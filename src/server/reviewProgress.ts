import { reviewScope, type ReviewScope } from "../shared/reviews.js";
import { jobOfTurn } from "./adapters/turnPolicy.js";
import type { ConsensusDatabase } from "./database.js";
import type { AgentAdapter, SessionTurn } from "./types.js";

export function reviewProgressReason(scope: ReviewScope, count: number): string {
  return `${scope === "planning" ? "계획 리뷰" : "구현 리뷰"} 왕복 ${count}회 점검: ` +
    "엔진 결함 또는 다른 문제로 무의미한 왕복이 반복되고 있는지 점검하고, 발견한 문제를 수정한 뒤 작업을 재개하세요. " +
    "최근 5회 응답·읽기 요청·체크포인트·원문 변경을 비교해 실제 진척과 반복 원인을 확인하세요. " +
    "엔진 문제가 아니라고 추정해 넘기지 마세요. 정상 진척이면 실행을 유지하고 중복 시작하지 마세요. " +
    "문제가 있으면 재현 근거를 기록하고 기존 승인 범위에서 수정·검증·필요한 host-review 후 공식 API로 재개하세요. " +
    "실행 중 모델 턴을 중단하거나 계획·근거·세션·한도를 초기화하지 마세요. 권한 밖의 조치만 사용자에게 확인하세요.";
}

// Inside evidence/planning wrappers: one call here is one actual reviewer reply, including
// progressive reads and corrections. Cached checkpoint replay never enters this boundary.
export function monitorReviewProgress(adapter: AgentAdapter, database: ConsensusDatabase): AgentAdapter {
  const run = async <T>(turn: Omit<SessionTurn, "sessionId">, invoke: () => Promise<T>): Promise<T> => {
    if (jobOfTurn(adapter.role, turn).role !== "reviewer") return invoke();
    const topic = database.topicForTurn(turn);
    const scope = topic ? reviewScope(topic.state) : undefined;
    const result = await invoke();
    if (topic && scope && !turn.signal?.aborted) database.recordReviewExchange(topic, scope);
    return result;
  };
  return {
    ...adapter,
    role: adapter.role,
    validateExistingSession: id => adapter.validateExistingSession(id),
    ...(adapter.isSessionMissing ? { isSessionMissing: (id: string) => adapter.isSessionMissing!(id) } : {}),
    createSession: turn => run(turn, () => adapter.createSession(turn)),
    resumeTurn: turn => run(turn, () => adapter.resumeTurn(turn)),
    ...(adapter.resumePlanRepair ? { resumePlanRepair: (turn: SessionTurn) => run(turn, () => adapter.resumePlanRepair!(turn)) } : {}),
  };
}
