import { assertTurnResult, envelopeIssues, envelopeRole, requireEnvelopeRole, turnContract, type EnvelopeRole, type TurnEnvelope, type WorkerFact } from "../../shared/turnContract.js";
import { isTopicGroup } from "../../shared/topicStructure.js";
import {ReviewBlocked} from "../reviewLedger.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { assertEngineRepositoryAvailable } from "../engineRepositoryLock.js";
import {reviewScope} from "../../shared/reviews.js";
import { wrapWorkGroupAdapter } from "../workGroupAdapter.js";
import { BudgetController } from "../budgetController.js";
import { isResumableReviewLedger } from "../planningStore.js";
import { PlanningPaused } from "../../shared/planningControl.js";
import { BudgetBlocked } from "../budgetLedger.js";
// WorkflowEngine 분해(2026-08-31): 상태 전환·세션·산출물·메모리·전달이 한 클래스(1,504줄)에 있어
// 순서 결함이 반복된다는 Codex 진단에 따른 분리. EngineCore는 공유 상태와 횡단 프리미티브만 갖는다 —
// 흐름(계획 수렴·구현 전달)은 PlanningPipeline·DeliveryPipeline이, 공개 API는 WorkflowEngine 파사드가 갖는다.
import { createHash, randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  AgentResultSchema,
  DeferredFindingsSchema,
  type DeferredFinding,
  type AgentExecutionSettings,
  type AgentResult,
  type Participant,
  type TimelineEvent,
  type Topic,
  type WorkflowState,
  type MemoryUpdate,
} from "../../shared/contracts.js";
import { appliedExecutionSettings } from "../../shared/execution.js";
import { type TurnJob } from "../../shared/roles.js";
import { bindingOf, describeBinding, designReadRequested, legacyBinding, resolveRoute, routeSupport, sameBinding, UnsupportedRoute,
  type SessionBinding, type TurnRoute } from "../turnRouting.js";
import {
  assertTransition,
  mergeCorrectionResult,
  salvageResultFields,
  redactSecrets,
  sha256,
} from "../../shared/workflow.js";
import { buildContractCorrectionPrompt, buildEnvelopeCorrectionPrompt } from "../../shared/prompts.js";
import { redactAgentResult, redactRecord, redactUnverifiedResult } from "../security.js";
import type { ActionRecord, AgentAdapter, AppliedMemoryChange, ParticipantRole, TurnUsage } from "../types.js";
import { exceededLimits } from "../adapters/executionMetrics.js";
import { ResponseLimitViolation, UnverifiedAgentResult, isUnverifiedResult, unverifiedResponse, validateAgentResult } from "../adapters/resultParser.js";
import type { WorkflowDependencies } from "../workflow.js";
import { AdmissionRefused, TurnExecutor, type EnvelopeOutcome, type EnvelopeTurnRequest, type TurnPurpose, type WriteGuards } from "./turnExecutor.js";
import { PlanBundle } from "../planBundle.js";
import { HostRuntimeUnavailable } from "../hostRuntime.js";
import { StaleArtifactError } from "../artifacts.js";
import { parseUsageLimit } from "../../shared/usageLimit.js";
import { reportBackgroundFailure, runBackgroundTask } from "../backgroundTask.js";
import { failureResumePoint, isResumePoint, resetCycle } from "../../shared/workflowLifecycle.js";

// 결과 JSON 의 표기만 틀린 위반(스키마·kind). 재제출에 판단이 필요 없어 교정 턴의 추론 강도를 low 로 내린다
// (2026-09-07 Codex 자기 최적화 제안 ③). 쟁점 누락·처분 규칙 위반은 판단이 섞이므로 여기 속하지 않는다.
// 파싱 직후·검사 직전에 결과를 손질하는 함수. carried 가 있으면 enforceResultContract 가 **최종 검사 뒤** 마지막 적용의 승계 id 를
// 턴당 1회 이벤트로 남긴다(2026-09-13 Codex 지적 3: 검사 전에 "재제출 없음" 을 적으면 바로 뒤 교정이 그 기록을 거짓으로 만든다).
export type ResultNormalizer = ((result: AgentResult) => AgentResult) & { carried?: () => readonly string[]; label?: string; beforeMerge?: (result: AgentResult, salvaged?: boolean) => AgentResult };

function normalized(normalize: ResultNormalizer | undefined, result: AgentResult): AgentResult {
  return normalize ? normalize(result) : result;
}

export class FormatViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatViolation";
  }
}

// 표기만 고치면 되는 위반(추론 low 로 교정): 스키마 오류·응답 한도·응답 종류. 처분 판단이 필요한 위반(쟁점 누락 등)은 제외.
export function isFormatOnlyViolation(error: unknown): boolean {
  return error instanceof ZodError || error instanceof ResponseLimitViolation || error instanceof FormatViolation;
}

// 교정 뒤 보존본의 출처 — 병합 교정본(원본의 유효 필드 + 교정 응답), 교정 응답 전체(논의 재제출), 병합 전에 실패한 교정 전 원본,
// 교정 병합 뒤 같은 원장으로 리뷰를 이어 간 계속 진행 응답(한 번 응답, R3 재리뷰2 884).
type CorrectionPreservedKind = "merged" | "correction" | "original" | "continuation";
const CORRECTION_PRESERVED_LABEL: Record<CorrectionPreservedKind, string> = {
  merged: "병합 교정본", correction: "교정 응답", original: "교정 전 원본", continuation: "계속 진행 응답",
};

// 이 턴이 보존할 최신 값과 그 출처(누적본인가)·세션(R3 재리뷰2 F002·F005). core.turn 이 소유해 enforceResultContract 에 넘기고, 새 값을 채택하는 모든 자리
// (계속 진행 응답·계획 교정 적용본·논의 교정·병합본)가 값과 출처·세션을 함께 바꾼다. 보존하는 자리(교정 대기본·교정 뒤 위반)는 이 기록만 읽는다 — 값과 출처를
// 따로 넘기면(raw 와 고정된 출처 인자, catch 의 진입 값) 새 값을 채택한 뒤의 보존이 옛 출처나 옛 값을 적었다.
interface LatestResult { value: AgentResult; accumulated: boolean; kind: CorrectionPreservedKind; sessionId: string }
function adopt(latest: LatestResult, value: AgentResult, accumulated: boolean, kind: CorrectionPreservedKind, sessionId = latest.sessionId): void {
  latest.value = value; latest.accumulated = accumulated; latest.kind = kind; latest.sessionId = sessionId;
}

// core.turn 은 자기가 재개를 소유할 때만 교정 대기본을 쓴다(R3 재리뷰3 F006). 오류 자체가 다른 재개 주인을 밝히면 소유하지 않는다: PlanningPaused 는
// 세션 연속성 정지(TurnExecutor 의 대화 파일 유실·다른 세션 ID 반환, delivery 의 승인 계획 세션 미확인)가, HandledWorkflowInterruption 은 인터럽트
// 상태가 재개를 맡는다.
// 턴이 소유할 때 남기는 정지(R3 재리뷰2 F005) — 한도(예산·리뷰)·실행 허용 거부(사유 무관: 상태를 바꾸는 사유는 pendingRepair 의 계획·근거·새 입력
// 대조가 버리고, 나머지는 환경 사유라 응답이 유효하다)·사용 한도. 사용 한도는 자동 retry 를 거는 판정(usageLimitRetry.consider)과 같은 함수로 가른다 — 같아야
// 남긴 대기본을 그 retry 가 잇는다. 분류 없는 일반 실패(전송)는 남기지 않는다 — 계획 단계·논의에는 죽은 세션을 버리는 출구가 없어 retry 가 같은 실패를
// 되풀이할 수 있다(후속 (아)).
function preservesLatest(error: unknown): boolean {
  if (error instanceof PlanningPaused || error instanceof HandledWorkflowInterruption) return false;
  return error instanceof BudgetBlocked || error instanceof ReviewBlocked || error instanceof AdmissionRefused
    || parseUsageLimit(error instanceof Error ? error.message : String(error)) !== null;
}

// 같은 세션 교정 1회 뒤에도 남은 기계 계약 위반(R3e, 2026-10-07 사용자 결정 "좁힌 안으로 고침"). 상태 전이는 종전대로 FAILED 다 — 이 오류는 그 문구에
// 막힌 것·영향·보존 위치·다음 행동을 싣고, 교정까지 마친 결과(preserved)를 호출자에게 넘긴다. core.turn 은 그것을 교정 대기본으로 보존해 retry 가 턴을
// 다시 사지 않고 같은 세션 교정부터 잇게 한다. 첫 줄은 위반 문구 그대로다. 교정 호출의 전송 실패·실행 허용 거부·정지는 이 오류가 아니다(isFlowControl).
export class ContractCorrectionFailed extends Error {
  constructor(
    readonly violation: string,
    readonly preserved: AgentResult,
    readonly preservedKind: CorrectionPreservedKind,
    readonly stage: WorkflowState,
    readonly job: TurnJob,
    readonly kept: readonly string[],
    cause: unknown,
    // 보존본의 누적 출처(교정 대기본 accumulated) — 던질 때의 기록(LatestResult)에서 온다(R3 재리뷰 F002·재리뷰2 F002).
    readonly accumulated = false,
  ) {
    super(ContractCorrectionFailed.describe(violation, stage, job, kept.length > 0 ? kept.join(" · ") : "없음",
      "중재자가 위반 내용을 확인한 뒤 retry 로 이 단계를 다시 엽니다."), { cause });
    this.name = "ContractCorrectionFailed";
  }

  // core.turn 이 보존본을 교정 대기본으로 남긴 뒤의 문구 — 보존 위치와 다음 행동이 그 기록을 가리킨다(재개 조건은 pendingRepair 와 같다).
  withPending(location: string, sessionId: string): string {
    return ContractCorrectionFailed.describe(this.violation, this.stage, this.job,
      [`${location}(${CORRECTION_PRESERVED_LABEL[this.preservedKind]}, 세션 ${sessionId})`, ...this.kept].join(" · "),
      `새 입력 없이 retry 하면 같은 세션 ${sessionId} 에서 보존한 결과의 교정부터 잇습니다(턴 전체를 다시 사지 않습니다). `
        + "새 결정·증거가 들어오거나 계획·세션이 바뀌면 보존본을 쓰지 않고 턴을 새로 엽니다.");
  }

  private static describe(violation: string, stage: WorkflowState, job: TurnJob, kept: string, next: string): string {
    return [
      violation,
      `막힌 것: ${stage} 단계 ${job.role}/${job.operation} 결과가 같은 세션 교정 1회 뒤에도 기계 계약을 어겼습니다(첫 줄).`,
      "영향: 이 결과를 단계에 반영하지 않았습니다. 자동 교정(1회)은 끝났고 이 실행은 실패로 끝납니다.",
      `보존 위치: ${kept}`,
      `다음 행동: ${next}`,
    ].join("\n");
  }
}

// 계약 검사가 아닌 흐름 제어 — startAction 이 각자의 정지(새 입력·세션 연속성·한도·실행 허용·호스트)로 보낸다. 교정 뒤 위반(FAILED 문구)으로 바꾸지 않는다.
function isFlowControl(error: unknown): boolean {
  return error instanceof HandledWorkflowInterruption || error instanceof PlanningPaused || error instanceof BudgetBlocked
    || error instanceof ReviewBlocked || error instanceof AdmissionRefused || error instanceof HostRuntimeUnavailable;
}

// 교정 응답을 원본의 개별로 유효한 필드 위에 병합한다(호출자의 beforeMerge 포함).
function mergeCorrection(raw: AgentResult, corrected: AgentResult, normalize: ResultNormalizer | undefined): { result: AgentResult; preserved: string[] } {
  // 해소 id 는 원본이 검증 안 된 한 번 응답일 때만 응답 한도로 자른다 — 누적본(여러 응답의 합집합, 저장 계약은 무제한 R02)을 다시 병합할 때 잘라 내면 이미
  // 받아들인 해소 id 를 잃는다(R3 리뷰 F002).
  const salvaged = salvageResultFields(raw, corrected.kind, { limitResolvedIds: isUnverifiedResult(raw) });
  return mergeCorrectionResult(normalize?.beforeMerge?.(salvaged, true) ?? salvaged, normalize?.beforeMerge?.(corrected) ?? corrected);
}

// 원본의 엔진 결함 보고 — 검증 안 된 원본(R3)이면 그 필드가 스키마를 통과할 때만 쓴다. 교정 병합의 재검사에서 원본의 잘못된 필드가 교정 결과를 죽이지 않게.
function originalEngineDefects(raw: AgentResult): AgentResult["engineDefects"] {
  return AgentResultSchema.shape.engineDefects.safeParse((raw as { engineDefects?: unknown }).engineDefects).data;
}

// 유지보수 잠금 소유 증명 — 잠금 파일의 pid·at 을 그대로 제시한 호출만 잠금 아래에서 통과한다(R3-06).
export type MaintenanceLockOwner = { pid: number; at: string };

export class HandledWorkflowInterruption extends Error {
  constructor() {
    super("새 메시지를 반영하기 위해 현재 단계를 멈췄습니다.");
    this.name = "HandledWorkflowInterruption";
  }
}

export function conflict(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// 경로의 기록용 요약(E2b) — 이벤트 payload·사용량 기록에 싣는다. 이벤트 actor·산출물 kind·execution_usage.role 은 좌석 이름 그대로 둔다(과거 기록과 같은 키).
function routeRecord(route: TurnRoute) {
  return { provider: route.provider, participant: route.participant, profileId: route.profileId, basis: route.basis, job: route.job };
}

// 실패 진단이 프롬프트 크기만큼 원장에 들어가는 것을 막는다(감사 최적화 지적: 4~16KB 상한).
function boundedError(message: string): string {
  return message.length <= 16_000 ? message : `${message.slice(0, 16_000)}\n[이하 생략]`;
}

type TransitionInput = Parameters<WorkflowDependencies["database"]["applyTopicTransition"]>[0];
// 행동 시작과 함께 해제할 역할 세션 저장(계약 v3.16 (17')) — 좌석 participant(pending:), 구현 세션(changes), 현재 범위 세대의 코드 리뷰 세션, 계획 연속성.
export type AdmissionRelease = Pick<TransitionInput, "participants" | "releaseCodeReviewSession" | "releaseContinuity" | "reopenEvidence">
  & { changes?: TransitionInput["changes"] };

// 봉투 기록과 같은 transaction 으로 남기는 사실 이벤트(계약 v3.3 (8)) — workerFact 밖의 추가 키는 허용한다.
export interface EnvelopeEvent {
  actor: "system";
  kind: "system";
  body: string;
  payload: { workerFact: WorkerFact } & Record<string, unknown>;
}

// 봉투 기록 뒤의 다음 상태(계약 v3.3 (9)) — state 가 없으면 전이 없이 changes·events 만 같은 transaction 으로 확정한다(v3.2 (3')).
// state 가 USER_DECISION_REQUIRED 이면 message 가 중재자 요청이다(v3.4 (3'')) — changes.resumeState 가 재개 지점이다.
export interface EnvelopeNext {
  state?: WorkflowState;
  message?: string;
  changes?: TransitionInput["changes"];
  events?: EnvelopeEvent[];
}

// AgentResult 턴의 옵션(core.turn) — 결과 계약 검사·교정 사다리·새 입력 인터럽트를 지나는 옛 경로다.
export interface ResultTurnOptions {
  freshSession?: boolean;
  planMode?: boolean;
  check?: (result: AgentResult) => void;
  // 코드 리뷰처럼 계획 participant와 수명이 다른 세션의 저장 책임은 호출자가 갖는다.
  session?: { id: string | null; persist: (sessionId: string) => void };
  // 이 턴에 추가로 읽기를 허용할 경로(주제 plan.md 등).
  readablePaths?: readonly string[];
  // prompt 가 이어 쓰는 세션 기준의 변경분일 때, 과제가 다른 세션으로 가면 쓸 전체 문맥 판(SessionTurn.freshSessionPrompt).
  freshSessionPrompt?: string;
  normalize?: ResultNormalizer;
  repairContextKey?: string;
  writeGuards?: WriteGuards;
}

// 결과 봉투 턴의 옵션(계약 v3 (1)) — resultContract "envelope" 이 이 오버로드를 고른다. session 이 없으면 core.seatSession 이 이어 쓸 세션을 정하고
// 역할별 저장소에 적는다. inputSequence 는 프롬프트에 반영한 마지막 타임라인 sequence 다(기본 지금).
export interface EnvelopeTurnOptions {
  resultContract: "envelope";
  session?: { id: string | null; persist: (sessionId: string) => void };
  freshSessionPrompt?: string;
  readablePaths?: readonly string[];
  planDirectory?: string;
  writeGuards?: WriteGuards;
  inputSequence?: number;
}
export interface EnvelopeTurnResult { envelope: TurnEnvelope; sessionId: string }

// 작업자에게 전할 사용자 입력(계약 v3 (2)) — 그 밖의 새 사실은 payload.workerFact 가 있는 system 이벤트다.
const USER_FACT_KINDS: ReadonlySet<string> = new Set(["note", "evidence", "decision", "scope_change"]);

export class EngineCore {
  readonly active = new Map<string, {
    actionId: string;
    controller: AbortController;
    completion: Promise<void>;
  }>();
  readonly deliveryActive = new Set<string>();
  readonly scopeChangeActive = new Set<string>();
  readonly turnInputSequence = new Map<string, number>();
  // 받았지만 아직 기록(채택)하지 않은 봉투 — 행동(actionId)마다 하나다. recordEnvelope 가 채택하면 비우고, 그 전에 행동이 던지면 startAction 이 원문·세션·역할과
  // 봉투를 돌려준 요청에 고정한 입력 커서를 interrupted-envelope 로 보존한다(79fc4fc5 F008, Codex 297). 반환 순간의 늦은 결과(turnExecutor.settleEnvelope)와
  // 교정 뒤 계약 위반(envelopeTurn)은 각자 보존하고 던지므로 여기 두지 않는다.
  private readonly receivedEnvelopes = new Map<string, { actionId: string; request: EnvelopeTurnRequest; envelope: TurnEnvelope; sessionId: string }>();
  shuttingDown = false;
  // 주제가 FAILED 로 떨어진 직후(원장 마감 뒤) 알린다 — 사용 한도 자동 재시도 예약(engine/usageLimitRetry.ts).
  failureObserver?: (topicId: string, message: string) => void;
  // 새 action 이 시작될 때 알린다 — 그 주제의 예약된 자동 재시도를 취소한다.
  actionObserver?: (topicId: string) => void;
  settledObserver?: () => void;
  private readonly warnedLimits = new Map<string, Set<string>>();
  // 모델 호출의 단일 경계(PLAN §2) — 파이프라인은 adapter 를 직접 부르지 않는다.
  readonly executor: TurnExecutor;
  // 계획 묶음(계약 v3.1 (6)) — 세대 폴더 배치는 ArtifactStore 를 그대로 쓰는 단일 인스턴스다. 계획 왕복·ticket 참고 경로·방식 전환이 함께 쓴다.
  readonly planBundle: PlanBundle;

  constructor(readonly dependencies: WorkflowDependencies) {
    const controller = new BudgetController(dependencies.database.budgets, (cwd, topicId) => {
      const topic = dependencies.database.topicForTurn({ cwd, topicId });
      if (!topic || !this.active.has(topic.id)) throw new Error("집계를 연결할 실행 중 토픽이 없습니다.");
      return {topicId:topic.id,accounts:this.budgetAccounts(topic.id),stage:topic.state};
    }, async(topicId,output)=>{
      await dependencies.artifacts.write(topicId,"interrupted-output",1,JSON.stringify(redactRecord(output as Record<string,unknown>)));
    },Boolean(dependencies.enforceBudgets),dependencies.database.reviews, dependencies.database);
    this.dependencies={...dependencies,
      claude:wrapWorkGroupAdapter(controller.wrap(dependencies.claude),dependencies.database,dependencies.git),
      codex:wrapWorkGroupAdapter(controller.wrap(dependencies.codex),dependencies.database,dependencies.git)};
    this.executor = new TurnExecutor(this);
    this.planBundle = new PlanBundle((topicId, scopeGeneration) => dependencies.artifacts.generationDirectory(topicId, scopeGeneration),
      dependencies.artifacts, dependencies.git, dependencies.database);
  }

  // 지금 토픽 상태를 실행 기대값으로 고정한다 — 실행기가 spawn 직전에 이 값과 현재를 대조한다.
  expectationOf(topic: Topic) {
    return { state: topic.state, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planSHA256: topic.planSHA256 };
  }

  budgetAccounts(topicId: string): string[] {
    const group=this.dependencies.database.workGroups.forTopic(topicId);
    return group?[topicId,group.id]:[topicId];
  }
  assertBudgetAvailable(topicId: string): void {
    if (this.dependencies.enforceBudgets) this.dependencies.database.budgets.assertAvailable(this.budgetAccounts(topicId));
  }

  // 재개가 다시 살 검토 회차가 남았는가(사용자 설정 ReviewLedger). 재작성 원장(RevisionLedger)은 예약하지 않으므로(D8) 보지 않는다 — 보면 예약 없이
  // 남은 옛 한도가 재개를 막는다.
  assertRetryRewriteAvailable(topicId: string): void {
    const stage=this.dependencies.database.getFlags(topicId).resumeState;
    const topic = this.dependencies.database.getTopic(topicId);
    const review=reviewScope(stage??"");
    if(review && !this.heldReviewLedger(stage, topic))this.dependencies.database.reviews.assertAvailable(topicId,review);
  }

  // 재시도가 이어 쓸 코드 리뷰 원장(E3-4c)이 이미 리뷰 1회를 예약해 두었는가 — 가장 최근 원장이 판정 전(open)이거나 판정 아님으로 멈췄고(paused) 그 호출이 spawn 해 예약이 원장에 묶였으며
  // (spawn 뒤에는 spawn 전 실패로도 되돌리지 않는다), 리뷰 종류가 재개 단계와 같고 범위 세대·계획 epoch·계획 SHA 가 지금 주제와 같을 때만 참이다. 그러면
  // 재시도의 읽기·판정 호출은 같은 원장 ID 로 멱등 예약해 새 1회를 쓰지 않으므로 가용 횟수 사전 검사를 건너뛴다. 여기서는 검토 tree·보고판을 보지 않는다 —
  // 실행 경로가 원장 신원을 대조해(openReviewLedger) 달라졌으면 새 원장 ID 로 예약하고, 한도에 닿았으면 ReviewLedger.reserve 가 spawn 전에 막는다. 답변
  // 확인·원장 없는 계약 교정처럼 호출마다 예약하는 턴과 예산 검사도 그대로 막힌다. 예산 강제가 꺼진 구성은 spawn 을 기록하지 않아 이 예외가 적용되지 않는다.
  private heldReviewLedger(stage: string | null | undefined, topic: Topic): boolean {
    const kind = stage === "CODEX_REVIEW" ? "codex-review" : null;
    const ledger = kind ? this.dependencies.database.planning.latestReviewLedger(topic.id) : null;
    return Boolean(ledger && isResumableReviewLedger(ledger) && ledger.spawned && ledger.kind === kind &&
      ledger.scopeGeneration === topic.scopeGeneration && ledger.planEpoch === topic.planEpoch && ledger.planSHA256 === topic.planSHA256);
  }

  // 서버 종료: 새 실행을 막고, 실행 중인 action 을 전부 중단(프로세스 그룹 SIGTERM→SIGKILL 은 runner 몫)한 뒤
  // 각 action 의 원장 마감(cancelled + 주제 FAILED/resume_state)이 끝나기를 기다린다. 그래서 재시작 뒤 startup
  // 회수가 할 일이 없고 retry 가 같은 세션을 resume 한다(2026-09-07 Codex 제안 ②: 종료가 DB 만 닫아 에이전트가 고아가 됨).
  async shutdown(timeoutMs = 15_000): Promise<number> {
    this.shuttingDown = true;
    const pending = [...this.active.values()];
    for (const action of pending) action.controller.abort(new Error("서버 종료로 실행을 중단했습니다."));
    await Promise.race([
      Promise.all(pending.map((action) => action.completion)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
    return pending.length;
  }

  // 종료 중에는 상태를 바꾸는 진입점(retry 의 resetToDraft·transition 포함)이 원장을 건드리기 전에 거부해야 한다.
  assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new Error("서버가 종료 중입니다. 재시작 뒤 다시 요청하세요.");
  }

  // admissionEvents: 행동 시작과 같은 transaction 으로 남길 이벤트(재개 결정문 등, D7) — 시작 전이 이벤트보다 앞에 둔다. 이 행동의 입력 기준점(turnInputSequence)은
  // 그 기록 뒤라서, 함께 남긴 결정을 이 행동이 소비한 입력으로 본다(새 입력 인터럽트가 아니다).
  // admissionRelease: 같은 transaction 에서 해제할 역할 세션(계약 v3.16 (17')) — 사전 검사에 막히면 아무것도 바뀌지 않고, 끊겨도 해제와 기록이 갈라지지 않는다.
  startAction(topicId: string, kind: string, work: (signal: AbortSignal) => Promise<void>, requestedActionId?: string,
    initialTransition?: { to: WorkflowState; message: string }, admissionEvents: TransitionInput["events"] = [], admissionRelease?: AdmissionRelease): string {
    this.assertNotShuttingDown();
    this.assertNoActiveWork(topicId);
    let topic = this.dependencies.database.getTopic(topicId);
    if (isTopicGroup(topic) && !["brainstorm", "brainstorm-plan", "brainstorm-close"].includes(kind)
      && !(kind === "retry" && this.dependencies.database.getFlags(topicId).resumeState === "BRAINSTORMING"))
      throw conflict("관리 주제에서는 실행할 수 없습니다. 말단 주제에서 작업을 시작하세요.");
    const actionId = requestedActionId ?? randomUUID();
    if (this.dependencies.database.getAction(actionId)) throw conflict("같은 Idempotency-Key로 이미 요청한 action입니다.");
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const scopeGeneration = this.dependencies.database.getTopic(topicId).scopeGeneration;
    const record: ActionRecord = {
      id: actionId, topicId, kind, status: "running", createdAt: new Date().toISOString(),
      finishedAt: null, error: null, pid: null, pgid: null,
      processExecutable: null, processCommand: null,
      processStartedAt: null,
    };
    const { changes: releaseChanges, ...release } = admissionRelease ?? {};
    if (initialTransition) {
      assertTransition(topic.state, initialTransition.to);
      topic = this.dependencies.database.applyTopicTransition({ topicId, ...release,
        changes: { ...releaseChanges, state: initialTransition.to, lastError: null, resumeState: null }, startAction: record,
        events: [...admissionEvents, { actor: "system", kind: "system", state: initialTransition.to, body: initialTransition.message,
          payload: { from: topic.state, to: initialTransition.to } }],
      });
    } else if (admissionEvents.length > 0 || admissionRelease) {
      topic = this.dependencies.database.applyTopicTransition({ topicId, ...release, changes: releaseChanges ?? {}, startAction: record, events: admissionEvents });
    } else this.dependencies.database.startAction(record);
    const inputSequence = this.latestSequence(topicId);
    this.active.set(topicId, { actionId, controller, completion });
    // A resumed action may consume stored results without a model turn. Its input
    // watermark starts here, never at the last turn of a previous action.
    this.turnInputSequence.set(topicId, inputSequence);
    void runBackgroundTask(`action:${actionId}`, () => this.dependencies.git.withSignal(controller.signal, async () => {
      try { this.actionObserver?.(topicId); }
      catch (error) { reportBackgroundFailure(`action:${actionId}:admission-observer`, error); }
      try {
        await work(controller.signal);
      } catch (error) {
        await this.preserveReceivedEnvelope(topicId, actionId)
          .catch((preserveError: unknown) => reportBackgroundFailure(`action:${actionId}:preserve-envelope`, preserveError));
        throw error;
      }
      if (!this.isCurrentAction(topicId, actionId, scopeGeneration)) return;
      this.dependencies.database.finishAction(actionId, "succeeded");
    }), (error: unknown) => {
      if (error instanceof PlanningPaused && this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        const topic = this.dependencies.database.getTopic(topicId);
        this.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, topic.state, { planningPause: true }, actionId);
        return;
      }
      if ((error instanceof BudgetBlocked || error instanceof ReviewBlocked) && this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        const topic = this.dependencies.database.getTopic(topicId);
        this.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, topic.state,
          error instanceof ReviewBlocked ? {reviewPause:error.scope} : {budgetPause:true}, actionId);
        return;
      }
      // spawn 직전 실행 허용 거부(계획 변경·유지보수·예산 소진·쓰기 기준 불일치)는 정상 정지다 — 결과는 checkpoint 로 보존됐고 사람이 재개한다.
      // FAILED 로 떨어뜨리면 사용 한도 자동 재시도가 같은 거부를 반복한다(PLAN §2 검증 조건 1).
      // 호스트 실행 파일 고장(리더 node·공급자 CLI, hostRuntime.ts)도 같은 정지다 — 원인·처방이 메시지에 있고, 환경을 고친 뒤 retry 가 같은 단계를 잇는다.
      if ((error instanceof AdmissionRefused || error instanceof HostRuntimeUnavailable) && this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        const topic = this.dependencies.database.getTopic(topicId);
        const reason = error instanceof HostRuntimeUnavailable ? "host-runtime" : error.reason;
        if (topic.state !== "USER_DECISION_REQUIRED") {
          // 예산 소진 거부는 기존 예산 정지와 같은 재개 계약(budgetPause → retry 가 같은 단계를 이어간다, 계획을 다시 만들지 않는다).
          this.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, topic.state,
            { admissionRefused: reason, ...(reason === "budget" ? { budgetPause: true } : {}) }, actionId);
        } else this.dependencies.database.finishAction(actionId, "cancelled", error.message);
        return;
      }
      const cancelled = controller.signal.aborted;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      if (error instanceof HandledWorkflowInterruption) {
        this.dependencies.database.finishAction(actionId, "succeeded");
        return;
      }
      if (!this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        this.dependencies.database.finishAction(actionId, cancelled ? "cancelled" : "failed", message);
        return;
      }
      const failure = this.dependencies.database.finishActionAndFailTopic({
        actionId,
        topicId,
        actionStatus: cancelled ? "cancelled" : "failed",
        error: message,
        expectedScopeGeneration: scopeGeneration,
      });
      if (!failure.topicFailed) this.event(topicId, "system", "system", `실행 요청을 처리하지 못했습니다: ${message} 주제 상태는 그대로 유지했습니다.`);
      if (!cancelled && failure.topicFailed) this.failureObserver?.(topicId, message);
    }, () => {
      if (this.receivedEnvelopes.get(topicId)?.actionId === actionId) this.receivedEnvelopes.delete(topicId);
      if (this.active.get(topicId)?.actionId === actionId) this.active.delete(topicId);
      resolveCompletion();
      this.settledObserver?.();
    });
    return actionId;
  }

  assertNoActiveWork(topicId: string, options: { maintenanceOwner?: MaintenanceLockOwner } = {}): void {
    if (this.active.has(topicId) || this.dependencies.database.runningAction(topicId) ||
        this.deliveryActive.has(topicId) || this.scopeChangeActive.has(topicId)) {
      throw new Error("이 주제에서 이미 실행 중인 작업이 있습니다.");
    }
    this.assertNoMaintenanceLock(options.maintenanceOwner);
    if (this.dependencies.maintenanceLockPath) {
      assertEngineRepositoryAvailable(dirname(this.dependencies.maintenanceLockPath), this.dependencies.database.getTopic(topicId).repositoryPath);
    }
  }

  // 중재자가 도구 트리·서버를 교체하는 동안(next-stop.sh) 새 실행을 시작하지 않는다 — 유휴 확인과 교체 사이의 경쟁을 막는 공유 잠금.
  // 60분이 지나고 소유 PID가 실제로 종료된 잠금만 무시한다. 손상된 소유 기록은 시간만으로 해제하지 않는다.
  // 잠금 **소유자**(잠금 파일의 pid·at 을 그대로 제시한 호출)는 통과한다 — 유지보수 스크립트가 잠금을 쥔 채 마지막에 기준 갱신(rebaseline)을
  // 부르는 종료 절차가 자기 잠금에 막히지 않게(R3-06). 잠금을 조기에 풀어 유휴 확인↔교체 경쟁을 되살리지 않는다.
  assertNoMaintenanceLock(owner?: MaintenanceLockOwner): void {
    const path = this.dependencies.maintenanceLockPath;
    if (!path || !existsSync(path)) return;
    let info: { at?: string; reason?: string; pid?: number } = {};
    try { info = JSON.parse(readFileSync(path, "utf8")) as { at?: string; reason?: string; pid?: number }; } catch { /* 형식 무관 — 파일 존재가 잠금이다 */ }
    const timestamp = info.at ? Date.parse(info.at) : NaN;
    const age = Date.now() - timestamp;
    let deadOwner = false;
    if (Number.isInteger(info.pid) && info.pid! > 1) {
      try { process.kill(info.pid!, 0); }
      catch (error) { deadOwner = (error as NodeJS.ErrnoException).code === "ESRCH"; }
    }
    if (deadOwner && age > 60 * 60 * 1000) return;
    if (owner && typeof info.pid === "number" && info.pid === owner.pid && info.at === owner.at) return;
    throw new Error(`중재자 유지보수 잠금 중입니다(${info.reason ?? "사유 없음"}, ${info.at ?? "시각 없음"}) — 끝난 뒤 다시 시도하세요.`);
  }

  // freshSession: 합의 이력을 물려받지 않는 일회용 세션에서 실행한다. 프롬프트가 판단에 필요한 것을
  // 전부 담고 있는 단계에만 쓴다(계획 전문·감사·타임라인·계약). 이력을 이어받으면 이미 폐기된 이전
  // 개정본까지 매 턴 재전송된다 — 2026-08-31 실측: 개정 11 시점에 턴당 재전송 834,290토큰, 그중
  // StructuredOutput(과거 개정 계획 전문 누적) 695KB. 개정 턴이 15분→45분으로 늘고 429를 두 번 맞았다.
  // 만들어진 세션 ID는 participant에 저장하지 않는다 — 저장하면 다음 단계가 이 세션을 이어받는다.
  // route 는 이 논리 턴의 경로(엔진 개편 E2b) — 좌석(세션 저장 키)·job(역할 정책)·실제 공급자·설정·선택 근거. core.route 로 만든다.
  turn(route: TurnRoute, topic: Topic, prompt: string, signal: AbortSignal, options: EnvelopeTurnOptions): Promise<EnvelopeTurnResult>;
  turn(route: TurnRoute, topic: Topic, prompt: string, signal: AbortSignal, options?: ResultTurnOptions): Promise<AgentResult>;
  turn(route: TurnRoute, topic: Topic, prompt: string, signal: AbortSignal,
    options: ResultTurnOptions | EnvelopeTurnOptions = {}): Promise<AgentResult | EnvelopeTurnResult> {
    return "resultContract" in options ? this.envelopeTurn(route, topic, prompt, signal, options) : this.resultTurn(route, topic, prompt, signal, options);
  }

  // 결과 봉투 턴(계약 v3 (1)·v3.15 (23)(26)(27)) — 새 사실·원문 변경으로 멈추지 않고(실행기 봉투 표식), 봉투 원문을 해석하지 않는다. 기록과 다음 상태는
  // 호출자가 recordEnvelope 로 정한다. 좌석은 계획 왕복(planner·plan-reviewer)만 요구하고, 구현자·코드 리뷰어는 좌석 없이 첫 생성도 연다.
  private async envelopeTurn(route: TurnRoute, topic: Topic, prompt: string, signal: AbortSignal, options: EnvelopeTurnOptions): Promise<EnvelopeTurnResult> {
    const role = requireEnvelopeRole(route.job);
    const participant = role === "planner" || role === "plan-reviewer" ? this.participant(topic, route.seat) : null;
    // 이어 쓸 세션 — 없거나 공급자·참여자 결속이 바뀌었거나 역할 세션 교체(v3.8 (17)) 뒤면 null 이라 새 세션을 연다. 저장된 세션이 유실되면 실행기가 새 세션
    // 없이 멈춘다(v3.7 (14)).
    const resumeSessionId = options.session ? options.session.id : this.seatSession(topic, route);
    // 저장된 세션의 공급자·참여자가 이 경로와 달라 새 세션을 여는 턴이면 이전 세션(id·바인딩)을 sessionRebound 사건으로 한 번 남긴다(E2b 이력) — 조회
    // (seatSession)는 기록하지 않고 실제로 새 세션을 여는 이 턴만 남긴다. 좌석 이름은 세션 저장소다(구현 세션 implementation, 코드 리뷰 세션 code-review,
    // 계획 왕복은 참여자 좌석). 새 세션을 저장하기 전에 실패하면 다음 시도가 다시 남긴다.
    if (!resumeSessionId) {
      const stored = this.storedSeat(topic, route);
      if (stored.sessionId && !stored.sessionId.startsWith("pending:") && !sameBinding(stored.binding, route)) {
        const seat = role === "implementer" ? "implementation" : role === "code-reviewer" ? "code-review" : route.seat;
        this.event(topic.id, "system", "system", `${seat} 세션 ${stored.sessionId}(${describeBinding(stored.binding)})은 이 턴의 경로 ${describeBinding(route)} 와 `
          + "공급자·참여자가 달라 이어 쓰지 않습니다. 새 세션을 엽니다(이전 세션 기록은 이 이벤트에 남깁니다).",
          { sessionRebound: { seat, previous: { sessionId: stored.sessionId, binding: stored.binding }, next: bindingOf(route) } });
      }
    }
    const persist = (sessionId: string) => {
      this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
      if (options.session) options.session.persist(sessionId);
      else this.persistEnvelopeSession(topic, route, role, participant, sessionId);
    };
    // 이 턴을 연 행동 — 수신 알림은 이 행동이 아직 현재일 때만 슬롯에 둔다(이전 행동의 늦은 응답이 새 행동의 슬롯에 들어가지 않게).
    const actionId = this.active.get(topic.id)?.actionId ?? null;
    const request = (session: EnvelopeTurnRequest["session"], text: string, freshSessionPrompt?: string): EnvelopeTurnRequest => {
      const built: EnvelopeTurnRequest = {
        route, topic, signal, purpose: "턴", inputSequence: options.inputSequence ?? this.latestSequence(topic.id), expected: this.expectationOf(topic),
        writeGuards: options.writeGuards, session, prompt: text, freshSessionPrompt, readablePaths: options.readablePaths, planDirectory: options.planDirectory,
        settings: route.settings, onUsage: this.usageObserver(topic.id, route, "턴"),
        // 새 세션은 응답과 함께 저장한다 — 이어 쓴 세션은 CLI 가 다른 id 로 답했을 때만(onSessionCreated) 바뀐다.
        onEnvelope: (outcome: EnvelopeOutcome) => { if (outcome.created) persist(outcome.sessionId); },
        // 운영 사슬 가장 안쪽 래퍼가 알린 수신(cd2876b7 F008) — 바깥 후처리가 던져도 startAction 의 catch 가 이 슬롯을 보존한다.
        onReceived: (received) => this.captureEnvelope(built, actionId, received.envelope, received.sessionId),
      };
      return built;
    };
    // 새 세션에는 전체 문맥 판을 보낸다 — prompt 는 이어 쓰는 세션 기준의 변경분일 수 있다.
    const firstRequest = !resumeSessionId || resumeSessionId.startsWith("pending:")
      ? request({ mode: "create", onSessionCreated: persist }, options.freshSessionPrompt ?? prompt, options.freshSessionPrompt)
      : request({ mode: "resume", sessionId: resumeSessionId, onSessionCreated: persist }, prompt, options.freshSessionPrompt);
    const first = await this.executor.executeEnvelope(firstRequest);
    if (first.envelope) return this.receiveEnvelope(firstRequest, first.envelope, first.sessionId);
    // 봉투 계약 위반 — 답한 세션에 같은 job·같은 경로(리뷰 원장 포함)로 1회 교정한다(v3.5 (11)). 그래도 어기면 원응답을 보존하고 멈춘다(v3.15 (23)).
    const correction = request({ mode: "resume", sessionId: first.sessionId, onSessionCreated: persist },
      buildEnvelopeCorrectionPrompt(role, envelopeIssues(role, first.violation.raw)));
    const corrected = await this.executor.executeEnvelope(correction);
    if (corrected.envelope) return this.receiveEnvelope(correction, corrected.envelope, corrected.sessionId);
    const location = await this.preserveEnvelope(topic, route, "envelope-contract-failure",
      { sessionId: corrected.sessionId, violation: corrected.violation, previousViolation: first.violation }, "교정 뒤에도 결과 봉투 계약을 어긴 응답입니다.");
    throw new Error(`${role} 결과 봉투가 같은 세션 교정 뒤에도 계약을 어겼습니다: ${corrected.violation.message}` +
      (location ? ` — 원응답은 ${location} 에 보존했습니다.` : ""));
  }

  // 정상 수신 — 지금 행동의 수신 슬롯에 둔다. 커서는 이 봉투를 돌려준 요청에 고정한 값이다(응답 뒤 다시 재면 실행 중 들어온 사실을 전달한 것으로 적는다).
  private receiveEnvelope(request: EnvelopeTurnRequest, envelope: TurnEnvelope, sessionId: string): EnvelopeTurnResult {
    const action = this.active.get(request.topic.id);
    if (action) this.receivedEnvelopes.set(request.topic.id, { actionId: action.actionId, request, envelope, sessionId });
    return { envelope, sessionId };
  }

  // 래퍼 후처리 전의 수신(cd2876b7 F008) — 요청을 연 행동이 아직 현재일 때만 같은 슬롯에 두고, 잡았는지 돌려준다(BudgetController 가 같은 봉투를 checkpoint 에
  // 다시 남기지 않게). 던지지 않는다 — 알림이 정상 봉투를 실패로 바꾸지 않는다.
  private captureEnvelope(request: EnvelopeTurnRequest, actionId: string | null, envelope: TurnEnvelope, sessionId: string): boolean {
    try {
      if (!actionId || this.active.get(request.topic.id)?.actionId !== actionId) return false;
      this.receivedEnvelopes.set(request.topic.id, { actionId, request, envelope, sessionId });
      return true;
    } catch {
      return false;
    }
  }

  // 늦은 결과(실행기 settleEnvelope)는 스스로 보존하므로 그 봉투의 슬롯을 비운다 — startAction 의 catch 가 같은 봉투를 또 남기지 않게.
  releaseReceivedEnvelope(topicId: string, envelope: TurnEnvelope): void {
    if (this.receivedEnvelopes.get(topicId)?.envelope === envelope) this.receivedEnvelopes.delete(topicId);
  }

  // 받은 봉투를 기록하기 전에 행동이 던졌다 — 채택하지 않고 원문·세션·역할·입력 커서만 기존 interrupted-envelope 로 남긴다. 다음 상태·재호출은 정하지 않는다.
  private async preserveReceivedEnvelope(topicId: string, actionId: string): Promise<void> {
    const received = this.receivedEnvelopes.get(topicId);
    if (!received || received.actionId !== actionId) return;
    this.receivedEnvelopes.delete(topicId);
    const { request } = received;
    await this.preserveEnvelope(request.topic, request.route, "interrupted-envelope",
      { sessionId: received.sessionId, envelope: received.envelope, inputSequence: request.inputSequence },
      `${request.route.seat} 봉투 결과를 받았지만 기록하기 전에 실행이 멈춰 이 결과는 반영하지 않습니다.`);
  }

  // 봉투 턴이 받은 세션을 역할별 기존 저장소에 적는다 — 섞임 방지 검사는 각 저장 함수가 한다(다른 주제 세션·같은 주제의 다른 좌석 세션).
  private persistEnvelopeSession(topic: Topic, route: TurnRoute, role: EnvelopeRole, participant: Participant | null, sessionId: string): void {
    const database = this.dependencies.database;
    if (role === "implementer") database.setImplementationSession(topic.id, sessionId, bindingOf(route));
    else if (role === "code-reviewer") database.setCodexReviewSession(topic.id, sessionId, bindingOf(route));
    else {
      if (database.participantSessionInUse(topic.id, route.provider, sessionId)) throw new Error("새 에이전트 세션이 다른 주제 세션과 충돌했습니다.");
      database.upsertParticipant(topic.id, { ...participant!, sessionId, acknowledgedPlanSHA256: null }, bindingOf(route));
    }
  }

  private async resultTurn(route: TurnRoute, topic: Topic, prompt: string, signal: AbortSignal, options: ResultTurnOptions = {}): Promise<AgentResult> {
    const { freshSession = false, planMode = false, check } = options;
    const role = route.seat;
    const startedAfter = this.latestSequence(topic.id);
    this.turnInputSequence.set(topic.id, startedAfter);
    const participant = this.participant(topic, role);
    // 좌석 세션은 바인딩(공급자·참여자)이 이 경로와 같을 때만 이어 쓴다 — 다른 공급자 CLI 에 옛 resume id 를 보내지 않는다(E2b).
    // 코드 리뷰처럼 호출자가 세션을 관리하면(options.session) 호출자가 같은 대조를 끝낸 id 를 넘긴다.
    const seatSession = options.session ? null : this.reboundSeatSession(topic, route, participant);
    const resumeSessionId = options.session ? options.session.id : seatSession;
    const onUsage = this.usageObserver(topic.id, route, "턴");
    const evidenceDigest = this.dependencies.database.evidence.topic(topic).digest;
    const pending=await this.pendingRepair(topic.id,topic.state);
    // 교정 대기본은 그 응답을 만든 공급자·참여자의 세션으로만 이어 쓴다(E2b — 배정이 바뀌었으면 다시 실행한다).
    const reuse=pending && pending.role===role && sameBinding(pending.binding, route) && pending.contextKey===(options.repairContextKey??null)
      && (!options.session || options.session.id===pending.sessionId);
    // 이 턴이 보존할 최신 값·출처·세션(R3 재리뷰2) — 응답을 받기 전에는 비어 있고, 비어 있으면 어떤 실패에도 교정 대기본을 쓰지 않는다. 첫 호출 안의 계속
    // 진행(continueDeferredReviews)이 멈춰도 받은 응답이 남도록 응답마다(onResponse) 채택한다.
    let latest: LatestResult | null = null;
    const adoptResponse = (outcome: { sessionId: string; result: AgentResult }) => {
      if (latest) adopt(latest, outcome.result, false, "original", outcome.sessionId);
      else latest = { value: outcome.result, accumulated: false, kind: "original", sessionId: outcome.sessionId };
    };
    // 교정 대기본 — retry 가 같은 세션 교정부터 잇는다(pendingRepair 가 바인딩·단계·세대·계획·근거·새 입력·세션을 대조한다).
    // accumulated: 여러 응답을 합친 누적본(교정 병합본)이라는 출처 표시 — 내용만으로는 한도만 어긴 한 번 응답과 정상 병합본이 둘 다 스키마를 통과해
    // 구분되지 않는다(R3 리뷰 F002). 새 상태가 아니라 기존 기록의 출처 표시이고, 옛 코드는 이 필드를 읽지 않는다(JSON.parse). 값·출처·세션은 기록
    // (LatestResult) 하나에서 읽는다 — 이 턴이 채택한 최신 값과 그 출처다(R3 재리뷰2 F002·F005).
    const keepPending=async(record:LatestResult):Promise<string>=>{
      const revision=this.latestSequence(topic.id)+1;
      await this.writeArtifact(topic,"pending-contract-repair",revision,JSON.stringify({
        role,binding:bindingOf(route),stage:topic.state,scopeGeneration:topic.scopeGeneration,planEpoch:topic.planEpoch,planSHA256:topic.planSHA256,
        participantSessionId:this.participant(this.dependencies.database.getTopic(topic.id),role).sessionId,
        sessionId:record.sessionId,raw:AgentResultSchema.safeParse(record.value).success?redactAgentResult(record.value):redactUnverifiedResult(record.value),
        contextKey:options.repairContextKey??null,startedAfter,evidenceDigest,
        ...(record.accumulated?{accumulated:true}:{}),
      }),signal);
      return `pending-contract-repair#${revision}`;
    };
    // 정지 처리 — 첫 호출(그 안의 계속 진행 포함)과 계약 검사 어디서 멈춰도 같은 규칙(preservesLatest)으로 기록을 남긴다. 보존 쓰기가 늦은·중단된 실행이라
    // 거부되면(writeArtifact 의 accept → StaleArtifactError) 그 거부만 삼키고 원래 오류를 올린다(R3 재리뷰2 (b)). 응답 전 실패(기록 없음)는 쓰지 않는다.
    const stop=async(error:unknown):Promise<never>=>{
      const preserve=async():Promise<string|null>=>{
        if(!latest)return null;
        try { return await keepPending(latest); }
        catch(keepError) { if(keepError instanceof StaleArtifactError)return null; throw keepError; }
      };
      // 교정 뒤에도 위반(R3e) — 교정 전 원본이 아니라 교정까지 마친 결과를 남긴다. 상태 전이는 그대로(FAILED), 문구만 이 기록을 가리킨다.
      if(error instanceof ContractCorrectionFailed) {
        const location=await preserve();
        throw location && latest ? new Error(error.withPending(location,latest.sessionId),{cause:error}) : error;
      }
      if(preservesLatest(error))await preserve();
      throw error;
    };
    if(reuse) {
      // 누적본(교정 병합본)은 저장 계약만, 한 번 응답(원본)은 응답 한도까지 다시 검사한다 — 표시가 없는 옛 기록은 종전대로 한 번 응답이다(R3 리뷰 F002).
      latest={value:pending.accumulated===true?pending.raw:unverifiedResponse(pending.raw),accumulated:pending.accumulated===true,kind:"original",sessionId:pending.sessionId};
      this.event(topic.id,"system","system","저장된 응답의 교정을 같은 세션에서 재개합니다.");
    } else if (freshSession || !resumeSessionId || resumeSessionId.startsWith("pending:")) {
      const created = await this.executor.execute({
        route, topic, signal, purpose: "턴", inputSequence: startedAfter, expected: this.expectationOf(topic),
        writeGuards: options.writeGuards, acceptUnverified: true,
        session: { mode: "create", onSessionCreated: id => {
          this.assertCurrent(topic.id,signal,topic.scopeGeneration,topic.state);
          if (options.session) options.session.persist(id);
          else if (!freshSession) {
            if (this.dependencies.database.participantSessionInUse(topic.id,route.provider,id)) throw new Error("세션 충돌");
            this.dependencies.database.upsertParticipant(topic.id,{...participant,sessionId:id,acknowledgedPlanSHA256:null},bindingOf(route));
          }
        } },
        // 새 세션에는 전체 문맥 판을 보낸다 — 변경분(prompt)은 그것을 계산한 좌석 세션에서만 유효한데, 배정이 바뀌어 새 세션으로 돌리면(reboundSeatSession)
        // 그 세션을 잇지 않는다(E2b, host-review 2fa1309 F-002: 새 검토자가 커서 이전의 결정·계획 문맥 없이 종결을 판단했다).
        prompt: options.freshSessionPrompt ?? prompt, freshSessionPrompt: options.freshSessionPrompt, planMode, readablePaths: options.readablePaths,
        settings: route.settings, onUsage,
        // 결과 교정·새 입력 처리(채택 검사) 전에 저장해야 재시도가 같은 세션을 이어 쓸 수 있다.
        onResponse: (outcome) => {
          adoptResponse(outcome);
          if (options.session) options.session.persist(outcome.sessionId);
          else if (!freshSession) {
            if (this.dependencies.database.participantSessionInUse(topic.id, route.provider, outcome.sessionId)) {
              throw new Error("새 에이전트 세션이 다른 주제 세션과 충돌했습니다.");
            }
            this.dependencies.database.upsertParticipant(topic.id, { ...participant, sessionId: outcome.sessionId, acknowledgedPlanSHA256: null }, bindingOf(route));
          }
        },
      }).catch(stop);
      this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
      latest = { value: created.result, accumulated: false, kind: "original", sessionId: created.sessionId };
    } else {
      const resumed = await this.executor.execute({
        route, topic, signal, purpose: "턴", inputSequence: startedAfter, expected: this.expectationOf(topic),
        writeGuards: options.writeGuards, acceptUnverified: true,
        session: { mode: "resume", sessionId: resumeSessionId, onSessionCreated: id => {
          this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
          if (options.session) options.session.persist(id);
          else {
            if (this.dependencies.database.participantSessionInUse(topic.id, route.provider, id)) throw new Error("세션 충돌");
            this.dependencies.database.upsertParticipant(topic.id, { ...participant, sessionId: id, acknowledgedPlanSHA256: null }, bindingOf(route));
          }
        } },
        prompt, freshSessionPrompt: options.freshSessionPrompt, planMode,
        readablePaths: options.readablePaths, settings: route.settings, onUsage, onResponse: adoptResponse,
      }).catch(stop);
      latest = { value: resumed.result, accumulated: false, kind: "original", sessionId: resumed.sessionId };
    }
    // 이 턴이 받은 응답(진입 값) — 교정 대기본의 기록(latest)은 enforce 가 새 값을 채택할 때마다 바뀐다.
    const result = latest.value;
    this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    if (await this.interruptPreservingResult(topic, role, result, startedAfter, signal)) throw new HandledWorkflowInterruption();
    try {
      const checked = await this.enforceResultContract(route, topic, result, latest.sessionId, {
        signal, planMode, startedAfter, check, readablePaths: options.readablePaths, normalize: options.normalize,
        writeGuards: options.writeGuards, latest,
      });
      this.recordResultDefects(topic.id, checked);
      if(pending)await this.writeArtifact(topic,"pending-contract-repair",this.latestSequence(topic.id)+1,"null",signal);
      return checked;
    } catch(error) {
      return await stop(error);
    }
  }

  async pendingRepair(topicId:string,stage:string):Promise<{
    role:ParticipantRole;binding:SessionBinding;stage:string;scopeGeneration:number;planEpoch:number;planSHA256:string|null;
    participantSessionId:string|null;sessionId:string;raw:AgentResult;contextKey:string|null;startedAfter:number;evidenceDigest:string;accumulated?:boolean;
  }|null> {
    const stored=await this.dependencies.artifacts.readLatest(topicId,"pending-contract-repair");
    if(!stored)return null;
    const pending=JSON.parse(stored);
    if(!pending)return null;
    const topic=this.dependencies.database.getTopic(topicId);
    const evidence=this.dependencies.database.evidence.topic(topic);
    // Records from before evidence binding was introduced cannot prove which sources produced the response.
    if(!evidence.ready || pending.evidenceDigest!==evidence.digest)return null;
    if(pending.stage!==stage || pending.scopeGeneration!==topic.scopeGeneration || pending.planEpoch!==topic.planEpoch
      || pending.planSHA256!==topic.planSHA256 || this.newUserInputSince(topic,pending.startedAfter))return null;
    if(pending.role!=="claude" && pending.role!=="codex")throw new Error("교정 재개 기록의 역할이 올바르지 않습니다.");
    if(this.participant(topic,pending.role).sessionId!==pending.participantSessionId)return null;
    if(typeof pending.sessionId!=="string" || !pending.raw || !Number.isInteger(pending.startedAfter))throw new Error("교정 재개 기록이 올바르지 않습니다.");
    // 바인딩이 없는 옛 기록은 좌석의 기본 공급자가 만든 응답이다(E2b 이전).
    return {...pending,binding:pending.binding ?? legacyBinding(pending.role)};
  }

  // 기계 계약 위반은 작업 실패가 아니라 표기 실패다. 턴을 버리면 그때까지의 작업 비용 전체가 소각되므로
  // (2026-09-01 S1.1: RESOLVED_BY_FIX 금지 하나로 1시간 구현 턴 폐기), 같은 세션에 거부 사유를 돌려주고
  // 한 번만 재제출받는다. 두 번째 위반은 FAILED 경로로 보낸다 — 무한 교정은 다른 종류의 소각이다. 그 위반은 ContractCorrectionFailed 로 던져 교정까지 마친
  // 결과와 보존 위치를 싣는다(R3e) — 호출자가 보존하고, 중재자가 연 retry 가 그 결과의 교정부터 잇는다.
  // route: 원 턴의 경로 — 교정 재제출·계획 교정은 원 턴의 세션을 이어 쓰므로 같은 공급자·설정으로 가고, job 만 교정 작업으로 바꾼다(E2b).
  async enforceResultContract(
    route: TurnRoute,
    topic: Topic,
    raw: AgentResult,
    sessionId: string,
    context: {
      signal: AbortSignal;
      planMode: boolean;
      startedAfter: number;
      check?: (result: AgentResult) => void;
      // 본 턴과 같은 읽기 허용(계획 정본 등) — 교정 턴에서만 권한이 빠지면 "필요하면 읽으라" 고 안내한 파일을 못 읽는다(Codex 후속 지적 7).
      readablePaths?: readonly string[];
      // 파싱 직후·검사 직전에 결과를 손질한다(예: 판단이 끝난 앞 단계 쟁점을 서버가 승계). 교정 재제출의 재파싱에도 같이 적용된다.
      normalize?: ResultNormalizer;
      writeGuards?: WriteGuards;
      // 보존할 최신 값·출처·세션의 기록(core.turn 소유, R3 재리뷰2) — raw 와 같은 값으로 시작해, 새 값을 채택하는 자리마다 함께 바뀐다. 없으면 이 호출의
      // 지역 기록을 쓴다(raw 가 그대로 보존 대상이다).
      latest?: LatestResult;
    },
  ): Promise<AgentResult> {
    const role = route.seat;
    const latest: LatestResult = context.latest ?? { value: raw, accumulated: false, kind: "original", sessionId };
    // 교정 사다리는 원문 변경을 이유로 멈추지 않는다(D6) — 실행 전 검사는 root 원문 승인만 본다(turnExecutor).
    let violation: string;
    let formatOnly = false;
    // 한 번 응답(검증 안 된 응답·저장해 둔 응답)은 어댑터와 같은 검증(응답 한도 포함)을, 여러 턴을 합친 결과는 저장 계약(스키마)만 받는다.
    let staged: AgentResult | undefined;
    let stageError: unknown;
    try {
      staged = normalized(context.normalize, redactAgentResult(isUnverifiedResult(raw) ? validateAgentResult(raw) : AgentResultSchema.parse(raw)));
    } catch (error) {
      stageError = error;
    }
    // 근거 공백의 이연 변환·리뷰 계속 진행 같은 정착 뒤 처리는 없다(D6, ⑥) — 정규화(누적)까지 마친 결과를 그대로 검사한다.
    try {
      if (stageError !== undefined) throw stageError;
      const parsed = staged!;
      assertTurnResult(route.job, parsed);
      context.check?.(parsed);
      this.reportCarriedFindings(topic.id, context.normalize, false);
      return parsed;
    } catch (error) {
      if (error instanceof HandledWorkflowInterruption) throw error;
      formatOnly = isFormatOnlyViolation(error);
      violation = error instanceof Error ? error.message : String(error);
    }
    // 교정 뒤에도 위반이면 FAILED 문구에 적을 보존 위치(R3e).
    const correctionRevision=(this.dependencies.database.latestArtifact(topic.id,"contract-repair-source")?.revision ?? 0)+1;
    const kept: string[] = [`contract-repair-source#${correctionRevision}(${CORRECTION_PRESERVED_LABEL.original})`];
    // 보관은 계약 검증 없이 가린다 — 계약을 어긴 응답을 스키마로 다시 파싱하면 보관에서 죽어 교정에 못 간다(Codex 감사 R08).
    // 세대·계획 sha·상태에 결속해 보관한다 — 교정이 실패하면 재개(delivery.pendingResultOriginal)가 이 원본을 소비한다(F03).
    await this.writeArtifact(topic,"contract-repair-source",correctionRevision,JSON.stringify({
      kind: "contract-repair-source", scopeGeneration: topic.scopeGeneration, planSHA256: topic.planSHA256, state: topic.state,
      original: redactUnverifiedResult(raw),
    }),context.signal);
    this.event(topic.id, "system", "system",
      `기계 계약 위반을 같은 세션에 돌려보내 1회 교정합니다${formatOnly ? "(표기 교정 — 추론 low)" : ""}: ${violation}`);
    // 논의의 재제출도 같은 읽기·팬아웃 금지 정책이다. 일반 검토자 교정 job으로 바꾸면 하위 에이전트 권한이 열린다.
    const discussion = route.job.operation === "brainstorm";
    const constrained = turnContract(route.job).kinds !== null;
    const correctionRoute: TurnRoute = constrained ? route : { ...route, job: { role: route.job.role, operation: "contract-correction" } };
    const settings = route.settings;
    // 실행 허용(새 입력·계획 변경·취소·유지보수·예산·쓰기 기준)은 실행기가 adapter 호출 전과 spawn 직전에 본다(R3-03 → PLAN §2).
    let corrected: AgentResult;
    try {
      ({ result: corrected } = await this.executor.execute({
        route: correctionRoute, topic, signal: context.signal, purpose: "계약 교정 재제출", inputSequence: context.startedAfter,
        expected: { ...this.expectationOf(topic), state: this.dependencies.database.getTopic(topic.id).state },
        writeGuards: context.writeGuards,
        session: { mode: "resume", sessionId },
        prompt: buildContractCorrectionPrompt(violation, turnContract(route.job).kinds),
        planMode: context.planMode, readablePaths: context.readablePaths,
        settings: formatOnly ? { ...settings, effort: "low" } : settings,
      }));
    } catch (error) {
      // 교정 응답 자체가 형식 검사에 걸렸다 — 이 호출은 검증 안 된 응답을 받지 않으므로(acceptUnverified 없음) 실행기가 그대로 던진다. 교정 뒤 위반이고,
      // 병합할 검증된 교정이 없으므로 교정 전 원본을 보존본으로 넘긴다. 그 밖의 실패(전송·허용 거부·정지)는 그대로 올린다.
      if (error instanceof UnverifiedAgentResult) throw this.correctionFailed(route, topic, error, latest, kept);
      throw error;
    }
    this.assertCurrent(topic.id, context.signal, topic.scopeGeneration, this.dependencies.database.getTopic(topic.id).state);
    // 교정 응답은 원본에서 개별로 유효했던 필드(요약·쟁점·증거·요청 결정·상태) 위에 병합한다 — 교정이 거부된 필드만 고치고
    // 나머지를 비워 내면 본 턴의 보고와 미해결 결정 요청이 흐름에서 사라진다(Codex 감사 R01 ②).
    // 위반 시점까지 만든 가장 진전된 결과를 보존본으로 넘긴다(기록) — 병합 전이면 교정 전 원본이다.
    let merged: AgentResult;
    try {
      const parsedCorrection = redactAgentResult(AgentResultSchema.parse(corrected));
      assertTurnResult(route.job, parsedCorrection);
      if (discussion) {
        // 논의는 전체 발언을 재제출한다. 계획·감사용 병합으로 금지한 쟁점을 원본에서 되살리지 않는다.
        adopt(latest, parsedCorrection, false, "correction");
        context.check?.(parsedCorrection);
        return parsedCorrection;
      }
      const combined = mergeCorrection(raw, parsedCorrection, context.normalize);
      if (combined.preserved.length > 0) {
        this.event(topic.id, "system", "system", `계약 교정 재제출에 원본의 유효한 필드를 병합했습니다(서버 보존): ${combined.preserved.join(" · ")}`,
          { correctionPreserved: combined.preserved });
      }
      merged = { ...combined.result, engineDefects: parsedCorrection.engineDefects ?? originalEngineDefects(raw) };
      adopt(latest, merged, true, "merged");
    } catch (error) {
      if (isFlowControl(error)) throw error;
      throw this.correctionFailed(route, topic, error, latest, kept);
    }
    let reparsed: AgentResult;
    try {
      reparsed = normalized(context.normalize, redactAgentResult(AgentResultSchema.parse(merged)));
    } catch (error) {
      if (isFlowControl(error)) throw error;
      throw this.correctionFailed(route, topic, error, latest, kept);
    }
    try {
      assertTurnResult(route.job, reparsed);
      context.check?.(reparsed);
      this.reportCarriedFindings(topic.id, context.normalize, true);
      return reparsed;
    } catch (error) {
      if (isFlowControl(error)) throw error;
      throw this.correctionFailed(route, topic, error, latest, kept);
    }
  }

  // 교정 뒤 위반 — 보존본·출처·라벨은 던질 때의 기록(LatestResult)에서만 읽는다(R3 재리뷰2: 값과 출처를 따로 넘기면 채택한 새 값에 옛 출처가 붙었다).
  private correctionFailed(route: TurnRoute, topic: Topic, error: unknown, latest: LatestResult, kept: readonly string[]): ContractCorrectionFailed {
    return new ContractCorrectionFailed(error instanceof Error ? error.message : String(error), latest.value, latest.kind, topic.state, route.job, kept, error,
      latest.accumulated);
  }

  // 최종 검사를 통과한 결과 기준으로 승계 id 와 실제 교정 여부를 한 번 남긴다 — 절감 측정의 근거(payload.carriedFindings·corrected).
  recordResultDefects(topicId: string, result: Pick<AgentResult, "engineDefects">): void {
    for (const defect of result.engineDefects ?? []) {
      const key = createHash("sha256").update(JSON.stringify(defect)).digest("hex");
      this.dependencies.database.engineDefects.enqueue(topicId, { ...defect, key });
    }
  }

  private reportCarriedFindings(topicId: string, normalize: ResultNormalizer | undefined, corrected: boolean): void {
    const carried = normalize?.carried?.() ?? [];
    if (carried.length === 0) return;
    const label = normalize?.label ?? "결과 계약";
    this.event(topicId, "system", "system",
      `${label}: 판단이 끝난 앞 단계 쟁점 ${carried.length}건을 서버가 같은 처분으로 승계했습니다(계약 교정 재제출 ${corrected ? "1회 뒤 확정" : "없음"}): ${carried.join(", ")}`,
      { carriedFindings: [...carried], label, corrected });
  }

  // 논리 턴의 경로(엔진 개편 E2b) — 역할 배정·프로필로 실제 공급자와 설정을 정하고(turnRouting.ts), 세션 저장·원장·모델 실행 같은 부수효과 전에
  // 지원 여부를 판정한다. 지원하지 않는 조합(Claude 읽기 턴 팬아웃·Codex Figma 관측)과 프로필 없는·잘못된 배정은 구체적 사유로 멈춘다(재시도해도 같으므로
  // FAILED 가 아니라 결정 대기). 설정: 기본 배정은 주제의 공급자 설정(구현자 job 이면 구현 전용 모델 — adversarial 계획 왕복은 fable, 구현은 opus 라는
  // 사용자 관행의 실행 지점, 2026-08-31), 배정은 프로필의 모델·강도.
  route(topic: Topic, job: TurnJob): TurnRoute {
    try {
      const route = resolveRoute(this.dependencies.database, topic, job);
      // withEvidence가 구현 턴에 붙이는 Figma 요구를 브랜치·세션 생성 전에도 판정한다(실행기의 마지막 판정과 같은 식 — designReadRequested).
      const reason = routeSupport(route, designReadRequested(this.dependencies.database, topic.id, job));
      if (reason) {
        throw new UnsupportedRoute(`${reason} — ${job.role}/${job.operation} 이(가) ${describeBinding(route)} 로 배정돼 있습니다. 배정을 바꾸거나 지원되는 공급자로 되돌린 뒤 재개하세요.`,
          { job, provider: route.provider, basis: route.basis });
      }
      return route;
    } catch (error) {
      if (!(error instanceof UnsupportedRoute)) throw error;
      this.event(topic.id, "system", "system", error.message,
        { admissionRefused: "unsupported-route", job, provider: error.detail.provider ?? null, basis: error.detail.basis ?? null });
      throw new AdmissionRefused("unsupported-route", error.message);
    }
  }

  // 좌석 세션을 이 경로로 이어 쓸 수 있으면 그 id, 아니면 null(새 세션). 바인딩이 다르면 이전 세션(id·공급자·근거)을 이벤트로 남기고 새 세션을 연다 —
  // 행·승인 이력·사용량은 지우지 않는다. 작성자 좌석의 계획 연속성 정책(계획→개정→구현이 한 세션)에서는 새 세션으로 끊지 않고 모델 실행 전에 멈춘다.
  reboundSeatSession(topic: Topic, route: TurnRoute, participant: Participant): string | null {
    const sessionId = participant.sessionId;
    if (!sessionId || sessionId.startsWith("pending:")) return sessionId;
    return this.boundSession(topic, route, sessionId, this.dependencies.database.participantBinding(topic.id, route.seat) ?? legacyBinding(route.seat), true);
  }

  // 봉투 턴이 이어 쓸 역할 세션(계약 v3 (5)) — 없거나 새 세션을 열어야 하면 null. 계획 왕복은 좌석 세션(reboundSeatSession 과 같은 판정), 구현자는 구현 세션,
  // 코드 리뷰어는 현재 코드 리뷰 세션이다. 저장된 세션의 공급자·참여자가 이 경로와 다르면 null 이고, 작성자 좌석의 계획 연속성 정책이면 새 세션 없이 멈춘다.
  // 조회만 한다 — 바인딩이 달라 새 세션을 연다는 기록은 실제로 새 세션을 여는 턴이 남긴다.
  seatSession(topic: Topic, route: TurnRoute): string | null {
    const stored = this.storedSeat(topic, route);
    if (!stored.sessionId || stored.sessionId.startsWith("pending:")) return null;
    return this.boundSession(topic, route, stored.sessionId, stored.binding, false);
  }

  // 봉투 턴 역할의 저장된 세션과 그 바인딩 — 조회(seatSession)와 새 세션을 여는 턴의 재결속 기록(envelopeTurn)이 같은 값을 읽는다.
  private storedSeat(topic: Topic, route: TurnRoute): { sessionId: string | null; binding: SessionBinding } {
    const database = this.dependencies.database;
    const role = envelopeRole(route.job);
    return role === "implementer"
      ? { sessionId: database.getFlags(topic.id).implementationSessionId, binding: database.implementationSessionBinding(topic.id) ?? legacyBinding("claude") }
      : role === "code-reviewer"
        ? { sessionId: database.getCodexReviewSession(topic.id), binding: database.codexReviewSessionBinding(topic.id) ?? legacyBinding("codex") }
        : { sessionId: this.participant(topic, route.seat).sessionId, binding: database.participantBinding(topic.id, route.seat) ?? legacyBinding(route.seat) };
  }

  // 저장된 세션을 이 경로로 이어 쓸 수 있는가 — 바인딩이 같으면 그 id, 다르면 null(recordRebound 면 이전 세션을 이벤트로 남긴다). 작성자 좌석의 계획
  // 연속성 정책은 한 세션을 이어 써야 하므로 새 세션 대신 멈춘다.
  private boundSession(topic: Topic, route: TurnRoute, sessionId: string, stored: SessionBinding, recordRebound: boolean): string | null {
    if (sameBinding(stored, route)) return sessionId;
    const message = `${route.seat} 좌석의 세션 ${sessionId}(${describeBinding(stored)})은 이 턴의 경로 ${describeBinding(route)} 와 공급자·참여자가 달라 이어 쓰지 않습니다.`;
    if (route.seat === "claude" && this.dependencies.database.planning.continuityEnabled(topic.id)) {
      this.event(topic.id, "system", "system", `${message} 계획 연속성 정책은 한 세션을 이어 써야 해서 새 세션을 열지 않고 멈춥니다 — 배정을 되돌리거나 연속성 정책을 끈 뒤 재개하세요.`,
        { admissionRefused: "session-binding", seat: route.seat, previous: { sessionId, binding: stored }, next: bindingOf(route) });
      throw new AdmissionRefused("session-binding", `${message} 계획 연속성 정책에서는 새 세션으로 바꾸지 않습니다.`);
    }
    if (recordRebound) this.event(topic.id, "system", "system", `${message} 새 세션을 엽니다(이전 세션 기록은 이 이벤트에 남깁니다).`,
      { sessionRebound: { seat: route.seat, previous: { sessionId, binding: stored }, next: bindingOf(route) } });
    return null;
  }

  // 역할 세션이 아직 받지 않은 새 사실(계약 v3 (2)). since 는 같은 범위 세대·역할·세션의 마지막 봉투 기록이 전달한 지점이다. 그 기록이 없으면 옛 커서
  // (구현 세션의 implementationPromptSequence, 코드 리뷰 세션의 prompt_sequence)를 잇고, 그것도 없거나 세션이 없으면(새 세션) 0 이다. facts 는 since 뒤의
  // 사용자 입력과 workerFact 표식이 있는 system 이벤트, through 는 지금 마지막 sequence 다 — 호출자는 이 값을 recordEnvelope 의 deliveredThrough 로 넘긴다.
  pendingFacts(topic: Topic, role: EnvelopeRole, sessionId: string | null): { facts: TimelineEvent[]; through: number; since: number } {
    const through = this.latestSequence(topic.id);
    const timeline = this.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration);
    const since = sessionId === null ? 0 : this.deliveredThrough(topic, role, sessionId, timeline);
    const facts = timeline.filter((event) => event.sequence > since && event.sequence <= through &&
      ((event.actor === "user" && USER_FACT_KINDS.has(event.kind)) || (event.actor === "system" && event.payload?.workerFact !== undefined)));
    return { facts, through, since };
  }

  private deliveredThrough(topic: Topic, role: EnvelopeRole, sessionId: string, timeline: readonly TimelineEvent[]): number {
    const recorded = timeline.findLast((event) => event.kind === "agent_output" && event.payload?.sessionId === sessionId &&
      (event.payload?.envelope as { role?: unknown } | undefined)?.role === role)?.payload?.deliveredThrough;
    if (typeof recorded === "number") return recorded;
    const database = this.dependencies.database;
    const flags = database.getFlags(topic.id);
    if (role === "implementer" && flags.implementationSessionId === sessionId) return flags.implementationPromptSequence ?? 0;
    if (role === "code-reviewer" && database.getCodexReviewSession(topic.id) === sessionId) return database.getCodexReviewPromptSequence(topic.id) ?? 0;
    return 0;
  }

  // 봉투 결과 기록(계약 v3 (3)·(3')·(3'')) — 받은 봉투 하나를 agent_output 으로 남기고 다음 상태(next)를 같은 transaction 으로 확정한다. message 는 원문 그대로
  // body 에 둔다(엔진은 해석·요약하지 않는다). 메모리 반영은 현재 실행 확인 뒤에만 한다 — 버려질 응답이 메모리만 바꾸지 않게(saveAgentOutput 과 같은 이유).
  // 확인과 transaction 사이에는 await 가 없다.
  async recordEnvelope(topic: Topic, route: TurnRoute, envelope: TurnEnvelope,
    record: { sessionId: string; deliveredThrough: number; next?: EnvelopeNext }, signal: AbortSignal): Promise<TimelineEvent> {
    const role = envelopeRole(route.job);
    if (!role) throw new Error(`${route.job.role}/${route.job.operation} 작업에는 결과 봉투가 없습니다.`);
    const issues = envelopeIssues(role, envelope);
    if (issues.length > 0) throw new Error(`${role} 결과 봉투가 계약을 어겨 기록하지 않습니다: ${issues.join("; ")}`);
    if (!Number.isInteger(record.deliveredThrough) || record.deliveredThrough < 0 || record.deliveredThrough > this.latestSequence(topic.id)) {
      throw new Error(`전달 커서(${record.deliveredThrough})가 이 토픽의 기록 범위 밖입니다.`);
    }
    this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    const updates = envelope.memoryUpdates ?? [];
    if (updates.length > 0 && !this.dependencies.memory) throw new Error("에이전트가 메모리 변경을 제안했지만 중앙 메모리 저장소가 연결되지 않았습니다.");
    const memoryChanges = updates.length > 0 ? await this.applyMemoryUpdates(route.provider, updates) : [];
    this.recordResultDefects(topic.id, envelope);
    this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    const next = record.next ?? {};
    const events: TransitionInput["events"] = [{ actor: route.seat, kind: "agent_output", state: topic.state, body: envelope.message, payload: {
      envelope: { role, outcome: envelope.outcome, ...(envelope.mediatorRequest ? { mediatorRequest: envelope.mediatorRequest } : {}),
        ...(envelope.engineDefects?.length ? { engineDefects: envelope.engineDefects } : {}) },
      sessionId: record.sessionId, deliveredThrough: record.deliveredThrough, route: routeRecord(route), memoryChanges,
    } }];
    let changes: TransitionInput["changes"] = { ...(next.changes ?? {}) };
    if (next.state === "USER_DECISION_REQUIRED") {
      const request = next.message ?? envelope.mediatorRequest ?? envelope.message;
      const { resumeState, ...rest } = next.changes ?? {};
      const stop = this.stopTransition(topic, "USER_DECISION_REQUIRED", request, resumeState ?? topic.state, { waitingFor: "mediator", mediatorRequest: request });
      changes = { ...rest, ...stop.changes };
      events.push(stop.event);
    } else if (next.state) {
      assertTransition(topic.state, next.state);
      changes = { lastError: null, resumeState: null, ...(next.changes ?? {}), state: next.state };
      events.push({ actor: "system", kind: "system", state: next.state, body: next.message ?? `${topic.state} → ${next.state}`, payload: { from: topic.state, to: next.state } });
    } else if (next.message) {
      events.push({ actor: "system", kind: "system", state: topic.state, body: next.message, payload: {} });
    }
    for (const event of next.events ?? []) events.push({ ...event, state: next.state ?? topic.state });
    const before = this.latestSequence(topic.id);
    this.dependencies.database.applyTopicTransition({ topicId: topic.id, changes, events });
    if (this.receivedEnvelopes.get(topic.id)?.envelope === envelope) this.receivedEnvelopes.delete(topic.id);
    const recorded = this.dependencies.database.getTimeline(topic.id, before).find((event) => event.kind === "agent_output");
    if (!recorded) throw new Error("봉투 기록을 찾을 수 없습니다.");
    return recorded;
  }

  adapter(provider: ParticipantRole): AgentAdapter {
    return provider === "claude" ? this.dependencies.claude : this.dependencies.codex;
  }

  participant(topic: Topic, role: ParticipantRole): Participant {
    const participant = topic.participants.find((item) => item.role === role);
    if (!participant) throw new Error(`${role} 세션을 먼저 연결하세요.`);
    return participant;
  }

  requireParticipants(topic: Topic): void {
    this.participant(topic, "claude");
    this.participant(topic, "codex");
  }

  requireState(topicId: string, expected: WorkflowState): Topic {
    const topic = this.dependencies.database.getTopic(topicId);
    if (topic.state !== expected) throw new Error(`현재 상태는 ${topic.state}이며 ${expected} 단계가 아닙니다.`);
    return topic;
  }

  transition(topicId: string, to: WorkflowState, message: string): Topic {
    return this.transitionWith(topicId, to, message);
  }

  // 상태 전이를 필드 변경·전달 해소·추가 이벤트와 **한 transaction** 으로 — 전이가 중간에 끊겨 갈라지지 않게(2026-09-15 감사 2차).
  // 이벤트의 비밀값 가림은 DB 저장 경계가 한다.
  transitionWith(topicId: string, to: WorkflowState, message: string, extras: {
    changes?: TransitionInput["changes"]; payload?: Record<string, unknown>; events?: TransitionInput["events"];
    deliveryResolution?: TransitionInput["deliveryResolution"];
  } = {}): Topic {
    const topic = this.dependencies.database.getTopic(topicId);
    assertTransition(topic.state, to);
    return this.dependencies.database.applyTopicTransition({
      topicId, changes: { state: to, lastError: null, resumeState: null, ...(extras.changes ?? {}) },
      deliveryResolution: extras.deliveryResolution,
      events: [{ actor: "system", kind: "system", state: to, body: message, payload: { from: topic.state, to, ...(extras.payload ?? {}) } }, ...(extras.events ?? [])],
    });
  }

  interrupt(
    topicId: string,
    state: "USER_DECISION_REQUIRED",
    message: string,
    resumeState: WorkflowState,
    payload: Record<string, unknown> = {},
    actionId?: string,
    // 정지와 같은 transaction 으로 남길 사실 — 봉투 기록(recordEnvelope)처럼 정지 사건 뒤에 그 상태로 싣는다.
    events: readonly EnvelopeEvent[] = [],
  ): void {
    const stop = this.stopTransition(this.dependencies.database.getTopic(topicId), state, message, resumeState, payload, actionId);
    this.dependencies.database.applyTopicTransition({ topicId, changes: stop.changes,
      ...(actionId ? { finishAction: { id: actionId, status: "cancelled", error: message } } : {}),
      events: [stop.event, ...events.map((event) => ({ ...event, state }))],
    });
  }

  // 정지 전이의 변경과 정지 이벤트 — interrupt 와 봉투 기록의 중재자 정지가 같은 모양(재개 지점·대기 실행)을 남긴다. retry·재개 정보가 이 이벤트의
  // payload.resumeState 로 정지를 찾는다(currentStopEvent).
  private stopTransition(topic: Topic, state: "USER_DECISION_REQUIRED", message: string, resumeState: WorkflowState,
    payload: Record<string, unknown>, actionId?: string): { changes: TransitionInput["changes"]; event: TransitionInput["events"][number] } {
    if (topic.state !== state) assertTransition(topic.state, state);
    const resume = failureResumePoint(resumeState, this.dependencies.database.getFlags(topic.id).resumeState ?? null);
    if (!isResumePoint(resume)) throw new Error("중단 기록에는 실제 재개 단계를 지정해야 합니다.");
    return {
      changes: { state, resumeState: resume, lastError: boundedError(redactSecrets(message)) },
      event: { actor: "system", kind: "system", state, body: message, payload: { ...payload, resumeState: resume,
        waitingCompletedActionId: actionId ?? this.active.get(topic.id)?.actionId } },
    };
  }

  resetToDraft(topic: Topic, message: string): void {
    this.dependencies.database.applyTopicTransition({ topicId: topic.id, changes: {
      state: "DRAFT", planRevision: 0, planEpoch: topic.planEpoch + 1,
      planSHA256: null, approvedPlanSHA256: null, lastError: null,
      ...resetCycle("plan"), resumeState: null,
    }, clearAcknowledgements: true, events: [{ actor: "system", kind: "system", state: "DRAFT", body: message,
      payload: { scopeGeneration: topic.scopeGeneration, replanConsumedThrough: this.dependencies.database.getTimeline(topic.id).at(-1)?.sequence ?? 0 } }] });
  }

  async stopIfRunning(topicId: string): Promise<void> {
    const running = this.active.get(topicId);
    if (!running) return;
    running.controller.abort(new Error("범위가 변경되어 기존 실행을 중단했습니다."));
    // The DB row must remain running until the process group has really exited.
    // Otherwise a server crash in the SIGTERM→SIGKILL window cannot recover it.
    await running.completion;
  }

  assertCurrent(topicId: string, signal: AbortSignal, scopeGeneration: number, expectedState: WorkflowState): void {
    if (signal.aborted) throw signal.reason ?? new Error("실행이 취소되었습니다.");
    const active = this.active.get(topicId);
    const topic = this.dependencies.database.getTopic(topicId);
    if (!active || active.controller.signal !== signal || topic.scopeGeneration !== scopeGeneration || topic.state !== expectedState) {
      throw new Error("이전 실행의 늦은 응답을 버렸습니다.");
    }
    // 작업 묶음 단계의 문맥 결속(E4) — 실행기가 spawn 직전과 응답 처리 때 이 함수로 대조한다. 문맥이 바뀌었으면 새 턴을 열지 않는다.
    this.dependencies.database.workGroups.assertStageContextCurrent(topicId);
  }

  isCurrentAction(topicId: string, actionId: string, scopeGeneration: number): boolean {
    return this.active.get(topicId)?.actionId === actionId &&
      this.dependencies.database.getTopic(topicId).scopeGeneration === scopeGeneration;
  }

  processObserver(topicId: string) {
    return (process: {
      pid: number;
      pgid: number;
      executable: string;
      commandLine: string;
      startedAt: string;
    }) => {
      const action = this.active.get(topicId);
      if (!action) throw new Error("CLI가 시작됐지만 연결할 action이 없습니다.");
      this.dependencies.database.recordActionProcess(action.actionId, process);
    };
  }

  // 턴이 쓴 토큰·시간을 타임라인에 남긴다(2026-09-07 Codex 자기 최적화 제안 ④). 이벤트의 state 열이 단계를
  // 가리키므로 단계별 집계는 SQL 로 한다. payload.usage 가 있는 이벤트는 getPromptTimeline 이 걸러 프롬프트에
  // 들어가지 않는다 — 사용량 줄이 에이전트에게 되돌아가면 그 자체가 새 입력 비용이다.
  // by: 경로(좌석 + 실제 공급자·근거) 또는 좌석. role 열은 좌석, 실제 공급자·근거는 사용량 기록의 route 로 남는다(E2b).
  usageObserver(topicId: string, by: TurnRoute | ParticipantRole, phase: TurnPurpose) {
    const role = typeof by === "string" ? by : by.seat;
    const route = typeof by === "string" ? undefined : routeRecord(by);
    const generation = this.dependencies.database.getTopic(topicId).scopeGeneration;
    const fallbackExecutionId = randomUUID();
    return (observation: TurnUsage) => {
      const usage = { ...observation, executionId: observation.executionId ?? fallbackExecutionId,
        recordKind: observation.recordKind ?? "final" as const, phase, ...(route ? { route } : {}) };
      const tokens = (count: number | undefined) => count === undefined ? "관측 안 됨" : count.toLocaleString("en-US");
      const seconds = (ms: number | undefined) => Math.round((ms ?? 0) / 1000);
      const cost = usage.costUSD === undefined ? "" : ` · $${usage.costUSD.toFixed(2)}`;
      // 총 시간은 CLI 실행 전체다. 도구 창(러너 측정)과 API 시간(claude CLI 측정)을 따로 적어야 모델 속도를 도구·빌드 시간과
      // 구분해 비교할 수 있다(2026-09-08 Codex 지적 — 이전의 '출력 tok/s' 비교는 총 시간 기준이라 도구 시간이 섞였다).
      const split = usage.toolDurationMs === undefined
        ? ""
        : ` · 도구 ${seconds(usage.toolDurationMs)}초(${usage.toolCalls ?? 0}회) · 모델+대기 ${seconds(Math.max(0, (usage.durationMs ?? 0) - usage.toolDurationMs))}초`;
      const api = usage.apiDurationMs === undefined ? "" : ` · API ${seconds(usage.apiDurationMs)}초`;
      const body = `${role} ${phase} 최종 사용량 — 입력 ${tokens(usage.inputTokens)}(캐시 ${tokens(usage.cachedInputTokens)}) · ` +
        `출력 ${tokens(usage.outputTokens)} 토큰 · ${seconds(usage.durationMs)}초${split}${api}${cost}${usage.model ? ` · 모델 ${usage.model}` : ""}${usage.completeness === "partial" ? " · 부분 관측" : ""}${usage.sourceUsage?.status === "mismatch" ? " · 원본 간 사용량 불일치" : ""}`;
      if (!this.dependencies.database.saveExecutionUsage(topicId, generation, role, phase, usage,
        usage.recordKind === "final" ? { body: redactSecrets(body), payload: redactRecord({ usage }) } : undefined)) return;
      // 이전 세대에서 늦게 종료된 관측은 보존하되 새 세대의 원장에 알리지 않는다.
      if (this.dependencies.database.getTopic(topicId).scopeGeneration !== generation) {
        this.warnedLimits.delete(usage.executionId);
        return;
      }
      const executionId = usage.executionId ?? `${topicId}:${role}:${phase}`;
      const warned = this.warnedLimits.get(executionId) ?? new Set<string>();
      this.warnedLimits.set(executionId, warned);
      for (const warning of exceededLimits(usage, this.dependencies.executionLimits ?? {})) {
        if (warned.has(warning.key)) continue;
        warned.add(warning.key);
        this.event(topicId, "system", "system", `${role} ${phase} 실행 한도 경고 — ${warning.key} ${warning.value} / ${warning.limit}${warning.timing === "completion" ? " (완료 시 평가)" : ""}`, {
          executionWarning: { executionId, ...warning },
        });
      }
      if (usage.recordKind === "final") this.warnedLimits.delete(executionId);
    };
  }

  async deferredFindingsOf(topicId: string): Promise<DeferredFinding[]> {
    const raw = await this.dependencies.artifacts.readLatest(topicId, "deferred-findings");
    if (!raw) return [];
    const parsed = DeferredFindingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.findings : [];
  }

  async writeArtifact(
    topic: Topic,
    kind: string,
    revision: number,
    content: string,
    signal: AbortSignal,
    accept?: () => boolean,
  ) {
    return this.dependencies.artifacts.write(topic.id, kind, revision, content, {
      scopeGeneration: topic.scopeGeneration,
      accept: () => {
        if (signal.aborted) return false;
        const active = this.active.get(topic.id);
        const current = this.dependencies.database.getTopic(topic.id);
        // 작업 묶음 단계면 문맥 변경 중에는 이미 돌던 옛 응답을 채택하지 않는다(엔진 개편 E4 — D2).
        return active?.controller.signal === signal &&
          current.scopeGeneration === topic.scopeGeneration && current.state === topic.state &&
          this.dependencies.database.workGroups.isStageContextCurrent(topic.id) && (accept?.() ?? true);
      },
    });
  }

  latestSequence(topicId: string): number {
    return this.dependencies.database.maxSequence(topicId);
  }

  // 턴 도중 도착한 사용자 입력 중 흐름을 멈춰야 하는 것 — 결정과 증거뿐이다. note 는 참고 메모라 멈추지 않고
  // 다음 턴의 타임라인으로 전달된다(2026-09-07 제안 ③: 메모 하나가 완료된 리뷰를 폐기하고 같은 단계를 재실행시켰다).
  newUserInputSince(topic: Topic, afterSequence: number): TimelineEvent | null {
    return this.dependencies.database.getTimeline(topic.id, afterSequence).find((event) =>
      event.actor === "user" && ["evidence", "decision"].includes(event.kind),
    ) ?? null;
  }

  // 저장 전 중단 지점 공용: 새 결정·증거가 있으면 이 턴의 결과를 산출물로 보존한 뒤 인터럽트하고 true 를 돌려준다.
  // 결과는 새 입력을 반영하지 못했으므로 흐름에 태우지 않지만 버리지도 않는다 — 다음 턴과 사람이 참고한다
  // (2026-09-07 Codex 제안 ③: 운영 기록 4건이 돌아온 결과를 통째로 잃었다. turn()·구현·수정 경로가 함께 쓴다).
  async interruptPreservingResult(
    topic: Topic, role: ParticipantRole, result: AgentResult, afterSequence: number, signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.newUserInputSince(topic, afterSequence)) return false;
    await this.preserveInterruptedResult(topic, role, result, signal);
    this.interruptForNewUserInput(topic, afterSequence);
    return true;
  }

  // 봉투 턴 원문 보존(v3.15 (23)) — 채택이 아니라 기록이라 현재 행동 조건(writeArtifact 의 accept) 없이 쓴다. interrupted-envelope 는 늦은 결과,
  // envelope-contract-failure 는 교정 뒤에도 봉투 계약을 어긴 원응답이다. 보존하지 못하면 사유를 남기고 호출자의 원래 흐름(throw)을 막지 않는다.
  async preserveEnvelope(topic: Topic, route: TurnRoute, kind: "interrupted-envelope" | "envelope-contract-failure",
    record: Record<string, unknown>, reason: string): Promise<string | null> {
    const revision = this.dependencies.database.latestArtifactRevision(topic.id, kind) + 1;
    const content = redactSecrets(JSON.stringify({ seat: route.seat, provider: route.provider, job: route.job, reason, ...record }, null, 2));
    try {
      await this.dependencies.artifacts.write(topic.id, kind, revision, content, { scopeGeneration: topic.scopeGeneration });
      this.event(topic.id, "system", "system", `${reason} 산출물 \`${kind}\`(#${revision}) 로 보존했습니다.`, { preservedEnvelope: kind, revision });
      return `${kind}#${revision}`;
    } catch (error) {
      this.event(topic.id, "system", "system", `봉투 턴 결과를 보존하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }

  async preserveInterruptedResult(topic: Topic, role: ParticipantRole, result: AgentResult, signal: AbortSignal, reason?: string): Promise<void> {
    const parsed = AgentResultSchema.safeParse(result);
    const safe = parsed.success ? redactAgentResult(parsed.data) : redactUnverifiedResult(result);
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    try {
      await this.writeArtifact(topic, `${role}-interrupted`, revision, JSON.stringify(safe, null, 2), signal);
      this.event(topic.id, "system", "system",
        `${reason ?? `${role} 턴이 끝나기 전에 새 결정·증거가 도착해 이 결과는 반영하지 않습니다.`} 산출물 \`${role}-interrupted\`(#${revision}) 로 보존했습니다.`);
    } catch (error) {
      this.event(topic.id, "system", "system",
        `중단된 ${role} 턴 결과를 보존하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  interruptForNewUserInput(topic: Topic, afterSequence: number): boolean {
    const newUserInput = this.newUserInputSince(topic, afterSequence);
    if (!newUserInput) return false;
    this.interrupt(
      topic.id,
      "USER_DECISION_REQUIRED",
      "에이전트가 답하는 동안 새 메시지가 추가되었습니다. 같은 단계를 다시 실행해 새 내용을 반영하세요.",
      topic.state, { newInputSequence: newUserInput.sequence },
    );
    return true;
  }

  // by: 이 결과를 만든 턴의 경로(또는 좌석). 이벤트 actor 는 좌석, 메모리 쓰기 검증은 실제 공급자다 — 좌석 이름으로 검증하면 다른 공급자가 실행한 턴이
  // 남의 플랫폼 메모리(claude-only/codex-only)에 쓴다(E2b). 경로는 이벤트 payload 에 남는다.
  async saveAgentOutput(
    topic: Topic,
    by: TurnRoute | ParticipantRole,
    result: AgentResult,
    kind: string,
    signal: AbortSignal,
    extraPayload: Record<string, unknown> = {},
  ): Promise<void> {
    const role = typeof by === "string" ? by : by.seat;
    const provider = typeof by === "string" ? by : by.provider;
    const safeResult = redactAgentResult(result);
    const requestedMemoryUpdates = safeResult.memoryUpdates ?? [];
    if (requestedMemoryUpdates.length > 0 && !this.dependencies.memory) {
      throw new Error("에이전트가 메모리 변경을 제안했지만 중앙 메모리 저장소가 연결되지 않았습니다.");
    }
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    // 아티팩트 쓰기가 세대·취소 검증 경계다. 공용 메모리는 그 경계를 통과한 응답만 바꿀 수 있다 —
    // 순서가 반대면 범위 변경으로 버려진 응답이 메모리만 바꾸고 타임라인에는 남지 않는다(감사 ③ 재현).
    await this.writeArtifact(topic, kind, revision, JSON.stringify(safeResult, null, 2), signal);
    // 메모리 쓰기는 턴의 부산물이다. 실패해도 방금 확정한 턴 결과를 버리지 않는다(2026-08-30).
    const memoryChanges = requestedMemoryUpdates.length > 0 && !signal.aborted
      ? await this.applyMemoryUpdates(provider, requestedMemoryUpdates)
      : requestedMemoryUpdates.map((update) => ({
          path: update.path, previousSHA256: update.expectedSHA256, sha256: "",
          reason: update.reason, status: "rejected" as const, error: "실행이 취소되어 반영하지 않았습니다.",
        }));
    this.event(topic.id, role, "agent_output", safeResult.summary, {
      resultKind: safeResult.kind, findings: safeResult.findings, evidenceRefs: safeResult.evidenceRefs,
      requestedMediatorAction: safeResult.requestedMediatorAction,
      requestedUserDecision: safeResult.requestedUserDecision, status: safeResult.status, remainingSteps: safeResult.remainingSteps,
      memoryChanges, ...(typeof by === "string" ? {} : { route: routeRecord(by) }), ...extraPayload, artifactRevision: revision,
    });
  }

  async applyMemoryUpdates(
    role: ParticipantRole,
    updates: readonly MemoryUpdate[],
  ): Promise<AppliedMemoryChange[]> {
    try {
      return await this.dependencies.memory!.apply(role, updates);
    } catch (error) {
      const reason = redactSecrets(error instanceof Error ? error.message : String(error));
      return updates.map((update) => ({
        path: update.path,
        previousSHA256: update.expectedSHA256,
        sha256: "",
        reason: update.reason,
        status: "rejected" as const,
        error: reason,
      }));
    }
  }

  // 구현·리뷰·수정이 읽는 계획 — 본문과 러너·리뷰어에게 넘기는 정본 blob 경로를 **같은 산출물 한 건**에서 꺼내 현재 계획 sha 에 결속한다. 최신 plan
  // 산출물이 그 sha 가 아니면(개정 계획 저장과 계획 전환 사이에 끊김 등) 그 sha 의 산출물을 쓰고, 그것도 없으면 멈춘다(2026-09-15 감사: 최신 산출물을 해시
  // 대조 없이 읽어 승인되지 않은 개정 계획으로 구현·리뷰했다 — 본문만 결속하자 읽기 허용 경로가 여전히 미승인 개정본을 가리켰다). 빠른 길과 그 sha 의
  // 산출물 조회(verifiedRevision)는 같은 바이트 계약(원문 sha256)이다 — 정규화 해시로 비교하면 공백만 다른 최신본을 현재 판으로 받는다(F010).
  async requireCurrentPlanArtifact(topicId: string): Promise<{ content: string; path: string }> {
    const planSHA256 = this.dependencies.database.getTopic(topicId).planSHA256;
    const latest = await this.dependencies.artifacts.verifiedLatest(topicId, "plan");
    if (!latest) throw new Error("저장된 plan.md가 없습니다.");
    if (!planSHA256 || sha256(latest.content) === planSHA256) return latest;
    const bound = await this.dependencies.artifacts.verifiedRevision(topicId, "plan", planSHA256);
    if (bound) return bound;
    throw new Error(`저장된 최신 계획이 현재 계획 sha(${planSHA256.slice(0, 12)}…)와 다르고 그 sha 의 계획 산출물도 없습니다 — 계획 상태를 먼저 확인하세요.`);
  }

  assertKind(result: AgentResult, expected: AgentResult["kind"]): void {
    if (result.kind !== expected) throw new FormatViolation(`에이전트 응답 종류가 다릅니다: ${result.kind} (예상 ${expected})`);
  }

  event(topicId: string, actor: "system" | "user" | ParticipantRole, kind: "system" | "decision" | "scope_change" | "agent_output", body: string, payload: Record<string, unknown> = {}): void {
    const state = this.dependencies.database.getTopic(topicId).state;
    this.dependencies.database.appendEvent({
      topicId,
      actor,
      kind,
      state,
      body: redactSecrets(body),
      payload: redactRecord(payload),
    });
  }
}
