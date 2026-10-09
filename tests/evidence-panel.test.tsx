// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EvidencePanel } from "../src/web/EvidencePanel";
import { api } from "../src/web/api";
import type { EvidenceTopicState, EvidenceCatalog } from "../src/shared/externalEvidence";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const state = (ready = true): EvidenceTopicState => ({ plan: { scopeGeneration: 1, planEpoch: 1, planSHA256: "d".repeat(64) }, ready, digest: "a".repeat(64), sources: [{
  id: "b".repeat(64), label: "Planning", url: "https://team.atlassian.net/browse/APP-1", mode: "connector", intervalSeconds: 900,
  provider: "jira", resource: "team.atlassian.net/APP-1", selector: "", revision: "r1", contentHash: "c".repeat(64), checkedAt: null, error: null, nextCheckAt: 0,
}] });
const catalog = (): EvidenceCatalog => ({ version: "a".repeat(64), groupId: "g", roots: [], entries: [], history: [], coverage: { sources: 0, units: 0, complete: 0, pending: 0, failed: 0, candidates: 0, ready: true } });
beforeEach(() => { vi.spyOn(api, "evidenceCatalog").mockResolvedValue(catalog()); });
it("shows the excluded source and reason as a To-do while the engine remains ready", async () => {
  const current = state();
  vi.spyOn(api, "evidence").mockResolvedValue({ ...current, deferred: [{ sourceId: current.sources[0].id,
    label: "Unavailable contract", url: current.sources[0].url, reason: "HTTP 404" }] });
  render(<EvidencePanel topicId="t" busy={false} />);
  const todo = await screen.findByRole("region", { name: "근거 확보 To-do", hidden: true });
  expect(todo).toHaveTextContent("HTTP 404");
  expect(within(todo).getByRole("link", { name: "Unavailable contract", hidden: true })).toHaveAttribute("href", current.sources[0].url);
});
it("places separately registered Jira descendants under their parent root instead of showing six peers", async () => {
  vi.spyOn(api,"evidence").mockResolvedValue({...state(),sources:[]});
  const labels=["Root Jira","Form policy","Photo policy","Draft policy","Backend form","Backend draft"];
  const sources=labels.map((label,i)=>({...state().sources[0],id:String(i+1).repeat(64),label,url:`https://team.atlassian.net/browse/APP-${i+1}`}));
  const roots=sources.map((source,i)=>({id:`root-${i}`,sourceId:source.id,source,scope:"group" as const,owner:"g",required:true,
    status:"approved" as const,version:1,createdAt:0,approvedAt:0,lastCompleteAt:0,nextCheckAt:0}));
  const parents=[null,0,0,0,1,3];
  vi.spyOn(api,"evidenceCatalog").mockResolvedValue({...catalog(),roots,entries:sources.map((source,i)=>({
    rootId:"root-0",source:{...source,label:`Collected ${source.label}`},state:"approved" as const,progress:"complete" as const,error:null,
    discoveredFrom:parents[i]===null?[]:[{sourceId:sources[parents[i]!].id,unitId:"parent",relation:"child"}],
  }))});
  render(<EvidencePanel topicId="t" busy={false}/>);
  const parent=(await screen.findByRole("link",{name:"Root Jira"})).closest("article")!;
  expect(within(parent).getByRole("link",{name:"Form policy"})).toBeInTheDocument();
  const form=within(parent).getByRole("link",{name:"Form policy"}).closest("article")!;
  expect(within(form).getByRole("link",{name:"Backend form"})).toBeInTheDocument();
  const draft=within(parent).getByRole("link",{name:"Draft policy"}).closest("article")!;
  expect(within(draft).getByRole("link",{name:"Backend draft"})).toBeInTheDocument();
});
it("labels draft sources as task inputs and lets an idle standalone topic select its registered evidence group", async () => {
  const draft={...state(),plan:{...state().plan,planSHA256:null}};
  vi.spyOn(api,"evidence").mockResolvedValue(draft);
  const groupId="11111111-1111-4111-8111-111111111111";
  vi.spyOn(api,"evidenceCatalog").mockResolvedValue({...catalog(),groupId:null,groups:[{id:groupId,title:"Listing registration"}],groupLocked:false});
  const selection= pending<EvidenceCatalog>();
  const select=vi.spyOn(api,"selectEvidenceGroup").mockReturnValue(selection.promise);
  render(<EvidencePanel topicId="t" busy={false}/>);
  expect(await screen.findByRole("heading",{name:"이 작업에서 사용할 원문"})).toBeInTheDocument();
  expect(screen.queryByRole("heading",{name:"현재 계획에 연결된 원문"})).not.toBeInTheDocument();
  const groups=screen.getByRole("combobox",{name:"이 작업에 연결된 근거 묶음"});
  fireEvent.change(groups,{target:{value:groupId}});
  expect(groups).toBeDisabled();
  fireEvent.change(groups,{target:{value:groupId}});
  expect(select).toHaveBeenCalledExactlyOnceWith("t",catalog().version,groupId);
  await act(async()=>{selection.reject(new Error("Topic started a turn"));await selection.promise.catch(()=>{});});
  expect(await screen.findByRole("alert")).toHaveTextContent("Topic started a turn");
  expect(groups).toBeEnabled();
  select.mockResolvedValue(catalog());
  fireEvent.change(groups,{target:{value:groupId}});
  await waitFor(()=>expect(select).toHaveBeenCalledTimes(2));
});
function pending<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
// 원문 변경은 사실로 전달되고 영향 판단은 작업자·중재자가 한다(D6) — 패널은 원문 준비(root 승인) 상태만 보이고 영향 검토 양식·상태를 두지 않는다.
it("shows only source readiness and offers no impact review form", async () => {
  vi.spyOn(api, "evidence").mockResolvedValueOnce(state(false));
  const view = render(<EvidencePanel topicId="t" busy={false} />);
  expect(await screen.findByRole("heading", { name: /원문 근거 \(1\) · 원문 확인 필요/, hidden: true })).toBeInTheDocument();
  view.unmount();
  vi.spyOn(api, "evidence").mockResolvedValue(state());
  render(<EvidencePanel topicId="t" busy={false} />);
  expect(await screen.findByRole("heading", { name: /원문 근거 \(1\) · 원문 준비됨/, hidden: true })).toBeInTheDocument();
  expect(screen.queryByText(/영향 검토/)).not.toBeInTheDocument();
  expect(screen.queryByText(/검토 완료/)).not.toBeInTheDocument();
  expect(screen.queryByRole("textbox", { name: "원문 변경 영향", hidden: true })).not.toBeInTheDocument();
});
it("registers once while pending and ignores an older poll that finishes after the mutation", async () => {
  const old = pending<EvidenceCatalog>(); const write = pending<any>();
  vi.spyOn(api, "evidence").mockResolvedValue(state());
  vi.spyOn(api, "evidenceCatalog").mockReturnValueOnce(old.promise).mockResolvedValue({ ...catalog(), coverage: { ...catalog().coverage, sources: 77 } });
  const add = vi.spyOn(api, "addEvidenceRoot").mockReturnValue(write.promise);
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/원문 근거/));
  fireEvent.change(screen.getByLabelText("탐색 루트 이름"), { target: { value: "Planning" } });
  fireEvent.change(screen.getByLabelText("탐색 루트 링크"), { target: { value: "https://team.atlassian.net/browse/APP-1" } });
  const button = screen.getByRole("button", { name: "루트와 탐색 범위 승인·추가" });
  fireEvent.click(button); fireEvent.click(button);
  expect(add).toHaveBeenCalledTimes(1); expect(button).toBeDisabled();
  write.resolve({}); await screen.findByText(/자료 77개/);
  await act(async () => { old.resolve(catalog()); await old.promise; });
  expect(screen.getByText(/자료 77개/)).toBeInTheDocument();
  expect(add).toHaveBeenCalledWith("t", expect.objectContaining({ scope: "group", mode: "connector", url: "https://team.atlassian.net/browse/APP-1" }));
});

it("shows the app reader's next work after collection instead of silently completing", async () => {
  vi.spyOn(api, "evidence").mockResolvedValue(state(false));
  const collect = vi.spyOn(api, "collectEvidence").mockResolvedValue({ ...catalog(), hostPlan: {
    version: catalog().version, total: 1, nextCursor: null, pendingReview: 2,
    requests: [{ rootId: "root", sourceId: "b".repeat(64), url: sourceURL, label: "Planning",
      provider: "jira", resource: "team.atlassian.net/APP-1", selector: "", previousHash: null, previousCheckedAt: null,
      integration: "Atlassian Rovo", requiredReads: ["이슈 본문·전체 댓글", "모든 하위·연결 티켓과 외부 링크"] }],
  } });
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/원문 근거/));
  fireEvent.click(await screen.findByRole("button", { name: "수집 이어가기" }));
  expect(await screen.findByRole("complementary", { name: "앱 연결로 읽을 자료" })).toHaveTextContent("앱 연결로 읽을 원문 1개 · 링크 검수 대기 2개");
  expect(screen.getByRole("complementary")).toHaveTextContent("전체 댓글");
  expect(screen.getByRole("complementary")).toHaveTextContent("채팅에 원문 수집을 요청하세요");
  expect(collect).toHaveBeenCalledExactlyOnceWith("t");
});
it.each(["connector", "rest"] as const)("preserves the user's %s selection for login-protected general documents", async mode => {
  vi.spyOn(api,"evidence").mockResolvedValue(state(false));
  const add=vi.spyOn(api,"addEvidenceRoot").mockResolvedValue({});
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/원문 근거/));
  await screen.findByRole("button",{name:"수집 이어가기"});
  fireEvent.change(screen.getByLabelText("탐색 루트 이름"),{target:{value:"Private policy"}});
  fireEvent.change(screen.getByLabelText("탐색 루트 링크"),{target:{value:"https://docs.google.com/document/d/private/edit"}});
  fireEvent.change(screen.getByLabelText("원문 수집 방법"),{target:{value:mode}});
  fireEvent.click(screen.getByRole("button",{name:"루트와 탐색 범위 승인·추가"}));
  expect(add).toHaveBeenCalledWith("t",expect.objectContaining({mode,url:"https://docs.google.com/document/d/private/edit"}));
});
const sourceURL = "https://team.atlassian.net/browse/APP-1";

it("shows connection setup and shared scope and explicitly converts a source to REST once", async () => {
  const pendingChange = pending<any>();
  const current = { ...state(), connections: [{ sourceId: "b".repeat(64), configured: false, sharedTopics: 2 }] };
  vi.spyOn(api, "evidence").mockResolvedValue(current);
  const convert = vi.spyOn(api, "useRestEvidence").mockReturnValue(pendingChange.promise);
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/원문 근거/));
  expect(await screen.findByText(/MCP 읽기 연결/)).toHaveTextContent("공유 주제 2개");
  expect(screen.queryByText(/서버 읽기 인증 설정 필요/)).not.toBeInTheDocument();
  const button = screen.getByRole("button", { name: "서버 수집으로 전환 (공유 주제 모두 적용)" });
  fireEvent.click(button); fireEvent.click(button); expect(convert).toHaveBeenCalledTimes(1);
  pendingChange.reject(new Error("읽기 인증 설정이 필요합니다."));
  expect(await screen.findByRole("alert")).toHaveTextContent("읽기 인증 설정");
  expect(button).toBeEnabled();
});

// Public boundary: opening evidence shows every platform and keeps a discovered link's selection tied to its root.
// Existing cases cover failed mutations and pending input; pixel layout is verified in the browser separately.
it("groups roots and cross-platform discoveries without changing which root receives the selection", async () => {
  const jira = state().sources[0];
  const figma = { ...jira, id: "f".repeat(64), provider: "figma" as const, label: "Design", url: "https://www.figma.com/design/design?node-id=1-2" };
  const sheet = { ...jira, id: "e".repeat(64), provider: "sheets" as const, label: "Policy", url: "https://docs.google.com/spreadsheets/d/policy/edit" };
  const backend = { ...jira, id: "c".repeat(64), provider: "document" as const, label: "API", url: "https://example.com/docs/api" };
  const roots = [jira, figma, sheet, backend].map((source, index) => ({
    id: `root-${index}`, sourceId: source.id, source, scope: "group" as const, owner: "g", status: "approved" as const,
    required: true, version: 1, createdAt: 0, approvedAt: 0, lastCompleteAt: 0, nextCheckAt: 0,
  }));
  const candidate = { ...figma, id: "a".repeat(64), label: "Linked design" };
  vi.spyOn(api, "evidence").mockResolvedValue({ ...state(), sources: [jira, figma, sheet, backend] });
  vi.spyOn(api, "evidenceCatalog").mockResolvedValue({ ...catalog(), roots, entries: [{
    rootId: roots[0].id, source: candidate, state: "candidate", progress: "pending", error: null, discoveredFrom: [],
  }] });
  const select = vi.spyOn(api, "selectEvidence").mockResolvedValue(catalog());
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/원문 근거/));
  const scope = await screen.findByRole("region", { name: "근거 탐색 범위" });
  for (const [platform, label] of [["Jira", "Planning"], ["Figma", "Design"], ["Google Sheets", "Policy"], ["Backend API·웹 문서", "API"]]) {
    const groups = within(scope).getAllByRole("group", { name: `${platform} 자료` });
    expect(groups.some(group => within(group).queryByRole("link", { name: label }))).toBe(true);
  }
  expect(within(scope).queryByRole("group", { name: "Confluence 자료" })).not.toBeInTheDocument();
  fireEvent.click(within(scope).getAllByText("연결 자료와 수집 상태")[0]);
  const linked = await within(scope).findByRole("link", { name: "Linked design" });
  fireEvent.click(within(linked.parentElement!).getByRole("button", { name: "이 루트에서 제외" }));
  await waitFor(() => expect(select).toHaveBeenCalledExactlyOnceWith("t", catalog().version, "root-0", "reject", candidate.id));
});

it("keeps a closed plan's source links in collapsed history without live source controls", async () => {
  vi.spyOn(api, "evidence").mockResolvedValue(state());
  const convert = vi.spyOn(api, "useRestEvidence");
  render(<EvidencePanel topicId="t" busy={false} archived />);
  const history = await screen.findByRole("group", { name: "완료 당시 참고 링크" });
  expect(history).not.toHaveAttribute("open");
  expect(screen.queryByRole("region", { name: "현재 계획에 연결된 원문" })).not.toBeInTheDocument();
  fireEvent.click(within(history).getByText("완료 당시 참고 링크 (1개)"));
  expect(within(history).getByRole("link", { name: "Planning" })).toHaveAttribute("href", sourceURL);
  expect(within(history).queryByRole("button")).not.toBeInTheDocument();
  expect(convert).not.toHaveBeenCalled();
});

it("keeps a closed stage's preserved links apart from future links without a re-review gate", async () => {
  vi.spyOn(api, "evidence").mockResolvedValue(state());
  const add = vi.spyOn(api, "addEvidenceRoot").mockResolvedValue({});
  render(<EvidencePanel topicId="t" busy={false} archived />);
  const history = await screen.findByRole("group", { name: "완료 당시 참고 링크" });
  expect(history).not.toHaveTextContent("재검토");
  fireEvent.click(within(history).getByText(/완료 당시 참고 링크 \(1개\)/));
  await waitFor(() => expect(screen.getByRole("button", { name: "루트와 탐색 범위 승인·추가" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("탐색 루트 이름"), { target: { value: "Future plan" } });
  fireEvent.change(screen.getByLabelText("탐색 루트 링크"), { target: { value: sourceURL } });
  fireEvent.click(screen.getByRole("button", { name: "루트와 탐색 범위 승인·추가" }));
  await waitFor(() => expect(add).toHaveBeenCalledExactlyOnceWith("t", expect.objectContaining({ label: "Future plan" })));
  expect(within(history).getByRole("link", { name: "Planning" })).toHaveAttribute("href", sourceURL);
});
