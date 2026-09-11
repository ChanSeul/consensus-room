import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { EngineCore } from "../src/server/engine/core";
import { preparePlanningContext } from "../src/server/engine/planningContext";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import { hashPlan } from "../src/shared/workflow";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "planning-context-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, "worktree"));
  const db = new ConsensusDatabase(join(root, "room.sqlite"));
  cleanup.push(async () => db.close());
  const old = Array.from({ length: 1000 }, (_, index) => `line ${index}: original`).join("\n") + "\n";
  const current = old.replace("line 500: original", "line 500: revised");
  db.createTopic({ id: "topic", slug: "plan", title: "계획", repositoryPath: root, worktreePath: join(root, "worktree"),
    baseRef: "HEAD", branchName: null, state: "CODEX_CLOSEOUT", scopeGeneration: 1, planRevision: 2,
    planSHA256: hashPlan(current), approvedPlanSHA256: null, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  db.upsertParticipant("topic", { role: "codex", sessionId: "session", mode: "attached", acknowledgedPlanSHA256: null });
  const artifacts = new ArtifactStore(join(root, "topics"), db);
  await artifacts.write("topic", "plan", 1, old);
  await artifacts.write("topic", "plan", 2, current);
  db.appendEvent({ topicId: "topic", actor: "user", kind: "evidence", state: "CODEX_CLOSEOUT", body: "OLD" });
  const cursor = { sessionId: "session", scopeGeneration: 1, planEpoch: db.getTopic("topic").planEpoch, planSHA256: hashPlan(old), sequence: 1 };
  await artifacts.write("topic", "codex-planning-cursor", 1, JSON.stringify(cursor));
  db.appendEvent({ topicId: "topic", actor: "user", kind: "decision", state: "CODEX_CLOSEOUT", body: "NEW" });
  const unused = async () => { throw new Error("모델 호출 없음"); };
  const core = new EngineCore({ database: db, artifacts, git: new GitService(new SpawnCommandRunner()),
    claude: { role: "claude", createSession: unused, resumeTurn: unused, validateExistingSession: unused },
    codex: { role: "codex", createSession: unused, resumeTurn: unused, validateExistingSession: unused } });
  return { root, db, artifacts, core, old, current, cursor,
    prepare: () => preparePlanningContext(core, db.getTopic("topic"), current, hashPlan(current)) };
}

describe("검증된 계획 정본으로 만드는 변경분", () => {
  it("직전 전달본과 실제 Git diff를 만들고 새 결정만 전달한다", async () => {
    const f = await fixture();
    const context = await f.prepare();
    expect(context.mode).toBe("delta");
    expect(context.text).toContain("-line 500: original");
    expect(context.text).toContain("+line 500: revised");
    expect(context.text).not.toContain("line 100: original");
    expect(context.readablePaths).toHaveLength(2);
    expect(context.timeline.map((event) => event.body)).toEqual(["NEW"]);
    const before = await f.artifacts.readLatest("topic", "codex-planning-cursor");
    await expect(context.accept(AbortSignal.abort(), "prompt")).rejects.toThrow();
    expect(await f.artifacts.readLatest("topic", "codex-planning-cursor")).toBe(before);
  });

  it.each(["session", "epoch", "scope", "legacy", "corrupt", "oversized-diff"])("%s에서는 전문과 전체 증거로 복구한다", async (reason) => {
    const f = await fixture();
    if (reason === "session") f.db.upsertParticipant("topic", { role: "codex", sessionId: "new-session", mode: "attached", acknowledgedPlanSHA256: null });
    if (reason === "epoch") f.db.updateTopic("topic", { planEpoch: f.cursor.planEpoch + 1 });
    if (reason === "scope") await f.artifacts.write("topic", "codex-planning-cursor", 2, JSON.stringify({ ...f.cursor, scopeGeneration: 99 }));
    if (reason === "legacy") await f.artifacts.write("topic", "codex-planning-cursor", 2, "{}");
    if (reason === "corrupt") await writeFile((await f.artifacts.verifiedRevision("topic", "plan", hashPlan(f.old)))!.path, "broken");
    if (reason === "oversized-diff") f.core.dependencies.git.diffPlanFiles = async () => "diff".repeat(10000);
    const context = await f.prepare();
    expect(context.mode).toBe("full");
    expect(context.text).toBe(f.current);
    expect(context.timeline.map((event) => event.body)).toEqual(["OLD", "NEW"]);
  });

  it("현재 정본 손상은 변경분 폴백으로 숨기지 않고 차단한다", async () => {
    const f = await fixture();
    await writeFile(f.db.latestArtifact("topic", "plan")!.path, "broken");
    await expect(f.prepare()).rejects.toThrow();
  });
});
