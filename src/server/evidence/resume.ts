import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Topic, WorkflowState } from "../../shared/contracts.js";

export interface EvidenceResumeIntent {
  topicId: string;
  scopeGeneration: number;
  planEpoch: number;
  planSHA256: string | null;
  mediator: string;
  resumeState: WorkflowState;
  actionId: string;
}

// Execution intent is separate from plan approval; a changed scope, plan or mediator binding cancels it (workflow.pollEvidenceAssessments).
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
}
