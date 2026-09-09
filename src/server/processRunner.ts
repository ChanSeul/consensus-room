import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import type { CommandResult, CommandRunner, CommandSpec } from "./types.js";

export class SpawnCommandRunner implements CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      if (spec.signal?.aborted) {
        reject(abortError(spec.signal.reason));
        return;
      }
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: spec.environment ?? process.env,
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      });
      // close 이후에도 process group을 다룰 수 있도록 spawn 시점의 PID를 붙잡아 둔다.
      const childPID = child.pid;
      const stdoutTail = createTailBuffer(spec.maxOutputBytes ?? MAX_CAPTURE_BYTES);
      const stderrTail = createTailBuffer(MAX_CAPTURE_BYTES);
      let lineBuffer = "";
      const jsonLines = createJSONLineBuffer();
      let totalOutputTooLarge = false;
      let lineTooLarge = false;
      let stdoutBytes = 0;
      let settled = false;
      let aborted = false;
      let abortReason: unknown;
      let spawnObserverError: unknown;
      let terminationError: unknown;
      let terminationDrain: Promise<void> | undefined;
      // 최종 결과 줄 수신 뒤 유휴 타임아웃(hang 처방). 타이머가 발화해 종료시킨 실행은 exitCode 0 으로 정규화한다.
      let finalResultTimer: NodeJS.Timeout | undefined;
      let terminatedAfterResult = false;
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, "utf8");
        // Agent JSONL can legitimately be verbose for a long-running implementation.
        // Keep only a bounded diagnostic tail, but fail on cumulative overflow only
        // when a caller (for example Git snapshotting) explicitly requires the full output.
        if (spec.maxOutputBytes !== undefined && stdoutBytes > spec.maxOutputBytes) {
          totalOutputTooLarge = true;
        }
        stdoutTail.push(chunk);
        lineBuffer += chunk;
        if (lineBuffer.length > MAX_LINE_BYTES) {
          lineTooLarge = true;
          lineBuffer = lineBuffer.slice(-MAX_LINE_BYTES);
        }
        const lines = lineBuffer.split(/\r?\n/);
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = appendJSONLine(jsonLines, line);
          if (parsed !== undefined) notifyJSONLine(spec, parsed);
          if (parsed !== undefined && finalResultTimer === undefined && spec.finalResultTimeoutMs && spec.isFinalResult?.(parsed)) {
            finalResultTimer = setTimeout(() => {
              if (settled || exitCode !== null) return;
              terminatedAfterResult = true;
              terminate();
            }, spec.finalResultTimeoutMs);
          }
        }
      });
      child.stderr.on("data", (chunk: string) => { stderrTail.push(chunk); });
      const finishReject = (error: unknown) => {
        if (settled) return;
        settled = true;
        reject(error);
      };
      const terminate = () => {
        try {
          terminateProcessGroup(childPID, "SIGTERM");
        } catch (error) {
          terminationError = error;
        }
        // 분리된 타이머로 승격하면 직속 자식 close로 실행이 먼저 끝나고, 그 뒤 서버가 종료되면
        // SIGTERM을 무시한 손자가 살아남는다. 승격을 promise로 붙잡아 두고 close가 이 promise를
        // 기다린 뒤에만 settle한다 — 실행은 process group이 실제로 빌 때까지 끝나지 않는다.
        terminationDrain ??= drainProcessGroup(childPID).then((error) => {
          if (error) terminationError ??= error;
        });
      };
      const abort = () => {
        aborted = true;
        abortReason = spec.signal?.reason;
        terminate();
      };
      spec.signal?.addEventListener("abort", abort, { once: true });
      child.once("error", finishReject);
      let exitCode: number | null = null;
      child.once("close", (code) => {
        exitCode = code;
        if (finalResultTimer !== undefined) clearTimeout(finalResultTimer);
        spec.signal?.removeEventListener("abort", abort);
        if (settled) return;
        const finalize = () => {
          if (settled) return;
          if (spawnObserverError) {
            finishReject(spawnObserverError);
            return;
          }
          if (aborted) {
            finishReject(abortError(abortReason));
            return;
          }
          if (terminationError && !terminatedAfterResult) {
            finishReject(terminationError);
            return;
          }
          complete();
        };
        // 직속 자식의 close가 group이 비었다는 뜻은 아니다. 중단된 실행은 group 소멸까지 기다린 뒤에 끝낸다.
        if (terminationDrain) {
          void terminationDrain.then(finalize);
          return;
        }
        finalize();
      });
      const complete = () => {
        if (lineBuffer) {
          const parsed = appendJSONLine(jsonLines, lineBuffer);
          if (parsed !== undefined) notifyJSONLine(spec, parsed);
        }
        if (lineTooLarge) {
          finishReject(new Error("CLI가 한 줄에 허용된 출력 크기를 넘었습니다."));
          return;
        }
        if (totalOutputTooLarge) {
          finishReject(new Error("CLI 전체 출력을 손실 없이 보관할 수 있는 크기를 넘었습니다."));
          return;
        }
        settled = true;
        resolve({
          exitCode: terminatedAfterResult ? 0 : (exitCode ?? -1),
          stdout: stdoutTail.join(), stderr: stderrTail.join(), jsonLines: jsonLineValues(jsonLines),
          ...(terminatedAfterResult ? { terminatedAfterResult: true } : {}),
        });
      };
      try {
        if (child.pid) spec.onSpawn?.(inspectProcess(child.pid, spec.command));
      } catch (error) {
        spawnObserverError = error;
        terminate();
      }
      // CLI가 stdin을 읽기 전에 종료하면 write가 EPIPE로 실패한다. 'error' 리스너가 없으면 스트림 오류가
      // 프로세스 전역 예외로 올라와 서버가 통째로 죽는다(감사 ④: 큰 입력 + 즉시 종료로 재현).
      // EPIPE는 자식이 이미 종료됐다는 뜻이므로 close 경로가 exit code로 정리하게 두고,
      // 그 외 스트림 오류는 좀비가 남지 않도록 같은 종료 경로로 보낸다.
      child.stdin.on("error", (error: NodeJS.ErrnoException) => {
        if (error.code === "EPIPE" || error.code === "ERR_STREAM_DESTROYED") return;
        terminate();
      });
      if (spec.stdin) child.stdin.end(spec.stdin);
      else child.stdin.end();
    });
  }
}

const MAX_CAPTURE_BYTES = 8 * 1024 * 1024;
const MAX_LINE_BYTES = 4 * 1024 * 1024;
const MAX_JSON_LINES = 2_000;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

interface ParsedJSONLine {
  value: unknown;
  bytes: number;
}

interface JSONLineBuffer {
  threadStarted: ParsedJSONLine | null;
  recent: ParsedJSONLine[];
  recentBytes: number;
}

function createJSONLineBuffer(): JSONLineBuffer {
  return { threadStarted: null, recent: [], recentBytes: 0 };
}

// 문자열 이어붙이기(current + chunk)는 8MB 상한에서 chunk마다 전체를 복사해 O(n^2)가 된다(감사 최적화 지적).
// 조각 배열에 쌓고 상한을 넘으면 앞에서 버리는 ring 방식으로 바꾸고, 문자열은 종료 시 한 번만 합친다.
interface TailBuffer {
  push(chunk: string): void;
  join(): string;
}

// 줄 관찰자는 부가 기록이다 — 던져도 실행 결과를 잃지 않는다.
function notifyJSONLine(spec: CommandSpec, value: unknown): void {
  if (!spec.onJSONLine) return;
  try {
    spec.onJSONLine(value, Date.now());
  } catch (error) {
    console.warn(`JSON 줄 관찰자 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function createTailBuffer(limit: number): TailBuffer {
  const chunks: string[] = [];
  let size = 0;
  return {
    push(chunk: string): void {
      chunks.push(chunk);
      size += chunk.length;
      while (size > limit && chunks.length > 1) {
        size -= chunks[0].length;
        chunks.shift();
      }
      if (size > limit) {
        chunks[0] = chunks[0].slice(size - limit);
        size = limit;
      }
    },
    join(): string {
      return chunks.join("");
    },
  };
}

function appendJSONLine(buffer: JSONLineBuffer, line: string): unknown {
  if (!line.trim()) return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    const entry = { value: parsed, bytes: Buffer.byteLength(line, "utf8") };
    if (isThreadStarted(parsed)) {
      buffer.threadStarted ??= entry;
      return parsed;
    }
    buffer.recent.push(entry);
    buffer.recentBytes += entry.bytes;
    while (buffer.recent.length > MAX_JSON_LINES || buffer.recentBytes > MAX_JSON_BYTES) {
      const removed = buffer.recent.shift();
      if (removed) buffer.recentBytes -= removed.bytes;
    }
    return parsed;
  } catch {
    // stream-json이 아닌 진단 텍스트는 bounded stdout tail에만 남긴다.
    return undefined;
  }
}

function jsonLineValues(buffer: JSONLineBuffer): unknown[] {
  return [
    ...(buffer.threadStarted ? [buffer.threadStarted.value] : []),
    ...buffer.recent.map((entry) => entry.value),
  ];
}

function isThreadStarted(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const type = (value as Record<string, unknown>).type;
  return type === "thread.started" || type === "thread_started";
}

function inspectProcess(pid: number, executable: string) {
  const read = (column: string) => execFileSync("ps", ["-p", String(pid), "-o", `${column}=`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: psEnvironment(),
  }).trim();
  try {
    return {
      pid,
      pgid: Number(read("pgid")),
      executable,
      commandLine: read("command"),
      startedAt: read("lstart"),
    };
  } catch {
    return { pid, pgid: pid, executable, commandLine: "", startedAt: "" };
  }
}

// ps의 lstart는 로케일에 따라 포맷이 달라져 원장에 남긴 문자열과 비교할 수 없게 되므로 C 로케일로 고정한다.
function psEnvironment(): NodeJS.ProcessEnv {
  return { ...process.env, LC_ALL: "C", LC_TIME: "C" };
}

function terminateProcessGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return;
  try {
    if (process.platform === "win32") process.kill(pid, signal);
    else process.kill(-pid, signal);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "ESRCH")) throw error;
  }
}

// SIGTERM 유예 1초를 기다렸다가 남아 있으면 SIGKILL을 보내고 group이 빌 때까지(상한 5초) 확인한다.
async function drainProcessGroup(pid: number | undefined): Promise<unknown> {
  if (!pid) return undefined;
  const graceDeadline = Date.now() + 1_000;
  while (Date.now() < graceDeadline) {
    if (!processGroupAlive(pid)) return undefined;
    await delay(50);
  }
  if (!processGroupAlive(pid)) return undefined;
  try {
    terminateProcessGroup(pid, "SIGKILL");
  } catch (error) {
    return error;
  }
  const killDeadline = Date.now() + 5_000;
  while (Date.now() < killDeadline) {
    if (!processGroupAlive(pid)) return undefined;
    await delay(50);
  }
  return new Error("SIGKILL 뒤에도 process group이 종료되지 않았습니다. 남은 프로세스를 직접 확인해 주세요.");
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function processGroupAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    if (process.platform === "win32") process.kill(pid, 0);
    else process.kill(-pid, 0);
    return true;
  } catch (error) {
    // ESRCH는 group이 비었다는 뜻이고, 그 밖의 오류는 신원을 확인할 수 없으니 살아 있다고 본다.
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

function abortError(reason: unknown): Error {
  const error = new Error(reason instanceof Error ? reason.message : "실행이 취소되었습니다.");
  error.name = "AbortError";
  return error;
}
