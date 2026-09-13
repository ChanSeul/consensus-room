import { AgentResultSchema, type AgentResult } from "../../shared/contracts.js";
import { redactSecrets } from "../../shared/workflow.js";

// AgentResultJsonSchema는 선택 필드를 "required + null 허용"으로 표현한다 — OpenAI 구조화 출력이
// required에 properties의 전 키를 요구하기 때문이다(그 주석 참조). 모델은 값이 없으면 null을 보내는데
// zod에서 그 필드들은 optional이라 null을 받지 못한다. 그래서 파싱 전에 값이 null인 키만 지운다.
// memoryUpdates[].expectedSHA256처럼 null 자체가 유효한 값인 필드는 건드리지 않으므로 재귀로 훑지 않는다.
const OPTIONAL_KEYS = [
  "planMarkdown", "planEdits", "planSHA256", "requestedUserDecision", "memoryUpdates", "findings", "evidenceRefs",
  "toleranceLedger",
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
      return copy;
    });
  }
  return record;
}

function parseResult(value: unknown) {
  return AgentResultSchema.safeParse(withoutNullOptionals(value));
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

// 두 CLI 다 마지막 이벤트에 사람이 읽을 사유를 담는다(claude는 result.result, codex는 error.message).
// 그걸 뽑아내면 4KB짜리 JSON 꼬리 대신 "월 지출 한도" 같은 한 줄이 원장에 남는다.
// 마지막 result 이벤트의 요약. stream-json: {"type":"result","subtype":"success|error_max_turns|error_during_execution|…",
// "is_error":bool,"num_turns":n,"result":"본문"}. codex: {"type":"turn.completed"} 다음 줄에 error 가 올 수 있다.
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
