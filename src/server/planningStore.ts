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
      CREATE TABLE IF NOT EXISTS planning_session_fragments(session_id TEXT NOT NULL,id TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(session_id,id));
      CREATE TABLE IF NOT EXISTS planning_sessions(topic_id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS planning_archives(id INTEGER PRIMARY KEY, topic_id TEXT NOT NULL, record_json TEXT NOT NULL);`);
  }
  policyVersion(topicId: string): number {
    const row = this.db.prepare("SELECT version FROM planning_policies WHERE topic_id=?").get(topicId);
    return row ? Number(row.version) : 0;
  }
  enabled(topicId: string): boolean { return this.policyVersion(topicId) > 0; }
  continuityEnabled(topicId: string): boolean { return this.policyVersion(topicId) === 2; }
  enable(topicId: string): void {
    // Existing policies and in-flight/approved work retain their original session contract.
    const topic = this.db.prepare("SELECT state,resume_state,plan_sha256,implementation_session_id FROM topics WHERE id=?").get(topicId);
    const unstartedPlan = !topic?.plan_sha256 && !topic?.implementation_session_id &&
      (["DRAFT", "CLAUDE_PLAN"].includes(String(topic?.state)) ||
        (["USER_DECISION_REQUIRED", "FAILED"].includes(String(topic?.state)) && topic?.resume_state === "CLAUDE_PLAN"));
    const version = unstartedPlan ? 2 : 1;
    this.db.prepare("INSERT INTO planning_policies VALUES (?,?) ON CONFLICT(topic_id) DO NOTHING").run(topicId, version);
  }
  deliveredToSession(sessionId: string): PlanningFragment[] {
    return this.db.prepare("SELECT record_json FROM planning_session_fragments WHERE session_id=?").all(sessionId)
      .map(row => JSON.parse(String(row.record_json)) as PlanningFragment);
  }
  recordDelivery(sessionId: string, fragments: readonly PlanningFragment[]): void {
    const insert = this.db.prepare("INSERT INTO planning_session_fragments VALUES (?,?,?) ON CONFLICT(session_id,id) DO NOTHING");
    for (const fragment of fragments) insert.run(sessionId, fragment.id, JSON.stringify(fragment));
  }
  get(key: string): PlanningCheckpoint | null {
    const row = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE key=?").get(key);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  save(record: PlanningCheckpoint): void {
    this.db.prepare("INSERT INTO planning_checkpoints VALUES (?,?,?) ON CONFLICT(key) DO UPDATE SET record_json=excluded.record_json")
      .run(record.key, record.topicId, JSON.stringify(record));
  }
  latest(topicId: string, role?: "claude" | "codex"): PlanningCheckpoint | null {
    const row = this.db.prepare("SELECT record_json FROM planning_checkpoints WHERE topic_id=? AND (? IS NULL OR json_extract(record_json,'$.role')=?) ORDER BY json_extract(record_json,'$.updatedAt') DESC, rowid DESC LIMIT 1").get(topicId, role ?? null, role ?? null);
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
  bindSession(topic: Topic, planSHA256: string, sessionId: string, inputSequence: number): void {
    this.db.prepare("INSERT INTO planning_sessions VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record_json=excluded.record_json")
      .run(topic.id, JSON.stringify({ scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
        planSHA256, sessionId, inputSequence }));
  }
  boundSession(topic: Topic): { sessionId: string; inputSequence: number } | null {
    const row = this.db.prepare("SELECT record_json FROM planning_sessions WHERE topic_id=?").get(topic.id);
    if (!row) return null;
    const binding = JSON.parse(String(row.record_json));
    return binding.scopeGeneration === topic.scopeGeneration && binding.planEpoch === topic.planEpoch &&
      binding.planSHA256 === topic.planSHA256 && binding.sessionId === topic.participants.find(p => p.role === "claude")?.sessionId
      ? { sessionId: binding.sessionId, inputSequence: binding.inputSequence } : null;
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
