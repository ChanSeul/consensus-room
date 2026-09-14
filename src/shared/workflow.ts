import { createHash } from "node:crypto";

import type { AgentResult, Finding, Participant, PlanEdit, WorkflowState } from "./contracts";
import { FIX_AWARE_KINDS, FindingSchema, validatePlanHeadings } from "./contracts";
import { parseTolerancePolicy } from "./tolerance";

export const ACTIVE_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  "CLAUDE_PLAN",
  "CODEX_AUDIT",
  "CLAUDE_REVISION",
  "CODEX_CLOSEOUT",
  "IMPLEMENTING",
  "CODEX_REVIEW",
  "CLAUDE_FIX",
  "CODEX_FINAL_REVIEW",
]);

export const INTERRUPTED_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  "BLOCKED_ON_EVIDENCE",
  "USER_DECISION_REQUIRED",
  "FAILED",
]);

const NEXT_STATES: Readonly<Record<WorkflowState, ReadonlySet<WorkflowState>>> = {
  DRAFT: new Set(["CLAUDE_PLAN", "FAILED"]),
  CLAUDE_PLAN: new Set(["CODEX_AUDIT", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  // CODEX_CLOSEOUT 직행: 감사 지적이 전부 경미(MEDIUM 이하)면 개정 턴을 생략하고 구현 노트로 넘긴다(2026-09-13 사용자 규칙).
  CODEX_AUDIT: new Set(["CLAUDE_REVISION", "CODEX_CLOSEOUT", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  CLAUDE_REVISION: new Set(["CODEX_CLOSEOUT", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  // CLAUDE_REVISION 포함: 종결 확인의 새 쟁점은 처음부터 다시 도는 대신 개정 2회차(바퀴당 1회)로 반영한다(2026-09-07).
  CODEX_CLOSEOUT: new Set(["CONSENSUS_ACK", "CLAUDE_REVISION", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  CONSENSUS_ACK: new Set(["AWAITING_USER_APPROVAL", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  AWAITING_USER_APPROVAL: new Set(["IMPLEMENTING", "DRAFT", "FAILED"]),
  IMPLEMENTING: new Set(["CODEX_REVIEW", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  CODEX_REVIEW: new Set(["CLAUDE_FIX", "READY_TO_DELIVER", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  CLAUDE_FIX: new Set(["CODEX_FINAL_REVIEW", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
  CODEX_FINAL_REVIEW: new Set(["READY_TO_DELIVER", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED", "CLAUDE_FIX"]),
  READY_TO_DELIVER: new Set(["CLOSED", "DRAFT", "FAILED"]),
  CLOSED: new Set(),
  BLOCKED_ON_EVIDENCE: new Set([
    "DRAFT", "CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT",
    "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW", "FAILED",
  ]),
  USER_DECISION_REQUIRED: new Set([
    "DRAFT",
    "CLAUDE_PLAN",
    "CLAUDE_REVISION",
    // 종결 확인이 "처분 되돌림" 가드로 멈춘 뒤 결정이 오면 저장된 종결로 곧장 ACK 한다(retry 사다리가 adjudicated 를
    // 확인한 뒤에만 고른다). CODEX_CLOSEOUT 은 여전히 막는다 — 결정을 소비해 처분을 재기재하는 단계는 개정이다.
    "CONSENSUS_ACK",
    "IMPLEMENTING",
    "CODEX_REVIEW",
    "CLAUDE_FIX",
    "CODEX_FINAL_REVIEW",
    "READY_TO_DELIVER",
    "FAILED",
  ]),
  // CONSENSUS_ACK 포함: ACK 턴이 인프라 오류(사용량 한도 등)로 죽으면 그 지점부터 재개해야 한다.
  // 빠져 있으면 retry가 합의 완료 직전 상태를 버리고 전체 재계획으로 떨어진다(2026-08-30 실측).
  FAILED: new Set(["DRAFT", "CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK", "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW"]),
};

// 구현 브랜치 이름 규칙. 지정 이름이 있으면 그것을, 없으면 접두사와 slug와 topic id를 base로 쓴다.
// 어느 쪽이든 범위 세대 접미사는 항상 붙는다 — scope_change로 세대가 올라가면 새 worktree에서 새
// 브랜치를 따야 하는데, 세대가 이름에 없으면 이전 세대 브랜치를 그대로 이어 쓰게 되기 때문이다.
export function resolveBranchName(topic: {
  requestedBranchName: string | null;
  branchPrefix: string;
  slug: string;
  id: string;
  scopeGeneration: number;
}): string {
  const base = topic.requestedBranchName
    ?? `${topic.branchPrefix}/${topic.slug}-${topic.id.slice(0, 8)}`;
  return `${base}-g${topic.scopeGeneration}`;
}

export function canTransition(from: WorkflowState, to: WorkflowState): boolean {
  return NEXT_STATES[from].has(to);
}

export function assertTransition(from: WorkflowState, to: WorkflowState): void {
  if (!canTransition(from, to)) {
    throw new Error(`허용되지 않은 상태 전이입니다: ${from} → ${to}`);
  }
}

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

// 개정 패치 적용. 각 find는 그 시점의 본문에서 정확히 1회 일치해야 한다 — 0회는 베이스 불일치(모델이
// 프롬프트의 '기존 계획'이 아닌 기억으로 썼다), 복수는 앵커 부족이다. 둘 다 어느 편집인지 명시하고 거부해
// 다음 시도가 교정하게 한다. replace의 $ 패턴 해석을 피하려고 String.replace 대신 split/join을 쓴다.
export function applyPlanEdits(base: string, edits: readonly PlanEdit[]): string {
  let text = base;
  edits.forEach((edit, index) => {
    const matches = text.split(edit.find).length - 1;
    if (matches !== 1) {
      const preview = edit.find.length > 120 ? `${edit.find.slice(0, 120)}…` : edit.find;
      throw new Error(
        `planEdits[${index}]의 find가 계획 본문에서 ${matches}회 일치합니다(정확히 1회여야 합니다). ` +
        `find 앞부분: ${JSON.stringify(preview)}`,
      );
    }
    text = text.split(edit.find).join(edit.replace);
  });
  return text;
}

export function normalizePlan(markdown: string): string {
  return `${markdown.replace(/\r\n/g, "\n").trim()}\n`;
}

export function hashPlan(markdown: string): string {
  return sha256(normalizePlan(markdown));
}

export function assertPlanContract(markdown: string): void {
  const missing = validatePlanHeadings(markdown);
  if (missing.length > 0) {
    throw new Error(`계획에 필수 절이 없습니다: ${missing.join(", ")}`);
  }
  // 허용 오차 블록은 필수다 — 제목만 있고 블록이 없으면 구현 단계의 범위 밖 대조가 통째로 생략된다(2026-09-08 Codex 지적 6).
  // 형식 오류도 여기서 거른다(구현 단계에서 처음 파싱해 실패하면 턴 하나를 잃는다).
  if (parseTolerancePolicy(markdown) === null) {
    throw new Error('계획의 `## 허용 오차` 절에 ```tolerance JSON 블록이 없습니다 — 규칙이 없으면 {"scopePaths":[…],"rules":[]} 로 명시하세요.');
  }
}

export function bothAgentsAcknowledged(
  participants: readonly Participant[],
  planSHA256: string,
): boolean {
  const byRole = new Map(participants.map((participant) => [participant.role, participant]));
  return (
    byRole.get("claude")?.acknowledgedPlanSHA256 === planSHA256 &&
    byRole.get("codex")?.acknowledgedPlanSHA256 === planSHA256
  );
}

export function assertImplementationGate(input: {
  state: WorkflowState;
  participants: readonly Participant[];
  planSHA256: string | null;
  approvedPlanSHA256: string | null;
}): void {
  if (input.state !== "AWAITING_USER_APPROVAL") {
    throw new Error("구현 승인을 기다리는 상태가 아닙니다.");
  }
  if (!input.planSHA256) {
    throw new Error("확정된 계획 해시가 없습니다.");
  }
  if (!bothAgentsAcknowledged(input.participants, input.planSHA256)) {
    throw new Error("Claude와 Codex가 같은 계획 버전을 확인하지 않았습니다.");
  }
  if (input.approvedPlanSHA256 !== input.planSHA256) {
    throw new Error("사용자가 현재 계획 버전을 승인하지 않았습니다.");
  }
}

export function classifyCloseout(result: AgentResult):
  | { state: "CONSENSUS_ACK"; findings: Finding[] }
  | { state: "BLOCKED_ON_EVIDENCE"; findings: Finding[] }
  | { state: "USER_DECISION_REQUIRED"; findings: Finding[] } {
  const unresolvedDecision = result.requestedUserDecision || result.findings.some((finding) => finding.requiresUserDecision);
  if (unresolvedDecision) {
    return { state: "USER_DECISION_REQUIRED", findings: result.findings };
  }

  const missingEvidence = result.findings.some(
    (finding) => !finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE",
  );
  if (missingEvidence) {
    return { state: "BLOCKED_ON_EVIDENCE", findings: result.findings };
  }

  return { state: "CONSENSUS_ACK", findings: result.findings };
}

// 판단이 끝난 쟁점 — 처분이 있고 행동(AGREED_ACTION·EXTERNAL_EVIDENCE·사용자 결정)이 필요 없는 것. 뒤 단계가 다시 적어도
// 정보가 늘지 않으므로 서버가 승계한다(2026-09-13 S10 #120: 러너가 이런 쟁점 13건을 빠뜨려 재제출 1회 $0.41·121초).
// forReview: 리뷰 단계는 RESOLVED_BY_FIX **주장**을 검증해야 하므로 그것은 승계하지 않는다.
export function isSettledFinding(finding: Finding, options: { forReview?: boolean } = {}): boolean {
  if (!finding.disposition || finding.requiresUserDecision) return false;
  if (finding.disposition === "AGREED_ACTION" || finding.disposition === "EXTERNAL_EVIDENCE") return false;
  if (options.forReview && finding.disposition === "RESOLVED_BY_FIX") return false;
  return true;
}

// 여러 앞 단계 결과를 id 별로 합친다 — 앞에 준 것이 최신이라 우선한다. 승계 판단은 반드시 합친 뒤에 한다: 원본마다 따로 승계하면
// 첫 리뷰의 AGREED_NO_ACTION 이 수정 결과의 AGREED_ACTION·RESOLVED_BY_FIX 를 덮어 최신 판단이 사라진다(2026-09-13 Codex 지적 1).
export function mergeFindingSources(...sources: ReadonlyArray<readonly Finding[] | undefined>): Finding[] {
  const seen = new Set<string>();
  const merged: Finding[] = [];
  for (const source of sources) {
    for (const finding of source ?? []) {
      if (seen.has(finding.id)) continue;
      seen.add(finding.id);
      merged.push(finding);
    }
  }
  return merged;
}

// 계획 개정을 여는 심각도. 그 아래(MEDIUM·LOW·INFO)는 "경미" — 개정 턴 대신 구현 노트로 러너에게 전달한다
// (2026-09-13 사용자 규칙: S10H·S11 계획 단계가 경미 지적의 개정 반복으로 토픽당 $50~60 을 썼다).
export const REVISION_SEVERITIES: ReadonlySet<Finding["severity"]> = new Set(["BLOCKER", "HIGH"]);
export function isMinorFinding(finding: Finding): boolean {
  return !REVISION_SEVERITIES.has(finding.severity);
}

export const CARRIED_RATIONALE_PREFIX = "리뷰 처분 승계(엔진 자동): ";

// source 의 settled 쟁점 중 response 에 없는 id 를 같은 처분으로 덧붙인다. response 가 이미 적은 쟁점은 response 가 우선
// (처분을 바꾸려는 뜻). 반환 carried 는 승계한 id 목록 — 호출자가 이벤트로 남겨 절감을 잰다.
export function carryForwardFindings(
  source: readonly Finding[],
  response: readonly Finding[],
  options: { forReview?: boolean } = {},
): { findings: Finding[]; carried: string[] } {
  const present = new Set(response.map((finding) => finding.id));
  const carried: Finding[] = [];
  for (const finding of source) {
    if (present.has(finding.id) || !isSettledFinding(finding, options)) continue;
    present.add(finding.id);
    carried.push({
      ...finding,
      requiresUserDecision: false,
      rationale: finding.rationale.startsWith(CARRIED_RATIONALE_PREFIX) ? finding.rationale : `${CARRIED_RATIONALE_PREFIX}${finding.rationale}`,
    });
  }
  return { findings: carried.length ? [...response, ...carried] : [...response], carried: carried.map((finding) => finding.id) };
}

export const CORRECTION_SUMMARY_SEPARATOR = "\n\n---\n교정 전 턴 보고(서버 보존):\n";

// 허용 오차 교정 재제출은 그 턴의 최종 결과가 된다 — 러너가 교정만 적고 본 턴 보고(summary·findings·evidence·요청 결정)를
// 비우면 턴의 성과가 기록에서 사라진다(2026-09-14 S11: $6.35 짜리 턴이 "코드 변경 없음 — 원장 공란" 한 줄로 남았고,
// 남은 단계를 적은 결정 요청도 사라져 엔진이 구현 완료로 보고 리뷰로 넘겼다). 교정 결과를 본 턴 결과 위에 병합한다:
// 같은 id 의 쟁점은 교정이 우선, 나머지는 보존; evidence 는 합집합; 요청 결정은 교정이 비우면 본 턴 것; summary 는 교정이
// 본 턴 요약을 담지 않았으면 뒤에 붙인다. toleranceLedger 는 교정 것만 쓴다(원장이 교정의 목적이다).
export function mergeCorrectionResult(original: AgentResult, corrected: AgentResult): { result: AgentResult; preserved: string[] } {
  const preserved: string[] = [];
  const ids = new Set(corrected.findings.map((finding) => finding.id));
  const keptFindings = original.findings.filter((finding) => !ids.has(finding.id));
  if (keptFindings.length) preserved.push(`findings ${keptFindings.length}건`);
  const evidence = [...corrected.evidenceRefs];
  const keptEvidence = original.evidenceRefs.filter((ref) => !evidence.includes(ref));
  if (keptEvidence.length) preserved.push(`evidence ${keptEvidence.length}건`);
  const originalDecision = original.requestedUserDecision?.trim() ? original.requestedUserDecision : undefined;
  // 교정이 요청 결정을 해소했다고 명시하면(resolvesRequestedDecision, 예: 범위 밖 변경을 전부 되돌려 질문이 사라짐) 복원하지 않는다(R07).
  const resolved = corrected.resolvesRequestedDecision === true;
  const decision = corrected.requestedUserDecision?.trim() ? corrected.requestedUserDecision : (resolved ? undefined : originalDecision);
  if (!corrected.requestedUserDecision?.trim() && originalDecision && !resolved) preserved.push("요청 결정");
  const originalSummary = original.summary.trim();
  let summary = corrected.summary;
  if (originalSummary && !corrected.summary.includes(originalSummary)) {
    summary = `${corrected.summary.trimEnd()}${CORRECTION_SUMMARY_SEPARATOR}${originalSummary}`;
    preserved.push("summary");
  }
  const { requestedUserDecision: _dropped, resolvesRequestedDecision: _flag, ...rest } = corrected;
  const result: AgentResult = {
    ...rest, summary, findings: [...corrected.findings, ...keptFindings], evidenceRefs: [...evidence, ...keptEvidence],
    ...(decision !== undefined ? { requestedUserDecision: decision } : {}),
    ...(corrected.status ?? original.status ? { status: corrected.status ?? original.status } : {}),
    ...(corrected.remainingSteps ?? original.remainingSteps ? { remainingSteps: corrected.remainingSteps ?? original.remainingSteps } : {}),
  };
  return { result, preserved };
}

// 구현·수정 결과가 "아직 진행 중" 인가 — status 가 in_progress 이거나, completed 가 아닌데 남은 단계가 적혀 있으면(D01).
export function implementationInProgress(result: AgentResult): boolean {
  if (result.status === "in_progress") return true;
  if (result.status === "completed" || result.status === "blocked") return false; // blocked 는 정지(pauseForResult) 몫
  return (result.remainingSteps?.length ?? 0) > 0;
}

// 계약을 어긴 원본 응답에서 **개별로 유효한** 필드만 건진다 — 교정 재제출 위에 병합할 본 턴 보고(요약·쟁점·증거·요청 결정·상태).
// 검증에 실패한 필드를 무조건 재주입하면 교정이 같은 위반으로 다시 죽는다(2026-09-14 Codex 감사 R01 ②).
export function salvageResultFields(raw: unknown, kind: AgentResult["kind"]): AgentResult {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const findings: Finding[] = [];
  if (Array.isArray(record.findings)) {
    for (const candidate of record.findings) {
      const parsed = FindingSchema.safeParse(candidate);
      if (parsed.success) findings.push(parsed.data);
    }
  }
  const evidenceRefs = Array.isArray(record.evidenceRefs) ? record.evidenceRefs.filter((ref): ref is string => typeof ref === "string") : [];
  const summary = typeof record.summary === "string" && record.summary.trim() ? record.summary : "";
  const decision = typeof record.requestedUserDecision === "string" && record.requestedUserDecision.trim() ? record.requestedUserDecision : undefined;
  const status = record.status === "completed" || record.status === "in_progress" || record.status === "blocked" ? record.status : undefined;
  const remainingSteps = Array.isArray(record.remainingSteps)
    ? record.remainingSteps.filter((step): step is string => typeof step === "string").slice(0, 50) : undefined;
  return {
    kind, summary: summary || "(교정 전 원본에 유효한 요약이 없음)", findings, evidenceRefs,
    ...(decision ? { requestedUserDecision: decision } : {}), ...(status ? { status } : {}),
    ...(remainingSteps && remainingSteps.length ? { remainingSteps } : {}),
  };
}

export function assertFindingCoverage(
  source: readonly Finding[],
  response: readonly Finding[],
  responseLabel: string,
): void {
  const sourceIDs = uniqueFindingIDs(source, "검토 원문");
  const responseIDs = uniqueFindingIDs(response, responseLabel);
  const missing = [...sourceIDs].filter((id) => !responseIDs.has(id));
  if (missing.length > 0) {
    throw new Error(`${responseLabel}에서 검토 쟁점을 누락했습니다: ${missing.join(", ")}`);
  }
}

export function newFindingIDs(
  source: readonly Finding[],
  response: readonly Finding[],
  responseLabel: string,
): string[] {
  const sourceIDs = uniqueFindingIDs(source, "검토 원문");
  const responseIDs = uniqueFindingIDs(response, responseLabel);
  return [...responseIDs].filter((id) => !sourceIDs.has(id));
}

// 앞 단계가 고치기로 합의한 심각도. 수정 단계 판정과 처분 강등 감시가 같은 집합을 봐야 한다.
const ACTIONABLE_SEVERITIES = ["BLOCKER", "HIGH", "MEDIUM", "LOW"];
const DOWNGRADED_DISPOSITIONS = ["AGREED_NO_ACTION", "REFUTED", "DEFERRED_OUT_OF_SCOPE"];

// 수정이 실제로 일어난 단계에서만 "수정으로 종결" 처분을 쓸 수 있다. 앞 단계가 이 값으로 확정 조치를 닫으면 M2가 막으려던 구멍이 다시 열린다.
// IMPLEMENTATION도 수정이 실제로 일어나는 단계다 — 구현 중 발견해 즉시 고친 쟁점의 정직한 처분이 이 값이고,
// 그 주장은 바로 다음 CODEX_REVIEW가 독립 검증한다. 허용 집합의 정본은 contracts.FIX_AWARE_KINDS다.
export function assertFixDispositionAllowed(result: AgentResult, label: string): void {
  if (FIX_AWARE_KINDS.has(result.kind)) return;
  const claimed = result.findings
    .filter((finding) => finding.disposition === "RESOLVED_BY_FIX")
    .map((finding) => finding.id);
  if (claimed.length > 0) {
    throw new Error(`${label} 단계에서는 RESOLVED_BY_FIX 처분을 쓸 수 없습니다: ${claimed.join(", ")}`);
  }
}

// 처분을 요구하는 대상은 앞 단계가 넘긴 쟁점뿐이다. 이 단계에서 새로 발견한 쟁점은 아직 처분 전일 수 있고,
// 그것까지 요구하면 수정 중 발견을 보고하는 정상 응답이 프로토콜 위반으로 실패한다.
export function assertDispositionsResolved(
  source: readonly Finding[],
  result: AgentResult,
  label: string,
): void {
  const carried = new Set(source.map((finding) => finding.id));
  const unresolved = result.findings
    .filter((finding) => carried.has(finding.id) && !finding.disposition)
    .map((finding) => finding.id);
  if (unresolved.length > 0) {
    throw new Error(`${label}에서 앞 단계 쟁점을 처분하지 않았습니다: ${unresolved.join(", ")}`);
  }
}

// 확정된 조치를 뒤 단계가 조용히 닫는 두 가지 길을 함께 막는다. 처분을 내리는 길과,
// 처분은 그대로 두고 심각도만 조치 대상 밖으로 낮추는 길이다. 뒤쪽을 빼면 shouldRunFixPass가 응답 심각도를
// 보기 때문에 HIGH를 INFO로 바꾸는 것만으로 전달 준비까지 통과한다.
// overruled: 사용자 결정이 명시적으로 뒤집은 쟁점 id. 그 쟁점의 하향 처분은 되돌림이 아니라 결정의 이행이다
// (2026-09-07: S6H #96·S8 #90/#103·S7 #161/#176 네 번의 sqlite 우회를 대체 — 판정은 delivery.ts userOverruledFindings).
export function dispositionRegressions(
  source: readonly Finding[],
  response: readonly Finding[],
  overruled: ReadonlySet<string> = new Set(),
): string[] {
  const responded = new Map(response.map((finding) => [finding.id, finding]));
  return source
    .filter((finding) => !overruled.has(finding.id))
    .filter((finding) =>
      finding.disposition === "AGREED_ACTION" && ACTIONABLE_SEVERITIES.includes(finding.severity))
    .filter((finding) => {
      const answer = responded.get(finding.id);
      if (!answer) return false;
      if (answer.disposition !== undefined && DOWNGRADED_DISPOSITIONS.includes(answer.disposition)) return true;
      return !ACTIONABLE_SEVERITIES.includes(answer.severity);
    })
    .map((finding) => finding.id);
}

// 중재자 소유 경로 — 러너(구현·수정 턴)가 고치지 않는다(2026-09-14 사용자 지시: "러너는 앱 코드만 고치게 경계를 둬").
// 근거: S10H 인도 리뷰가 수정 4회를 돌았는데 전부 gitignore 된 단계 도구 트리(DerivedData/*-logs/scripts)의 결함이었고,
// Swift 변경은 1회차에 검증이 끝났다. 도구는 중재자가 실물 트리에서 직접 고치고 자기검사를 돌리는 편이 싸고 정확하다.
// 판정: 증거 경로(`경로[:줄]` 모양, .md 문서 인용은 제외) 가 1개 이상 있고 **전부** 중재자 소유 패턴이면 그 지적은 중재자 몫이다.
// 경로가 하나도 없거나 앱 소스가 섞여 있으면 종전대로 러너가 고친다.
// 도구 트리·중재 저장소 자체(`swift6-tools`, `consensus-room`, `mediator-<stage>/`)도 중재자 소유다(2026-09-14 Codex Medium 5).
export const MEDIATOR_OWNED_PATH_PATTERNS: readonly RegExp[] = [
  /(^|\/)DerivedData\//, /(^|\/)\.build\//, /(^|\/)swift6-tools\//, /(^|\/)consensus-room(-public)?\//, /(^|\/)mediator-[a-z0-9]+\//,
];
// 경로 인용: 디렉터리 이름에는 공백을 허용한다(실제 워크트리가 `Library/Application Support/...` 아래에 있다 — 공백을 막으면
// 절대경로 증거가 전부 버려져 기본값(러너 수정)으로 흘렀다). 마지막 항목(파일명)엔 공백이 없어야 문장과 구분된다.
// 위치 접미는 한 파서다: `:줄`, `:줄:열`, `:줄-줄`, `:줄:열-열`, `:줄:열-줄:열`. 경로 인식(PATH_REF)과 정규화(normalizeEvidencePath)가 같은
// 정의를 쓰므로 한쪽만 아는 모양이 없다(2026-09-14 Codex 후속 Medium 1: `gate4.py:1-3` 같은 줄 범위를 PATH_REF 가 버려
// 도구 결함이 러너 수정 호출로 흘렀다 — 운영 DB 의 Codex 증거에도 `p0c_all.sh:165-170` 같은 범위가 흔하다).
const LOCATION_SUFFIX_SOURCE = String.raw`:\d+(?::\d+)?(?:-\d+(?::\d+)?)?`;
const LOCATION_SUFFIX = new RegExp(`${LOCATION_SUFFIX_SOURCE}$`);
const PATH_REF = new RegExp(`^\\/?(?:[A-Za-z0-9_.@+~ -]+\\/)*[A-Za-z0-9_.@+~-]+(?:${LOCATION_SUFFIX_SOURCE})?$`);

// 절대경로는 worktree 기준 상대경로로 정규화한다(worktreePath 가 주어졌을 때). 밖의 절대경로는 그대로 패턴에 댄다.
export function normalizeEvidencePath(ref: string, worktreePath?: string | null): string {
  const bare = ref.replace(LOCATION_SUFFIX, "");
  if (worktreePath) {
    const root = worktreePath.replace(/\/+$/, "");
    if (bare === root) return ".";
    if (bare.startsWith(root + "/")) return bare.slice(root.length + 1);
  }
  return bare;
}

export function isMediatorOwnedFinding(
  finding: Finding, patterns: readonly RegExp[] = MEDIATOR_OWNED_PATH_PATTERNS, worktreePath?: string | null,
): boolean {
  const paths = finding.evidenceRefs
    .map((ref) => ref.trim())
    .filter((ref) => ref.includes("/") && PATH_REF.test(ref))
    .map((ref) => normalizeEvidencePath(ref, worktreePath))
    .filter((path) => !/\.md$/i.test(path));
  if (paths.length === 0) return false;
  return paths.every((path) => patterns.some((pattern) => pattern.test(path)));
}

export const MEDIATOR_OWNED_PREFIX = "중재자 소유 경로(앱 밖 도구 코드) — 러너 수정 대신 중재자가 고친다: ";

// AGREED_ACTION 인 중재자 소유 지적을 EXTERNAL_EVIDENCE 로 바꾼다 → 방은 BLOCKED_ON_EVIDENCE 로 멈추고, 중재자가 고친 뒤
// evidence 메시지 + retry 로 같은 리뷰 단계가 다시 돌아 재검증한다. 반환 routed 는 바뀐 id 목록(이벤트·계측용).
export function routeMediatorOwnedFindings(
  findings: readonly Finding[],
  patterns: readonly RegExp[] = MEDIATOR_OWNED_PATH_PATTERNS,
  worktreePath?: string | null,
): { findings: Finding[]; routed: string[] } {
  const routed: string[] = [];
  const next = findings.map((finding) => {
    if (finding.disposition !== "AGREED_ACTION" || !isMediatorOwnedFinding(finding, patterns, worktreePath)) return finding;
    routed.push(finding.id);
    return {
      ...finding,
      disposition: "EXTERNAL_EVIDENCE" as const,
      requiresUserDecision: false,
      rationale: finding.rationale.startsWith(MEDIATOR_OWNED_PREFIX) ? finding.rationale : `${MEDIATOR_OWNED_PREFIX}${finding.rationale}`,
    };
  });
  return { findings: next, routed };
}

export function shouldRunFixPass(findings: readonly Finding[]): boolean {
  return findings.some(
    (finding) =>
      finding.disposition === "AGREED_ACTION" &&
      ACTIONABLE_SEVERITIES.includes(finding.severity),
  );
}

export function redactSecrets(value: string): string {
  const patterns: RegExp[] = [
    /\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*[^\r\n]+/gi,
    /\b(sk-(?:proj-)?[A-Za-z0-9_-]{12,})\b/g,
    /\b(gh[opsu]_[A-Za-z0-9]{20,})\b/g,
    /\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
    /\b(AKIA[A-Z0-9]{16})\b/g,
    /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
    /\b(password|passwd|token|secret|api[_-]?key)\s*[:=]\s*([^\s,;]+)/gi,
    // OPENAI_API_KEY=..., SENTRY_AUTH_TOKEN=... 같은 환경 변수 표기(감사 부차 지적).
    /\b([A-Z][A-Z0-9_]{1,60}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?))\s*=\s*([^\s,;"']+)/g,
    // { "token": "..." } 같은 JSON 표기.
    /"(password|passwd|token|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token)"\s*:\s*"[^"]*"/gi,
  ];

  return patterns.reduce((redacted, pattern) => {
    return redacted.replace(pattern, (match, prefix: string | undefined) => {
      if (prefix && /Authorization|Cookie/i.test(prefix)) return `${prefix}: [REDACTED]`;
      if (prefix && /Bearer\s+/i.test(prefix)) return `${prefix}[REDACTED]`;
      if (prefix && /_KEY$|_TOKEN$|_SECRET$|_PASSWORD$|_PASSWD$|_CREDENTIALS?$/.test(prefix)) {
        return `${prefix}=[REDACTED]`;
      }
      if (prefix && match.startsWith('"')) return `"${prefix}": "[REDACTED]"`;
      if (prefix && /password|passwd|token|secret|api[_-]?key/i.test(prefix)) {
        return `${prefix}=[REDACTED]`;
      }
      return "[REDACTED]";
    });
  }, value);
}

export function resetParticipantsForScopeChange(participants: readonly Participant[]): Participant[] {
  return participants.map((participant) => ({
    ...participant,
    acknowledgedPlanSHA256: null,
  }));
}

function uniqueFindingIDs(findings: readonly Finding[], label: string): Set<string> {
  const ids = new Set<string>();
  const duplicates = new Set<string>();
  for (const finding of findings) {
    if (ids.has(finding.id)) duplicates.add(finding.id);
    ids.add(finding.id);
  }
  if (duplicates.size > 0) {
    throw new Error(`${label}에 중복된 finding ID가 있습니다: ${[...duplicates].join(", ")}`);
  }
  return ids;
}

// 재계획 지시 판정. 본문 어딘가에 단어가 있기만 하면 트리거였던 승계 규칙은 "REPLAN 아님" 같은 제목 한 줄로 계획을
// DRAFT 로 되돌렸다(2026-09-07 S9 d03 사고). 지시로 인정하는 자리는 둘뿐이다: 어느 줄의 머리(`REPLAN …`) 또는 본문의 끝
// (`… REPLAN`). 문장 가운데 언급은 지시가 아니다.
export function replanDirective(body: string): boolean {
  return /^\s*REPLAN\b/m.test(body) || /\bREPLAN\s*$/.test(body.trimEnd());
}

// 수정 턴이 결정을 물어 멈춘 뒤의 결정에 REFIX 가 있으면 저장된 수정 결과를 재사용하지 않고 수정 턴을 다시 연다
// (2026-09-13 S10 실측: 결정이 "원자 하나 더 넣고 재측정" 인데 엔진이 저장 결과로 최종 리뷰에 들어가 Codex 리뷰 1회를 낭비).
// REPLAN 과 같은 위치 규칙 — 줄 머리 또는 본문 끝.
export function refixDirective(body: string): boolean {
  return /^\s*REFIX\b/m.test(body) || /\bREFIX\s*$/.test(body.trimEnd());
}
