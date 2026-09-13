// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RevisionPanel } from "../src/web/RevisionPanel";
const account = {
  topicId: "t",
  used: 3,
  limit: 3,
  version: 1,
  firstPlanUsed: true,
  historyIncomplete: true,
  startedAt: "2026-09-14",
};
afterEach(cleanup);
it("불완전 이력과 한도를 표시하고 추가 승인만 제공한다", () => {
  const grant = vi.fn();
  render(
    <RevisionPanel account={account} paused busy={false} onGrant={grant} />,
  );
  expect(screen.getByText(/3 \/ 3회/)).toBeTruthy();
  expect(screen.getByText(/이전 호출 기록이 불완전/)).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "재작성 1회 추가 승인 후 재개" }),
  );
  expect(grant).toHaveBeenCalledOnce();
});
it("실행 중 중복 승인을 막고 감사 진행에는 승인 버튼을 띄우지 않는다", () => {
  const grant = vi.fn();
  const view = render(
    <RevisionPanel account={account} paused busy onGrant={grant} />,
  );
  fireEvent.click(screen.getByRole("button"));
  expect(grant).not.toHaveBeenCalled();
  view.rerender(
    <RevisionPanel
      account={account}
      paused={false}
      busy={false}
      onGrant={grant}
    />,
  );
  expect(screen.queryByRole("button")).toBeNull();
});

import { ReviewPanel } from "../src/web/ReviewPanel";
it("계획 검토와 구현 리뷰를 나눠 표시하고 중단된 종류만 추가 승인한다", () => {
  const grant = vi.fn();
  render(
    <ReviewPanel
      accounts={[
        {
          topicId: "t",
          scope: "planning",
          used: 3,
          limit: 3,
          version: 2,
          historyIncomplete: false,
        },
        {
          topicId: "t",
          scope: "implementation",
          used: 1,
          limit: 3,
          version: 1,
          historyIncomplete: false,
        },
      ]}
      paused="planning"
      busy={false}
      onGrant={grant}
    />,
  );
  expect(screen.getByText("계획 검토 · 3 / 3회")).toBeTruthy();
  expect(screen.getByText("구현 리뷰 · 1 / 3회")).toBeTruthy();
  fireEvent.click(screen.getByRole("button"));
  expect(grant).toHaveBeenCalledWith("planning", 2);
});
