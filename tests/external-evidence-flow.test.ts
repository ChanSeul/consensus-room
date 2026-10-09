import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { crc32 } from "node:zlib";
import { buildIsolationSettings } from "../src/server/adapters/claude";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { EvidenceService, withEvidence } from "../src/server/evidence/service";
import { ArtifactStore } from "../src/server/artifacts";
import { GitService } from "../src/server/git";
import { EngineCore } from "../src/server/engine/core";
import { WorkflowEngine } from "../src/server/workflow";
import { buildApp, listenReady } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { ProjectMemoryReader } from "../src/server/projectMemory";
import type { AgentAdapter, CommandRunner } from "../src/server/types";
import { relayFactsFrom } from "../src/shared/prompts";

// Public workflow and HTTP entry points. Assertions target spawned calls, retained result and final topic state.
const roots: string[] = []; const dbs: ConsensusDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const sourceInput = { url: "https://team.atlassian.net/browse/APP-1", label: "Feature", mode: "connector" as const, intervalSeconds: 300 };
it("HTTP collection returns approved app work, bounds pages, and never invokes a model", async () => {
  const f=fixture(); f.database.updateTopic("t",{state:"DRAFT"});
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"},
    evidenceConnector:{configured:()=>false,fetch:async()=>{throw Error("Existing app reader only");}}});
  const headers={"x-consensus-token":"test-token"};
  try {
    const add=await app.inject({method:"POST",url:"/api/topics/t/evidence/roots",headers,payload:{
      url:"https://www.figma.com/design/approved?node-id=1-2",label:"Current design",scope:"topic",mode:"connector"}});
    expect(add.statusCode).toBe(200);
    const proposal=await app.inject({method:"POST",url:"/api/topics/t/evidence/roots",headers:{...headers,"x-consensus-actor":"mediator"},payload:{
      url:"https://www.figma.com/design/candidate?node-id=3-4",label:"Unverified design",scope:"topic",mode:"connector"}});
    expect(proposal.statusCode).toBe(200);
    const result=await app.inject({method:"POST",url:"/api/topics/t/evidence/collect",headers,payload:{}});
    expect(result.statusCode).toBe(200);
    expect(result.json().hostPlan.requests).toEqual(expect.arrayContaining([expect.objectContaining({provider:"figma",resource:"approved",selector:"1:2"})]));
    expect(result.json().hostPlan.requests.some((r:any)=>r.resource==="candidate")).toBe(false);
    expect((await app.inject({method:"GET",url:"/api/topics/t/evidence/host-plan?limit=1",headers})).json().requests).toHaveLength(1);
    expect((await app.inject({method:"GET",url:"/api/topics/t/evidence/host-plan?limit=100",headers})).statusCode).toBe(400);
    expect(f.adapter.createSession).not.toHaveBeenCalled();
  } finally {await app.close();dbs.splice(dbs.indexOf(f.database),1);}
});
it("registering an unrelated group root preserves a running scoped stage and its current artifact aliases", async () => {
  const f=fixture(),c=f.database.evidence.catalog;
  const root=c.add("t",{url:"https://www.figma.com/design/form?node-id=1-2",label:"Selected",scope:"topic",required:true,mode:"connector",intervalSeconds:900},true);
  const groupId="11111111-1111-4111-8111-111111111111";
  f.database.workGroups.create(groupId,{title:"Form",goal:"Form",contracts:"Keep approved scopes",stages:[
    {id:"ui",kind:"work",title:"UI",goal:"Layout",acceptance:"Verified",dependsOn:[],evidenceRootIds:[root.id]},
    {id:"all",kind:"integration",title:"All",goal:"All",acceptance:"Verified",dependsOn:["ui"]},
  ]},f.root,"a".repeat(40));
  f.database.workGroups.link(groupId,"ui","t","a".repeat(40));
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"}});
  const before=f.database.getTopic("t"),version=c.version("t");
  f.database.startAction({id:"busy",topicId:"t",kind:"test",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,
    pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
  const clear=vi.spyOn(ArtifactStore.prototype,"clearCurrentAliases");
  try {
    const response=await app.inject({method:"POST",url:"/api/topics/t/evidence/roots",headers:{"x-consensus-token":"test-token"},payload:{
      url:"https://team.atlassian.net/browse/APP-2",label:"Future server stage",scope:"group",required:true,mode:"connector",intervalSeconds:900}});
    expect(response.statusCode).toBe(200); expect(response.json().status).toBe("approved");
    expect(f.database.getTopic("t")).toEqual(before);
    expect(c.version("t")).toBe(version);
    expect(clear).not.toHaveBeenCalled();
  } finally {f.database.finishAction("busy","succeeded");await app.close();dbs.splice(dbs.indexOf(f.database),1);}
});
// 근거 범위 변경은 토픽을 초기화하지 않는다(CR 흐름 단순화 D6). 실행 중인 소비 토픽의 입력은 계속 보호한다.
it("승인을 전파하는 새 루트는 실행 중 선택 단계를 보호하고 유휴 때 전파하되 계획 승인은 보존한다", async () => {
  const f=fixture(),c=f.database.evidence.catalog;
  const selected=c.add("t",{url:"https://www.figma.com/design/form?node-id=1-2",label:"Selected",scope:"topic",required:true,mode:"connector",intervalSeconds:900},true);
  const groupId="11111111-1111-4111-8111-111111111111";
  f.database.workGroups.create(groupId,{title:"Form",goal:"Form",contracts:"Scope",stages:[
    {id:"ui",kind:"work",title:"UI",goal:"Layout",acceptance:"Verified",dependsOn:[],evidenceRootIds:[selected.id]},
    {id:"all",kind:"integration",title:"All",goal:"All",acceptance:"Verified",dependsOn:["ui"]},
  ]},f.root,"a".repeat(40));
  f.database.workGroups.link(groupId,"ui","t","a".repeat(40));
  const url="https://docs.google.com/spreadsheets/d/policy/edit";
  const service=new EvidenceService(f.database.evidence,{fetch:async()=>{throw Error("host only");}});
  const source=f.database.evidence.get(selected.sourceId);
  service.importHost("t",{version:c.version("t"),rootId:selected.id,sourceId:source.id,previousHash:source.contentHash,
    previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"r",missing:[],units:[{id:"body",kind:"design",content:url}]});
  await service.stop();
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"}});
  f.database.updateTopic("t",{state:"AWAITING_USER_APPROVAL",planSHA256:"f".repeat(64),approvedPlanSHA256:"f".repeat(64)});
  f.database.startAction({id:"busy",topicId:"t",kind:"test",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,
    pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
  const clear=vi.spyOn(ArtifactStore.prototype,"clearCurrentAliases");
  const request={method:"POST" as const,url:"/api/topics/t/evidence/roots",headers:{"x-consensus-token":"test-token"},payload:{
    url,label:"Approved policy",scope:"workspace",required:true,mode:"connector",intervalSeconds:900}};
  try {
    const blocked = await app.inject(request);
    expect(blocked.statusCode).toBe(500);
    expect(blocked.json().error).toContain("이미 실행 중인 작업");
    expect(c.state("t").entries.find(e=>e.source.url===url)?.state).toBe("candidate");
    expect(clear).not.toHaveBeenCalled();
    f.database.finishAction("busy","succeeded");
    expect((await app.inject(request)).statusCode).toBe(200);
    expect(c.state("t").entries.find(e=>e.source.url===url)?.state).toBe("approved");
    expect(f.database.getTopic("t")).toMatchObject({ state:"AWAITING_USER_APPROVAL", planSHA256:"f".repeat(64), approvedPlanSHA256:"f".repeat(64) });
  } finally {f.database.finishAction("busy","succeeded");await app.close();dbs.splice(dbs.indexOf(f.database),1);}
});
// 79fc4fc5 F011: 근거 선택 변경은 실제 변경 사실만 system 사실(evidence-selection)로 남긴다 — 사용자 발언으로 꾸미거나 재계획·세션 초기화를 지시하지
// 않는다. 작업 그룹 근거 연결도 같은 사실(그룹 id)로 남는다.
it("evidence selection changes are recorded as system facts without replanning or session-reset instructions", async () => {
  const f=fixture(),c=f.database.evidence.catalog;
  f.database.updateTopic("t",{state:"DRAFT"});
  const groupId="11111111-1111-4111-8111-111111111111";
  f.database.workGroups.create(groupId,{title:"Form",goal:"Form",contracts:"Scope",stages:[
    {id:"ui",kind:"work",title:"UI",goal:"Layout",acceptance:"Verified",dependsOn:[]},
    {id:"all",kind:"integration",title:"All",goal:"All",acceptance:"Verified",dependsOn:["ui"]},
  ]},f.root,"a".repeat(40));
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"}});
  const headers={"x-consensus-token":"test-token"};
  try {
    expect((await app.inject({method:"POST",url:"/api/topics/t/evidence/roots",headers,payload:{
      url:"https://docs.google.com/spreadsheets/d/policy/edit",label:"Policy",scope:"topic",required:true,mode:"connector",intervalSeconds:900}})).statusCode).toBe(200);
    const afterRoot=c.version("t");
    expect((await app.inject({method:"POST",url:"/api/topics/t/evidence/group",headers,payload:{groupId,version:afterRoot}})).statusCode).toBe(200);
    const timeline=f.database.getTimeline("t");
    const facts=timeline.filter(event=>(event.payload.workerFact as {kind?:unknown}|undefined)?.kind==="evidence-selection");
    expect(facts.map(event=>[event.actor,event.kind])).toEqual([["system","system"],["system","system"]]);
    expect(facts.map(event=>event.payload.workerFact)).toEqual([
      {kind:"evidence-selection",catalogVersion:afterRoot},{kind:"evidence-selection",catalogVersion:c.version("t"),groupId}]);
    expect(timeline.filter(event=>event.actor==="user"&&event.kind==="note")).toEqual([]);
    const relayed=relayFactsFrom(timeline).messages!;
    expect(relayed.filter(message=>message.kind==="evidence-selection")).toHaveLength(2);
    for (const body of [...timeline.map(event=>event.body),...relayed.map(message=>message.body)])
      for (const phrase of ["다시 계획","세션도 새로 시작"]) expect(body).not.toContain(phrase);
  } finally {await app.close();dbs.splice(dbs.indexOf(f.database),1);}
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "evidence-flow-")); roots.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite")); dbs.push(database);
  const topic = database.createTopic({ id: "t", slug: "t", title: "Feature", repositoryPath: root, worktreePath: root, baseRef: "main", branchName: "work",
    state: "IMPLEMENTING", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, workflowMode: "planned" });
  const source = database.evidence.register(topic.id, sourceInput);
  const ingest = (content: string) => {
    const check = database.evidence.begin(source.id, true)!;
    return database.evidence.ingest(source.id, { checkId: check.checkId, revision: content, units: [{ id: "issue", kind: "issue", content }] });
  };
  ingest("initial");
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: vi.fn(async turn => { await turn.beforeSpawn?.(); turn.admitSync?.(); return { sessionId: "s", result: { kind: "IMPLEMENTATION", summary: "result", findings: [] } as any }; }),
    resumeTurn: vi.fn(async () => { throw new Error("unused"); }),
    // 운영 계획·구현은 결과 봉투 왕복(relay)으로 이 메서드들을 부른다. 기본값은 실패해, 도달한 테스트가 스스로 응답을 정하게 한다.
    createEnvelopeSession: vi.fn(async () => { throw new Error("unused envelope"); }),
    resumeEnvelopeTurn: vi.fn(async () => { throw new Error("unused envelope"); }) };
  const dependencies = { database, artifacts: new ArtifactStore(join(root, "topics"), database), git: new GitService(runner), claude: adapter, codex: { ...adapter, role: "codex" as const }, enforceBudgets: false };
  return { root, database, topic, source, ingest, runner, adapter, dependencies };
}
it("marks unchanged wiki files for rechecking when their actual source hash changes", async () => {
  const f = fixture();
  const dependency = { sourceId: f.source.id, contentHash: f.database.evidence.get(f.source.id).contentHash! };
  writeFileSync(join(f.root, "context-router.md"), `# Reference\n\n\`\`\`wiki-evidence\n${JSON.stringify({ dependencies: [dependency] })}\n\`\`\`\n`);
  const reader = new ProjectMemoryReader(f.root, { resolveEvidenceStatus: dependencies => f.database.evidence.status(dependencies) });
  const before = await reader.select("Reference", "claude");
  expect(await reader.buildPrompt("Reference", "claude")).toContain("외부 근거: current");
  f.ingest("Changed backend contract");
  expect(await reader.buildManifest("Reference", "codex")).toContain("외부 근거: changed");
  expect((await reader.select("Reference", "codex"))[0].sha256).toBe(before[0].sha256);
  const check = f.database.evidence.begin(f.source.id, true)!;
  f.database.evidence.failed(f.source.id, check.checkId, "Access denied");
  expect(await reader.buildPrompt("Reference", "claude")).toContain("외부 근거: unavailable");
});
// 원문 내용 변경은 커밋·push 를 막지 않는다(D6 — 원문 영향 검토 표시는 게이트가 아니다). 인도 자체의 검사와 미수집 원문의 이연은 그대로다.
it("does not gate delivery on unreviewed content changes or on evidence that needs rechecking", async () => {
  const f = fixture(); f.database.updateTopic(f.topic.id, { state: "READY_TO_DELIVER" });
  const workflow = new WorkflowEngine(f.dependencies); f.ingest("new");
  await expect(workflow.commit(f.topic.id, "commit", ["x"])).rejects.toThrow("최종 리뷰가 확인한 변경 스냅샷이 없습니다");
  expect(f.runner.run).not.toHaveBeenCalled();
  let now = Date.now(); vi.spyOn(Date, "now").mockImplementation(() => now);
  now += 601_000;
  expect(f.database.evidence.fresh(f.database.evidence.get(f.source.id))).toBe(false);
  await expect(workflow.push(f.topic.id)).rejects.toThrow("확정한 커밋");
});
it("serves authenticated bridge APIs and rejects stale completions", async () => {
  const f = fixture();
  const config = loadConfig({ repositoryPath: f.root, dataDirectory: f.root, databasePath: join(f.root, "room.sqlite"), topicsDirectory: join(f.root, "topics"),
    worktreesDirectory: join(f.root, "worktrees"), webDirectory: join(f.root, "no-web"), launchToken: "test-token", enforceBudgets: false });
  const app = await buildApp({ config, database: f.database, runner: f.runner, claude: f.adapter, codex: { ...f.adapter, role: "codex" } });
  const headers = { "x-consensus-token": "test-token" };
  expect((await app.inject({ method: "GET", url: "/api/topics/t/evidence" })).statusCode).toBe(401);
  const check = (await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/check`, headers, payload: { force: true } })).json();
  expect(check.checkId).toBeTruthy();
  const update = await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/snapshot`, headers,
    payload: { checkId: check.checkId, revision: "v2", units: [{ id: "issue", kind: "issue", content: "new" }] } });
  expect(update.statusCode).toBe(200);
  const repeated = await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/snapshot`, headers,
    payload: { checkId: check.checkId, revision: "v1", units: [] } });
  expect(repeated.statusCode).toBe(409);
  expect((await app.inject({ method: "GET", url: "/api/topics/t/evidence", headers })).statusCode).toBe(200);
  expect((await app.inject({ method: "POST", url: "/api/evidence/status", headers, payload: { dependencies: [{ sourceId: f.source.id, contentHash: update.json().contentHash }] } })).json()).toEqual({ status: "current" });
  const address = await listenReady(app, { host: "127.0.0.1", port: 0 });
  const launchFile = join(f.root, "launch.url");
  writeFileSync(launchFile, `${address}/?token=test-token`, { mode: 0o600 });
  const bridge = await promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launchFile, "status", "--id", f.topic.id]);
  expect(JSON.parse(bridge.stdout).sources[0].contentHash).toBe(update.json().contentHash);
  expect(bridge.stdout).not.toContain("test-token");
  writeFileSync(launchFile, "https://remote.example/?token=test-token");
  await expect(promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launchFile, "due"]))
    .rejects.toMatchObject({ code: 1, stderr: "Expected the existing local Consensus Room launch URL\n" });
  await app.close(); dbs.splice(dbs.indexOf(f.database), 1);
});

it("uses mediator HTTP and CLI batches without model calls or implicit acknowledgement", async () => {
  const f = fixture(); f.database.updateTopic(f.topic.id, { state: "AWAITING_USER_APPROVAL" });
  const config = loadConfig({ repositoryPath: f.root, dataDirectory: f.root, webDirectory: join(f.root, "no-web"), launchToken: "test-token", enforceBudgets: false });
  let configured = false;
  const fetch = vi.fn(async () => ({ revision: "server-r1", units: [{ id: "issue", kind: "issue" as const, content: "server body" }] }));
  const app = await buildApp({ config, database: f.database, runner: f.runner, claude: f.adapter, codex: { ...f.adapter, role: "codex" },
    evidenceConnector: { configured: () => configured, fetch } });
  const headers = { "x-consensus-token": "test-token" }; const mediator = { ...headers, "x-consensus-actor": "mediator" };
  try {
    const url = "/api/topics/t/evidence/mediator/batch";
    expect((await app.inject({ method: "POST", url, payload: { sessionId: "s" } })).statusCode).toBe(401);
    expect((await app.inject({ method: "POST", url, headers, payload: { sessionId: "s" } })).statusCode).toBe(403);
    const hostRead = await app.inject({ method: "POST", url, headers: mediator, payload: { sessionId: "s" } });
    expect(hostRead.statusCode).toBe(200);
    expect(hostRead.json().changes.map((unit: any) => unit.content)).toEqual(["initial"]);
    expect(fetch).not.toHaveBeenCalled();
    expect((await app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/use-rest`, headers: mediator, payload: {} })).statusCode).not.toBe(200);
    const convert = () => app.inject({ method: "POST", url: `/api/evidence/${f.source.id}/use-rest`, headers, payload: {} });
    expect((await convert()).statusCode).not.toBe(200);
    configured = true;
    const shared = f.database.createTopic({ ...f.topic, id: "shared", slug: "shared", worktreePath: join(f.root, "shared"), state: "DRAFT" });
    f.database.evidence.register(shared.id, sourceInput);
    f.database.startAction({ id: "shared-action", topicId: shared.id, kind: "plan", status: "running", createdAt: new Date().toISOString(),
      finishedAt: null, error: null, pid: null, pgid: null, processCommand: null, processExecutable: null, processStartedAt: null });
    expect((await convert()).statusCode).not.toBe(200);
    expect(f.database.evidence.get(f.source.id).mode).toBe("connector");
    f.database.finishAction("shared-action", "succeeded");
    expect((await convert()).statusCode).toBe(200);
    const address = await listenReady(app, { host: "127.0.0.1", port: 0 });
    const launch = join(f.root, "bridge.url"); writeFileSync(launch, `${address}/?token=test-token`, { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launch, ...args]);
    const first = JSON.parse((await cli("batch", "--id", "t", "--session", "actual-session")).stdout);
    expect(first.changes.map((u: any) => u.content)).toEqual(["server body"]);
    expect(JSON.stringify(first)).not.toContain("test-token");
    expect(JSON.parse((await cli("batch", "--id", "t", "--session", "actual-session")).stdout).batchId).toBe(first.batchId);
    f.ingest("arrived after batch");
    await cli("ack", "--id", "t", "--session", "actual-session", "--batch", first.batchId);
    const next = JSON.parse((await cli("batch", "--id", "t", "--session", "actual-session")).stdout);
    expect(next.changes.map((u: any) => u.content)).toEqual(["arrived after batch"]);
    expect(next.batchId).not.toBe(first.batchId);
    const connections = (await app.inject({ method: "GET", url: "/api/evidence/connections", headers })).json();
    expect(connections[0]).toMatchObject({ configured: true, mode: "rest", topics: expect.arrayContaining(["t", "shared"]) });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(f.adapter.createSession).not.toHaveBeenCalled(); expect(f.adapter.resumeTurn).not.toHaveBeenCalled();
  } finally { await app.close(); dbs.splice(dbs.indexOf(f.database), 1); }
});

it.each(["missing", "expired", "failed"])("admits planning and implementation with %s visual cache through the real executor", async status => {
  const f = fixture();
  const source = f.database.evidence.register(f.topic.id, { ...sourceInput, url: "https://www.figma.com/design/abc/Screen?node-id=1-2" });
  if (status !== "missing") {
    f.database.evidence.ingest(source.id, { checkId: f.database.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [{ id: "node", kind: "design", content: "layout" }] });
    if (status === "expired") {
      const now = Date.now(); vi.spyOn(Date, "now").mockReturnValue(now + 601000); f.ingest("initial");
    } else f.database.evidence.failed(source.id, f.database.evidence.begin(source.id, true)!.checkId, "offline");
  }
  const core = new EngineCore(f.dependencies);
  for (const implementation of [false, true]) {
    const topic = f.database.updateTopic(f.topic.id, { state: implementation ? "IMPLEMENTING" : "CLAUDE_PLAN" });
    let accepted = false;
    core.startAction(topic.id, "design-test", async signal => {
      await core.executor.execute({ route: core.route(topic, implementation ? { role: "implementer", operation: "implement" } : { role: "planner", operation: "plan" }),
        topic, signal, purpose: "턴", inputSequence: 0, expected: core.expectationOf(topic),
        session: { mode: "create" }, prompt: "Task", settings: { model: "opus", effort: "high" } });
      accepted = true;
    });
    await core.active.get(topic.id)!.completion;
    expect(accepted).toBe(true);
  }
  expect(f.adapter.createSession).toHaveBeenCalledTimes(2);
});

// E3-1 bridge 소비처: 중재자가 실제로 받는 것은 bridge stdout 이다. 작은 --page-bytes 로 batch → 읽기 → ack → 다음 쪽을 batchId:null 까지 돌린다.
// 원문 전체를 먼저 출력하지 않는다 — 한 번의 batch 출력이 한 쪽이고, 그 바이트(끝 개행 제외)가 요청한 쪽 크기 이하다.
it("bridge 가 작은 쪽 크기로 큰 단위를 구간으로 끝까지 받고, 출력은 응답 본문 그대로이며, 끝 구간 ack 전에는 완료 영수증이 없다", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-pages-")); roots.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite")); dbs.push(database);
  const topic = database.createTopic({ id: "t", slug: "t", title: "Pages", repositoryPath: root, worktreePath: root, baseRef: "main", branchName: "work",
    state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null, workflowMode: "planned" });
  const source = database.evidence.register(topic.id, { url: "https://team.atlassian.net/browse/APP-2", label: "Big", mode: "rest", intervalSeconds: 300 });
  // 한국어·이모지(서로게이트 쌍)·JSON escape(따옴표·역슬래시·개행·제어 문자)가 섞인 최대 길이(160,000 UTF-16 코드 단위) 본문.
  const alphabet = ["가", "😀", '"', "\\", "\n", "\u0001", "a", "é"];
  let big = "";
  for (let index = 0; big.length + alphabet[index % alphabet.length].length <= 160_000; index++) big += alphabet[index % alphabet.length];
  database.evidence.ingest(source.id, { checkId: database.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [
    { id: "a-small", kind: "comment", content: "first small" }, { id: "b-big", kind: "comment", content: big }, { id: "c-small", kind: "comment", content: "last small" },
  ] });
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: vi.fn(async () => { throw new Error("unused"); }), resumeTurn: vi.fn(async () => { throw new Error("unused"); }) };
  const fetch = vi.fn(async () => ({ revision: "unused", units: [] }));
  const config = loadConfig({ repositoryPath: root, dataDirectory: root, webDirectory: join(root, "no-web"), memoryDirectory: join(root, "memory"),
    launchToken: "test-token", enforceBudgets: false });
  const app = await buildApp({ config, database, runner, claude: adapter, codex: { ...adapter, role: "codex" }, evidenceConnector: { configured: () => true, fetch } });
  const raw = new DatabaseSync(join(root, "room.sqlite"));
  try {
    const mediator = { "x-consensus-token": "test-token", "x-consensus-actor": "mediator" };
    const address = await listenReady(app, { host: "127.0.0.1", port: 0 });
    const launch = join(root, "bridge.url"); writeFileSync(launch, `${address}/?token=test-token`, { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launch, ...args], { maxBuffer: 4 << 20 });
    const batch = async (session: string, pageBytes: number) => {
      const { stdout } = await cli("batch", "--id", "t", "--session", session, "--page-bytes", String(pageBytes));
      expect(stdout.endsWith("\n")).toBe(true);
      expect(Buffer.byteLength(stdout) - 1).toBeLessThanOrEqual(pageBytes);
      return { stdout, page: JSON.parse(stdout) as { batchId: string | null; changes: Array<{ id: string; content: string; range?: { offset: number; end: number; total: number } }>; remaining: number } };
    };
    const ack = (session: string, batchId: string) => cli("ack", "--id", "t", "--session", session, "--batch", batchId);
    const received: Array<{ id: string; content: string; range?: { offset: number; end: number; total: number } }> = [];

    const first = await batch("mediator", 50_000);
    // 출력은 서버 응답 본문 바이트 그대로다(끝 개행만 더한다). 같은 대기 쪽을 HTTP 로 받은 본문과 비교한다.
    const body = (await app.inject({ method: "POST", url: "/api/topics/t/evidence/mediator/batch", headers: mediator, payload: { sessionId: "mediator", pageBytes: 50_000 } })).body;
    expect(first.stdout).toBe(`${body}\n`);
    expect((await app.inject({ method: "POST", url: "/api/topics/t/evidence/mediator/batch", headers: mediator,
      payload: { sessionId: "mediator", pageBytes: 240_001 } })).statusCode).toBe(400);
    // 큰 단위는 이 쪽에 다 들어가지 않고 이미 다른 항목이 있으므로 다음 쪽으로 넘어간다.
    expect(first.page.changes.map(change => change.id)).toEqual(["a-small"]);
    received.push(...first.page.changes); await ack("mediator", first.page.batchId!);

    const second = await batch("mediator", 50_000);
    expect(second.page.changes.map(change => [change.id, change.range?.offset])).toEqual([["b-big", 0]]);
    // 대기 쪽보다 작은 쪽을 요청하면 더 작은 새 쪽으로 바뀌고, 옛 batchId 는 ack 할 수 없다. 그 뒤 큰 요청은 작은 대기 쪽을 그대로 받는다.
    const smaller = await batch("mediator", 20_000);
    expect(smaller.page.batchId).not.toBe(second.page.batchId);
    expect(smaller.page.changes[0].range!.end).toBeLessThan(second.page.changes[0].range!.end);
    await expect(ack("mediator", second.page.batchId!)).rejects.toMatchObject({ code: 1, stderr: "Consensus Room returned HTTP 409\n" });
    expect((await batch("mediator", 50_000)).page.batchId).toBe(smaller.page.batchId);
    received.push(...smaller.page.changes); await ack("mediator", smaller.page.batchId!);

    // 중간에 멈추고 새 세션으로 요청하면 처음부터 받는다 — 다른 세션의 진행 위치를 이어받지 않는다.
    const other = await batch("second", 50_000);
    expect(other.page.changes.map(change => change.id)).toEqual(["a-small"]);
    await ack("second", other.page.batchId!);
    expect((await batch("second", 50_000)).page.changes[0]).toMatchObject({ id: "b-big", range: { offset: 0 } });

    const consumer = JSON.stringify(["t", 1, "mediator"]);
    let pages = 2;
    for (let round = 0; round < 40; round++) {
      const next = await batch("mediator", 50_000);
      if (next.page.batchId === null) { expect(next.page.changes).toEqual([]); break; }
      pages++;
      const last = next.page.changes.find(change => change.id === "b-big" && change.range?.end === change.range?.total);
      if (last) {
        // 끝 구간을 ack 하기 전에는 그 단위의 완료 영수증이 없고, 진행 위치만 이 구간의 시작에 있다.
        expect(raw.prepare("SELECT unit_id FROM evidence_mediator_unit_receipts WHERE consumer=? AND unit_id='b-big'").all(consumer)).toEqual([]);
        expect(raw.prepare("SELECT next_offset FROM evidence_mediator_progress WHERE consumer=? AND unit_id='b-big'").all(consumer))
          .toEqual([{ next_offset: last.range!.offset }]);
      }
      received.push(...next.page.changes); await ack("mediator", next.page.batchId!);
    }
    expect(pages).toBeGreaterThan(4);
    expect(raw.prepare("SELECT unit_id FROM evidence_mediator_unit_receipts WHERE consumer=? ORDER BY unit_id").all(consumer).map(row => row.unit_id))
      .toEqual(["a-small", "b-big", "c-small"]);
    const segments = received.filter(change => change.id === "b-big");
    expect(segments.length).toBeGreaterThan(4);
    let offset = 0;
    for (const segment of segments) {
      expect(segment.range!.offset).toBe(offset); offset = segment.range!.end;
      expect(/^[\uDC00-\uDFFF]/.test(segment.content) || /[\uD800-\uDBFF]$/.test(segment.content)).toBe(false);
    }
    expect(segments.map(segment => segment.content).join("")).toBe(big);
    expect(received.filter(change => change.id !== "b-big").map(change => [change.id, change.content])).toEqual([["a-small", "first small"], ["c-small", "last small"]]);
    expect(fetch).not.toHaveBeenCalled();
  } finally { raw.close(); await app.close(); dbs.splice(dbs.indexOf(database), 1); }
});

// ROOT-E3-01: 전달할 것이 없다는 응답(batchId:null)도 쪽이다. 모든 내용을 받은 뒤의 마지막 응답과 원문 없는 주제도 요청한 pageBytes 안에서만
// 200 이고, 들어가지 않으면 최소 바이트 안내와 함께 409 다. 크기는 HTTP 가 실제로 보내는 본문(currentDigest·superseded 포함)으로 잰다.
it("마지막 응답과 원문 없는 주제의 batchId:null 응답도 요청한 쪽 크기 안에서만 돌려주고, 넘치면 최소 바이트와 함께 409 다", async () => {
  const root = mkdtempSync(join(tmpdir(), "evidence-final-page-")); roots.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite")); dbs.push(database);
  const base = { repositoryPath: root, worktreePath: root, baseRef: "main", branchName: "work", state: "AWAITING_USER_APPROVAL" as const,
    workflowMode: "planned" as const, scopeGeneration: 1,
    planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null };
  const topic = database.createTopic({ ...base, id: "t", slug: "t", title: "Final page" });
  database.createTopic({ ...base, id: "empty", slug: "empty", title: "No evidence", worktreePath: join(root, "empty") });
  const source = database.evidence.register(topic.id, { url: "https://team.atlassian.net/browse/APP-3", label: "Small", mode: "rest", intervalSeconds: 300 });
  database.evidence.ingest(source.id, { checkId: database.evidence.begin(source.id, true)!.checkId, revision: "r1", units: [{ id: "issue", kind: "issue", content: "small body" }] });
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    createSession: vi.fn(async () => { throw new Error("unused"); }), resumeTurn: vi.fn(async () => { throw new Error("unused"); }) };
  const fetch = vi.fn(async () => ({ revision: "unused", units: [] }));
  const config = loadConfig({ repositoryPath: root, dataDirectory: root, webDirectory: join(root, "no-web"), memoryDirectory: join(root, "memory"),
    launchToken: "test-token", enforceBudgets: false });
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const app = await buildApp({ config, database, runner, claude: adapter, codex: { ...adapter, role: "codex" }, evidenceConnector: { configured: () => true, fetch } });
  try {
    const mediator = { "x-consensus-token": "test-token", "x-consensus-actor": "mediator" };
    const batch = (topicId: string, pageBytes: number) => app.inject({ method: "POST", url: `/api/topics/${topicId}/evidence/mediator/batch`, headers: mediator,
      payload: { sessionId: "mediator", pageBytes } });
    const address = await listenReady(app, { host: "127.0.0.1", port: 0 });
    const launch = join(root, "bridge.url"); writeFileSync(launch, `${address}/?token=test-token`, { mode: 0o600 });
    const cli = (...args: string[]) => promisify(execFile)("python3", ["scripts/evidence-bridge.py", "--launch-file", launch, ...args]);
    const first = JSON.parse((await cli("batch", "--id", "t", "--session", "mediator", "--page-bytes", "50000")).stdout);
    expect(first.changes.map((change: { id: string }) => change.id)).toEqual(["issue"]);
    await cli("ack", "--id", "t", "--session", "mediator", "--batch", first.batchId);
    for (const topicId of ["t", "empty"]) {
      const refused = await batch(topicId, 1);
      expect(refused.statusCode, topicId).toBe(409);
      const minimum = Number(/최소 (\d+)B/.exec(refused.json().error)?.[1]);
      expect(minimum, topicId).toBeGreaterThan(1);
      // 패킷만 재면 이 크기에 들어간다 — 응답 본문(currentDigest·superseded 포함)은 들어가지 않는다.
      expect((await batch(topicId, minimum - 1)).statusCode, topicId).toBe(409);
      const fitted = await batch(topicId, minimum);
      expect(fitted.statusCode, topicId).toBe(200);
      expect(fitted.json(), topicId).toMatchObject({ batchId: null, changes: [], remaining: 0, nextCursor: null });
      expect(Buffer.byteLength(fitted.body), topicId).toBeLessThanOrEqual(minimum);
      expect((await batch(topicId, minimum)).body, topicId).toBe(fitted.body);
      await expect(cli("batch", "--id", topicId, "--session", "mediator", "--page-bytes", "1"), topicId)
        .rejects.toMatchObject({ code: 1, stderr: "Consensus Room returned HTTP 409\n" });
      expect((await cli("batch", "--id", topicId, "--session", "mediator", "--page-bytes", String(minimum))).stdout, topicId).toBe(`${fitted.body}\n`);
    }
    expect(fetch).not.toHaveBeenCalled();
  } finally { await app.close(); dbs.splice(dbs.indexOf(database), 1); }
});

it("only users approve roots, stale or running selections preserve the active source set, and closed history remains editable for future use", async () => {
  const f=fixture(); const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"}});
  const headers={"x-consensus-token":"test-token"}, mediator={...headers,"x-consensus-actor":"mediator"};
  const route=`/api/topics/${f.topic.id}/evidence`;
  const proposal=await app.inject({method:"POST",url:`${route}/roots`,headers:mediator,payload:{url:"https://team.atlassian.net/browse/APP-2",label:"Root",scope:"group",mode:"rest",intervalSeconds:900}});
  expect(proposal.statusCode).toBe(200);expect(proposal.json().status).toBe("proposed");
  let catalog=(await app.inject({method:"GET",url:`${route}/catalog`,headers})).json();
  const selection={version:catalog.version,rootId:proposal.json().id,action:"approve"};
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers:mediator,payload:selection})).statusCode).toBe(403);
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:selection})).statusCode).toBe(200);
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:{...selection,action:"remove"}})).statusCode).toBe(409);
  catalog=(await app.inject({method:"GET",url:`${route}/catalog`,headers})).json();
  f.database.startAction({id:"busy",topicId:f.topic.id,kind:"test",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:{...selection,version:catalog.version,action:"remove"}})).statusCode).toBeGreaterThanOrEqual(400);
  expect(f.database.evidence.catalog.version(f.topic.id)).toBe(catalog.version);
  f.database.finishAction("busy","succeeded"); f.database.updateTopic(f.topic.id,{state:"CLOSED"});
  const closed=f.database.getTopic(f.topic.id);
  expect((await app.inject({method:"POST",url:`${route}/selection`,headers,payload:{...selection,version:catalog.version,action:"remove"}})).statusCode).toBe(200);
  expect(f.database.getTopic(f.topic.id)).toEqual(closed);
  await app.close();dbs.splice(dbs.indexOf(f.database),1);
});

it("connects a standalone topic to its registered group evidence through the idle user API without changing completed stages", async () => {
  const f=fixture(); f.database.updateTopic("t",{state:"DRAFT"});
  const groupId="11111111-1111-4111-8111-111111111111", foreignId="22222222-2222-4222-8222-222222222222";
  const definition={title:"Listing registration",goal:"Listing form",contracts:"Registered policy and designs",stages:[
    {id:"first",kind:"work" as const,title:"First",goal:"Form",acceptance:"Verified",dependsOn:[],budget:{mode:"observe" as const}},
    {id:"last",kind:"integration" as const,title:"Integration",goal:"Complete",acceptance:"Verified",dependsOn:["first"],budget:{mode:"observe" as const}},
  ]};
  f.database.workGroups.create(groupId,definition,f.root,"a".repeat(40));
  f.database.workGroups.create(foreignId,definition,join(f.root,"other-repo"),"a".repeat(40));
  f.database.createTopic({...f.topic,id:"completed",slug:"completed",state:"CLOSED"});
  f.database.workGroups.link(groupId,"first","completed","a".repeat(40));
  const c=f.database.evidence.catalog;
  const urls=["https://docs.google.com/spreadsheets/d/policy/edit",...Array.from({length:9},(_,i)=>`https://www.figma.com/design/listing?node-id=${i+1}-2`)];
  urls.forEach(url=>c.addScoped("group",groupId,{url,label:url,scope:"group",required:true,mode:"connector",intervalSeconds:900},true));
  const completed=f.database.getTopic("completed"),group=f.database.workGroups.get(groupId);
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"}});
  const headers={"x-consensus-token":"test-token"},route="/api/topics/t/evidence";
  const catalog=async()=>(await app.inject({method:"GET",url:`${route}/catalog`,headers})).json();
  const select=async(groupId:string|null,version:string,actor?:string)=>app.inject({method:"POST",url:`${route}/group`,
    headers:{...headers,...(actor?{"x-consensus-actor":actor}:{})},payload:{groupId,version}});
  try {
    expect((await app.inject({method:"GET",url:route,headers})).json().sources.map((s:any)=>s.url)).toEqual([sourceInput.url]);
    const before=await catalog();
    expect(before.groups.map((g:any)=>g.id)).toEqual([groupId]);
    expect((await select(groupId,before.version,"mediator")).statusCode).toBe(403);
    expect((await select(foreignId,before.version)).statusCode).toBe(409);
    f.database.startAction({id:"busy",topicId:"t",kind:"test",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,
      pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
    expect((await select(groupId,before.version)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await catalog()).groupId).toBeNull();
    f.database.finishAction("busy","succeeded");
    expect((await select(groupId,before.version)).statusCode).toBe(200);
    const connected=(await app.inject({method:"GET",url:route,headers})).json();
    expect(connected.sources.map((s:any)=>s.url).sort()).toEqual([sourceInput.url,...urls].sort());
    expect(f.database.getTopic("t").planSHA256).toBe("a".repeat(64));
    expect(f.database.getTopic("completed")).toEqual(completed);
    expect(f.database.workGroups.get(groupId)).toEqual(group);
    expect((await select(null,before.version)).statusCode).toBe(409);
    expect((await catalog()).groupId).toBe(groupId);
    expect((await select(null,(await catalog()).version)).statusCode).toBe(200);
    expect((await app.inject({method:"GET",url:route,headers})).json().sources.map((s:any)=>s.url)).toEqual([sourceInput.url]);
    expect((await app.inject({method:"POST",url:"/api/topics/completed/evidence/group",headers,
      payload:{groupId:null,version:c.version("completed")}})).statusCode).toBe(409);
  } finally {await app.close();dbs.splice(dbs.indexOf(f.database),1);}
});


it("frozen HTTP and mediator readers return the committed body after shared updates and expiration", async () => {
  const f=fixture();f.database.updateTopic("t",{state:"READY_TO_DELIVER",committedOID:"b".repeat(40)});
  const before=f.database.evidence.topic(f.database.getTopic("t"));f.ingest("new unapproved source");
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const fetch=vi.fn(async()=>{throw Error("Frozen evidence must not refetch");});
  const app=await buildApp({config,database:f.database,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"},evidenceConnector:{configured:()=>false,fetch}});
  const headers={"x-consensus-token":"test-token"};
  try {
    const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+3_600_000);
    const search=await app.inject({method:"POST",url:"/api/topics/t/evidence/search",headers,payload:{query:"initial"}});
    expect(search.json().total).toBe(1);const hit=search.json().hits[0];
    const read=await app.inject({method:"POST",url:"/api/topics/t/evidence/read",headers,payload:{sourceId:hit.sourceId,unitId:hit.unitId,hash:hit.hash}});
    expect(read.json().content).toBe("initial");
    const batch=await app.inject({method:"POST",url:"/api/topics/t/evidence/mediator/batch",headers:{...headers,"x-consensus-actor":"mediator"},payload:{sessionId:"frozen"}});
    expect(batch.statusCode).toBe(200);expect(batch.json().digest).toBe(before.digest);
    expect(batch.json().changes[0].content).toBe("initial");expect(fetch).not.toHaveBeenCalled();
  } finally {await app.close();dbs.splice(dbs.indexOf(f.database),1);}
});

it.each([false,true])("legacy committed evidence migrates without permanently freezing expiration: %s",(changed)=>{
  const f=fixture();if(changed)f.ingest("changed before migration");const now=Date.now();vi.spyOn(Date,"now").mockReturnValue(now+3_600_000);
  const raw=new DatabaseSync(join(f.root,"room.sqlite"));
  try {raw.prepare("UPDATE topics SET committed_oid=?,state='READY_TO_DELIVER' WHERE id='t'").run("b".repeat(40));} finally {raw.close();}
  f.database.evidence.freezeFinalized();
  const topic=f.database.getTopic("t"),state=f.database.evidence.topic(topic);
  expect(state).toMatchObject({ready:true});
  expect(()=>f.database.evidence.assertReady(topic)).not.toThrow();
});

it.each([false,true])("frozen corpus uses committed hashes with an existing index: %s",async(existingIndex)=>{
  const f=fixture();f.database.evidence.catalog.add("t",{...sourceInput,scope:"topic",required:false},true);
  f.database.updateTopic("t",{planSHA256:"a".repeat(64),state:"READY_TO_DELIVER"});
  const topic=f.database.getTopic("t"),before=f.database.evidence.topic(topic);
  f.database.updateTopic("t",{committedOID:"b".repeat(40)});
  const adapter=withEvidence(f.adapter,f.database,join(f.root,"images"));
  if(existingIndex)await adapter.createSession({cwd:f.root,prompt:"Review"});
  f.ingest("unapproved v2");
  await adapter.createSession({cwd:f.root,prompt:"Review"});
  const index=readFileSync(join(f.root,"images","corpus","t",before.digest,"index.jsonl"),"utf8");
  const entries=index.split("\n").map(line=>JSON.parse(line));
  expect(entries).toHaveLength(1);expect(JSON.parse(readFileSync(entries[0].path,"utf8")).content).toBe("initial");
});

// 공식 commit 뒤 재진입(F009 resume reentry)은 확정 커밋의 근거 동결을 다시 연다(cd2876b7 F017). 다시 연 작업은 같은 승인 원문의 현재 버전을 읽고,
// 다음 commit 은 그 근거를 동결한다. 첫 커밋의 동결 기록은 그대로 남고, 재진입 중 재시작(freezeFinalized)은 현재 입력을 다시 얼리지 않는다.
const commitEvidence=(f:ReturnType<typeof fixture>,oid:string)=>{
  const topic=f.database.getTopic("t");f.database.evidence.bindCommitInput(topic,f.database.evidence.captureForCommit(topic),oid);
  f.database.updateTopic("t",{committedOID:oid});
};
const frozenRecords=(f:ReturnType<typeof fixture>)=>{
  const raw=new DatabaseSync(join(f.root,"room.sqlite"));
  try {return raw.prepare("SELECT binding,record FROM evidence_frozen_topics").all().map(row=>({key:JSON.parse(String(row.binding)) as unknown[],
    digest:String(JSON.parse(String(row.record)).digest)}));} finally {raw.close();}
};
it("공식 commit 뒤 재진입은 같은 승인 원문의 새 버전을 읽고 다음 commit 이 그 근거를 동결하며, 첫 커밋 기록은 그대로다", async () => {
  const f=fixture(),db=f.database;db.evidence.catalog.add("t",{...sourceInput,scope:"topic",required:false},true);
  db.updateTopic("t",{state:"READY_TO_DELIVER"});
  commitEvidence(f,"b".repeat(40));
  const v1=db.evidence.topic(db.getTopic("t")).digest;
  f.ingest("second version");
  expect(db.evidence.topic(db.getTopic("t")).digest).toBe(v1);
  db.applyTopicTransition({topicId:"t",changes:{state:"CLAUDE_FIX"},reopenEvidence:true,events:[]});
  const v2=db.evidence.topic(db.getTopic("t")).digest;
  expect(v2).not.toBe(v1);expect(db.evidence.isFrozen(db.getTopic("t"))).toBe(false);
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:db,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"},
    evidenceConnector:{configured:()=>false,fetch:async()=>{throw Error("Reopened evidence reads the collected body");}}});
  const headers={"x-consensus-token":"test-token"};
  try {
    const search=await app.inject({method:"POST",url:"/api/topics/t/evidence/search",headers,payload:{query:"second"}});
    expect(search.json().total).toBe(1);const hit=search.json().hits[0];
    const read=await app.inject({method:"POST",url:"/api/topics/t/evidence/read",headers,payload:{sourceId:hit.sourceId,unitId:hit.unitId,hash:hit.hash}});
    expect(read.json().content).toBe("second version");
    await withEvidence(f.adapter,db,join(f.root,"images")).createSession({cwd:f.root,prompt:"Fix"});
    const entries=readFileSync(join(f.root,"images","corpus","t",v2,"index.jsonl"),"utf8").split("\n").map(line=>JSON.parse(line));
    expect(entries.map(entry=>JSON.parse(readFileSync(entry.path,"utf8")).content)).toEqual(["second version"]);
    // 재진입 중 재시작 — 기동의 freezeFinalized 는 다시 연 현재 입력을 얼리지 않는다.
    db.evidence.freezeFinalized();
    expect(db.evidence.isFrozen(db.getTopic("t"))).toBe(false);expect(db.evidence.topic(db.getTopic("t")).digest).toBe(v2);
    // 재리뷰 뒤 두 번째 commit 은 지금 근거(v2)를 동결한다 — 그 뒤 수집한 판은 이 커밋의 근거가 아니다.
    db.updateTopic("t",{state:"READY_TO_DELIVER"});
    commitEvidence(f,"c".repeat(40));
    f.ingest("third version");
    expect(db.evidence.isFrozen(db.getTopic("t"))).toBe(true);expect(db.evidence.topic(db.getTopic("t")).digest).toBe(v2);
    db.evidence.freezeFinalized();
    expect(db.evidence.topic(db.getTopic("t")).digest).toBe(v2);
    // 첫 커밋의 동결 기록(키 [topic, binding])은 v1 그대로이고, 두 번째 commit 은 다시 연 커밋 OID 를 덧붙인 키로 따로 남는다.
    expect(frozenRecords(f).map(record=>[record.key.length,record.digest])).toEqual(expect.arrayContaining([[2,v1],[3,v2]]));
    expect(frozenRecords(f)).toHaveLength(2);
    // 두 번째 확정 커밋을 다시 열고 commit 이 실패해(근거 체크포인트만 새로 잡힘) 새 commit 없이 닫혀도, 전달 커밋(두 번째)의 근거 v2 를 보존한다.
    db.applyTopicTransition({topicId:"t",changes:{state:"CLAUDE_FIX"},reopenEvidence:true,events:[]});
    expect(db.evidence.topic(db.getTopic("t")).digest).not.toBe(v2);
    db.updateTopic("t",{state:"READY_TO_DELIVER"});db.evidence.captureForCommit(db.getTopic("t"));
    db.updateTopic("t",{state:"CLOSED"});
    expect(db.evidence.topic(db.getTopic("t")).digest).toBe(v2);
  } finally {await app.close();dbs.splice(dbs.indexOf(db),1);}
});

// 재진입 뒤 새 commit 없이 닫으면 다시 동결한다 — 전달되는 커밋은 다시 연 확정 커밋이라 그 커밋의 근거를 보존한다(master 결정 07:19). commit 입력 없이
// 동결된 옛 토픽(:502·:520-524 모양)은 다시 열 때 현재였던 동결 기록으로 보존한다(Codex 306 반례).
it("commit 입력 없이 동결된 커밋을 재진입하고 새 commit 없이 닫으면 원래 동결 기록의 근거로 다시 동결한다", () => {
  const f=fixture(),db=f.database;db.evidence.catalog.add("t",{...sourceInput,scope:"topic",required:false},true);
  db.updateTopic("t",{state:"READY_TO_DELIVER",committedOID:"b".repeat(40)});db.evidence.freezeFinalized();
  const v1=db.evidence.topic(db.getTopic("t")).digest;
  f.ingest("second version");
  db.applyTopicTransition({topicId:"t",changes:{state:"CLAUDE_FIX"},reopenEvidence:true,events:[]});
  expect(db.evidence.isFrozen(db.getTopic("t"))).toBe(false);
  db.updateTopic("t",{state:"READY_TO_DELIVER"});
  db.updateTopic("t",{state:"CLOSED"});
  expect(db.evidence.isFrozen(db.getTopic("t"))).toBe(true);expect(db.evidence.topic(db.getTopic("t")).digest).toBe(v1);
  db.evidence.freezeFinalized();
  expect(db.evidence.topic(db.getTopic("t")).digest).toBe(v1);
  expect(frozenRecords(f).map(record=>[record.key.length,record.digest])).toEqual(expect.arrayContaining([[2,v1],[3,v1]]));
});

it.each(["host", "native", "cached"] as const)("%s 수집 승인 전파는 optional 루트의 실행과 현재 별칭을 보호하고 유휴 때 전파해도 계획 승인은 보존한다", async mode => {
  const f=fixture(), db=f.database, c=db.evidence.catalog;
  db.evidence.detach("t",f.source.id);
  db.updateTopic("t",{state:"DRAFT"});
  db.createTopic({...f.topic,id:"u",slug:"u",state:"DRAFT"});
  const groupId="11111111-1111-4111-8111-111111111112";
  db.workGroups.create(groupId,{title:"Form",goal:"Form",contracts:"Scope",stages:[
    {id:"ui",kind:"work",title:"UI",goal:"Layout",acceptance:"Verified",dependsOn:[]},
    {id:"all",kind:"integration",title:"All",goal:"All",acceptance:"Verified",dependsOn:["ui"]},
  ]},f.root,"a".repeat(40));
  const selected=c.addScoped("group",groupId,{url:"https://www.figma.com/design/form?node-id=1-2",label:"Optional",scope:"group",required:false,mode:"connector",intervalSeconds:900},true);
  const collecting=c.addScoped("group",groupId,{...sourceInput,scope:"group",required:true},true);
  const group=db.workGroups.get(groupId);
  db.workGroups.revise(groupId,{title:group.title,goal:group.goal,contracts:group.contracts,stages:group.stages.map(s=>({...s,evidenceRootIds:[s.id==="ui" ? selected.id : collecting.id]}))},group.version);
  db.workGroups.link(groupId,"ui","t","a".repeat(40));
  db.workGroups.link(groupId,"all","u","a".repeat(40));
  const url="https://team.atlassian.net/browse/APP-2";
  const seed=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("host only");}});
  seed.importHost("t",{version:c.version("t"),rootId:selected.id,sourceId:selected.sourceId,previousHash:null,
    previousCheckedAt:null,observedAt:Date.now(),revision:"r",missing:[],units:[{id:"body",kind:"design",content:url}]});
  await seed.stop();
  f.ingest(url);
  if (mode==="native") c.acceptPage(collecting,db.evidence.get(collecting.sourceId),null,{revision:"page-1",cursor:"next-page",units:[{id:"first",kind:"issue",content:"already read"}],links:[]});
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const connector={configured:()=>true,fetch:async()=>{throw Error("unused");},discover:async(source:any)=>({revision:"r2",cursor:null,units:[{id:"body",kind:"issue" as const,content:source.id===collecting.sourceId ? url : "child"}],links:source.id===collecting.sourceId ? [{url,label:"child",unitId:"body",relation:"child" as const}]:[]})};
  const app=await buildApp({config,database:db,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"},...(mode==="native" ? {nativeEvidenceConnector:connector} : {})});
  db.updateTopic("t",{state:"AWAITING_USER_APPROVAL",planSHA256:"f".repeat(64),approvedPlanSHA256:"f".repeat(64)});
  db.startAction({id:"busy-discovery",topicId:"t",kind:"test",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
  const clear=vi.spyOn(ArtifactStore.prototype,"clearCurrentAliases");
  await new ArtifactStore(join(f.root,"topics"),db).write("t","plan",1,"approved plan alias");
  const request=async(overrides:Record<string,unknown>={})=>{
    const source=db.evidence.get(collecting.sourceId);
    return app.inject({method:"POST",url:`/api/topics/u/evidence/${mode==="host" ? "host-import" : "collect"}`,
      headers:{"x-consensus-token":"test-token","x-consensus-actor":"mediator"},payload:mode==="host" ? {
        version:c.version("u"),rootId:collecting.id,sourceId:source.id,previousHash:source.contentHash,
        previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"r2",missing:[],units:[{id:"body",kind:"issue",content:url}],...overrides,
      } : {}});
  };
  try {
    await request();
    expect(c.state("t").entries.find(e=>e.source.url===url)?.state).toBe("candidate");
    expect(db.getTopic("t").approvedPlanSHA256).toBe("f".repeat(64));
    expect(clear).not.toHaveBeenCalledWith("t");
    if (mode==="native") {
      expect(c.members(collecting.id).find(m=>m.source_id===collecting.sourceId)?.cursor,JSON.stringify(db.evidence.get(collecting.sourceId).collection)).toBe("next-page");
      expect(c.roots().find(r=>r.id===collecting.id)?.nextCheckAt).toBe(0);
      expect(db.evidence.get(collecting.sourceId).collection).toBeUndefined();
    }
    db.finishAction("busy-discovery","succeeded");
    if (mode==="host") for (const invalid of [{version:"0".repeat(64)},{previousHash:"0".repeat(64)},
      {units:[{id:"dup",kind:"issue",content:url},{id:"dup",kind:"issue",content:url}]}]) {
      expect((await request(invalid)).statusCode).toBeGreaterThanOrEqual(400);
      expect(clear).not.toHaveBeenCalledWith("t");
      expect(readFileSync(join(f.root,"topics/t/plan.md"),"utf8")).toBe("approved plan alias");
      expect(c.state("t").entries.find(e=>e.source.url===url)?.state).toBe("candidate");
    }
    if (mode!=="native") c.requestRefresh(collecting.id);
    const result=await request(); expect(result.statusCode,result.body).toBe(200);
    expect(c.state("t").entries.find(e=>e.source.url===url)?.state).toBe("approved");
    expect(db.getTopic("t")).toMatchObject({ state:"AWAITING_USER_APPROVAL", approvedPlanSHA256:"f".repeat(64) });
  } finally {db.finishAction("busy-discovery","succeeded");await app.close();dbs.splice(dbs.indexOf(db),1);}
});

it("같은 루트의 candidate를 child로 재발견해도 실제 승인 변경이 없으면 현재 계획을 보존한다", async () => {
  const f=fixture(),db=f.database,c=db.evidence.catalog;
  db.updateTopic("t",{state:"DRAFT"});
  const root=c.add("t",{url:"https://team.atlassian.net/wiki/spaces/APP/pages/123/Parent",label:"Optional",scope:"topic",required:false,mode:"connector",intervalSeconds:900},true);
  const url="https://team.atlassian.net/wiki/spaces/APP/pages/456/Child";
  const link={url,label:"child",unitId:"body",relation:"link" as const};
  c.acceptPage(root,db.evidence.get(root.sourceId),null,{revision:"r1",cursor:null,units:[],links:[link]});
  c.requestRefresh(root.id);
  db.updateTopic("t",{state:"AWAITING_USER_APPROVAL",planSHA256:"f".repeat(64),approvedPlanSHA256:"f".repeat(64)});
  await f.dependencies.artifacts.write("t","plan",1,"unchanged plan");
  const engine=new WorkflowEngine(f.dependencies);
  const connector={configured:()=>true,fetch:async()=>{throw Error("unused");},discover:async()=>({revision:"r2",cursor:null,units:[],links:[{...link,relation:"child" as const}]})};
  const service=new EvidenceService(db.evidence,connector,undefined,connector);
  service.canPublish=id=>engine.canPublishEvidence(id);
  service.publishSelection=(guarded,publish)=>engine.publishEvidence(guarded,publish);
  try {
    await service.collect(root.id);
    expect(c.state("t").entries.find(e=>e.source.url===url)?.state).toBe("candidate");
    expect(db.getTopic("t").approvedPlanSHA256).toBe("f".repeat(64));
    expect(readFileSync(join(f.root,"topics/t/plan.md"),"utf8")).toBe("unchanged plan");
  } finally {await service.stop();}
});


it.each(["refreshed-graph", "invalid-last-page"] as const)("%s 수집은 변경되지 않은 다른 단계의 계획과 별칭을 보존한다", async mode => {
  const f=fixture(),db=f.database,c=db.evidence.catalog;
  db.evidence.detach("t",f.source.id);
  db.updateTopic("t",{state:"DRAFT"});
  db.createTopic({...f.topic,id:"u",slug:"u",state:"DRAFT"});
  const groupId="11111111-1111-4111-8111-111111111114";
  db.workGroups.create(groupId,{title:"Form",goal:"Form",contracts:"Scope",stages:[
    {id:"ui",kind:"work",title:"UI",goal:"Layout",acceptance:"Verified",dependsOn:[]},
    {id:"all",kind:"integration",title:"All",goal:"All",acceptance:"Verified",dependsOn:["ui"]},
  ]},f.root,"a".repeat(40));
  const selected=c.addScoped("group",groupId,{url:"https://www.figma.com/design/rollback?node-id=1-2",label:"Optional",scope:"group",required:false,mode:"connector",intervalSeconds:900},true);
  const collecting=c.addScoped("group",groupId,{url:mode==="refreshed-graph" ? "https://team.atlassian.net/wiki/spaces/APP/pages/123/Parent" : sourceInput.url,label:"Collector",scope:"group",required:true,mode:"connector",intervalSeconds:900},true);
  const group=db.workGroups.get(groupId);
  db.workGroups.revise(groupId,{title:group.title,goal:group.goal,contracts:group.contracts,stages:group.stages.map(s=>({...s,evidenceRootIds:[s.id==="ui" ? selected.id : collecting.id]}))},group.version);
  db.workGroups.link(groupId,"ui","t","a".repeat(40));
  db.workGroups.link(groupId,"all","u","a".repeat(40));
  const url=mode==="refreshed-graph" ? "https://docs.google.com/spreadsheets/d/refresh-policy/edit" : "https://team.atlassian.net/browse/APP-2";
  const link={url,label:"policy",unitId:"body",relation:"link" as const};
  const current=()=>c.roots().find(r=>r.id===collecting.id)!;
  if (mode==="refreshed-graph") {
    c.acceptPage(current(),db.evidence.get(collecting.sourceId),null,{revision:"seed",cursor:null,units:[],links:[link]});
    const child=c.members(collecting.id).find(m=>m.source_id!==collecting.sourceId)!;
    c.select("u",{version:c.version("u"),rootId:collecting.id,sourceId:child.source_id,action:"accept"});
  }
  c.acceptPage(current(),db.evidence.get(collecting.sourceId),null,{revision:"page1",cursor:"next",units:[{id:"body",kind:"issue",content:"first page"}],links:[]});
  c.acceptPage(selected,db.evidence.get(selected.sourceId),null,{revision:"candidate",cursor:null,units:[],links:[link]});
  if (mode==="refreshed-graph") {
    c.acceptPage(current(),db.evidence.get(collecting.sourceId),"next",{revision:"page2",cursor:null,units:[],links:[link]});
    c.requestRefresh(collecting.id);
  }
  db.updateTopic("t",{state:"AWAITING_USER_APPROVAL",planSHA256:"f".repeat(64),approvedPlanSHA256:"f".repeat(64)});
  await f.dependencies.artifacts.write("t","plan",1,"preserved plan");
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const connector={configured:()=>true,fetch:async()=>{throw Error("unused");},discover:async(source:any)=>({revision:"new",cursor:null,units:[{id:"body",kind:"issue" as const,content:"different last page"}],links:source.id===collecting.sourceId ? [link] : []})};
  const app=await buildApp({config,database:db,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"},nativeEvidenceConnector:connector});
  const originalHash=db.evidence.get(collecting.sourceId).contentHash;
  try {
    const response=await app.inject({method:"POST",url:"/api/topics/u/evidence/collect",headers:{"x-consensus-token":"test-token","x-consensus-actor":"mediator"},payload:{}});
    expect(response.statusCode).toBe(200);
    expect(c.state("t").entries.find(e=>e.source.url===url)?.state).toBe("candidate");
    expect(db.getTopic("t").approvedPlanSHA256).toBe("f".repeat(64));
    expect(readFileSync(join(f.root,"topics/t/plan.md"),"utf8")).toBe("preserved plan");
    if (mode==="invalid-last-page") {
      expect(db.evidence.get(collecting.sourceId).collection?.status).toBe("error");
      expect(db.evidence.get(collecting.sourceId).contentHash).toBe(originalHash);
    }
  } finally {await app.close();dbs.splice(dbs.indexOf(db),1);}
});


it("후보 없는 workspace 빈 페이지 수집은 루트별 전체 작업 탐색을 반복하지 않는다", async () => {
  const f=fixture(),db=f.database,c=db.evidence.catalog;
  db.evidence.detach("t",f.source.id);
  db.updateTopic("t",{state:"DRAFT"});
  for (let i=1;i<20;i++) {
    db.createTopic({...f.topic,id:`empty-${i}`,slug:`empty-${i}`,state:"DRAFT"});
    c.add(`empty-${i}`,{url:`https://team.atlassian.net/browse/EMPTY-${i}`,label:"Other",scope:"topic",required:false,mode:"connector",intervalSeconds:900},true);
  }
  const root=c.add("t",{url:"https://docs.google.com/spreadsheets/d/empty-workspace/edit",label:"Workspace",scope:"workspace",required:false,mode:"connector",intervalSeconds:900},true);
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const connector={configured:()=>true,fetch:async()=>{throw Error("unused");},discover:async()=>({revision:"empty",cursor:null,units:[],links:[]})};
  const app=await buildApp({config,database:db,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"},nativeEvidenceConnector:connector});
  const prepare=vi.spyOn(DatabaseSync.prototype,"prepare");
  try {
    const response=await app.inject({method:"POST",url:"/api/topics/t/evidence/collect",headers:{"x-consensus-token":"test-token","x-consensus-actor":"mediator"},payload:{}});
    expect(response.statusCode).toBe(200);
    const queries=prepare.mock.calls.length;
    expect(c.roots().find(r=>r.id===root.id)?.lastCompleteAt).not.toBeNull();
    expect(queries).toBeLessThan(3000);
  } finally {prepare.mockRestore();await app.close();dbs.splice(dbs.indexOf(db),1);}
});


it("승인 전파 없는 host-import는 전역과 다른 현재 토픽 중재자를 허용한다", async () => {
  const f=fixture(),db=f.database,c=db.evidence.catalog;
  db.evidence.detach("t",f.source.id);
  db.updateTopic("t",{state:"DRAFT"});
  const root=c.add("t",{url:"https://www.figma.com/design/localmediator?node-id=1-2",label:"Topic source",scope:"topic",required:true,mode:"connector",intervalSeconds:900},true);
  const assignment={role:"mediator" as const,operation:"",profileId:null,sessionId:null,note:"",expectedVersion:0};
  const global=db.roles.assign({...assignment,scope:"global",participant:"global-mediator"});
  const local=db.roles.assign({...assignment,scope:"topic:t",participant:"topic-mediator"});
  const config=loadConfig({repositoryPath:f.root,dataDirectory:f.root,webDirectory:join(f.root,"no-web"),launchToken:"test-token",enforceBudgets:false});
  const app=await buildApp({config,database:db,runner:f.runner,claude:f.adapter,codex:{...f.adapter,role:"codex"}});
  const request=(participant:string,version:number)=>app.inject({method:"POST",url:"/api/topics/t/evidence/host-import",
    headers:{"x-consensus-token":"test-token","x-consensus-actor":"mediator","x-consensus-mediator":participant,"x-consensus-mediator-version":String(version)},
    payload:{version:c.version("t"),rootId:root.id,sourceId:root.sourceId,previousHash:null,previousCheckedAt:null,observedAt:Date.now(),revision:"r1",missing:[],units:[{id:"body",kind:"design",content:"No linked sources"}]}});
  try {
    expect((await request(global.participant,global.version)).statusCode).toBe(409);
    expect(db.evidence.get(root.sourceId).contentHash).toBeNull();
    const accepted=await request(local.participant,local.version);
    expect(accepted.statusCode,accepted.body).toBe(200);
    expect(db.evidence.snapshot(root.sourceId)?.units[0].content).toBe("No linked sources");
  } finally {await app.close();dbs.splice(dbs.indexOf(db),1);}
});

// Public plan request -> collection/selection -> scheduler. A model failure ends the test
// at the real adapter boundary; collection itself must never spend a model call.
async function waitingPlan() {
  const f = fixture();
  f.database.updateTopic("t", { state: "DRAFT", planSHA256: null, approvedPlanSHA256: null });
  for (const role of ["claude", "codex"] as const) f.database.upsertParticipant("t", {
    role, sessionId: `pending:${role}`, mode: "created", acknowledgedPlanSHA256: null,
  });
  f.database.reviews.configure("t", "planning", 3, f.database.reviews.account("t", "planning").version);
  const catalog = f.database.evidence.catalog;
  const root = catalog.add("t", { ...sourceInput, scope: "topic", required: true }, false);
  const engine = new WorkflowEngine(f.dependencies);
  const action = engine.startPlan("t");
  await vi.waitFor(() => expect(f.database.getAction(action)?.status).toBe("succeeded"));
  expect(f.adapter.createEnvelopeSession).not.toHaveBeenCalled();
  const complete = () => {
    if (catalog.roots().find(item => item.id === root.id)?.status !== "approved")
      catalog.select("t", { version: catalog.version("t"), rootId: root.id, action: "approve" });
    const source = f.database.evidence.get(root.sourceId);
    new EvidenceService(f.database.evidence, { fetch: async () => { throw Error("host only"); } }).importHost("t", {
      version: catalog.version("t"), rootId: root.id, sourceId: source.id,
      previousHash: source.contentHash, previousCheckedAt: source.checkedAt, observedAt: Date.now(),
      revision: "complete", missing: [], units: [{ id: "body", kind: "issue", content: "Confirmed contract" }],
    });
  };
  vi.mocked(f.adapter.createEnvelopeSession!).mockImplementation(async () => { throw Error("Reached planning adapter"); });
  return { ...f, engine, evidenceRoot: root, complete };
}

it("resumes a requested plan once after root approval and a server restart", async () => {
  const f = await waitingPlan();
  // Root approval goes through the same selection path as a discovered source.
  const catalog = f.database.evidence.catalog;
  await f.engine.changeEvidenceSelection(["t"], () => catalog.select("t", {
    version: catalog.version("t"), rootId: f.evidenceRoot.id, action: "approve",
  }));
  f.complete();
  f.database.close(); dbs.splice(dbs.indexOf(f.database), 1);
  const database = new ConsensusDatabase(join(f.root, "room.sqlite")); dbs.push(database);
  const resumed = new WorkflowEngine({ ...f.dependencies, database, artifacts: new ArtifactStore(join(f.root, "topics"), database) });
  resumed.pollEvidenceAssessments();
  resumed.pollEvidenceAssessments();
  await vi.waitFor(() => expect(database.runningAction("t")).toBeNull());
  expect(f.adapter.createEnvelopeSession).toHaveBeenCalledTimes(1);
  expect(database.getTopic("t").lastError).toContain("Reached planning adapter");
  expect(database.getTopic("t").approvedPlanSHA256).toBeNull();
  resumed.pollEvidenceAssessments();
  expect(f.adapter.createEnvelopeSession).toHaveBeenCalledTimes(1);
});

it.each(["stop", "scope", "assignment"])("cancels evidence resume after %s, including after restart", async change => {
  const f = await waitingPlan();
  if (change === "stop") f.engine.stop("t");
  if (change === "scope") await f.engine.handleScopeChange("t", "Changed scope");
  if (change === "assignment") f.database.roles.assign({ scope: "topic:t", role: "mediator", operation: "", participant: "new-mediator",
    profileId: null, sessionId: null, expectedVersion: 0, note: "Reassigned" });
  f.complete();
  const restarted = new WorkflowEngine(f.dependencies);
  restarted.pollEvidenceAssessments();
  expect(f.database.runningAction("t")).toBeNull();
  expect(f.adapter.createEnvelopeSession).not.toHaveBeenCalled();
});

it("does not retry a budget refusal on every collection poll", async () => {
  const f = await waitingPlan();
  f.complete();
  f.database.budgets.start({ id: "unfinished", accounts: ["t"], startedAt: Date.now(), stage: "CLAUDE_PLAN", role: "claude", model: "test", effort: "low" });
  const gated = new WorkflowEngine({ ...f.dependencies, enforceBudgets: true });
  gated.pollEvidenceAssessments(); gated.pollEvidenceAssessments();
  expect(f.adapter.createEnvelopeSession).not.toHaveBeenCalled();
  expect(f.database.runningAction("t")).toBeNull();
  expect(f.database.getTimeline("t").filter(event => (event.payload?.evidenceResume as any)?.blocked)).toHaveLength(1);
});

it("resumes ready evidence while an unrelated topic is running", async () => {
  const f = await waitingPlan();
  f.database.createTopic({ ...f.database.getTopic("t"), id: "other", slug: "other", repositoryPath: f.root + "-other", worktreePath: f.root + "-other" });
  f.database.startAction({ id: "other-action", topicId: "other", kind: "test", status: "running", createdAt: new Date().toISOString(),
    finishedAt: null, error: null, pid: null, pgid: null, processExecutable: null, processCommand: null, processStartedAt: null });
  f.complete();
  f.engine.pollEvidenceAssessments();
  await vi.waitFor(() => expect(f.database.runningAction("t")).toBeNull());
  expect(f.adapter.createEnvelopeSession).toHaveBeenCalledTimes(1);
  expect(f.database.runningAction("other")?.id).toBe("other-action");
  f.database.finishAction("other-action", "succeeded");
});

it("starts a brainstorm with no plan while unavailable evidence is deferred", async () => {
  const f = await waitingPlan();
  f.engine.stop("t"); f.complete();
  f.database.updateTopic("t", { state: "BRAINSTORM_READY" });
  const check = f.database.evidence.begin(f.source.id, true)!;
  f.database.evidence.failed(f.source.id, check.checkId, "Unavailable source");
  vi.mocked(f.adapter.createSession).mockImplementation(async turn => {
    await turn.beforeSpawn?.(); turn.admitSync?.();
    throw Error("Started brainstorm adapter");
  });
  f.engine.startBrainstorm("t", {});
  await vi.waitFor(() => expect(f.database.runningAction("t")).toBeNull());
  expect(f.database.getTopic("t").lastError).toContain("Started brainstorm adapter");
  expect(f.database.evidence.resumes.get("t")).toBeNull();
});

it("exposes a pending evidence resume and cancellation through the web activity API", async () => {
  const f = await waitingPlan();
  const config = loadConfig({ repositoryPath: f.root, dataDirectory: f.root, webDirectory: join(f.root, "no-web"), launchToken: "test-token", enforceBudgets: false });
  const app = await buildApp({ config, database: f.database, runner: f.runner, claude: f.adapter, codex: { ...f.adapter, role: "codex" } });
  const headers = { "x-consensus-token": "test-token" };
  try {
    expect((await app.inject({ method: "GET", url: "/api/topics/t/activity", headers })).json().evidenceResumePending).toBe(true);
    expect((await app.inject({ method: "POST", url: "/api/topics/t/actions/stop", headers: { ...headers, "idempotency-key": "cancel-evidence" }, payload: {} })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: "/api/topics/t/activity", headers })).json().evidenceResumePending).toBe(false);
    f.complete();
    f.engine.pollEvidenceAssessments();
    expect(f.adapter.createEnvelopeSession).not.toHaveBeenCalled();
  } finally { await app.close(); dbs.splice(dbs.indexOf(f.database), 1); }
});

// 원문 수집 실패는 계획 시작을 막지 않고, 실패한 원문의 옛 캐시는 근거 묶음에서 빠진다. 실패 사실은 source-error 로 전달된다(external-evidence 검사).
it("starts a requested plan with failed evidence and excludes the failed source's cache", async () => {
  const f = fixture();
  f.database.updateTopic("t", { state: "DRAFT", planSHA256: null, approvedPlanSHA256: null });
  for (const role of ["claude", "codex"] as const) f.database.upsertParticipant("t", {
    role, sessionId: `pending:${role}`, mode: "created", acknowledgedPlanSHA256: null,
  });
  f.database.reviews.configure("t", "planning", 3, f.database.reviews.account("t", "planning").version);
  f.database.evidence.catalog.add("t", { ...sourceInput, scope: "topic", required: true }, true);
  const check = f.database.evidence.begin(f.source.id, true)!;
  f.database.evidence.failed(f.source.id, check.checkId, "HTTP 404", 300);
  vi.mocked(f.adapter.createEnvelopeSession!).mockImplementation(async () => { throw Error("Planning actually started"); });
  const engine = new WorkflowEngine(f.dependencies);
  const action = engine.startPlan("t");
  await vi.waitFor(() => expect(f.database.getAction(action)?.status).toBe("failed"));
  expect(f.adapter.createEnvelopeSession).toHaveBeenCalledTimes(1);
  expect(f.database.getTopic("t").lastError).toContain("Planning actually started");
  expect(f.database.evidence.resumes.get("t")).toBeNull();
  expect(f.database.evidence.catalog.state("t").coverage.ready).toBe(false);
  expect(f.database.evidence.usableSources(f.database.getTopic("t"))).toEqual([]);
  expect(f.database.evidence.packet(f.database.getTopic("t"), "claude").text).not.toContain('"content":"initial"');
});

it("defers unavailable source content without treating collection failure as a changed contract", () => {
  const f = fixture(), before = f.database.evidence.topic(f.topic);
  const check = f.database.evidence.begin(f.source.id, true)!;
  f.database.evidence.failed(f.source.id, check.checkId, "Connection unavailable", 300);
  const state = f.database.evidence.topic(f.topic);
  expect(state).toMatchObject({ ready: true, digest: before.digest,
    deferred: [expect.objectContaining({ sourceId: f.source.id, reason: "Connection unavailable" })] });
  expect(() => f.database.evidence.assertReady(f.topic)).not.toThrow();
  const later = Date.now() + 301_000; vi.spyOn(Date, "now").mockReturnValue(later);
  f.database.evidence.releaseCheck(f.source.id, check.checkId);
  f.ingest("changed contract");
  expect(f.database.evidence.topic(f.topic).digest).not.toBe(before.digest);
});

it("continues with an immutable partial corpus after a cached source becomes unavailable", async () => {
  const f = fixture();
  f.database.evidence.catalog.add("t", { ...sourceInput, scope: "topic", required: true }, true);
  const adapter = withEvidence(f.adapter, f.database, join(f.root, "images"));
  await adapter.createSession({ cwd: f.root, prompt: "Plan" });
  const first = vi.mocked(f.adapter.createSession).mock.calls[0][0].readablePaths![0];
  const before = readFileSync(join(first, "index.jsonl"), "utf8");
  const check = f.database.evidence.begin(f.source.id, true)!;
  f.database.evidence.failed(f.source.id, check.checkId, "offline");
  await adapter.createSession({ cwd: f.root, prompt: "Continue supported scope" });
  expect(f.adapter.createSession).toHaveBeenCalledTimes(2);
  const second = vi.mocked(f.adapter.createSession).mock.calls[1][0].readablePaths![0];
  expect(second).not.toBe(first);
  expect(readFileSync(join(second, "index.jsonl"), "utf8")).toBe("");
  expect(readFileSync(join(first, "index.jsonl"), "utf8")).toBe(before);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 301_000);
  f.database.evidence.releaseCheck(f.source.id, check.checkId);
  f.ingest("initial");
  await adapter.createSession({ cwd: f.root, prompt: "Reused current original" });
  expect(vi.mocked(f.adapter.createSession).mock.calls[2][0].readablePaths![0]).toBe(first);
});

// F006/F007: discovery-only roots still create To-do without hydrating every cached body.
it("records inaccessible workspace channel roots with metadata-only availability checks", () => {
  const f = fixture();
  const root = f.database.evidence.catalog.add("t", { url: "https://team.slack.com/archives/C123", label: "Team channel",
    mode: "connector", scope: "workspace", required: true, intervalSeconds: 300 }, true);
  const snapshot = vi.spyOn(f.database.evidence, "snapshot");
  const sourceSnapshot = vi.spyOn(f.database.evidence, "sourceSnapshot");
  expect(f.database.evidence.topic(f.database.getTopic("t"))).toMatchObject({ ready: true,
    deferred: [expect.objectContaining({ sourceId: root.sourceId, url: "https://team.slack.com/archives/C123" })] });
  expect(f.database.evidence.usableSources(f.database.getTopic("t")).map(source => source.id)).toEqual([f.source.id]);
  expect(snapshot).not.toHaveBeenCalled();
  expect(sourceSnapshot).not.toHaveBeenCalled();
});
