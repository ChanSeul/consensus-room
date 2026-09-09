import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { USAGE_LIMIT_RETRY, type RetryClock } from "../src/server/engine/usageLimitRetry";
import { GitService } from "../src/server/git";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import { WorkflowEngine } from "../src/server/workflow";
import { parseResetTime, parseUsageLimit } from "../src/shared/usageLimit";

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
    expect(database.getTimeline("topic-1").some((event) => event.body.includes(`연속 ${USAGE_LIMIT_RETRY.maxConsecutive}회 썼는데도`))).toBe(true);

    // 재시작 시뮬레이션: 상한(3회)에 닿은 상태는 DB 에 남아 재시작해도 다시 예약하지 않는다(Codex 후속 지적 5). 사람이 retry 로 연다.
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
