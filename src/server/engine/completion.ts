// 완료 판정기 — 구현·수정 결과 하나를 `완료 | 계속 진행 | 입력·증거 대기 | 상태 확인 필요` 로 판정한다(PLAN §2 "완료 판정").
// 판정을 통과한 결과만 AcceptedResult 로 다음 단계(리뷰·최종 리뷰·완료 처리)에 넘긴다 — 타입이 경계다.
//
// 규칙(위에서부터 먼저 맞는 것):
//   blocked ................................. 입력 대기
//   열린 요청 + 그 뒤 결정 없음 ............... 입력 대기(요청 결정)
//   열린 요청 + 그 뒤 결정 있음 + 해소 미확인 .. 상태 확인 필요(결정이 왔다는 이유로 요청을 지우지 않는다 — 러너가 해소를 확인해야 한다)
//   requiresUserDecision 쟁점 / EXTERNAL_EVIDENCE 처분 ... 입력·증거 대기
//   status 없음 ............................. 상태 확인 필요(신규·기존 결과 모두 — 읽기 전용 확인 1회, 그래도 불명확하면 보존한 채 멈춤)
//   completed + remainingSteps .............. 상태 확인 필요(모순)
//   in_progress ............................. 계속 진행
//   completed ............................... 완료
import type { AgentResult } from "../../shared/contracts.js";

// 열린 요청 — id 는 문구와 제시 시점(sequence)으로 만든다: 같은 질문을 나중에 다시 하면 새 요청, 아직 열린 채 다시 하면 같은 요청.
export interface OpenRequest { id: string; text: string; askedAfterSequence: number }

// 정지를 만드는 모든 사용자 요청을 같은 형태로 보존한다. 이후 응답에서 표시가 사라져도 열린 요청은 남는다.
export function decisionRequestTexts(result: Pick<AgentResult, "requestedUserDecision" | "findings" | "status" | "summary" | "remainingSteps">): string[] {
  const requests = [result.requestedUserDecision?.trim(),
    ...result.findings.filter((finding) => finding.requiresUserDecision).map((finding) => finding.rationale.trim() || finding.title.trim())];
  if (result.status === "blocked" && !requests.some(Boolean)) requests.push(`러너가 막힘(blocked)으로 정지했습니다 — ${result.summary} — 남은 단계: ${(result.remainingSteps ?? []).join(" · ") || "(명시 없음)"}`);
  return [...new Set(requests.filter((text): text is string => Boolean(text)))];
}

export function renderOpenRequests(requests: readonly OpenRequest[]): string {
  return requests.map((request) => `[${request.id}] ${request.text}`).join("\n\n");
}

export type CompletionVerdict =
  | { kind: "completed" }
  | { kind: "continue"; remainingSteps: string[] }
  | { kind: "await-input"; reason: "blocked" | "requested-decision" | "finding-decision" | "external-evidence"; message: string; requests?: OpenRequest[] }
  | { kind: "needs-confirmation"; reason: "status-missing" | "contradiction" | "open-request-after-decision"; message: string; requests?: OpenRequest[] };

export interface VerdictContext {
  openRequests: readonly OpenRequest[];
  // 열린 요청(가장 오래된 것 기준)이 제시된 뒤 사용자 결정이 도착했는가(타임라인 대조, 호출자가 계산).
  decisionAfterRequest: boolean;
  // 이 작업에 실린 진단 중 결과가 반영(RESOLVED_BY_FIX)도 반환(반박·증거 요청)도 보고하지 않은 것(AGREED_ACTION·누락). completed 와 함께면 모순이다 —
  // 진단이 전달됨인 채 리뷰·인도 대기로 넘어갔다(2026-09-15 감사, PLAN 3단계 완료 모순 판정).
  unresolvedDiagnoses?: readonly string[];
}

declare const acceptedBrand: unique symbol;
// 완료 판정을 통과한 결과만 만들 수 있다(acceptResult) — 리뷰·최종 리뷰·완료 처리는 이 타입만 받는다.
export type AcceptedResult = AgentResult & { readonly [acceptedBrand]: true };

export function completionVerdict(result: AgentResult, context: VerdictContext): CompletionVerdict {
  const remaining = result.remainingSteps ?? [];
  if (result.status === "blocked") {
    const requests = [...context.openRequests];
    const asked = requests.length ? `\n${renderOpenRequests(requests)}` : "";
    return { kind: "await-input", reason: "blocked", message: `러너가 막힘(blocked)으로 정지했습니다 — 남은 단계: ${remaining.join(" · ") || "(명시 없음)"}${asked}`, requests };
  }
  if (context.openRequests.length > 0) {
    const requests = [...context.openRequests];
    if (!context.decisionAfterRequest) {
      return { kind: "await-input", reason: "requested-decision", message: renderOpenRequests(requests), requests };
    }
    return {
      kind: "needs-confirmation", reason: "open-request-after-decision", requests,
      message: `열린 요청(${requests.map((request) => request.id).join(", ")}) 뒤에 결정이 올라왔지만 러너가 해소 여부(resolvesRequestedDecision + resolvedRequestId)를 밝히지 않았습니다 — 읽기 전용으로 확인합니다.`,
    };
  }
  const findingDecision = result.findings.find((finding) => finding.requiresUserDecision);
  if (findingDecision) return { kind: "await-input", reason: "finding-decision", message: findingDecision.rationale };
  const evidence = result.findings.find((finding) => finding.disposition === "EXTERNAL_EVIDENCE");
  if (evidence) return { kind: "await-input", reason: "external-evidence", message: evidence.rationale };
  if (result.status === undefined) {
    return { kind: "needs-confirmation", reason: "status-missing", message: "결과에 status(completed·in_progress·blocked)가 없습니다 — 완료 여부를 읽기 전용으로 확인합니다." };
  }
  if (result.status === "completed" && remaining.length > 0) {
    return { kind: "needs-confirmation", reason: "contradiction", message: `status=completed 인데 남은 단계가 적혀 있습니다(${remaining.join(" · ")}) — 완료로 보지 않고 확인합니다.` };
  }
  const unresolved = context.unresolvedDiagnoses ?? [];
  if (result.status === "completed" && unresolved.length > 0) {
    return { kind: "continue", remainingSteps: [...remaining, ...unresolved.map((id) =>
      `중재자 진단 ${id}: 반영했으면 RESOLVED_BY_FIX, 반박·증거 요청이면 그 처분으로 보고(지금은 미반영 처분인 채 status=completed)`)] };
  }
  if (result.status === "in_progress") return { kind: "continue", remainingSteps: remaining };
  return { kind: "completed" };
}

// 판정이 "완료" 일 때만 부른다 — 다른 판정에서 부르면 프로그래밍 오류다.
export function acceptResult(result: AgentResult, verdict: CompletionVerdict): AcceptedResult {
  if (verdict.kind !== "completed") throw new Error(`완료 판정이 아닌 결과를 받아들이려 했습니다: ${verdict.kind}`);
  return result as AcceptedResult;
}
