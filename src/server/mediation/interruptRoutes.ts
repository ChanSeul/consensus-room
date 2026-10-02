import { z } from "zod";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ConsensusDatabase } from "../database.js";
import { assertMediatorAssignment } from "../mediation.js";
import { MediatorSessionSchema, type MediatorSession } from "../../shared/mediatorInterrupts.js";
import { redactSecrets } from "../../shared/workflow.js";

export function interruptTarget(db: ConsensusDatabase, topicId: string): { key: string; session: MediatorSession } | null {
  const assignment = db.roles.effective(topicId, "mediator");
  const profile = assignment?.profileId ? db.roles.profile(assignment.profileId) : null;
  if (!assignment?.sessionId || !profile) return null;
  return { key: JSON.stringify([assignment.scope, assignment.participant, assignment.version, profile.provider, assignment.sessionId]),
    session: { provider: profile.provider, sessionId: assignment.sessionId } };
}
export function interruptStatus(db: ConsensusDatabase, topicId: string) {
  return db.interrupts.status(topicId, interruptTarget(db, topicId)?.key ?? null);
}
export function registerInterruptRoutes(app: FastifyInstance, db: ConsensusDatabase): void {
  const authorized = (request: FastifyRequest, topicId: string, session: MediatorSession): string => {
    if (request.headers["x-consensus-actor"] !== "mediator") throw Object.assign(new Error("현재 중재 세션에서 호출하세요."), { statusCode: 403 });
    const identity = assertMediatorAssignment(db.roles, request.headers, topicId), target = interruptTarget(db, topicId);
    if (!identity || !target || target.session.sessionId !== session.sessionId || target.session.provider !== session.provider)
      throw Object.assign(new Error("현재 중재자 profileId·sessionId와 수신 세션이 일치해야 합니다."), { statusCode: 409, errorCode: "MEDIATOR_SESSION_MISMATCH" });
    return target.key;
  };
  const wakeups = new Set<() => void>();
  app.addHook("preClose", async () => { for (const wake of wakeups) wake(); });
  app.get<{ Params: { id: string } }>("/api/topics/:id/interrupts", async (request, reply) => {
    const input = MediatorSessionSchema.extend({ waitMs: z.coerce.number().int().min(0).max(25000).default(0), descendants: z.enum(["true", "false"]).default("true") }).parse(request.query);
    authorized(request, request.params.id, input);
    const pending = () => {
      authorized(request, request.params.id, input); // Re-check assignment after a long wait.
      const ids = new Set([request.params.id]);
      if (input.descendants === "true") {
        const topics = db.listTopics(); let changed = true;
        while (changed) { changed = false; for (const topic of topics) if (topic.parentTopicId && ids.has(topic.parentTopicId) && !ids.has(topic.id)) { ids.add(topic.id); changed = true; } }
      }
      return [...ids].flatMap(id => {
        try { const target = authorized(request, id, input), item = db.interrupts.pending(id, target); return item ? [item] : []; }
        catch { return []; } // A subtree may belong to another mediator; never send its content to this session.
      });
    };
    let items = pending();
    if (!items.length && input.waitMs) {
      await new Promise<void>(resolve => {
        const wake = () => { clearTimeout(timer); db.events.off("mediation-change", wake); reply.raw.off("close", wake); wakeups.delete(wake); resolve(); };
        const timer = setTimeout(wake, input.waitMs); timer.unref();
        wakeups.add(wake); db.events.once("mediation-change", wake); reply.raw.once("close", wake);
      });
      items = pending();
    }
    return { items };
  });
  const path = "/api/topics/:id/interrupts/:interruptId";
  app.post<{ Params: { id: string; interruptId: string } }>(`${path}/claim`, async request => {
    const session = MediatorSessionSchema.parse(request.body), target = authorized(request, request.params.id, session);
    return db.interrupts.claim(request.params.id, request.params.interruptId, target);
  });
  app.post<{ Params: { id: string; interruptId: string } }>(`${path}/receipt`, async request => {
    const input = MediatorSessionSchema.extend({ claim: z.string().uuid(), state: z.enum(["sent", "acknowledged", "failed", "unknown"]), error: z.string().max(1000).optional() }).parse(request.body);
    const target = authorized(request, request.params.id, input);
    db.interrupts.receipt(request.params.id, request.params.interruptId, target, input.claim, input.state, input.error ? redactSecrets(input.error) : null);
    return { status: interruptStatus(db, request.params.id) };
  });
  app.post<{ Params: { id: string; interruptId: string } }>(`${path}/retry`, async request => {
    if (request.headers["x-consensus-actor"] === "mediator") throw Object.assign(new Error("응답 미확인 재전송은 실제 수신 상태를 확인한 사용자가 요청하세요."), { statusCode: 403 });
    const { reason } = z.object({ reason: z.string().trim().min(1).max(1000) }).strict().parse(request.body);
    const target = interruptTarget(db, request.params.id); if (!target) throw new Error("중재 세션이 배정되지 않았습니다.");
    db.interrupts.retry(request.params.id, request.params.interruptId, target.key);
    db.appendEvent({ topicId: request.params.id, actor: "user", kind: "note", state: db.getTopic(request.params.id).state,
      body: `중재 인터럽트 재전송 요청: ${redactSecrets(reason)}`, payload: { interruptRetry: request.params.interruptId } });
    return { status: interruptStatus(db, request.params.id) };
  });
}
