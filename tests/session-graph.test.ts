import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { buildApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { buildSessionGraph } from "../src/server/sessionGraph";
import { readHostReviewGraph } from "../src/server/hostReviewGraph";
import { WorkflowEngine } from "../src/server/workflow";
import { ArtifactStore } from "../src/server/artifacts";
import { GitService } from "../src/server/git";
import type { SessionGraph } from "../src/shared/sessionGraph";
import { DEFAULT_AGENT_SETTINGS } from "../src/shared/contracts";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "session-graph-")), path = join(root, "db.sqlite"), db = new ConsensusDatabase(path);
  const topic = (id: string, parentTopicId: string | null = null, group = false) => db.createTopic({ id, slug:id, title:id, parentTopicId, topicKind:group ? "group" : "task",
    workEntry:{mode:"goal",goal:`Goal ${id}`,sourceIds:[],evidenceDigest:null}, baseRef:"HEAD",repositoryPath:root,worktreePath:root,state:"DRAFT",branchName:null,
    scopeGeneration:1,planRevision:0,planSHA256:null,approvedPlanSHA256:null,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastError:null });
  cleanups.push(() => { db.close(); rmSync(root,{recursive:true,force:true}); });
  const graph = (id: string) => buildSessionGraph(db,id,{nodes:[],edges:[],warning:"Host-review 미연결"});
  return {db,topic,graph,root,path};
}
it("retains sessions from the stored previous recovery lineage without timeline events", () => {
  const f=fixture();f.topic("t");f.topic("outside");
  const old=f.db.planning.recoveryLineage("t","implementer",{kind:"approval",revision:1,sha256:"old"});
  old.sessions=["original-work"];
  f.db.planning.saveRecoveryLineage("t","implementer",old);
  const next=f.db.planning.recoveryLineage("t","implementer",{kind:"implementation",revision:2,sha256:"next"});
  next.sessions=["later-work"];
  f.db.planning.saveRecoveryLineage("t","implementer",next);
  f.db.planning.saveRecoveryLineage("outside","implementer",{anchor:null,sessions:["unrelated-work"],recoveries:[]});
  const graph=f.graph("t");
  for (const id of ["original-work","later-work"]) expect(graph.nodes.find(node=>node.sessionId===id)).toMatchObject({role:"runner",historical:true});
  expect(graph.nodes.some(node=>node.sessionId==="unrelated-work")).toBe(false);
});

it.each([false,true])("shows newly attached pending seats as unconnected (management: %s)", async group => {
  const f=fixture();f.topic("t",null,group);
  if(group) f.db.updateTopic("t",{state:"BRAINSTORM_READY"});
  const unexpected=async()=>{throw new Error("No model or Git call is needed to attach a new seat");};
  const engine=new WorkflowEngine({database:f.db,artifacts:new ArtifactStore(join(f.root,"artifacts"),f.db),git:new GitService({run:unexpected}),
    claude:{role:"claude",validateExistingSession:async()=>true,createSession:unexpected,resumeTurn:unexpected},
    codex:{role:"codex",validateExistingSession:async()=>true,createSession:unexpected,resumeTurn:unexpected}});
  cleanups.push(()=>engine.shutdown().then(()=>{}));
  for(const role of ["claude","codex"] as const) await engine.attachParticipant("t",role,{mode:"new"});
  expect(f.db.getTopic("t").participants.every(participant=>participant.sessionId.startsWith("pending:"))).toBe(true);
  const graph=f.graph("t");
  for(const role of ["planner","plan-reviewer"]) expect(graph.nodes.find(node=>node.role===role)).toMatchObject({sessionId:null,status:"unconnected",historical:false});
  expect(JSON.stringify(graph)).not.toContain("pending:");
});
it("scopes descendants, distinguishes actual source delivery, and keeps role settings provider-neutral", () => {
  const f=fixture();f.topic("root",null,true);const child=f.topic("child","root");f.topic("outside");
  f.db.upsertParticipant(child.id,{role:"claude",sessionId:"author-session",mode:"attached",acknowledgedPlanSHA256:null});
  f.db.roles.createProfile({id:"reviser",provider:"codex",model:"review-model",effort:"high",options:{}});
  f.db.roles.assign({scope:"topic:child",role:"planner",operation:"revision",participant:"person-b",profileId:"reviser",sessionId:null,expectedVersion:0,note:"test"});
  f.db.updateTopic(child.id,{state:"CLAUDE_REVISION"});
  const source=f.db.evidence.register(child.id,{url:"https://example.com/spec",label:"Source spec",mode:"rest",intervalSeconds:900});
  const sql=new DatabaseSync(f.path);
  sql.prepare("INSERT INTO evidence_receipts VALUES(?,?,?,?)").run(JSON.stringify([child.id,1,"claude","author-session"]),source.id,"unit-1","hash-1");sql.close();
  const graph=f.graph("root");
  expect(graph.nodes.filter(n=>n.kind==="topic").map(n=>n.topicId).sort()).toEqual(["child","root"]);
  const planner=graph.nodes.find(n=>n.sessionId==="author-session")!;
  expect(planner.details).toContainEqual({label:"플래너 현재 설정",value:"codex · review-model · high"});
  expect(planner.provider).toBe("claude"); // Existing session identity doesn't become the configured future provider.
  expect(graph.edges.filter(e=>e.kind==="delivered")).toEqual([expect.objectContaining({to:planner.id,label:expect.stringContaining("1개 원문 조각")})]);
  expect(graph.edges.filter(e=>e.kind==="registered")).toHaveLength(1);
  expect(graph.edges.filter(e=>e.kind==="communication")).toHaveLength(0);
  expect(graph.nodes.find(n=>n.role==="host-reviewer")?.status).toBe("unconnected");
});
it("shows persisted interrupt delivery without attributing a legacy request to a guessed sender session", () => {
  const f=fixture();f.topic("t");
  f.db.roles.createProfile({id:"med",provider:"codex",model:"med-model",effort:"medium",options:{}});
  f.db.roles.assign({scope:"global",role:"mediator",operation:"",participant:"owner",profileId:"med",sessionId:"med-session",expectedVersion:0,note:"test"});
  f.db.applyTopicTransition({topicId:"t",changes:{state:"USER_DECISION_REQUIRED",resumeState:"IMPLEMENTING",lastError:"확인 필요"},events:[{actor:"system",kind:"system",state:"USER_DECISION_REQUIRED",body:"확인 필요"}]});
  const item=f.db.interrupts.current("t")!,target=JSON.stringify(["global","owner",1,"codex","med-session"]);
  const claim=f.db.interrupts.claim("t",item.id,target);
  f.db.interrupts.receipt("t",item.id,target,claim.claim,"sent",null);
  let edge=f.graph("t").edges.find(e=>e.kind==="communication")!;
  expect(edge).toMatchObject({from:"topic:t",to:"session:t:codex:med-session",status:"sent"});
  expect(edge.detail).toContain("발신 세션 ID 기록이 없어");
  f.db.interrupts.receipt("t",item.id,target,claim.claim,"acknowledged",null);
  edge=f.graph("t").edges.find(e=>e.kind==="communication")!;expect(edge.status).toBe("acknowledged");
  expect(f.graph("t").nodes.filter(n=>n.status==="running")).toEqual([]);
});
it("includes future execution nodes and implicit integration admission edges", () => {
  const f=fixture();f.topic("r",null,true);
  f.db.workGroups.create("g",{title:"pipeline",goal:"Goal",contracts:"contracts",stages:[
    {id:"a",title:"First",goal:"First goal",kind:"work",dependsOn:[]},
    {id:"b",title:"Second",goal:"Second goal",kind:"work",dependsOn:["a"]},
    {id:"z",title:"Integration",goal:"Check all",kind:"integration",dependsOn:[]},
  ]},f.root,"base",{parentTopicId:"r"});
  expect(f.graph("r").edges.filter(e=>e.kind==="dependency").map(e=>[e.from,e.to])).toEqual([
    ["stage:g:a","stage:g:b"],["stage:g:a","stage:g:z"],["stage:g:b","stage:g:z"],
  ]);
});
it("graph polling is authenticated and cannot start adapters; pipeline edits preserve linked approvals", async () => {
  const f=fixture();f.topic("r",null,true);f.topic("t","r");f.db.updateTopic("t",{state:"USER_DECISION_REQUIRED"});
  const input={title:"pipeline",goal:"Goal",contracts:"contracts",stages:[
    {id:"a",title:"First",goal:"First goal",kind:"work" as const,dependsOn:[]},
    {id:"b",title:"Second",goal:"Second goal",acceptance:"independent result verified",kind:"work" as const,dependsOn:["a"]},
    {id:"z",title:"Integration",goal:"Check all",kind:"integration" as const,dependsOn:["b"]},
  ]};
  f.db.workGroups.create("g",input,f.root,"base",{parentTopicId:"r"});f.db.workGroups.link("g","a","t","base");
  const call=vi.fn(async()=>{throw new Error("Unexpected model call");});
  const config=loadConfig({dataDirectory:f.root,databasePath:f.path,repositoryPath:f.root,memoryDirectory:join(f.root,"memory"),webDirectory:join(f.root,"no-web"),launchToken:"test",defaultAgentSettings:DEFAULT_AGENT_SETTINGS});
  const app=await buildApp({config,database:f.db,runner:{run:async()=>({exitCode:0,stdout:"",stderr:"",jsonLines:[]})},claude:{role:"claude",validateExistingSession:async()=>true,createSession:call,resumeTurn:call},codex:{role:"codex",validateExistingSession:async()=>true,createSession:call,resumeTurn:call}});
  // buildApp owns the database close; remove the fixture's duplicate close.
  cleanups.pop();cleanups.push(async()=>{await app.close();rmSync(f.root,{recursive:true,force:true});});
  const headers={"x-consensus-token":"test"};
  expect((await app.inject({url:"/api/topics/r/graph"})).statusCode).toBe(401);
  const response=await app.inject({url:"/api/topics/r/graph",headers});expect(response.statusCode).toBe(200);
  expect((response.json() as SessionGraph).nodes.some(n=>n.kind==="stage")).toBe(true);expect(call).not.toHaveBeenCalled();
  const revise=(body:unknown)=>app.inject({method:"POST",url:"/api/work-groups/g/revise",headers:{...headers,"idempotency-key":crypto.randomUUID()},payload:body as any});
  const before=f.db.getTopic("t");
  expect((await app.inject({url:"/api/work-groups",headers})).json()[0].selectableStages).not.toContain("b");
  const rejected=await revise({mode:"pipeline",version:1,input:{...input,contracts:"new contracts"}});expect(rejected.statusCode, rejected.body).toBe(409);
  expect(f.db.workGroups.get("g").version).toBe(1);expect(f.db.getTopic("t")).toEqual(before);
  const edited={...input,stages:input.stages.map(s=>s.id==="b"?{...s,dependsOn:[]}:s)};
  const accepted=await revise({mode:"pipeline",version:1,input:edited});expect(accepted.statusCode).toBe(200);
  expect(f.db.workGroups.get("g").stages.find(s=>s.id==="b")?.dependsOn).toEqual([]);
  expect(f.db.getTopic("t")).toEqual(before);expect(call).not.toHaveBeenCalled();
  expect((await app.inject({url:"/api/work-groups",headers})).json()[0].selectableStages).toContain("b");
  const stale=await revise({mode:"pipeline",version:1,input});expect(stale.statusCode).toBeGreaterThanOrEqual(400);
});
it("missing optional host-review integration is explicit and does not crash the graph", () => {
  const f=fixture();expect(readHostReviewGraph(f.root)).toMatchObject({nodes:[],warning:expect.stringContaining("연결되지")});
});

it("reads host session settings without trusting corrupt or out-of-root subject files", () => {
  const f=fixture(), home=join(f.root,"review-tools");mkdirSync(home);const a=join(home,"a"),b=join(home,"b");mkdirSync(a);mkdirSync(b);
  writeFileSync(join(a,"subject.json"),JSON.stringify({runtime:{profile:{provider:"codex",model:"host-model",effort:"high"}}}));
  writeFileSync(join(b,"subject.json"),"invalid JSON");
  const sql=new DatabaseSync(join(home,"reviews.sqlite"));sql.exec("CREATE TABLE runs(id,job,session_id,status,head,started,provider_pid,directory);CREATE TABLE jobs(id,repo);");
  sql.prepare("INSERT INTO jobs VALUES(?,?)").run("job","engine");
  sql.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)").run("new","job","host-session","passed","head-a",2,null,a);
  sql.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)").run("old","job","old-session","running","head-b",1,null,b);sql.close();
  const graph=readHostReviewGraph(f.root);
  expect(graph.nodes.find(n=>n.sessionId==="host-session")).toMatchObject({provider:"codex",status:"complete",historical:false});
  expect(graph.nodes.find(n=>n.sessionId==="host-session")?.details).toContainEqual({label:"실행 당시 모델",value:"host-model"});
  expect(graph.nodes.find(n=>n.sessionId==="old-session")).toMatchObject({status:"unknown",historical:true});
});

it("keeps the two brainstorming sessions visible on a management topic", () => {
  const f=fixture();f.topic("root",null,true);f.db.updateTopic("root",{state:"BRAINSTORM_READY"});
  for (const role of ["claude","codex"] as const) f.db.upsertParticipant("root",{role,sessionId:`${role}-discussion`,mode:"attached",acknowledgedPlanSHA256:null});
  const graph=f.graph("root");
  expect(graph.nodes.filter(n=>["planner","plan-reviewer"].includes(n.role??"")).map(n=>[n.sessionId,n.historical])).toEqual([["claude-discussion",false],["codex-discussion",false]]);
  expect(graph.nodes.some(n=>n.role==="runner")).toBe(false);
});

it("keeps plan and code reviewer settings tied to their own seats across stages", () => {
  const f=fixture();f.topic("t");
  for (const operation of ["audit","review"] as const) {
    f.db.roles.createProfile({id:operation,provider:"codex",model:`${operation}-model`,effort:"high",options:{}});
    f.db.roles.assign({scope:"topic:t",role:"reviewer",operation,participant:`${operation}-owner`,profileId:operation,sessionId:null,expectedVersion:0,note:"test"});
  }
  for (const state of ["CODEX_AUDIT","CODEX_REVIEW"] as const) {
    f.db.updateTopic("t",{state});
    const graph=f.graph("t");
    expect(graph.nodes.find(n=>n.role==="plan-reviewer")?.details).toContainEqual({label:"계획 검토자 현재 설정",value:"codex · audit-model · high"});
    expect(graph.nodes.find(n=>n.role==="reviewer")?.details).toContainEqual({label:"코드 검토자 현재 설정",value:"codex · review-model · high"});
  }
});

it("retains replaced sessions, partial body delivery and indexed receipt lookups", () => {
  const f=fixture(),topic=f.topic("t");
  f.db.appendEvent({topicId:"t",actor:"system",kind:"system",state:"DRAFT",body:"session changed",payload:{sessionRebound:{seat:"claude",previous:{sessionId:"old-discussion",binding:{provider:"claude"}}}}});
  f.db.appendEvent({topicId:"t",actor:"user",kind:"scope_change",state:"DRAFT",body:"scope changed",payload:{previousSessions:{codex:"old-review"},previousBindings:{codex:{provider:"codex"}}}});
  const source=f.db.evidence.register(topic.id,{url:"https://example.com/large",label:"Large original",mode:"rest",intervalSeconds:900});
  const sql=new DatabaseSync(f.path),consumer=JSON.stringify([topic.id,1,"claude","old-discussion"]);
  sql.prepare("INSERT INTO evidence_link_receipts VALUES(?,?)").run(consumer,source.id);
  sql.prepare("INSERT INTO evidence_receipt_progress VALUES(?,?,?,?,?)").run(consumer,source.id,"large-unit","hash",1200);
  const graph=f.graph("t");
  expect(graph.nodes.find(n=>n.sessionId==="old-discussion")).toMatchObject({historical:true,role:"planner"});
  expect(graph.nodes.find(n=>n.sessionId==="old-review")).toMatchObject({historical:true,role:"plan-reviewer",provider:"codex"});
  const delivered=graph.edges.filter(e=>e.kind==="delivered");expect(delivered).toHaveLength(1);expect(delivered[0].label).toContain("본문 일부 전달");
  for (const table of ["evidence_receipts","evidence_receipt_progress","evidence_link_receipts","evidence_mediator_unit_receipts","evidence_mediator_progress","evidence_mediator_source_receipts"]) {
    const plan=sql.prepare(`EXPLAIN QUERY PLAN SELECT consumer,source_id,COUNT(*) FROM ${table} WHERE json_valid(consumer) AND json_extract(consumer,'$[0]')=? GROUP BY consumer,source_id`).all("t");
    expect(plan.some(row=>String(row.detail).includes(`SEARCH ${table} USING INDEX ${table}_topic`))).toBe(true);
  }
  sql.close();
});

it("does not mutate the cached host graph while retaining every reviewed snapshot of a resumed session", () => {
  const f=fixture();f.topic("t");const home=join(f.root,"review-tools");mkdirSync(home);
  const sql=new DatabaseSync(join(home,"reviews.sqlite"));sql.exec("CREATE TABLE runs(id,job,session_id,status,head,started,provider_pid,directory);CREATE TABLE jobs(id,repo);");
  sql.prepare("INSERT INTO jobs VALUES(?,?)").run("job","engine");
  for (const [index,head] of ["old-head","new-head"].entries()) sql.prepare("INSERT INTO runs VALUES(?,?,?,?,?,?,?,?)").run(String(index),"job","same-session","passed",head,index,null,home);
  sql.close();const host=readHostReviewGraph(f.root),original=structuredClone(host);
  const a=buildSessionGraph(f.db,"t",host),b=buildSessionGraph(f.db,"t",host);
  expect(host).toEqual(original);expect(b.nodes).toEqual(a.nodes);
  expect(host.nodes.filter(n=>n.kind==="session")).toHaveLength(1);expect(host.edges).toHaveLength(2);
  expect(host.nodes.filter(n=>n.kind==="source").map(n=>n.subtitle).sort()).toEqual(["new-head","old-head"]);
});

it("rejects new work after integration has started and restores attention without loading conversation history", () => {
  const f=fixture();f.topic("r",null,true);f.topic("a","r");f.topic("z","r");
  const input={title:"group",goal:"goal",contracts:"contract",stages:[{id:"a",title:"A",goal:"A",kind:"work" as const,dependsOn:[]},{id:"z",title:"Z",goal:"Z",kind:"integration" as const,dependsOn:["a"]}]};
  f.db.workGroups.create("g",input,f.root,"base");f.db.workGroups.link("g","a","a","base");f.db.workGroups.link("g","z","z","base");
  const next={...input,stages:[input.stages[0],{id:"b",title:"B",goal:"B",kind:"work" as const,dependsOn:[],outcome:"B result",separation:{basis:"rollback" as const,detail:"Separate reversible result"}},input.stages[1]]};
  expect(()=>f.db.workGroups.previewRevision("g",next,1)).toThrow("통합 검증이 시작된 뒤");expect(f.db.workGroups.get("g").version).toBe(1);
  f.db.updateTopic("z",{state:"USER_DECISION_REQUIRED",resumeState:"CODEX_REVIEW"});
  f.db.appendEvent({topicId:"z",actor:"system",kind:"system",state:"USER_DECISION_REQUIRED",body:"reviewer needs mediator"});
  const sql=new DatabaseSync(f.path);sql.exec("DELETE FROM mediator_interrupts");sql.close();
  const history=vi.spyOn(f.db,"getTimeline").mockImplementation(()=>{throw new Error("Full history must not load");});
  f.db.restoreMediatorInterrupts();expect(f.db.interrupts.current("z")).toMatchObject({reason:"reviewer needs mediator",sourceRole:"reviewer"});expect(f.db.interrupts.current("r")).toBeNull();expect(history).not.toHaveBeenCalled();
});
