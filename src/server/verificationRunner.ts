import { spawn } from "node:child_process";
import type { VerificationCommand, VerificationCompletion } from "./verifications.js";

// 중재자 CLI 전용. 모델 러너의 JSON 종료 판정이나 상속 환경을 사용하지 않는다.
export async function executeVerification(command: VerificationCommand, signal?: AbortSignal): Promise<VerificationCompletion> {
  if (signal?.aborted) return { status: "cancelled", exitCode: null, durationMs: 0, stdout: "", stderr: "" };
  const start = performance.now();
  return new Promise((resolve) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd, env: command.environment, detached: true, stdio: ["ignore", "pipe", "pipe"],
    });
    const output: Record<"stdout" | "stderr", Buffer[]> = { stdout: [], stderr: [] };
    const sizes = { stdout: 0, stderr: 0 };
    let stopped: "cancelled" | "timed_out" | "failed" | null = null;
    let spawnError = "";
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const kill = (kind: NodeJS.Signals) => {
      if (child.pid) { try { process.kill(-child.pid, kind); } catch { /* 이미 종료됨 */ } }
    };
    const stop = (reason: NonNullable<typeof stopped>) => {
      if (stopped) return;
      stopped = reason;
      kill("SIGTERM");
      escalation = setTimeout(() => kill("SIGKILL"), 250);
    };
    const cancel = () => stop("cancelled");
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    const timeout = setTimeout(() => stop("timed_out"), command.timeoutMs);
    for (const channel of ["stdout", "stderr"] as const) {
      child[channel].on("data", (chunk: Buffer) => {
        const remaining = 180_000 - sizes[channel];
        if (remaining > 0) output[channel].push(chunk.subarray(0, remaining));
        sizes[channel] += chunk.length;
        if (sizes[channel] > 180_000) stop("failed");
      });
    }
    child.once("error", (error) => { spawnError = error.message; });
    child.once("close", (exitCode) => {
      clearTimeout(timeout);
      if (escalation) clearTimeout(escalation);
      if (stopped) kill("SIGKILL");
      signal?.removeEventListener("abort", cancel);
      resolve({
        status: stopped ?? (exitCode === 0 && !spawnError ? "succeeded" : "failed"), exitCode,
        durationMs: performance.now() - start, stdout: Buffer.concat(output.stdout).toString("utf8"),
        stderr: Buffer.concat(output.stderr).toString("utf8") + (spawnError ? `\n${spawnError}` : "") +
          (sizes.stdout > 180_000 || sizes.stderr > 180_000 ? "\n[출력 한도 초과로 중단]" : ""),
      });
    });
  });
}
