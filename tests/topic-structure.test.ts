import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { ConsensusDatabase } from "../src/server/database";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import type { Topic } from "../src/shared/contracts";

// Public API contracts: persistent intake, source freshness, hierarchy ownership and real planner input.
// Model/connector responses are fixtures; these checks do not claim live provider execution.
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "topic-structure-"));
  execFileSync("git", ["init", "-q", root]);
  execFileSync("git", ["-C", root, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", root, "config", "user.email", "test@example.invalid"]);
  writeFileSync(join(root, "README.md"), "fixture\n");
  execFileSync("git", ["-C", root, "add", "README.md"]);
  execFileSync("git", ["-C", root, "commit", "-qm", "fixture"]);
  const config = loadConfig({ dataDirectory: root, repositoryPath: root, memoryDirectory: join(root, "memory"),
    databasePath: join(root, "room.sqlite"), worktreesDirectory: join(root, "trees"), topicsDirectory: join(root, "topics"),
    webDirectory: join(root, "no-web"), launchToken: "test", enforceBudgets: false });
  let db = new ConsensusDatabase(config.databasePath);
  const calls: Array<Omit<SessionTurn, "sessionId">> = [];
  // 계획 턴은 결과 봉투 턴이다(⑥) — 플래너 첫 턴이 입력을 확인하고 중재자 결정을 요청한다. 논의(brainstorm) 턴은 결과 메서드 그대로다.
  const adapter = (role: "claude" | "codex"): AgentAdapter => ({ role, validateExistingSession: async () => true,
    createSession: async turn => { calls.push(turn); return { sessionId: `${role}-${calls.length}`, result: { kind: "PLAN", summary: "계획 입력 확인", findings: [], evidenceRefs: [], requestedUserDecision: "범위를 확인하세요." } }; },
    resumeTurn: async () => { throw new Error("Unexpected resumed turn"); },
    createEnvelopeSession: async turn => { calls.push(turn); return { sessionId: `${role}-${calls.length}`,
      envelope: { message: "계획 입력 확인", outcome: "needs-mediator", mediatorRequest: "범위를 확인하세요." } }; },
    resumeEnvelopeTurn: async () => { throw new Error("Unexpected resumed turn"); },
  });
  const build = () => buildApp({ config, database: db, runner: new SpawnCommandRunner(), claude: adapter("claude"), codex: adapter("codex") });
  let app = await build(), serial = 0;
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const post = (path: string, body: Record<string, unknown>, extra: Record<string, string> = {}) => app.inject({ method: "POST", url: `/api/${path}`, payload: body,
    headers: { "x-consensus-token": "test", "idempotency-key": `r-${++serial}`, ...extra } });
  const create = async (body: Record<string, unknown>) => { const result = await post("topics", body); expect(result.statusCode, result.body).toBe(201); return result.json<Topic>(); };
  const done = async (id: string) => { for (let i = 0; db.runningAction(id); i++) { if (i > 1000) throw new Error("action did not settle"); await new Promise(resolve => setTimeout(resolve, 5)); } };
  const attach = async (id: string) => { for (const seat of ["claude", "codex"]) expect((await post(`topics/${id}/participants/${seat}`, { mode: "new" })).statusCode).toBe(200); };
  const restart = async () => { await app.close(); db = new ConsensusDatabase(config.databasePath); app = await build(); };
  return { get db() { return db; }, get app() { return app; }, root, post, create, done, attach, calls, restart };
}

it("persists Root → Sub → Sub → leaf, blocks manager execution, and gives the planner the entire Goal lineage", async () => {
  const f = await fixture();
  const root = await f.create({ title: "제품 큰 그림", topicKind: "group", entry: { mode: "goal", goal: "어떤 언어의 프로젝트에서도 협업한다." } });
  const sub = await f.create({ title: "시작 방식", topicKind: "group", parentTopicId: root.id, entry: { mode: "goal", goal: "사용자의 출발점을 세 경로로 받는다." } });
  const middle = await f.create({ title: "자료 해석", topicKind: "group", parentTopicId: sub.id, entry: { mode: "goal", goal: "링크와 확인된 요구사항을 구분한다." } });
  const leaf = await f.create({ title: "자료 읽기", parentTopicId: middle.id, workflowMode: "planned", entry: { mode: "goal", goal: "원문 읽기 실패를 명확하게 표시한다." } });
  expect(root.worktreePath).toBe(f.root);
  expect(leaf.worktreePath).not.toBe(f.root);
  for (const id of [root.id, sub.id, middle.id]) {
    for (const action of ["plan", "implement", "approve"]) {
      expect((await f.post(`topics/${id}/actions/${action}`, action === "approve" ? { planSHA256: "a".repeat(64) } : {})).statusCode).toBeGreaterThanOrEqual(400);
    }
    expect(f.db.getTopic(id).state).toBe("DRAFT");
  }
  expect((await f.post("topics", { title: "말단 아래 금지", parentTopicId: leaf.id })).statusCode).toBe(409);
  expect((await f.post(`topics/${root.id}/goal`, { goal: "이미 분리한 범위 변경" })).statusCode).toBe(409);
  await f.restart();
  expect(f.db.getTopic(leaf.id)).toMatchObject({ parentTopicId: middle.id, topicKind: "task", workEntry: leaf.workEntry });
  await f.attach(leaf.id);
  expect((await f.post(`topics/${leaf.id}/actions/plan`, {})).statusCode).toBe(200); await f.done(leaf.id);
  expect(f.calls).toHaveLength(1);
  for (const goal of [root, sub, middle, leaf].map(topic => topic.workEntry!.goal!)) expect(f.calls[0].prompt).toContain(goal);
  expect(f.db.getTopic(leaf.id).state).toBe("USER_DECISION_REQUIRED");
  expect((await f.app.inject({ url: `/api/topics/${root.id}/resume`, headers: { "x-consensus-token": "test" } })).json().nextActions.map((action: { action: string }) => action.action)).toEqual(["topic:create-child"]);
});

it("sources can establish a partial Goal with deferred originals; changed sources still invalidate that Goal", async () => {
  const f = await fixture();
  const topic = await f.create({ title: "원문 기반 구현", workflowMode: "planned", entry: { mode: "sources", sources: [{ url: "https://example.com/spec", label: "제품 요구사항" }] } });
  await f.attach(topic.id);
  expect((await f.post(`topics/${topic.id}/actions/plan`, {})).statusCode).toBe(409);
  expect((await f.post(`topics/${topic.id}/goal`, { goal: "원문 미수집 범위를 제외한 읽기 상태 표시", evidenceDigest: f.db.evidence.topic(topic).digest })).statusCode).toBe(200);
  expect(f.db.evidence.topic(f.db.getTopic(topic.id)).deferred).toHaveLength(1);
  expect(f.calls).toHaveLength(0);
  const publish = (revision: string) => {
    const catalog = f.db.evidence.catalog.state(topic.id), root = catalog.roots[0], source = f.db.evidence.get(root.sourceId);
    f.db.evidence.catalog.importHostSnapshot(topic.id, { version: catalog.version, rootId: root.id, sourceId: source.id,
      previousHash: source.contentHash, previousCheckedAt: source.checkedAt, observedAt: Date.now(), revision,
      units: [{ id: "spec", kind: "document", content: revision }], missing: [] }, []);
  };
  publish("실패한 원문을 표시한다");
  let evidence = f.db.evidence.topic(f.db.getTopic(topic.id));
  expect(evidence.ready).toBe(true);
  const goal = { goal: "읽기 실패 상태 표시", evidenceDigest: evidence.digest };
  const set = await f.post(`topics/${topic.id}/goal`, goal, { "idempotency-key": "same-goal" });
  expect(set.statusCode, set.body).toBe(200);
  expect((await f.post(`topics/${topic.id}/goal`, goal, { "idempotency-key": "same-goal" })).body).toBe(set.body);
  publish("오류와 다시 읽기 안내를 표시한다");
  expect((await f.post(`topics/${topic.id}/actions/plan`, {})).statusCode).toBe(409);
  evidence = f.db.evidence.topic(f.db.getTopic(topic.id));
  expect((await f.post(`topics/${topic.id}/goal`, { goal: "오류와 재시도 안내", evidenceDigest: evidence.digest })).statusCode).toBe(200);
  expect((await f.post(`topics/${topic.id}/actions/plan`, {})).statusCode).toBe(200); await f.done(topic.id);
  expect(f.calls).toHaveLength(1);
  expect(f.calls[0].prompt).toContain("오류와 재시도 안내");
  expect(f.db.getTopic(topic.id).workEntry?.mode).toBe("sources");
});

it("mediator source intake preserves source approval and authentication boundaries", async () => {
  const f = await fixture();
  const body = { title: "자료 시작", entry: { mode: "sources", sources: [{ url: "https://example.com/spec", label: "spec" }] } };
  const created = await f.post("topics", body, { "x-consensus-actor": "mediator" });
  expect(created.statusCode, created.body).toBe(201);
  const id = created.json().id;
  expect(f.db.evidence.catalog.state(id).roots[0].status).toBe("proposed");
  const denied = await f.app.inject({ method: "POST", url: `/api/topics/${id}/goal`, payload: { goal: "unauthorized" } });
  expect(denied.statusCode).toBe(401);
  expect((await f.post("topics", { title: "빈 소스 거절", entry: { mode: "sources", sources: [] } })).statusCode).toBe(400);
  expect((await f.post("topics", { title: "상충 경로", startMode: "plan", entry: { mode: "brainstorm" } })).statusCode).toBe(400);
});

it("brainstorm establishes a separate Goal and starts planning; a manager only establishes its Goal", async () => {
  const f = await fixture();
  const leaf = await f.create({ title: "토론 출발", workflowMode: "planned", entry: { mode: "brainstorm" } });
  expect(leaf.state).toBe("BRAINSTORM_READY");
  expect((await f.post(`topics/${leaf.id}/goal`, { goal: "논의 전환을 우회" })).statusCode).toBeGreaterThanOrEqual(400);
  await f.attach(leaf.id);
  expect((await f.post(`topics/${leaf.id}/actions/brainstorm-plan`, { decision: "작은 실험을 선택", goal: "한 경로로 효과를 검증한다." })).statusCode).toBe(200); await f.done(leaf.id);
  expect(f.calls[0].prompt).toContain("한 경로로 효과를 검증한다.");
  expect(f.db.getTopic(leaf.id).workEntry).toMatchObject({ mode: "brainstorm", goal: "한 경로로 효과를 검증한다." });
  const manager = await f.create({ title: "큰 그림 논의", topicKind: "group", entry: { mode: "brainstorm" } });
  expect((await f.post(`topics/${manager.id}/actions/brainstorm-plan`, { decision: "작게 분할", goal: "단계별로 검증하며 확장한다." })).statusCode).toBe(200); await f.done(manager.id);
  expect(f.calls).toHaveLength(1);
  expect(f.db.getTopic(manager.id)).toMatchObject({ state: "DRAFT", workEntry: { mode: "brainstorm", goal: "단계별로 검증하며 확장한다." } });
  const child = await f.create({ title: "첫 단계", parentTopicId: manager.id, entry: { mode: "goal", goal: "실험 한 가지" } });
  expect(child.parentTopicId).toBe(manager.id);
});

it("child creation uses the parent's current mediator assignment instead of the global assignment", async () => {
  const f = await fixture();
  const root = await f.create({ title: "담당 중재자", topicKind: "group", entry: { mode: "goal", goal: "배정 범위 안에서 자식을 만든다." } });
  expect((await f.post("role-assignments", { scope: "global", role: "mediator", participant: "global-owner", expectedVersion: 0 })).statusCode).toBe(200);
  expect((await f.post("role-assignments", { scope: `topic:${root.id}`, role: "mediator", participant: "root-owner", expectedVersion: 0 })).statusCode).toBe(200);
  const body = { title: "담당 자식", parentTopicId: root.id };
  expect((await f.post("topics", body, { "x-consensus-actor": "mediator", "x-consensus-mediator": "global-owner", "x-consensus-mediator-version": "1" })).statusCode).toBe(409);
  expect((await f.post("topics", body, { "x-consensus-actor": "mediator", "x-consensus-mediator": "root-owner", "x-consensus-mediator-version": "2" })).statusCode).toBe(201);
});

it("adopts existing results without changing approvals, plans or worktrees and persists the hierarchy", async () => {
  const f = await fixture();
  const parent = await f.create({ title: "기존 작업 큰 그림", topicKind: "group" });
  const leaf = await f.create({ title: "기존 실행 결과" });
  f.db.updateTopic(leaf.id, { state: "READY_TO_DELIVER", planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    planRevision: 3, planEpoch: 2, committedOID: "b".repeat(40) });
  const before = f.db.getTopic(leaf.id), flags = f.db.getFlags(leaf.id);
  const response = await f.post(`topics/${parent.id}/adopt`, { topicIds: [leaf.id] }, { "idempotency-key": "adopt-result" });
  expect(response.statusCode, response.body).toBe(200);
  expect((await f.post(`topics/${parent.id}/adopt`, { topicIds: [leaf.id] }, { "idempotency-key": "adopt-result" })).body).toBe(response.body);
  await f.restart();
  const after = f.db.getTopic(leaf.id);
  expect({ ...after, parentTopicId: before.parentTopicId, updatedAt: before.updatedAt }).toEqual(before);
  expect(after.parentTopicId).toBe(parent.id);
  expect(f.db.getFlags(leaf.id)).toEqual(flags);
  expect(f.calls).toHaveLength(0);
});

it("rejects reparenting, active work, manager cycles and mediator adoption atomically", async () => {
  const f = await fixture();
  const parent = await f.create({ title: "첫 큰 그림", topicKind: "group" });
  const other = await f.create({ title: "다른 큰 그림", topicKind: "group" });
  const leaf = await f.create({ title: "첫 실행" });
  const busy = await f.create({ title: "작업 중 실행" });
  f.db.updateTopic(busy.id, { state: "IMPLEMENTING" });
  expect((await f.post(`topics/${parent.id}/adopt`, { topicIds: [leaf.id, busy.id] })).statusCode).toBe(409);
  expect(f.db.getTopic(leaf.id).parentTopicId).toBeNull();
  expect((await f.post(`topics/${parent.id}/adopt`, { topicIds: [other.id] })).statusCode).toBe(409);
  expect((await f.post(`topics/${parent.id}/adopt`, { topicIds: [leaf.id] }, { "x-consensus-actor": "mediator" })).statusCode).toBe(403);
  expect((await f.app.inject({ method: "POST", url: `/api/topics/${parent.id}/adopt`, payload: { topicIds: [leaf.id] } })).statusCode).toBe(401);
  expect((await f.post(`topics/${parent.id}/adopt`, { topicIds: [leaf.id] })).statusCode).toBe(200);
  expect((await f.post(`topics/${other.id}/adopt`, { topicIds: [leaf.id] })).statusCode).toBe(409);
  f.db.updateTopic(busy.id, { state: "DRAFT" });
});

it("adopts legacy work groups together and keeps subsequent stage creation under the same parent", async () => {
  const f = await fixture();
  const parent = await f.create({ title: "단계 작업 큰 그림", topicKind: "group" });
  const input = { title: "단계 묶음", goal: "순차 진행", contracts: "기존 동작 보존", stages: [
    { id: "a", title: "첫 작업", goal: "첫 결과", acceptance: "첫 확인", dependsOn: [] },
    { id: "b", title: "다음 작업", goal: "독립 결과", acceptance: "다음 확인", dependsOn: [] },
    { id: "z", kind: "integration", title: "통합", goal: "전체 확인", acceptance: "통합 확인", dependsOn: ["a", "b"] },
  ] };
  const made = await f.post("work-groups", input); expect(made.statusCode, made.body).toBe(201);
  const groupId = made.json().id;
  const first = await f.post(`work-groups/${groupId}/next`, {}); expect(first.statusCode, first.body).toBe(201);
  const firstId = first.json().id;
  expect((await f.post(`topics/${parent.id}/adopt`, { topicIds: [firstId] })).statusCode).toBe(409);
  const before = f.db.workGroups.get(groupId);
  expect((await f.post(`topics/${parent.id}/adopt`, { workGroupIds: [groupId] })).statusCode).toBe(200);
  expect(f.db.getTopic(firstId).parentTopicId).toBe(parent.id);
  expect(f.db.workGroups.get(groupId)).toEqual({ ...before, parentTopicId: parent.id });
  f.db.updateTopic(firstId, { state: "USER_DECISION_REQUIRED", resumeState: "CLAUDE_PLAN" });
  const next = await f.post(`work-groups/${groupId}/next`, { stageId: "b" }); expect(next.statusCode, next.body).toBe(201);
  expect(next.json().parentTopicId).toBe(parent.id);
  expect((await f.post("role-assignments", { scope: "global", role: "mediator", participant: "global-owner", expectedVersion: 0 })).statusCode).toBe(200);
  expect((await f.post("role-assignments", { scope: `topic:${parent.id}`, role: "mediator", participant: "root-owner", expectedVersion: 0 })).statusCode).toBe(200);
  const owner = { "x-consensus-actor": "mediator", "x-consensus-mediator": "root-owner", "x-consensus-mediator-version": "2" };
  const stale = { ...owner, "x-consensus-mediator": "global-owner", "x-consensus-mediator-version": "1" };
  expect((await f.post("work-groups", { ...input, parentTopicId: parent.id }, stale)).statusCode).toBe(409);
  const fresh = await f.post("work-groups", { ...input, parentTopicId: parent.id }, owner); expect(fresh.statusCode, fresh.body).toBe(201);
  expect((await f.post(`work-groups/${fresh.json().id}/next`, {}, stale)).statusCode).toBe(409);
  const freshStage = await f.post(`work-groups/${fresh.json().id}/next`, {}, owner); expect(freshStage.statusCode, freshStage.body).toBe(201);
  expect(freshStage.json().parentTopicId).toBe(parent.id);
});

it("revalidates the same Source Goal after children exist without allowing a scope rewrite", async () => {
  const f=await fixture();const root=await f.create({title:"Source root",topicKind:"group",entry:{mode:"sources",sources:[{url:"https://example.com/renewed",label:"source"}]}});
  const publish=(revision:string)=>{const catalog=f.db.evidence.catalog.state(root.id),source=f.db.evidence.get(catalog.roots[0].sourceId);f.db.evidence.catalog.importHostSnapshot(root.id,{version:catalog.version,rootId:catalog.roots[0].id,sourceId:source.id,previousHash:source.contentHash,previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision,units:[{id:"spec",kind:"document",content:revision}],missing:[]},[]);};
  publish("v1");const goal="Same reviewed Goal";
  expect((await f.post(`topics/${root.id}/goal`,{goal,evidenceDigest:f.db.evidence.topic(f.db.getTopic(root.id)).digest})).statusCode).toBe(200);
  await f.create({title:"First child",parentTopicId:root.id});publish("v2");
  expect((await f.post("topics",{title:"stale child",parentTopicId:root.id})).statusCode).toBe(409);
  const evidenceDigest=f.db.evidence.topic(f.db.getTopic(root.id)).digest;
  expect((await f.post(`topics/${root.id}/goal`,{goal:"different Goal",evidenceDigest})).statusCode).toBe(409);
  expect((await f.post(`topics/${root.id}/goal`,{goal,evidenceDigest})).statusCode).toBe(200);
  expect((await f.post("topics",{title:"Next child",parentTopicId:root.id})).statusCode).toBe(201);
});

it("binds management turns explicitly when two topics share their repository directory", async () => {
  const f=await fixture();const roots=[];
  for (const title of ["First manager","Second manager"]) roots.push(await f.create({title,topicKind:"group",entry:{mode:"brainstorm"}}));
  expect(roots[0].worktreePath).toBe(roots[1].worktreePath);
  for (const root of roots) {
    await f.attach(root.id);await f.post(`topics/${root.id}/actions/brainstorm`,{});await f.done(root.id);
    expect(f.calls.at(-1)?.topicId).toBe(root.id);
    expect(f.db.topicForTurn({cwd:f.root,topicId:root.id})?.id).toBe(root.id);
  }
  expect(()=>f.db.topicForTurn({cwd:f.root})).toThrow("명시적인 topicId");
  expect(f.calls).toHaveLength(2);
});
