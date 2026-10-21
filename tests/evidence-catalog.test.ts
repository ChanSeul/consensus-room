import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { EvidenceService, PARTIAL_NATIVE_PROVIDERS } from "../src/server/evidence/service";
import { NativeEvidenceConnector } from "../src/server/evidence/nativeConnector";
import type { AppReader } from "../src/server/evidence/nativeReader";
import { collectPage, publicAddress, discoverLinks } from "../src/server/evidence/discovery";
import { EvidenceFetchError } from "../src/server/evidence/connectors";
import type { EvidenceRootInput, EvidenceSource } from "../src/shared/externalEvidence";
import type { WorkerFact } from "../src/shared/turnContract";
import { AppCallTimeout } from "../src/server/adapters/nativeApps";

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
// 2026-10-19 PROJECT-456 follow-up: one Figma member the app reader could not read failed first in every collect call and the
// call returned, so the 24 originals after it were neither read nor discovered. A failed member now stays failed and keeps its root
// incomplete, while the same call reads the members after it and the links they lead to.
const issue = (n: number) => `https://team.atlassian.net/browse/APP-${n}`;
const progressByKey = (db: ConsensusDatabase, rootId: string) => Object.fromEntries(db.evidence.catalog.members(rootId)
  .map(m => [db.evidence.get(m.source_id).url.split("/").pop(), m.progress]));
it("a member that keeps failing no longer stops its root: later members and their links are read, and it stays failed until its retry", async () => {
  vi.useFakeTimers({toFake:["Date"]});
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  const links:Record<string,number[]>={"APP-1":[2,3,4],"APP-3":[5]};
  let unavailable=true; const reads:string[]=[];
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");},configured:()=>true,discover:async source=>{
    const key=source.url.split("/").pop()!; reads.push(key);
    if (key==="APP-2" && unavailable) throw new EvidenceFetchError("MCP 원문 조회 실패: figma.get_design_context.");
    return {revision:"1",cursor:null,units:[{id:"body",kind:"issue" as const,content:key}],
      links:(links[key] ?? []).map(n=>({url:issue(n),label:`APP-${n}`,unitId:"body",relation:"link" as const}))};
  }});
  try {
    await service.collect(root.id);
    expect(progressByKey(db,root.id)).toEqual({"APP-1":"complete","APP-2":"failed","APP-3":"complete","APP-4":"complete","APP-5":"complete"});
    expect(c.state("a").coverage).toMatchObject({complete:4,failed:1,pending:0,ready:false});
    expect(c.roots().find(r=>r.id===root.id)).toMatchObject({lastCompleteAt:null,nextCheckAt:Date.now()+300_000});
    const sibling=c.members(root.id).find(m=>db.evidence.get(m.source_id).url.endsWith("/APP-3"))!;
    expect(db.evidence.fresh(db.evidence.get(sibling.source_id))).toBe(true);
    // An explicit collect retries only the remaining failed member, once per call. The automatic poll waits for the retry delay.
    await service.collect(root.id);
    expect(reads.filter(key=>key==="APP-2")).toHaveLength(2);
    expect(reads.filter(key=>key==="APP-3")).toHaveLength(1);
    expect(c.due().map(r=>r.id)).not.toContain(root.id);
    unavailable=false; vi.setSystemTime(Date.now()+300_001);
    expect(c.due().map(r=>r.id)).toContain(root.id);
    await service.poll();
    expect(progressByKey(db,root.id)["APP-2"]).toBe("complete");
    expect(c.roots().find(r=>r.id===root.id)!.lastCompleteAt).not.toBeNull();
    expect(c.state("a").coverage).toMatchObject({complete:5,failed:0,pending:0,ready:true});
  } finally {await service.stop();}
});
it("each failure in one collect call keeps its restart and the longest retry delay while the remaining members are read", async () => {
  vi.useFakeTimers({toFake:["Date"]});
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");},configured:()=>true,discover:async (source,cursor)=>{
    const key=source.url.split("/").pop()!;
    if (key==="APP-2" && cursor==="p2") throw new EvidenceFetchError("수집 중 Jira 원문이 바뀌었습니다. 처음부터 다시 확인합니다.",3600,true);
    if (key==="APP-3") throw new EvidenceFetchError("원문 조회 실패 (HTTP 503).");
    return {revision:"1",cursor:key==="APP-2" ? "p2" : null,units:[{id:`body-${cursor ?? 0}`,kind:"issue" as const,content:key}],
      links:key==="APP-1" ? [2,3,4].map(n=>({url:issue(n),label:`APP-${n}`,unitId:"body-0",relation:"link" as const})) : []};
  }});
  try {
    await service.collect(root.id);
    expect(progressByKey(db,root.id)).toEqual({"APP-1":"complete","APP-2":"failed","APP-3":"failed","APP-4":"complete"});
    expect(c.members(root.id).find(m=>db.evidence.get(m.source_id).url.endsWith("/APP-2"))?.cursor).toBeNull();
    expect(c.roots().find(r=>r.id===root.id)!.nextCheckAt).toBe(Date.now()+3_600_000);
  } finally {await service.stop();}
});
it("next() returns members still to collect before a failed member, and the failed member when only it remains", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  c.acceptPage(root,db.evidence.get(root.sourceId),null,{revision:"1",cursor:null,units:[{id:"body",kind:"issue",content:"root"}],
    links:[2,3].map(n=>({url:issue(n),label:`APP-${n}`,unitId:"body",relation:"link" as const}))});
  const [failed,pending]=[2,3].map(n=>c.members(root.id).find(m=>db.evidence.get(m.source_id).url.endsWith(`/APP-${n}`))!.source_id);
  c.failed(root.id,failed,"unavailable");
  expect(c.next(root.id)?.source.id).toBe(pending);
  expect(c.next(root.id,new Set([pending]))?.source.id).toBe(failed);
  expect(c.next(root.id,new Set([pending,failed]))).toBeNull();
});
// bf81000 review 44b3b20f F001: a member that cannot be read now — a host capture past its freshness, another collection's live
// lease, or the source's own retry wait — no longer ends the call. It is left exactly as it was and the members after it are read.
const linkAll = (db: ConsensusDatabase, root: { id: string; sourceId: string }, urls: string[]) =>
  db.evidence.catalog.acceptPage(db.evidence.catalog.roots().find(r=>r.id===root.id)!,db.evidence.get(root.sourceId),null,{revision:"1",cursor:null,
    units:[{id:"body",kind:"issue",content:"root"}],links:urls.map(url=>({url,label:url,unitId:"body",relation:"link" as const}))});
const memberId = (db: ConsensusDatabase, rootId: string, url: string) =>
  db.evidence.catalog.members(rootId).find(m=>db.evidence.get(m.source_id).url.endsWith(`/${url.split("/").pop()}`))!.source_id;
it.each(["stale host capture","live lease","source retry wait"] as const)("a member that cannot be read now (%s) is left as it was while the members after it are read", async kind => {
  vi.useFakeTimers({toFake:["Date"]});
  const {db}=fixture(),c=db.evidence.catalog;
  const mode=kind==="stale host capture" ? "connector" as const : "rest" as const;
  const root=c.add("a",{...input(issue(1)),mode},true);
  const waiting=db.evidence.ensureSource({url:kind==="stale host capture" ? "https://www.figma.com/design/ABC123/file?node-id=1-2" : issue(2),label:"waiting",mode,intervalSeconds:900},true);
  const later=db.evidence.ensureSource({url:issue(3),label:"later",mode,intervalSeconds:900},true);
  linkAll(db,root,[waiting.url,later.url]);
  let held:string|null=null;
  if (kind==="stale host capture") {
    c.select("a",{version:c.version("a"),rootId:root.id,sourceId:waiting.id,action:"accept"});
    linkAll(db,root,[waiting.url,later.url]);
    db.evidence.ingest(waiting.id,{checkId:db.evidence.begin(waiting.id,true)!.checkId,revision:"capture",units:[{id:"capture",kind:"document",content:"host body"}]});
    vi.setSystemTime(Date.now()+1_800_001);
  } else {
    held=db.evidence.begin(waiting.id,true)!.checkId;
    if (kind==="source retry wait") { db.evidence.failed(waiting.id,held,"retry later",3600); held=null; }
  }
  const reads:string[]=[];
  const reader={fetch:async()=>{throw Error("unused");},configured:()=>true,discover:async (source:EvidenceSource)=>{
    reads.push(source.url); return {revision:"2",cursor:null,units:[{id:"body",kind:"issue" as const,content:source.label}],links:[]};
  }};
  const service=new EvidenceService(db.evidence,reader,undefined,mode==="connector" ? reader : undefined);
  const member=c.members(root.id).find(m=>m.source_id===waiting.id), source=db.evidence.get(waiting.id), nextCheckAt=c.roots().find(r=>r.id===root.id)!.nextCheckAt;
  try {
    await service.collect(root.id);
    expect(reads).toEqual([later.url]);
    expect(c.members(root.id).find(m=>m.source_id===later.id)?.progress).toBe("complete");
    expect(c.members(root.id).find(m=>m.source_id===waiting.id)).toEqual(member);
    expect(db.evidence.get(waiting.id)).toEqual(source);
    expect(c.roots().find(r=>r.id===root.id)).toMatchObject({lastCompleteAt:null,nextCheckAt});
    if (held) expect(db.evidence.begin(waiting.id,true)).toBeNull();
    // Once the condition clears, the same member is read by its existing path and the root completes.
    if (kind==="stale host capture") db.evidence.ingest(waiting.id,{checkId:db.evidence.begin(waiting.id,true)!.checkId,revision:"capture-2",units:[{id:"capture",kind:"document",content:"host body"}]});
    else if (held) db.evidence.releaseCheck(waiting.id,held);
    else vi.setSystemTime(Date.now()+3_600_001);
    await service.collect(root.id);
    expect(c.members(root.id).find(m=>m.source_id===waiting.id)?.progress).toBe("complete");
    expect(c.roots().find(r=>r.id===root.id)!.lastCompleteAt).not.toBeNull();
  } finally {await service.stop();}
});
it("members waiting on another collection's lease do not use the call's 20 collection attempts", async () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  const urls=Array.from({length:22},(_,n)=>issue(n+2));
  linkAll(db,root,urls);
  const ids=urls.map(url=>memberId(db,root.id,url));
  for (const id of ids.slice(0,21)) db.evidence.begin(id,true);
  const reads:string[]=[];
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");},configured:()=>true,discover:async source=>{
    reads.push(source.url); return {revision:"1",cursor:null,units:[{id:"body",kind:"issue" as const,content:source.url}],links:[]};
  }});
  try {
    await service.collect(root.id);
    expect(reads).toEqual([db.evidence.get(ids[21]).url]);
  } finally {await service.stop();}
});
// F002: failed members are retried from the member after the one whose retry started last, across calls and restarts. A read that
// outlasts the 20-second slice (REST 90s, MCP 120s; the slice does not cut a started read) no longer keeps every later failed member
// from its retry.
it("a failed member whose read outlasts the slice does not keep the next failed member from its retry, across a restart", async () => {
  vi.useFakeTimers({toFake:["Date"]});
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  linkAll(db,root,[issue(2),issue(3)]);
  let recovered=false; const reads:string[]=[];
  const reader={fetch:async()=>{throw Error("unused");},configured:()=>true,discover:async (source:EvidenceSource)=>{
    const key=source.url.split("/").pop()!; reads.push(key);
    if (key==="APP-2") { vi.setSystemTime(Date.now()+121_000); throw new EvidenceFetchError("앱 연결 응답 시간이 지났습니다."); }
    if (!recovered) throw new EvidenceFetchError("앱 연결 응답 시간이 지났습니다.");
    return {revision:"1",cursor:null,units:[{id:"body",kind:"issue" as const,content:key}],links:[]};
  }};
  const service=new EvidenceService(db.evidence,reader);
  await service.collect(root.id);
  await service.collect(root.id);
  expect(reads).toEqual(["APP-2","APP-3","APP-2"]);
  await service.stop();
  recovered=true; reads.length=0;
  const restarted=new EvidenceService(db.evidence,reader);
  try {
    await restarted.collect(root.id);
    expect(reads[0]).toBe("APP-3");
    expect(progressByKey(db,root.id)["APP-3"]).toBe("complete");
  } finally {await restarted.stop();}
});
it("more than 20 failing members are all retried in turn across calls", async () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  linkAll(db,root,Array.from({length:25},(_,n)=>issue(n+2)));
  const attempts=new Map<string,number>();
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");},configured:()=>true,discover:async source=>{
    attempts.set(source.url,(attempts.get(source.url) ?? 0)+1); throw new EvidenceFetchError("unavailable");
  }});
  try {
    for (let n=0;n<3;n++) await service.collect(root.id);
    expect(attempts.size).toBe(25);
    expect(Math.min(...attempts.values())).toBeGreaterThanOrEqual(2);
  } finally {await service.stop();}
});
// F003: a later call's shorter failure no longer shortens the root's retry wait while an earlier failure is unresolved. A resolved
// failure, a completed cycle and a new cycle do not carry the old wait.
it("a later call's shorter failure keeps an unresolved failure's longer wait; resolution and completion release it", async () => {
  vi.useFakeTimers({toFake:["Date"]});
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  linkAll(db,root,[issue(2),issue(3),issue(4)]);
  let aFails=true,bFails=true;
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("unused");},configured:()=>true,discover:async (source,cursor)=>{
    const key=source.url.split("/").pop()!, page=Number(cursor ?? 0);
    if (key==="APP-2" && aFails) throw new EvidenceFetchError("rate limited",3600);
    if (key==="APP-4" && bFails) { vi.setSystemTime(Date.now()+121_000); throw new EvidenceFetchError("앱 연결 응답 시간이 지났습니다."); }
    return {revision:"1",cursor:key==="APP-3" && page<24 ? String(page+1) : null,units:[{id:`body-${page}`,kind:"issue" as const,content:key}],links:[]};
  }});
  const t0=Date.now(), nextCheckAt=()=>c.roots().find(r=>r.id===root.id)!.nextCheckAt;
  try {
    await service.collect(root.id);
    expect(progressByKey(db,root.id)).toMatchObject({"APP-2":"failed","APP-3":"reading","APP-4":"pending"});
    expect(nextCheckAt()).toBe(t0+3_600_000);
    await service.collect(root.id);
    expect(progressByKey(db,root.id)).toMatchObject({"APP-2":"failed","APP-3":"complete","APP-4":"failed"});
    expect(nextCheckAt()).toBe(t0+3_600_000);
    aFails=false;
    await service.collect(root.id);
    expect(progressByKey(db,root.id)).toMatchObject({"APP-2":"complete","APP-4":"failed"});
    expect(nextCheckAt()).toBe(Date.now()+300_000);
    bFails=false;
    await service.collect(root.id);
    expect(c.roots().find(r=>r.id===root.id)).toMatchObject({lastCompleteAt:Date.now(),nextCheckAt:Date.now()+900_000});
  } finally {await service.stop();}
});
it("a new cycle starts failed retries from the first failed member again", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true);
  linkAll(db,root,[issue(2),issue(3),issue(4)]);
  const [a,b,d]=[2,3,4].map(n=>memberId(db,root.id,issue(n)));
  const failAll=()=>{ for (const id of [a,b,d]) c.failed(root.id,id,"unavailable"); };
  failAll();
  c.startRetry(root.id,b);
  expect(c.next(root.id)?.source.id).toBe(d);
  c.requestRefresh(root.id);
  expect(c.roots().find(r=>r.id===root.id)!.nextCheckAt).toBe(0);
  linkAll(db,root,[issue(2),issue(3),issue(4)]);
  failAll();
  expect(c.next(root.id)?.source.id).toBe(a);
});
// 2026-10-20 user decision D1: a Jira root spread through a Confluence page a person approved to the Jira issues that page linked
// (282 members on root 97033fe2). Automatic approval now follows the root's scope only while the page holding the link is itself in
// that scope, and only a member this root actually approved shares its approval with other roots.
const sourceOf = (db: ConsensusDatabase, rootId: string, url: string) =>
  db.evidence.catalog.members(rootId).find(m => db.evidence.get(m.source_id).url === url)!;
const pageOf = (url: string, links: string[]) => ({revision:"1",cursor:null,units:[{id:"body",kind:"document" as const,content:[url,...links].join(" ")}],
  links:links.map(link=>({url:link,label:link,unitId:"body",relation:"link" as const}))});
it("a Jira link in a Confluence page a person approved under a Jira root stays a candidate, and earlier states stay as they were", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input(issue(1)),true), current=()=>c.roots().find(r=>r.id===root.id)!;
  const minutes="https://team.atlassian.net/wiki/spaces/A/pages/123/Minutes";
  c.acceptPage(current(),db.evidence.get(root.sourceId),null,pageOf(issue(1),[minutes]));
  const doc=sourceOf(db,root.id,minutes);
  expect(doc.state).toBe("candidate");
  c.select("a",{version:c.version("a"),rootId:root.id,sourceId:doc.source_id,action:"accept"});
  c.acceptPage(current(),db.evidence.get(doc.source_id),null,pageOf(minutes,[issue(8),issue(9)]));
  expect(sourceOf(db,root.id,issue(9)).state).toBe("candidate");
  expect(c.collected(root.id,doc.source_id).links.map(link=>link.url)).toEqual([issue(8),issue(9)]);
  // An approval made before this rule is not demoted when the page is read again, and its snapshot is untouched.
  const earlier=sourceOf(db,root.id,issue(8)).source_id;
  (c as unknown as {db:{prepare:(sql:string)=>{run:(...args:unknown[])=>unknown}}}).db
    .prepare("UPDATE evidence_members SET state='approved' WHERE root_id=? AND source_id=?").run(root.id,earlier);
  const kept=db.evidence.ingest(earlier,{checkId:db.evidence.begin(earlier,true)!.checkId,revision:"r",units:[{id:"body",kind:"issue",content:"kept"}]});
  c.requestRefresh(root.id);
  c.acceptPage(current(),db.evidence.get(root.sourceId),null,pageOf(issue(1),[minutes]));
  c.acceptPage(current(),db.evidence.get(doc.source_id),null,pageOf(minutes,[issue(8),issue(9)]));
  expect(sourceOf(db,root.id,issue(8)).state).toBe("approved");
  expect(sourceOf(db,root.id,issue(9)).state).toBe("candidate");
  expect(db.evidence.get(earlier).contentHash).toBe(kept.contentHash);
});
it("Jira relations of the root's own site are still explored, and an actual approval is still reused by another root", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const jira=c.add("a",input(issue(1)),true), current=()=>c.roots().find(r=>r.id===jira.id)!;
  const policy=c.add("a",input("https://team.atlassian.net/wiki/spaces/A/pages/200/Policy"),true);
  c.acceptPage(policy,db.evidence.get(policy.sourceId),null,pageOf("policy",[issue(3)]));
  expect(sourceOf(db,policy.id,issue(3)).state).toBe("candidate");
  c.acceptPage(current(),db.evidence.get(jira.sourceId),null,pageOf(issue(1),[issue(2)]));
  const child=sourceOf(db,jira.id,issue(2));
  expect(child.state).toBe("approved");
  c.acceptPage(current(),db.evidence.get(child.source_id),null,pageOf(issue(2),[issue(3)]));
  expect(sourceOf(db,jira.id,issue(3)).state).toBe("approved");
  expect(sourceOf(db,policy.id,issue(3)).state).toBe("approved");
});
it("rediscovering a member a person rejected does not approve it in another root of the same scope", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const jira=c.add("a",input(issue(1)),true), current=()=>c.roots().find(r=>r.id===jira.id)!;
  c.acceptPage(current(),db.evidence.get(jira.sourceId),null,pageOf(issue(1),[issue(5)]));
  const rejected=sourceOf(db,jira.id,issue(5)).source_id;
  c.select("a",{version:c.version("a"),rootId:jira.id,sourceId:rejected,action:"reject"});
  const policy=c.add("a",input("https://team.atlassian.net/wiki/spaces/A/pages/200/Policy"),true);
  c.acceptPage(policy,db.evidence.get(policy.sourceId),null,pageOf("policy",[issue(5)]));
  expect(sourceOf(db,policy.id,issue(5)).state).toBe("candidate");
  c.acceptPage(current(),db.evidence.get(jira.sourceId),null,pageOf(issue(1),[issue(5)]));
  expect(sourceOf(db,jira.id,issue(5)).state).toBe("rejected");
  expect(sourceOf(db,policy.id,issue(5)).state).toBe("candidate");
});
function fixture() {
  const path = mkdtempSync(join(tmpdir(),"catalog-")); const db = new ConsensusDatabase(join(path,"db"));
  cleanup.push(() => { db.close(); rmSync(path,{recursive:true,force:true}); });
  const topic = (id: string) => db.createTopic({ workflowMode: "planned", id, slug:id, title:id, repositoryPath:path, worktreePath:path,
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
// 2026-10-15: one poll parsed the whole work_groups table once per topic per root (context() inside affected()), so the
// server's main thread was intermittently unresponsive. A synchronous read computation now parses it once; separate calls
// still read the current table.
it("one due()/affected() computation reads work_groups once, and the next call sees a changed group", () => {
  const {db,topic}=fixture(),catalog=db.evidence.catalog;
  const root=catalog.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const sqlite=(catalog as unknown as {db:{prepare:(sql:string)=>{all:(...args:unknown[])=>unknown[]}}}).db;
  const prepare=sqlite.prepare.bind(sqlite); let reads=0;
  vi.spyOn(sqlite,"prepare").mockImplementation((sql:string)=>{
    const statement=prepare(sql);
    if (!/FROM work_groups/.test(sql)) return statement;
    const all=statement.all.bind(statement);
    return Object.assign(statement,{all:(...args:unknown[])=>{reads++;return all(...args);}});
  });
  const counted=<T,>(run:()=>T)=>{reads=0;const value=run();return {value,reads};};
  expect(counted(()=>catalog.due().map(r=>r.id))).toEqual({value:[root.id],reads:1});
  expect(counted(()=>catalog.affected(root))).toEqual({value:["a","closed"],reads:1});
  topic("next"); db.workGroups.link("g-a","later","next","a".repeat(40));
  expect(counted(()=>catalog.affected(root))).toEqual({value:["a","closed","next"],reads:1});
  expect(counted(()=>catalog.managed(root.sourceId))).toEqual({value:true,reads:1});
  // Outside a computation every context() reads the table, as before.
  expect(counted(()=>{catalog.context("a");catalog.context("a");}).reads).toBe(2);
});
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
it("a source the server's app reader collects has one writer: the host list skips it and a host import is refused", async () => {
  // A host capture stores the host's own unit layout. Alternating it with the app reader made each switch a whole-source change.
  // The document source has no app reader and keeps the host path. No live app connection is used.
  const {db}=fixture(),c=db.evidence.catalog;
  const jira=c.add("a",{...input("https://team.atlassian.net/browse/APP-1"),mode:"connector"},true);
  const page=c.add("a",{...input("https://docs.example.com/policy"),mode:"connector"},true);
  const native={configured:(source:EvidenceSource)=>source.provider!=="document",fetch:async()=>{throw Error("unused");}};
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host only");}},undefined,native);
  try {
    expect(service.hostPlan("a").requests.map(read=>read.sourceId)).toEqual([page.sourceId]);
    const version=c.version("a"),before=db.evidence.get(jira.sourceId),members=c.members(jira.id);
    let refused: unknown;
    try {
      service.importHost("a",{version,rootId:jira.id,sourceId:jira.sourceId,previousHash:null,previousCheckedAt:null,
        observedAt:Date.now(),revision:"host",units:[{id:"issue:APP-1",kind:"issue",content:"Host layout"}],missing:[]});
    } catch (error) { refused=error; }
    expect(refused).toMatchObject({statusCode:409});
    expect(db.evidence.get(jira.sourceId)).toEqual(before);
    expect(c.members(jira.id)).toEqual(members);
    expect(c.version("a")).toBe(version);
    const imported=service.importHost("a",{version,rootId:page.id,sourceId:page.sourceId,previousHash:null,previousCheckedAt:null,
      observedAt:Date.now(),revision:"host",units:[{id:"body",kind:"document",content:"Policy page"}],missing:[]});
    expect(imported.contentHash).not.toBeNull();
    expect(service.hostPlan("a").requests).toEqual([]);
  } finally {await service.stop();}
});
it("a shared document the app reader cannot read keeps its host capture for every root that selects it", async () => {
  // Two roots select the same document and one host import serves both. With an app reader installed, the other root's collection
  // used to skip the capture because a reader existed at all, then failed on the document and marked the shared source an error.
  const {db}=fixture(),c=db.evidence.catalog;
  const url="https://docs.example.com/shared-policy";
  const first=c.add("a",{...input(url,"topic"),mode:"connector"},true);
  const second=c.add("b",{...input(url,"topic"),mode:"connector"},true);
  expect(second.sourceId).toBe(first.sourceId);
  const discover=vi.fn(async()=>{throw Error("The app reader cannot read documents");});
  const native={configured:(source:EvidenceSource)=>source.provider!=="document",fetch:async()=>{throw Error("unused");},discover};
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host only");}},undefined,native);
  try {
    const imported=service.importHost("a",{version:c.version("a"),rootId:first.id,sourceId:first.sourceId,previousHash:null,previousCheckedAt:null,
      observedAt:Date.now(),revision:"host",units:[{id:"body",kind:"document",content:"Shared policy"}],missing:[]});
    await service.collect(second.id);
    const shared=db.evidence.get(first.sourceId);
    expect(shared).toMatchObject({contentHash:imported.contentHash,checkedAt:imported.checkedAt});
    expect(shared.error ?? null).toBeNull();
    expect(shared.collection?.status).not.toBe("error");
    expect(discover).not.toHaveBeenCalled();
    expect(db.evidence.usableSources(db.getTopic("b")).map(source=>source.id)).toEqual([first.sourceId]);
  } finally {await service.stop();}
});
it("a Figma source the app reader reads only partly keeps the host supplement, which the reader does not overwrite", async () => {
  // The app reader's Figma pages always report comments missing, so only a complete host capture makes the source usable.
  // Until one exists the reader collects the design; afterwards the host owns the source. Jira stays the reader's alone.
  const {db}=fixture(),c=db.evidence.catalog;
  const design=c.add("a",{...input("https://www.figma.com/design/form?node-id=1-2"),mode:"connector"},true);
  c.add("a",{...input("https://team.atlassian.net/browse/APP-1"),mode:"connector"},true);
  const discover=vi.fn(async()=>({units:[{id:"get_metadata:0",kind:"design" as const,content:"Reader design"}],links:[],cursor:null,
    revision:"reader",missing:["The app reader returns no Figma comments."]}));
  const native={configured:(source:EvidenceSource)=>source.provider!=="document",fetch:async()=>{throw Error("unused");},discover};
  const service=new EvidenceService(db.evidence,{fetch:async()=>{throw Error("Host only");}},undefined,native);
  try {
    expect(service.hostPlan("a").requests.map(read=>read.sourceId)).toEqual([design.sourceId]);
    await service.collect(design.id);
    expect(discover).toHaveBeenCalledTimes(1);
    const read=db.evidence.get(design.sourceId);
    expect(db.evidence.usable(read)).toBe(false);
    // The reader's collection finished with comments missing; the supplement stays offered while no complete capture exists.
    expect(service.hostPlan("a").requests.map(request=>request.sourceId)).toEqual([design.sourceId]);
    const imported=service.importHost("a",{version:c.version("a"),rootId:design.id,sourceId:design.sourceId,previousHash:read.contentHash,
      previousCheckedAt:read.checkedAt,observedAt:Date.now(),revision:"host",missing:[],
      units:[{id:"design",kind:"design",content:"Host design"},{id:"comment:1",kind:"comment",content:"Owner comment"}]});
    expect(db.evidence.usable(imported)).toBe(true);
    expect(service.hostPlan("a").requests).toEqual([]);
    await service.collect(design.id,true);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(db.evidence.get(design.sourceId)).toMatchObject({contentHash:imported.contentHash,checkedAt:imported.checkedAt});
  } finally {await service.stop();}
});
it("the partly-read provider list matches the providers whose app-reader pages report missing content", async () => {
  // PARTIAL_NATIVE_PROVIDERS repeats one fact of NativeEvidenceConnector. Each provider's first page is read through a stub app.
  const {db}=fixture();
  const responses: Record<string, unknown> = {
    "atlassian.atlassianUserInfo": {accountId:"owner"}, "slack.slack_read_user_profile": {result:"User ID: U1\n"},
    "figma.whoami": {whoami:{email:"designer@example.test"}},
    "atlassian.getJiraIssue": {key:"APP-1",fields:{updated:"2026-10-07T00:00:00.000+0900",summary:"Policy"}},
    "atlassian.getConfluenceContent": {body:"<p>Policy</p>"},
    "slack.slack_read_channel": {messages:[{ts:"1.2",user:"U1",text:"Policy"}]},
    "google_drive.get_spreadsheet_metadata": {sheets:[{properties:{sheetId:1,title:"Policy",gridProperties:{rowCount:1,columnCount:1}}}]},
    "figma.get_metadata": {content:[{type:"text",text:"<frame id=\"1:2\"/>"}]},
  };
  const reader: AppReader = {config:async()=>({googleDriveLinkId:"link_policy"}),close:async()=>{},call:async(_provider,name)=>{
    if (!(name in responses)) throw Error(`Unexpected app tool ${name}`);
    return responses[name];
  }};
  const connector=new NativeEvidenceConnector(reader), partial=new Set<string>();
  for (const url of ["https://team.atlassian.net/browse/APP-1","https://team.atlassian.net/wiki/spaces/A/pages/123/Policy",
    "https://team.slack.com/archives/C123","https://docs.google.com/spreadsheets/d/policy/edit","https://www.figma.com/design/form?node-id=1-2"]) {
    const source=db.evidence.ensureSource({url,label:url,mode:"connector",intervalSeconds:900},true);
    if ((await connector.discover(source,null,AbortSignal.timeout(5000))).missing?.length) partial.add(source.provider);
  }
  expect([...partial].sort()).toEqual([...PARTIAL_NATIVE_PROVIDERS].sort());
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
// 근거 범위 변경은 토픽을 초기화하지 않는다(CR 흐름 단순화 D6) — 계획·승인·산출물·세션을 그대로 두고, 사용자 행동은 catalog history 에 남는다.
it("approval is versioned; removal keeps the topic's plan, approval, artifacts and sessions, preserves snapshots and closed plans, and records the action", () => {
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
  expect(db.getTopic("a")).toMatchObject({ state:"AWAITING_USER_APPROVAL", planSHA256:"a".repeat(64), approvedPlanSHA256:"a".repeat(64) });
  expect(db.latestArtifact("a","plan")?.path).toBe("/historical-plan");
  expect(db.getTopic("a").participants[0].sessionId).toBe("old-session");
  expect(db.getTopic("closed")).toEqual(closed);
  expect(c.state("a").history[0].action).toBe("앞으로 사용할 근거에서 해제");
});
// 승인 루트가 있는 토픽도 근거 범위에서 빠진 원문을 다음 턴 근거 입력에 싣는다(계약 v3.12 (7'')) — 세션 영수증에 있는데 현재 원문 목록에 없는 원문이다.
it("a session of a topic with approved roots is told which received sources left the scope, again after a failed turn and not after a successful one", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const kept=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true), dropped=c.add("a",input("https://team.atlassian.net/browse/APP-2"),true);
  for (const root of [kept,dropped]) {
    const check=db.evidence.begin(root.sourceId,true)!;
    db.evidence.ingest(root.sourceId,{checkId:check.checkId,revision:"r",units:[{id:"body",kind:"issue",content:root.sourceId}]});
  }
  const binding=()=>db.getTopic("a"), notice="근거 범위에서 빠진 원문";
  const first=db.evidence.packet(binding(),"claude","s1");
  expect(first.entries).toEqual([]); expect([...first.links].sort()).toEqual([kept.sourceId,dropped.sourceId].sort());
  db.evidence.receipt(binding(),"claude","s1",first);
  c.select("a",{version:c.version("a"),rootId:dropped.id,action:"remove"});
  const removed=db.evidence.packet(binding(),"claude","s1");
  expect(removed.entries).toEqual([{type:"removedSource",sourceId:dropped.sourceId}]);
  expect(removed.text).toContain(notice); expect(removed.text).toContain("https://team.atlassian.net/browse/APP-2");
  expect(db.evidence.packet(binding(),"claude","other-session").entries).toEqual([]);
  // 실패한 턴은 영수증을 남기지 않으므로 다음 턴에 같은 제거가 다시 실린다.
  expect(db.evidence.packet(binding(),"claude","s1").entries).toEqual(removed.entries);
  db.evidence.receipt(binding(),"claude","s1",removed);
  const after=db.evidence.packet(binding(),"claude","s1");
  expect(after.entries).toEqual([]); expect(after.text).not.toContain(notice);
  // 조회 오류로 잠시 못 쓰는 원문은 범위에 남아 있으므로 제거로 알리지 않는다.
  const check=db.evidence.begin(kept.sourceId,true)!; db.evidence.failed(kept.sourceId,check.checkId,"429");
  expect(db.evidence.topic(binding()).deferred).toEqual([expect.objectContaining({sourceId:kept.sourceId})]);
  const deferred=db.evidence.packet(binding(),"claude","s1");
  expect(deferred.entries).toEqual([]); expect(deferred.text).not.toContain(notice);
  // 중재자 기록은 기존 catalog history 다.
  expect(c.state("a").history[0]).toMatchObject({action:"앞으로 사용할 근거에서 해제",url:"https://team.atlassian.net/browse/APP-2"});
});
// 79fc4fc5 F013: 승인 루트가 있는 토픽의 근거 packet 은 결과 봉투에 없는 처분(DEFERRED_OUT_OF_SCOPE·evidenceGap) 지침을 싣지 않는다. 엔진이 기록한 근거
// 공백 수(근거 확보 To-do)는 상태 수치로 남는다.
it("a root evidence packet carries no retired result-disposition guidance", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const root=c.add("a",input("https://team.atlassian.net/browse/APP-1"),true);
  const check=db.evidence.begin(root.sourceId,true)!;
  db.evidence.ingest(root.sourceId,{checkId:check.checkId,revision:"r",units:[{id:"body",kind:"issue",content:"body"}]});
  const packet=db.evidence.packet(db.getTopic("a"),"claude","s1");
  expect(packet.text).toContain("근거 확보 To-do: 0개");
  for (const retired of ["DEFERRED_OUT_OF_SCOPE","evidenceGap"]) expect(packet.text).not.toContain(retired);
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

it("an evidence scope change keeps the plan, finding ledgers and cycle flags", () => {
  const {db}=fixture(),c=db.evidence.catalog;
  db.updateTopic('a',{fixPassUsed:true,secondFixPassUsed:true,closeoutRevisionUsed:true});
  for (const kind of ['implementation-notes','deferred-findings','plan']) db.addArtifact('a',{kind,revision:1,scopeGeneration:1,sha256:'a'.repeat(64),path:`/${kind}`,createdAt:new Date().toISOString()});
  c.add('a',input('https://example.com/source'),true);
  expect(db.latestArtifact('a','implementation-notes')?.path).toBe('/implementation-notes');
  expect(db.latestArtifact('a','deferred-findings')?.path).toBe('/deferred-findings');
  expect(db.latestArtifact('a','plan')?.path).toBe('/plan');
  expect(db.getFlags('a')).toMatchObject({fixPassUsed:true,secondFixPassUsed:true,closeoutRevisionUsed:true});
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
  const facts:WorkerFact[]=[],cursors:Array<string|null>=[];
  const oldReader=new EvidenceService(db.evidence,{configured:()=>true,fetch:async()=>{throw Error('unused');},discover:async(_s,cursor)=>{
    cursors.push(cursor);const n=Number(cursor ?? '0');return {revision:'old',cursor:n<20 ? String(n+1):null,links:[],units:[{id:String(n),kind:'document',content:'old'}]};
  }},undefined,undefined,fact=>facts.push(fact));
  await oldReader.collect(a.id,true);
  await service.collect(b.id);const newer=db.evidence.get(a.sourceId);
  await oldReader.collect(a.id);expect(db.evidence.get(a.sourceId).contentHash).toBe(newer.contentHash);
  expect(c.members(a.id)[0]).toMatchObject({progress:'failed',cursor:null});
  // 1214e8c1 (자문 58 §2): the rejected scan is not a failed read. The stored source keeps the newer collection's body, error and
  // collection state, stays usable, and no source error reaches the runners. The conflict is recorded on the root's member only.
  expect(db.evidence.get(a.sourceId)).toEqual(newer);
  expect(db.evidence.usableSources(db.getTopic('a')).map(source=>source.id)).toContain(a.sourceId);
  expect(facts).toEqual([]);
  expect(c.members(a.id)[0].error).toBe("다른 수집이 먼저 갱신한 원문입니다. 처음부터 다시 수집하세요.");
  // The next collection of the root starts the member over from its first page.
  const read=cursors.length;await oldReader.collect(a.id);expect(cursors[read]).toBeNull();
});

it("a scan whose last page actually fails to read still marks the shared source failed and reports it", async () => {
  const {db}=fixture(),c=db.evidence.catalog;
  const a=c.add('a',input('https://example.com/shared'),true),b=c.add('b',input('https://example.com/shared'),true);
  const reader={configured:()=>true,fetch:async()=>{throw Error('unused');},discover:async(_s:EvidenceSource,cursor:string|null)=>{
    if (cursor==='20') throw new AppCallTimeout('앱 연결 응답 시간이 지났습니다.');
    const n=Number(cursor ?? '0');return {revision:'1',cursor:n<20 ? String(n+1):null,links:[],units:[{id:String(n),kind:'document' as const,content:'body'}]};
  }};
  const facts:WorkerFact[]=[];
  const scanner=new EvidenceService(db.evidence,reader,undefined,undefined,fact=>facts.push(fact));
  const current=new EvidenceService(db.evidence,{configured:()=>true,fetch:async()=>{throw Error('unused');},
    discover:async()=>({revision:'new',cursor:null,links:[],units:[{id:'body',kind:'document' as const,content:'new'}]})});
  await scanner.collect(a.id,true);
  await current.collect(b.id);const newer=db.evidence.get(a.sourceId).contentHash;
  await scanner.collect(a.id);
  expect(db.evidence.get(a.sourceId)).toMatchObject({contentHash:newer,collection:{status:'error',error:'앱 연결 응답 시간이 지났습니다.'}});
  expect(db.evidence.usableSources(db.getTopic('a')).map(source=>source.id)).not.toContain(a.sourceId);
  expect(facts).toEqual([{kind:'source-error',sourceId:a.sourceId,error:'앱 연결 응답 시간이 지났습니다.'}]);
  expect(c.members(a.id)[0]).toMatchObject({progress:'failed',cursor:'20'});
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

it("새 루트의 승인 재사용은 선택된 기존 루트의 자료를 승인하고 그 토픽의 계획·승인은 보존한다", async () => {
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
    expect(db.getTopic("ui")).toMatchObject({ approvedPlanSHA256:"f".repeat(64), planEpoch:before.planEpoch, state:"AWAITING_USER_APPROVAL" });
  } finally {await service.stop();}
});
