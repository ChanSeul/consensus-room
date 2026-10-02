// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { readFileSync } from "node:fs";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SessionGraph, GraphInspector } from "../src/web/SessionGraph";
import { PipelineEditor, orderPipeline } from "../src/web/PipelineEditor";
import { api, ApiError } from "../src/web/api";
import type { SessionGraph as Graph } from "../src/shared/sessionGraph";
import type { WorkGroupView } from "../src/shared/workGroups";
afterEach(()=>{cleanup();vi.restoreAllMocks();vi.useRealTimers();window.localStorage.clear();});
beforeEach(()=>{
  Object.defineProperty(document,"hidden",{configurable:true,value:false});
  const values = new Map<string,string>();
  Object.defineProperty(window,"localStorage",{configurable:true,value:{getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>values.set(key,value),removeItem:(key:string)=>values.delete(key),clear:()=>values.clear()}});
});
const graph:Graph={topicId:"t",nodes:[
  {id:"run",kind:"session",role:"runner",topicId:"t",lane:"t",label:"러너",subtitle:"codex",status:"running",historical:false,sessionId:"run-id",details:[{label:"모델",value:"model-live"}]},
  {id:"old",kind:"session",role:"runner",topicId:"t",lane:"t",label:"이전 러너",subtitle:"claude",status:"unknown",historical:true,sessionId:"old-id",details:[]},
  {id:"source",kind:"source",topicId:"t",lane:"t",label:"요구 원문",subtitle:"document",status:"complete",historical:false,url:"https://example.com",details:[]},
],edges:[{id:"delivery",from:"source",to:"run",kind:"delivered",label:"전달됨"}],lanes:[{id:"t",title:"작업"}],warnings:[],checkedAt:"now"};
it("selects a session's actual details, reveals history on demand and filters sources",async()=>{
  const host:Graph["nodes"][number]={...graph.nodes[0],id:"host",role:"host-reviewer",topicId:null,lane:"host",label:"engine-review"};
  vi.spyOn(api,"sessionGraph").mockResolvedValue({...graph,nodes:[...graph.nodes,host],lanes:[...graph.lanes,{id:"host",title:"engine-review"}]});const onSelect=vi.fn();
  const view=render(<SessionGraph topicId="t" onSelect={onSelect} onEdit={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button",{name:"러너 · 진행 중 · run-id"}));expect(onSelect).toHaveBeenLastCalledWith(graph.nodes[0],true);
  const hostNode=screen.getByRole("button",{name:/engine-review · 진행 중/});
  expect(parseFloat(hostNode.style.top)).toBeGreaterThan(parseFloat(screen.getByRole("button",{name:/러너 · 진행 중/}).style.top));
  fireEvent.change(screen.getByRole("combobox",{name:"그래프 주제 범위"}),{target:{value:"t"}});
  expect(hostNode).toBeInTheDocument();expect(screen.getByRole("button",{name:/러너 · 진행 중/})).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox",{name:"그래프 주제 범위"}),{target:{value:"host"}});
  expect(hostNode).toBeInTheDocument();expect(screen.queryByRole("button",{name:/러너 · 진행 중/})).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox",{name:"그래프 검색"}),{target:{value:"요구 원문"}});
  expect(screen.queryByRole("button",{name:/engine-review · 진행 중/})).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox",{name:"그래프 검색"}),{target:{value:""}});
  fireEvent.change(screen.getByRole("combobox",{name:"그래프 주제 범위"}),{target:{value:"all"}});
  expect(screen.queryByRole("button",{name:/이전 러너/})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox",{name:"이전 세션"}));expect(screen.getByRole("button",{name:/이전 러너/})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox",{name:"원문"}));expect(screen.queryByRole("button",{name:/요구 원문/})).not.toBeInTheDocument();
  view.unmount();render(<GraphInspector node={graph.nodes[0]} currentTopicId="t" onTopic={vi.fn()} onEvidence={vi.fn()} />);
  expect(screen.getByText("model-live")).toBeInTheDocument();
});
it("a failed refresh removes stale running indicators, and late replies cannot replace another topic",async()=>{
  vi.useFakeTimers();let resolve!:(g:Graph)=>void;
  vi.spyOn(api,"sessionGraph").mockResolvedValueOnce(graph).mockRejectedValueOnce(new Error("offline")).mockImplementationOnce(()=>new Promise(r=>{resolve=r;})).mockResolvedValue({...graph,topicId:"next",nodes:[]});
  const onSelect=vi.fn();const view=render(<SessionGraph topicId="t" onSelect={onSelect} onEdit={vi.fn()} />);
  await act(async()=>{});expect(screen.getByRole("button",{name:/러너 · 진행 중/})).toBeInTheDocument();
  await act(async()=>{await vi.advanceTimersByTimeAsync(3_000);});expect(screen.queryByRole("button",{name:/러너 · 진행 중/})).not.toBeInTheDocument();expect(screen.getByRole("alert")).toHaveTextContent("offline");
  await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
  view.rerender(<SessionGraph topicId="next" onSelect={onSelect} onEdit={vi.fn()} />);await act(async()=>{});
  await act(async()=>resolve(graph));expect(screen.queryByRole("button",{name:/러너 · 진행 중/})).not.toBeInTheDocument();
});
function pipeline():WorkGroupView{return {id:"g",parentTopicId:"r",title:"파이프라인",goal:"목표",contracts:"보존 계약",repositoryPath:"/repo",baseOID:"base",version:4,createdAt:"now",links:{a:{topicId:"t",baseOID:"base",groupVersion:4}},
  stages:[{id:"a",title:"A 작업",goal:"A 목표",kind:"work",dependsOn:[]},{id:"b",title:"B 작업",goal:"B 목표",kind:"work",dependsOn:[]},{id:"z",title:"통합",goal:"통합 목표",kind:"integration",dependsOn:["a","b"]}],
  questions:[{id:"q",stageId:null,text:"확인된 계약",blocksStart:false,resolution:"유지"}],budgetPolicy:{mode:"observe"},budget:null,stageStates:{a:"USER_DECISION_REQUIRED"},delivery:{},delivered:false,readyStages:[],selectableStages:[],replanPending:[]};}
it("edits real dependencies through ports, saves a recoverable draft, and applies versioned input without losing contracts",async()=>{
  const original=pipeline(),onDone=vi.fn();vi.spyOn(api,"listWorkGroups").mockResolvedValue([original]);const apply=vi.spyOn(api,"applyPipeline").mockResolvedValue(original);
  const renderEditor=()=>render(<PipelineEditor topicId="r" topicIds={["r","t"]} canCreate title="Root" goal="Goal" onDone={onDone}/>);
  let view=renderEditor();fireEvent.click(await screen.findByRole("button",{name:"a 출력 선택"}));fireEvent.click(screen.getByRole("button",{name:"b 입력에 연결"}));
  fireEvent.keyDown(screen.getByRole("button",{name:"a → b 연결 선택"}),{key:"Enter"});
  expect(screen.getByRole("button",{name:"a → b 연결 삭제"})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"a → b 연결 삭제"}));expect(screen.queryByRole("button",{name:"a → b 연결 선택"})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"a 출력 선택"}));fireEvent.click(screen.getByRole("button",{name:"b 입력에 연결"}));
  fireEvent.click(screen.getByRole("button",{name:"편집안 저장"}));expect(apply).not.toHaveBeenCalled();view.unmount();
  view=renderEditor();await screen.findByText(/이 브라우저에 저장한 편집안/);
  fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));await waitFor(()=>expect(apply).toHaveBeenCalled());
  const [id,input,version]=apply.mock.calls[0];expect(id).toBe("g");expect(version).toBe(4);expect(input.stages.find(s=>s.id==="b")?.dependsOn).toEqual(["a"]);
  expect(input.questions).toEqual(original.questions);expect(input.budgetPolicy).toEqual(original.budgetPolicy);expect(input.contracts).toBe(original.contracts);expect(onDone).toHaveBeenCalled();
});
it("adds and deletes pending nodes, rejects cycles, and keeps linked nodes read-only",async()=>{
  vi.spyOn(api,"listWorkGroups").mockResolvedValue([pipeline()]);render(<PipelineEditor topicId="r" topicIds={["r"]} canCreate title="Root" goal="Goal" onDone={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button",{name:/A 작업/}));expect(screen.getByRole("button",{name:"선택 노드 삭제"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"작업 노드 추가"}));expect(screen.getByRole("textbox",{name:"작업 이름"})).toHaveValue("새 작업");
  fireEvent.click(screen.getByRole("button",{name:"선택 노드 삭제"}));expect(screen.queryByRole("button",{name:/미착수 작업 새 작업/})).not.toBeInTheDocument();
  const input=pipeline();input.stages[0].dependsOn=["b"];input.stages[1].dependsOn=["a"];expect(()=>orderPipeline(input)).toThrow("순환 연결");
});

it("recovers from stale revisions through an explicit latest-server reset",async()=>{
  const original=pipeline(),latest={...pipeline(),version:5,title:"서버 최신 파이프라인"};
  vi.spyOn(api,"listWorkGroups").mockResolvedValueOnce([original]).mockResolvedValue([latest]);
  const apply=vi.spyOn(api,"applyPipeline").mockRejectedValueOnce(new Error("version conflict")).mockResolvedValue(latest);
  render(<PipelineEditor topicId="r" topicIds={["r"]} canCreate title="Root" goal="Goal" onDone={vi.fn()}/>);
  fireEvent.click(await screen.findByRole("button",{name:"실행에 적용"}));await screen.findByText(/version conflict/);
  fireEvent.click(screen.getByRole("button",{name:"편집 취소 · 최신본 불러오기"}));await screen.findByText(/편집을 취소하고 서버의 최신/);
  fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));await waitFor(()=>expect(apply).toHaveBeenCalledTimes(2));expect(apply.mock.calls[1][2]).toBe(5);
});

it.each([
  new TypeError("network unavailable"),
  new ApiError("request running",409,{status:"running"}),
  new ApiError("request unknown",409,{status:"unknown"}),
  new ApiError("server unavailable",503),
])("retries an unknown creation after reload with the same body and request key: %s",async(error)=>{
  const input=pipeline();const {pipelineInput}=await import("../src/web/PipelineEditor");
  window.localStorage.setItem("consensus:pipeline-draft:r",JSON.stringify({groupId:null,version:0,input:pipelineInput(input)}));
  vi.spyOn(api,"listWorkGroups").mockResolvedValue([]);const create=vi.spyOn(api,"createWorkGroup").mockRejectedValueOnce(error).mockResolvedValue(input);
  const show=()=>render(<PipelineEditor topicId="r" topicIds={["r"]} canCreate title="Root" goal="Goal" onDone={vi.fn()}/>);
  let view=show();fireEvent.click(await screen.findByRole("button",{name:"실행에 적용"}));await screen.findByText(`${error.message} · 편집안은 유지됩니다.`);
  expect(screen.getByRole("button",{name:"작업 노드 추가"})).toBeDisabled();
  expect(screen.getByRole("combobox",{name:"편집할 파이프라인"})).toBeDisabled();
  expect(screen.getByRole("textbox",{name:"이름"})).toBeDisabled();view.unmount();view=show();
  await screen.findByText(/생성 요청의 응답을 확인하지 못했습니다/);fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));
  await waitFor(()=>expect(create).toHaveBeenCalledTimes(2));expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);expect(create.mock.calls[0][2]).toBeTruthy();
  await waitFor(()=>expect(window.localStorage.getItem("consensus:pipeline-draft:r")).toBeNull());
});


it("does not dispatch a new creation when its retry identity cannot be persisted",async()=>{
  vi.spyOn(api,"listWorkGroups").mockResolvedValue([pipeline()]);
  const create=vi.spyOn(api,"createWorkGroup");
  render(<PipelineEditor topicId="r" topicIds={["r"]} canCreate title="Root" goal="Goal" onDone={vi.fn()}/>);
  await screen.findByRole("button",{name:"실행에 적용"});
  fireEvent.click(screen.getByRole("button",{name:"파이프라인 추가"}));
  fireEvent.change(screen.getByRole("textbox",{name:"공통 계약"}),{target:{value:"기존 기능을 보존한다"}});
  fireEvent.click(screen.getByRole("button",{name:/첫 작업/}));
  fireEvent.change(screen.getByRole("textbox",{name:"작업 목표"}),{target:{value:"작업을 완료한다"}});
  vi.spyOn(window.localStorage,"setItem").mockImplementation(()=>{throw new Error("storage unavailable");});
  fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));
  await screen.findByText(/storage unavailable/);
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByRole("textbox",{name:"작업 목표"})).toBeEnabled();
});

it.each([401,400])("preserves an unknown creation across a pre-ledger %i response and authenticated reload",async(status)=>{
  const {pipelineInput}=await import("../src/web/PipelineEditor");
  window.localStorage.setItem("consensus:pipeline-draft:r",JSON.stringify({groupId:null,version:0,input:pipelineInput(pipeline())}));
  vi.spyOn(api,"listWorkGroups").mockResolvedValue([]);
  const requests:{key:string;body:string}[]=[],ledger=new Map<string,WorkGroupView>();let creations=0;
  vi.spyOn(globalThis,"fetch").mockImplementation(async(_url,init)=>{
    const key=new Headers(init?.headers).get("idempotency-key")!,body=String(init?.body);
    requests.push({key,body});
    if(requests.length===2)return new Response(JSON.stringify({error:"before ledger lookup"}),{status,headers:{"content-type":"application/json"}});
    if(!ledger.has(key)){ledger.set(key,{...pipeline(),id:`created-${++creations}`});}
    if(requests.length===1)throw new TypeError("creation response lost");
    return new Response(JSON.stringify(ledger.get(key)),{status:201,headers:{"content-type":"application/json"}});
  });
  const onDone=vi.fn(),show=()=>render(<PipelineEditor topicId="r" topicIds={["r"]} canCreate title="Root" goal="Goal" onDone={onDone}/>);
  let view=show();fireEvent.click(await screen.findByRole("button",{name:"실행에 적용"}));await screen.findByText(/creation response lost/);
  fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));await screen.findByText(/before ledger lookup/);
  expect.soft(screen.getByRole("textbox",{name:"이름"})).toBeDisabled();
  view.unmount();view=show();
  fireEvent.click(await screen.findByRole("button",{name:"실행에 적용"}));await waitFor(()=>expect(onDone).toHaveBeenCalledOnce());
  expect(creations).toBe(1);
  expect(requests).toHaveLength(3);expect(requests[1]).toEqual(requests[0]);expect(requests[2]).toEqual(requests[0]);
  expect(window.localStorage.getItem("consensus:pipeline-draft:r")).toBeNull();
});

it("allows corrected input after a first rejection or a ledger-confirmed failure",async()=>{
  const {pipelineInput}=await import("../src/web/PipelineEditor");
  window.localStorage.setItem("consensus:pipeline-draft:r",JSON.stringify({groupId:null,version:0,input:pipelineInput(pipeline())}));
  vi.spyOn(api,"listWorkGroups").mockResolvedValue([]);
  const response=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
  const fetch=vi.spyOn(globalThis,"fetch").mockResolvedValueOnce(response(400,{error:"invalid creation input"}))
    .mockRejectedValueOnce(new TypeError("outcome unknown"))
    .mockResolvedValueOnce(response(409,{error:"recorded creation failure",status:"failed"}))
    .mockResolvedValueOnce(response(201,pipeline()));
  const onDone=vi.fn();render(<PipelineEditor topicId="r" topicIds={["r"]} canCreate title="Root" goal="Goal" onDone={onDone}/>);
  fireEvent.click(await screen.findByRole("button",{name:"실행에 적용"}));await screen.findByText(/invalid creation input/);
  expect(screen.getByRole("textbox",{name:"이름"})).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox",{name:"이름"}),{target:{value:"수정한 파이프라인"}});
  fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));await screen.findByText(/outcome unknown/);
  fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));await screen.findByText(/recorded creation failure/);
  expect(screen.getByRole("textbox",{name:"이름"})).toBeEnabled();
  fireEvent.change(screen.getByRole("textbox",{name:"이름"}),{target:{value:"최종 파이프라인"}});
  fireEvent.click(screen.getByRole("button",{name:"실행에 적용"}));await waitFor(()=>expect(onDone).toHaveBeenCalledOnce());
  const requests=fetch.mock.calls.map(([,init])=>({key:new Headers(init?.headers).get("idempotency-key"),body:JSON.parse(String(init?.body))}));
  expect(requests[0].key).not.toBe(requests[1].key);expect(requests[1]).toEqual(requests[2]);expect(requests[2].key).not.toBe(requests[3].key);
  expect(requests[1].body.title).toBe("수정한 파이프라인");expect(requests[3].body.title).toBe("최종 파이프라인");
});

it("keeps hundreds of sources folded below the session flow and reveals their real edges through expansion or search",async()=>{
  const sources=Array.from({length:591},(_,i)=>({...graph.nodes[2],id:`source-${i}`,label:`원문 ${i}`,subtitle:"wiki · 고정 원문"}));
  const planner={...graph.nodes[0],id:"plan",role:"planner" as const,label:"플래너"};
  const data:Graph={...graph,nodes:[planner,graph.nodes[0],...sources],edges:[{id:"actual",from:"source-590",to:"run",kind:"delivered",label:"기록된 전달"}]};
  vi.spyOn(api,"sessionGraph").mockResolvedValue(data);const onSelect=vi.fn();
  render(<SessionGraph topicId="t" onSelect={onSelect} onEdit={vi.fn()}/>);
  const group=await screen.findByRole("button",{name:/wiki.*원문 591개/});expect(group).toHaveAttribute("aria-expanded","false");
  expect(screen.queryByRole("button",{name:"원문 590 · 종료"})).not.toBeInTheDocument();
  const plan=screen.getByRole("button",{name:/플래너 · 진행 중/}),run=screen.getByRole("button",{name:/러너 · 진행 중/});
  expect(parseFloat(plan.style.left)).toBeLessThan(parseFloat(run.style.left));expect(plan.style.top).toBe(run.style.top);
  fireEvent.click(group);
  const first=screen.getByRole("button",{name:"원문 0 · 종료"}),second=screen.getByRole("button",{name:"원문 1 · 종료"});
  expect(first.style.top).toBe(second.style.top);expect(parseFloat(second.style.left)).toBeGreaterThan(parseFloat(first.style.left));
  expect(screen.getByText("기록된 전달")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"원문 590 · 종료"}));expect(onSelect).toHaveBeenLastCalledWith(sources[590],true);
  fireEvent.click(group);expect(screen.queryByRole("button",{name:"원문 590 · 종료"})).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole("textbox",{name:"그래프 검색"}),{target:{value:"원문 590"}});
  expect(screen.getByRole("button",{name:"원문 590 · 종료"})).toBeInTheDocument();
});

it("opens the same canvas fullscreen without shrinking nodes and exits with Escape",async()=>{
  const fullGraph:Graph={...graph,nodes:[{...graph.nodes[0],settingsTargets:["implementer"],environment:{executionId:"exec-observed",sessionId:"run-id",provider:"codex",consumer:"implementer/implement",spawnedAt:"2026-10-02T01:00:00Z",cwd:"/observed/worktree",hostname:"recorded-host",hostOS:{platform:"darwin",release:"25",arch:"arm64"},isolated:true,workspace:"git",access:"write",sandbox:"workspace-write",model:"recorded-model",effort:"medium"}},...graph.nodes.slice(1)]};
  vi.spyOn(api,"sessionGraph").mockResolvedValue(fullGraph);
  vi.spyOn(api,"sessionSettings").mockResolvedValue({...sessionSettingsView(),target:"implementer",criteria:undefined});
  const onSelect=vi.fn();const view=render(<SessionGraph topicId="t" onSelect={onSelect} onEdit={vi.fn()}/>);
  const run=await screen.findByRole("button",{name:/러너 · 진행 중/});
  expect(screen.getByText("100%")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:"전체화면"}));
  expect(screen.getByRole("region",{name:"세션과 원문 그래프"})).toHaveClass("is-fullscreen");
  fireEvent.click(run);expect(onSelect).toHaveBeenLastCalledWith(fullGraph.nodes[0],false);
  view.rerender(<SessionGraph topicId="t" selectedNodeId="run" onSelect={onSelect} onEdit={vi.fn()}/>);
  expect(screen.getByRole("complementary",{name:"전체화면 노드 상세"})).toHaveTextContent("model-live");
  expect(screen.queryByRole("button",{name:"현재 세션·설정 변경"})).not.toBeInTheDocument();
  expect(screen.getByRole("complementary",{name:"전체화면 노드 상세"})).toHaveTextContent("/observed/worktree");
  expect(screen.getByRole("complementary",{name:"전체화면 노드 상세"})).toHaveTextContent("recorded-model");
  fireEvent.click(screen.getByRole("button",{name:/구현 · 다음 실행 설정/}));
  expect(await screen.findByRole("combobox",{name:"모델"})).toHaveValue("model-a");
  fireEvent.click(screen.getByRole("button",{name:"그래프 확대"}));expect(screen.getByText("110%")).toBeInTheDocument();
  fireEvent.keyDown(document,{key:"Escape"});
  expect(screen.getByRole("region",{name:"세션과 원문 그래프"})).not.toHaveClass("is-fullscreen");
  expect(screen.getByRole("button",{name:"전체화면"})).toHaveFocus();expect(document.body.style.overflow).not.toBe("hidden");
});

function sessionSettingsView():import("../src/shared/sessionSettings").SessionSettingsView {
  return {target:"plan-review",editable:true,revision:"rev-1",appliesTo:"next-execution",mixed:false,models:["model-a","model-b"],efforts:["medium","high"],
    operations:[{operation:"audit",provider:"codex",model:"model-a",effort:"medium",scope:"topic:child"}],
    criteria:{catalog:[{id:"correctness",label:"정확성·경계 조건"},{id:"tests",label:"검증 근거"}],selectedIds:["correctness"],additionalText:"",mixed:false}};
}
it("edits the selected node's actual next-execution role and criteria without changing provider or starting execution",async()=>{
  const initial=sessionSettingsView();vi.spyOn(api,"sessionSettings").mockResolvedValue(initial);
  let finish!:(value:typeof initial)=>void;
  const update=vi.spyOn(api,"updateSessionSettings").mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const node={...graph.nodes[0],id:"child-review",topicId:"child",role:"plan-reviewer" as const,settingsTargets:["plan-review" as const]};
  render(<GraphInspector node={node} currentTopicId="root"/>);
  fireEvent.click(screen.getByRole("button",{name:/계획 검토 · 다음 실행 설정/}));
  fireEvent.change(await screen.findByRole("combobox",{name:"모델"}),{target:{value:"model-b"}});
  fireEvent.change(screen.getByRole("combobox",{name:"추론 강도"}),{target:{value:"high"}});
  fireEvent.click(screen.getByRole("checkbox",{name:"검증 근거"}));fireEvent.change(screen.getByRole("textbox",{name:"추가 기준"}),{target:{value:"취소 뒤 재시도를 확인한다"}});
  const save=screen.getByRole("button",{name:"다음 실행 설정 저장"});fireEvent.click(save);fireEvent.click(save);
  expect(update).toHaveBeenCalledTimes(1);expect(update).toHaveBeenCalledWith("child",{target:"plan-review",revision:"rev-1",model:"model-b",effort:"high",criteria:{selectedIds:["correctness","tests"],additionalText:"취소 뒤 재시도를 확인한다"}});
  await act(async()=>finish({...initial,revision:"rev-2",operations:[{...initial.operations[0],model:"model-b",effort:"high"}]}));
  expect(await screen.findByText(/저장했습니다. 모델·추론 강도는 다음 실행부터/)).toBeInTheDocument();
});
it("keeps edited criteria after a revision conflict and uses the latest revision only after explicit reset",async()=>{
  const {SessionSettingsEditor}=await import("../src/web/SessionSettingsEditor"),initial=sessionSettingsView();
  vi.spyOn(api,"sessionSettings").mockResolvedValueOnce(initial).mockResolvedValue({...initial,revision:"rev-2"});
  const update=vi.spyOn(api,"updateSessionSettings").mockRejectedValueOnce(new ApiError("다른 세션이 설정을 변경했습니다",409)).mockResolvedValue({...initial,revision:"rev-3"});
  render(<SessionSettingsEditor topicId="child" target="plan-review"/>);fireEvent.click(screen.getByRole("button",{name:/계획 검토 · 다음 실행 설정/}));
  fireEvent.change(await screen.findByRole("textbox",{name:"추가 기준"}),{target:{value:"보존할 입력"}});
  fireEvent.click(screen.getByRole("button",{name:"다음 실행 설정 저장"}));await screen.findByRole("alert");
  expect(screen.getByRole("textbox",{name:"추가 기준"})).toHaveValue("보존할 입력");expect(screen.getByRole("button",{name:"다음 실행 설정 저장"})).toBeDisabled();
  fireEvent.click(screen.getByRole("button",{name:"편집 취소 · 최신 설정"}));await waitFor(()=>expect(screen.getByRole("textbox",{name:"추가 기준"})).toHaveValue(""));
  fireEvent.click(screen.getByRole("button",{name:"다음 실행 설정 저장"}));await waitFor(()=>expect(update).toHaveBeenCalledTimes(2));expect(update.mock.calls[1][1].revision).toBe("rev-2");
});
it("shows unsupported and historical nodes as read-only and does not substitute current settings for missing spawn records",async()=>{
  const get=vi.spyOn(api,"sessionSettings").mockResolvedValue({...sessionSettingsView(),target:"mediator",editable:false,reason:"외부 중재 세션에서 변경하세요"});
  const node={...graph.nodes[0],role:"mediator" as const,settingsTargets:["mediator" as const]};
  const view=render(<GraphInspector node={node} currentTopicId="t"/>);
  expect(screen.getByText(/실행 당시 환경 기록이 없습니다/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:/중재자 · 다음 실행 설정/}));expect(await screen.findByText("외부 중재 세션에서 변경하세요")).toBeInTheDocument();
  expect(screen.queryByRole("button",{name:"다음 실행 설정 저장"})).not.toBeInTheDocument();
  view.rerender(<GraphInspector node={{...node,historical:true}} currentTopicId="t"/>);
  expect(screen.getByText(/과거 세션 기록은 읽기 전용/)).toBeInTheDocument();expect(screen.queryByRole("button",{name:/다음 실행 설정/})).not.toBeInTheDocument();expect(get).toHaveBeenCalledTimes(1);
});
it("requires an explicit common choice before replacing mixed operation settings",async()=>{
  const {SessionSettingsEditor}=await import("../src/web/SessionSettingsEditor"),initial={...sessionSettingsView(),mixed:true};
  vi.spyOn(api,"sessionSettings").mockResolvedValue(initial);const update=vi.spyOn(api,"updateSessionSettings").mockResolvedValue({...initial,mixed:false});
  render(<SessionSettingsEditor topicId="child" target="plan-review"/>);fireEvent.click(screen.getByRole("button",{name:/계획 검토 · 다음 실행 설정/}));
  const model=await screen.findByRole("combobox",{name:"모델"});expect(model).toHaveValue("");
  fireEvent.change(model,{target:{value:"model-a"}});fireEvent.change(screen.getByRole("combobox",{name:"추론 강도"}),{target:{value:"high"}});
  expect(screen.getByRole("button",{name:"다음 실행 설정 저장"})).toBeDisabled();expect(update).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("checkbox",{name:/작업별 설정이 서로 다릅니다/}));fireEvent.click(screen.getByRole("button",{name:"다음 실행 설정 저장"}));await waitFor(()=>expect(update).toHaveBeenCalledOnce());
});

it("groups communication labels sharing an anchor without dropping their full details or state colors",async()=>{
  vi.spyOn(api,"sessionGraph").mockResolvedValue({...graph,nodes:[{...graph.nodes[0],id:"topic",kind:"topic",label:"주제"},graph.nodes[0],{...graph.nodes[0],id:"second",label:"다른 러너"}],edges:[
    {id:"old-request",from:"topic",to:"run",kind:"communication",status:"acknowledged",label:"첫 요청 확인",detail:"첫 요청 원문"},
    {id:"new-request",from:"topic",to:"second",kind:"communication",status:"waiting",label:"추가 요청 대기",detail:"추가 요청 원문"},
  ]});
  const view=render(<SessionGraph topicId="t" onSelect={vi.fn()} onEdit={vi.fn()}/>);
  await screen.findByRole("button",{name:/^러너 · 진행 중/});
  const labels=view.container.querySelectorAll(".edge-communication text");
  expect(labels).toHaveLength(1);expect(labels[0]).toHaveTextContent("통신 2");
  expect(labels[0].querySelector("title")).toHaveTextContent("첫 요청 원문");expect(labels[0].querySelector("title")).toHaveTextContent("추가 요청 원문");
  expect(view.container.querySelector(".edge-acknowledged path")).toBeInTheDocument();expect(view.container.querySelector(".edge-waiting path")).toBeInTheDocument();
  view.rerender(<SessionGraph topicId="t" selectedNodeId="second" onSelect={vi.fn()} onEdit={vi.fn()}/>);
  expect(labels[0].closest("g")).toHaveClass("highlighted");expect(view.container.querySelector(".edge-acknowledged")).toHaveClass("dimmed");
});

it("routes nested hierarchy outside content with one trunk per parent and hides only unassigned verifier placeholders",async()=>{
  const topic=(id:string):Graph["nodes"][number]=>({...graph.nodes[0],id,kind:"topic",lane:id,label:id});
  const verifier:Graph["nodes"][number]={...graph.nodes[0],id:"empty-verifier",role:"verifier",label:"미배정 검증자",sessionId:null,details:[{label:"현재 배정",value:"배정 없음"}]};
  const assigned={...verifier,id:"assigned",label:"외부 검증자",details:[{label:"현재 배정",value:"user · v1"}]};
  const nodes=[topic("root"),topic("child"),topic("grandchild"),topic("sibling"),{...graph.nodes[2],lane:"root"},verifier,assigned,
    {...verifier,id:"recorded",label:"기록 검증자",sessionId:"actual"},{...verifier,id:"historical",label:"이전 검증자",historical:true}];
  vi.spyOn(api,"sessionGraph").mockResolvedValue({...graph,nodes,lanes:[{id:"root",title:"Root"},{id:"child",title:"Sub"},{id:"grandchild",title:"Nested"},{id:"sibling",title:"Sibling"},...graph.lanes],edges:[
    {id:"a",from:"root",to:"child",kind:"hierarchy",label:"하위 주제"},{id:"b",from:"root",to:"sibling",kind:"hierarchy",label:"하위 주제"},{id:"c",from:"child",to:"grandchild",kind:"hierarchy",label:"하위 주제"},
  ]});
  const view=render(<SessionGraph topicId="t" selectedNodeId="grandchild" onSelect={vi.fn()} onEdit={vi.fn()}/>);
  const root=await screen.findByRole("button",{name:/^root ·/});
  const trunks=[...view.container.querySelectorAll(".hierarchy-trunk")];expect(trunks).toHaveLength(2);
  const xs=trunks.map(path=>Number(path.getAttribute("d")!.split(" H ")[1].split(" ")[0]));
  expect(new Set(xs).size).toBe(2);for(const x of xs)expect(x).toBeLessThan(parseFloat(root.style.left));
  expect(view.container.querySelectorAll(".hierarchy-branch")).toHaveLength(3);
  const childInput=view.container.querySelector(".hierarchy-branch")!;
  const childOutput=trunks[1];
  expect(Number(childInput.getAttribute("d")!.split(" ")[2])).toBeLessThan(Number(childOutput.getAttribute("d")!.split(" ")[2]));
  expect(view.container.querySelectorAll(".edge-hierarchy.highlighted .hierarchy-trunk")).toHaveLength(1);
  expect(view.container.querySelector(".graph-source-group")).toHaveStyle({left:root.style.left});
  expect(view.container.querySelector(".graph-lane")).toHaveStyle({left:root.style.left});
  expect(screen.queryByRole("button",{name:/미배정 검증자/})).not.toBeInTheDocument();
  expect(screen.getByRole("button",{name:/외부 검증자/})).toBeInTheDocument();expect(screen.getByRole("button",{name:/기록 검증자/})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox",{name:"이전 세션"}));expect(screen.getByRole("button",{name:/이전 검증자/})).toBeInTheDocument();
  fireEvent.change(screen.getByRole("combobox",{name:"그래프 주제 범위"}),{target:{value:"child"}});
  expect(view.container.querySelector(".hierarchy-trunk")).not.toBeInTheDocument();
  view.unmount();render(<GraphInspector node={assigned} currentTopicId="t"/>);expect(screen.getByText(/이 서버는 검증자 모델을 자동 실행하지 않습니다/)).toBeInTheDocument();
});

it("renders multicolor source marks and dims unrelated edges while keeping compact communication labels in the gap",async()=>{
  const css=document.createElement("style");css.textContent=readFileSync("src/web/session-graph.css","utf8");document.head.append(css);
  const nodes:Graph["nodes"]=[{...graph.nodes[0],id:"plan",role:"planner",label:"계획"},graph.nodes[0],
    {...graph.nodes[2],id:"figma",url:"https://www.figma.com/design/sample",subtitle:"figma"},
    {...graph.nodes[2],id:"slack",url:"https://example.slack.com/archives/thread",subtitle:"slack"},
    {...graph.nodes[2],id:"swift-local",label:"C:\\Project\\View.swift::body",url:undefined,subtitle:"file · 고정 원문"},
    {...graph.nodes[2],id:"swift-url",label:"원격 파일",url:"https://github.com/org/repo/blob/main/View.swift?raw=1",subtitle:"file"},
    ...["HouseRegister","MainActor","S8.2"].map(symbol=>({...graph.nodes[2],id:`swift-selector-${symbol}`,label:`Project.swift::${symbol}`,url:undefined,subtitle:"file · 고정 원문"})),
    {...graph.nodes[2],id:"swift-query",label:"Swift 6: find Foo.swift usages",url:undefined,subtitle:"search · 고정 원문"},
    {...graph.nodes[0],id:"swift-topic",kind:"topic",label:"Swift 6 요구사항"}];
  vi.spyOn(api,"sessionGraph").mockResolvedValue({...graph,nodes,edges:[
    {id:"request",from:"plan",to:"run",kind:"communication",status:"waiting",label:"계획 검토자 → 중재 요청 전송 대기"},
    {id:"reference",from:"slack",to:"plan",kind:"registered",label:"등록된 원문"},
    {id:"swift-edge",from:"swift-local",to:"run",kind:"delivered",label:"파일 전달 기록"},
  ]});
  const onSelect=vi.fn(),view=render(<SessionGraph topicId="t" onSelect={onSelect} onEdit={vi.fn()}/>);
  try {
    await screen.findByRole("button",{name:/러너 · 진행 중/});
    expect(screen.queryByRole("button",{name:/C:\\Project/})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:/원격 파일/})).not.toBeInTheDocument();
    expect(screen.queryByRole("button",{name:/Project\.swift::/})).not.toBeInTheDocument();
    expect(screen.queryByText("파일 전달 기록")).not.toBeInTheDocument();
    expect(screen.getByRole("button",{name:/Swift 6: find Foo.swift usages/})).toBeInTheDocument();
    expect(screen.getByRole("button",{name:/Swift 6 요구사항/})).toBeInTheDocument();
    expect(screen.getByText(/6\/6개 노드 표시/)).toBeInTheDocument();
    const fills=(name:string)=>new Set([...view.container.querySelectorAll(`.graph-node .platform-icon--${name} svg [fill]`)].map(element=>element.getAttribute("fill")));
    expect(fills("figma")).toEqual(new Set(["#24CB71","#FF7237","#00B6FF","#FF3737","#874FFF"]));
    expect(fills("slack")).toEqual(new Set(["#E01E5A","#36C5F0","#2EB67D","#ECB22E"]));
    const communication=view.container.querySelector(".edge-communication")!,reference=view.container.querySelector(".edge-registered")!;
    const normalOpacity=Number(getComputedStyle(reference).opacity);expect(normalOpacity).toBeGreaterThan(0);
    view.rerender(<SessionGraph topicId="t" selectedNodeId="run" onSelect={onSelect} onEdit={vi.fn()}/>);
    expect(Number(getComputedStyle(reference).opacity)).toBeLessThan(normalOpacity/2);
    expect(Number(getComputedStyle(communication).opacity)).toBeGreaterThan(normalOpacity);
    expect(communication).toHaveClass("edge-waiting","highlighted");expect(communication.querySelector("title")).toHaveTextContent("계획 검토자 → 중재 요청 전송 대기");
    const label=communication.querySelector("text")!,plan=screen.getByRole("button",{name:/계획 · 진행 중/}),run=screen.getByRole("button",{name:/러너 · 진행 중/});
    expect(label).toHaveTextContent("대기");expect(Number(label.getAttribute("x"))).toBeGreaterThan(parseFloat(plan.style.left)+parseFloat(plan.style.width));
    expect(Number(label.getAttribute("x"))).toBeLessThan(parseFloat(run.style.left));
  } finally {css.remove();}
});

it("keeps role nodes with the same session ID separate in layout, selection and settings",async()=>{
  const {useState}=await import("react");
  const planner:Graph["nodes"][number]={...graph.nodes[0],id:"session:t:planner:shared",role:"planner",label:"플래너",sessionId:"shared-session",settingsTargets:["planner"],details:[{label:"세션 ID",value:"shared-session"}]};
  const runner:Graph["nodes"][number]={...planner,id:"session:t:runner:shared",role:"runner",label:"러너",settingsTargets:["implementer"]};
  const previous:Graph["nodes"][number]={...planner,id:"session:t:reviewer:shared",role:"reviewer",label:"이전 검토자",historical:true,settingsTargets:[]};
  vi.spyOn(api,"sessionGraph").mockResolvedValue({...graph,nodes:[planner,runner,previous],edges:[]});
  const settings=vi.spyOn(api,"sessionSettings").mockImplementation(async(_id,target)=>({...sessionSettingsView(),target,criteria:undefined}));
  function Probe(){const [selected,setSelected]=useState<Graph["nodes"][number]|null>(null);return <><SessionGraph topicId="t" selectedNodeId={selected?.id} onSelect={setSelected} onEdit={vi.fn()}/><GraphInspector node={selected} currentTopicId="t"/></>;}
  render(<Probe/>);
  const plan=await screen.findByRole("button",{name:"플래너 · 진행 중 · shared-session"}),run=screen.getByRole("button",{name:"러너 · 진행 중 · shared-session"});
  expect(plan.style.top).toBe(run.style.top);expect(parseFloat(plan.style.left)).toBeLessThan(parseFloat(run.style.left));
  fireEvent.click(plan);expect(plan).toHaveAttribute("aria-pressed","true");expect(run).toHaveAttribute("aria-pressed","false");
  fireEvent.click(screen.getByRole("button",{name:/계획 작성 · 다음 실행 설정/}));await screen.findByRole("combobox",{name:"모델"});
  expect(settings).toHaveBeenLastCalledWith("t","planner");
  fireEvent.click(run);expect(run).toHaveAttribute("aria-pressed","true");expect(plan).toHaveAttribute("aria-pressed","false");
  expect(screen.queryByRole("button",{name:/계획 작성 · 다음 실행 설정/})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button",{name:/구현 · 다음 실행 설정/}));await screen.findByRole("combobox",{name:"모델"});expect(settings).toHaveBeenLastCalledWith("t","implementer");
  fireEvent.click(screen.getByRole("checkbox",{name:"이전 세션"}));fireEvent.click(screen.getByRole("button",{name:"이전 검토자 · 진행 중 · shared-session"}));
  expect(screen.getByRole("region",{name:"선택한 노드 상세"})).toHaveTextContent("shared-session");expect(screen.getByText(/과거 세션 기록은 읽기 전용/)).toBeInTheDocument();
  expect(settings).toHaveBeenCalledTimes(2);
});
