import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { withEvidence } from "../src/server/evidence/service";
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
    await core.executor.execute({ route: core.route(f.topic, { role: "implementer", operation: "implement" }), topic: f.topic, signal, purpose: "턴", inputSequence: 0, expected: core.expectationOf(f.topic),
      session: { mode: "create" }, prompt: "Implement", settings: { model: "opus", effort: "high" } });
  });
  await core.active.get(f.topic.id)!.completion;
  expect(spawned).toBe(false); expect(f.database.getTopic(f.topic.id).state).toBe("BLOCKED_ON_EVIDENCE");
});
it("preserves an in-flight result without accepting it when source content changes", async () => {
  const f = fixture(); let accepted = false;
  f.adapter.createSession = async () => { f.ingest("new"); return { sessionId: "s", result: { kind: "IMPLEMENTATION", summary: "old evidence result", findings: [], evidenceRefs: [], status: "completed" } as any }; };
  const core = new EngineCore(f.dependencies);
  core.startAction(f.topic.id, "evidence-test", async signal => {
    await core.executor.execute({ route: core.route(f.topic, { role: "implementer", operation: "implement" }), topic: f.topic, signal, purpose: "턴", inputSequence: 0, expected: core.expectationOf(f.topic),
      session: { mode: "create" }, prompt: "Implement", settings: { model: "opus", effort: "high" } });
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
    await core.executor.executePlanRepair({ route: core.route(f.topic, { role: "planner", operation: "plan-repair" }), topic: f.topic, signal, purpose: "계획 교정", inputSequence: 0,
      expected: core.expectationOf(f.topic), session: { mode: "resume", sessionId: "s" }, prompt: "Repair format",
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

it.each(["missing", "expired", "failed"])("admits planning and implementation with %s visual cache through the real executor", async status => {
  const f = fixture();
  const source = f.database.evidence.register(f.topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Screen?node-id=1-2" });
  if (status !== "missing") {
    f.database.evidence.ingest(source.id, { checkId: f.database.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [{ id: "node", kind: "design", content: "layout" }] });
    if (status === "expired") {
      const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 601000); f.ingest("initial");
    } else f.database.evidence.failed(source.id, f.database.evidence.begin(source.id, true)!.checkId, "offline");
  }
  const core = new EngineCore(f.dependencies);
  for (const implementation of [false, true]) {
    const topic = f.database.updateTopic(f.topic.id, { state: implementation ? "IMPLEMENTING" : "CLAUDE_PLAN" });
    f.database.evidence.review(topic, f.database.evidence.topic(topic).digest, "Product behavior checked; visual details deferred", topic);
    let accepted = false;
    core.startAction(topic.id, "design-test", async signal => {
      await core.executor.execute({ route: core.route(topic, implementation ? { role: "implementer", operation: "implement" } : { role: "planner", operation: "plan" }),
        topic, signal, purpose: "턴", inputSequence: 0, expected: core.expectationOf(topic),
        session: { mode: "create" }, prompt: "Task", settings: { model: "opus", effort: "high" } });
      accepted = true;
    });
    await core.active.get(topic.id)!.completion;
    expect(accepted).toBe(true);
  }
  expect(f.adapter.createSession).toHaveBeenCalledTimes(2);
});

// E3-1 bridge 소비처: 중재자가 실제로 받는 것은 bridge stdout 이다. 작은 --page-bytes 로 batch → 읽기 → ack → 다음 쪽을 batchId:null 까지 돌린다.
// 원문 전체를 먼저 출력하지 않는다 — 한 번의 batch 출력이 한 쪽이고, 그 바이트(끝 개행 제외)가 요청한 쪽 크기 이하다.
it("bridge 가 작은 쪽 크기로 큰 단위를 구간으로 끝까지 받고, 출력은 응답 본문 그대로이며, 끝 구간 ack 전에는 완료 영수증이 없다", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-pages-")); roots.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite")); dbs.push(database);
  const topic = database.createTopic({ id: "t", slug: "t", title: "Pages", repositoryPath: root, worktreePath: root, baseRef: "main", branchName: "work",
    state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  const source = database.evidence.register(topic.id, { url: "https://team.atlassian.net/browse/APP-2", label: "Big", mode: "rest", intervalSeconds: 300 });
  // 한국어·이모지(서로게이트 쌍)·JSON escape(따옴표·역슬래시·개행·제어 문자)가 섞인 최대 길이(160,000 UTF-16 코드 단위) 본문.
  const alphabet = ["가", "😀", '"', "\\", "\n", "\u0001", "a", "é"];
  let big = "";
  for (let index = 0; big.length + alphabet[index % alphabet.length].length <= 160_000; index++) big += alphabet[index % alphabet.length];
  database.evidence.ingest(source.id, { checkId: database.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [
    { id: "a-small", kind: "comment", content: "first small" }, { id: "b-big", kind: "comment", content: big }, { id: "c-small", kind: "comment", content: "last small" },
  ] });
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: vi.fn(async () => { throw new Error("unused"); }), resumeTurn: vi.fn(async () => { throw new Error("unused"); }) };
  const fetch = vi.fn(async () => ({ revision: "unused", units: [] }));
  const config = loadConfig({ repositoryPath: root, dataDirectory: root, webDirectory: join(root, "no-web"), memoryDirectory: join(root, "memory"),
    launchToken: "test-token", enforceBudgets: false });
  const app = await buildApp({ config, database, runner, claude: adapter, codex: { ...adapter, role: "codex" }, evidenceConnector: { configured: () => true, fetch } });
  const raw = new DatabaseSync(join(root, "room.sqlite"));
  try {
    const mediator = { "x-consensus-token": "test-token", "x-consensus-actor": "mediator" };
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const launch = join(root, "bridge.url"); writeFileSync(launch, `${address}/?token=test-token`, { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launch, ...args], { maxBuffer: 4 << 20 });
    const batch = async (session: string, pageBytes: number) => {
      const { stdout } = await cli("batch", "--id", "t", "--session", session, "--page-bytes", String(pageBytes));
      expect(stdout.endsWith("\n")).toBe(true);
      expect(Buffer.byteLength(stdout) - 1).toBeLessThanOrEqual(pageBytes);
      return { stdout, page: JSON.parse(stdout) as { batchId: string | null; changes: Array<{ id: string; content: string; range?: { offset: number; end: number; total: number } }>; remaining: number } };
    };
    const ack = (session: string, batchId: string) => cli("ack", "--id", "t", "--session", session, "--batch", batchId);
    const received: Array<{ id: string; content: string; range?: { offset: number; end: number; total: number } }> = [];

    const first = await batch("mediator", 50_000);
    // 출력은 서버 응답 본문 바이트 그대로다(끝 개행만 더한다). 같은 대기 쪽을 HTTP 로 받은 본문과 비교한다.
    const body = (await app.inject({ method: "POST", url: "/api/topics/t/evidence/mediator/batch", headers: mediator, payload: { sessionId: "mediator", pageBytes: 50_000 } })).body;
    expect(first.stdout).toBe(`${body}\n`);
    expect((await app.inject({ method: "POST", url: "/api/topics/t/evidence/mediator/batch", headers: mediator,
      payload: { sessionId: "mediator", pageBytes: 240_001 } })).statusCode).toBe(400);
    // 큰 단위는 이 쪽에 다 들어가지 않고 이미 다른 항목이 있으므로 다음 쪽으로 넘어간다.
    expect(first.page.changes.map(change => change.id)).toEqual(["a-small"]);
    received.push(...first.page.changes); await ack("mediator", first.page.batchId!);

    const second = await batch("mediator", 50_000);
    expect(second.page.changes.map(change => [change.id, change.range?.offset])).toEqual([["b-big", 0]]);
    // 대기 쪽보다 작은 쪽을 요청하면 더 작은 새 쪽으로 바뀌고, 옛 batchId 는 ack 할 수 없다. 그 뒤 큰 요청은 작은 대기 쪽을 그대로 받는다.
    const smaller = await batch("mediator", 20_000);
    expect(smaller.page.batchId).not.toBe(second.page.batchId);
    expect(smaller.page.changes[0].range!.end).toBeLessThan(second.page.changes[0].range!.end);
    await expect(ack("mediator", second.page.batchId!)).rejects.toMatchObject({ code: 1, stderr: "Consensus Room returned HTTP 409\n" });
    expect((await batch("mediator", 50_000)).page.batchId).toBe(smaller.page.batchId);
    received.push(...smaller.page.changes); await ack("mediator", smaller.page.batchId!);

    // 중간에 멈추고 새 세션으로 요청하면 처음부터 받는다 — 다른 세션의 진행 위치를 이어받지 않는다.
    const other = await batch("second", 50_000);
    expect(other.page.changes.map(change => change.id)).toEqual(["a-small"]);
    await ack("second", other.page.batchId!);
    expect((await batch("second", 50_000)).page.changes[0]).toMatchObject({ id: "b-big", range: { offset: 0 } });

    const consumer = JSON.stringify(["t", 1, "mediator"]);
    let pages = 2;
    for (let round = 0; round < 40; round++) {
      const next = await batch("mediator", 50_000);
      if (next.page.batchId === null) { expect(next.page.changes).toEqual([]); break; }
      pages++;
      const last = next.page.changes.find(change => change.id === "b-big" && change.range?.end === change.range?.total);
      if (last) {
        // 끝 구간을 ack 하기 전에는 그 단위의 완료 영수증이 없고, 진행 위치만 이 구간의 시작에 있다.
        expect(raw.prepare("SELECT unit_id FROM evidence_mediator_unit_receipts WHERE consumer=? AND unit_id='b-big'").all(consumer)).toEqual([]);
        expect(raw.prepare("SELECT next_offset FROM evidence_mediator_progress WHERE consumer=? AND unit_id='b-big'").all(consumer))
          .toEqual([{ next_offset: last.range!.offset }]);
      }
      received.push(...next.page.changes); await ack("mediator", next.page.batchId!);
    }
    expect(pages).toBeGreaterThan(4);
    expect(raw.prepare("SELECT unit_id FROM evidence_mediator_unit_receipts WHERE consumer=? ORDER BY unit_id").all(consumer).map(row => row.unit_id))
      .toEqual(["a-small", "b-big", "c-small"]);
    const segments = received.filter(change => change.id === "b-big");
    expect(segments.length).toBeGreaterThan(4);
    let offset = 0;
    for (const segment of segments) {
      expect(segment.range!.offset).toBe(offset); offset = segment.range!.end;
      expect(/^[\uDC00-\uDFFF]/.test(segment.content) || /[\uD800-\uDBFF]$/.test(segment.content)).toBe(false);
    }
    expect(segments.map(segment => segment.content).join("")).toBe(big);
    expect(received.filter(change => change.id !== "b-big").map(change => [change.id, change.content])).toEqual([["a-small", "first small"], ["c-small", "last small"]]);
    expect(fetch).not.toHaveBeenCalled();
  } finally { raw.close(); await app.close(); dbs.splice(dbs.indexOf(database), 1); }
});

// ROOT-E3-01: 전달할 것이 없다는 응답(batchId:null)도 쪽이다. 모든 내용을 받은 뒤의 마지막 응답과 원문 없는 주제도 요청한 pageBytes 안에서만
// 200 이고, 들어가지 않으면 최소 바이트 안내와 함께 409 다. 크기는 HTTP 가 실제로 보내는 본문(currentDigest·superseded 포함)으로 잰다.
it("마지막 응답과 원문 없는 주제의 batchId:null 응답도 요청한 쪽 크기 안에서만 돌려주고, 넘치면 최소 바이트와 함께 409 다", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-final-page-")); roots.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite")); dbs.push(database);
  const base = { repositoryPath: root, worktreePath: root, baseRef: "main", branchName: "work", state: "AWAITING_USER_APPROVAL" as const, scopeGeneration: 1,
    planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null };
  const topic = database.createTopic({ ...base, id: "t", slug: "t", title: "Final page" });
  database.createTopic({ ...base, id: "empty", slug: "empty", title: "No evidence", worktreePath: join(root, "empty") });
  const source = database.evidence.register(topic.id, { url: "https://team.atlassian.net/browse/APP-3", label: "Small", mode: "rest", intervalSeconds: 300 });
  database.evidence.ingest(source.id, { checkId: database.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [{ id: "issue", kind: "issue", content: "small body" }] });
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: vi.fn(async () => { throw new Error("unused"); }), resumeTurn: vi.fn(async () => { throw new Error("unused"); }) };
  const fetch = vi.fn(async () => ({ revision: "unused", units: [] }));
  const config = loadConfig({ repositoryPath: root, dataDirectory: root, webDirectory: join(root, "no-web"), memoryDirectory: join(root, "memory"),
    launchToken: "test-token", enforceBudgets: false });
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const app = await buildApp({ config, database, runner, claude: adapter, codex: { ...adapter, role: "codex" }, evidenceConnector: { configured: () => true, fetch } });
  try {
    const mediator = { "x-consensus-token": "test-token", "x-consensus-actor": "mediator" };
    const batch = (topicId: string, pageBytes: number) => app.inject({ method: "POST", url: `/api/topics/${topicId}/evidence/mediator/batch`, headers: mediator,
      payload: { sessionId: "mediator", pageBytes } });
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    const launch = join(root, "bridge.url"); writeFileSync(launch, `${address}/?token=test-token`, { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launch, ...args]);
    const first = JSON.parse((await cli("batch", "--id", "t", "--session", "mediator", "--page-bytes", "50000")).stdout);
    expect(first.changes.map((change: { id: string }) => change.id)).toEqual(["issue"]);
    await cli("ack", "--id", "t", "--session", "mediator", "--batch", first.batchId);
    for (const topicId of ["t", "empty"]) {
      const refused = await batch(topicId, 1);
      expect(refused.statusCode, topicId).toBe(409);
      const minimum = Number(/최소 (\d+)B/.exec(refused.json().error)?.[1]);
      expect(minimum, topicId).toBeGreaterThan(1);
      // 패킷만 재면 이 크기에 들어간다 — 응답 본문(currentDigest·superseded 포함)은 들어가지 않는다.
      expect((await batch(topicId, minimum - 1)).statusCode, topicId).toBe(409);
      const fitted = await batch(topicId, minimum);
      expect(fitted.statusCode, topicId).toBe(200);
      expect(fitted.json(), topicId).toMatchObject({ batchId: null, changes: [], remaining: 0, nextCursor: null });
      expect(Buffer.byteLength(fitted.body), topicId).toBeLessThanOrEqual(minimum);
      expect((await batch(topicId, minimum)).body, topicId).toBe(fitted.body);
      await expect(cli("batch", "--id", topicId, "--session", "mediator", "--page-bytes", "1"), topicId)
        .rejects.toMatchObject({ code: 1, stderr: "Consensus Room returned HTTP 409\n" });
      expect((await cli("batch", "--id", topicId, "--session", "mediator", "--page-bytes", String(minimum))).stdout, topicId).toBe(`${fitted.body}\n`);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { await app.close(); dbs.splice(dbs.indexOf(database), 1); }
});

it("only users approve roots, stale or running selections preserve the active source set, and closed history remains editable for future use", async () => {
  const f=fixture(); const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"}});
  const headers={"x-consensus-token":"test-token"}, mediator={...headers,"x-consensus-actor":"mediator"};
  const route=`/api/topics/${f.topic.id}/evidence`;
  const proposal=await app.inject({method:"POST",url:`${route}/roots`,headers:mediator,payload:{url:"https://team.atlassian.net/browse/APP-2",label:"Root",scope:"group",mode:"rest",intervalSeconds:900}});
  expect(proposal.statusCode).toBe(200);expect(proposal.json().status).toBe("proposed");
  let catalog=(await app.inject({method:"GET",url:`${route}/catalog`,headers})).json();
  const selection={version:catalog.version,rootId:proposal.json().id,action:"approve"};
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers:mediator,payload:selection})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:selection})).statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:{...selection,action:"remove"}})).statusCode).toBe(409);
  catalog=(await app.inject({method:"GET",url:`${route}/catalog`,headers})).json();
  f.database.startAction({id:"busy",topicId:f.topic.id,kind:"test",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:{...selection,version:catalog.version,action:"remove"}})).statusCode).toBeGreaterThanOrEqual(400);
  expect(f.database.evidence.catalog.version(f.topic.id)).toBe(catalog.version);
  f.database.finishAction("busy","succeeded"); f.database.updateTopic(f.topic.id,{state:"CLOSED"});
  const closed=f.database.getTopic(f.topic.id);
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:{...selection,version:catalog.version,action:"remove"}})).statusCode).toBe(200);
  expect(f.database.getTopic(f.topic.id)).toEqual(closed);
  await app.close();dbs.splice(dbs.indexOf(f.database),1);
});


it("frozen HTTP and mediator readers return the committed body after shared updates and expiration", async () => {
  const f=fixture();f.database.updateTopic("t",{state:"READY_TO_DELIVER",committedOID:"b".repeat(40)});
  const before=f.database.evidence.topic(f.database.getTopic("t"));f.ingest("new unapproved source");
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const fetch=vi.fn(async()=>{throw Error("Frozen evidence must not refetch");});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"},evidenceConnector:{configured:()=>false,fetch}});
  const headers={"x-consensus-token":"test-token"};
  try {
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+3_600_000);
    const search=await app.inject({method:"POST",url:"/api/topics/t/evidence/search",headers,payload:{query:"initial"}});
    expect(search.json().total).toBe(1);const hit=search.json().hits[0];
    const read=await app.inject({method:"POST",url:"/api/topics/t/evidence/read",headers,payload:{sourceId:hit.sourceId,unitId:hit.unitId,hash:hit.hash}});
    expect(read.json().content).toBe("initial");
    const batch=await app.inject({method:"POST",url:"/api/topics/t/evidence/mediator/batch",headers:{...headers,"x-consensus-actor":"mediator"},payload:{sessionId:"frozen"}});
    expect(batch.statusCode).toBe(200);expect(batch.json().digest).toBe(before.digest);
    expect(batch.json().changes[0].content).toBe("initial");expect(fetch).not.toHaveBeenCalled();
  } finally {await app.close();dbs.splice(dbs.indexOf(f.database),1);}
});

it.each([false,true])("legacy committed evidence migrates without permanently freezing expiration or re-review: %s",(changed)=>{
  const f=fixture();if(changed)f.ingest("changed before migration");const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+3_600_000);
  const raw=new DatabaseSync(join(f.root,"room.sqlite"));
  try {raw.prepare("UPDATE topics SET committed_oid=?,state='READY_TO_DELIVER' WHERE id='t'").run("b".repeat(40));} finally {raw.close();}
  f.database.evidence.freezeFinalized();
  const topic=f.database.getTopic("t"),state=f.database.evidence.topic(topic);
  expect(state).toMatchObject({ready:true,reviewed:!changed});
  if(changed)f.database.evidence.review(topic,state.digest,"Explicitly rechecked migrated body",topic);
  expect(()=>f.database.evidence.assertReady(topic)).not.toThrow();
});

it.each([false,true])("frozen corpus uses committed hashes with an existing index: %s",async(existingIndex)=>{
  const f=fixture();f.database.evidence.catalog.add("t",{...sourceInput,scope:"topic",required:false},true);
  f.database.updateTopic("t",{planSHA256:"a".repeat(64),state:"READY_TO_DELIVER"});
  const topic=f.database.getTopic("t"),before=f.database.evidence.topic(topic);
  f.database.evidence.review(topic,before.digest,"Original body checked",topic);
  f.database.updateTopic("t",{committedOID:"b".repeat(40)});
  const adapter=withEvidence(f.adapter,f.database,join(f.root,"images"));
  if(existingIndex)await adapter.createSession({cwd:f.root,prompt:"Review"});
  f.ingest("unapproved v2");
  await adapter.createSession({cwd:f.root,prompt:"Review"});
  const index=readFileSync(join(f.root,"images","corpus","t",before.digest,"index.jsonl"),"utf8");
  const entries=index.split("\n").map(line=>JSON.parse(line));
  expect(entries).toHaveLength(1);expect(JSON.parse(readFileSync(entries[0].path,"utf8")).content).toBe("initial");
});
