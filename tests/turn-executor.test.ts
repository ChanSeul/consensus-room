import { mkdirSync, readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SpawnCommandRunner } from "../src/server/processRunner";
import { ClaudeAdapter } from "../src/server/adapters/claude";
import { CodexAdapter } from "../src/server/adapters/codex";
import { ConsensusDatabase } from "../src/server/database";
import type { AgentAdapter, CommandResult, CommandRunner, CommandSpec, SessionTurn } from "../src/server/types";
import { BudgetController } from "../src/server/budgetController";
import type { TurnJob } from "../src/shared/roles";
import { ArtifactStore } from "../src/server/artifacts";
import { GitService } from "../src/server/git";
import { EngineCore } from "../src/server/engine/core";
import { resolveRoute } from "../src/server/turnRouting";
import type { WorkflowState } from "../src/shared/contracts";

// PLAN §2 "다음 실행 허용" — 모델 호출은 공통 실행기(turnExecutor.ts)에서만 열리고, 허용 검사는 spawn 직전(비동기 준비 뒤·동기 마지막 검사)에 돈다.
const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("구조 — adapter 는 공통 실행기만 부른다", () => {
  it("engine/*.ts·workflow.ts·planning 에는 turnExecutor.ts 밖의 createSession/resumeTurn/resumePlanRepair 호출이 없다", () => {
    const engineDirectory = join(process.cwd(), "src", "server", "engine");
    const files = [...readdirSync(engineDirectory).map((name) => join(engineDirectory, name)), join(process.cwd(), "src", "server", "workflow.ts")];
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith("turnExecutor.ts")) continue;
      const source = readFileSync(file, "utf8");
      for (const pattern of [/\.createSession\(/g, /\.resumeTurn\(/g, /\.resumePlanRepair\b/g]) {
        if (pattern.test(source)) offenders.push(`${file.replace(process.cwd(), "")}: ${pattern.source}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("SpawnCommandRunner — spawn 직전 허용 검사", () => {
  function markerScript(marker: string): string[] {
    return ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "spawned")`];
  }
  it("beforeSpawn(비동기)이 던지면 프로세스는 뜨지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-runner-")); temporaryDirectories.push(root);
    const marker = join(root, "spawned.txt");
    const runner = new SpawnCommandRunner();
    await expect(runner.run({
      command: process.execPath, args: markerScript(marker), cwd: root,
      beforeSpawn: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); throw new Error("ADMISSION_REFUSED_ASYNC"); },
    })).rejects.toThrow("ADMISSION_REFUSED_ASYNC");
    expect(existsSync(marker)).toBe(false);
  });
  it("admitSync(동기 마지막 검사)가 던지면 프로세스는 뜨지 않고, 통과하면 비동기 검사 → 동기 검사 → spawn 순서다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-runner-")); temporaryDirectories.push(root);
    const marker = join(root, "spawned.txt");
    const runner = new SpawnCommandRunner();
    await expect(runner.run({
      command: process.execPath, args: markerScript(marker), cwd: root,
      beforeSpawn: async () => undefined, admitSync: () => { throw new Error("ADMISSION_REFUSED_SYNC"); },
    })).rejects.toThrow("ADMISSION_REFUSED_SYNC");
    expect(existsSync(marker)).toBe(false);
    const order: string[] = [];
    const result = await runner.run({
      command: process.execPath, args: markerScript(marker), cwd: root,
      beforeSpawn: async () => { await new Promise((resolve) => setTimeout(resolve, 5)); order.push("async"); },
      admitSync: () => { order.push("sync"); expect(existsSync(marker)).toBe(false); },   // 동기 검사 시점엔 아직 프로세스가 없다
      onSpawn: () => order.push("spawn"),
    });
    expect(result.exitCode).toBe(0);
    expect(order).toEqual(["async", "sync", "spawn"]);
    expect(existsSync(marker)).toBe(true);
  });
});

class RecordingRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];
  constructor(private readonly result: CommandResult) {}
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    // 실제 runner 와 같은 순서로 검사를 부른다.
    if (spec.beforeSpawn) await spec.beforeSpawn();
    spec.admitSync?.();
    return this.result;
  }
}
function successfulResult(jsonLines: unknown[]): CommandResult {
  return { exitCode: 0, stdout: jsonLines.map((line) => JSON.stringify(line)).join("\n"), stderr: "", jsonLines };
}
const agentResult = { kind: "IMPLEMENTATION", summary: "done", findings: [], evidenceRefs: [], status: "completed" };

describe("어댑터 — 허용 검사를 runner spec 으로 그대로 전달한다(내부 준비·슬롯 대기 뒤)", () => {
  it("ClaudeAdapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-claude-")); temporaryDirectories.push(root);
    const runner = new RecordingRunner(successfulResult([{ type: "result", subtype: "success", num_turns: 1, structured_output: agentResult }]));
    const adapter = new ClaudeAdapter(runner);
    const beforeSpawn = async () => undefined; const admitSync = () => undefined;
    await adapter.resumeTurn({ sessionId: "11111111-1111-4111-8111-111111111111", prompt: "p", cwd: root, implementation: true, beforeSpawn, admitSync });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].beforeSpawn).toBe(beforeSpawn);
    expect(runner.calls[0].admitSync).toBe(admitSync);
  });
  it("CodexAdapter — 슬롯 대기·관리형 홈 준비 뒤 runner 에 넘긴다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-codex-")); temporaryDirectories.push(root);
    const runner = new RecordingRunner(successfulResult([{ type: "thread.started", thread_id: "t-1" }, agentResult]));
    const adapter = new CodexAdapter(runner, join(root, "agent-result.schema.json"), join(root, "codex-home"), undefined, {});
    const beforeSpawn = async () => undefined; const admitSync = () => undefined;
    await adapter.resumeTurn({ sessionId: "t-1", prompt: "p", cwd: root, beforeSpawn, admitSync });
    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0].beforeSpawn).toBe(beforeSpawn);
    expect(runner.calls[0].admitSync).toBe(admitSync);
    expect(existsSync(join(root, "agent-result.schema.json"))).toBe(true);   // 준비(스키마 파일)는 검사보다 먼저 끝나 있다
  });
});

describe("예약 해제 — spawn 직전 거부로 실제 호출이 없었던 재작성·리뷰 예약", () => {
  function databaseWithTopic() {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-ledger-")); temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    database.createTopic({
      id: "t", slug: "t", title: "t", repositoryPath: root, baseRef: "develop", worktreePath: root, branchName: null, state: "DRAFT",
      scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z", lastError: null,
    });
    return database;
  }
  it("RevisionLedger.release 는 카운트된 시도만 되돌리고 없는 실행은 false", () => {
    const database = databaseWithTopic();
    const ledger = database.revisions;
    ledger.admit("t", "exec-1", "revision");
    expect(ledger.account("t").used).toBe(1);
    expect(ledger.release("t", "exec-1")).toBe(true);
    expect(ledger.account("t").used).toBe(0);
    expect(ledger.release("t", "exec-1")).toBe(false);
    ledger.admit("t", "exec-2", "revision");
    expect(ledger.release("other", "exec-2")).toBe(false);   // 다른 토픽의 실행은 건드리지 않는다
    expect(ledger.account("t").used).toBe(1);
    database.close();
  });
  it("ReviewLedger.release", () => {
    const database = databaseWithTopic();
    const ledger = database.reviews;
    ledger.admit("t", "exec-1", "implementation");
    expect(ledger.account("t", "implementation").used).toBe(1);
    expect(ledger.release("t", "exec-1")).toBe(true);
    expect(ledger.account("t", "implementation").used).toBe(0);
    database.close();
  });
});

// Astra CF-07·CF-08 — 실행 환경 정지(유지보수 거부)는 같은 단계로 재개하고, 무료 최초 계획 예약의 해제는 자격도 되돌린다.
describe("실행 허용 거부의 재개와 예약 복원", () => {
  it("CF-07: 감사 spawn 직전 유지보수 잠금으로 거부되면 retry 는 계획을 다시 만들지 않고 CODEX_AUDIT 를 재개한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-maint-")); temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    const at = new Date().toISOString();
    database.createTopic({ id: "t", slug: "t", title: "t", repositoryPath: root, baseRef: "develop", worktreePath: root, branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: at, updatedAt: at, lastError: null });
    for (const role of ["claude", "codex"] as const) database.upsertParticipant("t", { role, sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: null });
    database.budgets.configure("t", { execution: { inputTokens: 1000, outputTokens: 1000, durationMs: 60000 }, total: { inputTokens: 100000, outputTokens: 100000, durationMs: 600000 } }, "probe");
    const lock = join(root, "maintenance.json");
    const { REQUIRED_PLAN_HEADINGS } = await import("../src/shared/contracts");
    const plan = REQUIRED_PLAN_HEADINGS.map((h) => `## ${h}\n\n${h}${h === "허용 오차" ? '\n\n```tolerance\n{"scopePaths":["owned.txt"],"rules":[]}\n```' : ""}`).join("\n\n");
    let claudeCalls = 0, codexCalls = 0;
    const runClaude = async (turn: { beforeSpawn?: () => void | Promise<void>; admitSync?: () => void }) => { await turn.beforeSpawn?.(); turn.admitSync?.(); claudeCalls++; return { kind: "PLAN" as const, summary: "plan", planMarkdown: plan, findings: [], evidenceRefs: [] }; };
    const claude = { role: "claude" as const, validateExistingSession: async () => true, resumeTurn: runClaude, createSession: async (turn: Parameters<typeof runClaude>[0]) => ({ sessionId: "c", result: await runClaude(turn) }) };
    const runCodex = async (turn: { beforeSpawn?: () => void | Promise<void>; admitSync?: () => void }) => { codexCalls++; writeFileSync(lock, JSON.stringify({ at: new Date().toISOString(), reason: "probe" })); await turn.beforeSpawn?.(); turn.admitSync?.(); throw new Error("unexpected spawn"); };
    const codex = { role: "codex" as const, validateExistingSession: async () => true, resumeTurn: runCodex, createSession: async (turn: Parameters<typeof runCodex>[0]) => ({ sessionId: "x", result: await runCodex(turn) }) };
    const { WorkflowEngine } = await import("../src/server/workflow");
    const { ArtifactStore } = await import("../src/server/artifacts");
    const engine = new WorkflowEngine({ database, artifacts: new ArtifactStore(join(root, "topics"), database), git: {} as never, claude, codex, enforceBudgets: true, maintenanceLockPath: lock });
    const settled = async () => { while (database.runningAction("t")) await new Promise((resolve) => setTimeout(resolve, 10)); };
    engine.startPlan("t"); await settled();
    expect(database.getTopic("t").state).toBe("USER_DECISION_REQUIRED");
    expect(database.getFlags("t").resumeState).toBe("CODEX_AUDIT");
    const epoch = database.getTopic("t").planEpoch;
    expect(database.reviews.account("t", "planning").used).toBe(0);   // spawn 없이 거부된 리뷰 예약은 해제됐다
    rmSync(lock, { force: true });
    engine.retry("t"); await settled();
    expect(database.getTopic("t").planEpoch).toBe(epoch);
    expect(claudeCalls).toBe(1);          // 계획을 다시 만들지 않았다
    expect(codexCalls).toBe(2);           // 감사를 같은 단계에서 재개했다(가짜는 spawn 전에 실패한다)
    expect(database.getFlags("t").resumeState).toBe("CODEX_AUDIT");
    database.close();
  });
  it("CF-08: 무료 최초 계획 예약을 해제하면 자격도 돌아와 첫 실제 계획이 재작성 회차를 차감하지 않는다", () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-first-plan-")); temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    const at = new Date().toISOString();
    database.createTopic({ id: "u", slug: "u", title: "u", repositoryPath: root, baseRef: "develop", worktreePath: root, branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: at, updatedAt: at, lastError: null });
    const ledger = database.revisions;
    ledger.admit("u", "unspawned", "plan"); ledger.release("u", "unspawned");
    expect(ledger.account("u")).toMatchObject({ used: 0, firstPlanUsed: false });
    ledger.admit("u", "actual", "plan");
    expect(ledger.account("u")).toMatchObject({ used: 0, firstPlanUsed: true });
    ledger.admit("u", "second", "plan"); ledger.release("u", "second");   // 실제 계획이 이미 돈 뒤의 해제는 자격을 되살리지 않는다
    expect(ledger.account("u")).toMatchObject({ used: 0, firstPlanUsed: true });
    database.close();
  });
  it("HS-01: 서버가 샌드박스 안이면 spawn 없이 host-sandbox 로 멈추고, 샌드박스 밖에서 다시 띄운 엔진의 retry 는 같은 단계를 잇는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-host-sandbox-")); temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    const at = new Date().toISOString();
    database.createTopic({ id: "t", slug: "t", title: "t", repositoryPath: root, baseRef: "develop", worktreePath: root, branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: at, updatedAt: at, lastError: null });
    for (const role of ["claude", "codex"] as const) database.upsertParticipant("t", { role, sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: null });
    database.budgets.configure("t", { execution: { inputTokens: 1000, outputTokens: 1000, durationMs: 60000 }, total: { inputTokens: 100000, outputTokens: 100000, durationMs: 600000 } }, "probe");
    const lock = join(root, "maintenance.json");
    const { REQUIRED_PLAN_HEADINGS } = await import("../src/shared/contracts");
    const plan = REQUIRED_PLAN_HEADINGS.map((h) => `## ${h}\n\n${h}${h === "허용 오차" ? '\n\n```tolerance\n{"scopePaths":["owned.txt"],"rules":[]}\n```' : ""}`).join("\n\n");
    let claudeCalls = 0, codexCalls = 0;
    const runClaude = async (turn: { beforeSpawn?: () => void | Promise<void>; admitSync?: () => void }) => { await turn.beforeSpawn?.(); turn.admitSync?.(); claudeCalls++; return { kind: "PLAN" as const, summary: "plan", planMarkdown: plan, findings: [], evidenceRefs: [] }; };
    const claude = { role: "claude" as const, validateExistingSession: async () => true, resumeTurn: runClaude, createSession: async (turn: Parameters<typeof runClaude>[0]) => ({ sessionId: "c", result: await runClaude(turn) }) };
    // 두 번째 엔진의 감사는 CF-07 과 같은 유지보수 잠금으로 spawn 직전에 멈춰, 샌드박스 거부가 풀린 뒤 흐름이 감사까지 이어졌음을 끝에서 확인한다.
    const runCodex = async (turn: { beforeSpawn?: () => void | Promise<void>; admitSync?: () => void }) => { codexCalls++; writeFileSync(lock, JSON.stringify({ at: new Date().toISOString(), reason: "probe" })); await turn.beforeSpawn?.(); turn.admitSync?.(); throw new Error("unexpected spawn"); };
    const codex = { role: "codex" as const, validateExistingSession: async () => true, resumeTurn: runCodex, createSession: async (turn: Parameters<typeof runCodex>[0]) => ({ sessionId: "x", result: await runCodex(turn) }) };
    const { WorkflowEngine } = await import("../src/server/workflow");
    const settled = async () => { while (database.runningAction("t")) await new Promise((resolve) => setTimeout(resolve, 10)); };
    const detail = "/usr/bin/sandbox-exec rc 71: sandbox-exec: sandbox_apply: Operation not permitted";
    const sandboxed = new WorkflowEngine({ database, artifacts: new ArtifactStore(join(root, "topics"), database), git: {} as never, claude, codex, enforceBudgets: true, maintenanceLockPath: lock,
      hostSandbox: { kind: "unavailable", detail } });
    sandboxed.startPlan("t"); await settled();
    expect(database.getTopic("t").state).toBe("USER_DECISION_REQUIRED");
    const refusal = database.getTimeline("t").find((event) => event.payload?.admissionRefused === "host-sandbox");
    expect(refusal?.body).toContain(detail);
    expect(claudeCalls + codexCalls).toBe(0);                                          // 어떤 공급자도 부르지 않았다
    expect(database.revisions.account("t")).toMatchObject({ used: 0, firstPlanUsed: false });   // 무료 최초 계획 예약도 돌아왔다
    const resumeState = database.getFlags("t").resumeState;
    const restarted = new WorkflowEngine({ database, artifacts: new ArtifactStore(join(root, "topics"), database), git: {} as never, claude, codex, enforceBudgets: true, maintenanceLockPath: lock,
      hostSandbox: { kind: "available" } });
    restarted.retry("t"); await settled();
    expect(resumeState).toBe("CLAUDE_PLAN");
    expect(claudeCalls).toBe(1);          // 멈춘 계획 단계에서 이어 계획을 한 번 만들었다
    expect(codexCalls).toBe(1);           // 그 다음 단계(감사)까지 갔다
    expect(database.getFlags("t").resumeState).toBe("CODEX_AUDIT");
    expect(database.reviews.account("t", "planning").used).toBe(0);
    database.close();
  });
});

describe("서버 샌드박스 판정 — app.probeNestedSandbox", () => {
  it("중첩 적용이 되면 available, 거부(rc 71)·실행 실패면 unavailable, sandbox-exec 가 없거나 macOS 가 아니면 not-applicable 이다", async () => {
    const { probeNestedSandbox } = await import("../src/server/app");
    const calls: string[][] = [];
    const run = (status: number | null, stderr = "", error?: Error) => (command: string, args: string[]) => { calls.push([command, ...args]); return { status, stderr, error }; };
    expect(probeNestedSandbox({ platform: "darwin", run: run(0) })).toEqual({ kind: "available" });
    expect(calls[0]).toEqual(["/usr/bin/sandbox-exec", "-p", "(version 1)(allow default)", "/usr/bin/true"]);
    const nested = probeNestedSandbox({ platform: "darwin", run: run(71, "sandbox-exec: sandbox_apply: Operation not permitted\n") });
    expect(nested).toEqual({ kind: "unavailable", detail: "/usr/bin/sandbox-exec rc 71: sandbox-exec: sandbox_apply: Operation not permitted" });
    expect(probeNestedSandbox({ platform: "darwin", run: run(null, "", Object.assign(new Error("spawnSync /usr/bin/sandbox-exec ENOENT"), { code: "ENOENT" })) }).kind).toBe("not-applicable");
    expect(probeNestedSandbox({ platform: "darwin", run: run(null, "", Object.assign(new Error("spawnSync /usr/bin/sandbox-exec ETIMEDOUT"), { code: "ETIMEDOUT" })) }).kind).toBe("unavailable");
    const before = calls.length;
    expect(probeNestedSandbox({ platform: "linux", run: run(0) })).toEqual({ kind: "not-applicable", detail: "platform linux" });
    expect(calls.length).toBe(before);   // macOS 가 아니면 실행하지 않는다
  });
});

// E3-4c — 코드 리뷰 원장. 논리 리뷰 한 번의 읽기·최종 판정 호출은 원장 ID 하나로 리뷰 1회를 예약하고(ReviewLedger 예약은 ID 마다 멱등), 원장의 첫 spawn 뒤에는
// 어느 호출의 spawn 전 실패로도 예약을 되돌리지 않는다(원장의 spawn 기록은 PlanningStore 에 영속한다). 같은 판정의 계약 교정도 포함하며 원장 없는 호출은 각각 예약한다.
describe("E3-4c 코드 리뷰 원장 — 예산 래퍼의 예약·되돌림과 원장 신원", () => {
  const identity = { topicId: "t", kind: "codex-review" as const, scopeGeneration: 1, planEpoch: 0, planSHA256: null, reviewedTree: "tree-a", reportRevision: 3 };
  function reviewRoom() {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-review-ledger-")); temporaryDirectories.push(root);
    const path = join(root, "room.sqlite");
    let database = new ConsensusDatabase(path);
    database.createTopic({
      id: "t", slug: "t", title: "t", repositoryPath: root, baseRef: "develop", worktreePath: root, branchName: null, state: "CODEX_REVIEW",
      scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", lastError: null,
    });
    database.budgets.configure("t", { execution: { inputTokens: 1e9, outputTokens: 1e9, durationMs: 1e9 },
      total: { inputTokens: 1e10, outputTokens: 1e10, durationMs: 1e10 } }, "test");
    return { root, get database() { return database; }, reopen: () => { database.close(); database = new ConsensusDatabase(path); } };
  }
  // 예산 래퍼로 감싼 리뷰 좌석 대역 — prompt 로 spawn 전 실패(pre-spawn)·spawn 뒤 실패(post-spawn)·정상을 고른다.
  function reviewer(database: ConsensusDatabase, budgetsEnabled = true): AgentAdapter {
    const run = (turn: Omit<SessionTurn, "sessionId">) => {
      if (turn.prompt === "pre-spawn") throw new Error("CLI 준비 실패");
      turn.onProcessSpawn?.({ pid: 4545, pgid: 4545, executable: "fake", commandLine: "fake", startedAt: "now" });
      if (turn.prompt === "post-spawn") throw new Error("CLI 실행 실패");
      return { kind: "ACK" as const, summary: "ok", findings: [], evidenceRefs: [] };
    };
    const fake: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
      createSession: async (turn) => ({ sessionId: "s", result: run(turn) }), resumeTurn: async (turn) => run(turn) };
    return new BudgetController(database.budgets, () => ({ topicId: "t", accounts: ["t"], stage: "CODEX_REVIEW" }), async () => {},
      database.revisions, budgetsEnabled, database.reviews, database).wrap(fake);
  }
  const job = (operation: string) => ({ role: "reviewer", operation }) as TurnJob;
  const turn = (root: string, operation: string, prompt: string, reviewLedger?: string): SessionTurn =>
    ({ cwd: root, sessionId: "s", prompt, job: job(operation), ...(reviewLedger ? { reviewLedger } : {}) });
  const used = (database: ConsensusDatabase) => database.reviews.account("t", "implementation").used;

  it.each([true, false])("같은 원장의 읽기·판정·계약 교정은 리뷰 1회이고, 원장 없는 호출은 각각 센다(예산 적용: %s)", async (budgetsEnabled) => {
    const room = reviewRoom();
    room.database.reviews.configure(identity.topicId,"implementation",3,room.database.reviews.account(identity.topicId,"implementation").version);
    const ledger = room.database.planning.openReviewLedger(identity);
    const wrapped = reviewer(room.database, budgetsEnabled);
    await wrapped.createSession(turn(room.root, "review-read", "ok", ledger.id));
    await wrapped.resumeTurn(turn(room.root, "review-read", "ok", ledger.id));
    await wrapped.resumeTurn(turn(room.root, "review", "ok", ledger.id));
    expect(used(room.database)).toBe(1);
    await wrapped.resumeTurn(turn(room.root, "contract-correction", "ok", ledger.id));
    expect(used(room.database)).toBe(1);
    await wrapped.resumeTurn(turn(room.root, "review", "ok"));
    expect(used(room.database)).toBe(2);
    await wrapped.resumeTurn(turn(room.root, "contract-correction", "ok"));
    expect(used(room.database)).toBe(3);
    // 한도(3)에 닿아도 이미 예약한 원장의 호출은 새로 세지 않아 막히지 않고, 원장 없는 호출은 막힌다.
    await wrapped.resumeTurn(turn(room.root, "review-read", "ok", ledger.id));
    await wrapped.resumeTurn(turn(room.root, "contract-correction", "ok", ledger.id));
    expect(used(room.database)).toBe(3);
    await expect(wrapped.resumeTurn(turn(room.root, "review", "ok"))).rejects.toThrow("구현 리뷰 한도");
    await expect(wrapped.resumeTurn(turn(room.root, "answer-confirmation", "ok", ledger.id))).rejects.toThrow("구현 리뷰 한도");
    room.database.close();
  });

  it("원장의 첫 spawn 전 실패는 호출 단위로 되돌리고, 첫 spawn 뒤에는 DB 를 다시 열어도 뒤 호출의 spawn 전 실패로 원장 예약을 되돌리지 않는다", async () => {
    const room = reviewRoom();
    const ledger = room.database.planning.openReviewLedger(identity);
    await expect(reviewer(room.database).createSession(turn(room.root, "review-read", "pre-spawn", ledger.id))).rejects.toThrow("CLI 준비 실패");
    expect(used(room.database)).toBe(0);
    expect(room.database.planning.reviewLedgerSpawned(ledger.id)).toBe(false);

    await reviewer(room.database).createSession(turn(room.root, "review-read", "ok", ledger.id));
    expect(used(room.database)).toBe(1);
    expect(room.database.planning.reviewLedgerSpawned(ledger.id)).toBe(true);
    room.reopen();
    for (const [operation, prompt] of [["review-read", "pre-spawn"], ["review", "pre-spawn"], ["review", "post-spawn"]] as const) {
      await expect(reviewer(room.database).resumeTurn(turn(room.root, operation, prompt, ledger.id))).rejects.toThrow("CLI");
      expect(used(room.database)).toBe(1);
    }
    // 대조: 원장 없는 호출의 spawn 전 실패는 지금처럼 그 호출의 예약만 되돌린다.
    await expect(reviewer(room.database).resumeTurn(turn(room.root, "review", "pre-spawn"))).rejects.toThrow("CLI 준비 실패");
    expect(used(room.database)).toBe(1);
    room.database.close();
  });

  it("원장 신원: 판정 전 같은 신원은 같은 ID(DB 다시 열기 포함), 판정·새 tree·새 계약·다른 리뷰 종류는 새 ID 이고 옛 원장은 다시 이어지지 않는다", () => {
    const room = reviewRoom();
    const planning = () => room.database.planning;
    const first = planning().openReviewLedger(identity);
    expect(first).toMatchObject({ status: "open", reads: 0, spawned: false, createdSessions: [] });
    expect(planning().openReviewLedger(identity).id).toBe(first.id);
    room.reopen();
    expect(planning().openReviewLedger(identity).id).toBe(first.id);
    planning().noteReviewLedgerSession(first.id, "s1");
    planning().noteReviewLedgerSession(first.id, "s1");
    planning().noteReviewLedgerRead(first.id, "s1");
    expect(planning().reviewLedger(first.id)).toMatchObject({ createdSessions: ["s1"], reads: 1, session: "s1" });
    // 판정이 돌아오면 닫힌다 — 같은 신원도 새 원장이다(같은 ID 로 판정을 되풀이하지 않는다).
    planning().judgeReviewLedger(first.id);
    const second = planning().openReviewLedger(identity);
    expect(second.id).not.toBe(first.id);
    expect(planning().reviewLedger(first.id)?.status).toBe("judged");
    planning().completeReviewLedger(second.id);
    expect(planning().reviewLedger(second.id)?.status).toBe("completed");
    const third = planning().openReviewLedger(identity);
    expect(third.id).not.toBe(second.id);
    for (const change of [{ reviewedTree: "tree-b" }, { reportRevision: 4 }, { planEpoch: 1 }, { scopeGeneration: 2 }, { kind: "codex-final-review" as const }]) {
      const before = planning().latestReviewLedger("t")!;
      const opened = planning().openReviewLedger({ ...identity, ...change });
      expect(opened.id, JSON.stringify(change)).not.toBe(before.id);
    }
    // 가장 최근 원장만 산다 — tree 가 되돌아가도 옛 원장(third)을 잇지 않는다.
    expect(planning().openReviewLedger(identity).id).not.toBe(third.id);
    room.database.close();
  });
});

// E3-4c host-review 39d21df9 F004 — 세션별 메모리 본문 수신. 실행기는 모든 모델 턴이 지나는 결정 지점이다: 프로토콜 턴(ack·확인·리뷰 읽기)이 만든 세션을
// "메모리 본문 미수신"으로 적고, 그 세션의 첫 일반 resume 턴(계획 제어 턴 제외 — 계획 제어는 메모리를 조각으로 받는다)에 SessionTurn.memoryBodies 를 실어
// 어댑터가 본문을 한 번 싣게 한 뒤, 응답을 받으면 수신으로 적는다. 기록 없는 세션은 종전 의미(본문을 이미 받음)다. 실제 어댑터 + stdin 기록 러너로 바이트를 본다.
describe("E3-4c host-review 39d21df9 F004 — 프로토콜 턴이 만든 세션의 메모리 본문(실행기·실제 어댑터)", () => {
  const BODY = "EXECUTOR-MEMORY-BODY-MARKER";
  class StdinRunner implements CommandRunner {
    readonly calls: CommandSpec[] = [];
    private threads = 0;
    constructor(private readonly provider: "claude" | "codex") {}
    async run(spec: CommandSpec): Promise<CommandResult> {
      this.calls.push(spec);
      await spec.beforeSpawn?.(); spec.admitSync?.();
      spec.onSpawn?.({ pid: 123, pgid: 123, executable: this.provider, commandLine: this.provider, startedAt: new Date().toISOString() });
      const lines: unknown[] = [];
      if (this.provider === "codex") {
        const resume = spec.args.indexOf("resume");
        lines.push({ type: "thread.started", thread_id: resume >= 0 ? spec.args[resume + 1] : `executor-thread-${++this.threads}` });
      }
      lines.push({ kind: "ACK", summary: "확인했습니다.", findings: [], evidenceRefs: [] });
      // The real runner streams JSON events before returning its captured output.
      for (const line of lines) spec.onJSONLine?.(line, Date.now());
      return { exitCode: 0, stdout: lines.map((line) => JSON.stringify(line)).join("\n"), stderr: "", jsonLines: lines };
    }
  }
  function executorRoom(provider: "claude" | "codex") {
    const root = mkdtempSync(join(tmpdir(), `consensus-room-receipts-${provider}-`)); temporaryDirectories.push(root);
    const worktree = join(root, "worktree");
    const memory = join(root, "memory");
    mkdirSync(worktree, { recursive: true });
    mkdirSync(memory, { recursive: true });
    writeFileSync(join(memory, "context-router.md"), `# Context Router\n\n${BODY}\n`);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    database.createTopic({
      id: "t", slug: "t", title: "t", repositoryPath: worktree, baseRef: "develop", worktreePath: worktree, branchName: null, state: "IMPLEMENTING",
      scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
      createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", lastError: null,
    });
    const runner = new StdinRunner(provider);
    const adapter: AgentAdapter = provider === "claude" ? new ClaudeAdapter(runner, memory)
      : new CodexAdapter(runner, join(root, "agent-result.schema.json"), join(root, "codex-home"), memory);
    const idle: AgentAdapter = { role: provider === "claude" ? "codex" : "claude", validateExistingSession: async () => true,
      createSession: async () => { throw new Error("쓰지 않는 좌석"); }, resumeTurn: async () => { throw new Error("쓰지 않는 좌석"); } };
    const core = new EngineCore({ database, artifacts: new ArtifactStore(join(root, "topics"), database), git: new GitService(new SpawnCommandRunner()),
      claude: provider === "claude" ? adapter : idle, codex: provider === "codex" ? adapter : idle });
    // 한 action 안에서 턴을 연다(실행기는 action 의 signal·주제 상태를 현재성으로 대조한다).
    const inAction = async (work: (turn: (job: TurnJob, state: WorkflowState, session: string | null) => Promise<string>) => Promise<void>) => {
      let failure: unknown = null;
      core.startAction("t", "receipts", async (signal) => {
        const turn = async (job: TurnJob, state: WorkflowState, session: string | null) => {
          database.updateTopic("t", { state });
          const topic = database.getTopic("t");
          const route = resolveRoute(database, topic, job);
          const outcome = await core.executor.execute({ route, topic, signal, purpose: "턴", inputSequence: database.timelineCount("t"),
            expected: core.expectationOf(topic), session: session ? { mode: "resume", sessionId: session } : { mode: "create" },
            prompt: `${job.role}/${job.operation} 턴입니다.`, settings: route.settings });
          return outcome.sessionId;
        };
        try { await work(turn); } catch (error) { failure = error; }
      });
      const deadline = Date.now() + 10_000;
      while (database.runningAction("t")) {
        if (Date.now() > deadline) throw new Error("action 이 끝나지 않았습니다.");
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      if (failure) throw failure;
    };
    return { database, runner, inAction };
  }
  it.each(["claude", "codex"] as const)("%s 실제 spawn 메타데이터를 확정 세션에 저장한다", async provider => {
    const { database, inAction } = executorRoom(provider);
    try {
      let sessionId = "";
      await inAction(async turn => { sessionId = await turn({ role: provider === "claude" ? "planner" : "reviewer", operation: "ack" }, "IMPLEMENTING", null); });
      const records = database.sessions.forTopic("t");
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({ sessionId, provider, consumer: "consensus-engine", hostname: expect.any(String),
        hostOS: { platform: process.platform }, access: "none" });
    } finally { database.close(); }
  });
  const stdin = (runner: StdinRunner, index: number) => runner.calls[index].stdin ?? "";
  const hasBody = (text: string) => text.includes("--- 메모리 문서 시작: context-router.md ---") && text.includes(BODY);
  const JOBS = {
    claude: { protocol: { role: "planner", operation: "ack" }, work: { role: "implementer", operation: "implement" },
      planning: { role: "planner", operation: "revision" }, planningStage: "CLAUDE_REVISION" },
    codex: { protocol: { role: "reviewer", operation: "ack" }, work: { role: "reviewer", operation: "review" },
      planning: { role: "reviewer", operation: "audit" }, planningStage: "CODEX_AUDIT" },
  } as const;

  it.each(["claude", "codex"] as const)("%s: ACK 턴이 만든 세션의 첫 일반 resume 에 본문 1회, 다음은 매니페스트만 — 기록 없는 세션은 종전대로 매니페스트만", async (provider) => {
    const { database, runner, inAction } = executorRoom(provider);
    const jobs = JOBS[provider];
    const legacy = provider === "claude" ? "22222222-2222-4222-8222-222222222222" : "legacy-thread";
    let created = "";
    await inAction(async (turn) => {
      created = await turn(jobs.protocol, "IMPLEMENTING", null);
      expect(database.planning.sessionReceipt(created)).toMatchObject({ topicId: "t", protocolCreated: true, memoryBodies: false, reviewContext: false });
      await turn(jobs.work, "IMPLEMENTING", created);
      expect(database.planning.sessionReceipt(created)).toMatchObject({ memoryBodies: true });
      await turn(jobs.work, "IMPLEMENTING", created);
      await turn(jobs.work, "IMPLEMENTING", legacy);
    });
    // ACK(프로토콜) 턴은 본문·매니페스트 없이(종전), 그 세션의 첫 일반 resume 은 본문만(매니페스트 중복 없음), 다음 resume 은 매니페스트만.
    expect(hasBody(stdin(runner, 0))).toBe(false);
    expect(stdin(runner, 0)).not.toContain("메모리 스냅샷 갱신");
    expect(hasBody(stdin(runner, 1))).toBe(true);
    expect(stdin(runner, 1)).not.toContain("메모리 스냅샷 갱신");
    expect(hasBody(stdin(runner, 2))).toBe(false);
    expect(stdin(runner, 2)).toContain("메모리 스냅샷 갱신");
    // 기록 없는 기존 세션(배포 전 세션 포함)은 본문을 이미 받은 것으로 본다 — 재주입하지 않고 기록도 만들지 않는다.
    expect(hasBody(stdin(runner, 3))).toBe(false);
    expect(stdin(runner, 3)).toContain("메모리 스냅샷 갱신");
    expect(database.planning.sessionReceipt(legacy)).toBeNull();
    database.close();
  });

  it.each(["claude", "codex"] as const)("%s: 계획 제어 턴은 본문 수신 표시 없이 종전대로(조각으로 받는다) 가고, 그 뒤 첫 일반 턴이 본문을 한 번 받는다", async (provider) => {
    const { database, runner, inAction } = executorRoom(provider);
    const jobs = JOBS[provider];
    writeFileSync(join(database.getTopic("t").worktreePath, provider === "claude" ? "CLAUDE.md" : "AGENTS.md"), "지시문\n");
    database.planning.enable("t");
    expect(database.planning.enabled("t")).toBe(true);
    await inAction(async (turn) => {
      const created = await turn(jobs.protocol, jobs.planningStage, null);
      await turn(jobs.planning, jobs.planningStage, created);
      expect(database.planning.sessionReceipt(created)).toMatchObject({ protocolCreated: true, memoryBodies: false });
      await turn(jobs.work, "IMPLEMENTING", created);
      expect(database.planning.sessionReceipt(created)).toMatchObject({ memoryBodies: true });
    });
    expect(hasBody(stdin(runner, 1))).toBe(false);
    expect(stdin(runner, 1)).not.toContain("메모리 스냅샷 갱신");
    expect(hasBody(stdin(runner, 2))).toBe(true);
    database.close();
  });

  it("응답을 받지 못한 호출은 수신으로 적지 않는다 — 다음 일반 턴이 본문을 다시 싣는다", async () => {
    const { database, runner, inAction } = executorRoom("codex");
    let failNext = false;
    const run = runner.run.bind(runner);
    runner.run = async (spec) => {
      if (failNext) { failNext = false; runner.calls.push(spec); return { exitCode: 1, stdout: "", stderr: "Codex 실행 실패", jsonLines: [] }; }
      return run(spec);
    };
    await inAction(async (turn) => {
      const created = await turn(JOBS.codex.protocol, "IMPLEMENTING", null);
      failNext = true;
      await expect(turn(JOBS.codex.work, "IMPLEMENTING", created)).rejects.toThrow();
      expect(database.planning.sessionReceipt(created)).toMatchObject({ memoryBodies: false });
      await turn(JOBS.codex.work, "IMPLEMENTING", created);
      expect(database.planning.sessionReceipt(created)).toMatchObject({ memoryBodies: true });
    });
    expect(hasBody(stdin(runner, 1))).toBe(true);
    expect(hasBody(stdin(runner, 2))).toBe(true);
    database.close();
  });
});
