import { randomInt } from "node:crypto";
import { brainstormReplies, buildBrainstormPrompt, latestBrainstormRound, type BrainstormRole } from "../../shared/brainstorm.js";
import { redactAgentResult } from "../security.js";
import { EngineCore } from "./core.js";

export class BrainstormPipeline {
  constructor(private readonly core: EngineCore) {}

  async run(topicId: string, signal: AbortSignal, newRound: boolean): Promise<void> {
    const db = this.core.dependencies.database;
    const initial = db.getTopic(topicId);
    this.core.requireParticipants(initial);
    const previous = latestBrainstormRound(db.getScopedTimeline(topicId, initial.scopeGeneration));
    if (!newRound && !previous) throw new Error("재개할 논의 라운드가 없습니다.");
    if (newRound) {
      const order: [BrainstormRole, BrainstormRole] = randomInt(2) === 0 ? ["planner", "reviewer"] : ["reviewer", "planner"];
      // 순서와 실행 상태를 함께 확정한다. 실패·재시작은 같은 라운드의 남은 발언만 잇는다.
      db.applyTopicTransition({ topicId, changes: { state: "BRAINSTORMING", lastError: null, resumeState: null }, events: [{
        actor: "system", kind: "system", state: "BRAINSTORMING",
        body: `${(previous?.number ?? 0) + 1}번째 논의를 시작합니다. AI 발언 순서는 무작위로 정했고, 각자 한 번씩 말한 뒤 멈춥니다.`,
        payload: { brainstormRound: { number: (previous?.number ?? 0) + 1, order } },
      }] });
    } else this.core.transition(topicId, "BRAINSTORMING", "중단된 논의의 남은 발언을 이어갑니다.");

    let topic = db.getTopic(topicId);
    const round = latestBrainstormRound(db.getScopedTimeline(topicId, topic.scopeGeneration))!;
    for (const [index, role] of round.order.entries()) {
      this.core.assertCurrent(topicId, signal, topic.scopeGeneration, "BRAINSTORMING");
      const events = db.getScopedTimeline(topicId, topic.scopeGeneration);
      if (brainstormReplies(events, round.sequence).some(event => event.payload.brainstormRole === role)) continue;
      topic = db.getTopic(topicId);
      const route = this.core.route(topic, { role, operation: "brainstorm" });
      const result = await this.core.turn(route, topic, buildBrainstormPrompt(topic.title, events, index + 1), signal, {
        repairContextKey: `brainstorm:${round.sequence}:${role}`,
        check: result => {
          this.core.assertKind(result, "BRAINSTORM");
          if (result.memoryUpdates?.length || result.findings.length || result.planMarkdown || result.planEdits?.length || result.planLineEdits || result.planSHA256) {
            throw new Error("논의 결과에는 발언만 담으세요. 계획·승인·메모리 변경은 이 단계의 결과가 아닙니다.");
          }
        },
      });
      this.core.assertCurrent(topicId, signal, topic.scopeGeneration, "BRAINSTORMING");
      const safe = redactAgentResult(result);
      // 한 DB 이벤트가 발언 전문과 완료 체크포인트다. 둘 사이에 중단되어 완료 발언을 다시 실행하는 틈이 없다.
      this.core.event(topicId, route.seat, "agent_output", safe.summary, {
        resultKind: "BRAINSTORM", brainstormRoundSequence: round.sequence, brainstormRole: role,
        route: { provider: route.provider, participant: route.participant, profileId: route.profileId, basis: route.basis, job: route.job },
        evidenceRefs: safe.evidenceRefs, requestedUserDecision: safe.requestedUserDecision,
      });
    }
    this.core.transitionWith(topicId, "BRAINSTORM_READY", "두 참여자가 한 번씩 의견을 냈습니다. 추가 논의, 계획으로 진행, 논의 종료 중 다음 행동을 선택해 주세요.", {
      payload: { brainstormCompletedActionId: this.core.active.get(topicId)!.actionId },
    });
  }
}
