import type {
  AgentExecutionSettings,
  AgentResult,
  PlanRepair,
  AgentRole,
  MemoryUpdate,
  WorkflowState,
} from "../shared/contracts.js";
import type { TurnJob } from "../shared/roles.js";
import type { TurnEnvelope } from "../shared/turnContract.js";

export type ParticipantRole = Extract<AgentRole, "claude" | "codex">;

export interface AppliedMemoryChange {
  path: string;
  previousSHA256: string | null;
  sha256: string;
  reason: string;
  // rejected: 스냅샷 이후 파일이 바뀌었거나 계약을 어겨 쓰지 않았다는 뜻이다. 메모리는 턴의 부산물이므로
  // 이 실패가 턴 결과를 버리게 두지 않는다 — 사유를 남기고 에이전트 산출물은 그대로 저장한다.
  status: "written" | "unchanged" | "rejected";
  error?: string;
}

export interface ProjectMemoryWriter {
  apply(role: ParticipantRole, updates: readonly MemoryUpdate[]): Promise<AppliedMemoryChange[]>;
}

export interface CommandSpec {
  // 실행 허용 검사 — 준비(임시 파일·슬롯 대기)가 전부 끝난 뒤 spawn 직전에 부른다. 던지면 spawn 하지 않는다
  // (PLAN §2 "다음 실행 허용": 취소·새 결정/증거·계획 변경·유지보수·예산은 adapter 호출 전이 아니라 spawn 직전에 본다).
  //   beforeSpawn : 비동기 검사(Git HEAD 등) — await 한다.
  //   admitSync   : **동기** 마지막 검사(취소·새 입력·계획·실행 상태) — 이 호출과 spawn 사이에 await 가 없다(비동기 틈 없음).
  beforeSpawn?: () => void | Promise<void>;
  admitSync?: () => void;
  onInterruptedOutput?: (output: { stdout: string; stderr: string; jsonLines: unknown[]; truncated: boolean }) => void;
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  signal?: AbortSignal;
  environment?: NodeJS.ProcessEnv;
  onSpawn?: (process: SpawnedProcess) => void;
  maxOutputBytes?: number;
  // 최종 결과 줄(isFinalResult 가 true 인 JSON 줄)을 받은 뒤 이 시간 안에 프로세스가 끝나지 않으면 SIGTERM 하고
  // 이미 받은 결과를 유효 처리한다(2026-09-03: StructuredOutput 뒤 13분 유휴 hang 실측).
  finalResultTimeoutMs?: number;
  isFinalResult?: (value: unknown) => boolean;
  // stream-json 줄이 파싱되는 즉시 도착 시각과 함께 알린다(도구 실행 시간 측정, adapters/toolTime.ts). ring buffer 와 무관.
  onJSONLine?: (value: unknown, at: number) => void;
}

export interface SpawnedProcess {
  pid: number;
  pgid: number;
  executable: string;
  commandLine: string;
  startedAt: string;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  jsonLines: unknown[];
  // 최종 결과 수신 뒤 유휴 타임아웃으로 종료시킨 실행 — exitCode 는 0 으로 정규화된다.
  terminatedAfterResult?: boolean;
}

export interface CommandRunner {
  run(spec: CommandSpec): Promise<CommandResult>;
}

export interface SessionTurn {
  // Stable engine identity; management topics may share the same repository directory.
  topicId?: string;
  // 엔진이 이 턴에 명시한 역할·작업(엔진 개편 E2a). 어댑터는 job 과 턴 형태로 역할 정책(adapters/turnPolicy.ts)을 계산해 자기 CLI 인자로 변환한다.
  // implementation·protocolOnly 는 job 에서 유도한 값이 함께 실린다(래퍼가 읽는다). job 이 없으면 어댑터가 공급자·플래그로 유도한다(호환 경계).
  job?: TurnJob;
  // 코드 리뷰 원장 ID(E3-4c) — 실행기가 경로(TurnRoute.reviewLedger)에서 옮겨 싣는다. 예산 래퍼(BudgetController)가 리뷰 좌석의 읽기·최종 판정 호출을
  // 호출마다 새 ID 대신 이 ID 로 예약하고, 원장의 첫 spawn 뒤에는 spawn 전 실패에도 예약을 되돌리지 않는다. 어댑터는 읽지 않는다.
  reviewLedger?: string;
  // 메모리 본문 1회 주입(E3-4c host-review 39d21df9 F004) — 실행기가 "프로토콜 턴이 만들어 메모리 본문을 아직 받지 않은 세션"의 일반 resume 턴에만 싣는다.
  // 어댑터는 이 resume 에 새 세션처럼 본문을 싣고(매니페스트는 중복하지 않는다) 프로토콜 턴이면 무시한다. 없으면 종전(생성 턴에만 본문, resume 은
  // 매니페스트) — 모든 resume 재주입은 하지 않는다(2026-08-30 턴당 ~20K자 중복 과금 실측).
  memoryBodies?: boolean;
  // Host-managed product evidence disables direct web reads; Figma implementation access is a separate opt-in.
  evidenceManaged?: boolean;
  // Host opt-in only for implementation with registered Figma links; never planning or protocol turns.
  figmaReadEnabled?: boolean;
  figmaFileKeys?: readonly string[];
  // Native tool transcript, captured by the host, never supplied by the model final answer.
  onFigmaRequest?: (request: import("./evidence/readLifecycle.js").EvidenceReadRequest) => void;
  onFigmaResult?: (observation: import("./evidence/readLifecycle.js").EvidenceReadObservation) => void;
  sessionId: string;
  prompt: string;
  // 엔진이 과제 프롬프트를 확정한 타임라인 순번. 래퍼의 비동기 대기 중 들어온 입력까지 반영했다고 기록하지 않는다.
  // 본문의 개별 조각이 전부 전달되었다는 뜻은 아니다.
  inputSequence?: number;
  // prompt 가 sessionId 세션이 이미 받은 내용 위의 변경분일 때만 둔다 — 과제를 다른 세션(교체·새 세션)에 전달하는 쪽은 prompt 대신 이
  // 전체 문맥 판을 쓴다. 변경분은 계산한 세션에서만 유효하다(host-review a7a9ce86 F-001).
  freshSessionPrompt?: string;
  cwd: string;
  signal?: AbortSignal;
  // spawn 직전 실행 허용 검사(CommandSpec.beforeSpawn/admitSync 로 그대로 전달). 어댑터의 내부 재시도·슬롯 대기·세션 폴백도 매번 부른다.
  beforeSpawn?: () => void | Promise<void>;
  admitSync?: () => void;
  implementation?: boolean;
  // Host-only authority for a registered, completed-topic engine follow-up.
  engineDefectFix?: boolean;
  // 프로토콜 확인 전용 턴. 저장소를 읽거나 명령을 실행할 필요가 없는데 도구를 열어 두면 에이전트가
  // 스스로 파일 해시를 계산하는 등 탐색을 시작해 출력 토큰만 쓴다(2026-08-29 ACK 턴 실측: output 19,975).
  protocolOnly?: boolean;
  // plan 권한 모드로 돌릴지. 쓰기 차단은 이미 두 층이 독립으로 담당한다 — --tools에서 Edit/Write를 빼고,
  // sandbox가 계획 턴에 denyWrite:[workspace]로 Edit·Write·Bash 세 경로를 모두 막는다. 그래서 plan 모드는
  // 세 번째 중복 방벽이고, 얹히는 "탐색 후 승인 요청" 지침은 비대화형(-p) 개정 턴의 계약과 어긋난다.
  // 진짜 계획을 세우는 두 턴에만 켠다: 최초 계획, 그리고 감사 findings가 0으로 수렴한 개정.
  planMode?: boolean;
  settings?: AgentExecutionSettings;
  // 경로 프로필의 공급자 옵션(엔진 개편 E2c, shared/roles.ts PROVIDER_OPTION_SCHEMAS) — 경로 판정이 이 공급자의 스펙으로 검증한 값. 어댑터 입구
  // (resolveSupportedTurn)가 다시 읽어 변환한다.
  providerOptions?: Readonly<Record<string, unknown>>;
  onProcessSpawn?: (process: SpawnedProcess) => void;
  consumer?: string;
  // Provider spawn mode is per execution, including a fresh create inside an outer recovery/resume call.
  onExecutionEnvironment?: (record: import("../shared/sessionSettings.js").SessionEnvironment, mode?: "create" | "resume") => void;
  // 턴이 쓴 토큰·시간을 알린다(codex `turn.completed` / claude `result` 이벤트에서 읽음). 기록 전용 —
  // 관찰자가 던져도 턴 결과는 유지된다(adapters/usage.ts notifyUsage).
  onUsage?: (usage: TurnUsage) => void;
  // Strict external review accounting: keep dispatched executions unfinished until verified final usage is reconciled.
  requiresFinalUsage?: boolean;
  onBudgetExecution?: (id: string) => void;
  onInterruptedOutput?: CommandSpec["onInterruptedOutput"];
  // 모든 값이 기본 미설정인 실행별 관찰 한도. 한도는 중단이 아닌 경고에만 쓴다.
  limits?: ExecutionLimits;
  // Host-owned remaining allowance for this invocation (minimum of execution and account totals).
  // Providers may compact earlier to fit it; this neither replaces nor increases ledger limits.
  executionBudget?: Readonly<import("../shared/budgets.js").BudgetVector>;
  // 세션 id 가 만들어진 즉시(프로세스 실행 전) 알린다 — 턴이 429·stop 으로 끊겨도 resume 할 수 있게 저장하기 위함(2026-09-03 실측).
  // allocated is a new ID reserved before spawn; confirmed identifies the current spawned execution.
  onSessionCreated?: (sessionId: string, phase?: "allocated" | "confirmed") => void;
  // 결과 봉투 수신(cd2876b7 F008) — 운영 사슬 가장 안쪽 래퍼(guardRunnerControl)가 안쪽 봉투를 받은 직후, 자기 검사·바깥 후처리보다 먼저 한 번 알린다.
  // 돌려주는 값은 엔진이 수신 슬롯에 실제로 잡았는가(captured)다. 던지지 않는다 — 알림이 정상 봉투를 실패로 바꾸지 않는다.
  onEnvelopeReceived?: (received: { sessionId: string; envelope: TurnEnvelope }) => boolean;
  // 공급자가 보고한 원시 사용량 객체(E2e-2, Codex turn.completed.usage) — 기록 전용, 합산·보정하지 않는다.
  onProviderUsage?: (usage: Record<string, unknown>) => void;
  // 이 턴에서 추가로 읽기를 허용할 경로(예: 주제 디렉터리의 plan.md). 이어지는 턴이 계획 본문을 다시 받지 않는 대신
  // 세션 기억이 압축됐을 때 에이전트가 원문을 직접 읽을 수 있게 한다(2026-09-08 Codex 제안 ⑥).
  readablePaths?: readonly string[];
  // 호스트 격리 입력(엔진 개편 E2e, turnPolicy.ts TurnPolicy.isolated) — 운영 도구가 입력 전체를 고정한 턴. 엔진은 쓰지 않는다.
  isolated?: boolean;
  // cwd 가 Git 체크아웃이 아닌 호스트 snapshot 이다(E2e.md 규칙 3) — 공급자 CLI 의 Git 저장소 요구를 끈다. 엔진은 쓰지 않는다.
  snapshotWorkspace?: boolean;
  // 호스트가 소유한 공급자 세션 홈(E2e-1 host-review F001) — 격리 턴에서만 쓴다. 없으면 어댑터가 데이터 폴더 아래 격리 홈을 만든다.
  sessionHome?: string;
  // 승인 경로만 쓰기(엔진 개편 E2e-3, turnPolicy.ts writeScopeProblem) — 쓰기 턴의 쓰기 범위를 작업 폴더 안의 이 절대 경로들로 좁힌다. 엔진은 쓰지 않는다.
  writablePaths?: readonly string[];
  // 계획 작성 턴의 계획 묶음 폴더(D4) — planner 는 이 폴더 안만 쓸 수 있다. 경로 검증과 공급자별 쓰기 권한 변환은 어댑터(turnPolicy)가 한다.
  planDirectory?: string;
}

// 소비처가 정한 결과 JSON Schema(엔진 개편 E2e) — 공급자 CLI 의 구조화 출력 제약으로 넘긴다. 의미 검증은 소비처가 한다.
export type OutputSchema = Readonly<Record<string, unknown>>;

// 한 CLI 턴의 사용량. inputTokens 는 캐시 읽기를 포함한 총 입력이고 cachedInputTokens 는 그중 캐시에서 읽은 양이다.
export interface TurnUsage {
  // 이 실행의 경로(엔진 개편 E2b) — 실제 공급자·참여자·프로필·선택 근거·job. 사용량 기록의 role 은 좌석 이름이다.
  route?: { provider: string; participant: string; profileId: string | null; basis: unknown; job: TurnJob };
  lastRequestInputTokens?: number;
  peakRequestInputTokens?: number;
  autoCompactWindowTokens?: number;
  imageBytes?: number;
  // 한 CLI 프로세스를 식별한다. 기존 TurnUsage 소비처는 아래 숫자 필드만 사용해도 된다.
  executionId?: string;
  phase?: string;
  resumed?: boolean;
  inputBytes?: number;
  recordKind?: "progress" | "final";
  completeness?: "complete" | "partial";
  source?: "cli-stream" | "codex-home";
  // 이 턴을 돌린 모델(속도·비용 비교 때 모델 변경과 다른 변경을 분리하기 위해 기록, 2026-09-08).
  model?: string;
  effort?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
  // 모델(API) 응답 시간 — claude result 의 duration_api_ms. codex 는 이 값을 주지 않는다.
  apiDurationMs?: number;
  // 도구 실행 창의 합과 호출 수(adapters/toolTime.ts). durationMs − toolDurationMs ≈ 모델 응답 + CLI 오버헤드.
  toolDurationMs?: number;
  toolCalls?: number;
  costUSD?: number;
  modelTurns?: number;
  internalRequests?: number;
  // Codex CLI 최종값과 관리형 홈 원본을 합산하지 않고 나란히 보관한다.
  sourceUsage?: UsageSourceComparison & { turns?: Array<{
    executionId?: string; sessionId: string | null; round: number; sourceUsage: UsageSourceComparison;
  }> };
}

export interface UsageSourceComparison {
  cli?: Partial<TurnUsage>;
  claudeStream?: Partial<TurnUsage>;
  claudeSession?: Partial<TurnUsage>;
  codexHome?: Partial<TurnUsage>;
  status: "matched" | "mismatch" | "unavailable";
}

export interface ExecutionLimits {
  inputBytes?: number;
  durationMs?: number;
  internalRequests?: number;
  toolCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface CreatedSession {
  sessionId: string;
  result: AgentResult;
}

// 결과 봉투 턴의 새 세션(CR 흐름 단순화 D3, 계약 v3.7 (12)).
export interface CreatedEnvelopeSession {
  sessionId: string;
  envelope: TurnEnvelope;
}

export interface AgentAdapter {
  readonly role: ParticipantRole;
  createSession(turn: Omit<SessionTurn, "sessionId">): Promise<CreatedSession>;
  resumeTurn(turn: SessionTurn): Promise<AgentResult>;
  resumePlanRepair?(turn: SessionTurn): Promise<PlanRepair>;
  // 소비처 schema 의 결과(엔진 개편 E2e) — 마지막 구조화 응답을 JSON 객체로 돌려준다. 지원하지 않는 어댑터는 두지 않는다(호출 전 거부).
  createStructuredSession?(turn: Omit<SessionTurn, "sessionId">, schema: OutputSchema): Promise<{ sessionId: string; value: Record<string, unknown> }>;
  resumeStructuredTurn?(turn: SessionTurn, schema: OutputSchema): Promise<Record<string, unknown>>;
  // 결과 봉투 턴(계약 v3.7 (12)) — 봉투 여부는 부른 메서드가 정하고 역할은 envelopeRole(turn.job) 이 정한다. 기존 createSession·resumeTurn 은 그대로다.
  // 운영 사슬의 래퍼는 이 두 메서드를 늘 정의하고 다음 층의 같은 메서드로 넘긴다(nextEnvelopeMethod).
  createEnvelopeSession?(turn: Omit<SessionTurn, "sessionId">): Promise<CreatedEnvelopeSession>;
  resumeEnvelopeTurn?(turn: SessionTurn): Promise<TurnEnvelope>;
  // 호스트 소유 세션 홈의 native 세션 기록 확인(E2e-2) — 읽기만 한다. 공급자 프로세스를 띄우지 않고 홈에 쓰지 않는다.
  inspectSession?(sessionHome: string, cwd: string, sessionId: string): Promise<{ exists: boolean; reason: string }>;
  // 자동 복구용 부재 확인: 전 범위를 확인해 없을 때만 true, 존재하면 false. 조회 실패·불완전 탐색은 throw한다.
  // 지원하지 않는 제공자는 생략한다. 연결 검증(validateExistingSession)의 false로 대체하면 안 된다.
  isSessionMissing?(sessionId: string): Promise<boolean>;
  validateExistingSession(sessionId: string): Promise<boolean>;
}

type EnvelopeMethod = "createEnvelopeSession" | "resumeEnvelopeTurn";
// 래퍼가 봉투 턴을 넘길 다음 층의 메서드 — 없으면 명시 오류로 멈춘다. createSession·resumeTurn 으로 돌아가거나 층을 건너뛰지 않는다(계약 v3.7 (12)).
// 래퍼는 예산 예약·입력 변환 같은 자기 동작 전에 이 함수로 다음 층을 확인한다.
export function nextEnvelopeMethod<M extends EnvelopeMethod>(adapter: AgentAdapter, method: M): NonNullable<AgentAdapter[M]> {
  const next = adapter[method];
  if (!next) throw new Error(`${adapter.role} 어댑터 사슬의 다음 층에 ${method} 가 없어 결과 봉투 턴을 열지 않습니다.`);
  return next.bind(adapter) as NonNullable<AgentAdapter[M]>;
}

export interface StoredArtifact {
  kind: string;
  revision: number;
  scopeGeneration: number;
  sha256: string;
  path: string;
  createdAt: string;
}

export interface ActionRecord {
  id: string;
  topicId: string;
  kind: string;
  status: "running" | "succeeded" | "failed" | "cancelled";
  createdAt: string;
  finishedAt: string | null;
  error: string | null;
  pid: number | null;
  pgid: number | null;
  processCommand: string | null;
  processExecutable: string | null;
  processStartedAt: string | null;
}

// 사용 한도(429) 자동 재시도의 지속 상태(topics.auto_retry_json). 시각은 epoch ms.
export interface AutoRetryState {
  attempts: number;
  lastFiredAt: number | null;
  scheduledAt: number | null;
  cancelled: boolean;
}

export interface InternalTopicFlags {
  fixPassUsed: boolean;
  secondFixPassUsed: boolean;
  closeoutRevisionUsed: boolean;
  resumeState: WorkflowState | null;
  implementationSessionId: string | null;
  implementationBaseOID: string | null;
  // 구현 세션에 마지막으로 전달한 타임라인 sequence. 이어지는 턴은 이 뒤의 이벤트만 싣는다(null = 전부).
  implementationPromptSequence: number | null;
  reviewedHead: string | null;
  reviewedDiffSHA256: string | null;
  reviewedTreeOID: string | null;
  committedOID: string | null;
  pushedOID: string | null;
  orphanCommitOID: string | null;
}
