import { stableJSON } from "./evidence/store.js";
import { EvidenceAdmissionExpired } from "./evidence/scheduler.js";
import {reviewScope,type ReviewScope} from "../shared/reviews.js";
import { sha256 } from "../shared/workflow.js";
import { currentStopEvent, isRetryPoint, resetCycle, stopRecord, RESOURCE_PAUSE_KEYS } from "../shared/workflowLifecycle.js";
import { ReviewBlocked } from "./reviewLedger.js";
import { BudgetBlocked } from "./budgetLedger.js";
import { createHash, randomUUID } from "node:crypto";
import { describePrune, pruneBuildTrees } from "./buildTrees.js";
import { basename, dirname, join } from "node:path";
import {
  REENTRY_POINTS,
  type ReentryPoint,
  type ResumeImplementationInput,
  type ResumeInput,
  type ReturnToPlanningInput,
  type SessionReplacement,
  type AgentExecutionSettings,
  type Participant,
  type Topic,
  type WorkflowModeInput,
  type WorkflowState,
} from "../shared/contracts.js";
import {
  assertImplementationGate,
  assertTransition,
  isDeliveryResumeState,
  redactSecrets, workflowModeResumePoint } from "../shared/workflow.js";
import { ArtifactStore } from "./artifacts.js";
import { ConsensusDatabase } from "./database.js";
import { GitService } from "./git.js";
import { redactRecord } from "./security.js";
import type { AgentAdapter, ExecutionLimits, ParticipantRole, ProjectMemoryWriter } from "./types.js";
import { isTopicGroup, workEntry } from "../shared/topicStructure.js";
import { assertTask, assertEntryReady, hierarchyContext } from "./topicStructure.js";
import { conflict, EngineCore, type AdmissionRelease, type MaintenanceLockOwner } from "./engine/core.js";
import { PlanningPipeline } from "./engine/planning.js";
import { BrainstormPipeline } from "./engine/brainstorm.js";
import { BrainstormDecisionSchema, BrainstormInputSchema, brainstormReplies, latestBrainstormRound } from "../shared/brainstorm.js";
import { DeliveryPipeline } from "./engine/delivery.js";
import { UsageLimitRetryScheduler, type RetryClock } from "./engine/usageLimitRetry.js";
import { bindingOf, describeBinding, legacyBinding, resolveRoute, sameBinding, UnsupportedRoute, type SessionBinding, type TurnRoute } from "./turnRouting.js";

// 호출 주체 — 브라우저 사용자(기본)와 중재 세션(x-consensus-actor: mediator, 자율중재는 항상 ON). 이벤트 payload 에 남긴다(D03).
import { CLOSED_DIAGNOSIS_STATUSES, MEDIATOR_PENDING_STATUSES, type DiagnosisRecord } from "../shared/diagnoses.js";
import type { MediatorIdentity, TurnJob } from "../shared/roles.js";
import type { StageDecision, StageResult } from "../shared/workGroups.js";
import { resolvePriorResults } from "./workGroupService.js";
import { migrateLegacyWorkflow, type WorkflowMigrationResult } from "./workflowMigration.js";
import type { TimelineEvent } from "../shared/contracts.js";
import type { VerificationProfileId } from "../shared/planChecks.js";
import type { VerificationOutcome } from "./verifications.js";
// 재개 정보의 다음 허용 작업 — blocker 는 실제 액션의 사전 검사가 던지는 문구, deferredChecks 는 실행 때만 할 수 있는 검사(엔진 개편 E1).
export interface ResumeAction {
  action: string;
  blocker: string | null;
  input?: Record<string, unknown>;
  deferredChecks?: string[];
}
const INTERRUPTED_STATES: ReadonlySet<WorkflowState> = new Set(["FAILED", "USER_DECISION_REQUIRED"]);
// 계획으로 돌아가기를 받는 상태(계약 v3.17 (28)) — 실행 중 상태에서는 거부한다.
const RETURN_TO_PLANNING_STATES: ReadonlySet<WorkflowState> = new Set(["USER_DECISION_REQUIRED", "FAILED", "AWAITING_USER_APPROVAL", "READY_TO_DELIVER"]);
const SESSION_ROLE_LABEL: Readonly<Record<SessionReplacement["role"], string>> = {
  planner: "계획 작성자", "plan-reviewer": "계획 리뷰어", implementer: "구현자", "code-reviewer": "코드 리뷰어",
};
const PAUSE_KEYS = RESOURCE_PAUSE_KEYS;
// 좌석의 대표 job(E2b) — 좌석 세션을 연결할 때 그 세션이 어느 공급자의 것이어야 하는지 정하는 기준. 'claude' 좌석은 이 세션을 처음 이어 쓰는
// 계획 턴(계획자), 'codex' 좌석은 감사 턴(검토자)이다. 배정이 없으면 좌석 이름과 같은 공급자다(turnRouting.ts 기본 배정).
const SEAT_JOB: Readonly<Record<ParticipantRole, TurnJob>> = {
  claude: { role: "planner", operation: "plan" },
  codex: { role: "reviewer", operation: "audit" },
};

// mediator: 배정이 있는 작업에서 수락된 중재자의 배정 신원(참여자·버전·scope) — 배정이 없으면 null(엔진 개편 E1).
// policyVersion: 호출 시점의 공통 중재 정책 버전(sha256) — 작업에 적용한 설정 버전을 기록한다(plan §2.2).
export interface CallOrigin {
  actor: "mediator";
  delegationSetAt: string | null;
  mediator?: MediatorIdentity | null;
  policyVersion?: string | null;
}

// 서버 프로세스가 중첩 샌드박스를 만들 수 있는지(부팅 때 app.ts probeNestedSandbox 가 한 번 판정). 샌드박스 안에서 뜬 서버는 자식이 새 seatbelt 를
// 적용하지 못해 러너 Bash(Claude Code sandbox)와 Codex 새 세션(fs sandbox helper)이 exit 71 로 죽는다(2026-09-28~29 실측).
export type HostSandboxStatus =
  | { kind: "available" }
  | { kind: "not-applicable"; detail: string }
  | { kind: "unavailable"; detail: string };

export interface WorkflowDependencies {
  database: ConsensusDatabase;
  artifacts: ArtifactStore;
  // 계획 필수 검사의 엔진 실행(수락 경계 게이트)과 리뷰 영수증 — VerificationService.
  verifications?: {
    receipts(topicId: string, declared?: readonly VerificationProfileId[]): Promise<{ text: string; readablePaths: string[] }>;
    ensure(topicId: string, profileId: VerificationProfileId, signal?: AbortSignal): Promise<VerificationOutcome>;
  };
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
  // 부팅 때 판정한 중첩 샌드박스 가능 여부. unavailable 이면 러너·Codex 를 spawn 하지 않는다. 없으면 판정하지 않은 것(테스트).
  hostSandbox?: HostSandboxStatus;
}

// 범위 변경을 허용하는 상태. WorkflowState가 늘어나면 이 표가 컴파일을 막아 새 상태를 의식적으로 판단하게 만든다.
const SCOPE_CHANGE_ALLOWED_STATES: Readonly<Record<WorkflowState, boolean>> = {
  DRAFT: true,
  BRAINSTORM_READY: true,
  BRAINSTORMING: true,
  CLAUDE_PLAN: true,
  CODEX_AUDIT: true,
  CLAUDE_REVISION: true,
  AWAITING_USER_APPROVAL: true,
  IMPLEMENTING: true,
  CODEX_REVIEW: true,
  CLAUDE_FIX: true,
  READY_TO_DELIVER: true,
  USER_DECISION_REQUIRED: true,
  FAILED: true,
  CLOSED: false,
};

// 공개 API 파사드. 흐름은 PlanningPipeline·DeliveryPipeline, 공유 상태·프리미티브는 EngineCore가 갖는다
// (2026-08-31 분해 — 한 클래스가 전부 소유해 순서 결함이 반복된다는 Codex 진단).
export class WorkflowEngine {
  onSettled?: () => void;
  private readonly core: EngineCore;
  private readonly planning: PlanningPipeline;
  private readonly brainstorming: BrainstormPipeline;
  private readonly delivery: DeliveryPipeline;
  private readonly usageLimitRetry: UsageLimitRetryScheduler;
  // 결과 확인(git) 중인 묶음 단계 닫기 — 같은 단계를 두 번 동시에 닫지 않는다.
  private readonly stageClosing = new Set<string>();

  constructor(dependencies: WorkflowDependencies) {
    this.core = new EngineCore(dependencies);
    this.core.settledObserver = () => this.onSettled?.();
    this.planning = new PlanningPipeline(this.core);
    this.brainstorming = new BrainstormPipeline(this.core);
    this.delivery = new DeliveryPipeline(this.core);
    this.usageLimitRetry = new UsageLimitRetryScheduler(this.core, (topicId) => this.retry(topicId), dependencies.clock);
    this.core.failureObserver = (topicId, message) => this.usageLimitRetry.consider(topicId, message);
    this.core.actionObserver = (topicId) => {
      this.usageLimitRetry.cancel(topicId);
      dependencies.database.evidence.resumes.cancel(topicId);
    };
  }

  private mediatorBinding(topicId: string): string {
    return stableJSON(this.core.dependencies.database.roles.effective(topicId, "mediator"));
  }

  private armEvidenceResume(topicId: string, resumeState: WorkflowState): void {
    const db = this.core.dependencies.database;
    db.evidence.resumes.arm(db.getTopic(topicId), resumeState, this.mediatorBinding(topicId));
    this.core.event(topicId, "system", "system", "근거 수집이 완료되면 기존 실행 조건을 확인하고 자동 재개합니다. 중지하면 예약을 취소합니다.",
      { evidenceResume: { pending: true, resumeState } });
  }

  pollEvidenceAssessments(): void {
    const db = this.core.dependencies.database;
    if (this.core.shuttingDown) return;
    for (const intent of db.evidence.resumes.list()) {
      const topic = db.getTopic(intent.topicId);
      if (topic.scopeGeneration !== intent.scopeGeneration || topic.planEpoch !== intent.planEpoch ||
          topic.planSHA256 !== intent.planSHA256 || this.mediatorBinding(topic.id) !== intent.mediator ||
          topic.state !== "DRAFT" || db.getAction(intent.actionId)) {
        db.evidence.resumes.cancel(topic.id); continue;
      }
      // Existing topic/resource locks govern admission; unrelated topics may continue concurrently.
      if (!this.canPublishEvidence(topic.id)) continue;
      const evidence = db.evidence.topic(topic);
      // root 원문 승인(ready, 사용자 권한)만 기다린다 — 원문 영향 심사(reviewed)는 없다(D6, 계약 v3.17 (35)).
      if (!evidence.ready) continue;
      try {
        this.core.assertBudgetAvailable(topic.id);
        if (topic.state === "DRAFT" && intent.resumeState === "DRAFT") this.startPlan(topic.id, intent.actionId);
        else db.evidence.resumes.cancel(topic.id);
      } catch (error) {
        db.evidence.resumes.cancel(topic.id);
        this.core.event(topic.id, "system", "system", `근거 수집 후 자동 재개가 실행 조건에 막혔습니다: ${error instanceof Error ? error.message : String(error)}`,
          { evidenceResume: { blocked: true } });
      }
    }
    this.onSettled?.();
  }

  assertContinuationIdle(topicId: string): void {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
  }

  // The workflow, not the durable scheduler, owns phase eligibility and recovery preconditions.
  continuationAdmission(topicId: string, planSHA256: string): "approved-plan" | "delivery-ready" | "recover-delivery" {
    this.assertContinuationIdle(topicId);
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.planSHA256 !== planSHA256) throw new Error("현재 계획에 대해서만 자동 진행을 요청할 수 있습니다.");
    if (topic.state === "AWAITING_USER_APPROVAL") return "approved-plan";
    if (topic.state === "READY_TO_DELIVER") return "delivery-ready";
    this.assertApprovedDeliveryRecovery(topicId, planSHA256);
    return "recover-delivery";
  }

  private assertApprovedDeliveryRecovery(topicId: string, planSHA256: string): void {
    const { topic, resume } = this.retryPreconditions(topicId);
    if (topic.state !== "FAILED" || topic.planSHA256 !== planSHA256 || topic.approvedPlanSHA256 !== planSHA256 || !isDeliveryResumeState(resume))
      throw new Error("같은 승인 계획의 중단된 구현·리뷰만 자동 재개할 수 있습니다.");
  }

  resumeApprovedDelivery(topicId: string, planSHA256: string, actionId: string): string {
    // Revalidate after scheduling: no unseen-plan revision can replace the authorized intent.
    this.assertApprovedDeliveryRecovery(topicId, planSHA256);
    return this.retry(topicId, actionId);
  }
  pendingCommitPaths(topicId: string): Promise<string[]> {
    return this.core.dependencies.git.changedPaths(this.core.dependencies.database.getTopic(topicId).worktreePath);
  }
  async assertReviewedLocalDelivery(topicId: string): Promise<void> {
    const { database: db, git } = this.core.dependencies;
    // Group close validates and freezes its own stronger result proof.
    if (db.workGroups.forTopic(topicId)) return;
    const topic = db.getTopic(topicId), flags = db.getFlags(topicId);
    if (!flags.reviewedHead || !flags.reviewedDiffSHA256) throw new Error("로컬 완료를 확인할 최종 리뷰 스냅샷이 없습니다.");
    const current = await git.snapshot(topic.worktreePath, flags.reviewedHead);
    if (current.head !== (flags.committedOID ?? flags.reviewedHead) || current.diffSHA256 !== flags.reviewedDiffSHA256 ||
        (await git.changedPaths(topic.worktreePath)).length) throw new Error("현재 작업 트리가 검토된 로컬 완료 결과와 다릅니다. 변경을 되돌리거나 남긴 채 닫지 않았습니다.");
  }

  canPublishEvidence(topicId: string): boolean {
    try { this.core.assertNoActiveWork(topicId); return true; } catch { return false; }
  }

  // 기존 토픽 이행(D9) — app 초기화가 기동 복구 뒤, 자동 재개 장치(사용 한도 복원·자동 진행·원문 재개) 전에 한 번 부른다. 실행을 시작하지 않는다.
  migrateLegacyTopics(): Promise<WorkflowMigrationResult[]> {
    return migrateLegacyWorkflow(this.core.dependencies.database, this.core.planBundle);
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
    if (topic.state !== "DRAFT" && topic.state !== "BRAINSTORM_READY") throw new Error("세션 연결은 계획 실행 전이나 논의 대기 중에만 바꿀 수 있습니다.");
    this.core.assertNoActiveWork(topicId);
    const generation = topic.scopeGeneration;
    let participant: Participant;
    let binding: SessionBinding | undefined;
    if (input.mode === "attach") {
      // 기존 세션은 좌석이 라우팅되는 공급자의 CLI 세션이다 — 그 공급자의 어댑터로 확인하고 그 공급자의 세션 이름공간에서 중복을 본 뒤 바인딩과 함께 저장한다
      // (E2b — 다른 공급자 CLI 에 이 id 를 보내지 않게). 기본 배정에서는 좌석 이름과 같은 공급자라 E2b 이전과 같은 어댑터·검사다.
      const route = this.seatRoute(topic, topic.state === "BRAINSTORM_READY"
        ? { role: SEAT_JOB[role].role, operation: "brainstorm" } as TurnJob : SEAT_JOB[role]);
      if (!await this.core.adapter(route.provider).validateExistingSession(input.sessionId)) {
        throw new Error(`${role} 세션을 확인할 수 없습니다${route.provider === role ? "" : `(${describeBinding(route)} 세션으로 확인)`}.`);
      }
      const current = this.core.dependencies.database.getTopic(topicId);
      this.core.assertNoActiveWork(topicId);
      if (current.state !== topic.state || current.scopeGeneration !== generation) {
        throw new Error("세션을 확인하는 동안 합의가 시작되었거나 범위가 바뀌었습니다.");
      }
      if (this.core.dependencies.database.participantSessionInUse(topicId, route.provider, input.sessionId)) {
        throw new Error("이 에이전트 세션은 다른 주제에서 이미 사용 중입니다.");
      }
      // 같은 공급자가 두 좌석을 맡아도 좌석 세션은 역할마다 따로다(E2b) — 다른 좌석이 쓰는 같은 공급자의 세션을 이 좌석에 붙이지 않는다.
      // 공급자가 다르면 세션 이름공간이 달라 겹쳐도 같은 대화가 아니다(E2b 이전과 같다).
      const shared = current.participants.find((item) => item.role !== role && item.sessionId === input.sessionId
        && (this.core.dependencies.database.participantBinding(topicId, item.role) ?? legacyBinding(item.role)).provider === route.provider);
      if (shared) throw new Error(`이 ${route.provider} 세션은 이 주제의 ${shared.role} 좌석이 쓰고 있습니다 — 역할마다 다른 세션을 연결하세요.`);
      participant = { role, sessionId: input.sessionId, mode: "attached", acknowledgedPlanSHA256: null };
      binding = bindingOf(route);
    } else {
      // pending 새 세션은 바인딩 없이 둔다 — 첫 턴이 세션을 만들 때 그 경로의 바인딩을 함께 저장한다(core.turn).
      participant = { role, sessionId: `pending:${randomUUID()}`, mode: "created", acknowledgedPlanSHA256: null };
    }
    this.core.dependencies.database.upsertParticipant(topicId, participant, binding);
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

  // 좌석 세션을 확인할 공급자(E2b) — 좌석 대표 job 의 배정을 따른다. 배정이 실행할 수 없으면(프로필 없음·설정 오류) 어느 공급자의 세션인지 정할 수 없어
  // 409 로 거부한다(추측해 다른 공급자로 확인하지 않는다).
  private seatRoute(topic: Topic, job: TurnJob): TurnRoute {
    try {
      return resolveRoute(this.core.dependencies.database, topic, job);
    } catch (error) {
      if (!(error instanceof UnsupportedRoute)) throw error;
      throw Object.assign(new Error(`${error.message} 좌석 세션을 어느 공급자로 확인할지 정할 수 없습니다 — 배정을 고친 뒤 다시 시도하세요.`), { statusCode: 409 });
    }
  }

  async changeEvidenceSelection<T>(topicIds: string[] | (() => string[]), change: () => T, guardedIds: () => string[] = () => []): Promise<T> {
    const resolveIds = () => [...new Set(typeof topicIds === "function" ? topicIds() : topicIds)];
    const selected = resolveIds();
    const ids = [...new Set([...selected, ...guardedIds()])];
    for (const id of ids) this.core.assertNoActiveWork(id);
    for (const id of ids) this.core.scopeChangeActive.add(id);
    const db=this.core.dependencies.database,versions=new Map(ids.map(id=>[id,db.evidence.catalog.version(id)]));
    try {
      // 원문 범위 변경은 토픽을 초기화하지 않는다(D6) — 계획·산출물·사람용 현재 사본을 그대로 두고, 바뀐 원문은 사실로 전달된다.
      const currentSelected = resolveIds(), currentIds = [...new Set([...currentSelected, ...guardedIds()])];
      if (currentSelected.length !== selected.length || currentSelected.some(id => !selected.includes(id)) ||
          currentIds.length !== ids.length || currentIds.some(id => !versions.has(id)) ||
          ids.some(id=>db.evidence.catalog.version(id)!==versions.get(id)))
        throw Object.assign(new Error("근거 목록이 바뀌었습니다. 다시 확인하세요."),{statusCode:409});
      return change();
    } finally { for (const id of ids) this.core.scopeChangeActive.delete(id); }
  }
  async publishEvidence<T>(guarded: () => string[], publish: () => T, authorize: (ids: string[]) => void = () => {}): Promise<T> {
    const db = this.core.dependencies.database, ids = new Set<string>();
    const admit = (candidates: string[]) => {
      const added = [...new Set(candidates)].filter(id => !ids.has(id));
      try { for (const id of added) this.core.assertNoActiveWork(id); }
      catch { throw Object.assign(new EvidenceAdmissionExpired("근거 소비 작업이 실행 중입니다. 유휴 상태에서 다시 수집하세요."), { statusCode:409 }); }
      for (const id of added) { ids.add(id); this.core.scopeChangeActive.add(id); }
    };
    try {
      admit(guarded());
      const {result,changed,effects} = db.evidence.catalog.publish(publish, changed => { authorize(changed); admit(changed); });
      // 근거 범위가 바뀐 토픽도 초기화하지 않는다(D6) — 사람용 현재 사본을 지우지 않고, 바뀐 원문은 사실로 전달된다.
      for (const effect of effects) effect();
      return result;
    } finally { for (const id of ids) this.core.scopeChangeActive.delete(id); }
  }
  assertBudgetEditable(topicId: string): void { this.core.assertNoActiveWork(topicId); }

  setGoal(topicId: string, input: { goal: string; evidenceDigest?: string }, origin?: CallOrigin): Topic {
    const db = this.core.dependencies.database;
    this.core.assertNotShuttingDown(); this.core.assertNoActiveWork(topicId);
    const topic = this.core.requireState(topicId, "DRAFT");
    if (topic.planSHA256) throw Object.assign(new Error("현재 계획을 무효화한 뒤 Goal을 변경하세요."), { statusCode: 409 });
    const entry = workEntry(topic);
    if (db.listTopics().some(child => child.parentTopicId === topic.id) &&
        !(entry.mode === "sources" && redactSecrets(input.goal) === entry.goal))
      throw Object.assign(new Error("하위 주제가 생긴 상위 Goal은 고정됩니다. 새 범위는 새 관리 주제로 시작하세요."), { statusCode: 409 });
    if (entry.mode === "sources") {
      db.evidence.assertReady(topic);
      const state = db.evidence.topic(topic);
      if (input.evidenceDigest !== state.digest || !entry.sourceIds.length || entry.sourceIds.some(id => !state.sources.some(source => source.id === id)))
        throw Object.assign(new Error("시작 Source 전체를 검토한 현재 evidenceDigest가 필요합니다."), { statusCode: 409 });
    }
    db.evidence.resumes.cancel(topicId);
    return db.applyTopicTransition({ topicId, changes: { workEntry: { ...entry, goal: redactSecrets(input.goal),
      evidenceDigest: entry.mode === "sources" ? input.evidenceDigest! : null } }, events: [{
      actor: "user", kind: "decision", state: topic.state, body: `Goal: ${redactSecrets(input.goal)}`,
      payload: { goalEstablished: true, previousGoal: entry.goal, evidenceDigest: input.evidenceDigest ?? null, ...(origin ? { origin } : {}) },
    }] });
  }

  private brainstormPreconditions(topicId: string): Topic {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    const topic = this.core.requireState(topicId, "BRAINSTORM_READY");
    if (topic.planSHA256 || this.core.dependencies.database.workGroups.forTopic(topicId)) {
      throw new Error("계획 전의 독립 주제에서만 논의할 수 있습니다.");
    }
    return topic;
  }

  startBrainstorm(topicId: string, input: { message?: string } = {}, actionId?: string): string {
    const parsed = BrainstormInputSchema.parse(input);
    const topic = this.brainstormPreconditions(topicId);
    this.core.requireParticipants(topic);
    this.core.assertBudgetAvailable(topicId);
    return this.core.startAction(topicId, "brainstorm", async signal => {
      if (parsed.message) this.core.dependencies.database.appendEvent({ topicId, actor: "user", kind: "note", state: topic.state, body: redactSecrets(parsed.message) });
      await this.brainstorming.run(topicId, signal, true);
    }, actionId);
  }

  finishBrainstorm(topicId: string, input: { decision: string; goal?: string }, next: "plan" | "close", actionId?: string, origin?: CallOrigin): string {
    const parsed = BrainstormDecisionSchema.parse(input);
    const topic = this.brainstormPreconditions(topicId);
    if (next === "plan" && !isTopicGroup(topic)) {
      this.core.requireParticipants(topic);
      this.core.assertBudgetAvailable(topicId);
    }
    // 논의 전용 배정은 계획 연속성 v2의 시작 세션이 아니다. 다른 배정으로 넘길 때만 새 세션을 예약하고,
    // 이전 세션 신원과 사용자 결정을 상태 전이와 함께 남긴다. 같은 배정의 대화는 그대로 이어 쓴다.
    const handoffs = next === "plan" && !isTopicGroup(topic) ? topic.participants.flatMap(participant => {
      if (!participant.sessionId || participant.sessionId.startsWith("pending:")) return [];
      const route = this.seatRoute(topic, participant.role === "claude" ? { role: "planner", operation: "plan" } : { role: "reviewer", operation: "audit" });
      const stored = this.core.dependencies.database.participantBinding(topicId, participant.role) ?? legacyBinding(participant.role);
      return sameBinding(stored, route) ? [] : [{
        participant: { ...participant, sessionId: `pending:${randomUUID()}`, mode: "created" as const, acknowledgedPlanSHA256: null },
        previous: { sessionId: participant.sessionId, binding: stored }, next: bindingOf(route),
      }];
    }) : [];
    return this.core.startAction(topicId, `brainstorm-${next}`, async signal => {
      const state: WorkflowState = next === "plan" ? "DRAFT" : "CLOSED";
      this.core.dependencies.database.applyTopicTransition({ topicId,
        changes: { state, lastError: null, resumeState: null,
          ...(next === "plan" ? { workEntry: { ...workEntry(topic), goal: redactSecrets(parsed.goal ?? parsed.decision) } } : {}) },
        participants: handoffs.map(handoff => handoff.participant),
        events: [...handoffs.map(handoff => ({ actor: "system" as const, kind: "system" as const, state,
          body: "논의와 계획의 참여자 배정이 달라 계획용 새 세션을 연결합니다. 논의 기록은 계획에 전달합니다.",
          payload: { sessionRebound: { seat: handoff.participant.role, previous: handoff.previous, next: handoff.next } },
        })), { actor: "user", kind: "decision", state, body: redactSecrets(parsed.decision),
          payload: { brainstormConclusion: next, ...(origin ? { origin } : {}) } },
        { actor: "system", kind: "system", state,
          body: next === "plan" && isTopicGroup(topic) ? "논의 결과를 Goal로 확정했습니다. 하위 주제로 나누어 진행하세요."
            : next === "plan" && topic.workflowMode === "planned" ? "사용자가 논의 결과를 바탕으로 계획 작성을 선택했습니다. 기존 발언의 가설·대안은 승인으로 간주하지 않습니다."
            : next === "plan" ? "사용자가 논의 결과로 작업 진행을 선택했습니다(ticket). 다음 행동: implement. 기존 발언의 가설·대안은 승인으로 간주하지 않습니다."
            : "사용자의 결정으로 논의를 마쳤습니다. 계획이나 구현은 시작하지 않습니다." }],
      });
      // planned 는 같은 행동에서 계획 왕복을 연다. ticket 은 DRAFT 에 두고 구현은 중재자의 implement 로만 시작한다(자동 시작 없음, D1).
      if (next === "plan" && !isTopicGroup(topic) && topic.workflowMode === "planned") await this.planning.runPlanningRelay(topicId, signal);
    }, actionId);
  }

  startPlan(topicId: string, actionId?: string): string {
    // 원장에 running 행을 만들기 전에 상태를 확인한다. 비동기 work에서 거부하면 이미 끝난 주제까지 FAILED로 덮인다.
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    const topic = this.core.requireState(topicId, "DRAFT");
    // 계획은 planned 만 쓴다 — ticket 은 계획 없이 implement 로 시작한다(D1). 방식은 workflow-mode 로만 바꾼다.
    if (topic.workflowMode !== "planned") throw conflict("ticket 작업은 계획 없이 implement 로 시작합니다. 계획이 필요하면 workflow-mode 로 planned 를 고르세요.");
    assertTask(topic); assertEntryReady(this.core.dependencies.database, topic);
    this.core.requireParticipants(topic);
    this.assertStageContextCurrent(topicId);
    this.ensureInheritedDecisions(topicId);
    return this.core.startAction(topicId, "plan", async (signal) => {
      // root 원문이 아직 승인되지 않았으면 DRAFT 에 머물고, 승인되면 같은 계획 시작을 자동으로 잇는다 — 사용자가 이미 계획 시작을 요청했다(v3.17 (35)).
      if (!this.core.dependencies.database.evidence.topic(topic).ready) {
        this.armEvidenceResume(topicId, "DRAFT"); return;
      }
      await this.planning.runPlanningRelay(topicId, signal);
    }, actionId);
  }

  // 작업 묶음 단계가 이어받는 결정(선행 단계 동결 결과의 사용자 결정 원문)을 현재 범위 세대 타임라인에 싣는다(E4 보완 F012·F013). 계획 시작 경계(DRAFT,
  // 턴 전)에서 이 세대에 아직 없는 것만 멱등으로 적재한다 — 생성 직후 첫 계획과 범위 변경(새 세대) 뒤 첫 계획이 같은 한 경로를 지나고, 적재가 중간에
  // 끊겨도 다음 경계가 빠진 것만 채운다. 원문은 기존 프롬프트 타임라인(현재 세대)·결정 원문 산출물·참조 페이지 경로가 그대로 전달한다.
  private ensureInheritedDecisions(topicId: string): void {
    const db = this.core.dependencies.database;
    const group = db.workGroups.forTopic(topicId);
    if (!group) return;
    const stageId = Object.entries(group.links).find(([, link]) => link.topicId === topicId)![0];
    const topic = db.getTopic(topicId);
    const present = new Set(db.getScopedTimeline(topicId, topic.scopeGeneration).flatMap(event => {
      const inherited = event.payload?.inheritedDecision as { topicId?: unknown; sequence?: unknown } | undefined;
      return inherited && typeof inherited.topicId === "string" && typeof inherited.sequence === "number" ? [`${inherited.topicId}\0${inherited.sequence}`] : [];
    }));
    for (const entry of db.workGroups.inheritedDecisions(group, stageId)) {
      if (present.has(`${entry.decision.topicId}\0${entry.decision.sequence}`)) continue;
      db.appendEvent({ topicId, state: topic.state, ...db.workGroups.inheritedDecisionEvent(group.id, entry) });
    }
  }

  startImplementation(topicId: string, actionId?: string, kickoffDecision?: string): string {
    this.implementPreconditions(topicId);
    // 시작 결정문은 행동 시작과 같은 transaction 에 남겨 첫 구현 턴의 새 사실로 실린다.
    const kickoff = kickoffDecision === undefined ? [] : [{ actor: "user" as const, kind: "decision" as const,
      state: this.core.dependencies.database.getTopic(topicId).state, body: kickoffDecision, payload: { kickoff: true } }];
    return this.core.startAction(topicId, "implement", (signal) => this.delivery.runImplementationRelay(topicId, signal), actionId, undefined, kickoff);
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
    const cancelledEvidence = this.core.dependencies.database.evidence.resumes.cancel(topicId);
    const cancelledContinuation = this.core.dependencies.database.continuations.cancel(topicId);
    if (cancelledContinuation) this.core.event(topicId, "system", "system", "자동 진행 예약을 중지했습니다.");
    if (cancelledEvidence) this.core.event(topicId, "system", "system", "근거 수집 후 자동 재개 예약을 취소했습니다.", { evidenceResume: { cancelled: true } });
    if (!action) {
      if (cancelledRetry || cancelledEvidence || cancelledContinuation) return;
      throw new Error("중단할 실행이 없습니다.");
    }
    action.controller.abort(new Error("사용자가 실행을 중단했습니다."));
  }

  // retry 의 부작용 전 검사 전부 — retry 와 재개 정보(resumeInfo 의 다음 허용 작업)가 같은 함수를 쓴다(엔진 개편 E1).
  // resumed: 중재자의 정지 지점 재개(resume) — 중재자 실행 대기(waitingFor=mediator)를 근거 게시 없이 잇는다(D7).
  // reentry: 인도 대기의 재진입(F009) — 재개 지점은 기록된 resumeState 가 아니라 중재자가 지정한 단계다. 상태 검사는 resume() 한 곳에서 한다.
  private retryPreconditions(topicId: string, options: { resumed?: boolean; reentry?: ReentryPoint } = {}) {
    this.core.assertNotShuttingDown();
    this.core.assertBudgetAvailable(topicId);
    // 상태를 바꾸기 전에 다른 작업(실행·범위 변경·인도)이 없는지 본다 — 아래 사다리 일부는 startAction 전에 전이하므로,
    // 잠금을 startAction 에서 뒤늦게 만나면 상태만 바뀐 채 고착된다(Codex 후속 지적 2).
    this.core.assertNoActiveWork(topicId);
    this.assertStageContextCurrent(topicId);
    const topic = this.core.dependencies.database.getTopic(topicId);
    const flags = this.core.dependencies.database.getFlags(topicId);
    const resume = options.reentry ?? flags.resumeState;
    if (!resume) throw new Error("재시도할 단계가 기록되어 있지 않습니다.");
    if (!isRetryPoint(resume)) throw new Error(`재시도를 지원하지 않는 단계입니다: ${resume}`);
    if (resume !== "BRAINSTORMING") assertTask(topic);
    const interruption = currentStopEvent(topic, resume ?? null, this.core.dependencies.database.getTimeline(topicId));
    // 중재자 실행 대기(계획·구현·수정·리뷰가 함께 쓰는 정지 표식 waitingFor=mediator)는 그 정지 뒤 실행 근거(evidence)가 올라와야 재개한다. 근거 없이
    // 재개하면 같은 러너·리뷰를 다시 사서 같은 요청을 반복한다(2026-10-06 통합 검증 1fd0cc86: 구현 러너 6회 재호출). 재개 진입점 한 곳에서 막는다 — 자동
    // 재시도(사용 한도)도 이 경로다. 중재자가 재개 단계를 다른 단계로 바꾼 정지는 이 대기가 아니다.
    if (!options.resumed && topic.state === "USER_DECISION_REQUIRED" && interruption?.payload?.waitingFor === "mediator" && interruption.payload.resumeState === resume &&
        !this.core.dependencies.database.getTimeline(topicId, interruption.sequence).some(event => event.actor === "user" && event.kind === "evidence"))
      throw new Error(`중재자 실행 대기 중입니다. 요청한 실행의 근거(evidence)를 올린 뒤 재개하세요 — ${interruption.body}`);
    // 리뷰 한도 정지는 **그 리뷰 단계를 재개할 때만** 막는다. 중재자가 resume_state 를 다른 단계(예: 러너가 중간 보고를
    // 완료 형식으로 닫아 리뷰로 넘어간 것을 IMPLEMENTING 으로 되돌림, 2026-09-14 S11)로 바꿨으면 리뷰 승인은 필요 없다.
    if(interruption?.payload?.reviewPause && topic.state==="USER_DECISION_REQUIRED" && interruption.payload.resumeState===resume)
      this.core.dependencies.database.reviews.assertAvailable(topicId,interruption.payload.reviewPause as ReviewScope);
    return { topic, resume, interruption };
  }

  // admission: 재개(resume)가 넘기는 것 — resumed 표식, 시작하는 행동과 같은 transaction 으로 남길 이벤트(결정문)와 역할 세션 해제(v3.16 (17')).
  // 정지 지점의 같은 역할 턴을 같은 세션으로 다시 연다 — 계획 왕복은 planning.resumePlanning, 구현·리뷰 왕복은 delivery.resumeDeliveryRelay 다. 옛 계획
  // 수렴 사다리(저장 산출물 재생·재계획·REPLAN·근거 개정)는 없다(D8). 옛 재개 지점(CODEX_CLOSEOUT·CONSENSUS_ACK·CODEX_FINAL_REVIEW)은 기동 때 D9
  // 이행(workflowMigration.ts)이 옮긴다.
  retry(topicId: string, actionId?: string, admission: { resumed?: boolean; reentry?: ReentryPoint; events?: Parameters<EngineCore["startAction"]>[5];
    release?: Parameters<EngineCore["startAction"]>[6] } = {}): string {
    const { topic, resume } = this.retryPreconditions(topicId, { resumed: admission.resumed, reentry: admission.reentry });
    const start = (work: (signal: AbortSignal) => Promise<void>, transition?: { to: WorkflowState; message: string }) =>
      this.core.startAction(topicId, "retry", work, actionId, transition, admission.events, admission.release);
    if (resume === "DRAFT") {
      // An interrupted admission has no model stage to replay. Restore configuration
      // without changing scope, participants, checkpoints or buying a planning turn.
      return start(async () => {}, { to: "DRAFT", message: "중단된 실행 준비 상태를 복구했습니다. 세션과 입력을 확인한 뒤 계획을 시작하세요." });
    }
    if (resume === "BRAINSTORM_READY") {
      // 라운드나 사용자 결정을 저장하기 전 종료됐다. 시작 의도를 추측해 AI를 호출하지 않고 선택 화면을 복구한다.
      return start(async () => {
        this.core.transitionWith(topicId, "BRAINSTORM_READY", "논의 대기를 복구했습니다. 다음 행동을 다시 선택해 주세요.", {
          payload: { brainstormCompletedActionId: this.core.active.get(topicId)!.actionId },
        });
      });
    }
    if (resume === "BRAINSTORMING") {
      return start(signal => this.brainstorming.run(topicId, signal, false));
    }
    if (resume === "CLAUDE_PLAN" || resume === "CODEX_AUDIT" || resume === "CLAUDE_REVISION") {
      if (topic.workflowMode !== "planned") {
        throw conflict(`ticket 작업은 계획 단계(${resume})로 재개하지 않습니다. 계획이 필요하면 workflow-mode 로 planned 를 고르세요.`);
      }
      return start(signal => this.planning.resumePlanning(topicId, signal));
    }
    if (resume === "IMPLEMENTING" || resume === "CODEX_REVIEW" || resume === "CLAUDE_FIX") {
      return start(signal => this.delivery.resumeDeliveryRelay(topicId, resume, signal), { to: resume, message: admission.reentry
        ? `인도 대기에서 ${resume} 로 다시 들어갑니다 — 같은 역할 세션으로 엽니다.` : "중단된 구현 단계를 같은 역할 세션으로 재개합니다." });
    }
    throw new Error(`재시도를 지원하지 않는 단계입니다: ${resume}`);
  }

  // 정지 지점 재개(D7) — 결정문(선택)을 남기고 정지 지점에서 잇는다. 결정 기록과 행동 시작은 한 transaction 이다(core.startAction admissionEvents).
  // 재개 대상은 retry 와 같은 사다리다. 중재자 실행 대기(waitingFor=mediator)도 이 호출 하나로 잇는다 — 근거 게시 + retry 두 단계를 요구하지 않는다.
  // 결정문이 없으면 기록 없이 잇는다 — 대기 역할은 아직 받지 않은 사실만 받는다. 일시 오류로 멈춘 FAILED 도 이 호출이 같은 역할 턴을 같은 세션으로 다시
  // 연다(계약 v3.17 (29)). replaceSession 은 그 역할의 세션을 같은 transaction 에서 해제해 다음 턴이 새 세션 첫 턴이 되게 한다(v3.16 (17')).
  // reentry 는 인도 대기(READY_TO_DELIVER)에서 같은 역할 세션의 수정(CLAUDE_FIX, 결정문 필수)·재리뷰(CODEX_REVIEW)로 다시 들어간다(F009) — 세션 교체와 함께 쓰지 않는다.
  resume(topicId: string, input: ResumeInput, actionId?: string, origin?: CallOrigin): string {
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (input.reentry) {
      if (topic.state !== "READY_TO_DELIVER") throw conflict(`재진입(reentry)은 인도 대기(READY_TO_DELIVER)에서만 할 수 있습니다(현재 ${topic.state}).`);
      if (input.replaceSession) throw conflict("재진입(reentry)은 역할 세션 교체(replaceSession)와 함께 쓰지 않습니다 — 재진입은 같은 역할 세션으로 엽니다.");
      if (input.reentry === "CLAUDE_FIX" && input.decision === undefined) {
        throw conflict("수정 재진입(reentry CLAUDE_FIX)에는 무엇을 고칠지 적은 결정문(decision)이 필요합니다.");
      }
    } else if (!INTERRUPTED_STATES.has(topic.state)) {
      throw conflict(`정지 상태(${[...INTERRUPTED_STATES].join("·")})에서만 재개할 수 있습니다(현재 ${topic.state}).`);
    }
    const events: NonNullable<Parameters<EngineCore["startAction"]>[5]> = input.decision === undefined ? [] : [{ actor: "user", kind: "decision",
      state: topic.state, body: input.decision, payload: { resumeDecision: true, ...(origin ? { origin } : {}) } }];
    const replacement = input.replaceSession ? this.sessionReplacement(topic, input.replaceSession, origin) : null;
    // 재진입은 같은 전이 transaction 에서 확정 커밋의 근거 동결을 다시 연다(cd2876b7 F017) — 다음 commit·닫기가 다시 얼린다.
    return this.retry(topicId, actionId, { resumed: true, reentry: input.reentry, events: replacement ? [...events, replacement.event] : events,
      release: replacement?.release ?? (input.reentry ? { reopenEvidence: true } : undefined) });
  }

  // 역할 세션 교체의 해제 범위와 기록(계약 v3.16 (17')). 해제하는 것은 그 역할의 세션 연결뿐이다 — 승인 계획·계획 묶음·작업 트리·원문·산출물·사용량·
  // 다른 역할의 세션·재개 지점은 그대로다. 계획 연속성 토픽에서 planner·implementer 교체는 작성자 좌석(claude) 단위다: 좌석 participant·구현 세션·
  // 연속성 정책을 함께 푼다(따로 풀면 다음 구현 시작이 계획 세션을 다시 구현 세션으로 묶는다). 이전 세션은 사건 previous 에만 남기고 옛 행·사건은 고치지 않는다.
  private sessionReplacement(topic: Topic, input: SessionReplacement, origin?: CallOrigin): {
    event: NonNullable<Parameters<EngineCore["startAction"]>[5]>[number]; release: AdmissionRelease;
  } {
    const db = this.core.dependencies.database;
    const pending = (role: ParticipantRole): Participant => {
      const participant = topic.participants.find(item => item.role === role);
      if (!participant || participant.sessionId.startsWith("pending:")) throw conflict(`교체할 ${SESSION_ROLE_LABEL[input.role]} 세션이 없습니다.`);
      return { ...participant, sessionId: `pending:${randomUUID()}`, mode: "created", acknowledgedPlanSHA256: null };
    };
    const seatPrevious = (role: ParticipantRole) => {
      const participant = topic.participants.find(item => item.role === role);
      return participant && !participant.sessionId.startsWith("pending:")
        ? { sessionId: participant.sessionId, binding: db.participantBinding(topic.id, role) ?? legacyBinding(role) } : null;
    };
    const implementationSessionId = db.getFlags(topic.id).implementationSessionId;
    const implementationPrevious = implementationSessionId
      ? { sessionId: implementationSessionId, binding: db.implementationSessionBinding(topic.id) ?? legacyBinding("claude") } : null;
    const continuity = (input.role === "planner" || input.role === "implementer") && db.planning.continuityEnabled(topic.id);
    let seat: "author" | "plan-review" | "implementation" | "code-review";
    let previous: { sessionId: string; binding: SessionBinding } | null;
    let release: AdmissionRelease;
    if (input.role === "plan-reviewer") {
      seat = "plan-review"; previous = seatPrevious("codex");
      if (!previous) throw conflict(`교체할 ${SESSION_ROLE_LABEL[input.role]} 세션이 없습니다.`);
      release = { participants: [pending("codex")] };
    } else if (input.role === "code-reviewer") {
      const sessionId = db.getCodexReviewSession(topic.id);
      if (!sessionId) throw conflict(`교체할 ${SESSION_ROLE_LABEL[input.role]} 세션이 없습니다.`);
      seat = "code-review"; previous = { sessionId, binding: db.codexReviewSessionBinding(topic.id) ?? legacyBinding("codex") };
      release = { releaseCodeReviewSession: true };
    } else {
      previous = input.role === "planner" ? seatPrevious("claude") : implementationPrevious;
      if (!previous) throw conflict(`교체할 ${SESSION_ROLE_LABEL[input.role]} 세션이 없습니다.`);
      seat = input.role === "planner" || continuity ? "author" : "implementation";
      const author = input.role === "planner" || continuity;
      const authorParticipant = author && seatPrevious("claude") ? [pending("claude")] : [];
      release = {
        ...(authorParticipant.length ? { participants: authorParticipant } : {}),
        ...(input.role === "implementer" || continuity ? { changes: { implementationSessionId: null, implementationPromptSequence: null } } : {}),
        ...(continuity ? { releaseContinuity: true as const } : {}),
      };
    }
    // 작성자 좌석 단위 교체에서 함께 푼 다른 저장의 이전 세션도 남긴다 — 같은 세션이면 한 번만 적는다.
    const alsoReleased = seat === "author" && input.role === "planner" && continuity && implementationPrevious &&
      implementationPrevious.sessionId !== previous.sessionId ? { implementation: implementationPrevious }
      : seat === "author" && input.role === "implementer" && seatPrevious("claude") && seatPrevious("claude")!.sessionId !== previous.sessionId
        ? { author: seatPrevious("claude")! } : {};
    const label = SESSION_ROLE_LABEL[input.role];
    return {
      release,
      event: { actor: "system", kind: "system", state: topic.state,
        body: `중재자가 ${label} 세션을 교체합니다 — 다음 ${label} 턴은 새 세션 첫 턴으로 엽니다. 사유: ${input.reason}`
          + (continuity ? " 계획 연속성 정책을 이 토픽에서 해제합니다(작성자 좌석 단위 교체)." : ""),
        payload: { sessionReplaced: { role: input.role, seat, previous, reason: input.reason, ...alsoReleased,
          ...(continuity ? { continuityReleased: true } : {}) }, ...(origin ? { origin } : {}) } },
    };
  }

  // 계획으로 돌아가기(planned 전용, 계약 v3.17 (28)) — 같은 계획을 같은 플래너 세션이 고친다. 결정문은 행동 시작과 같은 transaction 의 사용자 결정으로
  // 남아 플래너의 새 사실이 된다. 승인 결속은 그대로다 — 새 판이 생기면 approved ≠ current 라 구현 게이트가 다시 승인을 요구한다. 구현자·코드 리뷰어
  // 세션·작업 트리·브랜치는 보존한다.
  returnToPlanning(topicId: string, input: ReturnToPlanningInput, actionId?: string, origin?: CallOrigin): string {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    this.core.assertBudgetAvailable(topicId);
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.workflowMode !== "planned") throw conflict("계획으로 돌아가기는 planned 작업에서만 합니다.");
    if (!topic.planSHA256) throw conflict("돌아갈 현재 계획이 없습니다.");
    if (!RETURN_TO_PLANNING_STATES.has(topic.state)) {
      throw conflict(`계획으로 돌아가기는 ${[...RETURN_TO_PLANNING_STATES].join("·")} 에서만 합니다(현재 ${topic.state}).`);
    }
    assertTask(topic);
    this.assertStageContextCurrent(topicId);
    return this.core.startAction(topicId, "return-to-planning", signal => this.planning.returnToPlanning(topicId, signal), actionId, undefined,
      [{ actor: "user", kind: "decision", state: topic.state, body: input.decision, payload: { returnToPlanning: true, ...(origin ? { origin } : {}) } }]);
  }

  // A recorded budget resume may still need another account or a new allowance. Reuse the
  // retry admission check so an already-held logical review/rewrite is not charged again.
  budgetResumeBlocker(topicId: string): string | null {
    try {
      this.core.assertBudgetAvailable(topicId);
      this.core.assertRetryRewriteAvailable(topicId);
      return null;
    } catch (error) {
      if (error instanceof BudgetBlocked || error instanceof ReviewBlocked) return error.message;
      throw error;
    }
  }

  reviewPaused(topicId:string):ReviewScope|null {
    const db=this.core.dependencies.database,topic=db.getTopic(topicId);
    if(!["FAILED","USER_DECISION_REQUIRED"].includes(topic.state))return null;
    const interruption=db.getTimeline(topicId).filter(e=>e.scopeGeneration===topic.scopeGeneration && e.actor==="system" && e.payload?.resumeState).at(-1);
    if(topic.state==="USER_DECISION_REQUIRED" && !interruption?.payload?.reviewPause && !interruption?.payload?.budgetPause)return null;
    const resume = db.getFlags(topicId).resumeState;
    const recordedScope = interruption?.payload?.resumeState === resume ? interruption?.payload?.reviewPause : null;
    const scope = recordedScope === "planning" || recordedScope === "implementation" ? recordedScope : reviewScope(resume ?? "");
    if(!scope)return null;
    const account=db.reviews.account(topicId,scope);
    return account.limit !== null && account.used>=account.limit?scope:null;
  }

  // 구현 시작의 부작용 전 검사(startAction 의 실행 중 작업 검사 포함) — startImplementation 과 재개 정보가 같은 함수를 쓴다(엔진 개편 E1).
  private implementPreconditions(topicId: string): void {
    assertTask(this.core.dependencies.database.getTopic(topicId));
    this.core.assertNotShuttingDown();
    assertImplementationGate(this.core.dependencies.database.getTopic(topicId));
    // 원문 승인 범위(root)만 확인한다 — 원문 변경의 영향 심사(reviewed)는 실행 조건이 아니다(D6).
    this.core.dependencies.database.evidence.assertReady(this.core.dependencies.database.getTopic(topicId));
    this.assertStageContextCurrent(topicId);
  }

  // 승인의 검사 — approve 와 재개 정보가 같은 함수를 쓴다(엔진 개편 E1).
  private approvePreconditions(topicId: string, planSHA256: string | null): void {
    const topic = this.core.dependencies.database.getTopic(topicId);
    assertTask(topic);
    this.core.dependencies.database.evidence.assertReady(topic);
    // 승인은 사용자가 지금 승인 대기 중인 계획 판에 하는 것이다 — 에이전트 ACK 는 요구하지 않는다(D8).
    if (topic.state !== "AWAITING_USER_APPROVAL" || !planSHA256 || topic.planSHA256 !== planSHA256) {
      throw new Error("현재 승인을 기다리는 계획 해시와 일치하지 않습니다.");
    }
    this.assertStageContextCurrent(topicId);
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
    // 싣는다 — USER_DECISION_REQUIRED 이고, 같은 재개 단계이며, 그 뒤 상태 전이가 없을 때. FAILED 의 원인은 실패 기록(lastError·
    // 실패 action)이지 옛 정지 요청이 아니다(host-review a7a9ce86 F-007).
    const lastPause = currentStopEvent(topic, flags.resumeState ?? null, timeline);
    const interruption = topic.state === "USER_DECISION_REQUIRED" && lastPause ? lastPause : null;
    const inputsSinceInterruption = interruption
      ? timeline.filter(event => event.sequence > interruption.sequence && event.actor === "user" && (event.kind === "decision" || event.kind === "evidence")).length
      : null;
    const lastAction = db.latestAction(topicId);
    const stop = INTERRUPTED_STATES.has(topic.state) ? {
      state: topic.state, reason: topic.lastError, resumeState: flags.resumeState ?? null,
      contract: stopRecord(topic, flags.resumeState ?? null, interruption ?? undefined),
      failedAction: topic.state === "FAILED" && lastAction && (lastAction.status === "failed" || lastAction.status === "cancelled")
        ? { id: lastAction.id, kind: lastAction.kind, status: lastAction.status, error: lastAction.error, finishedAt: lastAction.finishedAt } : null,
    } : null;
    const diagnoses = this.listDiagnoses(topicId).filter(record => !CLOSED_DIAGNOSIS_STATUSES.has(record.status))
      .map(record => ({ id: record.id, kind: record.input.kind, status: record.status, mediatorAction: MEDIATOR_PENDING_STATUSES.has(record.status) }));
    const findings = this.resumeFindings(topic);
    const planArtifact = db.latestArtifact(topicId, "plan");
    const brainstormRound = latestBrainstormRound(timeline);
    return {
      topicId: topic.id, title: topic.title, state: topic.state, resumeState: flags.resumeState ?? null,
      evidenceResume: db.evidence.resumes.get(topicId),
      entry: workEntry(topic), hierarchy: { topicKind: topic.topicKind ?? "task", parentTopicId: topic.parentTopicId ?? null,
        context: hierarchyContext(db, topic), children: db.listTopics().filter(child => child.parentTopicId === topic.id).map(child => ({ id: child.id, title: child.title, topicKind: child.topicKind ?? "task", state: child.state })) },
      scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planRevision: topic.planRevision,
      plan: {
        planSHA256: topic.planSHA256, approvedPlanSHA256: topic.approvedPlanSHA256,
        acknowledged: Object.fromEntries(topic.participants.map(participant => [participant.role, participant.acknowledgedPlanSHA256])),
        path: planArtifact?.path ?? null,
      },
      delivery: { branchName: topic.branchName, committedOID: flags.committedOID ?? null, pushedOID: flags.pushedOID ?? null, orphanCommitOID: flags.orphanCommitOID ?? null },
      runningAction: running ? { id: running.id, kind: running.kind } : null,
      brainstorm: brainstormRound ? {
        round: brainstormRound.number, order: brainstormRound.order,
        replies: brainstormReplies(timeline, brainstormRound.sequence).map(event => ({
          role: event.payload.brainstormRole, sequence: event.sequence, body: event.body, route: event.payload.route,
        })),
        conclusion: timeline.findLast(event => event.actor === "user" && event.payload.brainstormConclusion)?.body ?? null,
      } : null,
      autoRetryAt: this.scheduledRetryAt(topicId),
      continuation: db.continuations.get(topicId),
      stop,
      openRequests: {
        interruption: interruption ? { sequence: interruption.sequence, body: interruption.body, resumeState: interruption.payload?.resumeState ?? null,
          pause: PAUSE_KEYS.filter(key => Boolean(interruption.payload?.[key])) } : null,
        userInputsSinceInterruption: inputsSinceInterruption,
        workRequests: findings.workRequests,
        diagnoses,
      },
      findings: { basis: findings.basis, open: findings.open, errors: findings.errors },
      limits: {
        budget: db.budgets.account(topicId),
        reviews: [db.reviews.account(topicId, "planning"), db.reviews.account(topicId, "implementation")], reviewPaused: this.reviewPaused(topicId),
      },
      nextActions: await this.nextActions(topicId),
      locations: { worktreePath: topic.worktreePath, repositoryPath: topic.repositoryPath, planPath: planArtifact?.path ?? null },
    };
  }

  // 미해결 지적 — 역할 봉투에는 지적 목록이 없다(D3). 엔진은 역할 원문을 해석·판정하지 않으므로, 재개 정보는 이 범위 세대의 마지막 봉투 기록(역할·
  // outcome·사건 번호)을 가리키기만 하고 정지의 요청 원문은 openRequests.interruption 이 싣는다. 옛 결과의 판정 재계산(findingJudgment·저장 리뷰 판정·
  // 수정 수락 판정)과 작업 체크포인트의 열린 요청은 옛 경로와 함께 ⑥ 에서 뺐다.
  private resumeFindings(topic: Topic) {
    const latest = this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration)
      .findLast(event => event.kind === "agent_output" && event.payload?.envelope !== undefined);
    const envelope = latest?.payload?.envelope as { role?: unknown; outcome?: unknown } | undefined;
    return {
      basis: latest ? { kind: "envelope", role: envelope?.role ?? null, outcome: envelope?.outcome ?? null, sequence: latest.sequence } : null,
      open: [] as Array<never>, errors: [] as string[], workRequests: [] as Array<never>,
    };
  }

  private blocker(check: () => void): string | null {
    try { check(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  private async asyncBlocker(check: () => Promise<unknown>): Promise<string | null> {
    try { await check(); return null; } catch (error) { return error instanceof Error ? error.message : String(error); }
  }

  async nextActions(topicId: string): Promise<ResumeAction[]> {
    const db = this.core.dependencies.database;
    const topic = db.getTopic(topicId);
    const flags = db.getFlags(topicId);
    if (db.runningAction(topicId) || this.core.active.has(topicId)) return [{ action: "stop", blocker: null }];
    const actions: ResumeAction[] = [];
    if (isTopicGroup(topic) && topic.state === "CLOSED") return actions;
    if (topic.state === "BRAINSTORM_READY") {
      const blocker = this.blocker(() => { this.brainstormPreconditions(topicId); });
      const runnable = this.blocker(() => {
        const current = this.brainstormPreconditions(topicId); this.core.requireParticipants(current); this.core.assertBudgetAvailable(topicId);
      });
      actions.push({ action: "brainstorm", blocker: runnable },
        { action: "brainstorm-plan", blocker: isTopicGroup(topic) ? blocker : runnable, input: { decision: null, goal: null } },
        { action: "brainstorm-close", blocker, input: { decision: null } });
    } else if (topic.state === "DRAFT" && isTopicGroup(topic)) {
      actions.push({ action: "topic:create-child", blocker: this.blocker(() => assertEntryReady(db, topic)), input: { parentTopicId: topic.id } });
      if (!db.listTopics().some(child => child.parentTopicId === topic.id)) actions.push({ action: "goal:set", blocker: null, input: { goal: null } });
    } else if (topic.state === "DRAFT") {
      if (!workEntry(topic).goal || workEntry(topic).mode === "sources") actions.push({ action: "goal:set", blocker: null, input: { goal: null, evidenceDigest: db.evidence.topic(topic).digest } });
      if (topic.workflowMode === "ticket") {
        // ticket 은 계획 없이 구현으로 시작한다(D1). 계획이 필요하면 공식 방식 전환으로 planned 로 바꾼다.
        actions.push({ action: "implement", blocker: this.blocker(() => { this.implementPreconditions(topicId); this.core.assertNoActiveWork(topicId); }) },
          { action: "workflow-mode", input: { mode: "planned", reason: null }, blocker: this.blocker(() => this.workflowModePreconditions(topicId, "planned")) });
      } else {
        actions.push({ action: "plan", blocker: this.blocker(() => {
          this.core.assertNotShuttingDown(); this.core.assertNoActiveWork(topicId); this.core.requireState(topicId, "DRAFT");
          assertTask(topic); assertEntryReady(db, topic);
          this.assertStageContextCurrent(topicId);
        }) });
      }
    } else if (INTERRUPTED_STATES.has(topic.state)) {
      // 정지는 결정문(선택)을 실은 재개 한 번으로 정지 지점에서 잇는다(D7, 계약 v3.17 (29)) — 결정 게시 + 재시도 두 단계가 아니다. 실패(FAILED)의 일시
      // 오류도 같은 재개다.
      actions.push({ action: "resume", input: { decision: null }, blocker: this.blocker(() => { this.retryPreconditions(topicId, { resumed: true }); }) });
      if (this.scheduledRetryAt(topicId)) actions.push({ action: "stop", blocker: null });
    } else if (topic.state === "AWAITING_USER_APPROVAL") {
      if (topic.approvedPlanSHA256 !== topic.planSHA256) {
        actions.push({ action: "approve", input: { planSHA256: topic.planSHA256 }, blocker: this.blocker(() => this.approvePreconditions(topicId, topic.planSHA256)) });
      } else {
        actions.push({ action: "implement", blocker: this.blocker(() => { this.implementPreconditions(topicId); this.core.assertNoActiveWork(topicId); }) });
      }
    } else if (topic.state === "READY_TO_DELIVER") {
      // 리뷰 질문 답변·작업 트리 스냅샷·전달 잠금은 인도 실행이 검사한다(DeliveryPipeline 내부) — 여기서는 호출할 수 있는 검사만 판정하고 나머지를 밝힌다.
      const deliverable = () => this.blocker(() => {
        db.evidence.assertReady(topic);
        if (!topic.branchName) throw new Error("커밋할 작업 브랜치가 없습니다.");
        if (!flags.reviewedHead || !flags.reviewedDiffSHA256) throw new Error("최종 리뷰가 확인한 변경 스냅샷이 없습니다.");
      });
      const deferredChecks = ["리뷰 질문 답변 확인", "작업 트리가 최종 리뷰 스냅샷과 같은지", "전달 잠금"];
      actions.push({ action: "commit", input: { message: null, paths: null }, blocker: deliverable(), deferredChecks });
      if (flags.committedOID && flags.pushedOID !== flags.committedOID) actions.push({ action: "push", blocker: deliverable(), deferredChecks });
      // 묶음 단계는 closeStage 의 결과 확인(git)까지 같은 함수로 판정한다.
      actions.push({ action: "close", blocker: db.workGroups.forTopic(topicId)
        ? await this.asyncBlocker(async () => { this.closePreconditions(topicId); await this.stageCloseResult(topicId, { freeze: false }); })
        : this.blocker(() => this.closePreconditions(topicId)) });
      // 중재자 재진입(F009) — 같은 역할 세션의 수정·재리뷰. 상태 검사는 이 분기가 보장하므로 차단 사유는 재개의 사전 검사와 같다.
      for (const reentry of REENTRY_POINTS) {
        actions.push({ action: "resume", input: { reentry, decision: null },
          blocker: this.blocker(() => { this.retryPreconditions(topicId, { resumed: true, reentry }); }) });
      }
    } else if (topic.state === "CLOSED") {
      // 닫힌 작업 묶음 단계의 동결 결과 전달(E4 보완 F002) — 확정 커밋이 아직 push 되지 않았거나 결과 불명확 push 가 남았으면 push 를 싣는다.
      if (db.workGroups.forTopic(topicId) && ((flags.committedOID && flags.pushedOID !== flags.committedOID) || db.unknownDeliveryAction(topicId))) {
        actions.push({ action: "push", blocker: this.blocker(() => { this.core.assertNotShuttingDown(); this.delivery.closedStagePushPreconditions(topicId); }) });
      }
      actions.push({ action: "archive", blocker: this.blocker(() => { this.core.assertNotShuttingDown(); this.core.assertNoActiveWork(topicId); }) });
    }
    if (db.evidence.resumes.get(topicId) && !actions.some(item => item.action === "stop")) actions.push({ action: "stop", blocker: null });
    if (["pending", "running"].includes(db.continuations.get(topicId)?.status ?? "") && !actions.some(item => item.action === "stop"))
      actions.push({ action: "stop", blocker: null });
    return actions;
  }

  approve(topicId: string, planSHA256: string): Topic {
    this.approvePreconditions(topicId, planSHA256);
    const updated = this.core.dependencies.database.updateTopic(topicId, { approvedPlanSHA256: planSHA256 });
    this.core.event(topicId, "user", "decision", "현재 계획 버전의 구현을 승인했습니다.", { planSHA256 });
    return updated;
  }

  // 작업 묶음에 연결되지 않은 주제의 닫기. 묶음 단계는 결과 커밋 검증(git)과 결과 동결이 필요해 closeStage 로만 닫는다 — 동기 경로로 닫으면
  // 동결 기록 없이 CLOSED 가 되어 다음 단계가 이 결과를 승계할 수 없다(엔진 개편 E4, plan §3.3).
  close(topicId: string): Topic {
    this.closePreconditions(topicId);
    if (this.core.dependencies.database.workGroups.forTopic(topicId)) {
      throw new Error("작업 묶음 단계는 결과 커밋을 확인하고 결과를 동결해야 닫을 수 있습니다(closeStage).");
    }
    return this.core.transition(topicId, "CLOSED", "주제를 닫았습니다.");
  }

  // 닫기(API 경로) — 묶음 단계면 검증된 로컬 커밋(HEAD==committedOID·clean·커밋 트리==리뷰 트리·기준의 후손)과 합류 대상·통합의 조상 관계를 확인하고
  // 결과를 동결한 뒤 닫는다. push 는 요구하지 않는다: 원격 전달은 단계 착수와 분리된 상태이고, 닫힌 단계의 동결 결과는 따로 push 한다(plan §3.3, E4 보완
  // F002). git 경계 뒤 사전 검사를 다시 하고, 그 사이 커밋이 바뀌었으면 거부한다. 동결은 전이보다 먼저 쓰고(전이 실패 뒤 재시도는 닫히기 전이라 교체), 닫힌
  // 뒤에는 바뀌지 않는다. 변경 없이 검증한 통합·무변경 승인 작업은 리뷰한 기준 커밋을 확정 커밋으로 CLOSED 전이와 한 transaction 에 기록한다 — 전달 계약(push)이 이
  // 커밋을 싣는다(F003).
  async closeStage(topicId: string): Promise<Topic> {
    const db = this.core.dependencies.database;
    this.closePreconditions(topicId);
    const group = db.workGroups.forTopic(topicId);
    if (!group) return this.core.transition(topicId, "CLOSED", "주제를 닫았습니다.");
    if (this.stageClosing.has(topicId)) throw new Error("이미 단계를 닫고 있습니다.");
    this.stageClosing.add(topicId);
    try {
      const record = await this.stageCloseResult(topicId, { freeze: true });
      this.closePreconditions(topicId);
      const flags = db.getFlags(topicId);
      if ((flags.committedOID ?? null) !== record.committedOID) throw new Error("단계를 확인하는 동안 결과 커밋이 바뀌었습니다. 다시 닫아 주세요.");
      if (record.committedOID === null) {
        const topic = db.getTopic(topicId);
        const evidenceInput = db.evidence.captureForCommit(topic);
        db.evidence.bindCommitInput(topic, evidenceInput, record.result.commitOID);
      }
      db.workGroups.freezeResult(record.groupId, record.result, { replaceUnclosed: true });
      return this.core.transitionWith(topicId, "CLOSED", "주제를 닫았습니다.", record.committedOID === null
        ? { changes: { committedOID: record.result.commitOID }, payload: { verifiedBaseResult: record.result.commitOID } } : {});
    } finally {
      this.stageClosing.delete(topicId);
    }
  }

  // 묶음 단계 닫기의 결과 확인과 동결 기록. freeze:false(재개 정보의 close 판정)는 DB 를 쓰지 않는다 — E4 전 닫힌 선행 단계도 검증만 한다.
  // freeze:true(closeStage)는 선행 결과 해석(resolvePriorResults)이 안전한 legacy 결과를 동결한다(F005: 이미 열린 legacy 통합도 새 next 없이 닫힌다).
  private async stageCloseResult(topicId: string, options: { freeze: boolean }): Promise<{ groupId: string; committedOID: string | null; result: StageResult }> {
    const { database: db, git } = this.core.dependencies;
    const group = db.workGroups.forTopic(topicId);
    const stage = group?.stages.find(candidate => group.links[candidate.id]?.topicId === topicId);
    if (!group || !stage) throw new Error("작업 묶음 단계를 찾을 수 없습니다.");
    const link = group.links[stage.id];
    const topic = db.getTopic(topicId), flags = db.getFlags(topicId);
    const integration = stage.kind === "integration";
    const head = await git.head(topic.worktreePath);
    if ((await git.changedPaths(topic.worktreePath)).length) throw new Error("작업 트리에 커밋하지 않은 변경이 있어 단계를 닫을 수 없습니다.");
    const reviewedBaseCandidate = !link.preparedMerge && head === link.baseOID;
    // planned 의 무변경 결과는 승인 계획이 만든 것이어야 한다. ticket 은 계획이 없으므로 아래 리뷰 기록(리뷰 HEAD·리뷰 트리)만으로 결속한다(D1).
    if (topic.workflowMode === "planned" && !flags.committedOID && !integration && reviewedBaseCandidate) {
      // 계획 버전은 산출물 원문 바이트의 sha256 이다(계획 묶음 직렬화, planBundleVersion) — 정규화 해시로 비교하지 않는다(F010).
      const { content } = await this.core.requireCurrentPlanArtifact(topicId);
      if (sha256(content) !== topic.approvedPlanSHA256) throw new Error("승인된 무변경 계획을 확인할 수 없습니다.");
      // Scope/tolerance limits permitted edits; it does not require an edit. The final review
      // below proves whether this approved plan actually produced the unchanged base tree.
    }
    let commitOID: string;
    if (flags.committedOID) {
      if (head !== flags.committedOID) throw new Error("작업 트리 HEAD 가 단계 결과 커밋과 다릅니다 — 검증된 로컬 커밋에서만 닫습니다.");
      if (!flags.reviewedTreeOID) throw new Error("리뷰한 트리 기록이 없어 단계 결과를 승계할 수 없습니다.");
      if ((await git.diffTrees(topic.worktreePath, flags.committedOID, flags.reviewedTreeOID)).files.length) {
        throw new Error("단계 결과 커밋의 트리가 리뷰한 트리와 다릅니다.");
      }
      commitOID = flags.committedOID;
    } else if (reviewedBaseCandidate) {
      // 변경 없이 검증만 한 통합 또는 무변경 승인 작업 — 기준 커밋이 곧 결과다. 다만 "변경 없음" 도 리뷰가 확인한 사실이어야 한다(F004): 리뷰 HEAD 가 기준 커밋이고 리뷰한
      // 작업 트리가 기준 커밋 트리와 같을 때만. 리뷰한 수정을 커밋하지 않고 되돌린 작업 트리는 리뷰한 결과가 아니다.
      if (!flags.reviewedTreeOID || flags.reviewedHead !== head) {
        throw new Error("변경 없는 단계 결과를 리뷰한 기록(리뷰 HEAD·리뷰 트리)이 없어 단계를 닫을 수 없습니다.");
      }
      if ((await git.diffTrees(topic.worktreePath, head, flags.reviewedTreeOID)).files.length) {
        throw new Error("리뷰한 작업 트리에 변경이 있었습니다 — 리뷰한 변경을 커밋해야 단계 결과로 닫을 수 있습니다(되돌린 기준 커밋은 리뷰한 결과가 아닙니다).");
      }
      commitOID = head;
    } else {
      throw new Error("다음 단계로 넘어가려면 먼저 검증된 결과를 커밋하세요.");
    }
    if (!await git.isAncestor(topic.worktreePath, link.baseOID, commitOID)) throw new Error("단계 결과 커밋이 단계 기준 커밋의 후손이 아닙니다.");
    // 합류 대상(기준에 모이지 않은 선행 결과)과 통합(다른 모든 단계 결과)은 결과 커밋의 조상이어야 한다 — 필요한 선행 결과가 실제로 포함됐는지 확인한다.
    // 선행 결과는 어댑터와 같은 해석 함수로 얻는다: 동결 결과는 승계 검사, E4 전 닫힌 단계는 이전 계약 증거(F005·F009 같은 계약).
    const resolution = await resolvePriorResults(db, git, group.id, stage.id, { freeze: options.freeze });
    const proofs = new Map([...resolution.proof, ...resolution.unfrozen].map(proof => [proof.stageId, proof]));
    const required = integration ? group.stages.filter(other => other.id !== stage.id).map(other => other.id) : link.mergeTargets ?? [];
    for (const id of required) {
      const prior = proofs.get(id);
      if (!prior) throw new Error(`단계 ${id} 의 결과를 확인할 수 없어 ${integration ? "통합" : "합류"}을 확인할 수 없습니다.`);
      if (!await git.isAncestor(topic.worktreePath, prior.commit, commitOID)) {
        throw new Error(`단계 ${id} 의 결과 커밋이 이 단계 결과에 포함되지 않았습니다(${integration ? "통합" : "합류"} 대상).`);
      }
    }
    if (topic.workflowMode === "planned" && !topic.approvedPlanSHA256) throw new Error("승인된 계획이 없어 단계 결과를 동결할 수 없습니다.");
    const timeline = db.getTimeline(topicId);
    // 이 단계에서 실제로 쓴 위키 문서(경로별 마지막 기록 버전) — 통합 단계가 기록 버전과 당시 버전을 대조한다.
    const memory = new Map<string, string>();
    for (const event of timeline) {
      const changes = event.payload?.memoryChanges;
      if (!Array.isArray(changes)) continue;
      for (const change of changes as Array<{ path?: unknown; sha256?: unknown; status?: unknown }>) {
        if (change.status === "written" && typeof change.path === "string" && typeof change.sha256 === "string") memory.set(change.path, change.sha256);
      }
    }
    const questions = (group.questions ?? []).filter(q => !q.resolution && (q.stageId === stage.id || q.stageId === null));
    const deferredQuestions = questions.filter(q => q.deferredReason).map(q => ({ id: q.id, text: q.text, deferredReason: q.deferredReason }));
    const result: StageResult = {
      stageId: stage.id, topicId, baseOID: link.baseOID, commitOID,
      reviewedTreeOID: flags.reviewedTreeOID ?? "", planSHA256: topic.approvedPlanSHA256,
      evidenceDigest: db.evidence.topic(topic).digest ?? null,
      verifications: (db.verificationRecords(topicId) as Array<{ id?: unknown; status?: unknown }>)
        .filter(record => typeof record.id === "string" && typeof record.status === "string")
        .map(record => ({ id: record.id as string, status: record.status as string })),
      memoryChanges: [...memory].map(([path, sha256]) => ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path)),
      openQuestions: questions.filter(question => !question.deferredReason)
        .map(question => `${question.id}: ${question.text}`),
      ...(deferredQuestions.length ? { deferredQuestions } : {}),
      // 실제 보류 원장(deferred-findings 산출물) — 재개 판정의 열린 지적(resumeFindings.open)은 DEFERRED_OUT_OF_SCOPE 를 빼므로 쓰지 않는다(F007).
      deferredFindings: await this.core.deferredFindingsOf(topicId),
      // 현재 범위 세대의 사용자 결정 원문 전부(F012·F013) — 개수·길이로 자르지 않고, 과거 세대 결정과 절차 기록은 넣지 않는다.
      decisions: stageDecisions(db.getScopedTimeline(topicId, topic.scopeGeneration), topicId),
      closedAt: new Date().toISOString(),
    };
    return { groupId: group.id, committedOID: flags.committedOID ?? null, result };
  }

  // 작업 묶음 단계가 외부 결정(사용자 결정)에 막혔는가 — 막힌 단계 옆에서 독립 준비 단계를 고를 수 있는 조건(plan §3.1, E4-6).
  // 자원 정지(예산·재작성·리뷰·계획 제어·착수 거부)는 막힘이 아니다 — 재개 정보의 정지 분류(PAUSE_KEYS)와 같은 판정을 쓴다.
  stageBlockedExternally(topicId: string): boolean {
    const db = this.core.dependencies.database;
    const topic = db.getTopic(topicId);
    if (topic.state !== "USER_DECISION_REQUIRED") return false;
    if (db.runningAction(topicId) || this.core.active.has(topicId)) return false;
    const interruption = db.getTimeline(topicId).filter(event =>
      event.scopeGeneration === topic.scopeGeneration && event.actor === "system" && event.payload?.resumeState).at(-1);
    return !PAUSE_KEYS.some(key => Boolean(interruption?.payload?.[key]));
  }

  // 작업 묶음 단계의 문맥 결속(E4 — 문맥 해시). 연결 단계가 아니면 통과한다. 상태를 전진시키는 동작(계획·구현 시작·승인·재시도·
  // 구현 재개·닫기)이 모두 이 판정 하나를 쓴다.
  private assertStageContextCurrent(topicId: string): void {
    this.core.dependencies.database.workGroups.assertStageContextCurrent(topicId);
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
    // 묶음 단계: 문맥 변경 중에는 닫지 않는다(닫기는 결과를 동결해 다음 단계로 승계하는 길이다). 결과 커밋 검증은 closeStage 가 한다.
    this.assertStageContextCurrent(topicId);
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

  // 작업 방식 전환의 부작용 전 검사 — 실행 중인 일이 없고 닫히지 않은 말단 주제에서, 지금과 다른 방식으로만 바꾼다. 예약된 자동 실행(사용 한도 재시도·
  // 근거 수집 뒤 재개·자동 진행)은 옛 방식의 재개 지점으로 실행을 열므로 먼저 stop 으로 취소하게 한다 — 전환이 실행을 시작하지 않게 하기 위해서다.
  private workflowModePreconditions(topicId: string, mode: WorkflowModeInput["mode"]): Topic {
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    const db = this.core.dependencies.database;
    const topic = db.getTopic(topicId);
    assertTask(topic);
    if (topic.state === "CLOSED") throw conflict("닫은 주제의 작업 방식은 바꿀 수 없습니다.");
    if (topic.workflowMode === mode) throw conflict(`이미 ${mode} 작업입니다.`);
    if (this.scheduledRetryAt(topicId) || db.evidence.resumes.get(topicId) || ["pending", "running"].includes(db.continuations.get(topicId)?.status ?? ""))
      throw conflict("예약된 자동 실행이 있습니다. stop 으로 취소한 뒤 작업 방식을 바꾸세요.");
    return topic;
  }

  // 작업 방식 전환(CR 흐름 단순화 D1) — 중재자·사용자의 명시 행동이다. 초기화가 아니다: 작업 트리·브랜치·체크포인트·세션 결속·결정·원장과 planEpoch·
  // scopeGeneration 을 그대로 두고 방식과 재개 지점만 바꾼다. 재개 지점은 workflowModeResumePoint 가 기계적으로 정하고, 바뀌면 같은 transaction 에서
  // 정지 기록(USER_DECISION_REQUIRED, 이미 정지면 재개 단계만)을 남긴다 — 다음 중재자 재개가 그 지점을 쓴다. 이 함수는 실행을 시작하지 않는다.
  // 재개 지점이 그대로면 원래 정지 기록(대기 사유·한도 정지)을 가리지 않도록 resumeState 를 싣지 않는다.
  setWorkflowMode(topicId: string, input: WorkflowModeInput, requestKey?: string, origin?: CallOrigin): Topic {
    const topic = this.workflowModePreconditions(topicId, input.mode);
    const db = this.core.dependencies.database;
    const stopped = INTERRUPTED_STATES.has(topic.state);
    const point = stopped ? db.getFlags(topicId).resumeState : topic.state;
    const resumeState = point ? workflowModeResumePoint(input.mode, point, topic.planSHA256 !== null) : null;
    const state: WorkflowState = resumeState && !stopped ? "USER_DECISION_REQUIRED" : topic.state;
    if (state !== topic.state) assertTransition(topic.state, state);
    const reason = redactSecrets(input.reason);
    const body = `작업 방식을 ${topic.workflowMode} 에서 ${input.mode} 로 바꿨습니다${resumeState ? ` — 재개 지점 ${point} → ${resumeState}` : ""}. `
      + `실행은 시작하지 않았습니다. 사유: ${reason}`;
    // 계획 연속성 정책은 planned 생성·전환 때만 켠다(Codex Q-e) — enable 은 정책 행이 있으면 그대로 두고, 시작 전 계획에만 v2 를 준다. planned → ticket
    // 전환은 기존 정책 행·세션·커서를 바꾸지 않는다.
    return db.applyTopicTransition({
      topicId,
      changes: { workflowMode: input.mode, ...(resumeState ? { state, resumeState, ...(stopped ? {} : { lastError: body }) } : {}) },
      ...(input.mode === "planned" ? { enablePlanning: true as const } : {}),
      events: [{ actor: "system", kind: "system", state, body, payload: {
        workerFact: { kind: "workflow-mode", from: topic.workflowMode, to: input.mode, resumeState, reason },
        ...(resumeState ? { resumeState } : {}),
        ...(origin ? { origin } : {}), ...(requestKey ? { requestKey, requestAction: "workflow-mode" } : {}),
      } }],
    });
  }

  // 구현 계속 재개 — 리뷰 한도·실패로 멈춘 토픽의 resume 을 IMPLEMENTING 으로 되돌린다(같은 세션·같은 계획, 리뷰 소비량 불변). 그 뒤 retry.
  // planned 는 승인된 현재 계획이 있어야 하고, ticket 은 계획 없이 구현 세션으로 잇는다(D1).
  resumeImplementation(topicId: string, input: ResumeImplementationInput, origin?: CallOrigin): Topic {
    this.core.assertNoActiveWork(topicId);
    this.assertStageContextCurrent(topicId);
    const db = this.core.dependencies.database;
    const topic = db.getTopic(topicId);
    if (topic.state !== input.expectedState) throw new Error(`현재 상태 ${topic.state} 가 요청의 기대 상태 ${input.expectedState} 와 다릅니다.`);
    if (topic.scopeGeneration !== input.expectedScopeGeneration) throw new Error("범위 세대가 요청과 다릅니다 — 낡은 재개 요청입니다.");
    if (topic.workflowMode === "planned" && (!topic.approvedPlanSHA256 || topic.approvedPlanSHA256 !== topic.planSHA256)) {
      throw new Error("승인된 계획이 없거나 계획이 바뀌어 구현을 재개할 수 없습니다.");
    }
    if (!db.getFlags(topicId).implementationSessionId) throw new Error("구현 세션이 없어 재개할 수 없습니다(구현 시작을 쓰세요).");
    return db.applyTopicTransition({
      topicId, changes: { resumeState: "IMPLEMENTING", ...resetCycle("implementation") },
      events: [{ actor: "user", kind: "decision", state: topic.state,
        body: `구현 계속 재개(공식): resume → IMPLEMENTING. ${input.reason}`,
        payload: { implementationResume: { fromState: topic.state, scopeGeneration: topic.scopeGeneration }, ...(origin ? { origin } : {}) } }],
    });
  }

  // 중재자 진단 기록은 이력으로 읽기만 한다(D8) — 등록·적용 실행 경로는 없고, 중재자는 결정문을 실은 재개(resume)로 작업자에게 전한다.
  listDiagnoses(topicId: string): DiagnosisRecord[] {
    return this.core.dependencies.database.diagnoses.list(topicId);
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
    // 승인 대기·인도 대기 중 메시지도 사실로만 남긴다 — 계획·승인을 초기화하지 않고(D8, 계약 v3.17 (31)) 재확인 정지를 만들지 않는다(D8 의
    // reviewDeliveryRecheck 삭제). 계획을 고칠지는 중재자가 return-to-planning 으로, 구현을 고칠지는 resume 등 중재자 행동으로 정하고, 메시지는 각 역할
    // 세션의 다음 턴에 새 사실로 실린다(D7).
    this.core.dependencies.database.appendEvent({
      topicId,
      actor: "user",
      kind,
      state: topic.state,
      body: redactSecrets(body),
      payload: { ...(origin ? { origin } : {}), ...(requestKey ? { requestKey, requestAction: `message:${kind}` } : {}) },
    });
    if (kind === "decision" && topic.state === "USER_DECISION_REQUIRED") {
      this.core.event(topicId, "system", "system", "새 정보가 추가되었습니다. 재시도를 눌러 해당 단계를 다시 실행하세요.");
    }
    return this.core.dependencies.database.getTopic(topicId);
  }

  // 범위 변경의 부작용 전 검사 — handleScopeChange 와 작업 묶음 개정의 사전 검사(저장 전, E4 D2 ①)가 같은 함수를 쓴다.
  assertScopeChangeAllowed(topicId: string): Topic {
    if (this.core.deliveryActive.has(topicId)) throw new Error("커밋 또는 push가 끝난 뒤 범위를 바꿔 주세요.");
    if (this.core.dependencies.database.unknownDeliveryAction(topicId)) {
      // 미확정 commit/push 확인은 git await 사이에 낀다. 그 사이 세대가 올라가면 이전 세대의 OID가
      // 새 세대에 기록된다(감사 ② 재현) — 확인이 끝날 때까지 범위 변경을 막는다.
      throw new Error("결과가 불명확한 commit 또는 push가 있습니다. 전달 결과를 먼저 확인한 뒤 범위를 바꿔 주세요.");
    }
    if (this.core.scopeChangeActive.has(topicId)) throw new Error("이미 범위를 바꾸고 있습니다.");
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state === "CLOSED") {
      throw new Error("이미 닫은 주제는 범위를 바꿀 수 없습니다. 새 주제를 만들어 주세요.");
    }
    if (!SCOPE_CHANGE_ALLOWED_STATES[topic.state]) {
      throw new Error(`${topic.state} 상태에서는 범위를 바꿀 수 없습니다.`);
    }
    return topic;
  }

  async handleScopeChange(topicId: string, body: string, requestKey?: string, origin?: CallOrigin): Promise<Topic> {
    const topic = this.assertScopeChangeAllowed(topicId);
    const nextState = topic.state === "BRAINSTORM_READY" || topic.state === "BRAINSTORMING"
      || ["BRAINSTORMING", "BRAINSTORM_READY"].includes(this.core.dependencies.database.getFlags(topicId).resumeState ?? "") ? "BRAINSTORM_READY" : "DRAFT";
    this.core.scopeChangeActive.add(topicId);
    // 범위 변경은 새 사건이다 — 예약된 자동 재시도와 그 지속 상태를 지운다(잠금 중 발화하면 fire 가 건너뛴다).
    this.usageLimitRetry.reset(topicId);
    try {
      const nextGeneration = topic.scopeGeneration + 1;
      const needsFreshWorktree = Boolean(topic.branchName) || [
        "IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "READY_TO_DELIVER",
      ].includes(topic.state);
      let worktreePath = topic.worktreePath;
      if (needsFreshWorktree) {
        const stem = basename(topic.worktreePath).replace(/-g\d+(?:-[a-f0-9]+)?$/, "");
        worktreePath = join(dirname(topic.worktreePath), `${stem}-g${nextGeneration}-${randomUUID().slice(0, 6)}`);
        await this.core.dependencies.git.createDetachedWorktree(topic.repositoryPath, worktreePath, topic.baseRef);
        // 합류 병합을 준비한 작업 묶음 단계는 새 작업 트리에도 같은 준비를 다시 적용한다(E4 보완 F001) — 기준에서 새로 만든 트리에는 병합 내용이 없어,
        // 그대로 두면 인도 병합 커밋이 합류 대상을 부모로 삼으면서 그 내용을 빠뜨린다. 같은 기준·대상이면 같은 트리가 나와야 한다.
        const stageGroup = this.core.dependencies.database.workGroups.forTopic(topicId);
        const stageLink = stageGroup ? Object.values(stageGroup.links).find(link => link.topicId === topicId) : undefined;
        if (stageLink?.preparedMerge) {
          const prepared = await this.core.dependencies.git.prepareMerge(worktreePath, stageLink.baseOID,
            stageLink.preparedMerge.targets.map(target => target.commitOID));
          if (prepared.tree !== stageLink.preparedMerge.tree) throw new Error("새 작업 트리의 합류 병합 준비가 단계에 기록된 병합 트리와 다릅니다. 새로 만든 worktree는 보존했습니다.");
        }
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
      // 좌석 세션을 만든 공급자·근거도 남긴다(E2b) — 참여자 초기화(pending 세션)와 구현 세션 비우기 때 DB 가 바인딩도 함께 비우므로 이 이벤트가 남는 기록이다.
      // pending 세션은 아직 공급자가 정해지지 않았으므로 null.
      const previousBindings: Record<string, SessionBinding | null> = {};
      const resetParticipants = topic.participants.map((participant) => {
        previousSessions[participant.role] = participant.sessionId;
        previousBindings[participant.role] = participant.sessionId.startsWith("pending:") ? null
          : this.core.dependencies.database.participantBinding(topicId, participant.role);
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
          state: nextState,
          scopeGeneration: nextGeneration,
          planEpoch: topic.planEpoch + 1,
          planRevision: 0,
          planSHA256: null,
          approvedPlanSHA256: null,
          branchName: null,
          implementationBaseOID: null,
          worktreePath,
          lastError: null,
          ...resetCycle("plan"),
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
            state: nextState,
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
              previousBindings,
              ...(origin ? { origin } : {}),
              ...(requestKey ? { requestKey, requestAction: "message:scope_change" } : {}),
            }),
          },
          {
            actor: "system",
            kind: "system",
            state: nextState,
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

// 단계 결과에 넘길 사용자 결정(E4 보완 F012·F013) — 한 범위 세대의 사용자 결정 이벤트 원문 전부. 엔진 절차 기록(인도 동작·허용 오차 개정·구현 재개·승계 결정
// 사본·승인 기록)은 뺀다. 승인 기록은 planSHA256 만 싣는다(승인 대기 중 메시지의 계획 무효화는 invalidatedPlanSHA256 을 함께 싣는 사용자 결정이다).
const PROCEDURAL_DECISION_KEYS = ["deliveryAction", "toleranceAmendment", "implementationResume", "inheritedDecision"] as const;
function stageDecisions(events: readonly TimelineEvent[], topicId: string): StageDecision[] {
  return events.filter(event => event.actor === "user" && event.kind === "decision"
    && !PROCEDURAL_DECISION_KEYS.some(key => event.payload?.[key] !== undefined)
    && !(event.payload?.planSHA256 !== undefined && event.payload?.invalidatedPlanSHA256 === undefined))
    .map(event => ({ topicId, sequence: event.sequence, scopeGeneration: event.scopeGeneration,
      sha256: createHash("sha256").update(event.body, "utf8").digest("hex"), body: event.body }));
}
