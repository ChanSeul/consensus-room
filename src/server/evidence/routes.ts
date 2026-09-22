import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { EvidenceDependencySchema, EvidenceReviewInputSchema, EvidenceSnapshotInputSchema, EvidenceSourceInputSchema } from "../../shared/externalEvidence.js";
import type { ConsensusDatabase } from "../database.js";
import type { WorkflowEngine } from "../workflow.js";
import type { EvidenceService } from "./service.js";

export function registerEvidenceRoutes(app: FastifyInstance, db: ConsensusDatabase, workflow: WorkflowEngine, service: EvidenceService,
  authorizeReview: (headers: Record<string, unknown>) => void): void {
  app.get<{ Params: { id: string } }>("/api/topics/:id/evidence", async request => db.evidence.topic(db.getTopic(request.params.id)));
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/sources", async request => {
    const topic = db.getTopic(request.params.id);
    workflow.assertBudgetEditable(topic.id);
    if (topic.state === "CLOSED") throw new Error("닫힌 주제의 근거를 바꿀 수 없습니다.");
    return db.evidence.register(topic.id, EvidenceSourceInputSchema.parse(request.body));
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/review", async request => {
    authorizeReview(request.headers); workflow.assertBudgetEditable(request.params.id);
    const input = EvidenceReviewInputSchema.parse(request.body);
    const topic = db.getTopic(request.params.id);
    if (topic.state === "CLOSED") throw new Error("닫힌 주제는 검토할 수 없습니다.");
    db.evidence.review(topic, input.digest, input.reason, input.plan);
    db.appendEvent({ topicId: topic.id, actor: "user", kind: "note", state: topic.state,
      body: `외부 원문 변경 영향 확인: ${input.reason}`, payload: { evidenceDigest: input.digest, planSHA256: topic.planSHA256 } });
    return db.evidence.topic(topic);
  });
  app.delete<{ Params: { id: string; sourceId: string } }>("/api/topics/:id/evidence/sources/:sourceId", async request => {
    authorizeReview(request.headers); workflow.assertBudgetEditable(request.params.id);
    const topic = db.getTopic(request.params.id);
    if (topic.state === "CLOSED") throw new Error("닫힌 주제의 근거는 해제할 수 없습니다.");
    db.evidence.detach(topic.id, request.params.sourceId);
    return db.evidence.topic(topic);
  });
  app.get("/api/evidence/due", async () => db.evidence.activeSources().filter(source => source.mode === "connector" && source.nextCheckAt <= Date.now()));
  app.post<{ Params: { id: string } }>("/api/evidence/:id/check", async request => {
    const input = z.object({ force: z.boolean().default(false) }).strict().parse(request.body ?? {});
    const source = db.evidence.get(request.params.id);
    if (source.mode === "rest") { await service.refresh(source.id, input.force); return { source: db.evidence.get(source.id), checkId: null }; }
    return db.evidence.begin(source.id, input.force) ?? { source: db.evidence.get(source.id), checkId: null };
  });
  app.post<{ Params: { id: string } }>("/api/evidence/:id/snapshot", { bodyLimit: 16_000_000 }, async request =>
    service.ingest(request.params.id, EvidenceSnapshotInputSchema.parse(request.body)));
  app.post<{ Params: { id: string } }>("/api/evidence/:id/unchanged", async request => {
    const input = z.object({ checkId: z.string().uuid(), contentHash: z.string().regex(/^[a-f0-9]{64}$/), revision: z.string().max(300) }).strict().parse(request.body);
    return db.evidence.unchanged(request.params.id, input.checkId, input.contentHash, input.revision);
  });
  app.post<{ Params: { id: string } }>("/api/evidence/:id/failure", async request => {
    const input = z.object({ checkId: z.string().uuid(), error: z.string().max(500), retryAfterSeconds: z.number().int().min(300).max(86400).default(300) }).strict().parse(request.body);
    db.evidence.failed(request.params.id, input.checkId, input.error, input.retryAfterSeconds); return { ok: true };
  });
  app.get<{ Params: { id: string }; Querystring: { hash?: string } }>("/api/evidence/:id/snapshot", async request => {
    const query = z.object({ hash: z.string().regex(/^[a-f0-9]{64}$/).optional() }).parse(request.query);
    return db.evidence.snapshot(request.params.id, query.hash);
  });
  app.get<{ Params: { hash: string } }>("/api/evidence/images/:hash", async (request, reply) => {
    const hash = z.string().regex(/^[a-f0-9]{64}$/).parse(request.params.hash);
    return reply.header("cache-control", "private, max-age=31536000, immutable").type("image/png").send(db.evidence.image(hash));
  });
  app.post("/api/evidence/status", async request => {
    const input = z.object({ dependencies: z.array(EvidenceDependencySchema).max(200) }).strict().parse(request.body);
    return { status: db.evidence.status(input.dependencies) };
  });
}
