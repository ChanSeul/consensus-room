import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { observeMemory } from "../scripts/observe-memory";

describe("memory observations from recorded executions", () => {
  it("keeps all executions, separates comparison conditions, and preserves zero versus unknown", () => {
    const db = new DatabaseSync(":memory:");
    try {
      db.exec(`CREATE TABLE topics(id TEXT,state TEXT,created_at TEXT);
        CREATE TABLE timeline_events(topic_id TEXT,state TEXT,sequence INTEGER,created_at TEXT);
        CREATE TABLE execution_usage(execution_id TEXT,topic_id TEXT,role TEXT,phase TEXT,usage_json TEXT,observed_at TEXT,final INTEGER);
        INSERT INTO topics VALUES ('done','CLOSED','2026-09-22T00:00:00Z'),('active','IMPLEMENTING','2026-09-22T00:00:00Z');
        INSERT INTO timeline_events VALUES ('done','CLOSED',1,'2026-09-22T01:00:00Z');`);
      const add = db.prepare("INSERT INTO execution_usage VALUES (?, 'done','codex','REVIEW',?,'2026-09-22T00:30:00Z',1)");
      add.run("one", JSON.stringify({ model: "model-a", effort: "high", resumed: false, completeness: "complete", inputTokens: 100, cachedInputTokens: 0, outputTokens: 10, durationMs: 1000, toolCalls: 2 }));
      add.run("two", JSON.stringify({ model: "model-a", effort: "high", resumed: false, completeness: "complete", inputTokens: 200, cachedInputTokens: 50, outputTokens: 20, durationMs: 2000, toolCalls: 3 }));
      add.run("three", JSON.stringify({ model: "model-b", effort: "low", resumed: true, completeness: "partial", inputTokens: 5 }));
      const report = observeMemory(db, { implementationCommit: "a".repeat(40), entries: [
        { topicId: "done", cohort: "after", kind: "bugfix", userCorrections: 0 },
        { topicId: "active", cohort: "after", kind: "bugfix", userCorrections: null },
      ] });
      expect(report.completedAfterTasks).toBe(1);
      expect(report.assessment).toBe("insufficient-samples");
      const row = report.rows[0];
      if (!row.included) throw new Error("Expected a closed topic");
      expect(row.elapsedIncludingWaitsMs).toBe(3_600_000);
      expect(row.executions).toBe(3);
      expect(row.groups).toHaveLength(2);
      expect(row.groups![0].totals).toMatchObject({ inputTokens: 300, cachedInputTokens: 50, outputTokens: 30, durationMs: 3000 });
      expect(row.groups![1].totals.inputTokens).toBeNull();
      expect(row.userCorrections).toBe(0);
      expect(report.rows[1].userCorrections).toBeNull();
      expect(report.rows[1].included).toBe(false);
      expect(() => observeMemory(db, { implementationCommit: "a".repeat(40), entries: [
        { topicId: "done", cohort: "before", kind: "bugfix", userCorrections: 0 },
        { topicId: "done", cohort: "after", kind: "bugfix", userCorrections: 0 },
      ] })).toThrow("one cohort");
    } finally { db.close(); }
  });
});
