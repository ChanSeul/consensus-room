import type { DatabaseSync } from "node:sqlite";
import { BUDGET_KEYS, BudgetPolicySchema, hasBudgetLimits, OBSERVE_USAGE, zeroBudget, type BudgetAccount, type BudgetPolicy, type BudgetVector } from "../shared/budgets.js";

// Why a new execution cannot open now. running clears by itself when that execution ends; unsettled needs its usage
// confirmed (settled or acknowledged); budget needs a budget decision. Callers decide waiting versus stopping by this.
export type BudgetBlockReason = "running" | "unsettled" | "budget";
// What a person does before a stopped topic can resume, by reason.
const RESUME_STEP: Record<BudgetBlockReason, string> = {
  running: "같은 예산 계정의 다른 실행이 끝난 뒤 재개하세요.",
  unsettled: "중단된 실행의 집계를 확인한 뒤 재개하세요.",
  budget: "토큰·시간 예산도 추가한 뒤 재개하세요.",
};
export class BudgetBlocked extends Error {
  // executionId names the unfinished execution behind a running or unsettled refusal.
  constructor(readonly accountId: string, readonly reason: BudgetBlockReason, message = "예산을 추가한 뒤 재개해야 합니다.",
    readonly executionId?: string) {
    super(message); this.name = "BudgetBlocked";
  }
}
interface Execution {
  id: string; accounts: string[]; limit: BudgetVector | null; accountLimits: Record<string,BudgetVector | null>; used: BudgetVector;
  startedAt: number; stage: string; role: string; model: string; effort: string; finished: boolean;
  // Absent in legacy rows: unknown, never evidence that a paid process did not start.
  dispatchStarted?: boolean;
}
export class BudgetLedger {
  // Executions whose BudgetController.run is live in this server process — the only creator of executions. An unfinished
  // execution outside it ended without final usage or belongs to an earlier server: its usage is unknown until confirmed.
  private readonly live = new Set<string>();
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS budget_accounts(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_executions(id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS budget_grants(id TEXT PRIMARY KEY, account_id TEXT NOT NULL, record_json TEXT NOT NULL);`);
  }
  account(id: string): BudgetAccount | null {
    const row = this.db.prepare("SELECT record_json FROM budget_accounts WHERE id=?").get(id);
    return row ? JSON.parse(String(row.record_json)) : null;
  }
  hasUnfinishedExecution(id: string): boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM budget_executions,
      json_each(budget_executions.record_json, '$.accounts')
      WHERE json_each.value=? AND NOT coalesce(json_extract(budget_executions.record_json, '$.finished'), 0) LIMIT 1`).get(id));
  }
  private save(account: BudgetAccount): void {
    this.db.prepare("INSERT INTO budget_accounts VALUES (?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json")
      .run(account.id, JSON.stringify(account));
  }
  private assertNoLostAccount(id: string): void {
    const prior = this.db.prepare("SELECT 1 FROM budget_grants WHERE account_id=? LIMIT 1").get(id) ||
      this.db.prepare("SELECT 1 FROM budget_executions, json_each(budget_executions.record_json, '$.accounts') WHERE json_each.value=? LIMIT 1").get(id);
    if (prior) throw new BudgetBlocked(id, "unsettled", "사용량 기록에 연결된 계정이 없습니다. 기록을 복구한 뒤 진행하세요.");
  }
  configure(id: string, policy: BudgetPolicy, source: string, now = Date.now()): BudgetAccount {
    if (this.account(id)) throw new Error("기존 예산은 덮어쓸 수 없습니다. 증액을 사용하세요.");
    this.assertNoLostAccount(id);
    const account: BudgetAccount = { id, policy: BudgetPolicySchema.parse(policy), used: zeroBudget(), startedAt: now,
      pause: null, version: 1, source };
    this.save(account); return account;
  }
  // 실행 중인 호출의 spawn 직전에 쓰는 검사 — 자기 실행이 '미마감' 이라 assertAvailable 은 쓸 수 없고, 계정의 정지·총량 소진만 본다.
  assertNotExhausted(ids: string[]): void {
    for (const id of ids) {
      const a = this.account(id);
      if (!a) this.assertNoLostAccount(id);
      const policy = a?.policy;
      if (a && (a.pause || (policy && hasBudgetLimits(policy) && BUDGET_KEYS.some(key => a.used[key] >= policy.total[key])))) throw new BudgetBlocked(id, "budget");
    }
  }

  assertAvailable(ids: string[]): void {
    const unfinished = this.db.prepare("SELECT record_json FROM budget_executions").all()
      .map(row=>JSON.parse(String(row.record_json)) as Execution)
      .find(execution=>!execution.finished && execution.accounts.some(id=>ids.includes(id)));
    if(unfinished) {
      const account = unfinished.accounts.find(id=>ids.includes(id))!;
      throw this.live.has(unfinished.id)
        ? new BudgetBlocked(account, "running", "같은 예산 계정의 다른 실행이 진행 중입니다. 그 실행이 끝난 뒤 다시 시작하세요.", unfinished.id)
        : new BudgetBlocked(account, "unsettled", "집계가 끝나지 않은 실행이 있습니다. 중단된 실행을 확인하고 재개하세요.", unfinished.id);
    }
    for (const id of ids) {
      const a = this.account(id);
      if (!a) this.assertNoLostAccount(id);
      const policy = a?.policy;
      if (a && (a.pause || (policy && hasBudgetLimits(policy) && BUDGET_KEYS.some(key => a.used[key] >= policy.total[key])))) throw new BudgetBlocked(id, "budget");
    }
  }
  start(input: Omit<Execution, "used" | "finished" | "limit" | "accountLimits">, reserve?: () => void): Execution {
    return this.transaction(() => {
      if (!input.accounts.length || new Set(input.accounts).size !== input.accounts.length) throw new Error("예산 계정은 비어 있거나 중복될 수 없습니다.");
      this.assertAvailable(input.accounts);
      reserve?.();
      const accounts = input.accounts.map(id => this.account(id) ?? this.configure(id, OBSERVE_USAGE, "usage-only", input.startedAt));
      const policies = accounts.map(a => a.policy).filter(hasBudgetLimits);
      const limit = policies.length ? Object.fromEntries(BUDGET_KEYS.map(key => [key, Math.min(...policies.map(p => p.execution[key]))])) as BudgetVector : null;
      const execution = { ...input, limit, accountLimits:Object.fromEntries(accounts.map(a => [a.id, hasBudgetLimits(a.policy) ? a.policy.execution : null])), used: zeroBudget(), finished: false };
      this.db.prepare("INSERT INTO budget_executions VALUES (?,?)").run(input.id, JSON.stringify(execution));
      return execution;
    });
  }
  // null when a new execution can open on these accounts now; otherwise the step that must come first.
  resumeStep(ids: string[]): string | null {
    try { this.assertAvailable(ids); return null; }
    catch (error) { return RESUME_STEP[error instanceof BudgetBlocked ? error.reason : "budget"]; }
  }
  // BudgetController.run brackets its live span with these; leave always runs, even when the final observation throws.
  enter(id: string): void { this.live.add(id); }
  leave(id: string): void { this.live.delete(id); }
  execution(id: string): Execution {
    const row = this.db.prepare("SELECT record_json FROM budget_executions WHERE id=?").get(id);
    if (!row) throw new Error("예산 실행 기록이 없습니다.");
    return JSON.parse(String(row.record_json));
  }
  markDispatching(id: string): void {
    const execution = this.execution(id);
    if (execution.dispatchStarted) return;
    execution.dispatchStarted = true;
    this.db.prepare("UPDATE budget_executions SET record_json=? WHERE id=?").run(JSON.stringify(execution), id);
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
        // A recorded null is deliberately unbounded; only legacy rows without accountLimits use the merged limit.
        const limit = execution.accountLimits?.[accountId] === undefined ? execution.limit : execution.accountLimits[accountId];
        const exceeded = limit ? BUDGET_KEYS.filter(key => execution.used[key] >= limit[key]) : [];
        for (const key of BUDGET_KEYS) a.used[key] += delta[key];
        const policy = a.policy;
        const total = hasBudgetLimits(policy) ? BUDGET_KEYS.filter(key => a.used[key] >= policy.total[key]) : [];
        if (!a.pause && (exceeded.length || total.length)) a.pause = { executionId:id, detectedAt:now, deadline:now+60_000,
          reason: `${exceeded.length ? "실행" : "누적"} 예산 도달: ${(exceeded.length ? exceeded : total).join(", ")}` };
        this.save(a); return a;
      });
      execution.finished = finished;
      this.db.prepare("UPDATE budget_executions SET record_json=? WHERE id=?").run(JSON.stringify(execution), id);
      return accounts;
    });
  }
  // Startup only, after the previous server's actions/processes have been interrupted.
  // Only a durable pre-dispatch record with no token usage proves no paid call could be lost.
  // Started/legacy-unknown executions remain unfinished until usage is reconciled or explicitly granted.
  recoverInterruptedExecutions(): void {
    for (const row of this.db.prepare("SELECT record_json FROM budget_executions").all()) {
      const execution = JSON.parse(String(row.record_json)) as Execution;
      if (execution.finished || execution.dispatchStarted !== false || execution.used.inputTokens !== 0 || execution.used.outputTokens !== 0) continue;
      execution.finished = true;
      this.db.prepare("UPDATE budget_executions SET record_json=? WHERE id=?").run(JSON.stringify(execution), execution.id);
    }
  }
  // Explicitly acknowledge one finished execution stop. No automatic retry, discount, or reset:
  // the same total allowance, usage, execution evidence and all review/revision reservations survive.
  resumeExecution(id: string, requestId: string, executionId: string, expectedVersion: number): BudgetAccount {
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT account_id,record_json FROM budget_grants WHERE id=?").get(requestId);
      if (previous) {
        const saved = JSON.parse(String(previous.record_json));
        if (previous.account_id !== id || saved.kind !== "resume-execution" || saved.executionId !== executionId) {
          throw new Error("같은 요청 키의 재개 대상이 다릅니다.");
        }
        return this.account(id)!;
      }
      const account = this.account(id);
      if (!account || account.version !== expectedVersion) throw new Error("예산이 변경됐습니다. 새로 확인하세요.");
      if (account.pause?.executionId !== executionId) throw new Error("현재 중단된 실행만 재개할 수 있습니다.");
      const execution = this.execution(executionId);
      const unfinished = this.db.prepare("SELECT record_json FROM budget_executions").all()
        .map(row => JSON.parse(String(row.record_json)) as Execution)
        .some(row => !row.finished && row.accounts.includes(id));
      if (!execution.finished || !execution.accounts.includes(id) || unfinished) throw new Error("실행 종료와 사용량 기록을 먼저 확인하세요.");
      const policy = account.policy;
      if (hasBudgetLimits(policy) && BUDGET_KEYS.some(key => account.used[key] >= policy.total[key])) throw new Error("누적 예산이 소진되어 증액이 필요합니다.");
      const limit = execution.accountLimits?.[id] === undefined ? execution.limit : execution.accountLimits[id];
      if (!limit || !BUDGET_KEYS.some(key => execution.used[key] >= limit[key])) throw new Error("실행당 예산으로 중단된 기록이 아닙니다.");
      account.pause = null;
      account.version++;
      this.save(account);
      this.db.prepare("INSERT INTO budget_grants VALUES (?,?,?)").run(requestId, id,
        JSON.stringify({ kind: "resume-execution", executionId, policy: account.policy, version: account.version, at: Date.now() }));
      return account;
    });
  }
  grant(id: string, requestId: string, policy: BudgetPolicy, expectedVersion: number): BudgetAccount {
    policy = BudgetPolicySchema.parse(policy);
    return this.transaction(() => {
      const previous = this.db.prepare("SELECT account_id,record_json FROM budget_grants WHERE id=?").get(requestId);
      if (previous) {
        const saved = JSON.parse(String(previous.record_json));
        if (previous.account_id !== id || saved.kind === "resume-execution" || JSON.stringify(saved.policy) !== JSON.stringify(policy)) throw new Error("같은 요청 키의 예산이 다릅니다.");
        return this.account(id)!;
      }
      const a = this.account(id); if (!a) throw new Error("먼저 예산을 설정하세요.");
      policy = BudgetPolicySchema.parse(policy);
      if (a.version !== expectedVersion) throw new Error("예산이 변경됐습니다. 새로 확인하세요.");
      if (hasBudgetLimits(policy)) for (const key of BUDGET_KEYS) {
        if ((hasBudgetLimits(a.policy) && (policy.execution[key] < a.policy.execution[key] || policy.total[key] < a.policy.total[key]))
          || policy.total[key] <= a.used[key]) throw new Error("사용량보다 큰 예산을 지정하고 기존 상한을 낮추지 마세요.");
      }
      const interrupted = this.db.prepare("SELECT record_json FROM budget_executions").all()
        .map(row => JSON.parse(String(row.record_json)) as Execution)
        .filter(execution => !execution.finished && execution.accounts.includes(id));
      // The authenticated resume API first proves there is no active action. It may
      // acknowledge interrupted observation without inventing a numeric allowance.
      if (JSON.stringify(policy) === JSON.stringify(a.policy) && (hasBudgetLimits(policy) || !interrupted.length)) {
        throw new Error("변경할 정책이나 확인할 중단 실행이 없습니다.");
      }
      for (const execution of interrupted) {
        execution.finished = true;
        this.db.prepare("UPDATE budget_executions SET record_json=? WHERE id=?").run(JSON.stringify(execution),execution.id);
      }
      a.policy = policy; a.pause = null; a.version++;
      this.save(a);
      this.db.prepare("INSERT INTO budget_grants VALUES (?,?,?)").run(requestId,id,
        JSON.stringify({ policy, version:a.version, at:Date.now(), acknowledgedExecutions:interrupted.map(execution=>execution.id) }));
      return a;
    });
  }
  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
