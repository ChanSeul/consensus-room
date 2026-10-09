import { reviewCriteriaPrompt } from "../sessionSettings.js";
import { invokeAdapter } from "../runtime/invoke.js";
import { PlanningPaused, type InvocationUsage } from "../../shared/planningControl.js";
import { AgentRunError, UnverifiedAgentResult } from "../adapters/resultParser.js";
// 공통 실행기 — 모델 호출은 전부 여기서만 연다(PLAN §2 "다음 실행 허용"). 파이프라인·코어는 adapter 를 직접 부르지 않는다
// (tests/turn-executor.test.ts 가 소스를 읽어 구조를 검사한다).
//
// 실행 허용 검사(admit)는 두 번 돈다: adapter 를 부르기 전에 한 번(가짜 adapter·값싼 조기 종료), 그리고 어댑터가 준비(임시 파일·슬롯 대기·
// 세션 폴백·내부 재시도)를 마치고 **프로세스를 spawn 하기 직전**에 한 번 더(SessionTurn.beforeSpawn → CommandSpec.beforeSpawn).
// 검사 항목: 취소 · 늦은 응답(assertCurrent) · 서버 샌드박스(hostSandbox) · 새 결정/증거 · 계획 변경(epoch·sha, 쓰기 호출은 승인 계획) · 유지보수 잠금 · 예산 소진 ·
// 쓰기 호출의 Git 기준·도구 트리 기준. 거부하면 프로세스는 뜨지 않고, 사유는 구조화된 이벤트로 남으며, 결과·재개 위치는 호출자가
// checkpoint 로 이미 보존한 상태다(호출자가 execute 전에 record 한다).
import type { AgentExecutionSettings, AgentResult, Topic, WorkflowState } from "../../shared/contracts.js";
import type { TurnEnvelope } from "../../shared/turnContract.js";
import { turnFlags } from "../../shared/roles.js";
import { bindingOf, designReadRequested, routeSupport, type Provider, type TurnRoute } from "../turnRouting.js";
import type { AgentAdapter, SessionTurn, TurnUsage } from "../types.js";
import { digestToolTrees, type ToolTreeDigest } from "../toolTree.js";
import { BudgetBlocked } from "../budgetLedger.js";
import type { EngineCore } from "./core.js";
import { HandledWorkflowInterruption } from "./core.js";

export type TurnPurpose = "턴" | "계약 교정 재제출" | "프로토콜 확인" | "계속 진행 턴" | "허용 오차 교정" | "완료 확인" | "계획 교정" | "복구 세션 계획 확인"
  | "리뷰 읽기";

export interface TurnExpectation {
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
  // 결과를 곧바로 core.enforceResultContract 로 넘기는 호출자만 준다(2026-10-07 R3) — 검증에 실패한 최종 응답(UnverifiedAgentResult)을 결과로 받아
  // 같은 세션 교정으로 보낸다. 세션 id 를 모르는 호출과 이 표식이 없는 호출자는 지금처럼 그 오류를 받는다.
  acceptUnverified?: boolean;
  // prompt 가 이어 쓰는 세션 기준의 변경분일 때의 전체 문맥 판 — SessionTurn.freshSessionPrompt 로 그대로 넘긴다.
  freshSessionPrompt?: string;
  planMode?: boolean;
  readablePaths?: readonly string[];
  settings: AgentExecutionSettings;
  onUsage?: (usage: TurnUsage) => void;
  // 프로세스가 실제로 떴을 때(spawn 직후) 부른다 — "실행했다" 는 영속 기록을 남기는 데 쓴다(결과가 돌아오기 전에 죽어도 기록은 남는다).
  onSpawn?: () => void;
  // 응답이 돌아온 직후·채택 검사 전에 부른다 — 세션 id 저장처럼 채택 여부와 무관하게 남아야 하는 것(재시도가 같은 세션을 resume).
  onResponse?: (outcome: TurnOutcome) => void;
}

export interface TurnOutcome { sessionId: string; result: AgentResult; created: boolean }

// 결과 봉투 턴의 응답(계약 v3 (1)) — 봉투 계약을 어긴 응답은 violation 에 원응답·위반 문구를 싣는다(교정은 core 가 같은 세션에서 1회 한다, v3.5 (11)).
export type EnvelopeOutcome = { sessionId: string; created: boolean } &
  ({ envelope: TurnEnvelope; violation?: undefined } | { envelope?: undefined; violation: { raw: Record<string, unknown>; message: string } });
// 결과 봉투 턴의 요청 — AgentResult 경로의 응답 정착(onResponse)·검증 안 된 결과 수용은 없다(v3.15 (27)).
export type EnvelopeTurnRequest = Omit<TurnRequest, "onResponse" | "acceptUnverified"> & {
  // planner 계획 폴더(v3 (1)) — SessionTurn.planDirectory 로 그대로 넘긴다.
  planDirectory?: string;
  // 응답이 돌아온 직후·늦은 응답 판정 뒤에 부른다 — 세션 id 저장처럼 봉투 내용과 무관하게 남아야 하는 것.
  onEnvelope?: (outcome: EnvelopeOutcome) => void;
  // 운영 사슬 가장 안쪽 래퍼가 봉투를 받은 직후 부른다(SessionTurn.onEnvelopeReceived) — 엔진이 수신 슬롯에 잡았는지 돌려준다(cd2876b7 F008).
  onReceived?: NonNullable<SessionTurn["onEnvelopeReceived"]>;
};

// 실패한 호출의 관측(E3-3b) — 어떤 세션에 보낸 호출이었고 그 호출의 마지막 사용량 스냅숏이 완전했는가. 오류 객체는 그대로 던지고(모든 호출자의 기존 처리
// 유지) 관측만 짝지어 둔다. 복구는 이 호출의 관측만 쓴다 — 이전 성공 턴의 complete 를 재사용하지 않고, 관측이 없으면 unknown(0 이 아니다)이다.
export interface InvocationFailure { sessionId: string | null; usage: InvocationUsage; seat: TurnRoute["seat"]; job: TurnRoute["job"] }
const invocationFailures = new WeakMap<object, InvocationFailure>();
export function invocationFailure(error: unknown): InvocationFailure | undefined {
  return typeof error === "object" && error !== null ? invocationFailures.get(error) : undefined;
}

// 실패한 호출의 마지막 사용량 스냅숏 완전성 — 관측이 없으면 unknown(0 이 아니다).
function usageOf(usage: TurnUsage | undefined): InvocationUsage {
  return !usage ? "unknown" : usage.completeness === "complete" ? "complete" : "partial";
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
  // 같다: 증거 래퍼가 붙일 Figma 관측 요구(E2c — 전에는 Figma 요구를 빼고 판정했다).
  private assertRouteSupported(request: TurnRequest): void {
    const database = this.core.dependencies.database;
    const current = database.getTopic(request.topic.id);
    const reason = routeSupport(request.route, designReadRequested(database, current.id, request.route.job));
    if (reason) this.refuse(request, "unsupported-route", `${reason}(job ${request.route.job.role}/${request.route.job.operation}, 공급자 ${request.route.provider}).`);
  }

  // 실행 허용 검사 — 던지면 실행하지 않는다. 두 부분으로 나뉜다:
  //   sync  : 취소 · 늦은 응답 · 서버 샌드박스 · 계획 변경 · 승인 계획 · 새 결정/증거 · 유지보수 잠금 · 예산 소진 · 도구 트리 지문 — 전부 동기라 spawn 직전에
  //           await 없이 마지막으로 다시 돈다(CommandSpec.admitSync).
  //   async : Git HEAD(쓰기 호출) — 비동기 준비 단계(CommandSpec.beforeSpawn)에서 돈다. 그 뒤 sync 가 한 번 더 돈다.
  // 새 사용자 입력은 인터럽트(상태 전이)까지 하고 HandledWorkflowInterruption 을 던진다.
  // envelope: 결과 봉투 턴(v3.15 (26)) — root 승인만 보고, 새 입력 인터럽트는 하지 않는다.
  admission(request: TurnRequest, envelope = false): { sync: () => void; async: () => Promise<void> } {
    const { topic, signal, expected } = request;
    const { write } = turnFlags(request.route.job);
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
      // root 원문 승인(사용자 권한)만 실행 전에 본다 — 원문 변경·영향 심사(reviewed)는 정지 사유가 아니라 다음 턴에 전할 사실이다(D6, v3.15 (26)).
      // 옛 경로의 디지스트·reviewed 정지는 그 생산자(근거 심사)와 함께 ⑥ 에서 뺐다.
      if (!evidence.ready) this.stopForEvidenceRoots(request);
      if (current.planEpoch !== expected.planEpoch || current.planSHA256 !== expected.planSHA256) {
        this.refuse(request, "plan-changed", `계획이 바뀌어 ${request.purpose} 을 열지 않습니다(epoch ${expected.planEpoch}→${current.planEpoch}, sha ${(expected.planSHA256 ?? "-").slice(0, 12)}→${(current.planSHA256 ?? "-").slice(0, 12)}).`);
      }
      if (write && request.writeGuards?.requireApprovedPlan && (!current.approvedPlanSHA256 || current.approvedPlanSHA256 !== current.planSHA256)) {
        this.refuse(request, "unapproved-plan", `승인된 계획이 아니어서 쓰기 호출(${request.purpose})을 열지 않습니다.`);
      }
      // 새 결정·증거: 결과는 호출자가 checkpoint 로 보존했다 — 인터럽트하고 흐름을 끝낸다. 봉투 턴은 새 사실로 멈추지 않는다(v3 (1)).
      if (!envelope && this.core.newUserInputSince(topic, request.inputSequence)) {
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

  // 봉투 경로의 root 미승인 정지(v3.15 (26)) — 실행 전이라 봉투가 없으므로 recordEnvelope 와 같은 엔진 정지 규칙(v3.4 (3''): USER_DECISION_REQUIRED +
  // waitingFor·mediatorRequest)으로 남긴다. 자원 정지 표식(RESOURCE_PAUSE_KEYS)을 쓰지 않아 결정 정지로 분류되고, BLOCKED_ON_EVIDENCE 는 쓰지 않는다.
  private stopForEvidenceRoots(request: TurnRequest): never {
    const evidence = this.core.dependencies.database.evidence;
    const pending = evidence.catalog.forTopic(request.topic.id).filter(root => root.required && root.status === "proposed")
      .map(root => evidence.get(root.sourceId).url);
    const message = `필수 근거 범위(루트)가 승인되지 않아 ${request.purpose}(${request.route.job.role}/${request.route.job.operation})을 열지 않았습니다. ` +
      `승인 대기: ${pending.length ? pending.join(", ") : "선택한 근거 범위"}. 실행 전이라 보존한 결과는 없습니다. 근거 범위를 승인한 뒤 resume 하세요.`;
    this.core.interrupt(request.topic.id, "USER_DECISION_REQUIRED", message, request.expected.state,
      { waitingFor: "mediator", mediatorRequest: message, evidenceRootPending: true });
    throw new HandledWorkflowInterruption();
  }

  private refuse(request: TurnRequest, reason: AdmissionRefused["reason"], message: string): never {
    this.core.event(request.topic.id, "system", "system", `[${request.route.seat}] ${message}`,
      { admissionRefused: reason, purpose: request.purpose, role: request.route.seat, provider: request.route.provider, job: request.route.job });
    throw new AdmissionRefused(reason, message);
  }

  // 모델 호출 — AgentResult 를 돌려주는 턴(논의·교정·확인과 옛 경로). 근거 공백의 이연 주입·리뷰 계속 진행 턴은 없다(D6, ⑥).
  async execute(request: TurnRequest): Promise<TurnOutcome> {
    return this.executeOnce(request);
  }

  // 세션 턴의 공통 입력(AgentResult·결과 봉투 경로 공유) — 래퍼가 읽는 job 유도값, 세션별 메모리 본문 수신, 검토 기준 스냅샷, 허용 검사 훅, 사용량 관측.
  // envelope 이면 planner 계획 폴더(planDirectory)를 싣고, AgentResult 처분 지시는 싣지 않는다.
  private sessionTurn(request: TurnRequest, admit: ReturnType<TurnExecutor["admission"]>,
    options: { envelope?: { planDirectory?: string; onReceived?: EnvelopeTurnRequest["onReceived"] } }) {
    // 래퍼(증거 관리·예산)가 implementation·protocolOnly 를 읽는다 — job 유도값을 함께 싣는다.
    const flags = turnFlags(request.route.job);
    const requested = request.session.mode === "resume" ? request.session.sessionId : null;
    const database = this.core.dependencies.database;
    // 세션별 메모리 본문 수신(E3-4c host-review 39d21df9 F004) — 프로토콜 턴이 만든 세션은 생성 턴에 본문을 받지 않았다(어댑터는 protocolOnly 에 본문을 싣지
    // 않고 resume 에는 매니페스트만 싣는다). 그 세션의 첫 일반 resume 턴에만 본문 1회를 청한다. 기록 없는 세션은 종전 의미(이미 받음)라 청하지 않는다.
    const receipt = requested && !flags.protocolOnly ? database.planning.sessionReceipt(requested) : null;
    const memoryBodies = Boolean(receipt && !receipt.memoryBodies);
    const reviews = request.route.job.role === "reviewer" && (request.route.reviewLedger || ["audit", "closeout", "review", "final-review"].includes(request.route.job.operation));
    // Planning admission and cumulative limits survive participant reassignment within this contract.
    // Its review criteria must survive the same identity change as well.
    const criteriaKey = reviews ? JSON.stringify([request.topic.id, request.route.reviewLedger ?? [request.route.job.operation,
      request.topic.scopeGeneration, request.topic.planEpoch, request.topic.planSHA256, request.route.provider]]) : null;
    const criteriaSnapshot = criteriaKey ? database.sessions.criteria(criteriaKey, request.route.reviewCriteria) : null;
    const criteriaText = flags.protocolOnly ? "" : reviewCriteriaPrompt(criteriaSnapshot?.criteria);
    let lastUsage: TurnUsage | undefined;
    const base = {
      topicId: request.topic.id,
      prompt: request.prompt + criteriaText, freshSessionPrompt: request.freshSessionPrompt === undefined ? undefined : request.freshSessionPrompt + criteriaText, cwd: request.topic.worktreePath, signal: request.signal,
      inputSequence: request.inputSequence,
      job: request.route.job, implementation: flags.implementation,
      // 코드 리뷰 원장 ID(E3-4c) — core.turn 을 지나는 최종 판정 호출도 경로로만 실어 오므로 여기서 턴에 옮긴다. 없는 턴에는 키를 두지 않는다.
      ...(request.route.reviewLedger ? { reviewLedger: request.route.reviewLedger } : {}),
      ...(memoryBodies ? { memoryBodies: true } : {}),
      planMode: request.planMode, protocolOnly: flags.protocolOnly, readablePaths: request.readablePaths,
      consumer: "consensus-engine",
      onExecutionEnvironment: (record: import("../../shared/sessionSettings.js").SessionEnvironment) => database.sessions.observe(request.topic.id, record),
      settings: request.settings, providerOptions: request.route.options, beforeSpawn: admit.async, admitSync: admit.sync,
      onProcessSpawn: ((observe) => (process: Parameters<NonNullable<SessionTurn["onProcessSpawn"]>>[0]) => { observe(process); request.onSpawn?.(); })(this.core.processObserver(request.topic.id)),
      // 사용량은 기존 observer 로 그대로 넘기고(원장·이벤트 기록 유지), 이 호출의 마지막 스냅숏만 따로 잡는다(실패 관측).
      onUsage: ((observe) => (usage: TurnUsage) => { lastUsage = usage; observe(usage); })(request.onUsage ?? this.core.usageObserver(request.topic.id, request.route, request.purpose)),
      ...(options.envelope?.planDirectory ? { planDirectory: options.envelope.planDirectory } : {}),
      ...(options.envelope?.onReceived ? { onEnvelopeReceived: options.envelope.onReceived } : {}),
    };
    // 프로토콜 턴이 만든 세션(생성, 또는 resume 에 CLI 가 다른 id 로 답함)을 만든 즉시 적는다 — 호출자가 그 세션을 저장하기 전이라, 끊겨도 저장된 세션이
    // 기록 없이(= 이미 받은 것으로) 남지 않는다.
    const noteProtocolSession = (id: string) => { if (flags.protocolOnly) database.planning.noteProtocolSession(request.topic.id, id); };
    const receipts = { noteProtocolSession, memoryBodiesFor: memoryBodies ? requested : null };
    const authorContinuity = request.route.seat === "claude" && database.planning.continuityEnabled(request.topic.id);
    return { base, requested, receipts, authorContinuity, lastUsage: () => lastUsage };
  }

  private async executeOnce(request: TurnRequest): Promise<TurnOutcome> {
    this.assertRouteSupported(request);
    const admit = this.admission(request);
    await admit.async();
    const adapter = this.adapter(request.route.provider);
    const { base, requested, receipts, authorContinuity, lastUsage } = this.sessionTurn(request, admit, {});
    const noteProtocolSession = receipts.noteProtocolSession;
    // 이 호출에 답한(답할) 세션 — 새 세션은 어댑터가 알린 id(Claude 는 실행 전 할당, Codex 는 thread.started)다. 검증 안 된 응답을 결과로 바꿀 때 쓴다.
    let answered = requested;
    try {
      if (request.session.mode === "create") {
        const onCreated = request.session.onSessionCreated;
        const created = await invokeAdapter(adapter, { method: "create", turn: { ...base, onSessionCreated: (id: string) => {
          answered = id;
          noteProtocolSession(id);
          onCreated?.(id);
        } } });
        const outcome = await this.settle(request, { sessionId: created.sessionId, result: created.result, created: true }, receipts);
        return outcome;
      }
      const session = request.session;
      const sessionId = session.sessionId;
      const result = await invokeAdapter(adapter, { method: "resume", turn: { ...base, sessionId, onSessionCreated: id => {
        this.assertResumedIdentity(request, authorContinuity, sessionId, id);
        answered = id; session.onSessionCreated?.(id);
      } } });
      const outcome = await this.settle(request, { sessionId, result, created: false }, receipts);
      return outcome;
    } catch (error) {
      // 검증에 실패한 최종 응답(R3) — 결과를 곧바로 계약 검사로 넘기는 호출자에게만, 답한 세션과 함께 결과로 정착시킨다.
      if (error instanceof UnverifiedAgentResult && request.acceptUnverified && answered) {
        return this.settle(request, { sessionId: answered, result: error.raw as unknown as AgentResult, created: answered !== requested }, receipts);
      }
      if (typeof error === "object" && error !== null && !invocationFailures.has(error)) {
        invocationFailures.set(error, { sessionId: requested, seat: request.route.seat, job: request.route.job,
          usage: usageOf(lastUsage()) });
      }
      // 연속성 v2 작성자 좌석의 세션 유실 — 새 세션 없이 멈춘다(기존 계약). 정책이 없으면 원래 오류(session-missing)를 올린다.
      if (requested && authorContinuity && isMissingSessionError(error) && !request.signal.aborted) {
        throw new PlanningPaused("Claude 대화 파일을 찾을 수 없습니다. 새 세션을 생성하지 않고 복구를 기다립니다.");
      }
      throw error;
    }
  }

  // 결과 봉투 턴(계약 v3 (1)·v3.7 (13)·v3.15 (26)(27)) — 같은 허용 검사(봉투 표식)·작성자 좌석 신원 대조·세션 유실 처리를 지나 어댑터 봉투 메서드를 부른다.
  // 응답을 해석·요약하지 않는다. 근거 공백 기록·이연 주입·계속 진행 턴은 없다. 봉투 계약 위반은 답한 세션과 함께 violation 으로 돌려준다.
  async executeEnvelope(request: EnvelopeTurnRequest): Promise<EnvelopeOutcome> {
    this.assertRouteSupported(request);
    const admit = this.admission(request, true);
    await admit.async();
    const adapter = this.adapter(request.route.provider);
    const { base, requested, receipts, authorContinuity, lastUsage } = this.sessionTurn(request, admit,
      { envelope: { planDirectory: request.planDirectory, onReceived: request.onReceived } });
    let answered = requested;
    try {
      if (request.session.mode === "create") {
        const onCreated = request.session.onSessionCreated;
        const created = await invokeAdapter(adapter, { method: "create-envelope", turn: { ...base, onSessionCreated: (id: string) => {
          answered = id;
          receipts.noteProtocolSession(id);
          onCreated?.(id);
        } } });
        return await this.settleEnvelope(request, { sessionId: created.sessionId, envelope: created.envelope, created: true }, receipts);
      }
      const session = request.session;
      const sessionId = session.sessionId;
      const envelope = await invokeAdapter(adapter, { method: "resume-envelope", turn: { ...base, sessionId, onSessionCreated: id => {
        this.assertResumedIdentity(request, authorContinuity, sessionId, id);
        answered = id; session.onSessionCreated?.(id);
      } } });
      return await this.settleEnvelope(request, { sessionId, envelope, created: false }, receipts);
    } catch (error) {
      // 봉투 계약 위반(어댑터 파서의 UnverifiedAgentResult) — 답한 세션과 함께 정착시켜 호출자가 같은 세션에서 교정하게 한다(v3.5 (11)).
      if (error instanceof UnverifiedAgentResult && answered) {
        return this.settleEnvelope(request, { sessionId: answered, created: answered !== requested,
          violation: { raw: error.raw, message: error.message } }, receipts);
      }
      if (typeof error === "object" && error !== null && !invocationFailures.has(error)) {
        invocationFailures.set(error, { sessionId: requested, seat: request.route.seat, job: request.route.job, usage: usageOf(lastUsage()) });
      }
      // 세션 유실 — 봉투 턴은 복구를 위임받지 않는다. 연속성 정책의 작성자 좌석은 새 세션 없이 멈추고, 그 밖은 원래 오류(session-missing)를 올린다(D5 FAILED).
      // 새 세션은 역할 세션 교체(v3.8 (17))로만 연다(v3.15 (27)).
      if (requested && authorContinuity && isMissingSessionError(error) && !request.signal.aborted) {
        throw new PlanningPaused("Claude 대화 파일을 찾을 수 없습니다. 새 세션을 생성하지 않고 복구를 기다립니다.");
      }
      throw error;
    }
  }

  // 봉투 응답 정착: 늦은 응답(다른 행동·세대·상태·취소)은 interrupted-envelope 로 보존하고 던진다(v3.15 (23)) → 세션 수신 기록 → 세션 저장(onEnvelope).
  // 새 입력·계획 변경으로 결과를 보존만 하는 채택 검사는 없다(v3 (1)) — 그 사실은 다음 턴에 전달된다.
  private async settleEnvelope(request: EnvelopeTurnRequest, outcome: EnvelopeOutcome,
    receipts: { noteProtocolSession: (id: string) => void; memoryBodiesFor: string | null }): Promise<EnvelopeOutcome> {
    if (outcome.created) receipts.noteProtocolSession(outcome.sessionId);
    try {
      this.core.assertCurrent(request.topic.id, request.signal, request.expected.scopeGeneration, request.expected.state);
    } catch (error) {
      // 여기서 보존하므로 수신 슬롯(가장 안쪽 래퍼가 알린 같은 봉투)은 비운다 — startAction 의 catch 가 또 남기지 않게(cd2876b7 F008).
      if (outcome.envelope) this.core.releaseReceivedEnvelope(request.topic.id, outcome.envelope);
      await this.core.preserveEnvelope(request.topic, request.route, "interrupted-envelope",
        { sessionId: outcome.sessionId, ...(outcome.envelope ? { envelope: outcome.envelope } : { violation: outcome.violation }) },
        `${request.route.seat} 봉투 턴이 끝나기 전에 실행이 바뀌어 이 결과는 반영하지 않습니다.`);
      throw error;
    }
    if (receipts.memoryBodiesFor && outcome.sessionId === receipts.memoryBodiesFor) {
      this.core.dependencies.database.planning.noteMemoryBodies(receipts.memoryBodiesFor);
    }
    request.onEnvelope?.(outcome);
    return outcome;
  }

  // resume 이 요청한 세션과 다른 id 로 답하면 채택하지 않는다 — 계획 연속성 정책·좌석과 무관한 재개 경계의 규칙이다(Codex Q-e). 저장된 세션은 그대로 두고
  // 기존 정지(PlanningPaused → USER_DECISION_REQUIRED)로 멈춘다. 예외는 없다 — 옛 자동 복구 계보의 짝 기록도 채택 근거가 아니다(새 세션은 중재자의 명시적
  // resume {replaceSession} 으로만 연다). 연속성 정책 작성자 좌석의 변경은 계보에도 남긴다(K1). 배정 변경의 새 세션은 실행 전 core.boundSession 이 정한다.
  private assertResumedIdentity(request: TurnRequest, authorContinuity: boolean, requested: string, returned: string): void {
    if (returned === requested) return;
    if (authorContinuity) this.recordIdentityMismatch(request, requested, returned);
    throw new PlanningPaused(`${request.route.provider === "claude" ? "Claude" : "Codex"}가 다른 세션 ID를 반환했습니다. 기존 세션을 보존하고 중단합니다.`);
  }

  // 신원 변경은 응답을 채택하지 않고(기존 차단) 좌석 계보에 요청·반환 id 를 남긴다. 자동 복구 사유가 아니다(K1). 계획·개정 턴은 계획자 계보, 그 밖은 작업 계보다.
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
    if (current.planEpoch !== expected.planEpoch || current.planSHA256 !== expected.planSHA256) {
      await this.core.preserveInterruptedResult(topic, request.route.seat, result, signal,
        `${request.route.seat} 턴이 도는 동안 계획이 바뀌어(epoch ${expected.planEpoch}→${current.planEpoch}) 이 결과는 채택하지 않습니다.`);
      this.core.interrupt(topic.id, "USER_DECISION_REQUIRED",
        "에이전트가 답하는 동안 계획이 바뀌었습니다. 결과는 보존했습니다 — 같은 단계를 다시 실행해 새 계획을 반영하세요.", expected.state, { planChangedDuringTurn: true });
      throw new HandledWorkflowInterruption();
    }
    if (await this.core.interruptPreservingResult(topic, request.route.seat, result, request.inputSequence, signal)) throw new HandledWorkflowInterruption();
  }
}

// 세션 유실은 어댑터가 관측으로 분류한 코드로만 판정한다(E3-3b) — session-missing 은 분류기가 모델 턴 없음 관측(Claude result num_turns 0, Codex 빈 stdout +
// 정확한 thread/resume 실패 줄)을 필요조건으로 요구한다. 같은 문구를 담은 일반 Error 는 유실이 아니다(unknown 과 같다).
export function isMissingSessionError(error: unknown): boolean {
  return error instanceof AgentRunError && error.code === "session-missing";
}
