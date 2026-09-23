import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/server/app";
import { ConsensusDatabase } from "../src/server/database";
import type { AgentAdapter, CommandRunner } from "../src/server/types";

const temporaryDirectories: string[] = [];

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
  expect((await app.inject(request)).json()).toEqual(first.json());
  expect(database.planning.enabled("planning-topic")).toBe(true);
  await app.close();
});

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
  const adapterCalls:string[]=[];
  // 가짜는 프로세스를 띄운 뒤 실패한 호출을 흉내 낸다(onProcessSpawn) — 띄우지 않은 호출은 예약이 해제되므로 집계 테스트의 전제가 달라진다(PLAN §2 검증 조건 1).
  const fakeSpawn = (turn: { onProcessSpawn?: (process: { pid: number; pgid: number; executable: string; commandLine: string; startedAt: string }) => void }) =>
    turn.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });
  const adapter = (role: "claude" | "codex"): AgentAdapter => ({
    role,
    createSession: async (turn) => { adapterCalls.push(role); fakeSpawn(turn); throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
    resumeTurn: async (turn) => { adapterCalls.push(role); fakeSpawn(turn); throw new Error("이 테스트에서는 CLI를 실행하지 않습니다."); },
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
  return { app, database, root, adapterCalls };
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

it("작업 묶음 API는 단계 생성 중복을 막고 계약 변경 때 승인을 무효화한다",async()=>{
 const {runner,worktreeAdds}=countingGitRunner();let failWorktree=false;
 const {app,database,adapterCalls}=await makeApp({run:spec=>{if(failWorktree&&spec.args[0]==="worktree")throw new Error("worktree failure");return runner.run(spec);}});
 const budget={execution:{inputTokens:100,outputTokens:100,durationMs:100000},total:{inputTokens:1000,outputTokens:1000,durationMs:1000000}};
 const input={title:"단계 작업",goal:"목표",contracts:"기존 계약",stages:[
  {id:"one",kind:"work",title:"구현",goal:"구현",acceptance:"테스트",dependsOn:[],budget},
  {id:"two",kind:"integration",title:"통합",goal:"통합",acceptance:"전체 검증",dependsOn:["one"],budget}]};
 const post=(url:string,payload:unknown,key:string)=>app.inject({method:"POST",url,payload:payload as any,headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":key}});
 try {
  const created=await post("/api/work-groups",input,"create");expect(created.statusCode).toBe(201);const group=created.json();
  const next=await post(`/api/work-groups/${group.id}/next`,{},"next");expect(next.statusCode).toBe(201);const topic=next.json();
  const repeated=await post(`/api/work-groups/${group.id}/next`,{},"next");expect(repeated.json().id).toBe(topic.id);expect(worktreeAdds).toHaveLength(1);
  const blocked=await post(`/api/work-groups/${group.id}/next`,{},"next-new");expect(blocked.statusCode).toBeGreaterThanOrEqual(400);expect(worktreeAdds).toHaveLength(1);
  database.updateTopic(topic.id,{state:"AWAITING_USER_APPROVAL",planSHA256:"a".repeat(64),approvedPlanSHA256:"a".repeat(64)});
  const revised=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"새 계약"},version:1},"revise");expect(revised.statusCode).toBe(200);
  expect(database.getTopic(topic.id)).toMatchObject({state:"DRAFT",planSHA256:null,approvedPlanSHA256:null,planEpoch:2});
  expect(database.budgets.account(topic.id)?.policy).toEqual(budget);
  expect(database.workGroups.forTopic(topic.id)?.version).toBe(2);
  database.updateTopic(topic.id,{state:"READY_TO_DELIVER",approvedPlanSHA256:"a".repeat(64)});failWorktree=true;
  const failure=await post(`/api/work-groups/${group.id}/revise`,{input:{...input,contracts:"저장되면 안 되는 계약"},version:2},"revision-failure");
  expect(failure.statusCode).toBeGreaterThanOrEqual(400);
  expect(database.workGroups.get(group.id)).toMatchObject({version:2,contracts:"새 계약"});
  expect(database.getTopic(topic.id).approvedPlanSHA256).toBe("a".repeat(64));failWorktree=false;
  database.updateTopic(topic.id,{state:"USER_DECISION_REQUIRED",resumeState:"CLAUDE_PLAN"});
  database.appendEvent({topicId:topic.id,actor:"system",kind:"system",state:"USER_DECISION_REQUIRED",body:"예산 중단",payload:{budgetPause:true,resumeState:"CLAUDE_PLAN"}});
  database.budgets.start({id:"group-cap",accounts:[group.id],startedAt:Date.now(),stage:"PLAN",role:"claude",model:"test",effort:"test"});
  database.budgets.observe("group-cap",{inputTokens:100},Date.now(),true);
  const groupPolicy=database.budgets.account(group.id)!.policy;
  const granted=await post(`/api/work-groups/${group.id}/budget`,{version:1,policy:{...groupPolicy,execution:{...groupPolicy.execution,inputTokens:200}}},"grant");
  expect(granted.statusCode).toBe(200);
  await vi.waitFor(()=>expect(adapterCalls).toEqual(["claude"]));
  await vi.waitFor(()=>expect(database.runningAction(topic.id)).toBeNull());
  expect(database.budgets.account(group.id)?.used.inputTokens).toBe(100);

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
  const grant=await post("revision-resume",{version:1},"grant");expect(grant.statusCode).toBe(200);
  await vi.waitFor(()=>expect(database.runningAction("revisions")).toBeNull());
  expect(adapterCalls,database.getTopic("revisions").lastError ?? JSON.stringify(grant.json())).toEqual(["claude"]);
  expect(database.revisions.account("revisions")).toMatchObject({used:4,limit:4,version:2});
  expect((await post("revision-resume",{version:1},"grant")).statusCode).toBe(200);
  expect((await post("revision-resume",{version:1},"stale")).statusCode).toBeGreaterThanOrEqual(400);
  expect(adapterCalls).toHaveLength(1);
  const budgetGrant=await post("budget-resume",{version:1,policy:{...policy,execution:{...policy.execution,inputTokens:2000}}},"budget");
  expect(budgetGrant.statusCode).toBe(200);expect(budgetGrant.json().resumeBlocked).toContain("재작성");
  expect(database.revisions.account("revisions").limit).toBe(4);expect(adapterCalls).toHaveLength(1);
 } finally {await app.close();}
});

it("재작성 승인 후 토큰 예산이 없으면 승인만 보존하고 호출하지 않는다",async()=>{
 const {app,database,root,adapterCalls}=await makeApp(countingGitRunner().runner);
 try {
  draftTopic(database,"both",{worktreePath:root});
  database.revisions.admit("both","initial","plan");
  for(const id of ["a","b","c"])database.revisions.admit("both",id,"revision");
  const grant=await app.inject({method:"POST",url:"/api/topics/both/actions/revision-resume",payload:{version:1},headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":"grant"}});
  expect(grant.statusCode).toBe(200);expect(grant.json().resumeBlocked).toContain("예산");
  expect(database.revisions.account("both")).toMatchObject({used:3,limit:4});expect(adapterCalls).toHaveLength(0);
 } finally {await app.close();}
});

it("리뷰 1회 승인은 지정된 검토만 늘리고 예산 부족 시 재개를 보류한다",async()=>{
 const {app,database,adapterCalls}=await makeApp();
 try {
  draftTopic(database,"review");database.updateTopic("review",{state:"FAILED",resumeState:"CODEX_REVIEW"});
  for(const id of ["a","b","c"])database.reviews.admit("review",id,"implementation");
  const post=(scope:string,key:string)=>app.inject({method:"POST",url:"/api/topics/review/actions/review-resume",payload:{scope,version:1},headers:{"x-consensus-token":"launch-token-for-test","idempotency-key":key}});
  expect((await post("planning","wrong")).statusCode).toBeGreaterThanOrEqual(400);
  const result=await post("implementation","grant");expect(result.statusCode).toBe(200);expect(result.json().resumeBlocked).toContain("예산");
  expect((await post("implementation","grant")).statusCode).toBe(200);
  expect(database.reviews.account("review","implementation")).toMatchObject({used:3,limit:4,version:2});
  expect(database.reviews.account("review","planning")).toMatchObject({used:0,limit:3});expect(adapterCalls).toHaveLength(0);
 } finally {await app.close();}
});


// 2026-09-14 Codex 후속 F07 — 위임 스위치는 사용자만, 증거 게시는 OFF 에서도, 중재자 결정의 origin 보존.
describe("Codex 후속 F07 — 중재자 권한 경계", () => {
  const token = { "x-consensus-token": "launch-token-for-test" };
  it("OFF 상태에서 중재자 헤더로 위임을 ON 으로 바꿀 수 없다(403)", async () => {
    const { app } = await makeApp();
    try {
      const off = await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "idempotency-key": "f07-off" }, payload: { autonomy: "off", note: "audit" } });
      expect(off.statusCode).toBe(200);
      const enabled = await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "x-consensus-actor": "mediator", "idempotency-key": "f07-self" }, payload: { autonomy: "on", note: "self" } });
      expect(enabled.statusCode).toBe(403);
      const view = await app.inject({ method: "GET", url: "/api/mediation-autonomy", headers: token });
      expect(view.json().autonomy).toBe("off");
    } finally { await app.close(); }
  });
  it("OFF 에서도 증거 게시는 되고 결정 대행은 403 이며, ON 중재자 결정은 origin 을 남긴다", async () => {
    const { app, database } = await makeApp();
    try {
      draftTopic(database, "f07-topic");
      const headers = { ...token, "x-consensus-actor": "mediator" };
      await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "idempotency-key": "f07-off2" }, payload: { autonomy: "off", note: "audit" } });
      const evidence = await app.inject({ method: "POST", url: "/api/topics/f07-topic/messages", headers: { ...headers, "idempotency-key": "f07-ev" }, payload: { kind: "evidence", body: "측정 결과 게시" } });
      expect(evidence.statusCode).toBe(200);
      const decisionOff = await app.inject({ method: "POST", url: "/api/topics/f07-topic/messages", headers: { ...headers, "idempotency-key": "f07-dec-off" }, payload: { kind: "decision", body: "대행 결정" } });
      expect(decisionOff.statusCode).toBe(403);
      await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "idempotency-key": "f07-on" }, payload: { autonomy: "on", note: "user" } });
      database.updateTopic("f07-topic", { state: "USER_DECISION_REQUIRED" });
      const decisionOn = await app.inject({ method: "POST", url: "/api/topics/f07-topic/messages", headers: { ...headers, "idempotency-key": "f07-dec-on" }, payload: { kind: "decision", body: "위임 결정" } });
      expect(decisionOn.statusCode).toBe(200);
      const saved = database.getTimeline("f07-topic").find((event) => event.body === "위임 결정");
      expect(saved?.payload?.origin).toMatchObject({ actor: "mediator" });
    } finally { await app.close(); }
  });
  // 2026-09-14 Codex 3차 R3-04 — 범위 변경도 사용자 권한 대행이다: OFF 에서 중재자 scope_change 는 403 이고 세대가 오르지 않는다.
  it("OFF 에서 중재자 scope_change 는 403 이며 세대·타임라인이 그대로다; ON 이면 origin 을 남기고 세대가 오른다", async () => {
    const { app, database } = await makeApp();
    try {
      draftTopic(database, "r3-scope");
      const headers = { ...token, "x-consensus-actor": "mediator" };
      await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "idempotency-key": "r3-off" }, payload: { autonomy: "off", note: "audit" } });
      const refused = await app.inject({ method: "POST", url: "/api/topics/r3-scope/messages", headers: { ...headers, "idempotency-key": "r3-scope-off" }, payload: { kind: "scope_change", body: "Unapproved expanded scope" } });
      expect(refused.statusCode).toBe(403);
      expect(database.getTopic("r3-scope").scopeGeneration).toBe(1);
      expect(database.getTimeline("r3-scope").some((event) => event.body === "Unapproved expanded scope")).toBe(false);
      await app.inject({ method: "POST", url: "/api/mediation-autonomy", headers: { ...token, "idempotency-key": "r3-on" }, payload: { autonomy: "on", note: "user" } });
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
