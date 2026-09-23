import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Topic } from "../shared/contracts.js";
import type { PlanningCheckpoint, PlanningFragment } from "../shared/planningControl.js";

export const planningHash = (value: string) => createHash("sha256").update(value).digest("hex");
export function planningKey(topic: Topic, role: string, prompt: string): string {
  return planningHash(JSON.stringify([topic.id, topic.scopeGeneration, topic.planEpoch, topic.planSHA256, topic.state, role, prompt]));
}

export class PlanningStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS planning_policies(topic_id TEXT PRIMARY KEY, version INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_checkpoints(key TEXT PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_fragments(key TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_archives(id INTEGER PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);`);
  }
  enabled(topicId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM planning_policies WHERE topic_id=? AND version=1").get(topicId));
  }
  enable(topicId: string): void {
    this.db.prepare("INSERT INTO planning_policies VALUES (?,1) ON CONFLICT(topic_id) DO NOTHING").run(topicId);
  }
  get(key: string): PlanningCheckpoint | null {
    const row = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE key=?").get(key);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  save(record: PlanningCheckpoint): void {
    this.db.prepare("INSERT INTO planning_checkpoints VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET record_json=excluded.record_json")
      .run(record.key, record.topicId, JSON.stringify(record));
  }
  latest(topicId: string): PlanningCheckpoint | null {
    const row = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE topic_id=? ORDER BY json_extract(record_json,'$.updatedAt') DESC, rowid DESC LIMIT 1").get(topicId);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  archive(record: PlanningCheckpoint): void {
    this.db.prepare("INSERT INTO planning_archives(topic_id,record_json) VALUES (?,?)").run(record.topicId, JSON.stringify(record));
  }
  rekey(previousKey: string, record: PlanningCheckpoint): void {
    this.db.prepare("UPDATE planning_checkpoints SET key=?,record_json=? WHERE key=?")
      .run(record.key, JSON.stringify(record), previousKey);
  }
  sessionContext(sessionId: string): { known: boolean; bytes: number } {
    const rows = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE json_extract(record_json,'$.sessionId')=?").all(sessionId);
    const records = rows.map(r => JSON.parse(String(r.record_json)) as PlanningCheckpoint);
    return { known: records.some(r => r.started), bytes: records.reduce((sum, r) => sum + r.injectedBytes + (r.responseBytes ?? 0), 0) };
  }
  fragment(key: string): PlanningFragment | null {
    const row = this.db.prepare("SELECT record_json FROM planning_fragments WHERE key=?").get(key);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  saveFragment(key: string, fragment: PlanningFragment): void {
    this.db.prepare("INSERT INTO planning_fragments VALUES (?,?) ON CONFLICT(key) DO NOTHING").run(key, JSON.stringify(fragment));
  }
  progress(topicId: string) {
    const r = this.latest(topicId);
    return r ? { version: r.version, checkpointId: r.id, stage: r.stage, round: r.round, updatedAt: r.updatedAt,
      questions: r.step.questions, stopped: r.stopped, finalized: r.finalized, usage: r.usage,
      injectedBytes: r.injectedBytes, deliveredFragments: r.delivered.length,
      lastRequestInputTokens: r.lastRequestInputTokens ?? null, peakRequestInputTokens: r.peakRequestInputTokens ?? null,
      imageBytes: r.imageBytes ?? 0 } : null;
  }
}
