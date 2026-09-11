// 계획 수렴 파이프라인: CLAUDE_PLAN → CODEX_AUDIT → CLAUDE_REVISION → CODEX_CLOSEOUT → CONSENSUS_ACK.
// 각 단계의 검증 순서(검증 → 메모리 반영 → pause → 저장)가 이 파일의 계약이다.
import { type AgentResult, type Topic, AgentResultSchema, type Finding } from "../../shared/contracts.js";
import {
  buildClaudePlanPrompt,
  buildClaudeRevisionPrompt,
  buildCodexAuditPrompt,
  buildCodexCloseoutPrompt,
  buildPlanAckPrompt,
} from "../../shared/prompts.js";
import {
  assertDispositionsResolved,
  assertFindingCoverage,
  assertPlanContract,
  bothAgentsAcknowledged,
  classifyCloseout,
  dispositionRegressions,
  hashPlan,
  newFindingIDs,
  normalizePlan,
  redactSecrets, replanDirective } from "../../shared/workflow.js";
import type { EngineCore } from "./core.js";
import { preparePlanningContext } from "./planningContext.js";

export class PlanningPipeline {
  constructor(private readonly core: EngineCore) {}

  async runPlanningLoop(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.requireState(topicId, "DRAFT");
    this.core.requireParticipants(topic);

    topic = this.core.transition(topicId, "CLAUDE_PLAN", "Claude가 첫 계획을 작성합니다.");
    // 재시작(closeout 신규 쟁점 → DRAFT)이면 직전 계획 전문을 프롬프트에 그대로 싣는다 — 새 세션은 타임라인만 받아 본문을 잃는다.
    const previousPlanMarkdown = await this.core.dependencies.artifacts.readLatest(topicId, "plan");
    const claudePlan = await this.core.turn("claude", topic, buildClaudePlanPrompt({
      title: topic.title, worktreePath: topic.worktreePath, sourceRepositoryPath: topic.repositoryPath,
      baseRef: topic.baseRef,
      scopeGeneration: topic.scopeGeneration,
      timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration),
      previousPlanMarkdown,
      deferredFindings: await this.core.deferredFindingsFor(topicId),
    }), signal, false, {
      planMode: true,
      // 계약 위반(kind·계획 본문 형식)은 같은 세션 1회 교정으로 회수한다 — 멈추는 응답은 계획이 없어도 정당.
      check: (r) => {
        this.core.assertKind(r, "PLAN");
        if (!this.core.resultRequestsPause(r)) this.core.requirePlan(r);
      },
    });
    const firstPlan = this.core.resultRequestsPause(claudePlan) ? null : this.core.requirePlan(claudePlan);
    await this.core.saveAgentOutput(topic, "claude", claudePlan, "claude-plan", signal);
    if (this.core.pauseForResult(topicId, claudePlan, "CLAUDE_PLAN", "계획을 확정하려면 사용자 결정이 필요합니다.")) return;
    if (firstPlan === null) throw new Error("계획 검증 경로 불변식 위반: pause 예측이 어긋났습니다.");
    const storedFirstPlan = await this.savePlan(topic, firstPlan, 1, signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;

    await this.runPlanningFromAudit(topicId, claudePlan, storedFirstPlan, signal);
  }

  // 계획 턴이 requestedUserDecision 으로 멈춘 뒤(claude-plan 산출물은 저장됨) 사용자 결정이 올라왔으면, 그 계획을
  // 그대로 저장하고 감사로 넘긴다 — 계획 턴을 다시 사지 않는다(2026-09-07 S10 #17: "더 필요한 결정 없음" 안내문이
  // requestedUserDecision 에 담겨 $3~17 짜리 계획 턴이 반복될 뻔했다). 결정은 타임라인으로 감사·개정 턴에 전달된다.
  // 전이표가 USER_DECISION_REQUIRED → CODEX_AUDIT 를 막으므로 CLAUDE_PLAN 을 거쳐 간다. 계획 본문이 없거나
  // 계약 위반이면(멈춘 응답은 계획이 없어도 정당) 종전대로 처음부터 다시 돈다.
  pausedPlanReusable(topicId: string): boolean {
    return this.pausedResultReusable(topicId, "claude-plan");
  }

  // 필수 쟁점 잔존 인터럽트 뒤의 사용자 결정에 REPLAN 이 있으면 처음부터 다시 돈다(핵심 전제가 바뀐 경우).
  replanRequested(topicId: string): boolean {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    const events = database.getTimeline(topicId).filter((event) => event.scopeGeneration === topic.scopeGeneration);
    let lastInterrupt = -1;
    events.forEach((event, index) => {
      if (event.actor === "system" && Array.isArray(event.payload?.closeoutEssentialFindingIDs)) lastInterrupt = index;
    });
    if (lastInterrupt < 0) return false;
    return events.slice(lastInterrupt + 1)
      .some((event) => event.actor === "user" && event.kind === "decision" && replanDirective(event.body));
  }

  // 개정 턴도 같다(2026-09-07 S10 #31: 배치 순서 확인 하나로 $11·35분짜리 개정 턴이 반복될 뻔했다).
  pausedRevisionReusable(topicId: string): boolean {
    return this.pausedResultReusable(topicId, "claude-revision");
  }

  private pausedResultReusable(topicId: string, kind: "claude-plan" | "claude-revision"): boolean {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    if (topic.state !== "USER_DECISION_REQUIRED") return false;
    const stored = database.latestArtifact(topicId, kind);
    if (!stored || stored.scopeGeneration !== topic.scopeGeneration) return false;
    // 그 산출물이 **멈춘 턴 자신의 것**이어야 한다. 종결 확인이 새 쟁점을 내 resume=CLAUDE_PLAN 으로 재시작을 지시한
    // 경우에도 옛 claude-plan 은 남아 있다 — 그걸 재사용하면 새 쟁점을 반영할 기회 없이 감사로 되돌아간다.
    // 뒤 단계 산출물(감사·개정·종결)이 더 최신이면 재사용 대상이 아니다.
    const laterKinds = kind === "claude-plan" ? ["audit", "claude-revision", "closeout"] : ["closeout"];
    for (const later of laterKinds) {
      const artifact = database.latestArtifact(topicId, later);
      if (artifact && artifact.scopeGeneration === topic.scopeGeneration && artifact.revision > stored.revision) return false;
    }
    const decided = database.getTimeline(topicId, stored.revision)
      .some((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    return decided;
  }

  async resumePlanningFromPausedRevision(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.requireState(topicId, "USER_DECISION_REQUIRED");
    this.core.requireParticipants(topic);
    const storedFirstPlan = await this.storedPlanForResume(topicId);
    const stored = this.core.dependencies.database.latestArtifact(topicId, "claude-revision");
    const revision = await this.core.latestResult(topicId, "claude-revision");
    let revisedPlan: string;
    try {
      revisedPlan = this.core.requireRevisedPlan(revision, storedFirstPlan.markdown);
    } catch {
      // 멈춘 개정 응답에 개정본이 없으면 종전대로 개정 턴을 다시 돈다.
      return this.resumePlanningAtRevision(topicId, signal);
    }
    const secondRound = this.core.dependencies.database.getFlags(topicId).closeoutRevisionUsed;
    topic = this.core.transition(topicId, "CLAUDE_REVISION",
      `결정이 올라온 저장된 개정(#${stored?.revision ?? "?"})을 재사용해 종결 확인으로 넘깁니다 — 개정 턴을 다시 사지 않습니다.`);
    const storedRevisedPlan = await this.savePlan(topic, revisedPlan, topic.planRevision + 1, signal);
    const known = secondRound ? await this.roundKnownFindings(topicId) : revision.findings;
    await this.runPlanningFromCloseout(topicId, revision, storedRevisedPlan, signal, known);
  }

  async resumePlanningFromPausedPlan(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.requireState(topicId, "USER_DECISION_REQUIRED");
    this.core.requireParticipants(topic);
    const stored = this.core.dependencies.database.latestArtifact(topicId, "claude-plan");
    const claudePlan = await this.core.latestResult(topicId, "claude-plan");
    let plan: string;
    try {
      plan = this.core.requirePlan(claudePlan);
    } catch {
      this.core.resetToDraft(topic, "멈춘 계획 응답에 재사용할 계획 본문이 없어 처음부터 다시 실행합니다.");
      return this.runPlanningLoop(topicId, signal);
    }
    topic = this.core.transition(topicId, "CLAUDE_PLAN",
      `결정이 올라온 저장된 계획(#${stored?.revision ?? "?"})을 재사용해 감사로 넘깁니다 — 계획 턴을 다시 사지 않습니다.`);
    const storedFirstPlan = await this.savePlan(topic, plan, 1, signal);
    await this.runPlanningFromAudit(topicId, claudePlan, storedFirstPlan, signal);
  }

  // 저장된 계획으로 감사부터 다시 시작한다. 계획 턴이 결과를 냈는데 그다음이 인프라 오류로 죽었을 때
  // 계획을 버리고 Claude를 처음부터 돌리면 같은 계획을 다시 만드느라 비용만 든다. 왕복 횟수는 늘지 않는다 —
  // 결과를 낸 적 없는 감사 회차를 완료시키는 것이기 때문이다.
  // 재개용으로 저장된 계획과 그 해시를 되살린다. topic.planSHA256에 기대지 않는다 — 중단이 resetToDraft를
  // 거치면 그 값이 지워지지만 아티팩트는 남기 때문이다. 해시는 저장할 때와 같은 방식으로 본문에서 다시 계산한다.
  private async storedPlanForResume(topicId: string): Promise<{ markdown: string; sha256: string }> {
    const markdown = await this.core.requireStoredPlan(topicId);
    return { markdown, sha256: hashPlan(markdown) };
  }

  async resumePlanningAtAudit(topicId: string, signal: AbortSignal): Promise<void> {
    this.core.requireParticipants(this.core.dependencies.database.getTopic(topicId));
    const stored = await this.storedPlanForResume(topicId);
    const claudePlan = await this.core.latestResult(topicId, "claude-plan");
    await this.runPlanningFromAudit(topicId, claudePlan, stored, signal);
  }

  private async runPlanningFromAudit(
    topicId: string,
    claudePlan: AgentResult,
    storedFirstPlan: { markdown: string; sha256: string },
    signal: AbortSignal,
  ): Promise<void> {
    let topic = this.core.transition(topicId, "CODEX_AUDIT", "Codex가 계획을 읽기 전용으로 감사합니다.");
    const context = await preparePlanningContext(this.core, topic, storedFirstPlan.markdown, storedFirstPlan.sha256);
    const prompt = buildCodexAuditPrompt({
      title: topic.title, planMarkdown: context.text, planSHA256: storedFirstPlan.sha256,
      scopeGeneration: topic.scopeGeneration,
      timeline: context.timeline,
      planningContextMode: context.mode,
      claudePlan,
      deferredFindings: await this.core.deferredFindingsFor(topicId),
    });
    const audit = await this.core.turn("codex", topic, prompt, signal, false, {
      readablePaths: context.readablePaths,
      check: (r) => {
        this.core.assertKind(r, "AUDIT");
        assertFindingCoverage(claudePlan.findings, r.findings, "Codex audit");
      },
    });
    await this.core.saveAgentOutput(topic, "codex", audit, "audit", signal);
    if (this.core.interruptForNewUserInput(topic, context.inputSequence)) return;
    await context.accept(signal, prompt);
    if (this.core.interruptForNewUserInput(topic, context.inputSequence)) return;
    if (this.core.pauseForResult(topicId, audit, "CODEX_AUDIT", "계획 검토에 사용자 결정이나 외부 증거가 필요합니다.")) return;

    await this.runPlanningFromRevision(topicId, audit, storedFirstPlan, signal);
  }

  // 감사가 사용자 결정을 요구해 멈췄다가 결정이 들어온 경우의 재개 지점이다. 같은 계획을 다시 감사하는 것은
  // 의미가 없고(전이표도 USER_DECISION_REQUIRED → CODEX_AUDIT를 막는다), 저장된 감사 결과와 새 결정을
  // 합쳐 계획을 고치는 것이 다음 단계다. 계획 턴도 감사 턴도 다시 돌지 않는다.
  async resumePlanningAtRevision(topicId: string, signal: AbortSignal): Promise<void> {
    this.core.requireParticipants(this.core.dependencies.database.getTopic(topicId));
    const stored = await this.storedPlanForResume(topicId);
    if (this.core.dependencies.database.getFlags(topicId).closeoutRevisionUsed) {
      // 개정 2회차 도중 죽었다 — 감사가 아니라 종결 확인의 새 쟁점을 다시 반영한다(기존 계획 = 2판).
      const closeout = await this.core.latestResult(topicId, "closeout");
      const known = await this.roundKnownFindings(topicId);
      const { essential } = classifyCloseoutAdditions(known, closeout);
      if (essential.length === 0) return this.resumePlanningAtCloseout(topicId, signal);
      await this.runPlanningFromRevision2(topicId, closeout, essential.map((finding) => finding.id), stored, known, signal);
      return;
    }
    const audit = await this.core.latestResult(topicId, "audit");
    await this.runPlanningFromRevision(topicId, audit, stored, signal);
  }

  // 이 바퀴에서 Claude 가 처분한 쟁점 전부 — 개정 1회차(감사 답변) + 개정 2회차(종결 새 쟁점 답변).
  // 종결 확인이 "새 쟁점" 을 판정하는 기준 집합이다. 개정 2회차를 열지 않았으면 최신 개정 하나뿐이다.
  private async roundKnownFindings(topicId: string): Promise<Finding[]> {
    const flags = this.core.dependencies.database.getFlags(topicId);
    const latest = await this.core.latestResult(topicId, "claude-revision");
    if (!flags.closeoutRevisionUsed) return latest.findings;
    const previousRaw = await this.core.dependencies.artifacts.readPrevious(topicId, "claude-revision");
    const previous = previousRaw ? AgentResultSchema.parse(JSON.parse(previousRaw)) : null;
    return uniqueFindings([...(previous?.findings ?? []), ...latest.findings]);
  }

  private async runPlanningFromRevision(
    topicId: string,
    audit: AgentResult,
    storedFirstPlan: { markdown: string; sha256: string },
    signal: AbortSignal,
  ): Promise<void> {
    let topic = this.core.transition(topicId, "CLAUDE_REVISION", "Claude가 감사 결과를 한 번 반영합니다.");
    // 일회용 세션으로 돈다(freshSession). buildClaudeRevisionPrompt가 계획 전문·감사 전문·타임라인·
    // 처분 계약을 전부 담으므로 합의 대화 이력이 없어도 판단에 필요한 것이 부족하지 않다.
    const revision = await this.core.turn("claude", topic, buildClaudeRevisionPrompt({
      planMarkdown: storedFirstPlan.markdown, audit, scopeGeneration: topic.scopeGeneration,
      timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration),
    }), signal, false, {
      freshSession: true, planMode: audit.findings.length === 0,
      check: (r) => {
        this.core.assertKind(r, "REVISION");
        assertFindingCoverage(audit.findings, r.findings, "Claude revision");
        assertDispositionsResolved(audit.findings, r, "Claude revision");
        if (!this.core.resultRequestsPause(r)) this.core.requireRevisedPlan(r, storedFirstPlan.markdown);
      },
    });
    const revisedPlan = this.core.resultRequestsPause(revision)
      ? null : this.core.requireRevisedPlan(revision, storedFirstPlan.markdown);
    await this.core.saveAgentOutput(topic, "claude", revision, "claude-revision", signal);
    if (this.core.pauseForResult(topicId, revision, "CLAUDE_REVISION", "계획을 고치려면 사용자 결정이나 외부 증거가 필요합니다.")) return;
    if (revisedPlan === null) throw new Error("개정 검증 경로 불변식 위반: pause 예측이 어긋났습니다.");
    const storedRevisedPlan = await this.savePlan(topic, revisedPlan, 2, signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;

    await this.runPlanningFromCloseout(topicId, revision, storedRevisedPlan, signal);
  }

  async resumePlanningAtCloseout(topicId: string, signal: AbortSignal): Promise<void> {
    const { markdown, sha256 } = await this.storedPlanForResume(topicId);
    const revision = await this.core.latestResult(topicId, "claude-revision");
    await this.runPlanningFromCloseout(topicId, revision, { markdown, sha256 }, signal, await this.roundKnownFindings(topicId));
  }

  // 종결 확인의 새 쟁점만 반영하는 개정 2회차(2026-09-07, 사용자 결정 "개정 2회차로 바꿔"). 처음부터 다시 도는 대신
  // 앞으로 한 칸 더 간다: 2판 위에 planEdits 로 새 쟁점만 반영해 3판을 만들고 종결 확인을 다시 한다. 바퀴당 1회 —
  // 그 뒤에도 새 쟁점이 나오면 종전대로 사용자 결정 뒤 처음부터 다시 돈다.
  private async runPlanningFromRevision2(
    topicId: string,
    closeout: AgentResult,
    newIDs: readonly string[],
    storedRevisedPlan: { markdown: string; sha256: string },
    knownFindings: readonly Finding[],
    signal: AbortSignal,
  ): Promise<void> {
    const source: AgentResult = { ...closeout, findings: closeout.findings.filter((finding) => newIDs.includes(finding.id)) };
    const roundLabel = this.core.dependencies.database.getTopic(topicId).planRevision >= 3 ? "추가 개정" : "개정 2회차";
    let topic = this.core.transition(topicId, "CLAUDE_REVISION",
      `종결 확인의 필수 쟁점(${newIDs.join(", ")})을 ${roundLabel}로 최신 계획 위에 반영합니다 — 처음부터 다시 돌지 않습니다.`);
    const revision = await this.core.turn("claude", topic, buildClaudeRevisionPrompt({
      planMarkdown: storedRevisedPlan.markdown, audit: source, scopeGeneration: topic.scopeGeneration,
      timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration),
      source: "closeout",
    }), signal, false, {
      freshSession: true, planMode: false,
      check: (r) => {
        this.core.assertKind(r, "REVISION");
        assertFindingCoverage(source.findings, r.findings, "Claude revision(2회차)");
        assertDispositionsResolved(source.findings, r, "Claude revision(2회차)");
        if (!this.core.resultRequestsPause(r)) this.core.requireRevisedPlan(r, storedRevisedPlan.markdown);
      },
    });
    const revisedPlan = this.core.resultRequestsPause(revision)
      ? null : this.core.requireRevisedPlan(revision, storedRevisedPlan.markdown);
    await this.core.saveAgentOutput(topic, "claude", revision, "claude-revision", signal);
    if (this.core.pauseForResult(topicId, revision, "CLAUDE_REVISION", "개정 2회차에 사용자 결정이나 외부 증거가 필요합니다.")) return;
    if (revisedPlan === null) throw new Error("개정 2회차 검증 경로 불변식 위반: pause 예측이 어긋났습니다.");
    const storedNextPlan = await this.savePlan(topic, revisedPlan, topic.planRevision + 1, signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;
    await this.runPlanningFromCloseout(topicId, revision, storedNextPlan, signal, uniqueFindings([...knownFindings, ...revision.findings]));
  }

  private async runPlanningFromCloseout(
    topicId: string,
    revision: AgentResult,
    storedRevisedPlan: { markdown: string; sha256: string },
    signal: AbortSignal,
    knownFindings: readonly Finding[] = revision.findings,
  ): Promise<void> {
    const secondRound = this.core.dependencies.database.getFlags(topicId).closeoutRevisionUsed;
    let topic = this.core.transition(topicId, "CODEX_CLOSEOUT", secondRound
      ? "Codex가 개정 2회차 결과로 의견 수렴을 종료할 수 있는지 확인합니다."
      : "Codex가 의견 수렴을 종료할 수 있는지 확인합니다.");
    const context = await preparePlanningContext(this.core, topic, storedRevisedPlan.markdown, storedRevisedPlan.sha256);
    const prompt = buildCodexCloseoutPrompt({
      revisedPlan: context.text,
      revisedPlanSHA256: storedRevisedPlan.sha256,
      claudeRevision: revision,
      timeline: context.timeline,
      planningContextMode: context.mode,
      secondRound,
    });
    const closeout = await this.core.turn("codex", topic, prompt, signal, false, {
      readablePaths: context.readablePaths,
      check: (r) => {
        this.core.assertKind(r, "CLOSEOUT");
        assertFindingCoverage(revision.findings, r.findings, "Codex closeout");
      },
    });
    await this.core.saveAgentOutput(topic, "codex", closeout, "closeout", signal);
    if (this.core.interruptForNewUserInput(topic, context.inputSequence)) return;
    if (closeout.planSHA256 === storedRevisedPlan.sha256) await context.accept(signal, prompt);
    if (this.core.interruptForNewUserInput(topic, context.inputSequence)) return;
    // 새 쟁점은 발견 시점이 아니라 Codex 의 처분으로 분류한다(2026-09-07 Codex 피드백): 범위 밖(DEFERRED_OUT_OF_SCOPE·
    // AGREED_NO_ACTION)은 후속 목록에 기록만 하고 진행, 필수 쟁점은 개정 2회차(바퀴당 1회) → 그 뒤에도 남으면 최신 계획을
    // 보존한 채 사용자 결정 뒤 그 쟁점만 추가 개정. 처음부터 다시 도는 것은 결정에 REPLAN 을 적은 경우뿐이다.
    const { deferred, essential } = classifyCloseoutAdditions(knownFindings, closeout);
    if (deferred.length > 0) await this.core.recordDeferredFindings(topic, deferred, "closeout", signal);
    if (essential.length > 0) {
      const ids = essential.map((finding) => finding.id);
      if (!secondRound) {
        this.core.dependencies.database.updateTopic(topicId, { closeoutRevisionUsed: true });
        await this.runPlanningFromRevision2(topicId, closeout, ids, storedRevisedPlan, knownFindings, signal);
        return;
      }
      this.core.interrupt(
        topicId,
        "USER_DECISION_REQUIRED",
        `개정 2회차 뒤의 종결 확인에서도 필수 쟁점이 남았습니다(${ids.join(", ")}). 결정을 올리고 재시도하면 최신 계획(${this.core.dependencies.database.getTopic(topicId).planRevision}판) 위에 그 쟁점만 반영합니다. 계획의 핵심 전제가 바뀌었으면 결정에 REPLAN 을 적으세요 — 그때만 처음부터 다시 돕니다.`,
        "CLAUDE_REVISION",
        { closeoutEssentialFindingIDs: ids },
      );
      return;
    }
    const downgradedAtCloseout = dispositionRegressions(knownFindings, closeout.findings);
    if (downgradedAtCloseout.length > 0) {
      // 재개 지점은 CODEX_CLOSEOUT이다 — 되돌린 주체가 closeout이므로 종결 판정만 다시 하면 된다.
      // CLAUDE_PLAN으로 두면 retry가 전체 재계획으로 떨어져 그때까지의 개정 전부를 버린다
      // (2026-08-31 S0.2 실측: codex 필드 기입 오류 하나에 12개 개정 폐기 직전까지 감).
      // 전이표가 앞길을 막으면 retry 사다리가 CLAUDE_REVISION으로 내려가는데, 그것도 정확하다 —
      // 사용자 결정을 소비해 처분을 재기재하는 단계가 개정이기 때문이다.
      this.core.interrupt(
        topicId,
        "USER_DECISION_REQUIRED",
        `마지막 검토가 고치기로 합의한 쟁점의 처분을 되돌렸습니다(${downgradedAtCloseout.join(", ")}). 합의로 닫지 않고 계획 수렴을 다시 실행해야 합니다.`,
        "CODEX_CLOSEOUT",
      );
      return;
    }
    const classification = classifyCloseout(closeout);
    if (classification.state !== "CONSENSUS_ACK") {
      this.core.interrupt(
        topicId,
        classification.state,
        closeout.requestedUserDecision ?? "의견 수렴에 추가 증거나 사용자 결정이 필요합니다.",
        "CODEX_CLOSEOUT",
      );
      return;
    }
    if (closeout.planSHA256 !== storedRevisedPlan.sha256) throw new Error("Codex closeout의 계획 해시가 현재 plan.md와 다릅니다.");

    await this.runConsensusFinalization(topicId, closeout.findings, storedRevisedPlan.sha256, signal);
  }

  // ACK 턴이 인프라 오류로 죽었을 때의 재개 지점. 종결까지 끝난 상태이므로 계획·감사·개정·종결을
  // 하나도 다시 돌리지 않고 저장된 종결 결과로 확인 절차만 완료한다.
  async resumePlanningAtAck(topicId: string, signal: AbortSignal): Promise<void> {
    this.core.requireParticipants(this.core.dependencies.database.getTopic(topicId));
    const stored = await this.storedPlanForResume(topicId);
    const closeout = await this.core.latestResult(topicId, "closeout");
    if (closeout.planSHA256 !== stored.sha256) throw new Error("저장된 closeout의 계획 해시가 현재 plan.md와 다릅니다.");
    await this.runConsensusFinalization(topicId, closeout.findings, stored.sha256, signal);
  }

  private async runConsensusFinalization(
    topicId: string,
    closeoutFindings: AgentResult["findings"],
    sha256: string,
    signal: AbortSignal,
  ): Promise<void> {
    const topic = this.core.transition(topicId, "CONSENSUS_ACK", "두 에이전트가 같은 계획 해시를 확인합니다.");
    if (!await this.runAcknowledgements(topic, sha256, signal)) return;
    const acknowledged = this.core.dependencies.database.getTopic(topicId);
    if (!bothAgentsAcknowledged(acknowledged.participants, sha256)) {
      throw new Error("두 에이전트의 계획 ACK가 일치하지 않습니다.");
    }
    await this.core.writeArtifact(topic, "consensus", 1, JSON.stringify({
      planSHA256: sha256,
      scopeGeneration: acknowledged.scopeGeneration,
      planEpoch: acknowledged.planEpoch,
      findings: closeoutFindings,
      acknowledgedBy: ["claude", "codex"],
      createdAt: new Date().toISOString(),
    }, null, 2), signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;
    this.core.transition(topicId, "AWAITING_USER_APPROVAL", "계획 합의가 끝났습니다. 사용자 구현 승인을 기다립니다.");
  }

  private async runAcknowledgements(topic: Topic, sha256: string, signal: AbortSignal): Promise<boolean> {
    const planMarkdown = await this.core.requireStoredPlan(topic.id);
    for (const role of ["claude", "codex"] as const) {
      // 세션을 이어받지 않는다. ACK는 계획 본문과 기대 SHA만 있으면 끝나는 프로토콜 확인인데,
      // 기존 세션을 resume하면 합의 대화 전체를 다시 실어 나른다(2026-08-29 실측: 한 턴 $17.71,
      // cache creation 759K + cache read 1.5M + output 19,975).
      const result = await this.core.isolatedTurn(role, topic, buildPlanAckPrompt(sha256, planMarkdown), signal);
      this.core.assertKind(result, "ACK");
      await this.core.saveAgentOutput(topic, role, result, `${role}-ack`, signal);
      if (this.core.interruptForLatestTurnInput(topic)) return false;
      if (this.core.pauseForResult(topic.id, result, "CONSENSUS_ACK", `${role}가 계획 해시를 확인하지 못했습니다.`)) return false;
      if (result.planSHA256 !== sha256) throw new Error(`${role}가 현재 계획 해시를 ACK하지 않았습니다.`);
      this.core.dependencies.database.acknowledge(topic.id, role, sha256);
    }
    return true;
  }

  private async savePlan(
    topic: Topic,
    markdown: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<{ markdown: string; sha256: string }> {
    assertPlanContract(markdown);
    const normalized = normalizePlan(redactSecrets(markdown));
    const artifact = await this.core.writeArtifact(topic, "plan", revision, normalized, signal);
    this.core.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    this.core.dependencies.database.updateTopic(topic.id, {
      planRevision: revision, planSHA256: artifact.sha256, approvedPlanSHA256: null,
    });
    this.core.dependencies.database.clearAcknowledgements(topic.id);
    this.core.event(topic.id, "claude", "agent_output", `계획 ${revision}판을 저장했습니다.`, {
      artifactKind: "plan", revision, artifactRevision: artifact.revision, sha256: artifact.sha256,
    });
    return { markdown: normalized, sha256: artifact.sha256 };
  }
}

// 종결 확인이 낸 새 쟁점을 Codex 의 처분으로 나눈다: 범위 밖(기록만) vs 필수(개정으로 반영).
function classifyCloseoutAdditions(known: readonly Finding[], closeout: AgentResult): { deferred: Finding[]; essential: Finding[] } {
  const added = new Set(newFindingIDs(known, closeout.findings, "Codex closeout"));
  const additions = closeout.findings.filter((finding) => added.has(finding.id));
  const deferred = additions.filter((finding) =>
    finding.disposition === "DEFERRED_OUT_OF_SCOPE" || finding.disposition === "AGREED_NO_ACTION");
  const essential = additions.filter((finding) => !deferred.includes(finding));
  return { deferred, essential };
}

function uniqueFindings(findings: readonly Finding[]): Finding[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}
