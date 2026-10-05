import type { DatabaseSync } from "node:sqlite";
import type { AgentResult, Topic } from "../../shared/contracts.js";
import type { EvidenceAssessment, EvidenceSource } from "../../shared/externalEvidence.js";
import { evidenceHash, stableJSON } from "./store.js";

type Manifest = Record<string, string | null>;
export interface AssessmentReceipt { sessionId: string; routeBinding: string; planRevision: number; inputSequence: number; raw: AgentResult; accepted?: AgentResult; consumedAt?: number; resolutionActionId?: string }
const binding = (topic: Topic) => stableJSON([topic.scopeGeneration, topic.planEpoch, topic.planSHA256]);
export class EvidenceAutomationStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS evidence_auto_baselines(topic_id TEXT PRIMARY KEY,binding TEXT NOT NULL,manifest TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_auto_jobs(id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,record TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS evidence_assessment_receipts(id TEXT PRIMARY KEY,record TEXT NOT NULL);`);
  }
  jobs(topicId: string): EvidenceAssessment[] {
    return this.db.prepare("SELECT record FROM evidence_auto_jobs WHERE topic_id=? ORDER BY rowid DESC").all(topicId).map(row => JSON.parse(String(row.record)));
  }
  receipt(id: string): AssessmentReceipt | null {
    const row = this.db.prepare("SELECT record FROM evidence_assessment_receipts WHERE id=?").get(id);
    return row ? JSON.parse(String(row.record)) : null;
  }
  saveReceipt(id: string, receipt: AssessmentReceipt): void {
    this.db.prepare("INSERT INTO evidence_assessment_receipts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record")
      .run(id, JSON.stringify(receipt));
  }
  private inputSequence(topic: Topic): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(sequence),0) AS sequence FROM timeline_events WHERE topic_id=? AND scope_generation=? AND actor='user' AND kind IN ('decision','evidence')")
      .get(topic.id, topic.scopeGeneration);
    return Number(row?.sequence ?? 0);
  }
  current(topic: Topic, digest: string): EvidenceAssessment | null {
    const inputSequence = this.inputSequence(topic), currentBinding = binding(topic);
    return this.jobs(topic.id).find(job => job.binding === currentBinding && job.digest === digest && job.status === "complete" &&
      job.planRevision === topic.planRevision &&
      (this.receipt(job.id)?.inputSequence ?? 0) >= inputSequence &&
      (job.outcome === "no-impact" ? job.purpose === "plan-review" : Boolean(this.receipt(job.id)?.accepted))) ?? null;
  }
  private save(job: EvidenceAssessment): void {
    this.db.prepare("INSERT INTO evidence_auto_jobs VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET record=excluded.record").run(job.id, job.topicId, JSON.stringify(job));
  }
  private baseline(topic: Topic, manifest: Manifest): void {
    this.db.prepare("INSERT INTO evidence_auto_baselines VALUES (?,?,?) ON CONFLICT(topic_id) DO UPDATE SET binding=excluded.binding,manifest=excluded.manifest")
      .run(topic.id, binding(topic), stableJSON(manifest));
  }
  reviewPlan(topic: Topic, sources: EvidenceSource[], digest: string): EvidenceAssessment {
    const id = evidenceHash(stableJSON(["plan-review", topic.id, binding(topic), topic.planRevision, digest, this.inputSequence(topic)]));
    const existing = this.jobs(topic.id).find(job => job.id === id);
    if (existing) return existing;
    const job: EvidenceAssessment = { id, topicId: topic.id, binding: binding(topic), planRevision: topic.planRevision, digest, purpose: "plan-review",
      changes: [], target: Object.fromEntries(sources.map(source => [source.id, source.contentHash])), status: "pending", createdAt: Date.now() };
    this.save(job); return job;
  }
  retryPlanReview(topic: Topic, sources: EvidenceSource[], digest: string): void {
    this.recover(topic.id);
    const job = this.reviewPlan(topic, sources, digest);
    if (job.status === "failed" || (job.status === "complete" && job.outcome !== "no-impact" && !this.receipt(job.id)?.accepted)) this.save({ ...job, status: "pending", actionId: undefined, summary: undefined, finishedAt: undefined });
  }
  observe(topic: Topic, sources: EvidenceSource[], digest: string, retainMissing: readonly string[] = []): EvidenceAssessment | null {
    for (const job of this.jobs(topic.id).filter(job => job.status === "pending" && job.planRevision !== topic.planRevision))
      this.save({ ...job, status: "superseded" });
    const target = Object.fromEntries(sources.map(source => [source.id, source.contentHash]));
    const previous = this.db.prepare("SELECT binding,manifest FROM evidence_auto_baselines WHERE topic_id=?").get(topic.id);
    if (!previous || previous.binding !== binding(topic) || topic.state === "CLOSED" || !topic.planSHA256) {
      for (const job of this.jobs(topic.id).filter(job => job.status === "pending" &&
        (job.purpose !== "plan-review" || job.binding !== binding(topic)))) this.save({ ...job, status: "superseded" });
      this.baseline(topic, target); return null;
    }
    const before: Manifest = JSON.parse(String(previous.manifest));
    // A paginated rediscovery can temporarily hide old links. Preserve only those
    // sources; an unrelated unavailable root must not block every other change.
    for (const id of retainMissing) if (!(id in target) && before[id]) target[id] = before[id];
    // First complete observations establish a baseline; they are not edits to a previously observed source.
    for (const [id, hash] of Object.entries(target)) if (!before[id]) before[id] = hash;
    this.baseline(topic, before);
    const changes = Object.keys(before).filter(id => before[id] && before[id] !== (target[id] ?? null))
      .map(sourceId => ({ sourceId, before: before[sourceId]!, after: target[sourceId] ?? null }));
    const id = evidenceHash(stableJSON([topic.id, binding(topic), topic.planRevision, before, target]));
    for (const old of this.jobs(topic.id).filter(job => job.status === "pending" && job.id !== id && job.purpose !== "plan-review")) this.save({ ...old, status: "superseded" });
    if (!changes.length) return null;
    const existing = this.jobs(topic.id).find(job => job.id === id);
    if (existing) {
      if (existing.status === "complete") this.baseline(topic, target);
      if (existing.status === "pending" || (existing.status === "superseded" && !existing.actionId)) { const refreshed: EvidenceAssessment = { ...existing, status: "pending", digest }; this.save(refreshed); return refreshed; }
      return null;
    }
    const job: EvidenceAssessment = { id, topicId: topic.id, binding: binding(topic), planRevision: topic.planRevision, digest, changes, target, status: "pending", createdAt: Date.now() };
    this.save(job); return job;
  }
  start(job: EvidenceAssessment, actionId: string): boolean {
    const current = this.jobs(job.topicId).find(item => item.id === job.id);
    if (current?.status !== "pending") return false;
    this.save({ ...current, status: "running", actionId }); return true;
  }
  finish(job: EvidenceAssessment, topic: Topic, digest: string, outcome: EvidenceAssessment["outcome"], summary: string): boolean {
    const current = this.jobs(job.topicId).find(item => item.id === job.id);
    if (current?.status !== "running") return false;
    if (binding(topic) !== job.binding || job.planRevision !== topic.planRevision || digest !== job.digest) {
      this.save({ ...current, status: "superseded", summary: "검토 중 계획이나 원문이 바뀌었습니다." }); return false;
    }
    this.save({ ...current, status: "complete", outcome, summary, finishedAt: Date.now() });
    this.baseline(topic, job.target); return true;
  }
  failed(job: EvidenceAssessment, message: string): void {
    const current = this.jobs(job.topicId).find(item => item.id === job.id);
    if (current) this.save({ ...current, status: "failed", summary: message.slice(0, 2000), finishedAt: Date.now() });
  }
  recover(topicId: string): void {
    for (const job of this.jobs(topicId).filter(job => job.status === "running")) {
      if (!job.actionId || !this.db.prepare("SELECT 1 FROM actions WHERE id=? AND status='running'").get(job.actionId)) this.failed(job, "서버 중단 뒤 자동 검토 완료를 확인하지 못했습니다. 같은 검토를 자동 중복 실행하지 않았습니다.");
    }
  }
}
