import { invokeAdapter } from "../runtime/invoke.js";
import { PlanningPaused, type InvocationUsage, type TimelineDelivery } from "../../shared/planningControl.js";
import { AgentRunError } from "../adapters/resultParser.js";
// 공통 실행기 — 모델 호출은 전부 여기서만 연다(PLAN §2 "다음 실행 허용"). 파이프라인·코어는 adapter 를 직접 부르지 않는다
// (tests/turn-executor.test.ts 가 소스를 읽어 구조를 검사한다).
//
// 실행 허용 검사(admit)는 두 번 돈다: adapter 를 부르기 전에 한 번(가짜 adapter·값싼 조기 종료), 그리고 어댑터가 준비(임시 파일·슬롯 대기·
// 세션 폴백·내부 재시도)를 마치고 **프로세스를 spawn 하기 직전**에 한 번 더(SessionTurn.beforeSpawn → CommandSpec.beforeSpawn).
// 검사 항목: 취소 · 늦은 응답(assertCurrent) · 서버 샌드박스(hostSandbox) · 새 결정/증거 · 계획 변경(epoch·sha, 쓰기 호출은 승인 계획) · 유지보수 잠금 · 예산 소진 ·
// 쓰기 호출의 Git 기준·도구 트리 기준. 거부하면 프로세스는 뜨지 않고, 사유는 구조화된 이벤트로 남으며, 결과·재개 위치는 호출자가
// checkpoint 로 이미 보존한 상태다(호출자가 execute 전에 record 한다).
import type { AgentExecutionSettings, AgentResult, PlanRepair, Topic, WorkflowState } from "../../shared/contracts.js";
import { turnFlags } from "../../shared/roles.js";
import { planningControlApplies } from "../guardedPlanning.js";
import { bindingOf, designReadRequested, routeSupport, type Provider, type TurnRoute } from "../turnRouting.js";
import type { AgentAdapter, SessionTurn, TurnUsage } from "../types.js";
import { digestToolTrees, type ToolTreeDigest } from "../toolTree.js";
import { BudgetBlocked } from "../budgetLedger.js";
import type { EngineCore } from "./core.js";
import { HandledWorkflowInterruption } from "./core.js";

export type TurnPurpose = "턴" | "계약 교정 재제출" | "프로토콜 확인" | "계속 진행 턴" | "허용 오차 교정" | "완료 확인" | "계획 교정" | "복구 세션 계획 확인"
  | "리뷰 읽기";

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
  // 이 턴의 경로(엔진 개편 E2b, core.route) — job(역할 정책: write·implementation·protocolOnly 는 호출자가 따로 적지 않고 turnFlags 로 유도, E2a),
  // 좌석(이벤트·산출물 이름), 실제 공급자(어느 어댑터로 가는가)와 선택 근거.
  route: TurnRoute;
  topic: Topic;
  signal: AbortSignal;
  purpose: TurnPurpose;
  // 프롬프트에 반영한 마지막 타임라인 sequence — 그 뒤 결정·증거가 오면 실행하지 않는다.
  inputSequence: number;
  expected: TurnExpectation;
  writeGuards?: WriteGuards;
  session:
    | { mode: "resume"; sessionId: string; onSessionCreated?: (sessionId: string) => void }
    | { mode: "create"; onSessionCreated?: (sessionId: string) => void };
  prompt: string;
  // 복구 경로를 호출자가 가진다(E3-3b, delivery 의 작업 세션 턴) — 연속성 v2 작성자 좌석의 세션 유실도 PlanningPaused 로 바꾸지 않고 원래 오류를 그대로
  // 던진다. 호출자가 계보·사용량·진척을 보고 복구하거나 같은 정지로 돌린다.
  recoverable?: boolean;
  // prompt 가 이어 쓰는 세션 기준의 변경분일 때의 전체 문맥 판 — SessionTurn.freshSessionPrompt 로 그대로 넘긴다.
  freshSessionPrompt?: string;
  // 두 판의 타임라인 참조 descriptor — SessionTurn.timelineDelivery 로 그대로 넘긴다(E3-2-2a).
  timelineDelivery?: TimelineDelivery;
  planMode?: boolean;
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

// 실패한 호출의 관측(E3-3b) — 어떤 세션에 보낸 호출이었고 그 호출의 마지막 사용량 스냅숏이 완전했는가. 오류 객체는 그대로 던지고(모든 호출자의 기존 처리
// 유지) 관측만 짝지어 둔다. 복구는 이 호출의 관측만 쓴다 — 이전 성공 턴의 complete 를 재사용하지 않고, 관측이 없으면 unknown(0 이 아니다)이다.
export interface InvocationFailure { sessionId: string | null; usage: InvocationUsage; seat: TurnRoute["seat"]; job: TurnRoute["job"] }
const invocationFailures = new WeakMap<object, InvocationFailure>();
export function invocationFailure(error: unknown): InvocationFailure | undefined {
  return typeof error === "object" && error !== null ? invocationFailures.get(error) : undefined;
}

export class AdmissionRefused extends Error {
  // unsupported-route: 배정된 공급자가 이 job 의 정책을 표현할 수 없거나 배정이 실행할 수 없다(E2b). session-binding: 연속성 정책에서 좌석 세션을 다른
  // 공급자·참여자로 이어 쓸 수 없다(E2b). 둘 다 재시도해도 같으므로 결정 대기로 멈춘다. host-sandbox: 서버가 샌드박스 안에서 떠 러너·Codex 가
  // 중첩 샌드박스를 만들 수 없다(app.ts probeNestedSandbox) — 서버를 샌드박스 밖에서 다시 띄워야 풀린다.
  constructor(readonly reason: "cancelled" | "stale" | "plan-changed" | "unapproved-plan" | "maintenance" | "budget" | "baseline" | "tool-tree"
    | "unsupported-route" | "session-binding" | "host-sandbox", message: string) {
    super(message);
    this.name = "AdmissionRefused";
  }
}

export class TurnExecutor {
  constructor(private readonly core: EngineCore) {}

  private adapter(provider: Provider): AgentAdapter {
    return provider === "claude" ? this.core.dependencies.claude : this.core.dependencies.codex;
  }

  // 어댑터를 부르기 전 마지막 지원 판정 — 경로를 만들 때(core.route) 이미 봤지만, 래퍼·세션 저장이 돌기 전에 한 번 더 막는다(E2b). 형태는 경로 판정과
  // 같다: 계획 제어 여부와 증거 래퍼가 붙일 Figma 관측 요구(E2c — 전에는 Figma 요구를 빼고 판정했다).
  private assertRouteSupported(request: TurnRequest): void {
    const database = this.core.dependencies.database;
    const current = database.getTopic(request.topic.id);
    const reason = routeSupport(request.route, planningControlApplies(database, current.id, current.state, turnFlags(request.route.job)),
      designReadRequested(database, current.id, request.route.job));
    if (reason) this.refuse(request, "unsupported-route", `${reason}(job ${request.route.job.role}/${request.route.job.operation}, 공급자 ${request.route.provider}).`);
  }

  // 실행 허용 검사 — 던지면 실행하지 않는다. 두 부분으로 나뉜다:
  //   sync  : 취소 · 늦은 응답 · 서버 샌드박스 · 계획 변경 · 승인 계획 · 새 결정/증거 · 유지보수 잠금 · 예산 소진 · 도구 트리 지문 — 전부 동기라 spawn 직전에
  //           await 없이 마지막으로 다시 돈다(CommandSpec.admitSync).
  //   async : Git HEAD(쓰기 호출) — 비동기 준비 단계(CommandSpec.beforeSpawn)에서 돈다. 그 뒤 sync 가 한 번 더 돈다.
  // 새 사용자 입력은 인터럽트(상태 전이)까지 하고 HandledWorkflowInterruption 을 던진다.
  admission(request: TurnRequest): { sync: () => void; async: () => Promise<void> } {
    const { topic, signal, expected } = request;
    const { write } = turnFlags(request.route.job);
    request.evidenceDigest ??= expected.evidenceDigest ?? this.core.dependencies.database.evidence.topic(topic).digest;
    const sync = () => {
      if (signal.aborted) throw signal.reason ?? new AdmissionRefused("cancelled", "실행이 취소되었습니다.");
      const db = this.core.dependencies.database;
      const current = db.getTopic(topic.id);
      this.core.assertCurrent(topic.id, signal, expected.scopeGeneration, expected.state);
      // 근거·계획보다 먼저 본다 — 이 조건에서는 어떤 호출도 도구를 쓰지 못하고, 근거를 갱신해도 풀리지 않는다.
      const host = this.core.dependencies.hostSandbox;
      if (host?.kind === "unavailable") {
        this.refuse(request, "host-sandbox", `${request.purpose} 을 열지 않습니다 — 서버 프로세스가 macOS 샌드박스 안에서 실행 중이라 러너 Bash·Codex 세션이 중첩 샌드박스를 만들지 못합니다(${host.detail}). 샌드박스 밖(사용자 터미널)에서 서버를 재시작한 뒤 retry 하세요.`);
      }
      const evidence = db.evidence.topic(current);
      if (!evidence.ready || evidence.digest !== request.evidenceDigest || (write && !evidence.reviewed)) {
        this.core.interrupt(topic.id, "BLOCKED_ON_EVIDENCE", "외부 근거가 바뀌었거나 확인이 필요합니다. 원문을 갱신하고 현재 계획에 미치는 영향을 확인하세요.", expected.state, { externalEvidence: true });
        throw new HandledWorkflowInterruption();
      }
      if (current.planEpoch !== expected.planEpoch || current.planSHA256 !== expected.planSHA256) {
        this.refuse(request, "plan-changed", `계획이 바뀌어 ${request.purpose} 을 열지 않습니다(epoch ${expected.planEpoch}→${current.planEpoch}, sha ${(expected.planSHA256 ?? "-").slice(0, 12)}→${(current.planSHA256 ?? "-").slice(0, 12)}).`);
      }
      if (write && request.writeGuards?.requireApprovedPlan && (!current.approvedPlanSHA256 || current.approvedPlanSHA256 !== current.planSHA256)) {
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
      if (write && request.writeGuards?.toolTreeBaseline) {
        const baseline = request.writeGuards.toolTreeBaseline;
        const after = digestToolTrees(topic.worktreePath);
        if (after.sha256 !== baseline.sha256) {
          this.refuse(request, "tool-tree", `도구 트리가 기준과 달라 쓰기 호출(${request.purpose})을 열지 않습니다(${baseline.sha256.slice(0, 12)} → ${after.sha256.slice(0, 12)}) — tools_sync + tool-tree-rebaseline 뒤 재시도.`);
        }
      }
    };
    const async = async () => {
      sync();
      if (write && request.writeGuards?.baselineHead !== undefined) {
        const head = await this.core.dependencies.git.head(topic.worktreePath);
        if (head !== request.writeGuards.baselineHead) {
          this.refuse(request, "baseline", `Git HEAD(${head.slice(0, 12)})가 구현 기준(${request.writeGuards.baselineHead.slice(0, 12)})과 달라 쓰기 호출(${request.purpose})을 열지 않습니다.`);
        }
      }
    };
    return { sync, async };
  }

  private refuse(request: TurnRequest, reason: AdmissionRefused["reason"], message: string): never {
    this.core.event(request.topic.id, "system", "system", `[${request.route.seat}] ${message}`,
      { admissionRefused: reason, purpose: request.purpose, role: request.route.seat, provider: request.route.provider, job: request.route.job });
    throw new AdmissionRefused(reason, message);
  }

  // 모델 호출 — AgentResult 를 돌려주는 턴(계획·리뷰·구현·수정·교정·계속 진행·확인).
  async execute(request: TurnRequest): Promise<TurnOutcome> {
    this.assertRouteSupported(request);
    const admit = this.admission(request);
    await admit.async();
    const adapter = this.adapter(request.route.provider);
    // 래퍼(증거 관리·계획 제어·예산)가 implementation·protocolOnly 를 읽는다 — job 유도값을 함께 싣는다.
    const flags = turnFlags(request.route.job);
    const requested = request.session.mode === "resume" ? request.session.sessionId : null;
    const database = this.core.dependencies.database;
    // 세션별 메모리 본문 수신(E3-4c host-review 39d21df9 F004) — 프로토콜 턴이 만든 세션은 생성 턴에 본문을 받지 않았다(어댑터는 protocolOnly 에 본문을 싣지
    // 않고 resume 에는 매니페스트만 싣는다). 그 세션의 첫 일반 resume 턴에만 본문 1회를 청한다. 계획 제어 턴은 메모리를 조각으로 받으므로 청하지도, 수신으로
    // 적지도 않는다(경로 판정·예산 래퍼와 같은 식). 기록 없는 세션은 종전 의미(이미 받음)라 청하지 않는다.
    const receipt = requested && !flags.protocolOnly
      && !planningControlApplies(database, request.topic.id, database.getTopic(request.topic.id).state, flags)
      ? database.planning.sessionReceipt(requested) : null;
    const memoryBodies = Boolean(receipt && !receipt.memoryBodies);
    const base = {
      prompt: request.prompt, freshSessionPrompt: request.freshSessionPrompt, cwd: request.topic.worktreePath, signal: request.signal,
      inputSequence: request.inputSequence,
      timelineDelivery: request.timelineDelivery,
      job: request.route.job, binding: bindingOf(request.route), implementation: flags.implementation,
      // 코드 리뷰 원장 ID(E3-4c) — core.turn 을 지나는 최종 판정 호출도 경로로만 실어 오므로 여기서 턴에 옮긴다. 없는 턴에는 키를 두지 않는다.
      ...(request.route.reviewLedger ? { reviewLedger: request.route.reviewLedger } : {}),
      ...(memoryBodies ? { memoryBodies: true } : {}),
      planMode: request.planMode, protocolOnly: flags.protocolOnly, planningWrite: request.planningWrite, readablePaths: request.readablePaths,
      settings: request.settings, providerOptions: request.route.options, beforeSpawn: admit.async, admitSync: admit.sync,
      onProcessSpawn: ((observe) => (process: Parameters<NonNullable<SessionTurn["onProcessSpawn"]>>[0]) => { observe(process); request.onSpawn?.(); })(this.core.processObserver(request.topic.id)),
      // 사용량은 기존 observer 로 그대로 넘기고(원장·이벤트 기록 유지), 이 호출의 마지막 스냅숏만 따로 잡는다(실패 관측).
      onUsage: ((observe) => (usage: TurnUsage) => { lastUsage = usage; observe(usage); })(request.onUsage ?? this.core.usageObserver(request.topic.id, request.route, request.purpose)),
    };
    let lastUsage: TurnUsage | undefined;
    // 프로토콜 턴이 만든 세션(생성, 또는 resume 에 CLI 가 다른 id 로 답함)을 만든 즉시 적는다 — 호출자가 그 세션을 저장하기 전이라, 끊겨도 저장된 세션이
    // 기록 없이(= 이미 받은 것으로) 남지 않는다.
    const noteProtocolSession = (id: string) => { if (flags.protocolOnly) database.planning.noteProtocolSession(request.topic.id, id); };
    const receipts = { noteProtocolSession, memoryBodiesFor: memoryBodies ? requested : null };
    const authorContinuity = request.route.seat === "claude" && database.planning.continuityEnabled(request.topic.id);
    try {
      if (request.session.mode === "create") {
        const onCreated = request.session.onSessionCreated;
        const created = await invokeAdapter(adapter, { method: "create", turn: { ...base, onSessionCreated: (id: string) => {
          noteProtocolSession(id);
          onCreated?.(id);
        } } });
        return this.settle(request, { sessionId: created.sessionId, result: created.result, created: true }, receipts);
      }
      const session = request.session;
      let sessionId = session.sessionId;
      const result = await invokeAdapter(adapter, { method: "resume", turn: { ...base, sessionId, onSessionCreated: id => {
        // 작성자 좌석의 계획 연속성(계획→개정→구현이 한 세션) — CLI 가 다른 세션 id 를 돌려주면 보존하고 멈춘다. 예외는 그 좌석 계보의 마지막 자동 복구
        // 기록과 짝인 새 세션뿐이다(E3-3b — 계획 제어 래퍼가 같은 route 새 세션을 만들며 요청 id → 새 id 를 먼저 기록한다). 짝은 이 호출이 **직전에 수용한**
        // 세션 기준이다 — 한 호출 안의 연쇄 복구(S0 → S1 → S2)에서 최초 요청 id(S0)로 대조하면 허가된 두 번째 복구를 막았다(host-review 9c4d786 F003).
        if (authorContinuity && id !== sessionId && !this.pairedRecovery(request, sessionId, id)) {
          this.recordIdentityMismatch(request, sessionId, id);
          throw new PlanningPaused("Claude가 다른 세션 ID를 반환했습니다. 기존 세션을 보존하고 중단합니다.");
        }
        if (id !== session.sessionId) noteProtocolSession(id);
        sessionId = id; session.onSessionCreated?.(id);
      } } });
      return this.settle(request, { sessionId, result, created: sessionId !== session.sessionId }, receipts);
    } catch (error) {
      if (typeof error === "object" && error !== null && !invocationFailures.has(error)) {
        invocationFailures.set(error, { sessionId: requested, seat: request.route.seat, job: request.route.job,
          usage: !lastUsage ? "unknown" : lastUsage.completeness === "complete" ? "complete" : "partial" });
      }
      // 연속성 v2 작성자 좌석의 세션 유실 — 복구 경로를 가진 호출자(delivery 작업 세션 턴)가 아니면 새 세션 없이 멈춘다(기존 계약).
      if (requested && authorContinuity && !request.recoverable && isMissingSessionError(error) && !request.signal.aborted) {
        throw new PlanningPaused("Claude 대화 파일을 찾을 수 없습니다. 새 세션을 생성하지 않고 복구를 기다립니다.");
      }
      throw error;
    }
  }

  // 새 세션 id 가 그 좌석 계보의 마지막 자동 복구 기록(요청 id → 새 id)과 짝인가(E3-3b). 계획·개정 턴은 계획자 계보, 그 밖(구현·수정·확인)은 작업 계보다.
  private pairedRecovery(request: TurnRequest, requested: string, returned: string): boolean {
    const last = this.core.dependencies.database.planning.storedRecoveryLineage(request.topic.id, request.route.job.role === "planner" ? "planner" : "implementer")
      ?.recoveries.at(-1);
    return Boolean(last && (last.fromSession === requested || last.unstartedSessions?.includes(requested)) && last.toSession === returned);
  }

  // 짝 없는 신원 변경은 응답을 채택하지 않고(기존 차단) 좌석 계보에 요청·반환 id 를 남긴다. 자동 복구 사유가 아니다(K1).
  private recordIdentityMismatch(request: TurnRequest, requested: string, returned: string): void {
    const planning = this.core.dependencies.database.planning;
    const seat = request.route.job.role === "planner" ? "planner" : "implementer";
    const lineage = planning.currentRecoveryLineage(request.topic.id, seat);
    const topic = this.core.dependencies.database.getTopic(request.topic.id);
    lineage.blocked = { at: new Date().toISOString(), reason: "identity-mismatch",
      error: { provider: request.route.provider, code: "identity-mismatch", message: "Claude가 다른 세션 ID를 반환했습니다." },
      contract: { stage: topic.state, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planSHA256: topic.planSHA256, binding: bindingOf(request.route) },
      sessions: { requested, returned } };
    planning.saveRecoveryLineage(request.topic.id, seat, lineage);
  }

  // 응답 정착 순서: 늦은 응답·취소 → 버림(저장 없음) / 현재 응답 → 세션 수신 기록 → 세션 저장(onResponse) → 채택 검사(계획 변경·새 입력이면 보존만).
  // 수신 기록(E3-4c F004): 프로토콜 턴이 만든 세션은 세션 저장보다 먼저 적는다(생성 알림이 없던 어댑터 포함, 멱등). 본문을 청한 턴은 현재 응답이 요청한 세션에서
  // 돌아온 뒤에만 수신으로 적는다 — 실패·취소·늦은 응답·다른 세션 응답은 적지 않아 다음 일반 턴이 다시 싣는다.
  private async settle(request: TurnRequest, outcome: TurnOutcome,
    receipts: { noteProtocolSession: (id: string) => void; memoryBodiesFor: string | null }): Promise<TurnOutcome> {
    if (outcome.created) receipts.noteProtocolSession(outcome.sessionId);
    this.core.assertCurrent(request.topic.id, request.signal, request.expected.scopeGeneration, request.expected.state);
    if (receipts.memoryBodiesFor && outcome.sessionId === receipts.memoryBodiesFor) {
      this.core.dependencies.database.planning.noteMemoryBodies(receipts.memoryBodiesFor);
    }
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
      await this.core.preserveInterruptedResult(topic, request.route.seat, result, signal, "원문 확인 상태가 바뀌어 이전 근거로 만든 결과를 보존만 합니다.");
      this.core.interrupt(topic.id, "BLOCKED_ON_EVIDENCE", "외부 근거가 실행 중 바뀌었습니다. 변경 영향을 확인한 뒤 재개하세요.", expected.state, { externalEvidence: true });
      throw new HandledWorkflowInterruption();
    }
    if (current.planEpoch !== expected.planEpoch || current.planSHA256 !== expected.planSHA256) {
      await this.core.preserveInterruptedResult(topic, request.route.seat, result, signal,
        `${request.route.seat} 턴이 도는 동안 계획이 바뀌어(epoch ${expected.planEpoch}→${current.planEpoch}) 이 결과는 채택하지 않습니다.`);
      this.core.interrupt(topic.id, "USER_DECISION_REQUIRED",
        "에이전트가 답하는 동안 계획이 바뀌었습니다. 결과는 보존했습니다 — 같은 단계를 다시 실행해 새 계획을 반영하세요.", expected.state, { planChangedDuringTurn: true });
      throw new HandledWorkflowInterruption();
    }
    if (await this.core.interruptPreservingResult(topic, request.route.seat, result, request.inputSequence, signal)) throw new HandledWorkflowInterruption();
  }

  // 계획 표기 교정(패치 응답) — 같은 허용 검사를 거친다.
  async executePlanRepair(request: TurnRequest): Promise<PlanRepair> {
    const adapter = this.adapter(request.route.provider);
    if (!adapter.resumePlanRepair || request.session.mode !== "resume") throw new Error("계획 교정을 지원하지 않는 어댑터·세션입니다.");
    // 다른 작업의 job 으로 이 경로를 열면 권한이 조용히 바뀐다 — 계획 교정 job 만 받는다.
    if (request.route.job.operation !== "plan-repair") throw new Error(`계획 교정은 plan-repair 작업으로만 엽니다(${request.route.job.role}/${request.route.job.operation}).`);
    this.assertRouteSupported(request);
    const admit = this.admission(request);
    await admit.async();
    const flags = turnFlags(request.route.job);
    const result = await invokeAdapter(adapter, { method: "plan-repair", turn: {
      sessionId: request.session.sessionId, prompt: request.prompt, cwd: request.topic.worktreePath, signal: request.signal,
      job: request.route.job, protocolOnly: flags.protocolOnly, implementation: flags.implementation, planMode: false, settings: request.settings,
      providerOptions: request.route.options, beforeSpawn: admit.async, admitSync: admit.sync,
      onProcessSpawn: this.core.processObserver(request.topic.id),
      onUsage: request.onUsage ?? this.core.usageObserver(request.topic.id, request.route, request.purpose),
    } });
    admit.sync();
    return result;
  }

  supportsPlanRepair(provider: Provider): boolean {
    return Boolean(this.adapter(provider).resumePlanRepair);
  }
}

// 세션 유실은 어댑터가 관측으로 분류한 코드로만 판정한다(E3-3b) — session-missing 은 분류기가 모델 턴 없음 관측(Claude result num_turns 0, Codex 빈 stdout +
// 정확한 thread/resume 실패 줄)을 필요조건으로 요구한다. 같은 문구를 담은 일반 Error 는 유실이 아니다(unknown 과 같다).
export function isMissingSessionError(error: unknown): boolean {
  return error instanceof AgentRunError && error.code === "session-missing";
}
