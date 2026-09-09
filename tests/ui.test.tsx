// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/web/App";
import { api } from "../src/web/api";
import type { TimelineEvent, Topic, TopicDetail } from "../src/shared/contracts";

const eventSources: FakeEventSource[] = [];

beforeEach(() => {
  eventSources.length = 0;
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
