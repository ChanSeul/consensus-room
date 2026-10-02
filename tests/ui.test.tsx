// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/web/App";
import { api } from "../src/web/api";
import type { SessionSettingsTarget, SessionSettingsView } from "../src/shared/sessionSettings";
import type { RoutingView, TimelineEvent, Topic, TopicDetail } from "../src/shared/contracts";

const eventSources: FakeEventSource[] = [];

beforeEach(() => {
  eventSources.length = 0;
  vi.spyOn(api,"sessionGraph").mockImplementation(async topicId => ({ topicId, nodes: [
    {id:"planner",kind:"session",topicId,lane:topicId,label:"플래너",subtitle:"claude",role:"planner",settingsTargets:["planner"],status:"idle",historical:false,sessionId:"claude-session",details:[]},
    {id:"reviewer",kind:"session",topicId,lane:topicId,label:"계획 검토자",subtitle:"claude",role:"plan-reviewer",settingsTargets:["plan-review"],status:"idle",historical:false,sessionId:"reviewer-session",details:[]},
  ],edges:[],lanes:[{id:topicId,title:"주제"}],warnings:[],checkedAt:new Date().toISOString()}));
  vi.spyOn(api,"listWorkGroups").mockResolvedValue([]);
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  });
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.spyOn(api, "getActivity").mockResolvedValue({
    state: "IMPLEMENTING", runningAction: true, lastChangeAt: "2026-09-08T01:00:00.000Z", lastChangedPath: "a.swift",
    scanned: 1, truncated: false, autoRetryAt: null, checkedAt: "2026-09-08T01:00:05.000Z",
  });
  vi.spyOn(api, "getConfig").mockResolvedValue({
    repositoryPath: "/Users/example/sample-ios",
    memoryDirectory: "/Users/example/sample-memory",
    defaultAgentSettings: {
      claude: { model: "opus", effort: "xhigh" },
      codex: { model: "gpt-5.6-sol", effort: "xhigh" },
    },
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("방 화면의 비동기 결과", () => {
  it("중재 세션의 기록을 보여 주고 웹 지시 입력란과 위임 토글은 제공하지 않는다", async () => {
    const topic = makeTopic();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic, [timelineEvent(1, "중재 세션에서 전달한 지시")]));
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "대화창" }));
    expect(await screen.findByText("중재 세션에서 전달한 지시")).toBeInTheDocument();
    expect(screen.queryByPlaceholderText("두 에이전트가 함께 알아야 할 내용을 적어 주세요.")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "메시지 종류" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "보내기" })).not.toBeInTheDocument();
    expect(screen.queryByRole("switch", { name: "자율중재 위임" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "긴 작업을 단계로 나누기" })).not.toBeInTheDocument();
    const overview = screen.getByRole("region", { name: "주제 목표와 진행 방식" });
    const controls = screen.getByRole("region", { name: "작업 실행" });
    expect(overview.closest(".inspector-scroll")?.firstElementChild).toBe(overview);
    expect(controls.closest(".chat-pane")).not.toBeNull();
    expect(screen.getByText("검토 쟁점").closest("details")?.nextElementSibling).toBeNull();
    for (const label of ["범위 지정 커밋", "푸시 승인", "주제 닫기", "빌드 트리 정리"])
      expect(screen.queryByRole("button", { name: label })).not.toBeInTheDocument();
  });

  it("늦게 끝난 전체 조회가 먼저 받은 SSE 메시지를 지우지 않는다", async () => {
    const topic = makeTopic();
    topic.participants = ["claude", "codex"].map(role => ({ role: role as "claude" | "codex", sessionId: `${role}-session`, mode: "attached", acknowledgedPlanSHA256: null }));
    const first = timelineEvent(1, "첫 기록");
    const second = timelineEvent(2, "SSE로 먼저 도착한 기록");
    const staleRefresh = deferred<TopicDetail>();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic")
      .mockResolvedValueOnce(makeDetail(topic, [first]))
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValue(makeDetail(topic, []));
    vi.spyOn(api, "runAction").mockResolvedValue({ accepted: true, actionId: "plan", topic });

    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "대화창" }));
    await screen.findByText("첫 기록");
    await waitFor(() => expect(eventSources).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "합의 시작" }));
    await waitFor(() => expect(api.getTopic).toHaveBeenCalledTimes(2));

    eventSources[0].emit(second);
    expect(await screen.findByText("SSE로 먼저 도착한 기록")).toBeInTheDocument();
    staleRefresh.resolve(makeDetail(topic, [first]));

    await waitFor(() => expect(screen.getByText("SSE로 먼저 도착한 기록")).toBeInTheDocument());
  });
});

function settingsFor(target:SessionSettingsTarget):SessionSettingsView {
  return {target,editable:true,revision:"actual-assignment-revision",appliesTo:"next-execution",mixed:false,models:["opus","sonnet"],efforts:["medium","high"],operations:[{operation:target==="plan-review"?"audit":target==="implementer"?"implement":"plan",provider:"claude",model:"opus",effort:"medium",scope:"topic:topic-1"}]};
}

describe("저장소와 에이전트 실행 설정", () => {
  it("시작 안내는 세 가지 경로를 보여 주고 웹 지시를 입력받지 않는다", async () => {
    vi.spyOn(api, "listTopics").mockResolvedValue([]);
    const create = vi.spyOn(api, "createTopic");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "작업 시작 방식 보기" }));
    expect(screen.getByRole("heading", { name: "Goal에서 시작" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Source에서 시작" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "브레인스토밍에서 시작" })).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "주제 이름" })).not.toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });

  it("연결된 세션을 교체하지 않고 Claude 모델과 추론 강도만 저장한다", async () => {
    const topic = {
      ...makeTopic(),
      participants: [{
        role: "claude" as const,
        sessionId: "claude-session",
        mode: "attached" as const,
        acknowledgedPlanSHA256: null,
      }],
    };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));
    const attach = vi.spyOn(api, "attachParticipant").mockResolvedValue(topic);
    vi.spyOn(api,"sessionSettings").mockResolvedValue(settingsFor("planner"));
    const update=vi.spyOn(api,"updateSessionSettings").mockImplementation(async()=>{
      vi.mocked(api.sessionGraph).mockResolvedValue({topicId:topic.id,nodes:[{id:"planner",kind:"session",topicId:topic.id,lane:topic.id,label:"플래너",subtitle:"claude",role:"planner",settingsTargets:["planner"],status:"idle",historical:false,sessionId:"claude-session",details:[{label:"플래너 현재 설정",value:"saved-route-sonnet-high"},{label:"세션 프로필",value:"기본 배정"}]}],edges:[],lanes:[{id:topic.id,title:"주제"}],warnings:[],checkedAt:"after-save"});
      const next=settingsFor("planner");return {...next,operations:next.operations.map(operation=>({...operation,model:"sonnet",effort:"high" as const}))};
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^플래너 ·/ }));
    fireEvent.click(screen.getByRole("button", {name:/계획 작성 · 다음 실행 설정/}));
    fireEvent.change(await screen.findByRole("combobox", { name: "모델" }), { target: { value: "sonnet" } });
    fireEvent.change(screen.getByRole("combobox", { name: "추론 강도" }), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "다음 실행 설정 저장" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(topic.id, {
      target:"planner",revision:"actual-assignment-revision",model: "sonnet",
      effort: "high",
    }));
    expect(attach).not.toHaveBeenCalled();
    expect(await screen.findByText("saved-route-sonnet-high")).toBeInTheDocument();
    expect(screen.getByText("세션 생성 시 프로필")).toBeInTheDocument();
    expect(screen.getByRole("combobox",{name:"모델"})).toHaveValue("sonnet");
    expect(api.sessionGraph).toHaveBeenCalledTimes(2);
  });

  it("미연결 구현 역할도 기본 좌석과 다른 실제 실행 설정을 편집한다",async()=>{
    const topic=withImplementationOverride(makeTopic());
    vi.spyOn(api,"listTopics").mockResolvedValue([topic]);vi.spyOn(api,"getTopic").mockResolvedValue(makeDetail(topic));
    vi.mocked(api.sessionGraph).mockResolvedValue({topicId:topic.id,nodes:[{id:"runner",kind:"session",topicId:topic.id,lane:topic.id,label:"러너",subtitle:"claude",role:"runner",settingsTargets:["implementer"],status:"unconnected",historical:false,sessionId:null,details:[]}],edges:[],lanes:[{id:topic.id,title:"주제"}],warnings:[],checkedAt:"now"});
    vi.spyOn(api,"sessionSettings").mockResolvedValue(settingsFor("implementer"));const update=vi.spyOn(api,"updateSessionSettings").mockResolvedValue(settingsFor("implementer"));
    const legacy=vi.spyOn(api,"updateAgentSettings"),attach=vi.spyOn(api,"attachParticipant");
    render(<App/>);fireEvent.click(await screen.findByRole("button",{name:/러너 · 미연결/}));
    fireEvent.click(screen.getByRole("button",{name:/구현 · 다음 실행 설정/}));
    fireEvent.change(await screen.findByRole("combobox",{name:"모델"}),{target:{value:"sonnet"}});
    fireEvent.click(screen.getByRole("button",{name:"다음 실행 설정 저장"}));
    await waitFor(()=>expect(update).toHaveBeenCalledWith(topic.id,{target:"implementer",revision:"actual-assignment-revision",model:"sonnet",effort:"medium"}));
    expect(legacy).not.toHaveBeenCalled();expect(attach).not.toHaveBeenCalled();
  });


});

function withImplementationOverride(topic: Topic): Topic {
  return {
    ...topic,
    agentSettings: {
      ...topic.agentSettings,
      claude: { model: "fable", effort: "xhigh", implementation: { model: "opus", effort: "xhigh" } },
    },
  };
}

// 엔진 개편 E2c C3 — 역할과 실제 실행 AI 를 나눠 보여 준다. 실제 AI 는 토픽 상세의 routing(경로·세션 바인딩)과 이벤트의 경로 기록에서만 읽는다.
describe("역할과 실제 실행 AI", () => {
  const TOPIC_SCOPE = "topic:topic-1";
  // 서버가 정한 좌석별 현재 작업(routing.current) — 기본은 계획 감사 단계(CODEX_AUDIT: 작성자는 다음 개정, 검토자는 감사).
  function routing(overrides: Partial<Record<string, RoutingView["jobs"][number]>> = {},
    current: RoutingView["current"] = { author: { role: "planner", operation: "revision" }, reviewer: { role: "reviewer", operation: "audit" } }): RoutingView {
    const jobs: RoutingView["jobs"] = [
      ["planner", "plan"], ["planner", "revision"], ["implementer", "implement"], ["reviewer", "audit"], ["reviewer", "review"],
    ].map(([role, operation]) => overrides[`${role}/${operation}`] ?? {
      role: role as "planner" | "implementer" | "reviewer", operation, refusal: null, inheritsFrom: null,
      route: { provider: role === "reviewer" ? "codex" : "claude", participant: role === "reviewer" ? "codex" : "claude", profileId: null,
        basis: { kind: "default" }, settings: role === "reviewer" ? { model: "gpt-5.6-sol", effort: "xhigh" } : { model: "opus", effort: "xhigh" } },
    });
    return { jobs, current, sessions: [
      { seat: "author", sessionId: "claude-session", binding: { provider: "claude", participant: "claude", profileId: null, basis: { kind: "default" } } },
      { seat: "plan-review", sessionId: "reviewer-session", binding: { provider: "claude", participant: "reviewer-claude", profileId: "claude-reviewer",
        basis: { kind: "assignment", scope: TOPIC_SCOPE, role: "reviewer", operation: "", version: 2 } } },
      { seat: "implementation", sessionId: null, binding: null },
      { seat: "code-review", sessionId: null, binding: null },
    ] };
  }
  const claudeReviewer: RoutingView["jobs"][number] = { role: "reviewer", operation: "audit", refusal: null, inheritsFrom: null, route: {
    provider: "claude", participant: "reviewer-claude", profileId: "claude-reviewer",
    basis: { kind: "assignment", scope: TOPIC_SCOPE, role: "reviewer", operation: "", version: 2 }, settings: { model: "claude-opus-5-5", effort: "high" } } };
  function auditing(): Topic {
    return { ...makeTopic(), state: "CODEX_AUDIT", participants: [
      { role: "claude", sessionId: "claude-session", mode: "attached", acknowledgedPlanSHA256: null },
      { role: "codex", sessionId: "reviewer-session", mode: "attached", acknowledgedPlanSHA256: null },
    ] };
  }





  it("타임라인: 경로가 기록된 결과는 역할과 실제 AI 를, 경로가 없는 기록은 좌석 역할만 보여 준다(추측한 AI 를 붙이지 않는다)", async () => {
    const topic = auditing();
    const routed: TimelineEvent = { ...timelineEvent(1, "감사 결과"), actor: "codex", kind: "agent_output",
      payload: { route: { provider: "claude", participant: "reviewer-claude", profileId: "claude-reviewer", job: { role: "reviewer", operation: "audit" } } } };
    const unrouted: TimelineEvent = { ...timelineEvent(2, "계획 1판을 저장했습니다."), actor: "claude", kind: "agent_output" };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic, [routed, unrouted]), routing: routing({ "reviewer/audit": claudeReviewer }) });
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "대화창" }));
    const routedMessage = (await screen.findByText("감사 결과")).closest("article")!;
    expect(routedMessage).toHaveTextContent("검토자 · Claude");
    const unroutedMessage = screen.getByText("계획 1판을 저장했습니다.").closest("article")!;
    expect(unroutedMessage.querySelector(".message-meta strong")).toHaveTextContent(/^작성자$/);
  });





  it("검토 노드는 기본 Codex 좌석 대신 실제 배정된 Claude 설정을 편집한다", async () => {
    const topic=auditing();vi.spyOn(api,"listTopics").mockResolvedValue([topic]);
    vi.spyOn(api,"getTopic").mockResolvedValue({...makeDetail(topic),routing:routing({"reviewer/audit":claudeReviewer})});
    const get=vi.spyOn(api,"sessionSettings").mockResolvedValue(settingsFor("plan-review"));
    render(<App/>);fireEvent.click(await screen.findByRole("button",{name:/^계획 검토자 ·/}));
    fireEvent.click(screen.getByRole("button",{name:/계획 검토 · 다음 실행 설정/}));
    expect(await screen.findByRole("combobox",{name:"모델"})).toHaveValue("opus");
    expect(get).toHaveBeenCalledWith(topic.id,"plan-review");expect(screen.getByText("claude · opus · medium")).toBeInTheDocument();
    expect(screen.queryByRole("textbox",{name:"Codex 모델"})).not.toBeInTheDocument();
  });
});

describe("변경 요청의 Idempotency-Key", () => {
  it("응답을 받지 못한 요청을 같은 내용으로 다시 보내면 같은 키를 쓰고, 성공한 뒤에는 새 키를 쓴다", async () => {
    const sent: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get("idempotency-key"));
      if (sent.length === 1) throw new TypeError("Failed to fetch");
      return jsonResponse(200, { accepted: true, actionId: "note", topic: makeTopic() });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { kind: "note" as const, body: "응답이 사라진 요청" };

    await expect(api.postMessage("topic-1", input)).rejects.toThrow("Failed to fetch");
    await api.postMessage("topic-1", input);
    await api.postMessage("topic-1", input);

    expect(sent).toHaveLength(3);
    expect(sent[0]).toBeTruthy();
    expect(sent[1]).toBe(sent[0]);
    expect(sent[2]).not.toBe(sent[1]);
  });

  it("이미 결과가 확정된 409는 키를 놓아 다음 클릭이 곧바로 진행된다", async () => {
    const sent: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get("idempotency-key"));
      if (sent.length === 1) throw new TypeError("Failed to fetch");
      if (sent.length === 2) {
        return jsonResponse(409, { error: "원래 요청은 재실행할 수 없습니다.", status: "failed" });
      }
      return jsonResponse(200, { accepted: true, actionId: "note", topic: makeTopic() });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { kind: "note" as const, body: "결과가 이미 확정된 요청" };

    await expect(api.postMessage("topic-1", input)).rejects.toThrow("Failed to fetch");
    await expect(api.postMessage("topic-1", input)).rejects.toThrow("원래 요청은 재실행할 수 없습니다.");
    await api.postMessage("topic-1", input);

    expect(sent[1]).toBe(sent[0]);
    expect(sent[2]).not.toBe(sent[1]);
  });

  it("status가 없는 409도 확정된 결과로 보고 키를 놓는다", async () => {
    const sent: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get("idempotency-key"));
      return jsonResponse(409, { error: "같은 Idempotency-Key로 이미 요청한 action입니다." });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(api.runAction("topic-1", "plan")).rejects.toThrow("이미 요청한 action");
    await expect(api.runAction("topic-1", "plan")).rejects.toThrow("이미 요청한 action");

    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
  });

  it("아직 처리 중이라는 409에서는 같은 키를 유지한다", async () => {
    const sent: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get("idempotency-key"));
      return jsonResponse(409, { error: "같은 요청이 아직 처리 중입니다.", status: "running" });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { kind: "note" as const, body: "아직 처리 중인 요청" };

    await expect(api.postMessage("topic-1", input)).rejects.toThrow("아직 처리 중");
    await expect(api.postMessage("topic-1", input)).rejects.toThrow("아직 처리 중");

    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
  });

  it("서버가 결과를 알려 준 실패는 다음 요청에 새 키를 쓴다", async () => {
    const sent: Array<string | null> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers).get("idempotency-key"));
      return jsonResponse(500, { error: "커밋할 변경이 없습니다." });
    });
    vi.stubGlobal("fetch", fetchMock);
    const input = { kind: "note" as const, body: "서버가 거절한 요청" };

    await expect(api.postMessage("topic-1", input)).rejects.toThrow("커밋할 변경이 없습니다.");
    await expect(api.postMessage("topic-1", input)).rejects.toThrow("커밋할 변경이 없습니다.");

    expect(sent).toHaveLength(2);
    expect(sent[1]).not.toBe(sent[0]);
  });
});

class FakeEventSource {
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent<string>) => void>();

  constructor(_url: string, _options?: EventSourceInit) {
    eventSources.push(this);
  }

  addEventListener(type: string, listener: EventListenerOrEventListenerObject): void {
    this.listeners.set(type, listener as (event: MessageEvent<string>) => void);
  }

  close(): void {}

  emit(event: TimelineEvent): void {
    this.listeners.get("timeline")?.(new MessageEvent("timeline", { data: JSON.stringify(event) }));
  }
}

describe("계획 전 선택형 논의", () => {
  it("같은 AI의 두 참여자를 버튼과 발언의 접근 가능한 이름으로 구분한다", async () => {
    const topic = { ...makeTopic(), state: "BRAINSTORM_READY" as const };
    const jobs: RoutingView["jobs"] = (["planner", "reviewer"] as const).map((role, index) => ({
      role, operation: "brainstorm", refusal: null, inheritsFrom: null,
      route: { provider: "codex", participant: `person-${index}`, profileId: "shared-model", basis: { kind: "default" }, settings: { model: "gpt-6-astra", effort: "high" } },
    }));
    const events = jobs.map((job, index) => ({ ...timelineEvent(index + 1, `발언 ${index + 1}`), actor: index === 0 ? "claude" as const : "codex" as const,
      kind: "agent_output" as const, payload: { route: { ...job.route, job: { role: job.role, operation: "brainstorm" } } } }));
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic, events), routing: {
      jobs, sessions: [], current: { author: { role: "planner", operation: "brainstorm" }, reviewer: { role: "reviewer", operation: "brainstorm" } },
    } });
    render(<App />);
    fireEvent.click(await screen.findByRole("tab", { name: "대화창" }));
    await screen.findByText("발언 1");
    expect(screen.getByText("논의 참여자 1 · Codex")).toBeInTheDocument();
    expect(screen.getByText("논의 참여자 2 · Codex")).toBeInTheDocument();
  });

  it("논의의 Goal 결정은 중재 세션으로 안내한다", async () => {
    const topic: Topic = { ...makeTopic(), state: "BRAINSTORM_READY", participants: ["claude", "codex"].map(role => ({
      role: role as "claude" | "codex", sessionId: `${role}-session`, mode: "created", acknowledgedPlanSHA256: null,
    })) };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));
    const run = vi.spyOn(api, "runAction");
    render(<App />);
    expect(await screen.findByRole("button", { name: "한 바퀴 논의" })).toBeEnabled();
    expect(screen.getByText("Goal 확정·계획 전환은 중재 세션에서 진행합니다.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "결론과 다음 행동" })).not.toBeInTheDocument();
    expect(run).not.toHaveBeenCalled();
  });

});

function makeTopic(): Topic {
  return {
    id: "topic-1",
    slug: "ui-race",
    title: "UI 경합 검증",
    repositoryPath: "/tmp/repository",
    baseRef: "develop",
    worktreePath: "/tmp/worktree",
    branchPrefix: "consensus",
    requestedBranchName: null,
    predecessorTopicId: null,
    branchName: null,
    state: "DRAFT",
    scopeGeneration: 1,
    planEpoch: 1,
    planRevision: 0,
    planSHA256: null,
    approvedPlanSHA256: null,
    agentSettings: {
      claude: { model: "opus", effort: "xhigh" },
      codex: { model: "gpt-5.6-sol", effort: "xhigh" },
    },
    participants: [],
    createdAt: "2026-08-23T00:00:00.000Z",
    updatedAt: "2026-08-23T00:00:00.000Z",
    lastError: null,
  };
}

function makeDetail(
  topic: Topic,
  timeline: TimelineEvent[] = [],
  orphanCommitOID: string | null = null,
): TopicDetail {
  return {
    topic,
    timeline,
    currentPlan: null,
    previousPlan: null,
    consensus: null,
    implementationReport: null,
    codexReview: null,
    changedPaths: [],
    orphanCommitOID,
    deliveryRecovery: null,
  };
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": "application/json" }),
    json: async () => body,
  } as unknown as Response;
}

function timelineEvent(sequence: number, body: string): TimelineEvent {
  return {
    id: sequence,
    topicId: "topic-1",
    sequence,
    scopeGeneration: 1,
    actor: "system",
    kind: "system",
    state: "DRAFT",
    body,
    payload: {},
    createdAt: `2026-08-23T00:00:0${sequence}.000Z`,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => { resolve = next; });
  return { promise, resolve };
}

it("예산 증액의 늦은 응답은 다른 토픽의 예산을 덮지 않는다",async()=>{
 const a={...makeTopic(),state:"USER_DECISION_REQUIRED" as const},b={...makeTopic(),id:"topic-b",title:"다른 토픽",state:"USER_DECISION_REQUIRED" as const};
 vi.spyOn(api,"listTopics").mockResolvedValue([a,b]);vi.spyOn(api,"getTopic").mockImplementation(async id=>makeDetail(id===a.id?a:b));
 const account=(id:string,input:number)=>({id,policy:{execution:{inputTokens:100,outputTokens:100,durationMs:60000},total:{inputTokens:1000,outputTokens:1000,durationMs:600000}},used:{inputTokens:input,outputTokens:0,durationMs:0},startedAt:0,pause:{reason:"중단",detectedAt:0,deadline:60000},version:1,source:"test"});
 vi.mocked(api.getActivity).mockImplementation(async id=>({state:"USER_DECISION_REQUIRED",runningAction:false,lastChangeAt:null,lastChangedPath:null,scanned:0,truncated:false,autoRetryAt:null,checkedAt:"now",budget:account(id,id===a.id?111:222)}));
 const pending=deferred<any>();vi.spyOn(api,"runAction").mockReturnValue(pending.promise);
 render(<App/>);fireEvent.click(await screen.findByRole("button",{name:"예산 추가 후 재개"}));
 expect(screen.queryByRole("button",{name:"다시 시도"})).not.toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:"증액하고 재개"}));
 fireEvent.click(screen.getByRole("button",{name:/다른 토픽/}));
 await screen.findByText(/입력 222/);
 pending.resolve({accepted:true,actionId:"grant",topic:a,resumeBlocked:"이전 토픽의 추가 예산 안내"});
 await waitFor(()=>expect(api.getActivity).toHaveBeenCalledWith(a.id));
 expect(screen.getByText(/입력 222/)).toBeInTheDocument();expect(screen.queryByText(/입력 111/)).not.toBeInTheDocument();expect(screen.queryByText("이전 토픽의 추가 예산 안내")).not.toBeInTheDocument();
});

it("추가 승인 뒤 예산이 부족하면 안내를 표시하고 토픽 전환 시 지운다",async()=>{
 const a={...makeTopic(),state:"USER_DECISION_REQUIRED" as const},b={...makeTopic(),id:"notice-b",title:"다른 승인 토픽",state:"USER_DECISION_REQUIRED" as const};
 vi.spyOn(api,"listTopics").mockResolvedValue([a,b]);vi.spyOn(api,"getTopic").mockImplementation(async id=>makeDetail(id===a.id?a:b));
 vi.mocked(api.getActivity).mockResolvedValue({state:"USER_DECISION_REQUIRED",runningAction:false,lastChangeAt:null,lastChangedPath:null,scanned:0,truncated:false,autoRetryAt:null,checkedAt:"now",revisionPaused:true,revisionAllowance:{topicId:a.id,used:3,limit:3,version:1,firstPlanUsed:true,historyIncomplete:false,startedAt:"now"}});
 vi.spyOn(api,"runAction").mockResolvedValue({accepted:true,actionId:"grant",topic:a,resumeBlocked:"승인은 저장했습니다. 재개하려면 예산을 추가하세요."} as any);
 render(<App/>);fireEvent.click(await screen.findByRole("button",{name:"재작성 1회 추가 승인 후 재개"}));
 expect(await screen.findByText("승인은 저장했습니다. 재개하려면 예산을 추가하세요.")).toBeInTheDocument();
 fireEvent.click(screen.getByRole("button",{name:/다른 승인 토픽/}));
 await waitFor(()=>expect(screen.queryByText("승인은 저장했습니다. 재개하려면 예산을 추가하세요.")).not.toBeInTheDocument());
});

it("scrollIntoView 반환값을 effect 정리 함수로 사용하지 않는다",async()=>{
 Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn(()=>Promise.resolve())});
 vi.spyOn(api,"listTopics").mockResolvedValue([makeTopic()]);vi.spyOn(api,"getTopic").mockResolvedValue(makeDetail(makeTopic(),[timelineEvent(1,"스크롤 확인")]));
 const view=render(<App/>);fireEvent.click(await screen.findByRole("tab",{name:"대화창"}));
 await waitFor(()=>expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
 expect(()=>view.unmount()).not.toThrow();
});

it("discovers mediator-created roots and child progress while the selected root has no events", async () => {
  vi.useFakeTimers();Object.defineProperty(document,"hidden",{configurable:true,value:false});
  const root:Topic={...makeTopic(),id:"root",title:"외부에서 시작한 큰 그림",topicKind:"group",parentTopicId:null};
  const child:Topic={...makeTopic(),id:"child",title:"외부 하위 작업",parentTopicId:root.id};
  let topics:Topic[]=[];vi.spyOn(api,"listTopics").mockImplementation(async()=>topics);vi.spyOn(api,"getTopic").mockResolvedValue(makeDetail(root));
  const view=render(<App/>);
  try {
    await act(async()=>{});expect(screen.getByText("아직 주제가 없습니다.")).toBeInTheDocument();
    topics=[root,child];await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
    expect(screen.getByRole("button",{name:/Root.*외부에서 시작한 큰 그림.*0\/1/})).toBeInTheDocument();
    topics=[root,{...child,state:"CLOSED",updatedAt:"2026-10-02T00:00:00.000Z"}];
    await act(async()=>{await vi.advanceTimersByTimeAsync(10_000);});
    expect(screen.getByRole("button",{name:/Root.*외부에서 시작한 큰 그림.*1\/1/})).toBeInTheDocument();
  } finally {view.unmount();vi.useRealTimers();}
});
