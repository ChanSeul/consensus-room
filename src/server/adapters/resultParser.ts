import {
  PlanRepairSchema, type PlanRepair, AgentResultSchema, RESPONSE_RESOLVED_IDS_LIMIT, type AgentResult,
} from "../../shared/contracts.js";
import { redactSecrets } from "../../shared/workflow.js";
import type { AgentRunErrorCode } from "../../shared/planningControl.js";
import { envelopeIssues, turnEnvelopeSchema, type EnvelopeRole, type TurnEnvelope } from "../../shared/turnContract.js";

// AgentResultJsonSchema는 선택 필드를 "required + null 허용"으로 표현한다 — OpenAI 구조화 출력이
// required에 properties의 전 키를 요구하기 때문이다(그 주석 참조). 모델은 값이 없으면 null을 보내는데
// zod에서 그 필드들은 optional이라 null을 받지 못한다. 그래서 파싱 전에 값이 null인 키만 지운다.
// memoryUpdates[].expectedSHA256처럼 null 자체가 유효한 값인 필드는 건드리지 않으므로 재귀로 훑지 않는다.
const OPTIONAL_KEYS = [
  "engineDefects",
  "planMarkdown", "planEdits", "planLineEdits", "planSHA256", "requestedUserDecision", "requestedMediatorAction", "memoryUpdates", "findings", "evidenceRefs",
  "status", "remainingSteps", "resolvesRequestedDecision", "resolvedRequestId", "resolvedRequestIds", "reviewDecisionAnswers", "decisionAssessments",
] as const;

function withoutNullOptionals(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = { ...(value as Record<string, unknown>) };
  for (const key of OPTIONAL_KEYS) {
    if (record[key] === null) delete record[key];
  }
  if (Array.isArray(record.findings)) {
    record.findings = record.findings.map((finding) => {
      if (!finding || typeof finding !== "object" || Array.isArray(finding)) return finding;
      const copy = { ...(finding as Record<string, unknown>) };
      if (copy.disposition === null) delete copy.disposition;
      if (copy.evidenceGap === null) delete copy.evidenceGap;
      if (copy.planImpact === null) delete copy.planImpact;
      return copy;
    });
  }
  return record;
}

// 한 번 응답 한도(zod 밖) 위반 — 표기만 고치면 되는 위반이라 교정은 추론 low 로 간다(core.isFormatOnlyViolation).
export class ResponseLimitViolation extends Error {}

// 모델 한 번 응답의 검증 전부(zod + 응답 한도). 어댑터 파싱과 enforceResultContract 의 첫 검사가 같은 규칙을 쓴다 — 검증 안 된 결과가 교정 경로로
// 오면(UnverifiedAgentResult) 응답 한도까지 거기서 다시 걸러야 한다(2026-10-07 R3).
// 원장 한도는 누적 저장 계약(무제한)과 분리한다(F10). 서버 승계로 500행을 넘는 것은 저장 쪽 몫이다.
export function validateAgentResult(value: unknown): AgentResult {
  const parsed = AgentResultSchema.parse(withoutNullOptionals(value));
  // 해소 요청 id 도 같은 분리 — 응답 한도는 여기서, 저장 계약(교정 병합 합집합)은 무제한(host-review R02).
  if ((parsed.resolvedRequestIds?.length ?? 0) > RESPONSE_RESOLVED_IDS_LIMIT) {
    throw new ResponseLimitViolation(`resolvedRequestIds 가 한 번 응답 한도 ${RESPONSE_RESOLVED_IDS_LIMIT}개를 넘습니다(열린 요청과 일치하는 id 만 적으세요)`);
  }
  return parsed;
}

function parseResult(value: unknown): { success: true; data: AgentResult } | { success: false; error: unknown } {
  try {
    return { success: true, data: validateAgentResult(value) };
  } catch (error) {
    return { success: false, error };
  }
}

// 최종 구조화 응답은 왔지만 검증(validateAgentResult)에 실패했다. 메시지는 기존 계약 실패 문구 그대로라 지금의 소비처(문구 판정·FAILED 기록)는 같다.
// raw 는 그 응답 객체다. 실행기(TurnExecutor)만, 결과를 곧바로 enforceResultContract 로 넘기는 요청에서 이것을 결과로 바꿔 같은 세션 교정으로 보낸다
// (2026-10-07 R3: 505자 단계 하나로 1145초 근거 검토 결과가 통째로 버려졌다). 그 밖의 소비처(엔진 결함 워커 등)는 지금처럼 오류를 받는다.
const unverifiedResults = new WeakSet<object>();
export class UnverifiedAgentResult extends Error {
  constructor(readonly raw: Record<string, unknown>, message: string) {
    super(message);
    unverifiedResults.add(raw);
  }
}

// 검증 안 된 한 번 응답인가 — enforceResultContract 가 응답 한도까지 다시 검사하고, 실행기·소비처가 검증된 결과로 다루지 않게 가른다.
// 여러 턴을 합친 결과(재대조의 누적본)는 이 표식이 없어 응답 한도를 받지 않는다(저장 계약은 무제한, R02).
export function isUnverifiedResult(value: unknown): boolean {
  return typeof value === "object" && value !== null && unverifiedResults.has(value);
}

// 저장해 둔 한 번 응답(교정 대기본·근거 검토 영수증의 원본)을 다시 계약 검사에 넘길 때 표식을 붙인다 — 직렬화로 표식이 사라져도 응답 한도를 다시 받게.
export function unverifiedResponse<T extends object>(value: T): T {
  unverifiedResults.add(value);
  return value;
}

export function parseAgentResult(candidates: unknown[], stdout: string): AgentResult {
  // 왜 구조가 없는지 남긴다 — CLI 의 result 이벤트(subtype·is_error·num_turns·본문 앞부분)가 진단의 전부인데 버려지고
  // 있었다(2026-09-13 S10 실측: 수정 턴이 tool_use 직후 result 로 끝났는데 원인을 알 길이 없었다).
  const message = () => `에이전트가 계약된 구조의 결과를 반환하지 않았습니다.${describeTerminalResult(candidates, stdout)}`;
  // 모델이 제출한 최종 구조화 응답을 먼저 정한다 — 그 응답이 검증에 실패하면 같은 호출의 앞선 유효 JSON(오래된 판정)으로 물러서지 않고 교정 경로로
  // 보낸다(R3 리뷰 F001: Codex 의 앞선 agent_message 가 유효한 REVIEW 이면 마지막 응답의 새 지적이 교정 없이 사라졌다).
  // 응답 본문을 가진 최종 이벤트가 있으면 내용과 관계없이 그것만 본다(R3 재리뷰 F001) — 결과 종류 없는 JSON·일반 문장·오류 본문이어도 앞선 후보로
  // 물러서지 않는다. 구조화 응답이 아니면 교정할 결과가 없으므로 일반 오류로 멈춘다. 최종 이벤트에 응답 본문이 없으면(사용량만 실린 result 이벤트 등)
  // 그보다 새 응답이 없다는 뜻이라 지금처럼 앞선 후보를 찾는다.
  const event = finalEvent(candidates);
  if (event && hasResponseBody(event)) {
    const final = finalStructuredResponse(event);
    if (!final) throw new Error(message());
    const parsed = parseResult(final);
    if (parsed.success) return parsed.data;
    throw new UnverifiedAgentResult(final, message());
  }
  // 응답 본문을 가진 최종 이벤트가 없을 때만 지금처럼 후보를 뒤에서부터, 그다음 stdout 을 찾는다.
  for (const candidate of [...candidates].reverse()) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  const direct = parseJsonText(stdout);
  if (direct) return direct;
  const raw = event ? null : structuredRecord(jsonObject(stdout));
  throw raw ? new UnverifiedAgentResult(raw, message()) : new Error(message());
}

// 검증에 실패한 최종 구조화 응답 — parseStructuredResult 와 같은 마지막 응답 하나(Claude: result 이벤트의 structured_output, 없으면 result 본문,
// Codex: 마지막 agent_message)만 본다. 앞 메시지의 JSON 은 모델이 제출한 결과가 아니다. 결과 종류(kind 문자열)가 없는 객체는 구조화 응답으로 보지 않는다.
// stdout 은 최종 이벤트가 없을 때만 본다(parseAgentResult 의 마지막 단계) — 후보 객체보다 먼저 이기지 않게.
function finalStructuredResponse(final: Record<string, unknown>): Record<string, unknown> | null {
  return structuredRecord(finalResponseValue(final));
}

// 최종 이벤트가 실은 응답 값 — Claude result 의 structured_output(없으면 result 본문의 JSON), Codex agent_message 본문의 JSON.
function finalResponseValue(final: Record<string, unknown>): unknown {
  return final.type === "result" ? (isRecord(final.structured_output) ? final.structured_output : jsonObject(final.result))
    : jsonObject(isRecord(final.item) ? final.item.text : undefined);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function finalEvent(candidates: readonly unknown[]): Record<string, unknown> | undefined {
  return [...candidates].reverse().filter(isRecord)
    .find(event => event.type === "result" || (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message"));
}

// 최종 이벤트가 모델 응답 본문을 실었는가 — Claude result 의 structured_output 또는 result 글, Codex agent_message 의 글.
function hasResponseBody(final: Record<string, unknown>): boolean {
  return final.type === "result" ? final.structured_output !== undefined && final.structured_output !== null || typeof final.result === "string"
    : isRecord(final.item) && typeof final.item.text === "string";
}

function structuredRecord(value: unknown): Record<string, unknown> | null {
  const record = withoutNullOptionals(value);
  return isRecord(record) && typeof record.kind === "string" ? record : null;
}

function jsonObject(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  for (const attempt of fenced ? [trimmed, fenced.trim()] : [trimmed]) {
    try { return JSON.parse(attempt); } catch { /* next representation */ }
  }
  return undefined;
}

function parseCandidate(candidate: unknown): AgentResult | null {
  const direct = parseResult(candidate);
  if (direct.success) return direct.data;
  if (!candidate || typeof candidate !== "object") return null;
  const value = candidate as Record<string, unknown>;
  for (const key of ["structured_output", "structuredOutput", "result", "output", "text"]) {
    const nested = value[key];
    const parsed = typeof nested === "string" ? parseJsonText(nested) : parseResult(nested);
    if (parsed && "success" in parsed) {
      if (parsed.success) return parsed.data;
    } else if (parsed) return parsed;
  }
  const item = value.item as Record<string, unknown> | undefined;
  if (item?.type === "agent_message" && typeof item.text === "string") return parseJsonText(item.text);
  return null;
}

// 결과 봉투(D3) — 모델이 제출한 마지막 최종 응답 하나만 읽는다(앞 메시지의 JSON 은 제출한 결과가 아니다). 응답이 JSON 객체가 아니면 교정할 결과가 없으므로
// 일반 오류다. 객체인데 이 역할의 봉투 계약을 어기면 그 응답을 UnverifiedAgentResult 로 넘긴다 — 같은 세션 교정은 실행기가 정한다.
// 값이 null 인 선택 키(CLI 스키마의 "required + null")는 지운 뒤 검사한다.
const ENVELOPE_OPTIONAL_KEYS = ["mediatorRequest", "memoryUpdates", "engineDefects"] as const;

export function parseTurnEnvelope(role: EnvelopeRole, candidates: readonly unknown[], stdout: string): TurnEnvelope {
  const message = () => `에이전트가 결과 봉투를 반환하지 않았습니다.${describeTerminalResult(candidates, stdout)}`;
  const event = finalEvent(candidates);
  const value = event && hasResponseBody(event) ? finalResponseValue(event) : undefined;
  if (!isRecord(value)) throw new Error(message());
  const response = { ...value };
  for (const key of ENVELOPE_OPTIONAL_KEYS) if (response[key] === null) delete response[key];
  const issues = envelopeIssues(role, response);
  if (issues.length === 0) return turnEnvelopeSchema(role).parse(response);
  throw new UnverifiedAgentResult(response, `${message()} 계약 위반: ${issues.join("; ")}`);
}

// 두 CLI 모두 실패 사유를 stderr가 아니라 stdout에 쓴다 — codex는 스키마 400을, claude는 사용량·API
// 오류를 stream-json 이벤트로 낸다. stderr만 담으면 "실행 실패(1): "만 남아 원인을 구별할 수 없다
// (2026-08-29에 두 번 그렇게 잃었다). 그래서 stdout 꼬리를 함께 싣는다.
export function describeCommandFailure(
  label: string,
  exitCode: number | null,
  stderr: string,
  stdout: string,
): string {
  // 원장·타임라인에 남는 진단은 사람이 읽을 크기(수 KB)면 충분하다(감사 최적화 지적).
  const details = [tailForDiagnosis(stderr.trim(), 6, 4_000), terminalMessage(stdout) ?? tailForDiagnosis(stdout)]
    .filter(Boolean).join("\n");
  return `${label} 실행 실패(${exitCode}): ${redactSecrets(details) || "stderr와 stdout 모두 비어 있습니다."}`;
}

// 공급자 CLI 비정상 종료(E3-3a) — 메시지는 기존 describeCommandFailure 문자열 그대로이고(기존 문구 판정 호환), 관측된 실패 형태만 code 로 올린다.
// 래퍼·엔진은 message 가 아니라 code 로만 가른다. raw 는 판정에 쓴 출력 꼬리를 보존한다(원형 보존 정지·복구 기록용).
export class AgentRunError extends Error {
  constructor(readonly code: AgentRunErrorCode, readonly provider: "claude" | "codex", message: string,
    readonly raw: { exitCode: number | null; stderr: string; stdout: string }) {
    super(message);
    this.name = "AgentRunError";
  }
}

// 재개한 세션이 요청과 다른 신원으로 응답했다(E3-3a) — 응답을 채택하지 않는 기존 차단은 그대로이고, 요청·반환 id 를 구조로 실어 호출자가 복구 상태에
// 남기게 한다. 자동 복구 사유가 아니다(메시지는 기존 문자열 그대로).
export class SessionIdentityMismatch extends Error {
  constructor(readonly provider: "claude" | "codex", readonly requested: string, readonly returned: string, message: string) {
    super(message);
    this.name = "SessionIdentityMismatch";
  }
}

export function agentRunError(provider: "claude" | "codex", exitCode: number | null, stderr: string, stdout: string): AgentRunError {
  return new AgentRunError(classifyRunFailure(provider, stderr, stdout), provider,
    describeCommandFailure(provider === "claude" ? "Claude" : "Codex", exitCode, stderr, stdout),
    { exitCode, stderr: redactSecrets(tailForDiagnosis(stderr, 6, 4_000)), stdout: redactSecrets(tailForDiagnosis(stdout)) });
}

// 관측된 형태만 판정한다 — 비슷한 문구·일반 실패·사용 한도(429)는 unknown 이다. 새 형태는 실제 관측을 근거로만 더한다.
// - Claude 세션 유실(운영 기록 2026-09-08, 주제 5154fc57 seq 63): stderr "No conversation found with session ID: <id>" 와 마지막 result 이벤트
//   is_error=true·num_turns=0(모델 호출 없음).
// - Codex 세션 유실(격리 실측 2026-09-26, codex-cli 0.155.0-alpha.9, 빈 CODEX_HOME 에서 없는 thread 로 exec resume): stdout 비어 있음,
//   stderr "Error: thread/resume: thread/resume failed: no rollout found for thread id <id> (code -32600)".
// - Codex 문맥 초과(운영 기록 2026-09-06, 주제 e13f53ae seq 43, CODEX_CLOSEOUT): 마지막 오류 이벤트 message
//   "Codex ran out of room in the model's context window. …".
export function classifyRunFailure(provider: "claude" | "codex", stderr: string, stdout: string): AgentRunErrorCode {
  const events = stdout.trim().split(/\r?\n/).flatMap((line) => {
    try {
      const value = JSON.parse(line) as unknown;
      return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch { return []; }
  });
  if (provider === "claude") {
    const result = [...events].reverse().find((event) => event.type === "result");
    if (/^No conversation found with session ID: \S+/m.test(stderr) && result?.is_error === true && result.num_turns === 0) return "session-missing";
    return "unknown";
  }
  if (stdout.trim() === "" && /^Error: thread\/resume: thread\/resume failed: no rollout found for thread id \S+ \(code -32600\)$/m.test(stderr)) {
    return "session-missing";
  }
  const messages = events.flatMap((event) => [event.message, (event.error as { message?: unknown } | undefined)?.message])
    .filter((value): value is string => typeof value === "string");
  if (messages.some((message) => message.startsWith("Codex ran out of room in the model's context window."))) return "context-exceeded";
  return "unknown";
}

// 두 CLI 다 마지막 이벤트에 사람이 읽을 사유를 담는다(claude는 result.result, codex는 error.message).
// 그걸 뽑아내면 4KB짜리 JSON 꼬리 대신 "월 지출 한도" 같은 한 줄이 원장에 남는다.
// 마지막 result 이벤트의 요약. stream-json: {"type":"result","subtype":"success|error_max_turns|error_during_execution|…",
// "is_error":bool,"num_turns":n,"result":"본문"}. codex: {"type":"turn.completed"} 다음 줄에 error 가 올 수 있다.
// CLI 가 모델을 한 번도 부르지 않고 끝낸 결과(num_turns=0, is_error=false) — 2026-09-14 S10H 실측: 이전 프로세스가 남긴
// 백그라운드 작업 알림이 resume 직후 큐에서 먼저 빠지며 합성 턴("No response requested")이 result 로 나갔고 실제 프롬프트는
// 응답 없이 남았다. 모델 비용 0 이므로 같은 호출을 한 번 다시 돌리는 것이 정확한 처방이다(FAILED 로 사람을 부르는 것이 아니라).
export function isZeroTurnResult(candidates: readonly unknown[]): boolean {
  const events = [...candidates].reverse().filter((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value));
  const result = events.find((event) => event.type === "result");
  return Boolean(result) && result!.num_turns === 0 && result!.is_error !== true;
}

function describeTerminalResult(candidates: readonly unknown[], stdout: string): string {
  const events = [...candidates].reverse().filter((value): value is Record<string, unknown> =>
    Boolean(value) && typeof value === "object" && !Array.isArray(value));
  const result = events.find((event) => event.type === "result") ?? events.find((event) => event.type === "turn.completed" || event.type === "error");
  const parts: string[] = [];
  if (result) {
    if (typeof result.subtype === "string") parts.push(`subtype=${result.subtype}`);
    if (typeof result.is_error === "boolean") parts.push(`is_error=${result.is_error}`);
    if (typeof result.num_turns === "number") parts.push(`num_turns=${result.num_turns}`);
    if (typeof result.stop_reason === "string") parts.push(`stop_reason=${result.stop_reason}`);
    const text = typeof result.result === "string" ? result.result : typeof result.message === "string" ? result.message : null;
    if (text) parts.push(`text=${JSON.stringify(redactSecrets(text.slice(0, 300)))}`);
    const errors = Array.isArray(result.errors) ? result.errors : null;
    if (errors && errors.length > 0) parts.push(`errors=${JSON.stringify(redactSecrets(JSON.stringify(errors).slice(0, 300)))}`);
  } else {
    parts.push("result 이벤트 없음");
  }
  const terminal = terminalMessage(stdout);
  if (terminal) parts.push(`terminal=${JSON.stringify(terminal.slice(0, 200))}`);
  return parts.length ? ` (${parts.join(" · ")})` : "";
}

function terminalMessage(stdout: string): string | null {
  const lines = stdout.trim().split(/\r?\n/);
  for (const line of [...lines].reverse().slice(0, 12)) {
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const status = event.api_error_status ?? event.error;
    const candidates = [
      typeof event.result === "string" && event.is_error ? event.result : null,
      typeof event.message === "string" ? event.message : null,
      typeof (event.error as { message?: unknown })?.message === "string"
        ? (event.error as { message: string }).message
        : null,
    ].filter((value): value is string => Boolean(value));
    if (candidates.length > 0) {
      return status ? `${candidates[0]} (${JSON.stringify(status)})` : candidates[0];
    }
  }
  return null;
}

// 마지막 줄들에 종료 사유가 담긴다. 통째로 실으면 원장과 타임라인이 프롬프트 크기만큼 부풀어 오른다.
function tailForDiagnosis(stdout: string, lines = 6, limit = 4_000): string {
  const tail = stdout.trim().split(/\r?\n/).slice(-lines).join("\n");
  return tail.length > limit ? `…${tail.slice(-limit)}` : tail;
}

function parseJsonText(text: string): AgentResult | null {
  const trimmed = text.trim();
  const attempts = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  if (fenced) attempts.push(fenced.trim());
  for (const attempt of attempts) {
    try {
      const parsed = parseResult(JSON.parse(attempt));
      if (parsed.success) return parsed.data;
    } catch { /* next representation */ }
  }
  return null;
}


// 소비처 schema 의 결과(엔진 개편 E2e) — 계약 형태를 여기서 알 수 없으므로 "들어맞는 JSON 객체"를 찾아 앞 메시지까지 훑지 않는다. 마지막 최종 응답
// 하나만 읽는다(Codex: 마지막 agent_message, Claude: result 이벤트의 structured_output). 그 응답이 JSON 객체가 아니면 실패다. 의미 검증은 소비처 몫이다.
export function parseStructuredResult(candidates: readonly unknown[], stdout: string): Record<string, unknown> {
  const isRecord = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value);
  const final = [...candidates].reverse().filter(isRecord)
    .find(event => event.type === "result" || (event.type === "item.completed" && isRecord(event.item) && event.item.type === "agent_message"));
  let value: unknown;
  if (final?.type === "result") value = final.structured_output;
  else if (final && isRecord(final.item) && typeof final.item.text === "string") {
    try { value = JSON.parse(final.item.text.trim()); } catch { value = undefined; }
  }
  if (isRecord(value)) return value;
  throw new Error(`에이전트의 마지막 응답이 JSON 객체가 아닙니다.${describeTerminalResult(candidates, stdout)}`);
}

// 부분 계획 교정 응답이 PlanRepair 계약(서버 스키마)을 어겼다 — 전송·실행 실패와 구분되는 교정 응답의 형식 위반이다. core 는 이 오류만 교정 뒤 위반으로
// 받아 원본을 교정 대기본으로 남긴다(R3 리뷰 F004: CLI 스키마는 edits: [] 를 허용하지만 서버 계약 min(1)에 걸려 일반 오류로 계획 전체를 다시 샀다).
export class PlanRepairViolation extends Error {}

// Repair responses cannot be interpreted as a full AgentResult (or accidentally reuse one from stdout).
export function parsePlanRepair(candidates: unknown[], stdout: string): PlanRepair {
  const inspect = (value: unknown, depth = 0): PlanRepair | null => {
    if (depth > 4) return null;
    if (typeof value === "string") {
      try { return inspect(JSON.parse(value), depth + 1); } catch { return null; }
    }
    const parsed = PlanRepairSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    if (!value || typeof value !== "object") return null;
    const row = value as Record<string, unknown>;
    for (const key of ["structured_output", "structuredOutput", "result", "output", "text", "item"]) {
      const nested = inspect(row[key], depth + 1);
      if (nested) return nested;
    }
    return null;
  };
  for (const candidate of [...candidates].reverse()) {
    const repair = inspect(candidate);
    if (repair) return repair;
  }
  const direct = inspect(stdout);
  if (direct) return direct;
  throw new PlanRepairViolation("부분 교정 결과가 PlanRepair 계약을 만족하지 않습니다.");
}
