import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeStore(): { store: ArtifactStore; database: ConsensusDatabase; root: string } {
  const root = mkdtempSync(join(tmpdir(), "consensus-room-artifacts-"));
  temporaryDirectories.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite"));
  database.createTopic({
    id: "topic-1",
    slug: "plan",
    title: "계획",
    repositoryPath: "/tmp/repository",
    baseRef: "HEAD",
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
  return { store: new ArtifactStore(join(root, "topics"), database), database, root };
}

describe("계획 산출물", () => {
  it("새 계획 버전을 저장하면 공개 plan.md와 해시 경로가 같은 내용을 가리킨다", async () => {
    const { store, database, root } = makeStore();

    const artifact = await store.write("topic-1", "plan", 1, "# 계획\n\n첫 버전\n");

    expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(readFileSync(artifact.path, "utf8")).toBe("# 계획\n\n첫 버전\n");
    expect(readFileSync(join(root, "topics", "topic-1", "plan.md"), "utf8")).toBe(
      "# 계획\n\n첫 버전\n",
    );
    expect(await store.readLatest("topic-1", "plan")).toBe("# 계획\n\n첫 버전\n");
    database.close();
  });

  it("계획을 고쳐도 이전 해시 산출물을 덮어쓰지 않고 최신 공개본만 교체한다", async () => {
    const { store, database, root } = makeStore();

    const first = await store.write("topic-1", "plan", 1, "첫 버전");
    const second = await store.write("topic-1", "plan", 2, "둘째 버전");

    expect(first.path).not.toBe(second.path);
    expect(readFileSync(first.path, "utf8")).toBe("첫 버전");
    expect(readFileSync(second.path, "utf8")).toBe("둘째 버전");
    expect(readFileSync(join(root, "topics", "topic-1", "plan.md"), "utf8")).toBe("둘째 버전");
    expect(await store.readLatest("topic-1", "plan")).toBe("둘째 버전");
    database.close();
  });

  it("범위 세대가 바뀌면 이전 계획은 현재 계획으로 조회하지 않고 새 revision 번호는 충돌하지 않는다", async () => {
    const { store, database } = makeStore();
    const first = await store.write("topic-1", "plan", 2, "이전 범위 계획");

    database.updateTopic("topic-1", { scopeGeneration: 2, planRevision: 0, planSHA256: null });
    await store.clearCurrentAliases("topic-1");

    expect(await store.readLatest("topic-1", "plan")).toBeNull();
    const second = await store.write("topic-1", "plan", 1, "새 범위 계획", { scopeGeneration: 2 });
    expect(second.revision).toBeGreaterThan(first.revision);
    expect(second.scopeGeneration).toBe(2);
    expect(await store.readLatest("topic-1", "plan")).toBe("새 범위 계획");
    expect(readFileSync(first.path, "utf8")).toBe("이전 범위 계획");
    database.close();
  });

  it("산출물 commit boundary에서 범위가 달라지면 공개본과 DB 최신본을 바꾸지 않는다", async () => {
    const { store, database, root } = makeStore();

    await expect(store.write("topic-1", "plan", 1, "늦은 계획", {
      scopeGeneration: 1,
      accept: () => false,
    })).rejects.toThrow("이전 범위");

    expect(database.latestArtifact("topic-1", "plan")).toBeNull();
    expect(() => readFileSync(join(root, "topics", "topic-1", "plan.md"), "utf8")).toThrow();
    database.close();
  });
});


// 감사 ⑧: 기록된 SHA-256과 다른 파일 본문이 조용히 반환되면 승인한 계획과 다른 본문으로 구현이 시작된다.
describe("아티팩트 무결성", () => {
  it("파일이 기록된 해시와 다르면 변조로 보고 읽기를 거부한다", async () => {
    const { store, database } = makeStore();
    const artifact = await store.write("topic-1", "plan", 1, "# 승인된 계획\n");

    writeFileSync(artifact.path, "# ALTERED\n");

    await expect(store.readLatest("topic-1", "plan")).rejects.toThrow("SHA-256과 다릅니다");
    // DB 기록은 그대로여야 한다 — 변조를 덮어쓰지 않는다.
    expect(database.latestArtifact("topic-1", "plan")?.sha256).toBe(artifact.sha256);
  });
});
