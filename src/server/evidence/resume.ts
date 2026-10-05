import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Topic, WorkflowState } from "../../shared/contracts.js";

export const EVIDENCE_PLANNING_STATES = new Set<WorkflowState>(["CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK"]);
export interface EvidenceResumeIntent {
  topicId: string;
  scopeGeneration: number;
  planEpoch: number;
  planSHA256: string | null;
  mediator: string;
  resumeState: WorkflowState;
  actionId: string;
}

// Execution intent is separate from plan approval and survives only evidence-driven invalidation.
export class EvidenceResumeStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec("CREATE TABLE IF NOT EXISTS evidence_resume_intents(topic_id TEXT PRIMARY KEY REFERENCES topics(id) ON DELETE CASCADE,record TEXT NOT NULL)");
  }
  list(): EvidenceResumeIntent[] {
    return this.db.prepare("SELECT record FROM evidence_resume_intents").all().map(row => JSON.parse(String(row.record)));
  }
  get(topicId: string): EvidenceResumeIntent | null {
    const row = this.db.prepare("SELECT record FROM evidence_resume_intents WHERE topic_id=?").get(topicId);
    return row ? JSON.parse(String(row.record)) : null;
  }
  private save(intent: EvidenceResumeIntent): void {
    this.db.prepare("INSERT INTO evidence_resume_intents VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record=excluded.record")
      .run(intent.topicId, JSON.stringify(intent));
  }
  arm(topic: Topic, resumeState: WorkflowState, mediator: string): void {
    this.save({ topicId: topic.id, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
      planSHA256: topic.planSHA256, resumeState, mediator, actionId: randomUUID() });
  }
  cancel(topicId: string): boolean {
    return this.db.prepare("DELETE FROM evidence_resume_intents WHERE topic_id=?").run(topicId).changes > 0;
  }
  invalidate(topicId: string): void {
    const intent = this.get(topicId);
    if (!intent) return;
    const topic = this.db.prepare("SELECT scope_generation,plan_epoch,plan_sha256,state FROM topics WHERE id=?").get(topicId);
    if (!topic || topic.scope_generation !== intent.scopeGeneration || topic.plan_epoch !== intent.planEpoch ||
        topic.plan_sha256 !== intent.planSHA256 || !["DRAFT", "BLOCKED_ON_EVIDENCE"].includes(String(topic.state)) ||
        !(intent.resumeState === "DRAFT" || EVIDENCE_PLANNING_STATES.has(intent.resumeState))) {
      this.cancel(topicId); return;
    }
    this.save({ ...intent, planEpoch: intent.planEpoch + 1, planSHA256: null, resumeState: "DRAFT" });
  }
}
