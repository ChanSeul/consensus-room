import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { EvidenceService } from "../src/server/evidence/service";
import { collectPage, publicAddress, discoverLinks } from "../src/server/evidence/discovery";
import { EvidenceFetchError } from "../src/server/evidence/connectors";
import type { EvidenceRootInput, EvidenceSource } from "../src/shared/externalEvidence";

// Public catalog selection -> actual gate, inherited sources and next-session binding.
// HTTP fixtures exercise pagination/comments/failure, never reproduce production calculations.
// New contracts have no prior implementation to restore. Live auth and rendered UI remain separate.
const cleanup: Array<() => void> = [];
it.each([false, true])("host recovery delivers current evidence after a collection failure (same body: %s)", async sameBody => {
  const {db}=fixture(), catalog=db.evidence.catalog;
  const root=catalog.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  let unavailable=false;
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw new Error("unused");},configured:()=>true,
    discover:async()=>{
      if (unavailable) throw new Error("Official app unavailable");
      return {units:[{id:"body",kind:"issue" as const,content:"Current policy"}],links:[],cursor:null,revision:"v1"};
    }});
  const capture=(missing:string[]=[])=>{
    const source=db.evidence.get(root.sourceId);
    return service.importHost("a",{version:catalog.version("a"),rootId:root.id,sourceId:source.id,
      previousHash:source.contentHash,previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"v2",
      units:[{id:"body",kind:"issue",content:sameBody?"Current policy":"Updated policy"}],missing});
  };
  try {
    await service.collect(root.id,true);
    unavailable=true;
    await service.collect(root.id,true);
    expect(db.evidence.usableSources(db.getTopic("a"))).toHaveLength(0);
    const first=capture();
    expect(first.collection).toMatchObject({status:sameBody?"unchanged":"collected",checkedAt:first.checkedAt});
    expect(db.evidence.usableSources(db.getTopic("a")).map(s=>s.id)).toEqual([root.sourceId]);
    capture(["comments unread"]);
    expect(db.evidence.usableSources(db.getTopic("a"))).toHaveLength(0);
    const recovered=capture();
    expect(recovered.collection).toMatchObject({status:"unchanged",checkedAt:recovered.checkedAt});
    expect(recovered.collection?.error).toBeUndefined();
    expect(recovered.collection?.missing).toBeUndefined();
    expect(db.evidence.usableSources(db.getTopic("a")).map(s=>s.id)).toEqual([root.sourceId]);
    expect(db.evidence.topic(db.getTopic("a")).deferred).toEqual([]);
    expect((await service.prepareMediator(db,"a","recovered-session")).corpus).toMatchObject({sources:1,units:1});
  } finally {await service.stop();}
});
it("a complete host capture reaches the mediator without REST credentials; partial captures and stale reads do not", async () => {
  const {db}=fixture();
  const root=db.evidence.catalog.add("a",{...input("https://docs.google.com/spreadsheets/d/policy/edit"),scope:"group"},true);
  const fetch=vi.fn(async()=>{throw new Error("No provider credentials or model calls needed");});
  const service=new EvidenceService(db.evidence,{fetch});
  const capture=(missing:string[])=>{
    const source=db.evidence.get(root.sourceId);
    return {version:db.evidence.catalog.version("a"),rootId:root.id,sourceId:root.sourceId,previousHash:source.contentHash,
      previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"export-v1",units:[{id:"A1",kind:"cells" as const,content:"Owner policy"}],missing};
  };
  try {
    service.importHost("a",capture(["unread comments"]));
    await expect(service.prepareMediator(db,"a","host-session")).rejects.toThrow();
    service.importHost("a",capture([]));
    const before=db.evidence.get(root.sourceId).contentHash;
    const packet=await service.prepareMediator(db,"a","host-session");
    expect(packet.corpus).toMatchObject({sources:1,units:1});
    expect(db.evidence.catalog.state("a").coverage.ready).toBe(true);
    const frozen=db.evidence.topic(db.getTopic("closed")).digest;
    await service.poll();
    expect(fetch).not.toHaveBeenCalled();
    expect(db.evidence.get(root.sourceId).contentHash).toBe(before);
    expect(db.evidence.topic(db.getTopic("closed")).digest).toBe(frozen);
    const other=db.evidence.catalog.add("b",{...input("https://docs.google.com/spreadsheets/d/policy/edit"),scope:"group",mode:"connector"},true);
    service.importHost("b",{...capture([]),rootId:other.id,version:db.evidence.catalog.version("b")});
    service.importHost("a",capture(["comments became inaccessible"]));
    expect(db.evidence.catalog.state("b").coverage.ready).toBe(false);
    await expect(service.prepareMediator(db,"b","other-session")).rejects.toThrow();
    expect(db.evidence.snapshot(root.sourceId)?.units[0].content).toBe("Owner policy");
  } finally {await service.stop();}
});
afterEach(() => { cleanup.splice(0).forEach(f => f()); vi.useRealTimers(); });
it("partial host recovery cannot renew an unread sibling in another completed root", async () => {
  vi.useFakeTimers({toFake:["Date"]});
  const {db}=fixture(), c=db.evidence.catalog;
  const a=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const b=c.add("b",input("https://team.atlassian.net/browse/APP-1"),true);
  const child="https://team.atlassian.net/browse/APP-2";
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw new Error("Host only");}});
  const capture=(topic:string,rootId:string,url:string,missing:string[]=[])=>{
    const source=c.state(topic).entries.find(e=>e.rootId===rootId && e.source.url===url)!.source;
    return service.importHost(topic,{version:c.version(topic),rootId,sourceId:source.id,previousHash:source.contentHash,
      previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"browser",missing,
      units:[{id:"body",kind:"issue",content:url.endsWith("APP-1")?`Root ${child}`:"Sibling policy"}]});
  };
  try {
    capture("a",a.id,db.evidence.get(a.sourceId).url); capture("b",b.id,db.evidence.get(b.sourceId).url);
    const sibling=capture("a",a.id,child); capture("b",b.id,child);
    expect(c.state("b").coverage.ready).toBe(true);
    vi.setSystemTime(Date.now()+1_900_000);
    capture("a",a.id,db.evidence.get(a.sourceId).url,["comments missing"]);
    capture("b",b.id,db.evidence.get(b.sourceId).url);
    expect(c.state("b").coverage.ready).toBe(false);
    expect(db.evidence.fresh(db.evidence.get(sibling.id))).toBe(false);
    await expect(service.prepareMediator(db,"b","blocked")).rejects.toThrow();
    capture("b",b.id,child);
    expect((await service.prepareMediator(db,"b","recovered")).corpus).toMatchObject({sources:2,units:2});
  } finally {await service.stop();}
});
it.each([false,true])("REST collection preserves host roots and rejects stale captures (host REST credentials: %s)", async hostConfigured => {
  vi.useFakeTimers({toFake:["Date"]});
  const {db}=fixture(),c=db.evidence.catalog;
  const host=c.add("a",input("https://docs.google.com/spreadsheets/d/policy/edit"),true);
  const rest=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const discover=vi.fn(async()=>({units:[{id:"issue",kind:"issue" as const,content:"Root"}],
    links:[{url:db.evidence.get(host.sourceId).url,label:"Policy",unitId:"issue",relation:"link" as const}],cursor:null,revision:"rest-v1"}));
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw new Error("unused");},discover,configured:s=>s.provider==="jira" || hostConfigured});
  try {
    const source=service.importHost("a",{version:c.version("a"),rootId:host.id,sourceId:host.sourceId,previousHash:null,previousCheckedAt:null,
      observedAt:Date.now(),revision:"host-v1",units:[{id:"A1",kind:"cells",content:"Policy"}],missing:[]});
    await service.collect(rest.id);
    expect(c.state("a").coverage.ready).toBe(true);
    expect(db.evidence.get(host.sourceId)).toMatchObject({mode:"connector",checkedAt:source.checkedAt,contentHash:source.contentHash});
    expect(discover).toHaveBeenCalledTimes(1);
    vi.setSystemTime(Date.now()+1_900_000);
    await service.collect(rest.id,true);
    expect(c.state("a").coverage.ready).toBe(false);
    expect(db.evidence.get(host.sourceId)).toMatchObject({mode:"connector",checkedAt:source.checkedAt,contentHash:source.contentHash});
    expect(discover).toHaveBeenCalledTimes(2);
  } finally {await service.stop();}
});
it("resuming REST pagination replaces old pages and links with the complete host capture", async () => {
  // collect/importHost -> current catalog and collected units; a failed next page preserves the real cursor.
  // The mediator consumes this catalog. Browser rendering and live authentication are outside this test.
  const {db}=fixture(),c=db.evidence.catalog;
  const host=c.add("a",input("https://docs.google.com/spreadsheets/d/policy/edit"),true);
  const rest=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const removed="https://www.figma.com/design/old?node-id=1-2";
  const discover=vi.fn(async (source:EvidenceSource,cursor:string|null)=>{
    if (source.id===rest.sourceId) return {units:[{id:"issue",kind:"issue" as const,content:"Root"}],
      links:[{url:db.evidence.get(host.sourceId).url,label:"Policy",unitId:"issue",relation:"link" as const}],cursor:null,revision:"r1"};
    if (cursor) throw new EvidenceFetchError("Next page unavailable");
    return {units:[{id:"old",kind:"cells" as const,content:removed}],
      links:[{url:removed,label:"Old design",unitId:"old",relation:"link" as const}],cursor:"page-2",revision:"s1"};
  });
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw new Error("unused");},discover,configured:()=>true});
  try {
    await service.collect(rest.id);
    expect(c.next(rest.id)).toMatchObject({source:{id:host.sourceId},cursor:"page-2"});
    service.importHost("a",{version:c.version("a"),rootId:host.id,sourceId:host.sourceId,previousHash:null,previousCheckedAt:null,
      observedAt:Date.now(),revision:"host-v2",units:[{id:"current",kind:"cells",content:"Current policy without the old design"}],missing:[]});
    const calls=discover.mock.calls.length;
    await service.collect(rest.id);
    expect(c.state("a").entries.some(e=>e.source.url===removed)).toBe(false);
    expect(c.collected(rest.id,host.sourceId).units.map(u=>u.id)).toEqual(["current"]);
    expect(c.state("a").coverage.ready).toBe(true);
    expect(discover).toHaveBeenCalledTimes(calls);
  } finally {await service.stop();}
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(),"catalog-")); const db = new ConsensusDatabase(join(path,"db"));
  cleanup.push(() => { db.close(); rmSync(path,{recursive:true,force:true}); });
  const topic = (id: string) => db.createTopic({ id, slug:id, title:id, repositoryPath:path, worktreePath:path,
    baseRef:"main", branchName:null, state:"DRAFT", scopeGeneration:1, planRevision:0, planSHA256:null,
    approvedPlanSHA256:null, createdAt:new Date().toISOString(), updatedAt:new Date().toISOString(), lastError:null });
  topic("a"); topic("b"); topic("closed");
  const budget = { mode: "observe" as const };
  for (const id of ["a","b"]) {
    db.workGroups.create(`g-${id}`,{ title:id, goal:id, contracts:"separate roots", stages:[
      {id:"first",kind:"work",title:"first",goal:"first",acceptance:"verified",dependsOn:[],budget},
      {id:"closed",kind:"work",title:"closed",goal:"closed",acceptance:"verified",dependsOn:[],budget},
      {id:"later",kind:"integration",title:"later",goal:"later",acceptance:"verified",dependsOn:["first","closed"],budget},
    ]},path,"a".repeat(40));
    db.workGroups.link(`g-${id}`,"first",id,"a".repeat(40));
  }
  db.workGroups.link("g-a","closed","closed","a".repeat(40)); db.updateTopic("closed",{state:"CLOSED"});
  return {db,topic};
}
const input = (url: string, scope: EvidenceRootInput["scope"] = "group"): EvidenceRootInput => ({url,label:url,scope,required:true,mode:"rest",intervalSeconds:900});
it("a scoped stage preserves expired selected originals while its mediator still requires freshness", async () => {
  // Group revision/link -> catalog -> actual mediator packet/readiness. Restore the old inheritance to see RED.
  // Live OAuth and Figma pixels are not proved by these captured source fixtures.
  vi.useFakeTimers({toFake:["Date"]});
  const {db,topic}=fixture(),c=db.evidence.catalog;
  const selected=["1-2","3-4"].map(node=>c.add("a",input(`https://www.figma.com/design/form?node-id=${node}`),true));
  const unrelated=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  c.add("a",input("https://team.slack.com/archives/C123","workspace"),true);
  const group=db.workGroups.get("g-a");
  db.workGroups.revise(group.id,{title:group.title,goal:group.goal,contracts:group.contracts,stages:group.stages.map(stage=>stage.id==="later"
    ? {...stage,evidenceRootIds:selected.map(root=>root.id)} : stage)},group.version);
  topic("ui"); db.workGroups.link(group.id,"later","ui","a".repeat(40));
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host captures only");}});
  const capture=(root:typeof unrelated,missing:string[]=[])=>{
    const source=db.evidence.get(root.sourceId);
    return service.importHost("a",{version:c.version("a"),rootId:root.id,sourceId:source.id,previousHash:source.contentHash,
      previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"captured-v1",missing,
      units:[{id:"body",kind:source.provider==="figma"?"design":"issue",content:source.url}]});
  };
  try {
    selected.forEach(root=>capture(root)); capture(unrelated,["unread comments"]);
    expect(db.evidence.list("ui").map(source=>source.id).sort()).toEqual(selected.map(root=>root.sourceId).sort());
    expect(c.state("a").coverage.ready).toBe(false);
    expect(await service.prepareMediator(db,"ui","scoped-session")).toMatchObject({corpus:{sources:2}});
    const binding=db.getTopic("ui"),digest=db.evidence.topic(binding).digest;
    c.add("a",input("https://team.atlassian.net/browse/APP-2"),true);
    expect(db.getTopic("ui").planEpoch).toBe(binding.planEpoch);
    expect(db.evidence.topic(db.getTopic("ui")).digest).toBe(digest);
    capture(selected[0],["selected node contents unread"]);
    expect(db.evidence.topic(db.getTopic("ui"))).toMatchObject({ ready: true,
      deferred: [expect.objectContaining({ sourceId: selected[0].sourceId })] });
    await expect(service.prepareMediator(db,"ui","failed-session")).rejects.toThrow();
    capture(selected[0]);
    expect(db.evidence.topic(db.getTopic("ui")).ready).toBe(true);
    vi.setSystemTime(Date.now()+1_900_000);
    expect(db.evidence.topic(db.getTopic("ui"))).toMatchObject({ ready: true });
    expect(db.evidence.usableSources(db.getTopic("ui")).map(source=>source.id).sort()).toEqual(selected.map(root=>root.sourceId).sort());
    await expect(service.prepareMediator(db,"ui","expired-session")).rejects.toThrow();
    expect(db.evidence.usableSources(db.getTopic("ui")).map(source=>source.id).sort()).toEqual(selected.map(root=>root.sourceId).sort());
    expect(db.evidence.get(selected[0].sourceId).collection?.status).not.toBe("error");
  } finally {await service.stop();}
});
it.each(["missing","proposed","removed"])("a stage cannot treat a %s selected root as an empty successful corpus", state => {
  const {db,topic}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input("https://www.figma.com/design/form?node-id=1-2"));
  if (state==="removed") c.select("a",{version:c.version("a"),rootId:root.id,action:"remove"});
  const group=db.workGroups.get("g-a"),rootId=state==="missing"?"ffffffff-ffff-4fff-8fff-ffffffffffff":root.id;
  db.workGroups.revise(group.id,{title:group.title,goal:group.goal,contracts:group.contracts,stages:group.stages.map(stage=>stage.id==="later"
    ? {...stage,evidenceRootIds:[rootId]} : stage)},group.version);
  topic("ui"); db.workGroups.link(group.id,"later","ui","a".repeat(40));
  expect(db.evidence.topic(db.getTopic("ui")).ready).toBe(false);
});
it("does not require unsupported links found in an original, while a selected original's missing comments still block collection", async () => {
  // Host import -> catalog/host plan -> mediator. Incidental URLs are not selected evidence.
  // The original body retains these references; an incomplete approved source still blocks its consumers.
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const content=["Policy body", "https://team.atlassian.net/jira/people/team/team-id",
    "https://cityplan.example.com:442/popup_request.asp", "https://www.figma.com/make/prototype/"].join("\n");
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host captures only");}});
  const capture=(missing:string[]=[])=>{
    const source=db.evidence.get(root.sourceId);
    return service.importHost("a",{version:c.version("a"),rootId:root.id,sourceId:source.id,previousHash:source.contentHash,
      previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"host",missing,units:[{id:"body",kind:"issue",content}]});
  };
  try {
    capture();
    expect(c.state("a").coverage).toMatchObject({sources:1,failed:0,candidates:0,ready:true});
    expect(c.state("a").unresolvedLinks ?? []).toEqual([]);
    expect(service.hostPlan("a").requests).toEqual([]);
    expect(db.evidence.snapshot(root.sourceId)?.units[0].content).toBe(content);
    expect((await service.prepareMediator(db,"a","incidental-links")).corpus).toMatchObject({sources:1,units:1});
    capture(["Comments unavailable"]);
    expect(c.state("a").coverage).toMatchObject({failed:1,ready:false});
    expect(service.hostPlan("a").requests.map(read=>read.sourceId)).toEqual([root.sourceId]);
    await expect(service.prepareMediator(db,"a","missing-selected-comments")).rejects.toThrow();
    capture();
    expect(c.state("a").coverage.ready).toBe(true);
  } finally {await service.stop();}
});
it("uses only task-linked notification threads from a workspace channel in the catalog and mediator corpus", async () => {
  // Public host imports -> task source list/catalog -> mediator input. Exact Jira links distinguish APP-1 from APP-10.
  const {db}=fixture(),c=db.evidence.catalog;
  const a=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const b=c.add("b",input("https://team.atlassian.net/browse/APP-2"),true);
  const channel=c.add("a",input("https://team.slack.com/archives/D01","workspace"),true);
  const threads=["1790000000000001","1790000000000002","1790000000000003","1790000000000004"]
    .map(ts=>`https://team.slack.com/archives/D01/p${ts}`);
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host captures only");}});
  const capture=(topic:string,rootId:string,url:string,content:string,missing:string[]=[])=>{
    const source=c.state(topic).entries.find(e=>e.rootId===rootId && e.source.url===url)?.source
      ?? db.evidence.list().find(s=>s.url===url)!;
    return service.importHost(topic,{version:c.version(topic),rootId,sourceId:source.id,previousHash:source.contentHash,
      previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"host",missing,units:[{id:"body",kind:"message",content}]});
  };
  try {
    capture("a",a.id,db.evidence.get(a.sourceId).url,"Task A policy");
    capture("b",b.id,db.evidence.get(b.sourceId).url,"Task B policy");
    expect(service.hostPlan("a").requests.map(r => r.sourceId)).toContain(channel.sourceId);
    capture("a",channel.id,db.evidence.get(channel.sourceId).url,threads.join("\n"));
    expect(service.hostPlan("a").requests.map(r => r.url)).toEqual(expect.arrayContaining(threads));
    const bodies=["https://team.atlassian.net/browse/APP-1","https://team.atlassian.net/browse/APP-2",
      "https://team.atlassian.net/browse/APP-10","Unrelated notification"];
    threads.forEach((url,i)=>capture("a",channel.id,url,bodies[i]));
    expect(db.evidence.list("a").map(s=>s.url).sort()).toEqual([db.evidence.get(a.sourceId).url,threads[0]].sort());
    expect(db.evidence.list("b").map(s=>s.url).sort()).toEqual([db.evidence.get(b.sourceId).url,threads[1]].sort());
    expect(c.state("a").entries.filter(e=>e.rootId===channel.id).map(e=>e.source.url)).toEqual([threads[0]]);
    expect(c.state("a").coverage.ready).toBe(true);
    expect((await service.prepareMediator(db,"a","scoped-notifications")).corpus).toMatchObject({sources:2,units:2});
    capture("a",channel.id,threads[0],bodies[0],["Thread replies unavailable"]);
    expect(c.state("a").coverage.ready).toBe(false);
    await expect(service.prepareMediator(db,"a","unread-notifications")).rejects.toThrow();
    capture("a",channel.id,threads[0],bodies[0]);
    expect(c.state("a").coverage.ready).toBe(false);
    capture("a",channel.id,db.evidence.get(channel.sourceId).url,threads.join("\n"));
    threads.slice(1).forEach((url,i)=>capture("a",channel.id,url,bodies[i+1]));
    expect(c.state("a").coverage.ready).toBe(true);
    c.select("a",{version:c.version("a"),rootId:a.id,action:"remove"});
    expect(db.evidence.list("a")).toEqual([]);
  } finally {await service.stop();}
});
it("keeps the next unread source reachable after the preceding host page is imported", async () => {
  // host-plan -> host-import -> cursor resume is the host collector's public contract.
  // Restoring the old offset would skip the remaining independent root; no model or live auth is used.
  const {db}=fixture(),c=db.evidence.catalog;
  for (const key of ["APP-1","APP-2"]) c.add("a",{...input(`https://team.atlassian.net/browse/${key}`),mode:"connector"},true);
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host only");}});
  try {
    const first=service.hostPlan("a",undefined,1),read=first.requests[0];
    expect(first.nextCursor).not.toBeNull();
    service.importHost("a",{version:first.version,rootId:read.rootId,sourceId:read.sourceId,previousHash:null,
      previousCheckedAt:null,observedAt:Date.now(),revision:"host",units:[{id:"body",kind:"issue",content:"Root body"}],missing:[]});
    const next=service.hostPlan("a",first.nextCursor!,1);
    expect(next.requests).toHaveLength(1); expect(next.requests[0].sourceId).not.toBe(read.sourceId);
    expect(next.nextCursor).toBeNull();
  } finally {await service.stop();}
});
it("changes the host list version when an import discovers an approved child before its cursor", async () => {
  // The host compares the import/list version and restarts metadata paging when discovery changes the work list.
  const {db}=fixture(),c=db.evidence.catalog;
  for (const key of ["APP-1","APP-2"]) c.add("a",{...input(`https://team.atlassian.net/browse/${key}`),mode:"connector"},true);
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host only");}});
  try {
    const first=service.hostPlan("a",undefined,1),read=first.requests[0];
    const child=Array.from({length:100},(_,n)=>db.evidence.ensureSource({
      url:`https://team.atlassian.net/browse/APP-${n+3}`,label:"Child",mode:"connector",intervalSeconds:900},true)).find(source=>source.id<read.sourceId)!;
    expect(child).toBeDefined();
    service.importHost("a",{version:first.version,rootId:read.rootId,sourceId:read.sourceId,previousHash:null,
      previousCheckedAt:null,observedAt:Date.now(),revision:"host",units:[{id:"body",kind:"issue",content:`Child: ${child.url}`}],missing:[]});
    const resumed=service.hostPlan("a",first.nextCursor!,1);
    expect(resumed.version).not.toBe(first.version);
    const restarted=service.hostPlan("a",undefined,1);
    expect(restarted.requests[0].sourceId).toBe(child.id);
    service.importHost("a",{version:restarted.version,rootId:read.rootId,sourceId:child.id,previousHash:null,
      previousCheckedAt:null,observedAt:Date.now(),revision:"child",units:[{id:"body",kind:"issue",content:"Child body"}],missing:[]});
    expect(service.hostPlan("a").requests.map(request=>request.sourceId)).not.toContain(child.id);
    expect(service.hostPlan("a").version).toBe(restarted.version);
  } finally {await service.stop();}
});
it("app read plans contain only approved metadata and imports remain incomplete when comments are missing", async () => {
  const {db} = fixture(), c = db.evidence.catalog;
  const root = c.add("a",{...input("https://team.atlassian.net/browse/APP-1"),mode:"connector"},true);
  c.add("a",{...input("https://www.figma.com/design/design?node-id=1-2"),mode:"connector"},false);
  const fetch = vi.fn(async()=>{throw new Error("Existing app connection owns reads");});
  const service = new EvidenceService(db.evidence,{fetch,configured:()=>false});
  try {
    const plan = service.hostPlan("a");
    expect(plan.total).toBe(1); expect(plan.pendingReview).toBe(1);
    expect(plan.requests[0]).toMatchObject({rootId:root.id,provider:"jira",integration:"Atlassian Rovo",previousHash:null});
    expect(JSON.stringify(plan)).not.toContain("content\"");
    const source=service.importHost("a",{version:plan.version,rootId:root.id,sourceId:root.sourceId,
      previousHash:null,previousCheckedAt:null,observedAt:Date.now(),revision:"native-app",
      units:[{id:"issue",kind:"issue",content:"Actual issue body"}],missing:["comments unavailable"]});
    expect(c.state("a").coverage.ready).toBe(false); expect(service.hostPlan("a").total).toBe(1);
    expect(db.evidence.snapshot(source.id)?.units[0].content).toBe("Actual issue body");
    expect(fetch).not.toHaveBeenCalled();
  } finally {await service.stop();}
});
it("connector collection reuses a fresh shared capture without reading the same source again", async () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",{...input("https://team.atlassian.net/browse/APP-1"),mode:"connector"},true);
  const shared=c.add("a",{...input("https://team.atlassian.net/browse/APP-1","topic"),mode:"connector"},true);
  const service=new EvidenceService(db.evidence,{fetch:vi.fn(async()=>{throw Error("No reread");})});
  try {
    service.importHost("a",{version:c.version("a"),rootId:root.id,sourceId:root.sourceId,previousHash:null,previousCheckedAt:null,
      observedAt:Date.now(),revision:"app",units:[{id:"issue",kind:"issue",content:"Shared actual body"}],missing:[]});
    expect(service.hostPlan("a").total).toBe(1);
    await service.collect(shared.id);
    expect(c.state("a").coverage.ready).toBe(true); expect(service.hostPlan("a").total).toBe(0);
  } finally {await service.stop();}
});
it("Jira roots belong to separate groups, inherit into new stages, and only explicit workspace documents are shared", () => {
  const {db,topic} = fixture(); const catalog = db.evidence.catalog;
  catalog.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  catalog.add("b",input("https://team.atlassian.net/browse/APP-2"),true);
  catalog.add("a",input("https://api.example.com/openapi.json","workspace"),true);
  topic("next"); db.workGroups.link("g-a","later","next","a".repeat(40));
  expect(db.evidence.list("next").map(s=>s.url)).toEqual(expect.arrayContaining(["https://team.atlassian.net/browse/APP-1","https://api.example.com/openapi.json"]));
  expect(db.evidence.list("next").map(s=>s.url)).not.toContain("https://team.atlassian.net/browse/APP-2");
  expect(()=>catalog.add("a",input("https://team.atlassian.net/browse/APP-3","workspace"),true)).toThrow("작업 그룹");
  expect(db.getTopic("closed").state).toBe("CLOSED");
});
it("approval is versioned, removal starts fresh sessions and preserves snapshots and closed plans", () => {
  const {db} = fixture(); const c = db.evidence.catalog;
  const root = c.add("a",input("https://team.atlassian.net/browse/APP-1"));
  expect(db.evidence.list("a")).toHaveLength(0);
  expect(db.evidence.topic(db.getTopic("a")).ready).toBe(false);
  const version = c.version("a"); c.select("a",{version,rootId:root.id,action:"approve"});
  expect(()=>c.select("a",{version,rootId:root.id,action:"remove"})).toThrow("바뀌었습니다");
  const check = db.evidence.begin(root.sourceId,true)!;
  const snap = db.evidence.ingest(root.sourceId,{checkId:check.checkId,revision:"r",units:[{id:"body",kind:"issue",content:"historical"}]});
  db.upsertParticipant("a",{role:"claude",sessionId:"old-session",mode:"created",acknowledgedPlanSHA256:null});
  db.updateTopic("a",{planSHA256:"a".repeat(64),approvedPlanSHA256:"a".repeat(64),state:"AWAITING_USER_APPROVAL"});
  db.addArtifact("a",{kind:"plan",revision:1,scopeGeneration:1,sha256:"a".repeat(64),path:"/historical-plan",createdAt:new Date().toISOString()});
  expect(db.latestArtifact("a","plan")).not.toBeNull();
  const closed = db.getTopic("closed");
  c.select("a",{version:c.version("a"),rootId:root.id,action:"remove"});
  expect(db.evidence.list("a")).toHaveLength(0);
  expect(db.evidence.snapshot(root.sourceId,snap.contentHash!)!.units[0].content).toBe("historical");
  expect(db.getTopic("a").planSHA256).toBeNull();
  expect(db.latestArtifact("a","plan")).toBeNull();
  expect(db.artifactsForScope("a","plan")).toEqual([]);
  expect(db.latestArtifactRevision("a","plan")).toBe(1);
  db.addArtifact("a",{kind:"plan",revision:2,scopeGeneration:1,sha256:"b".repeat(64),path:"/current-plan",createdAt:new Date().toISOString()});
  expect(db.latestArtifact("a","plan")?.path).toBe("/current-plan");
  expect(db.getTopic("a").participants[0].sessionId).toMatch(/^pending:/);
  expect(db.getTopic("closed")).toEqual(closed);
  expect(c.state("a").history[0].action).toBe("앞으로 사용할 근거에서 해제");
});
it("a durable frontier collects more than 64 children and requires human approval of newly discovered external documents", async () => {
  const {db} = fixture(); const c = db.evidence.catalog;
  const root = c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const calls: string[] = [];
  const service = new EvidenceService(db.evidence,{ configured:()=>true, fetch:async()=>{throw Error("not used");}, discover:async(source,cursor)=>{
    calls.push(source.id+String(cursor));
    return {revision:"r",cursor:null,units:[{id:"body",kind:"issue",content:source.resource}],links:source.id===root.sourceId ? [
      ...Array.from({length:70},(_,n)=>({url:`https://team.atlassian.net/browse/APP-${n+2}`,label:`child ${n}`,unitId:"body",relation:"child" as const})),
      {url:"https://docs.google.com/spreadsheets/d/policy/edit",label:"Policy",unitId:"body",relation:"link"},
    ] : [{url:"https://team.atlassian.net/browse/APP-1",label:"cycle",unitId:"body",relation:"child"}]};
  }});
  await service.collect(root.id);
  expect(c.state("a").coverage.ready).toBe(false);
  for (let n=0;n<4;n++) await service.collect(root.id);
  expect(new Set(calls).size).toBe(71); expect(calls).toHaveLength(71);
  expect(db.evidence.list("a")).toHaveLength(71);
  const candidate = c.state("a").entries.find(e=>e.state==="candidate")!;
  expect(candidate.source.provider).toBe("sheets"); expect(c.state("a").coverage.ready).toBe(false);
  c.select("a",{version:c.version("a"),rootId:root.id,sourceId:candidate.source.id,action:"accept"});
  for (let n=0;n<5 && !c.state("a").coverage.ready;n++) await service.collect(root.id);
  expect(c.state("a").coverage.ready).toBe(true);
  const batch = await service.prepareMediator(db,"a","mediator-test");
  expect(batch.changes).toEqual([]); expect(batch.batchId).toBeNull();
  expect(batch.corpus).toMatchObject({sources:72});
  expect(Buffer.byteLength(JSON.stringify(batch))).toBeLessThan(2000);
  expect(db.evidence.packet(db.getTopic("a"),"claude").text).not.toContain("APP-2");
  await service.stop();
});
it.each([undefined, "11111111-1111-4111-8111-111111111111"])("Jira root traversal retains comments and descendants with cloud routing %s", async jiraCloudId => {
  const {db} = fixture(); const source = db.evidence.ensureSource({url:"https://team.atlassian.net/browse/APP-1",label:"Root",mode:"rest",intervalSeconds:900});
  let changed = false; const paths: string[] = [];
  const request = (async (raw: string) => {
    const url = new URL(raw); paths.push(raw);
    const data = url.pathname.endsWith("/comment") ? { startAt:0,total:1,comments:[{id:"1",body:{text:"Policy https://docs.google.com/spreadsheets/d/policy/edit"},author:{displayName:"Owner"},updated:"r1"}] }
      : url.pathname.endsWith("/search/jql") ? {isLast:true,issues:[{key:"APP-2",fields:{summary:"Child"}}]}
      : url.pathname.endsWith("/remotelink") ? [] : {fields:{summary:"Root",updated:changed ? "r2" : "r1"}};
    return Response.json(data);
  }) as typeof fetch;
  let cursor: string|null = null; const units: string[] = [], links: string[] = [];
  do { const page = await collectPage(source,cursor,{jiraCloudId},request,new AbortController().signal,async()=>({revision:"unused"}));
    units.push(...page.units.map(u=>u.id)); links.push(...page.links.map(l=>l.url)); cursor=page.cursor;
  } while(cursor);
  expect(paths.every(url => url.startsWith(jiraCloudId ? "https://api.atlassian.com/ex/jira/11111111-1111-4111-8111-111111111111/rest/api/3/" : "https://team.atlassian.net/rest/api/3/"))).toBe(true);
  expect(units).toContain("comment:1"); expect(links).toContain("https://team.atlassian.net/browse/APP-2");
  expect(links).toContain("https://docs.google.com/spreadsheets/d/policy/edit");
  changed=true;
  await expect(collectPage(source,JSON.stringify({stage:"remote",updated:"r1"}),{},request,new AbortController().signal,async()=>({revision:"unused"}))).rejects.toThrow("바뀌었습니다");
});
it("OpenAPI reads operations and reusable schemas without admitting private network targets", async () => {
  const {db}=fixture(); const source=db.evidence.ensureSource({url:"https://api.example.com/docs",label:"API",mode:"rest",intervalSeconds:900});
  const spec={openapi:"3.1.0",info:{title:"API"},paths:{"/houses":{servers:[{url:"https://regional.example.com"}],get:{responses:{"200":{description:"ok"}}}},"/alias":{$ref:"#/components/pathItems/Shared"}},components:{schemas:{House:{type:"object"}}}};
  const page=await collectPage(source,null,{},fetch,new AbortController().signal,async()=>({revision:"unused"}),async()=>`docs.apiDescriptionDocument = ${JSON.stringify(JSON.stringify(spec))};`);
  expect(page.units.filter(u=>u.id.startsWith("api:get:"))).toHaveLength(1);
  expect(page.units.some(u=>u.id.startsWith("path:") && u.content.includes('"$ref":"#/components/pathItems/Shared"'))).toBe(true);
  expect(page.units.find(u=>u.id.startsWith("api:get:"))!.content).toContain("https://regional.example.com");
  expect(page.units.filter(u=>u.id.startsWith("component:schemas:House"))).toHaveLength(1);
  for(const address of ["127.0.0.1","10.0.0.1","169.254.169.254","172.16.0.1","192.168.1.1","::1"]) expect(publicAddress(address)).toBe(false);
});
it("Sheets walks every tab and retains notes, linked cells, comments and replies; denied comments do not complete", async () => {
  const {db}=fixture(); const source=db.evidence.ensureSource({url:"https://docs.google.com/spreadsheets/d/policy/edit?gid=7",label:"Policy",mode:"rest",intervalSeconds:900});
  let deny = false; const ranges: string[]=[];
  const request=(async(raw:string)=>{
    const url=new URL(raw);
    if(url.pathname.endsWith("/comments")) return deny ? new Response("denied",{status:403}) : Response.json({comments:[{id:"c1",content:"Policy decision",replies:[{id:"r1",content:"Owner confirmation"}]}]});
    if(url.hostname==="www.googleapis.com") return Response.json({version:"1"});
    const range=url.searchParams.get("ranges");
    if(range){ ranges.push(range); return Response.json({sheets:[{data:[{rowData:[{values:[{formattedValue:"Value",note:"Must verify",hyperlink:"https://example.com/policy"}]}]}]}]}); }
    return Response.json({sheets:[{properties:{sheetId:7,title:"Policy",gridProperties:{rowCount:101,columnCount:2}}},{properties:{sheetId:8,title:"History",gridProperties:{rowCount:1,columnCount:1}}}]});
  }) as typeof fetch;
  let cursor:string|null=null; const contents:string[]=[];
  do { const page=await collectPage(source,cursor,{},request,new AbortController().signal,async()=>({revision:"unused"}));contents.push(...page.units.map(u=>u.content));cursor=page.cursor; }while(cursor);
  expect(ranges).toEqual(["'Policy'!A1:B100","'Policy'!A101:B101","'History'!A1:A1"]);
  expect(contents.join("\n")).toContain("Must verify"); expect(contents.join("\n")).toContain("Owner confirmation");
  deny=true;
  await expect(collectPage(source,JSON.stringify({stage:"comments",version:"1"}),{},request,new AbortController().signal,async()=>({revision:"unused"}))).rejects.toThrow("403");
});

it("committed and closed stages keep their evidence while new stages receive future roots", () => {
  const {db,topic}=fixture(),c=db.evidence.catalog;
  const initial=db.evidence.topic(db.getTopic('closed'));
  db.updateTopic('a',{state:'READY_TO_DELIVER',committedOID:'a'.repeat(40)});
  const committed=db.getTopic('a'),before=db.evidence.topic(committed);
  c.add('a',input('https://example.com/shared','workspace'),true);
  expect(db.getTopic('a')).toEqual(committed);
  expect(db.evidence.topic(db.getTopic('a'))).toEqual(before);
  expect(db.evidence.topic(db.getTopic('closed'))).toEqual(initial);
  topic('later');expect(db.evidence.list('later').map(s=>s.url)).toContain('https://example.com/shared');
});

it("replanning preserves finding ledgers and clears flags from the previous plan cycle", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  db.updateTopic('a',{fixPassUsed:true,secondFixPassUsed:true,closeoutRevisionUsed:true});
  for (const kind of ['implementation-notes','deferred-findings','plan']) db.addArtifact('a',{kind,revision:1,scopeGeneration:1,sha256:'a'.repeat(64),path:`/${kind}`,createdAt:new Date().toISOString()});
  c.add('a',input('https://example.com/source'),true);
  expect(db.latestArtifact('a','implementation-notes')?.path).toBe('/implementation-notes');
  expect(db.latestArtifact('a','deferred-findings')?.path).toBe('/deferred-findings');
  expect(db.latestArtifact('a','plan')).toBeNull();
  expect(db.getFlags('a')).toMatchObject({fixPassUsed:false,secondFixPassUsed:false,closeoutRevisionUsed:false});
});

it("transient failures retain the cursor, no-op collection preserves dates, and force starts a new cycle", async () => {
  const {db}=fixture(),c=db.evidence.catalog,root=c.add('a',input('https://example.com/source'),true);
  const calls:Array<string|null>=[];let fail=true;
  const service=new EvidenceService(db.evidence,{configured:()=>true,fetch:async()=>{throw Error('unused');},discover:async(_source,cursor)=>{
    calls.push(cursor);if(cursor && fail){fail=false;throw new EvidenceFetchError('HTTP 429',300);}
    return {revision:'1',units:[{id:cursor ?? 'first',kind:'document',content:cursor ?? 'first'}],links:[],cursor:cursor ? null : 'next'};
  }});
  await service.collect(root.id);expect(c.members(root.id)[0].cursor).toBe('next');
  await service.collect(root.id);expect(calls).toEqual([null,'next','next']);
  const complete=c.roots()[0];await service.collect(root.id);
  expect(c.roots()[0].lastCompleteAt).toBe(complete.lastCompleteAt);expect(c.roots()[0].nextCheckAt).toBe(complete.nextCheckAt);
  await service.collect(root.id,true);expect(calls.slice(-2)).toEqual([null,'next']);
});

it("a completed long scan remains consumable without rewriting individual read timestamps", async () => {
  vi.useFakeTimers();vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  const {db}=fixture(),c=db.evidence.catalog,root=c.add('a',input('https://team.atlassian.net/browse/APP-1'),true);
  const service=new EvidenceService(db.evidence,{configured:()=>true,fetch:async()=>{throw Error('unused');},discover:async(source)=>{
    vi.setSystemTime(Date.now()+60_000);
    return {revision:'1',cursor:null,units:[{id:'body',kind:'issue',content:source.resource}],links:source.id===root.sourceId ? Array.from({length:35},(_,n)=>({url:`https://team.atlassian.net/browse/APP-${n+2}`,label:'child',unitId:'body',relation:'child' as const})) : []};
  }});
  await service.collect(root.id);const firstRead=db.evidence.get(root.sourceId).checkedAt;
  for(let n=0;n<35;n++) await service.collect(root.id);expect(c.state('a').coverage.ready).toBe(true);
  const packet=await service.prepareMediator(db,'a','session');expect(packet.corpus?.sources).toBe(36);
  expect(db.evidence.get(root.sourceId).checkedAt).toBe(firstRead);
  await expect(service.prepareMediator(db,'a','session',1)).rejects.toThrow('최소');
});

it("source leases prevent concurrent fetches and older multi-page scans cannot overwrite a newer snapshot", async () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const a=c.add('a',input('https://example.com/shared'),true),b=c.add('b',input('https://example.com/shared'),true);
  let release!:()=>void;let calls=0;const pending=new Promise<void>(r=>release=r);
  const service=new EvidenceService(db.evidence,{configured:()=>true,fetch:async()=>{throw Error('unused');},discover:async()=>{
    calls++;await pending;return {revision:'new',cursor:null,links:[],units:[{id:'body',kind:'document',content:'new'}]};
  }});
  const first=service.collect(a.id),second=service.collect(b.id);
  try { expect(calls).toBe(1); } finally { release();await Promise.allSettled([first,second]); }
  const oldReader=new EvidenceService(db.evidence,{configured:()=>true,fetch:async()=>{throw Error('unused');},discover:async(_s,cursor)=>{
    const n=Number(cursor ?? '0');return {revision:'old',cursor:n<20 ? String(n+1):null,links:[],units:[{id:String(n),kind:'document',content:'old'}]};
  }});
  await oldReader.collect(a.id,true);
  await service.collect(b.id);const newer=db.evidence.get(a.sourceId).contentHash;
  await oldReader.collect(a.id);expect(db.evidence.get(a.sourceId).contentHash).toBe(newer);
  expect(c.members(a.id)[0]).toMatchObject({progress:'failed',cursor:null});
});

it("existing connector-mode children are reused by an authorized REST root", async () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const old=db.evidence.register('a',{url:'https://team.atlassian.net/browse/APP-2',label:'legacy',mode:'connector',intervalSeconds:900});db.evidence.detach('a',old.id);
  const root=c.add('a',input('https://team.atlassian.net/browse/APP-1'),true);
  const service=new EvidenceService(db.evidence,{configured:()=>true,fetch:async()=>{throw Error('unused');},discover:async(source)=>({revision:'1',cursor:null,units:[{id:'body',kind:'issue',content:source.resource}],links:source.id===root.sourceId ? [{url:old.url,label:'child',unitId:'body',relation:'child'}]:[]})});
  await service.collect(root.id);expect(c.state('a').coverage.ready).toBe(true);expect(db.evidence.get(old.id).mode).toBe('rest');
});

it("HTML links resolve relative references and do not include closing quotes", () => {
  const links=discoverLinks([{id:'page',kind:'document',content:`<a href='/policy'>Policy</a><a href="../faq">FAQ</a><a href='https://example.net/doc'>Doc</a>`}], 'https://example.com/docs/page');
  expect(links.map(l=>l.url)).toEqual(expect.arrayContaining(['https://example.com/policy','https://example.com/faq','https://example.net/doc']));
  expect(links.some(l=>l.url.includes("'"))).toBe(false);
});

it("Slack invalid_cursor responses restart while other HTTP 200 API failures preserve progress",async()=>{
  const {db}=fixture();const root=db.evidence.catalog.add("a",input("https://team.slack.com/archives/C123"),true);
  const source=db.evidence.get(root.sourceId);
  for (const error of ["invalid_cursor","ratelimited"]) {
    const request:typeof fetch=async()=>new Response(JSON.stringify({ok:false,error}),{status:200});
    await expect(collectPage(source,JSON.stringify({stage:"messages",next:"expired"}),{},request,new AbortController().signal,async()=>({revision:"unused"}))).rejects.toMatchObject({restart:error==="invalid_cursor"});
  }
});

it("새 루트의 승인 재사용은 선택된 기존 루트의 계획도 무효화한다", async () => {
  const {db,topic}=fixture(),c=db.evidence.catalog;
  const selected=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const group=db.workGroups.get("g-a");
  db.workGroups.revise(group.id,{title:group.title,goal:group.goal,contracts:group.contracts,stages:group.stages.map(stage=>stage.id==="later"
    ? {...stage,evidenceRootIds:[selected.id]} : stage)},group.version);
  topic("ui"); db.workGroups.link(group.id,"later","ui","a".repeat(40));
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("host only");}});
  const source=db.evidence.get(selected.sourceId);
  const url="https://docs.google.com/spreadsheets/d/new-policy/edit";
  try {
    service.importHost("a",{version:c.version("a"),rootId:selected.id,sourceId:source.id,previousHash:source.contentHash,
      previousCheckedAt:source.checkedAt,observedAt:Date.now(),revision:"r",missing:[],units:[{id:"body",kind:"issue",content:url}]});
    const candidate=c.state("ui").entries.find(e=>e.source.url===url)!;
    expect(candidate.state).toBe("candidate");
    db.updateTopic("ui",{state:"AWAITING_USER_APPROVAL",planSHA256:"f".repeat(64),approvedPlanSHA256:"f".repeat(64)});
    const before=db.getTopic("ui");
    expect(c.approvalAffected(candidate.source.id,"group","g-a")).toContain("ui");
    c.add("a",input(url),true);
    expect(c.state("ui").entries.find(e=>e.source.id===candidate.source.id)?.state).toBe("approved");
    expect(db.getTopic("ui").approvedPlanSHA256).toBeNull();
    expect(db.getTopic("ui").planEpoch).toBe(before.planEpoch+1);
  } finally {await service.stop();}
});
