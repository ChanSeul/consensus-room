import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import type { AgentAdapter, CommandRunner, ProjectMemoryWriter } from "../src/server/types";
import { WorkflowEngine } from "../src/server/workflow";
import { REQUIRED_PLAN_HEADINGS, type AgentResult } from "../src/shared/contracts";
import { hashPlan, normalizePlan, redactSecrets } from "../src/shared/workflow";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class RecordingGitRunner implements CommandRunner {
  readonly args: string[][] = [];
  private staged = false;

  async run(spec: Parameters<CommandRunner["run"]>[0]) {
    this.args.push(spec.args);
    const command = spec.args[0];
    let stdout = "";
    if (command === "branch" && spec.args[1] === "--show-current") stdout = "consensus/scope-ab12\n";
    // 리뷰 시점 트리 스냅샷은 임시 index(GIT_INDEX_FILE)에 add 하므로 실제 index 를 stage 한 것으로 치지 않는다.
    if (command === "add" && !spec.environment?.GIT_INDEX_FILE) this.staged = true;
    if (command === "diff" && spec.args.includes("--cached") && this.staged) {
      stdout = "owned.txt\0";
    }
    if (command === "diff-tree") stdout = spec.args.includes("-p") ? "diff --git a/owned.txt b/owned.txt\n+수정\n" : "owned.txt\0";
    if (command === "write-tree") stdout = `${"b".repeat(40)}\n`;
    if (command === "rev-parse") stdout = spec.args.includes("--absolute-git-dir") ? `${tmpdir()}\n` : "a".repeat(40);
    return { exitCode: 0, stdout, stderr: "", jsonLines: [] };
  }
}

function makeEngine(
  state: "DRAFT" | "AWAITING_USER_APPROVAL" | "READY_TO_DELIVER",
  planSHA256: string | null,
  alreadyApproved = false,
  runner: CommandRunner | null = null,
) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-engine-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  database.createTopic({
    id: "topic-1",
    slug: "scope",
    title: "범위 변경",
    repositoryPath: "/tmp/repository",
    baseRef: "develop",
    worktreePath: "/tmp/worktree",
    branchName: state === "READY_TO_DELIVER" ? "consensus/scope-ab12" : null,
    state,
    scopeGeneration: 3,
    planRevision: planSHA256 ? 2 : 0,
    planSHA256,
    approvedPlanSHA256: alreadyApproved ? planSHA256 : null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    lastError: null,
  });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant("topic-1", {
      role,
      sessionId: `${role}-session`,
      mode: "attached",
      acknowledgedPlanSHA256: planSHA256,
    });
  }
  if (state === "READY_TO_DELIVER") {
    const head = "a".repeat(40);
    const diffSHA256 = createHash("sha256").update(`BASE\0${head}\0`, "utf8").digest("hex");
    database.updateTopic("topic-1", { reviewedHead: head, reviewedDiffSHA256: diffSHA256 });
  }
  const unavailableAdapter = (role: "claude" | "codex"): AgentAdapter => ({
    role,
    createSession: async () => { throw new Error("이 테스트에서는 CLI를 호출하지 않습니다."); },
    resumeTurn: async () => { throw new Error("이 테스트에서는 CLI를 호출하지 않습니다."); },
    validateExistingSession: async () => false,
  });
  const unavailableRunner: CommandRunner = runner ?? {
    run: async () => { throw new Error("이 테스트에서는 Git을 호출하지 않습니다."); },
  };
  const engine = new WorkflowEngine({
    database,
    artifacts: new ArtifactStore(join(root, "topics"), database),
    git: new GitService(unavailableRunner),
    claude: unavailableAdapter("claude"),
    codex: unavailableAdapter("codex"),
  });
  return { database, engine };
}

describe("범위 세대", () => {
  it("사용자가 범위를 바꾸면 세대를 하나 올리고 이전 계획·승인·ACK를 전부 무효로 한다", async () => {
    const sha = "a".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha, true);

    const changed = await engine.handleScopeChange("topic-1", "푸시 알림도 이번 범위에 넣어 주세요.");

    expect(changed).toMatchObject({
      state: "DRAFT",
      scopeGeneration: 4,
      planRevision: 0,
      planSHA256: null,
      approvedPlanSHA256: null,
    });
    expect(changed.participants.map((participant) => participant.acknowledgedPlanSHA256)).toEqual([
      null,
      null,
    ]);
    const scopeChange = database.getTimeline("topic-1").findLast((event) => event.kind === "scope_change");
    expect(scopeChange).toMatchObject({
      actor: "user",
      kind: "scope_change",
      body: "푸시 알림도 이번 범위에 넣어 주세요.",
      payload: { scopeGeneration: 4 },
    });
    // 세대가 갈렸다는 사실은 사용자에게 남겨야 한다. 이전 세대 대화가 프롬프트에서 조용히 사라지지 않도록.
    expect(database.getTimeline("topic-1").at(-1)?.body).toContain("이전 세대의 대화와 에이전트 응답");
    database.close();
  });

  it("계획 작성 중 범위를 바꾸면 취소된 이전 작업이 새 세대 상태를 FAILED로 덮지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-stale-scope-"));
    temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    database.createTopic({
      id: "topic-1",
      slug: "stale",
      title: "늦은 결과",
      repositoryPath: "/tmp/repository",
      baseRef: "develop",
      worktreePath: "/tmp/worktree",
      branchName: null,
      state: "DRAFT",
      scopeGeneration: 1,
      planRevision: 0,
      planSHA256: null,
      approvedPlanSHA256: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastError: null,
    });
    for (const role of ["claude", "codex"] as const) {
      database.upsertParticipant("topic-1", {
        role,
        sessionId: `${role}-session`,
        mode: "attached",
        acknowledgedPlanSHA256: null,
      });
    }
    let started!: () => void;
    const turnStarted = new Promise<void>((resolve) => { started = resolve; });
    let observedAbort!: () => void;
    const abortObserved = new Promise<void>((resolve) => { observedAbort = resolve; });
    let allowProcessClose!: () => void;
    const processMayClose = new Promise<void>((resolve) => { allowProcessClose = resolve; });
    const blockingClaude: AgentAdapter = {
      role: "claude",
      createSession: async () => { throw new Error("사용하지 않습니다."); },
      resumeTurn: ({ signal }) => {
        started();
        return new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => {
            observedAbort();
            void processMayClose.then(() => reject(signal.reason));
          }, { once: true });
        });
      },
      validateExistingSession: async () => true,
    };
    const unusedCodex: AgentAdapter = {
      role: "codex",
      createSession: async () => { throw new Error("사용하지 않습니다."); },
      resumeTurn: async () => { throw new Error("사용하지 않습니다."); },
      validateExistingSession: async () => true,
    };
    const unavailableRunner: CommandRunner = {
      run: async () => { throw new Error("사용하지 않습니다."); },
    };
    const engine = new WorkflowEngine({
      database,
      artifacts: new ArtifactStore(join(root, "topics"), database),
      git: new GitService(unavailableRunner),
      claude: blockingClaude,
      codex: unusedCodex,
    });

    engine.startPlan("topic-1");
    await turnStarted;
    expect(() => engine.startPlan("topic-1")).toThrow("이미 실행 중인 작업");
    const scopeChange = engine.handleScopeChange("topic-1", "새 범위로 다시 계획합니다.");
    await abortObserved;

    expect(database.runningAction("topic-1")).toMatchObject({ status: "running" });
    expect(database.getTopic("topic-1")).toMatchObject({ state: "CLAUDE_PLAN", scopeGeneration: 1 });

    allowProcessClose();
    await scopeChange;

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "DRAFT",
      scopeGeneration: 2,
      lastError: null,
    });
    expect(database.getTimeline("topic-1").findLast((event) => event.kind === "scope_change")).toMatchObject({
      kind: "scope_change",
      body: "새 범위로 다시 계획합니다.",
      payload: { scopeGeneration: 2 },
    });
    database.close();
  });

  it("새 세대의 첫 계획 프롬프트에 이전 세대의 계획 해시·쟁점·승인 결정이 들어가지 않는다", async () => {
    const firstRevised = validPlan("첫 세대 개정 계획");
    const firstSHA = hashPlan(`${firstRevised.trim()}\n`);
    const secondRevised = validPlan("두 번째 세대 개정 계획");
    const secondSHA = hashPlan(`${secondRevised.trim()}\n`);
    const disposed = finding("F-GEN1", "첫 세대에서만 나온 쟁점");
    const { database, engine, claude } = makePlanningEngine({
      slug: "generation-isolation",
      claudeResults: [
        { kind: "PLAN", summary: "첫 세대 계획", planMarkdown: validPlan("첫 세대 계획"), findings: [], evidenceRefs: [] },
        {
          kind: "REVISION",
          summary: "첫 세대 개정",
          planMarkdown: firstRevised,
          findings: [disposed],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: firstSHA, findings: [], evidenceRefs: [] },
        {
          kind: "PLAN",
          summary: "두 번째 세대 계획",
          planMarkdown: validPlan("두 번째 세대 계획"),
          findings: [],
          evidenceRefs: [],
        },
        {
          kind: "REVISION",
          summary: "두 번째 세대 개정",
          planMarkdown: secondRevised,
          findings: [],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: secondSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        {
          kind: "AUDIT",
          summary: "첫 세대 감사",
          findings: [finding("F-GEN1", "첫 세대에서만 나온 쟁점", { disposition: undefined })],
          evidenceRefs: [],
        },
        {
          kind: "CLOSEOUT",
          summary: "첫 세대 종료",
          planSHA256: firstSHA,
          findings: [disposed],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: firstSHA, findings: [], evidenceRefs: [] },
        { kind: "AUDIT", summary: "두 번째 세대 감사", findings: [], evidenceRefs: [] },
        {
          kind: "CLOSEOUT",
          summary: "두 번째 세대 종료",
          planSHA256: secondSHA,
          findings: [],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: secondSHA, findings: [], evidenceRefs: [] },
      ],
    });

    const firstApproval = waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    engine.startPlan("topic-1");
    await firstApproval;
    await waitForActionCompletion(database, "topic-1");
    engine.approve("topic-1", firstSHA);
    await engine.handleScopeChange("topic-1", "두 번째 세대 범위로 다시 계획합니다.");

    const secondApproval = waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    engine.startPlan("topic-1");
    await secondApproval;
    await waitForActionCompletion(database, "topic-1");

    expect(claude.calls).toHaveLength(6);
    const secondGenerationPlanPrompt = claude.calls[3];
    expect(secondGenerationPlanPrompt).toContain("범위 세대: 2");
    expect(secondGenerationPlanPrompt).toContain("두 번째 세대 범위로 다시 계획합니다.");
    expect(secondGenerationPlanPrompt).not.toContain(firstSHA);
    expect(secondGenerationPlanPrompt).not.toContain("F-GEN1");
    expect(secondGenerationPlanPrompt).not.toContain("현재 계획 버전의 구현을 승인했습니다.");
    database.close();
  });

  it("이미 닫은 주제는 범위 변경으로 되살리지 않는다", async () => {
    const { database, engine } = makeEngine("READY_TO_DELIVER", "e".repeat(64), true);
    database.updateTopic("topic-1", { branchName: null });
    engine.close("topic-1");

    await expect(engine.handleScopeChange("topic-1", "닫힌 주제를 다시 열어 주세요."))
      .rejects.toThrow("닫은 주제");

    expect(database.getTopic("topic-1")).toMatchObject({ state: "CLOSED", scopeGeneration: 3 });
    expect(database.getTimeline("topic-1").some((event) => event.kind === "scope_change")).toBe(false);
    database.close();
  });
});

describe("사용자 계획 승인", () => {
  it("사용자가 두 모델이 확인한 현재 해시를 승인하면 그 버전만 기록한다", () => {
    const sha = "b".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha);

    const approved = engine.approve("topic-1", sha);

    expect(approved.approvedPlanSHA256).toBe(sha);
    expect(database.getTimeline("topic-1").at(-1)).toMatchObject({
      actor: "user",
      kind: "decision",
      payload: { planSHA256: sha },
    });
    database.close();
  });

  it("사용자가 예전 계획 해시를 승인하면 현재 계획 승인으로 기록하지 않는다", () => {
    const current = "c".repeat(64);
    const old = "d".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", current);

    expect(() => engine.approve("topic-1", old)).toThrow("일치하지 않습니다");
    expect(database.getTopic("topic-1").approvedPlanSHA256).toBeNull();
    database.close();
  });

  it("합의 뒤 새 메시지가 오면 기존 SHA 승인과 ACK를 취소하고 구현을 막는다", async () => {
    const sha = "c".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha, true);

    const changed = await engine.postMessage("topic-1", "decision", "삭제 동작도 계획에 넣어 주세요.");

    expect(changed).toMatchObject({
      state: "DRAFT",
      // 계획만 무효화하는 경로는 범위가 그대로다. 세대 대신 planEpoch을 올린다.
      scopeGeneration: 3,
      planEpoch: 2,
      planSHA256: null,
      approvedPlanSHA256: null,
    });
    expect(changed.participants.every((participant) => participant.acknowledgedPlanSHA256 === null)).toBe(true);
    expect(() => engine.startImplementation("topic-1")).toThrow("구현 승인을 기다리는 상태");
    database.close();
  });

  it("계획 무효화는 세션과 이전 대화를 유지해 두 에이전트가 같은 맥락에서 다시 수렴한다", async () => {
    const sha = "c".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha, true);
    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "evidence", state: "AWAITING_USER_APPROVAL",
      body: "승인 전에 남긴 근거",
    });

    const changed = await engine.postMessage("topic-1", "decision", "삭제 동작도 계획에 넣어 주세요.");

    // 세션 재생성은 실제 범위 변경(scope_change)에서만 일어난다.
    expect(changed.participants.map((participant) => participant.sessionId)).toEqual([
      "claude-session",
      "codex-session",
    ]);
    // 같은 세대이므로 이전 근거와 이번 결정이 모두 다음 프롬프트 조회에 남는다.
    const scoped = database.getScopedTimeline("topic-1", 3).map((event) => event.body);
    expect(scoped).toContain("승인 전에 남긴 근거");
    expect(scoped).toContain("삭제 동작도 계획에 넣어 주세요.");
    database.close();
  });

  it("범위 변경 완료 후 원장 기록 전에 죽어도 재시도가 세대를 다시 올리지 않는다", async () => {
    const sha = "c".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha, true);
    database.claimActionRequest("topic-1", "message:scope_change", "scope-key", { body: "범위 변경" });

    // 범위 변경은 끝났지만 서버가 원장 finish 전에 죽은 상황 — 마커는 전이와 한 transaction으로 이미 남았다.
    await engine.handleScopeChange("topic-1", "결제 검증까지 범위에 넣습니다.", "scope-key");
    database.recoverInterruptedNonDeliveryRequests();

    expect(database.getActionRequest("topic-1", "message:scope_change", "scope-key")?.status).toBe("succeeded");
    // 같은 키 재청구는 거부되어(저장 응답 재생 경로) 세대가 4에서 더 올라갈 수 없다.
    expect(database.claimActionRequest("topic-1", "message:scope_change", "scope-key", {})).toBe(false);
    expect(database.getTopic("topic-1").scopeGeneration).toBe(4);
    expect(database.getTimeline("topic-1").filter((event) => event.kind === "scope_change")).toHaveLength(1);
    database.close();
  });

  it("범위를 바꾸면 두 에이전트 세션을 새로 만들어 이전 범위의 세션 기억을 끊는다", async () => {
    const sha = "c".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha, true);

    const changed = await engine.handleScopeChange("topic-1", "결제 검증까지 범위에 넣습니다.");

    expect(changed.planEpoch).toBe(2);
    for (const participant of changed.participants) {
      expect(participant.sessionId).toMatch(/^pending:/);
      expect(participant.mode).toBe("created");
    }
    const scopeChange = database.getTimeline("topic-1").findLast((event) => event.kind === "scope_change");
    expect(scopeChange?.payload).toMatchObject({
      previousSessions: { claude: "claude-session", codex: "codex-session" },
    });
    database.close();
  });
});

describe("커밋과 push 승인 분리", () => {
  it("사용자가 커밋만 승인하면 선택한 경로를 커밋하고 push는 실행하지 않는다", async () => {
    const runner = new RecordingGitRunner();
    const { database, engine } = makeEngine("READY_TO_DELIVER", "e".repeat(64), true, runner);

    const oid = await engine.commit("topic-1", "선택 범위 커밋", ["owned.txt"]);

    expect(oid).toBe("a".repeat(40));
    expect(runner.args).toContainEqual(["add", "--", "owned.txt"]);
    expect(runner.args.some((args) => args[0] === "push")).toBe(false);
    expect(database.getTimeline("topic-1").at(-1)).toMatchObject({
      actor: "user",
      kind: "decision",
      body: "선택한 변경을 커밋했습니다.",
    });
    database.close();
  });

  it("사용자가 별도로 push를 승인할 때만 현재 작업 브랜치를 원격에 올린다", async () => {
    const runner = new RecordingGitRunner();
    const { database, engine } = makeEngine("READY_TO_DELIVER", "f".repeat(64), true, runner);
    database.updateTopic("topic-1", { committedOID: "a".repeat(40) });

    await engine.push("topic-1");

    expect(runner.args).toContainEqual([
      "push", "--set-upstream", "origin", "consensus/scope-ab12",
    ]);
    expect(runner.args.some((args) => args[0] === "commit")).toBe(false);
    database.close();
  });

  it("최종 읽기 전용 리뷰가 끝나기 전에는 커밋과 push를 모두 거부한다", async () => {
    const runner = new RecordingGitRunner();
    const { database, engine } = makeEngine("DRAFT", null, false, runner);

    await expect(engine.commit("topic-1", "너무 이른 커밋", ["owned.txt"])).rejects.toThrow(
      "READY_TO_DELIVER",
    );
    await expect(engine.push("topic-1")).rejects.toThrow("READY_TO_DELIVER");
    expect(runner.args).toEqual([]);
    database.close();
  });
});

describe("완료 상태 주제 보호", () => {
  it("전달 준비가 끝난 주제의 계획 실행 요청은 원장에 남기지 않고 거부한다", async () => {
    const runner = new RecordingGitRunner();
    const { database, engine } = makeEngine("READY_TO_DELIVER", "e".repeat(64), true, runner);

    expect(() => engine.startPlan("topic-1", "plan-request-1")).toThrow("READY_TO_DELIVER");

    expect(database.getAction("plan-request-1")).toBeNull();
    expect(database.runningAction("topic-1")).toBeNull();
    expect(database.getTopic("topic-1")).toMatchObject({ state: "READY_TO_DELIVER" });

    const oid = await engine.commit("topic-1", "리뷰가 끝난 변경", ["owned.txt"]);

    expect(oid).toBe("a".repeat(40));
    expect(database.getFlags("topic-1").committedOID).toBe(oid);
    database.close();
  });
});

describe("가짜 에이전트 전체 계획 왕복", () => {
  // 메모리 쓰기 실패가 saveAgentOutput보다 앞에 있어서, 스냅샷 충돌 하나로 방금 끝난 계획·감사·구현 턴이
  // 통째로 사라졌다(2026-08-30 발견). 메모리는 부산물이므로 실패해도 턴 결과는 남아야 한다.
  it("메모리 쓰기가 실패해도 에이전트 턴 결과를 버리지 않고 사유를 남긴다", async () => {
    const revisedPlan = validPlan("메모리 충돌이 나는 계획");
    const revisedSHA = hashPlan(`${revisedPlan.trim()}\n`);
    const memory: ProjectMemoryWriter = {
      apply: async () => {
        throw new Error("메모리 파일이 스냅샷 뒤 바뀌었습니다: feedback-x.md");
      },
    };
    const { database, engine } = makePlanningEngine({
      slug: "memory-conflict",
      memory,
      claudeResults: [
        {
          kind: "PLAN", summary: "계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [],
          memoryUpdates: [{
            path: "feedback-x.md", expectedSHA256: "a".repeat(64),
            content: "---\nname: feedback-x\ndescription: 교훈\nmetadata:\n  platform: shared\n  type: feedback\n---\n",
            reason: "재사용 가능한 교훈",
          }],
        },
        { kind: "REVISION", summary: "개정", planMarkdown: revisedPlan, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });

    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // 메모리 실패가 턴을 죽였다면 여기까지 오지 못한다.
    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    const event = database.getTimeline("topic-1").find((e) =>
      Array.isArray(e.payload.memoryChanges) && (e.payload.memoryChanges as unknown[]).length > 0);
    const changes = event?.payload.memoryChanges as Array<Record<string, unknown>>;
    expect(changes[0].status).toBe("rejected");
    expect(String(changes[0].error)).toContain("스냅샷 뒤 바뀌었습니다");
    database.close();
  });

  it("에이전트의 메모리 제안은 중앙 저장소에 맡기고 타임라인에는 경로와 해시만 남긴다", async () => {
    const revisedPlan = validPlan("메모리 제안을 포함한 계획");
    const revisedSHA = hashPlan(`${revisedPlan.trim()}\n`);
    const calls: Array<{ role: string; paths: string[] }> = [];
    const memory: ProjectMemoryWriter = {
      apply: async (role, updates) => {
        calls.push({ role, paths: updates.map((update) => update.path) });
        return updates.map((update) => ({
          path: update.path,
          previousSHA256: update.expectedSHA256,
          sha256: "b".repeat(64),
          reason: update.reason,
          status: "written" as const,
        }));
      },
    };
    const { database, engine } = makePlanningEngine({
      slug: "memory-update",
      memory,
      claudeResults: [
        {
          kind: "PLAN",
          summary: "첫 계획과 교훈",
          planMarkdown: validPlan("첫 계획"),
          findings: [],
          evidenceRefs: [],
          memoryUpdates: [{
            path: "feedback-rule.md",
            expectedSHA256: null,
            content: "---\nname: feedback-rule\ndescription: 반복 교훈\nmetadata:\n  platform: shared\n  type: feedback\n---\n",
            reason: "다음 작업에도 필요한 규칙",
          }],
        },
        { kind: "REVISION", summary: "개정", planMarkdown: revisedPlan, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "ACK", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종료", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "ACK", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });

    engine.startPlan("topic-1");
    await waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    await waitForActionCompletion(database, "topic-1");

    expect(calls).toEqual([{ role: "claude", paths: ["feedback-rule.md"] }]);
    const memoryEvent = database.getTimeline("topic-1").find((event) =>
      Array.isArray(event.payload.memoryChanges) && event.payload.memoryChanges.length > 0);
    expect(memoryEvent?.payload.memoryChanges).toEqual([expect.objectContaining({
      path: "feedback-rule.md",
      sha256: "b".repeat(64),
    })]);
    expect(JSON.stringify(memoryEvent?.payload)).not.toContain("반복 교훈");
    database.close();
  });

  it("사용자가 합의를 시작하면 정해진 한 번의 왕복 뒤 같은 SHA ACK와 승인 대기 상태를 만든다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-plan-loop-"));
    temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    database.createTopic({
      id: "topic-1",
      slug: "bounded-loop",
      title: "한 번의 의견 수렴",
      repositoryPath: "/tmp/repository",
      baseRef: "develop",
      worktreePath: "/tmp/worktree",
      branchName: null,
      state: "DRAFT",
      scopeGeneration: 1,
      planRevision: 0,
      planSHA256: null,
      approvedPlanSHA256: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastError: null,
    });
    const firstPlan = validPlan("첫 계획");
    const revisedPlan = validPlan("검토를 반영한 계획 token=secret-value");
    const storedRevisedPlan = `${redactSecrets(revisedPlan).trim()}\n`;
    const revisedSHA = hashPlan(storedRevisedPlan);
    const claude = new QueuedAdapter("claude", [
      { kind: "PLAN", summary: "첫 계획", planMarkdown: firstPlan, findings: [], evidenceRefs: [] },
      { kind: "REVISION", summary: "계획 수정", planMarkdown: revisedPlan, findings: [], evidenceRefs: [] },
      { kind: "ACK", summary: "계획 해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
    ]);
    const codex = new QueuedAdapter("codex", [
      { kind: "AUDIT", summary: "계획 검토", findings: [], evidenceRefs: [] },
      { kind: "CLOSEOUT", summary: "의견 수렴 종료", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      { kind: "ACK", summary: "계획 해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
    ]);
    const unusedRunner: CommandRunner = {
      run: async () => { throw new Error("사용하지 않습니다."); },
    };
    const artifacts = new ArtifactStore(join(root, "topics"), database);
    const engine = new WorkflowEngine({
      database,
      artifacts,
      git: new GitService(unusedRunner),
      claude,
      codex,
    });
    database.updateAgentSettings("topic-1", "claude", { model: "sonnet", effort: "high" });
    database.updateAgentSettings("topic-1", "codex", { model: "gpt-5.6-luna", effort: "medium" });
    await engine.attachParticipant("topic-1", "claude", { mode: "new" });
    await engine.attachParticipant("topic-1", "codex", { mode: "new" });

    const reachedApproval = waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    engine.startPlan("topic-1");
    await reachedApproval;
    await new Promise<void>((resolve) => setImmediate(resolve));

    const unfinished = database.runningAction("topic-1");
    if (unfinished) {
      const current = database.getTopic("topic-1");
      throw new Error(
        `계획 상태는 ${current.state}지만 action ${unfinished.id}가 ${unfinished.status}입니다. lastError=${current.lastError ?? "없음"}`,
      );
    }

    const topic = database.getTopic("topic-1");
    expect(topic).toMatchObject({
      state: "AWAITING_USER_APPROVAL",
      planRevision: 2,
      planSHA256: revisedSHA,
      approvedPlanSHA256: null,
    });
    expect(topic.participants.map((participant) => participant.acknowledgedPlanSHA256)).toEqual([
      revisedSHA,
      revisedSHA,
    ]);
    expect(claude.calls).toHaveLength(3);
    expect(codex.calls).toHaveLength(3);
    // 마지막 턴은 ACK: 모델은 주제 설정을 따르되 추론 강도만 low로 내린다(프로토콜 확인에 고강도 추론은 낭비).
    expect(claude.turns.map((turn) => turn.settings)).toEqual([
      { model: "sonnet", effort: "high" },
      { model: "sonnet", effort: "high" },
      { model: "sonnet", effort: "low" },
    ]);
    expect(codex.turns.map((turn) => turn.settings)).toEqual([
      { model: "gpt-5.6-luna", effort: "medium" },
      { model: "gpt-5.6-luna", effort: "medium" },
      { model: "gpt-5.6-luna", effort: "low" },
    ]);
    expect(await artifacts.readLatest("topic-1", "plan")).toBe(storedRevisedPlan);
    expect(await artifacts.readLatest("topic-1", "plan")).not.toContain("secret-value");
    expect(codex.calls[1]).toContain(revisedSHA);
    expect(codex.calls[1]).not.toContain("secret-value");
    expect(await artifacts.readLatest("topic-1", "consensus")).not.toBeNull();
    database.close();
  });

  it("Claude 개정이 쟁점을 처분하지 않으면 합의 ACK로 넘기지 않는다", async () => {
    const revised = validPlan("처분이 빠진 개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const undisposed = finding("F-1", "감사가 올린 쟁점", { severity: "HIGH", disposition: undefined });
    const { database, engine, claude, codex } = makePlanningEngine({
      slug: "revision-disposition",
      claudeResults: [
        { kind: "PLAN", summary: "첫 계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        {
          kind: "REVISION",
          summary: "처분 없는 개정",
          planMarkdown: revised,
          findings: [undisposed],
          evidenceRefs: [],
        },
        // 계약 위반은 1회 교정 기회를 받는다 — 교정 회차도 같은 위반을 내면 그대로 실패해야 한다.
        {
          kind: "REVISION",
          summary: "교정 회차에도 처분 없는 개정",
          planMarkdown: revised,
          findings: [undisposed],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [undisposed], evidenceRefs: [] },
        {
          kind: "CLOSEOUT",
          summary: "종료",
          planSHA256: revisedSHA,
          findings: [finding("F-1", "감사가 올린 쟁점", { severity: "HIGH" })],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });

    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "FAILED",
      lastError: expect.stringContaining("F-1"),
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_REVISION");
    expect(claude.calls).toHaveLength(3);
    expect(codex.calls).toHaveLength(1);
    database.close();
  });

  it("Codex 종결이 고치기로 합의한 쟁점을 강등하면 합의로 닫지 않고 사용자 판단을 기다린다", async () => {
    const revised = validPlan("수정 합의를 담은 개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const { database, engine, claude, codex } = makePlanningEngine({
      slug: "closeout-downgrade",
      claudeResults: [
        { kind: "PLAN", summary: "첫 계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        {
          kind: "REVISION",
          summary: "고치기로 합의한 개정",
          planMarkdown: revised,
          findings: [finding("F-1", "고치기로 합의한 결함", { severity: "HIGH", disposition: "AGREED_ACTION" })],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        {
          kind: "AUDIT",
          summary: "감사",
          findings: [finding("F-1", "고치기로 합의한 결함", { severity: "HIGH", disposition: undefined })],
          evidenceRefs: [],
        },
        {
          kind: "CLOSEOUT",
          summary: "처분을 되돌린 종료",
          planSHA256: revisedSHA,
          findings: [finding("F-1", "고치기로 합의한 결함", { severity: "HIGH", disposition: "AGREED_NO_ACTION" })],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });

    const interrupted = waitForTopicState(database, "topic-1", "USER_DECISION_REQUIRED");
    engine.startPlan("topic-1");
    await interrupted;
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "USER_DECISION_REQUIRED",
      lastError: expect.stringContaining("F-1"),
    });
    // 2026-08-31 수정: 처분 강등의 재개 지점은 수렴 단계 안(CODEX_CLOSEOUT)이다. CLAUDE_PLAN이면
    // retry가 전체 재계획으로 떨어져 그때까지의 개정을 전부 버린다.
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_CLOSEOUT");
    expect(claude.calls).toHaveLength(2);
    expect(codex.calls).toHaveLength(2);
    database.close();
  });

  it("계획 단계 응답이 수정으로 종결했다고 주장하면 거부한다", async () => {
    const revised = validPlan("수정 합의를 담은 개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const { database, engine, codex } = makePlanningEngine({
      slug: "closeout-fix-claim",
      claudeResults: [
        { kind: "PLAN", summary: "첫 계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        {
          kind: "REVISION",
          summary: "고치기로 합의한 개정",
          planMarkdown: revised,
          findings: [finding("F-1", "고치기로 합의한 결함", { severity: "HIGH", disposition: "AGREED_ACTION" })],
          evidenceRefs: [],
        },
      ],
      codexResults: [
        {
          kind: "AUDIT",
          summary: "감사",
          findings: [finding("F-1", "고치기로 합의한 결함", { severity: "HIGH", disposition: undefined })],
          evidenceRefs: [],
        },
        {
          kind: "CLOSEOUT",
          summary: "수정했다고 주장하는 종료",
          planSHA256: revisedSHA,
          findings: [finding("F-1", "고치기로 합의한 결함", { severity: "HIGH", disposition: "RESOLVED_BY_FIX" })],
          evidenceRefs: [],
        },
        // 교정 회차에도 같은 주장을 유지하면 그대로 실패해야 한다.
        {
          kind: "CLOSEOUT",
          summary: "교정 회차에도 수정 주장 유지",
          planSHA256: revisedSHA,
          findings: [finding("F-1", "고치기로 합의한 결함", { severity: "HIGH", disposition: "RESOLVED_BY_FIX" })],
          evidenceRefs: [],
        },
      ],
    });

    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "FAILED",
      lastError: expect.stringContaining("RESOLVED_BY_FIX"),
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_CLOSEOUT");
    expect(codex.calls).toHaveLength(3);
    database.close();
  });

  it("Codex 감사 프롬프트의 계획 펜스 안에는 저장된 계획 본문만 들어간다", async () => {
    const firstPlan = validPlan("첫 계획");
    const revised = validPlan("개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const { database, artifacts, engine, codex } = makePlanningEngine({
      slug: "audit-fence",
      claudeResults: [
        {
          kind: "PLAN",
          summary: "첫 계획",
          planMarkdown: firstPlan,
          findings: [finding("F-PLAN", "계획과 함께 기록한 쟁점", { disposition: undefined })],
          evidenceRefs: [],
        },
        {
          kind: "REVISION",
          summary: "개정",
          planMarkdown: revised,
          findings: [finding("F-PLAN", "계획과 함께 기록한 쟁점")],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        {
          kind: "AUDIT",
          summary: "감사",
          findings: [finding("F-PLAN", "계획과 함께 기록한 쟁점", { disposition: undefined })],
          evidenceRefs: [],
        },
        {
          kind: "CLOSEOUT",
          summary: "종료",
          planSHA256: revisedSHA,
          findings: [finding("F-PLAN", "계획과 함께 기록한 쟁점")],
          evidenceRefs: [],
        },
        { kind: "ACK", summary: "해시 확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });

    const approval = waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    engine.startPlan("topic-1");
    await approval;
    await waitForActionCompletion(database, "topic-1");

    const storedFirstPlan = await artifacts.readPrevious("topic-1", "plan");
    const auditPrompt = codex.calls[0];
    const fenced = /검토할 계획:\n---\n([\s\S]*?)\n---\n/.exec(auditPrompt);

    expect(storedFirstPlan).toBe(`${firstPlan.trim()}\n`);
    expect(fenced?.[1]).toBe(storedFirstPlan);
    expect(fenced?.[1]).not.toContain("F-PLAN");
    expect(auditPrompt).toContain("F-PLAN");
    database.close();
  });

  // 2026-09-07 의미 변경: 종결 확인의 새 finding 은 처음부터 재수렴이 아니라 개정 2회차로 반영한다(바퀴당 1회).
  it("Codex closeout에서 새 finding이 나오면 ACK로 닫지 않고 개정 2회차를 연다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-closeout-finding-"));
    temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    database.createTopic({
      id: "topic-1",
      slug: "closeout-finding",
      title: "마지막 검토 새 쟁점",
      repositoryPath: "/tmp/repository",
      baseRef: "develop",
      worktreePath: "/tmp/worktree",
      branchName: null,
      state: "DRAFT",
      scopeGeneration: 1,
      planRevision: 0,
      planSHA256: null,
      approvedPlanSHA256: null,
      createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z",
      lastError: null,
    });
    for (const role of ["claude", "codex"] as const) {
      database.upsertParticipant("topic-1", {
        role,
        sessionId: `${role}-session`,
        mode: "attached",
        acknowledgedPlanSHA256: null,
      });
    }
    const firstPlan = validPlan("첫 계획");
    const revisedPlan = validPlan("수정 계획");
    const revisedSHA = hashPlan(`${revisedPlan.trim()}\n`);
    const newCloseoutFinding = finding("F-NEW", "마지막 검토에서 나온 새 쟁점", { disposition: "AGREED_ACTION" });
    const claude = new QueuedAdapter("claude", [
      { kind: "PLAN", summary: "첫 계획", planMarkdown: firstPlan, findings: [], evidenceRefs: [] },
      { kind: "REVISION", summary: "계획 수정", planMarkdown: revisedPlan, findings: [], evidenceRefs: [] },
    ]);
    const codex = new QueuedAdapter("codex", [
      { kind: "AUDIT", summary: "첫 감사", findings: [], evidenceRefs: [] },
      {
        kind: "CLOSEOUT",
        summary: "새 쟁점 발견",
        planSHA256: revisedSHA,
        findings: [newCloseoutFinding],
        evidenceRefs: [],
      },
    ]);
    const engine = new WorkflowEngine({
      database,
      artifacts: new ArtifactStore(join(root, "topics"), database),
      git: new GitService({ run: async () => { throw new Error("사용하지 않습니다."); } }),
      claude,
      codex,
    });

    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // ACK 로 닫히지 않았고, 개정 2회차 턴이 열렸다(응답이 없어 그 단계에서 실패하는 것이 진행의 증거).
    expect(database.getTopic("topic-1")).toMatchObject({
      state: "FAILED",
      lastError: expect.stringContaining("claude 가짜 응답이 부족합니다"),
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_REVISION");
    expect(database.getFlags("topic-1").closeoutRevisionUsed).toBe(true);
    expect(claude.calls).toHaveLength(3);
    expect(claude.calls[2]).toContain("F-NEW");
    expect(codex.calls).toHaveLength(2);
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("개정 2회차로 최신 계획 위에 반영합니다"))).toBe(true);
    expect(bodies.some((body) => body.includes("처음부터 재시도"))).toBe(false);
    database.close();
  });
});

describe("리뷰 finding 보존", () => {
  it("첫 Codex 리뷰가 구현 보고의 finding을 누락하면 전달 준비로 넘어가지 않는다", async () => {
    const implementationFinding = finding("F-IMPLEMENTATION", "구현 중 발견한 제약");
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW",
      implementationFindings: [implementationFinding],
      originalReviewFindings: [],
      codexResult: {
        kind: "REVIEW",
        summary: "구현 finding을 누락한 리뷰",
        findings: [],
        evidenceRefs: [],
      },
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "FAILED",
      lastError: expect.stringContaining("F-IMPLEMENTATION"),
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_REVIEW");
    database.close();
  });

  it("Claude 보완이 고치기로 합의한 쟁점을 강등하면 최종 리뷰로 넘기지 않는다", async () => {
    const agreed = finding("F-1", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CLAUDE_FIX",
      implementationFindings: [agreed],
      originalReviewFindings: [agreed],
      claudeResults: [{
        kind: "FIX",
        summary: "처분을 되돌린 보완",
        findings: [finding("F-1", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_NO_ACTION" })],
        evidenceRefs: [],
      }],
      codexResult: {
        kind: "FINAL_REVIEW",
        summary: "보완을 확인한 최종 리뷰",
        findings: [finding("F-1", "첫 리뷰가 고치기로 한 결함")],
        evidenceRefs: [],
      },
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "USER_DECISION_REQUIRED",
      lastError: expect.stringContaining("F-1"),
    });
    expect(database.getFlags("topic-1")).toMatchObject({
      resumeState: "CLAUDE_FIX",
      fixPassUsed: false,
    });
    database.close();
  });

  it("최종 Codex 리뷰가 수정을 확인해 종결하면 전달 준비로 넘어가고 커밋할 수 있다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const resolved = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "RESOLVED_BY_FIX" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [resolved],
      originalReviewFindings: [agreed],
      codexResult: {
        kind: "FINAL_REVIEW",
        summary: "수정을 확인한 최종 리뷰",
        findings: [resolved],
        evidenceRefs: [],
      },
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(database.getFlags("topic-1")).toMatchObject({
      reviewedHead: "a".repeat(40),
      resumeState: null,
    });

    const oid = await engine.commit("topic-1", "리뷰가 끝난 변경", ["owned.txt"]);

    expect(database.getFlags("topic-1").committedOID).toBe(oid);
    database.close();
  });

  it("최종 Codex 리뷰가 확정 결함을 그대로 남기면 자동으로 전달 준비로 넘기지 않는다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [agreed],
      originalReviewFindings: [agreed],
      codexResult: {
        kind: "FINAL_REVIEW",
        summary: "결함이 남은 최종 리뷰",
        findings: [agreed],
        evidenceRefs: [],
      },
    });
    database.setImplementationSession("topic-1", "claude-implementation-session");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // 2026-09-07: 남은 회차 안에서는 결정 없이 바로 2차 수정으로 간다(가짜 수정 응답이 없어 그 단계에서 실패하는 것이 진행의 증거).
    expect(database.getTopic("topic-1")).toMatchObject({ state: "FAILED", lastError: expect.stringContaining("claude 가짜 응답이 부족합니다") });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_FIX");
    expect(database.getFlags("topic-1").secondFixPassUsed).toBe(false);
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("2차 자동 수정으로 바로"))).toBe(true);
    database.close();
  });

  it("최종 리뷰 잔여 결함은 결정 없이 2차 자동 수정으로 바로 고치고, 그 뒤 최종 리뷰를 다시 받는다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const resolved = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "RESOLVED_BY_FIX" });
    const remaining: AgentResult = { kind: "FINAL_REVIEW", summary: "결함이 남은 최종 리뷰", findings: [agreed], evidenceRefs: [] };
    const passed: AgentResult = { kind: "FINAL_REVIEW", summary: "2차 수정을 확인한 최종 리뷰", findings: [resolved], evidenceRefs: [] };
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [agreed],
      originalReviewFindings: [agreed],
      codexResult: remaining,
      codexResults: [remaining, passed],
      claudeResults: [{ kind: "FIX", summary: "2차 수정", findings: [resolved], evidenceRefs: [] }],
    });
    database.updateTopic("topic-1", { fixPassUsed: true });
    database.setImplementationSession("topic-1", "claude-implementation-session");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getFlags("topic-1").secondFixPassUsed).toBe(true);
    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("2차 자동 수정으로 바로"))).toBe(true);
    expect(database.getTimeline("topic-1").some((event) => event.state === "USER_DECISION_REQUIRED")).toBe(false);
    database.close();
  });

  it("회차를 다 쓴 뒤 남은 결함은 한 번 결정받고, 그 결정이 추가 회차를 열어 저장된 리뷰에서 곧장 수정으로 간다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const resolved = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "RESOLVED_BY_FIX" });
    const remaining: AgentResult = { kind: "FINAL_REVIEW", summary: "결함이 남은 최종 리뷰", findings: [agreed], evidenceRefs: [] };
    const passed: AgentResult = { kind: "FINAL_REVIEW", summary: "추가 수정을 확인한 최종 리뷰", findings: [resolved], evidenceRefs: [] };
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [agreed],
      originalReviewFindings: [agreed],
      codexResult: remaining,
      // 리뷰 2개뿐: 소진 뒤 결정→retry 가 리뷰를 다시 사면 세 번째 호출에서 가짜 응답 부족으로 드러난다.
      codexResults: [remaining, passed],
      claudeResults: [{ kind: "FIX", summary: "추가 수정", findings: [resolved], evidenceRefs: [] }],
    });
    database.updateTopic("topic-1", { fixPassUsed: true, secondFixPassUsed: true });
    database.setImplementationSession("topic-1", "claude-implementation-session");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1")).toMatchObject({
      state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("두 번의 자동 수정 뒤에도 확정 결함이 남았습니다(F-ORIGINAL)"),
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_FINAL_REVIEW");

    await engine.postMessage("topic-1", "decision", "F-ORIGINAL 은 고친다. 추가 회차를 연다.");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("저장된 최종 리뷰") && body.includes("바로 수정으로"))).toBe(true);
    database.close();
  });

  it("최종 Codex 리뷰가 첫 리뷰의 수정 합의를 수정 없이 철회하면 전달 준비로 넘어가지 않는다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    for (const disposition of ["AGREED_NO_ACTION", "REFUTED", "DEFERRED_OUT_OF_SCOPE"] as const) {
      const { database, engine } = await makeReviewRecovery({
        resumeState: "CODEX_FINAL_REVIEW",
        implementationFindings: [agreed],
        originalReviewFindings: [agreed],
        codexResult: {
          kind: "FINAL_REVIEW",
          summary: `수정 합의를 ${disposition}으로 철회한 최종 리뷰`,
          findings: [finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition })],
          evidenceRefs: [],
        },
      });

      engine.retry("topic-1");
      await waitForActionCompletion(database, "topic-1");

      expect(database.getTopic("topic-1").state, disposition).toBe("USER_DECISION_REQUIRED");
      expect(database.getTopic("topic-1").lastError).toContain("F-ORIGINAL");
      expect(database.getFlags("topic-1").resumeState).toBe("CODEX_FINAL_REVIEW");
      database.close();
    }
  });

  it("최종 리뷰에서 처음 등장한 쟁점은 수정 종결로 표시해도 전달 준비로 넘어가지 않는다", async () => {
    const carried = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "RESOLVED_BY_FIX" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [carried],
      originalReviewFindings: [finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" })],
      codexResult: {
        kind: "FINAL_REVIEW",
        summary: "새 쟁점을 수정 종결로 위장한 최종 리뷰",
        findings: [
          carried,
          // Claude가 고칠 기회가 없었던 쟁점이다. RESOLVED_BY_FIX여도 자동으로 닫히면 안 된다.
          finding("F-BRAND-NEW", "최종 리뷰에서 처음 나온 결함", { disposition: "RESOLVED_BY_FIX" }),
        ],
        evidenceRefs: [],
      },
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
    expect(database.getTopic("topic-1").lastError).toContain("F-BRAND-NEW");
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_FINAL_REVIEW");
    // 리뷰가 본 스냅샷은 가드 결과와 무관하게 기록된다(저장된 리뷰 재사용의 대조 근거, 2026-09-07). 전달은 여전히
    // READY_TO_DELIVER 상태가 열어야 한다 — 스냅샷 기록만으로 커밋이 뚫리면 안 된다.
    expect(database.getFlags("topic-1").reviewedHead).toBe("a".repeat(40));
    await expect(engine.commit("topic-1", "막혀야 하는 커밋", ["owned.txt"])).rejects.toThrow("READY_TO_DELIVER");
    database.close();
  });

  it("최종 Codex 리뷰가 Claude fix에서 새로 보고한 finding을 누락하면 전달 준비로 넘어가지 않는다", async () => {
    const originalFinding = finding("F-ORIGINAL", "첫 리뷰 지적");
    const fixFinding = finding("F-FIX", "수정 중 새로 발견한 제약");
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [fixFinding],
      originalReviewFindings: [originalFinding],
      codexResult: {
        kind: "FINAL_REVIEW",
        summary: "fix finding을 누락한 최종 리뷰",
        findings: [originalFinding],
        evidenceRefs: [],
      },
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "FAILED",
      lastError: expect.stringContaining("F-FIX"),
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_FINAL_REVIEW");
    database.close();
  });
});

class QueuedAdapter implements AgentAdapter {
  readonly calls: string[] = [];
  readonly turns: Array<Parameters<AgentAdapter["resumeTurn"]>[0] | Parameters<AgentAdapter["createSession"]>[0]> = [];

  constructor(
    readonly role: "claude" | "codex",
    private readonly results: AgentResult[],
  ) {}

  async createSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    this.calls.push(turn.prompt);
    this.turns.push(turn);
    return { sessionId: `${this.role}-created-session`, result: this.next() };
  }

  async resumeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    this.calls.push(turn.prompt);
    this.turns.push(turn);
    return this.next();
  }

  async validateExistingSession() {
    return true;
  }

  private next(): AgentResult {
    const result = this.results.shift();
    if (!result) throw new Error(`${this.role} 가짜 응답이 부족합니다.`);
    return result;
  }
}

class ReviewSessionAdapter implements AgentAdapter {
  readonly role = "codex" as const;
  readonly calls: Array<{ sessionId: string; created: boolean; turn: Parameters<AgentAdapter["createSession"]>[0] }> = [];
  private createdCount = 0;
  constructor(private readonly results: AgentResult[]) {}
  async createSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    const sessionId = `review-only-${++this.createdCount}`;
    this.calls.push({ sessionId, created: true, turn });
    return { sessionId, result: this.next() };
  }
  async resumeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    this.calls.push({ sessionId: turn.sessionId, created: false, turn });
    return this.next();
  }
  async validateExistingSession() { return true; }
  private next(): AgentResult {
    const result = this.results.shift();
    if (!result) throw new Error("예상하지 않은 추가 리뷰 호출입니다.");
    return result;
  }
}

describe("저장된 구현 세션의 대화 파일이 없을 때", () => {
  it("resume 이 'No conversation found' 로 실패하면 새 세션으로 시작하고 그 사실을 타임라인에 남긴다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const resolved = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "RESOLVED_BY_FIX" });
    const passed: AgentResult = { kind: "FINAL_REVIEW", summary: "수정을 확인한 최종 리뷰", findings: [resolved], evidenceRefs: [] };
    const calls: string[] = [];
    const claude: AgentAdapter = {
      role: "claude",
      async createSession(turn) {
        calls.push("create");
        return { sessionId: "claude-fresh-session", result: { kind: "FIX", summary: "새 세션에서 고침", findings: [resolved], evidenceRefs: ["F-ORIGINAL → 원인 → 파일 → 검증 → 없음"] } };
      },
      async resumeTurn(turn) {
        calls.push(`resume:${turn.sessionId}`);
        throw new Error("Claude 실행 실패(1): No conversation found with session ID: claude-implementation-session");
      },
      async validateExistingSession() { return false; },
    };
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CLAUDE_FIX", implementationFindings: [agreed], originalReviewFindings: [agreed], codexResult: passed, claude,
    });
    database.setImplementationSession("topic-1", "claude-implementation-session");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // 수정 턴은 구현 세션을 resume 하는 경로라 동일 폴백이 적용돼야 한다 — 이 테스트는 그 경로가 아직 실패하면 붉다.
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(calls[0]).toBe("resume:claude-implementation-session");
    expect(bodies.some((body) => body.includes("대화 파일을 CLI 가 찾지 못해 새 세션으로 시작합니다"))).toBe(true);
    expect(calls).toContain("create");
    expect(database.getFlags("topic-1").implementationSessionId).toBe("claude-fresh-session");
    database.close();
  });
});

describe("implement 의 시작 결정문(kickoffDecision)", () => {
  it("구현 액션이 시작되기 전에 user/decision 으로 타임라인에 붙는다", async () => {
    const sha = "e".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha, true);

    engine.startImplementation("topic-1", undefined, "[d06] base 승격 — S9 인도 커밋 위에서 시작한다.");
    await waitForActionCompletion(database, "topic-1");

    const bodies = database.getTimeline("topic-1").map((event) => `${event.actor}/${event.kind}:${event.body}`);
    const kickoff = bodies.findIndex((body) => body.startsWith("user/decision:[d06] base 승격"));
    const started = bodies.findIndex((body) => body.includes("Claude가 승인된 계획을 구현합니다."));
    expect(kickoff).toBeGreaterThanOrEqual(0);
    expect(started).toBeGreaterThan(kickoff);
    expect(database.getTimeline("topic-1")[kickoff].payload).toMatchObject({ kickoff: true });
    // 첫 프롬프트가 읽는 타임라인에도 들어 있다.
    expect(database.getPromptTimeline("topic-1", 3).map((event) => event.body)).toContain("[d06] base 승격 — S9 인도 커밋 위에서 시작한다.");
    database.close();
  });

  it("재계획 트리거 단어가 든 시작 결정문은 거부하고 아무것도 바꾸지 않는다", () => {
    const sha = "f".repeat(64);
    const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", sha, true);
    const before = database.getTimeline("topic-1").length;

    expect(() => engine.startImplementation("topic-1", undefined, "REPLAN — 전제가 바뀌었다")).toThrow("재계획 트리거");
    expect(() => engine.startImplementation("topic-1", undefined, "전제가 바뀌었다.\nREPLAN")).toThrow("재계획 트리거");
    expect(database.getTimeline("topic-1").length).toBe(before);
    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    database.close();
  });
});

const TOLERANCE_BLOCK = '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';

function validPlan(label: string): string {
  return REQUIRED_PLAN_HEADINGS
    .map((heading) => `## ${heading}\n\n${label}: ${heading}${heading === "허용 오차" ? TOLERANCE_BLOCK : ""}`)
    .join("\n\n");
}

function makePlanningEngine(input: {
  slug: string;
  claudeResults: AgentResult[];
  codexResults: AgentResult[];
  memory?: ProjectMemoryWriter;
}) {
  const root = mkdtempSync(join(tmpdir(), `consensus-room-${input.slug}-`));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  database.createTopic({
    id: "topic-1",
    slug: input.slug,
    title: "계획 왕복",
    repositoryPath: "/tmp/repository",
    baseRef: "develop",
    worktreePath: "/tmp/worktree",
    branchName: null,
    state: "DRAFT",
    scopeGeneration: 1,
    planRevision: 0,
    planSHA256: null,
    approvedPlanSHA256: null,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    lastError: null,
  });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant("topic-1", {
      role,
      sessionId: `${role}-session`,
      mode: "attached",
      acknowledgedPlanSHA256: null,
    });
  }
  const claude = new QueuedAdapter("claude", input.claudeResults);
  const codex = new QueuedAdapter("codex", input.codexResults);
  const artifacts = new ArtifactStore(join(root, "topics"), database);
  const engine = new WorkflowEngine({
    database,
    artifacts,
    git: new GitService({ run: async () => { throw new Error("사용하지 않습니다."); } }),
    claude,
    codex,
    memory: input.memory,
  });
  return { database, artifacts, engine, claude, codex };
}

async function makeReviewRecovery(input: {
  resumeState: "CLAUDE_FIX" | "CODEX_REVIEW" | "CODEX_FINAL_REVIEW";
  implementationFindings: AgentResult["findings"];
  originalReviewFindings: AgentResult["findings"];
  codexResult: AgentResult;
  claudeResults?: AgentResult[];
  // 지정하면 codex 큐를 그대로 쓴다(2차 수정 패스처럼 최종 리뷰가 두 번 도는 시나리오).
  codexResults?: AgentResult[];
  codex?: AgentAdapter;
  // 지정하면 claude 어댑터를 통째로 바꾼다(턴 도중 입력을 넣는 게이트 어댑터 등).
  claude?: AgentAdapter;
}) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-review-coverage-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  const plan = validPlan("검토 finding 보존");
  const planSHA256 = hashPlan(plan);
  database.createTopic({
    id: "topic-1",
    slug: "coverage",
    title: "리뷰 finding 보존",
    repositoryPath: "/tmp/repository",
    baseRef: "develop",
    worktreePath: "/tmp/worktree",
    branchName: "consensus/scope-ab12",
    state: "FAILED",
    scopeGeneration: 1,
    planRevision: 2,
    planSHA256,
    approvedPlanSHA256: planSHA256,
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    lastError: "재시도 준비",
  });
  database.updateTopic("topic-1", { resumeState: input.resumeState });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant("topic-1", {
      role,
      sessionId: `${role}-session`,
      mode: "attached",
      acknowledgedPlanSHA256: planSHA256,
    });
  }
  const artifacts = new ArtifactStore(join(root, "topics"), database);
  await artifacts.write("topic-1", "plan", 2, plan);
  const implementationKind = input.resumeState === "CODEX_FINAL_REVIEW" ? "claude-fix" : "implementation-result";
  await artifacts.write("topic-1", implementationKind, 1, JSON.stringify({
    kind: input.resumeState === "CODEX_FINAL_REVIEW" ? "FIX" : "IMPLEMENTATION",
    summary: "검토할 구현 결과",
    findings: input.implementationFindings,
    evidenceRefs: [],
  }));
  if (input.resumeState !== "CODEX_REVIEW") {
    await artifacts.write("topic-1", "codex-review", 1, JSON.stringify({
      kind: "REVIEW",
      summary: "첫 리뷰",
      findings: input.originalReviewFindings,
      evidenceRefs: [],
    }));
  }
  if (input.resumeState === "CLAUDE_FIX") {
    database.setImplementationSession("topic-1", "claude-implementation-session");
  }
  const engine = new WorkflowEngine({
    database,
    artifacts,
    git: new GitService(new RecordingGitRunner()),
    claude: input.claude ?? new QueuedAdapter("claude", input.claudeResults ?? []),
    // 계약 위반 1회 교정 회차 몫까지 같은 결과를 공급한다 — 위반이 유지되면 실패해야 한다.
    codex: input.codex ?? new QueuedAdapter("codex", input.codexResults ?? [input.codexResult, input.codexResult]),
  });
  return { database, engine, artifacts };
}

// 2026-08-29 실측: ACK 턴 하나가 $17.71이었다(cache creation 759K + cache read 1.5M + output 19,975).
// 합의 세션을 resume해 대화 전체를 다시 실어 나르고, 도구가 열려 있어 파일 해시까지 직접 계산했기 때문이다.
describe("계획 ACK는 합의 세션을 다시 실어 나르지 않는다", () => {
  async function runToAck() {
    const revised = validPlan("개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const { database, engine, claude, codex } = makePlanningEngine({
      slug: "ack-isolation",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    return { database, claude, codex, revised, revisedSHA };
  }

  it("ACK는 새 세션에서 도구 없이 돌고, 그 세션을 participant에 저장하지 않는다", async () => {
    const { database, claude, codex } = await runToAck();

    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    for (const adapter of [claude, codex]) {
      const ackTurn = adapter.turns.at(-1)!;
      expect(ackTurn.protocolOnly).toBe(true);
      // createSession으로 들어온 턴에는 sessionId가 없다 — resume이면 있다.
      expect("sessionId" in ackTurn).toBe(false);
    }
    // 일회용 세션 ID가 participant를 덮으면 다음 단계가 빈 세션을 이어받는다.
    for (const participant of database.getTopic("topic-1").participants) {
      expect(participant.sessionId).toBe(`${participant.role}-session`);
    }
    database.close();
  });

  it("ACK 프롬프트가 계획 본문을 직접 담아 세션 기억에 기대지 않는다", async () => {
    const { database, claude, revised, revisedSHA } = await runToAck();

    const ackPrompt = claude.calls.at(-1)!;
    expect(ackPrompt).toContain(revised.trim().slice(0, 60));
    expect(ackPrompt).toContain(revisedSHA);
    expect(ackPrompt).toContain("해시를 직접 계산하지도 마세요");
    database.close();
  });
});

// 2026-08-31 실측: 개정 11 시점에 합의 세션이 턴당 834,290토큰을 재전송했고, 그중 StructuredOutput
// 695KB가 이미 폐기된 이전 개정본들의 계획 전문이었다. 개정 턴이 15분→45분으로 늘고 429를 두 번 맞았다.
// 개정 프롬프트는 계획 전문·감사 전문·타임라인·처분 계약을 모두 담으므로 이력이 필요 없다.
describe("개정 턴은 이전 개정본을 다시 실어 나르지 않는다", () => {
  async function runToRevision() {
    const revised = validPlan("개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const first = validPlan("첫 계획");
    const { database, engine, claude, codex } = makePlanningEngine({
      slug: "revision-isolation",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    // claude 턴 순서: [0] PLAN, [1] REVISION, [2] ACK
    return { database, claude, codex, first, revisionTurn: claude.turns[1]!, revisionPrompt: claude.calls[1]! };
  }

  it("개정은 새 세션에서 돌고 그 세션을 participant에 저장하지 않는다", async () => {
    const { database, revisionTurn } = await runToRevision();

    // createSession으로 들어온 턴에는 sessionId가 없다 — resume이면 있다.
    expect("sessionId" in revisionTurn).toBe(false);
    // 일회용 세션 ID가 participant를 덮으면 구현 fork가 빈 세션을 물려받는다.
    for (const participant of database.getTopic("topic-1").participants) {
      expect(participant.sessionId).toBe(`${participant.role}-session`);
    }
    database.close();
  });

  it("개정은 ACK와 달리 도구를 닫지 않는다 — 감사 지적을 코드로 검증해야 한다", async () => {
    const { database, revisionTurn } = await runToRevision();

    expect(revisionTurn.protocolOnly ?? false).toBe(false);
    database.close();
  });

  it("개정 프롬프트가 계획 전문을 직접 담아 세션 기억에 기대지 않는다", async () => {
    const { database, first, revisionPrompt } = await runToRevision();

    expect(revisionPrompt).toContain(first.trim().slice(0, 60));
    expect(revisionPrompt).toContain("Codex 감사:");
    database.close();
  });
});

// plan 권한 모드는 "탐색 후 승인 요청" 지침을 얹는다. 비대화형 개정 턴에는 승인받을 상대가 없고,
// 쓰기 차단은 --tools와 sandbox가 이미 독립으로 담당한다. 그래서 진짜 계획을 세우는 두 턴에만 켠다.
describe("plan 권한 모드는 최초 계획과 findings 0 개정 두 번만 켠다", () => {
  type F = AgentResult["findings"][number];
  async function run(auditFindings: F[], revisionFindings: F[]) {
    const revised = validPlan("개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const { database, engine, claude } = makePlanningEngine({
      slug: `planmode-${auditFindings.length}`,
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: revisionFindings, evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: auditFindings, evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: revisionFindings, evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    // claude 턴 순서: [0] PLAN, [1] REVISION, [2] ACK
    return { database, planTurn: claude.turns[0]!, revisionTurn: claude.turns[1]!, ackTurn: claude.turns[2]! };
  }

  it("최초 계획 턴은 plan 모드로 돈다", async () => {
    const { database, planTurn } = await run([], []);
    expect(planTurn.planMode).toBe(true);
    database.close();
  });

  // workflow.updateAgentSettings가 implementation을 떨어뜨리던 회귀 방지(2026-08-31 실측:
  // API 200인데 impl 컬럼 NULL — changes 재구성에서 필드 누락).
  it("설정 API 경로가 implementation 오버라이드를 보존한다", async () => {
    const { database, engine } = makePlanningEngine({ slug: "impl-settings", claudeResults: [], codexResults: [] });
    engine.updateAgentSettings("topic-1", "claude",
      { model: "fable", effort: "xhigh", implementation: { model: "opus", effort: "xhigh" } });
    expect(database.getTopic("topic-1").agentSettings.claude.implementation)
      .toEqual({ model: "opus", effort: "xhigh" });
    // implementation 없이 다시 설정하면 오버라이드가 지워진다(명시적 왕복)
    engine.updateAgentSettings("topic-1", "claude", { model: "fable", effort: "xhigh" });
    expect(database.getTopic("topic-1").agentSettings.claude.implementation).toBeUndefined();
    database.close();
  });

  it("계획 수렴 턴은 계획 모델(fable)을 받고 구현 오버라이드는 노출되지 않는다", async () => {
    const { database, planTurn, revisionTurn } = await run([], []);
    for (const turn of [planTurn, revisionTurn]) {
      expect(turn.settings).toEqual({ model: "fable", effort: "xhigh" });
    }
    database.close();
  });

  it("감사 findings가 남아 있는 개정은 plan 모드로 돌지 않는다", async () => {
    const open = finding("F-1", "감사가 올린 쟁점", { severity: "HIGH", disposition: undefined });
    const resolved = finding("F-1", "감사가 올린 쟁점", { severity: "HIGH", disposition: "AGREED_ACTION" });
    const { database, revisionTurn } = await run([open], [resolved]);
    expect(revisionTurn.planMode ?? false).toBe(false);
    database.close();
  });

  it("감사 findings가 0으로 수렴한 개정은 plan 모드로 돈다", async () => {
    const { database, revisionTurn } = await run([], []);
    expect(revisionTurn.planMode).toBe(true);
    database.close();
  });

  it("ACK는 plan 모드가 아니다 — 도구가 아예 닫혀 있다", async () => {
    const { database, ackTurn } = await run([], []);
    expect(ackTurn.planMode ?? false).toBe(false);
    expect(ackTurn.protocolOnly).toBe(true);
    database.close();
  });
});

// 매 개정이 53KB 계획 전문을 재출력해 출력 상한(64K)에 닿던 병목(2026-08-31 실측 62,066)의 해소.
// 개정은 planEdits 패치를 반환하고, 전문은 서버가 저장된 직전 계획에 적용해 만들고 해시한다.
describe("개정은 planEdits 패치로 계획을 고칠 수 있다", () => {
  function planWith(label: string, marker: string): string {
    return REQUIRED_PLAN_HEADINGS
      .map((heading) => `## ${heading}\n\n${label}: ${heading}${heading === REQUIRED_PLAN_HEADINGS[0] ? `\n${marker}` : ""}${heading === "허용 오차" ? TOLERANCE_BLOCK : ""}`)
      .join("\n\n");
  }

  it("패치가 적용된 전문이 저장되고 그 SHA로 합의가 닫힌다", async () => {
    const first = planWith("첫 계획", "패치 전 문장");
    const revised = normalizePlan(first.replace("패치 전 문장", "패치 후 문장"));
    const revisedSHA = hashPlan(revised);
    const { database, engine } = makePlanningEngine({
      slug: "plan-edits-apply",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        // 전문 없이 패치만 반환한다 — 서버가 적용해야 이 SHA가 성립한다.
        { kind: "REVISION", summary: "개정", planEdits: [{ find: "패치 전 문장", replace: "패치 후 문장" }], findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    const topic = database.getTopic("topic-1");
    expect(topic.lastError ?? "").toBe("");
    expect(topic.state).toBe("AWAITING_USER_APPROVAL");
    expect(topic.planSHA256).toBe(revisedSHA);
    database.close();
  });

  it("일치하지 않는 편집은 어느 편집인지 명시하며 턴을 거부한다", async () => {
    const first = planWith("첫 계획", "패치 전 문장");
    const { database, engine } = makePlanningEngine({
      slug: "plan-edits-reject",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planEdits: [{ find: "계획에 없는 문구", replace: "x" }], findings: [], evidenceRefs: [] },
        // 교정 회차에도 같은 편집을 고집하면 그대로 실패해야 한다.
        { kind: "REVISION", summary: "개정 재시도", planEdits: [{ find: "계획에 없는 문구", replace: "x" }], findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    const topic = database.getTopic("topic-1");
    expect(topic.state).toBe("FAILED");
    expect(topic.lastError ?? "").toContain("planEdits[0]");
    expect(topic.lastError ?? "").toContain("0회 일치");
    database.close();
  });

  // 2026-08-31 실측: closeout이 처분을 되돌리면 interrupt가 resume=CLAUDE_PLAN을 박아, retry가
  // 전체 재계획으로 떨어져 12개 개정을 폐기하기 직전까지 갔다. 재개는 수렴 단계 안에서 이뤄져야 한다.
  it("closeout이 처분을 되돌려도 retry가 전체 재계획으로 떨어지지 않는다", async () => {
    const revised = validPlan("개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const agreed = finding("F-1", "합의된 결함", { severity: "HIGH", disposition: "AGREED_ACTION" });
    const regressed = finding("F-1", "합의된 결함", { severity: "HIGH", disposition: "AGREED_NO_ACTION" });
    const { database, engine } = makePlanningEngine({
      slug: "closeout-regression-resume",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: [agreed], evidenceRefs: [] },
        // retry 사다리가 CLAUDE_REVISION으로 내려오면 이 개정이 소비된다
        { kind: "REVISION", summary: "재개정", planMarkdown: revised, findings: [agreed], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [finding("F-1", "합의된 결함", { severity: "HIGH", disposition: undefined })], evidenceRefs: [] },
        // 1차 closeout이 처분을 되돌린다 → 서버가 거부해야 한다
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [regressed], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [agreed], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    let topic = database.getTopic("topic-1");
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(topic.lastError ?? "").toContain("처분을 되돌렸습니다(F-1)");
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_CLOSEOUT");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    topic = database.getTopic("topic-1");
    const timeline = database.getTimeline("topic-1");
    // 전체 재계획으로 떨어지지 않았고(재계획 이벤트 없음), 수렴이 끝까지 갔다
    expect(timeline.some((event) => (event.body ?? "").includes("계획 실행을 처음부터 재시도합니다"))).toBe(false);
    expect(topic.state).toBe("AWAITING_USER_APPROVAL");
    database.close();
  });

  // 무수정 개정(개정 6·12 실측 패턴): planEdits: []는 "계획 변경 없음"이지 planMarkdown 누락이 아니다.
  it("planEdits가 빈 배열이면 계획을 그대로 두고 수렴을 잇는다", async () => {
    const first = validPlan("그대로 유지될 계획");
    const firstSHA = hashPlan(`${first.trim()}\n`);
    const { database, engine } = makePlanningEngine({
      slug: "plan-edits-empty",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "무수정 개정", planEdits: [], findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: firstSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: firstSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: firstSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    const topic = database.getTopic("topic-1");
    expect(topic.lastError ?? "").toBe("");
    expect(topic.state).toBe("AWAITING_USER_APPROVAL");
    expect(topic.planSHA256).toBe(firstSHA);
    database.close();
  });

  // 2026-08-31 Codex 지적: 계약 위반 응답(planMarkdown 없음)이 FAILED가 되고도 공용 메모리를 1회
  // 오염시켰다 — 검증이 saveAgentOutput(메모리 반영 지점)보다 뒤에 있었기 때문. 순서를 고정한다.
  it("계약 위반 응답은 공용 메모리를 바꾸지 못한다", async () => {
    const applied: unknown[] = [];
    const memory: ProjectMemoryWriter = {
      apply: async (_role, updates) => { applied.push(...updates); return []; },
    };
    const { database, engine } = makePlanningEngine({
      slug: "memory-after-validation",
      memory,
      claudeResults: [
        {
          kind: "PLAN", summary: "계획 없이 메모리만", findings: [], evidenceRefs: [],
          memoryUpdates: [{
            path: "feedback-y.md", expectedSHA256: null,
            content: "---\nname: feedback-y\ndescription: 교훈\nmetadata:\n  platform: shared\n  type: feedback\n---\n",
            reason: "오염 시도",
          }],
        },
        // 교정 회차에도 계획 없는 응답 — 메모리는 여전히 반영되면 안 된다.
        {
          kind: "PLAN", summary: "교정 회차에도 계획 없음", findings: [], evidenceRefs: [],
          memoryUpdates: [{
            path: "feedback-y.md", expectedSHA256: null,
            content: "---\nname: feedback-y\ndescription: 교훈\nmetadata:\n  platform: shared\n  type: feedback\n---\n",
            reason: "오염 재시도",
          }],
        },
      ],
      codexResults: [],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(database.getTopic("topic-1").lastError ?? "").toContain("planMarkdown");
    expect(applied).toHaveLength(0);
    database.close();
  });

  it("planEdits와 planMarkdown이 둘 다 오면 프롬프트에 명시한 대로 planEdits가 이긴다", async () => {
    const first = planWith("첫 계획", "패치 전 문장");
    const patched = normalizePlan(first.replace("패치 전 문장", "패치 후 문장"));
    const patchedSHA = hashPlan(patched);
    const { database, engine } = makePlanningEngine({
      slug: "plan-edits-priority",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        {
          kind: "REVISION", summary: "개정",
          planMarkdown: planWith("무시돼야 할 전문", "다른 문장"),
          planEdits: [{ find: "패치 전 문장", replace: "패치 후 문장" }],
          findings: [], evidenceRefs: [],
        },
        { kind: "ACK", summary: "확인", planSHA256: patchedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: patchedSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: patchedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").planSHA256).toBe(patchedSHA);
    database.close();
  });
});

// 감사 ⑨: 감사 도중 새 메시지가 오면 audit 산출물 없이 resume=CODEX_AUDIT·상태 USER_DECISION_REQUIRED가
// 된다. 전이표가 재감사를 막는다는 이유로 앞 지점(개정)으로 건너뛰면 'audit 결과를 찾을 수 없습니다'에 고착된다.
describe("재개 전제 산출물이 없으면 앞으로 건너뛰지 않는다", () => {
  it("audit 산출물이 없으면 개정 재개 대신 계획 재실행으로 떨어진다", async () => {
    const { database, engine } = await makePlanningRecovery("CODEX_AUDIT", {
      state: "USER_DECISION_REQUIRED",
      artifactKinds: ["claude-plan"], // audit 턴이 버려진 상황
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    const topic = database.getTopic("topic-1");
    expect(topic.lastError ?? "").not.toContain("audit 결과를 찾을 수 없습니다");
    const timeline = database.getTimeline("topic-1");
    expect(timeline.some((event) => (event.body ?? "").includes("처음부터 재시도"))).toBe(true);
    expect(timeline.some((event) => event.state === "CLAUDE_PLAN")).toBe(true);
    database.close();
  });
});

// 감사 ②: 미확정 commit/push 확인은 git await 사이에 낀다. 그 사이 세대가 올라가면 이전 세대의
// OID가 새 세대에 기록된다 — 확인이 끝날 때까지 범위 변경을 막는다.
describe("미확정 전달과 범위 변경", () => {
  it("결과가 불명확한 commit이 있으면 범위 변경을 거부한다", async () => {
    const { database, engine } = makePlanningEngine({
      slug: "scope-vs-delivery",
      claudeResults: [],
      codexResults: [],
    });
    database.claimActionRequest("topic-1", "commit", "unknown-commit-1", {
      message: "미확정 커밋", paths: ["a.txt"],
    });
    database.recoverInterruptedDeliveryRequests();
    expect(database.unknownDeliveryAction("topic-1")).not.toBeNull();

    await expect(engine.handleScopeChange("topic-1", "새 범위"))
      .rejects.toThrow("결과가 불명확한 commit 또는 push");
    database.close();
  });
});

// 감사 ⑥: 재시도마다 현재 HEAD를 기준으로 다시 잡으면, 서버가 중단된 사이 생긴 비인가 커밋이
// 다음 재시도의 '원래 상태'로 둔갑한다. 기준은 브랜치 생성 시점에 고정하고 불일치는 멈춘다.
describe("구현 기준 HEAD 고정", () => {
  it("고정된 기준과 현재 HEAD가 다르면 그 커밋을 기준으로 승격하지 않고 실패한다", async () => {
    const plan = validPlan("기준 고정");
    const planSHA256 = hashPlan(plan);
    const root = mkdtempSync(join(tmpdir(), "consensus-room-baseline-pin-"));
    temporaryDirectories.push(root);
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    database.createTopic({
      id: "topic-1", slug: "pin", title: "기준 고정",
      repositoryPath: "/tmp/repository", baseRef: "develop", worktreePath: "/tmp/worktree",
      branchName: "consensus/scope-ab12",
      state: "FAILED", scopeGeneration: 1, planRevision: 2, planSHA256,
      approvedPlanSHA256: planSHA256,
      createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", lastError: "재시도 준비",
    });
    database.updateTopic("topic-1", {
      resumeState: "IMPLEMENTING",
      implementationBaseOID: "a".repeat(40), // 브랜치 생성 시점에 고정된 기준
    });
    for (const role of ["claude", "codex"] as const) {
      database.upsertParticipant("topic-1", {
        role, sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: planSHA256,
      });
    }
    const artifacts = new ArtifactStore(join(root, "topics"), database);
    await artifacts.write("topic-1", "plan", 2, plan);
    // 현재 HEAD는 기준과 다른 커밋(서버 중단 사이 생긴 비인가 커밋을 흉내 낸다).
    const gitFake: CommandRunner = {
      run: async (spec) => {
        const args = spec.args;
        if (args[0] === "config") return { exitCode: 1, stdout: "", stderr: "", jsonLines: [] };
        if (args[0] === "rev-parse" && args.includes("--git-common-dir")) {
          return { exitCode: 0, stdout: join(root, "no-such-git-dir"), stderr: "", jsonLines: [] };
        }
        if (args[0] === "rev-parse" && args[1] === "HEAD") {
          return { exitCode: 0, stdout: `${"b".repeat(40)}\n`, stderr: "", jsonLines: [] };
        }
        if (args[0] === "branch") return { exitCode: 0, stdout: "consensus/scope-ab12\n", stderr: "", jsonLines: [] };
        return { exitCode: 0, stdout: "", stderr: "", jsonLines: [] };
      },
    };
    const engine = new WorkflowEngine({
      database, artifacts, git: new GitService(gitFake),
      claude: new QueuedAdapter("claude", []),
      codex: new QueuedAdapter("codex", []),
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    const topic = database.getTopic("topic-1");
    expect(topic.state).toBe("FAILED");
    expect(topic.lastError ?? "").toContain("구현 기준");
    // 기준이 비인가 커밋으로 승격되지 않았어야 한다.
    expect(database.getFlags("topic-1").implementationBaseOID).toBe("a".repeat(40));
    database.close();
  });
});

// 계획 단계에서 멈춘 주제를 저장된 산출물과 함께 만든다.
async function makePlanningRecovery(
  resumeState: "CODEX_AUDIT" | "CLAUDE_REVISION" | "CODEX_CLOSEOUT" | "CONSENSUS_ACK",
  queues: {
    claudeResults?: AgentResult[];
    codexResults?: AgentResult[];
    state?: "FAILED" | "USER_DECISION_REQUIRED";
    artifactKinds?: ReadonlyArray<"claude-plan" | "audit" | "claude-revision" | "closeout">;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-planning-resume-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  const plan = validPlan("계획 단계 재개");
  const planSHA256 = hashPlan(plan);
  database.createTopic({
    id: "topic-1",
    slug: "resume",
    title: "계획 단계 재개",
    repositoryPath: "/tmp/repository",
    baseRef: "develop",
    worktreePath: "/tmp/worktree",
    branchName: null,
    state: queues.state ?? "FAILED",
    scopeGeneration: 1,
    planRevision: 1,
    planSHA256,
    approvedPlanSHA256: null,
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    lastError: "재시도 준비",
  });
  database.updateTopic("topic-1", { resumeState });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant("topic-1", {
      role, sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: null,
    });
  }
  const artifacts = new ArtifactStore(join(root, "topics"), database);
  await artifacts.write("topic-1", "plan", 1, plan);
  const artifactKinds = queues.artifactKinds ?? ["claude-plan", "audit", "claude-revision", "closeout"];
  for (const [kind, resultKind] of ([
    ["claude-plan", "PLAN"], ["audit", "AUDIT"], ["claude-revision", "REVISION"], ["closeout", "CLOSEOUT"],
  ] as const).filter(([kind]) => artifactKinds.includes(kind))) {
    await artifacts.write("topic-1", kind, 1, JSON.stringify({
      kind: resultKind, summary: `저장된 ${kind}`, findings: [], evidenceRefs: [],
      planMarkdown: plan, planSHA256,
    }));
  }
  const engine = new WorkflowEngine({
    database,
    artifacts,
    git: new GitService(new RecordingGitRunner()),
    // 기본 큐는 비워 둔다. 재개가 계획 턴을 다시 돌리려 하면 그 시도 자체가 타임라인에 남는다.
    claude: new QueuedAdapter("claude", queues.claudeResults ?? []),
    codex: new QueuedAdapter("codex", queues.codexResults ?? []),
  });
  return { database, engine, artifacts, planSHA256 };
}

// 2026-08-29 회귀: 재개 조건이 CODEX_AUDIT만 봐서 CLAUDE_REVISION에서 죽으면 resetToDraft로 떨어졌고,
// 이미 나온 계획을 버리고 계획 턴을 통째로 다시 돌렸다.
describe("계획 단계 재시도는 저장된 계획을 다시 만들지 않는다", () => {
  for (const resumeState of ["CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT", "CONSENSUS_ACK"] as const) {
    it(`${resumeState}에서 멈춰도 계획 작성 단계로 되돌아가지 않는다`, async () => {
      const { database, engine } = await makePlanningRecovery(resumeState);

      engine.retry("topic-1");
      await waitForActionCompletion(database, "topic-1");

      const timeline = database.getTimeline("topic-1");
      expect(timeline.some((event) => event.state === "CLAUDE_PLAN")).toBe(false);
      expect(timeline.some((event) => (event.body ?? "").includes("처음부터 재시도"))).toBe(false);
      // resetToDraft가 돌면 planRevision이 0으로, planSHA256이 null로 지워진다.
      expect(database.getTopic("topic-1").planRevision).toBe(1);
      expect(database.getTopic("topic-1").planSHA256).not.toBeNull();
      database.close();
    });
  }

  // 2026-08-31 S0.2 실측: closeout이 사용자 결정을 요구하며 멈추면 전이표가 앞길을 전부 막아
  // 앞으로만 걷던 사다리가 후보를 못 찾고 전체 재계획으로 떨어졌다. 사용자 결정을 소비하는 단계는 개정이다.
  it("사용자 결정으로 멈춘 closeout은 재계획이 아니라 개정으로 되돌아간다", async () => {
    const plan = validPlan("계획 단계 재개");
    const sha = hashPlan(plan);
    const revision: AgentResult = {
      kind: "REVISION", summary: "사용자 결정을 반영한 개정",
      planMarkdown: plan, planSHA256: sha, findings: [], evidenceRefs: [],
    };
    const { database, engine } = await makePlanningRecovery("CODEX_CLOSEOUT", {
      state: "USER_DECISION_REQUIRED",
      claudeResults: [revision],
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    const timeline = database.getTimeline("topic-1");
    expect(timeline.some((event) => event.state === "CLAUDE_REVISION")).toBe(true);
    expect(timeline.some((event) => event.state === "CLAUDE_PLAN")).toBe(false);
    expect(timeline.some((event) => (event.body ?? "").includes("처음부터 재시도"))).toBe(false);
    expect(database.getTopic("topic-1").planRevision).not.toBe(0);
    database.close();
  });

  // ACK에서 죽은 주제(2026-08-29 사용량 한도 실측)의 재개: 네 턴을 하나도 다시 돌리지 않고 확인 절차만 완료한다.
  it("CONSENSUS_ACK에서 멈춘 주제는 ACK 두 턴만으로 승인 대기까지 간다", async () => {
    const plan = validPlan("계획 단계 재개");
    const sha = hashPlan(plan);
    const ack: AgentResult = { kind: "ACK", summary: "확인", planSHA256: sha, findings: [], evidenceRefs: [] };
    const { database, engine, artifacts } = await makePlanningRecovery(
      "CONSENSUS_ACK", { claudeResults: [ack], codexResults: [ack] },
    );

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    expect(await artifacts.readLatest("topic-1", "consensus")).not.toBeNull();
    const timeline = database.getTimeline("topic-1");
    for (const state of ["CLAUDE_PLAN", "CODEX_AUDIT", "CLAUDE_REVISION", "CODEX_CLOSEOUT"]) {
      expect(timeline.some((event) => event.state === state)).toBe(false);
    }
    database.close();
  });
});

function finding(
  id: string,
  title: string,
  overrides: Partial<AgentResult["findings"][number]> = {},
): AgentResult["findings"][number] {
  return {
    id,
    title,
    severity: "MEDIUM",
    disposition: "AGREED_NO_ACTION",
    rationale: "최종 리뷰에서 처분을 유지해야 합니다.",
    evidenceRefs: ["src/example.ts:1"],
    requiresUserDecision: false,
    ...overrides,
  };
}

async function waitForActionCompletion(database: ConsensusDatabase, topicId: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (database.runningAction(topicId)) {
    if (Date.now() >= deadline) throw new Error("action 종료를 기다리는 동안 제한 시간을 넘었습니다.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function waitForTopicState(
  database: ConsensusDatabase,
  topicId: string,
  expected: "AWAITING_USER_APPROVAL" | "USER_DECISION_REQUIRED",
): Promise<void> {
  if (database.getTopic(topicId).state === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const eventName = `topic:${topicId}`;
    const timeout = setTimeout(() => {
      cleanup();
      const topic = database.getTopic(topicId);
      const action = database.runningAction(topicId);
      reject(new Error(
        `기다린 상태=${expected}, 현재 상태=${topic.state}, action=${action?.status ?? "없음"}, lastError=${topic.lastError ?? "없음"}`,
      ));
    }, 2_000);
    const listener = (event: { state: string }) => {
      if (event.state === expected) {
        cleanup();
        resolve();
      } else if (event.state === "FAILED" || event.state === "USER_DECISION_REQUIRED") {
        cleanup();
        const topic = database.getTopic(topicId);
        reject(new Error(`계획 왕복 실패: ${topic.lastError ?? "원인 없음"}`));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      database.events.off(eventName, listener);
    };
    database.events.on(eventName, listener);
  });
}

// 기계 계약 위반은 작업 실패가 아니라 표기 실패다 — 같은 세션 1회 교정으로 회수하고,
// 두 번째 위반만 실패로 보낸다(2026-09-01 S1.1: 처분 계약 위반 하나로 1시간 구현 턴이 소각된 사건).
describe("기계 계약 위반 자가 교정", () => {
  it("계약 위반 턴을 같은 세션에 돌려보내 1회 교정으로 회수한다", async () => {
    const revisedPlan = validPlan("교정 뒤 개정 계획");
    const revisedSHA = hashPlan(`${revisedPlan.trim()}\n`);
    const { database, engine, claude } = makePlanningEngine({
      slug: "contract-correction",
      claudeResults: [
        { kind: "AUDIT", summary: "종류가 틀린 응답", findings: [], evidenceRefs: [] },
        { kind: "PLAN", summary: "교정된 첫 계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revisedPlan, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });

    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    const correction = claude.calls.find((prompt) => prompt.includes("거부 사유"));
    expect(correction).toContain("에이전트 응답 종류가 다릅니다");
    expect(database.getTimeline("topic-1").some((event) => String(event.body).includes("1회 교정합니다"))).toBe(true);
    database.close();
  });

  it("교정 뒤에도 위반이면 실패로 보내고 무한 교정하지 않는다", async () => {
    const { database, engine, claude } = makePlanningEngine({
      slug: "contract-correction-fail",
      claudeResults: [
        { kind: "AUDIT", summary: "틀린 응답 1", findings: [], evidenceRefs: [] },
        { kind: "AUDIT", summary: "틀린 응답 2", findings: [], evidenceRefs: [] },
      ],
      codexResults: [],
    });

    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(claude.calls.filter((prompt) => prompt.includes("거부 사유")).length).toBe(1);
    database.close();
  });
});

// 최종 리뷰 신규 쟁점을 사용자 결정이 소비하면 재리뷰가 같은 쟁점으로 다시 멈추지 않는다.
// 결정 없는 재실행은 여전히 멈춘다 — 조용한 종결 방지(2026-09-01 S1.1 R4 무변경 fix 패스 루프의 대체).
describe("최종 리뷰 신규 쟁점의 사용자 결정 소비", () => {
  // 2026-09-07 분류 규칙: 새 쟁점을 수정 없이 RESOLVED_BY_FIX 로 닫은 경우가 사용자 판단 대상이다(AGREED_NO_ACTION·DEFERRED 는 후속 목록에 기록만).
  const newFinding = finding("F-NEW", "최종 리뷰에서 처음 나온 절차 기록", { disposition: "RESOLVED_BY_FIX" });
  const finalReview: AgentResult = {
    kind: "FINAL_REVIEW", summary: "신규 쟁점 1건을 기록한 최종 리뷰",
    findings: [newFinding], evidenceRefs: [],
  };

  it("범위 밖으로 처분된 신규 쟁점은 후속 목록에 기록되고 전달을 막지 않는다", async () => {
    const deferredNew = finding("F-DEFER", "범위 밖 개선 제안", { disposition: "DEFERRED_OUT_OF_SCOPE" });
    const { database, engine, artifacts } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW", implementationFindings: [], originalReviewFindings: [],
      codexResult: { kind: "FINAL_REVIEW", summary: "이연 1건", findings: [deferredNew], evidenceRefs: [] },
    });
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(await artifacts.readLatest("topic-1", "deferred-findings")).toContain("F-DEFER");
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("후속 목록에 기록") && event.body.includes("F-DEFER"))).toBe(true);
    database.close();
  });

  it("결정이 소비한 신규 쟁점은 재리뷰에서 기지로 보고 전달 준비를 선언한다", async () => {
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [],
      originalReviewFindings: [],
      codexResult: finalReview,
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
    const interruptEvent = database.getTimeline("topic-1").find((event) =>
      Array.isArray(event.payload.finalReviewNewFindingIDs));
    expect(interruptEvent?.payload.finalReviewNewFindingIDs).toEqual(["F-NEW"]);

    database.appendEvent({
      topicId: "topic-1", actor: "user", kind: "decision", state: "USER_DECISION_REQUIRED",
      body: "F-NEW는 기록만 유지하고 종결한다.", payload: {},
    });
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    database.close();
  });

  it("결정 없는 재실행은 같은 신규 쟁점으로 다시 멈춘다", async () => {
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [],
      originalReviewFindings: [],
      codexResult: finalReview,
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
    expect(database.getTimeline("topic-1").filter((event) =>
      Array.isArray(event.payload.finalReviewNewFindingIDs)).length).toBe(2);
    database.close();
  });
});

// 턴이 진행 중인 동안 사용자 입력·종료를 넣기 위해 호출을 게이트로 붙잡는 어댑터. signal 이 abort 되면 그 reason 으로 거부한다.
class GatedAdapter implements AgentAdapter {
  readonly calls: string[] = [];
  readonly started: Promise<void>;
  private markStarted!: () => void;
  private release!: () => void;
  private readonly gate: Promise<void>;

  constructor(readonly role: "claude" | "codex", private readonly results: AgentResult[]) {
    this.gate = new Promise<void>((resolve) => { this.release = resolve; });
    this.started = new Promise<void>((resolve) => { this.markStarted = resolve; });
  }

  open(): void { this.release(); }

  async createSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    this.calls.push(turn.prompt); this.markStarted();
    await this.wait(turn.signal);
    return { sessionId: `${this.role}-created-session`, result: this.next() };
  }

  async resumeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    this.calls.push(turn.prompt); this.markStarted();
    await this.wait(turn.signal);
    return this.next();
  }

  async validateExistingSession() { return true; }

  private wait(signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      signal?.addEventListener("abort", () => {
        reject(signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason)));
      }, { once: true });
      void this.gate.then(resolve);
    });
  }

  private next(): AgentResult {
    const result = this.results.shift();
    if (!result) throw new Error(`${this.role} 가짜 응답이 부족합니다.`);
    return result;
  }
}

function makeGatedPlanningEngine(claude: AgentAdapter, codex: AgentAdapter) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-gated-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  database.createTopic({
    id: "topic-1", slug: "gated", title: "게이트 계획", repositoryPath: "/tmp/repository", baseRef: "develop",
    worktreePath: "/tmp/worktree", branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0,
    planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z", lastError: null,
  });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant("topic-1", { role, sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: null });
  }
  const artifacts = new ArtifactStore(join(root, "topics"), database);
  const engine = new WorkflowEngine({
    database, artifacts, git: new GitService({ run: async () => { throw new Error("사용하지 않습니다."); } }), claude, codex,
  });
  return { database, artifacts, engine };
}

// 2026-09-07 엔진 수정(Codex 2차 제안 ①②③ + 중재자 #7, 사용자 승인 "그렇게 해라"): 회차는 완주 시점에 소비,
// 종료 시 실행 중 에이전트 정리, note 는 턴을 멈추지 않음, 사용자 결정이 id 로 뒤집은 처분은 가드 통과.
describe("2026-09-07 엔진 수정: 회차 소비·종료 정리·메모 비중단·결정으로 뒤집힌 처분", () => {
  it("#7 사용자 결정이 finding id 를 명시하면 최종 리뷰의 하향 처분이 가드에 걸리지 않고 전달 준비로 간다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const overruled = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_NO_ACTION" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW",
      implementationFindings: [overruled],
      originalReviewFindings: [agreed],
      codexResult: { kind: "FINAL_REVIEW", summary: "결정대로 닫은 최종 리뷰", findings: [overruled], evidenceRefs: [] },
    });
    // 첫 리뷰 산출물(revision 1) 뒤의 시퀀스를 만들고, 결정 본문에 id 를 통째로 적는다.
    await engine.postMessage("topic-1", "note", "참고 메모");
    await engine.postMessage("topic-1", "decision", "`F-ORIGINAL` 은 중재자 예외로 확정한다(AGREED_NO_ACTION). 최종 리뷰는 이 결정을 따른다.");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("사용자 결정이 처분 변경을 허용한 쟁점: F-ORIGINAL(AGREED_ACTION → AGREED_NO_ACTION)"))).toBe(true);
    database.close();
  });

  it("#7 id 를 부분 문자열로만 담은 결정은 뒤집은 것으로 치지 않는다", async () => {
    const agreed = finding("F-1", "결함", { disposition: "AGREED_ACTION" });
    const closed = finding("F-1", "결함", { disposition: "AGREED_NO_ACTION" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW", implementationFindings: [closed], originalReviewFindings: [agreed],
      codexResult: { kind: "FINAL_REVIEW", summary: "닫은 최종 리뷰", findings: [closed], evidenceRefs: [] },
    });
    await engine.postMessage("topic-1", "note", "참고 메모");
    await engine.postMessage("topic-1", "decision", "F-10 과 F-11 은 예외로 확정한다.");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({
      state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("수정 확인 없이 닫았습니다(F-1)"),
    });
    database.close();
  });

  it("가드로 멈춘 최종 리뷰는 그 뒤의 결정으로 통과 조건을 만족하면 Codex 턴 없이 재사용된다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const closed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_NO_ACTION" });
    const review: AgentResult = { kind: "FINAL_REVIEW", summary: "예외로 닫은 최종 리뷰", findings: [closed], evidenceRefs: [] };
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW", implementationFindings: [closed], originalReviewFindings: [agreed],
      codexResult: review,
      // 리뷰 하나뿐 — 재개가 Codex 를 다시 부르면 가짜 응답 부족으로 FAILED 가 되어 드러난다.
      codexResults: [review],
    });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1")).toMatchObject({
      state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("수정 확인 없이 닫았습니다(F-ORIGINAL)"),
    });
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_FINAL_REVIEW");

    await engine.postMessage("topic-1", "decision", "F-ORIGINAL 은 중재자 예외(AGREED_NO_ACTION)로 확정한다.");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(database.getFlags("topic-1")).toMatchObject({ reviewedHead: "a".repeat(40), resumeState: null });
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("저장된 최종 리뷰") && body.includes("Codex 턴 없이"))).toBe(true);
    database.close();
  });

  it("#1 2차 수정이 결과를 내기 전에 실패하면 회차를 소비하지 않아 재시도가 다시 에이전트를 부른다", async () => {
    const agreed = finding("F-ORIGINAL", "첫 리뷰가 고치기로 한 결함", { disposition: "AGREED_ACTION" });
    const remaining: AgentResult = { kind: "FINAL_REVIEW", summary: "결함이 남은 최종 리뷰", findings: [agreed], evidenceRefs: [] };
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW", implementationFindings: [agreed], originalReviewFindings: [agreed],
      codexResult: remaining, codexResults: [remaining, remaining],
      claudeResults: [], // 2차 수정 턴이 일시 실패(응답 없음)한다
    });
    database.updateTopic("topic-1", { fixPassUsed: true });
    database.setImplementationSession("topic-1", "claude-implementation-session");

    // 2026-09-07: 남은 회차 안이라 결정 없이 2차 수정이 바로 열리고, 응답이 없어 그 턴이 실패한다.
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1")).toMatchObject({ state: "FAILED", lastError: expect.stringContaining("claude 가짜 응답이 부족합니다") });
    expect(database.getFlags("topic-1")).toMatchObject({ resumeState: "CLAUDE_FIX", secondFixPassUsed: false });

    // 종전(시작 시 소비)에는 여기서 "두 번까지만 허용" 으로 막혔다. 지금은 같은 회차를 다시 시도한다.
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").lastError).toContain("claude 가짜 응답이 부족합니다");
    expect(database.getTopic("topic-1").lastError).not.toContain("두 번까지만");
    expect(database.getFlags("topic-1").secondFixPassUsed).toBe(false);
    database.close();
  });

  it("#3 턴 도중의 note 는 턴을 멈추지 않고, decision 은 멈추되 결과를 산출물로 보존한다", async () => {
    const plan: AgentResult = { kind: "PLAN", summary: "게이트 뒤의 계획", planMarkdown: validPlan("게이트 계획"), findings: [], evidenceRefs: [] };
    // note: 계획 턴이 완주해 다음 단계(codex 감사)까지 간다 — codex 응답이 없어 그 단계에서 실패하는 것이 완주의 증거.
    {
      const claude = new GatedAdapter("claude", [plan]);
      const { database, engine } = makeGatedPlanningEngine(claude, new QueuedAdapter("codex", []));
      engine.startPlan("topic-1");
      await claude.started;
      await engine.postMessage("topic-1", "note", "참고: 관련 문서 링크");
      claude.open();
      await waitForActionCompletion(database, "topic-1");

      expect(database.getTopic("topic-1")).toMatchObject({ state: "FAILED", lastError: expect.stringContaining("codex 가짜 응답이 부족합니다") });
      expect(database.getFlags("topic-1").resumeState).toBe("CODEX_AUDIT");
      expect(database.getTimeline("topic-1").some((event) => event.body.includes("새 메시지가 추가되었습니다"))).toBe(false);
      database.close();
    }
    // decision: 턴을 멈추고 결과는 `claude-interrupted` 로 남는다.
    {
      const claude = new GatedAdapter("claude", [plan]);
      const { database, artifacts, engine } = makeGatedPlanningEngine(claude, new QueuedAdapter("codex", []));
      engine.startPlan("topic-1");
      await claude.started;
      await engine.postMessage("topic-1", "decision", "범위를 바꾼다: 모듈 B 는 제외.");
      claude.open();
      await waitForActionCompletion(database, "topic-1");

      expect(database.getTopic("topic-1")).toMatchObject({ state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("새 메시지가 추가되었습니다") });
      expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_PLAN");
      const preserved = await artifacts.readLatest("topic-1", "claude-interrupted");
      expect(preserved).toContain("게이트 뒤의 계획");
      expect(database.getTimeline("topic-1").some((event) => event.body.includes("claude-interrupted"))).toBe(true);
      database.close();
    }
  });

  it("#2 shutdown 은 실행 중 action 을 중단해 원장을 마감하고, 그 뒤 새 실행을 거부한다", async () => {
    const claude = new GatedAdapter("claude", []);
    const { database, engine } = makeGatedPlanningEngine(claude, new QueuedAdapter("codex", []));
    engine.startPlan("topic-1");
    await claude.started;

    const stopped = await engine.shutdown(5_000);

    expect(stopped).toBe(1);
    expect(database.runningAction("topic-1")).toBeNull();
    expect(database.getTopic("topic-1")).toMatchObject({ state: "FAILED", lastError: expect.stringContaining("서버 종료로 실행을 중단했습니다") });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_PLAN");
    expect(database.getTimeline("topic-1").some((event) => event.body === "실행을 중단했습니다.")).toBe(true);
    // retry 는 원장을 먼저 바꾸는 진입점이다(resetToDraft·transition) — 종료 중에는 바꾸기 전에 거부해야 한다.
    expect(() => engine.retry("topic-1")).toThrow("종료 중");
    expect(database.getTopic("topic-1").state).toBe("FAILED");
    database.close();
  });
});

// 2026-09-07 Codex 2차 제안 ④: 닫힌 주제의 빌드 트리 정리 — *-logs 만 남기고 DerivedData 하위를 지운다.
describe("닫힌 주제 빌드 트리 정리(archive)", () => {
  function closedTopicWithDerivedData() {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-archive-"));
    temporaryDirectories.push(root);
    const worktree = join(root, "worktree");
    for (const dir of ["DerivedData/s7-logs/artifacts", "DerivedData/gate2-a/Build", "DerivedData/s71-post/Build"]) {
      mkdirSync(join(worktree, dir), { recursive: true });
      writeFileSync(join(worktree, dir, "file.txt"), "x".repeat(1024));
    }
    writeFileSync(join(worktree, "DerivedData", "note.txt"), "파일은 건드리지 않는다");
    const database = new ConsensusDatabase(join(root, "room.sqlite"));
    database.createTopic({
      id: "topic-1", slug: "archive", title: "정리", repositoryPath: "/tmp/repository", baseRef: "develop",
      worktreePath: worktree, branchName: "consensus/archive", state: "CLOSED", scopeGeneration: 1, planRevision: 1,
      planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z", lastError: null,
    });
    const engine = new WorkflowEngine({
      database, artifacts: new ArtifactStore(join(root, "topics"), database),
      git: new GitService({ run: async () => { throw new Error("사용하지 않습니다."); } }),
      claude: new QueuedAdapter("claude", []), codex: new QueuedAdapter("codex", []),
    });
    return { database, engine, worktree };
  }

  it("CLOSED 주제의 DerivedData 에서 *-logs 가 아닌 디렉터리만 지우고 원장에 남긴다", async () => {
    const { database, engine, worktree } = closedTopicWithDerivedData();

    engine.archiveBuildTrees("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(existsSync(join(worktree, "DerivedData", "s7-logs", "artifacts", "file.txt"))).toBe(true);
    expect(existsSync(join(worktree, "DerivedData", "note.txt"))).toBe(true);
    expect(existsSync(join(worktree, "DerivedData", "gate2-a"))).toBe(false);
    expect(existsSync(join(worktree, "DerivedData", "s71-post"))).toBe(false);
    expect(database.getTopic("topic-1").state).toBe("CLOSED");
    const body = database.getTimeline("topic-1").map((event) => event.body).find((text) => text.startsWith("빌드 트리 정리"));
    expect(body).toContain("2개 삭제");
    expect(body).toContain("gate2-a, s71-post");
    expect(body).toContain("보존: s7-logs");

    // 두 번째 실행은 지울 것이 없어도 실패하지 않는다.
    engine.archiveBuildTrees("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTimeline("topic-1").filter((event) => event.body.startsWith("빌드 트리 정리")).length).toBe(2);
    database.close();
  });

  it("닫히지 않은 주제는 거부한다", () => {
    const { database, engine } = closedTopicWithDerivedData();
    database.updateTopic("topic-1", { state: "READY_TO_DELIVER" });
    expect(() => engine.archiveBuildTrees("topic-1")).toThrow("CLOSED");
    database.close();
  });
});

// 2026-09-07 S10 #17: 계획 턴이 "더 필요한 결정 없음" 을 requestedUserDecision 에 담아 멈췄다. 결정 뒤 retry 가 계획 턴을
// 다시 사지 않고 저장된 계획으로 감사에 들어가야 한다. 결정이 없으면(인프라 재시도) 종전대로 처음부터 돈다.
describe("멈춘 계획의 재사용", () => {
  const plan = validPlan("멈춘 계획");
  const pausedPlan: AgentResult = {
    kind: "PLAN", summary: "결정을 묻는 계획", planMarkdown: plan, findings: [], evidenceRefs: [],
    requestedUserDecision: "게이트 2 주기를 정해 주세요.",
  };

  it("결정이 올라온 뒤 retry 는 계획 턴 없이 저장된 계획으로 감사에 들어간다", async () => {
    const { database, artifacts, engine, claude, codex } = makePlanningEngine({
      slug: "paused-plan-reuse",
      claudeResults: [pausedPlan],
      codexResults: [{ kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] }],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_PLAN");
    expect(await artifacts.readLatest("topic-1", "plan")).toBeNull();

    await engine.postMessage("topic-1", "decision", "게이트 2 는 6회 주기로 간다.");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // 계획 턴은 1회뿐, 감사는 저장된 계획으로 돌았다(개정 응답이 없어 그 단계에서 실패하는 것이 진행의 증거).
    expect(claude.calls).toHaveLength(2);
    expect(codex.calls).toHaveLength(1);
    expect(codex.calls[0]).toContain("멈춘 계획: ");
    expect(await artifacts.readLatest("topic-1", "plan")).toContain("멈춘 계획");
    expect(database.getTopic("topic-1")).toMatchObject({ state: "FAILED", lastError: expect.stringContaining("claude 가짜 응답이 부족합니다") });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_REVISION");
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("저장된 계획") && body.includes("계획 턴을 다시 사지 않습니다"))).toBe(true);
    expect(bodies.some((body) => body.includes("처음부터 재시도"))).toBe(false);
    database.close();
  });

  it("결정 없이 retry 하면 종전대로 처음부터 다시 돈다", async () => {
    const { database, engine, claude } = makePlanningEngine({
      slug: "paused-plan-restart",
      claudeResults: [pausedPlan, pausedPlan],
      codexResults: [],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(claude.calls).toHaveLength(2);
    expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("처음부터 재시도"))).toBe(true);
    database.close();
  });
});

// 2026-09-07 Codex 지적 보정: 구현·수정 경로의 저장 전 중단도 결과를 보존하고, 멈춘 수정 결과는 결정 뒤 재사용한다.
describe("구현·수정 경로의 결과 보존과 멈춘 수정 결과 재사용", () => {
  it("수정 턴 도중 결정이 오면 결과를 claude-interrupted 로 보존하고 멈춘다", async () => {
    const agreed = finding("F-1", "결함", { disposition: "AGREED_ACTION" });
    const resolved = finding("F-1", "결함", { disposition: "RESOLVED_BY_FIX" });
    const claude = new GatedAdapter("claude", [{ kind: "FIX", summary: "게이트 뒤의 수정", findings: [resolved], evidenceRefs: [] }]);
    const { database, engine, artifacts } = await makeReviewRecovery({
      resumeState: "CLAUDE_FIX", implementationFindings: [agreed], originalReviewFindings: [agreed],
      codexResult: { kind: "FINAL_REVIEW", summary: "사용 안 함", findings: [resolved], evidenceRefs: [] }, claude,
    });
    engine.retry("topic-1");
    await claude.started;
    await engine.postMessage("topic-1", "decision", "수정 범위를 바꾼다.");
    claude.open();
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({ state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("새 메시지가 추가되었습니다") });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_FIX");
    expect(await artifacts.readLatest("topic-1", "claude-interrupted")).toContain("게이트 뒤의 수정");
    expect(await artifacts.readLatest("topic-1", "claude-fix")).toBeNull();
    database.close();
  });

  it("수정 턴이 결정을 물어 멈춘 뒤 결정이 오면 retry 는 수정 턴 없이 저장된 결과로 최종 리뷰에 들어간다", async () => {
    const agreed = finding("F-1", "결함", { disposition: "AGREED_ACTION" });
    const resolved = finding("F-1", "결함", { disposition: "RESOLVED_BY_FIX" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CLAUDE_FIX", implementationFindings: [agreed], originalReviewFindings: [agreed],
      codexResult: { kind: "FINAL_REVIEW", summary: "수정 확인", findings: [resolved], evidenceRefs: [] },
      codexResults: [{ kind: "FINAL_REVIEW", summary: "수정 확인", findings: [resolved], evidenceRefs: [] }],
      // 수정 응답 하나뿐 — 재개가 수정 턴을 다시 부르면 가짜 응답 부족으로 FAILED 가 되어 드러난다.
      claudeResults: [{
        kind: "FIX", summary: "고쳤지만 범위 확인 요청", findings: [resolved], evidenceRefs: ["feature.txt"],
        requestedUserDecision: "도구 폴더도 손대도 되는지 확인해 주세요.",
      }],
    });
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1")).toMatchObject({ state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("도구 폴더") });
    expect(database.getFlags("topic-1")).toMatchObject({ resumeState: "CLAUDE_FIX", fixPassUsed: false });

    await engine.postMessage("topic-1", "decision", "도구 폴더 수정을 승인한다.");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(database.getFlags("topic-1").fixPassUsed).toBe(true);
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("저장된 수정 결과") && body.includes("수정 턴을 다시 사지 않습니다"))).toBe(true);
    database.close();
  });
});

// 2026-09-07 S10 #31: 개정 턴이 배치 순서 확인 하나를 requestedUserDecision 에 담아 멈췄다. 결정 뒤 retry 는 개정 턴을
// 다시 사지 않고 저장된 개정본으로 종결 확인에 들어가야 한다.
describe("멈춘 개정의 재사용", () => {
  it("결정이 올라온 뒤 retry 는 개정 턴 없이 저장된 개정본으로 종결 확인에 들어간다", async () => {
    const first = validPlan("첫 계획");
    const revised = validPlan("개정 계획");
    const revisedSHA = hashPlan(`${revised.trim()}\n`);
    const { database, artifacts, engine, claude, codex } = makePlanningEngine({
      slug: "paused-revision-reuse",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        {
          kind: "REVISION", summary: "개정 — 배치 순서 확인 요청", planMarkdown: revised, findings: [], evidenceRefs: [],
          requestedUserDecision: "S10.10 을 B1 첫 폴더로 옮겨도 됩니까?",
        },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1")).toMatchObject({ state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("S10.10") });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_REVISION");
    expect(claude.calls).toHaveLength(2);

    await engine.postMessage("topic-1", "decision", "승인한다. S10.10 을 B1 첫 폴더로.");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // 개정 턴은 다시 돌지 않았고(개정 프롬프트 1회 그대로; 세 번째 claude 호출은 종결 뒤 ACK 시도), 종결 확인이 저장된 개정본으로 돌았다.
    expect(claude.calls.filter((prompt) => prompt.includes("Codex 감사에 답하고"))).toHaveLength(1);
    expect(claude.calls[2]).toContain("프로토콜 확인 단계입니다.");
    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1]).toContain("개정 계획: ");
    expect(await artifacts.readLatest("topic-1", "plan")).toContain("개정 계획");
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("저장된 개정") && body.includes("개정 턴을 다시 사지 않습니다"))).toBe(true);
    // 종결 뒤 ACK 응답이 없어 그 단계에서 실패하는 것이 진행의 증거.
    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(database.getFlags("topic-1").resumeState).toBe("CONSENSUS_ACK");
    database.close();
  });
});

// 2026-09-07 사용자 결정 "개정 2회차로 바꿔": 종결 확인의 새 쟁점은 처음부터 다시 도는 대신 개정 2회차(새 쟁점만, planEdits)
// 로 반영하고 종결 확인을 다시 한다. 바퀴당 1회 — 그 뒤에도 새 쟁점이면 종전대로 사용자 결정 뒤 재시작.
describe("종결 확인의 새 쟁점 → 개정 2회차", () => {
  const first = validPlan("첫 계획");
  const revised = validPlan("개정 계획");
  const revisedSHA = hashPlan(`${revised.trim()}\n`);
  const third = validPlan("개정 2회차 계획");
  const thirdSHA = hashPlan(`${third.trim()}\n`);
  const auditFinding = finding("A-1", "감사 지적", { disposition: "AGREED_ACTION" });
  const closeoutNew = finding("C-NEW", "종결에서 처음 나온 쟁점", { disposition: "AGREED_ACTION" });

  it("새 쟁점만 개정 2회차로 반영하고 종결 확인을 다시 해 승인 대기까지 간다", async () => {
    const { database, artifacts, engine, claude, codex } = makePlanningEngine({
      slug: "closeout-revision-2",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: [auditFinding], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정 2회차", planMarkdown: third, findings: [closeoutNew], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: thirdSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [auditFinding], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결 — 새 쟁점", planSHA256: revisedSHA, findings: [auditFinding, closeoutNew], evidenceRefs: [] },
        // 2회차 종결: 개정 1회차 쟁점(A-1)을 다시 적어도 "새 쟁점" 이 아니다(known = 1회차 ∪ 2회차).
        { kind: "CLOSEOUT", summary: "종결 2회차", planSHA256: thirdSHA, findings: [auditFinding, closeoutNew], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: thirdSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    expect(database.getTopic("topic-1").planSHA256).toBe(thirdSHA);
    expect(database.getFlags("topic-1").closeoutRevisionUsed).toBe(true);
    expect(await artifacts.readLatest("topic-1", "plan")).toContain("개정 2회차 계획");
    // 개정 2회차 프롬프트는 새 쟁점만 담고, 감사 지적은 담지 않는다.
    const revision2Prompt = claude.calls[2];
    expect(revision2Prompt).toContain("개정 2회차");
    expect(revision2Prompt).toContain("C-NEW");
    expect(revision2Prompt).not.toContain("A-1");
    expect(revision2Prompt).toContain("개정 계획: "); // 2판이 기존 계획
    expect(codex.calls).toHaveLength(4);
    expect(codex.calls[2]).toContain("개정 2회차는 이미 썼으므로");
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("개정 2회차로 최신 계획 위에 반영합니다"))).toBe(true);
    expect(bodies.some((body) => body.includes("처음부터 재시도"))).toBe(false);
    database.close();
  });

  const closeoutNew2 = finding("C-NEW-2", "2회차 종결에서 또 나온 필수 쟁점", { disposition: "AGREED_ACTION" });

  function exhaustedRound(extraClaude: AgentResult[], extraCodex: AgentResult[]) {
    return {
      ...makePlanningEngine({
        slug: "closeout-exhausted",
        claudeResults: [
          { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
          { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: [auditFinding], evidenceRefs: [] },
          { kind: "REVISION", summary: "개정 2회차", planMarkdown: third, findings: [closeoutNew], evidenceRefs: [] },
          ...extraClaude,
        ],
        codexResults: [
          { kind: "AUDIT", summary: "감사", findings: [auditFinding], evidenceRefs: [] },
          { kind: "CLOSEOUT", summary: "종결 — 새 쟁점", planSHA256: revisedSHA, findings: [auditFinding, closeoutNew], evidenceRefs: [] },
          { kind: "CLOSEOUT", summary: "종결 2회차 — 또 필수 쟁점", planSHA256: thirdSHA, findings: [closeoutNew, closeoutNew2], evidenceRefs: [] },
          ...extraCodex,
        ],
      }),
    };
  }

  it("개정 2회차 뒤에도 필수 쟁점이 남으면 최신 계획을 보존한 채 한 번 결정받고, 결정 뒤 그 쟁점만 추가 개정한다", async () => {
    const fourth = validPlan("추가 개정 계획");
    const fourthSHA = hashPlan(`${fourth.trim()}\n`);
    const { database, engine, claude, codex } = exhaustedRound(
      [{ kind: "REVISION", summary: "추가 개정", planMarkdown: fourth, findings: [closeoutNew2], evidenceRefs: [] }],
      [{ kind: "CLOSEOUT", summary: "종결 3회차", planSHA256: fourthSHA, findings: [closeoutNew2], evidenceRefs: [] }],
    );
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1")).toMatchObject({ state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("필수 쟁점이 남았습니다(C-NEW-2)") });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_REVISION");
    expect(database.getTopic("topic-1").planRevision).toBe(3); // 최신 계획 보존
    expect(claude.calls).toHaveLength(3);

    await engine.postMessage("topic-1", "decision", "C-NEW-2 는 범위에 넣는다. 최신 계획 위에 반영하라.");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // 첫 계획 턴이 아니라 C-NEW-2 만 담은 추가 개정 턴이 돌았고(4번째), 종결 3회차 통과 뒤 ACK 턴(5번째)까지 갔다.
    expect(claude.calls).toHaveLength(5);
    expect(claude.calls[3]).toContain("Codex 종결 확인의 새 쟁점:");
    expect(claude.calls[3]).not.toContain("계획 작성자");
    expect(claude.calls[3]).toContain("C-NEW-2");
    expect(claude.calls[3]).not.toContain("C-NEW\"");
    expect(codex.calls).toHaveLength(4);
    expect(database.getTopic("topic-1").planRevision).toBe(4);
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("추가 개정로") || body.includes("추가 개정으로") || body.includes("추가 개정"))).toBe(true);
    expect(bodies.some((body) => body.includes("처음부터 재시도"))).toBe(false);
    // 종결 3회차 통과 → ACK 응답이 없어 그 단계에서 실패하는 것이 진행의 증거
    expect(database.getFlags("topic-1").resumeState).toBe("CONSENSUS_ACK");
    database.close();
  });

  it("결정에 REPLAN 을 적으면 그때만 처음부터 다시 돌고 옛 계획을 재사용하지 않는다", async () => {
    const { database, engine, claude } = exhaustedRound(
      [{ kind: "PLAN", summary: "재시작 계획", planMarkdown: validPlan("재시작 계획"), findings: [], evidenceRefs: [] }],
      [],
    );
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_REVISION");

    await engine.postMessage("topic-1", "decision", "핵심 전제가 바뀌었다. REPLAN");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(claude.calls).toHaveLength(4);
    expect(claude.calls[3]).toContain("계획 작성자");
    expect(database.getFlags("topic-1").closeoutRevisionUsed).toBe(false); // 새 바퀴
    const bodies = database.getTimeline("topic-1").map((event) => event.body);
    expect(bodies.some((body) => body.includes("REPLAN 지시로"))).toBe(true);
    expect(bodies.some((body) => body.includes("저장된 계획"))).toBe(false);
    database.close();
  });

  it("종결 확인이 범위 밖으로 처분한 새 쟁점은 후속 목록에 기록만 하고 승인 대기로 간다", async () => {
    const deferredNew = finding("C-DEF", "범위 밖 개선 제안", { disposition: "DEFERRED_OUT_OF_SCOPE" });
    const { database, artifacts, engine, claude } = makePlanningEngine({
      slug: "closeout-deferred",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: [auditFinding], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [auditFinding], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결 — 이연 1건", planSHA256: revisedSHA, findings: [auditFinding, deferredNew], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: revisedSHA, findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    expect(claude.calls.filter((prompt) => prompt.includes("Codex 종결 확인의 새 쟁점:"))).toHaveLength(0);
    expect(await artifacts.readLatest("topic-1", "deferred-findings")).toContain("C-DEF");
    expect(database.getTimeline("topic-1").some((event) => event.body.includes("후속 목록에 기록") && event.body.includes("C-DEF"))).toBe(true);
    database.close();
  });

  it("선행 토픽이 이연한 쟁점은 후속 토픽의 첫 계획·감사 프롬프트에 자동으로 실린다", async () => {
    const { database, artifacts, engine, claude, codex } = makePlanningEngine({
      slug: "predecessor",
      claudeResults: [{ kind: "PLAN", summary: "후속 계획", planMarkdown: validPlan("후속 계획"), findings: [], evidenceRefs: [] }],
      codexResults: [],
    });
    await artifacts.write("topic-1", "deferred-findings", 1, JSON.stringify({ findings: [{
      id: "C-DEF", title: "선행 토픽이 이연한 개선", severity: "MEDIUM", rationale: "다음 계획에서 판단", source: "closeout",
      topicId: "topic-1", recordedAt: "2026-09-07T00:00:00.000Z",
    }] }));
    database.createTopic({
      id: "topic-2", slug: "successor", title: "후속 주제", repositoryPath: "/tmp/repository", baseRef: "develop",
      worktreePath: "/tmp/worktree-2", branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0,
      planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z", lastError: null, predecessorTopicId: "topic-1",
    });
    for (const role of ["claude", "codex"] as const) {
      database.upsertParticipant("topic-2", { role, sessionId: `${role}-session-2`, mode: "attached", acknowledgedPlanSHA256: null });
    }
    engine.startPlan("topic-2");
    await waitForActionCompletion(database, "topic-2");

    expect(claude.calls[0]).toContain("이연된 쟁점");
    expect(claude.calls[0]).toContain("C-DEF");
    // 감사 응답이 없어 감사에서 실패하지만, 감사 프롬프트에도 목록이 실렸다.
    expect(codex.calls[0]).toContain("이미 이연 판정을 받은 쟁점");
    expect(codex.calls[0]).toContain("C-DEF");
    database.close();
  });

  it("개정 2회차가 결정을 물어 멈추면 결정 뒤 retry 가 그 개정본(3판)을 재사용해 종결 확인으로 간다", async () => {
    const { database, artifacts, engine, claude, codex } = makePlanningEngine({
      slug: "closeout-revision-2-paused",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: first, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: revised, findings: [auditFinding], evidenceRefs: [] },
        {
          kind: "REVISION", summary: "개정 2회차 — 확인 요청", planMarkdown: third, findings: [closeoutNew], evidenceRefs: [],
          requestedUserDecision: "C-NEW 의 범위를 확인해 주세요.",
        },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [auditFinding], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결 — 새 쟁점", planSHA256: revisedSHA, findings: [auditFinding, closeoutNew], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "종결 2회차", planSHA256: thirdSHA, findings: [auditFinding, closeoutNew], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1")).toMatchObject({ state: "USER_DECISION_REQUIRED", lastError: expect.stringContaining("C-NEW 의 범위") });
    expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_REVISION");

    await engine.postMessage("topic-1", "decision", "C-NEW 는 범위 안이다.");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    // 개정 2회차 프롬프트("Codex 종결 확인의 새 쟁점:")는 1회뿐 — 재실행 없음. 계획 본문의 "개정 2회차 계획" 문구는 세지 않는다.
    expect(claude.calls.filter((prompt) => prompt.includes("Codex 종결 확인의 새 쟁점:"))).toHaveLength(1);
    expect(codex.calls).toHaveLength(3);
    expect(await artifacts.readLatest("topic-1", "plan")).toContain("개정 2회차 계획");
    expect(database.getTopic("topic-1").planSHA256).toBe(thirdSHA);
    // 종결 2회차 통과 → ACK 응답이 없어 그 단계에서 실패하는 것이 진행의 증거
    expect(database.getFlags("topic-1").resumeState).toBe("CONSENSUS_ACK");
    database.close();
  });
});

// 2026-09-07 Codex 피드백 ④: 최종 리뷰의 새 쟁점은 처분으로 분류 — 확정 결함(AGREED_ACTION)은 남은 회차에서 바로 수정.
describe("최종 리뷰 새 쟁점의 분류", () => {
  it("승인 범위 안의 새 확정 결함은 결정 없이 2차 수정으로 바로 고치고 다음 최종 리뷰에서 기지로 본다", async () => {
    const agreed = finding("F-1", "첫 리뷰 결함", { disposition: "AGREED_ACTION" });
    const resolved = finding("F-1", "첫 리뷰 결함", { disposition: "RESOLVED_BY_FIX" });
    const newAgreed = finding("F-2", "수정으로 생긴 결함", { disposition: "AGREED_ACTION" });
    const newResolved = finding("F-2", "수정으로 생긴 결함", { disposition: "RESOLVED_BY_FIX" });
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW", implementationFindings: [resolved], originalReviewFindings: [agreed],
      codexResult: { kind: "FINAL_REVIEW", summary: "새 확정 결함", findings: [resolved, newAgreed], evidenceRefs: [] },
      codexResults: [
        { kind: "FINAL_REVIEW", summary: "새 확정 결함", findings: [resolved, newAgreed], evidenceRefs: [] },
        { kind: "FINAL_REVIEW", summary: "확인", findings: [resolved, newResolved], evidenceRefs: [] },
      ],
      claudeResults: [{ kind: "FIX", summary: "2차 수정", findings: [resolved, newResolved], evidenceRefs: [] }],
    });
    database.updateTopic("topic-1", { fixPassUsed: true });
    database.setImplementationSession("topic-1", "claude-implementation-session");

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(database.getFlags("topic-1").secondFixPassUsed).toBe(true);
    expect(database.getTimeline("topic-1").some((event) => event.state === "USER_DECISION_REQUIRED")).toBe(false);
    database.close();
  });
});

describe("코드 리뷰 전용 세션", () => {
  const agreed = finding("R-1", "취소 뒤 늦은 응답", {
    disposition: "AGREED_ACTION", rationale: "수정 후에도 반드시 확인할 실패 조건",
  });
  const resolved = { ...agreed, disposition: "RESOLVED_BY_FIX" as const };
  const review: AgentResult = { kind: "REVIEW", summary: "수정 필요", findings: [agreed], evidenceRefs: [] };
  const final: AgentResult = { kind: "FINAL_REVIEW", summary: "수정 확인", findings: [resolved], evidenceRefs: [] };
  const clear: AgentResult = { kind: "REVIEW", summary: "검토 완료", findings: [], evidenceRefs: [] };

  it("첫 리뷰에 필요한 근거만 넘기고 수정 뒤에는 그 세션을 이어 쓴다", async () => {
    const codex = new ReviewSessionAdapter([review, final]);
    const { database, engine, artifacts } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [], codexResult: review, codex,
      claudeResults: [{ kind: "FIX", summary: "늦은 응답 거부", findings: [resolved], evidenceRefs: ["취소 회귀 테스트"] }],
    });
    database.setImplementationSession("topic-1", "claude-implementation");
    database.updateAgentSettings("topic-1", "codex", { model: "gpt-6-astra", effort: "xhigh" });
    const before = database.getTopic("topic-1");
    await artifacts.write("topic-1", "closeout", 1, JSON.stringify({
      kind: "CLOSEOUT", summary: "계획 합의", planSHA256: before.planSHA256,
      findings: [finding("P-1", "계획에서 합의한 취소 계약", { disposition: "AGREED_ACTION" })],
      evidenceRefs: ["계획 판정의 원본 근거"],
    }));
    database.appendEvent({ topicId: "topic-1", actor: "user", kind: "note", state: "DRAFT", body: "오래된 필수 사용자 제약" });
    for (let i = 0; i < 100; i++) {
      database.appendEvent({ topicId: "topic-1", actor: "codex", kind: "agent_output", state: "CODEX_AUDIT", body: `폐기된 탐색 보고 ${i}` });
    }
    database.appendEvent({ topicId: "topic-1", actor: "user", kind: "decision", state: "FAILED", body: "현재 범위의 확정 결정" });
    database.appendEvent({ topicId: "topic-1", actor: "user", kind: "evidence", state: "FAILED", body: "실패 로그의 원본 경로" });

    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");

    expect(database.getTopic("topic-1")).toMatchObject({ state: "READY_TO_DELIVER", lastError: null });
    expect(codex.calls.map(({ created, sessionId }) => ({ created, sessionId }))).toEqual([
      { created: true, sessionId: "review-only-1" }, { created: false, sessionId: "review-only-1" },
    ]);
    const initial = codex.calls[0].turn;
    for (const required of [validPlan("검토 finding 보존"), "계획에서 합의한 취소 계약", "계획 판정의 원본 근거",
      "오래된 필수 사용자 제약", "현재 범위의 확정 결정", "실패 로그의 원본 경로", "검토할 구현 결과"]) {
      expect(initial.prompt).toContain(required);
    }
    expect(initial.prompt).not.toContain("폐기된 탐색 보고");
    expect(codex.calls[1].turn.prompt).not.toContain(validPlan("검토 finding 보존"));
    expect(codex.calls[1].turn.prompt).toContain("취소 회귀 테스트");
    expect(codex.calls.every(({ turn }) => turn.implementation === false)).toBe(true);
    expect(codex.calls.map(({ turn }) => turn.settings)).toEqual([
      { model: "gpt-6-astra", effort: "xhigh" }, { model: "gpt-6-astra", effort: "xhigh" },
    ]);
    expect(database.getTopic("topic-1").participants).toEqual(before.participants);
    database.close();
  });

  it("결과 교정 실패 뒤 서버를 다시 열어도 저장한 리뷰 세션으로 재시도한다", async () => {
    const invalid: AgentResult = { ...clear, kind: "AUDIT" };
    const codex = new ReviewSessionAdapter([invalid, invalid, clear]);
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [], codexResult: invalid, codex,
    });
    const root = temporaryDirectories.at(-1)!;
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(database.getCodexReviewSession("topic-1")).toBe("review-only-1");
    expect(codex.calls[1].turn.settings?.effort).toBe("low");
    database.close();

    const reopened = new ConsensusDatabase(join(root, "room.sqlite"));
    const resumedEngine = new WorkflowEngine({
      database: reopened, artifacts: new ArtifactStore(join(root, "topics"), reopened),
      git: new GitService(new RecordingGitRunner()), codex, claude: new QueuedAdapter("claude", []),
    });
    resumedEngine.retry("topic-1");
    await waitForActionCompletion(reopened, "topic-1");
    expect(reopened.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(codex.calls.map(({ created, sessionId }) => ({ created, sessionId }))).toEqual([
      { created: true, sessionId: "review-only-1" },
      { created: false, sessionId: "review-only-1" },
      { created: false, sessionId: "review-only-1" },
    ]);
    reopened.close();
  });

  it("기존 주제가 최종 리뷰에서 처음 분리될 때는 첫 리뷰의 근거도 전문으로 넘긴다", async () => {
    const codex = new ReviewSessionAdapter([final]);
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_FINAL_REVIEW", implementationFindings: [resolved], originalReviewFindings: [agreed],
      codexResult: final, codex,
    });
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(codex.calls[0].created).toBe(true);
    expect(codex.calls[0].turn.prompt).toContain(validPlan("검토 finding 보존"));
    expect(codex.calls[0].turn.prompt).toContain("수정 후에도 반드시 확인할 실패 조건");
    database.close();
  });

  it("첫 리뷰 도중 도착한 사용자 결정은 저장한 리뷰 세션의 다음 턴에 전달한다", async () => {
    const codex = new ReviewSessionAdapter([clear, clear]);
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [], codexResult: clear, codex,
    });
    const create = codex.createSession.bind(codex);
    codex.createSession = async (turn) => {
      database.appendEvent({ topicId: "topic-1", actor: "user", kind: "decision", state: "CODEX_REVIEW", body: "실행 중 추가한 필수 조건" });
      return create(turn);
    };
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
    expect(database.getCodexReviewSession("topic-1")).toBe("review-only-1");
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
    expect(codex.calls.map(({ created }) => created)).toEqual([true, false]);
    expect(codex.calls[1].turn.prompt).toContain("실행 중 추가한 필수 조건");
    database.close();
  });

  it("새 세션 생성 중 중복 재시도를 거부하고 취소 뒤 늦은 응답은 저장하지 않는다", async () => {
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const codex: AgentAdapter = {
      role: "codex", validateExistingSession: async () => true,
      createSession: async () => {
        start();
        await released; // 의도적으로 취소를 무시하는 외부 프로세스의 늦은 응답
        return { sessionId: "late-review-session", result: clear };
      },
      resumeTurn: async () => { throw new Error("계획 세션을 이어 쓰면 안 됩니다."); },
    };
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [], codexResult: clear, codex,
    });
    engine.retry("topic-1");
    await started;
    try {
      expect(() => engine.retry("topic-1")).toThrow();
      engine.stop("topic-1");
    } finally {
      release();
    }
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(database.getCodexReviewSession("topic-1")).toBeNull();
    expect(database.latestArtifact("topic-1", "codex-review")).toBeNull();
    database.close();
  });
});

describe("계획 전송 기록", () => {
  it.each([true, false])("공개 계획 흐름에서 같은 계획은 크기에 따라 축소한다 (긴 계획: %s)", async (longPlan) => {
    const plan = normalizePlan(validPlan(longPlan ? "PLAN-CONTENT\n".repeat(1000) : "짧은 계획"));
    const sha = hashPlan(plan);
    const { database, artifacts, engine, codex, claude } = makePlanningEngine({
      slug: "planning-cursor",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: plan, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "변경 없음", planMarkdown: plan, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: sha, findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "검토", findings: [], evidenceRefs: [] },
        { kind: "CLOSEOUT", summary: "확정", planSHA256: sha, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: sha, findings: [], evidenceRefs: [] },
      ],
    });
    await engine.postMessage("topic-1", "evidence", "OLD-EVIDENCE-MARKER");
    const done = waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    engine.startPlan("topic-1");
    await done;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(codex.calls[0]).toContain(plan.trim());
    expect(codex.calls[0]).toContain("OLD-EVIDENCE-MARKER");
    if (longPlan) {
      expect(codex.calls[1]).toContain("(계획 변경 없음)");
      expect(codex.calls[1]).not.toContain("PLAN-CONTENT");
      expect(codex.calls[1]).not.toContain("OLD-EVIDENCE-MARKER");
    } else {
      expect(codex.calls[1]).toContain(plan.trim());
      expect(codex.calls[1]).toContain("OLD-EVIDENCE-MARKER");
    }
    const cursor = JSON.parse((await artifacts.readLatest("topic-1", "codex-planning-cursor"))!);
    expect(cursor).toMatchObject({ sessionId: "codex-session", scopeGeneration: 1, planSHA256: sha });
    const metrics = database.getTimeline("topic-1").filter((event) => event.payload.promptMetrics);
    expect(metrics).toHaveLength(2);
    expect(database.getPromptTimeline("topic-1", 1).every((event) => !event.payload.promptMetrics)).toBe(true);
    expect(claude.turns[1]).not.toHaveProperty("sessionId");
    database.close();
  });
});

describe("계획 전송 기록 저장 중 새 결정", () => {
  it.each(["before-commit", "after-commit"])("%s에 도착한 결정을 처리하기 전에는 ACK로 넘어가지 않는다", async (timing) => {
    const plan = normalizePlan(validPlan("상세 계획\n".repeat(500)));
    const sha = hashPlan(plan);
    const closeout: AgentResult = { kind: "CLOSEOUT", summary: "종결", planSHA256: sha, findings: [], evidenceRefs: [] };
    const { database, artifacts, engine, codex, claude } = makePlanningEngine({ slug: "cursor-input-race",
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: plan, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: plan, findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "새 결정 반영", planMarkdown: plan, findings: [], evidenceRefs: [] },
        { kind: "ACK", summary: "확인", planSHA256: sha, findings: [], evidenceRefs: [] },
      ],
      codexResults: [{ kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] }, closeout, closeout,
        { kind: "ACK", summary: "확인", planSHA256: sha, findings: [], evidenceRefs: [] }],
    });
    const write = artifacts.write.bind(artifacts);
    let injected = false;
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (args[1] !== "codex-planning-cursor" || database.getTopic("topic-1").state !== "CODEX_CLOSEOUT" || injected) return write(...args);
      injected = true;
      if (timing === "before-commit") await engine.postMessage("topic-1", "decision", "NEW-CURSOR-DECISION");
      const result = await write(...args);
      if (timing === "after-commit") await engine.postMessage("topic-1", "decision", "NEW-CURSOR-DECISION");
      return result;
    };
    const stopped = waitForTopicState(database, "topic-1", "USER_DECISION_REQUIRED");
    engine.startPlan("topic-1");
    await stopped;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(codex.calls).toHaveLength(2);
    expect(claude.calls).toHaveLength(2);
    expect(database.artifactsForScope("topic-1", "codex-planning-cursor")).toHaveLength(timing === "before-commit" ? 1 : 2);
    expect(database.getFlags("topic-1").resumeState).toBe("CODEX_CLOSEOUT");
    const done = waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    engine.retry("topic-1");
    await done;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(claude.calls[2]).toContain("NEW-CURSOR-DECISION");
    expect(codex.calls[2]).toContain("NEW-CURSOR-DECISION");
    expect(codex.calls).toHaveLength(4);
    database.close();
  });
});
