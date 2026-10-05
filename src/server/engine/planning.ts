import { hierarchyContext, assertTask, assertEntryReady } from "../topicStructure.js";
import { EvidenceAssessmentPipeline } from "./evidenceAssessment.js";
import type { EvidenceAssessment } from "../../shared/externalEvidence.js";
import { stableJSON } from "../evidence/store.js";
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
  planTimelineDelivery,
} from "../../shared/prompts.js";
import { applyInfo, diagnosisFinding, type DiagnosisRecord } from "../../shared/diagnoses.js";
import {
  assertDispositionsResolved,
  assertFindingCoverage,
  auditFindingIdentity,
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
import type { ConsensusDatabase } from "../database.js";
import type { PlanningCheckpoint, TimelineDeliveryPlan } from "../../shared/planningControl.js";
import { turnFlags } from "../../shared/roles.js";
import { timelineReferencesApply, unreadRequiredTimeline, unreadRequiredInputs } from "../guardedPlanning.js";
import { bindingOf, legacyBinding, resolveRoute, sameBinding, UnsupportedRoute, type SessionBinding, type TurnRoute } from "../turnRouting.js";
import type { StoredArtifact } from "../types.js";
import type { EngineCore } from "./core.js";
import { preparePlanningContext } from "./planningContext.js";
import { classifyCloseoutAdditions, judgeCloseout } from "./findingJudgment.js";

const IMPLEMENTATION_NOTE_PREFIX = "구현 노트로 승계(엔진 자동, 개정 생략): ";

// 채택 기록(host-review 39d21df9 5차 F010) — 계획 확정 이벤트(savePlan, artifactKind plan)와 경미 지적 합성 개정의 생략 이벤트(skippedRevision)가
// payload.adoptedResult 로 그 계획을 만든(합성 개정은 계획을 유지한) 결과 산출물을 가리킨다. 개정의 채택 여부는 이 기록(과 아래 구형 기록)만으로 판정한다(adoptedRevisions).
type AdoptedResult = { kind: "claude-plan" | "claude-revision"; revision: number };

// 구형 채택 기록(860d8cb 이하 생산자, host-review 39d21df9 6차 F011) — F010 전의 계획 확정 이벤트와 합성 개정 생략 이벤트에는 adoptedResult 가 없다. 과거 기록은 고쳐
// 쓰지 않고(읽기 쪽 호환) 그 생산자가 남긴 모양과 순서로만 결속한다. 근거: 결과 산출물 revision 은 저장 시점의 타임라인 순번(timelineCount+1 = 다음 이벤트의 sequence)이고
// 타임라인 행은 지우지 않으므로 이벤트 sequence 와 같은 축에서 비교된다. 모양은 필드 집합까지 같아야 한다 — 진단 계획 개정의 확정(diagnosisPlanRevised 를 더 싣는다)과
// 신형 확정(adoptedResult)은 여기로 오지 않는다. 증명할 수 없으면 채택하지 않는다(null).
const LEGACY_PLAN_COMMIT_FIELDS = "artifactKind,artifactRevision,revision,sha256";
const LEGACY_SKIPPED_REVISION_FIELDS = "implementationNoteIDs,skippedRevision";
type LegacyHistory = {
  timeline: readonly TimelineEvent[]; // 현재 범위 세대, sequence 오름차순
  results: readonly StoredArtifact[]; // 현재 범위 세대의 claude-plan·claude-revision, revision 오름차순
  sources: readonly StoredArtifact[]; // 현재 범위 세대의 audit·closeout
  requestsPause: (result: AgentResult) => boolean;
};
function legacyAdoptedRevision(event: TimelineEvent, history: LegacyHistory): number | null {
  const payload = event.payload ?? {};
  const fields = Object.keys(payload).sort().join();
  if (event.actor === "system" && event.kind === "system" && payload.skippedRevision === true && fields === LEGACY_SKIPPED_REVISION_FIELDS) {
    // 합성 개정(host-review 39d21df9 6·7차 F011): 생산자(4f086bf~860d8cb 판마다 같다)는 감사 단계에서 revision = timelineCount+1 을 정하고, 합성 산출물 저장을
    // await 한 뒤 곧바로 이 이벤트를 남겼다. 저장은 accept(취소 아님·같은 실행·같은 범위 세대·같은 상태)를 통과해야 원장에 들어가고, 주제당 실행은 하나라 그 창
    // [합성 revision, 이 이벤트)에는 다른 결과가 저장·수신될 수 없다. 창 안의 다른 사건(사용자 입력·설정 변경·원문 변경·역할 배정·위임 기록·검사 지표 등)은 이
    // 이벤트가 어느 결과를 가리키는지와 무관하므로 가리지 않는다. 결속을 실제로 틀리게 하는 것만 본다 — 구형 확정 규칙과 같은 증거로:
    // (a) 이 이벤트 이하의 가장 최근 결과(계획·개정)가 개정이고 같은 순번 결과가 둘이 아니다 — 저장 revision 이 밀렸거나 합성이 아닌 결과를 가리키지 않는다.
    // (b) 그 결과와 이 이벤트 사이에 감사·종결 산출물이 없다(같은 순번 포함).
    // (c) 창 안에 결과 수신·확정 기록(kind agent_output)이 없다 — 모델 결과는 늘 수신 기록을 남기고 합성은 남기지 않는다.
    // (d) 이 이벤트가 생산자의 단계(CODEX_AUDIT)에서 남았다 — 모든 판의 생산자는 감사 단계에서만 이 이벤트를 쓴다. 창 안 기록의 state 는 단계 증거로 쓰지 않는다:
    //     await 앞에서 읽은 낡은 스냅숏을 싣는 생산자가 있고(verifications.ts:132 → 147 검사 완료 지표), 창 안에서 실제로 단계가 바뀌면(취소·범위 변경 등)
    //     저장 accept 가 합성 산출물을 버려 이 이벤트 자체가 생기지 않는다.
    // 세대는 호출부(adoptedRevisions)가 타임라인·산출물을 현재 범위 세대로 걸러 구조적으로 같다.
    if (event.state !== "CODEX_AUDIT") return null;
    const results = history.results.filter((item) => item.revision <= event.sequence);
    const artifact = results.at(-1);
    if (!artifact || artifact.kind !== "claude-revision" || results.at(-2)?.revision === artifact.revision) return null;
    if (history.sources.some((item) => item.revision >= artifact.revision && item.revision < event.sequence)) return null;
    return history.timeline.every((item) => item.sequence < artifact.revision || item.sequence >= event.sequence || item.kind !== "agent_output")
      ? artifact.revision : null;
  }
  if (event.actor === "claude" && event.kind === "agent_output" && payload.artifactKind === "plan" && fields === LEGACY_PLAN_COMMIT_FIELDS) {
    // 계획 확정(savePlan): 모든 호출처가 방금 받은(또는 결정 뒤 재사용한) 결과의 계획을 저장했다 — 그 결과는 이 이벤트 앞의 가장 최근 결과 산출물(계획·개정)이다.
    // 계획 1판(claude-plan)이면 계획 결과를 확정한 것이라 개정을 채택하지 않는다 — 그 앞의 옛 미완료 개정을 대신 채택하지 않는다. 같은 순번의 결과가 둘이면
    // 순서를 증명할 수 없어 채택하지 않는다.
    const before = history.results.filter((item) => item.revision < event.sequence);
    const source = before.at(-1);
    if (!source || source.kind !== "claude-revision" || before.at(-2)?.revision === source.revision) return null;
    // 그 결과와 확정 사이에 감사·종결이 있으면(같은 순번 포함) 이 확정이 그 결과에서 나왔다는 순서가 성립하지 않는다.
    if (history.sources.some((item) => item.revision >= source.revision && item.revision < event.sequence)) return null;
    // 받은 기록(saveAgentOutput 의 agent_output 이벤트, 2026-09-15 전 기록은 artifactRevision 없음)이 있어야 하고, 멈춤을 요청한 결과는 결정 뒤 재사용 확정일
    // 때만이다 — 받은 뒤 확정 전에 사용자 결정이 있다(pausedResultReusable 과 같은 조건).
    const receipt = history.timeline.find((item) => item.sequence >= source.revision && item.sequence < event.sequence && item.actor !== "user"
      && item.kind === "agent_output" && item.payload?.resultKind === "REVISION" && Array.isArray(item.payload.findings)
      && (item.payload.artifactRevision === undefined || item.payload.artifactRevision === source.revision));
    if (!receipt) return null;
    if (history.requestsPause(receipt.payload as unknown as AgentResult) && !history.timeline.some((item) =>
      item.sequence > receipt.sequence && item.sequence < event.sequence && item.actor === "user" && item.kind === "decision")) return null;
    return source.revision;
  }
  return null;
}

// 유지 계획 세션의 재계획은 그 세션이 마지막으로 받은 순번(직전 epoch 에 저장 성공으로 묶인 바인딩) 뒤 이벤트만 보낸다(E3-2-1, E0 r4).
// 첫 무효화 이벤트를 기준으로 자르면 세션이 받지 못한 결정(예: 종결 재시도에서 검토자만 읽은 결정)이 빠졌다. 연속성이 없으면(교체 세션·다른 좌석·
// 다른 범위·epoch 불일치) 전체를 보낸다. 커서는 저장 성공 뒤에만 앞서므로 실패·취소한 재계획을 다시 돌려도 같은 위치에서 보낸다.
// mode "all": 참조 모드 턴은 최근 80개 제한 없이 대상 이벤트 전부를 받아 인라인·참조·색인으로 싣는다(E3-2-2a, host-review cd73bc5c F002).
export function resumedPlanTimeline(database: Pick<ConsensusDatabase, "planning" | "getPromptTimeline">, topic: Topic,
  previousPlanSHA256: string | null, mode: "recent" | "all" = "recent"): TimelineEvent[] {
  const cursor = previousPlanSHA256 ? database.planning.priorPlanCursor(topic, previousPlanSHA256) : null;
  return database.getPromptTimeline(topic.id, topic.scopeGeneration, cursor ?? 0, mode);
}

// 계획 제어 단계를 재개하는 턴의 job — 각 단계의 턴이 core.route 로 여는 경로와 같다(계획 runPlanningLoop, 개정 runPlanningFromRevision·개정 2회차,
// 감사 runPlanningFromAudit, 종결 runPlanningFromCloseout). 진단 계획 개정(planner/diagnosis-revision)도 CLAUDE_PLAN 단계지만 retry 가 재사용 판정보다
// 먼저 진단 개정 분기(pendingPlanRevision)로 보내므로 계획 단계의 재개 job 은 planner/plan 이다.
const RESUMING_JOB = {
  CLAUDE_PLAN: { role: "planner", operation: "plan" },
  CLAUDE_REVISION: { role: "planner", operation: "revision" },
  CODEX_AUDIT: { role: "reviewer", operation: "audit" },
  CODEX_CLOSEOUT: { role: "reviewer", operation: "closeout" },
} as const satisfies Record<string, TurnRoute["job"]>;

export class PlanningPipeline {
  constructor(private readonly core: EngineCore) {}

  // 타임라인 참조 모드(E3-2-2a) — 계획 제어가 실제로 적용되고 세션을 유지하는 턴(검토자, 연속성 v2 계획자)에만 명시적으로 켠다. 빌더 기본과 v1 비유지
  // 계획자는 기존 렌더를 쓴다. 판정은 계획 제어 래퍼와 같은 식이다. 참조 모드면 조회도 최근 80개 제한 없이 전부 받는다("all", F002) — 조회에서
  // 빠진 이벤트는 인라인·참조·색인 어디에도 실을 수 없다. 비참조 경로는 기존 "recent" 그대로다.
  private referenceMode(topic: Topic, route: TurnRoute): "recent" | "all" {
    return timelineReferencesApply(this.core.dependencies.database, topic.id, topic.state, turnFlags(route.job), route.job.role) ? "all" : "recent";
  }
  private timelineDelivery(mode: "recent" | "all", timeline: readonly TimelineEvent[]): TimelineDeliveryPlan | undefined {
    return mode === "all" ? planTimelineDelivery(timeline) : undefined;
  }

  async runPlanningLoop(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.requireState(topicId, "DRAFT");
    assertTask(topic); assertEntryReady(this.core.dependencies.database, topic);
    this.core.requireParticipants(topic);

    topic = this.core.transition(topicId, "CLAUDE_PLAN", "Claude가 첫 계획을 작성합니다.");
    // 재시작(closeout 신규 쟁점 → DRAFT)이면 직전 계획 전문을 프롬프트에 그대로 싣는다 — 새 세션은 타임라인만 받아 본문을 잃는다.
    const previousPlanMarkdown = await this.core.dependencies.artifacts.readLatest(topicId, "plan");
    const deferredFindings = await this.core.deferredFindingsFor(topicId);
    // 이연 쟁점 근거 전문은 원문 산출물로 둔다 — 프롬프트 목록은 인라인 예산을 넘으면 색인과 이 산출물 참조만 싣는다(E4 2차 보완 F012).
    const deferredFindingsPath = await this.core.writeDeferredFindingsDigest(topic, deferredFindings, signal);
    // 승인 대기 중 새 결정으로 계획만 무효화한 경우, 같은 세션이 이미 받은 이전 대화를 다시 싣지 않는다. 직전 계획 전문은 보존한다.
    // 타임라인은 모든 비동기 준비를 마친 뒤 턴 직전에 읽는다 — 사이에 await 가 있으면 그동안 도착한 결정이 프롬프트에도 턴 뒤 새 입력 검사
    // (startedAfter 이하)에도 없이 전달 커서에만 들어갔다(E3-2-1).
    const planRoute = this.core.route(topic, { role: "planner", operation: "plan" });
    const planMode = this.referenceMode(topic, planRoute);
    const timeline = resumedPlanTimeline(this.core.dependencies.database, topic, previousPlanMarkdown ? hashPlan(previousPlanMarkdown) : null, planMode);
    const planDelivery = this.timelineDelivery(planMode, timeline);
    const claudePlan = await this.core.turn(planRoute, topic, buildClaudePlanPrompt({
      title: topic.title, goalContext: hierarchyContext(this.core.dependencies.database, topic), worktreePath: topic.worktreePath, sourceRepositoryPath: topic.repositoryPath,
      baseRef: topic.baseRef,
      scopeGeneration: topic.scopeGeneration,
      timeline,
      previousPlanMarkdown,
      deferredFindings,
      ...(deferredFindingsPath ? { deferredFindingsPath } : {}),
      timelineDelivery: planDelivery,
    }), signal, {
      planMode: true,
      ...(planDelivery ? { timelineDelivery: { prompt: planDelivery } } : {}),
      ...(deferredFindingsPath ? { readablePaths: [deferredFindingsPath] } : {}),
      // 계약 위반(kind·계획 본문 형식)은 같은 세션 1회 교정으로 회수한다 — 멈추는 응답은 계획이 없어도 정당.
      check: (r) => {
        this.core.assertKind(r, "PLAN");
        if (!this.core.resultRequestsPause(r)) this.core.requirePlan(r);
      },
    });
    const firstPlan = this.core.resultRequestsPause(claudePlan) ? null : this.core.requirePlan(claudePlan);
    await this.core.saveAgentOutput(topic, planRoute, claudePlan, "claude-plan", signal);
    if (this.core.pauseForResult(topicId, claudePlan, "CLAUDE_PLAN", "계획을 확정하려면 사용자 결정이 필요합니다.")) return;
    if (firstPlan === null) throw new Error("계획 검증 경로 불변식 위반: pause 예측이 어긋났습니다.");
    const storedFirstPlan = await this.savePlan(topic, firstPlan, 1, signal, this.savedResult(topicId, "claude-plan"));
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
    const revisionRoute = this.core.route(topic, { role: "planner", operation: "diagnosis-revision" });
    const revisionMode = this.referenceMode(topic, revisionRoute);
    const revisionTimeline = this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, known.inputSequence, revisionMode);
    const revisionDelivery = this.timelineDelivery(revisionMode, revisionTimeline);
    const revision = await this.core.turn(revisionRoute, topic, buildDiagnosisPlanRevisionPrompt({
      knownPlan: known.knownPlan,
      planMarkdown: carry.basePlan, scopeGeneration: topic.scopeGeneration, worktreePath: topic.worktreePath, branchName: topic.branchName ?? "-",
      diagnoses: delivered.prompts,
      carry: {
        remainingSteps: carry.remainingSteps, openRequests: carry.openRequests, changedPaths: carry.changedPaths,
        lastSummary: carry.lastSummary, verifiedLedgerRows: carry.verifiedLedger.length,
      },
      timeline: revisionTimeline,
      timelineDelivery: revisionDelivery,
    }), signal, {
      ...(revisionDelivery ? { timelineDelivery: { prompt: revisionDelivery } } : {}),
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
    await this.core.saveAgentOutput(topic, revisionRoute, revision, "diagnosis-plan-revision", signal, { diagnosisPlanRevision: record.id });
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
    const consumedThrough = Math.max(0, ...events.map(event => Number(event.payload?.replanConsumedThrough) || 0));
    let lastInterrupt = -1;
    events.forEach((event, index) => {
      if (event.actor === "system" && Array.isArray(event.payload?.closeoutEssentialFindingIDs)) lastInterrupt = index;
    });
    if (lastInterrupt < 0) return false;
    return events.slice(lastInterrupt + 1)
      .some((event) => event.sequence > consumedThrough && event.actor === "user" && event.kind === "decision" && replanDirective(event.body));
  }

  // 개정 턴도 같다(2026-09-07 S10 #31: 배치 순서 확인 하나로 $11·35분짜리 개정 턴이 반복될 뻔했다).
  pausedRevisionReusable(topicId: string): boolean {
    return this.pausedResultReusable(topicId, "claude-revision");
  }

  private pausedResultReusable(topicId: string, kind: "claude-plan" | "claude-revision"): boolean {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    if (topic.state !== "USER_DECISION_REQUIRED" && !(kind === "claude-plan" && topic.state === "BLOCKED_ON_EVIDENCE")) return false;
    const stored = database.latestArtifact(topicId, kind);
    if (!stored || stored.scopeGeneration !== topic.scopeGeneration) return false;
    // 이미 채택된 개정(계획 확정 기록이 가리킨다)은 멈춘 결과가 아니다 — 재사용하면 그 편집(planEdits·planLineEdits)을 이미 반영된 계획에 한 번 더 적용한다
    // (host-review 39d21df9 5차 F010: 계획 저장 도중 도착한 결정으로 멈춘 뒤 retry 가 채택된 개정을 다시 적용했다). 그런 멈춤은 같은 단계를 다시 돌려 새
    // 입력을 반영한다(아래 사다리). 계획은 본문 전체라 다시 저장해도 같은 판이므로 이 규칙이 필요 없다.
    if (kind === "claude-revision" && this.adoptedRevisions(topicId).has(stored.revision)) return false;
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
    // 결정을 청하며 읽기를 남긴 계획 제어 체크포인트는 닫히지 않고 남는다 — 저장된 결과(결정 응답의 본문)를 채택하지 않고 그 체크포인트(같은 admission·epoch·
    // 조사 회차 누적)에서 읽기를 잇는다. 계획은 retry 의 미완료 체크포인트 분기, 개정은 개정 재개가 그 체크포인트로 간다(판정은 openReadObligation 하나).
    if (this.openReadObligation(topicId, kind === "claude-plan" ? "CLAUDE_PLAN" : "CLAUDE_REVISION")) return false;
    return decided;
  }

  // 결정 뒤 재개가 같은 단계의 계획 제어 체크포인트를 이어 대기 읽기를 먼저 채택해야 하는가 — 결정을 청하며 읽기 의무(결정 뒤로 미룬 이연 읽기·필수
  // 타임라인 미완독)를 남기고 열어 둔 체크포인트가 이 단계에 있다(E3-2-2a F003, host-review 39d21df9 F001·F007). 계획·개정의 멈춘 결과 재사용 판정
  // (pausedResultReusable)과 감사·종결의 retry 분기(workflow.retry)가 이 한 판정을 쓴다. 모두 만족할 때만 참이다.
  // - 가장 최근 체크포인트(planning.latest)가 이 단계의 미확정 체크포인트이고 열린 질문 표식(awaitingDecision)이 있다 — 그 뒤 다른 단계가 돌았거나
  //   결정 없이 확정됐으면 잇지 않는다.
  // - 이연 읽기나 필수 미완독이 남았다. 예산이 강제한 정리가 완료 결과 없이 결정만 청한 체크포인트(synthesisIncomplete — 정리 모드라 읽을 곳을 결정 문장
  //   으로만 남겼다, E5 파일럿 51b22146)도 같은 조사 의무다 — 거짓이면 계획은 새 epoch 재계획으로, 감사·종결은 개정으로 내려가 그 시도를 잃었다.
  // - 범위 세대·계획 epoch·계획 SHA 가 지금 주제와 같다 — guardedPlanning 이 그 체크포인트를 이어 가는 조건과 같다.
  // - 공급자·바인딩이 이 단계를 재개할 실제 job route(재개 턴이 core.route 로 여는 경로)와 같다 — guardedPlanning 이 체크포인트를 잇는 기준(ownedByTurn:
  //   체크포인트 바인딩 = 턴 route 의 바인딩, 체크포인트 공급자 = 어댑터 공급자)과 같은 식이다. 좌석 표에 남은 바인딩은 정본이 아니다 — 비연속 계획자의
  //   개정은 새 세션(freshSession)이라 좌석 바인딩을 갱신하지 않아, 계획·개정을 다른 참여자로 배정하면 좌석에는 계획 참여자가 남는다(host-review 39d21df9
  //   3차 F001). route 는 부작용 없는 resolveRoute 로 푼다(core.route 는 지원되지 않는 경로면 이벤트를 남기고 던진다). 풀 수 없는 배정(프로필 없음·
  //   설정 불가·세션 지정)이면 의무는 남아 있으므로 참이다 — 그 단계로 재개해 실제 턴의 core.route 가 거부 사유를 남기고 멈춘다(모델 호출 없음). 거짓으로
  //   두면 다음 단계로 내려가 요청한 자료가 조용히 버려진다.
  openReadObligation(topicId: string, stage: "CLAUDE_PLAN" | "CLAUDE_REVISION" | "CODEX_AUDIT" | "CODEX_CLOSEOUT"): boolean {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    const checkpoint = database.planning.latest(topicId) as (PlanningCheckpoint & { binding?: SessionBinding }) | null;
    if (!checkpoint || checkpoint.finalized || checkpoint.stage !== stage || !checkpoint.awaitingDecision) return false;
    if (checkpoint.scopeGeneration !== topic.scopeGeneration || checkpoint.planEpoch !== topic.planEpoch ||
        checkpoint.planSHA256 !== topic.planSHA256) return false;
    if (!checkpoint.deferredReads?.length && !checkpoint.synthesisIncomplete && !unreadRequiredTimeline(database, checkpoint).length &&
        !unreadRequiredInputs(database, checkpoint).length) return false;
    let route: TurnRoute;
    try { route = resolveRoute(database, topic, RESUMING_JOB[stage]); }
    catch (error) { if (error instanceof UnsupportedRoute) return true; throw error; }
    return checkpoint.role === route.provider && sameBinding(checkpoint.binding ?? legacyBinding(checkpoint.role), bindingOf(route));
  }

  async resumePlanningFromPausedRevision(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.requireState(topicId, "USER_DECISION_REQUIRED");
    this.core.requireParticipants(topic);
    const storedFirstPlan = await this.storedPlanForResume(topicId);
    const stored = this.core.dependencies.database.latestArtifact(topicId, "claude-revision");
    if (!stored) throw new Error("재사용할 개정 산출물이 없습니다.");
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
      `결정이 올라온 저장된 개정(#${stored.revision})을 재사용해 종결 확인으로 넘깁니다 — 개정 턴을 다시 사지 않습니다.`);
    const storedRevisedPlan = await this.savePlan(topic, revisedPlan, topic.planRevision + 1, signal,
      { kind: "claude-revision", revision: stored.revision });
    const known = secondRound ? await this.roundKnownFindings(topicId) : revision.findings;
    await this.runPlanningFromCloseout(topicId, revision, storedRevisedPlan, signal, known);
  }

  async resumePlanningFromPausedPlan(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.dependencies.database.getTopic(topicId);
    if (!this.pausedPlanReusable(topicId)) throw new Error("현재 중단 계획을 재사용할 결정과 완결된 읽기 상태가 필요합니다.");
    this.core.requireParticipants(topic);
    const stored = this.core.dependencies.database.latestArtifact(topicId, "claude-plan");
    if (!stored) throw new Error("재사용할 계획 산출물이 없습니다.");
    const claudePlan = await this.core.latestResult(topicId, "claude-plan");
    let plan: string;
    try {
      plan = this.core.requirePlan(claudePlan);
    } catch {
      this.core.resetToDraft(topic, "멈춘 계획 응답에 재사용할 계획 본문이 없어 처음부터 다시 실행합니다.");
      return this.runPlanningLoop(topicId, signal);
    }
    topic = this.core.transition(topicId, "CLAUDE_PLAN",
      `결정이 올라온 저장된 계획(#${stored.revision})을 재사용해 감사로 넘깁니다 — 계획 턴을 다시 사지 않습니다.`);
    const storedFirstPlan = await this.savePlan(topic, plan, 1, signal, { kind: "claude-plan", revision: stored.revision });
    await this.runPlanningFromAudit(topicId, claudePlan, storedFirstPlan, signal);
  }

  // 저장된 계획으로 감사부터 다시 시작한다. 계획 턴이 결과를 냈는데 그다음이 인프라 오류로 죽었을 때
  // 계획을 버리고 Claude를 처음부터 돌리면 같은 계획을 다시 만드느라 비용만 든다. 왕복 횟수는 늘지 않는다 —
  // 결과를 낸 적 없는 감사 회차를 완료시키는 것이기 때문이다.
  // 재개용으로 확정된 계획과 그 해시를 되살린다 — topic.planSHA256 에 결속한 계획 산출물이다(requireCurrentPlanArtifact). 최신 plan 산출물이 아니다:
  // 계획 저장(savePlan)이 산출물만 쓰고 확정(계획 필드·ACK·확정 이벤트) 전에 끊기면 최신 산출물은 확정되지 않은 개정본이고, 그것을 바탕으로 삼으면 개정의
  // 편집을 이미 반영된 본문에 한 번 더 적용하거나 확정되지 않은 계획으로 종결 확인을 했다(host-review 39d21df9 5차 F010). resetToDraft 로 계획 SHA 가
  // 지워졌으면 종전대로 최신 산출물이다(산출물은 남는다). 해시는 저장할 때와 같은 방식으로 본문에서 다시 계산한다.
  private async storedPlanForResume(topicId: string): Promise<{ markdown: string; sha256: string }> {
    const { content: markdown } = await this.core.requireCurrentPlanArtifact(topicId);
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
    const identity = auditFindingIdentity(claudePlan.findings);
    claudePlan = { ...claudePlan, findings: identity.findings };
    const carry = this.core.carryForwardNormalizer(identity.findings, "Codex audit", { forReview: true });
    const normalize = Object.assign(
      (result: AgentResult) => carry({ ...result, findings: identity.normalize(result.findings) }),
      { carried: carry.carried, label: carry.label,
        beforeMerge: (result: AgentResult, salvaged = false) => ({ ...result, findings: salvaged
          ? result.findings.map(finding => {
            // A malformed original can be replaced by a valid corrected item with this ID.
            // Preserve failures verbatim; any unreplaced invalid item still fails final normalization.
            try { return identity.normalize([finding], false)[0]; } catch { return finding; }
          }) : identity.normalize(result.findings, false) }) },
    );
    let topic = this.core.transition(topicId, "CODEX_AUDIT", "Codex가 계획을 읽기 전용으로 감사합니다.");
    const auditRoute = this.core.route(topic, { role: "reviewer", operation: "audit" });
    const auditMode = this.referenceMode(topic, auditRoute);
    const context = await preparePlanningContext(this.core, topic, storedFirstPlan.markdown, storedFirstPlan.sha256, auditMode);
    // 진단 계획 개정 뒤의 감사면 진단 원문·이전 승인 계획·이미 바뀐 파일을 함께 싣는다(구현 도중의 개정).
    const revisionContext = await this.core.diagnoses.revisionAuditContext(topicId);
    const deferredFindings = await this.core.deferredFindingsFor(topicId);
    const deferredFindingsPath = await this.core.writeDeferredFindingsDigest(topic, deferredFindings, signal);
    const auditDelivery = this.timelineDelivery(auditMode, context.timeline);
    const fullAuditDelivery = context.full ? this.timelineDelivery(auditMode, context.full.timeline) : undefined;
    const auditPrompt = (text: string, timeline: typeof context.timeline, planningContextMode: typeof context.mode,
      timelineDelivery: TimelineDeliveryPlan | undefined) => buildCodexAuditPrompt({
      title: topic.title, planMarkdown: text, planSHA256: storedFirstPlan.sha256,
      scopeGeneration: topic.scopeGeneration,
      timeline,
      timelineDelivery,
      planningContextMode,
      claudePlan,
      deferredFindings,
      ...(deferredFindingsPath ? { deferredFindingsPath } : {}),
      diagnosisRevision: revisionContext?.context,
    });
    const prompt = auditPrompt(context.text, context.timeline, context.mode, auditDelivery);
    const audit = await this.core.turn(auditRoute, topic, prompt, signal, {
      // 변경분은 커서를 기록한 세션에서만 유효하다 — 계획 제어가 새 감사 세션으로 바꾸면 전체 문맥 판을 쓴다(host-review a7a9ce86 F-001).
      freshSessionPrompt: context.full ? auditPrompt(context.full.text, context.full.timeline, "full", fullAuditDelivery) : undefined,
      ...(auditDelivery ? { timelineDelivery: { prompt: auditDelivery, fresh: fullAuditDelivery } } : {}),
      readablePaths: [...context.readablePaths, ...(revisionContext?.paths ?? []), ...(deferredFindingsPath ? [deferredFindingsPath] : [])],
      normalize,
      check: (r) => {
        this.core.assertKind(r, "AUDIT");
        assertFindingCoverage(claudePlan.findings, r.findings, "Codex audit");
      },
    });
    await this.core.saveAgentOutput(topic, auditRoute, audit, "audit", signal);
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
      const artifact = await this.core.writeArtifact(topic, "claude-revision", revision, JSON.stringify(synthetic, null, 2), signal);
      // 합성 개정의 채택 기록은 이 생략 이벤트다 — 계획을 유지하므로 계획 확정 이벤트가 없고, 산출물 revision 을 명시해 그 합성 개정만 가리킨다(F010).
      this.core.event(topicId, "system", "system",
        `감사 지적 ${actionable.length}건이 전부 경미(MEDIUM 이하)라 개정 턴을 생략합니다 — 구현 노트로 러너에게 넘기고 종결 확인으로 갑니다: ${actionable.map((finding) => finding.id).join(", ")}`,
        { skippedRevision: true, implementationNoteIDs: actionable.map((finding) => finding.id),
          adoptedResult: { kind: "claude-revision", revision: artifact.revision } satisfies AdoptedResult });
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
    // 받았지만 계획을 확정하지 못한 개정이 있으면 그것부터 채택한다 — 바퀴 합의·쟁점 선택·개정 재실행보다 먼저다(host-review 39d21df9 5차 F010).
    const received = await this.receivedUnadoptedRevision(topicId);
    if (received) {
      await this.adoptReceivedRevision(topicId, received, stored, signal);
      return;
    }
    const progress = this.evidenceRevisionProgress(topicId);
    const obligation = progress && !progress.handedOff ? progress.job : null;
    if (obligation) {
      const result = this.core.dependencies.database.evidence.automation.receipt(obligation.id)?.accepted;
      if (!result) throw new Error("근거 개정의 원본 검토 결과가 없습니다.");
      const db = this.core.dependencies.database;
      const lateInput = db.getTopic(topicId).state === "USER_DECISION_REQUIRED" &&
        db.getTimeline(topicId).filter(event => event.payload?.resumeState).at(-1)?.payload?.newInputSequence;
      if (progress?.adopted && !lateInput) {
        await this.resumePlanningAtCloseout(topicId, signal);
      } else {
        await this.runPlanningFromRevision(topicId, result, stored, signal);
      }
      return;
    }
    const db = this.core.dependencies.database;
    const current = db.getTopic(topicId), events = db.getScopedTimeline(topicId, current.scopeGeneration);
    const newInput = events.filter(event => event.actor === "system" && event.payload?.evidenceReviewNewInput === true &&
      event.payload.evidenceReviewPlanEpoch === current.planEpoch).at(-1);
    const adoptedAfterInput = newInput && events.some(event => event.sequence > newInput.sequence && event.actor !== "user" &&
      (event.payload?.adoptedResult as { kind?: string } | undefined)?.kind === "claude-revision");
    if (newInput && !adoptedAfterInput) {
      // A decision after final review is a new revision input, even when an earlier
      // second revision settled every finding. Keep this obligation across retries/restarts.
      const closeout = await this.core.latestResult(topicId, "closeout");
      await this.runPlanningFromRevision2(topicId, closeout, closeout.findings.map(finding => finding.id), stored,
        await this.roundKnownFindings(topicId), signal);
      return;
    }
    if (this.core.dependencies.database.getFlags(topicId).closeoutRevisionUsed) {
      // 개정 2회차 도중 죽었다 — 감사가 아니라 종결 확인의 새 쟁점을 다시 반영한다(기존 계획 = 2판).
      const closeout = await this.core.latestResult(topicId, "closeout");
      // 바퀴 합의는 채택된 개정만이다(roundKnownFindings) — 멈춘 개정 2회차·추가 개정의 결과는 아직 처리한 쟁점이 아니다.
      const known = await this.roundKnownFindings(topicId);
      const { essential, minor } = classifyCloseoutAdditions(known, closeout);
      // 처분을 되돌린 쟁점도 추가 개정의 대상이다 — 결정을 소비해 처분을 재기재하는 단계가 개정이기 때문이다.
      const ids = [...new Set([...essential.map((finding) => finding.id), ...dispositionRegressions(known, closeout.findings)])];
      // 결정을 청하며 읽기를 남긴 열린 개정(2회차·추가 개정) 체크포인트는 합의·종결 재개보다 먼저 같은 개정 턴으로 잇는다(host-review 39d21df9 4차 F009).
      // 쟁점은 저장된 종결과 채택된 개정 집합에서 다시 고른다 — 그 개정을 열 때와 같은 입력이라 같은 쟁점이다. guardedPlanning 이 같은 체크포인트(같은
      // admission·세션·route·epoch)를 이어, 결정이 왔으면 대기 읽기를 싣고 개정을 채택(새 계획 저장)한 뒤 새 계획 SHA 로 종결 확인을 하고, 결정이 없으면
      // 저장된 질문을 돌려줘 다시 멈춘다. 종결의 구현 노트는 그 종결을 처음 판정할 때 기록했으므로 여기서 다시 적지 않는다. 쟁점이 비면 채택 집합과 종결이
      // 어긋난 것이라 합의로 넘어가지 않고 멈춘다(쟁점 id 를 지어내 우회하지 않는다).
      if (this.openReadObligation(topicId, "CLAUDE_REVISION")) {
        if (ids.length === 0) {
          throw new Error("결정 뒤 읽을 자료가 남은 개정 체크포인트가 있는데 저장된 종결에서 이어 갈 쟁점을 찾지 못했습니다 — 합의로 넘어가지 않고 멈춥니다(중재 필요).");
        }
        await this.runPlanningFromRevision2(topicId, closeout, ids, stored, known, signal);
        return;
      }
      if (minor.length > 0) await this.core.recordImplementationNotes(this.core.dependencies.database.getTopic(topicId), minor, "closeout", signal);
      if (ids.length === 0) {
        // 남은 것이 경미 지적뿐이면(배포 전 엔진이 필수로 분류했던 것) 저장된 종결로 합의를 마친다 — 종결 재실행은 전이표가 막는다.
        if (closeout.planSHA256 === stored.sha256 && classifyCloseout(closeout).state === "CONSENSUS_ACK") {
          return this.runConsensusFinalization(topicId, closeout.findings, stored.sha256, signal);
        }
        // The stored decision has no unresolved revision finding. Enter the explicit
        // recovery edge instead of letting the resumer attempt a forbidden pause→closeout.
        const current = this.core.dependencies.database.getTopic(topicId);
        if (current.state === "USER_DECISION_REQUIRED") {
          this.core.transitionWith(topicId, "FAILED", "저장된 종결의 결정을 같은 단계에서 재확인합니다.",
            { changes: { resumeState: "CODEX_CLOSEOUT" } });
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
  // 채택된 개정만 모은다(host-review 39d21df9 4차 F009·5차 F010). 채택의 정의: 그 개정 결과 산출물을 가리키는 채택 기록(adoptedRevisions)이 있다 — 실제
  // 개정은 그 결과로 만든 계획의 확정 이벤트, 계획을 유지하는 합성 개정은 엔진의 생략 이벤트다. 결과를 받은 것(산출물 저장)이나 개정 계획 산출물이 저장된
  // 것만으로는 채택이 아니다 — 계획 확정 전에 끊긴 개정을 넣으면 그 쟁점을 처리한 것으로 보아 재개가 옛 계획의 종결로 합의했다(F010). 멈춤을 요청한
  // 결과는 결정 뒤 그 본문을 재사용해 계획을 확정했을 때만 기록이 생기고(F009), 질문 재생 사본은 기록이 없다. 이전 버전이 남긴 기록(adoptedResult 없음)도
  // 그 생산자의 순서로 같은 결과에 결속해 센다(F011 — 업그레이드 전 채택본을 빼면 되돌림 감시가 약해진다). 계획 SHA 로는 가르지 않는다 — 개정 결과는
  // 계획 SHA 를 담지 않고(planEdits 는 바탕 계획이 있어야 풀린다) 합성 개정은 계획을 바꾸지 않는다.
  // 1회차는 그 바퀴 개정이 하나라 최신 개정이 곧 채택본이다 — 1회차 개정이 채택 전인 동안 이 집합을 읽는 소비처는 없다(종결·ACK 재개는 개정 채택
  // 뒤이고, 받고 확정하지 못한 개정은 개정 재개가 먼저 채택하며, 재개 정보의 종결 판정은 종결이 가장 최근 계획 산출물일 때만이다).
  async roundKnownFindings(topicId: string): Promise<Finding[]> {
    const { database, artifacts } = this.core.dependencies;
    const latest = await this.core.latestResult(topicId, "claude-revision");
    if (!database.getFlags(topicId).closeoutRevisionUsed) return latest.findings;
    const audit = database.latestArtifact(topicId, "audit");
    const adopted = this.adoptedRevisions(topicId);
    const round = database.artifactsForScope(topicId, "claude-revision")
      .filter((artifact) => (!audit || artifact.revision > audit.revision) && adopted.has(artifact.revision))
      .reverse();
    const results = await Promise.all(round.map(async (artifact) => {
      const stored = await artifacts.verifiedByRevision(topicId, "claude-revision", artifact.revision);
      if (!stored) throw new Error(`개정 산출물 #${artifact.revision} 을 읽을 수 없습니다.`);
      return AgentResultSchema.parse(JSON.parse(stored.content));
    }));
    return uniqueFindings(results.flatMap((result) => result.findings));
  }

  // 채택 기록이 가리키는 개정 결과 산출물 revision 들(현재 범위 세대) — 계획 확정 이벤트(savePlan)와 합성 개정의 생략 이벤트만 센다. 둘 다 엔진이 쓰는
  // payload 라 사용자 입력이 흉내 낼 수 없다. 채택 판정은 여기 한 곳이다(바퀴 합의 roundKnownFindings·복구 후보 receivedUnadoptedRevision·멈춘 결과 재사용
  // pausedResultReusable). adoptedResult 가 있으면 그것만, 없으면(860d8cb 이하 생산자) 구형 결속 규칙(legacyAdoptedRevision)으로 읽는다(F011).
  private adoptedRevisions(topicId: string): Set<number> {
    const database = this.core.dependencies.database;
    const scopeGeneration = database.getTopic(topicId).scopeGeneration;
    const timeline = database.getTimeline(topicId).filter((event) => event.scopeGeneration === scopeGeneration);
    const byRevision = (left: StoredArtifact, right: StoredArtifact) => left.revision - right.revision;
    let legacy: LegacyHistory | undefined;
    const adopted = new Set<number>();
    for (const event of timeline) {
      if (event.actor === "user") continue;
      if (event.payload?.artifactKind !== "plan" && event.payload?.skippedRevision !== true) continue;
      if (event.payload?.adoptedResult !== undefined) {
        const record = event.payload.adoptedResult as Partial<AdoptedResult> | null;
        if (record?.kind === "claude-revision" && typeof record.revision === "number") adopted.add(record.revision);
        continue;
      }
      legacy ??= {
        timeline,
        results: [...database.artifactsForScope(topicId, "claude-plan"), ...database.artifactsForScope(topicId, "claude-revision")].sort(byRevision),
        sources: [...database.artifactsForScope(topicId, "audit"), ...database.artifactsForScope(topicId, "closeout")],
        requestsPause: (result) => this.core.resultRequestsPause(result),
      };
      const revision = legacyAdoptedRevision(event, legacy);
      if (revision !== null) adopted.add(revision);
    }
    return adopted;
  }

  // 받았지만 채택 기록이 없는 개정 — 개정 결과를 저장(saveAgentOutput)한 뒤 그 계획의 확정(savePlan)이 끝나기 전에 서버 종료·쓰기 실패·취소로 끊겼다.
  // 이 바퀴의 가장 최근 계획 제어 결과(최신 감사·종결보다 뒤)여야 한다 — 그 뒤 종결이 돌았으면 이미 다음 단계로 넘어간 것이다. 산출물 revision 은 저장 시점의
  // 타임라인 순번이라 엔진이 쓴 기록에서는 종류를 넘어 겹치지 않는다. 같으면 순서를 증명할 수 없으므로 채택하지 않는다(종전 경로 — 개정 재실행). 멈춤을
  // 요청한 결과는 제외한다(결정 뒤 재사용 규칙·개정 재실행을 따른다 — 결정 없이 채택하면 물은 질문을 건너뛴다).
  private async receivedUnadoptedRevision(topicId: string): Promise<{ revision: number; result: AgentResult } | null> {
    const { database, artifacts } = this.core.dependencies;
    const latest = database.latestArtifact(topicId, "claude-revision");
    if (!latest) return null;
    for (const source of ["audit", "closeout"]) {
      const artifact = database.latestArtifact(topicId, source);
      if (artifact && artifact.revision >= latest.revision) return null;
    }
    if (this.adoptedRevisions(topicId).has(latest.revision)) return null;
    // 바탕 증명(F011) — 저장된 결과를 적용해도 되는 것은 그 개정이 받은 계획이 지금 확정된 계획일 때뿐이다(한 번만 적용). 개정 뒤에 계획 확정(모양 무관)이 있으면
    // 계획이 이미 넘어갔고, 개정 앞의 마지막 계획 확정이 가리키는 sha 가 지금 계획 sha 가 아니면 확정 기록 없이 계획 필드가 바뀐 것이다(구형 savePlan 은 계획 필드를
    // 확정 이벤트보다 먼저 썼다). 어느 쪽이든 복구 채택하지 않는다 — 종전 경로(확정된 계획을 바탕으로 개정 재실행)로 가서 편집을 다시 적용하지 않는다.
    const topic = database.getTopic(topicId);
    const commits = database.getTimeline(topicId).filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor !== "user"
      && event.payload?.artifactKind === "plan");
    if (commits.some((event) => event.sequence > latest.revision)) return null;
    if (commits.filter((event) => event.sequence < latest.revision).at(-1)?.payload?.sha256 !== topic.planSHA256) return null;
    const stored = await artifacts.verifiedByRevision(topicId, "claude-revision", latest.revision);
    if (!stored) throw new Error(`개정 산출물 #${latest.revision} 을 읽을 수 없습니다.`);
    const result = AgentResultSchema.parse(JSON.parse(stored.content));
    return this.core.resultRequestsPause(result) ? null : { revision: latest.revision, result };
  }

  // 받은 개정의 복구 채택 — 모델을 다시 부르지 않고(새 admission·재작성 예약 없음) 저장된 결과를 확정된 계획(topic.planSHA256 결속, storedPlanForResume)
  // 위에 한 번 적용해 계획을 확정한 뒤 새 계획 SHA 로 종결 확인을 한다. 바탕은 그 개정 턴이 받은 계획과 같다 — 계획 SHA 는 확정(savePlan 의 한
  // transaction)에서만 바뀌고 그 확정이 없었다. 확정 전에 개정 계획 산출물까지 저장됐으면 savePlan 이 같은 판으로 받는다(다시 쓰지 않는다). 판 번호·
  // 바퀴 합의는 끊기지 않은 흐름(runPlanningFromRevision·runPlanningFromRevision2)과 같다.
  private async adoptReceivedRevision(
    topicId: string, received: { revision: number; result: AgentResult }, base: { markdown: string; sha256: string }, signal: AbortSignal,
  ): Promise<void> {
    const revisedPlan = this.core.requireRevisedPlan(received.result, base.markdown);
    const secondRound = this.core.dependencies.database.getFlags(topicId).closeoutRevisionUsed;
    const topic = this.core.transition(topicId, "CLAUDE_REVISION",
      `받은 개정(#${received.revision})의 계획 확정이 끝나기 전에 멈췄습니다 — 개정 턴을 다시 사지 않고 그 개정을 확정된 계획(${base.sha256.slice(0, 12)}…)`
      + " 위에 한 번 적용해 저장한 뒤 종결 확인으로 넘깁니다.");
    const storedRevisedPlan = await this.savePlan(topic, revisedPlan, secondRound ? topic.planRevision + 1 : Math.max(2, topic.planRevision + 1), signal,
      { kind: "claude-revision", revision: received.revision });
    const known = secondRound ? await this.roundKnownFindings(topicId) : received.result.findings;
    await this.runPlanningFromCloseout(topicId, received.result, storedRevisedPlan, signal, known);
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
    const revisionRoute = this.core.route(topic, { role: "planner", operation: "revision" });
    const revisionMode = this.referenceMode(topic, revisionRoute);
    const revisionTimeline = this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, known.inputSequence, revisionMode);
    const revisionDelivery = this.timelineDelivery(revisionMode, revisionTimeline);
    const revision = await this.core.turn(revisionRoute, topic, buildClaudeRevisionPrompt({
      knownPlan: known.knownPlan,
      planMarkdown: storedFirstPlan.markdown, audit, scopeGeneration: topic.scopeGeneration,
      timeline: revisionTimeline,
      timelineDelivery: revisionDelivery,
    }), signal, {
      ...(revisionDelivery ? { timelineDelivery: { prompt: revisionDelivery } } : {}),
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
    await this.core.saveAgentOutput(topic, revisionRoute, revision, "claude-revision", signal);
    if (this.core.pauseForResult(topicId, revision, "CLAUDE_REVISION", "계획을 고치려면 사용자 결정이나 외부 증거가 필요합니다.")) return;
    if (revisedPlan === null) throw new Error("개정 검증 경로 불변식 위반: pause 예측이 어긋났습니다.");
    // 판 번호는 앞으로만 간다 — 진단 계획 개정 뒤의 감사 답변 개정이 판 번호를 2로 되돌리지 않게(첫 주기는 종전대로 2판).
    const storedRevisedPlan = await this.savePlan(topic, revisedPlan, Math.max(2, topic.planRevision + 1), signal,
      this.savedResult(topicId, "claude-revision"));
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
    const revisionRoute = this.core.route(topic, { role: "planner", operation: "revision" });
    const revisionMode = this.referenceMode(topic, revisionRoute);
    const revisionTimeline = this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, known.inputSequence, revisionMode);
    const revisionDelivery = this.timelineDelivery(revisionMode, revisionTimeline);
    const revision = await this.core.turn(revisionRoute, topic, buildClaudeRevisionPrompt({
      knownPlan: known.knownPlan,
      planMarkdown: storedRevisedPlan.markdown, audit: source, scopeGeneration: topic.scopeGeneration,
      timeline: revisionTimeline,
      timelineDelivery: revisionDelivery,
      source: "closeout",
    }), signal, {
      ...(revisionDelivery ? { timelineDelivery: { prompt: revisionDelivery } } : {}),
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
    await this.core.saveAgentOutput(topic, revisionRoute, revision, "claude-revision", signal);
    if (this.core.pauseForResult(topicId, revision, "CLAUDE_REVISION", "개정 2회차에 사용자 결정이나 외부 증거가 필요합니다.")) return;
    if (revisedPlan === null) throw new Error("개정 2회차 검증 경로 불변식 위반: pause 예측이 어긋났습니다.");
    const storedNextPlan = await this.savePlan(topic, revisedPlan, topic.planRevision + 1, signal, this.savedResult(topicId, "claude-revision"));
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
    const closeoutRoute = this.core.route(topic, { role: "reviewer", operation: "closeout" });
    const closeoutMode = this.referenceMode(topic, closeoutRoute);
    const context = await preparePlanningContext(this.core, topic, storedRevisedPlan.markdown, storedRevisedPlan.sha256, closeoutMode);
    const implementationNotes = await this.core.implementationNotesOf(topicId);
    const closeoutDelivery = this.timelineDelivery(closeoutMode, context.timeline);
    const fullCloseoutDelivery = context.full ? this.timelineDelivery(closeoutMode, context.full.timeline) : undefined;
    const closeoutPrompt = (text: string, timeline: typeof context.timeline, planningContextMode: typeof context.mode,
      timelineDelivery: TimelineDeliveryPlan | undefined) => buildCodexCloseoutPrompt({
      revisedPlan: text,
      revisedPlanSHA256: storedRevisedPlan.sha256,
      claudeRevision: revision,
      timeline,
      planningContextMode,
      secondRound,
      implementationNotes,
      timelineDelivery,
    });
    const prompt = closeoutPrompt(context.text, context.timeline, context.mode, closeoutDelivery);
    const closeout = await this.core.turn(closeoutRoute, topic, prompt, signal, {
      freshSessionPrompt: context.full ? closeoutPrompt(context.full.text, context.full.timeline, "full", fullCloseoutDelivery) : undefined,
      ...(closeoutDelivery ? { timelineDelivery: { prompt: closeoutDelivery, fresh: fullCloseoutDelivery } } : {}),
      readablePaths: context.readablePaths,
      normalize: this.core.carryForwardNormalizer(revision.findings, "Codex closeout", { forReview: true }),
      check: (r) => {
        this.core.assertKind(r, "CLOSEOUT");
        assertFindingCoverage(revision.findings, r.findings, "Codex closeout");
      },
    });
    await this.core.saveAgentOutput(topic, closeoutRoute, closeout, "closeout", signal);
    if (this.core.interruptForNewUserInput(topic, context.inputSequence)) return;
    if (closeout.planSHA256 === storedRevisedPlan.sha256) await context.accept(signal, prompt);
    if (this.core.interruptForNewUserInput(topic, context.inputSequence)) return;
    // 아직 자료를 읽어야 하는 종결(결정을 청하며 읽기 의무를 남긴 열린 계획 제어 체크포인트)은 확정 결과가 아니다 — 후속 목록·구현 노트 기록, 필수 쟁점
    // 분류(개정 2회차·추가 개정 결정), 처분 되돌림·합의 판정으로 소비하기 전에 이 단계로 멈춘다(host-review 39d21df9 3차 F007). 재개 단계는 종결이라, 결정 뒤
    // retry 가 같은 종결 체크포인트에서 대기 읽기를 싣고, 그 뒤 나온 완료 종결을 아래 판정이 종전대로 분류한다. 예전에는 필수 쟁점 분류가 먼저 돌아 재개
    // 단계를 개정으로 기록하거나(2회차) 곧바로 개정 2회차로 가(1회차) 요청한 자료가 끝내 전달되지 않았다. 감사·계획·개정은 결과를 소비하기 전의
    // pauseForResult 가 이미 그 단계로 멈춘다(결정 질문이면 requestedUserDecision 이 있다).
    if (this.openReadObligation(topicId, "CODEX_CLOSEOUT")) {
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED",
        closeout.requestedUserDecision ?? "종결 확인이 결정 뒤에 읽을 자료를 남겼습니다.", "CODEX_CLOSEOUT");
      return;
    }
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
    const acknowledgementBindings = ["claude", "codex"].map(role => bindingOf(this.core.route(topic,
      role === "claude" ? { role: "planner", operation: "ack" } : { role: "reviewer", operation: "ack" })));
    const rawConsensus = await this.core.dependencies.artifacts.readLatest(topicId, "consensus");
    const previous = rawConsensus ? JSON.parse(rawConsensus) as Record<string, unknown> : null;
    const reuse = previous?.planSHA256 === sha256 && previous.scopeGeneration === topic.scopeGeneration && previous.planEpoch === topic.planEpoch &&
      stableJSON(previous.acknowledgementBindings) === stableJSON(acknowledgementBindings) && bothAgentsAcknowledged(topic.participants, sha256);
    if (!reuse && !await this.runAcknowledgements(topic, sha256, signal)) return;
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
      acknowledgementBindings,
      createdAt: new Date().toISOString(),
    }, null, 2), signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;
    if (!await new EvidenceAssessmentPipeline(this.core, (id, job, result, stop) => this.runEvidenceRevision(id, job, result, stop))
      .finishPlanning(topicId, signal)) return;
    this.core.transition(topicId, "AWAITING_USER_APPROVAL", "계획 합의가 끝났습니다. 사용자 구현 승인을 기다립니다.");
  }

  private evidenceRevisionProgress(topicId: string) {
    const db = this.core.dependencies.database, topic = db.getTopic(topicId);
    const events = db.getScopedTimeline(topicId, topic.scopeGeneration);
    const start = events.filter(event => event.payload?.evidenceRevisionPlanEpoch === topic.planEpoch).at(-1);
    if (!start || events.some(event => event.sequence > start.sequence && event.payload?.to === "AWAITING_USER_APPROVAL")) return null;
    const adopted = events.find(event => event.sequence > start.sequence && event.payload?.artifactKind === "plan" && event.payload.adoptedResult);
    const job = db.evidence.automation.jobs(topicId).find(job => job.id === start.payload?.evidenceRevisionId);
    if (!job || (!adopted && (job.binding !== stableJSON([topic.scopeGeneration, topic.planEpoch, topic.planSHA256]) ||
      job.planRevision !== topic.planRevision))) return null;
    // Recovery ownership moves to closeout, but the evidence revision remains open
    // until consensus. Its unanswered decisions must still block premature retries.
    const handedOff = Boolean(adopted && events.some(event => event.sequence > adopted.sequence && event.payload?.to === "CODEX_CLOSEOUT"));
    return { job, adopted, handedOff };
  }

  pendingEvidenceRevision(topicId: string): EvidenceAssessment | null {
    return this.evidenceRevisionProgress(topicId)?.job ?? null;
  }

  async runEvidenceRevision(topicId: string, job: EvidenceAssessment, result: AgentResult, signal: AbortSignal): Promise<void> {
    const db = this.core.dependencies.database, topic = db.getTopic(topicId);
    if (job.binding !== stableJSON([topic.scopeGeneration, topic.planEpoch, topic.planSHA256]) ||
      job.planRevision !== topic.planRevision || job.digest !== db.evidence.topic(topic).digest)
      throw new Error("계획 또는 원문이 바뀌어 이전 근거 개정을 적용하지 않았습니다.");
    const continuation = db.continuations.get(topicId);
    const actionId = this.core.active.get(topicId)!.actionId;
    if (this.pendingEvidenceRevision(topicId)?.id !== job.id || !db.evidenceActionOwnsWorkflow(topicId, actionId)) this.core.event(topicId, "system", "system",
      "완료된 근거 검토의 지적을 현재 계획에 반영합니다. 기존 판단과 검토 결과를 보존합니다.",
      { evidenceRevisionId: job.id, evidenceRevisionPlanEpoch: topic.planEpoch, evidenceRevisionBaseSHA256: topic.planSHA256,
        evidenceRevisionActionId: actionId,
        continuationId: continuation?.actionId === actionId ? continuation?.id : undefined });
    await this.runPlanningFromRevision(topicId, result,
      { markdown: (await this.core.requireCurrentPlanArtifact(topicId)).content, sha256: topic.planSHA256! }, signal);
  }

  private async runAcknowledgements(topic: Topic, sha256: string, signal: AbortSignal): Promise<boolean> {
    const planMarkdown = await this.core.requireStoredPlan(topic.id);
    for (const role of ["claude", "codex"] as const) {
      // 세션을 이어받지 않는다. ACK는 계획 본문과 기대 SHA만 있으면 끝나는 프로토콜 확인인데,
      // 기존 세션을 resume하면 합의 대화 전체를 다시 실어 나른다(2026-08-29 실측: 한 턴 $17.71,
      // cache creation 759K + cache read 1.5M + output 19,975).
      // 좌석마다 그 역할의 ACK 경로(E2b) — 좌석 키(ACK 저장·산출물 이름)는 그대로, 공급자·설정은 배정으로 정한다.
      const ackRoute = this.core.route(topic, role === "claude" ? { role: "planner", operation: "ack" } : { role: "reviewer", operation: "ack" });
      const result = await this.core.isolatedTurn(ackRoute, topic, buildPlanAckPrompt(sha256, planMarkdown), signal);
      this.core.assertKind(result, "ACK");
      await this.core.saveAgentOutput(topic, ackRoute, result, `${role}-ack`, signal);
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
    if (!sessionId || sessionId.startsWith("pending:")) throw new Error("계획을 작성한 작성자 좌석 세션이 없습니다.");
    // 작성자 좌석 세션을 만든 실제 공급자의 계획자 단계 체크포인트(E2b) — 공급자 키만으로 찾으면 같은 공급자의 검토자 체크포인트를 집는다.
    const provider = database.participantBinding(topic.id, "claude")?.provider ?? "claude";
    const checkpoint = database.latestPlannerCheckpoint(topic.id, provider);
    if (!checkpoint?.finalized || checkpoint.sessionId !== sessionId || checkpoint.scopeGeneration !== current.scopeGeneration || checkpoint.planEpoch !== current.planEpoch) {
      throw new Error(`현재 계획 응답을 작성한 작성자 좌석 세션(${provider})과 연결 정보를 확인할 수 없습니다.`);
    }
    database.planning.bindSession(current, sha256, sessionId, checkpoint.inputSequence);
  }

  // 방금 저장한 결과 산출물(채택 기록의 대상) — saveAgentOutput 바로 뒤, 같은 실행 안에서만 부른다. 주제당 실행은 하나라 그 사이 같은 종류의 다른 쓰기가 없다.
  private savedResult(topicId: string, kind: AdoptedResult["kind"]): AdoptedResult {
    const artifact = this.core.dependencies.database.latestArtifact(topicId, kind);
    if (!artifact) throw new Error(`방금 저장한 ${kind} 산출물을 찾을 수 없습니다.`);
    return { kind, revision: artifact.revision };
  }

  // 계획 저장 — 산출물 쓰기 → 늦은 응답 검사 → 계획 세션 바인딩 → 확정(계획 필드·승인 무효화·ACK 삭제·확정 이벤트를 한 transaction)이다. 확정 이벤트는
  // adopted(그 계획을 만든 결과 산출물)를 가리키는 채택 기록이다(host-review 39d21df9 5차 F010). 중간에 끊겨도 반쯤 확정된 상태가 없게 짰다:
  // - 계획 필드·ACK·이벤트가 한 transaction 이라 "계획 SHA 는 새것인데 채택 기록이 없는" 상태가 없다 — 그 상태면 확정된 계획을 바탕으로 개정을 다시 적용했다.
  // - 바인딩은 확정 앞이다. 바인딩은 계획 SHA 가 같을 때만 읽히므로(boundSession) 확정 전에 끊겨도 효력이 없고, 복구가 같은 값으로 다시 쓴다. 뒤에 두면
  //   확정 뒤 끊긴 계획에 연결 세션이 없어 구현 시작이 멈췄다. 연결을 확인할 수 없는 계획은 확정하지 않는다.
  // - 산출물까지만 쓰고 끊긴 저장(최신 plan 산출물이 이 본문이고 계획 SHA 는 아직 그것이 아니다)을 다시 부르면 그 산출물을 같은 판으로 받고 다시 쓰지 않는다.
  private async savePlan(
    topic: Topic,
    markdown: string,
    revision: number,
    signal: AbortSignal,
    adopted: AdoptedResult,
  ): Promise<{ markdown: string; sha256: string }> {
    assertPlanContract(markdown);
    const normalized = normalizePlan(normalizeToleranceBlocks(redactSecrets(markdown)));
    const database = this.core.dependencies.database;
    const sha256 = hashPlan(normalized);
    const written = database.latestArtifact(topic.id, "plan");
    const artifact = written && written.sha256 === sha256 && database.getTopic(topic.id).planSHA256 !== sha256
      ? written : await this.core.writeArtifact(topic, "plan", revision, normalized, signal);
    this.core.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
    this.bindPlanningSession(topic, artifact.sha256);
    database.applyTopicTransition({
      topicId: topic.id,
      changes: { planRevision: revision, planSHA256: artifact.sha256, approvedPlanSHA256: null },
      clearAcknowledgements: database.getTopic(topic.id).planSHA256 !== artifact.sha256,
      events: [{ actor: "claude", kind: "agent_output", state: topic.state, body: `계획 ${revision}판을 저장했습니다.`,
        payload: { artifactKind: "plan", revision, artifactRevision: artifact.revision, sha256: artifact.sha256, adoptedResult: adopted } }],
    });
    return { markdown: normalized, sha256: artifact.sha256 };
  }
}

function uniqueFindings(findings: readonly Finding[]): Finding[] {
  return [...new Map(findings.map((finding) => [finding.id, finding])).values()];
}
