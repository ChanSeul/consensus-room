import type { PlanningMigration } from "../shared/planningControl.js";
import {reviewScope,type ReviewScope} from "../shared/reviews.js";
import { assertToleranceWidening, normalizeToleranceBlocks, parseTolerancePolicy, replaceToleranceBlock, TolerancePolicySchema } from "../shared/tolerance.js";
import { hashPlan, normalizePlan } from "../shared/workflow.js";
import { RevisionBlocked } from "./revisionLedger.js";
import { randomUUID } from "node:crypto";
import { describePrune, pruneBuildTrees } from "./buildTrees.js";
import { basename, dirname, join } from "node:path";
import {
  type ResumeImplementationInput,
  type AgentExecutionSettings,
  type Finding,
  type Participant,
  type Topic,
  type WorkflowState,
} from "../shared/contracts.js";
import {
  assertImplementationGate,
  bothAgentsAcknowledged,
  canTransition,
  redactSecrets, replanDirective } from "../shared/workflow.js";
import { ArtifactStore, StaleArtifactError } from "./artifacts.js";
import { ConsensusDatabase } from "./database.js";
import { GitService } from "./git.js";
import { redactRecord } from "./security.js";
import type { AgentAdapter, ExecutionLimits, ParticipantRole, ProjectMemoryWriter } from "./types.js";
import { EngineCore, type MaintenanceLockOwner } from "./engine/core.js";
import { PlanningPipeline } from "./engine/planning.js";
import { DeliveryPipeline } from "./engine/delivery.js";
import { CheckpointCorrupt, checkpointOpenRequests, WORK_CHECKPOINT_KIND } from "./engine/checkpoint.js";
import { pendingReviewRequests } from "./engine/reviewRequests.js";
import { closeoutOpenFindings, fixOpenFindings, judgeCloseout, reviewOpenFindings, settleClosedDiagnoses, unsettledFindings, type OpenFinding } from "./engine/findingJudgment.js";
import { UsageLimitRetryScheduler, type RetryClock } from "./engine/usageLimitRetry.js";
import { recoverableFinalizedFirstPlan } from "./planningStore.js";

// 호출 주체 — 브라우저 사용자(기본)와 중재 세션(x-consensus-actor: mediator, 위임 스위치 on 일 때만). 이벤트 payload 에 남긴다(D03).
import { CLOSED_DIAGNOSIS_STATUSES, MEDIATOR_PENDING_STATUSES, type DiagnosisInput, type DiagnosisRecord } from "../shared/diagnoses.js";
import type { MediatorIdentity } from "../shared/roles.js";
// 재개 정보의 다음 허용 작업 — blocker 는 실제 액션의 사전 검사가 던지는 문구, deferredChecks 는 실행 때만 할 수 있는 검사(엔진 개편 E1).
export interface ResumeAction {
  action: string;
  blocker: string | null;
  input?: Record<string, unknown>;
  deferredChecks?: string[];
}
const INTERRUPTED_STATES: ReadonlySet<WorkflowState> = new Set(["FAILED", "USER_DECISION_REQUIRED", "BLOCKED_ON_EVIDENCE"]);
// 재개 정보의 미해결 지적 — 판정 지점이 될 수 있는 결과 산출물(계획 단계·인도 단계)과 인도 작업 체크포인트(host-review a7a9ce86 F-004).
// 러너 보고(구현·수정·체크포인트)의 RESOLVED_BY_FIX 는 리뷰가 확인할 주장이다.
const PLANNING_STAGES: ReadonlySet<string> = new Set(["DRAFT", "CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK", "AWAITING_USER_APPROVAL"]);
const PLANNING_RESULT_KINDS = ["claude-plan", "diagnosis-plan-revision", "audit", "claude-revision", "closeout"] as const;
const DELIVERY_RESULT_KINDS = ["implementation-result", "codex-review", "claude-fix", "codex-final-review"] as const;
const RUNNER_REPORT_KINDS: ReadonlySet<string> = new Set(["implementation-result", "claude-fix"]);
const PAUSE_KEYS = ["planningPause", "budgetPause", "revisionPause", "reviewPause", "admissionRefused"] as const;

// mediator: 배정이 있는 작업에서 수락된 중재자의 배정 신원(참여자·버전·scope) — 배정이 없으면 null(엔진 개편 E1).
// policyVersion: 호출 시점의 공통 중재 정책 버전(sha256) — 작업에 적용한 설정 버전을 기록한다(plan §2.2).
export interface CallOrigin {
  actor: "mediator";
  delegationSetAt: string | null;
  mediator?: MediatorIdentity | null;
  policyVersion?: string | null;
}

export interface WorkflowDependencies {
  database: ConsensusDatabase;
  artifacts: ArtifactStore;
  verifications?: { receipts(topicId: string): Promise<{ text: string; readablePaths: string[] }> };
  git: GitService;
  claude: AgentAdapter;
  codex: AgentAdapter;
  memory?: ProjectMemoryWriter;
  // 사용 한도 자동 재시도의 시계(테스트 주입용). 기본은 실제 setTimeout(unref).
  clock?: RetryClock;
  executionLimits?: ExecutionLimits;
  enforceBudgets?: boolean;
  // 중재자 유지보수 잠금 파일(도구 트리 교체·서버 교체 중). 있으면 새 실행을 시작하지 않는다(2026-09-14 Codex 감사 R04).
  maintenanceLockPath?: string;
}

// 범위 변경을 허용하는 상태. WorkflowState가 늘어나면 이 표가 컴파일을 막아 새 상태를 의식적으로 판단하게 만든다.
const SCOPE_CHANGE_ALLOWED_STATES: Readonly<Record<WorkflowState, boolean>> = {
  DRAFT: true,
  CLAUDE_PLAN: true,
  CODEX_AUDIT: true,
  CLAUDE_REVISION: true,
  CODEX_CLOSEOUT: true,
  CONSENSUS_ACK: true,
  AWAITING_USER_APPROVAL: true,
  IMPLEMENTING: true,
  CODEX_REVIEW: true,
  CLAUDE_FIX: true,
  CODEX_FINAL_REVIEW: true,
  READY_TO_DELIVER: true,
  BLOCKED_ON_EVIDENCE: true,
  USER_DECISION_REQUIRED: true,
  FAILED: true,
  CLOSED: false,
};

// 공개 API 파사드. 흐름은 PlanningPipeline·DeliveryPipeline, 공유 상태·프리미티브는 EngineCore가 갖는다
// (2026-08-31 분해 — 한 클래스가 전부 소유해 순서 결함이 반복된다는 Codex 진단).
export class WorkflowEngine {
  private readonly core: EngineCore;
  private readonly planning: PlanningPipeline;
  private readonly delivery: DeliveryPipeline;
  private readonly usageLimitRetry: UsageLimitRetryScheduler;

  constructor(dependencies: WorkflowDependencies) {
    this.core = new EngineCore(dependencies);
    this.planning = new PlanningPipeline(this.core);
    this.delivery = new DeliveryPipeline(this.core);
    this.usageLimitRetry = new UsageLimitRetryScheduler(this.core, (topicId) => this.retry(topicId), dependencies.clock);
    this.core.failureObserver = (topicId, message) => this.usageLimitRetry.consider(topicId, message);
    this.core.actionObserver = (topicId) => this.usageLimitRetry.cancel(topicId);
  }

  // 재시작 뒤 FAILED 주제의 사용 한도 예약을 복원한다(listen 성공 뒤 호출). 복원한 건수를 돌려준다.
  restoreScheduledRetries(): number {
    return this.usageLimitRetry.restore();
  }

  scheduledRetryAt(topicId: string): string | null {
    return this.usageLimitRetry.scheduledAt(topicId);
  }

  async attachParticipant(
    topicId: string,
    role: ParticipantRole,
    input: { mode: "new" } | { mode: "attach"; sessionId: string },
    requestKey?: string,
  ): Promise<Topic> {
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state !== "DRAFT") throw new Error("세션 연결은 계획 실행 전에만 바꿀 수 있습니다.");
    const generation = topic.scopeGeneration;
    const adapter = this.core.adapter(role);
    let participant: Participant;
    if (input.mode === "attach") {
      if (!await adapter.validateExistingSession(input.sessionId)) throw new Error(`${role} 세션을 확인할 수 없습니다.`);
      const current = this.core.dependencies.database.getTopic(topicId);
      if (current.state !== "DRAFT" || current.scopeGeneration !== generation) {
        throw new Error("세션을 확인하는 동안 합의가 시작되었거나 범위가 바뀌었습니다.");
      }
      if (this.core.dependencies.database.participantSessionInUse(topicId, role, input.sessionId)) {
        throw new Error("이 에이전트 세션은 다른 주제에서 이미 사용 중입니다.");
      }
      participant = { role, sessionId: input.sessionId, mode: "attached", acknowledgedPlanSHA256: null };
    } else {
      participant = { role, sessionId: `pending:${randomUUID()}`, mode: "created", acknowledgedPlanSHA256: null };
    }
    this.core.dependencies.database.upsertParticipant(topicId, participant);
    this.core.event(topicId, "system", "system", `${role} ${input.mode === "new" ? "새" : "기존"} 세션을 연결했습니다.`, {
      role, mode: input.mode,
      ...(requestKey ? { requestKey, requestAction: `participant:${role}` } : {}),
    });
    return this.core.dependencies.database.getTopic(topicId);
  }

  updateAgentSettings(
    topicId: string,
    role: ParticipantRole,
    settings: AgentExecutionSettings,
    requestKey?: string,
  ): Topic {
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state === "CLOSED") throw new Error("닫은 주제의 에이전트 설정은 바꿀 수 없습니다.");
    const label = role === "claude" ? "Claude" : "Codex";
    const changes = role === "claude"
      ? {
          claudeModel: settings.model, claudeEffort: settings.effort,
          claudeImplModel: settings.implementation?.model ?? null,
          claudeImplEffort: settings.implementation?.effort ?? null,
        }
      : {
          codexModel: settings.model, codexEffort: settings.effort,
          codexImplModel: settings.implementation?.model ?? null,
          codexImplEffort: settings.implementation?.effort ?? null,
        };
    return this.core.dependencies.database.applyTopicTransition({
      topicId,
      changes,
      events: [{
        actor: "system",
        kind: "system",
        state: topic.state,
        // 구현 오버라이드도 같이 적는다 — 계획 모델만 적으면 "runner 를 sonnet 으로" 같은 변경이 타임라인에 안 보인다(2026-09-08 실측).
        body: `${label} 설정을 ${settings.model} / ${settings.effort}${settings.implementation
          ? ` (구현 ${settings.implementation.model} / ${settings.implementation.effort})`
          : " (구현 오버라이드 없음)"}로 바꿨습니다. 현재 실행 중인 호출은 그대로 두고 다음 ${label} 호출부터 적용합니다.`,
        payload: {
          role,
          model: settings.model,
          effort: settings.effort,
          ...(requestKey ? { requestKey, requestAction: `participant-settings:${role}` } : {}),
        },
      }],
    });
  }

  async migrateInterruptedPlanning(topicId: string, input: PlanningMigration, requestKey: string, origin?: CallOrigin) {
    const db = this.core.dependencies.database;
    const snapshot = () => {
      this.core.assertNotShuttingDown();
      this.core.assertNoActiveWork(topicId);
      const topic = db.getTopic(topicId);
      db.planning.assertMigration(topic, input);
      if (db.participantSessionInUse(topicId, "claude", input.sessionId)) throw new Error("Session belongs to another topic.");
      return JSON.stringify([topic, db.getFlags(topicId), db.getTimeline(topicId).at(-1)?.sequence]);
    };
    const before = snapshot();
    if (!await this.core.adapter("claude").validateExistingSession(input.sessionId)) throw new Error("Planning session is unavailable.");
    const artifact = await this.core.dependencies.artifacts.verifiedLatest(topicId, "interrupted-output");
    if (!artifact) throw new Error("Interrupted output is unavailable.");
    const output = JSON.parse(artifact.content);
    const topic = db.getTopic(topicId);
    const matchesInit = (row: unknown): boolean => {
      if (!row || typeof row !== "object") return false;
      const value = row as Record<string, unknown>;
      return value.type === "system" && value.subtype === "init" &&
        value.session_id === input.sessionId && value.cwd === topic.worktreePath;
    };
    // Structured output pins initialization even when the bounded stdout tail has evicted it.
    const init = (Array.isArray(output.output?.jsonLines) && output.output.jsonLines.some(matchesInit)) ||
      (typeof output.output?.stdout === "string" && output.output.stdout.split("\n").some((line: string) => {
        try { return matchesInit(JSON.parse(line)); } catch { return false; }
      }));
    if (output.sessionId !== input.sessionId || !init) throw new Error("Interrupted output does not verify this session and worktree.");
    if (snapshot() !== before) throw new Error("Topic changed during migration validation.");
    if (input.apply) db.applyTopicTransition({ topicId, changes: {}, planningMigration: input, events: [{
      actor: "system", kind: "system", state: topic.state,
      body: "중단된 첫 계획을 검증된 기존 세션과 계획 정책 v2로 이전했습니다. 사용 예산과 재작성 횟수는 유지합니다.",
      payload: { planningMigration: input, requestKey, requestAction: "planning:migrate", ...(origin ? { origin } : {}) },
    }] });
    return { version: db.planning.policyVersion(topicId), validated: true, applied: input.apply, ...input };
  }

  assertBudgetEditable(topicId: string): void { this.core.assertNoActiveWork(topicId); }

  startPlan(topicId: string, actionId?: string): string {
    // 원장에 running 행을 만들기 전에 상태를 확인한다. 비동기 work에서 거부하면 이미 끝난 주제까지 FAILED로 덮인다.
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    this.core.requireState(topicId, "DRAFT");
    return this.core.startAction(topicId, "plan", (signal) => this.planning.runPlanningLoop(topicId, signal), actionId);
  }

  startImplementation(topicId: string, actionId?: string, kickoffDecision?: string): string {
    this.implementPreconditions(topicId);
    if (kickoffDecision !== undefined) {
      // 재계획 트리거 단어는 결정 본문에 쓸 수 없다 — retry 사다리가 그 단어로 DRAFT 리셋을 판단한다(2026-09-07 사고).
      if (replanDirective(kickoffDecision)) throw new Error("시작 결정문에는 재계획 트리거 지시(줄 머리 또는 본문 끝의 REPLAN)를 쓸 수 없습니다.");
      // 승인 대기 상태의 postMessage 는 계획을 무효화하므로 여기서 타임라인에 직접 붙인다. 액션 시작 전에
      // 붙어야 첫 구현 프롬프트의 타임라인에 실린다(startAction 은 동기적으로 실행을 예약한다).
      this.core.event(topicId, "user", "decision", kickoffDecision, { kickoff: true });
    }
    return this.core.startAction(topicId, "implement", (signal) => this.delivery.runImplementation(topicId, signal), actionId);
  }

  // 닫힌 주제의 빌드 트리 정리(DerivedData/* 중 *-logs 제외). action 으로 돌려 원장에 남기고 중단할 수 있게 한다.
  archiveBuildTrees(topicId: string, actionId?: string): string {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    const topic = this.core.requireState(topicId, "CLOSED");
    return this.core.startAction(topicId, "archive", async () => {
      const report = await pruneBuildTrees(topic.worktreePath);
      this.core.event(topicId, "system", "system", describePrune(report), {
        buildTreesRemoved: report.removed, buildTreesKept: report.kept, freedBytes: report.freedBytes,
      });
    }, actionId);
  }

  // 서버 종료 순서의 엔진 몫: 새 실행 거부 → 실행 중 action 중단 → 원장 마감 대기. 반환값은 중단한 action 수.
  shutdown(timeoutMs?: number): Promise<number> {
    this.usageLimitRetry.shutdown();
    return this.core.shutdown(timeoutMs);
  }

  // 실행 중이면 중단하고, FAILED 대기 중 예약된 사용 한도 자동 재시도가 있으면 취소한다(Codex 후속 지적 4).
  stop(topicId: string): void {
    const action = this.core.active.get(topicId);
    const cancelledRetry = this.usageLimitRetry.cancelByUser(topicId);
    if (!action) {
      if (cancelledRetry) return;
      throw new Error("중단할 실행이 없습니다.");
    }
    action.controller.abort(new Error("사용자가 실행을 중단했습니다."));
  }

  // retry 의 부작용 전 검사 전부 — retry 와 재개 정보(resumeInfo 의 다음 허용 작업)가 같은 함수를 쓴다(엔진 개편 E1).
  private retryPreconditions(topicId: string) {
    this.core.assertNotShuttingDown();
    this.core.assertBudgetAvailable(topicId);
    // 상태를 바꾸기 전에 다른 작업(실행·범위 변경·인도)이 없는지 본다 — 아래 사다리 일부는 startAction 전에 전이하므로,
    // 잠금을 startAction 에서 뒤늦게 만나면 상태만 바뀐 채 고착된다(Codex 후속 지적 2).
    this.core.assertNoActiveWork(topicId);
    const topic = this.core.dependencies.database.getTopic(topicId);
    const flags = this.core.dependencies.database.getFlags(topicId);
    const resume = flags.resumeState;
    // 공통 진단 상태 검사: 중재자가 처리할 진단(적용 대기·재확인·반박·추가 증거)이 있으면 재개하지 않는다 — 자동 재시도도 이 경로다.
    // 계획 단계 재시도는 전체 재계획이 재확인으로 돌린 진단에 막히지 않는다(host-review R9) — 재개 단계를 함께 넘긴다.
    this.core.diagnoses.assertResumable(topicId, "재시도(retry)", resume);
    const interruption = this.core.dependencies.database.getTimeline(topicId).filter(event =>
      event.scopeGeneration === topic.scopeGeneration && event.actor === "system" && event.payload?.resumeState).at(-1);
    // 리뷰 한도 정지는 **그 리뷰 단계를 재개할 때만** 막는다. 중재자가 resume_state 를 다른 단계(예: 러너가 중간 보고를
    // 완료 형식으로 닫아 리뷰로 넘어간 것을 IMPLEMENTING 으로 되돌림, 2026-09-14 S11)로 바꿨으면 리뷰 승인은 필요 없다.
    if(interruption?.payload?.reviewPause && topic.state==="USER_DECISION_REQUIRED" && interruption.payload.resumeState===resume)
      this.core.dependencies.database.reviews.assertAvailable(topicId,interruption.payload.reviewPause as ReviewScope);
    // 재작성 한도 정지도 **그 계획 단계를 재개할 때만** 막는다 — 정정이 재개 단계를 구현으로 되돌렸으면 쓰지 않을 재작성 승인을 요구하지 않는다(2026-09-15 감사 2차).
    if(interruption?.payload?.revisionPause===true && topic.state==="USER_DECISION_REQUIRED" && interruption.payload.resumeState===resume)
      this.core.dependencies.database.revisions.assertAvailable(topicId,resume==="CLAUDE_PLAN"?"plan":"revision");
    return { topic, resume, interruption };
  }

  retry(topicId: string, actionId?: string): string {
    const preconditions = this.retryPreconditions(topicId);
    let topic = preconditions.topic;
    const { resume, interruption } = preconditions;
    // 실행 환경 때문에 멈춘 정지(예산·한도·spawn 직전 허용 거부: 유지보수 잠금·계획 변경·기준 불일치)는 사람의 제품 결정이 아니다 — 저장된 같은 단계로
    // 재개하고 계획을 다시 만들지 않는다(CF-07: 유지보수 거부 뒤 retry 가 계획부터 다시 만들었다).
    if (topic.state === "USER_DECISION_REQUIRED" && (interruption?.payload?.planningPause === true || interruption?.payload?.budgetPause === true || interruption?.payload?.revisionPause === true || Boolean(interruption?.payload?.reviewPause)
      || typeof interruption?.payload?.admissionRefused === "string")
      && interruption?.payload?.resumeState === resume) {
      // Budget pauses resume the exact infrastructure stage, without consuming a product decision or resetting the plan.
      topic = this.core.dependencies.database.updateTopic(topicId, {state:"FAILED"});
    }
    // 계획 변경 진단(적용됨·개정 저장 전)은 멈춘 단계와 무관하게 진단 계획 개정 턴으로 간다 — 옛 승인 계획으로의 구현 재개나 전체 재계획
    // (restartPlanning)으로 새지 않는다. 한도 정지(재작성·리뷰·예산) 검사는 위에서 이미 거쳤다(한도는 초기화·추가 승인하지 않는다).
    if (this.core.diagnoses.pendingPlanRevision(topicId)) {
      return this.core.startAction(topicId, "retry", (signal) => this.planning.runDiagnosisPlanRevision(topicId, signal), actionId);
    }
    if (!resume) throw new Error("재시도할 단계가 기록되어 있지 않습니다.");
    const migration = this.core.dependencies.database.getTimeline(topicId).filter(e => e.payload?.planningMigration).at(-1)?.payload?.planningMigration as PlanningMigration | undefined;
    if (resume === "CLAUDE_PLAN" && migration && this.core.dependencies.database.planning.continuityEnabled(topicId) &&
        migration.scopeGeneration === topic.scopeGeneration && migration.planEpoch === topic.planEpoch &&
        migration.sessionId === topic.participants.find(p => p.role === "claude")?.sessionId && !topic.planSHA256 &&
        !this.core.dependencies.database.latestArtifact(topicId, "claude-plan")) {
      return this.core.startAction(topicId, "retry", async signal => {
        this.core.dependencies.database.updateTopic(topicId, { state: "DRAFT" });
        await this.planning.runPlanningLoop(topicId, signal);
      }, actionId);
    }
    const planningCheckpoint = this.core.dependencies.database.planning.latest(topicId);
    if (resume === "CLAUDE_PLAN" && planningCheckpoint &&
        (!planningCheckpoint.finalized || (topic.state === "FAILED" && recoverableFinalizedFirstPlan(
          planningCheckpoint, topic, this.core.dependencies.database.getTimeline(topicId)))) &&
        planningCheckpoint.stage === resume && planningCheckpoint.scopeGeneration === topic.scopeGeneration &&
        planningCheckpoint.planEpoch === topic.planEpoch && planningCheckpoint.planSHA256 === topic.planSHA256) {
      return this.core.startAction(topicId, "retry", async signal => {
        this.core.dependencies.database.updateTopic(topicId, { state: "DRAFT" });
        await this.planning.runPlanningLoop(topicId, signal);
      }, actionId);
    }
    // 진단 계획 개정이 저장된 직후(감사 전)에 멈춰 재개 단계가 계획 턴으로 남았으면 저장된 개정 계획으로 감사부터 잇는다 — 전체 재계획으로 떨어져 저장된
    // 개정을 버리고 진단을 재계획 stale 로 돌리지 않는다(2026-09-15 감사).
    if (resume === "CLAUDE_PLAN" && this.core.diagnoses.savedRevisionAwaitingAudit(topicId)) {
      return this.core.startAction(topicId, "retry", (signal) => this.planning.resumeSavedDiagnosisRevision(topicId, signal), actionId);
    }
    // 개정 턴이 결정을 물어 멈췄고 결정이 올라왔다 — 그 개정본을 저장해 종결 확인으로 넘긴다(개정 턴 재구매 방지).
    // 아래 사다리(resumers)가 CLAUDE_REVISION 을 "개정 재실행" 으로 잡기 전에 먼저 본다.
    if (resume === "CLAUDE_REVISION" && this.planning.replanRequested(topicId)) {
      // 사용자가 결정에 REPLAN 을 적었다 — 핵심 전제가 바뀐 경우라 처음부터 다시 돈다(직전 계획 전문은 프롬프트에 실린다).
      return this.restartPlanning(topic, "결정의 REPLAN 지시로 계획 수렴을 처음부터 다시 실행합니다.", actionId);
    }
    if (resume === "CLAUDE_REVISION" && this.planning.pausedRevisionReusable(topicId)) {
      return this.core.startAction(topicId, "retry", (signal) => this.planning.resumePlanningFromPausedRevision(topicId, signal), actionId);
    }
    // 계획 턴이 이미 결과를 낸 뒤 멈췄다면 저장된 산출물로 그 지점부터 재개한다. 계획을 다시 만드는 것은
    // 같은 계획을 또 생성하는 비용일 뿐이다. 저장된 산출물이 없으면 재개 함수가 명시적으로 실패하므로,
    // 조용히 전체 재계획으로 떨어지지 않는다. resetToDraft 경로는 계획 단계 자체가 실패했을 때만 쓴다.
    const stages = ["CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK"] as const;
    const resumeStage = stages.find((stage) => stage === resume);
    if (resumeStage) {
      // 같은 단계로 되돌아갈 수 있으면 그 단계를 다시 돌리고(인프라 실패·증거 보강), 전이표가 막으면
      // 다음 단계로 넘어간다. 사용자 결정으로 멈춘 감사는 재감사가 아니라 개정으로 가는 것이 맞다.
      const resumers = {
        CODEX_AUDIT: (signal: AbortSignal) => this.planning.resumePlanningAtAudit(topicId, signal),
        CLAUDE_REVISION: (signal: AbortSignal) => this.planning.resumePlanningAtRevision(topicId, signal),
        CODEX_CLOSEOUT: (signal: AbortSignal) => this.planning.resumePlanningAtCloseout(topicId, signal),
        CONSENSUS_ACK: (signal: AbortSignal) => this.planning.resumePlanningAtAck(topicId, signal),
      };
      // 각 지점의 전제 산출물. 중단으로 그 턴의 결과가 버려졌으면(예: 감사 도중 새 메시지) 산출물이 없고,
      // 그 상태에서 앞 지점으로 건너뛰면 '결과를 찾을 수 없습니다'에 고착된다(감사 ⑨) — 전제가 없으면
      // 아래 resetToDraft 경로로 떨어뜨려 계획부터 다시 돈다.
      const prerequisites = {
        CODEX_AUDIT: "claude-plan",
        CLAUDE_REVISION: "audit",
        CODEX_CLOSEOUT: "claude-revision",
        CONSENSUS_ACK: "closeout",
      } as const;
      // 후보 순서: 중단된 단계 → 그 뒤 단계들 → 개정. 개정을 꼬리에 두는 이유는 closeout이 사용자 결정으로
      // 멈추는 경우다. 그 상태에서 전이표는 앞으로 가는 길(CODEX_CLOSEOUT·CONSENSUS_ACK)을 모두 막으므로
      // 앞으로만 걷는 사다리는 후보를 못 찾고 전체 재계획으로 떨어진다 — 이미 만든 계획·감사·개정을 통째로
      // 버리는 바로 그 낭비다(2026-08-31 S0.2 실측). 사용자 결정을 실제로 소비하는 단계는 개정이다.
      // 전제 산출물이 없으면 break가 아니라 continue다: 각 후보가 자기 전제를 따로 보므로 앞 지점으로
      // 잘못 건너뛰지 않고(감사 ⑨ 유지), 모든 후보가 탈락하면 아래 재계획 경로로 내려간다.
      const candidates = [...stages.slice(stages.indexOf(resumeStage)), "CLAUDE_REVISION" as const]
        .filter((stage, index, all) => all.indexOf(stage) === index);
      for (const stage of candidates) {
        if (!canTransition(topic.state, stage)) continue;
        if (!this.core.dependencies.database.latestArtifact(topicId, prerequisites[stage])) continue;
        // 결정으로 멈춘 종결(USER_DECISION_REQUIRED)에서 ACK 로 건너뛰는 것은 "처분 되돌림" 가드가 결정으로 확정된 경우뿐이다.
        // 종결이 결정·증거를 요청해 멈춘 경우는 그대로 개정(CLAUDE_REVISION)이 결정을 소비한다(2026-09-13).
        if (stage === "CONSENSUS_ACK" && topic.state === "USER_DECISION_REQUIRED" && !this.planning.closeoutRegressionAdjudicated(topicId)) continue;
        return this.core.startAction(topicId, "retry", resumers[stage], actionId);
      }
    }
    if (resume === "CLAUDE_PLAN" && this.planning.pausedPlanReusable(topicId)) {
      // 계획 턴이 결정을 물어 멈췄고 결정이 올라왔다 — 그 계획을 저장해 감사로 넘긴다(계획 턴 재구매 방지).
      return this.core.startAction(topicId, "retry", (signal) => this.planning.resumePlanningFromPausedPlan(topicId, signal), actionId);
    }
    if (["CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK"].includes(resume)) {
      // 재개할 산출물이 없으면 계획부터 다시 실행하되, 초기화 전에 재작성 한도를 검사한다.
      // 범위 세대는 올리지 않는다. 재시도의 근거가 된 사용자 evidence·decision이 같은 세대에 있어야 새 프롬프트에 실린다.
      return this.restartPlanning(topic, "계획 실행을 처음부터 재시도합니다.", actionId);
    }
    if (["IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW"].includes(resume)) {
      this.core.transition(topicId, resume, "중단된 구현 단계를 재시도합니다.");
      return this.core.startAction(topicId, "retry", (signal) => this.delivery.resumeDelivery(topicId, resume, signal), actionId);
    }
    throw new Error(`재시도를 지원하지 않는 단계입니다: ${resume}`);
  }

  private restartPlanning(topic: Topic, message: string, actionId?: string): string {
    return this.core.startAction(topic.id, "retry", async signal => {
      try { this.core.dependencies.database.revisions.assertAvailable(topic.id, "plan"); }
      catch (error) {
        if (!(error instanceof RevisionBlocked)) throw error;
        if(topic.state!=="USER_DECISION_REQUIRED")this.core.transition(topic.id,"CLAUDE_PLAN","재계획 호출 전 한도를 확인했습니다.");
        this.core.interrupt(topic.id, "USER_DECISION_REQUIRED", error.message, "CLAUDE_PLAN", {revisionPause:true});
        return;
      }
      const pending=await this.core.pendingRepair(topic.id,"CLAUDE_PLAN");
      this.core.assertCurrent(topic.id,signal,topic.scopeGeneration,topic.state);
      if(pending)this.core.dependencies.database.updateTopic(topic.id,{state:"DRAFT"});
      else this.core.resetToDraft(topic, message);
      await this.planning.runPlanningLoop(topic.id, signal);
    }, actionId);
  }

  reviewPaused(topicId:string):ReviewScope|null {
    const db=this.core.dependencies.database,topic=db.getTopic(topicId);
    if(!["FAILED","USER_DECISION_REQUIRED"].includes(topic.state))return null;
    const interruption=db.getTimeline(topicId).filter(e=>e.scopeGeneration===topic.scopeGeneration && e.actor==="system" && e.payload?.resumeState).at(-1);
    if(topic.state==="USER_DECISION_REQUIRED" && !interruption?.payload?.reviewPause && !interruption?.payload?.budgetPause)return null;
    const scope=reviewScope(db.getFlags(topicId).resumeState??"");
    if(!scope)return null;
    const account=db.reviews.account(topicId,scope);
    return account.used>=account.limit?scope:null;
  }

  revisionPaused(topicId: string): boolean {
    const db=this.core.dependencies.database, topic=db.getTopic(topicId);
    const account=db.revisions.account(topicId);
    if(account.used<account.limit)return false;
    const interruption=db.getTimeline(topicId).filter(e=>e.scopeGeneration===topic.scopeGeneration && e.actor==="system" && e.payload?.resumeState).at(-1);
    if(topic.state==="USER_DECISION_REQUIRED" && interruption?.payload?.revisionPause===true)return true;
    if(topic.state==="USER_DECISION_REQUIRED" && !interruption?.payload?.budgetPause)return false;
    const stage=topic.state==="DRAFT" ? "CLAUDE_PLAN" : db.getFlags(topicId).resumeState;
    if(!["DRAFT","FAILED","USER_DECISION_REQUIRED"].includes(topic.state))return false;
    if(stage==="CLAUDE_PLAN")return account.firstPlanUsed || account.historyIncomplete;
    return stage==="CLAUDE_REVISION";
  }

  // 구현 시작의 부작용 전 검사(startAction 의 실행 중 작업 검사 포함) — startImplementation 과 재개 정보가 같은 함수를 쓴다(엔진 개편 E1).
  private implementPreconditions(topicId: string): void {
    this.core.assertNotShuttingDown();
    this.core.diagnoses.assertResumable(topicId, "구현 시작(implement)");
    assertImplementationGate(this.core.dependencies.database.getTopic(topicId));
    this.core.dependencies.database.evidence.assertReady(this.core.dependencies.database.getTopic(topicId));
  }

  // 승인의 검사 — approve 와 재개 정보가 같은 함수를 쓴다(엔진 개편 E1).
  private approvePreconditions(topicId: string, planSHA256: string | null): void {
    const topic = this.core.dependencies.database.getTopic(topicId);
    this.core.dependencies.database.evidence.assertReady(topic);
    if (topic.state !== "AWAITING_USER_APPROVAL" || !planSHA256 || topic.planSHA256 !== planSHA256) {
      throw new Error("현재 승인을 기다리는 계획 해시와 일치하지 않습니다.");
    }
    if (!bothAgentsAcknowledged(topic.participants, planSHA256)) {
      throw new Error("두 에이전트가 같은 계획 해시를 ACK하지 않았습니다.");
    }
  }

  // 중재자 인계용 재개 정보(엔진 개편 E1, plan §2.5 "재개 정보 조회") — 어느 중재자가 읽어도 같은 사실과 같은 다음 작업을 돌려준다.
  // 다음 허용 작업은 실제 액션의 사전 검사 함수를 부작용 없이 호출해 판정한다(규칙표를 따로 두면 액션과 어긋난다).
  async resumeInfo(topicId: string) {
    const db = this.core.dependencies.database;
    const topic = db.getTopic(topicId);
    const flags = db.getFlags(topicId);
    const running = db.runningAction(topicId);
    const timeline = db.getTimeline(topicId).filter(event => event.scopeGeneration === topic.scopeGeneration);
    // 정지의 정본은 topic.lastError·resume_state 다(interrupt·실패 기록이 함께 쓴다). resumeState 이벤트는 그것이 **지금** 정지를 만든 기록일 때만
    // 싣는다 — USER_DECISION_REQUIRED·BLOCKED_ON_EVIDENCE 이고, 같은 재개 단계이며, 그 뒤 상태 전이가 없을 때. FAILED 의 원인은 실패 기록(lastError·
    // 실패 action)이지 옛 정지 요청이 아니다(host-review a7a9ce86 F-007).
    const lastTransition = timeline.filter(event => event.actor === "system" && event.payload?.to !== undefined).at(-1)?.sequence ?? 0;
    const lastPause = timeline.filter(event => event.actor === "system" && event.payload?.resumeState).at(-1) ?? null;
    const interruption = (topic.state === "USER_DECISION_REQUIRED" || topic.state === "BLOCKED_ON_EVIDENCE")
      && lastPause && lastPause.sequence > lastTransition && lastPause.payload?.resumeState === flags.resumeState ? lastPause : null;
    const inputsSinceInterruption = interruption
      ? timeline.filter(event => event.sequence > interruption.sequence && event.actor === "user" && (event.kind === "decision" || event.kind === "evidence")).length
      : null;
    const lastAction = db.latestAction(topicId);
    const stop = INTERRUPTED_STATES.has(topic.state) ? {
      state: topic.state, reason: topic.lastError, resumeState: flags.resumeState ?? null,
      failedAction: topic.state === "FAILED" && lastAction && (lastAction.status === "failed" || lastAction.status === "cancelled")
        ? { id: lastAction.id, kind: lastAction.kind, status: lastAction.status, error: lastAction.error, finishedAt: lastAction.finishedAt } : null,
    } : null;
    const diagnoses = this.listDiagnoses(topicId).filter(record => !CLOSED_DIAGNOSIS_STATUSES.has(record.status))
      .map(record => ({ id: record.id, kind: record.input.kind, status: record.status, mediatorAction: MEDIATOR_PENDING_STATUSES.has(record.status) }));
    // 열린 리뷰 요청은 정본 원장(pendingReviewRequests — 수정 작업 계약과 같은 함수)에서 읽는다(F-006).
    const reviewRequests = pendingReviewRequests(db.getTimeline(topicId), topic.scopeGeneration)
      .map(request => ({ id: request.id, question: request.question, askedAtSequence: request.sequence, answerDecisionSequence: request.answerDecisionSequence ?? null }));
    const findings = await this.resumeFindings(topic, flags.resumeState ?? null);
    const planArtifact = db.latestArtifact(topicId, "plan");
    return {
      topicId: topic.id, title: topic.title, state: topic.state, resumeState: flags.resumeState ?? null,
      scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planRevision: topic.planRevision,
      plan: {
        planSHA256: topic.planSHA256, approvedPlanSHA256: topic.approvedPlanSHA256,
        acknowledged: Object.fromEntries(topic.participants.map(participant => [participant.role, participant.acknowledgedPlanSHA256])),
        path: planArtifact?.path ?? null,
      },
      delivery: { branchName: topic.branchName, committedOID: flags.committedOID ?? null, pushedOID: flags.pushedOID ?? null, orphanCommitOID: flags.orphanCommitOID ?? null },
      runningAction: running ? { id: running.id, kind: running.kind } : null,
      autoRetryAt: this.scheduledRetryAt(topicId),
      stop,
      openRequests: {
        interruption: interruption ? { sequence: interruption.sequence, body: interruption.body, resumeState: interruption.payload?.resumeState ?? null,
          pause: PAUSE_KEYS.filter(key => Boolean(interruption.payload?.[key])) } : null,
        userInputsSinceInterruption: inputsSinceInterruption,
        reviewRequests,
        workRequests: findings.workRequests,
        diagnoses,
      },
      findings: { basis: findings.basis, open: findings.open, errors: findings.errors },
      limits: {
        budget: db.budgets.account(topicId),
        revision: db.revisions.account(topicId), revisionPaused: this.revisionPaused(topicId),
        reviews: [db.reviews.account(topicId, "planning"), db.reviews.account(topicId, "implementation")], reviewPaused: this.reviewPaused(topicId),
      },
      nextActions: this.nextActions(topicId),
      locations: { worktreePath: topic.worktreePath, repositoryPath: topic.repositoryPath, planPath: planArtifact?.path ?? null },
    };
  }

  // 미해결 지적 — 현재 단계(정지면 재개 단계)의 **최신 판정 지점**(그 단계의 가장 최근 결과 산출물 또는 현재 작업 체크포인트)을 골라, 파이프라인이 그
  // 지점에서 쓰는 판정 함수(engine/findingJudgment.ts)를 같은 입력으로 다시 부른다 — 종결은 바퀴 합의(planning.roundKnownFindings), 리뷰는 runReview 의
  // 입력(대조 보고·첫 리뷰·계약 원본·원본 이후 OVERRULE·판정 끝난 신규 id). resume 이 판정을 따로 구현하면 엔진과 어긋난다(host-review dd71c649).
  // 계획 판정 지점은 이 범위 세대의 가장 최근 계획 단계 산출물이다 — 엔진이 멈춘 계획·개정을 재사용할 때 쓰는 기준과 같다(planning.pausedResultReusable:
  // 최초 계획은 결정을 묻고 멈추면 계획 저장 전이라 planSHA256 이 아직 없다). DRAFT 는 판정할 것이 없다. 인도 판정은 현재 계획 산출물 이후의 것만 본다
  // (옛 계획의 리뷰를 지금 판정으로 쓰지 않는다).
  // 판정 지점을 읽거나 판정을 다시 계산하지 못하면 "지적 없음" 으로 바꾸지 않고 오류로 돌려준다.
  private async resumeFindings(topic: Topic, resumeState: string | null) {
    const db = this.core.dependencies.database;
    const stage = INTERRUPTED_STATES.has(topic.state) ? resumeState ?? topic.state : topic.state;
    // 재개 단계를 모르는 정지(재개 단계 없는 FAILED 등)는 두 단계의 판정 지점을 모두 후보로 본다.
    const unknownStage = (INTERRUPTED_STATES as ReadonlySet<string>).has(stage);
    const planningKinds = PLANNING_STAGES.has(stage) || unknownStage;
    const deliveryKinds = !PLANNING_STAGES.has(stage) || unknownStage;
    const planArtifact = db.latestArtifact(topic.id, "plan");
    type Basis = { kind: string; revision: number; path: string; createdAt: string };
    const candidates: Basis[] = [];
    if (planningKinds && stage !== "DRAFT") {
      for (const kind of PLANNING_RESULT_KINDS) {
        const artifact = db.latestArtifact(topic.id, kind);
        if (artifact) candidates.push({ kind, revision: artifact.revision, path: artifact.path, createdAt: artifact.createdAt });
      }
    }
    const errors: string[] = [];
    let workRequests: Array<{ id: string; text: string; askedAfterSequence: number }> = [];
    let workFindings: Finding[] = [];
    let workIsFix = false;
    if (deliveryKinds) {
      const current = (createdAt: string) => !planArtifact || createdAt >= planArtifact.createdAt;
      for (const kind of DELIVERY_RESULT_KINDS) {
        const artifact = db.latestArtifact(topic.id, kind);
        if (artifact && current(artifact.createdAt)) candidates.push({ kind, revision: artifact.revision, path: artifact.path, createdAt: artifact.createdAt });
      }
      // 진행 중인 인도 작업(현재 세대·현재 계획)의 누적 결과와 열린 요청 — 결과 산출물을 저장하기 전에 멈춘 구현·수정의 지적·질문이 여기 있다.
      const artifact = db.latestArtifact(topic.id, WORK_CHECKPOINT_KIND);
      if (artifact) {
        try {
          const checkpoint = await this.core.checkpoints.latest(topic.id);
          if (checkpoint && checkpoint.work.scopeGeneration === topic.scopeGeneration && checkpoint.work.planSHA256 === topic.planSHA256) {
            candidates.push({ kind: WORK_CHECKPOINT_KIND, revision: artifact.revision, path: artifact.path, createdAt: artifact.createdAt });
            workFindings = settleClosedDiagnoses(checkpoint.accumulated, this.core.diagnoses.mediatorClosedIds(topic.id)).findings;
            workIsFix = checkpoint.work.kind === "FIX";
            workRequests = checkpointOpenRequests(checkpoint).map(request => ({ id: request.id, text: request.text, askedAfterSequence: request.askedAfterSequence }));
          }
        } catch (error) {
          // 손상은 "열린 요청·지적 없음" 으로 바꾸지 않고 손상으로 돌려준다(엔진의 다른 읽는 곳과 같은 규칙). 그 밖의 오류는 재개 조회 실패로 올린다.
          if (!(error instanceof CheckpointCorrupt)) throw error;
          errors.push(`작업 체크포인트 #${error.revision} 이 손상돼 열린 요청·지적을 확인할 수 없습니다: ${error.message}`);
        }
      }
    }
    const basis = candidates.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.revision - a.revision)[0] ?? null;
    let open: OpenFinding[] = [];
    if (basis) {
      try {
        if (basis.kind === "closeout") {
          const closeout = await this.core.latestResult(topic.id, "closeout");
          open = closeoutOpenFindings(closeout, judgeCloseout(await this.planning.roundKnownFindings(topic.id), closeout,
            { regressionAdjudicated: this.planning.closeoutRegressionAdjudicated(topic.id) }));
        } else if (basis.kind === "codex-review" || basis.kind === "codex-final-review") {
          const { review, judgment } = await this.delivery.storedReviewJudgment(topic.id, basis.kind);
          open = reviewOpenFindings(review, judgment);
        } else if (basis.kind === "claude-fix" || (basis.kind === WORK_CHECKPOINT_KIND && workIsFix)) {
          // 수정 결과는 수락 가드(contractAcceptance)와 같은 판정 — 열린 수정 작업 계약의 원본 합의를 내린 되돌림을 미해결로 싣는다.
          const findings = basis.kind === "claude-fix" ? await this.runnerFindings(topic.id, "claude-fix") : workFindings;
          const judgment = this.delivery.fixAcceptanceJudgment(topic.id, findings);
          open = judgment ? fixOpenFindings(findings, judgment) : unsettledFindings(findings, { runnerReport: true });
        } else if (basis.kind === WORK_CHECKPOINT_KIND) {
          open = unsettledFindings(workFindings, { runnerReport: true });
        } else if (RUNNER_REPORT_KINDS.has(basis.kind)) {
          open = unsettledFindings(await this.runnerFindings(topic.id, basis.kind), { runnerReport: true });
        } else {
          open = unsettledFindings((await this.core.latestResult(topic.id, basis.kind)).findings);
        }
      } catch (error) {
        errors.push(`${basis.kind} 판정을 다시 계산하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return {
      basis: basis ? { kind: basis.kind, revision: basis.revision, path: basis.path } : null,
      open: open.map(({ finding, reason }) => ({ id: finding.id, severity: finding.severity, title: finding.title,
        disposition: finding.disposition ?? null, requiresUserDecision: finding.requiresUserDecision, reason })),
      errors, workRequests,
    };
  }

  // 러너 보고(구현·수정 결과)의 처분 — 인도 작업 재개와 같이 정정·해결로 닫힌 진단의 옛 처분을 정리한 뒤 판정한다.
  private async runnerFindings(topicId: string, kind: string): Promise<Finding[]> {
    return settleClosedDiagnoses(await this.core.latestResult(topicId, kind), this.core.diagnoses.mediatorClosedIds(topicId)).findings;
  }

  private blocker(check: () => void): string | null {
    try { check(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  nextActions(topicId: string): ResumeAction[] {
    const db = this.core.dependencies.database;
    const topic = db.getTopic(topicId);
    const flags = db.getFlags(topicId);
    if (db.runningAction(topicId) || this.core.active.has(topicId)) return [{ action: "stop", blocker: null }];
    const actions: ResumeAction[] = [];
    if (topic.state === "DRAFT") {
      actions.push({ action: "plan", blocker: this.blocker(() => {
        this.core.assertNotShuttingDown(); this.core.assertNoActiveWork(topicId); this.core.requireState(topicId, "DRAFT");
      }) });
    } else if (INTERRUPTED_STATES.has(topic.state)) {
      if (topic.state === "USER_DECISION_REQUIRED") actions.push({ action: "message:decision", blocker: null });
      if (topic.state === "BLOCKED_ON_EVIDENCE") actions.push({ action: "message:evidence", blocker: null });
      actions.push({ action: "retry", blocker: this.blocker(() => {
        const { resume } = this.retryPreconditions(topicId);
        if (!resume && !this.core.diagnoses.pendingPlanRevision(topicId)) throw new Error("재시도할 단계가 기록되어 있지 않습니다.");
      }) });
      if (this.scheduledRetryAt(topicId)) actions.push({ action: "stop", blocker: null });
    } else if (topic.state === "AWAITING_USER_APPROVAL") {
      if (topic.approvedPlanSHA256 !== topic.planSHA256) {
        actions.push({ action: "approve", input: { planSHA256: topic.planSHA256 }, blocker: this.blocker(() => this.approvePreconditions(topicId, topic.planSHA256)) });
      } else {
        actions.push({ action: "implement", blocker: this.blocker(() => { this.implementPreconditions(topicId); this.core.assertNoActiveWork(topicId); }) });
      }
    } else if (topic.state === "READY_TO_DELIVER") {
      // 리뷰 질문 답변·작업 트리 스냅샷·전달 잠금은 인도 실행이 검사한다(DeliveryPipeline 내부) — 여기서는 호출할 수 있는 검사만 판정하고 나머지를 밝힌다.
      const deliverable = (entry: string) => this.blocker(() => {
        db.evidence.assertReady(topic); this.core.diagnoses.assertDeliverable(topicId, entry);
        if (!topic.branchName) throw new Error("커밋할 작업 브랜치가 없습니다.");
        if (!flags.reviewedHead || !flags.reviewedDiffSHA256) throw new Error("최종 리뷰가 확인한 변경 스냅샷이 없습니다.");
      });
      const deferredChecks = ["리뷰 질문 답변 확인", "작업 트리가 최종 리뷰 스냅샷과 같은지", "전달 잠금"];
      actions.push({ action: "commit", input: { message: null, paths: null }, blocker: deliverable("커밋(commit)"), deferredChecks });
      if (flags.committedOID && flags.pushedOID !== flags.committedOID) actions.push({ action: "push", blocker: deliverable("푸시(push)"), deferredChecks });
      actions.push({ action: "close", blocker: this.blocker(() => this.closePreconditions(topicId)) });
    } else if (topic.state === "CLOSED") {
      actions.push({ action: "archive", blocker: this.blocker(() => { this.core.assertNotShuttingDown(); this.core.assertNoActiveWork(topicId); }) });
    }
    return actions;
  }

  approve(topicId: string, planSHA256: string): Topic {
    this.approvePreconditions(topicId, planSHA256);
    const updated = this.core.dependencies.database.updateTopic(topicId, { approvedPlanSHA256: planSHA256 });
    this.core.event(topicId, "user", "decision", "현재 계획 버전의 구현을 승인했습니다.", { planSHA256 });
    return updated;
  }

  close(topicId: string): Topic {
    this.closePreconditions(topicId);
    return this.core.transition(topicId, "CLOSED", "주제를 닫았습니다.");
  }

  // close 의 부작용 전 검사 전부 — close 와 재개 정보가 같은 함수를 쓴다(엔진 개편 E1).
  private closePreconditions(topicId: string): void {
    this.core.dependencies.database.evidence.assertReady(this.core.dependencies.database.getTopic(topicId));
    if (this.core.active.has(topicId) || this.core.deliveryActive.has(topicId) || this.core.scopeChangeActive.has(topicId)) {
      throw new Error("다른 작업이 끝난 뒤 주제를 닫아 주세요.");
    }
    // 닫으면 전달 잠금이 READY_TO_DELIVER를 요구하는 되돌리기 경로가 영구히 막힌다. 처분 전에는 닫지 않는다.
    if (this.core.dependencies.database.getFlags(topicId).orphanCommitOID) {
      throw new Error("전달하지 못한 로컬 커밋을 먼저 되돌리거나 직접 처분한 뒤 주제를 닫아 주세요.");
    }
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state !== "READY_TO_DELIVER") throw new Error("전달 준비가 끝난 주제만 닫을 수 있습니다.");
    this.core.diagnoses.assertDeliverable(topicId, "주제 닫기(close)");
    const group=this.core.dependencies.database.workGroups.forTopic(topicId);
    if(group && group.links[group.stages.at(-1)!.id]?.topicId!==topicId) {
      const flags=this.core.dependencies.database.getFlags(topicId);
      if(!flags.pushedOID || flags.pushedOID!==flags.committedOID)throw new Error("다음 단계로 넘어가려면 먼저 커밋과 푸시를 완료하세요.");
    }
  }

  // 전달(commit/push/처분) API는 DeliveryPipeline에 위임한다.
  commit(topicId: string, message: string, paths: string[], idempotencyKey?: string): Promise<string> {
    this.core.dependencies.database.evidence.assertReady(this.core.dependencies.database.getTopic(topicId));
    return this.delivery.commit(topicId, message, paths, idempotencyKey);
  }

  push(topicId: string): Promise<string> {
    this.core.dependencies.database.evidence.assertReady(this.core.dependencies.database.getTopic(topicId));
    return this.delivery.push(topicId);
  }

  discardOrphanCommit(topicId: string): Promise<Topic> {
    return this.delivery.discardOrphanCommit(topicId);
  }

  reconcileDelivery(
    topicId: string,
    input: { idempotencyKey: string; outcome: "succeeded" | "failed"; oid?: string },
  ): Promise<Topic> {
    return this.delivery.reconcileDelivery(topicId, input);
  }

  // 구현 도중 허용 오차 개정(2026-09-14 S11). 정지 상태(USER_DECISION_REQUIRED/FAILED, 재개 단계 IMPLEMENTING/CLAUDE_FIX)에서만,
  // 넓히기만 허용한다(assertToleranceWidening). 새 plan 산출물을 쓰고 plan/approved sha 를 그 값으로 옮기며 decision 이벤트를 남긴다 —
  // 이후 enforceTolerance·리뷰 프롬프트·재개 프롬프트(planPath)는 모두 최신 plan 산출물을 읽으므로 새 규칙이 곧바로 적용된다.
  async amendTolerance(topicId: string, input: { tolerance: unknown; reason: string }, requestKey?: string): Promise<Topic> {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    if (this.core.amendmentActive.has(topicId)) throw new Error("허용 오차 개정이 이미 진행 중입니다.");
    this.core.diagnoses.assertNoPlanRevision(topicId, "허용 오차 개정(amend-tolerance)");
    // 개정 자체를 이 주제의 진행 중 작업으로 등록한다 — 읽기(readLatest)와 쓰기 사이에 범위 변경·재개·다른 개정이 끼지 못한다.
    this.core.amendmentActive.add(topicId);
    try {
      const db = this.core.dependencies.database;
      const topic = db.getTopic(topicId);
      const resume = db.getFlags(topicId).resumeState;
      if (!["USER_DECISION_REQUIRED", "FAILED"].includes(topic.state) || !["IMPLEMENTING", "CLAUDE_FIX"].includes(resume ?? ""))
        throw new Error(`허용 오차 개정은 구현·수정 단계가 멈춘 상태에서만 가능합니다(현재 ${topic.state}/${resume ?? "-"}).`);
      // 개정의 바탕은 현재(승인) 계획 sha 의 산출물이다 — 최신 산출물이 저장만 되고 승인되지 않은 개정본이면 그 문구가 감사·승인 없이 승인 계획이 됐다
      // (2026-09-15 감사 2차). 결속한 본문이 현재 sha 와 다르면 개정하지 않는다.
      const { content: previousPlan } = await this.core.requireCurrentPlanArtifact(topicId);
      if (hashPlan(previousPlan) !== topic.planSHA256) {
        throw Object.assign(new Error("현재 계획 sha 와 계획 산출물이 맞지 않아 허용 오차를 개정하지 않습니다 — 계획 상태를 먼저 확인하세요."), { statusCode: 409 });
      }
      const previous = parseTolerancePolicy(previousPlan);
      if (!previous) throw new Error("계획에 허용 오차 블록이 없어 개정할 수 없습니다.");
      const parsed = TolerancePolicySchema.safeParse(input.tolerance);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw new Error(`허용 오차 블록 형식 오류: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown"}`);
      }
      assertToleranceWidening(previous, parsed.data);
      const markdown = normalizePlan(normalizeToleranceBlocks(replaceToleranceBlock(previousPlan, parsed.data)));
      if (!parseTolerancePolicy(markdown)) throw new Error("개정 뒤 계획에서 허용 오차 블록을 다시 읽지 못했습니다.");
      // 저장 직전 세대·계획 버전·상태를 다시 본다(await 사이의 변화 방어) — 산출물 저장의 accept 와 DB 확정 둘 다 같은 조건이다.
      const unchanged = () => {
        const now = db.getTopic(topicId);
        return now.scopeGeneration === topic.scopeGeneration && now.planSHA256 === topic.planSHA256
          && now.approvedPlanSHA256 === topic.approvedPlanSHA256 && now.state === topic.state
          && db.getFlags(topicId).resumeState === resume && !this.core.scopeChangeActive.has(topicId);
      };
      if (!unchanged()) throw new Error("개정 도중 주제의 세대·계획·상태가 바뀌었습니다. 다시 시도하세요.");
      const revision = db.latestArtifactRevision(topicId, "plan") + 1;
      let artifact;
      try {
        artifact = await this.core.dependencies.artifacts.write(topicId, "plan", revision, markdown, { scopeGeneration: topic.scopeGeneration, accept: unchanged });
      } catch (error) {
        if (error instanceof StaleArtifactError) throw new Error("개정 도중 주제의 세대·계획·상태가 바뀌었습니다. 다시 시도하세요.");
        throw error;
      }
      const sha256 = artifact.sha256;
      if (sha256 !== hashPlan(markdown)) throw new Error("개정 계획의 sha 가 산출물과 다릅니다.");
      const addedRules = parsed.data.rules.filter((rule) => !previous.rules.some((old) => old.id === rule.id)).map((rule) => rule.id);
      const addedScope = parsed.data.scopePaths.filter((path) => !previous.scopePaths.includes(path));
      // 두 에이전트의 계획 확인(acknowledgedPlanSHA256)도 새 sha 로 옮긴다 — 개정은 허용 오차 블록만 넓힌 중재자 결정이고,
      // 그 내용은 decision 이벤트와 planPath 로 다음 프롬프트에 실린다. 안 옮기면 재개가 "같은 계획 버전을 확인하지 않았습니다" 로 죽는다.
      const participants = topic.participants
        .filter((participant) => participant.acknowledgedPlanSHA256 === topic.approvedPlanSHA256 || participant.acknowledgedPlanSHA256 === topic.planSHA256)
        .map((participant) => ({ ...participant, acknowledgedPlanSHA256: sha256 }));
      if (!unchanged()) throw new Error("개정 도중 주제의 세대·계획·상태가 바뀌었습니다. 다시 시도하세요.");
      // 계획 sha·승인·participant·이벤트를 한 transaction 으로 확정한다.
      return db.applyTopicTransition({
        topicId,
        changes: { planSHA256: sha256, approvedPlanSHA256: sha256 },
        planningSessionAmendment: { previousSHA256: topic.planSHA256!, nextSHA256: sha256 },
        participants,
        events: [{
          actor: "user", kind: "decision", state: topic.state,
          body: `허용 오차 개정(넓히기, 중재자 결정) — 계획 산출물 ${revision}판 ${sha256.slice(0, 12)}…\n추가 규칙: ${addedRules.join(", ") || "없음"} · 추가 scopePaths: ${addedScope.join(", ") || "없음"}\n\n${input.reason}\n\n적용할 허용 오차 전체:\n${JSON.stringify(parsed.data)}`,
          payload: { toleranceAmendment: { addedRules, addedScope, previousPlanSHA256: topic.planSHA256, planSHA256: sha256, artifactRevision: artifact.revision },
            ...(requestKey ? { requestKey, requestAction: "action:amend-tolerance" } : {}) },
        }],
      });
    } finally {
      this.core.amendmentActive.delete(topicId);
    }
  }

  // 구현 계속 재개 — 리뷰 한도·실패로 멈춘 토픽의 resume 을 IMPLEMENTING 으로 되돌린다(같은 세션·같은 계획, 리뷰 소비량 불변). 그 뒤 retry.
  resumeImplementation(topicId: string, input: ResumeImplementationInput, origin?: CallOrigin): Topic {
    this.core.assertNoActiveWork(topicId);
    this.core.diagnoses.assertResumable(topicId, "구현 재개(resume-implementation)");
    this.core.diagnoses.assertNoPlanRevision(topicId, "구현 재개(resume-implementation)");
    const db = this.core.dependencies.database;
    const topic = db.getTopic(topicId);
    if (topic.state !== input.expectedState) throw new Error(`현재 상태 ${topic.state} 가 요청의 기대 상태 ${input.expectedState} 와 다릅니다.`);
    if (topic.scopeGeneration !== input.expectedScopeGeneration) throw new Error("범위 세대가 요청과 다릅니다 — 낡은 재개 요청입니다.");
    if (!topic.approvedPlanSHA256 || topic.approvedPlanSHA256 !== topic.planSHA256) throw new Error("승인된 계획이 없거나 계획이 바뀌어 구현을 재개할 수 없습니다.");
    if (!db.getFlags(topicId).implementationSessionId) throw new Error("구현 세션이 없어 재개할 수 없습니다(구현 시작을 쓰세요).");
    // 열린 수정 작업에 실린 진단(처분 보고 전)이 있으면 구현으로 되돌리지 않는다 — 되돌리면 그 전달·반박이 묻히고 뒤의 수정 턴이 같은 지시를 다시 실었다
    // (2026-09-15 감사 2차). 재시도가 수정 작업을 이어 반박을 기록하거나 처분을 받는다. 실린 진단이 없으면 열린 계약은 버려진 것으로 남긴다.
    const open = this.core.fixContracts.open(topicId);
    // 계약 도입 전의 수정 작업(열린 계약 없음)은 적용 기록으로 본다 — 멈춘 수정 작업에 실린 처분 전 진단(2026-09-15 감사 3차).
    const carried = open ? this.core.fixContracts.diagnoses(topicId, open)
      : db.getFlags(topicId).resumeState === "CLAUDE_FIX"
        ? [...this.core.diagnoses.forWork(topicId, "CLAUDE_FIX", "work"), ...this.core.diagnoses.forWork(topicId, "CLAUDE_FIX", "diagnosis-fix")] : [];
    if (carried.length > 0) {
      throw Object.assign(new Error(`수정 작업 ${open ? open.contractId : "(계약 도입 전)"} 에 실린 진단 ${carried.map((record) => record.id).join(", ")} 이(가) 처분 보고 전입니다 — 구현으로 되돌리면 `
        + "그 전달·처분이 묻힙니다. 재시도(retry)로 수정 작업을 이어 처분을 받거나, 정정(supersedes)으로 닫은 뒤 재개하세요."), { statusCode: 409 });
    }
    return db.applyTopicTransition({
      topicId, changes: { resumeState: "IMPLEMENTING" }, contracts: open ? [{ ...open, status: "abandoned" as const }] : undefined,
      events: [{ actor: "user", kind: "decision", state: topic.state,
        body: `구현 계속 재개(공식): resume → IMPLEMENTING. ${input.reason}`,
        payload: { implementationResume: { fromState: topic.state, scopeGeneration: topic.scopeGeneration }, ...(origin ? { origin } : {}) } }],
    });
  }

  // ---- 중재자 진단(2026-09-14) — 저장·조회·적용은 DiagnosisService 한곳, 반환은 공통 재시도 사다리(retry)로 한다.
  registerDiagnosis(topicId: string, input: DiagnosisInput, requestKey?: string, origin?: CallOrigin): Promise<DiagnosisRecord> {
    return this.core.diagnoses.register(topicId, input, requestKey, origin);
  }

  listDiagnoses(topicId: string): DiagnosisRecord[] {
    return this.core.diagnoses.list(topicId);
  }

  // null: 적용은 기록했지만 등록된 다른 수정 진단이 적용을 기다려 실행을 열지 않았다(순차 적용 — 마지막 적용이 재개한다).
  applyDiagnosis(topicId: string, diagnosisId: string, request: { requestKey?: string; origin?: CallOrigin; actionId?: string }): Promise<string | null> {
    return this.core.diagnoses.apply(topicId, diagnosisId, request, (id, actionId) => this.retry(id, actionId));
  }

  // 도구 트리 기준 재설정(F04) — 중재자가 tools_sync 로 되돌리거나 새 핀을 배치한 뒤 부른다. 실행 중이면 거부. 유지보수 잠금을 쥔 스크립트의
  // 종료 절차로 부를 때는 잠금 소유 증명(maintenanceLock = 잠금 파일의 pid·at)을 실어 자기 잠금에 막히지 않는다(R3-06).
  async rebaselineToolTree(topicId: string, reason: string, origin?: CallOrigin, maintenanceLock?: MaintenanceLockOwner): Promise<Topic> {
    this.core.assertNoActiveWork(topicId, { maintenanceOwner: maintenanceLock });
    const topic = this.core.dependencies.database.getTopic(topicId);
    const controller = new AbortController();
    const suffix = `${origin ? " (중재자 위임 호출)" : ""}${maintenanceLock ? ` (유지보수 잠금 소유자 pid ${maintenanceLock.pid})` : ""}`;
    await this.delivery.writeToolTreeBaseline(topic, controller.signal, `${reason}${suffix}`);
    return this.core.dependencies.database.getTopic(topicId);
  }

  async postMessage(
    topicId: string,
    kind: "note" | "evidence" | "decision",
    body: string,
    requestKey?: string,
    origin?: CallOrigin,
  ): Promise<Topic> {
    if (kind === "decision" && this.core.deliveryActive.has(topicId)) {
      throw new Error("커밋 또는 push가 끝난 뒤 사용자 결정을 변경하세요.");
    }
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state === "AWAITING_USER_APPROVAL") {
      // 계획만 무효화하는 경로다. 범위는 그대로이므로 세대·세션·worktree·타임라인을 유지하고
      // planEpoch만 올린다 — 두 에이전트가 같은 대화 위에서 다시 수렴한다.
      // 전체 재계획(계획 주기 +1) — 이전 계획에 묶인 진행 중 진단을 먼저 재확인으로 돌린다. resetToDraft 와 같은 규칙이다
      // (2026-09-15 감사: 승인 대기 중 메시지로 일어나는 재계획만 이 규칙이 빠져, 개정 계획이 승인되지 않은 계획 변경 진단이 새 계획에 전달·해결됐다).
      this.core.diagnoses.staleOnReplan(topic);
      const nextEpoch = topic.planEpoch + 1;
      await this.core.dependencies.artifacts.clearCurrentAliases(topicId);
      // 승인 무효화와 requestKey 마커도 한 transaction이다. scope_change와 같은 이유다.
      return this.core.dependencies.database.applyTopicTransition({
        topicId,
        changes: {
          state: "DRAFT",
          planEpoch: nextEpoch,
          planRevision: 0,
          planSHA256: null,
          approvedPlanSHA256: null,
          lastError: null,
          resumeState: null,
        },
        clearAcknowledgements: true,
        events: [
          {
            actor: "user",
            kind,
            state: "DRAFT",
            body: redactSecrets(body),
            payload: {
              invalidatedPlanSHA256: topic.planSHA256,
              planEpoch: nextEpoch,
              ...(origin ? { origin } : {}), ...(requestKey ? { requestKey, requestAction: `message:${kind}` } : {}),
            },
          },
          {
            actor: "system",
            kind: "system",
            state: "DRAFT",
            body: "합의 뒤 새 메시지가 추가되어 기존 계획 확인과 승인을 취소했습니다. 같은 대화와 세션을 유지한 채 계획 수렴을 다시 시작하세요.",
          },
        ],
      });
    }
    this.core.dependencies.database.appendEvent({
      topicId,
      actor: "user",
      kind,
      state: topic.state,
      body: redactSecrets(body),
      payload: { ...(origin ? { origin } : {}), ...(requestKey ? { requestKey, requestAction: `message:${kind}` } : {}) },
    });
    // 인도 대기의 **모든** 새 결정은 재확인을 거친다(host-review 2026-09-21 R7) — 열린 질문이 없어도 결정이 구현 변경을 요구할 수 있고, 그 판정은 답변 확인자(decisionAssessments)만 내린다.
    // 종전엔 열린 질문이 있을 때만 멈춰, 질문 없이 인도 대기에 이른 주제의 변경 요구가 commit/push 를 그대로 지났다.
    if (kind === "decision" && topic.state === "READY_TO_DELIVER") {
      const reviews = ["codex-review", "codex-final-review"]
        .map(name => this.core.dependencies.database.latestArtifact(topicId, name, topic.scopeGeneration))
        .filter(item => item !== null).sort((a, b) => b.revision - a.revision);
      const resume = reviews[0]?.kind === "codex-final-review" ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW";
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", "새 결정이 기존 리뷰 답변을 바꾸거나 구현 변경을 요구하는지 재확인해야 합니다. 재시도하세요.", resume,
        { reviewDeliveryRecheck: true });
    }
    if ((kind === "evidence" && topic.state === "BLOCKED_ON_EVIDENCE") ||
        (kind === "decision" && topic.state === "USER_DECISION_REQUIRED")) {
      this.core.event(topicId, "system", "system", "새 정보가 추가되었습니다. 재시도를 눌러 해당 단계를 다시 실행하세요.");
    }
    return this.core.dependencies.database.getTopic(topicId);
  }

  async handleScopeChange(topicId: string, body: string, requestKey?: string, origin?: CallOrigin): Promise<Topic> {
    if (this.core.deliveryActive.has(topicId)) throw new Error("커밋 또는 push가 끝난 뒤 범위를 바꿔 주세요.");
    if (this.core.dependencies.database.unknownDeliveryAction(topicId)) {
      // 미확정 commit/push 확인은 git await 사이에 낀다. 그 사이 세대가 올라가면 이전 세대의 OID가
      // 새 세대에 기록된다(감사 ② 재현) — 확인이 끝날 때까지 범위 변경을 막는다.
      throw new Error("결과가 불명확한 commit 또는 push가 있습니다. 전달 결과를 먼저 확인한 뒤 범위를 바꿔 주세요.");
    }
    if (this.core.scopeChangeActive.has(topicId)) throw new Error("이미 범위를 바꾸고 있습니다.");
    if (this.core.amendmentActive.has(topicId)) throw new Error("허용 오차 개정이 진행 중입니다. 끝난 뒤 범위를 바꿔 주세요.");
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state === "CLOSED") {
      throw new Error("이미 닫은 주제는 범위를 바꿀 수 없습니다. 새 주제를 만들어 주세요.");
    }
    if (!SCOPE_CHANGE_ALLOWED_STATES[topic.state]) {
      throw new Error(`${topic.state} 상태에서는 범위를 바꿀 수 없습니다.`);
    }
    this.core.scopeChangeActive.add(topicId);
    // 범위 변경은 새 사건이다 — 예약된 자동 재시도와 그 지속 상태를 지운다(잠금 중 발화하면 fire 가 건너뛴다).
    this.usageLimitRetry.reset(topicId);
    try {
      const nextGeneration = topic.scopeGeneration + 1;
      const needsFreshWorktree = Boolean(topic.branchName) || [
        "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW", "READY_TO_DELIVER",
      ].includes(topic.state);
      let worktreePath = topic.worktreePath;
      if (needsFreshWorktree) {
        const stem = basename(topic.worktreePath).replace(/-g\d+(?:-[a-f0-9]+)?$/, "");
        worktreePath = join(dirname(topic.worktreePath), `${stem}-g${nextGeneration}-${randomUUID().slice(0, 6)}`);
        await this.core.dependencies.git.createDetachedWorktree(topic.repositoryPath, worktreePath, topic.baseRef);
        const current = this.core.dependencies.database.getTopic(topicId);
        if (current.scopeGeneration !== topic.scopeGeneration || current.state !== topic.state) {
          throw new Error("범위를 바꾸는 동안 주제 상태가 달라졌습니다. 새로 만든 worktree는 보존했습니다.");
        }
      }
      await this.core.stopIfRunning(topicId);
      const previous = this.core.dependencies.database.getFlags(topicId);
      // 강한 격리: 범위가 실제로 바뀌면 두 에이전트 세션도 새로 만든다. --resume으로 이어지는 세션 기억이
      // 이전 범위의 대화를 그대로 갖고 있기 때문이다. 계획만 무효화하는 note/evidence 경로는 세션을 유지한다.
      const previousSessions: Record<string, string> = {};
      const resetParticipants = topic.participants.map((participant) => {
        previousSessions[participant.role] = participant.sessionId;
        return {
          role: participant.role,
          sessionId: `pending:${randomUUID()}`,
          mode: "created" as const,
          acknowledgedPlanSHA256: null,
        };
      });
      // 별칭 정리는 transaction 앞에 둔다. 지워진 별칭은 언제든 다시 만들어지지만,
      // 세대가 오른 뒤 별칭이 남는 쪽은 이전 세대 파일을 최신처럼 보이게 한다.
      await this.core.dependencies.artifacts.clearCurrentAliases(topicId);
      // 세대·세션 변경과 requestKey 마커가 한 transaction으로 묶인다. 사이에 서버가 죽으면
      // 재시작 복구가 "마커 없음 = 미실행"으로 오판해 새 키 재시도가 세대를 한 번 더 올리기 때문이다.
      const updated = this.core.dependencies.database.applyTopicTransition({
        topicId,
        changes: {
          state: "DRAFT",
          scopeGeneration: nextGeneration,
          planEpoch: topic.planEpoch + 1,
          planRevision: 0,
          planSHA256: null,
          approvedPlanSHA256: null,
          branchName: null,
          implementationBaseOID: null,
          worktreePath,
          lastError: null,
          fixPassUsed: false,
          resumeState: null,
          implementationSessionId: null,
          implementationPromptSequence: null,
          reviewedHead: null,
          reviewedDiffSHA256: null,
          committedOID: null,
          pushedOID: null,
          orphanCommitOID: null,
        },
        clearAcknowledgements: true,
        participants: resetParticipants,
        events: [
          {
            actor: "user",
            kind: "scope_change",
            state: "DRAFT",
            body: redactSecrets(body),
            payload: redactRecord({
              scopeGeneration: nextGeneration,
              worktreePath,
              previousWorktreePath: topic.worktreePath,
              previousBranchName: topic.branchName,
              previousCommittedOID: previous.committedOID,
              previousPushedOID: previous.pushedOID,
              previousOrphanCommitOID: previous.orphanCommitOID,
              previousSessions,
              ...(origin ? { origin } : {}),
              ...(requestKey ? { requestKey, requestAction: "message:scope_change" } : {}),
            }),
          },
          {
            actor: "system",
            kind: "system",
            state: "DRAFT",
            body: "범위 세대가 올라갔습니다. 이전 세대의 대화와 에이전트 응답은 다음 프롬프트에 들어가지 않고, 두 에이전트 세션도 새로 시작합니다. 계속 필요한 근거와 결정은 이 세대에 다시 남겨 주세요. 기존 세션을 다시 쓰려면 연결을 바꿔 주세요.",
          },
        ],
      });
      return updated;
    } finally {
      this.core.scopeChangeActive.delete(topicId);
    }
  }
}
