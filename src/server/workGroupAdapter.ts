import type { ConsensusDatabase } from "./database.js";
import type { GitService } from "./git.js";
import type { AgentAdapter, SessionTurn } from "./types.js";
import { resolvePriorResults } from "./workGroupService.js";
import { GUARDED_STAGES, timelineReferencesApply } from "./guardedPlanning.js";
import { jobOfTurn } from "./adapters/turnPolicy.js";

export function wrapWorkGroupAdapter(
  adapter: AgentAdapter,
  database: ConsensusDatabase,
  git: GitService,
): AgentAdapter {
  const enrich = async <T extends Omit<SessionTurn, "sessionId">>(
    turn: T,
    sharedPlanning = true,
  ): Promise<T> => {
    const topic = database.topicForTurn(turn);
    const group = topic ? database.workGroups.forTopic(topic.id) : null;
    if (!topic || !group) return turn;
    const stage = group.stages.find(
      (stage) => group.links[stage.id]?.topicId === topic.id,
    )!;
    // 단계 문맥 결속(E4 D2) — 재계획 대기·문맥 해시 변경(E4 전 연결은 묶음 버전 변경)이면 턴을 시작하지 않는다. 선행 결과 해석(git)이 비동기라
    // 그 사이에 개정이 저장될 수 있으므로 경계 뒤에 다시 판정한다. 선행 결과 해석은 동결 결과를 승계 검사하고, 동결 결과가 없는 E4 전 닫힌 단계는
    // 이전 계약 증거로 검증해 (결속을 깨지 않으면) 동결한다 — 이미 열린 E4 전 단계도 새 착수 없이 선행 결과를 확보한다(host-review F005).
    database.workGroups.assertStageContextCurrent(topic.id);
    const { proof } = await resolvePriorResults(database, git, group.id, stage.id);
    database.workGroups.assertStageContextCurrent(topic.id);
    // 머리말은 지금 묶음의 단계 문맥이고, 동결 결과가 덮지 않은 검증 증거(동결하지 않은 E4 전 선행)는 옛 줄 형식으로 잇는다(F009). 선행 결과가
    // 모두 동결돼 있으면 renderStageContext 와 같다.
    const context = database.workGroups.prompt(topic.id, proof);
    if (sharedPlanning && GUARDED_STAGES.has(topic.state) && timelineReferencesApply(database, topic.id, topic.state, turn,
      jobOfTurn(adapter.role, turn).role)) {
      return { ...turn, planningDocuments: [...(turn.planningDocuments ?? []),
        { selector: "shared:work-group", content: context }] };
    }
    // 과제 프롬프트를 바꾸는 변환은 새·교체 세션용 전체 문맥 판에도 똑같이 적용한다 — 계획 제어가 세션을 교체하면 그 판이 과제가 된다
    // (host-review 전 사전 검증 261622a-09250218). 통합 단계 지시는 단계 문맥(render)이 담는다.
    const header = `${context}\n\n`;
    return {
      ...turn, prompt: `${header}${turn.prompt}`,
      ...(turn.freshSessionPrompt !== undefined ? { freshSessionPrompt: `${header}${turn.freshSessionPrompt}` } : {}),
    };
  };
  const wrapped: AgentAdapter = {
    role: adapter.role,
    validateExistingSession: (id) => adapter.validateExistingSession(id),
    ...(adapter.isSessionMissing ? { isSessionMissing: (id: string) => adapter.isSessionMissing!(id) } : {}),
    createSession: async (turn) => adapter.createSession(await enrich(turn)),
    resumeTurn: async (turn) => adapter.resumeTurn(await enrich(turn)),
  };
  if (adapter.resumePlanRepair)
    wrapped.resumePlanRepair = async (turn) =>
      adapter.resumePlanRepair!(await enrich(turn, false));
  return wrapped;
}
