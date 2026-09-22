// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { EvidencePanel } from "../src/web/EvidencePanel";
import { api } from "../src/web/api";
import type { EvidenceTopicState } from "../src/shared/externalEvidence";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const state = (ready = true): EvidenceTopicState => ({ plan: { scopeGeneration: 1, planEpoch: 1, planSHA256: "d".repeat(64) }, ready, reviewed: false, digest: "a".repeat(64), sources: [{
  id: "b".repeat(64), label: "Planning", url: "https://team.atlassian.net/browse/APP-1", mode: "connector", intervalSeconds: 900,
  provider: "jira", resource: "team.atlassian.net/APP-1", selector: "", revision: "r1", contentHash: "c".repeat(64), checkedAt: null, error: null, nextCheckAt: 0,
}] });
function pending<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
it("does not allow unverified content to be marked reviewed and preserves the reason after failure", async () => {
  vi.spyOn(api, "evidence").mockResolvedValue(state(false));
  const review = vi.spyOn(api, "reviewEvidence").mockRejectedValue(new Error("Source changed"));
  const view = render(<EvidencePanel topicId="t" busy={false} />);
  const button = await screen.findByRole("button", { name: "현재 계획에서 검토 완료", hidden: true });
  expect(button).toBeDisabled(); expect(review).not.toHaveBeenCalled();
  view.unmount(); vi.spyOn(api, "evidence").mockResolvedValue(state());
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/Slack · Jira · Figma 근거/));
  const input = await screen.findByLabelText("원문 변경 영향");
  fireEvent.change(input, { target: { value: "Compared source and plan" } });
  fireEvent.click(screen.getByRole("button", { name: "현재 계획에서 검토 완료" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Source changed");
  expect(input).toHaveValue("Compared source and plan");
  expect(review).toHaveBeenCalledWith("t", { digest: "a".repeat(64), plan: state().plan, reason: "Compared source and plan" });
});
it("registers once while pending and ignores an older poll that finishes after the mutation", async () => {
  const old = pending<EvidenceTopicState>(); const write = pending<any>();
  vi.spyOn(api, "evidence").mockReturnValueOnce(old.promise).mockResolvedValue(state());
  const add = vi.spyOn(api, "addEvidence").mockReturnValue(write.promise);
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/Slack · Jira · Figma 근거/));
  fireEvent.change(screen.getByLabelText("원문 이름"), { target: { value: "Planning" } });
  fireEvent.change(screen.getByLabelText("원문 링크"), { target: { value: "https://team.atlassian.net/browse/APP-1" } });
  const button = screen.getByRole("button", { name: "원문 등록" });
  fireEvent.click(button); fireEvent.click(button);
  expect(add).toHaveBeenCalledTimes(1); expect(button).toBeDisabled();
  write.resolve(state().sources[0]); await screen.findByRole("link", { name: "Planning" });
  old.resolve({ plan: state().plan, ready: true, reviewed: true, digest: "old", sources: [] });
  await waitFor(() => expect(button).toBeEnabled());
  expect(screen.getByRole("link", { name: "Planning" })).toBeInTheDocument();
});

it("clears the old review reason when polling detects a different plan", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const current = { ...state(), plan: { ...state().plan, planSHA256: "e".repeat(64) } };
  vi.spyOn(api, "evidence").mockResolvedValueOnce(state()).mockResolvedValue(current);
  const review = vi.spyOn(api, "reviewEvidence").mockResolvedValue({});
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/Slack · Jira · Figma 근거/));
  const input = await screen.findByLabelText("원문 변경 영향");
  fireEvent.change(input, { target: { value: "Reason for old plan" } });
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
  await waitFor(() => expect(input).toHaveValue(""));
  fireEvent.change(input, { target: { value: "Compared new plan" } });
  fireEvent.click(screen.getByRole("button", { name: "현재 계획에서 검토 완료" }));
  await waitFor(() => expect(review).toHaveBeenCalledWith("t", { digest: current.digest, plan: current.plan, reason: "Compared new plan" }));
});

it("shows connection setup and shared scope and explicitly converts a source to REST once", async () => {
  const pendingChange = pending<any>();
  const current = { ...state(), connections: [{ sourceId: "b".repeat(64), configured: false, sharedTopics: 2 }] };
  vi.spyOn(api, "evidence").mockResolvedValue(current);
  const convert = vi.spyOn(api, "useRestEvidence").mockReturnValue(pendingChange.promise);
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/Slack · Jira · Figma 근거/));
  expect(await screen.findByText(/서버 읽기 인증 설정 필요/)).toHaveTextContent("공유 주제 2개");
  expect(screen.getByLabelText("원문 연결 방식")).toHaveValue("rest");
  const button = screen.getByRole("button", { name: "서버 수집으로 전환 (공유 주제 모두 적용)" });
  fireEvent.click(button); fireEvent.click(button); expect(convert).toHaveBeenCalledTimes(1);
  pendingChange.reject(new Error("읽기 인증 설정이 필요합니다."));
  expect(await screen.findByRole("alert")).toHaveTextContent("읽기 인증 설정");
  expect(button).toBeEnabled();
});
