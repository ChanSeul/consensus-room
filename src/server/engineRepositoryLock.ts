import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, realpathSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { systemProcessControl } from "./processSupervisor.js";

export interface EngineRepositoryOwner {
  pid: number; pgid: number; startedAt: string; commandLine: string;
  id: string; repository: string; at: string;
}
export function refreshEngineRepositoryLock(path: string, owner: EngineRepositoryOwner): void {
  const current = JSON.parse(readFileSync(path, "utf8")) as EngineRepositoryOwner;
  if (current.pid !== owner.pid || current.id !== owner.id || current.startedAt !== owner.startedAt) throw new Error("엔진 작업 잠금 소유권을 잃었습니다.");
  const temporary = `${path}.${owner.pid}.${owner.id}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(owner), { mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
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
  let owner: EngineRepositoryOwner;
  try { owner = JSON.parse(readFileSync(path, "utf8")) as EngineRepositoryOwner; }
  catch { throw new Error("엔진 저장소 잠금의 소유 기록이 손상됐습니다. 소유 작업을 확인한 뒤 복구하세요."); }
  if (repositoryIdentity(repository) === owner.repository) {
    throw new Error(`엔진 저장소 후속 작업 중입니다(${owner.id}). 다른 프로젝트 토픽은 계속 실행할 수 있습니다.`);
  }
}
