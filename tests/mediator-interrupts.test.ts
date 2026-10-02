import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { loadConfig } from "../src/server/config";
import { buildApp } from "../src/server/app";
import { DEFAULT_AGENT_SETTINGS, type WorkflowState } from "../src/shared/contracts";
import { interruptTarget } from "../src/server/mediation/interruptRoutes";
import { deliverCodexInterrupt, type CodexRPC } from "../src/server/mediation/codexInterrupt";
import { claudeChannelNotification } from "../src/server/mediation/interruptBridge";
import type { MediatorInterrupt } from "../src/shared/mediatorInterrupts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const item: MediatorInterrupt = { id: "notice-id", topicId: "topic-1", title: "제품 구현", state: "USER_DECISION_REQUIRED", reason: "범위 확인", sourceRole: "planner", sequence: 4, createdAt: new Date().toISOString() };
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "room-interrupt-"));
  const path = join(root, "db.sqlite");
  let db = new ConsensusDatabase(path);
  const topic = db.createTopic({ id: "topic-1", slug: "topic", title: "중재 호출", baseRef: "HEAD", repositoryPath: root, worktreePath: root,
    state: "DRAFT", branchName: null, scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  db.roles.createProfile({ id: "mediator-profile", provider: "codex", model: "test-model", effort: "medium", options: {} });
  const assign = (participant = "owner", sessionId = "mediator-session", version = 0) => db.roles.assign({ scope: "global", role: "mediator", operation: "", profileId: "mediator-profile", participant, sessionId, expectedVersion: version, note: "test" });
  assign();
  const config = loadConfig({ dataDirectory: root, repositoryPath: root, memoryDirectory: join(root, "memory"), databasePath: path, launchToken: "test", webDirectory: join(root, "no-web"), enforceBudgets: false, defaultAgentSettings: DEFAULT_AGENT_SETTINGS });
  const adapter = (role: "claude" | "codex") => ({ role, validateExistingSession: async () => true,
    createSession: async () => { throw new Error("No model expected"); }, resumeTurn: async () => { throw new Error("No model expected"); } });
  const build = () => buildApp({ config, database: db, claude: adapter("claude"), codex: adapter("codex"), runner: { run: async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] }) } });
  let app = await build();
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { "x-consensus-token": "test", "x-consensus-actor": "mediator", "x-consensus-mediator": "owner", "x-consensus-mediator-version": "1" };
  const session = { provider: "codex", sessionId: "mediator-session" };
  const get = (extra: Record<string, string> = {}) => app.inject({ url: "/api/topics/topic-1/interrupts?provider=codex&sessionId=mediator-session", headers: { ...headers, ...extra } });
  const post = (id: string, action: string, body: Record<string, unknown> = {}, extra: Record<string, string> = {}) => app.inject({ method: "POST", url: `/api/topics/topic-1/interrupts/${id}/${action}`, headers: { ...headers, ...extra }, payload: { ...session, ...body } });
  const pause = (stage: WorkflowState = "CLAUDE_PLAN", state: WorkflowState = "USER_DECISION_REQUIRED") => db.applyTopicTransition({ topicId: topic.id,
    changes: { state, resumeState: stage, lastError: "사용자 범위 확인" }, events: [{ actor: "system", kind: "system", state, body: "사용자 범위 확인", payload: { resumeState: stage } }] });
  const restart = async () => { await app.close(); db = new ConsensusDatabase(path); app = await build(); };
  return { get db() { return db; }, get app() { return app; }, topic, headers, session, get, post, pause, assign, restart };
}

it.each([["CLAUDE_PLAN", "planner"], ["IMPLEMENTING", "runner"], ["CODEX_REVIEW", "reviewer"]] as const)("%s interruption persists once and is not re-sent after receipt", async (stage, role) => {
  const f = await fixture(); f.pause(stage);
  const items = (await f.get()).json().items;
  expect(items).toHaveLength(1); expect(items[0].sourceRole).toBe(role);
  f.db.appendEvent({ topicId: "topic-1", actor: "system", kind: "system", state: "USER_DECISION_REQUIRED", body: "동일 정지의 사용량 저장" });
  expect((await f.get()).json().items.map((i: MediatorInterrupt) => i.id)).toEqual([items[0].id]);
  await f.restart();
  const claim = await f.post(items[0].id, "claim"); expect(claim.statusCode).toBe(200);
  expect((await f.post(items[0].id, "claim")).statusCode).toBe(409);
  const sent = await f.post(items[0].id, "receipt", { claim: claim.json().claim, state: "sent" }); expect(sent.statusCode).toBe(200);
  expect((await f.get()).json().items).toEqual([]);
  expect((await f.app.inject({ url: "/api/topics/topic-1/activity", headers: f.headers })).json().mediationInterrupt.state).toBe("sent");
  f.db.updateTopic("topic-1", { state: "IMPLEMENTING" });
  expect(f.db.interrupts.current("topic-1")).toBeNull(); // No stale notification even before the transition event.
  f.pause(stage); expect((await f.get()).json().items[0].id).not.toBe(items[0].id);
});

it("reassignment routes an unresolved request to the new mediator and rejects the old session receipt", async () => {
  const f = await fixture(); f.pause();
  const item = (await f.get()).json().items[0]; const claim = (await f.post(item.id, "claim")).json().claim;
  const next = f.assign("next-owner", "next-session", 1);
  expect((await f.get()).statusCode).toBe(409);
  expect((await f.post(item.id, "receipt", { claim, state: "sent" })).statusCode).toBe(409);
  const received = await f.app.inject({ url: "/api/topics/topic-1/interrupts?provider=codex&sessionId=next-session",
    headers: { ...f.headers, "x-consensus-mediator": "next-owner", "x-consensus-mediator-version": String(next.version) } });
  expect(received.statusCode).toBe(200); expect(received.json().items[0].id).toBe(item.id);
});

it("uncertain delivery is visible and needs an explicit retry instead of duplicating model calls", async () => {
  const f = await fixture(); f.pause();
  const item = (await f.get()).json().items[0], claim = (await f.post(item.id, "claim")).json().claim;
  expect((await f.post(item.id, "receipt", { claim, state: "unknown", error: "연결 종료" })).statusCode).toBe(200);
  expect((await f.get()).json().items).toEqual([]);
  expect(f.db.interrupts.status("topic-1", interruptTarget(f.db, "topic-1")!.key)?.state).toBe("unknown");
  expect((await f.post(item.id, "retry", { reason: "확인" })).statusCode).toBe(403);
  const result = await f.app.inject({ method: "POST", url: `/api/topics/topic-1/interrupts/${item.id}/retry`, headers: { "x-consensus-token": "test" }, payload: { reason: "실제 세션에 미수신한 것을 확인" } });
  expect(result.statusCode).toBe(200); expect((await f.get()).json().items).toHaveLength(1);
});

it("rejects unauthenticated and incorrectly bound receiver sessions", async () => {
  const f = await fixture(); f.pause();
  expect((await f.get({ "x-consensus-token": "wrong" })).statusCode).toBe(401);
  expect((await f.get({ "x-consensus-actor": "user" })).statusCode).toBe(403);
  expect((await f.app.inject({ url: "/api/topics/topic-1/interrupts?provider=codex&sessionId=other-session", headers: f.headers })).statusCode).toBe(409);
});

it.each(["active", "idle"])("Codex %s mediator is steered or woken in the same session without cancellation or configuration overrides", async state => {
  const rpc = vi.fn(async (method: string) => {
    if (method === "thread/read") return { thread: { id: "mediator-session", status: { type: state } } };
    if (method === "thread/turns/list") return { data: [{ id: "active-turn", status: "inProgress" }] };
    return {};
  });
  await deliverCodexInterrupt(rpc as CodexRPC, "mediator-session", item);
  expect(rpc).toHaveBeenLastCalledWith(state === "active" ? "turn/steer" : "turn/start", {
    threadId: "mediator-session", input: [{ type: "text", text: expect.stringContaining("notice-id") }], clientUserMessageId: "notice-id",
    ...(state === "active" ? { expectedTurnId: "active-turn" } : {}),
  });
  expect(rpc.mock.calls.map(call => call[0])).not.toContain("turn/interrupt");
});

it("Claude channel sends one current event with role and topic routing metadata", () => {
  const event = claudeChannelNotification(item);
  expect(event.method).toBe("notifications/claude/channel");
  expect(event.params.meta).toEqual({ interrupt_id: item.id, topic_id: item.topicId, source_role: "planner" });
  expect(event.params.content).toContain(`/api/topics/${item.topicId}/resume`);
});

it("wakes a connected mediator on a new pause without waiting for the poll timeout", async () => {
  const f = await fixture();
  const response = f.app.inject({ url: "/api/topics/topic-1/interrupts?provider=codex&sessionId=mediator-session&waitMs=25000", headers: f.headers }).then(value => value);
  await vi.waitFor(() => expect(f.db.events.listenerCount("mediation-change")).toBeGreaterThan(0));
  const emit = vi.spyOn(f.db.events, "emit");
  f.db.appendEvent({ topicId: "topic-1", actor: "system", kind: "system", state: "DRAFT", body: "일반 진행 기록" });
  expect(emit.mock.calls.some(call => call[0] === "mediation-change")).toBe(false);
  f.pause("IMPLEMENTING");
  expect((await response).json().items[0].sourceRole).toBe("runner");
  expect(f.db.events.listenerCount("mediation-change")).toBe(0);
});

it("a lost sender receipt expires to unknown and an early Claude acknowledgement is never downgraded", async () => {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await fixture(); f.pause();
  const id = (await f.get()).json().items[0].id, claim = (await f.post(id, "claim")).json().claim;
  now += 30_001;
  expect((await f.get()).json().items).toEqual([]);
  expect(f.db.interrupts.status("topic-1", interruptTarget(f.db, "topic-1")!.key)?.state).toBe("unknown");
  expect((await f.post(id, "receipt", { claim, state: "acknowledged" })).statusCode).toBe(200);
  expect((await f.post(id, "receipt", { claim, state: "sent" })).statusCode).toBe(200);
  expect(f.db.interrupts.status("topic-1", interruptTarget(f.db, "topic-1")!.key)?.state).toBe("acknowledged");
});
