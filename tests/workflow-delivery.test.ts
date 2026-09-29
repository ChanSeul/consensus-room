import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, CommandResult, CommandRunner, CommandSpec, SessionTurn } from "../src/server/types";
import { ClaudeAdapter } from "../src/server/adapters/claude";
import { CodexAdapter } from "../src/server/adapters/codex";
import { ReviewBlocked } from "../src/server/reviewLedger";
import { pendingReviewRequests } from "../src/server/engine/reviewRequests";
import { WorkflowEngine } from "../src/server/workflow";
import { REQUIRED_PLAN_HEADINGS, type AgentResult } from "../src/shared/contracts";
import { EXECUTION_POLICY_NOTE, timelineEventText, timelineReference } from "../src/shared/prompts";
import { hashPlan } from "../src/shared/workflow";
import { agentRunError } from "../src/server/adapters/resultParser";

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

    // Enabling reads after approval retains the legacy first-implementation session contract.
    database.planning.enable(topicId);
    expect(database.planning.policyVersion(topicId)).toBe(1);
    expect(database.planning.continuityEnabled(topicId)).toBe(false);
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

describe("인도 커밋 사슬(C1→C2→C3) — 2026-09-21", () => {
  // S11 계획([d02] S11-A03)은 소스·flip·문서를 세 커밋으로 순서대로 인도한다. 이전 엔진은 기준을 리뷰 HEAD 로 고정해 두 번째 커밋부터
  // "worktree 가 바뀌었다" 로 거부했다(모든 이전 단계가 커밋 1회라 드러나지 않았다). 기준은 마지막 확정 커밋, 내용 불변은 리뷰 HEAD 기준이다.
  async function setupTwoFiles(label: string) {
    const ready = await setupReadyToDeliver(label);
    writeFileSync(join(ready.worktree, "second.txt"), "둘째 파일\n");
    const reviewed = await ready.gitService.snapshot(ready.worktree);   // 리뷰가 두 파일 변경을 본 상태
    ready.database.updateTopic(ready.topicId, { reviewedHead: reviewed.head, reviewedDiffSHA256: reviewed.diffSHA256 });
    return { ...ready, reviewed };
  }

  it("두 번째 커밋의 기준·부모는 첫 확정 커밋이고, 남은 변경이 없으면 세 번째는 거부되며, push 는 마지막 커밋을 보낸다", async () => {
    const { database, engine, worktree, remote, branchName, topicId, reviewed } = await setupTwoFiles("chain");
    const c1 = await engine.commit(topicId, "C1 소스", ["feature.txt"]);
    expect(git(worktree, ["rev-parse", `${c1}^`])).toBe(reviewed.head);
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c1, orphanCommitOID: null });
    const c2 = await engine.commit(topicId, "C2 둘째", ["second.txt"]);
    expect(git(worktree, ["rev-parse", `${c2}^`])).toBe(c1);
    expect(git(worktree, ["show", "--pretty=format:", "--name-only", c2])).toBe("second.txt");
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c2, pushedOID: null, orphanCommitOID: null });
    expect(database.getTimeline(topicId).at(-1)?.payload).toMatchObject({ oid: c2, parent: c1, deliveryAction: "commit" });
    await expect(engine.commit(topicId, "C3 없음", ["feature.txt"])).rejects.toThrow("커밋할 변경이 없습니다");
    const pushed = await engine.push(topicId);
    expect(pushed).toBe(c2);
    expect(git(remote, ["rev-parse", `refs/heads/${branchName}`])).toBe(c2);
    database.close();
  });

  it("첫 커밋 뒤 파일 내용이 바뀌면 두 번째 커밋은 거부된다(내용 불변은 리뷰 HEAD 기준)", async () => {
    const { database, engine, worktree, topicId } = await setupTwoFiles("chain-drift");
    const c1 = await engine.commit(topicId, "C1 소스", ["feature.txt"]);
    writeFileSync(join(worktree, "second.txt"), "리뷰 뒤 바뀐 내용\n");
    await expect(engine.commit(topicId, "C2 둘째", ["second.txt"])).rejects.toThrow("최종 리뷰 뒤 worktree가 바뀌었습니다");
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c1 });
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(c1);
    database.close();
  });

  it("첫 커밋 뒤 두 번째 커밋이 결과 기록 전에 끊겨도 복구(reconcile)는 마지막 확정 커밋을 기준으로 성공을 판정한다", async () => {
    const { database, engine, worktree, topicId } = await setupTwoFiles("chain-reconcile");
    const c1 = await engine.commit(topicId, "C1 소스", ["feature.txt"]);
    git(worktree, ["add", "--", "second.txt"]); git(worktree, ["commit", "-m", "C2 둘째(기록 전 중단)"]);
    const c2 = git(worktree, ["rev-parse", "HEAD"])!;
    database.claimActionRequest(topicId, "commit", "chain-c2", { message: "C2 둘째", paths: ["second.txt"] });
    database.recoverInterruptedDeliveryRequests();
    await expect(engine.reconcileDelivery(topicId, { idempotencyKey: "chain-c2", outcome: "succeeded", oid: c1 }))
      .rejects.toThrow("현재 HEAD와 다릅니다");
    await engine.reconcileDelivery(topicId, { idempotencyKey: "chain-c2", outcome: "succeeded", oid: c2 });
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c2, pushedOID: null });
    database.close();
  });

  it("확정 기록(committedOID) 뒤·요청 완료 기록 전에 끊긴 커밋도 복구는 요청 좌표(시작 HEAD)로 성공을 받고, 같은 메시지의 미실행 요청은 거부한다(host-review R1·R2)", async () => {
    const { database, engine, worktree, topicId } = await setupTwoFiles("chain-reconcile-confirmed");
    const c1 = await engine.commit(topicId, "C1 소스", ["feature.txt"]);
    // API 경로처럼 요청을 걸고(claim) commit() 이 시작 HEAD 를 좌표로 남긴 뒤 확정까지 됐지만 요청 완료 기록 전에 서버가 죽었다.
    database.claimActionRequest(topicId, "commit", "chain-c2-confirmed", { message: "C2 둘째\n\n본문  \n\n\n끝", paths: ["second.txt"] });
    const c2 = await engine.commit(topicId, "C2 둘째\n\n본문  \n\n\n끝", ["second.txt"], "chain-c2-confirmed");   // git 이 공백을 정리하는 메시지
    expect(database.getFlags(topicId).committedOID).toBe(c2);
    expect(database.unknownDeliveryAction(topicId)).toBeNull();
    database.recoverInterruptedDeliveryRequests();   // 서버 재시작: running → unknown
    expect(database.unknownDeliveryAction(topicId)).toMatchObject({ idempotencyKey: "chain-c2-confirmed", annotation: { parent: c1 } });
    await engine.reconcileDelivery(topicId, { idempotencyKey: "chain-c2-confirmed", outcome: "succeeded", oid: c2 });
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c2, pushedOID: null });
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(c2);
    // R2: 같은 메시지·넓은 paths 로 다음 요청을 걸고 git 실행 전에 죽었다 — 좌표(parent=c2) 와 HEAD 가 같으므로 성공이 아니다.
    database.claimActionRequest(topicId, "commit", "chain-c3-never", { message: "C2 둘째", paths: ["feature.txt", "second.txt"] });
    database.annotateActionRequest(topicId, "commit", "chain-c3-never", { parent: c2 });
    database.recoverInterruptedDeliveryRequests();
    await expect(engine.reconcileDelivery(topicId, { idempotencyKey: "chain-c3-never", outcome: "succeeded", oid: c2 }))
      .rejects.toThrow("커밋 전 리뷰 기준과 같아");
    await engine.reconcileDelivery(topicId, { idempotencyKey: "chain-c3-never", outcome: "failed" });
    // 좌표가 없는 옛 요청도 확정 기록된 HEAD 를 성공으로 인정하지 않는다(보수적).
    database.claimActionRequest(topicId, "commit", "chain-legacy", { message: "C2 둘째", paths: ["second.txt"] });
    database.recoverInterruptedDeliveryRequests();
    await expect(engine.reconcileDelivery(topicId, { idempotencyKey: "chain-legacy", outcome: "succeeded", oid: c2 }))
      .rejects.toThrow("커밋 전 리뷰 기준과 같아");
    await engine.reconcileDelivery(topicId, { idempotencyKey: "chain-legacy", outcome: "failed" });
    expect(database.getFlags(topicId).committedOID).toBe(c2);
    database.close();
  });

  it("확정 커밋 바로 뒤에 붙은 고아는 되돌려 확정 커밋으로 복귀하고, 그 뒤 정상 커밋이 사슬을 잇는다", async () => {
    const { database, engine, parentMismatchEngine, gitService, worktree, topicId } = await setupTwoFiles("chain-orphan");
    const c1 = await engine.commit(topicId, "C1 소스", ["feature.txt"]);
    // 사후 검증(부모 대조)이 거부한 커밋 — 실제 git 부모는 c1 이다.
    await expect(parentMismatchEngine.commit(topicId, "C2 고아", ["second.txt"])).rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");
    const orphan = git(worktree, ["rev-parse", "HEAD"]);
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c1, orphanCommitOID: orphan });
    const restored = await engine.discardOrphanCommit(topicId);
    expect(restored.state).toBe("READY_TO_DELIVER");
    expect(await gitService.head(worktree)).toBe(c1);
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c1, orphanCommitOID: null });
    expect(readFileSync(join(worktree, "second.txt"), "utf8")).toBe("둘째 파일\n");
    const c2 = await engine.commit(topicId, "C2 둘째", ["second.txt"]);
    expect(git(worktree, ["rev-parse", `${c2}^`])).toBe(c1);
    database.close();
  });

  it("확정 커밋 이전으로 돌아가야 하는 고아(부모가 확정 커밋이 아님)는 되돌리지 않는다", async () => {
    const { database, engine, worktree, topicId } = await setupTwoFiles("chain-orphan-deep");
    const c1 = await engine.commit(topicId, "C1 소스", ["feature.txt"]);
    git(worktree, ["add", "--", "second.txt"]); git(worktree, ["commit", "-m", "X"]);
    git(worktree, ["commit", "--allow-empty", "-m", "Y"]);
    const y = git(worktree, ["rev-parse", "HEAD"])!;
    database.updateTopic(topicId, { orphanCommitOID: y });   // 부모 X ≠ 확정 커밋 c1
    await expect(engine.discardOrphanCommit(topicId)).rejects.toThrow("이미 확정한 커밋이 있어 되돌리지 않았습니다");
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(y);
    expect(database.getFlags(topicId)).toMatchObject({ committedOID: c1, orphanCommitOID: y });
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

  it.each([false, true])("R5 답변 확인 뒤 커밋 복구가 질문을 다시 열지 않는다(half=%s)", async (half) => {
    const { database, engine, dependencies, parentMismatchEngine, topicId } = await setupReadyToDeliver("r5-recovery");
    const append = (actor: "codex" | "user" | "system", kind: "agent_output" | "decision" | "system", payload: Record<string, unknown>) =>
      database.appendEvent({ topicId, actor, kind, state: "READY_TO_DELIVER", body: "fixture", payload });
    append("codex", "agent_output", { resultKind: "FINAL_REVIEW", findings: [], requestedUserDecision: "배포 승인?" });
    const request = pendingReviewRequests(database.getTimeline(topicId), 1)[0];
    append("user", "decision", {});
    const decision = database.getTimeline(topicId).at(-1)!.sequence;
    append("system", "system", { reviewRequestAnswers: [{ requestId: request.id, decisionSequence: decision }], reviewAnswersThrough: decision });
    await expect(parentMismatchEngine.commit(topicId, "orphan", ["feature.txt"])).rejects.toThrow("부모가 최종 리뷰 기준과 다릅니다");
    if (half) {
      const halfEngine = new WorkflowEngine({ ...dependencies, git: new ParentMismatchGitWithFailingReset(new ResetFailingRunner()) });
      await expect(halfEngine.discardOrphanCommit(topicId)).rejects.toThrow("index 재정렬");
    }
    await parentMismatchEngine.discardOrphanCommit(topicId);
    expect(pendingReviewRequests(database.getTimeline(topicId), 1)).toEqual([]);
    expect(await engine.commit(topicId, "recovered", ["feature.txt"])).toBeTruthy();
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
    // 계획 설정과 별개로 구현은 승인된 기본값 Sonnet 5.5를 받아야 한다.
    expect(turn.settings).toEqual({ model: "claude-sonnet-5-5", effort: "xhigh" });
    expect(turn.cwd).toBe(this.worktree);
    this.implementationTurns += 1;
    writeFileSync(join(this.worktree, "feature.txt"), "첫 구현\n");
    return {
      sessionId: "claude-implementation-session",
      result: { ...result("IMPLEMENTATION", "첫 구현을 마쳤습니다."), status: "completed" as const },   // 정상 완료 — 완료 선언 계약(status 필수)
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
    return { ...result("FIX", "검토 지적을 보완했습니다.", [reviewFinding("RESOLVED_BY_FIX")]), status: "completed" as const };
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
    expect(claude.correctionSettings[0]).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(database.getTimeline(topicId).some((event) => event.body.includes("표기 교정 — 추론 low"))).toBe(true);
    database.close();
  });
});

// ---- E3-2-2b 구현·수정·코드 리뷰 턴의 타임라인 쪽 ----
// 공개 흐름(엔진 구현·수정·리뷰 + 실제 실행기 + 러너 대역)으로 본다. 러너의 파일 읽기는 관측할 수 없으므로 필수 참조(결정·범위 변경) 원문은 호스트가
// 과제 프롬프트에 쪽으로 싣고, 정상 반환한 호출이 실제로 보낸 판의 쪽만 반환된 세션에 인정한다. 쪽은 프롬프트에서 표식으로 되읽어 원문과 대조한다.
const WORK_PAGE = 48 * 1024;
const REVIEW_PAGE = 96 * 1024;

type PagedStep = {
  noChange?: boolean;
  remainingSteps?: string[];
  status?: "completed" | "in_progress" | null;
  // resume 중 CLI 가 알린 다른 세션 id(비연속 주제에서만 허용된 경로), create 면 만들 세션 id.
  sessionId?: string;
  missing?: boolean;
  fail?: string;
  latch?: Promise<void>;
  // 사용자 결정을 청한다(열린 요청이 된다).
  requestedUserDecision?: string;
  // 프롬프트의 열린 요청 id 를 모두 해소했다고 답한다.
  resolveRequests?: boolean;
  // 이 호출이 보고하는 입력 토큰 사용량(예산 강제 검사용).
  inputTokens?: number;
};
type PagedCall = { method: "create" | "resume"; sessionId: string | null; operation: string; prompt: string; readablePaths: readonly string[] };

class PagingClaude implements AgentAdapter {
  readonly role = "claude" as const;
  readonly calls: PagedCall[] = [];
  private kind: "IMPLEMENTATION" | "FIX" = "IMPLEMENTATION";
  private created = 0;
  constructor(private readonly worktree: string, readonly steps: PagedStep[] = []) {}

  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    const step = this.begin("create", null, turn);
    await step.latch;
    if (step.fail) throw new Error(step.fail);
    const sessionId = step.sessionId ?? `claude-s${++this.created}`;
    turn.onSessionCreated?.(sessionId);
    return { sessionId, result: this.result(step, turn.prompt) };
  }

  async resumeTurn(turn: SessionTurn) {
    const step = this.begin("resume", turn.sessionId, turn);
    await step.latch;
    // 관측된 세션 유실 형태(E3-3b — 폴백은 문구가 아니라 어댑터 분류 session-missing 으로만 열린다).
    if (step.missing) throw agentRunError("claude", 1, `No conversation found with session ID: ${turn.sessionId}\n`,
      JSON.stringify({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, session_id: turn.sessionId }));
    if (step.fail) throw new Error(step.fail);
    if (step.sessionId) turn.onSessionCreated?.(step.sessionId);
    return this.result(step, turn.prompt);
  }

  async validateExistingSession() { return true; }

  private begin(method: PagedCall["method"], sessionId: string | null, turn: Omit<SessionTurn, "sessionId">): PagedStep {
    const operation = turn.job?.operation ?? "";
    if (operation === "implement") this.kind = "IMPLEMENTATION";
    if (operation === "fix") this.kind = "FIX";
    this.calls.push({ method, sessionId, operation, prompt: turn.prompt, readablePaths: turn.readablePaths ?? [] });
    const step = this.steps.shift() ?? {};
    if (step.inputTokens) turn.onUsage?.({ inputTokens: step.inputTokens, recordKind: "final" });
    return step;
  }

  private result(step: PagedStep, prompt: string): AgentResult {
    if (!step.noChange) writeFileSync(join(this.worktree, "feature.txt"), `구현 ${this.calls.length}\n`);
    const status = step.status === undefined ? "completed" as const : step.status;
    const base = this.kind === "FIX"
      ? result("FIX", "검토 지적을 보완했습니다.", [reviewFinding("RESOLVED_BY_FIX")])
      : result("IMPLEMENTATION", "구현했습니다.");
    const requests = step.resolveRequests ? [...prompt.matchAll(/^- \[([^\]]+)\] /gm)].map((match) => match[1]) : [];
    return {
      ...base, ...(status ? { status } : {}), ...(status === "in_progress" ? { remainingSteps: step.remainingSteps ?? ["남은 구현"] } : {}),
      ...(step.requestedUserDecision ? { requestedUserDecision: step.requestedUserDecision } : {}),
      ...(requests.length ? { resolvesRequestedDecision: true, resolvedRequestIds: requests } : {}),
    };
  }
}

class PagingCodex implements AgentAdapter {
  readonly role = "codex" as const;
  readonly calls: PagedCall[] = [];
  // invalidFirst: 첫 리뷰 응답이 계약을 어긴다(종류 오류) — 교정이 필요하다.
  constructor(private readonly withFinding: boolean, private readonly invalidFirst = false) {}

  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    this.calls.push({ method: "create", sessionId: null, operation: turn.job?.operation ?? "", prompt: turn.prompt, readablePaths: turn.readablePaths ?? [] });
    await turn.beforeSpawn?.();
    turn.admitSync?.();
    turn.onProcessSpawn?.({ pid: 4545, pgid: 4545, executable: "fake-codex", commandLine: "fake-codex", startedAt: new Date().toISOString() });
    return { sessionId: "codex-paged-review", result: this.review(turn.job?.operation) };
  }

  async resumeTurn(turn: SessionTurn) {
    this.calls.push({ method: "resume", sessionId: turn.sessionId, operation: turn.job?.operation ?? "", prompt: turn.prompt, readablePaths: turn.readablePaths ?? [] });
    await turn.beforeSpawn?.();
    turn.admitSync?.();
    turn.onProcessSpawn?.({ pid: 4545, pgid: 4545, executable: "fake-codex", commandLine: "fake-codex", startedAt: new Date().toISOString() });
    return this.review(turn.job?.operation);
  }

  async validateExistingSession() { return true; }

  // 리뷰 읽기 호출(E3-4c)은 ACK 만 답한다. 판정 호출의 순서는 읽기 호출을 빼고 센다.
  private review(operation: string | undefined): AgentResult {
    if (operation === "review-read") return result("ACK", "리뷰 읽기 쪽을 받았습니다.");
    const judged = this.calls.filter((call) => call.operation !== "review-read").length;
    if (this.invalidFirst && judged === 1) return result("PLAN", "종류를 잘못 적은 리뷰");
    if (!this.withFinding) return result("REVIEW", "문제 없습니다.");
    return judged === 1
      ? result("REVIEW", "한 곳을 보완해야 합니다.", [reviewFinding("AGREED_ACTION")])
      : result("FINAL_REVIEW", "보완 결과를 확인했습니다.", [reviewFinding("RESOLVED_BY_FIX")]);
  }
}

// 구버전의 교정 대기본 복구 검증용: 당시 계약 교정은 별도 리뷰 예약에 막혔다. 현재 예약 정책에 기대지 않고 그 호출 경계의
// 거부를 한 번 재현한다. 대기본 생성·저장·문맥 대조·재개는 모두 실제 엔진이 수행한다.
function legacyPausedReview(topicId: string): PagingCodex {
  return new class extends PagingCodex {
    private paused = false;
    override async resumeTurn(turn: SessionTurn) {
      if (!this.paused && turn.job?.operation === "contract-correction") {
        this.paused = true;
        throw new ReviewBlocked(topicId, "implementation");
      }
      return super.resumeTurn(turn);
    }
  }(false, true);
}

type PageMark = { selector: string; offset: number; end: number; total: number; text: string };
function pagesIn(prompt: string): PageMark[] {
  return [...prompt.matchAll(/--- 쪽 (timeline:\d+@[0-9a-f]{64}) \[(\d+), (\d+)\) \/ (\d+) ---\n([\s\S]*?)\n--- 쪽 끝 ---/g)].map((match) => ({
    selector: match[1], offset: Number(match[2]), end: Number(match[3]), total: Number(match[4]), text: match[5],
  }));
}

// 한국어 결정 본문(글자당 3바이트) — seed 로 원문(해시)을 구별한다.
function koreanDecision(chars: number, seed: string): string {
  const alphabet = "가나다라마바사아자차카타파하";
  let body = "";
  for (let index = 0; body.length < chars; index += 1) body += alphabet[(index * 7 + seed.charCodeAt(0)) % alphabet.length];
  return body;
}

async function pagedTopic(label: string, decisions: readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), `consensus-room-pages-${label}-`));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const worktree = join(root, "worktrees", "topic");
  const data = join(root, "data");
  git(root, ["init", "--initial-branch=develop", repository]);
  git(repository, ["config", "user.name", "Consensus Room Test"]);
  git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
  writeFileSync(join(repository, "feature.txt"), "기준\n");
  git(repository, ["add", "feature.txt"]);
  git(repository, ["commit", "-m", "baseline"]);
  const gitService = new GitService(new SpawnCommandRunner());
  await gitService.createDetachedWorktree(repository, worktree, "develop");
  const databasePath = join(data, "room.sqlite");
  let database = new ConsensusDatabase(databasePath);
  let artifacts = new ArtifactStore(join(data, "topics"), database);
  const plan = validPlan();
  const planSHA256 = hashPlan(plan);
  const topicId = "e3220b00-2222-4333-8444-555555555555";
  const timestamp = "2026-09-26T00:00:00.000Z";
  database.createTopic({
    id: topicId, slug: `pages-${label}`, title: "타임라인 쪽", repositoryPath: repository, baseRef: "develop", worktreePath: worktree,
    branchName: null, state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 2, planSHA256, approvedPlanSHA256: planSHA256,
    createdAt: timestamp, updatedAt: timestamp, lastError: null,
  });
  database.upsertParticipant(topicId, { role: "claude", sessionId: "claude-plan-session", mode: "attached", acknowledgedPlanSHA256: planSHA256 });
  database.upsertParticipant(topicId, { role: "codex", sessionId: "codex-plan-session", mode: "attached", acknowledgedPlanSHA256: planSHA256 });
  await artifacts.write(topicId, "plan", 2, `${plan.trim()}\n`);
  const events = decisions.map((body) => database.appendEvent({ topicId, actor: "user", kind: "decision", state: "AWAITING_USER_APPROVAL", body }));
  const references = events.map((event) => ({ reference: timelineReference(event), text: timelineEventText(event) }));
  const topic = { id: topicId, scopeGeneration: 1 };
  return {
    topicId, topic, worktree, references, get database() { return database; }, get artifacts() { return artifacts; },
    engine: (claude: AgentAdapter, codex: AgentAdapter, enforceBudgets = false) =>
      new WorkflowEngine({ database, artifacts, git: gitService, claude, codex, enforceBudgets }),
    reopen: () => {
      database.close();
      database = new ConsensusDatabase(databasePath);
      artifacts = new ArtifactStore(join(data, "topics"), database);
    },
    idle: () => waitUntil(() => database.runningAction(topicId) === null, 20_000),
  };
}

// 한 참조로 간 쪽을 offset 순으로 이어 붙이면 원문인지(빈틈·겹침 없이).
function joined(pages: readonly PageMark[], selector: string): string {
  const own = pages.filter((page) => page.selector === selector).sort((left, right) => left.offset - right.offset);
  own.forEach((page, index) => { if (index > 0) expect(page.offset).toBe(own[index - 1].end); });
  return own.map((page) => page.text).join("");
}

const pageBytes = (pages: readonly PageMark[]) => pages.reduce((sum, page) => sum + page.end - page.offset, 0);
const RECHECK = "이미 만든 결과를 그 결정과 다시 대조해";

describe("E3-2-2b 타임라인 쪽 — 구현·수정·코드 리뷰", () => {
  it("구현: 한국어 50,000자 결정이 첫 턴·계속 진행 쪽으로 나뉘어 원문과 같고, 완독 전 완료는 재대조 계속 진행이며, 한 리뷰 호출 예산을 넘는 리뷰는 판정 전 읽기 호출로 나눠 실은 뒤 한 번 판정한다", async () => {
    const decision = koreanDecision(50_000, "a");
    const room = await pagedTopic("impl", [decision]);
    const { reference, text } = room.references[0];
    expect(reference.bytes).toBeGreaterThan(3 * WORK_PAGE);
    const claude = new PagingClaude(room.worktree);
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    // 첫 턴(create, 전체 판) + 완독 게이트의 계속 진행 3회. 러너는 매번 completed 를 보고했지만 필수 구간이 남은 동안은 채택하지 않았다.
    expect(claude.calls.map((call) => `${call.method}:${call.operation}`)).toEqual(["create:implement", "resume:continue", "resume:continue", "resume:continue"]);
    const pages = claude.calls.map((call) => pagesIn(call.prompt));
    pages.forEach((own) => expect(pageBytes(own)).toBeLessThanOrEqual(WORK_PAGE));
    expect(joined(pages.flat(), reference.selector)).toBe(text);
    expect(pages[0][0].offset).toBe(0);
    expect(claude.calls.slice(1).every((call) => call.prompt.includes(RECHECK))).toBe(true);
    expect(claude.calls[0].prompt).toContain(`[참조·필수] selector=${reference.selector}`);
    // 참조 원문 파일은 읽기 허용 경로로만 준다 — 그 경로가 있어도 인정·완료 판정에 쓰이지 않았다(위 계속 진행 3회).
    const referencesFile = room.database.latestArtifact(room.topicId, "timeline-references")!.path;
    expect(claude.calls.every((call) => call.readablePaths.includes(referencesFile))).toBe(true);
    expect(readFileSync(referencesFile, "utf8")).toContain(text);
    expect(claude.calls[0].prompt).toContain("파일 읽기를 전달·완독 근거로 쓰지 않습니다");
    expect(room.database.planning.referenceComplete("claude-s1", room.topic, reference)).toBe(true);
    // 구현 채택(구현 보고 산출물)은 마지막 쪽을 받은 뒤다.
    const accepted = room.database.getTimeline(room.topicId).find((event) => event.state === "CODEX_REVIEW")!;
    const lastContinuation = room.database.getTimeline(room.topicId).filter((event) => event.payload?.timelineRecheck).at(-1)!;
    expect(accepted.sequence).toBeGreaterThan(lastContinuation.sequence);

    // 코드 리뷰(새 세션)의 필수 구간 150,000B 는 한 호출 예산(96KiB)을 넘는다 — E3-4c 전에는 호출 전에 멈췄다(timelineReviewExceeded). 이제 판정 전 리뷰 읽기
    // 호출(도구 없음·ACK)이 앞부분 쪽을 싣고, 남은 쪽이 한 호출에 드는 마지막 호출이 그 쪽과 함께 한 번 판정한다. 둘은 같은 원장으로 리뷰 1회만 쓴다.
    expect(codex.calls.map((call) => `${call.method}:${call.operation}`)).toEqual(["create:review-read", "resume:review"]);
    const reviewPages = codex.calls.map((call) => pagesIn(call.prompt));
    reviewPages.forEach((own) => expect(pageBytes(own)).toBeLessThanOrEqual(REVIEW_PAGE));
    expect(reviewPages[0][0].offset).toBe(0);
    expect(pageBytes(reviewPages[0])).toBeGreaterThanOrEqual(REVIEW_PAGE - 3);
    expect(joined(reviewPages.flat(), reference.selector)).toBe(text);
    expect(room.database.planning.referenceComplete("codex-paged-review", room.topic, reference)).toBe(true);
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    expect(room.database.latestArtifact(room.topicId, "codex-review")).not.toBeNull();
    expect(room.database.reviews.account(room.topicId, "implementation").used).toBe(1);
    expect(room.database.getTimeline(room.topicId).some((event) => event.payload?.timelineReviewExceeded)).toBe(false);

    // 실제 패킷(J4): 과제 문자열 + 어댑터가 앞에 붙이는 실행 정책 지시문. 작업 공간 지시문(CLAUDE.md·AGENTS.md)·메모리는 저장소마다 더해진다.
    const policy = Buffer.byteLength(EXECUTION_POLICY_NOTE) + 2;
    console.log(`E3-2-2b packet implementation ${JSON.stringify(claude.calls.map((call, index) => ({
      call: `${call.method}:${call.operation}`, promptBytes: Buffer.byteLength(call.prompt), withPolicyNote: Buffer.byteLength(call.prompt) + policy,
      pageBytes: pageBytes(pages[index]),
    })))}`);
    room.database.close();
  });

  // E3-4b: 필수 읽기 턴은 계속 진행 상한(4)을 쓰지 않는다 — 첫 턴 + 4회의 쪽 합(245,760B)을 넘는 필수 결정도 한 액션에서 끝까지 읽고 채택한다.
  it("필수 읽기 분리: 첫 턴 + 계속 진행 4회의 쪽 합보다 큰 필수 결정도 한 액션에서 끝까지 읽고, 쪽마다 인정된 바이트만큼 진척해 채택한다", async () => {
    const room = await pagedTopic("limit", [koreanDecision(50_000, "b"), koreanDecision(50_000, "c")]);
    const [first, second] = room.references;
    const total = first.reference.bytes + second.reference.bytes;
    expect(total).toBeGreaterThan(5 * WORK_PAGE);
    const claude = new PagingClaude(room.worktree);
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    const pages = claude.calls.map((call) => pagesIn(call.prompt));
    // 첫 턴 뒤는 모두 필수 읽기 턴 — 같은 세션, 쪽 ≤ 48KiB, 마지막 앞의 쪽은 예산을 채운다(UTF-8 경계로 최대 3바이트 줄어듦). 중복 쪽 없이 원문 그대로.
    expect(claude.calls.slice(1).every((call) => call.method === "resume" && call.sessionId === "claude-s1" && call.prompt.includes(RECHECK))).toBe(true);
    pages.forEach((own) => expect(pageBytes(own)).toBeLessThanOrEqual(WORK_PAGE));
    pages.slice(0, -1).forEach((own) => expect(pageBytes(own)).toBeGreaterThanOrEqual(WORK_PAGE - 3));
    expect(pageBytes(pages.flat())).toBe(total);
    expect(joined(pages.flat(), first.reference.selector)).toBe(first.text);
    expect(joined(pages.flat(), second.reference.selector)).toBe(second.text);
    const readings = room.database.getTimeline(room.topicId).filter((event) => typeof event.payload?.readingTurn === "number");
    expect(readings.map((event) => event.payload?.readingTurn)).toEqual(claude.calls.slice(1).map((_, index) => index + 1));
    expect(readings.length).toBeGreaterThan(4);
    expect(claude.calls.at(-1)!.prompt).toContain(`(필수 읽기 ${readings.length}회차)`);
    expect(claude.calls.slice(1).some((call) => /계속 진행 \d+\/4/.test(call.prompt))).toBe(false);
    expect(room.database.getTimeline(room.topicId).some((event) => event.payload?.continuationExhausted || event.payload?.readingStalled)).toBe(false);
    expect(room.database.planning.referenceComplete("claude-s1", room.topic, first.reference)).toBe(true);
    expect(room.database.planning.referenceComplete("claude-s1", room.topic, second.reference)).toBe(true);
    expect(room.database.latestArtifact(room.topicId, "implementation")).not.toBeNull();
    room.database.close();
  });

  it("진척 게이트: 필수 읽기 턴의 응답이 다른 세션 id 로 돌아와 작업 세션의 미인정 구간이 줄지 않으면 보존·명시 정지하고, DB 를 다시 연 뒤 재시도는 같은 세션에서 남은 쪽을 잇는다", async () => {
    const room = await pagedTopic("stalled", [koreanDecision(50_000, "g")]);
    const { reference, text } = room.references[0];
    // 셋째 호출이 생기면 진척 게이트가 반복을 끊지 못한 것이다(같은 쪽을 다시 싣는 무한 반복) — 실패로 드러낸다.
    const claude = new PagingClaude(room.worktree, [{}, { sessionId: "claude-s1-forked" }, { fail: "진척 없는 필수 읽기 반복" }]);
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(claude.calls.map((call) => `${call.method}:${call.sessionId}`)).toEqual(["create:null", "resume:claude-s1"]);
    const stalledPages = pagesIn(claude.calls[1].prompt);
    expect(stalledPages[0]).toMatchObject({ offset: WORK_PAGE });
    // 반환 세션(forked)에는 인정됐지만 작업 세션의 공백은 그대로다.
    expect(room.database.planning.referenceGaps("claude-s1-forked", room.topic, reference)).toEqual([
      { offset: 0, end: WORK_PAGE }, { offset: stalledPages[0].end, end: reference.bytes }]);
    expect(room.database.planning.referenceGaps("claude-s1", room.topic, reference)).toEqual([{ offset: WORK_PAGE, end: reference.bytes }]);
    expect(room.database.getTopic(room.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(room.database.getFlags(room.topicId).resumeState).toBe("IMPLEMENTING");
    const stop = room.database.getTimeline(room.topicId).filter((event) => event.payload?.timelineUnread).at(-1)!;
    expect(stop.payload?.readingStalled).toBe(true);
    expect(stop.payload?.continuationExhausted).toBeUndefined();
    expect(stop.payload?.timelineUnread).toEqual({ references: [reference.selector], bytes: reference.bytes - WORK_PAGE });
    expect(room.database.latestArtifact(room.topicId, "implementation")).toBeNull();
    expect(codex.calls).toHaveLength(0);

    claude.steps.length = 0;
    room.reopen();
    room.engine(claude, codex).retry(room.topicId);
    await room.idle();
    const retried = claude.calls.slice(2);
    expect(retried.every((call) => call.method === "resume" && call.sessionId === "claude-s1")).toBe(true);
    expect(pagesIn(retried[0].prompt)[0]).toMatchObject({ offset: WORK_PAGE });
    const own = [...pagesIn(claude.calls[0].prompt), ...retried.flatMap((call) => pagesIn(call.prompt))];
    expect(joined(own, reference.selector)).toBe(text);
    expect(room.database.planning.referenceComplete("claude-s1", room.topic, reference)).toBe(true);
    expect(room.database.latestArtifact(room.topicId, "implementation")).not.toBeNull();
    room.database.close();
  });

  it("진척이 있으면 네 번을 넘어 같은 세션에서 계속하고 완료 후 한 번만 리뷰한다", async () => {
    const room = await pagedTopic("progress-cap", [koreanDecision(50_000, "h"), koreanDecision(50_000, "i")]);
    const claude = new PagingClaude(room.worktree, Array.from({ length: 6 }, () => ({ status: "in_progress" as const })));
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(claude.calls).toHaveLength(7);
    expect(claude.calls.slice(1).every(call => call.sessionId === "claude-s1")).toBe(true);
    expect(claude.calls.slice(1).every((call) => call.prompt.includes("status=in_progress 였습니다(계속 진행") && !call.prompt.includes(RECHECK))).toBe(true);
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    expect(codex.calls.filter(call => call.operation === "review")).toHaveLength(1);
    expect(room.database.getTimeline(room.topicId).some((event) => typeof event.payload?.readingTurn === "number")).toBe(false);
    expect(room.database.latestArtifact(room.topicId, "implementation")).not.toBeNull();
    room.database.close();
  });

  it("같은 결과를 반복하고 파일 변경과 필수 읽기 진척이 없으면 보존 후 멈춘다", async () => {
    const room = await pagedTopic("no-progress", []);
    const claude = new PagingClaude(room.worktree, Array.from({ length: 4 }, () => ({ status: "in_progress" as const, noChange: true })));
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();
    expect(claude.calls).toHaveLength(3);
    expect(room.database.getTopic(room.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(room.database.getTimeline(room.topicId).at(-1)!.payload?.continuationStalled).toBe(true);
    expect(room.database.latestArtifact(room.topicId, "implementation-progress")).not.toBeNull();
    expect(room.database.latestArtifact(room.topicId, "implementation")).toBeNull();
    expect(codex.calls).toHaveLength(0); room.database.close();
  });

  it("파일을 바꾸지 않는 조사도 남은 작업이 줄어들면 같은 세션에서 계속한다", async () => {
    const room = await pagedTopic("investigation-progress", []);
    const claude = new PagingClaude(room.worktree, [
      { status: "in_progress", remainingSteps: ["A 확인", "B 확인", "C 확인", "최종 확인"] },
      { status: "in_progress", noChange: true, remainingSteps: ["B 확인", "C 확인", "최종 확인"] },
      { status: "in_progress", noChange: true, remainingSteps: ["C 확인", "최종 확인"] },
      { status: "in_progress", noChange: true, remainingSteps: ["최종 확인"] },
      { status: "completed", noChange: true },
    ]);
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();
    expect(claude.calls).toHaveLength(5);
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    expect(codex.calls.filter(call => call.operation === "review")).toHaveLength(1);
    room.database.close();
  });

  it("섞임: in_progress 계속 진행 2회 + 필수 읽기 턴은 합쳐 4회를 넘어도 상한 정지 없이 끝까지 읽고 채택한다", async () => {
    const room = await pagedTopic("mixed", [koreanDecision(50_000, "j"), koreanDecision(50_000, "k")]);
    const [first, second] = room.references;
    // 순서: 첫 턴 in_progress → 계속 진행 1 → 필수 읽기 1·2 → 필수 읽기 3 이 in_progress → 계속 진행 2 → 남은 필수 읽기. 필수 읽기가 in_progress 계수를 쓰면
    // 계속 진행 2 앞에서 상한(4)에 닿는다.
    const claude = new PagingClaude(room.worktree, [{ status: "in_progress" }, {}, {}, {}, { status: "in_progress" }]);
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    const timeline = room.database.getTimeline(room.topicId);
    expect(timeline.filter((event) => typeof event.payload?.continuation === "number").map((event) => event.payload?.continuation)).toEqual([1, 2]);
    const readings = timeline.filter((event) => typeof event.payload?.readingTurn === "number");
    expect(readings.length).toBeGreaterThanOrEqual(3);
    expect(2 + readings.length).toBeGreaterThan(4);
    expect(timeline.some((event) => event.payload?.continuationExhausted || event.payload?.readingStalled)).toBe(false);
    const pages = claude.calls.flatMap((call) => pagesIn(call.prompt));
    expect(joined(pages, first.reference.selector)).toBe(first.text);
    expect(joined(pages, second.reference.selector)).toBe(second.text);
    expect(room.database.latestArtifact(room.topicId, "implementation")).not.toBeNull();
    room.database.close();
  });

  it("예산: 필수 읽기 턴 도중 예산이 바닥나면 기존 예산 정지로 멈추고, 이미 인정된 구간은 보존된다", async () => {
    const room = await pagedTopic("budget", [koreanDecision(50_000, "l"), koreanDecision(50_000, "m")]);
    const [first, second] = room.references;
    const policy = { execution: { inputTokens: 1_000, outputTokens: 1_000_000, durationMs: 10_000_000 },
      total: { inputTokens: 30, outputTokens: 10_000_000, durationMs: 100_000_000 } };
    room.database.budgets.configure(room.topicId, policy, "test");
    const claude = new PagingClaude(room.worktree, Array.from({ length: 10 }, () => ({ inputTokens: 10 })));
    const codex = new PagingCodex(false);
    room.engine(claude, codex, true).startImplementation(room.topicId);
    await room.idle();

    // 호출마다 10 토큰 — 셋째 호출 뒤 누적 예산(30)이 바닥나 넷째 필수 읽기 턴은 열리지 않는다(허용 검사가 spawn 전에 막는다).
    expect(claude.calls).toHaveLength(3);
    expect(room.database.getTopic(room.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(room.database.getTimeline(room.topicId).some((event) => event.payload?.budgetPause)).toBe(true);
    expect(room.database.getTimeline(room.topicId).some((event) => event.payload?.continuationExhausted || event.payload?.readingStalled)).toBe(false);
    const acknowledged = [first, second].reduce((sum, { reference }) => sum + reference.bytes - room.database.planning.referenceGaps("claude-s1", room.topic, reference)
      .reduce((own, gap) => own + gap.end - gap.offset, 0), 0);
    expect(acknowledged).toBe(pageBytes(claude.calls.flatMap((call) => pagesIn(call.prompt))));
    expect(room.database.latestArtifact(room.topicId, "implementation")).toBeNull();
    room.database.close();
  });

  it("첫 호출 취소(늦은 resolve 포함)는 인정하지 않고, 재시도가 같은 구간을 처음부터 다시 싣는다", async () => {
    const room = await pagedTopic("cancel", [koreanDecision(30_000, "d")]);
    const { reference } = room.references[0];
    let release!: () => void;
    const latch = new Promise<void>((resolve) => { release = resolve; });
    const claude = new PagingClaude(room.worktree, [{ latch }]);
    const codex = new PagingCodex(false);
    const engine = room.engine(claude, codex);
    engine.startImplementation(room.topicId);
    await waitUntil(() => claude.calls.length === 1);
    engine.stop(room.topicId);
    // 취소 뒤에 늦게 끝난 응답 — 버려지고 인정되지 않는다.
    release();
    await room.idle();
    expect(room.database.planning.referenceGaps("claude-s1", room.topic, reference)).toEqual([{ offset: 0, end: reference.bytes }]);
    // 세션 id 는 생성 알림(onSessionCreated)으로 이미 저장됐다 — 재시도는 그 세션을 resume 하되, 인정이 없으므로 같은 구간을 다시 싣는다.
    expect(room.database.getFlags(room.topicId).implementationSessionId).toBe("claude-s1");

    engine.retry(room.topicId);
    await room.idle();
    const cancelled = pagesIn(claude.calls[0].prompt);
    const retried = pagesIn(claude.calls[1].prompt);
    expect(claude.calls[1]).toMatchObject({ method: "resume", sessionId: "claude-s1" });
    expect(retried).toEqual(cancelled);
    expect(retried[0].offset).toBe(0);
    expect(room.database.planning.referenceComplete("claude-s1", room.topic, reference)).toBe(true);
    room.database.close();
  });

  it("세션 유실 폴백의 새 세션은 fresh 판(offset 0부터)의 쪽만 인정받고 옛 세션 인정을 이어받지 않는다", async () => {
    const room = await pagedTopic("fallback", [koreanDecision(50_000, "e")]);
    const { reference, text } = room.references[0];
    const claude = new PagingClaude(room.worktree, [{}, { fail: "네트워크 오류" }, { missing: true }, { sessionId: "claude-fallback" }]);
    const codex = new PagingCodex(false);
    const engine = room.engine(claude, codex);
    engine.startImplementation(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("FAILED");
    expect(room.database.planning.referenceGaps("claude-s1", room.topic, reference)).toEqual([{ offset: WORK_PAGE, end: reference.bytes }]);

    engine.retry(room.topicId);
    await room.idle();
    // 재시도: resume 판(옛 세션 인정 뒤부터) → 세션 유실 → 폴백 create 는 fresh 판(처음부터).
    expect(claude.calls[2]).toMatchObject({ method: "resume", sessionId: "claude-s1" });
    expect(pagesIn(claude.calls[2].prompt)[0].offset).toBe(WORK_PAGE);
    expect(claude.calls[3].method).toBe("create");
    const fresh = pagesIn(claude.calls[3].prompt);
    expect(fresh[0]).toMatchObject({ offset: 0, end: WORK_PAGE });
    // 옛 세션 인정은 그대로(폴백 턴의 쪽이 옛 세션에 가지 않았다), 새 세션은 자기 쪽으로만 완독한다.
    expect(room.database.planning.referenceGaps("claude-s1", room.topic, reference)).toEqual([{ offset: WORK_PAGE, end: reference.bytes }]);
    const fallbackPages = claude.calls.slice(3).flatMap((call) => pagesIn(call.prompt));
    expect(claude.calls.slice(4).every((call) => call.sessionId === "claude-fallback")).toBe(true);
    expect(joined(fallbackPages, reference.selector)).toBe(text);
    expect(room.database.planning.referenceComplete("claude-fallback", room.topic, reference)).toBe(true);
    room.database.close();
  });

  it("resume 중 CLI 가 세션 id 를 바꾸면 resume 판 쪽만 새 세션에 인정하고, 다음 호출은 첫 공백부터 싣되 공백 뒤 인정 구간은 다시 싣지 않는다", async () => {
    const room = await pagedTopic("changed-id", [koreanDecision(50_000, "f")]);
    const { reference, text } = room.references[0];
    const claude = new PagingClaude(room.worktree, [{}, { fail: "네트워크 오류" }, { sessionId: "claude-s1-forked" }]);
    const codex = new PagingCodex(false);
    const engine = room.engine(claude, codex);
    engine.startImplementation(room.topicId);
    await room.idle();
    engine.retry(room.topicId);
    await room.idle();

    expect(claude.calls[2]).toMatchObject({ method: "resume", sessionId: "claude-s1" });
    // 보낸 것은 resume 판([48KiB, 96KiB)) — created=true 여도 fresh 판으로 추정하지 않는다.
    expect(pagesIn(claude.calls[2].prompt).map((page) => [page.offset, page.end])).toEqual([[WORK_PAGE, 2 * WORK_PAGE]]);
    expect(claude.calls.slice(3).every((call) => call.sessionId === "claude-s1-forked")).toBe(true);
    expect(claude.calls.slice(3).map((call) => pagesIn(call.prompt).map((page) => page.offset))).toEqual([[0], [2 * WORK_PAGE], [3 * WORK_PAGE]]);
    const forked = claude.calls.slice(2).flatMap((call) => pagesIn(call.prompt));
    expect(joined(forked, reference.selector)).toBe(text);
    expect(room.database.planning.referenceComplete("claude-s1-forked", room.topic, reference)).toBe(true);
    expect(room.database.planning.referenceGaps("claude-s1", room.topic, reference)).toEqual([{ offset: WORK_PAGE, end: reference.bytes }]);
    room.database.close();
  });

  it("쪽 크기가 다르거나 겹친 인정 구간은 합집합으로 계산해 건너뛰거나 두 번 싣지 않는다(2a 조각 + 2b 쪽이 같은 세션에 섞인 경우)", async () => {
    const room = await pagedTopic("overlap", [koreanDecision(40_000, "g")]);
    const { reference, text } = room.references[0];
    const header = Buffer.byteLength(text) - 3 * 40_000;
    const at = (chars: number) => header + 3 * chars;
    const seeded = [[0, at(300)], [at(100), at(1000)], [at(3000), at(6000)]] as const;
    room.database.setImplementationSession(room.topicId, "claude-seeded");
    room.database.planning.acknowledgeReferenceReads("claude-seeded", room.topic,
      [{ selector: reference.selector, hash: reference.hash, offset: seeded[0][0], nextOffset: seeded[0][1], total: reference.bytes }]);
    room.database.planning.acknowledgeReferencePages("claude-seeded", room.topic, seeded.slice(1).map(([offset, end]) =>
      ({ selector: reference.selector, hash: reference.hash, offset, end, total: reference.bytes })));
    const claude = new PagingClaude(room.worktree);
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(claude.calls[0]).toMatchObject({ method: "resume", sessionId: "claude-seeded" });
    const sent = claude.calls.flatMap((call) => pagesIn(call.prompt));
    expect(sent[0]).toMatchObject({ offset: at(1000), end: at(3000) });
    expect(sent[1].offset).toBe(at(6000));
    // 보낸 쪽끼리도, 이미 인정된 구간과도 겹치지 않고, 합치면 원문 전체다.
    const ranges = [...seeded.map(([offset, end]) => ({ offset, end })), ...sent.map(({ offset, end }) => ({ offset, end }))];
    for (const page of sent) {
      expect(ranges.filter((range) => range.offset < page.end && page.offset < range.end)).toHaveLength(1);
    }
    const bytes = Buffer.from(text);
    for (const page of sent) expect(page.text).toBe(bytes.subarray(page.offset, page.end).toString("utf8"));
    expect(pageBytes(sent) + at(1000) + (at(6000) - at(3000))).toBe(reference.bytes);
    expect(room.database.planning.referenceComplete("claude-seeded", room.topic, reference)).toBe(true);
    room.database.close();
  });

  it.each([false, true])("리뷰는 예산 안이면 한 호출에 필수 쪽을 모두 싣고, 수정 턴은 같은 세션이면 이어 싣고 새 세션이면 처음부터 싣는다(수정 세션 유실: %s)", async (fixSessionLost) => {
    const room = await pagedTopic(fixSessionLost ? "fix-fresh" : "fix-same", [koreanDecision(30_000, "h")]);
    const { reference, text } = room.references[0];
    const claude = new PagingClaude(room.worktree, [{}, {}, ...(fixSessionLost ? [{ missing: true }, { sessionId: "claude-fix-fresh" }] : [])]);
    const codex = new PagingCodex(true);
    room.engine(claude, codex).startImplementation(room.topicId);
    await waitForState(room.database, room.topicId, "READY_TO_DELIVER");
    await room.idle();

    // 코드 리뷰(새 세션): 필수 90,000B 가 한 호출에 모두 실리고 반환 뒤 리뷰 세션에 인정된다. 최종 리뷰(같은 세션)는 다시 싣지 않는다.
    expect(codex.calls.map((call) => call.method)).toEqual(["create", "resume"]);
    const reviewPages = pagesIn(codex.calls[0].prompt);
    expect(joined(reviewPages, reference.selector)).toBe(text);
    expect(pageBytes(reviewPages)).toBeLessThanOrEqual(REVIEW_PAGE);
    expect(room.database.planning.referenceComplete("codex-paged-review", room.topic, reference)).toBe(true);
    expect(pagesIn(codex.calls[1].prompt)).toEqual([]);
    const referencesFile = room.database.latestArtifact(room.topicId, "timeline-references")!.path;
    expect(codex.calls[0].readablePaths).toContain(referencesFile);

    const fixCalls = claude.calls.filter((call, index) => index >= 2);
    expect(fixCalls[0]).toMatchObject({ method: "resume", sessionId: "claude-s1", operation: "fix" });
    if (!fixSessionLost) {
      // 같은 구현 세션은 이미 완독했다 — 다시 싣지 않는다.
      expect(fixCalls.flatMap((call) => pagesIn(call.prompt))).toEqual([]);
      expect(fixCalls).toHaveLength(1);
    } else {
      // 새 수정 세션(폴백)은 처음부터 싣고 완독 뒤에만 채택된다.
      expect(fixCalls[1].method).toBe("create");
      expect(pagesIn(fixCalls[1].prompt)[0].offset).toBe(0);
      expect(joined(fixCalls.slice(1).flatMap((call) => pagesIn(call.prompt)), reference.selector)).toBe(text);
      expect(room.database.planning.referenceComplete("claude-fix-fresh", room.topic, reference)).toBe(true);
    }
    const reviewPolicy = Buffer.byteLength(EXECUTION_POLICY_NOTE) + 2;
    console.log(`E3-2-2b packet review ${JSON.stringify(codex.calls.map((call) => ({
      call: call.method, promptBytes: Buffer.byteLength(call.prompt), withPolicyNote: Buffer.byteLength(call.prompt) + reviewPolicy, pageBytes: pageBytes(pagesIn(call.prompt)),
    })))}`);
    room.database.close();
  });

  it("완료 확인 턴(읽기 전용 프로토콜 턴)은 쪽을 싣지 않고, 기존 렌더에서 20,000자로 잘린 결정은 인정하지 않아 확인 뒤 완료를 게이트가 계속 진행으로 잇는다", async () => {
    const room = await pagedTopic("confirm", [koreanDecision(30_000, "i")]);
    const { reference, text } = room.references[0];
    const claude = new PagingClaude(room.worktree, [{ status: null }, {}]);
    const codex = new PagingCodex(false);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(claude.calls.map((call) => call.operation)).toEqual(["implement", "completion-confirmation", "continue"]);
    expect(pagesIn(claude.calls[1].prompt)).toEqual([]);
    expect(claude.calls[1].prompt).not.toContain("타임라인 쪽");
    // 확인 턴 뒤의 계속 진행은 첫 턴이 인정받은 구간 뒤부터다(확인 턴이 인정을 더하거나 지우지 않았다).
    expect(pagesIn(claude.calls[2].prompt)[0].offset).toBe(WORK_PAGE);
    expect(joined(claude.calls.flatMap((call) => pagesIn(call.prompt)), reference.selector)).toBe(text);
    room.database.close();
  });
});

describe("E3-2-2b host-review 1차 보완(55f3795 F001~F003)", () => {
  it("F001: 응답 수신 경계에서 의무 기록이 실패하면 커서도 전진하지 않아, DB 를 다시 연 재시도가 남은 필수 원문을 끝까지 실은 뒤에만 구현을 채택한다", async () => {
    const room = await pagedTopic("f001", [koreanDecision(50_000, "j")]);
    const { reference, text } = room.references[0];
    const claude = new PagingClaude(room.worktree);
    const codex = new PagingCodex(false);
    const failing = vi.spyOn(room.database.planning, "rememberSessionReferences").mockImplementationOnce(() => {
      throw new Error("참조 의무 INSERT 실패");
    });
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();
    expect(failing).toHaveBeenCalledTimes(1);
    expect(room.database.getTopic(room.topicId).state).toBe("FAILED");
    // 의무를 적지 못한 응답은 커서를 옮기지 않았다.
    expect(room.database.getFlags(room.topicId).implementationPromptSequence ?? null).toBeNull();

    room.reopen();
    room.engine(claude, codex).retry(room.topicId);
    await room.idle();
    const retried = claude.calls.slice(1);
    expect(retried[0]).toMatchObject({ method: "resume", sessionId: "claude-s1", operation: "implement" });
    const pages = retried.flatMap((call) => pagesIn(call.prompt));
    expect(joined(pages, reference.selector)).toBe(text);
    // 소비 경계: 구현 채택(CODEX_REVIEW 전이)은 마지막 쪽을 받은 계속 진행 뒤다.
    const timeline = room.database.getTimeline(room.topicId);
    const accepted = timeline.find((event) => event.state === "CODEX_REVIEW")!;
    expect(accepted.sequence).toBeGreaterThan(timeline.filter((event) => event.payload?.timelineRecheck).at(-1)!.sequence);
    expect(room.database.planning.referenceComplete("claude-s1", room.topic, reference)).toBe(true);
    room.database.close();
  });

  it.each([13, 0])("F002: 저장된 완료+열린 요청의 확인 턴 — 뒤에 20,000자 근거 %i건. 앞부분 절단으로 놓친 짧은 결정은 게이트가 쪽으로 실은 뒤에만 채택하고, 온전히 실린 결정은 추가 쓰기 턴 없이 채택한다", async (evidenceCount) => {
    const room = await pagedTopic(`f002-${evidenceCount}`, []);
    const claude = new PagingClaude(room.worktree, [{ requestedUserDecision: "버튼 색을 정해 주세요." }, { resolveRequests: true }]);
    const codex = new PagingCodex(false);
    const engine = room.engine(claude, codex);
    engine.startImplementation(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("USER_DECISION_REQUIRED");

    const decisionBody = "결정 F002: 버튼 색은 파랑으로 한다.";
    const decision = room.database.appendEvent({ topicId: room.topicId, actor: "user", kind: "decision", state: "USER_DECISION_REQUIRED", body: decisionBody });
    for (let index = 0; index < evidenceCount; index += 1) {
      room.database.appendEvent({ topicId: room.topicId, actor: "user", kind: "evidence", state: "USER_DECISION_REQUIRED",
        body: `근거 ${index} ${"가".repeat(20_000)}` });
    }
    const reference = timelineReference(decision);
    engine.retry(room.topicId);
    await room.idle();

    const operations = claude.calls.map((call) => call.operation);
    expect(operations.slice(0, 2)).toEqual(["implement", "completion-confirmation"]);
    if (evidenceCount === 0) {
      // 확인 턴이 결정을 온전히 실었다 — 정상 확인 응답 뒤 그 전달을 인정하고, 쓰기 턴 없이 채택한다(기존 읽기 전용 확인 경로 유지).
      expect(claude.calls[1].prompt).toContain(decisionBody);
      expect(operations).toEqual(["implement", "completion-confirmation"]);
      expect(room.database.planning.referenceComplete("claude-s1", room.topic, reference)).toBe(true);
      expect(room.database.getTimeline(room.topicId).some((event) => event.state === "CODEX_REVIEW")).toBe(true);
      room.database.close();
      return;
    }
    // 전제: 읽기 전용 확인 턴(기존 렌더)은 앞부분을 잘라 짧은 결정을 싣지 못했다.
    expect(claude.calls[1].prompt).not.toContain(decisionBody);
    // 완료 게이트가 그 결정을 쪽으로 실어 계속 진행을 열고, 받은 뒤에만 채택했다.
    expect(operations[2]).toBe("continue");
    const pages = pagesIn(claude.calls[2].prompt);
    expect(joined(pages, reference.selector)).toBe(timelineEventText(decision));
    expect(claude.calls[2].prompt).toContain(RECHECK);
    expect(room.database.planning.referenceComplete("claude-s1", room.topic, reference)).toBe(true);
    const timeline = room.database.getTimeline(room.topicId);
    const accepted = timeline.find((event) => event.state === "CODEX_REVIEW")!;
    expect(accepted.sequence).toBeGreaterThan(timeline.filter((event) => event.payload?.timelineRecheck).at(-1)!.sequence);
    room.database.close();
  });

  it("F003: 리뷰 교정 대기본이 있어도 작업 트리가 바뀌어 새 프롬프트·쪽이 실제로 전달됐으면 반환 뒤 인정하고 리뷰를 저장한다", async () => {
    const room = await pagedTopic("f003", [koreanDecision(30_000, "k")]);
    const { reference, text } = room.references[0];
    const claude = new PagingClaude(room.worktree);
    const codex = legacyPausedReview(room.topicId);
    room.database.reviews.configure(room.topicId,"implementation",3,room.database.reviews.account(room.topicId,"implementation").version);
    for (const id of ["pre-1", "pre-2"]) room.database.reviews.admit(room.topicId, id, "implementation");
    const engine = room.engine(claude, codex, true);
    engine.startImplementation(room.topicId);
    await room.idle();
    // 구버전의 교정 예약 거부를 재현해 실제 엔진이 교정 대기본을 저장하게 한다.
    expect(codex.calls).toHaveLength(1);
    expect(engine.reviewPaused(room.topicId)).toBe("implementation");
    expect(await room.artifacts.readLatest(room.topicId, "pending-contract-repair")).toContain("codex-paged-review");

    // 작업 트리가 바뀌어(교정 문맥 키가 달라짐) 대기본을 이어 쓰지 않고 새 리뷰 프롬프트가 나간다.
    writeFileSync(join(room.worktree, "feature.txt"), "리뷰 대기 중 바뀐 작업 트리\n");
    room.database.reviews.grant(room.topicId, "implementation", "f003-more", room.database.reviews.account(room.topicId, "implementation").version);
    engine.retry(room.topicId);
    await room.idle();
    expect(codex.calls).toHaveLength(2);
    expect(codex.calls[1]).toMatchObject({ method: "resume", sessionId: "codex-paged-review" });
    expect(joined(pagesIn(codex.calls[1].prompt), reference.selector)).toBe(text);
    // 소비 경계: 실제로 전달된 쪽은 인정되고 리뷰가 저장돼 전달 준비까지 간다.
    expect(room.database.planning.referenceComplete("codex-paged-review", room.topic, reference)).toBe(true);
    expect(room.database.latestArtifact(room.topicId, "codex-review")).not.toBeNull();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    room.database.close();
  });

  it("F003 대조: 같은 트리·바인딩·세션이라 core.turn 이 교정 대기본을 실제로 이어 쓰면 이번 쪽은 보내지 않았으므로 인정하지 않고 리뷰도 저장하지 않으며, 다음 새 호출이 쪽을 싣는다", async () => {
    const room = await pagedTopic("f003-reuse", [koreanDecision(30_000, "l")]);
    const { reference, text } = room.references[0];
    const claude = new PagingClaude(room.worktree);
    const codex = legacyPausedReview(room.topicId);
    room.database.reviews.configure(room.topicId,"implementation",3,room.database.reviews.account(room.topicId,"implementation").version);
    for (const id of ["pre-1", "pre-2"]) room.database.reviews.admit(room.topicId, id, "implementation");
    const engine = room.engine(claude, codex, true);
    engine.startImplementation(room.topicId);
    await room.idle();
    expect(engine.reviewPaused(room.topicId)).toBe("implementation");
    const grant = (id: string) => room.database.reviews.grant(room.topicId, "implementation", id, room.database.reviews.account(room.topicId, "implementation").version);

    // 작업 트리·바인딩·세션이 그대로라 대기본을 이어 쓴다 — 두 번째 Codex 호출은 교정 요청이고 리뷰 프롬프트·쪽이 아니다.
    grant("reuse-1");
    engine.retry(room.topicId);
    await room.idle();
    expect(codex.calls).toHaveLength(2);
    expect(pagesIn(codex.calls[1].prompt)).toEqual([]);
    expect(room.database.planning.referenceGaps("codex-paged-review", room.topic, reference)).toEqual([{ offset: 0, end: reference.bytes }]);
    expect(room.database.latestArtifact(room.topicId, "codex-review")).toBeNull();
    expect(room.database.getTopic(room.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(room.database.getTimeline(room.topicId).at(-1)!.payload?.timelineReviewUnread).toEqual([reference.selector]);

    // 대기본을 다 쓴 뒤의 재시도는 새 리뷰 프롬프트로 쪽을 싣고, 반환 뒤 인정·저장한다.
    // 교정은 같은 리뷰 횟수에 포함되므로 앞서 추가한 새 리뷰 1회가 그대로 남아 있다.
    engine.retry(room.topicId);
    await room.idle();
    expect(codex.calls).toHaveLength(3);
    expect(joined(pagesIn(codex.calls[2].prompt), reference.selector)).toBe(text);
    expect(room.database.planning.referenceComplete("codex-paged-review", room.topic, reference)).toBe(true);
    expect(room.database.latestArtifact(room.topicId, "codex-review")).not.toBeNull();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    room.database.close();
  });
});

// ---- E3-4c 코드 리뷰 다중 호출 원장 ----
// 공개 흐름(엔진 구현 → 코드 리뷰 + 실제 실행기·예산 래퍼 + 러너 대역)으로 본다. 리뷰 좌석 대역은 호출마다 job·세션·설정·원장 ID(SessionTurn.reviewLedger)를
// 기록하고, 실제 CLI 처럼 준비(beforeSpawn·admitSync) → spawn → 응답 순서를 따른다(spawn 전 실패는 onProcessSpawn 없이 던진다).
type LedgerStep = {
  // 판정·읽기 호출의 응답을 바꾼다(없으면 읽기 = ACK, 판정 = 문제 없는 REVIEW·FINAL_REVIEW, 답변 확인 = 모든 질문에 마지막 결정으로 답함).
  result?: AgentResult;
  // resume 중 CLI 가 알린 다른 세션 id, create 면 만들 세션 id.
  sessionId?: string;
  missing?: boolean;
  // spawn 뒤 실패.
  fail?: string;
  // spawn 전(준비 단계) 실패 — 예산 래퍼는 이 호출이 실행되지 않은 것으로 본다.
  failBeforeSpawn?: string;
};
type LedgerCall = PagedCall & { protocolOnly: boolean; settings: SessionTurn["settings"]; reviewLedger: string | undefined };

const codexMissing = (sessionId: string) => agentRunError("codex", 1,
  `Error: thread/resume: thread/resume failed: no rollout found for thread id ${sessionId} (code -32600)\n`, "");

// 리뷰 답변 확인 대역 — 입력의 질문 전부에 마지막 결정으로 답하고, 판정할 결정은 모두 구현 변경 요구 아님으로 적는다.
function answerAll(prompt: string): AgentResult {
  const input = JSON.parse(prompt.split("REVIEW_ANSWER_INPUT\n")[1].split("\nEND_REVIEW_ANSWER_INPUT")[0]) as {
    requests: Array<{ id: string }>; decisions: Array<{ sequence: number }>; answerEvidence: Array<{ sequence: number }> };
  const last = Math.max(...[...input.decisions, ...input.answerEvidence].map((decision) => decision.sequence));
  return { kind: "REVIEW", summary: "답변을 확인했습니다.", status: "completed", findings: [], evidenceRefs: [],
    reviewDecisionAnswers: input.requests.map((request) => ({ requestId: request.id, decisionSequence: last })),
    decisionAssessments: input.decisions.map((decision) => ({ decisionSequence: decision.sequence, changesImplementation: false })) };
}

class LedgerCodex implements AgentAdapter {
  readonly role = "codex" as const;
  readonly calls: LedgerCall[] = [];
  private created = 0;
  constructor(readonly steps: LedgerStep[] = []) {}

  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    const step = await this.begin("create", null, turn);
    const sessionId = step.sessionId ?? `codex-ledger-${++this.created}`;
    turn.onSessionCreated?.(sessionId);
    if (step.fail) throw new Error(step.fail);
    return { sessionId, result: this.reply(step, turn) };
  }

  async resumeTurn(turn: SessionTurn) {
    const step = await this.begin("resume", turn.sessionId, turn);
    if (step.missing) throw codexMissing(turn.sessionId);
    if (step.fail) throw new Error(step.fail);
    if (step.sessionId) turn.onSessionCreated?.(step.sessionId);
    return this.reply(step, turn);
  }

  async validateExistingSession() { return true; }

  // 판정 호출(review·final-review)만 — 읽기 호출·답변 확인은 판정이 아니다.
  judgments(): LedgerCall[] { return this.calls.filter((call) => call.operation === "review" || call.operation === "final-review"); }

  private async begin(method: PagedCall["method"], sessionId: string | null, turn: Omit<SessionTurn, "sessionId">): Promise<LedgerStep> {
    this.calls.push({ method, sessionId, operation: turn.job?.operation ?? "", prompt: turn.prompt, readablePaths: turn.readablePaths ?? [],
      protocolOnly: Boolean(turn.protocolOnly), settings: turn.settings, reviewLedger: turn.reviewLedger });
    const step = this.steps.shift() ?? {};
    if (step.failBeforeSpawn) throw new Error(step.failBeforeSpawn);
    await turn.beforeSpawn?.();
    turn.admitSync?.();
    turn.onProcessSpawn?.({ pid: 4343, pgid: 4343, executable: "fake-codex", commandLine: "fake-codex", startedAt: new Date().toISOString() });
    return step;
  }

  private reply(step: LedgerStep, turn: Omit<SessionTurn, "sessionId">): AgentResult {
    if (step.result) return step.result;
    const operation = turn.job?.operation;
    if (operation === "review-read") return result("ACK", "리뷰 읽기 쪽을 받았습니다.");
    if (operation === "answer-confirmation") return answerAll(turn.prompt);
    return result(operation === "final-review" ? "FINAL_REVIEW" : "REVIEW", "문제 없습니다.");
  }
}

// 두 한국어 결정(각 150,000B 대) — 리뷰 필수 구간이 한 호출 예산(96KiB)의 세 배를 넘는다.
async function largeReviewRoom(label: string) {
  const room = await pagedTopic(label, [koreanDecision(50_000, "p"), koreanDecision(50_000, "q")]);
  const total = room.references.reduce((sum, { reference }) => sum + reference.bytes, 0);
  expect(total).toBeGreaterThan(3 * REVIEW_PAGE);
  return { room, total };
}

// 넉넉한 예산(예산 래퍼의 예약·되돌림 경로를 켠다).
function generousBudget(room: Awaited<ReturnType<typeof pagedTopic>>) {
  room.database.budgets.configure(room.topicId, { execution: { inputTokens: 1e9, outputTokens: 1e9, durationMs: 1e9 },
    total: { inputTokens: 1e10, outputTokens: 1e10, durationMs: 1e10 } }, "test");
}

const reviewUsed = (room: Awaited<ReturnType<typeof pagedTopic>>) => room.database.reviews.account(room.topicId, "implementation").used;
const operationsOf = (calls: readonly LedgerCall[]) => calls.map((call) => `${call.method}:${call.operation}`);

describe("E3-4c 코드 리뷰 다중 호출 원장", () => {
  it("한 호출 예산을 넘는 필수 자료는 판정 전 리뷰 읽기 호출(도구 없음·ACK·설정 상속)로 끝까지 싣고 판정은 한 번이며, 논리 리뷰 전체가 원장 ID 하나로 리뷰 1회만 쓴다", async () => {
    const { room, total } = await largeReviewRoom("ledger-reads");
    const [first, second] = room.references;
    const claude = new PagingClaude(room.worktree);
    const codex = new LedgerCodex();
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    const reads = codex.calls.slice(0, -1);
    const judgment = codex.calls.at(-1)!;
    expect(operationsOf(codex.calls)).toEqual(["create:review-read", "resume:review-read", "resume:review-read", "resume:review"]);
    // 읽기 호출: 프로토콜 턴(도구·읽기 경로 없음), 리뷰 경로의 모델·추론 설정을 그대로 쓴다(확인 턴처럼 낮추지 않는다), 판정 없이 ACK.
    for (const read of reads) {
      expect(read).toMatchObject({ protocolOnly: true, readablePaths: [] });
      expect(read.settings).toEqual(judgment.settings);
      expect(read.prompt).toContain("kind 는 ACK");
      expect(read.prompt).not.toContain("승인된 계획");
    }
    expect(judgment.settings?.effort).not.toBe("low");
    expect(judgment.protocolOnly).toBe(false);
    expect(reads.map((read, index) => read.prompt.includes(`리뷰 읽기 ${index + 1}회차`))).toEqual([true, true, true]);
    // 쪽: 호출마다 ≤ 96KiB, 읽기 호출은 예산을 채우고(UTF-8 경계로 최대 3바이트 줄어듦) 판정 호출이 나머지를 싣는다. 중복·누락 없이 원문 그대로.
    const pages = codex.calls.map((call) => pagesIn(call.prompt));
    pages.forEach((own) => expect(pageBytes(own)).toBeLessThanOrEqual(REVIEW_PAGE));
    pages.slice(0, -1).forEach((own) => expect(pageBytes(own)).toBeGreaterThanOrEqual(REVIEW_PAGE - 3));
    expect(pageBytes(pages.flat())).toBe(total);
    expect(joined(pages.flat(), first.reference.selector)).toBe(first.text);
    expect(joined(pages.flat(), second.reference.selector)).toBe(second.text);
    // 판정 호출은 읽기 호출이 만든 세션을 잇지만 그 세션은 쪽만 받았으므로 전문 판(계획 본문)을 보낸다.
    expect(judgment).toMatchObject({ method: "resume", sessionId: "codex-ledger-1" });
    expect(judgment.prompt).toContain("승인된 계획:\n---");
    // 원장: 네 호출이 같은 ID 로 예약해 리뷰는 1회, 판정 뒤 완료로 닫혔다. 커서·완료 산출물은 완료 판정 뒤에만.
    const ledger = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(codex.calls.map((call) => call.reviewLedger)).toEqual(codex.calls.map(() => ledger.id));
    expect(ledger).toMatchObject({ status: "completed", reads: 3, createdSessions: ["codex-ledger-1"], kind: "codex-review" });
    expect(reviewUsed(room)).toBe(1);
    expect(room.database.getCodexReviewPromptSequence(room.topicId)).not.toBeNull();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    const timeline = room.database.getTimeline(room.topicId);
    expect(timeline.filter((event) => typeof event.payload?.reviewReadingTurn === "number").map((event) => event.payload?.reviewReadingTurn)).toEqual([1, 2, 3]);
    // ACK 는 리뷰 산출물이 아니다 — codex agent_output 은 판정 하나뿐이다(리뷰 요청·재확인 해제가 이 기록을 센다).
    expect(timeline.filter((event) => event.actor === "codex" && event.kind === "agent_output").map((event) => event.payload?.resultKind)).toEqual(["REVIEW"]);
    expect(room.database.planning.referenceComplete("codex-ledger-1", room.topic, first.reference)).toBe(true);
    expect(room.database.planning.referenceComplete("codex-ledger-1", room.topic, second.reference)).toBe(true);
    room.database.close();
  });

  it.each([["읽기 호출", 1], ["판정 호출", 3]] as const)("%s이 실패한 뒤 DB 를 다시 열고 재시도하면 같은 원장·같은 예약으로 남은 구간부터 잇고, 판정은 한 번이다", async (_label, failAt) => {
    const { room, total } = await largeReviewRoom(`ledger-reopen-${failAt}`);
    const claude = new PagingClaude(room.worktree);
    const steps: LedgerStep[] = Array.from({ length: failAt }, () => ({}));
    const codex = new LedgerCodex([...steps, { fail: "네트워크 오류" }]);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("FAILED");
    const ledger = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(ledger).toMatchObject({ status: "open", reads: failAt });
    expect(reviewUsed(room)).toBe(1);
    expect(room.database.latestArtifact(room.topicId, "codex-review")).toBeNull();
    const failed = codex.calls.at(-1)!;

    room.reopen();
    room.engine(claude, codex).retry(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    const retried = codex.calls.slice(failAt + 1);
    // 실패한 호출의 쪽은 인정되지 않았다 — 재시도의 첫 호출이 같은 구간을 다시 싣고, 그 앞 구간은 다시 싣지 않는다.
    expect(pagesIn(retried[0].prompt).map((page) => [page.selector, page.offset, page.end])).toEqual(
      pagesIn(failed.prompt).map((page) => [page.selector, page.offset, page.end]));
    const delivered = [...codex.calls.slice(0, failAt), ...retried].flatMap((call) => pagesIn(call.prompt));
    expect(pageBytes(delivered)).toBe(total);
    // 모든 호출이 같은 원장이고 예약은 한 번, 반환된 판정은 한 번이다.
    expect(new Set(codex.calls.map((call) => call.reviewLedger))).toEqual(new Set([ledger.id]));
    expect(reviewUsed(room)).toBe(1);
    expect(codex.judgments().length).toBe(failAt === 3 ? 2 : 1);
    expect(room.database.getTimeline(room.topicId).filter((event) => event.actor === "codex" && event.kind === "agent_output")).toHaveLength(1);
    expect(room.database.planning.reviewLedger(ledger.id)).toMatchObject({ status: "completed", reads: 3 });
    room.database.close();
  });

  it("세션 유실은 code-review 계보 복구로 같은 원장을 잇는다 — 새 세션은 처음부터 다시 읽고 추가 호출은 같은 원장 ID·같은 예약에 쌓인다", async () => {
    const { room } = await largeReviewRoom("ledger-recovery");
    const [first, second] = room.references;
    const claude = new PagingClaude(room.worktree);
    const codex = new LedgerCodex([{}, { missing: true }]);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    expect(operationsOf(codex.calls.slice(0, 3))).toEqual(["create:review-read", "resume:review-read", "create:review-read"]);
    const recovered = codex.calls.slice(2);
    expect(recovered.every((call, index) => index === 0 || call.sessionId === "codex-ledger-2")).toBe(true);
    expect(pagesIn(recovered[0].prompt)[0].offset).toBe(0);
    const fresh = recovered.flatMap((call) => pagesIn(call.prompt));
    expect(joined(fresh, first.reference.selector)).toBe(first.text);
    expect(joined(fresh, second.reference.selector)).toBe(second.text);
    const lineage = room.database.planning.storedRecoveryLineage(room.topicId, "code-review")!;
    expect(lineage.recoveries).toEqual([expect.objectContaining({ fromSession: "codex-ledger-1", toSession: "codex-ledger-2", reason: "session-missing" })]);
    const ledger = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(new Set(codex.calls.map((call) => call.reviewLedger))).toEqual(new Set([ledger.id]));
    expect(ledger).toMatchObject({ status: "completed", createdSessions: ["codex-ledger-1", "codex-ledger-2"] });
    expect(reviewUsed(room)).toBe(1);
    expect(codex.judgments()).toHaveLength(1);
    expect(codex.judgments()[0].prompt).toContain("승인된 계획:\n---");
    expect(room.database.planning.referenceComplete("codex-ledger-2", room.topic, first.reference)).toBe(true);
    room.database.close();
  });

  it.each([true, false])("원장의 호출이 spawn 한 뒤에는 뒤 호출이 spawn 전에 실패해도 예약을 되돌리지 않는다 — 첫 spawn 전 실패만 호출 단위로 되돌린다(앞선 spawn: %s)", async (spawnedBefore) => {
    const { room } = await largeReviewRoom(`ledger-release-${spawnedBefore}`);
    generousBudget(room);
    const claude = new PagingClaude(room.worktree);
    const codex = new LedgerCodex(spawnedBefore ? [{}, { failBeforeSpawn: "CLI 준비 실패" }] : [{ failBeforeSpawn: "CLI 준비 실패" }]);
    room.engine(claude, codex, true).startImplementation(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("FAILED");
    const ledger = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(ledger.spawned).toBe(spawnedBefore);
    expect(reviewUsed(room)).toBe(spawnedBefore ? 1 : 0);

    // 재시도는 같은 원장으로 잇는다 — 되돌린 예약은 다시 잡고, 남은 예약은 새로 세지 않는다.
    room.reopen();
    room.engine(claude, codex, true).retry(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    expect(new Set(codex.calls.map((call) => call.reviewLedger))).toEqual(new Set([ledger.id]));
    expect(reviewUsed(room)).toBe(1);
    expect(room.database.planning.reviewLedger(ledger.id)).toMatchObject({ status: "completed", spawned: true });
    room.database.close();
  });

  it("검토 tree 가 바뀌면 새 논리 리뷰다 — 새 원장 ID 로 다시 예약하고, 세션이 이미 인정받은 쪽은 다시 싣지 않는다", async () => {
    const { room } = await largeReviewRoom("ledger-new-tree");
    const claude = new PagingClaude(room.worktree);
    const codex = new LedgerCodex([{}, { fail: "네트워크 오류" }]);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();
    const before = room.database.planning.latestReviewLedger(room.topicId)!;
    const firstRead = pagesIn(codex.calls[0].prompt);

    writeFileSync(join(room.worktree, "feature.txt"), "리뷰 대기 중 바뀐 작업 트리\n");
    room.engine(claude, codex).retry(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    const after = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(after.id).not.toBe(before.id);
    expect(after.reviewedTree).not.toBe(before.reviewedTree);
    expect(codex.calls.slice(2).every((call) => call.reviewLedger === after.id)).toBe(true);
    expect(reviewUsed(room)).toBe(2);
    expect(room.database.planning.reviewLedger(before.id)?.status).toBe("open");
    // 같은 세션의 인정 구간은 원장과 무관하다 — 새 원장의 첫 호출은 첫 읽기 호출이 인정받은 구간 뒤부터 싣는다.
    expect(codex.calls[2].sessionId).toBe("codex-ledger-1");
    expect(pagesIn(codex.calls[2].prompt)[0].offset).toBe(firstRead.at(-1)!.end);
    room.database.close();
  });

  it.each([false, true])("완료 리뷰에 구현자의 다음 작업을 적었으면 같은 세션에서 보고만 교정하고 수정·재검토까지 자동 진행한다 (최종 리뷰: %s)", async (finalPass) => {
    const room = await pagedTopic(`review-completion-${finalPass}`, []);
    const claude = new PagingClaude(room.worktree);
    const first: AgentResult = { ...result("REVIEW", "검토 완료, 확정 결함을 수정해야 합니다.", [reviewFinding("AGREED_ACTION")]), status: "completed" };
    const final: AgentResult = { ...result("FINAL_REVIEW", "수정을 확인했습니다.", [reviewFinding("RESOLVED_BY_FIX")]), status: "completed" };
    const confused = { ...(finalPass ? final : first), remainingSteps: ["구현자가 확정 지적을 수정하고 해당 부분만 재검토합니다."] };
    const codex = new LedgerCodex(finalPass
      ? [{ result: first }, { result: confused }, { result: final }]
      : [{ result: confused }, { result: first }, { result: final }]);
    room.engine(claude, codex, true).startImplementation(room.topicId);
    await room.idle();

    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    expect(claude.calls.map(call => call.operation)).toEqual(["implement", "fix"]);
    expect(operationsOf(codex.calls)).toEqual(finalPass
      ? ["create:review", "resume:final-review", "resume:contract-correction"]
      : ["create:review", "resume:contract-correction", "resume:final-review"]);
    expect(codex.calls.slice(1).every(call => call.sessionId === "codex-ledger-1")).toBe(true);
    expect(reviewUsed(room)).toBe(2); // 보고 교정은 원래 리뷰 원장에 속하며 새 전체 리뷰를 사지 않는다.
    const correction = codex.calls.find(call => call.operation === "contract-correction")!;
    expect(correction.prompt).toContain("리뷰어가 아직 검토하지 못한 작업");
    expect(correction.settings).toEqual(codex.calls[0].settings);
    expect(correction.reviewLedger).toBe(codex.calls[finalPass ? 1 : 0].reviewLedger);
    const reviewed = JSON.parse((await room.artifacts.readLatest(room.topicId, finalPass ? "codex-final-review" : "codex-review"))!);
    expect(reviewed.findings).toContainEqual(expect.objectContaining({ id: "F-1", disposition: finalPass ? "RESOLVED_BY_FIX" : "AGREED_ACTION" }));
    expect(reviewed.remainingSteps ?? []).toEqual([]);
    expect(room.database.getTimeline(room.topicId).some(event => event.state === "USER_DECISION_REQUIRED")).toBe(false);
    room.database.close();
  });

  it.each(["incomplete", "decision", "evidence"] as const)("완료 보고 교정에서도 실제 미검토·사용자 결정·외부 증거는 자동 통과시키지 않는다 (%s)", async (blocker) => {
    const room = await pagedTopic(`review-completion-blocker-${blocker}`, []);
    const claude = new PagingClaude(room.worktree);
    const first: AgentResult = { ...result("REVIEW", "검토 보고", [reviewFinding("AGREED_ACTION")]),
      status: "completed", remainingSteps: ["다음 작업"] };
    const corrected: AgentResult = { ...first,
      ...(blocker === "incomplete" ? { status: "in_progress", remainingSteps: ["리뷰어가 테스트 실패 경로를 아직 확인하지 못했습니다."] }
        : blocker === "decision" ? { remainingSteps: [], requestedUserDecision: "승인된 범위를 넓힐지 결정해 주세요." }
          : { remainingSteps: [], findings: [{ ...reviewFinding("AGREED_ACTION"), disposition: "EXTERNAL_EVIDENCE" }] }) };
    const codex = new LedgerCodex([{ result: first }, { result: corrected }]);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(room.database.getTopic(room.topicId).state).toBe(blocker === "evidence" ? "BLOCKED_ON_EVIDENCE" : "USER_DECISION_REQUIRED");
    expect(claude.calls.map(call => call.operation)).toEqual(["implement"]);
    expect(operationsOf(codex.calls)).toEqual(["create:review", "resume:contract-correction"]);
    expect(reviewUsed(room)).toBe(1);
    expect(room.database.planning.latestReviewLedger(room.topicId)?.status).toBe(blocker === "incomplete" ? "judged" : "completed");
    room.database.close();
  });

  it.each([true, false])("리뷰 보고 교정 실패는 원본·같은 리뷰 예약을 보존하고 수정 작업을 열지 않는다 (spawn 전 실패: %s)", async (beforeSpawn) => {
    const room = await pagedTopic(`review-completion-failed-${beforeSpawn}`, []);
    const claude = new PagingClaude(room.worktree);
    const original: AgentResult = { ...result("REVIEW", "검토한 지적", [reviewFinding("AGREED_ACTION")]),
      status: "completed", remainingSteps: ["구현자가 수정합니다."] };
    const codex = new LedgerCodex([{ result: original }, beforeSpawn ? { failBeforeSpawn: "교정 준비 실패" } : { fail: "교정 응답 실패" }]);
    room.engine(claude, codex, true).startImplementation(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("FAILED");
    expect(claude.calls.map(call => call.operation)).toEqual(["implement"]);
    expect(operationsOf(codex.calls)).toEqual(["create:review", "resume:contract-correction"]);
    expect(codex.calls[1].reviewLedger).toBe(codex.calls[0].reviewLedger);
    expect(reviewUsed(room)).toBe(1);
    expect(room.database.planning.latestReviewLedger(room.topicId)).toMatchObject({ status: "open", spawned: true });
    const saved = JSON.parse((await room.artifacts.readLatest(room.topicId, "contract-repair-source"))!);
    expect(saved.original).toMatchObject(original);
    room.database.close();
  });

  it("미완료 판정은 원장을 닫되 커서·완료·저장 리뷰로 수정 열기의 근거가 아니다 — 질문은 agent_output 으로 보존되고, 결정 뒤 재시도는 새 원장으로 다시 판정한다", async () => {
    const room = await pagedTopic("ledger-incomplete", [koreanDecision(1_000, "r")]);
    const claude = new PagingClaude(room.worktree);
    const question = "배포 채널을 정해 주세요.";
    const incomplete: AgentResult = { ...result("REVIEW", "일부만 검토했습니다.", [reviewFinding("AGREED_ACTION")]),
      status: "in_progress", remainingSteps: ["테스트 경로 검토"], requestedUserDecision: question };
    const codex = new LedgerCodex([{ result: incomplete }]);
    const engine = room.engine(claude, codex);
    engine.startImplementation(room.topicId);
    await room.idle();

    expect(room.database.getTopic(room.topicId).state).toBe("USER_DECISION_REQUIRED");
    const first = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(first.status).toBe("judged");
    // 원문·질문은 기존 agent_output 계약으로 보존된다(리뷰 요청 목록이 그 이벤트에서 질문을 읽는다).
    expect(room.database.latestArtifact(room.topicId, "codex-review")).not.toBeNull();
    const topic = room.database.getTopic(room.topicId);
    expect(pendingReviewRequests(room.database.getTimeline(room.topicId), topic.scopeGeneration).map((request) => request.question)).toEqual([question]);
    // 커서는 완료 판정에서만 전진한다.
    expect(room.database.getCodexReviewPromptSequence(room.topicId)).toBeNull();

    room.database.appendEvent({ topicId: room.topicId, actor: "user", kind: "decision", state: "USER_DECISION_REQUIRED", body: "배포 채널은 A 로 합니다." });
    engine.retry(room.topicId);
    await room.idle();
    // 결정 뒤에도 미완료 리뷰의 확정 결함을 곧장 수정으로 보내지 않는다 — 답변 확인 뒤 새 원장으로 다시 판정한다(남은 검토를 이어 보라는 안내와 함께).
    expect(claude.calls.map((call) => call.operation)).toEqual(["implement"]);
    expect(operationsOf(codex.calls)).toEqual(["create:review", "resume:answer-confirmation", "resume:review"]);
    expect(codex.calls[2].prompt).toContain("이전 코드 리뷰는 미완료입니다");
    const second = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(second.id).not.toBe(first.id);
    expect(second.status).toBe("completed");
    expect(codex.calls[2].reviewLedger).toBe(second.id);
    expect(room.database.getCodexReviewPromptSequence(room.topicId)).not.toBeNull();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    room.database.close();
  });

  it("진척 게이트: 리뷰 읽기 호출이 다른 세션 id 로 돌아와 리뷰 세션의 미인정 구간이 줄지 않으면 판정 없이 보존·명시 정지하고, 재시도는 같은 원장·같은 세션에서 잇는다", async () => {
    const { room, total } = await largeReviewRoom("ledger-stalled");
    room.database.setCodexReviewSession(room.topicId, "codex-existing");
    const claude = new PagingClaude(room.worktree);
    // 둘째 호출이 생기면 진척 게이트가 반복을 끊지 못한 것이다 — 실패로 드러낸다.
    const codex = new LedgerCodex([{ sessionId: "codex-forked" }, { fail: "진척 없는 리뷰 읽기 반복" }]);
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(operationsOf(codex.calls)).toEqual(["resume:review-read"]);
    expect(codex.calls[0].sessionId).toBe("codex-existing");
    const ledger = room.database.planning.latestReviewLedger(room.topicId)!;
    const stop = room.database.getTimeline(room.topicId).at(-1)!;
    expect(stop.payload).toMatchObject({ readingStalled: true, reviewLedger: ledger.id, reviewSession: "codex-existing" });
    expect(stop.payload?.timelineUnread).toEqual({ references: room.references.map(({ reference }) => reference.selector), bytes: total });
    expect(room.database.getTopic(room.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(room.database.getFlags(room.topicId).resumeState).toBe("CODEX_REVIEW");
    expect(room.database.getCodexReviewSession(room.topicId)).toBe("codex-existing");
    expect(room.database.latestArtifact(room.topicId, "codex-review")).toBeNull();
    expect(ledger).toMatchObject({ status: "open" });

    codex.steps.length = 0;
    room.reopen();
    room.engine(claude, codex).retry(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    const retried = codex.calls.slice(1);
    expect(retried.every((call) => call.method === "resume" && call.sessionId === "codex-existing" && call.reviewLedger === ledger.id)).toBe(true);
    expect(pagesIn(retried[0].prompt)[0].offset).toBe(0);
    expect(pageBytes(retried.flatMap((call) => pagesIn(call.prompt)))).toBe(total);
    // 원래 이어 쓰던 세션이라 판정 호출은 재개 판이다(계획 본문 생략).
    expect(codex.judgments()).toHaveLength(1);
    expect(codex.judgments()[0].prompt).not.toContain("승인된 계획:\n---");
    expect(reviewUsed(room)).toBe(1);
    room.database.close();
  });

  it("리뷰 읽기 호출이 ACK 가 아닌 판정을 내면 판정으로 쓰지 않고 멈추며, 실은 쪽의 인정은 보존해 재시도가 남은 구간부터 잇는다", async () => {
    const { room } = await largeReviewRoom("ledger-invalid-ack");
    const claude = new PagingClaude(room.worktree);
    const codex = new LedgerCodex([{ result: result("REVIEW", "읽기 호출에서 판정했습니다.", [reviewFinding("AGREED_ACTION")]) }]);
    const engine = room.engine(claude, codex);
    engine.startImplementation(room.topicId);
    await room.idle();

    expect(operationsOf(codex.calls)).toEqual(["create:review-read"]);
    const stop = room.database.getTimeline(room.topicId).at(-1)!;
    expect(stop.payload?.reviewReadInvalid).toEqual({ round: 1, kind: "REVIEW" });
    expect(room.database.latestArtifact(room.topicId, "codex-review")).toBeNull();
    expect(room.database.getTimeline(room.topicId).some((event) => event.actor === "codex" && event.kind === "agent_output")).toBe(false);
    const sent = pagesIn(codex.calls[0].prompt);

    engine.retry(room.topicId);
    await room.idle();
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    expect(pagesIn(codex.calls[1].prompt)[0].offset).toBe(sent.at(-1)!.end);
    expect(reviewUsed(room)).toBe(1);
    room.database.close();
  });
});

// ---- E3-4c host-review 39d21df9 F003·F004 — 세션별 수신 기록 ----
// 원장(논리 리뷰 1회)과 별개로 "그 세션이 무엇을 받았는가"를 세션 단위로 둔다. 프로토콜 턴(도구·지시문·메모리 없음)이 만든 세션은 리뷰 전문 판과 메모리 본문을
// 받지 않았으므로, 그 세션의 첫 일반 판정 호출이 전문 판을 보내고(F003) 어댑터가 resume 에도 메모리 본문을 한 번 싣는다(F004).

// 리뷰 좌석 러너 대역 — 실제 어댑터가 만든 CLI 입력(stdin)을 그대로 기록하고, 과제 문구로 응답을 고른다(읽기 = ACK, 첫 판정 = 확정 결함 하나, 최종 = 해결 확인).
class ScriptedReviewRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];
  private threads = 0;
  constructor(private readonly provider: "claude" | "codex") {}
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    const stdin = spec.stdin ?? "";
    const reply = stdin.includes("리뷰의 자료 읽기 호출입니다") ? result("ACK", "쪽을 받았습니다.")
      : stdin.includes("반환 kind는 FINAL_REVIEW") ? result("FINAL_REVIEW", "보완 결과를 확인했습니다.", [reviewFinding("RESOLVED_BY_FIX")])
      : result("REVIEW", "한 곳을 보완해야 합니다.", [reviewFinding("AGREED_ACTION")]);
    const lines: unknown[] = [];
    if (this.provider === "codex") {
      const resume = spec.args.indexOf("resume");
      lines.push({ type: "thread.started", thread_id: resume >= 0 ? spec.args[resume + 1] : `codex-thread-${++this.threads}` });
    }
    lines.push(reply);
    return { exitCode: 0, stdout: lines.map((line) => JSON.stringify(line)).join("\n"), stderr: "", jsonLines: lines };
  }
  kinds(): string[] {
    return this.calls.map((call) => (call.stdin ?? "").includes("리뷰의 자료 읽기 호출입니다") ? "read"
      : (call.stdin ?? "").includes("반환 kind는 FINAL_REVIEW") ? "final-review" : "review");
  }
}

const MEMORY_BODY = "REVIEW-MEMORY-BODY-MARKER";
function reviewMemory(): string {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-review-memory-"));
  temporaryDirectories.push(root);
  writeFileSync(join(root, "context-router.md"), `# Context Router\n\n${MEMORY_BODY}\n`);
  return root;
}

describe("E3-4c host-review 39d21df9 F003·F004 — 세션별 수신 기록", () => {
  it("F003: 이전 원장의 리뷰 읽기 호출이 만든 세션은 트리가 바뀌어 새 원장이 열려도 첫 판정에 계획 전문·계획 검토 근거를 싣고 '이미 전달' 안내를 하지 않는다", async () => {
    const { room } = await largeReviewRoom("receipt-new-tree");
    const topic = room.database.getTopic(room.topicId);
    // 계획 검토 종결 근거 — 전문 판(새 세션)만 싣는다.
    await room.artifacts.write(room.topicId, "closeout", 1, JSON.stringify({ kind: "CLOSEOUT", summary: "계획 검토를 종결했습니다.",
      planSHA256: topic.planSHA256, findings: [], evidenceRefs: ["closeout-evidence-marker"] }));
    const claude = new PagingClaude(room.worktree);
    const codex = new LedgerCodex([{}, { fail: "네트워크 오류" }]);
    const engine = room.engine(claude, codex);
    engine.startImplementation(room.topicId);
    await room.idle();
    const before = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(before.createdSessions).toEqual(["codex-ledger-1"]);

    writeFileSync(join(room.worktree, "feature.txt"), "리뷰 대기 중 바뀐 작업 트리\n");
    engine.retry(room.topicId);
    await room.idle();
    const after = room.database.planning.latestReviewLedger(room.topicId)!;
    expect(after.id).not.toBe(before.id);
    expect(after.createdSessions).toEqual([]);
    const judgment = codex.judgments()[0];
    expect(judgment).toMatchObject({ method: "resume", sessionId: "codex-ledger-1" });
    // 새 원장에는 이 세션의 생성 기록이 없지만, 세션은 쪽만 받았다 — 전문 판이어야 한다.
    expect(judgment.prompt).toContain("승인된 계획:\n---");
    expect(judgment.prompt).toContain("계획 검토의 최종 처분과 근거");
    expect(judgment.prompt).toContain("closeout-evidence-marker");
    expect(judgment.prompt).not.toContain("이 리뷰 세션에 이미 전달한 계획과 같은 전문입니다");
    expect(judgment.prompt).not.toContain("이 리뷰 세션의 직전 턴 이후");
    expect(room.database.getTopic(room.topicId).state).toBe("READY_TO_DELIVER");
    // 전문 판 판정이 돌아온 뒤에야 그 세션이 리뷰 문맥을 받았다고 적는다.
    expect(room.database.planning.sessionReceipt("codex-ledger-1")).toMatchObject({ protocolCreated: true, reviewContext: true });
    room.database.close();
  });

  it.each(["codex", "claude"] as const)("F004: 리뷰 읽기(프로토콜) 호출이 만든 리뷰 세션의 첫 판정 stdin 에 메모리 본문을 한 번 싣고, 다음 판정은 매니페스트만 싣는다(리뷰 경로 %s — 실제 어댑터 바이트)", async (provider) => {
    const room = await pagedTopic(`receipt-memory-${provider}`, [koreanDecision(50_000, provider === "codex" ? "s" : "t")]);
    const runner = new ScriptedReviewRunner(provider);
    const memory = reviewMemory();
    const paging = new PagingClaude(room.worktree);
    let claude: AgentAdapter = paging;
    let codex: AgentAdapter;
    if (provider === "codex") {
      const home = mkdtempSync(join(tmpdir(), "consensus-room-review-codex-"));
      temporaryDirectories.push(home);
      codex = new CodexAdapter(runner, join(home, "agent-result.schema.json"), join(home, "codex-home"), memory);
    } else {
      // 검토자 배정을 Claude 프로필로 옮긴다(E2b) — 리뷰 턴은 실제 ClaudeAdapter 로, 구현·수정 턴은 대역으로 간다.
      room.database.roles.createProfile({ id: "claude-reviewer", provider: "claude", model: "claude-opus-5-5", effort: "high", options: {} });
      room.database.roles.assign({ scope: `topic:${room.topicId}`, role: "reviewer", operation: "", participant: "reviewer-claude",
        profileId: "claude-reviewer", sessionId: null, note: "", expectedVersion: 0 });
      const reviewer = new ClaudeAdapter(runner, memory);
      const byRole = (turn: Omit<SessionTurn, "sessionId">) => turn.job?.role === "reviewer" ? reviewer : paging;
      claude = { role: "claude", validateExistingSession: async () => true,
        createSession: (turn) => byRole(turn).createSession(turn), resumeTurn: (turn) => byRole(turn).resumeTurn(turn) };
      codex = new LedgerCodex([{ fail: "Codex 로 가면 안 되는 호출" }]);
    }
    room.engine(claude, codex).startImplementation(room.topicId);
    await room.idle();

    expect(room.database.getTopic(room.topicId).state, room.database.getTopic(room.topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    expect(runner.kinds()).toEqual(["read", "review", "final-review"]);
    const [read, review, finalReview] = runner.calls.map((call) => call.stdin ?? "");
    // 읽기 호출(프로토콜)은 본문도 매니페스트도 싣지 않는다 — 기존 정책 그대로.
    expect(read).not.toContain(MEMORY_BODY);
    expect(read).not.toContain("메모리 스냅샷 갱신");
    // 그 세션의 첫 일반 판정(resume)에 본문을 한 번 싣는다(매니페스트 중복 없이).
    expect(review).toContain("--- 메모리 문서 시작: context-router.md ---");
    expect(review).toContain(MEMORY_BODY);
    expect(review).not.toContain("메모리 스냅샷 갱신");
    // 다음 판정은 종전 resume 규칙 — 본문 없이 매니페스트만.
    expect(finalReview).not.toContain(MEMORY_BODY);
    expect(finalReview).toContain("메모리 스냅샷 갱신");
    const session = room.database.getCodexReviewSession(room.topicId)!;
    expect(room.database.planning.sessionReceipt(session)).toMatchObject({ protocolCreated: true, memoryBodies: true, reviewContext: true });
    room.database.close();
  });
});
