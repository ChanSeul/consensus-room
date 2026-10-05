import type { DatabaseSync } from "node:sqlite";
import type { ContinuationRecord } from "../shared/continuation.js";

export class ContinuationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS workflow_continuations(topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE, record TEXT NOT NULL)");
  }
  get(topicId: string): ContinuationRecord | null {
    const row = this.db.prepare("SELECT record FROM workflow_continuations WHERE topic_id=?").get(topicId);
    return row ? JSON.parse(String(row.record)) : null;
  }
  pending(): ContinuationRecord[] {
    return this.db.prepare("SELECT record FROM workflow_continuations WHERE json_extract(record,'$.status') IN ('pending','running')")
      .all().map(row => JSON.parse(String(row.record)));
  }
  save(record: ContinuationRecord): ContinuationRecord {
    const current = { ...record, updatedAt: new Date().toISOString() };
    this.db.prepare("INSERT INTO workflow_continuations VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record=excluded.record")
      .run(current.topicId, JSON.stringify(current));
    return current;
  }
  cancel(topicId: string): boolean {
    const record = this.get(topicId);
    if (!record || ["cancelled", "complete"].includes(record.status)) return false;
    this.save({ ...record, status: "cancelled", error: "사용자가 자동 진행을 중지했습니다." });
    return true;
  }
}
