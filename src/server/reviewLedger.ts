import { executionHistory } from "./executionHistory.js";
import type { DatabaseSync } from "node:sqlite";
import {
  reviewScope,
  type ReviewScope,
  type ReviewAllowance,
} from "../shared/reviews.js";
export class ReviewBlocked extends Error {
  constructor(
    readonly topicId: string,
    readonly scope: ReviewScope,
  ) {
    super(
      `${scope === "planning" ? "계획 검토" : "구현 리뷰"} 한도에 도달했습니다. 1회 추가 승인 후 재개하세요.`,
    );
    this.name = "ReviewBlocked";
  }
}
export class ReviewLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_allowances(topic_id TEXT NOT NULL,scope TEXT NOT NULL,record_json TEXT NOT NULL,PRIMARY KEY(topic_id,scope));
   CREATE TABLE IF NOT EXISTS review_attempts(execution_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,scope TEXT NOT NULL);
   CREATE TABLE IF NOT EXISTS review_grants(request_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,scope TEXT NOT NULL,expected_version INTEGER NOT NULL);`);
    const topics = db
      .prepare("SELECT id FROM topics")
      .all()
      .filter(
        (row) =>
          !this.find(String(row.id), "planning") ||
          !this.find(String(row.id), "implementation"),
      );
    const history = executionHistory(
      db,
      new Set(topics.map((row) => String(row.id))),
      "codex",
    );
    for (const row of topics)
      for (const scope of ["planning", "implementation"] as const) {
        const topicId = String(row.id);
        if (this.find(topicId, scope)) continue;
        this.transaction(() => {
          const executions = (history.get(topicId) ?? []).filter(
            (e) => reviewScope(e.stage) === scope,
          );
          for (const e of executions)
            db.prepare(
              "INSERT OR IGNORE INTO review_attempts VALUES (?,?,?)",
            ).run(e.id, topicId, scope);
          this.save({
            topicId,
            scope,
            used: executions.length,
            limit: executions.length,
            version: 1,
            historyIncomplete: true,
          });
        });
      }
  }
  initialize(topicId: string): void {
    for (const scope of ["planning", "implementation"] as const) {
      if (this.find(topicId, scope))
        throw new Error("리뷰 집계는 초기화할 수 없습니다.");
      this.save({
        topicId,
        scope,
        used: 0,
        limit: 3,
        version: 1,
        historyIncomplete: false,
      });
    }
  }
  private find(
    topicId: string,
    scope: ReviewScope,
  ): ReviewAllowance | undefined {
    const row = this.db
      .prepare(
        "SELECT record_json FROM review_allowances WHERE topic_id=? AND scope=?",
      )
      .get(topicId, scope);
    return row ? JSON.parse(String(row.record_json)) : undefined;
  }
  account(topicId: string, scope: ReviewScope): ReviewAllowance {
    const a = this.find(topicId, scope);
    if (!a) throw new Error("리뷰 집계 기록이 없습니다.");
    return a;
  }
  assertAvailable(topicId: string, scope: ReviewScope): void {
    const a = this.account(topicId, scope);
    if (a.used >= a.limit) throw new ReviewBlocked(topicId, scope);
  }
  reserve(topicId: string, id: string, scope: ReviewScope): void {
    const old = this.db
      .prepare("SELECT * FROM review_attempts WHERE execution_id=?")
      .get(id);
    if (old) {
      if (old.topic_id !== topicId || old.scope !== scope)
        throw new Error("실행 ID의 리뷰 정보가 다릅니다.");
      return;
    }
    this.assertAvailable(topicId, scope);
    const a = this.account(topicId, scope);
    a.used++;
    this.db
      .prepare("INSERT INTO review_attempts VALUES (?,?,?)")
      .run(id, topicId, scope);
    this.save(a);
  }
  admit(topicId: string, id: string, scope: ReviewScope): void {
    this.transaction(() => this.reserve(topicId, id, scope));
  }
  // spawn 직전 실행 허용 검사에 막혀 실제 호출이 없었던 예약을 되돌린다(PLAN §2 검증 조건 1).
  release(topicId: string, id: string): boolean {
    return this.transaction(() => {
      const old = this.db.prepare("SELECT * FROM review_attempts WHERE execution_id=?").get(id);
      if (!old || old.topic_id !== topicId) return false;
      this.db.prepare("DELETE FROM review_attempts WHERE execution_id=?").run(id);
      const a = this.account(topicId, String(old.scope) as ReviewScope); a.used = Math.max(0, a.used - 1); this.save(a);
      return true;
    });
  }
  grant(
    topicId: string,
    scope: ReviewScope,
    id: string,
    version: number,
  ): ReviewAllowance {
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM review_grants WHERE request_id=?")
        .get(id);
      if (old) {
        if (
          old.topic_id !== topicId ||
          old.scope !== scope ||
          old.expected_version !== version
        )
          throw new Error("같은 승인 요청의 내용이 다릅니다.");
        return this.account(topicId, scope);
      }
      const a = this.account(topicId, scope);
      if (a.version !== version)
        throw new Error("리뷰 한도가 변경됐습니다. 새로 확인하세요.");
      if (a.used < a.limit)
        throw new Error("아직 사용할 리뷰 횟수가 남아 있습니다.");
      a.limit = a.used + 1;
      a.version++;
      this.save(a);
      this.db
        .prepare("INSERT INTO review_grants VALUES (?,?,?,?)")
        .run(id, topicId, scope, version);
      return a;
    });
  }
  private save(a: ReviewAllowance): void {
    this.db
      .prepare(
        "INSERT INTO review_allowances VALUES (?,?,?) ON CONFLICT(topic_id,scope) DO UPDATE SET record_json=excluded.record_json",
      )
      .run(a.topicId, a.scope, JSON.stringify(a));
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
}
