import type { TimelineEvent } from "./contracts";
import { PLAN_ITEMS_EXAMPLE, type PlanItemReport } from "./planItems";
import { TURN_OUTCOMES, WorkerFactSchema, type EnvelopeRole, type WorkerFact } from "./turnContract";

// 어댑터가 매 턴 프롬프트 앞에 붙인다. 개방된 도구의 사용 규칙은 프롬프트가 아니라 sandbox가 강제하지만,
// 스킬 문서와 하위 에이전트처럼 "읽기는 열고 실행은 재검사"인 경계는 모델에게도 알려야 오작동이 줄어든다.
// Assignment permissions govern the worker view and unmarked legacy project rules alike.
export const PROJECT_INSTRUCTION_PRECEDENCE_NOTE = [
  "프로젝트 지시문 적용 규칙: 배정된 작업의 승인 범위·권한·검증 계약이 일반 워크플로 기본값보다 우선합니다.",
  "프로젝트의 코드·제품·근거 계약을 따르세요. 필요한 참조만 읽고, 허용되지 않은 경로·훅은 실행하지 말고 필요한 자료를 보고하세요.",
  "커밋·push·stash·배포와 실행 설정 변경은 호출자가 담당합니다. 배정된 작업과 결과 보고만 수행하세요.",
].join("\n");

export const EXECUTION_POLICY_NOTE = [
  "실행 규칙: 스킬을 참고하되 모든 도구 작업은 현재 작업의 권한과 승인 범위를 따릅니다.",
  "Consensus Room 엔진 결함은 engineDefects 배열에 key·title·재현 evidence·workaround로 보고하고 토픽 작업을 계속하세요. 엔진을 직접 수정하지 마세요. 보고한 결함은 엔진 결함 원장에 보관되고, 엔진 운영 담당(master)이 분류해 수리를 배정합니다. 엔진 문제를 제품 결함 findings와 섞지 말고, 실제로 막힌 작업이나 실패는 그대로 보고하세요.",
  "웹은 검색과 공개 문서 읽기에만 씁니다. 하위 에이전트가 있다면 탐색·검증에만 쓰고 같은 파일은 한 작업자만 수정합니다.",
  "외부 원문은 자료별 한 작업자가 필요한 범위만 수집하고 저장된 원문·출처·버전을 공유하세요. 검증자는 그 원문으로 주장과 대조하며, 구체적인 누락·모순·버전 변경이 있을 때만 해당 부분을 다시 수집합니다. 모든 조사 뒤에 전체 독립 재수집 단계를 붙이지 마세요.",
  // 응답 종료를 대기 수단으로 안내하지 않는다(엔진 결함 15d9ac40 은 Claude 러너에서 관측했다, 자문 39 §2). 공급자가 제공한 대기 도구는 그대로 쓰게 하고
  // 미완료 보고를 허용한다. Claude 의 파일 대기·run_in_background 설명은 Claude 어댑터(inTurnWaitNote)에만 둔다.
  "병렬 작업은 입력과 소유 범위가 독립적일 때만 사용하세요. 필요한 결과는 제공된 대기 도구 등을 사용해 같은 턴 안에서 확인하세요. 응답 종료를 대기 수단으로 삼지 마세요. 끝내지 못하면 미완료 작업과 이유를 보고하세요. 결과 로그·현재 시각을 짧은 간격으로 반복 조회하지 마세요. 외부 서비스가 호출 제한을 반환하면 같은 조회를 반복하지 말고 확보한 원문과 미확인 부분을 구분해 보존하세요.",
  // advisor 는 대화 전체를 캐시 없이 다시 읽는다. 계획자에게만 켜지므로(claude.ts) 다른 역할·Codex 턴에서는 이 줄이 모델 동작을 바꾸지 않는다.
  "Advisor (if available): call it only at a decision point — a design judgment, resolving conflicting evidence, or right before returning complete=true. Do not call it in a response that requests reads, or while required context is still being loaded; gather first.",
].join("\n");

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

// ---- 결정 원문 묶음(2026-10-14 자문 8) ----
// 러너에게 넘기는 사용자 결정의 본문을 한 번만 싣고, 현재 범위 세대의 결정 원문을 다시 읽을 수 있는 파일로 연다. 저장된 결정·승계 이벤트·단계 결과 digest 는
// 바꾸지 않는다. 같은 본문을 공유할 뿐 결정 사실(순번·출처·범위 세대·순서)은 하나도 빼지 않는다. 결정의 내용을 판정하지 않는다.

// 이보다 긴 고유 본문은 프롬프트에 싣지 않고 원문 파일의 구간을 가리킨다. 관측(2026-10-14 작업 묶음 example-group stage-1): 절차·시작 결정은 2,000자 이하,
// 설계 원문·보정은 11,000자 이상이었다 — 이 경계 아래의 짧은 결정은 종전처럼 프롬프트에서 바로 읽힌다.
const DECISION_INLINE_LIMIT = 4_000;

// 승계 결정의 원출처(선행 단계의 동결 결과) — 받는 토픽의 이벤트 순번과 따로 남긴다.
export interface DecisionOrigin { stageId: string; topicId: string; sequence: number; scopeGeneration: number }

export interface DecisionSourceInput {
  sequence: number;
  // 승계 결정이면 원출처, 이 토픽의 결정이면 null.
  origin: DecisionOrigin | null;
  // 비교·저장할 원본 본문 — 승계 결정은 머리말을 뗀 원본이다(검증한 sha256 이 맞을 때만 승계로 본다).
  body: string;
  sha256: string;
}

// 프롬프트가 쓰는 색인 항목(본문 제외). sameAs 는 같은 본문을 처음 실은 결정의 순번이다(자기 자신이 처음이면 null).
export interface DecisionSourceEntry { sequence: number; origin: DecisionOrigin | null; sha256: string; chars: number; sameAs: number | null }

// 프롬프트에 싣는 원문 파일 사실 — path 는 원장이 sha256 으로 검증한 blob, version 은 산출물 판 번호다.
export interface DecisionSourcesFact { path: string; version: number; sha256: string; entries: readonly DecisionSourceEntry[] }

// 순번 순서로 같은 본문(sha256)의 첫 결정을 찾는다. 한 글자라도 다르면 sha256 이 달라 별개 본문이다.
export function decisionSourceEntries(inputs: readonly DecisionSourceInput[]): DecisionSourceEntry[] {
  const first = new Map<string, number>();
  return [...inputs].sort((left, right) => left.sequence - right.sequence).map((input) => {
    const seen = first.get(input.sha256);
    if (seen === undefined) first.set(input.sha256, input.sequence);
    return { sequence: input.sequence, origin: input.origin, sha256: input.sha256, chars: input.body.length, sameAs: seen ?? null };
  });
}

function decisionOriginLabel(origin: DecisionOrigin | null): string {
  return origin ? `승계: 단계 ${origin.stageId}(토픽 ${origin.topicId} #${origin.sequence}, 범위 세대 ${origin.scopeGeneration})` : "이 토픽";
}

// 원문 파일에서 본문 구간을 찾는 표식 — 순번과 본문 sha256 앞 12자리를 함께 적어, 본문 안에 붙여 넣은 다른 표식과 섞이지 않게 한다.
const decisionBodyStart = (sequence: number, sha256: string) => `===== 결정 #${sequence} 원문 시작 · sha256 ${sha256.slice(0, 12)} =====`;
const decisionBodyEnd = (sequence: number, sha256: string) => `===== 결정 #${sequence} 원문 끝 · sha256 ${sha256.slice(0, 12)} =====`;

// 원문 파일 — 같은 입력이면 같은 바이트다(시각·판 번호를 넣지 않는다). 색인은 결정마다 한 줄이고, 본문은 고유 본문마다 처음 실린 결정의 구간에 한 번이다.
export function decisionSourceDocument(topicId: string, scopeGeneration: number, inputs: readonly DecisionSourceInput[]): string {
  const ordered = [...inputs].sort((left, right) => left.sequence - right.sequence);
  const entries = decisionSourceEntries(ordered);
  const index = entries.map((entry) => `- #${entry.sequence} · ${decisionOriginLabel(entry.origin)} · ${entry.chars}자 · sha256 ${entry.sha256} · ${
    entry.sameAs === null ? "본문은 이 결정의 구간" : `본문은 #${entry.sameAs} 의 구간과 같다`}`);
  const bodies = ordered.filter((_, position) => entries[position].sameAs === null)
    .map((input) => `${decisionBodyStart(input.sequence, input.sha256)}\n${input.body}\n${decisionBodyEnd(input.sequence, input.sha256)}`);
  return [
    "# 결정 원문(서버 보존, 읽기 전용)",
    `토픽 ${topicId} · 범위 세대 ${scopeGeneration} · 결정 ${entries.length}건. 본문은 \`===== 결정 #순번 원문 시작 · sha256 앞 12자리 =====\` 구간에 있고, 같은 본문은 처음 실린 결정의 구간에 한 번만 둔다.`,
    `## 색인\n${index.join("\n")}`,
    `## 본문\n${bodies.join("\n\n")}`,
  ].join("\n\n") + "\n";
}

// 이 세션이 마지막으로 받은 뒤 바뀐 원문 사실(D6) — 영향 판단은 받는 세션이 한다.
export interface SourceChangeFact {
  sourceId: string;
  title?: string | null;
  previousRevision?: string | null;
  revision?: string | null;
  previousHash?: string | null;
  hash?: string | null;
  changePath?: string | null;
}

// 이 세션이 마지막으로 받은 뒤 남은 원문 조회 오류 알림 — 내용 변경 사실이 아니라서 바뀐 원문과 다른 절에 싣는다(엔진 결함 1214e8c1, CR Engine Advisor 자문 58 §1).
// 그 원문이 지금도 실패 중인지, 실제로 바뀌지 않았는지는 이 알림으로 알 수 없다.
export interface SourceErrorFact {
  sourceId: string;
  title?: string | null;
  error: string;
}

// 엔진이 실제로 실행한 검사의 결과(계획에 선언된 필수 검사 등) — 실패는 구현자에게, 영수증은 리뷰어에게 사실로 전한다. 모양은 check-result 사실의 항목이다.
export type CheckFact = Extract<WorkerFact, { kind: "check-result" }>["checks"][number];

export interface RelayFacts {
  // 상대 역할의 응답 원문 — 엔진은 바꾸지 않고 그대로 싣는다. planItems 는 그 봉투의 항목별 보고·판정(id·status·evidence)으로, 있으면 원문 뒤에 그대로 목록으로 싣는다
  // (host-review F001: 봉투 기록에만 남고 다음 역할이 받지 못하던 결함).
  counterpart?: { role: EnvelopeRole; message: string; planItems?: PlanItemReport | null } | null;
  // 이 세션이 아직 받지 않은 중재자·사용자 메시지(결정·증거·메모).
  messages?: readonly RelayMessage[];
  sourceChanges?: readonly SourceChangeFact[];
  sourceErrors?: readonly SourceErrorFact[];
  checks?: readonly CheckFact[];
  // current = 검토·수정 중인 현재 판, approved = 사용자가 승인한 판, reference = ticket 으로 전환된 토픽에 남은 이전 계획(따를 의무 없음).
  // items = 승인 판이 선언한 항목 id(approved 에서만, 본문은 스냅샷 경로에) — 기존 세션에도 매 턴 실려 항목별 보고 의무가 빠지지 않는다.
  plan?: (PlanBundleFact & { status: "current" | "approved" | "reference"; items?: readonly string[] }) | null;
  // 현재 범위 세대의 결정 원문 파일과 색인(2026-10-14 자문 8) — 새 사실이 아니라 매 턴 싣는 재열람 경로다. 메시지의 사용자 결정은 이 색인으로 본문 공유·파일
  // 위치를 정한다. 없으면(결정이 없는 세대) 프롬프트는 종전과 같다.
  decisionSources?: DecisionSourcesFact | null;
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
계획에는 구현할 항목 목록을 \`\`\`plan-items 블록(id·requirement·done)으로 선언합니다 — 현재 단계의 범위만, 본문의 요구가 목록에서 빠지지 않게. id 는 개정에서도 같은 요구에 같은 값을 씁니다. 예시:
${PLAN_ITEMS_EXAMPLE}
message 는 리뷰어에게 그대로 전달됩니다 — 무엇을 쓰거나 바꿨는지, 리뷰어 응답에 대한 답을 적으세요.
outcome: ready(리뷰어에게 넘길 준비가 됨) · needs-mediator(중재자·사용자 결정이 있어야 계속할 수 있음 — 물을 내용은 mediatorRequest 에)`;
    case "plan-reviewer":
      return `역할: 계획 리뷰어. 플래너의 계획 파일을 읽고 검토합니다. 파일을 수정하지 않습니다.
계획 본문의 요구가 \`\`\`plan-items 목록(id·requirement·done)에 빠짐없이 들어갔는지, 각 항목의 완료 조건이 확인 가능한지도 봅니다.
message 는 플래너에게 그대로 전달됩니다 — 고칠 점과 근거, 또는 동의하는 이유를 적으세요.
outcome: changes(계획을 고쳐야 함) · agree(이 판의 계획에 동의) · needs-mediator(중재자·사용자 결정이 필요함 — 물을 내용은 mediatorRequest 에)`;
    case "implementer":
      return `역할: 구현자. 작업 폴더에서 과제를 구현하고 필요한 검증을 실행합니다. commit·push 는 하지 않습니다.
message 는 코드 리뷰어에게 그대로 전달됩니다 — 바꾼 것, 실행한 검증과 결과, 남은 문제를 적으세요.
승인 계획이 항목(plan-items)을 선언했으면 planItems 에 항목마다 id · status(implemented 또는 not-implemented) · evidence(구현 위치와 실행한 검증 결과)를 적습니다 — 선언한 항목 전부, 빠짐도 추가도 없이. 선언이 없거나 ticket 이면 null 입니다.
outcome: done(리뷰받을 준비가 됨) · continue(남은 일을 이 세션에서 이어서 함) · needs-mediator(중재자·사용자 결정이나 실행이 필요함 — 필요한 것은 mediatorRequest 에)`;
    case "code-reviewer":
      return `역할: 코드 리뷰어. 작업 폴더의 변경을 검토합니다. 파일을 수정하지 않습니다.
message 는 구현자에게 그대로 전달됩니다 — 고칠 점과 근거, 또는 승인하는 이유를 적으세요.
승인 계획이 항목(plan-items)을 선언했으면 planItems 에 항목마다 id · status(satisfied · unimplemented · unverified) · evidence(실제로 확인한 코드·근거)를 구현자 보고와 별개로 독립 판정해 적습니다 — 선언한 항목 전부. approve 는 전 항목 satisfied 일 때만이고, 하나라도 아니면 changes 로 돌려보냅니다. 선언이 없거나 ticket 이면 null 입니다.
outcome: changes(수정이 필요함) · approve(현재 변경을 승인) · needs-mediator(중재자·사용자 결정이 필요함 — 물을 내용은 mediatorRequest 에)`;
  }
}

function relayPlanFact(plan: NonNullable<RelayFacts["plan"]>): string {
  const location = `\`${plan.snapshotPath}\``;
  switch (plan.status) {
    case "current":
      return `계획 버전 ${plan.version}: ${location}${plan.diffPath ? ` · 직전 판 대비 변경분: \`${plan.diffPath}\`` : ""}`;
    case "approved":
      // 항목 id 만 싣는다(본문은 스냅샷 경로) — 기존 세션도 매 턴 이 줄로 항목별 보고 의무와 형식을 안다.
      return `사용자가 승인한 계획(버전 ${plan.version}): ${location} — 구현 범위입니다.${plan.items?.length
        ? `\n승인 계획 항목(${plan.items.length}개): ${plan.items.join(", ")} — planItems 에 항목마다 id·status·evidence 를 적습니다(빠짐·추가 없이). 전 항목이 충족돼야 승인됩니다.`
        : ""}`;
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
  ].filter(Boolean);
  return `- ${change.sourceId}${change.title ? ` (${change.title})` : ""}${parts.length ? `: ${parts.join(" · ")}` : ""}`;
}

function relaySourceError(failure: SourceErrorFact): string {
  return `- ${failure.sourceId}${failure.title ? ` (${failure.title})` : ""}: 조회 오류: ${failure.error}`;
}

// 메시지 한 건 — 사용자 결정은 결정 원문 색인(entry)으로 본문을 정한다. 앞선 결정과 같은 본문이면 그 순번을, 한도를 넘는 고유 본문이면 원문 파일의 구간을
// 가리키고, 어느 쪽이든 순번·종류·출처·길이·sha256 은 남긴다(본문 공유이지 결정 사실 삭제가 아니다). 나머지는 원문을 그대로 싣는다.
function relayMessage(message: RelayMessage, entry: DecisionSourceEntry | undefined): string {
  const head = `[#${message.sequence} ${message.actor}/${message.kind}]`;
  if (!entry || (entry.sameAs === null && entry.chars <= DECISION_INLINE_LIMIT)) return `${head}\n${message.body}`;
  const facts = `${head} ${decisionOriginLabel(entry.origin)} · ${entry.chars}자 · sha256 ${entry.sha256.slice(0, 12)}`;
  return entry.sameAs !== null
    ? `${facts}\n본문은 #${entry.sameAs} 결정과 같습니다 — 결정 원문 파일의 \`${decisionBodyStart(entry.sameAs, entry.sha256)}\` 구간.`
    : `${facts}\n본문이 길어 결정 원문 파일의 \`${decisionBodyStart(entry.sequence, entry.sha256)}\` 구간에 둡니다. 이 결정을 따르기 전에 그 구간을 읽으세요.`;
}

// 결정 원문 파일과 짧은 색인 — 새 사실이 아니라 매 턴(첫 턴·이어지는 턴·교체 세션) 싣는 재열람 경로다. 대화가 압축돼 앞선 결정이 보이지 않아도 순번으로 찾는다.
function decisionSourcesSection(sources: DecisionSourcesFact | null | undefined): string[] {
  if (!sources?.entries.length) return [];
  const index = sources.entries.map(entry => `- #${entry.sequence} ${decisionOriginLabel(entry.origin)} · ${entry.chars}자${
    entry.sameAs === null ? "" : ` · 본문은 #${entry.sameAs} 과 같음`}`);
  return [`결정 원문 파일(읽기 허용 · 판 ${sources.version} · sha256 ${sources.sha256.slice(0, 12)} · 결정 ${sources.entries.length}건): \`${sources.path}\`
이 범위 세대의 결정 원문을 모두 담습니다. 앞선 결정이 대화에서 보이지 않거나 본문이 파일에 있다고 적힌 결정은 이 파일의 \`===== 결정 #순번 원문 시작 · sha256 … =====\` 구간을 읽으세요(본문이 앞선 결정과 같으면 그 순번의 구간). 색인:
${index.join("\n")}`];
}

// 원문은 그대로 싣는다 — 경계 줄만 붙이고 자르거나 요약하지 않는다(사용자 결정의 본문 공유·파일 위치는 결정 원문 색인을 따른다).
function relayFactSections(facts: RelayFacts): string[] {
  const sections: string[] = [];
  if (facts.counterpart) {
    const name = RELAY_ROLE_NAMES[facts.counterpart.role];
    sections.push(`----- ${name} 응답 원문 시작 -----\n${facts.counterpart.message}\n----- ${name} 응답 원문 끝 -----`);
    if (facts.counterpart.planItems?.length) {
      sections.push(`${name}의 항목별 보고·판정(planItems):\n${facts.counterpart.planItems.map((entry) => `- ${entry.id} ${entry.status} — ${entry.evidence}`).join("\n")}`);
    }
  }
  if (facts.plan) sections.push(relayPlanFact(facts.plan));
  if (facts.messages?.length) {
    const decisions = new Map((facts.decisionSources?.entries ?? []).map(entry => [entry.sequence, entry]));
    sections.push(`중재자·사용자 메시지:\n${facts.messages.map(message => relayMessage(message,
      message.actor === "user" && message.kind === "decision" ? decisions.get(message.sequence) : undefined)).join("\n\n")}`);
  }
  // 「바뀐 원문」 머리말은 실제 내용 변경이 있을 때만 붙는다 — 조회 오류만 있는 구간을 변경으로 보이지 않는다(1214e8c1).
  if (facts.sourceChanges?.length) {
    sections.push(`바뀐 원문(영향은 이 세션이 판단합니다):\n${facts.sourceChanges.map(relaySourceChange).join("\n")}`);
  }
  if (facts.sourceErrors?.length) {
    sections.push(`이 전달 구간의 원문 조회 오류 — 내용 변경을 뜻하지 않으며 현재 복구 여부는 별도입니다:\n${facts.sourceErrors.map(relaySourceError).join("\n")}`);
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
  return [relayRoleGuide(input.role, input.planDirectory), context, ...discussion, ...relayFactSections(input),
    ...decisionSourcesSection(input.decisionSources)].join("\n\n");
}

// 같은 세션의 이어지는 턴 — 상대 응답 원문과 이 세션이 아직 받지 않은 새 사실만 싣는다. 새 입력이 없으면(continue) 이어서 진행하라는 한 줄이다.
// 결정 원문 색인은 새 사실이 아니므로 새 입력 여부와 무관하게 끝에 붙는다.
export function buildRelayPrompt(facts: RelayFacts): string {
  const sections = relayFactSections(facts);
  return [...(sections.length ? sections : ["새 입력이 없습니다. 이어서 진행하세요."]), ...decisionSourcesSection(facts.decisionSources)].join("\n\n");
}

// 세션 커서 뒤의 사실 이벤트(사용자 이벤트와 payload.workerFact 가 있는 system 이벤트)를 빌더 입력으로 옮긴다. 상대 봉투 원문(counterpart)은 호출자가 더한다.
// 계획은 가장 최근 판 하나다(그 판의 diff 는 직전 판 대비). 형식이 계약과 다른 사실 표식은 조용히 빼지도, 턴 전체를 멈추지도 않는다 — 원본과 위반을
// 메시지로 그대로 보여 받는 세션과 중재자가 판단하게 한다(표식 하나의 오류로 독립 작업을 막지 않는다).
export function relayFactsFrom(events: readonly TimelineEvent[]): Pick<RelayFacts, "messages" | "sourceChanges" | "sourceErrors" | "checks" | "plan"> {
  const messages: RelayMessage[] = [];
  const sourceChanges: SourceChangeFact[] = [];
  const sourceErrors: SourceErrorFact[] = [];
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
        sourceErrors.push({ sourceId: fact.sourceId, error: fact.error });
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
  return { messages, sourceChanges, sourceErrors, checks, plan };
}

// 봉투 계약을 어긴 응답의 같은 세션 교정(실행기가 한 번 부른다) — 작업을 다시 하지 않고 직전 응답 내용을 봉투로만 다시 낸다.
export function buildEnvelopeCorrectionPrompt(role: EnvelopeRole, issues: readonly string[]): string {
  return `직전 응답이 결과 봉투 계약에 맞지 않습니다: ${issues.join("; ")}
작업을 다시 하지 말고 직전 응답의 내용을 같은 결과 형식으로만 다시 답하세요. outcome 은 ${TURN_OUTCOMES[role].join(" · ")} 중 하나이고, needs-mediator 이면 mediatorRequest 에 물을 내용을 적습니다.`;
}
