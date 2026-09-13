import { createHash } from "node:crypto";

import type { AgentResult, Finding, Participant, PlanEdit, WorkflowState } from "./contracts";
import { FIX_AWARE_KINDS, validatePlanHeadings } from "./contracts";
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
  CODEX_AUDIT: new Set(["CLAUDE_REVISION", "BLOCKED_ON_EVIDENCE", "USER_DECISION_REQUIRED", "FAILED"]),
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
