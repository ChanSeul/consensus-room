import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFindingCoverage } from "../src/shared/workflow";
import { evidenceHash, stableJSON } from "../src/server/evidence/store";
import { ConsensusDatabase } from "../src/server/database";
import { EVIDENCE_PAGE_BYTES, parseEvidenceSource, type EvidenceRange, type EvidenceSourceInput, type EvidenceUnitInput,
  type MediatorEvidenceBatch } from "../src/shared/externalEvidence";
import { EvidenceService, withEvidence } from "../src/server/evidence/service";
import { RestEvidenceConnector, evidenceCredentials } from "../src/server/evidence/connectors";
import type { AgentAdapter } from "../src/server/types";
import { accumulate } from "../src/server/engine/checkpoint";
import type { AgentResult } from "../src/shared/contracts";

// Public contracts: source ingestion -> topic freshness/gates, packet -> actual adapter prompt,
// and provider HTTP -> complete snapshots. Fake boundaries model pagination, edits, failure and late replies.
// No pre-existing implementation exists to restore for RED. UI pixels/live provider auth are separate checks.
const roots: string[] = []; const databases: ConsensusDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of databases.splice(0)) db.close(); for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });
const sourceInput: EvidenceSourceInput = { url: "https://team.slack.com/archives/C123/p1789709010013729", label: "Planning", mode: "connector", intervalSeconds: 300 };
function setup() {
  const root = mkdtempSync(join(tmpdir(), "evidence-")); roots.push(root);
  const db = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(db);
  const topic = db.createTopic({ id: "topic", slug: "topic", title: "Evidence", repositoryPath: root, worktreePath: root, baseRef: "main", branchName: null,
    state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  const source = db.evidence.register(topic.id, sourceInput);
  const ingest = (units: EvidenceUnitInput[], revision = "r1") => {
    const check = db.evidence.begin(source.id, true)!;
    return db.evidence.ingest(source.id, { checkId: check.checkId, revision, units });
  };
  return { root, db, topic, source, ingest };
}
const unit = (id: string, content: string): EvidenceUnitInput => ({ id, kind: "message", content, author: "Owner" });
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII=";

describe("source identity and persistent content cache", () => {
  it("registers direct message roots and normalizes their threads without broadening accepted Slack addresses", () => {
    const {db,topic}=setup();
    const url="https://team.slack.com/archives/D123";
    const root=db.evidence.register(topic.id,{...sourceInput,url});
    expect(root).toMatchObject({provider:"slack",resource:"team.slack.com/D123",selector:"",url});
    const thread=db.evidence.register(topic.id,{...sourceInput,url:`${url}/p1789709010013729?thread_ts=1789709010.013729`});
    expect(thread).toMatchObject({provider:"slack",resource:root.resource,selector:"1789709010.013729"});
    expect(thread.id).not.toBe(root.id);
    for (const invalid of ["https://team.slack.com/archives/U123","https://team.slack.com/archives/D123/pbad",
      "https://team.slack.com.evil.test/archives/D123"]) expect(()=>parseEvidenceSource({...sourceInput,url:invalid})).toThrow();
  });
  it("normalizes link variants and isolates different resources", () => {
    const { db, topic, source } = setup();
    const again = db.evidence.register(topic.id, { ...sourceInput, url: `${sourceInput.url}?thread_ts=1789709010.013729&cid=C123` });
    expect(again.id).toBe(source.id); expect(db.evidence.list()).toHaveLength(1);
    const other = db.evidence.register(topic.id, { ...sourceInput, url: sourceInput.url.replace("team.slack", "other.slack") });
    expect(other.id).not.toBe(source.id);
    expect(() => parseEvidenceSource({ ...sourceInput, url: "https://team.slack.com.evil.test/archives/C123/p1789709010013729" })).toThrow();
    expect(() => parseEvidenceSource({ ...sourceInput, url: "https://user:secret@team.atlassian.net/browse/APP-1" })).toThrow();
    expect(() => parseEvidenceSource({ ...sourceInput, url: "https://www.figma.com/design/abc/Name" })).toThrow();
  });
  it("timestamps and revision bumps alone do not resend content; deletion does", () => {
    const { db, topic, source, ingest } = setup();
    const first = ingest([{ ...unit("1", "Decision"), changedAt: "old" }, unit("2", "Question")]);
    const packet = db.evidence.packet(topic, "claude"); db.evidence.receipt(topic, "claude", "s1", packet);
    const second = ingest([unit("2", "Question"), { ...unit("1", "Decision"), changedAt: "new" }], "r2");
    expect(second.contentHash).toBe(first.contentHash);
    expect(db.evidence.packet(topic, "claude", "s1").text).not.toContain('"content":"Decision"');
    ingest([unit("1", "Changed")]);
    const changed = db.evidence.packet(topic, "claude", "s1");
    expect(changed.text).toContain('"content":"Changed"'); expect(changed.text).toContain('"removedUnitId":"2"');
    expect(db.evidence.snapshot(source.id, first.contentHash!)?.units).toHaveLength(2);
    db.evidence.receipt(topic, "claude", "s1", changed);
    expect(db.evidence.packet(topic, "claude", "s1").text).not.toContain("removedUnitId");
    expect(db.evidence.packet(topic, "codex", "s1").text).toContain('"content":"Changed"');
  });
  it("leases suppress duplicate readers and reject late responses after expiry", () => {
    const { db, source } = setup(); let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
    const first = db.evidence.begin(source.id, true)!;
    expect(db.evidence.begin(source.id, true)).toBeNull();
    now += 240_001;
    const renewed = db.evidence.begin(source.id, true)!;
    expect(renewed.checkId).not.toBe(first.checkId);
    expect(() => db.evidence.ingest(source.id, { checkId: first.checkId, revision: "expired", units: [] })).toThrow("이전 확인");
    expect(() => db.evidence.ingest(source.id, { checkId: "00000000-0000-4000-8000-000000000000", revision: "old", units: [unit("1", "stale")] })).toThrow("이전 확인");
    db.evidence.ingest(source.id, { checkId: renewed.checkId, revision: "ok", units: [] });
    const next = db.evidence.begin(source.id, true)!;
    expect(() => db.evidence.ingest(source.id, { checkId: first.checkId, revision: "late", units: [] })).toThrow("이전 확인");
    db.evidence.failed(source.id, next.checkId, "Access denied");
    expect(db.evidence.get(source.id).error).toBe("Access denied");
    expect(db.evidence.begin(source.id, true)).toBeNull();
  });
  it("binds review to current content AND plan/scope, failures never mark old content fresh", () => {
    const { db, topic, source, ingest } = setup(); const first = ingest([unit("1", "A")]);
    const deps = [{ sourceId: source.id, contentHash: first.contentHash! }];
    expect(db.evidence.status(deps)).toBe("current");
    expect(() => db.evidence.assertReady(topic)).toThrow("검토");
    db.evidence.review(topic, db.evidence.topic(topic).digest, "확정 내용과 계획 대조", topic); db.evidence.assertReady(topic);
    expect(() => db.evidence.assertReady({ ...topic, planEpoch: topic.planEpoch + 1 })).toThrow("검토");
    ingest([unit("1", "B")]); expect(db.evidence.status(deps)).toBe("changed");
    expect(() => db.evidence.assertReady(topic)).toThrow("검토");
    const check = db.evidence.begin(source.id, true)!; db.evidence.failed(source.id, check.checkId, "429");
    expect(db.evidence.status(deps)).toBe("unavailable");
    db.evidence.review(topic, db.evidence.topic(topic).digest, "접근 불가 원문과 의존 작업은 To-do로 제외", topic);
    expect(db.evidence.topic(topic).deferred).toEqual([expect.objectContaining({ sourceId: source.id })]);
    expect(db.evidence.usableSources(topic)).toEqual([]);
    expect(db.evidence.status(deps)).toBe("unavailable");
  });
  it("does not partially replace a source on duplicate units or invalid screenshots", () => {
    const { db, source, ingest } = setup(); ingest([unit("1", "A")]);
    const check = db.evidence.begin(source.id, true)!;
    expect(() => db.evidence.ingest(source.id, { checkId: check.checkId, revision: "r2", units: [unit("1", "B"), unit("1", "C")] })).toThrow("중복");
    expect(() => db.evidence.ingest(source.id, { checkId: check.checkId, revision: "r2", units: [{ ...unit("1", "B"), imageBase64: "not png" }] })).toThrow("PNG");
    expect(db.evidence.snapshot(source.id)?.units[0].content).toBe("A");
  });
  it("persists receipts and snapshots across database reopening", () => {
    const { db, root, topic, source, ingest } = setup(); ingest([unit("1", "Kept")]);
    db.evidence.receipt(topic, "claude", "session", db.evidence.packet(topic, "claude"));
    const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
    expect(reopened.evidence.packet(topic, "claude", "session").text).not.toContain('"content":"Kept"');
    expect(reopened.evidence.snapshot(source.id)?.units[0].content).toBe("Kept");
    expect(reopened.evidence.packet(topic, "claude", "new").text).toContain('"content":"Kept"');
  });
});

describe("delivery to real adapter boundary", () => {
  it("sends only delta after successful response, repeats after failure, isolates new sessions", async () => {
    const { db, root, topic, ingest } = setup(); ingest([unit("1", "A"), { ...unit("2", "Image"), kind: "render", imageBase64: png }]);
    const prompts: string[] = []; const readablePaths: string[][] = []; let fail = true;
    const raw: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
      createSession: async () => { throw new Error("unused"); }, resumeTurn: async turn => {
        prompts.push(turn.prompt); readablePaths.push([...(turn.readablePaths ?? [])]); expect(turn.evidenceManaged).toBe(true);
        if (fail) throw new Error("failure");
        return { kind: "IMPLEMENTATION", summary: "done", findings: [] } as any;
      } };
    const adapter = withEvidence(raw, db, join(root, "images"));
    const turn = { sessionId: "session", cwd: root, prompt: "Implement" };
    await expect(adapter.resumeTurn(turn)).rejects.toThrow("failure"); fail = false;
    await adapter.resumeTurn(turn); await adapter.resumeTurn(turn);
    expect(prompts[1]).toContain('"content":"A"'); expect(prompts[1]).toContain(".png");
    expect(prompts[2]).not.toContain('"content":"A"'); expect(prompts[2]).not.toContain(".png");
    expect(readablePaths[2]).toEqual(readablePaths[1]); // Later verification can read the local cache, without a remote fetch.
    ingest([unit("1", "B")]); await adapter.resumeTurn(turn);
    expect(prompts[3]).toContain('"content":"B"'); expect(prompts[3]).toContain("removedUnitId");
    expect(db.evidence.packet(topic, "claude", "new-session").text).toContain('"content":"B"');
  });
  it("does not acknowledge a cancelled late model response", async () => {
    const { db, root, topic, ingest } = setup(); ingest([unit("1", "A")]);
    const abort = new AbortController();
    const raw: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
      createSession: async () => { abort.abort(); return { sessionId: "cancelled", result: {} as any }; }, resumeTurn: async () => ({} as any) };
    await withEvidence(raw, db, join(root, "images")).createSession({ cwd: root, prompt: "P", signal: abort.signal });
    expect(db.evidence.packet(topic, "codex", "cancelled").text).toContain('"content":"A"');
  });
});

describe("read-only provider collection", () => {
  it("reads all Slack pages and retains edited messages while dropping reaction noise", async () => {
    const { source } = setup(); const urls: string[] = [];
    const request = vi.fn(async (url: any, options: any) => {
      urls.push(String(url)); expect(options.redirect).toBe("error"); expect(options.method).toBeUndefined();
      return Response.json(urls.length === 1
        ? { ok: true, messages: [{ ts: source.selector, text: "old", reactions: [1] }], response_metadata: { next_cursor: "next" } }
        : { ok: true, messages: [{ ts: "2", text: "edit", edited: { ts: "3" }, user: "owner" }], response_metadata: {} });
    });
    const connector = new RestEvidenceConnector({ slackToken: "secret", slackWorkspace: "team.slack.com" }, request as typeof fetch);
    const result = await connector.fetch(source, null, new AbortController().signal);
    expect(result.units).toHaveLength(2); expect(result.units![1].changedAt).toBe("3");
    expect(result.units![0].content).not.toContain("reactions"); expect(urls[1]).toContain("cursor=next");
  });
  it("does not accept incomplete Slack pages or leak provider error bodies", async () => {
    const { source } = setup();
    const incomplete = new RestEvidenceConnector({ slackToken: "secret", slackWorkspace: "team.slack.com" }, vi.fn(async () => Response.json({ ok: true, messages: [], has_more: true })) as typeof fetch);
    await expect(incomplete.fetch(source, null, new AbortController().signal)).rejects.toThrow("일부");
    const limited = new RestEvidenceConnector({ slackToken: "secret", slackWorkspace: "team.slack.com" }, vi.fn(async () => new Response("secret content", { status: 429, headers: { "retry-after": "900" } })) as typeof fetch);
    await expect(limited.fetch(source, null, new AbortController().signal)).rejects.toMatchObject({ retryAfterSeconds: 900 });
    await expect(limited.fetch(source, null, new AbortController().signal)).rejects.not.toThrow("secret");
  });
  it.each([undefined, "11111111-1111-4111-8111-111111111111"])("uses Jira revision probes and all comments with cloud routing %s", async jiraCloudId => {
    const { db, topic } = setup();
    const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://team.atlassian.net/browse/APP-12" });
    const calls: string[] = []; let finalRevision = "r1"; let commentText = "Decision";
    const request = vi.fn(async (url: any) => {
      const text = String(url); calls.push(text);
      if (text.endsWith("fields=updated")) return Response.json({ fields: { updated: calls.length > 1 ? finalRevision : "r1" } });
      if (text.includes("/comment")) {
        const startAt = Number(new URL(text).searchParams.get("startAt"));
        return Response.json({ startAt, total: 2, comments: [{ id: startAt === 0 ? "c1" : "c2", body: { text: startAt === 0 ? commentText : "Latest owner reply" }, author: { displayName: "Owner" } }] });
      }
      return Response.json({ fields: { updated: "r1", summary: "Feature", description: { text: "A" } } });
    });
    const connector = new RestEvidenceConnector(evidenceCredentials({ CONSENSUS_EVIDENCE_JIRA_SITE: "https://team.atlassian.net", CONSENSUS_EVIDENCE_JIRA_EMAIL: "test", CONSENSUS_EVIDENCE_JIRA_TOKEN: "secret", CONSENSUS_EVIDENCE_JIRA_CLOUD_ID: jiraCloudId }), request as typeof fetch);
    const initial = await connector.fetch(source, null, new AbortController().signal);
    expect(initial.units).toHaveLength(3);
    expect(calls.every(url => url.startsWith(jiraCloudId ? "https://api.atlassian.com/ex/jira/11111111-1111-4111-8111-111111111111/rest/api/3/" : "https://team.atlassian.net/rest/api/3/"))).toBe(true);
    expect(initial.units?.some(unit => unit.content.includes("Latest owner reply"))).toBe(true);
    calls.length = 0;
    const cached = { sourceId: source.id, contentHash: "h", units: initial.units!.map(unit => ({ ...unit, contentHash: "h" })) };
    commentText = "Edited decision";
    const refreshed = await connector.fetch({ ...source, revision: "r1" }, cached, new AbortController().signal);
    expect(refreshed.units).toHaveLength(3);
    expect(refreshed.units?.find(unit => unit.id === "comment:c1")?.content).toContain("Edited decision");
    expect(calls).toHaveLength(4); expect(calls.some(url => url.includes("fields=summary"))).toBe(false);
    expect(calls.some(url => url.includes("/comment"))).toBe(true);
    calls.length = 0; finalRevision = "r2";
    await expect(connector.fetch(source, null, new AbortController().signal)).rejects.toThrow("변경");
  });
  it("does not fetch Figma nodes/images again for unchanged versions but checks comments", async () => {
    const { db, topic } = setup();
    const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Name?node-id=1-2" });
    const urls: string[] = [];
    const request = vi.fn(async (url: any) => {
      urls.push(String(url));
      if (String(url).endsWith("/meta")) return Response.json({ file: { version: "v1" } });
      if (String(url).endsWith("/comments")) return Response.json({ comments: [{ id: "1", message: "New policy", user: { handle: "Designer" } }] });
      throw new Error("must not fetch content");
    });
    const connector = new RestEvidenceConnector({ figmaToken: "secret" }, request as typeof fetch);
    const result = await connector.fetch({ ...source, revision: "v1" }, { sourceId: source.id, contentHash: "h", units: [{ id: "node:1:2", kind: "design", content: "old node", contentHash: "h" }] }, new AbortController().signal);
    expect(urls).toHaveLength(2); expect(result.units?.some(u => u.content.includes("New policy"))).toBe(true);
  });
  it("single-flights polling", async () => {
    const { db, topic } = setup(); const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Name?node-id=1-2", mode: "rest" });
    let release!: () => void; const pending = new Promise<void>(resolve => { release = resolve; });
    const fetch = vi.fn(async () => { await pending; return { revision: "v1", units: [unit("1", "A")] }; });
    const service = new EvidenceService(db.evidence, { fetch });
    const first = service.refresh(source.id); const second = service.refresh(source.id);
    expect(fetch).toHaveBeenCalledTimes(1); release(); await Promise.all([first, second]);
    expect(db.evidence.topic(topic).sources.find(s => s.id === source.id)?.contentHash).not.toBeNull();
    await service.stop();
  });
});

it("reuses the selected Figma subtree and PNG when only another screen changed", async () => {
  const { db, topic } = setup();
  const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Name?node-id=1-2", mode: "rest" });
  let version = "v1"; const urls: string[] = [];
  const request = vi.fn(async (url: any, options: any) => {
    const value = String(url); urls.push(value);
    if (value.endsWith("/meta")) return Response.json({ file: { version } });
    if (value.endsWith("/comments")) return Response.json({ comments: [] });
    if (value.includes("/nodes?")) return Response.json({ nodes: { "1:2": { document: { id: "1:2", type: "FRAME", name: "Screen", children: [{ id: "1:3", type: "TEXT", characters: "Policy" }] } } } });
    if (value.includes("/images/")) return Response.json({ images: { "1:2": "https://assets.figma.com/design.png" } });
    expect(options.headers).toBeUndefined();
    return new Response(Buffer.from(png, "base64"));
  });
  const service = new EvidenceService(db.evidence, new RestEvidenceConnector({ figmaToken: "secret" }, request as typeof fetch));
  await service.refresh(source.id, true);
  const first = db.evidence.get(source.id); expect(first.error).toBeNull();
  db.evidence.receipt(topic, "claude", "session", db.evidence.packet(topic, "claude"));
  version = "v2"; await service.refresh(source.id, true);
  expect(db.evidence.get(source.id)).toMatchObject({ error: null, revision: "v2", contentHash: first.contentHash });
  expect(urls.filter(url => url.includes("/images/"))).toHaveLength(1);
  expect(urls.filter(url => url.endsWith("design.png"))).toHaveLength(1);
  expect(db.evidence.packet(topic, "claude", "session").images).toHaveLength(0);
  await service.stop();
});
it("tells an existing session when its last source was removed", async () => {
  const { db, root, topic, source, ingest } = setup(); ingest([unit("1", "Old source")]);
  const prompts: string[] = [];
  const raw: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: async () => { throw new Error("unused"); }, resumeTurn: async turn => { prompts.push(turn.prompt); return {} as any; } };
  const adapter = withEvidence(raw, db, join(root, "images"));
  await adapter.resumeTurn({ sessionId: "s", cwd: root, prompt: "Read" });
  db.evidence.detach(topic.id, source.id);
  await adapter.resumeTurn({ sessionId: "s", cwd: root, prompt: "Continue" });
  expect(prompts[1]).toContain(`"removedSourceId":"${source.id}"`);
  await adapter.resumeTurn({ sessionId: "s", cwd: root, prompt: "Continue" });
  expect(prompts[2]).toBe("Continue");
});

// Mediator contract: explicit batch read -> separate ack -> next delta. No model is involved.
// New feature: no historical bug to restore. Scope/session, failure, persistence and late updates are real DB boundaries.
it("keeps a mediator batch pending across restart, acknowledges exactly that version, and isolates sessions/scopes", () => {
  const { db, root, topic, source, ingest } = setup();
  ingest([unit("1", "A"), unit("2", "remove")]);
  const first = db.evidence.mediatorBatch(topic, "mediator-1");
  expect(first.changes.map(u => u.content)).toEqual(["A", "remove"]);
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  expect(reopened.evidence.mediatorBatch(topic, "mediator-1")).toEqual(first);
  ingest([unit("1", "B")]);
  expect(db.evidence.mediatorBatch(topic, "mediator-1")).toEqual(first);
  expect(() => db.evidence.acknowledgeMediator(topic, "other", first.batchId!)).toThrow();
  expect(() => db.evidence.acknowledgeMediator({ ...topic, scopeGeneration: 2 }, "mediator-1", first.batchId!)).toThrow();
  db.evidence.acknowledgeMediator(topic, "mediator-1", first.batchId!);
  const second = db.evidence.mediatorBatch(topic, "mediator-1");
  expect(second.changes.map(u => u.content)).toEqual(["B"]);
  expect(second.removedUnits).toEqual([{ sourceId: source.id, unitId: "2" }]);
  db.evidence.acknowledgeMediator(topic, "mediator-1", first.batchId!); // old duplicate cannot consume the newer batch
  expect(db.evidence.mediatorBatch(topic, "mediator-1").batchId).toBe(second.batchId);
  db.evidence.acknowledgeMediator(topic, "mediator-1", second.batchId!);
  db.evidence.acknowledgeMediator(topic, "mediator-1", first.batchId!);
  expect(db.evidence.mediatorBatch(topic, "mediator-1")).toMatchObject({ batchId: null, changes: [] });
  expect(db.evidence.mediatorBatch(topic, "new-session").changes).toHaveLength(1);
  expect(db.evidence.mediatorBatch({ ...topic, scopeGeneration: 2 }, "mediator-1").changes).toHaveLength(1);
  expect(db.evidence.packet(topic, "claude", "mediator-1").text).toContain('"content":"B"');
  db.evidence.detach(topic.id, source.id);
  const removed = db.evidence.mediatorBatch(topic, "mediator-1");
  expect(removed.removedSources).toEqual([source.id]);
  db.evidence.acknowledgeMediator(topic, "mediator-1", removed.batchId!);
  expect(db.evidence.mediatorBatch(topic, "mediator-1").batchId).toBeNull();
});

it("preserves cache on REST conversion, rejects a live collection lease, and requires fresh REST collection", () => {
  const { db, topic, source, ingest } = setup(); ingest([unit("1", "A")]);
  const hash = db.evidence.get(source.id).contentHash;
  const lease = db.evidence.begin(source.id, true)!;
  expect(() => db.evidence.useRest(source.id)).toThrow("수집 중");
  db.evidence.unchanged(source.id, lease.checkId, hash!, "r1");
  expect(db.evidence.useRest(source.id)).toMatchObject({ mode: "rest", contentHash: hash, checkedAt: null, nextCheckAt: 0 });
  expect(() => db.evidence.mediatorBatch(topic, "s")).toThrow("원문 확인");
});

it("waits for a shared pending REST fetch, returns only changed PNG paths, and never calls a model", async () => {
  const { db, root, topic, source } = setup(); db.evidence.useRest(source.id);
  let finish!: (value: any) => void;
  const fetch = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const service = new EvidenceService(db.evidence, { fetch }, undefined, join(root, "images"));
  const first = service.prepareMediator(db, topic.id, "s");
  const second = service.prepareMediator(db, topic.id, "s");
  expect(fetch).toHaveBeenCalledTimes(1);
  finish({ revision: "r1", units: [{ id: "render", kind: "render", content: "design", imageBase64: png }] });
  const a = await first; const b = await second;
  expect(a.batchId).toBe(b.batchId); expect(a.images).toHaveLength(1);
  expect(a.images[0].path).toContain(join(root, "images"));
  db.evidence.acknowledgeMediator(topic, "s", a.batchId!);
  const same = await service.prepareMediator(db, topic.id, "s");
  expect(same).toMatchObject({ batchId: null, changes: [], images: [] });
  expect(fetch).toHaveBeenCalledTimes(1);
  expect(db.evidence.metrics(`runner:${topic.id}`)).toEqual({});
  const lease = db.evidence.begin(source.id, true)!;
  db.evidence.failed(source.id, lease.checkId, "429", 300);
  await expect(service.prepareMediator(db, topic.id, "s")).rejects.toThrow("실패");
  expect(fetch).toHaveBeenCalledTimes(1);
  await service.stop();
});

it("measures actual REST response bytes without exposing credentials", async () => {
  const { db, source } = setup(); const reply = { ok: true, messages: [{ ts: source.selector, text: "A" }] };
  let bytes = 0;
  const connector = new RestEvidenceConnector({ slackToken: "secret", slackWorkspace: "team.slack.com" }, vi.fn(async () => Response.json(reply)) as typeof fetch);
  await connector.fetch(source, null, new AbortController().signal, n => { bytes += n; });
  expect(bytes).toBe(Buffer.byteLength(JSON.stringify(reply)));
  expect(connector.configured(source)).toBe(true);
  expect(new RestEvidenceConnector({}).configured(source)).toBe(false);
});

it("does not resend an already acknowledged PNG when its text unit changes", () => {
  const { db, topic, ingest } = setup();
  ingest([{ id: "render", kind: "render", content: "old", imageBase64: png }]);
  const first = db.evidence.mediatorBatch(topic, "s"); expect(first.images).toHaveLength(1);
  db.evidence.acknowledgeMediator(topic, "s", first.batchId!);
  ingest([{ id: "render", kind: "render", content: "new", imageBase64: png }]);
  const next = db.evidence.mediatorBatch(topic, "s");
  expect(next.changes).toHaveLength(1); expect(next.images).toEqual([]);
});

it("does not override provider backoff by switching from connector to REST", () => {
  const { db, source } = setup(); const lease = db.evidence.begin(source.id, true)!;
  db.evidence.failed(source.id, lease.checkId, "429", 900);
  const retryAt = db.evidence.get(source.id).nextCheckAt;
  expect(db.evidence.useRest(source.id).nextCheckAt).toBe(retryAt);
  expect(db.evidence.begin(source.id, true)).toBeNull();
});

// Regression boundary: connector tree -> REST conversion -> mediator receives child-node comments.
// The pre-fix conversion fails this test because the same file version incorrectly skips /nodes.
it("rebuilds connector Figma trees on REST conversion without dropping child comments", async () => {
  const { db, root, topic, source: slack } = setup(); db.evidence.detach(topic.id, slack.id);
  const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Name?node-id=1-2" });
  const tree = { id: "1:2", type: "FRAME", children: [{ id: "1:3", type: "TEXT", characters: "Policy" }] };
  db.evidence.ingest(source.id, { checkId: db.evidence.begin(source.id)!.checkId, revision: "v1", units: [
    { id: "node:1:2", kind: "design", content: JSON.stringify(tree) },
    { id: "comment:old", kind: "comment", content: "Existing child decision" },
  ] });
  const old = db.evidence.mediatorBatch(topic, "s"); db.evidence.acknowledgeMediator(topic, "s", old.batchId!);
  const urls: string[] = [];
  const request = vi.fn(async (url: any) => {
    const value = String(url); urls.push(value);
    if (value.endsWith("/meta")) return Response.json({ file: { version: "v1" } });
    if (value.endsWith("/comments")) return Response.json({ comments: [
      { id: "old", message: "Existing child decision", client_meta: { node_id: "1:3" } },
      { id: "new", message: "New child decision", client_meta: { node_id: "1:3" } },
    ] });
    if (value.includes("/nodes?")) return Response.json({ nodes: { "1:2": { document: tree } } });
    if (value.includes("/images/")) return Response.json({ images: { "1:2": "https://assets.figma.com/design.png" } });
    return new Response(Buffer.from(png, "base64"));
  });
  const service = new EvidenceService(db.evidence, new RestEvidenceConnector({ figmaToken: "secret" }, request as typeof fetch), undefined, join(root, "images"));
  db.evidence.useRest(source.id);
  const next = await service.prepareMediator(db, topic.id, "s");
  expect(next.changes.map(unit => unit.id)).toContain("comment:new");
  expect(next.removedUnits).not.toContainEqual({ sourceId: source.id, unitId: "comment:old" });
  expect(db.evidence.snapshot(source.id)!.units.find(unit => unit.id === "comment:old")?.content).toContain("Existing child decision");
  db.evidence.acknowledgeMediator(topic, "s", next.batchId!);
  await service.refresh(source.id, true);
  expect((await service.prepareMediator(db, topic.id, "s")).changes).toEqual([]);
  expect(urls.filter(url => url.includes("/nodes?"))).toHaveLength(1);
  expect(urls.filter(url => url.endsWith("design.png"))).toHaveLength(1);
  await service.stop();
});

it("does not return old bytes when an external lease is still refreshing an overdue source", async () => {
  const { db, topic, source, ingest } = setup(); ingest([unit("1", "old")]); db.evidence.useRest(source.id);
  const lease = db.evidence.begin(source.id, true)!;
  const fetch = vi.fn(); const service = new EvidenceService(db.evidence, { fetch });
  await expect(service.prepareMediator(db, topic.id, "s")).rejects.toThrow("수집이 진행 중");
  expect(fetch).not.toHaveBeenCalled();
  db.evidence.ingest(source.id, { checkId: lease.checkId, revision: "new", units: [unit("1", "new")] });
  expect((await service.prepareMediator(db, topic.id, "s")).changes[0].content).toBe("new");
  await service.stop();
});


it("keeps Figma detail out of planning and implementation prompts, exposing immutable caches only on implementation demand", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Confirmed product behavior")]);
  const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/DesignFile?node-id=1-2", label: "Entry screen" });
  const update = (content: string) => db.evidence.ingest(source.id, { checkId: db.evidence.begin(source.id, true)!.checkId,
    revision: content, units: [{ id: "1:2", kind: "design", content, imageBase64: png }] });
  update("PRIVATE_LAYOUT_DETAILS");
  const turns: any[] = [];
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true,
    createSession: async () => { throw new Error("unused"); }, resumeTurn: async turn => {
      turns.push(turn); return { kind: "PLAN", summary: "ok", findings: [], evidenceRefs: [] };
    } }, db, join(root, "images"));
  const turn = { sessionId: "same-session", cwd: root, prompt: "Task" };
  await adapter.resumeTurn(turn);
  expect(turns[0].prompt).toContain(source.url);
  expect(turns[0].prompt).toContain("Confirmed product behavior");
  expect(turns[0].prompt).not.toContain("PRIVATE_LAYOUT_DETAILS");
  expect(turns[0].readablePaths).toEqual([]);
  expect(turns[0].figmaReadEnabled).toBe(false);
  await adapter.resumeTurn({ ...turn, implementation: true });
  expect(turns[1].prompt).not.toContain("PRIVATE_LAYOUT_DETAILS");
  expect(turns[1].figmaReadEnabled).toBe(true);
  const cached = turns[1].readablePaths.find((p: string) => p.endsWith(".design.json"));
  expect(readFileSync(cached, "utf8")).toContain("PRIVATE_LAYOUT_DETAILS");
  const modified = statSync(cached).mtimeMs;
  await adapter.resumeTurn({ ...turn, implementation: true });
  expect(turns[2].readablePaths).toEqual(turns[1].readablePaths);
  expect(statSync(cached).mtimeMs).toBe(modified);
  update("UPDATED_LAYOUT_DETAILS");
  await adapter.resumeTurn({ ...turn, implementation: true });
  expect(turns[3].prompt).not.toContain("UPDATED_LAYOUT_DETAILS");
  expect(turns[3].readablePaths).not.toContain(cached);
  const next = turns[3].readablePaths.find((p: string) => p.endsWith(".design.json"));
  expect(readFileSync(next, "utf8")).toContain("UPDATED_LAYOUT_DETAILS");
  db.updateTopic(topic.id, { state: "CODEX_REVIEW" });
  await adapter.resumeTurn(turn);
  expect(turns[4].readablePaths).toContain(next);
  expect(turns[4].prompt).not.toContain("UPDATED_LAYOUT_DETAILS");
  const check = db.evidence.begin(source.id, true)!;
  db.evidence.failed(source.id, check.checkId, "unavailable", 300);
  await adapter.resumeTurn({ ...turn, implementation: true });
  expect(turns[5].readablePaths).toEqual([]);
  expect(turns[5].prompt).toContain(source.url);
  db.evidence.detach(topic.id, source.id);
  await adapter.resumeTurn({ ...turn, implementation: true });
  expect(turns[6].figmaReadEnabled).toBe(false);
  expect(turns[6].readablePaths).toEqual([]);
});

it("delivers Figma product comments and link removal, without claiming design units were delivered", async () => {
  const { db, topic, root, source: slack } = setup(); db.evidence.detach(topic.id, slack.id);
  const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Screen?node-id=1-2" });
  db.evidence.ingest(source.id, { checkId: db.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [
    { id: "node", kind: "design", content: "PRIVATE_LAYOUT" }, { id: "decision", kind: "comment", content: "Owner: save draft on exit" },
  ] });
  const turns: any[] = [];
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async turn => { turns.push(turn); return { kind: "PLAN", summary: "ok", findings: [], evidenceRefs: [] }; } }, db, join(root, "images"));
  const turn = { sessionId: "s", cwd: root, prompt: "Plan" };
  await adapter.resumeTurn(turn);
  expect(turns[0].prompt).toContain("save draft on exit"); expect(turns[0].prompt).not.toContain("PRIVATE_LAYOUT");
  // delivered 는 이 쪽에 실린 단위만이다(E3-1) — 이미 받은 세션은 비어 있고, 새 세션의 첫 쪽에도 디자인 단위는 없다.
  expect(db.evidence.packet(topic, "claude", "s").delivered).toEqual([]);
  expect(db.evidence.packet(topic, "claude", "fresh").delivered.map(row => row.unitId)).toEqual(["decision"]);
  await adapter.resumeTurn(turn); expect(turns[1].prompt).not.toContain("save draft on exit");
  db.evidence.failed(source.id, db.evidence.begin(source.id, true)!.checkId, "offline");
  expect(db.evidence.topic(topic).ready).toBe(true);
  expect(db.evidence.usableSources(topic)).toEqual([]); // Failed product comments are deferred, never injected as current.
  db.evidence.detach(topic.id, source.id);
  await adapter.resumeTurn(turn);
  expect(turns[2].prompt).toContain(`"removedSourceId":"${source.id}"`);
  await adapter.resumeTurn(turn); expect(turns[3].prompt).not.toContain("removedSourceId");
});

it("binds native observed design B to the result and reviewer even while the REST cache still contains A", async () => {
  const { ClaudeAdapter } = await import("../src/server/adapters/claude");
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Product contract")]);
  const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Screen?node-id=1-2" });
  db.evidence.ingest(source.id, { checkId: db.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [{ id: "node", kind: "design", content: "cache A" }] });
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "mcp__figma-desktop__get_design_context", input: { nodeId: "1:2" } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: [{ type: "text", text: "observed B" }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }] }] } },
    { type: "result", subtype: "success", num_turns: 1, structured_output: { kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] } },
  ];
  const native = new ClaudeAdapter({ run: async spec => {
    for (const line of lines) spec.onJSONLine?.(line, Date.now());
    return { exitCode: 0, stdout: "", stderr: "", jsonLines: lines };
  } }, undefined, { figmaMcpUrl: "http://127.0.0.1:3845/mcp" });
  const implementation = withEvidence(native, db, join(root, "images"));
  const result = await implementation.createSession({ cwd: root, prompt: "Implement", implementation: true });
  expect(result.result.evidenceRefs).toHaveLength(1);
  expect(db.evidence.designObservations(topic)).toHaveLength(1);
  const hash = db.evidence.designObservations(topic)[0].hash;
  expect(result.result.evidenceRefs[0]).toContain(`figma-observation:${hash}`);
  expect(db.evidence.designObservations(topic)).toHaveLength(1);
  db.updateTopic(topic.id, { state: "CODEX_REVIEW" });
  let review: any;
  const reviewer = withEvidence({ role: "codex", validateExistingSession: async () => true, createSession: async turn => {
    review = turn; return { sessionId: "review", result: { kind: "REVIEW", summary: "ok", findings: [], evidenceRefs: [] } };
  }, resumeTurn: async () => { throw Error("unused"); } }, db, join(root, "images"));
  await reviewer.createSession({ cwd: root, prompt: "Review" });
  expect(review.prompt).toContain(hash); expect(review.prompt).not.toContain("observed B");
  const path = review.readablePaths.find((p: string) => p.endsWith(".observed-design.json"));
  expect(result.result.evidenceRefs[0]).toContain(path);
  expect(readFileSync(path, "utf8")).toContain("observed B"); expect(readFileSync(path, "utf8")).not.toContain(png);
  expect(review.readablePaths.some((p: string) => p.endsWith(".png"))).toBe(true);
  const mtime = statSync(path).mtimeMs;
  const resumed = await implementation.resumeTurn({ cwd: root, sessionId: result.sessionId, prompt: "Continue", implementation: true });
  expect(resumed.evidenceRefs).toEqual(result.result.evidenceRefs);
  expect(db.evidence.designObservations(topic)).toHaveLength(1);
  expect(statSync(path).mtimeMs).toBe(mtime);
  db.updateTopic(topic.id, { planEpoch: topic.planEpoch + 1 });
  expect(db.evidence.designObservations(db.getTopic(topic.id))).toHaveLength(1);
});

it("remembers a link-only Figma delivery across database reopen and reports removal of the final link", async () => {
  const { db, topic, root, source: slack } = setup(); db.evidence.detach(topic.id, slack.id);
  const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const packet = db.evidence.packet(topic, "claude", "s");
  expect(packet.delivered).toEqual([]);
  db.evidence.receipt(topic, "claude", "s", packet);
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  reopened.evidence.detach(topic.id, source.id);
  const removed = reopened.evidence.packet(topic, "claude", "s");
  expect(removed.text).toContain(`"removedSourceId":"${source.id}"`);
  reopened.evidence.receipt(topic, "claude", "s", removed);
  expect(reopened.evidence.packet(topic, "claude", "s").text).toBe("");
});

it.each(["429", "cancelled", "invalid-result"])("retains native design evidence after %s and binds it on same-session resume after a plan revision", async failure => {
  const { ClaudeAdapter } = await import("../src/server/adapters/claude");
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Confirmed behavior")]);
  db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const tool = { type: "assistant", message: { content: [{ type: "tool_use", id: "read", name: "mcp__figma-desktop__get_design_context", input: { nodeId: "1:2" } }] } };
  const reply = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read", content: "design B before failure" }] } };
  let attempt = 0; const prompts: string[] = [];
  const native = new ClaudeAdapter({ run: async spec => {
    prompts.push(spec.stdin!); attempt++;
    if (attempt === 1) {
      spec.onJSONLine?.(tool, Date.now()); spec.onJSONLine?.(reply, Date.now());
      if (failure === "cancelled") throw new Error("Cancelled after reading Figma");
      return { exitCode: failure === "429" ? 1 : 0, stdout: "", stderr: "rate limit", jsonLines: failure === "429" ? [] : [{ type: "result", num_turns: 1, structured_output: {} }] };
    }
    return { exitCode: 0, stdout: "", stderr: "", jsonLines: [{ type: "result", subtype: "success", num_turns: 1,
      structured_output: { kind: "IMPLEMENTATION", summary: "resumed using remembered design", status: "completed", findings: [], evidenceRefs: [] } }] };
  } }, undefined, { figmaMcpUrl: "http://127.0.0.1:3845/mcp" });
  const adapter = withEvidence(native, db, join(root, "images"));
  const turn = { cwd: root, sessionId: "same-session", prompt: "Implement", implementation: true };
  await expect(adapter.resumeTurn(turn)).rejects.toThrow();
  expect(db.evidence.designObservations(topic)).toHaveLength(1);
  const hash = db.evidence.designObservations(topic)[0].hash;
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([]);
  db.updateTopic(topic.id, { planEpoch: topic.planEpoch + 1, planSHA256: "b".repeat(64) });
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  const resumed = await withEvidence(native, reopened, join(root, "images")).resumeTurn(turn);
  expect(resumed.evidenceRefs).toHaveLength(1); expect(resumed.evidenceRefs[0]).toContain(hash);
  expect(prompts[1]).toContain(hash); expect(prompts[1]).not.toContain("design B before failure");
  let review: any;
  db.updateTopic(topic.id, { state: "CODEX_REVIEW" });
  await withEvidence({ role: "codex", validateExistingSession: async () => true, resumeTurn: async () => { throw Error("unused"); },
    createSession: async turn => { review = turn; return { sessionId: "review", result: { kind: "REVIEW", summary: "ok", findings: [], evidenceRefs: [] } }; }
  }, reopened, join(root, "images")).createSession({ cwd: root, prompt: "Review" });
  const path = review.readablePaths.find((path: string) => path.endsWith(".observed-design.json"));
  expect(resumed.evidenceRefs[0]).toContain(path); expect(readFileSync(path, "utf8")).toContain("design B before failure");
  expect(review.prompt).toContain(hash);
});

it("ignores late design callbacks after cancellation and retains unknown reads for resume", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Behavior")]);
  db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const request = { tool: "mcp__figma-desktop__get_metadata", input: { nodeId: "1:2" } }, abort = new AbortController();
  let attempt = 0, resumedPrompt = "";
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async turn => {
      if (++attempt === 1) {
        turn.onFigmaRequest!(request);
        abort.abort();
        turn.onFigmaRequest!({ ...request, input: { nodeId: "1:3" } });
        turn.onFigmaResult!({ ...request, content: "late success" });
        turn.onFigmaResult!({ ...request, content: "late failure", isError: true });
      } else resumedPrompt = turn.prompt;
      return { kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] };
    } }, db, join(root, "images"));
  await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Implement", implementation: true, signal: abort.signal });
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([request]);
  expect(db.evidence.designObservations(topic)).toEqual([]);
  expect(db.evidence.failedDesignRequests(topic)).toEqual([]);
  const resumed = await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Resume", implementation: true });
  expect(resumed.evidenceRefs).toEqual([]);
  expect(resumedPrompt).toContain("unreceived");
  expect(resumedPrompt).not.toContain("late success");
});

it("keeps design debt outside accumulated summaries while supplying current referenced gaps", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Behavior")]);
  db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  for (let i = 0; i < 36; i++) db.evidence.designRequest(topic, { tool: "mcp__figma-desktop__get_metadata", input: { nodeId: `1:${i + 2}` } });
  let attempt = 0, accumulated: AgentResult | null = null;
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async turn => {
      expect(turn.prompt).toContain("unreceived");
      expect(turn.readablePaths?.filter(path => path.endsWith(".observed-design.json"))).toHaveLength(36);
      return { kind: "IMPLEMENTATION", summary: `Progress ${++attempt}`, status: "in_progress", findings: [], evidenceRefs: [] };
    } }, db, join(root, "images"));
  for (let i = 0; i < 10; i++) {
    const next = await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true });
    expect(next.summary).toBe(`Progress ${i + 1}`);
    accumulated = accumulate(accumulated, next, [], i).result;
  }
  expect(accumulated!.summary).not.toContain("get_metadata");
  expect(db.evidence.designReadGaps(topic)).toHaveLength(36);
});

it("rejects current capture loss but defers previous unknown reads until a successful explicit retry", async () => {
  const { ClaudeAdapter } = await import("../src/server/adapters/claude");
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Behavior")]);
  db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  let attempt = 0;
  const native = new ClaudeAdapter({ run: async spec => {
    attempt++;
    if (attempt !== 2) spec.onJSONLine?.({ type: "assistant", message: { content: [{ type: "tool_use", id: `read-${attempt}`, name: "mcp__figma-desktop__get_metadata", input: { nodeId: "1:2" } }] } }, Date.now());
    if (attempt === 3) spec.onJSONLine?.({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "read-3", content: "recaptured design" }] } }, Date.now());
    return { exitCode: 0, stdout: "", stderr: "", jsonLines: [{ type: "result", subtype: "success", num_turns: 1,
      structured_output: { kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] } }] };
  } }, undefined, { figmaMcpUrl: "http://127.0.0.1:3845/mcp" });
  const adapter = withEvidence(native, db, join(root, "images"));
  const turn = { cwd: root, sessionId: "s", prompt: "Implement", implementation: true };
  await expect(adapter.resumeTurn(turn)).rejects.toThrow("not captured");
  const continued = await adapter.resumeTurn(turn);
  expect(continued.summary).toBe("done");
  expect(continued.evidenceRefs).toEqual([]);
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([]);
  expect(db.evidence.failedDesignRequests(topic)).toEqual([]);
  expect(db.evidence.designReadGaps(topic)).toHaveLength(1);
  expect((await adapter.resumeTurn(turn)).evidenceRefs).toHaveLength(1);
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([]);
  expect(db.evidence.designReadGaps(topic)).toEqual([]);
});

it("retains explicit design failures as unverified To-do without forcing another read", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Behavior")]);
  db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const request = { tool: "mcp__figma-desktop__get_metadata", input: { nodeId: "1:2" } };
  db.evidence.designRequest(topic, request);
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async turn => {
      turn.onFigmaRequest?.(request);
      turn.onFigmaResult?.({ ...request, content: "Access denied", isError: true });
      return { kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] };
    } }, db, join(root, "images"));
  const result = await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Retry", implementation: true });
  expect(result.summary).toBe("done");
  expect(result.findings).toEqual([]);
  expect(result.evidenceRefs).toEqual([]);
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([]);
  expect(db.evidence.designObservations(topic)).toEqual([]);
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  expect(reopened.evidence.failedDesignRequests(topic)).toMatchObject([{ request, failure: "Access denied" }]);
  let delivered: any;
  const continued = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async turn => { delivered = turn; return { kind: "IMPLEMENTATION", summary: "Other work", status: "completed", findings: [], evidenceRefs: [] }; }
  }, reopened, join(root, "images"));
  const resumed = await continued.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true });
  expect(resumed.findings).toEqual([]);
  const judgment = { id: `FIGMA-UNAVAILABLE-${topic.scopeGeneration}-${evidenceHash(stableJSON(request))}`,
    title: "Unverified design", evidenceRefs: [], severity: "HIGH" as const, disposition: "AGREED_ACTION" as const,
    requiresUserDecision: true, rationale: "The reviewer requires an explicit decision." };
  const review = withEvidence({ role: "codex", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async () => ({ kind: "REVIEW", summary: "Decision needed", status: "blocked", findings: [judgment], evidenceRefs: [], requestedUserDecision: "Confirm required verification" })
  }, reopened, join(root, "images"));
  const reviewed = await review.resumeTurn({ cwd: root, sessionId: "review", prompt: "Review", implementation: true });
  expect(reviewed.findings).toEqual([judgment]);
  expect(reviewed.status).toBe("blocked"); expect(reviewed.requestedUserDecision).toBe("Confirm required verification");
  const omitted = withEvidence({ role: "codex", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async () => ({ kind: "REVIEW", summary: "done", status: "completed", findings: [], evidenceRefs: [] })
  }, reopened, join(root, "images"));
  const missing = await omitted.resumeTurn({ cwd: root, sessionId: "review", prompt: "Review", implementation: true });
  expect(missing.findings).toEqual([]);
  expect(() => assertFindingCoverage([judgment], missing.findings, "review")).toThrow();
  expect(delivered.prompt).toContain("Do not automatically repeat failed reads");
  expect(delivered.prompt).not.toContain("Repeat these reads before completing");
  const failure = JSON.parse(readFileSync(delivered.readablePaths.find((path: string) => path.endsWith(".json")), "utf8"));
  expect(failure.observation).toMatchObject({ content: "Access denied", isError: true });
  reopened.evidence.designRequest(topic, request);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([request]);
  expect(reopened.evidence.failedDesignRequests(topic)).toEqual([]);
  reopened.evidence.designRequest(topic, request, true);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([]);
});

it("detaching an independent Figma file disposes only its requests and permits the remaining product task", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Behavior")]);
  const one = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const two = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/other?node-id=3-4" });
  const first = { tool: "mcp__figma-desktop__get_metadata", input: { nodeId: "1:2" } };
  const second = { tool: "mcp__figma-desktop__get_metadata", input: { nodeId: "3:4" } };
  db.evidence.designRequest(topic, first); db.evidence.designRequest(topic, second);
  db.evidence.detach(topic.id, one.id);
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([second]);
  db.evidence.detach(topic.id, two.id);
  let delivered: any;
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async turn => { delivered = turn; return { kind: "IMPLEMENTATION", summary: "Product work", status: "completed", findings: [], evidenceRefs: [] }; }
  }, db, join(root, "images"));
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
  expect(delivered.figmaReadEnabled).toBe(false); expect(db.evidence.pendingDesignRequests(topic)).toEqual([]);
});

it("keeps a child-node read pending while its parent screen remains linked", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Product behavior")]);
  const parent = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const child = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-3" });
  const request = { tool: "mcp__figma-desktop__get_design_context", input: { nodeId: "1:3" } };
  db.evidence.designRequest(topic, request);
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  reopened.evidence.detach(topic.id, child.id);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([request]);
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async () => ({ kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] })
  }, reopened, join(root, "images"));
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
  expect(reopened.evidence.designReadGaps(topic).map(gap => gap.request)).toEqual([request]);
  reopened.evidence.detach(topic.id, parent.id);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([]);
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
});

it.each(["blocked", "in_progress"] as const)("preserves a %s report with missing native design responses for the existing workflow", async status => {
  const { ClaudeAdapter } = await import("../src/server/adapters/claude");
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Behavior")]);
  db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const native = new ClaudeAdapter({ run: async spec => {
    spec.onJSONLine?.({ type: "assistant", message: { content: [{ type: "tool_use", id: "pending", name: "mcp__figma-desktop__get_metadata", input: { nodeId: "1:2" } }] } }, Date.now());
    return { exitCode: 0, stdout: "", stderr: "", jsonLines: [{ type: "result", subtype: "success", num_turns: 1, structured_output: {
      kind: "IMPLEMENTATION", summary: "Saved partial work", status, requestedUserDecision: "Reconnect Figma", findings: [], evidenceRefs: [],
    } }] };
  } }, undefined, { figmaMcpUrl: "http://127.0.0.1:3845/mcp" });
  const result = await withEvidence(native, db, join(root, "images")).resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true });
  expect(result).toMatchObject({ status, requestedUserDecision: "Reconnect Figma", summary: "Saved partial work" });
  expect(db.evidence.pendingDesignRequests(topic)).toHaveLength(1);
});

it("keeps an unresolved child-node read when only another candidate screen is detached", async () => {
  const { db, root, topic, source: slack, ingest } = setup(); ingest([unit("1", "Product behavior")]);
  const screenA = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const screenB = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=3-4" });
  const request = { tool: "mcp__figma-desktop__get_design_context", input: { nodeId: "1:10" } };
  db.evidence.designRequest(topic, request);
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  reopened.evidence.detach(topic.id, screenB.id);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([request]);
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async () => ({ kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] })
  }, reopened, join(root, "images"));
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
  expect(reopened.evidence.designReadGaps(topic).map(gap => gap.request)).toEqual([request]);
  reopened.evidence.detach(topic.id, screenA.id);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([]);
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
  expect(reopened.evidence.get(slack.id)).toBeTruthy();
});

it("restores candidate links when a child-node read is retried after a screen is reattached", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Product behavior")]);
  const inputA = { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" };
  const inputB = { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=3-4" };
  const screenA = db.evidence.register(topic.id, inputA);
  const screenB = db.evidence.register(topic.id, inputB);
  const request = { tool: "mcp__figma-desktop__get_design_context", input: { nodeId: "3:10" } };
  db.evidence.designRequest(topic, request);
  db.evidence.detach(topic.id, screenB.id);
  db.evidence.register(topic.id, inputB);
  db.evidence.designRequest(topic, request); // Retry is still waiting for a successful response.
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  reopened.evidence.detach(topic.id, screenA.id);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([request]);
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async () => ({ kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] })
  }, reopened, join(root, "images"));
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
  expect(reopened.evidence.designReadGaps(topic).map(gap => gap.request)).toEqual([request]);
  reopened.evidence.detach(topic.id, screenB.id);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([]);
});

it("reactivates an unresolved read when its last screen is reattached before another tool call", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Product behavior")]);
  const screenInput = { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" };
  const screen = db.evidence.register(topic.id, screenInput);
  const request = { tool: "mcp__figma-desktop__get_design_context", input: { nodeId: "1:10" } };
  db.evidence.designRequest(topic, request);
  db.evidence.detach(topic.id, screen.id);
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([]);
  db.evidence.register(topic.id, screenInput); // No native retry has happened yet.
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([request]);
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async () => ({ kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] })
  }, reopened, join(root, "images"));
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
  expect(reopened.evidence.designReadGaps(topic).map(gap => gap.request)).toEqual([request]);
});

it("keeps an uncaptured read pending when a different screen in the same Figma file is linked", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Product behavior")]);
  const first = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const request = { tool: "mcp__figma-desktop__get_design_context", input: { nodeId: "1:10" } };
  db.evidence.designRequest(topic, request);
  db.evidence.detach(topic.id, first.id);
  db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=3-4" });
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  expect(reopened.evidence.pendingDesignRequests(topic)).toEqual([request]);
  const adapter = withEvidence({ role: "claude", validateExistingSession: async () => true, createSession: async () => { throw Error("unused"); },
    resumeTurn: async () => ({ kind: "IMPLEMENTATION", summary: "done", status: "completed", findings: [], evidenceRefs: [] })
  }, reopened, join(root, "images"));
  expect((await adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Continue", implementation: true })).status).toBe("completed");
  expect(reopened.evidence.designReadGaps(topic).map(gap => gap.request)).toEqual([request]);
});

// E3-1 쪽·구간 전달: 두 소비처(중재자 batch·러너 턴)가 한 쪽 구성 규칙을 쓴다. 공개 경계는 store 의 batch·ack·packet·receipt, 서비스 응답,
// 실제 어댑터 래퍼(withEvidence)다. 영수증·진행 위치는 같은 sqlite 파일을 따로 열어 확인한다(ack 전 완료 기록이 없다는 계약).
describe("E3-1 근거 쪽·구간 전달", () => {
  // 단위 본문 최대 길이는 JS 문자열 길이(UTF-16 코드 단위) 160,000 이다 — 이모지만으로는 80,000 코드 포인트가 최대다.
  const MAX_CONTENT = 160_000;
  const fill = (alphabet: string[]) => {
    let content = "";
    for (let index = 0; content.length + alphabet[index % alphabet.length].length <= MAX_CONTENT; index++) content += alphabet[index % alphabet.length];
    return content;
  };
  const korean = fill(Array.from({ length: 64 }, (_, index) => String.fromCodePoint(0xAC00 + index * 7)));
  const emoji = fill(Array.from({ length: 80 }, (_, index) => String.fromCodePoint(0x1F600 + index)));
  const escapes = fill(['"', "\\", "\n", "\u0001", "\u001f", "\t", "a"]);
  const splitsSurrogate = (text: string) => /^[\uDC00-\uDFFF]/.test(text) || /[\uD800-\uDBFF]$/.test(text);
  type Delivered = { unitId: string; content: string; range?: EvidenceRange };
  // 구간을 받은 순서대로 잇는다. 구간은 앞 구간의 끝에서 시작해야 하고, 서로게이트를 가르지 않아야 한다.
  function reassemble(delivered: Delivered[]): Map<string, string> {
    const joined = new Map<string, { text: string; end: number }>();
    for (const item of delivered) {
      expect(splitsSurrogate(item.content), item.unitId).toBe(false);
      if (!item.range) { expect(joined.has(item.unitId), item.unitId).toBe(false); joined.set(item.unitId, { text: item.content, end: -1 }); continue; }
      const previous = joined.get(item.unitId) ?? { text: "", end: 0 };
      expect(item.range.offset, item.unitId).toBe(previous.end);
      expect(Array.from(item.content).length, item.unitId).toBe(item.range.end - item.range.offset);
      joined.set(item.unitId, { text: previous.text + item.content, end: item.range.end });
    }
    return new Map([...joined].map(([id, value]) => [id, value.text]));
  }
  function drainMediator(db: ConsensusDatabase, topic: Parameters<ConsensusDatabase["evidence"]["mediatorBatch"]>[0], session: string, pageBytes?: number) {
    const pages: MediatorEvidenceBatch[] = [];
    for (let round = 0; round < 200; round++) {
      const page = db.evidence.mediatorBatch(topic, session, { pageBytes });
      if (page.batchId === null) return pages;
      expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThanOrEqual(pageBytes ?? EVIDENCE_PAGE_BYTES);
      pages.push(page); db.evidence.acknowledgeMediator(topic, session, page.batchId);
    }
    throw new Error("mediator pages did not drain");
  }
  const runnerRows = (prompt: string) => prompt.split("\n").filter(line => line.startsWith('{"sourceId"') && line.includes('"content"'))
    .map(line => JSON.parse(line) as Delivered);
  const recorder = (prompts: string[], fail = () => false): AgentAdapter => ({ role: "claude", validateExistingSession: async () => true,
    createSession: async () => { throw new Error("unused"); },
    resumeTurn: async turn => { prompts.push(turn.prompt); if (fail()) throw new Error("model failure"); return {} as any; } });
  const rows = (root: string, sql: string, ...values: string[]) => {
    const raw = new DatabaseSync(join(root, "room.sqlite"));
    try { return raw.prepare(sql).all(...values); } finally { raw.close(); }
  };

  it("최대 길이 단위 세 종류(한국어·이모지·JSON escape)를 두 소비처 모두 코드 포인트 구간으로 나눠 싣고, 이으면 원문과 같다", async () => {
    const { db, root, topic, ingest } = setup();
    ingest([unit("escape", escapes), unit("emoji", emoji), unit("korean", korean)]);
    expect(Array.from(emoji).length).toBe(80_000);
    const originals = new Map([["escape", escapes], ["emoji", emoji], ["korean", korean]]);
    const pages = drainMediator(db, topic, "mediator");
    expect(pages.length).toBeGreaterThan(3);
    const mediatorItems = pages.flatMap(page => page.changes.map(change => ({ unitId: change.id, content: change.content, range: change.range })));
    expect(reassemble(mediatorItems)).toEqual(originals);
    expect(mediatorItems.every(item => item.range?.total === Array.from(originals.get(item.unitId)!).length)).toBe(true);
    const prompts: string[] = [];
    const adapter = withEvidence(recorder(prompts), db, join(root, "images"));
    for (let round = 0; round < 20 && prompts.at(-1) !== "Task"; round++) await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    expect(prompts.at(-1)).toBe("Task");
    for (const prompt of prompts) expect(Buffer.byteLength(prompt.slice("Task\n\n".length))).toBeLessThanOrEqual(EVIDENCE_PAGE_BYTES);
    expect(reassemble(prompts.flatMap(runnerRows))).toEqual(originals);
  });

  it("끝 구간을 확인하기 전에는 그 단위의 완료 영수증이 없고, 실패한 턴은 진행 위치를 옮기지 않으며, 새 세션은 처음부터 받는다", async () => {
    const { db, root, topic, source, ingest } = setup();
    ingest([unit("big", korean)]);
    const prompts: string[] = []; let failing = false;
    const adapter = withEvidence(recorder(prompts, () => failing), db, join(root, "images"));
    const turn = { sessionId: "runner", cwd: root, prompt: "Task" };
    await adapter.resumeTurn(turn);
    const [first] = runnerRows(prompts[0]);
    expect(first.range).toMatchObject({ offset: 0, total: Array.from(korean).length });
    const receipts = () => rows(root, "SELECT unit_id FROM evidence_receipts WHERE unit_id='big'");
    const progress = () => rows(root, "SELECT next_offset FROM evidence_receipt_progress WHERE unit_id='big'");
    expect(receipts()).toEqual([]); expect(progress()).toEqual([{ next_offset: first.range!.end }]);
    failing = true; await expect(adapter.resumeTurn(turn)).rejects.toThrow("model failure"); failing = false;
    expect(progress()).toEqual([{ next_offset: first.range!.end }]);
    expect(runnerRows(db.evidence.packet(topic, "claude", "other").text)[0].range?.offset).toBe(0);
    for (let round = 0; round < 5 && prompts.at(-1) !== "Task"; round++) await adapter.resumeTurn(turn);
    expect(receipts()).toEqual([{ unit_id: "big" }]); expect(progress()).toEqual([]);
    // 중재자도 같다: 끝 구간 ack 전에는 완료 영수증 없이 진행 위치만 있다.
    const page = db.evidence.mediatorBatch(topic, "mediator");
    expect(page.changes[0].range).toMatchObject({ offset: 0 });
    db.evidence.acknowledgeMediator(topic, "mediator", page.batchId!);
    expect(rows(root, "SELECT unit_id FROM evidence_mediator_unit_receipts WHERE source_id=?", source.id)).toEqual([]);
    expect(rows(root, "SELECT next_offset FROM evidence_mediator_progress WHERE source_id=?", source.id)).toEqual([{ next_offset: page.changes[0].range!.end }]);
  });

  it("구간 전달 중 단위가 바뀌면 진행 위치를 버리고 새 해시로 처음부터 싣는다(두 소비처)", async () => {
    const { db, root, topic, ingest } = setup();
    ingest([unit("big", korean)]);
    const page = db.evidence.mediatorBatch(topic, "mediator");
    db.evidence.acknowledgeMediator(topic, "mediator", page.batchId!);
    const prompts: string[] = [];
    const adapter = withEvidence(recorder(prompts), db, join(root, "images"));
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    const changed = `변경 ${korean}`.slice(0, MAX_CONTENT);
    ingest([unit("big", changed)], "r2");
    const hash = db.evidence.snapshot(db.evidence.list(topic.id)[0].id)!.units[0].contentHash;
    const next = db.evidence.mediatorBatch(topic, "mediator");
    expect(next.changes[0]).toMatchObject({ contentHash: hash, range: { offset: 0 } });
    expect(next.changes[0].content.startsWith("변경 ")).toBe(true);
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    const [row] = runnerRows(prompts[1]);
    expect(row).toMatchObject({ hash, range: { offset: 0 } }); expect(row.content.startsWith("변경 ")).toBe(true);
  });

  it("모두 확인한 뒤 한 단위만 바뀌면 다음 쪽에는 그 단위만 싣는다 — 바뀌지 않은 단위를 다시 보내지 않는다(두 소비처)", async () => {
    const { db, root, topic, ingest } = setup();
    const units = ["a", "b", "c", "d"].map(id => unit(id, `stable ${id}`));
    ingest(units);
    drainMediator(db, topic, "mediator");
    const prompts: string[] = [];
    const adapter = withEvidence(recorder(prompts), db, join(root, "images"));
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    expect(prompts[1]).toBe("Task");
    ingest([...units.slice(0, 2), unit("c", "changed c"), units[3]], "r2");
    const next = db.evidence.mediatorBatch(topic, "mediator");
    expect(next.changes.map(change => change.id)).toEqual(["c"]); expect(next.remaining).toBe(0);
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    expect(runnerRows(prompts[2]).map(row => row.unitId)).toEqual(["c"]);
  });

  it("pageBytes 는 요청자가 고르는 최대 쪽 크기다 — 작은 요청은 작은 쪽, 대기 쪽보다 작으면 새 쪽으로 바꾸고 옛 batchId 는 거부, 담을 수 없으면 최소 바이트와 함께 409", () => {
    const { db, topic, ingest } = setup();
    ingest(Array.from({ length: 20 }, (_, index) => unit(`u${String(index).padStart(2, "0")}`, "x".repeat(1_000))));
    const large = db.evidence.mediatorBatch(topic, "s");
    expect(large).toMatchObject({ remaining: 0, nextCursor: null }); expect(large.changes).toHaveLength(20);
    expect(db.evidence.mediatorBatch(topic, "s", { pageBytes: EVIDENCE_PAGE_BYTES }).batchId).toBe(large.batchId);
    const small = db.evidence.mediatorBatch(topic, "s", { pageBytes: 5_000 });
    expect(small.batchId).not.toBe(large.batchId);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(5_000);
    expect(small.changes.length).toBeLessThan(20); expect(small.remaining).toBe(20 - small.changes.length);
    expect(() => db.evidence.acknowledgeMediator(topic, "s", large.batchId!)).toThrow("미확인 배치가 아닙니다");
    expect(db.evidence.mediatorBatch(topic, "s", { pageBytes: EVIDENCE_PAGE_BYTES }).batchId).toBe(small.batchId);
    expect(() => db.evidence.mediatorBatch(topic, "tiny", { pageBytes: 50 })).toThrow(/최소 \d+B/);
    for (const pageBytes of [0, 1.5, EVIDENCE_PAGE_BYTES + 1]) {
      expect(() => db.evidence.mediatorBatch(topic, "invalid", { pageBytes })).toThrow(expect.objectContaining({ statusCode: 400 }));
    }
    const pages = drainMediator(db, topic, "s", 5_000);
    expect(pages.length).toBeGreaterThan(1);
  });

  it("서비스 응답 본문(이미지 경로·currentDigest·superseded 포함)으로 쪽 크기를 재고, ack 전 원문 갱신은 옛 쪽을 superseded 로 돌려준 뒤 새 해시로 다시 싣는다", async () => {
    const { db, root, topic, source } = setup(); db.evidence.useRest(source.id);
    const first = [unit("a-big", korean), { id: "b-render", kind: "render" as const, content: "design", imageBase64: png }];
    const fetch = vi.fn(async () => ({ revision: "r1", units: first }));
    const service = new EvidenceService(db.evidence, { fetch }, undefined, join(root, "images"));
    const responses = [];
    for (let round = 0; round < 60; round++) {
      const response = await service.prepareMediator(db, topic.id, "s", 30_000);
      if (response.batchId === null) break;
      expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThanOrEqual(30_000);
      responses.push(response); db.evidence.acknowledgeMediator(topic, "s", response.batchId);
    }
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(reassemble(responses.flatMap(page => page.changes.map(change => ({ unitId: change.id, content: change.content, range: change.range })))))
      .toEqual(new Map([["a-big", korean], ["b-render", "design"]]));
    expect(responses.flatMap(page => page.images)).toEqual([{ hash: expect.any(String), path: expect.stringContaining(join(root, "images")) }]);
    const again = [unit("a-big", "short"), first[1]];
    const pending = await service.prepareMediator(db, topic.id, "fresh");
    db.evidence.ingest(source.id, { checkId: db.evidence.begin(source.id, true)!.checkId, revision: "r2", units: again });
    const stale = await service.prepareMediator(db, topic.id, "fresh");
    expect(stale).toMatchObject({ batchId: pending.batchId, superseded: true });
    db.evidence.acknowledgeMediator(topic, "fresh", pending.batchId!);
    const next = await service.prepareMediator(db, topic.id, "fresh");
    expect(next.changes.map(change => [change.id, change.content])).toEqual([["a-big", "short"], ["b-render", "design"]]);
    await service.stop();
  });

  // host-review 530cd5fe F001: 마지막 항목을 넣으면 nextCursor 가 null 이 되고 러너 잔여 안내가 사라져 쪽이 오히려 작아진다.
  it("모든 항목을 실은 쪽이 한 항목만 실은 쪽보다 작아도 그 크기의 요청을 받아들이고, 409 의 최소 바이트는 가장 작은 쪽이다(두 소비처)", async () => {
    const { db, root, topic, ingest } = setup();
    ingest([unit("u1", "first"), unit("u2", "second")]);
    for (const session of ["probe", "real"]) drainMediator(db, topic, session);
    const prompts: string[] = [];
    const adapter = withEvidence(recorder(prompts), db, join(root, "images"));
    for (const session of ["probe", "real"]) await adapter.resumeTurn({ sessionId: session, cwd: root, prompt: "Task" });
    ingest([], "r2");
    const probe = db.evidence.mediatorBatch(topic, "probe");
    expect(probe.removedUnits.map(item => item.unitId)).toEqual(["u1", "u2"]);
    const full = Buffer.byteLength(JSON.stringify(probe));
    const error = (() => { try { db.evidence.mediatorBatch(topic, "real", { pageBytes: full - 1 }); } catch (caught) { return String(caught); } return ""; })();
    expect(error).toContain(`최소 ${full}B`);
    const page = db.evidence.mediatorBatch(topic, "real", { pageBytes: full });
    expect(page.removedUnits.map(item => item.unitId)).toEqual(["u1", "u2"]);
    expect(page).toMatchObject({ remaining: 0, nextCursor: null });
    const text = db.evidence.packet(topic, "claude", "probe").text;
    const runner = db.evidence.packet(topic, "claude", "real", { pageBytes: Buffer.byteLength(text) });
    expect(runner.entries.map(entry => entry.type)).toEqual(["removedUnit", "removedUnit"]);
    expect(runner.text).toBe(text);
  });

  // host-review 530cd5fe F002: 완료한 버전 A 로 되돌아와도, 소비처가 마지막으로 받은 것은 다른 버전 B 의 일부다 — 현재 버전을 다시 싣는다.
  it("다른 버전의 구간을 받은 뒤 원문이 이전에 완료한 버전으로 되돌아오면 현재 버전을 처음부터 다시 싣는다(두 소비처)", async () => {
    const { db, root, topic, ingest } = setup();
    ingest([unit("big", "A")]);
    drainMediator(db, topic, "mediator");
    const prompts: string[] = [];
    const adapter = withEvidence(recorder(prompts), db, join(root, "images"));
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    ingest([unit("big", korean)], "r2");
    const partial = db.evidence.mediatorBatch(topic, "mediator");
    expect(partial.changes[0].range).toMatchObject({ offset: 0 });
    db.evidence.acknowledgeMediator(topic, "mediator", partial.batchId!);
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    expect(runnerRows(prompts[1])[0].range).toMatchObject({ offset: 0 });
    const restored = ingest([unit("big", "A")], "r3");
    const hash = db.evidence.snapshot(restored.id)!.units[0].contentHash;
    const back = db.evidence.mediatorBatch(topic, "mediator");
    expect(back.changes.map(change => [change.id, change.content, change.contentHash, change.range])).toEqual([["big", "A", hash, undefined]]);
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    expect(runnerRows(prompts[2]).map(row => [row.unitId, row.content, row.range])).toEqual([["big", "A", undefined]]);
    db.evidence.acknowledgeMediator(topic, "mediator", back.batchId!);
    expect(db.evidence.mediatorBatch(topic, "mediator").batchId).toBeNull();
    await adapter.resumeTurn({ sessionId: "runner", cwd: root, prompt: "Task" });
    expect(prompts[3]).toBe("Task");
  });

  // eef75b21 F002: 복원 버전도 여러 쪽이면 첫 구간 확인 뒤 같은 해시의 옛 완료 기록보다 진행 위치가 우선해야 한다.
  it("여러 쪽인 A 완료 후 B 일부를 받고 A로 복원하면 두 소비처가 A의 마지막 구간까지 다시 받는다", async () => {
    const { db, root, topic, ingest } = setup();
    ingest([unit("big", korean)]);
    drainMediator(db, topic, "mediator");
    const prompts: string[] = [];
    const adapter = withEvidence(recorder(prompts), db, join(root, "images"));
    const turn = { sessionId: "runner", cwd: root, prompt: "Task" };
    const drainRunner = async () => {
      const start = prompts.length;
      for (let round = 0; round < 20; round++) {
        await adapter.resumeTurn(turn);
        if (prompts.at(-1) === "Task") return prompts.slice(start).flatMap(runnerRows);
      }
      throw new Error("runner pages did not drain");
    };
    expect(reassemble(await drainRunner())).toEqual(new Map([["big", korean]]));
    ingest([unit("big", escapes)], "r2");
    const partial = db.evidence.mediatorBatch(topic, "mediator");
    expect(partial.changes[0].range).toMatchObject({ offset: 0 });
    db.evidence.acknowledgeMediator(topic, "mediator", partial.batchId!);
    await adapter.resumeTurn(turn);
    expect(runnerRows(prompts.at(-1)!)[0].range).toMatchObject({ offset: 0 });
    ingest([unit("big", korean)], "r3");
    const restored = drainMediator(db, topic, "mediator");
    const received = await drainRunner();
    expect(restored.length).toBeGreaterThan(1);
    expect(received.length).toBeGreaterThan(1);
    expect(reassemble(restored.flatMap(page => page.changes.map(change => ({ unitId: change.id, content: change.content, range: change.range })))))
      .toEqual(new Map([["big", korean]]));
    expect(reassemble(received)).toEqual(new Map([["big", korean]]));
    expect(restored.at(-1)).toMatchObject({ remaining: 0, nextCursor: null });
    expect(received.at(-1)?.range?.end).toBe(Array.from(korean).length);
    expect(db.evidence.mediatorBatch(topic, "mediator").batchId).toBeNull();
    await adapter.resumeTurn(turn);
    expect(prompts.at(-1)).toBe("Task");
  });

  // eef75b21 F004: 부분 구간의 range 포장보다 짧은 단위 전체가 작을 수 있다. 실제 성공 응답의 크기로 최소 안내를 대조한다.
  it.each(["hi", "한글", "😀😃", '"\n'])("짧은 첫 단위 %j 전체의 응답 크기를 최소 크기 안내에서 빠뜨리지 않는다", async content => {
    const { db, root, topic, source } = setup(); db.evidence.useRest(source.id);
    const fetch = vi.fn(async () => ({ revision: "r1", units: [unit("first", content), unit("second", "z".repeat(10_000))] }));
    const service = new EvidenceService(db.evidence, { fetch }, undefined, join(root, "images"));
    try {
      const probe = await service.prepareMediator(db, topic.id, "probe", 2_000);
      expect(probe.changes.map(change => [change.id, change.content, change.range])).toEqual([["first", content, undefined]]);
      const minimum = Buffer.byteLength(JSON.stringify(probe));
      await expect(service.prepareMediator(db, topic.id, "real", minimum - 1)).rejects.toThrow(`최소 ${minimum}B`);
      const exact = await service.prepareMediator(db, topic.id, "real", minimum);
      expect(Buffer.byteLength(JSON.stringify(exact))).toBe(minimum);
      expect(exact.changes.map(change => change.content)).toEqual([content]);
      const runnerProbe = db.evidence.packet(topic, "claude", "probe", { pageBytes: 2_000 });
      expect(runnerRows(runnerProbe.text).map(row => [row.unitId, row.content, row.range])).toEqual([["first", content, undefined]]);
      const runnerMinimum = Buffer.byteLength(runnerProbe.text);
      expect(() => db.evidence.packet(topic, "claude", "real", { pageBytes: runnerMinimum - 1 })).toThrow(`최소 ${runnerMinimum}B`);
      expect(db.evidence.packet(topic, "claude", "real", { pageBytes: runnerMinimum }).text).toBe(runnerProbe.text);
      expect(fetch).toHaveBeenCalledTimes(1);
    } finally { await service.stop(); }
  });

  // host-review 530cd5fe F003: 대기 쪽은 저장 때 잰 바이트가 아니라 지금 돌려줄 포장으로 다시 잰다(데이터 폴더를 옮겨 이미지 경로가 길어진 재시작).
  it("재시작 뒤 이미지 경로가 길어져 대기 쪽이 요청 크기를 넘으면 그대로 돌려주지 않고 요청 크기 안의 새 쪽으로 바꾼다", async () => {
    const { db, root, topic, source } = setup(); db.evidence.useRest(source.id);
    const fetch = vi.fn(async () => ({ revision: "r1", units: [{ id: "render", kind: "render" as const, content: "design", imageBase64: png }, unit("z", "zeta")] }));
    const before = new EvidenceService(db.evidence, { fetch }, undefined, join(root, "i"));
    const first = await before.prepareMediator(db, topic.id, "s");
    const size = Buffer.byteLength(JSON.stringify(first));
    await before.stop();
    const after = new EvidenceService(db.evidence, { fetch }, undefined, join(root, "moved-data-directory-with-a-much-longer-name", "images"));
    const replayed = await after.prepareMediator(db, topic.id, "s", size);
    expect(Buffer.byteLength(JSON.stringify(replayed))).toBeLessThanOrEqual(size);
    expect(replayed.batchId).not.toBe(first.batchId);
    expect(() => db.evidence.acknowledgeMediator(topic, "s", first.batchId!)).toThrow("미확인 배치가 아닙니다");
    expect(fetch).toHaveBeenCalledTimes(1);
    await after.stop();
  });

  describe("E3-1 이전 중재자 기록(소스별 스냅샷 manifest) 호환", () => {
    // 옛 서버가 남긴 기록: 소비처(주제·범위 세대·세션)별로 확인한 [sourceId, snapshotHash] 목록.
    function legacy(root: string, session: string, manifest: Array<[string, string]>) {
      const raw = new DatabaseSync(join(root, "room.sqlite"));
      try { raw.prepare("INSERT INTO evidence_mediator_consumers(consumer,manifest,ack_id) VALUES (?,?,?)").run(JSON.stringify(["topic", 1, session]), JSON.stringify(manifest), "old"); }
      finally { raw.close(); }
    }
    it("정확한 스냅샷이 있으면 그 버전 단위만 확인한 것으로 보고, 이후 버전의 새·변경 단위는 싣는다", () => {
      const { db, root, topic, source, ingest } = setup();
      const acknowledged = ingest([unit("1", "A"), unit("2", "B")]).contentHash!;
      ingest([unit("1", "A"), unit("2", "B changed"), unit("3", "C")], "r2");
      legacy(root, "legacy", [[source.id, acknowledged]]);
      expect(db.evidence.mediatorBatch(topic, "legacy").changes.map(change => change.id)).toEqual(["2", "3"]);
    });
    it("스냅샷이 없거나 단위 레코드가 빠져 불완전하면 옮기지 않고 모두 다시 싣는다", () => {
      const { db, root, topic, source, ingest } = setup();
      const acknowledged = ingest([unit("1", "A"), unit("old", "only in the old version")]).contentHash!;
      const oldUnit = db.evidence.snapshot(source.id)!.units.find(item => item.id === "old")!.contentHash;
      ingest([unit("1", "A"), unit("2", "B")], "r2");
      legacy(root, "missing", [[source.id, "f".repeat(64)]]);
      expect(db.evidence.mediatorBatch(topic, "missing").changes.map(change => change.id)).toEqual(["1", "2"]);
      const raw = new DatabaseSync(join(root, "room.sqlite"));
      try { raw.prepare("DELETE FROM evidence_units WHERE hash=?").run(oldUnit); } finally { raw.close(); }
      legacy(root, "incomplete", [[source.id, acknowledged]]);
      expect(db.evidence.mediatorBatch(topic, "incomplete").changes.map(change => change.id)).toEqual(["1", "2"]);
    });
    it("옮기기는 소비처마다 한 번이다 — 확인한 삭제를 옛 기록이 되살리지 않는다", () => {
      const { db, root, topic, source, ingest } = setup();
      const acknowledged = ingest([unit("1", "A"), unit("2", "B")]).contentHash!;
      legacy(root, "legacy", [[source.id, acknowledged]]);
      expect(db.evidence.mediatorBatch(topic, "legacy").batchId).toBeNull();
      ingest([unit("2", "B")], "r2");
      const removal = db.evidence.mediatorBatch(topic, "legacy");
      expect(removal.removedUnits).toEqual([{ sourceId: source.id, unitId: "1" }]);
      db.evidence.acknowledgeMediator(topic, "legacy", removal.batchId!);
      const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
      expect(reopened.evidence.mediatorBatch(topic, "legacy").batchId).toBeNull();
    });
  });
});

it("rejects invalid scoped Jira routing and a different source site before sending credentials", async () => {
  const { db, topic } = setup();
  const source = db.evidence.register(topic.id, { ...sourceInput, url: "https://team.atlassian.net/browse/APP-12" });
  const request = vi.fn();
  for (const jiraCloudId of ["", "../another-tenant", "11111111-1111-4111-8111-111111111111/extra"]) {
    const connector = new RestEvidenceConnector({ jiraSite: "https://team.atlassian.net", jiraEmail: "test", jiraToken: "secret", jiraCloudId }, request);
    await expect(connector.fetch(source, null, new AbortController().signal)).rejects.toThrow("Cloud ID");
    await expect(connector.discover(source, null, new AbortController().signal)).rejects.toThrow("Cloud ID");
  }
  const differentSite = new RestEvidenceConnector({ jiraSite: "https://other.atlassian.net", jiraEmail: "test", jiraToken: "secret", jiraCloudId: "11111111-1111-4111-8111-111111111111" }, request);
  await expect(differentSite.fetch(source, null, new AbortController().signal)).rejects.toThrow("연결");
  await expect(differentSite.discover(source, null, new AbortController().signal)).rejects.toThrow("연결");
  expect(request).not.toHaveBeenCalled();
});

it("delivers originals and receipts by explicit topic identity for shared directories",async()=>{
  const {db,root,topic,ingest}=setup();ingest([unit("a","First topic original")]);
  const second=db.createTopic({...topic,id:"second",slug:"second",title:"Second",updatedAt:"2099-01-01T00:00:00.000Z"});
  const source=db.evidence.register(second.id,{...sourceInput,url:"https://example.com/second"});
  const check=db.evidence.begin(source.id,true)!;db.evidence.ingest(source.id,{checkId:check.checkId,revision:"v1",units:[unit("b","Second topic original")]});
  const prompts:string[]=[];const adapter=withEvidence({role:"claude",validateExistingSession:async()=>true,createSession:async turn=>{prompts.push(turn.prompt);return {sessionId:`session-${turn.topicId}`,result:{kind:"BRAINSTORM",summary:"done",findings:[],evidenceRefs:[]}};},resumeTurn:async()=>{throw new Error("unused");}},db,join(root,"images"));
  for (const id of [topic.id,second.id]) await adapter.createSession({topicId:id,cwd:root,prompt:"discuss"});
  expect(prompts[0]).toContain("First topic original");expect(prompts[0]).not.toContain("Second topic original");expect(prompts[1]).toContain("Second topic original");
  expect(db.evidence.packet(topic,"claude",`session-${topic.id}`).text).not.toContain("First topic original");
  await expect(adapter.createSession({cwd:root,prompt:"ambiguous"})).rejects.toThrow("명시적인 topicId");
});
