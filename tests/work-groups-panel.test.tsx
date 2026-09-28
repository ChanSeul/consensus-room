// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkGroupsPanel } from "../src/web/WorkGroupsPanel";
import { api } from "../src/web/api";
import type { Topic } from "../src/shared/contracts";
import type { WorkGroupView } from "../src/shared/workGroups";

// 엔진 개편 E4 — 작업 묶음 패널: 대략 단계·준비/선택 가능 단계·재계획 대기와 재적용·단계별 전달(커밋·푸시 분리)과 묶음 전달·미정 질문·막힌 단계 옆 선택 착수,
// 대략 단계를 허용하는 생성 폼, 미착수 단계의 완료 조건·예산 준비(host-review F010), 닫힌 단계 push(F002). 목록 뷰의 파생 필드는 서버가 계산한다(여기서는 api 대역으로 준다).

const budget = {
  execution: { inputTokens: 10, outputTokens: 10, durationMs: 60000 },
  total: { inputTokens: 100, outputTokens: 100, durationMs: 600000 },
};

function view(patch: Partial<WorkGroupView> = {}): WorkGroupView {
  return {
    id: "g", title: "큰 작업", goal: "전체 목표", contracts: "공통 계약", repositoryPath: "/repo", baseOID: "base", version: 3,
    createdAt: "2026-09-27T00:00:00.000Z",
    stages: [
      { id: "a", kind: "work", title: "가 단계", goal: "가 목표", acceptance: "가 완료", dependsOn: [], budget },
      { id: "b", kind: "work", title: "나 단계", goal: "나 목표", acceptance: "나 완료", dependsOn: [], budget },
      { id: "c", kind: "work", title: "다 단계", goal: "다 목표", dependsOn: ["a"] },
      { id: "z", kind: "integration", title: "통합 검증", goal: "통합 목표", acceptance: "통합 완료", dependsOn: ["a", "b", "c"], budget },
    ],
    questions: [
      { id: "q1", stageId: "c", text: "다 단계의 범위", blocksStart: true },
      { id: "q2", stageId: null, text: "이미 정한 질문", blocksStart: false, resolution: "정했다" },
    ],
    links: { a: { topicId: "topic-a", baseOID: "base", groupVersion: 3, contextDigest: "d" } },
    budget: null,
    stageStates: { a: "USER_DECISION_REQUIRED", b: null, c: null, z: null },
    delivery: { a: { committedOID: null, pushedOID: null } },
    delivered: false,
    readyStages: ["b"],
    selectableStages: ["b"],
    replanPending: [],
    ...patch,
  };
}
const topic = (id: string) => ({ id }) as Topic;
// 단계 목록(ol)의 항목과 미정 질문(ul)의 항목을 나눠 찾는다 — 질문 줄도 단계 이름으로 시작한다.
const item = (container: HTMLElement, title: string) =>
  [...container.querySelectorAll("ol > li")].find((li) => li.textContent?.startsWith(`${title} · `))?.textContent ?? "";
const question = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("ul > li")].find((li) => li.textContent?.includes(text))?.textContent ?? "";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("작업 묶음 패널", () => {
  it("대략 단계·준비된 단계·미정 질문을 보이고, 외부 결정으로 막힌 단계 옆에서 고른 단계를 연다", async () => {
    vi.spyOn(api, "listWorkGroups").mockResolvedValue([view()]);
    const next = vi.spyOn(api, "nextWorkStage").mockResolvedValue(topic("topic-b"));
    const onTopic = vi.fn();
    const { container } = render(<WorkGroupsPanel onTopic={onTopic} />);
    await screen.findByText(/큰 작업/);
    expect(item(container, "가 단계")).toContain("결정 대기");
    expect(item(container, "나 단계")).toContain("준비됨");
    expect(item(container, "나 단계")).not.toContain("대략 단계");
    expect(item(container, "다 단계")).toContain("대략 단계(완료 조건 미정)");
    expect(item(container, "다 단계")).not.toContain("준비됨");
    // 미해소 질문만 — 단계 이름·착수 차단 여부와 함께.
    expect(question(container, "다 단계의 범위")).toBe("다 단계 · 다 단계의 범위 · 착수 차단");
    expect(container.textContent).not.toContain("이미 정한 질문");
    // 선택 착수는 열린(막힌) 단계 옆에만 있다.
    expect(item(container, "가 단계")).toContain("나 단계 골라 열기");
    expect(item(container, "나 단계")).not.toContain("골라 열기");
    fireEvent.click(screen.getByText("나 단계 골라 열기"));
    await waitFor(() => expect(onTopic).toHaveBeenCalledWith("topic-b"));
    expect(next).toHaveBeenCalledWith("g", "b");
  });

  it("기본 착수는 단계를 지정하지 않고, 고를 단계가 없으면 선택 착수를 보이지 않는다", async () => {
    vi.spyOn(api, "listWorkGroups").mockResolvedValue([view({ selectableStages: [], stageStates: { a: "IMPLEMENTING", b: null, c: null, z: null } })]);
    const next = vi.spyOn(api, "nextWorkStage").mockResolvedValue(topic("topic-b"));
    const onTopic = vi.fn();
    const { container } = render(<WorkGroupsPanel onTopic={onTopic} />);
    await screen.findByText(/큰 작업/);
    expect(item(container, "가 단계")).toContain("진행 중");
    expect(container.textContent).not.toContain("골라 열기");
    fireEvent.click(screen.getByText("다음 단계 열기"));
    await waitFor(() => expect(onTopic).toHaveBeenCalledWith("topic-b"));
    expect(next).toHaveBeenCalledWith("g", undefined);
  });

  it("재계획 대기 단계를 보이고 '개정 다시 적용'은 같은 입력(질문·묶음 예산 포함)과 지금 버전으로 개정을 다시 보낸다", async () => {
    const policy = { execution: budget.execution, total: { inputTokens: 999, outputTokens: 999, durationMs: 999000 } };
    const group = view({ replanPending: ["a"], budgetPolicy: policy });
    vi.spyOn(api, "listWorkGroups").mockResolvedValue([group]);
    const revise = vi.spyOn(api, "reviseWorkGroup").mockResolvedValue(group);
    const { container } = render(<WorkGroupsPanel onTopic={vi.fn()} />);
    await screen.findByText(/큰 작업/);
    expect(item(container, "가 단계")).toContain("재계획 대기");
    expect(screen.getByRole("status", { hidden: true })).toHaveTextContent("재계획 대기: 가 단계");
    fireEvent.click(screen.getByText("개정 다시 적용"));
    await waitFor(() => expect(revise).toHaveBeenCalledTimes(1));
    expect(revise).toHaveBeenCalledWith("g", {
      title: "큰 작업", goal: "전체 목표", contracts: "공통 계약", stages: group.stages, budgetPolicy: policy, questions: group.questions,
    }, 3);
    // 계약 변경도 질문·묶음 예산을 빠뜨리지 않는다(기존 질문 삭제로 거부되지 않게).
    fireEvent.change(container.querySelector("textarea[name=contracts]")!, { target: { value: "새 계약" } });
    fireEvent.submit(screen.getByText("계약 변경 · 미완료 단계 재계획").closest("form")!);
    await waitFor(() => expect(revise).toHaveBeenCalledTimes(2));
    expect(revise).toHaveBeenLastCalledWith("g", {
      title: "큰 작업", goal: "전체 목표", contracts: "새 계약", stages: group.stages, budgetPolicy: policy, questions: group.questions,
    }, 3);
  });

  it("재계획 대기가 없으면 재적용 동작을 보이지 않는다", async () => {
    vi.spyOn(api, "listWorkGroups").mockResolvedValue([view()]);
    const { container } = render(<WorkGroupsPanel onTopic={vi.fn()} />);
    await screen.findByText(/큰 작업/);
    expect(container.textContent).not.toContain("개정 다시 적용");
    expect(item(container, "가 단계")).not.toContain("재계획 대기");
  });

  it("단계별 전달은 커밋과 푸시를 나눠 보이고, 통합 검증 완료와 묶음 전달 완료를 구분한다", async () => {
    const closed = { a: "CLOSED", b: "CLOSED", c: "CLOSED", z: "CLOSED" };
    const links = Object.fromEntries(["a", "b", "c", "z"].map((id) => [id, { topicId: `topic-${id}`, baseOID: "base", groupVersion: 3 }]));
    const delivery = {
      a: { committedOID: "aaaaaaa111", pushedOID: null }, b: { committedOID: "bbbbbbb222", pushedOID: "bbbbbbb222" },
      c: { committedOID: null, pushedOID: null }, z: { committedOID: "zzzzzzz333", pushedOID: null },
    };
    const listed = vi.spyOn(api, "listWorkGroups").mockResolvedValue([view({ stageStates: closed, links, delivery, selectableStages: [], readyStages: [] })]);
    const first = render(<WorkGroupsPanel onTopic={vi.fn()} />);
    await screen.findByText(/통합 검증 완료\(전달 전\)/);
    expect(item(first.container, "가 단계")).toContain("커밋 aaaaaaa · 푸시 전");
    expect(item(first.container, "나 단계")).toContain("커밋 bbbbbbb · 푸시 bbbbbbb");
    expect(item(first.container, "다 단계")).toContain("커밋 없음 · 푸시 전");
    expect(first.container.textContent).not.toContain("묶음 전달 완료");
    first.unmount();
    listed.mockResolvedValue([view({ stageStates: closed, links, delivery: { ...delivery, z: { committedOID: "zzzzzzz333", pushedOID: "zzzzzzz333" } },
      delivered: true, selectableStages: [], readyStages: [] })]);
    const second = render(<WorkGroupsPanel onTopic={vi.fn()} />);
    await screen.findByText(/묶음 전달 완료/);
    expect(second.container.textContent).not.toContain("전달 전)");
    expect(item(second.container, "통합 검증")).toContain("커밋 zzzzzzz · 푸시 zzzzzzz");
  });

  it.each(["explicit", "observe"])("생성 폼은 %s 예산과 완료 조건을 비운 대략 단계를 보낸다", async mode => {
    vi.spyOn(api, "listWorkGroups").mockResolvedValue([]);
    const create = vi.spyOn(api, "createWorkGroup").mockResolvedValue(view());
    const { container } = render(<WorkGroupsPanel onTopic={vi.fn()} />);
    fireEvent.click(screen.getByText("긴 작업을 단계로 나누기"));
    const field = (name: string, value: string) =>
      fireEvent.change(container.querySelector(`[name=${name}]`)!, { target: { value } });
    field("title", "새 묶음");
    field("goal", "새 목표");
    field("contracts", "새 계약");
    field("title0", "대략 단계");
    field("goal0", "나중에 정할 목표");
    field("goal1", "통합 목표");
    field("acceptance1", "통합 완료 조건");
    if (mode === "explicit") for (const [name, value] of [["input", "10"], ["output", "20"], ["minutes", "1"], ["totalInput", "100"], ["totalOutput", "200"], ["totalMinutes", "10"]])
      field(name, value);
    expect(container.querySelector("form")!.checkValidity()).toBe(true);
    fireEvent.submit(container.querySelector("form")!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const input = create.mock.calls[0][0];
    expect(input.stages[0]).toEqual({ id: "stage-1", kind: "work", title: "대략 단계", goal: "나중에 정할 목표", dependsOn: [] });
    expect(input.stages[1]).toEqual({
      id: "stage-2", kind: "integration", title: "전체 통합 검증", goal: "통합 목표", dependsOn: ["stage-1"], acceptance: "통합 완료 조건",
      budget: mode === "observe" ? { mode: "observe" } : {
        execution: { inputTokens: 10, outputTokens: 20, durationMs: 60000 },
        total: { inputTokens: 100, outputTokens: 200, durationMs: 600000 },
      },
    });
  });
});

describe("단계 준비와 닫힌 단계 전달(host-review F010·F002)", () => {
  it("미착수 단계의 완료 조건·예산을 정하면 기존 개정으로 입력 전체를 다시 보내고, 준비된 단계를 착수로 잇는다", async () => {
    const closedA = { stageStates: { a: "CLOSED", b: "CLOSED", c: null, z: null }, selectableStages: [], readyStages: [],
      links: { a: { topicId: "topic-a", baseOID: "base", groupVersion: 3 }, b: { topicId: "topic-b", baseOID: "base", groupVersion: 3 } },
      delivery: { a: { committedOID: "aaaaaaa111", pushedOID: "aaaaaaa111" }, b: { committedOID: "bbbbbbb222", pushedOID: "bbbbbbb222" } },
      questions: [{ id: "q2", stageId: null, text: "이미 정한 질문", blocksStart: false, resolution: "정했다" }] };
    const before = view(closedA);
    const planned = { execution: { inputTokens: 11, outputTokens: 12, durationMs: 2 * 60000 }, total: { inputTokens: 110, outputTokens: 120, durationMs: 20 * 60000 } };
    const after = view({ ...closedA, version: 4, readyStages: ["c"],
      stages: before.stages.map((stage) => (stage.id === "c" ? { ...stage, acceptance: "다 완료", budget: planned } : stage)) });
    vi.spyOn(api, "listWorkGroups").mockResolvedValueOnce([before]).mockResolvedValue([after]);
    const revise = vi.spyOn(api, "reviseWorkGroup").mockResolvedValue(after);
    const next = vi.spyOn(api, "nextWorkStage").mockResolvedValue(topic("topic-c"));
    const onTopic = vi.fn();
    const { container } = render(<WorkGroupsPanel onTopic={onTopic} />);
    await screen.findByText(/큰 작업/);
    // 연결된 단계는 개정 규칙이 막으므로 준비 폼이 없다.
    expect(item(container, "가 단계")).not.toContain("완료 조건·예산 정하기");
    expect(item(container, "다 단계")).toContain("대략 단계(완료 조건 미정)");
    const form = screen.getByRole("form", { name: "다 단계 준비", hidden: true });
    const field = (name: string, value: string) =>
      fireEvent.change(form.querySelector(`[name=${name}]`)!, { target: { value } });
    field("acceptance", "다 완료");
    for (const [name, value] of [["input", "11"], ["output", "12"], ["minutes", "2"], ["totalInput", "110"], ["totalOutput", "120"], ["totalMinutes", "20"]])
      field(name, value);
    fireEvent.submit(form);
    await waitFor(() => expect(revise).toHaveBeenCalledTimes(1));
    expect(revise).toHaveBeenCalledWith("g", {
      title: "큰 작업", goal: "전체 목표", contracts: "공통 계약", questions: before.questions,
      stages: before.stages.map((stage) => (stage.id === "c" ? { ...stage, acceptance: "다 완료", budget: planned } : stage)),
    }, 3);
    // 저장 뒤 목록 뷰가 준비된 단계로 알려 주면 기본 착수로 연다.
    await waitFor(() => expect(item(container, "다 단계")).toContain("준비됨"));
    expect(item(container, "다 단계")).not.toContain("대략 단계");
    fireEvent.click(screen.getByText("다음 단계 열기"));
    await waitFor(() => expect(onTopic).toHaveBeenCalledWith("topic-c"));
    expect(next).toHaveBeenCalledWith("g", undefined);
  });

  it("준비 폼은 이미 정한 완료 조건·예산을 기본값으로 보인다", async () => {
    vi.spyOn(api, "listWorkGroups").mockResolvedValue([view()]);
    render(<WorkGroupsPanel onTopic={vi.fn()} />);
    await screen.findByText(/큰 작업/);
    const form = screen.getByRole("form", { name: "나 단계 준비", hidden: true });
    expect(within(form).getByDisplayValue("나 완료")).toBeInTheDocument();
    expect((form.querySelector("[name=minutes]") as HTMLInputElement).value).toBe("1");
    expect((form.querySelector("[name=totalMinutes]") as HTMLInputElement).value).toBe("10");
    expect((form.querySelector("[name=totalInput]") as HTMLInputElement).value).toBe("100");
  });

  it("닫혔지만 결과 커밋을 아직 push 하지 않은 단계에 push 진입을 두고, 기존 push 동작을 부른다", async () => {
    const links = Object.fromEntries(["a", "b", "c"].map((id) => [id, { topicId: `topic-${id}`, baseOID: "base", groupVersion: 3 }]));
    vi.spyOn(api, "listWorkGroups").mockResolvedValue([view({
      links, stageStates: { a: "CLOSED", b: "CLOSED", c: "READY_TO_DELIVER", z: null }, selectableStages: [], readyStages: [],
      delivery: {
        a: { committedOID: "aaaaaaa111", pushedOID: null }, b: { committedOID: "bbbbbbb222", pushedOID: "bbbbbbb222" },
        c: { committedOID: "ccccccc333", pushedOID: null },
      },
    })]);
    const push = vi.spyOn(api, "runAction").mockResolvedValue({ accepted: true, actionId: "push", topic: topic("topic-a") });
    const { container } = render(<WorkGroupsPanel onTopic={vi.fn()} />);
    await screen.findByText(/큰 작업/);
    expect(item(container, "가 단계")).toContain("닫힌 단계 푸시");
    // 이미 push 한 닫힌 단계, 아직 닫히지 않은 단계(토픽 화면의 전달 절차)에는 두지 않는다.
    expect(item(container, "나 단계")).not.toContain("닫힌 단계 푸시");
    expect(item(container, "다 단계")).not.toContain("닫힌 단계 푸시");
    fireEvent.click(screen.getByText("닫힌 단계 푸시"));
    await waitFor(() => expect(push).toHaveBeenCalledWith("topic-a", "push"));
  });
});
