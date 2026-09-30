// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EvidencePanel } from "../src/web/EvidencePanel";
import { api } from "../src/web/api";
import type { EvidenceTopicState, EvidenceCatalog } from "../src/shared/externalEvidence";

afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); });
const state = (ready = true): EvidenceTopicState => ({ plan: { scopeGeneration: 1, planEpoch: 1, planSHA256: "d".repeat(64) }, ready, reviewed: false, digest: "a".repeat(64), sources: [{
  id: "b".repeat(64), label: "Planning", url: "https://team.atlassian.net/browse/APP-1", mode: "connector", intervalSeconds: 900,
  provider: "jira", resource: "team.atlassian.net/APP-1", selector: "", revision: "r1", contentHash: "c".repeat(64), checkedAt: null, error: null, nextCheckAt: 0,
}] });
const catalog = (): EvidenceCatalog => ({ version: "a".repeat(64), groupId: "g", roots: [], entries: [], history: [], coverage: { sources: 0, units: 0, complete: 0, pending: 0, failed: 0, candidates: 0, ready: true } });
beforeEach(() => { vi.spyOn(api, "evidenceCatalog").mockResolvedValue(catalog()); });
function pending<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
it("does not allow unverified content to be marked reviewed and preserves the reason after failure", async () => {
  vi.spyOn(api, "evidence").mockResolvedValue(state(false));
  const review = vi.spyOn(api, "reviewEvidence").mockRejectedValue(new Error("Source changed"));
  const view = render(<EvidencePanel topicId="t" busy={false} />);
  const button = await screen.findByRole("button", { name: "현재 계획에서 검토 완료", hidden: true });
  expect(button).toBeDisabled(); expect(review).not.toHaveBeenCalled();
  view.unmount();
  const loaded = pending<EvidenceTopicState>();
  vi.spyOn(api, "evidence").mockReturnValue(loaded.promise);
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/원문 근거/));
  expect(screen.queryByLabelText("원문 변경 영향")).not.toBeInTheDocument();
  // 초기 응답과 그에 따른 이유 초기화가 반영된 뒤 사용자의 입력을 시작한다.
  await act(async () => { loaded.resolve(state()); await loaded.promise; });
  const input = screen.getByLabelText("원문 변경 영향");
  fireEvent.change(input, { target: { value: "Compared source and plan" } });
  expect(input).toHaveValue("Compared source and plan");
  fireEvent.click(screen.getByRole("button", { name: "현재 계획에서 검토 완료" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Source changed");
  expect(input).toHaveValue("Compared source and plan");
  expect(review).toHaveBeenCalledWith("t", { digest: "a".repeat(64), plan: state().plan, reason: "Compared source and plan" });
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

it("clears the old review reason when polling detects a different plan", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const current = { ...state(), plan: { ...state().plan, planSHA256: "e".repeat(64) } };
  const loaded = pending<EvidenceTopicState>();
  vi.spyOn(api, "evidence").mockReturnValueOnce(loaded.promise).mockResolvedValue(current);
  const review = vi.spyOn(api, "reviewEvidence").mockResolvedValue({});
  render(<EvidencePanel topicId="t" busy={false} />);
  fireEvent.click(screen.getByText(/원문 근거/));
  await act(async () => { loaded.resolve(state()); await loaded.promise; });
  const input = screen.getByLabelText("원문 변경 영향");
  fireEvent.change(input, { target: { value: "Reason for old plan" } });
  expect(input).toHaveValue("Reason for old plan");
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
  fireEvent.click(screen.getByText(/원문 근거/));
  expect(await screen.findByText(/에이전트가 읽은 자료/)).toHaveTextContent("공유 주제 2개");
  expect(screen.queryByText(/서버 읽기 인증 설정 필요/)).not.toBeInTheDocument();
  const button = screen.getByRole("button", { name: "서버 수집으로 전환 (공유 주제 모두 적용)" });
  fireEvent.click(button); fireEvent.click(button); expect(convert).toHaveBeenCalledTimes(1);
  pendingChange.reject(new Error("읽기 인증 설정이 필요합니다."));
  expect(await screen.findByRole("alert")).toHaveTextContent("읽기 인증 설정");
  expect(button).toBeEnabled();
});
