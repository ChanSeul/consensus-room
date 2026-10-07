import { reviewScope, type ReviewScope } from "../shared/reviews.js";
import { jobOfTurn } from "./adapters/turnPolicy.js";
import type { ConsensusDatabase } from "./database.js";
import type { AgentAdapter, SessionTurn } from "./types.js";

export function reviewProgressReason(scope: ReviewScope, count: number): string {
  return `${scope === "planning" ? "계획 리뷰" : "구현 리뷰"} 왕복 ${count}회 점검: ` +
    "최근 5회 응답·읽기 요청·체크포인트·원문 변경을 비교해 실제 진척과 반복 원인을 확인하세요. " +
    "당장 고쳐야 하는 엔진 결함인지, 기존 중재·공식 복구로 풀 수 있는 문제인지 소프트웨어 설계 철학에 근거해 판단하세요. " +
    "정상 진척이면 실행을 유지하고 중복 시작하지 마세요. " +
    "문제가 있으면 기존 승인 안의 중재·공식 복구·작업 인계로 제품 작업을 이어갈 수 있는지 먼저 확인하세요. " +
    "즉시 수리가 불가피할 때만 재현 근거·대안이 안 되는 이유·최소 수리 범위와 종료 조건을 정해 수리 담당자에게 전달하세요. " +
    "나머지 엔진 개선은 후속으로 남기고 제품 작업의 선행 조건으로 추가하지 마세요. " +
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
