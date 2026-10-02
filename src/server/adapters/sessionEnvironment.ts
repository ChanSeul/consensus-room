import { randomUUID } from "node:crypto";
import { arch, hostname, platform, release } from "node:os";
import { resolve } from "node:path";
import type { SessionTurn, SpawnedProcess } from "../types.js";
import type { TurnPolicy } from "./turnPolicy.js";
import type { AgentExecutionSettings } from "../../shared/contracts.js";

// Called only by the provider runner's actual spawn callback, after final admission.
export function observeEnvironment(turn: Omit<SessionTurn, "sessionId">, provider: "claude" | "codex", policy: TurnPolicy,
  settings: AgentExecutionSettings, sandbox: string, spawned: SpawnedProcess, mode: "create" | "resume"): void {
  turn.onExecutionEnvironment?.({ executionId: randomUUID(), sessionId: null, provider, consumer: turn.consumer ?? "runtime",
    spawnedAt: spawned.startedAt, cwd: resolve(turn.cwd), hostname: hostname(), hostOS: { platform: platform(), release: release(), arch: arch() },
    isolated: policy.isolated, workspace: turn.snapshotWorkspace ? "snapshot" : "git", access: policy.access,
    sandbox, model: settings.model, effort: settings.effort }, mode);
}
