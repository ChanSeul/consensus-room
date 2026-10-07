import { z } from "zod";
import { maxCharacters } from "./textLimits.js";

export const PlanningMigrationSchema = z.object({
  sessionId: z.uuid(), scopeGeneration: z.number().int().positive(), planEpoch: z.number().int().nonnegative(),
  interruptedSHA256: z.string().regex(/^[a-f0-9]{64}$/), apply: z.boolean(),
}).strict();
export type PlanningMigration = z.infer<typeof PlanningMigrationSchema>;

// This authorizes continuation with unknown cost; it never claims missing usage was measured.
export const PlanningUsageRecoverySchema = z.object({
  checkpointId: z.string().min(1), checkpointSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  gapIds: z.array(z.string().min(1)).min(1).max(100),
  acceptUnknownUsage: z.literal(true), reason: z.string().trim().min(1).max(2000),
}).strict();
export type PlanningUsageRecovery = z.infer<typeof PlanningUsageRecoverySchema>;
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
export function planningUsageBlocked(record: PlanningCheckpoint): boolean {
  return planningUsageGaps(record).some(gap => !gap.authorization);
}

// 한 호출 패킷 한도(계획 64KiB·검토 96KiB)는 자료 분할 기준이다. 같은 세션의 누적 호스트 입력·응답은 측정값으로만 남기고 다음 호출을 막는 기준으로 쓰지
// 않는다(plan §3.6, E3-3a — 예전 검토 누적 한도 감사 256KiB·종결 384KiB 는 제거했다). 조사 회차도 측정값이다 — 회차 수만으로 최종 정리를 강제하지 않고
// (예전 고정 회차 8 + 정리 1 은 제거, E3-4a), 진척 없는 반복(stalledRounds)·예산 soft limit·취소·권한·공급자 오류가 끊는다.
// 읽기는 쪽(fragmentBytes) 단위로 자르고, 한 회차에 싣는 양은 별도 묶음 한도 없이 실측한 패킷 남은 공간이 정한다(guardedPlanning 의 읽기 패커).
export const PLANNING_LIMITS = {
  promptBytes: 64 * 1024, reviewPromptBytes: 96 * 1024,
  fragmentBytes: 8 * 1024,
  checkpointBytes: 12 * 1024, requests: 4, stalledRounds: 2,
} as const;

export function planningPacketLimit(stage: string): number {
  return stage === "CODEX_AUDIT" || stage === "CODEX_CLOSEOUT"
    ? PLANNING_LIMITS.reviewPromptBytes : PLANNING_LIMITS.promptBytes;
}

// 공백만 있는 사유는 trim 뒤 비어 거부된다 — 같은 판정을 정규식으로도 두어 생성 스키마(z.toJSONSchema)가 pattern 으로 싣게 한다(R4 리뷰 F002).
const RereadReasonSchema = maxCharacters(z.string().trim().min(1).regex(/\S/), 500);
// 범위 읽기의 끝 — 배타적 UTF-8 바이트 위치. offset 의 쪽은 항상 싣고, 이어지는 쪽은 그 쪽의 시작이 end 보다 앞일 때까지 싣는다(쪽을 자르지 않는다 —
// 쪽 신원 kind·selector·hash·offset 이 그대로다). null 은 문서 끝까지다(사용자 결정 2026-10-06). 모델 출력 스키마는 이 필드를 반드시 쓰게 하고,
// 필드가 없는 값은 배포 전에 저장된 요청·이연 읽기뿐이라 그때의 계약대로 한 쪽으로 읽는다(readRangeEnd).
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
// 저장 형식의 범위 끝 — 필드 없음(옛 요청)은 offset 의 한 쪽만이다. 대기 읽기(QueuedRead)는 이 값으로 정규화해 저장하므로 offset 이 전진해도 범위가 늘지 않는다.
export function readRangeEnd(read: { offset: number; end?: number | null }): number | null {
  return read.end === undefined ? read.offset + 1 : read.end;
}
// 범위 읽기가 nextOffset 의 쪽까지 이어지는가(정규화한 end 기준).
export function readContinues(read: { end: number | null }, nextOffset: number | null): nextOffset is number {
  return nextOffset !== null && (read.end === null || nextOffset < read.end);
}
export const PlanningStepSchema = z.object({
  draft: z.string(),
  facts: z.array(z.object({ statement: z.string(), refs: z.array(z.string()).min(1) }).strict()),
  contradictions: z.array(z.string()),
  questions: z.array(z.string()),
  requests: z.array(PlanningReadSchema).max(PLANNING_LIMITS.requests),
  complete: z.boolean(),
}).strict();
export type PlanningStep = z.infer<typeof PlanningStepSchema>;
// 모델 출력은 범위 끝을 반드시 밝힌다(null = 문서 끝) — 필드가 빠진 값을 옛 한 쪽 계약과 구분할 수 없게 두지 않는다.
export const PlanningStepJsonSchema = z.toJSONSchema(PlanningStepSchema.safeExtend({
  requests: z.array(PlanningReadSchema.safeExtend({ end: ReadEndSchema.nullable() })).max(PLANNING_LIMITS.requests),
}));
// Codex structured outputs require every object property. Null means the optional reread reason is absent.
export const CodexPlanningStepJsonSchema = z.toJSONSchema(PlanningStepSchema.safeExtend({
  requests: z.array(PlanningReadSchema.safeExtend({ end: ReadEndSchema.nullable(), rereadReason: RereadReasonSchema.nullable() }))
    .max(PLANNING_LIMITS.requests),
}));

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
  // Both task versions and their delivery descriptors belong to the same logical attempt.
  // Operational pause/retry events must not silently replace the saved full-context version.
  taskContext?: { freshSessionPrompt?: string; timelineDelivery?: TimelineDelivery; readablePaths?: readonly string[] };
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
  // The task body is a required context document when its inline packet would overflow.
  // Reading is tracked in the existing per-session byte-range receipts, not another attempt.
  taskReference?: Pick<TimelineReference, "selector" | "hash" | "bytes" | "unit" | "version">;
  instructionReference?: Pick<TimelineReference, "selector" | "hash" | "bytes" | "unit" | "version">;
  contextReferences?: Array<Pick<TimelineReference, "selector" | "hash" | "bytes" | "unit" | "version">>;
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
  // Actual delivery paired with the saved response; never infer reads from a reconstructed packet.
  pendingResponseReceipt?: {
    sessionId: string | null; contract: RecoveryContract; inputSequence: number;
    sourceHash: string; instructionHash: string; responseHash: string;
    presented: TimelineReference[];
    reads: Array<Pick<PlanningFragment, "kind" | "selector" | "hash" | "offset" | "nextOffset">>;
  };
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
  // 이 체크포인트가 문서로 싣는 타임라인 참조(E3-2-2a) — 만들 때 고정한다. 읽기가 진행돼도 문서 목록이 줄지 않아야 체크포인트가 초기화되지 않는다.
  timeline?: CheckpointTimeline;
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
// 복구 세션이 승인 계획을 이어받았다는 검증(E3-3b, 연속성 v2 작성자 좌석). 새 세션 S1 에서 읽기 전용 확인 턴(기존 ACK 프롬프트)을 마친 뒤에만
// verified 가 되고, 그때 참여자·ACK·승인 바인딩·구현 세션이 한 transaction 으로 S1 로 옮겨진다. handoff 는 S1 의 첫 쓰기 턴이 전문 판을 받았는가다.
export interface RecoveryVerification {
  phase: "pending" | "verified"; session: string | null;
  planSHA256: string; scopeGeneration: number; planEpoch: number; evidenceDigest: string; binding: unknown;
  handoff?: "fresh-pending" | "done"; at?: string; acknowledged?: { kind: string; planSHA256: string | null; summary: string };
}
export interface RecoveryRecord {
  at: string; reason: Exclude<AgentRunErrorCode, "unknown">; fromSession: string | null; toSession: string | null;
  // 실행 전에 ID만 할당된 뒤 대화가 없음을 확인한 세션. 같은 복구의 생성 재개이며 새 복구 횟수로 세지 않는다.
  unstartedSessions?: string[];
  // 호스트가 부를 수 있는 공급자 압축이 없으면 unsupported, CLI 자동 압축만 있으면 automatic-only — 어느 쪽이든 같은 route 새 세션으로 인계한다.
  compaction: "unsupported" | "automatic-only";
  contract: RecoveryContract; baseline: RecoveryProgress; error: RecoveryError;
  // 작업 좌석(E3-3b): 실패한 호출의 사용량 관측, 기준선 시점 같은 논리 작업(workId)의 검증 계열 checkpoint 가 가진 열린 요청 id, v2 복구 세션 검증.
  usage?: InvocationUsage; requests?: { workId: string; open: string[] }; verification?: RecoveryVerification;
}
// 작업·리뷰 좌석 계보의 경계 표식(E3-3b) — 승인·수락 게이트를 통과한 상태 전이 이벤트(한 transaction)에만 싣는다. 전이 문자열·SHA·epoch 로 추론하지
// 않는다. 같은 전이의 재사용·retry·재키·DB 다시 열기는 새 이벤트를 만들지 않는다.
export type RecoveryBoundaryKind = "approval" | "implementation" | "fix" | "fix-closed" | "review" | "review-passed";
export interface RecoveryBoundary { seat: "implementer" | "code-review"; kind: RecoveryBoundaryKind; ref: Record<string, unknown> }
export interface RecoveryLineage {
  anchor: RecoveryAnchor | null; sessions: string[]; recoveries: RecoveryRecord[];
  // 자동 복구하지 않고 멈춘 사유(두 번째 무진척 실패·신원 불일치·사용량 누락·복구 세션 검증 실패). 원형 오류를 함께 남긴다. requests.open 은 실패 시점
  // 같은 작업의 검증 계열 checkpoint 가 가진 열린 요청 — 읽지 못했거나(손상) 다른 작업이면 null 이다(빈 목록 = 전부 해소와 구분한다).
  blocked?: { at: string; reason: AgentRunErrorCode | "identity-mismatch"; error: RecoveryError; contract: RecoveryContract;
    sessions?: { requested: string | null; returned: string | null }; baseline?: RecoveryProgress; current?: RecoveryProgress;
    usage?: InvocationUsage; requests?: { baseline: string[]; open: string[] | null }; verification?: string } | null;
  previous?: Omit<RecoveryLineage, "previous"> | null;
}

export class PlanningPaused extends Error {
  constructor(message: string, readonly reason: "control" | "evidence" = "control") { super(message); this.name = "PlanningPaused"; }
}

// 타임라인 버전 고정 참조(E3-2-2a). 엔진이 불변 timeline_events 행으로 만든 이 descriptor 가 정본이다 — 프롬프트의 참조 줄은 모델용 표시일 뿐이고,
// 계획 제어 래퍼는 문자열을 해석하지 않고 descriptor 로만 읽을 문서를 싣는다. 구간 단위는 계획 제어 읽기(PlanningReader)와 같은 UTF-8 바이트 v1 이다.
export const TIMELINE_REFERENCE_UNIT = "utf8";
export const TIMELINE_REFERENCE_VERSION = 1;
// 필수 이벤트: 결정·범위 변경. 커도 빠지지 않고, 끝까지 읽기 전에는 계획 단계의 complete 를 받지 않는다.
export const TIMELINE_REQUIRED_KINDS: ReadonlySet<string> = new Set(["decision", "scope_change"]);
// 인라인 원문과 참조 목록의 예산 — 과제 패킷(64/96KiB)에 계획·지시문과 함께 들어가야 한다. 넘는 이벤트는 참조로, 넘는 참조 목록은 색인 하나로 싣는다.
export const TIMELINE_DELIVERY_LIMITS = { inlineBytes: 16 * 1024, referenceBytes: 6 * 1024 } as const;
export interface TimelineReference {
  seq: number; hash: string; bytes: number; required: boolean;
  unit: typeof TIMELINE_REFERENCE_UNIT; version: typeof TIMELINE_REFERENCE_VERSION; selector: string;
}
export interface TimelineIndexReference { selector: string; hash: string; bytes: number; count: number; required: number }
export interface TimelineDeliveryPlan { inline: number[]; references: TimelineReference[]; index: TimelineIndexReference | null }
// 과제 프롬프트 두 판(SessionTurn.prompt·freshSessionPrompt)에 각각 대응한다.
export interface TimelineDelivery { prompt?: TimelineDeliveryPlan; fresh?: TimelineDeliveryPlan }
// 체크포인트에 고정한 참조 문서. prompt·fresh: 두 과제 판이 실은 참조, merged: 진행 중 병합한 새 사용자 입력, indexes: 색인과 그 구성원(seq),
// carried: 같은 세션이 앞선 턴에서 받았지만 끝까지 읽지 않은 참조(carriedFrom 세션에서만 제시한다 — 새 세션은 이어받지 않는다).
export interface CheckpointTimeline {
  prompt: TimelineReference[]; fresh: TimelineReference[]; merged: TimelineReference[];
  indexes: Array<{ index: TimelineIndexReference; members: number[] }>;
  carried: TimelineReference[]; carriedFrom: string | null;
  // 실제로 전체 판을 보냈으면 prompt·merged 대신 쓰는 참조 목록(F001·F005). 빈 목록도 전체 판을 보냈다는 뜻이다.
  freshSent?: TimelineReference[];
}
