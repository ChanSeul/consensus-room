import { randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ServerConfig } from "../src/server/config";
import { buildApp, listenReady } from "../src/server/app";
import { ConsensusDatabase } from "../src/server/database";
import { SpawnCommandRunner } from "../src/server/processRunner";
import { turnPolicy } from "../src/server/adapters/turnPolicy";
import { DEFAULT_AGENT_SETTINGS, type AgentResult } from "../src/shared/contracts";
import { brainstormReplies, latestBrainstormRound } from "../src/shared/brainstorm";
import type { AgentAdapter, SessionTurn } from "../src/server/types";

// 공개 API → 상태·타임라인·다음 행동을 소비하는 방 화면/중재자 계약.
// 대역은 pending, 오류, 취소를 무시한 늦은 응답을 재현한다. 대기는 action 완료와 명시적 latch를 쓴다.
// 신규 흐름이라 기존 버그 복원은 해당 없음. 실제 CLI 권한·AI 발언 품질·렌더는 이 검사의 주장 밖이다.
vi.mock("node:crypto", async original => ({ ...await original<typeof import("node:crypto")>(), randomInt: vi.fn(() => 0) }));
const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => vi.mocked(randomInt).mockReturnValue(0 as never));
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
const reply = (text = "현재 방식과 작은 실험을 비교해 볼 수 있습니다."): AgentResult => ({ kind: "BRAINSTORM", summary: text, findings: [], evidenceRefs: [] });
function latch<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

async function fixture(control?: (turn: Omit<SessionTurn, "sessionId">, index: number) => Promise<AgentResult>, guardedPlanning = false) {
  const root = mkdtempSync(join(tmpdir(), "room-brainstorm-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, "README.md"), "Test repository\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "baseline"]);
  let database = new ConsensusDatabase(join(root, "room.sqlite"));
  const calls: Array<{ provider: string; turn: Omit<SessionTurn, "sessionId">; sessionId?: string }> = [];
  const adapter = (provider: "claude" | "codex"): AgentAdapter => {
    const run = async (turn: Omit<SessionTurn, "sessionId">, sessionId?: string) => {
      calls.push({ provider, turn, sessionId });
      return control ? control(turn, calls.length) : reply(`의견 ${calls.length}`);
    };
    return { role: provider, validateExistingSession: async () => true,
      createSession: async turn => ({ sessionId: `${provider}-${calls.length}`, result: await run(turn) }),
      resumeTurn: turn => run(turn, turn.sessionId) };
  };
  const config: ServerConfig = {
    host: "127.0.0.1", port: 0, launchToken: "test-token", dataDirectory: root, topicsDirectory: join(root, "topics"),
    worktreesDirectory: join(root, "trees"), databasePath: join(root, "room.sqlite"), repositoryPath: root,
    webDirectory: join(root, "no-web"), memoryDirectory: join(root, "memory"), claudeSkillDirectories: [], codexSkillDirectories: [],
    defaultAgentSettings: DEFAULT_AGENT_SETTINGS, figmaMcpUrl: null, codexConcurrency: 2, guardedPlanning, enforceBudgets: false,
  };
  const build = () => buildApp({ database, runner: new SpawnCommandRunner(), claude: adapter("claude"), codex: adapter("codex"), config });
  let app = await build();
  cleanups.unshift(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  let key = 0;
  const post = (url: string, payload: Record<string, unknown> = {}, headers: Record<string, string> = {}) => app.inject({ method: "POST", url, payload,
    headers: { "x-consensus-token": "test-token", "idempotency-key": `request-${++key}`, ...headers } });
  const created = await post("/api/topics", { title: "긴 계획을 어떻게 전달할지 논의", startMode: "brainstorm" });
  expect(created.statusCode).toBe(201);
  const id = created.json().id as string;
  for (const seat of ["claude", "codex"]) {
    const attached = await post(`/api/topics/${id}/participants/${seat}`, { mode: "new" });
    expect(attached.statusCode).toBe(200);
  }
  const action = (name: string, body: Record<string, unknown> = {}, headers?: Record<string, string>) => post(`/api/topics/${id}/actions/${name}`, body, headers);
  const done = async () => {
    const until = Date.now() + 5000;
    while (database.runningAction(id)) {
      if (Date.now() > until) throw new Error(`action did not complete: ${database.getTopic(id).lastError}`);
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  const events = () => database.getScopedTimeline(id, database.getTopic(id).scopeGeneration);
  const restart = async () => { await app.close(); database = new ConsensusDatabase(join(root, "room.sqlite")); app = await build(); await listenReady(app, { host: "127.0.0.1", port: 0 }); await done(); };
  return { get app() { return app; }, get database() { return database; }, id, calls, post, action, done, events, restart };
}

it.each([0, 1])("random order %s: each participant speaks once, then only the user chooses another round or closure", async order => {
  vi.mocked(randomInt).mockReturnValue(order as never);
  const f = await fixture(undefined, true);
  expect(f.database.planning.policyVersion(f.id)).toBe(2);
  expect((await f.action("plan")).statusCode).toBeGreaterThanOrEqual(400);
  expect((await f.action("brainstorm", { message: "작은 실험으로 비교하고 싶습니다" }, { "idempotency-key": "same-round" })).statusCode).toBe(200);
  await f.done();
  expect(f.database.getTopic(f.id)).toMatchObject({ state: "BRAINSTORM_READY", planSHA256: null, approvedPlanSHA256: null });
  expect(f.calls.map(c => c.turn.job?.role)).toEqual(order === 0 ? ["planner", "reviewer"] : ["reviewer", "planner"]);
  expect(f.calls.every(c => c.turn.job?.operation === "brainstorm")).toBe(true);
  expect(f.calls[1].turn.prompt).toContain("의견 1");
  for (const call of f.calls) expect(turnPolicy(call.turn.job!, {})).toMatchObject({ access: "read", fanout: false });
  await f.action("brainstorm", { message: "작은 실험으로 비교하고 싶습니다" }, { "idempotency-key": "same-round" });
  expect(f.calls).toHaveLength(2);
  const resume = await f.app.inject({ url: `/api/topics/${f.id}/resume`, headers: { "x-consensus-token": "test-token" } });
  expect(resume.json().nextActions.map((a: { action: string }) => a.action)).toEqual(["brainstorm", "brainstorm-plan", "brainstorm-close"]);
  vi.mocked(randomInt).mockReturnValue((1 - order) as never);
  await f.action("brainstorm"); await f.done();
  expect(f.calls.slice(2).map(c => c.turn.job?.role)).toEqual(order === 0 ? ["reviewer", "planner"] : ["planner", "reviewer"]);
  expect(latestBrainstormRound(f.events())?.number).toBe(2);
  await f.action("brainstorm-close", { decision: "현재 방식으로 충분해서 진행하지 않습니다." }); await f.done();
  expect(f.database.getTopic(f.id).state).toBe("CLOSED");
  expect((await f.action("brainstorm")).statusCode).toBeGreaterThanOrEqual(400);
  expect(f.calls).toHaveLength(4);
});

it("pending duplicate is refused; second-speaker failure resumes only that speaker with the saved order", async () => {
  const entered = latch<void>(); const release = latch<AgentResult>();
  cleanups.push(async () => release.resolve(reply()));
  const f = await fixture(async (_turn, index) => {
    if (index === 1) { entered.resolve(); return release.promise; }
    if (index === 2) throw new Error("simulated provider failure");
    return reply("재시도 후 의견");
  });
  await f.action("brainstorm"); await entered.promise;
  expect((await f.action("brainstorm")).statusCode).toBeGreaterThanOrEqual(400);
  expect((await f.action("brainstorm-plan", { decision: "아직 발언 중" })).statusCode).toBeGreaterThanOrEqual(400);
  expect(f.calls).toHaveLength(1);
  release.resolve(reply("첫 번째 발언")); await f.done();
  expect(f.database.getTopic(f.id).state).toBe("FAILED");
  const round = latestBrainstormRound(f.events())!;
  expect(brainstormReplies(f.events(), round.sequence)).toHaveLength(1);
  await f.restart();
  vi.mocked(randomInt).mockReturnValue(1 as never);
  await f.action("retry"); await f.done();
  expect(f.calls.map(c => c.turn.job?.role)).toEqual(["planner", "reviewer", "reviewer"]);
  expect(latestBrainstormRound(f.events())).toEqual(round);
  expect(f.calls[2].turn.prompt).toContain("첫 번째 발언");
  expect(f.database.getTopic(f.id).state).toBe("BRAINSTORM_READY");
});

it("a decision arriving during a pending turn keeps the late answer out of accepted discussion and is included on retry", async () => {
  const entered = latch<void>(); const release = latch<AgentResult>();
  cleanups.push(async () => release.resolve(reply()));
  const f = await fixture(async (_turn, index) => { if (index === 1) { entered.resolve(); return release.promise; } return reply("new input considered"); });
  await f.action("brainstorm"); await entered.promise;
  await f.post(`/api/topics/${f.id}/messages`, { kind: "decision", body: "이미지 변환 대신 전송량부터 확인합시다." });
  release.resolve(reply("OUTDATED ANSWER")); await f.done();
  expect(f.database.getTopic(f.id).state).toBe("USER_DECISION_REQUIRED");
  expect(f.events().filter(e => e.payload.resultKind === "BRAINSTORM")).toHaveLength(0);
  await f.action("retry"); await f.done();
  expect(f.calls[1].turn.prompt).toContain("전송량부터 확인");
  expect(f.calls[1].turn.prompt).not.toContain("OUTDATED ANSWER");
  expect(f.database.getTopic(f.id).state).toBe("BRAINSTORM_READY");
});

it.each(["reversed", "same-provider"])("uses assigned participants for %s and hands the explicit decision and discussion to planning", async mode => {
  const f = await fixture(async turn => turn.job?.operation === "plan"
    ? { kind: "PLAN", summary: "계획에서 확인할 질문", findings: [], evidenceRefs: [], requestedUserDecision: "측정 환경을 확인해 주세요." }
    : reply("전체 도입보다 비교 실험을 제안합니다."));
  for (const role of ["planner", "reviewer"] as const) {
    const provider = role === "planner" || mode === "same-provider" ? "codex" : "claude";
    expect((await f.post("/api/agent-profiles", { id: `${role}-profile`, provider, model: provider === "codex" ? "gpt-6-astra" : "opus", effort: "high" })).statusCode).toBe(201);
    expect((await f.post("/api/role-assignments", { scope: `topic:${f.id}`, role, participant: `${role}-person`, profileId: `${role}-profile`, expectedVersion: 0 })).statusCode).toBe(200);
  }
  await f.action("brainstorm"); await f.done();
  expect(f.calls.map(c => c.provider)).toEqual(mode === "reversed" ? ["codex", "claude"] : ["codex", "codex"]);
  const sessions = f.database.getTopic(f.id).participants.map(p => p.sessionId);
  expect(new Set(sessions).size).toBe(2);
  expect((await f.action("brainstorm-plan", { decision: " " })).statusCode).toBe(400);
  expect(f.calls).toHaveLength(2);
  expect((await f.action("brainstorm-plan", { decision: "비교 실험만 계획하고 전체 도입은 제외합니다." }, { "x-consensus-actor": "mediator" })).statusCode).toBe(200); await f.done();
  expect(f.calls[2].turn.job).toEqual({ role: "planner", operation: "plan" });
  expect(f.calls[2].turn.prompt).toContain("전체 도입은 제외");
  expect(f.calls[2].turn.prompt).toContain("비교 실험을 제안");
  expect(f.database.getTopic(f.id)).toMatchObject({ state: "USER_DECISION_REQUIRED", approvedPlanSHA256: null });
});

it("scope change discards a late discussion answer and starts a fresh discussion without entering planning", async () => {
  const entered = latch<void>(); const release = latch<AgentResult>();
  const f = await fixture(async (_turn, index) => { if (index === 1) { entered.resolve(); return release.promise; } return reply("새 범위의 의견"); });
  cleanups.push(async () => release.resolve(reply()));
  await f.action("brainstorm"); await entered.promise;
  const changing = f.post(`/api/topics/${f.id}/messages`, { kind: "scope_change", body: "텍스트 저장과 검색만 비교합니다." });
  release.resolve(reply("OLD SCOPE"));
  expect((await changing).statusCode).toBe(200); await f.done();
  expect(f.database.getTopic(f.id)).toMatchObject({ state: "BRAINSTORM_READY", scopeGeneration: 2, planSHA256: null });
  await f.action("brainstorm"); await f.done();
  expect(f.calls.slice(-2).every(call => call.turn.job?.operation === "brainstorm")).toBe(true);
  expect(f.calls.at(-1)!.turn.prompt).not.toContain("OLD SCOPE");
  expect(latestBrainstormRound(f.events())?.number).toBe(1);
});

it.each(["brainstorm", "brainstorm-plan", "brainstorm-close"])("restart before persisting %s restores user choice without calling an AI", async kind => {
  const f = await fixture();
  // 프로세스가 action 원장을 쓴 직후 종료한 상태. 같은 시작 상태가 완료 대기 상태이기도 하므로 완료 표식이 필요하다.
  f.database.startAction({ id: "crashed-before-round", topicId: f.id, kind, status: "running", createdAt: new Date().toISOString(),
    finishedAt: null, error: null, pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null });
  await f.restart();
  expect(f.database.getTopic(f.id).state).toBe("FAILED");
  expect(f.database.getFlags(f.id).resumeState).toBe("BRAINSTORM_READY");
  await f.action("retry"); await f.done();
  expect(f.calls).toHaveLength(0);
  expect(f.database.getTopic(f.id).state).toBe("BRAINSTORM_READY");
  await f.action("brainstorm"); await f.done();
  expect(f.calls).toHaveLength(2);
  expect(f.database.getTopic(f.id).state).toBe("BRAINSTORM_READY");
});

// 호스트 리뷰 회귀: 공개 action부터 실행해 v2 계획 연결, 근거 대기/재개, 교정의 실제 어댑터 입력과 채택 발언을 확인한다.
// 아래 세 검사는 수정 전 각각 세션 연결 거부, FAILED 전이, 원본 finding 복원으로 실패한다.
it("hands an operation-only discussion assignment to the default planner under continuity v2", async () => {
  const f = await fixture(async turn => turn.job?.operation === "plan" ? {
    kind: "PLAN", summary: "계획에 필요한 질문", findings: [], evidenceRefs: [], requestedUserDecision: "실험 환경을 알려 주세요.",
    planningStep: { draft: "비교 실험", facts: [], contradictions: [], questions: ["실험 환경"], requests: [], complete: false },
  } : reply("작은 비교 실험"), true);
  await f.post("/api/agent-profiles", { id: "discussion", provider: "codex", model: "gpt-6-astra", effort: "high" });
  await f.post("/api/role-assignments", { scope: `topic:${f.id}`, role: "planner", operation: "brainstorm", participant: "discussion-author", profileId: "discussion", expectedVersion: 0 });
  await f.action("brainstorm"); await f.done();
  expect(f.calls).toHaveLength(2);
  const previousSession = f.database.getTopic(f.id).participants.find(p => p.role === "claude")!.sessionId;
  await f.action("brainstorm-plan", { decision: "비교 실험만 계획합니다." }); await f.done();
  expect(f.calls).toHaveLength(3);
  expect(f.calls[2]).toMatchObject({ provider: "claude", sessionId: undefined, turn: { job: { role: "planner", operation: "plan" } } });
  expect(f.calls[2].turn.prompt).toContain("작은 비교 실험");
  expect(f.database.getTopic(f.id).state).toBe("USER_DECISION_REQUIRED");
  expect(f.database.getTopic(f.id).participants.find(p => p.role === "claude")!.sessionId).not.toBe(previousSession);
  expect(f.database.planning.policyVersion(f.id)).toBe(2);
});

it("defers missing evidence but retries an unaccepted speech when actual source content changes", async () => {
  const entered = latch<void>(); const release = latch<AgentResult>();
  const f = await fixture(async (_turn, index) => { if (index === 1) { entered.resolve(); return release.promise; } return reply("최신 근거의 의견"); });
  cleanups.push(async () => release.resolve(reply()));
  const source = (await f.post(`/api/topics/${f.id}/evidence/sources`, { url: "https://team.atlassian.net/browse/APP-1", label: "논의 근거", mode: "connector", intervalSeconds: 300 })).json();
  const publish = async (revision: string) => {
    const check = (await f.post(`/api/evidence/${source.id}/check`, { force: true })).json();
    expect((await f.post(`/api/evidence/${source.id}/snapshot`, { checkId: check.checkId, revision, units: [{ id: "issue", kind: "issue", content: revision }] })).statusCode).toBe(200);
  };
  await f.action("brainstorm"); await entered.promise;
  expect(f.calls).toHaveLength(1);
  await publish("v2"); release.resolve(reply("OLD EVIDENCE")); await f.done();
  expect(f.database.getTopic(f.id).state).toBe("BLOCKED_ON_EVIDENCE");
  expect(brainstormReplies(f.events(), latestBrainstormRound(f.events())!.sequence)).toHaveLength(0);
  await f.action("retry"); await f.done();
  expect(f.calls).toHaveLength(3);
  expect(f.database.getTopic(f.id).state).toBe("BRAINSTORM_READY");
});

it("a discussion correction keeps no-fanout policy and removes prohibited findings before accepting the speech", async () => {
  const f = await fixture(async (_turn, index) => index === 2 ? { ...reply("잘못된 쟁점 응답"), findings: [{
    id: "B-1", severity: "MEDIUM", title: "논의에 쓰면 안 되는 쟁점", rationale: "가설을 발언으로 설명해야 합니다.", evidenceRefs: [], requiresUserDecision: false,
  }] } : reply("교정한 발언"));
  await f.action("brainstorm"); await f.done();
  expect(f.calls).toHaveLength(3);
  expect.soft(turnPolicy(f.calls[2].turn.job!, {})).toMatchObject({ access: "read", fanout: false });
  expect(f.database.getTopic(f.id).state).toBe("BRAINSTORM_READY");
  const replies = brainstormReplies(f.events(), latestBrainstormRound(f.events())!.sequence);
  expect(replies).toHaveLength(2);
  expect(replies[1].body).toBe("교정한 발언");
});
