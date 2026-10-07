import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { loadConfig } from "../src/server/config";
import { buildApp, listenReady } from "../src/server/app";
import { DEFAULT_AGENT_SETTINGS, type WorkflowState } from "../src/shared/contracts";
import { interruptTarget } from "../src/server/mediation/interruptRoutes";
import { deliverCodexInterrupt, interruptMessage, resolveCodexTransport, sendCodexInterrupt, type CodexRPC } from "../src/server/mediation/codexInterrupt";
import { claudeChannelNotification } from "../src/server/mediation/interruptBridge";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { MediatorInterrupt } from "../src/shared/mediatorInterrupts";

vi.mock("node:child_process", async importOriginal => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
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

it("closed grouped stages retain a single mediator handoff across restart until a successor opens", async () => {
  const f = await fixture();
  f.db.workGroups.create("group", { title: "group", goal: "goal", contracts: "contract", stages: [
    { id: "a", kind: "work", title: "a", goal: "a", acceptance: "done", dependsOn: [] },
    { id: "b", kind: "work", title: "b", goal: "b", dependsOn: ["a"] },
    { id: "int", kind: "integration", title: "int", goal: "int", acceptance: "done", dependsOn: ["a", "b"] },
  ] }, f.topic.repositoryPath, "base");
  f.db.workGroups.link("group", "a", f.topic.id, "base");
  f.db.applyTopicTransition({ topicId: f.topic.id, changes: { state: "CLOSED" },
    events: [{ actor: "system", kind: "system", state: "CLOSED", body: "단계 완료" }] });
  const items = (await f.get()).json().items;
  expect(items).toHaveLength(1);
  expect(items[0].reason).toContain("작업 묶음 group");
  const groups = (await f.app.inject({ url: "/api/work-groups", headers: f.headers })).json();
  expect(groups[0].readyStages).toEqual([]);
  expect(groups[0].continuation.reason).toContain("완료 조건");
  const claim = (await f.post(items[0].id, "claim")).json().claim;
  await f.post(items[0].id, "receipt", { claim, state: "sent" });
  await f.restart();
  f.db.restoreMediatorInterrupts();
  expect(f.db.interrupts.current(f.topic.id)?.id).toBe(items[0].id);
  expect((await f.get()).json().items).toEqual([]);
  const next = f.db.createTopic({ ...f.topic, id: "next", slug: "next" });
  f.db.workGroups.link("group", "b", next.id, "base");
  expect(f.db.interrupts.current(f.topic.id)).toBeNull();
});

it("simultaneous stage timestamps still hand off from the last committed close transition", async () => {
  const f = await fixture();
  f.db.workGroups.create("group", { title: "group", goal: "goal", contracts: "contract", stages: [
    { id: "a", kind: "work", title: "a", goal: "a", acceptance: "done", dependsOn: [] },
    { id: "b", kind: "work", title: "b", goal: "b", acceptance: "done", dependsOn: [] },
    { id: "int", kind: "integration", title: "int", goal: "int", acceptance: "done", dependsOn: ["a", "b"] },
  ] }, f.topic.repositoryPath, "base");
  f.db.createTopic({ ...f.topic, id: "zz-older", slug: "older" });
  f.db.workGroups.link("group", "a", f.topic.id, "base");
  f.db.workGroups.link("group", "b", "zz-older", "base");
  vi.useFakeTimers({ toFake: ["Date"] });
  try {
    vi.setSystemTime(new Date("2026-10-04T00:00:00Z"));
    for (const topicId of ["zz-older", f.topic.id]) f.db.applyTopicTransition({ topicId, changes: { state: "CLOSED" },
      events: [{ actor: "system", kind: "system", state: "CLOSED", body: "완료", payload: { to: "CLOSED" } }] });
    expect(f.db.interrupts.current("zz-older")).toBeNull();
    expect(f.db.interrupts.current(f.topic.id)?.reason).toContain("작업 묶음 group");
  } finally { vi.useRealTimers(); }
});

it("restoration skips delivered legacy integrations with approval and review evidence", async () => {
  const f = await fixture();
  f.db.workGroups.create("legacy", { title: "legacy", goal: "goal", contracts: "contract", stages: [
    { id: "a", kind: "work", title: "a", goal: "a", acceptance: "done", dependsOn: [] },
    { id: "int", kind: "integration", title: "int", goal: "int", acceptance: "done", dependsOn: ["a"] },
  ] }, f.topic.repositoryPath, "base");
  f.db.workGroups.link("legacy", "a", f.topic.id, "base");
  f.db.updateTopic(f.topic.id, { state: "CLOSED" });
  const integration = f.db.createTopic({ ...f.topic, id: "integration", slug: "integration" });
  f.db.workGroups.link("legacy", "int", integration.id, "base");
  f.db.applyTopicTransition({ topicId: integration.id,
    changes: { state: "CLOSED", approvedPlanSHA256: "a".repeat(64), reviewedTreeOID: "b".repeat(40), committedOID: "c".repeat(40), pushedOID: "c".repeat(40) },
    events: [{ actor: "system", kind: "system", state: "CLOSED", body: "전달 완료", payload: { to: "CLOSED" } }] });
  await f.restart();
  f.db.restoreMediatorInterrupts();
  expect(f.db.interrupts.current(integration.id)).toBeNull();
  // Missing delivery proof must still request follow-up; do not normalize it to complete.
  f.db.updateTopic(integration.id, { pushedOID: null });
  f.db.restoreMediatorInterrupts();
  expect(f.db.interrupts.current(integration.id)?.reason).toContain("작업 묶음 legacy");
});

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
  expect((await f.post(item.id, "handling")).statusCode).toBe(200);
  const result = await f.app.inject({ method: "POST", url: `/api/topics/topic-1/interrupts/${item.id}/retry`, headers: { "x-consensus-token": "test" }, payload: { reason: "실제 세션에 미수신한 것을 확인" } });
  expect(result.statusCode).toBe(200); expect((await f.get()).json().items).toHaveLength(1);
  expect(f.db.interrupts.intervention(f.topic.id, interruptTarget(f.db, f.topic.id)!.key)?.handlingAt).toBeNull();
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

it("retries a confirmed transport outage after recovery without exhausting delivery attempts", async () => {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await fixture(); f.pause();
  const id = (await f.get()).json().items[0].id;
  for (let attempt = 0; attempt < 4; attempt++) {
    const claim = (await f.post(id, "claim")).json().claim;
    expect((await f.post(id, "receipt", { claim, state: "failed", error: "control socket unavailable", transportUnavailable: true })).statusCode).toBe(200);
    expect((await f.get()).json().items).toEqual([]);
    now += 60_001;
    expect((await f.get()).json().items.map((item: MediatorInterrupt) => item.id)).toEqual([id]);
  }
  const claim = (await f.post(id, "claim")).json().claim;
  expect((await f.post(id, "receipt", { claim, state: "sent" })).statusCode).toBe(200);
  now += 60_001;
  expect((await f.get()).json().items).toEqual([]);
  expect(f.db.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
});

it("never treats uncertain delivery as a reconnectable pre-send outage", async () => {
  const f = await fixture(); f.pause();
  const id = (await f.get()).json().items[0].id, claim = (await f.post(id, "claim")).json().claim;
  expect((await f.post(id, "receipt", { claim, state: "unknown", transportUnavailable: true })).statusCode).toBe(409);
  expect((await f.post(id, "receipt", { claim, state: "unknown" })).statusCode).toBe(200);
  expect((await f.post(id, "receipt", { claim, state: "failed", transportUnavailable: true })).statusCode).toBe(409);
  expect((await f.get()).json().items).toEqual([]);
});

it.each([false, true])("classifies proxy termination by whether a turn mutation was sent: %s", async afterSend => {
  const root = mkdtempSync(join(tmpdir(), "room-proxy-"));
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "codex"), `#!/usr/bin/env node
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request = JSON.parse(line);
  if (!${afterSend} || request.method === 'turn/start') process.exit(1);
  if (!request.id) return;
  const result = request.method === 'thread/read' ? {thread:{id:'mediator-session',status:{type:'idle'}}} : {};
  process.stdout.write(JSON.stringify({id:request.id,result})+'\\n');
});
`, { mode: 0o700 });
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  await expect(sendCodexInterrupt({ kind: "app-server" }, "mediator-session", item)).rejects.toMatchObject({
    uncertain: afterSend, transportUnavailable: !afterSend,
  });
});

it.each([false, true])("classifies a write callback failure before the stream error event: %s", async afterSend => {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString());
      if (!afterSend || request.method === "turn/start") { callback(Object.assign(new Error("broken pipe"), { code: "EPIPE" })); return; }
      callback();
      if (request.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id,
        result: request.method === "thread/read" ? { thread: { id: "mediator-session", status: { type: "idle" } } } : {},
      }) + "\n"));
    } }),
  });
  vi.mocked(childProcess.spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
  await expect(sendCodexInterrupt({ kind: "app-server" }, "mediator-session", item)).rejects.toMatchObject({ uncertain: afterSend, transportUnavailable: !afterSend });
});

// Adapter replies -> durable milestone -> authenticated mediator API. Real model diagnosis/repair
// and native session delivery are not claimed by this test; existing transport tests cover delivery.
it("checks every five returned review exchanges across retries and restart without pausing work", async () => {
  const f = await fixture();
  f.db.updateTopic("topic-1", { state: "CODEX_AUDIT" });
  const { monitorReviewProgress } = await import("../src/server/reviewProgress");
  const result = { kind: "ACK" as const, summary: "read", findings: [], evidenceRefs: [] };
  const raw = { role: "claude" as const, validateExistingSession: async () => true,
    createSession: async () => ({ sessionId: "review-session", result }), resumeTurn: async () => result };
  const turn = { cwd: f.topic.worktreePath!, topicId: f.topic.id, prompt: "Read next page", sessionId: "review-session",
    job: { role: "reviewer" as const, operation: "audit" as const } };
  let model = monitorReviewProgress(raw, f.db);
  for (let n = 0; n < 4; n++) await model.resumeTurn(turn);
  expect((await f.get()).json().items).toEqual([]);
  await f.restart(); model = monitorReviewProgress(raw, f.db);
  const waiting = f.app.inject({ url: "/api/topics/topic-1/interrupts?provider=codex&sessionId=mediator-session&waitMs=25000", headers: f.headers }).then(value => value);
  await vi.waitFor(() => expect(f.db.events.listenerCount("mediation-change")).toBeGreaterThan(0));
  expect(await model.resumeTurn(turn)).toEqual(result);
  expect((await waiting).json().items).toHaveLength(1);
  const fifth = (await f.get()).json().items[0];
  expect(fifth.reason).toContain("계획 리뷰 왕복 5회");
  expect(fifth.reason).toContain("기존 중재·공식 복구로 풀 수 있는 문제인지");
  expect(f.db.getTopic("topic-1").state).toBe("CODEX_AUDIT");
  const claim = (await f.post(fifth.id, "claim")).json().claim;
  expect((await f.post(fifth.id, "receipt", { claim, state: "sent" })).statusCode).toBe(200);
  await f.restart(); model = monitorReviewProgress(raw, f.db);
  expect((await f.get()).json().items).toEqual([]);
  f.db.updateTopic("topic-1", { state: "CODEX_CLOSEOUT" });
  for (let n = 0; n < 5; n++) await model.resumeTurn({ ...turn, job: { role: "reviewer", operation: "closeout" } });
  const tenth = (await f.get()).json().items[0];
  expect(tenth.reason).toContain("계획 리뷰 왕복 10회");
  expect(tenth.id).not.toBe(fifth.id);
  // A final reply may immediately transition to approval. Preserve its inspection in that alert.
  f.pause("CODEX_CLOSEOUT", "AWAITING_USER_APPROVAL");
  expect((await f.get()).json().items[0].reason).toContain("계획 리뷰 왕복 10회");
  f.db.updateTopic("topic-1", { state: "CODEX_REVIEW" });
  for (let n = 0; n < 5; n++) await model.resumeTurn({ ...turn, job: { role: "reviewer", operation: "review-read" } });
  expect((await f.get()).json().items[0].reason).toContain("구현 리뷰 왕복 5회");
  f.db.updateTopic("topic-1", { state: "CLAUDE_FIX" });
  expect((await f.get()).json().items).toHaveLength(1);
  f.db.updateTopic("topic-1", { state: "CLOSED" });
  expect((await f.get()).json().items).toEqual([]);
});

it("does not count failed, cancelled, stale or non-reviewer calls as review exchanges", async () => {
  const f = await fixture(); f.db.updateTopic("topic-1", { state: "CODEX_REVIEW" });
  const { monitorReviewProgress } = await import("../src/server/reviewProgress");
  const result = { kind: "ACK" as const, summary: "read", findings: [], evidenceRefs: [] };
  const response = vi.fn(async () => result);
  const model = monitorReviewProgress({ role: "codex", validateExistingSession: async () => true,
    createSession: async () => ({ sessionId: "review-session", result: await response() }), resumeTurn: response }, f.db);
  const turn = { cwd: f.topic.worktreePath!, topicId: f.topic.id, prompt: "Review", sessionId: "review-session",
    job: { role: "reviewer" as const, operation: "review" as const } };
  for (let n = 0; n < 4; n++) await model.resumeTurn(turn);
  response.mockRejectedValueOnce(new Error("provider failed"));
  await expect(model.resumeTurn(turn)).rejects.toThrow("provider failed");
  await model.resumeTurn({ ...turn, signal: AbortSignal.abort() });
  await model.resumeTurn({ ...turn, job: { role: "implementer", operation: "implement" } });
  response.mockImplementationOnce(async () => { f.db.updateTopic("topic-1", { scopeGeneration: 2 }); return result; });
  await model.resumeTurn(turn);
  expect((await f.get()).json().items).toEqual([]);
  await model.createSession(turn);
  expect((await f.get()).json().items[0].reason).toContain("구현 리뷰 왕복 5회");
});

it("inherits the existing parent mediator for a new child without issuing a new assignment", async () => {
  const f = await fixture();
  const parent = f.db.roles.assign({ scope: "topic:topic-1", role: "mediator", operation: "", participant: "parent-owner",
    profileId: "mediator-profile", sessionId: "parent-session", expectedVersion: 0, note: "existing parent" });
  f.db.createTopic({ ...f.topic, id: "child", slug: "child", parentTopicId: f.topic.id, state: "DRAFT" });
  f.db.createTopic({ ...f.topic, id: "grandchild", slug: "grandchild", parentTopicId: "child", state: "DRAFT" });
  const headers = { ...f.headers, "x-consensus-mediator": parent.participant, "x-consensus-mediator-version": String(parent.version) };
  const context = await f.app.inject({ url: "/api/mediation/context?topic=grandchild", headers });
  expect(context.statusCode).toBe(200);
  expect(context.json().assignment).toEqual(parent);
  expect(f.db.roles.assignment("topic:grandchild", "mediator")).toBeNull();
  expect(f.db.roles.effective("grandchild", "reviewer")).toBeNull();
  f.db.applyTopicTransition({ topicId: "grandchild", changes: { state: "USER_DECISION_REQUIRED", resumeState: "CODEX_REVIEW" },
    events: [{ actor: "system", kind: "system", state: "USER_DECISION_REQUIRED", body: "Review needs attention" }] });
  const url = "/api/topics/topic-1/interrupts?provider=codex&sessionId=parent-session";
  expect((await f.app.inject({ url, headers })).json().items.map((item: MediatorInterrupt) => item.topicId)).toEqual(["grandchild"]);
  await f.restart();
  expect((await f.app.inject({ url, headers })).json().items).toHaveLength(1);
  const child = f.db.roles.assign({ scope: "topic:child", role: "mediator", operation: "", participant: "child-owner",
    profileId: "mediator-profile", sessionId: "child-session", expectedVersion: 0, note: "explicit override" });
  expect((await f.app.inject({ url, headers })).json().items).toEqual([]);
  expect((await f.app.inject({ url: "/api/topics/grandchild/interrupts?provider=codex&sessionId=parent-session", headers })).statusCode).toBe(409);
  expect(f.db.roles.effective("grandchild", "mediator")).toEqual(child);
  f.db.roles.assign({ ...child, profileId: null, sessionId: null, expectedVersion: child.version });
  expect(interruptTarget(f.db, "grandchild")).toBeNull(); // Explicit unconfigured child masks parent/global.
});

it("reports unavailable and expired connections even without an interrupt, and restores the lease after restart", async () => {
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  const f = await fixture();
  const activity = async () => (await f.app.inject({ url: "/api/topics/topic-1/activity", headers: f.headers })).json();
  const report = (available: boolean, extra = {}) => f.app.inject({ method: "POST", url: "/api/topics/topic-1/interrupts/connection",
    headers: f.headers, payload: { ...f.session, available, ...extra } });
  expect((await activity()).mediationConnection.state).toBe("unreported");
  expect((await report(false, { error: "control socket unavailable" })).statusCode).toBe(200);
  expect(await activity()).toMatchObject({ mediationInterrupt: null, mediationConnection: { state: "unavailable", error: "control socket unavailable" } });
  expect((await report(true)).statusCode).toBe(200);
  await f.restart();
  expect((await activity()).mediationConnection.state).toBe("connected");
  now += 90_001;
  expect((await activity()).mediationConnection.state).toBe("stale");
  expect((await report(true, { sessionId: "wrong" })).statusCode).toBe(409);
  f.assign("new-owner", "new-session", 1);
  expect((await report(true)).statusCode).toBe(409);
  expect((await activity()).mediationConnection.state).toBe("unreported");
  expect(f.db.getTopic(f.topic.id).state).toBe("DRAFT");
});

it("resolves a closed leaf to its assigned parent and surfaces a narrow subscription as a mismatch", async () => {
  const f = await fixture();
  const assignment = f.db.roles.assign({ scope: "topic:topic-1", role: "mediator", operation: "", participant: "owner", profileId: "mediator-profile", sessionId: "mediator-session", expectedVersion: 0, note: "parent assignment" });
  f.headers["x-consensus-mediator-version"] = String(assignment.version);
  f.db.createTopic({ ...f.topic, id: "closed", slug: "closed", parentTopicId: f.topic.id, state: "CLOSED" });
  f.db.createTopic({ ...f.topic, id: "integration", slug: "integration", parentTopicId: f.topic.id });
  const resolution = await f.app.inject({ url: "/api/topics/closed/interrupts/connection?provider=codex&sessionId=mediator-session", headers: f.headers });
  expect(resolution.statusCode, resolution.body).toBe(200);
  expect(resolution.json().subscriptionTopicId).toBe("topic-1");
  await f.app.inject({ method: "POST", url: "/api/topics/closed/interrupts/connection", headers: f.headers, payload: { ...f.session, available: true } });
  expect((await f.app.inject({ url: "/api/topics/integration/activity", headers: f.headers })).json().mediationConnection.state).toBe("scope-mismatch");
  await f.app.inject({ method: "POST", url: "/api/topics/topic-1/interrupts/connection", headers: f.headers, payload: { ...f.session, available: true } });
  expect((await f.app.inject({ url: "/api/topics/integration/resume", headers: f.headers })).json().mediation.connection.state).toBe("connected");
});

it.each(["IMPLEMENTING", "CONSENSUS_ACK"] as const)("keeps delivery, handling, and %s resumption separate across restart", async state => {
  const f = await fixture(); f.pause();
  const id = (await f.get()).json().items[0].id, claim = (await f.post(id, "claim")).json().claim;
  const activity = async () => (await f.app.inject({ url: "/api/topics/topic-1/activity", headers: f.headers })).json();
  await f.post(id, "receipt", { claim, state: "sent" });
  expect((await activity()).mediationIntervention).toMatchObject({ delivery: "sent", handlingAt: null, resumedAt: null });
  expect((await f.post(id, "handling", { sessionId: "wrong" })).statusCode).toBe(409);
  expect((await f.post(id, "handling")).statusCode).toBe(200);
  await f.restart();
  expect((await activity()).mediationIntervention).toMatchObject({ handlingAt: expect.any(String), resumedAt: null });
  const action = { id: "archive", topicId: f.topic.id, kind: "archive", status: "running" as const, createdAt: new Date().toISOString(),
    finishedAt: null, error: null, pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null };
  f.db.startAction(action); f.db.finishAction(action.id, "succeeded");
  expect((await activity()).mediationIntervention.resumedAt).toBeNull();
  f.db.applyTopicTransition({ topicId: f.topic.id, changes: { state, resumeState: null },
    startAction: { ...action, id: "resume-implementation", kind: "retry" },
    events: [{ actor: "system", kind: "system", state, body: "작업 재개" }] });
  expect(await activity()).toMatchObject({ mediationInterrupt: null, mediationIntervention: { id, delivery: "sent", handlingAt: expect.any(String), resumedAt: expect.any(String), actionId: "resume-implementation", closed: true } });
  await f.restart();
  expect((await activity()).mediationIntervention.actionId).toBe("resume-implementation");
  expect((await f.post(id, "handling")).statusCode).toBe(409);
  f.db.updateTopic(f.topic.id, { scopeGeneration: 2 });
  expect((await activity()).mediationIntervention).toBeNull();
});

it("preserves a delivered and handled stop through a no-impact evidence assessment", async () => {
  const f = await fixture(); f.pause("CODEX_REVIEW", "READY_TO_DELIVER");
  const id = (await f.get()).json().items[0].id, claim = (await f.post(id, "claim")).json().claim;
  await f.post(id, "receipt", { claim, state: "sent" });
  await f.post(id, "handling");
  const action = { id: "assessment", topicId: f.topic.id, kind: "evidence-assessment", status: "running" as const,
    createdAt: new Date().toISOString(), finishedAt: null, error: null, pid: null, pgid: null,
    processExecutable: null, processCommand: null, processStartedAt: null };
  f.db.startAction(action);
  const activity = async () => (await f.app.inject({ url: "/api/topics/topic-1/activity", headers: f.headers })).json();
  expect((await activity()).mediationIntervention).toMatchObject({ id, resumedAt: null, closed: false });
  f.db.appendEvent({ topicId: f.topic.id, actor: "system", kind: "system", state: "READY_TO_DELIVER", body: "근거 검토 완료: 영향 없음" });
  f.db.finishAction(action.id, "succeeded");
  await f.restart();
  expect(await activity()).toMatchObject({ mediationInterrupt: { id, state: "sent" },
    mediationIntervention: { id, delivery: "sent", handlingAt: expect.any(String), resumedAt: null, closed: false } });
  expect((await f.get()).json().items).toEqual([]);
  // A later assessment only counts as resumption when it hands off into an active workflow.
  f.db.startAction({ ...action, id: "assessment-replan" });
  expect((await activity()).mediationIntervention.resumedAt).toBeNull();
  f.db.applyTopicTransition({ topicId: f.topic.id, changes: { state: "CLAUDE_REVISION" },
    events: [{ actor: "system", kind: "system", state: "CLAUDE_REVISION", body: "근거 변경 반영을 위한 개정" }] });
  expect(await activity()).toMatchObject({ mediationInterrupt: null,
    mediationIntervention: { id, actionId: "assessment-replan", resumedAt: expect.any(String), closed: true } });
});

// A control-socket proxy child: answers like an app-server whose session has `status`, exits before answering like a
// proxy with no app-server behind the socket (`status` null), or stays up without answering (`"hang"`).
function fakeProxy(status: string | null, calls: string[] = []) {
  const child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), kill: vi.fn(),
    stdin: new Writable({ write(chunk, _encoding, callback) {
      const request = JSON.parse(chunk.toString()); calls.push(request.method); callback();
      if (status === null) { queueMicrotask(() => child.emit("exit", 1, null)); return; }
      if (status === "hang") return;
      if (request.id) queueMicrotask(() => child.stdout.write(JSON.stringify({ id: request.id,
        result: request.method === "thread/read" ? { thread: { id: "mediator-session", status: { type: status } } } : {},
      }) + "\n"));
    } }),
  });
  vi.mocked(childProcess.spawn).mockReturnValueOnce(child as unknown as ReturnType<typeof childProcess.spawn>);
  return child;
}

it("a connection check reads the assigned session without sending a model turn", async () => {
  const calls: string[] = [];
  fakeProxy("active", calls);
  await expect(resolveCodexTransport("mediator-session", "/tmp/explicit.sock")).resolves.toEqual({ kind: "app-server", socket: "/tmp/explicit.sock" });
  expect(calls).toEqual(["initialize", "initialized", "thread/read"]);
  expect(childProcess.spawn).toHaveBeenCalledWith("codex", ["app-server", "proxy", "--sock", "/tmp/explicit.sock"], expect.anything());
});

it.each([
  { name: "no shared app-server answers the default socket", status: null, socket: undefined, transport: { kind: "queue" } },
  { name: "the configured socket is unreachable", status: null, socket: "/tmp/explicit.sock", failure: "Codex 제어 연결을 사용할 수 없습니다" },
  { name: "a shared app-server does not host the session", status: "notLoaded", socket: undefined, failure: "로드되지 않았거나" },
] as Array<{ name: string; status: string | null; socket?: string; transport?: { kind: "queue" }; failure?: string }>)("decides the delivery route once without queueing a message when $name", async ({ status, socket, transport, failure }) => {
  fakeProxy(status);
  const spawned = vi.mocked(childProcess.spawn).mock.calls.length;
  const resolved = resolveCodexTransport("mediator-session", socket);
  if (transport) await expect(resolved).resolves.toEqual(transport);
  else await expect(resolved).rejects.toMatchObject({ transportUnavailable: true, message: expect.stringContaining(failure ?? "") });
  expect(vi.mocked(childProcess.spawn).mock.calls.slice(spawned).map(call => call[1]?.[0])).toEqual(["app-server"]);
});

it("treats a shared app-server that never answers initialize as unavailable, not as absent", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    fakeProxy("hang");
    const resolved = expect(resolveCodexTransport("mediator-session")).rejects.toMatchObject({ timedOut: true, controlUnavailable: false });
    await vi.advanceTimersByTimeAsync(10_000);
    await resolved;
  } finally { vi.useRealTimers(); }
});

it("keeps a missing codex CLI unavailable instead of routing to the queue", async () => {
  const empty = mkdtempSync(join(tmpdir(), "room-no-codex-"));
  cleanups.push(async () => { rmSync(empty, { recursive: true, force: true }); });
  vi.stubEnv("PATH", empty);
  await expect(resolveCodexTransport("mediator-session")).rejects.toMatchObject({ transportUnavailable: true, cliUnavailable: true, message: expect.stringContaining("codex CLI") });
  await expect(sendCodexInterrupt({ kind: "queue" }, "mediator-session", item)).rejects.toMatchObject({ transportUnavailable: true, message: expect.stringContaining("codex CLI") });
});

it.each([
  { exitCode: 0, server: "none", outcome: "sent" },
  { exitCode: 1, server: "none", outcome: "refused" },
  { exitCode: 1, server: "idle", outcome: "rerouted" },
  { exitCode: 1, server: "notLoaded", outcome: "rerouted" },
] as const)("queues one notice for the app without starting a shared daemon: exit $exitCode, shared server $server -> $outcome", async ({ exitCode, server, outcome }) => {
  const root = mkdtempSync(join(tmpdir(), "room-queue-")), calls = join(root, "calls.jsonl");
  cleanups.push(async () => { rmSync(root, { recursive: true, force: true }); });
  writeFileSync(join(root, "codex"), `#!/usr/bin/env node
const fs=require('node:fs'), argv=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(argv) + '\\n');
if (argv[0] === 'queue') process.exit(${exitCode});
if (${JSON.stringify(server)} === 'none') process.exit(1);
require('node:readline').createInterface({input:process.stdin}).on('line', line => { const request = JSON.parse(line);
  if (request.id) process.stdout.write(JSON.stringify({id:request.id,result:request.method==='thread/read'?{thread:{id:'mediator-session',status:{type:${JSON.stringify(server)}}}}:{}})+'\\n'); });
`, { mode: 0o700 });
  vi.stubEnv("PATH", `${root}:${process.env.PATH}`);
  const failure = await sendCodexInterrupt({ kind: "queue" }, "mediator-session", item).then(() => null, (error: Error & { uncertain?: boolean; transportUnavailable?: boolean }) => error);
  const flags = { uncertain: failure?.uncertain, transportUnavailable: failure?.transportUnavailable };
  if (outcome === "sent") expect(failure).toBeNull();
  // Still no shared server: the CLI itself refused, a counted failure that is neither reconnectable nor unknown.
  else if (outcome === "refused") { expect(failure?.message).toContain("대기열 추가를 거부"); expect(flags).toEqual({ uncertain: undefined, transportUnavailable: undefined }); }
  // A shared server appeared after the route was decided: nothing was queued and the next check re-routes it.
  else { expect(failure?.message).toContain("전달 경로가 바뀌었습니다"); expect(flags).toEqual({ uncertain: undefined, transportUnavailable: true }); }
  expect(readFileSync(calls, "utf8").trim().split("\n").map(line => JSON.parse(line))).toEqual([
    ["queue", "--disable", "daemon_auto_start", "--thread", "mediator-session", "--message", interruptMessage(item)],
    ...(outcome === "sent" ? [] : [["app-server", "proxy"]]),
  ]);
});

it("never treats an enqueue that timed out or was killed as a resendable pre-send failure", async () => {
  const child = () => {
    const fake = Object.assign(new EventEmitter(), { kill: vi.fn() });
    vi.mocked(childProcess.spawn).mockReturnValueOnce(fake as unknown as ReturnType<typeof childProcess.spawn>);
    return fake;
  };
  const killed = child(), signalled = sendCodexInterrupt({ kind: "queue" }, "mediator-session", item);
  killed.emit("exit", null, "SIGTERM");
  await expect(signalled).rejects.toMatchObject({ uncertain: true });
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    const hung = child(), pending = expect(sendCodexInterrupt({ kind: "queue" }, "mediator-session", item)).rejects.toMatchObject({ uncertain: true });
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;
    expect(hung.kill).toHaveBeenCalled();
  } finally { vi.useRealTimers(); }
});

// Runs the real bridge process against the fixture server with a fake `codex` CLI on PATH. The fake answers the
// control proxy like an app-server hosting the session (or exits like a proxy without one), accepts `codex queue`,
// and records every call. Add server hooks before calling: the server starts listening here.
async function startCodexBridge(f: Awaited<ReturnType<typeof fixture>>, { appServer, topicId, env = {} }: { appServer: boolean; topicId: string; env?: Record<string, string> }) {
  const bin = mkdtempSync(join(tmpdir(), "room-bridge-")), calls = join(bin, "calls.jsonl");
  const clockFile = join(bin, "clock"), clockPreload = join(bin, "clock.cjs");
  writeFileSync(clockFile, "0");
  writeFileSync(clockPreload, `const originalNow=Date.now; Date.now=()=>originalNow()+Number(require('node:fs').readFileSync(${JSON.stringify(clockFile)}, 'utf8'));`);
  writeFileSync(calls, "");
  writeFileSync(join(bin, "codex"), `#!/usr/bin/env node
const fs=require('node:fs'), argv=process.argv.slice(2);
if(argv[0]==='queue'){fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({method:'queue',argv})+'\\n');process.exit(0);}
require('node:readline').createInterface({input:process.stdin}).on('line', line=>{
 const request=JSON.parse(line);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify({...request,argv})+'\\n');
 if (!${appServer}) process.exit(1);
 if(request.id)process.stdout.write(JSON.stringify({id:request.id,result:request.method==='thread/read'?{thread:{id:'mediator-session',status:{type:'idle'}}}:{}})+'\\n');
});\n`, { mode: 0o700 });
  const address = await listenReady(f.app, { port: 0, host: "127.0.0.1" });
  const bridge = childProcess.spawn(process.execPath, ["--require", clockPreload, "--import", "tsx", "src/server/mediation/interruptBridge.ts", "codex"], {
    cwd: process.cwd(), stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CONSENSUS_ROOM_URL: address,
      CONSENSUS_ROOM_TOKEN: "test", CONSENSUS_ROOM_TOPIC_ID: topicId, CONSENSUS_MEDIATOR: "owner@1", CONSENSUS_MEDIATOR_SESSION_ID: "mediator-session", ...env },
  });
  let stderr = ""; bridge.stderr!.on("data", data => { stderr += data; });
  cleanups.push(async () => {
    if (bridge.exitCode === null && bridge.signalCode === null) { const exit = new Promise<void>(resolve => bridge.once("exit", () => resolve())); bridge.kill(); await exit; }
    rmSync(bin, { recursive: true, force: true });
  });
  return { bridge, clockFile, stderr: () => stderr,
    calls: () => readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line)) };
}

it.each([
  { appServer: true, race: null }, { appServer: false, race: null },
  { appServer: true, race: "claim" }, { appServer: true, race: "receipt" }, { appServer: true, race: "parent" },
] as const)("bridge preserves authorized parent delivery from a closed leaf: app-server $appServer / $race", async ({ appServer, race }) => {
  const f = await fixture();
  const originalTarget = interruptTarget(f.db, f.topic.id)!.key;
  f.db.createTopic({ ...f.topic, id: "closed", slug: "closed", parentTopicId: f.topic.id, state: "CLOSED" });
  f.db.createTopic({ ...f.topic, id: "integration", slug: "integration", parentTopicId: f.topic.id });
  f.db.applyTopicTransition({ topicId: "integration", changes: { state: "USER_DECISION_REQUIRED", resumeState: "IMPLEMENTING" },
    events: [{ actor: "system", kind: "system", state: "USER_DECISION_REQUIRED", body: "범위 확인" }] });
  const connectionPaths: string[] = [];
  let raced = false;
  f.app.addHook("onRequest", async request => {
    if (request.method === "GET" && request.url.includes("/interrupts/connection?")) connectionPaths.push(request.url.split("?")[0]);
    if (race && !raced && request.method === "POST" && request.url.startsWith("/api/topics/integration/interrupts/")
      && request.url.endsWith(race === "receipt" ? "/receipt" : "/claim")) {
      raced = true;
      if (race === "parent") f.assign("new-owner", "new-session", 1);
      else f.db.roles.assign({ scope: "topic:integration", role: "mediator", operation: "", participant: "child-owner",
        profileId: "mediator-profile", sessionId: "child-session", expectedVersion: 0, note: "reassigned during delivery" });
      f.pause("IMPLEMENTING");
    }
  });
  const run = await startCodexBridge(f, { appServer, topicId: "closed" });
  // Without a shared app-server the session is reachable through the app-consumed queue, so the connection holds.
  await vi.waitFor(() => expect(f.db.interrupts.connection(originalTarget, f.topic.id).state, run.stderr()).toBe("connected"), { timeout: 5000 });
  if (race) {
    if (race === "parent") await vi.waitFor(() => expect(run.bridge.exitCode).toBe(1), { timeout: 5000 });
    else {
      await vi.waitFor(() => expect(f.db.interrupts.status(f.topic.id, originalTarget)?.state, run.stderr()).toBe("sent"), { timeout: 5000 });
      expect(run.bridge.exitCode, run.stderr()).toBeNull();
    }
    expect(raced).toBe(true);
    expect(connectionPaths).toContain("/api/topics/topic-1/interrupts/connection");
    expect(f.db.interrupts.status("integration", interruptTarget(f.db, "integration")!.key)?.state).toBe("waiting");
    const turns = run.calls().filter(r => ["turn/start", "turn/steer"].includes(r.method));
    expect(turns).toHaveLength(race === "parent" ? 0 : race === "receipt" ? 2 : 1);
    if (race !== "parent") expect(turns.at(-1).params.input[0].text).toContain("/api/topics/topic-1/resume");
    return;
  }
  await vi.waitFor(() => expect(f.db.interrupts.status("integration", interruptTarget(f.db, "integration")!.key)?.state, run.stderr()).toBe("sent"), { timeout: 5000 });
  const requests = run.calls();
  expect(requests.filter(r => ["turn/start", "turn/steer"].includes(r.method))).toHaveLength(appServer ? 1 : 0);
  expect(requests.filter(r => r.method === "queue").map(r => r.argv)).toEqual(appServer ? [] : [
    ["queue", "--disable", "daemon_auto_start", "--thread", "mediator-session", "--message", expect.stringContaining("/api/topics/integration/resume")],
  ]);
  expect(requests.some(r => r.method === "thread/start" || r.method === "thread/resume" || r.method === "turn/interrupt")).toBe(false);
  if (appServer) {
    f.db.roles.assign({ scope: "topic:closed", role: "mediator", operation: "", participant: "child-owner",
      profileId: "mediator-profile", sessionId: "child-session", expectedVersion: 0, note: "independent child mediator" });
    writeFileSync(run.clockFile, "31000");
    f.pause("IMPLEMENTING"); // Wake the existing long poll; the next connection probe is due.
    await vi.waitFor(() => expect(connectionPaths, run.stderr()).toContain("/api/topics/topic-1/interrupts/connection"), { timeout: 5000 });
    await vi.waitFor(() => expect(f.db.interrupts.status(f.topic.id, interruptTarget(f.db, f.topic.id)!.key)?.state).toBe("sent"), { timeout: 5000 });
    expect(run.bridge.exitCode, run.stderr()).toBeNull();
    expect(connectionPaths.filter(path => path === "/api/topics/closed/interrupts/connection")).toHaveLength(1);
  }
});

it("records an unreachable session on each claimed request and reclaims it without spending attempts", async () => {
  // The store reads the clock it was built with; advance it with real time plus an explicit offset.
  const realNow = Date.now; let offset = 0;
  vi.spyOn(Date, "now").mockImplementation(() => realNow() + offset);
  const f = await fixture(); f.pause();
  const target = interruptTarget(f.db, f.topic.id)!.key, id = f.db.interrupts.current(f.topic.id)!.id;
  const run = await startCodexBridge(f, { appServer: false, topicId: f.topic.id, env: { CONSENSUS_CODEX_SOCKET: "/tmp/room-missing-control.sock" } });
  const delivery = () => f.db.interrupts.current(f.topic.id)?.deliveries[target];
  await vi.waitFor(() => expect(delivery(), run.stderr()).toMatchObject({ state: "failed", transportUnavailable: true, attempts: 0 }), { timeout: 5000 });
  expect(f.db.interrupts.connection(target, f.topic.id)).toMatchObject({ state: "unavailable", error: expect.stringContaining("제어 연결을 사용할 수 없습니다") });
  expect(f.db.interrupts.status(f.topic.id, target)).toMatchObject({ id, state: "failed", error: expect.stringContaining("제어 연결을 사용할 수 없습니다") });
  const first = delivery()!;
  await vi.waitFor(() => expect(f.db.events.listenerCount("mediation-change")).toBeGreaterThan(0), { timeout: 5000 });
  offset = 60_001; f.db.events.emit("mediation-change"); // The pre-send retry window passed; wake the long poll.
  await vi.waitFor(() => expect(delivery()?.claim, run.stderr()).not.toBe(first.claim), { timeout: 5000 });
  await vi.waitFor(() => expect(delivery()).toMatchObject({ state: "failed", transportUnavailable: true, attempts: 0 }), { timeout: 5000 });
  expect(run.calls().filter(r => ["queue", "turn/start", "turn/steer"].includes(r.method))).toEqual([]);
  expect(run.calls().every(r => r.argv.includes("/tmp/room-missing-control.sock"))).toBe(true);
});

it("the Claude channel bridge still delivers through the same loop and records the acknowledgement", async () => {
  const f = await fixture();
  f.db.roles.createProfile({ id: "claude-profile", provider: "claude", model: "test-model", effort: "medium", options: {} });
  const assignment = f.db.roles.assign({ scope: "global", role: "mediator", operation: "", profileId: "claude-profile", participant: "claude-owner",
    sessionId: "claude-session", expectedVersion: 1, note: "claude mediator" });
  const target = interruptTarget(f.db, f.topic.id)!.key;
  const address = await listenReady(f.app, { port: 0, host: "127.0.0.1" });
  const notifications: Array<{ method: string; params?: { meta?: Record<string, string> } }> = [];
  const client = new Client({ name: "mediator-test", version: "1.0.0" });
  client.fallbackNotificationHandler = async notification => { notifications.push(notification as typeof notifications[number]); };
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined));
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", "src/server/mediation/interruptBridge.ts", "claude"],
    cwd: process.cwd(), stderr: "ignore", env: { ...env, CONSENSUS_ROOM_URL: address, CONSENSUS_ROOM_TOKEN: "test", CONSENSUS_ROOM_TOPIC_ID: f.topic.id,
      CONSENSUS_MEDIATOR: `claude-owner@${assignment.version}`, CONSENSUS_MEDIATOR_SESSION_ID: "claude-session" } }));
  cleanups.push(async () => { await client.close(); });
  await vi.waitFor(() => expect(f.db.interrupts.connection(target, f.topic.id)).toMatchObject({ state: "connected", error: null }), { timeout: 5000 });
  f.pause();
  await vi.waitFor(() => expect(notifications.map(notification => notification.method)).toEqual(["notifications/claude/channel"]), { timeout: 5000 });
  const interruptId = notifications[0].params!.meta!.interrupt_id;
  expect(interruptId).toBe(f.db.interrupts.current(f.topic.id)!.id);
  await vi.waitFor(() => expect(f.db.interrupts.status(f.topic.id, target)?.state).toBe("sent"), { timeout: 5000 });
  await client.callTool({ name: "consensus_interrupt_ack", arguments: { interruptId } });
  expect(f.db.interrupts.status(f.topic.id, target)?.state).toBe("acknowledged");
});
