import type { DatabaseSync } from "node:sqlite";

// One-time migration, not a startup default that overwrites later user choices.
export function migrateUnlimitedIterations(db: DatabaseSync, table: "review_allowances" | "revision_allowances"): void {
  db.exec("CREATE TABLE IF NOT EXISTS iteration_limit_migrations(id TEXT PRIMARY KEY)");
  if (db.prepare("SELECT 1 FROM iteration_limit_migrations WHERE id=?").get(table)) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`UPDATE ${table} SET record_json=json_set(record_json,'$.limit',NULL,'$.version',json_extract(record_json,'$.version')+1)
      WHERE topic_id IN (SELECT id FROM topics WHERE state!='CLOSED')`).run();
    db.prepare("INSERT INTO iteration_limit_migrations VALUES (?)").run(table);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

export function validateIterationLimit(limit: number | null): void {
  if (limit !== null && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("횟수 한도는 0 이상의 정수 또는 제한 없음이어야 합니다.");
}
