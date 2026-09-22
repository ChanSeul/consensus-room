import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MediatorEvidenceInputSchema, MediatorEvidenceAckSchema, EvidenceDependencySchema, EvidenceReviewInputSchema, EvidenceSnapshotInputSchema, EvidenceSourceInputSchema } from "../../shared/externalEvidence.js";
import type { ConsensusDatabase } from "../database.js";
import type { WorkflowEngine } from "../workflow.js";
import type { EvidenceService } from "./service.js";

export function registerEvidenceRoutes(app: FastifyInstance, db: ConsensusDatabase, workflow: WorkflowEngine, service: EvidenceService,
  authorizeReview: (headers: Record<string, unknown>) => void): void {
  const mediator = (headers: Record<string, unknown>) => {
    if (headers["x-consensus-actor"] !== "mediator") throw Object.assign(new Error("중재자 세션에서 호출하세요."), { statusCode: 403 });
  };
  app.get("/api/evidence/connections", async () => db.evidence.list().map(source => ({
    id: source.id, provider: source.provider, mode: source.mode, ...service.connection(source),
    topics: db.evidence.linkedTopics(source.id), metrics: db.evidence.metrics(source.id),
  })));
  app.post<{ Params: { id: string } }>("/api/evidence/:id/use-rest", async request => {
    authorizeReview(request.headers);
    z.object({}).strict().parse(request.body);
    const source = db.evidence.get(request.params.id);
    for (const topicId of db.evidence.linkedTopics(source.id)) workflow.assertBudgetEditable(topicId);
    if (!db.evidence.activeSources().some(item => item.id === source.id)) throw new Error("열린 주제에 연결된 원문만 전환할 수 있습니다.");
    if (!service.connection(source).configured) throw new Error("서버의 읽기 인증 설정이 필요합니다.");
    return db.evidence.useRest(source.id);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/mediator/batch", async request => {
    mediator(request.headers);
    const input = MediatorEvidenceInputSchema.parse(request.body);
    return service.prepareMediator(db, request.params.id, input.sessionId);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/mediator/ack", async request => {
    mediator(request.headers);
    const input = MediatorEvidenceAckSchema.parse(request.body);
    db.evidence.acknowledgeMediator(db.getTopic(request.params.id), input.sessionId, input.batchId);
    return { ok: true };
  });
  app.get<{ Params: { id: string } }>("/api/topics/:id/evidence/metrics", async request => {
    db.getTopic(request.params.id);
    return { mediator: db.evidence.metrics(`mediator:${request.params.id}`), runner: db.evidence.metrics(`runner:${request.params.id}`) };
  });
  app.get<{ Params: { id: string } }>("/api/topics/:id/evidence", async request => {
    const state = db.evidence.topic(db.getTopic(request.params.id));
    return { ...state, connections: state.sources.map(source => ({ sourceId: source.id, configured: service.connection(source).configured,
      sharedTopics: db.evidence.linkedTopics(source.id).length })) };
  });
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
