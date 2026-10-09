// 계획 왕복(planned 모드): CLAUDE_PLAN → CODEX_AUDIT ⇄ CLAUDE_REVISION → (agree) AWAITING_USER_APPROVAL. 같은 두 세션이 응답 원문과 계획 판을 주고받는다.
// 진입점은 runPlanningRelay·resumePlanning·returnToPlanning 셋이다. 옛 계획 수렴 경로(감사·개정·종결·ACK·채택 기록)는 없다(CR 흐름 단순화).
import { realpath } from "node:fs/promises";
import { hierarchyContext, assertTask, assertEntryReady } from "../topicStructure.js";
import { type Topic, type TimelineEvent, type WorkflowState } from "../../shared/contracts.js";
import { buildFirstTurnPrompt, buildRelayPrompt, relayFactsFrom, type RelayFacts, type RelayMessage } from "../../shared/prompts.js";
import { brainstormReplies } from "../../shared/brainstorm.js";
import type { PlanBundleCapture } from "../../shared/planningControl.js";
import type { EngineCore, EnvelopeNext } from "./core.js";
import type { EnvelopeRole, WorkerFact } from "../../shared/turnContract.js";
import { PlanBundleError } from "../planBundle.js";

// 계획 왕복의 역할 턴 단계 — 플래너의 첫 작성·같은 계획 수정, 리뷰어의 검토.
type RelayStage = "CLAUDE_PLAN" | "CLAUDE_REVISION" | "CODEX_AUDIT";
const RELAY_LABEL: Readonly<Record<RelayStage, string>> = { CLAUDE_PLAN: "계획 작성", CLAUDE_REVISION: "계획 수정", CODEX_AUDIT: "계획 검토" };
const isRelayStage = (value: unknown): value is RelayStage => typeof value === "string" && value in RELAY_LABEL;

// 중재자에게 넘기고 같은 역할 턴을 재개 지점으로 둔다.
function mediatorStop(request: string, stage: RelayStage): EnvelopeNext {
  return { state: "USER_DECISION_REQUIRED" satisfies WorkflowState, message: request, changes: { resumeState: stage } };
}

// 확정한 판을 지금 계획으로 삼는다 — 판이 바뀌었으면 계획 SHA·판 번호를 올리고 사용자 승인을 무효화한다. 판 알림(workerFact plan-version)은 바뀌지
// 않았어도 남긴다: 상대 세션이 받은 판은 그 세션의 deliveredThrough 이하 가장 최근 판 알림으로 정해진다.
function planVersionAdoption(topic: Topic, captured: PlanBundleCapture): Pick<EnvelopeNext, "changes" | "events"> {
  const revision = captured.changed ? topic.planRevision + 1 : topic.planRevision;
  const short = captured.version.slice(0, 12);
  return {
    ...(captured.changed ? { changes: { planSHA256: captured.version, planRevision: revision, approvedPlanSHA256: null } } : {}),
    events: [{
      actor: "system", kind: "system",
      body: captured.changed ? `계획 ${revision}판(${short})을 확정했습니다.` : `계획 파일이 바뀌지 않았습니다 — ${revision}판(${short}) 그대로입니다.`,
      payload: { workerFact: { kind: "plan-version", version: captured.version, snapshotPath: captured.snapshotPath,
        diffPath: captured.diffPath, previous: captured.previous } satisfies WorkerFact },
    }],
  };
}

const envelopeOf = (event: TimelineEvent) => event.payload?.envelope as { role?: string; outcome?: string } | undefined;

export class PlanningPipeline {
  constructor(private readonly core: EngineCore) {}

  // ---- 계획 왕복(planned 모드) ---------------------------------------------------------------------------------------------
  // 같은 planner·plan reviewer 세션이 상대 응답 원문과 현재 계획 버전을 주고받는다. 엔진은 봉투의 outcome 으로 다음 역할 턴만 고르고 message 를
  // 해석·요약하지 않는다. planner 는 계획 폴더(plan/*.md)를 직접 쓰고 고치며, ready 면 엔진이 폴더를 버전으로 확정해 리뷰어에게 경로·버전·변경분을
  // 넘긴다. 리뷰어의 agree 는 받은 판이 지금 폴더의 판일 때 사용자 승인 대기로 간다. 종결·ACK·재계획 턴은 없다. 각 턴은 그 세션이 아직 받지 않은
  // 사실만 받는다(첫 턴만 과제·지침을 싣는다) — 문맥 관리는 공급자 세션에 맡긴다.

  // DRAFT → 플래너의 첫 계획 작성.
  async runPlanningRelay(topicId: string, signal: AbortSignal): Promise<void> {
    const topic = this.core.requireState(topicId, "DRAFT");
    assertTask(topic); assertEntryReady(this.core.dependencies.database, topic);
    this.core.requireParticipants(topic);
    this.core.transition(topicId, "CLAUDE_PLAN", "플래너가 계획 파일을 처음 작성합니다.");
    await this.relay(topicId, "CLAUDE_PLAN", signal);
  }

  // 멈춘 계획 왕복을 재개 지점의 역할 턴으로 같은 세션에서 다시 연다 — 중재자 결정·재시도·ticket → planned 전환 뒤 진입이 모두 이 경로다. 결정문은
  // 그 세션이 아직 받지 않은 사실로 실린다.
  async resumePlanning(topicId: string, signal: AbortSignal): Promise<void> {
    const { database } = this.core.dependencies;
    const topic = database.getTopic(topicId);
    const stage = isRelayStage(topic.state) ? topic.state : database.getFlags(topicId).resumeState;
    if (!isRelayStage(stage)) throw new Error(`계획 왕복을 다시 열 단계가 아닙니다(상태 ${topic.state}, 재개 지점 ${stage ?? "없음"}).`);
    this.core.requireParticipants(topic);
    if (topic.state !== stage) this.core.transition(topicId, stage, `${RELAY_LABEL[stage]} 턴을 같은 세션으로 다시 엽니다.`);
    await this.relay(topicId, stage, signal);
  }

  // 구현 중 계획 변경(중재자 return-to-planning) — 같은 계획을 같은 플래너 세션이 고친다. 중재자 결정은 사실로 전달된다.
  async returnToPlanning(topicId: string, signal: AbortSignal): Promise<void> {
    this.core.requireParticipants(this.core.dependencies.database.getTopic(topicId));
    this.core.transition(topicId, "CLAUDE_REVISION", "중재자가 계획 변경을 요청했습니다. 같은 플래너 세션이 같은 계획을 고칩니다.");
    await this.relay(topicId, "CLAUDE_REVISION", signal);
  }

  private async relay(topicId: string, stage: RelayStage, signal: AbortSignal): Promise<void> {
    for (let next: RelayStage | null = stage; next;) {
      next = next === "CODEX_AUDIT" ? await this.reviewerTurn(topicId, signal) : await this.plannerTurn(topicId, next, signal);
    }
  }

  private async plannerTurn(topicId: string, stage: "CLAUDE_PLAN" | "CLAUDE_REVISION", signal: AbortSignal): Promise<RelayStage | null> {
    const { database } = this.core.dependencies;
    const bundle = this.core.planBundle;
    const topic = database.getTopic(topicId);
    const route = this.core.route(topic, { role: "planner", operation: stage === "CLAUDE_PLAN" ? "plan" : "revision" });
    // 안내와 SessionTurn 은 실제 경로다 — 쓰기 경계는 실제 경로로 열고(turnPolicy.resolveSupportedTurn), Claude 의 allow 는 요청 경로와 실제 경로가
    // 둘 다 맞아야 적용된다. 데이터 폴더가 링크 아래면(⑧ S2 /tmp) 안내한 철자로 쓴 Write 가 막힌다.
    const planDirectory = await realpath(await bundle.directory(topic));
    const current = await bundle.current(topic);
    const seat = this.core.seatSession(topic, route);
    const first = this.isFirstTurn(topic, "planner", seat);
    const pending = this.core.pendingFacts(topic, "planner", seat);
    const facts: RelayFacts = { ...relayFactsFrom(pending.facts), counterpart: this.counterpart(topic, "plan-reviewer", first, pending.since) };
    // 첫 턴만 과제·지침·계획 폴더·논의 원문과 지금 계획(있으면 — 이행했거나 ticket 에서 전환한 계획)을 싣는다.
    const prompt = first
      ? buildFirstTurnPrompt({ ...this.firstTurn(topic, "planner"), planDirectory, ...facts,
        plan: facts.plan ?? (current ? { ...current, diffPath: null, status: "current" } : null) })
      : buildRelayPrompt(facts);
    const { envelope, sessionId } = await this.core.turn(route, topic, prompt, signal, {
      resultContract: "envelope", planDirectory, inputSequence: pending.through,
      ...(current ? { readablePaths: [current.snapshotPath] } : {}),
    });
    const record = (next?: EnvelopeNext) => this.core.recordEnvelope(topic, route, envelope,
      { sessionId, deliveredThrough: pending.through, ...(next ? { next } : {}) }, signal);
    if (envelope.outcome === "needs-mediator") {
      await record(mediatorStop(envelope.mediatorRequest ?? envelope.message, stage));
      return null;
    }
    const captured = await this.capture(topic, signal);
    if (typeof captured === "string") {
      await record(await this.bundleStop(topic, stage, "플래너가 ready 로 답했지만 계획 폴더를 계획 판으로 확정하지 못했습니다.", captured));
      return null;
    }
    // 계획 세션을 구현으로 잇는 토픽(계획 연속성 정책)은 이 판을 쓴 세션과 그 세션이 받은 순번을 묶어 둔다. 결속은 계획 SHA 가 같을 때만 읽히므로
    // 판 확정 앞에 써도 효력이 없고, 확정 뒤 끊겨 결속이 빠지는 일이 없다.
    if (database.planning.continuityEnabled(topic.id)) database.planning.bindSession(topic, captured.version, sessionId, pending.through);
    await record({ state: "CODEX_AUDIT", message: "리뷰어가 계획을 검토합니다.", ...planVersionAdoption(topic, captured) });
    return "CODEX_AUDIT";
  }

  private async reviewerTurn(topicId: string, signal: AbortSignal): Promise<RelayStage | null> {
    const { database } = this.core.dependencies;
    const topic = database.getTopic(topicId);
    const route = this.core.route(topic, { role: "reviewer", operation: "audit" });
    const current = await this.core.planBundle.current(topic);
    if (!current) throw new Error("검토할 현재 계획 버전이 없습니다.");
    const seat = this.core.seatSession(topic, route);
    const first = this.isFirstTurn(topic, "plan-reviewer", seat);
    const pending = this.core.pendingFacts(topic, "plan-reviewer", seat);
    const relayed = relayFactsFrom(pending.facts);
    // 리뷰어가 받는 판은 언제나 지금 판이다. 이번 사실에 그 판의 확정 기록이 있으면 직전 판 대비 변경분까지, 없으면(이행한 계획) 경로·버전만 싣는다.
    const plan = relayed.plan?.version === current.version ? relayed.plan : { ...current, diffPath: null, status: "current" as const };
    const facts: RelayFacts = { ...relayed, plan, counterpart: this.counterpart(topic, "planner", first, pending.since) };
    const prompt = first ? buildFirstTurnPrompt({ ...this.firstTurn(topic, "plan-reviewer"), ...facts }) : buildRelayPrompt(facts);
    const { envelope, sessionId } = await this.core.turn(route, topic, prompt, signal, {
      resultContract: "envelope", inputSequence: pending.through,
      readablePaths: [plan.snapshotPath, ...(plan.diffPath ? [plan.diffPath] : [])],
    });
    const record = (next?: EnvelopeNext) => this.core.recordEnvelope(topic, route, envelope,
      { sessionId, deliveredThrough: pending.through, ...(next ? { next } : {}) }, signal);
    switch (envelope.outcome) {
      case "needs-mediator":
        await record(mediatorStop(envelope.mediatorRequest ?? envelope.message, "CODEX_AUDIT"));
        return null;
      case "changes":
        await record({ state: "CLAUDE_REVISION", message: "플래너가 리뷰어 응답을 받아 같은 계획을 고칩니다." });
        return "CLAUDE_REVISION";
      case "agree": {
        // 합의는 리뷰어가 받은 판이 지금 폴더의 판일 때만이다. 리뷰 사이에 폴더가 바뀌었으면 새 판을 확정해 같은 리뷰어 세션에 다시 보낸다(상태 유지).
        const captured = await this.capture(topic, signal);
        if (typeof captured === "string") {
          await record(await this.bundleStop(topic, "CODEX_AUDIT", "리뷰어가 동의했지만 동의한 판이 지금 계획 폴더와 같은지 확인하지 못했습니다.", captured));
          return null;
        }
        if (!captured.changed) {
          await record({ state: "AWAITING_USER_APPROVAL",
            message: `리뷰어가 계획 ${topic.planRevision}판(${captured.version.slice(0, 12)})에 동의했습니다. 사용자 구현 승인을 기다립니다.` });
          return null;
        }
        await record({ message: "리뷰 사이에 계획 파일이 바뀌어 새 판을 같은 리뷰어 세션에 다시 보냅니다.", ...planVersionAdoption(topic, captured) });
        return "CODEX_AUDIT";
      }
      default:
        throw new Error(`계획 리뷰어 봉투의 outcome 이 아닙니다: ${envelope.outcome}`);
    }
  }

  // 계획 폴더를 판으로 확정하지 못한 엔진 정지 — 중재자가 판단할 수 있게 막힌 것·근거·보존한 위치·다음 행동을 적는다.
  private async bundleStop(topic: Topic, stage: RelayStage, blocked: string, reason: string): Promise<EnvelopeNext> {
    const role = stage === "CODEX_AUDIT" ? "리뷰어" : "플래너";
    return mediatorStop([
      `막힌 것: ${blocked}`,
      `근거: ${reason}`,
      `보존: ${role} 응답 원문은 이 기록에, 계획 파일은 ${await this.core.planBundle.directory(topic)} 에 그대로 있습니다. 지금 계획 판은 ${topic.planSHA256 ?? "없음"} 입니다.`,
      `다음 행동: 계획 폴더를 고치거나 진행 방법을 결정으로 남긴 뒤 재개하면, 같은 ${role} 세션이 그 결정을 받아 ${RELAY_LABEL[stage]} 턴을 다시 합니다.`,
    ].join("\n"), stage);
  }

  // 작업 폴더를 버전으로 확정한다(실행 중인 턴의 현재성 검사로 저장). 폴더에 계획이 없거나 읽을 수 없으면 그 사유를 돌려준다 — 호출자가 원문을 보존하고
  // 중재자에게 넘긴다(같은 지시를 자동으로 반복하지 않는다).
  private async capture(topic: Topic, signal: AbortSignal): Promise<PlanBundleCapture | string> {
    try {
      return await this.core.planBundle.capture(topic,
        { write: (kind, revision, content) => this.core.writeArtifact(topic, kind, revision, content, signal) });
    } catch (error) {
      if (error instanceof PlanBundleError) return error.message;
      throw error;
    }
  }

  // 상대 역할의 봉투 원문. 이어 쓰는 세션은 since 뒤 받지 않은 것을 모두(중재자 정지를 거쳐 여럿일 수 있다) 순서대로 받는다. 첫 턴(새 세션이거나
  // 이 역할 봉투 기록이 없는 세션)은 상대의 마지막 message 만 받는다 — 지난 왕복 전체를 다시 싣지 않는다. 원문은 바꾸지 않고 둘 이상일 때만 순번·outcome
  // 머리줄을 붙인다.
  private counterpart(topic: Topic, role: EnvelopeRole, first: boolean, since: number): RelayFacts["counterpart"] {
    const all = this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration, since)
      .filter((event) => event.kind === "agent_output" && envelopeOf(event)?.role === role);
    const outputs = first ? all.slice(-1) : all;
    if (outputs.length === 0) return null;
    const message = outputs.length === 1 ? outputs[0]!.body
      : outputs.map((event) => `[#${event.sequence} ${envelopeOf(event)?.outcome ?? ""}]\n${event.body}`).join("\n\n");
    return { role, message };
  }

  // 이 세션이 이 역할로 봉투를 기록한 적이 없으면 첫 턴이다 — 새 세션이거나, 이행 토픽처럼 세션은 이어 쓰지만 이 역할 지침을 받은 적이 없다.
  // 구현·리뷰 왕복의 판정(delivery.ts relayLatestEnvelope)과 같은 뜻이고, 따로 표식을 두지 않는다.
  private isFirstTurn(topic: Topic, role: EnvelopeRole, seat: string | null): boolean {
    return seat === null || !this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration)
      .some((event) => event.kind === "agent_output" && envelopeOf(event)?.role === role && event.payload?.sessionId === seat);
  }

  private firstTurn(topic: Topic, role: "planner" | "plan-reviewer") {
    return {
      role, title: topic.title, task: hierarchyContext(this.core.dependencies.database, topic),
      worktreePath: topic.worktreePath, branchName: topic.branchName, baseRef: topic.baseRef, discussion: this.discussion(topic),
    };
  }

  // 계획 전에 나눈 논의 발언 원문 — 옛 첫 계획 턴이 받던 범위(이 범위 세대 타임라인, getPromptTimeline)와 같게 라운드와 무관하게 모두 싣는다.
  // 결정·목표는 사용자 사실(messages)과 과제로 따로 간다.
  private discussion(topic: Topic): RelayMessage[] {
    const timeline = this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration);
    return timeline.filter((event) => event.actor === "system" && event.payload.brainstormRound !== undefined)
      .flatMap((round) => brainstormReplies(timeline, round.sequence))
      .map((event) => ({ sequence: event.sequence, actor: String(event.payload.brainstormRole ?? event.actor), kind: "brainstorm", body: event.body }));
  }
}
