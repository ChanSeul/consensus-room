import { basename } from "node:path";
import { execFileSync } from "node:child_process";

import type { ActionRecord } from "./types.js";

export interface ProcessIdentity {
  pgid: number;
  commandLine: string;
  startedAt: string;
}

export interface ProcessControl {
  inspect(pid: number): ProcessIdentity | null;
  terminateGroup(pid: number, pgid: number, signal: NodeJS.Signals): void;
  wait(milliseconds: number): Promise<void>;
  // leader가 사라진 group에 남은 PID 목록. 미구현이면 잔존 탐지를 건너뛴다.
  listGroup?(pgid: number): number[];
}

// "회수했다" / "죽일 것이 없었다" / "신원이 달라 회수하지 못했다"를 호출자가 구분할 수 있어야 한다.
export type ProcessRecoveryOutcome =
  | "ineligible"
  | "already-gone"
  | "leader-gone-group-alive"
  | "identity-mismatch"
  | "terminated"
  | "killed"
  | "failed";

export interface ProcessRecoveryReport {
  outcome: ProcessRecoveryOutcome;
  action: ActionRecord;
  observed: ProcessIdentity | null;
  detail?: string;
}

export type ProcessRecoveryReporter = (report: ProcessRecoveryReport) => void;

export class ProcessSupervisor {
  constructor(
    private readonly control: ProcessControl = systemProcessControl,
    private readonly reporter: ProcessRecoveryReporter = writeRecoveryReport,
  ) {}

  async recover(actions: readonly ActionRecord[]): Promise<void> {
    await Promise.all(actions.map((action) => this.terminateIfOwned(action)));
  }

  private async terminateIfOwned(action: ActionRecord): Promise<void> {
    const { pid, pgid, processCommand, processExecutable, processStartedAt } = action;
    if (!pid || pid <= 1 || !pgid || pgid <= 1 || !processCommand || !processStartedAt) {
      this.report({ outcome: "ineligible", action, observed: null, detail: "원장 행에 종료 판정에 필요한 신원이 없습니다." });
      return;
    }
    // 어댑터가 실제 경로로 spawn하므로(예: /Applications/ChatGPT.app/.../codex) 원장에는 절대 경로가
    // 남는다. 문자열 전체 비교는 그 행을 전부 ineligible로 만들어 재시작 회수가 무력화된다(감사 ⑤).
    // basename만 보는 것은 isSameProcess가 command line·시작 시각까지 대조하므로 안전하다.
    const executableName = processExecutable ? basename(processExecutable) : "";
    if (executableName !== "claude" && executableName !== "codex") {
      this.report({ outcome: "ineligible", action, observed: null, detail: `허용한 CLI가 아닙니다: ${processExecutable}` });
      return;
    }
    try {
      const observed = this.control.inspect(pid);
      if (!observed) {
        // leader가 죽어도 SIGTERM을 무시한 자식이 같은 group에 남을 수 있다. 원장의 신원 기록은 leader뿐이라
        // 이 group을 그대로 죽이면 PGID가 재사용됐을 때 무관한 프로세스를 오살한다 — 죽이지 않고 보고만 한다.
        const survivors = this.control.listGroup?.(pgid) ?? [];
        if (survivors.length > 0) {
          this.report({
            outcome: "leader-gone-group-alive", action, observed: null,
            detail: `leader는 종료됐지만 group ${pgid}에 프로세스가 남았습니다: ${survivors.join(", ")}. 신원을 확인할 수 없어 종료하지 않았으니 직접 확인해 주세요.`,
          });
          return;
        }
        this.report({ outcome: "already-gone", action, observed: null });
        return;
      }
      if (!isSameProcess(observed, pgid, processCommand, processStartedAt)) {
        this.report({ outcome: "identity-mismatch", action, observed });
        return;
      }
      this.killGroup(pid, pgid, "SIGTERM");
      const deadline = Date.now() + 1_000;
      while (Date.now() < deadline) {
        // leader만 보면 SIGTERM을 무시한 자식이 남아도 terminated로 기록된다(감사 ⑤).
        // leader 신원을 이미 확인하고 우리가 신호를 보낸 group이므로 비어질 때까지가 종료다.
        if (this.groupFullyGone(pid, pgid, processCommand, processStartedAt)) {
          this.report({ outcome: "terminated", action, observed });
          return;
        }
        await this.control.wait(50);
      }
      this.killGroup(pid, pgid, "SIGKILL");
      // SIGKILL도 비동기다 — 즉시 조회하면 곧 죽을 프로세스가 생존자로 잡히고, 반대로 진짜 생존을
      // 놓친 채 killed로 기록한다(2026-08-31 Codex 지적). 짧게 소진을 기다린 뒤 판정한다.
      const killDeadline = Date.now() + 500;
      while (Date.now() < killDeadline && !this.groupFullyGone(pid, pgid, processCommand, processStartedAt)) {
        await this.control.wait(50);
      }
      const survivors = this.control.listGroup?.(pgid) ?? [];
      this.report({
        outcome: "killed", action, observed,
        ...(survivors.length > 0
          ? { detail: `SIGKILL 뒤에도 group ${pgid}에 프로세스가 남았습니다: ${survivors.join(", ")}. 직접 확인해 주세요.` }
          : {}),
      });
    } catch (error) {
      // PID가 재사용됐거나 이미 종료됐으면 다른 프로세스를 건드리지 않는다.
      this.report({
        outcome: "failed",
        action,
        observed: null,
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stillRunning(pid: number, pgid: number, expectedCommand: string, startedAt: string): boolean {
    const current = this.control.inspect(pid);
    return current !== null && isSameProcess(current, pgid, expectedCommand, startedAt);
  }

  private groupFullyGone(pid: number, pgid: number, expectedCommand: string, startedAt: string): boolean {
    if (this.stillRunning(pid, pgid, expectedCommand, startedAt)) return false;
    // listGroup을 지원하지 않는 환경에서는 기존처럼 leader 기준으로 판정한다.
    return (this.control.listGroup?.(pgid) ?? []).length === 0;
  }

  private killGroup(pid: number, pgid: number, signal: NodeJS.Signals): void {
    this.control.terminateGroup(pid, pgid, signal);
  }

  private report(report: ProcessRecoveryReport): void {
    try {
      this.reporter(report);
    } catch {
      // 보고가 실패해도 나머지 원장 행의 회수는 계속한다.
    }
  }
}

function isSameProcess(
  current: ProcessIdentity,
  pgid: number,
  expectedCommand: string,
  startedAt: string,
): boolean {
  return current.pgid === pgid && current.commandLine === expectedCommand && current.startedAt === startedAt;
}

// 신원 불일치로 회수를 건너뛴 사실이 조용히 묻히지 않도록 기본 보고는 stderr에 남긴다.
// 정상 회수와 "죽일 것이 없었음"은 시작 로그를 어지럽히지 않도록 주입된 보고자에게만 전달한다.
function writeRecoveryReport(report: ProcessRecoveryReport): void {
  const loud: ProcessRecoveryOutcome[] = ["identity-mismatch", "failed", "leader-gone-group-alive"];
  if (!loud.includes(report.outcome)) return;
  const parts = [
    `[process-recovery] ${report.outcome}`,
    `action=${report.action.id}`,
    `topic=${report.action.topicId}`,
    `pid=${report.action.pid ?? "-"}`,
    `recordedStartedAt=${JSON.stringify(report.action.processStartedAt)}`,
    `observedStartedAt=${JSON.stringify(report.observed?.startedAt ?? null)}`,
  ];
  if (report.detail) parts.push(`detail=${report.detail}`);
  process.stderr.write(`${parts.join(" ")}\n`);
}

export const systemProcessControl: ProcessControl = {
  inspect(pid) {
    const runPs = (column: string) => execFileSync("ps", ["-p", String(pid), "-o", `${column}=`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // lstart는 로케일에 따라 포맷이 달라져 원장 문자열과 영원히 불일치할 수 있으므로 C 로케일로 고정한다.
      env: { ...process.env, LC_ALL: "C", LC_TIME: "C" },
    }).trim();
    try {
      const pgid = Number(runPs("pgid"));
      const commandLine = runPs("command");
      const startedAt = runPs("lstart");
      if (!Number.isFinite(pgid) || !commandLine || !startedAt) return null;
      return { pgid, commandLine, startedAt };
    } catch {
      return null;
    }
  },
  listGroup(pgid) {
    try {
      const output = execFileSync("pgrep", ["-g", String(pgid)], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      return output.split(/\s+/).map(Number).filter((value) => Number.isInteger(value) && value > 1);
    } catch {
      // pgrep은 일치가 없으면 종료 코드 1로 끝난다 — 남은 프로세스 없음.
      return [];
    }
  },
  terminateGroup(pid, pgid, signal) {
    try {
      process.kill(process.platform === "win32" ? pid : -pgid, signal);
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
    }
  },
  wait(milliseconds) {
    return new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
  },
};
