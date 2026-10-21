import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { ArtifactStore } from "../src/server/artifacts";
import { loadConfig } from "../src/server/config";
import { ConsensusDatabase } from "../src/server/database";
import { EngineCore } from "../src/server/engine/core";
import { GitService } from "../src/server/git";
import { resolveRoute } from "../src/server/turnRouting";
import type { TurnJob } from "../src/shared/roles";
import type { SessionSettingsView } from "../src/shared/sessionSettings";
import type { AgentAdapter, SessionTurn } from "../src/server/types";

// 2026-10-18 사용자 지시 "중재자한테 fast mode on/off 부탁하면 바로 처리" — 토픽·묶음 속도 설정이 모든 Codex 작업에 다음 턴부터 적용되는지 본다.
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

const audit: TurnJob = { role: "reviewer", operation: "audit" };
const review: TurnJob = { role: "reviewer", operation: "review" };
const plan: TurnJob = { role: "planner", operation: "plan" };

async function room() {
  const root = mkdtempSync(join(tmpdir(), "codex-speed-")), database = new ConsensusDatabase(join(root, "db.sqlite"));
  const topic = (id: string) => database.createTopic({ workflowMode: "planned", id, slug: id, title: id, repositoryPath: root, worktreePath: root, baseRef: "HEAD",
    branchName: null, state: "CODEX_AUDIT", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  topic("t");
  database.roles.createProfile({ id: "mediator-profile", provider: "codex", model: "test-model", effort: "medium", options: {} });
  database.roles.assign({ scope: "global", role: "mediator", operation: "", profileId: "mediator-profile", participant: "owner", sessionId: "mediator-session",
    expectedVersion: 0, note: "test" });
  const calls: Array<Omit<SessionTurn, "sessionId">> = [];
  const result = { kind: "AUDIT" as const, summary: "review", findings: [], evidenceRefs: [] };
  const codex: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
    createSession: async turn => { calls.push(turn); return { sessionId: "review-session", result }; },
    resumeTurn: async turn => { calls.push(turn); return result; } };
  const claude = { ...codex, role: "claude" as const };
  const runner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] }) };
  const config = loadConfig({ dataDirectory: root, repositoryPath: root, launchToken: "test", webDirectory: join(root, "no-web"), enforceBudgets: false });
  const app = await buildApp({ config, database, runner, claude, codex });
  const core = new EngineCore({ database, artifacts: new ArtifactStore(join(root, "topics"), database), git: new GitService(runner), claude, codex });
  cleanup.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const mediator = { "x-consensus-token": "test", "x-consensus-actor": "mediator", "x-consensus-mediator": "owner", "x-consensus-mediator-version": "1" };
  const speed = (url: string, payload: object, headers: Record<string, string> = mediator) =>
    app.inject({ method: "POST", url, headers: { ...headers, "idempotency-key": randomUUID() }, payload });
  const view = async (topicId = "t") => {
    const response = await app.inject({ url: `/api/topics/${topicId}/codex-speed`, headers: { "x-consensus-token": "test" } });
    expect(response.statusCode).toBe(200);
    return response.json() as { topicSetting: unknown; group: { id: string } | null;
      operations: Array<{ role: string; operation: string; serviceTier?: string; source?: string; profileId?: string | null; error?: string }> };
  };
  const route = (job: TurnJob, topicId = "t") => resolveRoute(database, database.getTopic(topicId), job);
  const profile = (id: string, options: Record<string, unknown> = {}) =>
    database.roles.createProfile({ id, provider: "codex", model: "gpt-6-astra", effort: "xhigh", options });
  const assign = (operation: string, profileId: string, topicId = "t") => {
    const current = database.roles.assignment(`topic:${topicId}`, "reviewer", operation);
    return database.roles.assign({ scope: `topic:${topicId}`, role: "reviewer", operation, participant: "codex-reviewer", profileId, sessionId: null,
      expectedVersion: current?.version ?? 0, note: "" });
  };
  return { root, database, app, core, calls, topic, speed, view, route, profile, assign, mediator };
}

it("토픽 fast 는 작업별 배정에 가려지지 않고 모든 Codex 작업에 적용되며 모델·Claude 경로는 그대로다", async () => {
  const r = await room();
  r.profile("reviewer-all"); r.profile("reviewer-audit");
  r.assign("", "reviewer-all"); r.assign("audit", "reviewer-audit");
  expect(r.route(audit).options).toEqual({});

  const response = await r.speed("/api/topics/t/codex-speed", { mode: "fast", reason: "사용자: fast 켜 줘" });
  expect(response.statusCode).toBe(200);
  expect(r.route(audit)).toMatchObject({ profileId: "reviewer-audit", settings: { model: "gpt-6-astra", effort: "xhigh" }, options: { serviceTier: "fast" },
    speed: { serviceTier: "fast", source: "topic" } });
  expect(r.route(review)).toMatchObject({ profileId: "reviewer-all", options: { serviceTier: "fast" } });
  // Claude 로 가는 기본 계획 경로는 속도 설정과 무관하다.
  expect(r.route(plan)).toMatchObject({ provider: "claude", options: {} });
  expect(r.route(plan).speed).toBeUndefined();

  const shown = await r.view();
  const codexOps = shown.operations.filter(op => !op.error);
  expect(codexOps.length).toBeGreaterThan(0);
  expect(codexOps.every(op => op.serviceTier === "fast" && op.source === "topic")).toBe(true);
  expect(codexOps.find(op => op.operation === "audit")).toMatchObject({ profileId: "reviewer-audit" });
  expect(shown.operations.some(op => op.role === "planner")).toBe(false);
  expect(r.database.getTimeline("t").some(event => event.body.includes("Codex 속도 토픽: fast") && event.body.includes("사용자: fast 켜 줘"))).toBe(true);
});

it("standard 는 프로필의 fast 를 끄고 inherit 은 프로필 값으로 돌아간다", async () => {
  const r = await room();
  r.profile("reviewer-fast", { serviceTier: "fast" });
  r.assign("", "reviewer-fast");
  expect(r.route(audit).options).toEqual({ serviceTier: "fast" });
  expect((await r.view()).operations.find(op => op.operation === "audit")).toMatchObject({ serviceTier: "fast", source: "profile" });

  expect((await r.speed("/api/topics/t/codex-speed", { mode: "standard", reason: "사용자: fast 꺼 줘" })).statusCode).toBe(200);
  expect(r.route(audit).options).toEqual({});
  expect((await r.view()).operations.find(op => op.operation === "audit")).toMatchObject({ serviceTier: "standard", source: "topic" });

  expect((await r.speed("/api/topics/t/codex-speed", { mode: "inherit", reason: "사용자: 원래대로" })).statusCode).toBe(200);
  expect(r.route(audit).options).toEqual({ serviceTier: "fast" });
  const shown = await r.view();
  expect(shown.topicSetting).toBeNull();
  expect(shown.operations.find(op => op.operation === "audit")).toMatchObject({ serviceTier: "fast", source: "profile" });
});

it("묶음 설정은 연결된 단계와 나중에 연결되는 단계에 적용되고 토픽 설정이 묶음보다 앞선다", async () => {
  const r = await room();
  r.database.workGroups.create("group", { title: "작업", goal: "목표", contracts: "계약", stages: [
    { id: "a", kind: "work", title: "a", goal: "a", acceptance: "a", dependsOn: [] },
    { id: "b", kind: "integration", title: "b", goal: "b", acceptance: "b", dependsOn: ["a"] }] }, r.root, "base");
  r.database.workGroups.link("group", "a", "t", "base");

  const response = await r.speed("/api/work-groups/group/codex-speed", { mode: "fast", reason: "사용자: 이 묶음 fast" });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ groupId: "group", setting: { serviceTier: "fast" }, stages: [{ stageId: "a", topicId: "t" }] });
  expect(r.route(audit)).toMatchObject({ options: { serviceTier: "fast" }, speed: { source: "group", scope: "group:group" } });
  expect(r.database.getTimeline("t").some(event => event.body.includes("Codex 속도 묶음 group: fast"))).toBe(true);

  // 설정 뒤에 연결된 단계 토픽도 다시 걸지 않고 묶음 값을 쓴다.
  r.topic("t2");
  r.database.workGroups.link("group", "b", "t2", "base");
  expect(r.route(audit, "t2")).toMatchObject({ options: { serviceTier: "fast" }, speed: { source: "group" } });
  expect((await r.view("t2")).group).toMatchObject({ id: "group" });

  expect((await r.speed("/api/topics/t/codex-speed", { mode: "standard", reason: "사용자: 이 단계만 끄기" })).statusCode).toBe(200);
  expect(r.route(audit).speed).toMatchObject({ serviceTier: "standard", source: "topic" });
  expect(r.route(audit).options).toEqual({});
  expect(r.route(audit, "t2").options).toEqual({ serviceTier: "fast" });
});

it("세션 설정 저장은 토픽 속도를 새 프로필에 굽지 않는다", async () => {
  const r = await room();
  expect((await r.speed("/api/topics/t/codex-speed", { mode: "fast", reason: "사용자: fast" })).statusCode).toBe(200);
  const headers = { "x-consensus-token": "test" };
  const current = (await r.app.inject({ url: "/api/topics/t/session-settings?target=plan-review", headers })).json() as SessionSettingsView;
  expect(current.editable).toBe(true);
  const saved = await r.app.inject({ method: "POST", url: "/api/topics/t/session-settings", headers: { ...headers, "idempotency-key": randomUUID() },
    payload: { target: "plan-review", revision: current.revision, model: current.models[0], effort: "high" } });
  expect(saved.statusCode).toBe(200);
  const created = r.database.roles.profile(r.route(audit).profileId!);
  expect(created?.id.startsWith("session-settings:")).toBe(true);
  expect(created?.options ?? {}).toEqual({});
  expect(r.route(audit).options).toEqual({ serviceTier: "fast" });
  expect((await r.speed("/api/topics/t/codex-speed", { mode: "inherit", reason: "사용자: 원래대로" })).statusCode).toBe(200);
  expect(r.route(audit).options).toEqual({});
});

it("실행기가 어댑터에 넘기는 공급자 옵션에 토픽 fast 가 실린다", async () => {
  const r = await room();
  expect((await r.speed("/api/topics/t/codex-speed", { mode: "fast", reason: "사용자: fast" })).statusCode).toBe(200);
  await new Promise<void>((resolve, reject) => {
    r.core.startAction("t", "codex-speed-test", async signal => {
      try {
        const topic = r.database.getTopic("t"), route = resolveRoute(r.database, topic, audit);
        await r.core.executor.execute({ topic, route, signal, purpose: "턴", inputSequence: r.database.timelineCount("t"), expected: r.core.expectationOf(topic),
          session: { mode: "create" }, prompt: "기존 필수 검토 규칙과 결과 형식을 유지하세요.", settings: route.settings });
        resolve();
      } catch (error) { reject(error); }
    });
  });
  while (r.database.runningAction("t")) await new Promise(resolve => setImmediate(resolve));
  expect(r.calls.at(-1)?.providerOptions).toEqual({ serviceTier: "fast" });
});

it("속도 조회는 부속 턴을 부모 작업의 경로로 보여 준다(실행과 같은 배정)", async () => {
  const r = await room();
  r.profile("implementer-codex"); r.profile("continue-fast", { serviceTier: "fast" });
  const assignImplementer = (operation: string, profileId: string) => r.database.roles.assign({ scope: "topic:t", role: "implementer", operation,
    participant: "codex-implementer", profileId, sessionId: null, expectedVersion: 0, note: "" });
  assignImplementer("implement", "implementer-codex");
  // 계속 진행에 따로 둔 배정은 실행에 쓰이지 않는다 — 엔진은 지금 작업(implement)의 경로로 연다.
  assignImplementer("continue", "continue-fast");
  const before = (await r.view()).operations.find(op => op.role === "implementer" && op.operation === "continue");
  expect(before).toMatchObject({ inheritsFrom: "implement", profileId: "implementer-codex", serviceTier: "standard", source: "profile" });

  expect((await r.speed("/api/topics/t/codex-speed", { mode: "fast", reason: "사용자: fast" })).statusCode).toBe(200);
  const after = (await r.view()).operations.find(op => op.role === "implementer" && op.operation === "continue");
  expect(after).toMatchObject({ inheritsFrom: "implement", profileId: "implementer-codex", serviceTier: "fast", source: "topic" });
  expect((await r.view()).operations.find(op => op.role === "reviewer" && op.operation === "review-read")).toMatchObject({ inheritsFrom: "review" });
});

it("중재자 요청은 배정이 맞을 때만 받고 사유가 없으면 거부한다", async () => {
  const r = await room();
  const stale = await r.speed("/api/topics/t/codex-speed", { mode: "fast", reason: "사용자: fast" },
    { ...r.mediator, "x-consensus-mediator": "someone-else" });
  expect(stale.statusCode).toBe(409);
  expect(r.route(audit).options).toEqual({});
  expect((await r.speed("/api/topics/t/codex-speed", { mode: "fast", reason: "  " })).statusCode).toBe(400);
  expect((await r.speed("/api/topics/t/codex-speed", { mode: "turbo", reason: "사용자" })).statusCode).toBe(400);
  // 사용자 호출(중재자 헤더 없음)도 같은 API 로 바꾼다.
  expect((await r.speed("/api/topics/t/codex-speed", { mode: "fast", reason: "사용자 직접" }, { "x-consensus-token": "test" })).statusCode).toBe(200);
  expect(r.route(audit).options).toEqual({ serviceTier: "fast" });
});
