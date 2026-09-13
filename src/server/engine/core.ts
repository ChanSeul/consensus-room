// WorkflowEngine 분해(2026-08-31): 상태 전환·세션·산출물·메모리·전달이 한 클래스(1,504줄)에 있어
// 순서 결함이 반복된다는 Codex 진단에 따른 분리. EngineCore는 공유 상태와 횡단 프리미티브만 갖는다 —
// 흐름(계획 수렴·구현 전달)은 PlanningPipeline·DeliveryPipeline이, 공개 API는 WorkflowEngine 파사드가 갖는다.
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import {
  AgentResultSchema,
  DeferredFindingsSchema,
  type DeferredFinding,
  type Finding,
  type AgentExecutionSettings,
  type AgentResult,
  type Participant,
  type TimelineEvent,
  type Topic,
  type WorkflowState,
  type MemoryUpdate,
} from "../../shared/contracts.js";
import { appliedExecutionSettings } from "../../shared/execution.js";
import {
  applyPlanEdits,
  assertFixDispositionAllowed,
  assertPlanContract,
  assertTransition,
  normalizePlan,
  redactSecrets,
} from "../../shared/workflow.js";
import { buildContractCorrectionPrompt } from "../../shared/prompts.js";
import { redactAgentResult, redactRecord } from "../security.js";
import type { AgentAdapter, AppliedMemoryChange, ParticipantRole, TurnUsage } from "../types.js";
import { exceededLimits } from "../adapters/executionMetrics.js";
import type { WorkflowDependencies } from "../workflow.js";

// 결과 JSON 의 표기만 틀린 위반(스키마·kind). 재제출에 판단이 필요 없어 교정 턴의 추론 강도를 low 로 내린다
// (2026-09-07 Codex 자기 최적화 제안 ③). 쟁점 누락·처분 규칙 위반은 판단이 섞이므로 여기 속하지 않는다.
export class FormatViolation extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FormatViolation";
  }
}

export class HandledWorkflowInterruption extends Error {
  constructor() {
    super("새 메시지를 반영하기 위해 현재 단계를 멈췄습니다.");
    this.name = "HandledWorkflowInterruption";
  }
}

export function conflict(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 409 });
}

// 실패 진단이 프롬프트 크기만큼 원장에 들어가는 것을 막는다(감사 최적화 지적: 4~16KB 상한).
function boundedError(message: string): string {
  return message.length <= 16_000 ? message : `${message.slice(0, 16_000)}\n[이하 생략]`;
}

const DEFERRED_SOURCE_LABEL: Record<DeferredFinding["source"], string> = {
  closeout: "종결 확인", "final-review": "최종 리뷰", implementation: "구현 to-do", fix: "수정 to-do",
};

export class EngineCore {
  readonly active = new Map<string, {
    actionId: string;
    controller: AbortController;
    completion: Promise<void>;
  }>();
  readonly deliveryActive = new Set<string>();
  readonly scopeChangeActive = new Set<string>();
  readonly turnInputSequence = new Map<string, number>();
  shuttingDown = false;
  // 주제가 FAILED 로 떨어진 직후(원장 마감 뒤) 알린다 — 사용 한도 자동 재시도 예약(engine/usageLimitRetry.ts).
  failureObserver?: (topicId: string, message: string) => void;
  // 새 action 이 시작될 때 알린다 — 그 주제의 예약된 자동 재시도를 취소한다.
  actionObserver?: (topicId: string) => void;
  private readonly warnedLimits = new Map<string, Set<string>>();

  constructor(readonly dependencies: WorkflowDependencies) {}

  // 서버 종료: 새 실행을 막고, 실행 중인 action 을 전부 중단(프로세스 그룹 SIGTERM→SIGKILL 은 runner 몫)한 뒤
  // 각 action 의 원장 마감(cancelled + 주제 FAILED/resume_state)이 끝나기를 기다린다. 그래서 재시작 뒤 startup
  // 회수가 할 일이 없고 retry 가 같은 세션을 resume 한다(2026-09-07 Codex 제안 ②: 종료가 DB 만 닫아 에이전트가 고아가 됨).
  async shutdown(timeoutMs = 15_000): Promise<number> {
    this.shuttingDown = true;
    const pending = [...this.active.values()];
    for (const action of pending) action.controller.abort(new Error("서버 종료로 실행을 중단했습니다."));
    await Promise.race([
      Promise.all(pending.map((action) => action.completion)),
      new Promise<void>((resolve) => setTimeout(resolve, timeoutMs).unref()),
    ]);
    return pending.length;
  }

  // 종료 중에는 상태를 바꾸는 진입점(retry 의 resetToDraft·transition 포함)이 원장을 건드리기 전에 거부해야 한다.
  assertNotShuttingDown(): void {
    if (this.shuttingDown) throw new Error("서버가 종료 중입니다. 재시작 뒤 다시 요청하세요.");
  }

  startAction(topicId: string, kind: string, work: (signal: AbortSignal) => Promise<void>, requestedActionId?: string): string {
    this.assertNotShuttingDown();
    this.assertNoActiveWork(topicId);
    const actionId = requestedActionId ?? randomUUID();
    if (this.dependencies.database.getAction(actionId)) throw conflict("같은 Idempotency-Key로 이미 요청한 action입니다.");
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const scopeGeneration = this.dependencies.database.getTopic(topicId).scopeGeneration;
    this.dependencies.database.startAction({
      id: actionId, topicId, kind, status: "running", createdAt: new Date().toISOString(),
      finishedAt: null, error: null, pid: null, pgid: null,
      processExecutable: null, processCommand: null,
      processStartedAt: null,
    });
    this.active.set(topicId, { actionId, controller, completion });
    this.actionObserver?.(topicId);
    void work(controller.signal).then(() => {
      if (!this.isCurrentAction(topicId, actionId, scopeGeneration)) return;
      this.dependencies.database.finishAction(actionId, "succeeded");
    }).catch((error: unknown) => {
      const cancelled = controller.signal.aborted;
      const message = redactSecrets(error instanceof Error ? error.message : String(error));
      if (error instanceof HandledWorkflowInterruption) {
        this.dependencies.database.finishAction(actionId, "succeeded");
        return;
      }
      if (!this.isCurrentAction(topicId, actionId, scopeGeneration)) {
        this.dependencies.database.finishAction(actionId, cancelled ? "cancelled" : "failed", message);
        return;
      }
      const failure = this.dependencies.database.finishActionAndFailTopic({
        actionId,
        topicId,
        actionStatus: cancelled ? "cancelled" : "failed",
        error: message,
        expectedScopeGeneration: scopeGeneration,
      });
      this.event(topicId, "system", "system", cancelled
        ? "실행을 중단했습니다."
        : failure.topicFailed
          ? `실행에 실패했습니다: ${message}`
          : `실행 요청을 처리하지 못했습니다: ${message} 주제 상태는 그대로 유지했습니다.`);
      if (!cancelled && failure.topicFailed) this.failureObserver?.(topicId, message);
    }).finally(() => {
      if (this.active.get(topicId)?.actionId === actionId) this.active.delete(topicId);
      resolveCompletion();
    });
    return actionId;
  }

  assertNoActiveWork(topicId: string): void {
    if (this.active.has(topicId) || this.dependencies.database.runningAction(topicId) ||
        this.deliveryActive.has(topicId) || this.scopeChangeActive.has(topicId)) {
      throw new Error("이 주제에서 이미 실행 중인 작업이 있습니다.");
    }
  }

  // freshSession: 합의 이력을 물려받지 않는 일회용 세션에서 실행한다. 프롬프트가 판단에 필요한 것을
  // 전부 담고 있는 단계에만 쓴다(계획 전문·감사·타임라인·계약). 이력을 이어받으면 이미 폐기된 이전
  // 개정본까지 매 턴 재전송된다 — 2026-08-31 실측: 개정 11 시점에 턴당 재전송 834,290토큰, 그중
  // StructuredOutput(과거 개정 계획 전문 누적) 695KB. 개정 턴이 15분→45분으로 늘고 429를 두 번 맞았다.
  // 만들어진 세션 ID는 participant에 저장하지 않는다 — 저장하면 다음 단계가 이 세션을 이어받는다.
  async turn(
    role: ParticipantRole,
    topic: Topic,
    prompt: string,
    signal: AbortSignal,
    implementation: boolean,
    options: {
      freshSession?: boolean;
      planMode?: boolean;
      check?: (result: AgentResult) => void;
      // 코드 리뷰처럼 계획 participant와 수명이 다른 세션의 저장 책임은 호출자가 갖는다.
      session?: { id: string | null; persist: (sessionId: string) => void };
      // 이 턴에 추가로 읽기를 허용할 경로(주제 plan.md 등).
      readablePaths?: readonly string[];
    } = {},
  ): Promise<AgentResult> {
    const { freshSession = false, planMode = false, check } = options;
    const startedAfter = this.latestSequence(topic.id);
    this.turnInputSequence.set(topic.id, startedAfter);
    const participant = this.participant(topic, role);
    const resumeSessionId = options.session ? options.session.id : participant.sessionId;
    const adapter = this.adapter(role);
    let result: AgentResult;
    let sessionId: string;
    if (freshSession || !resumeSessionId || resumeSessionId.startsWith("pending:")) {
      const created = await adapter.createSession({
        prompt, cwd: topic.worktreePath, signal, implementation, planMode,
        settings: this.executionSettings(topic.id, role, implementation),
        onProcessSpawn: this.processObserver(topic.id),
        onUsage: this.usageObserver(topic.id, role, "턴"),
        readablePaths: options.readablePaths,
      });
      this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
      if (options.session) {
        // 결과 교정·새 입력 처리 전에 저장해야 재시도가 같은 세션을 이어 쓸 수 있다.
        options.session.persist(created.sessionId);
      } else if (!freshSession) {
        if (this.dependencies.database.participantSessionInUse(topic.id, role, created.sessionId)) {
          throw new Error("새 에이전트 세션이 다른 주제 세션과 충돌했습니다.");
        }
        this.dependencies.database.upsertParticipant(topic.id, {
          ...participant, sessionId: created.sessionId, acknowledgedPlanSHA256: null,
        });
      }
      result = created.result;
      sessionId = created.sessionId;
    } else {
      result = await adapter.resumeTurn({
        sessionId: resumeSessionId, prompt, cwd: topic.worktreePath, signal, implementation, planMode,
        settings: this.executionSettings(topic.id, role, implementation),
        onProcessSpawn: this.processObserver(topic.id),
        onUsage: this.usageObserver(topic.id, role, "턴"),
        readablePaths: options.readablePaths,
      });
      sessionId = resumeSessionId;
    }
    this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    if (await this.interruptPreservingResult(topic, role, result, startedAfter, signal)) throw new HandledWorkflowInterruption();
    return this.enforceResultContract(role, topic, result, sessionId, {
      signal, implementation, planMode, startedAfter, check, readablePaths: options.readablePaths,
    });
  }

  // 기계 계약 위반은 작업 실패가 아니라 표기 실패다. 턴을 버리면 그때까지의 작업 비용 전체가 소각되므로
  // (2026-09-01 S1.1: RESOLVED_BY_FIX 금지 하나로 1시간 구현 턴 폐기), 같은 세션에 거부 사유를 돌려주고
  // 한 번만 재제출받는다. 두 번째 위반은 그대로 던져 FAILED 경로로 보낸다 — 무한 교정은 다른 종류의 소각이다.
  async enforceResultContract(
    role: ParticipantRole,
    topic: Topic,
    raw: AgentResult,
    sessionId: string,
    context: {
      signal: AbortSignal;
      implementation: boolean;
      planMode: boolean;
      startedAfter: number;
      check?: (result: AgentResult) => void;
      // 본 턴과 같은 읽기 허용(계획 정본 등) — 교정 턴에서만 권한이 빠지면 "필요하면 읽으라" 고 안내한 파일을 못 읽는다(Codex 후속 지적 7).
      readablePaths?: readonly string[];
    },
  ): Promise<AgentResult> {
    let violation: string;
    let formatOnly = false;
    try {
      const parsed = redactAgentResult(AgentResultSchema.parse(raw));
      context.check?.(parsed);
      return parsed;
    } catch (error) {
      if (error instanceof HandledWorkflowInterruption) throw error;
      formatOnly = error instanceof ZodError || error instanceof FormatViolation;
      violation = error instanceof Error ? error.message : String(error);
    }
    this.event(topic.id, "system", "system",
      `기계 계약 위반을 같은 세션에 돌려보내 1회 교정합니다${formatOnly ? "(표기 교정 — 추론 low)" : ""}: ${violation}`);
    const settings = this.executionSettings(topic.id, role, context.implementation);
    const corrected = await this.adapter(role).resumeTurn({
      sessionId, prompt: buildContractCorrectionPrompt(violation), cwd: topic.worktreePath,
      signal: context.signal, implementation: context.implementation, planMode: context.planMode,
      readablePaths: context.readablePaths,
      settings: formatOnly ? { ...settings, effort: "low" } : settings,
      onProcessSpawn: this.processObserver(topic.id),
      onUsage: this.usageObserver(topic.id, role, "계약 교정 재제출"),
    });
    this.assertCurrent(topic.id, context.signal, topic.scopeGeneration, this.dependencies.database.getTopic(topic.id).state);
    if (this.interruptForNewUserInput(topic, context.startedAfter)) throw new HandledWorkflowInterruption();
    const reparsed = redactAgentResult(AgentResultSchema.parse(corrected));
    context.check?.(reparsed);
    return reparsed;
  }

  // 합의 세션과 무관한 일회용 세션에서 실행한다. 만들어진 세션 ID는 participant에 저장하지 않는다 —
  // 저장하면 다음 단계가 그 빈 세션을 이어받아 합의 대화를 잃는다.
  async isolatedTurn(
    role: ParticipantRole,
    topic: Topic,
    prompt: string,
    signal: AbortSignal,
  ): Promise<AgentResult> {
    const startedAfter = this.latestSequence(topic.id);
    this.turnInputSequence.set(topic.id, startedAfter);
    const created = await this.adapter(role).createSession({
      prompt, cwd: topic.worktreePath, signal, implementation: false, protocolOnly: true,
      // 모델은 주제 설정을 따르되 추론 강도는 low로 내린다. 프로토콜 확인에 xhigh/max 추론은
      // thinking 토큰 낭비다(2026-08-29 ACK 실측: output 19,975 중 상당분이 탐색·추론).
      settings: { ...this.executionSettings(topic.id, role), effort: "low" },
      onProcessSpawn: this.processObserver(topic.id),
      onUsage: this.usageObserver(topic.id, role, "프로토콜 확인"),
    });
    this.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    if (this.interruptForNewUserInput(topic, startedAfter)) throw new HandledWorkflowInterruption();
    return redactAgentResult(AgentResultSchema.parse(created.result));
  }

  // implementation=true인 턴은 구현 전용 모델(있으면)을 쓴다 — adversarial 계획 왕복은 fable,
  // 구현은 opus라는 사용자 관행의 실행 지점(2026-08-31). 반환값에서 implementation 필드는 벗긴다.
  executionSettings(topicId: string, role: ParticipantRole, implementation = false): AgentExecutionSettings {
    return appliedExecutionSettings(this.dependencies.database.getTopic(topicId).agentSettings[role], implementation);
  }

  adapter(role: ParticipantRole): AgentAdapter {
    return role === "claude" ? this.dependencies.claude : this.dependencies.codex;
  }

  participant(topic: Topic, role: ParticipantRole): Participant {
    const participant = topic.participants.find((item) => item.role === role);
    if (!participant) throw new Error(`${role} 세션을 먼저 연결하세요.`);
    return participant;
  }

  requireParticipants(topic: Topic): void {
    this.participant(topic, "claude");
    this.participant(topic, "codex");
  }

  requireState(topicId: string, expected: WorkflowState): Topic {
    const topic = this.dependencies.database.getTopic(topicId);
    if (topic.state !== expected) throw new Error(`현재 상태는 ${topic.state}이며 ${expected} 단계가 아닙니다.`);
    return topic;
  }

  transition(topicId: string, to: WorkflowState, message: string): Topic {
    const topic = this.dependencies.database.getTopic(topicId);
    assertTransition(topic.state, to);
    const updated = this.dependencies.database.updateTopic(topicId, {
      state: to, lastError: null, resumeState: null,
    });
    this.event(topicId, "system", "system", message, { from: topic.state, to });
    return updated;
  }

  interrupt(
    topicId: string,
    state: "BLOCKED_ON_EVIDENCE" | "USER_DECISION_REQUIRED",
    message: string,
    resumeState: WorkflowState,
    payload: Record<string, unknown> = {},
  ): void {
    const topic = this.dependencies.database.getTopic(topicId);
    assertTransition(topic.state, state);
    this.dependencies.database.updateTopic(topicId, { state, resumeState, lastError: boundedError(redactSecrets(message)) });
    this.event(topicId, "system", "system", message, { resumeState, ...payload });
  }

  resetToDraft(topic: Topic, message: string): void {
    this.dependencies.database.updateTopic(topic.id, {
      state: "DRAFT", planRevision: 0, planEpoch: topic.planEpoch + 1,
      planSHA256: null, approvedPlanSHA256: null, lastError: null,
      fixPassUsed: false, closeoutRevisionUsed: false, resumeState: null,
    });
    this.dependencies.database.clearAcknowledgements(topic.id);
    this.event(topic.id, "system", "system", message, { scopeGeneration: topic.scopeGeneration });
  }

  async stopIfRunning(topicId: string): Promise<void> {
    const running = this.active.get(topicId);
    if (!running) return;
    running.controller.abort(new Error("범위가 변경되어 기존 실행을 중단했습니다."));
    // The DB row must remain running until the process group has really exited.
    // Otherwise a server crash in the SIGTERM→SIGKILL window cannot recover it.
    await running.completion;
  }

  assertCurrent(topicId: string, signal: AbortSignal, scopeGeneration: number, expectedState: WorkflowState): void {
    if (signal.aborted) throw signal.reason ?? new Error("실행이 취소되었습니다.");
    const active = this.active.get(topicId);
    const topic = this.dependencies.database.getTopic(topicId);
    if (!active || active.controller.signal !== signal || topic.scopeGeneration !== scopeGeneration || topic.state !== expectedState) {
      throw new Error("이전 실행의 늦은 응답을 버렸습니다.");
    }
  }

  isCurrentAction(topicId: string, actionId: string, scopeGeneration: number): boolean {
    return this.active.get(topicId)?.actionId === actionId &&
      this.dependencies.database.getTopic(topicId).scopeGeneration === scopeGeneration;
  }

  processObserver(topicId: string) {
    return (process: {
      pid: number;
      pgid: number;
      executable: string;
      commandLine: string;
      startedAt: string;
    }) => {
      const action = this.active.get(topicId);
      if (!action) throw new Error("CLI가 시작됐지만 연결할 action이 없습니다.");
      this.dependencies.database.recordActionProcess(action.actionId, process);
    };
  }

  // 턴이 쓴 토큰·시간을 타임라인에 남긴다(2026-09-07 Codex 자기 최적화 제안 ④). 이벤트의 state 열이 단계를
  // 가리키므로 단계별 집계는 SQL 로 한다. payload.usage 가 있는 이벤트는 getPromptTimeline 이 걸러 프롬프트에
  // 들어가지 않는다 — 사용량 줄이 에이전트에게 되돌아가면 그 자체가 새 입력 비용이다.
  usageObserver(topicId: string, role: ParticipantRole, phase: "턴" | "계약 교정 재제출" | "프로토콜 확인") {
    const generation = this.dependencies.database.getTopic(topicId).scopeGeneration;
    const fallbackExecutionId = randomUUID();
    return (observation: TurnUsage) => {
      const usage = { ...observation, executionId: observation.executionId ?? fallbackExecutionId,
        recordKind: observation.recordKind ?? "final" as const, phase };
      const tokens = (count: number | undefined) => count === undefined ? "관측 안 됨" : count.toLocaleString("en-US");
      const seconds = (ms: number | undefined) => Math.round((ms ?? 0) / 1000);
      const cost = usage.costUSD === undefined ? "" : ` · $${usage.costUSD.toFixed(2)}`;
      // 총 시간은 CLI 실행 전체다. 도구 창(러너 측정)과 API 시간(claude CLI 측정)을 따로 적어야 모델 속도를 도구·빌드 시간과
      // 구분해 비교할 수 있다(2026-09-08 Codex 지적 — 이전의 '출력 tok/s' 비교는 총 시간 기준이라 도구 시간이 섞였다).
      const split = usage.toolDurationMs === undefined
        ? ""
        : ` · 도구 ${seconds(usage.toolDurationMs)}초(${usage.toolCalls ?? 0}회) · 모델+대기 ${seconds(Math.max(0, (usage.durationMs ?? 0) - usage.toolDurationMs))}초`;
      const api = usage.apiDurationMs === undefined ? "" : ` · API ${seconds(usage.apiDurationMs)}초`;
      const body = `${role} ${phase} 최종 사용량 — 입력 ${tokens(usage.inputTokens)}(캐시 ${tokens(usage.cachedInputTokens)}) · ` +
        `출력 ${tokens(usage.outputTokens)} 토큰 · ${seconds(usage.durationMs)}초${split}${api}${cost}${usage.model ? ` · 모델 ${usage.model}` : ""}${usage.completeness === "partial" ? " · 부분 관측" : ""}${usage.sourceUsage?.status === "mismatch" ? " · 원본 간 사용량 불일치" : ""}`;
      if (!this.dependencies.database.saveExecutionUsage(topicId, generation, role, phase, usage,
        usage.recordKind === "final" ? { body: redactSecrets(body), payload: redactRecord({ usage }) } : undefined)) return;
      // 이전 세대에서 늦게 종료된 관측은 보존하되 새 세대의 원장에 알리지 않는다.
      if (this.dependencies.database.getTopic(topicId).scopeGeneration !== generation) {
        this.warnedLimits.delete(usage.executionId);
        return;
      }
      const executionId = usage.executionId ?? `${topicId}:${role}:${phase}`;
      const warned = this.warnedLimits.get(executionId) ?? new Set<string>();
      this.warnedLimits.set(executionId, warned);
      for (const warning of exceededLimits(usage, this.dependencies.executionLimits ?? {})) {
        if (warned.has(warning.key)) continue;
        warned.add(warning.key);
        this.event(topicId, "system", "system", `${role} ${phase} 실행 한도 경고 — ${warning.key} ${warning.value} / ${warning.limit}${warning.timing === "completion" ? " (완료 시 평가)" : ""}`, {
          executionWarning: { executionId, ...warning },
        });
      }
      if (usage.recordKind === "final") this.warnedLimits.delete(executionId);
    };
  }

  // 이연 쟁점 기록(2026-09-07 Codex 피드백): 종결 확인·최종 리뷰가 "이번 범위 밖" 으로 처분한 새 쟁점을 산출물
  // `deferred-findings` 에 누적한다. 발견 시점이 아니라 **처분**(DEFERRED_OUT_OF_SCOPE·AGREED_NO_ACTION)이 기준이다 —
  // 늦게 발견했다는 이유로 범위 밖이라 적으면 해결 안 한 문제를 범위 밖으로 기록하게 된다.
  // 후속 목록의 출처 표시 — 사용자는 인도 전에 이 목록의 처분(후속 토픽·다음 계획·폐기)을 정한다.
  async recordDeferredFindings(
    topic: Topic, findings: readonly Finding[], source: DeferredFinding["source"], signal: AbortSignal,
  ): Promise<void> {
    if (findings.length === 0) return;
    const existing = await this.deferredFindingsOf(topic.id);
    const recordedAt = new Date().toISOString();
    const additions = findings
      .filter((finding) => !existing.some((item) => item.id === finding.id && item.source === source))
      .map((finding) => ({
        id: finding.id, title: finding.title, severity: finding.severity, rationale: finding.rationale,
        source, topicId: topic.id, recordedAt,
      }));
    if (additions.length === 0) return;
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    await this.writeArtifact(topic, "deferred-findings", revision,
      JSON.stringify({ findings: [...existing, ...additions] }, null, 2), signal);
    this.event(topic.id, "system", "system",
      `후속 목록에 기록(이번 범위 밖, ${DEFERRED_SOURCE_LABEL[source]}): ${additions.map((item) => `${item.id} ${item.title}`).join(", ")}`,
      { deferredFindingIDs: additions.map((item) => item.id) });
  }

  // 뒤 단계(리뷰·수정)가 to-do 를 다른 처분으로 닫으면 후속 목록에서 뺀다. 종결 확인·최종 리뷰 이연은 그대로 둔다
  // (그 출처의 항목은 계획 단계가 다시 판단한다).
  async pruneDeferredFindings(topic: Topic, resolvedIDs: readonly string[], signal: AbortSignal): Promise<void> {
    if (resolvedIDs.length === 0) return;
    const existing = await this.deferredFindingsOf(topic.id);
    const remaining = existing.filter((item) =>
      !(resolvedIDs.includes(item.id) && (item.source === "implementation" || item.source === "fix")));
    if (remaining.length === existing.length) return;
    const removed = existing.filter((item) => !remaining.includes(item));
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    await this.writeArtifact(topic, "deferred-findings", revision, JSON.stringify({ findings: remaining }, null, 2), signal);
    this.event(topic.id, "system", "system",
      `후속 목록에서 제외(뒤 단계에서 처분됨): ${removed.map((item) => `${item.id} ${item.title}`).join(", ")}`,
      { deferredFindingIDsRemoved: removed.map((item) => item.id) });
  }

  async deferredFindingsOf(topicId: string): Promise<DeferredFinding[]> {
    const raw = await this.dependencies.artifacts.readLatest(topicId, "deferred-findings");
    if (!raw) return [];
    const parsed = DeferredFindingsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.findings : [];
  }

  // 계획·감사 프롬프트에 실을 이연 목록: 이 토픽이 이연한 것(재시작 바퀴) + 선행 토픽(predecessorTopicId)이 이연한 것.
  async deferredFindingsFor(topicId: string): Promise<DeferredFinding[]> {
    const topic = this.dependencies.database.getTopic(topicId);
    const own = await this.deferredFindingsOf(topicId);
    const inherited = topic.predecessorTopicId
      ? await this.deferredFindingsOf(topic.predecessorTopicId).catch(() => [])
      : [];
    return [...inherited, ...own];
  }

  async writeArtifact(
    topic: Topic,
    kind: string,
    revision: number,
    content: string,
    signal: AbortSignal,
    accept?: () => boolean,
  ) {
    return this.dependencies.artifacts.write(topic.id, kind, revision, content, {
      scopeGeneration: topic.scopeGeneration,
      accept: () => {
        if (signal.aborted) return false;
        const active = this.active.get(topic.id);
        const current = this.dependencies.database.getTopic(topic.id);
        return active?.controller.signal === signal &&
          current.scopeGeneration === topic.scopeGeneration && current.state === topic.state && (accept?.() ?? true);
      },
    });
  }

  // pauseForResult가 멈출지 미리 판정한다 — 멈추는 응답은 계획이 없어도 정당하므로, 계획 검증을
  // 메모리 반영(saveAgentOutput)보다 앞으로 올릴 때 이 예측으로 가드한다(2026-08-31 Codex 지적:
  // 검증 전에 메모리를 바꿔, 계약 위반 응답이 FAILED가 되고도 공용 메모리를 1회 오염).
  resultRequestsPause(result: AgentResult): boolean {
    const decision = result.requestedUserDecision ??
      result.findings.find((finding) => finding.requiresUserDecision)?.rationale;
    if (decision) return true;
    return result.findings.some((finding) => finding.disposition === "EXTERNAL_EVIDENCE");
  }

  pauseForResult(
    topicId: string,
    result: AgentResult,
    resumeState: WorkflowState,
    fallbackMessage: string,
  ): boolean {
    const decision = result.requestedUserDecision ??
      result.findings.find((finding) => finding.requiresUserDecision)?.rationale;
    if (decision) {
      this.interrupt(topicId, "USER_DECISION_REQUIRED", decision || fallbackMessage, resumeState);
      return true;
    }
    const missingEvidence = result.findings.find((finding) => finding.disposition === "EXTERNAL_EVIDENCE");
    if (missingEvidence) {
      this.interrupt(topicId, "BLOCKED_ON_EVIDENCE", missingEvidence.rationale || fallbackMessage, resumeState);
      return true;
    }
    return false;
  }

  latestSequence(topicId: string): number {
    return this.dependencies.database.maxSequence(topicId);
  }

  // 턴 도중 도착한 사용자 입력 중 흐름을 멈춰야 하는 것 — 결정과 증거뿐이다. note 는 참고 메모라 멈추지 않고
  // 다음 턴의 타임라인으로 전달된다(2026-09-07 제안 ③: 메모 하나가 완료된 리뷰를 폐기하고 같은 단계를 재실행시켰다).
  newUserInputSince(topic: Topic, afterSequence: number): TimelineEvent | null {
    return this.dependencies.database.getTimeline(topic.id, afterSequence).find((event) =>
      event.actor === "user" && ["evidence", "decision"].includes(event.kind),
    ) ?? null;
  }

  // 저장 전 중단 지점 공용: 새 결정·증거가 있으면 이 턴의 결과를 산출물로 보존한 뒤 인터럽트하고 true 를 돌려준다.
  // 결과는 새 입력을 반영하지 못했으므로 흐름에 태우지 않지만 버리지도 않는다 — 다음 턴과 사람이 참고한다
  // (2026-09-07 Codex 제안 ③: 운영 기록 4건이 돌아온 결과를 통째로 잃었다. turn()·구현·수정 경로가 함께 쓴다).
  async interruptPreservingResult(
    topic: Topic, role: ParticipantRole, result: AgentResult, afterSequence: number, signal: AbortSignal,
  ): Promise<boolean> {
    if (!this.newUserInputSince(topic, afterSequence)) return false;
    await this.preserveInterruptedResult(topic, role, result, signal);
    this.interruptForNewUserInput(topic, afterSequence);
    return true;
  }

  private async preserveInterruptedResult(topic: Topic, role: ParticipantRole, result: AgentResult, signal: AbortSignal): Promise<void> {
    const parsed = AgentResultSchema.safeParse(result);
    const safe = parsed.success ? redactAgentResult(parsed.data) : result;
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    try {
      await this.writeArtifact(topic, `${role}-interrupted`, revision, JSON.stringify(safe, null, 2), signal);
      this.event(topic.id, "system", "system",
        `${role} 턴이 끝나기 전에 새 결정·증거가 도착해 이 결과는 반영하지 않습니다. 산출물 \`${role}-interrupted\`(#${revision}) 로 보존했습니다.`);
    } catch (error) {
      this.event(topic.id, "system", "system",
        `중단된 ${role} 턴 결과를 보존하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  interruptForNewUserInput(topic: Topic, afterSequence: number): boolean {
    const newUserInput = this.newUserInputSince(topic, afterSequence);
    if (!newUserInput) return false;
    this.interrupt(
      topic.id,
      "USER_DECISION_REQUIRED",
      "에이전트가 답하는 동안 새 메시지가 추가되었습니다. 같은 단계를 다시 실행해 새 내용을 반영하세요.",
      topic.state,
    );
    return true;
  }

  interruptForLatestTurnInput(topic: Topic): boolean {
    return this.interruptForNewUserInput(topic, this.turnInputSequence.get(topic.id) ?? this.latestSequence(topic.id));
  }

  async saveAgentOutput(
    topic: Topic,
    role: ParticipantRole,
    result: AgentResult,
    kind: string,
    signal: AbortSignal,
  ): Promise<void> {
    const safeResult = redactAgentResult(result);
    const requestedMemoryUpdates = safeResult.memoryUpdates ?? [];
    if (requestedMemoryUpdates.length > 0 && !this.dependencies.memory) {
      throw new Error("에이전트가 메모리 변경을 제안했지만 중앙 메모리 저장소가 연결되지 않았습니다.");
    }
    const revision = this.dependencies.database.timelineCount(topic.id) + 1;
    // 아티팩트 쓰기가 세대·취소 검증 경계다. 공용 메모리는 그 경계를 통과한 응답만 바꿀 수 있다 —
    // 순서가 반대면 범위 변경으로 버려진 응답이 메모리만 바꾸고 타임라인에는 남지 않는다(감사 ③ 재현).
    await this.writeArtifact(topic, kind, revision, JSON.stringify(safeResult, null, 2), signal);
    // 메모리 쓰기는 턴의 부산물이다. 실패해도 방금 확정한 턴 결과를 버리지 않는다(2026-08-30).
    const memoryChanges = requestedMemoryUpdates.length > 0 && !signal.aborted
      ? await this.applyMemoryUpdates(role, requestedMemoryUpdates)
      : requestedMemoryUpdates.map((update) => ({
          path: update.path, previousSHA256: update.expectedSHA256, sha256: "",
          reason: update.reason, status: "rejected" as const, error: "실행이 취소되어 반영하지 않았습니다.",
        }));
    this.event(topic.id, role, "agent_output", safeResult.summary, {
      resultKind: safeResult.kind, findings: safeResult.findings, evidenceRefs: safeResult.evidenceRefs,
      requestedUserDecision: safeResult.requestedUserDecision,
      memoryChanges,
    });
  }

  async applyMemoryUpdates(
    role: ParticipantRole,
    updates: readonly MemoryUpdate[],
  ): Promise<AppliedMemoryChange[]> {
    try {
      return await this.dependencies.memory!.apply(role, updates);
    } catch (error) {
      const reason = redactSecrets(error instanceof Error ? error.message : String(error));
      return updates.map((update) => ({
        path: update.path,
        previousSHA256: update.expectedSHA256,
        sha256: "",
        reason: update.reason,
        status: "rejected" as const,
        error: reason,
      }));
    }
  }

  async latestResult(topicId: string, kind: string): Promise<AgentResult> {
    const raw = await this.dependencies.artifacts.readLatest(topicId, kind);
    if (!raw) throw new Error(`${kind} 결과를 찾을 수 없습니다.`);
    return AgentResultSchema.parse(JSON.parse(raw));
  }

  requirePlan(result: AgentResult): string {
    if (!result.planMarkdown) throw new Error(`${result.kind} 응답에 planMarkdown이 없습니다.`);
    assertPlanContract(result.planMarkdown);
    return normalizePlan(result.planMarkdown);
  }

  // 개정은 패치(planEdits)를 우선 해석한다 — 프롬프트가 같은 우선순위를 명시한다(둘 다 있으면 edits).
  // find의 유일 일치는 applyPlanEdits가 강제하고, 실패 메시지는 어느 편집인지 명시한다. 베이스는
  // 프롬프트에 실린 '기존 계획'과 같은 storedPlan이라 모델이 본 본문과 적용 대상이 항상 일치한다.
  requireRevisedPlan(result: AgentResult, baseMarkdown: string): string {
    // 빈 배열도 패치 모드다 — "계획 변경 없음"(개정 6·12 실측 패턴). planMarkdown 누락으로
    // 오판해 거부하면 무수정 개정이 성립할 수 없다(2026-08-31 Codex 지적 재현 확인).
    if (result.planEdits) {
      const patched = applyPlanEdits(baseMarkdown, result.planEdits);
      assertPlanContract(patched);
      return normalizePlan(patched);
    }
    return this.requirePlan(result);
  }

  async requireStoredPlan(topicId: string): Promise<string> {
    const plan = await this.dependencies.artifacts.readLatest(topicId, "plan");
    if (!plan) throw new Error("저장된 plan.md가 없습니다.");
    return plan;
  }

  assertKind(result: AgentResult, expected: AgentResult["kind"]): void {
    if (result.kind !== expected) throw new FormatViolation(`에이전트 응답 종류가 다릅니다: ${result.kind} (예상 ${expected})`);
    assertFixDispositionAllowed(result, expected);
  }

  event(topicId: string, actor: "system" | "user" | ParticipantRole, kind: "system" | "decision" | "scope_change" | "agent_output", body: string, payload: Record<string, unknown> = {}): void {
    const state = this.dependencies.database.getTopic(topicId).state;
    this.dependencies.database.appendEvent({
      topicId,
      actor,
      kind,
      state,
      body: redactSecrets(body),
      payload: redactRecord(payload),
    });
  }
}
