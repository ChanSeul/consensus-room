import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, CommandRunner, ProjectMemoryWriter } from "../src/server/types";
import { EngineCore, FormatViolation, isFormatOnlyViolation } from "../src/server/engine/core";
import { ContinuationCoordinator } from "../src/server/engine/continuation";
import { buildEnvelopeCorrectionPrompt } from "../src/shared/prompts";
import { WorkflowEngine } from "../src/server/workflow";
import { REQUIRED_PLAN_HEADINGS, type AgentResult } from "../src/shared/contracts";
import { hashPlan } from "../src/shared/workflow";
import { planBundleVersion, serializePlanBundle } from "../src/server/planBundle";
import { UnverifiedAgentResult } from "../src/server/adapters/resultParser";
import { PlanningPaused } from "../src/shared/planningControl";
import type { SessionTurn } from "../src/server/types";
import { envelopeIssues, type TurnEnvelope } from "../src/shared/turnContract";

const temporaryDirectories: string[] = [];

// 운영 라우팅은 결과 봉투 턴이다(⑥) — 옛 결과 모양의 가짜 응답을 그 역할의 봉투로 옮긴다. 플래너 결과의 계획 본문은 계획 폴더의 plan.md 로 쓴다(플래너가
// 파일로 계획을 쓰는 것과 같다). 봉투 relay 에 없는 턴(종결·ACK·최종 리뷰)의 결과가 오면 던진다.
function envelopeOf(result: AgentResult, turn: { planDirectory?: string }): TurnEnvelope {
  const carried = { ...(result.memoryUpdates ? { memoryUpdates: result.memoryUpdates } : {}), ...(result.engineDefects ? { engineDefects: result.engineDefects } : {}) };
  const mediatorRequest = result.requestedUserDecision ?? result.requestedMediatorAction;
  if (mediatorRequest) return { message: result.summary, outcome: "needs-mediator", mediatorRequest, ...carried };
  switch (result.kind) {
    case "PLAN": case "REVISION":
      if (result.planMarkdown && turn.planDirectory) writeFileSync(join(turn.planDirectory, "plan.md"), `${result.planMarkdown.trim()}\n`);
      return { message: result.summary, outcome: "ready", ...carried };
    case "AUDIT": return { message: result.summary, outcome: result.findings.length ? "changes" : "agree", ...carried };
    case "REVIEW": return { message: result.summary, outcome: result.findings.length ? "changes" : "approve", ...carried };
    case "IMPLEMENTATION": case "FIX":
      return { message: result.summary, outcome: result.status === "in_progress" ? "continue" : "done", ...carried };
    default: throw new Error(`봉투 relay 에 없는 결과 종류입니다: ${result.kind}`);
  }
}

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
  attachParticipants = true,
) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-engine-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  database.createTopic({
    workflowMode: "planned",
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
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
  for (const role of attachParticipants ? ["claude", "codex"] as const : []) {
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
    createEnvelopeSession: async () => { throw new Error("이 테스트에서는 CLI를 호출하지 않습니다."); },
    resumeEnvelopeTurn: async () => { throw new Error("이 테스트에서는 CLI를 호출하지 않습니다."); },
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
  return { root, database, engine, dependencies: { database, artifacts: new ArtifactStore(join(root, "topics"), database), git: new GitService(unavailableRunner), claude: unavailableAdapter("claude"), codex: unavailableAdapter("codex") } };
}

it("rejects incomplete planning admission without stranding the topic, then accepts repaired participants", async () => {
  const { database, engine } = makeEngine("DRAFT", null, false, null, false);
  expect(() => engine.startPlan("topic-1", "missing-participants")).toThrow("세션");
  expect(database.getTopic("topic-1").state).toBe("DRAFT");
  expect(database.getAction("missing-participants")).toBeNull();
  for (const role of ["claude", "codex"] as const) database.upsertParticipant("topic-1", {
    role, sessionId: role, mode: "attached", acknowledgedPlanSHA256: null,
  });
  expect(engine.startPlan("topic-1", "repaired-participants")).toBe("repaired-participants");
  await engine.shutdown();
  expect(database.getAction("repaired-participants")).not.toBeNull();
  database.close();
});

it("contains failure-persistence and settlement observer faults while preserving the unfinished action for recovery", async () => {
  const { database, dependencies } = makeEngine("DRAFT", null);
  const core = new EngineCore(dependencies);
  const finish = database.finishActionAndFailTopic.bind(database);
  database.finishActionAndFailTopic = () => { throw new Error("failure storage unavailable"); };
  core.settledObserver = () => { throw new Error("observer unavailable"); };
  const actionId = core.startAction("topic-1", "test", async () => { throw new Error("work failed"); });
  await core.active.get("topic-1")!.completion;
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(core.active.has("topic-1")).toBe(false);
  expect(database.getAction(actionId)?.status).toBe("running");
  database.finishActionAndFailTopic = finish;
  database.recoverInterruptedActions();
  expect(database.getAction(actionId)?.status).toBe("cancelled");
  expect(database.getFlags("topic-1").resumeState).toBe("DRAFT");
  database.close();
});

it.each([false, true])("planning pause keeps action and resume recoverable when event storage fails (%s)", async fail => {
  const { root, database, dependencies } = makeEngine("DRAFT", null);
  database.updateTopic("topic-1", { state: "CLAUDE_PLAN" });
  const core = new EngineCore(dependencies);
  const fault = new DatabaseSync(join(root, "room.sqlite"));
  if (fail) fault.exec("CREATE TRIGGER reject_pause BEFORE INSERT ON timeline_events BEGIN SELECT RAISE(ABORT, 'pause unavailable'); END");
  const id = core.startAction("topic-1", "test", async () => { throw new PlanningPaused("external input needed"); });
  await core.active.get("topic-1")!.completion;
  expect(database.getAction(id)?.status).toBe(fail ? "running" : "cancelled");
  expect(database.getTopic("topic-1").state).toBe(fail ? "CLAUDE_PLAN" : "USER_DECISION_REQUIRED");
  if (fail) {
    fault.exec("DROP TRIGGER reject_pause");
    database.recoverInterruptedActions();
  } else expect(database.getTimeline("topic-1").at(-1)?.payload).toMatchObject({ planningPause: true, resumeState: "CLAUDE_PLAN" });
  expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_PLAN");
  fault.close(); database.close();
});

it("recovers a legacy failed draft admission through retry without changing scope or starting a model", async () => {
  const { database, engine } = makeEngine("DRAFT", null, false, null, false);
  database.updateTopic("topic-1", { state: "FAILED", resumeState: "DRAFT", lastError: "missing participant" });
  const before = database.getTopic("topic-1");
  const id = engine.retry("topic-1");
  await waitForActionCompletion(database, "topic-1");
  expect(database.getTopic("topic-1")).toMatchObject({ state: "DRAFT", scopeGeneration: before.scopeGeneration,
    planEpoch: before.planEpoch, planSHA256: null, participants: [] });
  expect(database.getAction(id)?.status).toBe("succeeded");
  expect(() => engine.startPlan("topic-1")).toThrow("세션");
  database.close();
});

it("action cancellation reaches a pending Git operation before any model call", async () => {
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let release!: () => void;
  const runner: CommandRunner = { run: spec => new Promise((resolve, reject) => {
    release = () => resolve({ exitCode: 0, stdout: "head", stderr: "", jsonLines: [] });
    spec.signal?.addEventListener("abort", () => reject(new Error("git cancelled")), { once: true });
    entered();
  }) };
  const { database, dependencies } = makeEngine("DRAFT", null, false, runner);
  const core = new EngineCore(dependencies);
  const id = core.startAction("topic-1", "test", async () => { await dependencies.git.head("/tmp/repository"); });
  const completion = core.active.get("topic-1")!.completion;
  await started;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    core.active.get("topic-1")!.controller.abort(new Error("user stop"));
    await Promise.race([completion, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Git did not cancel")), 200); })]);
    expect(database.getAction(id)?.status).toBe("cancelled");
  } finally { clearTimeout(timer); release(); await completion; database.close(); }
});

it("contains continuation storage faults and does not repeat an unrecorded failed attempt", async () => {
  const hash = "a".repeat(64), { database, engine } = makeEngine("AWAITING_USER_APPROVAL", hash, true);
  const coordinator = new ContinuationCoordinator(database, engine, {} as never);
  coordinator.arm("topic-1", { planSHA256: hash, reason: "existing approved scope" });
  const save = database.continuations.save.bind(database.continuations);
  let attempts = 0;
  engine.assertContinuationIdle = () => { attempts++; throw new Error("cannot start"); };
  database.continuations.save = () => { throw new Error("storage unavailable"); };
  await new Promise<void>(resolve => setImmediate(resolve));
  await new Promise<void>(resolve => setImmediate(resolve));
  coordinator.wake();
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(attempts).toBe(1);
  expect(database.continuations.get("topic-1")?.status).toBe("pending");
  database.continuations.save = save;
  await coordinator.stop();
  database.close();
});

it.each(["IMPLEMENTING", "CODEX_REVIEW", "CLAUDE_FIX"] as const)(
  "atomically admits %s recovery across state and action writes", resume => {
    for (const fault of ["after-state", "after-action"]) {
      const hash = "a".repeat(64), { root, database, engine } = makeEngine("AWAITING_USER_APPROVAL", hash, true);
      database.updateTopic("topic-1", { state: "FAILED", resumeState: resume });
      const observer = new DatabaseSync(join(root, "room.sqlite"), { readOnly: true });
      const update = database.updateTopic.bind(database), start = database.startAction.bind(database);
      const timeline = database.timelineCount("topic-1");
      const checkDurableBoundary = () => {
        // A separate connection sees only the old complete state until admission commits.
        expect(observer.prepare("SELECT state,resume_state FROM topics WHERE id='topic-1'").get())
          .toMatchObject({ state: "FAILED", resume_state: resume });
        expect(observer.prepare("SELECT id FROM actions WHERE id='recovery'").get()).toBeUndefined();
      };
      database.updateTopic = (id, changes) => {
        const result = update(id, changes);
        if (id === "topic-1" && changes.state === resume) {
          checkDurableBoundary();
          if (fault === "after-state") throw new Error("Injected interrupted admission");
        }
        return result;
      };
      database.startAction = record => {
        start(record);
        checkDurableBoundary();
        if (fault === "after-action") throw new Error("Injected interrupted admission");
      };
      expect(() => engine.resumeApprovedDelivery("topic-1", hash, "recovery")).toThrow("Injected interrupted admission");
      database.updateTopic = update; database.startAction = start;
      expect(database.getTopic("topic-1").state).toBe("FAILED");
      expect(database.getFlags("topic-1").resumeState).toBe(resume);
      expect(database.getAction("recovery")).toBeNull();
      expect(database.timelineCount("topic-1")).toBe(timeline);
      database.recoverInterruptedActions();
      expect(database.getFlags("topic-1").resumeState).toBe(resume);
      observer.close(); database.close();
    }
  });

it("continuation recovery revalidates approved delivery intent at admission and execution", () => {
  const hash = "a".repeat(64);
  const { database, engine } = makeEngine("AWAITING_USER_APPROVAL", hash, true);
  database.updateTopic("topic-1", { state: "FAILED", resumeState: "IMPLEMENTING" });
  expect(engine.continuationAdmission("topic-1", hash)).toBe("recover-delivery");
  // Approval can change after the scheduler saves its intent. The execution port must recheck it.
  database.updateTopic("topic-1", { approvedPlanSHA256: null });
  expect(() => engine.resumeApprovedDelivery("topic-1", hash, "must-not-start")).toThrow("같은 승인 계획");
  expect(database.runningAction("topic-1")).toBeNull();
  database.updateTopic("topic-1", { approvedPlanSHA256: hash, resumeState: "CLAUDE_PLAN" });
  expect(() => engine.continuationAdmission("topic-1", hash)).toThrow("같은 승인 계획");
  expect(() => engine.resumeApprovedDelivery("topic-1", hash, "must-not-replan")).toThrow("같은 승인 계획");
  expect(database.getTopic("topic-1").state).toBe("FAILED");
  database.close();
});

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
      workflowMode: "planned",
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
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
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
    const blockingTurn = ({ signal }: SessionTurn) => {
      started();
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          observedAbort();
          void processMayClose.then(() => reject(signal.reason));
        }, { once: true });
      });
    };
    const blockingClaude: AgentAdapter = {
      role: "claude",
      createSession: async () => { throw new Error("사용하지 않습니다."); },
      resumeTurn: blockingTurn,
      createEnvelopeSession: async () => { throw new Error("사용하지 않습니다."); },
      resumeEnvelopeTurn: blockingTurn,
      validateExistingSession: async () => true,
    };
    const unusedCodex: AgentAdapter = {
      role: "codex",
      createSession: async () => { throw new Error("사용하지 않습니다."); },
      resumeTurn: async () => { throw new Error("사용하지 않습니다."); },
      createEnvelopeSession: async () => { throw new Error("사용하지 않습니다."); },
      resumeEnvelopeTurn: async () => { throw new Error("사용하지 않습니다."); },
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
    const { database, engine, claude } = makePlanningEngine({
      slug: "generation-isolation",
      git: new SpawnCommandRunner(),
      claudeResults: [
        { kind: "PLAN", summary: "첫 세대 계획", planMarkdown: validPlan("첫 세대 계획"), findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "첫 세대 개정", planMarkdown: validPlan("첫 세대 개정 계획"), findings: [], evidenceRefs: [] },
        { kind: "PLAN", summary: "두 번째 세대 계획", planMarkdown: validPlan("두 번째 세대 계획"), findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        {
          kind: "AUDIT",
          summary: "첫 세대 감사",
          findings: [finding("F-GEN1", "첫 세대에서만 나온 쟁점", { severity: "HIGH", disposition: undefined })],
          evidenceRefs: [],
        },
        { kind: "AUDIT", summary: "첫 세대 합의", findings: [], evidenceRefs: [] },
        { kind: "AUDIT", summary: "두 번째 세대 합의", findings: [], evidenceRefs: [] },
      ],
    });

    const firstApproval = waitForTopicState(database, "topic-1", "AWAITING_USER_APPROVAL");
    engine.startPlan("topic-1");
    await firstApproval;
    await waitForActionCompletion(database, "topic-1");
    const firstSHA = database.getTopic("topic-1").planSHA256!;
    engine.approve("topic-1", firstSHA);
    await engine.handleScopeChange("topic-1", "두 번째 세대 범위로 다시 계획합니다.");

    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");

    // claude 턴 순서: [0] 첫 세대 계획, [1] 첫 세대 개정, [2] 두 번째 세대 계획(새 세션 첫 턴)
    expect(claude.calls).toHaveLength(3);
    const secondGenerationPlanPrompt = claude.calls[2];
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
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
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
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [], evidenceRefs: [] },
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
});

type QueuedResult = AgentResult | ((turn: { prompt: string; protocolOnly?: boolean }) => AgentResult);

class QueuedAdapter implements AgentAdapter {
  readonly calls: string[] = [];
  readonly turns: Array<Parameters<AgentAdapter["resumeTurn"]>[0] | Parameters<AgentAdapter["createSession"]>[0]> = [];

  constructor(
    readonly role: "claude" | "codex",
    private readonly results: QueuedResult[],
  ) {}

  // 리뷰 답변 확인 호출(프로토콜 확인) — 큐를 소비하지 않고 여기 따로 기록한다. 인도 대기·재개의 모든 새 결정은 확인자의 결정별 판정을 거친다(host-review 2026-09-21 R1·R7):
  // 정상 fixture 는 열린 질문을 마지막 결정으로 답하고 결정 전부를 "구현 변경 요구 아님(false)" 으로 판정한다. `calls` 는 리뷰·수정 등 실제 턴만 센다.
  readonly confirmations: string[] = [];

  async createSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    const confirmation = this.confirm(turn.prompt);
    if (confirmation) return { sessionId: `${this.role}-created-session`, result: confirmation };
    this.calls.push(turn.prompt);
    this.turns.push(turn);
    return { sessionId: `${this.role}-created-session`, result: this.next(turn) };
  }

  async resumeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    const confirmation = this.confirm(turn.prompt);
    if (confirmation) return confirmation;
    this.calls.push(turn.prompt);
    this.turns.push(turn);
    return this.next(turn);
  }

  async createEnvelopeSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    this.calls.push(turn.prompt);
    this.turns.push(turn);
    return { sessionId: `${this.role}-created-session`, envelope: envelopeOf(this.next(turn), turn) };
  }

  async resumeEnvelopeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    this.calls.push(turn.prompt);
    this.turns.push(turn);
    return envelopeOf(this.next(turn), turn);
  }

  async validateExistingSession() {
    return true;
  }

  private confirm(prompt: string): AgentResult | null {
    if (this.role !== "codex" || !prompt.includes("REVIEW_ANSWER_INPUT\n")) return null;
    this.confirmations.push(prompt);
    const input = JSON.parse(prompt.split("REVIEW_ANSWER_INPUT\n")[1].split("\nEND_REVIEW_ANSWER_INPUT")[0]) as {
      requests: Array<{ id: string }>; decisions: Array<{ sequence: number }>; answerEvidence?: Array<{ sequence: number }>;
    };
    const last = [...(input.answerEvidence ?? []), ...input.decisions].sort((a, b) => a.sequence - b.sequence).at(-1);
    return {
      kind: "REVIEW", summary: "질문 답변 확인", status: "completed", findings: [], evidenceRefs: [],
      reviewDecisionAnswers: last ? input.requests.map((request) => ({ requestId: request.id, decisionSequence: last.sequence })) : [],
      decisionAssessments: input.decisions.map((decision) => ({ decisionSequence: decision.sequence, changesImplementation: false })),
    };
  }

  private next(turn: { prompt: string; protocolOnly?: boolean }): AgentResult {
    const result = this.results.shift();
    if (!result) throw new Error(`${this.role} 가짜 응답이 부족합니다.`);
    return typeof result === "function" ? result(turn) : result;
  }
}

class ReviewSessionAdapter implements AgentAdapter {
  readonly role = "codex" as const;
  readonly calls: Array<{ sessionId: string; created: boolean; turn: Parameters<AgentAdapter["createSession"]>[0] }> = [];
  private createdCount = 0;
  constructor(private readonly results: Array<AgentResult | (() => AgentResult)>) {}
  async createSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    const sessionId = `review-only-${++this.createdCount}`;
    this.calls.push({ sessionId, created: true, turn });
    return { sessionId, result: this.next() };
  }
  async resumeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    this.calls.push({ sessionId: turn.sessionId, created: false, turn });
    return this.next();
  }
  async createEnvelopeSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    const sessionId = `review-only-${++this.createdCount}`;
    turn.onSessionCreated?.(sessionId);
    this.calls.push({ sessionId, created: true, turn });
    return { sessionId, envelope: envelopeOf(this.next(), turn) };
  }
  async resumeEnvelopeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    this.calls.push({ sessionId: turn.sessionId, created: false, turn });
    return envelopeOf(this.next(), turn);
  }
  async validateExistingSession() { return true; }
  private next(): AgentResult {
    const result = this.results.shift();
    if (!result) throw new Error("예상하지 않은 추가 리뷰 호출입니다.");
    return typeof result === "function" ? result() : result;
  }
}

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
});

const TOLERANCE_BLOCK = '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';

function validPlan(label: string): string {
  return REQUIRED_PLAN_HEADINGS
    .map((heading) => `## ${heading}\n\n${label}: ${heading}${heading === "허용 오차" ? TOLERANCE_BLOCK : ""}`)
    .join("\n\n");
}

function makePlanningEngine(input: {
  slug: string;
  claudeResults: QueuedResult[];
  codexResults: QueuedResult[];
  memory?: ProjectMemoryWriter;
  // 개정이 계획 판을 바꾸면 판 사이 변경분을 git diff --no-index 로 계산한다 — 그 흐름을 지나는 검사만 실제 git 을 준다.
  git?: CommandRunner;
}) {
  const root = mkdtempSync(join(tmpdir(), `consensus-room-${input.slug}-`));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  database.createTopic({
    workflowMode: "planned",
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
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
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
    git: new GitService(input.git ?? { run: async () => { throw new Error("사용하지 않습니다."); } }),
    claude,
    codex,
    memory: input.memory,
  });
  return { database, artifacts, engine, claude, codex };
}

async function makeReviewRecovery(input: {
  resumeState: "CLAUDE_FIX" | "CODEX_REVIEW";
  implementationFindings: AgentResult["findings"];
  originalReviewFindings: AgentResult["findings"];
  codexResult: AgentResult;
  claudeResults?: QueuedResult[];
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
    workflowMode: "planned",
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
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
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
  // 계획 산출물은 계획 sha 와 같은 바이트다(F010 — 운영 저장은 정규화한 본문이거나 저장 바이트의 sha 다).
  await artifacts.write("topic-1", "plan", 2, `${plan.trim()}\n`);
  const implementation = {
    kind: "IMPLEMENTATION",
    summary: "검토할 구현 결과",
    findings: input.implementationFindings,
    evidenceRefs: [],
  };
  await artifacts.write("topic-1", "implementation-result", 1, JSON.stringify(implementation));
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
    codex: input.codex ?? new QueuedAdapter("codex", [input.codexResult, input.codexResult]),
  });
  return { database, engine, artifacts };
}

// 계획 왕복 턴(플래너의 계획·개정)의 모델 설정 — 계획 모델을 받고 구현 오버라이드는 계획 턴에 노출되지 않는다.
describe("계획 왕복 턴의 모델 설정", () => {
  async function run() {
    const { database, engine, claude } = makePlanningEngine({
      slug: "planning-settings",
      git: new SpawnCommandRunner(),
      claudeResults: [
        { kind: "PLAN", summary: "계획", planMarkdown: validPlan("첫 계획"), findings: [], evidenceRefs: [] },
        { kind: "REVISION", summary: "개정", planMarkdown: validPlan("개정 계획"), findings: [], evidenceRefs: [] },
      ],
      codexResults: [
        { kind: "AUDIT", summary: "감사", findings: [finding("F-1", "감사가 올린 쟁점", { severity: "HIGH", disposition: undefined })], evidenceRefs: [] },
        { kind: "AUDIT", summary: "합의", findings: [], evidenceRefs: [] },
      ],
    });
    engine.startPlan("topic-1");
    await waitForActionCompletion(database, "topic-1");
    // claude 턴 순서: [0] 계획(plan), [1] 개정(revision)
    return { database, planTurn: claude.turns[0]!, revisionTurn: claude.turns[1]! };
  }

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

  it("계획 수렴 턴은 계획 모델(Fable 5.1)을 받고 구현 오버라이드는 노출되지 않는다", async () => {
    const { database, planTurn, revisionTurn } = await run();
    expect(database.getTopic("topic-1").state).toBe("AWAITING_USER_APPROVAL");
    for (const turn of [planTurn, revisionTurn]) {
      expect(turn.settings).toEqual({ model: "claude-fable-5-1", effort: "xhigh" });
    }
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
      workflowMode: "planned",
      id: "topic-1", slug: "pin", title: "기준 고정",
      repositoryPath: "/tmp/repository", baseRef: "develop", worktreePath: "/tmp/worktree",
      branchName: "consensus/scope-ab12",
      state: "FAILED", scopeGeneration: 1, planRevision: 2, planSHA256,
      approvedPlanSHA256: planSHA256,
      createdAt: "2026-08-30T00:00:00.000Z", updatedAt: "2026-08-30T00:00:00.000Z", lastError: "재시도 준비",
    });
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
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
    await artifacts.write("topic-1", "plan", 2, `${plan.trim()}\n`);
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
  resumeState: "CODEX_AUDIT" | "CLAUDE_REVISION",
  queues: {
    claudeResults?: QueuedResult[];
    codexResults?: QueuedResult[];
    state?: "FAILED" | "USER_DECISION_REQUIRED";
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-planning-resume-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  const plan = validPlan("계획 단계 재개");
  const planSHA256 = hashPlan(plan);
  database.createTopic({
    workflowMode: "planned",
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
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
  database.updateTopic("topic-1", { resumeState });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant("topic-1", {
      role, sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: null,
    });
  }
  const artifacts = new ArtifactStore(join(root, "topics"), database);
  await artifacts.write("topic-1", "plan", 1, `${plan.trim()}\n`);
  for (const [kind, resultKind] of [
    ["claude-plan", "PLAN"], ["audit", "AUDIT"], ["claude-revision", "REVISION"], ["closeout", "CLOSEOUT"],
  ] as const) {
    await artifacts.write("topic-1", kind, 1, JSON.stringify({
      kind: resultKind, summary: `저장된 ${kind}`, findings: [], evidenceRefs: [],
      planMarkdown: plan, planSHA256,
    }));
  }
  const claude=new QueuedAdapter("claude",queues.claudeResults??[]);
  const codex=new QueuedAdapter("codex",queues.codexResults??[]);
  const engine = new WorkflowEngine({
    database,
    artifacts,
    git: new GitService(new RecordingGitRunner()),
    // 기본 큐는 비워 둔다. 재개가 계획 턴을 다시 돌리려 하면 그 시도 자체가 타임라인에 남는다.
    claude,
    codex,
  });
  return { database, engine, artifacts, planSHA256,claude,codex };
}

// 2026-08-29 회귀: 재개 조건이 CODEX_AUDIT만 봐서 CLAUDE_REVISION에서 죽으면 resetToDraft로 떨어졌고,
// 이미 나온 계획을 버리고 계획 턴을 통째로 다시 돌렸다.
describe("계획 단계 재시도는 저장된 계획을 다시 만들지 않는다", () => {
  for (const resumeState of ["CODEX_AUDIT", "CLAUDE_REVISION"] as const) {
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

  async createEnvelopeSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    this.calls.push(turn.prompt); this.markStarted();
    await this.wait(turn.signal);
    return { sessionId: `${this.role}-created-session`, envelope: envelopeOf(this.next(), turn) };
  }

  async resumeEnvelopeTurn(turn: Parameters<AgentAdapter["resumeTurn"]>[0]) {
    this.calls.push(turn.prompt); this.markStarted();
    await this.wait(turn.signal);
    return envelopeOf(this.next(), turn);
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
    workflowMode: "planned",
    id: "topic-1", slug: "gated", title: "게이트 계획", repositoryPath: "/tmp/repository", baseRef: "develop",
    worktreePath: "/tmp/worktree", branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0,
    planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z", lastError: null,
  });
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
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

  // 턴 도중의 decision 이 턴을 멈추던 단언은 지웠다 — 새 입력은 턴을 멈추지 않고 그 세션 다음 턴의 새 사실로 실린다(계약 v3 (1)·v3.15 (26)).
  it("#3 턴 도중의 note 는 턴을 멈추지 않는다", async () => {
    const plan: AgentResult = { kind: "PLAN", summary: "게이트 뒤의 계획", planMarkdown: validPlan("게이트 계획"), findings: [], evidenceRefs: [] };
    // note: 계획 턴이 완주해 다음 단계(codex 감사)까지 간다 — codex 응답이 없어 그 단계에서 실패하는 것이 완주의 증거.
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
      workflowMode: "planned",
      id: "topic-1", slug: "archive", title: "정리", repositoryPath: "/tmp/repository", baseRef: "develop",
      worktreePath: worktree, branchName: "consensus/archive", state: "CLOSED", scopeGeneration: 1, planRevision: 1,
      planSHA256: null, approvedPlanSHA256: null, createdAt: "2026-08-23T00:00:00.000Z",
      updatedAt: "2026-08-23T00:00:00.000Z", lastError: null,
    });
  for (const scope of ["planning", "implementation"] as const) database.reviews.configure("topic-1", scope, 3, database.reviews.account("topic-1", scope).version);
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

describe("코드 리뷰 전용 세션", () => {
  const agreed = finding("R-1", "취소 뒤 늦은 응답", {
    disposition: "AGREED_ACTION", rationale: "수정 후에도 반드시 확인할 실패 조건",
  });
  const resolved = { ...agreed, disposition: "RESOLVED_BY_FIX" as const };
  const review: AgentResult = { kind: "REVIEW", summary: "수정 필요", findings: [agreed], evidenceRefs: [] };
  const clear: AgentResult = { kind: "REVIEW", summary: "검토 완료", findings: [], evidenceRefs: [] };

  it("첫 리뷰에 필요한 근거만 넘기고 수정 뒤에는 그 세션을 이어 쓴다", async () => {
    const codex = new ReviewSessionAdapter([review, clear]);
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [], codexResult: review, codex,
      claudeResults: [{ kind: "FIX", status: "completed", summary: "늦은 응답 거부", findings: [resolved], evidenceRefs: ["취소 회귀 테스트"] }],
    });
    database.setImplementationSession("topic-1", "claude-implementation");
    database.updateAgentSettings("topic-1", "codex", { model: "gpt-6-astra", effort: "xhigh" });
    const before = database.getTopic("topic-1");
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
    // 첫 리뷰는 새 리뷰 세션 첫 턴이라 이 범위 세대의 사용자 사실을 모두 받고, 에이전트 출력(탐색 보고)은 사실이 아니라 싣지 않는다. 수정 뒤 같은 세션의
    // 다음 턴은 계획을 다시 싣지 않고 구현자의 message 원문을 받는다(D5).
    const initial = codex.calls[0].turn;
    for (const required of ["오래된 필수 사용자 제약", "현재 범위의 확정 결정", "실패 로그의 원본 경로"]) {
      expect(initial.prompt).toContain(required);
    }
    expect(initial.prompt).not.toContain("폐기된 탐색 보고");
    expect(codex.calls[1].turn.prompt).not.toContain(validPlan("검토 finding 보존"));
    expect(codex.calls[1].turn.prompt).toContain("늦은 응답 거부");
    expect(codex.calls.every(({ turn }) => turn.implementation === false)).toBe(true);
    expect(codex.calls.map(({ turn }) => turn.settings)).toEqual([
      { model: "gpt-6-astra", effort: "xhigh" }, { model: "gpt-6-astra", effort: "xhigh" },
    ]);
    expect(database.getTopic("topic-1").participants).toEqual(before.participants);
    database.close();
  });

  it("결과 교정 실패 뒤 서버를 다시 열어도 저장한 리뷰 세션으로 재시도한다", async () => {
    const invalid = envelopeViolation({ message: "검토 완료", outcome: "agree" });
    const codex = new ReviewSessionAdapter([invalid, invalid, clear]);
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [], codexResult: clear, codex,
    });
    const root = temporaryDirectories.at(-1)!;
    engine.retry("topic-1");
    await waitForActionCompletion(database, "topic-1");
    expect(database.getTopic("topic-1").state).toBe("FAILED");
    expect(database.getCodexReviewSession("topic-1")).toBe("review-only-1");
    // 교정은 답한 세션에 같은 job·같은 경로(설정 포함)로 한다(v3.5 (11)).
    expect(codex.calls[1].turn.settings).toEqual(codex.calls[0].turn.settings);
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

  it("새 세션 생성 중 중복 재시도를 거부하고 취소 뒤 늦은 응답은 저장하지 않는다", async () => {
    let start!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { start = resolve; });
    const released = new Promise<void>((resolve) => { release = resolve; });
    const codex: AgentAdapter = {
      role: "codex", validateExistingSession: async () => true,
      createSession: async () => { throw new Error("봉투 턴만 부릅니다."); },
      resumeTurn: async () => { throw new Error("계획 세션을 이어 쓰면 안 됩니다."); },
      createEnvelopeSession: async () => {
        start();
        await released; // 의도적으로 취소를 무시하는 외부 프로세스의 늦은 응답
        return { sessionId: "late-review-session", envelope: { message: "검토 완료", outcome: "approve" } };
      },
      resumeEnvelopeTurn: async () => { throw new Error("계획 세션을 이어 쓰면 안 됩니다."); },
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


describe("사용량 이벤트 전달", () => {
  it("진행은 최신 관측만 갱신하고 final·경고만 원장과 이벤트 구독에 전달한다", () => {
    const { database, dependencies } = makeEngine("DRAFT", null);
    const core = new EngineCore({ ...dependencies, executionLimits: { outputTokens: 10 } });
    const received: unknown[] = [];
    database.events.on("topic:topic-1", (event) => received.push(event));
    const observe = core.usageObserver("topic-1", "claude", "턴");
    observe({ executionId: "e1", recordKind: "progress", outputTokens: 1 });
    observe({ executionId: "e1", recordKind: "progress", outputTokens: 2 });
    expect(database.getTimeline("topic-1")).toHaveLength(0);
    expect(received).toHaveLength(0);
    observe({ executionId: "e1", recordKind: "progress", outputTokens: 10 });
    observe({ executionId: "e1", recordKind: "progress", outputTokens: 11 });
    expect(database.getTimeline("topic-1")).toHaveLength(1);
    observe({ executionId: "e1", recordKind: "final", outputTokens: 12 });
    observe({ executionId: "e1", recordKind: "final", outputTokens: 12 });
    observe({ executionId: "e1", recordKind: "progress", outputTokens: 13 });
    expect(database.getTimeline("topic-1")).toHaveLength(2);
    expect(received).toHaveLength(2);
    expect(database.getPromptTimeline("topic-1", 3)).toHaveLength(0);
    expect(database.getExecutionUsage("topic-1")[0].usage.outputTokens).toBe(12);
    const late = core.usageObserver("topic-1", "codex", "턴");
    database.updateTopic("topic-1", { scopeGeneration: 4 });
    late({ executionId: "old", recordKind: "final", outputTokens: 20 });
    expect(database.getExecutionUsage("topic-1")).toHaveLength(0);
    expect(database.getTimeline("topic-1")).toHaveLength(2);
  });
});

// 2026-09-13 S10H 실측: 표기 오류가 xhigh 교정으로 갔다 — 표기 위반은 전부 low 로 분류한다(허용 오차 블록은 ⑦-2 에서 지웠다).
describe("계약 교정의 표기 위반 분류", () => {
  it("스키마·응답 종류 형식 오류는 표기 위반이고, 쟁점 누락(plain Error)은 아니다", () => {
    expect(isFormatOnlyViolation(new FormatViolation("kind"))).toBe(true);
    expect(isFormatOnlyViolation(new Error("Claude fix 가 검토 쟁점을 누락했습니다: F-1"))).toBe(false);
  });
});


it("완료한 계획을 보존하고 예산 도달 뒤 감사와 일반 재시도를 막는다", async () => {
  const {database,dependencies}=makeEngine("DRAFT",null);
  const artifacts=dependencies.artifacts;
  let claudeCalls=0,codexCalls=0; const claudePrompts:string[]=[];
  dependencies.claude.createEnvelopeSession=async turn=>{claudeCalls++;claudePrompts.push(turn.prompt);turn.onUsage?.({inputTokens:10,recordKind:"final"});
   return {sessionId:"new",envelope:envelopeOf({kind:"PLAN",summary:"완료",planMarkdown:validPlan("예산"),findings:[],evidenceRefs:[]},turn)};};
  dependencies.claude.resumeEnvelopeTurn=async turn=>(await dependencies.claude.createEnvelopeSession!(turn)).envelope;
  dependencies.codex.createEnvelopeSession=async()=>{codexCalls++;throw new Error("호출 금지");};
  dependencies.codex.resumeEnvelopeTurn=async()=>{codexCalls++;throw new Error("호출 금지");};
  const policy={execution:{inputTokens:10,outputTokens:100,durationMs:100000},total:{inputTokens:100,outputTokens:1000,durationMs:1000000}};
  database.budgets.configure("topic-1",policy,"test");
  const engine=new WorkflowEngine({...dependencies,enforceBudgets:true});
  engine.startPlan("topic-1");await waitForActionCompletion(database,"topic-1");
  expect(claudeCalls, claudePrompts.map((prompt) => prompt.slice(0, 80)).join(" || ")).toBe(1);expect(codexCalls).toBe(0);
  expect(await artifacts.readLatest("topic-1","plan")).not.toBeNull();
  expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
  expect(database.getFlags("topic-1").resumeState).toBe("CODEX_AUDIT");
  expect(()=>engine.retry("topic-1")).toThrow("예산");
  expect(database.budgets.account("topic-1")?.used.inputTokens).toBe(10);
  const before=database.getTopic("topic-1");
  database.budgets.grant("topic-1","grant",{...policy,execution:{...policy.execution,inputTokens:20}},1);
  engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
  expect(claudeCalls).toBe(1);expect(codexCalls).toBe(1);
  expect(database.getTopic("topic-1").planEpoch).toBe(before.planEpoch);
  expect(database.getTopic("topic-1").planSHA256).toBe(before.planSHA256);
  database.close();
});

for(const resumeState of ["CODEX_AUDIT"] as const) {
 it(`예산 중단의 ${resumeState} 재개는 계획 해시와 epoch를 보존한다`,async()=>{
  const {database,engine,planSHA256}=await makePlanningRecovery(resumeState,{state:"USER_DECISION_REQUIRED"});
  const epoch=database.getTopic("topic-1").planEpoch;
  database.appendEvent({topicId:"topic-1",actor:"system",kind:"system",state:"USER_DECISION_REQUIRED",body:"예산 중단",payload:{budgetPause:true,resumeState}});
  engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
  expect(database.getTopic("topic-1").planEpoch).toBe(epoch);
  expect(database.getTopic("topic-1").planSHA256).toBe(planSHA256);
  expect(database.getTimeline("topic-1").some(event=>event.state==="CLAUDE_PLAN")).toBe(false);
  expect(database.getFlags("topic-1").resumeState).toBe(resumeState);
  database.close();
 });
}

it("단계 토픽의 실제 호출은 공통 계약을 받고 작업 묶음 예산에도 누적된다",async()=>{
 const {database,dependencies}=makeEngine("DRAFT",null);
 const budget={execution:{inputTokens:100,outputTokens:100,durationMs:100000},total:{inputTokens:1000,outputTokens:1000,durationMs:1000000}};
 database.workGroups.create("group",{title:"작업",goal:"전체 목표",contracts:"공통 계약 표식",stages:[
  {id:"one",kind:"work",title:"첫 단계",goal:"지금 구현",acceptance:"검증",dependsOn:[],budget},
  {id:"two",kind:"integration",title:"통합",goal:"미래 단계 표식",acceptance:"통합 검증",dependsOn:["one"],budget}]},"/tmp/repository","head");
 database.workGroups.link("group","one","topic-1","head");
 // 작업 묶음 서비스는 단계 토픽의 참여자를 새 세션(pending)으로 연다 — 단계 문맥 머리말은 새 세션 첫 턴에 실린다(v3.18 (34)).
 for(const role of ["claude","codex"] as const)database.upsertParticipant("topic-1",{role,sessionId:`pending:${role}`,mode:"created",acknowledgedPlanSHA256:null});
 database.budgets.configure("topic-1",budget,"test");
 database.budgets.configure("group",{...budget,execution:{...budget.execution,inputTokens:5}},"test");
 let prompt="",codexCalls=0;
 dependencies.claude.createEnvelopeSession=async turn=>{prompt=turn.prompt;turn.onUsage?.({inputTokens:10});
  return {sessionId:"stage-session",envelope:envelopeOf({kind:"PLAN",summary:"plan",planMarkdown:validPlan("단계"),findings:[],evidenceRefs:[]},turn)};};
 dependencies.claude.resumeEnvelopeTurn=async turn=>(await dependencies.claude.createEnvelopeSession!(turn)).envelope;
 dependencies.codex.createEnvelopeSession=async()=>{codexCalls++;throw new Error("blocked");};dependencies.codex.resumeEnvelopeTurn=async()=>{codexCalls++;throw new Error("blocked");};
 const engine=new WorkflowEngine({...dependencies,enforceBudgets:true});engine.startPlan("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(prompt).toContain("공통 계약 표식");expect(prompt).not.toContain("미래 단계 표식");
 expect(database.budgets.account("topic-1")?.used.inputTokens).toBe(10);expect(database.budgets.account("topic-1")?.pause).toBeNull();
 expect(database.budgets.account("group")?.used.inputTokens).toBe(10);expect(database.budgets.account("group")?.pause).not.toBeNull();
 expect(codexCalls).toBe(0);database.close();
});

// E4(plan §3.3) 계약 변경: 중간 단계는 push 가 아니라 검증된 로컬 커밋(HEAD==committedOID·clean·커밋 트리==리뷰 트리·기준의 후손)에서 닫고, 닫을 때
// 결과를 동결한다. 원격 전달은 단계 착수와 분리된 상태다. (E4 전 계약: "다음 단계로 넘어가려면 먼저 커밋과 푸시를 완료하세요.")
it("묶음의 중간 단계는 검증된 로컬 커밋에서 push 없이 닫고 결과를 동결한다",async()=>{
 const commit="c".repeat(40),tree="e".repeat(40);
 let head="head",treeFiles="",ancestor=true;
 const ok=(stdout:string,exitCode=0)=>({exitCode,stdout,stderr:"",jsonLines:[]});
 const runner:CommandRunner={run:async spec=>{
  const args=spec.args;
  if(args[0]==="rev-parse"&&args[1]==="HEAD")return ok(`${head}\n`);
  if(args[0]==="status")return ok("");
  if(args[0]==="diff-tree"&&args.includes("--name-only"))return ok(treeFiles);
  if(args[0]==="diff-tree")return ok("");
  if(args[0]==="merge-base"&&args[1]==="--is-ancestor")return ok("",ancestor?0:1);
  throw new Error(`예상하지 않은 git 호출: ${args.join(" ")}`);
 }};
 const {database,engine}=makeEngine("READY_TO_DELIVER","a".repeat(64),true,runner);
 const budget={execution:{inputTokens:10,outputTokens:10,durationMs:100},total:{inputTokens:100,outputTokens:100,durationMs:1000}};
 database.workGroups.create("group",{title:"작업",goal:"목표",contracts:"계약",stages:[
 {id:"a",kind:"work",title:"a",goal:"a",acceptance:"a",dependsOn:[],budget},
 {id:"b",kind:"integration",title:"b",goal:"b",acceptance:"b",dependsOn:["a"],budget}]},"/repo","head");
 database.workGroups.link("group","a","topic-1","head");
 // 동기 close 는 묶음 단계를 닫지 않는다(동결 기록 없이 닫히면 다음 단계가 승계할 수 없다).
 expect(()=>engine.close("topic-1")).toThrow("closeStage");
 await expect(engine.closeStage("topic-1")).rejects.toThrow("저장된 plan.md가 없습니다");
 database.updateTopic("topic-1",{committedOID:commit,reviewedTreeOID:tree});
 await expect(engine.closeStage("topic-1")).rejects.toThrow("작업 트리 HEAD");
 head=commit;treeFiles="form.swift\0";
 await expect(engine.closeStage("topic-1")).rejects.toThrow("리뷰한 트리");
 treeFiles="";ancestor=false;
 await expect(engine.closeStage("topic-1")).rejects.toThrow("후손");
 ancestor=true;
 expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
 expect((await engine.closeStage("topic-1")).state).toBe("CLOSED");
 expect(database.getFlags("topic-1").pushedOID??null).toBeNull();
 expect(database.workGroups.get("group").results?.a).toMatchObject({stageId:"a",topicId:"topic-1",baseOID:"head",commitOID:commit,reviewedTreeOID:tree,planSHA256:"a".repeat(64)});
 database.close();
});

// F010(79fc4fc5): 계획 버전은 계획 묶음 직렬화 바이트의 sha256 이다 — 파일이 둘 이상이면 직렬화가 파일마다 끝 개행을 더해 옛 정규화 해시(hashPlan)와
// 달라진다. 무변경 단계 닫기는 같은 바이트 계약으로 승인 계획을 확인한다.
it("planned 무변경 단계는 여러 파일 계획 묶음의 바이트 버전으로 승인 계획을 확인하고 닫는다",async()=>{
 const tree="e".repeat(40);
 const ok=(stdout:string,exitCode=0)=>({exitCode,stdout,stderr:"",jsonLines:[]});
 const runner:CommandRunner={run:async spec=>{
  const args=spec.args;
  if(args[0]==="rev-parse"&&args[1]==="HEAD")return ok("head\n");
  if(args[0]==="status")return ok("");
  if(args[0]==="diff-tree")return ok("");
  if(args[0]==="merge-base"&&args[1]==="--is-ancestor")return ok("");
  throw new Error(`예상하지 않은 git 호출: ${args.join(" ")}`);
 }};
 const files=[{path:"plan.md",content:`${validPlan("무변경 묶음")}\n`},{path:"steps.md",content:"## 단계\n\n1. 기존 동작을 확인만 한다.\n"}];
 const version=planBundleVersion(files);
 expect(hashPlan(serializePlanBundle(files))).not.toBe(version);
 const {database,engine,dependencies}=makeEngine("READY_TO_DELIVER",version,true,runner);
 await dependencies.artifacts.write("topic-1","plan",1,serializePlanBundle(files));
 database.updateTopic("topic-1",{reviewedHead:"head",reviewedTreeOID:tree});
 const budget={execution:{inputTokens:10,outputTokens:10,durationMs:100},total:{inputTokens:100,outputTokens:100,durationMs:1000}};
 database.workGroups.create("group",{title:"작업",goal:"목표",contracts:"계약",stages:[
 {id:"a",kind:"work",title:"a",goal:"a",acceptance:"a",dependsOn:[],budget},
 {id:"b",kind:"integration",title:"b",goal:"b",acceptance:"b",dependsOn:["a"],budget}]},"/repo","head");
 database.workGroups.link("group","a","topic-1","head");
 expect((await engine.closeStage("topic-1")).state).toBe("CLOSED");
 expect(database.workGroups.get("group").results?.a).toMatchObject({stageId:"a",commitOID:"head",reviewedTreeOID:tree,planSHA256:version});
 database.close();
});

// F010 같은 계열: 현재 계획 판도 같은 바이트 계약으로 읽는다 — 공백만 다른 최신 산출물(아직 현재 판이 아님)을 현재 판으로 받지 않는다.
it("현재 계획은 계획 sha 와 바이트가 같은 산출물이고, 공백만 다른 최신 산출물을 현재 판으로 받지 않는다",async()=>{
 const current="## 계획\n\n현재 판\n",later=`${current}\n`;
 const planSHA256=createHash("sha256").update(current,"utf8").digest("hex");
 expect(hashPlan(later)).toBe(planSHA256);
 const {database,dependencies}=makeEngine("READY_TO_DELIVER",planSHA256,true);
 const bound=await dependencies.artifacts.write("topic-1","plan",1,current);
 await dependencies.artifacts.write("topic-1","plan",2,later);
 expect(await new EngineCore(dependencies).requireCurrentPlanArtifact("topic-1")).toEqual({path:bound.path,content:current});
 database.close();
});

// 합류·통합 close(E4-5·6): 합류 대상(기준에 모이지 않은 선행 결과)과 통합 단계의 다른 모든 단계 결과는 결과 커밋의 조상이어야 한다. git 확인 사이에
// 결과 커밋이 바뀌면 거부한다. 변경 없이 검증만 한 통합 단계는 기준 커밋이 결과다.
// 닫기 결과 확인의 합성 fixture — git 은 합성 응답이다. 공식 경로(병합 준비·병합 커밋·close·push)의 종단 증명은 tests/work-group-e2e.test.ts 가 실제 git 으로 한다.
// 선행 단계 토픽은 CLOSED 이고 그 작업 트리 HEAD 가 동결 결과 커밋이다(승계 검사 — closeStage 가 어댑터와 같은 선행 결과 해석 함수를 쓴다).
function stageCloseFixture(kind:"merge"|"integration"){
 const commit="c".repeat(40),tree="e".repeat(40),dirtyTree="d".repeat(40);
 const notAncestors=new Set<string>();let onMergeBase:(()=>void)|null=null;let head=commit;
 const ok=(stdout:string,exitCode=0)=>({exitCode,stdout,stderr:"",jsonLines:[]});
 const runner:CommandRunner={run:async spec=>{
  const args=spec.args;
  if(args[0]==="rev-parse"&&args[1]==="HEAD")return ok(`${spec.cwd.startsWith("/w-")?`${spec.cwd.slice(3)}-commit`:head}\n`);
  if(args[0]==="status")return ok("");
  // 리뷰 트리가 dirtyTree 면 리뷰한 작업 트리에 변경이 있었던 것이다.
  if(args[0]==="diff-tree")return ok(args.includes(dirtyTree)&&args.includes("--name-only")?"changed.txt\0":"");
  if(args[0]==="merge-base"&&args[1]==="--is-ancestor"){const hook=onMergeBase;onMergeBase=null;hook?.();return ok("",notAncestors.has(args[2])?1:0);}
  throw new Error(`예상하지 않은 git 호출: ${args.join(" ")}`);
 }};
 const {database,engine}=makeEngine("READY_TO_DELIVER","a".repeat(64),true,runner);
 const budget={execution:{inputTokens:10,outputTokens:10,durationMs:100},total:{inputTokens:100,outputTokens:100,durationMs:1000}};
 const stage=(id:string,dependsOn:string[],stageKind:"work"|"integration"="work")=>({id,kind:stageKind,title:id,goal:id,acceptance:id,dependsOn,budget});
 database.workGroups.create("group",{title:"작업",goal:"목표",contracts:"계약",stages:kind==="merge"
  ?[stage("x",[]),stage("y",[]),stage("z",["x","y"]),stage("int",["z"],"integration")]
  :[stage("x",[]),stage("y",[]),stage("w",[]),stage("int",["x"],"integration")]},"/repo","head");
 const result=(stageId:string,topicId:string)=>({stageId,topicId,baseOID:"head",commitOID:`${stageId}-commit`,reviewedTreeOID:tree,planSHA256:"p".repeat(64),
  evidenceDigest:null,verifications:[],memoryChanges:[],openQuestions:[],deferredFindings:[],decisions:[],closedAt:"2026-09-27T00:00:00.000Z"});
 const closedPrior=(stageId:string,selected:boolean)=>{
  database.createTopic({workflowMode:"planned",id:`topic-${stageId}`,slug:stageId,title:stageId,repositoryPath:"/repo",worktreePath:`/w-${stageId}`,baseRef:"head",branchName:`consensus/${stageId}`,
   state:"CLOSED",scopeGeneration:1,planRevision:1,planSHA256:"b".repeat(64),approvedPlanSHA256:"b".repeat(64),createdAt:"2026-09-27T00:00:00.000Z",
   updatedAt:"2026-09-27T00:00:00.000Z",lastError:null});
  database.workGroups.link("group",stageId,`topic-${stageId}`,"head",selected?{selected:true}:{});database.workGroups.freezeResult("group",result(stageId,`topic-${stageId}`));
 };
 closedPrior("x",false);closedPrior("y",true);
 // w 는 통합 단계가 의존하지도, 합류 대상으로 받지도 않는 단계다(기준 커밋에 이미 들었다고 본 결과) — 통합은 그래도 w 결과를 조상으로 요구한다.
 if(kind==="integration")closedPrior("w",true);
 if(kind==="merge")database.workGroups.link("group","z","topic-1","x-commit",{selected:true,mergeTargets:["y"],
  preparedMerge:{tree,conflicts:[],targets:[{stageId:"y",commitOID:"y-commit"}]}});
 else database.workGroups.link("group","int","topic-1","x-commit",{selected:true});
 database.updateTopic("topic-1",{committedOID:commit,reviewedTreeOID:tree});
 return {database,engine,commit,dirtyTree,notAncestors,setHead:(value:string)=>{head=value;},onMergeBase:(hook:()=>void)=>{onMergeBase=hook;}};
}

it("합류 대상 결과가 결과 커밋의 조상이 아니면 단계를 닫지 않고, 확인하는 동안 결과 커밋이 바뀌어도 닫지 않는다",async()=>{
 const fx=stageCloseFixture("merge");
 fx.notAncestors.add("y-commit");
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow("단계 y 의 결과 커밋이 이 단계 결과에 포함되지 않았습니다(합류 대상)");
 fx.notAncestors.clear();
 fx.onMergeBase(()=>fx.database.updateTopic("topic-1",{committedOID:"f".repeat(40)}));
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow();
 expect(fx.database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
 expect(fx.database.workGroups.get("group").results?.z).toBeUndefined();
 fx.database.updateTopic("topic-1",{committedOID:fx.commit});
 fx.onMergeBase(()=>fx.database.updateTopic("topic-1",{committedOID:"f".repeat(40)}));
 fx.setHead(fx.commit);
 // HEAD 확인 뒤(조상 확인 중) 결과 커밋이 바뀐 경우 — git 경계 뒤 재확인이 막는다.
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow("결과 커밋이 바뀌었습니다");
 fx.database.updateTopic("topic-1",{committedOID:fx.commit});
 // 합류 병합을 준비한 단계는 커밋 없이(기준 커밋 그대로) 닫을 수 없다 — 준비한 병합은 병합 커밋으로만 결과가 된다.
 fx.database.updateTopic("topic-1",{committedOID:null});fx.setHead("x-commit");
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow("먼저 검증된 결과를 커밋하세요");
 fx.database.updateTopic("topic-1",{committedOID:fx.commit});fx.setHead(fx.commit);
 expect((await fx.engine.closeStage("topic-1")).state).toBe("CLOSED");
 expect(fx.database.workGroups.get("group").results?.z).toMatchObject({commitOID:fx.commit,baseOID:"x-commit"});
 fx.database.close();
});

it("통합 단계는 의존하지 않는 단계를 포함해 다른 모든 단계 결과가 조상이어야 닫히고, 변경 없이 검증만 했으면 리뷰한 기준 커밋이 결과이자 확정 커밋이다",async()=>{
 const fx=stageCloseFixture("integration");
 fx.notAncestors.add("y-commit");
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow("단계 y 의 결과 커밋이 이 단계 결과에 포함되지 않았습니다(통합 대상)");
 fx.notAncestors.clear();
 // 합류 대상이 아닌 단계(w)의 결과도 조상이어야 한다 — 통합은 합류 대상만이 아니라 다른 모든 단계 결과를 확인한다.
 fx.notAncestors.add("w-commit");
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow("단계 w 의 결과 커밋이 이 단계 결과에 포함되지 않았습니다(통합 대상)");
 fx.notAncestors.clear();
 // 커밋 없이 기준(x-commit)에서 검증만 한 통합(F004) — 리뷰 HEAD 가 기준이 아니면(리뷰 기록 없음) 닫지 않는다.
 fx.database.updateTopic("topic-1",{committedOID:null,reviewedHead:null});fx.setHead("x-commit");
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow("변경 없는 단계 결과를 리뷰한 기록");
 // 리뷰한 작업 트리에 변경이 있었는데(리뷰 트리 ≠ 기준 트리) 커밋하지 않고 되돌렸으면 리뷰한 결과가 아니다.
 fx.database.updateTopic("topic-1",{reviewedHead:"x-commit",reviewedTreeOID:fx.dirtyTree});
 await expect(fx.engine.closeStage("topic-1")).rejects.toThrow("리뷰한 작업 트리에 변경이 있었습니다");
 fx.database.updateTopic("topic-1",{reviewedTreeOID:"e".repeat(40)});
 expect((await fx.engine.closeStage("topic-1")).state).toBe("CLOSED");
 expect(fx.database.workGroups.get("group").results?.int).toMatchObject({commitOID:"x-commit",baseOID:"x-commit"});
 // 리뷰한 기준 커밋을 전달 계약의 확정 커밋으로 기록한다(F003) — 닫힌 단계 push 가 이 커밋을 싣는다.
 expect(fx.database.getFlags("topic-1").committedOID).toBe("x-commit");
 fx.database.close();
});

it("막힌 단계 판정: 사용자 결정 대기만 막힘이고, 예산·리뷰·재작성 같은 자원 정지와 진행 중 상태는 막힘이 아니다",()=>{
 const {database,engine}=makeEngine("DRAFT",null);
 expect(engine.stageBlockedExternally("topic-1")).toBe(false);
 const interrupt=(state:"USER_DECISION_REQUIRED",payload:Record<string,unknown>)=>{
  database.updateTopic("topic-1",{state});
  database.appendEvent({topicId:"topic-1",actor:"system",kind:"system",state,body:"중단",payload:{resumeState:"CLAUDE_PLAN",...payload}});
 };
 interrupt("USER_DECISION_REQUIRED",{});expect(engine.stageBlockedExternally("topic-1")).toBe(true);
 for(const key of ["budgetPause","revisionPause","planningPause"]) {interrupt("USER_DECISION_REQUIRED",{[key]:true});expect(engine.stageBlockedExternally("topic-1")).toBe(false);}
 interrupt("USER_DECISION_REQUIRED",{reviewPause:"planning"});expect(engine.stageBlockedExternally("topic-1")).toBe(false);
 interrupt("USER_DECISION_REQUIRED",{admissionRefused:"잠금"});expect(engine.stageBlockedExternally("topic-1")).toBe(false);
 // 결정 대기 상태라도 실행이 돌고 있으면(결정을 처리하는 중) 막힌 것이 아니다.
 interrupt("USER_DECISION_REQUIRED",{});
 database.startAction({id:"running-action",topicId:"topic-1",kind:"retry",status:"running",createdAt:"2026-09-27T00:00:00.000Z",finishedAt:null,error:null,
  pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
 expect(engine.stageBlockedExternally("topic-1")).toBe(false);
 database.updateTopic("topic-1",{state:"FAILED"});expect(engine.stageBlockedExternally("topic-1")).toBe(false);
 database.close();
});

it("네 번째 계획 검토를 차단하고 1회 승인 뒤 저장된 계획으로 같은 검토를 재개한다",async()=>{
 const {database,engine,planSHA256}=await makePlanningRecovery("CODEX_AUDIT");
 for(const id of ["one","two","three"])database.reviews.admit("topic-1",id,"planning");
 const epoch=database.getTopic("topic-1").planEpoch;
 engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(database.getTopic("topic-1"),database.getTopic("topic-1").lastError??"").toMatchObject({state:"USER_DECISION_REQUIRED",planSHA256,planEpoch:epoch});
 expect(database.getFlags("topic-1").resumeState).toBe("CODEX_AUDIT");
 expect(()=>engine.retry("topic-1")).toThrow("한도");
 database.reviews.grant("topic-1","planning","allow",2);
 engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(database.reviews.account("topic-1","planning").used).toBe(4);
 expect(database.getTopic("topic-1")).toMatchObject({state:"FAILED",planSHA256,planEpoch:epoch});
 expect(database.getFlags("topic-1").resumeState).toBe("CODEX_AUDIT");
 database.close();
});

it("세 번째 구현 리뷰는 전달 준비까지 완료하고 네 번째 호출은 중단한다",async()=>{
 const result:AgentResult={kind:"REVIEW",summary:"검토 완료",findings:[],evidenceRefs:[]};
 const {database,engine}=await makeReviewRecovery({resumeState:"CODEX_REVIEW",implementationFindings:[],originalReviewFindings:[],codexResult:result});
 database.reviews.admit("topic-1","one","implementation");database.reviews.admit("topic-1","two","implementation");
 engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
 expect(database.reviews.account("topic-1","implementation").used).toBe(3);
 // 새 증거로 기존 통과 판정 재사용을 막아 실제 네 번째 호출이 필요한 상태를 만든다.
 await engine.postMessage("topic-1", "evidence", "추가 검증 결과를 검토해야 합니다.");
 database.updateTopic("topic-1",{state:"FAILED",resumeState:"CODEX_REVIEW"});
 engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
 expect(engine.reviewPaused("topic-1")).toBe("implementation");
 expect(database.reviews.account("topic-1","implementation").used).toBe(3);database.close();
});

// 2026-09-14 S11: 러너가 중간 보고를 완료 형식으로 닫아 리뷰로 넘어가 한도에서 멈춘 뒤, 중재자가 resume_state 를
// IMPLEMENTING 으로 되돌리면 리뷰 승인 없이 retry 가 구현을 재개해야 한다(한도 정지는 그 리뷰 단계 재개에만 걸린다).
it("리뷰 한도 정지 뒤 resume_state 를 다른 단계로 되돌리면 retry 가 리뷰 승인 없이 그 단계를 재개한다",async()=>{
 const result:AgentResult={kind:"REVIEW",summary:"검토 완료",findings:[],evidenceRefs:[]};
 const {database,engine}=await makeReviewRecovery({resumeState:"CODEX_REVIEW",implementationFindings:[],originalReviewFindings:[],codexResult:result});
 for(const id of ["one","two","three"])database.reviews.admit("topic-1",id,"implementation");
 database.updateTopic("topic-1",{state:"FAILED",resumeState:"CODEX_REVIEW"});
 engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(database.getTopic("topic-1").state).toBe("USER_DECISION_REQUIRED");
 expect(engine.reviewPaused("topic-1")).toBe("implementation");
 expect(()=>engine.retry("topic-1")).toThrow("한도");
 database.updateTopic("topic-1",{resumeState:"IMPLEMENTING"});
 expect(engine.reviewPaused("topic-1")).toBeNull();
 expect(()=>engine.retry("topic-1")).not.toThrow();
 await waitForActionCompletion(database,"topic-1");
 expect(database.reviews.account("topic-1","implementation").used).toBe(3);database.close();
});

// 봉투 계약 위반 교정(v3.5 (11)) — 어댑터가 결과 봉투를 확인하지 못하면 UnverifiedAgentResult 를 던진다. 교정은 같은 세션·같은 job 의 1회이며 재작성 회차·
// 리뷰 승인을 쓰지 않는다(D8).
const envelopeViolation = (raw: Record<string, unknown>) => () => {
  throw new UnverifiedAgentResult(raw, "에이전트가 결과 봉투를 반환하지 않았습니다. 계약 위반: outcome");
};

it("개정 교정은 원본 세션에서 바로 교정한다(D8)",async()=>{
 const plan=validPlan("계획 단계 재개");
 const raw={message:"종류만 잘못 적은 개정",outcome:"agree"};
 const {database,engine,claude}=await makePlanningRecovery("CLAUDE_REVISION",{claudeResults:[
  envelopeViolation(raw),
  {kind:"REVISION",summary:"종류 교정",planMarkdown:plan,findings:[],evidenceRefs:[]},
 ]});
 engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(claude.calls).toHaveLength(2);expect(claude.turns[1]).toMatchObject({sessionId:"claude-session"});
 expect(claude.calls[1]).toContain(buildEnvelopeCorrectionPrompt("planner",envelopeIssues("planner",raw)));
 expect(database.getTimeline("topic-1").some(event=>event.actor==="claude"&&event.body==="종류 교정")).toBe(true);database.close();
});

it("최초 계획 교정은 같은 세션에서 교정하고 epoch를 바꾸거나 계획 호출을 다시 사지 않는다(D8)",async()=>{
 const raw={message:"종류 오류",outcome:"approve"};
 const {database,engine,claude}=makePlanningEngine({slug:"initial-correction",claudeResults:[
  envelopeViolation(raw),
  {kind:"PLAN",summary:"교정 완료",planMarkdown:validPlan("계획"),findings:[],evidenceRefs:[]},
 ],codexResults:[]});
 const epoch=database.getTopic("topic-1").planEpoch;
 engine.startPlan("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(claude.calls).toHaveLength(2);expect(claude.turns[1]).toMatchObject({sessionId:"claude-session"});
 expect(claude.calls[1]).toContain(buildEnvelopeCorrectionPrompt("planner",envelopeIssues("planner",raw)));
 expect(database.getTopic("topic-1").planEpoch).toBe(epoch);database.close();
});

it("리뷰 결과 교정은 추가 승인 없이 같은 리뷰 세션과 논리 리뷰 한도에서 진행한다",async()=>{
 const raw={message:"종류 오류",outcome:"agree"};
 const codex=new ReviewSessionAdapter([envelopeViolation(raw),{kind:"REVIEW",summary:"교정 완료",findings:[],evidenceRefs:[]}]);
 const {database,engine}=await makeReviewRecovery({resumeState:"CODEX_REVIEW",implementationFindings:[],originalReviewFindings:[],codexResult:{kind:"REVIEW",summary:"unused",findings:[],evidenceRefs:[]},codex});
 database.reviews.admit("topic-1","a","implementation");database.reviews.admit("topic-1","b","implementation");
 engine.retry("topic-1");await waitForActionCompletion(database,"topic-1");
 expect(codex.calls).toHaveLength(2);expect(codex.calls[1]).toMatchObject({sessionId:codex.calls[0].sessionId,created:false});
 expect(codex.calls[1].turn.prompt).toContain(buildEnvelopeCorrectionPrompt("code-reviewer",envelopeIssues("code-reviewer",raw)));expect(database.getTopic("topic-1").state).toBe("READY_TO_DELIVER");
 expect(database.reviews.account("topic-1","implementation").used).toBe(3);database.close();
});



// 2026-09-14 Codex 감사 D01·R01② — 공식 구현 재개 API 와 계약 교정의 원본 필드 병합(공개 경계).
describe("Codex 감사 2026-09-14 — resume-implementation / 계약 교정 원본 병합", () => {
  it("리뷰 한도로 멈춘 토픽을 resume-implementation 으로 IMPLEMENTING 재개 상태로 되돌린다(기대 상태·세대 결속, 리뷰 소비량 불변)", async () => {
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [],
      codexResult: { kind: "REVIEW", summary: "unused", findings: [], evidenceRefs: [] },
    });
    database.setImplementationSession("topic-1", "claude-implementation-session");
    database.updateTopic("topic-1", { state: "USER_DECISION_REQUIRED" });
    database.updateTopic("topic-1", { fixPassUsed: true, secondFixPassUsed: true, reviewedHead: "old-head",
      reviewedDiffSHA256: "old-diff", reviewedTreeOID: "old-tree" });
    const before = database.reviews.account("topic-1", "implementation").used;
    expect(() => engine.resumeImplementation("topic-1", { expectedState: "FAILED", expectedScopeGeneration: 1, reason: "x" })).toThrow("기대 상태");
    expect(() => engine.resumeImplementation("topic-1", { expectedState: "USER_DECISION_REQUIRED", expectedScopeGeneration: 9, reason: "x" })).toThrow("범위 세대");
    const topic = engine.resumeImplementation("topic-1", { expectedState: "USER_DECISION_REQUIRED", expectedScopeGeneration: 1, reason: "완료 형식 중간 보고를 되돌림" }, { actor: "mediator", delegationSetAt: "2026-09-14T00:00:00Z" });
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(database.getFlags("topic-1")).toMatchObject({ fixPassUsed: false, secondFixPassUsed: false,
      reviewedHead: null, reviewedDiffSHA256: null, reviewedTreeOID: null });
    expect(database.getFlags("topic-1").resumeState).toBe("IMPLEMENTING");
    expect(database.reviews.account("topic-1", "implementation").used).toBe(before);
    const event = database.getTimeline("topic-1").at(-1)!;
    expect(event.body).toContain("구현 계속 재개(공식)");
    expect(event.payload.origin).toEqual({ actor: "mediator", delegationSetAt: "2026-09-14T00:00:00Z" });
    database.close();
  });

  it("ticket 은 승인 계획 없이 구현 세션으로 재개하고, planned 는 승인된 현재 계획을 요구한다(D1)", async () => {
    const { database, engine } = await makeReviewRecovery({
      resumeState: "CODEX_REVIEW", implementationFindings: [], originalReviewFindings: [],
      codexResult: { kind: "REVIEW", summary: "unused", findings: [], evidenceRefs: [] },
    });
    database.setImplementationSession("topic-1", "claude-implementation-session");
    database.updateTopic("topic-1", { state: "USER_DECISION_REQUIRED", planSHA256: null, approvedPlanSHA256: null });
    const input = { expectedState: "USER_DECISION_REQUIRED" as const, expectedScopeGeneration: 1, reason: "계획 없는 수정 작업을 잇는다" };
    expect(() => engine.resumeImplementation("topic-1", input)).toThrow("승인된 계획이 없거나");
    database.updateTopic("topic-1", { workflowMode: "ticket" });
    engine.resumeImplementation("topic-1", input);
    expect(database.getFlags("topic-1").resumeState).toBe("IMPLEMENTING");
    database.close();
  });
});

it("원문 변경 뒤 교정 대기를 재개하면 옛 응답 대신 새 계획을 작성한다 — 교정 대기는 교정 뒤에도 위반이 남아 멈춘 응답이다",async()=>{
 const {database,dependencies}=makeEngine("DRAFT",null);
 database.updateTopic("topic-1",{state:"CLAUDE_PLAN"});
 const source=database.evidence.register("topic-1",{url:"https://team.atlassian.net/browse/APP-1",label:"Planning",mode:"connector",intervalSeconds:300});
 const ingest=(content:string)=>{const check=database.evidence.begin(source.id,true)!;database.evidence.ingest(source.id,{checkId:check.checkId,revision:content,units:[{id:"issue",kind:"issue",content}]});};
 ingest("old decision");
 const original=validPlan("old decision");
 const updated=validPlan("new decision");
 const calls:string[]=[];
 dependencies.claude.createSession=async()=>{calls.push("create");return {sessionId:`correction-session-${calls.length}`,result:{kind:"PLAN",summary:"plan",planMarkdown:calls.length===1?original:updated,findings:[],evidenceRefs:[]}};};
 // 같은 세션 교정도 옛 결정을 그대로 내 위반이 남는다 — 교정 뒤 위반이라 교정 대기본이 남는다.
 dependencies.claude.resumeTurn=async turn=>{calls.push(`correct:${turn.sessionId}`);return {kind:"PLAN",summary:"plan",planMarkdown:original,findings:[],evidenceRefs:[]};};
 let checked:AgentResult|undefined;
 const run=(core:EngineCore)=>core.startAction("topic-1","test",async signal=>{
  checked=await core.turn(core.route(database.getTopic("topic-1"),{role:"planner",operation:"plan"}),database.getTopic("topic-1"),"Write current plan",signal,{freshSession:true,check:r=>{if(r.planMarkdown?.includes("old decision"))throw new Error("옛 결정을 담은 계획");}});
 });
 run(new EngineCore(dependencies));await waitForActionCompletion(database,"topic-1");
 expect(database.getTopic("topic-1").state).toBe("FAILED");expect(calls).toEqual(["create","correct:correction-session-1"]);
 ingest("new decision");
 database.updateTopic("topic-1",{state:"CLAUDE_PLAN"});
 run(new EngineCore(dependencies));await waitForActionCompletion(database,"topic-1");
 expect(calls).toEqual(["create","correct:correction-session-1","create"]);
 expect(checked?.planMarkdown,database.getTopic("topic-1").lastError??"").toBe(updated);
 expect(await dependencies.artifacts.readLatest("topic-1","pending-contract-repair")).toContain("old decision");
 database.close();
});


it("does not age out a live or unrecognized maintenance owner", () => {
  const { root, database, dependencies } = makeEngine("DRAFT", null);
  const path = join(root, "maintenance.lock");
  const core = new EngineCore({ ...dependencies, maintenanceLockPath: path });
  const at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeFileSync(path, JSON.stringify({ pid: process.pid, at }));
  expect(() => core.assertNoMaintenanceLock()).toThrow("유지보수 잠금");
  writeFileSync(path, "{partial");
  expect(() => core.assertNoMaintenanceLock()).toThrow("유지보수 잠금");
  writeFileSync(path, JSON.stringify({ pid: 2147483647, at }));
  expect(() => core.assertNoMaintenanceLock()).not.toThrow();
  database.close();
});


it("hands mediator execution off without purchasing another runner or review turn", async () => {
  const claude = new QueuedAdapter("claude", [{ kind: "FIX", summary: "Code ready for render verification", findings: [], evidenceRefs: [],
    status: "in_progress", requestedMediatorAction: "Run the authorized render gate and return its evidence",
    remainingSteps: ["Update UI test selectors after render verification"] }]);
  const codex = new QueuedAdapter("codex", []);
  const { database, engine } = await makeReviewRecovery({ resumeState: "CLAUDE_FIX",
    implementationFindings: [], originalReviewFindings: [],
    codexResult: { kind: "REVIEW", summary: "unused", findings: [], evidenceRefs: [] }, claude, codex });
  database.setImplementationSession("topic-1", "claude-implementation-session");
  engine.retry("topic-1");
  await waitForActionCompletion(database, "topic-1");
  expect(database.getTopic("topic-1")).toMatchObject({ state: "USER_DECISION_REQUIRED" });
  expect(database.getTopic("topic-1").lastError).toContain("Run the authorized render gate and return its evidence");
  expect(database.getTimeline("topic-1").some(event => event.payload?.waitingFor === "mediator")).toBe(true);
  expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_FIX");
  expect(claude.calls).toHaveLength(1);
  expect(codex.calls).toHaveLength(0);
  database.close();
});


it("retry without mediator evidence is refused without re-invoking the waiting runner", async () => {
  const waiting: AgentResult = { kind: "FIX", summary: "Code ready for render verification", findings: [], evidenceRefs: [],
    status: "in_progress", requestedMediatorAction: "Run the authorized render gate and return its evidence",
    remainingSteps: ["Update UI test selectors after render verification"] };
  const claude = new QueuedAdapter("claude", [waiting, waiting]);
  const codex = new QueuedAdapter("codex", []);
  const { database, engine } = await makeReviewRecovery({ resumeState: "CLAUDE_FIX",
    implementationFindings: [], originalReviewFindings: [],
    codexResult: { kind: "REVIEW", summary: "unused", findings: [], evidenceRefs: [] }, claude, codex });
  database.setImplementationSession("topic-1", "claude-implementation-session");
  engine.retry("topic-1");
  await waitForActionCompletion(database, "topic-1");
  expect(claude.calls).toHaveLength(1);
  const actions = database.getTimeline("topic-1").length;
  expect(() => engine.retry("topic-1")).toThrow("중재자 실행 대기 중입니다");
  database.appendEvent({ topicId: "topic-1", actor: "user", kind: "decision", state: "USER_DECISION_REQUIRED", body: "Render not run yet" });
  expect(() => engine.retry("topic-1")).toThrow("중재자 실행 대기 중입니다");
  expect(claude.calls).toHaveLength(1);
  expect(database.getTimeline("topic-1")).toHaveLength(actions + 1);
  // The mediator's execution evidence lets the same stage resume once.
  database.appendEvent({ topicId: "topic-1", actor: "user", kind: "evidence", state: "USER_DECISION_REQUIRED", body: "Render gate passed: 4 segments" });
  engine.retry("topic-1");
  await waitForActionCompletion(database, "topic-1");
  expect(claude.calls).toHaveLength(2);
  expect(database.getFlags("topic-1").resumeState).toBe("CLAUDE_FIX");
  database.close();
});
