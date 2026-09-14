import { executionHistory } from "./executionHistory.js";
import type { DatabaseSync } from "node:sqlite";
import type { RevisionAllowance, RewriteKind } from "../shared/revisions.js";

export class RevisionBlocked extends Error {
  constructor(readonly topicId: string) {
    super(
      "계획 재작성 한도에 도달했거나 과거 호출 기록이 불완전합니다. 1회 추가 승인 후 재개하세요.",
    );
    this.name = "RevisionBlocked";
  }
}
export class RevisionLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS revision_allowances(topic_id TEXT PRIMARY KEY,record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revision_attempts(execution_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,kind TEXT NOT NULL,counted INTEGER NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS revision_grants(request_id TEXT PRIMARY KEY,topic_id TEXT NOT NULL,expected_version INTEGER NOT NULL);`);
    // Old execution records cannot prove coverage before accounting was installed. Preserve known calls as a lower bound.
    const topics = db
      .prepare(
        "SELECT id FROM topics WHERE id NOT IN (SELECT topic_id FROM revision_allowances)",
      )
      .all();
    const history = executionHistory(
      db,
      new Set(topics.map((row) => String(row.id))),
      "claude",
    );
    for (const row of topics) {
      const id = String(row.id);
      const executions = (history.get(id) ?? []).filter((e) =>
        ["CLAUDE_PLAN", "CLAUDE_REVISION"].includes(e.stage),
      );
      this.transaction(() => {
        let firstPlanUsed = false,
          used = 0;
        for (const e of executions) {
          const free = e.stage === "CLAUDE_PLAN" && !firstPlanUsed;
          if (e.stage === "CLAUDE_PLAN") firstPlanUsed = true;
          if (!free) used++;
          db.prepare(
            "INSERT OR IGNORE INTO revision_attempts VALUES (?,?,?,?,?)",
          ).run(
            e.id,
            id,
            e.stage === "CLAUDE_PLAN" ? "plan" : "revision",
            free ? 0 : 1,
            new Date(e.startedAt).toISOString(),
          );
        }
        this.save({
          topicId: id,
          used,
          limit: used,
          firstPlanUsed: true,
          historyIncomplete: true,
          startedAt: new Date().toISOString(),
          version: 1,
        });
      });
    }
  }
  initialize(topicId: string): void {
    if (
      this.db
        .prepare("SELECT 1 FROM revision_allowances WHERE topic_id=?")
        .get(topicId)
    )
      throw new Error("재작성 집계는 초기화할 수 없습니다.");
    this.save({
      topicId,
      used: 0,
      limit: 3,
      firstPlanUsed: false,
      historyIncomplete: false,
      startedAt: new Date().toISOString(),
      version: 1,
    });
  }
  account(topicId: string): RevisionAllowance {
    const row = this.db
      .prepare("SELECT record_json FROM revision_allowances WHERE topic_id=?")
      .get(topicId);
    if (!row) throw new Error("계획 재작성 집계 기록이 없습니다.");
    return JSON.parse(String(row.record_json));
  }
  assertAvailable(topicId: string, kind: RewriteKind): void {
    const a = this.account(topicId);
    if (kind === "plan" && !a.firstPlanUsed && !a.historyIncomplete) return;
    if (a.used >= a.limit) throw new RevisionBlocked(topicId);
  }
  // Called in the same transaction as the budget execution reservation; no await or nested transaction.
  reserve(topicId: string, executionId: string, kind: RewriteKind): void {
    const previous = this.db
      .prepare("SELECT * FROM revision_attempts WHERE execution_id=?")
      .get(executionId);
    if (previous) {
      if (previous.topic_id !== topicId || previous.kind !== kind)
        throw new Error("실행 ID의 재작성 정보가 다릅니다.");
      return;
    }
    this.assertAvailable(topicId, kind);
    const a = this.account(topicId),
      free = kind === "plan" && !a.firstPlanUsed && !a.historyIncomplete;
    if (kind === "plan") a.firstPlanUsed = true;
    if (!free) a.used++;
    this.db
      .prepare("INSERT INTO revision_attempts VALUES (?,?,?,?,?)")
      .run(executionId, topicId, kind, free ? 0 : 1, new Date().toISOString());
    this.save(a);
  }
  admit(topicId: string, executionId: string, kind: RewriteKind): void {
    this.transaction(() => this.reserve(topicId, executionId, kind));
  }
  // spawn 직전 실행 허용 검사에 막혀 **실제 호출이 없었던** 예약을 되돌린다(PLAN §2 검증 조건 1). 카운트된 시도만 used 를 줄인다.
  release(topicId: string, executionId: string): boolean {
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT * FROM revision_attempts WHERE execution_id=?").get(executionId);
      if (!previous || previous.topic_id !== topicId) return false;
      this.db.prepare("DELETE FROM revision_attempts WHERE execution_id=?").run(executionId);
      const a = this.account(topicId);
      if (Number(previous.counted) === 1) a.used = Math.max(0, a.used - 1);
      // 무료 최초 계획 예약(counted=0, plan)을 되돌리면 그 자격도 되돌린다 — 아니면 첫 실제 계획이 재작성 1회를 차감한다(CF-08).
      // 그 사이 실제로 돈 다른 plan 시도가 있으면 자격은 이미 소비된 것이다.
      else if (previous.kind === "plan") {
        const otherPlan = this.db.prepare("SELECT 1 FROM revision_attempts WHERE topic_id=? AND kind='plan' LIMIT 1").get(topicId);
        if (!otherPlan) a.firstPlanUsed = false;
      }
      this.save(a);
      return true;
    });
  }
  grant(
    topicId: string,
    requestId: string,
    expectedVersion: number,
  ): RevisionAllowance {
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM revision_grants WHERE request_id=?")
        .get(requestId);
      if (old) {
        if (
          old.topic_id !== topicId ||
          old.expected_version !== expectedVersion
        )
          throw new Error("같은 승인 요청의 내용이 다릅니다.");
        return this.account(topicId);
      }
      const a = this.account(topicId);
      if (a.version !== expectedVersion)
        throw new Error("재작성 한도가 변경됐습니다. 새로 확인하세요.");
      if (a.used < a.limit)
        throw new Error("아직 사용할 재작성 횟수가 남아 있습니다.");
      a.limit = a.used + 1;
      a.version++;
      this.save(a);
      this.db
        .prepare("INSERT INTO revision_grants VALUES (?,?,?)")
        .run(requestId, topicId, expectedVersion);
      return a;
    });
  }
  private save(a: RevisionAllowance): void {
    this.db
      .prepare(
        "INSERT INTO revision_allowances VALUES (?,?) ON CONFLICT(topic_id) DO UPDATE SET record_json=excluded.record_json",
      )
      .run(a.topicId, JSON.stringify(a));
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}
