import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { RevisionLedger } from "../src/server/revisionLedger";
import { BudgetLedger } from "../src/server/budgetLedger";
function setup() {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE topics(id TEXT PRIMARY KEY)");
  const budgets = new BudgetLedger(db),
    revisions = new RevisionLedger(db);
  revisions.initialize("t");
  return { db, budgets, revisions };
}
it("최초 계획만 제외하고 재계획·교정·개정을 합쳐 세 번에서 차단한다", () => {
  const { db, revisions } = setup();
  revisions.admit("t", "first", "plan");
  revisions.admit("t", "repair", "repair");
  revisions.admit("t", "revision", "revision");
  revisions.admit("t", "replan", "plan");
  revisions.admit("t", "replan", "plan");
  expect(revisions.account("t").used).toBe(3);
  expect(() => revisions.admit("t", "fourth", "revision")).toThrow("한도");
  revisions.grant("t", "grant", 1);
  revisions.grant("t", "grant", 1);
  expect(revisions.account("t").limit).toBe(4);
  expect(() => revisions.grant("t", "other", 1)).toThrow("변경");
  revisions.admit("t", "fourth", "revision");
  expect(() => revisions.admit("t", "fifth", "repair")).toThrow();
  expect(new RevisionLedger(db).account("t").used).toBe(4);
  db.close();
});
it("토큰 예산 거절은 횟수를 쓰지 않고 횟수 거절은 실행 원장을 만들지 않는다", () => {
  const { db, budgets, revisions } = setup();
  const start = (id: string) =>
    budgets.start(
      {
        id,
        accounts: ["t"],
        stage: "CLAUDE_REVISION",
        role: "claude",
        model: "m",
        effort: "e",
        startedAt: 0,
      },
      () => revisions.reserve("t", id, "revision"),
    );
  expect(() => start("blocked")).toThrow();
  expect(revisions.account("t").used).toBe(0);
  budgets.configure(
    "t",
    {
      execution: { inputTokens: 10, outputTokens: 10, durationMs: 100 },
      total: { inputTokens: 100, outputTokens: 100, durationMs: 1000 },
    },
    "test",
  );
  for (const id of ["1", "2", "3"]) {
    start(id);
    budgets.observe(id, {}, 0, true);
  }
  expect(() => start("4")).toThrow("한도");
  expect(() => budgets.execution("4")).toThrow();
  db.close();
});
it("기존 토픽의 불완전한 이력은 0회 여유를 주지 않고 확인한 호출만 보존한다", () => {
  const { db } = setup();
  db.exec("INSERT INTO topics VALUES ('old')");
  db.prepare("INSERT INTO budget_executions VALUES (?,?)").run(
    "old-call",
    JSON.stringify({
      id: "old-call",
      accounts: ["old"],
      role: "claude",
      stage: "CLAUDE_REVISION",
      startedAt: 1,
    }),
  );
  const migrated = new RevisionLedger(db);
  expect(migrated.account("old")).toMatchObject({
    used: 1,
    limit: 1,
    historyIncomplete: true,
  });
  expect(() => migrated.admit("old", "next", "plan")).toThrow();
  migrated.grant("old", "ack", 1);
  migrated.admit("old", "next", "plan");
  expect(() => migrated.admit("old", "again", "revision")).toThrow();
  db.close();
});
