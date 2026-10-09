import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { buildApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { ConsensusDatabase } from "../src/server/database";
import { EngineCore } from "../src/server/engine/core";
import { ArtifactStore } from "../src/server/artifacts";
import { GitService } from "../src/server/git";
import { resolveRoute } from "../src/server/turnRouting";
import { buildSessionGraph } from "../src/server/sessionGraph";
import { readSessionSettings } from "../src/server/sessionSettings";
import type { SessionSettingsView } from "../src/shared/sessionSettings";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

async function room() {
  const root = mkdtempSync(join(tmpdir(), "session-settings-")), database = new ConsensusDatabase(join(root, "db.sqlite"));
  database.createTopic({ workflowMode: "planned", id: "t", slug: "t", title: "t", repositoryPath: root, worktreePath: root, baseRef: "HEAD", branchName: null,
    state: "CODEX_AUDIT", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  const calls: Array<Omit<SessionTurn, "sessionId">> = [], participants: string[] = [];
  let fail = false;
  const result = { kind: "AUDIT" as const, summary: "review", findings: [], evidenceRefs: [] };
  const adapter: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
    createSession: async turn => { calls.push(turn); if (fail) throw new Error("provider interrupted"); return { sessionId: "review-session", result }; },
    resumeTurn: async turn => { calls.push(turn); if (fail) throw new Error("provider interrupted"); return result; } };
  const claude = { ...adapter, role: "claude" as const };
  const runner = { run: async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] }) };
  const config = loadConfig({ dataDirectory: root, repositoryPath: root, launchToken: "test", webDirectory: join(root, "no-web"), enforceBudgets: false });
  const app = await buildApp({ config, database, runner, claude, codex: adapter });
  const core = new EngineCore({ database, artifacts: new ArtifactStore(join(root, "topics"), database), git: new GitService(runner), claude, codex: adapter });
  cleanup.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const headers = { "x-consensus-token": "test" };
  const get = async (target = "plan-review") => {
    const response = await app.inject({ url: `/api/topics/t/session-settings?target=${target}`, headers });
    expect(response.statusCode).toBe(200); return response.json() as SessionSettingsView;
  };
  const post = (body: object, extra = {}) => app.inject({ method: "POST", url: "/api/topics/t/session-settings", headers: { ...headers, "idempotency-key": randomUUID(), ...extra }, payload: body });
  const turn = async (ledger?: string, rejectContract = false) => {
    await new Promise<void>((resolve, reject) => {
      core.startAction("t", "settings-test", async signal => {
        try {
          const topic = database.getTopic("t"), route = resolveRoute(database, topic, { role: "reviewer", operation: ledger ? "review" : "audit" });
          participants.push(route.participant);
          if (ledger) route.reviewLedger = ledger;
          if (rejectContract) await core.turn(route, topic, "계획 검토", signal, {
            session: { id: null, persist: () => undefined }, check: () => { throw new Error("post-response contract failure"); },
          });
          else await core.executor.execute({ topic, route, signal, purpose: "턴", inputSequence: database.timelineCount("t"), expected: core.expectationOf(topic),
            session: { mode: "create" }, prompt: "기존 필수 검토 규칙과 결과 형식을 유지하세요.", settings: route.settings });
          resolve();
        } catch (error) { reject(error); }
      });
    });
    // Observe action completion, not a guessed delay.
    while (database.runningAction("t")) await new Promise(resolve => setImmediate(resolve));
  };
  return { database, calls, participants, get, post, turn, setFail: (value: boolean) => { fail = value; } };
}

it("user POST reaches the next reviewer request and freezes criteria across interrupted resume", async () => {
  const f = await room();
  f.database.roles.createProfile({ id: "registered-model", provider: "codex", model: "gpt-6-astra", effort: "high", options: {} });
  f.database.roles.createProfile({ id: "other-provider", provider: "claude", model: "claude-opus-5-5", effort: "high", options: {} });
  const first = await f.get();
  expect(first.models).toContain("gpt-6-astra");
  expect(first.models).not.toContain("claude-opus-5-5");
  const save = (view: SessionSettingsView, text: string) => f.post({ target: "plan-review", revision: view.revision, model: "gpt-6-astra", effort: "medium",
    criteria: { selectedIds: ["efficiency"], additionalText: text } });
  expect((await save(first, "첫 기준")).statusCode).toBe(200);
  f.setFail(true);
  await expect(f.turn()).rejects.toThrow("provider interrupted");
  while (f.database.runningAction("t")) await new Promise(resolve => setImmediate(resolve));
  expect(f.calls[0].settings).toMatchObject({ model: "gpt-6-astra", effort: "medium" });
  expect(f.calls[0].prompt).toContain("첫 기준");
  expect(f.calls[0].prompt).toContain("불필요한 모델 호출");
  expect(f.calls[0].prompt).toContain("기존 필수 검토 규칙");
  expect((await save(await f.get(), "새 기준")).statusCode).toBe(200);
  const assignment = f.database.roles.assignment("topic:t", "reviewer", "audit")!;
  f.database.roles.assign({ ...assignment, participant: "replacement-reviewer", expectedVersion: assignment.version });
  f.setFail(false);
  await f.turn();
  expect(f.participants[1]).toBe("replacement-reviewer");
  expect(f.calls[1].prompt).toContain("첫 기준");
  expect(f.calls[1].prompt).not.toContain("새 기준");
  // Only a new plan contract starts a new logical audit, not an adapter response.
  f.database.updateTopic("t", { planSHA256: "b".repeat(64) });
  await f.turn();
  expect(f.calls[2].prompt).toContain("새 기준");
  expect(f.database.sessions.forTopic("t")).toEqual([]); // no actual spawn callback from this adapter
});

it("rejects readonly, stale, provider and unsupported model edits without partial assignments", async () => {
  const f = await room(), view = await f.get();
  const body = { target: "plan-review", revision: view.revision, model: view.models[0], effort: "medium" };
  expect((await f.post({ ...body, provider: "claude" })).statusCode).toBe(400);
  expect((await f.post({ ...body, model: "invented-model" })).statusCode).toBe(400);
  expect(f.database.roles.list()).toEqual([]);
  expect((await f.post(body, { "x-consensus-actor": "mediator" })).statusCode).toBe(403);
  for (const target of ["mediator", "verifier", "host-reviewer"]) {
    expect(await f.get(target)).toMatchObject({ editable: false, reason: expect.any(String) });
    expect((await f.post({ ...body, target })).statusCode).toBe(403);
  }
  const global = f.database.roles.createProfile({ id: "global-review", provider: "codex", model: view.models[0], effort: "high", options: {} });
  f.database.roles.assign({ scope: "global", role: "reviewer", operation: "", profileId: global.id, participant: "reviewer", sessionId: null, note: "", expectedVersion: 0 });
  expect((await f.post(body)).statusCode).toBe(409);
  expect(f.database.roles.list("topic:t")).toEqual([]);
  const fresh = await f.get();
  expect((await f.post({ ...body, revision: fresh.revision })).statusCode).toBe(200);
  expect(f.database.roles.list("topic:t")).toHaveLength(2);
  expect(f.database.roles.list("topic:t").every(a => a.participant === "reviewer")).toBe(true);
});

it("mixed providers are readonly and inherited suboperations are not fictitious edit targets", async () => {
  const f = await room();
  const profile = f.database.roles.createProfile({ id: "claude-review", provider: "claude", model: "claude-opus-5-5", effort: "high", options: {} });
  f.database.roles.assign({ scope: "topic:t", role: "reviewer", operation: "audit", profileId: profile.id, participant: "reviewer", sessionId: null, note: "", expectedVersion: 0 });
  expect(await f.get()).toMatchObject({ editable: false, reason: expect.stringContaining("공급자") });
  expect(readSessionSettings(f.database, "t", "implementer").operations.map(row => row.operation)).toEqual(["implement", "fix"]);
  const graph = buildSessionGraph(f.database, "t", { nodes: [], edges: [] });
  expect(graph.nodes.filter(node => node.kind === "session").every(node => node.environment === undefined)).toBe(true);
});

it("one code-review ledger retains its criteria and a new logical ledger adopts the next settings", async () => {
  const f = await room();
  const save = async (text: string) => {
    const view = await f.get("code-review");
    expect((await f.post({ target: "code-review", revision: view.revision, model: view.models[0], effort: "high",
      criteria: { selectedIds: ["tests"], additionalText: text } })).statusCode).toBe(200);
  };
  await save("고정 리뷰 관점");
  await f.turn("logical-review-1");
  await save("다음 리뷰 관점");
  await f.turn("logical-review-1");
  expect(f.calls[1].prompt).toContain("고정 리뷰 관점");
  expect(f.calls[1].prompt).not.toContain("다음 리뷰 관점");
  await f.turn("logical-review-2");
  expect(f.calls[2].prompt).toContain("다음 리뷰 관점");
});


it("a failed second assignment rolls back both profiles and all topic assignments", async () => {
  const f = await room(), view = await f.get();
  const assign = f.database.roles.assign.bind(f.database.roles);
  let calls = 0;
  const spy = vi.spyOn(f.database.roles, "assign").mockImplementation(input => {
    if (++calls === 2) throw new Error("storage failure");
    return assign(input);
  });
  try {
    expect((await f.post({ target: "plan-review", revision: view.revision, model: view.models[0], effort: "medium" })).statusCode).toBe(500);
    expect(f.database.roles.list("topic:t")).toEqual([]);
    expect(f.database.roles.profiles()).toEqual([]);
  } finally { spy.mockRestore(); }
});


it("a model response followed by real core contract rejection does not release the frozen audit criteria", async () => {
  const f = await room();
  const save = async (text: string) => {
    const view = await f.get();
    expect((await f.post({ target: "plan-review", revision: view.revision, model: view.models[0], effort: "high",
      criteria: { selectedIds: [], additionalText: text } })).statusCode).toBe(200);
  };
  f.database.upsertParticipant("t", { role: "codex", sessionId: "review-session", mode: "attached", acknowledgedPlanSHA256: null });
  await save("계약 실패 전 기준");
  await expect(f.turn(undefined, true)).rejects.toThrow("post-response contract failure");
  while (f.database.runningAction("t")) await new Promise(resolve => setImmediate(resolve));
  expect(f.calls.some(call => call.job?.operation === "contract-correction")).toBe(true);
  await save("저장된 다음 기준");
  await f.turn();
  expect(f.calls.at(-1)!.prompt).toContain("계약 실패 전 기준");
  expect(f.calls.at(-1)!.prompt).not.toContain("저장된 다음 기준");
});
