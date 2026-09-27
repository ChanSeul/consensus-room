import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { codexUsageEvidence } from "../src/server/adapters/codexUsageEvidence";
import { reconcileCodexPlanningUsage } from "../src/server/codexUsageReconciliation";
import type { PlanningCheckpoint } from "../src/shared/planningControl";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function transcript() {
  const raw = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
  const event = (at: number, type: string, payload: object) => ({ timestamp: new Date(at).toISOString(), type, payload });
  return [
    { type: "session_meta", payload: { id: "thread-test" } },
    event(1100, "event_msg", { type: "task_started", turn_id: "turn-1" }),
    event(1400, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-1", response_id: "r1",
      usage: raw(10, 5, 2), turn_token_usage: raw(10, 5, 2), thread_token_usage: raw(110, 55, 12) }),
    event(1500, "event_msg", { type: "task_complete", turn_id: "turn-1" }),
    event(2100, "event_msg", { type: "task_started", turn_id: "turn-2" }),
    event(2400, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-2", response_id: "r2",
      usage: raw(20, 10, 3), turn_token_usage: raw(20, 10, 3), thread_token_usage: raw(130, 65, 15) }),
    event(2500, "event_msg", { type: "task_complete", turn_id: "turn-2" }),
  ];
}
const encode = (events: unknown[]) => events.map(e => JSON.stringify(e)).join("\n");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "codex-usage-reconcile-")); dirs.push(root);
  const databasePath = join(root, "room.sqlite"), codexHome = join(root, "home"), transcriptPath = join(codexHome, "sessions/thread-test.jsonl");
  mkdirSync(join(codexHome, "sessions"), { recursive: true }); writeFileSync(transcriptPath, encode(transcript()));
  const database = new ConsensusDatabase(databasePath);
  database.createTopic({ id: "topic", slug: "usage", title: "Usage", repositoryPath: root, baseRef: "main", worktreePath: root,
    branchPrefix: "test", requestedBranchName: null, predecessorTopicId: null, branchName: null, state: "USER_DECISION_REQUIRED",
    scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(), lastError: null });
  const policy = { execution: { inputTokens: 10_000, outputTokens: 1000, durationMs: 10_000 },
    total: { inputTokens: 100_000, outputTokens: 10_000, durationMs: 100_000 } };
  database.budgets.configure("topic", policy, "user-explicit", 0);
  database.budgets.start({ id: "execution", accounts: ["topic"], stage: "CODEX_AUDIT", role: "codex", model: "test", effort: "xhigh", startedAt: 1000, dispatchStarted: true });
  const wrong = { inputTokens: 240, cachedInputTokens: 120, outputTokens: 27 };
  database.budgets.observe("execution", { ...wrong, durationMs: 2000 }, 3000, true);
  database.saveExecutionUsage("topic", 1, "codex", "turn", { executionId: "execution", ...wrong,
    durationMs: 2000, internalRequests: 2, recordKind: "final", completeness: "complete" });
  database.planning.save({ key: "checkpoint", id: "checkpoint-id", topicId: "topic", sessionId: "thread-test", role: "codex", stage: "CODEX_AUDIT",
    scopeGeneration: 1, planEpoch: 1, planSHA256: null, stopped: "Planning checkpoint saved; insufficient remaining budget for synthesis.",
    usage: { ...wrong, durationMs: 2100 }, peakStep: { inputTokens: 130, cachedInputTokens: 65, outputTokens: 15, durationMs: 600 },
    metrics: { internalRequests: 2 }, updatedAt: new Date(3000).toISOString(), admissionId: "same-admission", round: 2, delivered: ["keep-receipt"] } as unknown as PlanningCheckpoint);
  database.close();
  return { databasePath, codexHome, transcriptPath, executionId: "execution", policy };
}

it("reconciles only proved overcount, preserves policy/duration/receipts, and atomically records an idempotent repair", () => {
  const f = fixture(), preview = reconcileCodexPlanningUsage(f);
  expect(preview.applied).toBe(false);
  expect(preview.proof.usage).toEqual({ inputTokens: 30, cachedInputTokens: 15, outputTokens: 5 });
  const applied = reconcileCodexPlanningUsage({ ...f, expectedHash: preview.hash });
  expect(applied.applied).toBe(true);
  const db = new ConsensusDatabase(f.databasePath);
  expect(db.budgets.account("topic")).toMatchObject({ policy: f.policy, version: 1, pause: null,
    used: { inputTokens: 30, outputTokens: 5, durationMs: 2000 } });
  expect(db.budgets.execution("execution").used).toEqual({ inputTokens: 30, outputTokens: 5, durationMs: 2000 });
  expect(db.planning.latest("topic")).toMatchObject({ sessionId: "thread-test", admissionId: "same-admission", round: 2,
    delivered: ["keep-receipt"], usage: { inputTokens: 30, outputTokens: 5, durationMs: 2100 },
    peakStep: { inputTokens: 20, outputTokens: 3, durationMs: 600 } });
  db.close();
  const again = reconcileCodexPlanningUsage({ ...f, expectedHash: preview.hash });
  expect(again.reused).toBe(true);
  expect(again.before.execution.used.inputTokens).toBe(240);
  expect(() => reconcileCodexPlanningUsage({ ...f, expectedHash: "wrong" })).toThrow("different correction hash");
});

it("rejects changed previews without partial writes", () => {
  const f = fixture(), preview = reconcileCodexPlanningUsage(f);
  const db = new ConsensusDatabase(f.databasePath);
  const cp = db.planning.latest("topic")!; cp.updatedAt = new Date(4000).toISOString(); db.planning.save(cp); db.close();
  expect(() => reconcileCodexPlanningUsage({ ...f, expectedHash: preview.hash })).toThrow("preview changed");
  const raw = new DatabaseSync(f.databasePath);
  expect(JSON.parse(String(raw.prepare("SELECT record_json FROM budget_accounts").get()!.record_json)).used.inputTokens).toBe(240);
  expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='codex_usage_reconciliations'").get()).toBeUndefined(); raw.close();
});

it.each(["missing completion", "missing request", "foreign thread", "contradictory duplicate", "unfinished turn", "out of window"])("does not normalize %s evidence", condition => {
  const rows = transcript();
  if (condition === "missing completion") rows.splice(3, 1);
  if (condition === "missing request") rows.splice(2, 1);
  if (condition === "foreign thread") (rows[2].payload as Record<string, unknown>).thread_id = "another";
  if (condition === "contradictory duplicate") rows.splice(3, 0, { ...rows[2], payload: { ...rows[2].payload, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 } } } as never);
  if (condition === "unfinished turn") rows.pop();
  expect(codexUsageEvidence(encode(rows), "thread-test", condition === "out of window" ? 1200 : 1000, 3000)).toBeNull();
});

it("deduplicates identical request records and refuses a missing ledger source", () => {
  const rows = transcript(); rows.splice(3, 0, rows[2]);
  expect(codexUsageEvidence(encode(rows), "thread-test", 1000, 3000)?.usage.inputTokens).toBe(30);
  const f = fixture(); writeFileSync(f.transcriptPath, readFileSync(f.transcriptPath, "utf8").replaceAll('"thread-test"', '"foreign"'));
  expect(() => reconcileCodexPlanningUsage(f)).toThrow("provider request evidence");
});

it("rolls every counter and receipt back if the checkpoint write fails", () => {
  const f = fixture(), preview = reconcileCodexPlanningUsage(f);
  const raw = new DatabaseSync(f.databasePath);
  raw.exec("CREATE TRIGGER reject_correction BEFORE UPDATE ON planning_checkpoints BEGIN SELECT RAISE(ABORT,'checkpoint unavailable'); END");
  expect(() => reconcileCodexPlanningUsage({ ...f, expectedHash: preview.hash })).toThrow("checkpoint unavailable");
  expect(JSON.parse(String(raw.prepare("SELECT record_json FROM budget_accounts").get()!.record_json)).used.inputTokens).toBe(240);
  expect(JSON.parse(String(raw.prepare("SELECT record_json FROM budget_executions").get()!.record_json)).used.inputTokens).toBe(240);
  expect(JSON.parse(String(raw.prepare("SELECT usage_json FROM execution_usage").get()!.usage_json)).inputTokens).toBe(240);
  expect(raw.prepare("SELECT 1 FROM sqlite_master WHERE name='codex_usage_reconciliations'").get()).toBeUndefined();
  raw.close();
});

it.each(["negative", "missing", "fraction"])("rejects %s request counters without treating them as zero", value => {
  const rows = transcript(), p = rows[2].payload as { usage: { input_tokens?: number } };
  if (value === "missing") delete p.usage.input_tokens;
  else p.usage.input_tokens = value === "negative" ? -1 : 1.5;
  expect(codexUsageEvidence(encode(rows), "thread-test", 1000, 3000)).toBeNull();
});


it.each([130, 1030, 120])("checks a constant session baseline within the first multi-request turn (%s)", sessionInput => {
  const rows = transcript().slice(0, 4);
  rows.splice(3, 0, { timestamp: new Date(1450).toISOString(), type: "token_usage_record", payload: {
    thread_id: "thread-test", turn_id: "turn-1", response_id: "r1-second",
    usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3 },
    turn_token_usage: { input_tokens: 30, cached_input_tokens: 15, output_tokens: 5 },
    thread_token_usage: { input_tokens: sessionInput, cached_input_tokens: 65, output_tokens: 15 },
  } } as never);
  const evidence = codexUsageEvidence(encode(rows), "thread-test", 1000, 2000);
  if (sessionInput === 130) expect(evidence?.usage).toEqual({ inputTokens: 30, cachedInputTokens: 15, outputTokens: 5 });
  else expect(evidence).toBeNull();
});
