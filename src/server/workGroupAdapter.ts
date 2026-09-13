import type { ConsensusDatabase } from "./database.js";
import type { GitService } from "./git.js";
import type { AgentAdapter, SessionTurn } from "./types.js";
import { stageEvidence } from "./workGroupService.js";

export function wrapWorkGroupAdapter(
  adapter: AgentAdapter,
  database: ConsensusDatabase,
  git: GitService,
): AgentAdapter {
  const enrich = async <T extends Omit<SessionTurn, "sessionId">>(
    turn: T,
  ): Promise<T> => {
    const topic = database
      .listTopics()
      .find((topic) => topic.worktreePath === turn.cwd);
    const group = topic ? database.workGroups.forTopic(topic.id) : null;
    if (!topic || !group) return turn;
    const stage = group.stages.find(
      (stage) => group.links[stage.id]?.topicId === topic.id,
    )!;
    if (group.links[stage.id].groupVersion !== group.version)
      throw new Error(
        "공통 계약이 바뀌었습니다. 현재 단계의 계획을 다시 승인해야 합니다.",
      );
    const proof = await stageEvidence(database, git, group, stage.id);
    const context = database.workGroups.prompt(topic.id, proof);
    const integration =
      stage.kind === "integration"
        ? "\n전체 통합 검증 단계입니다. 앞 단계의 개별 성공만으로 완료하지 말고 공통 계약과 전체 변경을 함께 검증하세요."
        : "";
    return { ...turn, prompt: `${context}${integration}\n\n${turn.prompt}` };
  };
  const wrapped: AgentAdapter = {
    role: adapter.role,
    validateExistingSession: (id) => adapter.validateExistingSession(id),
    createSession: async (turn) => adapter.createSession(await enrich(turn)),
    resumeTurn: async (turn) => adapter.resumeTurn(await enrich(turn)),
  };
  if (adapter.resumePlanRepair)
    wrapped.resumePlanRepair = async (turn) =>
      adapter.resumePlanRepair!(await enrich(turn));
  return wrapped;
}
