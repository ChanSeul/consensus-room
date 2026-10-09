import type { TimelineEvent } from "./contracts";
import { TURN_OUTCOMES, WorkerFactSchema, type EnvelopeRole, type WorkerFact } from "./turnContract";

// 어댑터가 매 턴 프롬프트 앞에 붙인다. 개방된 도구의 사용 규칙은 프롬프트가 아니라 sandbox가 강제하지만,
// 스킬 문서와 하위 에이전트처럼 "읽기는 열고 실행은 재검사"인 경계는 모델에게도 알려야 오작동이 줄어든다.
// Assignment permissions govern the worker view and unmarked legacy project rules alike.
export const PROJECT_INSTRUCTION_PRECEDENCE_NOTE = [
  "프로젝트 지시문 적용 규칙: 배정된 작업의 승인 범위·권한·검증 계약이 일반 워크플로 기본값보다 우선합니다.",
  "프로젝트의 코드·제품·근거 계약을 따르세요. 필요한 참조만 읽고, 허용되지 않은 경로·훅은 실행하지 말고 필요한 자료를 보고하세요.",
  "커밋·push·stash·배포와 실행 설정 변경은 호출자가 담당합니다. 배정된 작업과 결과 보고만 수행하세요.",
].join("\n");

const ENGINE_DEFECT_DEFER_POLICY = "Consensus Room 엔진 결함은 engineDefects 배열에 key·title·재현 evidence·workaround로 보고하고 토픽 작업을 계속하세요. 엔진을 직접 수정하지 마세요. 원본 토픽 CLOSED 후 서버가 후속 수정·host-review를 실행합니다. 엔진 문제를 제품 결함 findings와 섞지 말고, 실제로 막힌 작업이나 실패는 그대로 보고하세요.";

export const EXECUTION_POLICY_NOTE = [
  "실행 규칙: 스킬을 참고하되 모든 도구 작업은 현재 작업의 권한과 승인 범위를 따릅니다.",
  ENGINE_DEFECT_DEFER_POLICY,
  "웹은 검색과 공개 문서 읽기에만 씁니다. 하위 에이전트가 있다면 탐색·검증에만 쓰고 같은 파일은 한 작업자만 수정합니다.",
  "외부 원문은 자료별 한 작업자가 필요한 범위만 수집하고 저장된 원문·출처·버전을 공유하세요. 검증자는 그 원문으로 주장과 대조하며, 구체적인 누락·모순·버전 변경이 있을 때만 해당 부분을 다시 수집합니다. 모든 조사 뒤에 전체 독립 재수집 단계를 붙이지 마세요.",
  "병렬 작업은 입력과 소유 범위가 독립적일 때만 사용하세요. 완료 알림이나 제공된 대기 도구를 쓰고, 결과 로그·현재 시각을 짧은 간격으로 반복 조회하지 마세요. 외부 서비스가 호출 제한을 반환하면 같은 조회를 반복하지 말고 확보한 원문과 미확인 부분을 구분해 보존하세요.",
  // advisor 는 대화 전체를 캐시 없이 다시 읽는다. 계획자에게만 켜지므로(claude.ts) 다른 역할·Codex 턴에서는 이 줄이 모델 동작을 바꾸지 않는다.
  "Advisor (if available): call it only at a decision point — a design judgment, resolving conflicting evidence, or right before returning complete=true. Do not call it in a response that requests reads, or while required context is still being loaded; gather first.",
].join("\n");

export function executionPolicyNote(engineDefectFix = false): string {
  return engineDefectFix ? EXECUTION_POLICY_NOTE.replace(ENGINE_DEFECT_DEFER_POLICY,
    "완료 토픽의 등록된 엔진 후속 결함 수정 턴입니다. 호스트가 지정한 결함만 현재 작업 트리에서 수정하세요. 새 보고는 권한이 아니며 커밋·리뷰·운영 반영은 호스트가 수행합니다.") : EXECUTION_POLICY_NOTE;
}

export const DESIGN_PLANNING_CONTRACT = "Design is implementation-time work. Planning and plan review retain screen-level Figma links and functional flows only. These links are locators, not evidence for visual claims or delivered fragment IDs. Do not fetch or reproduce layout, dimensions, spacing, typography, colors, node trees or screenshots in the plan. Resolve product behavior from confirmed requirements; missing visual detail is not a planning blocker. At implementation, inspect the linked screen on demand and stop for a product decision only if it changes the agreed behavior or scope.";

// 기계 검사가 거부한 응답을 같은 세션에 돌려보내 표기만 고친 재제출을 받는다. 작업을 다시 시키는 것이
// 아니다 — 세션 컨텍스트에 직전 작업이 전부 있으므로 결과 JSON만 계약에 맞춰 다시 방출하면 된다
// (2026-09-01 S1.1: 계약 위반 하나로 1시간 구현 턴이 소각된 사건의 프로그램적 방지).
export function buildContractCorrectionPrompt(violation: string, allowedKinds?: readonly string[] | null): string {
  const kindRule = allowedKinds && allowedKinds.length > 1
    ? `kind는 ${allowedKinds.join(", ")} 안에서 실제 판단과 일치하는 값을 고르세요. 거부 사유가 판단 종류와 내용의 모순이면 kind도 교정하세요.`
    : "kind는 직전 응답과 동일하게 유지하세요.";
  return `서버 기계 검사가 방금 응답을 거부했습니다.

거부 사유: ${violation}

작업을 다시 하지 마세요. 파일도 수정하지 마세요. 직전 턴에서 실제로 한 작업 내용 그대로,
거부 사유가 가리키는 필드 값만 계약에 맞게 고쳐 전체 결과 JSON을 다시 반환하세요.
${kindRule} 사실과 다른 값으로 바꿔치기하지 마세요 —
계약에 맞는 값 중 실제 상황을 정직하게 나타내는 값을 고르세요.`;
}

// ---- 역할별 원문 왕복 프롬프트(CR 흐름 단순화 D5) ----------------------------------------------------------------------------
// 각 역할은 자기 세션 하나를 계속 쓴다. 과제·지침·근거 위치는 세션 첫 턴에만 싣고, 이후 턴은 상대 응답 원문과 그 세션이 아직 받지 않은 새 사실
// (중재자·사용자 메시지, 원문 변경 사실, 계획 버전·변경분 경로)만 싣는다. 옛 계획 의무(감사·종결·ACK·처분·허용 오차·계획 해시 합의·필수 절)는
// 싣지 않는다 — 지적의 타당성·영향·합의는 작업자와 중재자가 판단하고, 엔진은 outcome 만 읽는다. 문맥 압축은 공급자 기본 세션에 맡긴다.

const RELAY_ROLE_NAMES: Readonly<Record<EnvelopeRole, string>> = {
  planner: "플래너", "plan-reviewer": "계획 리뷰어", implementer: "구현자", "code-reviewer": "코드 리뷰어",
};

// 계획 묶음의 한 판 — 세션 3 의 계획 묶음 타입과 같은 모양이다(서로 import 하지 않는다). snapshotPath 는 그 판의 스냅샷 폴더, diffPath 는 직전 판 대비 변경분.
export interface PlanBundleFact { version: string; snapshotPath: string; diffPath?: string | null }

export interface RelayMessage { sequence: number; actor: string; kind: string; body: string }

// 이 세션이 마지막으로 받은 뒤 바뀐 원문 사실(D6) — 영향 판단은 받는 세션이 한다.
export interface SourceChangeFact {
  sourceId: string;
  title?: string | null;
  previousRevision?: string | null;
  revision?: string | null;
  previousHash?: string | null;
  hash?: string | null;
  changePath?: string | null;
  error?: string | null;
}

// 엔진이 실제로 실행한 검사의 결과(계획에 선언된 필수 검사 등) — 실패는 구현자에게, 영수증은 리뷰어에게 사실로 전한다. 모양은 check-result 사실의 항목이다.
export type CheckFact = Extract<WorkerFact, { kind: "check-result" }>["checks"][number];

export interface RelayFacts {
  // 상대 역할의 응답 원문 — 엔진은 바꾸지 않고 그대로 싣는다.
  counterpart?: { role: EnvelopeRole; message: string } | null;
  // 이 세션이 아직 받지 않은 중재자·사용자 메시지(결정·증거·메모).
  messages?: readonly RelayMessage[];
  sourceChanges?: readonly SourceChangeFact[];
  checks?: readonly CheckFact[];
  // current = 검토·수정 중인 현재 판, approved = 사용자가 승인한 판, reference = ticket 으로 전환된 토픽에 남은 이전 계획(따를 의무 없음).
  plan?: (PlanBundleFact & { status: "current" | "approved" | "reference" }) | null;
}

export interface FirstTurnInput extends RelayFacts {
  role: EnvelopeRole;
  title: string;
  task?: string | null;
  worktreePath: string;
  branchName?: string | null;
  baseRef?: string | null;
  // planner 가 계획 파일을 쓰고 고칠 폴더(planner 첫 턴에 필수).
  planDirectory?: string | null;
  // 근거 위치 — 이 세션에 읽기가 허용된 원문·결정 경로.
  references?: readonly { label: string; path: string }[];
  // 계획 전에 나눈 논의 발언 원문 — 첫 턴에 한 번만 싣는다(이어지는 턴의 relay 프롬프트에는 없다).
  discussion?: readonly RelayMessage[];
}

function relayRoleGuide(role: EnvelopeRole, planDirectory: string | null | undefined): string {
  switch (role) {
    case "planner":
      if (!planDirectory) throw new Error("planner 첫 턴에는 계획 폴더(planDirectory)가 필요합니다.");
      return `역할: 플래너. 계획을 \`${planDirectory}\` 폴더의 Markdown 파일(기본 plan.md, 필요하면 여러 파일)로 직접 쓰고, 리뷰어 응답을 받으면 같은 파일을 고칩니다. 이 폴더 밖의 파일은 수정하지 않습니다.
message 는 리뷰어에게 그대로 전달됩니다 — 무엇을 쓰거나 바꿨는지, 리뷰어 응답에 대한 답을 적으세요.
outcome: ready(리뷰어에게 넘길 준비가 됨) · needs-mediator(중재자·사용자 결정이 있어야 계속할 수 있음 — 물을 내용은 mediatorRequest 에)`;
    case "plan-reviewer":
      return `역할: 계획 리뷰어. 플래너의 계획 파일을 읽고 검토합니다. 파일을 수정하지 않습니다.
message 는 플래너에게 그대로 전달됩니다 — 고칠 점과 근거, 또는 동의하는 이유를 적으세요.
outcome: changes(계획을 고쳐야 함) · agree(이 판의 계획에 동의) · needs-mediator(중재자·사용자 결정이 필요함 — 물을 내용은 mediatorRequest 에)`;
    case "implementer":
      return `역할: 구현자. 작업 폴더에서 과제를 구현하고 필요한 검증을 실행합니다. commit·push 는 하지 않습니다.
message 는 코드 리뷰어에게 그대로 전달됩니다 — 바꾼 것, 실행한 검증과 결과, 남은 문제를 적으세요.
outcome: done(리뷰받을 준비가 됨) · continue(남은 일을 이 세션에서 이어서 함) · needs-mediator(중재자·사용자 결정이나 실행이 필요함 — 필요한 것은 mediatorRequest 에)`;
    case "code-reviewer":
      return `역할: 코드 리뷰어. 작업 폴더의 변경을 검토합니다. 파일을 수정하지 않습니다.
message 는 구현자에게 그대로 전달됩니다 — 고칠 점과 근거, 또는 승인하는 이유를 적으세요.
outcome: changes(수정이 필요함) · approve(현재 변경을 승인) · needs-mediator(중재자·사용자 결정이 필요함 — 물을 내용은 mediatorRequest 에)`;
  }
}

function relayPlanFact(plan: NonNullable<RelayFacts["plan"]>): string {
  const location = `\`${plan.snapshotPath}\``;
  switch (plan.status) {
    case "current":
      return `계획 버전 ${plan.version}: ${location}${plan.diffPath ? ` · 직전 판 대비 변경분: \`${plan.diffPath}\`` : ""}`;
    case "approved":
      return `사용자가 승인한 계획(버전 ${plan.version}): ${location} — 구현 범위입니다.`;
    case "reference":
      return `참고 자료 — 이전 계획 묶음(따를 의무는 없습니다. 필요할 때만 읽으세요): ${location}`;
  }
}

function relaySourceChange(change: SourceChangeFact): string {
  const span = (before: string | null | undefined, after: string | null | undefined) => before || after ? `${before ?? "없음"} → ${after ?? "없음"}` : null;
  const parts = [
    span(change.previousRevision, change.revision) && `revision ${span(change.previousRevision, change.revision)}`,
    span(change.previousHash, change.hash) && `hash ${span(change.previousHash, change.hash)}`,
    change.changePath && `변경분 \`${change.changePath}\``,
    change.error && `조회 오류: ${change.error}`,
  ].filter(Boolean);
  return `- ${change.sourceId}${change.title ? ` (${change.title})` : ""}${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

// 원문은 그대로 싣는다 — 경계 줄만 붙이고 자르거나 요약하지 않는다.
function relayFactSections(facts: RelayFacts): string[] {
  const sections: string[] = [];
  if (facts.counterpart) {
    const name = RELAY_ROLE_NAMES[facts.counterpart.role];
    sections.push(`----- ${name} 응답 원문 시작 -----\n${facts.counterpart.message}\n----- ${name} 응답 원문 끝 -----`);
  }
  if (facts.plan) sections.push(relayPlanFact(facts.plan));
  if (facts.messages?.length) {
    sections.push(`중재자·사용자 메시지:\n${facts.messages.map(message => `[#${message.sequence} ${message.actor}/${message.kind}]\n${message.body}`).join("\n\n")}`);
  }
  if (facts.sourceChanges?.length) {
    sections.push(`바뀐 원문(영향은 이 세션이 판단합니다):\n${facts.sourceChanges.map(relaySourceChange).join("\n")}`);
  }
  if (facts.checks?.length) {
    sections.push(`엔진이 실행한 검사:\n${facts.checks.map(check => `- ${check.id}: ${check.status}${check.logPath ? ` · 로그 \`${check.logPath}\`` : ""}${check.summary ? `\n  ${check.summary}` : ""}`).join("\n")}`);
  }
  return sections;
}

// 역할 세션의 첫 턴 — 과제·지침·근거 위치와 지금까지의 사실을 한 번 싣는다. 결과 형식(필드·outcome 값)은 CLI 출력 스키마가, memoryUpdates·engineDefects 의
// 쓰임은 어댑터가 붙이는 실행 규칙·메모리 안내가 이미 전하므로 다시 설명하지 않는다. 지침은 스키마가 말하지 못하는 것(message 의 수신자, outcome 의 뜻)만 싣는다.
export function buildFirstTurnPrompt(input: FirstTurnInput): string {
  const context = [
    `과제: ${input.title}`,
    ...(input.task ? [input.task] : []),
    `작업 폴더: ${input.worktreePath}`,
    ...(input.branchName ? [`작업 브랜치: ${input.branchName}`] : []),
    ...(input.baseRef ? [`기준 리비전: ${input.baseRef}`] : []),
    ...(input.references?.length ? [`근거 위치(읽기 허용):\n${input.references.map(reference => `- ${reference.label}: \`${reference.path}\``).join("\n")}`] : []),
  ].join("\n");
  const discussion = input.discussion?.length
    ? [`논의 발언 원문:\n${input.discussion.map(message => `[#${message.sequence} ${message.actor}]\n${message.body}`).join("\n\n")}`] : [];
  return [relayRoleGuide(input.role, input.planDirectory), context, ...discussion, ...relayFactSections(input)].join("\n\n");
}

// 같은 세션의 이어지는 턴 — 상대 응답 원문과 이 세션이 아직 받지 않은 새 사실만 싣는다. 새 입력이 없으면(continue) 이어서 진행하라는 한 줄이다.
export function buildRelayPrompt(facts: RelayFacts): string {
  const sections = relayFactSections(facts);
  return sections.length ? sections.join("\n\n") : "새 입력이 없습니다. 이어서 진행하세요.";
}

// 세션 커서 뒤의 사실 이벤트(사용자 이벤트와 payload.workerFact 가 있는 system 이벤트)를 빌더 입력으로 옮긴다. 상대 봉투 원문(counterpart)은 호출자가 더한다.
// 계획은 가장 최근 판 하나다(그 판의 diff 는 직전 판 대비). 형식이 계약과 다른 사실 표식은 조용히 빼지도, 턴 전체를 멈추지도 않는다 — 원본과 위반을
// 메시지로 그대로 보여 받는 세션과 중재자가 판단하게 한다(표식 하나의 오류로 독립 작업을 막지 않는다).
export function relayFactsFrom(events: readonly TimelineEvent[]): Pick<RelayFacts, "messages" | "sourceChanges" | "checks" | "plan"> {
  const messages: RelayMessage[] = [];
  const sourceChanges: SourceChangeFact[] = [];
  const checks: CheckFact[] = [];
  let plan: RelayFacts["plan"] = null;
  let groupRevision = -1;
  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.actor === "user") {
      messages.push({ sequence: event.sequence, actor: event.actor, kind: event.kind, body: event.body });
      continue;
    }
    if (event.payload.workerFact === undefined) continue;
    const parsed = WorkerFactSchema.safeParse(event.payload.workerFact);
    if (!parsed.success) {
      messages.push({ sequence: event.sequence, actor: "system", kind: "worker-fact-invalid",
        body: `사실 표식을 읽지 못했습니다(${parsed.error.issues.map(issue => `${issue.path.join(".") || "(전체)"}: ${issue.message}`).join("; ")}). 원본: ${JSON.stringify(event.payload.workerFact)}` });
      continue;
    }
    const fact = parsed.data;
    switch (fact.kind) {
      case "plan-version":
        plan = { status: "current", version: fact.version, snapshotPath: fact.snapshotPath, diffPath: fact.diffPath };
        break;
      case "source-change":
        sourceChanges.push({ sourceId: fact.sourceId, previousRevision: fact.before?.revision, revision: fact.after?.revision,
          previousHash: fact.before?.contentHash, hash: fact.after?.contentHash, changePath: fact.diffPath });
        break;
      case "source-error":
        sourceChanges.push({ sourceId: fact.sourceId, error: fact.error });
        break;
      case "workflow-mode":
        messages.push({ sequence: event.sequence, actor: "system", kind: "workflow-mode", body: `작업 방식이 ${fact.from} 에서 ${fact.to} 로 바뀌었습니다. 사유: ${fact.reason}` });
        break;
      case "check-result":
        checks.push(...fact.checks);
        break;
      case "work-group-revision":
        // 본문은 개정 시점의 단계 문맥 전체라 최근 본문이 옛 본문을 대신한다 — 계획 판처럼 가장 최근 하나만 싣는다(저장된 사건은 그대로다).
        if (groupRevision >= 0) messages.splice(groupRevision, 1);
        groupRevision = messages.push({ sequence: event.sequence, actor: "system", kind: "work-group-revision",
          body: `작업 묶음 ${fact.groupId} 이 v${fact.version} 로 개정됐습니다. 단계 ${fact.stageId} 의 개정 시점 문맥:\n${fact.context}` }) - 1;
        break;
      case "evidence-selection": {
        // 바뀐 사실만 싣는다 — 무엇을 다시 할지는 받는 세션과 중재자가 정한다(79fc4fc5 F011).
        const version = `카탈로그 버전 ${fact.catalogVersion.slice(0, 12)}`;
        messages.push({ sequence: event.sequence, actor: "system", kind: "evidence-selection", body: fact.groupId === undefined
          ? `근거 목록이 바뀌었습니다(${version}).`
          : fact.groupId === null ? `이 주제의 작업 그룹 근거 연결을 해제했습니다(${version}).`
            : `작업 그룹 ${fact.groupId} 의 근거를 이 주제에 연결했습니다(${version}).` });
        break;
      }
    }
  }
  return { messages, sourceChanges, checks, plan };
}

// 봉투 계약을 어긴 응답의 같은 세션 교정(실행기가 한 번 부른다) — 작업을 다시 하지 않고 직전 응답 내용을 봉투로만 다시 낸다.
export function buildEnvelopeCorrectionPrompt(role: EnvelopeRole, issues: readonly string[]): string {
  return `직전 응답이 결과 봉투 계약에 맞지 않습니다: ${issues.join("; ")}
작업을 다시 하지 말고 직전 응답의 내용을 같은 결과 형식으로만 다시 답하세요. outcome 은 ${TURN_OUTCOMES[role].join(" · ")} 중 하나이고, needs-mediator 이면 mediatorRequest 에 물을 내용을 적습니다.`;
}
