// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ReviewPanel } from "../src/web/ReviewPanel";

// 재작성 회차 패널(RevisionPanel)은 계획 왕복에 재작성 회차가 없어 지웠다(CR 흐름 단순화). 계획 검토·구현 리뷰 회차는 ReviewPanel 이 보인다.
afterEach(cleanup);
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
