import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { systemProcessControl } from "./processSupervisor.js";

// An OS-held SQLite lock is only a process lease, never a second workflow ledger.
// It releases on crash without stale-file deletion races and covers different ports.
export function acquireServerOwnership(directory: string): () => void {
  mkdirSync(directory, { recursive: true });
  const lease = new DatabaseSync(join(directory, "server-ownership.sqlite"));
  try {
    lease.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE");
    // Older servers do not acquire this lease. Keep their live registry authoritative
    // during the first upgrade; an unreadable identity is not proof of death.
    const registry = join(directory, "server-process.json");
    if (existsSync(registry)) {
      const owner = JSON.parse(readFileSync(registry, "utf8")) as { pid?: number; startedAt?: string; commandLine?: string };
      if (!Number.isInteger(owner.pid) || owner.pid! <= 1 || !owner.startedAt || !owner.commandLine) {
        throw new Error("서버 소유 기록을 확인할 수 없습니다.");
      }
      let alive = true;
      try { process.kill(owner.pid!, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false; else throw error; }
      if (alive) {
        const observed = systemProcessControl.inspect(owner.pid!);
        if (!observed || (observed.startedAt === owner.startedAt && observed.commandLine === owner.commandLine)) {
          throw new Error("이 데이터 디렉터리를 사용하는 서버가 이미 실행 중입니다.");
        }
      }
    }
  } catch (error) {
    lease.close();
    throw error;
  }
  let released = false;
  return () => { if (!released) { released = true; lease.close(); } };
}
