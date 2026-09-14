import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { scanWorktreeActivity } from "../src/server/activity";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

describe("러너 생존 표시 — 작업 트리 최근 변경", () => {
  it("가장 최근에 바뀐 파일을 돌려주되 .git 과 *-logs 가 아닌 DerivedData 는 보지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-activity-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "DerivedData", "gate2-B1-a1"), { recursive: true });
    mkdirSync(join(root, "DerivedData", "s10-logs", "artifacts"), { recursive: true });
    mkdirSync(join(root, "src"));
    const old = new Date("2026-09-08T00:00:00Z");
    const newer = new Date("2026-09-08T01:00:00Z");
    const newest = new Date("2026-09-08T02:00:00Z");
    for (const [path, time] of [
      ["src/a.swift", old], [".git/HEAD", newest], ["DerivedData/gate2-B1-a1/build.log", newest],
      ["DerivedData/s10-logs/artifacts/p0.log", newer],
    ] as const) {
      writeFileSync(join(root, path), "x");
      utimesSync(join(root, path), time, time);
    }
    const activity = await scanWorktreeActivity(root);
    expect(activity.lastChangedPath).toBe("DerivedData/s10-logs/artifacts/p0.log");
    expect(activity.lastChangeAt).toBe(newer.toISOString());
    expect(activity.truncated).toBe(false);
    expect(activity.scanned).toBe(2);
  });

  it("상한이 큰 트리보다 작아도 DerivedData/*-logs 와 docs 를 먼저 봐서 러너 산출물을 놓치지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-activity-priority-"));
    temporaryDirectories.push(root);
    mkdirSync(join(root, "Modules", "Big"), { recursive: true });
    mkdirSync(join(root, "DerivedData", "s11-logs", "artifacts"), { recursive: true });
    const old = new Date("2026-09-14T00:00:00Z");
    const newest = new Date("2026-09-14T01:00:00Z");
    for (let index = 0; index < 50; index += 1) {
      writeFileSync(join(root, "Modules", "Big", `f${index}.swift`), "x");
      utimesSync(join(root, "Modules", "Big", `f${index}.swift`), old, old);
    }
    writeFileSync(join(root, "DerivedData", "s11-logs", "artifacts", "p1.log"), "x");
    utimesSync(join(root, "DerivedData", "s11-logs", "artifacts", "p1.log"), newest, newest);
    const activity = await scanWorktreeActivity(root, 10);
    expect(activity.truncated).toBe(true);
    expect(activity.lastChangedPath).toBe("DerivedData/s11-logs/artifacts/p1.log");
    expect(activity.lastChangeAt).toBe(newest.toISOString());
  });

  it("빈 트리는 null 을 돌려주고, 상한을 넘으면 truncated 를 표시한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-activity-empty-"));
    temporaryDirectories.push(root);
    expect(await scanWorktreeActivity(root)).toMatchObject({ lastChangeAt: null, lastChangedPath: null, scanned: 0 });
    for (let index = 0; index < 5; index += 1) writeFileSync(join(root, `f${index}.txt`), "x");
    expect((await scanWorktreeActivity(root, 3)).truncated).toBe(true);
  });
});
