import { PlanningPaused } from "../../shared/planningControl.js";
// 공통 실행기 — 모델 호출은 전부 여기서만 연다(PLAN §2 "다음 실행 허용"). 파이프라인·코어는 adapter 를 직접 부르지 않는다
// (tests/turn-executor.test.ts 가 소스를 읽어 구조를 검사한다).
//
// 실행 허용 검사(admit)는 두 번 돈다: adapter 를 부르기 전에 한 번(가짜 adapter·값싼 조기 종료), 그리고 어댑터가 준비(임시 파일·슬롯 대기·
// 세션 폴백·내부 재시도)를 마치고 **프로세스를 spawn 하기 직전**에 한 번 더(SessionTurn.beforeSpawn → CommandSpec.beforeSpawn).
// 검사 항목: 취소 · 늦은 응답(assertCurrent) · 새 결정/증거 · 계획 변경(epoch·sha, 쓰기 호출은 승인 계획) · 유지보수 잠금 · 예산 소진 ·
// 쓰기 호출의 Git 기준·도구 트리 기준. 거부하면 프로세스는 뜨지 않고, 사유는 구조화된 이벤트로 남으며, 결과·재개 위치는 호출자가
// checkpoint 로 이미 보존한 상태다(호출자가 execute 전에 record 한다).
import type { AgentExecutionSettings, AgentResult, PlanRepair, Topic, WorkflowState } from "../../shared/contracts.js";
import type { AgentAdapter, ParticipantRole, SessionTurn, TurnUsage } from "../types.js";
import { digestToolTrees, type ToolTreeDigest } from "../toolTree.js";
import { BudgetBlocked } from "../budgetLedger.js";
import type { EngineCore } from "./core.js";
import { HandledWorkflowInterruption } from "./core.js";

export type TurnPurpose = "턴" | "계약 교정 재제출" | "프로토콜 확인" | "계속 진행 턴" | "허용 오차 교정" | "완료 확인" | "계획 교정";

export interface TurnExpectation {
  evidenceDigest?: string;
  state: WorkflowState;
  scopeGeneration: number;
  planEpoch: number;
  planSHA256: string | null;
}

export interface WriteGuards {
  // 쓰기 호출은 승인된 계획과 같은 계획에서만 연다.
  requireApprovedPlan: boolean;
  baselineHead?: string;          // git HEAD 가 구현 기준과 같아야 한다
  toolTreeBaseline?: ToolTreeDigest;
}

export interface TurnRequest {
  evidenceDigest?: string;
  role: ParticipantRole;
  topic: Topic;
  signal: AbortSignal;
  purpose: TurnPurpose;
  // 프롬프트에 반영한 마지막 타임라인 sequence — 그 뒤 결정·증거가 오면 실행하지 않는다.
  inputSequence: number;
  expected: TurnExpectation;
  write: boolean;
  writeGuards?: WriteGuards;
  session:
    | { mode: "resume"; sessionId: string; onSessionCreated?: (sessionId: string) => void; fallbackFresh?: { prompt: string; onSessionCreated?: (sessionId: string) => void; onFallback?: (sessionId: string) => void } }
    | { mode: "create"; onSessionCreated?: (sessionId: string) => void };
  prompt: string;
  // prompt 가 이어 쓰는 세션 기준의 변경분일 때의 전체 문맥 판 — SessionTurn.freshSessionPrompt 로 그대로 넘긴다.
  freshSessionPrompt?: string;
  implementation: boolean;
  planMode?: boolean;
  protocolOnly?: boolean;
  planningWrite?: SessionTurn["planningWrite"];
  readablePaths?: readonly string[];
  settings: AgentExecutionSettings;
  onUsage?: (usage: TurnUsage) => void;
  // 프로세스가 실제로 떴을 때(spawn 직후) 부른다 — "실행했다" 는 영속 기록을 남기는 데 쓴다(결과가 돌아오기 전에 죽어도 기록은 남는다).
  onSpawn?: () => void;
  // 응답이 돌아온 직후·채택 검사 전에 부른다 — 세션 id 저장처럼 채택 여부와 무관하게 남아야 하는 것(재시도가 같은 세션을 resume).
  onResponse?: (outcome: TurnOutcome) => void;
}

export interface TurnOutcome { sessionId: string; result: AgentResult; created: boolean }

export class AdmissionRefused extends Error {
  constructor(readonly reason: "cancelled" | "stale" | "plan-changed" | "unapproved-plan" | "maintenance" | "budget" | "baseline" | "tool-tree", message: string) {
    super(message);
    this.name = "AdmissionRefused";
  }
}

export class TurnExecutor {
  constructor(private readonly core: EngineCore) {}

  private adapter(role: ParticipantRole): AgentAdapter {
    return role === "claude" ? this.core.dependencies.claude : this.core.dependencies.codex;
  }

  // 실행 허용 검사 — 던지면 실행하지 않는다. 두 부분으로 나뉜다:
  //   sync  : 취소 · 늦은 응답 · 계획 변경 · 승인 계획 · 새 결정/증거 · 유지보수 잠금 · 예산 소진 · 도구 트리 지문 — 전부 동기라 spawn 직전에
  //           await 없이 마지막으로 다시 돈다(CommandSpec.admitSync).
  //   async : Git HEAD(쓰기 호출) — 비동기 준비 단계(CommandSpec.beforeSpawn)에서 돈다. 그 뒤 sync 가 한 번 더 돈다.
  // 새 사용자 입력은 인터럽트(상태 전이)까지 하고 HandledWorkflowInterruption 을 던진다.
  admission(request: TurnRequest): { sync: () => void; async: () => Promise<void> } {
    const { topic, signal, expected } = request;
    request.evidenceDigest ??= expected.evidenceDigest ?? this.core.dependencies.database.evidence.topic(topic).digest;
    const sync = () => {
      if (signal.aborted) throw signal.reason ?? new AdmissionRefused("cancelled", "실행이 취소되었습니다.");
      const db = this.core.dependencies.database;
      const current = db.getTopic(topic.id);
      this.core.assertCurrent(topic.id, signal, expected.scopeGeneration, expected.state);
      const evidence = db.evidence.topic(current);
      if (!evidence.ready || evidence.digest !== request.evidenceDigest || (request.write && !evidence.reviewed)) {
        this.core.interrupt(topic.id, "BLOCKED_ON_EVIDENCE", "외부 근거가 바뀌었거나 확인이 필요합니다. 원문을 갱신하고 현재 계획에 미치는 영향을 확인하세요.", expected.state, { externalEvidence: true });
        throw new HandledWorkflowInterruption();
      }
      if (current.planEpoch !== expected.planEpoch || current.planSHA256 !== expected.planSHA256) {
        this.refuse(request, "plan-changed", `계획이 바뀌어 ${request.purpose} 을 열지 않습니다(epoch ${expected.planEpoch}→${current.planEpoch}, sha ${(expected.planSHA256 ?? "-").slice(0, 12)}→${(current.planSHA256 ?? "-").slice(0, 12)}).`);
      }
      if (request.write && request.writeGuards?.requireApprovedPlan && (!current.approvedPlanSHA256 || current.approvedPlanSHA256 !== current.planSHA256)) {
        this.refuse(request, "unapproved-plan", `승인된 계획이 아니어서 쓰기 호출(${request.purpose})을 열지 않습니다.`);
      }
      // 새 결정·증거: 결과는 호출자가 checkpoint 로 보존했다 — 인터럽트하고 흐름을 끝낸다.
      if (this.core.newUserInputSince(topic, request.inputSequence)) {
        this.core.event(topic.id, "system", "system",
          `${request.purpose} 을 열기 직전에 새 결정·증거가 도착해 실행하지 않습니다(진행 결과는 보존됨).`, { admissionRefused: "new-user-input", purpose: request.purpose });
        this.core.interruptForNewUserInput(topic, request.inputSequence);
        throw new HandledWorkflowInterruption();
      }
      try { this.core.assertNoMaintenanceLock(); } catch (error) {
        this.refuse(request, "maintenance", `${request.purpose} 을 열지 않습니다 — ${error instanceof Error ? error.message : String(error)}`);
      }
      if (this.core.dependencies.enforceBudgets) {
        try { db.budgets.assertNotExhausted(this.core.budgetAccounts(topic.id)); } catch (error) {
          if (error instanceof BudgetBlocked) this.refuse(request, "budget", `${request.purpose} 을 열지 않습니다 — 예산 소진(${error.accountId}): ${error.message}`);
          throw error;
        }
      }
      if (request.write && request.writeGuards?.toolTreeBaseline) {
        const baseline = request.writeGuards.toolTreeBaseline;
        const after = digestToolTrees(topic.worktreePath);
        if (after.sha256 !== baseline.sha256) {
          this.refuse(request, "tool-tree", `도구 트리가 기준과 달라 쓰기 호출(${request.purpose})을 열지 않습니다(${baseline.sha256.slice(0, 12)} → ${after.sha256.slice(0, 12)}) — tools_sync + tool-tree-rebaseline 뒤 재시도.`);
        }
      }
    };
    const async = async () => {
      sync();
      if (request.write && request.writeGuards?.baselineHead !== undefined) {
        const head = await this.core.dependencies.git.head(topic.worktreePath);
        if (head !== request.writeGuards.baselineHead) {
          this.refuse(request, "baseline", `Git HEAD(${head.slice(0, 12)})가 구현 기준(${request.writeGuards.baselineHead.slice(0, 12)})과 달라 쓰기 호출(${request.purpose})을 열지 않습니다.`);
        }
      }
    };
    return { sync, async };
  }

  private refuse(request: TurnRequest, reason: AdmissionRefused["reason"], message: string): never {
    this.core.event(request.topic.id, "system", "system", `[${request.role}] ${message}`, { admissionRefused: reason, purpose: request.purpose, role: request.role });
    throw new AdmissionRefused(reason, message);
  }

  // 모델 호출 — AgentResult 를 돌려주는 턴(계획·리뷰·구현·수정·교정·계속 진행·확인).
  async execute(request: TurnRequest): Promise<TurnOutcome> {
    const admit = this.admission(request);
    await admit.async();
    const adapter = this.adapter(request.role);
    const base = {
      prompt: request.prompt, freshSessionPrompt: request.freshSessionPrompt, cwd: request.topic.worktreePath, signal: request.signal, implementation: request.implementation,
      planMode: request.planMode, protocolOnly: request.protocolOnly, planningWrite: request.planningWrite, readablePaths: request.readablePaths,
      settings: request.settings, beforeSpawn: admit.async, admitSync: admit.sync,
      onProcessSpawn: ((observe) => (process: Parameters<NonNullable<SessionTurn["onProcessSpawn"]>>[0]) => { observe(process); request.onSpawn?.(); })(this.core.processObserver(request.topic.id)),
      onUsage: request.onUsage ?? this.core.usageObserver(request.topic.id, request.role, request.purpose),
    };
    if (request.session.mode === "create") {
      const created = await adapter.createSession({ ...base, onSessionCreated: request.session.onSessionCreated });
      return this.settle(request, { sessionId: created.sessionId, result: created.result, created: true });
    }
    const session = request.session;
    try {
      let sessionId = session.sessionId;
      const result = await adapter.resumeTurn({ ...base, sessionId, onSessionCreated: id => {
        if (request.role === "claude" && this.core.dependencies.database.planning.continuityEnabled(request.topic.id) && id !== session.sessionId) {
          throw new PlanningPaused("Claude가 다른 세션 ID를 반환했습니다. 기존 세션을 보존하고 중단합니다.");
        }
        sessionId = id; session.onSessionCreated?.(id);
      } });
      return this.settle(request, { sessionId, result, created: sessionId !== session.sessionId });
    } catch (error) {
      if (request.role === "claude" && this.core.dependencies.database.planning.continuityEnabled(request.topic.id) && isMissingSessionError(error) && !request.signal.aborted) {
        throw new PlanningPaused("Claude 대화 파일을 찾을 수 없습니다. 새 세션을 생성하지 않고 복구를 기다립니다.");
      }
      if (!session.fallbackFresh || !isMissingSessionError(error) || request.signal.aborted) throw error;
      // 세션 유실 폴백도 같은 경계다 — 새 spawn 전에 beforeSpawn(admit) 이 다시 돈다.
      this.core.event(request.topic.id, "system", "system",
        `저장된 세션 ${session.sessionId} 의 대화 파일을 CLI 가 찾지 못해 새 세션으로 시작합니다(직전 턴이 시작 직후 중단됐을 때 생기는 상태).`,
        { missingSessionId: session.sessionId });
      const created = await adapter.createSession({ ...base, prompt: session.fallbackFresh.prompt, onSessionCreated: session.fallbackFresh.onSessionCreated });
      session.fallbackFresh.onFallback?.(created.sessionId);
      return this.settle(request, { sessionId: created.sessionId, result: created.result, created: true });
    }
  }

  // 응답 정착 순서: 늦은 응답·취소 → 버림(저장 없음) / 현재 응답 → 세션 저장(onResponse) → 채택 검사(계획 변경·새 입력이면 보존만).
  private async settle(request: TurnRequest, outcome: TurnOutcome): Promise<TurnOutcome> {
    this.core.assertCurrent(request.topic.id, request.signal, request.expected.scopeGeneration, request.expected.state);
    request.onResponse?.(outcome);
    await this.accept(request, outcome.result);
    return outcome;
  }

  // 응답을 받아들일 때의 검사(PLAN §2 검증 조건 2) — 호출 도중 새 결정·증거가 오거나 계획이 바뀌었으면 결과를 **보존만** 하고 현재 결과로
  // 채택하지 않는다(`<role>-interrupted` 산출물 + 인터럽트). 늦은 응답(다른 action·세대·상태)은 버린다.
  private async accept(request: TurnRequest, result: AgentResult): Promise<void> {
    const { topic, signal, expected } = request;
    this.core.assertCurrent(topic.id, signal, expected.scopeGeneration, expected.state);
    const current = this.core.dependencies.database.getTopic(topic.id);
    const evidence = this.core.dependencies.database.evidence.topic(current);
    if (!evidence.ready || evidence.digest !== request.evidenceDigest) {
      await this.core.preserveInterruptedResult(topic, request.role, result, signal, "원문 확인 상태가 바뀌어 이전 근거로 만든 결과를 보존만 합니다.");
      this.core.interrupt(topic.id, "BLOCKED_ON_EVIDENCE", "외부 근거가 실행 중 바뀌었습니다. 변경 영향을 확인한 뒤 재개하세요.", expected.state, { externalEvidence: true });
      throw new HandledWorkflowInterruption();
    }
    if (current.planEpoch !== expected.planEpoch || current.planSHA256 !== expected.planSHA256) {
      await this.core.preserveInterruptedResult(topic, request.role, result, signal,
        `${request.role} 턴이 도는 동안 계획이 바뀌어(epoch ${expected.planEpoch}→${current.planEpoch}) 이 결과는 채택하지 않습니다.`);
      this.core.interrupt(topic.id, "USER_DECISION_REQUIRED",
        "에이전트가 답하는 동안 계획이 바뀌었습니다. 결과는 보존했습니다 — 같은 단계를 다시 실행해 새 계획을 반영하세요.", expected.state, { planChangedDuringTurn: true });
      throw new HandledWorkflowInterruption();
    }
    if (await this.core.interruptPreservingResult(topic, request.role, result, request.inputSequence, signal)) throw new HandledWorkflowInterruption();
  }

  // 계획 표기 교정(패치 응답) — 같은 허용 검사를 거친다.
  async executePlanRepair(request: TurnRequest): Promise<PlanRepair> {
    const adapter = this.adapter(request.role);
    if (!adapter.resumePlanRepair || request.session.mode !== "resume") throw new Error("계획 교정을 지원하지 않는 어댑터·세션입니다.");
    const admit = this.admission(request);
    await admit.async();
    const result = await adapter.resumePlanRepair({
      sessionId: request.session.sessionId, prompt: request.prompt, cwd: request.topic.worktreePath, signal: request.signal,
      protocolOnly: true, implementation: false, planMode: false, settings: request.settings, beforeSpawn: admit.async, admitSync: admit.sync,
      onProcessSpawn: this.core.processObserver(request.topic.id),
      onUsage: request.onUsage ?? this.core.usageObserver(request.topic.id, request.role, request.purpose),
    });
    admit.sync();
    return result;
  }

  supportsPlanRepair(role: ParticipantRole): boolean {
    return Boolean(this.adapter(role).resumePlanRepair);
  }
}

export function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No conversation found with session ID/i.test(message);
}
