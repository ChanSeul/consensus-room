import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { parseEvidenceSource, type EvidenceSourceInput, type EvidenceUnitInput } from "../src/shared/externalEvidence";
import { EvidenceService, withEvidence } from "../src/server/evidence/service";
import { RestEvidenceConnector } from "../src/server/evidence/connectors";
import type { AgentAdapter } from "../src/server/types";

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
    const packet = db.evidence.packet(topic, "claude"); db.evidence.receipt(topic, "claude", "s1", packet.delivered);
    const second = ingest([unit("2", "Question"), { ...unit("1", "Decision"), changedAt: "new" }], "r2");
    expect(second.contentHash).toBe(first.contentHash);
    expect(db.evidence.packet(topic, "claude", "s1").text).not.toContain('"content":"Decision"');
    ingest([unit("1", "Changed")]);
    const changed = db.evidence.packet(topic, "claude", "s1");
    expect(changed.text).toContain('"content":"Changed"'); expect(changed.text).toContain('"removedUnitId":"2"');
    expect(db.evidence.snapshot(source.id, first.contentHash!)?.units).toHaveLength(2);
    db.evidence.receipt(topic, "claude", "s1", changed.delivered);
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
    expect(() => db.evidence.review(topic, db.evidence.topic(topic).digest, "ignore", topic)).toThrow("최신");
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
    db.evidence.receipt(topic, "claude", "session", db.evidence.packet(topic, "claude").delivered);
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
  it("uses Jira revision probes; paginates comments and rejects an update during collection", async () => {
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
    const connector = new RestEvidenceConnector({ jiraSite: "https://team.atlassian.net", jiraEmail: "test", jiraToken: "secret" }, request as typeof fetch);
    const initial = await connector.fetch(source, null, new AbortController().signal);
    expect(initial.units).toHaveLength(3);
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
  db.evidence.receipt(topic, "claude", "session", db.evidence.packet(topic, "claude").delivered);
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
  expect(db.evidence.packet(topic, "claude", "s").delivered.map(row => row.unitId)).toEqual(["decision"]);
  await adapter.resumeTurn(turn); expect(turns[1].prompt).not.toContain("save draft on exit");
  db.evidence.failed(source.id, db.evidence.begin(source.id, true)!.checkId, "offline");
  expect(db.evidence.topic(topic).ready).toBe(false); // Known product comments still require fresh evidence.
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
  db.evidence.receipt(topic, "claude", "s", packet.delivered, packet.links);
  const reopened = new ConsensusDatabase(join(root, "room.sqlite")); databases.push(reopened);
  reopened.evidence.detach(topic.id, source.id);
  const removed = reopened.evidence.packet(topic, "claude", "s");
  expect(removed.text).toContain(`"removedSourceId":"${source.id}"`);
  reopened.evidence.receipt(topic, "claude", "s", removed.delivered, removed.links);
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

it("requires recapture after a missing tool response, including on later no-tool resumes", async () => {
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
  await expect(adapter.resumeTurn(turn)).rejects.toThrow("previous attempt");
  expect(db.evidence.pendingDesignRequests(topic)).toHaveLength(1);
  expect((await adapter.resumeTurn(turn)).evidenceRefs).toHaveLength(1);
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([]);
});

it("does not clear an uncaptured design request when a retry returns a tool error", async () => {
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
  await expect(adapter.resumeTurn({ cwd: root, sessionId: "s", prompt: "Retry", implementation: true })).rejects.toThrow("previous attempt");
  expect(db.evidence.pendingDesignRequests(topic)).toEqual([request]);
  expect(db.evidence.designObservations(topic)).toEqual([]);
});

it("explicit detach disposes only requests tied to that Figma source and permits the remaining product task", async () => {
  const { db, root, topic, ingest } = setup(); ingest([unit("1", "Behavior")]);
  const one = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=1-2" });
  const two = db.evidence.register(topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc?node-id=3-4" });
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
