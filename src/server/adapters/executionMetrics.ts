import { createHash, randomUUID } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExecutionLimits, TurnUsage } from "../types.js";

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : null;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : undefined;
}

function usageEvent(kind: "claude" | "codex", value: unknown): RecordValue | null {
  const event = record(value);
  if (!event) return null;
  if (kind === "codex") return event.type === "turn.completed" ? event : null;
  const message = record(event.message);
  return event.type === "assistant" && record(message?.usage) ? event : event.type === "result" ? event : null;
}

// JSONL은 같은 완료 이벤트를 재전송할 수 있다. response/message id가 있으면 그것을, 없으면 내용 hash를
// dedupe key로 써서 누적값을 중복 합산하지 않는다.
function eventID(event: RecordValue): string {
  const message = record(event.message);
  const payload = record(event.payload);
  for (const key of ["response_id", "responseId", "message_id", "messageId"]) {
    if (typeof event[key] === "string") return `${key}:${event[key]}`;
    if (typeof payload?.[key] === "string") return `${key}:${payload[key]}`;
  }
  if (typeof message?.id === "string") return `message:id:${message.id}`;
  return `hash:${createHash("sha256").update(JSON.stringify(event)).digest("hex")}`;
}

function homeRecordID(event: RecordValue, payload: RecordValue, usage: RecordValue): string {
  const responseId = [event.response_id, event.responseId, payload.response_id, payload.responseId]
    .find((value): value is string => typeof value === "string");
  if (!responseId) return eventID(event);
  // 동일 response의 일부 토큰 필드는 서로 다른 레코드로 합산한다. timestamp·JSON key 순서만 달라진
  // 재전송은 같은 토큰 필드 조합이므로 하나로 접는다.
  return JSON.stringify({
    responseId,
    input: number(usage.input_tokens),
    cached: number(usage.cached_input_tokens),
    output: number(usage.output_tokens),
  });
}

export class ExecutionMetrics {
  readonly executionId = randomUUID();
  private readonly seen = new Set<string>();
  private totals: Partial<Pick<TurnUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">> = {};
  private metadata: Partial<Pick<TurnUsage, "costUSD" | "modelTurns" | "apiDurationMs">> = {};
  private internalRequests = 0;
  private finalSourceSeen = false;
  private finalUsageComplete = false;
  private claudeAssistantRequests = 0;
  private reconciliation: TurnUsage["sourceUsage"];

  constructor(
    private readonly kind: "claude" | "codex",
    private readonly inputBytes: number,
    private readonly model: string,
    private readonly effort: string,
    private readonly resumed: boolean,
    private readonly startedAt: number,
  ) {}

  observe(value: unknown): void {
    const event = usageEvent(this.kind, value);
    if (!event || this.seen.has(eventID(event))) return;
    const isClaudeAssistant = this.kind === "claude" && event.type === "assistant";
    const isClaudeFinal = this.kind === "claude" && event.type === "result";
    this.seen.add(eventID(event));
    if ((this.kind === "codex" && event.type === "turn.completed") || (this.kind === "claude" && event.type === "result")) this.finalSourceSeen = true;
    // Claude result usage is turn-cumulative. The streamed assistant records remain the partial observation
    // for aborts, but a result replaces (rather than adds to) that provisional sum.
    if (isClaudeFinal) {
      this.metadata = {
        ...(number(event.total_cost_usd) === undefined ? {} : { costUSD: Number(event.total_cost_usd) }),
        ...(number(event.num_turns) === undefined ? {} : { modelTurns: number(event.num_turns) }),
        ...(number(event.duration_api_ms) === undefined ? {} : { apiDurationMs: number(event.duration_api_ms) }),
      };
      const usage = record(event.usage);
      if (!usage) return;
      const plain = number(usage.input_tokens);
      const cached = number(usage.cache_read_input_tokens);
      const created = number(usage.cache_creation_input_tokens);
      const output = number(usage.output_tokens);
      this.finalUsageComplete = (plain !== undefined || cached !== undefined || created !== undefined) && output !== undefined;
      this.totals = {
        ...this.totals,
        ...(plain === undefined && cached === undefined && created === undefined ? {} : { inputTokens: (plain ?? 0) + (cached ?? 0) + (created ?? 0) }),
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        ...(output === undefined ? {} : { outputTokens: output }),
      };
      // num_turns is the authoritative aggregate when present. The streamed count is retained only for
      // an aborted run that never emitted result.
      this.internalRequests = number(event.num_turns) ?? this.claudeAssistantRequests;
      return;
    }
    if (isClaudeAssistant) this.claudeAssistantRequests += 1;
    this.internalRequests += 1;
    const message = record(event.message);
    const usage = record(event.usage) ?? record(message?.usage);
    if (!usage) return;
    let counts: Partial<Pick<TurnUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">>;
    if (this.kind === "codex") {
      counts = {
        inputTokens: number(usage.input_tokens),
        cachedInputTokens: number(usage.cached_input_tokens),
        outputTokens: number(usage.output_tokens),
      };
    } else {
      const plain = number(usage.input_tokens);
      const cached = number(usage.cache_read_input_tokens);
      const created = number(usage.cache_creation_input_tokens);
      counts = {
        ...(plain === undefined && cached === undefined && created === undefined ? {} : { inputTokens: (plain ?? 0) + (cached ?? 0) + (created ?? 0) }),
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        ...(number(usage.output_tokens) === undefined ? {} : { outputTokens: number(usage.output_tokens) }),
      };
      this.metadata = {
        ...(number(event.total_cost_usd) === undefined ? {} : { costUSD: Number(event.total_cost_usd) }),
        ...(number(event.num_turns) === undefined ? {} : { modelTurns: number(event.num_turns) }),
        ...(number(event.duration_api_ms) === undefined ? {} : { apiDurationMs: number(event.duration_api_ms) }),
      };
    }
    if (this.kind === "codex" && event.type === "turn.completed") {
      this.finalUsageComplete = counts.inputTokens !== undefined && counts.outputTokens !== undefined;
    }
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
      if (counts[key] !== undefined) this.totals[key] = (this.totals[key] ?? 0) + counts[key]!;
    }
  }

  hasObserved(tool: { toolDurationMs: number; toolCalls: number }): boolean {
    return this.internalRequests > 0 || tool.toolCalls > 0 || Object.keys(this.totals).length > 0;
  }

  hasFinalSource(): boolean { return this.finalSourceSeen; }

  setCodexHomeUsage(homeUsage: Partial<TurnUsage> | null): void {
    const cli = { ...this.totals, internalRequests: this.internalRequests };
    const same = homeUsage && cli.inputTokens === homeUsage.inputTokens && cli.outputTokens === homeUsage.outputTokens;
    this.reconciliation = { cli, ...(homeUsage ? { codexHome: homeUsage } : {}), status: homeUsage ? (same ? "matched" : "mismatch") : "unavailable" };
  }

  snapshot(tool: { toolDurationMs: number; toolCalls: number }, recordKind: "progress" | "final"): TurnUsage {
    const observed = this.finalSourceSeen && this.finalUsageComplete && this.totals.inputTokens !== undefined && this.totals.outputTokens !== undefined;
    return {
      executionId: this.executionId,
      model: this.model,
      effort: this.effort,
      resumed: this.resumed,
      inputBytes: this.inputBytes,
      recordKind,
      completeness: observed ? "complete" : "partial",
      source: "cli-stream",
      internalRequests: this.internalRequests,
      toolDurationMs: tool.toolDurationMs,
      toolCalls: tool.toolCalls,
      durationMs: Math.max(0, Date.now() - this.startedAt),
      ...this.totals,
      ...this.metadata,
      ...(this.reconciliation ? { sourceUsage: this.reconciliation } : {}),
    };
  }
}

// 관리형 CODEX_HOME은 CLI 버전별로 세션 파일 배치가 달라질 수 있으므로, 해당 홈 아래 JSONL만 제한적으로
// 읽고 같은 완료 이벤트의 마지막 관측값을 따로 보관한다. 찾지 못한 것은 0이 아니라 unavailable이다.
export async function codexHomeUsage(home: string, sessionId: string | undefined, startedAt: number, endedAt = Date.now()): Promise<Partial<TurnUsage> | null> {
  if (!sessionId) return null;
  const files: string[] = [];
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || files.length >= 200) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) files.push(path);
    }
  };
  await visit(home, 0);
  let total: Partial<TurnUsage> = {};
  let found = false;
  const seen = new Set<string>();
  for (const path of files) {
    const text = await readFile(path, "utf8").catch(() => "");
    for (const line of text.split(/\r?\n/)) {
      try {
        const event = record(JSON.parse(line));
        const payload = record(event?.payload);
        if (event?.type !== "token_usage_record" || payload?.thread_id !== sessionId) continue;
        const timestamp = Date.parse(String(event?.timestamp ?? ""));
        if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > endedAt) continue;
        const usage = record(payload.usage);
        if (!usage) continue;
        const id = homeRecordID(event, payload, usage);
        if (seen.has(id)) continue;
        const next = { inputTokens: number(usage.input_tokens), cachedInputTokens: number(usage.cached_input_tokens), outputTokens: number(usage.output_tokens), source: "codex-home" };
        total = {
          ...total,
          ...(next.inputTokens === undefined ? {} : { inputTokens: (total.inputTokens ?? 0) + next.inputTokens }),
          ...(next.cachedInputTokens === undefined ? {} : { cachedInputTokens: (total.cachedInputTokens ?? 0) + next.cachedInputTokens }),
          ...(next.outputTokens === undefined ? {} : { outputTokens: (total.outputTokens ?? 0) + next.outputTokens }), source: "codex-home",
        };
        seen.add(id);
        found = true;
      } catch { /* non JSON lines are not source records */ }
    }
  }
  return found ? total : null;
}

export function exceededLimits(usage: TurnUsage, limits: ExecutionLimits): Array<{ key: keyof ExecutionLimits; value: number; limit: number; timing: "live" | "completion" }> {
  const values: Partial<Record<keyof ExecutionLimits, number | undefined>> = {
    inputBytes: usage.inputBytes,
    durationMs: usage.durationMs,
    internalRequests: usage.internalRequests,
    toolCalls: usage.toolCalls,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
  };
  return (Object.keys(values) as Array<keyof ExecutionLimits>).flatMap((key) => {
    const value = values[key];
    const limit = limits[key];
    if (value === undefined || limit === undefined || value < limit) return [];
    return [{ key, value, limit, timing: usage.recordKind === "final" ? "completion" : "live" }];
  });
}
