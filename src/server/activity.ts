import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

// 러너 생존 표시(2026-09-08 사용자 요청 "구현 중이라고 뜨는데 일하고 있는 게 아니야?"). 방 화면은 상태만 보여 주고
// 러너가 지금 무엇을 만지는지는 안 보여서 2시간짜리 도구 턴이 멈춘 것처럼 보였다. 작업 트리의 최근 변경 시각·경로를
// 짧게 훑어 상단바에 "러너 활동 N초 전 · 파일" 로 보여 준다. 빌드 트리(DerivedData/*)는 크고 무의미하므로 *-logs 만 본다.
export interface WorktreeActivity {
  lastChangeAt: string | null;
  lastChangedPath: string | null;
  scanned: number;
  truncated: boolean;
}

const SKIP_NAMES = new Set([".git", "node_modules", "Derived", ".build", ".swiftpm", "Pods", ".tuist"]);

export async function scanWorktreeActivity(worktreePath: string, maxEntries = 40_000): Promise<WorktreeActivity> {
  let latest = 0;
  let latestPath: string | null = null;
  let scanned = 0;
  let truncated = false;
  const queue: string[] = [worktreePath];
  while (queue.length > 0) {
    const directory = queue.shift()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (scanned >= maxEntries) { truncated = true; break; }
      const full = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_NAMES.has(entry.name)) continue;
        if (relative(worktreePath, directory) === "DerivedData" && !entry.name.endsWith("-logs")) continue;
        queue.push(full);
        continue;
      }
      if (!entry.isFile()) continue;
      scanned += 1;
      try {
        const info = await stat(full);
        if (info.mtimeMs > latest) { latest = info.mtimeMs; latestPath = relative(worktreePath, full); }
      } catch {
        // 스캔 도중 지워진 파일은 건너뛴다.
      }
    }
    if (truncated) break;
  }
  return { lastChangeAt: latest ? new Date(latest).toISOString() : null, lastChangedPath: latestPath, scanned, truncated };
}
