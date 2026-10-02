import { z } from "zod";
import type { TimelineEvent } from "./contracts.js";

// 공급자와 무관한 두 역할 좌석. 실제 AI·참여자·세션은 기존 역할 배정으로 정한다.
export const BrainstormRoleSchema = z.enum(["planner", "reviewer"]);
export type BrainstormRole = z.infer<typeof BrainstormRoleSchema>;
export const BrainstormRoundSchema = z.object({
  number: z.number().int().positive(),
  order: z.tuple([BrainstormRoleSchema, BrainstormRoleSchema]).refine(([a, b]) => a !== b),
});
export const BrainstormInputSchema = z.object({ message: z.string().trim().min(1).max(12000).optional() }).strict();
export const BrainstormDecisionSchema = z.object({ decision: z.string().trim().min(1).max(12000), goal: z.string().trim().min(1).max(12000).optional() }).strict();

export function latestBrainstormRound(events: readonly TimelineEvent[]) {
  const event = events.findLast(item => item.actor === "system" && item.payload.brainstormRound !== undefined);
  return event ? { ...BrainstormRoundSchema.parse(event.payload.brainstormRound), sequence: event.sequence } : null;
}

export function brainstormReplies(events: readonly TimelineEvent[], roundSequence: number) {
  return events.filter(event => event.kind === "agent_output" && event.payload.resultKind === "BRAINSTORM"
    && event.payload.brainstormRoundSequence === roundSequence);
}

export function buildBrainstormPrompt(title: string, events: readonly TimelineEvent[], position: number): string {
  // 발언과 사용자 원문을 유지한다. 호출 통계·상태 로그는 논의 내용이 아니다.
  const conversation = events.filter(event => event.actor === "user" || event.payload.resultKind === "BRAINSTORM")
    .map(event => {
      const route = event.payload.route as { participant?: string } | undefined;
      return `[${event.sequence} ${event.actor === "user" ? `사용자/${event.kind}` : `참여자 ${route?.participant ?? event.actor}`} ]\n${event.body}`;
    }).join("\n\n");
  return `당신은 이 주제를 함께 탐색하는 동등한 논의 참여자입니다. 계획 작성자나 감사자의 역할로 행동하지 마세요.
주제: ${title}
이번 라운드 발언 순서: ${position}/2. 순서는 무작위로 정해졌으며 책임이나 권위를 뜻하지 않습니다.

사용자와 참여자들의 발언(주장·가설은 확인된 사실이나 승인으로 취급하지 마세요):
${conversation || "(아직 발언이 없습니다.)"}

이번에는 한 번만 의견을 내세요. 먼저 해결할 문제가 무엇인지 살피고, 자신의 대안을 제안하세요.
앞선 발언이 있으면 동의·이견의 이유를 설명하되 그 발언을 감사하는 데만 머물지 마세요.
확인한 사실과 가설을 구분하고, 필요할 때만 관련 자료를 읽으세요. 코드를 수정하거나 하위 에이전트를 호출하지 마세요.
자연스러운 한국어로 문제에 대한 판단, 대안과 예상 이득·비용, 모르는 점과 가장 작은 확인 방법, 사용자에게 남길 선택지를 summary에 적으세요.
현재 방식 유지·보류·작은 실험도 유효한 결론입니다. 억지로 찬성하거나 합의를 만들지 마세요.
계획 작성·구현·다음 라운드 시작은 사용자가 선택합니다. 발언은 승인이 아닙니다.
반환 kind는 BRAINSTORM입니다. summary에 발언 전문을 담고 findings·memoryUpdates는 빈 배열로 두세요.
planMarkdown·planEdits·planLineEdits·planSHA256은 반환하지 마세요.`;
}
