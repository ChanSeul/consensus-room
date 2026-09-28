import {ReviewBlocked} from "../reviewLedger.js";
import { existsSync, readFileSync } from "node:fs";
import {reviewScope} from "../../shared/reviews.js";
import { RevisionBlocked } from "../revisionLedger.js";
import type { RewriteKind } from "../../shared/revisions.js";
import { wrapWorkGroupAdapter } from "../workGroupAdapter.js";
import { BudgetController } from "../budgetController.js";
import { recoverableFinalizedFirstPlan } from "../planningStore.js";
import { PlanningPaused, type TimelineDelivery } from "../../shared/planningControl.js";
import { BudgetBlocked } from "../budgetLedger.js";
import { applyPlanLineEdits, applyPlanRepair, planRepairPrompt, repairablePlan } from "../../shared/planPatches.js";
// WorkflowEngine 분해(2026-08-31): 상태 전환·세션·산출물·메모리·전달이 한 클래스(1,504줄)에 있어
// 순서 결함이 반복된다는 Codex 진단에 따른 분리. EngineCore는 공유 상태와 횡단 프리미티브만 갖는다 —
// 흐름(계획 수렴·구현 전달)은 PlanningPipeline·DeliveryPipeline이, 공개 API는 WorkflowEngine 파사드가 갖는다.
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { ToleranceFormatError } from "../../shared/tolerance.js";
import {
  AgentResultSchema,
  DeferredFindingsSchema,
  type DeferredFinding,
  type Finding,
  type AgentExecutionSettings,
  type AgentResult,
  type Participant,
  type TimelineEvent,
  type Topic,
  type WorkflowState,
  type MemoryUpdate,
  type ImplementationNote,
  ImplementationNotesSchema,
} from "../../shared/contracts.js";
import { appliedExecutionSettings } from "../../shared/execution.js";
import { turnFlags, type TurnJob } from "../../shared/roles.js";
import { planningControlApplies } from "../guardedPlanning.js";
import { bindingOf, describeBinding, designReadRequested, legacyBinding, resolveRoute, routeSupport, sameBinding, UnsupportedRoute,
  type SessionBinding, type TurnRoute } from "../turnRouting.js";
import {
  applyPlanEdits,
  assertFixDispositionAllowed,
  assertPlanContract,
  assertTransition,
  hashPlan,
  carryForwardFindings,
  mergeCorrectionResult,
  salvageResultFields,
  normalizePlan,
  redactSecrets,
} from "../../shared/workflow.js";
import { buildContractCorrectionPrompt } from "../../shared/prompts.js";
import { redactAgentResult, redactRecord, redactUnverifiedResult } from "../security.js";
import type { AgentAdapter, AppliedMemoryChange, ParticipantRole, TurnUsage } from "../types.js";
import { exceededLimits } from "../adapters/executionMetrics.js";
import type { WorkflowDependencies } from "../workflow.js";
import { AdmissionRefused, TurnExecutor, type TurnPurpose, type WriteGuards } from "./turnExecutor.js";
import { WorkCheckpoints } from "./checkpoint.js";
import { FixContracts } from "./fixContracts.js";
import { DiagnosisService } from "./diagnoses.js";

// 결과 JSON 의 표기만 틀린 위반(스키마·kind). 재제출에 판단이 필요 없어 교정 턴의 추론 강도를 low 로 내린다
// (2026-09-07 Codex 자기 최적화 제안 ③). 쟁점 누락·처분 규칙 위반은 판단이 섞이므로 여기 속하지 않는다.
// 파싱 직후·검사 직전에 결과를 손질하는 함수. carried 가 있으면 enforceResultContract 가 **최종 검사 뒤** 마지막 적용의 승계 id 를
// 턴당 1회 이벤트로 남긴다(2026-09-13 Codex 지적 3: 검사 전에 "재제출 없음" 을 적으면 바로 뒤 교정이 그 기록을 거짓으로 만든다).
export type ResultNormalizer = ((result: AgentResult) => AgentResult) & { carried?: () => readonly string[]; label?: string };

function normalized(normalize: ResultNormalizer | undefined, result: AgentResult): AgentResult {
  return normalize ? normalize(result) : result;
}

export class FormatViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatViolation";
  }
}

// 표기만 고치면 되는 위반(추론 low 로 교정): 스키마 오류·응답 종류·허용 오차 블록 형식. 처분 판단이 필요한 위반(쟁점 누락 등)은 제외.
export function isFormatOnlyViolation(error: unknown): boolean {
  return error instanceof ZodError || error instanceof FormatViolation || error instanceof ToleranceFormatError;
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

// 실패 진단이 프롬프트 크기만큼 원장에 들어가는 것을 막는다(감사 최적화 지적: 4~16KB 상한).
// 재작성 집계 종류 — 계획자 job 의 계획 단계 턴이다(E2b: 공급자 이름이 아니라 job 역할로 판정 — 계획자가 다른 공급자로 가도 한도가 빠지지 않는다).
function planningWriteOf(job: TurnJob, state: WorkflowState): RewriteKind | undefined {
  if (job.role !== "planner") return undefined;
  return state === "CLAUDE_PLAN" ? "plan" : state === "CLAUDE_REVISION" ? "revision" : undefined;
}

// 경로의 기록용 요약(E2b) — 이벤트 payload·사용량 기록에 싣는다. 이벤트 actor·산출물 kind·execution_usage.role 은 좌석 이름 그대로 둔다(과거 기록과 같은 키).
function routeRecord(route: TurnRoute) {
  return { provider: route.provider, participant: route.participant, profileId: route.profileId, basis: route.basis, job: route.job };
}

function boundedError(message: string): string {
  return message.length <= 16_000 ? message : `${message.slice(0, 16_000)}\n[이하 생략]`;
}

const DEFERRED_SOURCE_LABEL: Record<DeferredFinding["source"], string> = {
  closeout: "종결 확인", review: "첫 코드 리뷰", "final-review": "최종 리뷰", implementation: "구현 to-do", fix: "수정 to-do",
};
// 계획·감사 턴의 이연 쟁점 원문 산출물 종류 — 토픽 자기 원장(deferred-findings)과 다른 종류다(원장은 이 토픽이 이연한 것만, 이것은 턴에 실은 전체).
export const DEFERRED_FINDINGS_DIGEST = "deferred-findings-digest";

type TransitionInput = Parameters<WorkflowDependencies["database"]["applyTopicTransition"]>[0];

export class EngineCore {
  readonly active = new Map<string, {
    actionId: string;
    controller: AbortController;
    completion: Promise<void>;
  }>();
  readonly deliveryActive = new Set<string>();
  readonly scopeChangeActive = new Set<string>();
  // 허용 오차 개정(amendTolerance)이 계획을 읽고 쓰는 동안 — 범위 변경·재개와 직렬화한다(2026-09-14 Codex High 2).
  readonly amendmentActive = new Set<string>();
  // 진단 등록·적용(결속을 잡는 await 포함) 진행 중 — 다른 변경·실행과 겹치지 않는다.
  readonly diagnosisActive = new Set<string>();
  readonly turnInputSequence = new Map<string, number>();
  shuttingDown = false;
  // 주제가 FAILED 로 떨어진 직후(원장 마감 뒤) 알린다 — 사용 한도 자동 재시도 예약(engine/usageLimitRetry.ts).
  failureObserver?: (topicId: string, message: string) => void;
  // 새 action 이 시작될 때 알린다 — 그 주제의 예약된 자동 재시도를 취소한다.
  actionObserver?: (topicId: string) => void;
  private readonly warnedLimits = new Map<string, Set<string>>();
  // 모델 호출의 단일 경계(PLAN §2) — 파이프라인은 adapter 를 직접 부르지 않는다.
  readonly executor: TurnExecutor;
  // 논리 작업별 누적 checkpoint(결과 복구의 정본).
  readonly checkpoints: WorkCheckpoints;
  // 중재자 진단 서비스(저장·조회·적용·재개 검사·전달 기록) — 2026-09-14 진단 계획.
  readonly diagnoses: DiagnosisService;
  // 수정 작업 계약(원본 쟁점·판정 면제·회차·실은 진단) — 2026-09-15 "작업 계약을 기록으로".
  readonly fixContracts: FixContracts;

  constructor(readonly dependencies: WorkflowDependencies) {
    const controller = new BudgetController(dependencies.database.budgets, cwd => {
      const topic = dependencies.database.listTopics().find(t => t.worktreePath === cwd && this.active.has(t.id));
      if (!topic) throw new Error("집계를 연결할 실행 중 토픽이 없습니다.");
      return {topicId:topic.id,accounts:this.budgetAccounts(topic.id),stage:topic.state};
    }, async(topicId,output)=>{
      await dependencies.artifacts.write(topicId,"interrupted-output",1,JSON.stringify(redactRecord(output as Record<string,unknown>)));
    },dependencies.database.revisions,Boolean(dependencies.enforceBudgets),dependencies.database.reviews, dependencies.database);
    this.dependencies={...dependencies,
      claude:wrapWorkGroupAdapter(controller.wrap(dependencies.claude),dependencies.database,dependencies.git),
      codex:wrapWorkGroupAdapter(controller.wrap(dependencies.codex),dependencies.database,dependencies.git)};
    this.executor = new TurnExecutor(this);
    this.checkpoints = new WorkCheckpoints(this);
    this.diagnoses = new DiagnosisService(this);
    this.fixContracts = new FixContracts(this);
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

  assertRetryRewriteAvailable(topicId: string): void {
    const stage=this.dependencies.database.getFlags(topicId).resumeState;
    const checkpoint = this.dependencies.database.planning.latest(topicId);
    const topic = this.dependencies.database.getTopic(topicId);
    if (checkpoint?.started && (!checkpoint.finalized || (stage === "CLAUDE_PLAN" &&
        recoverableFinalizedFirstPlan(checkpoint, topic, this.dependencies.database.getTimeline(topicId)))) && checkpoint.stage === stage &&
        checkpoint.scopeGeneration === topic.scopeGeneration && checkpoint.planEpoch === topic.planEpoch && checkpoint.planSHA256 === topic.planSHA256) return;
    const review=reviewScope(stage??"");
    if(review && !this.heldReviewLedger(stage, topic))this.dependencies.database.reviews.assertAvailable(topicId,review);
    if(stage==="CLAUDE_PLAN" || stage==="CLAUDE_REVISION")
      this.dependencies.database.revisions.assertAvailable(topicId,stage==="CLAUDE_PLAN"?"plan":"revision");
  }

  // 재시도가 이어 쓸 코드 리뷰 원장(E3-4c)이 이미 리뷰 1회를 예약해 두었는가 — 가장 최근 원장이 판정 전(open)이고 그 호출이 spawn 해 예약이 원장에 묶였으며
  // (spawn 뒤에는 spawn 전 실패로도 되돌리지 않는다), 리뷰 종류가 재개 단계와 같고 범위 세대·계획 epoch·계획 SHA 가 지금 주제와 같을 때만 참이다. 그러면
  // 재시도의 읽기·판정 호출은 같은 원장 ID 로 멱등 예약해 새 1회를 쓰지 않으므로 가용 횟수 사전 검사를 건너뛴다. 여기서는 검토 tree·보고판을 보지 않는다 —
  // 실행 경로가 원장 신원을 대조해(openReviewLedger) 달라졌으면 새 원장 ID 로 예약하고, 한도에 닿았으면 ReviewLedger.reserve 가 spawn 전에 막는다. 답변
  // 확인·원장 없는 계약 교정처럼 호출마다 예약하는 턴과 예산 검사도 그대로 막힌다. 예산 강제가 꺼진 구성은 spawn 을 기록하지 않아 이 예외가 적용되지 않는다.
  private heldReviewLedger(stage: string | null | undefined, topic: Topic): boolean {
    const kind = stage === "CODEX_FINAL_REVIEW" ? "codex-final-review" : stage === "CODEX_REVIEW" ? "codex-review" : null;
    const ledger = kind ? this.dependencies.database.planning.latestReviewLedger(topic.id) : null;
    return Boolean(ledger && ledger.status === "open" && ledger.spawned && ledger.kind === kind &&
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

  startAction(topicId: string, kind: string, work: (signal: AbortSignal) => Promise<void>, requestedActionId?: string): string {
    this.assertNotShuttingDown();
    this.assertNoActiveWork(topicId);
    const actionId = requestedActionId ?? randomUUID();
    if (this.dependencies.database.getAction(actionId)) throw conflict("같은 Idempotency-Key로 이미 요청한 action입니다.");
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const scopeGeneration = this.dependencies.database.getTopic(topicId).scopeGeneration;
    this.dependencies.database.startAction({
      id: actionId, topicId, kind, status: "running", createdAt: new Date().toISOString(),
      finishedAt: null, error: null, pid: null, pgid: null,
      processExecutable: null, processCommand: null,
      processStartedAt: null,
    });
    this.active.set(topicId, { actionId, controller, completion });
    this.actionObserver?.(topicId);
    void work(controller.signal).then(() => {
      if (!this.isCurrentAction(topicId, actionId, scopeGeneration)) return;
      this.dependencies.database.finishAction(actionId, "succeeded");
    }).catch((error: unknown) => {
      if (error instanceof PlanningPaused && this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        const topic = this.dependencies.database.getTopic(topicId);
        this.dependencies.database.finishAction(actionId, "cancelled", error.message);
        this.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, topic.state, { planningPause: true });
        return;
      }
      if ((error instanceof BudgetBlocked || error instanceof RevisionBlocked || error instanceof ReviewBlocked) && this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        const topic = this.dependencies.database.getTopic(topicId);
        this.dependencies.database.finishAction(actionId, "cancelled", error.message);
        this.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, topic.state, error instanceof RevisionBlocked ? {revisionPause:true} : error instanceof ReviewBlocked ? {reviewPause:error.scope} : {budgetPause:true});
        return;
      }
      // spawn 직전 실행 허용 거부(계획 변경·유지보수·예산 소진·쓰기 기준 불일치)는 정상 정지다 — 결과는 checkpoint 로 보존됐고 사람이 재개한다.
      // FAILED 로 떨어뜨리면 사용 한도 자동 재시도가 같은 거부를 반복한다(PLAN §2 검증 조건 1).
      if (error instanceof AdmissionRefused && this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        const topic = this.dependencies.database.getTopic(topicId);
        this.dependencies.database.finishAction(actionId, "cancelled", error.message);
        if (topic.state !== "USER_DECISION_REQUIRED" && topic.state !== "BLOCKED_ON_EVIDENCE") {
          // 예산 소진 거부는 기존 예산 정지와 같은 재개 계약(budgetPause → retry 가 같은 단계를 이어간다, 계획을 다시 만들지 않는다).
          this.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, topic.state,
            { admissionRefused: error.reason, ...(error.reason === "budget" ? { budgetPause: true } : {}) });
        }
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
      this.event(topicId, "system", "system", cancelled
        ? "실행을 중단했습니다."
        : failure.topicFailed
          ? `실행에 실패했습니다: ${message}`
          : `실행 요청을 처리하지 못했습니다: ${message} 주제 상태는 그대로 유지했습니다.`);
      if (!cancelled && failure.topicFailed) this.failureObserver?.(topicId, message);
    }).finally(() => {
      if (this.active.get(topicId)?.actionId === actionId) this.active.delete(topicId);
      resolveCompletion();
    });
    return actionId;
  }

  assertNoActiveWork(topicId: string, options: { maintenanceOwner?: MaintenanceLockOwner } = {}): void {
    if (this.active.has(topicId) || this.dependencies.database.runningAction(topicId) ||
        this.deliveryActive.has(topicId) || this.scopeChangeActive.has(topicId) || this.amendmentActive.has(topicId) || this.diagnosisActive.has(topicId)) {
      throw new Error("이 주제에서 이미 실행 중인 작업이 있습니다.");
    }
    this.assertNoMaintenanceLock(options.maintenanceOwner);
  }

  // 중재자가 도구 트리·서버를 교체하는 동안(next-stop.sh) 새 실행을 시작하지 않는다 — 유휴 확인과 교체 사이의 경쟁을 막는 공유 잠금.
  // 60분이 지난 잠금은 버려진 것으로 보고 무시한다(스크립트가 죽어 지우지 못한 경우).
  // 잠금 **소유자**(잠금 파일의 pid·at 을 그대로 제시한 호출)는 통과한다 — 유지보수 스크립트가 잠금을 쥔 채 마지막에 기준 갱신(rebaseline)을
  // 부르는 종료 절차가 자기 잠금에 막히지 않게(R3-06). 잠금을 조기에 풀어 유휴 확인↔교체 경쟁을 되살리지 않는다.
  assertNoMaintenanceLock(owner?: MaintenanceLockOwner): void {
    const path = this.dependencies.maintenanceLockPath;
    if (!path || !existsSync(path)) return;
    let info: { at?: string; reason?: string; pid?: number } = {};
    try { info = JSON.parse(readFileSync(path, "utf8")) as { at?: string; reason?: string; pid?: number }; } catch { /* 형식 무관 — 파일 존재가 잠금이다 */ }
    const age = info.at ? Date.now() - Date.parse(info.at) : 0;
    if (Number.isFinite(age) && age > 60 * 60 * 1000) return;
    if (owner && typeof info.pid === "number" && info.pid === owner.pid && info.at === owner.at) return;
    throw new Error(`중재자 유지보수 잠금 중입니다(${info.reason ?? "사유 없음"}, ${info.at ?? "시각 없음"}) — 끝난 뒤 다시 시도하세요.`);
  }

  // freshSession: 합의 이력을 물려받지 않는 일회용 세션에서 실행한다. 프롬프트가 판단에 필요한 것을
  // 전부 담고 있는 단계에만 쓴다(계획 전문·감사·타임라인·계약). 이력을 이어받으면 이미 폐기된 이전
  // 개정본까지 매 턴 재전송된다 — 2026-08-31 실측: 개정 11 시점에 턴당 재전송 834,290토큰, 그중
  // StructuredOutput(과거 개정 계획 전문 누적) 695KB. 개정 턴이 15분→45분으로 늘고 429를 두 번 맞았다.
  // 만들어진 세션 ID는 participant에 저장하지 않는다 — 저장하면 다음 단계가 이 세션을 이어받는다.
  // route 는 이 논리 턴의 경로(엔진 개편 E2b) — 좌석(세션 저장 키)·job(역할 정책)·실제 공급자·설정·선택 근거. core.route 로 만든다.
  async turn(
    route: TurnRoute,
    topic: Topic,
    prompt: string,
    signal: AbortSignal,
    options: {
      freshSession?: boolean;
      planMode?: boolean;
      check?: (result: AgentResult) => void;
      // 코드 리뷰처럼 계획 participant와 수명이 다른 세션의 저장 책임은 호출자가 갖는다.
      session?: { id: string | null; persist: (sessionId: string) => void };
      // 이 턴에 추가로 읽기를 허용할 경로(주제 plan.md 등).
      readablePaths?: readonly string[];
      // prompt 가 이어 쓰는 세션 기준의 변경분일 때, 과제가 다른 세션으로 가면 쓸 전체 문맥 판(SessionTurn.freshSessionPrompt).
      freshSessionPrompt?: string;
      // 두 판(prompt·freshSessionPrompt)의 타임라인 참조 descriptor(E3-2-2a) — 과제 문자열과 짝을 맞춰 턴에 싣는다.
      timelineDelivery?: TimelineDelivery;
      normalize?: ResultNormalizer;
      planBase?: string;
      repairContextKey?: string;
      writeGuards?: WriteGuards;
      // 재작성 집계 종류를 명시한다 — 없으면 상태로 정한다(CLAUDE_PLAN=plan, CLAUDE_REVISION=revision). 진단 계획 개정은 CLAUDE_PLAN 에서 돌지만
      // 승인 계획의 개정이라 revision 으로 센다(무료 최초 계획 자격을 쓰지 않는다).
      planningWrite?: RewriteKind;
    } = {},
  ): Promise<AgentResult> {
    const { freshSession = false, planMode = false, check } = options;
    const role = route.seat;
    const startedAfter = this.latestSequence(topic.id);
    this.turnInputSequence.set(topic.id, startedAfter);
    const participant = this.participant(topic, role);
    // 좌석 세션은 바인딩(공급자·참여자)이 이 경로와 같을 때만 이어 쓴다 — 다른 공급자 CLI 에 옛 resume id 를 보내지 않는다(E2b).
    // 코드 리뷰처럼 호출자가 세션을 관리하면(options.session) 호출자가 같은 대조를 끝낸 id 를 넘긴다.
    const seatSession = options.session ? null : this.reboundSeatSession(topic, route, participant);
    const resumeSessionId = options.session ? options.session.id : seatSession;
    let executionId: string | undefined;
    const observeUsage = this.usageObserver(topic.id, route, "턴");
    const onUsage = (usage: TurnUsage) => { executionId = usage.executionId; observeUsage(usage); };
    let result: AgentResult;
    let sessionId: string;
    const evidenceDigest = this.dependencies.database.evidence.topic(topic).digest;
    const pending=await this.pendingRepair(topic.id,topic.state);
    // 교정 대기본은 그 응답을 만든 공급자·참여자의 세션으로만 이어 쓴다(E2b — 배정이 바뀌었으면 다시 실행한다).
    const reuse=pending && pending.role===role && sameBinding(pending.binding, route) && pending.contextKey===(options.repairContextKey??null)
      && (!options.session || options.session.id===pending.sessionId);
    if(reuse) {
      result=pending.raw;sessionId=pending.sessionId;
      this.event(topic.id,"system","system","저장된 응답의 교정을 같은 세션에서 재개합니다.");
    } else if (freshSession || !resumeSessionId || resumeSessionId.startsWith("pending:")) {
      const planningWrite = options.planningWrite ?? planningWriteOf(route.job, topic.state);
      const created = await this.executor.execute({
        evidenceDigest,
        route, topic, signal, purpose: "턴", inputSequence: startedAfter, expected: this.expectationOf(topic),
        writeGuards: options.writeGuards,
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
        prompt: options.freshSessionPrompt ?? prompt, freshSessionPrompt: options.freshSessionPrompt, planMode, planningWrite, readablePaths: options.readablePaths,
        // 새 세션에는 전체 판을 보내므로 descriptor 도 전체 판의 것을 과제 판으로 짝짓는다.
        timelineDelivery: options.timelineDelivery && options.freshSessionPrompt !== undefined
          ? { prompt: options.timelineDelivery.fresh, fresh: options.timelineDelivery.fresh } : options.timelineDelivery,
        settings: route.settings, onUsage,
        // 결과 교정·새 입력 처리(채택 검사) 전에 저장해야 재시도가 같은 세션을 이어 쓸 수 있다.
        onResponse: (outcome) => {
          if (options.session) options.session.persist(outcome.sessionId);
          else if (!freshSession) {
            if (this.dependencies.database.participantSessionInUse(topic.id, route.provider, outcome.sessionId)) {
              throw new Error("새 에이전트 세션이 다른 주제 세션과 충돌했습니다.");
            }
            this.dependencies.database.upsertParticipant(topic.id, { ...participant, sessionId: outcome.sessionId, acknowledgedPlanSHA256: null }, bindingOf(route));
          }
        },
      });
      this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
      result = created.result;
      sessionId = created.sessionId;
    } else {
      const resumed = await this.executor.execute({
        evidenceDigest,
        route, topic, signal, purpose: "턴", inputSequence: startedAfter, expected: this.expectationOf(topic),
        writeGuards: options.writeGuards,
        session: { mode: "resume", sessionId: resumeSessionId, onSessionCreated: id => {
          this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
          if (options.session) options.session.persist(id);
          else {
            if (this.dependencies.database.participantSessionInUse(topic.id, route.provider, id)) throw new Error("세션 충돌");
            this.dependencies.database.upsertParticipant(topic.id, { ...participant, sessionId: id, acknowledgedPlanSHA256: null }, bindingOf(route));
          }
        } },
        prompt, freshSessionPrompt: options.freshSessionPrompt, timelineDelivery: options.timelineDelivery, planMode,
        planningWrite: options.planningWrite ?? planningWriteOf(route.job, topic.state),
        readablePaths: options.readablePaths, settings: route.settings, onUsage,
      });
      result = resumed.result;
      sessionId = resumed.sessionId;
    }
    this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    if (await this.interruptPreservingResult(topic, role, result, startedAfter, signal)) throw new HandledWorkflowInterruption();
    let accepted = false;
    try {
      const checked = await this.enforceResultContract(route, topic, result, sessionId, {
        evidenceDigest,
        signal, planMode, startedAfter, check, readablePaths: options.readablePaths, normalize: options.normalize, planBase: options.planBase,
        writeGuards: options.writeGuards,
      });
      accepted = true;
      if(pending)await this.writeArtifact(topic,"pending-contract-repair",this.latestSequence(topic.id)+1,"null",signal);
      return checked;
    } catch(error) {
      if(error instanceof RevisionBlocked || error instanceof ReviewBlocked || error instanceof BudgetBlocked) {
        await this.writeArtifact(topic,"pending-contract-repair",this.latestSequence(topic.id)+1,JSON.stringify({
          role,binding:bindingOf(route),stage:topic.state,scopeGeneration:topic.scopeGeneration,planEpoch:topic.planEpoch,planSHA256:topic.planSHA256,
          participantSessionId:this.participant(this.dependencies.database.getTopic(topic.id),role).sessionId,
          sessionId,raw:redactAgentResult(result),contextKey:options.repairContextKey??null,startedAfter,evidenceDigest,
        }),signal);
      }
      throw error;
    } finally {
      if (result.kind === "PLAN" || result.kind === "REVISION") this.dependencies.database.saveOptimizationMetric(topic.id, topic.scopeGeneration, executionId, {
        kind: "plan-output", success: accepted, format: result.planLineEdits ? "lines" : result.planEdits ? "find-replace" : "full",
        responseBytes: Buffer.byteLength(JSON.stringify(result), "utf8"),
        patchBytes: Buffer.byteLength(JSON.stringify(result.planLineEdits ?? result.planEdits ?? result.planMarkdown ?? ""), "utf8"),
        patchCount: result.planLineEdits?.edits.length ?? result.planEdits?.length ?? 0,
      });
    }
  }

  async pendingRepair(topicId:string,stage:string):Promise<{
    role:ParticipantRole;binding:SessionBinding;stage:string;scopeGeneration:number;planEpoch:number;planSHA256:string|null;
    participantSessionId:string|null;sessionId:string;raw:AgentResult;contextKey:string|null;startedAfter:number;evidenceDigest:string;
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
  // 한 번만 재제출받는다. 두 번째 위반은 그대로 던져 FAILED 경로로 보낸다 — 무한 교정은 다른 종류의 소각이다.
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
      evidenceDigest: string;
      check?: (result: AgentResult) => void;
      // 본 턴과 같은 읽기 허용(계획 정본 등) — 교정 턴에서만 권한이 빠지면 "필요하면 읽으라" 고 안내한 파일을 못 읽는다(Codex 후속 지적 7).
      readablePaths?: readonly string[];
      // 파싱 직후·검사 직전에 결과를 손질한다(예: 판단이 끝난 앞 단계 쟁점을 서버가 승계). 교정 재제출의 재파싱에도 같이 적용된다.
      normalize?: ResultNormalizer;
      planBase?: string;
      writeGuards?: WriteGuards;
      // 교정 호출을 열기 **전에** 호출자가 누적본을 checkpoint 로 보존한다(PLAN §2: 호출 실패·재시작에도 같은 기록에서 이어간다).
      beforeCorrection?: (raw: AgentResult, violation: string) => Promise<void>;
    },
  ): Promise<AgentResult> {
    const role = route.seat;
    const evidence = this.dependencies.database.evidence.topic(this.dependencies.database.getTopic(topic.id));
    const evidenceDigest = context.evidenceDigest;
    if (!evidence.ready || evidence.digest !== evidenceDigest) {
      await this.preserveInterruptedResult(topic, role, raw, context.signal, "원문 확인 상태가 바뀌어 교정 전 응답을 보존만 합니다.");
      this.interrupt(topic.id, "BLOCKED_ON_EVIDENCE", "교정할 응답의 원문이 바뀌었습니다. 최신 근거로 다시 작업하세요.", topic.state, { externalEvidence: true });
      throw new HandledWorkflowInterruption();
    }
    let violation: string;
    let formatOnly = false;
    let repairPlan: string | null = null;
    try {
      const parsed = normalized(context.normalize, redactAgentResult(AgentResultSchema.parse(raw)));
      context.check?.(parsed);
      this.reportCarriedFindings(topic.id, context.normalize, false);
      return parsed;
    } catch (error) {
      if (error instanceof HandledWorkflowInterruption) throw error;
      formatOnly = isFormatOnlyViolation(error);
      violation = error instanceof Error ? error.message : String(error);
      if (error instanceof ToleranceFormatError) repairPlan = repairablePlan(redactAgentResult(raw), context.planBase);
    }
    if (this.dependencies.database.planning.enabled(topic.id) &&
        ["CLAUDE_PLAN", "CLAUDE_REVISION", "CODEX_AUDIT", "CODEX_CLOSEOUT"].includes(topic.state)) {
      const checkpoint = this.dependencies.database.planning.latest(topic.id);
      if (checkpoint && checkpoint.stage === topic.state && checkpoint.role === route.provider &&
          checkpoint.scopeGeneration === topic.scopeGeneration && checkpoint.planEpoch === topic.planEpoch) {
        checkpoint.finalized = false; checkpoint.finalResult = undefined;
        // 무효화한 응답은 결정 질문이어도 재생할 질문이 아니다 — 결정 대기 표식(awaitingDecision)을 함께 내려 이 체크포인트를 교정 대기로만 둔다
        // (E3 후속 리뷰 F008). 남겨 두면 새 입력 없는 retry 가 guardedPlanning 의 질문 재생 분기에서 거절된 응답을 그대로 돌려줘 같은 거절을 끝없이
        // 되풀이하고 교정 호출에 닿지 못한다. 무효화 상태는 여기 한 곳이 정하고 재생 분기에 예외를 두지 않는다. 같은 체크포인트(같은 admission·세션)를
        // 이어 가므로 교정 호출은 새 시도·새 예약이 아니고, 결정 뒤로 미룬 읽기(deferredReads)는 지우지 않아 교정 호출에 다시 대조해 실린다.
        checkpoint.awaitingDecision = undefined;
        checkpoint.step.complete = false;
        checkpoint.step.questions = [`Repair the final task contract: ${violation}`, ...checkpoint.step.questions];
        checkpoint.stopped = "Final result failed the task contract; checkpoint and response retained.";
        checkpoint.updatedAt = new Date().toISOString();
        this.dependencies.database.planning.save(checkpoint);
      }
      // A generic repair call would bypass the bounded research protocol and buy a second logical attempt.
      throw new PlanningPaused("Final result failed the task contract; resume the saved planning attempt after mediation.");
    }
    // 계획 교정(plan-repair)은 계획자·검토자에게만 있다 — 구현자 원본에는 열지 않는다. 지금도 구현 턴에서는 열리지 않는다: 구현 결과는
    // kind 검사를 통과하면 PLAN·REVISION 이 아니어서 repairablePlan 이 null 이다(planBase 도 넘기지 않는다).
    const repairJob: TurnJob | null = route.job.role === "implementer" ? null : { role: route.job.role, operation: "plan-repair" };
    if (repairPlan && repairJob && this.executor.supportsPlanRepair(route.provider)) {
      const repairRoute: TurnRoute = { ...route, job: repairJob };
      const usageObserver = this.usageObserver(topic.id, repairRoute, "계약 교정 재제출");
      let executionId: string | undefined;
      let repaired: AgentResult | undefined;
      let responseBytes: number | undefined;
      let accepted = false;
      try {
        const sourceRevision = (this.dependencies.database.latestArtifact(topic.id, "plan-repair-source")?.revision ?? 0) + 1;
        await this.writeArtifact(topic, "plan-repair-source", sourceRevision, JSON.stringify(redactAgentResult(raw)), context.signal);
        // 실행 허용(새 입력·계획 변경·취소…)은 실행기가 spawn 직전에 본다(R3-03 → PLAN §2 공통 실행기).
        const patch = await this.executor.executePlanRepair({
          evidenceDigest,
          route: repairRoute, topic, signal: context.signal, purpose: "계획 교정", inputSequence: context.startedAfter, expected: this.expectationOf(topic),
          session: { mode: "resume", sessionId }, prompt: planRepairPrompt(repairPlan, violation),
          settings: { ...route.settings, effort: "low" },
          onUsage: (usage) => { executionId = usage.executionId; usageObserver(usage); },
        });
        responseBytes = Buffer.byteLength(JSON.stringify(patch), "utf8");
        this.assertCurrent(topic.id, context.signal, topic.scopeGeneration, topic.state);
        if (this.interruptForNewUserInput(topic, context.startedAfter)) throw new HandledWorkflowInterruption();
        if (this.dependencies.database.getTopic(topic.id).planSHA256 !== topic.planSHA256) throw new Error("교정 중 계획 기준이 바뀌었습니다.");
        const planMarkdown = applyPlanRepair(repairPlan, patch);
        const { planEdits: _oldEdits, planLineEdits: _oldLines, ...preserved } = raw;
        repaired = normalized(context.normalize, redactAgentResult(AgentResultSchema.parse({ ...preserved, planMarkdown })));
        context.check?.(repaired);
        this.reportCarriedFindings(topic.id, context.normalize, true);
        accepted = true;
        return repaired;
      } finally {
        this.dependencies.database.saveOptimizationMetric(topic.id, topic.scopeGeneration, executionId, {
          kind: "plan-repair", success: accepted, originalBytes: Buffer.byteLength(JSON.stringify(raw), "utf8"),
          responseBytes,
        });
      }
    }
    const correctionRevision=(this.dependencies.database.latestArtifact(topic.id,"contract-repair-source")?.revision ?? 0)+1;
    // 보관은 계약 검증 없이 가린다 — 계약을 어긴 응답을 스키마로 다시 파싱하면 보관에서 죽어 교정에 못 간다(Codex 감사 R08).
    // 세대·계획 sha·상태에 결속해 보관한다 — 교정이 실패하면 재개(delivery.pendingResultOriginal)가 이 원본을 소비한다(F03).
    await this.writeArtifact(topic,"contract-repair-source",correctionRevision,JSON.stringify({
      kind: "contract-repair-source", scopeGeneration: topic.scopeGeneration, planSHA256: topic.planSHA256, state: topic.state,
      original: redactUnverifiedResult(raw),
    }),context.signal);
    // 호출자가 누적본을 보존한다(구현·수정 경로의 checkpoint) — 교정 호출이 죽어도 같은 기록에서 이어간다.
    await context.beforeCorrection?.(raw, violation);
    this.event(topic.id, "system", "system",
      `기계 계약 위반을 같은 세션에 돌려보내 1회 교정합니다${formatOnly ? "(표기 교정 — 추론 low)" : ""}: ${violation}`);
    const correctionRoute: TurnRoute = { ...route, job: { role: route.job.role, operation: "contract-correction" } };
    const settings = route.settings;
    // 실행 허용(새 입력·계획 변경·취소·유지보수·예산·쓰기 기준)은 실행기가 adapter 호출 전과 spawn 직전에 본다(R3-03 → PLAN §2).
    const { result: corrected } = await this.executor.execute({
      evidenceDigest,
      route: correctionRoute, topic, signal: context.signal, purpose: "계약 교정 재제출", inputSequence: context.startedAfter,
      expected: { ...this.expectationOf(topic), state: this.dependencies.database.getTopic(topic.id).state },
      writeGuards: context.writeGuards,
      session: { mode: "resume", sessionId }, prompt: buildContractCorrectionPrompt(violation),
      planMode: context.planMode, planningWrite: "repair", readablePaths: context.readablePaths,
      settings: formatOnly ? { ...settings, effort: "low" } : settings,
    });
    this.assertCurrent(topic.id, context.signal, topic.scopeGeneration, this.dependencies.database.getTopic(topic.id).state);
    // 교정 응답은 원본에서 개별로 유효했던 필드(요약·쟁점·증거·요청 결정·상태) 위에 병합한다 — 교정이 거부된 필드만 고치고
    // 나머지를 비워 내면 본 턴의 보고와 미해결 결정 요청이 흐름에서 사라진다(Codex 감사 R01 ②).
    const parsedCorrection = redactAgentResult(AgentResultSchema.parse(corrected));
    const salvaged = salvageResultFields(raw, parsedCorrection.kind);
    const merged = mergeCorrectionResult(salvaged, parsedCorrection);
    if (merged.preserved.length > 0) {
      this.event(topic.id, "system", "system", `계약 교정 재제출에 원본의 유효한 필드를 병합했습니다(서버 보존): ${merged.preserved.join(" · ")}`,
        { correctionPreserved: merged.preserved });
    }
    const reparsed = normalized(context.normalize, redactAgentResult(AgentResultSchema.parse(merged.result)));
    context.check?.(reparsed);
    this.reportCarriedFindings(topic.id, context.normalize, true);
    return reparsed;
  }

  // 최종 검사를 통과한 결과 기준으로 승계 id 와 실제 교정 여부를 한 번 남긴다 — 절감 측정의 근거(payload.carriedFindings·corrected).
  private reportCarriedFindings(topicId: string, normalize: ResultNormalizer | undefined, corrected: boolean): void {
    const carried = normalize?.carried?.() ?? [];
    if (carried.length === 0) return;
    const label = normalize?.label ?? "결과 계약";
    this.event(topicId, "system", "system",
      `${label}: 판단이 끝난 앞 단계 쟁점 ${carried.length}건을 서버가 같은 처분으로 승계했습니다(계약 교정 재제출 ${corrected ? "1회 뒤 확정" : "없음"}): ${carried.join(", ")}`,
      { carriedFindings: [...carried], label, corrected });
  }

  // 앞 단계 쟁점 승계용 normalize. 이벤트는 여기서 내지 않는다 — enforceResultContract 가 최종 검사 뒤 마지막 적용분을 1회 기록한다.
  // 원본이 여럿이면 호출자가 mergeFindingSources 로 최신 우선 합친 **하나**를 준다(원본마다 normalizer 를 두면 옛 처분이 최신을 덮는다).
  carryForwardNormalizer(
    source: readonly Finding[], label: string, options: { forReview?: boolean } = {},
  ): ResultNormalizer {
    let lastCarried: readonly string[] = [];
    const normalizer: ResultNormalizer = (result) => {
      const { findings, carried } = carryForwardFindings(source, result.findings, options);
      lastCarried = carried;
      return carried.length > 0 ? { ...result, findings } : result;
    };
    normalizer.carried = () => lastCarried;
    normalizer.label = label;
    return normalizer;
  }

  // 합의 세션과 무관한 일회용 세션에서 실행한다. 만들어진 세션 ID는 participant에 저장하지 않는다 —
  // 저장하면 다음 단계가 그 빈 세션을 이어받아 합의 대화를 잃는다.
  async isolatedTurn(
    route: TurnRoute,
    topic: Topic,
    prompt: string,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const startedAfter = this.latestSequence(topic.id);
    this.turnInputSequence.set(topic.id, startedAfter);
    const created = await this.executor.execute({
      route, topic, signal, purpose: "프로토콜 확인", inputSequence: startedAfter, expected: this.expectationOf(topic),
      session: { mode: "create" }, prompt,
      // 모델은 경로의 설정을 따르되 추론 강도는 low로 내린다. 프로토콜 확인에 xhigh/max 추론은
      // thinking 토큰 낭비다(2026-08-29 ACK 실측: output 19,975 중 상당분이 탐색·추론).
      settings: { ...route.settings, effort: "low" },
    });
    this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    if (this.interruptForNewUserInput(topic, startedAfter)) throw new HandledWorkflowInterruption();
    return redactAgentResult(AgentResultSchema.parse(created.result));
  }

  // 논리 턴의 경로(엔진 개편 E2b) — 역할 배정·프로필로 실제 공급자와 설정을 정하고(turnRouting.ts), 세션 저장·원장·모델 실행 같은 부수효과 전에
  // 지원 여부를 판정한다. 지원하지 않는 조합(Claude 읽기 턴 팬아웃·Codex Figma 관측)과 프로필 없는·잘못된 배정은 구체적 사유로 멈춘다(재시도해도 같으므로
  // FAILED 가 아니라 결정 대기). 설정: 기본 배정은 주제의 공급자 설정(구현자 job 이면 구현 전용 모델 — adversarial 계획 왕복은 fable, 구현은 opus 라는
  // 사용자 관행의 실행 지점, 2026-08-31), 배정은 프로필의 모델·강도.
  route(topic: Topic, job: TurnJob): TurnRoute {
    try {
      const route = resolveRoute(this.dependencies.database, topic, job);
      const flags = turnFlags(job);
      // withEvidence가 구현 턴에 붙이는 Figma 요구를 브랜치·세션 생성 전에도 판정한다(실행기의 마지막 판정과 같은 식 — designReadRequested).
      const reason = routeSupport(route, planningControlApplies(this.dependencies.database, topic.id, topic.state, flags),
        designReadRequested(this.dependencies.database, topic.id, job));
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
    const stored = this.dependencies.database.participantBinding(topic.id, route.seat) ?? legacyBinding(route.seat);
    if (sameBinding(stored, route)) return sessionId;
    const message = `${route.seat} 좌석의 세션 ${sessionId}(${describeBinding(stored)})은 이 턴의 경로 ${describeBinding(route)} 와 공급자·참여자가 달라 이어 쓰지 않습니다.`;
    if (route.seat === "claude" && this.dependencies.database.planning.continuityEnabled(topic.id)) {
      this.event(topic.id, "system", "system", `${message} 계획 연속성 정책은 한 세션을 이어 써야 해서 새 세션을 열지 않고 멈춥니다 — 배정을 되돌리거나 연속성 정책을 끈 뒤 재개하세요.`,
        { admissionRefused: "session-binding", seat: route.seat, previous: { sessionId, binding: stored }, next: bindingOf(route) });
      throw new AdmissionRefused("session-binding", `${message} 계획 연속성 정책에서는 새 세션으로 바꾸지 않습니다.`);
    }
    this.event(topic.id, "system", "system", `${message} 새 세션을 엽니다(이전 세션 기록은 이 이벤트에 남깁니다).`,
      { sessionRebound: { seat: route.seat, previous: { sessionId, binding: stored }, next: bindingOf(route) } });
    return null;
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
    const topic = this.dependencies.database.getTopic(topicId);
    assertTransition(topic.state, to);
    const updated = this.dependencies.database.updateTopic(topicId, {
      state: to, lastError: null, resumeState: null,
    });
    this.event(topicId, "system", "system", message, { from: topic.state, to });
    return updated;
  }

  // 상태 전이를 수정 작업 계약 행·진단 상태 기록·추가 이벤트와 **한 transaction** 으로 — 수정 작업을 여는 전이(계약 생성)와 수락 전이(회차 소비·계약 수락·
  // 반영 보고)가 중간에 끊겨 갈라지지 않게(2026-09-15 감사 2차). 이벤트의 비밀값 가림은 DB 저장 경계가 한다.
  transitionWith(topicId: string, to: WorkflowState, message: string, extras: {
    changes?: TransitionInput["changes"]; contracts?: TransitionInput["contracts"]; diagnosisEntries?: TransitionInput["diagnosisEntries"];
    payload?: Record<string, unknown>; events?: TransitionInput["events"]; deliveryResolution?: TransitionInput["deliveryResolution"];
  } = {}): Topic {
    const topic = this.dependencies.database.getTopic(topicId);
    assertTransition(topic.state, to);
    return this.dependencies.database.applyTopicTransition({
      topicId, changes: { state: to, lastError: null, resumeState: null, ...(extras.changes ?? {}) },
      contracts: extras.contracts, diagnosisEntries: extras.diagnosisEntries, deliveryResolution: extras.deliveryResolution,
      events: [{ actor: "system", kind: "system", state: to, body: message, payload: { from: topic.state, to, ...(extras.payload ?? {}) } }, ...(extras.events ?? [])],
    });
  }

  interrupt(
    topicId: string,
    state: "BLOCKED_ON_EVIDENCE" | "USER_DECISION_REQUIRED",
    message: string,
    resumeState: WorkflowState,
    payload: Record<string, unknown> = {},
  ): void {
    const topic = this.dependencies.database.getTopic(topicId);
    assertTransition(topic.state, state);
    this.dependencies.database.updateTopic(topicId, { state, resumeState, lastError: boundedError(redactSecrets(message)) });
    this.event(topicId, "system", "system", message, { resumeState, ...payload });
  }

  resetToDraft(topic: Topic, message: string): void {
    // 이전 계획에 묶인 진행 중 진단을 먼저 재확인으로 돌린다 — 초기화 도중 끊겨도 옛 개정·지시가 새 계획에 실리지 않는 쪽으로 멈춘다(fail-closed).
    this.diagnoses.staleOnReplan(topic);
    this.dependencies.database.updateTopic(topic.id, {
      state: "DRAFT", planRevision: 0, planEpoch: topic.planEpoch + 1,
      planSHA256: null, approvedPlanSHA256: null, lastError: null,
      fixPassUsed: false, closeoutRevisionUsed: false, resumeState: null,
    });
    this.dependencies.database.clearAcknowledgements(topic.id);
    this.event(topic.id, "system", "system", message, { scopeGeneration: topic.scopeGeneration });
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
    // 작업 묶음 단계의 문맥 결속(E4) — 실행기가 spawn 직전과 응답 처리 때 이 함수로 대조한다. 재계획 대기·문맥 변경이면 새 턴을 열지 않는다.
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

  // 이연 쟁점 기록(2026-09-07 Codex 피드백): 종결 확인·최종 리뷰가 "이번 범위 밖" 으로 처분한 새 쟁점을 산출물
  // `deferred-findings` 에 누적한다. 발견 시점이 아니라 **처분**(DEFERRED_OUT_OF_SCOPE·AGREED_NO_ACTION)이 기준이다 —
  // 늦게 발견했다는 이유로 범위 밖이라 적으면 해결 안 한 문제를 범위 밖으로 기록하게 된다.
  // 후속 목록의 출처 표시 — 사용자는 인도 전에 이 목록의 처분(후속 토픽·다음 계획·폐기)을 정한다.
  async recordDeferredFindings(
    topic: Topic, findings: readonly Finding[], source: DeferredFinding["source"], signal: AbortSignal,
  ): Promise<void> {
    if (findings.length === 0) return;
    const existing = await this.deferredFindingsOf(topic.id);
    const recordedAt = new Date().toISOString();
    const additions = findings
      .filter((finding) => !existing.some((item) => item.id === finding.id))
      .map((finding) => ({
        id: finding.id, title: finding.title, severity: finding.severity, rationale: finding.rationale,
        source, topicId: topic.id, recordedAt,
      }));
    if (additions.length === 0) return;
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    await this.writeArtifact(topic, "deferred-findings", revision,
      JSON.stringify({ findings: [...existing, ...additions] }, null, 2), signal);
    this.event(topic.id, "system", "system",
      `후속 목록에 기록(이번 범위 밖, ${DEFERRED_SOURCE_LABEL[source]}): ${additions.map((item) => `${item.id} ${item.title}`).join(", ")}`,
      { deferredFindingIDs: additions.map((item) => item.id) });
  }

  // 뒤 단계(리뷰·수정)가 to-do 를 다른 처분으로 닫으면 후속 목록에서 뺀다. 종결 확인·최종 리뷰 이연은 그대로 둔다
  // (그 출처의 항목은 계획 단계가 다시 판단한다).
  async pruneDeferredFindings(topic: Topic, resolvedIDs: readonly string[], signal: AbortSignal): Promise<void> {
    if (resolvedIDs.length === 0) return;
    const existing = await this.deferredFindingsOf(topic.id);
    const remaining = existing.filter((item) =>
      !(resolvedIDs.includes(item.id) && (item.source === "implementation" || item.source === "fix" || item.source === "review")));
    if (remaining.length === existing.length) return;
    const removed = existing.filter((item) => !remaining.includes(item));
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    await this.writeArtifact(topic, "deferred-findings", revision, JSON.stringify({ findings: remaining }, null, 2), signal);
    this.event(topic.id, "system", "system",
      `후속 목록에서 제외(뒤 단계에서 처분됨): ${removed.map((item) => `${item.id} ${item.title}`).join(", ")}`,
      { deferredFindingIDsRemoved: removed.map((item) => item.id) });
  }

  // 경미 지적을 개정 없이 구현 단계로 넘긴다 — 산출물 implementation-notes + 이벤트(payload.implementationNoteIDs).
  async recordImplementationNotes(
    topic: Topic, findings: readonly Finding[], source: ImplementationNote["source"], signal: AbortSignal,
  ): Promise<void> {
    if (findings.length === 0) return;
    const existing = await this.implementationNotesOf(topic.id);
    const recordedAt = new Date().toISOString();
    const additions = findings
      .filter((finding) => !existing.some((item) => item.id === finding.id))
      .map((finding) => ({ id: finding.id, title: finding.title, severity: finding.severity, rationale: finding.rationale, source, topicId: topic.id, recordedAt }));
    if (additions.length === 0) return;
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    await this.writeArtifact(topic, "implementation-notes", revision, JSON.stringify({ notes: [...existing, ...additions] }, null, 2), signal);
    this.event(topic.id, "system", "system",
      `경미 지적 ${additions.length}건을 개정 없이 구현 노트로 넘깁니다(${source === "audit" ? "감사" : "종결 확인"}, 구현 프롬프트에 실리고 러너가 id 별 처분을 보고합니다): ${additions.map((item) => `${item.id} [${item.severity}] ${item.title}`).join(", ")}`,
      { implementationNoteIDs: additions.map((item) => item.id), source });
  }

  async implementationNotesOf(topicId: string): Promise<ImplementationNote[]> {
    const raw = await this.dependencies.artifacts.readLatest(topicId, "implementation-notes");
    if (!raw) return [];
    const parsed = ImplementationNotesSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.notes : [];
  }

  async deferredFindingsOf(topicId: string): Promise<DeferredFinding[]> {
    const raw = await this.dependencies.artifacts.readLatest(topicId, "deferred-findings");
    if (!raw) return [];
    const parsed = DeferredFindingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.findings : [];
  }

  // 계획·감사 프롬프트에 실을 이연 목록: 이 토픽이 이연한 것(재시작 바퀴) + 선행 토픽(predecessorTopicId)이 이연한 것 + 작업 묶음 단계면 이어받는
  // 선행 단계 동결 결과의 보류 원장(E4 보완 F007 — 단계 토픽은 predecessorTopicId 가 없고, 결과가 동결한 deferred-findings 원장이 승계 근거다).
  // 같은 토픽의 같은 id 는 한 번만 싣는다.
  async deferredFindingsFor(topicId: string): Promise<DeferredFinding[]> {
    const topic = this.dependencies.database.getTopic(topicId);
    const own = await this.deferredFindingsOf(topicId);
    const inherited = topic.predecessorTopicId
      ? await this.deferredFindingsOf(topic.predecessorTopicId).catch(() => [])
      : [];
    const group = this.dependencies.database.workGroups.forTopic(topicId);
    const stageId = group ? Object.entries(group.links).find(([, link]) => link.topicId === topicId)?.[0] : undefined;
    const stageInherited = group && stageId ? this.dependencies.database.workGroups.inheritedDeferredFindings(group, stageId) : [];
    const seen = new Set<string>();
    return [...stageInherited, ...inherited, ...own].filter((finding) => {
      const key = `${finding.topicId}\0${finding.id}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  // 계획·감사 턴에 실을 이연 쟁점 전체(deferredFindingsFor 결과)를 근거 전문 그대로 읽기 전용 산출물로 쓴다(E4 2차 보완 F012). 프롬프트의 이연 목록은
  // 인라인 예산을 넘으면 색인과 이 산출물의 참조만 싣는다 — 근거를 잘라 싣지 않는다. 결정 원문 산출물과 같은 방식으로 내용이 같으면 새 판을 만들지 않고,
  // 쓰기는 writeArtifact 의 채택 경계(범위 세대·작업 묶음 문맥)를 지난다. 없으면 쓰지 않고 null. 반환: 원장 sha 로 검증한 정본 경로(계획 제어는 그 턴의
  // readablePaths 로 받아 kind=artifact selector=<경로> 문서로 싣는다).
  async writeDeferredFindingsDigest(topic: Topic, findings: readonly DeferredFinding[], signal: AbortSignal): Promise<string | null> {
    if (!findings.length) return null;
    const body = [
      "# 이연 쟁점 원문(서버 보존, 읽기 전용)", "",
      `주제 ${topic.id} · 범위 세대 ${topic.scopeGeneration} · ${findings.length}건. 계획·감사 프롬프트의 이연 쟁점 목록이 가리키는 근거 전문이다.`, "",
      ...findings.map((finding) => `## ${finding.id} [${finding.severity}] ${finding.title}\n\n출처 ${finding.source} · 토픽 ${finding.topicId} · 기록 ${finding.recordedAt}\n\n${finding.rationale}\n`),
    ].join("\n");
    const latest = await this.dependencies.artifacts.readLatest(topic.id, DEFERRED_FINDINGS_DIGEST);
    if (latest !== body) {
      const revision = (this.dependencies.database.latestArtifact(topic.id, DEFERRED_FINDINGS_DIGEST)?.revision ?? 0) + 1;
      await this.writeArtifact(topic, DEFERRED_FINDINGS_DIGEST, revision, body, signal);
    }
    return this.dependencies.artifacts.verifiedPath(topic.id, DEFERRED_FINDINGS_DIGEST);
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
        // 작업 묶음 단계면 재계획 대기·문맥 변경 중에는 이미 돌던 옛 응답을 채택하지 않는다(엔진 개편 E4 — D2). 대기 표식은 범위 세대를 올린 뒤에만
        // 지워지므로, 대기 중에는 이 표식이, 해제 뒤에는 위 세대 대조가 막는다.
        return active?.controller.signal === signal &&
          current.scopeGeneration === topic.scopeGeneration && current.state === topic.state &&
          this.dependencies.database.workGroups.isStageContextCurrent(topic.id) && (accept?.() ?? true);
      },
    });
  }

  // pauseForResult가 멈출지 미리 판정한다 — 멈추는 응답은 계획이 없어도 정당하므로, 계획 검증을
  // 메모리 반영(saveAgentOutput)보다 앞으로 올릴 때 이 예측으로 가드한다(2026-08-31 Codex 지적:
  // 검증 전에 메모리를 바꿔, 계약 위반 응답이 FAILED가 되고도 공용 메모리를 1회 오염).
  resultRequestsPause(result: AgentResult): boolean {
    // status=blocked 는 요청 문구가 없어도 정지다(D01: 완료 판단을 요청 필드 유무에만 맡기지 않는다).
    const blocked = result.status === "blocked"
      ? `러너가 막힘(blocked)으로 정지했습니다 — 남은 단계: ${(result.remainingSteps ?? []).join(" · ") || "(명시 없음)"}` : undefined;
    const decision = result.requestedUserDecision ?? blocked ??
      result.findings.find((finding) => finding.requiresUserDecision)?.rationale;
    if (decision) return true;
    return result.findings.some((finding) => finding.disposition === "EXTERNAL_EVIDENCE");
  }

  pauseForResult(
    topicId: string,
    result: AgentResult,
    resumeState: WorkflowState,
    fallbackMessage: string,
  ): boolean {
    const blocked = result.status === "blocked"
      ? `러너가 막힘(blocked)으로 정지했습니다 — 남은 단계: ${(result.remainingSteps ?? []).join(" · ") || "(명시 없음)"}` : undefined;
    const decision = result.requestedUserDecision ?? blocked ??
      result.findings.find((finding) => finding.requiresUserDecision)?.rationale;
    if (decision) {
      this.interrupt(topicId, "USER_DECISION_REQUIRED", decision || fallbackMessage, resumeState,
        result.status === "blocked" ? { runnerBlocked: true, remainingSteps: result.remainingSteps ?? [] } : {});
      return true;
    }
    const missingEvidence = result.findings.find((finding) => finding.disposition === "EXTERNAL_EVIDENCE");
    if (missingEvidence) {
      this.interrupt(topicId, "BLOCKED_ON_EVIDENCE", missingEvidence.rationale || fallbackMessage, resumeState);
      return true;
    }
    return false;
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
      topic.state,
    );
    return true;
  }

  interruptForLatestTurnInput(topic: Topic): boolean {
    return this.interruptForNewUserInput(topic, this.turnInputSequence.get(topic.id) ?? this.latestSequence(topic.id));
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

  async latestResult(topicId: string, kind: string): Promise<AgentResult> {
    const raw = await this.dependencies.artifacts.readLatest(topicId, kind);
    if (!raw) throw new Error(`${kind} 결과를 찾을 수 없습니다.`);
    return AgentResultSchema.parse(JSON.parse(raw));
  }

  requirePlan(result: AgentResult): string {
    if (!result.planMarkdown) throw new Error(`${result.kind} 응답에 planMarkdown이 없습니다.`);
    assertPlanContract(result.planMarkdown);
    return normalizePlan(result.planMarkdown);
  }

  // 개정은 패치(planEdits)를 우선 해석한다 — 프롬프트가 같은 우선순위를 명시한다(둘 다 있으면 edits).
  // find의 유일 일치는 applyPlanEdits가 강제하고, 실패 메시지는 어느 편집인지 명시한다. 베이스는
  // 프롬프트에 실린 '기존 계획'과 같은 storedPlan이라 모델이 본 본문과 적용 대상이 항상 일치한다.
  requireRevisedPlan(result: AgentResult, baseMarkdown: string): string {
    // 빈 배열도 패치 모드다 — "계획 변경 없음"(개정 6·12 실측 패턴). planMarkdown 누락으로
    // 오판해 거부하면 무수정 개정이 성립할 수 없다(2026-08-31 Codex 지적 재현 확인).
    if (result.planLineEdits) {
      const patched = applyPlanLineEdits(baseMarkdown, result.planLineEdits);
      assertPlanContract(patched);
      return patched;
    }
    if (result.planEdits) {
      const patched = applyPlanEdits(baseMarkdown, result.planEdits);
      assertPlanContract(patched);
      return normalizePlan(patched);
    }
    return this.requirePlan(result);
  }

  async requireStoredPlan(topicId: string): Promise<string> {
    const plan = await this.dependencies.artifacts.readLatest(topicId, "plan");
    if (!plan) throw new Error("저장된 plan.md가 없습니다.");
    return plan;
  }

  // 구현·리뷰·수정이 읽는 계획 — 본문과 러너·리뷰어에게 넘기는 정본 blob 경로를 **같은 산출물 한 건**에서 꺼내 현재 계획 sha 에 결속한다. 최신 plan
  // 산출물이 그 sha 가 아니면(개정 계획 저장과 계획 전환 사이에 끊김 등) 그 sha 의 산출물을 쓰고, 그것도 없으면 멈춘다(2026-09-15 감사: 최신 산출물을 해시
  // 대조 없이 읽어 승인되지 않은 개정 계획으로 구현·리뷰했다 — 본문만 결속하자 읽기 허용 경로가 여전히 미승인 개정본을 가리켰다).
  async requireCurrentPlanArtifact(topicId: string): Promise<{ content: string; path: string }> {
    const planSHA256 = this.dependencies.database.getTopic(topicId).planSHA256;
    const latest = await this.dependencies.artifacts.verifiedLatest(topicId, "plan");
    if (!latest) throw new Error("저장된 plan.md가 없습니다.");
    if (!planSHA256 || hashPlan(latest.content) === planSHA256) return latest;
    const bound = await this.dependencies.artifacts.verifiedRevision(topicId, "plan", planSHA256);
    if (bound) return bound;
    throw new Error(`저장된 최신 계획이 현재 계획 sha(${planSHA256.slice(0, 12)}…)와 다르고 그 sha 의 계획 산출물도 없습니다 — 계획 상태를 먼저 확인하세요.`);
  }

  assertKind(result: AgentResult, expected: AgentResult["kind"]): void {
    if (result.kind !== expected) throw new FormatViolation(`에이전트 응답 종류가 다릅니다: ${result.kind} (예상 ${expected})`);
    assertFixDispositionAllowed(result, expected);
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
