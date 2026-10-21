import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp, listenReady } from "../src/server/app";
import { request as httpRequest } from "node:http";
import { ProcessSupervisor, systemProcessControl } from "../src/server/processSupervisor";
import { acquireServerOwnership } from "../src/server/serverOwnership";
import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { TopicActivitySchema } from "../src/shared/contracts";
import { hashPlan } from "../src/shared/workflow";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, CommandRunner } from "../src/server/types";

const temporaryDirectories: string[] = [];

it("owns a data directory exclusively across server instances and releases it without deleting a lock file", () => {
  const root = mkdtempSync(join(tmpdir(), "server-ownership-")); temporaryDirectories.push(root);
  const release = acquireServerOwnership(root);
  try { expect(() => acquireServerOwnership(root)).toThrow(); }
  finally { release(); }
  const next = acquireServerOwnership(root); next(); next();
});

it("refuses a live pre-lease server registry before recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "server-ownership-")); temporaryDirectories.push(root);
  writeFileSync(join(root, "server-process.json"), JSON.stringify({ pid: process.pid, ...systemProcessControl.inspect(process.pid) }));
  expect(() => acquireServerOwnership(root)).toThrow("이미 실행 중");
  // Unverifiable legacy owners fail closed rather than being taken over.
  writeFileSync(join(root, "server-process.json"), "{}");
  expect(() => acquireServerOwnership(root)).toThrow("소유 기록");
});

it("gates requests until recovery finishes and propagates startup failure", async () => {
  const { app, database } = await makeApp();
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const recover = vi.spyOn(ProcessSupervisor.prototype, "recover").mockImplementation(async () => { entered(); await barrier; });
  const fail = vi.spyOn(database, "recoverInterruptedActions").mockImplementation(() => { throw new Error("recovery failed"); });
  const listen = listenReady(app, { host: "127.0.0.1", port: 0 });
  const assertion = expect(listen).rejects.toThrow("recovery failed");
  try {
    await started;
    for (const url of ["/api/health", "/api/topics"]) {
      const response = await app.inject({ url: `${url}?token=launch-token-for-test` });
      expect(response.statusCode).toBe(503);
      expect(response.json().ok).toBe(false);
    }
    release(); await assertion;
    expect(app.server.listening).toBe(false);
  } finally { release(); recover.mockRestore(); fail.mockRestore(); await app.close(); }
});

it("ends open SSE responses before waiting for HTTP close", async () => {
  const { app, database } = await makeApp(); draftTopic(database, "stream-topic");
  const address = await listenReady(app, { host: "127.0.0.1", port: 0 });
  const response = await new Promise<import("node:http").IncomingMessage>((resolve, reject) => {
    const request = httpRequest(`${address}/api/topics/stream-topic/events`, { headers: { "x-consensus-token": "launch-token-for-test" } }, resolve);
    request.on("error", reject); request.end();
  });
  response.resume();
  try { await app.close(); expect(app.server.listening).toBe(false); }
  finally { response.destroy(); await app.close(); }
});

// 엔진 결함 큐는 등록·조회·종결만 한다(2026-10-15 사용자 결정 "큐 수리 주체: Claude 워커로 단일화"). 수리는 master 가 Claude 작업으로 배정한다.
// 지운 자동 큐는 서버 시작 때 실행 중이던 행을 blocked 로 바꾸고, 닫힌 토픽의 todo 를 집어 git·Codex 수정·host-review·정산·합류를 돌렸다.
it("starts, registers and closes engine defects without a model call, host-review, settlement or git merge, and leaves recorded rows as they were", async () => {
  const commands: string[] = [];
  const refusing: CommandRunner = { run: async spec => { commands.push(`${spec.command} ${spec.args.join(" ")}`); throw new Error("엔진 결함 큐는 명령을 실행하지 않습니다."); } };
  const { app, database, adapterCalls } = await makeApp(refusing, undefined, { gitRepository: true });
  try {
    draftTopic(database, "engine-source");
    database.createTopic({ ...database.getTopic("engine-source"), id: "engine-done", slug: "engine-done", state: "CLOSED" });
    const todo = database.engineDefects.enqueue("engine-done", { key: "waiting", title: "Waiting defect", evidence: "Observed", workaround: "" });
    const candidate = database.engineDefects.enqueue("engine-done", { key: "candidate", title: "Kept candidate", evidence: "Observed", workaround: "" });
    database.engineDefects.save({ ...candidate, status: "blocked", error: "host-review 실패", base: "a".repeat(40), head: "b".repeat(40),
      worktree: "/kept/engine-defect-candidate", review: { status: "blocked" }, waiting: "예산 대기", budgetAccounts: ["engine-done", "engine-defects"],
      reviewExecutionId: "old-review" });
    const executing = database.engineDefects.enqueue("engine-done", { key: "executing", title: "Interrupted run", evidence: "Observed", workaround: "" });
    database.engineDefects.save({ ...executing, status: "executing", actionId: "old-run", base: "a".repeat(40) });
    // The candidate's review execution is still open: the removed queue settled it through host-review usage before any other work.
    database.budgets.start({ id: "old-review", accounts: ["engine-done", "engine-defects"], stage: "ENGINE_DEFECT_REVIEW",
      role: "codex", model: "m", effort: "xhigh", startedAt: Date.now(), dispatchStarted: true });
    const recorded = database.engineDefects.list();
    await listenReady(app, { host: "127.0.0.1", port: 0 });
    await new Promise(resolve => setTimeout(resolve, 200));
    const token = { "x-consensus-token": "launch-token-for-test" };
    const registered = await app.inject({ method: "POST", url: "/api/topics/engine-done/engine-defects", headers: { ...token, "x-consensus-actor": "mediator" },
      payload: { key: "new", title: "New defect", evidence: "Observed again", workaround: "" } });
    expect(registered.statusCode).toBe(200);
    expect(registered.json()).toMatchObject({ status: "todo" });
    expect(database.getTimeline("engine-done").at(-1)?.body).toContain("master 가 분류해 수리를 배정합니다");
    const closed = await app.inject({ method: "POST", url: `/api/engine-defects/${todo.id}/close`, headers: token,
      payload: { reason: "duplicate", representativeId: candidate.id } });
    expect(closed.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/api/engine-defects/${candidate.id}/retry`, headers: token, payload: {} })).statusCode).toBe(404);
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(commands).toEqual([]);
    expect(adapterCalls).toEqual([]);
    expect(database.budgets.execution("old-review").finished).toBe(false);
    const listed = (await app.inject({ url: "/api/engine-defects", headers: token })).json() as typeof recorded;
    expect(listed.filter(row => row.id !== todo.id && row.key !== "new")).toEqual(recorded.filter(row => row.id !== todo.id));
    expect(listed.find(row => row.id === todo.id)).toMatchObject({ status: "closed", closure: { reason: "duplicate", representativeId: candidate.id } });
  } finally { await app.close(); }
});

// engine-work.lock 은 지운 자동 큐만 만들고 갱신했다. 남은 파일이 있어도 엔진 저장소 토픽의 실행 허용을 막지 않는다.
it("a leftover engine-work.lock from the removed queue no longer refuses the engine repository", async () => {
  const { app, database, root } = await makeApp(undefined, undefined, { gitRepository: true });
  try {
    draftTopic(database, "engine-repository", { repositoryPath: root, worktreePath: root });
    writeFileSync(join(root, "engine-work.lock"), JSON.stringify({ id: "engine-fix", repository: realpathSync(join(root, ".git")) }));
    const response = await app.inject({ method: "POST", url: "/api/topics/engine-repository/actions/tool-tree-rebaseline",
      headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": "engine-repository" }, payload: { reason: "tools updated" } });
    expect(response.statusCode).toBe(200);
  } finally { await app.close(); }
});

// 구현 기준 채택(2026-10-13)은 공식 action 이다 — 라우트가 있고(404 아님), head 형식 오류는 400, 정지 상태가 아닌 토픽은 사전 검사 사유(409)로 거부한다.
it("implementation-rebaseline is an official action that validates head and refuses topics that are not interrupted", async () => {
  const { app, database } = await makeApp();
  try {
    draftTopic(database, "rebaseline-draft");
    const post = (key: string, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/topics/rebaseline-draft/actions/implementation-rebaseline",
      headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": key }, payload });
    expect((await post("bad-head", { reason: "확인", head: "abc" })).statusCode).toBe(400);
    const draft = await post("draft", { reason: "확인", head: "a".repeat(40) });
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error).toContain("정지 상태");
    expect(database.getTopic("rebaseline-draft").state).toBe("DRAFT");
  } finally { await app.close(); }
});

// 구현 기준 채택의 요청 복구 마커(정식 리뷰 F010, 2026-10-13) — 라우트가 idempotency key 를 기준 변경과 같은 transaction 의 결정 기록에 싣는다. 기준 변경 뒤 원장
// 기록 전에 서버가 죽어도(finish·fail 모두 남지 않음) 재시작 복구가 성공으로 닫고, 같은 키 재전송은 다시 실행하지 않고 복구 응답을 재생한다.
it("implementation-rebaseline records its request marker with the adopted baseline so restart recovery closes an interrupted request as succeeded", async () => {
  const { app, database, root } = await makeApp(new SpawnCommandRunner(), undefined, { gitRepository: true });
  try {
    const git = (...args: string[]) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
    git("checkout", "-qb", "consensus/rebaseline-route");
    const pinned = git("rev-parse", "HEAD");
    writeFileSync(join(root, "README.txt"), "외부\n");
    git("commit", "-qam", "외부 커밋");
    const head = git("rev-parse", "HEAD");
    draftTopic(database, "rebaseline-route", { repositoryPath: root, worktreePath: root, branchName: "consensus/rebaseline-route" });
    database.updateTopic("rebaseline-route", { state: "FAILED", resumeState: "CLAUDE_FIX", implementationBaseOID: pinned });
    const post = () => app.inject({ method: "POST", url: "/api/topics/rebaseline-route/actions/implementation-rebaseline",
      headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": "rebaseline-key" }, payload: { reason: "외부 커밋을 확인했습니다.", head } });
    const finish = vi.spyOn(database, "finishActionRequest").mockImplementation(() => { throw new Error("서버 종료"); });
    const fail = vi.spyOn(database, "failActionRequest").mockImplementation(() => { throw new Error("서버 종료"); });
    try { expect((await post()).statusCode).toBe(500); } finally { finish.mockRestore(); fail.mockRestore(); }
    expect(database.getFlags("rebaseline-route").implementationBaseOID).toBe(head);
    expect(database.getActionRequest("rebaseline-route", "implementation-rebaseline", "rebaseline-key")?.status).toBe("running");
    database.recoverInterruptedNonDeliveryRequests();
    expect(database.getActionRequest("rebaseline-route", "implementation-rebaseline", "rebaseline-key")?.status).toBe("succeeded");
    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ recovered: true });
    expect(database.getTimeline("rebaseline-route").filter((event) => event.payload?.implementationRebaseline)).toHaveLength(1);
  } finally { await app.close(); }
});

// 계획 왕복 1회 보류(자문 17)는 공식 위임 action 이다 — 본문 형식 오류는 400, 계획 왕복 밖·범위 세대·계획 epoch 불일치는 409 로 거부하고 아무것도 남기지 않는다.
// 받으면 실행을 시작하지 않고 요청 하나만 남긴다. 같은 키 재전송은 저장 응답을 재생하고, 새 키의 중복 요청은 같은 대기 요청을 돌려준다.
it("planning-hold is a delegated action bound to the scope generation and plan epoch that records one pending request without starting work", async () => {
  const { app, database } = await makeApp();
  try {
    draftTopic(database, "planning-hold");
    const post = (key: string, payload: Record<string, unknown>, actor?: string) => app.inject({ method: "POST", url: "/api/topics/planning-hold/actions/planning-hold",
      headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": key, ...(actor ? { "x-consensus-actor": actor } : {}) }, payload });
    const input = { reason: "결정문을 넣고 잇는다", expectedScopeGeneration: 1, expectedPlanEpoch: 1 };
    const requests = () => database.getTimeline("planning-hold").filter((event) => typeof (event.payload?.planningHold as { request?: unknown } | undefined)?.request === "string");
    expect((await post("missing-epoch", { reason: "확인", expectedScopeGeneration: 1 })).statusCode).toBe(400);
    const draft = await post("draft", input);
    expect(draft.statusCode).toBe(409);
    expect(draft.json().error).toContain("계획 왕복 중이 아닙니다");

    database.updateTopic("planning-hold", { state: "USER_DECISION_REQUIRED", resumeState: "CLAUDE_REVISION" });
    const stale = await post("stale-generation", { ...input, expectedScopeGeneration: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toContain("범위 세대가 다릅니다");
    expect((await post("stale-epoch", { ...input, expectedPlanEpoch: 2 })).statusCode).toBe(409);
    expect(requests()).toHaveLength(0);

    const accepted = await post("hold", input, "mediator");
    expect(accepted.statusCode).toBe(200);
    const hold = accepted.json().hold;
    expect(hold).toMatchObject({ alreadyPending: false, scopeGeneration: 1, planEpoch: 1, state: "USER_DECISION_REQUIRED", stage: "CLAUDE_REVISION", running: false });
    expect(database.getTopic("planning-hold").state).toBe("USER_DECISION_REQUIRED");
    expect(requests()).toHaveLength(1);
    expect(requests()[0].payload).toMatchObject({ requestKey: "hold", requestAction: "planning-hold", origin: expect.anything() });
    const replay = await post("hold", input, "mediator");
    expect(replay.statusCode).toBe(200);
    expect(replay.json().hold).toEqual(hold);
    const duplicate = await post("hold-again", input);
    expect(duplicate.json().hold).toMatchObject({ alreadyPending: true, requestId: hold.requestId, sequence: hold.sequence });
    expect(requests()).toHaveLength(1);
  } finally { await app.close(); }
});

// 계획 보류의 요청 복구 마커 — 라우트가 idempotency key 를 요청 기록과 같은 insert 에 싣는다. 원장 기록 전에 서버가 죽어도 재시작 복구가 성공으로 닫고,
// 같은 키 재전송은 다시 실행하지 않고 복구 응답을 재생한다(요청이 두 번 남지 않는다).
it("planning-hold records its request marker with the hold so restart recovery closes an interrupted request as succeeded", async () => {
  const { app, database } = await makeApp();
  try {
    draftTopic(database, "planning-hold-route");
    database.updateTopic("planning-hold-route", { state: "FAILED", resumeState: "CODEX_AUDIT" });
    const post = () => app.inject({ method: "POST", url: "/api/topics/planning-hold-route/actions/planning-hold",
      headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": "hold-key" },
      payload: { reason: "감사 결과를 보고 결정한다", expectedScopeGeneration: 1, expectedPlanEpoch: 1 } });
    const finish = vi.spyOn(database, "finishActionRequest").mockImplementation(() => { throw new Error("서버 종료"); });
    const fail = vi.spyOn(database, "failActionRequest").mockImplementation(() => { throw new Error("서버 종료"); });
    try { expect((await post()).statusCode).toBe(500); } finally { finish.mockRestore(); fail.mockRestore(); }
    expect(database.getActionRequest("planning-hold-route", "planning-hold", "hold-key")?.status).toBe("running");
    database.recoverInterruptedNonDeliveryRequests();
    expect(database.getActionRequest("planning-hold-route", "planning-hold", "hold-key")?.status).toBe("succeeded");
    const replay = await post();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ recovered: true });
    expect(database.getTimeline("planning-hold-route").filter((event) => typeof (event.payload?.planningHold as { request?: unknown } | undefined)?.request === "string")).toHaveLength(1);
  } finally { await app.close(); }
});

it("records mediator engine defect To-dos without a delegation file while retaining authentication", async () => {
  const { app, database } = await makeApp();
  draftTopic(database, "engine-report");
  const url = "/api/topics/engine-report/engine-defects";
  const payload = { key: "observed", title: "Engine error", evidence: "Observed failure", workaround: "Continue topic" };
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
  const result = await app.inject({ method: "POST", url, payload,
    headers: { "x-consensus-token": "launch-token-for-test", "x-consensus-actor": "mediator" } });
  expect(result.statusCode).toBe(200);
  expect(database.engineDefects.list("engine-report")).toHaveLength(1);
  expect(database.getTopic("engine-report").state).toBe("DRAFT");
  await app.close();
});

it("closes an engine defect only for the user: a mediator is refused and nothing changes", async () => {
  const { app, database } = await makeApp();
  draftTopic(database, "engine-report");
  const representative = database.engineDefects.enqueue("engine-report", { key: "first", title: "Engine error", evidence: "Observed", workaround: "" });
  const target = database.engineDefects.enqueue("engine-report", { key: "again", title: "Engine error again", evidence: "Observed again", workaround: "" });
  const url = `/api/engine-defects/${target.id}/close`;
  const payload = { reason: "duplicate", representativeId: representative.id };
  const token = { "x-consensus-token": "launch-token-for-test" };
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
  // The mediator reports defects; closing one takes it out of the queue for good, so only the user may.
  const mediator = await app.inject({ method: "POST", url, payload, headers: { ...token, "x-consensus-actor": "mediator" } });
  expect(mediator.statusCode).toBe(403);
  // A body whose fields do not match its reason is refused.
  expect((await app.inject({ method: "POST", url, payload: { ...payload, commit: "abc1234" }, headers: token })).statusCode).toBe(400);
  expect(database.engineDefects.get(target.id)).toEqual(target);
  expect(database.getTimeline("engine-report").filter(event => event.body.startsWith("엔진 결함 종결"))).toHaveLength(0);
  const user = await app.inject({ method: "POST", url, payload, headers: token });
  expect(user.statusCode).toBe(200);
  expect(user.json()).toMatchObject({ status: "closed", closure: { reason: "duplicate", representativeId: representative.id, actor: "user" } });
  expect(database.getTimeline("engine-report").filter(event => event.body.startsWith("엔진 결함 종결"))).toHaveLength(1);
  await app.close();
});

it("closes an engine defect as not needing an engine repair only for the user, with its kind, finding, basis and source", async () => {
  const { app, database } = await makeApp();
  draftTopic(database, "engine-report");
  const target = database.engineDefects.enqueue("engine-report", { key: "outside", title: "App simulator error", evidence: "Observed", workaround: "" });
  const url = `/api/engine-defects/${target.id}/close`;
  const payload = { reason: "not_applicable", kind: "not_engine", finding: "The app checkout's simulator failed, not the engine.",
    basis: "triage.md 2", decidedBy: "CR Engine Advisor 자문 36 §2" };
  const token = { "x-consensus-token": "launch-token-for-test" };
  const closures = () => database.getTimeline("engine-report").filter(event => event.body.startsWith("엔진 결함 종결"));
  expect((await app.inject({ method: "POST", url, payload })).statusCode).toBe(401);
  expect((await app.inject({ method: "POST", url, payload, headers: { ...token, "x-consensus-actor": "mediator" } })).statusCode).toBe(403);
  // The judgment needs its basis, and a cause not yet confirmed has no kind.
  const { basis: _basis, ...withoutBasis } = payload;
  expect((await app.inject({ method: "POST", url, payload: withoutBasis, headers: token })).statusCode).toBe(400);
  expect((await app.inject({ method: "POST", url, payload: { ...payload, kind: "cause_unknown" }, headers: token })).statusCode).toBe(400);
  expect(database.engineDefects.get(target.id)).toEqual(target);
  expect(closures()).toHaveLength(0);
  const user = await app.inject({ method: "POST", url, payload, headers: token });
  expect(user.statusCode).toBe(200);
  expect(user.json()).toMatchObject({ status: "closed", title: target.title, evidence: target.evidence,
    closure: { ...payload, actor: "user" } });
  expect(closures()).toHaveLength(1);
  expect(closures()[0].body).toContain("비수리 종결(not_engine)");
  await app.close();
});

it("requires authentication and an idempotency key to opt an idle topic into controlled planning", async () => {
  const { app, database } = await makeApp();
  draftTopic(database, "planning-topic");
  const url = "/api/topics/planning-topic/planning-control";
  expect(database.planning.policyVersion("planning-topic")).toBe(0);
  expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
  const headers = { "x-consensus-token": "launch-token-for-test" };
  expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(400);
  const request = { method: "POST" as const, url, headers: { ...headers, "idempotency-key": "enable-once" } };
  const first = await app.inject(request);
  expect(first.statusCode).toBe(200);
  expect(first.json().version).toBe(2);
  expect((await app.inject(request)).json()).toEqual(first.json());
  expect(database.planning.policyVersion("planning-topic")).toBeGreaterThan(0);
  await app.close();
});

it("enabling planning after approval does not impose a new session contract", async () => {
  const { app, database } = await makeApp();
  draftTopic(database, "approved-topic");
  database.updateTopic("approved-topic", { state: "AWAITING_USER_APPROVAL", planSHA256: "a".repeat(64) });
  const response = await app.inject({ method: "POST", url: "/api/topics/approved-topic/planning-control",
    headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": "late-enable" } });
  expect(response.statusCode).toBe(200);
  expect(response.json().version).toBe(1);
  expect(database.planning.continuityEnabled("approved-topic")).toBe(false);
  await app.close();
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

// gitRepository: 저장소 경로(root)를 실제 git 저장소로 만든다 — 계획 제어(v2) 턴은 작업 트리 스냅숏(writeWorkingTree)에 실제 git 이 필요하다.
async function makeApp(runner?: CommandRunner, validateSession: () => Promise<boolean> = async () => false, options: { gitRepository?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-app-"));
  temporaryDirectories.push(root);
  if (options.gitRepository) {
    execFileSync("git", ["init", "-q", root]);
    for (const [key, value] of [["user.name", "App Test"], ["user.email", "app-test@example.invalid"]]) execFileSync("git", ["-C", root, "config", key, value]);
    writeFileSync(join(root, "README.txt"), "기준\n");
    execFileSync("git", ["-C", root, "add", "README.txt"]);
    execFileSync("git", ["-C", root, "commit", "-qm", "baseline"]);
  }
  const unavailableRunner: CommandRunner = {
    run: async () => { throw new Error("이 테스트에서는 명령을 실행하지 않습니다."); },
  };
  const adapterCalls:string[]=[];
  let resolveAdapterCall!: (role: string) => void;
  const adapterCalled = new Promise<string>(resolve => { resolveAdapterCall = resolve; });
  // 가짜는 프로세스를 띄운 뒤 실패한 호출을 흉내 낸다(onProcessSpawn) — 띄우지 않은 호출은 예약이 해제되므로 집계 테스트의 전제가 달라진다(PLAN §2 검증 조건 1).
  const fakeSpawn = (turn: { onProcessSpawn?: (process: { pid: number; pgid: number; executable: string; commandLine: string; startedAt: string }) => void }) =>
    turn.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });
  // 운영 라우팅은 봉투 턴(createEnvelopeSession·resumeEnvelopeTurn)으로 간다(⑥) — 옛 결과 메서드와 같은 실패 흉내를 봉투 메서드에도 둔다.
  const failCall = (role: "claude" | "codex", turn: Parameters<typeof fakeSpawn>[0]): never => {
    adapterCalls.push(role); resolveAdapterCall(role); fakeSpawn(turn); throw new Error("이 테스트에서는 CLI를 실행하지 않습니다.");
  };
  const adapter = (role: "claude" | "codex"): AgentAdapter => ({
    role,
    createSession: async (turn) => failCall(role, turn),
    resumeTurn: async (turn) => failCall(role, turn),
    createEnvelopeSession: async (turn) => failCall(role, turn),
    resumeEnvelopeTurn: async (turn) => failCall(role, turn),
    validateExistingSession: validateSession,
  });
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  const config = {
    host: "127.0.0.1" as const,
    port: 0,
    launchToken: "launch-token-for-test",
    dataDirectory: root,
    topicsDirectory: join(root, "topics"),
    worktreesDirectory: join(root, "worktrees"),
    databasePath: join(root, "room.sqlite"),
    webDirectory: join(root, "missing-web"),
    repositoryPath: root,
    memoryDirectory: join(root, "memory"),
    claudeSkillDirectories: [],
    codexSkillDirectories: [],
    defaultAgentSettings: {
      claude: { model: "opus", effort: "xhigh" as const },
      codex: { model: "gpt-5.6-sol", effort: "xhigh" as const },
    },
    figmaMcpUrl: null,
    codexConcurrency: 2,
  };
  const app = await buildApp({
    config,
    database,
    runner: runner ?? unavailableRunner,
    claude: adapter("claude"),
    codex: adapter("codex"),
  });
  return { app, database, root, adapterCalls, adapterCalled };
}

// 실제 git 에 위임하면서 worktree 생성 명령만 센다 — 작업 묶음 새 단계 토픽은 계획 제어 v2 라(E4 2차 보완 F012) 계획 턴이 실제 작업 트리 스냅숏을 만든다.
function countingRealGitRunner(): { runner: CommandRunner; worktreeAdds: string[] } {
  const inner = new SpawnCommandRunner();
  const worktreeAdds: string[] = [];
  return { worktreeAdds, runner: { run: async (spec) => {
    if (spec.args[0] === "worktree" && spec.args[1] === "add") worktreeAdds.push(spec.args.join(" "));
    return inner.run(spec);
  } } };
}

// worktree 생성 명령만 세는 가짜 git. 실제 저장소 없이 "몇 번 만들었는지"를 관측한다.
function countingGitRunner(): { runner: CommandRunner; worktreeAdds: string[] } {
  const worktreeAdds: string[] = [];
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", jsonLines: [] });
  const runner: CommandRunner = {
    run: async ({ args, cwd }) => {
      const joined = args.join(" ");
      if (joined === "rev-parse HEAD") return ok("a".repeat(40));
      if (joined === "rev-parse --show-toplevel") return ok(cwd);
      if (joined === "config --path --get core.hooksPath") return { exitCode: 1, stdout: "", stderr: "", jsonLines: [] };
      if (joined === "rev-parse --path-format=absolute --git-common-dir") return ok(join(cwd, ".git"));
      if (args[0] === "worktree" && args[1] === "add") {
        worktreeAdds.push(String(args[3]));
        return ok("");
      }
      throw new Error(`이 테스트에서 예상하지 않은 git 명령입니다: ${joined}`);
    },
  };
  return { runner, worktreeAdds };
}

function draftTopic(
  database: ConsensusDatabase,
  id: string,
  changes: Partial<{ repositoryPath: string; worktreePath: string; branchName: string | null }> = {},
) {
  database.createTopic({
    workflowMode: "planned",
    id,
    slug: "idempotency",
    title: "중복 요청",
    repositoryPath: changes.repositoryPath ?? "/tmp/repository",
    baseRef: "develop",
    worktreePath: changes.worktreePath ?? "/tmp/worktree",
    branchName: changes.branchName ?? null,
    state: "DRAFT",
    scopeGeneration: 1,
    planRevision: 0,
    planSHA256: null,
    approvedPlanSHA256: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    lastError: null,
  });
  for(const scope of ["planning","implementation"] as const) database.reviews.configure(id,scope,3,database.reviews.account(id,scope).version);
}

describe("로컬 API 접속 토큰", () => {
  it("브라우저가 접속 토큰 없이 API를 요청하면 내용을 보여 주지 않는다", async () => {
    const { app } = await makeApp();

    const response = await app.inject({ method: "GET", url: "/api/health" });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toEqual({ error: "인증 토큰이 필요합니다." });
    await app.close();
  });

  it("브라우저가 고정 저장소와 새 주제 기본 모델 설정을 읽을 수 있다", async () => {
    const { app, root } = await makeApp();

    const response = await app.inject({
      method: "GET",
      url: "/api/config",
      headers: { "x-consensus-token": "launch-token-for-test" },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      repositoryPath: root,
      defaultAgentSettings: {
        claude: { model: "opus", effort: "xhigh" },
        codex: { model: "gpt-5.6-sol", effort: "xhigh" },
      },
    });
    await app.close();
  });

  it("일회성 URL 토큰을 확인하면 HttpOnly 쿠키를 발급하고 같은 브라우저 요청을 허용한다", async () => {
    const { app } = await makeApp();

    const first = await app.inject({
      method: "GET",
      url: "/api/health?token=launch-token-for-test",
    });
    const cookie = first.cookies.find((value) => value.name === "consensus_room_token");
    const second = await app.inject({
      method: "GET",
      url: "/api/health",
      cookies: { consensus_room_token: cookie?.value ?? "" },
    });

    expect(first.statusCode).toBe(200);
    expect(cookie).toMatchObject({
      value: "launch-token-for-test",
      httpOnly: true,
      sameSite: "Strict",
      path: "/",
    });
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual({ ok: true });
    await app.close();
  });

  it("브라우저 시작 URL의 토큰은 HttpOnly 쿠키로 바꾼 뒤 주소에서 지운다", async () => {
    const { app } = await makeApp();

    const response = await app.inject({
      method: "GET",
      url: "/?token=launch-token-for-test",
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe("/");
    expect(response.cookies).toContainEqual(expect.objectContaining({
      name: "consensus_room_token",
      httpOnly: true,
      sameSite: "Strict",
    }));
    await app.close();
  });
});

describe("HTTP idempotency", () => {
  it("주제를 만들 때 요청 본문의 경로를 무시하고 서버에 고정한 sample-ios 저장소만 사용한다", async () => {
    const { runner, worktreeAdds } = countingGitRunner();
    const { app, root, database } = await makeApp(runner);
    const unrelated = mkdtempSync(join(tmpdir(), "consensus-room-unrelated-"));
    temporaryDirectories.push(unrelated);

    const response = await app.inject({
      method: "POST",
      url: "/api/topics",
      headers: {
        "x-consensus-token": "launch-token-for-test",
        "idempotency-key": "fixed-repository",
      },
      payload: { title: "고정 저장소", repositoryPath: unrelated, baseRef: "develop" },
    });

    expect(response.statusCode).toBe(201);
    expect(database.listTopics()[0].repositoryPath).toBe(root);
    expect(worktreeAdds).toHaveLength(1);
    await app.close();
  });

  it("같은 성공 요청 키를 다시 보내면 저장한 응답을 돌려주고 결정 이벤트를 한 번만 기록한다", async () => {
    const { app, database, root } = await makeApp();
    // planned 승인 경계는 승인할 판이 항목 목록(plan-items)을 선언한 산출물이어야 받는다(2026-10-11 계약) — 승인할 판을 실제 산출물로 둔다.
    const plan = '# 계획\n\n```plan-items\n{"version":1,"items":[{"id":"R-1","requirement":"중복 승인 검사","done":"요청 두 번"}]}\n```\n';
    const planSHA256 = hashPlan(plan);
    database.createTopic({
      workflowMode: "planned",
      id: "topic-1",
      slug: "idempotency",
      title: "중복 승인",
      repositoryPath: "/tmp/repository",
      baseRef: "develop",
      worktreePath: "/tmp/worktree",
      branchName: null,
      state: "AWAITING_USER_APPROVAL",
      scopeGeneration: 1,
      planRevision: 2,
      planSHA256,
      approvedPlanSHA256: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastError: null,
    });
    for (const role of ["claude", "codex"] as const) {
      database.upsertParticipant("topic-1", {
        role,
        sessionId: `${role}-session`,
        mode: "attached",
        acknowledgedPlanSHA256: planSHA256,
      });
    }
    await new ArtifactStore(join(root, "topics"), database).write("topic-1", "plan", 2, plan);
    const request = {
      method: "POST" as const,
      url: "/api/topics/topic-1/actions/approve",
      headers: {
        "x-consensus-token": "launch-token-for-test",
        "idempotency-key": "approve-once",
      },
      payload: { planSHA256 },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(database.getTimeline("topic-1").filter((event) =>
      event.actor === "user" && event.kind === "decision",
    )).toHaveLength(1);
    await app.close();
  });

  it("주제 생성은 Idempotency-Key 없이는 받지 않는다", async () => {
    const { app, root } = await makeApp(countingGitRunner().runner);

    const response = await app.inject({
      method: "POST",
      url: "/api/topics",
      headers: { "x-consensus-token": "launch-token-for-test" },
      payload: { title: "키 없는 생성", repositoryPath: root, baseRef: "develop" },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({ error: "Idempotency-Key 헤더가 필요합니다." });
    await app.close();
  });

  it("같은 키로 주제를 두 번 만들면 저장한 201 응답을 재생하고 worktree를 한 번만 만든다", async () => {
    const { runner, worktreeAdds } = countingGitRunner();
    const { app, root, database } = await makeApp(runner);
    const request = {
      method: "POST" as const,
      url: "/api/topics",
      headers: {
        "x-consensus-token": "launch-token-for-test",
        "idempotency-key": "create-once",
      },
      payload: { title: "중복 생성 방지", repositoryPath: root, baseRef: "develop" },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect(worktreeAdds).toHaveLength(1);
    expect(database.listTopics()).toHaveLength(1);
    await app.close();
  });

  it("메시지는 Idempotency-Key 없이는 받지 않고 같은 키 재전송으로는 기록이 늘지 않는다", async () => {
    const { app, database } = await makeApp();
    draftTopic(database, "topic-1");
    const headers = { "x-consensus-token": "launch-token-for-test" };
    const payload = { kind: "note", body: "같은 근거를 다시 보냅니다." };

    const missingKey = await app.inject({ method: "POST", url: "/api/topics/topic-1/messages", headers, payload });
    const request = {
      method: "POST" as const,
      url: "/api/topics/topic-1/messages",
      headers: { ...headers, "idempotency-key": "note-once" },
      payload,
    };
    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toEqual({ error: "Idempotency-Key 헤더가 필요합니다." });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const notes = database.getTimeline("topic-1").filter((event) => event.kind === "note");
    expect(notes).toHaveLength(1);
    // 재시작 복구가 완료를 판정할 마커다. 이벤트에 키가 남지 않으면 crash 뒤 같은 키가 새 실행으로 중복된다.
    expect(notes[0].payload).toMatchObject({ requestKey: "note-once" });
    await app.close();
  });

  it("같은 키의 범위 변경은 세대를 한 번만 올리고 worktree도 하나만 만든다", async () => {
    const { runner, worktreeAdds } = countingGitRunner();
    const { app, database, root } = await makeApp(runner);
    draftTopic(database, "topic-1", {
      repositoryPath: root,
      worktreePath: join(root, "worktrees", "scope-topic"),
      branchName: "consensus/scope-topic-g1",
    });
    const post = (key: string, payload: Record<string, unknown>) => app.inject({
      method: "POST", url: "/api/topics/topic-1/messages",
      headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": key }, payload,
    });
    const body = { kind: "scope_change", body: "범위를 다시 잡습니다." };

    // 확인·기대 세대가 빠지면 원장 기록 전에 400 이다. 세대가 다르면 409 이고, 두 거부 모두 세대·작업 트리·타임라인을 바꾸지 않는다.
    for (const [key, missing] of [["no-confirm", { expectedScopeGeneration: 1 }], ["no-generation", { confirmScopeGenerationBump: true }],
      ["false-confirm", { confirmScopeGenerationBump: false, expectedScopeGeneration: 1 }]] as const) {
      const rejected = await post(key, { ...body, ...missing });
      expect(rejected.statusCode, key).toBe(400);
      expect(database.getActionRequest("topic-1", "message:scope_change", key), key).toBeNull();
    }
    const stale = await post("stale-before", { ...body, confirmScopeGenerationBump: true, expectedScopeGeneration: 2 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ code: "SCOPE_GENERATION_MISMATCH", current: 1 });
    expect(database.getTopic("topic-1")).toMatchObject({ scopeGeneration: 1, worktreePath: join(root, "worktrees", "scope-topic") });
    expect(worktreeAdds).toHaveLength(0);
    expect(database.getTimeline("topic-1").filter((event) => event.kind === "scope_change")).toEqual([]);

    const confirmed = { ...body, confirmScopeGenerationBump: true, expectedScopeGeneration: 1 };
    const first = await post("scope-once", confirmed);
    const second = await post("scope-once", confirmed);

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(database.getTopic("topic-1").scopeGeneration).toBe(2);
    expect(worktreeAdds).toHaveLength(1);
    // 같은 확인을 새 키로 다시 보내면 낡은 세대라 409 다 — 초기화를 두 번 하지 않는다.
    const retried = await post("scope-again", confirmed);
    expect(retried.statusCode).toBe(409);
    expect(retried.json()).toMatchObject({ code: "SCOPE_GENERATION_MISMATCH", current: 2 });
    expect(database.getTopic("topic-1").scopeGeneration).toBe(2);
    expect(worktreeAdds).toHaveLength(1);
    expect(database.getTimeline("topic-1").filter((event) => event.kind === "scope_change")).toHaveLength(1);
    await app.close();
  });

  it("세션 연결은 Idempotency-Key 없이는 받지 않고 같은 키 재전송으로 세션을 새로 만들지 않는다", async () => {
    const { app, database } = await makeApp();
    draftTopic(database, "topic-1");
    const headers = { "x-consensus-token": "launch-token-for-test" };
    const payload = { mode: "new" };

    const missingKey = await app.inject({
      method: "POST", url: "/api/topics/topic-1/participants/claude", headers, payload,
    });
    const request = {
      method: "POST" as const,
      url: "/api/topics/topic-1/participants/claude",
      headers: { ...headers, "idempotency-key": "attach-once" },
      payload,
    };
    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(missingKey.statusCode).toBe(400);
    expect(missingKey.json()).toEqual({ error: "Idempotency-Key 헤더가 필요합니다." });
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(database.getTopic("topic-1").participants).toHaveLength(1);
    expect(database.getTimeline("topic-1").filter((event) =>
      event.kind === "system" && event.body.startsWith("claude"),
    )).toHaveLength(1);
    await app.close();
  });

  it("연결한 세션 ID를 유지한 채 역할별 모델 설정만 바꾸고 다음 호출 적용 사실을 기록한다", async () => {
    const { app, database } = await makeApp();
    draftTopic(database, "topic-1");
    database.upsertParticipant("topic-1", {
      role: "claude",
      sessionId: "claude-session",
      mode: "attached",
      acknowledgedPlanSHA256: null,
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/topics/topic-1/participants/claude/settings",
      headers: {
        "x-consensus-token": "launch-token-for-test",
        "idempotency-key": "claude-settings-once",
      },
      payload: { model: "sonnet", effort: "high" },
    });

    expect(response.statusCode).toBe(200);
    expect(database.getTopic("topic-1")).toMatchObject({
      agentSettings: { claude: { model: "sonnet", effort: "high" } },
      participants: [{ role: "claude", sessionId: "claude-session" }],
    });
    expect(database.getTimeline("topic-1").at(-1)).toMatchObject({
      actor: "system",
      kind: "system",
      body: expect.stringContaining("다음 Claude 호출부터 적용"),
      payload: {
        role: "claude",
        model: "sonnet",
        effort: "high",
        requestKey: "claude-settings-once",
      },
    });
    await app.close();
  });
});


// 감사 부차 지적: 같은 키를 다른 본문에 재사용해도 예전 응답을 재생했다 — 클라이언트 버그가
// 조용히 엉뚱한 결과를 받는다. 이제 본문이 다르면 409로 드러난다.
describe("멱등 키 본문 재사용", () => {
  it("같은 키가 다른 본문으로 오면 저장된 응답을 재생하지 않고 409를 돌려준다", async () => {
    const gitFake: CommandRunner = {
      run: async (spec) => {
        if (spec.args[0] === "config") return { exitCode: 1, stdout: "", stderr: "", jsonLines: [] };
        return { exitCode: 0, stdout: "/tmp/no-such-git-dir\n", stderr: "", jsonLines: [] };
      },
    };
    const { app } = await makeApp(gitFake);
    const cookies = { consensus_room_token: "launch-token-for-test" };

    const first = await app.inject({
      method: "POST", url: "/api/topics", cookies,
      headers: { "idempotency-key": "reuse-1" },
      payload: { title: "원래 주제", baseRef: "HEAD" },
    });
    expect(first.statusCode).toBe(201);

    const different = await app.inject({
      method: "POST", url: "/api/topics", cookies,
      headers: { "idempotency-key": "reuse-1" },
      payload: { title: "다른 주제", baseRef: "HEAD" },
    });
    expect(different.statusCode).toBe(409);
    expect(different.json().error).toContain("다른 요청 본문");

    // 같은 본문 재전송은 여전히 201 재생이어야 한다.
    const replay = await app.inject({
      method: "POST", url: "/api/topics", cookies,
      headers: { "idempotency-key": "reuse-1" },
      payload: { title: "원래 주제", baseRef: "HEAD" },
    });
    expect(replay.statusCode).toBe(201);
    expect(replay.json().id).toBe(first.json().id);
  });
});


it("activity API는 현재 세대의 역할별 최신 관측과 시각을 반환한다", async () => {
  const { app, database, root } = await makeApp();
  draftTopic(database, "metrics", { worktreePath: root });
  database.saveExecutionUsage("metrics", 1, "claude", "턴", { executionId: "older", recordKind: "progress", outputTokens: 1 });
  database.saveExecutionUsage("metrics", 1, "claude", "턴", { executionId: "newer", recordKind: "final", outputTokens: 2 });
  database.saveExecutionUsage("metrics", 1, "claude", "턴", { executionId: "older", recordKind: "progress", outputTokens: 3 });
  database.saveExecutionUsage("metrics", 1, "codex", "턴", { executionId: "codex", recordKind: "progress" });
  const response = await app.inject({ method: "GET", url: "/api/topics/metrics/activity",
    headers: { "x-consensus-token": "launch-token-for-test" } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ runningAction: false, scanned:0, executionUsage: [
    { executionId: "newer", role: "claude", observedAt: expect.any(String), usage: { recordKind: "final", outputTokens: 2 } },
    { executionId: "codex", role: "codex", usage: { recordKind: "progress" } },
  ] });
  database.updateTopic("metrics", { scopeGeneration: 2 });
  const next = await app.inject({ method: "GET", url: "/api/topics/metrics/activity",
    headers: { "x-consensus-token": "launch-token-for-test" } });
  expect(next.json().executionUsage).toEqual([]);
  await app.close();
});

it.each(["grant","resume","observe"])("작업 묶음 API는 단계 생성 중복·계약 개정·예산 %s 경계를 지킨다",async mode=>{
 // 새 단계 토픽은 계획 제어 v2 다(E4 2차 보완 F012) — 예산 재개 뒤 계획 턴이 실제 작업 트리 스냅숏을 거쳐 에이전트에 닿도록 실제 git 저장소를 쓴다.
 const {runner,worktreeAdds}=countingRealGitRunner();let failWorktree=false;
 const {app,database,adapterCalls,adapterCalled}=await makeApp({run:spec=>{if(failWorktree&&spec.args[0]==="worktree")throw new Error("worktree failure");return runner.run(spec);}},undefined,{gitRepository:true});
 const budget={execution:{inputTokens:100,outputTokens:100,durationMs:100000},total:{inputTokens:1000,outputTokens:1000,durationMs:1000000}};
 const input={title:"단계 작업",goal:"목표",contracts:"기존 계약",stages:[
  {id:"one",kind:"work",title:"구현",goal:"구현",acceptance:"테스트",dependsOn:[],budget},
  {id:"two",kind:"integration",title:"통합",goal:"통합",acceptance:"전체 검증",dependsOn:["one"],budget}]};
 const post=(url:string,payload:unknown,key:string)=>app.inject({method:"POST",url,payload:payload as any,headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":key}});
 try {
  const created=await post("/api/work-groups",input,"create");expect(created.statusCode).toBe(201);const group=created.json();
  const next=await post(`/api/work-groups/${group.id}/next`,{},"next");expect(next.statusCode).toBe(201);const topic=next.json();
  // 새 단계는 ticket 이고 정책을 켜지 않는다. 아래 예산 재개는 계획 단계를 검사하므로 공개 방식 전환으로 planned 를 고른다.
  expect(database.planning.policyVersion(topic.id)).toBe(0);
  expect((await post(`/api/topics/${topic.id}/workflow-mode`,{mode:"planned",reason:"계획 단계 예산 재개를 검사한다"},"mode")).statusCode).toBe(200);
  const repeated=await post(`/api/work-groups/${group.id}/next`,{},"next");expect(repeated.json().id).toBe(topic.id);expect(worktreeAdds).toHaveLength(1);
  const blocked=await post(`/api/work-groups/${group.id}/next`,{},"next-new");expect(blocked.statusCode).toBeGreaterThanOrEqual(400);expect(worktreeAdds).toHaveLength(1);
  database.updateTopic(topic.id,{state:"AWAITING_USER_APPROVAL",planSHA256:"a".repeat(64),approvedPlanSHA256:"a".repeat(64)});
  const revised=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"새 계약"},version:1},"revise");expect(revised.statusCode).toBe(200);
  // 개정은 승인 계획·상태를 초기화하지 않는다 — 바뀐 단계 문맥을 그 단계 토픽의 사실(work-group-revision)로 남기고, 계획 수정·범위 변경은 중재자가 정한다
  // (D8, 계약 v3.18 (33')).
  expect(database.getTopic(topic.id)).toMatchObject({state:"AWAITING_USER_APPROVAL",planSHA256:"a".repeat(64),approvedPlanSHA256:"a".repeat(64),planEpoch:1,scopeGeneration:1});
  expect(database.budgets.account(topic.id)?.policy).toEqual(budget);
  expect(database.workGroups.forTopic(topic.id)?.version).toBe(2);
  const revisionFacts=()=>database.getTimeline(topic.id).filter(event=>(event.payload?.workerFact as {kind?:string}|undefined)?.kind==="work-group-revision")
    .map(event=>(event.payload.workerFact as {version:number}).version);
  expect(revisionFacts()).toEqual([2]);
  // 개정은 작업 트리를 만들지 않는다(범위 변경 없음) — worktree 생성이 실패하는 동안에도 저장된다. 같은 입력을 새 키로 다시 보내면 바꿀 것이 없다.
  database.updateTopic(topic.id,{state:"READY_TO_DELIVER",approvedPlanSHA256:"a".repeat(64)});failWorktree=true;
  const second=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"두 번째 계약"},version:2},"revision-second");
  expect(second.statusCode).toBe(200);
  expect(database.workGroups.get(group.id)).toMatchObject({version:3,contracts:"두 번째 계약"});
  expect(database.getTopic(topic.id)).toMatchObject({state:"READY_TO_DELIVER",scopeGeneration:1,approvedPlanSHA256:"a".repeat(64)});failWorktree=false;
  expect(worktreeAdds).toHaveLength(1);
  const reapplied=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"두 번째 계약"},version:3},"revision-reapply");
  expect(reapplied.statusCode).toBe(200);
  expect(database.workGroups.get(group.id)).toMatchObject({version:3,contracts:"두 번째 계약"});
  expect(revisionFacts()).toEqual([2,3]);
  expect(database.budgets.account(topic.id)?.policy).toEqual(budget);
  // 예산으로 멈춘 첫 계획 단계 — 계획 없이 CLAUDE_PLAN 재개 지점으로 둔다(묶음 예산 재개가 실제 계획 턴을 연다).
  database.updateTopic(topic.id,{state:"USER_DECISION_REQUIRED",resumeState:"CLAUDE_PLAN",planSHA256:null,approvedPlanSHA256:null});
  database.appendEvent({topicId:topic.id,actor:"system",kind:"system",state:"USER_DECISION_REQUIRED",body:"예산 중단",payload:{budgetPause:true,resumeState:"CLAUDE_PLAN"}});
  database.budgets.start({id:"group-cap",accounts:[group.id,topic.id],startedAt:Date.now(),stage:"PLAN",role:"claude",model:"test",effort:"test"});
  database.budgets.observe("group-cap",{inputTokens:100},Date.now(),true);
  database.budgets.resumeExecution(topic.id,"topic-resume","group-cap",1);
  const groupPolicy=database.budgets.account(group.id)!.policy;
  if (!("execution" in groupPolicy)) throw Error("bounded fixture expected");
  const budgetBody=mode==="observe"?{version:1,policy:{mode:"observe"}}:mode==="resume"?{version:1,resumeExecutionId:"group-cap"}:{version:1,policy:{...groupPolicy,execution:{...groupPolicy.execution,inputTokens:200}}};
  const granted=await post(`/api/work-groups/${group.id}/budget`,budgetBody,"grant");
  expect(granted.statusCode).toBe(200);
  expect(await adapterCalled).toBe("claude");
  expect(adapterCalls).toEqual(["claude"]);
  await vi.waitFor(()=>expect(database.runningAction(topic.id)).toBeNull());
  expect(database.budgets.account(group.id)?.used.inputTokens).toBe(100);
  if(mode==="resume")expect(database.budgets.account(group.id)?.policy).toEqual(groupPolicy);
  if(mode==="observe")expect(database.budgets.account(group.id)?.policy).toEqual({mode:"observe"});

 } finally {await app.close();}
});

it.each(["same", "observe", "recovery"])("authenticated %s budget policy preserves usage and dispatches only once",async mode=>{
 const {app,database,root,adapterCalls,adapterCalled}=await makeApp(countingGitRunner().runner);
 const policy={execution:{inputTokens:1000,outputTokens:1000,durationMs:100000},total:{inputTokens:10000,outputTokens:10000,durationMs:1000000}};
 try {
  draftTopic(database,"resume-budget",{worktreePath:root});
  for(const role of ["claude","codex"] as const)database.upsertParticipant("resume-budget",{role,sessionId:`${role}-same`,mode:"attached",acknowledgedPlanSHA256:null});
  database.updateTopic("resume-budget",{state:"USER_DECISION_REQUIRED",resumeState:"CLAUDE_PLAN"});
  database.budgets.configure("resume-budget",mode==="recovery"?{mode:"observe"}:policy,"test");
  database.budgets.start({id:"stopped",accounts:["resume-budget"],stage:"CLAUDE_PLAN",role:"claude",model:"opus",effort:"xhigh",startedAt:0,dispatchStarted:true});
  database.budgets.observe("stopped",{inputTokens:1100},1,mode!=="recovery");
  if(mode==="recovery")database.budgets.recoverInterruptedExecutions();
  const url="/api/topics/resume-budget/actions/budget-resume",payload=mode!=="same"?{policy:{mode:"observe" as const},version:1}:{resumeExecutionId:"stopped",version:1};
  expect((await app.inject({method:"POST",url,payload})).statusCode).toBe(401);
  const headers={"x-consensus-token":"launch-token-for-test","idempotency-key":"same-allowance"};
  expect((await app.inject({method:"POST",url,payload:{resumeExecutionId:"stopped",version:1,policy},headers:{...headers,"idempotency-key":"mixed"}})).statusCode).toBeGreaterThanOrEqual(400);
  if(mode==="recovery") {
   const activity=()=>app.inject({method:"GET",url:"/api/topics/resume-budget/activity",headers});
   expect(TopicActivitySchema.parse((await activity()).json()).budgetRecoveryRequired).toBe(true);
   database.startAction({id:"still-running",topicId:"resume-budget",kind:"retry",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,
    pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
   const denied=await app.inject({method:"POST",url,payload,headers:{...headers,"idempotency-key":"active"}});
   expect(denied.statusCode).toBeGreaterThanOrEqual(400);
   expect(database.budgets.execution("stopped").finished).toBe(false);
   expect(database.budgets.account("resume-budget")!.version).toBe(1);
   expect(adapterCalls).toEqual([]);
   expect(TopicActivitySchema.parse((await activity()).json()).budgetRecoveryRequired).toBe(false);
   database.finishAction("still-running","failed","confirmed stopped");
  }
  const response=await app.inject({method:"POST",url,payload,headers});
  expect(response.statusCode,response.body).toBe(200);
  expect(await adapterCalled).toBe("claude");
  await vi.waitFor(()=>expect(database.runningAction("resume-budget")).toBeNull());
  expect((await app.inject({method:"POST",url,payload,headers})).json()).toEqual(response.json());
  expect(adapterCalls).toEqual(["claude"]);
  expect(database.budgets.account("resume-budget")).toMatchObject({policy:mode!=="same"?{mode:"observe"}:policy,used:{inputTokens:1100},version:2});
  expect(database.budgets.execution("stopped").used.inputTokens).toBe(1100);
  if(mode==="recovery") {
   const activity=await app.inject({method:"GET",url:"/api/topics/resume-budget/activity",headers});
   expect(TopicActivitySchema.parse(activity.json()).budgetRecoveryRequired).toBe(false);
  }
 } finally {await app.close();}
});

it("records a topic resume while its shared account remains paused, then resumes only that execution's topic",async()=>{
 const {app,database,root,adapterCalls,adapterCalled}=await makeApp(countingGitRunner().runner);
 const policy={execution:{inputTokens:100,outputTokens:1000,durationMs:100000},total:{inputTokens:1000,outputTokens:10000,durationMs:1000000}};
 const post=(url:string,payload:unknown,key:string)=>app.inject({method:"POST",url,payload:payload as any,
  headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":key}});
 try {
  const stages=[{id:"first",kind:"work" as const,title:"Earlier",goal:"Earlier",acceptance:"Check",dependsOn:[],budget:policy},
   {id:"target",kind:"work" as const,title:"Target",goal:"Target",acceptance:"Check",dependsOn:[],budget:policy},
   {id:"integration",kind:"integration" as const,title:"Integrate",goal:"Integrate",acceptance:"Check",dependsOn:["first","target"],budget:policy}];
  database.workGroups.create("shared",{title:"Group",goal:"Goal",contracts:"Contract",stages},root,"a".repeat(40));
  database.budgets.configure("shared",policy,"test");
  for(const id of ["first","target"]) {
   draftTopic(database,id,{repositoryPath:root,worktreePath:root});
   database.workGroups.link("shared",id,id,"a".repeat(40));
   database.budgets.configure(id,policy,"test");
   database.updateTopic(id,{state:id==="first"?"FAILED":"USER_DECISION_REQUIRED",resumeState:"CLAUDE_PLAN"});
   for(const role of ["claude","codex"] as const)database.upsertParticipant(id,{role,sessionId:`${id}-${role}`,mode:"attached",acknowledgedPlanSHA256:null});
  }
  database.appendEvent({topicId:"target",actor:"system",kind:"system",state:"USER_DECISION_REQUIRED",body:"Budget stopped",payload:{budgetPause:true,resumeState:"CLAUDE_PLAN"}});
  database.budgets.start({id:"shared-stop",accounts:["shared","target"],stage:"CLAUDE_PLAN",role:"claude",model:"opus",effort:"xhigh",startedAt:0});
  database.budgets.observe("shared-stop",{inputTokens:110},1,true);
  const payload={resumeExecutionId:"shared-stop",version:1},url="/api/topics/target/actions/budget-resume";
  const recorded=await post(url,payload,"topic-resume");
  expect(recorded.statusCode,recorded.body).toBe(200);expect(recorded.json().resumeBlocked).toContain("예산");
  expect((await post(url,payload,"topic-resume")).json()).toEqual(recorded.json());
  expect(database.budgets.account("target")).toMatchObject({pause:null,version:2,used:{inputTokens:110},policy});
  expect(database.budgets.account("shared")?.pause?.executionId).toBe("shared-stop");
  expect(adapterCalls).toEqual([]);
  const resumed=await post("/api/work-groups/shared/budget",payload,"group-resume");
  expect(resumed.statusCode,resumed.body).toBe(200);expect(resumed.json().resumedTopicId).toBe("target");
  expect(await adapterCalled).toBe("claude");
  await vi.waitFor(()=>expect(database.runningAction("target")).toBeNull());
  expect(database.getTopic("first").state).toBe("FAILED");expect(database.latestAction("first")).toBeNull();
  expect(adapterCalls).toEqual(["claude"]);
 } finally {await app.close();}
});

it.each(["held","closed","stale"])("budget resume checks the existing %s review reservation before requiring a new allowance",async kind=>{
 const {app,database,root}=await makeApp(countingGitRunner().runner);
 const policy={execution:{inputTokens:100,outputTokens:1000,durationMs:100000},total:{inputTokens:1000,outputTokens:10000,durationMs:1000000}};
 try {
  draftTopic(database,"reserved",{worktreePath:root});
  const topic=database.updateTopic("reserved",{state:"USER_DECISION_REQUIRED",resumeState:"CODEX_REVIEW"});
  database.appendEvent({topicId:topic.id,actor:"system",kind:"system",state:topic.state,body:"Budget stopped",payload:{budgetPause:true,resumeState:"CODEX_REVIEW"}});
  const ledger=database.planning.openReviewLedger({topicId:topic.id,kind:"codex-review",scopeGeneration:topic.scopeGeneration,
   planEpoch:topic.planEpoch,planSHA256:topic.planSHA256,reviewedTree:"tree",reportRevision:1});
  for(const id of ["old-1","old-2",ledger.id])database.reviews.admit(topic.id,id,"implementation");
  database.planning.markReviewLedgerSpawned(ledger.id);
  if(kind==="closed")database.planning.completeReviewLedger(ledger.id);
  if(kind==="stale")database.updateTopic(topic.id,{planEpoch:topic.planEpoch+1});
  database.budgets.configure(topic.id,policy,"test");
  database.budgets.start({id:"reserved-stop",accounts:[topic.id],stage:"CODEX_REVIEW",role:"codex",model:"test",effort:"test",startedAt:0});
  database.budgets.observe("reserved-stop",{inputTokens:110},1,true);
  const response=await app.inject({method:"POST",url:`/api/topics/${topic.id}/actions/budget-resume`,payload:{version:1,resumeExecutionId:"reserved-stop"},
   headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":"resume-held"}});
  expect(response.statusCode,response.body).toBe(200);
  if(kind==="held") {expect(response.json().resumeBlocked).toBeUndefined();expect(database.latestAction(topic.id)).not.toBeNull();}
  else {expect(response.json().resumeBlocked).toContain("리뷰");expect(database.latestAction(topic.id)).toBeNull();}
  await vi.waitFor(()=>expect(database.runningAction(topic.id)).toBeNull());
  expect(database.reviews.account(topic.id,"implementation")).toMatchObject({used:3,limit:3,version:2});
 } finally {await app.close();}
});

it("리뷰 1회 승인은 지정된 검토만 늘리고 예산 부족 시 재개를 보류한다",async()=>{
 const {app,database,adapterCalls}=await makeApp();
 try {
  draftTopic(database,"review");database.updateTopic("review",{state:"FAILED",resumeState:"CODEX_REVIEW"});
  database.budgets.configure("review",{execution:{inputTokens:1,outputTokens:1,durationMs:1000},total:{inputTokens:1,outputTokens:1,durationMs:1000}},"user-explicit");
  database.budgets.start({id:"review-cap",accounts:["review"],startedAt:0,stage:"CODEX_REVIEW",role:"codex",model:"test",effort:"test"});
  database.budgets.observe("review-cap",{inputTokens:1},1,true);
  for(const id of ["a","b","c"])database.reviews.admit("review",id,"implementation");
  const post=(scope:string,key:string)=>app.inject({method:"POST",url:"/api/topics/review/actions/review-resume",payload:{scope,version:2},headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":key}});
  expect((await post("planning","wrong")).statusCode).toBeGreaterThanOrEqual(400);
  const result=await post("implementation","grant");expect(result.statusCode).toBe(200);expect(result.json().resumeBlocked).toContain("예산");
  expect((await post("implementation","grant")).statusCode).toBe(200);
  expect(database.reviews.account("review","implementation")).toMatchObject({used:3,limit:4,version:3});
  expect(database.reviews.account("review","planning")).toMatchObject({used:0,limit:3});expect(adapterCalls).toHaveLength(0);
 } finally {await app.close();}
});


// 2026-10-02: 자율중재는 항상 ON. 인증·배정·상태 검사와 중재자 origin은 보존한다.
describe("Codex 후속 F07 — 중재자 권한 경계", () => {
  const token = { "x-consensus-token": "launch-token-for-test" };
  it("자율중재 OFF 요청과 중재자 설정 요청을 거부한다", async () => {
    const { app } = await makeApp();
    try {
      const off = await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "idempotency-key": "f07-off" }, payload: { autonomy: "off", note: "audit" } });
      expect(off.statusCode).toBe(400);
      const enabled = await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "x-consensus-actor": "mediator", "idempotency-key": "f07-self" }, payload: { autonomy: "on", note: "self" } });
      expect(enabled.statusCode).toBe(403);
      const view = await app.inject({ method: "GET", url: "/api/mediation-autonomy", headers: token });
      expect(view.json().autonomy).toBe("on");
    } finally { await app.close(); }
  });
  it("설정 파일 없이 중재자 증거·결정을 받고 origin을 남긴다", async () => {
    const { app, database } = await makeApp();
    try {
      draftTopic(database, "f07-topic");
      const headers = { ...token, "x-consensus-actor": "mediator" };
      const evidence = await app.inject({ method: "POST", url: "/api/topics/f07-topic/messages", headers: { ...headers, "idempotency-key": "f07-ev" }, payload: { kind: "evidence", body: "측정 결과 게시" } });
      expect(evidence.statusCode).toBe(200);
      database.updateTopic("f07-topic", { state: "USER_DECISION_REQUIRED" });
      const decisionOn = await app.inject({ method: "POST", url: "/api/topics/f07-topic/messages", headers: { ...headers, "idempotency-key": "f07-dec-on" }, payload: { kind: "decision", body: "위임 결정" } });
      expect(decisionOn.statusCode).toBe(200);
      const saved = database.getTimeline("f07-topic").find((event) => event.body === "위임 결정");
      expect(saved?.payload?.origin).toMatchObject({ actor: "mediator" });
    } finally { await app.close(); }
  });
  // 과거 OFF 파일이 남아 있어도 현재 정책에 따라 중재자의 범위 변경을 기록한다.
  it("예전 OFF 파일이 있어도 scope_change는 origin을 남기고 세대를 올린다", async () => {
    const { app, database, root } = await makeApp();
    try {
      draftTopic(database, "r3-scope");
      const headers = { ...token, "x-consensus-actor": "mediator" };
      writeFileSync(join(root, "mediation-autonomy.json"), JSON.stringify({ autonomy: "off" }));
      const allowed = await app.inject({ method: "POST", url: "/api/topics/r3-scope/messages", headers: { ...headers, "idempotency-key": "r3-scope-on" }, payload: { kind: "scope_change", body: "Delegated scope change", confirmScopeGenerationBump: true, expectedScopeGeneration: 1 } });
      expect(allowed.statusCode).toBe(200);
      expect(database.getTopic("r3-scope").scopeGeneration).toBe(2);
      const saved = database.getTimeline("r3-scope").find((event) => event.body === "Delegated scope change");
      expect(saved?.payload?.origin).toMatchObject({ actor: "mediator" });
    } finally { await app.close(); }
  });
  // R3-06 — 유지보수 잠금 아래의 기준 갱신은 잠금 소유자(pid·at 증명)만 통과한다. 잠금을 풀지 않아 유휴 확인↔교체 경쟁이 되살아나지 않는다.
  it("maintenance.lock 이 있으면 tool-tree-rebaseline 은 거부되고, 잠금 소유 증명을 실은 호출만 기준 산출물을 만든다", async () => {
    const { app, database, root } = await makeApp();
    try {
      draftTopic(database, "r3-lock", { worktreePath: root });
      const lock = { at: new Date().toISOString(), pid: 123, reason: "next-stop audit" };
      writeFileSync(join(root, "maintenance.lock"), JSON.stringify(lock));
      const refused = await app.inject({ method: "POST", url: "/api/topics/r3-lock/actions/tool-tree-rebaseline", headers: { ...token, "idempotency-key": "r3-lock-1" }, payload: { reason: "tools_sync finished" } });
      expect(refused.statusCode).toBeGreaterThanOrEqual(400);
      expect(refused.json().error).toContain("유지보수 잠금");
      expect(database.latestArtifact("r3-lock", "tool-tree-baseline")).toBeNull();
      const wrongOwner = await app.inject({ method: "POST", url: "/api/topics/r3-lock/actions/tool-tree-rebaseline", headers: { ...token, "idempotency-key": "r3-lock-2" }, payload: { reason: "tools_sync finished", maintenanceLock: { pid: 999, at: lock.at } } });
      expect(wrongOwner.statusCode).toBeGreaterThanOrEqual(400);
      const owner = await app.inject({ method: "POST", url: "/api/topics/r3-lock/actions/tool-tree-rebaseline", headers: { ...token, "idempotency-key": "r3-lock-3" }, payload: { reason: "tools_sync finished", maintenanceLock: { pid: lock.pid, at: lock.at } } });
      expect(owner.statusCode, owner.body).toBe(200);
      expect(database.latestArtifact("r3-lock", "tool-tree-baseline")).not.toBeNull();
      expect(database.getTimeline("r3-lock").some((event) => event.body.includes("유지보수 잠금 소유자 pid 123"))).toBe(true);
      expect(existsSync(join(root, "maintenance.lock"))).toBe(true);   // 잠금은 스크립트가 끝날 때 스스로 지운다 — 서버가 풀지 않는다
    } finally { await app.close(); }
  });
});
