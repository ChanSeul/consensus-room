import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ReviewCriteria, SessionEnvironment } from "../shared/sessionSettings.js";

// Small indexed metadata only: no transcript scans or source bodies on graph refresh.
export class SessionRecords {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS session_environments(execution_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,provider TEXT NOT NULL,session_id TEXT,record_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS session_environments_topic ON session_environments(topic_id,provider,session_id);
      CREATE TABLE IF NOT EXISTS review_criteria_attempts(id TEXT PRIMARY KEY,logical_key TEXT NOT NULL,record_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS review_criteria_attempt_key ON review_criteria_attempts(logical_key);`);
  }
  observe(topicId: string, record: SessionEnvironment): void {
    this.db.prepare(`INSERT INTO session_environments VALUES(?,?,?,?,?) ON CONFLICT(execution_id) DO UPDATE SET session_id=excluded.session_id,record_json=excluded.record_json`)
      .run(record.executionId, topicId, record.provider, record.sessionId, JSON.stringify(record));
  }
  forTopic(topicId: string): SessionEnvironment[] {
    return this.db.prepare(`SELECT e.record_json FROM session_environments e JOIN
      (SELECT MAX(rowid) AS latest FROM session_environments WHERE topic_id=? GROUP BY provider,session_id) s ON e.rowid=s.latest ORDER BY e.rowid`).all(topicId)
      .map(row => JSON.parse(String(row.record_json)) as SessionEnvironment);
  }
  // The logical contract key is immutable, including failures after a model response. New plan contracts/ledger IDs get new snapshots.
  criteria(key: string, value: ReviewCriteria | undefined): { id: string; criteria: ReviewCriteria } {
    const row = this.db.prepare("SELECT record_json FROM review_criteria_attempts WHERE logical_key=? ORDER BY rowid DESC LIMIT 1").get(key);
    const previous = row ? JSON.parse(String(row.record_json)) as { id: string; criteria: ReviewCriteria } : null;
    if (previous) return previous;
    const record = { id: randomUUID(), criteria: value ?? { selectedIds: [], additionalText: "" } };
    this.db.prepare("INSERT INTO review_criteria_attempts VALUES(?,?,?)").run(record.id, key, JSON.stringify(record));
    return record;
  }
}
