import { ArtifactStore } from "../src/server/artifacts";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/server/app";
import { ConsensusDatabase } from "../src/server/database";
import { TopicActivitySchema } from "../src/shared/contracts";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, CommandRunner } from "../src/server/types";

const temporaryDirectories: string[] = [];

it("engine repository lock refuses that repository while another project remains admitted", async () => {
  const { app, database, root } = await makeApp(undefined, undefined, { gitRepository: true });
  try {
    const product = join(root, "product"); mkdirSync(product);
    execFileSync("git", ["init", "-q", product]);
    draftTopic(database, "engine-locked", { repositoryPath: root, worktreePath: root });
    draftTopic(database, "product-free", { repositoryPath: product, worktreePath: root });
    writeFileSync(join(root, "engine-work.lock"), JSON.stringify({ id: "engine-fix", repository: realpathSync(join(root, ".git")) }));
    const request = (id: string) => app.inject({ method: "POST", url: `/api/topics/${id}/actions/tool-tree-rebaseline`,
      headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": id }, payload: { reason: "tools updated" } });
    const blocked = await request("engine-locked");
    expect(blocked.statusCode).toBeGreaterThanOrEqual(400);
    expect(blocked.json().error).toContain("엔진 저장소 후속 작업");
    expect((await request("product-free")).statusCode).toBe(200);
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

it("requires authentication and an idempotency key to opt an idle topic into controlled planning", async () => {
  const { app, database } = await makeApp();
  draftTopic(database, "planning-topic");
  const url = "/api/topics/planning-topic/planning-control";
  expect(database.planning.enabled("planning-topic")).toBe(false);
  expect((await app.inject({ method: "POST", url })).statusCode).toBe(401);
  const headers = { "x-consensus-token": "launch-token-for-test" };
  expect((await app.inject({ method: "POST", url, headers })).statusCode).toBe(400);
  const request = { method: "POST" as const, url, headers: { ...headers, "idempotency-key": "enable-once" } };
  const first = await app.inject(request);
  expect(first.statusCode).toBe(200);
  expect(first.json().version).toBe(2);
  expect((await app.inject(request)).json()).toEqual(first.json());
  expect(database.planning.enabled("planning-topic")).toBe(true);
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

// Public API -> persisted policy -> retry routing. No model call is needed to migrate.
// Fixtures reproduce a hash-verified interrupted CLI output; saved plans and concurrent changes must refuse migration.
async function migrationFixture(validate: () => Promise<boolean> = async () => true) {
  const context = await makeApp(undefined, validate);
  const { database, root } = context;
  draftTopic(database, "migrate");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  database.upsertParticipant("migrate", { role: "claude", sessionId, mode: "created", acknowledgedPlanSHA256: null });
  database.updateTopic("migrate", { state: "USER_DECISION_REQUIRED", resumeState: "CLAUDE_PLAN" });
  const store = new ArtifactStore(join(root, "topics"), database);
  const artifact = await store.write("migrate", "interrupted-output", 1, JSON.stringify({ sessionId,
    output: { stdout: JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: "/tmp/worktree" }) } }));
  const topic = database.getTopic("migrate");
  const payload = { sessionId, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
    interruptedSHA256: artifact.sha256, apply: true };
  const request = { method: "POST" as const, url: "/api/topics/migrate/planning-control/migration",
    headers: { "x-consensus-token": "launch-token-for-test", "idempotency-key": "migration" }, payload };
  return { ...context, request, store, artifact };
}

it("previews and atomically migrates a verified interrupted plan without granting allowances or calling models", async () => {
  const { app, database, request, adapterCalls } = await migrationFixture();
  const topic = database.getTopic("migrate");
  const revisions = database.revisions.account("migrate");
  const preview = await app.inject({ ...request, headers: { ...request.headers, "idempotency-key": "preview" },
    payload: { ...request.payload, apply: false } });
  expect(preview.statusCode).toBe(200);
  expect(database.planning.policyVersion("migrate")).toBe(0);
  const first = await app.inject(request);
  expect(first.statusCode).toBe(200);
  expect(first.json()).toMatchObject({ version: 2, applied: true });
  expect((await app.inject(request)).json()).toEqual(first.json());
  expect(database.getTopic("migrate")).toMatchObject({ scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch,
    state: topic.state, participants: topic.participants, planSHA256: null });
  expect(database.revisions.account("migrate")).toEqual(revisions);
  expect(database.getTimeline("migrate").filter(e => e.payload?.planningMigration)).toHaveLength(1);
  expect(adapterCalls).toEqual([]);
  await app.close();
});

it.each(["missing-session", "saved-plan", "tampered-output", "wrong-session", "wrong-epoch", "stale-mediator", "wrong-worktree", "implementation"])(
  "refuses migration for %s without changing the policy", async reason => {
    const { app, database, request, store, artifact } = await migrationFixture(async () => reason !== "missing-session");
    if (reason === "saved-plan") await store.write("migrate", "claude-plan", 1, "saved response before planSHA assignment");
    if (reason === "tampered-output") writeFileSync(artifact.path, "tampered");
    if (reason === "wrong-session") request.payload.sessionId = "22222222-2222-4222-8222-222222222222";
    if (reason === "wrong-epoch") request.payload.planEpoch++;
    if (reason === "wrong-worktree") database.updateTopic("migrate", { worktreePath: "/tmp/another-worktree" });
    if (reason === "implementation") database.updateTopic("migrate", { implementationSessionId: request.payload.sessionId });
    if (reason === "stale-mediator") database.roles.assign({ scope: "global", role: "mediator", participant: "current-mediator",
      profileId: null, sessionId: null, note: "", operation: "", expectedVersion: 0 });
    const response = await app.inject({ ...request, headers: { ...request.headers,
      ...(reason === "stale-mediator" ? { "x-consensus-actor": "mediator" } : {}) } });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    expect(database.planning.policyVersion("migrate")).toBe(0);
    await app.close();
  });

it("rejects a changed topic after asynchronous session validation", async () => {
  let mutate = () => {};
  const { app, database, request } = await migrationFixture(async () => { mutate(); return true; });
  mutate = () => database.updateTopic("migrate", { planEpoch: request.payload.planEpoch + 1 });
  expect((await app.inject(request)).statusCode).toBeGreaterThanOrEqual(400);
  expect(database.planning.policyVersion("migrate")).toBe(0);
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
  const adapter = (role: "claude" | "codex"): AgentAdapter => ({
    role,
    createSession: async (turn) => { adapterCalls.push(role); resolveAdapterCall(role); fakeSpawn(turn); throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
    resumeTurn: async (turn) => { adapterCalls.push(role); resolveAdapterCall(role); fakeSpawn(turn); throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
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
  database.revisions.configure(id,3,database.revisions.account(id).version);
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
    const { app, database } = await makeApp();
    const planSHA256 = "a".repeat(64);
    database.createTopic({
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
    const request = {
      method: "POST" as const,
      url: "/api/topics/topic-1/messages",
      headers: {
        "x-consensus-token": "launch-token-for-test",
        "idempotency-key": "scope-once",
      },
      payload: { kind: "scope_change", body: "범위를 다시 잡습니다." },
    };

    const first = await app.inject(request);
    const second = await app.inject(request);

    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(database.getTopic("topic-1").scopeGeneration).toBe(2);
    expect(worktreeAdds).toHaveLength(1);
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
  expect(database.planning.policyVersion(topic.id)).toBe(2);
  const repeated=await post(`/api/work-groups/${group.id}/next`,{},"next");expect(repeated.json().id).toBe(topic.id);expect(worktreeAdds).toHaveLength(1);
  const blocked=await post(`/api/work-groups/${group.id}/next`,{},"next-new");expect(blocked.statusCode).toBeGreaterThanOrEqual(400);expect(worktreeAdds).toHaveLength(1);
  database.updateTopic(topic.id,{state:"AWAITING_USER_APPROVAL",planSHA256:"a".repeat(64),approvedPlanSHA256:"a".repeat(64)});
  const revised=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"새 계약"},version:1},"revise");expect(revised.statusCode).toBe(200);
  expect(database.getTopic(topic.id)).toMatchObject({state:"DRAFT",planSHA256:null,approvedPlanSHA256:null,planEpoch:2});
  expect(database.budgets.account(topic.id)?.policy).toEqual(budget);
  expect(database.workGroups.forTopic(topic.id)?.version).toBe(2);
  // E4 D2(저장 우선 + 명시적 재계획 대기) — 범위 변경이 끊겨도 개정은 저장되고, 대기 표식이 그 단계를 막으며, 같은 입력을 새 키로 다시 보내면 이어 적용한다.
  // (E4 전 계약은 "실패하면 개정을 저장하지 않는다" 였는데, 영향 단계가 둘이면 일부만 초기화된 채 개정이 사라졌다 — E0 관측.)
  database.updateTopic(topic.id,{state:"READY_TO_DELIVER",approvedPlanSHA256:"a".repeat(64)});failWorktree=true;
  const failure=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"범위 변경이 끊긴 계약"},version:2},"revision-failure");
  expect(failure.statusCode).toBeGreaterThanOrEqual(400);
  expect(database.workGroups.get(group.id)).toMatchObject({version:3,contracts:"범위 변경이 끊긴 계약"});
  expect(database.workGroups.get(group.id).links.one.replanPending).toEqual({version:3,fromGeneration:2});
  expect(database.getTopic(topic.id)).toMatchObject({state:"READY_TO_DELIVER",scopeGeneration:2,approvedPlanSHA256:"a".repeat(64)});failWorktree=false;
  const reapplied=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"범위 변경이 끊긴 계약"},version:3},"revision-reapply");
  expect(reapplied.statusCode).toBe(200);
  expect(database.workGroups.get(group.id)).toMatchObject({version:3,contracts:"범위 변경이 끊긴 계약"});
  expect(database.workGroups.get(group.id).links.one.replanPending).toBeUndefined();
  expect(database.getTopic(topic.id)).toMatchObject({state:"DRAFT",scopeGeneration:3,approvedPlanSHA256:null});
  expect(database.budgets.account(topic.id)?.policy).toEqual(budget);
  database.updateTopic(topic.id,{state:"USER_DECISION_REQUIRED",resumeState:"CLAUDE_PLAN"});
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

it("재작성 승인은 1회만 늘리고 실제 호출을 재개하며 중복·낡은 승인을 거절한다",async()=>{
 const {app,database,root,adapterCalls}=await makeApp(countingGitRunner().runner);
 const post=(action:string,payload:unknown,key:string)=>app.inject({method:"POST",url:`/api/topics/revisions/actions/${action}`,payload:payload as any,headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":key}});
 try {
  draftTopic(database,"revisions",{worktreePath:root});
  for(const role of ["claude","codex"] as const)database.upsertParticipant("revisions",{role,sessionId:`${role}-revision`,mode:"attached",acknowledgedPlanSHA256:null});
  database.revisions.admit("revisions","initial","plan");
  for(const id of ["a","b","c"])database.revisions.admit("revisions",id,"revision");
  const policy={execution:{inputTokens:1000,outputTokens:1000,durationMs:100000},total:{inputTokens:10000,outputTokens:10000,durationMs:1000000}};
  database.budgets.configure("revisions",policy,"test");
  const unauthorized=await app.inject({method:"POST",url:"/api/topics/revisions/actions/revision-resume",payload:{version:1}});
  expect(unauthorized.statusCode).toBe(401);
  expect((await post("revision-resume",{version:1,limit:100},"invalid")).statusCode).toBeGreaterThanOrEqual(400);
  const grant=await post("revision-resume",{version:2},"grant");expect(grant.statusCode).toBe(200);
  await vi.waitFor(()=>expect(database.runningAction("revisions")).toBeNull());
  expect(adapterCalls,database.getTopic("revisions").lastError ?? JSON.stringify(grant.json())).toEqual(["claude"]);
  expect(database.revisions.account("revisions")).toMatchObject({used:4,limit:4,version:3});
  expect((await post("revision-resume",{version:2},"grant")).statusCode).toBe(200);
  expect((await post("revision-resume",{version:2},"stale")).statusCode).toBeGreaterThanOrEqual(400);
  expect(adapterCalls).toHaveLength(1);
  const budgetGrant=await post("budget-resume",{version:1,policy:{...policy,execution:{...policy.execution,inputTokens:2000}}},"budget");
  expect(budgetGrant.statusCode).toBe(200);expect(budgetGrant.json().resumeBlocked).toContain("재작성");
  expect(database.revisions.account("revisions").limit).toBe(4);expect(adapterCalls).toHaveLength(1);
 } finally {await app.close();}
});

it("재작성 승인 후 명시한 토큰 예산이 소진됐으면 승인만 보존하고 호출하지 않는다",async()=>{
 const {app,database,root,adapterCalls}=await makeApp(countingGitRunner().runner);
 try {
  draftTopic(database,"both",{worktreePath:root});
  database.budgets.configure("both",{execution:{inputTokens:1,outputTokens:1,durationMs:1000},total:{inputTokens:1,outputTokens:1,durationMs:1000}},"user-explicit");
  database.budgets.start({id:"both-cap",accounts:["both"],startedAt:0,stage:"PLAN",role:"claude",model:"test",effort:"test"});
  database.budgets.observe("both-cap",{inputTokens:1},1,true);
  database.revisions.admit("both","initial","plan");
  for(const id of ["a","b","c"])database.revisions.admit("both",id,"revision");
  const grant=await app.inject({method:"POST",url:"/api/topics/both/actions/revision-resume",payload:{version:2},headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":"grant"}});
  expect(grant.statusCode).toBe(200);expect(grant.json().resumeBlocked).toContain("예산");
  expect(database.revisions.account("both")).toMatchObject({used:3,limit:4});expect(adapterCalls).toHaveLength(0);
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
  if(kind==="closed")database.planning.judgeReviewLedger(ledger.id);
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
      const allowed = await app.inject({ method: "POST", url: "/api/topics/r3-scope/messages", headers: { ...headers, "idempotency-key": "r3-scope-on" }, payload: { kind: "scope_change", body: "Delegated scope change" } });
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

it("migrates when a bounded stdout tail lost init but verified jsonLines retained it", async () => {
  const { app, request, store } = await migrationFixture();
  const artifact = await store.write("migrate", "interrupted-output", 2, JSON.stringify({ sessionId: request.payload.sessionId,
    output: { stdout: '{"type":"progress"}\n', truncated: true,
      jsonLines: [{ type: "system", subtype: "init", session_id: request.payload.sessionId, cwd: "/tmp/worktree" }] } }));
  request.payload.interruptedSHA256 = artifact.sha256;
  expect((await app.inject(request)).statusCode).toBe(200);
  await app.close();
});
