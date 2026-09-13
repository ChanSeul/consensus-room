import type { DatabaseSync } from "node:sqlite";
import { BUDGET_KEYS, BudgetPolicySchema, zeroBudget, type BudgetAccount, type BudgetPolicy, type BudgetVector } from "../shared/budgets.js";

export class BudgetBlocked extends Error {
  constructor(readonly accountId: string, message = "예산을 추가한 뒤 재개해야 합니다.") { super(message); this.name = "BudgetBlocked"; }
}
interface Execution {
  id: string; accounts: string[]; limit: BudgetVector; accountLimits: Record<string,BudgetVector>; used: BudgetVector;
  startedAt: number; stage: string; role: string; model: string; effort: string; finished: boolean;
}
export class BudgetLedger {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS budget_accounts(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_executions(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_grants(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, record_json TEXT NOT NULL);`);
  }
  account(id: string): BudgetAccount | null {
    const row = this.db.prepare("SELECT record_json FROM budget_accounts WHERE id=?").get(id);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  private save(account: BudgetAccount): void {
    this.db.prepare("INSERT INTO budget_accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json")
      .run(account.id, JSON.stringify(account));
  }
  configure(id: string, policy: BudgetPolicy, source: string, now = Date.now()): BudgetAccount {
    if (this.account(id)) throw new Error("기존 예산은 덮어쓸 수 없습니다. 증액을 사용하세요.");
    const account: BudgetAccount = { id, policy: BudgetPolicySchema.parse(policy), used: zeroBudget(), startedAt: now,
      pause: null, version: 1, source };
    this.save(account); return account;
  }
  assertAvailable(ids: string[]): void {
    const unfinished = this.db.prepare("SELECT record_json FROM budget_executions").all()
      .map(row=>JSON.parse(String(row.record_json)) as Execution)
      .find(execution=>!execution.finished && execution.accounts.some(id=>ids.includes(id)));
    if(unfinished) throw new BudgetBlocked(unfinished.accounts.find(id=>ids.includes(id))!,"집계가 끝나지 않은 실행이 있습니다. 진행 상태를 확인하고 예산을 추가하세요.");
    for (const id of ids) {
      const a = this.account(id);
      if (!a) throw new BudgetBlocked(id, "검증된 기본 예산이 없습니다. 예산을 설정한 뒤 진행하세요.");
      if (a.pause || BUDGET_KEYS.some(key => a.used[key] >= a.policy.total[key])) throw new BudgetBlocked(id);
    }
  }
  start(input: Omit<Execution, "used" | "finished" | "limit" | "accountLimits">): Execution {
    return this.transaction(() => {
      if (!input.accounts.length || new Set(input.accounts).size !== input.accounts.length) throw new Error("예산 계정은 비어 있거나 중복될 수 없습니다.");
      this.assertAvailable(input.accounts);
      const limit = Object.fromEntries(BUDGET_KEYS.map(key => [key, Math.min(...input.accounts.map(id => this.account(id)!.policy.execution[key]))])) as BudgetVector;
      const execution = { ...input, limit, accountLimits:Object.fromEntries(input.accounts.map(id=>[id,this.account(id)!.policy.execution])), used: zeroBudget(), finished: false };
      this.db.prepare("INSERT INTO budget_executions VALUES (?,?)").run(input.id, JSON.stringify(execution));
      return execution;
    });
  }
  execution(id: string): Execution {
    const row = this.db.prepare("SELECT record_json FROM budget_executions WHERE id=?").get(id);
    if (!row) throw new Error("예산 실행 기록이 없습니다.");
    return JSON.parse(String(row.record_json));
  }
  observe(id: string, usage: Partial<BudgetVector>, now = Date.now(), finished = false): BudgetAccount[] {
    return this.transaction(() => {
      const execution = this.execution(id);
      if (execution.finished) return execution.accounts.map(id => this.account(id)!);
      const delta = zeroBudget();
      for (const key of BUDGET_KEYS) {
        const value = usage[key];
        if (value !== undefined && Number.isFinite(value) && value >= 0) {
          const next = Math.max(execution.used[key], value);
          delta[key] = next - execution.used[key]; execution.used[key] = next;
        }
      }
      const accounts = execution.accounts.map(accountId => {
        const a = this.account(accountId)!;
        const exceeded = BUDGET_KEYS.filter(key => execution.used[key] >= (execution.accountLimits?.[accountId] ?? execution.limit)[key]);
        for (const key of BUDGET_KEYS) a.used[key] += delta[key];
        const total = BUDGET_KEYS.filter(key => a.used[key] >= a.policy.total[key]);
        if (!a.pause && (exceeded.length || total.length)) a.pause = { executionId:id, detectedAt:now, deadline:now+60_000,
          reason: `${exceeded.length ? "실행" : "누적"} 예산 도달: ${(exceeded.length ? exceeded : total).join(", ")}` };
        this.save(a); return a;
      });
      execution.finished = finished;
      this.db.prepare("UPDATE budget_executions SET record_json=? WHERE id=?").run(JSON.stringify(execution), id);
      return accounts;
    });
  }
  grant(id: string, requestId: string, policy: BudgetPolicy, expectedVersion: number): BudgetAccount {
    policy = BudgetPolicySchema.parse(policy);
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT account_id,record_json FROM budget_grants WHERE id=?").get(requestId);
      if (previous) {
        const saved = JSON.parse(String(previous.record_json));
        if (previous.account_id !== id || JSON.stringify(saved.policy) !== JSON.stringify(policy)) throw new Error("같은 요청 키의 예산이 다릅니다.");
        return this.account(id)!;
      }
      const a = this.account(id); if (!a) throw new Error("먼저 예산을 설정하세요.");
      policy = BudgetPolicySchema.parse(policy);
      if (a.version !== expectedVersion) throw new Error("예산이 변경됐습니다. 새로 확인하세요.");
      for (const key of BUDGET_KEYS) {
        if (policy.execution[key] < a.policy.execution[key] || policy.total[key] < a.policy.total[key]
          || policy.total[key] <= a.used[key]) throw new Error("사용량보다 큰 예산을 지정하고 기존 상한을 낮추지 마세요.");
      }
      if (JSON.stringify(policy) === JSON.stringify(a.policy)) throw new Error("추가 예산이 필요합니다.");
      for(const row of this.db.prepare("SELECT record_json FROM budget_executions").all()) {
        const execution=JSON.parse(String(row.record_json)) as Execution;
        if(!execution.finished && execution.accounts.includes(id)) {
          execution.finished=true;
          this.db.prepare("UPDATE budget_executions SET record_json=? WHERE id=?").run(JSON.stringify(execution),execution.id);
        }
      }
      a.policy = policy; a.pause = null; a.version++;
      this.save(a);
      this.db.prepare("INSERT INTO budget_grants VALUES (?,?,?)").run(requestId,id,JSON.stringify({ policy, version:a.version, at:Date.now() }));
      return a;
    });
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
