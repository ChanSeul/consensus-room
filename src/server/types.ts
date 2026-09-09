import type {
  AgentExecutionSettings,
  AgentResult,
  AgentRole,
  MemoryUpdate,
  WorkflowState,
} from "../shared/contracts.js";

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
  sessionId: string;
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
  implementation?: boolean;
  // 프로토콜 확인 전용 턴. 저장소를 읽거나 명령을 실행할 필요가 없는데 도구를 열어 두면 에이전트가
  // 스스로 파일 해시를 계산하는 등 탐색을 시작해 출력 토큰만 쓴다(2026-08-29 ACK 턴 실측: output 19,975).
  protocolOnly?: boolean;
  // plan 권한 모드로 돌릴지. 쓰기 차단은 이미 두 층이 독립으로 담당한다 — --tools에서 Edit/Write를 빼고,
  // sandbox가 계획 턴에 denyWrite:[workspace]로 Edit·Write·Bash 세 경로를 모두 막는다. 그래서 plan 모드는
  // 세 번째 중복 방벽이고, 얹히는 "탐색 후 승인 요청" 지침은 비대화형(-p) 개정 턴의 계약과 어긋난다.
  // 진짜 계획을 세우는 두 턴에만 켠다: 최초 계획, 그리고 감사 findings가 0으로 수렴한 개정.
  planMode?: boolean;
  settings?: AgentExecutionSettings;
  onProcessSpawn?: (process: SpawnedProcess) => void;
  // 턴이 쓴 토큰·시간을 알린다(codex `turn.completed` / claude `result` 이벤트에서 읽음). 기록 전용 —
  // 관찰자가 던져도 턴 결과는 유지된다(adapters/usage.ts notifyUsage).
  onUsage?: (usage: TurnUsage) => void;
  // 세션 id 가 만들어진 즉시(프로세스 실행 전) 알린다 — 턴이 429·stop 으로 끊겨도 resume 할 수 있게 저장하기 위함(2026-09-03 실측).
  onSessionCreated?: (sessionId: string) => void;
  // 이 턴에서 추가로 읽기를 허용할 경로(예: 주제 디렉터리의 plan.md). 이어지는 턴이 계획 본문을 다시 받지 않는 대신
  // 세션 기억이 압축됐을 때 에이전트가 원문을 직접 읽을 수 있게 한다(2026-09-08 Codex 제안 ⑥).
  readablePaths?: readonly string[];
}

// 한 CLI 턴의 사용량. inputTokens 는 캐시 읽기를 포함한 총 입력이고 cachedInputTokens 는 그중 캐시에서 읽은 양이다.
export interface TurnUsage {
  // 이 턴을 돌린 모델(속도·비용 비교 때 모델 변경과 다른 변경을 분리하기 위해 기록, 2026-09-08).
  model?: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  durationMs: number;
  // 모델(API) 응답 시간 — claude result 의 duration_api_ms. codex 는 이 값을 주지 않는다.
  apiDurationMs?: number;
  // 도구 실행 창의 합과 호출 수(adapters/toolTime.ts). durationMs − toolDurationMs ≈ 모델 응답 + CLI 오버헤드.
  toolDurationMs?: number;
  toolCalls?: number;
  costUSD?: number;
  modelTurns?: number;
}

export interface CreatedSession {
  sessionId: string;
  result: AgentResult;
}

export interface AgentAdapter {
  readonly role: ParticipantRole;
  createSession(turn: Omit<SessionTurn, "sessionId">): Promise<CreatedSession>;
  resumeTurn(turn: SessionTurn): Promise<AgentResult>;
  validateExistingSession(sessionId: string): Promise<boolean>;
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
