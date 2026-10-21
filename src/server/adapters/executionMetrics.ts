import { createHash, randomUUID } from "node:crypto";
import { open, readdir, readFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { ExecutionLimits, TurnUsage } from "../types.js";
import { codexUsageEvidence, sameTokenCounts, type CodexUsageEvidence } from "./codexUsageEvidence.js";
import { isModelOrToolActivity, isSyntheticZeroTurnResult } from "./resultParser.js";
import { reportBackgroundFailure } from "../backgroundTask.js";

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

// 검증된 세션 전체 차분 — 실행 전 기준점과 같은 세션의 modelUsage 누적값 차이다. 필드별(p·r·c·o)로 돌려준다. 세션 불일치·기준점 없음·카운터 역행·
// 잘못된 값이면 null 이다(0 에서 시작하지 않는다).
function claudeSessionFields(baseline: ClaudeUsageBaseline | undefined, event: RecordValue): { fields: number[]; costUSD?: number; apiDurationMs?: number } | null {
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
  if (!Number.isSafeInteger(sum.inputTokens + sum.cacheReadInputTokens + sum.cacheCreationInputTokens)) return null;
  const difference = (now: unknown, before: unknown): number | undefined =>
    typeof now === "number" && Number.isFinite(now) && typeof before === "number" && Number.isFinite(before) && before >= 0 && now >= before ? now - before : undefined;
  return { fields: [sum.inputTokens, sum.cacheReadInputTokens, sum.cacheCreationInputTokens, sum.outputTokens],
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

// Claude 사용량 원천 필드(CR Engine Advisor 자문 48). 공개 값은 이 네 필드에서만 만든다: inputTokens = p+r+c, cachedInputTokens = r, outputTokens = o.
const CLAUDE_FIELDS = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens", "output_tokens"] as const;
type ClaudeFieldValues = Array<number | undefined>;
// 호출당 근거 상한 — 실측 한도가 아니라 구현 제안값이다(자문 48). 넘으면 그때까지의 관측을 보존하고 partial·진단을 남긴다. 호출은 멈추지 않는다.
const CLAUDE_MESSAGE_LIMIT = 16_384;
const CLAUDE_ANCHOR_LIMIT = 4_096;

// 같은 메시지의 출처별 필드 누적값(최대값). 갱신·재전송은 합산하지 않는다.
interface ClaudeMessageEvidence {
  executor: ClaudeFieldValues;
  advisor: ClaudeFieldValues;
  request?: { last: number; peak: number; fromIterations: boolean };
}
// result 가 남긴 필드별 집계점 — cut 은 그 result 때까지 시작한 메시지 수다. E 는 result.usage(executor), G 는 검증된 세션 차분(advisor·압축 포함 전체).
interface ClaudeAnchor { domain: "E" | "G"; field: number; cut: number; value: number }
interface ClaudeResultEvidence {
  seq: number;
  executor: ClaudeFieldValues;
  session?: { fields: number[]; costUSD?: number; apiDurationMs?: number };
  hasModelUsage: boolean;
  costUSD?: number;
  modelTurns?: number;
  apiDurationMs?: number;
}

// 음수가 아닌 안전한 정수만 관측값이다. 0 은 값이고, 누락·null·잘못된 형식은 미관측이다.
function tokenCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function fixedKey(key: string): string {
  return createHash("sha256").update(key).digest("base64url").slice(0, 22);
}

function claudeTargets(fields: ClaudeFieldValues): Partial<TurnUsage> {
  const [plain, cached, created, output] = fields;
  return {
    ...(plain === undefined && cached === undefined && created === undefined ? {} : { inputTokens: (plain ?? 0) + (cached ?? 0) + (created ?? 0) }),
    ...(cached === undefined ? {} : { cachedInputTokens: cached }),
    ...(output === undefined ? {} : { outputTokens: output }),
  };
}

export class ExecutionMetrics {
  readonly executionId = randomUUID();
  private readonly seen = new Set<string>();
  // Codex 집계(아래 Claude 근거와 별개).
  private totals: Partial<Pick<TurnUsage, "inputTokens" | "cachedInputTokens" | "outputTokens">> = {};
  private metadata: Partial<Pick<TurnUsage, "costUSD" | "modelTurns" | "apiDurationMs">> = {};
  private internalRequests = 0;
  private finalSourceSeen = false;
  private finalUsageComplete = false;
  private reconciliation: TurnUsage["sourceUsage"];
  private reconciledCodexTurn = false;
  // Claude 근거(자문 48): observe() 는 이것만 갱신하고, snapshot() 이 닫힌 규칙으로 값을 계산한다.
  private claudeSeq = 0;
  private claudeLastActivity = -1;
  private readonly claudeMessageIndex = new Map<string, number>();
  private readonly claudeMessages: ClaudeMessageEvidence[] = [];
  private readonly claudeAnchors: ClaudeAnchor[] = [];
  private claudeResult?: ClaudeResultEvidence;
  private readonly claudeKnown = [false, false, false, false];
  private readonly claudeStreamKnown = [false, false, false, false];
  private claudeLoss = false;
  private activeClaudeMessage?: string;
  private sawClaudeAdvisor = false;
  private lastRequestInputTokens?: number;
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
    if (this.kind === "claude") {
      this.observeClaude(value);
      return;
    }
    const event = usageEvent(this.kind, value);
    if (!event) return;
    if (this.seen.has(eventID(event))) return;
    this.seen.add(eventID(event));
    this.finalSourceSeen = true;
    this.internalRequests += 1;
    const usage = record(event.usage);
    if (!usage) return;
    const counts = {
      inputTokens: number(usage.input_tokens),
      cachedInputTokens: number(usage.cached_input_tokens),
      outputTokens: number(usage.output_tokens),
    };
    this.finalUsageComplete = counts.inputTokens !== undefined && counts.outputTokens !== undefined;
    for (const key of ["inputTokens", "cachedInputTokens", "outputTokens"] as const) {
      if (counts[key] !== undefined) this.totals[key] = (this.totals[key] ?? 0) + counts[key]!;
    }
  }

  // 한 줄을 받을 때마다 순번을 하나 올린다. 모델·도구 작업 줄(isModelOrToolActivity)은 마지막 작업 순번이다 — 그 뒤의 비합성 result 만 호출의
  // 최종 집계가 될 수 있다(engine-review 1d47a14d F001). 부분 스트림 줄은 같은 메시지의 사용량으로 정규화한다.
  private observeClaude(value: unknown): void {
    const seq = ++this.claudeSeq;
    if (isModelOrToolActivity(value)) this.claudeLastActivity = seq;
    const envelope = record(value);
    if (envelope?.type === "system" && envelope.subtype === "compact_boundary") this.claudeCompacted = true;
    if (envelope?.type === "stream_event") {
      if (envelope.parent_tool_use_id) return;
      const chunk = record(envelope.event);
      if (chunk?.type === "message_start") {
        const message = record(chunk.message);
        this.activeClaudeMessage = typeof message?.id === "string" ? message.id : undefined;
        const usage = record(message?.usage);
        if (this.activeClaudeMessage && usage) this.observeClaudeMessage(`message:id:${this.activeClaudeMessage}`, usage);
      } else if (chunk?.type === "message_delta" && this.activeClaudeMessage && record(chunk.usage)) {
        this.observeClaudeMessage(`message:id:${this.activeClaudeMessage}`, record(chunk.usage)!);
      } else if (chunk?.type === "message_stop") this.activeClaudeMessage = undefined;
      return;
    }
    const event = usageEvent("claude", value);
    if (!event) return;
    if (event.type === "assistant") {
      this.observeClaudeMessage(eventID(event), record(record(event.message)?.usage)!);
      return;
    }
    const key = fixedKey(eventID(event));
    if (this.seen.has(key)) return;
    this.seen.add(key);
    this.observeClaudeResult(seq, event);
  }

  private observeClaudeMessage(key: string, usage: RecordValue): void {
    const id = fixedKey(key);
    let index = this.claudeMessageIndex.get(id);
    if (index === undefined) {
      if (this.claudeMessages.length >= CLAUDE_MESSAGE_LIMIT) {
        this.markClaudeLoss(`메시지 ${CLAUDE_MESSAGE_LIMIT}개`);
        return;
      }
      index = this.claudeMessages.length;
      this.claudeMessageIndex.set(id, index);
      this.claudeMessages.push({ executor: [undefined, undefined, undefined, undefined], advisor: [undefined, undefined, undefined, undefined] });
    }
    const evidence = this.claudeMessages[index];
    CLAUDE_FIELDS.forEach((name, field) => {
      const value = tokenCount(usage[name]);
      if (value === undefined) return;
      evidence.executor[field] = Math.max(evidence.executor[field] ?? 0, value);
      this.claudeKnown[field] = this.claudeStreamKnown[field] = true;
    });
    // API top-level usage excludes advisor iterations. Keep their counters separate so they
    // affect the budget but not the main model's context-window/compaction measurements.
    const advisors = Array.isArray(usage.iterations)
      ? usage.iterations.map(record).filter(item => item?.type === "advisor_message") : [];
    if (advisors.length) {
      this.sawClaudeAdvisor = true;
      CLAUDE_FIELDS.forEach((name, field) => {
        const values = advisors.map(item => tokenCount(item?.[name]));
        if (!values.every(value => value !== undefined)) return;
        const sum = values.reduce<number>((total, value) => total + value!, 0);
        if (!Number.isSafeInteger(sum)) return;
        evidence.advisor[field] = Math.max(evidence.advisor[field] ?? 0, sum);
        this.claudeKnown[field] = this.claudeStreamKnown[field] = true;
      });
    }
    // Per-request input is one API request's context. With server-side advisor calls one message holds several
    // executor requests (iterations of type "message") and the top-level usage is their sum, so count each
    // iteration; advisor iterations stay budget-only as above. Without iterations the top-level sum is one request.
    // Once a message reports iterations, a later top-level-only event does not replace them with the sum.
    const inputNames = ["input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
    const requestInput = (item: RecordValue | null) => {
      const values = inputNames.map(name => number(item?.[name]));
      return values.some(value => value !== undefined) && values.every(value => value === undefined || value >= 0)
        ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined;
    };
    const requests = Array.isArray(usage.iterations)
      ? usage.iterations.map(record).filter(item => item?.type === "message").map(requestInput) : [];
    const observed = evidence.request;
    if (requests.length && requests.every(value => value !== undefined)) {
      const counts = requests as number[];
      evidence.request = { last: counts.at(-1)!, peak: Math.max(observed?.fromIterations ? observed.peak : 0, ...counts), fromIterations: true };
    } else if (!observed?.fromIterations && evidence.executor.slice(0, 3).some(value => value !== undefined)) {
      const total = evidence.executor.slice(0, 3).reduce<number>((sum, value) => sum + (value ?? 0), 0);
      evidence.request = { last: total, peak: Math.max(observed?.peak ?? 0, total), fromIterations: false };
    }
    if (evidence.request) this.lastRequestInputTokens = evidence.request.last;
  }

  // result 는 합계를 바꾸지 않고 필드별 집계점만 남긴다. 생략한 필드는 집계점을 만들지도, 앞 집계점을 지우지도 않는다.
  // 합성 0턴 result 는 모델을 부르지 않은 줄이라 집계 근거가 아니다 — 0 이라는 관측만 남긴다(자문 46·48).
  private observeClaudeResult(seq: number, event: RecordValue): void {
    const usage = record(event.usage);
    const executor = CLAUDE_FIELDS.map(name => tokenCount(usage?.[name]));
    if (isSyntheticZeroTurnResult(event)) {
      executor.forEach((value, field) => { if (value !== undefined) this.claudeKnown[field] = true; });
      return;
    }
    const cut = this.claudeMessages.length;
    const session = claudeSessionFields(this.claudeBaseline, event) ?? undefined;
    const anchors: ClaudeAnchor[] = [
      ...executor.flatMap((value, field) => value === undefined ? [] : [{ domain: "E" as const, field, cut, value }]),
      ...(session ? session.fields.map((value, field) => ({ domain: "G" as const, field, cut, value })) : []),
    ];
    if (this.claudeAnchors.length + anchors.length > CLAUDE_ANCHOR_LIMIT) this.markClaudeLoss(`집계점 ${CLAUDE_ANCHOR_LIMIT}개`);
    else {
      this.claudeAnchors.push(...anchors);
      for (const anchor of anchors) this.claudeKnown[anchor.field] = true;
    }
    this.claudeResult = {
      seq, executor, session, hasModelUsage: Boolean(record(event.modelUsage)),
      costUSD: number(event.total_cost_usd) === undefined ? undefined : Number(event.total_cost_usd),
      modelTurns: number(event.num_turns), apiDurationMs: number(event.duration_api_ms),
    };
  }

  private markClaudeLoss(limit: string): void {
    if (this.claudeLoss) return;
    this.claudeLoss = true;
    reportBackgroundFailure("execution-metrics-limit", new Error(`Claude 사용량 근거가 상한(${limit}, 구현 제안값)을 넘었습니다. 그때까지의 관측을 보존하고 partial 로 둡니다.`));
  }

  // 자문 48 의 닫힌 규칙. 메시지 순서별 뒤쪽 누적합을 필드·출처마다 한 번 만들어 O(메시지 + 집계점)으로 계산한다.
  //   Q = 집계값 + 그 집계 뒤에 시작한 메시지의 그 필드 합
  //   executor 필드 = max(executor 스트림 합, executor 집계점들의 Q)
  //   필드 = max(executor 필드 + advisor 스트림 합, 세션 집계점들의 Q)   — 세션 차분은 executor·advisor 를 이미 포함하므로 더하지 않는다.
  // 작은 result 는 관측을 낮추지 않는다(불일치로 남는다). 그래서 스냅숏의 토큰 값은 줄지 않는다.
  private claudeUsage(recordKind: "progress" | "final"): Partial<TurnUsage> {
    const messages = this.claudeMessages;
    const suffix = (source: "executor" | "advisor", field: number) => {
      const sums = new Array<number>(messages.length + 1).fill(0);
      for (let index = messages.length - 1; index >= 0; index -= 1) sums[index] = sums[index + 1] + (messages[index][source][field] ?? 0);
      return sums;
    };
    const anchorsByField: ClaudeAnchor[][] = [[], [], [], []];
    for (const anchor of this.claudeAnchors) anchorsByField[anchor.field].push(anchor);
    const streams: number[] = [];
    const parts = CLAUDE_FIELDS.map((_, field) => {
      const executor = suffix("executor", field), advisor = suffix("advisor", field);
      let executorView = executor[0], sessionView = executor[0] + advisor[0];
      for (const anchor of anchorsByField[field]) {
        if (anchor.domain === "E") executorView = Math.max(executorView, anchor.value + executor[anchor.cut]);
        else sessionView = Math.max(sessionView, anchor.value + executor[anchor.cut] + advisor[anchor.cut]);
      }
      streams.push(executor[0] + advisor[0]);
      return Math.max(executorView + advisor[0], sessionView);
    });
    const known = this.claudeKnown;
    const totals = claudeTargets(parts.map((value, field) => known[field] ? value : undefined));
    const result = this.claudeResult;
    // 마지막 작업 뒤의 비합성 result 만 호출의 최종 집계 후보다. 작업이 이어졌으면 그 result 의 비용·턴 수는 호출 전체의 값이 아니다.
    const current = result && result.seq > this.claudeLastActivity ? result : undefined;
    const requiresSession = (candidate: ClaudeResultEvidence) =>
      this.sawClaudeAdvisor || (candidate.hasModelUsage && (this.claudeCompacted || this.claudeBaseline !== undefined));
    const sessionMatches = Boolean(result?.session?.fields.every((value, field) => value === parts[field]));
    const proof = current ? current.session?.fields ?? (requiresSession(current) ? undefined : current.executor) : undefined;
    const complete = recordKind === "final" && !this.claudeLoss && proof !== undefined
      && proof.every((value, field) => value !== undefined && value === parts[field]);
    const metadata: Partial<TurnUsage> = !current ? {} : {
      ...(current.modelTurns === undefined ? {} : { modelTurns: current.modelTurns }),
      ...(current.session && sessionMatches ? { costUSD: current.session.costUSD, apiDurationMs: current.session.apiDurationMs }
        : current.hasModelUsage || this.sawClaudeAdvisor ? {}
          : { ...(current.costUSD === undefined ? {} : { costUSD: current.costUSD }), ...(current.apiDurationMs === undefined ? {} : { apiDurationMs: current.apiDurationMs }) }),
    };
    // 대조 기록은 마지막 result 의 것이다. 그 뒤 작업이 이어졌으면 이전 result 의 대조 기록으로만 읽는다.
    let reconciliation: TurnUsage["sourceUsage"];
    if (result) {
      const cli = claudeTargets(result.executor);
      const claudeStream = claudeTargets(streams.map((value, field) => this.claudeStreamKnown[field] ? value : undefined));
      // 관측보다 작은 세션 차분은 청구 근거로 남기지 않는다(기존 계약: adapter-permissions 「below-stream」). 불일치만 기록한다.
      if (result.session && sessionMatches) {
        reconciliation = { cli, claudeStream, claudeSession: { ...claudeTargets(result.session.fields), costUSD: result.session.costUSD,
          apiDurationMs: result.session.apiDurationMs }, status: "matched" };
      } else if (result.session) reconciliation = { cli, claudeStream, status: "mismatch" };
      else if (requiresSession(result)) reconciliation = { cli, claudeStream, status: "unavailable" };
      else if (result.executor.some((value, field) => value !== undefined && value !== parts[field])) reconciliation = { cli, claudeStream, status: "mismatch" };
    }
    const peaks = messages.flatMap(message => message.request ? [message.request.peak] : []);
    return {
      completeness: complete ? "complete" : "partial",
      internalRequests: current?.modelTurns ?? messages.length,
      lastRequestInputTokens: this.lastRequestInputTokens,
      peakRequestInputTokens: peaks.length ? peaks.reduce((max, value) => Math.max(max, value), 0) : undefined,
      ...totals,
      ...metadata,
      ...(reconciliation ? { sourceUsage: reconciliation } : {}),
    };
  }

  hasObserved(tool: { toolDurationMs: number; toolCalls: number }): boolean {
    if (this.kind === "claude") return this.claudeMessages.length > 0 || tool.toolCalls > 0 || this.claudeKnown.some(Boolean) || this.claudeResult !== undefined;
    return this.internalRequests > 0 || tool.toolCalls > 0 || Object.keys(this.totals).length > 0;
  }

  // Claude: 마지막 작업 뒤에 비합성 result 를 받았는가(작업이 이어지면 다시 false — 진행 보고가 재개된다).
  hasFinalSource(): boolean {
    if (this.kind === "claude") return this.claudeResult !== undefined && this.claudeResult.seq > this.claudeLastActivity;
    return this.finalSourceSeen;
  }

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
    const base = {
      executionId: this.executionId,
      model: this.model,
      effort: this.effort,
      resumed: this.resumed,
      inputBytes: this.inputBytes,
      recordKind,
      source: this.reconciledCodexTurn ? "codex-home" as const : "cli-stream" as const,
      toolDurationMs: tool.toolDurationMs,
      toolCalls: tool.toolCalls,
      durationMs: Math.max(0, Date.now() - this.startedAt),
    };
    if (this.kind === "claude") {
      const { completeness, internalRequests, lastRequestInputTokens, peakRequestInputTokens, ...usage } = this.claudeUsage(recordKind);
      return { ...base, completeness, internalRequests, lastRequestInputTokens, peakRequestInputTokens, ...usage };
    }
    const observed = this.finalSourceSeen && this.finalUsageComplete && this.totals.inputTokens !== undefined && this.totals.outputTokens !== undefined;
    return {
      ...base,
      completeness: observed ? "complete" : "partial",
      internalRequests: this.internalRequests,
      lastRequestInputTokens: undefined,
      peakRequestInputTokens: undefined,
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
