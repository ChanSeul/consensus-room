import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
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
import { REQUIRED_PLAN_HEADINGS, type AgentResult } from "../src/shared/contracts";

const cleanups: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); for (const clean of cleanups.splice(0).reverse()) clean(); });
function setup(role: "claude" | "codex" = "claude", executionInput = 100000, executionDuration = 100000, enable = true) {
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
  if (enable) database.planning.enable(topic.id);
  database.budgets.configure(topic.id, { execution: { inputTokens: executionInput, outputTokens: 10000, durationMs: executionDuration },
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
  expect(restoredSession).toBe("session-1");
  expect(fake.calls).toHaveLength(2);
});

it("fulfills intermediate reads without accepting facts that cite undelivered evidence", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({
      facts: [{ statement: "Unverified step behavior", refs: ["context:request"] }],
      requests: [{ kind: "file", selector: "form.swift", question: "Verify step behavior", offset: 0 }],
    }));
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{ id: string }>;
    return answer(step({ facts: [{ statement: "Verified step behavior", refs: [fragments[0].id] }],
      questions: [], complete: true }));
  });
  const result = await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1].prompt).toContain("let step = 0");
  expect(fake.calls[1].prompt).not.toContain('"statement":"Unverified step behavior"');
  const checkpoint = database.planning.latest("topic")!;
  expect(checkpoint.step.facts).toHaveLength(1);
  expect(checkpoint.step.facts[0].statement).toBe("Verified step behavior");
  expect(checkpoint.delivered).toContain(checkpoint.step.facts[0].refs[0]);
});

it("still rejects undelivered facts in a completed checkpoint", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async () => answer(step({ facts: [{ statement: "Unsupported", refs: ["context:request"] }],
    questions: [], complete: true })));
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" }))
    .rejects.toThrow("Checkpoint cites evidence that was not delivered.");
  expect(database.planning.latest("topic")!.finalized).toBe(false);
});

it("reuses a saved intermediate read request after a citation pause without another research call", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
      questions: [], complete: true }));
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{ id: string }>;
    expect(fragments).toHaveLength(1);
    return answer(step({ facts: [{ statement: "Verified", refs: [fragments[0].id] }], questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.lastResponse = answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
    requests: [{ kind: "file", selector: "form.swift", question: "Verify", offset: 0 }] }));
  saved.responsePending = undefined; // Legacy checkpoint created before the explicit rejection marker.
  database.planning.save(saved);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")!.round).toBe(2);
});

it.each(["marked", "legacy"])("replays a %s saved response when freshness returns with the same digest", async mode => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [
      { kind: "file", selector: "form.swift", question: "Locate step ownership", offset: 0 },
    ] }));
    expect(turn.prompt).toContain("let step = 0");
    return answer(step({ questions: [], complete: true }));
  }, "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  const topicEvidence = database.evidence.topic.bind(database.evidence);
  let expired = false;
  const freshness = vi.spyOn(database.evidence, "topic").mockImplementation(topic => {
    const state = topicEvidence(topic);
    if (!expired && database.planning.latest("topic")?.lastResponse) {
      expired = true;
      return { ...state, ready: false };
    }
    return state;
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Planning binding changed");
  freshness.mockRestore();
  const saved = database.planning.latest("topic")!;
  expect(saved.lastResponse?.planningStep?.requests).toHaveLength(1);
  expect(saved.stopped).toBe("Planning binding changed; preserved checkpoint is not an approved plan.");
  if (mode === "legacy") {
    saved.responsePending = undefined;
    database.planning.save(saved);
  } else expect(saved.responsePending).toBe(true);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")!.round).toBe(2);
  expect(database.planning.latest("topic")!.responsePending).toBe(false);
});

it("drops a saved pre-adoption response when the working tree changes before retry", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [
      { kind: "file", selector: "form.swift", question: "Read previous source", offset: 0 },
    ] }));
    expect(JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)).toEqual([]);
    expect(database.planning.latest("topic")!.responsePending).toBe(false);
    return answer(step({ questions: [], complete: true }));
  }, "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  const topicEvidence = database.evidence.topic.bind(database.evidence);
  let expired = false;
  const freshness = vi.spyOn(database.evidence, "topic").mockImplementation(topic => {
    const state = topicEvidence(topic);
    if (!expired && database.planning.latest("topic")?.lastResponse) {
      expired = true;
      return { ...state, ready: false };
    }
    return state;
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Planning binding changed");
  freshness.mockRestore();
  writeFileSync(join(repo, "form.swift"), "let step = 1\n");
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
});

it("replays a final response persisted immediately before an interrupted adoption", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async () => answer(step({ questions: [], complete: true })), "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  const save = database.planning.save.bind(database.planning);
  let interrupted = false;
  const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
    save(record);
    if (!interrupted && record.responsePending) {
      interrupted = true;
      throw new Error("Interrupted before adopting the response");
    }
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted before adopting");
  saving.mockRestore();
  const saved = database.planning.latest("topic")!;
  expect(saved.responsePending).toBe(true);
  expect(saved.stopped).toBeNull();
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(1);
  expect(database.planning.latest("topic")!.responsePending).toBe(false);
});

it("uses a compact final review turn before same-session history reaches its cap", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ draft: "x".repeat(2000), requests: [
      { kind: "file", selector: "form.swift", question: "Check navigation", offset: 0 },
    ] }));
    expect(turn.prompt).toContain("No further reads fit the host history limit");
    expect(turn.prompt).toContain("let step = 0");
    expect(turn.prompt).not.toContain('Checkpoint: {"draft"');
    expect(turn.planningControl?.instructionsInSession).toBe(true);
    return answer(step({ questions: [], complete: true }));
  }, "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  const save = database.planning.save.bind(database.planning);
  let interrupted = false;
  const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
    save(record);
    if (!interrupted && record.responsePending) {
      interrupted = true;
      throw new Error("Interrupted before first read");
    }
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted before first read");
  saving.mockRestore();
  const saved = database.planning.latest("topic")!;
  saved.injectedBytes = PLANNING_LIMITS.reviewHistoryBytes - (saved.responseBytes ?? 0) - 9000;
  database.planning.save(saved);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
});

it("resends changed instructions when a resumed call stopped before delivering them", async () => {
  const { repo, database, git } = setup("codex");
  writeFileSync(join(repo, "AGENTS.md"), "Original rule\n");
  const fake = scripted(async (_turn, n) => n === 1 ? answer(step({
    facts: [{ statement: "Unsupported", refs: ["context:request"] }], questions: [], complete: true,
  })) : answer(step({ questions: [], complete: true })), "codex");
  let stopBeforeSpawn = false;
  const adapter: AgentAdapter = { ...fake.adapter, resumeTurn: async turn => {
    if (stopBeforeSpawn) { stopBeforeSpawn = false; throw new Error("Stopped before spawn"); }
    return fake.adapter.resumeTurn(turn);
  } };
  const wrapped = guardedPlanning(adapter, database, git);
  await expect(wrapped.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const originalHash = database.planning.latest("topic")!.deliveredInstructionHash;
  writeFileSync(join(repo, "AGENTS.md"), "Updated rule\n");
  stopBeforeSpawn = true;
  await expect(wrapped.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Stopped before spawn");
  expect(database.planning.latest("topic")!.deliveredInstructionHash).toBe(originalHash);
  await wrapped.createSession({ cwd: repo, prompt: "Plan" });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1].planningControl?.instructionsInSession).toBe(false);
  expect(database.planning.latest("topic")!.deliveredInstructionHash).not.toBe(originalHash);
});

it("does not omit a contract repair question from a compact final review", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async () => answer(step({ requests: [
    { kind: "file", selector: "form.swift", question: "Check navigation", offset: 0 },
  ] })), "codex");
  const wrapped = guardedPlanning(fake.adapter, database, git);
  const save = database.planning.save.bind(database.planning);
  let interrupted = false;
  const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
    save(record);
    if (!interrupted && record.responsePending) {
      interrupted = true;
      throw new Error("Interrupted before adoption");
    }
  });
  await expect(wrapped.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted before adoption");
  saving.mockRestore();
  const saved = database.planning.latest("topic")!;
  saved.responsePending = false;
  saved.step.questions = ["Repair the final task contract: include the missing section"];
  saved.injectedBytes = PLANNING_LIMITS.reviewHistoryBytes - (saved.responseBytes ?? 0) - 1000;
  database.planning.save(saved);
  await expect(wrapped.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("host history limit");
  expect(fake.calls).toHaveLength(1);
  expect(database.planning.latest("topic")!.finalAttempted).toBe(false);
});

it.each(["unsupported citation", "oversized checkpoint"])("requests a corrected response after rejecting an %s", async reason => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (_turn, n) => {
    if (n === 1 && reason === "unsupported citation") return answer(step({
      facts: [{ statement: "Unsupported", refs: ["context:request"] }], questions: [], complete: true,
    }));
    if (n === 1) return answer(step({ draft: "x".repeat(PLANNING_LIMITS.checkpointBytes + 1) }));
    return answer(step({ questions: [], complete: true }));
  }, "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow(
    reason === "unsupported citation" ? "not delivered" : "output limit");
  expect(database.planning.latest("topic")!.responsePending).toBe(false);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
});

it("does not replay an explicitly rejected decision response with pending reads", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (_turn, n) => n === 1
    ? { ...answer(step({ facts: [{ statement: "Unsupported", refs: ["context:request"] }], requests: [
      { kind: "file", selector: "form.swift", question: "Read source", offset: 0 },
    ] })), requestedUserDecision: "Confirm this fact" }
    : answer(step({ questions: [], complete: true })), "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  expect(database.planning.latest("topic")!.responsePending).toBe(false);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
});

it("persists the final result atomically with clearing the replay marker", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async () => answer(step({ questions: [], complete: true })), "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  const save = database.planning.save.bind(database.planning);
  let interrupted = false;
  const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
    save(record);
    if (!interrupted && record.step.complete) {
      interrupted = true;
      throw new Error("Interrupted after completed checkpoint save");
    }
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted after completed checkpoint save");
  saving.mockRestore();
  const saved = database.planning.latest("topic")!;
  expect(saved.finalized).toBe(true);
  expect(saved.finalResult?.planMarkdown).toBe("Final navigation plan");
  expect(saved.responsePending).toBe(false);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(1);
});

it("does not replay an adopted citation response after a crash while saving its reads", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
      questions: [], complete: true }));
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{ id: string }>;
    expect(fragments).toHaveLength(1);
    return answer(step({ facts: [{ statement: "Verified", refs: [fragments[0].id] }], questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.lastResponse = answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
    requests: [{ kind: "file", selector: "form.swift", question: "Verify", offset: 0 }] }));
  saved.responsePending = undefined;
  database.planning.save(saved);
  const save = database.planning.save.bind(database.planning);
  let interrupted = false;
  const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
    save(record);
    if (!interrupted && record.fragments.length > 0 && record.stopped) {
      interrupted = true;
      throw new Error("Interrupted after fragment save");
    }
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted after fragment save");
  saving.mockRestore();
  expect(database.planning.latest("topic")!.fragments).toHaveLength(1);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
});

it("keeps citation replay reads pending when the soft budget stops research", async () => {
  const { repo, database, git } = setup("claude", 100);
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
      questions: [], complete: true }));
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{ id: string }>;
    expect(fragments).toHaveLength(1);
    return answer(step({ facts: [{ statement: "Verified", refs: [fragments[0].id] }], questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.lastResponse = answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
    requests: [{ kind: "file", selector: "form.swift", question: "Verify", offset: 0 }] }));
  saved.responsePending = undefined;
  database.planning.save(saved);
  const writeTree = git.writeWorkingTree.bind(git);
  let reads = 0;
  const interrupted = vi.spyOn(git, "writeWorkingTree").mockImplementation(async (...args) => {
    if (++reads === 3) throw new Error("Interrupted before budget pause");
    return writeTree(...args);
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted before budget pause");
  interrupted.mockRestore();
  expect(database.planning.latest("topic")!.stopped).toBe("Planning checkpoint accepted; deferred reads pending.");
  database.budgets.grant("topic", "raise-input", { execution: { inputTokens: 1000, outputTokens: 10000, durationMs: 100000 },
    total: { inputTokens: 300000, outputTokens: 30000, durationMs: 300000 } }, 1);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
});

it("counts unadopted delivered fragments as progress when replaying a paused response", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "First read", offset: 0 }] }));
    if (n === 2) throw new Error("Simulate the former citation pause");
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{ id: string }>;
    expect(fragments).toHaveLength(1);
    return answer(step({ facts: [{ statement: "Verified", refs: [fragments[0].id] }], questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("former citation pause");
  const saved = database.planning.latest("topic")!;
  expect(saved.stalled).toBe(1);
  expect(saved.fragments).toHaveLength(1);
  database.planning.recordDelivery(saved.sessionId!, saved.fragments);
  saved.lastResponse = answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
    requests: [{ kind: "file", selector: "form.swift", question: "Continue read", offset: 100 }] }));
  saved.responsePending = undefined;
  saved.stopped = "Checkpoint cites evidence that was not delivered.";
  database.planning.save(saved);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(3);
  expect(database.planning.latest("topic")!.stalled).toBe(0);
});

it("does not replay an old read request after new user evidence changes the task", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
      questions: [], complete: true }));
    expect(turn.prompt).toContain("Updated requirement");
    expect(JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)).toEqual([]);
    return answer(step({ questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.lastResponse = answer(step({ facts: [{ statement: "Unverified", refs: ["context:request"] }],
    requests: [{ kind: "file", selector: "form.swift", question: "Old read", offset: 0 }] }));
  database.planning.save(saved);
  database.appendEvent({ topicId: "topic", actor: "user", kind: "evidence", state: "CLAUDE_PLAN", body: "Updated requirement" });
  await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(fake.calls).toHaveLength(2);
});

it("fulfills accepted read requests after a budget increase without repeating the research call", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unsupported", refs: ["context:request"] }],
      questions: [], complete: true }));
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{ id: string }>;
    expect(fragments).toHaveLength(1);
    return answer(step({ facts: [{ statement: "Verified", refs: [fragments[0].id] }], questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.step = step({ requests: [{ kind: "file", selector: "form.swift", question: "Continue after budget", offset: 0 }] });
  saved.stopped = "Planning checkpoint saved; insufficient remaining budget for synthesis.";
  saved.responsePending = false;
  database.planning.save(saved);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")!.round).toBe(2);
});

it("retains deferred reads when recovery is interrupted before fragments are saved", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unsupported", refs: ["context:request"] }],
      questions: [], complete: true }));
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{ id: string }>;
    expect(fragments).toHaveLength(1);
    return answer(step({ facts: [{ statement: "Verified", refs: [fragments[0].id] }], questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.step = step({ requests: [{ kind: "file", selector: "form.swift", question: "Continue after budget", offset: 0 }] });
  saved.stopped = "Planning checkpoint saved; insufficient remaining budget for synthesis.";
  saved.responsePending = false;
  database.planning.save(saved);
  const read = vi.spyOn(PlanningReader.prototype, "read").mockRejectedValueOnce(new Error("Interrupted read"));
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted read");
  expect(database.planning.latest("topic")!.stopped).toBe(saved.stopped);
  expect(fake.calls).toHaveLength(1);
  read.mockRestore();
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
});

it("does not reserve an image when a later read in the same batch fails", async () => {
  const { root, repo, database, git } = setup();
  const source = database.evidence.register("topic", { url: "https://team.slack.com/archives/C123/p1789709010013729",
    label: "Image evidence", mode: "connector", intervalSeconds: 900 });
  const check = database.evidence.begin(source.id, true)!;
  const imageBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=";
  database.evidence.ingest(source.id, { checkId: check.checkId, revision: "r1", units: [
    { id: "render", kind: "render", content: "Reference image", imageBase64 },
  ] });
  const imageHash = database.evidence.snapshot(source.id)!.units[0].imageHash!;
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unsupported", refs: ["context:request"] }],
      questions: [], complete: true }));
    expect(JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)).toHaveLength(2);
    expect(turn.planningControl?.image).toBeDefined();
    return answer(step({ questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git, undefined, join(root, "images"));
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.step = step({ requests: [
    { kind: "image", selector: imageHash, question: "Inspect image", offset: 0 },
    { kind: "file", selector: "form.swift", question: "Inspect form", offset: 0 },
  ] });
  saved.stopped = "Planning checkpoint saved; insufficient remaining budget for synthesis.";
  saved.responsePending = false;
  database.planning.save(saved);
  const read = vi.spyOn(PlanningReader.prototype, "read").mockRejectedValueOnce(new Error("Interrupted file read"));
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted file read");
  read.mockRestore();
  expect(database.planning.latest("topic")!.imageHash).toBeUndefined();
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
});

it("does not recover budget-paused reads from a previous user contract", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unsupported", refs: ["context:request"] }],
      questions: [], complete: true }));
    expect(turn.prompt).toContain("New scope evidence");
    expect(JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)).toEqual([]);
    return answer(step({ questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.step = step({ requests: [{ kind: "file", selector: "form.swift", question: "Old read", offset: 0 }] });
  saved.stopped = "Planning checkpoint saved; insufficient remaining budget for synthesis.";
  database.planning.save(saved);
  database.appendEvent({ topicId: "topic", actor: "user", kind: "evidence", state: "CLAUDE_PLAN", body: "New scope evidence" });
  await adapter.createSession({ cwd: repo, prompt: "Plan" });
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

it("admits a complete large Codex audit contract with mandatory instructions and reuses its session", async () => {
  const { repo, database, git } = setup("codex");
  writeFileSync(join(repo, "AGENTS.md"), "Keep this mandatory rule.\n".repeat(800));
  execFileSync("git", ["-C", repo, "add", "AGENTS.md"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "instructions"]);
  const contract = "AUDIT_CONTRACT_START" + "x".repeat(44_000) + "AUDIT_CONTRACT_END";
  const fake = scripted(async (_turn, n) => answer(n === 1 ? step({ requests: [
    { kind: "file", selector: "form.swift", question: "Check navigation", offset: 0 },
  ] }) : step({ questions: [], complete: true })), "codex");
  const wrapped = new BudgetController(database.budgets, () => ({ topicId: "topic", accounts: ["topic"], stage: "CODEX_AUDIT" }),
    async () => {}, database.revisions, true, database.reviews, database).wrap(guardedPlanning(fake.adapter, database, git));
  await wrapped.createSession({ cwd: repo, prompt: contract });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[0].prompt).toContain(contract);
  expect(fake.calls[0].planningControl?.maxPromptBytes).toBe(PLANNING_LIMITS.reviewPromptBytes);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
  expect(fake.calls[1].prompt).not.toContain(contract);
  expect(database.planning.latest("topic")?.finalized).toBe(true);
});

it("still rejects a Codex audit packet above its larger review limit before a model call", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async () => answer(step({ questions: [], complete: true })), "codex");
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo,
    prompt: "x".repeat(PLANNING_LIMITS.reviewPromptBytes + 1) })).rejects.toThrow("packet limit");
  expect(fake.calls).toHaveLength(0);
  expect(database.planning.latest("topic")?.finalized).toBe(false);
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
  expect(database.getTopic("topic").participants.find(p => p.role === "claude")?.sessionId).toBe("claude-existing");
  expect(database.planning.latest("topic")?.sessions).toEqual(["claude-existing"]);
  expect(database.revisions.account("topic").used).toBe(0);
  expect(codex.calls).toHaveLength(0);
  await engine.shutdown();
});

it.each([false, true])("public retry reuses a finalized first plan with prior-epoch artifact=%s", async hasPriorArtifact => {
  const { root, repo, database, git } = setup();
  database.updateTopic("topic", { state: "DRAFT" });
  for (const role of ["claude", "codex"] as const) database.upsertParticipant("topic", {
    role, sessionId: `${role}-existing`, mode: "attached", acknowledgedPlanSHA256: null,
  });
  const plan = REQUIRED_PLAN_HEADINGS.map(heading => `## ${heading}\n\nPlan${heading === "허용 오차" ? '\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```' : ""}`).join("\n\n");
  const claude = scripted(async () => ({ ...answer(step({ questions: [], complete: true })), planMarkdown: plan }));
  const codex = scripted(async () => { throw new Error("Stop after first plan recovery"); }, "codex");
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  if (hasPriorArtifact) {
    await artifacts.write("topic", "claude-plan", 1, "Prior epoch plan result");
    database.updateTopic("topic", { planEpoch: 2 });
  }
  const previousArtifact = database.latestArtifact("topic", "claude-plan");
  const write = artifacts.write.bind(artifacts);
  let interrupted = false;
  const writing = vi.spyOn(artifacts, "write").mockImplementation(async (...args) => {
    if (args[1] === "claude-plan" && !interrupted) {
      interrupted = true;
      throw new Error("Interrupted before first plan artifact write");
    }
    return write(...args);
  });
  const engine = new WorkflowEngine({ database, git, artifacts,
    claude: new BudgetController(database.budgets, () => ({ topicId: "topic", accounts: ["topic"],
      stage: database.getTopic("topic").state }), async () => {}, database.revisions, true, database.reviews, database)
      .wrap(guardedPlanning(claude.adapter, database, git)), codex: codex.adapter });
  const settle = async () => {
    const deadline = Date.now() + 5000;
    while (database.runningAction("topic")) {
      if (Date.now() > deadline) throw new Error("Workflow did not complete");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  engine.startPlan("topic"); await settle();
  const epoch = database.getTopic("topic").planEpoch;
  expect(database.getTopic("topic").state).toBe("FAILED");
  expect(database.planning.latest("topic")!.finalized).toBe(true);
  expect(database.latestArtifact("topic", "claude-plan")).toEqual(previousArtifact);
  const usedBeforeRetry = database.revisions.account("topic").used;
  writing.mockRestore();
  engine.retry("topic"); await settle();
  expect(database.getTopic("topic").planEpoch).toBe(epoch);
  expect(claude.calls).toHaveLength(1);
  expect(database.latestArtifact("topic", "claude-plan")!.revision).toBeGreaterThan(previousArtifact?.revision ?? 0);
  expect(database.revisions.account("topic").used).toBe(usedBeforeRetry);
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

it("does not double count session discovery time or stop research before the real time threshold", async () => {
  const { repo, database, git } = setup("codex", 100000, 15000);
  const origin = Date.now(); let elapsed = 0, calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => origin + elapsed);
  const createSession: AgentAdapter["createSession"] = async turn => {
    calls++;
    turn.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });
    if (calls === 1) { elapsed = 2000; turn.onSessionCreated?.("review-session"); elapsed = 10000; }
    else elapsed = 10001;
    turn.onUsage?.({ inputTokens: 100, outputTokens: 20, durationMs: calls === 1 ? 10000 : 1, recordKind: "final" });
    return { sessionId: "review-session", result: answer(calls === 1 ? step({ requests: [
      { kind: "file", selector: "form.swift", question: "Read", offset: 0 },
    ] }) : step({ questions: [], complete: true })) };
  };
  const adapter: AgentAdapter = { role: "codex", createSession, resumeTurn: async t => (await createSession(t)).result,
    validateExistingSession: async () => true };
  await guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Review" });
  expect(calls).toBe(2);
  expect(database.planning.latest("topic")?.usage.durationMs).toBe(10001);
});

// Public adapter boundary: research continuation must retain identity and omit delivered source bytes.
it("resumes one Claude research session and does not resend the task or delivered fragments", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => n < 3 ? answer(step({ requests: [
    { kind: "file", selector: "form.swift", question: "Read", offset: 0 },
  ] })) : answer(step({ questions: [], complete: true })));
  await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "UNIQUE_INITIAL_CONTRACT" });
  expect(fake.calls).toHaveLength(3);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
  expect(fake.calls[2]).toMatchObject({ sessionId: "session-1" });
  expect(fake.calls[1].prompt).not.toContain("UNIQUE_INITIAL_CONTRACT");
  expect(fake.calls[1].prompt).toContain("let step = 0");
  expect(fake.calls[2].prompt).not.toContain("let step = 0");
});

// Actual consumer: WorkflowEngine approval -> implementation, with real Git and persisted SQLite.
// CLI processes are fake: native flags/permissions are checked in adapter-permissions.test.ts.
it("keeps the plan and revision session through approval, engine restart, implementation and missing-session recovery", async () => {
  const { root, repo, database, git } = setup();
  database.updateTopic("topic", { state: "DRAFT" });
  for (const role of ["claude", "codex"] as const) database.upsertParticipant("topic", {
    role, sessionId: `pending:${role}`, mode: "created", acknowledgedPlanSHA256: null,
  });
  const plan = REQUIRED_PLAN_HEADINGS.map(h => `## ${h}\n\nUNIQUE_PLAN_BODY${h === "허용 오차" ? '\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```' : ""}`).join("\n\n");
  const finding = { id: "F-1", title: "Validate navigation", severity: "HIGH" as const, disposition: "AGREED_ACTION" as const,
    rationale: "Preserve navigation", evidenceRefs: [], requiresUserDecision: false };
  const modelTurns: SessionTurn[] = [];
  let creates = 0, unavailable = false;
  const runClaude = async (t: SessionTurn): Promise<AgentResult> => {
    if (t.protocolOnly) return { kind: "ACK", summary: "ack", findings: [], evidenceRefs: [], planSHA256: database.getTopic("topic").planSHA256! };
    modelTurns.push(t);
    if (unavailable) throw new Error("No conversation found with session ID: " + t.sessionId);
    t.onSessionCreated?.(t.sessionId);
    t.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });
    t.onUsage?.({ inputTokens: 100, outputTokens: 20, durationMs: 1, recordKind: "final" });
    if (t.implementation) return { kind: "IMPLEMENTATION", summary: "Await decision", status: "blocked", findings: [], evidenceRefs: [], requestedUserDecision: "Confirm completion" };
    const revision = database.getTopic("topic").state === "CLAUDE_REVISION";
    return { kind: revision ? "REVISION" : "PLAN", summary: "Plan", planMarkdown: plan,
      findings: revision ? [finding] : [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
  };
  const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: async t => { const id = t.protocolOnly ? "ack-only" : `author-${++creates}`; return { sessionId: id, result: await runClaude({ ...t, sessionId: id }) }; },
    resumeTurn: runClaude };
  const codex: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
    createSession: async t => ({ sessionId: "review", result: await codex.resumeTurn({ ...t, sessionId: "review" }) }),
    resumeTurn: async t => ({ kind: t.protocolOnly ? "ACK" : database.getTopic("topic").state === "CODEX_AUDIT" ? "AUDIT" : "CLOSEOUT",
      summary: "Reviewed", findings: t.protocolOnly ? [] : [finding], evidenceRefs: [], planSHA256: database.getTopic("topic").planSHA256! }) };
  let runtimeDatabase = database;
  const buildEngine = () => new WorkflowEngine({ database: runtimeDatabase, git, artifacts: new ArtifactStore(join(root, "artifacts"), runtimeDatabase),
    claude: guardedPlanning(claude, runtimeDatabase, git), codex });
  let engine = buildEngine();
  const settle = async () => {
    const deadline = Date.now() + 8000;
    while (database.runningAction("topic")) {
      if (Date.now() > deadline) throw new Error("Workflow timeout");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  };
  engine.startPlan("topic"); await settle();
  expect(database.getTopic("topic").state, database.getTopic("topic").lastError ?? "").toBe("AWAITING_USER_APPROVAL");
  expect(creates).toBe(1);
  expect(modelTurns.map(t => t.sessionId)).toEqual(["author-1", "author-1"]);
  expect(modelTurns[1].prompt).not.toContain("UNIQUE_PLAN_BODY");
  const binding = database.planning.boundSession(database.getTopic("topic"));
  expect(binding?.sessionId).toBe("author-1");
  engine.approve("topic", database.getTopic("topic").planSHA256!);
  await engine.shutdown();
  runtimeDatabase = new ConsensusDatabase(join(root, "room.db"));
  cleanups.push(() => runtimeDatabase.close());
  engine = buildEngine();
  engine.startImplementation("topic", undefined, "ONLY_NEW_KICKOFF"); await settle();
  expect(database.getTopic("topic").state, database.getTopic("topic").lastError ?? "").toBe("USER_DECISION_REQUIRED");
  const implementation = modelTurns.at(-1)!;
  expect(implementation.sessionId).toBe("author-1");
  expect(implementation.implementation).toBe(true);
  expect(implementation.prompt).toContain("ONLY_NEW_KICKOFF");
  expect(implementation.prompt).not.toContain("UNIQUE_PLAN_BODY");
  expect(database.getFlags("topic").implementationSessionId).toBe("author-1");
  await engine.amendTolerance("topic", { tolerance: { scopePaths: ["**", "form.swift"], rules: [] }, reason: "ALLOW_UPDATED_TOLERANCE" });
  engine.retry("topic"); await settle();
  expect(modelTurns.at(-1)?.prompt).toContain("ALLOW_UPDATED_TOLERANCE");
  expect(modelTurns.at(-1)?.sessionId).toBe("author-1");
  expect(modelTurns.at(-1)?.prompt).toContain('"form.swift"');
  unavailable = true;
  engine.retry("topic"); await settle();
  expect(database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
  expect(creates).toBe(1);
  expect(database.getFlags("topic").implementationSessionId).toBe("author-1");
  const callCount = modelTurns.length;
  database.upsertParticipant("topic", { role: "claude", sessionId: "unrelated-session", mode: "attached", acknowledgedPlanSHA256: database.getTopic("topic").planSHA256 });
  engine.retry("topic"); await settle();
  expect(modelTurns).toHaveLength(callCount);
  expect(database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
  await engine.shutdown();
});

it("allows an explicit bounded reread after compaction without treating it as new evidence", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_t, n) => n < 3 ? answer(step({ requests: [
    { kind: "file", selector: "form.swift", question: "Read", offset: 0,
      ...(n === 2 ? { rereadReason: "Compaction omitted the exact declaration" } : {}) },
  ] })) : answer(step({ questions: [], complete: true })));
  await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" });
  expect(fake.calls[2].prompt).toContain("let step = 0");
  expect(database.planning.latest("topic")?.delivered).toHaveLength(1);
});

it("inherits current delivered evidence across plan and revision without retransmitting it", async () => {
  const { repo, database, git } = setup();
  let fragmentId = "";
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
    if (n === 2) {
      fragmentId = JSON.parse(turn.prompt.split("Fragments: ")[1])[0].id;
      return answer(step({ facts: [{ statement: "Step exists", refs: [fragmentId] }], questions: [], complete: true }));
    }
    if (n === 3) return answer(step({ facts: [{ statement: "Step exists", refs: [fragmentId] }],
      requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
    expect(turn.prompt).not.toContain("let step = 0");
    return answer(step({ facts: [{ statement: "Step exists", refs: [fragmentId] }], questions: [], complete: true }));
  });
  const wrapped = guardedPlanning(fake.adapter, database, git);
  const first = await wrapped.createSession({ cwd: repo, prompt: "Plan" });
  database.updateTopic("topic", { state: "CLAUDE_REVISION", planSHA256: "a".repeat(64) });
  await wrapped.resumeTurn({ cwd: repo, prompt: "Revise", sessionId: first.sessionId });
  expect(fake.calls).toHaveLength(4);
  expect(database.planning.latest("topic")?.delivered).toEqual([fragmentId]);
  writeFileSync(join(repo, "form.swift"), "let renamed = 1\n");
  database.updateTopic("topic", { planSHA256: "b".repeat(64) });
  await expect(wrapped.resumeTurn({ cwd: repo, prompt: "Revalidate changed source", sessionId: first.sessionId }))
    .rejects.toThrow("not delivered");
});


it("resumes migrated interrupted planning in the same epoch and session with bounded reads and preserved rewrite usage", async () => {
  const { root, repo, database, git } = setup("claude", 100000, 100000, false);
  const sessionId = "11111111-1111-4111-8111-111111111111";
  database.upsertParticipant("topic", { role: "claude", sessionId, mode: "created", acknowledgedPlanSHA256: null });
  database.upsertParticipant("topic", { role: "codex", sessionId: "pending:review", mode: "created", acknowledgedPlanSHA256: null });
  database.updateTopic("topic", { state: "USER_DECISION_REQUIRED", resumeState: "CLAUDE_PLAN" });
  const before = database.getTopic("topic");
  const artifacts = new ArtifactStore(join(root, "artifacts"), database);
  const interrupted = await artifacts.write("topic", "interrupted-output", 1, JSON.stringify({ sessionId,
    output: { stdout: JSON.stringify({ type: "system", subtype: "init", session_id: sessionId, cwd: repo }) } }));
  database.revisions.reserve("topic", "old-plan", "plan");
  const revisions = database.revisions.account("topic");
  const fake = scripted(async (turn, n) => {
    expect((turn as SessionTurn).sessionId).toBe(sessionId);
    expect(Buffer.byteLength(turn.prompt)).toBeLessThan(PLANNING_LIMITS.promptBytes);
    if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", offset: 0, question: "Inspect" }] }));
    throw new Error("transport interruption after bounded read");
  });
  const engine = new WorkflowEngine({ database, git, artifacts, enforceBudgets: true,
    claude: guardedPlanning(fake.adapter, database, git), codex: scripted(async () => { throw new Error("No audit"); }, "codex").adapter });
  await engine.migrateInterruptedPlanning("topic", { sessionId, scopeGeneration: before.scopeGeneration, planEpoch: before.planEpoch,
    interruptedSHA256: interrupted.sha256, apply: true }, "migration");
  expect(database.revisions.account("topic")).toEqual(revisions);
  engine.retry("topic");
  const deadline = Date.now() + 8000;
  while (database.runningAction("topic")) {
    if (Date.now() > deadline) throw new Error("Workflow timeout");
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  expect(fake.calls).toHaveLength(2);
  expect(database.getTopic("topic")).toMatchObject({ planEpoch: before.planEpoch, scopeGeneration: before.scopeGeneration });
  expect(database.revisions.account("topic").used).toBe(revisions.used + 1);
  expect(database.planning.latest("topic")).toMatchObject({ sessionId, started: true });
  expect(database.artifactsForScope("topic", "interrupted-output").map(a => a.sha256)).toContain(interrupted.sha256);
});


it.each(["claude", "codex"] as const)("%s planning sees Figma links but cannot retrieve the cached design body", async role => {
  const { repo, database, git, topic } = setup(role);
  const source = database.evidence.register(topic.id, { url: "https://www.figma.com/design/DesignFile?node-id=1-2", label: "Entry screen", mode: "connector", intervalSeconds: 900 });
  const check = database.evidence.begin(source.id, true)!;
  database.evidence.ingest(source.id, { checkId: check.checkId, revision: "r1",
    units: [{ id: "1:2", kind: "design", content: "DO_NOT_SEND_NODE_TREE" }] });
  const fake = scripted(async turn => {
    expect(turn.prompt).toContain(source.url);
    expect(turn.prompt).toContain("Design is implementation-time work");
    expect(turn.prompt).not.toContain("DO_NOT_SEND_NODE_TREE");
    return answer(step({ requests: [{ kind: "evidence", selector: `${source.id}::1:2`, offset: 0, question: "Try reading design early" }] }));
  }, role);
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan functional boundaries" })).rejects.toThrow();
  expect(fake.calls).toHaveLength(1);
  expect(database.planning.latest(topic.id)?.fragments).toEqual([]);
});

it("lets bounded planning request a Figma product comment while omitting the visual node", async () => {
  const { repo, database, git, topic } = setup();
  const source = database.evidence.register(topic.id, { url: "https://www.figma.com/design/abc?node-id=1-2", label: "Screen", mode: "connector", intervalSeconds: 900 });
  database.evidence.ingest(source.id, { checkId: database.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [
    { id: "decision", kind: "comment", content: "Owner decision: save before exit" }, { id: "node", kind: "design", content: "VISUAL_SECRET" },
  ] });
  const fake = scripted(async (turn, call) => {
    expect(turn.prompt).not.toContain("VISUAL_SECRET");
    if (call === 1) return answer(step({ requests: [{ kind: "evidence", selector: `${source.id}::decision`, offset: 0, question: "Check exit policy" }] }));
    expect(turn.prompt).toContain("save before exit");
    return answer(step({ questions: [], complete: true }));
  });
  await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan behavior" });
  expect(fake.calls.length).toBeGreaterThan(1);
});
