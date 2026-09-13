import { randomUUID } from "node:crypto";
import { describePrune, pruneBuildTrees } from "./buildTrees.js";
import { basename, dirname, join } from "node:path";
import {
  type AgentExecutionSettings,
  type Participant,
  type Topic,
  type WorkflowState,
} from "../shared/contracts.js";
import {
  assertImplementationGate,
  bothAgentsAcknowledged,
  canTransition,
  redactSecrets, replanDirective } from "../shared/workflow.js";
import { ArtifactStore } from "./artifacts.js";
import { ConsensusDatabase } from "./database.js";
import { GitService } from "./git.js";
import { redactRecord } from "./security.js";
import type { AgentAdapter, ExecutionLimits, ParticipantRole, ProjectMemoryWriter } from "./types.js";
import { EngineCore } from "./engine/core.js";
import { PlanningPipeline } from "./engine/planning.js";
import { DeliveryPipeline } from "./engine/delivery.js";
import { UsageLimitRetryScheduler, type RetryClock } from "./engine/usageLimitRetry.js";

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

  startPlan(topicId: string, actionId?: string): string {
    // 원장에 running 행을 만들기 전에 상태를 확인한다. 비동기 work에서 거부하면 이미 끝난 주제까지 FAILED로 덮인다.
    this.core.assertNotShuttingDown();
    this.core.assertNoActiveWork(topicId);
    this.core.requireState(topicId, "DRAFT");
    return this.core.startAction(topicId, "plan", (signal) => this.planning.runPlanningLoop(topicId, signal), actionId);
  }

  startImplementation(topicId: string, actionId?: string, kickoffDecision?: string): string {
    this.core.assertNotShuttingDown();
    assertImplementationGate(this.core.dependencies.database.getTopic(topicId));
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

  retry(topicId: string, actionId?: string): string {
    this.core.assertNotShuttingDown();
    // 상태를 바꾸기 전에 다른 작업(실행·범위 변경·인도)이 없는지 본다 — 아래 사다리 일부는 startAction 전에 전이하므로,
    // 잠금을 startAction 에서 뒤늦게 만나면 상태만 바뀐 채 고착된다(Codex 후속 지적 2).
    this.core.assertNoActiveWork(topicId);
    const topic = this.core.dependencies.database.getTopic(topicId);
    const flags = this.core.dependencies.database.getFlags(topicId);
    const resume = flags.resumeState;
    if (!resume) throw new Error("재시도할 단계가 기록되어 있지 않습니다.");
    // 개정 턴이 결정을 물어 멈췄고 결정이 올라왔다 — 그 개정본을 저장해 종결 확인으로 넘긴다(개정 턴 재구매 방지).
    // 아래 사다리(resumers)가 CLAUDE_REVISION 을 "개정 재실행" 으로 잡기 전에 먼저 본다.
    if (resume === "CLAUDE_REVISION" && this.planning.replanRequested(topicId)) {
      // 사용자가 결정에 REPLAN 을 적었다 — 핵심 전제가 바뀐 경우라 처음부터 다시 돈다(직전 계획 전문은 프롬프트에 실린다).
      this.core.resetToDraft(topic, "결정의 REPLAN 지시로 계획 수렴을 처음부터 다시 실행합니다.");
      return this.startPlan(topicId, actionId);
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
        return this.core.startAction(topicId, "retry", resumers[stage], actionId);
      }
    }
    if (resume === "CLAUDE_PLAN" && this.planning.pausedPlanReusable(topicId)) {
      // 계획 턴이 결정을 물어 멈췄고 결정이 올라왔다 — 그 계획을 저장해 감사로 넘긴다(계획 턴 재구매 방지).
      return this.core.startAction(topicId, "retry", (signal) => this.planning.resumePlanningFromPausedPlan(topicId, signal), actionId);
    }
    if (["CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK"].includes(resume)) {
      // 계획 왕복은 4회 경계를 보존하기 위해 중간 단계를 반복하지 않고 첫 계획부터 다시 실행한다.
      // 범위 세대는 올리지 않는다. 재시도의 근거가 된 사용자 evidence·decision이 같은 세대에 있어야 새 프롬프트에 실린다.
      this.core.resetToDraft(topic, "계획 실행을 처음부터 재시도합니다.");
      return this.startPlan(topicId, actionId);
    }
    if (["IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX", "CODEX_FINAL_REVIEW"].includes(resume)) {
      this.core.transition(topicId, resume, "중단된 구현 단계를 재시도합니다.");
      return this.core.startAction(topicId, "retry", (signal) => this.delivery.resumeDelivery(topicId, resume, signal), actionId);
    }
    throw new Error(`재시도를 지원하지 않는 단계입니다: ${resume}`);
  }

  approve(topicId: string, planSHA256: string): Topic {
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state !== "AWAITING_USER_APPROVAL" || topic.planSHA256 !== planSHA256) {
      throw new Error("현재 승인을 기다리는 계획 해시와 일치하지 않습니다.");
    }
    if (!bothAgentsAcknowledged(topic.participants, planSHA256)) {
      throw new Error("두 에이전트가 같은 계획 해시를 ACK하지 않았습니다.");
    }
    const updated = this.core.dependencies.database.updateTopic(topicId, { approvedPlanSHA256: planSHA256 });
    this.core.event(topicId, "user", "decision", "현재 계획 버전의 구현을 승인했습니다.", { planSHA256 });
    return updated;
  }

  close(topicId: string): Topic {
    if (this.core.active.has(topicId) || this.core.deliveryActive.has(topicId) || this.core.scopeChangeActive.has(topicId)) {
      throw new Error("다른 작업이 끝난 뒤 주제를 닫아 주세요.");
    }
    // 닫으면 전달 잠금이 READY_TO_DELIVER를 요구하는 되돌리기 경로가 영구히 막힌다. 처분 전에는 닫지 않는다.
    if (this.core.dependencies.database.getFlags(topicId).orphanCommitOID) {
      throw new Error("전달하지 못한 로컬 커밋을 먼저 되돌리거나 직접 처분한 뒤 주제를 닫아 주세요.");
    }
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state !== "READY_TO_DELIVER") throw new Error("전달 준비가 끝난 주제만 닫을 수 있습니다.");
    return this.core.transition(topicId, "CLOSED", "주제를 닫았습니다.");
  }

  // 전달(commit/push/처분) API는 DeliveryPipeline에 위임한다.
  commit(topicId: string, message: string, paths: string[]): Promise<string> {
    return this.delivery.commit(topicId, message, paths);
  }

  push(topicId: string): Promise<string> {
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

  async postMessage(
    topicId: string,
    kind: "note" | "evidence" | "decision",
    body: string,
    requestKey?: string,
  ): Promise<Topic> {
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (topic.state === "AWAITING_USER_APPROVAL") {
      // 계획만 무효화하는 경로다. 범위는 그대로이므로 세대·세션·worktree·타임라인을 유지하고
      // planEpoch만 올린다 — 두 에이전트가 같은 대화 위에서 다시 수렴한다.
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
              ...(requestKey ? { requestKey, requestAction: `message:${kind}` } : {}),
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
      payload: requestKey ? { requestKey, requestAction: `message:${kind}` } : {},
    });
    if ((kind === "evidence" && topic.state === "BLOCKED_ON_EVIDENCE") ||
        (kind === "decision" && topic.state === "USER_DECISION_REQUIRED")) {
      this.core.event(topicId, "system", "system", "새 정보가 추가되었습니다. 재시도를 눌러 해당 단계를 다시 실행하세요.");
    }
    return this.core.dependencies.database.getTopic(topicId);
  }

  async handleScopeChange(topicId: string, body: string, requestKey?: string): Promise<Topic> {
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
