import { describe, expect, it } from "vitest";
import type { TimelineEvent } from "../src/shared/contracts";
import { pendingReviewRequests, reviewAnswerCandidate } from "../src/server/engine/reviewRequests";

function event(sequence: number, actor: string, kind: string, payload = {}, body = "", scopeGeneration = 1): TimelineEvent {
  return { sequence, actor, kind, payload, body, scopeGeneration } as TimelineEvent;
}
const question = (sequence = 1) => event(sequence, "codex", "agent_output", { resultKind: "FINAL_REVIEW", findings: [], requestedUserDecision: "배포 채널?" });
const decision = (sequence = 2, body = "보류하고 다른 작업만 진행") => event(sequence, "user", "decision", {}, body);

describe("review request ledger", () => {
  it("보류·무관한 결정·공식 구현 재개 이벤트는 어떤 질문도 해소하지 않는다", () => {
    const resume = event(3, "user", "decision", { implementationResume: {} }, "구현 계속 재개(공식)");
    const records = [question(), decision(), resume];
    expect(pendingReviewRequests(records, 1)).toHaveLength(1);
    expect(reviewAnswerCandidate(resume)).toBe(false);
    expect(pendingReviewRequests([...records, event(4, "codex", "agent_output", { resultKind: "FINAL_REVIEW", findings: [], status: "completed" })], 1)).toHaveLength(1);
  });
  it("질문별 답변 확인만 해소하며 잘못된 요청·질문 이전 결정·다른 세대는 해소하지 않는다", () => {
    const second = event(2, "codex", "agent_output", { resultKind: "REVIEW", findings: [], requestedUserDecision: "배포 시간?" });
    const records = [question(), second, decision(3, "A 채널, 시간은 보류")];
    const [a, b] = pendingReviewRequests(records, 1);
    expect(pendingReviewRequests([...records, event(4, "system", "system", { reviewRequestAnswers: [{ requestId: a.id, decisionSequence: 3 }] })], 1)).toEqual([b]);
    for (const answers of [[{ requestId: "unknown", decisionSequence: 3 }], [{ requestId: a.id, decisionSequence: 0 }]]) {
      expect(pendingReviewRequests([...records, event(4, "system", "system", { reviewRequestAnswers: answers })], 1)).toHaveLength(2);
    }
    expect(pendingReviewRequests([...records, event(4, "system", "system", { reviewRequestAnswers: [{ requestId: a.id, decisionSequence: 3 }] }, "", 2)], 1)).toHaveLength(2);
  });
  it("blocked 리뷰와 구버전 blocked 정지 모두 다음 리뷰 출력이 요청을 생략해도 보존한다", () => {
    const blocked = event(1, "codex", "agent_output", { resultKind: "FINAL_REVIEW", status: "blocked", findings: [] }, "확인 필요");
    const next = event(3, "codex", "agent_output", { resultKind: "FINAL_REVIEW", status: "completed", findings: [] });
    expect(pendingReviewRequests([blocked, next], 1)).toHaveLength(1);
    const legacy = event(1, "codex", "agent_output", { resultKind: "FINAL_REVIEW", findings: [] }, "확인 필요");
    expect(pendingReviewRequests([legacy, event(2, "system", "system", { runnerBlocked: true, resumeState: "CODEX_FINAL_REVIEW" }), next], 1)).toHaveLength(1);
  });
  it("확인 턴은 새로운 코드 리뷰 질문을 만들지 않고, 같은 질문의 재출력은 하나로 남는다", () => {
    expect(pendingReviewRequests([question(), question(2)], 1)).toHaveLength(1);
    const response = event(2, "codex", "agent_output", { resultKind: "REVIEW", reviewAnswerConfirmation: true, status: "blocked", findings: [] });
    expect(pendingReviewRequests([question(), response], 1)).toHaveLength(1);
  });
});

describe("R2 confirmed answer revocation", () => {
  it("retains resolved questions for rechecking after a later decision", () => {
    const records = [question(), decision(2, "A 채널 승인")];
    const [request] = pendingReviewRequests(records, 1);
    records.push(event(3, "system", "system", { reviewRequestAnswers: [{ requestId: request.id, decisionSequence: 2 }], reviewAnswersThrough: 2 }));
    expect(pendingReviewRequests(records, 1)).toEqual([]);
    records.push(decision(4, "채널 승인 취소, 보류"));
    expect(pendingReviewRequests(records, 1).map(r => r.id)).toEqual([request.id]);
    records.push(event(5, "system", "system", { reviewRequestAnswers: [], reviewAnswersThrough: 4 }));
    expect(pendingReviewRequests(records, 1).map(r => r.id)).toEqual([request.id]);
    records.push(decision(6, "A 채널 재승인"));
    records.push(event(7, "system", "system", { reviewRequestAnswers: [{ requestId: request.id, decisionSequence: 6 }], reviewAnswersThrough: 6 }));
    expect(pendingReviewRequests(records, 1)).toEqual([]);
    expect(reviewAnswerCandidate(event(8, "user", "decision", { oid: "abc", paths: ["a"] }))).toBe(false);
    records.push(event(8, "user", "decision", { discardedCommitOID: "abc", restoredHead: "def" }));
    expect(pendingReviewRequests(records, 1)).toEqual([]);
  });
});
