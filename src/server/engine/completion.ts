// 결과가 요청한 정지와 그 요청 문구의 공통 표현 — 엔진 결함 수정 턴(engineDefects)이 작업자 결과를 받을지 정할 때 쓴다.
// 구현·수정 결과의 완료 판정(completionVerdict·AcceptedResult)은 구현·리뷰 왕복(relay)이 봉투 outcome 만 읽게 되면서 지웠다(CR 흐름 단순화 D8).
import type { AgentResult } from "../../shared/contracts.js";

const MEDIATOR_REQUEST_PREFIX = "중재자 실행 요청: ";

// 정지를 만드는 모든 사용자 요청을 같은 형태로 모은다(중복 문구는 하나로).
export function decisionRequestTexts(result: Pick<AgentResult, "requestedUserDecision" | "requestedMediatorAction" | "findings" | "status" | "summary" | "remainingSteps">): string[] {
  const requests = [result.requestedUserDecision?.trim(), result.requestedMediatorAction?.trim() ? `${MEDIATOR_REQUEST_PREFIX}${result.requestedMediatorAction.trim()}` : undefined,
    ...result.findings.filter((finding) => finding.requiresUserDecision).map((finding) => finding.rationale.trim() || finding.title.trim())];
  if (result.status === "blocked" && !requests.some(Boolean)) requests.push(`러너가 막힘(blocked)으로 정지했습니다 — ${result.summary} — 남은 단계: ${(result.remainingSteps ?? []).join(" · ") || "(명시 없음)"}`);
  return [...new Set(requests.filter((text): text is string => Boolean(text)))];
}

// 결과 하나가 요청한 정지 — 중재자 실행 · 사용자 결정(blocked 포함) · 외부 증거. 엔진 결함 수정 턴은 이 정지가 있으면 결과를 받지 않는다.
export type ResultPause =
  | { kind: "mediator"; action: string }
  | { kind: "decision"; message: string | undefined; blocked: boolean; remainingSteps: string[] }
  | { kind: "evidence"; message: string };
export function resultPause(result: Pick<AgentResult, "requestedMediatorAction" | "requestedUserDecision" | "findings" | "status" | "remainingSteps">): ResultPause | null {
  const action = result.requestedMediatorAction?.trim();
  if (action) return { kind: "mediator", action };
  const remainingSteps = result.remainingSteps ?? [];
  const blocked = result.status === "blocked"
    ? `러너가 막힘(blocked)으로 정지했습니다 — 남은 단계: ${remainingSteps.join(" · ") || "(명시 없음)"}` : undefined;
  const decision = result.requestedUserDecision ?? blocked ?? result.findings.find((finding) => finding.requiresUserDecision)?.rationale;
  if (decision) return { kind: "decision", message: decision, blocked: result.status === "blocked", remainingSteps };
  const evidence = result.findings.find((finding) => finding.disposition === "EXTERNAL_EVIDENCE");
  if (evidence) return { kind: "evidence", message: evidence.rationale };
  return null;
}
