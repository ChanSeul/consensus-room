import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceSource, EvidenceSnapshotInput } from "../../shared/externalEvidence.js";
import type { ConsensusDatabase } from "../database.js";
import type { AgentAdapter, SessionTurn } from "../types.js";
import { EvidenceFetchError, type EvidenceConnector } from "./connectors.js";
import { evidenceHash, type EvidenceStore } from "./store.js";

export class EvidenceService {
  private timer?: ReturnType<typeof setInterval>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  constructor(readonly store: EvidenceStore, private readonly connector: EvidenceConnector,
    private readonly changed: (source: EvidenceSource) => void = () => undefined) {}
  start(): void {
    if (this.timer) return;
    const poll = () => { void this.poll().catch(() => console.warn("[evidence] 원문 확인을 마치지 못했습니다. 다음 주기에 다시 확인합니다.")); };
    this.timer = setInterval(poll, 30_000); this.timer.unref();
    poll();
  }
  async stop(): Promise<void> { clearInterval(this.timer); this.abort.abort(); await Promise.allSettled(this.jobs.values()); }
  async poll(): Promise<void> {
    // Bounded parallelism: each iteration waits for one source; manual requests share the same lease.
    for (const source of this.store.activeSources()) {
      if (this.abort.signal.aborted) return;
      if (source.mode === "rest") await this.refresh(source.id);
    }
  }
  refresh(id: string, force = false): Promise<void> {
    const running = this.jobs.get(id); if (running) return running;
    const job = this.fetch(id, force).finally(() => this.jobs.delete(id));
    this.jobs.set(id, job); return job;
  }
  private async fetch(id: string, force: boolean): Promise<void> {
    const source = this.store.get(id);
    if (source.mode !== "rest" || this.abort.signal.aborted) return;
    const check = this.store.begin(id, force); if (!check) return;
    try {
      const previous = this.store.snapshot(id);
      const result = await this.connector.fetch(check.source, previous, this.abort.signal);
      if (this.abort.signal.aborted) return;
      if (result.unchanged && check.source.contentHash) {
        this.store.unchanged(id, check.checkId, check.source.contentHash, result.revision); return;
      }
      if (!result.units) throw new EvidenceFetchError("원문을 받지 못했습니다.");
      const units = result.units.map(unit => {
        const old = previous?.units.find(old => old.id === unit.id && old.content === unit.content);
        return !unit.imageBase64 && old?.imageHash
          ? { ...unit, imageBase64: this.store.image(old.imageHash).toString("base64") } : unit;
      });
      this.ingest(id, { checkId: check.checkId, revision: result.revision, units });
    } catch (error) {
      // HTTP bodies and credentials must not enter diagnostics. A provider error is already bounded.
      try { this.store.failed(id, check.checkId, error instanceof EvidenceFetchError ? error.message : "원문 수집에 실패했습니다. 이전 캐시를 최신으로 처리하지 않습니다.", error instanceof EvidenceFetchError ? error.retryAfterSeconds : 300); } catch { /* A newer lease owns this source. */ }
    }
  }
  ingest(id: string, input: EvidenceSnapshotInput): EvidenceSource {
    const before = this.store.get(id); const after = this.store.ingest(id, input);
    if (before.contentHash !== after.contentHash) this.changed(after);
    return after;
  }
}

// Cache is shared across roles/topics; delivery receipts belong to one actual model session.
// A failed/cancelled call never acknowledges content that the model may not have received.
export function withEvidence(adapter: AgentAdapter, database: ConsensusDatabase, imageDirectory: string): AgentAdapter {
  const run = async <T>(turn: Omit<SessionTurn, "sessionId"> | SessionTurn, invoke: (enriched: typeof turn) => Promise<T>, session: (result: T) => string): Promise<T> => {
    const topic = database.listTopics().find(topic => topic.worktreePath === turn.cwd);
    if (!topic || turn.protocolOnly) return invoke(turn);
    const packet = database.evidence.packet(topic, adapter.role, "sessionId" in turn ? turn.sessionId : undefined);
    if (!packet.text) return invoke(turn);
    const paths: string[] = [];
    if (packet.images.length) await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
    for (const hash of packet.images) {
      const path = join(imageDirectory, `${hash}.png`);
      const bytes = database.evidence.image(hash);
      try { await writeFile(path, bytes, { flag: "wx", mode: 0o600 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      if (evidenceHash(await readFile(path)) !== hash) throw new Error("디자인 파일 캐시가 변경됐습니다.");
      paths.push(path);
    }
    const result = await invoke({ ...turn, evidenceManaged: true,
      prompt: `${turn.prompt}\n\n${packet.text}${paths.length ? `\n변경된 디자인 PNG (원격에서 다시 읽지 말고 이 파일을 확인):\n${paths.join("\n")}` : ""}`,
      readablePaths: [...turn.readablePaths ?? [], ...packet.availableImages.map(hash => join(imageDirectory, `${hash}.png`))] });
    if (!turn.signal?.aborted && database.getTopic(topic.id).scopeGeneration === topic.scopeGeneration) {
      database.evidence.receipt(topic, adapter.role, session(result), packet.delivered);
    }
    return result;
  };
  return {
    role: adapter.role, validateExistingSession: id => adapter.validateExistingSession(id),
    createSession: turn => run(turn, enriched => adapter.createSession(enriched), result => result.sessionId),
    resumeTurn: turn => run(turn, enriched => adapter.resumeTurn(enriched as SessionTurn), () => turn.sessionId),
    ...(adapter.resumePlanRepair ? { resumePlanRepair: (turn: SessionTurn) => adapter.resumePlanRepair!(turn) } : {}),
  };
}
