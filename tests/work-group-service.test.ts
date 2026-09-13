import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { WorkGroupService } from "../src/server/workGroupService";
import { DEFAULT_AGENT_SETTINGS } from "../src/shared/contracts";
import type { GitService } from "../src/server/git";

it("선행 단계가 전달된 뒤 그 커밋으로 다음 토픽을 만들고 각 단계 승인을 보존한다", async () => {
  const root = mkdtempSync(join(tmpdir(), "group-service-")),
    database = new ConsensusDatabase(join(root, "db"));
  let failFirst = true;
  const heads = new Map<string, string>([[root, "base"]]),
    created: string[] = [];
  const git = {
    changedPaths: async () => [],
    head: async (path: string) => heads.get(path)!,
    createDetachedWorktree: async (
      _repo: string,
      path: string,
      base: string,
    ) => {
      created.push(base);
      mkdirSync(path, { recursive: true });
      heads.set(path, base);
      if (failFirst) {
        failFirst = false;
        throw new Error("interrupted after worktree");
      }
    },
  } as unknown as GitService;
  const service = new WorkGroupService(
    database,
    git,
    root,
    join(root, "trees"),
    DEFAULT_AGENT_SETTINGS,
  );
  const budget = {
    execution: { inputTokens: 100, outputTokens: 100, durationMs: 1000 },
    total: { inputTokens: 1000, outputTokens: 1000, durationMs: 10000 },
  };
  const group = await service.create({
    title: "큰 작업",
    goal: "전체",
    contracts: "동작 보존",
    stages: [
      {
        id: "one",
        kind: "work",
        title: "구현",
        goal: "첫 단계",
        acceptance: "단위 검증",
        dependsOn: [],
        budget,
      },
      {
        id: "two",
        kind: "integration",
        title: "통합",
        goal: "전체 검증",
        acceptance: "회귀 검증",
        dependsOn: ["one"],
        budget,
      },
    ],
  });
  try {
    await expect(service.next(group.id)).rejects.toThrow(
      "interrupted after worktree",
    );
    const first = await new WorkGroupService(
      database,
      git,
      root,
      join(root, "trees"),
      DEFAULT_AGENT_SETTINGS,
    ).next(group.id);
    expect(first.state).toBe("DRAFT");
    expect(first.approvedPlanSHA256).toBeNull();
    await expect(service.next(group.id)).rejects.toThrow("승인·리뷰·푸시");
    expect(created).toEqual(["base"]);
    database.updateTopic(first.id, {
      state: "CLOSED",
      approvedPlanSHA256: "a".repeat(64),
      committedOID: "delivered",
      pushedOID: "delivered",
      reviewedTreeOID: "tree",
    });
    await expect(service.next(group.id)).rejects.toThrow("전달 커밋");
    heads.set(first.worktreePath, "delivered");
    const second = await service.next(group.id);
    expect(second.state).toBe("DRAFT");
    expect(second.approvedPlanSHA256).toBeNull();
    expect(created).toEqual(["base", "delivered"]);
    expect(database.budgets.account(group.id)?.policy.total.inputTokens).toBe(
      2000,
    );
    expect(database.getTimeline(second.id)[0].body).toContain(
      "commit delivered",
    );
    expect(database.getTimeline(second.id)[0].body).toContain("전체 검증");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
