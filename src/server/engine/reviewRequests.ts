import type { TimelineEvent } from "../../shared/contracts.js";
import { AgentResultSchema } from "../../shared/contracts.js";
import { requestId } from "./checkpoint.js";
import { decisionRequestTexts } from "./completion.js";

export interface ReviewRequest { id: string; sequence: number; question: string }

// 상태를 바꾸는 자동 decision 이벤트는 질문의 답변이 아니다.
export function reviewAnswerCandidate(event: TimelineEvent): boolean {
  return event.actor === "user" && event.kind === "decision" && !event.payload?.implementationResume
    && !event.payload?.toleranceAmendment && !String(event.payload?.requestAction ?? "").startsWith("action:");
}

// 사용자 메시지는 요청을 지우지 않는다. 해당 요청·사용자 답변을 대조한 확인 결과만 해소 기록이다.
export function pendingReviewRequests(events: readonly TimelineEvent[], generation: number): ReviewRequest[] {
  let pending: ReviewRequest[] = [];
  let lastReview: TimelineEvent | null = null;
  const decisions = new Map<number, TimelineEvent>();
  const append = (question: string, sequence: number) => {
    if (!pending.some((item) => item.question === question)) pending.push({ id: "R" + requestId(question, sequence), sequence, question });
  };
  for (const event of events) {
    if (event.scopeGeneration !== generation) continue;
    if (reviewAnswerCandidate(event)) decisions.set(event.sequence, event);
    if (event.actor === "system" && event.kind === "system" && Array.isArray(event.payload?.reviewRequestAnswers)) {
      for (const answer of event.payload.reviewRequestAnswers) {
        const request = pending.find((item) => item.id === answer?.requestId);
        const decision = decisions.get(answer?.decisionSequence);
        if (request && decision && decision.sequence > request.sequence) pending = pending.filter((item) => item.id !== request.id);
      }
    }
    if (event.kind === "agent_output") {
      lastReview = event.actor === "codex" && !event.payload?.reviewAnswerConfirmation && ["REVIEW", "FINAL_REVIEW"].includes(String(event.payload?.resultKind)) ? event : null;
      if (lastReview) {
        const findings = AgentResultSchema.shape.findings.parse(event.payload?.findings ?? []);
        const status = AgentResultSchema.shape.status.parse(event.payload?.status);
        const asked = AgentResultSchema.shape.requestedUserDecision.parse(event.payload?.requestedUserDecision);
        const remainingSteps = AgentResultSchema.shape.remainingSteps.parse(event.payload?.remainingSteps);
        for (const text of decisionRequestTexts({ findings, status, requestedUserDecision: asked, remainingSteps, summary: event.body })) append(text, event.sequence);
      }
    }
    // 구버전은 출력 이벤트에 status 를 남기지 않았다. 바로 그 리뷰를 멈춘 runnerBlocked 기록으로 복구한다.
    if (lastReview && event.actor === "system" && event.payload?.runnerBlocked === true
      && ["CODEX_REVIEW", "CODEX_FINAL_REVIEW"].includes(String(event.payload?.resumeState))
      && lastReview.payload?.status === undefined && !pending.some((item) => item.sequence === lastReview!.sequence)) {
      const texts = decisionRequestTexts({ findings: [], status: "blocked", summary: lastReview.body,
        requestedUserDecision: undefined, remainingSteps: Array.isArray(event.payload.remainingSteps) ? event.payload.remainingSteps : [] });
      for (const text of texts) append(text, lastReview.sequence);
      lastReview = null;
    }
  }
  return pending;
}
