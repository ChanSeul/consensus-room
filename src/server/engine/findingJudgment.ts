import type { AgentResult, Finding } from "../../shared/contracts.js";
import {
  classifyCloseout,
  dispositionRegressions,
  isMinorFinding,
  isSettledFinding,
  mergeAgreedSources,
  newFindingIDs,
  shouldRunFixPass,
} from "../../shared/workflow.js";

// 지적 판정 — 파이프라인이 다음 전이를 정할 때와 재개 정보(resume)가 미해결 지적을 보일 때 **같은 함수**를 쓴다(엔진 개편 E1).
// resume 이 판정을 따로 다시 구현하자 개정 2회차의 앞 개정 합의·OVERRULE 의 원본 이후 경계·최종 리뷰 신규 지적의 판정 대기·개정에서 수락된 반박에서
// 엔진과 어긋났다(host-review dd71c649 F-005·F-010·F-011·F-012). 다음 허용 작업이 액션의 사전 검사를 재사용하는 것과 같은 규칙이다.

// 미해결 사유 — 엔진이 그 지적 때문에 멈추거나 다음 단계에서 다루는 이유.
export type OpenFindingReason =
  | "regressed"        // 고치기로 합의한 쟁점을 OVERRULE 없이 내렸다(되돌림 가드로 멈춤)
  | "new-final"        // 최종 리뷰가 처음 낸 쟁점 — 고칠 기회가 없어 사용자 판정을 기다린다
  | "essential"        // 종결 확인의 새 필수 쟁점(BLOCKER·HIGH) — 개정 2회차 또는 사용자 결정
  | "decision"         // 사용자 결정 필요
  | "evidence"         // 처분 없음·외부 증거 필요
  | "unconfirmed-fix"  // 러너의 수정 완료 주장 — 리뷰가 확인한다
  | "agreed-action";   // 합의한 조치 — 수정·개정·종결 확인이 다룬다
export interface OpenFinding { finding: Finding; reason: OpenFindingReason }

function unsettledReason(finding: Finding): OpenFindingReason {
  if (finding.requiresUserDecision) return "decision";
  if (!finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE") return "evidence";
  if (finding.disposition === "RESOLVED_BY_FIX") return "unconfirmed-fix";
  return "agreed-action";
}

// 결과 하나가 남긴 판정 끝나지 않은 처분(계획·감사·개정·구현·수정 결과). runnerReport: 구현·수정 보고의 RESOLVED_BY_FIX 는 리뷰가 확인할 주장이다.
export function unsettledFindings(findings: readonly Finding[], options: { runnerReport?: boolean } = {}): OpenFinding[] {
  return findings.filter((finding) => !isSettledFinding(finding, { forReview: options.runnerReport }))
    .map((finding) => ({ finding, reason: unsettledReason(finding) }));
}

// 종결 확인이 낸 새 쟁점을 Codex 의 처분으로 나눈다: 범위 밖(기록만) vs 필수(개정으로 반영).
// 2026-09-13 사용자 규칙: 경미(MEDIUM 이하) 새 쟁점은 개정을 열지 않고 구현 노트로 러너에게 넘긴다. 필수(essential)는 BLOCKER/HIGH 뿐.
export function classifyCloseoutAdditions(known: readonly Finding[], closeout: AgentResult): { deferred: Finding[]; essential: Finding[]; minor: Finding[] } {
  const added = new Set(newFindingIDs(known, closeout.findings, "Codex closeout"));
  const additions = closeout.findings.filter((finding) => added.has(finding.id));
  const deferred = additions.filter((finding) =>
    finding.disposition === "DEFERRED_OUT_OF_SCOPE" || finding.disposition === "AGREED_NO_ACTION");
  const actionable = additions.filter((finding) => !deferred.includes(finding));
  const minor = actionable.filter((finding) => isMinorFinding(finding) && !finding.requiresUserDecision && finding.disposition !== "EXTERNAL_EVIDENCE");
  const essential = actionable.filter((finding) => !minor.includes(finding));
  return { deferred, essential, minor };
}

// 종결 판정 — known 은 이 바퀴에서 Claude 가 처분한 쟁점 전부(최신 감사 뒤의 개정 전부 — 1회차·2회차·추가 개정, planning.roundKnownFindings).
// regressionAdjudicated: 저장된 종결이 되돌림 가드로 멈춘 뒤 사용자 결정이 올라왔다(planning.closeoutRegressionAdjudicated — 최종 리뷰 adjudicated 와
// 같은 규칙) — 그 되돌림은 판정이 끝났다. 새 종결 턴의 판정에는 쓰지 않는다(재개가 저장된 종결을 다시 판정할 때만).
export interface CloseoutJudgment { deferred: Finding[]; essential: Finding[]; minor: Finding[]; regressed: string[] }
export function judgeCloseout(known: readonly Finding[], closeout: AgentResult, options: { regressionAdjudicated?: boolean } = {}): CloseoutJudgment {
  return { ...classifyCloseoutAdditions(known, closeout),
    regressed: options.regressionAdjudicated ? [] : dispositionRegressions(known, closeout.findings) };
}

// 종결 판정이 남긴 미해결: 되돌림·새 필수 쟁점, 그리고 합의 종결을 막는 결정·증거 필요 쟁점(classifyCloseout). 경미한 새 쟁점은 구현 노트, 범위 밖은 후속 목록으로 간다.
export function closeoutOpenFindings(closeout: AgentResult, judgment: CloseoutJudgment): OpenFinding[] {
  const regressed = new Set(judgment.regressed);
  const essential = new Set(judgment.essential.map((finding) => finding.id));
  const blocking = classifyCloseout(closeout).state !== "CONSENSUS_ACK";
  return closeout.findings.flatMap((finding): OpenFinding[] => {
    if (regressed.has(finding.id)) return [{ finding, reason: "regressed" }];
    if (essential.has(finding.id)) return [{ finding, reason: "essential" }];
    if (blocking && finding.requiresUserDecision) return [{ finding, reason: "decision" }];
    if (blocking && (!finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE")) return [{ finding, reason: "evidence" }];
    return [];
  });
}

// 코드 리뷰 판정의 입력 — delivery.runReview 가 모으는 그대로(대조 보고·첫 리뷰·수정 작업 계약의 원본과 면제, 판정 끝난 최종 리뷰 신규 id, 원본 이후 OVERRULE).
export interface ReviewJudgmentInput {
  review: AgentResult;
  finalPass: boolean;
  implementation: AgentResult;
  originalReview: AgentResult | null;
  base: { sources: readonly Finding[]; overruled: ReadonlySet<string> } | null;
  adjudicated: ReadonlySet<string>;
  userOverruled: ReadonlySet<string>;
}
export interface ReviewJudgment {
  added: Finding[];       // 최종 리뷰가 처음 낸 쟁점(판정 끝난 id 제외)
  deferredNew: Finding[]; // 그중 범위 밖·조치 없음 — 후속 목록
  askUser: Finding[];     // 그중 사용자 판정이 필요한 것(RESOLVED_BY_FIX 포함 — 고칠 기회가 없었다)
  overruled: Set<string>;
  agreed: Finding[];      // 되돌림 검사의 합의 원본
  withdrawn: string[];    // 합의를 OVERRULE 없이 내린 쟁점
  remaining: string[];    // 수정 회차가 고칠 확정 결함(수정 회차를 열 때만)
}
export function judgeReview(input: ReviewJudgmentInput): ReviewJudgment {
  const { review } = input;
  const remaining = shouldRunFixPass(review.findings)
    ? review.findings.filter((finding) => finding.disposition === "AGREED_ACTION").map((finding) => finding.id) : [];
  if (!input.finalPass) return { added: [], deferredNew: [], askUser: [], overruled: new Set(), agreed: [], withdrawn: [], remaining };
  // 최종 리뷰에서 처음 등장한 쟁점은 Claude가 고칠 기회가 없었다. RESOLVED_BY_FIX로 표시해도
  // 실제 수정이 없었으므로, closeout의 신규 쟁점 규칙과 똑같이 처분과 무관하게 사용자 판단으로 보낸다.
  // 이월 쟁점은 fix와 첫 리뷰 양쪽에 같은 ID로 있으므로 합집합을 ID로 접어야 newFindingIDs의 중복 검사에 걸리지 않는다.
  const knownFindings = [...new Map(
    [...input.implementation.findings, ...(input.originalReview?.findings ?? []), ...(input.base?.sources ?? [])].map((finding) => [finding.id, finding]),
  ).values()];
  // 사용자 결정이 이미 소비한 신규 쟁점(adjudicated)은 다시 사용자에게 보내지 않는다.
  const addedIDs = new Set(newFindingIDs(knownFindings, review.findings, "Codex final review").filter((id) => !input.adjudicated.has(id)));
  const added = review.findings.filter((finding) => addedIDs.has(finding.id));
  // 새 쟁점은 발견 시점이 아니라 처분으로 분류한다(2026-09-07 Codex 피드백 ④): 범위 밖은 후속 목록에 기록만,
  // 확정 결함(AGREED_ACTION)은 남은 수정 회차에서 바로 수정, 결정이 필요하거나 처분이 없거나 수정 없이 닫힌
  // (RESOLVED_BY_FIX — 고칠 기회가 없었다) 쟁점만 사용자에게 보낸다.
  const deferredNew = added.filter((finding) =>
    finding.disposition === "DEFERRED_OUT_OF_SCOPE" || finding.disposition === "AGREED_NO_ACTION");
  const askUser = added.filter((finding) =>
    finding.requiresUserDecision || !finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE"
    || finding.disposition === "RESOLVED_BY_FIX");
  // 수정을 마친 쟁점의 정상 종결은 RESOLVED_BY_FIX다. 다른 처분으로 내리면 아무도 고치지 않은 요구를 닫는 것이므로 멈춘다.
  // 되돌림 검사의 원본 = 첫 리뷰 쟁점 ∪ 수정 작업 계약의 원본(최종 리뷰 정지 쟁점 등). 면제 = 사용자 결정 ∪ 계약의 판정 id ∪ 닫힌 진단.
  const overruled = new Set(input.userOverruled);
  for (const id of input.base?.overruled ?? []) overruled.add(id);
  // 진단 전용 계약의 원본(정지 쟁점)이 같은 id 의 첫 리뷰·보고 처분보다 최신 판정이다 — 앞에 둔다(감사 3차: 옛 settled 처분에 가려졌다).
  const agreed = mergeAgreedSources(input.base?.sources, input.originalReview?.findings);
  const withdrawn = [...new Set(dispositionRegressions(agreed, review.findings, overruled))];
  return { added, deferredNew, askUser, overruled, agreed, withdrawn, remaining };
}

// 리뷰 판정이 남긴 미해결 — runReview 가 멈추거나 수정 회차로 보내는 쟁점: 되돌림·최종 리뷰 신규 판정 대기·결정·증거 필요·수정할 확정 결함.
export function reviewOpenFindings(review: AgentResult, judgment: ReviewJudgment): OpenFinding[] {
  const withdrawn = new Set(judgment.withdrawn);
  const askUser = new Set(judgment.askUser.map((finding) => finding.id));
  const remaining = new Set(judgment.remaining);
  return review.findings.flatMap((finding): OpenFinding[] => {
    if (withdrawn.has(finding.id)) return [{ finding, reason: "regressed" }];
    if (askUser.has(finding.id)) return [{ finding, reason: "new-final" }];
    if (finding.requiresUserDecision) return [{ finding, reason: "decision" }];
    if (!finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE") return [{ finding, reason: "evidence" }];
    if (remaining.has(finding.id)) return [{ finding, reason: "agreed-action" }];
    return [];
  });
}

// 수정 수락 판정 — 수정 결과가 계약 원본의 합의(AGREED_ACTION)를 OVERRULE 없이 내렸으면 최종 리뷰로 넘기지 않는다(delivery.contractAcceptance).
// source·overruled 는 수정 작업 계약의 원본과 면제(fixContracts.source·overruled — 계약 시점 이후 사용자 결정의 OVERRULE ∪ 닫힌 진단).
// uncovered 는 결과가 아직 다루지 않은 원본 쟁점이다 — 수정 결과의 계약 검사(assertFindingCoverage)가 막는 누락이라, 검사 전 체크포인트(턴 응답·계약 교정 전)
// 에서 멈추면 이 쟁점들이 아직 미해결이다(host-review 125855a2 F-013). 수락 전이는 계약 검사를 통과한 결과만 받으므로 거기서는 비어 있다.
export interface FixAcceptanceJudgment { downgraded: string[]; uncovered: Finding[] }
export function judgeFixAcceptance(source: readonly Finding[], fixFindings: readonly Finding[], overruled: ReadonlySet<string>): FixAcceptanceJudgment {
  const answered = new Set(fixFindings.map((finding) => finding.id));
  return { downgraded: dispositionRegressions(source, fixFindings, overruled), uncovered: source.filter((finding) => !answered.has(finding.id)) };
}

// 수정 결과가 남긴 미해결 — 되돌림(수락 가드로 멈춤), 아직 다루지 않은 원본 쟁점, 러너 보고의 판정 끝나지 않은 처분(수정 완료 주장 포함).
export function fixOpenFindings(fixFindings: readonly Finding[], judgment: FixAcceptanceJudgment): OpenFinding[] {
  const downgraded = new Set(judgment.downgraded);
  return [
    ...fixFindings.filter((finding) => downgraded.has(finding.id)).map((finding): OpenFinding => ({ finding, reason: "regressed" })),
    ...unsettledFindings(judgment.uncovered),
    ...unsettledFindings(fixFindings.filter((finding) => !downgraded.has(finding.id)), { runnerReport: true }),
  ];
}

// 정정·해결로 닫힌 진단의 쟁점 중 판단이 끝나지 않은 처분(증거·결정 요청, 미반영)을 판단이 끝난 처분으로 바꾼다 — 닫힌 진단은 중재자가 처리했으므로
// 완료 판정·계속 진행이 그 처분을 기다리지 않는다. 쟁점 자체(보고 기록)는 지우지 않는다. 인도 작업 재개(delivery.runWork)와 재개 정보가 같은 정리를 한 뒤
// 판정한다(host-review 125855a2 F-014: 정정으로 끝난 증거 요청을 재개 정보가 다시 미해결로 보였다).
export function settleClosedDiagnoses(result: AgentResult, closed: ReadonlySet<string>): AgentResult {
  if (closed.size === 0) return result;
  let changed = false;
  const findings = result.findings.map((finding) => {
    if (!closed.has(finding.id)) return finding;
    const open = finding.disposition === undefined || finding.disposition === "AGREED_ACTION" || finding.disposition === "EXTERNAL_EVIDENCE" || finding.requiresUserDecision;
    if (!open) return finding;
    changed = true;
    return { ...finding, disposition: "AGREED_NO_ACTION" as const, requiresUserDecision: false, rationale: `정정·해결로 닫힌 중재자 진단(서버 정리): ${finding.rationale}` };
  });
  return changed ? { ...result, findings } : result;
}

