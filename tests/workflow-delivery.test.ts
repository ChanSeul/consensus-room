import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import { WorkflowEngine } from "../src/server/workflow";
import { REQUIRED_PLAN_HEADINGS, type AgentResult } from "../src/shared/contracts";
import { hashPlan } from "../src/shared/workflow";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("승인 뒤 구현부터 전달까지", () => {
  it.each([true, false])("Claude 구현·보완과 최종 리뷰 뒤에만 전달한다 (파일 수정: %s)", async (changeOnFix) => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-delivery-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const remote = join(root, "origin.git");
    const worktree = join(root, "worktrees", "topic");
    const data = join(root, "data");
    git(root, ["init", "--bare", remote]);
    git(root, ["init", "--initial-branch=develop", repository]);
    git(repository, ["config", "user.name", "Consensus Room Test"]);
    git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
    writeFileSync(join(repository, "feature.txt"), "기준\n");
    git(repository, ["add", "feature.txt"]);
    git(repository, ["commit", "-m", "baseline"]);
    git(repository, ["remote", "add", "origin", remote]);
    git(repository, ["push", "-u", "origin", "develop"]);

    const gitService = new GitService(new SpawnCommandRunner());
    await gitService.createDetachedWorktree(repository, worktree, "develop");
    const baseline = await gitService.head(worktree);
    const database = new ConsensusDatabase(join(data, "room.sqlite"));
    const artifacts = new ArtifactStore(join(data, "topics"), database);
    const plan = validPlan();
    const planSHA256 = hashPlan(plan);
    const topicId = "11111111-2222-4333-8444-555555555555";
    const timestamp = "2026-08-23T00:00:00.000Z";
    database.createTopic({
      id: topicId,
      slug: "delivery-flow",
      title: "전달 흐름",
      repositoryPath: repository,
      baseRef: "develop",
      worktreePath: worktree,
      branchName: null,
      state: "AWAITING_USER_APPROVAL",
      scopeGeneration: 1,
      planRevision: 2,
      planSHA256,
      approvedPlanSHA256: planSHA256,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: null,
    });
    database.upsertParticipant(topicId, {
      role: "claude", sessionId: "claude-plan-session", mode: "attached",
      acknowledgedPlanSHA256: planSHA256,
    });
    database.upsertParticipant(topicId, {
      role: "codex", sessionId: "codex-review-session", mode: "attached",
      acknowledgedPlanSHA256: planSHA256,
    });
    await artifacts.write(topicId, "plan", 2, `${plan.trim()}\n`);

    const claude = new EditingClaude(worktree, changeOnFix);
    const codex = new ReviewingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude, codex });

    const ready = waitForState(database, topicId, "READY_TO_DELIVER");
    engine.startImplementation(topicId);
    await ready;
    await waitUntil(() => database.runningAction(topicId) === null);

    const reviewedTopic = database.getTopic(topicId);
    const flags = database.getFlags(topicId);
    // 첫 리뷰는 별도 세션에서 승인 계획 전문을 받고, 최종 리뷰는 그 세션에서 SHA와 findings 색인을 받는다.
    expect(codex.prompts).toHaveLength(2);
    expect(codex.prompts[0]).toContain(planSHA256);
    expect(codex.prompts[0]).toContain("승인된 계획:\n---");
    expect(codex.prompts[0]).toContain(plan);
    expect(codex.prompts[1]).toContain("본문은 다시 싣지 않습니다");
    expect(codex.prompts[1]).toContain(changeOnFix ? "직전 리뷰 이후 실제 변경분(파일 1개)" : "직전 리뷰 이후 실제 변경분(파일 0개)");
    expect(codex.sessions).toEqual(["codex-code-review", "codex-code-review"]);
    expect(reviewedTopic.participants.find((participant) => participant.role === "codex")?.sessionId).toBe("codex-review-session");
    expect(codex.prompts[1]).toContain("- F-1 [MEDIUM] 보완할 동작 → AGREED_ACTION");
    expect(codex.prompts[1]).not.toContain("현재 구현을 한 번 고쳐야 합니다.");
    // 2026-09-08 제안 ⑥: 재개 리뷰는 직전 리뷰 턴 이후 이벤트만 받고(사이에 결정이 없었으므로 '없음'), 계획 원문 경로를 읽기 허용으로 받는다.
    expect(codex.prompts[1]).toContain("(직전 리뷰 턴 이후 새 결정·증거 없음)");
    // 경로는 별칭 plan.md 가 아니라 sha 로 검증한 정본 blob 이다(Codex 후속 지적 6).
    const planBlob = database.latestArtifact(topicId, "plan")!.path;
    expect(planBlob).toContain(join(data, "topics", topicId, "artifacts"));
    expect(codex.prompts[1]).toContain(`\`${planBlob}\` 를 읽으세요`);
    expect(codex.readablePaths.every((paths) => paths?.includes(planBlob))).toBe(true);
    expect(database.getCodexReviewPromptSequence(topicId)).toBeGreaterThan(0);
    // 수정 턴은 구현 세션을 이어 쓰므로 계획 본문 없이 SHA·경로만 받고, 전달한 sequence 가 갱신된다.
    expect(claude.fixPrompts).toHaveLength(1);
    expect(claude.fixPrompts[0]).toContain("본문은 다시 싣지 않습니다");
    expect(claude.fixPrompts[0]).not.toContain("승인된 계획:\n---");
    expect(claude.fixPrompts[0]).toContain(planSHA256);
    expect(claude.readablePaths[0]).toContain(planBlob);
    expect(flags.implementationPromptSequence).toBeGreaterThan(0);
    // 턴 사용량 통지가 없는 가짜 어댑터라도 흐름은 그대로 — 사용량 행은 선택 기록이다.
    expect(database.getTimeline(topicId).some((event) => "usage" in event.payload)).toBe(false);
    expect(reviewedTopic.branchName).toBe(`consensus/delivery-flow-${topicId.slice(0, 8)}-g1`);
    expect(flags.fixPassUsed).toBe(true);
    expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toBe(changeOnFix ? "보완 완료\n" : "첫 구현\n");
    expect(await gitService.head(worktree)).toBe(baseline);
    expect(git(worktree, ["rev-list", "--count", `${baseline}..HEAD`])).toBe("0");
    const reviewedSnapshot = await gitService.snapshot(worktree);
    expect(flags.reviewedHead).toBe(reviewedSnapshot.head);
    expect(flags.reviewedDiffSHA256).toBe(reviewedSnapshot.diffSHA256);
    expect(claude.implementationTurns).toBe(1);
    expect(claude.fixTurns).toBe(1);
    expect(codex.reviewTurns).toBe(2);

    database.claimActionRequest(topicId, "commit", "unknown-commit", {
      message: "합의된 변경", paths: ["feature.txt"],
    });
    database.recoverInterruptedDeliveryRequests();
    await expect(engine.reconcileDelivery(topicId, {
      idempotencyKey: "unknown-commit", outcome: "succeeded", oid: baseline,
    })).rejects.toThrow("커밋 전 리뷰 기준과 같아");
    await engine.reconcileDelivery(topicId, {
      idempotencyKey: "unknown-commit", outcome: "failed",
    });

    const committedOID = await engine.commit(topicId, "합의된 변경", ["feature.txt"]);
    expect(committedOID).not.toBe(baseline);
    expect(git(worktree, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("feature.txt");
    expect(git(remote, ["rev-parse", `refs/heads/${reviewedTopic.branchName}`], true)).toBeNull();

    database.claimActionRequest(topicId, "push", "unknown-push", {});
    database.recoverInterruptedDeliveryRequests();
    await expect(engine.reconcileDelivery(topicId, {
      idempotencyKey: "unknown-push", outcome: "succeeded", oid: committedOID,
    })).rejects.toThrow("원격 브랜치가 현재 커밋을 가리키지 않아");
    await engine.reconcileDelivery(topicId, {
      idempotencyKey: "unknown-push", outcome: "failed",
    });

    const pushedOID = await engine.push(topicId);
    expect(pushedOID).toBe(committedOID);
    expect(git(remote, ["rev-parse", `refs/heads/${reviewedTopic.branchName}`])).toBe(committedOID);
    database.close();
  });
});

describe("사후 검증이 거부한 커밋 처분", () => {
  it("사용자가 ./로 시작하는 경로를 골라도 커밋을 확정하고 원장에 기록한다", async () => {
    const { database, engine, worktree, topicId, reviewed } = await setupReadyToDeliver("prefix-path");

    const oid = await engine.commit(topicId, "합의된 변경", ["./feature.txt"]);

    expect(oid).not.toBe(reviewed.head);
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: oid, orphanCommitOID: null });
    expect(git(worktree, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("feature.txt");
    database.close();
  });

  it("사후 검증이 실패하면 로컬 커밋을 남기되 확정하지 않고 OID를 원장과 timeline에 기록한다", async () => {
    const { database, parentMismatchEngine, worktree, topicId, reviewed } =
      await setupReadyToDeliver("orphan-record");

    await expect(parentMismatchEngine.commit(topicId, "부모 검증이 실패하는 커밋", ["feature.txt"]))
      .rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");

    const orphanOID = git(worktree, ["rev-parse", "HEAD"]);
    expect(orphanOID).not.toBe(reviewed.head);
    expect(git(worktree, ["rev-list", "--count", `${reviewed.head}..HEAD`])).toBe("1");
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: null, orphanCommitOID: orphanOID });
    const recorded = database.getTimeline(topicId).at(-1);
    expect(recorded?.payload).toMatchObject({ orphanCommitOID: orphanOID });
    expect(recorded?.body).toContain(String(orphanOID));
    database.close();
  });

  // 거부를 만든 배선과 되돌리기 배선이 같아야 실제 상황이다. 예전 테스트는 결함을 주입한 엔진으로 고아를 만들고
  // 정상 엔진으로 되돌려, 프로덕션에서는 영구히 되돌릴 수 없는 조합을 초록으로 통과시켰다.
  it("거부를 만든 그 배선으로도 되돌려 HEAD만 부모로 돌아가고 작업 파일은 그대로 남는다", async () => {
    const { database, parentMismatchEngine, gitService, worktree, topicId, reviewed } =
      await setupReadyToDeliver("orphan-discard");
    await expect(parentMismatchEngine.commit(topicId, "부모 검증이 실패하는 커밋", ["feature.txt"]))
      .rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");
    const orphanOID = git(worktree, ["rev-parse", "HEAD"]);

    const restored = await parentMismatchEngine.discardOrphanCommit(topicId);

    expect(restored.state).toBe("READY_TO_DELIVER");
    expect(await gitService.head(worktree)).toBe(reviewed.head);
    expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toBe("리뷰를 통과한 구현\n");
    expect(git(worktree, ["diff", "--cached", "--name-only", "-z"])).toBe("");
    expect(database.getFlags(topicId).orphanCommitOID).toBeNull();
    expect(database.getTimeline(topicId).at(-1)?.payload).toMatchObject({
      discardedCommitOID: orphanOID,
      restoredHead: reviewed.head,
    });

    const oid = await parentMismatchEngine.commit(topicId, "합의된 변경", ["feature.txt"])
      .catch(() => null);
    expect(oid).toBeNull();
    const clean = await setupReadyToDeliver("orphan-discard-recommit");
    expect(await clean.engine.commit(clean.topicId, "합의된 변경", ["feature.txt"])).toBeTruthy();
    clean.database.close();
    database.close();
  });

  // 되돌리기는 거부 사유가 남긴 불일치를 전제조건으로 다시 요구하지 않아야 한다.
  it("리뷰 스냅샷 기록이 현재 상태와 어긋나도 되돌리기는 막히지 않는다", async () => {
    const { database, parentMismatchEngine, gitService, worktree, topicId, reviewed } =
      await setupReadyToDeliver("orphan-discard-drifted");
    await expect(parentMismatchEngine.commit(topicId, "부모 검증이 실패하는 커밋", ["feature.txt"]))
      .rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");
    database.updateTopic(topicId, { reviewedHead: "0".repeat(40), reviewedDiffSHA256: "f".repeat(64) });

    await parentMismatchEngine.discardOrphanCommit(topicId);

    expect(await gitService.head(worktree)).toBe(reviewed.head);
    expect(database.getFlags(topicId).orphanCommitOID).toBeNull();
    database.close();
  });

  it("HEAD만 되돌아간 반쪽 상태에서 되돌리기를 다시 승인하면 index를 마저 정리한다", async () => {
    const { database, dependencies, parentMismatchEngine, gitService, worktree, topicId, reviewed } =
      await setupReadyToDeliver("orphan-half-reset");
    await expect(parentMismatchEngine.commit(topicId, "부모 검증이 실패하는 커밋", ["feature.txt"]))
      .rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");
    const orphanOID = git(worktree, ["rev-parse", "HEAD"]);

    // update-ref는 성공하고 reset --mixed 직전에 서버가 죽은 상황.
    const halfEngine = new WorkflowEngine({
      ...dependencies, git: new ParentMismatchGitWithFailingReset(new ResetFailingRunner()),
    });
    await expect(halfEngine.discardOrphanCommit(topicId)).rejects.toThrow("index 재정렬");
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(reviewed.head);
    expect(git(worktree, ["diff", "--cached", "--name-only", "-z"])).not.toBe("");
    expect(database.getFlags(topicId).orphanCommitOID).toBe(orphanOID);

    // 다시 승인하면 남은 index만 정리하고 플래그를 닫는다. 여기서 막히면 커밋·닫기가 전부 봉쇄된다.
    const restored = await parentMismatchEngine.discardOrphanCommit(topicId);

    expect(restored.state).toBe("READY_TO_DELIVER");
    expect(await gitService.head(worktree)).toBe(reviewed.head);
    expect(git(worktree, ["diff", "--cached", "--name-only", "-z"])).toBe("");
    expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toBe("리뷰를 통과한 구현\n");
    expect(database.getFlags(topicId).orphanCommitOID).toBeNull();
    expect(database.getTimeline(topicId).at(-1)?.body).toContain("중단됐던 되돌리기");
    database.close();
  });

  it("되돌릴 조건이 어긋나면 아무것도 하지 않고 이유를 알린다", async () => {
    const { database, parentMismatchEngine, gitService, worktree, topicId } =
      await setupReadyToDeliver("orphan-guard");
    await expect(parentMismatchEngine.commit(topicId, "부모 검증이 실패하는 커밋", ["feature.txt"]))
      .rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");
    const orphanOID = git(worktree, ["rev-parse", "HEAD"]);
    git(worktree, ["commit", "--allow-empty", "-m", "사용자가 직접 만든 커밋"]);
    const movedHead = await gitService.head(worktree);

    await expect(parentMismatchEngine.discardOrphanCommit(topicId)).rejects.toThrow("현재 HEAD");

    expect(await gitService.head(worktree)).toBe(movedHead);
    expect(database.getFlags(topicId).orphanCommitOID).toBe(orphanOID);
    database.close();
  });

  it("남은 커밋을 처분하기 전에는 주제를 닫지 않는다", async () => {
    const { database, engine, parentMismatchEngine, topicId } = await setupReadyToDeliver("orphan-close");
    await expect(parentMismatchEngine.commit(topicId, "부모 검증이 실패하는 커밋", ["feature.txt"]))
      .rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");

    expect(() => engine.close(topicId)).toThrow("전달하지 못한 로컬 커밋");
    expect(database.getTopic(topicId).state).toBe("READY_TO_DELIVER");

    await parentMismatchEngine.discardOrphanCommit(topicId);

    expect(engine.close(topicId).state).toBe("CLOSED");
    database.close();
  });

  it("결과를 모르는 커밋과 push를 사용자가 성공으로 확인하면 실제 Git OID로 확정한다", async () => {
    const { database, engine, gitService, worktree, remote, branchName, topicId } =
      await setupReadyToDeliver("reconcile-success");
    git(worktree, ["add", "feature.txt"]);
    git(worktree, ["commit", "-m", "응답을 남기지 못한 커밋"]);
    const commitOID = await gitService.head(worktree);
    database.claimActionRequest(topicId, "commit", "unknown-commit", {
      message: "응답을 남기지 못한 커밋", paths: ["./feature.txt"],
    });
    database.recoverInterruptedDeliveryRequests();

    const afterCommit = await engine.reconcileDelivery(topicId, {
      idempotencyKey: "unknown-commit", outcome: "succeeded", oid: commitOID,
    });

    expect(afterCommit.state).toBe("READY_TO_DELIVER");
    expect(database.getFlags(topicId).committedOID).toBe(commitOID);

    git(worktree, ["push", "--set-upstream", "origin", branchName]);
    database.claimActionRequest(topicId, "push", "unknown-push", {});
    database.recoverInterruptedDeliveryRequests();

    const afterPush = await engine.reconcileDelivery(topicId, {
      idempotencyKey: "unknown-push", outcome: "succeeded", oid: commitOID,
    });

    expect(afterPush.state).toBe("READY_TO_DELIVER");
    expect(database.getFlags(topicId).pushedOID).toBe(commitOID);
    expect(git(remote, ["rev-parse", `refs/heads/${branchName}`])).toBe(commitOID);
    database.close();
  });
});

class EditingClaude implements AgentAdapter {
  readonly role = "claude" as const;
  implementationTurns = 0;
  fixTurns = 0;

  constructor(private readonly worktree: string, private readonly changeOnFix = true) {}

  // 구현은 계획 세션 fork가 아니라 **새 세션**으로 시작한다(2026-09-02 — fork가 물려주던 50만 토큰대
  // 계획 이력이 구현 비용의 대부분이었다). 계획 세션을 만드는 경로가 아님은 implementation 플래그로 판별한다.
  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    expect(turn.implementation).toBe(true);
    // 단계별 분리: 계획은 fable, 구현은 implementation 오버라이드(opus)를 받아야 한다(2026-08-31).
    expect(turn.settings).toEqual({ model: "opus", effort: "xhigh" });
    expect(turn.cwd).toBe(this.worktree);
    this.implementationTurns += 1;
    writeFileSync(join(this.worktree, "feature.txt"), "첫 구현\n");
    return {
      sessionId: "claude-implementation-session",
      result: result("IMPLEMENTATION", "첫 구현을 마쳤습니다."),
    };
  }

  readonly fixPrompts: string[] = [];
  readonly readablePaths: Array<readonly string[] | undefined> = [];

  async resumeTurn(turn: SessionTurn) {
    expect(turn.sessionId).toBe("claude-implementation-session");
    this.fixTurns += 1;
    this.fixPrompts.push(turn.prompt);
    this.readablePaths.push(turn.readablePaths);
    if (this.changeOnFix) writeFileSync(join(this.worktree, "feature.txt"), "보완 완료\n");
    return result("FIX", "검토 지적을 보완했습니다.", [reviewFinding("RESOLVED_BY_FIX")]);
  }

  async validateExistingSession() { return true; }
}

class ReviewingCodex implements AgentAdapter {
  readonly role = "codex" as const;
  reviewTurns = 0;
  readonly prompts: string[] = [];

  readonly sessions: string[] = [];

  async createSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    return { sessionId: "codex-code-review", result: await this.resumeTurn({ ...turn, sessionId: "codex-code-review" }) };
  }

  readonly readablePaths: Array<readonly string[] | undefined> = [];

  async resumeTurn(turn: SessionTurn) {
    this.sessions.push(turn.sessionId);
    this.prompts.push(turn.prompt);
    this.readablePaths.push(turn.readablePaths);
    this.reviewTurns += 1;
    return this.reviewTurns === 1
      ? result("REVIEW", "한 곳을 보완해야 합니다.", [reviewFinding("AGREED_ACTION")])
      : result("FINAL_REVIEW", "보완 결과를 확인했습니다.", [reviewFinding("RESOLVED_BY_FIX")]);
  }

  async validateExistingSession() { return true; }
}

function result(
  kind: AgentResult["kind"],
  summary: string,
  findings: AgentResult["findings"] = [],
): AgentResult {
  return { kind, summary, findings, evidenceRefs: ["feature.txt"] };
}

function reviewFinding(disposition: "AGREED_ACTION" | "RESOLVED_BY_FIX"): AgentResult["findings"][number] {
  return {
    id: "F-1",
    title: "보완할 동작",
    severity: "MEDIUM",
    disposition,
    rationale: disposition === "AGREED_ACTION" ? "현재 구현을 한 번 고쳐야 합니다." : "수정 결과를 확인했습니다.",
    evidenceRefs: ["feature.txt"],
    requiresUserDecision: false,
  };
}

function validPlan(): string {
  return REQUIRED_PLAN_HEADINGS.map((heading) => `## ${heading}\n\n검증할 내용${heading === "허용 오차" ? TOLERANCE_BLOCK : ""}`).join("\n\n");
}

// 허용 오차 블록은 계획 필수 요소다 — 범위 전체를 승인 경로로 두고 규칙 없음.
const TOLERANCE_BLOCK = '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';

// 부모 검증만 실패시켜 실제 git 커밋이 남은 상태를 만든다. 되돌리기 검증은 진짜 git으로 해야 하므로 엔진을 둘로 나눈다.
class ParentMismatchGit extends GitService {
  async commitParent(): Promise<string> {
    return "0".repeat(40);
  }
}

class ParentMismatchGitWithFailingReset extends ParentMismatchGit {}

// update-ref까지 끝난 뒤 index 재정렬(reset --mixed)에서만 죽는 러너 — 되돌리기가 반쪽 중단된 서버 크래시 재현.
class ResetFailingRunner extends SpawnCommandRunner {
  run(spec: Parameters<SpawnCommandRunner["run"]>[0]): ReturnType<SpawnCommandRunner["run"]> {
    if (spec.command === "git" && spec.args[0] === "reset") {
      return Promise.reject(new Error("index 재정렬 도중 서버가 종료되었습니다."));
    }
    return super.run(spec);
  }
}

function idleAdapter(role: "claude" | "codex"): AgentAdapter {
  return {
    role,
    createSession: async () => { throw new Error("이 테스트에서는 에이전트를 호출하지 않습니다."); },
    resumeTurn: async () => { throw new Error("이 테스트에서는 에이전트를 호출하지 않습니다."); },
    validateExistingSession: async () => false,
  };
}

async function setupReadyToDeliver(label: string) {
  const root = mkdtempSync(join(tmpdir(), `consensus-room-${label}-`));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const remote = join(root, "origin.git");
  const worktree = join(root, "worktrees", "topic");
  const data = join(root, "data");
  git(root, ["init", "--bare", remote]);
  git(root, ["init", "--initial-branch=develop", repository]);
  git(repository, ["config", "user.name", "Consensus Room Test"]);
  git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
  writeFileSync(join(repository, "feature.txt"), "기준\n");
  git(repository, ["add", "feature.txt"]);
  git(repository, ["commit", "-m", "baseline"]);
  git(repository, ["remote", "add", "origin", remote]);
  git(repository, ["push", "-u", "origin", "develop"]);

  const gitService = new GitService(new SpawnCommandRunner());
  await gitService.createDetachedWorktree(repository, worktree, "develop");
  const branchName = `consensus/${label}-g1`;
  await gitService.createBranch(worktree, branchName);
  writeFileSync(join(worktree, "feature.txt"), "리뷰를 통과한 구현\n");

  const database = new ConsensusDatabase(join(data, "room.sqlite"));
  const artifacts = new ArtifactStore(join(data, "topics"), database);
  const plan = validPlan();
  const planSHA256 = hashPlan(plan);
  const topicId = "11111111-2222-4333-8444-666666666666";
  const timestamp = "2026-08-23T00:00:00.000Z";
  database.createTopic({
    id: topicId,
    slug: label,
    title: "전달 사후 검증",
    repositoryPath: repository,
    baseRef: "develop",
    worktreePath: worktree,
    branchName,
    state: "READY_TO_DELIVER",
    scopeGeneration: 1,
    planRevision: 2,
    planSHA256,
    approvedPlanSHA256: planSHA256,
    createdAt: timestamp,
    updatedAt: timestamp,
    lastError: null,
  });
  await artifacts.write(topicId, "plan", 2, `${plan.trim()}\n`);
  const reviewed = await gitService.snapshot(worktree);
  database.updateTopic(topicId, {
    reviewedHead: reviewed.head, reviewedDiffSHA256: reviewed.diffSHA256,
  });
  const dependencies = {
    database, artifacts, claude: idleAdapter("claude"), codex: idleAdapter("codex"),
  };
  return {
    database,
    artifacts,
    dependencies,
    gitService,
    engine: new WorkflowEngine({ ...dependencies, git: gitService }),
    parentMismatchEngine: new WorkflowEngine({
      ...dependencies, git: new ParentMismatchGit(new SpawnCommandRunner()),
    }),
    repository,
    remote,
    worktree,
    branchName,
    topicId,
    reviewed,
  };
}

function git(cwd: string, args: string[], allowFailure = false): string | null {
  try {
    return execFileSync("git", args, {
      cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    if (allowFailure) return null;
    throw error;
  }
}

function waitForState(
  database: ConsensusDatabase,
  topicId: string,
  expected: "READY_TO_DELIVER",
): Promise<void> {
  if (database.getTopic(topicId).state === expected) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const eventName = `topic:${topicId}`;
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error(`상태 대기 실패: ${database.getTopic(topicId).state}`));
    }, 5_000);
    const listener = (event: { state: string }) => {
      if (event.state === expected) {
        cleanup();
        resolve();
      } else if (event.state === "FAILED" || event.state === "USER_DECISION_REQUIRED") {
        cleanup();
        reject(new Error(`워크플로 실패: ${database.getTopic(topicId).lastError ?? event.state}`));
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      database.events.off(eventName, listener);
    };
    database.events.on(eventName, listener);
  });
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("조건을 기다리는 동안 제한 시간을 넘었습니다.");
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

// 구현 세션 저장이 계약 검증보다 먼저다 — 검증이 턴을 거부해도 세션이 남아 재시도가 재구현 없이
// resume된다(2026-09-01 S1.1: 저장 전 거부로 수동 DB 복구가 필요했던 사건의 프로그램적 방지).
class ContractViolatingClaude implements AgentAdapter {
  readonly role = "claude" as const;
  readonly correctionPrompts: string[] = [];
  readonly correctionSettings: Array<SessionTurn["settings"]> = [];

  constructor(private readonly worktree: string) {}

  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    expect(turn.implementation).toBe(true);
    writeFileSync(join(this.worktree, "feature.txt"), "구현\n");
    return { sessionId: "claude-implementation-session", result: result("PLAN", "종류가 틀린 구현 보고") };
  }

  async resumeTurn(turn: SessionTurn) {
    expect(turn.sessionId).toBe("claude-implementation-session");
    this.correctionPrompts.push(turn.prompt);
    this.correctionSettings.push(turn.settings);
    return result("PLAN", "여전히 종류가 틀린 응답");
  }

  async validateExistingSession() { return true; }
}

describe("구현 턴 계약 위반", () => {
  it("검증이 거부해도 구현 세션은 저장되고 교정은 1회만 시도한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-impl-contract-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const remote = join(root, "origin.git");
    const worktree = join(root, "worktrees", "topic");
    const data = join(root, "data");
    git(root, ["init", "--bare", remote]);
    git(root, ["init", "--initial-branch=develop", repository]);
    git(repository, ["config", "user.name", "Consensus Room Test"]);
    git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
    writeFileSync(join(repository, "feature.txt"), "기준\n");
    git(repository, ["add", "feature.txt"]);
    git(repository, ["commit", "-m", "baseline"]);
    git(repository, ["remote", "add", "origin", remote]);
    git(repository, ["push", "-u", "origin", "develop"]);

    const gitService = new GitService(new SpawnCommandRunner());
    await gitService.createDetachedWorktree(repository, worktree, "develop");
    const database = new ConsensusDatabase(join(data, "room.sqlite"));
    const artifacts = new ArtifactStore(join(data, "topics"), database);
    const plan = validPlan();
    const planSHA256 = hashPlan(plan);
    const topicId = "99999999-2222-4333-8444-555555555555";
    const timestamp = "2026-09-01T00:00:00.000Z";
    database.createTopic({
      id: topicId,
      slug: "impl-contract",
      title: "구현 계약 위반",
      repositoryPath: repository,
      baseRef: "develop",
      worktreePath: worktree,
      branchName: null,
      state: "AWAITING_USER_APPROVAL",
      scopeGeneration: 1,
      planRevision: 2,
      planSHA256,
      approvedPlanSHA256: planSHA256,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastError: null,
    });
    database.upsertParticipant(topicId, {
      role: "claude", sessionId: "claude-plan-session", mode: "attached",
      acknowledgedPlanSHA256: planSHA256,
    });
    database.upsertParticipant(topicId, {
      role: "codex", sessionId: "codex-review-session", mode: "attached",
      acknowledgedPlanSHA256: planSHA256,
    });
    await artifacts.write(topicId, "plan", 2, `${plan.trim()}\n`);
    const claude = new ContractViolatingClaude(worktree);
    const engine = new WorkflowEngine({
      database,
      artifacts,
      git: gitService,
      claude,
      codex: {
        role: "codex",
        createSession: async () => { throw new Error("사용하지 않습니다."); },
        resumeTurn: async () => { throw new Error("사용하지 않습니다."); },
        validateExistingSession: async () => true,
      } as AgentAdapter,
    });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null, 10_000);

    expect(database.getTopic(topicId).state).toBe("FAILED");
    // 오늘의 사건 재발 방지 핵심: 거부된 턴의 세션이 DB에 남아 재시도가 resume으로 이어진다.
    expect(database.getFlags(topicId).implementationSessionId).toBe("claude-implementation-session");
    expect(claude.correctionPrompts.length).toBe(1);
    expect(claude.correctionPrompts[0]).toContain("거부 사유");
    // kind 불일치는 표기 위반이라 교정 재제출은 구현 모델 그대로, 추론만 low 로 내린다(2026-09-07 제안 ③).
    expect(claude.correctionSettings[0]).toEqual({ model: "opus", effort: "low" });
    expect(database.getTimeline(topicId).some((event) => event.body.includes("표기 교정 — 추론 low"))).toBe(true);
    database.close();
  });
});
