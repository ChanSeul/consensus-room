import { readdir, rm, stat, statfs } from "node:fs/promises";
import { join } from "node:path";

// 닫힌 주제의 worktree 에서 빌드 트리만 지운다(2026-09-07 Codex 2차 제안 ④: 닫힌 주제 8개가 48.8GiB 를 쥐고 있었다).
// 대상은 `<worktree>/DerivedData/*` 중 이름이 `-logs` 로 끝나지 않는 디렉터리뿐이다 — `*-logs` 는 다음 단계가
// rsync 로 물려받는 도구·증거 트리라 남긴다(S9/S10 이 s6·s7·s8-logs 를 승계). worktree 자체와 git 상태는 건드리지 않는다.
export interface BuildTreePruneReport {
  removed: string[];
  kept: string[];
  freedBytes: number;
}

export async function pruneBuildTrees(worktreePath: string): Promise<BuildTreePruneReport> {
  const derived = join(worktreePath, "DerivedData");
  const before = await freeBytes(derived);
  let entries: string[];
  try {
    entries = await readdir(derived);
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return { removed: [], kept: [], freedBytes: 0 };
    throw error;
  }
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of entries.sort()) {
    const path = join(derived, name);
    const info = await stat(path).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (name.endsWith("-logs")) {
      kept.push(name);
      continue;
    }
    await rm(path, { recursive: true, force: true });
    removed.push(name);
  }
  const after = await freeBytes(derived);
  return { removed, kept, freedBytes: Math.max(0, after - before) };
}

async function freeBytes(path: string): Promise<number> {
  try {
    const fs = await statfs(path);
    return Number(fs.bavail) * Number(fs.bsize);
  } catch {
    return 0;
  }
}

export function describePrune(report: BuildTreePruneReport): string {
  const gib = (report.freedBytes / 1024 ** 3).toFixed(1);
  const removed = report.removed.length > 0 ? report.removed.join(", ") : "(없음)";
  const kept = report.kept.length > 0 ? report.kept.join(", ") : "(없음)";
  return `빌드 트리 정리: ${report.removed.length}개 삭제(약 ${gib} GiB 확보) — ${removed}. 보존: ${kept}.`;
}
