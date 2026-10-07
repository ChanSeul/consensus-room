import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { USAGE_LIMIT_RETRY, type RetryClock } from "../src/server/engine/usageLimitRetry";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import { WorkflowEngine } from "../src/server/workflow";
import { parseResetTime, parseUsageLimit } from "../src/shared/usageLimit";
import { REQUIRED_PLAN_HEADINGS, type AgentResult } from "../src/shared/contracts";
import { hashPlan } from "../src/shared/workflow";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

// 2026-09-08 Codex 제안 ①: 시스템 오류(사용 한도 429) 때문에 사람이 깨어서 retry 를 누르는 대기를 없앤다.
describe("사용 한도 메시지 해석", () => {
  const now = new Date("2026-09-07T22:10:00.000Z"); // KST 2026-09-08 07:10

  it("세션 한도 + 리셋 시각(am/pm, IANA 시간대)을 그 시간대의 다음 발생 시각으로 읽는다", () => {
    const parsed = parseUsageLimit("Claude 실행 실패(1): You've hit your session limit · resets 8:50am (Asia/Seoul) (429)", now);
    expect(parsed).toMatchObject({ kind: "session", retryable: true });
    expect(parsed?.resetAt?.toISOString()).toBe("2026-09-07T23:50:00.000Z"); // 같은 날 KST 08:50
  });

  it("이미 지난 시각은 다음 날로 본다", () => {
    const parsed = parseResetTime("resets 6:00am (Asia/Seoul)", now);
    expect(parsed?.toISOString()).toBe("2026-09-08T21:00:00.000Z"); // 다음 날 KST 06:00
  });

  it("주간 한도의 '월 일 at 시' 형식을 읽는다", () => {
    const parsed = parseUsageLimit("You've hit your weekly limit · resets Sep 6 at 1pm (Asia/Seoul) (429)", new Date("2026-09-05T00:00:00.000Z"));
    expect(parsed).toMatchObject({ kind: "weekly", retryable: true });
    expect(parsed?.resetAt?.toISOString()).toBe("2026-09-06T04:00:00.000Z"); // KST 13:00
  });

  it("지출 한도는 재시도 대상이 아니다", () => {
    const parsed = parseUsageLimit(
      "You've hit your org's monthly spend limit · run /usage-credits to ask your admin for a higher limit · your session limit resets 3:20pm (Asia/Seoul) (429)",
      now,
    );
    expect(parsed).toMatchObject({ kind: "monthly-spend", retryable: false });
  });

  it("리셋 시각이 없는 429 는 resetAt 없이 재시도 대상이고, 한도와 무관한 실패는 null 이다", () => {
    expect(parseUsageLimit("Codex 실행 실패(1): rate limit exceeded (429)", now)).toMatchObject({ kind: "unknown", resetAt: null, retryable: true });
    expect(parseUsageLimit("에이전트 응답 종류가 다릅니다: FIX (예상 IMPLEMENTATION)", now)).toBeNull();
    // 잘못된 시간대 이름은 서버 로컬 시간대로 떨어지되 던지지 않는다.
    expect(parseResetTime("resets 9:00am (Mars/Olympus)", now)).toBeInstanceOf(Date);
  });
});

class FakeClock implements RetryClock {
  current: number;
  readonly timers: Array<{ id: number; callback: () => void; delayMs: number }> = [];
  readonly cleared: number[] = [];
  private nextId = 1;

  constructor(start: string) { this.current = Date.parse(start); }
  now(): number { return this.current; }
  setTimeout(callback: () => void, delayMs: number): unknown {
    const id = this.nextId;
    this.nextId += 1;
    this.timers.push({ id, callback, delayMs });
    return id;
  }
  clearTimeout(handle: unknown): void { this.cleared.push(handle as number); }
  fire(): void {
    const timer = this.timers.shift();
    if (!timer) throw new Error("예약된 타이머가 없습니다.");
    this.current += timer.delayMs;
    timer.callback();
  }
}

// 호출 순서대로 정해진 실패를 던지는 계획 어댑터. 성공 응답은 이 테스트에 필요 없다 — 재시도가 '시작됐는지' 만 본다.
class FailingClaude implements AgentAdapter {
  readonly role = "claude" as const;
  calls = 0;
  constructor(private readonly errors: string[]) {}
  async createSession(_turn: Omit<SessionTurn, "sessionId">) { return this.fail(); }
  async resumeTurn(_turn: SessionTurn) { return this.fail(); }
  async validateExistingSession() { return true; }
  private fail(): never {
    const message = this.errors[Math.min(this.calls, this.errors.length - 1)];
    this.calls += 1;
    throw new Error(message);
  }
}

function makeEngine(errors: string[], clock: FakeClock) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-usage-limit-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  database.createTopic({
    id: "topic-1", slug: "usage-limit", title: "사용 한도", repositoryPath: "/tmp/repository", baseRef: "develop",
    worktreePath: "/tmp/worktree", branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0,
    planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-09-07T00:00:00.000Z", updatedAt: "2026-09-07T00:00:00.000Z",
    lastError: null,
  });
  database.revisions.configure("topic-1", 3, database.revisions.account("topic-1").version);
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant("topic-1", { role, sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: null });
  }
  const claude = new FailingClaude(errors);
  const codex: AgentAdapter = {
    role: "codex",
    createSession: async () => { throw new Error("이 테스트에서는 codex 를 부르지 않습니다."); },
    resumeTurn: async () => { throw new Error("이 테스트에서는 codex 를 부르지 않습니다."); },
    validateExistingSession: async () => true,
  };
  const engine = new WorkflowEngine({
    database, artifacts: new ArtifactStore(join(root, "topics"), database),
    git: new GitService({ run: async () => { throw new Error("사용하지 않습니다."); } }),
    claude, codex, clock,
  });
  return { database, engine, claude };
}

async function settle(database: ConsensusDatabase): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (database.runningAction("topic-1")) {
    if (Date.now() >= deadline) throw new Error("action 종료 대기 시간 초과");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

const SESSION_LIMIT = "Claude 실행 실패(1): You've hit your session limit · resets 8:50am (Asia/Seoul) (429)";

describe("사용 한도 자동 재시도", () => {
  it("429 로 FAILED 가 되면 리셋 시각 + 여유에 같은 주제를 retry 하고, 한도가 아닌 실패는 예약하지 않는다", async () => {
    const clock = new FakeClock("2026-09-07T22:10:00.000Z"); // KST 07:10 → 리셋 08:50 까지 100분
    const { database, engine, claude } = makeEngine([SESSION_LIMIT, "Claude 실행 실패(1): 가짜 오류"], clock);

    engine.startPlan("topic-1");
    await settle(database);
    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0].delayMs).toBe(100 * 60_000 + USAGE_LIMIT_RETRY.graceMs);
    const scheduled = database.getTimeline("topic-1").find((event) => event.body.includes("자동 재시도합니다(1/3)"));
    expect(scheduled?.payload).toMatchObject({ autoRetry: { attempt: 1, kind: "session", resetAt: "2026-09-07T23:50:00.000Z" } });
    expect(engine.scheduledRetryAt("topic-1")).toBe(new Date(clock.current + clock.timers[0].delayMs).toISOString());

    clock.fire();
    await settle(database);
    expect(claude.calls).toBe(2);
    expect(engine.scheduledRetryAt("topic-1")).toBeNull();
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("자동 재시도를 시작했습니다(1/3)"))).toBe(true);
    // 두 번째 실패는 한도가 아니므로 새 예약이 없다.
    expect(database.getTopic("topic-1")).toMatchObject({ state: "FAILED", lastError: expect.stringContaining("가짜 오류") });
    expect(clock.timers).toHaveLength(0);
    database.close();
  });

  it("사용자가 먼저 retry 하면 예약을 취소하고, 발화 시점에 FAILED 가 아니면 건너뛴다", async () => {
    const clock = new FakeClock("2026-09-07T22:10:00.000Z");
    const { database, engine } = makeEngine([SESSION_LIMIT, SESSION_LIMIT], clock);

    engine.startPlan("topic-1");
    await settle(database);
    const first = clock.timers[0];
    engine.retry("topic-1"); // 수동 retry → 새 action 시작 → 예약 취소
    await settle(database);
    expect(clock.cleared).toContain(first.id);
    // 두 번째 429 가 새 예약을 만들었다(연속 카운터는 자동 발화 기준이라 수동 retry 는 세지 않는다).
    expect(clock.timers.map((timer) => timer.id)).toEqual([first.id, first.id + 1]);
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.filter((body) => body.includes("자동 재시도합니다(1/3)"))).toHaveLength(2);

    // 취소된 첫 타이머가 어떤 이유로 발화해도 상태 검사로 무해하다: 지금은 FAILED 라 시작하지만 그 뒤 두 번째는 건너뛴다.
    clock.timers.shift(); // 취소된 타이머는 실제로는 발화하지 않는다
    database.updateTopic("topic-1", { state: "DRAFT", resumeState: null, lastError: null });
    clock.fire();
    expect(bodies.length).toBeGreaterThan(0);
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("건너뜁니다 — 주제가 이미 DRAFT"))).toBe(true);
    database.close();
  });

  it("지출 한도는 예약하지 않고 이유를 남긴다", async () => {
    const clock = new FakeClock("2026-09-07T22:10:00.000Z");
    const { database, engine } = makeEngine([
      "Claude 실행 실패(1): You've hit your org's monthly spend limit · your session limit resets 3:20pm (Asia/Seoul) (429)",
    ], clock);
    engine.startPlan("topic-1");
    await settle(database);
    expect(clock.timers).toHaveLength(0);
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("지출 한도(spend limit)는 관리자 조치가 필요해"))).toBe(true);
    database.close();
  });

  it("연속 자동 재시도는 3회까지이며, 재시작 뒤 restore 가 FAILED 주제의 예약을 복원한다", async () => {
    const clock = new FakeClock("2026-09-07T22:10:00.000Z");
    const { database, engine } = makeEngine([SESSION_LIMIT], clock);
    engine.startPlan("topic-1");
    await settle(database);
    for (let round = 1; round <= USAGE_LIMIT_RETRY.maxConsecutive; round += 1) {
      expect(clock.timers).toHaveLength(1);
      clock.fire();
      await settle(database);
    }
    expect(clock.timers).toHaveLength(0);
    expect(database.revisions.account("topic-1")).toMatchObject({used:3,limit:3});
    expect(database.getAutoRetry("topic-1")?.attempts).toBe(3);

    // 재시작 시뮬레이션: 상한(3회)에 닿은 상태는 DB 에 남아 재시작해도 다시 예약하지 않는다(Codex 후속 지적 5). 사람이 재작성 1회를 추가 승인해야 연다.
    const restartClock = new FakeClock("2026-09-20T00:00:00.000Z");
    const restarted = new WorkflowEngine({
      database, artifacts: new ArtifactStore(join(tmpdir(), "unused-topics"), database),
      git: new GitService({ run: async () => { throw new Error("사용하지 않습니다."); } }),
      claude: { role: "claude", createSession: async () => { throw new Error("x"); }, resumeTurn: async () => { throw new Error("x"); }, validateExistingSession: async () => true },
      codex: { role: "codex", createSession: async () => { throw new Error("x"); }, resumeTurn: async () => { throw new Error("x"); }, validateExistingSession: async () => true },
      clock: restartClock,
    });
    expect(restarted.restoreScheduledRetries()).toBe(0);
    expect(restartClock.timers).toHaveLength(0);
    database.close();
  });
});

// 2026-09-08 Codex 후속 지적 2·4·5: 예약은 stop 으로 취소되고, 상한·취소는 재시작을 넘어 지속되며, 다른 작업 잠금 중에는 발화하지 않는다.
describe("사용 한도 자동 재시도 — 취소·지속·잠금", () => {
  function restartedEngine(database: ConsensusDatabase, clock: FakeClock) {
    const dead: AgentAdapter = {
      role: "claude", createSession: async () => { throw new Error("x"); }, resumeTurn: async () => { throw new Error("x"); }, validateExistingSession: async () => true,
    };
    return new WorkflowEngine({
      database, artifacts: new ArtifactStore(join(tmpdir(), "unused-topics"), database),
      git: new GitService({ run: async () => { throw new Error("사용하지 않습니다."); } }),
      claude: dead, codex: { ...dead, role: "codex" }, clock,
    });
  }

  it("stop 은 예약을 취소하고, 취소한 예약은 재시작 뒤 복원되지 않는다", async () => {
    const clock = new FakeClock("2026-09-07T22:10:00.000Z");
    const { database, engine } = makeEngine([SESSION_LIMIT], clock);
    engine.startPlan("topic-1");
    await settle(database);
    expect(engine.scheduledRetryAt("topic-1")).not.toBeNull();

    engine.stop("topic-1"); // 실행 중 action 이 없어도 예약이 있으면 성공
    expect(engine.scheduledRetryAt("topic-1")).toBeNull();
    expect(clock.cleared).toHaveLength(1);
    expect(database.getAutoRetry("topic-1")).toMatchObject({ cancelled: true, scheduledAt: null });
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("사용자가 취소했습니다"))).toBe(true);
    expect(() => engine.stop("topic-1")).toThrow("중단할 실행이 없습니다");

    const restarted = restartedEngine(database, new FakeClock("2026-09-07T22:20:00.000Z"));
    expect(restarted.restoreScheduledRetries()).toBe(0);
    database.close();
  });

  it("상한(3회)에 닿은 직후 재시작해도 다시 예약하지 않고, 예약 중 재시작은 같은 시각으로 복원한다", async () => {
    const clock = new FakeClock("2026-09-07T22:10:00.000Z");
    const { database, engine } = makeEngine([SESSION_LIMIT], clock);
    engine.startPlan("topic-1");
    await settle(database);
    // 예약 중 재시작: 지속 상태의 예약 시각을 그대로 복원한다(1/3).
    const scheduledAt = database.getAutoRetry("topic-1")!.scheduledAt!;
    const midClock = new FakeClock(new Date(clock.current + 60_000).toISOString());
    const mid = restartedEngine(database, midClock);
    expect(mid.restoreScheduledRetries()).toBe(1);
    expect(midClock.timers[0].delayMs).toBe(scheduledAt - midClock.current);
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("예약을 복원했습니다") && event.body.includes("(1/3)"))).toBe(true);

    for (let round = 1; round <= USAGE_LIMIT_RETRY.maxConsecutive; round += 1) {
      clock.fire();
      await settle(database);
    }
    expect(database.getAutoRetry("topic-1")).toMatchObject({ attempts: 3, scheduledAt: null, cancelled: false });
    const soon = restartedEngine(database, new FakeClock(new Date(clock.current + 5 * 60_000).toISOString()));
    expect(soon.restoreScheduledRetries()).toBe(0);
    expect(soon.scheduledRetryAt("topic-1")).toBeNull();
    database.close();
  });

  it("범위 변경 잠금 중에 발화하면 상태를 바꾸지 않고 건너뛰고, 수동 retry 도 잠금 중이면 거부된다", async () => {
    const clock = new FakeClock("2026-09-07T22:10:00.000Z");
    const { database, engine } = makeEngine([SESSION_LIMIT], clock);
    engine.startPlan("topic-1");
    await settle(database);
    const core = (engine as unknown as { core: { scopeChangeActive: Set<string> } }).core;
    core.scopeChangeActive.add("topic-1");
    expect(() => engine.retry("topic-1")).toThrow("이미 실행 중인 작업이 있습니다");
    clock.fire();
    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(database.runningAction("topic-1")).toBeNull();
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("예약된 자동 재시도를 건너뜁니다"))).toBe(true);
    core.scopeChangeActive.delete("topic-1");
    database.close();
  });
});

// ---- E3-4c 보완: 마지막 허용 리뷰 도중 429 뒤 같은 코드 리뷰 원장·같은 예약으로 자동 재개 ----
// 공개 흐름: 실제 git 작업 트리에서 구현 → 코드 리뷰(마지막 허용 1회) → 리뷰 호출이 spawn 한 뒤 429 → FAILED → 자동 재시도 예약 → 시계 발화 → retry.
// 예산 강제를 켠다 — 원장의 spawn 은 예산 래퍼가 기록한다(E3-4c).
describe("E3-4c 코드 리뷰 원장과 사용 한도 자동 재시도", () => {
  function git(cwd: string, args: string[]): string {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }
  const TOLERANCE_BLOCK = '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';
  const validPlan = () => REQUIRED_PLAN_HEADINGS.map((heading) => `## ${heading}\n\n검증할 내용${heading === "허용 오차" ? TOLERANCE_BLOCK : ""}`).join("\n\n");
  const PROCESS = { pid: 123, pgid: 123, executable: "fake", commandLine: "fake", startedAt: "now" };

  class ImplementingClaude implements AgentAdapter {
    readonly role = "claude" as const;
    calls = 0;
    constructor(private readonly worktree: string) {}
    async createSession(turn: Omit<SessionTurn, "sessionId">) {
      turn.onSessionCreated?.("claude-impl");
      return { sessionId: "claude-impl", result: this.implement() };
    }
    async resumeTurn(_turn: SessionTurn) { return this.implement(); }
    async validateExistingSession() { return true; }
    private implement(): AgentResult {
      this.calls += 1;
      writeFileSync(join(this.worktree, "feature.txt"), `구현 ${this.calls}\n`);
      return { kind: "IMPLEMENTATION", summary: "구현했습니다.", findings: [], evidenceRefs: ["feature.txt"], status: "completed" };
    }
  }
  // 첫 리뷰 호출은 프로세스를 띄운 뒤 사용 한도로 실패하고, 그 뒤 호출은 문제 없는 리뷰를 돌려준다.
  class LimitedCodex implements AgentAdapter {
    readonly role = "codex" as const;
    readonly calls: string[] = [];
    async createSession(turn: Omit<SessionTurn, "sessionId">) {
      return { sessionId: "codex-review-session", result: this.review(turn) };
    }
    async resumeTurn(turn: SessionTurn) { return this.review(turn); }
    async validateExistingSession() { return true; }
    private review(turn: Omit<SessionTurn, "sessionId">): AgentResult {
      this.calls.push(turn.job?.operation ?? "");
      turn.onProcessSpawn?.(PROCESS);
      if (this.calls.length === 1) throw new Error(SESSION_LIMIT);
      return { kind: "REVIEW", summary: "문제 없습니다.", findings: [], evidenceRefs: ["feature.txt"] };
    }
  }

  async function lastAllowanceReview(label: string) {
    const root = mkdtempSync(join(tmpdir(), `consensus-room-usage-review-${label}-`));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const worktree = join(root, "worktrees", "topic");
    git(root, ["init", "--initial-branch=develop", repository]);
    git(repository, ["config", "user.name", "Consensus Room Test"]);
    git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
    writeFileSync(join(repository, "feature.txt"), "기준\n");
    git(repository, ["add", "feature.txt"]);
    git(repository, ["commit", "-m", "baseline"]);
    const gitService = new GitService(new SpawnCommandRunner());
    await gitService.createDetachedWorktree(repository, worktree, "develop");
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    const artifacts = new ArtifactStore(join(root, "topics"), database);
    const plan = validPlan();
    const planSHA256 = hashPlan(plan);
    const topicId = "topic-1";
    database.createTopic({
      id: topicId, slug: `usage-review-${label}`, title: "리뷰 한도와 자동 재시도", repositoryPath: repository, baseRef: "develop",
      worktreePath: worktree, branchName: null, state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 2, planSHA256,
      approvedPlanSHA256: planSHA256, createdAt: "2026-09-26T00:00:00.000Z", updatedAt: "2026-09-26T00:00:00.000Z", lastError: null,
    });
  database.revisions.configure(topicId, 3, database.revisions.account(topicId).version);
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure(topicId, scope, 3, database.reviews.account(topicId, scope).version);
    for (const role of ["claude", "codex"] as const) {
      database.upsertParticipant(topicId, { role, sessionId: `${role}-plan-session`, mode: "attached", acknowledgedPlanSHA256: planSHA256 });
    }
    await artifacts.write(topicId, "plan", 2, `${plan.trim()}\n`);
    database.budgets.configure(topicId, { execution: { inputTokens: 1_000_000, outputTokens: 1_000_000, durationMs: 10_000_000 },
      total: { inputTokens: 10_000_000, outputTokens: 10_000_000, durationMs: 100_000_000 } }, "test");
    // 구현 리뷰 한도 3회 가운데 2회를 앞서 썼다 — 이번 코드 리뷰가 마지막 허용 1회다.
    database.reviews.admit(topicId, "earlier-review-1", "implementation");
    database.reviews.admit(topicId, "earlier-review-2", "implementation");
    const clock = new FakeClock("2026-09-07T22:10:00.000Z");
    const claude = new ImplementingClaude(worktree);
    const codex = new LimitedCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude, codex, clock, enforceBudgets: true });
    engine.startImplementation(topicId);
    await waitForIdle(database, topicId);
    return { database, engine, clock, codex, worktree, topicId };
  }
  async function waitForIdle(database: ConsensusDatabase, topicId: string): Promise<void> {
    const deadline = Date.now() + 20_000;
    while (database.runningAction(topicId)) {
      if (Date.now() >= deadline) throw new Error("action 종료 대기 시간 초과");
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  const used = (database: ConsensusDatabase) => database.reviews.account("topic-1", "implementation").used;

  it("마지막 허용 리뷰가 spawn 뒤 429 로 끝나면 자동 재시도를 예약하고, 발화한 재시도는 같은 원장·같은 예약으로 리뷰를 마친다", async () => {
    const room = await lastAllowanceReview("held");
    const { database, clock, codex, topicId } = room;
    expect(database.getTopic(topicId)).toMatchObject({ state: "FAILED", lastError: expect.stringContaining("session limit") });
    expect(database.getFlags(topicId).resumeState).toBe("CODEX_REVIEW");
    const ledger = database.planning.latestReviewLedger(topicId)!;
    expect(ledger).toMatchObject({ status: "open", spawned: true, kind: "codex-review" });
    expect(used(database)).toBe(3);
    expect(database.reviews.account(topicId, "implementation").limit).toBe(3);
    // 가용 횟수가 0 이어도 같은 원장의 예약으로 이어지므로 자동 재시도를 예약했다.
    expect(clock.timers).toHaveLength(1);

    expect(room.engine.budgetResumeBlocker(topicId)).toBeNull();
    clock.fire();
    await waitForIdle(database, topicId);
    expect(database.getTimeline(topicId).some((event) => event.body.includes("자동 재시도를 시작했습니다(1/3)"))).toBe(true);
    expect(codex.calls).toEqual(["review", "review"]);
    expect(database.getTopic(topicId).state).toBe("READY_TO_DELIVER");
    expect(database.planning.latestReviewLedger(topicId)).toMatchObject({ id: ledger.id, status: "completed" });
    expect(used(database)).toBe(3);
    database.close();
  });

  it("발화 전에 원장이 판정으로 닫혔으면(새 예약이 필요) 발화한 자동 재시도를 건너뛰고 모델을 부르지 않는다", async () => {
    const room = await lastAllowanceReview("judged");
    const { database, clock, codex, topicId } = room;
    expect(clock.timers).toHaveLength(1);
    database.planning.completeReviewLedger(database.planning.latestReviewLedger(topicId)!.id);
    expect(room.engine.budgetResumeBlocker(topicId)).toContain("리뷰");
    clock.fire();
    await waitForIdle(database, topicId);
    expect(codex.calls).toEqual(["review"]);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(database.getTimeline(topicId).some((event) => event.body.includes("예약된 자동 재시도를 건너뜁니다"))).toBe(true);
    expect(used(database)).toBe(3);
    database.close();
  });

  it("발화 전에 주제의 계획 epoch 가 원장 신원과 달라졌으면 발화한 자동 재시도를 건너뛰고 모델을 부르지 않는다", async () => {
    const room = await lastAllowanceReview("epoch");
    const { database, clock, codex, topicId } = room;
    expect(clock.timers).toHaveLength(1);
    database.updateTopic(topicId, { planEpoch: database.getTopic(topicId).planEpoch + 1 });
    expect(room.engine.budgetResumeBlocker(topicId)).toContain("리뷰");
    clock.fire();
    await waitForIdle(database, topicId);
    expect(codex.calls).toEqual(["review"]);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(database.getTimeline(topicId).some((event) => event.body.includes("예약된 자동 재시도를 건너뜁니다"))).toBe(true);
    expect(used(database)).toBe(3);
    database.close();
  });

  // 원장의 호출이 모두 spawn 전에 실패하면 예산 래퍼가 예약을 되돌려 원장은 판정 전(open)인 채 예약이 없다. 그런 원장은 재시도가 이어 쓸 예약이 아니다.
  it("발화 전 최신 원장이 판정 전이지만 spawn 하지 않았으면(예약이 원장에 묶이지 않음) 발화한 자동 재시도를 건너뛰고 모델을 부르지 않는다", async () => {
    const room = await lastAllowanceReview("unspawned");
    const { database, clock, codex, topicId } = room;
    expect(clock.timers).toHaveLength(1);
    const held = database.planning.latestReviewLedger(topicId)!;
    const { id: _id, createdSessions: _sessions, session: _session, spawned: _spawned, reads: _reads, status: _status, createdAt: _created,
      updatedAt: _updated, ...identity } = held;
    const unspawned = database.planning.openReviewLedger({ ...identity, reviewedTree: "tree-whose-calls-never-spawned" });
    expect(unspawned).toMatchObject({ status: "open", spawned: false });
    expect(database.planning.latestReviewLedger(topicId)!.id).toBe(unspawned.id);
    clock.fire();
    await waitForIdle(database, topicId);
    expect(codex.calls).toEqual(["review"]);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(database.getTimeline(topicId).some((event) => event.body.includes("예약된 자동 재시도를 건너뜁니다"))).toBe(true);
    expect(used(database)).toBe(3);
    database.close();
  });

  it("검토 tree 가 바뀌면 사전 검사는 통과해도 실행 경로가 새 원장의 예약을 spawn 전에 막아 모델이 뜨지 않는다", async () => {
    const room = await lastAllowanceReview("tree");
    const { database, clock, codex, worktree, topicId } = room;
    const ledger = database.planning.latestReviewLedger(topicId)!;
    writeFileSync(join(worktree, "feature.txt"), "리뷰 뒤에 바뀐 작업 트리\n");
    clock.fire();
    await waitForIdle(database, topicId);
    expect(codex.calls).toEqual(["review"]);
    const topic = database.getTopic(topicId);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(database.getTimeline(topicId).at(-1)?.payload).toMatchObject({ reviewPause: "implementation", resumeState: "CODEX_REVIEW" });
    expect(database.planning.latestReviewLedger(topicId)!.id).not.toBe(ledger.id);
    expect(used(database)).toBe(3);
    database.close();
  });
});
