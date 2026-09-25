import { normalizeToleranceBlocks } from "../../shared/tolerance.js";
// 계획 수렴 파이프라인: CLAUDE_PLAN → CODEX_AUDIT → CLAUDE_REVISION → CODEX_CLOSEOUT → CONSENSUS_ACK.
// 각 단계의 검증 순서(검증 → 메모리 반영 → pause → 저장)가 이 파일의 계약이다.
import { type AgentResult, type Topic, type TimelineEvent, AgentResultSchema, type Finding } from "../../shared/contracts.js";
import {
  buildClaudePlanPrompt,
  buildClaudeRevisionPrompt,
  buildCodexAuditPrompt,
  buildCodexCloseoutPrompt,
  buildDiagnosisPlanRevisionPrompt,
  buildPlanAckPrompt,
} from "../../shared/prompts.js";
import { applyInfo, diagnosisFinding, type DiagnosisRecord } from "../../shared/diagnoses.js";
import {
  assertDispositionsResolved,
  assertFindingCoverage,
  assertPlanContract,
  bothAgentsAcknowledged,
  classifyCloseout,
  dispositionRegressions,
  hashPlan,
  isMinorFinding,
  isSettledFinding,
  normalizePlan,
  redactSecrets, replanDirective,
  salvageResultFields,
} from "../../shared/workflow.js";
import type { EngineCore } from "./core.js";
import { preparePlanningContext } from "./planningContext.js";
import { classifyCloseoutAdditions, judgeCloseout } from "./findingJudgment.js";

const IMPLEMENTATION_NOTE_PREFIX = "구현 노트로 승계(엔진 자동, 개정 생략): ";

export function resumedPlanTimeline(timeline: readonly TimelineEvent[], previousPlanMarkdown: string | null,
  continuousSession: boolean, planEpoch: number): readonly TimelineEvent[] {
  if (!previousPlanMarkdown || !continuousSession) return timeline;
  const invalidationIndex = timeline.findIndex(event =>
    event.payload?.invalidatedPlanSHA256 && event.payload?.planEpoch === planEpoch);
  return invalidationIndex >= 0 ? timeline.slice(invalidationIndex) : timeline;
}

export class PlanningPipeline {
  constructor(private readonly core: EngineCore) {}

  async runPlanningLoop(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.requireState(topicId, "DRAFT");
    this.core.requireParticipants(topic);

    topic = this.core.transition(topicId, "CLAUDE_PLAN", "Claude가 첫 계획을 작성합니다.");
    // 재시작(closeout 신규 쟁점 → DRAFT)이면 직전 계획 전문을 프롬프트에 그대로 싣는다 — 새 세션은 타임라인만 받아 본문을 잃는다.
    const previousPlanMarkdown = await this.core.dependencies.artifacts.readLatest(topicId, "plan");
    const fullTimeline = this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration);
    // 승인 대기 중 새 결정으로 계획만 무효화한 경우, 직전 계획 전문과 그 계획을 만든
    // 이전 대화를 함께 다시 싣지 않는다. 무효화 결정 이후만 보내되 직전 계획은 보존한다.
    const continuousSession = previousPlanMarkdown
      ? this.core.dependencies.database.planning.continuesPriorPlan(topic, hashPlan(previousPlanMarkdown))
      : false;
    const timeline = resumedPlanTimeline(fullTimeline, previousPlanMarkdown, continuousSession, topic.planEpoch);
    const claudePlan = await this.core.turn("claude", topic, buildClaudePlanPrompt({
      title: topic.title, worktreePath: topic.worktreePath, sourceRepositoryPath: topic.repositoryPath,
      baseRef: topic.baseRef,
      scopeGeneration: topic.scopeGeneration,
      timeline,
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

  // ---- 중재자 진단의 계획 개정(2026-09-14 진단 계획 §2) -------------------------------------------------------------------
  // 계획 변경이 필요한 진단을 적용하면 공통 재시도 사다리의 첫 분기가 여기로 온다. 승인 계획(승계 기록의 기준본)을 진단·현재 코드·남은 작업에 맞춰 고친
  // 개정 계획을 저장하고(승인·ACK 무효화·새 주기 회차 초기화 — markPlanRevised, 한 transaction), 기존 감사 → 개정 → 종결 → ACK → 사용자 승인으로 넘긴다.
  // 작업 트리·브랜치·구현 기준 커밋·미커밋 변경·구현 세션은 건드리지 않는다(범위 변경 경로가 아니다). 원 응답은 diagnosis-plan-revision, 개정본 전문을
  // 담은 PLAN 결과는 claude-plan 으로 저장한다 — 감사·재개 사다리(pausedPlanReusable·resumePlanningAtAudit)가 그대로 읽는다.
  async runDiagnosisPlanRevision(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.dependencies.database.getTopic(topicId);
    this.core.requireParticipants(topic);
    const record = this.core.diagnoses.pendingPlanRevision(topicId);
    if (!record) throw new Error("진단 계획 개정을 열 계획 변경 진단이 없습니다.");
    const carry = await this.core.diagnoses.planRevisionCarry(record);
    if (hashPlan(carry.basePlan) !== carry.basePlanSHA256) throw new Error(`계획 변경 진단 ${record.id} 의 기준 계획 해시가 맞지 않습니다(승계 기록 손상).`);
    const delivered = await this.core.diagnoses.prompts([record]);
    const carryPath = await this.core.diagnoses.carryPath(record);
    const finding = diagnosisFinding(record);
    const label = "Claude 계획 개정(중재자 진단)";
    const salvaged = await this.salvagedRevisionAfterApply(topic, record);
    topic = this.core.transition(topicId, "CLAUDE_PLAN",
      `중재자 진단 ${record.id} 로 승인 계획을 개정합니다 — 작업 트리·브랜치·구현 기준 커밋·미커밋 변경은 그대로 둡니다. 개정 계획은 감사·종결 확인·ACK·사용자 승인을 거친 뒤에만 구현으로 돌아갑니다.`);
    // 앞 개정 턴의 반박이 계약 교정 도중 끊겨 교정 원본에만 남았으면 새 턴을 열지 않고 기록한 뒤 중재자에게 돌려보낸다 — runWork 의 복구 시점 검사와 같은
    // 규칙이다(2026-09-15 감사: retry 가 같은 지시로 개정 턴을 다시 사 재작성 한도를 소진했다).
    if (salvaged) {
      const recovered = this.core.diagnoses.returnedBy([record], salvaged);
      if (recovered.length > 0) {
        const message = this.core.diagnoses.recordReturned(topicId, recovered, "진단 계획 개정 턴(교정 도중 끊긴 응답)");
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", message, "CLAUDE_PLAN", { diagnosisReturned: recovered.map((item) => item.record.id) });
        return;
      }
    }
    const known = await this.knownPlanningContext(topic);
    const revision = await this.core.turn("claude", topic, buildDiagnosisPlanRevisionPrompt({
      knownPlan: known.knownPlan,
      planMarkdown: carry.basePlan, scopeGeneration: topic.scopeGeneration, worktreePath: topic.worktreePath, branchName: topic.branchName ?? "-",
      diagnoses: delivered.prompts,
      carry: {
        remainingSteps: carry.remainingSteps, openRequests: carry.openRequests, changedPaths: carry.changedPaths,
        lastSummary: carry.lastSummary, verifiedLedgerRows: carry.verifiedLedger.length,
      },
      timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, known.inputSequence),
    }), signal, false, {
      // 읽기 전용 개정은 revision으로 집계한다. 서버 제어 계획에서는 작성 세션을 유지한다.
      freshSession: !this.core.dependencies.database.planning.continuityEnabled(topic.id), planMode: true, planBase: carry.basePlan, planningWrite: "revision",
      // 교정 대기본(pending-contract-repair)은 이 진단의 이 적용 시도에만 결속한다 — 정정한 새 진단의 개정 턴이 앞 진단의 응답을 재사용해 새 진단 원문이
      // 러너에게 한 번도 전달되지 않았다(2026-09-15 감사 2차).
      repairContextKey: `diagnosis-plan-revision:${record.id}#${applyInfo(record)?.seq ?? 0}`,
      readablePaths: [...known.readablePaths, ...delivered.paths, ...(carryPath ? [carryPath] : [])],
      check: (r) => {
        this.core.assertKind(r, "REVISION");
        assertFindingCoverage([finding], r.findings, label);
        assertDispositionsResolved([finding], r, label);
        const verdict = r.findings.find((item) => item.id === record.id);
        if (!verdict || verdict.disposition !== "AGREED_ACTION" || verdict.requiresUserDecision || this.core.resultRequestsPause(r)) return;
        const revised = this.core.requireRevisedPlan(r, carry.basePlan);
        if (normalizePlan(revised) === normalizePlan(carry.basePlan)) {
          throw new Error(`계획 변경이 필요한 진단 ${record.id} 를 AGREED_ACTION 으로 처분했지만 개정이 계획을 바꾸지 않았습니다 — 진단이 요구하는 변경을 planLineEdits 로 반영하거나, 변경이 필요 없다고 판단하면 REFUTED 로 처분하세요.`);
        }
      },
    });
    // 반박·증거 요청은 계획을 고치지 않고 중재자에게 돌아간다(같은 지시를 자동으로 반복하지 않는다). 기록은 산출물 저장보다 먼저다 — 저장 도중 끊겨도
    // 반박을 잃지 않는다(2026-09-15 감사). 인터럽트는 저장 뒤다(인터럽트 뒤의 쓰기는 늦은 산출물로 버려진다).
    const returned = this.core.diagnoses.returnedBy([record], revision);
    const returnMessage = returned.length > 0 ? this.core.diagnoses.recordReturned(topicId, returned, "진단 계획 개정 턴") : null;
    await this.core.saveAgentOutput(topic, "claude", revision, "diagnosis-plan-revision", signal, { diagnosisPlanRevision: record.id });
    if (returnMessage) {
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", returnMessage, "CLAUDE_PLAN", { diagnosisReturned: returned.map((item) => item.record.id) });
      return;
    }
    if (this.core.pauseForResult(topicId, revision, "CLAUDE_PLAN", "계획 개정에 사용자 결정이나 외부 증거가 필요합니다.")) return;
    const revised = this.core.requireRevisedPlan(revision, carry.basePlan);
    const planResult: AgentResult = {
      kind: "PLAN", summary: revision.summary, findings: revision.findings, evidenceRefs: revision.evidenceRefs, planMarkdown: revised,
    };
    await this.core.writeArtifact(topic, "claude-plan", this.core.dependencies.database.timelineCount(topicId) + 1, JSON.stringify(planResult, null, 2), signal);
    const stored = await this.saveDiagnosisRevisedPlan(topic, revised, record, carry.basePlanSHA256, signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;
    await this.runPlanningFromAudit(topicId, planResult, stored, signal);
  }

  private async saveDiagnosisRevisedPlan(
    topic: Topic, markdown: string, record: DiagnosisRecord, previousPlanSHA256: string, signal: AbortSignal,
  ): Promise<{ markdown: string; sha256: string }> {
    assertPlanContract(markdown);
    const normalized = normalizePlan(normalizeToleranceBlocks(redactSecrets(markdown)));
    // 계획 산출물 revision 은 증가 순서로 둔다(허용 오차 개정이 planRevision 과 무관하게 올린다). planRevision 은 판 번호(표시)다.
    const artifactRevision = this.core.dependencies.database.latestArtifactRevision(topic.id, "plan") + 1;
    const artifact = await this.core.writeArtifact(topic, "plan", artifactRevision, normalized, signal);
    this.core.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    this.core.diagnoses.markPlanRevised(topic, record, {
      planRevision: topic.planRevision + 1, sha256: artifact.sha256, previousPlanSHA256, artifactRevision: artifact.revision,
    });
    this.bindPlanningSession(topic, artifact.sha256);
    return { markdown: normalized, sha256: artifact.sha256 };
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

  // 진단 계획 개정이 저장된 직후(감사 전)에 멈췄으면 저장된 개정 계획으로 감사부터 잇는다 — 개정 턴을 다시 사지 않고, 전체 재계획으로 떨어져 저장된 개정을
  // 버리지도 않는다(2026-09-15 감사). 멈춘 상태에서 감사로 곧장 가는 전이가 없으므로 계획 턴 단계를 거친다.
  async resumeSavedDiagnosisRevision(topicId: string, signal: AbortSignal): Promise<void> {
    this.core.transition(topicId, "CLAUDE_PLAN", "저장된 진단 개정 계획으로 감사부터 이어갑니다 — 개정 턴을 다시 사지 않습니다.");
    await this.resumePlanningAtAudit(topicId, signal);
  }

  // 이 진단의 마지막 적용 뒤, 같은 세대·같은 기준 계획으로 계약 교정에 들어간 개정 응답(교정 원본) — 교정이 끝나기 전에 끊겼으면 이것만 남는다.
  private async salvagedRevisionAfterApply(topic: Topic, record: DiagnosisRecord): Promise<AgentResult | null> {
    const applied = [...record.history].reverse().find((entry) => entry.status === "applied");
    const artifact = this.core.dependencies.database.latestArtifact(topic.id, "contract-repair-source");
    if (!applied || !artifact || artifact.createdAt < applied.at) return null;
    // 교정이 끝나 개정 턴 결과가 저장됐으면(교정 재제출이 반박을 철회했을 수 있다) 교정 원본을 재생하지 않는다 — 원본은 교정 도중 끊긴 경우에만 쓴다
    // (2026-09-15 감사 2차: 교정이 결정 요청으로 멈춘 뒤 retry 가 철회된 반박을 refuted 로 기록했다).
    const completed = this.core.dependencies.database.latestArtifact(topic.id, "diagnosis-plan-revision");
    if (completed && completed.createdAt >= artifact.createdAt) return null;
    try {
      const raw = await this.core.dependencies.artifacts.readLatest(topic.id, "contract-repair-source");
      const parsed = raw ? JSON.parse(raw) as { state?: string; scopeGeneration?: number; planSHA256?: string | null; original?: unknown } : null;
      if (!parsed || parsed.state !== "CLAUDE_PLAN" || parsed.scopeGeneration !== topic.scopeGeneration || parsed.planSHA256 !== topic.planSHA256) return null;
      return salvageResultFields(parsed.original, "REVISION");
    } catch {
      return null;
    }
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
    // 진단 계획 개정 뒤의 감사면 진단 원문·이전 승인 계획·이미 바뀐 파일을 함께 싣는다(구현 도중의 개정).
    const revisionContext = await this.core.diagnoses.revisionAuditContext(topicId);
    const deferredFindings = await this.core.deferredFindingsFor(topicId);
    const auditPrompt = (text: string, timeline: typeof context.timeline, planningContextMode: typeof context.mode) => buildCodexAuditPrompt({
      title: topic.title, planMarkdown: text, planSHA256: storedFirstPlan.sha256,
      scopeGeneration: topic.scopeGeneration,
      timeline,
      planningContextMode,
      claudePlan,
      deferredFindings,
      diagnosisRevision: revisionContext?.context,
    });
    const prompt = auditPrompt(context.text, context.timeline, context.mode);
    const audit = await this.core.turn("codex", topic, prompt, signal, false, {
      // 변경분은 커서를 기록한 세션에서만 유효하다 — 계획 제어가 새 감사 세션으로 바꾸면 전체 문맥 판을 쓴다(host-review a7a9ce86 F-001).
      freshSessionPrompt: context.full ? auditPrompt(context.full.text, context.full.timeline, "full") : undefined,
      readablePaths: [...context.readablePaths, ...(revisionContext?.paths ?? [])],
      normalize: this.core.carryForwardNormalizer(claudePlan.findings, "Codex audit", { forReview: true }),
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

    // 2026-09-13 사용자 규칙: 감사 지적이 전부 경미(MEDIUM 이하)이거나 이미 판단이 끝난 것이면 개정 턴을 사지 않는다 —
    // 경미 지적은 구현 노트로 러너에게 넘기고(AGREED_ACTION 으로 승계), 계획은 그대로 종결 확인으로 간다.
    const actionable = audit.findings.filter((finding) => !isSettledFinding(finding));
    if (actionable.length > 0 && actionable.every(isMinorFinding)) {
      const carried = actionable.map((finding) => ({
        ...finding, disposition: "AGREED_ACTION" as const, requiresUserDecision: false,
        rationale: `${IMPLEMENTATION_NOTE_PREFIX}${finding.rationale}`,
      }));
      await this.core.recordImplementationNotes(topic, actionable, "audit", signal);
      const synthetic: AgentResult = {
        kind: "REVISION", summary: "감사 지적이 전부 경미해 개정을 생략했습니다(엔진 자동) — 경미 지적은 구현 노트로 러너에게 넘어갑니다.",
        findings: uniqueFindings([...audit.findings.filter((finding) => isSettledFinding(finding)), ...carried]),
        evidenceRefs: [], planEdits: [],
      };
      const revision = this.core.dependencies.database.timelineCount(topicId) + 1;
      await this.core.writeArtifact(topic, "claude-revision", revision, JSON.stringify(synthetic, null, 2), signal);
      this.core.event(topicId, "system", "system",
        `감사 지적 ${actionable.length}건이 전부 경미(MEDIUM 이하)라 개정 턴을 생략합니다 — 구현 노트로 러너에게 넘기고 종결 확인으로 갑니다: ${actionable.map((finding) => finding.id).join(", ")}`,
        { skippedRevision: true, implementationNoteIDs: actionable.map((finding) => finding.id) });
      await this.runPlanningFromCloseout(topicId, synthetic, storedFirstPlan, signal);
      return;
    }

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
      const { essential, minor } = classifyCloseoutAdditions(known, closeout);
      if (minor.length > 0) await this.core.recordImplementationNotes(this.core.dependencies.database.getTopic(topicId), minor, "closeout", signal);
      // 처분을 되돌린 쟁점도 추가 개정의 대상이다 — 결정을 소비해 처분을 재기재하는 단계가 개정이기 때문이다.
      const ids = [...new Set([...essential.map((finding) => finding.id), ...dispositionRegressions(known, closeout.findings)])];
      if (ids.length === 0) {
        // 남은 것이 경미 지적뿐이면(배포 전 엔진이 필수로 분류했던 것) 저장된 종결로 합의를 마친다 — 종결 재실행은 전이표가 막는다.
        if (closeout.planSHA256 === stored.sha256 && classifyCloseout(closeout).state === "CONSENSUS_ACK") {
          return this.runConsensusFinalization(topicId, closeout.findings, stored.sha256, signal);
        }
        return this.resumePlanningAtCloseout(topicId, signal);
      }
      await this.runPlanningFromRevision2(topicId, closeout, ids, stored, known, signal);
      return;
    }
    const audit = await this.core.latestResult(topicId, "audit");
    await this.runPlanningFromRevision(topicId, audit, stored, signal);
  }

  // 이 바퀴에서 Claude 가 처분한 쟁점 전부 — 최신 감사 뒤의 개정 전부(1회차 감사 답변 + 2회차·추가 개정의 종결 새 쟁점 답변).
  // 종결 확인이 "새 쟁점"·"처분 되돌림" 을 판정하는 기준 집합이다. 개정 2회차를 열지 않았으면 최신 개정 하나뿐이다.
  // 결정 뒤 추가 개정(3회차 이상)이 이어질 수 있어 최근 두 개만 읽으면 1회차 합의가 빠진다 — 재개한 종결이 그 합의를 내려도
  // 되돌림 가드가 보지 못했다(host-review 1b40ea64 F-005). 연속 실행의 누적(runPlanningFromRevision2)과 같은 순서로 합친다(나중 개정이 같은 id 를 덮는다).
  // 산출물 revision 은 저장 시점의 타임라인 순번이라 종류를 넘어 순서를 비교한다(pausedResultReusable 과 같은 규칙).
  // 재개 정보(resume)의 종결 판정도 이 집합을 쓴다 — 부작용 없음.
  async roundKnownFindings(topicId: string): Promise<Finding[]> {
    const { database, artifacts } = this.core.dependencies;
    const latest = await this.core.latestResult(topicId, "claude-revision");
    if (!database.getFlags(topicId).closeoutRevisionUsed) return latest.findings;
    const audit = database.latestArtifact(topicId, "audit");
    const round = database.artifactsForScope(topicId, "claude-revision")
      .filter((artifact) => !audit || artifact.revision > audit.revision)
      .reverse();
    const results = await Promise.all(round.map(async (artifact) => {
      const stored = await artifacts.verifiedByRevision(topicId, "claude-revision", artifact.revision);
      if (!stored) throw new Error(`개정 산출물 #${artifact.revision} 을 읽을 수 없습니다.`);
      return AgentResultSchema.parse(JSON.parse(stored.content));
    }));
    return uniqueFindings(results.flatMap((result) => result.findings));
  }

  private async runPlanningFromRevision(
    topicId: string,
    audit: AgentResult,
    storedFirstPlan: { markdown: string; sha256: string },
    signal: AbortSignal,
  ): Promise<void> {
    let topic = this.core.transition(topicId, "CLAUDE_REVISION", "Claude가 감사 결과를 한 번 반영합니다.");
    // 서버 제어 계획은 기존 Claude 세션을 이어 쓴다. 기존 토픽의 실행 방식은 유지한다.
    const known = await this.knownPlanningContext(topic);
    const revision = await this.core.turn("claude", topic, buildClaudeRevisionPrompt({
      knownPlan: known.knownPlan,
      planMarkdown: storedFirstPlan.markdown, audit, scopeGeneration: topic.scopeGeneration,
      timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, known.inputSequence),
    }), signal, false, {
      readablePaths: known.readablePaths,
      freshSession: !this.core.dependencies.database.planning.continuityEnabled(topic.id), planMode: audit.findings.length === 0, planBase: storedFirstPlan.markdown,
      normalize: this.core.carryForwardNormalizer(audit.findings, "Claude revision", { forReview: false }),
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
    // 판 번호는 앞으로만 간다 — 진단 계획 개정 뒤의 감사 답변 개정이 판 번호를 2로 되돌리지 않게(첫 주기는 종전대로 2판).
    const storedRevisedPlan = await this.savePlan(topic, revisedPlan, Math.max(2, topic.planRevision + 1), signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;

    await this.runPlanningFromCloseout(topicId, revision, storedRevisedPlan, signal);
  }

  async resumePlanningAtCloseout(topicId: string, signal: AbortSignal): Promise<void> {
    const { markdown, sha256 } = await this.storedPlanForResume(topicId);
    const revision = await this.core.latestResult(topicId, "claude-revision");
    const known = await this.roundKnownFindings(topicId);
    // 종결 확인이 "처분 되돌림" 가드로 멈췄고 그 뒤 사용자 결정이 올라왔으면(최종 리뷰의 adjudicated 와 같은 규칙),
    // 저장된 종결로 곧장 ACK 한다 — Codex 종결 턴을 다시 사지 않는다(2026-09-13 S10H: 결정이 id 를 확정했는데도 재개가 죽었다).
    if (this.closeoutRegressionAdjudicated(topicId)) {
      const stored = this.core.dependencies.database.latestArtifact(topicId, "closeout");
      const closeout = stored ? await this.core.latestResult(topicId, "closeout") : null;
      // 저장된 종결의 재판정 — resume(재개 정보)과 같은 함수·같은 입력(되돌림 판정 끝)이다.
      if (closeout && closeout.planSHA256 === sha256 && classifyCloseout(closeout).state === "CONSENSUS_ACK"
        && judgeCloseout(known, closeout, { regressionAdjudicated: true }).essential.length === 0) {
        this.core.event(topicId, "system", "system",
          `결정이 처분 되돌림 쟁점(${dispositionRegressions(known, closeout.findings).join(", ")})을 확정했습니다 — 저장된 종결 확인(#${stored?.revision ?? "?"})으로 합의를 마칩니다(종결 턴 재구매 없음).`);
        await this.runConsensusFinalization(topicId, closeout.findings, sha256, signal);
        return;
      }
    }
    await this.runPlanningFromCloseout(topicId, revision, { markdown, sha256 }, signal, known);
  }

  // 처분 되돌림 가드(payload closeoutRegressedFindingIDs) 뒤에 사용자 결정이 하나라도 올라왔는가 — delivery 의
  // adjudicatedFinalReviewIDs 와 같은 규칙(결정이 그 쟁점을 다뤘다고 본다; 내용 판단은 사람 몫).
  closeoutRegressionAdjudicated(topicId: string): boolean {
    const topic = this.core.dependencies.database.getTopic(topicId);
    const events = this.core.dependencies.database.getTimeline(topicId)
      .filter((event) => event.scopeGeneration === topic.scopeGeneration);
    for (let index = events.length - 1; index >= 0; index -= 1) {
      if (!Array.isArray(events[index].payload?.closeoutRegressedFindingIDs)) continue;
      return events.slice(index + 1).some((later) => later.actor === "user" && later.kind === "decision");
    }
    return false;
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
    const known = await this.knownPlanningContext(topic);
    const revision = await this.core.turn("claude", topic, buildClaudeRevisionPrompt({
      knownPlan: known.knownPlan,
      planMarkdown: storedRevisedPlan.markdown, audit: source, scopeGeneration: topic.scopeGeneration,
      timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, known.inputSequence),
      source: "closeout",
    }), signal, false, {
      readablePaths: known.readablePaths,
      freshSession: !this.core.dependencies.database.planning.continuityEnabled(topic.id), planMode: false, planBase: storedRevisedPlan.markdown,
      normalize: this.core.carryForwardNormalizer(source.findings, "Claude revision(2회차)", { forReview: false }),
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
    const implementationNotes = await this.core.implementationNotesOf(topicId);
    const closeoutPrompt = (text: string, timeline: typeof context.timeline, planningContextMode: typeof context.mode) => buildCodexCloseoutPrompt({
      revisedPlan: text,
      revisedPlanSHA256: storedRevisedPlan.sha256,
      claudeRevision: revision,
      timeline,
      planningContextMode,
      secondRound,
      implementationNotes,
    });
    const prompt = closeoutPrompt(context.text, context.timeline, context.mode);
    const closeout = await this.core.turn("codex", topic, prompt, signal, false, {
      freshSessionPrompt: context.full ? closeoutPrompt(context.full.text, context.full.timeline, "full") : undefined,
      readablePaths: context.readablePaths,
      normalize: this.core.carryForwardNormalizer(revision.findings, "Codex closeout", { forReview: true }),
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
    // 종결 판정은 resume(재개 정보)과 같은 함수로 한다(findingJudgment.ts).
    const closeoutJudgment = judgeCloseout(knownFindings, closeout);
    const { deferred, essential, minor } = closeoutJudgment;
    if (deferred.length > 0) await this.core.recordDeferredFindings(topic, deferred, "closeout", signal);
    if (minor.length > 0) await this.core.recordImplementationNotes(topic, minor, "closeout", signal);
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
    const downgradedAtCloseout = closeoutJudgment.regressed;
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
        { closeoutRegressedFindingIDs: downgradedAtCloseout },
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
    const current = this.core.dependencies.database.getTopic(topicId);
    this.core.requireParticipants(current);
    const stored = await this.storedPlanForResume(topicId);
    const closeout = await this.core.latestResult(topicId, "closeout");
    if (closeout.planSHA256 !== stored.sha256) throw new Error("저장된 closeout의 계획 해시가 현재 plan.md와 다릅니다.");
    if (current.state === "USER_DECISION_REQUIRED") {
      const regressed = dispositionRegressions(await this.roundKnownFindings(topicId), closeout.findings);
      this.core.event(topicId, "system", "system",
        `결정이 처분 되돌림 쟁점(${regressed.join(", ")})을 확정했습니다 — 저장된 종결 확인으로 합의를 마칩니다(종결 턴 재구매 없음).`);
    }
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

  private async knownPlanningContext(topic: Topic) {
    const database = this.core.dependencies.database;
    const binding = database.planning.continuityEnabled(topic.id) ? database.planning.boundSession(topic) : null;
    if (!binding) return { knownPlan: undefined, inputSequence: 0, readablePaths: [] as string[] };
    const artifact = await this.core.requireCurrentPlanArtifact(topic.id);
    return { knownPlan: { sha256: topic.planSHA256!, path: artifact.path },
      inputSequence: Math.max(binding.inputSequence, database.getFlags(topic.id).implementationPromptSequence ?? 0),
      readablePaths: [artifact.path] };
  }

  private bindPlanningSession(topic: Topic, sha256: string): void {
    const database = this.core.dependencies.database;
    if (!database.planning.continuityEnabled(topic.id)) return;
    const current = database.getTopic(topic.id);
    const sessionId = current.participants.find(p => p.role === "claude")?.sessionId;
    if (!sessionId || sessionId.startsWith("pending:")) throw new Error("계획을 작성한 Claude 세션이 없습니다.");
    const checkpoint = database.planning.latest(topic.id, "claude");
    if (!checkpoint?.finalized || checkpoint.sessionId !== sessionId || checkpoint.scopeGeneration !== current.scopeGeneration || checkpoint.planEpoch !== current.planEpoch) {
      throw new Error("현재 계획 응답을 작성한 Claude 세션과 연결 정보를 확인할 수 없습니다.");
    }
    database.planning.bindSession(current, sha256, sessionId, checkpoint.inputSequence);
  }

  private async savePlan(
    topic: Topic,
    markdown: string,
    revision: number,
    signal: AbortSignal,
  ): Promise<{ markdown: string; sha256: string }> {
    assertPlanContract(markdown);
    const normalized = normalizePlan(normalizeToleranceBlocks(redactSecrets(markdown)));
    const artifact = await this.core.writeArtifact(topic, "plan", revision, normalized, signal);
    this.core.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    this.core.dependencies.database.updateTopic(topic.id, {
      planRevision: revision, planSHA256: artifact.sha256, approvedPlanSHA256: null,
    });
    this.core.dependencies.database.clearAcknowledgements(topic.id);
    this.core.event(topic.id, "claude", "agent_output", `계획 ${revision}판을 저장했습니다.`, {
      artifactKind: "plan", revision, artifactRevision: artifact.revision, sha256: artifact.sha256,
    });
    this.bindPlanningSession(topic, artifact.sha256);
    return { markdown: normalized, sha256: artifact.sha256 };
  }
}

function uniqueFindings(findings: readonly Finding[]): Finding[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}
