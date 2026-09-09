import { execFileSync, spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import {
  ProcessSupervisor,
  systemProcessControl,
  type ProcessControl,
  type ProcessIdentity,
  type ProcessRecoveryReport,
} from "../src/server/processSupervisor";
import type { ActionRecord } from "../src/server/types";

// C 로케일 `ps -o lstart=` 포맷: "Sun Aug 23 18:38:50 2026"
const C_LOCALE_START_TIME = /^[A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

describe("재시작 프로세스 감독", () => {
  it("PID·PGID·명령·시작 시각이 모두 같을 때 기록된 process group만 종료한다", async () => {
    const identity: ProcessIdentity = {
      pgid: 4201,
      commandLine: "claude --resume session-1",
      startedAt: "Sun Aug 23 14:00:00 2026",
    };
    let running = true;
    const signals: Array<{ pid: number; pgid: number; signal: NodeJS.Signals }> = [];
    const control: ProcessControl = {
      inspect: () => running ? identity : null,
      terminateGroup: (pid, pgid, signal) => {
        signals.push({ pid, pgid, signal });
        running = false;
      },
      wait: async () => {},
    };

    await new ProcessSupervisor(control).recover([actionFor(identity)]);

    expect(signals).toEqual([{ pid: 4201, pgid: 4201, signal: "SIGTERM" }]);
  });

  it("시작 시각이 다른 PID는 재사용된 프로세스로 보고 종료하지 않는다", async () => {
    const recorded: ProcessIdentity = {
      pgid: 4201,
      commandLine: "claude --resume session-1",
      startedAt: "Sun Aug 23 14:00:00 2026",
    };
    const current = { ...recorded, startedAt: "Sun Aug 23 14:01:00 2026" };
    const signals: NodeJS.Signals[] = [];
    const control: ProcessControl = {
      inspect: () => current,
      terminateGroup: (_pid, _pgid, signal) => { signals.push(signal); },
      wait: async () => {},
    };

    await new ProcessSupervisor(control).recover([actionFor(recorded)]);

    expect(signals).toEqual([]);
  });

  it("허용한 CLI가 아닌 원장 행은 일치 여부를 조사하지 않는다", async () => {
    let inspections = 0;
    const control: ProcessControl = {
      inspect: () => { inspections += 1; return null; },
      terminateGroup: () => {},
      wait: async () => {},
    };
    const action = actionFor({
      pgid: 4201,
      commandLine: "node server.js",
      startedAt: "Sun Aug 23 14:00:00 2026",
    });
    action.processExecutable = "node";

    await new ProcessSupervisor(control).recover([action]);

    expect(inspections).toBe(0);
  });

  it("원장 시작 시각이 다른 로케일 포맷이면 종료를 건너뛴 사실을 보고한다", async () => {
    const recorded: ProcessIdentity = {
      pgid: 4201,
      commandLine: "claude --resume session-1",
      startedAt: "2026년  8월 23일 일요일 16시 36분 50초",
    };
    const observed: ProcessIdentity = { ...recorded, startedAt: "Sun Aug 23 16:36:50 2026" };
    const signals: NodeJS.Signals[] = [];
    const reports: ProcessRecoveryReport[] = [];
    const control: ProcessControl = {
      inspect: () => observed,
      terminateGroup: (_pid, _pgid, signal) => { signals.push(signal); },
      wait: async () => {},
    };

    await new ProcessSupervisor(control, (report) => { reports.push(report); })
      .recover([actionFor(recorded)]);

    expect(signals).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0].outcome).toBe("identity-mismatch");
    expect(reports[0].action.id).toBe("action-1");
    expect(reports[0].action.processStartedAt).toBe(recorded.startedAt);
    expect(reports[0].observed?.startedAt).toBe(observed.startedAt);
  });

  it("원장 PID가 이미 사라졌으면 회수 실패와 구분해서 보고한다", async () => {
    const recorded: ProcessIdentity = {
      pgid: 4201,
      commandLine: "claude --resume session-1",
      startedAt: "Sun Aug 23 14:00:00 2026",
    };
    const reports: ProcessRecoveryReport[] = [];
    const control: ProcessControl = {
      inspect: () => null,
      terminateGroup: () => { throw new Error("사라진 PID의 group을 건드리면 안 됩니다."); },
      wait: async () => {},
    };

    await new ProcessSupervisor(control, (report) => { reports.push(report); })
      .recover([actionFor(recorded)]);

    expect(reports.map((report) => report.outcome)).toEqual(["already-gone"]);
  });

  it("leader가 죽고 group에 프로세스가 남으면 죽이지 않고 잔존 PID를 보고한다", async () => {
    // 신원 기록은 leader뿐이다. leader 없는 group을 그대로 죽이면 PGID 재사용 시 무관한 프로세스를 오살한다.
    const reports: ProcessRecoveryReport[] = [];
    const leader = spawn(process.execPath, ["-e", [
      "const { spawn } = require('node:child_process');",
      "const survivor = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      "console.log(JSON.stringify({ survivor: survivor.pid }));",
      "setTimeout(() => process.exit(0), 50);",
    ].join("\n")], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
    const leaderPID = leader.pid!;
    let survivorPID = 0;
    leader.stdout!.on("data", (chunk: Buffer) => {
      try { survivorPID = (JSON.parse(chunk.toString()) as { survivor: number }).survivor; } catch { /* 무시 */ }
    });
    try {
      await waitUntil(() => survivorPID > 0 && !isRunning(leaderPID) && isRunning(survivorPID));

      const action: ActionRecord = {
        ...actionFor({ pgid: leaderPID, commandLine: "claude --resume session-1", startedAt: "Sun Aug 23 14:00:00 2026" }),
        pid: leaderPID,
      };
      await new ProcessSupervisor(systemProcessControl, (report) => { reports.push(report); }).recover([action]);

      expect(reports.map((report) => report.outcome)).toEqual(["leader-gone-group-alive"]);
      expect(reports[0].detail).toContain(String(survivorPID));
      expect(isRunning(survivorPID)).toBe(true);
    } finally {
      try { process.kill(-leaderPID, "SIGKILL"); } catch { /* 이미 정리됨 */ }
    }
  });

  it("종료까지 확인한 회수는 성공으로 보고한다", async () => {
    const recorded: ProcessIdentity = {
      pgid: 4201,
      commandLine: "claude --resume session-1",
      startedAt: "Sun Aug 23 14:00:00 2026",
    };
    let running = true;
    const reports: ProcessRecoveryReport[] = [];
    const control: ProcessControl = {
      inspect: () => running ? recorded : null,
      terminateGroup: () => { running = false; },
      wait: async () => {},
    };

    await new ProcessSupervisor(control, (report) => { reports.push(report); })
      .recover([actionFor(recorded)]);

    expect(reports.map((report) => report.outcome)).toEqual(["terminated"]);
  });
});

describe("시스템 프로세스 조사", () => {
  it("서버 로케일이 달라도 같은 프로세스의 시작 시각을 같은 문자열로 읽는다", async (context) => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    const pid = child.pid ?? 0;
    const originalLocale = process.env.LC_ALL;
    try {
      await waitUntil(() => systemProcessControl.inspect(pid) !== null);
      // 로케일이 실제로 ps 출력을 바꾸지 못하는 머신에서는 이 검증이 무의미하므로 건너뛴다.
      const localized = execFileSync("ps", ["-p", String(pid), "-o", "lstart="], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, LC_ALL: "ko_KR.UTF-8", LC_TIME: "ko_KR.UTF-8" },
      }).trim();
      if (C_LOCALE_START_TIME.test(localized)) context.skip();

      process.env.LC_ALL = "ko_KR.UTF-8";
      const korean = systemProcessControl.inspect(pid);
      process.env.LC_ALL = "C";
      const neutral = systemProcessControl.inspect(pid);

      expect(korean?.startedAt).toBe(neutral?.startedAt);
      expect(korean?.startedAt).toMatch(C_LOCALE_START_TIME);
    } finally {
      if (originalLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLocale;
      child.kill("SIGKILL");
    }
  });
});

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("조건을 기다리는 동안 제한 시간을 넘었습니다.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}


// 감사 ⑤: 어댑터가 실제 경로로 spawn하므로 원장에는 절대 경로가 남는다. 문자열 전체 비교는
// 그 행을 전부 ineligible로 만들어 재시작 회수가 무력화된다.
describe("절대 경로 실행 파일 회수", () => {
  it("절대 경로 codex 실행 파일도 basename으로 신뢰해 회수한다", async () => {
    const identity: ProcessIdentity = {
      pgid: 4300,
      commandLine: "/Applications/ChatGPT.app/Contents/Resources/codex exec --json -",
      startedAt: "Sun Aug 23 14:00:00 2026",
    };
    let running = true;
    const signals: NodeJS.Signals[] = [];
    const control: ProcessControl = {
      inspect: () => running ? identity : null,
      terminateGroup: (_pid, _pgid, signal) => { signals.push(signal); running = false; },
      wait: async () => {},
      listGroup: () => [],
    };

    await new ProcessSupervisor(control).recover([
      { ...actionFor(identity, "/Applications/ChatGPT.app/Contents/Resources/codex"), pid: 4300 },
    ]);

    expect(signals).toEqual(["SIGTERM"]);
  });

  it("basename이 claude/codex가 아니면 여전히 조사하지 않는다", async () => {
    let inspections = 0;
    const control: ProcessControl = {
      inspect: () => { inspections += 1; return null; },
      terminateGroup: () => {},
      wait: async () => {},
    };
    const identity: ProcessIdentity = {
      pgid: 4301, commandLine: "/usr/bin/evil --resume", startedAt: "Sun Aug 23 14:00:00 2026",
    };

    await new ProcessSupervisor(control).recover([
      { ...actionFor(identity, "/usr/bin/evil"), pid: 4301 },
    ]);

    expect(inspections).toBe(0);
  });
});

// 감사 ⑤ 후반: SIGTERM 뒤 leader만 죽고 자식이 group에 남아도 terminated로 기록됐다.
describe("group 단위 종료 판정", () => {
  it("leader가 죽어도 group에 자식이 남아 있으면 terminated로 기록하지 않고 SIGKILL로 승격한다", async () => {
    const identity: ProcessIdentity = {
      pgid: 4400,
      commandLine: "claude --resume session-1",
      startedAt: "Sun Aug 23 14:00:00 2026",
    };
    let leaderRunning = true;
    let childRunning = true;
    const signals: NodeJS.Signals[] = [];
    const reports: ProcessRecoveryReport[] = [];
    const control: ProcessControl = {
      inspect: () => leaderRunning ? identity : null,
      terminateGroup: (_pid, _pgid, signal) => {
        signals.push(signal);
        leaderRunning = false; // SIGTERM에 leader만 죽고
        if (signal === "SIGKILL") childRunning = false; // 자식은 SIGKILL에만 죽는다
      },
      wait: async () => {},
      listGroup: (pgid) => childRunning && pgid === 4400 ? [9999] : [],
    };

    await new ProcessSupervisor(control, (report) => reports.push(report))
      .recover([{ ...actionFor(identity), pid: 4400, pgid: 4400 }]);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(reports.map((report) => report.outcome)).toEqual(["killed"]);
  });
});

function actionFor(identity: ProcessIdentity, executable = "claude"): ActionRecord {
  return {
    id: "action-1",
    topicId: "topic-1",
    kind: "claude-plan",
    status: "running",
    createdAt: "2026-08-23T00:00:00.000Z",
    finishedAt: null,
    error: null,
    pid: 4201,
    pgid: identity.pgid,
    processExecutable: executable,
    processCommand: identity.commandLine,
    processStartedAt: identity.startedAt,
  };
}
