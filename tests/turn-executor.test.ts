import { readdirSync, readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { SpawnCommandRunner } from "../src/server/processRunner";
import { ClaudeAdapter } from "../src/server/adapters/claude";
import { CodexAdapter } from "../src/server/adapters/codex";
import { ConsensusDatabase } from "../src/server/database";
import type { CommandResult, CommandRunner, CommandSpec } from "../src/server/types";

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
