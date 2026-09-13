import type { DatabaseSync } from "node:sqlite";
interface HistoricalExecution {
  id: string;
  accounts: string[];
  role: string;
  stage: string;
  startedAt: number;
}
// Read persisted executions once per migration, instead of parsing the full history for every topic.
export function executionHistory(
  db: DatabaseSync,
  topicIds: ReadonlySet<string>,
  role: string,
): Map<string, HistoricalExecution[]> {
  const grouped = new Map<string, HistoricalExecution[]>();
  if (topicIds.size === 0) return grouped;
  for (const row of db
    .prepare("SELECT record_json FROM budget_executions ORDER BY rowid")
    .all()) {
    const execution = JSON.parse(
      String(row.record_json),
    ) as HistoricalExecution;
    if (execution.role !== role) continue;
    for (const topicId of new Set(execution.accounts))
      if (topicIds.has(topicId)) {
        const records = grouped.get(topicId) ?? [];
        records.push(execution);
        grouped.set(topicId, records);
      }
  }
  return grouped;
}
