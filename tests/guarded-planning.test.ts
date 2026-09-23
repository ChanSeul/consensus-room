import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import { guardedPlanning } from "../src/server/guardedPlanning";
import { BudgetController } from "../src/server/budgetController";
import { PlanningReader, utf8Slice } from "../src/server/planningReader";
import { PLANNING_LIMITS, type PlanningStep } from "../src/shared/planningControl";
import { WorkflowEngine } from "../src/server/workflow";
import { ArtifactStore } from "../src/server/artifacts";
import type { AgentAdapter, SessionTurn, TurnUsage } from "../src/server/types";
import type { AgentResult } from "../src/shared/contracts";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const clean of cleanups.splice(0).reverse()) clean(); });
function setup(role: "claude" | "codex" = "claude", executionInput = 100000) {
  const root = mkdtempSync(join(tmpdir(), "guarded-planning-"));
  const repo = join(root, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@example.invalid"]);
  writeFileSync(join(repo, "form.swift"), "let step = 0\n".repeat(6000));
  execFileSync("git", ["-C", repo, "add", "."]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "fixture"]);
  const database = new ConsensusDatabase(join(root, "room.db"));
  const topic = database.createTopic({ id: "topic", slug: "test", title: "Plan existing step navigation",
    repositoryPath: repo, worktreePath: repo, baseRef: "HEAD", branchName: null,
    state: role === "claude" ? "CLAUDE_PLAN" : "CODEX_AUDIT", scopeGeneration: 1, planRevision: 0,
    planSHA256: null, approvedPlanSHA256: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  database.planning.enable(topic.id);
  database.budgets.configure(topic.id, { execution: { inputTokens: executionInput, outputTokens: 10000, durationMs: 100000 },
    total: { inputTokens: 300000, outputTokens: 30000, durationMs: 300000 } }, "test");
  const git = new GitService(new SpawnCommandRunner());
  cleanups.push(() => rmSync(root, { recursive: true, force: true }), () => database.close());
  return { root, repo, database, git, topic };
}
const step = (patch: Partial<PlanningStep> = {}): PlanningStep => ({
  draft: "Preserve existing navigation", facts: [], contradictions: [], questions: ["Where is step stored?"],
  requests: [], complete: false, ...patch,
});
const answer = (s: PlanningStep): AgentResult => ({ kind: "PLAN", summary: "Planning",
  findings: [], evidenceRefs: [], planningStep: s, ...(s.complete ? { planMarkdown: "Final navigation plan" } : {}) });
function scripted(callback: (turn: Omit<SessionTurn, "sessionId">, call: number) => Promise<AgentResult>, role: "claude" | "codex" = "claude") {
  const calls: Array<Omit<SessionTurn, "sessionId">> = [];
  const run = async (turn: Omit<SessionTurn, "sessionId">, resumedSessionId?: string) => {
    calls.push(turn);
    const id = resumedSessionId ?? `session-${calls.length}`;
    turn.onSessionCreated?.(id);
    turn.onProcessSpawn?.({ pid: 123, pgid: 123, executable: "fake", commandLine: "fake", startedAt: "now" });
    turn.onUsage?.({ inputTokens: 100, cachedInputTokens: 80, outputTokens: 20, durationMs: 30,
      internalRequests: 2, costUSD: 0.25, inputBytes: 1000, recordKind: "final", completeness: "complete" });
    return { sessionId: id, result: await callback(turn, calls.length) };
  };
  const adapter: AgentAdapter = { role, createSession: run, resumeTurn: async t => (await run(t, t.sessionId)).result,
    validateExistingSession: async () => true };
  return { calls, adapter };
}

// Public boundary: BudgetController -> guarded adapter -> scripted model -> final result consumed by planning pipeline.
// No historical bug restoration: new protocol. Fake models reproduce reads, cancellation, and incomplete replies;
// native CLI permission enforcement is separately tested and is not claimed by this suite.
it("collects bounded snapshot evidence before returning one final plan and reserves only one logical attempt", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => n === 1 ? answer(step({ requests: [
    { kind: "file", selector: "form.swift", question: "Find step ownership", offset: 0 },
  ] })) : answer(step({ questions: [], complete: true })));
  const wrapped = new BudgetController(database.budgets, () => ({ topicId: "topic", accounts: ["topic"], stage: "CLAUDE_PLAN" }),
    async () => {}, database.revisions, true, database.reviews, database).wrap(guardedPlanning(fake.adapter, database, git));
  const usage: TurnUsage[] = [];
  const result = await wrapped.createSession({ cwd: repo, prompt: "Plan navigation without edits.", onUsage: u => usage.push(u) });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(result.result.planningStep).toBeUndefined();
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1].prompt).toContain("let step = 0");
  expect(fake.calls.every(c => c.planningControl && Buffer.byteLength(c.prompt) < PLANNING_LIMITS.promptBytes)).toBe(true);
  expect(database.budgets.account("topic")!.used.inputTokens).toBe(200);
  expect(database.revisions.account("topic").firstPlanUsed).toBe(true);
  expect(database.revisions.account("topic").used).toBe(0);
  expect(database.planning.latest("topic")!.finalized).toBe(true);
  expect(usage.at(-1)).toMatchObject({ internalRequests: 4, costUSD: 0.5, inputBytes: 2000, inputTokens: 200 });
  let restoredSession = "";
  await wrapped.resumeTurn({ cwd: repo, prompt: "Plan navigation without edits.", sessionId: "stale-participant",
    onSessionCreated: id => { restoredSession = id; } });
  expect(restoredSession).toBe("session-2");
  expect(fake.calls).toHaveLength(2);
});

it("persists interrupted progress and retries without refunding or double charging the previous attempt", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => {
    if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
    if (n === 2) throw new Error("simulated process interruption");
    return answer(step({ questions: [], complete: true }));
  });
  const wrap = () => new BudgetController(database.budgets, () => ({ topicId: "topic", accounts: ["topic"], stage: "CLAUDE_PLAN" }),
    async () => {}, database.revisions, true, database.reviews, database).wrap(guardedPlanning(fake.adapter, database, git));
  await expect(wrap().createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interruption");
  const before = database.planning.latest("topic")!;
  expect(before.step.draft).toContain("Preserve");
  expect(before.round).toBe(2);
  await wrap().createSession({ cwd: repo, prompt: "Plan" });
  expect(database.planning.latest("topic")!.id).toBe(before.id);
  expect(database.budgets.account("topic")!.used.inputTokens).toBe(300);
  expect(database.planning.latest("topic")!.usage.inputTokens).toBe(300);
  expect(database.revisions.account("topic").used).toBe(0);
});

it("rejects an oversized mandatory prompt before any model call and preserves a checkpoint", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async () => answer(step({ questions: [], complete: true })));
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo,
    prompt: "x".repeat(PLANNING_LIMITS.promptBytes + 1) })).rejects.toThrow("packet limit");
  expect(fake.calls).toHaveLength(0);
  expect(database.planning.latest("topic")!.finalized).toBe(false);
});

it("does not promote a completed claim with unanswered questions", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async () => answer(step({ complete: true })));
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Incomplete");
  expect(database.planning.latest("topic")!.finalized).toBe(false);
});

it("detects worktree changes between model response and adoption", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async () => { writeFileSync(join(repo, "new.swift"), "new state"); return answer(step({ questions: [], complete: true })); });
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Working tree changed");
  expect(database.planning.latest("topic")!.finalized).toBe(false);
});

it("reads dirty snapshot content, rejects symlinks/credential paths and paginates UTF-8 without losing bytes", async () => {
  const { repo, git } = setup();
  const content = "한글🙂".repeat(3000);
  writeFileSync(join(repo, "form.swift"), content);
  symlinkSync("form.swift", join(repo, "link.swift"));
  const tree = await git.writeWorkingTree(repo, "test");
  const reader = new PlanningReader(repo, tree, new Map());
  let offset = 0; let reconstructed = "";
  do {
    const result = await reader.read({ kind: "file", selector: "form.swift", question: "Read", offset });
    expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(PLANNING_LIMITS.fragmentBytes);
    reconstructed += result.content;
    if (result.nextOffset === null) break;
    offset = result.nextOffset;
  } while (true);
  expect(reconstructed).toBe(content);
  for (const selector of ["link.swift", "../outside", ".env", "/etc/passwd"]) {
    await expect(reader.read({ kind: "file", selector, question: "Read", offset: 0 })).rejects.toThrow();
  }
  expect(() => utf8Slice("한", 1, 100)).toThrow("UTF-8");
});

it("checkpoints oversized mandatory instructions before dispatch without truncating them", async () => {
  const { repo, database, git } = setup();
  writeFileSync(join(repo, "CLAUDE.md"), "필수 규칙".repeat(10000));
  const fake = scripted(async () => answer(step({ questions: [], complete: true })));
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("silently truncated");
  expect(fake.calls).toHaveLength(0);
  expect(database.planning.latest("topic")?.stopped).toContain("instruction");
});

it("limits one attempt to eight research calls and one synthesis, including duplicate retries", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => n === 9
    ? (expect(turn.prompt).toContain("No more research"), answer(step({ questions: [], complete: true })))
    : answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Continue", offset: (n - 1) * 100 }] })));
  const adapter = guardedPlanning(fake.adapter, database, git);
  const first = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  const again = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(again).toEqual(first);
  expect(fake.calls).toHaveLength(9);
  expect(database.planning.latest("topic")?.usage.inputTokens).toBe(900);
});

it("stops research at the soft limit and does not fetch a newly requested source", async () => {
  const { repo, database, git } = setup("claude", 500);
  const fake = scripted(async (_turn, n) => answer(step({ requests: [{ kind: "file",
    selector: n === 4 ? "missing.swift" : "form.swift", question: "Continue", offset: (n - 1) * 100 }] })));
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" }))
    .rejects.toThrow("insufficient remaining budget");
  expect(fake.calls).toHaveLength(4);
  expect(database.planning.latest("topic")?.step.requests[0].selector).toBe("missing.swift");
});

it("revalidates changed source snapshots on retry without resetting usage or rounds", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
    if (n === 2) throw new Error("connection interrupted");
    expect(turn.prompt).toContain("Sources changed");
    expect(turn.prompt).not.toContain("let step = 0");
    return answer(step({ questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
  const id = database.planning.latest("topic")!.admissionId;
  writeFileSync(join(repo, "form.swift"), "let step = 42");
  await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(database.planning.latest("topic")).toMatchObject({ admissionId: id, round: 3, usage: { inputTokens: 300 } });
});

it("does not reuse a final response after a newer user decision", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async () => answer(step({ questions: [], complete: true })));
  const adapter = guardedPlanning(fake.adapter, database, git);
  await adapter.createSession({ cwd: repo, prompt: "Plan" });
  database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", body: "Preserve the old form", state: "CLAUDE_PLAN" });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("New user decisions");
  expect(fake.calls).toHaveLength(1);
});

it("survives a database reopen and preserves the logical attempt", async () => {
  const { root, repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => {
    if (n === 1) throw new Error("lost connection");
    return answer(step({ questions: [], complete: true }));
  });
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("lost");
  const old = database.planning.latest("topic")!;
  // A second connection exercises serialized checkpoint recovery; no in-memory wrapper state is shared.
  const reopened = new ConsensusDatabase(join(root, "room.db"));
  try {
    await guardedPlanning(fake.adapter, reopened, git).createSession({ cwd: repo, prompt: "Plan" });
    expect(reopened.planning.latest("topic")).toMatchObject({ id: old.id, admissionId: old.admissionId,
      round: 2, usage: { inputTokens: 200 } });
  } finally { reopened.close(); }
});

it("stops after two rounds with no new evidence and never approves the partial draft", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async () => answer(step()));
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" }))
    .rejects.toThrow("no new evidence");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")?.finalized).toBe(false);
});

it("excludes secrets from literal searches and cannot turn the path into a Git pathspec", async () => {
  const { repo, git } = setup();
  writeFileSync(join(repo, ".env"), "TEST_SECRET_MARKER=never");
  writeFileSync(join(repo, "auth.json"), '{"TEST_SECRET_MARKER":"never"}');
  const reader = new PlanningReader(repo, await git.writeWorkingTree(repo, "search"), new Map());
  const request = { kind: "search" as const, selector: ".::TEST_SECRET_MARKER", question: "Find", offset: 0 };
  expect((await reader.read(request)).content).toBe("");
  expect((await reader.read({ ...request, selector: ":(top)**::let step" })).content).toBe("");
});

it("keeps the Codex review session across reads and never replaces an unmeasured legacy session", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (_turn, n) => n === 1 ? answer(step({ requests: [
    { kind: "file", selector: "form.swift", question: "Read", offset: 0 },
  ] })) : answer(step({ questions: [], complete: true })), "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  await adapter.createSession({ cwd: repo, prompt: "Review" });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
  await expect(adapter.resumeTurn({ cwd: repo, prompt: "A new review stage", sessionId: "legacy-review" }))
    .rejects.toThrow("context is unknown");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")?.sessionId).toBe("legacy-review");
});

it("does not continue a paid research loop when usage was not reported", async () => {
  const { repo, database, git } = setup();
  let calls = 0;
  const createSession: AgentAdapter["createSession"] = async turn => {
    calls++; turn.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: "now" });
    return { sessionId: "unknown-usage", result: answer(step({ requests: [
      { kind: "file", selector: "form.swift", question: "Read", offset: 0 },
    ] })) };
  };
  const adapter: AgentAdapter = { role: "claude", createSession, resumeTurn: async t => (await createSession(t)).result,
    validateExistingSession: async () => true };
  await expect(guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Usage is incomplete");
  expect(calls).toBe(1);
  expect(database.planning.latest("topic")?.finalized).toBe(false);
});

it("public workflow retry preserves the epoch and blocks a malformed final result without an unguarded repair", async () => {
  const { root, repo, database, git } = setup();
  database.updateTopic("topic", { state: "DRAFT" });
  for (const role of ["claude", "codex"] as const) database.upsertParticipant("topic", {
    role, sessionId: `${role}-existing`, mode: "attached", acknowledgedPlanSHA256: null,
  });
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
    if (n === 2) throw new Error("transport interrupted");
    expect(turn.prompt).toContain("Keep the address screen unchanged");
    return answer(step({ questions: [], complete: true })); // Deliberately fails the real plan-heading contract.
  });
  const codex = scripted(async () => { throw new Error("Audit must not start"); }, "codex");
  const engine = new WorkflowEngine({ database, git, artifacts: new ArtifactStore(join(root, "artifacts"), database),
    claude: guardedPlanning(fake.adapter, database, git), codex: codex.adapter });
  const settle = async () => {
    const deadline = Date.now() + 5000;
    while (database.runningAction("topic")) {
      if (Date.now() > deadline) throw new Error("Workflow did not complete");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  engine.startPlan("topic"); await settle();
  const checkpoint = database.planning.latest("topic")!;
  expect(fake.calls).toHaveLength(2);
  expect(database.getTopic("topic").state).toBe("FAILED");
  await engine.postMessage("topic", "decision", "Keep the address screen unchanged");
  engine.retry("topic"); await settle();
  expect(fake.calls).toHaveLength(3);
  expect(database.getTopic("topic")).toMatchObject({ state: "USER_DECISION_REQUIRED", planEpoch: checkpoint.planEpoch, approvedPlanSHA256: null });
  expect(database.planning.latest("topic")).toMatchObject({ id: checkpoint.id, finalized: false });
  expect(database.getTopic("topic").participants.find(p => p.role === "claude")?.sessionId).toBe("session-3");
  expect(database.planning.latest("topic")?.sessions).toEqual(["session-1", "session-2", "session-3"]);
  expect(database.revisions.account("topic").used).toBe(0);
  expect(codex.calls).toHaveLength(0);
  await engine.shutdown();
});

it("rebases an interrupted plan onto new user decisions without buying a new attempt", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) throw new Error("interrupted");
    expect(turn.prompt).toContain("Keep the address screen unchanged");
    expect(turn.prompt).toContain("Sources changed");
    return answer(step({ questions: [], complete: true }));
  });
  const wrap = () => new BudgetController(database.budgets, () => ({ topicId: "topic", accounts: ["topic"], stage: "CLAUDE_PLAN" }),
    async () => {}, database.revisions, true, database.reviews, database).wrap(guardedPlanning(fake.adapter, database, git));
  await expect(wrap().createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
  const original = database.planning.latest("topic")!;
  database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_PLAN", body: "Keep the address screen unchanged" });
  await wrap().createSession({ cwd: repo, prompt: "Plan with decision: Keep the address screen unchanged" });
  const current = database.planning.latest("topic")!;
  expect(current).toMatchObject({ id: original.id, admissionId: original.admissionId, round: 2, finalized: true });
  expect(current.inputSequence).toBeGreaterThan(original.inputSequence);
  expect(database.revisions.account("topic").used).toBe(0);
  expect(database.budgets.account("topic")?.used.inputTokens).toBe(200);
  await wrap().createSession({ cwd: repo, prompt: current.prompt });
  expect(fake.calls).toHaveLength(2);
});

it("delivers approved out-of-tree diagnosis artifacts in bounded pieces, rejecting unlisted paths", async () => {
  const { root, repo, database, git } = setup();
  const path = join(root, "diagnosis.md");
  writeFileSync(path, "bodyline\n".repeat(5000) + "REQUIRED_VALIDATION_AFTER_PREVIEW");
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [{ kind: "artifact", selector: path, question: "Read full validation criteria", offset: 40000 }] }));
    expect(turn.prompt).toContain("REQUIRED_VALIDATION_AFTER_PREVIEW");
    expect(turn.readablePaths).not.toContain(path);
    return answer(step({ questions: [], complete: true }));
  });
  await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan diagnosis", readablePaths: [path] });
  const reader = new PlanningReader(repo, await git.writeWorkingTree(repo, "artifact-test"), new Map());
  await expect(reader.read({ kind: "artifact", selector: path, question: "Unlisted", offset: 0 })).rejects.toThrow("pinned manifest");
});
