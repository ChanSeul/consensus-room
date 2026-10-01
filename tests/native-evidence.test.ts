import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { NativeEvidenceConnector } from "../src/server/evidence/nativeConnector";
import { EvidenceService } from "../src/server/evidence/service";
import type { AppReader } from "../src/server/evidence/nativeReader";

// discover/collect -> persisted snapshot -> automatic queue is the public contract.
// Fixtures model provider pagination, account switching, edits/deletions, and failure.
// New collection contracts and review regressions are covered here; live auth and rendered UI need separate checks.
const clean: Array<() => void> = [];
afterEach(() => { clean.splice(0).forEach(fn => fn()); });
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "native-evidence-"));
  const db = new ConsensusDatabase(join(dir, "room.sqlite"));
  clean.push(() => { db.close(); rmSync(dir, {recursive:true,force:true}); });
  const topic = db.createTopic({ id:"t",slug:"t",title:"Test",repositoryPath:dir,worktreePath:dir,baseRef:"main",branchName:null,
    state:"CODEX_AUDIT",scopeGeneration:1,planRevision:1,planSHA256:"a".repeat(64),approvedPlanSHA256:null,
    createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),lastError:null });
  const root = db.evidence.catalog.add(topic.id,{url:"https://docs.google.com/spreadsheets/d/test/edit",label:"Policy",mode:"connector",scope:"topic",required:true,intervalSeconds:900},true);
  return {db,topic,root};
}
it("commits complete hidden-tab/formula/comment reads, skips duplicate notifications, and preserves cache on failure", async () => {
  const {db,topic,root}=fixture(); let formula="=1+1", hidden=true, comments:any[]=[{id:"c",content:"Before",replies:[{id:"r",content:"Reply"}]}], fail=false;
  const call=vi.fn(async (_provider,name) => {
    if(name.endsWith("metadata")) return {sheets:[{properties:{sheetId:1,title:"Hidden",hidden,gridProperties:{rowCount:1,columnCount:1}}}]};
    if(name.endsWith("cells")) return {sheets:[{properties:{sheetId:1},data:[{rowData:[{values:[{userEnteredValue:{formulaValue:formula},note:"Owner note"}]}]}]}]};
    if(fail) throw Error("Permission revoked");
    return {comments,nextPageToken:null};
  });
  const reader:AppReader={call,config:async()=>({googleDriveLinkId:"link_work"}),close:async()=>{}};
  const changed=vi.fn();
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("No REST");}},changed,undefined,new NativeEvidenceConnector(reader));
  const observe=()=>db.evidence.automation.observe(topic,db.evidence.list(topic.id),db.evidence.topic(topic).digest);
  try {
    await service.collect(root.id); expect(observe()).toBeNull();
    const first=db.evidence.get(root.sourceId).contentHash;
    expect(db.evidence.snapshot(root.sourceId)?.units.map(u=>u.id)).toEqual(["1:0:0","comment:c","workbook"]);
    await service.collect(root.id,true); expect(observe()).toBeNull(); expect(changed).toHaveBeenCalledTimes(1);
    expect(db.evidence.get(root.sourceId).collection?.status).toBe("unchanged");
    formula="=2+2"; hidden=false; comments=[]; fail=true;
    await service.collect(root.id,true); expect(db.evidence.get(root.sourceId).contentHash).toBe(first); expect(observe()).toBeNull();
    expect(db.evidence.get(root.sourceId).collection?.status).toBe("error");
    fail=false; await service.collect(root.id,true);
    const job=observe()!; expect(job.changes).toHaveLength(1); expect(observe()?.id).toBe(job.id);
    expect(db.evidence.snapshot(root.sourceId)?.units.map(u=>u.id)).not.toContain("comment:c");
    expect(db.evidence.snapshot(root.sourceId)?.units.find(u=>u.id==="workbook")?.content).toContain('"hidden":false');
    expect(db.evidence.automation.start(job,"action")).toBe(true); expect(db.evidence.automation.start(job,"other")).toBe(false);
    expect(db.evidence.automation.finish(job,{...topic,planEpoch:topic.planEpoch+1},job.digest,"no-impact","stale")).toBe(false);
    expect(db.evidence.automation.jobs(topic.id)[0].status).toBe("superseded");
  } finally {await service.stop();}
});
it("refuses mixed accounts across sheet pages and records no completed snapshot", async()=>{
  const {db,root}=fixture(); let link="link_work";
  const reader:AppReader={config:async()=>({googleDriveLinkId:link}),close:async()=>{},call:async()=>({sheets:[{properties:{sheetId:1,title:"Policy",gridProperties:{rowCount:1,columnCount:1}}}]})};
  const connector=new NativeEvidenceConnector(reader), source=db.evidence.get(root.sourceId), signal=new AbortController().signal;
  const page=await connector.discover(source,null,signal); link="link_other";
  await expect(connector.discover(source,page.cursor,signal)).rejects.toThrow("계정이 바뀌었습니다");
  expect(db.evidence.snapshot(root.sourceId)).toBeNull();
});
it("reads Slack formatted messages and refuses an incomplete pagination response",async()=>{
  const {db,topic}=fixture();
  const source=db.evidence.register(topic.id,{url:"https://team.slack.com/archives/C123",label:"Slack",mode:"connector",intervalSeconds:900});
  let pagination_info="There are more messages available. Next page";
  const reader:AppReader={config:async()=>({}),close:async()=>{},call:async(_p,name)=>name.endsWith("profile")?{result:"User ID: U123\nName: Owner"}:{messages:"=== Message from Owner ===\nMessage TS: 123.456\nPolicy",pagination_info}};
  const connector=new NativeEvidenceConnector(reader), signal=new AbortController().signal;
  await expect(connector.discover(source,null,signal)).rejects.toThrow("커서");
  pagination_info="There are no more messages.";
  const page=await connector.discover(source,null,signal); expect(page.units[0].id).toBe("123.456"); expect(page.links[0].relation).toBe("child");
});
it("persists pending changes across store recovery and does not replay an unconfirmed model run",()=>{
  const {db,topic,root}=fixture();
  const ingest=(text:string)=>{const check=db.evidence.begin(root.sourceId,true)!;db.evidence.ingest(root.sourceId,{checkId:check.checkId,revision:text,units:[{id:"policy",kind:"cells",content:text}]});};
  const observe=()=>db.evidence.automation.observe(topic,db.evidence.list(topic.id),db.evidence.topic(topic).digest);
  ingest("before");expect(observe()).toBeNull();ingest("after");const job=observe()!;
  db.evidence.automation.recover(topic.id);expect(observe()?.id).toBe(job.id);
  db.evidence.automation.start(job,"lost-action");db.evidence.automation.recover(topic.id);
  expect(db.evidence.automation.jobs(topic.id)[0].status).toBe("failed");expect(observe()).toBeNull();
});
it("captures Figma design edits and explicitly reports unavailable comments",async()=>{
  const {db,topic}=fixture();const source=db.evidence.register(topic.id,{url:"https://www.figma.com/design/test?node-id=1-2",label:"Approved",mode:"connector",intervalSeconds:900});
  let text="Original design";
  const reader:AppReader={config:async()=>({}),close:async()=>{},call:async(_p,name)=>name.endsWith("whoami")?{whoami:{email:"designer@example.test"}}:{content:[{type:"text",text}]}};
  const c=new NativeEvidenceConnector(reader),signal=new AbortController().signal;
  const before=await c.discover(source,null,signal);text="Changed design";const after=await c.discover(source,null,signal);
  expect(after.revision).not.toBe(before.revision);expect(after.missing).toEqual(["현재 Figma 읽기 도구는 댓글을 제공하지 않습니다."]);
});

it("resumes a forced multi-slice refresh instead of declaring its previous fresh cache complete",async()=>{
  const {db,root}=fixture();let rows=1;
  const reader:AppReader={config:async()=>({googleDriveLinkId:"link_work"}),close:async()=>{},call:async(_p,name)=>name.endsWith("metadata")
    ?{sheets:[{properties:{sheetId:1,title:"Tab",gridProperties:{rowCount:rows,columnCount:100}}}]}
    :name.endsWith("cells")?{sheets:[{properties:{sheetId:1},data:[]}]}:{comments:[]}};
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");}},()=>{},undefined,new NativeEvidenceConnector(reader));
  try {
    await service.collect(root.id);const before=db.evidence.get(root.sourceId).contentHash;
    rows=2100;await service.collect(root.id,true);
    expect(db.evidence.catalog.members(root.id)[0].progress).toBe("reading");expect(db.evidence.get(root.sourceId).contentHash).toBe(before);
    await service.collect(root.id);
    expect(db.evidence.snapshot(root.sourceId)?.units.find(u=>u.id==="workbook")?.content).toContain('"rowCount":2100');
    expect(db.evidence.catalog.members(root.id)[0].progress).toBe("complete");
  }finally{await service.stop();}
});

it("reads Slack thread parents and replies through the final no-more-messages page",async()=>{
  const {db,topic}=fixture();const source=db.evidence.register(topic.id,{url:"https://team.slack.com/archives/C123/p1789709010013729",label:"Thread",mode:"connector",intervalSeconds:900});
  const reader:AppReader={config:async()=>({}),close:async()=>{},call:async(_p,name)=>name.endsWith("profile")?{result:"User ID: U123\n"}:{messages:
    "=== THREAD PARENT MESSAGE ===\nFrom: Owner\nMessage TS: 123.456\nOriginal\n=== THREAD REPLIES (1 total) ===\n--- Reply 1 of 1 ---\nFrom: Reviewer\nMessage TS: 124.456\nDecision",pagination_info:"There are no more messages in this thread.\n"}};
  const page=await new NativeEvidenceConnector(reader).discover(source,null,new AbortController().signal);
  expect(page.cursor).toBeNull();expect(page.units.map(unit=>unit.id)).toEqual(["123.456","124.456"]);expect(page.units[1].content).toContain("Decision");
});
it("reuses explicit child discovery when another approved root shares a collected source",async()=>{
  const {db,topic}=fixture();db.createTopic({...topic,id:"other",slug:"other"});
  const input={url:"https://team.atlassian.net/wiki/spaces/TEAM/pages/123",label:"Pages",mode:"connector" as const,scope:"topic" as const,required:true,intervalSeconds:900};
  const first=db.evidence.catalog.add(topic.id,input,true),second=db.evidence.catalog.add("other",input,true);
  const child="https://team.atlassian.net/wiki/spaces/TEAM/pages/456";
  const discover=vi.fn(async(source:any)=>({revision:"r1",cursor:null,connectionKey:"same-account",accountConfirmed:true,
    units:[{id:"body",kind:"document" as const,content:source.resource}],links:source.id===first.sourceId?[{url:child,label:"Child",unitId:"body",relation:"child" as const}]:[]}));
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");}},()=>{},undefined,{configured:()=>true,fetch:async()=>{throw Error("unused");},discover});
  try{await service.poll();expect(discover.mock.calls.filter(([source])=>source.id===first.sourceId)).toHaveLength(1);
    expect(db.evidence.catalog.state("other").entries.filter(e=>e.rootId===second.id).map(e=>e.source.url)).toContain(child);
    expect(db.evidence.catalog.state("other").coverage.ready).toBe(true);
  }finally{await service.stop();}
});
it("restores an unstarted superseded change and records removed sources as changes",()=>{
  const {db,topic,root}=fixture();
  const ingest=(text:string)=>{const check=db.evidence.begin(root.sourceId,true)!;db.evidence.ingest(root.sourceId,{checkId:check.checkId,revision:text,units:[{id:"policy",kind:"cells",content:text}]});};
  const observe=()=>db.evidence.automation.observe(topic,db.evidence.list(topic.id),db.evidence.topic(topic).digest);
  ingest("A");observe();ingest("B");const b=observe()!;ingest("C");observe();ingest("B");
  expect(observe()).toMatchObject({id:b.id,status:"pending"});
  const removed=db.evidence.automation.observe(topic,[],"d".repeat(64));expect(removed?.changes).toEqual([{sourceId:root.sourceId,before:b.changes[0].before,after:null}]);
});
it("does not fail the main workflow when an automatic review is interrupted by restart",()=>{
  const {db,topic}=fixture();db.updateTopic(topic.id,{state:"CODEX_AUDIT"});db.startAction({id:"auto",topicId:topic.id,kind:"evidence-assessment",status:"running",createdAt:new Date().toISOString(),finishedAt:null,error:null,pid:null,pgid:null,processExecutable:null,processCommand:null,processStartedAt:null});
  db.recoverInterruptedActions();expect(db.getTopic(topic.id).state).toBe("CODEX_AUDIT");expect(db.getAction("auto")?.status).toBe("cancelled");
});
it("rejects Jira snapshots if the issue changes while comments and links are being read",async()=>{
  const {db,topic}=fixture();const source=db.evidence.register(topic.id,{url:"https://team.atlassian.net/browse/APP-1",label:"Jira",mode:"connector",intervalSeconds:900});
  const reader:AppReader={config:async()=>({}),close:async()=>{},call:async(_p,name,args)=>{
    if(name.endsWith("atlassianUserInfo"))return {accountId:"owner"};
    if(name.endsWith("getJiraIssue"))return {key:"APP-1",fields:{updated:args.fields?"changed":"original",description:"Policy"}};
    if(name.endsWith("searchJiraIssuesUsingJql"))return {issues:[],isLast:true};
    if(args.name==="listJiraIssueComments")return {comments:[],startAt:0,total:0};return [];
  }};
  const connector=new NativeEvidenceConnector(reader),signal=new AbortController().signal;
  let page=await connector.discover(source,null,signal);page=await connector.discover(source,page.cursor,signal);page=await connector.discover(source,page.cursor,signal);
  await expect(connector.discover(source,page.cursor,signal)).rejects.toMatchObject({restart:true});expect(db.evidence.snapshot(source.id)).toBeNull();
});
it("splits astral Unicode text according to the persisted unit length contract",async()=>{
  const {db,topic}=fixture();const source=db.evidence.register(topic.id,{url:"https://team.slack.com/archives/C123",label:"Slack",mode:"connector",intervalSeconds:900});
  const reader:AppReader={config:async()=>({}),close:async()=>{},call:async(_p,name)=>name.endsWith("profile")?{id:"owner"}:{messages:`=== Message from Owner ===\nMessage TS: 123.456\n${"😀".repeat(85000)}`,pagination_info:""}};
  const page=await new NativeEvidenceConnector(reader).discover(source,null,new AbortController().signal);const check=db.evidence.begin(source.id,true)!;
  expect(()=>db.evidence.ingest(source.id,{checkId:check.checkId,revision:page.revision,units:page.units},true)).not.toThrow();
  expect(db.evidence.snapshot(source.id)?.units.every(u=>u.content.length<=160000 && !u.content.includes("�"))).toBe(true);
});

it("ignores Confluence view counts while preserving page edits",async()=>{
  const {db,topic}=fixture();const source=db.evidence.register(topic.id,{url:"https://team.atlassian.net/wiki/pages/123",label:"Page",mode:"connector",intervalSeconds:900});
  let totalViews=1,body="Policy";
  const reader:AppReader={config:async()=>({}),close:async()=>{},call:async(_p,name)=>name.endsWith("atlassianUserInfo")?{accountId:"owner"}:{id:"123",body:{html:body},metadata:{totalViews,version:1}}};
  const connector=new NativeEvidenceConnector(reader),signal=new AbortController().signal;
  const first=await connector.discover(source,null,signal);totalViews++;
  expect((await connector.discover(source,null,signal)).revision).toBe(first.revision);
  body="Changed policy";expect((await connector.discover(source,null,signal)).revision).not.toBe(first.revision);
});

it("discovers complete URLs before splitting long MCP text",async()=>{
  const {db,topic}=fixture();const source=db.evidence.register(topic.id,{url:"https://www.figma.com/design/test?node-id=1-2",label:"Design",mode:"connector",intervalSeconds:900});
  const url="https://team.atlassian.net/browse/APP-123";
  const body="a".repeat(59980)+url+" "+"b".repeat(100000);
  const reader:AppReader={config:async()=>({}),close:async()=>{},call:async(_p,name)=>name.endsWith("whoami")?{whoami:{email:"owner@example.test"}}:{content:[{type:"text",text:body}]}};
  const page=await new NativeEvidenceConnector(reader).discover(source,null,new AbortController().signal);
  expect(page.units.length).toBeGreaterThan(1);expect(page.links.map(link=>link.url)).toEqual([url]);
});

function collectionLatch<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
it("manual and background reads overlap unrelated providers while source requests share one collection", async () => {
  const {db,topic,root}=fixture(), held=collectionLatch<void>(), sheetStarted=collectionLatch<void>(), slackStarted=collectionLatch<void>();
  const slack=db.evidence.catalog.add(topic.id,{url:"https://team.slack.com/archives/C123/p1234567890123456",label:"Slack",mode:"connector",scope:"topic",required:true,intervalSeconds:900},true);
  const calls=vi.fn(async(source)=> {
    if(source.provider==="sheets") { sheetStarted.resolve(); await held.promise; }
    else slackStarted.resolve();
    return {units:[{id:"body",kind:"document" as const,content:"policy"}],links:[],cursor:null,revision:"v1"};
  });
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");}},()=>{},undefined,{fetch:async()=>{throw Error("unused");},discover:calls});
  const manual=service.collect(root.id), duplicate=service.collect(root.id);
  try {
    expect(duplicate).toBe(manual); await sheetStarted.promise;
    const poll=service.poll(); await slackStarted.promise;
    expect(calls).toHaveBeenCalledTimes(2);
    held.resolve(); await Promise.all([manual,poll]);
    expect(db.evidence.snapshot(root.sourceId)?.units[0].content).toBe("policy");
  } finally {held.resolve(); await service.stop();}
});
it("a cancelled late page preserves the previous snapshot and never notifies model work", async()=>{
  const {db,root}=fixture(), started=collectionLatch<void>(), held=collectionLatch<void>();
  const check=db.evidence.begin(root.sourceId,true)!;
  db.evidence.ingest(root.sourceId,{checkId:check.checkId,revision:"old",units:[{id:"body",kind:"document",content:"old"}]});
  const hash=db.evidence.get(root.sourceId).contentHash, changed=vi.fn();
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");}},changed,undefined,{fetch:async()=>{throw Error("unused");},discover:async()=>{
    started.resolve(); await held.promise;
    return {units:[{id:"body",kind:"document",content:"new"}],links:[],cursor:null,revision:"new"};
  }});
  const collect=service.collect(root.id,true);
  await started.promise; const stopped=service.stop(); held.resolve(); await Promise.all([collect,stopped]);
  expect(db.evidence.get(root.sourceId).contentHash).toBe(hash); expect(changed).not.toHaveBeenCalled();
  expect(db.evidence.catalog.members(root.id)[0].progress).not.toBe("complete");
});
it("rejects binding changes during a pending final page and retains the completed old snapshot",async()=>{
  const {db,root}=fixture(); let link="link_work", pending=false;
  const started=collectionLatch<void>(), held=collectionLatch<void>();
  const reader:AppReader={config:async()=>({googleDriveLinkId:link}),close:async()=>{},call:async(_p,name)=>{
    if(name.endsWith("metadata")) return {sheets:[{properties:{sheetId:1,title:"Policy",gridProperties:{rowCount:1,columnCount:1}}}]};
    if(name.endsWith("cells")) return {sheets:[{properties:{sheetId:1},data:[]}]};
    if(pending){started.resolve();await held.promise;}
    return {comments:[{id:"c",content:pending?"new":"old"}]};
  }};
  const changed=vi.fn(), service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");}},changed,undefined,new NativeEvidenceConnector(reader));
  try {
    await service.collect(root.id); const hash=db.evidence.get(root.sourceId).contentHash;
    pending=true; const collect=service.collect(root.id,true);await started.promise;link="link_other";held.resolve();await collect;
    expect(db.evidence.get(root.sourceId).contentHash).toBe(hash);expect(changed).toHaveBeenCalledTimes(1);
    expect(db.evidence.get(root.sourceId).collection?.status).toBe("error");
  }finally{held.resolve();await service.stop();}
});
