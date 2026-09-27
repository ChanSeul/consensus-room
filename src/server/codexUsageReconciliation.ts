import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { codexUsageEvidence, sameTokenCounts } from "./adapters/codexUsageEvidence.js";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const tokenKeys = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;
type Input = { databasePath: string; codexHome: string; transcriptPath: string; executionId: string; expectedHash?: string };
function requireProof(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(`Usage reconciliation refused: ${message}`); }

// Explicit operator repair, never startup migration: prove one completed planning invocation from
// provider request/turn records, preview its exact before/after rows, then apply that hash atomically.
// The original rows remain in the receipt. Policies, durations, grants and logical review IDs stay intact.
export function reconcileCodexPlanningUsage(input: Input) {
  const db = new DatabaseSync(input.databasePath, { readOnly: !input.expectedHash });
  db.exec("PRAGMA busy_timeout = 5000");
  try {
    if (input.expectedHash) db.exec("BEGIN IMMEDIATE");
    const hasReceipts = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='codex_usage_reconciliations'").get();
    const prior = hasReceipts ? db.prepare("SELECT receipt_json FROM codex_usage_reconciliations WHERE execution_id=?").get(input.executionId) : null;
    if (prior) {
      const receipt = JSON.parse(String(prior.receipt_json));
      requireProof(!input.expectedHash || input.expectedHash === receipt.hash, "different correction hash");
      if (input.expectedHash) db.exec("COMMIT");
      return { ...receipt, applied: true, reused: true };
    }
    requireProof(!db.prepare("SELECT 1 FROM actions WHERE status='running' LIMIT 1").get(), "an action is running");
    const executionRow = db.prepare("SELECT record_json FROM budget_executions WHERE id=?").get(input.executionId);
    requireProof(executionRow, "execution missing");
    const execution = JSON.parse(String(executionRow.record_json));
    requireProof(execution.finished === true && execution.role === "codex", "execution is not completed Codex work");
    const usageRow = db.prepare("SELECT * FROM execution_usage WHERE execution_id=?").get(input.executionId);
    requireProof(usageRow && usageRow.final === 1, "final observed usage missing");
    const observed = JSON.parse(String(usageRow.usage_json));
    const topicRow = db.prepare("SELECT * FROM topics WHERE id=?").get(String(usageRow.topic_id));
    requireProof(topicRow?.state === "USER_DECISION_REQUIRED", "topic is not waiting at a checkpoint");
    const rows = db.prepare("SELECT key,record_json FROM planning_checkpoints WHERE topic_id=? ORDER BY json_extract(record_json,'$.updatedAt') DESC,rowid DESC LIMIT 1").all(String(usageRow.topic_id));
    requireProof(rows.length === 1, "checkpoint missing");
    const checkpoint = JSON.parse(String(rows[0].record_json));
    requireProof(checkpoint.role === "codex" && checkpoint.stage === execution.stage && checkpoint.scopeGeneration === usageRow.scope_generation &&
      checkpoint.scopeGeneration === topicRow.scope_generation && checkpoint.planEpoch === topicRow.plan_epoch && checkpoint.planSHA256 === topicRow.plan_sha256 &&
      checkpoint.stopped === "Planning checkpoint saved; insufficient remaining budget for synthesis.", "checkpoint binding changed");
    const givenSessions = resolve(input.codexHome, "sessions"), sessions = realpathSync(givenSessions);
    const rel = relative(givenSessions, resolve(input.transcriptPath));
    requireProof(rel !== "" && !rel.startsWith(`..${sep}`) && rel !== ".." && !rel.startsWith(sep), "transcript outside session home");
    const file = join(sessions, rel);
    let part = sessions;
    for (const name of rel.split(sep)) { part = join(part, name); requireProof(!lstatSync(part).isSymbolicLink(), "symlinked transcript"); }
    requireProof(basename(file).includes(checkpoint.sessionId) && lstatSync(file).isFile(), "wrong transcript path");
    const text = readFileSync(file, "utf8"), sourceSHA256 = digest(text);
    const end = execution.startedAt + execution.used.durationMs;
    const proof = codexUsageEvidence(text, checkpoint.sessionId, execution.startedAt, end);
    requireProof(proof, "incomplete or contradictory provider request evidence");
    requireProof(sameTokenCounts(observed, proof.reported) && sameTokenCounts(checkpoint.usage, proof.reported) &&
      execution.used.inputTokens === proof.reported.inputTokens && execution.used.outputTokens === proof.reported.outputTokens &&
      checkpoint.metrics?.internalRequests === proof.turnCount && observed.internalRequests === proof.turnCount,
    "stored counters are not exactly the proved cumulative-count defect");
    requireProof(tokenKeys.some(k => proof.reported[k] > proof.usage[k]) && tokenKeys.every(k => proof.reported[k] >= proof.usage[k]), "not a cumulative overcount");
    requireProof(Array.isArray(execution.accounts) && execution.accounts.includes(usageRow.topic_id), "execution ownership mismatch");
    for (const row of db.prepare("SELECT record_json FROM budget_executions").all()) {
      const other = JSON.parse(String(row.record_json));
      requireProof(other.finished || !other.accounts.some((id: string) => execution.accounts.includes(id)), "another account execution is unfinished");
    }
    const accounts = execution.accounts.map((id: string) => {
      const row = db.prepare("SELECT record_json FROM budget_accounts WHERE id=?").get(id);
      requireProof(row, "account missing");
      const before = JSON.parse(String(row.record_json));
      requireProof(before.pause === null && before.used.inputTokens >= proof.reported.inputTokens && before.used.outputTokens >= proof.reported.outputTokens,
        "account is paused or counters cannot cover this execution");
      return { id, before, after: { ...before, used: { ...before.used,
        inputTokens: before.used.inputTokens - proof.reported.inputTokens + proof.usage.inputTokens,
        outputTokens: before.used.outputTokens - proof.reported.outputTokens + proof.usage.outputTokens } } };
    });
    const correctedExecution = { ...execution, used: { ...execution.used, inputTokens: proof.usage.inputTokens, outputTokens: proof.usage.outputTokens } };
    const correctedUsage = { ...observed, ...proof.usage, source: "codex-home", sourceUsage: { status: "mismatch",
      cli: proof.reported, codexHome: { ...proof.usage, source: "codex-home" } } };
    const correctedCheckpoint = { ...checkpoint, usage: { ...checkpoint.usage, ...proof.usage }, peakStep: { ...checkpoint.peakStep, ...proof.peak } };
    const report = { version: 1, executionId: input.executionId, topicId: usageRow.topic_id, checkpointKey: rows[0].key,
      sessionId: checkpoint.sessionId, sourceSHA256, startedAt: execution.startedAt, endedAt: end, proof,
      before: { execution, usage: observed, checkpoint, accounts: accounts.map((a: { before: unknown }) => a.before) },
      after: { execution: correctedExecution, usage: correctedUsage, checkpoint: correctedCheckpoint, accounts: accounts.map((a: { after: unknown }) => a.after) } };
    const hash = digest(JSON.stringify(report));
    if (input.expectedHash) {
      requireProof(input.expectedHash === hash, "preview changed; inspect a fresh preview");
      db.exec("CREATE TABLE IF NOT EXISTS codex_usage_reconciliations(execution_id TEXT PRIMARY KEY, receipt_json TEXT NOT NULL)");
      db.prepare("UPDATE budget_executions SET record_json=? WHERE id=?").run(JSON.stringify(correctedExecution), input.executionId);
      for (const account of accounts) db.prepare("UPDATE budget_accounts SET record_json=? WHERE id=?").run(JSON.stringify(account.after), account.id);
      db.prepare("UPDATE execution_usage SET usage_json=? WHERE execution_id=?").run(JSON.stringify(correctedUsage), input.executionId);
      db.prepare("UPDATE planning_checkpoints SET record_json=? WHERE key=?").run(JSON.stringify(correctedCheckpoint), String(rows[0].key));
      db.prepare("INSERT INTO codex_usage_reconciliations VALUES (?,?)").run(input.executionId, JSON.stringify({ ...report, hash }));
      db.exec("COMMIT");
    }
    return { ...report, hash, applied: Boolean(input.expectedHash), reused: false };
  } catch (error) {
    if (input.expectedHash) { try { db.exec("ROLLBACK"); } catch { /* no transaction */ } }
    throw error;
  } finally { db.close(); }
}
