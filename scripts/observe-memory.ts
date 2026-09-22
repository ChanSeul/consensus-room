import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { z } from "zod";

export const ObservationCohort = z.object({
  implementationCommit: z.string().regex(/^[a-f0-9]{40}$/),
  entries: z.array(z.object({
    topicId: z.string().min(1), cohort: z.enum(["before", "after"]), kind: z.string().min(1),
    userCorrections: z.number().int().nonnegative().nullable(),
  })).refine(entries => new Set(entries.map(e => e.topicId)).size === entries.length, "A topic belongs to one cohort only"),
});
const metrics = ["inputTokens", "cachedInputTokens", "outputTokens", "durationMs", "toolCalls"] as const;

// Read-only observations, not an A/B claim. Missing measurements remain null, including genuine zero values.
export function observeMemory(db: DatabaseSync, raw: unknown) {
  const cohort = ObservationCohort.parse(raw);
  const rows = cohort.entries.map(entry => {
    const topic = db.prepare("SELECT state,created_at FROM topics WHERE id=?").get(entry.topicId);
    if (!topic || topic.state !== "CLOSED") return { ...entry, included: false as const, reason: "not-closed" };
    const close = db.prepare("SELECT created_at FROM timeline_events WHERE topic_id=? AND state='CLOSED' ORDER BY sequence LIMIT 1").get(entry.topicId);
    const elapsed = close ? Date.parse(String(close.created_at)) - Date.parse(String(topic.created_at)) : NaN;
    const executions = db.prepare("SELECT role,phase,usage_json,final FROM execution_usage WHERE topic_id=? ORDER BY observed_at,execution_id").all(entry.topicId);
    const groups = new Map<string, { executions: number; incomplete: number; totals: Record<string, number | null> }>();
    let incomplete = 0;
    for (const execution of executions) {
      const usage = JSON.parse(String(execution.usage_json));
      const key = JSON.stringify([entry.kind, execution.role, execution.phase, usage.model ?? null, usage.effort ?? null, usage.resumed ?? null]);
      const group = groups.get(key) ?? { executions: 0, incomplete: 0, totals: Object.fromEntries(metrics.map(m => [m, 0])) };
      const complete = execution.final === 1 && usage.completeness === "complete";
      group.executions += 1;
      if (!complete) { group.incomplete += 1; incomplete += 1; }
      for (const metric of metrics) {
        const value = usage[metric];
        if (!complete || typeof value !== "number" || !Number.isFinite(value) || value < 0) group.totals[metric] = null;
        else if (group.totals[metric] !== null) group.totals[metric]! += value;
      }
      groups.set(key, group);
    }
    return { ...entry, included: true as const, elapsedIncludingWaitsMs: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : null,
      executions: executions.length, incomplete, groups: [...groups].map(([key, value]) => ({ dimensions: JSON.parse(key), ...value })) };
  });
  const after = rows.filter(row => row.included && row.cohort === "after").length;
  return { implementationCommit: cohort.implementationCommit, completedAfterTasks: after, targetAfterTasks: 20,
    assessment: after < 20 ? "insufficient-samples" : "observational-only",
    note: "durationMs sums model executions; elapsedIncludingWaitsMs includes user waits. Cached input is part of inputTokens. Null is unavailable. Corrections are manually verified, not inferred from messages. No causal speedup is asserted.", rows };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const arg = (key: string) => args[args.indexOf(key) + 1];
  if (!args.includes("--db") || !args.includes("--cohort")) throw new Error("Usage: tsx scripts/observe-memory.ts --db PATH --cohort JSON");
  const db = new DatabaseSync(arg("--db"), { readOnly: true });
  try { console.log(JSON.stringify(observeMemory(db, JSON.parse(readFileSync(arg("--cohort"), "utf8"))), null, 2)); }
  finally { db.close(); }
}
