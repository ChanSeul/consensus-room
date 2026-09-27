import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { codexUsageEvidence } from "../src/server/adapters/codexUsageEvidence";
import { reconcileCodexPlanningUsage } from "../src/server/codexUsageReconciliation";
import { ExecutionMetrics } from "../src/server/adapters/executionMetrics";
import type { PlanningCheckpoint } from "../src/shared/planningControl";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function transcript() {
  const raw = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
  const event = (at: number, type: string, payload: object) => ({ timestamp: new Date(at).toISOString(), type, payload });
  return [
    { type: "session_meta", payload: { id: "thread-test" } },
    event(900, "event_msg", { type: "token_count", info: { total_token_usage: raw(100, 50, 10), last_token_usage: raw(10, 5, 2) } }),
    event(1100, "event_msg", { type: "task_started", turn_id: "turn-1" }),
    event(1400, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-1", response_id: "r1",
      usage: raw(10, 5, 2), turn_token_usage: raw(10, 5, 2), thread_token_usage: raw(110, 55, 12) }),
    event(1440, "event_msg", { type: "token_count", info: { total_token_usage: raw(110, 55, 12), last_token_usage: raw(10, 5, 2) } }),
    event(1500, "event_msg", { type: "task_complete", turn_id: "turn-1" }),
    event(2100, "event_msg", { type: "task_started", turn_id: "turn-2" }),
    event(2400, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-2", response_id: "r2",
      usage: raw(20, 10, 3), turn_token_usage: raw(20, 10, 3), thread_token_usage: raw(130, 65, 15) }),
    event(2440, "event_msg", { type: "token_count", info: { total_token_usage: raw(130, 65, 15), last_token_usage: raw(20, 10, 3) } }),
    event(2500, "event_msg", { type: "task_complete", turn_id: "turn-2" }),
  ];
}
const encode = (events: unknown[]) => events.map(e => JSON.stringify(e)).join("\n");
function fixture(mixed = false) {
  const root = mkdtempSync(join(tmpdir(), "codex-usage-reconcile-")); dirs.push(root);
  const databasePath = join(root, "room.sqlite"), codexHome = join(root, "home"), transcriptPath = join(codexHome, "sessions/thread-test.jsonl");
  mkdirSync(join(codexHome, "sessions"), { recursive: true });
  const rows = mixed ? compactedTranscript() : transcript();
  writeFileSync(transcriptPath, encode(rows));
  const turns = codexUsageEvidence(encode(rows), "thread-test", 1000, 3000)!.turns.map((turn, i) => ({
    executionId: `inner-${i}`, sessionId: "thread-test", round: i + 1, sourceUsage: { status: "mismatch" as const,
      cli: { ...turn.cliReported, internalRequests: 1 }, codexHome: { ...turn.usage, turnEvidence: {
        usage: turn.usage, reported: turn.reported, lastThread: turn.reported, turnCount: 1, requestIds: turn.requestIds,
      } } } }));
  const database = new ConsensusDatabase(databasePath);
  database.createTopic({ id: "topic", slug: "usage", title: "Usage", repositoryPath: root, baseRef: "main", worktreePath: root,
    branchPrefix: "test", requestedBranchName: null, predecessorTopicId: null, branchName: null, state: "USER_DECISION_REQUIRED",
    scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(), lastError: null });
  const policy = { execution: { inputTokens: 10_000, outputTokens: 1000, durationMs: 10_000 },
    total: { inputTokens: 100_000, outputTokens: 10_000, durationMs: 100_000 } };
  database.budgets.configure("topic", policy, "user-explicit", 0);
  database.budgets.start({ id: "execution", accounts: ["topic"], stage: "CODEX_AUDIT", role: "codex", model: "test", effort: "xhigh", startedAt: 1000, dispatchStarted: true });
  const wrong = mixed ? { inputTokens: 300, cachedInputTokens: 155, outputTokens: 36 } : { inputTokens: 240, cachedInputTokens: 120, outputTokens: 27 };
  database.budgets.observe("execution", { ...wrong, durationMs: 2000 }, 3000, true);
  database.saveExecutionUsage("topic", 1, "codex", "turn", { executionId: "execution", ...wrong,
    durationMs: 2000, internalRequests: mixed ? 3 : 2, recordKind: "final", completeness: "complete",
    ...(mixed ? { sourceUsage: { status: "mismatch" as const, turns } } : {}) });
  database.planning.save({ key: "checkpoint", id: "checkpoint-id", topicId: "topic", sessionId: "thread-test", role: "codex", stage: "CODEX_AUDIT",
    scopeGeneration: 1, planEpoch: 1, planSHA256: null, stopped: "Planning checkpoint saved; insufficient remaining budget for synthesis.",
    usage: { ...wrong, durationMs: 2100 }, peakStep: { inputTokens: 130, cachedInputTokens: 65, outputTokens: 15, durationMs: 600 },
    metrics: { internalRequests: mixed ? 3 : 2 }, updatedAt: new Date(3000).toISOString(), admissionId: "same-admission", round: mixed ? 3 : 2, delivered: ["keep-receipt"] } as unknown as PlanningCheckpoint);
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
  if (condition === "missing completion") rows.splice(5, 1);
  if (condition === "missing request") rows.splice(3, 1);
  if (condition === "foreign thread") (rows[3].payload as Record<string, unknown>).thread_id = "another";
  if (condition === "contradictory duplicate") rows.splice(4, 0, { ...rows[3], payload: { ...rows[3].payload, usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 0 } } } as never);
  if (condition === "unfinished turn") rows.pop();
  expect(codexUsageEvidence(encode(rows), "thread-test", condition === "out of window" ? 1200 : 1000, 3000)).toBeNull();
});

it("deduplicates identical request records and refuses a missing ledger source", () => {
  const rows = transcript(); rows.splice(4, 0, rows[3]);
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
  const rows = transcript(), p = rows[3].payload as { usage: { input_tokens?: number } };
  if (value === "missing") delete p.usage.input_tokens;
  else p.usage.input_tokens = value === "negative" ? -1 : 1.5;
  expect(codexUsageEvidence(encode(rows), "thread-test", 1000, 3000)).toBeNull();
});


it.each([130, 1030, 120])("checks a constant session baseline within the first multi-request turn (%s)", sessionInput => {
  const rows = transcript().slice(0, 6);
  rows.splice(5, 0, { timestamp: new Date(1450).toISOString(), type: "token_usage_record", payload: {
    thread_id: "thread-test", turn_id: "turn-1", response_id: "r1-second",
    usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3 },
    turn_token_usage: { input_tokens: 30, cached_input_tokens: 15, output_tokens: 5 },
    thread_token_usage: { input_tokens: sessionInput, cached_input_tokens: 65, output_tokens: 15 },
  } } as never, { timestamp: new Date(1460).toISOString(), type: "event_msg", payload: { type: "token_count", info: {
    total_token_usage: { input_tokens: sessionInput, cached_input_tokens: 65, output_tokens: 15 },
    last_token_usage: { input_tokens: 20, cached_input_tokens: 10, output_tokens: 3 },
  } } } as never);
  const evidence = codexUsageEvidence(encode(rows), "thread-test", 1000, 2000);
  if (sessionInput === 130) expect(evidence?.usage).toEqual({ inputTokens: 30, cachedInputTokens: 15, outputTokens: 5 });
  else expect(evidence).toBeNull();
});

function compactedTranscript() {
  const rows = transcript().slice(0, 6);
  const raw = (input: number, cached: number, output: number) => ({ input_tokens: input, cached_input_tokens: cached, output_tokens: output });
  const event = (at: number, type: string, payload: object) => ({ timestamp: new Date(at).toISOString(), type, payload });
  rows.push(...[
    event(2100, "event_msg", { type: "task_started", turn_id: "turn-2" }),
    event(2200, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-2", response_id: "compact",
      usage: raw(40, 0, 6), turn_token_usage: raw(40, 0, 6), thread_token_usage: raw(150, 55, 18) }),
    event(2250, "compacted", {}),
    event(2300, "event_msg", { type: "token_count", info: { total_token_usage: raw(110, 55, 12), last_token_usage: raw(0, 0, 0) } }),
    event(2400, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-2", response_id: "r2",
      usage: raw(20, 10, 3), turn_token_usage: raw(60, 10, 9), thread_token_usage: raw(170, 65, 21) }),
    event(2450, "event_msg", { type: "token_count", info: { total_token_usage: raw(130, 65, 15), last_token_usage: raw(20, 10, 3) } }),
    event(2500, "event_msg", { type: "task_complete", turn_id: "turn-2" }),
    event(2600, "event_msg", { type: "task_started", turn_id: "turn-3" }),
    event(2700, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-3", response_id: "r3",
      usage: raw(30, 20, 4), turn_token_usage: raw(30, 20, 4), thread_token_usage: raw(200, 85, 25) }),
    event(2750, "event_msg", { type: "token_count", info: { total_token_usage: raw(160, 85, 19), last_token_usage: raw(30, 20, 4) } }),
    event(2800, "event_msg", { type: "task_complete", turn_id: "turn-3" }),
  ] as never[]);
  return rows;
}

// Public parser/metrics boundary -> bill all request records including compaction -> planning
// and ledger counters. Expected amounts are independent request costs, not copied session sums.
it("proves CLI counters after compaction but charges all four requests, including compaction", () => {
  const proof = codexUsageEvidence(encode(compactedTranscript()), "thread-test", 1000, 3000)!;
  expect(proof.usage).toEqual({ inputTokens: 100, cachedInputTokens: 35, outputTokens: 15 });
  expect(proof.cliReported).toEqual({ inputTokens: 400, cachedInputTokens: 205, outputTokens: 46 });
  expect(proof.requestIds).toEqual(["r1", "compact", "r2", "r3"]);
  const meter = new ExecutionMetrics("codex", 10, "test", "xhigh", true, 1000);
  for (const [i, usage] of [[110, 55, 12], [130, 65, 15], [160, 85, 19]].entries()) meter.observe({ type: "turn.completed", response_id: `turn-${i}`,
    usage: { input_tokens: usage[0], cached_input_tokens: usage[1], output_tokens: usage[2] } });
  meter.setCodexHomeUsage({ ...proof.usage, turnEvidence: proof });
  expect(meter.snapshot({ toolCalls: 0, toolDurationMs: 0 }, "final")).toMatchObject({ ...proof.usage, source: "codex-home" });
});

it.each(["missing", "stale", "contradictory", "outside turn"])("does not corroborate %s CLI counters", fault => {
  const rows = compactedTranscript();
  const last = rows.findIndex(r => "timestamp" in r && r.timestamp === new Date(2750).toISOString());
  if (fault === "missing") rows.splice(last, 1);
  if (fault === "stale") { const [event] = rows.splice(last, 1); rows.splice(last - 1, 0, event); }
  if (fault === "contradictory") (rows[last].payload as any).info.last_token_usage.input_tokens = 999;
  if (fault === "outside turn") { const [event] = rows.splice(last, 1); rows.push(event); }
  expect(codexUsageEvidence(encode(rows), "thread-test", 1000, 3000)?.cliReported).toBeUndefined();
});

it.each([
  { earlierCounter: true, baseline: true, repeat: false },
  { earlierCounter: false, baseline: true, repeat: false },
  { earlierCounter: false, baseline: false, repeat: true },
])("F001: refuses missing equal-sized requests with baseline=$baseline earlierCounter=$earlierCounter repeat=$repeat", ({ earlierCounter, baseline, repeat }) => {
  const raw = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output });
  const event = (at: number, type: string, payload: object) => ({ timestamp: new Date(at).toISOString(), type, payload });
  const rows = [
    { type: "session_meta", payload: { id: "thread-test" } },
    ...(baseline ? [event(900, "event_msg", { type: "token_count", info: { total_token_usage: raw(800, 80), last_token_usage: raw(100, 10) } })] : []),
    event(1100, "event_msg", { type: "task_started", turn_id: "turn-1" }),
    event(1200, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-1", response_id: "r1",
      usage: raw(100, 10), turn_token_usage: raw(100, 10), thread_token_usage: raw(1100, 110) }),
    ...(earlierCounter ? [event(1250, "event_msg", { type: "token_count", info: { total_token_usage: raw(900, 90), last_token_usage: raw(100, 10) } })] : []),
    // The second 100/10 request record is missing; its counter must not validate the first.
    event(1400, "event_msg", { type: "token_count", info: { total_token_usage: raw(1000, 100), last_token_usage: raw(100, 10) } }),
    ...(repeat ? [event(1450, "event_msg", { type: "token_count", info: { total_token_usage: raw(1000, 100), last_token_usage: raw(100, 10) } })] : []),
    event(1500, "event_msg", { type: "task_complete", turn_id: "turn-1" }),
  ];
  const proof = codexUsageEvidence(encode(rows), "thread-test", 1000, 2000);
  expect(proof).toBeNull();
  const meter = new ExecutionMetrics("codex", 10, "test", "xhigh", true, 1000);
  meter.observe({ type: "turn.completed", usage: raw(1000, 100) });
  meter.setCodexHomeUsage(proof ? { ...proof.usage, turnEvidence: proof } : null);
  expect(meter.snapshot({ toolCalls: 0, toolDurationMs: 0 }, "final")).toMatchObject({ inputTokens: 1000, outputTokens: 100, source: "cli-stream" });
});


it("atomically repairs a mixture of normalized and cumulative turns without losing source evidence", () => {
  const f = fixture(true), preview = reconcileCodexPlanningUsage(f);
  expect(preview.charged).toEqual({ inputTokens: 300, cachedInputTokens: 155, outputTokens: 36 });
  reconcileCodexPlanningUsage({ ...f, expectedHash: preview.hash });
  const db = new ConsensusDatabase(f.databasePath);
  expect(db.budgets.account("topic")).toMatchObject({ policy: f.policy, pause: null, used: { inputTokens: 100, outputTokens: 15, durationMs: 2000 } });
  expect(db.planning.latest("topic")).toMatchObject({ admissionId: "same-admission", round: 3, usage: { inputTokens: 100, outputTokens: 15 },
    peakStep: { inputTokens: 60, outputTokens: 9 } });
  db.close();
  expect(preview.after.usage.sourceUsage.turns).toEqual(preview.before.usage.sourceUsage.turns);
  expect(reconcileCodexPlanningUsage({ ...f, expectedHash: preview.hash }).reused).toBe(true);
});

it.each([false, true])("F002: preserves the pre-window anchor with a rate-limit-only notification=%s", rateLimitNotice => {
  const event = (at: number, type: string, payload: object) => ({ timestamp: new Date(at).toISOString(), type, payload });
  const raw = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: output });
  const rows = [
    { type: "session_meta", payload: { id: "thread-test" } },
    event(800, "event_msg", { type: "token_count", info: { total_token_usage: raw(800, 80), last_token_usage: raw(100, 10) } }),
    ...(rateLimitNotice ? [event(900, "event_msg", { type: "token_count", info: null })] : []),
    event(1100, "event_msg", { type: "task_started", turn_id: "turn-1" }),
    event(1200, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-1", response_id: "r1",
      usage: raw(100, 10), turn_token_usage: raw(100, 10), thread_token_usage: raw(1100, 110) }),
    event(1400, "event_msg", { type: "token_count", info: { total_token_usage: raw(900, 90), last_token_usage: raw(100, 10) } }),
    event(1500, "event_msg", { type: "task_complete", turn_id: "turn-1" }),
  ];
  const proof = codexUsageEvidence(encode(rows), "thread-test", 1000, 2000)!;
  expect(proof.cliReported).toEqual({ inputTokens: 900, cachedInputTokens: 0, outputTokens: 90 });
  const meter = new ExecutionMetrics("codex", 10, "test", "xhigh", true, 1000);
  meter.observe({ type: "turn.completed", usage: raw(900, 90) });
  meter.setCodexHomeUsage({ ...proof.usage, turnEvidence: proof });
  expect(meter.snapshot({ toolCalls: 0, toolDurationMs: 0 }, "final")).toMatchObject({ inputTokens: 100, outputTokens: 10, source: "codex-home" });
});

it.each([
  { label: "missing request cancels compaction without anchor", base: 1000, baseline: false, missing: true, counter: true, valid: false },
  { label: "missing request with anchor", base: 1000, baseline: true, missing: true, counter: true, valid: false },
  { label: "missing final counter", base: 1000, baseline: true, missing: false, counter: false, valid: false },
  { label: "unanchored complete resumed turn", base: 1000, baseline: false, missing: false, counter: true, valid: false },
  { label: "complete resumed turn", base: 1000, baseline: true, missing: false, counter: true, valid: true },
  { label: "complete fresh session", base: 0, baseline: false, missing: false, counter: true, valid: true },
])("F001: requires independently bounded request accounting: $label", ({ base, baseline, missing, counter, valid }) => {
  const raw = (input: number) => ({ input_tokens: input, cached_input_tokens: 0, output_tokens: input / 10 });
  const event = (at: number, type: string, payload: object) => ({ timestamp: new Date(at).toISOString(), type, payload });
  const request = (n: number) => event(1100 + n * 100, "token_usage_record", { thread_id: "thread-test", turn_id: "turn-1", response_id: `r${n}`,
    usage: raw(100), turn_token_usage: raw(n * 100), thread_token_usage: raw(base + n * 100) });
  const rows = [
    { type: "session_meta", payload: { id: "thread-test" } },
    ...(baseline ? [event(900, "event_msg", { type: "token_count", info: { total_token_usage: raw(base), last_token_usage: raw(100) } })] : []),
    event(1100, "event_msg", { type: "task_started", turn_id: "turn-1" }),
    request(1), event(1250, "compacted", {}), request(2), ...(missing ? [] : [request(3)]),
    ...(counter ? [event(1450, "event_msg", { type: "token_count", info: { total_token_usage: raw(base + 200), last_token_usage: raw(100) } })] : []),
    event(1500, "event_msg", { type: "task_complete", turn_id: "turn-1" }),
  ];
  const proof = codexUsageEvidence(encode(rows), "thread-test", 1000, 2000);
  if (valid) expect(proof?.usage).toEqual({ inputTokens: 300, cachedInputTokens: 0, outputTokens: 30 });
  else expect(proof).toBeNull();
  const meter = new ExecutionMetrics("codex", 10, "test", "xhigh", true, 1000);
  meter.observe({ type: "turn.completed", usage: raw(base + 200) });
  meter.setCodexHomeUsage(proof ? { ...proof.usage, turnEvidence: proof } : null);
  expect(meter.snapshot({ toolCalls: 0, toolDurationMs: 0 }, "final").inputTokens).toBe(valid ? 300 : base + 200);
});

it.each(["foreign", "missing", "reordered", "duplicate", "wrong request", "wrong CLI", "wrong charge"])("refuses %s mixed accounting evidence without writes", fault => {
  const f = fixture(true), db = new DatabaseSync(f.databasePath);
  const observed = JSON.parse(String(db.prepare("SELECT usage_json FROM execution_usage").get()!.usage_json));
  const turns = observed.sourceUsage.turns;
  if (fault === "foreign") turns[1].sessionId = "foreign";
  if (fault === "missing") turns.pop();
  if (fault === "reordered") turns.reverse();
  if (fault === "duplicate") turns[1].executionId = turns[0].executionId;
  if (fault === "wrong request") turns[1].sourceUsage.codexHome.turnEvidence.requestIds = ["r1"];
  if (fault === "wrong CLI") turns[1].sourceUsage.cli.inputTokens--;
  if (fault === "wrong charge") observed.inputTokens--;
  db.prepare("UPDATE execution_usage SET usage_json=?").run(JSON.stringify(observed));
  expect(() => reconcileCodexPlanningUsage(f)).toThrow("Usage reconciliation refused");
  expect(JSON.parse(String(db.prepare("SELECT record_json FROM budget_accounts").get()!.record_json)).used.inputTokens).toBe(300);
  db.close();
});
