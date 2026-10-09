// 구현·리뷰·전달 파이프라인: IMPLEMENTING → CODEX_REVIEW ⇄ CLAUDE_FIX → READY_TO_DELIVER → commit/push.
// 구현·리뷰는 역할별 봉투(message·outcome)를 잇는 왕복(relay)이고, git 사후 검증(고아 커밋 처분 포함)이 이 파일의 인도 계약이다.
import { PlanningPaused } from "../../shared/planningControl.js";
import { DeliveryInputSchema, type TimelineEvent, type Topic, type WorkflowState } from "../../shared/contracts.js";
import { digestToolTrees, type ToolTreeDigest } from "../toolTree.js";
import { assertImplementationGate, implementationStartState, resolveBranchName } from "../../shared/workflow.js";
import { normalizeCommitPaths } from "../git.js";
import type { EngineCore, EnvelopeEvent, EnvelopeNext } from "./core.js";
import { AdmissionRefused, type WriteGuards } from "./turnExecutor.js";
import { parsePlanChecks, type PlanCheckItem } from "../../shared/planChecks.js";
import { planCheckGate, verificationSatisfier, type PlanCheckGateVerdict } from "./planCheckGate.js";
import type { TurnJob } from "../../shared/roles.js";
import { buildFirstTurnPrompt, buildRelayPrompt, relayFactsFrom, type RelayFacts } from "../../shared/prompts.js";
import type { EnvelopeRole, TurnEnvelope, WorkerFact } from "../../shared/turnContract.js";
import type { PreparedMerge, WorkGroup } from "../../shared/workGroups.js";
import { bindingOf, describeBinding, legacyBinding, sameBinding, type SessionBinding, type TurnRoute } from "../turnRouting.js";
import { hierarchyContext } from "../topicStructure.js";

function isWithinSelectedPaths(path: string, selectedPaths: readonly string[]): boolean {
  return selectedPaths.some((scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`));
}

// ---- 구현·리뷰 왕복(relay) 공통 정의 ----
const RELAY_IMPLEMENT_JOB: TurnJob = { role: "implementer", operation: "implement" };
const RELAY_REVIEW_JOB: TurnJob = { role: "reviewer", operation: "review" };

// 구현자·리뷰어에게 주는 계획 — planned 는 승인 계획 정본(필수 검사 선언 포함), ticket 은 남은 계획 묶음의 참고 경로(게이트·검사 근거 아님).
interface RelayPlan {
  status: "approved" | "reference";
  version: string;
  snapshotPath: string;
  checks: PlanCheckItem[];
}

// 구현자 턴의 준비(구현·수정 공통).
interface RelaySetup {
  baselineHead: string;
  toolTreesBefore: ToolTreeDigest;
  plan: RelayPlan | null;
}

// 돌아온 봉투 턴 하나 — 기록(recordEnvelope)에 그대로 넘긴다.
interface RelayTurn {
  topic: Topic;
  route: TurnRoute;
  envelope: TurnEnvelope;
  sessionId: string;
  through: number;
}

// 봉투 결과와 한 transaction 으로 확정하는 중재자 정지(recordEnvelope 의 next).
const relayStop = (message: string, resumeState: WorkflowState): EnvelopeNext =>
  ({ state: "USER_DECISION_REQUIRED", message, changes: { resumeState } });

export class DeliveryPipeline {
  constructor(private readonly core: EngineCore) {}
  // ==== 구현·리뷰 왕복(relay, CR 흐름 단순화 D3·D5) ====
  // IMPLEMENTING → CODEX_REVIEW ⇄ CLAUDE_FIX → READY_TO_DELIVER 를 역할별 봉투(message·outcome)로 잇는다. 엔진은 outcome 만 읽어 다음 상태로 옮기고 상대
  // message 원문과 그 세션이 아직 받지 않은 새 사실만 같은 세션에 싣는다. 지적의 타당성·추가 리뷰·완료 같은 업무 판단은 작업자와 중재자가 한다. 엔진이
  // 지키는 것은 기준 HEAD·브랜치·도구 트리·작업 트리 대조, 계획에 선언된 필수 검사의 실제 실행, 결과 채택 때 소유권·입력 버전 확인(core.turn·recordEnvelope)이다.

  // 구현 시작·재개(IMPLEMENTING). ticket 은 계획·ACK 없이 시작하고, planned 는 승인 계획(approved == current)을 구현자에게 준다.
  async runImplementationRelay(topicId: string, signal: AbortSignal): Promise<void> {
    const database = this.core.dependencies.database;
    let topic = database.getTopic(topicId);
    const resuming = topic.state === "IMPLEMENTING";
    // 재개는 그 모드의 시작 상태(ticket = DRAFT, planned = AWAITING_USER_APPROVAL)에서 게이트를 다시 본다.
    assertImplementationGate(resuming ? { ...topic, state: implementationStartState(topic.workflowMode) } : topic);
    if (!resuming) {
      topic = this.core.transition(topicId, "IMPLEMENTING",
        topic.workflowMode === "planned" ? "Claude가 승인된 계획을 구현합니다." : "구현을 시작합니다.");
    }
    // 실행 전 거부(경로 지원·계획 세션 인계·세션 바인딩)는 IMPLEMENTING 전이 뒤, 브랜치·세션·모델 실행 전에 이 순서로 한다(E2c) — 재개 상태 IMPLEMENTING
    // 으로 멈추고 재개가 같은 판정을 다시 한다. 경로 판정은 공통 검증(core.route)이다.
    const route = this.core.route(topic, RELAY_IMPLEMENT_JOB);
    if (topic.workflowMode === "planned") this.relayHandOffPlanningSession(topic, route);
    if (!topic.branchName) {
      const branchName = resolveBranchName(topic);
      await this.core.dependencies.git.createBranch(topic.worktreePath, branchName);
      this.core.assertCurrent(topicId, signal, topic.scopeGeneration, "IMPLEMENTING");
      // 이 시점의 HEAD가 이 세대 구현의 기준이다. 재시도마다 현재 HEAD를 새 기준으로 잡으면 서버가 중단된 사이 생긴 비인가 커밋이 다음 재시도의
      // '원래 상태'로 둔갑한다(감사 ⑥).
      const implementationBaseOID = await this.core.dependencies.git.head(topic.worktreePath);
      database.updateTopic(topicId, { branchName, implementationBaseOID });
    }
    await this.relayImplementer(topicId, signal);
  }

  // 멈춘 단계의 재개 — 같은 역할의 다음 턴을 연다. 그 사이 올라온 결정·증거·원문 변경은 새 사실로 실린다.
  async resumeDeliveryRelay(topicId: string, state: WorkflowState, signal: AbortSignal): Promise<void> {
    if (state === "IMPLEMENTING") return this.runImplementationRelay(topicId, signal);
    if (state === "CLAUDE_FIX") {
      this.core.requireState(topicId, "CLAUDE_FIX");
      return this.relayImplementer(topicId, signal);
    }
    if (state === "CODEX_REVIEW") return this.relayReviewEntry(topicId, signal);
    throw new Error(`지원하지 않는 재개 단계입니다: ${state}`);
  }

  // planned 의 계획 세션 인계 — 토픽의 연속성 정책이 켜져 있을 때만 승인 계획을 쓴 계획 세션을 구현 세션으로 결속한다(이미 결속된 구현 세션은 그대로
  // 이어 쓴다). 계획 세션을 확인할 수 없거나 다른 공급자·참여자의 구현 경로면 새 세션을 만들지 않고 멈춘다.
  private relayHandOffPlanningSession(topic: Topic, route: TurnRoute): void {
    const database = this.core.dependencies.database;
    if (!database.planning.continuityEnabled(topic.id)) return;
    const planningSession = database.planning.boundSession(topic);
    const saved = database.getFlags(topic.id).implementationSessionId;
    if (!planningSession || (saved && saved !== planningSession.sessionId)) {
      throw new PlanningPaused("승인 계획과 연결된 Claude 세션을 확인할 수 없습니다. 새 세션을 만들지 않고 중재를 기다립니다.");
    }
    if (saved) return;
    const authorBinding = database.participantBinding(topic.id, "claude") ?? legacyBinding("claude");
    if (!sameBinding(authorBinding, route)) this.refuseSessionBinding(topic.id, "계획", planningSession.sessionId, authorBinding, route);
    database.setImplementationSession(topic.id, planningSession.sessionId, authorBinding);
  }

  // 계획 연속성 정책의 세션을 다른 바인딩의 경로로 넘기지 않는다 — 새 세션으로 바꾸지도 않고 멈춘다(core.reboundSeatSession 의 작성자 좌석 규칙과 같다).
  private refuseSessionBinding(topicId: string, label: string, sessionId: string, stored: SessionBinding, route: TurnRoute): never {
    const message = `${label} 세션 ${sessionId}(${describeBinding(stored)})은 이 턴의 경로 ${describeBinding(route)} 와 공급자·참여자가 달라 이어 쓸 수 없습니다. `
      + "계획 연속성 정책은 계획 세션을 구현까지 이어 써야 해서 새 세션을 열지 않고 멈춥니다 — 배정을 되돌리거나 연속성 정책을 끈 뒤 재개하세요.";
    this.core.event(topicId, "system", "system", message,
      { admissionRefused: "session-binding", seat: route.seat, previous: { sessionId, binding: stored }, next: bindingOf(route) });
    throw new AdmissionRefused("session-binding", message);
  }

  // ---- 구현자 턴(구현·수정 공통, D3) ----
  // 상대 message 원문과 새 사실을 같은 구현 세션에 싣고 outcome 만 읽는다:
  //   done → 승인 계획이 checks 를 선언했으면 엔진이 이 작업 트리에서 실행한다. 통과면 CODEX_REVIEW, 실패면 그 결과를 사실로 남기고 같은 세션에서 다음 턴
  //          (같은 입력으로 다시 실패하면 중재자 정지 — 같은 조건의 반복은 진척이 아니다), 판정 불가(호스트 문제)면 중재자 정지.
  //   continue → 같은 세션·같은 상태로 다음 턴. needs-mediator → USER_DECISION_REQUIRED(재개 = 같은 상태).
  // 기록과 다음 전이는 recordEnvelope 한 transaction 이다 — 끊긴 뒤 재개해도 같은 결과가 두 번 기록되거나 전이 없이 남지 않는다.
  private async relayImplementer(topicId: string, signal: AbortSignal): Promise<void> {
    const database = this.core.dependencies.database;
    const setup = await this.relayPrepareWork(topicId, signal);
    let continued = false;
    for (;;) {
      const topic = database.getTopic(topicId);
      const state = topic.state;
      if (state !== "IMPLEMENTING" && state !== "CLAUDE_FIX") throw new Error(`구현자 턴을 열 수 없는 상태입니다: ${state}`);
      const work: TurnJob = { role: "implementer", operation: state === "CLAUDE_FIX" ? "fix" : "implement" };
      // 계속 진행은 부속 턴이다(host-review F003) — 지금 작업(implement·fix)의 배정·설정·세션으로 열고 job 만 continue 로 바꾼다.
      const job: TurnJob = continued ? { role: "implementer", operation: "continue" } : work;
      const turn = await this.relayTurn(topic, job, "implementer", signal, {
        parent: work,
        plan: setup.plan,
        writeGuards: { requireApprovedPlan: topic.workflowMode === "planned", baselineHead: setup.baselineHead, toolTreeBaseline: setup.toolTreesBefore },
        persist: (sessionId, route) => database.setImplementationSession(topicId, sessionId, bindingOf(route)),
      });
      const violation = await this.relayIntegrityViolation(topic, setup);
      if (violation) {
        await this.relayRecord(turn, signal, relayStop(violation, state));
        return;
      }
      const { envelope } = turn;
      if (envelope.outcome === "continue") {
        await this.relayRecord(turn, signal);
        continued = true;
        continue;
      }
      if (envelope.outcome === "needs-mediator") {
        await this.relayRecord(turn, signal, relayStop(envelope.mediatorRequest?.trim() || envelope.message, state));
        return;
      }
      if (envelope.outcome !== "done") throw new Error(`구현자 봉투의 outcome 을 처리할 수 없습니다: ${envelope.outcome}`);
      const checks = await this.relayPlanChecks(topic, setup.plan, signal);
      if (checks && checks.verdict.kind === "unavailable") {
        await this.relayRecord(turn, signal, { ...relayStop(`계획 필수 검사를 이 호스트에서 판정하지 못해 구현자의 완료를 리뷰로 넘기지 않았습니다 — ${checks.details}. `
          + "구현자 응답은 결과 기록(agent_output)에, 검사 결과는 check-result 사실로 보존했습니다. 호스트 도구·검사 프로필을 확인한 뒤 재개하면 같은 구현자 세션이 이어서 받습니다.", state), events: [checks.event] });
        return;
      }
      if (checks && checks.verdict.kind === "unsatisfied") {
        if (this.relayRepeatedCheckFailure(topic, checks.verdict.inputKey)) {
          await this.relayRecord(turn, signal, { ...relayStop(`계획 필수 검사가 직전 실패와 같은 입력(검사 대상이 바뀌지 않음)으로 다시 실패했습니다 — ${checks.details}. `
            + "구현자 응답은 결과 기록(agent_output)에, 검사 결과는 check-result 사실로 보존했습니다. 결정(고칠 방향·검사 선언 변경 등)을 남기고 재개하면 같은 구현자 세션이 그 결정과 검사 결과를 받습니다.", state), events: [checks.event] });
          return;
        }
        // 실패 사실(check-result)은 다음 구현자 턴의 새 사실로 실린다 — 전이 없이 봉투 기록과 사실을 한 transaction 으로 남긴다.
        await this.relayRecord(turn, signal, { events: [checks.event] });
        continued = true;
        continue;
      }
      await this.relayRecord(turn, signal, { state: "CODEX_REVIEW", message: "Codex가 구현 결과를 읽기 전용으로 검토합니다.", ...(checks ? { events: [checks.event] } : {}) });
      return this.relayReview(topicId, signal, setup.baselineHead);
    }
  }

  // 구현자 턴의 준비(구현·수정 공통) — 브랜치·고정된 기준 HEAD·도구 트리 기준·계획 문맥.
  private async relayPrepareWork(topicId: string, signal: AbortSignal): Promise<RelaySetup> {
    const topic = this.core.dependencies.database.getTopic(topicId);
    if (!topic.branchName) throw new Error("작업 브랜치가 없습니다.");
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName);
    const baselineHead = await this.requirePinnedBaseline(topicId, topic.worktreePath);
    // 도구 트리 기준은 산출물(tool-tree-baseline)이다 — 감지된 변경은 중재자가 재동기화 뒤 rebaseline 하기 전까지 재시도로 통과하지 않는다(F04).
    const toolTreesBefore = await this.toolTreeBaseline(topic, signal);
    this.assertToolTreesIntact(topic, toolTreesBefore, "재개 전");
    return { baselineHead, toolTreesBefore, plan: await this.relayPlanContext(topic) };
  }

  // 계획 문맥 — planned 는 sha 로 검증한 승인 계획 정본과 그 checks 선언, ticket 은 남은 계획 묶음의 현재 판(참고 경로만, 필수 검사 없음).
  private async relayPlanContext(topic: Topic): Promise<RelayPlan | null> {
    if (topic.workflowMode === "planned") {
      const { content, path } = await this.core.requireCurrentPlanArtifact(topic.id);
      return { status: "approved", version: topic.approvedPlanSHA256 ?? topic.planSHA256 ?? "", snapshotPath: path, checks: parsePlanChecks(content) };
    }
    const reference = await this.core.planBundle.current(topic);
    return reference ? { status: "reference", version: reference.version, snapshotPath: reference.snapshotPath, checks: [] } : null;
  }

  // 턴 뒤 작업 트리 무결성 — 러너가 브랜치를 바꿨거나, 커밋을 만들었거나(기준 HEAD 이동), 앱 밖 도구 트리를 바꿨으면 중재자 정지 문구(막힌 것·근거·
  // 보존한 위치·다음 행동), 아니면 null. 구현자 응답은 정지와 한 transaction 으로 봉투 기록에 남는다.
  private async relayIntegrityViolation(topic: Topic, setup: RelaySetup): Promise<string | null> {
    const git = this.core.dependencies.git;
    const kept = "구현자 응답은 이 턴의 결과 기록(agent_output)에, 작업 트리 변경은 그대로 보존했습니다.";
    try {
      await git.assertCurrentBranch(topic.worktreePath, topic.branchName!);
    } catch (error) {
      return `구현자 턴 중 작업 브랜치가 바뀌었습니다 — ${error instanceof Error ? error.message : String(error)}. ${kept} `
        + `작업 브랜치(${topic.branchName})로 되돌린 뒤 재개하세요.`;
    }
    const head = await git.head(topic.worktreePath);
    if (head !== setup.baselineHead) {
      return `구현자 턴 중 승인되지 않은 git commit 이 생겼습니다 — HEAD ${head.slice(0, 12)}, 구현 기준 ${setup.baselineHead.slice(0, 12)}. ${kept} `
        + "커밋 내용을 확인하고 기준으로 되돌린(파일 변경은 남김) 뒤 재개하세요.";
    }
    const after = digestToolTrees(topic.worktreePath);
    if (after.sha256 !== setup.toolTreesBefore.sha256) {
      return `구현자 턴 중 앱 밖 도구 트리가 기준과 달라졌습니다 — 파일 ${setup.toolTreesBefore.files} → ${after.files}, `
        + `${setup.toolTreesBefore.sha256.slice(0, 12)} → ${after.sha256.slice(0, 12)}(${after.directories.join(", ") || "-"}). 러너는 앱 코드만 고칩니다. ${kept} `
        + "tools_sync 로 되돌리고 tool-tree-rebaseline 으로 기준을 갱신한 뒤 재개하세요.";
    }
    return null;
  }

  // ---- 계획 필수 검사(planned 승인 계획의 ```checks 선언이 있을 때만) ----
  // 엔진이 이 작업 트리에서 실제로 실행하고, 결과를 check-result 사실(system 이벤트의 payload.workerFact)로 만든다 — 구현자에게는 실패, 리뷰어에게는
  // 영수증으로 새 사실 커서가 싣는다. 반복 실패 판정용 입력 해시(planCheckInput)는 workerFact 밖에 둔다.
  private async relayPlanChecks(topic: Topic, plan: RelayPlan | null, signal: AbortSignal): Promise<{
    verdict: PlanCheckGateVerdict; details: string; event: EnvelopeEvent;
  } | null> {
    if (!plan || plan.status !== "approved" || plan.checks.length === 0) return null;
    const verifications = this.core.dependencies.verifications;
    const verdict = await planCheckGate(plan.checks, {
      verification: verificationSatisfier(verifications ? (profileId, gateSignal) => verifications.ensure(topic.id, profileId, gateSignal) : undefined),
    }, signal);
    const failures = verdict.kind === "satisfied" ? [] : verdict.failures;
    // 사실은 항목별 실제 결과다 — 집계(verdict.kind)는 아래 상태 전이만 정한다. 실행 불가가 섞여도 실패한 항목은 failed 로 남는다(79fc4fc5 F006).
    const status = { satisfied: "passed", unsatisfied: "failed", unavailable: "not-run" } as const;
    const checks: Extract<WorkerFact, { kind: "check-result" }>["checks"] = verdict.results.map((result) =>
      ({ id: result.item.id, status: status[result.status], summary: result.detail }));
    const details = failures.length ? failures.map((failure) => failure.detail).join(" / ") : "모두 통과";
    return { verdict, details, event: {
      actor: "system", kind: "system",
      body: `계획 필수 검사 결과: ${checks.map((check) => `${check.id} ${check.status}`).join(", ")}`,
      payload: { workerFact: { kind: "check-result", checks }, ...(verdict.kind === "unsatisfied" ? { planCheckInput: verdict.inputKey } : {}) },
    } };
  }

  // 직전 검사 결과가 같은 입력으로 실패했는가 — 그 사이 통과한 검사 결과가 있으면 반복이 아니다.
  private relayRepeatedCheckFailure(topic: Topic, inputKey: string): boolean {
    const previous = this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration)
      .findLast((event) => event.actor === "system" && (event.payload?.workerFact as { kind?: unknown } | undefined)?.kind === "check-result");
    return previous?.payload?.planCheckInput === inputKey;
  }

  // ---- 두 번째 리뷰 진입(재개·재진입, cd2876b7 F015·F016) ----
  // 구현자 done 경로를 거치지 않고 리뷰를 다시 여는 진입(정지된 리뷰의 재개·사용 한도 자동 재시도·인도 대기 재진입)도 done 경로와 같은 수락 경계를 지난다:
  // 허용 HEAD(구현 기준 또는 공식 확정 커밋)와 승인 계획의 필수 검사(planCheckGate 계약 그대로 — 통과면 영수증을 남기고 리뷰, 실패면 같은 구현 세션의
  // 수정 턴, 같은 입력의 반복 실패·판정 불가면 검사 사실과 함께 중재자 정지). 같은 입력의 성공은 verifications.ensure 가 재사용한다.
  private async relayReviewEntry(topicId: string, signal: AbortSignal): Promise<void> {
    const topic = this.core.requireState(topicId, "CODEX_REVIEW");
    const baselineHead = await this.requirePinnedBaseline(topicId, topic.worktreePath);
    const checks = await this.relayPlanChecks(topic, await this.relayPlanContext(topic), signal);
    if (checks && checks.verdict.kind === "unavailable") {
      const message = `계획 필수 검사를 이 호스트에서 판정하지 못해 리뷰를 열지 않았습니다 — ${checks.details}. 검사 결과는 check-result 사실로 보존했습니다. `
        + "호스트 도구·검사 프로필을 확인한 뒤 재개하면 검사부터 다시 합니다.";
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", message, "CODEX_REVIEW", { waitingFor: "mediator", mediatorRequest: message }, undefined, [checks.event]);
      return;
    }
    if (checks && checks.verdict.kind === "unsatisfied") {
      if (this.relayRepeatedCheckFailure(topic, checks.verdict.inputKey)) {
        const message = `계획 필수 검사가 직전 실패와 같은 입력(검사 대상이 바뀌지 않음)으로 다시 실패해 리뷰를 열지 않았습니다 — ${checks.details}. `
          + "검사 결과는 check-result 사실로 보존했습니다. 결정(고칠 방향·검사 선언 변경 등)을 남기고 재개하면 같은 구현자 세션이 그 결정과 검사 결과를 받습니다.";
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", message, "CLAUDE_FIX", { waitingFor: "mediator", mediatorRequest: message }, undefined, [checks.event]);
        return;
      }
      // 실패 사실(check-result)은 같은 구현 세션의 다음 턴에 새 사실로 실린다 — 리뷰 changes 뒤 흐름과 같다.
      this.core.transitionWith(topicId, "CLAUDE_FIX", "계획 필수 검사가 리뷰 전에 실패해 Claude가 실패 내용을 반영합니다.",
        { events: [{ ...checks.event, state: "CLAUDE_FIX" }] });
      return this.relayImplementer(topicId, signal);
    }
    if (checks) this.core.event(topicId, checks.event.actor, checks.event.kind, checks.event.body, checks.event.payload);
    return this.relayReview(topicId, signal, baselineHead);
  }

  // ---- 코드 리뷰 턴(CODEX_REVIEW, D3) ----
  // 구현자 message 원문과 새 사실(검사 영수증 포함)을 같은 코드 리뷰 세션에 싣는다. 리뷰 시작 전 작업 트리를 고정하고, 돌아온 뒤 바뀌었으면 결과를 기록한
  // 채 중재자에게 넘긴다. changes → CLAUDE_FIX(리뷰어 message 를 구현자에게 그대로), approve → 리뷰한 트리 = 현재 트리이므로 READY_TO_DELIVER,
  // needs-mediator → USER_DECISION_REQUIRED(재개 = CODEX_REVIEW).
  // expectedHead 는 두 진입이 검사 전에 확인한 허용 HEAD(구현 기준 또는 공식 확정 커밋)다 — 검사 대기 중 서버 밖에서 생긴 커밋은 검사 입력이 같으면 검사를
  // 통과하므로, 리뷰가 채택할 실제 HEAD 가 그 값과 다르면 작업 트리 기록·리뷰 원장·모델 호출 전에 멈춘다(715f7e2e F016).
  private async relayReview(topicId: string, signal: AbortSignal, expectedHead: string): Promise<void> {
    const database = this.core.dependencies.database;
    const git = this.core.dependencies.git;
    const topic = this.core.requireState(topicId, "CODEX_REVIEW");
    const reviewRoute = this.core.route(topic, RELAY_REVIEW_JOB);
    const reviewed = await git.snapshot(topic.worktreePath);
    if (reviewed.head !== expectedHead) {
      throw new Error(`리뷰 기준 HEAD(${reviewed.head.slice(0, 12)})가 검사 전에 확인한 구현 기준(${expectedHead.slice(0, 12)})과 다릅니다. 서버 밖에서 생긴 커밋을 먼저 처분해 주세요.`);
    }
    const reviewedTree = await git.writeWorkingTree(topic.worktreePath, `${topicId.slice(0, 8)}-review`).catch(() => null);
    // 코드 리뷰 원장 — 같은 검토 tree·같은 구현 보고에 대한 재시도·재개는 리뷰 1회로 센다(회차 한도는 사용자 설정).
    const ledger = database.planning.openReviewLedger({ topicId, kind: "codex-review", scopeGeneration: topic.scopeGeneration,
      planEpoch: topic.planEpoch, planSHA256: topic.planSHA256, reviewedTree: reviewedTree ?? JSON.stringify(reviewed),
      reportRevision: this.relayLatestEnvelope(topic, "implementer")?.sequence ?? 0 });
    const turn = await this.relayTurn(topic, RELAY_REVIEW_JOB, "code-reviewer", signal, {
      plan: await this.relayPlanContext(topic), ledger: ledger.id,
      persist: (sessionId) => database.setCodexReviewSession(topicId, sessionId, bindingOf(reviewRoute)),
    });
    const after = await git.snapshot(topic.worktreePath);
    const snapshot = { reviewedHead: reviewed.head, reviewedDiffSHA256: reviewed.diffSHA256, reviewedTreeOID: reviewedTree };
    const { envelope } = turn;
    if (reviewed.head !== after.head || reviewed.diffSHA256 !== after.diffSHA256) {
      await this.relayRecord(turn, signal, relayStop(`코드 리뷰 중 작업 트리가 바뀌었습니다 — 리뷰 시작 ${reviewed.head.slice(0, 12)}/${reviewed.diffSHA256.slice(0, 12)}, 리뷰 뒤 ${after.head.slice(0, 12)}/${after.diffSHA256.slice(0, 12)}. `
        + "리뷰 응답은 결과 기록(agent_output)에 보존했지만 리뷰한 트리와 현재 트리가 달라 채택하지 않았습니다. 변경 원인을 확인한 뒤 재개하면 같은 리뷰 세션이 현재 트리를 다시 리뷰합니다.", "CODEX_REVIEW"));
    } else if (envelope.outcome === "changes") {
      await this.relayRecord(turn, signal, { state: "CLAUDE_FIX", message: "Claude가 리뷰 응답을 반영합니다.", changes: snapshot });
    } else if (envelope.outcome === "approve") {
      // 확정 커밋(push)이 지금 HEAD 그대로면 보존한다 — 커밋 뒤 새 결정을 다시 리뷰한 경우 인도 사슬(deliveryBase)이 그 커밋에서 이어진다(host-review
      // 2026-09-21 R3). HEAD 가 다르면 그 커밋은 더 이상 인도 기준이 아니므로 지운다.
      const flags = database.getFlags(topicId);
      await this.relayRecord(turn, signal, { state: "READY_TO_DELIVER", message: "코드 리뷰가 현재 작업 트리를 승인했습니다.", changes: { ...snapshot,
        committedOID: flags.committedOID && flags.committedOID === reviewed.head ? flags.committedOID : null,
        pushedOID: flags.pushedOID && flags.pushedOID === reviewed.head ? flags.pushedOID : null } });
    } else if (envelope.outcome === "needs-mediator") {
      await this.relayRecord(turn, signal, relayStop(envelope.mediatorRequest?.trim() || envelope.message, "CODEX_REVIEW"));
    } else {
      throw new Error(`리뷰어 봉투의 outcome 을 처리할 수 없습니다: ${envelope.outcome}`);
    }
    // 판정에 도달한 리뷰는 원장을 닫고, 중재자를 기다리는 리뷰는 원장을 멈춰 둔다(재개가 같은 원장으로 잇는다).
    if (envelope.outcome === "needs-mediator") database.planning.pauseReviewLedger(ledger.id);
    else database.planning.completeReviewLedger(ledger.id);
    if (database.getTopic(topicId).state === "CLAUDE_FIX") await this.relayImplementer(topicId, signal);
  }

  // ---- 왕복 턴 공통 ----
  // 좌석 세션 → 새 사실(pendingFacts)·상대 봉투 원문 → 프롬프트 → 봉투 턴(core.turn). 그 역할의 봉투 기록이 아직 없는 세션(새 세션·옛 흐름 세션·연속성
  // 인계 세션)은 역할 지침이 든 첫 턴 프롬프트를 받고, 기록이 있는 세션은 상대 원문과 새 사실만 받는다(D5). 사실은 그 세션이 받은 커서 뒤만 싣는다.
  // 부속 턴(parent 가 있으면)은 부모 작업의 경로를 풀고 job 만 바꾼다 — 실제 실행과 표시 경로(routingView)가 같은 배정이다(turnRouting INHERITING_OPERATIONS).
  private async relayTurn(topic: Topic, job: TurnJob, role: EnvelopeRole, signal: AbortSignal, input: {
    parent?: TurnJob; plan: RelayPlan | null; writeGuards?: WriteGuards; ledger?: string; persist: (sessionId: string, route: TurnRoute) => void;
  }): Promise<RelayTurn> {
    const route = input.parent && input.parent !== job ? { ...this.core.route(topic, input.parent), job } : this.core.route(topic, job);
    const sessionId = this.core.seatSession(topic, route);
    const pending = this.core.pendingFacts(topic, role, sessionId);
    const facts: RelayFacts = { ...relayFactsFrom(pending.facts), counterpart: this.relayCounterpart(topic, role, pending.since) };
    const plan = input.plan ? { status: input.plan.status, version: input.plan.version, snapshotPath: input.plan.snapshotPath } : null;
    const first = buildFirstTurnPrompt({
      ...facts, role, title: topic.title, task: hierarchyContext(this.core.dependencies.database, topic), worktreePath: topic.worktreePath, branchName: topic.branchName,
      baseRef: this.core.dependencies.database.getFlags(topic.id).implementationBaseOID,
      // 이 단계의 계획 정본은 파이프라인이 정한 문맥(approved·reference)이다 — 첫 턴에 실리는 계획 왕복 때의 판 알림(current)이 그것을 덮지 않는다.
      plan: plan ?? facts.plan,
    });
    const relay = sessionId !== null && this.relayLatestEnvelope(topic, role, sessionId) !== null;
    const turnRoute: TurnRoute = input.ledger ? { ...route, reviewLedger: input.ledger } : route;
    const outcome = await this.core.turn(turnRoute, topic, relay ? buildRelayPrompt(facts) : first, signal, {
      resultContract: "envelope",
      session: { id: sessionId, persist: (id: string) => input.persist(id, route) },
      ...(relay ? { freshSessionPrompt: first } : {}),
      readablePaths: input.plan ? [input.plan.snapshotPath] : [],
      ...(input.writeGuards ? { writeGuards: input.writeGuards } : {}),
      inputSequence: pending.through,
    });
    return { topic, route: turnRoute, envelope: outcome.envelope, sessionId: outcome.sessionId, through: pending.through };
  }

  // 봉투 기록 — 다음 전이(next)가 있으면 기록과 한 transaction 이다(core.recordEnvelope).
  private async relayRecord(turn: RelayTurn, signal: AbortSignal, next?: EnvelopeNext): Promise<TimelineEvent> {
    return this.core.recordEnvelope(turn.topic, turn.route, turn.envelope,
      { sessionId: turn.sessionId, deliveredThrough: turn.through, ...(next ? { next } : {}) }, signal);
  }

  // 역할의 마지막 봉투 기록(현재 범위 세대, sessionId 를 주면 그 세션의 것만).
  private relayLatestEnvelope(topic: Topic, role: EnvelopeRole, sessionId?: string): TimelineEvent | null {
    return this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration).findLast((event) => event.kind === "agent_output"
      && (event.payload?.envelope as { role?: unknown } | undefined)?.role === role && (sessionId === undefined || event.payload?.sessionId === sessionId)) ?? null;
  }

  // 상대 봉투 원문 — 이 역할 세션이 마지막으로 받은 커서(since) 뒤에 기록된 상대 역할의 마지막 봉투 message.
  private relayCounterpart(topic: Topic, role: EnvelopeRole, since: number): RelayFacts["counterpart"] {
    const other: EnvelopeRole = role === "implementer" ? "code-reviewer" : "implementer";
    const event = this.relayLatestEnvelope(topic, other);
    return event && event.sequence > since ? { role: other, message: event.body } : null;
  }

  // 도구 트리 기준 산출물(tool-tree-baseline, 세대별). 없으면 지금 지문을 첫 기준으로 쓴다. 감지된 변경은 중재자가 재동기화 뒤
  // rebaseline 액션으로만 새 기준이 된다 — 재시도가 현재 디스크를 기준으로 다시 잡지 않는다(F04).
  private async toolTreeBaseline(topic: Topic, signal: AbortSignal): Promise<ToolTreeDigest> {
    const db = this.core.dependencies.database;
    const latest = db.latestArtifact(topic.id, "tool-tree-baseline");
    if (latest && latest.scopeGeneration === topic.scopeGeneration) {
      const raw = await this.core.dependencies.artifacts.readLatest(topic.id, "tool-tree-baseline");
      if (raw) {
        const record = JSON.parse(raw) as { digest?: ToolTreeDigest };
        if (record.digest?.sha256) return record.digest;
      }
    }
    return this.writeToolTreeBaseline(topic, signal, "첫 구현 턴의 도구 트리 지문");
  }

  async writeToolTreeBaseline(topic: Topic, _signal: AbortSignal, reason: string): Promise<ToolTreeDigest> {
    const digest = digestToolTrees(topic.worktreePath);
    const revision = (this.core.dependencies.database.latestArtifact(topic.id, "tool-tree-baseline")?.revision ?? 0) + 1;
    // 실행(action) 밖에서도 쓴다(rebaseline 액션) — action 현재성 가드가 있는 core.writeArtifact 대신 저장소에 직접 쓴다.
    await this.core.dependencies.artifacts.write(topic.id, "tool-tree-baseline", revision, JSON.stringify({
      kind: "tool-tree-baseline", scopeGeneration: topic.scopeGeneration, reason, digest, at: new Date().toISOString(),
    }, null, 2), { scopeGeneration: topic.scopeGeneration });
    this.core.event(topic.id, "system", "system", `도구 트리 기준 #${revision} — ${reason} (파일 ${digest.files}, ${digest.sha256.slice(0, 12)})`,
      { toolTreeBaseline: { revision, sha256: digest.sha256, files: digest.files } });
    return digest;
  }

  // 단계 도구 트리(gitignore 된 DerivedData/*-logs/{scripts,…})가 기준과 다르면 턴을 실패시킨다 — git 변경 목록은 ignored 파일을 보지
  // 않으므로 별도 대조(R02). 중재자가 tools_sync 로 되돌린 뒤 tool-tree-rebaseline 액션으로 기준을 갱신하고 retry 한다.
  private assertToolTreesIntact(topic: Topic, baseline: ToolTreeDigest, phase: string): void {
    const after = digestToolTrees(topic.worktreePath);
    if (after.sha256 === baseline.sha256) return;
    this.core.event(topic.id, "system", "system",
      `도구 트리가 기준과 다릅니다(${phase}: 파일 ${baseline.files} → ${after.files}, ${baseline.sha256.slice(0, 12)} → ${after.sha256.slice(0, 12)}) — 러너는 앱 코드만 고친다. 중재자가 tools_sync 로 되돌린 뒤 tool-tree-rebaseline 으로 기준을 갱신하고 재시도한다.`,
      { toolTreeDrift: { baseline: baseline.sha256, after: after.sha256, directories: after.directories } });
    throw new Error(`도구 트리가 기준과 다릅니다(${phase}) — 러너 권한 밖. 재동기화 + tool-tree-rebaseline 뒤 재시도.`);
  }

  // 브랜치 생성 시점에 고정한 기준 HEAD를 돌려준다. 현재 HEAD가 기준과 다르면 서버 밖에서 커밋이
  // 생긴 것이므로 그것을 기준으로 승격하지 않고 멈춘다 — 사용자가 discard-orphan-commit이나 직접
  // 확인으로 처분해야 한다(감사 ⑥). 예외는 공식 commit 으로 확정한 커밋(committedOID)이다 — 엔진이 부모·내용·경로를 확인한 인도 사슬의 끝이므로,
  // HEAD 가 그 커밋이면 구현 기준은 그대로 두고 그 커밋을 이번 턴의 기준으로 쓴다(확정 뒤 재진입·재개, F009).
  private async requirePinnedBaseline(topicId: string, worktreePath: string): Promise<string> {
    const flags = this.core.dependencies.database.getFlags(topicId);
    const pinned = flags.implementationBaseOID;
    const head = await this.core.dependencies.git.head(worktreePath);
    if (!pinned) {
      // 이 컬럼이 생기기 전에 시작한 주제의 이행 경로: 지금 HEAD를 기준으로 고정한다.
      this.core.dependencies.database.updateTopic(topicId, { implementationBaseOID: head });
      return head;
    }
    if (head !== pinned && flags.committedOID && head === flags.committedOID) return flags.committedOID;
    if (head !== pinned) {
      throw new Error(`현재 HEAD(${head.slice(0, 12)})가 구현 기준(${pinned.slice(0, 12)})과 다릅니다. 서버 밖에서 생긴 커밋을 먼저 처분해 주세요.`);
    }
    return pinned;
  }

  async commit(topicId: string, message: string, paths: string[], idempotencyKey?: string): Promise<string> {
    return this.withDeliveryLock(topicId, async (topic) => {
      if (!topic.branchName) throw new Error("커밋할 작업 브랜치가 없습니다.");
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.reviewedHead || !flags.reviewedDiffSHA256) throw new Error("최종 리뷰가 확인한 변경 스냅샷이 없습니다.");
      // 인도 커밋은 사슬을 이룰 수 있다(S11 계획 C1 소스 → C2 flip → C3 문서, [d02] S11-A03; 2026-09-21): 다음 커밋의 기준 HEAD 와 부모는
      // **마지막 확정 커밋**(없으면 리뷰 HEAD)이고, 내용 불변은 **리뷰 HEAD 기준** diff 해시로 본다 — 커밋은 파일을 바꾸지 않으므로 리뷰가 본
      // 변경 집합(작업 트리 vs 리뷰 HEAD)은 사슬 내내 같다. 이전엔 기준이 리뷰 HEAD 로 고정돼 두 번째 커밋부터 "worktree 가 바뀌었다" 로 거부됐다.
      const deliveryBase = flags.committedOID ?? flags.reviewedHead;
      // 합류 병합을 준비한 작업 묶음 단계의 첫 인도 커밋은 엔진이 만드는 병합 커밋이다(E4 보완 F001).
      const preparedMerge = flags.committedOID ? null : this.stagePreparedMerge(topicId);
      if (preparedMerge) return this.commitStageMerge(topic, flags, preparedMerge, message, paths, idempotencyKey);
      // 경로 없는 커밋은 파일 차이가 없는 합류 병합 커밋에만 있다(E4 2차 보완 F001) — 일반 커밋은 고른 경로가 있어야 한다.
      if (paths.length === 0) throw new Error("커밋할 경로를 하나 이상 고르세요.");
      // stage와 사후 검증이 같은 정규화 결과를 봐야 한다. 다르면 커밋은 남고 기록은 없는 고아 커밋이 생긴다.
      const selectedPaths = normalizeCommitPaths(topic.worktreePath, paths);
      const current = await this.core.dependencies.git.snapshot(topic.worktreePath, flags.reviewedHead);
      if (current.head !== deliveryBase || current.diffSHA256 !== flags.reviewedDiffSHA256) {
        throw new Error("최종 리뷰 뒤 worktree가 바뀌었습니다. 다시 리뷰해야 커밋할 수 있습니다.");
      }
      // 요청의 시작 HEAD 를 실행 **전에** 요청 좌표로 남긴다 — 서버가 확정 기록(committedOID)과 요청 완료(ledger.finish) 사이에 죽어도, 복구는
      // "이 요청이 그 HEAD 위에 새 커밋을 만들었는가" 를 좌표로 판정한다(메시지 대조는 git 의 공백 정리와 같은 메시지 재사용에 깨진다 — host-review R1·R2).
      if (idempotencyKey) {
        this.core.dependencies.database.annotateActionRequest(topicId, "commit", idempotencyKey, { parent: deliveryBase });
      }
      const evidenceInput = this.core.dependencies.database.evidence.captureForCommit(topic);
      if (idempotencyKey) this.core.dependencies.database.annotateActionRequest(topicId,"commit",idempotencyKey,{ evidenceNonce: evidenceInput });
      const oid = await this.core.dependencies.git.commit(topic.worktreePath, topic.branchName, message, paths);
      this.core.dependencies.database.evidence.bindCommitInput(topic,evidenceInput,oid);
      this.assertDeliverySnapshot(topic);
      if (await this.core.dependencies.git.commitParent(topic.worktreePath, oid) !== deliveryBase) {
        this.rejectOrphanCommit(topicId, oid, "생성된 커밋의 부모가 최종 리뷰 기준과 다릅니다.");
      }
      const afterCommit = await this.core.dependencies.git.snapshot(topic.worktreePath, flags.reviewedHead);
      if (afterCommit.diffSHA256 !== flags.reviewedDiffSHA256) {
        this.rejectOrphanCommit(topicId, oid, "커밋 도중 파일 내용이 최종 리뷰 결과와 달라졌습니다.");
      }
      const committedPaths = await this.core.dependencies.git.commitChangedPaths(topic.worktreePath, oid);
      if (committedPaths.length === 0 || committedPaths.some((path) => !isWithinSelectedPaths(path, selectedPaths))) {
        this.rejectOrphanCommit(topicId, oid, "생성된 커밋에 사용자가 고른 범위 밖 파일이 들어 있습니다.");
      }
      // 이 커밋이 확정되면 앞서 거부됐던 커밋 기록은 더 이상 처분 대상이 아니다.
      this.core.dependencies.database.updateTopic(topicId, { committedOID: oid, pushedOID: null, orphanCommitOID: null });
      this.core.event(topicId, "user", "decision", "선택한 변경을 커밋했습니다.", { oid, paths, deliveryAction: "commit", parent: deliveryBase });
      return oid;
    });
  }

  // 작업 묶음 단계 링크의 합류 병합 준비(없으면 null). 단계 토픽이 아니면 null.
  private stagePreparedMerge(topicId: string): StagePreparedMerge | null {
    const group = this.core.dependencies.database.workGroups.forTopic(topicId);
    const stageId = group && Object.entries(group.links).find(([, link]) => link.topicId === topicId)?.[0];
    const link = stageId ? group.links[stageId] : undefined;
    return group && stageId && link?.preparedMerge
      ? { stageId, merge: link.preparedMerge, mergeTargets: link.mergeTargets ?? [], baseOID: link.baseOID, results: group.results ?? {} } : null;
  }

  // 합류 병합 커밋(E4 보완 F001) — 에이전트가 커밋하거나 병합하지 않는다(기준 HEAD 고정 가드 유지). 엔진이 확인하는 것:
  //  ① 승인된 합류 대상: 링크에 준비한 대상 = 링크의 합류 대상이고, 각 커밋이 지금 동결된 그 단계 결과 커밋이다.
  //  ② 부모: [인도 기준(리뷰 HEAD), …합류 대상 커밋] — 브랜치는 update-ref 세 인자로 기대 HEAD 에서만 옮긴다.
  //  ③ 리뷰 트리: 작업 트리 전체의 트리 == 최종 리뷰가 기록한 트리. 병합 커밋은 리뷰한 작업 트리 전체를 담으므로 바뀐 경로가 모두 선택 범위 안이어야 한다
  //     (일부만 담으면 합류 대상을 부모로 삼으면서 그 내용을 되돌리는 커밋이 된다). 같은 변경을 서로 다른 커밋으로 만든 결과를 잇는 병합처럼 파일 차이가
  //     없는 계보 병합도 부모·트리가 확인되면 정상 결과다(E4 2차 보완 F001) — 선택 경로는 비어 있을 수 있다.
  // 순서(E4 2차 보완 F014): 커밋 객체 생성 → 그 OID·부모·트리·경로를 타임라인(과 요청 좌표)에 기록 → 브랜치 이동 → index 정렬 → 사후 검증·확정. ref 를
  // 옮긴 뒤 어디서 멈춰도(index.lock 등 정렬 실패, 서버 종료) 기록한 OID 가 남는다. 그 OID 가 HEAD 인 동안 commit 재요청(또는 서버 종료 뒤
  // reconcile-delivery 성공 확인)이 index 를 맞추고 같은 검증으로 확정한다 — 바뀐 HEAD 를 그대로 인정하지 않고 기록한 커밋일 때만 잇는다.
  // 요청 좌표(E4 3차 보완): 최초 요청과 재요청 모두 확정 **전에** 자기 요청에 {parent: 인도 기준, mergeCommit: 병합 OID} 를 남긴다. 확정 기록 뒤 요청
  // 완료 전에 서버가 멈추면 복구는 이 좌표로 "이 요청의 병합 커밋" 을 가려 이미 확정된 경우에도 같은 검증으로 성공을 확인한다.
  // 사후 검증(부모·트리·첫 부모 대비 경로·작업 트리 스냅샷)이 어긋나면 일반 커밋과 같은 고아 처분 규칙을 쓴다.
  private async commitStageMerge(
    topic: Topic, flags: ReturnType<EngineCore["dependencies"]["database"]["getFlags"]>,
    prepared: StagePreparedMerge,
    message: string, paths: string[], idempotencyKey?: string,
  ): Promise<string> {
    const git = this.core.dependencies.git;
    const database = this.core.dependencies.database;
    const deliveryBase = flags.reviewedHead!;
    const approved = this.approvedMergeParents(prepared, deliveryBase);
    if (!flags.reviewedTreeOID) throw new Error("최종 리뷰가 기록한 작업 트리가 없어 합류 병합 커밋을 만들 수 없습니다.");
    const head = await git.head(topic.worktreePath);
    if (head !== deliveryBase) {
      // 브랜치를 옮긴 뒤 확정 전에 멈춘 병합 커밋 — 이 범위 세대에 마지막으로 기록한 병합 커밋이 같은 인도 기준에서 만든 것이고 지금 HEAD 일 때만 이어서
      // 끝낸다(요청의 메시지·경로는 기록한 것을 쓴다). 확정 기록이 없는 상태에서만 이 경로에 온다(commit 이 확정 커밋이 있으면 병합 경로를 타지 않는다).
      const pending = this.recordedStageMerge(topic.id);
      if (!pending || pending.parent !== deliveryBase || pending.oid !== head) {
        throw new Error("최종 리뷰 뒤 worktree가 바뀌었습니다. 다시 리뷰해야 커밋할 수 있습니다.");
      }
      if (idempotencyKey) database.annotateActionRequest(topic.id, "commit", idempotencyKey, { parent: pending.parent, mergeCommit: pending.oid });
      return this.finishStageMerge(topic, flags, approved, pending, "retry");
    }
    const selectedPaths = paths.length ? normalizeCommitPaths(topic.worktreePath, paths) : [];
    const current = await git.snapshot(topic.worktreePath, flags.reviewedHead!);
    if (current.head !== deliveryBase || current.diffSHA256 !== flags.reviewedDiffSHA256) {
      throw new Error("최종 리뷰 뒤 worktree가 바뀌었습니다. 다시 리뷰해야 커밋할 수 있습니다.");
    }
    const changed = await git.changedPaths(topic.worktreePath);
    const unselected = changed.filter((path) => !isWithinSelectedPaths(path, selectedPaths));
    if (unselected.length > 0) {
      throw new Error(`합류 병합 커밋은 리뷰한 작업 트리 전체를 담습니다 — 바뀐 경로를 모두 선택하세요: ${unselected.join(", ")}`);
    }
    const tree = await git.workingTreeOID(topic.worktreePath);
    if (tree !== flags.reviewedTreeOID) throw new Error("작업 트리가 최종 리뷰한 트리와 달라 합류 병합 커밋을 만들지 않았습니다. 다시 리뷰하세요.");
    const evidenceInput = database.evidence.captureForCommit(topic);
    if (idempotencyKey) database.annotateActionRequest(topic.id,"commit",idempotencyKey,{ parent: deliveryBase, evidenceNonce: evidenceInput });
    const oid = await git.writeMergeCommit(topic.worktreePath, tree, approved, message);
    database.evidence.bindCommitInput(topic,evidenceInput,oid);
    const pending: PendingStageMerge = { oid, parent: deliveryBase, parents: approved, tree, paths: selectedPaths, message };
    if (idempotencyKey) database.annotateActionRequest(topic.id, "commit", idempotencyKey, { parent: deliveryBase, mergeCommit: oid });
    this.core.event(topic.id, "system", "system",
      `합류 병합 커밋 ${oid} 을 만들었습니다 — 브랜치를 옮기고 index 를 맞춘 뒤 확정합니다(부모 ${approved.join(", ")}).`, { mergeCommitPending: pending });
    await git.moveBranch(topic.worktreePath, topic.branchName!, oid, deliveryBase);
    return this.finishStageMerge(topic, flags, approved, pending, "commit");
  }

  // 승인된 병합 부모 — [인도 기준, …준비한 합류 대상 커밋]. 준비 대상 = 링크 합류 대상이고 각 커밋이 지금 동결된 그 단계 결과여야 한다.
  private approvedMergeParents(prepared: StagePreparedMerge, deliveryBase: string): string[] {
    const mergeTargets = prepared.mergeTargets;
    const targetIds = prepared.merge.targets.map((target) => target.stageId);
    if (targetIds.length === 0 || [...targetIds].sort().join("\0") !== [...mergeTargets].sort().join("\0")) {
      throw new Error("준비한 합류 대상이 단계의 합류 대상과 다릅니다.");
    }
    for (const target of prepared.merge.targets) {
      if (prepared.results[target.stageId]?.commitOID !== target.commitOID) {
        throw new Error(`합류 대상 ${target.stageId} 의 커밋이 동결된 단계 결과와 다릅니다.`);
      }
    }
    return [deliveryBase, ...prepared.merge.targets.map((target) => target.commitOID)];
  }

  // 이 범위 세대에서 마지막으로 기록한 합류 병합 커밋(없으면 null) — 확정 여부와 무관하다. 호출자가 인도 기준·HEAD·요청 좌표로 결속한다: commit 재요청은
  // 확정 전에만, 결과 확인은 그 요청이 좌표로 남긴 병합 OID 일 때만 쓴다(E4 3차 보완). 다른 세대의 기록은 보지 않는다(범위 변경은 새 작업 트리다).
  private recordedStageMerge(topicId: string): PendingStageMerge | null {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    return (database.getScopedTimeline(topicId, topic.scopeGeneration)
      .filter((event) => event.payload?.mergeCommitPending).at(-1)?.payload?.mergeCommitPending as PendingStageMerge | undefined) ?? null;
  }

  // 브랜치를 옮긴 병합 커밋의 index 정렬·사후 검증·확정(커밋·재요청 공용). index 정렬이 실패하면(index.lock 등) 그 상태를 기록하고 멈춘다 — HEAD 는 기록한
  // 커밋이고 확정하지 않았으며, 원인을 푼 뒤 commit 재요청이 여기서 이어 끝낸다.
  private async finishStageMerge(
    topic: Topic, flags: ReturnType<EngineCore["dependencies"]["database"]["getFlags"]>, approved: string[], pending: PendingStageMerge,
    via: "commit" | "retry",
  ): Promise<string> {
    const git = this.core.dependencies.git;
    try {
      await git.resyncIndex(topic.worktreePath, topic.branchName!);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.core.event(topic.id, "system", "system",
        `합류 병합 커밋 ${pending.oid} 로 브랜치를 옮겼지만 index 를 맞추지 못했습니다(${reason.split("\n")[0]}). HEAD 는 이 커밋이고 아직 확정하지 않았습니다 — `
          + "index 잠금 등 원인을 푼 뒤 commit 을 다시 요청하면 index 를 맞추고 같은 검증으로 확정합니다.",
        { mergeCommitIndexPending: pending.oid });
      throw Object.assign(new Error(`합류 병합 커밋 ${pending.oid} 의 index 정렬에 실패해 확정하지 못했습니다(${reason.split("\n")[0]}). 원인을 푼 뒤 commit 을 다시 요청하세요.`),
        { statusCode: 409 });
    }
    this.assertDeliverySnapshot(topic);
    const problem = await this.stageMergeProblem(topic, flags, approved, pending);
    if (problem) this.rejectOrphanCommit(topic.id, pending.oid, problem);
    this.core.dependencies.database.updateTopic(topic.id, { committedOID: pending.oid, pushedOID: null, orphanCommitOID: null });
    this.core.event(topic.id, "user", "decision", via === "retry"
      ? "브랜치를 옮긴 뒤 멈췄던 합류 병합 커밋의 index 를 맞추고 확정했습니다(엔진 병합 커밋)."
      : "합류 대상을 병합한 선택 변경을 커밋했습니다(엔진 병합 커밋).", {
      oid: pending.oid, paths: pending.paths, deliveryAction: "commit", parent: pending.parent,
      merge: { parents: pending.parents, tree: pending.tree, via },
    });
    return pending.oid;
  }

  // 병합 커밋 사후 검증 — 어긋난 이유(없으면 null). 부모 = 기록한 부모 = 승인된 부모, 커밋 트리 == 리뷰 트리, 작업 트리 내용 == 리뷰 스냅샷, 첫 부모 대비
  // 경로 ⊆ 선택 경로(파일 차이 없는 계보 병합은 빈 경로).
  private async stageMergeProblem(
    topic: Topic, flags: ReturnType<EngineCore["dependencies"]["database"]["getFlags"]>, approved: string[], pending: PendingStageMerge,
  ): Promise<string | null> {
    const git = this.core.dependencies.git;
    const parents = await git.commitParents(topic.worktreePath, pending.oid);
    if (parents.join("\0") !== approved.join("\0") || pending.parents.join("\0") !== approved.join("\0")) {
      return "생성된 병합 커밋의 부모가 인도 기준·합류 대상과 다릅니다.";
    }
    if (!flags.reviewedTreeOID || (await git.diffTrees(topic.worktreePath, pending.oid, flags.reviewedTreeOID)).files.length > 0) {
      return "생성된 병합 커밋의 트리가 최종 리뷰한 트리와 다릅니다.";
    }
    if ((await git.snapshot(topic.worktreePath, flags.reviewedHead!)).diffSHA256 !== flags.reviewedDiffSHA256) {
      return "커밋 도중 파일 내용이 최종 리뷰 결과와 달라졌습니다.";
    }
    const committedPaths = await git.commitChangedPaths(topic.worktreePath, pending.oid);
    if (committedPaths.some((path) => !isWithinSelectedPaths(path, pending.paths))) {
      return "생성된 커밋에 사용자가 고른 범위 밖 파일이 들어 있습니다.";
    }
    return null;
  }

  async push(topicId: string): Promise<string> {
    // 닫힌 작업 묶음 단계는 동결 결과를 전달한다(E4 보완 F002) — 단계 종료(로컬 커밋 승계)와 원격 전달은 독립이다.
    if (this.core.dependencies.database.getTopic(topicId).state === "CLOSED") return this.pushClosedStage(topicId);
    return this.withDeliveryLock(topicId, async (topic) => {
      if (!topic.branchName) throw new Error("push할 작업 브랜치가 없습니다.");
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.committedOID) throw new Error("Consensus Room에서 확정한 커밋이 없습니다.");
      if (await this.core.dependencies.git.head(topic.worktreePath) !== flags.committedOID) {
        throw new Error("확정한 커밋 뒤 HEAD가 바뀌어 push를 중단했습니다.");
      }
      this.core.dependencies.database.evidence.assertReady(this.core.dependencies.database.getTopic(topicId));
      const oid = await this.core.dependencies.git.push(topic.worktreePath, topic.branchName);
      this.assertDeliverySnapshot(topic);
      this.core.dependencies.database.updateTopic(topicId, { pushedOID: oid });
      this.core.event(topicId, "user", "decision", "작업 브랜치를 원격 저장소에 push했습니다.", { oid, branchName: topic.branchName, deliveryAction: "push" });
      return oid;
    });
  }

  // 닫힌 단계의 push 가 받아들여지는 조건(부작용 전 검사 전부) — push 와 재개 정보가 같은 함수를 쓴다. 동결 결과가 이 토픽의 것이고 확정 커밋이 그 결과
  // 커밋이며, 결과가 불명확한 전달 요청이 없을 때만. 상태는 CLOSED 그대로다(다시 열지 않는다).
  closedStagePushPreconditions(topicId: string): { topic: Topic; commitOID: string } {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    if (topic.state !== "CLOSED") throw new Error("닫힌 단계가 아닙니다.");
    const group = database.workGroups.forTopic(topicId);
    const stageId = group && Object.entries(group.links).find(([, link]) => link.topicId === topicId)?.[0];
    const result = stageId ? group.results?.[stageId] : undefined;
    if (!group || !stageId || !result || result.topicId !== topicId) throw new Error("동결된 단계 결과가 있는 닫힌 작업 묶음 단계만 push 할 수 있습니다.");
    const flags = database.getFlags(topicId);
    if (!flags.committedOID || flags.committedOID !== result.commitOID) throw new Error("확정 커밋이 동결된 단계 결과 커밋과 다릅니다.");
    if (flags.pushedOID === flags.committedOID) throw new Error("동결된 단계 결과는 이미 push 했습니다.");
    if (database.unknownDeliveryAction(topicId)) {
      throw new Error("결과가 불명확한 push 가 있습니다. reconcile-delivery 로 원격 결과를 먼저 확인하세요.");
    }
    if (!topic.branchName) throw new Error("push할 작업 브랜치가 없습니다.");
    this.core.assertNoActiveWork(topicId);
    database.evidence.assertReady(topic);
    return { topic, commitOID: flags.committedOID };
  }

  private async pushClosedStage(topicId: string): Promise<string> {
    const { topic, commitOID } = this.closedStagePushPreconditions(topicId);
    this.core.deliveryActive.add(topicId);
    try {
      await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName!);
      if (await this.core.dependencies.git.head(topic.worktreePath) !== commitOID) {
        throw new Error("닫힌 단계의 작업 트리 HEAD 가 동결된 결과 커밋과 달라 push 를 중단했습니다.");
      }
      const oid = await this.core.dependencies.git.push(topic.worktreePath, topic.branchName!);
      const current = this.core.dependencies.database.getTopic(topicId);
      if (current.state !== "CLOSED" || current.branchName !== topic.branchName || current.worktreePath !== topic.worktreePath) {
        throw new Error("전달 작업 중 주제 상태나 worktree가 바뀌었습니다.");
      }
      if (oid !== commitOID) throw new Error("push 한 커밋이 동결된 단계 결과 커밋과 다릅니다.");
      this.core.dependencies.database.updateTopic(topicId, { pushedOID: oid });
      this.core.event(topicId, "user", "decision", "닫힌 단계의 동결 결과를 원격 저장소에 push했습니다.", {
        oid, branchName: topic.branchName, deliveryAction: "push", closedStage: true,
      });
      return oid;
    } finally {
      this.core.deliveryActive.delete(topicId);
    }
  }

  // 사후 검증으로 거부한 커밋은 이 경로에서만, 되돌려도 안전하다는 것을 전부 확인한 뒤에 되돌린다.
  async discardOrphanCommit(topicId: string): Promise<Topic> {
    return this.withDeliveryLock(topicId, async (topic) => {
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.orphanCommitOID) throw new Error("되돌릴 로컬 커밋이 원장에 기록되어 있지 않습니다.");
      if (!topic.branchName) throw new Error("되돌릴 작업 브랜치가 없습니다.");
      // 전제조건은 "이 커밋을 떼도 잃는 것이 없다"만 본다. 리뷰 기준과의 일치는 요구하지 않는다 —
      // 부모 불일치와 내용 변화는 애초에 이 커밋을 거부한 사유이므로, 그것을 되돌리기 조건으로 삼으면
      // 정작 거부된 커밋만 영구히 처분할 수 없게 된다.
      const head = await this.core.dependencies.git.head(topic.worktreePath);
      const parents = await this.core.dependencies.git.commitParents(topic.worktreePath, flags.orphanCommitOID);
      // 엔진이 만든 합류 병합 커밋(부모 = [기준, …준비한 합류 대상])은 첫 부모로 되돌린다 — 작업 트리는 그대로라 잃는 것이 없다(E4 보완 F001).
      const prepared = this.stagePreparedMerge(topicId);
      const engineMerge = prepared !== null && parents.length >= 2
        && parents.slice(1).join("\0") === prepared.merge.targets.map((target) => target.commitOID).join("\0");
      if (parents.length !== 1 && !engineMerge) {
        throw new Error(`부모가 하나인 커밋만 되돌립니다. 이 커밋의 부모는 ${parents.length}개입니다.`);
      }
      const restoredHead = parents[0];
      // 확정 커밋이 있으면 그 **뒤에 붙은** 고아만 되돌린다 — 확정 커밋 이전으로는 돌아가지 않는다(사슬 인도에서 C2 고아는 C1 로 복귀).
      if (flags.committedOID && restoredHead !== flags.committedOID) throw new Error("이미 확정한 커밋이 있어 되돌리지 않았습니다.");
      if (head !== flags.orphanCommitOID) {
        // update-ref는 됐는데 index 재정렬 전에 중단된 되돌리기가 남긴 상태다. HEAD가 이미 부모를
        // 가리키면 index만 마저 맞추고 끝낸다 — 여기서 막으면 반쪽 상태에서 커밋·닫기까지 전부 봉쇄된다.
        if (head === restoredHead) {
          this.assertDeliverySnapshot(topic);
          await this.core.dependencies.git.resyncIndex(topic.worktreePath, topic.branchName);
          this.core.dependencies.database.updateTopic(topicId, { orphanCommitOID: null });
          this.core.event(topicId, "user", "decision", "중단됐던 되돌리기를 마저 끝냈습니다. 파일 변경은 그대로 남았습니다.", {
            discardedCommitOID: flags.orphanCommitOID, deliveryAction: "discard-orphan-commit",
            restoredHead,
          });
          return this.core.dependencies.database.getTopic(topicId);
        }
        throw new Error(`현재 HEAD가 기록된 커밋과 달라 되돌리지 않았습니다: ${head}`);
      }
      this.assertDeliverySnapshot(topic);
      await this.core.dependencies.git.resetToCommit(topic.worktreePath, topic.branchName, restoredHead, head);
      this.core.dependencies.database.updateTopic(topicId, { orphanCommitOID: null });
      this.core.event(topicId, "user", "decision", "전달하지 못한 로컬 커밋을 되돌렸습니다. 파일 변경은 그대로 남았습니다.", {
        discardedCommitOID: flags.orphanCommitOID, deliveryAction: "discard-orphan-commit",
        restoredHead,
      });
      return this.core.dependencies.database.getTopic(topicId);
    });
  }

  async reconcileDelivery(
    topicId: string,
    input: { idempotencyKey: string; outcome: "succeeded" | "failed"; oid?: string },
  ): Promise<Topic> {
    const topic = this.core.dependencies.database.getTopic(topicId);
    const flags = this.core.dependencies.database.getFlags(topicId);
    if (topic.state === "CLOSED") return this.reconcileClosedStagePush(topic, input);
    if (topic.state !== "USER_DECISION_REQUIRED" || flags.resumeState !== "READY_TO_DELIVER") {
      throw new Error("확인이 필요한 전달 작업이 없습니다.");
    }
    if (!topic.branchName) throw new Error("확인할 작업 브랜치가 없습니다.");
    const recovery = this.core.dependencies.database.unknownDeliveryAction(topicId);
    if (!recovery) throw new Error("결과가 불명확한 commit 또는 push 요청이 없습니다.");
    if (recovery.idempotencyKey !== input.idempotencyKey) {
      throw new Error("확인하려는 전달 요청이 현재 복구 대상과 다릅니다.");
    }
    const action = recovery.action;
    const bindEvidenceInput = (oid: string) => {
      const nonce = recovery.annotation?.evidenceNonce;
      if (typeof nonce === "string") this.core.dependencies.database.evidence.bindCommitInput(topic,nonce,oid);
    };
    const startedGeneration = topic.scopeGeneration;
    // git 확인은 await를 여러 번 지난다. 기록 직전에 상태·세대·복구 대상이 그대로인지 다시 본다(감사 ②).
    const assertStillReconciling = () => {
      const current = this.core.dependencies.database.getTopic(topicId);
      const currentFlags = this.core.dependencies.database.getFlags(topicId);
      const currentRecovery = this.core.dependencies.database.unknownDeliveryAction(topicId);
      if (current.state !== "USER_DECISION_REQUIRED" || current.scopeGeneration !== startedGeneration
          || currentFlags.resumeState !== "READY_TO_DELIVER"
          || currentRecovery?.idempotencyKey !== input.idempotencyKey) {
        throw new Error("전달 결과를 확인하는 동안 주제 상태가 바뀌었습니다. 다시 확인해 주세요.");
      }
    };
    // 성공 확인이 남길 확정 기록 — 아래 마감 transaction 에 요청 마감·전이와 함께 싣는다(E4 F016).
    let confirmedChanges: { committedOID?: string; pushedOID?: string | null } = {};
    if (input.outcome === "succeeded") {
      if (!input.oid) throw new Error("성공 확인에는 Git OID가 필요합니다.");
      await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName);
      const head = await this.core.dependencies.git.head(topic.worktreePath);
      if (input.oid !== head) throw new Error("입력한 Git OID가 현재 HEAD와 다릅니다.");
      if (action === "commit") {
        if (!flags.reviewedHead || !flags.reviewedDiffSHA256) {
          throw new Error("리뷰가 확인한 커밋 전 상태가 없어 성공을 검증할 수 없습니다.");
        }
        const request = DeliveryInputSchema.parse(recovery.request);
        // 성공 판정의 기준 = 이 요청이 시작할 때 기록한 HEAD(요청 좌표 `parent`). commit() 이 committedOID 를 기록한 뒤 요청 완료(ledger.finish)
        // 전에 서버가 죽어도 좌표는 남아 있어 "그 HEAD 위에 새 커밋이 생겼는가" 로 판정한다(host-review 2026-09-21 R1). 좌표가 없는 옛 요청은
        // 사슬 기준(마지막 확정 커밋, 없으면 리뷰 HEAD)으로 보되 이미 확정 기록된 HEAD 를 성공으로 인정하지 않는다 — 같은 메시지의 미실행 요청을
        // 성공으로 오인하지 않게(R2: 메시지 대조는 판정 근거가 아니다).
        const annotated = recovery.annotation?.parent;
        const expectedParent = typeof annotated === "string" && annotated ? annotated : (flags.committedOID ?? flags.reviewedHead);
        if (head === expectedParent) throw new Error("현재 HEAD는 커밋 전 리뷰 기준과 같아 커밋 성공이 아닙니다.");
        // 합류 병합 요청(E4 2·3차 보완 F014·F001) — 요청이 확정 전에 남긴 좌표의 병합 OID(mergeCommit)로 가린다. 확정 기록(committedOID)이 이미 이 병합
        // 커밋이어도 같은 경로다: 확정 뒤 요청 완료 전에 멈춘 경우 일반 커밋 판정(첫 부모 대비 경로가 있어야 함)은 파일 차이 없는 계보 병합을 거부했고,
        // 좌표 없는 재요청은 기준이 확정 커밋으로 잡혀 거부됐다. 좌표가 없어도 확정 기록이 없는 준비 단계면 이 경로다 — 그 단계의 첫 인도 커밋은 엔진 병합
        // 커밋뿐이라, 엔진이 기록하지 않은 커밋(좌표를 남기기 전에 멈춘 요청 뒤 손으로 만든 병합 등)을 일반 커밋 규칙으로 성공 처리하지 않는다. 확정 뒤의
        // 좌표 없는 요청(일반 후속 커밋)은 병합 요청이 아니다 — 과거 병합을 그 요청의 성공으로 보지 않는다.
        const recordedMerge = typeof recovery.annotation?.mergeCommit === "string" && recovery.annotation.mergeCommit
          ? recovery.annotation.mergeCommit : null;
        const prepared = this.stagePreparedMerge(topicId);
        if (recordedMerge || (prepared && !flags.committedOID)) {
          if (!prepared) throw new Error("합류 병합 준비가 없는 단계에 병합 요청 기록이 있어 성공으로 확인하지 않았습니다.");
          // 이 요청이 기록한 병합 OID = 현재 HEAD = 이 세대에 마지막으로 기록한 병합 커밋이고, 그 기록이 이 요청의 인도 기준에서 만든 것이어야 한다.
          const pending = this.recordedStageMerge(topicId);
          if ((recordedMerge && recordedMerge !== head) || !pending || pending.oid !== head || pending.parent !== expectedParent) {
            throw new Error("현재 HEAD 가 이 요청에서 엔진이 기록한 합류 병합 커밋이 아니어서 성공으로 확인하지 않았습니다.");
          }
          // 확정 기록이 있으면 그것이 이 병합 커밋이어야 한다(다른 확정 커밋 위의 HEAD 를 이 요청의 성공으로 보지 않는다).
          const alreadyCommitted = flags.committedOID === head;
          if (flags.committedOID && !alreadyCommitted) {
            throw new Error("확정 커밋이 이 요청의 합류 병합 커밋과 달라 성공으로 확인하지 않았습니다.");
          }
          const approved = this.approvedMergeParents(prepared, pending.parent);
          await this.core.dependencies.git.resyncIndex(topic.worktreePath, topic.branchName);
          const problem = await this.stageMergeProblem(topic, flags, approved, pending);
          if (problem) throw new Error(problem);
          assertStillReconciling();
          // 확정 기록·확정 이벤트·요청 마감·전이를 한 transaction 으로 저장하고 알림은 COMMIT 뒤에 낸다(E4 F016) — 사이에서 멈춰도 요청이 사라진 채 복구
          // 대기에 남지 않는다(모두 이전 상태면 재기동 뒤 같은 확인을 다시 한다). 확정 기록과 확정 이벤트는 커밋 경로에서 따로 쓰이므로 그 사이에서 멈췄으면
          // 이벤트가 없다 — 없을 때만 넣어 이 병합 커밋의 확정 이벤트가 정확히 하나가 되게 한다.
          const confirmed = this.core.dependencies.database.getScopedTimeline(topicId, topic.scopeGeneration)
            .some((event) => event.payload?.deliveryAction === "commit" && event.payload?.oid === head);
          bindEvidenceInput(head);
          return this.core.transitionWith(topicId, "READY_TO_DELIVER", alreadyCommitted
            ? `확정 기록 뒤 요청 완료 전에 멈췄던 ${action}(합류 병합 커밋 ${head}) 결과를 사용자가 성공으로 확인했습니다.`
            : `중단됐던 ${action} 결과를 사용자가 성공으로 확인했습니다.`, {
            changes: alreadyCommitted ? {} : { committedOID: head, pushedOID: null, orphanCommitOID: null },
            events: confirmed ? [] : [{ actor: "user", kind: "decision", state: "READY_TO_DELIVER",
              body: "중단됐던 합류 병합 커밋의 index 를 맞추고 확정했습니다(엔진 병합 커밋, 전달 결과 확인).",
              payload: { oid: head, paths: pending.paths, deliveryAction: "commit", parent: pending.parent,
                merge: { parents: pending.parents, tree: pending.tree, via: "reconcile" } } }],
            deliveryResolution: { action, idempotencyKey: recovery.idempotencyKey, outcome: input.outcome },
          });
        }
        if (await this.core.dependencies.git.commitParent(topic.worktreePath, head) !== expectedParent) {
          throw new Error("현재 커밋의 부모가 리뷰 기준 HEAD와 다릅니다.");
        }
        const reviewedContent = await this.core.dependencies.git.snapshot(topic.worktreePath, flags.reviewedHead);
        if (reviewedContent.diffSHA256 !== flags.reviewedDiffSHA256) {
          throw new Error("현재 파일 내용이 최종 리뷰가 확인한 변경과 다릅니다.");
        }
        const selectedPaths = normalizeCommitPaths(topic.worktreePath, request.paths);
        const committedPaths = await this.core.dependencies.git.commitChangedPaths(topic.worktreePath, head);
        if (committedPaths.length === 0 || committedPaths.some((path) => !isWithinSelectedPaths(path, selectedPaths))) {
          throw new Error("복구한 커밋에 사용자가 고른 범위 밖 파일이 들어 있습니다.");
        }
        assertStillReconciling();
        bindEvidenceInput(head);
        confirmedChanges = { committedOID: head, pushedOID: null };
      } else {
        if (flags.committedOID !== head) {
          throw new Error("확정된 커밋과 현재 HEAD가 달라 push 성공으로 기록할 수 없습니다.");
        }
        if (await this.core.dependencies.git.remoteBranchOID(topic.worktreePath, topic.branchName) !== head) {
          throw new Error("원격 브랜치가 현재 커밋을 가리키지 않아 push 성공이 아닙니다.");
        }
        assertStillReconciling();
        confirmedChanges = { pushedOID: head };
      }
    }
    assertStillReconciling();
    // 확정 기록(성공 확인의 committedOID·pushedOID)·요청 마감·전이를 한 transaction 으로 저장하고 알림은 COMMIT 뒤에 낸다(E4 F016).
    return this.core.transitionWith(topicId, "READY_TO_DELIVER",
      `중단됐던 ${action} 결과를 사용자가 ${input.outcome === "succeeded" ? "성공" : "실패"}으로 확인했습니다.`, {
        changes: confirmedChanges,
        deliveryResolution: { action, idempotencyKey: recovery.idempotencyKey, outcome: input.outcome },
      });
  }

  // 닫힌 단계 push 의 결과 불명확 요청 확인(E4 보완 F002) — 서버 재시작 복구는 CLOSED 토픽을 다시 열지 않고 요청만 unknown 으로 남긴다. 성공 확인은
  // 원격 브랜치가 동결 결과 커밋(=확정 커밋=HEAD)을 가리킬 때만, 실패 확인은 기록만 닫아 다시 push 할 수 있게 한다. 상태는 CLOSED 그대로다.
  private async reconcileClosedStagePush(
    topic: Topic, input: { idempotencyKey: string; outcome: "succeeded" | "failed"; oid?: string },
  ): Promise<Topic> {
    const database = this.core.dependencies.database;
    const recovery = database.unknownDeliveryAction(topic.id);
    if (!recovery || recovery.action !== "push") throw new Error("확인이 필요한 전달 작업이 없습니다.");
    if (recovery.idempotencyKey !== input.idempotencyKey) throw new Error("확인하려는 전달 요청이 현재 복구 대상과 다릅니다.");
    if (!topic.branchName) throw new Error("확인할 작업 브랜치가 없습니다.");
    if (this.core.deliveryActive.has(topic.id)) throw new Error("다른 전달 작업이 끝난 뒤 확인하세요.");
    this.core.deliveryActive.add(topic.id);
    try {
      if (input.outcome === "succeeded") {
        const flags = database.getFlags(topic.id);
        if (!input.oid) throw new Error("성공 확인에는 Git OID가 필요합니다.");
        await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName);
        const head = await this.core.dependencies.git.head(topic.worktreePath);
        if (input.oid !== head || flags.committedOID !== head) throw new Error("확정된 커밋과 현재 HEAD가 달라 push 성공으로 기록할 수 없습니다.");
        if (await this.core.dependencies.git.remoteBranchOID(topic.worktreePath, topic.branchName) !== head) {
          throw new Error("원격 브랜치가 현재 커밋을 가리키지 않아 push 성공이 아닙니다.");
        }
        if (database.getTopic(topic.id).state !== "CLOSED" || database.unknownDeliveryAction(topic.id)?.idempotencyKey !== input.idempotencyKey) {
          throw new Error("전달 결과를 확인하는 동안 주제 상태가 바뀌었습니다. 다시 확인해 주세요.");
        }
        database.updateTopic(topic.id, { pushedOID: head });
      }
      database.resolveUnknownDeliveryAction(topic.id, "push", recovery.idempotencyKey, input.outcome);
      this.core.event(topic.id, "system", "system", `중단됐던 닫힌 단계 push 결과를 사용자가 ${input.outcome === "succeeded" ? "성공" : "실패"}으로 확인했습니다.`,
        { closedStagePushReconciled: input.outcome });
      return database.getTopic(topic.id);
    } finally {
      this.core.deliveryActive.delete(topic.id);
    }
  }

  private async withDeliveryLock<T>(topicId: string, work: (topic: Topic) => Promise<T>): Promise<T> {
    this.core.assertNoActiveWork(topicId);
    const topic = this.core.requireState(topicId, "READY_TO_DELIVER");
    this.core.deliveryActive.add(topicId);
    try {
      return await work(topic);
    } finally {
      this.core.deliveryActive.delete(topicId);
    }
  }

  private assertDeliverySnapshot(snapshot: Topic): void {
    const current = this.core.dependencies.database.getTopic(snapshot.id);
    if (current.state !== "READY_TO_DELIVER" ||
        current.scopeGeneration !== snapshot.scopeGeneration ||
        current.worktreePath !== snapshot.worktreePath ||
        current.branchName !== snapshot.branchName) {
      throw new Error("전달 작업 중 주제 범위나 worktree가 바뀌었습니다.");
    }
  }

  // 거부한 커밋은 지우지도 push하지도 않는다. OID를 원장과 timeline에 남겨 사용자가 처분을 승인할 수 있게 한다.
  private rejectOrphanCommit(topicId: string, oid: string, reason: string): never {
    this.core.dependencies.database.updateTopic(topicId, { orphanCommitOID: oid });
    this.core.event(
      topicId,
      "system",
      "system",
      `${reason} 로컬 커밋 ${oid}은 전달하지 않으며 자동으로 지우지도 않았습니다. 내용을 확인한 뒤 되돌리기를 승인해 주세요.`,
      { orphanCommitOID: oid, reason },
    );
    throw new Error(`${reason} 이 커밋은 push할 수 없습니다.`);
  }
}

// 작업 묶음 단계 링크의 합류 병합 준비(E4 보완 F001).
interface StagePreparedMerge {
  stageId: string;
  merge: PreparedMerge;
  mergeTargets: string[];
  baseOID: string;
  results: NonNullable<WorkGroup["results"]>;
}
// 만들어 기록했지만 아직 확정하지 않은 합류 병합 커밋(E4 2차 보완 F014) — 타임라인 system 이벤트 payload.mergeCommitPending.
interface PendingStageMerge {
  oid: string;
  parent: string;
  parents: string[];
  tree: string;
  paths: string[];
  message: string;
}
