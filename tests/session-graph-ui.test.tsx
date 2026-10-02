// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
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
  vi.spyOn(api,"sessionGraph").mockResolvedValue(graph);const onSelect=vi.fn();
  const view=render(<SessionGraph topicId="t" onSelect={onSelect} onEdit={vi.fn()} />);
  fireEvent.click(await screen.findByRole("button",{name:"러너 · 진행 중 · run-id"}));expect(onSelect).toHaveBeenLastCalledWith(graph.nodes[0],true);
  expect(screen.queryByRole("button",{name:/이전 러너/})).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox",{name:"이전 세션"}));expect(screen.getByRole("button",{name:/이전 러너/})).toBeInTheDocument();
  fireEvent.click(screen.getByRole("checkbox",{name:"원문"}));expect(screen.queryByRole("button",{name:/요구 원문/})).not.toBeInTheDocument();
  view.unmount();render(<GraphInspector node={graph.nodes[0]} currentTopicId="t" onTopic={vi.fn()} onSession={vi.fn()} onEvidence={vi.fn()} />);
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
