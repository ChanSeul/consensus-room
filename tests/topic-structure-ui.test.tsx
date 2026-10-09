// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TopicSchema } from "../src/shared/contracts";
import { TopicOverview, TopicTree } from "../src/web/TopicStructure";
import { DEFAULT_AGENT_SETTINGS } from "../src/shared/contracts";
afterEach(cleanup);
const topic = (id: string, title: string, parentTopicId: string | null, group = false) => TopicSchema.parse({
  id, title, slug: id, parentTopicId, topicKind: group ? "group" : "task", repositoryPath: "/tmp/repo", worktreePath: "/tmp/repo",
  state: "DRAFT", baseRef: "HEAD", branchName: null, scopeGeneration: 1, planRevision: 0,
  planSHA256: null, approvedPlanSHA256: null, agentSettings: DEFAULT_AGENT_SETTINGS, participants: [],
  createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null,
  workEntry: { mode: "goal", goal: `${title}의 목표`, sourceIds: [], evidenceDigest: null },
});
it("keeps nested navigation, leaf totals, collapsed branches and the selected path coherent", () => {
  const root = topic("r", "제품 큰 그림", null, true), sub = topic("s", "입력 경로", "r", true), leaf = topic("l", "자료 읽기", "s");
  const closed = { ...topic("c", "목표 입력", "r"), state: "CLOSED" as const }, onSelect = vi.fn();
  const topics = [leaf, closed, root, sub]; // Server order is recent activity, not hierarchy order.
  const view = render(<TopicTree topics={topics} selectedId={root.id} onSelect={onSelect} />);
  expect(screen.getByText("말단 1/2 종료")).toBeInTheDocument();
  expect(screen.queryByText("입력 경로")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "제품 큰 그림 하위 주제" }));
  expect(screen.getByText("말단 0/1 종료")).toBeInTheDocument();
  expect(screen.queryByText("자료 읽기")).not.toBeInTheDocument();
  view.rerender(<TopicTree topics={topics} selectedId={leaf.id} onSelect={onSelect} />);
  expect(screen.getByText("자료 읽기")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /말단 · 실행.*자료 읽기/ }));
  expect(onSelect).toHaveBeenCalledWith(leaf.id);
  render(<TopicOverview topic={leaf} topics={topics} onSelect={onSelect} />);
  fireEvent.click(screen.getByRole("button", { name: "Root · 제품 큰 그림" }));
  expect(onSelect).toHaveBeenLastCalledWith(root.id);
  expect(screen.getByText("자료 읽기의 목표")).toBeInTheDocument();
});
it("keeps source and brainstorm entry modes visible after moving into implementation", () => {
  const source = { ...topic("s", "자료 구현", null), state: "IMPLEMENTING" as const,
    workEntry: { mode: "sources" as const, goal: "실패를 표시한다", sourceIds: [], evidenceDigest: null } };
  const view = render(<TopicOverview topic={source} topics={[source]} onSelect={vi.fn()} />);
  expect(screen.getByText("Source에서 시작")).toBeInTheDocument();
  expect(screen.getByText("구현·검토").closest("li")).toHaveAttribute("aria-current", "step");
  const brainstorm = { ...source, workEntry: { ...source.workEntry, mode: "brainstorm" as const } };
  view.rerender(<TopicOverview topic={brainstorm} topics={[brainstorm]} onSelect={vi.fn()} />);
  expect(screen.getByText("브레인스토밍에서 시작")).toBeInTheDocument();
});
it("moves running and blocked badges to the nearest visible row and preserves collapse on refresh", () => {
  const root = topic("r", "Root", null, true), sub = topic("s", "Sub", "r", true);
  const running = { ...topic("a", "실행 작업", "s"), state: "IMPLEMENTING" as const };
  const blocked = { ...topic("b", "정지 작업", "s"), state: "USER_DECISION_REQUIRED" as const };
  const topics = [root, sub, running, blocked];
  const props = { selectedId: running.id, onSelect: vi.fn(), status: (item: typeof root) => <span>{item.state}</span> };
  const view = render(<TopicTree {...props} topics={topics} />);
  expect(screen.getAllByText("IMPLEMENTING")).toHaveLength(1);
  expect(screen.getByText("IMPLEMENTING").closest("button")).toHaveTextContent("실행 작업");
  fireEvent.click(screen.getByRole("button", { name: "Sub 하위 주제" }));
  expect(screen.getByText("IMPLEMENTING").closest("button")).toHaveTextContent("Sub");
  expect(screen.getByText("USER_DECISION_REQUIRED").closest("button")).toHaveTextContent("Sub");
  view.rerender(<TopicTree {...props} topics={topics.map(item => ({ ...item }))} />);
  expect(screen.queryByText("실행 작업")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Root 하위 주제" }));
  expect(screen.getByText("IMPLEMENTING").closest("button")).toHaveTextContent("Root");
  expect(screen.getAllByText("USER_DECISION_REQUIRED")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Root 하위 주제" }));
  fireEvent.click(screen.getByRole("button", { name: "Sub 하위 주제" }));
  expect(screen.getByText("IMPLEMENTING").closest("button")).toHaveTextContent("실행 작업");
});
it("reveals active leaf paths on initial load only, leaving idle branches collapsed", () => {
  const root = topic("r", "Root", null, true), sub = topic("s", "Sub", "r", true);
  const idleRoot = topic("i", "Idle", null, true), idle = topic("j", "대기 작업", "i");
  const active = { ...topic("a", "실행 중 말단", "s"), state: "IMPLEMENTING" as const };
  const topics = [root, sub, active, idleRoot, idle];
  const props = { selectedId: null, onSelect: vi.fn() };
  const view = render(<TopicTree {...props} topics={[]} />);
  view.rerender(<TopicTree {...props} topics={topics} />);
  expect(screen.getByText("실행 중 말단")).toBeInTheDocument();
  expect(screen.queryByText("대기 작업")).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Root 하위 주제" }));
  view.rerender(<TopicTree {...props} topics={topics.map(item => ({ ...item }))} />);
  expect(screen.queryByText("실행 중 말단")).not.toBeInTheDocument();
});
