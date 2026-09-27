import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import { guardedPlanning } from "../src/server/guardedPlanning";
import { BudgetController } from "../src/server/budgetController";
import { PlanningReader, utf8Slice } from "../src/server/planningReader";
import { PLANNING_LIMITS, type PlanningFragment, type PlanningStep } from "../src/shared/planningControl";
import { buildClaudePlanPrompt, buildCodexAuditPrompt, planTimelineDelivery, timelineEventText, timelineReference } from "../src/shared/prompts";
import { WorkflowEngine } from "../src/server/workflow";
import { ArtifactStore } from "../src/server/artifacts";
import type { AgentAdapter, SessionTurn, TurnUsage } from "../src/server/types";
import { REQUIRED_PLAN_HEADINGS, type AgentResult, type TimelineEvent } from "../src/shared/contracts";
import { AgentRunError, agentRunError, classifyRunFailure, SessionIdentityMismatch } from "../src/server/adapters/resultParser";
import { ExecutionMetrics } from "../src/server/adapters/executionMetrics";
import { CodexAdapter } from "../src/server/adapters/codex";
import { ClaudeAdapter } from "../src/server/adapters/claude";
import { guardRunnerControl } from "../src/server/adapters/turnPolicy";
import { withEvidence } from "../src/server/evidence/service";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/server/types";
import { legacyBinding } from "../src/server/turnRouting";
import { DiagnosisInputSchema } from "../src/shared/diagnoses";

// Each scenario may run many model turns and source revalidations. Await their completion;
// individual reader cancellation/deadlines are asserted separately in user-file-reader.test.ts.
vi.setConfig({ testTimeout: 30_000 });

vi.mock("node:fs/promises", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

// E3-3a 전의 검토 감사 누적 한도 — 제거한 기준이다. 예전 한도 근처의 측정 이력으로도 멈추지 않는지 보는 데만 쓴다.
const FORMER_AUDIT_HISTORY_BYTES = 256 * 1024;
// E3-4a 전의 고정 조사 회차(8 + 최종 정리 1) — 제거한 기준이다. 회차 수만으로 정리를 강제하지 않는지 보는 데만 쓴다.
const FORMER_RESEARCH_ROUNDS = 8;
// 관측된 Codex 세션 유실 형태(격리 실측 2026-09-26, resultParser.classifyRunFailure 주석) — 명시적 복구로 새 세션을 만드는 데 쓴다.
const codexSessionMissing = (sessionId: string) =>
  agentRunError("codex", 1, `Error: thread/resume: thread/resume failed: no rollout found for thread id ${sessionId} (code -32600)\n`, "");

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

it("repairs an undelivered final citation once in the same planning session after a forced synthesis", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => answer(step({
    facts: n === 1 ? [{ statement: "Unsupported", refs: ["not-delivered"] }] : [],
    questions: [], complete: true,
  })));
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.finalAttempted = true;
  database.planning.save(saved);

  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.sessionId).toBe("session-1");
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1].prompt).toContain("Citation repair, final attempt");
  expect(fake.calls[1].prompt).toContain("not-delivered");
  expect(database.planning.latest("topic")!.citationRepairAttempted).toBe(true);
});

it("does not buy another correction when the final citation repair is still unsupported", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async () => answer(step({
    facts: [{ statement: "Unsupported", refs: ["not-delivered"] }], questions: [], complete: true,
  })));
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.finalAttempted = true;
  database.planning.save(saved);

  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Citation repair already attempted");
  expect(fake.calls).toHaveLength(2);
});

it("keeps citation repair final even when a later budget grant removes the soft limit", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => n === 1
    ? answer(step({ facts: [{ statement: "Unsupported", refs: ["not-delivered"] }], questions: [], complete: true }))
    : answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read more", offset: 0 }] })));
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.finalAttempted = true;
  database.planning.save(saved);

  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Synthesis did not produce a complete plan");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")!.fragments).toHaveLength(0);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Citation repair already attempted");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")!.fragments).toHaveLength(0);
});

it("does not replay old pending reads before correcting a final citation", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => answer(step({
    facts: n === 1 ? [{ statement: "Unsupported", refs: ["not-delivered"] }] : [],
    questions: [], complete: true,
  })));
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.finalAttempted = true;
  saved.step.requests = [{ kind: "file", selector: "missing.swift", question: "Old research", offset: 0 }];
  saved.stopped = "Planning checkpoint saved; insufficient remaining budget for synthesis.";
  database.planning.save(saved);

  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1].prompt).toContain("Citation repair, final attempt");
  expect(fake.calls[1].prompt).toContain("Fragments: []");
});

// E3-3a: 누적 이력은 측정만 한다 — 예전 한도 근처의 검토 세션에서도 인용 교정은 합성 축약 없이 같은 세션의 일반 교정 패킷으로 간다.
it("repairs a final citation in the same review session near the former history cap without compact synthesis", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ facts: [{ statement: "Unsupported", refs: ["not-delivered"] }],
      questions: [], complete: true }));
    expect(turn.prompt).toContain("preceding complete response was rejected");
    expect(turn.prompt).toContain("not-delivered");
    expect(turn.prompt).toContain('Checkpoint: {"draft"');
    expect(turn.prompt).not.toContain("host history limit");
    return answer(step({ questions: [], complete: true }));
  }, "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.finalAttempted = true;
  saved.step.draft = "x".repeat(9000);
  saved.injectedBytes = FORMER_AUDIT_HISTORY_BYTES - (saved.responseBytes ?? 0) - 4000;
  database.planning.save(saved);

  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(result.sessionId).toBe("session-1");
  expect(fake.calls).toHaveLength(2);
  expect(database.planning.latest("topic")!.context?.measuredHistoryBytes).toBeGreaterThan(FORMER_AUDIT_HISTORY_BYTES - 5000);
});

it("replays a saved final citation correction after interruption without another model call", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (_turn, n) => answer(step({
    facts: n === 1 ? [{ statement: "Unsupported", refs: ["not-delivered"] }] : [],
    questions: [], complete: true,
  })));
  const adapter = guardedPlanning(fake.adapter, database, git);
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("not delivered");
  const saved = database.planning.latest("topic")!;
  saved.finalAttempted = true;
  database.planning.save(saved);
  const save = database.planning.save.bind(database.planning);
  let interrupted = false;
  const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
    save(record);
    if (!interrupted && record.citationRepairAttempted && record.responsePending) {
      interrupted = true;
      throw new Error("Interrupted before adopting correction");
    }
  });
  await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted before adopting correction");
  saving.mockRestore();

  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
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

// E3-3a: 예전 한도 근처의 같은 세션도 합성 축약 최종 정리("No further reads fit…")로 바꾸지 않고 일반 조사 라운드로 읽은 근거를 싣는다.
it("keeps reading in the same review session near the former history cap instead of a compact final review", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ draft: "x".repeat(2000), requests: [
      { kind: "file", selector: "form.swift", question: "Check navigation", offset: 0 },
    ] }));
    expect(turn.prompt).not.toContain("No further reads fit the host history limit");
    expect(turn.prompt).toContain("let step = 0");
    expect(turn.prompt).toContain('Checkpoint: {"draft"');
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
  saved.injectedBytes = FORMER_AUDIT_HISTORY_BYTES - (saved.responseBytes ?? 0) - 9000;
  database.planning.save(saved);
  const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
});

// E3-3a: 누적 기준 세션 교체(4471b48)를 없앴다 — 예전 감사 한도를 넘는 새 계획 감사도 같은 검토 세션을 이어 쓰고 측정값만 남긴다.
it("keeps the reviewer session for a new plan whose audit would have exceeded the former history cap", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (_turn, n) => answer(step({ draft: n === 1 ? "Previous audit" : "New audit",
    questions: [], complete: true })), "codex");
  const wrapped = guardedPlanning(fake.adapter, database, git);
  await wrapped.createSession({ cwd: repo, prompt: "Audit the previous plan" });
  const old = database.planning.latest("topic")!;
  old.injectedBytes = FORMER_AUDIT_HISTORY_BYTES - (old.responseBytes ?? 0) - 1000;
  database.planning.save(old);
  database.updateTopic("topic", { planEpoch: 1, planSHA256: "a".repeat(64) });

  const result = await wrapped.resumeTurn({ cwd: repo, prompt: "Audit the complete revised plan and prior findings",
    sessionId: "session-1" });
  expect(result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1].prompt).toContain("Audit the complete revised plan and prior findings");
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
  expect(fake.calls[1].planningControl?.instructionsInSession).toBe(false);
  const record = database.planning.latest("topic")!;
  expect(record.sessionId).toBe("session-1");
  expect(record.context?.measuredHistoryBytes).toBeGreaterThan(FORMER_AUDIT_HISTORY_BYTES - 2000);
});

// host-review a7a9ce86 F-001 — 진단 개정(planEpoch 유지) 뒤 감사는 기존 세션 기준 변경분일 수 있다. 세션을 교체하면 변경분이 아니라 전체 문맥 판을 보낸다.
// E3-3a: 교체는 누적 이력이 아니라 관측된 세션 유실의 명시적 복구로만 일어난다.
it.each([
  { rotated: true, sent: "FULL-CONTEXT audit: complete plan and every decision", withheld: "DELTA audit: changed lines since the cursor" },
  { rotated: false, sent: "DELTA audit: changed lines since the cursor", withheld: "FULL-CONTEXT audit: complete plan and every decision" },
])("sends the full-context task only to a session other than the delta's (rotated=$rotated)", async ({ rotated, sent, withheld }) => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (_turn, n) => answer(step({ draft: n === 1 ? "Previous audit" : "New audit",
    questions: [], complete: true })), "codex");
  let lost = rotated;
  const wrapped = guardedPlanning({ ...fake.adapter, resumeTurn: async turn => {
    if (lost) { lost = false; throw codexSessionMissing(turn.sessionId); }
    return fake.adapter.resumeTurn(turn);
  } }, database, git);
  await wrapped.createSession({ cwd: repo, prompt: "Audit the previous plan" });
  database.updateTopic("topic", { planSHA256: "b".repeat(64) });

  await wrapped.resumeTurn({ cwd: repo, prompt: "DELTA audit: changed lines since the cursor",
    freshSessionPrompt: "FULL-CONTEXT audit: complete plan and every decision", sessionId: "session-1" });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1].prompt).toContain(sent);
  expect(fake.calls[1].prompt).not.toContain(withheld);
  expect("sessionId" in fake.calls[1]).toBe(!rotated);
});

// E3-3a: 예전 한도 근처의 같은 세션도 조각을 축약하지 않는다 — 요청한 본문·인용·메타데이터를 그대로 싣는다.
it("keeps every requested body and citation in the same review session near the former history cap", async () => {
  const { repo, database, git } = setup("codex");
  writeFileSync(join(repo, "tiny.swift"), "let account = 1\n");
  execFileSync("git", ["-C", repo, "add", "tiny.swift"]);
  execFileSync("git", ["-C", repo, "commit", "-qm", "tiny fixture"]);
  const requests = [0, 7000, 14000].map(offset => ({
    kind: "file" as const, selector: "form.swift", question: "Review this form section", offset,
  }));
  requests.push({ kind: "file", selector: "tiny.swift", question: "Review account state", offset: 0 });
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests }));
    const fragments = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as Array<{
      id: string; content: string; nextOffset: number | null;
    }>;
    expect(fragments).toHaveLength(4);
    expect(fragments.every(fragment => fragment.id.length === 64 && fragment.content.length > 0)).toBe(true);
    expect(fragments.slice(0, 3).every(fragment => fragment.nextOffset !== null)).toBe(true);
    expect(fragments[3].nextOffset).toBeNull();
    expect(fragments[3].content).toContain("let account = 1");
    expect(turn.prompt).toContain('"selector":"form.swift"');
    return answer(step({ facts: [{ statement: "Reviewed account state", refs: [fragments[3].id] }],
      questions: [], complete: true }));
  }, "codex");
  const wrapped = guardedPlanning(fake.adapter, database, git);
  const save = database.planning.save.bind(database.planning);
  let interrupted = false;
  const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
    save(record);
    if (!interrupted && record.fragments.length === 4 && !record.responsePending) {
      interrupted = true;
      throw new Error("Interrupted after bounded reads");
    }
  });
  await expect(wrapped.createSession({ cwd: repo, prompt: "Review local draft flow" }))
    .rejects.toThrow("Interrupted after bounded reads");
  saving.mockRestore();
  const saved = database.planning.latest("topic")!;
  expect(saved.fragments).toHaveLength(4);
  saved.injectedBytes = FORMER_AUDIT_HISTORY_BYTES - (saved.responseBytes ?? 0) - 23_000;
  database.planning.save(saved);
  const result = await wrapped.createSession({ cwd: repo, prompt: "Review local draft flow" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
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

// E3-3a: 예전 한도 근처에서도 누적 이력으로 멈추거나 축약하지 않는다 — 계약 교정 질문을 담은 체크포인트를 같은 세션에 그대로 싣는다.
it("keeps a contract repair question in the checkpoint sent to the same review session near the former history cap", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (turn, n) => {
    if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Check navigation", offset: 0 }] }));
    expect(turn.prompt).toContain("Repair the final task contract: include the missing section");
    return answer(step({ questions: [], complete: true }));
  }, "codex");
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
  saved.injectedBytes = FORMER_AUDIT_HISTORY_BYTES - (saved.responseBytes ?? 0) - 1000;
  database.planning.save(saved);
  const result = await wrapped.createSession({ cwd: repo, prompt: "Plan" });
  expect(result.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
});

it("carries a revised closeout into the existing reviewer session after the audit history cap", async () => {
  const { repo, database, git } = setup("codex");
  writeFileSync(join(repo, "AGENTS.md"), "Mandatory project rule.\n".repeat(700));
  const fake = scripted(async () => answer(step({ questions: [], complete: true })), "codex");
  const wrapped = guardedPlanning(fake.adapter, database, git);
  await wrapped.createSession({ cwd: repo, prompt: "Audit the first plan" });
  const audit = database.planning.latest("topic")!;
  audit.injectedBytes = FORMER_AUDIT_HISTORY_BYTES + 12_000;
  database.planning.save(audit);
  database.updateTopic("topic", { state: "CODEX_CLOSEOUT" });
  const revisedPlan = "Revised plan: " + "scope and validation. ".repeat(1450);
  const result = await wrapped.resumeTurn({ cwd: repo, prompt: revisedPlan, sessionId: "session-1" });
  expect(result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
  expect(fake.calls[1].planningControl?.instructionsInSession).toBe(false);
  expect(fake.calls[1].prompt).toContain(revisedPlan);
  expect(database.planning.latest("topic")!.finalized).toBe(true);
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

it("preserves the legacy non-continuous planner's mandatory instruction limit before any model call", async () => {
  const { repo, database, git } = setup("claude", 100000, 100000, false);
  database.updateTopic("topic", { state: "CLAUDE_REVISION" });
  database.planning.enable("topic");
  writeFileSync(join(repo, "CLAUDE.md"), "x".repeat(32_001));
  const fake = scripted(async () => answer(step({ questions: [], complete: true })));
  await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo,
    prompt: "Plan" })).rejects.toThrow("Mandatory instruction file exceeds");
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

it.each(["task", "instructions", "combined"])("streams oversized %s through required context without accepting an unread complete claim", async kind => {
  const { repo, database, git } = setup("codex");
  const contract = kind === "instructions" ? "Audit" : "TASK_BEGIN\n" + "한글 contract 내용.\n".repeat(4000) + "TASK_END";
  const rules = kind === "task" ? null : "MANDATORY_BEGIN\n" + "이 규칙을 지킨다.\n".repeat(4000) + "MANDATORY_END";
  if (rules) writeFileSync(join(repo, "AGENTS.md"), rules);
  const received: PlanningFragment[] = [];
  const fake = scripted(async (turn, n) => {
    const match = /Fragments: (.*)$/.exec(turn.prompt);
    received.push(...JSON.parse(match![1]));
    if (n === 1) {
      if (kind !== "instructions") expect(turn.prompt).not.toContain(contract);
      expect(turn.prompt).toContain("selector=request");
      if (rules) expect(turn.prompt).toContain("selector=mandatory-instructions");
      expect(turn.planningControl?.instructionsProvided).toBe(true);
    } else expect(turn).toMatchObject({ sessionId: "session-1" });
    // Deliberately claim complete before reading. The host must deliver every required byte first.
    return answer(step({ questions: [], complete: true }));
  }, "codex");
  const wrapped = new BudgetController(database.budgets, () => ({ topicId: "topic", accounts: ["topic"], stage: "CODEX_AUDIT" }),
    async () => {}, database.revisions, true, database.reviews, database).wrap(guardedPlanning(fake.adapter, database, git));
  await wrapped.createSession({ cwd: repo, prompt: contract });
  expect(received.filter(f => f.selector === "request").map(f => f.content).join("")).toBe(contract);
  if (rules) expect(received.filter(f => f.selector === "mandatory-instructions").map(f => f.content).join("")).toContain(rules);
  expect(fake.calls.length).toBeGreaterThan(2);
  expect(fake.calls.every(t => Buffer.byteLength(t.prompt) < PLANNING_LIMITS.reviewPromptBytes)).toBe(true);
  expect(database.planning.latest("topic")).toMatchObject({ finalized: true, sessionId: "session-1" });
  expect(database.planning.latest("topic")?.priorAttempt).toBeUndefined();
  expect(() => database.budgets.assertAvailable(["topic"])).not.toThrow();
}, 30000);

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

it("streams oversized planner instructions before accepting completion without truncating them", async () => {
  const { repo, database, git } = setup();
  const rules = "필수 규칙".repeat(10000);
  writeFileSync(join(repo, "CLAUDE.md"), rules);
  const received: PlanningFragment[] = [];
  const fake = scripted(async turn => {
    received.push(...JSON.parse(/Fragments: (.*)$/.exec(turn.prompt)![1]));
    return answer(step({ questions: [], complete: true }));
  });
  await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" });
  expect(received.filter(f => f.selector === "mandatory-instructions").map(f => f.content).join("")).toContain(rules);
  expect(fake.calls.length).toBeGreaterThan(2);
  expect(fake.calls.every(turn => Buffer.byteLength(turn.prompt) < PLANNING_LIMITS.promptBytes)).toBe(true);
  expect(database.planning.latest("topic")).toMatchObject({ finalized: true, sessionId: "session-1" });
});

// E3-4a(r3 B 뒤집기): 회차 수만으로 최종 정리를 강제하지 않는다. 예전 고정 회차(8)를 넘어 조사가 이어지고, 여덟째 회차가 청한 읽기도 다음 호출에 실린다.
it("keeps researching past the former eight rounds without forced synthesis and replays the final result for duplicate retries", async () => {
  const { repo, database, git } = setup();
  const fake = scripted(async (turn, n) => {
    expect(turn.prompt).not.toContain("No more research");
    return n <= FORMER_RESEARCH_ROUNDS + 2
      ? answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Continue", offset: (n - 1) * 100 }] }))
      : answer(step({ questions: [], complete: true }));
  });
  const adapter = guardedPlanning(fake.adapter, database, git);
  const first = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  const again = await adapter.createSession({ cwd: repo, prompt: "Plan" });
  expect(again).toEqual(first);
  expect(first.result.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(FORMER_RESEARCH_ROUNDS + 3);
  const ninth = JSON.parse(fake.calls[FORMER_RESEARCH_ROUNDS].prompt.split("Fragments: ").at(-1)!) as PlanningFragment[];
  expect(ninth.map(fragment => fragment.offset)).toEqual([(FORMER_RESEARCH_ROUNDS - 1) * 100]);
  expect(database.planning.latest("topic")).toMatchObject({ round: FORMER_RESEARCH_ROUNDS + 3, finalAttempted: false,
    usage: { inputTokens: (FORMER_RESEARCH_ROUNDS + 3) * 100 } });
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

// E3-3a(K2): 측정 기록이 없는 세션은 측정값 unknown(null)으로 두고 멈추지도 바꾸지도 않는다 — 신원·권한·계약 검증은 그대로다.
it("keeps the Codex review session across reads and resumes an unmeasured legacy session as unknown without replacing it", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (_turn, n) => n === 1 ? answer(step({ requests: [
    { kind: "file", selector: "form.swift", question: "Read", offset: 0 },
  ] })) : answer(step({ questions: [], complete: true })), "codex");
  const adapter = guardedPlanning(fake.adapter, database, git);
  await adapter.createSession({ cwd: repo, prompt: "Review" });
  expect(fake.calls).toHaveLength(2);
  expect(fake.calls[1]).toMatchObject({ sessionId: "session-1" });
  const legacy = await adapter.resumeTurn({ cwd: repo, prompt: "A new review stage", sessionId: "legacy-review" });
  expect(legacy.planMarkdown).toBe("Final navigation plan");
  expect(fake.calls).toHaveLength(3);
  expect(fake.calls[2]).toMatchObject({ sessionId: "legacy-review" });
  const record = database.planning.latest("topic")!;
  expect(record.sessionId).toBe("legacy-review");
  expect(record.context?.measuredHistoryBytes).toBeNull();
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
// E3-3b(K1·Root Q5 A): 작성자 세션의 실제 유실은 같은 작업 route 의 새 세션 S1 이 승인 계획을 읽기 전용으로 확인한 뒤에만 한 번 복구된다. 참여자·ACK(=S1 이 답한
// 값)·승인 바인딩·구현 세션이 함께 S1 로 옮겨지고, 사용자 승인과 계획자 checkpoint 는 그대로다. 재계획 → 재승인 → 구현도 S1 을 잇는다.
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
  const recoveryChecks: SessionTurn[] = [];
  const lost = new Set<string>();
  let creates = 0, currentPlan = plan, diagnosisId = "";
  const diagnosisFindings = () => diagnosisId ? [{ id: diagnosisId, title: "중재자 진단", severity: "HIGH" as const, disposition: "AGREED_ACTION" as const,
    rationale: "검증 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }] : [];
  const runClaude = async (t: SessionTurn): Promise<AgentResult> => {
    if (lost.has(t.sessionId)) throw agentRunError("claude", 1, `No conversation found with session ID: ${t.sessionId}\n`,
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: t.sessionId }));
    if (t.protocolOnly) {
      if (database.getTopic("topic").state === "IMPLEMENTING") recoveryChecks.push(t);
      return { kind: "ACK", summary: "ack", findings: [], evidenceRefs: [], planSHA256: database.getTopic("topic").planSHA256! };
    }
    modelTurns.push(t);
    t.onSessionCreated?.(t.sessionId);
    t.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });
    t.onUsage?.({ inputTokens: 100, outputTokens: 20, durationMs: 1, recordKind: "final" });
    if (t.implementation) return { kind: "IMPLEMENTATION", summary: "Await decision", status: "blocked", findings: [], evidenceRefs: [], requestedUserDecision: "Confirm completion" };
    if (t.job?.operation === "diagnosis-revision") {
      // 계획 변경 진단의 개정 — 계획을 실제로 바꾸고 진단 처분을 남긴다.
      currentPlan = plan.replace("UNIQUE_PLAN_BODY", "UNIQUE_PLAN_BODY\n\nREPLANNED_VERIFICATION_STEP");
      return { kind: "REVISION", summary: "Replanned", planMarkdown: currentPlan, evidenceRefs: [], planningStep: step({ questions: [], complete: true }),
        findings: [{ id: diagnosisId, title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "검증 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }] };
    }
    const revision = database.getTopic("topic").state === "CLAUDE_REVISION";
    return { kind: revision ? "REVISION" : "PLAN", summary: "Plan", planMarkdown: currentPlan,
      findings: revision ? [finding, ...diagnosisFindings()] : [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
  };
  const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: async t => {
      // 합의 단계의 격리 ACK 는 일회용 세션이고, 구현 중의 protocol 턴은 복구 세션 S1 을 만든다.
      const id = t.protocolOnly && database.getTopic("topic").state !== "IMPLEMENTING" ? "ack-only" : `author-${++creates}`;
      return { sessionId: id, result: await runClaude({ ...t, sessionId: id }) };
    },
    resumeTurn: runClaude };
  const codex: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
    createSession: async t => ({ sessionId: "review", result: await codex.resumeTurn({ ...t, sessionId: "review" }) }),
    resumeTurn: async t => ({ kind: t.protocolOnly ? "ACK" : database.getTopic("topic").state === "CODEX_AUDIT" ? "AUDIT" : "CLOSEOUT",
      summary: "Reviewed", findings: t.protocolOnly ? [] : [finding, ...diagnosisFindings()], evidenceRefs: [], planSHA256: database.getTopic("topic").planSHA256! }) };
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
  const lastImplementation = modelTurns.at(-1)!;
  const approvedBefore = database.getTopic("topic").approvedPlanSHA256;
  const plannerCheckpointBefore = database.latestPlannerCheckpoint("topic", "claude");
  // 작성자 세션 author-1 이 실제로 유실됐다(관측된 session-missing) — 같은 작업 route 의 새 세션 author-2 가 먼저 승인 계획을 읽기 전용으로 확인한다.
  lost.add("author-1");
  engine.retry("topic"); await settle();
  expect(database.getTopic("topic").state, database.getTopic("topic").lastError ?? "").toBe("USER_DECISION_REQUIRED");
  expect(creates).toBe(2);
  expect(recoveryChecks).toHaveLength(1);
  const check = recoveryChecks[0];
  expect(check).toMatchObject({ sessionId: "author-2", protocolOnly: true, implementation: false, job: { role: "planner", operation: "ack" } });
  expect(check.settings).toEqual(lastImplementation.settings);
  expect(check.planningControl).toBeUndefined();
  expect(check.prompt).toContain(database.getTopic("topic").planSHA256!);
  // 확인 뒤 참여자·ACK(=author-2 가 답한 값)·승인 바인딩·구현 세션이 author-2 로 함께 옮겨졌다. 사용자 승인·계획자 checkpoint 는 그대로다.
  const switched = database.getTopic("topic");
  expect(switched.participants.find(participant => participant.role === "claude")).toMatchObject({ sessionId: "author-2", acknowledgedPlanSHA256: switched.planSHA256 });
  expect(database.getFlags("topic").implementationSessionId).toBe("author-2");
  expect(database.planning.boundSession(switched)?.sessionId).toBe("author-2");
  expect(switched.approvedPlanSHA256).toBe(approvedBefore);
  expect(database.latestPlannerCheckpoint("topic", "claude")).toEqual(plannerCheckpointBefore);
  // 첫 쓰기 턴은 author-2 에 전문 판(계획 본문 포함)이다 — 확인만 받은 세션이라 이어 쓰기 판을 보내지 않는다.
  const handoff = modelTurns.at(-1)!;
  expect(handoff).toMatchObject({ sessionId: "author-2", implementation: true });
  expect(handoff.prompt).toContain("UNIQUE_PLAN_BODY");
  const lineage = database.planning.storedRecoveryLineage("topic", "implementer")!;
  expect(lineage.recoveries).toHaveLength(1);
  expect(lineage.recoveries[0]).toMatchObject({ reason: "session-missing", fromSession: "author-1", toSession: "author-2",
    verification: { phase: "verified", session: "author-2", handoff: "done", planSHA256: switched.planSHA256 } });

  // 재계획 → 재승인 → 구현이 author-2 를 잇는다: 계획 변경 진단의 개정 턴이 좌석 세션 author-2 를 재개하고, 그 진짜 계획자 checkpoint 로 바인딩된다.
  const diagnosis = await engine.registerDiagnosis("topic", DiagnosisInputSchema.parse({ kind: "fix", title: "계획 변경: 검증 단계 추가",
    observedFailure: "검증 기준이 부족합니다.", evidenceRefs: ["evidence/check.log"], cause: "승인 계획에 검증 단계가 없습니다.", uncertainty: "없음",
    instructions: "검증 단계를 계획에 추가하세요.", verificationCriteria: ["검증 green"], planChange: { required: true, reason: "승인 범위에 검증 단계를 더해야 합니다." } }));
  diagnosisId = diagnosis.id;
  await engine.applyDiagnosis("topic", diagnosis.id, {}); await settle();
  // 첫 계획 흐름이 계획 검토 한도를 썼다 — 재계획의 감사·종결이 한도에 닿으면 사용자 승인으로 1회씩 더하고 재개한다(이 검사의 대상이 아니다).
  for (let grants = 0; grants < 3 && (database.getTopic("topic").lastError ?? "").includes("계획 검토 한도"); grants += 1) {
    database.reviews.grant("topic", "planning", `replan-review-${grants}`, database.reviews.account("topic", "planning").version);
    engine.retry("topic"); await settle();
  }
  expect(database.getTopic("topic").state, database.getTopic("topic").lastError ?? "").toBe("AWAITING_USER_APPROVAL");
  expect(creates).toBe(2);
  const replanned = database.getTopic("topic");
  expect(database.planning.boundSession(replanned)?.sessionId).toBe("author-2");
  expect(database.latestPlannerCheckpoint("topic", "claude")?.sessionId).toBe("author-2");
  engine.approve("topic", replanned.planSHA256!);
  engine.startImplementation("topic"); await settle();
  expect(modelTurns.at(-1)).toMatchObject({ sessionId: "author-2", implementation: true });
  expect(database.getFlags("topic").implementationSessionId).toBe("author-2");
  expect(creates).toBe(2);
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

// E3-2-2a — 세션 유지 계획 제어 턴의 타임라인 버전 고정 참조. 공개 흐름은 엔진(startPlan·retry) + 실제 guardedPlanning(엔진이 예산·작업 묶음 래퍼로 감싼다)
// + 아래 읽기 모델 대역이다. 대역은 모델이 하듯 패킷의 참조 표시(와 읽은 색인)에서 selector 를 찾고, 받은 조각을 모아 각 문서를 offset 0 부터 돌려받은
// nextOffset 을 따라 읽는다(다음 offset 은 앞 조각을 받아야 알 수 있어 한 문서는 라운드마다 한 조각이다). 래퍼는 문자열을 해석하지 않는다.
describe("E3-2-2a timeline references", () => {
  const TOLERANCE = '\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';
  const planMarkdown = (marker: string) => REQUIRED_PLAN_HEADINGS
    .map(heading => `## ${heading}\n\n${marker} ${heading}${heading === "허용 오차" ? TOLERANCE : ""}`).join("\n\n");
  const korean = (length: number) => Array.from({ length }, (_, i) => "가나다라마바사아자차카타파하"[i % 14]).join("");
  const mixed = (length: number) => Array.from({ length }, (_, i) => ["가", "😀", '"', "\\", "\n", "a", "}"][i % 7]).join("");
  const SELECTOR = /timeline(?::\d+|-index)@[a-f0-9]{64}/g;
  const done = (plan: string): AgentResult => ({ ...answer(step({ questions: [], complete: true })), planMarkdown: plan });

  type Received = Map<string, Map<number, PlanningFragment>>;
  function assembled(received: Received, selector: string): { text: string; complete: boolean; next: number } {
    let offset = 0, text = "";
    const parts = received.get(selector);
    while (parts?.has(offset)) {
      const fragment = parts.get(offset)!;
      text += fragment.content;
      if (fragment.nextOffset === null) return { text, complete: true, next: offset };
      offset = fragment.nextOffset;
    }
    return { text, complete: false, next: offset };
  }
  type Hook = (turn: Omit<SessionTurn, "sessionId">, call: number, state: { received: Received; selectors: Set<string>;
    pending: () => Array<{ selector: string; next: number }> }) => Promise<AgentResult | undefined> | AgentResult | undefined;
  function readingModel(plan: string, hook?: Hook, role: "claude" | "codex" = "claude") {
    const received: Received = new Map();
    const selectors = new Set<string>();
    const delivered: Array<{ call: number; selector: string; offset: number }> = [];
    const pending = () => [...selectors].map(selector => ({ selector, ...assembled(received, selector) }))
      .filter(entry => !entry.complete).map(entry => ({ selector: entry.selector, next: entry.next }));
    const model = scripted(async (turn, call) => {
      for (const selector of turn.prompt.match(SELECTOR) ?? []) selectors.add(selector);
      const tail = turn.prompt.split("Fragments: ").at(-1)!;
      const arrived = JSON.parse(tail) as PlanningFragment[];
      // 수신이 인정되지 않은 조각만 버리고 다시 청한다. 공백 뒤의 정상 수신 조각은 그대로 보존한다.
      const status = turn.prompt.split("\n").find(line => line.startsWith("Required timeline references not yet fully read"));
      for (const entry of status ? JSON.parse(status.slice(status.indexOf("again: ") + 7).split(" (")[0]) as Array<{ selector: string; offset: number }> : []) {
        received.get(entry.selector)?.delete(entry.offset);
      }
      for (const fragment of arrived) {
        if (!received.has(fragment.selector)) received.set(fragment.selector, new Map());
        received.get(fragment.selector)!.set(fragment.offset, fragment);
        delivered.push({ call, selector: fragment.selector, offset: fragment.offset });
      }
      for (const selector of [...selectors].filter(item => item.startsWith("timeline-index@"))) {
        const index = assembled(received, selector);
        if (index.complete) for (const line of index.text.split("\n")) selectors.add(JSON.parse(line).selector);
      }
      const custom = await hook?.(turn, call, { received, selectors, pending });
      if (custom) return custom;
      const open = pending();
      if (!open.length || turn.prompt.includes("No more research is available")) return done(plan);
      return answer(step({ questions: [], requests: open.slice(0, PLANNING_LIMITS.requests)
        .map(entry => ({ kind: "context" as const, selector: entry.selector, offset: entry.next, question: "Read the timeline reference" })) }));
    }, role);
    return { ...model, received, selectors, delivered };
  }
  // 연속성 v2 계획 주제(setup 이 이력 전에 계획 제어를 켠다) — 두 좌석이 기존 세션에 붙어 있다.
  function referenceTopic(executionInput?: number) {
    const context = setup("claude", executionInput);
    context.database.updateTopic("topic", { state: "DRAFT" });
    for (const role of ["claude", "codex"] as const) context.database.upsertParticipant("topic", {
      role, sessionId: `${role}-existing`, mode: "attached", acknowledgedPlanSHA256: null });
    const settle = async () => {
      const deadline = Date.now() + 10_000;
      while (context.database.runningAction("topic")) {
        if (Date.now() > deadline) throw new Error("Workflow did not complete");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    return { ...context, settle, artifacts: new ArtifactStore(join(context.root, "artifacts"), context.database) };
  }
  const eventOf = (database: ConsensusDatabase, body: string) => database.getTimeline("topic").find(event => event.body === body)!;
  const stopAudit = () => scripted(async () => { throw new Error("E3_2_2A_AUDIT_STOP"); }, "codex");

  it("reads a large required decision and a mixed reference to the end within one attempt before the plan is accepted", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const decision = korean(10_000);
    const evidence = mixed(12_000);
    expect(database.planning.continuityEnabled("topic")).toBe(true);
    const engineDecision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: decision });
    const engineEvidence = database.appendEvent({ topicId: "topic", actor: "user", kind: "evidence", state: "DRAFT", body: evidence });
    const model = readingModel(planMarkdown("E3_2_2A_WITHIN"));
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();

    const references = [timelineReference(engineDecision), timelineReference(engineEvidence)];
    const first = model.calls[0].prompt;
    for (const reference of references) expect(first).toContain(reference.selector);
    expect(first).toContain("[참조·필수]");
    expect(first).not.toContain(decision.slice(0, 300));
    expect(first).not.toContain(evidence.slice(0, 300));
    expect(model.calls.every(call => Buffer.byteLength(call.prompt) < PLANNING_LIMITS.promptBytes)).toBe(true);
    for (const [reference, event] of [[references[0], engineDecision], [references[1], engineEvidence]] as const) {
      expect(assembled(model.received, reference.selector)).toMatchObject({ complete: true, text: timelineEventText(event) });
      expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    }
    const keys = model.delivered.map(entry => `${entry.selector}#${entry.offset}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(database.planning.unreadSessionReferences("claude-existing", database.getTopic("topic"))).toEqual([]);
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_WITHIN");
    expect(database.getTopic("topic")).toMatchObject({ state: "FAILED", lastError: "E3_2_2A_AUDIT_STOP" });
    expect(model.calls.length).toBeLessThanOrEqual(FORMER_RESEARCH_ROUNDS);
    await engine.shutdown();
  });

  // E3-4a: 예전에는 한 시도의 고정 회차(8 + 정리 1) 때문에 문서 하나를 약 46KB 까지만 읽고 멈췄다. 회차 상한이 없어져 같은 시도에서 끝까지 읽는다.
  it("reads a required decision that needs more read rounds than the former fixed cap to the end within one attempt", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: korean(30_000) });
    const reference = timelineReference(decision);
    expect(reference.bytes).toBeGreaterThan(PLANNING_LIMITS.promptBytes);
    const model = readingModel(planMarkdown("E3_2_2A_OVER"));
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    expect(model.calls[0].prompt).not.toContain(decision.body.slice(0, 300));
    expect(model.calls.length).toBeGreaterThan(FORMER_RESEARCH_ROUNDS + 1);
    expect(model.calls.some(call => call.prompt.includes("No more research is available"))).toBe(false);
    expect(model.calls.every(call => Buffer.byteLength(call.prompt) < PLANNING_LIMITS.promptBytes)).toBe(true);
    expect(assembled(model.received, reference.selector)).toMatchObject({ complete: true, text: timelineEventText(decision) });
    const keys = model.delivered.map(entry => `${entry.selector}#${entry.offset}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_OVER");
    expect(database.getTopic("topic")).toMatchObject({ state: "FAILED", lastError: "E3_2_2A_AUDIT_STOP" });
    await engine.shutdown();
  });

  // E3-4a Q-A2: 끝 조각을 먼저 읽고 가운데가 빈 채 낸 완료는 거절하지 않고 중간 단계로 강등한다 — 같은 시도에서 호스트가 남은 필수 구간을 청해 싣고 다시 판단한다.
  it("does not accept completion after the last fragment was read first or a middle range is missing, and reads the gap in the same attempt", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: "x".repeat(24_000) });
    const reference = timelineReference(decision);
    const last = Math.floor((reference.bytes - 1) / 6000) * 6000;
    let forced = true;
    const model = readingModel(planMarkdown("E3_2_2A_GAP"), (_turn, call, state) => {
      if (call === 1) return answer(step({ requests: [
        { kind: "context", selector: reference.selector, offset: last, question: "Read the end first" },
        { kind: "context", selector: reference.selector, offset: 0, question: "Read the start" },
      ] }));
      if (forced && call === 2) {
        forced = false;
        expect(state.received.get(reference.selector)?.get(last)?.nextOffset).toBeNull();
        return done(planMarkdown("E3_2_2A_GAP"));
      }
      return undefined;
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    // 둘째 응답(가운데가 빈 완료)은 채택되지 않고 강등됐다 — 셋째 호출의 checkpoint 는 complete=false 이고, 모델이 청하지 않은 첫 공백 구간을 호스트가 실었다.
    const gapStart = model.received.get(reference.selector)!.get(0)!.nextOffset!;
    expect(model.calls[2].prompt).toContain('"complete":false');
    const third = JSON.parse(model.calls[2].prompt.split("Fragments: ").at(-1)!) as PlanningFragment[];
    expect(third.map(fragment => [fragment.selector, fragment.offset])).toEqual([[reference.selector, gapStart]]);
    expect(database.getTopic("topic").lastError ?? "").not.toContain("not fully read");
    expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    expect(assembled(model.received, reference.selector)).toMatchObject({ complete: true, text: timelineEventText(decision) });
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_GAP");
    expect(database.getTopic("topic")).toMatchObject({ state: "FAILED", lastError: "E3_2_2A_AUDIT_STOP" });
    await engine.shutdown();
  });

  it("does not acknowledge ranges of a call that ignored cancellation and resolved late, and reads them again", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: korean(6_000) });
    const reference = timelineReference(decision);
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    let lateOffset = -1;
    const model = readingModel(planMarkdown("E3_2_2A_LATE"), async (turn, call, state) => {
      if (call !== 2) return undefined;
      lateOffset = [...state.received.get(reference.selector)!.keys()][0];
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      const open = state.pending();
      return answer(step({ requests: open.map(entry => ({ kind: "context" as const, selector: entry.selector, offset: entry.next, question: "Continue" })) }));
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic");
    await pending;
    engine.stop("topic");
    expect(() => engine.retry("topic")).toThrow();
    release();
    await settle();
    const stopped = database.getTopic("topic");
    expect(stopped).toMatchObject({ state: "FAILED", lastError: "사용자가 실행을 중단했습니다." });
    expect(lateOffset).toBe(0);
    expect(database.planning.referenceReadAcknowledged("claude-existing", stopped, reference.selector, reference.hash, 0)).toBe(false);
    const before = model.delivered.length;
    engine.retry("topic"); await settle();
    expect(model.delivered.slice(before).some(entry => entry.selector === reference.selector && entry.offset === 0)).toBe(true);
    expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_LATE");
    await engine.shutdown();
  });

  it("stores reference completion only as gap-free acknowledged coverage of the pinned version in the same session", () => {
    const { database } = setup();
    const topic = database.getTopic("topic");
    const event = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_PLAN", body: "y".repeat(100) });
    const reference = timelineReference(event);
    const read = (offset: number, nextOffset: number | null, hash = reference.hash) =>
      ({ selector: reference.selector, hash, offset, nextOffset, total: reference.bytes });
    database.planning.acknowledgeReferenceReads("session-a", topic, [read(80, null)]);
    expect(database.planning.referenceComplete("session-a", topic, reference)).toBe(false);
    database.planning.acknowledgeReferenceReads("session-a", topic, [read(0, 40)]);
    expect(database.planning.referenceComplete("session-a", topic, reference)).toBe(false);
    expect(database.planning.referenceCovered("session-a", topic, reference)).toBe(40);
    database.planning.acknowledgeReferenceReads("session-b", topic, [read(40, 80)]);
    database.planning.acknowledgeReferenceReads("session-a", topic, [{ ...read(40, 80, "f".repeat(64)) }]);
    expect(database.planning.referenceComplete("session-a", topic, reference)).toBe(false);
    database.planning.acknowledgeReferenceReads("session-a", { ...topic, scopeGeneration: topic.scopeGeneration + 1 }, [read(40, 80)]);
    expect(database.planning.referenceComplete("session-a", topic, reference)).toBe(false);
    expect(database.planning.referenceComplete("session-a", topic, { ...reference, unit: "codepoint" as never })).toBe(false);
    database.planning.acknowledgeReferenceReads("session-a", topic, [read(40, 80)]);
    expect(database.planning.referenceComplete("session-a", topic, reference)).toBe(true);
    expect(database.planning.referenceComplete("session-b", topic, reference)).toBe(false);
  });

  it("carries a reference the reviewer left unread at audit into closeout of the same session after the planning cursor advanced", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    // 호스트가 모르는 붙인 검토 세션은 기존 규칙으로 안전 정지한다 — 감사가 자기 세션을 만들도록 좌석을 비운다.
    database.upsertParticipant("topic", { role: "codex", sessionId: "pending:codex-e3", mode: "attached", acknowledgedPlanSHA256: null });
    const evidence = database.appendEvent({ topicId: "topic", actor: "user", kind: "evidence", state: "DRAFT", body: mixed(10_000) });
    const reference = timelineReference(evidence);
    const plan = `${planMarkdown("E3_2_2A_REVIEW")}\n\n${"계획 본문 ".repeat(600)}`;
    const stopAck = (turn: Omit<SessionTurn, "sessionId">) => { if (turn.protocolOnly) throw new Error("E3_2_2A_ACK_STOP"); };
    const claude = readingModel(plan, turn => {
      stopAck(turn);
      if (turn.prompt.includes("Codex 감사에 답하고")) return { kind: "REVISION", summary: "개정", findings: [], evidenceRefs: [], planEdits: [],
        planningStep: step({ questions: [], complete: true }) };
      return done(plan);
    });
    let auditCalls = 0, closeoutSHA = "", closeoutFirst = -1, stage = "";
    const codex = readingModel(plan, (turn, call, state) => {
      stopAck(turn);
      // 같은 세션의 다음 라운드는 "Continue the task already in this session." 만 받으므로 단계는 과제를 처음 받았을 때 정한다.
      if (turn.prompt.includes("검토할 계획 SHA-256")) stage = "audit";
      if (turn.prompt.includes("개정 계획 SHA-256")) stage = "closeout";
      if (stage === "audit") {
        auditCalls += 1;
        return auditCalls === 1
          ? answer(step({ questions: [], requests: [{ kind: "context", selector: reference.selector, offset: 0, question: "Start reading" }] }))
          : { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
      }
      const sha = /개정 계획 SHA-256: ([a-f0-9]{64})/.exec(turn.prompt)?.[1];
      if (sha) { closeoutSHA = sha; closeoutFirst = call; }
      if (state.pending().length) return undefined;
      return { kind: "CLOSEOUT", summary: "종결", planSHA256: closeoutSHA, findings: [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
    }, "codex");
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(claude.adapter, database, git),
      codex: guardedPlanning(codex.adapter, database, git) });
    engine.startPlan("topic"); await settle();
    const topic = database.getTopic("topic");
    expect(database.latestArtifact("topic", "closeout")).not.toBeNull();
    expect(closeoutFirst).toBeGreaterThan(0);
    const packet = codex.calls[closeoutFirst - 1].prompt;
    const note = packet.indexOf("Timeline references from earlier turns in this session");
    expect(note).toBeGreaterThan(0);
    expect(packet.slice(note)).toContain(reference.selector);
    expect(packet.slice(0, note)).not.toContain(reference.selector);
    const auditOffsets = codex.delivered.filter(entry => entry.call < closeoutFirst).map(entry => entry.offset);
    expect(auditOffsets).toEqual([0]);
    expect(codex.delivered.filter(entry => entry.call >= closeoutFirst).map(entry => entry.offset)).not.toContain(0);
    const reviewSession = topic.participants.find(participant => participant.role === "codex")!.sessionId;
    expect(new Set(codex.calls.map(call => (call as SessionTurn).sessionId).filter(Boolean))).toEqual(new Set([reviewSession]));
    expect(database.planning.referenceComplete(reviewSession, topic, reference)).toBe(true);
    expect(assembled(codex.received, reference.selector)).toMatchObject({ complete: true, text: timelineEventText(evidence) });
    await engine.shutdown();
  });

  it("resumes the same session after a database reopen without resending acknowledged ranges", async () => {
    const { root, database, git, artifacts } = referenceTopic();
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: korean(12_000) });
    const reference = timelineReference(decision);
    let fail = true;
    const model = readingModel(planMarkdown("E3_2_2A_RESTART"), (_turn, call) => {
      if (fail && call === 4) { fail = false; throw new Error("E3_2_2A_TRANSPORT"); }
      return undefined;
    });
    const settleOn = async (db: ConsensusDatabase) => {
      const deadline = Date.now() + 10_000;
      while (db.runningAction("topic")) {
        if (Date.now() > deadline) throw new Error("Workflow did not complete");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settleOn(database);
    expect(database.getTopic("topic")).toMatchObject({ state: "FAILED", lastError: "E3_2_2A_TRANSPORT" });
    const acknowledged = model.delivered.filter(entry => entry.call < 4).map(entry => entry.offset);
    const failedCall = model.delivered.filter(entry => entry.call === 4).map(entry => entry.offset);
    expect(acknowledged.length).toBeGreaterThan(0);
    expect(failedCall.length).toBeGreaterThan(0);
    await engine.shutdown();
    const reopened = new ConsensusDatabase(join(root, "room.db"));
    cleanups.push(() => reopened.close());
    expect(database.planning.referenceCovered("claude-existing", reopened.getTopic("topic"), reference))
      .toBe(reopened.planning.referenceCovered("claude-existing", reopened.getTopic("topic"), reference));
    const before = model.delivered.length;
    const restarted = new WorkflowEngine({ database: reopened, git, artifacts: new ArtifactStore(join(root, "artifacts"), reopened),
      claude: guardedPlanning(model.adapter, reopened, git), codex: stopAudit().adapter });
    restarted.retry("topic"); await settleOn(reopened);
    const after = model.delivered.slice(before).map(entry => entry.offset);
    for (const offset of acknowledged) expect(after).not.toContain(offset);
    for (const offset of failedCall) expect(after).toContain(offset);
    expect(reopened.planning.referenceComplete("claude-existing", reopened.getTopic("topic"), reference)).toBe(true);
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_RESTART");
    await restarted.shutdown();
  });

  it("does not inherit reads or unread references into a replacement session", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const evidence = database.appendEvent({ topicId: "topic", actor: "user", kind: "evidence", state: "DRAFT", body: mixed(10_000) });
    const reference = timelineReference(evidence);
    const plan = planMarkdown("E3_2_2A_REPLACE");
    const perSession = new Map<string, number>();
    const model = readingModel(plan, turn => {
      const session = (turn as SessionTurn).sessionId ?? "created";
      const calls = (perSession.get(session) ?? 0) + 1;
      perSession.set(session, calls);
      return calls === 1
        ? answer(step({ questions: [], requests: [{ kind: "context", selector: reference.selector, offset: 0, question: "Start reading" }] }))
        : done(plan);
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    expect(database.planning.referenceCovered("claude-existing", database.getTopic("topic"), reference)).toBeGreaterThan(0);
    database.updateTopic("topic", { state: "AWAITING_USER_APPROVAL" });
    await engine.postMessage("topic", "decision", "E3_2_2A 교체 세션으로 다시 계획");
    await engine.attachParticipant("topic", "claude", { mode: "attach", sessionId: "claude-replacement" });
    const before = model.calls.length, delivered = model.delivered.length;
    engine.startPlan("topic"); await settle();
    const replacement = model.calls.slice(before);
    expect(replacement.map(call => (call as SessionTurn).sessionId)).toEqual(["claude-replacement", "claude-replacement"]);
    expect(replacement.some(call => call.prompt.includes("from earlier turns") || call.prompt.includes("not yet fully read"))).toBe(false);
    expect(model.delivered.slice(delivered).map(entry => entry.offset)).toContain(0);
    const topic = database.getTopic("topic");
    expect(database.planning.unreadSessionReferences("claude-replacement", topic).map(item => item.selector)).toEqual([reference.selector]);
    expect(database.planning.referenceCovered("claude-replacement", topic, reference))
      .toBe(database.planning.referenceCovered("claude-existing", topic, reference));
    await engine.shutdown();
  });

  it("replaces an oversized reference list with one index reference that is read by range", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const notes = Array.from({ length: 60 }, (_, i) => database.appendEvent({ topicId: "topic", actor: "codex", kind: "note", state: "DRAFT",
      body: `E3_2_2A_NOTE_${i} ${"기록".repeat(300)}` }));
    const planned = planTimelineDelivery(notes);
    expect(planned.index).not.toBeNull();
    let readOne = "";
    const model = readingModel(planMarkdown("E3_2_2A_INDEX"), (_turn, _call, state) => {
      const index = [...state.selectors].find(selector => selector.startsWith("timeline-index@"))!;
      if (!assembled(state.received, index).complete) return undefined;
      readOne ||= [...state.selectors].find(selector => selector.startsWith("timeline:"))!;
      return assembled(state.received, readOne).complete ? done(planMarkdown("E3_2_2A_INDEX")) : answer(step({ questions: [],
        requests: [{ kind: "context", selector: readOne, offset: assembled(state.received, readOne).next, question: "Read one listed reference" }] }));
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    const first = model.calls[0].prompt;
    expect(first).toContain(planned.index!.selector);
    for (const reference of planned.references) expect(first).not.toContain(reference.selector);
    const indexText = assembled(model.received, planned.index!.selector);
    expect(indexText.complete).toBe(true);
    expect(indexText.text.split("\n").map(line => JSON.parse(line).selector)).toEqual(planned.references.map(reference => reference.selector));
    expect(planned.references.map(reference => reference.selector)).toContain(readOne);
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_INDEX");
    await engine.shutdown();
  });

  it("merges a large decision that arrives during planning as a reference instead of raw text", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    database.appendEvent({ topicId: "topic", actor: "user", kind: "evidence", state: "DRAFT", body: mixed(10_000) });
    const late = korean(50_000);
    let posted = false;
    let engine!: WorkflowEngine;
    const model = readingModel(planMarkdown("E3_2_2A_MERGE"), async (_turn, call) => {
      if (call === 2 && !posted) { posted = true; await engine.postMessage("topic", "decision", late); }
      return undefined;
    });
    engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    expect(database.getTopic("topic").lastError).toContain("New user decisions or evidence");
    const decision = eventOf(database, late);
    const before = model.calls.length;
    engine.retry("topic"); await settle();
    const retried = model.calls.slice(before);
    expect(retried.length).toBeGreaterThan(0);
    expect(retried[0].prompt).toContain(timelineReference(decision).selector);
    expect(retried[0].prompt).not.toContain(late.slice(0, 300));
    expect(retried.every(call => Buffer.byteLength(call.prompt) < PLANNING_LIMITS.promptBytes)).toBe(true);
    expect(database.getTopic("topic").lastError ?? "").not.toContain("exceed the planning packet limit");
    await engine.shutdown();
  });

  it("does not acknowledge a late response while a scope change waits for it", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: korean(6_000) });
    const reference = timelineReference(decision);
    const oldScope = database.getTopic("topic");
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    const model = readingModel(planMarkdown("E3_2_2A_SCOPE"), async (_turn, call, state) => {
      if (call !== 2) return undefined;
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return answer(step({ questions: [], requests: state.pending().map(entry => ({ kind: "context" as const, selector: entry.selector, offset: entry.next, question: "Continue" })) }));
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic");
    await waiting;
    const changing = engine.handleScopeChange("topic", "E3_2_2A 범위 변경");
    release();
    await changing;
    await settle();
    const topic = database.getTopic("topic");
    expect(topic.scopeGeneration).toBe(oldScope.scopeGeneration + 1);
    expect(database.planning.referenceReadAcknowledged("claude-existing", oldScope, reference.selector, reference.hash, 0)).toBe(false);
    expect(database.planning.unreadSessionReferences("claude-existing", topic)).toEqual([]);
    await engine.shutdown();
  });

  it("keeps timeline selectors out of default builders, v1 planners and paths without session-keeping planning control", async () => {
    const big = { sequence: 7, actor: "user" as const, kind: "decision" as const, body: korean(8_000), payload: {} };
    const event = { ...big, id: 7, topicId: "topic", scopeGeneration: 1, state: "DRAFT" as const, createdAt: new Date().toISOString() } as TimelineEvent;
    const builder = buildClaudePlanPrompt({ title: "t", worktreePath: "/w", sourceRepositoryPath: "/r", baseRef: "HEAD", scopeGeneration: 1, timeline: [event] });
    expect(builder).not.toMatch(/timeline:\d+@/);
    const delivery = { prompt: planTimelineDelivery([event]) };
    expect(delivery.prompt.references).toHaveLength(1);

    // 엔진 descriptor 의 해시가 불변 행과 다르면(버전이 바뀐 참조) 모델을 부르지 않는다.
    const pinned = setup();
    const row = pinned.database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_PLAN", body: korean(8_000) });
    const stale = { ...timelineReference(row), hash: "0".repeat(64), selector: `timeline:${row.sequence}@${"0".repeat(64)}` };
    const staleModel = scripted(async () => answer(step({ questions: [], complete: true })));
    await expect(guardedPlanning(staleModel.adapter, pinned.database, pinned.git).createSession({ cwd: pinned.repo, prompt: "Plan",
      timelineDelivery: { prompt: { inline: [], references: [stale], index: null } } })).rejects.toThrow("no longer matches its immutable event");
    expect(staleModel.calls).toHaveLength(0);

    const disabled = setup("claude", 100000, 100000, false);
    const refused = scripted(async () => answer(step({ questions: [], complete: true })));
    await expect(guardedPlanning(refused.adapter, disabled.database, disabled.git).createSession({ cwd: disabled.repo, prompt: "Plan",
      timelineDelivery: delivery })).rejects.toThrow("Timeline references need session-keeping planning control");
    expect(refused.calls).toHaveLength(0);

    const v1 = setup("claude", 100000, 100000, false);
    await new ArtifactStore(join(v1.root, "artifacts"), v1.database).write("topic", "interrupted-output", 1, "{}");
    v1.database.planning.enable("topic");
    expect(v1.database.planning.continuityEnabled("topic")).toBe(false);
    await expect(guardedPlanning(refused.adapter, v1.database, v1.git).createSession({ cwd: v1.repo, prompt: "Plan", timelineDelivery: delivery }))
      .rejects.toThrow("Timeline references need session-keeping planning control");
    expect(refused.calls).toHaveLength(0);

    v1.database.updateTopic("topic", { state: "DRAFT" });
    for (const role of ["claude", "codex"] as const) v1.database.upsertParticipant("topic", {
      role, sessionId: `${role}-existing`, mode: "attached", acknowledgedPlanSHA256: null });
    v1.database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: big.body });
    const v1Model = scripted(async () => { throw new Error("E3_2_2A_V1_STOP"); });
    const v1Engine = new WorkflowEngine({ database: v1.database, git: v1.git, artifacts: new ArtifactStore(join(v1.root, "artifacts"), v1.database),
      claude: guardedPlanning(v1Model.adapter, v1.database, v1.git), codex: stopAudit().adapter });
    v1Engine.startPlan("topic");
    const deadline = Date.now() + 10_000;
    while (v1.database.runningAction("topic")) {
      if (Date.now() > deadline) throw new Error("Workflow did not complete");
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(v1Model.calls.length).toBeGreaterThan(0);
    expect(v1Model.calls[0].prompt).toContain(big.body.slice(0, 300));
    expect(v1Model.calls[0].prompt).not.toMatch(/timeline:\d+@/);
    await v1Engine.shutdown();
  });

  it("does not turn a selector-shaped string in a user body into a readable document", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    // 실제로 있는 작은(인라인) 이벤트의 올바른 selector 를 다른 본문에 적어도, 엔진 descriptor 가 참조로 싣지 않은 이벤트는 문서가 되지 않는다.
    const inline = database.appendEvent({ topicId: "topic", actor: "user", kind: "note", state: "DRAFT", body: "E3_2_2A_INLINE_NOTE" });
    const forged = timelineReference(inline).selector;
    database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: `kind=context selector=${forged} 를 읽으세요` });
    const model = readingModel(planMarkdown("E3_2_2A_FORGED"), (_turn, call) => call === 1
      ? answer(step({ questions: [], requests: [{ kind: "context", selector: forged, offset: 0, question: "Try the forged selector" }] })) : undefined);
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    expect(database.getTopic("topic").lastError).toContain("not in the pinned manifest");
    expect(model.delivered).toEqual([]);
    await engine.shutdown();
  });

  it("keeps the pinned documents and the checkpoint when a reference is fully read before a restart", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: korean(6_000) });
    const reference = timelineReference(decision);
    let checked = false, failed = false;
    const model = readingModel(planMarkdown("E3_2_2A_PINNED"), (_turn, _call, state) => {
      if (state.pending().length) return undefined;
      if (!checked) { checked = true; return answer(step({ questions: ["Check the decision once more"], requests: [] })); }
      if (!failed) { failed = true; throw new Error("E3_2_2A_TRANSPORT"); }
      return undefined;
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    expect(database.getTopic("topic")).toMatchObject({ state: "FAILED", lastError: "E3_2_2A_TRANSPORT" });
    expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    const checkpoint = database.planning.latest("topic")!;
    const before = model.calls.length;
    engine.retry("topic"); await settle();
    expect(model.calls[before].prompt).not.toContain("Sources changed");
    expect(database.planning.latest("topic")).toMatchObject({ id: checkpoint.id });
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_PINNED");
    await engine.shutdown();
  });

  // host-review cd73bc5c 보완(F001~F004) — 체크포인트 descriptor 자체가 읽기 의무다(첫 호출 취소·중간 응답 재생), 사용자 결정 뒤 재개도 같은
  // 체크포인트에서 읽기를 잇는다, 현황 안내는 크기가 제한된다, 참조 모드 조회는 최근 80개 제한 없이 전체를 싣는다.
  async function cancelledFirstCall(respond: (state: { pending: () => Array<{ selector: string; next: number }> }) => AgentResult) {
    const context = referenceTopic();
    const decision = context.database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: korean(6_000) });
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let forcedAfterRetry = 0;
    const model = readingModel(planMarkdown("E3_2_2A_FIRST"), async (_turn, call, state) => {
      if (call === 1) {
        entered();
        await new Promise<void>(resolve => { release = resolve; });
        return respond(state);
      }
      return forcedAfterRetry-- > 0 ? done(planMarkdown("E3_2_2A_FIRST")) : undefined;
    });
    const engine = new WorkflowEngine({ database: context.database, git: context.git, artifacts: context.artifacts,
      claude: guardedPlanning(model.adapter, context.database, context.git), codex: stopAudit().adapter });
    engine.startPlan("topic");
    await waiting;
    engine.stop("topic");
    release();
    await context.settle();
    expect(context.database.getTopic("topic")).toMatchObject({ state: "FAILED", lastError: "사용자가 실행을 중단했습니다." });
    return { ...context, engine, model, reference: timelineReference(decision), force: (count: number) => { forcedAfterRetry = count; } };
  }

  it("keeps the checkpoint descriptors as a reading obligation when the first call ignored cancellation and returned complete", async () => {
    const run = await cancelledFirstCall(() => done(planMarkdown("E3_2_2A_FIRST")));
    // 재생된 complete 는 읽기 의무 때문에 채택되지 않고 강등된다(E3-4a Q-A2) — 같은 재시도에서 호스트가 의무 참조를 처음부터 싣고 끝까지 읽은 뒤 채택한다.
    const before = run.model.delivered.length;
    run.engine.retry("topic"); await run.settle();
    expect(run.database.getTopic("topic").lastError ?? "").not.toContain("not fully read");
    expect(run.model.delivered.slice(before).some(entry => entry.selector === run.reference.selector && entry.offset === 0)).toBe(true);
    expect(run.database.planning.referenceComplete("claude-existing", run.database.getTopic("topic"), run.reference)).toBe(true);
    expect(await run.artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_FIRST");
    await run.engine.shutdown();
  });

  it("keeps the obligation when a replayed intermediate response is followed only by continuation packets", async () => {
    const run = await cancelledFirstCall(state => answer(step({ questions: [], requests: [
      { kind: "context", selector: [...(state.pending())].map(entry => entry.selector)[0], offset: 0, question: "Start" }] })));
    run.force(1);
    // 이어 싣는 쪽만 받은 뒤 낸 완료도 강등된다(E3-4a Q-A2) — 같은 재시도에서 남은 구간을 읽고 채택한다.
    run.engine.retry("topic"); await run.settle();
    expect(run.database.getTopic("topic").lastError ?? "").not.toContain("not fully read");
    expect(run.database.planning.referenceComplete("claude-existing", run.database.getTopic("topic"), run.reference)).toBe(true);
    expect(await run.artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_FIRST");
    await run.engine.shutdown();
  });

  it("continues reading in the same checkpoint after a user decision instead of adopting a paused plan with unread required references", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: korean(6_000) });
    const reference = timelineReference(decision);
    const plan = planMarkdown("E3_2_2A_PAUSED");
    let asked = false;
    const model = readingModel(plan, (_turn, _call, state) => {
      if (!asked && state.pending().length) {
        asked = true;
        return { ...answer(step({ questions: ["어느 쪽으로 진행할까요?"], requests: [] })), planMarkdown: plan, requestedUserDecision: "진행 방향을 정해 주세요" };
      }
      return undefined;
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    const paused = database.getTopic("topic");
    expect(paused.state).toBe("USER_DECISION_REQUIRED");
    const checkpoint = database.latestPlannerCheckpoint("topic", "claude")!;
    await engine.postMessage("topic", "decision", "E3_2_2A 원래 방향으로 계속 읽어 주세요");
    engine.retry("topic"); await settle();
    expect(database.getTopic("topic").planEpoch).toBe(paused.planEpoch);
    const resumed = database.latestPlannerCheckpoint("topic", "claude")!;
    expect(resumed.id).toBe(checkpoint.id);
    expect(resumed.round).toBeGreaterThan(checkpoint.round);
    expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_PAUSED");
    await engine.shutdown();
  });

  it("does not close a revision checkpoint that asked for a user decision while required references are unread", async () => {
    const { repo, database, git } = setup();
    database.updateTopic("topic", { state: "CLAUDE_REVISION" });
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_REVISION", body: korean(6_000) });
    const delivery = planTimelineDelivery([decision]);
    const reference = delivery.references[0];
    const fake = scripted(async (_turn, call) => call === 1
      ? { ...answer(step({ questions: ["확인"], requests: [] })), kind: "REVISION", planEdits: [], requestedUserDecision: "확인해 주세요" }
      : { kind: "REVISION", summary: "개정", findings: [], evidenceRefs: [], planEdits: [], planningStep: step({ questions: [], complete: true }) });
    const adapter = guardedPlanning(fake.adapter, database, git);
    const first = await adapter.resumeTurn({ cwd: repo, prompt: "Revise", sessionId: "claude-session", timelineDelivery: { prompt: delivery } });
    expect(first.requestedUserDecision).toBe("확인해 주세요");
    const open = database.planning.latest("topic")!;
    expect(open).toMatchObject({ finalized: false, awaitingDecision: true });
    // 결정을 청한 열린 체크포인트는 새 사용자 입력 전까지 저장된 질문을 그대로 돌려준다(host-review 39d21df9 F001 — 이연 읽기의 결정 체크포인트와 한 경로).
    expect(await adapter.resumeTurn({ cwd: repo, prompt: "Revise", sessionId: "claude-session", timelineDelivery: { prompt: delivery } })).toEqual(first);
    expect(fake.calls).toHaveLength(1);
    database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_REVISION", body: "확인했습니다" });
    // 다음 완료는 필수 참조를 끝까지 읽기 전이라 강등되고(E3-4a Q-A2), 같은 체크포인트에서 호스트가 남은 구간을 실어 읽힌 뒤에야 채택된다.
    const revised = await adapter.resumeTurn({ cwd: repo, prompt: "Revise", sessionId: "claude-session", timelineDelivery: { prompt: delivery } });
    expect(revised.kind).toBe("REVISION");
    expect(fake.calls.length).toBeGreaterThan(2);
    expect(database.planning.latest("topic")).toMatchObject({ id: open.id, finalized: true });
    expect(database.planning.referenceComplete("claude-session", database.getTopic("topic"), reference)).toBe(true);
  });

  // 회차 상한이 없어져(E3-4a) 수백 개 참조의 조사는 예산이 끊는다 — 실행 예산 1,000 토큰(호출당 100)이면 soft limit(80%) 뒤 한 번 정리하고, 필수 참조를 다 읽지
  // 못한 완료는 채택하지 않고 명시 정지한다. 패킷은 그동안 한도 안이다.
  it("keeps the packet within its limit when hundreds of required references are unread", async () => {
    const { database, git, artifacts, settle } = referenceTopic(1_000);
    for (let i = 0; i < 600; i += 1) database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT",
      body: `E3_2_2A_REQUIRED_${i} ${"x".repeat(16_400)}` });
    const model = readingModel(planMarkdown("E3_2_2A_MANY"));
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    expect(model.calls.length).toBeGreaterThan(2);
    expect(model.calls.every(call => Buffer.byteLength(call.prompt) < PLANNING_LIMITS.promptBytes)).toBe(true);
    expect(model.calls.at(-1)!.prompt).toContain("No more research is available");
    expect(database.getTopic("topic").lastError).toBe("Synthesis did not produce a complete plan; checkpoint retained.");
    expect(database.planning.latest("topic")).toMatchObject({ finalized: false, finalAttempted: true,
      demotedComplete: { requests: 0, unreadRequired: expect.any(Number) } });
    expect(await artifacts.readLatest("topic", "plan")).toBeNull();
    await engine.shutdown();
  }, 60_000);

  it("delivers every one of more than a hundred notes inline, by reference or through the index", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const notes = Array.from({ length: 120 }, (_, i) => database.appendEvent({ topicId: "topic", actor: "codex", kind: "note", state: "DRAFT",
      body: `E3_2_2A_MANY_NOTE_${String(i).padStart(3, "0")} ${"메모".repeat(40)}` }));
    const model = readingModel(planMarkdown("E3_2_2A_NOTES"), (_turn, _call, state) => {
      const index = [...state.selectors].find(selector => selector.startsWith("timeline-index@"));
      if (index && !assembled(state.received, index).complete) return undefined;
      return done(planMarkdown("E3_2_2A_NOTES"));
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    const first = model.calls[0].prompt;
    const index = [...model.selectors].find(selector => selector.startsWith("timeline-index@"));
    const listed = new Set(index ? assembled(model.received, index).text.split("\n").map(line => JSON.parse(line).selector) : []);
    const missing = notes.filter(note => !first.includes(note.body) && !first.includes(timelineReference(note).selector) &&
      !listed.has(timelineReference(note).selector)).map(note => note.sequence);
    expect(missing).toEqual([]);
    expect(await artifacts.readLatest("topic", "plan")).toContain("E3_2_2A_NOTES");
    await engine.shutdown();
  });

  it("keeps every note beyond the recent eighty in audit and in both closeout versions (delta and full)", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    database.upsertParticipant("topic", { role: "codex", sessionId: "pending:codex-e3", mode: "attached", acknowledgedPlanSHA256: null });
    const note = (label: string, i: number) => database.appendEvent({ topicId: "topic", actor: "codex", kind: "note", state: "DRAFT",
      body: `E3_2_2A_${label}_${String(i).padStart(3, "0")} ${"메모".repeat(40)}` }).sequence;
    const early = Array.from({ length: 120 }, (_, i) => note("EARLY", i));
    let late: number[] = [];
    const plan = `${planMarkdown("E3_2_2A_ALL")}\n\n${"계획 본문 ".repeat(600)}`;
    const stopAck = (turn: Omit<SessionTurn, "sessionId">) => { if (turn.protocolOnly) throw new Error("E3_2_2A_ACK_STOP"); };
    const claude = scripted(async turn => {
      stopAck(turn);
      if (turn.prompt.includes("Codex 감사에 답하고")) {
        late = Array.from({ length: 120 }, (_, i) => note("LATE", i));
        return { kind: "REVISION", summary: "개정", findings: [], evidenceRefs: [], planEdits: [], planningStep: step({ questions: [], complete: true }) };
      }
      return done(plan);
    });
    let closeoutSHA = "";
    const codex = scripted(async turn => {
      stopAck(turn);
      if (turn.prompt.includes("검토할 계획 SHA-256")) return { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [],
        planningStep: step({ questions: [], complete: true }) };
      closeoutSHA ||= /개정 계획 SHA-256: ([a-f0-9]{64})/.exec(turn.prompt)?.[1] ?? "";
      return { kind: "CLOSEOUT", summary: "종결", planSHA256: closeoutSHA, findings: [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
    }, "codex");
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(claude.adapter, database, git),
      codex: guardedPlanning(codex.adapter, database, git) });
    engine.startPlan("topic"); await settle();
    expect(database.latestArtifact("topic", "closeout")).not.toBeNull();
    const covered = (plan?: { inline: number[]; references: Array<{ seq: number }> }) =>
      new Set([...(plan?.inline ?? []), ...(plan?.references ?? []).map(reference => reference.seq)]);
    const audit = codex.calls.find(call => call.prompt.includes("검토할 계획 SHA-256"))!;
    const auditCovered = covered(audit.timelineDelivery?.prompt);
    expect(early.filter(seq => !auditCovered.has(seq))).toEqual([]);
    const closeout = codex.calls.find(call => call.prompt.includes("개정 계획 SHA-256"))!;
    expect(closeout.prompt).toContain("직전 전달 이후 추가된 결정과 증거");
    const delta = covered(closeout.timelineDelivery?.prompt);
    const full = covered(closeout.timelineDelivery?.fresh);
    expect(late).toHaveLength(120);
    expect(late.filter(seq => !delta.has(seq))).toEqual([]);
    expect([...early, ...late].filter(seq => !full.has(seq))).toEqual([]);
    await engine.shutdown();
  });

  it("does not adopt a paused revision with unread required references and continues reading in the same revision checkpoint", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    database.upsertParticipant("topic", { role: "codex", sessionId: "pending:codex-e3", mode: "attached", acknowledgedPlanSHA256: null });
    const plan = `${planMarkdown("E3_2_2A_REVISION")}\n\n${"계획 본문 ".repeat(600)}`;
    let engine!: WorkflowEngine;
    let decision = "";
    let asked = false;
    const stopAck = (turn: Omit<SessionTurn, "sessionId">) => { if (turn.protocolOnly) throw new Error("E3_2_2A_ACK_STOP"); };
    const revisionDone = (): AgentResult => ({ kind: "REVISION", summary: "개정", findings: [], evidenceRefs: [], planEdits: [],
      planningStep: step({ questions: [], complete: true }) });
    let stage = "";
    const claude = readingModel(plan, (turn, _call, state) => {
      stopAck(turn);
      if (turn.prompt.includes("Codex 감사에 답하고")) stage = "revision";
      if (stage !== "revision") return done(plan);
      if (!asked) {
        asked = true;
        return { ...answer(step({ questions: ["확인해 주세요"], requests: [] })), kind: "REVISION", planEdits: [], requestedUserDecision: "개정 방향을 확인해 주세요" };
      }
      return state.pending().length ? undefined : revisionDone();
    });
    let auditStage = "", closeoutSHA = "";
    const codex = readingModel(plan, async (turn, _call, state) => {
      stopAck(turn);
      if (turn.prompt.includes("검토할 계획 SHA-256")) auditStage = "audit";
      if (turn.prompt.includes("개정 계획 SHA-256")) auditStage = "closeout";
      if (auditStage === "audit" && !decision) {
        decision = korean(6_000);
        await engine.postMessage("topic", "decision", decision);
      }
      if (state.pending().length) return undefined;
      if (auditStage === "audit") return { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
      closeoutSHA ||= /개정 계획 SHA-256: ([a-f0-9]{64})/.exec(turn.prompt)?.[1] ?? "";
      return { kind: "CLOSEOUT", summary: "종결", planSHA256: closeoutSHA, findings: [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
    }, "codex");
    engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(claude.adapter, database, git),
      codex: guardedPlanning(codex.adapter, database, git) });
    engine.startPlan("topic"); await settle();
    for (let attempt = 0; attempt < 3 && database.getFlags("topic").resumeState !== "CLAUDE_REVISION"; attempt += 1) {
      engine.retry("topic"); await settle();
    }
    const paused = database.getTopic("topic");
    expect(paused.state).toBe("USER_DECISION_REQUIRED");
    expect(database.getFlags("topic").resumeState).toBe("CLAUDE_REVISION");
    const reference = timelineReference(eventOf(database, decision));
    const checkpoint = database.latestPlannerCheckpoint("topic", "claude")!;
    expect(checkpoint).toMatchObject({ stage: "CLAUDE_REVISION", finalized: false });
    expect(database.planning.referenceComplete("claude-existing", paused, reference)).toBe(false);
    await engine.postMessage("topic", "decision", "E3_2_2A 개정 방향 확인 — 계속 읽어 주세요");
    engine.retry("topic"); await settle();
    const resumed = database.latestPlannerCheckpoint("topic", "claude")!;
    expect(database.getTopic("topic").planEpoch).toBe(paused.planEpoch);
    expect(resumed.id).toBe(checkpoint.id);
    expect(resumed.round).toBeGreaterThan(checkpoint.round);
    expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    expect(database.latestArtifact("topic", "closeout")).not.toBeNull();
    await engine.shutdown();
  });

  // F005: 공개 래퍼의 세션 교체 → 실제 프롬프트 빌더 → 조각 읽기 → 반환 결과를 확인한다.
  it.each([16 * 1024, 32 * 1024])("uses only the sent full-context reading obligations after rotation (inline budget %i)", async inlineBytes => {
    const { repo, database, git } = setup("codex");
    const rows = [8_000, 10_000, 7_000].map((size, index) => database.appendEvent({ topicId: "topic", actor: "user",
      kind: "decision", state: "CODEX_AUDIT", body: String.fromCharCode(65 + index).repeat(size) }));
    const seed = scripted(async () => ({ kind: "AUDIT", summary: "seed", findings: [], evidenceRefs: [],
      planningStep: step({ questions: [], complete: true }) }), "codex");
    await guardedPlanning(seed.adapter, database, git).createSession({ cwd: repo, prompt: "Seed review history" });
    database.planning.save({ ...database.planning.latest("topic")!, id: "seed", key: "seed", sessionId: "reviewer-old",
      started: true, finalized: true, stage: "CODEX_CLOSEOUT" });
    const delta = planTimelineDelivery(rows.slice(1));
    const fresh = planTimelineDelivery(rows, { inlineBytes, referenceBytes: 6 * 1024 });
    const c = timelineReference(rows[2]);
    expect(delta.references.map(ref => ref.seq)).toEqual([rows[2].sequence]);
    expect(fresh.inline).toContain(rows[2].sequence);
    expect(fresh.references.map(ref => ref.seq)).toEqual(inlineBytes === 16 * 1024 ? [rows[1].sequence] : []);
    const model = readingModel(planMarkdown("F005_FULL"), (turn, call, state) => {
      // manifest는 조회 가능한 자료 목록이다. 실제 과제에 원문으로 실린 항목은 참조로 다시 읽지 않는다.
      for (const row of rows.filter(row => fresh.inline.includes(row.sequence))) state.selectors.delete(timelineReference(row).selector);
      if (call === 1) {
        expect(turn.prompt).toContain(rows[2].body);
        expect(turn.prompt).not.toContain("직전 전달 이후 추가된 결정과 증거:");
      }
      if (!state.pending().length) return { kind: "AUDIT", summary: "F005_FULL", findings: [], evidenceRefs: [],
        planningStep: step({ questions: [], complete: true }) };
      return undefined;
    }, "codex");
    const input = { title: "Actual task version", planMarkdown: planMarkdown("F005"), planSHA256: "a".repeat(64), scopeGeneration: 1 };
    // 세션 교체는 E3-3a 부터 관측된 세션 유실의 명시적 복구로만 일어난다 — 옛 검토 세션이 유실돼 새 세션에 전체 판이 간다.
    const lostOld: AgentAdapter = { ...model.adapter, resumeTurn: async turn => {
      if (turn.sessionId === "reviewer-old") throw codexSessionMissing(turn.sessionId);
      return model.adapter.resumeTurn(turn);
    } };
    const result = await guardedPlanning(lostOld, database, git).resumeTurn({ cwd: repo, sessionId: "reviewer-old",
      prompt: buildCodexAuditPrompt({ ...input, timeline: rows.slice(1), planningContextMode: "delta", timelineDelivery: delta }),
      freshSessionPrompt: buildCodexAuditPrompt({ ...input, timeline: rows, timelineDelivery: fresh }),
      timelineDelivery: { prompt: delta, fresh } });
    expect(result.summary).toBe("F005_FULL");
    const record = database.planning.latest("topic")!;
    expect(record.sessionId).not.toBe("reviewer-old");
    expect(record.finalized).toBe(true);
    expect(model.delivered.some(part => part.selector === c.selector)).toBe(false);
    expect(database.planning.referenceComplete(record.sessionId!, database.getTopic("topic"), c)).toBe(false);
    expect(database.planning.unreadSessionReferences(record.sessionId!, database.getTopic("topic"))).toEqual([]);
    for (const ref of fresh.references) expect(assembled(model.received, ref.selector))
      .toMatchObject({ complete: true, text: timelineEventText(rows.find(row => row.sequence === ref.seq)!) });
  });

  it("preserves an acknowledged tail while filling an earlier gap without duplicate delivery", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const row = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: "x".repeat(18_000) });
    const reference = timelineReference(row);
    const model = readingModel(planMarkdown("F006_TAIL"), (_turn, call) => call === 1
      ? answer(step({ requests: [{ kind: "context", selector: reference.selector, offset: 13_384, question: "Read the tail first" }] }))
      : undefined);
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    expect(database.getTopic("topic").lastError).toBe("E3_2_2A_AUDIT_STOP");
    expect(assembled(model.received, reference.selector)).toMatchObject({ complete: true, text: timelineEventText(row) });
    expect(model.delivered.filter(part => part.selector === reference.selector).map(part => part.offset)).toEqual([13_384, 0, 6_692]);
    expect(model.calls.every(turn => !turn.prompt.includes("Required timeline references not yet fully read"))).toBe(true);
    expect(await artifacts.readLatest("topic", "plan")).toContain("F006_TAIL");
    await engine.shutdown();
  });

  it("rereads only the cancelled range while preserving an acknowledged tail beyond the same gap", async () => {
    const { database, git, artifacts, settle } = referenceTopic();
    const row = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "DRAFT", body: "x".repeat(18_000) });
    const reference = timelineReference(row);
    let entered!: () => void, release!: () => void;
    const pending = new Promise<void>(resolve => { entered = resolve; });
    const model = readingModel(planMarkdown("F006_MIXED"), async (turn, call, state) => {
      if (call === 1) return answer(step({ requests: [{ kind: "context", selector: reference.selector, offset: 13_384, question: "Read the tail first" }] }));
      if (call === 4) {
        const status = turn.prompt.split("\n").find(line => line.startsWith("Required timeline references not yet fully read"))!;
        expect(JSON.parse(status.slice(status.indexOf("again: ") + 7))).toEqual([{ selector: reference.selector, offset: 0 }]);
      }
      if (call !== 3) return undefined;
      entered();
      await new Promise<void>(resolve => { release = resolve; });
      return answer(step({ requests: state.pending().map(entry => ({ kind: "context" as const, selector: entry.selector,
        offset: entry.next, question: "Fill the middle gap" })) }));
    });
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(model.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await pending;
    engine.stop("topic"); release(); await settle();
    const stopped = database.getTopic("topic");
    expect(database.planning.referenceReadAcknowledged("claude-existing", stopped, reference.selector, reference.hash, 13_384)).toBe(true);
    expect(database.planning.referenceReadAcknowledged("claude-existing", stopped, reference.selector, reference.hash, 0)).toBe(false);
    engine.retry("topic"); await settle();
    expect(database.getTopic("topic").lastError).toBe("E3_2_2A_AUDIT_STOP");
    expect(assembled(model.received, reference.selector)).toMatchObject({ complete: true, text: timelineEventText(row) });
    expect(model.delivered.filter(part => part.selector === reference.selector).map(part => part.offset)).toEqual([13_384, 0, 6_692, 0]);
    expect(database.planning.referenceComplete("claude-existing", database.getTopic("topic"), reference)).toBe(true);
    expect(await artifacts.readLatest("topic", "plan")).toContain("F006_MIXED");
    await engine.shutdown();
  });

  it("keeps the required references of a full-context version it actually sent as a reading obligation", async () => {
    // 검토자 세션이 유실돼(E3-3a 명시적 복구) 감사가 새 세션으로 돌면 전체 판을 보낸다. 그 호출이 취소를 무시하고 늦게 complete 를 돌려주면 전달 인정이
    // 없다 — 재생된 complete 는 보낸 전체 판의 필수 참조를 읽기 의무로 삼아 채택하지 않는다. E3-4a Q-A2 부터는 거절 대신 강등하고 같은 시도에서 그 참조를
    // 끝까지 읽힌 뒤에 채택한다.
    const { repo, database, git } = setup("codex");
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CODEX_AUDIT", body: korean(6_000) });
    const seedModel = scripted(async () => ({ kind: "AUDIT", summary: "seed", findings: [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) }), "codex");
    await guardedPlanning(seedModel.adapter, database, git).createSession({ cwd: repo, prompt: "Seed the reviewer session" });
    const seeded = database.planning.latest("topic")!;
    database.planning.save({ ...seeded, id: "seed", key: "seed", sessionId: "reviewer-old", started: true,
      finalized: true, stage: "CODEX_CLOSEOUT" });
    const fresh = planTimelineDelivery([decision]);
    const controller = new AbortController();
    const model = scripted(async (turn, call) => {
      if (call === 1) {
        expect(turn.prompt).toContain("Full context version");
        controller.abort(new Error("cancelled"));
      }
      return { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
    }, "codex");
    const adapter = guardedPlanning({ ...model.adapter, resumeTurn: async turn => {
      if (turn.sessionId === "reviewer-old") throw codexSessionMissing(turn.sessionId);
      return model.adapter.resumeTurn(turn);
    } }, database, git);
    const turn = { cwd: repo, prompt: "Delta version", freshSessionPrompt: "Full context version", sessionId: "reviewer-old",
      timelineDelivery: { prompt: planTimelineDelivery([]), fresh } };
    await expect(adapter.resumeTurn({ ...turn, signal: controller.signal })).rejects.toThrow();
    expect(model.calls).toHaveLength(1);
    const audited = await adapter.resumeTurn({ ...turn, signal: new AbortController().signal });
    expect(audited.kind).toBe("AUDIT");
    expect(model.calls.length).toBeGreaterThan(1);
    expect(model.calls[1].prompt).toContain('"complete":false');
    const [reference] = fresh.references;
    const reviewer = database.planning.latest("topic")!;
    expect(reviewer).toMatchObject({ finalized: true, sessionId: "session-1" });
    expect(database.planning.referenceComplete("session-1", database.getTopic("topic"), reference)).toBe(true);
  });
});

// ---- E3-3a 같은 route 자동 복구와 복구 계보(검토자 좌석) ----
// 공개 경계: guardedPlanning(adapter) — 엔진 core.turn 이 부르는 어댑터. 관측된 실패 형태(resultParser.classifyRunFailure)를 어댑터 호출 자리에 끼운다.
// 끼운 시도는 프로세스가 뜨고 사용량을 보고한 뒤 실패한다(실제 CLI 실패와 같은 순서). 모델 대역(scripted)은 실패한 시도를 보지 않는다.
describe("E3-3a 같은 route 자동 복구와 복구 계보", () => {
  const READ = { kind: "file" as const, selector: "form.swift", question: "Check navigation", offset: 0 };
  const NEW_RANGE = { kind: "file" as const, selector: "form.swift", question: "Check the later section", offset: 13_384 };
  const ROOM = "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.";
  const contextExceeded = () => agentRunError("codex", 1, "", JSON.stringify({ type: "turn.failed", error: { message: ROOM } }));
  const unknownFailure = () => agentRunError("codex", 2, "fatal: unexpected failure\n", "");
  const settings = { model: "gpt-5.6-sol", effort: "max" } as const;
  type Attempt = { method: "create" | "resume"; sessionId?: string; settings: unknown; binding: unknown };
  function lossy(fake: ReturnType<typeof scripted>, failures: Record<number, (turn: Omit<SessionTurn, "sessionId"> & { sessionId?: string }) => Error>) {
    const attempts: Attempt[] = [];
    const attempt = (method: Attempt["method"], turn: Omit<SessionTurn, "sessionId"> & { sessionId?: string }) => {
      attempts.push({ method, sessionId: turn.sessionId, settings: turn.settings, binding: turn.binding });
      const fail = failures[attempts.length];
      if (!fail) return;
      turn.onProcessSpawn?.({ pid: 7, pgid: 7, executable: "fake", commandLine: "fake", startedAt: "now" });
      turn.onUsage?.({ inputTokens: 10, cachedInputTokens: 0, outputTokens: 0, durationMs: 5, recordKind: "final", completeness: "complete" });
      throw fail(turn);
    };
    const adapter: AgentAdapter = { ...fake.adapter,
      createSession: async turn => { attempt("create", turn); return fake.adapter.createSession(turn); },
      resumeTurn: async turn => { attempt("resume", turn); return fake.adapter.resumeTurn(turn); } };
    return { adapter, attempts };
  }
  const lineageOf = (database: ConsensusDatabase) =>
    database.planning.recoveryLineage("topic", "reviewer", database.planning.recoveryAnchor("topic", ["audit", "closeout"]));
  const missing = (turn: { sessionId?: string }) => codexSessionMissing(turn.sessionId ?? "none");

  it.each([
    { label: "세션 유실", failure: missing, reason: "session-missing" },
    { label: "문맥 초과", failure: contextExceeded, reason: "context-exceeded" },
  ])("$label: 같은 route(설정·바인딩 그대로)로 새 세션을 한 번 만들고, 과제·체크포인트를 보존한 채 조각을 처음부터 다시 받아 끝낸다", async ({ failure, reason }) => {
    const { root, repo, database, git } = setup("codex");
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ draft: "Audit draft kept across recovery", requests: [READ] }));
      expect(turn.prompt).toContain("Audit the plan");
      expect(turn.prompt).toContain("Audit draft kept across recovery");
      expect(turn.prompt).toContain("let step = 0");
      expect(turn.planningControl?.instructionsInSession).toBe(false);
      return answer(step({ questions: [], complete: true }));
    }, "codex");
    const { adapter, attempts } = lossy(fake, { 2: failure });
    const result = await guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(result.sessionId).toBe("session-2");
    expect(attempts.map(({ method, sessionId }) => [method, sessionId ?? null])).toEqual([["create", null], ["resume", "session-1"], ["create", null]]);
    // 같은 route — 모델·강도·바인딩을 바꾸지 않는다.
    expect(attempts[2].settings).toEqual(attempts[1].settings);
    expect(attempts[2].binding).toEqual(attempts[1].binding);
    const record = database.planning.latest("topic")!;
    expect(record).toMatchObject({ sessionId: "session-2", finalized: true });
    expect(record.sessions).toEqual(expect.arrayContaining(["session-1", "session-2"]));
    // 옛 세션의 읽음 표시는 상속하지 않는다 — 조각을 새 세션이 다시 받았다.
    expect(database.planning.deliveredToSession("session-2").some(fragment => fragment.selector === "form.swift")).toBe(true);
    const lineage = lineageOf(database);
    expect(lineage.recoveries).toHaveLength(1);
    expect(lineage.recoveries[0]).toMatchObject({ reason, fromSession: "session-1", toSession: "session-2", compaction: "unsupported",
      contract: { stage: "CODEX_AUDIT", scopeGeneration: 1, planEpoch: database.getTopic("topic").planEpoch } });
    expect(lineage.blocked ?? null).toBeNull();
    // F004(host-review 008064c): 세션별 대화 측정값을 나눈다 — 옛 세션의 바이트는 옛 세션에, 새 세션은 자기 호출만. 시도 합(회차·주입 바이트)은 그대로다.
    // F005: 복구 기록에 공급자·코드·가린 원형 출력이 남아 DB 를 다시 열어도 분류를 다시 대조할 수 있다.
    for (const db of [database, (() => { const reopened = new ConsensusDatabase(join(root, "room.db")); cleanups.push(() => reopened.close()); return reopened; })()]) {
      const saved = db.planning.latest("topic")!;
      const old = saved.sessionMeasurements!.find(measured => measured.sessionId === "session-1")!;
      expect(old).toMatchObject({ started: true });
      expect(old.injectedBytes).toBeGreaterThan(0);
      expect(db.planning.sessionContext("session-1")).toEqual({ known: true, bytes: old.injectedBytes + old.responseBytes });
      expect(db.planning.sessionContext("session-2")).toEqual({ known: true, bytes: saved.injectedBytes + (saved.responseBytes ?? 0) });
      expect(saved.round).toBe(1);
      expect(saved.context).toBeUndefined();
      expect(db.planning.progress("topic")).toMatchObject({ round: 3, injectedBytes: old.injectedBytes + saved.injectedBytes });
      const error = lineageOf(db).recoveries[0].error;
      expect(error).toMatchObject({ provider: "codex", code: reason, raw: { exitCode: 1 } });
      expect(classifyRunFailure(error.provider, error.raw!.stderr, error.raw!.stdout)).toBe(reason);
    }
  });

  it.each([false, true])("반례 B: 새 세션이 옛 세션이 받은 같은 구간을 다시 받고 문구만 바꾼 뒤 다시 실패하면 자동 복구하지 않는다 — 새 구간을 읽었으면 한 번 더 받는다(새 구간: %s)", async newRange => {
    const { repo, database, git } = setup("codex");
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ questions: ["q"], requests: [READ] }));
      if (n === 2) {
        const id = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)[0].id as string;
        return answer(step({ draft: "first wording", facts: [{ statement: "Step is stored", refs: [id] }], questions: ["q"] }));
      }
      if (n === 3) return answer(step({ draft: "re-reading", questions: ["q"], requests: [newRange ? NEW_RANGE : READ] }));
      if (n === 4) {
        const id = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)[0].id as string;
        return answer(step({ draft: "second wording with a different digest",
          facts: [{ statement: "Step is stored (reworded)", refs: [id] }, { statement: "Same evidence again", refs: [id] }], questions: ["q"] }));
      }
      return answer(step({ questions: [], complete: true }));
    }, "codex");
    const { adapter, attempts } = lossy(fake, { 3: missing, 6: missing });
    const run = guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings });
    if (!newRange) {
      await expect(run).rejects.toThrow("again without new evidence");
      expect(attempts).toHaveLength(6);
      const lineage = lineageOf(database);
      expect(lineage.recoveries).toHaveLength(1);
      // 세션별 영수증은 늘었지만(새 세션이 같은 조각을 다시 받음) 계보 합집합은 기준선 그대로다.
      expect(database.planning.deliveredToSession("session-3").some(fragment => fragment.offset === 0)).toBe(true);
      expect(lineage.blocked).toMatchObject({ reason: "session-missing", error: { provider: "codex", code: "session-missing" } });
      expect(classifyRunFailure("codex", lineage.blocked!.error.raw!.stderr, lineage.blocked!.error.raw!.stdout)).toBe("session-missing");
      expect(lineage.blocked!.current).toEqual(lineage.blocked!.baseline);
      expect(database.planning.latest("topic")!.finalized).toBe(false);
    } else {
      const result = await run;
      expect(result.result.planMarkdown).toBe("Final navigation plan");
      const lineage = lineageOf(database);
      expect(lineage.recoveries).toHaveLength(2);
      expect(Object.values(lineage.recoveries[1].baseline).reduce((a, b) => a + b, 0))
        .toBeGreaterThan(Object.values(lineage.recoveries[0].baseline).reduce((a, b) => a + b, 0));
    }
  });

  it("반례 A: 자동 1회 뒤 사유가 바뀌거나 계획이 수정돼(새 체크포인트) 다시 실패해도 같은 계보라 자동 복구하지 않고, 엔진 채택 뒤 다음 과제는 새 계보로 1회를 받는다", async () => {
    const { repo, database, git } = setup("codex");
    const fake = scripted(async (_turn, n) => n === 1 ? answer(step({ requests: [READ] })) : answer(step({ questions: [], complete: true })), "codex");
    const { adapter, attempts } = lossy(fake, { 2: missing, 3: contextExceeded, 4: missing, 5: missing });
    const wrapped = guardedPlanning(adapter, database, git);
    // 1회 자동 복구 뒤 새 세션 생성 시도가 다른 사유로 실패 — 사유 변경은 초기화가 아니다.
    await expect(wrapped.createSession({ cwd: repo, prompt: "Audit the plan", settings })).rejects.toThrow("again without new evidence");
    expect(lineageOf(database).recoveries).toHaveLength(1);
    // 중재자 계획 수정 — 계획 SHA·epoch 가 바뀌어 새 체크포인트가 생긴다. 같은 계보이므로 자동 복구가 없다.
    const epoch = database.getTopic("topic").planEpoch;
    database.updateTopic("topic", { planEpoch: epoch + 1, planSHA256: "c".repeat(64) });
    await expect(wrapped.resumeTurn({ cwd: repo, prompt: "Audit the edited plan", sessionId: "session-1", settings }))
      .rejects.toThrow("again without new evidence");
    let lineage = lineageOf(database);
    expect(lineage.recoveries).toHaveLength(1);
    expect(lineage.recoveries[0].contract).toMatchObject({ planEpoch: epoch });
    expect(lineage.blocked!.contract).toMatchObject({ planEpoch: epoch + 1, planSHA256: "c".repeat(64) });
    expect(database.planning.latest("topic")!.planEpoch).toBe(epoch + 1);
    expect(attempts).toHaveLength(4);
    // 엔진이 검토 결과를 채택(감사 산출물) — 새 계보가 열려 다음 과제(종결 확인)의 실패는 자동 복구 1회를 받는다.
    database.addArtifact("topic", { kind: "audit", revision: 1, scopeGeneration: 1, sha256: "d".repeat(64), path: join(repo, "audit.json"),
      createdAt: new Date().toISOString() });
    database.updateTopic("topic", { state: "CODEX_CLOSEOUT" });
    const closeout = await wrapped.resumeTurn({ cwd: repo, prompt: "Close out the audited plan", sessionId: "session-1", settings });
    expect(closeout.planMarkdown).toBe("Final navigation plan");
    lineage = lineageOf(database);
    expect(lineage.anchor).toMatchObject({ kind: "audit", revision: 1 });
    expect(lineage.recoveries).toHaveLength(1);
    expect(lineage.previous!.recoveries).toHaveLength(1);
  });

  it("DB 를 다시 열고 재시도해도 계보의 자동 복구 횟수는 유지된다", async () => {
    const { root, repo, database, git } = setup("codex");
    const fake = scripted(async (_turn, n) => answer(step({ draft: `round ${n}`, questions: [] })), "codex");
    const { adapter, attempts } = lossy(fake, { 2: missing, 4: unknownFailure, 5: missing });
    await expect(guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings }))
      .rejects.toThrow("fatal: unexpected failure");
    expect(lineageOf(database).recoveries).toHaveLength(1);
    const reopened = new ConsensusDatabase(join(root, "room.db"));
    cleanups.push(() => reopened.close());
    await expect(guardedPlanning(adapter, reopened, git).resumeTurn({ cwd: repo, prompt: "Audit the plan", sessionId: "session-2", settings }))
      .rejects.toThrow("again without new evidence");
    expect(attempts).toHaveLength(5);
    expect(lineageOf(reopened).recoveries).toHaveLength(1);
    expect(lineageOf(reopened).blocked).toMatchObject({ reason: "session-missing" });
  });

  it("관측되지 않은 실패(unknown)는 복구하지 않고 원형을 보존한 채 그대로 멈춘다", async () => {
    const { repo, database, git } = setup("codex");
    const fake = scripted(async () => answer(step({ requests: [READ] })), "codex");
    const { adapter, attempts } = lossy(fake, { 2: unknownFailure });
    const error = await guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AgentRunError);
    expect(error).toMatchObject({ code: "unknown" });
    expect((error as AgentRunError).raw.stderr).toContain("fatal: unexpected failure");
    expect(attempts).toHaveLength(2);
    expect(lineageOf(database).recoveries).toEqual([]);
    // 관측 문구를 담았지만 관측 형태가 아닌 실패(result 이벤트 없는 Claude 문구)도 unknown 이다 — 래퍼는 문구가 아니라 code 로만 가른다.
    const phraseOnly = lossy(scripted(async () => answer(step({ requests: [READ] })), "codex"),
      { 2: () => agentRunError("claude", 1, "No conversation found with session ID: session-1\n", "") });
    const second = setup("codex");
    const phraseError = await guardedPlanning(phraseOnly.adapter, second.database, second.git)
      .createSession({ cwd: second.repo, prompt: "Audit the plan", settings }).catch((failure: unknown) => failure);
    expect(phraseError).toMatchObject({ code: "unknown" });
    expect(phraseOnly.attempts).toHaveLength(2);
  });

  it("기준선 뒤에 사용자 결정이 들어와 재키돼도 새 근거 구간이 없으면 자동 복구 횟수를 다시 주지 않는다", async () => {
    const { repo, database, git } = setup("codex");
    const fake = scripted(async (_turn, n) => answer(step({ draft: `round ${n}`, questions: [] })), "codex");
    const { adapter, attempts } = lossy(fake, { 2: missing, 4: unknownFailure, 5: missing });
    const wrapped = guardedPlanning(adapter, database, git);
    await expect(wrapped.createSession({ cwd: repo, prompt: "Audit the plan", settings })).rejects.toThrow("fatal: unexpected failure");
    expect(lineageOf(database).recoveries).toHaveLength(1);
    database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CODEX_AUDIT", body: "검토 범위를 확정한다." });
    await expect(wrapped.resumeTurn({ cwd: repo, prompt: "Audit the plan", sessionId: "session-2", settings }))
      .rejects.toThrow("again without new evidence");
    expect(attempts).toHaveLength(5);
    expect(lineageOf(database).recoveries).toHaveLength(1);
  });

  it("계보 진척 합집합은 범위 세대만 다른 같은 원문·해시·구간을 새 근거로 세지 않는다(세션별 영수증의 범위 검증은 그대로)", () => {
    const { database } = setup("codex");
    const reference = { selector: `timeline:9@${"e".repeat(64)}`, hash: "e".repeat(64), offset: 0, end: 4_000, total: 8_000 };
    database.planning.acknowledgeReferencePages("session-a", { id: "topic", scopeGeneration: 1 }, [reference]);
    database.planning.acknowledgeReferencePages("session-b", { id: "topic", scopeGeneration: 2 }, [reference]);
    const one = database.planning.lineageProgress("topic", ["session-a"]);
    expect(Object.values(one)).toEqual([4_000]);
    expect(database.planning.lineageProgress("topic", ["session-a", "session-b"])).toEqual(one);
    // 영수증은 범위 세대마다 따로다 — 세대 2 세션의 완독 판정은 세대 1 기록을 쓰지 않는다.
    expect(database.planning.referenceGaps("session-b", { id: "topic", scopeGeneration: 1 },
      { selector: reference.selector, hash: reference.hash, bytes: 8_000, unit: "utf8", version: 1 })).toEqual([{ offset: 0, end: 8_000 }]);
    // 새 구간은 늘어난다.
    database.planning.acknowledgeReferencePages("session-b", { id: "topic", scopeGeneration: 2 }, [{ ...reference, offset: 4_000, end: 8_000 }]);
    expect(Object.values(database.planning.lineageProgress("topic", ["session-a", "session-b"]))).toEqual([8_000]);
  });

  it("예상 밖 세션 신원 변경 응답은 채택하지 않고 복구 상태에 남긴 채 멈춘다(자동 복구 사유가 아니다)", async () => {
    const { repo, database, git } = setup("codex");
    const fake = scripted(async () => answer(step({ requests: [READ] })), "codex");
    let call = 0;
    const adapter: AgentAdapter = { ...fake.adapter, resumeTurn: async turn => {
      call++;
      turn.onSessionCreated?.("session-other");
      return fake.adapter.resumeTurn(turn);
    } };
    await expect(guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings }))
      .rejects.toThrow("changed the planning session identity");
    expect(call).toBe(1);
    expect(fake.calls).toHaveLength(1);
    const record = database.planning.latest("topic")!;
    expect(record).toMatchObject({ sessionId: "session-1", finalized: false });
    const lineage = lineageOf(database);
    expect(lineage.recoveries).toEqual([]);
    expect(lineage.blocked).toMatchObject({ reason: "identity-mismatch", sessions: { requested: "session-1", returned: "session-other" } });
  });

  // ---- host-review 008064c 보완(F001~F005) ----
  // 실패 시도의 사용량을 실제 어댑터와 같은 계측(ExecutionMetrics)으로 만든다 — 실패 원형의 이벤트만 관측하므로 turn.failed 에는 토큰 사용량이 없다.
  function metered(fake: ReturnType<typeof scripted>, failures: Record<number, () => AgentRunError>) {
    const attempts: string[] = [];
    const attempt = (method: string, turn: Omit<SessionTurn, "sessionId">) => {
      attempts.push(method);
      const fail = failures[attempts.length];
      if (!fail) return;
      const error = fail();
      turn.onProcessSpawn?.({ pid: 7, pgid: 7, executable: "fake", commandLine: "fake", startedAt: "now" });
      const metrics = new ExecutionMetrics("codex", 64, settings.model, settings.effort, method === "resume", Date.now());
      for (const line of error.raw.stdout.split("\n").filter(Boolean)) metrics.observe(JSON.parse(line));
      turn.onUsage?.(metrics.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final"));
      throw error;
    };
    const adapter: AgentAdapter = { ...fake.adapter,
      createSession: async turn => { attempt("create", turn); return fake.adapter.createSession(turn); },
      resumeTurn: async turn => { attempt("resume", turn); return fake.adapter.resumeTurn(turn); } };
    return { adapter, attempts };
  }

  it("F001: 사용량이 빠진 문맥 초과(실제 계측 형태)면 복구 호출을 사지 않고 멈추고, 모델 턴이 없는 세션 유실은 같은 계측에서도 복구한다", async () => {
    const room = setup("codex");
    const exceeded = metered(scripted(async () => answer(step({ requests: [READ] })), "codex"), { 2: contextExceeded });
    await expect(guardedPlanning(exceeded.adapter, room.database, room.git).createSession({ cwd: room.repo, prompt: "Audit the plan", settings }))
      .rejects.toThrow("Usage is incomplete after the provider reported context-exceeded");
    expect(exceeded.attempts).toEqual(["create", "resume"]);
    expect(room.database.planning.latest("topic")).toMatchObject({ usageIncomplete: true, sessionId: "session-1" });
    expect(lineageOf(room.database).recoveries).toEqual([]);

    const lost = setup("codex");
    const missingRun = metered(scripted(async (_turn, n) => n === 1 ? answer(step({ requests: [READ] })) : answer(step({ questions: [], complete: true })), "codex"),
      { 2: () => codexSessionMissing("session-1") });
    const result = await guardedPlanning(missingRun.adapter, lost.database, lost.git).createSession({ cwd: lost.repo, prompt: "Audit the plan", settings });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(missingRun.attempts).toEqual(["create", "resume", "create"]);
    expect(lost.database.planning.latest("topic")!.usageIncomplete).toBeFalsy();
    expect(lineageOf(lost.database).recoveries).toHaveLength(1);
  });

  it("F002: 옛 세션의 인정된 타임라인 구간을 새 세션이 조각으로 다시 받은 것은 새 근거가 아니다 — 다시 실패하면 자동 복구하지 않는다", async () => {
    const { repo, database, git } = setup("codex");
    const decision = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CODEX_AUDIT", body: "가".repeat(6_000) });
    const fresh = planTimelineDelivery([decision]);
    const reference = fresh.references[0];
    expect(reference?.seq).toBe(decision.sequence);
    // 옛 검토 세션 A 는 호스트가 실은 쪽으로 이 참조를 끝까지 인정받았다(2b 전달 인정만 있고 조각 기록은 없다).
    database.planning.acknowledgeReferencePages("reviewer-old", database.getTopic("topic"),
      [{ selector: reference.selector, hash: reference.hash, offset: 0, end: reference.bytes, total: reference.bytes }]);
    const fake = scripted(async (_turn, n) => n === 1
      ? answer(step({ questions: ["q"], requests: [{ kind: "context", selector: reference.selector, offset: 0, question: "Re-read the decision" }] }))
      : answer(step({ questions: ["q"] })), "codex");
    const { adapter, attempts } = lossy(fake, { 1: missing, 4: missing });
    await expect(guardedPlanning(adapter, database, git).resumeTurn({ cwd: repo, prompt: "Delta version", freshSessionPrompt: "Full context version",
      sessionId: "reviewer-old", settings, timelineDelivery: { prompt: planTimelineDelivery([]), fresh } })).rejects.toThrow("again without new evidence");
    expect(attempts.map(({ method, sessionId }) => [method, sessionId ?? null]))
      .toEqual([["resume", "reviewer-old"], ["create", null], ["resume", "session-1"], ["resume", "session-1"]]);
    // 새 세션 B 는 같은 원문을 조각으로 받아 두 기록(조각 전달·참조 인정)을 남겼지만, 계보 합집합은 기준선 그대로다.
    expect(database.planning.deliveredToSession("session-1").some(fragment => fragment.selector === reference.selector)).toBe(true);
    expect(database.planning.referenceReadAcknowledged("session-1", database.getTopic("topic"), reference.selector, reference.hash, 0)).toBe(true);
    const lineage = lineageOf(database);
    expect(lineage.recoveries).toHaveLength(1);
    expect(lineage.blocked).toMatchObject({ reason: "session-missing" });
    expect(lineage.blocked!.current).toEqual(lineage.blocked!.baseline);
  });

  it.each([
    { label: "단계 채택 거절", reject: "cites" },
    { label: "현재성 검사 거절", reject: "current" },
  ])("F002: $label 된 호출의 새 조각은 진척이 아니다 — 그 뒤 다시 실패하면 자동 복구하지 않는다", async ({ reject }) => {
    const { repo, database, git } = setup("codex");
    const fragmentId = (turn: Omit<SessionTurn, "sessionId">) => JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)[0].id as string;
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ questions: ["q"], requests: [READ] }));
      if (n === 2) return answer(step({ facts: [{ statement: "Step is stored", refs: [fragmentId(turn)] }], questions: ["q"] }));
      if (n === 3) return answer(step({ questions: ["q"], requests: [NEW_RANGE] }));
      // 새 구간을 받은 호출 — 인용 계약 위반(받지 않은 근거 인용)으로 거절되거나, 호출 도중 계획이 바뀌어 현재성 검사에서 거절된다.
      if (reject === "current") {
        database.updateTopic("topic", { planSHA256: "f".repeat(64) });
        return answer(step({ facts: [{ statement: "Later section read", refs: [fragmentId(turn)] }], questions: ["q"] }));
      }
      return answer(step({ facts: [{ statement: "Unsupported", refs: ["never-delivered"] }], questions: [], complete: true }));
    }, "codex");
    const { adapter, attempts } = lossy(fake, { 3: missing, 6: missing });
    const wrapped = guardedPlanning(adapter, database, git);
    await expect(wrapped.createSession({ cwd: repo, prompt: "Audit the plan", settings }))
      .rejects.toThrow(reject === "current" ? "Planning binding changed" : "Checkpoint cites evidence that was not delivered");
    // 새 세션(가짜 모델의 세 번째 호출이 만든 session-3)은 새 구간을 받아 전달 기록에 남겼지만 그 호출은 채택되지 않았다.
    expect(database.planning.deliveredToSession("session-3").some(fragment => fragment.offset === NEW_RANGE.offset)).toBe(true);
    await expect(wrapped.resumeTurn({ cwd: repo, prompt: "Audit the plan", sessionId: "session-3", settings })).rejects.toThrow("again without new evidence");
    expect(attempts).toHaveLength(6);
    const lineage = lineageOf(database);
    expect(lineage.recoveries).toHaveLength(1);
    expect(lineage.blocked!.current).toEqual(lineage.blocked!.baseline);
  });

  it("F003: 실제 Codex 어댑터가 재개 스트림의 다른 thread 로 거부한 응답도 요청·반환 id 와 함께 복구 상태에 남긴다(자동 복구 사유가 아니다)", async () => {
    const { root, repo, database, git } = setup("codex");
    class ForeignThreadRunner implements CommandRunner {
      readonly calls: CommandSpec[] = [];
      async run(spec: CommandSpec): Promise<CommandResult> {
        this.calls.push(spec);
        const line = { type: "thread.started", thread_id: "thread-other" };
        spec.onJSONLine?.(line, Date.now());
        return { exitCode: 0, stdout: `${JSON.stringify(line)}\n`, stderr: "", jsonLines: [line] };
      }
    }
    const runner = new ForeignThreadRunner();
    const codex = new CodexAdapter(runner, join(root, "agent-result.schema.json"), join(root, "codex-home"));
    const error = await guardedPlanning(codex, database, git).resumeTurn({ cwd: repo, prompt: "Audit the plan", sessionId: "session-1" })
      .catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(SessionIdentityMismatch);
    expect((error as Error).message).toContain("요청한 세션(session-1)과 다릅니다");
    expect(runner.calls).toHaveLength(1);
    const lineage = lineageOf(database);
    expect(lineage.recoveries).toEqual([]);
    expect(lineage.blocked).toMatchObject({ reason: "identity-mismatch", sessions: { requested: "session-1", returned: "thread-other" },
      error: { provider: "codex", code: "identity-mismatch" } });
    expect(database.planning.latest("topic")!.sessionId).toBe("session-1");
  });

  it("F005: 복구·차단 기록의 원형 출력은 어댑터가 가리고 자른 값이다 — 비밀을 되살리거나 원문 전체를 남기지 않는다", async () => {
    const { repo, database, git } = setup("codex");
    const noisy = () => agentRunError("codex", 1,
      `${"noise line\n".repeat(2_000)}OPENAI_API_KEY=sk-proj-abcdefghijklmnop\nError: thread/resume: thread/resume failed: no rollout found for thread id session-1 (code -32600)\n`, "");
    const fake = scripted(async (_turn, n) => n === 1 ? answer(step({ requests: [READ] })) : answer(step({ questions: [], complete: true })), "codex");
    const { adapter } = lossy(fake, { 2: noisy });
    await guardedPlanning(adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings });
    const error = lineageOf(database).recoveries[0].error;
    expect(error.code).toBe("session-missing");
    expect(error.raw!.stderr.length).toBeLessThanOrEqual(4_001);
    expect(error.raw!.stderr).not.toContain("sk-proj-abcdefghijklmnop");
    expect(classifyRunFailure("codex", error.raw!.stderr, error.raw!.stdout)).toBe("session-missing");
  });

  // 공개 경계: 기존 형식 DB를 연 guardedPlanning의 복구 호출. 실제 소비자는 추가 유료 호출 허가이고, SQL은 옛 스키마 fixture만 만든다.
  // 거절 응답은 위 F002 검사가, 여기서는 업그레이드·재개·같은 원문과 새 원문을 구분하는 계약을 검증한다.
  it.each([
    { newRange: false, original: "form.swift", reread: "form.swift" },
    { newRange: false, original: "form.swift", reread: "./form.swift" },
    { newRange: false, original: "./form.swift", reread: "form.swift" },
    { newRange: false, original: "././/form.swift", reread: "././form.swift" },
    { newRange: true, original: "form.swift", reread: "form.swift" },
    { newRange: true, original: "form.swift", reread: "./form.swift" },
    { newRange: true, original: "./form.swift", reread: "form.swift" },
  ])("F006: 옛 DB의 $original → $reread 재읽기는 추가 복구를 열지 않고, 새 구간만 진척이다(새 구간: $newRange)", async ({ newRange, original, reread }) => {
    const { root, repo, database, git } = setup("codex");
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ requests: [{ ...READ, selector: original }] }));
      if (n === 3) return answer(step({ questions: ["q"], requests: [{ ...(newRange ? NEW_RANGE : READ), selector: reread }] }));
      if (n === 2 || n === 4) {
        const id = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)[0].id as string;
        return answer(step({ facts: [{ statement: "Read navigation", refs: [id] }], questions: ["q"] }));
      }
      return answer(step({ questions: [], complete: true }));
    }, "codex");
    const initial = lossy(fake, { 3: unknownFailure });
    await expect(guardedPlanning(initial.adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings }))
      .rejects.toThrow("unexpected failure");
    expect(database.planning.deliveredToSession("session-1").some(fragment => fragment.kind === "file")).toBe(true);
    // 채택 원장 도입 전의 DB: 정상 채택한 checkpoint·전달 구간은 있지만 새 두 테이블은 없다.
    const raw = new DatabaseSync(join(root, "room.db"));
    raw.exec("DROP TABLE planning_adopted_fragments; DROP TABLE IF EXISTS planning_progress_exclusions;");
    raw.close();
    const upgraded = new ConsensusDatabase(join(root, "room.db"));
    cleanups.push(() => upgraded.close());
    const recovery = lossy(fake, { 1: missing, 4: missing });
    const wrapped = guardedPlanning(recovery.adapter, upgraded, git);
    const run = wrapped.resumeTurn({ cwd: repo, prompt: "Audit the plan", sessionId: "session-1", settings });
    if (newRange) {
      expect((await run).planMarkdown).toBe("Final navigation plan");
      expect(lineageOf(upgraded).recoveries).toHaveLength(2);
    } else {
      await expect(run).rejects.toThrow("again without new evidence");
      expect(recovery.attempts).toHaveLength(4);
      const lineage = lineageOf(upgraded);
      expect(lineage.recoveries).toHaveLength(1);
      expect(lineage.blocked!.current).toEqual(lineage.blocked!.baseline);
      // 다시 열어도 같은 원문을 새 진척으로 올리거나 유료 복구를 더 하지 않는다.
      const reopened = new ConsensusDatabase(join(root, "room.db"));
      cleanups.push(() => reopened.close());
      const retry = lossy(fake, { 1: missing });
      await expect(guardedPlanning(retry.adapter, reopened, git).resumeTurn({ cwd: repo, prompt: "Audit the plan",
        sessionId: "session-3", settings })).rejects.toThrow("again without new evidence");
      expect(retry.attempts.map(attempt => attempt.method)).toEqual(["resume"]);
      expect(lineageOf(reopened).recoveries).toHaveLength(1);
    }
  });

  it("F004 잔여: 복구 뒤 같은 키로 재배정하고 반복 보관·DB 재개해도 각 세션의 측정값은 한 번씩 남는다", async () => {
    const { root, repo, database, git } = setup("codex");
    const fake = scripted(async (_turn, n) => n === 1 ? answer(step({ requests: [READ] }))
      : answer(step({ questions: [], complete: true })), "codex");
    const { adapter } = lossy(fake, { 2: missing });
    const wrapped = guardedPlanning(adapter, database, git);
    const turn = { cwd: repo, prompt: "Audit the plan", settings, job: { role: "reviewer", operation: "audit" } as const };
    await wrapped.createSession({ ...turn, binding: legacyBinding("codex") });
    const prior = database.planning.latest("topic")!;
    const before = ["session-1", "session-2"].map(id => database.planning.sessionContext(id));
    expect(before.every(value => value.known && value.bytes > 0)).toBe(true);
    database.planning.archive(prior);
    database.planning.archive(prior);
    await wrapped.createSession({ ...turn, binding: { provider: "codex", participant: "replacement", profileId: "codex-auditor", basis: { kind: "default" } } });
    const current = database.planning.latest("topic")!;
    expect(current.key).toBe(prior.key);
    expect(current.id).not.toBe(prior.id);
    expect(current.sessionId).toBe("session-3");
    const reopened = new ConsensusDatabase(join(root, "room.db"));
    cleanups.push(() => reopened.close());
    for (const db of [database, reopened]) {
      expect(["session-1", "session-2"].map(id => db.planning.sessionContext(id))).toEqual(before);
      expect(db.planning.sessionContext("session-3")).toEqual({ known: true, bytes: current.injectedBytes + (current.responseBytes ?? 0) });
      expect(db.planning.sessionContext("never-observed")).toEqual({ known: false, bytes: 0 });
    }
    // 같은 세션에 별도 checkpoint가 실제로 보낸 바이트는 합산한다(archive 중복 제거를 세션 전체 max로 바꾸면 안 됨).
    database.planning.save({ ...current, id: "another-checkpoint", key: "another-key", injectedBytes: 100, responseBytes: 50 });
    expect(database.planning.sessionContext("session-3").bytes).toBe(current.injectedBytes + (current.responseBytes ?? 0) + 150);
  });

  it("F006: 옛 전달은 채택으로 승격하지 않고 겹친 바이트만 제외하며, 업그레이드 뒤의 미채택 구간은 재개 때 제외 목록에 넣지 않는다", () => {
    const { root, database } = setup("codex");
    const fragment = (id: string, offset: number, nextOffset: number, hash = "a".repeat(64)): PlanningFragment => ({
      id, kind: "file", selector: "file.swift", hash, offset, nextOffset, content: "x".repeat(nextOffset - offset),
    });
    database.planning.recordDelivery("legacy", [fragment("old-a", 0, 8), fragment("old-b", 4, 12)]);
    const raw = new DatabaseSync(join(root, "room.db"));
    raw.exec("DROP TABLE planning_adopted_fragments; DROP TABLE IF EXISTS planning_progress_exclusions;");
    raw.close();
    const upgraded = new ConsensusDatabase(join(root, "room.db"));
    cleanups.push(() => upgraded.close());
    const sessions = ["legacy", "new"];
    expect(upgraded.planning.lineageProgress("topic", sessions)).toEqual({});
    upgraded.planning.recordDelivery("new", [fragment("overlap", 2, 16)]);
    expect(upgraded.planning.lineageProgress("topic", sessions)).toEqual({});
    upgraded.planning.recordAdoption("new", ["overlap"]);
    const key = JSON.stringify(["file", "file.swift", "a".repeat(64)]);
    // 옛 [0,8)+[4,12)의 합집합은 [0,12). 새 [2,16) 중 [12,16) 4바이트만 새 진척이다.
    expect(upgraded.planning.lineageProgress("topic", sessions)).toEqual({ [key]: 4 });
    upgraded.planning.recordDelivery("new", [fragment("pending", 16, 20), fragment("changed-source", 0, 3, "b".repeat(64))]);
    const reopened = new ConsensusDatabase(join(root, "room.db"));
    cleanups.push(() => reopened.close());
    expect(reopened.planning.lineageProgress("topic", sessions)).toEqual({ [key]: 4 });
    reopened.planning.recordAdoption("new", ["pending", "changed-source"]);
    expect(reopened.planning.lineageProgress("topic", sessions)).toEqual({
      [key]: 8, [JSON.stringify(["file", "file.swift", "b".repeat(64)])]: 3,
    });
    // 파일이 아닌 문서 selector와 내용이 같은 별도 파일을 정규화해서 서로 합치면 안 된다.
    const distinct: PlanningFragment[] = [
      { ...fragment("context-a", 0, 3), kind: "context", selector: "file.swift" },
      { ...fragment("context-b", 0, 3), kind: "context", selector: "./file.swift" },
      { ...fragment("another-file", 0, 3), selector: "another.swift" },
    ];
    reopened.planning.recordDelivery("new", distinct);
    reopened.planning.recordAdoption("new", distinct.map(value => value.id));
    expect(reopened.planning.lineageProgress("topic", sessions)).toMatchObject({
      [JSON.stringify(["context", "file.swift", "a".repeat(64)])]: 3,
      [JSON.stringify(["context", "./file.swift", "a".repeat(64)])]: 3,
      [JSON.stringify(["file", "another.swift", "a".repeat(64)])]: 3,
    });
  });

  it.each([false, true])("F006: 이미 소비한 복구의 옛 별칭 기준선도 DB 재개 후 같은 파일로 대조한다(중복 별칭: %s)", async duplicate => {
    const { root, repo, database, git } = setup("codex");
    const fake = scripted(async (turn, n) => {
      if (n === 1 || n === 3) return answer(step({ questions: ["q"], requests: [{ ...READ, selector: n === 1 ? "./form.swift" : "form.swift" }] }));
      if (n === 2 || n === 4) {
        const id = JSON.parse(turn.prompt.split("Fragments: ").at(-1)!)[0].id as string;
        return answer(step({ facts: [{ statement: "Same file", refs: [id] }], questions: ["q"] }));
      }
      return answer(step({ questions: [], complete: true }));
    }, "codex");
    const initial = lossy(fake, { 3: missing, 4: unknownFailure });
    await expect(guardedPlanning(initial.adapter, database, git).createSession({ cwd: repo, prompt: "Audit the plan", settings }))
      .rejects.toThrow("unexpected failure");
    const lineage = lineageOf(database);
    expect(lineage.recoveries).toHaveLength(1);
    const last = lineage.recoveries[0];
    const [key, covered] = Object.entries(last.baseline).find(([key]) => JSON.parse(key)[0] === "file")!;
    const source = JSON.parse(key) as string[];
    expect(covered).toBeGreaterThan(0);
    delete last.baseline[key];
    last.baseline[JSON.stringify([source[0], "./form.swift", source[2]])] = covered;
    if (duplicate) last.baseline[JSON.stringify([source[0], "././form.swift", source[2]])] = covered;
    // 정규화 전 저장 형식의 기준선 fixture. 새 복구나 예산을 만들지 않고 동일 계보를 다시 연다.
    database.planning.saveRecoveryLineage("topic", "reviewer", lineage);
    const reopened = new ConsensusDatabase(join(root, "room.db"));
    cleanups.push(() => reopened.close());
    const retry = lossy(fake, { 3: missing });
    await expect(guardedPlanning(retry.adapter, reopened, git).resumeTurn({ cwd: repo, prompt: "Audit the plan",
      sessionId: "session-1", settings })).rejects.toThrow("again without new evidence");
    expect(retry.attempts.map(attempt => attempt.method)).toEqual(["create", "resume", "resume"]);
    expect(lineageOf(reopened).recoveries).toHaveLength(1);
    expect(lineageOf(reopened).recoveries[0].baseline[key]).toBe(covered * (duplicate ? 2 : 1));
  });
});

// host-review 9c4d786 F003·F004 — 연속성 v2 작성자 좌석의 계획 턴 복구가 좌석 세션 연결을 끊지 않는다. 공개 경계: 엔진 startPlan·retry → 실행기(좌석 신원 대조)
// → guardedPlanning(복구 계보) → 가짜 모델. 감사(Codex)는 이 검사의 대상이 아니라 부르면 실패로 멈춘다.
describe("E3-3b 계획자 좌석 복구의 세션 연결(host-review 9c4d786)", () => {
  const claudeMissing = (sessionId: string) => agentRunError("claude", 1, `No conversation found with session ID: ${sessionId}\n`,
    JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: sessionId }));
  const PLAN_BODY = REQUIRED_PLAN_HEADINGS.map(heading => `## ${heading}\n\nPLANNER_RECOVERY_BODY${heading === "허용 오차"
    ? '\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```' : ""}`).join("\n\n");
  const finalPlan = (): AgentResult => ({ kind: "PLAN", summary: "Plan", planMarkdown: PLAN_BODY, findings: [], evidenceRefs: [],
    planningStep: step({ questions: [], complete: true }) });
  // 모델 대역: 잃은 세션이면 관측된 유실 형태로 실패하고, 아니면 script 의 답(또는 세션을 알리기 전의 실패)을 낸다. 새 세션 id 는 author-N 이다.
  function planningModel(lost: Set<string>, script: (turn: SessionTurn, call: number) => AgentResult | Error) {
    const calls: SessionTurn[] = [];
    let created = 0;
    const run = async (turn: SessionTurn): Promise<AgentResult> => {
      calls.push(turn);
      if (lost.has(turn.sessionId)) throw claudeMissing(turn.sessionId);
      const reply = script(turn, calls.length);
      if (reply instanceof Error) throw reply;
      turn.onSessionCreated?.(turn.sessionId);
      turn.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });
      turn.onUsage?.({ inputTokens: 100, outputTokens: 20, durationMs: 1, recordKind: "final", completeness: "complete" });
      return reply;
    };
    const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true, resumeTurn: run,
      createSession: async turn => { const sessionId = `author-${++created}`; return { sessionId, result: await run({ ...turn, sessionId } as SessionTurn) }; } };
    return { calls, adapter };
  }
  // 연속성 v2(계획 전 활성화) 주제의 첫 계획 — 좌석 세션 claude-existing 을 재개한다.
  function planningRoom(adapter: AgentAdapter) {
    const env = setup();
    env.database.updateTopic("topic", { state: "DRAFT" });
    for (const role of ["claude", "codex"] as const) env.database.upsertParticipant("topic", {
      role, sessionId: `${role}-existing`, mode: "attached", acknowledgedPlanSHA256: null,
    });
    const codex: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
      createSession: async () => { throw new Error("AUDIT_OUT_OF_SCOPE"); }, resumeTurn: async () => { throw new Error("AUDIT_OUT_OF_SCOPE"); } };
    const engine = new WorkflowEngine({ database: env.database, git: env.git, artifacts: new ArtifactStore(join(env.root, "artifacts"), env.database),
      claude: guardedPlanning(withEvidence(guardRunnerControl(adapter), env.database, join(env.root, "evidence-images")), env.database, env.git), codex });
    const settle = async () => {
      const deadline = Date.now() + 15000;
      while (env.database.runningAction("topic")) {
        if (Date.now() > deadline) throw new Error("Workflow timeout");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    return { ...env, engine, settle };
  }
  // 대기 중 복구(toSession 없음)의 계약 바인딩을 다른 참여자로 바꾼다 — 계약이 바뀐 복구 기록에 새 세션을 잇지 않는지 보는 전제.
  const moveContractBinding = (database: ConsensusDatabase) => {
    const lineage = database.planning.storedRecoveryLineage("topic", "planner")!;
    const pending = lineage.recoveries.at(-1)!;
    expect(pending.toSession).toBeNull();
    pending.contract = { ...pending.contract, binding: { ...(pending.contract.binding ?? legacyBinding("claude")), participant: "another-author" } };
    database.planning.saveRecoveryLineage("topic", "planner", lineage);
  };

  // F001: 구현한 v2 주제의 진단 계획 개정 턴에서 작성자 세션(구현 세션과 같은 author-1)이 유실되면 계획자 좌석 복구가 author-2 를 연다 — 그 복구는 구현
  // 연결(구현 세션)도 author-1 → author-2 로 함께 옮긴다. 옛 세션에 남기면 재승인 뒤 runImplementation 가드가 author-1 ≠ author-2 로 영구 정지했다.
  it("F001: 구현한 v2 주제의 진단 계획 개정 중 작성자 세션이 유실되면 계획자 복구가 구현 연결도 새 세션으로 옮겨 재승인 뒤 구현이 잇는다", async () => {
    const { root, database, git } = setup();
    database.updateTopic("topic", { state: "DRAFT" });
    for (const role of ["claude", "codex"] as const) database.upsertParticipant("topic", {
      role, sessionId: `pending:${role}`, mode: "created", acknowledgedPlanSHA256: null,
    });
    const plan = REQUIRED_PLAN_HEADINGS.map(heading => `## ${heading}\n\nF001_PLAN_BODY${heading === "허용 오차" ? '\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```' : ""}`).join("\n\n");
    const finding = { id: "F-1", title: "Validate navigation", severity: "HIGH" as const, disposition: "AGREED_ACTION" as const,
      rationale: "Preserve navigation", evidenceRefs: [], requiresUserDecision: false };
    const lost = new Set<string>();
    const turns: SessionTurn[] = [];
    let creates = 0, currentPlan = plan, diagnosisId = "";
    const diagnosisFindings = () => diagnosisId ? [{ id: diagnosisId, title: "중재자 진단", severity: "HIGH" as const, disposition: "AGREED_ACTION" as const,
      rationale: "롤백 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }] : [];
    const runClaude = async (t: SessionTurn): Promise<AgentResult> => {
      if (lost.has(t.sessionId)) throw claudeMissing(t.sessionId);
      if (t.protocolOnly) return { kind: "ACK", summary: "ack", findings: [], evidenceRefs: [], planSHA256: database.getTopic("topic").planSHA256! };
      turns.push(t);
      t.onSessionCreated?.(t.sessionId);
      t.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });
      t.onUsage?.({ inputTokens: 100, outputTokens: 20, durationMs: 1, recordKind: "final" });
      if (t.implementation) return { kind: "IMPLEMENTATION", summary: "Await decision", status: "blocked", findings: [], evidenceRefs: [], requestedUserDecision: "Confirm completion" };
      if (t.job?.operation === "diagnosis-revision") {
        currentPlan = plan.replace("F001_PLAN_BODY", "F001_PLAN_BODY\n\nROLLBACK_STEP");
        return { kind: "REVISION", summary: "Replanned", planMarkdown: currentPlan, evidenceRefs: [], planningStep: step({ questions: [], complete: true }),
          findings: diagnosisFindings() };
      }
      const revision = database.getTopic("topic").state === "CLAUDE_REVISION";
      return { kind: revision ? "REVISION" : "PLAN", summary: "Plan", planMarkdown: currentPlan,
        findings: revision ? [finding, ...diagnosisFindings()] : [], evidenceRefs: [], planningStep: step({ questions: [], complete: true }) };
    };
    const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true, resumeTurn: runClaude,
      createSession: async t => {
        const id = t.protocolOnly ? "ack-only" : `author-${++creates}`;
        return { sessionId: id, result: await runClaude({ ...t, sessionId: id }) };
      } };
    const codex: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
      createSession: async t => ({ sessionId: "review", result: await codex.resumeTurn({ ...t, sessionId: "review" }) }),
      resumeTurn: async t => ({ kind: t.protocolOnly ? "ACK" : database.getTopic("topic").state === "CODEX_AUDIT" ? "AUDIT" : "CLOSEOUT",
        summary: "Reviewed", findings: t.protocolOnly ? [] : [finding, ...diagnosisFindings()], evidenceRefs: [], planSHA256: database.getTopic("topic").planSHA256! }) };
    const engine = new WorkflowEngine({ database, git, artifacts: new ArtifactStore(join(root, "artifacts"), database),
      claude: guardedPlanning(claude, database, git), codex });
    const settle = async () => {
      const deadline = Date.now() + 15000;
      while (database.runningAction("topic")) {
        if (Date.now() > deadline) throw new Error("Workflow timeout");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    engine.startPlan("topic"); await settle();
    expect(database.getTopic("topic").state, database.getTopic("topic").lastError ?? "").toBe("AWAITING_USER_APPROVAL");
    engine.approve("topic", database.getTopic("topic").planSHA256!);
    engine.startImplementation("topic"); await settle();
    expect(turns.at(-1)).toMatchObject({ sessionId: "author-1", implementation: true });
    expect(database.getFlags("topic").implementationSessionId).toBe("author-1");
    // 작성자 세션 author-1 이 실제로 유실된 채 계획 변경 진단의 개정 턴이 그 세션을 재개한다 — 계획자 좌석 복구가 author-2 를 연다.
    lost.add("author-1");
    const diagnosis = await engine.registerDiagnosis("topic", DiagnosisInputSchema.parse({ kind: "fix", title: "계획 변경: 롤백 단계 추가",
      observedFailure: "롤백 절차가 없습니다.", evidenceRefs: ["evidence/rollback.log"], cause: "승인 계획에 롤백 단계가 없습니다.", uncertainty: "없음",
      instructions: "롤백 단계를 계획에 추가하세요.", verificationCriteria: ["롤백 green"], planChange: { required: true, reason: "승인 범위에 롤백 단계를 더해야 합니다." } }));
    diagnosisId = diagnosis.id;
    await engine.applyDiagnosis("topic", diagnosis.id, {}); await settle();
    for (let grants = 0; grants < 3 && (database.getTopic("topic").lastError ?? "").includes("계획 검토 한도"); grants += 1) {
      database.reviews.grant("topic", "planning", `f001-replan-review-${grants}`, database.reviews.account("topic", "planning").version);
      engine.retry("topic"); await settle();
    }
    expect(database.getTopic("topic").state, database.getTopic("topic").lastError ?? "").toBe("AWAITING_USER_APPROVAL");
    expect(creates).toBe(2);
    expect(database.planning.storedRecoveryLineage("topic", "planner")!.recoveries.map(record => [record.fromSession, record.toSession]))
      .toEqual([["author-1", "author-2"]]);
    expect(database.getFlags("topic").implementationSessionId).toBe("author-2");
    const replanned = database.getTopic("topic");
    expect(database.planning.boundSession(replanned)?.sessionId).toBe("author-2");
    engine.approve("topic", replanned.planSHA256!);
    engine.startImplementation("topic"); await settle();
    expect(turns.at(-1)).toMatchObject({ sessionId: "author-2", implementation: true });
    expect(database.getFlags("topic").implementationSessionId).toBe("author-2");
    expect(creates).toBe(2);
    await engine.shutdown();
  });

  // F001 경계: 계보 연결과 함께 구현 연결을 옮기는 것은 구현 세션이 그 복구의 원래 세션이고 저장된 구현 바인딩이 좌석 바인딩과 같을 때뿐이다 — 다른 구현
  // 세션이나 바뀐 바인딩은 덮지 않는다(계보는 그래도 잇는다). 한 transaction 이다.
  it.each(["same", "other-session", "other-binding"] as const)("F001 경계: 구현 연결은 원래 세션·같은 바인딩일 때만 옮긴다(%s)", kind => {
    const { database } = setup();
    const seat = { ...legacyBinding("claude"), participant: "author-seat" };
    database.setImplementationSession("topic", kind === "other-session" ? "impl-other" : "author-1",
      kind === "other-binding" ? { ...seat, participant: "replaced-seat" } : seat);
    const lineage = database.planning.currentRecoveryLineage("topic", "planner");
    lineage.recoveries.push({ at: new Date().toISOString(), reason: "session-missing", fromSession: "author-1", toSession: "author-2", compaction: "automatic-only",
      contract: { stage: "CLAUDE_PLAN", scopeGeneration: 1, planEpoch: 0, planSHA256: null, binding: seat }, baseline: {},
      error: { provider: "claude", code: "session-missing", message: "lost" } });
    database.linkRecoveredPlanningSession({ topicId: "topic", lineage: { jobRole: "planner", value: lineage },
      implementation: { fromSession: "author-1", toSession: "author-2", binding: seat } });
    expect(database.planning.storedRecoveryLineage("topic", "planner")!.recoveries.at(-1)?.toSession).toBe("author-2");
    expect([database.getFlags("topic").implementationSessionId, database.implementationSessionBinding("topic")?.participant]).toEqual({
      "same": ["author-2", "author-seat"], "other-session": ["impl-other", "author-seat"], "other-binding": ["author-1", "replaced-seat"],
    }[kind]);
  });

  // F003: 한 계획 호출 안의 연쇄 복구 — 실행기는 직전에 수용한 세션을 기준으로 짝을 대조한다. 합법적인 claude-existing → author-1 → author-2 는 받고,
  // 계약이 바뀌어 짝이 없는 새 세션은 직전 수용 세션(author-1)을 요청 id 로 남기고 막는다.
  it.each([true, false])("F003: 한 호출 안의 연쇄 복구를 직전 수용 세션 기준으로 대조한다(짝 있음: %s)", async paired => {
    const lost = new Set(["claude-existing"]);
    let room!: ReturnType<typeof planningRoom>;
    const model = planningModel(lost, (turn, call) => {
      if (call === 2) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
      if (call === 3) {
        // author-1 이 새 조각을 받아 채택된 뒤 유실된다 — 새 근거가 있어 두 번째 복구가 허가된다.
        lost.add(turn.sessionId);
        return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read more", offset: 6692 }] }));
      }
      if (!paired) moveContractBinding(room.database);
      return finalPlan();
    });
    room = planningRoom(model.adapter);
    room.engine.startPlan("topic"); await room.settle();
    expect(model.calls.map(turn => turn.sessionId)).toEqual(["claude-existing", "author-1", "author-1", "author-1", "author-2"]);
    const lineage = room.database.planning.storedRecoveryLineage("topic", "planner")!;
    const seat = room.database.getTopic("topic").participants.find(participant => participant.role === "claude")!;
    if (paired) {
      expect(lineage.recoveries.map(record => [record.fromSession, record.toSession])).toEqual([["claude-existing", "author-1"], ["author-1", "author-2"]]);
      expect(lineage.blocked ?? null).toBeNull();
      expect(seat.sessionId).toBe("author-2");
      expect(room.database.latestPlannerCheckpoint("topic", "claude")).toMatchObject({ finalized: true, sessionId: "author-2" });
      expect(room.database.getTopic("topic").lastError).toContain("AUDIT_OUT_OF_SCOPE");
    } else {
      expect(lineage.recoveries.map(record => [record.fromSession, record.toSession])).toEqual([["claude-existing", "author-1"], ["author-1", null]]);
      expect(lineage.blocked).toMatchObject({ reason: "identity-mismatch", sessions: { requested: "author-1", returned: "author-2" } });
      expect(seat.sessionId).toBe("author-1");
      expect(room.database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
    }
    await room.engine.shutdown();
  });

  it.each(["missing", "existing", "unavailable"] as const)("F004 실행 전 중단: 실제 대화의 존재·유실·조회 실패를 구분한다(%s)", async mode => {
    const exists = mode === "existing";
    let unavailable = mode === "unavailable";
    const lost = new Set(["claude-existing"]);
    const model = planningModel(lost, (turn, call) => {
      if (call === 2) {
        // ClaudeAdapter.createSession처럼 ID를 먼저 알리고, 비동기 준비 중 종료된다(onProcessSpawn 없음).
        turn.onSessionCreated?.(turn.sessionId);
        if (!exists) lost.add(turn.sessionId);
        return new Error("INTERRUPTED_AFTER_ID_ALLOCATION");
      }
      return finalPlan();
    });
    model.adapter.validateExistingSession = async id => {
      if (unavailable) throw new Error("SESSION_LOOKUP_UNAVAILABLE");
      return !lost.has(id);
    };
    model.adapter.isSessionMissing = async id => {
      if (unavailable) throw new Error("SESSION_LOOKUP_UNAVAILABLE");
      return lost.has(id);
    };
    const room = planningRoom(model.adapter);
    room.database.setImplementationSession("topic", "claude-existing", legacyBinding("claude"));
    room.engine.startPlan("topic"); await room.settle();
    expect(room.database.getTopic("topic").lastError).toContain("INTERRUPTED_AFTER_ID_ALLOCATION");
    const reopened = new ConsensusDatabase(join(room.root, "room.db"));
    try {
      expect(reopened.planning.latest("topic", "claude")).toMatchObject({ sessionId: "author-1", started: false });
      expect(reopened.planning.storedRecoveryLineage("topic", "planner")!.recoveries.at(-1)?.toSession).toBe("author-1");
    } finally { reopened.close(); }
    room.engine.retry("topic"); await room.settle();
    if (unavailable) {
      expect(room.database.getTopic("topic").lastError).toContain("SESSION_LOOKUP_UNAVAILABLE");
      expect(model.calls).toHaveLength(2);
      expect(room.database.planning.storedRecoveryLineage("topic", "planner")!.recoveries.at(-1))
        .toMatchObject({ fromSession: "claude-existing", toSession: "author-1" });
      unavailable = false;
      room.engine.retry("topic"); await room.settle();
    }
    const recovered = exists ? "author-1" : "author-2";
    expect(model.calls.map(turn => turn.sessionId)).toEqual(["claude-existing", "author-1", recovered]);
    expect(room.database.planning.storedRecoveryLineage("topic", "planner")!.recoveries.map(record => [record.fromSession, record.toSession]))
      .toEqual([["claude-existing", recovered]]);
    expect(room.database.planning.storedRecoveryLineage("topic", "planner")!.recoveries.at(-1)?.unstartedSessions ?? [])
      .toEqual(exists ? [] : ["author-1"]);
    expect(room.database.latestPlannerCheckpoint("topic", "claude"), room.database.getTopic("topic").lastError ?? "").toMatchObject({ finalized: true, sessionId: recovered });
    expect(room.database.getFlags("topic").implementationSessionId).toBe(recovered);
    await room.engine.shutdown();
  });

  it.each(["EACCES", "EIO", "unsupported"])("F006: 실제 세션 조회를 확정하지 못하면 복구 연결을 보존한다(%s)", async mode => {
    const id = "11111111-1111-4111-8111-111111111111";
    const native = new ClaudeAdapter({ run: async () => { throw new Error("NO_PROVIDER_SPAWN"); } });
    const model = planningModel(new Set(["claude-existing"]), (turn, call) => {
      if (call === 2) {
        turn.onSessionCreated?.(turn.sessionId);
        return new Error("INTERRUPTED_AFTER_ID_ALLOCATION");
      }
      return finalPlan();
    });
    model.adapter.validateExistingSession = async () => native.validateExistingSession(id);
    if (mode !== "unsupported") model.adapter.isSessionMissing = async () => native.isSessionMissing(id);
    const room = planningRoom(model.adapter);
    room.database.setImplementationSession("topic", "claude-existing", legacyBinding("claude"));
    room.engine.startPlan("topic"); await room.settle();
    expect(room.database.planning.latest("topic", "claude")).toMatchObject({ sessionId: "author-1", started: false });
    const sessionRoot = join(room.root, "provider-home");
    const project = join(sessionRoot, ".claude", "projects", "-workspace");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${id}.jsonl`), "existing conversation\n");
    const { readdir: original } = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    const read = vi.spyOn(fsPromises, "readdir").mockImplementation((async (...args: Parameters<typeof original>) => {
      if (String(args[0]) === project) throw Object.assign(new Error(`SESSION_LOOKUP_${mode}`), { code: mode });
      return original(...args);
    }) as typeof original);
    vi.stubEnv("HOME", sessionRoot);
    try {
      // 실제 어댑터의 legacy false를 재현한다. 이 값은 복구용 부재 증명이 아니다.
      expect(await native.validateExistingSession(id)).toBe(false);
      room.engine.retry("topic"); await room.settle();
      expect(model.calls).toHaveLength(2);
      expect(room.database.getTopic("topic").lastError).toContain(mode === "unsupported" ? "cannot confirm session absence" : `SESSION_LOOKUP_${mode}`);
      const reopened = new ConsensusDatabase(join(room.root, "room.db"));
      try {
        expect(reopened.planning.latest("topic", "claude")).toMatchObject({ sessionId: "author-1", started: false });
        expect(reopened.planning.storedRecoveryLineage("topic", "planner")!.recoveries).toHaveLength(1);
        expect(reopened.planning.storedRecoveryLineage("topic", "planner")!.recoveries[0]).toMatchObject({ toSession: "author-1" });
        expect(reopened.getFlags("topic").implementationSessionId).toBe("author-1");
      } finally { reopened.close(); }
      read.mockRestore();
      if (mode === "unsupported") return;
      room.engine.retry("topic"); await room.settle();
      expect(model.calls.map(turn => turn.sessionId)).toEqual(["claude-existing", "author-1", "author-1"]);
      expect(room.database.latestPlannerCheckpoint("topic", "claude")).toMatchObject({ finalized: true, sessionId: "author-1" });
      expect(room.database.planning.storedRecoveryLineage("topic", "planner")!.recoveries[0].unstartedSessions ?? []).toEqual([]);
    } finally { read.mockRestore(); vi.unstubAllEnvs(); await room.engine.shutdown(); }
  });

  it("F004 실행된 세션: 시작한 복구 세션의 유실을 ID 할당 취소로 돌려 복구 제한을 우회하지 않는다", async () => {
    const lost = new Set(["claude-existing"]);
    const model = planningModel(lost, (turn, call) => {
      if (call === 2) {
        turn.onSessionCreated?.(turn.sessionId);
        turn.onProcessSpawn?.({ pid: 1, pgid: 1, executable: "fake", commandLine: "fake", startedAt: "now" });
        turn.onUsage?.({ inputTokens: 10, outputTokens: 0, durationMs: 1, recordKind: "final", completeness: "complete" });
        lost.add(turn.sessionId);
        return new Error("INTERRUPTED_AFTER_SPAWN");
      }
      return finalPlan();
    });
    model.adapter.validateExistingSession = async id => !lost.has(id);
    const room = planningRoom(model.adapter);
    room.engine.startPlan("topic"); await room.settle();
    expect(room.database.planning.latest("topic", "claude")).toMatchObject({ sessionId: "author-1", started: true });
    room.engine.retry("topic"); await room.settle();
    expect(model.calls.map(turn => turn.sessionId)).toEqual(["claude-existing", "author-1", "author-1"]);
    const lineage = room.database.planning.storedRecoveryLineage("topic", "planner")!;
    expect(lineage.recoveries).toHaveLength(1);
    expect(lineage.recoveries[0].unstartedSessions ?? []).toEqual([]);
    expect(lineage.blocked?.reason).toBe("session-missing");
    await room.engine.shutdown();
  });

  it.each([false, true])("F004 저장 중단: 복구 연결과 checkpoint가 함께 남고 DB 재개 뒤 정상 계획을 잇는다(일시 실패: %s)", async transient => {
    const model = planningModel(new Set(["claude-existing"]), () => finalPlan());
    const room = planningRoom(model.adapter);
    room.database.setImplementationSession("topic", "claude-existing", legacyBinding("claude"));
    const save = room.database.planning.save.bind(room.database.planning);
    let interrupted = false;
    const spy = vi.spyOn(room.database.planning, "save").mockImplementation(record => {
      // 연결 저장 뒤 checkpoint 쓰기에서 종료한다. finally의 같은 세션 재저장도 실패시켜 종료 시 디스크 상태를 보존한다.
      if (record.sessionId === "author-1" && (!interrupted || !transient)) {
        interrupted = true;
        throw new Error("CHECKPOINT_WRITE_INTERRUPTED");
      }
      save(record);
    });
    room.engine.startPlan("topic"); await room.settle();
    expect(interrupted).toBe(true);
    spy.mockRestore();
    const reopened = new ConsensusDatabase(join(room.root, "room.db"));
    try {
      expect(reopened.planning.storedRecoveryLineage("topic", "planner")!.recoveries.at(-1)?.toSession).toBeNull();
      expect(reopened.planning.latest("topic", "claude")?.sessionId).toBeNull();
      expect(reopened.getFlags("topic").implementationSessionId).toBe("claude-existing");
    } finally { reopened.close(); }
    room.engine.retry("topic"); await room.settle();
    expect(model.calls.map(turn => turn.sessionId)).toEqual(["claude-existing", "author-1", "author-2"]);
    expect(room.database.planning.storedRecoveryLineage("topic", "planner")!.recoveries.at(-1)?.toSession).toBe("author-2");
    expect(room.database.latestPlannerCheckpoint("topic", "claude")).toMatchObject({ finalized: true, sessionId: "author-2" });
    expect(room.database.getTopic("topic").participants.find(participant => participant.role === "claude")?.sessionId).toBe("author-2");
    expect(room.database.getFlags("topic").implementationSessionId).toBe("author-2");
    await room.engine.shutdown();
  });

  // F004: 복구를 허가한 뒤 새 세션이 생기기 전에 끊기면(호스트 중단) 재시도의 새 세션을 영속 계보의 대기 중 기록에 잇는다 — 메모리 표지는 사라졌다.
  // 계약(바인딩)이 바뀐 대기 중 기록에는 잇지 않고, 실행기가 짝 없는 세션으로 막는다.
  it.each([false, true])("F004: 새 세션 전 중단 뒤 재시도의 새 세션을 영속된 대기 중 복구에 잇는다(계약 바뀜: %s)", async contractChanged => {
    const lost = new Set(["claude-existing"]);
    const model = planningModel(lost, (_turn, call) => call === 2 ? new Error("HOST_INTERRUPTED_BEFORE_SESSION") : finalPlan());
    const room = planningRoom(model.adapter);
    room.engine.startPlan("topic"); await room.settle();
    expect(room.database.getTopic("topic").lastError).toContain("HOST_INTERRUPTED_BEFORE_SESSION");
    const pending = room.database.planning.storedRecoveryLineage("topic", "planner")!;
    expect(pending.recoveries.map(record => [record.fromSession, record.toSession])).toEqual([["claude-existing", null]]);
    if (contractChanged) moveContractBinding(room.database);
    room.engine.retry("topic"); await room.settle();
    expect(model.calls.map(turn => turn.sessionId)).toEqual(["claude-existing", "author-1", "author-2"]);
    const lineage = room.database.planning.storedRecoveryLineage("topic", "planner")!;
    const seat = room.database.getTopic("topic").participants.find(participant => participant.role === "claude")!;
    if (!contractChanged) {
      expect(lineage.recoveries.map(record => [record.fromSession, record.toSession])).toEqual([["claude-existing", "author-2"]]);
      expect(lineage.sessions).toContain("author-2");
      expect(lineage.blocked ?? null).toBeNull();
      expect(seat.sessionId).toBe("author-2");
      expect(room.database.latestPlannerCheckpoint("topic", "claude")).toMatchObject({ finalized: true, sessionId: "author-2" });
    } else {
      expect(lineage.recoveries.map(record => [record.fromSession, record.toSession])).toEqual([["claude-existing", null]]);
      expect(lineage.blocked).toMatchObject({ reason: "identity-mismatch", sessions: { requested: "claude-existing", returned: "author-2" } });
      expect(seat.sessionId).toBe("claude-existing");
    }
    await room.engine.shutdown();
  });
});

// ---- E3-4a 회차 수로 정리하지 않기·완료 강등·결정 뒤 이연 읽기 ----
// 공개 경계: guardedPlanning(adapter) — 대역 모델이 완료·결정 요청·읽기 요청을 낸다. 스냅숏은 실제 git 작업 트리(writeWorkingTree)다.
describe("E3-4a 완료 강등과 이연 읽기", () => {
  const korean = (length: number) => Array.from({ length }, (_, i) => "가나다라마바사아자차카타파하"[i % 14]).join("");
  const DEFERRED = { kind: "file" as const, selector: "form.swift", question: "Read behind the decision", offset: 26 };
  const fragmentsIn = (turn: Omit<SessionTurn, "sessionId">) => JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as PlanningFragment[];
  // 결정을 청하며 읽기를 남긴 첫 응답 → 결정 → 결정 뒤 재개. 결정 전 스냅숏을 바꾸는 손질(mutate)을 끼울 수 있다.
  async function decideThenResume(mutate: (repo: string) => void = () => {}) {
    const context = setup();
    const fake = scripted(async (_turn, n) => n === 1
      ? { ...answer(step({ requests: [DEFERRED] })), requestedUserDecision: "Who owns the step value?" }
      : answer(step({ questions: [], complete: true })));
    const adapter = guardedPlanning(fake.adapter, context.database, context.git);
    await adapter.resumeTurn({ cwd: context.repo, prompt: "Plan", sessionId: "planning-session" });
    const decided = context.database.planning.latest("topic")!;
    mutate(context.repo);
    context.database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_PLAN", body: "The form owns the step value" });
    const resumed = await adapter.resumeTurn({ cwd: context.repo, prompt: "Plan with decision", sessionId: "planning-session" });
    return { ...context, fake, decided, resumed };
  }

  it("Q-A: a completed response that still requests reads keeps its raw answer, is adopted as an intermediate step and approved only after the reads", async () => {
    const { repo, database, git } = setup();
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ questions: [], complete: true, requests: [{ kind: "file", selector: "form.swift", question: "Confirm", offset: 0 }] }));
      const checkpoint = database.planning.latest("topic")!;
      expect(checkpoint).toMatchObject({ finalized: false, demotedComplete: { requests: 1, unreadRequired: 0 }, step: { complete: false } });
      expect(checkpoint.lastResponse?.planningStep?.complete).toBe(true);
      expect(checkpoint.finalResult).toBeUndefined();
      expect(fragmentsIn(turn).map(fragment => [fragment.selector, fragment.offset])).toEqual([["form.swift", 0]]);
      return answer(step({ questions: [], complete: true }));
    });
    const result = await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(2);
    const final = database.planning.latest("topic")!;
    expect(final.finalized).toBe(true);
    expect(final.demotedComplete).toBeUndefined();
  });

  it("Q-A: a repeated demoted completion without new evidence is not progress and stops on the no-progress rule", async () => {
    const { repo, database, git } = setup();
    const fake = scripted(async () => answer(step({ questions: [], complete: true,
      requests: [{ kind: "file", selector: "form.swift", question: "Confirm", offset: 0 }] })));
    await expect(guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("no new evidence");
    // 1: 강등·읽기 제공 → 2: 받은 조각이 새 근거(진척) → 3·4: 같은 조각은 이미 전달돼 새 근거 없음 — 두 번 연속 무진척이면 다음 호출 전에 멈춘다.
    expect(fake.calls).toHaveLength(4);
    expect(database.planning.latest("topic")).toMatchObject({ finalized: false, stalled: 2 });
  });

  // 강등한 응답은 거절된 최종 응답이 아니다 — 그 raw 에 남은 미전달 인용으로 인용 교정(추가 조사 없이 최종 정리하는 유료 호출)을 열지 않는다. 예산 정지는 그대로다.
  it("Q-A: a demoted final response with unsupported citations does not open citation repair after the budget stop", async () => {
    // 실행 예산 1,000(호출당 100): 여덟 번 뒤 soft limit, 정리 예약(최대 호출의 125%)이 남아 아홉째가 예산이 강제한 정리다.
    const { repo, database, git } = setup("claude", 1000);
    const fake = scripted(async (_turn, n) => n <= 8
      ? answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Continue", offset: (n - 1) * 100 }] }))
      : n === 9 ? answer(step({ questions: [], complete: true, facts: [{ statement: "Unsupported", refs: ["not-delivered"] }],
        requests: [{ kind: "file", selector: "form.swift", question: "One more", offset: 900 }] }))
      : answer(step({ questions: [], complete: true })));
    const adapter = guardedPlanning(fake.adapter, database, git);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Synthesis did not produce a complete plan");
    expect(fake.calls).toHaveLength(9);
    expect(fake.calls[8].prompt).toContain("No more research is available");
    expect(database.planning.latest("topic")).toMatchObject({ finalAttempted: true, demotedComplete: { requests: 1, unreadRequired: 0 } });
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("insufficient remaining budget for synthesis");
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("insufficient remaining budget for synthesis");
    expect(fake.calls).toHaveLength(9);
    // 예산을 늘리면 같은 시도가 인용 교정("Do not request more evidence")이 아니라 남은 읽기부터 잇는다.
    database.budgets.grant("topic", "raise-after-demoted-synthesis", { execution: { inputTokens: 3000, outputTokens: 10000, durationMs: 100000 },
      total: { inputTokens: 300000, outputTokens: 30000, durationMs: 300000 } }, database.budgets.account("topic")!.version);
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(10);
    expect(fake.calls[9].prompt).not.toContain("Citation repair");
    expect(fragmentsIn(fake.calls[9]).map(fragment => fragment.offset)).toEqual([900]);
    expect(database.planning.latest("topic")!.citationRepairAttempted).toBeFalsy();
  });

  it("Q-C: a decision response persists its pending read with the source version and the attempt after the decision serves it at the same offset", async () => {
    const { database, fake, decided, resumed } = await decideThenResume();
    // 이연 읽기가 남은 결정 체크포인트는 닫지 않는다(host-review 39d21df9 F001) — 결정 뒤 같은 체크포인트(같은 admission·조사 회차)가 읽기를 싣는다.
    expect(decided).toMatchObject({ finalized: false, awaitingDecision: true, deferredReads: [{ ...DEFERRED, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    expect(database.planning.latest("topic")).toMatchObject({ id: decided.id, admissionId: decided.admissionId, finalized: true });
    expect(resumed.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(2);
    const served = fragmentsIn(fake.calls[1]);
    expect(served.map(fragment => [fragment.selector, fragment.offset, fragment.hash])).toEqual([["form.swift", DEFERRED.offset, decided.deferredReads![0].hash]]);
    expect(database.planning.latest("topic")!.deferredReads).toBeUndefined();
    expect(database.getTimeline("topic").some(event => event.payload?.deferredReadChanged || event.payload?.deferredReadMissing)).toBe(false);
  });

  it("Q-C: when the source changed before the decision the deferred read restarts at offset 0 and the change is recorded", async () => {
    const { database, fake, decided } = await decideThenResume(repo => writeFileSync(join(repo, "form.swift"), "let step = 42\n".repeat(6000)));
    const served = fragmentsIn(fake.calls[1]);
    expect(served.map(fragment => [fragment.selector, fragment.offset])).toEqual([["form.swift", 0]]);
    expect(served[0].content.startsWith("let step = 42")).toBe(true);
    const from = decided.deferredReads![0].hash;
    expect(served[0].hash).not.toBe(from);
    const change = database.getTimeline("topic").find(event => event.payload?.deferredReadChanged)!;
    expect(change.payload?.deferredReadChanged).toEqual([{ kind: "file", selector: "form.swift", from, to: served[0].hash }]);
  });

  it("Q-C: a deferred read whose source disappeared is recorded as missing and never marked delivered", async () => {
    const { database, fake } = await decideThenResume(repo => rmSync(join(repo, "form.swift")));
    expect(fragmentsIn(fake.calls[1])).toEqual([]);
    const missing = database.getTimeline("topic").find(event => event.payload?.deferredReadMissing)!;
    expect(missing.payload?.deferredReadMissing).toEqual([{ kind: "file", selector: "form.swift", offset: DEFERRED.offset }]);
    const latest = database.planning.latest("topic")!;
    expect(latest.deferredReads).toBeUndefined();
    expect(database.planning.deliveredToSession("planning-session").some(fragment => fragment.selector === "form.swift")).toBe(false);
  });

  it("Q-C with F003: a decision asked while required references are unread keeps the checkpoint open and serves the deferred read after the decision", async () => {
    const { repo, database, git } = setup();
    database.updateTopic("topic", { state: "CLAUDE_REVISION" });
    const required = database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_REVISION", body: korean(6_000) });
    const delivery = planTimelineDelivery([required]);
    const fake = scripted(async (_turn, call) => call === 1
      ? { ...answer(step({ questions: ["확인"], requests: [DEFERRED] })), kind: "REVISION", planEdits: [], requestedUserDecision: "확인해 주세요" }
      : { kind: "REVISION", summary: "개정", findings: [], evidenceRefs: [], planEdits: [], planningStep: step({ questions: [], complete: true }) });
    const adapter = guardedPlanning(fake.adapter, database, git);
    const turn = { cwd: repo, sessionId: "claude-session", timelineDelivery: { prompt: delivery } };
    const first = await adapter.resumeTurn({ ...turn, prompt: "Revise" });
    expect(first.requestedUserDecision).toBe("확인해 주세요");
    const open = database.planning.latest("topic")!;
    expect(open).toMatchObject({ finalized: false, awaitingDecision: true, deferredReads: [{ ...DEFERRED, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }] });
    // 필수 미완독과 이연 읽기가 함께 남아도 한 경로다 — 결정 전 같은 입력의 재개는 저장된 질문을 돌려주고 어느 읽기도 싣지 않는다.
    expect(await adapter.resumeTurn({ ...turn, prompt: "Revise" })).toEqual(first);
    expect(fake.calls).toHaveLength(1);
    database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_REVISION", body: "확인했습니다" });
    const revised = await adapter.resumeTurn({ ...turn, prompt: "Revise with the decision" });
    expect(revised.kind).toBe("REVISION");
    // 결정은 원문 변경 초기화로 단계를 비우지만 이연 읽기는 남아 결정 뒤 첫 호출에 실렸다(같은 체크포인트).
    expect(fragmentsIn(fake.calls[1]).map(fragment => [fragment.selector, fragment.offset])).toContainEqual(["form.swift", DEFERRED.offset]);
    expect(database.planning.latest("topic")).toMatchObject({ id: open.id, finalized: true });
    expect(database.planning.latest("topic")!.deferredReads).toBeUndefined();
  });

  // ---- host-review 39d21df9 F002·F005·F006: 이연 읽기는 실제로 전달·채택되기 전에는 사라지지 않고, 남아 있으면 완료를 막는다 ----
  const decide = (database: ConsensusDatabase) =>
    database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_PLAN", body: "The form owns the step value" });

  it("F002: deferred reads left over by the batch limit demote a completed response until they are served", async () => {
    const { repo, database, git } = setup();
    // 한 조각(8KiB)씩 네 구간 — 24KiB 묶음에 셋만 들어간다.
    const READS = [0, 7_000, 14_000, 21_000].map(offset => ({ kind: "file" as const, selector: "form.swift", question: `Read at ${offset}`, offset }));
    const fake = scripted(async (_turn, n) => {
      if (n === 1) return { ...answer(step({ requests: READS })), requestedUserDecision: "Who owns the step value?" };
      if (n === 2) return answer(step({ questions: [], complete: true, facts: [{ statement: "Unverified", refs: ["not-delivered"] }] }));
      if (n === 3) {
        const checkpoint = database.planning.latest("topic")!;
        expect(checkpoint).toMatchObject({ finalized: false, demotedComplete: { requests: 0, unreadRequired: 0, deferred: 1 }, step: { complete: false } });
        expect(checkpoint.lastResponse?.planningStep?.complete).toBe(true);
        expect(checkpoint.deferredReads!.map(read => read.offset)).toEqual([21_000]);
        // 남은 이연 읽기가 이어질 읽기라, 강등된 완료의 미전달 인용은 거절하지 않고 버린 뒤 다시 쓰게 한다(청한 읽기가 남은 중간 단계와 같다).
        expect(checkpoint.step.facts).toEqual([]);
      }
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git);
    await adapter.resumeTurn({ cwd: repo, prompt: "Plan", sessionId: "planning-session" });
    decide(database);
    const result = await adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" });
    expect(result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(3);
    expect(fragmentsIn(fake.calls[1]).map(fragment => fragment.offset)).toEqual([0, 7_000, 14_000]);
    expect(fragmentsIn(fake.calls[2]).map(fragment => fragment.offset)).toEqual([21_000]);
    const final = database.planning.latest("topic")!;
    expect(final.finalized).toBe(true);
    expect(final.deferredReads).toBeUndefined();
    expect(final.demotedComplete).toBeUndefined();
  });

  // 예산이 강제한 정리(soft limit)에서도 남은 이연 읽기는 완료를 막는다 — 정리 응답의 complete 는 강등되고 명시 정지한다. 예산을 늘린 retry 가 같은 시도에서
  // 남은 이연 읽기부터 싣는다(r3 B 와 같은 뜻). 실행 예산 1,000(호출당 100): 여덟 번 뒤 soft limit, 아홉째가 정리다.
  it("F002: a budget-forced synthesis is not adopted while deferred reads remain and a retry after a grant serves them first", async () => {
    const { repo, database, git } = setup("claude", 1000);
    writeFileSync(join(repo, "form.swift"), "let step = 0\n".repeat(20_000));
    const READS = [0, 7_000, 14_000, 21_000].map(offset => ({ kind: "file" as const, selector: "form.swift", question: `Read at ${offset}`, offset }));
    // 모델이 매 회차 큰 조각 셋을 청해 묶음을 채운다 — 남은 이연 읽기 하나는 정리 전까지 실리지 못한다.
    const rounds = (n: number) => [0, 1, 2].map(i => ({ kind: "file" as const, selector: "form.swift", question: `Round ${n}`,
      offset: 30_000 + ((n - 2) * 3 + i) * 7_000 }));
    const fake = scripted(async (turn, n) => {
      if (n === 1) return { ...answer(step({ requests: READS })), requestedUserDecision: "Who owns the step value?" };
      if (turn.prompt.includes("No more research is available") || n > 9) return answer(step({ questions: [], complete: true }));
      return answer(step({ requests: rounds(n) }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git);
    await adapter.resumeTurn({ cwd: repo, prompt: "Plan", sessionId: "planning-session" });
    decide(database);
    await expect(adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" }))
      .rejects.toThrow("Synthesis did not produce a complete plan");
    expect(fake.calls).toHaveLength(9);
    expect(fake.calls[8].prompt).toContain("No more research is available");
    const paused = database.planning.latest("topic")!;
    expect(paused).toMatchObject({ finalized: false, finalAttempted: true, demotedComplete: { requests: 0, unreadRequired: 0, deferred: 1 } });
    expect(paused.deferredReads!.map(read => read.offset)).toEqual([21_000]);
    database.budgets.grant("topic", "f002-raise", { execution: { inputTokens: 3000, outputTokens: 10000, durationMs: 100000 },
      total: { inputTokens: 300000, outputTokens: 30000, durationMs: 300000 } }, database.budgets.account("topic")!.version);
    const result = await adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" });
    expect(result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(10);
    expect(fragmentsIn(fake.calls[9]).map(fragment => fragment.offset)).toEqual([21_000]);
    expect(database.planning.latest("topic")).toMatchObject({ id: paused.id, finalized: true });
    expect(database.planning.latest("topic")!.deferredReads).toBeUndefined();
  });

  it("F005: a deferred read carried by an interrupted call survives a source change and is revalidated and served again from the start", async () => {
    const { repo, database, git } = setup();
    const fake = scripted(async (turn, n) => {
      if (n === 1) return { ...answer(step({ requests: [DEFERRED] })), requestedUserDecision: "Who owns the step value?" };
      if (n === 2) {
        expect(fragmentsIn(turn).map(fragment => [fragment.selector, fragment.offset])).toEqual([["form.swift", DEFERRED.offset]]);
        throw new Error("connection interrupted");
      }
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git);
    await adapter.resumeTurn({ cwd: repo, prompt: "Plan", sessionId: "planning-session" });
    decide(database);
    await expect(adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" })).rejects.toThrow("interrupted");
    // 실은 조각은 호출이 끊겨 채택되지 않았다 — 이연 읽기는 그대로 남는다.
    const carried = database.planning.latest("topic")!;
    expect(carried.fragments.map(fragment => fragment.offset)).toEqual([DEFERRED.offset]);
    expect(carried.deferredReads).toEqual([{ ...DEFERRED, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    writeFileSync(join(repo, "form.swift"), "let step = 42\n".repeat(6000));
    const result = await adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" });
    expect(result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(3);
    const served = fragmentsIn(fake.calls[2]);
    expect(served.map(fragment => [fragment.selector, fragment.offset])).toEqual([["form.swift", 0]]);
    expect(served[0].content.startsWith("let step = 42")).toBe(true);
    const change = database.getTimeline("topic").find(event => event.payload?.deferredReadChanged)!;
    expect(change.payload?.deferredReadChanged).toEqual([{ kind: "file", selector: "form.swift", from: carried.deferredReads![0].hash, to: served[0].hash }]);
    expect(database.planning.latest("topic")!.deferredReads).toBeUndefined();
  });

  // 결정 뒤 원문 변경 초기화는 열린 질문 표식도 지운다 — 남아 있으면 결정 뒤 호출의 응답이 채택 직전에 끊겼을 때 다음 실행이 그 응답을 "저장된 질문"으로
  // 돌려줘, 채택 검사(인용·강등·읽기 제공) 없이 결과로 내보냈다.
  it("after the decision, a response interrupted before adoption is adopted on the next run instead of being replayed as the stored question", async () => {
    const { repo, database, git } = setup();
    const NEXT = { kind: "file" as const, selector: "form.swift", question: "Read further", offset: 1_000 };
    const fake = scripted(async (_turn, n) => {
      if (n === 1) return { ...answer(step({ requests: [DEFERRED] })), requestedUserDecision: "Who owns the step value?" };
      if (n === 2) return answer(step({ requests: [NEXT] }));
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git);
    await adapter.resumeTurn({ cwd: repo, prompt: "Plan", sessionId: "planning-session" });
    decide(database);
    const save = database.planning.save.bind(database.planning);
    let interrupted = false;
    const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
      save(record);
      if (!interrupted && record.responsePending) { interrupted = true; throw new Error("Interrupted before adopting the response"); }
    });
    await expect(adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" })).rejects.toThrow("Interrupted before adopting");
    saving.mockRestore();
    const pending = database.planning.latest("topic")!;
    expect(pending).toMatchObject({ responsePending: true, finalized: false });
    expect(pending.awaitingDecision).toBeUndefined();
    const result = await adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" });
    expect(result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(3);
    expect(fragmentsIn(fake.calls[2]).map(fragment => fragment.offset)).toEqual([NEXT.offset]);
    expect(database.planning.latest("topic")!.deferredReads).toBeUndefined();
  });

  // F006 의 짝: 재읽기 사유 없는 이연 읽기가 이 세션이 이미 받은 조각이면 다시 싣지 않고 충족으로 지운다 — 남겨 두면 싣지도 채택하지도 못해 완료를 영원히 막는다.
  it("F006: a deferred read of a fragment the session already received is satisfied without resending it", async () => {
    const { repo, database, git } = setup();
    const SAME = { kind: "file" as const, selector: "form.swift", question: "Read again after the decision", offset: 0 };
    const fake = scripted(async (_turn, n) => {
      if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
      if (n === 2) return { ...answer(step({ requests: [SAME] })), requestedUserDecision: "Who owns the step value?" };
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git);
    await adapter.resumeTurn({ cwd: repo, prompt: "Plan", sessionId: "planning-session" });
    expect(database.planning.latest("topic")!.deferredReads).toHaveLength(1);
    decide(database);
    const result = await adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" });
    expect(result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(3);
    expect(fragmentsIn(fake.calls[2])).toEqual([]);
    expect(database.planning.latest("topic")).toMatchObject({ finalized: true });
    expect(database.planning.latest("topic")!.deferredReads).toBeUndefined();
  });

  it("F006: a deferred read with a reread reason is served again after the decision although the session already received it", async () => {
    const { repo, database, git } = setup();
    const REREAD = { kind: "file" as const, selector: "form.swift", question: "Recover the declaration lost to compaction", offset: 0,
      rereadReason: "Compaction lost the declaration" };
    let firstId = "";
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }));
      if (n === 2) {
        firstId = fragmentsIn(turn)[0].id;
        return { ...answer(step({ requests: [REREAD] })), requestedUserDecision: "Who owns the step value?" };
      }
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git);
    await adapter.resumeTurn({ cwd: repo, prompt: "Plan", sessionId: "planning-session" });
    const decided = database.planning.latest("topic")!;
    expect(decided.delivered).toContain(firstId);
    expect(decided.deferredReads).toEqual([{ ...REREAD, hash: expect.stringMatching(/^[a-f0-9]{64}$/) }]);
    decide(database);
    await adapter.resumeTurn({ cwd: repo, prompt: "Plan with decision", sessionId: "planning-session" });
    expect(fake.calls).toHaveLength(3);
    expect(fragmentsIn(fake.calls[2]).map(fragment => fragment.id)).toEqual([firstId]);
    expect(database.planning.latest("topic")!.deferredReads).toBeUndefined();
  });
});

// ---- E3-5 허용 색인에서 위키 추가 검색 ----
// 공개 경계: guardedPlanning(adapter, …, memoryDirectory) — 실제 메모리 디렉터리(라우터·MEMORY.md·역할 폴더)를 만든다. 처음 고른 문서(sourceHash)는
// 지금처럼 고정하고, 색인과 색인 대상 본문은 sourceHash 뒤에 실린다. 대역 모델이 색인을 조각으로 읽고 후보 문서를 kind=memory 로 청한다.
describe("E3-5 허용 색인에서 위키 추가 검색", () => {
  const INDEX = "@allowed-index";
  const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
  const fragmentsIn = (turn: Omit<SessionTurn, "sessionId">) => JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as PlanningFragment[];
  type IndexRow = { path: string; version: string; bytes: number; context: string[] };
  // 색인 문서는 첫 줄이 안내이고 이후 한 줄에 문서 하나(JSON)다. 이 시험의 색인은 한 조각에 다 들어간다.
  const indexRows = (fragment: PlanningFragment) => fragment.content.split("\n").slice(1).map(line => JSON.parse(line) as IndexRow);
  // PlanningReader 의 조각 id 규칙 — 색인의 버전만 알면 대상 문서 조각의 id 를 계산할 수 있다(받지 않고도).
  const idOf = (selector: string, hash: string, offset = 0) => sha(JSON.stringify(["memory", selector, hash, offset]));
  // 한 조각(8KiB)을 넘어 두 구간으로 읽히는 크기. 머리글·길이는 두 판이 같다.
  const ALPHA_V1 = `# alpha\nALPHA_BODY_V1\n${"보조 기록 ".repeat(700)}`;
  const ALPHA_V2 = ALPHA_V1.replace("ALPHA_BODY_V1", "ALPHA_BODY_V2");
  const BETA_V2 = "# beta\nBETA_BODY_V2\n";
  // "Plan" 과제에는 plan-notes.md 만 관련 문서로 뽑힌다(파일명 일치). alpha·beta·역할 문서는 관련도 0 이라 처음 고른 목록 밖이다.
  function wiki() {
    const dir = mkdtempSync(join(tmpdir(), "guarded-wiki-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    mkdirSync(join(dir, "claude-only"));
    mkdirSync(join(dir, "codex-only"));
    const write = (path: string, text: string) => writeFileSync(join(dir, path), text);
    for (const [path, text] of Object.entries({
      "context-router.md": "# 라우터\n- 계획: [계획 노트](plan-notes.md)\n",
      "MEMORY.md": "# 목록\n- 보조: [알파 기록](alpha.md) · [베타 기록](beta.md)\n- 역할: [클로드 절차](claude-only/steps.md) · [코덱스 절차](codex-only/steps.md)\n",
      "plan-notes.md": "# plan notes\nPLAN_NOTES_V1\n",
      "alpha.md": ALPHA_V1,
      "beta.md": "# beta\nBETA_BODY_V1\n",
      "claude-only/steps.md": "# steps\nCLAUDE_ONLY_STEPS\n",
      "codex-only/steps.md": "# steps\nCODEX_ONLY_STEPS\n",
    })) write(path, text);
    return { dir, write };
  }
  const READ_FORM = { kind: "file" as const, selector: "form.swift", question: "Read form", offset: 0 };

  it("finds an additional document through the allowed index, reads it by kind=memory ranges and cites it", async () => {
    const { repo, database, git } = setup();
    const { dir } = wiki();
    let alphaVersion = "", indexFragment: PlanningFragment | undefined;
    const alphaIds: string[] = [];
    const fake = scripted(async (turn, n) => {
      const fragments = fragmentsIn(turn);
      if (n === 1) {
        // 색인은 매니페스트 밖이다 — 안내 한 줄로만 알린다.
        expect(turn.prompt).toContain(`kind=memory selector=${INDEX}`);
        expect(turn.prompt).toContain('"id":"memory:plan-notes.md"');
        expect(turn.prompt).not.toContain('"id":"memory:alpha.md"');
        expect(turn.prompt).not.toContain(`"id":"memory:${INDEX}"`);
        return answer(step({ requests: [{ kind: "memory", selector: INDEX, question: "Which wiki documents exist?", offset: 0 }] }));
      }
      if (n === 2) {
        indexFragment = fragments[0];
        const rows = indexRows(indexFragment);
        expect(rows.map(row => row.path)).toEqual(["plan-notes.md", "alpha.md", "beta.md", "claude-only/steps.md"]);
        expect(rows.find(row => row.path === "alpha.md")).toEqual({ path: "alpha.md", version: sha(ALPHA_V1),
          bytes: Buffer.byteLength(ALPHA_V1), context: ["- 보조: [알파 기록](alpha.md)"] });
        alphaVersion = rows.find(row => row.path === "alpha.md")!.version;
        return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      }
      if (n === 3) {
        expect(fragments).toMatchObject([{ kind: "memory", selector: "alpha.md", offset: 0, hash: alphaVersion }]);
        expect(fragments[0].nextOffset).not.toBeNull();
        alphaIds.push(fragments[0].id);
        return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Continue alpha", offset: fragments[0].nextOffset! }] }));
      }
      expect(fragments).toMatchObject([{ kind: "memory", selector: "alpha.md", hash: alphaVersion, nextOffset: null }]);
      alphaIds.push(fragments[0].id);
      return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha rule", refs: alphaIds }] }));
    });
    const result = await guardedPlanning(fake.adapter, database, git, dir).createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(4);
    const final = database.planning.latest("topic")!;
    expect(final.step.facts).toEqual([{ statement: "Alpha rule", refs: alphaIds }]);
    // 색인 조각은 적지 않고, 대상 문서만 실은 버전으로 적는다.
    expect(final.memoryReads).toEqual({ "alpha.md": sha(ALPHA_V1) });
    // 계보 진척은 원본별이다 — 색인과 대상 문서가 각자의 selector·버전으로 센다.
    expect(database.planning.lineageProgress("topic", ["session-1"])).toEqual({
      [JSON.stringify(["memory", INDEX, indexFragment!.hash])]: Buffer.byteLength(indexFragment!.content),
      [JSON.stringify(["memory", "alpha.md", alphaVersion])]: Buffer.byteLength(ALPHA_V1),
    });
  });

  it("does not treat an index row as a read of the listed document", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    const fake = scripted(async (turn, n) => {
      const fragments = fragmentsIn(turn);
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: INDEX, question: "Find", offset: 0 }] }));
      if (n === 2) {
        // 색인의 버전으로 대상 조각 id 를 계산할 수는 있지만, 받은 적 없는 조각이다.
        const alpha = indexRows(fragments[0]).find(row => row.path === "alpha.md")!;
        return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha says so", refs: [idOf("alpha.md", alpha.version)] }] }));
      }
      if (n === 3) {
        // 색인만 읽은 문서가 바뀌어도 시도를 초기화하지 않는다.
        expect(turn.prompt).not.toContain("Sources changed");
        return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      }
      expect(fragments).toMatchObject([{ selector: "alpha.md", offset: 0, hash: sha(ALPHA_V2) }]);
      expect(fragments[0].content.startsWith("# alpha\nALPHA_BODY_V2")).toBe(true);
      return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha says so", refs: [fragments[0].id] }] }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Checkpoint cites evidence that was not delivered.");
    expect(database.planning.latest("topic")!.memoryReads).toBeUndefined();
    write("alpha.md", ALPHA_V2);
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(4);
    expect(database.planning.latest("topic")!.memoryReads).toEqual({ "alpha.md": sha(ALPHA_V2) });
  });

  it("treats a changed additionally read document like a source change at the next run and does not adopt its old fragment", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    let staleId = "";
    const fake = scripted(async (turn, n) => {
      const fragments = fragmentsIn(turn);
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      if (n === 2) {
        staleId = fragments[0].id;
        return answer(step({ facts: [{ statement: "Alpha v1 rule", refs: [staleId] }], requests: [READ_FORM] }));
      }
      if (n === 3) throw new Error("connection interrupted");
      if (n === 4) {
        expect(turn.prompt).toContain("Sources changed");
        expect(fragments).toEqual([]);
        // 옛 조각을 인용한 사실은 전달 목록에 없어 채택되지 않는다(중간 단계라 버린다).
        return answer(step({ facts: [{ statement: "Alpha v1 rule", refs: [staleId] }],
          requests: [{ kind: "memory", selector: "alpha.md", question: "Reread alpha", offset: 0 }] }));
      }
      expect(database.planning.latest("topic")!.step.facts).toEqual([]);
      // 초기화 뒤 다시 청한 같은 selector·offset 은 지금 버전으로 실린다(조각 캐시가 옛 버전을 돌려주지 않는다).
      expect(fragments).toMatchObject([{ selector: "alpha.md", offset: 0, hash: sha(ALPHA_V2) }]);
      expect(fragments[0].content.startsWith("# alpha\nALPHA_BODY_V2")).toBe(true);
      return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha v2 rule", refs: [fragments[0].id] }] }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
    const before = database.planning.latest("topic")!;
    expect(before.memoryReads).toEqual({ "alpha.md": sha(ALPHA_V1) });
    expect(before.delivered).toContain(staleId);
    write("alpha.md", ALPHA_V2);
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(5);
    const after = database.planning.latest("topic")!;
    expect(after).toMatchObject({ admissionId: before.admissionId, memoryReads: { "alpha.md": sha(ALPHA_V2) } });
    expect(after.delivered).not.toContain(staleId);
  });

  // 버전은 조각을 체크포인트에 실을 때 적는다 — 호출이 끊겨 전달 기록 없이 남은 대기 조각도 다음 실행이 그대로 보내므로, 반환 뒤에만 적으면 바뀐 문서의
  // 옛 판이 그대로 실린다.
  it("does not resend a pending fragment of an additional document that changed after the call carrying it was interrupted", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      if (n === 2) throw new Error("connection interrupted");
      expect(turn.prompt).toContain("Sources changed");
      expect(fragmentsIn(turn)).toEqual([]);
      expect(turn.prompt).not.toContain("ALPHA_BODY_V1");
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
    const pending = database.planning.latest("topic")!;
    expect(pending.fragments.map(fragment => fragment.selector)).toEqual(["alpha.md"]);
    expect(pending.delivered).not.toContain(pending.fragments[0].id);
    expect(pending.memoryReads).toEqual({ "alpha.md": sha(ALPHA_V1) });
    write("alpha.md", ALPHA_V2);
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(3);
  });

  // 본문이 바뀌거나, 본문은 그대로여도 링크가 빠져 허용 목록에서 사라지면 지금 버전이 없다 — 둘 다 적힌 버전과 다르다.
  it.each([
    ["changes", (write: (path: string, text: string) => void) => write("alpha.md", ALPHA_V2)],
    ["loses its link", (write: (path: string, text: string) => void) => write("MEMORY.md", "# 목록\n- 보조: [베타 기록](beta.md)\n")],
  ] as const)("pauses when an additionally read document %s during the run and resets the attempt at the next run", async (_case, mutate) => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    const fake = scripted(async (turn, n) => {
      const fragments = fragmentsIn(turn);
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      if (n === 2) {
        mutate(write); // 모델이 응답하는 사이 위키가 바뀐다.
        return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha v1 rule", refs: [fragments[0].id] }] }));
      }
      expect(turn.prompt).toContain("Sources changed");
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" }))
      .rejects.toThrow("A wiki document read from the allowed index changed during planning.");
    expect(database.planning.latest("topic")).toMatchObject({ finalized: false, responsePending: true, memoryReads: { "alpha.md": sha(ALPHA_V1) } });
    // 보존한 완료 응답은 재생하지 않는다 — 원문 변경으로 초기화하고 다시 판단한다.
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(3);
    expect(database.planning.latest("topic")!.step.facts).toEqual([]);
  });

  it("treats a recorded additional document that is no longer linked like a changed source at the next run", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    let alphaId = "";
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      if (n === 2) {
        alphaId = fragmentsIn(turn)[0].id;
        return answer(step({ facts: [{ statement: "Alpha rule", refs: [alphaId] }], requests: [READ_FORM] }));
      }
      if (n === 3) throw new Error("connection interrupted");
      expect(turn.prompt).toContain("Sources changed");
      return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha rule", refs: [alphaId] }] }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
    // alpha.md 는 디스크에 그대로 두고 링크만 뺀다 — 더는 읽을 수 없는 문서의 옛 조각을 인용하지 못한다.
    write("MEMORY.md", "# 목록\n- 보조: [베타 기록](beta.md)\n");
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Checkpoint cites evidence that was not delivered.");
    expect(fake.calls).toHaveLength(4);
  });

  // 가린 본문이 조각의 본문이고 버전이다 — 색인 API 의 버전과 조각 hash 가 어긋나면 민감값이 있는 문서는 매 실행 "바뀐 문서"로 초기화된다.
  it("serves an additional document with secrets redacted and keeps its version stable across runs", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    write("MEMORY.md", "# 목록\n- 보조: [알파 기록](alpha.md) · [감마 기록](gamma.md)\n");
    write("gamma.md", "# gamma\n검증용 token=do-not-send-this-value\n");
    let gammaId = "", gammaVersion = "";
    const fake = scripted(async (turn, n) => {
      const fragments = fragmentsIn(turn);
      if (n === 1) return answer(step({ requests: [
        { kind: "memory", selector: INDEX, question: "Find", offset: 0 },
        { kind: "memory", selector: "gamma.md", question: "Read gamma", offset: 0 }] }));
      if (n === 2) {
        gammaVersion = indexRows(fragments[0]).find(row => row.path === "gamma.md")!.version;
        expect(fragments[1]).toMatchObject({ selector: "gamma.md", hash: gammaVersion });
        expect(fragments[1].content).toContain("token=[REDACTED]");
        gammaId = fragments[1].id;
        return answer(step({ facts: [{ statement: "Gamma rule", refs: [gammaId] }], requests: [READ_FORM] }));
      }
      if (n === 3) throw new Error("connection interrupted");
      expect(turn.prompt).not.toContain("Sources changed");
      return answer(step({ questions: [], complete: true, facts: [{ statement: "Gamma rule", refs: [gammaId] }] }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
    expect(database.planning.latest("topic")!.memoryReads).toEqual({ "gamma.md": gammaVersion });
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(4);
    expect(fake.calls.some(call => call.prompt.includes("do-not-send-this-value"))).toBe(false);
  });

  it("keeps the attempt when an unrelated wiki document changes and serves the index at its new version", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    let alphaId = "", firstIndexId = "";
    const fake = scripted(async (turn, n) => {
      const fragments = fragmentsIn(turn);
      if (n === 1) return answer(step({ requests: [
        { kind: "memory", selector: INDEX, question: "Find", offset: 0 },
        { kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      if (n === 2) {
        firstIndexId = fragments[0].id; alphaId = fragments[1].id;
        return answer(step({ facts: [{ statement: "Alpha rule", refs: [alphaId] }], requests: [READ_FORM] }));
      }
      if (n === 3) throw new Error("connection interrupted");
      if (n === 4) {
        expect(turn.prompt).not.toContain("Sources changed");
        return answer(step({ facts: [{ statement: "Alpha rule", refs: [alphaId] }],
          requests: [{ kind: "memory", selector: INDEX, question: "Find again", offset: 0 }] }));
      }
      const index = fragments.find(fragment => fragment.selector === INDEX)!;
      expect(index.id).not.toBe(firstIndexId);
      expect(indexRows(index).find(row => row.path === "beta.md")!.version).toBe(sha(BETA_V2));
      return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha rule", refs: [alphaId] }] }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
    write("beta.md", BETA_V2);
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(5);
    const final = database.planning.latest("topic")!;
    expect(final.step.facts).toEqual([{ statement: "Alpha rule", refs: [alphaId] }]);
    expect(final.memoryReads).toEqual({ "alpha.md": sha(ALPHA_V1) });
  });

  it("still resets the attempt when an initially selected document changes, without recording it as an additional read", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: "plan-notes.md", question: "Read notes", offset: 0 }] }));
      if (n === 2) return answer(step({ facts: [{ statement: "Notes", refs: [fragmentsIn(turn)[0].id] }], requests: [READ_FORM] }));
      if (n === 3) throw new Error("connection interrupted");
      expect(turn.prompt).toContain("Sources changed");
      return answer(step({ questions: [], complete: true }));
    });
    const adapter = guardedPlanning(fake.adapter, database, git, dir);
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("interrupted");
    expect(database.planning.latest("topic")!.memoryReads).toBeUndefined();
    write("plan-notes.md", "# plan notes\nPLAN_NOTES_V2\n");
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(4);
  });

  it("never lists or serves documents of the other role's folder", async () => {
    const { repo, database, git } = setup("codex");
    const { dir } = wiki();
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: INDEX, question: "Find", offset: 0 }] }));
      expect(indexRows(fragmentsIn(turn)[0]).map(row => row.path)).toEqual(["plan-notes.md", "alpha.md", "beta.md", "codex-only/steps.md"]);
      return answer(step({ requests: [{ kind: "memory", selector: "claude-only/steps.md", question: "Peek", offset: 0 }] }));
    }, "codex");
    await expect(guardedPlanning(fake.adapter, database, git, dir).createSession({ cwd: repo, prompt: "Plan" }))
      .rejects.toThrow("not in the pinned manifest");
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls.some(call => call.prompt.includes("claude-only/steps.md") || call.prompt.includes("CLAUDE_ONLY_STEPS"))).toBe(false);
  });

  it("records an additional document inherited by a later checkpoint of the same session so its change is still detected", async () => {
    const { repo, database, git } = setup();
    const { dir, write } = wiki();
    let alphaId = "";
    const fake = scripted(async (turn, n) => {
      if (n === 1) return answer(step({ requests: [{ kind: "memory", selector: "alpha.md", question: "Read alpha", offset: 0 }] }));
      if (n === 2) {
        alphaId = fragmentsIn(turn)[0].id;
        return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha rule", refs: [alphaId] }] }));
      }
      // 개정 체크포인트는 같은 세션이 받은 알파 조각을 상속 재검증으로 이어받아 인용한다.
      if (n === 3) return answer(step({ facts: [{ statement: "Alpha rule", refs: [alphaId] }], requests: [READ_FORM] }));
      if (n === 4) throw new Error("connection interrupted");
      expect(turn.prompt).toContain("Sources changed");
      return answer(step({ questions: [], complete: true, facts: [{ statement: "Alpha rule", refs: [alphaId] }] }));
    });
    const wrapped = guardedPlanning(fake.adapter, database, git, dir);
    const first = await wrapped.createSession({ cwd: repo, prompt: "Plan" });
    database.updateTopic("topic", { state: "CLAUDE_REVISION", planSHA256: "a".repeat(64) });
    await expect(wrapped.resumeTurn({ cwd: repo, prompt: "Revise", sessionId: first.sessionId })).rejects.toThrow("interrupted");
    const revision = database.planning.latest("topic")!;
    expect(revision.stage).toBe("CLAUDE_REVISION");
    expect(revision.delivered).toContain(alphaId);
    expect(revision.memoryReads).toEqual({ "alpha.md": sha(ALPHA_V1) });
    write("alpha.md", ALPHA_V2);
    // 상속 재검증은 바뀐 문서의 옛 조각을 전달 목록에서 지우지 않는다 — 기록한 버전이 달라 원문 변경으로 초기화해야 옛 조각을 인용하지 못한다.
    await expect(wrapped.resumeTurn({ cwd: repo, prompt: "Revise", sessionId: first.sessionId }))
      .rejects.toThrow("Checkpoint cites evidence that was not delivered.");
    expect(fake.calls).toHaveLength(5);
  });
});

// ---- E3 후속 리뷰 F008(host-review 39d21df9): 계약 위반으로 무효화한 결정 응답은 재생할 질문이 아니다 ----
// 공개 흐름은 엔진(startPlan·retry) + 실제 guardedPlanning(엔진이 예산·작업 묶음 래퍼로 감싼다)이다. 읽기와 결정 요청을 함께 담은 응답이 과제 계약
// (EngineCore.enforceResultContract — 응답 종류·앞 단계 지적 승계)에 걸리면, 엔진은 같은 체크포인트를 교정 대기(교정 질문을 앞에 둔 미완료)로 되돌리고
// 멈춘다. 결정 대기 표식이 남아 있으면 새 입력 없는 공개 retry 가 교정 호출 대신 거절된 응답을 그대로 재생해 같은 거절을 끝없이 되풀이했다.
// 대표 단계는 두 좌석·두 위반 종류를 하나씩 덮는다: 계획자 CLAUDE_PLAN(잘못된 kind)과 검토자 CODEX_AUDIT(앞 단계 지적 누락). CLAUDE_REVISION·
// CODEX_CLOSEOUT 은 같은 무효화 블록(core.ts 의 한 단계 목록)과 단계를 가리지 않는 재생 분기를 지나고, 단계마다 다른 것은 check 의 기대 kind·승계
// 원본뿐이라 두 대표로 충분하다.
describe("E3 후속 리뷰 F008 계약 위반으로 무효화한 결정 응답", () => {
  const TOLERANCE = '\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';
  const contractPlan = (marker: string) => REQUIRED_PLAN_HEADINGS
    .map(heading => `## ${heading}\n\n${marker} ${heading}${heading === "허용 오차" ? TOLERANCE : ""}`).join("\n\n");
  const DEFERRED = { kind: "file" as const, selector: "form.swift", question: "Read behind the decision", offset: 26 };
  const REPAIR = "Repair the final task contract";
  const fragmentsIn = (turn: Omit<SessionTurn, "sessionId">) => JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as PlanningFragment[];
  // 계획자가 스스로 남긴 미처분 지적 — 감사가 반드시 승계해야 한다(처분이 없어 carryForward 가 대신 싣지 않는다).
  const PLAN_FINDING = { id: "P-1", title: "Step owner", severity: "HIGH" as const, rationale: "Audit must confirm the step owner",
    evidenceRefs: [], requiresUserDecision: false };
  // 연속성 v2 계획 주제 — 계획 좌석은 기존 세션에 붙고, 검토 좌석은 감사가 자기 세션을 만들도록 비워 둘 수 있다.
  function engineTopic(codexSession = "codex-existing") {
    const context = setup();
    context.database.updateTopic("topic", { state: "DRAFT" });
    for (const [role, sessionId] of [["claude", "claude-existing"], ["codex", codexSession]] as const) context.database.upsertParticipant("topic", {
      role, sessionId, mode: "attached", acknowledgedPlanSHA256: null });
    const settle = async () => {
      const deadline = Date.now() + 10_000;
      while (context.database.runningAction("topic")) {
        if (Date.now() > deadline) throw new Error("Workflow did not complete");
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    };
    return { ...context, settle, artifacts: new ArtifactStore(join(context.root, "artifacts"), context.database) };
  }
  // 재작성(계획자)·리뷰(검토자) 예약 — 새 논리 시도(새 admission)를 사면 한쪽이 는다.
  const reservations = (database: ConsensusDatabase) => ({ rewrites: database.revisions.account("topic").used,
    firstPlanUsed: database.revisions.account("topic").firstPlanUsed, reviews: database.reviews.account("topic", "planning").used });
  const stopAudit = () => scripted(async () => { throw new Error("F008_AUDIT_STOP"); }, "codex");

  it.each(["task", "instructions"])("public retry resumes unread oversized %s after a user decision on the same audit attempt", async source => {
    const { repo, database, git, artifacts, settle } = engineTopic("pending:input-queue-audit");
    const body = "Required audit content. ".repeat(5000) + "END_OF_REQUIRED_INPUT";
    if (source === "instructions") writeFileSync(join(repo, "AGENTS.md"), body);
    const plan = contractPlan("INPUT_QUEUE") + (source === "task" ? `\n${body}` : "");
    const claude = scripted(async (_turn, n) => {
      if (n === 1) return { ...answer(step({ questions: [], complete: true })), planMarkdown: plan };
      throw new Error("INPUT_QUEUE_REVISION_STOP");
    });
    const received: PlanningFragment[] = [];
    const codex = scripted(async (turn, n) => {
      received.push(...fragmentsIn(turn));
      return { kind: "AUDIT", summary: "Audit", findings: [], evidenceRefs: [],
        ...(n === 1 ? { requestedUserDecision: "Confirm the audit scope" } : {}),
        planningStep: step({ questions: n === 1 ? ["Confirm scope"] : [], requests: [], complete: n !== 1 }) };
    }, "codex");
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(claude.adapter, database, git),
      codex: guardedPlanning(codex.adapter, database, git) });
    try {
      engine.startPlan("topic"); await settle();
      const open = database.planning.latest("topic", "codex")!;
      expect(open).toMatchObject({ stage: "CODEX_AUDIT", finalized: false, awaitingDecision: true });
      const before = reservations(database);
      await engine.postMessage("topic", "decision", "Keep the current audit scope and read the remaining original text");
      engine.retry("topic"); await settle();
      expect(codex.calls.length).toBeGreaterThan(1);
      expect(received.filter(fragment => source === "task" ? ["request", "request-fresh"].includes(fragment.selector)
        : fragment.selector === "mandatory-instructions").map(fragment => fragment.content).join("").includes(body)).toBe(true);
      expect(database.planning.latest("topic", "codex")).toMatchObject({ id: open.id, admissionId: open.admissionId,
        sessionId: open.sessionId, finalized: true });
      expect(database.reviews.account("topic", "planning").used).toBe(before.reviews);
      expect(database.latestArtifact("topic", "audit")).not.toBeNull();
    } finally { await engine.shutdown(); }
  });

  it("CLAUDE_PLAN: a public retry without new input reaches the repair call for a wrong-kind decision response and adopts it on the same checkpoint and admission", async () => {
    const { database, git, artifacts, settle } = engineTopic();
    const plan = contractPlan("F008_PLAN");
    const claude = scripted(async (turn, call) => {
      if (call === 1) return { ...answer(step({ requests: [DEFERRED] })), kind: "REVISION", planEdits: [], requestedUserDecision: "Who owns the step value?" };
      return { ...answer(step({ questions: [], complete: true })), planMarkdown: plan };
    });
    const codex = stopAudit();
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(claude.adapter, database, git), codex: codex.adapter });
    engine.startPlan("topic"); await settle();
    const rejected = database.planning.latest("topic", "claude")!;
    expect(database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
    expect(rejected).toMatchObject({ stage: "CLAUDE_PLAN", finalized: false });
    expect(rejected.step.questions[0]).toBe(`${REPAIR}: 에이전트 응답 종류가 다릅니다: REVISION (예상 PLAN)`);
    const before = reservations(database);
    expect(before).toMatchObject({ rewrites: 0, firstPlanUsed: true });
    expect(claude.calls).toHaveLength(1);

    // 새 사용자 입력 없이 공개 retry — 저장된(거절된) 질문을 재생하지 않고 교정 질문을 실은 모델 호출에 닿아야 한다.
    engine.retry("topic"); await settle();
    expect(claude.calls).toHaveLength(2);
    expect(claude.calls[1].prompt).toContain(`${REPAIR}: 에이전트 응답 종류가 다릅니다: REVISION (예상 PLAN)`);
    // 결정 대기가 풀려 결정 뒤로 미룬 읽기는 교정 호출에 실린다(이연 읽기는 전달·채택 전에는 사라지지 않는다 — F002·F005).
    expect(fragmentsIn(claude.calls[1]).map(fragment => [fragment.selector, fragment.offset])).toContainEqual(["form.swift", DEFERRED.offset]);
    // 교정 결과는 같은 체크포인트·같은 admission 으로 채택됐고(계획 저장 → 감사 시작), 재작성·리뷰 예약은 늘지 않았다.
    expect(database.planning.latest("topic", "claude")).toMatchObject({ id: rejected.id, admissionId: rejected.admissionId, finalized: true,
      finalResult: { kind: "PLAN", planMarkdown: plan } });
    expect(database.planning.latest("topic", "claude")!.deferredReads).toBeUndefined();
    expect(database.getTopic("topic").planSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(codex.calls).toHaveLength(1);
    expect(reservations(database)).toMatchObject({ rewrites: before.rewrites, firstPlanUsed: true });
    await engine.shutdown();
  });

  it("CODEX_AUDIT: a public retry without new input reaches the repair call for a decision response that omitted a plan finding and adopts it on the same checkpoint and admission", async () => {
    const { database, git, artifacts, settle } = engineTopic("pending:codex-f008");
    const plan = contractPlan("F008_AUDIT");
    const claude = scripted(async () => ({ ...answer(step({ questions: [], complete: true })), planMarkdown: plan, findings: [PLAN_FINDING] }));
    const codex = scripted(async (_turn, call) => call === 1
      ? { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [], requestedUserDecision: "단계 소유자를 정해 주세요",
        planningStep: step({ requests: [DEFERRED] }) }
      : { kind: "AUDIT", summary: "감사 교정", findings: [{ ...PLAN_FINDING, disposition: "AGREED_ACTION" }], evidenceRefs: [],
        requestedUserDecision: "P-1 의 단계 소유자를 정해 주세요", planningStep: step({ questions: [], complete: true }) }, "codex");
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(claude.adapter, database, git),
      codex: guardedPlanning(codex.adapter, database, git) });
    engine.startPlan("topic"); await settle();
    const rejected = database.planning.latest("topic", "codex")!;
    expect(database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
    expect(rejected).toMatchObject({ stage: "CODEX_AUDIT", finalized: false });
    expect(rejected.step.questions[0]).toBe(`${REPAIR}: Codex audit에서 검토 쟁점을 누락했습니다: P-1`);
    const before = reservations(database);
    expect(before.reviews).toBe(1);
    expect(codex.calls).toHaveLength(1);

    engine.retry("topic"); await settle();
    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1].prompt).toContain(`${REPAIR}: Codex audit에서 검토 쟁점을 누락했습니다: P-1`);
    expect(fragmentsIn(codex.calls[1]).map(fragment => [fragment.selector, fragment.offset])).toContainEqual(["form.swift", DEFERRED.offset]);
    // 교정한 감사가 같은 체크포인트·admission 으로 채택돼 저장되고, 교정 결과가 청한 결정으로 멈춘다(다음 턴 없음 — 예약 비교가 이 턴만 본다).
    expect(database.planning.latest("topic", "codex")).toMatchObject({ id: rejected.id, admissionId: rejected.admissionId, finalized: true,
      finalResult: { kind: "AUDIT", findings: [{ id: "P-1" }] } });
    expect(JSON.parse((await artifacts.verifiedLatest("topic", "audit"))!.content).findings).toMatchObject([{ id: "P-1" }]);
    expect(database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
    expect(database.getFlags("topic").resumeState).toBe("CODEX_AUDIT");
    expect(reservations(database)).toEqual(before);
    expect(claude.calls).toHaveLength(1);
    await engine.shutdown();
  });

  // 대조(B 의 N06 계약): 계약을 지킨 결정 응답은 같은 입력의 retry 에 모델을 다시 부르지 않고 저장된 질문을 재생한다.
  it("control: a contract-valid decision response still replays its question on a public retry without new input", async () => {
    const { database, git, artifacts, settle } = engineTopic();
    const claude = scripted(async () => ({ ...answer(step({ requests: [DEFERRED] })), requestedUserDecision: "Who owns the step value?" }));
    const engine = new WorkflowEngine({ database, git, artifacts, claude: guardedPlanning(claude.adapter, database, git), codex: stopAudit().adapter });
    engine.startPlan("topic"); await settle();
    const open = database.planning.latest("topic", "claude")!;
    expect(database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
    expect(open).toMatchObject({ finalized: false, awaitingDecision: true });
    expect(open.step.questions.some(question => question.startsWith(REPAIR))).toBe(false);
    engine.retry("topic"); await settle();
    expect(claude.calls).toHaveLength(1);
    expect(database.getTopic("topic").state).toBe("USER_DECISION_REQUIRED");
    expect(database.planning.latest("topic", "claude")).toMatchObject({ id: open.id, admissionId: open.admissionId, finalized: false, awaitingDecision: true });
    await engine.shutdown();
  });
});

// E5 격리 파일럿(s2a 51b22146) — 예산이 강제한 정리(soft limit)가 완료 결과 없이 사용자 결정만 청한 응답. 정리 모드는 조사를 막아 모델이 필요한 읽기를
// requests 가 아니라 결정 문장·questions 로 남긴다. 이 응답도 "정리가 완료 결과를 내지 못한" 경우다(docs/guarded-planning.md 중단과 재개) — 체크포인트를
// 닫지 않고 열린 결정(synthesisIncomplete)으로 두어, 결정 뒤 예산이 그대로면 모델을 부르지 않고 예산 정지, 증액하면 같은 시도(같은 admission·조사 회차)에서
// 잇는다. 닫으면 공개 retry 가 계획은 새 epoch·재작성으로, 감사·종결은 개정으로 내려가 같은 조사 시도를 잃었다(공개 경로는 tests/rework/e5-budget-forced-decision).
describe("E5 budget-forced synthesis that only asks a user decision", () => {
  const fragmentsIn = (turn: Omit<SessionTurn, "sessionId">) => JSON.parse(turn.prompt.split("Fragments: ").at(-1)!) as PlanningFragment[];
  const QUESTION = "Appendix A is still unread; open more research budget to read it";
  const BUDGET_STOP = "Planning checkpoint saved; insufficient remaining budget for synthesis.";
  const LATER_READ = { kind: "file" as const, selector: "form.swift", question: "Appendix", offset: 900 };
  const research = (n: number) => answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Continue", offset: (n - 1) * 100 }] }));
  // 실행 예산 1,000(호출당 100): 여덟 번 뒤 soft limit, 아홉째가 예산이 강제한 정리다. `ninth` 가 정리 응답이다.
  const forced = (ninth: () => AgentResult) => scripted(async (_turn, n) => n <= 8 ? research(n)
    : n === 9 ? ninth()
    : n === 10 ? answer(step({ requests: [LATER_READ] }))
    : answer(step({ questions: [], complete: true })));
  const decisionOnly = (): AgentResult => ({ ...answer(step({ questions: ["Appendix A unread (BLOCKER)"] })), requestedUserDecision: QUESTION });
  const grant = (database: ConsensusDatabase, key: string) => database.budgets.grant("topic", key, {
    execution: { inputTokens: 3000, outputTokens: 10000, durationMs: 100000 },
    total: { inputTokens: 300000, outputTokens: 30000, durationMs: 300000 } }, database.budgets.account("topic")!.version);

  it("keeps the attempt open: the question replays without a call, the decision stops on budget and a grant continues the same attempt", async () => {
    const { repo, database, git } = setup("claude", 1000);
    const fake = forced(decisionOnly);
    const adapter = guardedPlanning(fake.adapter, database, git);
    const first = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(fake.calls).toHaveLength(9);
    expect(fake.calls[8].prompt).toContain("No more research is available");
    expect(first.result.requestedUserDecision).toBe(QUESTION);
    const open = database.planning.latest("topic")!;
    expect(open).toMatchObject({ finalized: false, finalAttempted: true, awaitingDecision: true, synthesisIncomplete: true, round: 9 });
    expect(open.finalResult).toBeUndefined();
    // 새 입력 없는 재개는 저장된 질문을 그대로 돌려준다 — 모델 호출 없음.
    expect((await adapter.createSession({ cwd: repo, prompt: "Plan" })).result.requestedUserDecision).toBe(QUESTION);
    expect(fake.calls).toHaveLength(9);
    // 결정 뒤에도 예산이 그대로면 정리를 다시 사지 않고 예산 정지다(같은 시도).
    database.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CLAUDE_PLAN", body: "Read the appendix" });
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow(BUDGET_STOP);
    expect(fake.calls).toHaveLength(9);
    expect(database.planning.latest("topic")).toMatchObject({ id: open.id, admissionId: open.admissionId, round: 9, finalized: false });
    // 증액하면 같은 시도가 조사를 잇는다 — 정리 프롬프트가 아니고, 청한 읽기가 다음 호출에 실린다.
    grant(database, "e5-raise-after-forced-decision");
    const result = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    expect(result.result.planMarkdown).toBe("Final navigation plan");
    expect(fake.calls).toHaveLength(11);
    expect(fake.calls[9].prompt).not.toContain("No more research is available");
    expect(fragmentsIn(fake.calls[10]).map(fragment => fragment.offset)).toEqual([LATER_READ.offset]);
    const adopted = database.planning.latest("topic")!;
    expect(adopted).toMatchObject({ id: open.id, admissionId: open.admissionId, round: 11, finalized: true });
    expect(adopted.synthesisIncomplete).toBeUndefined();
  });

  // 응답을 저장한 뒤 채택 전에 끊긴 재생도 같은 판정이다 — 그 응답이 정리 호출에서 왔다는 사실을 응답과 함께 저장해, 재생 채택이 닫지 않는다.
  it("replays a saved forced-synthesis decision after an interruption as the same open question without another call", async () => {
    const { repo, database, git } = setup("claude", 1000);
    const fake = forced(decisionOnly);
    const adapter = guardedPlanning(fake.adapter, database, git);
    const save = database.planning.save.bind(database.planning);
    let interrupted = false;
    const saving = vi.spyOn(database.planning, "save").mockImplementation(record => {
      save(record);
      if (!interrupted && record.responsePending && record.lastResponse?.requestedUserDecision) {
        interrupted = true;
        throw new Error("Interrupted before adopting the synthesis response");
      }
    });
    await expect(adapter.createSession({ cwd: repo, prompt: "Plan" })).rejects.toThrow("Interrupted before adopting");
    expect(fake.calls).toHaveLength(9);
    expect(database.planning.latest("topic")).toMatchObject({ responsePending: true, finalized: false });
    const replayed = await adapter.createSession({ cwd: repo, prompt: "Plan" });
    saving.mockRestore();
    expect(replayed.result.requestedUserDecision).toBe(QUESTION);
    expect(fake.calls).toHaveLength(9);
    expect(database.planning.latest("topic")).toMatchObject({ finalized: false, awaitingDecision: true, synthesisIncomplete: true, responsePending: false });
  });

  // 대조군 — 정리가 완료 결과를 내면서 결정도 청하면 완료 결과다(저장 본문 재사용 경로). 정리 밖의 일반 결정 요청(읽기 없음)은 종전대로 최종 결과로
  // 닫힌다 — 이번 보완은 예산이 강제한 정리의 미완료 결정에만 적용된다.
  it("keeps a complete forced-synthesis result with a decision and an ordinary decision without reads as final results", async () => {
    const complete = setup("claude", 1000);
    const withPlan = forced(() => ({ ...answer(step({ questions: [], complete: true })), requestedUserDecision: QUESTION }));
    const planned = await guardedPlanning(withPlan.adapter, complete.database, complete.git).createSession({ cwd: complete.repo, prompt: "Plan" });
    expect(planned.result).toMatchObject({ planMarkdown: "Final navigation plan", requestedUserDecision: QUESTION });
    expect(complete.database.planning.latest("topic")).toMatchObject({ finalized: true, finalAttempted: true });
    expect(complete.database.planning.latest("topic")!.synthesisIncomplete).toBeUndefined();

    const ordinary = setup();
    const asked = scripted(async () => decisionOnly());
    const first = await guardedPlanning(asked.adapter, ordinary.database, ordinary.git).createSession({ cwd: ordinary.repo, prompt: "Plan" });
    expect(first.result.requestedUserDecision).toBe(QUESTION);
    expect(asked.calls).toHaveLength(1);
    expect(ordinary.database.planning.latest("topic")).toMatchObject({ finalized: true, finalAttempted: false });
    expect(ordinary.database.planning.latest("topic")!.awaitingDecision).toBeUndefined();
    expect(ordinary.database.planning.latest("topic")!.synthesisIncomplete).toBeUndefined();
  });
});

it("cancels a blocked preparation read before model spawn and closes the same budget execution", async () => {
  const { repo, database, git } = setup("codex");
  execFileSync("mkfifo", [join(repo, "AGENTS.md")]);
  const fake = scripted(async () => answer(step({ questions: [], complete: true })), "codex");
  const wrapped = new BudgetController(database.budgets, () => ({ topicId: "topic", accounts: ["topic"], stage: "CODEX_AUDIT" }),
    async () => {}, database.revisions, true, database.reviews, database).wrap(guardedPlanning(fake.adapter, database, git));
  await expect(wrapped.createSession({ cwd: repo, prompt: "Resume audit", signal: AbortSignal.timeout(300) }))
    .rejects.toMatchObject({ name: "TimeoutError" });
  expect(fake.calls).toHaveLength(0);
  expect(database.planning.latest("topic")?.started).toBe(false);
  expect(database.planning.latest("topic")?.finalized).toBe(false);
  expect(() => database.budgets.assertAvailable(["topic"])).not.toThrow();
});


it("preserves each internal Codex comparison through guarded planning into execution_usage", async () => {
  const { repo, database, git } = setup("codex");
  const fake = scripted(async (turn, n) => {
    const comparison = { status: "mismatch" as const, cli: { inputTokens: 1000 + n, outputTokens: 200 + n },
      codexHome: { inputTokens: 100, outputTokens: 20 } };
    // Repeated final observation for one call must replace its source record, not append another.
    for (let i = 0; i < 2; i++) turn.onUsage?.({ executionId: `inner-${n}`, inputTokens: 100, outputTokens: 20,
      recordKind: "final", sourceUsage: comparison });
    return n === 1 ? answer(step({ requests: [{ kind: "file", selector: "form.swift", question: "Read", offset: 0 }] }))
      : answer(step({ questions: [], complete: true }));
  }, "codex");
  await guardedPlanning(fake.adapter, database, git).createSession({ cwd: repo, prompt: "Plan",
    onUsage: usage => database.saveExecutionUsage("topic", 1, "codex", "turn", { ...usage, executionId: "outer" }) });
  const saved = database.getExecutionUsage("topic")[0].usage;
  expect(saved).toMatchObject({ recordKind: "final", inputTokens: 200, outputTokens: 40, sourceUsage: { status: "mismatch",
    turns: [
      { executionId: "inner-1", sessionId: "session-1", sourceUsage: { cli: { inputTokens: 1001, outputTokens: 201 }, codexHome: { inputTokens: 100, outputTokens: 20 } } },
      { executionId: "inner-2", sessionId: "session-1", sourceUsage: { cli: { inputTokens: 1002, outputTokens: 202 }, codexHome: { inputTokens: 100, outputTokens: 20 } } },
    ] } });
});
