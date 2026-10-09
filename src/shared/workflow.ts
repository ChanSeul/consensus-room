import { createHash } from "node:crypto";
import { sourceStringEnd, type SourceStringCache } from "./sourceStrings";

import type { AgentResult, Finding, WorkflowMode, WorkflowState } from "./contracts";
import { AgentResultSchema, FindingSchema, RESPONSE_RESOLVED_IDS_LIMIT, validatePlanHeadings } from "./contracts";
import { parsePlanChecks } from "./planChecks";

export const DELIVERY_RESUME_STATES = ["IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX"] as const;
export type DeliveryResumeState = typeof DELIVERY_RESUME_STATES[number];
export const isDeliveryResumeState = (state: unknown): state is DeliveryResumeState =>
  DELIVERY_RESUME_STATES.some(candidate => candidate === state);

export const ACTIVE_WORKFLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  "BRAINSTORMING",
  "CLAUDE_PLAN",
  "CODEX_AUDIT",
  "CLAUDE_REVISION",
  "IMPLEMENTING",
  "CODEX_REVIEW",
  "CLAUDE_FIX",
]);

// CR 흐름 단순화(D2): ticket 은 DRAFT → IMPLEMENTING → CODEX_REVIEW ⇄ CLAUDE_FIX → READY_TO_DELIVER, planned 는 CLAUDE_PLAN → CODEX_AUDIT ⇄
// CLAUDE_REVISION → (agree) AWAITING_USER_APPROVAL 로 간다.
const NEXT_STATES: Readonly<Record<WorkflowState, ReadonlySet<WorkflowState>>> = {
  DRAFT: new Set(["CLAUDE_PLAN", "IMPLEMENTING", "FAILED"]),
  BRAINSTORM_READY: new Set(["BRAINSTORMING", "DRAFT", "CLOSED", "FAILED"]),
  BRAINSTORMING: new Set(["BRAINSTORM_READY", "USER_DECISION_REQUIRED", "FAILED"]),
  CLAUDE_PLAN: new Set(["CODEX_AUDIT", "USER_DECISION_REQUIRED", "FAILED"]),
  CODEX_AUDIT: new Set(["CLAUDE_REVISION", "AWAITING_USER_APPROVAL", "USER_DECISION_REQUIRED", "FAILED"]),
  CLAUDE_REVISION: new Set(["CODEX_AUDIT", "USER_DECISION_REQUIRED", "FAILED"]),
  AWAITING_USER_APPROVAL: new Set(["IMPLEMENTING", "DRAFT", "CLAUDE_REVISION", "USER_DECISION_REQUIRED", "FAILED"]),
  IMPLEMENTING: new Set(["CODEX_REVIEW", "USER_DECISION_REQUIRED", "FAILED"]),
  CODEX_REVIEW: new Set(["CLAUDE_FIX", "READY_TO_DELIVER", "USER_DECISION_REQUIRED", "FAILED"]),
  CLAUDE_FIX: new Set(["CODEX_REVIEW", "USER_DECISION_REQUIRED", "FAILED"]),
  // CLAUDE_FIX·CODEX_REVIEW: 중재자의 재진입(resume reentry, F009) — 인도 대기 중 외부 검증이 찾은 결함의 수정, 또는 바뀐 작업 트리의 재리뷰를 같은 역할 세션으로 연다.
  // CLAUDE_PLAN: 계획 변경이 필요한 중재자 진단 — 진단 계획 개정 턴(→ 감사·사용자 승인). 작업 트리·브랜치·구현 기준은 보존한다.
  READY_TO_DELIVER: new Set(["CLOSED", "DRAFT", "FAILED", "CLAUDE_FIX", "CODEX_REVIEW", "CLAUDE_PLAN", "CLAUDE_REVISION", "USER_DECISION_REQUIRED"]),
  CLOSED: new Set(),
  USER_DECISION_REQUIRED: new Set([
    "BRAINSTORM_READY",
    "BRAINSTORMING",
    "DRAFT",
    "CLAUDE_PLAN",
    // 계획 리뷰어 정지(needs-mediator)를 결정문과 함께 같은 역할 턴으로 재개한다(D7, 계약 v3.7 (15)).
    "CODEX_AUDIT",
    "CLAUDE_REVISION",
    "IMPLEMENTING",
    "CODEX_REVIEW",
    "CLAUDE_FIX",
    "READY_TO_DELIVER",
    "FAILED",
  ]),
  FAILED: new Set(["BRAINSTORM_READY", "BRAINSTORMING", "DRAFT", "CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX"]),
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
  // 필수 검사 블록(```checks)은 선택이다 — 있으면 형식·등록 프로필을 여기서 거른다(수락 경계에서 처음 파싱해 실패하면 구현 턴 하나를 잃는다).
  parsePlanChecks(markdown);
}

export function bothAgentsAcknowledged(
  participants: readonly { role: string; acknowledgedPlanSHA256: string | null }[],
  planSHA256: string,
): boolean {
  const byRole = new Map(participants.map((participant) => [participant.role, participant]));
  return (
    byRole.get("claude")?.acknowledgedPlanSHA256 === planSHA256 &&
    byRole.get("codex")?.acknowledgedPlanSHA256 === planSHA256
  );
}

// 계획 흐름의 단계(D1) — 이 단계에 있거나 이 단계로 재개할 토픽은 계획 흐름을 탄 것이다.
const PLAN_FLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  "CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "AWAITING_USER_APPROVAL",
]);
// 구현 흐름의 단계 — ticket 에서 planned 로 바꿀 때 계획 단계로 옮기는 재개 지점이다(구현 결과는 그대로 둔다).
const DELIVERY_FLOW_STATES: ReadonlySet<WorkflowState> = new Set([
  "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "READY_TO_DELIVER",
]);
// 방식 백필 전용 계획 단계(D9) — 저장된 기록 문자열을 본다. 지운 옛 종결·ACK 단계에 머물렀거나 그리로 재개할 행도 계획 흐름이다.
const RECORDED_PLAN_FLOW_STATES: ReadonlySet<string> = new Set([...PLAN_FLOW_STATES, "CODEX_CLOSEOUT", "CONSENSUS_ACK"]);

// 작업 방식이 없던 기존 토픽의 방식(D9) — 현재 계획이 있거나 계획 단계에 있거나 그 단계로 재개할 토픽은 planned, 아니면 ticket.
// 방식 컬럼을 처음 붙일 때의 백필 판정이다(이행 전 원시 행이라 상태·재개 지점은 기록 문자열이다). 새 토픽은 생성 입력의 방식(기본 ticket)을 쓴다.
export function recordedWorkflowMode(topic: { planSHA256: string | null; state: string; resumeState: string | null }): WorkflowMode {
  const planning = RECORDED_PLAN_FLOW_STATES.has(topic.state) || (topic.resumeState !== null && RECORDED_PLAN_FLOW_STATES.has(topic.resumeState));
  return topic.planSHA256 || planning ? "planned" : "ticket";
}

// 작업 방식 전환 뒤 재개 지점(D1) — 기계적으로만 정하고 실행은 시작하지 않는다. null 이면 재개 지점을 바꾸지 않는다.
// planned → ticket: 계획 단계·승인 대기면 IMPLEMENTING(기존 구현 세션·작업 트리를 이어 쓴다). ticket → planned: 구현 단계면 계획이 없을 때
// CLAUDE_PLAN, 있을 때 같은 계획을 고치는 CLAUDE_REVISION.
export function workflowModeResumePoint(to: WorkflowMode, point: WorkflowState, hasPlan: boolean): WorkflowState | null {
  if (to === "ticket") return PLAN_FLOW_STATES.has(point) ? "IMPLEMENTING" : null;
  return DELIVERY_FLOW_STATES.has(point) ? (hasPlan ? "CLAUDE_REVISION" : "CLAUDE_PLAN") : null;
}

// 구현을 시작하는 상태 — ticket 은 시작 전(DRAFT), planned 는 사용자 승인 대기다.
export function implementationStartState(mode: WorkflowMode): WorkflowState {
  return mode === "ticket" ? "DRAFT" : "AWAITING_USER_APPROVAL";
}

// 구현 시작 게이트(D1·D2). ticket 은 계획·확인·승인을 요구하지 않는다. planned 는 사용자가 승인한 계획이 현재 계획과 같아야 한다 — 사용자 승인은
// 권한이라 남기고, 두 에이전트의 계획 확인(ACK)은 요구하지 않는다.
export function assertImplementationGate(input: {
  state: WorkflowState;
  workflowMode: WorkflowMode;
  planSHA256: string | null;
  approvedPlanSHA256: string | null;
}): void {
  if (input.state !== implementationStartState(input.workflowMode)) {
    throw new Error(input.workflowMode === "ticket" ? "티켓 작업은 시작 전(DRAFT)에서만 구현을 시작할 수 있습니다." : "구현 승인을 기다리는 상태가 아닙니다.");
  }
  if (input.workflowMode === "ticket") return;
  if (!input.planSHA256) {
    throw new Error("확정된 계획 해시가 없습니다.");
  }
  if (input.approvedPlanSHA256 !== input.planSHA256) {
    throw new Error("사용자가 현재 계획 버전을 승인하지 않았습니다.");
  }
}

// 해소 표식이 가리키는 요청 id 들 — 단수·복수 필드를 합쳐 공백을 지우고 중복을 없앤다(순서 유지). 빈 문자열·공백은 id 가 아니다: 구조화 출력
// 스키마는 minLength 를 못 걸어(OpenAI strict) 모델이 "" 를 낼 수 있고, 그것이 zod 에서 응답 전체를 거부시키면 유효한 나머지 id 의 해소까지
// 잃는다(2026-09-21 사전 검증 #2) — 스키마는 문자열을 받고 여기서 거른다.
export function resolutionIds(result: Pick<AgentResult, "resolvedRequestId" | "resolvedRequestIds">): string[] {
  const raw = [result.resolvedRequestId, ...(result.resolvedRequestIds ?? [])];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const value of raw) {
    const id = typeof value === "string" ? value.trim() : "";
    if (id && !seen.has(id)) { seen.add(id); ids.push(id); }
  }
  return ids;
}

export const CORRECTION_SUMMARY_SEPARATOR = "\n\n---\n교정 전 턴 보고(서버 보존):\n";

// 허용 오차 교정 재제출은 그 턴의 최종 결과가 된다 — 러너가 교정만 적고 본 턴 보고(summary·findings·evidence·요청 결정)를
// 비우면 턴의 성과가 기록에서 사라진다(2026-09-14 S11: $6.35 짜리 턴이 "코드 변경 없음 — 원장 공란" 한 줄로 남았고,
// 남은 단계를 적은 결정 요청도 사라져 엔진이 구현 완료로 보고 리뷰로 넘겼다). 교정 결과를 본 턴 결과 위에 병합한다:
// 같은 id 의 쟁점은 교정이 우선, 나머지는 보존; evidence 는 합집합; 요청 결정은 교정이 비우면 본 턴 것; summary 는 교정이
// 본 턴 요약을 담지 않았으면 뒤에 붙인다.
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
  // 이 판단은 **교정 자신의** 표식만 본다 — 원본의 표식은 앞 요청을 닫은 것이지 본 턴 질문이 사라졌다는 뜻이 아니다.
  const resolved = corrected.resolvesRequestedDecision === true;
  // 해소 표식·요청 id 는 교정이 되풀이하지 않아도 원본 것을 보존한다(합집합·중복 제거) — 계약 교정 프롬프트에는 열린 요청 절이 없어 러너가 id 를
  // 다시 적을 수 없고, salvage 원본 위에 교정만 얹으면 한 응답으로 닫은 N 건이 한꺼번에 되살아났다(2026-09-21 사전 검증 #1).
  const originalResolved = original.resolvesRequestedDecision === true;
  const resolutionFlag = resolved || originalResolved;
  if (!resolved && originalResolved) preserved.push("해소 표식");
  // 각 응답의 id 는 **그 응답의 표식이 true 일 때만** 해소 대상이다 — 표식 없는 응답의 id 를 다른 응답의 표식과 결합하면 보류 중인 요청까지
  // 닫힌다(host-review R01: 원본 {false, A} + 교정 {true, B} 는 B 만). 합집합은 응답 한도(100)를 넘을 수 있고 저장 계약은 그것을 받는다(R02).
  const resolvedIds = resolutionIds({
    resolvedRequestIds: [...(resolved ? resolutionIds(corrected) : []), ...(originalResolved ? resolutionIds(original) : [])],
  });
  const mediatorAction = corrected.requestedMediatorAction?.trim() || original.requestedMediatorAction?.trim();
  const decision = corrected.requestedUserDecision?.trim() ? corrected.requestedUserDecision : (resolved ? undefined : originalDecision);
  if (!corrected.requestedUserDecision?.trim() && originalDecision && !resolved) preserved.push("요청 결정");
  const originalSummary = original.summary.trim();
  let summary = corrected.summary;
  if (originalSummary && !corrected.summary.includes(originalSummary)) {
    const summaries = [...corrected.summary.split(CORRECTION_SUMMARY_SEPARATOR), ...originalSummary.split(CORRECTION_SUMMARY_SEPARATOR)];
    summary = [...new Set(summaries.map(value => value.trim()).filter(Boolean))].join(CORRECTION_SUMMARY_SEPARATOR);
    preserved.push("summary");
  }
  const { requestedUserDecision: _dropped, resolvesRequestedDecision: _flag, resolvedRequestId: _rid, resolvedRequestIds: _rids, ...rest } = corrected;
  const result: AgentResult = {
    ...rest, summary, findings: [...corrected.findings, ...keptFindings], evidenceRefs: [...evidence, ...keptEvidence],
    ...(decision !== undefined ? { requestedUserDecision: decision } : {}),
    ...(mediatorAction ? { requestedMediatorAction: mediatorAction } : {}),
    // 해소 표식은 최종 병합·소비까지 유지한다 — 실패 원본 복구와 교정 병합이 겹치면 바깥 병합이 원래 질문을 되살렸다(F08).
    ...(resolutionFlag ? { resolvesRequestedDecision: true } : {}),
    ...(resolvedIds.length ? { resolvedRequestIds: resolvedIds } : {}),
    ...(corrected.status ?? original.status ? { status: corrected.status ?? original.status } : {}),
    // 교정이 completed 를 선언하면 옛 remainingSteps 를 끌고 오지 않는다(완료 결과에 남은 단계가 붙어 모순이 되지 않게, R3-01).
    ...((corrected.remainingSteps ?? (corrected.status === "completed" ? undefined : original.remainingSteps))
      ? { remainingSteps: corrected.remainingSteps ?? original.remainingSteps } : {}),
  };
  return { result, preserved };
}

// 계약을 어긴 원본 응답에서 **개별로 유효한** 필드만 건진다 — 교정 재제출 위에 병합할 본 턴 보고(요약·쟁점·증거·요청 결정·상태·해소 표식).
// 검증에 실패한 필드를 무조건 재주입하면 교정이 같은 위반으로 다시 죽는다(2026-09-14 Codex 감사 R01 ②).
// 해소 표식(게이트·단수·복수 id)도 건진다 — 빠뜨리면 turn-result·before-contract-correction checkpoint 가 요청을 열린 채 기록하고 서버 재시작·
// 계약 교정 뒤 러너가 같은 해소를 다시 해야 한다(2026-09-21 사전 검증 #1; 단수 시절부터의 구멍이 목록으로 규모가 커졌다).
const remainingStepSchema = AgentResultSchema.shape.remainingSteps.unwrap().element;
// limitResolvedIds: 해소 id 를 한 번 응답 한도로 자른다(기본). 여러 응답을 합친 누적본을 건질 때는 false — 저장 계약은 무제한이다(R02, R3 리뷰 F002).
export function salvageResultFields(raw: unknown, kind: AgentResult["kind"], options: { limitResolvedIds?: boolean } = {}): AgentResult {
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
  const mediatorAction = typeof record.requestedMediatorAction === "string" && record.requestedMediatorAction.trim() ? record.requestedMediatorAction : undefined;
  const status = record.status === "completed" || record.status === "in_progress" || record.status === "blocked" ? record.status : undefined;
  // 남은 단계는 항목마다 스키마 원소 규칙(길이 한도)을 통과한 것만 건진다 — 한도를 넘는 단계를 건지면 누적본 checkpoint·교정 병합의 재검사가 같은
  // 위반으로 죽는다(2026-10-07 R3c: 505자 단계 하나가 구현 턴을 교정 전에 FAILED 로 보냈다). 잘라 넣지 않는다 — 원본은 교정 원본·checkpoint raw 에 남는다.
  const remainingSteps = Array.isArray(record.remainingSteps)
    ? record.remainingSteps.filter((step): step is string => remainingStepSchema.safeParse(step).success).slice(0, 50) : undefined;
  const resolves = record.resolvesRequestedDecision === true;
  const resolvedId = typeof record.resolvedRequestId === "string" && record.resolvedRequestId.trim() ? record.resolvedRequestId.trim() : undefined;
  const resolvedIds = Array.isArray(record.resolvedRequestIds)
    ? record.resolvedRequestIds.filter((id): id is string => typeof id === "string" && id.trim().length > 0).map((id) => id.trim())
      .slice(0, options.limitResolvedIds === false ? undefined : RESPONSE_RESOLVED_IDS_LIMIT)
    : undefined;
  return {
    kind, summary: summary || "(교정 전 원본에 유효한 요약이 없음)", findings, evidenceRefs,
    ...(mediatorAction ? { requestedMediatorAction: mediatorAction } : {}),
    ...(decision ? { requestedUserDecision: decision } : {}), ...(status ? { status } : {}),
    ...(remainingSteps && remainingSteps.length ? { remainingSteps } : {}),
    ...(resolves ? { resolvesRequestedDecision: true } : {}),
    ...(resolvedId ? { resolvedRequestId: resolvedId } : {}),
    ...(resolvedIds && resolvedIds.length ? { resolvedRequestIds: resolvedIds } : {}),
  };
}

// Read a value without consuming its enclosing quotes, including quotes escaped
// inside a JSON string. Replacing only this range preserves the caller's grammar.
function credentialValue(text: string, offset: number, grammar: "assignment" | "cookie" | "authorization-pair" | "environment" = "assignment", limit = text.length,
  sourceStrings: SourceStringCache = new Map()):
  { start: number; end: number; after: number; quoted: boolean } {
  if (text.startsWith("[REDACTED]", offset)) return { start: offset, end: offset + 10, after: offset + 10, quoted: false };
  let quoteIndex = offset;
  while (grammar !== "environment" && text[quoteIndex] === "\\") quoteIndex++;
  const quote = text[quoteIndex];
  if (quote === '"' || ((quote === "'" || quote === "`") && (grammar === "assignment" || grammar === "environment"))) {
    const escapes = quoteIndex - offset, start = quoteIndex + 1;
    if (!escapes && (quote === "`" || quote === '"') && (grammar === "assignment" || grammar === "environment")) {
      const value = sourceStringEnd(text, quoteIndex, limit, sourceStrings);
      return { start, end: value.after - (value.closed ? 1 : 0), after: value.after, quoted: true };
    }
    let fallbackEnd = limit;
    for (let cursor = start; cursor < limit; cursor++) {
      if (text[cursor] === "\n" || text[cursor] === "\r") {
        fallbackEnd = Math.min(fallbackEnd, cursor);
        if (grammar !== "assignment" && grammar !== "environment") break;
      }
      if (text[cursor] !== quote) continue;
      let slashes = 0;
      for (let index = cursor - 1; index >= start && text[index] === "\\"; index--) slashes++;
      if (slashes % (2 * (escapes + 1)) === escapes)
        return { start, end: cursor - escapes, after: cursor + 1, quoted: true };
    }
    return { start, end: fallbackEnd, after: fallbackEnd, quoted: true };
  }
  let end = offset;
  const delimiter = grammar === "environment" ? /[\s,;]/ : grammar === "cookie" ? /[\s;,]/
    : grammar === "authorization-pair" ? /[\s,]/ : /[\s,;&"'`)}\]|\\]/;
  while (end < limit && !delimiter.test(text[end])) end++;
  return { start: offset, end, after: end, quoted: false };
}

function redactCredentialValues(text: string, quotedContent: boolean): string {
  const ranges: Array<{ start: number; end: number; replacement: string; priority: number }> = [];
  const sourceStrings: SourceStringCache = new Map();
  const valueAt = (offset: number, grammar: Parameters<typeof credentialValue>[2] = "assignment", limit = text.length) =>
    credentialValue(text, offset, grammar, limit, sourceStrings);
  const strings: Array<{ start: number; end: number }> = [];
  // JSON string syntax belongs to the enclosing document, not to the credential
  // grammar. Decode complete strings, redact their contents, and re-encode only
  // changed contents. Never run the outer scanner inside those string spans.
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/g)) {
    let slashes = 0;
    for (let cursor = match.index! - 1; cursor >= 0 && text[cursor] === "\\"; cursor--) slashes++;
    if (slashes % 2) continue;
    let decoded: string;
    try { decoded = JSON.parse(match[0]) as string; } catch { continue; }
    const start = match.index!, end = start + match[0].length;
    strings.push({ start, end });
    const redacted = redactTextSecrets(decoded, true);
    if (redacted !== decoded) ranges.push({ start: start + 1, end: end - 1,
      replacement: JSON.stringify(redacted).slice(1, -1), priority: 1 });
  }
  const containing = <T extends { start: number; end: number }>(spans: readonly T[], index: number): T | undefined => {
    let low = 0, high = spans.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (spans[middle].end <= index) low = middle + 1; else high = middle;
    }
    return low < spans.length && spans[low].start <= index ? spans[low] : undefined;
  };
  const insideString = (index: number) => containing(strings, index);
  const shellLiterals: Array<{ start: number; end: number }> = [];
  for (let start = text.indexOf("'"); start >= 0;) {
    const json = insideString(start);
    if (json) { start = text.indexOf("'", json.end); continue; }
    const close = text.indexOf("'", start + 1);
    const end = close < 0 ? text.length : close + 1;
    shellLiterals.push({ start, end });
    start = text.indexOf("'", end);
  }
  // Parameter annotations are code contracts, independent of their type names.
  // Scope the exception to declarations; a standalone Authorization header must
  // still be masked even when its value resembles a type identifier.
  type ParameterSpan = { start: number; end: number; colon?: number };
  const declarations: ParameterSpan[] = [];
  const defaults = new Map<number, number>();
  const comments: Array<{ start: number; end: number }> = [];
  const blockStartByEnd = new Map<number, number>(), blockEndByStart = new Map<number, number>();
  const blockStack: number[] = [];
  // Balanced Swift blocks own their closing token even in a source fragment.
  // Matching all pairs once avoids backward searches from each init candidate.
  for (const token of text.matchAll(/\/\*|\*\//g)) {
    if (token[0] === "/*") blockStack.push(token.index!);
    else if (blockStack.length) {
      const start = blockStack.pop()!, end = token.index! + 2;
      blockStartByEnd.set(end, start);
      blockEndByStart.set(start, end);
    }
  }
  const quoteEnd = (start: number): number => sourceStringEnd(text, start, text.length, sourceStrings).after;
  const lineStarts = [0, ...Array.from(text.matchAll(/\r\n?|\n/g), match => match.index! + match[0].length)];
  const lineComments = new Map<number, number>();
  const beforeComment = new Map<number, string | undefined>();
  const previousCodeCharacter = (offset: number): string | undefined => {
    let previous = offset - 1;
    const visited: number[] = [];
    const finish = (character: string | undefined): string | undefined => {
      for (const start of visited) beforeComment.set(start, character);
      return character;
    };
    while (previous >= 0) {
      if (/\s/.test(text[previous])) { previous--; continue; }
      const blockStart = blockStartByEnd.get(previous + 1);
      if (blockStart !== undefined) {
        if (beforeComment.has(blockStart)) return finish(beforeComment.get(blockStart));
        visited.push(blockStart);
        previous = blockStart - 1;
        continue;
      }
      let low = 0, high = lineStarts.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (lineStarts[middle] <= previous) low = middle; else high = middle;
      }
      const start = lineStarts[low], end = lineStarts[low + 1] ?? text.length;
      if (!lineComments.has(start)) {
        let comment = -1;
        for (let cursor = start; cursor < end;) {
          if (text[cursor] === '"' || text[cursor] === "'") { cursor = quoteEnd(cursor); continue; }
          const blockEnd = blockEndByStart.get(cursor);
          if (blockEnd !== undefined) { cursor = blockEnd; continue; }
          if (text.startsWith("//", cursor)) { comment = cursor; break; }
          cursor++;
        }
        lineComments.set(start, comment);
      }
      const comment = lineComments.get(start)!;
      if (comment >= 0 && comment <= previous) {
        // Cache the predecessor of the whole comment chain, not just its text.
        // Many declaration-like words in consecutive comments otherwise walk
        // the same earlier lines once for every candidate.
        if (beforeComment.has(comment)) return finish(beforeComment.get(comment));
        visited.push(comment);
        previous = comment - 1;
        continue;
      }
      return finish(text[previous]);
    }
    return finish(undefined);
  };
  const declarationStarts = new Map<number, boolean>();
  for (const match of text.matchAll(/\b(?:(?:func|function)\s+[A-Za-z_$][\w.$]*|init[!?]?|subscript|constructor)(?:<[^>\r\n]*>)?\s*\(/g)) {
    if (previousCodeCharacter(match.index!) !== ".") {
      declarationStarts.set(match.index! + match[0].length - 1, /^(?:func\b|init\b|subscript\b)/.test(match[0]));
    }
  }
  type Declaration = { start: number; annotation: boolean; nestedComments: boolean; colon?: number; ranges: ParameterSpan[] };
  const delimiters: Array<{ close: string; declaration?: Declaration }> = [];
  const activeDeclarations: Declaration[] = [];
  // Source islands start at a recognized declaration, not at prose parentheses
  // or a preceding declaration. Each owns its comments, strings and parameters.
  // One forward pass also preserves linear handling of truncated declarations.
  for (let cursor = 0; declarationStarts.size && cursor < text.length; cursor++) {
    const quoted = insideString(cursor);
    if (quoted) { cursor = quoted.end - 1; continue; }
    if (declarationStarts.has(cursor)) {
      const declaration: Declaration = { start: cursor + 1, annotation: true,
        nestedComments: declarationStarts.get(cursor)!, ranges: [] };
      activeDeclarations.push(declaration);
      delimiters.push({ close: ")", declaration });
      continue;
    }
    if (!delimiters.length) continue;
    const character = text[cursor];
    if (character === "'" || character === "`") { cursor = quoteEnd(cursor) - 1; continue; }
    if (text.startsWith("//", cursor)) {
      let end = cursor + 2;
      while (end < text.length && text[end] !== "\n" && text[end] !== "\r") end++;
      comments.push({ start: cursor, end });
      cursor = end - 1;
      continue;
    }
    if (text.startsWith("/*", cursor)) {
      let end: number;
      if (activeDeclarations.at(-1)!.nestedComments) {
        end = blockEndByStart.get(cursor) ?? text.length;
      } else {
        const close = text.indexOf("*/", cursor + 2);
        end = close < 0 ? text.length : close + 2;
      }
      comments.push({ start: cursor, end });
      cursor = end - 1;
      continue;
    }
    const top = delimiters.at(-1)!;
    if (top.declaration && (character === "," || character === "=")) {
      const declaration = top.declaration;
      if (declaration.annotation) {
        declaration.ranges.push({ start: declaration.start, end: cursor + (character === "=" ? 1 : 0), colon: declaration.colon });
        if (character === "=" && declaration.colon !== undefined) defaults.set(declaration.colon, cursor + 1);
      }
      declaration.start = cursor + 1;
      declaration.annotation = character === ",";
      declaration.colon = undefined;
    } else if (top.declaration?.annotation && character === ":") {
      top.declaration.colon ??= cursor;
    } else if ("([{<".includes(character) && (character !== "<" || activeDeclarations.at(-1)?.annotation)) {
      delimiters.push({ close: ")]}>"["([{<".indexOf(character)] });
    } else if (character === top.close) {
      delimiters.pop();
      if (top.declaration) {
        activeDeclarations.pop();
        const declaration = top.declaration;
        if (declaration.annotation) declaration.ranges.push({ start: declaration.start, end: cursor, colon: declaration.colon });
        for (const range of declaration.ranges) declarations.push(range);
      }
    }
  }
  const afterTrivia = (offset: number): number => {
    while (offset < text.length) {
      if (/\s/.test(text[offset])) { offset++; continue; }
      const comment = containing(comments, offset);
      if (!comment) break;
      offset = comment.end;
    }
    return offset;
  };
  declarations.sort((a, b) => a.start - b.start);
  const placeholder = (value: string, variable = false) => /^(?:\[REDACTED\]|<[^<>\r\n]+>)$/.test(value.trim()) ||
    (variable && /^\$/.test(value.trim()));
  const add = (value: ReturnType<typeof credentialValue>, variable = false) => {
    if (value.end > value.start && !placeholder(text.slice(value.start, value.end), variable))
      ranges.push({ start: value.start, end: value.end, replacement: "[REDACTED]", priority: 0 });
  };
  const parameter = (key: number): boolean => {
    const colon = text.indexOf(":", key), defaultStart = defaults.get(colon);
    // Privacy does not depend on a complete declaration or type exemption.
    // A truncated declaration still has a literal credential default to mask.
    if (defaultStart !== undefined) {
      const value = valueAt(afterTrivia(defaultStart));
      if (value.quoted) add(value);
    }
    const declaration = containing(declarations, key);
    return declaration !== undefined && declaration.colon === colon;
  };
  for (const match of text.matchAll(/(^|[\s,({?&]|["'`](?=[\w-]+\s*=))((?:password|passwd|token|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token)\s*[:=]\s*)/gi)) {
    if (insideString(match.index! + match[1].length)) continue;
    // Keep an opaque quoted namespace:value label. Actual JSON credential keys
    // are handled before this pass; log fields and = assignments remain scanned.
    if (quotedContent && match.index === 0 && /^[\w-]+:$/.test(match[2])) continue;
    if (/:\s*$/.test(match[2]) && parameter(match.index! + match[1].length)) continue;
    const value = valueAt(match.index! + match[0].length);
    const literal = text.slice(value.start, value.end);
    const query = match[1] === "?" || match[1] === "&";
    if (!query && !value.quoted && (/[(]/.test(literal) ||
        (/:(?:\s*)$/.test(match[2]) && /^(?:String|NSString|Data|Int|Bool|Token)(?:[?<].*)?$/.test(literal)) ||
        /^(?:read|use|from|the|only|never|true|false|null|undefined|nil)$/i.test(literal))) continue;
    add(value, !query && !value.quoted && !containing(shellLiterals, match.index! + match[1].length));
  }
  // Environment assignments use the same decoded-string and value boundaries.
  // Running a regex after JSON re-encoding can consume the closing quote escape.
  for (const match of text.matchAll(/\b[A-Z][A-Z0-9_]{1,60}(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?)\s*=\s*/g)) {
    if (insideString(match.index!)) continue;
    const shell = containing(shellLiterals, match.index!);
    const limit = shell && text[shell.end - 1] === "'" ? shell.end - 1 : text.length;
    add(valueAt(match.index! + match[0].length, "environment", limit));
  }
  const pairPattern = /[^\s=;,"'`|\\]+\s*=\s*/y;
  const schemePattern = /[A-Za-z][A-Za-z0-9_-]*\s+/y;
  const typeSuffix = /\s*(?:[,)]|=)/y;
  const redactPairs = (offset: number, separator: ";" | ",", limit: number): boolean => {
    let cursor = offset, matched = false;
    for (;;) {
      pairPattern.lastIndex = cursor;
      const pair = pairPattern.exec(text);
      if (!pair || cursor + pair[0].length > limit) return matched;
      matched = true;
      const value = valueAt(cursor + pair[0].length, separator === ";" ? "cookie" : "authorization-pair", limit); add(value);
      cursor = value.after;
      while (cursor < limit && /\s/.test(text[cursor])) cursor++;
      if (cursor >= limit) return matched;
      if (text[cursor] !== separator) return matched;
      cursor++;
      while (cursor < limit && /\s/.test(text[cursor])) cursor++;
    }
  };
  for (const match of text.matchAll(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*:\s*/gi)) {
    if (insideString(match.index!)) continue;
    const cursor = match.index! + match[0].length;
    if (parameter(match.index!)) continue;
    // A shell's outer quotes are not Cookie octets. JSON-compatible double
    // quotes were handled above; shell-only escapes still need this boundary.
    const wrapper = text[match.index! - 1];
    const wrapperEnd = wrapper === "'" || wrapper === '"' ? valueAt(match.index! - 1).end : -1;
    const newline = text.indexOf("\n", cursor);
    const limit = Math.min(wrapperEnd < 0 ? text.length : wrapperEnd, newline < 0 ? text.length : newline);
    if (/cookie/i.test(match[1])) {
      redactPairs(cursor, ";", limit);
      continue;
    }
    const value = valueAt(cursor);
    if (value.quoted) {
      const literal = text.slice(value.start, value.end).replace(/^(?:Bearer|Basic)\s+/i, "");
      if (!placeholder(literal)) add(value);
      continue;
    }
    const first = text.slice(value.start, value.end);
    typeSuffix.lastIndex = value.after;
    if (/^(?:String|NSString|Data|Token)\??$/.test(first) && typeSuffix.test(text)) continue;
    schemePattern.lastIndex = cursor;
    const scheme = schemePattern.exec(text);
    if (scheme) {
      if (!/^(?:Basic|Bearer|Negotiate|Token)\s/i.test(scheme[0]) &&
          redactPairs(cursor + scheme[0].length, ",", limit)) continue;
      const token = valueAt(cursor + scheme[0].length);
      if (!placeholder(text.slice(token.start, token.end))) {
        if (token.quoted) add(token); else add({ ...token, start: cursor });
      }
    } else add(value);
  }
  const chunks: string[] = [];
  let cursor = 0;
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end || a.priority - b.priority)) {
    if (range.start < cursor) continue;
    chunks.push(text.slice(cursor, range.start), range.replacement);
    cursor = range.end;
  }
  chunks.push(text.slice(cursor));
  return chunks.join("");
}

export function redactSecrets(value: string): string {
  return redactTextSecrets(value, false);
}

function redactTextSecrets(value: string, quotedContent: boolean): string {
  // JSON secret fields retain both delimiters. Free-text headers/assignments then
  // redact value ranges rather than swallowing code, quotes or a whole line.
  let text = value.replace(
    /("(?:password|passwd|token|secret|api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|Authorization|Proxy-Authorization|Cookie|Set-Cookie)"\s*:\s*)"(?:\\.|[^"\\])*"/gi,
    '$1"[REDACTED]"',
  );
  text = redactCredentialValues(text, quotedContent);
  const patterns: RegExp[] = [
    /\b(sk-(?:proj-)?[A-Za-z0-9_-]{12,})\b/g,
    /\b(gh[opsu]_[A-Za-z0-9]{20,})\b/g,
    /\b(xox[baprs]-[A-Za-z0-9-]{12,})\b/g,
    /\b(AKIA[A-Z0-9]{16})\b/g,
    /\b(Bearer\s+)[A-Za-z0-9._~+\/-]+=*/gi,
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
  }, text);
}
