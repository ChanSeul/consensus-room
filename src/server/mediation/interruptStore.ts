import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TimelineEvent, Topic } from "../../shared/contracts.js";
import { needsMediatorAttention, type MediatorConnectionStatus, type MediatorInterventionStatus, type MediatorInterrupt, type MediatorInterruptStatus } from "../../shared/mediatorInterrupts.js";
import type { ActionRecord } from "../types.js";
import { ACTIVE_WORKFLOW_STATES } from "../../shared/workflow.js";

type Delivery = { state: "sending" | "sent" | "acknowledged" | "failed" | "unknown"; claim: string; attempts: number; updatedAt: number; error: string | null; transportUnavailable?: boolean };
type Record = MediatorInterrupt & { binding: string; reviewProgress?: boolean; continuationKey?: string; open: boolean; deliveries: { [target: string]: Delivery };
  handling?: { [target: string]: string }; startedActionId?: string; resumed?: { at: string; actionId: string } };
function conflict(message: string): never { throw Object.assign(new Error(message), { statusCode: 409 }); }
export class MediatorInterruptStore {
  constructor(private readonly db: DatabaseSync, private readonly clock = Date.now, private readonly continuation: (topicId: string) => { key: string; reason: string } | null = () => null) {
    db.exec("CREATE TABLE IF NOT EXISTS mediator_interrupts(id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), open INTEGER NOT NULL, record_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS mediator_interrupts_topic ON mediator_interrupts(topic_id,open);");
    db.exec("CREATE TABLE IF NOT EXISTS mediator_connections(target TEXT NOT NULL, topic_id TEXT NOT NULL REFERENCES topics(id), checked_at INTEGER NOT NULL, available INTEGER NOT NULL, error TEXT, PRIMARY KEY(target,topic_id));");
  }
  reportConnection(target: string, topicId: string, available: boolean, error: string | null): void {
    this.db.prepare("INSERT INTO mediator_connections VALUES(?,?,?,?,?) ON CONFLICT(target,topic_id) DO UPDATE SET checked_at=excluded.checked_at,available=excluded.available,error=excluded.error")
      .run(target, topicId, this.clock(), available ? 1 : 0, error);
  }
  connection(target: string | null, topicId: string): MediatorConnectionStatus {
    const empty = { subscriptionTopicId: null, checkedAt: null, error: null };
    if (!target) return { ...empty, state: "unconfigured" };
    const exact = this.db.prepare("SELECT * FROM mediator_connections WHERE target=? AND topic_id=?").get(target, topicId);
    const row = exact ?? this.db.prepare("SELECT * FROM mediator_connections WHERE target=? ORDER BY checked_at DESC LIMIT 1").get(target);
    if (!row) return { ...empty, state: "unreported" };
    return { subscriptionTopicId: String(row.topic_id), checkedAt: new Date(Number(row.checked_at)).toISOString(), error: row.error === null ? null : String(row.error),
      state: this.clock() - Number(row.checked_at) >= 90_000 ? "stale" : !exact ? "scope-mismatch" : row.available ? "connected" : "unavailable" };
  }
  handling(topicId: string, id: string, target: string): void {
    const record = this.current(topicId);
    if (!record || record.id !== id) conflict("현재 개입 요청이 아닙니다.");
    record.handling ??= {}; record.handling[target] ??= new Date(this.clock()).toISOString(); this.save(record);
  }
  // Admission alone cannot release a stop: an evidence assessment may leave it unchanged.
  // Pair the admitted action with an actual active-state transition in current().
  actionStarted(topic: Topic, action: ActionRecord): void {
    const row = this.db.prepare("SELECT record_json FROM mediator_interrupts WHERE topic_id=? AND open=1 ORDER BY rowid DESC LIMIT 1").get(topic.id);
    if (!row || action.status !== "running" || !["plan", "implement", "retry", "evidence-assessment", "brainstorm", "brainstorm-plan", "brainstorm-close"].includes(action.kind)) return;
    const record: Record = JSON.parse(String(row.record_json)), binding = JSON.parse(record.binding);
    if (record.reviewProgress || record.continuationKey || binding[0] !== topic.scopeGeneration || binding[1] !== topic.planEpoch || !needsMediatorAttention(record.state)) return;
    this.save({ ...record, startedActionId: action.id });
  }
  intervention(topicId: string, target: string | null): MediatorInterventionStatus | null {
    this.current(topicId); // Expire obsolete open requests before presenting history.
    const row = this.db.prepare("SELECT record_json FROM mediator_interrupts WHERE topic_id=? ORDER BY rowid DESC LIMIT 1").get(topicId);
    if (!row || !target) return null;
    const record: Record = JSON.parse(String(row.record_json)), binding = JSON.parse(record.binding);
    const topic = this.db.prepare("SELECT scope_generation,plan_epoch FROM topics WHERE id=?").get(topicId);
    if (!topic || binding[0] !== Number(topic.scope_generation) || binding[1] !== Number(topic.plan_epoch)) return null;
    const delivery = this.delivery(record, target);
    return { id: record.id, delivery: delivery?.state ?? "waiting", handlingAt: record.handling?.[target] ?? null,
      resumedAt: record.resumed?.at ?? null, actionId: record.resumed?.actionId ?? null, closed: !record.open };
  }
  // Called in the same transaction as the timeline event. Replay on startup repairs pre-feature/recovery state.
  observe(topic: Topic, event: Pick<TimelineEvent, "sequence" | "body" | "actor" | "payload">, resumeState: string | null): void {
    const previous = this.current(topic.id);
    const progress = event.actor === "system" && Boolean(event.payload.reviewProgress);
    const continuation = topic.state === "CLOSED" ? this.continuation(topic.id) : null;
    const binding = JSON.stringify([topic.scopeGeneration, topic.planEpoch, progress ? "review-progress" : continuation?.key ?? topic.state]);
    const attention = Boolean(continuation) || needsMediatorAttention(topic.state) && !(topic.state === "BRAINSTORM_READY" && !event.payload.brainstormCompletedActionId);
    // A periodic inspection is advisory and survives normal stage transitions. A real stop
    // replaces it, carrying the inspection request so a quick final reply cannot lose it.
    if (!progress && !attention && previous?.reviewProgress) return;
    if (previous && (progress || previous.binding !== binding || !attention)) this.save({ ...previous, open: false });
    if ((!attention && !progress) || (!progress && previous?.binding === binding) || event.actor !== "system") return;
    const stage = progress ? topic.state : resumeState ?? String(event.payload.from ?? topic.state);
    const sourceRole = ["IMPLEMENTING", "CLAUDE_FIX"].includes(stage) ? "runner"
      : ["CODEX_AUDIT", "CODEX_CLOSEOUT", "CODEX_REVIEW", "CODEX_FINAL_REVIEW", "CONSENSUS_ACK"].includes(stage) ? "reviewer"
        : ["CLAUDE_PLAN", "CLAUDE_REVISION"].includes(stage) ? "planner" : "system";
    this.save({ id: randomUUID(), topicId: topic.id, title: topic.title, state: topic.state, binding, reviewProgress: progress || undefined, continuationKey: continuation?.key, open: true,
      reason: continuation ? continuation.reason : progress ? event.body : [topic.lastError ?? event.body, previous?.reviewProgress ? previous.reason : ""].filter(Boolean).join("\n"), sourceRole, sequence: event.sequence, createdAt: new Date(this.clock()).toISOString(), deliveries: {} });
  }
  current(topicId: string): Record | null {
    const row = this.db.prepare("SELECT record_json FROM mediator_interrupts WHERE topic_id=? AND open=1 ORDER BY rowid DESC LIMIT 1").get(topicId);
    if (!row) return null;
    const record: Record = JSON.parse(String(row.record_json));
    const topic = this.db.prepare("SELECT scope_generation,plan_epoch,state FROM topics WHERE id=?").get(topicId);
    const continuationKey = record.continuationKey ? this.continuation(topicId)?.key : undefined;
    if (!topic || (record.continuationKey && continuationKey !== record.continuationKey) || (record.reviewProgress && topic.state === "CLOSED") || record.binding !== JSON.stringify([Number(topic.scope_generation), Number(topic.plan_epoch), record.reviewProgress ? "review-progress" : continuationKey ?? topic.state])) {
      const binding = JSON.parse(record.binding);
      if (topic && record.startedActionId && !record.reviewProgress && !record.continuationKey
        && binding[0] === Number(topic.scope_generation) && binding[1] === Number(topic.plan_epoch)
        && (ACTIVE_WORKFLOW_STATES.has(topic.state as Topic["state"]) || topic.state === "CONSENSUS_ACK")
        && this.db.prepare("SELECT 1 FROM actions WHERE id=? AND topic_id=? AND status='running'").get(record.startedActionId, topicId)) {
        record.resumed = { at: new Date(this.clock()).toISOString(), actionId: record.startedActionId };
      }
      this.save({ ...record, open: false }); return null;
    }
    return record;
  }
  private save(record: Record): void {
    this.db.prepare("INSERT INTO mediator_interrupts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET open=excluded.open,record_json=excluded.record_json")
      .run(record.id, record.topicId, record.open ? 1 : 0, JSON.stringify(record));
  }
  private delivery(record: Record, target: string): Delivery | undefined {
    const delivery = record.deliveries[target];
    if (delivery?.state === "sending" && this.clock() - delivery.updatedAt >= 30_000) {
      delivery.state = "unknown"; delivery.error = "전송 응답을 확인하지 못했습니다. 실제 세션을 확인한 뒤 다시 요청하세요."; this.save(record);
    }
    return delivery;
  }
  pending(topicId: string, target: string): MediatorInterrupt | null {
    const record = this.current(topicId); if (!record) return null;
    if (record.handling?.[target]) return null;
    const d = this.delivery(record, target);
    return !d || d.state === "failed" && (d.transportUnavailable || d.attempts < 3) && this.clock() - d.updatedAt >= (d.transportUnavailable ? 60_000 : Math.min(30_000, d.attempts * 5_000))
      ? this.publicRecord(record) : null;
  }
  claim(topicId: string, id: string, target: string): { interrupt: MediatorInterrupt; claim: string } {
    const record = this.current(topicId);
    if (!record || record.id !== id || !this.pending(topicId, target)) conflict("이미 전달됐거나 현재 개입 요청이 아닙니다.");
    const claim = randomUUID();
    record.deliveries[target] = { state: "sending", claim, attempts: (record.deliveries[target]?.attempts ?? 0) + 1, updatedAt: this.clock(), error: null };
    this.save(record); return { interrupt: this.publicRecord(record), claim };
  }
  receipt(topicId: string, id: string, target: string, claim: string, state: Delivery["state"], error: string | null, transportUnavailable = false): void {
    if (transportUnavailable && state !== "failed") conflict("연결 전 실패만 자동 재연결할 수 있습니다.");
    const record = this.current(topicId), previous = record?.deliveries[target];
    if (!record || record.id !== id || !previous || previous.claim !== claim) conflict("현재 전송 시도의 응답이 아닙니다.");
    if (previous.state === state || previous.state === "acknowledged" && state === "sent") return;
    if (transportUnavailable && previous.state !== "sending") conflict("응답 미확인 전송을 연결 전 실패로 바꿀 수 없습니다.");
    if (!["sending", "unknown"].includes(previous.state) && !(previous.state === "sent" && state === "acknowledged")) conflict("전송 상태가 이미 확정되었습니다.");
    record.deliveries[target] = { ...previous, state, attempts: transportUnavailable ? Math.max(0, previous.attempts - 1) : previous.attempts, updatedAt: this.clock(), error, transportUnavailable }; this.save(record);
  }
  retry(topicId: string, id: string, target: string): void {
    const record = this.current(topicId); if (!record || record.id !== id) conflict("현재 개입 요청이 아닙니다.");
    const delivery = this.delivery(record, target);
    if (!delivery || !["failed", "unknown"].includes(delivery.state)) conflict("재전송할 실패·응답 미확인 요청이 아닙니다.");
    delete record.deliveries[target];
    if (record.handling) delete record.handling[target];
    this.save(record);
  }
  status(topicId: string, target: string | null): MediatorInterruptStatus | null {
    const record = this.current(topicId); if (!record) return null;
    const delivery = target ? this.delivery(record, target) : null;
    return { id: record.id, state: target ? delivery?.state ?? "waiting" : "unconfigured", reason: record.reason, error: delivery?.error ?? null };
  }
  private publicRecord({ id, topicId, title, state, reason, sequence, createdAt, sourceRole }: Record): MediatorInterrupt {
    return { id, topicId, title, state, reason, sequence, createdAt, sourceRole };
  }
}
