import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, realpathSync } from "node:fs";
import { resolve, join } from "node:path";
import { systemProcessControl } from "./processSupervisor.js";

export interface EngineRepositoryOwner {
  pid: number; pgid: number; startedAt: string; commandLine: string;
  id: string; repository: string; at: string;
}
export function repositoryIdentity(path: string): string {
  const common = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: path, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"],
  }).trim();
  return realpathSync(resolve(path, common));
}
export function recoverEngineRepositoryLock(path: string): void {
  if (!existsSync(path)) return;
  let owner: EngineRepositoryOwner;
  try { owner = JSON.parse(readFileSync(path, "utf8")) as EngineRepositoryOwner; }
  catch { return; } // Preserve an unknown owner; it cannot authorize a repository mutation.
  if (!Number.isInteger(owner.pid) || !Number.isInteger(owner.pgid) || !owner.startedAt || !owner.commandLine) return;
  const observed = systemProcessControl.inspect(owner.pid);
  if (!observed || observed.startedAt !== owner.startedAt || observed.pgid !== owner.pgid || observed.commandLine !== owner.commandLine) {
    // The old server can no longer own this lock; a replacement PID is never signalled.
    unlinkSync(path);
  }
}
export function assertEngineRepositoryAvailable(directory: string, repository: string): void {
  const path = join(directory, "engine-work.lock");
  if (!existsSync(path)) return;
  const owner = JSON.parse(readFileSync(path, "utf8")) as EngineRepositoryOwner;
  if (repositoryIdentity(repository) === owner.repository) {
    throw new Error(`엔진 저장소 후속 작업 중입니다(${owner.id}). 다른 프로젝트 토픽은 계속 실행할 수 있습니다.`);
  }
}
