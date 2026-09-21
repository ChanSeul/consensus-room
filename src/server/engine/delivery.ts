import { createHash } from "node:crypto";
import { reviewAnswerCandidate } from "./reviewRequests.js";
// 구현·리뷰·전달 파이프라인: IMPLEMENTING → CODEX_REVIEW → (CLAUDE_FIX → CODEX_FINAL_REVIEW) →
// READY_TO_DELIVER → commit/push. git 사후 검증(고아 커밋 처분 포함)이 이 파일의 계약이다.
import {
  AgentResultSchema, DeliveryInputSchema, REVIEW_DECISION_BATCH_LIMIT, REVIEW_ANSWER_BATCH_LIMIT, type AgentResult, type Finding, type TimelineEvent, type Topic, type WorkflowState,
} from "../../shared/contracts.js";
import { digestToolTrees, type ToolTreeDigest } from "../toolTree.js";
import { redactUnverifiedResult } from "../security.js";
import {
  buildContinuationPrompt, buildReviewAnswerConfirmationPrompt,
  buildStatusConfirmationPrompt,
  buildClaudeFixPrompt,
  buildCodexReviewPrompt,
  buildImplementationPrompt, buildToleranceCorrectionPrompt, type PlanRevisionNotice,
} from "../../shared/prompts.js";
import {
  assertImplementationGate,
  assertDispositionsResolved,
  assertFindingCoverage,
  dispositionRegressions,
  newFindingIDs,
  resolveBranchName,
  OVERRULE_GUIDANCE, overruleDirectiveIDs, refixDirective,
  shouldRunFixPass,
  routeMediatorOwnedFindings,
  carryForwardFindings,
  implementationInProgress,
  mergeCorrectionResult,
  salvageResultFields,
  mergeFindingSources,
  mergeAgreedSources,
  assertTransition,
} from "../../shared/workflow.js";
import { normalizeCommitPaths } from "../git.js";
import { redactAgentResult } from "../security.js";
import {
  carryForwardLedger, evaluateTolerance, parseTolerancePolicy, parseUnifiedDiff, renderToleranceSummary, type ChangedFile,
  type ToleranceLedgerEntry,
} from "../../shared/tolerance.js";
import { HandledWorkflowInterruption, type ResultNormalizer, type EngineCore } from "./core.js";
import type { TurnExpectation, WriteGuards } from "./turnExecutor.js";
import {
  accumulate, checkpointOpenRequests, requestId, workId, CheckpointCorrupt, type Accumulation, type RecoveredWork, type WorkBinding, type WorkCheckpoint, type WorkKind,
} from "./checkpoint.js";
import { acceptResult, completionVerdict, decisionRequestTexts, renderOpenRequests, type AcceptedResult, type CompletionVerdict, type OpenRequest } from "./completion.js";
import type { DiagnosisRecord } from "../../shared/diagnoses.js";
import type { FixContract } from "../../shared/fixContract.js";

// 논리 작업 실행기의 입력(구현·수정 공통).
interface WorkSetup {
  topicId: string; topic: Topic; kind: WorkKind; work: WorkBinding; plan: string; planPath: string; readablePaths: readonly string[];
  baselineHead: string; toolTreesBefore: ToolTreeDigest; inputSequence: number;
  check: (result: AgentResult) => void; carry: ResultNormalizer;
  progressKind: string; resultKind: string; deferredSource: "implementation" | "fix"; pauseFallbackMessage?: string;
  prompts: (openRequests: readonly OpenRequest[]) => { fresh: string; resume: string };
  sessionId: string | null; persistSession: (sessionId: string) => void;
  // false 면 모델 턴 없이 완료 판정 루프만 돈다(저장 결과 재사용·확인).
  initialTurn: boolean;
  legacyBase: () => Promise<{ base: AgentResult | null; ledger: ToleranceLedgerEntry[] }>;
  // 옛 산출물(legacyBase) 대신 쓸 승계 바탕 — 계획 변경 진단의 개정 뒤 첫 구현(열린 요청·개정 계획으로 다시 대조한 원장). checkpoint 가 있으면 쓰지 않는다.
  carriedSeed?: () => Promise<WorkSeed>;
  // 이 작업에 실린 중재자 진단(적용·전달됨). 적용됐고 아직 전달 전(applied)인 것이 있으면 복구 지름길(수락 이어가기·완료 확인 턴·저장 결과 재사용)을
  // 쓰지 않고 쓰기 턴을 연다 — 진단은 실제 수정 지시다. 전달은 쓰기 턴의 spawn 에, 처분은 수락 경계에서 기록한다.
  diagnoses?: DiagnosisRecord[];
  // 수락의 세 부분(CF-01): persist(비동기 저장 — 보고서 등) → [동기 현재성 검사] → transition(**동기** 상태 전이) → continue(다음 단계).
  // 검사와 전이 사이에 await 가 없어야 늦게 도착한 결정이 전이를 타고 넘어가지 않는다.
  accept: {
    persist: (accepted: AcceptedResult, acceptId: number) => Promise<void>;
    // false 면 전이하지 않았다(가드로 정지) — 호출자는 continue 를 부르지 않는다. reported: 실은 진단의 반영 보고 항목 — 전이와 **한 transaction** 으로 쓴다.
    transition: (accepted: AcceptedResult, acceptId: number, reported: FixReported) => boolean;
    continue: (accepted: AcceptedResult) => Promise<void>;
  };
}

// 수락된 결과가 실은 진단의 반영 보고(fix_reported) 항목 — 수락 전이와 한 transaction 으로 쓴다.
type FixReported = ReturnType<EngineCore["diagnoses"]["acceptedEntries"]>;

// 반영 보고를 전이 transaction 의 진단 기록·이벤트로 싣는다.
function reportedExtras(reported: FixReported, state: WorkflowState) {
  return reported
    ? { diagnosisEntries: reported.entries, events: [{ actor: "system" as const, kind: "system" as const, state, body: reported.body, payload: reported.payload }] }
    : {};
}

// 복구 직후(턴 전)의 바탕 — 결과가 없을 수 있다.
interface WorkSeed {
  base: AgentResult | null;
  openRequests: OpenRequest[];
  verifiedLedger: ToleranceLedgerEntry[];
  confirmations: number;
}
// 턴을 흡수한 뒤의 상태 — 완료 판정할 누적 결과가 있다.
interface WorkState extends WorkSeed { base: AgentResult }

function renderReport(result: AgentResult): string {
  return `# ${result.kind}\n\n${result.summary}\n\n## Findings\n\n\`\`\`json\n${JSON.stringify(result.findings, null, 2)}\n\`\`\`\n\n## Evidence\n\n${result.evidenceRefs.map((item) => `- ${item}`).join("\n") || "- 없음"}\n`;
}

// status=in_progress 로 멈춘 러너를 같은 액션 안에서 다시 여는 상한. 그 뒤엔 USER_DECISION_REQUIRED(resume IMPLEMENTING)로 넘겨 retry 로 잇는다.
const CONTINUATION_LIMIT = 4;

function isWithinSelectedPaths(path: string, selectedPaths: readonly string[]): boolean {
  return selectedPaths.some((scope) => path === scope || path.startsWith(`${scope.replace(/\/$/, "")}/`));
}

export class DeliveryPipeline {
  constructor(private readonly core: EngineCore) {}

  async runImplementation(topicId: string, signal: AbortSignal): Promise<void> {
    let topic = this.core.dependencies.database.getTopic(topicId);
    const resuming = topic.state === "IMPLEMENTING";
    assertImplementationGate(resuming ? { ...topic, state: "AWAITING_USER_APPROVAL" } : topic);
    if (!resuming) topic = this.core.transition(topicId, "IMPLEMENTING", "Claude가 승인된 계획을 구현합니다.");
    if (!topic.branchName) {
      const branchName = resolveBranchName(topic);
      await this.core.dependencies.git.createBranch(topic.worktreePath, branchName);
      this.core.assertCurrent(topicId, signal, topic.scopeGeneration, "IMPLEMENTING");
      // 이 시점의 HEAD가 이 세대 구현의 기준이다. 재시도마다 현재 HEAD를 새 기준으로 잡으면 서버가
      // 중단된 사이 생긴 비인가 커밋이 다음 재시도의 '원래 상태'로 둔갑한다(감사 ⑥).
      const implementationBaseOID = await this.core.dependencies.git.head(topic.worktreePath);
      topic = this.core.dependencies.database.updateTopic(topicId, { branchName, implementationBaseOID });
    }
    // 계획 원문은 별칭(plan.md)이 아니라 sha 로 검증한 정본 blob 경로를 넘긴다(Codex 후속 지적 6) — 본문과 같은 산출물 한 건에서 꺼내 승인 계획 sha 에 결속한다.
    const { content: plan, path: planPath } = await this.core.requireCurrentPlanArtifact(topicId);
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName!);
    const baselineHead = await this.requirePinnedBaseline(topicId, topic.worktreePath);
    const inputSequence = this.core.latestSequence(topicId);
    const sessionFlags = this.core.dependencies.database.getFlags(topicId);
    const existingImplementationSession = sessionFlags.implementationSessionId;
    // 개정 없이 넘어온 경미 지적(구현 노트)은 첫 프롬프트에 실리고, 러너 결과가 id 별 처분을 빠뜨리면 커버리지 계약이 재제출을 요구한다.
    const implementationNotes = await this.core.implementationNotesOf(topicId);
    const noteFindings: Finding[] = implementationNotes.map((note) => ({
      id: note.id, title: note.title, severity: note.severity, disposition: "AGREED_ACTION", rationale: note.rationale,
      evidenceRefs: [], requiresUserDecision: false,
    }));
    // 결정·증거 원문 산출물(읽기 허용) — 세션 압축 뒤에도 원문을 다시 찾을 수 있다(Codex 감사 D02).
    const decisionsPath = await this.writeDecisionsDigest(topic, signal);
    // 적용된 중재자 진단(구현 단계 반환) — 수정 지시로 싣고, findings 계약으로 id 별 처분 보고를 받는다.
    const diagnoses = this.core.diagnoses.forImplementation(topicId);
    const diagnosisFindings = this.core.diagnoses.findings(diagnoses);
    const diagnosisPrompts = await this.core.diagnoses.prompts(diagnoses);
    const readablePaths = [planPath, decisionsPath, ...diagnosisPrompts.paths];
    // 계획 변경 진단의 개정 계획이 승인된 뒤의 구현: 첫 전달이면 이어받은 세션에도 개정 계획 전문과 개정 알림을 싣고, checkpoint 가 없으면 옛 산출물
    // 대신 승계 기록(열린 요청·개정 계획으로 다시 대조한 허용 오차 원장)에서 시작한다. 구현 기준 커밋·브랜치·작업 트리는 그대로다.
    const revisionCarry = await this.core.diagnoses.planRevisionForImplementation(topicId);
    let planRevised: PlanRevisionNotice | undefined;
    let carriedSeed: (() => Promise<WorkSeed>) | undefined;
    if (revisionCarry) {
      const carry = revisionCarry.carry;
      const policy = parseTolerancePolicy(plan);
      const evaluation = policy ? evaluateTolerance(policy, await this.collectChangedFiles(topic), carry.verifiedLedger) : null;
      const ledgerOk = !evaluation || evaluation.violations.length === 0;
      const ledgerNote = !policy ? "개정 계획에 허용 오차 규칙이 없습니다."
        : ledgerOk ? `승계한 허용 오차 원장 ${carry.verifiedLedger.length}행이 개정 계획의 규칙·현재 diff 대조를 다시 통과했습니다(이번 결과에는 추가·변경분만 제출).`
        : `승계한 허용 오차 원장이 개정 계획의 규칙·현재 diff 와 맞지 않습니다(위반 ${evaluation?.violations.length ?? 0}건) — 개정 규칙에 맞는 원장을 이번 결과에 다시 제출하세요: ${(evaluation?.violations ?? []).slice(0, 5).join(" · ")}`;
      const ids = revisionCarry.records.map((record) => record.id);
      // 첫 전달: 개정 계획이 막 저장됐거나(plan_revised), 전달됐지만 그 처분을 담은 결과가 구현 작업에 아직 없는(spawn 뒤 응답 전에 끊긴) 경우 —
      // R5 와 같은 기준이다(2026-09-15 감사: 끊긴 뒤 retry 는 진단만 다시 싣고 개정 계획 전문·알림 없이 '같은 계획'이라고 안내했다).
      // 손상 checkpoint 는 삼키지 않는다 — runWork 복구와 같은 규칙으로 보존한 채 멈춘다(감사 6차 #7: `.catch(() => null)` 이 손상·I/O 오류를 '첫 전달' 로 삼켰다).
      let recoveredImplementation: RecoveredWork | null;
      try {
        recoveredImplementation = await this.core.checkpoints.recoverFor(topicId, this.core.checkpoints.binding(topic, "IMPLEMENTATION", existingImplementationSession));
      } catch (error) {
        if (!(error instanceof CheckpointCorrupt)) throw error;
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, "IMPLEMENTING", { checkpointCorrupt: error.revision });
        return;
      }
      if (this.core.diagnoses.pendingFor(revisionCarry.records, recoveredImplementation?.accumulated ?? null).length > 0) {
        planRevised = { previousPlanSHA256: carry.basePlanSHA256, diagnosisIds: ids, remainingSteps: carry.remainingSteps, ledgerNote };
      }
      carriedSeed = async () => {
        this.core.event(topicId, "system", "system",
          `계획 변경 진단 ${ids.join(", ")} 의 승계 기록에서 구현을 시작합니다 — 열린 요청 ${carry.openRequests.length}건 승계. ${ledgerNote}`,
          { planRevisionCarry: { ids, openRequests: carry.openRequests.map((request) => request.id), ledgerRows: carry.verifiedLedger.length, ledgerRevalidated: ledgerOk } });
        return { base: null, openRequests: carry.openRequests.map((request) => ({ ...request })), verifiedLedger: ledgerOk ? [...carry.verifiedLedger] : [], confirmations: 0 };
      };
    }
    // 도구 트리 기준은 산출물(tool-tree-baseline)이다 — 감지된 변경은 중재자가 재동기화 뒤 rebaseline 하기 전까지 재시도로 통과하지 않는다(F04).
    const toolTreesBefore = await this.toolTreeBaseline(topic, signal);
    this.assertToolTreesIntact(topic, toolTreesBefore, "재개 전");
    const promptBase = {
      planMarkdown: plan, planSHA256: topic.planSHA256!, worktreePath: topic.worktreePath, branchName: topic.branchName!, planPath,
      decisionsPath, implementationNotes, diagnoses: diagnosisPrompts.prompts, planRevised,
    };
    const scopedTopic = topic;
    await this.runWork({
      topicId, topic, kind: "IMPLEMENTATION", work: this.core.checkpoints.binding(topic, "IMPLEMENTATION", existingImplementationSession),
      plan, planPath, readablePaths, baselineHead, toolTreesBefore, inputSequence,
      check: (r: AgentResult) => {
        this.core.assertKind(r, "IMPLEMENTATION");
        assertFindingCoverage(noteFindings, r.findings, "Claude implementation(구현 노트)");
        if (diagnosisFindings.length) {
          assertFindingCoverage(diagnosisFindings, r.findings, "Claude implementation(중재자 진단)");
          assertDispositionsResolved(diagnosisFindings, r, "Claude implementation(중재자 진단)");
        }
      },
      carry: this.core.carryForwardNormalizer(noteFindings, "Claude implementation"),
      progressKind: "implementation-progress", resultKind: "implementation-result", deferredSource: "implementation",
      // 이어지는 턴은 계획 본문과 이미 받은 이벤트를 다시 싣지 않는다(2026-09-08 Codex 제안 ⑥). 세션 유실로 새 세션이 되면 실행기가 전문 프롬프트로
      // 폴백한다. '전달한 sequence' 는 턴이 실제로 돌아온 뒤에만 적는다 — 429 로 끊긴 턴이 못 본 이벤트를 다음 retry 가 다시 싣게 하기 위해서다.
      prompts: (openRequests) => ({
        fresh: buildImplementationPrompt({
          ...promptBase, openRequests, timeline: this.core.dependencies.database.getPromptTimeline(topicId, scopedTopic.scopeGeneration),
        }),
        resume: buildImplementationPrompt({
          ...promptBase, openRequests, resumedSession: true,
          timeline: this.core.dependencies.database.getPromptTimeline(topicId, scopedTopic.scopeGeneration, sessionFlags.implementationPromptSequence ?? 0),
        }),
      }),
      sessionId: existingImplementationSession,
      diagnoses,
      carriedSeed,
      // 세션 저장이 검증보다 먼저다 — 검증이 턴을 거부해도 세션이 남아야 재시도가 재구현 없이 resume된다
      // (2026-09-01 S1.1: 저장 전에 거부돼 수동 DB 복구가 필요했던 사건의 프로그램적 방지).
      persistSession: (sessionId) => this.core.dependencies.database.setImplementationSession(topicId, sessionId),
      initialTurn: true,
      legacyBase: async () => ({
        base: await this.legacyPendingOriginal(topicId, scopedTopic, "IMPLEMENTING"), ledger: await this.legacyAcceptedLedger(topicId),
      }),
      accept: {
        persist: async (accepted) => { await this.core.writeArtifact(scopedTopic, "implementation", 1, renderReport(accepted), signal); },
        transition: (_accepted, _acceptId, reported) => {
          this.core.transitionWith(topicId, "CODEX_REVIEW", "Codex가 구현 결과를 읽기 전용으로 검토합니다.", reportedExtras(reported, "CODEX_REVIEW"));
          return true;
        },
        continue: async () => { await this.runReview(topicId, signal, false); },
      },
    }, signal);
  }

  // ---- 논리 작업 실행기(구현·수정 공통, PLAN §2): 복구 → 턴 → 흡수(계약·허용 오차·누적 checkpoint) → 완료 판정 루프(계속 진행·확인·정지·수락) ----
  private async runWork(setup: WorkSetup, signal: AbortSignal): Promise<void> {
    const { topicId, topic } = setup;
    const db = this.core.dependencies.database;
    const expected = { state: setup.work.resumeState, scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planSHA256: topic.planSHA256 };
    const writeGuards: WriteGuards = { requireApprovedPlan: true, baselineHead: setup.baselineHead, toolTreeBaseline: setup.toolTreesBefore };
    // 1) 복구 — 논리 작업(workId)의 최신 checkpoint. 손상이면 보존한 채 멈춘다. 없으면 옛 산출물(legacy)에서 바탕을 만든다.
    let recovered: RecoveredWork | null;
    try {
      recovered = await this.core.checkpoints.recoverFor(topicId, setup.work);
    } catch (error) {
      if (!(error instanceof CheckpointCorrupt)) throw error;
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, setup.work.resumeState, { checkpointCorrupt: error.revision });
      return;
    }
    let seed: WorkSeed;
    // 이 action 안에서 워킹트리 대조(허용 오차)를 통과한 누적본인가 — 복구·확인 경로로 왔으면 수락 전에 다시 대조한다(읽기 전용 확인 턴 뒤에
    // 워킹트리가 바뀌어 있어도 검증 없이 리뷰로 새지 않게).
    let freshlyVerified = false;
    let initialTurn = setup.initialTurn;
    // 복구 지름길을 막는 진단: 전달할 차례이거나, 전달됐지만 그 처분을 담은 결과가 아직 저장되지 않은 것(host-review R5 — spawn 뒤 응답 전에 죽은 턴).
    const pendingDiagnoses = this.core.diagnoses.pendingFor(setup.diagnoses ?? [], recovered?.accumulated ?? null);
    const diagnosisPending = pendingDiagnoses.length > 0;
    if (recovered) {
      const checkpoint = recovered.checkpoint;
      const newInput = this.userInputSince(topic, checkpoint.inputSequence);
      const confirmationExecuted = checkpoint.phase === "before-confirmation" && db.getTimeline(topicId)
        .some((event) => event.payload?.confirmationExecuted === checkpoint.revision);
      if (checkpoint.phase === "accepting" || checkpoint.phase === "accepted") {
        // 수락 복구도 일반 수락과 같은 현재성 검사에 결속된다(CF-01): 새 결정·증거가 왔으면 반영할 쓰기 턴을, 워킹트리가 수락 시점과 다르면
        // 다시 대조·판정을 거친 뒤에만 채택·전이한다. 둘 다 아니면 acceptId 기준으로 남은 후속만 한다.
        const snapshot = await this.core.dependencies.git.snapshot(topic.worktreePath);
        const treeChanged = !checkpoint.worktree || checkpoint.worktree.head !== snapshot.head || checkpoint.worktree.diffSHA256 !== snapshot.diffSHA256;
        if (!newInput && !treeChanged && !diagnosisPending) {
          await this.finishAccept(setup, checkpoint, signal);
          return;
        }
        this.core.event(topicId, "system", "system",
          `수락 checkpoint #${checkpoint.revision}(${checkpoint.phase}) 뒤에 ${newInput ? "새 결정·증거가 도착해" : "워킹트리가 바뀌어"} 수락을 그대로 이어가지 않습니다 — ${newInput ? "반영할 쓰기 턴을 연 뒤" : "현재 변경분을 다시 대조·판정한 뒤"} 다시 수락합니다.`,
          { acceptNotResumed: checkpoint.revision, newInput: Boolean(newInput), treeChanged });
        if (!newInput && !diagnosisPending) initialTurn = false;
      } else if (checkpoint.phase === "before-confirmation") {
        // 확인 예약 뒤 종료됐다 — 쓰기를 다시 열지 않는다(CF-05). 실행 기록(confirmationExecuted 이벤트)이 없으면 예약만 된 것이라 그 확인을 이어서
        // 하고, 있으면 확인은 이미 실행됐고 결과만 잃은 것이므로 횟수를 환급하지 않는다(그 결과는 새 결정 없이는 다시 사지 않는다).
        // 적용된 진단이 있으면 확인 예약은 진단 반영 쓰기 턴으로 대체된다(쓰기를 다시 여는 사유가 결정이 아니라 수정 지시다).
        if (!diagnosisPending) initialTurn = false;
        if (!diagnosisPending) this.core.event(topicId, "system", "system",
          `checkpoint #${checkpoint.revision} 는 완료 상태 확인 턴 ${confirmationExecuted ? "실행 뒤 결과 저장 전" : "예약"} 상태였습니다 — 쓰기 턴 없이 ${confirmationExecuted ? "확인 소비를 유지한 채 이어갑니다" : "읽기 전용 확인을 이어갑니다"}.`,
          { confirmationResumed: checkpoint.revision, confirmationExecuted });
      }
      const openRequests = checkpointOpenRequests({ ...checkpoint, accumulated: recovered.accumulated });
      // 확인 횟수: 예약(before-confirmation)은 실행이 아니다. 멈춘 뒤 새 결정이 올라왔으면 그 결정에 대해 확인 1회를 다시 허용한다(자동 무제한이
      // 아니라 사용자 결정 1건당 1회 — "결정을 올리고 재시도" 안내가 실제로 통하게, CF-05).
      const confirmations = checkpoint.phase === "before-confirmation"
        ? (confirmationExecuted ? checkpoint.confirmations : Math.max(0, checkpoint.confirmations - 1))
        : (checkpoint.phase === "paused" && newInput ? 0 : checkpoint.confirmations);
      seed = { base: recovered.accumulated, openRequests, verifiedLedger: [...recovered.verifiedLedger], confirmations };
      this.core.event(topicId, "system", "system",
        `누적 checkpoint #${checkpoint.revision}(${checkpoint.phase}, ${workId(setup.work)}) 에서 이어갑니다 — 열린 요청 ${seed.openRequests.length}건, 검증 원장 ${seed.verifiedLedger.length}행.`,
        { checkpointResumed: checkpoint.revision, phase: checkpoint.phase, workId: workId(setup.work) });
    } else if (setup.carriedSeed) {
      seed = await setup.carriedSeed();
    } else {
      const legacy = await setup.legacyBase();
      const asked = legacy.base ? decisionRequestTexts(legacy.base) : [];
      seed = {
        base: legacy.base, verifiedLedger: legacy.ledger, confirmations: 0,
        // 옛 산출물의 요청은 제시 시점을 모른다 — 0 으로 두면 그 뒤의 모든 결정이 "요청 뒤 결정" 이 되어 해소 확인을 거친다.
        openRequests: asked.map((text) => ({ id: requestId(text, 0), text, askedAfterSequence: 0 })),
      };
      if (legacy.base) {
        this.core.event(topicId, "system", "system",
          "직전 턴이 교정·계속 진행 도중 끊겨 보존해 둔 미완료 보고(요약·쟁점·증거·요청 결정)를 이번 재개 결과에 병합합니다.", { pendingCorrectionMerged: true });
      }
    }
    // 직전 작업 checkpoint(같은 세대·계획 주기의 최신 checkpoint 가 다른 작업의 것) — 열린 요청 승계와 반박 검사의 근거다. 손상이면 복구와 같은 규칙으로 보존한
    // 채 멈춘다 — 삼키면 그 작업의 열린 요청·반박을 잃은 채 새 작업을 열었다(2026-09-15 감사 5차 #3).
    let previous: WorkCheckpoint | null = null;
    if (!recovered || !seed.base) {
      try {
        previous = await this.previousWorkCheckpoint(topic, setup.work);
      } catch (error) {
        if (!(error instanceof CheckpointCorrupt)) throw error;
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, setup.work.resumeState, { checkpointCorrupt: error.revision });
        return;
      }
    }
    // 논리 작업이 바뀌어(진단 추가·정정으로 수정 원본이 바뀜, 허용 오차 개정 등) 이 작업의 checkpoint 가 없으면, 같은 세대·같은 계획 주기의 최신 checkpoint 에 남은 열린 요청을
    // 승계한다 — 요청은 작업이 아니라 주제·계획에 속한다. 결과·원장은 승계하지 않는다(다른 작업의 누적본이다) — host-review R2.
    if (!recovered) {
      const inherited = previous ? checkpointOpenRequests(previous) : [];
      const missing = inherited.filter((request) => !seed.openRequests.some((open) => open.id === request.id));
      if (missing.length > 0) {
        seed = { ...seed, openRequests: [...seed.openRequests, ...missing] };
        this.core.event(topicId, "system", "system",
          `이전 작업(checkpoint)에 남은 열린 요청 ${missing.map((request) => request.id).join(", ")} 을(를) 이 작업으로 승계합니다 — 러너가 id 로 해소해야 닫힙니다.`,
          { openRequestsInherited: missing.map((request) => request.id) });
      }
    }
    // 복구한 누적본에 러너가 이미 돌려보낸 진단(반박·증거 요청)이 있으면 새 턴을 열지 않고 중재자에게 돌려보낸다 — 처분을 기록하기 전에 끊긴 턴
    // (교정·계속 진행 도중의 종료·취소)이 남긴 반박을 잃고 같은 지시를 다시 싣지 않게(host-review R3 잔여). 적용은 등록 상태의 진단만 받고 정정은
    // 새 진단(supersedes)이라, 돌려보낸 진단이 다시 실려 이 검사를 되풀이하지 않는다.
    // 정정·해결로 닫힌 진단의 옛 처분(증거·결정 요청, 미반영)이 누적본에 남아 완료 판정을 막지 않게 판단이 끝난 처분으로 바꾼다 — 닫힌 진단은 중재자가
    // 처리했다(2026-09-15 감사: needs_evidence 진단을 정정해 적용해도 옛 EXTERNAL_EVIDENCE 가 BLOCKED_ON_EVIDENCE 를 되풀이했다).
    if (seed.base) seed = { ...seed, base: settleClosedDiagnoses(seed.base, this.core.diagnoses.mediatorClosedIds(topicId)) };
    // 작업 id 가 바뀌어(진단 추가·허용 오차 개정) 이 작업의 checkpoint 가 없으면 같은 세대·계획 주기의 직전 작업 checkpoint 를 본다 — 거기에만 남은
    // 반박을 잃고 같은 지시를 다시 싣지 않게(2026-09-15 감사).
    const returnSource = recovered && seed.base
      ? { base: seed.base, revision: recovered.checkpoint.revision }
      : previous ? { base: previous.accumulated, revision: previous.revision } : null;
    if (returnSource) {
      const returned = this.recordDiagnosisReturns(setup, returnSource.base);
      if (returned) {
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", returned.message, setup.work.resumeState,
          { diagnosisReturned: returned.ids, checkpointResumed: returnSource.revision });
        return;
      }
    }
    let sessionId = setup.work.sessionId;
    let work: WorkBinding = setup.work;
    let state: WorkState;
    // 멈춘(paused) 결과가 열린 요청만 빼면 완료였고 그 뒤 결정이 올라왔으면 쓰기 턴을 다시 사지 않는다 — 읽기 전용 확인 턴(요청 해소 여부)으로
    // 간다. 결정이 REFIX 를 지시하면 저장 결과는 낡은 것이므로 쓰기 턴을 다시 연다. 미완료(in_progress·blocked)면 쓰기 턴이 남은 단계를 한다.
    if (recovered && recovered.checkpoint.phase === "paused" && seed.base && initialTurn && !diagnosisPending) {
      const decisions = db.getTimeline(topicId, recovered.checkpoint.inputSequence)
        .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
      const completeApartFromRequests = completionVerdict(seed.base, {
        openRequests: [], decisionAfterRequest: false, unresolvedDiagnoses: this.unresolvedDiagnoses(setup, seed.base),
      }).kind === "completed";
      if (decisions.some((event) => refixDirective(event.body))) {
        this.core.event(topicId, "system", "system",
          `결정의 REFIX 지시로 저장된 ${setup.kind === "FIX" ? "수정" : "구현"} 결과(checkpoint #${recovered.checkpoint.revision})를 재사용하지 않고 ${setup.kind === "FIX" ? "수정" : "구현"} 턴을 다시 엽니다.`);
      } else if (completeApartFromRequests && seed.openRequests.length > 0 && decisions.length > 0) {
        initialTurn = false;
        this.core.event(topicId, "system", "system",
          `저장된 ${setup.kind === "FIX" ? "수정" : "구현"} 결과(checkpoint #${recovered.checkpoint.revision})는 열린 요청 ${seed.openRequests.length}건 말고는 완료였고 그 뒤 결정이 올라왔습니다 — 쓰기 턴을 다시 사지 않고 읽기 전용 확인 턴으로 해소 여부를 확인합니다.`,
          { storedResultConfirm: recovered.checkpoint.revision });
      }
    }
    if (diagnosisPending) {
      const ids = pendingDiagnoses.map((record) => record.id);
      this.core.event(topicId, "system", "system",
        `적용된 중재자 진단 ${ids.join(", ")} 을(를) 전달하는 쓰기 턴을 엽니다 — 수락 이어가기·완료 확인 턴·저장 결과 재사용으로 건너뛰지 않습니다.`, { diagnosisTurn: ids });
    }
    // 2) 턴 — 실행기가 adapter 호출 전·spawn 직전에 허용 검사를 하고, 응답 수신 시 채택 검사를 한다.
    if (initialTurn) {
      const prompts = setup.prompts(seed.openRequests);
      // 진단 전달 기록 — 프로세스가 뜨는 순간(spawn). 프로세스를 띄우지 않는 어댑터를 위해 정상 반환 뒤에도 한 번(멱등). spawn 전 거부는 전달이 아니다.
      const deliverDiagnoses = (moment: "spawn" | "return") => {
        if (setup.diagnoses?.length) this.core.diagnoses.markDelivered(topicId, setup.diagnoses, { moment, workId: workId(setup.work) });
      };
      const outcome = await this.core.executor.execute({
        role: "claude", topic, signal, purpose: "턴", inputSequence: setup.inputSequence, expected, write: true, writeGuards,
        session: sessionId
          ? { mode: "resume", sessionId, fallbackFresh: { prompt: prompts.fresh, onSessionCreated: setup.persistSession } }
          : { mode: "create", onSessionCreated: setup.persistSession },
        prompt: sessionId ? prompts.resume : prompts.fresh, implementation: true, readablePaths: setup.readablePaths,
        settings: this.core.executionSettings(topicId, "claude", true),
        onSpawn: () => deliverDiagnoses("spawn"),
        // 세션 저장이 검증·채택 검사보다 먼저다 — 검증이 턴을 거부해도 세션이 남아야 재시도가 재구현 없이 resume 된다(2026-09-01 S1.1).
        onResponse: (outcome) => {
          if (outcome.created || outcome.sessionId !== sessionId) setup.persistSession(outcome.sessionId);
          db.updateTopic(topicId, { implementationPromptSequence: setup.inputSequence });
        },
      });
      deliverDiagnoses("return");
      sessionId = outcome.sessionId;
      work = { ...setup.work, sessionId };
      this.assertToolTreesIntact(topic, setup.toolTreesBefore, `${setup.kind === "FIX" ? "자동 수정" : "구현"} 중`);
      await this.assertBaselineIntact(topic, setup.baselineHead, `${setup.kind === "FIX" ? "자동 수정" : "구현"} 중`);
      const absorbed = await this.absorbTurn(setup, work, seed, outcome.result, sessionId, expected, writeGuards, signal);
      if (!absorbed) return;
      state = absorbed;
    } else {
      if (!seed.base) throw new Error("완료 판정할 결과가 없습니다.");
      state = { ...seed, base: seed.base };
    }
    if (!sessionId) throw new Error("세션 없이 완료 판정 루프에 들어왔습니다.");
    if (initialTurn) freshlyVerified = true;
    // 3) 완료 판정 루프
    let continuations = 0;
    for (;;) {
      // 루프에 들어오는 모든 누적본(첫 턴·복구·재대조·계속 진행·확인 턴)에서 먼저 본다 — 러너가 이 작업에 실린 진단을 반박하거나 증거를 요구했으면
      // 결과를 보존한 채 중재자에게 돌려보낸다. 판정·수락보다 앞이라, 재대조가 연 허용 오차 교정 턴의 반박도 수락으로 새지 않는다(host-review R3·2026-09-14 감사).
      if (await this.returnDiagnosesToMediator(setup, work, state, signal)) return;
      const verdict = completionVerdict(state.base, {
        openRequests: state.openRequests, decisionAfterRequest: this.decisionAfter(topic, state.openRequests), unresolvedDiagnoses: this.unresolvedDiagnoses(setup, state.base),
      });
      if (verdict.kind === "completed") {
        if (!freshlyVerified) {
          // 재대조는 새 턴과 같은 흡수 경로(absorbTurn)를 지난다 — 재대조가 연 허용 오차 교정과 그 안의 계약 교정도 같은 checkpoint·누적 계약을 받고,
          // 교정 응답(요청·증거·원장·상태)은 누적된 뒤 **다시 판정**된다(CF-02·CF-04 잔여).
          const reverified = await this.absorbTurn(setup, work, state, state.base, sessionId, expected, writeGuards, signal, state.confirmations);
          if (!reverified) return;
          state = reverified;
          freshlyVerified = true;
          continue;
        }
        await this.acceptWork(setup, work, state, verdict, signal);
        return;
      }
      if (verdict.kind === "await-input") {
        await this.pauseWork(setup, work, state, verdict.reason === "external-evidence" ? "BLOCKED_ON_EVIDENCE" : "USER_DECISION_REQUIRED",
          verdict.message || setup.pauseFallbackMessage || "사용자 결정이 필요합니다.", { verdict: verdict.reason, openRequests: state.openRequests.map((request) => request.id) }, signal);
        return;
      }
      if (verdict.kind === "continue") {
        if (continuations >= CONTINUATION_LIMIT) {
          await this.pauseWork(setup, work, state, "USER_DECISION_REQUIRED",
            `러너가 계속 진행 상한(${CONTINUATION_LIMIT}회)에 닿았는데 아직 in_progress 입니다 — 남은 단계: ${verdict.remainingSteps.join(" · ") || "(명시 없음)"}. 재시도(retry)로 같은 세션에서 이어갑니다.`,
            { continuationExhausted: true, remainingSteps: verdict.remainingSteps }, signal);
          return;
        }
        continuations += 1;
        // 호출을 열기 전에 누적본을 보존한다(옛 progress 산출물은 사람·옛 소비처 호환).
        await this.core.saveAgentOutput(topic, "claude", state.base, setup.progressKind, signal);
        await this.core.checkpoints.record(topic, {
          work, phase: "before-continuation", accumulated: state.base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
          openRequests: state.openRequests, confirmations: state.confirmations,
        }, signal);
        this.core.event(topicId, "system", "system",
          `러너가 진행 중(status=in_progress)으로 멈췄습니다 — 남은 단계 ${verdict.remainingSteps.length}개. 같은 세션에서 계속 진행합니다(${continuations}/${CONTINUATION_LIMIT}).`,
          { continuation: continuations, remainingSteps: verdict.remainingSteps });
        const continued = await this.core.executor.execute({
          role: "claude", topic, signal, purpose: "계속 진행 턴", inputSequence: setup.inputSequence, expected, write: true, writeGuards,
          session: { mode: "resume", sessionId },
          prompt: buildContinuationPrompt(verdict.remainingSteps, continuations, CONTINUATION_LIMIT, setup.kind, state.openRequests),
          implementation: true, readablePaths: setup.readablePaths, settings: this.core.executionSettings(topicId, "claude", true),
        });
        await this.assertBaselineIntact(topic, setup.baselineHead, "계속 진행 중");
        this.assertToolTreesIntact(topic, setup.toolTreesBefore, "계속 진행 중");
        const absorbed = await this.absorbTurn(setup, work, state, continued.result, sessionId, expected, writeGuards, signal);
        if (!absorbed) return;
        state = absorbed;
        freshlyVerified = true;
        continue;
      }
      // needs-confirmation — 결과마다 읽기 전용 확인은 1회. 그래도 불명확하면 보존한 채 멈춘다(PLAN §3).
      if (state.confirmations >= 1) {
        const open = state.openRequests.length ? `\n${renderOpenRequests(state.openRequests)}` : "";
        await this.pauseWork(setup, work, state, "USER_DECISION_REQUIRED",
          `완료 상태를 확인하지 못했습니다(읽기 전용 확인 1회 소진): ${verdict.message} — 결과는 보존했습니다. 결정을 올리고 재시도하면 같은 세션에서 이어갑니다.${open}`,
          { confirmationExhausted: true, verdict: verdict.reason, openRequests: state.openRequests.map((request) => request.id) }, signal);
        return;
      }
      state = { ...state, confirmations: 1 };
      const reservation = await this.core.checkpoints.record(topic, {
        work, phase: "before-confirmation", accumulated: state.base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
        openRequests: state.openRequests, confirmations: 1,
      }, signal);
      this.core.event(topicId, "system", "system", `완료 판정 보류 — ${verdict.message} 읽기 전용 확인 턴을 1회 엽니다.`, { confirmation: verdict.reason });
      const decisionsSince = state.openRequests.length
        ? db.getTimeline(topicId, Math.min(...state.openRequests.map((request) => request.askedAfterSequence)))
          .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && ["decision", "evidence"].includes(event.kind))
        : [];
      // 실행 기록(영속, CF-05): 프로세스가 **뜨는 순간**(spawn) 남긴다 — 실행 뒤 오류로 끝나도 "실행했다" 는 기록이 남아 재개가 미실행으로 환급하지
      // 않는다(r3). 프로세스를 띄우지 않는 어댑터를 위해 정상 반환 뒤에도 같은 기록을 한 번 남긴다. spawn 전 거부(허용 검사)는 기록이 없어 환급된다.
      let executionRecorded = false;
      const recordExecution = (moment: "spawn" | "return") => {
        if (executionRecorded) return;
        executionRecorded = true;
        this.core.event(topicId, "system", "system", `완료 상태 확인 턴 실행(${moment === "spawn" ? "프로세스 시작" : "응답 수신"}, checkpoint #${reservation.revision}).`,
          { confirmationExecuted: reservation.revision, moment });
      };
      const confirmed = await this.core.executor.execute({
        role: "claude", topic, signal, purpose: "완료 확인", inputSequence: setup.inputSequence, expected, write: false,
        session: { mode: "resume", sessionId }, implementation: false, protocolOnly: true, readablePaths: setup.readablePaths,
        prompt: buildStatusConfirmationPrompt({ kind: setup.kind, reason: verdict.message, accumulated: state.base, planPath: setup.planPath, openRequests: state.openRequests, decisionsSince }),
        settings: { ...this.core.executionSettings(topicId, "claude", true), effort: "low" },
        onSpawn: () => recordExecution("spawn"),
      });
      recordExecution("return");
      const parsed = AgentResultSchema.safeParse(confirmed.result);
      if (!parsed.success || parsed.data.kind !== setup.kind) {
        this.core.event(topicId, "system", "system", "확인 턴 응답이 계약을 어겨 상태를 확정하지 못했습니다(보존).", { confirmationInvalid: true });
        continue; // confirmations=1 → 다음 반복에서 보존한 채 멈춘다
      }
      // 확인 턴은 저장된 원본 위에 허용된 필드(상태·남은 단계·해소 표식·blocked 요청)만 바꾸는 연산이다 — 쟁점·증거·요약·메모리 갱신·원장은
      // 원본 그대로(CF-06: 재구성하면 memoryUpdates 가 사라졌다). 원본의 requestedUserDecision 은 열린 요청 렌더링이라 다시 요청으로 넣지 않는다.
      const { requestedUserDecision: _rendered, status: _status, remainingSteps: _remaining, ...original } = state.base;
      const confirmation: AgentResult = {
        ...original,
        ...(parsed.data.status ? { status: parsed.data.status } : {}),
        ...(parsed.data.remainingSteps ? { remainingSteps: parsed.data.remainingSteps } : {}),
        ...(parsed.data.resolvesRequestedDecision ? { resolvesRequestedDecision: true } : {}),
        ...(parsed.data.resolvedRequestId ? { resolvedRequestId: parsed.data.resolvedRequestId } : {}),
        ...(parsed.data.resolvedRequestIds?.length ? { resolvedRequestIds: parsed.data.resolvedRequestIds } : {}),
        ...(parsed.data.status === "blocked" && parsed.data.requestedUserDecision ? { requestedUserDecision: parsed.data.requestedUserDecision } : {}),
      };
      const acc = accumulate(state.base, confirmation, state.openRequests, setup.inputSequence);
      this.reportAccumulation(topicId, acc);
      state = { ...state, base: acc.result, openRequests: acc.openRequests };
      await this.core.checkpoints.record(topic, {
        work, phase: "verified", accumulated: state.base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
        openRequests: state.openRequests, confirmations: 1,
      }, signal);
    }
  }

  // 러너가 이 작업에 실린 진단을 반박(REFUTED·수정 불필요·범위 밖)하거나 증거·결정을 요구하면 진단을 refuted·needs_evidence 로 기록하고 결과를
  // 보존한 채 멈춘다 — 같은 지시를 자동으로 반복하지 않고, 적용 대기 검사가 중재자의 정정 전 재개를 막는다(host-review R3).
  private async returnDiagnosesToMediator(setup: WorkSetup, work: WorkBinding, state: WorkState, signal: AbortSignal): Promise<boolean> {
    const returned = this.recordDiagnosisReturns(setup, state.base);
    if (!returned) return false;
    await this.pauseWork(setup, work, state, "USER_DECISION_REQUIRED", returned.message, { diagnosisReturned: returned.ids }, signal);
    return true;
  }

  // 이 작업에 실린 진단(닫힌 것 제외) 중 결과가 반영도 반환도 보고하지 않은 것 — 반환 처분은 판정 루프 머리에서 이미 중재자에게 돌아갔다.
  private unresolvedDiagnoses(setup: WorkSetup, result: AgentResult): string[] {
    const closed = this.core.diagnoses.mediatorClosedIds(setup.topicId);
    return (setup.diagnoses ?? []).filter((record) => !closed.has(record.id)).filter((record) => {
      const finding = result.findings.find((item) => item.id === record.id);
      return !finding || finding.disposition === undefined || finding.disposition === "AGREED_ACTION";
    }).map((record) => record.id);
  }

  // 결과가 돌려보낸 진단(반박·증거 요청)을 refuted·needs_evidence 로 기록한다 — 정지는 호출자 몫이다(일반 경로는 pauseWork, 허용 오차 정지·복구는
  // 기록 뒤 인터럽트). 진단 등록·적용은 작업 중에 막히므로(assertNoActiveWork) setup 의 진단 목록이 턴 도중 낡지 않는다.
  private recordDiagnosisReturns(setup: WorkSetup, result: AgentResult): { ids: string[]; message: string } | null {
    const returned = this.core.diagnoses.returnedBy(setup.diagnoses ?? [], result);
    if (returned.length === 0) return null;
    const message = this.core.diagnoses.recordReturned(setup.topicId, returned, setup.kind === "FIX" ? "수정 턴" : "구현 턴");
    return { ids: returned.map((item) => item.record.id), message };
  }

  // 같은 세대·같은 계획 주기의 최신 checkpoint 가 다른 논리 작업의 것이면 그 checkpoint — 열린 요청 승계와 복구 시점 반박 검사의 공통 근거다(없으면 null).
  // 손상이면 CheckpointCorrupt 를 그대로 던진다 — 호출자(runWork)가 보존한 채 멈춘다(감사 5차 #3: 삼키면 그 작업의 열린 요청을 잃은 채 새 작업을 열었다).
  private async previousWorkCheckpoint(topic: Topic, work: WorkBinding): Promise<WorkCheckpoint | null> {
    const latest = await this.core.checkpoints.latest(topic.id);
    if (!latest || latest.work.scopeGeneration !== topic.scopeGeneration || latest.work.planEpoch !== topic.planEpoch) return null;
    return workId(latest.work) === workId(work) ? null : latest;
  }

  // 턴 응답 하나를 누적본에 흡수한다: turn-result checkpoint(raw) → 계약(교정 전 checkpoint) → 허용 오차(교정 전 checkpoint) → verified checkpoint.
  // 반환 null = 허용 오차 위반이 남아 정지했다(인터럽트·보존 완료).
  private async absorbTurn(
    setup: WorkSetup, work: WorkBinding, state: WorkSeed, raw: AgentResult, sessionId: string,
    expected: TurnExpectation, writeGuards: WriteGuards, signal: AbortSignal,
    // 새 턴 응답이면 0(결과마다 확인 1회), 재대조(같은 결과)면 지금 값을 유지한다.
    confirmations = 0,
  ): Promise<WorkState | null> {
    const { topicId, topic } = setup;
    // 누적의 입력은 항상 **최신** 누적본이다 — 계약 교정·허용 오차 교정이 같은 normalizer 를 다시 부를 때 턴 시작 전 상태로 되돌아가면 앞 응답이
    // 낸 질문·해소가 사라진다(CF-04). 같은 응답을 두 번 누적해도 쟁점·증거는 합집합, 요청은 문구로 중복 제거되므로 멱등이다.
    let current: { base: AgentResult | null; openRequests: OpenRequest[] } = { base: state.base, openRequests: [...state.openRequests] };
    const salvaged = (value: unknown) => accumulate(current.base, salvageResultFields(value, setup.kind), current.openRequests, setup.inputSequence);
    const first = salvaged(raw);
    await this.core.checkpoints.record(topic, {
      work, phase: "turn-result", raw, accumulated: first.result, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
      openRequests: first.openRequests, confirmations,
    }, signal);
    let last: Accumulation | null = null;
    const latestRequests = () => (last as Accumulation | null)?.openRequests ?? first.openRequests;
    const normalize: ResultNormalizer = (parsed) => {
      const acc = accumulate(current.base, parsed, current.openRequests, setup.inputSequence);
      last = acc;
      current = { base: acc.result, openRequests: acc.openRequests };
      return setup.carry(acc.result);
    };
    normalize.carried = () => setup.carry.carried?.() ?? [];
    normalize.label = setup.carry.label;
    const contracted = await this.core.enforceResultContract("claude", topic, raw, sessionId, {
      signal, implementation: true, planMode: false, startedAfter: setup.inputSequence, check: setup.check, readablePaths: setup.readablePaths,
      normalize, writeGuards,
      beforeCorrection: async (rejected) => {
        const acc = salvaged(rejected);
        await this.core.checkpoints.record(topic, {
          work, phase: "before-contract-correction", raw: rejected, accumulated: acc.result, verifiedLedger: state.verifiedLedger,
          inputSequence: setup.inputSequence, openRequests: acc.openRequests, confirmations, pendingCorrection: "contract",
        }, signal);
      },
    });
    await this.assertBaselineIntact(topic, setup.baselineHead, "계약 교정 중");
    this.assertToolTreesIntact(topic, setup.toolTreesBefore, "계약 교정 중");
    const tolerance = await this.enforceTolerance({
      topicId, topic: this.core.dependencies.database.getTopic(topicId), plan: setup.plan, result: contracted, sessionId, signal,
      inputSequence: setup.inputSequence, resumeState: setup.work.resumeState, check: setup.check, baselineHead: setup.baselineHead,
      // 교정 프롬프트의 열린 요청은 **최신** 누적본 기준이다 — 턴 시작 시점 목록이면 이번 턴이 새로 연 질문의 서버 id 가 빠져, 교정이 원인을 되돌려도
      // 그 요청을 resolvedRequestIds 로 닫을 수 없어 사용자 입력 대기로 멈춘다(host-review R03; checkpoint 기록과 같은 latestRequests()).
      readablePaths: setup.readablePaths, normalize, previousLedger: state.verifiedLedger, expected, writeGuards, openRequests: latestRequests(),
      beforeCorrection: async (original) => {
        await this.core.checkpoints.record(topic, {
          work, phase: "before-tolerance-correction", raw: original, accumulated: original, verifiedLedger: state.verifiedLedger,
          inputSequence: setup.inputSequence, openRequests: latestRequests(), confirmations, pendingCorrection: "tolerance",
        }, signal);
      },
      // 허용 오차 교정 응답의 계약 교정(중첩) 직전에도 최신 누적본(교정 응답이 낸 새 질문 포함)을 보존한다(CF-04 잔여).
      beforeNestedCorrection: async (rejected) => {
        const acc = salvaged(rejected);
        await this.core.checkpoints.record(topic, {
          work, phase: "before-contract-correction", raw: rejected, accumulated: acc.result, verifiedLedger: state.verifiedLedger,
          inputSequence: setup.inputSequence, openRequests: acc.openRequests, confirmations, pendingCorrection: "contract",
        }, signal);
      },
    });
    if ("stop" in tolerance) {
      // 허용 오차 위반이 교정 뒤에도 남았다 — 마지막 누적본을 보존하고, 러너가 돌려보낸 진단(반박·증거 요청)을 기록한 **뒤에** 멈춘다.
      // 인터럽트가 먼저면 그 뒤의 checkpoint 는 늦은 산출물로 버려지고 호출자는 곧바로 끝나, 누적본과 진단 처분을 함께 잃었다 — 진단이 delivered 로
      // 남아 retry 가 같은 지시를 다시 실었다(host-review R3 잔여). 순서는 pauseWork 와 같다(산출물 저장은 하지 않는다 — 검증을 통과하지 못한 결과다).
      const accumulated = (last as Accumulation | null)?.result ?? contracted;
      await this.core.checkpoints.record(topic, {
        work, phase: "paused", accumulated, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
        openRequests: latestRequests(), confirmations,
      }, signal);
      const returned = this.recordDiagnosisReturns(setup, accumulated);
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", returned ? `${tolerance.stop.message}\n${returned.message}` : tolerance.stop.message,
        setup.work.resumeState, { toleranceViolations: tolerance.stop.violations, ...(returned ? { diagnosisReturned: returned.ids } : {}) });
      return null;
    }
    const checked = tolerance.result;
    await this.assertBaselineIntact(topic, setup.baselineHead, "허용 오차 교정 중");
    this.assertToolTreesIntact(topic, setup.toolTreesBefore, "허용 오차 교정 중");
    const acc = last as Accumulation | null;
    if (acc) this.reportAccumulation(topicId, acc);
    const next: WorkState = {
      base: checked, openRequests: latestRequests(), verifiedLedger: [...(checked.toleranceLedger ?? [])], confirmations,
    };
    await this.core.checkpoints.record(topic, {
      work, phase: "verified", accumulated: next.base, verifiedLedger: next.verifiedLedger, inputSequence: setup.inputSequence,
      openRequests: next.openRequests, confirmations,
    }, signal);
    return next;
  }

  private reportAccumulation(topicId: string, acc: Accumulation): void {
    for (const request of acc.resolvedRequests) {
      this.core.event(topicId, "system", "system", `열린 요청 ${request.id} 를 러너가 해소로 확인해 닫았습니다: ${request.text.slice(0, 120)}`, { resolvedRequest: request.id });
    }
    if (acc.unmatchedResolution) {
      this.core.event(topicId, "system", "system", `해소 표식을 적용하지 않았습니다 — ${acc.unmatchedResolution}`, { unmatchedResolution: acc.unmatchedResolution });
    }
  }

  // 가장 오래된 열린 요청이 제시된 뒤 사용자 결정이 올라왔는가.
  private decisionAfter(topic: Topic, openRequests: readonly OpenRequest[]): boolean {
    if (openRequests.length === 0) return false;
    const since = Math.min(...openRequests.map((request) => request.askedAfterSequence));
    return this.core.dependencies.database.getTimeline(topic.id, since)
      .some((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
  }

  // 입력·증거 대기 또는 확인 실패 — 결과를 옛 산출물(호환)과 paused checkpoint 로 보존하고 멈춘다.
  private async pauseWork(
    setup: WorkSetup, work: WorkBinding, state: WorkState, to: "USER_DECISION_REQUIRED" | "BLOCKED_ON_EVIDENCE",
    message: string, payload: Record<string, unknown>, signal: AbortSignal,
  ): Promise<void> {
    const { topic, topicId } = setup;
    await this.core.recordDeferredFindings(topic, state.base.findings.filter((finding) => finding.disposition === "DEFERRED_OUT_OF_SCOPE"), setup.deferredSource, signal);
    await this.core.saveAgentOutput(topic, "claude", state.base, setup.resultKind, signal);
    await this.core.checkpoints.record(topic, {
      work, phase: "paused", accumulated: state.base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
      openRequests: state.openRequests, confirmations: state.confirmations,
    }, signal);
    this.core.interrupt(topicId, to, message, setup.work.resumeState, payload);
  }

  // 완료 판정을 통과한 결과의 수락 — accepting checkpoint(acceptId) → 산출물·메모리·이벤트 → accepted checkpoint → 후속(전이·리뷰).
  // 강제 종료 뒤 재개는 finishAccept 가 acceptId 로 어디까지 됐는지 판단한다(결과 내용 해시가 아니다).
  private async acceptWork(setup: WorkSetup, work: WorkBinding, state: WorkState, verdict: CompletionVerdict, signal: AbortSignal): Promise<void> {
    const { topic } = setup;
    const base = state.base;
    await this.core.recordDeferredFindings(topic, base.findings.filter((finding) => finding.disposition === "DEFERRED_OUT_OF_SCOPE"), setup.deferredSource, signal);
    if (setup.kind === "FIX") await this.core.pruneDeferredFindings(topic, resolvedIDs(base), signal);
    const worktree = await this.core.dependencies.git.snapshot(topic.worktreePath);
    const accepting = await this.core.checkpoints.record(topic, {
      work, phase: "accepting", accumulated: base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
      openRequests: state.openRequests, confirmations: state.confirmations, worktree,
    }, signal);
    await this.core.saveAgentOutput(topic, "claude", base, setup.resultKind, signal, { acceptId: accepting.revision });
    await this.core.checkpoints.record(topic, {
      work, phase: "accepted", accumulated: base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
      openRequests: state.openRequests, confirmations: state.confirmations, acceptId: accepting.revision, worktree,
    }, signal);
    await this.completeAcceptance(setup, acceptResult(base, verdict), accepting.revision, setup.inputSequence);
  }

  // 수락의 마지막 경계(정상·복구 공통): 비동기 저장(persist) 을 전부 끝낸 뒤 **동기**로 새 결정·증거를 검사하고, 같은 동기 구간에서 상태를 전이한다.
  // 검사와 전이 사이에 await 가 없다 — 늦게 도착한 결정이 전이를 타고 넘어갈 틈이 없다(CF-01 잔여). 새 입력이면 결과·산출물은 보존한 채 멈추고
  // 재개가 수락 checkpoint 를 보고 반영 턴을 연다.
  private async completeAcceptance(setup: WorkSetup, accepted: AcceptedResult, acceptId: number, inputSequence: number): Promise<void> {
    await setup.accept.persist(accepted, acceptId);
    if (this.core.interruptForNewUserInput(setup.topic, inputSequence)) {
      this.core.event(setup.topic.id, "system", "system", "수락 절차 도중 새 결정·증거가 도착해 채택·전이를 멈췄습니다(결과·산출물은 보존됨) — 재시도가 결정을 반영하는 턴을 엽니다.",
        { acceptInterrupted: acceptId });
      return;
    }
    // 진단 처분 기록(반영 보고)은 전이가 받아들일 때 **그 전이와 한 transaction** 으로 쓴다 — 가드(처분 되돌림 등)가 거부한 결과는 채택된 것이 아니므로 기록하지
    // 않고(2026-09-15 감사: 가드 거부 뒤에도 fix_reported 가 남아 리뷰 없이 해결됐다), 전이와 기록 사이에서 끊겨 반영 보고를 잃지도 않는다(감사 2차).
    const reported = setup.diagnoses?.length ? this.core.diagnoses.acceptedEntries(setup.topicId, setup.diagnoses, accepted, acceptId) : null;
    if (!setup.accept.transition(accepted, acceptId, reported)) return;
    await setup.accept.continue(accepted);
  }

  // 결정·증거 중 checkpoint 이후의 것(같은 세대).
  private userInputSince(topic: Topic, afterSequence: number): TimelineEvent | null {
    return this.core.dependencies.database.getTimeline(topic.id, afterSequence).find((event) =>
      event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && ["decision", "evidence"].includes(event.kind)) ?? null;
  }

  // 수락 도중(산출물 저장·메모리 반영·이벤트·전이 사이) 종료된 뒤의 재개 — 모델 호출 없이 acceptId 기준으로 남은 단계만 한다.
  private async finishAccept(setup: WorkSetup, checkpoint: WorkCheckpoint, signal: AbortSignal): Promise<void> {
    const { topic, topicId } = setup;
    const acceptId = checkpoint.phase === "accepted" ? (checkpoint.acceptId ?? checkpoint.previous ?? checkpoint.revision) : checkpoint.revision;
    const base = checkpoint.accumulated;
    const verdict = completionVerdict(base, { openRequests: checkpoint.openRequests, decisionAfterRequest: false });
    if (verdict.kind !== "completed") throw new Error(`수락 checkpoint #${checkpoint.revision} 의 누적본이 완료 판정이 아닙니다(${verdict.kind}).`);
    const outputRecorded = this.core.dependencies.database.getTimeline(topicId)
      .some((event) => event.kind === "agent_output" && event.payload?.acceptId === acceptId);
    this.core.event(topicId, "system", "system",
      `받아들인 결과(acceptId ${acceptId}, ${checkpoint.phase})의 후속 처리를 이어갑니다 — 모델 호출 없음, 산출물·메모리 반영 ${outputRecorded ? "완료" : "미완"}.`,
      { acceptResumed: acceptId, phase: checkpoint.phase, outputRecorded });
    if (checkpoint.phase === "accepting") {
      // 산출물·메모리·이벤트는 한 묶음(saveAgentOutput) — 이벤트가 없으면 다시 돈다. 메모리 갱신은 expectedSHA256 으로 두 번 적용되지 않는다.
      if (!outputRecorded) await this.core.saveAgentOutput(topic, "claude", base, setup.resultKind, signal, { acceptId });
      // 검증된 워킹트리 스냅샷은 복구 저장에도 그대로 남긴다 — 빠지면 다음 재개가 "트리 변경" 으로 보고 같은 결과를 새 acceptId 로 다시 수락한다(CF-01 회귀).
      await this.core.checkpoints.record(topic, {
        work: checkpoint.work, phase: "accepted", accumulated: base, verifiedLedger: checkpoint.verifiedLedger, inputSequence: checkpoint.inputSequence,
        openRequests: checkpoint.openRequests, confirmations: checkpoint.confirmations, acceptId, worktree: checkpoint.worktree,
      }, signal);
    }
    // 복구 수락도 같은 마지막 경계를 지난다 — 이 재개 action 이 시작된 뒤(checkpoint 이후) 도착한 입력은 recovery 진입에서 걸렀고, 저장 사이에 온 것은 여기서 건다.
    await this.completeAcceptance(setup, acceptResult(base, verdict), acceptId, checkpoint.inputSequence);
  }

  // 최종 리뷰 신규 쟁점 인터럽트(payload.finalReviewNewFindingIDs) 뒤에 사용자 결정이 도착했으면
  // 그 ID들은 사용자가 소비한 것으로 본다. 같은 범위 세대 안에서만 인정한다.
  // 최종 리뷰의 "확정 결함이 남았습니다"/"새 쟁점" 인터럽트 뒤에 사용자 결정이 올라왔는지 — 2차 수정 패스를 여는 조건.
  private userDecisionAfterLastFixInterrupt(topic: Topic): boolean {
    const events = this.core.dependencies.database.getTimeline(topic.id)
      .filter((event) => event.scopeGeneration === topic.scopeGeneration);
    let lastInterrupt = -1;
    for (let index = 0; index < events.length; index += 1) {
      const body = events[index].body ?? "";
      if (events[index].actor === "system" && (body.includes("확정 결함이 남았습니다") || body.includes("최종 리뷰에서 새 쟁점이 나왔습니다") || body.includes("두 번까지만 허용됩니다"))) {
        lastInterrupt = index;
      }
    }
    if (lastInterrupt < 0) return false;
    return events.slice(lastInterrupt + 1).some((event) => event.actor === "user" && event.kind === "decision");
  }

  async resumeDelivery(topicId: string, state: WorkflowState, signal: AbortSignal): Promise<void> {
    const timeline = this.core.dependencies.database.getScopedTimeline(topicId, this.core.dependencies.database.getTopic(topicId).scopeGeneration);
    const recheck = timeline.findLast(event => event.actor === "system" && typeof event.payload?.reviewDeliveryRecheck === "boolean");
    // 재확인은 "결과가 저장된 새 리뷰" 가 생길 때까지 남는다(host-review 2026-09-21 4회차 R1): 거절 뒤 정상 리뷰가 결과 저장 전에 실패·중단되면 다음 재시도가 이 분기를
    // 건너뛰고 저장된 리뷰 재사용 경로로 들어가 미판정 결정인 채 인도 대기로 복귀했다. 거절 표식(true)은 그 뒤에 리뷰 산출물(답변 확인이 아닌 codex agent_output)이 저장돼야 풀린다.
    const recheckPending = recheck?.payload?.reviewDeliveryRecheck === true
      && !timeline.some((event) => event.sequence > recheck.sequence && event.actor === "codex" && event.kind === "agent_output"
        && event.payload?.reviewAnswerConfirmation !== true);
    if (["CODEX_REVIEW", "CODEX_FINAL_REVIEW"].includes(state) && recheckPending) {
      if (await this.resumeDeliveryAnswers(topicId, signal)) return;
      // 재확인이 코드 판정 재사용을 거절했다("코드·증거 변경을 정상 리뷰에서 확인합니다") — 저장된 리뷰 재사용 경로(finalizePassedReview 등)를 건너뛰고 정상 리뷰로 바로 간다.
      // 그 경로들은 판정 없는 결정을 허용하므로, 거절 직후 거기로 떨어지면 변경 전 리뷰로 인도 대기에 복귀했다(host-review 2026-09-21 3회차 R1).
      return this.runReview(topicId, signal, state === "CODEX_FINAL_REVIEW");
    }
    if (state === "IMPLEMENTING") return this.runImplementation(topicId, signal);
    // 저장된 리뷰를 재사용하는 어느 경로도 그 리뷰 뒤의 판정되지 않은 결정을 지나치지 못한다(canReuseReview, host-review 2026-09-21 5회차 R1) — 재사용 판단 전에 확인자를
    // reviewKind 로 불러 결정별 판정을 받는다(열린 질문·미판정 결정이 없으면 호출하지 않는다). 리뷰 도중(결과 저장 뒤 입력 검사에서) 도착한 결정처럼 재확인 표식 없이 재개되는
    // 경우도 같은 길이다. 판정이 없거나 true 면 재사용 경로가 모두 false 를 돌려주고 정상 리뷰가 읽는다.
    if (state === "CODEX_REVIEW") {
      await this.confirmReviewAnswers(topicId, signal, { reviewKind: "codex-review" });
      if (await this.finalizePassedReview(topicId, false)) return;
      if (await this.openFixFromStoredReview(topicId, false, signal)) return;
      return this.runReview(topicId, signal, false);
    }
    if (state === "CLAUDE_FIX") {
      // 멈춘 수정 작업은 그 계약이 정한다(경로·원본·회차·실은 진단) — 회차 플래그·산출물 종류·진단 사슬로 원본을 추정하지 않는다(2026-09-15 감사 2차: 진단 전용
      // 수정 뒤 최종 리뷰가 연 수정이 끊기면 retry 가 첫 리뷰를 원본으로 골라 확정 결함을 버렸다). 계약 도입 전의 작업이면 한 번 이관한다.
      let contract: FixContract;
      try {
        contract = await this.core.fixContracts.ensureOpen(topicId);
      } catch (error) {
        // 옛 토픽 이관이 손상된 checkpoint 를 만나면 계약을 추정하지 않고 멈춘다(runWork 복구와 같은 처리, 2026-09-15 감사 4차).
        if (!(error instanceof CheckpointCorrupt)) throw error;
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, "CLAUDE_FIX", { checkpointCorrupt: error.revision });
        return;
      }
      if (contract.route === "review") {
        // 수정 턴이 멈춘 뒤 결정이 올라왔으면 저장된 수정 결과를 재사용한다(수정 턴 재구매 방지) — 단, 이 작업의 checkpoint 가 있으면 runWork 가 거기서
        // 복구하므로 옛 산출물 경로는 쓰지 않는다. 적용된 진단이 기다리면 재사용하지 않는다 — 진단은 쓰기 턴으로 전달한다.
        const flags = this.core.dependencies.database.getFlags(topicId);
        const topic = this.core.dependencies.database.getTopic(topicId);
        // 손상 checkpoint 는 있는 것으로 본다 — 저장 결과를 재사용하지 않고 runWork 의 복구가 보존한 채 멈춘다(삼키지 않는다, 감사 5차 #3).
        const hasCheckpoint = flags.implementationSessionId
          ? await this.core.checkpoints.recoverFor(topicId, this.core.checkpoints.binding(topic, "FIX", flags.implementationSessionId, contract.contractId)).then((r) => r !== null).catch((error: unknown) => { if (error instanceof CheckpointCorrupt) return true; throw error; })
          : false;
        const diagnosisPending = this.core.diagnoses.pendingFor(this.core.fixContracts.diagnoses(topicId, contract), null).length > 0;
        if (!hasCheckpoint && !diagnosisPending && await this.finishStoredFix(topicId, contract, signal)) return;
      }
      return this.runContractFix(topicId, signal, contract);
    }
    if (state === "CODEX_FINAL_REVIEW") {
      await this.confirmReviewAnswers(topicId, signal, { reviewKind: "codex-final-review" });
      if (await this.finalizePassedReview(topicId, true)) return;
      // 가드로 멈춘 최종 리뷰가 그 뒤의 사용자 결정으로 통과 조건을 만족하면 Codex 턴을 다시 사지 않는다.
      if (await this.finalizeStoredFinalReview(topicId)) return;
      // 확정 결함이 남은 채 결정이 올라왔으면 저장된 리뷰의 finding 을 바로 수정으로 보낸다(리뷰 재구매 방지, Codex 피드백 ②).
      if (await this.openFixFromStoredReview(topicId, true, signal)) return;
      return this.runReview(topicId, signal, true);
    }
    throw new Error(`지원하지 않는 재개 단계입니다: ${state}`);
  }

  private async runReview(topicId: string, signal: AbortSignal, finalPass: boolean): Promise<void> {
    await this.confirmReviewAnswers(topicId, signal);
    let topic = this.core.dependencies.database.getTopic(topicId);
    const expected = finalPass ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW";
    this.core.requireState(topicId, expected);
    const { content: plan, path: planPath } = await this.core.requireCurrentPlanArtifact(topicId);
    // 최종 리뷰의 대조 기준은 수정 작업 계약에서 읽는다 — 보고는 수락된 결과만(반환·정지로 저장된 수정 결과는 아니다), 그 뒤 수정 없이 닫힌 계약의
    // 원본(최종 리뷰 정지 쟁점)도 커버리지·되돌림 검사에 싣는다(2026-09-15 감사 2차).
    const base = finalPass ? await this.core.fixContracts.finalReviewBase(topicId) : null;
    const implementation = base ? base.report : await this.core.latestResult(topicId, "implementation-result");
    const originalReview = finalPass ? await this.core.latestResult(topicId, "codex-review") : null;
    const reviewedSnapshot = await this.core.dependencies.git.snapshot(topic.worktreePath);
    // 리뷰 시점 작업 트리를 객체로 남긴다 — 최종 리뷰가 '직전 리뷰 이후 변경분' 만 다시 보게 하는 근거(Codex 피드백 ①).
    const previousFlags = this.core.dependencies.database.getFlags(topicId);
    const reviewedTree = await this.core.dependencies.git.writeWorkingTree(topic.worktreePath, `${topicId.slice(0, 8)}-${finalPass ? "final" : "first"}`)
      .catch(() => null);
    const reviewSessionId = this.core.dependencies.database.getCodexReviewSession(topicId);
    const resumedSession = reviewSessionId !== null;
    const previousReviewArtifact = ["codex-review", "codex-final-review"]
      .map((kind) => this.core.dependencies.database.latestArtifact(topicId, kind, topic.scopeGeneration))
      .filter((artifact) => artifact !== null).sort((a, b) => b.revision - a.revision)[0];
    const previousReview = previousReviewArtifact ? await this.core.latestResult(topicId, previousReviewArtifact.kind) : null;
    const previousReviewCompleted = previousReview !== null && this.reviewWorkCompleted(previousReview);
    const remainingReviewSteps = previousReview && !previousReviewCompleted ? previousReview.remainingSteps ?? [] : undefined;
    // 미완료 판정은 변경되지 않은 코드의 검토를 보장하지 않는다. 완료한 리뷰가 있을 때만 변경분으로 좁힌다.
    const deltaSinceLastReview = finalPass && resumedSession && previousReviewCompleted && previousFlags.reviewedTreeOID && reviewedTree
      ? previousFlags.reviewedTreeOID === reviewedTree
        ? { files: [], patch: "" }
        : await this.core.dependencies.git.diffTrees(topic.worktreePath, previousFlags.reviewedTreeOID, reviewedTree).catch(() => null)
      : null;
    // 재개 세션에는 직전 리뷰 턴 이후의 결정·증거만 싣는다(2026-09-08 Codex 제안 ⑥). 값은 턴이 돌아온 뒤에 적는다.
    const reviewInputSequence = this.core.latestSequence(topicId);
    const reviewSince = resumedSession ? (this.core.dependencies.database.getCodexReviewPromptSequence(topicId) ?? 0) : 0;
    const closeout = !resumedSession && this.core.dependencies.database.latestArtifact(topicId, "closeout")
      ? await this.core.latestResult(topicId, "closeout") : null;
    // 리뷰 프롬프트용 허용 오차 요약. 강제 대조는 구현·수정 단계(enforceTolerance)가 이미 했으므로 여기서의 git 실패는
    // 리뷰를 죽이지 않고 그 사실을 프롬프트에 적는다(Codex 가 diff 로 직접 본다).
    const tolerancePolicy = parseTolerancePolicy(plan);
    let tolerance: string | null = null;
    if (tolerancePolicy) {
      const rules = JSON.stringify(tolerancePolicy.rules.map((rule) => ({
        id: rule.id, title: rule.title, paths: rule.paths, hunk: rule.hunk, tokens: rule.tokens, maxFiles: rule.maxFiles, maxHunks: rule.maxHunks,
      })));
      const ledger = JSON.stringify(implementation.toleranceLedger ?? []);
      try {
        const evaluation = evaluateTolerance(tolerancePolicy, await this.collectChangedFiles(topic), implementation.toleranceLedger ?? []);
        tolerance = `${renderToleranceSummary(evaluation)}\n원장: ${ledger}\n규칙: ${rules}`;
      } catch (error) {
        tolerance = `허용 오차 대조를 리뷰 시점에 다시 계산하지 못했습니다(${error instanceof Error ? error.message : String(error)}) — 구현 단계의 대조 이벤트와 원장으로 판정하세요.\n원장: ${ledger}\n규칙: ${rules}`;
      }
    }
    const receipts = await this.core.dependencies.verifications?.receipts(topicId);
    // 이 결과가 처분을 보고한 중재자 진단의 원문(지시·검증 기준) — 리뷰어가 반영 보고와 대조한다(host-review R4). 원문 파일은 읽기 허용.
    const reviewDiagnoses = await this.core.diagnoses.prompts(this.core.diagnoses.forReview(topicId));
    // 구현/수정 결과의 settled 쟁점(주로 TODO-n 이연)과 첫 리뷰의 no-action 쟁점은 서버가 승계한다. RESOLVED_BY_FIX 주장은 승계하지 않는다(리뷰가 판정).
    // 두 원본은 **최신(수정 결과) 우선으로 합친 뒤** 승계를 판단한다 — 따로 승계하면 첫 리뷰의 AGREED_NO_ACTION 이 수정 결과의
    // AGREED_ACTION·RESOLVED_BY_FIX 를 덮어 누락된 쟁점이 검사를 통과한다(2026-09-13 Codex 지적 1).
    const reviewLabel = finalPass ? "Codex final review" : "Codex review";
    const reviewNormalizer = this.core.carryForwardNormalizer(
      mergeFindingSources(base?.sources, implementation.findings, originalReview?.findings), reviewLabel, { forReview: true });
    let review = await this.core.turn("codex", topic, buildCodexReviewPrompt({
      planMarkdown: plan, planSHA256: topic.planSHA256!, implementation, finalPass, resumedSession, tolerance, planPath,
      timeline: this.reviewTimeline(topicId, topic.scopeGeneration, reviewSince),
      planningFindings: closeout?.planSHA256 === topic.planSHA256 ? closeout.findings : undefined,
      planningEvidenceRefs: closeout?.planSHA256 === topic.planSHA256 ? closeout.evidenceRefs : undefined,
      originalReviewFindings: originalReview?.findings,
      deltaSinceLastReview, remainingReviewSteps, verificationReceipts: receipts?.text, diagnoses: reviewDiagnoses.prompts, fixSourceFindings: base?.sources,
    }), signal, false, {
      readablePaths: [planPath, ...(receipts?.readablePaths ?? []), ...reviewDiagnoses.paths],
      repairContextKey: reviewedTree ?? JSON.stringify(reviewedSnapshot),
      normalize: reviewNormalizer,
      session: {
        id: reviewSessionId,
        persist: (sessionId) => {
          this.core.dependencies.database.setCodexReviewSession(topicId, sessionId);
          this.core.event(topicId, "system", "system", "계획 이력을 넘기지 않는 Codex 코드 리뷰 세션을 만들었습니다.", {
            role: "codex", sessionId, planSHA256: topic.planSHA256,
          });
        },
      },
      check: (r) => {
        this.core.assertKind(r, finalPass ? "FINAL_REVIEW" : "REVIEW");
        assertFindingCoverage(implementation.findings, r.findings, finalPass ? "Codex final review" : "Codex review");
        if (originalReview) assertFindingCoverage(originalReview.findings, r.findings, "Codex final review");
        if (base?.sources.length) assertFindingCoverage(base.sources, r.findings, "Codex final review(수정 작업 원본)");
      },
    });
    this.core.dependencies.database.setCodexReviewPromptSequence(topicId, reviewInputSequence);
    // 중재자 소유 경로(gitignore 된 도구 트리)의 확정 결함은 러너 수정 회차를 열지 않는다 — EXTERNAL_EVIDENCE 로 바꿔 아래
    // BLOCKED_ON_EVIDENCE 분기로 보낸다. 중재자가 고치고 evidence + retry 하면 같은 리뷰 단계가 다시 돌아 재검증한다
    // (2026-09-14 사용자 지시 "러너는 앱 코드만"; S10H 도구 결함 수정 4회 루프의 처방).
    const routed = routeMediatorOwnedFindings(review.findings, undefined, topic.worktreePath);
    if (routed.routed.length > 0) {
      review = { ...review, findings: routed.findings };
      this.core.event(topicId, "system", "system",
        `중재자 소유 경로(앱 밖 도구 코드)의 확정 결함 ${routed.routed.length}건은 러너 수정 대신 중재자에게 보냅니다: ${routed.routed.join(", ")}`,
        { mediatorOwnedFindingIDs: routed.routed });
    }
    const afterReviewSnapshot = await this.core.dependencies.git.snapshot(topic.worktreePath);
    if (reviewedSnapshot.head !== afterReviewSnapshot.head || reviewedSnapshot.diffSHA256 !== afterReviewSnapshot.diffSHA256) {
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", "코드 검토 중 worktree가 바뀌었습니다. 변경 원인을 확인한 뒤 다시 검토하세요.", expected);
      return;
    }
    // 리뷰가 본 스냅샷은 가드 결과와 무관하게 기록한다 — 가드로 멈춘 뒤 사용자 결정으로 재개할 때(finalizeStoredFinalReview)
    // 저장된 리뷰가 지금 worktree 를 본 것인지 대조하는 근거다. 커밋은 여전히 READY_TO_DELIVER 상태를 요구한다.
    this.core.dependencies.database.updateTopic(topicId, {
      reviewedHead: reviewedSnapshot.head, reviewedDiffSHA256: reviewedSnapshot.diffSHA256, reviewedTreeOID: reviewedTree,
    });
    // 리뷰가 to-do 를 다른 처분(해결·불필요·반박·수정 합의)으로 닫았으면 후속 목록에서 뺀다(2026-09-08 Codex 지적 9).
    await this.core.pruneDeferredFindings(topic, resolvedIDs(review), signal);
    await this.core.writeArtifact(topic, "codexReview", finalPass ? 2 : 1, renderReport(review), signal);
    await this.core.saveAgentOutput(topic, "codex", review, finalPass ? "codex-final-review" : "codex-review", signal, { reviewInputSequence });
    // 통과 판정에 쓸 진단 확인 처분은 입력 검사 전에 읽는다 — 검사와 인도 대기 전이 사이에 await 가 끼면 그 사이 도착한 결정·증거를 건너뛰고 READY 로 갔다
    // (CF-01, 2026-09-15 감사 5차 #6). 이 뒤로는 전이까지 await 가 없거나, 있으면 전이 전에 입력을 다시 본다.
    const verdicts = await this.core.fixContracts.reviewVerdicts(topicId, review.findings);
    if (this.core.interruptForLatestTurnInput(topic)) return;
    if (this.core.pauseForResult(topicId, review, expected, "코드 리뷰 결과에 사용자 결정이 필요합니다.")) {
      return;
    }
    if (!this.reviewWorkCompleted(review)) {
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED",
        `코드 리뷰가 완료되지 않았습니다 — 남은 검토: ${(review.remainingSteps ?? []).join(" · ") || "(명시 없음)"}`, expected);
      return;
    }
    if (review.findings.some((finding) => !finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE")) {
      this.core.interrupt(topicId, "BLOCKED_ON_EVIDENCE", "코드 리뷰 결과에 외부 증거가 필요합니다.", expected);
      return;
    }
    if (finalPass) {
      // 최종 리뷰에서 처음 등장한 쟁점은 Claude가 고칠 기회가 없었다. RESOLVED_BY_FIX로 표시해도
      // 실제 수정이 없었으므로, closeout의 신규 쟁점 규칙과 똑같이 처분과 무관하게 사용자 판단으로 보낸다.
      // 이월 쟁점은 fix와 첫 리뷰 양쪽에 같은 ID로 있으므로 합집합을 ID로 접어야 newFindingIDs의 중복 검사에 걸리지 않는다.
      const knownFindings = [...new Map(
        [...implementation.findings, ...(originalReview?.findings ?? []), ...(base?.sources ?? [])].map((finding) => [finding.id, finding]),
      ).values()];
      // 사용자 결정이 이미 소비한 신규 쟁점은 다시 사용자에게 보내지 않는다. 인터럽트 이벤트에 실린
      // ID 목록과 그 뒤에 도착한 사용자 결정의 짝으로만 판정하므로, 결정 없는 재실행(인프라 재시도)은
      // 여전히 인터럽트된다 — 조용한 종결은 불가능하다(2026-09-01 S1.1 R4 무변경 fix 패스 루프의 프로그램적 방지).
      const adjudicated = this.core.fixContracts.adjudicatedFinalReviewIDs(topic);
      const addedIDs = new Set(newFindingIDs(knownFindings, review.findings, "Codex final review").filter((id) => !adjudicated.has(id)));
      const added = review.findings.filter((finding) => addedIDs.has(finding.id));
      // 새 쟁점은 발견 시점이 아니라 처분으로 분류한다(2026-09-07 Codex 피드백 ④): 범위 밖은 후속 목록에 기록만,
      // 확정 결함(AGREED_ACTION)은 남은 수정 회차에서 바로 수정, 결정이 필요하거나 처분이 없거나 수정 없이 닫힌
      // (RESOLVED_BY_FIX — 고칠 기회가 없었다) 쟁점만 사용자에게 보낸다.
      const deferredNew = added.filter((finding) =>
        finding.disposition === "DEFERRED_OUT_OF_SCOPE" || finding.disposition === "AGREED_NO_ACTION");
      if (deferredNew.length > 0) {
        await this.core.recordDeferredFindings(topic, deferredNew, "final-review", signal);
        // 기록하는 await 동안 도착한 결정·증거는 이 판정에 반영되지 않았다 — 인도 대기 전이 전에 다시 본다(CF-01, 감사 5차 #6).
        if (this.core.interruptForLatestTurnInput(topic)) return;
      }
      const askUser = added.filter((finding) =>
        finding.requiresUserDecision || !finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE"
        || finding.disposition === "RESOLVED_BY_FIX");
      if (askUser.length > 0) {
        const ids = askUser.map((finding) => finding.id);
        this.core.interrupt(
          topicId,
          "USER_DECISION_REQUIRED",
          `최종 리뷰에서 새 쟁점이 나왔습니다(${ids.join(", ")}). 수정 기회가 없었거나 사용자 판단이 필요해 자동으로 닫지 않았습니다.`,
          expected,
          { finalReviewNewFindingIDs: ids },
        );
        return;
      }
      // 수정을 마친 쟁점의 정상 종결은 RESOLVED_BY_FIX다. 다른 처분으로 내리면 아무도 고치지 않은 요구를 닫는 것이므로 멈춘다.
      // 되돌림 검사의 원본 = 첫 리뷰 쟁점 ∪ 수정 작업 계약의 원본(최종 리뷰 정지 쟁점 등). 면제 = 사용자 결정 ∪ 계약의 판정 id ∪ 닫힌 진단.
      const overruled = originalReview ? this.userOverruledFindings(topic, "codex-review", originalReview.findings) : new Set<string>();
      for (const id of base?.overruled ?? []) overruled.add(id);
      // 진단 전용 계약의 원본(정지 쟁점)이 같은 id 의 첫 리뷰·보고 처분보다 최신 판정이다 — 앞에 둔다(감사 3차: 옛 settled 처분에 가려졌다).
      const agreed = mergeAgreedSources(base?.sources, originalReview?.findings);
      this.noteOverruled(topicId, overruled, agreed, review.findings);
      const withdrawn = [...new Set(dispositionRegressions(agreed, review.findings, overruled))];
      if (withdrawn.length > 0) {
        this.core.interrupt(
          topicId,
          "USER_DECISION_REQUIRED",
          `최종 리뷰가 고치기로 합의한 쟁점(첫 리뷰·진단 전용 수정의 원본)을 수정 확인 없이 닫았습니다(${withdrawn.join(", ")}). 전달 준비로 넘기지 않았습니다 — `
            + OVERRULE_GUIDANCE,
          expected,
        );
        return;
      }
      if (shouldRunFixPass(review.findings)) {
        if (this.refuseFixAfterCommit(topicId, review, expected)) return;
        const flags = this.core.dependencies.database.getFlags(topicId);
        const remaining = review.findings
          .filter((finding) => finding.disposition === "AGREED_ACTION").map((finding) => finding.id);
        // 남은 수정 회차 안에서는 결정 없이 바로 고친다(2026-09-07 Codex 피드백 ④ — 종전엔 2차도 사용자 결정 뒤에만 열렸다).
        // 회차를 다 썼으면 최신 코드와 남은 필수 쟁점을 보존한 채 한 번 결정받고, 그 결정이 추가 회차 1회를 연다(runFix 의 해제 규칙).
        if (!flags.secondFixPassUsed || this.userDecisionAfterLastFixInterrupt(topic)) {
          await this.openReviewFix(topicId, signal, "codex-final-review", review,
            flags.secondFixPassUsed ? "사용자 결정으로 추가 수정 회차를 열어 남은 확정 결함을 수정합니다." : "남은 확정 결함을 2차 자동 수정으로 바로 고칩니다.");
          return;
        }
        this.core.interrupt(
          topicId,
          "USER_DECISION_REQUIRED",
          `두 번의 자동 수정 뒤에도 확정 결함이 남았습니다(${remaining.join(", ")}). 최신 코드는 보존됩니다. 결정을 올리고 재시도하면 그 결정이 추가 수정 회차 1회를 열어 남은 쟁점만 고칩니다.`,
          expected,
          { remainingFindingIDs: remaining },
        );
      } else {
        await this.finishCodeReview(topic, reviewedSnapshot, "최종 읽기 전용 리뷰를 통과했습니다.", verdicts, signal);
      }
      return;
    }
    if (!shouldRunFixPass(review.findings)) {
      await this.finishCodeReview(topic, reviewedSnapshot, "구현 리뷰에서 수정할 확정 결함이 없습니다.", verdicts, signal);
      return;
    }
    if (this.refuseFixAfterCommit(topicId, review, expected)) return;
    if (this.core.dependencies.database.getFlags(topicId).fixPassUsed) {
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", "자동 수정 횟수를 이미 사용했습니다.", expected);
      return;
    }
    await this.openReviewFix(topicId, signal, "codex-review", review, "Claude가 합의된 결함을 한 번 수정합니다.");
  }

  // 리뷰가 연 수정 작업 — 계약(원본 = 방금 저장한 이 리뷰 산출물의 쟁점, 소비할 회차)을 CLAUDE_FIX 전이와 **한 transaction** 으로 기록하고 그 계약으로 수정한다.
  private async openReviewFix(topicId: string, signal: AbortSignal, kind: "codex-review" | "codex-final-review", review: AgentResult, message: string): Promise<void> {
    const database = this.core.dependencies.database;
    const artifact = database.latestArtifact(topicId, kind);
    if (!artifact) throw new Error(`수정 작업의 원본 리뷰(${kind})가 저장되지 않았습니다.`);
    const contract = this.core.fixContracts.forReview(database.getTopic(topicId), { kind, revision: artifact.revision, findings: review.findings });
    this.core.transitionWith(topicId, "CLAUDE_FIX", message, {
      contracts: [...this.core.fixContracts.abandonOpen(topicId), contract], payload: { fixContract: contract.contractId },
    });
    await this.runContractFix(topicId, signal, contract);
  }

  // 사용자 결정이 뒤집은 쟁점: 원본 리뷰(그 finding 을 낸 codex 산출물, revision = 타임라인 sequence)보다 뒤에 올라온 사용자 decision 이 줄 머리
  // `OVERRULE <id>` 로 지시한 쟁점만 하향 처분을 허용한다(2026-09-15 사용자 결정 "명시 지시어로 한정" — 2026-09-07 의 "id 를 통째로 적으면" 규칙은 수정을
  // 요구하는 결정도 허용했다). 사용자만 뒤집을 수 있다는 가드의 성질은 그대로다 — 에이전트 출력·note 는 세지 않는다.
  private userOverruledFindings(topic: Topic, sourceKind: string, findings: readonly Finding[]): Set<string> {
    const source = this.core.dependencies.database.latestArtifact(topic.id, sourceKind);
    const decisions = this.core.dependencies.database.getTimeline(topic.id, source?.revision ?? 0)
      .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    const overruled = new Set<string>();
    // 줄 머리 `OVERRULE <id>` 지시만 센다 — id 를 언급만 한 결정("F-1 은 반드시 고쳐 주세요")은 허용이 아니다(2026-09-15 사용자 결정, 감사 3차 #7).
    const directed = new Set(decisions.flatMap((event) => [...overruleDirectiveIDs(event.body)]));
    for (const finding of findings) if (directed.has(finding.id)) overruled.add(finding.id);
    return overruled;
  }

  private noteOverruled(topicId: string, overruled: ReadonlySet<string>, source: readonly Finding[], response: readonly Finding[]): void {
    const changed = source
      .filter((finding) => overruled.has(finding.id) && finding.disposition === "AGREED_ACTION")
      .map((finding) => ({ finding, answer: response.find((item) => item.id === finding.id) }))
      .filter(({ answer }) => answer && answer.disposition !== "RESOLVED_BY_FIX" && answer.disposition !== "AGREED_ACTION");
    if (changed.length === 0) return;
    const summary = changed.map(({ finding, answer }) => `${finding.id}(AGREED_ACTION → ${answer?.disposition ?? "?"})`).join(", ");
    this.core.event(topicId, "system", "system", `사용자 결정이 처분 변경을 허용한 쟁점: ${summary}`, { overruledFindingIDs: [...overruled] });
  }

  // 저장된 리뷰에서 곧장 수정으로(2026-09-07 Codex 피드백 ②): 리뷰가 확정 결함을 남긴 채 멈췄고(회차 소진·결정 요구) 그 뒤
  // 사용자 결정이 왔으면, 같은 코드(리뷰 스냅샷 = 지금 worktree)·같은 계획이므로 리뷰를 다시 사지 않고 저장된 finding 을
  // Claude 수정으로 보낸다. 회차 규칙은 runFix 가 본다(소진 뒤에는 결정이 추가 회차 1회를 연다).
  private async openFixFromStoredReview(topicId: string, finalPass: boolean, signal: AbortSignal): Promise<boolean> {
    const database = this.core.dependencies.database;
    const topic = this.core.requireState(topicId, finalPass ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW");
    const reviewKind = finalPass ? "codex-final-review" : "codex-review";
    const stored = database.latestArtifact(topicId, reviewKind);
    // 저장된 리뷰가 지금 대조 보고(최종 리뷰면 수정 작업 계약이 정한 수락 결과·종결 시점)보다 뒤여야 그 보고를 본 리뷰다.
    const reportRevision = finalPass ? (await this.core.fixContracts.finalReviewBase(topicId)).reportRevision
      : database.latestArtifact(topicId, "implementation-result")?.revision;
    if (!stored || reportRevision === undefined || stored.revision <= reportRevision) return false;
    if (stored.scopeGeneration !== topic.scopeGeneration) return false;
    const flags = database.getFlags(topicId);
    if (!flags.reviewedHead || !flags.reviewedDiffSHA256) return false;
    const current = await this.core.dependencies.git.snapshot(topic.worktreePath);
    if (current.head !== flags.reviewedHead || current.diffSHA256 !== flags.reviewedDiffSHA256) return false;
    const decided = database.getTimeline(topicId, stored.revision)
      .some((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    if (!decided) return false;
    const review = await this.core.latestResult(topicId, reviewKind);
    if (!shouldRunFixPass(review.findings)) return false;
    if (!finalPass && flags.fixPassUsed) return false;
    if (finalPass && flags.fixPassUsed && flags.secondFixPassUsed && !this.userDecisionAfterLastFixInterrupt(topic)) return false;
    if (this.refuseFixAfterCommit(topicId, review, finalPass ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW")) return true;
    this.core.event(topicId, "system", "system",
      `결정이 올라온 저장된 ${finalPass ? "최종 " : ""}리뷰(#${stored.revision})의 확정 결함을 바로 수정으로 보냅니다 — 리뷰를 다시 사지 않습니다.`);
    await this.openReviewFix(topicId, signal, reviewKind, review, "Claude가 합의된 결함을 수정합니다.");
    return true;
  }

  // 코드 판정은 답변 확인 호출보다 먼저 보존한다. 확인 예산 소진·실패가 통과한 코드 리뷰를 다시 사게 만들지 않는다.
  private async finishCodeReview(topic: Topic, snapshot: { head: string; diffSHA256: string }, message: string,
    verdicts: ReadonlyMap<string, Finding["disposition"]>, signal: AbortSignal): Promise<void> {
    if (this.core.fixContracts.unansweredReviewQuestions(topic).length > 0) {
      this.recordCodeReviewPassed(topic, snapshot);
      await this.confirmReviewAnswers(topic.id, signal);
      const current = await this.core.dependencies.git.snapshot(topic.worktreePath);
      this.core.assertCurrent(topic.id, signal, topic.scopeGeneration, topic.state);
      if (current.head !== snapshot.head || current.diffSHA256 !== snapshot.diffSHA256) {
        this.core.interrupt(topic.id, "USER_DECISION_REQUIRED", "답변 확인 중 worktree가 바뀌었습니다. 현재 변경을 다시 검토하세요.", topic.state);
        return;
      }
    }
    if (this.core.interruptForLatestTurnInput(topic)) return;
    this.markReady(topic.id, snapshot, message, verdicts);
  }

  private recordCodeReviewPassed(topic: Topic, snapshot: { head: string; diffSHA256: string }): void {
    const database = this.core.dependencies.database;
    const payload = { reviewCodePassed: true, reviewState: topic.state,
      reviewRevision: database.latestArtifact(topic.id, topic.state === "CODEX_FINAL_REVIEW" ? "codex-final-review" : "codex-review")?.revision,
      planEpoch: topic.planEpoch, planSHA256: topic.planSHA256, reviewedHead: snapshot.head, reviewedDiffSHA256: snapshot.diffSHA256 };
    const old = database.getTimeline(topic.id).findLast((event) => event.scopeGeneration === topic.scopeGeneration && event.payload?.reviewCodePassed === true);
    if (old && Object.entries(payload).every(([key, value]) => old.payload?.[key] === value)) return;
    this.core.event(topic.id, "system", "system", "현재 계획과 변경 스냅샷에 대한 코드 검토 통과를 보존했습니다.", payload);
  }

  // 같은 입력 묶음은 최대 한 번 호출한다. 성공한 판정은 보존하고 실패·보류·부분 답변은 새 사용자 입력 없이 재호출하지 않는다.
  // options.reviewKind(답변 재확인 경로): 열린 질문이 없어도 그 리뷰 뒤의 **판정되지 않은 결정 전부**를 확인자에게 보내 결정별 판정(decisionAssessments)을 받는다 —
  // 질문의 답이 아닌 변경 요구, 질문 없이 인도 대기에 이른 주제의 새 결정도 여기서 판정된다(host-review 2026-09-21 R1·R7).
  private async confirmReviewAnswers(topicId: string, signal: AbortSignal, options: { reviewKind?: "codex-review" | "codex-final-review" } = {}): Promise<void> {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    const requests = this.core.fixContracts.unansweredReviewQuestions(topic);
    const events = database.getTimeline(topicId).filter((event) => event.scopeGeneration === topic.scopeGeneration);
    let decisions: TimelineEvent[];
    // 재확인 경로의 기준 리뷰 — 저장된 산출물과 그 입력 순번이 있을 때만. 없으면(그 종류의 리뷰가 아직 없다) 열린 질문 기준의 일반 확인으로 내려간다.
    const stored = options.reviewKind ? database.latestArtifact(topicId, options.reviewKind, topic.scopeGeneration) : null;
    // 개정 계획의 구현 결과보다 오래된 리뷰는 재사용 후보가 아니다. 새 리뷰가 이미 읽은 결정을 옛 리뷰 기준으로 다시 판정하지 않는다.
    const implementation = database.latestArtifact(topicId, "implementation-result", topic.scopeGeneration);
    const input = stored && (!implementation || stored.revision > implementation.revision)
      ? this.reviewInputSequence(topic, stored.revision) : null;
    if (input !== null) {
      // 판정 대상과 답변 근거를 함께 수집한 뒤 아래에서 분리한다. 예전 답변도 새 결정으로 취소됐는지 확인할 자료로 남긴다.
      const assessed = this.decisionAssessmentFlags(topic);
      const candidates = events.filter((event) => reviewAnswerCandidate(event) && event.sequence > input);
      if (requests.length === 0 && candidates.every((event) => assessed.has(event.sequence))) return;
      // 열린 질문의 답은 그 질문 뒤의 어느 결정이든 될 수 있다 — 마지막 리뷰 입력보다 앞선 결정도(이전 리뷰가 물은 질문에 답한 뒤 다른 리뷰가 돌아 통과한 경우) 포함한다.
      // 이 창을 리뷰 입력 뒤로만 좁히면 답이 이미 있는 질문이 "결정 없음" 으로 남아 인도 대기 대신 질문 정지를 반복했다(일반 확인 경로와 같은 규칙).
      const forRequests = events.filter((event) => reviewAnswerCandidate(event) && requests.some((request) => event.sequence > request.sequence));
      // 다시 열린 질문의 기존 답(answerDecisionSequence)은 마지막 리뷰 입력보다 앞에 있을 수 있다(답한 뒤 정상 리뷰가 다시 돌아 통과한 경우) — 창과 무관하게 입력에 넣어야
      // 확인자가 그 순번을 인용한 정당한 재확인이 거부되지 않는다(host-review 2026-09-21 4회차 R9). 합친 목록은 순번으로 중복을 없앤다 — 한 결정이 여러 질문의 답이면
      // 같은 결정이 여러 번 들어가고, 확인자가 입력 원소마다 판정을 돌려주면 "같은 결정을 두 번" 검사에 걸려 정당한 답변이 거부됐다(5회차 R9 잔여).
      const priorAnswers = requests.map((request) => request.answerDecisionSequence)
        .filter((sequence): sequence is number => typeof sequence === "number")
        .map((sequence) => events.find((event) => event.sequence === sequence && reviewAnswerCandidate(event)))
        .filter((event): event is TimelineEvent => event !== undefined);
      decisions = [...new Map([...priorAnswers, ...forRequests, ...candidates].map((event) => [event.sequence, event])).values()].sort((a, b) => a.sequence - b.sequence);
    } else {
      if (requests.length === 0) return;
      decisions = events.filter((event) => reviewAnswerCandidate(event) && requests.some((request) => event.sequence > request.sequence));
    }
    const latest = decisions.at(-1);
    if (!latest) return;
    // 실패·부분 답변을 받은 질문은 같은 결정으로 재호출하지 않는다. 한도 때문에 아직 보내지 않은 질문은 이어갈 수 있다.
    // 구버전의 상한 초과 묶음은 유효한 확인 자체가 불가능했으므로 새 묶음 계약으로 복구한다(사용한 예산은 그대로).
    const attemptedQuestions = new Set(events.filter((event) => event.actor === "system"
      && event.payload?.reviewAnswerQuestionsAttempt === latest.sequence && Array.isArray(event.payload.requestIds)
      && event.payload.requestIds.length <= REVIEW_ANSWER_BATCH_LIMIT).flatMap((event) => event.payload!.requestIds as string[]));
    if (requests.some((request) => attemptedQuestions.has(request.id))) return;
    const sessionId = database.getCodexReviewSession(topicId);
    if (!sessionId) return; // 대화가 없으면 임의 새 세션으로 확인하지 않는다. 다음 정상 리뷰가 세션을 만든다.
    const assessed = this.decisionAssessmentFlags(topic);
    // 과거 답변은 근거로만 유지한다. 현재 리뷰가 이미 읽었거나 확인자가 판정한 결정을 다시 출력하게 하지 않는다.
    const pending = decisions.filter((event) => (input === null || event.sequence > input) && !assessed.has(event.sequence));
    const batches: Array<{ decisions: TimelineEvent[]; requests: typeof requests }> = [];
    for (let offset = 0; offset < pending.length; offset += REVIEW_DECISION_BATCH_LIMIT) {
      batches.push({ decisions: pending.slice(offset, offset + REVIEW_DECISION_BATCH_LIMIT), requests: [] });
    }
    // 질문도 응답 상한으로 나눈다. 첫 질문 묶음은 마지막 결정 묶음과 함께 보내고, 나머지는 답변만 확인한다.
    for (let offset = 0; offset < requests.length; offset += REVIEW_ANSWER_BATCH_LIMIT) {
      const requestBatch = requests.slice(offset, offset + REVIEW_ANSWER_BATCH_LIMIT);
      if (offset === 0 && batches.length > 0) batches[batches.length - 1].requests = requestBatch;
      else batches.push({ decisions: [], requests: requestBatch });
    }
    const inputSequence = this.core.latestSequence(topicId);
    for (const { decisions: batch, requests: batchRequests } of batches) {
      // 모든 결정의 판정이 끝난 뒤 질문을 확인한다. 중간 실패·예산 정지는 이미 받은 판정과 답변을 보존한다.
      const wanted = new Set(batch.map((decision) => decision.sequence));
      const answerEvidence = decisions.filter((decision) => !wanted.has(decision.sequence));
      const batchKey = createHash("sha256").update(JSON.stringify({ version: 2, latest: latest.sequence,
        decisions: [...wanted], requests: batchRequests.map((request) => request.id) })).digest("hex");
      if (events.some((event) => event.actor === "system" && event.payload?.reviewAnswerBatchKey === batchKey)) return;
      let recorded = false;
      const recordAttempt = () => {
        if (recorded) return;
        recorded = true;
        this.core.event(topicId, "system", "system", "사용자 답변을 기존 Codex 세션에서 요청별로 확인합니다.",
          { reviewAnswerAttempt: latest.sequence, reviewAnswerBatchKey: batchKey,
            ...(batchRequests.length > 0 ? { reviewAnswerQuestionsAttempt: latest.sequence } : {}),
            requestIds: batchRequests.map((request) => request.id) });
      };
      const outcome = await this.core.executor.execute({
        role: "codex", topic, signal, purpose: "프로토콜 확인", inputSequence, expected: this.core.expectationOf(topic),
        write: false, implementation: false, protocolOnly: true, session: { mode: "resume", sessionId }, readablePaths: [],
        settings: this.core.executionSettings(topicId, "codex", false), onSpawn: recordAttempt,
        prompt: buildReviewAnswerConfirmationPrompt({ requests: batchRequests,
          decisions: batch.map(({ sequence, body }) => ({ sequence, body })),
          answerEvidence: answerEvidence.map(({ sequence, body }) => ({ sequence, body })) }),
      });
      recordAttempt();
      const parsed = AgentResultSchema.safeParse(outcome.result);
      if (!parsed.success || parsed.data.kind !== "REVIEW" || parsed.data.status !== "completed"
        || parsed.data.findings.length > 0 || parsed.data.requestedUserDecision || parsed.data.memoryUpdates?.length) {
        this.core.event(topicId, "system", "system", "답변 확인 결과가 유효하지 않아 열린 요청을 보존합니다.");
        return;
      }
      await this.core.saveAgentOutput(topic, "codex", parsed.data, "review-answer-confirmation", signal, { reviewAnswerConfirmation: true });
      if (this.core.interruptForNewUserInput(topic, inputSequence)) throw new HandledWorkflowInterruption();
      const answers = parsed.data.reviewDecisionAnswers ?? [];
      const ids = new Set<string>();
      if (answers.some((answer) => {
        const request = batchRequests.find((item) => item.id === answer.requestId);
        const decision = decisions.find((item) => item.sequence === answer.decisionSequence);
        const invalid = !request || !decision || decision.sequence <= request.sequence || ids.has(answer.requestId);
        ids.add(answer.requestId);
        return invalid;
      })) {
        this.core.event(topicId, "system", "system", "답변 확인의 요청 ID 또는 결정 순번이 일치하지 않아 요청을 보존합니다.");
        return;
      }
      // 이번 묶음만 정확히 한 번씩 판정해야 한다. 근거로 실은 과거 결정을 재판정하거나 일부를 빠뜨리면 저장하지 않는다.
      const assessments = parsed.data.decisionAssessments ?? [];
      const judged = new Set<number>();
      if (assessments.some((item) => !wanted.has(item.decisionSequence) || judged.has(item.decisionSequence) || !judged.add(item.decisionSequence))) {
        this.core.event(topicId, "system", "system", "결정 판정(decisionAssessments)이 입력에 없는 결정을 가리키거나 같은 결정을 두 번 다뤄 확인 결과를 받지 않습니다.");
        return;
      }
      if (judged.size !== wanted.size) {
        this.core.event(topicId, "system", "system", `결정 판정(decisionAssessments)이 결정을 다 다루지 않아(${judged.size}/${wanted.size}) 확인 결과를 받지 않습니다.`);
        return;
      }
      const demanding = assessments.filter((item) => item.changesImplementation).map((item) => item.decisionSequence);
      this.core.event(topicId, "system", "system",
        `답변을 확인한 리뷰 요청 ${answers.length}개를 해소했습니다.` + (demanding.length ? ` 구현 변경을 요구하는 결정: #${demanding.join(", #")}.` : ""),
        { reviewRequestAnswers: answers, reviewDecisionAssessments: assessments, reviewAnswersThrough: inputSequence });
      if (answers.length < batchRequests.length) return; // 실제 미답 질문은 새 답변을 기다린다.
    }
  }

  // READY에서 새 답변만 확인할 때는 이미 확정한 로컬 커밋과 코드 판정을 보존한다.
  private async resumeDeliveryAnswers(topicId: string, signal: AbortSignal): Promise<boolean> {
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    const flags = database.getFlags(topicId);
    const inputSequence = this.core.latestSequence(topicId);
    const kind = topic.state === "CODEX_FINAL_REVIEW" ? "codex-final-review" : "codex-review";
    await this.confirmReviewAnswers(topicId, signal, { reviewKind: kind });
    const stored = database.latestArtifact(topicId, kind, topic.scopeGeneration);
    const review = stored ? await this.core.latestResult(topicId, kind) : null;
    const passed = stored && database.getScopedTimeline(topicId, topic.scopeGeneration).findLast((event) =>
      event.actor === "system" && event.payload?.reviewCodePassed === true && event.payload?.reviewRevision === stored.revision
      && event.payload?.planEpoch === topic.planEpoch && event.payload?.planSHA256 === topic.planSHA256
      && event.payload?.reviewState === topic.state && event.payload?.reviewedHead === flags.reviewedHead
      && event.payload?.reviewedDiffSHA256 === flags.reviewedDiffSHA256);
    const snapshot = await this.core.dependencies.git.snapshot(topic.worktreePath, flags.reviewedHead ?? undefined);
    this.core.assertCurrent(topicId, signal, topic.scopeGeneration, topic.state);
    if (this.core.interruptForNewUserInput(topic, inputSequence)) return true;
    // 확인되지 않은 리뷰 답변이 남았으면 코드 판정 재사용 여부와 무관하게 여기서 멈춘다 — 리뷰를 다시 사도 그 질문은 해소되지 않는다.
    if (this.core.fixContracts.unansweredReviewQuestions(topic).length > 0) {
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", "취소되었거나 확인되지 않은 리뷰 답변이 남았습니다. 답변 후 재시도하세요.", topic.state);
      return true;
    }
    const reusable = Boolean(stored && review && passed && this.canReuseReview(topic, stored.revision, review));
    const codeSame = snapshot.head === (flags.committedOID ?? flags.reviewedHead) && snapshot.diffSHA256 === flags.reviewedDiffSHA256;
    if (!reusable || !codeSame) {
      if (flags.committedOID && !codeSame) {
        // 확정 커밋 뒤에 코드(HEAD 또는 diff)가 실제로 바뀐 경우만 멈춘다 — 이 주제에서 이어 고칠 수 없는 상태다(범위 변경 또는 새 주제).
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", "확정된 커밋의 코드가 바뀌어 답변 확인만으로 push할 수 없습니다. 커밋을 보존하고 변경을 확인하세요.", topic.state);
        return true;
      }
      // 코드·확정 커밋은 그대로이고 새 증거·메모·구현을 바꾸는(또는 확인되지 않은) 결정만 올라온 경우: 정상 리뷰가 새 입력을 읽는다. 확정 커밋은 deliveryBase(committedOID)로
      // 보존되고 markReady 가 HEAD == committedOID 이면 플래그를 지우지 않는다 — 여기서 멈추면 재시도마다 같은 정지만 반복했다(host-review 2026-09-21 R3).
      // 표식은 true 로 남긴다 — 새 리뷰 결과가 저장돼야 재확인이 끝난다(resumeDelivery 의 recheckPending; 4회차 R1).
      this.core.event(topicId, "system", "system", "코드·증거 변경을 정상 리뷰에서 확인합니다.", { reviewDeliveryRecheck: true, reviewDeliveryRecheckRefused: true });
      return false;
    }
    this.core.diagnoses.assertDeliverable(topicId, "답변 확인 후 인도");
    this.core.event(topicId, "system", "system", "기존 코드 판정과 커밋을 보존하고 답변을 재확인했습니다.", { reviewDeliveryRecheck: false });
    this.core.transition(topicId, "READY_TO_DELIVER", "현재 사용자 답변을 확인했습니다.");
    return true;
  }

  private reviewWorkCompleted(review: AgentResult): boolean {
    return review.status !== "blocked" && review.status !== "in_progress" && !review.remainingSteps?.length;
  }

  // 저장된 리뷰의 코드 판정을 재사용하는 **유일한** 게이트(모든 재사용 경로: resumeDeliveryAnswers·finalizePassedReview·finalizeStoredFinalReview). 핵심 조건 하나다 —
  // "그 리뷰가 읽은 입력(reviewInputSequence) 뒤의 사용자 입력이 전부 판정돼 있다": 결정이 아닌 입력(새 증거·메모·범위 변경)은 원래 리뷰가 읽지 않았으므로 하나라도 있으면 불가;
  // 결정은 엔진 행위 기록(commit/push/되돌리기·허용 오차 개정·구현 재개·action 요청 — reviewAnswerCandidate 가 아닌 것)이거나 확인자가 "구현 변경 요구 아님(false)" 으로
  // 판정한 것만 허용. 판정 없음(확인자가 돌지 않았거나 확인 결과가 거부됨)·판정 true·`OVERRULE <id>` 지시만 있는 결정은 허용이 아니다(fail-closed) — OVERRULE 은 그 쟁점의
  // 처분 변경 허용일 뿐 메시지 전체의 구현 변경 판정이 아니다(host-review 2026-09-21 5회차 R1·OVERRULE). 종전엔 이 검사가 재확인 경로에만 있어 저장 리뷰 재사용 경로가
  // 미판정 결정인 채 인도 대기로 갔다(3~5회차 R1 계열). 판정은 확인자(confirmReviewAnswers reviewKind)만 내린다 — 재개 경로는 재사용 판단 전에 확인자를 부른다.
  private canReuseReview(topic: Topic, revision: number, review: AgentResult): boolean {
    if (!this.reviewWorkCompleted(review)) return false;
    const input = this.reviewInputSequence(topic, revision);
    if (input === null) return false;
    const assessments = this.decisionAssessmentFlags(topic);
    return this.reviewTimeline(topic.id, topic.scopeGeneration, input).every((event) => {
      if (event.kind !== "decision") return false;
      if (!reviewAnswerCandidate(event)) return true;
      return assessments.get(event.sequence) === false;
    });
  }

  // 그 리뷰 산출물이 읽은 입력 순번(reviewInputSequence) — 재사용 판단의 기준점.
  private reviewInputSequence(topic: Topic, revision: number): number | null {
    const events = this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration);
    const output = events.find((event) => event.actor === "codex" && event.kind === "agent_output"
      && event.payload?.artifactRevision === revision && event.payload?.reviewAnswerConfirmation !== true);
    const input = output?.payload?.reviewInputSequence;
    return typeof input === "number" && Number.isSafeInteger(input) && input >= 0 && input < revision ? input : null;
  }

  // 확인자의 결정별 판정(decision 순번 → 구현 변경 요구 여부). 결정 하나당 판정 하나라 답변 여러 개가 한 판정을 덮어쓰지 않는다(R6); 같은 결정을 다시 판정했으면 마지막이 앞선다.
  private decisionAssessmentFlags(topic: Topic): Map<number, boolean> {
    const flags = new Map<number, boolean>();
    for (const event of this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration)) {
      if (event.actor !== "system" || !Array.isArray(event.payload?.reviewDecisionAssessments)) continue;
      for (const item of event.payload.reviewDecisionAssessments as Array<{ decisionSequence?: unknown; changesImplementation?: unknown }>) {
        if (typeof item?.decisionSequence === "number" && typeof item.changesImplementation === "boolean") flags.set(item.decisionSequence, item.changesImplementation);
      }
    }
    return flags;
  }

  // 확정 커밋 뒤의 재리뷰가 수정할 결함을 내면 수정 작업을 열지 않는다(host-review 2026-09-21 R8): 수정 턴은 requirePinnedBaseline(커밋 전 구현 기준 HEAD)에서 실패하고 커밋 뒤
  // 진단 등록도 막혀 되돌릴 길이 없다. 커밋된 결과는 이 주제에서 고칠 수 없으니 사용자에게 범위 변경(새 세대) 또는 인도 뒤 새 주제를 안내하고 멈춘다.
  private refuseFixAfterCommit(topicId: string, review: AgentResult, expected: WorkflowState): boolean {
    const flags = this.core.dependencies.database.getFlags(topicId);
    if (!flags.committedOID) return false;
    const ids = review.findings.filter((finding) => finding.disposition === "AGREED_ACTION").map((finding) => finding.id);
    this.core.interrupt(topicId, "USER_DECISION_REQUIRED",
      `확정 커밋(${flags.committedOID.slice(0, 12)}) 뒤의 재리뷰가 수정할 결함을 냈습니다(${ids.join(", ") || "-"}). 커밋된 결과는 이 주제에서 고칠 수 없습니다 — `
        + "범위 변경(scope_change)으로 새 세대를 열어 고치거나, 인도 뒤 새 주제에서 고치세요. 확정 커밋과 코드는 보존됩니다.",
      expected, { fixRefusedAfterCommit: ids, committedOID: flags.committedOID });
    return true;
  }

  private async finalizePassedReview(topicId: string, finalPass: boolean): Promise<boolean> {
    const database = this.core.dependencies.database;
    const inputSequence = this.core.latestSequence(topicId);
    const topic = this.core.requireState(topicId, finalPass ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW");
    const kind = finalPass ? "codex-final-review" : "codex-review";
    const stored = database.latestArtifact(topicId, kind, topic.scopeGeneration);
    if (!stored) return false;
    const passed = database.getTimeline(topicId, stored.revision).findLast((event) => event.scopeGeneration === topic.scopeGeneration
      && event.actor === "system" && event.payload?.reviewCodePassed === true && event.payload?.reviewRevision === stored.revision
      && event.payload?.planEpoch === topic.planEpoch && event.payload?.planSHA256 === topic.planSHA256 && event.payload?.reviewState === topic.state);
    if (!passed) return false;
    const reportRevision = finalPass ? (await this.core.fixContracts.finalReviewBase(topicId)).reportRevision
      : database.latestArtifact(topicId, "implementation-result", topic.scopeGeneration)?.revision;
    if (reportRevision === undefined || stored.revision <= reportRevision) return false;
    const current = await this.core.dependencies.git.snapshot(topic.worktreePath);
    if (current.head !== passed.payload?.reviewedHead || current.diffSHA256 !== passed.payload?.reviewedDiffSHA256) return false;
    const review = await this.core.latestResult(topicId, kind);
    const verdicts = await this.core.fixContracts.reviewVerdicts(topicId, review.findings);
    if (this.core.interruptForNewUserInput(topic, inputSequence)) return true;
    // 미답 질문이 남았으면(확인 결과가 거부된 답변 포함) 재사용 판단보다 먼저 멈춘다 — 통과한 코드 판정은 보존되고, 리뷰를 다시 사도 질문은 해소되지 않는다(R10 잔여).
    if (this.stopForUnansweredQuestions(database.getTopic(topicId))) return true;
    if (!this.canReuseReview(topic, stored.revision, review)) return false;
    this.markReady(topicId, current, "사용자 결정을 확인해 통과한 코드 리뷰를 재사용합니다.", verdicts);
    return true;
  }

  private async finalizeStoredFinalReview(topicId: string): Promise<boolean> {
    const database = this.core.dependencies.database;
    const inputSequence = this.core.latestSequence(topicId);
    const topic = this.core.requireState(topicId, "CODEX_FINAL_REVIEW");
    const stored = database.latestArtifact(topicId, "codex-final-review", topic.scopeGeneration);
    const base = await this.core.fixContracts.finalReviewBase(topicId);
    if (!stored || stored.revision <= base.reportRevision) return false;
    const flags = database.getFlags(topicId);
    if (!flags.reviewedHead || !flags.reviewedDiffSHA256) return false;
    const current = await this.core.dependencies.git.snapshot(topic.worktreePath);
    if (current.head !== flags.reviewedHead || current.diffSHA256 !== flags.reviewedDiffSHA256) return false;
    const review = await this.core.latestResult(topicId, "codex-final-review");
    const fixResult = base.report;
    const originalReview = await this.core.latestResult(topicId, "codex-review");
    // 진단 확인 처분은 통과 판정 전에 읽는다 — 이 뒤 전이까지 await 가 없어야 그 사이 도착한 결정을 건너뛰지 않는다(CF-01, 감사 5차 #6).
    const verdicts = await this.core.fixContracts.reviewVerdicts(topicId, review.findings);
    // 그 await 사이에 도착한 결정은 확인자가 아직 판정하지 않았다 — 판정 없는 결정으로는 재사용할 수 없으므로(canReuseReview) 여기서 멈추고 재시도가 확인자를 거쳐 판정받게 한다
    // (finalizePassedReview 와 같은 검사; 종전엔 그 결정을 되돌림 면제로만 세고 판정 없이 인도 대기로 갔다 — host-review 2026-09-21 5회차 R1 계열).
    if (this.core.interruptForNewUserInput(topic, inputSequence)) return true;
    // 수정 작업 계약의 원본(정지 쟁점 등)을 저장된 리뷰가 판정하지 않았으면 재사용하지 않는다 — 리뷰를 다시 사서 판정받는다.
    if (base.sources.some((finding) => !review.findings.some((item) => item.id === finding.id))) return false;
    if (review.findings.some((finding) => !finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE")) return false;
    const decisionsAfter = database.getTimeline(topicId, stored.revision)
      .some((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    if (!decisionsAfter) return false;
    const knownFindings = [...new Map(
      [...fixResult.findings, ...originalReview.findings, ...base.sources].map((finding) => [finding.id, finding]),
    ).values()];
    const adjudicated = this.core.fixContracts.adjudicatedFinalReviewIDs(topic);
    if (newFindingIDs(knownFindings, review.findings, "Codex final review").some((id) => !adjudicated.has(id))) return false;
    const overruled = this.userOverruledFindings(topic, "codex-review", originalReview.findings);
    for (const id of base.overruled) overruled.add(id);
    const agreed = mergeAgreedSources(base.sources, originalReview.findings);
    if (dispositionRegressions(agreed, review.findings, overruled).length > 0) return false;
    if (shouldRunFixPass(review.findings)) return false;
    // 미답 질문이 남았으면(확인 결과가 거부된 답변 포함) 재사용 판단보다 먼저 멈춘다 — 리뷰를 다시 사도 질문은 해소되지 않는다(R10 잔여, finalizePassedReview 와 같다).
    if (this.stopForUnansweredQuestions(database.getTopic(topicId))) return true;
    if (!this.canReuseReview(topic, stored.revision, review)) return false;
    this.noteOverruled(topicId, overruled, agreed, review.findings);
    this.core.event(topicId, "system", "system",
      `저장된 최종 리뷰(#${stored.revision})가 사용자 결정으로 통과 조건을 만족해 Codex 턴 없이 전달 준비로 넘깁니다.`);
    this.markReady(topicId, current, "최종 읽기 전용 리뷰를 통과했습니다(저장된 리뷰 재사용).", verdicts);
    return true;
  }

  // 계획의 탐색·왕복 보고는 제외한다. 사용자 제약·결정·외부 증거는 오래된 note도 남기며,
  // 구현·수정 보고와 첫 리뷰 findings는 프롬프트의 전용 항목으로 전달한다.
  private reviewTimeline(topicId: string, scopeGeneration: number, afterSequence = 0): TimelineEvent[] {
    return this.core.dependencies.database.getScopedTimeline(topicId, scopeGeneration, afterSequence).filter((event) =>
      ["scope_change", "evidence", "decision"].includes(event.kind) || (event.actor === "user" && event.kind === "note"));
  }

  // 수정 작업(계약) 실행 — 리뷰 수정·진단 전용 수정 공통(2026-09-15 "작업 계약을 기록으로"). 원본 쟁점·실은 진단·회차·수락 가드는 모두 계약에서 읽는다 —
  // 두 경로가 원본을 따로 추정하던 것(리뷰 수정: 회차 플래그와 최신 리뷰, 진단 전용 수정: 진단 사슬과 최신 최종 리뷰)이 조합마다 어긋났다(감사 2차).
  // 리뷰 수정은 자동 수정 회차(fixPassUsed·secondFixPassUsed)를 완주(최종 리뷰로 전이) 시점에 소비하고, 진단 전용 수정은 소비하지도 초기화하지도 않는다.
  private async runContractFix(topicId: string, signal: AbortSignal, opened: FixContract): Promise<void> {
    const database = this.core.dependencies.database;
    const topic = this.core.requireState(topicId, "CLAUDE_FIX");
    const contract = this.core.fixContracts.current(topicId, opened.contractId) ?? opened;
    const flags = database.getFlags(topicId);
    if (contract.route === "review" && flags.fixPassUsed && flags.secondFixPassUsed && !this.userDecisionAfterLastFixInterrupt(topic)) {
      throw new Error("Claude 자동 수정은 두 번까지만 허용됩니다. 결정을 올리고 재시도하면 추가 회차 1회가 열립니다.");
    }
    if (!flags.implementationSessionId) throw new Error("Claude 구현 세션을 찾을 수 없습니다.");
    const diagnoses = this.core.fixContracts.diagnoses(topicId, contract);
    if (contract.route === "diagnosis" && diagnoses.length === 0) {
      // 실은 진단이 모두 닫혔다(정정으로 닫았는데 계약 종결이 빠진 구성 — 옛 토픽·중간 종료). 러너 턴 없이 계약을 닫고 지금 작업 트리를 최종 리뷰한다 — throw 하면
      // retry 가 매번 FAILED 였다(2026-09-15 감사 3차). 열린 요청이 남았으면 닫지 않는다 — 요청을 해소할 작업이 사라진다(host-review R10 과 같은 규칙).
      let latest: WorkCheckpoint | null;
      try {
        latest = await this.core.checkpoints.latest(topicId);
      } catch (error) {
        // 손상된 checkpoint 의 열린 요청을 없는 것으로 보고 계약을 닫지 않는다 — 다른 복구 경로처럼 멈춘다(2026-09-15 감사 4차).
        if (!(error instanceof CheckpointCorrupt)) throw error;
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED", error.message, "CLAUDE_FIX", { checkpointCorrupt: error.revision, fixContract: contract.contractId });
        return;
      }
      const openRequests = latest && latest.work.scopeGeneration === topic.scopeGeneration && latest.work.planEpoch === topic.planEpoch ? latest.openRequests : [];
      if (openRequests.length > 0) {
        this.core.interrupt(topicId, "USER_DECISION_REQUIRED",
          `진단 전용 수정 작업 ${contract.contractId} 의 진단이 모두 닫혔지만 열린 요청 ${openRequests.map((request) => request.id).join(", ")} 이(가) 남았습니다 — `
          + "요청 해소를 지시하는 정정(kind fix)을 적용하세요.", "CLAUDE_FIX", { fixContract: contract.contractId });
        return;
      }
      this.core.transitionWith(topicId, "CODEX_FINAL_REVIEW",
        `진단 전용 수정 작업 ${contract.contractId} 의 진단이 모두 정정으로 닫혀 수정 없이 끝났습니다 — 지금 작업 트리를 최종 리뷰합니다.`, {
          contracts: [this.core.fixContracts.closed(contract, this.core.latestSequence(topicId))], payload: { fixContract: contract.contractId, fixContractClosed: true },
        });
      await this.runReview(topicId, signal, true);
      return;
    }
    const { content: plan, path: planPath } = await this.core.requireCurrentPlanArtifact(topicId);
    if (!topic.branchName) throw new Error("수정할 작업 브랜치가 없습니다.");
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName);
    const baselineHead = await this.requirePinnedBaseline(topicId, topic.worktreePath);
    const inputSequence = this.core.latestSequence(topicId);
    const decisionsPath = await this.writeDecisionsDigest(topic, signal);
    const diagnosisPrompts = await this.core.diagnoses.prompts(diagnoses);
    const readablePaths = [planPath, decisionsPath, ...diagnosisPrompts.paths];
    const toolTreesBefore = await this.toolTreeBaseline(topic, signal);
    this.assertToolTreesIntact(topic, toolTreesBefore, contract.route === "diagnosis" ? "진단 수정 재개 전" : "수정 재개 전");
    // 원본: 동결된 원본 중 정정·해결로 닫힌 진단이 아닌 것 + 실은 진단 중 열린 것. 진단 전용 수정은 둘을 한 원본으로(정지 쟁점도 러너가 처분한다),
    // 리뷰 수정은 리뷰 원본과 진단을 따로 검사한다(진단 누락은 진단 라벨로 교정 요청).
    const closed = this.core.diagnoses.mediatorClosedIds(topicId);
    const reviewSource = contract.source.filter((finding) => !closed.has(finding.id));
    const diagnosisFindings = this.core.diagnoses.findings(diagnoses);
    const diagnosisRoute = contract.route === "diagnosis";
    const primary = diagnosisRoute ? this.core.fixContracts.source(topicId, contract) : reviewSource;
    const label = diagnosisRoute ? "Claude fix(중재자 진단)" : "Claude fix";
    const check = (r: AgentResult) => {
      this.core.assertKind(r, "FIX");
      assertFindingCoverage(primary, r.findings, label);
      assertDispositionsResolved(primary, r, label);
      if (!diagnosisRoute && diagnosisFindings.length) {
        assertFindingCoverage(diagnosisFindings, r.findings, "Claude fix(중재자 진단)");
        assertDispositionsResolved(diagnosisFindings, r, "Claude fix(중재자 진단)");
      }
    };
    const fixBase = {
      planMarkdown: plan, planSHA256: topic.planSHA256, reviewFindings: primary, planPath, decisionsPath, diagnoses: diagnosisPrompts.prompts,
      ...(diagnosisRoute ? { heading: "승인된 계획 범위 안에서 중재자 진단(수정 지시)을 반영하세요. 수정 결과는 최종 리뷰를 다시 거쳐야 인도할 수 있습니다." } : {}),
    };
    await this.runWork({
      topicId, topic, kind: "FIX", work: this.core.checkpoints.binding(topic, "FIX", flags.implementationSessionId, contract.contractId),
      plan, planPath, readablePaths, baselineHead, toolTreesBefore, inputSequence, check,
      // 판단이 끝난 원본 쟁점은 서버가 승계한다 — 러너가 되돌려 담지 않아도 재제출을 사지 않는다(2026-09-13).
      carry: this.core.carryForwardNormalizer(primary, label),
      progressKind: "fix-progress", resultKind: "claude-fix", deferredSource: "fix",
      pauseFallbackMessage: diagnosisRoute ? "진단 수정에 사용자 결정이 필요합니다." : "수정 범위를 넓히려면 사용자 결정이 필요합니다.",
      prompts: (openRequests) => ({
        fresh: buildClaudeFixPrompt({ ...fixBase, openRequests, timeline: database.getPromptTimeline(topicId, topic.scopeGeneration) }),
        resume: buildClaudeFixPrompt({
          ...fixBase, openRequests, resumedSession: true,
          timeline: database.getPromptTimeline(topicId, topic.scopeGeneration, flags.implementationPromptSequence ?? 0),
        }),
      }),
      sessionId: flags.implementationSessionId,
      persistSession: (sessionId) => database.setImplementationSession(topicId, sessionId),
      initialTurn: true,
      // 진단 전용 수정은 새 논리 작업이다 — 결과는 이 진단 보고부터 쌓고, 허용 오차 원장은 마지막으로 수락된 원장에서 승계해 전체 diff 로 다시 대조한다.
      legacyBase: diagnosisRoute
        ? async () => ({ base: null, ledger: await this.legacyAcceptedLedger(topicId) })
        : async () => ({ base: await this.legacyPendingOriginal(topicId, topic, "CLAUDE_FIX"), ledger: await this.legacyAcceptedLedger(topicId) }),
      diagnoses,
      accept: this.contractAcceptance(topicId, topic, contract.contractId, signal),
    }, signal);
  }

  // 수정 수락(두 경로 공통): persist 없음 → transition = 되돌림 가드(면제 = 계약 시점의 판정 id ∪ 원본 뒤 사용자 결정이 적은 id ∪ 닫힌 진단) + **한 transaction**
  // 으로 회차 소비·최종 리뷰 전이·계약 수락·진단 반영 보고 → continue = 최종 리뷰. AcceptedResult 만 받는다 — 완료 판정을 거치지 않은 결과는 타입이 막는다.
  private contractAcceptance(topicId: string, topic: Topic, contractId: string, signal: AbortSignal): WorkSetup["accept"] {
    return {
      persist: async () => undefined,
      transition: (fixResult: AcceptedResult, acceptId: number, reported: FixReported) => {
        const contract = this.core.fixContracts.current(topicId, contractId);
        if (!contract || contract.status !== "open") {
          throw new Error(`수정 작업 계약 ${contractId} 가 열려 있지 않습니다(${contract?.status ?? "없음"}) — 이 결과를 수락하지 않습니다.`);
        }
        const source = this.core.fixContracts.source(topicId, contract);
        const overruled = this.core.fixContracts.overruled(topic, contract, source);
        this.noteOverruled(topicId, overruled, source, fixResult.findings);
        const downgraded = dispositionRegressions(source, fixResult.findings, overruled);
        if (downgraded.length > 0) {
          this.core.interrupt(topicId, "USER_DECISION_REQUIRED",
            `수정 단계가 고치기로 합의한 쟁점의 처분을 되돌렸습니다(${downgraded.join(", ")}). 최종 리뷰로 넘기지 않았습니다 — ${OVERRULE_GUIDANCE} `
            + "(중재자 진단이면 정정 진단으로 판단하세요.)", "CLAUDE_FIX", { fixContract: contract.contractId, downgradedFindingIDs: downgraded });
          return false;
        }
        this.core.transitionWith(topicId, "CODEX_FINAL_REVIEW",
          contract.route === "diagnosis" ? `Codex가 중재자 진단(${contract.diagnosisIds.join(", ")}) 수정 결과를 최종 검토합니다.` : "Codex가 수정 결과를 마지막으로 검토합니다.", {
            changes: contract.pass === "first" ? { fixPassUsed: true } : contract.pass === "second" ? { secondFixPassUsed: true } : {},
            contracts: [this.core.fixContracts.accepted(contract, acceptId, this.core.latestSequence(topicId))],
            payload: { fixContract: contract.contractId, ...(contract.pass === "none" ? { diagnosisFix: contract.diagnosisIds } : { fixPassConsumed: contract.pass === "second" ? 2 : 1 }) },
            ...reportedExtras(reported, "CODEX_FINAL_REVIEW"),
          });
        return true;
      },
      continue: async () => { await this.runReview(topicId, signal, true); },
    };
  }

  // 멈춘 수정 결과 재사용(2026-09-07, 계획·최종 리뷰 재사용과 같은 계열): 저장된 claude-fix 가 지금 고치는 리뷰보다 뒤이고, 그 뒤 사용자 decision 이 있고,
  // 그 결과가 수정 계약(kind·쟁점 커버·처분 해소)을 만족하고 **완료 판정을 통과**하면 수정 턴을 다시 사지 않는다. 완료 판정이 "상태 확인 필요"
  // (status 없음·모순)면 읽기 전용 확인 턴 1회를 거친다(PLAN §3 기존 결과 보존 후 확인). 하나라도 어긋나면 false — 호출자가 수정 턴을 돈다.
  // 논리 작업의 checkpoint 가 있으면 이 경로를 쓰지 않는다(runWork 가 checkpoint 에서 복구한다).
  private async finishStoredFix(topicId: string, contract: FixContract, signal: AbortSignal): Promise<boolean> {
    const database = this.core.dependencies.database;
    const topic = this.core.requireState(topicId, "CLAUDE_FIX");
    const flags = database.getFlags(topicId);
    if (flags.fixPassUsed && flags.secondFixPassUsed && !this.userDecisionAfterLastFixInterrupt(topic)) return false;
    const storedFix = database.latestArtifact(topicId, "claude-fix");
    // 저장된 수정 결과가 이 계약의 원본 리뷰보다 뒤여야 이 작업의 결과다.
    const originRevision = contract.origin.review?.revision;
    if (!storedFix || originRevision === undefined || storedFix.revision <= originRevision) return false;
    if (storedFix.scopeGeneration !== topic.scopeGeneration) return false;
    const decisions = database.getTimeline(topicId, storedFix.revision)
      .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    if (decisions.length === 0) return false;
    // 결정이 수정을 더 요구하면(REFIX) 저장 결과는 낡은 것이다 — 재사용하지 않고 수정 턴을 다시 연다.
    if (decisions.some((event) => refixDirective(event.body))) {
      this.core.event(topicId, "system", "system",
        `결정의 REFIX 지시로 저장된 수정 결과(#${storedFix.revision})를 재사용하지 않고 수정 턴을 다시 엽니다.`);
      return false;
    }
    const storedResult = await this.core.latestResult(topicId, "claude-fix");
    const closed = this.core.diagnoses.mediatorClosedIds(topicId);
    const source = contract.source.filter((finding) => !closed.has(finding.id));
    // 저장된 결과도 같은 승계 규칙으로 본다 — 되돌려 담지 않은 settled 쟁점 때문에 재사용을 포기하지 않는다.
    const fixResult = { ...storedResult, findings: carryForwardFindings(source, storedResult.findings).findings };
    try {
      this.core.assertKind(fixResult, "FIX");
      assertFindingCoverage(source, fixResult.findings, "Claude fix");
      assertDispositionsResolved(source, fixResult, "Claude fix");
    } catch {
      return false;
    }
    if (!topic.branchName) return false;
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName);
    const baselineHead = await this.requirePinnedBaseline(topicId, topic.worktreePath);
    if (await this.core.dependencies.git.head(topic.worktreePath) !== baselineHead) {
      throw new Error("Claude가 자동 수정 중 승인되지 않은 git commit을 만들었습니다.");
    }
    // 저장된 결과의 요청은 이미 사용자에게 제시됐고 그 뒤 결정이 왔다 — 해소 여부는 러너(확인 턴)가 판단한다(결정이 왔다고 지우지 않는다).
    const asked = fixResult.requestedUserDecision?.trim();
    const openRequests: OpenRequest[] = asked ? [{ id: requestId(asked, storedFix.revision), text: asked, askedAfterSequence: storedFix.revision }] : [];
    const verdict = completionVerdict(fixResult, { openRequests, decisionAfterRequest: decisions.length > 0 });
    if (verdict.kind === "await-input" || verdict.kind === "continue") {
      this.core.event(topicId, "system", "system",
        `저장된 수정 결과(#${storedFix.revision})는 완료가 아닙니다(${verdict.kind}${"remainingSteps" in verdict ? `: ${verdict.remainingSteps.join(" · ")}` : ""}) — 재사용하지 않고 같은 세션에서 수정 턴을 이어 갑니다.`,
        { storedFixInProgress: true, verdict: verdict.kind });
      return false;
    }
    if (!flags.implementationSessionId) return false;
    const { content: plan, path: planPath } = await this.core.requireCurrentPlanArtifact(topicId);
    const toolTreesBefore = await this.toolTreeBaseline(topic, signal);
    this.core.event(topicId, "system", "system",
      verdict.kind === "completed"
        ? `결정이 올라온 저장된 수정 결과(#${storedFix.revision})를 재사용해 최종 리뷰로 넘깁니다 — 수정 턴을 다시 사지 않습니다.`
        : `결정이 올라온 저장된 수정 결과(#${storedFix.revision})의 완료 상태가 불명확합니다(${verdict.message}) — 읽기 전용 확인 턴 1회로 확인합니다.`);
    // 완료 판정 루프만 돈다(initialTurn=false): 완료면 수락, 확인 필요면 읽기 전용 확인 1회, 그래도 불명확하면 보존한 채 멈춘다.
    await this.runWork({
      topicId, topic, kind: "FIX", work: this.core.checkpoints.binding(topic, "FIX", flags.implementationSessionId, contract.contractId),
      plan, planPath, readablePaths: [planPath], baselineHead, toolTreesBefore, inputSequence: this.core.latestSequence(topicId),
      check: (r) => { this.core.assertKind(r, "FIX"); assertFindingCoverage(source, r.findings, "Claude fix"); assertDispositionsResolved(source, r, "Claude fix"); },
      carry: this.core.carryForwardNormalizer(source, "Claude fix"),
      progressKind: "fix-progress", resultKind: "claude-fix", deferredSource: "fix",
      pauseFallbackMessage: "수정 범위를 넓히려면 사용자 결정이 필요합니다.",
      prompts: () => ({ fresh: "", resume: "" }),
      sessionId: flags.implementationSessionId, persistSession: () => undefined, initialTurn: false,
      legacyBase: async () => ({ base: fixResult, ledger: [...(fixResult.toleranceLedger ?? [])] }),
      accept: this.contractAcceptance(topicId, topic, contract.contractId, signal),
    }, signal);
    return true;
  }

  // 구현 세션은 계획 세션을 fork하지 않고 **새로 만든다**(2026-09-02). fork는 계획 턴의 저장소 탐색 이력을
  // 통째로 물려받아 첫 스텝부터 50만 토큰대에서 시작했고(S5 실측 517K), 매 스텝이 그것을 다시 읽어
  // 구현 비용의 대부분이 cache read였다(S5.1까지 Opus 1.8억 중 1.6억). 1M 벽도 그 때문이었다(S4 피크 998K,
  // S5 첫 fork는 모듈 하나 만에 800K). 구현 프롬프트는 계획 전문·타임라인·worktree·브랜치를 이미 다
  // 담고 있어 이력이 필요 없고, 메모리 문서는 새 세션 생성 턴에 주입되므로 fork로 물려받을 이유도 없다.
  // ---- 허용 오차(tolerance) 대조 — shared/tolerance.ts. 계획에 블록이 없으면 건너뛴다(승계 계획 호환) ----
  private async collectChangedFiles(topic: Topic): Promise<ChangedFile[]> {
    const git = this.core.dependencies.git;
    const base = this.core.dependencies.database.getFlags(topic.id).implementationBaseOID;
    if (!base) throw new Error("구현 기준 커밋이 없어 허용 오차를 대조할 수 없습니다.");
    const paths = await git.changedPaths(topic.worktreePath);
    const tracked = new Set(await git.trackedPaths(topic.worktreePath, paths));
    const changed: ChangedFile[] = [];
    for (const file of paths) {
      if (!tracked.has(file)) { changed.push({ file, untracked: true, hunks: [] }); continue; }
      const parsed = parseUnifiedDiff(await git.fileDiffSinceBase(topic.worktreePath, base, file));
      // 기준 커밋의 내용으로 hunk 의 문자열·주석 문맥을 재구성한다(여러 줄·raw 문자열, Codex 후속 지적 3). 못 읽으면 null → 위반.
      const baseContent = parsed.binary ? null : await git.fileAtCommit(topic.worktreePath, base, file);
      changed.push({
        file, untracked: false, hunks: parsed.hunks, binary: parsed.binary, modeChanged: parsed.modeChanged,
        baseLines: baseContent === null ? null : baseContent.split("\n"),
      });
    }
    return changed;
  }

  // 반환: 위반이 교정 뒤에도 남았으면 stop(정지 문구·위반 — 인터럽트는 호출자가 보존을 마친 뒤에 한다), 아니면 (1회 교정을 거쳤을 수 있는) 결과.
  private async enforceTolerance(input: {
    topicId: string; topic: Topic; plan: string; result: AgentResult; sessionId: string; signal: AbortSignal;
    inputSequence: number; resumeState: "IMPLEMENTING" | "CLAUDE_FIX"; check: (result: AgentResult) => void;
    baselineHead: string;
    readablePaths?: readonly string[];
    normalize?: ResultNormalizer;
    // 앞 턴에서 검증을 통과한 누적 원장(checkpoint.verifiedLedger) — 승계 대상.
    previousLedger: readonly ToleranceLedgerEntry[];
    expected: TurnExpectation; writeGuards: WriteGuards;
    openRequests?: readonly OpenRequest[];
    beforeCorrection?: (original: AgentResult) => Promise<void>;
    // 허용 오차 교정 응답이 계약을 어겨 다시 교정할 때(중첩), 그 호출 직전에 부른다.
    beforeNestedCorrection?: (rejected: AgentResult, violation: string) => Promise<void>;
  }): Promise<{ result: AgentResult } | { stop: { message: string; violations: string[] } }> {
    const policy = parseTolerancePolicy(input.plan);
    if (!policy) return { result: input.result };
    // 앞 턴에서 받아들인 원장은 승계한다 — 같은 파일이 그대로 범위 밖으로 바뀐 채면 러너가 다시 적지 않아도 교정 턴을 사지 않는다.
    // 술어·상한은 승계된 원장으로 다시 판정한다.
    const previousLedger = input.previousLedger;
    const evaluateWithCarry = async (candidate: AgentResult): Promise<{ result: AgentResult; evaluation: ReturnType<typeof evaluateTolerance> }> => {
      const changed = await this.collectChangedFiles(input.topic);
      const own = candidate.toleranceLedger ?? [];
      let evaluation = evaluateTolerance(policy, changed, own);
      const carry = carryForwardLedger(previousLedger, own, evaluation.outOfScopeFiles);
      if (carry.carried.length === 0) return { result: candidate, evaluation };
      evaluation = evaluateTolerance(policy, changed, carry.ledger);
      this.core.event(input.topicId, "system", "system",
        `허용 오차 원장 승계 ${carry.carried.length}건(앞 턴에서 받아들인 행, 엔진 자동): ${carry.carried.join(", ")}`,
        { carriedLedgerFiles: carry.carried });
      return { result: { ...candidate, toleranceLedger: carry.ledger }, evaluation };
    };
    let { result, evaluation } = await evaluateWithCarry(input.result);
    if (evaluation.violations.length > 0) {
      const original = result;
      // 교정 전 원본을 산출물로 보존한다(옛 소비처 호환) — 정본 복구는 checkpoint(beforeCorrection)다.
      const sourceRevision = (this.core.dependencies.database.latestArtifact(input.topicId, "tolerance-correction-source")?.revision ?? 0) + 1;
      await this.core.writeArtifact(input.topic, "tolerance-correction-source", sourceRevision, JSON.stringify({
        kind: "tolerance-correction-source", scopeGeneration: input.topic.scopeGeneration, planSHA256: input.topic.planSHA256,
        resumeState: input.resumeState, sessionId: input.sessionId, violations: evaluation.violations,
        original: redactUnverifiedResult(original),
      }, null, 2), input.signal);
      await input.beforeCorrection?.(original);
      this.core.event(input.topicId, "system", "system",
        `${renderToleranceSummary(evaluation)}\n같은 세션에 돌려보내 1회 교정합니다(되돌리기 또는 원장 보완).`,
        { toleranceViolations: evaluation.violations });
      // 실행 허용(새 입력·계획 변경·취소·유지보수·예산·쓰기 기준)은 실행기가 spawn 직전에 본다.
      const { result: corrected } = await this.core.executor.execute({
        role: "claude", topic: input.topic, signal: input.signal, purpose: "허용 오차 교정", inputSequence: input.inputSequence,
        expected: input.expected, write: true, writeGuards: input.writeGuards, session: { mode: "resume", sessionId: input.sessionId },
        prompt: buildToleranceCorrectionPrompt(evaluation.violations, policy, input.resumeState === "CLAUDE_FIX" ? "FIX" : "IMPLEMENTATION", input.openRequests),
        implementation: true, readablePaths: input.readablePaths, settings: this.core.executionSettings(input.topicId, "claude", true),
      });
      // 교정 턴도 커밋을 만들 수 있다 — 범위 밖 변경을 커밋해 버리면 작업 트리 대조에서 사라진다(2026-09-08 Codex 지적 2).
      await this.assertBaselineIntact(input.topic, input.baselineHead, "허용 오차 교정 중");
      // 교정 재제출은 본 턴 결과 위에 병합한다(쟁점·증거·요청 결정·요약 보존). 파싱 직후·계약 검사 전에 병합해야
      // 본 턴이 이미 채운 쟁점 처분을 교정이 빠뜨렸다고 계약 교정을 한 번 더 사지 않는다.
      let preservedParts: string[] = [];
      const mergeNormalizer = (parsed: AgentResult): AgentResult => {
        const merged = mergeCorrectionResult(original, parsed);
        preservedParts = merged.preserved;
        return input.normalize ? input.normalize(merged.result) : merged.result;
      };
      const contracted = await this.core.enforceResultContract("claude", input.topic, corrected, input.sessionId, {
        signal: input.signal, implementation: true, planMode: false, startedAfter: input.inputSequence, check: input.check,
        readablePaths: input.readablePaths, normalize: mergeNormalizer, writeGuards: input.writeGuards, beforeCorrection: input.beforeNestedCorrection,
      });
      if (preservedParts.length > 0) {
        this.core.event(input.topicId, "system", "system",
          `허용 오차 교정 재제출에 본 턴 보고를 병합했습니다(서버 보존): ${preservedParts.join(" · ")}`, { correctionPreserved: preservedParts });
      }
      // 계약 교정이 한 번 더 돌았을 수 있다 — 그 호출도 커밋을 만들 수 있으므로 다시 본다(Codex 후속 지적 1).
      await this.assertBaselineIntact(input.topic, input.baselineHead, "허용 오차 교정 뒤 계약 교정 중");
      ({ result, evaluation } = await evaluateWithCarry(contracted));
      if (evaluation.violations.length > 0) {
        // 정지는 호출자가 한다 — 누적본(checkpoint)과 진단 처분을 인터럽트 **전에** 보존해야 한다(인터럽트 뒤의 기록은 늦은 산출물로 버려진다).
        return { stop: {
          message: `교정 뒤에도 허용 오차 위반이 남았습니다 — 되돌릴지, 규칙을 넓힐지(계획 개정) 결정이 필요합니다.\n${renderToleranceSummary(evaluation)}`,
          violations: evaluation.violations,
        } };
      }
    }
    this.core.event(input.topicId, "system", "system", renderToleranceSummary(evaluation), { toleranceUsage: evaluation.usage });
    return { result };
  }

  // ---- 옛 산출물 복구(checkpoint 가 없는 토픽·시드 픽스처 전용) — checkpoint 가 있으면 쓰지 않는다 ----
  // 서버가 받아들인 **가장 최근** 결과 하나의 원장. 여러 결과를 합치지 않는다(R05). fix-progress 포함(R3-10).
  private async legacyAcceptedLedger(topicId: string): Promise<ToleranceLedgerEntry[]> {
    const db = this.core.dependencies.database;
    const candidates = ["implementation-result", "implementation-progress", "claude-fix", "fix-progress"]
      .map((kind) => db.latestArtifact(topicId, kind))
      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const latest = candidates[0];
    if (!latest) return [];
    try {
      const raw = await this.core.dependencies.artifacts.readLatest(topicId, latest.kind);
      if (!raw) return [];
      const parsed = AgentResultSchema.safeParse(JSON.parse(raw));
      return parsed.success ? [...(parsed.data.toleranceLedger ?? [])] : [];
    } catch {
      return []; // 손상된 산출물은 승계 근거가 아니다 — 러너 원장만으로 판정한다.
    }
  }

  // 마지막 받아들인 결과 이후의 원본(tolerance/contract/progress)을 오래된 것부터 순서대로 병합한다(R3-02). 받아들였지만 완료가 아닌 최신 결과도 바탕이다(R3-01).
  // 요청 결정은 결정이 왔다는 이유로 지우지 않는다 — 열린 요청은 runWork 가 요청별로 보존·확인한다.
  private async legacyPendingOriginal(topicId: string, topic: Topic, resumeState: "IMPLEMENTING" | "CLAUDE_FIX"): Promise<AgentResult | null> {
    const db = this.core.dependencies.database;
    const acceptedArtifacts = ["implementation-result", "claude-fix"].map((kind) => db.latestArtifact(topicId, kind))
      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    const latestAccepted = acceptedArtifacts[0];
    const accepted = latestAccepted?.createdAt ?? "";
    const parts: AgentResult[] = [];
    const acceptedKind = resumeState === "IMPLEMENTING" ? "implementation-result" : "claude-fix";
    if (latestAccepted && latestAccepted.kind === acceptedKind && latestAccepted.scopeGeneration === topic.scopeGeneration) {
      try {
        const raw = await this.core.dependencies.artifacts.readLatest(topicId, acceptedKind);
        const parsed = raw ? AgentResultSchema.safeParse(JSON.parse(raw)) : null;
        if (parsed?.success && completionVerdict(parsed.data, { openRequests: [], decisionAfterRequest: false }).kind !== "completed") parts.push(parsed.data);
      } catch {
        // 손상된 산출물은 복구 근거가 아니다.
      }
    }
    const kinds = ["tolerance-correction-source", "contract-repair-source", resumeState === "IMPLEMENTING" ? "implementation-progress" : "fix-progress"];
    const candidates = kinds.map((kind) => db.latestArtifact(topicId, kind))
      .filter((artifact): artifact is NonNullable<typeof artifact> => artifact !== null && artifact.createdAt > accepted && artifact.scopeGeneration === topic.scopeGeneration)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    for (const artifact of candidates) {
      try {
        const raw = await this.core.dependencies.artifacts.readLatest(topicId, artifact.kind);
        if (!raw) continue;
        const record = JSON.parse(raw) as Record<string, unknown>;
        if (artifact.kind === "tolerance-correction-source") {
          if (record.planSHA256 !== topic.planSHA256 || record.resumeState !== resumeState) continue;
          const parsed = AgentResultSchema.safeParse(record.original);
          if (parsed.success) parts.push(parsed.data);
          continue;
        }
        if (artifact.kind === "contract-repair-source") {
          if (record.kind !== "contract-repair-source" || record.state !== resumeState || record.planSHA256 !== topic.planSHA256) continue;
          parts.push(salvageResultFields(record.original, resumeState === "IMPLEMENTING" ? "IMPLEMENTATION" : "FIX"));
          continue;
        }
        const parsed = AgentResultSchema.safeParse(record);
        if (parsed.success) parts.push(parsed.data);
      } catch {
        // 손상된 산출물은 복구 근거가 아니다.
      }
    }
    if (parts.length === 0) return null;
    return parts.reduce((base, next) => mergeCorrectionResult(base, next).result);
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

  // 사용자 결정·증거·범위 변경 원문 전체를 읽기 전용 산출물로 쓴다(내용이 같으면 새 판 없음). 반환: sha 검증한 정본 경로.
  private async writeDecisionsDigest(topic: Topic, signal: AbortSignal): Promise<string> {
    const events = this.core.dependencies.database.getScopedTimeline(topic.id, topic.scopeGeneration)
      .filter((event) => event.actor === "user" && ["decision", "evidence", "scope_change"].includes(event.kind));
    const body = [
      "# 결정·증거 원문(서버 보존, 읽기 전용)", "",
      `주제 ${topic.id} · 범위 세대 ${topic.scopeGeneration} · ${events.length}건. 결정 번호([d n])는 본문 첫 줄에 있다.`, "",
      ...events.map((event) => `## 이벤트 #${event.sequence} · ${event.kind} · ${event.createdAt}\n\n${event.body}\n`),
    ].join("\n");
    const latest = await this.core.dependencies.artifacts.readLatest(topic.id, "decisions");
    if (latest !== body) {
      const revision = (this.core.dependencies.database.latestArtifact(topic.id, "decisions")?.revision ?? 0) + 1;
      await this.core.writeArtifact(topic, "decisions", revision, body, signal);
    }
    return this.core.dependencies.artifacts.verifiedPath(topic.id, "decisions");
  }



  // 브랜치가 그대로이고 HEAD 가 구현 기준과 같은지 — 에이전트 호출(교정 포함) 뒤마다 부른다. 커밋으로 범위 밖 변경을 숨기면 여기서 멈춘다.
  private async assertBaselineIntact(topic: Topic, baselineHead: string, phase: string): Promise<void> {
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName!);
    if (await this.core.dependencies.git.head(topic.worktreePath) !== baselineHead) {
      throw new Error(`Claude가 ${phase} 승인되지 않은 git commit을 만들었습니다. 중단합니다.`);
    }
  }

  // 브랜치 생성 시점에 고정한 기준 HEAD를 돌려준다. 현재 HEAD가 기준과 다르면 서버 밖에서 커밋이
  // 생긴 것이므로 그것을 기준으로 승격하지 않고 멈춘다 — 사용자가 discard-orphan-commit이나 직접
  // 확인으로 처분해야 한다(감사 ⑥).
  private async requirePinnedBaseline(topicId: string, worktreePath: string): Promise<string> {
    const pinned = this.core.dependencies.database.getFlags(topicId).implementationBaseOID;
    const head = await this.core.dependencies.git.head(worktreePath);
    if (!pinned) {
      // 이 컬럼이 생기기 전에 시작한 주제의 이행 경로: 지금 HEAD를 기준으로 고정한다.
      this.core.dependencies.database.updateTopic(topicId, { implementationBaseOID: head });
      return head;
    }
    if (head !== pinned) {
      throw new Error(`현재 HEAD(${head.slice(0, 12)})가 구현 기준(${pinned.slice(0, 12)})과 다릅니다. 서버 밖에서 생긴 커밋을 먼저 처분해 주세요.`);
    }
    return pinned;
  }

  private markReady(
    topicId: string,
    snapshot: { head: string; diffSHA256: string },
    message: string,
    verdicts: ReadonlyMap<string, Finding["disposition"]>,
  ): void {
    // 리뷰가 사용자에게 물은 질문(requestedUserDecision)에 사용자 결정이 없으면 인도 대기로 넘기지 않는다 — 인도 대기로 가는 길은 모두 여기를 지나므로 진단 우회·결정
    // 없는 재시도 어느 경로도 그 질문을 건너뛰지 못한다(host-review R10 잔여). 동기 검사라 입력 검사와 전이 사이에 await 가 끼지 않는다(⑩).
    const database = this.core.dependencies.database;
    const topic = database.getTopic(topicId);
    this.recordCodeReviewPassed(topic, snapshot);
    if (this.stopForUnansweredQuestions(topic)) return;
    // 확정 커밋(push)이 지금 HEAD 그대로면 보존한다 — 커밋 뒤 새 증거·결정을 정상 리뷰로 확인한 경우 인도 사슬(deliveryBase)이 그 커밋에서 이어진다(host-review 2026-09-21 R3).
    // HEAD 가 다르면 그 커밋은 더 이상 인도 기준이 아니므로 지운다.
    const flags = database.getFlags(topicId);
    this.core.dependencies.database.updateTopic(topicId, {
      reviewedHead: snapshot.head,
      reviewedDiffSHA256: snapshot.diffSHA256,
      committedOID: flags.committedOID && flags.committedOID === snapshot.head ? flags.committedOID : null,
      pushedOID: flags.pushedOID && flags.pushedOID === snapshot.head ? flags.pushedOID : null,
    });
    this.core.transition(topicId, "READY_TO_DELIVER", message);
    // 반영 보고된 중재자 진단 중 통과한 리뷰가 반영을 확인한 것만 해결이다(나머지는 열린 채 커밋을 막는다).
    this.core.diagnoses.resolveReported(topicId, snapshot, verdicts);
    void this.announceDeferredForDelivery(topicId);
  }

  // 리뷰가 물은 질문에 결정이 없으면 여기서 멈춘다 — 인도 대기 전이(markReady)와 통과한 저장 리뷰의 재사용 판단(finalizePassedReview) 둘 다 이 검사를 먼저 지난다. 재사용 판단이
  // 먼저 오면 미답 질문(확인 결과가 거부된 답변 포함)이 남은 결정을 "판정 없음" 으로 보고 리뷰를 다시 사는데, 리뷰를 다시 사도 그 질문은 해소되지 않는다(R10 잔여: 요청 보존·재호출 없음).
  private stopForUnansweredQuestions(topic: Topic): boolean {
    const unanswered = this.core.fixContracts.unansweredReviewQuestions(topic);
    if (unanswered.length === 0) return false;
    this.core.interrupt(topic.id, "USER_DECISION_REQUIRED",
      `리뷰가 사용자에게 물은 질문에 아직 결정이 없어 인도 대기로 넘기지 않았습니다 — ${unanswered.map((item) => `#${item.sequence} ${item.question}`).join(" / ")}. `
        + "결정을 올리고 재시도하세요(진단 적용·정정이나 결정 없는 재시도는 이 질문을 해소하지 않습니다).",
      topic.state, { reviewQuestionsUnanswered: unanswered.map((item) => item.sequence) });
    return true;
  }

  // 인도 전 처분 요청: 이 토픽이 후속 목록에 올린 쟁점(러너 to-do·종결 확인·최종 리뷰 이연)을 한 번 띄운다.
  // 처분(후속 토픽 / 다음 단계 계획 포함 / 폐기)은 범위 결정이라 사용자 몫이고, "다음 계획 포함" 은 후속 토픽의
  // 첫 계획 프롬프트에 자동으로 실린다(deferredFindingsFor). 실패해도 인도를 막지 않는다.
  private async announceDeferredForDelivery(topicId: string): Promise<void> {
    try {
      const deferred = await this.core.deferredFindingsOf(topicId);
      if (deferred.length === 0) return;
      const lines = deferred.map((item) => `- ${item.id} [${item.severity}] ${item.title} (${item.source})`).join("\n");
      this.core.event(topicId, "system", "system",
        `인도 전 처분이 필요한 후속 목록 ${deferred.length}건 — 항목마다 후속 토픽 / 다음 단계 계획에 포함 / 폐기 중 하나를 사용자가 정합니다(커밋 전).\n${lines}`,
        { deferredForDelivery: deferred.map((item) => item.id) });
    } catch {
      // 부가 안내라 실패를 삼킨다.
    }
  }

  async commit(topicId: string, message: string, paths: string[], idempotencyKey?: string): Promise<string> {
    return this.withDeliveryLock(topicId, async (topic) => {
      this.assertReviewAnswersForDelivery(topic);
      this.core.diagnoses.assertDeliverable(topicId, "커밋(commit)");
      if (!topic.branchName) throw new Error("커밋할 작업 브랜치가 없습니다.");
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.reviewedHead || !flags.reviewedDiffSHA256) throw new Error("최종 리뷰가 확인한 변경 스냅샷이 없습니다.");
      // 인도 커밋은 사슬을 이룰 수 있다(S11 계획 C1 소스 → C2 flip → C3 문서, [d02] S11-A03; 2026-09-21): 다음 커밋의 기준 HEAD 와 부모는
      // **마지막 확정 커밋**(없으면 리뷰 HEAD)이고, 내용 불변은 **리뷰 HEAD 기준** diff 해시로 본다 — 커밋은 파일을 바꾸지 않으므로 리뷰가 본
      // 변경 집합(작업 트리 vs 리뷰 HEAD)은 사슬 내내 같다. 이전엔 기준이 리뷰 HEAD 로 고정돼 두 번째 커밋부터 "worktree 가 바뀌었다" 로 거부됐다.
      const deliveryBase = flags.committedOID ?? flags.reviewedHead;
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
      const oid = await this.core.dependencies.git.commit(topic.worktreePath, topic.branchName, message, paths);
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

  async push(topicId: string): Promise<string> {
    return this.withDeliveryLock(topicId, async (topic) => {
      this.assertReviewAnswersForDelivery(topic);
      this.core.diagnoses.assertDeliverable(topicId, "push");
      if (!topic.branchName) throw new Error("push할 작업 브랜치가 없습니다.");
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.committedOID) throw new Error("Consensus Room에서 확정한 커밋이 없습니다.");
      if (await this.core.dependencies.git.head(topic.worktreePath) !== flags.committedOID) {
        throw new Error("확정한 커밋 뒤 HEAD가 바뀌어 push를 중단했습니다.");
      }
      const oid = await this.core.dependencies.git.push(topic.worktreePath, topic.branchName);
      this.assertDeliverySnapshot(topic);
      this.core.dependencies.database.updateTopic(topicId, { pushedOID: oid });
      this.core.event(topicId, "user", "decision", "작업 브랜치를 원격 저장소에 push했습니다.", { oid, branchName: topic.branchName, deliveryAction: "push" });
      return oid;
    });
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
      if (parents.length !== 1) {
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
        this.core.dependencies.database.updateTopic(topicId, { committedOID: head, pushedOID: null });
      } else {
        if (flags.committedOID !== head) {
          throw new Error("확정된 커밋과 현재 HEAD가 달라 push 성공으로 기록할 수 없습니다.");
        }
        if (await this.core.dependencies.git.remoteBranchOID(topic.worktreePath, topic.branchName) !== head) {
          throw new Error("원격 브랜치가 현재 커밋을 가리키지 않아 push 성공이 아닙니다.");
        }
        assertStillReconciling();
        this.core.dependencies.database.updateTopic(topicId, { pushedOID: head });
      }
    }
    assertStillReconciling();
    this.core.dependencies.database.resolveUnknownDeliveryAction(
      topicId, action, recovery.idempotencyKey, input.outcome,
    );
    this.core.transition(topicId, "READY_TO_DELIVER", `중단됐던 ${action} 결과를 사용자가 ${input.outcome === "succeeded" ? "성공" : "실패"}으로 확인했습니다.`);
    return this.core.dependencies.database.getTopic(topicId);
  }

  private assertReviewAnswersForDelivery(topic: Topic): void {
    if (this.core.fixContracts.unansweredReviewQuestions(topic).length > 0) {
      throw new Error("리뷰 답변의 확인이 필요해 전달을 막았습니다. 사용자 결정을 확인하고 재시도하세요.");
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

export { isMissingSessionError } from "./turnExecutor.js";


// 후속 목록에서 빼야 할 쟁점 id — 뒤 단계가 DEFERRED_OUT_OF_SCOPE 가 아닌 처분(해결·불필요·반박·수정 합의)을 붙인 것.
function resolvedIDs(result: AgentResult): string[] {
  return result.findings
    .filter((finding) => finding.disposition && finding.disposition !== "DEFERRED_OUT_OF_SCOPE" && finding.disposition !== "EXTERNAL_EVIDENCE")
    .map((finding) => finding.id);
}

// 정정·해결로 닫힌 진단의 쟁점 중 판단이 끝나지 않은 처분(증거·결정 요청, 미반영)을 판단이 끝난 처분으로 바꾼다 — 닫힌 진단은 중재자가 처리했으므로
// 완료 판정·계속 진행이 그 처분을 기다리지 않는다. 쟁점 자체(보고 기록)는 지우지 않는다.
function settleClosedDiagnoses(result: AgentResult, closed: ReadonlySet<string>): AgentResult {
  if (closed.size === 0) return result;
  let changed = false;
  const findings = result.findings.map((finding) => {
    if (!closed.has(finding.id)) return finding;
    const open = finding.disposition === undefined || finding.disposition === "AGREED_ACTION" || finding.disposition === "EXTERNAL_EVIDENCE" || finding.requiresUserDecision;
    if (!open) return finding;
    changed = true;
    return { ...finding, disposition: "AGREED_NO_ACTION" as const, requiresUserDecision: false, rationale: `정정·해결로 닫힌 중재자 진단(서버 정리): ${finding.rationale}` };
  });
  return changed ? { ...result, findings } : result;
}
