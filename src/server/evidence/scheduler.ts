import type { EvidenceSource } from "../../shared/externalEvidence.js";

export class EvidenceAdmissionExpired extends Error {}
type Waiting = { group: string; signal: AbortSignal; deadline?: number; start: () => void; cancel: () => void };
// Slots cover the actual read, not its RPC timeout. Skip busy groups so a slow app cannot stall another app.
export class EvidenceScheduler {
  private active = 0;
  private readonly groups = new Set<string>();
  private readonly queue: Waiting[] = [];
  constructor(private readonly limit = 4) {}
  run<T>(group: string, signal: AbortSignal, read: () => Promise<T>, deadline?: number, waited: (ms: number) => void = () => {}): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queuedAt = Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cleanup = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); };
      const remove = () => { const index = this.queue.indexOf(entry); if (index !== -1) this.queue.splice(index, 1); cleanup(); };
      const abort = () => { remove(); reject(signal.reason ?? new Error("수집이 취소됐습니다.")); this.drain(); };
      const entry: Waiting = { group, signal, deadline,
        cancel: () => { remove(); reject(new EvidenceAdmissionExpired("다음 수집 주기에 계속합니다.")); },
        start: () => {
          cleanup(); waited(Math.max(0, Date.now() - queuedAt));
          this.active++; this.groups.add(group);
          const execute = async () => { signal.throwIfAborted(); return read(); };
          void execute().then(resolve, reject).finally(() => {
            this.active--; this.groups.delete(group); this.drain();
          });
        } };
      if (signal.aborted) { abort(); return; }
      this.queue.push(entry); signal.addEventListener("abort", abort, { once: true });
      if (deadline !== undefined) timer = setTimeout(() => { entry.cancel(); this.drain(); }, Math.max(0, deadline - Date.now()));
      this.drain();
    });
  }
  private drain(): void {
    for (const entry of [...this.queue]) {
      if (entry.deadline !== undefined && entry.deadline <= Date.now()) { entry.cancel(); continue; }
      if (this.active >= this.limit) return;
      if (this.groups.has(entry.group)) continue;
      this.queue.splice(this.queue.indexOf(entry), 1); entry.start();
    }
  }
}
export function evidenceGroup(source: EvidenceSource): string {
  if (source.mode === "rest") return `rest:${new URL(source.url).hostname}`;
  return `app:${source.provider === "jira" || source.provider === "confluence" ? "atlassian" : source.provider}`;
}
