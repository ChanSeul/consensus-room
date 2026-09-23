import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EvidenceSource, EvidenceSnapshotInput, MediatorEvidenceResponse } from "../../shared/externalEvidence.js";
import type { ConsensusDatabase } from "../database.js";
import type { AgentResult } from "../../shared/contracts.js";
import type { AgentAdapter, SessionTurn } from "../types.js";
import { EvidenceFetchError, type EvidenceConnector } from "./connectors.js";
import { DESIGN_PLANNING_CONTRACT } from "../../shared/prompts.js";
import { evidenceHash, type EvidenceStore } from "./store.js";

export class EvidenceService {
  private timer?: ReturnType<typeof setInterval>;
  private readonly jobs = new Map<string, Promise<void>>();
  private readonly abort = new AbortController();
  constructor(readonly store: EvidenceStore, private readonly connector: EvidenceConnector,
    private readonly changed: (source: EvidenceSource) => void = () => undefined, private readonly imageDirectory?: string) {}
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
  connection(source: EvidenceSource): { configured: boolean; error: string | null } {
    return { configured: this.connector.configured?.(source) ?? false, error: source.error };
  }
  async prepareMediator(database: ConsensusDatabase, topicId: string, sessionId: string): Promise<MediatorEvidenceResponse> {
    const start = database.getTopic(topicId);
    if (start.state === "CLOSED") throw new Error("닫힌 주제는 수집하지 않습니다.");
    const deadline = Date.now() + 90_000;
    for (const source of this.store.list(topicId)) {
      if (Date.now() >= deadline) throw new Error("이번 수집 대기 시간이 끝났습니다. 완료된 자료는 보존했으니 다시 확인하세요.");
      if (source.mode !== "rest") throw new Error("서버 REST 연결이 필요합니다. 연결 도구로 자동 수집하지 않습니다.");
      if (this.connector.configured && !this.connector.configured(source)) throw new Error("서버 읽기 인증 설정이 필요합니다.");
      await this.refresh(source.id);
    }
    const topic = database.getTopic(topicId);
    if (topic.scopeGeneration !== start.scopeGeneration || topic.state === "CLOSED") throw new Error("수집 중 작업 범위가 바뀌었습니다.");
    // An external lease or retry delay must not cause an overdue cache to be presented as newly checked.
    if (this.store.list(topicId).some(source => source.mode !== "rest" || source.nextCheckAt <= Date.now() || !this.store.fresh(source))) {
      throw new Error("원문 수집이 진행 중이거나 실패했습니다. 완료 후 다시 확인하세요.");
    }
    const packet = this.store.mediatorBatch(topic, sessionId);
    const hashes = packet.images.map(image => image.hash);
    if (hashes.length && !this.imageDirectory) throw new Error("디자인 캐시 경로가 설정되지 않았습니다.");
    const images = [];
    for (const hash of hashes) images.push({ hash, path: await materializeImage(this.store, this.imageDirectory!, hash) });
    const current = database.getTopic(topicId);
    if (current.scopeGeneration !== topic.scopeGeneration || current.state === "CLOSED") throw new Error("자료 준비 중 작업 범위가 바뀌었습니다.");
    this.store.assertReady(current, false);
    const currentDigest = this.store.topic(current).digest;
    const response = { ...packet, images, currentDigest, superseded: packet.digest !== currentDigest };
    this.store.measure(`mediator:${topicId}`, "deliveredBytes", Buffer.byteLength(JSON.stringify(response)));
    return response;
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
    this.store.measure(id, "fetchAttempts", 1);
    try {
      const previous = this.store.snapshot(id);
      const result = await this.connector.fetch(check.source, previous, this.abort.signal, bytes => this.store.measure(id, "receivedBytes", bytes));
      if (this.abort.signal.aborted) return;
      if (result.unchanged && check.source.contentHash) {
        this.store.unchanged(id, check.checkId, check.source.contentHash, result.revision); return;
      }
      if (!result.units) throw new EvidenceFetchError("원문을 받지 못했습니다.");
      const units = result.units.map(unit => {
        const old = previous?.units.find(old => old.id === unit.id && old.content === unit.content);
        if (!unit.imageBase64 && old?.imageHash) {
          this.store.measure(id, "reusedImages", 1);
          return { ...unit, imageBase64: this.store.image(old.imageHash).toString("base64") };
        }
        return unit;
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
    if (!topic || turn.protocolOnly || turn.planningControl) return invoke(turn);
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
    // Materialize design data outside the prompt, only once implementation actually asks for a turn.
    // Content-addressed files remain readable in resumed turns without re-sending their bodies or images.
    const designPaths: string[] = [];
    const designCache: Array<{ url: string; nodeId: string; contentHash: string; path: string }> = [];
    const designSources = database.evidence.list(topic.id).filter(source => source.provider === "figma");
    const designAccess = turn.implementation || ["CODEX_REVIEW", "CODEX_FINAL_REVIEW"].includes(topic.state);
    const observed = designAccess ? database.evidence.designObservations(topic) : [];
    const observationReferences: Array<{ hash: string; path: string }> = [];
    if (designAccess) {
      for (const observation of observed) {
        const files = await materializeObservation(imageDirectory, observation.hash, observation.record);
        designPaths.push(...files);
        observationReferences.push({ hash: observation.hash, path: files[0] });
      }
      for (const source of designSources) {
        // An old cache must never be presented as the current design. The link can still be queried directly.
        if (!database.evidence.fresh(source)) continue;
        const snapshot = database.evidence.snapshot(source.id, source.contentHash ?? undefined);
        if (!snapshot) continue;
        const images: string[] = [];
        for (const hash of new Set(snapshot.units.flatMap(unit => unit.imageHash ? [unit.imageHash] : []))) {
          images.push(await materializeImage(database.evidence, imageDirectory, hash));
        }
        const content = JSON.stringify({ ...snapshot, imagePaths: images }, null, 2);
        const hash = evidenceHash(content);
        await mkdir(imageDirectory, { recursive: true, mode: 0o700 });
        const path = join(imageDirectory, `${hash}.design.json`);
        try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        if (evidenceHash(await readFile(path)) !== hash) throw new Error("디자인 캐시가 변경됐습니다.");
        designPaths.push(path, ...images);
        designCache.push({ url: source.url, nodeId: source.selector, contentHash: snapshot.contentHash, path });
      }
    }
    const designGuidance = !designSources.length ? "" : designAccess
      ? `Inspect only the Figma screen currently being implemented or reviewed. Reuse already inspected data with the same contentHash; read the cache only when needed. The observed-design references are the exact native tool responses seen by implementation, not a claim that the remote file is still current. Use those same observations for review. Older source caches are baseline references only and must not override a newer observed response. Cached observations may be partial: use read-only Figma tools on the supplied link for missing design context, and screenshots only when visual verification is needed. Do not fetch the whole file. If the Figma tools or required node are unavailable, report the blocker instead of inventing design values.\nOptional design cache references (not yet read): ${JSON.stringify(designCache)}\nObserved design references for this exact scope and plan: ${JSON.stringify(observationReferences)}`
      : DESIGN_PLANNING_CONTRACT;
    const evidenceText = `${designGuidance}\n\n${packet.text}${paths.length ? `\n변경된 디자인 PNG (원격에서 다시 읽지 말고 이 파일을 확인):\n${paths.join("\n")}` : ""}`;
    database.evidence.measure(`runner:${topic.id}`, "modelCalls", 1);
    database.evidence.measure(`runner:${topic.id}`, "deliveredBytes", Buffer.byteLength(evidenceText));
    const sourceDigest = database.evidence.topic(topic).digest;
    const observations: Array<{ tool: string; input: unknown; content: unknown }> = [];
    const result = await invoke({ ...turn,
      onFigmaResult: turn.implementation ? observation => { observations.push(observation); } : undefined, evidenceManaged: true, figmaReadEnabled: Boolean(turn.implementation && designSources.length),
      prompt: `${turn.prompt}\n\n${evidenceText}`,
      readablePaths: [...turn.readablePaths ?? [], ...designPaths, ...packet.availableImages.map(hash => join(imageDirectory, `${hash}.png`))] });
    const current = database.getTopic(topic.id);
    if (!turn.signal?.aborted && current.scopeGeneration === topic.scopeGeneration && current.planEpoch === topic.planEpoch && current.planSHA256 === topic.planSHA256) {
      const refs: string[] = [];
      for (const observation of observations) {
        const record = JSON.stringify({ ...observation, sources: designSources.map(source => ({ url: source.url, nodeId: source.selector })),
          sourceDigest });
        const hash = database.evidence.observeDesign(topic, record);
        const files = await materializeObservation(imageDirectory, hash, record);
        refs.push(`figma-observation:${hash} ${files[0]}`);
      }
      // Bind the accepted implementation artifact to the exact observed content, not an older REST snapshot.
      if (refs.length) {
        const outcome = result as AgentResult | { result: AgentResult };
        const agentResult = "result" in outcome ? outcome.result : outcome;
        agentResult.evidenceRefs = [...agentResult.evidenceRefs, ...new Set(refs)];
      }
      database.evidence.receipt(topic, adapter.role, session(result), packet.delivered, packet.links);
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

async function materializeImage(store: EvidenceStore, directory: string, hash: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${hash}.png`);
  try { await writeFile(path, store.image(hash), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (evidenceHash(await readFile(path)) !== hash) throw new Error("디자인 캐시가 변경됐습니다.");
  return path;
}

// Raw native responses are hashed and retained; the readable view externalizes images so JSON reads stay bounded.
async function materializeObservation(directory: string, hash: string, record: string): Promise<string[]> {
  if (evidenceHash(record) !== hash) throw new Error("Design observation cache changed.");
  const paths: string[] = [];
  const externalize = async (value: unknown): Promise<unknown> => {
    if (Array.isArray(value)) return Promise.all(value.map(externalize));
    if (!value || typeof value !== "object") return value;
    const block = value as Record<string, unknown>;
    const source = block.source as Record<string, unknown> | undefined;
    const data = block.type === "image" ? (source?.data ?? block.data) : undefined;
    const mime = source?.media_type ?? block.mimeType;
    if (typeof data === "string" && typeof mime === "string" && ["image/png", "image/jpeg", "image/webp"].includes(mime)) {
      const bytes = Buffer.from(data, "base64");
      const path = await immutableFile(directory, bytes, mime === "image/jpeg" ? "jpg" : mime.split("/")[1]);
      paths.push(path); return { type: "image", mimeType: mime, path, hash: evidenceHash(bytes) };
    }
    return Object.fromEntries(await Promise.all(Object.entries(block).map(async ([key, item]) => [key, await externalize(item)])));
  };
  const content = JSON.stringify({ observationHash: hash, observation: await externalize(JSON.parse(record)) }, null, 2);
  const path = await immutableFile(directory, Buffer.from(content), "observed-design.json");
  return [path, ...new Set(paths)];
}
async function immutableFile(directory: string, content: Buffer, extension: string): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const hash = evidenceHash(content); const path = join(directory, `${hash}.${extension}`);
  try { await writeFile(path, content, { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  if (evidenceHash(await readFile(path)) !== hash) throw new Error("Design observation file changed.");
  return path;
}
