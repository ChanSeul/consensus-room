// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/web/App";
import { api } from "../src/web/api";
import type { RoutingView, TimelineEvent, Topic, TopicDetail } from "../src/shared/contracts";
import type { WorkGroupView } from "../src/shared/workGroups";

const eventSources: FakeEventSource[] = [];

beforeEach(() => {
  eventSources.length = 0;
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
  vi.spyOn(api, "getMediationAutonomy").mockResolvedValue({
    autonomy: "on", set_at: "2026-09-08T01:41:01Z", set_by: "example-user", note: "", history: [], unset: false,
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
  it("메시지 전송이 실패하면 사용자가 쓴 내용을 지우지 않는다", async () => {
    const topic = makeTopic();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));
    vi.spyOn(api, "postMessage").mockRejectedValue(new Error("네트워크 연결에 실패했습니다."));

    render(<App />);
    const editor = await screen.findByPlaceholderText("두 에이전트가 함께 알아야 할 내용을 적어 주세요.");
    fireEvent.change(editor, { target: { value: "지워지면 안 되는 근거" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));

    expect(await screen.findByText("네트워크 연결에 실패했습니다.")).toBeInTheDocument();
    expect(editor).toHaveValue("지워지면 안 되는 근거");
  });

  it("늦게 끝난 전체 조회가 먼저 받은 SSE 메시지를 지우지 않는다", async () => {
    const topic = makeTopic();
    const first = timelineEvent(1, "첫 기록");
    const second = timelineEvent(2, "SSE로 먼저 도착한 기록");
    const staleRefresh = deferred<TopicDetail>();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic")
      .mockResolvedValueOnce(makeDetail(topic, [first]))
      .mockReturnValueOnce(staleRefresh.promise)
      .mockResolvedValue(makeDetail(topic, []));
    vi.spyOn(api, "postMessage").mockResolvedValue({ accepted: true, actionId: "message", topic });

    render(<App />);
    const editor = await screen.findByPlaceholderText("두 에이전트가 함께 알아야 할 내용을 적어 주세요.");
    await waitFor(() => expect(eventSources).toHaveLength(1));
    fireEvent.change(editor, { target: { value: "새 메시지" } });
    fireEvent.click(screen.getByRole("button", { name: "보내기" }));
    await waitFor(() => expect(api.getTopic).toHaveBeenCalledTimes(2));

    eventSources[0].emit(second);
    expect(await screen.findByText("SSE로 먼저 도착한 기록")).toBeInTheDocument();
    staleRefresh.resolve(makeDetail(topic, [first]));

    await waitFor(() => expect(screen.getByText("SSE로 먼저 도착한 기록")).toBeInTheDocument());
  });
});

describe("저장소와 에이전트 실행 설정", () => {
  it("새 주제 화면은 저장소 경로를 입력받지 않고 서버가 고정한 sample-ios 경로를 보여 준다", async () => {
    vi.spyOn(api, "listTopics").mockResolvedValue([]);
    const createTopic = vi.spyOn(api, "createTopic").mockResolvedValue(makeTopic());

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "첫 주제 만들기" }));

    expect(screen.getByText("/Users/example/sample-ios")).toBeInTheDocument();
    expect(screen.getByText("/Users/example/sample-memory")).toBeInTheDocument();
    expect(screen.getByText("현재 주제에 맞는 문서만 골라 각 모델에 전달합니다.")).toBeInTheDocument();
    expect(screen.queryByRole("textbox", { name: "저장소 경로" })).not.toBeInTheDocument();
    fireEvent.change(screen.getByRole("textbox", { name: "주제 이름" }), { target: { value: "설정 변경" } });
    fireEvent.click(screen.getByRole("button", { name: "주제 만들기" }));

    await waitFor(() => expect(createTopic).toHaveBeenCalledWith({
      title: "설정 변경", baseRef: "HEAD", branchPrefix: "consensus", requestedBranchName: null,
    predecessorTopicId: null,
    }));
  });

  // 브랜치 접두사는 저장소 관례(feature/·refactoring/ 등)에 맞춰야 해서 주제마다 정한다.
  it("브랜치 접두사를 바꾸면 그 값으로 주제를 만든다", async () => {
    vi.spyOn(api, "listTopics").mockResolvedValue([]);
    const createTopic = vi.spyOn(api, "createTopic").mockResolvedValue(makeTopic());

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "첫 주제 만들기" }));
    fireEvent.change(screen.getByRole("textbox", { name: "주제 이름" }), { target: { value: "Rx 제거" } });
    fireEvent.change(screen.getByRole("textbox", { name: /브랜치 접두사/ }), { target: { value: "refactoring" } });
    fireEvent.click(screen.getByRole("button", { name: "주제 만들기" }));

    await waitFor(() => expect(createTopic).toHaveBeenCalledWith({
      title: "Rx 제거", baseRef: "HEAD", branchPrefix: "refactoring", requestedBranchName: null,
    predecessorTopicId: null,
    }));
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
    const update = vi.spyOn(api, "updateAgentSettings").mockResolvedValue({
      ...topic,
      agentSettings: { ...topic.agentSettings, claude: { model: "sonnet", effort: "high" } },
    });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Claude 연결됨/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Claude 모델" }), { target: { value: "sonnet" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Claude 추론 강도" }), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(topic.id, "claude", {
      model: "sonnet",
      effort: "high",
    }));
    expect(attach).not.toHaveBeenCalled();
  });

  // 2026-09-07: 폼에 구현 칸이 없어 저장할 때마다 서버가 구현 오버라이드를 NULL 로 지웠다.
  // 그 뒤 구현 턴은 계획 모델(fable)로 돌게 된다.
  it("계획 모델만 바꿔 저장해도 구현 전용 설정은 그대로 함께 보낸다", async () => {
    const topic = withImplementationOverride(makeTopic());
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));
    const update = vi.spyOn(api, "updateAgentSettings").mockResolvedValue(topic);

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /Claude 연결/ }));
    fireEvent.change(screen.getByRole("textbox", { name: "Claude 모델" }), { target: { value: "sonnet" } });
    fireEvent.click(screen.getByRole("button", { name: "설정 저장" }));

    await waitFor(() => expect(update).toHaveBeenCalledWith(topic.id, "claude", {
      model: "sonnet",
      effort: "xhigh",
      implementation: { model: "opus", effort: "xhigh" },
    }));
  });

  it("구현 단계에서는 계획 모델이 아니라 구현 모델을 보여 준다", async () => {
    const planning = withImplementationOverride(makeTopic());
    vi.spyOn(api, "listTopics").mockResolvedValue([planning]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(planning));
    const { unmount } = render(<App />);
    expect(await screen.findByRole("button", { name: /Claude 연결 · 계획 fable · xhigh/ })).toBeInTheDocument();
    unmount();

    const implementing = { ...planning, state: "IMPLEMENTING" as const };
    vi.spyOn(api, "listTopics").mockResolvedValue([implementing]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(implementing));
    render(<App />);
    expect(await screen.findByRole("button", { name: /Claude 연결 · 구현 opus · xhigh/ })).toBeInTheDocument();
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

  it("좌석 칩은 역할과 그 좌석이 지금 실행할 실제 AI 를 보여 주고, 배정 경로면 프로필 설정을 보여 준다", async () => {
    const topic = auditing();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic), routing: routing({ "reviewer/audit": claudeReviewer }) });
    render(<App />);
    expect(await screen.findByRole("button", { name: "작성자 · Claude 연결됨 · opus · xhigh" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검토자 · Claude 연결됨 · 배정 claude-opus-5-5 · high" })).toBeInTheDocument();
    // 상태 문구는 회사 이름이 아니라 역할이다(상태 값 CODEX_AUDIT 는 호환 이름).
    expect(screen.getAllByText("계획 검토").length).toBeGreaterThan(0);
    expect(screen.queryByText("Codex 검토")).not.toBeInTheDocument();
  });

  it("좌석 칩은 서버가 정한 현재 작업의 경로를 쓴다 — 작업별 배정(개정만 Codex)이면 개정 단계의 작성자 칩이 Codex 다", async () => {
    const topic = { ...auditing(), state: "CLAUDE_REVISION" as const };
    const codexReviser: RoutingView["jobs"][number] = { role: "planner", operation: "revision", refusal: null, inheritsFrom: null, route: {
      provider: "codex", participant: "reviser-codex", profileId: "codex-reviser",
      basis: { kind: "assignment", scope: TOPIC_SCOPE, role: "planner", operation: "revision", version: 3 }, settings: { model: "gpt-6-astra", effort: "high" } } };
    const closeout: RoutingView["jobs"][number] = { ...claudeReviewer, operation: "closeout" };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic), routing: {
      ...routing({ "planner/revision": codexReviser }), jobs: [...routing({ "planner/revision": codexReviser }).jobs, closeout],
      current: { author: { role: "planner", operation: "revision" }, reviewer: { role: "reviewer", operation: "closeout" } } } });
    render(<App />);
    expect(await screen.findByRole("button", { name: "작성자 · Codex 연결됨 · 배정 gpt-6-astra · high" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "검토자 · Claude 연결됨 · 배정 claude-opus-5-5 · high" })).toBeInTheDocument();
  });

  it("실행 정보는 역할별 실제 경로·실행 전 거부 사유·좌석 세션을 만든 AI 를 보여 준다", async () => {
    const topic = auditing();
    const refused: RoutingView["jobs"][number] = { role: "planner", operation: "revision", route: null, inheritsFrom: null,
      refusal: "planner/revision 배정의 프로필 claude-bad 옵션을 실행할 수 없습니다: claude 공급자가 해석하지 않는 옵션 sandbox." };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic), routing: routing({ "reviewer/audit": claudeReviewer, "planner/revision": refused }) });
    render(<App />);
    const planner = (await screen.findByText("설계자")).closest("div")!;
    expect(planner).toHaveTextContent("plan: Claude · opus · xhigh · 기본 배정");
    expect(planner).toHaveTextContent("revision: 실행할 수 없는 배정 — 실행 불가: planner/revision 배정의 프로필 claude-bad 옵션을 실행할 수 없습니다");
    const reviewer = screen.getByText("검토자", { selector: "dt" }).closest("div")!;
    expect(reviewer).toHaveTextContent("audit: Claude · claude-opus-5-5 · high · 배정 topic:topic-1 v2(프로필 claude-reviewer, 참여자 reviewer-claude)");
    expect(reviewer).toHaveTextContent("review: Codex · gpt-5.6-sol · xhigh · 기본 배정");
    expect(screen.getByText("계획 검토 좌석 세션").closest("div")!).toHaveTextContent("reviewer-session · Claude(reviewer-claude, 배정 topic:topic-1 v2)");
    // 계획 확인 표도 좌석 역할과 그 세션의 실제 AI 를 쓴다.
    expect(screen.getByText("검토자 · Claude")).toBeInTheDocument();
  });

  it("타임라인: 경로가 기록된 결과는 역할과 실제 AI 를, 경로가 없는 기록은 좌석 역할만 보여 준다(추측한 AI 를 붙이지 않는다)", async () => {
    const topic = auditing();
    const routed: TimelineEvent = { ...timelineEvent(1, "감사 결과"), actor: "codex", kind: "agent_output",
      payload: { route: { provider: "claude", participant: "reviewer-claude", profileId: "claude-reviewer", job: { role: "reviewer", operation: "audit" } } } };
    const unrouted: TimelineEvent = { ...timelineEvent(2, "계획 1판을 저장했습니다."), actor: "claude", kind: "agent_output" };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic, [routed, unrouted]), routing: routing({ "reviewer/audit": claudeReviewer }) });
    render(<App />);
    const routedMessage = (await screen.findByText("감사 결과")).closest("article")!;
    expect(routedMessage).toHaveTextContent("검토자 · Claude");
    const unroutedMessage = screen.getByText("계획 1판을 저장했습니다.").closest("article")!;
    expect(unroutedMessage.querySelector(".message-meta strong")).toHaveTextContent(/^작성자$/);
  });

  it("host-review F003: 부속 턴은 부모 작업 경로 상속과 독립 배정 미적용을 함께 보여 준다", async () => {
    const topic = { ...auditing(), state: "IMPLEMENTING" as const };
    const codexImplement: RoutingView["jobs"][number] = { role: "implementer", operation: "implement", refusal: null, inheritsFrom: null, route: {
      provider: "codex", participant: "implementer-codex", profileId: "codex-writer",
      basis: { kind: "assignment", scope: TOPIC_SCOPE, role: "implementer", operation: "implement", version: 4 }, settings: { model: "gpt-6-astra", effort: "medium" } } };
    const continued: RoutingView["jobs"][number] = { ...codexImplement, operation: "continue", inheritsFrom: "implement" };
    const base = routing({ "implementer/implement": codexImplement }, { author: { role: "implementer", operation: "implement" }, reviewer: { role: "reviewer", operation: "review" } });
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic), routing: { ...base, jobs: [...base.jobs, continued] } });
    render(<App />);
    const implementer = (await screen.findByText("구현자")).closest("div")!;
    expect(implementer).toHaveTextContent("continue: Codex · gpt-6-astra · medium · 배정 topic:topic-1 v4(프로필 codex-writer, 참여자 implementer-codex) · implement 경로 상속(이 작업의 독립 배정은 적용되지 않음)");
  });

  it("host-review F004: routing 이 있으면 기본 배정도 서버가 정한 현재 작업의 설정을 쓴다 — 실패 뒤 재개 단계가 구현이면 구현 모델", async () => {
    const topic = { ...withImplementationOverride(auditing()), state: "FAILED" as const };
    const implementDefault: RoutingView["jobs"][number] = { role: "implementer", operation: "implement", refusal: null, inheritsFrom: null, route: {
      provider: "claude", participant: "claude", profileId: null, basis: { kind: "default" }, settings: { model: "opus", effort: "xhigh" } } };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic), routing: routing({ "implementer/implement": implementDefault },
      { author: { role: "implementer", operation: "implement" }, reviewer: { role: "reviewer", operation: "review" } }) });
    render(<App />);
    expect(await screen.findByRole("button", { name: "작성자 · Claude 연결됨 · 구현 opus · xhigh" })).toBeInTheDocument();
  });

  it("routing 이 없는 과거 응답은 좌석의 기본 공급자로 표시한다", async () => {
    const topic = auditing();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));
    render(<App />);
    expect(await screen.findByRole("button", { name: /^검토자 · Codex 연결됨/ })).toBeInTheDocument();
    expect(screen.getByText("검토자 좌석 세션")).toBeInTheDocument();
  });

  it("세션 창은 좌석 역할로 부르고, 배정 경로로 실행되면 입력이 기본 배정 설정이라는 것을 알린다", async () => {
    const topic = auditing();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue({ ...makeDetail(topic), routing: routing({ "reviewer/audit": claudeReviewer }) });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: /^검토자 · Claude 연결됨/ }));
    expect(screen.getByRole("heading", { name: "검토자 좌석 세션과 실행 설정" })).toBeInTheDocument();
    expect(screen.getByText(/지금 이 좌석은 배정 topic:topic-1 v2\(프로필 claude-reviewer, Claude\)으로 실행됩니다 — 아래 설정은 배정이 없을 때\(기본 배정\)의 Codex 설정입니다/))
      .toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "Codex 모델" })).toBeInTheDocument();
  });
});

describe("전달하지 못한 로컬 커밋", () => {
  it("남은 커밋이 있으면 안내와 되돌리기를 보여 주고 승인한 처분만 서버로 보낸다", async () => {
    const topic = { ...makeTopic(), state: "READY_TO_DELIVER" as const };
    const orphan = "f".repeat(40);
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic, [], orphan));
    const runAction = vi.spyOn(api, "runAction").mockResolvedValue({ accepted: true, actionId: "discard", topic });

    render(<App />);

    expect(await screen.findByText("전달하지 못한 로컬 커밋이 남아 있습니다.")).toBeInTheDocument();
    expect(screen.getByText(orphan)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "이 커밋 되돌리기" }));
    await waitFor(() => expect(runAction.mock.calls.map((call) => call.slice(0, 2))).toEqual([
      [topic.id, "discard-orphan-commit"],
    ]));
  });

  it("남은 커밋이 없으면 되돌리기를 보여 주지 않는다", async () => {
    const topic = { ...makeTopic(), state: "READY_TO_DELIVER" as const };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));

    render(<App />);

    expect(await screen.findByText("전달")).toBeInTheDocument();
    expect(screen.queryByText("전달하지 못한 로컬 커밋이 남아 있습니다.")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "이 커밋 되돌리기" })).not.toBeInTheDocument();
  });
});

// host-review F002 — 닫힌 작업 묶음 단계의 push 진입. 토픽 상세에는 전달 판정이 없어 묶음 목록 뷰(동결 결과·전달 상태)로 판정하고, 최종 판정은 서버 push 다.
// 2차 F002 — 닫힌 단계의 결과 불명확 push 복구, 2차 F001 — 합류 병합을 준비한 단계의 경로 없는 계보 병합 커밋 진입.
describe("작업 묶음 단계의 전달 화면", () => {
  const commit = "c".repeat(40);
  const closedTopic = () => ({ ...makeTopic(), state: "CLOSED" as const, branchName: "consensus/ui-race" });
  const readyTopic = () => ({ ...makeTopic(), state: "READY_TO_DELIVER" as const, branchName: "consensus/ui-race" });
  const preparedMerge = { tree: "m".repeat(40), conflicts: [], targets: [{ stageId: "b", commitOID: "b".repeat(40) }] };
  function stageView(patch: { results?: WorkGroupView["results"]; delivery?: WorkGroupView["delivery"]; links?: WorkGroupView["links"] } = {}): WorkGroupView {
    const budget = { execution: { inputTokens: 1, outputTokens: 1, durationMs: 60000 }, total: { inputTokens: 1, outputTokens: 1, durationMs: 60000 } };
    return {
      id: "g", title: "묶음", goal: "목표", contracts: "계약", repositoryPath: "/repo", baseOID: "base", version: 1, createdAt: "2026-09-27T00:00:00.000Z",
      stages: [
        { id: "a", kind: "work", title: "가 단계", goal: "가", acceptance: "가 완료", dependsOn: [], budget },
        { id: "b", kind: "work", title: "나 단계", goal: "나", acceptance: "나 완료", dependsOn: [], budget },
        { id: "z", kind: "integration", title: "통합", goal: "통합", acceptance: "통합 완료", dependsOn: ["a", "b"], budget },
      ],
      links: patch.links ?? { a: { topicId: "topic-1", baseOID: "base", groupVersion: 1 } },
      results: patch.results ?? { a: {
        stageId: "a", topicId: "topic-1", baseOID: "base", commitOID: commit, reviewedTreeOID: "t".repeat(40), planSHA256: "p".repeat(64),
        evidenceDigest: null, verifications: [], memoryChanges: [], openQuestions: [], deferredFindings: [], decisions: [], closedAt: "2026-09-27T00:00:00.000Z",
      } },
      budget: null, stageStates: { a: "CLOSED", b: null, z: null },
      delivery: patch.delivery ?? { a: { committedOID: commit, pushedOID: null } },
      delivered: false, readyStages: [], selectableStages: [], replanPending: [],
    };
  }
  // 합류 병합을 준비한 채 전달 준비된 단계 a(아직 결과 없음). committedOID 는 목록 뷰의 확정 커밋(계보 병합 커밋을 이미 만들었으면 있다).
  const mergeStage = (link: Partial<WorkGroupView["links"][string]> = { mergeTargets: ["b"], preparedMerge }, committedOID: string | null = null) => [stageView({
    links: { a: { topicId: "topic-1", baseOID: "base", groupVersion: 1, ...link } }, results: {}, delivery: { a: { committedOID, pushedOID: null } },
  })];
  // 서버 응답은 검사가 쥔다 — 토픽 상세는 server.detail 을 돌려주고(동작 대역이 바꾼다), 목록 뷰는 요청마다 해소 전 promise 다. 패널(마운트)과 화면(선택
  // 토픽이 전달 준비·CLOSED)이 목록 뷰를 요청할 때까지 조건으로 기다린다.
  async function renderStage(topic: Topic, detail: TopicDetail) {
    const server = { detail };
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    const getTopic = vi.spyOn(api, "getTopic").mockImplementation(async () => server.detail);
    const pending: Array<(groups: WorkGroupView[]) => void> = [];
    vi.spyOn(api, "listWorkGroups").mockImplementation(() => new Promise<WorkGroupView[]>((resolve) => { pending.push(resolve); }));
    render(<App />);
    await waitFor(() => expect(pending).toHaveLength(2));
    // 대기 중인 요청을 모두 해소하고, 그 응답으로 생기는 상태 반영을 act 안에서 끝낸다.
    const answer = async (groups: WorkGroupView[]) => {
      await act(async () => { for (const resolve of pending.splice(0)) resolve(groups); });
    };
    return { topic, server, getTopic, pending, answer, push: screen.getByRole("button", { name: "푸시 승인" }) };
  }
  const renderClosed = (patch: Partial<TopicDetail> = {}) => {
    const topic = closedTopic();
    return renderStage(topic, { ...makeDetail(topic), ...patch });
  };
  // 동작이 끝났다(busy 해제) — CLOSED 에서는 "빌드 트리 정리"가 busy 가 아닐 때만 열린다.
  const idle = () => waitFor(() => expect(screen.getByRole("button", { name: "빌드 트리 정리" })).toBeEnabled());

  it("결과 커밋을 아직 push 하지 않은 닫힌 단계는 push 를 열고, 전달 뒤 목록 뷰를 다시 읽는다", async () => {
    const { topic, push, pending, answer } = await renderClosed();
    // 응답 전에는 닫혀 있고, 응답을 돌려준 act 경계 직후에 열린다(waitFor 없이) — 비활성 검사들이 쓰는 경계가 응답을 반영한다는 대조다.
    expect(push).toBeDisabled();
    await answer([stageView()]);
    expect(push).toBeEnabled();
    const runAction = vi.spyOn(api, "runAction").mockResolvedValue({ accepted: true, actionId: "push", topic });
    fireEvent.click(push);
    fireEvent.click(await screen.findByRole("button", { name: "푸시 실행" }));
    await waitFor(() => expect(runAction).toHaveBeenCalledWith(topic.id, "push", {}));
    // 전달 동작 뒤 화면이 목록 뷰를 다시 요청한다. 이제 push 된 응답을 돌려주면, 동작이 끝난 뒤 push 진입이 닫힌다.
    await waitFor(() => expect(pending).toHaveLength(1));
    await answer([stageView({ delivery: { a: { committedOID: commit, pushedOID: commit } } })]);
    await idle();
    expect(screen.getByRole("button", { name: "푸시 승인" })).toBeDisabled();
  });

  it.each([
    ["이미 push 한 결과", () => [stageView({ delivery: { a: { committedOID: commit, pushedOID: commit } } })]],
    ["동결 결과 없음", () => [stageView({ results: {} })]],
    ["다른 토픽의 결과", () => [stageView({ results: { a: { ...stageView().results!.a, topicId: "topic-2" } } })]],
    ["기록된 커밋이 결과 커밋과 다름", () => [stageView({ delivery: { a: { committedOID: "d".repeat(40), pushedOID: null } } })]],
    ["작업 묶음 단계가 아님", () => []],
  ])("%s이면 닫힌 토픽의 push 를 열지 않는다", async (_label, groups) => {
    const denied = await renderClosed();
    await denied.answer(groups());
    expect(denied.push).toBeDisabled();
    // 같은 경로·같은 경계의 활성 대조 — 한 필드만 다른 응답이면 같은 act 경계 직후 열린다. 이 대조가 통과하므로 위 비활성은 응답을 반영한 뒤의 상태다.
    cleanup();
    const control = await renderClosed();
    await control.answer([stageView()]);
    expect(control.push).toBeEnabled();
  });

  describe("닫힌 단계의 결과 불명확 push 복구(2차 F002)", () => {
    const recovery = { action: "push" as const, idempotencyKey: "push-request-0123456789", createdAt: "2026-09-27T00:00:00.000Z", requestedPaths: [] };
    // 결과 확인 동작 대역 — 서버처럼 결과 불명확 요청을 지운 상세를 이후 조회에 돌려준다.
    const reconcileClears = (rendered: Awaited<ReturnType<typeof renderStage>>) =>
      vi.spyOn(api, "runAction").mockImplementation(async (_topicId, action) => {
        rendered.server.detail = makeDetail(rendered.topic);
        return { accepted: true, actionId: action, topic: rendered.topic };
      });

    it("결과 확인 전에는 push 를 막고, 실패 확인을 기록한 뒤 상세·목록 뷰를 다시 읽어 push 진입을 되돌린다", async () => {
      const rendered = await renderClosed({ deliveryRecovery: recovery });
      await rendered.answer([stageView()]);
      // 목록 뷰로는 push 할 수 있는 단계지만 결과 불명확 요청이 있는 동안에는 막는다(서버가 결과 확인 전 push 를 거부한다).
      expect(screen.getByText("푸시 결과를 확인해야 합니다")).toBeInTheDocument();
      expect(rendered.push).toBeDisabled();
      const runAction = reconcileClears(rendered);
      const reads = rendered.getTopic.mock.calls.length;
      fireEvent.click(screen.getByRole("button", { name: "Git 작업이 실패함" }));
      await waitFor(() => expect(runAction).toHaveBeenCalledWith(rendered.topic.id, "reconcile-delivery", {
        outcome: "failed", idempotencyKey: recovery.idempotencyKey,
      }));
      // 확인 뒤 상세를 다시 읽고(복구 표시가 사라진다), 전달 진입 판정용 목록 뷰도 다시 읽는다.
      await waitFor(() => expect(rendered.pending).toHaveLength(1));
      expect(rendered.getTopic.mock.calls.length).toBeGreaterThan(reads);
      await rendered.answer([stageView()]);
      await idle();
      expect(screen.queryByText("푸시 결과를 확인해야 합니다")).not.toBeInTheDocument();
      // 같은 경로의 활성 대조 — 결과 불명확 요청이 없어지면 같은 목록 뷰 응답으로 push 진입이 열린다.
      expect(screen.getByRole("button", { name: "푸시 승인" })).toBeEnabled();
    });

    it("성공한 Git OID 를 입력해 확인하면 OID·요청 키로 결과를 기록하고 상세를 다시 읽는다", async () => {
      const oid = "e".repeat(40);
      const rendered = await renderClosed({ deliveryRecovery: recovery });
      await rendered.answer([stageView()]);
      const confirm = screen.getByRole("button", { name: "OID를 검증해 성공 확인" });
      expect(confirm).toBeDisabled();
      // 대문자·공백을 정규화한 전체 OID 여야 확인을 연다.
      fireEvent.change(screen.getByLabelText("성공했다고 확인할 Git OID"), { target: { value: ` ${oid.toUpperCase()} ` } });
      expect(confirm).toBeEnabled();
      const runAction = reconcileClears(rendered);
      const reads = rendered.getTopic.mock.calls.length;
      fireEvent.click(confirm);
      await waitFor(() => expect(runAction).toHaveBeenCalledWith(rendered.topic.id, "reconcile-delivery", {
        outcome: "succeeded", oid, idempotencyKey: recovery.idempotencyKey,
      }));
      await waitFor(() => expect(rendered.pending).toHaveLength(1));
      expect(rendered.getTopic.mock.calls.length).toBeGreaterThan(reads);
      await rendered.answer([stageView({ delivery: { a: { committedOID: commit, pushedOID: commit } } })]);
      await idle();
      expect(screen.queryByText("푸시 결과를 확인해야 합니다")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "푸시 승인" })).toBeDisabled();
    });

    it("결과 불명확 요청이 없는 닫힌 토픽에는 복구 표시를 두지 않는다", async () => {
      const rendered = await renderClosed();
      await rendered.answer([stageView()]);
      expect(screen.queryByText("푸시 결과를 확인해야 합니다")).not.toBeInTheDocument();
      expect(rendered.push).toBeEnabled();
    });
  });

  describe("합류 병합을 준비한 단계의 계보 병합 커밋(2차 F001)", () => {
    // 전달 준비된 토픽을 열고 커밋 대화상자에 메시지를 적는다 — 목록 뷰 응답을 반영한 뒤다.
    async function commitDialog(groups: WorkGroupView[], changedPaths: string[] = []) {
      const topic = readyTopic();
      const rendered = await renderStage(topic, { ...makeDetail(topic), changedPaths });
      await rendered.answer(groups);
      fireEvent.click(screen.getByRole("button", { name: "범위 지정 커밋" }));
      fireEvent.change(await screen.findByLabelText("커밋 메시지"), { target: { value: "합류 병합" } });
      return { ...rendered, submit: screen.getByRole("button", { name: "이 범위만 커밋" }) };
    }

    it("파일 차이가 없으면 경로 없이 병합 커밋을 요청한다", async () => {
      const dialog = await commitDialog(mergeStage());
      expect(screen.getByText("파일 차이가 없습니다. 준비한 합류 대상을 부모로 잇는 병합 커밋을 경로 없이 요청합니다.")).toBeInTheDocument();
      expect(dialog.submit).toBeEnabled();
      const runAction = vi.spyOn(api, "runAction").mockResolvedValue({ accepted: true, actionId: "commit", topic: dialog.topic });
      fireEvent.click(dialog.submit);
      await waitFor(() => expect(runAction).toHaveBeenCalledWith(dialog.topic.id, "commit", { message: "합류 병합", paths: [] }));
      await waitFor(() => expect(dialog.pending).toHaveLength(1));
      await dialog.answer(mergeStage());
    });

    it.each([
      ["합류 준비 없는 묶음 단계", () => mergeStage({}), []],
      ["작업 묶음 단계가 아님", () => [], []],
      ["합류 준비 단계에 바뀐 경로가 있음(경로를 골라야 한다)", () => mergeStage(), ["a.txt"]],
      // 서버 commit 은 확정 커밋이 없을 때만 합류 병합 경로를 탄다 — 이미 확정했으면 경로 없는 커밋은 일반 커밋으로 거부되므로 진입을 닫는다.
      ["계보 병합 커밋을 이미 확정함(바뀐 파일 0개)", () => mergeStage(undefined, "f".repeat(40)), []],
    ])("%s이면 경로 없는 커밋을 열지 않는다", async (_label, groups, changedPaths) => {
      const denied = await commitDialog(groups(), changedPaths);
      expect(denied.submit).toBeDisabled();
      // 같은 경로·같은 경계의 활성 대조 — 합류 준비 단계·파일 차이 없음이면 같은 경계 직후 열린다.
      cleanup();
      const control = await commitDialog(mergeStage());
      expect(control.submit).toBeEnabled();
    });
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

describe("자율중재 위임 토글", () => {
  it("현재 값을 보여 주고 누르면 반대 값으로 저장한다", async () => {
    const topic = makeTopic();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));
    const set = vi.spyOn(api, "setMediationAutonomy").mockResolvedValue({
      autonomy: "off", set_at: "2026-09-08T02:00:00Z", set_by: "web", note: "웹 토글",
      history: [{ autonomy: "on", set_at: "2026-09-08T01:41:01Z", set_by: "example-user", note: "" }], unset: false,
    });
    render(<App />);
    const toggle = await screen.findByRole("switch", { name: "자율중재 위임" });
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "true"));
    expect(toggle).toHaveTextContent("자율중재 위임 ON");
    fireEvent.click(toggle);
    await waitFor(() => expect(set).toHaveBeenCalledWith({ autonomy: "off", note: "웹 토글" }));
    await waitFor(() => expect(toggle).toHaveAttribute("aria-checked", "false"));
    expect(toggle).toHaveTextContent("자율중재 위임 OFF");
  });

  it("스위치 파일이 없으면 OFF 로 보이고 제목에 그 사실을 적는다", async () => {
    const topic = makeTopic();
    vi.spyOn(api, "listTopics").mockResolvedValue([topic]);
    vi.spyOn(api, "getTopic").mockResolvedValue(makeDetail(topic));
    vi.spyOn(api, "getMediationAutonomy").mockResolvedValue({
      autonomy: "off", set_at: null, set_by: null, note: null, history: [], unset: true,
    });
    render(<App />);
    const toggle = await screen.findByRole("switch", { name: "자율중재 위임" });
    await waitFor(() => expect(toggle).toHaveTextContent("자율중재 위임 OFF"));
    expect(toggle.getAttribute("title")).toContain("파일이 없어");
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
 expect(await screen.findByRole("status")).toHaveTextContent("승인은 저장했습니다. 재개하려면 예산을 추가하세요.");
 fireEvent.click(screen.getByRole("button",{name:/다른 승인 토픽/}));
 await waitFor(()=>expect(screen.queryByText("승인은 저장했습니다. 재개하려면 예산을 추가하세요.")).not.toBeInTheDocument());
});

it("scrollIntoView 반환값을 effect 정리 함수로 사용하지 않는다",async()=>{
 Object.defineProperty(HTMLElement.prototype,"scrollIntoView",{configurable:true,value:vi.fn(()=>Promise.resolve())});
 vi.spyOn(api,"listTopics").mockResolvedValue([makeTopic()]);vi.spyOn(api,"getTopic").mockResolvedValue(makeDetail(makeTopic(),[timelineEvent(1,"스크롤 확인")]));
 const view=render(<App/>);await screen.findByRole("heading",{name:makeTopic().title});
 await waitFor(()=>expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalled());
 expect(()=>view.unmount()).not.toThrow();
});
