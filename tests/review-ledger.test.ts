import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { BudgetLedger } from "../src/server/budgetLedger";
import { ReviewLedger } from "../src/server/reviewLedger";
it("계획 검토·구현 리뷰는 각각 첫 호출부터 3회이고 중복·재시작·승인이 한도를 우회하지 않는다", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE topics(id TEXT PRIMARY KEY)");
  new BudgetLedger(db);
  const ledger = new ReviewLedger(db);
  ledger.initialize("t");
  for (const scope of ["planning", "implementation"] as const) {
    for (let n = 0; n < 3; n++) ledger.admit("t", `${scope}-${n}`, scope);
    ledger.admit("t", `${scope}-2`, scope);
    expect(ledger.account("t", scope).used).toBe(3);
    expect(() => ledger.admit("t", `${scope}-3`, scope)).toThrow("한도");
  }
  ledger.grant("t", "planning", "grant", 1);
  ledger.grant("t", "planning", "grant", 1);
  expect(ledger.account("t", "implementation").limit).toBe(3);
  expect(() => ledger.grant("t", "planning", "stale", 1)).toThrow("변경");
  ledger.admit("t", "planning-3", "planning");
  expect(new ReviewLedger(db).account("t", "planning")).toMatchObject({
    used: 4,
    limit: 4,
  });
  db.close();
});
it("기존 리뷰 기록은 확인한 호출만 복구하고 추가 승인 전에 호출하지 않는다", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE topics(id TEXT PRIMARY KEY); INSERT INTO topics VALUES ('old')",
  );
  new BudgetLedger(db);
  db.prepare("INSERT INTO budget_executions VALUES (?,?)").run(
    "old",
    JSON.stringify({
      id: "old",
      accounts: ["old"],
      role: "codex",
      stage: "CODEX_CLOSEOUT",
    }),
  );
  const ledger = new ReviewLedger(db);
  expect(ledger.account("old", "planning")).toMatchObject({
    used: 1,
    limit: 1,
    historyIncomplete: true,
  });
  expect(() => ledger.admit("old", "next", "planning")).toThrow();
  ledger.grant("old", "planning", "allow", 1);
  ledger.admit("old", "next", "planning");
  expect(() => ledger.admit("old", "again", "planning")).toThrow();
  db.close();
});

it("여러 토픽의 이력은 원장마다 한 번 읽으며 집계가 끝난 뒤에는 다시 읽지 않는다", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("CREATE TABLE topics(id TEXT PRIMARY KEY)");
  new BudgetLedger(db);
  for (let n = 0; n < 100; n++)
    db.prepare("INSERT INTO topics VALUES (?)").run(`t${n}`);
  const prepare = db.prepare.bind(db);
  let scans = 0;
  db.prepare = ((sql: string) => {
    if (sql.includes("FROM budget_executions")) scans++;
    return prepare(sql);
  }) as typeof db.prepare;
  new ReviewLedger(db);
  expect(scans).toBe(1);
  new ReviewLedger(db);
  expect(scans).toBe(1);
  db.close();
});
