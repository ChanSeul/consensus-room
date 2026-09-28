import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { BudgetLedger } from "../src/server/budgetLedger";
import { BudgetController } from "../src/server/budgetController";
import type { AgentAdapter, SessionTurn } from "../src/server/types";

// Public ledger/controller boundaries: absence of a cost ceiling must not stop useful work.
// Explicit shared limits, accounting, dispatch ownership, cancellation and review budgets remain independent.
const bounded = { execution: { inputTokens: 100, outputTokens: 20, durationMs: 10000 },
  total: { inputTokens: 200, outputTokens: 40, durationMs: 30000 } };
const start = (id: string, accounts = ["topic"]) => ({ id, accounts, startedAt: 0,
  stage: "IMPLEMENTING", role: "claude", model: "opus", effort: "xhigh", dispatchStarted: true });

it("records unconfigured work without manufacturing a ceiling and retains usage across executions", () => {
  const db = new DatabaseSync(":memory:"), ledger = new BudgetLedger(db);
  expect(() => ledger.assertAvailable(["topic"])).not.toThrow();
  ledger.start(start("one"));
  ledger.observe("one", { inputTokens: 12_000_000, outputTokens: 260_000, durationMs: 3_000_000 }, 1);
  expect(() => ledger.start(start("overlap"))).toThrow("집계");
  ledger.observe("one", {}, 2, true);
  ledger.start(start("two")); ledger.observe("two", { inputTokens: 40_000_000 }, 3, true);
  expect(ledger.account("topic")).toMatchObject({ policy: { mode: "observe" }, pause: null,
    used: { inputTokens: 52_000_000, outputTokens: 260_000, durationMs: 3_000_000 } });
  expect(ledger.execution("one").used.inputTokens).toBe(12_000_000);
  expect(() => new BudgetLedger(db).assertAvailable(["topic"])).not.toThrow(); db.close();
});

it("an explicit shared ceiling still stops an otherwise unbounded topic", () => {
  const db = new DatabaseSync(":memory:"), ledger = new BudgetLedger(db);
  ledger.configure("group", bounded, "user-explicit", 0);
  ledger.start(start("one", ["topic", "group"])); ledger.observe("one", { inputTokens: 100 }, 1, true);
  expect(ledger.account("topic")!.pause).toBeNull();
  expect(ledger.account("group")!.pause?.executionId).toBe("one");
  expect(() => ledger.assertAvailable(["topic", "group"])).toThrow(); db.close();
});

it("does not confuse a lost accounting record with a new unbounded task", () => {
  const db = new DatabaseSync(":memory:"), ledger = new BudgetLedger(db);
  ledger.start(start("one")); ledger.observe("one", { inputTokens: 123 }, 1, true);
  db.prepare("DELETE FROM budget_accounts WHERE id=?").run("topic");
  expect(() => ledger.assertAvailable(["topic"])).toThrow("복구");
  expect(() => ledger.assertNotExhausted(["topic"])).toThrow("복구");
  expect(() => ledger.start(start("two"))).toThrow("복구");
  expect(() => ledger.configure("topic", { mode: "observe" }, "user-explicit")).toThrow("복구");
  expect(() => ledger.configure("topic", bounded, "user-explicit")).toThrow("복구");
  expect(ledger.account("topic")).toBeNull();
  expect(ledger.execution("one").used.inputTokens).toBe(123); db.close();
});

it("acknowledges interrupted unbounded accounting without imposing a ceiling or losing usage", () => {
  const db = new DatabaseSync(":memory:"), ledger = new BudgetLedger(db);
  ledger.start(start("interrupted")); ledger.observe("interrupted", { inputTokens: 123, outputTokens: 7 }, 1);
  ledger.recoverInterruptedExecutions();
  const before = ledger.execution("interrupted");
  expect(() => ledger.assertAvailable(["topic"])).toThrow("집계");
  expect(() => ledger.grant("topic", "stale", { mode: "observe" }, 2)).toThrow("변경");
  ledger.grant("topic", "acknowledge", { mode: "observe" }, 1);
  expect(ledger.execution("interrupted")).toEqual({ ...before, finished: true });
  expect(ledger.account("topic")).toMatchObject({ policy: { mode: "observe" }, version: 2,
    used: { inputTokens: 123, outputTokens: 7 }, startedAt: 0, pause: null });
  ledger.grant("topic", "acknowledge", { mode: "observe" }, 1);
  expect(ledger.account("topic")!.version).toBe(2);
  expect(() => ledger.grant("topic", "no-interruption", { mode: "observe" }, 2)).toThrow();
  ledger.start(start("next")); ledger.observe("next", { inputTokens: 10 }, 2, true);
  expect(ledger.account("topic")!.used.inputTokens).toBe(133); db.close();
});

it("refuses fresh configuration when only prior policy-change history remains", () => {
  const db = new DatabaseSync(":memory:"), ledger = new BudgetLedger(db);
  ledger.configure("topic", bounded, "user-explicit");
  ledger.grant("topic", "remove-cap", { mode: "observe" }, 1);
  const history = db.prepare("SELECT * FROM budget_grants").all();
  db.prepare("DELETE FROM budget_accounts WHERE id=?").run("topic");
  expect(() => ledger.configure("topic", { mode: "observe" }, "user-explicit")).toThrow("복구");
  expect(ledger.account("topic")).toBeNull();
  expect(db.prepare("SELECT * FROM budget_grants").all()).toEqual(history); db.close();
});

it("removing an explicit ceiling requires a versioned policy request and never refunds usage", () => {
  const db = new DatabaseSync(":memory:"), ledger = new BudgetLedger(db);
  ledger.configure("topic", bounded, "user-explicit", 0);
  ledger.start(start("one")); ledger.observe("one", { inputTokens: 100 }, 1, true);
  const execution = ledger.execution("one");
  expect(() => ledger.grant("topic", "stale", { mode: "observe" }, 2)).toThrow("변경");
  ledger.grant("topic", "remove-cap", { mode: "observe" }, 1);
  ledger.grant("topic", "remove-cap", { mode: "observe" }, 1);
  expect(ledger.account("topic")).toMatchObject({ policy: { mode: "observe" }, used: { inputTokens: 100 }, version: 2, pause: null });
  expect(ledger.execution("one")).toEqual(execution);
  expect(() => ledger.grant("topic", "remove-cap", bounded, 2)).toThrow("같은 요청 키");
  expect(() => ledger.grant("topic", "cap-below-used", { ...bounded, total: { ...bounded.total, inputTokens: 90 } }, 2)).toThrow();
  ledger.grant("topic", "set-cap", bounded, 2);
  expect(ledger.account("topic")!.used.inputTokens).toBe(100); db.close();
});

it("does not send an invented compaction allowance to the unchanged native session", async () => {
  const db = new DatabaseSync(":memory:"), ledger = new BudgetLedger(db);
  const received: SessionTurn[] = [];
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: async () => { throw Error("must resume"); }, resumeTurn: async turn => {
      received.push(turn); turn.admitSync?.(); turn.onUsage?.({ inputTokens: 12_000_000 });
      return { kind: "IMPLEMENTATION", status: "in_progress", remainingSteps: ["next coherent unit"], summary: "saved", findings: [], evidenceRefs: [] };
    } };
  const wrapped = new BudgetController(ledger, () => ({ topicId: "topic", accounts: ["topic"], stage: "IMPLEMENTING" }), async () => {}).wrap(adapter);
  await wrapped.resumeTurn({ sessionId: "original", cwd: "/tmp", prompt: "approved work", job: { role: "implementer", operation: "implement" },
    settings: { model: "opus", effort: "xhigh" }, providerOptions: { ultracode: true } });
  expect(received[0].executionBudget).toBeUndefined();
  expect(received[0]).toMatchObject({ sessionId: "original", settings: { model: "opus", effort: "xhigh" }, providerOptions: { ultracode: true } });
  expect(ledger.account("topic")).toMatchObject({ used: { inputTokens: 12_000_000 }, pause: null }); db.close();
});
