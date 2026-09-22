import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { ArtifactStore } from "../src/server/artifacts";
import { GitService } from "../src/server/git";
import { EngineCore } from "../src/server/engine/core";
import { WorkflowEngine } from "../src/server/workflow";
import { buildApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { ProjectMemoryReader } from "../src/server/projectMemory";
import type { AgentAdapter, CommandRunner } from "../src/server/types";

// Public workflow and HTTP entry points. Assertions target spawned calls, retained result and final topic state.
const roots: string[] = []; const dbs: ConsensusDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sourceInput = { url: "https://team.atlassian.net/browse/APP-1", label: "Feature", mode: "connector" as const, intervalSeconds: 300 };
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "evidence-flow-")); roots.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite")); dbs.push(database);
  const topic = database.createTopic({ id: "t", slug: "t", title: "Feature", repositoryPath: root, worktreePath: root, baseRef: "main", branchName: "work",
    state: "IMPLEMENTING", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  const source = database.evidence.register(topic.id, sourceInput);
  const ingest = (content: string) => {
    const check = database.evidence.begin(source.id, true)!;
    return database.evidence.ingest(source.id, { checkId: check.checkId, revision: content, units: [{ id: "issue", kind: "issue", content }] });
  };
  ingest("initial"); database.evidence.review(topic, database.evidence.topic(topic).digest, "Compared with plan", topic);
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: vi.fn(async turn => { await turn.beforeSpawn?.(); turn.admitSync?.(); return { sessionId: "s", result: { kind: "IMPLEMENTATION", summary: "result", findings: [] } as any }; }),
    resumeTurn: vi.fn(async () => { throw new Error("unused"); }) };
  const dependencies = { database, artifacts: new ArtifactStore(join(root, "topics"), database), git: new GitService(runner), claude: adapter, codex: { ...adapter, role: "codex" as const }, enforceBudgets: false };
  return { root, database, topic, source, ingest, runner, adapter, dependencies };
}
it("marks unchanged wiki files for rechecking when their actual source hash changes", async () => {
  const f = fixture();
  const dependency = { sourceId: f.source.id, contentHash: f.database.evidence.get(f.source.id).contentHash! };
  writeFileSync(join(f.root, "context-router.md"), `# Reference\n\n\`\`\`wiki-evidence\n${JSON.stringify({ dependencies: [dependency] })}\n\`\`\`\n`);
  const reader = new ProjectMemoryReader(f.root, { resolveEvidenceStatus: dependencies => f.database.evidence.status(dependencies) });
  const before = await reader.select("Reference", "claude");
  expect(await reader.buildPrompt("Reference", "claude")).toContain("외부 근거: current");
  f.ingest("Changed backend contract");
  expect(await reader.buildManifest("Reference", "codex")).toContain("외부 근거: changed");
  expect((await reader.select("Reference", "codex"))[0].sha256).toBe(before[0].sha256);
  const check = f.database.evidence.begin(f.source.id, true)!;
  f.database.evidence.failed(f.source.id, check.checkId, "Access denied");
  expect(await reader.buildPrompt("Reference", "claude")).toContain("외부 근거: unavailable");
});
it("blocks the actual spawn if a source changes during adapter preparation", async () => {
  const f = fixture(); let spawned = false;
  f.adapter.createSession = async turn => {
    f.ingest("new"); await turn.beforeSpawn?.(); turn.admitSync?.(); spawned = true;
    return { sessionId: "s", result: {} as any };
  };
  const core = new EngineCore(f.dependencies);
  core.startAction(f.topic.id, "evidence-test", async signal => {
    await core.executor.execute({ role: "claude", topic: f.topic, signal, purpose: "턴", inputSequence: 0, expected: core.expectationOf(f.topic), write: true,
      session: { mode: "create" }, prompt: "Implement", implementation: true, settings: { model: "opus", effort: "high" } });
  });
  await core.active.get(f.topic.id)!.completion;
  expect(spawned).toBe(false); expect(f.database.getTopic(f.topic.id).state).toBe("BLOCKED_ON_EVIDENCE");
});
it("preserves an in-flight result without accepting it when source content changes", async () => {
  const f = fixture(); let accepted = false;
  f.adapter.createSession = async () => { f.ingest("new"); return { sessionId: "s", result: { kind: "IMPLEMENTATION", summary: "old evidence result", findings: [], evidenceRefs: [], status: "completed" } as any }; };
  const core = new EngineCore(f.dependencies);
  core.startAction(f.topic.id, "evidence-test", async signal => {
    await core.executor.execute({ role: "claude", topic: f.topic, signal, purpose: "턴", inputSequence: 0, expected: core.expectationOf(f.topic), write: true,
      session: { mode: "create" }, prompt: "Implement", implementation: true, settings: { model: "opus", effort: "high" } });
    accepted = true;
  });
  await core.active.get(f.topic.id)!.completion;
  expect(accepted).toBe(false); expect(f.database.getTopic(f.topic.id).state).toBe("BLOCKED_ON_EVIDENCE");
  expect(await f.dependencies.artifacts.readLatest(f.topic.id, "claude-interrupted")).toContain("old evidence result");
});
it("guards commit and push before invoking Git when evidence is changed or stale", () => {
  const f = fixture(); f.database.updateTopic(f.topic.id, { state: "READY_TO_DELIVER" });
  const workflow = new WorkflowEngine(f.dependencies); f.ingest("new");
  expect(() => workflow.commit(f.topic.id, "commit", ["x"])).toThrow("검토");
  expect(() => workflow.push(f.topic.id)).toThrow("검토");
  expect(f.runner.run).not.toHaveBeenCalled();
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  f.database.evidence.review(f.database.getTopic(f.topic.id), f.database.evidence.topic(f.topic).digest, "Checked change", f.database.getTopic(f.topic.id));
  now += 601_000;
  expect(() => workflow.push(f.topic.id)).toThrow("오래");
});
it("rejects a plan repair response when its source changed during the call", async () => {
  const f = fixture(); let accepted = false;
  f.adapter.resumePlanRepair = async () => { f.ingest("New planning decision"); return {} as any; };
  const core = new EngineCore(f.dependencies);
  core.startAction(f.topic.id, "evidence-repair-test", async signal => {
    await core.executor.executePlanRepair({ role: "claude", topic: f.topic, signal, purpose: "계획 교정", inputSequence: 0,
      expected: core.expectationOf(f.topic), write: false, session: { mode: "resume", sessionId: "s" }, prompt: "Repair format", implementation: false,
      settings: { model: "opus", effort: "high" } });
    accepted = true;
  });
  await core.active.get(f.topic.id)!.completion;
  expect(accepted).toBe(false); expect(f.database.getTopic(f.topic.id).state).toBe("BLOCKED_ON_EVIDENCE");
});
it("serves authenticated bridge APIs, rejects stale completions and enforces mediator review authority", async () => {
  const f = fixture();
  const config = loadConfig({ repositoryPath: f.root, dataDirectory: f.root, databasePath: join(f.root, "room.sqlite"), topicsDirectory: join(f.root, "topics"),
    worktreesDirectory: join(f.root, "worktrees"), webDirectory: join(f.root, "no-web"), launchToken: "test-token", enforceBudgets: false });
  const app = await buildApp({ config, database: f.database, runner: f.runner, claude: f.adapter, codex: { ...f.adapter, role: "codex" } });
  const headers = { "x-consensus-token": "test-token" };
  expect((await app.inject({ method: "GET", url: "/api/topics/t/evidence" })).statusCode).toBe(401);
  const check = (await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/check`, headers, payload: { force: true } })).json();
  expect(check.checkId).toBeTruthy();
  const update = await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/snapshot`, headers,
    payload: { checkId: check.checkId, revision: "v2", units: [{ id: "issue", kind: "issue", content: "new" }] } });
  expect(update.statusCode).toBe(200);
  const repeated = await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/snapshot`, headers,
    payload: { checkId: check.checkId, revision: "v1", units: [] } });
  expect(repeated.statusCode).toBe(409);
  const state = (await app.inject({ method: "GET", url: "/api/topics/t/evidence", headers })).json();
  expect(state.reviewed).toBe(false);
  const denied = await app.inject({ method: "POST", url: "/api/topics/t/evidence/review", headers: { ...headers, "x-consensus-actor": "mediator" }, payload: { digest: state.digest, plan: state.plan, reason: "Reviewed" } });
  expect(denied.statusCode).toBe(403);
  expect((await app.inject({ method: "POST", url: "/api/topics/t/evidence/review", headers, payload: { digest: state.digest, plan: state.plan, reason: "Reviewed source and plan" } })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/api/evidence/status", headers, payload: { dependencies: [{ sourceId: f.source.id, contentHash: update.json().contentHash }] } })).json()).toEqual({ status: "current" });
  const address = await app.listen({ host: "127.0.0.1", port: 0 });
  const launchFile = join(f.root, "launch.url");
  writeFileSync(launchFile, `${address}/?token=test-token`, { mode: 0o600 });
  const bridge = await promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launchFile, "status", "--id", f.topic.id]);
  expect(JSON.parse(bridge.stdout).sources[0].contentHash).toBe(update.json().contentHash);
  expect(bridge.stdout).not.toContain("test-token");
  writeFileSync(launchFile, "https://remote.example/?token=test-token");
  await expect(promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launchFile, "due"]))
    .rejects.toMatchObject({ code: 1, stderr: "Expected the existing local Consensus Room launch URL\n" });
  await app.close(); dbs.splice(dbs.indexOf(f.database), 1);
});

it.each([
  { planSHA256: "b".repeat(64) }, { planEpoch: 2 }, { scopeGeneration: 2 },
])("rejects review submitted for a previous plan binding: %j", async change => {
  const f = fixture();
  const config = loadConfig({ repositoryPath: f.root, dataDirectory: f.root, webDirectory: join(f.root, "no-web"), launchToken: "test-token", enforceBudgets: false });
  const app = await buildApp({ config, database: f.database, runner: f.runner, claude: f.adapter, codex: { ...f.adapter, role: "codex" } });
  const headers = { "x-consensus-token": "test-token" };
  try {
    const previous = (await app.inject({ method: "GET", url: "/api/topics/t/evidence", headers })).json();
    f.database.updateTopic(f.topic.id, change);
    const review = await app.inject({ method: "POST", url: "/api/topics/t/evidence/review", headers,
      payload: { digest: previous.digest, plan: previous.plan, reason: "Compared the previous plan" } });
    expect(review.statusCode).toBe(409);
    expect(f.database.evidence.topic(f.database.getTopic(f.topic.id)).reviewed).toBe(false);
    const current = (await app.inject({ method: "GET", url: "/api/topics/t/evidence", headers })).json();
    expect((await app.inject({ method: "POST", url: "/api/topics/t/evidence/review", headers,
      payload: { digest: current.digest, plan: current.plan, reason: "Compared the updated plan" } })).statusCode).toBe(200);
    expect(f.database.evidence.topic(f.database.getTopic(f.topic.id)).reviewed).toBe(true);
  } finally { await app.close(); }
});

it("uses mediator HTTP and CLI batches without model calls or implicit acknowledgement", async () => {
  const f = fixture(); f.database.updateTopic(f.topic.id, { state: "AWAITING_USER_APPROVAL" });
  const config = loadConfig({ repositoryPath: f.root, dataDirectory: f.root, webDirectory: join(f.root, "no-web"), launchToken: "test-token", enforceBudgets: false });
  let configured = false;
  const fetch = vi.fn(async () => ({ revision: "server-r1", units: [{ id: "issue", kind: "issue" as const, content: "server body" }] }));
  const app = await buildApp({ config, database: f.database, runner: f.runner, claude: f.adapter, codex: { ...f.adapter, role: "codex" },
    evidenceConnector: { configured: () => configured, fetch } });
  const headers = { "x-consensus-token": "test-token" }; const mediator = { ...headers, "x-consensus-actor": "mediator" };
  try {
    const url = "/api/topics/t/evidence/mediator/batch";
    expect((await app.inject({ method: "POST", url, payload: { sessionId: "s" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers, payload: { sessionId: "s" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "POST", url, headers: mediator, payload: { sessionId: "s" } })).statusCode).not.toBe(200);
    expect(fetch).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/use-rest`, headers: mediator, payload: {} })).statusCode).toBe(403);
    const convert = () => app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/use-rest`, headers, payload: {} });
    expect((await convert()).statusCode).not.toBe(200);
    configured = true;
    const shared = f.database.createTopic({ ...f.topic, id: "shared", slug: "shared", worktreePath: join(f.root, "shared"), state: "DRAFT" });
    f.database.evidence.register(shared.id, sourceInput);
    f.database.startAction({ id: "shared-action", topicId: shared.id, kind: "plan", status: "running", createdAt: new Date().toISOString(),
      finishedAt: null, error: null, pid: null, pgid: null, processCommand: null, processExecutable: null, processStartedAt: null });
    expect((await convert()).statusCode).not.toBe(200);
    expect(f.database.evidence.get(f.source.id).mode).toBe("connector");
    f.database.finishAction("shared-action", "succeeded");
    expect((await convert()).statusCode).toBe(200);
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const launch = join(f.root, "bridge.url"); writeFileSync(launch, `${address}/?token=test-token`, { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launch, ...args]);
    const first = JSON.parse((await cli("batch", "--id", "t", "--session", "actual-session")).stdout);
    expect(first.changes.map((u: any) => u.content)).toEqual(["server body"]);
    expect(JSON.stringify(first)).not.toContain("test-token");
    expect(JSON.parse((await cli("batch", "--id", "t", "--session", "actual-session")).stdout).batchId).toBe(first.batchId);
    f.ingest("arrived after batch");
    await cli("ack", "--id", "t", "--session", "actual-session", "--batch", first.batchId);
    const next = JSON.parse((await cli("batch", "--id", "t", "--session", "actual-session")).stdout);
    expect(next.changes.map((u: any) => u.content)).toEqual(["arrived after batch"]);
    expect(next.batchId).not.toBe(first.batchId);
    const connections = (await app.inject({ method: "GET", url: "/api/evidence/connections", headers })).json();
    expect(connections[0]).toMatchObject({ configured: true, mode: "rest", topics: expect.arrayContaining(["t", "shared"]) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.resumeTurn).not.toHaveBeenCalled();
  } finally { await app.close(); dbs.splice(dbs.indexOf(f.database), 1); }
});
