import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { TimelineEvent, Topic } from "../../shared/contracts.js";
import { needsMediatorAttention, type MediatorInterrupt, type MediatorInterruptStatus } from "../../shared/mediatorInterrupts.js";

type Delivery = { state: "sending" | "sent" | "acknowledged" | "failed" | "unknown"; claim: string; attempts: number; updatedAt: number; error: string | null };
type Record = MediatorInterrupt & { binding: string; open: boolean; deliveries: { [target: string]: Delivery } };
function conflict(message: string): never { throw Object.assign(new Error(message), { statusCode: 409 }); }
export class MediatorInterruptStore {
  constructor(private readonly db: DatabaseSync, private readonly clock = Date.now) {
    db.exec("CREATE TABLE IF NOT EXISTS mediator_interrupts(id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id), open INTEGER NOT NULL, record_json TEXT NOT NULL); CREATE INDEX IF NOT EXISTS mediator_interrupts_topic ON mediator_interrupts(topic_id,open);");
  }
  // Called in the same transaction as the timeline event. Replay on startup repairs pre-feature/recovery state.
  observe(topic: Topic, event: Pick<TimelineEvent, "sequence" | "body" | "actor" | "payload">, resumeState: string | null): void {
    const previous = this.current(topic.id);
    const binding = JSON.stringify([topic.scopeGeneration, topic.planEpoch, topic.state]);
    const attention = needsMediatorAttention(topic.state) && !(topic.state === "BRAINSTORM_READY" && !event.payload.brainstormCompletedActionId);
    if (previous && (previous.binding !== binding || !needsMediatorAttention(topic.state))) this.save({ ...previous, open: false });
    if (!attention || previous?.binding === binding || event.actor !== "system") return;
    const stage = resumeState ?? String(event.payload.from ?? topic.state);
    const sourceRole = ["IMPLEMENTING", "CLAUDE_FIX"].includes(stage) ? "runner"
      : ["CODEX_AUDIT", "CODEX_CLOSEOUT", "CODEX_REVIEW", "CODEX_FINAL_REVIEW", "CONSENSUS_ACK"].includes(stage) ? "reviewer"
        : ["CLAUDE_PLAN", "CLAUDE_REVISION"].includes(stage) ? "planner" : "system";
    this.save({ id: randomUUID(), topicId: topic.id, title: topic.title, state: topic.state, binding, open: true,
      reason: topic.lastError ?? event.body, sourceRole, sequence: event.sequence, createdAt: new Date(this.clock()).toISOString(), deliveries: {} });
  }
  current(topicId: string): Record | null {
    const row = this.db.prepare("SELECT record_json FROM mediator_interrupts WHERE topic_id=? AND open=1 ORDER BY rowid DESC LIMIT 1").get(topicId);
    if (!row) return null;
    const record: Record = JSON.parse(String(row.record_json));
    const topic = this.db.prepare("SELECT scope_generation,plan_epoch,state FROM topics WHERE id=?").get(topicId);
    if (!topic || record.binding !== JSON.stringify([Number(topic.scope_generation), Number(topic.plan_epoch), topic.state])) {
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
    const d = this.delivery(record, target);
    return !d || d.state === "failed" && d.attempts < 3 && this.clock() - d.updatedAt >= Math.min(30_000, d.attempts * 5_000)
      ? this.publicRecord(record) : null;
  }
  claim(topicId: string, id: string, target: string): { interrupt: MediatorInterrupt; claim: string } {
    const record = this.current(topicId);
    if (!record || record.id !== id || !this.pending(topicId, target)) conflict("이미 전달됐거나 현재 개입 요청이 아닙니다.");
    const claim = randomUUID();
    record.deliveries[target] = { state: "sending", claim, attempts: (record.deliveries[target]?.attempts ?? 0) + 1, updatedAt: this.clock(), error: null };
    this.save(record); return { interrupt: this.publicRecord(record), claim };
  }
  receipt(topicId: string, id: string, target: string, claim: string, state: Delivery["state"], error: string | null): void {
    const record = this.current(topicId), previous = record?.deliveries[target];
    if (!record || record.id !== id || !previous || previous.claim !== claim) conflict("현재 전송 시도의 응답이 아닙니다.");
    if (previous.state === state || previous.state === "acknowledged" && state === "sent") return;
    if (!["sending", "unknown"].includes(previous.state) && !(previous.state === "sent" && state === "acknowledged")) conflict("전송 상태가 이미 확정되었습니다.");
    record.deliveries[target] = { ...previous, state, updatedAt: this.clock(), error }; this.save(record);
  }
  retry(topicId: string, id: string, target: string): void {
    const record = this.current(topicId); if (!record || record.id !== id) conflict("현재 개입 요청이 아닙니다.");
    const delivery = this.delivery(record, target);
    if (!delivery || !["failed", "unknown"].includes(delivery.state)) conflict("재전송할 실패·응답 미확인 요청이 아닙니다.");
    delete record.deliveries[target]; this.save(record);
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
