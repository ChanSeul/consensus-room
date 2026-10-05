import {
  PlanRepairSchema, type PlanRepair, AgentResultSchema, RESPONSE_LEDGER_LIMIT, RESPONSE_RESOLVED_IDS_LIMIT, type AgentResult,
} from "../../shared/contracts.js";
import { redactSecrets } from "../../shared/workflow.js";
import type { AgentRunErrorCode } from "../../shared/planningControl.js";

// AgentResultJsonSchema는 선택 필드를 "required + null 허용"으로 표현한다 — OpenAI 구조화 출력이
// required에 properties의 전 키를 요구하기 때문이다(그 주석 참조). 모델은 값이 없으면 null을 보내는데
// zod에서 그 필드들은 optional이라 null을 받지 못한다. 그래서 파싱 전에 값이 null인 키만 지운다.
// memoryUpdates[].expectedSHA256처럼 null 자체가 유효한 값인 필드는 건드리지 않으므로 재귀로 훑지 않는다.
const OPTIONAL_KEYS = [
  "planningStep",
  "engineDefects",
  "planMarkdown", "planEdits", "planLineEdits", "planSHA256", "requestedUserDecision", "memoryUpdates", "findings", "evidenceRefs",
  "toleranceLedger", "status", "remainingSteps", "resolvesRequestedDecision", "resolvedRequestId", "resolvedRequestIds", "reviewDecisionAnswers", "decisionAssessments",
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
      return copy;
    });
  }
  return record;
}

// 모델 한 번 응답의 원장 한도 — 누적 저장 계약(무제한)과 분리한다(F10). 서버 승계로 500행을 넘는 것은 저장 쪽 몫이다.
function parseResult(value: unknown) {
  const parsed = AgentResultSchema.safeParse(withoutNullOptionals(value));
  if (parsed.success && (parsed.data.toleranceLedger?.length ?? 0) > RESPONSE_LEDGER_LIMIT) {
    return { success: false as const, error: new Error(`toleranceLedger 가 한 번 응답 한도 ${RESPONSE_LEDGER_LIMIT}행을 넘습니다(서버가 앞 턴 원장을 승계하므로 이번 턴 변경분만 적으세요)`) };
  }
  // 해소 요청 id 도 같은 분리 — 응답 한도는 여기서, 저장 계약(교정 병합 합집합)은 무제한(host-review R02).
  if (parsed.success && (parsed.data.resolvedRequestIds?.length ?? 0) > RESPONSE_RESOLVED_IDS_LIMIT) {
    return { success: false as const, error: new Error(`resolvedRequestIds 가 한 번 응답 한도 ${RESPONSE_RESOLVED_IDS_LIMIT}개를 넘습니다(열린 요청과 일치하는 id 만 적으세요)`) };
  }
  return parsed;
}

export function parseAgentResult(candidates: unknown[], stdout: string): AgentResult {
  for (const candidate of [...candidates].reverse()) {
    const parsed = parseCandidate(candidate);
    if (parsed) return parsed;
  }
  const direct = parseJsonText(stdout);
  if (direct) return direct;
  // 왜 구조가 없는지 남긴다 — CLI 의 result 이벤트(subtype·is_error·num_turns·본문 앞부분)가 진단의 전부인데 버려지고
  // 있었다(2026-09-13 S10 실측: 수정 턴이 tool_use 직후 result 로 끝났는데 원인을 알 길이 없었다).
  throw new Error(`에이전트가 계약된 구조의 결과를 반환하지 않았습니다.${describeTerminalResult(candidates, stdout)}`);
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
  throw new Error("부분 교정 결과가 PlanRepair 계약을 만족하지 않습니다.");
}
