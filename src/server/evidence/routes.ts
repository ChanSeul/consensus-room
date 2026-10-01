import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { MediatorEvidenceBatchInputSchema, MediatorEvidenceAckSchema, EvidenceDependencySchema, EvidenceReviewInputSchema, EvidenceSnapshotInputSchema, EvidenceSourceInputSchema,
  parseEvidenceSource, EvidenceRootInputSchema, EvidenceSelectionInputSchema, EvidenceSearchInputSchema, EvidenceHostImportSchema } from "../../shared/externalEvidence.js";
import type { ConsensusDatabase } from "../database.js";
import type { WorkflowEngine } from "../workflow.js";
import type { EvidenceService } from "./service.js";
import { assertMediatorForAnyTopic } from "../mediation.js";

export function registerEvidenceRoutes(app: FastifyInstance, db: ConsensusDatabase, workflow: WorkflowEngine, service: EvidenceService,
  authorizeReview: (headers: Record<string, unknown>) => void): void {
  const mediator = (headers: Record<string, unknown>) => {
    if (headers["x-consensus-actor"] !== "mediator") throw Object.assign(new Error("중재자 세션에서 호출하세요."), { statusCode: 403 });
  };
  const user = (headers: Record<string, unknown>) => {
    if (headers["x-consensus-actor"] === "mediator") throw Object.assign(new Error("근거 선택 승인은 사용자만 할 수 있습니다."), { statusCode: 403 });
  };
  const idle = (ids: string[]) => { for (const id of ids) workflow.assertBudgetEditable(id); };
  const notifySelection = (ids: string[]) => {
    for (const id of new Set(ids)) {
      const topic = db.getTopic(id); if (topic.state === "CLOSED" || db.getFlags(id).committedOID) continue;
      db.appendEvent({topicId:id,actor:"user",kind:"note",state:topic.state,
        body:"앞으로 사용할 근거 목록이 바뀌었습니다. 이전 계획과 인용은 과거 기록이며, 현재 승인된 근거로 다시 계획하고 확인하세요. 에이전트 세션도 새로 시작합니다.",
        payload:{evidenceCatalogVersion:db.evidence.catalog.version(id),planEpoch:topic.planEpoch}});
    }
  };
  app.get<{ Params: { id: string } }>("/api/topics/:id/evidence/catalog", async request => db.evidence.catalog.state(request.params.id));
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/group", async request => {
    user(request.headers);
    const input=z.object({version:z.string().regex(/^[a-f0-9]{64}$/),groupId:z.string().uuid().nullable()}).strict().parse(request.body);
    db.evidence.catalog.assertGroup(request.params.id,input);
    if (db.evidence.catalog.context(request.params.id).group === input.groupId) return db.evidence.catalog.state(request.params.id);
    await workflow.changeEvidenceSelection([request.params.id],()=>db.evidence.catalog.selectGroup(request.params.id,input));
    notifySelection([request.params.id]);
    db.appendEvent({topicId:request.params.id,actor:"user",kind:"note",state:db.getTopic(request.params.id).state,
      body:input.groupId ? "등록된 작업 그룹의 근거를 이 주제에 연결했습니다." : "이 주제의 근거 묶음 연결을 해제했습니다.",payload:{evidenceGroupId:input.groupId}});
    return db.evidence.catalog.state(request.params.id);
  });
  app.get<{ Params: { id: string } }>("/api/topics/:id/evidence/host-plan", async request => {
    const input = z.object({ cursor: z.string().regex(/^[a-f0-9]{64}$/).optional(),
      limit: z.coerce.number().int().min(1).max(50).default(50) }).strict().parse(request.query);
    return service.hostPlan(request.params.id, input.cursor, input.limit);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/host-import", {bodyLimit:16_000_000}, async request => {
    mediator(request.headers);
    const input=EvidenceHostImportSchema.parse(request.body);
    const root=db.evidence.catalog.forTopic(request.params.id).find(r=>r.id===input.rootId);
    if (!root) throw Object.assign(new Error("이 작업에 연결된 루트가 아닙니다."),{statusCode:409});
    await workflow.publishEvidence(() => {
      const guarded = [...new Set([...db.evidence.catalog.affected(root),...db.evidence.linkedTopics(root.sourceId),...db.evidence.linkedTopics(input.sourceId)])];
      assertMediatorForAnyTopic(db.roles,request.headers,guarded.filter(id=>db.getTopic(id).state!=="CLOSED"));
      return guarded;
    },()=>service.importHost(request.params.id,input), ids => {
      assertMediatorForAnyTopic(db.roles,request.headers,ids.filter(id=>db.getTopic(id).state!=="CLOSED"));
    });
    return db.evidence.catalog.state(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/roots", async request => {
    const input = EvidenceRootInputSchema.parse(request.body), context = db.evidence.catalog.context(request.params.id);
    const scope = input.scope === "group" && !context.group ? "topic" : input.scope;
    // A newly registered root is outside an explicitly scoped stage until its group revision selects it.
    const baseAffected = () => db.listTopics().filter(t => {
      const target = db.evidence.catalog.context(t.id);
      return target[scope] === context[scope] && target.evidenceRootIds === undefined;
    }).map(t => t.id);
    const approved = request.headers["x-consensus-actor"] !== "mediator";
    if (scope === "workspace") user(request.headers);
    const parsed = parseEvidenceSource(input);
    if (scope === "workspace" && parsed.provider === "jira") throw new Error("Jira 루트는 작업 그룹별로 지정하세요.");
    const source = db.evidence.ensureSource({url:input.url,label:input.label,mode:input.mode,intervalSeconds:input.intervalSeconds},true);
    const existing = db.evidence.catalog.forTopic(request.params.id).find(root => root.scope === scope && root.sourceId === source.id && root.status !== "removed");
    if (existing) return existing;
    const affected = () => [...baseAffected(),...db.evidence.catalog.approvalAffected(source.id, scope, context[scope]!)];
    if (approved) { const changed = affected(); const result = await workflow.changeEvidenceSelection(affected,()=>db.evidence.catalog.add(request.params.id,input,true)); notifySelection(changed); return result; }
    idle(baseAffected()); return db.evidence.catalog.add(request.params.id,input,false);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/selection", async request => {
    user(request.headers);
    const input = EvidenceSelectionInputSchema.parse(request.body);
    const root = db.evidence.catalog.assertSelection(request.params.id,input);
    const affected = () => [...db.evidence.catalog.affected(root),...(input.action === "approve" || input.action === "accept"
      ? db.evidence.catalog.approvalAffected(input.action === "approve" ? root.sourceId : input.sourceId!, root.scope, root.owner) : [])];
    const ids = affected();
    await workflow.changeEvidenceSelection(affected,()=>db.evidence.catalog.select(request.params.id,input));
    notifySelection(ids);
    return db.evidence.catalog.state(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/selection-batch", async request => {
    user(request.headers);
    const input = z.object({ version:z.string(),rootId:z.string().uuid(),action:z.enum(["accept","reject"]),sourceIds:z.array(z.string()).min(1).max(200) }).strict().parse(request.body);
    const root = db.evidence.catalog.assertSelection(request.params.id,{...input,sourceId:input.sourceIds[0]});
    for (const sourceId of input.sourceIds) db.evidence.catalog.assertSelection(request.params.id,{...input,sourceId});
    const affected = () => [...db.evidence.catalog.affected(root),...(input.action === "accept"
      ? input.sourceIds.flatMap(id => db.evidence.catalog.approvalAffected(id, root.scope, root.owner)) : [])];
    const ids = affected();
    await workflow.changeEvidenceSelection(affected,()=>db.evidence.catalog.selectBatch(request.params.id,input));
    notifySelection(ids);
    return db.evidence.catalog.state(request.params.id);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/collect", async request => {
    z.object({}).strict().parse(request.body ?? {});
    for (const root of db.evidence.catalog.forTopic(request.params.id).filter(r => r.status === "approved")) await service.collect(root.id);
    return { ...db.evidence.catalog.state(request.params.id), hostPlan: service.hostPlan(request.params.id) };
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/search", async request => {
    const input = EvidenceSearchInputSchema.parse(request.body);
    const terms = input.query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const hits = db.evidence.list(request.params.id).flatMap(source => (db.evidence.sourceSnapshot(source)?.units ?? []).flatMap(unit => {
      const haystack = `${source.label}\n${unit.id}\n${unit.content}`.toLocaleLowerCase();
      const positions = terms.map(term => haystack.indexOf(term)).filter(i => i >= 0);
      const bodyPositions=terms.map(term=>unit.content.toLocaleLowerCase().indexOf(term)).filter(i=>i>=0);
      const start=bodyPositions.length ? Math.max(0,Math.min(...bodyPositions)-120) : 0;
      return positions.length ? [{ sourceId: source.id, unitId: unit.id, hash: unit.contentHash, url: source.url, label: source.label,
        excerpt: unit.content.slice(start,start+800), score: positions.length }] : [];
    })).sort((a,b) => b.score - a.score || a.sourceId.localeCompare(b.sourceId) || a.unitId.localeCompare(b.unitId));
    return { total: hits.length, hits: hits.slice(input.offset, input.offset + input.limit), nextOffset: input.offset + input.limit < hits.length ? input.offset + input.limit : null };
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/read", async request => {
    const input = z.object({ sourceId: z.string(), unitId: z.string(), hash: z.string(), offset: z.number().int().nonnegative().default(0),
      limit: z.number().int().min(1).max(16000).default(8000) }).strict().parse(request.body);
    const source = db.evidence.list(request.params.id).find(s => s.id === input.sourceId);
    if (!source) throw new Error("현재 승인된 근거가 아닙니다.");
    const unit = db.evidence.sourceSnapshot(source)?.units.find(u => u.id === input.unitId && u.contentHash === input.hash);
    if (!unit) throw new Error("원문 버전이 바뀌었습니다. 다시 검색하세요.");
    const points = Array.from(unit.content), end = Math.min(points.length, input.offset + input.limit);
    return { ...unit, content: points.slice(input.offset, end).join(""), nextOffset: end < points.length ? end : null };
  });
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
    if (!service.connection({ ...source, mode: "rest" }).configured) throw new Error("서버의 읽기 인증 설정이 필요합니다.");
    return db.evidence.useRest(source.id);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/mediator/batch", async request => {
    mediator(request.headers);
    const input = MediatorEvidenceBatchInputSchema.parse(request.body);
    return service.prepareMediator(db, request.params.id, input.sessionId, input.pageBytes);
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
    const collectionMetrics = { ...db.evidence.metrics(`assessment:${request.params.id}`) };
    for (const source of state.sources) for (const [name, value] of Object.entries(db.evidence.metrics(source.id))) collectionMetrics[name] = (collectionMetrics[name] ?? 0) + value;
    return { ...state, assessments: db.evidence.automation.jobs(request.params.id).filter(job => job.status !== "superseded" && job.binding === JSON.stringify([state.plan.scopeGeneration, state.plan.planEpoch, state.plan.planSHA256])).slice(0, 20), collectionMetrics, connections: state.sources.map(source => ({ sourceId: source.id, configured: service.connection(source).configured,
      sharedTopics: db.evidence.linkedTopics(source.id).length })) };
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/sources", async request => {
    const topic = db.getTopic(request.params.id);
    workflow.assertBudgetEditable(topic.id);
    const input = EvidenceSourceInputSchema.parse(request.body);
    // Compatibility for explicit user-provided single-source snapshots; recursive roots use /roots.
    if (request.headers["x-consensus-actor"] !== "mediator") return db.evidence.register(topic.id, input);
    const root = db.evidence.catalog.add(topic.id, { ...input, scope: "topic", required: true }, false);
    return db.evidence.get(root.sourceId);
  });
  app.post<{ Params: { id: string } }>("/api/topics/:id/evidence/review", async request => {
    authorizeReview(request.headers); workflow.assertBudgetEditable(request.params.id);
    const input = EvidenceReviewInputSchema.parse(request.body);
    const topic = db.getTopic(request.params.id);
    if (topic.state === "CLOSED" && !(db.getFlags(topic.id).committedOID && db.evidence.isFrozen(topic)))
      throw new Error("확정 커밋이 있는 닫힌 단계의 보존된 근거만 재검토할 수 있습니다.");
    db.evidence.review(topic, input.digest, input.reason, input.plan);
    db.appendEvent({ topicId: topic.id, actor: "user", kind: "note", state: topic.state,
      body: `외부 원문 변경 영향 확인: ${input.reason}`, payload: { evidenceDigest: input.digest, planSHA256: topic.planSHA256 } });
    return db.evidence.topic(topic);
  });
  app.delete<{ Params: { id: string; sourceId: string } }>("/api/topics/:id/evidence/sources/:sourceId", async request => {
    user(request.headers); workflow.assertBudgetEditable(request.params.id);
    const topic = db.getTopic(request.params.id);
    const roots = db.evidence.catalog.forTopic(topic.id).filter(r => r.sourceId === request.params.sourceId && r.status !== "removed");
    for (const root of roots) {
      await workflow.changeEvidenceSelection(db.evidence.catalog.affected(root),()=>db.evidence.catalog.select(topic.id, { version: db.evidence.catalog.version(topic.id), rootId: root.id, action: "remove" }));
      notifySelection(db.evidence.catalog.affected(root));
    }
    db.evidence.detach(topic.id, request.params.sourceId);
    return db.evidence.topic(topic);
  });
  app.get("/api/evidence/due", async () => db.evidence.activeSources().filter(source => source.mode === "connector" && source.nextCheckAt <= Date.now()));
  app.post<{ Params: { id: string } }>("/api/evidence/:id/check", async request => {
    const input = z.object({ force: z.boolean().default(false) }).strict().parse(request.body ?? {});
    const source = db.evidence.get(request.params.id);
    const roots = db.evidence.catalog.roots().filter(r => r.status === "approved" && db.evidence.catalog.members(r.id).some(m => m.source_id === source.id && m.state === "approved"));
    if (roots.length) { for (const root of roots) await service.collect(root.id,input.force); return { source: db.evidence.get(source.id), checkId: null }; }
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
