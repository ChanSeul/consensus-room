import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { DatabaseSync } from "node:sqlite";

import { ConsensusDatabase } from "../src/server/database";
import type { ActionRecord } from "../src/server/types";
import type { Topic } from "../src/shared/contracts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function openDatabase(): { database: ConsensusDatabase; path: string } {
  const directory = mkdtempSync(join(tmpdir(), "consensus-room-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "room.sqlite");
  return { database: new ConsensusDatabase(path), path };
}

function topic(id = "topic-1"): Omit<Topic, "participants" | "planEpoch" | "agentSettings"> {
  const timestamp = new Date("2026-08-23T00:00:00.000Z").toISOString();
  return {
    id,
    slug: "task-cancellation",
    title: "취소 정책 정리",
    repositoryPath: "/tmp/repository",
    baseRef: "develop",
    worktreePath: "/tmp/worktree",
    branchPrefix: "consensus",
    requestedBranchName: null,
    predecessorTopicId: null,
    branchName: null,
    state: "DRAFT",
    scopeGeneration: 1,
    planRevision: 0,
    planSHA256: null,
    approvedPlanSHA256: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: null,
  };
}

function runningAction(id = "action-1", kind = "claude-plan"): ActionRecord {
  return {
    id,
    topicId: "topic-1",
    kind,
    status: "running",
    createdAt: "2026-08-23T00:00:01.000Z",
    finishedAt: null,
    error: null,
    pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null,
  };
}

describe("이벤트 원장과 재시작 복구", () => {
  it("사용자가 남긴 메시지를 주제별 순서대로 다시 읽는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());

    const first = database.appendEvent({
      topicId: "topic-1",
      actor: "user",
      kind: "note",
      state: "DRAFT",
      body: "기존 동작은 유지해 주세요.",
    });
    const second = database.appendEvent({
      topicId: "topic-1",
      actor: "user",
      kind: "evidence",
      state: "DRAFT",
      body: "실패 로그를 추가했습니다.",
      payload: { artifact: "failure.log" },
    });

    expect([first.sequence, second.sequence]).toEqual([1, 2]);
    expect(database.getTimeline("topic-1").map((event) => event.body)).toEqual([
      "기존 동작은 유지해 주세요.",
      "실패 로그를 추가했습니다.",
    ]);
    expect(database.getTimeline("topic-1", 1)).toEqual([second]);
    database.close();
  });

  it("전달 복구는 사용자가 확인한 정확한 요청 한 건만 닫는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.claimActionRequest("topic-1", "commit", "commit-key", {
      message: "커밋", paths: ["owned.txt"],
    });
    database.claimActionRequest("topic-1", "push", "push-key", {});
    database.recoverInterruptedDeliveryRequests();

    expect(database.unknownDeliveryAction("topic-1")).toMatchObject({
      action: "push", idempotencyKey: "push-key",
    });
    database.resolveUnknownDeliveryAction("topic-1", "push", "push-key", "failed");
    expect(database.unknownDeliveryAction("topic-1")).toMatchObject({
      action: "commit", idempotencyKey: "commit-key", request: { paths: ["owned.txt"] },
    });
    expect(database.getActionRequest("topic-1", "push", "push-key")).toMatchObject({
      status: "failed",
    });
    expect(database.getActionRequest("topic-1", "commit", "commit-key")).toMatchObject({
      status: "unknown",
    });
    database.close();
  });

  it("서버 재시작 때 전달 외 요청의 running idempotency key를 영구 대기 상태로 남기지 않는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.claimActionRequest("topic-1", "plan", "plan-key", {});

    database.recoverInterruptedNonDeliveryRequests();

    expect(database.getActionRequest("topic-1", "plan", "plan-key")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("새 요청으로 다시 실행"),
    });
    expect(database.claimActionRequest("topic-1", "plan", "new-plan-key", {})).toBe(true);
    database.close();
  });

  it("부작용이 끝난 요청은 재시작 복구가 성공으로 닫아 같은 키 재전송이 중복 실행되지 않는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.claimActionRequest("topic-1", "message:note", "note-key", { body: "메모" });
    // 서버가 이벤트 기록까지 마치고 원장 finish 직전에 죽은 상황.
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT", body: "메모",
      payload: { requestKey: "note-key" },
    });

    database.recoverInterruptedNonDeliveryRequests();

    const recovered = database.getActionRequest("topic-1", "message:note", "note-key");
    expect(recovered?.status).toBe("succeeded");
    // 같은 키 재청구가 거부되어(저장 응답 재생 경로) 이벤트가 다시 만들어질 수 없다.
    expect(database.claimActionRequest("topic-1", "message:note", "note-key", {})).toBe(false);
    expect(database.getTimeline("topic-1")).toHaveLength(1);
    database.close();
  });

  it("완료 기록이 없는 주제 생성만 실패로 바꾸고, 주제가 만들어진 생성은 성공으로 복구한다", () => {
    const { database } = openDatabase();
    // 완료된 생성: 주제가 실제로 존재.
    database.claimGlobalRequest("topic:create", "done-key", { title: "끝난 주제" });
    database.annotateGlobalRequest("topic:create", "done-key", {
      plannedTopicId: "topic-1", worktreePath: "/tmp/done-worktree",
    });
    database.createTopic(topic());
    // 미완 생성: worktree만 만들었을 수 있는 상태.
    database.claimGlobalRequest("topic:create", "lost-key", { title: "사라진 주제" });
    database.annotateGlobalRequest("topic:create", "lost-key", {
      plannedTopicId: "topic-ghost", worktreePath: "/tmp/ghost-worktree",
    });

    database.recoverInterruptedGlobalRequests();

    expect(database.getGlobalRequest("topic:create", "done-key")?.status).toBe("succeeded");
    const lost = database.getGlobalRequest("topic:create", "lost-key");
    expect(lost?.status).toBe("failed");
    expect(lost?.error).toContain("/tmp/ghost-worktree");
    expect(lost?.error).toContain("자동으로 지우지 않습니다");
    database.close();
  });

  it("서버가 꺼졌다 다시 열려도 마지막 확정 상태와 대화가 남는다", () => {
    const { database, path } = openDatabase();
    database.createTopic(topic());
    database.updateTopic("topic-1", { state: "CLAUDE_PLAN", planRevision: 1 });
    database.appendEvent({
      topicId: "topic-1",
      actor: "system",
      kind: "system",
      state: "CLAUDE_PLAN",
      body: "Claude 계획 작성을 시작했습니다.",
    });
    database.close();

    const reopened = new ConsensusDatabase(path);

    expect(reopened.getTopic("topic-1")).toMatchObject({
      state: "CLAUDE_PLAN",
      planRevision: 1,
    });
    expect(reopened.getTimeline("topic-1")).toHaveLength(1);
    reopened.close();
  });

  it("중단된 CLI 작업을 재시작 뒤 성공으로 바꾸지 않는다", () => {
    const { database, path } = openDatabase();
    database.createTopic(topic());
    database.startAction({
      id: "action-1",
      topicId: "topic-1",
      kind: "claude-plan",
      status: "running",
      createdAt: "2026-08-23T00:00:01.000Z",
      finishedAt: null,
      error: null,
      pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null,
    });
    database.close();

    const reopened = new ConsensusDatabase(path);
    reopened.recoverInterruptedActions();

    expect(reopened.runningAction("topic-1")).toBeNull();
    expect(reopened.getTopic("topic-1")).toMatchObject({
      state: "FAILED",
      lastError: "서버 재시작으로 실행이 중단되었습니다.",
    });
    expect(reopened.getFlags("topic-1").resumeState).toBe("DRAFT");
    reopened.close();
  });

  it("action 종료 뒤 주제 갱신이 실패하면 두 변경을 함께 되돌린다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.startAction({
      id: "action-1",
      topicId: "topic-1",
      kind: "claude-plan",
      status: "running",
      createdAt: "2026-08-23T00:00:01.000Z",
      finishedAt: null,
      error: null,
      pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null,
    });

    expect(() => database.finishActionAndFailTopic({
      actionId: "action-1",
      topicId: "topic-1",
      actionStatus: "failed",
      error: "실패",
      expectedScopeGeneration: 999,
    })).toThrow("같은 범위 세대");

    expect(database.getAction("action-1")).toMatchObject({ status: "running", finishedAt: null });
    expect(database.getTopic("topic-1")).toMatchObject({ state: "DRAFT", lastError: null });
    database.close();
  });

  it("같은 주제에서 실행 버튼을 연속으로 누르면 두 번째 작업을 거부한다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.startAction({
      id: "action-1",
      topicId: "topic-1",
      kind: "codex-review",
      status: "running",
      createdAt: "2026-08-23T00:00:01.000Z",
      finishedAt: null,
      error: null,
      pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null,
    });

    expect(() =>
      database.startAction({
        id: "action-2",
        topicId: "topic-1",
        kind: "codex-review",
        status: "running",
        createdAt: "2026-08-23T00:00:02.000Z",
        finishedAt: null,
        error: null,
        pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null,
      }),
    ).toThrow();
    database.close();
  });

  it("범위 세대가 오른 뒤의 이벤트를 이전 세대 프롬프트 조회에 섞지 않는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    const first = database.appendEvent({
      topicId: "topic-1",
      actor: "claude",
      kind: "agent_output",
      state: "CLAUDE_PLAN",
      body: "이전 범위의 계획 응답",
    });
    database.updateTopic("topic-1", { scopeGeneration: 2, state: "DRAFT" });
    const second = database.appendEvent({
      topicId: "topic-1",
      actor: "user",
      kind: "scope_change",
      state: "DRAFT",
      body: "범위를 바꿉니다.",
    });

    expect([first.scopeGeneration, second.scopeGeneration]).toEqual([1, 2]);
    expect(database.getScopedTimeline("topic-1", 1).map((event) => event.body)).toEqual([
      "이전 범위의 계획 응답",
    ]);
    expect(database.getScopedTimeline("topic-1", 2).map((event) => event.body)).toEqual([
      "범위를 바꿉니다.",
    ]);
    expect(database.getScopedTimeline("topic-1", 2, 2)).toEqual([]);
    expect(database.getTimeline("topic-1")).toEqual([first, second]);
    database.close();
  });

  // 세대 컬럼이 없던 DB의 기존 행은 세대를 올렸던 이벤트가 payload에 남긴 scopeGeneration 표식으로
  // 각자의 세대를 되살린다. 전 행을 현재 세대로 뭉개면 철회된 결정이 새 프롬프트에 다시 들어가고,
  // 기본값 1로 두면 세대가 오른 주제의 프롬프트가 통째로 빈다 — 둘 다 안 된다.
  it("세대 컬럼이 없던 DB를 열면 표식을 따라 각 이벤트의 세대를 되살린다", () => {
    const { database, path } = openDatabase();
    database.createTopic(topic());
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "decision", state: "AWAITING_USER_APPROVAL",
      body: "세대 1에서 승인했다가 철회된 결정",
    });
    // 과거 코드가 세대를 올릴 때 남기던 표식과 같은 형태의 이벤트.
    database.updateTopic("topic-1", { scopeGeneration: 3 });
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "scope_change", state: "DRAFT",
      body: "범위를 크게 바꿉니다.", payload: { scopeGeneration: 3 },
    });
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT", body: "세대 3의 메모",
    });
    database.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("DROP INDEX IF EXISTS timeline_topic_scope_sequence");
    legacy.exec("ALTER TABLE timeline_events DROP COLUMN scope_generation");
    legacy.close();

    const upgraded = new ConsensusDatabase(path);

    expect(upgraded.getScopedTimeline("topic-1", 1).map((event) => event.body)).toEqual([
      "세대 1에서 승인했다가 철회된 결정",
    ]);
    expect(upgraded.getScopedTimeline("topic-1", 3).map((event) => event.body)).toEqual([
      "범위를 크게 바꿉니다.",
      "세대 3의 메모",
    ]);
    expect(upgraded.getTimeline("topic-1")).toHaveLength(3);
    upgraded.appendEvent({
      topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT", body: "업그레이드 뒤 메모",
    });
    expect(upgraded.getScopedTimeline("topic-1", 3).at(-1)?.body).toBe("업그레이드 뒤 메모");
    upgraded.close();
  });

  it("상태 전이와 기록 이벤트는 함께 성공하거나 함께 없던 일이 된다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.upsertParticipant("topic-1", {
      role: "claude", sessionId: "claude-session", mode: "attached", acknowledgedPlanSHA256: null,
    });
    // 이벤트 직렬화가 실패하는 payload를 주입해 transaction 도중 실패를 재현한다.
    const poisoned: Record<string, unknown> = {};
    Object.defineProperty(poisoned, "requestKey", {
      enumerable: true,
      get() { throw new Error("이벤트 기록 도중 서버가 죽었습니다."); },
    });

    expect(() => database.applyTopicTransition({
      topicId: "topic-1",
      changes: { scopeGeneration: 2, planEpoch: 2, state: "DRAFT" },
      clearAcknowledgements: true,
      participants: [{ role: "claude", sessionId: "pending:new", mode: "created", acknowledgedPlanSHA256: null }],
      events: [{ actor: "user", kind: "scope_change", state: "DRAFT", body: "범위 변경", payload: poisoned }],
    })).toThrow("이벤트 기록 도중");

    // 세대·세션·이벤트 전부 원래대로다. 여기서 세대만 올라가 있으면 복구가 "마커 없음 = 미실행"으로 오판한다.
    expect(database.getTopic("topic-1")).toMatchObject({ scopeGeneration: 1, planEpoch: 1 });
    expect(database.getTopic("topic-1").participants[0]?.sessionId).toBe("claude-session");
    expect(database.getTimeline("topic-1")).toEqual([]);
    database.close();
  });

  it("세대 컬럼 추가와 백필 사이에 죽으면 컬럼 추가까지 함께 되돌린다", () => {
    // 백필 도중 크래시를 주입한다. 컬럼 추가만 커밋된 채 남으면 다음 실행이 백필을 영구히 건너뛴다.
    class CrashDuringBackfill extends ConsensusDatabase {
      protected override backfillTimelineGenerations(): void {
        throw new Error("백필 도중 서버가 죽었습니다.");
      }
    }
    const { database, path } = openDatabase();
    database.createTopic(topic());
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "evidence", state: "DRAFT", body: "레거시 근거",
    });
    database.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP INDEX IF EXISTS timeline_topic_scope_sequence");
    legacy.exec("ALTER TABLE timeline_events DROP COLUMN scope_generation");
    legacy.close();

    expect(() => new CrashDuringBackfill(path)).toThrow("백필 도중");

    const inspect = new DatabaseSync(path);
    const columns = inspect.prepare("PRAGMA table_info(timeline_events)").all() as Array<Record<string, unknown>>;
    inspect.close();
    expect(columns.some((column) => column.name === "scope_generation")).toBe(false);

    // 다음 실행은 컬럼이 없다고 보고 마이그레이션 전체를 다시 수행한다.
    const recovered = new ConsensusDatabase(path);
    expect(recovered.getScopedTimeline("topic-1", 1).map((event) => event.body)).toEqual(["레거시 근거"]);
    recovered.close();
  });

  it("표식이 없는 옛 대화는 어느 세대인지 알 수 없으므로 새 세대 프롬프트에 넣지 않는다", () => {
    const { database, path } = openDatabase();
    database.createTopic(topic());
    database.updateTopic("topic-1", { scopeGeneration: 3 });
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT", body: "표식 없이 남은 옛 메모",
    });
    database.close();

    const legacy = new DatabaseSync(path);
    legacy.exec("DROP INDEX IF EXISTS timeline_topic_scope_sequence");
    legacy.exec("ALTER TABLE timeline_events DROP COLUMN scope_generation");
    legacy.close();

    const upgraded = new ConsensusDatabase(path);

    // 표식이 없으면 세대 1로 남긴다. 어느 세대의 대화인지 증명할 수 없는 행을 현재 세대에 넣는 것보다
    // 프롬프트에서 빼는 쪽이 계약 4("이전 범위의 응답은 읽히면 안 됨")의 안전한 방향이다.
    expect(upgraded.getScopedTimeline("topic-1", 3)).toEqual([]);
    expect(upgraded.getScopedTimeline("topic-1", 1)).toHaveLength(1);
    upgraded.close();
  });

  it("완료된 주제는 실패한 action 때문에 FAILED로 굳지 않는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.updateTopic("topic-1", { state: "READY_TO_DELIVER" });
    database.startAction(runningAction());

    expect(database.finishActionAndFailTopic({
      actionId: "action-1",
      topicId: "topic-1",
      actionStatus: "failed",
      error: "전달 준비가 끝난 주제입니다.",
      expectedScopeGeneration: 1,
    })).toEqual({ actionFinished: true, topicFailed: false });

    expect(database.getAction("action-1")).toMatchObject({ status: "failed" });
    expect(database.getTopic("topic-1")).toMatchObject({ state: "READY_TO_DELIVER", lastError: null });
    expect(database.getFlags("topic-1").resumeState).toBeNull();
    database.close();
  });

  it("실행 중이던 단계의 실패는 그대로 FAILED와 재시도 지점으로 남긴다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.updateTopic("topic-1", { state: "CLAUDE_PLAN" });
    database.startAction(runningAction());

    expect(database.finishActionAndFailTopic({
      actionId: "action-1",
      topicId: "topic-1",
      actionStatus: "failed",
      error: "계획 실행이 실패했습니다.",
      expectedScopeGeneration: 1,
    })).toEqual({ actionFinished: true, topicFailed: true });

    expect(database.getAction("action-1")).toMatchObject({ status: "failed" });
    expect(database.getTopic("topic-1")).toMatchObject({
      state: "FAILED",
      lastError: "계획 실행이 실패했습니다.",
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_PLAN");
    database.close();
  });

  it("재시작 복구는 사용자 판단을 기다리는 주제의 남은 action만 성공으로 닫는다", () => {
    const { database, path } = openDatabase();
    database.createTopic(topic());
    database.updateTopic("topic-1", { state: "AWAITING_USER_APPROVAL" });
    database.startAction(runningAction());
    database.close();

    const reopened = new ConsensusDatabase(path);
    reopened.recoverInterruptedActions();

    expect(reopened.getAction("action-1")).toMatchObject({ status: "succeeded", error: null });
    expect(reopened.getAction("action-1")?.finishedAt).not.toBeNull();
    expect(reopened.getTopic("topic-1")).toMatchObject({
      state: "AWAITING_USER_APPROVAL",
      lastError: null,
    });
    expect(reopened.getFlags("topic-1").resumeState).toBeNull();
    reopened.close();
  });

  it("주제가 아직 없는 요청도 같은 멱등 키로 두 번 처리하지 않는다", () => {
    const { database } = openDatabase();

    expect(database.claimGlobalRequest("topics", "create-key", { title: "취소 정책 정리" })).toBe(true);
    expect(database.claimGlobalRequest("topics", "create-key", { title: "취소 정책 정리" })).toBe(false);
    expect(database.getGlobalRequest("topics", "create-key")).toMatchObject({ status: "running" });

    database.finishGlobalRequest("topics", "create-key", { id: "topic-1" });
    expect(database.getGlobalRequest("topics", "create-key")).toMatchObject({
      status: "succeeded",
      response: { id: "topic-1" },
      error: null,
    });

    expect(database.claimGlobalRequest("topics", "failed-key", {})).toBe(true);
    database.failGlobalRequest("topics", "failed-key", "저장소 경로를 찾을 수 없습니다.");
    expect(database.getGlobalRequest("topics", "failed-key")).toMatchObject({
      status: "failed",
      error: "저장소 경로를 찾을 수 없습니다.",
    });

    expect(database.claimGlobalRequest("topics", "interrupted-key", {})).toBe(true);
    database.recoverInterruptedGlobalRequests();

    expect(database.getGlobalRequest("topics", "interrupted-key")).toMatchObject({
      status: "failed",
      error: expect.stringContaining("남은 worktree"),
    });
    expect(database.getGlobalRequest("topics", "create-key")).toMatchObject({ status: "succeeded" });
    expect(database.getGlobalRequest("topics", "없는-키")).toBeNull();
    database.close();
  });

  it("사후 검증에서 남은 고아 커밋 OID를 원장에 보존한다", () => {
    const { database, path } = openDatabase();
    database.createTopic(topic());

    expect(database.getFlags("topic-1").orphanCommitOID).toBeNull();
    database.updateTopic("topic-1", { orphanCommitOID: "0".repeat(40) });
    database.close();

    const reopened = new ConsensusDatabase(path);
    expect(reopened.getFlags("topic-1").orphanCommitOID).toBe("0".repeat(40));
    reopened.updateTopic("topic-1", { orphanCommitOID: null });
    expect(reopened.getFlags("topic-1").orphanCommitOID).toBeNull();
    reopened.close();
  });
});


// 감사 부차 지적: 같은 키를 다른 본문에 재사용해도 예전 응답을 돌려줬다. 원장이 본문을 돌려줘야
// 라우트가 재사용을 검출할 수 있다.
describe("멱등 원장 본문", () => {
  it("action 원장이 claim 때 저장한 본문을 그대로 돌려준다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.claimActionRequest("topic-1", "message:note", "key-1", { body: "원래 본문" });

    expect(database.getActionRequest("topic-1", "message:note", "key-1")?.request)
      .toEqual({ body: "원래 본문" });
    database.close();
  });

  it("global 원장의 계획 좌표(annotation)는 요청 본문과 분리 저장된다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.claimGlobalRequest("topic:create", "key-1", { title: "새 주제" });
    database.annotateGlobalRequest("topic:create", "key-1", { plannedTopicId: "t-1" });

    // annotation이 request에 섞이면 같은 본문 재전송이 '다른 본문'으로 오판된다.
    expect(database.getGlobalRequest("topic:create", "key-1")?.request).toEqual({ title: "새 주제" });
    database.close();
  });
});

// 감사 부차 지적: 재시작 복구가 action을 구분하지 않고 같은 requestKey 마커만 찾았다.
describe("복구 마커의 action 구분", () => {
  it("다른 action의 완료 마커를 자기 완료로 가로채지 않는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    // note는 완료(마커 있음), decision은 부작용 전 중단(마커 없음) — 같은 키 문자열을 공유한다.
    database.claimActionRequest("topic-1", "message:note", "shared-key", {});
    database.claimActionRequest("topic-1", "message:decision", "shared-key", {});
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT",
      body: "완료된 note", payload: { requestKey: "shared-key", requestAction: "message:note" },
    });

    database.recoverInterruptedNonDeliveryRequests();

    expect(database.getActionRequest("topic-1", "message:note", "shared-key")?.status).toBe("succeeded");
    expect(database.getActionRequest("topic-1", "message:decision", "shared-key")?.status).toBe("failed");
    database.close();
  });

  it("requestAction이 없는 옛 마커는 기존 의미(키만 대조)로 접는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.claimActionRequest("topic-1", "message:note", "old-key", {});
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT",
      body: "옛 마커", payload: { requestKey: "old-key" },
    });

    database.recoverInterruptedNonDeliveryRequests();

    expect(database.getActionRequest("topic-1", "message:note", "old-key")?.status).toBe("succeeded");
    database.close();
  });
});

// 감사 최적화 지적: 타임라인 전체 읽기를 전용 쿼리로 대체했다 — 의미가 같아야 한다.
describe("타임라인 전용 쿼리", () => {
  it("maxSequence와 timelineCount가 전체 읽기와 같은 값을 낸다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    for (let index = 0; index < 5; index += 1) {
      database.appendEvent({
        topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT",
        body: `메시지 ${index}`, payload: {},
      });
    }

    expect(database.maxSequence("topic-1")).toBe(database.getTimeline("topic-1").at(-1)?.sequence);
    expect(database.timelineCount("topic-1")).toBe(database.getTimeline("topic-1").length);
    expect(database.maxSequence("no-such-topic")).toBe(0);
    database.close();
  });

  it("getPromptTimeline은 중요 이벤트 전부와 최근 이벤트를 세대별로 돌려준다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    // 중요 이벤트 하나를 맨 앞에 두고 note를 100개 쌓아 최근 80 창 밖으로 밀어낸다.
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "decision", state: "DRAFT",
      body: "오래된 결정", payload: {},
    });
    for (let index = 0; index < 100; index += 1) {
      database.appendEvent({
        topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT",
        body: `채움 ${index}`, payload: {},
      });
    }

    const prompt = database.getPromptTimeline("topic-1", 1);

    expect(prompt.some((event) => event.body === "오래된 결정")).toBe(true); // 중요 이벤트는 창 밖이어도 포함
    expect(prompt.some((event) => event.body === "채움 99")).toBe(true);     // 최근은 포함
    expect(prompt.some((event) => event.body === "채움 0")).toBe(false);     // 창 밖 note는 제외
    // 정렬 보존
    const sequences = prompt.map((event) => event.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    database.close();
  });
});

// 2026-09-07 제안 ④: 턴 사용량은 타임라인에 남기되 에이전트 프롬프트로는 되돌아가지 않는다.
describe("사용량 이벤트는 프롬프트 타임라인에서 뺀다", () => {
  it("payload.usage 가 있는 행은 getPromptTimeline 에 나오지 않고 getTimeline 에는 남는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT", body: "메시지", payload: {},
    });
    database.appendEvent({
      topicId: "topic-1", actor: "codex", kind: "system", state: "CODEX_REVIEW",
      body: "codex 턴 사용량 — 입력 1,200(캐시 1,000) · 출력 50 토큰 · 12초",
      payload: { usage: { inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 50, durationMs: 12_000, phase: "턴" } },
    });

    expect(database.getTimeline("topic-1").map((event) => event.body)).toEqual([
      "메시지", "codex 턴 사용량 — 입력 1,200(캐시 1,000) · 출력 50 토큰 · 12초",
    ]);
    expect(database.getPromptTimeline("topic-1", 1).map((event) => event.body)).toEqual(["메시지"]);
    database.close();
  });

  it("실행 한도 경고도 다음 모델 프롬프트에 넣지 않는다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.appendEvent({ topicId: "topic-1", actor: "system", kind: "system", state: "DRAFT", body: "한도 경고", payload: { executionWarning: { key: "toolCalls" } } });
    database.appendEvent({ topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT", body: "메시지", payload: {} });
    expect(database.getPromptTimeline("topic-1", 1).map((event) => event.body)).toEqual(["메시지"]);
    database.close();
  });
});

describe("코드 리뷰 세션의 저장과 범위 격리", () => {
  function approvedTopic(id = "topic-1") {
    return { ...topic(id), planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64) };
  }

  it("기존 DB 이행 시 계획 세션을 유지하고 리뷰 세션은 비어 있게 시작한다", () => {
    const { database, path } = openDatabase();
    database.createTopic(approvedTopic());
    database.upsertParticipant("topic-1", { role: "codex", sessionId: "planning", mode: "attached", acknowledgedPlanSHA256: "a".repeat(64) });
    database.close();
    const legacy = new DatabaseSync(path);
    legacy.exec("DROP TABLE codex_review_sessions");
    legacy.close();
    const reopened = new ConsensusDatabase(path);
    expect(reopened.getCodexReviewSession("topic-1")).toBeNull();
    expect(reopened.getTopic("topic-1").participants[0].sessionId).toBe("planning");
    reopened.close();
  });

  it.each([
    { scopeGeneration: 2 }, { planEpoch: 2 },
    { planSHA256: "b".repeat(64), approvedPlanSHA256: "b".repeat(64) },
    { approvedPlanSHA256: null },
  ])("범위·계획 회차·승인 계획이 달라지면 이전 리뷰 세션을 반환하지 않는다: %j", (changes) => {
    const { database } = openDatabase();
    database.createTopic(approvedTopic());
    database.setCodexReviewSession("topic-1", "review-one");
    expect(database.getCodexReviewSession("topic-1")).toBe("review-one");
    database.updateTopic("topic-1", changes);
    expect(database.getCodexReviewSession("topic-1")).toBeNull();
    if (changes.approvedPlanSHA256 === null) {
      expect(() => database.setCodexReviewSession("topic-1", "review-new")).toThrow("승인된 계획 없이");
    } else {
      database.setCodexReviewSession("topic-1", "review-new");
      expect(database.getCodexReviewSession("topic-1")).toBe("review-new");
    }
    database.close();
  });

  it("빈 ID·계획 세션·다른 주제의 계획 및 리뷰 세션을 섞지 않는다", () => {
    const { database } = openDatabase();
    database.createTopic(approvedTopic());
    database.createTopic(approvedTopic("topic-2"));
    for (const id of ["topic-1", "topic-2"]) {
      database.upsertParticipant(id, { role: "codex", sessionId: `planning-${id}`, mode: "attached", acknowledgedPlanSHA256: null });
    }
    database.setCodexReviewSession("topic-2", "review-two");
    for (const id of ["", " ", "pending:new", "planning-topic-1", "planning-topic-2", "review-two"]) {
      expect(() => database.setCodexReviewSession("topic-1", id)).toThrow();
    }
    expect(database.participantSessionInUse("topic-1", "codex", "review-two")).toBe(true);
    expect(database.getCodexReviewSession("topic-1")).toBeNull();
    expect(database.getCodexReviewSession("topic-2")).toBe("review-two");
    database.close();
  });
});

// 2026-09-08 Codex 제안 ⑥: 이어지는 턴에 새 이벤트만 싣기 위한 '전달한 sequence' 기록.
describe("전달한 타임라인 sequence 기록", () => {
  it("getPromptTimeline 은 afterSequence 뒤의 행만 돌려준다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    for (const body of ["첫 결정", "둘째 결정", "셋째 결정"]) {
      database.appendEvent({ topicId: "topic-1", actor: "user", kind: "decision", state: "DRAFT", body, payload: {} });
    }
    expect(database.getPromptTimeline("topic-1", 1).map((event) => event.body)).toEqual(["첫 결정", "둘째 결정", "셋째 결정"]);
    expect(database.getPromptTimeline("topic-1", 1, 2).map((event) => event.body)).toEqual(["셋째 결정"]);
    expect(database.getScopedTimeline("topic-1", 1, 3)).toEqual([]);
    database.close();
  });

  it("구현 세션이 바뀌면 전달한 sequence 는 비워지고, 같은 세션이면 유지된다", () => {
    const { database } = openDatabase();
    database.createTopic(topic());
    database.setImplementationSession("topic-1", "impl-a");
    database.updateTopic("topic-1", { implementationPromptSequence: 7 });
    database.setImplementationSession("topic-1", "impl-a");
    expect(database.getFlags("topic-1").implementationPromptSequence).toBe(7);
    database.setImplementationSession("topic-1", "impl-b");
    expect(database.getFlags("topic-1")).toMatchObject({ implementationSessionId: "impl-b", implementationPromptSequence: null });
    database.close();
  });

  it("리뷰 세션의 전달한 sequence 는 세션과 함께 살고 새 세션 저장 시 비워진다", () => {
    const { database } = openDatabase();
    database.createTopic({ ...topic(), planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64) });
    expect(database.getCodexReviewPromptSequence("topic-1")).toBeNull();
    database.setCodexReviewSession("topic-1", "review-1");
    expect(database.getCodexReviewPromptSequence("topic-1")).toBeNull();
    database.setCodexReviewPromptSequence("topic-1", 12);
    expect(database.getCodexReviewPromptSequence("topic-1")).toBe(12);
    database.setCodexReviewSession("topic-1", "review-2");
    expect(database.getCodexReviewPromptSequence("topic-1")).toBeNull();
    database.close();
  });
});
