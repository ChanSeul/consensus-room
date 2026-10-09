import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter } from "../src/server/types";
import { WorkflowEngine } from "../src/server/workflow";
import { REQUIRED_PLAN_HEADINGS } from "../src/shared/contracts";
import { hashPlan } from "../src/shared/workflow";

const DELIVERY_TEST_TIMEOUT_MS = 90_000;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});


describe("인도 커밋 사슬(C1→C2→C3) — 2026-09-21", { timeout: DELIVERY_TEST_TIMEOUT_MS }, () => {
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
    workflowMode: "planned",
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


// ---- E3-4c host-review 39d21df9 F003·F004 — 세션별 수신 기록 ----
// 원장(논리 리뷰 1회)과 별개로 "그 세션이 무엇을 받았는가"를 세션 단위로 둔다. 프로토콜 턴(도구·지시문·메모리 없음)이 만든 세션은 리뷰 전문 판과 메모리 본문을
// 받지 않았으므로, 그 세션의 첫 일반 판정 호출이 전문 판을 보내고(F003) 어댑터가 resume 에도 메모리 본문을 한 번 싣는다(F004).


it("commit preserves the validated evidence when a shared source changes during Git commit", async () => {
  const {database,engine,gitService,topicId}=await setupReadyToDeliver("evidence-commit-race");
  try {
    const topic=database.getTopic(topicId);
    const source=database.evidence.register(topicId,{url:"https://team.atlassian.net/browse/APP-1",label:"Policy",mode:"connector",intervalSeconds:300});
    const ingest=(content:string)=>{const check=database.evidence.begin(source.id,true)!;database.evidence.ingest(source.id,{checkId:check.checkId,revision:content,units:[{id:"policy",kind:"issue",content}]});};
    ingest("approved v1");
    const before=database.evidence.topic(topic);
    const original=gitService.commit.bind(gitService);
    const spy=vi.spyOn(gitService,"commit").mockImplementation(async(...args)=>{ingest("unreviewed v2");return original(...args);});
    try { await engine.commit(topicId,"feature",["feature.txt"]); } finally { spy.mockRestore(); }
    const after=database.evidence.topic(database.getTopic(topicId));
    expect(after).toMatchObject({digest:before.digest,ready:true});
    expect(database.evidence.sourceSnapshot(after.sources[0])!.units[0].content).toBe("approved v1");
    await expect(engine.push(topicId)).resolves.toBe(database.getFlags(topicId).committedOID);
  } finally { database.close(); }
});

it("closing after a failed commit freezes the latest evidence, not the failed attempt",async()=>{
  const {database,engine,gitService,topicId}=await setupReadyToDeliver("failed-evidence-commit");
  try {
    const topic=database.getTopic(topicId);
    const source=database.evidence.register(topicId,{url:"https://team.atlassian.net/browse/APP-1",label:"Policy",mode:"connector",intervalSeconds:300});
    const ingest=(content:string)=>{const check=database.evidence.begin(source.id,true)!;database.evidence.ingest(source.id,{checkId:check.checkId,revision:content,units:[{id:"policy",kind:"issue",content}]});};
    ingest("v1");
    const spy=vi.spyOn(gitService,"commit").mockRejectedValue(new Error("Git failed"));
    try {await expect(engine.commit(topicId,"feature",["feature.txt"])).rejects.toThrow("Git failed");} finally {spy.mockRestore();}
    ingest("v2");const latest=database.evidence.topic(topic);
    engine.close(topicId);
    expect(database.getTopic(topicId).state).toBe("CLOSED");
    expect(database.getFlags(topicId).committedOID).toBeNull();
    expect(database.evidence.topic(database.getTopic(topicId))).toMatchObject({digest:latest.digest,ready:true});
  } finally {database.close();}
});

it.each(["changed","expired"])("interrupted commit recovery retains its request-bound evidence after %s cache",async(change)=>{
  const f=await setupReadyToDeliver("evidence-recovery-"+change);let database=f.database;
  let clock:ReturnType<typeof vi.spyOn>|undefined;
  try {
    const topic=database.getTopic(f.topicId);
    const source=database.evidence.register(f.topicId,{url:"https://team.atlassian.net/browse/APP-1",label:"Policy",mode:"connector",intervalSeconds:300});
    const ingest=(content:string)=>{const check=database.evidence.begin(source.id,true)!;database.evidence.ingest(source.id,{checkId:check.checkId,revision:content,units:[{id:"policy",kind:"issue",content}]});};
    ingest("approved before commit");const before=database.evidence.topic(topic);
    database.claimActionRequest(f.topicId,"commit","interrupted-evidence",{message:"feature",paths:["feature.txt"]});
    const original=f.gitService.commit.bind(f.gitService);
    const spy=vi.spyOn(f.gitService,"commit").mockImplementation(async(...args)=>{await original(...args);throw Error("Lost Git reply");});
    try {await expect(f.engine.commit(f.topicId,"feature",["feature.txt"],"interrupted-evidence")).rejects.toThrow("Lost Git reply");} finally {spy.mockRestore();}
    const oid=await f.gitService.head(f.worktree);
    if(change==="changed")ingest("new unapproved shared body");
    else clock=vi.spyOn(Date,"now").mockReturnValue(Date.now()+3_600_000);
    database.close();database=new ConsensusDatabase(join(f.repository,"..","data","room.sqlite"));
    database.recoverInterruptedDeliveryRequests();
    const engine=new WorkflowEngine({...f.dependencies,database,artifacts:new ArtifactStore(join(f.repository,"..","data","topics"),database),git:f.gitService});
    await engine.reconcileDelivery(f.topicId,{idempotencyKey:"interrupted-evidence",outcome:"succeeded",oid});
    const state=database.evidence.topic(database.getTopic(f.topicId));
    expect(state).toMatchObject({digest:before.digest,ready:true});
    expect(database.evidence.sourceSnapshot(state.sources[0])!.units[0].content).toBe("approved before commit");
    await expect(engine.push(f.topicId)).resolves.toBe(oid);
  } finally {clock?.mockRestore();database.close();}
});

