import { randomUUID } from "node:crypto";
import { ContinuationInputSchema, type ContinuationRecord } from "../../shared/continuation.js";
import { redactSecrets } from "../../shared/workflow.js";
import type { ConsensusDatabase } from "../database.js";
import { stableJSON } from "../evidence/store.js";
import type { CallOrigin, WorkflowEngine } from "../workflow.js";
import type { WorkGroupService } from "../workGroupService.js";
import { reportBackgroundFailure, runBackgroundTask } from "../backgroundTask.js";

class HostStopping extends Error {}

// The scheduler persists intent and observes outcomes. The workflow port owns all eligibility,
// recovery dispatch, approval and delivery checks; scheduling cannot inspect its private flags.
export type ContinuationWorkflow = Pick<WorkflowEngine, "assertContinuationIdle" | "continuationAdmission" | "resumeApprovedDelivery" |
  "retry" | "reviewCurrentEvidence" | "approve" | "startImplementation" | "pendingCommitPaths" | "resumeInfo" |
  "commit" | "assertReviewedLocalDelivery" | "closeStage" | "startPlan">;

// One durable owner advances an explicitly authorized plan through its prerequisites.
// Notifications are observability, never the mechanism which executes the next step.
export class ContinuationCoordinator {
  private timer?: ReturnType<typeof setInterval>;
  private scheduled = false;
  private stopping = false;
  private readonly active = new Map<string, Promise<void>>();
  private readonly faulted = new Set<string>();
  constructor(private readonly db: ConsensusDatabase, private readonly workflow: ContinuationWorkflow,
    private readonly groups: WorkGroupService) {}

  arm(topicId: string, value: unknown, origin?: CallOrigin): ContinuationRecord {
    if (this.stopping) throw new HostStopping("서버 종료 중입니다.");
    const input = ContinuationInputSchema.parse(value), topic = this.db.getTopic(topicId);
    // Explicit reauthorization owns both retry and subsequent delivery. Ordinary retry must not
    // silently resurrect a cancelled continuation or forget a failed action's outcome.
    const recovering = this.workflow.continuationAdmission(topicId, input.planSHA256) === "recover-delivery";
    const previous = this.db.continuations.get(topicId);
    if (previous && ["pending", "running"].includes(previous.status)) throw new Error("이미 자동 진행 중입니다. resume에서 현재 작업을 확인하세요.");
    if (input.nextStage) {
      const group = this.db.workGroups.forTopic(topicId);
      if (!group || group.id !== input.nextStage.groupId || group.version !== input.nextStage.version ||
          !group.stages.some(stage => stage.id === input.nextStage!.stageId) || group.links[input.nextStage.stageId])
        throw new Error("현재 묶음 버전의 아직 시작하지 않은 다음 단계를 지정하세요.");
      if (this.binding(group.parentTopicId ?? topicId) !== this.binding(topicId)) throw new Error("다음 단계의 중재자 배정이 현재 주제와 다릅니다.");
    }
    const evidence = this.db.evidence.topic(topic);
    if (!evidence.reviewed) this.db.evidence.automation.retryPlanReview(topic, evidence.sources, evidence.digest);
    const record = this.db.continuations.save({ ...input, reason: redactSecrets(input.reason), id: randomUUID(), topicId,
      scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, mediator: this.binding(topicId),
      inputSequence: this.db.getTimeline(topicId).at(-1)?.sequence ?? 0,
      status: "pending", step: recovering ? "implement" : "evidence", actionId: null, nextTopicId: null, error: null, updatedAt: "" });
    this.db.appendEvent({ topicId, actor: "system", kind: "system", state: topic.state,
      body: `현재 계획의 자동 진행을 예약했습니다: ${record.reason}`, payload: { continuationId: record.id, planSHA256: record.planSHA256, origin } });
    this.start();
    return record;
  }

  start(): void {
    if (this.stopping) return;
    this.timer ??= setInterval(() => this.wake(), 5000).unref();
    this.wake();
  }
  wake(): void {
    if (this.stopping || this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      if (this.stopping) return;
      try {
        for (const record of this.db.continuations.pending()) {
          if (this.active.has(record.topicId) || this.faulted.has(record.id)) continue;
          const task = runBackgroundTask(`continuation:${record.id}`, () => this.advance(record), error => {
            if (error instanceof HostStopping) return;
            // If persistence fails, do not silently retry side effects on the next timer tick.
            this.faulted.add(record.id);
            this.update(record, { status: "blocked", error: redactSecrets(String(error)) });
          }, () => { this.active.delete(record.topicId); });
          this.active.set(record.topicId, task);
        }
      } catch (error) { reportBackgroundFailure("continuation:scan", error); }
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    try {
      for (const record of this.db.continuations.pending()) this.db.appendEvent({ topicId: record.topicId, actor: "system", kind: "system",
        state: this.db.getTopic(record.topicId).state, body: "서버 종료 뒤 이어갈 자동 진행 예약을 보존했습니다.",
        payload: { continuationSuspended: record.id } });
    } catch (error) { reportBackgroundFailure("continuation:shutdown", error); }
    await Promise.allSettled(this.active.values());
  }

  private binding(topicId: string): string { return stableJSON(this.db.roles.effective(topicId, "mediator")); }
  private ownsEvidenceRevision(record: ContinuationRecord): boolean {
    return record.step === "evidence" && this.db.getTimeline(record.topicId, record.inputSequence).some(event =>
      event.payload?.continuationId === record.id && event.payload.evidenceRevisionBaseSHA256 === record.planSHA256);
  }
  private valid(record: ContinuationRecord): void {
    const stored = this.db.continuations.get(record.topicId), topic = this.db.getTopic(record.topicId);
    if (this.stopping) throw new HostStopping("서버 종료 뒤 같은 예약에서 이어갑니다.");
    if (stored?.id !== record.id || !["pending", "running"].includes(stored.status)) throw new Error("자동 진행이 중지되거나 교체됐습니다.");
    if (topic.scopeGeneration !== record.scopeGeneration || topic.planEpoch !== record.planEpoch || (topic.planSHA256 !== record.planSHA256 && !this.ownsEvidenceRevision(record)) ||
        this.binding(topic.id) !== record.mediator) throw new Error("계획·범위 또는 중재자 배정이 바뀌어 이전 자동 진행 권한을 사용하지 않았습니다.");
    const input = this.db.getTimeline(topic.id, record.inputSequence).find(event => event.actor === "user" &&
      ["decision", "evidence", "scope_change"].includes(event.kind) &&
      !(event.payload?.planSHA256 === record.planSHA256 && !event.payload?.invalidatedPlanSHA256) && !event.payload?.deliveryAction);
    if (input) throw new Error("자동 진행 예약 후 새 사용자 입력이 있습니다. 반영 내용을 확인한 뒤 재개하세요.");
  }
  private update(record: ContinuationRecord, patch: Partial<ContinuationRecord>): void {
    const current = this.db.continuations.get(record.topicId);
    if (!current || current.id !== record.id || !["pending", "running"].includes(current.status)) return;
    this.db.continuations.save({ ...current, ...patch });
    if (patch.error && patch.error !== current.error) this.db.appendEvent({ topicId: record.topicId, actor: "system", kind: "system",
      state: this.db.getTopic(record.topicId).state, body: `자동 진행 확인 필요: ${patch.error}`, payload: { continuationId: record.id, step: patch.step ?? current.step } });
  }
  private launch(record: ContinuationRecord, step: ContinuationRecord["step"], run: (id: string) => string | null): void {
    const actionId = randomUUID();
    // Persist intent before the action. A crash before admission is distinguishable from an unfinished action.
    this.update(record, { status: "running", step, actionId, error: null });
    run(actionId);
    this.wake();
  }
  private async advance(record: ContinuationRecord): Promise<void> {
    this.valid(record);
    const topic = this.db.getTopic(record.topicId);
    if (this.db.runningAction(topic.id)) return;
    // Resource/maintenance locks are temporary, not a forgotten or consumed continuation.
    try { this.workflow.assertContinuationIdle(topic.id); }
    catch (error) { this.update(record, { status: "pending", error: redactSecrets(String(error)) }); return; }
    const action = record.actionId && this.db.getAction(record.actionId);
    if (!action && record.step === "implement" && topic.state === "FAILED") {
      // A new explicit continuation grants one recovery attempt, through the normal retry gates.
      // A reserved ID without an action row means the host stopped before admission, not a failed attempt.
      // A later failure stays attached to that action and cannot create an automatic retry loop.
      this.launch(record, "implement", id => this.workflow.resumeApprovedDelivery(topic.id, record.planSHA256, id)); return;
    }
    if (action && action.status !== "succeeded") {
      // Only a host interruption is automatically recoverable here. Manual stop cancels the
      // durable intent; budget/decision/provider failures retain their existing recovery gate.
      const hostInterrupted = action.status === "cancelled" && /^서버 (종료|재시작)/.test(action.error ?? "");
      if (!hostInterrupted) throw new Error(action.error || `이전 ${record.step} 실행 결과가 ${action.status}입니다.`);
      if (record.step === "evidence" && topic.state === "FAILED" && this.ownsEvidenceRevision(record)) {
        this.launch(record, "evidence", id => this.workflow.retry(topic.id, id)); return;
      } else if (record.step === "evidence") {
        const evidence = this.db.evidence.topic(topic);
        this.db.evidence.automation.retryPlanReview(topic, evidence.sources, evidence.digest);
      } else if (record.step === "implement" && topic.state === "FAILED") {
        this.launch(record, "implement", id => this.workflow.retry(topic.id, id)); return;
      } else throw new Error(action.error || "중단된 작업을 확인해야 합니다.");
    }
    if (topic.planSHA256 !== record.planSHA256) {
      if (topic.state !== "AWAITING_USER_APPROVAL" || !this.ownsEvidenceRevision(record))
        throw new Error("개정 계획의 합의가 완료되지 않았습니다. 보존된 개정 단계에서 복구하세요.");
      this.update(record, { status: "awaiting-approval", error: "근거 검토를 반영한 새 계획의 합의가 끝났습니다. 기존 승인 범위와 대조한 뒤 새 계획 해시로 이어가세요." });
      return;
    }
    if (topic.state === "AWAITING_USER_APPROVAL" || topic.state === "READY_TO_DELIVER") {
      const evidence = this.db.evidence.topic(topic);
      if (!evidence.ready) { this.update(record, { status: "pending", step: "evidence", error: "필수 근거 범위 승인을 기다립니다." }); return; }
      if (!evidence.reviewed) {
        this.launch(record, "evidence", id => this.workflow.reviewCurrentEvidence(topic.id, id)); return;
      }
    }
    if (topic.state === "AWAITING_USER_APPROVAL") {
      this.update(record, { step: "approve", error: null });
      if (topic.approvedPlanSHA256 !== record.planSHA256) this.workflow.approve(topic.id, record.planSHA256);
      this.valid(record);
      this.launch(record, "implement", id => this.workflow.startImplementation(topic.id, id)); return;
    }
    if (topic.state === "READY_TO_DELIVER") {
      if (!record.localDelivery) { this.update(record, { status: "complete", step: "complete", error: null }); return; }
      const key = `continuation:${record.id}:commit`, request = this.db.getActionRequest(topic.id, "commit", key);
      if (request && request.status !== "succeeded") throw new Error(request.error || "이전 자동 커밋 결과를 확인해야 합니다. 재실행하지 않았습니다.");
      const changed = await this.workflow.pendingCommitPaths(topic.id);
      const canCloseUnchanged = changed.length === 0 &&
        (await this.workflow.resumeInfo(topic.id)).nextActions.some(action => action.action === "close" && action.blocker === null);
      this.valid(record);
      if (!canCloseUnchanged) {
        this.update(record, { step: "commit", actionId: null, error: null });
        if (!request) {
          this.valid(record);
          this.db.claimActionRequest(topic.id, "commit", key, record.localDelivery);
          try {
            const oid = await this.workflow.commit(topic.id, record.localDelivery.message, record.localDelivery.paths, key);
            this.db.finishActionRequest(topic.id, "commit", key, { accepted: true, actionId: oid });
          } catch (error) {
            this.db.failActionRequest(topic.id, "commit", key, redactSecrets(String(error))); throw error;
          }
        }
      }
      this.valid(record);
      await this.workflow.assertReviewedLocalDelivery(topic.id);
      this.valid(record);
      this.update(record, { step: "close", actionId: null });
      await this.workflow.closeStage(topic.id);
      this.wake(); return;
    }
    if (topic.state === "CLOSED") {
      if (!record.nextStage) { this.update(record, { status: "complete", step: "complete", error: null }); return; }
      const next = record.nextStage, group = this.db.workGroups.get(next.groupId);
      if (group.version !== next.version || this.binding(group.parentTopicId ?? topic.id) !== record.mediator)
        throw new Error("다음 단계의 묶음 버전 또는 중재자 배정이 바뀌었습니다.");
      this.update(record, { step: "next-plan", actionId: null });
      let nextTopicId = group.links[next.stageId]?.topicId;
      if (nextTopicId && nextTopicId !== record.nextTopicId) throw new Error("다음 단계가 별도 요청으로 이미 열렸습니다. 중복 착수하지 않았습니다.");
      if (!nextTopicId) {
        this.valid(record);
        const admission = this.groups.continuation(group);
        if (admission.stageId !== next.stageId) throw new Error(admission.reason || "현재 착수 가능한 다음 단계가 승인한 단계와 다릅니다.");
        const created = await this.groups.next(group.id, id => this.update(record, { nextTopicId: id }));
        nextTopicId = created.id;
      }
      this.valid(record);
      this.update(record, { nextTopicId });
      if (this.db.workGroups.get(group.id).version !== next.version) throw new Error("다음 단계 생성 중 묶음 버전이 바뀌었습니다. 계획을 시작하지 않았습니다.");
      const nextTopic = this.db.getTopic(nextTopicId);
      if (this.binding(nextTopicId) !== record.mediator) throw new Error("다음 단계의 중재자 배정이 바뀌었습니다.");
      if (nextTopic.state === "DRAFT" && !this.db.runningAction(nextTopicId)) this.workflow.startPlan(nextTopicId);
      else if (["FAILED", "USER_DECISION_REQUIRED", "CLOSED"].includes(nextTopic.state)) throw new Error("다음 단계가 별도 정지 또는 완료 상태입니다. 계획 시작 결과를 확인해야 합니다.");
      // This permission opens/plans the specified next stage, never approves its unseen plan.
      this.update(record, { status: "complete", step: "complete", error: null }); return;
    }
    throw new Error(topic.lastError || `${topic.state} 단계의 복구 조건을 확인해야 합니다. 기존 계획과 체크포인트를 보존했습니다.`);
  }
}
