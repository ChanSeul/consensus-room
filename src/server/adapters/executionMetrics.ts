import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ExecutionLimits, TurnUsage } from "../types.js";
import { codexUsageEvidence, sameTokenCounts, type CodexUsageEvidence } from "./codexUsageEvidence.js";

type CodexHomeUsage = Partial<TurnUsage> & { turnEvidence?: CodexUsageEvidence };

type RecordValue = Record<string, unknown>;

export interface ClaudeUsageBaseline {
  sessionId: string;
  modelUsage: Record<string, unknown>;
  totalCostUSD?: number;
  totalAPIDuration?: number;
}

// Claude's result.modelUsage is session-cumulative, including compaction. Its result.usage can
// omit compaction. Anchor the former BEFORE spawning; never turn a missing resume anchor into zero.
export async function readClaudeUsageBaseline(root: string, sessionId: string): Promise<ClaudeUsageBaseline | null> {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = await open(join(root, entry.name, `${sessionId}.jsonl`), constants.O_RDONLY | constants.O_NOFOLLOW).catch(() => null);
    if (!file) continue;
    try {
      const stat = await file.stat(), size = Math.min(stat.size, 2 * 1024 * 1024);
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await file.read(buffer, 0, size, stat.size - size);
      if (bytesRead !== size) return null;
      const after = await file.stat();
      if (stat.size !== after.size || stat.mtimeMs !== after.mtimeMs) return null;
      const lines = buffer.toString("utf8").split("\n");
      if (size < stat.size) lines.shift();
      for (const line of lines.reverse()) {
        let value: RecordValue;
        try { value = JSON.parse(line); } catch { continue; }
        if (value?.type !== "cost-state") continue;
        if (value.sessionId !== sessionId || !record(value.modelUsage)) return null;
        return { sessionId, modelUsage: value.modelUsage as RecordValue,
          totalCostUSD: typeof value.totalCostUSD === "number" ? value.totalCostUSD : undefined,
          totalAPIDuration: typeof value.totalAPIDuration === "number" ? value.totalAPIDuration : undefined };
      }
    } finally { await file.close(); }
    return null;
  }
  return null;
}

function claudeSessionDelta(baseline: ClaudeUsageBaseline | undefined, event: RecordValue): Partial<TurnUsage> | null {
  const models = record(event.modelUsage);
  if (!baseline || event.session_id !== baseline.sessionId || !models || !Object.keys(models).length) return null;
  if (Object.keys(baseline.modelUsage).some(model => !record(models[model]))) return null;
  const keys = ["inputTokens", "cacheReadInputTokens", "cacheCreationInputTokens", "outputTokens"] as const;
  const sum = { inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 };
  for (const [model, raw] of Object.entries(models)) {
    const current = record(raw), before = record(baseline.modelUsage[model]);
    if (!current || (baseline.modelUsage[model] !== undefined && !before)) return null;
    for (const key of keys) {
      const now = current[key], prior = before ? before[key] : 0;
      if (!Number.isSafeInteger(now) || !Number.isSafeInteger(prior) || (prior as number) < 0 || (now as number) < (prior as number)) return null;
      sum[key] += (now as number) - (prior as number);
      if (!Number.isSafeInteger(sum[key])) return null;
    }
  }
  const inputTokens = sum.inputTokens + sum.cacheReadInputTokens + sum.cacheCreationInputTokens;
  if (!Number.isSafeInteger(inputTokens)) return null;
  const difference = (now: unknown, before: unknown): number | undefined =>
    typeof now === "number" && Number.isFinite(now) && typeof before === "number" && Number.isFinite(before) && before >= 0 && now >= before ? now - before : undefined;
  return { inputTokens, cachedInputTokens: sum.cacheReadInputTokens, outputTokens: sum.outputTokens,
    costUSD: difference(event.total_cost_usd, baseline.totalCostUSD), apiDurationMs: difference(event.duration_api_ms, baseline.totalAPIDuration) };
}

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
  private readonly claudeInputTotals: Record<string, number> = {};
  private activeClaudeMessage?: string;
  private sawClaudeDelta = false;
  private sawClaudeAdvisor = false;
  private readonly claudeMessages = new Map<string, Record<string, number>>();
  private readonly claudeRequestInputs = new Map<string, { last: number; peak: number; fromIterations: boolean }>();
  private totals: Partial<Pick<TurnUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">> = {};
  private metadata: Partial<Pick<TurnUsage, "costUSD" | "modelTurns" | "apiDurationMs">> = {};
  private internalRequests = 0;
  private lastRequestInputTokens?: number;
  private peakRequestInputTokens?: number;
  private finalSourceSeen = false;
  private finalUsageComplete = false;
  private claudeAssistantRequests = 0;
  private reconciliation: TurnUsage["sourceUsage"];
  private reconciledCodexTurn = false;
  private claudeBaseline?: ClaudeUsageBaseline;
  private claudeCompacted = false;

  setClaudeBaseline(baseline: ClaudeUsageBaseline | null): void { this.claudeBaseline = baseline ?? undefined; }

  constructor(
    private readonly kind: "claude" | "codex",
    private readonly inputBytes: number,
    private readonly model: string,
    private readonly effort: string,
    private readonly resumed: boolean,
    private readonly startedAt: number,
  ) {}

  observe(value: unknown): void {
    const envelope = record(value);
    if (this.kind === "claude" && envelope?.type === "system" && envelope.subtype === "compact_boundary") this.claudeCompacted = true;
    if (this.kind === "claude" && envelope?.type === "stream_event") {
      if (this.finalSourceSeen || envelope.parent_tool_use_id) return;
      const chunk = record(envelope.event);
      if (chunk?.type === "message_start") {
        const message = record(chunk.message);
        this.activeClaudeMessage = typeof message?.id === "string" ? message.id : undefined;
        if (this.activeClaudeMessage) this.observe({ type: "assistant", message });
      } else if (chunk?.type === "message_delta" && this.activeClaudeMessage && record(chunk.usage)) {
        this.sawClaudeDelta = true;
        this.observe({ type: "assistant", message: { id: this.activeClaudeMessage, usage: chunk.usage } });
      } else if (chunk?.type === "message_stop") this.activeClaudeMessage = undefined;
      return;
    }
    const event = usageEvent(this.kind, value);
    if (!event) return;
    const isClaudeAssistant = this.kind === "claude" && event.type === "assistant";
    const isClaudeFinal = this.kind === "claude" && event.type === "result";
    if (isClaudeAssistant) {
      if (this.finalSourceSeen) return;
      const id = eventID(event);
      const previous = this.claudeMessages.get(id);
      const next = { ...previous };
      const usage = record(record(event.message)?.usage)!;
      for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]) {
        const value = number(usage[key]);
        if (value !== undefined && value >= 0) next[key] = Math.max(next[key] ?? 0, value);
      }
      // API top-level usage excludes advisor iterations. Keep their counters separate so they
      // affect the budget but not the main model's context-window/compaction measurements.
      const advisors = Array.isArray(usage.iterations)
        ? usage.iterations.map(record).filter(item => item?.type === "advisor_message") : [];
      if (advisors.length) {
        this.sawClaudeAdvisor = true;
        for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"]) {
          const values = advisors.map(item => number(item?.[key]));
          if (values.every(value => value !== undefined && Number.isSafeInteger(value) && value >= 0)) {
            const sum = values.reduce<number>((total, value) => total + value!, 0);
            if (Number.isSafeInteger(sum)) next[`advisor_${key}`] = Math.max(next[`advisor_${key}`] ?? 0, sum);
          }
        }
      }
      for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
        if (next[key] !== undefined) this.claudeInputTotals[key] = (this.claudeInputTotals[key] ?? 0) + next[key] - (previous?.[key] ?? 0);
      }
      if (!previous) this.claudeAssistantRequests += 1;
      this.claudeMessages.set(id, next);
      // Per-request input is one API request's context. With server-side advisor calls one message holds several
      // executor requests (iterations of type "message") and the top-level usage is their sum, so count each
      // iteration; advisor iterations stay budget-only as above. Without iterations the top-level sum is one request.
      // Once a message reports iterations, a later top-level-only event does not replace them with the sum.
      const fields = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
      const requestInput = (item: RecordValue | null) => {
        const values = fields.map(key => number(item?.[key]));
        return values.some(value => value !== undefined) && values.every(value => value === undefined || value >= 0)
          ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined;
      };
      const requests = Array.isArray(usage.iterations)
        ? usage.iterations.map(record).filter(item => item?.type === "message").map(requestInput) : [];
      const observed = this.claudeRequestInputs.get(id);
      if (requests.length && requests.every(value => value !== undefined)) {
        const counts = requests as number[];
        this.claudeRequestInputs.set(id, { last: counts.at(-1)!,
          peak: Math.max(observed?.fromIterations ? observed.peak : 0, ...counts), fromIterations: true });
      } else if (!observed?.fromIterations && fields.some(key => next[key] !== undefined)) {
        const total = fields.reduce((sum, key) => sum + (next[key] ?? 0), 0);
        this.claudeRequestInputs.set(id, { last: total, peak: Math.max(observed?.peak ?? 0, total), fromIterations: false });
      }
      const request = this.claudeRequestInputs.get(id);
      if (request) {
        this.lastRequestInputTokens = request.last;
        this.peakRequestInputTokens = Math.max(...[...this.claudeRequestInputs.values()].map(item => item.peak));
      }
      this.internalRequests = this.claudeAssistantRequests;
      const addDelta = (target: "inputTokens" | "cachedInputTokens" | "outputTokens", keys: string[]) => {
        if (!keys.some((key) => next[key] !== undefined)) return;
        const delta = keys.reduce((sum, key) => sum + (next[key] ?? 0) - (previous?.[key] ?? 0), 0);
        this.totals[target] = (this.totals[target] ?? 0) + delta;
      };
      addDelta("inputTokens", ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens",
        "advisor_input_tokens", "advisor_cache_read_input_tokens", "advisor_cache_creation_input_tokens"]);
      addDelta("cachedInputTokens", ["cache_read_input_tokens", "advisor_cache_read_input_tokens"]);
      addDelta("outputTokens", ["output_tokens", "advisor_output_tokens"]);
      return;
    }
    if (this.seen.has(eventID(event))) return;
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
      const cli = {
        ...(plain === undefined && cached === undefined && created === undefined ? {} : { inputTokens: (plain ?? 0) + (cached ?? 0) + (created ?? 0) }),
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        ...(output === undefined ? {} : { outputTokens: output }),
      };
      const inputParts = { ...this.claudeInputTotals };
      for (const key of ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"]) {
        const value = number(usage[key]);
        if (value !== undefined) inputParts[key] = value;
        else if (inputParts[key] !== undefined && inputParts[key] > 0) this.finalUsageComplete = false;
      }
      const streamed = { ...this.totals };
      this.totals = {
        ...this.totals,
        ...(plain === undefined && cached === undefined && created === undefined ? {} : { inputTokens: Object.values(inputParts).reduce((sum, count) => sum + count, 0) }),
        ...(cached === undefined ? {} : { cachedInputTokens: cached }),
        ...(output === undefined ? {} : { outputTokens: output }),
      };
      // Preserve both sources if the CLI aggregate contradicts completed streaming observations.
      // This is not evidence that either source is the full billable total.
      if (this.sawClaudeDelta) {
        const mismatch = (["inputTokens", "cachedInputTokens", "outputTokens"] as const)
          .some((key) => streamed[key] !== undefined && this.totals[key] !== undefined && streamed[key]! > this.totals[key]!);
        if (mismatch) {
          this.finalUsageComplete = false;
          this.reconciliation = { cli, claudeStream: streamed, status: "mismatch" };
        }
      }
      // num_turns is the authoritative aggregate when present. The streamed count is retained only for
      // an aborted run that never emitted result.
      const sessionDelta = claudeSessionDelta(this.claudeBaseline, event);
      const coversObserved = sessionDelta && (["inputTokens", "cachedInputTokens", "outputTokens"] as const).every(key =>
        sessionDelta[key] !== undefined && sessionDelta[key]! >= Math.max(streamed[key] ?? 0, this.totals[key] ?? 0));
      if (coversObserved) {
        this.reconciliation = { cli, claudeStream: streamed, claudeSession: sessionDelta, status: "matched" };
        this.totals = { inputTokens: sessionDelta.inputTokens, cachedInputTokens: sessionDelta.cachedInputTokens, outputTokens: sessionDelta.outputTokens };
        this.metadata = { ...this.metadata, costUSD: sessionDelta.costUSD, apiDurationMs: sessionDelta.apiDurationMs };
        this.finalUsageComplete = true;
      } else if (record(event.modelUsage)) {
        // These fields are cumulative too; without a verified baseline they are not this run's cost.
        delete this.metadata.costUSD;
        delete this.metadata.apiDurationMs;
        if (this.claudeCompacted || this.claudeBaseline) {
          this.finalUsageComplete = false;
          this.reconciliation = { cli, claudeStream: streamed, status: "unavailable" };
          for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
            if (streamed[key] !== undefined) this.totals[key] = Math.max(this.totals[key] ?? 0, streamed[key]!);
          }
        }
      }
      // Without a verified session delta, never let executor-only final usage erase observed
      // advisor tokens, and never claim that partial observations are a complete billable total.
      if (this.sawClaudeAdvisor && !coversObserved) {
        this.finalUsageComplete = false;
        this.reconciliation = { cli, claudeStream: streamed, status: "unavailable" };
        delete this.metadata.costUSD;
        delete this.metadata.apiDurationMs;
        for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
          if (streamed[key] !== undefined) this.totals[key] = Math.max(this.totals[key] ?? 0, streamed[key]!);
        }
      }
      this.internalRequests = number(event.num_turns) ?? this.claudeAssistantRequests;
      return;
    }
    this.internalRequests += 1;
    const usage = record(event.usage);
    if (!usage) return;
    const counts = {
      inputTokens: number(usage.input_tokens),
      cachedInputTokens: number(usage.cached_input_tokens),
      outputTokens: number(usage.output_tokens),
    };
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

  setCodexHomeUsage(homeUsage: CodexHomeUsage | null): void {
    const cli = { ...this.totals, internalRequests: this.internalRequests };
    const same = homeUsage && cli.inputTokens === homeUsage.inputTokens && cli.outputTokens === homeUsage.outputTokens;
    this.reconciliation = { cli, ...(homeUsage ? { codexHome: homeUsage } : {}), status: homeUsage ? (same ? "matched" : "mismatch") : "unavailable" };
    const proof = homeUsage?.turnEvidence;
    // Keep the provider's original cumulative report above; only verified completed request/turn
    // records may replace the counters consumed by planning and the budget ledger.
    if (this.kind === "codex" && proof && proof.turnCount === this.internalRequests &&
      (sameTokenCounts(cli, proof.reported) || sameTokenCounts(cli, proof.usage) ||
        (proof.cliReported && sameTokenCounts(cli, proof.cliReported)))) {
      this.totals = { ...proof.usage };
      this.reconciledCodexTurn = true;
    }
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
      source: this.reconciledCodexTurn ? "codex-home" : "cli-stream",
      internalRequests: this.internalRequests,
      lastRequestInputTokens: this.lastRequestInputTokens,
      peakRequestInputTokens: this.peakRequestInputTokens,
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
export async function codexHomeUsage(home: string | readonly string[], sessionId: string | undefined, startedAt: number, endedAt = Date.now()): Promise<CodexHomeUsage | null> {
  if (!sessionId) return null;
  const files = new Set<string>();
  const visit = async (directory: string, depth: number): Promise<void> => {
    if (depth > 4 || files.size >= 200) return;
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) await visit(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) files.add(path);
    }
  };
  for (const root of new Set(typeof home === "string" ? [home] : home)) await visit(root, 0);
  let total: Partial<TurnUsage> = {};
  let found = false;
  const seen = new Set<string>();
  const proofs: CodexUsageEvidence[] = [];
  for (const path of files) {
    const text = await readFile(path, "utf8").catch(() => "");
    const proof = codexUsageEvidence(text, sessionId, startedAt, endedAt);
    if (proof) proofs.push(proof);
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
  // More than one matching transcript is ambiguous; do not select whichever counter is smaller.
  return found ? { ...total, ...(files.size === 1 && proofs.length === 1 && sameTokenCounts(total, proofs[0].usage)
    ? { turnEvidence: proofs[0] } : {}) } : null;
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
