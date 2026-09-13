import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server/app";
import { ConsensusDatabase } from "../src/server/database";
import type { AgentAdapter, CommandRunner } from "../src/server/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

async function makeApp(runner?: CommandRunner) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-app-"));
  temporaryDirectories.push(root);
  const unavailableRunner: CommandRunner = {
    run: async () => { throw new Error("이 테스트에서는 명령을 실행하지 않습니다."); },
  };
  const adapter = (role: "claude" | "codex"): AgentAdapter => ({
    role,
    createSession: async () => { throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
    resumeTurn: async () => { throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
    validateExistingSession: async () => false,
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
  return { app, database, root };
}

// worktree 생성 명령만 세는 가짜 git. 실제 저장소 없이 "몇 번 만들었는지"를 관측한다.
function countingGitRunner(): { runner: CommandRunner; worktreeAdds: string[] } {
  const worktreeAdds: string[] = [];
  const ok = (stdout: string) => ({ exitCode: 0, stdout, stderr: "", jsonLines: [] });
  const runner: CommandRunner = {
    run: async ({ args, cwd }) => {
      const joined = args.join(" ");
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
  expect(response.json()).toMatchObject({ runningAction: false, executionUsage: [
    { executionId: "newer", role: "claude", observedAt: expect.any(String), usage: { recordKind: "final", outputTokens: 2 } },
    { executionId: "codex", role: "codex", usage: { recordKind: "progress" } },
  ] });
  database.updateTopic("metrics", { scopeGeneration: 2 });
  const next = await app.inject({ method: "GET", url: "/api/topics/metrics/activity",
    headers: { "x-consensus-token": "launch-token-for-test" } });
  expect(next.json().executionUsage).toEqual([]);
  await app.close();
});
