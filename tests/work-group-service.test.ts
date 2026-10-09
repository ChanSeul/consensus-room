import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import { wrapWorkGroupAdapter } from "../src/server/workGroupAdapter";
import { WorkGroups } from "../src/server/workGroups";
import { resolvePriorResults, stageEvidence, WorkGroupService, type WorkGroupServiceOptions } from "../src/server/workGroupService";
import { DEFAULT_AGENT_SETTINGS, type DeferredFinding } from "../src/shared/contracts";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import type { StageResult, WorkGroupInput } from "../src/shared/workGroups";

// 엔진 개편 E4 — 작업 묶음 서비스(착수 선택·기준 커밋·승계 검사·과거 결과 동결)와 어댑터 게이트. 기준 커밋·합류 대상·승계 ①②③ 은 실제 Git 저장소
// (SpawnCommandRunner + GitService)로 확인한다. 단계 닫기는 부모 workflow.closeStage 가 남기는 기록(CLOSED·committedOID·reviewedTreeOID·동결 결과)을
// 그대로 만들어 흉내 낸다.

const budget = {
  execution: { inputTokens: 100, outputTokens: 100, durationMs: 1000 },
  total: { inputTokens: 1000, outputTokens: 1000, durationMs: 10000 },
};
type StageInput = WorkGroupInput["stages"][number];
const work = (id: string, patch: Partial<StageInput> = {}): StageInput => ({
  id, kind: "work", title: `${id} 제목`, goal: `${id} 목표`, acceptance: `${id} 완료 조건`, dependsOn: [], budget, ...patch,
});
const integration = (id: string, dependsOn: string[]): StageInput => ({ ...work(id, { dependsOn }), kind: "integration" });
const groupInput = (stages: StageInput[], patch: Partial<WorkGroupInput> = {}): WorkGroupInput => ({
  title: "묶음", goal: "전체 목표", contracts: "공통 계약", stages, ...patch,
});
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const roots: string[] = [];
const databases: ConsensusDatabase[] = [];
afterEach(() => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const run = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();

function fixture(git: GitService = new GitService(new SpawnCommandRunner())) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "group-service-")));
  roots.push(root);
  const repository = join(root, "repo");
  execFileSync("git", ["init", "-q", repository]);
  run(repository, "config", "user.name", "Test");
  run(repository, "config", "user.email", "test@example.invalid");
  writeFileSync(join(repository, "base.txt"), "base\n");
  run(repository, "add", ".");
  run(repository, "commit", "-qm", "base");
  const base = run(repository, "rev-parse", "HEAD");
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  databases.push(database);
  const blocked = new Set<string>();
  const memory = join(root, "memory");
  mkdirSync(memory);
  // 토픽별 보류 원장(엔진의 deferred-findings 산출물 자리) — 묶음 밖 선행 토픽의 원장 동결이 읽는다.
  const ledgers = new Map<string, DeferredFinding[]>();
  const service = (gitService: GitService = git, extra: Partial<WorkGroupServiceOptions> = {}) =>
    new WorkGroupService(database, gitService, repository, join(root, "trees"), DEFAULT_AGENT_SETTINGS,
      { blockedExternally: (topicId) => blocked.has(topicId), memoryDirectory: memory,
        deferredFindingsOf: async (topicId) => ledgers.get(topicId) ?? [], ...extra });
  return { root, repository, base, database, blocked, memory, git, service, ledgers };
}
type Fixture = ReturnType<typeof fixture>;

// 단계 토픽의 작업을 끝낸 것처럼 만든다 — 작업 트리 커밋 → 리뷰 트리 = 커밋 트리 → CLOSED·committedOID → 결과 동결(closeStage 가 쓰는 기록).
function closeStage(fx: Fixture, groupId: string, stageId: string, closedAt: string, patch: Partial<StageResult> = {}, prepare?: (worktree: string) => void) {
  const link = fx.database.workGroups.get(groupId).links[stageId];
  const topic = fx.database.getTopic(link.topicId);
  prepare?.(topic.worktreePath);
  writeFileSync(join(topic.worktreePath, `${stageId}.txt`), `${stageId}\n`);
  run(topic.worktreePath, "add", ".");
  run(topic.worktreePath, "commit", "-qm", stageId);
  const commit = run(topic.worktreePath, "rev-parse", "HEAD"), tree = run(topic.worktreePath, "rev-parse", "HEAD^{tree}");
  fx.database.updateTopic(topic.id, { state: "CLOSED", approvedPlanSHA256: sha256(`${stageId} 계획`), committedOID: commit, reviewedTreeOID: tree });
  fx.database.workGroups.freezeResult(groupId, {
    stageId, topicId: topic.id, baseOID: link.baseOID, commitOID: commit, reviewedTreeOID: tree, planSHA256: sha256(`${stageId} 계획`),
    evidenceDigest: null, verifications: [], memoryChanges: [], openQuestions: [], deferredFindings: [], decisions: [], closedAt, ...patch,
  });
  return { commit, tree, topic };
}
const creationEvent = (fx: Fixture, topicId: string) => fx.database.getTimeline(topicId)[0];

it("continuation reports the actual default admission blocker and never readies integration early", async () => {
  const fx = fixture(), service = fx.service();
  const group = await service.create(groupInput([
    work("a"), work("b", { acceptance: undefined, dependsOn: ["a"] }), integration("z", ["a", "b"]),
  ]));
  expect(service.continuation(group).stageId).toBe("a");
  await service.next(group.id);
  expect(service.continuation(fx.database.workGroups.get(group.id)).stageId).toBeNull();
  closeStage(fx, group.id, "a", "2026-10-04T00:00:00.000Z");
  const status = service.continuation(fx.database.workGroups.get(group.id));
  expect(status.stageId).toBeNull();
  expect(status.reason).toContain("완료 조건");
  expect(status.reason).toContain("남은 단계 b");
  await expect(service.next(group.id)).rejects.toThrow(status.reason!);
});

describe("착수 선택과 기준 커밋", () => {
  it("기본은 한 번에 한 단계다. 외부 결정으로 막힌 단계 옆에서만 독립 준비 단계를 고르고, 갈라진 결과는 가장 최근 head 를 기준으로 합류 대상에 싣는다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([
      work("a"), work("b"), work("c", { dependsOn: ["a", "b"] }), integration("z", ["a", "b", "c"]),
    ]));
    // 묶음을 만든 뒤 저장소가 움직여도 첫 단계는 묶음 기준에서 연다(작업 트리·저장소 HEAD 는 기준이 되지 않는다).
    writeFileSync(join(fx.repository, "later.txt"), "later\n");
    run(fx.repository, "add", ".");
    run(fx.repository, "commit", "-qm", "later");
    const a = await service.next(group.id);
    expect(fx.database.workGroups.get(group.id).links.a.baseOID).toBe(fx.base);
    expect(run(a.worktreePath, "rev-parse", "HEAD")).toBe(fx.base);
    expect(creationEvent(fx, a.id).payload).toMatchObject({ stageId: "a", baseOID: fx.base, selected: false, mergeTargets: [] });
    // 한 단계 규칙: 열린 단계가 있으면 기본 착수는 거부한다.
    await expect(service.next(group.id)).rejects.toThrow("열린 단계(a)가 끝난 뒤 다음 단계를 여세요.");
    // 진행 중(또는 자원 정지)인 단계 옆에서는 고를 수 없다.
    expect(service.selectableStages(fx.database.workGroups.get(group.id))).toEqual([]);
    await expect(service.next(group.id, undefined, "b")).rejects.toThrow("외부 결정으로 막혀 있지 않습니다");
    // 외부 결정으로 막히면 독립 준비 단계(b)만 고를 수 있다 — c 는 a 에 의존, z 는 통합 단계.
    fx.blocked.add(a.id);
    expect(service.selectableStages(fx.database.workGroups.get(group.id))).toEqual(["b"]);
    await expect(service.next(group.id, undefined, "c")).rejects.toThrow("c: 의존 단계 a 가 아직 닫히지 않았습니다");
    await expect(service.next(group.id, undefined, "z")).rejects.toThrow("통합 단계는 골라 열 수 없습니다");
    const b = await service.next(group.id, undefined, "b");
    expect(creationEvent(fx, b.id).payload).toMatchObject({ stageId: "b", baseOID: fx.base, selected: true, mergeTargets: [] });
    expect(run(b.worktreePath, "rev-parse", "HEAD")).toBe(fx.base);
    // 막혔던 a 와 독립 b 가 같은 기준에서 갈라진 결과를 낸다. a 가 더 나중에 닫혔다.
    const closedB = closeStage(fx, group.id, "b", "2026-09-27T01:00:00.000Z");
    fx.blocked.delete(a.id);
    const closedA = closeStage(fx, group.id, "a", "2026-09-27T02:00:00.000Z");
    const c = await service.next(group.id);
    const cLink = fx.database.workGroups.get(group.id).links.c;
    // 두 결과를 모두 가진 head 가 없다 → 가장 최근 head(a) 를 기준으로, b 는 합류 대상.
    expect(cLink.baseOID).toBe(closedA.commit);
    expect(cLink.mergeTargets).toEqual(["b"]);
    expect(run(c.worktreePath, "rev-parse", "HEAD")).toBe(closedA.commit);
    expect(creationEvent(fx, c.id).payload).toMatchObject({ stageId: "c", baseOID: closedA.commit, selected: false, mergeTargets: ["b"] });
    expect((await stageEvidence(fx.database, fx.git, fx.database.workGroups.get(group.id), "c")).map((proof) => [proof.stageId, proof.commit]))
      .toEqual([["a", closedA.commit], ["b", closedB.commit]]);
    // 합류 대상(b)은 엔진이 연결 전에 c 의 작업 트리에 커밋 없이 병합해 둔다(host-review F001) — HEAD 는 기준(a) 그대로, 작업 트리는 병합 트리다.
    // 병합 결과를 커밋해 합류를 끝내는 경로(인도 커밋·닫기)의 종단 확인은 부모 종단 검사가 한다.
    const expectedTree = run(fx.repository, "merge-tree", "--write-tree", closedA.commit, closedB.commit);
    expect(cLink.preparedMerge).toEqual({ tree: expectedTree, conflicts: [], targets: [{ stageId: "b", commitOID: closedB.commit }] });
    expect(await fx.git.workingTreeOID(c.worktreePath)).toBe(expectedTree);
    expect(readFileSync(join(c.worktreePath, "b.txt"), "utf8")).toBe("b\n");
    expect(run(c.worktreePath, "status", "--porcelain")).toBe("?? b.txt");
  });

  it("합류 대상 병합에 충돌이 있으면 충돌 표식을 담은 채 작업 트리에 준비하고 충돌 파일을 연결 기록에 남긴다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b"), work("c", { dependsOn: ["a", "b"] }), integration("z", ["a", "b", "c"])]));
    const a = await service.next(group.id);
    fx.blocked.add(a.id);
    await service.next(group.id, undefined, "b");
    const closedB = closeStage(fx, group.id, "b", "2026-09-27T01:00:00.000Z", {}, (worktree) => writeFileSync(join(worktree, "shared.txt"), "b 의 내용\n"));
    fx.blocked.delete(a.id);
    const closedA = closeStage(fx, group.id, "a", "2026-09-27T02:00:00.000Z", {}, (worktree) => writeFileSync(join(worktree, "shared.txt"), "a 의 내용\n"));
    const c = await service.next(group.id);
    const link = fx.database.workGroups.get(group.id).links.c;
    expect(link.baseOID).toBe(closedA.commit);
    expect(link.mergeTargets).toEqual(["b"]);
    expect(link.preparedMerge?.conflicts).toEqual(["shared.txt"]);
    expect(link.preparedMerge?.targets).toEqual([{ stageId: "b", commitOID: closedB.commit }]);
    expect(await fx.git.workingTreeOID(c.worktreePath)).toBe(link.preparedMerge?.tree);
    const shared = readFileSync(join(c.worktreePath, "shared.txt"), "utf8");
    expect(shared).toContain("<<<<<<<");
    expect(shared).toContain("a 의 내용");
    expect(shared).toContain("b 의 내용");
    expect(run(c.worktreePath, "rev-parse", "HEAD")).toBe(closedA.commit);
  });

  it("통합 단계는 연결 때 위키 기록 버전과 지금 버전이 다른 문서만 재어 싣고, 생성 이벤트 body 는 저장소 단계 문맥 그대로다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), integration("z", ["a"])]));
    await service.next(group.id);
    writeFileSync(join(fx.memory, "a.md"), "지금 문서\n");
    writeFileSync(join(fx.memory, "same.md"), "그대로인 문서\n");
    const closedA = closeStage(fx, group.id, "a", "2026-09-27T01:00:00.000Z", {
      memoryChanges: [{ path: "a.md", sha256: sha256("기록한 문서\n") }, { path: "gone.md", sha256: sha256("지운 문서\n") },
        { path: "same.md", sha256: sha256("그대로인 문서\n") }],
    });
    const z = await service.next(group.id);
    const zLink = fx.database.workGroups.get(group.id).links.z;
    expect(zLink.baseOID).toBe(closedA.commit);
    expect(zLink.mergeTargets ?? []).toEqual([]);
    expect(zLink.preparedMerge).toBeUndefined();
    // 기록 버전과 지금 버전이 다른 문서만 싣는다(같은 same.md 는 빠진다).
    expect(zLink.memoryDrift).toEqual([
      { path: "a.md", stageId: "a", recordedSHA256: sha256("기록한 문서\n"), currentSHA256: sha256("지금 문서\n") },
      { path: "gone.md", stageId: "a", recordedSHA256: sha256("지운 문서\n"), currentSHA256: null },
    ]);
    expect(creationEvent(fx, z.id).payload).toMatchObject({ stageId: "z", baseOID: closedA.commit, selected: false, mergeTargets: [] });
    expect(creationEvent(fx, z.id).body).toBe(fx.database.workGroups.renderStageContext(fx.database.workGroups.get(group.id), "z"));
  });

  it("기본 착수는 준비된(완료 조건·예산·차단 질문 해소) 단계 중 의존 폐포가 닫힌 첫 단계를 열고, 통합 단계는 다른 모든 단계가 닫힌 뒤에만 연다", async () => {
    const fx = fixture();
    const service = fx.service();
    const input = groupInput([
      work("a"), work("b", { acceptance: undefined, budget: undefined }), work("c", { dependsOn: ["b"] }), work("d"), integration("z", ["a", "b", "c", "d"]),
    ], { questions: [{ id: "q1", stageId: "d", text: "d 의 범위", blocksStart: true }, { id: "q2", stageId: "a", text: "비차단 질문", blocksStart: false }] });
    const group = await service.create(input);
    const a = await service.next(group.id);
    expect(fx.database.workGroups.get(group.id).links.a.topicId).toBe(a.id);
    const closedA = closeStage(fx, group.id, "a", "2026-09-27T01:00:00.000Z");
    const blocked = service.next(group.id);
    await expect(blocked).rejects.toThrow("열 수 있는 준비된 단계가 없습니다");
    const message = await blocked.catch((error: Error) => error.message);
    expect(message).toContain("b: 완료 조건이 정해지지 않은 대략 단계입니다");
    expect(message).toContain("c: 의존 단계 b 가 아직 착수되지 않았습니다");
    expect(message).toContain("d: 착수를 막는 미정 질문 q1 이 해소되지 않았습니다");
    expect(message).toContain("z: 통합 단계는 다른 모든 단계가 닫힌 뒤에 엽니다(남은 단계 b, c, d)");
    expect(service.selectableStages(fx.database.workGroups.get(group.id))).toEqual([]);
    expect(Object.keys(fx.database.workGroups.get(group.id).links)).toEqual(["a"]);
    // 차단 질문을 해소하면 대략 단계 b·그에 의존하는 c 를 건너뛰고 d 를 연다(기준은 닫힌 결과 head).
    fx.database.workGroups.revise(group.id, { ...input, questions: [{ ...input.questions![0], resolution: "정했다" }, input.questions![1]] }, 1);
    const d = await service.next(group.id);
    const dLink = fx.database.workGroups.get(group.id).links.d;
    expect(dLink).toMatchObject({ topicId: d.id, baseOID: closedA.commit });
    expect(dLink.mergeTargets ?? []).toEqual([]);
    expect(creationEvent(fx, d.id).payload).toMatchObject({ stageId: "d", selected: false });
  });

  it("unavailable evidence can be deferred without resolving it, and the next worker retains the excluded scope", async () => {
    const fx = fixture(), service = fx.service();
    const question = { id: "q", stageId: "a", text: "Unavailable API field", blocksStart: true };
    const input = groupInput([work("a"), integration("z", ["a"])], { questions: [question] });
    const group = await service.create(input);
    await expect(service.next(group.id)).rejects.toThrow("열 수 있는 준비된 단계가 없습니다");
    const deferredReason = "Exclude the unconfirmed field; implement documented fields and recheck the source later";
    fx.database.workGroups.revise(group.id, { ...input, questions: [{ ...question, deferredReason }] }, 1);
    const saved = fx.database.workGroups.get(group.id);
    expect(saved.questions![0].resolution).toBeUndefined();
    expect(service.selectableStages(saved)).toEqual(["a"]);
    const topic = await service.next(group.id);
    const prompt = creationEvent(fx, topic.id).body;
    expect(prompt).toContain(deferredReason);
    expect(prompt).toContain("미해소");
    expect(prompt).toContain("그 질문에 의존하는 동작은 이번 구현에서 제외");
    expect(prompt).not.toContain("(착수 차단)");
    await expect(service.next(group.id)).rejects.toThrow();
  });

  it("필요한 결과를 모두 가진 head 가 있으면 가장 최근 head 가 아니어도 그것을 기준으로 하고 합류 대상을 두지 않는다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b"), work("c", { dependsOn: ["a"] }), integration("z", ["a", "b", "c"])]));
    const a = await service.next(group.id);
    fx.blocked.add(a.id);
    await service.next(group.id, undefined, "b");
    fx.blocked.delete(a.id);
    const closedA = closeStage(fx, group.id, "a", "2026-09-27T01:00:00.000Z");
    closeStage(fx, group.id, "b", "2026-09-27T02:00:00.000Z");
    // heads = {a, b}. 가장 최근은 b 지만 c 에 필요한 결과(a)를 가진 head 는 a 다.
    const c = await service.next(group.id);
    expect(fx.database.workGroups.get(group.id).links.c.baseOID).toBe(closedA.commit);
    expect(fx.database.workGroups.get(group.id).links.c.mergeTargets ?? []).toEqual([]);
    expect(run(c.worktreePath, "rev-parse", "HEAD")).toBe(closedA.commit);
  });

  it("닫힌 순서가 계보와 어긋나도(열린 단계의 커밋을 먼저 병합) 기준은 다른 결과의 조상이 아닌 head 다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b"), work("c", { dependsOn: ["a"] }), integration("z", ["a", "b", "c"])]));
    const a = await service.next(group.id);
    fx.blocked.add(a.id);
    await service.next(group.id, undefined, "b");
    // 기준 고르기만 보는 합성 계보다(공식 인도 경로의 병합이 아니다 — 러너는 병합을 직접 만들지 않는다). 닫힌 시각과 계보가 어긋나는 실제 경우는
    // E4 전 결과(닫힌 시각 = 토픽 마지막 갱신 시각)다: b 가 a 의 커밋을 조상으로 가진 채 먼저 닫히고, a 는 그 커밋 그대로 나중에 닫힌다.
    writeFileSync(join(a.worktreePath, "a.txt"), "a\n");
    run(a.worktreePath, "add", ".");
    run(a.worktreePath, "commit", "-qm", "a");
    const aCommit = run(a.worktreePath, "rev-parse", "HEAD"), aTree = run(a.worktreePath, "rev-parse", "HEAD^{tree}");
    const closedB = closeStage(fx, group.id, "b", "2026-09-27T01:00:00.000Z", {}, (worktree) => run(worktree, "merge", "-q", "--no-edit", aCommit));
    fx.blocked.delete(a.id);
    fx.database.updateTopic(a.id, { state: "CLOSED", approvedPlanSHA256: sha256("a 계획"), committedOID: aCommit, reviewedTreeOID: aTree });
    fx.database.workGroups.freezeResult(group.id, {
      stageId: "a", topicId: a.id, baseOID: fx.base, commitOID: aCommit, reviewedTreeOID: aTree, planSHA256: sha256("a 계획"), evidenceDigest: null,
      verifications: [], memoryChanges: [], openQuestions: [], deferredFindings: [], decisions: [], closedAt: "2026-09-27T02:00:00.000Z",
    });
    const c = await service.next(group.id);
    expect(fx.database.workGroups.get(group.id).links.c.baseOID).toBe(closedB.commit);
    expect(run(c.worktreePath, "rev-parse", "HEAD")).toBe(closedB.commit);
  });

  it("작업 트리를 만드는 동안 막혔던 단계가 재개되면 선택 착수를 연결하지 않고 예약을 남긴다 — 다시 막히면 그 예약을 이어 연다", async () => {
    const holder: { onCreate?: () => void } = {};
    class Hooked extends GitService {
      async createDetachedWorktree(repositoryPath: string, worktreePath: string, baseRef: string) {
        await super.createDetachedWorktree(repositoryPath, worktreePath, baseRef);
        const hook = holder.onCreate;
        holder.onCreate = undefined;
        hook?.();
      }
    }
    const fx = fixture(new Hooked(new SpawnCommandRunner()));
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b"), integration("z", ["a", "b"])]));
    const a = await service.next(group.id);
    fx.blocked.add(a.id);
    holder.onCreate = () => fx.blocked.delete(a.id);
    await expect(service.next(group.id, undefined, "b")).rejects.toThrow("준비 중인 단계를 열 수 없습니다 — 열린 단계 a 가 외부 결정으로 막혀 있지 않습니다");
    expect(fx.database.workGroups.get(group.id).links.b).toBeUndefined();
    expect(Object.keys(fx.database.workGroups.get(group.id).pending ?? {})).toEqual(["b"]);
    fx.blocked.add(a.id);
    const b = await service.next(group.id, undefined, "b");
    expect(fx.database.workGroups.get(group.id).links.b.topicId).toBe(b.id);
    expect(creationEvent(fx, b.id).payload).toMatchObject({ stageId: "b", selected: true });
  });

  it("통합 단계가 의존하지 않는 단계의 결과도 기준에 없으면 합류 대상이 되고, 턴마다 그 결과를 다시 확인한다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b"), integration("z", ["a"])]));
    const a = await service.next(group.id);
    fx.blocked.add(a.id);
    await service.next(group.id, undefined, "b");
    const closedB = closeStage(fx, group.id, "b", "2026-09-27T01:00:00.000Z");
    fx.blocked.delete(a.id);
    const closedA = closeStage(fx, group.id, "a", "2026-09-27T02:00:00.000Z");
    // 가장 최근 head 는 a — b 의 결과는 기준에 없고 z 의 의존도 아니지만, 통합 단계는 다른 모든 단계 결과를 이어받으므로 합류 대상이다.
    const z = await service.next(group.id);
    const saved = fx.database.workGroups.get(group.id);
    expect(saved.links.z).toMatchObject({ topicId: z.id, baseOID: closedA.commit, mergeTargets: ["b"] });
    expect(saved.links.z.preparedMerge?.targets).toEqual([{ stageId: "b", commitOID: closedB.commit }]);
    expect(await fx.git.workingTreeOID(z.worktreePath)).toBe(saved.links.z.preparedMerge?.tree);
    expect(creationEvent(fx, z.id).payload).toMatchObject({ stageId: "z", baseOID: closedA.commit, selected: false, mergeTargets: ["b"] });
    expect((await stageEvidence(fx.database, fx.git, saved, "z")).map((proof) => [proof.stageId, proof.commit]))
      .toEqual([["a", closedA.commit], ["b", closedB.commit]]);
    expect((await resolvePriorResults(fx.database, fx.git, group.id, "z")).proof.map((proof) => [proof.stageId, proof.commit]))
      .toEqual([["a", closedA.commit], ["b", closedB.commit]]);
    // 합류 대상 결과의 작업 트리가 결과 커밋에서 벗어나면 통합 단계의 턴 근거 확인이 거부한다.
    writeFileSync(join(closedB.topic.worktreePath, "dirty.txt"), "x\n");
    await expect(stageEvidence(fx.database, fx.git, saved, "z")).rejects.toThrow("단계 b 의 결과 커밋이 변경됐습니다");
    await expect(resolvePriorResults(fx.database, fx.git, group.id, "z")).rejects.toThrow("단계 b 의 결과 커밋이 변경됐습니다");
  });

  it("준비 중 예약은 그 단계만 이어서 열고(작업 트리 한 번), 다른 단계 선택은 거부한다", async () => {
    class InterruptedOnce extends GitService {
      created: string[] = [];
      async createDetachedWorktree(repositoryPath: string, worktreePath: string, baseRef: string) {
        this.created.push(baseRef);
        await super.createDetachedWorktree(repositoryPath, worktreePath, baseRef);
        if (this.created.length === 1) throw new Error("interrupted after worktree");
      }
    }
    const git = new InterruptedOnce(new SpawnCommandRunner());
    const fx = fixture(git);
    const group = await fx.service().create(groupInput([work("a"), work("b"), integration("z", ["a", "b"])]));
    await expect(fx.service().next(group.id)).rejects.toThrow("interrupted after worktree");
    expect(Object.keys(fx.database.workGroups.get(group.id).pending ?? {})).toEqual(["a"]);
    expect(fx.service().selectableStages(fx.database.workGroups.get(group.id))).toEqual(["a"]);
    await expect(fx.service().next(group.id, undefined, "b")).rejects.toThrow("준비 중인 단계 a 를 먼저 연결하세요.");
    const a = await fx.service().next(group.id);
    expect(a.state).toBe("DRAFT");
    expect(a.approvedPlanSHA256).toBeNull();
    expect(git.created).toEqual([fx.base]);
    expect(fx.database.workGroups.get(group.id).pending?.a).toBeUndefined();
  });

  it("완료 조건이 정해진 단계는 숫자 예산 없이 열고 사용량만 기록한다", async () => {
    const fx = fixture(), service = fx.service();
    const group = await service.create(groupInput([work("a", { budget: undefined }), { ...integration("z", ["a"]), budget: undefined }]));
    expect(service.selectableStages(group)).toContain("a");
    const topic = await service.next(group.id);
    expect(fx.database.budgets.account(group.id)?.policy).toEqual({ mode: "observe" });
    expect(fx.database.budgets.account(topic.id)?.policy).toEqual({ mode: "observe" });
  });

  it("묶음 예산은 묶음 정책이 있으면 그것, 없으면 예산을 선언한 단계들로 정하고(계정 출처는 늘 explicit-stage-budgets) 대략 단계를 허용한다", async () => {
    const fx = fixture();
    const service = fx.service();
    const stages = [work("a"), work("b", { acceptance: undefined, budget: undefined }), integration("z", ["a", "b"])];
    const staged = await service.create(groupInput(stages));
    expect(fx.database.budgets.account(staged.id)).toMatchObject({ source: "explicit-stage-budgets", policy: { total: { inputTokens: 2000 } } });
    const policy = { execution: { inputTokens: 7, outputTokens: 8, durationMs: 9 }, total: { inputTokens: 70, outputTokens: 80, durationMs: 90 } };
    const pooled = await service.create(groupInput(stages, { budgetPolicy: policy }));
    // 예산 화면은 이 출처로 묶음 계정을 알아본다 — 정책 출처는 레코드의 budgetPolicy 에 남는다.
    expect(fx.database.budgets.account(pooled.id)).toMatchObject({ source: "explicit-stage-budgets", policy });
    expect(fx.database.workGroups.get(pooled.id).budgetPolicy).toEqual(policy);
    expect(fx.database.workGroups.get(staged.id).budgetPolicy).toBeUndefined();
  });
});

describe("승계 검사(동결 결과)", () => {
  async function opened() {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b", { dependsOn: ["a"] }), integration("z", ["a", "b"])]));
    await service.next(group.id);
    return { fx, service, group };
  }
  const unlinked = (fx: Fixture, groupId: string) => {
    const group = fx.database.workGroups.get(groupId);
    expect(group.links.b).toBeUndefined();
    expect(group.pending ?? {}).toEqual({});
  };

  it("① 결과 커밋 트리가 리뷰한 트리와 다르면 다음 단계를 열지 않는다", async () => {
    const { fx, service, group } = await opened();
    closeStage(fx, group.id, "a", "2026-09-27T01:00:00.000Z", { reviewedTreeOID: run(fx.repository, "rev-parse", `${fx.base}^{tree}`) });
    await expect(service.next(group.id)).rejects.toThrow("단계 a 의 결과 커밋 트리가 리뷰한 트리와 다릅니다.");
    unlinked(fx, group.id);
  });

  it("② 결과 커밋이 그 단계 기준 커밋의 후손이 아니면(다른 계보) 다음 단계를 열지 않는다", async () => {
    const { fx, service, group } = await opened();
    closeStage(fx, group.id, "a", "2026-09-27T01:00:00.000Z", {}, (worktree) => run(worktree, "checkout", "-q", "--orphan", "other-lineage"));
    await expect(service.next(group.id)).rejects.toThrow("단계 a 의 결과 커밋이 그 단계 기준 커밋의 후손이 아닙니다.");
    unlinked(fx, group.id);
  });

  it("③ 그 단계 작업 트리 HEAD 가 결과 커밋이 아니거나 커밋하지 않은 변경이 있으면 거부하고, 되돌리면 결과 커밋에서 연다", async () => {
    const { fx, service, group } = await opened();
    const closed = closeStage(fx, group.id, "a", "2026-09-27T01:00:00.000Z");
    writeFileSync(join(closed.topic.worktreePath, "dirty.txt"), "커밋하지 않은 변경\n");
    await expect(service.next(group.id)).rejects.toThrow("단계 a 의 결과 커밋이 변경됐습니다");
    unlinked(fx, group.id);
    run(closed.topic.worktreePath, "add", ".");
    run(closed.topic.worktreePath, "commit", "-qm", "닫은 뒤 이어 쓴 커밋");
    await expect(service.next(group.id)).rejects.toThrow("단계 a 의 결과 커밋이 변경됐습니다");
    unlinked(fx, group.id);
    run(closed.topic.worktreePath, "reset", "-q", "--hard", closed.commit);
    const b = await service.next(group.id);
    expect(run(b.worktreePath, "rev-parse", "HEAD")).toBe(closed.commit);
  });

  it("E4 전에 닫힌 단계는 이전 계약 증거(push 된 커밋·승인·리뷰 트리·HEAD·clean)로 legacy 결과를 한 번 동결하고, 증거가 없으면 거부한다", async () => {
    const { fx, service, group } = await opened();
    const topicId = fx.database.workGroups.get(group.id).links.a.topicId;
    const worktree = fx.database.getTopic(topicId).worktreePath;
    writeFileSync(join(worktree, "a.txt"), "a\n");
    run(worktree, "add", ".");
    run(worktree, "commit", "-qm", "a");
    const commit = run(worktree, "rev-parse", "HEAD"), tree = run(worktree, "rev-parse", "HEAD^{tree}");
    // 동결 결과 없이 닫힌 단계 = E4 전 닫힘. push 가 없으면 이전 계약의 승계 증거가 없다.
    fx.database.updateTopic(topicId, { state: "CLOSED", approvedPlanSHA256: sha256("a 계획"), committedOID: commit, reviewedTreeOID: tree });
    await expect(service.next(group.id)).rejects.toThrow("E4 전에 닫힌 단계 a 의 승인·리뷰·푸시 기록이 없어 결과를 승계할 수 없습니다.");
    expect(fx.database.workGroups.get(group.id).results?.a).toBeUndefined();
    unlinked(fx, group.id);
    fx.database.updateTopic(topicId, { pushedOID: commit });
    // push 기록이 있어도 그 토픽 작업 트리가 전달 커밋에서 벗어났으면 동결하지 않는다.
    writeFileSync(join(worktree, "dirty.txt"), "x\n");
    await expect(service.next(group.id)).rejects.toThrow("단계 a 의 전달 커밋이 변경됐습니다.");
    expect(fx.database.workGroups.get(group.id).results?.a).toBeUndefined();
    unlinked(fx, group.id);
    rmSync(join(worktree, "dirty.txt"));
    const b = await service.next(group.id);
    expect(fx.database.workGroups.get(group.id).results?.a).toMatchObject({
      stageId: "a", topicId, commitOID: commit, reviewedTreeOID: tree, planSHA256: sha256("a 계획"), legacy: true,
      verifications: [], memoryChanges: [], openQuestions: [], deferredFindings: [], decisions: [],
    });
    expect(run(b.worktreePath, "rev-parse", "HEAD")).toBe(commit);
    // legacy 결과는 이전 검사(HEAD==커밋·clean)만 다시 한다.
    expect(await stageEvidence(fx.database, fx.git, fx.database.workGroups.get(group.id), "b"))
      .toEqual([{ stageId: "a", commit, planSHA: sha256("a 계획"), verification: tree }]);
    writeFileSync(join(worktree, "dirty.txt"), "x\n");
    await expect(stageEvidence(fx.database, fx.git, fx.database.workGroups.get(group.id), "b")).rejects.toThrow("단계 a 의 결과 커밋이 변경됐습니다");
  });
});

describe("E4 전에 닫힌 단계와 결속된 열린 단계", () => {
  it("동결하면 열린 단계의 문맥이 바뀌는 E4 전 결과는 동결하지 않는다 — 그 결과가 필요한 단계는 거부하고, 필요 없는 단계는 연다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([
      work("a"), work("b", { dependsOn: ["a"] }), work("c", { dependsOn: ["a"] }), work("d"), integration("z", ["a", "b", "c", "d"]),
    ]));
    const a = await service.next(group.id);
    writeFileSync(join(a.worktreePath, "a.txt"), "a\n");
    run(a.worktreePath, "add", ".");
    run(a.worktreePath, "commit", "-qm", "a");
    const commit = run(a.worktreePath, "rev-parse", "HEAD");
    fx.database.updateTopic(a.id, { state: "CLOSED", approvedPlanSHA256: sha256("a 계획"), committedOID: commit, pushedOID: commit,
      reviewedTreeOID: run(a.worktreePath, "rev-parse", "HEAD^{tree}") });
    // a 는 E4 전에 닫혀 결과가 동결되지 않았고, b 는 그 뒤 해시로 결속됐다(재계획 완료로 해시를 얻은 E4 전 연결과 같은 상태).
    const created = "2026-09-27T00:00:00.000Z";
    fx.database.createTopic({ workflowMode: "planned", id: "topic-b", slug: "stage-b", title: "b", repositoryPath: fx.repository, baseRef: commit,
      worktreePath: join(fx.root, "stage-b"), branchName: null, state: "USER_DECISION_REQUIRED", scopeGeneration: 1, planRevision: 0,
      planSHA256: null, approvedPlanSHA256: null, createdAt: created, updatedAt: created, lastError: null });
    fx.database.workGroups.link(group.id, "b", "topic-b", commit, { selected: true });
    fx.blocked.add("topic-b");
    expect(service.selectableStages(fx.database.workGroups.get(group.id))).toEqual(["d"]);
    await expect(service.next(group.id, undefined, "c"))
      .rejects.toThrow("c: E4 전에 닫힌 의존 단계 a 의 결과를 동결하면 열린 단계 b 의 단계 문맥이 바뀝니다");
    const d = await service.next(group.id, undefined, "d");
    expect(fx.database.workGroups.get(group.id).results?.a).toBeUndefined();
    expect(() => fx.database.workGroups.assertStageContextCurrent("topic-b")).not.toThrow();
    // 동결하지 못한 결과는 기준 후보가 아니다 — 묶음 기준에서 연다.
    expect(run(d.worktreePath, "rev-parse", "HEAD")).toBe(fx.base);
  });
});

describe("선행 결과 해석(resolvePriorResults)", () => {
  async function legacyClosed(pushed: boolean) {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b", { dependsOn: ["a"] }), integration("z", ["a", "b"])]));
    const a = await service.next(group.id);
    // 닫히지 않은 선행 단계는 해석하지 않는다.
    await expect(resolvePriorResults(fx.database, fx.git, group.id, "b")).rejects.toThrow("의존 단계 a 가 아직 닫히지 않았습니다.");
    writeFileSync(join(a.worktreePath, "a.txt"), "a\n");
    run(a.worktreePath, "add", ".");
    run(a.worktreePath, "commit", "-qm", "a");
    const commit = run(a.worktreePath, "rev-parse", "HEAD"), tree = run(a.worktreePath, "rev-parse", "HEAD^{tree}");
    // 동결 결과 없이 닫힌 단계 = E4 전 닫힘.
    fx.database.updateTopic(a.id, { state: "CLOSED", approvedPlanSHA256: sha256("a 계획"), committedOID: commit, reviewedTreeOID: tree,
      ...(pushed ? { pushedOID: commit } : {}) });
    return { fx, group, a, commit, tree };
  }

  it("E4 전 닫힌 선행은 이전 계약 증거로 검증해 legacy 결과로 동결하고(freeze:false 면 DB 를 쓰지 않는다), 동결 뒤에는 승계 검사로 판정한다", async () => {
    const { fx, group, a, commit, tree } = await legacyClosed(true);
    const expected = { stageId: "a", commit, planSHA: sha256("a 계획"), verification: tree };
    const before = JSON.stringify(fx.database.workGroups.get(group.id));
    const dry = await resolvePriorResults(fx.database, fx.git, group.id, "b", { freeze: false });
    expect(dry.proof).toEqual([expected]);
    expect(dry.unfrozen).toEqual([expected]);
    expect(JSON.stringify(fx.database.workGroups.get(group.id))).toBe(before);
    const resolved = await resolvePriorResults(fx.database, fx.git, group.id, "b");
    expect(resolved.proof).toEqual([expected]);
    expect(resolved.unfrozen).toEqual([]);
    expect(resolved.group.results?.a).toMatchObject({
      stageId: "a", topicId: a.id, commitOID: commit, reviewedTreeOID: tree, legacy: true, deferredFindings: [], decisions: [],
    });
    // 동결된 legacy 결과는 이전 검사(HEAD·clean)로 다시 판정한다 — 같은 증거, 작업 트리가 벗어나면 거부.
    expect((await resolvePriorResults(fx.database, fx.git, group.id, "b")).proof).toEqual([expected]);
    writeFileSync(join(a.worktreePath, "dirty.txt"), "x\n");
    await expect(resolvePriorResults(fx.database, fx.git, group.id, "b")).rejects.toThrow("단계 a 의 결과 커밋이 변경됐습니다");
  });

  it("E4 전 선행의 이전 계약 증거가 없으면(push 없음) 동결하지 않고 거부한다", async () => {
    const { fx, group } = await legacyClosed(false);
    await expect(resolvePriorResults(fx.database, fx.git, group.id, "b"))
      .rejects.toThrow("E4 전에 닫힌 단계 a 의 승인·리뷰·푸시 기록이 없어 결과를 승계할 수 없습니다.");
    expect(fx.database.workGroups.get(group.id).results?.a).toBeUndefined();
  });

  it("이미 열린 통합 단계가 해시로 결속돼 있으면 E4 전 선행을 검증만 하고 동결하지 않는다(결속 유지)", async () => {
    const { fx, group, commit, tree } = await legacyClosed(true);
    const created = "2026-09-27T00:00:00.000Z";
    for (const [stageId, topicId] of [["b", "topic-b"], ["z", "topic-z"]] as const) {
      fx.database.createTopic({ workflowMode: "planned", id: topicId, slug: `stage-${stageId}`, title: stageId, repositoryPath: fx.repository, baseRef: commit,
        worktreePath: join(fx.root, `stage-${stageId}`), branchName: null, state: stageId === "b" ? "CLOSED" : "DRAFT", scopeGeneration: 1,
        planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: created, updatedAt: created, lastError: null });
    }
    // b 는 동결 결과가 있고(작업 트리를 결과 커밋에 둔다), z 는 a 의 결과 없이 해시로 결속된 열린 통합 단계다.
    const bTree = join(fx.root, "stage-b");
    run(fx.repository, "worktree", "add", "-q", "--detach", bTree, commit);
    fx.database.workGroups.link(group.id, "b", "topic-b", commit, { selected: true });
    fx.database.workGroups.freezeResult(group.id, {
      stageId: "b", topicId: "topic-b", baseOID: commit, commitOID: commit, reviewedTreeOID: tree, planSHA256: sha256("b 계획"), evidenceDigest: null,
      verifications: [], memoryChanges: [], openQuestions: [], deferredFindings: [], decisions: [], closedAt: created,
    });
    fx.database.workGroups.link(group.id, "z", "topic-z", commit, { selected: true });
    const resolved = await resolvePriorResults(fx.database, fx.git, group.id, "z");
    expect(resolved.proof.map((proof) => proof.stageId)).toEqual(["a", "b"]);
    expect(resolved.unfrozen).toEqual([{ stageId: "a", commit, planSHA: sha256("a 계획"), verification: tree }]);
    expect(resolved.group.results?.a).toBeUndefined();
    expect(() => fx.database.workGroups.assertStageContextCurrent("topic-z")).not.toThrow();
  });
});

describe("어댑터 게이트", () => {
  // 저장소는 실제 WorkGroups, 토픽·Git 은 대역이다 — 게이트는 저장소의 결속 판정(assertStageContextCurrent)과 선행 결과 확인 순서만 본다.
  function gate(order: "frozen-then-link" | "link-then-frozen" = "frozen-then-link") {
    const db = new DatabaseSync(":memory:"), groups = new WorkGroups(db);
    const input = groupInput([work("a"), work("b", { dependsOn: ["a"] }), integration("z", ["a", "b"])]);
    groups.create("g", input, "/repo", "base");
    groups.link("g", "a", "ta", "base");
    const result: StageResult = {
      stageId: "a", topicId: "ta", baseOID: "base", commitOID: "commit-a", reviewedTreeOID: "tree-a", planSHA256: "plan-a",
      evidenceDigest: null, verifications: [], memoryChanges: [], openQuestions: [], deferredFindings: [], decisions: [], closedAt: "2026-09-27T00:00:00.000Z",
    };
    if (order === "frozen-then-link") groups.freezeResult("g", result);
    groups.link("g", "b", "tb", "commit-a", { selected: true });
    if (order === "link-then-frozen") groups.freezeResult("g", result);
    const topics = [{ id: "ta", worktreePath: "/wa", state: "CLOSED" }, { id: "tb", worktreePath: "/wb", state: "DRAFT", scopeGeneration: 1 }];
    const database = {
      listTopics: () => topics, getTopic: (id: string) => topics.find((topic) => topic.id === id), workGroups: groups,
      topicForTurn: ({ cwd }: Pick<SessionTurn, "cwd">) => topics.find(topic => topic.worktreePath === cwd),
    } as unknown as ConsensusDatabase;
    const hooks = { onHead: null as null | (() => void), heads: 0 };
    const git = {
      diffTrees: async () => ({ files: [], patch: "" }),
      isAncestor: async () => true,
      changedPaths: async () => [],
      head: async (path: string) => {
        hooks.heads += 1;
        const hook = hooks.onHead;
        hooks.onHead = null;
        hook?.();
        return path === "/wa" ? "commit-a" : "other";
      },
    } as unknown as GitService;
    const seen: Array<Omit<SessionTurn, "sessionId">> = [];
    const inner: AgentAdapter = {
      role: "claude", validateExistingSession: async () => true,
      createSession: async (turn) => { seen.push(turn); return { sessionId: "s", result: { kind: "AUDIT", summary: "", findings: [], evidenceRefs: [] } }; },
      resumeTurn: async (turn) => { seen.push(turn); return { kind: "AUDIT", summary: "", findings: [], evidenceRefs: [] }; },
    };
    const revise = () => groups.applyRevision("g",
      groups.previewRevision("g", { ...input, contracts: "바뀐 공통 계약" }, groups.get("g").version, (topicId) => topicId === "ta"));
    // 단계 문맥 결속을 깨는 기록 — 연결·재결속 때 기록한 해시가 지금 문맥과 다르다.
    const breakBinding = () => {
      const record = groups.get("g");
      record.links.b.contextDigest = "stale";
      db.prepare("UPDATE work_groups SET record_json=? WHERE id=?").run(JSON.stringify(record), "g");
    };
    return { db, groups, hooks, seen, revise, breakBinding, wrapped: wrapWorkGroupAdapter(inner, database, git) };
  }

  it("선행 결과를 확인한 뒤 저장소 단계 문맥을 두 판(이어 쓰는 판·새 세션 판)에 똑같이 붙이고, 새 세션 판이 없으면 만들지 않는다", async () => {
    const { db, groups, hooks, seen, wrapped } = gate();
    await wrapped.resumeTurn({ sessionId: "s1", cwd: "/wb", prompt: "변경분-과제", freshSessionPrompt: "전체문맥-과제" });
    await wrapped.createSession({ cwd: "/wb", prompt: "새-과제" });
    const header = `${groups.renderStageContext(groups.get("g"), "b")}\n\n`;
    expect(hooks.heads).toBe(2);
    expect(seen[0].prompt).toBe(`${header}변경분-과제`);
    expect(seen[0].freshSessionPrompt).toBe(`${header}전체문맥-과제`);
    expect(seen[1].prompt).toBe(`${header}새-과제`);
    expect("freshSessionPrompt" in seen[1]).toBe(false);
    db.close();
  });

  // E4 전 흐름 — a 는 동결 결과, p 는 E4 전에 닫혀 결과가 없다(push 된 증거만). b 는 a·p 에 의존하는 열린 단계다.
  function legacyGate(bound: boolean) {
    const db = new DatabaseSync(":memory:"), groups = new WorkGroups(db);
    groups.create("g", groupInput([work("a"), work("p"), work("b", { dependsOn: ["a", "p"] }), integration("z", ["a", "p", "b"])]), "/repo", "base");
    groups.link("g", "a", "ta", "base");
    groups.freezeResult("g", {
      stageId: "a", topicId: "ta", baseOID: "base", commitOID: "commit-a", reviewedTreeOID: "tree-a", planSHA256: "plan-a", evidenceDigest: null,
      verifications: [], memoryChanges: [], openQuestions: [], deferredFindings: [], decisions: [], closedAt: "2026-09-27T00:00:00.000Z",
    });
    groups.link("g", "p", "tp", "base");
    groups.link("g", "b", "tb", "commit-a", { selected: true });
    const rewrite = (change: (record: { links: Record<string, { contextDigest?: string; groupVersion: number }> }) => void) => {
      const record = JSON.parse(String((db.prepare("SELECT record_json FROM work_groups WHERE id=?").get("g") as { record_json: string }).record_json));
      change(record);
      db.prepare("UPDATE work_groups SET record_json=? WHERE id=?").run(JSON.stringify(record), "g");
    };
    // bound=false: E4 전 연결(해시 없음, 묶음 버전 결속). bound=true: p 의 결과 없이 해시로 결속된 연결(재계획 완료로 해시를 얻은 E4 전 연결과 같은 상태).
    if (!bound) rewrite((record) => { delete record.links.b.contextDigest; });
    const updatedAt = "2026-09-26T00:00:00.000Z";
    const topics = [
      { id: "ta", worktreePath: "/wa", state: "CLOSED", updatedAt },
      { id: "tp", worktreePath: "/wp", state: "CLOSED", approvedPlanSHA256: "plan-p", updatedAt },
      { id: "tb", worktreePath: "/wb", state: "DRAFT", updatedAt },
    ];
    const database = {
      listTopics: () => topics, getTopic: (id: string) => topics.find((topic) => topic.id === id), workGroups: groups,
      topicForTurn: ({ cwd }: Pick<SessionTurn, "cwd">) => topics.find(topic => topic.worktreePath === cwd),
      getFlags: () => ({ committedOID: "commit-p", pushedOID: "commit-p", reviewedTreeOID: "tree-p" }),
    } as unknown as ConsensusDatabase;
    const git = {
      diffTrees: async () => ({ files: [], patch: "" }), isAncestor: async () => true, changedPaths: async () => [],
      head: async (path: string) => (path === "/wa" ? "commit-a" : path === "/wp" ? "commit-p" : "other"),
    } as unknown as GitService;
    const seen: Array<Omit<SessionTurn, "sessionId">> = [];
    const wrapped = wrapWorkGroupAdapter({
      role: "claude", validateExistingSession: async () => true,
      createSession: async (turn) => { seen.push(turn); return { sessionId: "s", result: { kind: "AUDIT", summary: "", findings: [], evidenceRefs: [] } }; },
      resumeTurn: async (turn) => { seen.push(turn); return { kind: "AUDIT", summary: "", findings: [], evidenceRefs: [] }; },
    }, database, git);
    return { db, groups, rewrite, seen, wrapped };
  }

  it("E4 전 연결(해시 없음)의 턴은 새 착수 없이 E4 전 선행 결과를 검증·동결하고, 묶음 버전으로만 결속한다", async () => {
    const { db, groups, rewrite, seen, wrapped } = legacyGate(false);
    await wrapped.resumeTurn({ sessionId: "s1", cwd: "/wb", prompt: "과제" });
    expect(groups.get("g").results?.p).toMatchObject({
      stageId: "p", topicId: "tp", commitOID: "commit-p", reviewedTreeOID: "tree-p", planSHA256: "plan-p", legacy: true, deferredFindings: [], decisions: [],
    });
    // 동결한 뒤의 머리말은 저장소 단계 문맥 그대로다(p 가 선행 결과로 실린다).
    expect(seen[0].prompt).toBe(`${groups.renderStageContext(groups.get("g"), "b")}\n\n과제`);
    expect(seen[0].prompt).toContain("p: commit commit-p");
    // 묶음 버전이 연결 때와 다르면(E4 전 개정) 턴을 시작하지 않는다.
    rewrite((record) => { record.links.b.groupVersion = 0; });
    await expect(wrapped.resumeTurn({ sessionId: "s1", cwd: "/wb", prompt: "과제" })).rejects.toThrow("작업 묶음 버전이 연결 때와 다릅니다.");
    expect(seen).toHaveLength(1);
    db.close();
  });

  it("동결하면 결속이 깨지는 E4 전 선행 결과는 동결하지 않고, 검증한 증거를 머리말에 옛 줄 형식으로 싣는다", async () => {
    const { db, groups, seen, wrapped } = legacyGate(true);
    await wrapped.resumeTurn({ sessionId: "s1", cwd: "/wb", prompt: "과제" });
    expect(groups.get("g").results?.p).toBeUndefined();
    expect(() => groups.assertStageContextCurrent("tb")).not.toThrow();
    const proof = [
      { stageId: "a", commit: "commit-a", planSHA: "plan-a", verification: "tree-a" },
      { stageId: "p", commit: "commit-p", planSHA: "plan-p", verification: "tree-p" },
    ];
    expect(seen[0].prompt).toBe(`${groups.prompt("tb", proof)}\n\n과제`);
    expect(seen[0].prompt).toContain("p: commit commit-p, plan SHA plan-p, 검증 tree-p");
    db.close();
  });

  // 개정은 영향 단계를 새 문맥으로 다시 묶는다 — 다음 턴을 막지 않고 머리말이 개정된 문맥이다(바뀐 문맥은 app 이 사실로도 남긴다, 계약 v3.18 (33')).
  it("개정된 단계는 새 문맥 머리말로 턴을 시작한다", async () => {
    const { db, seen, revise, wrapped } = gate();
    revise();
    await wrapped.createSession({ cwd: "/wb", prompt: "과제" });
    expect(seen).toHaveLength(1);
    expect(seen[0].prompt).toContain("바뀐 공통 계약");
    db.close();
  });

  it("연결 뒤 단계 문맥이 바뀌었으면(해시 불일치) 턴을 시작하지 않는다", async () => {
    const { db, hooks, seen, wrapped } = gate("link-then-frozen");
    await expect(wrapped.createSession({ cwd: "/wb", prompt: "과제" }))
      .rejects.toThrow("공통 계약이 바뀌었습니다. 현재 단계의 계획을 다시 승인해야 합니다.");
    expect(hooks.heads).toBe(0);
    expect(seen).toEqual([]);
    db.close();
  });

  it("선행 결과 확인(git) 중에 단계 문맥 결속이 깨지면 경계 뒤 재판정으로 턴을 시작하지 않는다", async () => {
    const { db, hooks, seen, breakBinding, wrapped } = gate();
    hooks.onHead = breakBinding;
    await expect(wrapped.resumeTurn({ sessionId: "s1", cwd: "/wb", prompt: "과제", freshSessionPrompt: "전체" }))
      .rejects.toThrow("공통 계약이 바뀌었습니다. 현재 단계의 계획을 다시 승인해야 합니다.");
    expect(hooks.heads).toBe(1);
    expect(seen).toEqual([]);
    db.close();
  });
});

// ---- 새 단계 토픽은 ticket 이고 계획 연속성 정책을 켜지 않는다(Codex 273, Q-e) ----
// 단계·묶음 입력에 계획 선택이 없다. 계획이 필요하면 공개 방식 전환으로 planned 를 고르고, 그 전환이 정책을 켠다. 기존 토픽의 정책은 바꾸지 않는다.
describe("새 단계 토픽의 방식과 계획 연속성 정책", () => {
  it("next 가 여는 새 단계 토픽은 ticket 이고 정책을 켜지 않으며, 이미 연결된 다른 단계 토픽의 정책은 바꾸지 않는다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), work("b"), integration("z", ["a", "b"])]));
    // E4 전처럼 계획 제어 없이 연결된 열린 단계 a(정책 0) — 외부 결정으로 막혀 b 를 선택 착수한다.
    const timestamp = new Date().toISOString();
    const legacy = fx.database.createTopic({ workflowMode: "planned", id: "legacy-a", slug: "legacy-a", title: "legacy a", repositoryPath: fx.repository,
      worktreePath: join(fx.root, "legacy-a"), baseRef: fx.base, branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0,
      planSHA256: null, approvedPlanSHA256: null, createdAt: timestamp, updatedAt: timestamp, lastError: null });
    fx.database.workGroups.link(group.id, "a", legacy.id, fx.base);
    expect(fx.database.planning.policyVersion(legacy.id)).toBe(0);
    fx.blocked.add(legacy.id);
    const b = await service.next(group.id, undefined, "b");
    expect(b.workflowMode).toBe("ticket");
    expect(fx.database.planning.policyVersion(b.id)).toBe(0);
    expect(fx.database.planning.continuityEnabled(b.id)).toBe(false);
    expect(fx.database.planning.policyVersion(legacy.id)).toBe(0);
  });

  it("링크가 실패하면 토픽도 정책도 남지 않고, 예약을 이어 열면 ticket 이고 정책을 켜지 않는다", async () => {
    const fx = fixture();
    const service = fx.service();
    const group = await service.create(groupInput([work("a"), integration("z", ["a"])]));
    const link = vi.spyOn(fx.database.workGroups, "link").mockImplementationOnce(() => { throw new Error("link failed"); });
    await expect(service.next(group.id)).rejects.toThrow("link failed");
    const reserved = fx.database.workGroups.get(group.id).pending!.a.topicId;
    expect(fx.database.listTopics().some((topic) => topic.id === reserved)).toBe(false);
    expect(fx.database.planning.policyVersion(reserved)).toBe(0);
    expect(fx.database.budgets.account(reserved)).toBeNull();
    link.mockRestore();
    const a = await service.next(group.id);
    expect(a.id).toBe(reserved);
    expect(a.workflowMode).toBe("ticket");
    expect(fx.database.planning.policyVersion(a.id)).toBe(0);
  });

  it("예약을 이어 열 때 토픽이 이미 있고 정책이 있으면 그 정책을 바꾸지 않는다", async () => {
    class InterruptedOnce extends GitService {
      created = 0;
      async createDetachedWorktree(repositoryPath: string, worktreePath: string, baseRef: string) {
        await super.createDetachedWorktree(repositoryPath, worktreePath, baseRef);
        if (++this.created === 1) throw new Error("interrupted after worktree");
      }
    }
    const fx = fixture(new InterruptedOnce(new SpawnCommandRunner()));
    const group = await fx.service().create(groupInput([work("a"), integration("z", ["a"])]));
    await expect(fx.service().next(group.id)).rejects.toThrow("interrupted after worktree");
    const reservation = fx.database.workGroups.get(group.id).pending!.a;
    // 예약된 토픽이 이미 있고, 실행 이력이 있어 정책이 v1 로 정해진 경우(이미 있는 정책) — 이어 여는 착수가 정책을 다시 고르지 않는다.
    const timestamp = new Date().toISOString();
    fx.database.createTopic({ workflowMode: "planned", id: reservation.topicId, slug: "stage-a", title: "묶음 · a 제목", repositoryPath: fx.repository,
      worktreePath: reservation.worktreePath, baseRef: reservation.baseOID, branchName: null, state: "DRAFT", scopeGeneration: 1, planRevision: 0,
      planSHA256: null, approvedPlanSHA256: null, createdAt: timestamp, updatedAt: timestamp, lastError: null });
    fx.database.startAction({ id: "earlier-run", topicId: reservation.topicId, kind: "plan", status: "running", createdAt: timestamp, finishedAt: null,
      error: null, pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null });
    fx.database.finishAction("earlier-run", "succeeded");
    fx.database.planning.enable(reservation.topicId);
    expect(fx.database.planning.policyVersion(reservation.topicId)).toBe(1);
    const a = await fx.service().next(group.id);
    expect(a.id).toBe(reservation.topicId);
    expect(fx.database.planning.policyVersion(a.id)).toBe(1);
  });
});

// 묶음 밖 선행 토픽 — 전달 커밋(committedOID)을 가진 일반 토픽. patch 로 저장소·전달 커밋을 바꾼다(null 이면 전달 커밋 없음).
function predecessor(fx: Fixture, patch: { repositoryPath?: string; committedOID?: string | null } = {}) {
  const id = randomUUID(), timestamp = new Date().toISOString();
  fx.database.createTopic({ workflowMode: "planned", id, slug: `pred-${id.slice(0, 8)}`, title: "선행", repositoryPath: patch.repositoryPath ?? fx.repository,
    worktreePath: join(fx.root, `pred-${id.slice(0, 8)}`), baseRef: fx.base, branchName: null, state: "READY_TO_DELIVER", scopeGeneration: 1,
    planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: timestamp, updatedAt: timestamp, lastError: null });
  if (patch.committedOID !== null) fx.database.updateTopic(id, { committedOID: patch.committedOID ?? fx.base });
  return id;
}

describe("생성 전용 입력 — 명시 기준 커밋·단계 브랜치·묶음 밖 선행 토픽", () => {
  it("명시 기준 커밋(ref)으로 묶음을 만들면 저장소 HEAD 가 달라도 첫 단계를 그 커밋에서 열고, 해석할 수 없는 ref 는 묶음을 만들지 않고 거부한다", async () => {
    const fx = fixture();
    const service = fx.service();
    run(fx.repository, "branch", "stacked", fx.base);
    writeFileSync(join(fx.repository, "later.txt"), "later\n");
    run(fx.repository, "add", ".");
    run(fx.repository, "commit", "-qm", "later");
    const head = run(fx.repository, "rev-parse", "HEAD");
    // 입력이 없으면 기존대로 저장소 HEAD 다.
    expect((await service.create(groupInput([work("a"), integration("z", ["a"])]))).baseOID).toBe(head);
    const group = await service.create(groupInput([work("a"), integration("z", ["a"])]), undefined, { baseRef: "stacked" });
    expect(group.baseOID).toBe(fx.base);
    const a = await service.next(group.id);
    expect(fx.database.workGroups.get(group.id).links.a.baseOID).toBe(fx.base);
    expect(run(a.worktreePath, "rev-parse", "HEAD")).toBe(fx.base);
    const count = fx.database.workGroups.list().length;
    await expect(service.create(groupInput([work("a"), integration("z", ["a"])]), undefined, { baseRef: "no-such-ref" }))
      .rejects.toThrow("작업 묶음 기준 커밋을 찾을 수 없습니다: no-such-ref");
    await expect(service.create(groupInput([work("a"), integration("z", ["a"])]), undefined, { baseRef: "-x" }))
      .rejects.toThrow("기준 리비전은 '-'로 시작할 수 없습니다.");
    expect(fx.database.workGroups.list()).toHaveLength(count);
  });

  it("단계 토픽은 묶음 접두사와 단계 브랜치 이름을 받고, 입력이 없으면 기존 값(consensus·요청 없음)이다. 단계끼리 같은 브랜치 이름은 거부한다", async () => {
    const fx = fixture();
    const service = fx.service();
    const named = await service.create(groupInput([work("a", { branchName: "feature/T-1-a" }), work("b"), integration("z", ["a", "b"])]),
      undefined, { branchPrefix: "feature" });
    const a = await service.next(named.id);
    expect(fx.database.getTopic(a.id)).toMatchObject({ branchPrefix: "feature", requestedBranchName: "feature/T-1-a" });
    closeStage(fx, named.id, "a", "2026-09-28T01:00:00.000Z");
    const b = await service.next(named.id);
    expect(fx.database.getTopic(b.id)).toMatchObject({ branchPrefix: "feature", requestedBranchName: null });
    const plain = await service.create(groupInput([work("a"), integration("z", ["a"])]));
    const plainA = await service.next(plain.id);
    expect(fx.database.getTopic(plainA.id)).toMatchObject({ branchPrefix: "consensus", requestedBranchName: null });
    await expect(service.create(groupInput([work("a", { branchName: "feature/same" }), { ...integration("z", ["a"]), branchName: "feature/same" }])))
      .rejects.toThrow("단계 브랜치 이름이 겹칩니다: a(feature/same) ↔ z(feature/same)");
  });

  it("묶음 밖 선행 토픽은 생성 때 세대·전달 커밋·보류 원장을 묶음 레코드에 동결하고, 뒤에 선행 토픽이 바뀌어도 동결 기록은 그대로다", async () => {
    const fx = fixture();
    const service = fx.service();
    const predecessorId = predecessor(fx);
    const carried: DeferredFinding = { id: "P-1", title: "선행 토픽이 미룬 개선", severity: "LOW", rationale: "다음 단계에서 판단",
      source: "closeout", topicId: predecessorId, recordedAt: "2026-09-27T00:00:00.000Z" };
    fx.ledgers.set(predecessorId, [carried]);
    const group = await service.create(groupInput([work("a"), work("b", { dependsOn: ["a"] }), integration("z", ["a", "b"])]),
      undefined, { predecessorTopicId: predecessorId });
    expect(group.predecessor).toEqual({ topicId: predecessorId, scopeGeneration: 1, committedOID: fx.base, deferredFindings: [carried],
      frozenAt: expect.any(String) });
    // 단계 토픽은 선행 토픽을 참조하지 않는다 — 선행 토픽의 근거는 묶음 레코드(predecessor)에 동결된다.
    const a = await service.next(group.id);
    expect(fx.database.getTopic(a.id).predecessorTopicId).toBeNull();
    // 생성 뒤 선행 토픽이 바뀌어도(원장 교체·전달 커밋 해제 — 범위 변경이 남기는 모양) 동결한 근거는 그대로다.
    fx.ledgers.set(predecessorId, []);
    fx.database.updateTopic(predecessorId, { committedOID: null });
    closeStage(fx, group.id, "a", "2026-09-28T01:00:00.000Z");
    const b = await service.next(group.id);
    expect(fx.database.getTopic(b.id).predecessorTopicId).toBeNull();
    expect(fx.database.workGroups.get(group.id).predecessor).toEqual(group.predecessor);
    expect(fx.database.workGroups.get(group.id).predecessor?.deferredFindings).toEqual([carried]);
  });

  it("묶음 밖 선행 토픽은 같은 저장소이고 전달 커밋이 기준에 포함돼야 하며, 원장을 읽을 수 없거나 읽는 사이 바뀌면 묶음을 만들지 않는다", async () => {
    const fx = fixture();
    const service = fx.service();
    const input = groupInput([work("a"), integration("z", ["a"])]);
    await expect(service.create(input, undefined, { predecessorTopicId: randomUUID() })).rejects.toThrow("선행 토픽을 찾을 수 없습니다");
    await expect(service.create(input, undefined, { predecessorTopicId: predecessor(fx, { repositoryPath: join(fx.root, "other") }) }))
      .rejects.toThrow("다른 저장소의 토픽입니다");
    await expect(service.create(input, undefined, { predecessorTopicId: predecessor(fx, { committedOID: null }) }))
      .rejects.toThrow("전달(커밋)한 결과가 없습니다");
    await expect(fx.service(undefined, { deferredFindingsOf: undefined }).create(input, undefined, { predecessorTopicId: predecessor(fx) }))
      .rejects.toThrow("선행 토픽의 보류 원장을 읽을 수 없어");
    const moving = predecessor(fx);
    await expect(fx.service(undefined, { deferredFindingsOf: async (topicId) => {
      fx.database.updateTopic(topicId, { committedOID: null });
      return [];
    } }).create(input, undefined, { predecessorTopicId: moving })).rejects.toThrow(`선행 토픽 ${moving} 이(가) 확인하는 동안 바뀌었습니다.`);
    run(fx.repository, "checkout", "-qb", "side", fx.base);
    writeFileSync(join(fx.repository, "side.txt"), "side\n");
    run(fx.repository, "add", ".");
    run(fx.repository, "commit", "-qm", "side");
    const side = run(fx.repository, "rev-parse", "HEAD");
    await expect(service.create(input, undefined, { baseRef: fx.base, predecessorTopicId: predecessor(fx, { committedOID: side }) }))
      .rejects.toThrow(`선행 토픽의 전달 커밋 ${side} 가 작업 묶음 기준 커밋 ${fx.base} 에 포함되지 않았습니다.`);
    expect(fx.database.workGroups.list()).toHaveLength(0);
  });
});
