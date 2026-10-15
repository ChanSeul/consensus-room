import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it } from "vitest";
import { pruneBuildTrees } from "../src/server/buildTrees";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "prune-test-")); roots.push(root);
  const worktree = join(root, "worktree"); mkdirSync(worktree);
  const file = (path: string) => {
    mkdirSync(join(worktree, path), { recursive: true });
    writeFileSync(join(worktree, path, "data"), "cache");
  };
  return { root, worktree, file };
}
it("previews then removes only named caches while preserving evidence, work folders and unknown files", async () => {
  const { worktree, file } = fixture();
  const caches = ["DerivedData/Build", "DerivedData/job/Index.noindex", "DerivedData/ModuleCache.noindex", "Tuist/.build"];
  const protectedPaths = ["DerivedData/job/Logs", "DerivedData/job/TestResults", "DerivedData/job/unknown", "DerivedData/s7-logs/Build", "DerivedData/s7-work/Build"];
  [...caches, ...protectedPaths].forEach(file);
  const preview = await pruneBuildTrees(worktree, { dryRun: true });
  expect(preview.candidates.map(item => item.path).sort()).toEqual(caches.sort());
  expect(preview.candidates.every(item => item.bytes === 5 && !item.removed)).toBe(true);
  [...caches, ...protectedPaths].forEach(path => expect(readFileSync(join(worktree, path, "data"), "utf8")).toBe("cache"));
  const result = await pruneBuildTrees(worktree);
  expect(result.removed.sort()).toEqual(caches.sort());
  expect(result.freedBytes).toBe(20);
  protectedPaths.forEach(path => expect(readFileSync(join(worktree, path, "data"), "utf8")).toBe("cache"));
});
it("preserves linked roots, ancestors, cache children and nested evidence", async () => {
  const { root, worktree, file } = fixture();
  file("DerivedData/job/Build/Logs"); file("DerivedData/Index");
  const outside = join(root, "outside"); mkdirSync(join(outside, ".build"), { recursive: true });
  writeFileSync(join(outside, ".build", "precious"), "keep");
  symlinkSync(outside, join(worktree, "Tuist"));
  symlinkSync(outside, join(worktree, "DerivedData", "Index", "link"));
  symlinkSync(outside, join(worktree, "DerivedData", "ModuleCache"));
  const report = await pruneBuildTrees(worktree);
  expect(report.removed).toEqual([]);
  expect(report.candidates.filter(candidate => candidate.reason)).toHaveLength(3);
  expect(readFileSync(join(outside, ".build", "precious"), "utf8")).toBe("keep");
  const alias = join(root, "alias"); symlinkSync(worktree, alias);
  expect((await pruneBuildTrees(alias)).removed).toEqual([]);
});
it("rechecks activity immediately before deletion and preserves caches when a new action appears", async () => {
  const { worktree, file } = fixture(); file("DerivedData/Build");
  let calls = 0;
  const report = await pruneBuildTrees(worktree, { protection: () => ++calls === 1 ? [] : ["new action"] });
  expect(report.removed).toEqual([]);
  expect(report.candidates[0].reason).toBe("new action");
  expect(existsSync(join(worktree, "DerivedData/Build/data"))).toBe(true);
});
it("revalidates root identity after a preview starts and honors cancellation", async () => {
  const { root, worktree, file } = fixture(); file("DerivedData/Build");
  const original = join(root, "original");
  const report = await pruneBuildTrees(worktree, { protection: () => {
    renameSync(worktree, original); mkdirSync(worktree); mkdirSync(join(worktree, "DerivedData/Build"), { recursive: true }); return [];
  } });
  expect(report.removed).toEqual([]);
  expect(report.candidates[0].reason).toContain("작업 폴더 경로가 바뀌었습니다");
  expect(existsSync(join(original, "DerivedData/Build/data"))).toBe(true);
  const controller = new AbortController(); controller.abort(new Error("cancelled"));
  await expect(pruneBuildTrees(original, { signal: controller.signal })).rejects.toThrow("cancelled");
});

it("preserves confirmed deletions in the report when cancellation stops the next candidate", async () => {
  const { worktree, file } = fixture(); file("DerivedData/Build"); file("DerivedData/Index");
  const controller = new AbortController(); let checks = 0;
  const report = await pruneBuildTrees(worktree, { signal: controller.signal, protection: () => {
    if (++checks === 3) controller.abort(new Error("cancelled")); return [];
  } });
  expect(report).toMatchObject({ cancelled: true, removed: ["DerivedData/Build"], incomplete: [], freedBytes: 5 });
  expect(existsSync(join(worktree, "DerivedData/Index/data"))).toBe(true);
});
