import { z } from "zod";
import { maxCharacters } from "./textLimits.js";

export interface PlanningUsageGap {
  id: string; round: number; sessionId: string | null; executionId?: string;
  observedUsage: Partial<PlanningUsage>; missingFields: string[];
  authorization?: { requestKey: string; reason: string; at: string };
}

export function planningUsageGaps(record: PlanningCheckpoint): PlanningUsageGap[] {
  if (!record.usageIncomplete) return [];
  // Legacy checkpoints retain the whole unknown attempt; no fabricated per-call measurement.
  return record.usageGaps?.length ? record.usageGaps : [{ id: `legacy:${record.admissionId}`, round: record.round,
    sessionId: record.sessionId, observedUsage: {}, missingFields: ["legacy-call-usage"] }];
}

// 계획 단계 응답 한 번에 청할 수 있는 읽기 수 — 아래 PlanningStep 스키마의 제약이다.
export const PLANNING_LIMITS = { requests: 4 } as const;

// 공백만 있는 사유는 trim 뒤 비어 거부된다.
const RereadReasonSchema = maxCharacters(z.string().trim().min(1).regex(/\S/), 500);
// 범위 읽기의 끝 — 배타적 UTF-8 바이트 위치. offset 의 쪽은 항상 싣고, 이어지는 쪽은 그 쪽의 시작이 end 보다 앞일 때까지 싣는다(쪽을 자르지 않는다 —
// 쪽 신원 kind·selector·hash·offset 이 그대로다). null 은 문서 끝까지다(사용자 결정 2026-10-06).
// 필드가 없는 값은 배포 전에 저장된 요청·이연 읽기뿐이라 그때의 계약대로 한 쪽으로 읽는다.
const ReadEndSchema = z.number().int().positive();
export const PlanningReadSchema = z.object({
  kind: z.enum(["file", "search", "evidence", "memory", "context", "artifact", "image"]),
  selector: maxCharacters(z.string().min(1), 1024),
  question: maxCharacters(z.string().min(1), 500),
  offset: z.number().int().nonnegative(),
  end: ReadEndSchema.nullish(),
  rereadReason: RereadReasonSchema.nullish(),
}).strict();
export type PlanningRead = z.infer<typeof PlanningReadSchema>;
export const PlanningStepSchema = z.object({
  draft: z.string(),
  facts: z.array(z.object({ statement: z.string(), refs: z.array(z.string()).min(1) }).strict()),
  contradictions: z.array(z.string()),
  questions: z.array(z.string()),
  requests: z.array(PlanningReadSchema).max(PLANNING_LIMITS.requests),
  complete: z.boolean(),
}).strict();
export type PlanningStep = z.infer<typeof PlanningStepSchema>;

export interface PlanningFragment {
  id: string;
  kind: PlanningRead["kind"];
  selector: string;
  hash: string;
  offset: number;
  nextOffset: number | null;
  content: string;
}
// 사용자 결정 요청 뒤로 미룬 읽기(E3-4a Q-C) — 요청 당시 고정 스냅숏의 원문 버전(전체 원문 해시, 읽을 수 없었으면 null)을 함께 둔다. 결정 뒤 시도가 지금 고정
// 스냅숏에서 selector·버전을 다시 대조해 제공한다(바뀌었으면 첫 구간부터, 없어졌으면 제공하지 않음). 재읽기 사유(rereadReason)도 요청 그대로 보존한다 —
// 버리면 같은 세션이 이미 받은 조각이라 생략돼, 압축으로 잃은 문맥의 명시적 복구가 실행되지 않는다(host-review 39d21df9 F006).
export interface DeferredRead { kind: PlanningRead["kind"]; selector: string; offset: number; end?: number | null; question: string; hash: string | null; rereadReason?: string }
// 대기 읽기(호스트 소유) — 모델이 청했지만 아직 이 세션에 다 싣지 못한 범위. offset 은 아직 채택되지 않은 첫 쪽이고 end 는 정규화한 범위 끝이다.
// 읽기 패커가 회차마다 남은 패킷 공간에 이어 싣고, 단계 채택(acceptStep)이 실린 쪽만큼 전진시킨다 — 다음 응답이 다시 청하지 않아도 버리지 않는다.
export interface QueuedRead { kind: PlanningRead["kind"]; selector: string; question: string; offset: number; end: number | null; rereadReason?: string }
export interface PlanningUsage {
  inputTokens: number; cachedInputTokens: number; outputTokens: number; durationMs: number;
}
export const PLANNING_METRIC_KEYS = ["inputBytes", "apiDurationMs", "toolDurationMs", "toolCalls", "costUSD", "modelTurns", "internalRequests"] as const;
export type PlanningMetrics = Partial<Record<typeof PLANNING_METRIC_KEYS[number], number>>;
export interface PlanningCheckpoint {
  version: 1; id: string; key: string; topicId: string; role: "claude" | "codex";
  stage: string; tree: string; evidenceDigest: string; instructionHash: string;
  scopeGeneration: number; planEpoch: number; prompt: string; inputSequence: number;
  planSHA256: string | null;
  admissionId: string; round: number; stalled: number; sessionId: string | null;
  step: PlanningStep; fragments: PlanningFragment[]; delivered: string[];
  // 대기 읽기 — 없으면 배포 전 체크포인트다(재개 블록이 그때의 대기 요청에서 한 번 채운다).
  readQueue?: QueuedRead[];
  // Request feedback, never evidence. Persist until the next response is adopted, including interrupted calls.
  readErrors?: Array<{ request: PlanningRead; message: string }>;
  usage: PlanningUsage; updatedAt: string; stopped: string | null;
  finalized: boolean; finalAttempted: boolean;
  citationRepairAttempted?: boolean;
  checkpointRepair?: { bytes: number; attempted: boolean };
  started: boolean; injectedBytes: number;
  sourceHash?: string;
  // Selected memory and approved artifacts are decision premises, independent of the external corpus.
  premiseHash?: string;
  deliveredContractHash?: string;
  deliveredInstructionHash?: string;
  peakStep?: PlanningUsage;
  lastRequestInputTokens?: number;
  peakRequestInputTokens?: number;
  imageBytes?: number;
  responseBytes?: number;
  usageIncomplete?: boolean;
  usageGaps?: PlanningUsageGap[];
  metrics?: PlanningMetrics;
  sessions?: string[];
  // 앞선 대화들의 누적(엔진 개편 E2b) — 참여자가 바뀌어 한 논리 시도가 대화 여럿에 걸치면, 이 레코드의 round·started·injectedBytes 등은 지금 대화의
  // 측정값이고(세션 문맥 판정·새 세션 회전이 읽는다) 앞선 대화들의 합은 여기에 둔다 — 조사 한도·예산 환급·진행 표시(progress)가 지금 대화 값과 더해 읽는다.
  priorAttempt?: { rounds: number; started: boolean; injectedBytes: number; imageBytes: number; deliveredFragments: number };
  lastResponse?: import("./contracts.js").AgentResult;
  responsePending?: boolean;
  // A recoverable provider failure must survive a pause for unknown usage, before another call.
  pendingProviderRecovery?: { sessionId: string | null; contract: RecoveryContract; error: RecoveryError };
  // 최근 응답의 complete 를 중간 단계로 강등했는가(E3-4a Q-A·Q-A2, host-review 39d21df9 F002) — 청한 읽기 수, 끝까지 읽지 않은 필수 타임라인 참조 수, 아직
  // 채택되지 않은 이연 읽기 수. raw 는 lastResponse 에 그대로 있다.
  demotedComplete?: { requests: number; unreadRequired: number; deferred: number };
  // 이연 읽기(E3-4a Q-C) — 결정 요청이 남긴 읽기. 수명(host-review 39d21df9 F002·F005·F006): 실어도 지우지 않고 그 조각이 채택될 때(또는 이미 이 세션에
  // 있어 싣지 않을 때) 지운다. 남아 있으면 완료를 강등하고 결정 요청을 열린 질문으로 둔다.
  deferredReads?: DeferredRead[];
  // 결정을 청하며 읽기(필수 타임라인 미완독·이연 읽기)를 남겨 열어 둔 체크포인트(host-review 39d21df9 F001, E3-2-2a F003). 새 사용자 입력이나 원문
  // 변경 전까지는 같은 시도를 다시 불러도 저장된 질문(lastResponse)을 그대로 돌려준다 — 읽기는 결정 뒤다. 원문 변경 초기화와 다음 채택이 지운다.
  awaitingDecision?: boolean;
  // 처분 확인 회차(core.reopenPlanningCheckpoint, 합동 리뷰 a4628d1d F007) — 이 회차는 모델 호출 한 번이다. 값은 그 호출이 최종 결과를 내지 못해 멈출 때
  // 다음 retry 에 남길 질문이다. 루프(guardedPlanning settleConfirmation)가 채택·정지 때 지운다.
  confirmationRound?: string;
  // 예산이 강제한 정리(soft limit)가 완료 결과 없이 결정만 청해 열어 둔 체크포인트(E5 파일럿 51b22146). 정리 모드는 조사를 막아 모델이 필요한 읽기를
  // requests 가 아니라 결정 문장·questions 로만 남긴다 — 이연 읽기처럼 결정 뒤 같은 시도가 이어야 할 조사 의무다. awaitingDecision 과 함께만 뜻이 있고
  // 재개 판정(openReadObligation)이 읽기 의무와 같이 본다. 다음 채택과 원문 변경 초기화가 다시 정한다.
  synthesisIncomplete?: boolean;
  // lastResponse 가 예산이 강제한 정리 호출의 응답인가 — 응답을 저장한 뒤 채택 전에 끊긴 재생(responsePending)도 같은 판정을 받게 응답과 함께 저장한다.
  responseFromSynthesis?: boolean;
  // 처음 고른 목록(sourceHash) 밖에서 허용 색인으로 찾아 실은 위키 문서의 버전(E3-5) — 경로 → 가린 본문 해시(= 그 문서 조각의 hash). 조각을 실을 때와
  // 상속 조각 재검증이 전달로 되살릴 때 적는다. 색인 문서 자체는 적지 않는다(무관한 위키 편집이 시도를 초기화하지 않게). 실행 시작 때 지금 버전과
  // 다르면 원문 변경(sourceChanged)으로 다루고, 실행 중 현재성 검사는 멈춘다. 원문 변경 초기화가 사실·조각·전달과 함께 지운다.
  memoryReads?: Record<string, string>;
  // 상시 참조 문서(설정 standingReferencePath)를 실은 버전 — selector(절대 경로) → 가린 본문 해시(= 그 문서 조각의 hash). memoryReads 와 같은 규칙이다:
  // 이 문서는 sourceHash 밖이라, 조각을 실을 때와 상속 조각 재검증이 전달로 되살릴 때만 적는다. 실행 시작 때 지금 버전과 다르면 원문 변경(sourceChanged)으로
  // 다루고, 실행 중 현재성 검사는 멈춘다. 원문 변경 초기화가 함께 지운다.
  standingReads?: Record<string, string>;
  // Only external fragments and their source dependencies; availability never resets local research.
  evidenceFragments?: Record<string, string[]>;
  deferredEvidenceSources?: string[];
  imageHash?: string;
  finalResult?: import("./contracts.js").AgentResult;
  // 세션 누적 이력의 측정값(E3-3a) — 같은 세션 체크포인트들의 호스트 입력·응답 합과 이번 패킷. 호출을 막는 기준이 아니다. 기록이 없는 세션은 null(unknown).
  context?: { measuredHistoryBytes: number | null; packetBytes: number };
  // 자동 복구로 이 체크포인트를 떠난 세션들의 대화 측정값(E3-3a) — 복구는 같은 체크포인트에서 새 세션으로 잇고 지금 대화의 측정값을 0 부터 센다.
  // 떠난 세션의 입력·응답 바이트와 실행 여부는 여기 남아 그 세션의 문맥 측정(sessionContext)이 계속 읽는다. 시도 단위 합은 priorAttempt 다.
  sessionMeasurements?: Array<{ sessionId: string; injectedBytes: number; responseBytes: number; started: boolean }>;
}

// 어댑터 경계에서 관측된 실패 형태만 코드로 올린다(E3-3a). 나머지는 unknown — 원형을 보존하고 복구하지 않는다.
export type AgentRunErrorCode = "session-missing" | "context-exceeded" | "unknown";

// 좌석의 복구 계보(E3-3a). 자동 복구 1회는 계보 단위로 소비된다. 새 계보는 엔진이 그 좌석의 결과를 검증·채택해 새 산출물(anchor)이 생긴 경계에서만
// 열린다 — 계획 SHA·epoch·범위 세대·재키·오류 사유·retry·DB 다시 열기는 계보를 바꾸지 않는다(계약 좌표는 기록에 현재 계약 정보로만 남긴다).
export interface RecoveryAnchor { kind: string; revision: number; sha256: string }
export interface RecoveryContract { stage: string; scopeGeneration: number; planEpoch: number; planSHA256: string | null; binding: unknown }
// 계보 진척 스냅숏 — 계보의 모든 세션에서 인정된 원문 구간 합집합의 원본별 덮은 바이트(범위 세대는 원본 신원에 넣지 않는다).
export type RecoveryProgress = Record<string, number>;
// 복구·차단의 근거가 된 실패(E3-3a) — 공급자·코드와 어댑터가 가린(비밀 마스킹)·자른(끝부분 한도) 원형 출력이다. DB 를 다시 열어도 분류를 다시 대조할 수 있다.
export interface RecoveryError {
  provider: "claude" | "codex"; code: AgentRunErrorCode | "identity-mismatch"; message: string;
  raw?: { exitCode: number | null; stderr: string; stdout: string };
}
// 실패한 그 호출(invocation)의 사용량 관측(E3-3b) — 마지막 스냅숏이 완전(complete)했는가. 관측이 없으면 unknown 이고 0 으로 보지 않는다.
export type InvocationUsage = "complete" | "partial" | "unknown";
export interface RecoveryRecord {
  at: string; reason: Exclude<AgentRunErrorCode, "unknown">; fromSession: string | null; toSession: string | null;
  // 실행 전에 ID만 할당된 뒤 대화가 없음을 확인한 세션. 같은 복구의 생성 재개이며 새 복구 횟수로 세지 않는다.
  unstartedSessions?: string[];
  // 호스트가 부를 수 있는 공급자 압축이 없으면 unsupported, CLI 자동 압축만 있으면 automatic-only — 어느 쪽이든 같은 route 새 세션으로 인계한다.
  compaction: "unsupported" | "automatic-only";
  contract: RecoveryContract; baseline: RecoveryProgress; error: RecoveryError;
  // 작업 좌석(E3-3b): 실패한 호출의 사용량 관측, 기준선 시점 같은 논리 작업(workId)의 검증 계열 checkpoint 가 가진 열린 요청 id.
  usage?: InvocationUsage; requests?: { workId: string; open: string[] };
}
// 작업·리뷰 좌석 계보의 경계 표식(E3-3b) — 승인·수락 게이트를 통과한 상태 전이 이벤트(한 transaction)에만 싣는다. 전이 문자열·SHA·epoch 로 추론하지
// 않는다. 같은 전이의 재사용·retry·재키·DB 다시 열기는 새 이벤트를 만들지 않는다.
export type RecoveryBoundaryKind = "approval" | "implementation" | "fix" | "fix-closed" | "review" | "review-passed";
export interface RecoveryLineage {
  anchor: RecoveryAnchor | null; sessions: string[]; recoveries: RecoveryRecord[];
  // 자동 복구하지 않고 멈춘 사유(두 번째 무진척 실패·신원 불일치·사용량 누락). 원형 오류를 함께 남긴다. requests.open 은 실패 시점
  // 같은 작업의 검증 계열 checkpoint 가 가진 열린 요청 — 읽지 못했거나(손상) 다른 작업이면 null 이다(빈 목록 = 전부 해소와 구분한다).
  blocked?: { at: string; reason: AgentRunErrorCode | "identity-mismatch"; error: RecoveryError; contract: RecoveryContract;
    sessions?: { requested: string | null; returned: string | null }; baseline?: RecoveryProgress; current?: RecoveryProgress;
    usage?: InvocationUsage; requests?: { baseline: string[]; open: string[] | null } } | null;
  previous?: Omit<RecoveryLineage, "previous"> | null;
}

// 계획 묶음(planned 모드)의 한 버전. 버전은 스냅샷 산출물(묶음의 정규 직렬화, kind plan)의 sha256 이라 topic.planSHA256·승인 SHA 와 같은 축이다.
// 프롬프트 빌더는 이 구조 필드만 읽는다(경로·버전·변경분 경로 — 본문을 쪼개 싣지 않는다).
export interface PlanBundleSnapshot { version: string; snapshotPath: string }
// 작업 폴더를 버전으로 확정한 결과. previous 는 직전 현재 버전, diffPath 는 그 대비 변경분 산출물이다(첫 버전·변경 없음은 null).
export interface PlanBundleCapture extends PlanBundleSnapshot { previous: string | null; diffPath: string | null; changed: boolean }

export class PlanningPaused extends Error {
  constructor(message: string) { super(message); this.name = "PlanningPaused"; }
}
