// 계획 항목 coverage(2026-10-11 사용자 요청) — planned 토픽에서 승인 계획이 선언한 항목(shared/planItems)마다 구현자 보고와 코드 리뷰어 판정이 있고, 전 항목
// 충족 판정이 승인 판·검토 트리에 결속된 영수증으로 남아야만 READY_TO_DELIVER·commit·push·close 가 된다. 기존 ```checks(planCheckGate, 엔진 실행 검사)와
// 별개 계약이고 ticket 은 지나지 않는다. 판정은 집합 일치·status·근거 유무뿐이다 — 구현의 의미적 정확성과 근거의 진실성은 리뷰어·중재자·사용자가 본다.
//   선언 판정(declaredPlanItems) ......... 승인 경계(approve)·구현 진입·리뷰 진입이 쓴다. 선언 없음·형식 오류는 모델 호출 0 으로 멈춘다(보완 경로 안내).
//   구현자 보고(implementerCoverage) ...... done 봉투의 planItems 가 선언 집합과 정확히 같고 전부 implemented 인가 — 아니면 같은 세션의 교정 턴.
//   리뷰어 판정(reviewerCoverage) ......... approve 봉투의 planItems 가 선언 집합과 같은가(format → 같은 리뷰 세션 교정 턴) · 전부 satisfied 인가(unmet → CLAUDE_FIX).
//   영수증(coverage receipt) .............. READY 전이 사건의 payload.planCoverage — 전달 경계(deliveryCoverageProblem)가 승인 판·세대·epoch·검토 트리와 대조한다.
import { createHash } from "node:crypto";
import type { TimelineEvent, Topic } from "../../shared/contracts.js";
import { parsePlanItems, planItemCoverage, PLAN_ITEMS_EXAMPLE, PlanItemsError, type PlanItem, type PlanItemReport, type PlanItemViolations } from "../../shared/planItems.js";
import type { InternalTopicFlags } from "../types.js";
import type { EnvelopeEvent } from "./core.js";

export const PLAN_ITEMS_CHECK_ID = "plan-items";
// 보완 경로 — 목록이 없거나 틀린 승인 계획은 같은 플래너 세션이 고치고(return-to-planning → 리뷰 → 승인), 계획 없이 이을 작업은 명시적 방식 전환(ticket)이다.
// 자동으로 바꾸지 않는다.
const REMEDIATION = "return-to-planning 으로 같은 플래너 세션이 plan-items 목록을 보완한 뒤 리뷰·승인을 다시 받거나, 계획 없이 잇는 작업이면 workflow-mode 로 ticket 을 고르세요.";

export type PlanItemsDeclaration =
  | { kind: "declared"; items: PlanItem[] }
  | { kind: "undeclared"; message: string }
  | { kind: "invalid"; message: string };

// 계획 본문(승인 판의 산출물 원문)의 항목 선언 — 호출자가 kind 로 멈출지 정한다.
export function declaredPlanItems(planContent: string): PlanItemsDeclaration {
  try {
    const items = parsePlanItems(planContent);
    if (items.length === 0) {
      return { kind: "undeclared", message: `승인 계획이 항목 목록(\`\`\`plan-items)을 선언하지 않았습니다. 구현자·리뷰어의 항목별 보고를 확인할 수 없어 진행하지 않았습니다. ${REMEDIATION} 예시:\n${PLAN_ITEMS_EXAMPLE}` };
    }
    return { kind: "declared", items };
  } catch (error) {
    if (error instanceof PlanItemsError) return { kind: "invalid", message: `승인 계획의 plan-items 블록이 형식에 맞지 않아 진행하지 않았습니다 — ${error.message}. ${REMEDIATION}` };
    throw error;
  }
}

// 선언된 항목만 돌려주고, 아니면 그 사유로 던진다 — 승인 경계(approve)처럼 동기 거부가 필요한 호출자용.
export function requireDeclaredPlanItems(planContent: string): PlanItem[] {
  const declaration = declaredPlanItems(planContent);
  if (declaration.kind !== "declared") throw new Error(declaration.message);
  return declaration.items;
}

export function planItemsInputKey(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts), "utf8").digest("hex");
}

// 작업자 세션에 돌려주는 교정 사실 — 기존 계획 필수 검사와 같은 check-result 모양이라 프롬프트 빌더가 그대로 싣는다. 반복 판정 키(planCheckInput)도 같은 자리다.
export function planItemsFact(summary: string, inputKey: string, status: "failed" | "passed" = "failed"): EnvelopeEvent {
  return {
    actor: "system", kind: "system",
    body: `계획 항목 보고 확인: ${PLAN_ITEMS_CHECK_ID} ${status} — ${summary}`,
    payload: { workerFact: { kind: "check-result", checks: [{ id: PLAN_ITEMS_CHECK_ID, status, summary }] }, ...(status === "failed" ? { planCheckInput: inputKey } : {}) },
  };
}

// 반복 판정 키(host-review F002) — 역할 + 실제 검사 입력(승인 계획 판·planEpoch·실제 코드 스냅샷: 구현자는 턴 뒤 작업 트리, 리뷰어는 리뷰 시작 트리) + 선언 id +
// 정규화한 위반 집합(구현자는 not-implemented id 집합까지). 보고 순서·evidence 문구·턴 번호는 들어가지 않는다 — 같은 트리에서 같은 누락·같은 미구현이면 같은 키라
// 되풀이로 보고, 위반 집합이 줄거나({R-2,R-3}→{R-3}→{}) 실제 코드·승인 판이 바뀌면 새 입력이라 교정 턴을 받는다. 범위 세대는 타임라인 필터가 가른다.
export interface CoverageInput {
  planSHA256: string;
  planEpoch: number;
  snapshot: { head: string; diffSHA256: string };
}
export function coverageInputKey(role: "implementer" | "code-reviewer", input: CoverageInput, items: readonly PlanItem[], violations: PlanItemViolations,
  unmet: readonly string[] = []): string {
  return planItemsInputKey(role, input.planSHA256, input.planEpoch, input.snapshot.head, input.snapshot.diffSHA256, items.map((item) => item.id), violations, [...unmet]);
}

// 구현자 done 봉투 — 선언 집합과 정확히 같고 전부 implemented 여야 리뷰로 간다. 그 밖은 교정 사유(같은 세션 continue 턴)다. 반복 키는 호출자가 coverageInputKey 로 만든다.
export function implementerCoverage(items: readonly PlanItem[], reported: PlanItemReport | null | undefined):
  { ok: true } | { ok: false; summary: string; violations: PlanItemViolations; unmet: string[] } {
  const coverage = planItemCoverage(items, reported, "implemented");
  const problems = [...coverage.format, ...(coverage.unmet.length ? [`아직 구현되지 않은 항목(not-implemented): ${coverage.unmet.map((entry) => entry.id).join(", ")}`] : [])];
  if (problems.length === 0) return { ok: true };
  const summary = `${problems.join(" / ")}. 선언한 항목 전부를 planItems 에 id·status·evidence 로 적고(빠짐·추가 없이), 남은 항목은 구현을 마친 뒤 done 으로 답하세요. 범위를 바꿔야 하면 needs-mediator 로 중재자에게 물으세요.`;
  return { ok: false, summary, violations: coverage.violations, unmet: [...new Set(coverage.unmet.map((entry) => entry.id))].sort() };
}

// 코드 리뷰어 approve 봉투 — 집합 불일치·빈 근거는 형식 교정(같은 리뷰 세션 재턴), 충족되지 않은 항목이 있는 approve 는 모순이라 수정 턴(CLAUDE_FIX)으로 보낸다.
export type ReviewerCoverage =
  | { kind: "ok"; items: PlanItemReport }
  | { kind: "format"; summary: string; violations: PlanItemViolations }
  | { kind: "unmet"; summary: string; unmet: PlanItemReport };
export function reviewerCoverage(items: readonly PlanItem[], reported: PlanItemReport | null | undefined): ReviewerCoverage {
  const coverage = planItemCoverage(items, reported, "satisfied");
  if (coverage.format.length) {
    return { kind: "format", summary: `${coverage.format.join(" / ")}. 선언한 항목 전부를 planItems 에 id·status·evidence 로 적어 같은 판정을 다시 답하세요(코드는 바뀌지 않았습니다).`,
      violations: coverage.violations };
  }
  if (coverage.unmet.length) {
    return { kind: "unmet", unmet: coverage.unmet,
      summary: `리뷰어가 approve 로 답했지만 충족되지 않은 항목이 있습니다: ${coverage.unmet.map((entry) => `${entry.id}(${entry.status}: ${entry.evidence})`).join("; ")}. 구현자가 이 항목을 마치고 리뷰를 다시 받습니다.` };
  }
  return { kind: "ok", items: reported ?? [] };
}

// 영수증 — READY 전이 사건(payload.planCoverage)에 남긴다. 승인 판·범위 세대·planEpoch·검토 트리와 판정 출처(리뷰 세션·원장)를 함께 적어 전달 경계가 대조한다.
export interface PlanCoverageReceipt {
  planSHA256: string;
  scopeGeneration: number;
  planEpoch: number;
  reviewedHead: string;
  reviewedDiffSHA256: string;
  reviewedTreeOID: string | null;
  reviewSessionId: string;
  reviewLedgerId: string;
  items: PlanItemReport;
  recordedAt: string;
}

export function coverageReceipt(input: Omit<PlanCoverageReceipt, "recordedAt">): PlanCoverageReceipt {
  return { ...input, recordedAt: new Date().toISOString() };
}

// 현재 범위 세대의 마지막 영수증 — READY 전이 사건에만 실리므로 그 사건을 찾는다.
export function latestCoverageReceipt(timeline: readonly TimelineEvent[]): PlanCoverageReceipt | null {
  const event = timeline.findLast((entry) => entry.payload?.to === "READY_TO_DELIVER" && entry.payload?.planCoverage !== undefined);
  return (event?.payload?.planCoverage as PlanCoverageReceipt | undefined) ?? null;
}

// 전달 경계(commit·push·close)의 대조 — planned 만. 영수증이 없거나 승인 판·세대·epoch·검토 트리 가운데 하나라도 다르면 그 사유(보완 경로 포함)를 돌려준다.
// 계획 개정(approvedPlanSHA256 null)·재리뷰(reviewed* 갱신)·범위 변경은 자동으로 낡음이 된다. 복구(discardOrphanCommit·reconcileDelivery)는 이 대조를 지나지 않는다.
export function deliveryCoverageProblem(topic: Topic, flags: InternalTopicFlags, timeline: readonly TimelineEvent[]): string | null {
  if (topic.workflowMode !== "planned") return null;
  const receipt = latestCoverageReceipt(timeline.filter((event) => event.scopeGeneration === topic.scopeGeneration));
  if (!receipt) {
    return "planned 토픽의 항목 영수증(승인 계획 항목 전부 satisfied 판정)이 없어 전달하지 않았습니다. 계획에 plan-items 목록이 있으면 resume(reentry CODEX_REVIEW)으로 같은 리뷰 세션의 항목별 판정을 받고, "
      + `목록이 없으면 ${REMEDIATION}`;
  }
  const stale: string[] = [];
  if (!topic.approvedPlanSHA256 || receipt.planSHA256 !== topic.approvedPlanSHA256 || topic.approvedPlanSHA256 !== topic.planSHA256) stale.push("승인 계획 판");
  if (receipt.scopeGeneration !== topic.scopeGeneration) stale.push("범위 세대");
  if (receipt.planEpoch !== topic.planEpoch) stale.push("계획 epoch");
  if (receipt.reviewedHead !== flags.reviewedHead || receipt.reviewedDiffSHA256 !== flags.reviewedDiffSHA256 || receipt.reviewedTreeOID !== (flags.reviewedTreeOID ?? null)) stale.push("검토 트리");
  if (stale.length === 0) return null;
  return `항목 영수증이 지금 상태와 다릅니다(${stale.join("·")}). 낡은 판정은 채택하지 않습니다 — resume(reentry CODEX_REVIEW)으로 같은 리뷰 세션이 현재 트리·승인 판을 다시 판정하게 하거나, `
    + `계획이 바뀌었으면 승인·구현·리뷰를 다시 거치세요.`;
}
