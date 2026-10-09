import { WorkflowStateSchema, type WorkflowState } from "../shared/contracts.js";
import { bothAgentsAcknowledged } from "../shared/workflow.js";
import { currentStopEvent, RESOURCE_PAUSE_KEYS } from "../shared/workflowLifecycle.js";
import type { ConsensusDatabase, LegacyTopicRow } from "./database.js";
import { PlanBundleError, type PlanBundle } from "./planBundle.js";

// 기존 토픽 이행(CR 흐름 단순화 D9) — 지운 단계(종결·ACK·최종 리뷰·근거 정지)에 머문 토픽을 남는 역할 턴으로 옮기고, 현재 계획을 계획 묶음(plan/plan.md)
// v1 로 옮기고, 작업 묶음에 남은 재계획 대기 표식(⑥ 전 개정)을 풀어 지금 문맥으로 다시 묶는다. 서버 기동 때 프로세스 회수 뒤, 기동 복구(만료 검사 회수·
// running → FAILED + 재개 지점·중재 개입 복원)와 자동 재개 장치(사용 한도 복원·자동 진행·원문 재개) 전에 한 번 부른다.
//  - 옛 저장 형식(지운 상태 문자열)은 이 이행만 읽는다(F6). 토픽은 parse 하지 않은 원시 행으로 읽고, 뒤 단계는 현재 상태만 본다.
//  - 전역 표식은 두지 않는다. 고를 조건(옛 상태·재개 지점, 묶음 없는 현재 계획, 남은 재계획 대기 표식) 자체가 멱등이라 바꿀 것이 없으면 사건도
//    남기지 않는다.
//  - 실행을 시작하지 않는다. 상태가 바뀌거나 표식이 풀린 토픽의 살아 있는 자동 진행은 기존 blocked 상태로 보존하고, 사용 한도 자동 재시도는 복원하지
//    않게 표시하고, 근거 재개 예약은 취소한다(계약 v3.17 (32)). 재개는 중재자의 resume·implement 같은 명시 동작으로만 한다.
//  - 열린 요청·진단·fix 계약·체크포인트·옛 결과는 이력으로 그대로 둔다. 원래 정지 사유는 새 정지 사건 본문에 남긴다.
const LEGACY_RUNNING: ReadonlySet<string> = new Set(["CODEX_CLOSEOUT", "CONSENSUS_ACK", "CODEX_FINAL_REVIEW"]);

export interface WorkflowMigrationResult {
  topicId: string;
  from: { state: string; resumeState: string | null };
  to: { state: WorkflowState; resumeState: WorkflowState | null };
  plan: { version: string | null; migrated: boolean } | { error: string } | null;
}

// 옛 상태·재개 지점의 대응표(D9). 입력은 저장된 기록 문자열이다(지운 상태도 받는다). 바꿀 것이 없으면 null. 옮긴 결과는 현재 상태다.
export function legacyWorkflowTarget(topic: Pick<LegacyTopicRow, "state" | "planSHA256" | "participants">, resumeState: string | null):
  { state: WorkflowState; resumeState: WorkflowState | null; waitingForMediator: boolean } | null {
  let state = topic.state;
  let resume = resumeState;
  // 옛 실행 상태에 남은 토픽은 그 단계를 재개 지점으로 둔 정지로 본다. 남은 running 행동은 이행 뒤의 기동 복구가 마감한다.
  if (LEGACY_RUNNING.has(state)) { resume = state; state = "FAILED"; }
  const waitingForMediator = state === "BLOCKED_ON_EVIDENCE";
  if (waitingForMediator) state = "USER_DECISION_REQUIRED";
  if (resume === "CONSENSUS_ACK") {
    // 현재 계획에 두 참여자가 모두 확인했으면 합의는 끝났다 — 사용자 승인 대기로 옮긴다. 아니면 같은 계획의 리뷰 턴으로 재개한다.
    if (topic.planSHA256 && bothAgentsAcknowledged(topic.participants, topic.planSHA256)) { state = "AWAITING_USER_APPROVAL"; resume = null; }
    else resume = "CODEX_AUDIT";
  } else if (resume === "CODEX_CLOSEOUT") resume = "CODEX_AUDIT";
  else if (resume === "CODEX_FINAL_REVIEW") resume = "CODEX_REVIEW";
  if (state === topic.state && resume === resumeState) return null;
  return { state: WorkflowStateSchema.parse(state), resumeState: resume === null ? null : WorkflowStateSchema.parse(resume), waitingForMediator };
}

export async function migrateLegacyWorkflow(database: ConsensusDatabase, planBundle: Pick<PlanBundle, "migrateLegacyPlan">):
  Promise<WorkflowMigrationResult[]> {
  const results: WorkflowMigrationResult[] = [];
  for (const row of database.legacyMigrationRows()) {
    if (row.state === "CLOSED" || row.topicKind === "group") continue;
    // 파일 쓰기는 transaction 밖에서 먼저 한다 — 멱등이라 끊겨도 다음 기동이 같은 판정을 다시 한다. 폴더에 다른 내용이 있으면 그 토픽만 건너뛴다.
    let plan: WorkflowMigrationResult["plan"] = null;
    if (row.workflowMode === "planned" && row.planSHA256) {
      try { plan = await planBundle.migrateLegacyPlan({ id: row.id, scopeGeneration: row.scopeGeneration, planSHA256: row.planSHA256 }); }
      catch (error) {
        if (!(error instanceof PlanBundleError)) throw error;
        plan = { error: error.message };
      }
    }
    const target = legacyWorkflowTarget(row, row.resumeState);
    const planChanged = plan !== null && ("error" in plan || plan.migrated);
    if (!target && !planChanged) continue;
    // 바꿀 것이 없는(계획 묶음만 옮긴) 토픽은 지금 상태라 그대로 읽는다.
    const to = target ?? { state: database.getTopic(row.id).state, resumeState: database.getFlags(row.id).resumeState ?? null, waitingForMediator: false };
    const timeline = database.getTimeline(row.id);
    const previousStop = currentStopEvent(row, row.resumeState, timeline);
    const reason = row.lastError ?? previousStop?.body ?? "기록 없음";
    const waitingFor = to.waitingForMediator || previousStop?.payload?.waitingFor === "mediator";
    const mediatorRequest = to.waitingForMediator ? reason
      : typeof previousStop?.payload?.mediatorRequest === "string" ? previousStop.payload.mediatorRequest : undefined;
    const moved = target ? `${row.state}${row.resumeState ? `(재개 ${row.resumeState})` : ""} → ${to.state}${to.resumeState ? `(재개 ${to.resumeState})` : ""}` : "상태 변경 없음";
    const planNote = plan && "error" in plan ? ` 계획 묶음 이행을 건너뛰었습니다: ${plan.error}` : plan?.migrated ? ` 현재 계획을 계획 묶음 v1(plan/plan.md, 버전 ${plan.version})로 옮겼습니다.` : "";
    const body = `이행(D9): ${moved}.${planNote}${target ? ` 원래 정지 사유: ${reason}` : ""} 이행은 실행을 시작하지 않습니다 — 중재자의 명시 재개로 잇습니다.`;
    // 상태가 바뀐 토픽의 살아 있는 자동 진행은 기존 blocked 로 보존한다(전이보다 먼저 — 그 사이에 끊겨도 자동 진행이 옛 권한으로 잇지 않는다).
    if (target) holdContinuation(database, row.id, `이행(D9)으로 단계가 바뀌었습니다(${moved}). 확인한 뒤 다시 지정하세요.`);
    database.applyTopicTransition({
      topicId: row.id,
      changes: target ? { state: to.state, resumeState: to.resumeState, ...(to.state === "AWAITING_USER_APPROVAL" ? { lastError: null } : {}) } : {},
      // 상태가 바뀌면 이 사건이 새 재개 지점의 정지 기록이다 — 원래 정지의 중재자 대기와 자원 정지 표식(예산·리뷰 한도 등)을 옮긴다. 원래 정지가 대기에
      // 닿은 행동 표식(waitingCompletedActionId)을 실제로 가졌으면 그대로 옮긴다 — 뒤의 기동 복구가 그 행동을 대기 도달로 마감한다. 계획 묶음만 옮긴
      // 토픽은 재개 지점을 적지 않는다(원래 정지 기록이 현재 정지로 남는다).
      events: [{ actor: "system", kind: "system", state: to.state, body, payload: {
        ...(target && to.resumeState ? { resumeState: to.resumeState } : {}),
        ...(target && previousStop ? Object.fromEntries(RESOURCE_PAUSE_KEYS.filter(key => previousStop.payload?.[key] !== undefined)
          .map(key => [key, previousStop.payload![key]])) : {}),
        ...(target && previousStop?.payload?.waitingCompletedActionId !== undefined
          ? { waitingCompletedActionId: previousStop.payload.waitingCompletedActionId } : {}),
        ...(target && waitingFor && to.state === "USER_DECISION_REQUIRED" ? { waitingFor: "mediator", ...(mediatorRequest ? { mediatorRequest } : {}) } : {}),
        workflowMigration: { from: { state: row.state, resumeState: row.resumeState }, to: { state: to.state, resumeState: to.resumeState }, plan },
      } }],
    });
    if (target) cancelAutomaticResume(database, row.id);
    results.push({ topicId: row.id, from: { state: row.state, resumeState: row.resumeState }, to: { state: to.state, resumeState: to.resumeState }, plan });
  }
  releaseLegacyReplanMarkers(database);
  return results;
}

// ⑥ 전 개정이 남긴 작업 묶음 재계획 대기 표식(Q4) — 표식이 남은 연결을 지금 버전·문맥 해시로 다시 묶고, 그 단계 토픽에 개정 API 와 같은 문맥
// 사실(work-group-revision) 1건을 남긴다. 표식이 막던 단계의 자동 실행 장치는 상태 이행과 같게 멈춘다. 해제·멈춤·사실은 한 transaction 이다 — 그
// 사이에 끊겨도 표식만 풀린 채 자동 진행이 옛 권한으로 잇지 않는다. 토픽 이행 뒤에 부르므로 단계 토픽은 이미 지금 상태다.
function releaseLegacyReplanMarkers(database: ConsensusDatabase): void {
  database.atomicWithEvents(() => {
    const released = database.workGroups.releaseLegacyReplanMarkers().flatMap(({ group, stageIds }) =>
      stageIds.map(stageId => ({ group, stageId, topicId: group.links[stageId].topicId })));
    for (const { group, stageId, topicId } of released) {
      holdContinuation(database, topicId,
        `이행(D9)으로 작업 묶음 재계획 대기 표식을 풀고 이 단계(${stageId}) 문맥을 지금 버전 v${group.version} 으로 다시 묶었습니다. 확인한 뒤 다시 지정하세요.`);
      cancelAutomaticResume(database, topicId);
    }
    return released;
  }, released => released.map(({ group, stageId, topicId }) => ({ topicId, actor: "system" as const, kind: "system" as const,
    state: database.getTopic(topicId).state,
    body: `이행(D9): 작업 묶음 개정이 남긴 재계획 대기 표식을 풀고 이 단계(${stageId}) 문맥을 지금 버전 v${group.version} 으로 다시 묶었습니다. `
      + "지금 단계 문맥 전체를 사실로 전합니다 — 계획 수정·범위 변경은 중재자가 정합니다. 이행은 실행을 시작하지 않습니다.",
    payload: { workerFact: { kind: "work-group-revision", groupId: group.id, stageId, version: group.version,
      context: database.workGroups.renderStageContext(group, stageId) } } })));
}

// 이행이 실행 조건을 바꾼 토픽의 살아 있는 자동 진행은 기존 blocked 로 보존한다 — 이행은 실행을 시작하지 않는다(계약 v3.17 (32)).
function holdContinuation(database: ConsensusDatabase, topicId: string, error: string): void {
  const continuation = database.continuations.get(topicId);
  if (continuation && ["pending", "running"].includes(continuation.status)) database.continuations.save({ ...continuation, status: "blocked", error });
}

// 사용 한도 자동 재시도는 복원하지 않게 표시하고 근거 재개 예약은 취소한다 — 이행이 스스로 실행을 재개하지 않게(새 실패가 오면 그때 다시 판정한다).
function cancelAutomaticResume(database: ConsensusDatabase, topicId: string): void {
  const retry = database.getAutoRetry(topicId);
  database.setAutoRetry(topicId, { attempts: retry?.attempts ?? 0, lastFiredAt: retry?.lastFiredAt ?? null, scheduledAt: null, cancelled: true });
  database.evidence.resumes.cancel(topicId);
}
