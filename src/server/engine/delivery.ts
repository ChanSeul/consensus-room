// 구현·리뷰·전달 파이프라인: IMPLEMENTING → CODEX_REVIEW → (CLAUDE_FIX → CODEX_FINAL_REVIEW) →
// READY_TO_DELIVER → commit/push. git 사후 검증(고아 커밋 처분 포함)이 이 파일의 계약이다.
import {
  AgentResultSchema, DeliveryInputSchema, type AgentResult, type Finding, type TimelineEvent, type Topic, type WorkflowState,
} from "../../shared/contracts.js";
import { digestToolTrees, type ToolTreeDigest } from "../toolTree.js";
import { redactUnverifiedResult } from "../security.js";
import {
  buildContinuationPrompt,
  buildStatusConfirmationPrompt,
  buildClaudeFixPrompt,
  buildCodexReviewPrompt,
  buildImplementationPrompt, buildToleranceCorrectionPrompt,
} from "../../shared/prompts.js";
import {
  assertImplementationGate,
  assertDispositionsResolved,
  assertFindingCoverage,
  dispositionRegressions,
  newFindingIDs,
  resolveBranchName,
  refixDirective,
  shouldRunFixPass,
  routeMediatorOwnedFindings,
  carryForwardFindings,
  implementationInProgress,
  mergeCorrectionResult,
  salvageResultFields,
  mergeFindingSources,
  assertTransition,
} from "../../shared/workflow.js";
import { normalizeCommitPaths } from "../git.js";
import { redactAgentResult } from "../security.js";
import {
  carryForwardLedger, evaluateTolerance, parseTolerancePolicy, parseUnifiedDiff, renderToleranceSummary, type ChangedFile,
  type ToleranceLedgerEntry,
} from "../../shared/tolerance.js";
import type { ResultNormalizer, EngineCore } from "./core.js";
import type { TurnExpectation, WriteGuards } from "./turnExecutor.js";
import {
  accumulate, requestId, workId, CheckpointCorrupt, type Accumulation, type RecoveredWork, type WorkBinding, type WorkCheckpoint, type WorkKind,
} from "./checkpoint.js";
import { acceptResult, completionVerdict, renderOpenRequests, type AcceptedResult, type CompletionVerdict, type OpenRequest } from "./completion.js";

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
  onAccepted: (accepted: AcceptedResult, acceptId: number) => Promise<void>;
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
    const plan = await this.core.requireStoredPlan(topicId);
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName!);
    const baselineHead = await this.requirePinnedBaseline(topicId, topic.worktreePath);
    const inputSequence = this.core.latestSequence(topicId);
    const sessionFlags = this.core.dependencies.database.getFlags(topicId);
    const existingImplementationSession = sessionFlags.implementationSessionId;
    // 계획 원문은 별칭(plan.md)이 아니라 sha 로 검증한 정본 blob 경로를 넘긴다(Codex 후속 지적 6).
    const planPath = await this.core.dependencies.artifacts.verifiedPath(topicId, "plan");
    // 개정 없이 넘어온 경미 지적(구현 노트)은 첫 프롬프트에 실리고, 러너 결과가 id 별 처분을 빠뜨리면 커버리지 계약이 재제출을 요구한다.
    const implementationNotes = await this.core.implementationNotesOf(topicId);
    const noteFindings: Finding[] = implementationNotes.map((note) => ({
      id: note.id, title: note.title, severity: note.severity, disposition: "AGREED_ACTION", rationale: note.rationale,
      evidenceRefs: [], requiresUserDecision: false,
    }));
    // 결정·증거 원문 산출물(읽기 허용) — 세션 압축 뒤에도 원문을 다시 찾을 수 있다(Codex 감사 D02).
    const decisionsPath = await this.writeDecisionsDigest(topic, signal);
    const readablePaths = [planPath, decisionsPath];
    // 도구 트리 기준은 산출물(tool-tree-baseline)이다 — 감지된 변경은 중재자가 재동기화 뒤 rebaseline 하기 전까지 재시도로 통과하지 않는다(F04).
    const toolTreesBefore = await this.toolTreeBaseline(topic, signal);
    this.assertToolTreesIntact(topic, toolTreesBefore, "재개 전");
    const promptBase = {
      planMarkdown: plan, planSHA256: topic.planSHA256!, worktreePath: topic.worktreePath, branchName: topic.branchName!, planPath,
      decisionsPath, implementationNotes,
    };
    const scopedTopic = topic;
    await this.runWork({
      topicId, topic, kind: "IMPLEMENTATION", work: this.core.checkpoints.binding(topic, "IMPLEMENTATION", existingImplementationSession),
      plan, planPath, readablePaths, baselineHead, toolTreesBefore, inputSequence,
      check: (r: AgentResult) => { this.core.assertKind(r, "IMPLEMENTATION"); assertFindingCoverage(noteFindings, r.findings, "Claude implementation(구현 노트)"); },
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
      // 세션 저장이 검증보다 먼저다 — 검증이 턴을 거부해도 세션이 남아야 재시도가 재구현 없이 resume된다
      // (2026-09-01 S1.1: 저장 전에 거부돼 수동 DB 복구가 필요했던 사건의 프로그램적 방지).
      persistSession: (sessionId) => this.core.dependencies.database.setImplementationSession(topicId, sessionId),
      initialTurn: true,
      legacyBase: async () => ({
        base: await this.legacyPendingOriginal(topicId, scopedTopic, "IMPLEMENTING"), ledger: await this.legacyAcceptedLedger(topicId),
      }),
      onAccepted: async (accepted) => {
        await this.core.writeArtifact(scopedTopic, "implementation", 1, renderReport(accepted), signal);
        this.core.transition(topicId, "CODEX_REVIEW", "Codex가 구현 결과를 읽기 전용으로 검토합니다.");
        await this.runReview(topicId, signal, false);
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
    if (recovered) {
      const checkpoint = recovered.checkpoint;
      const newInput = this.userInputSince(topic, checkpoint.inputSequence);
      if (checkpoint.phase === "accepting" || checkpoint.phase === "accepted") {
        // 수락 복구도 일반 수락과 같은 현재성 검사에 결속된다(CF-01): 새 결정·증거가 왔으면 반영할 쓰기 턴을, 워킹트리가 수락 시점과 다르면
        // 다시 대조·판정을 거친 뒤에만 채택·전이한다. 둘 다 아니면 acceptId 기준으로 남은 후속만 한다.
        const snapshot = await this.core.dependencies.git.snapshot(topic.worktreePath);
        const treeChanged = !checkpoint.worktree || checkpoint.worktree.head !== snapshot.head || checkpoint.worktree.diffSHA256 !== snapshot.diffSHA256;
        if (!newInput && !treeChanged) {
          await this.finishAccept(setup, checkpoint, signal);
          return;
        }
        this.core.event(topicId, "system", "system",
          `수락 checkpoint #${checkpoint.revision}(${checkpoint.phase}) 뒤에 ${newInput ? "새 결정·증거가 도착해" : "워킹트리가 바뀌어"} 수락을 그대로 이어가지 않습니다 — ${newInput ? "반영할 쓰기 턴을 연 뒤" : "현재 변경분을 다시 대조·판정한 뒤"} 다시 수락합니다.`,
          { acceptNotResumed: checkpoint.revision, newInput: Boolean(newInput), treeChanged });
        if (!newInput) initialTurn = false;
      } else if (checkpoint.phase === "before-confirmation") {
        // 확인 예약만 남기고 종료됐다 — 쓰기를 다시 열지 않고 그 확인(읽기 전용)을 이어서 한다(CF-05). 예약은 실행이 아니므로 횟수에서 뺀다.
        initialTurn = false;
        this.core.event(topicId, "system", "system", `checkpoint #${checkpoint.revision} 는 완료 상태 확인 턴 예약 상태였습니다 — 쓰기 턴 없이 읽기 전용 확인을 이어갑니다.`,
          { confirmationResumed: checkpoint.revision });
      }
      const askedText = recovered.accumulated.requestedUserDecision?.trim();
      const openRequests = checkpoint.openRequests.length === 0 && askedText
        ? [{ id: requestId(askedText, checkpoint.inputSequence), text: askedText, askedAfterSequence: checkpoint.inputSequence }]
        : [...checkpoint.openRequests];
      // 확인 횟수: 예약(before-confirmation)은 실행이 아니다. 멈춘 뒤 새 결정이 올라왔으면 그 결정에 대해 확인 1회를 다시 허용한다(자동 무제한이
      // 아니라 사용자 결정 1건당 1회 — "결정을 올리고 재시도" 안내가 실제로 통하게, CF-05).
      const confirmations = checkpoint.phase === "before-confirmation" ? Math.max(0, checkpoint.confirmations - 1)
        : (checkpoint.phase === "paused" && newInput ? 0 : checkpoint.confirmations);
      seed = { base: recovered.accumulated, openRequests, verifiedLedger: [...recovered.verifiedLedger], confirmations };
      this.core.event(topicId, "system", "system",
        `누적 checkpoint #${checkpoint.revision}(${checkpoint.phase}, ${workId(setup.work)}) 에서 이어갑니다 — 열린 요청 ${seed.openRequests.length}건, 검증 원장 ${seed.verifiedLedger.length}행.`,
        { checkpointResumed: checkpoint.revision, phase: checkpoint.phase, workId: workId(setup.work) });
    } else {
      const legacy = await setup.legacyBase();
      const asked = legacy.base?.requestedUserDecision?.trim();
      seed = {
        base: legacy.base, verifiedLedger: legacy.ledger, confirmations: 0,
        // 옛 산출물의 요청은 제시 시점을 모른다 — 0 으로 두면 그 뒤의 모든 결정이 "요청 뒤 결정" 이 되어 해소 확인을 거친다.
        openRequests: asked ? [{ id: requestId(asked, 0), text: asked, askedAfterSequence: 0 }] : [],
      };
      if (legacy.base) {
        this.core.event(topicId, "system", "system",
          "직전 턴이 교정·계속 진행 도중 끊겨 보존해 둔 미완료 보고(요약·쟁점·증거·요청 결정)를 이번 재개 결과에 병합합니다.", { pendingCorrectionMerged: true });
      }
    }
    let sessionId = setup.work.sessionId;
    let work: WorkBinding = setup.work;
    let state: WorkState;
    // 멈춘(paused) 결과가 열린 요청만 빼면 완료였고 그 뒤 결정이 올라왔으면 쓰기 턴을 다시 사지 않는다 — 읽기 전용 확인 턴(요청 해소 여부)으로
    // 간다. 결정이 REFIX 를 지시하면 저장 결과는 낡은 것이므로 쓰기 턴을 다시 연다. 미완료(in_progress·blocked)면 쓰기 턴이 남은 단계를 한다.
    if (recovered && recovered.checkpoint.phase === "paused" && seed.base && initialTurn) {
      const decisions = db.getTimeline(topicId, recovered.checkpoint.inputSequence)
        .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
      const completeApartFromRequests = completionVerdict(seed.base, { openRequests: [], decisionAfterRequest: false }).kind === "completed";
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
    // 2) 턴 — 실행기가 adapter 호출 전·spawn 직전에 허용 검사를 하고, 응답 수신 시 채택 검사를 한다.
    if (initialTurn) {
      const prompts = setup.prompts(seed.openRequests);
      const outcome = await this.core.executor.execute({
        role: "claude", topic, signal, purpose: "턴", inputSequence: setup.inputSequence, expected, write: true, writeGuards,
        session: sessionId
          ? { mode: "resume", sessionId, fallbackFresh: { prompt: prompts.fresh, onSessionCreated: setup.persistSession } }
          : { mode: "create", onSessionCreated: setup.persistSession },
        prompt: sessionId ? prompts.resume : prompts.fresh, implementation: true, readablePaths: setup.readablePaths,
        settings: this.core.executionSettings(topicId, "claude", true),
        // 세션 저장이 검증·채택 검사보다 먼저다 — 검증이 턴을 거부해도 세션이 남아야 재시도가 재구현 없이 resume 된다(2026-09-01 S1.1).
        onResponse: (outcome) => {
          if (outcome.created || outcome.sessionId !== sessionId) setup.persistSession(outcome.sessionId);
          db.updateTopic(topicId, { implementationPromptSequence: setup.inputSequence });
        },
      });
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
      const verdict = completionVerdict(state.base, { openRequests: state.openRequests, decisionAfterRequest: this.decisionAfter(topic, state.openRequests) });
      if (verdict.kind === "completed") {
        if (!freshlyVerified) {
          const reverified = await this.enforceTolerance({
            topicId, topic: db.getTopic(topicId), plan: setup.plan, result: state.base, sessionId, signal, inputSequence: setup.inputSequence,
            resumeState: setup.work.resumeState, check: setup.check, baselineHead: setup.baselineHead, readablePaths: setup.readablePaths,
            previousLedger: state.verifiedLedger, expected, writeGuards, openRequests: state.openRequests,
          });
          if (!reverified) {
            await this.core.checkpoints.record(topic, {
              work, phase: "paused", accumulated: state.base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
              openRequests: state.openRequests, confirmations: state.confirmations,
            }, signal);
            return;
          }
          // 재대조가 쓰기 교정을 열었을 수 있다 — 교정 응답은 요청·증거·원장까지 누적됐고 상태가 바뀌었을 수 있으므로 **다시 판정**한다(CF-02).
          const acc = accumulate(state.base, reverified, state.openRequests, setup.inputSequence);
          this.reportAccumulation(topicId, acc);
          state = { ...state, base: acc.result, openRequests: acc.openRequests, verifiedLedger: [...(reverified.toleranceLedger ?? [])] };
          freshlyVerified = true;
          await this.core.checkpoints.record(topic, {
            work, phase: "verified", accumulated: state.base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
            openRequests: state.openRequests, confirmations: state.confirmations,
          }, signal);
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
      await this.core.checkpoints.record(topic, {
        work, phase: "before-confirmation", accumulated: state.base, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
        openRequests: state.openRequests, confirmations: 1,
      }, signal);
      this.core.event(topicId, "system", "system", `완료 판정 보류 — ${verdict.message} 읽기 전용 확인 턴을 1회 엽니다.`, { confirmation: verdict.reason });
      const decisionsSince = state.openRequests.length
        ? db.getTimeline(topicId, Math.min(...state.openRequests.map((request) => request.askedAfterSequence)))
          .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && ["decision", "evidence"].includes(event.kind))
        : [];
      const confirmed = await this.core.executor.execute({
        role: "claude", topic, signal, purpose: "완료 확인", inputSequence: setup.inputSequence, expected, write: false,
        session: { mode: "resume", sessionId }, implementation: false, protocolOnly: true, readablePaths: setup.readablePaths,
        prompt: buildStatusConfirmationPrompt({ kind: setup.kind, reason: verdict.message, accumulated: state.base, planPath: setup.planPath, openRequests: state.openRequests, decisionsSince }),
        settings: { ...this.core.executionSettings(topicId, "claude", true), effort: "low" },
      });
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

  // 턴 응답 하나를 누적본에 흡수한다: turn-result checkpoint(raw) → 계약(교정 전 checkpoint) → 허용 오차(교정 전 checkpoint) → verified checkpoint.
  // 반환 null = 허용 오차 위반이 남아 정지했다(인터럽트·보존 완료).
  private async absorbTurn(
    setup: WorkSetup, work: WorkBinding, state: WorkSeed, raw: AgentResult, sessionId: string,
    expected: TurnExpectation, writeGuards: WriteGuards, signal: AbortSignal,
  ): Promise<WorkState | null> {
    const { topicId, topic } = setup;
    // 누적의 입력은 항상 **최신** 누적본이다 — 계약 교정·허용 오차 교정이 같은 normalizer 를 다시 부를 때 턴 시작 전 상태로 되돌아가면 앞 응답이
    // 낸 질문·해소가 사라진다(CF-04). 같은 응답을 두 번 누적해도 쟁점·증거는 합집합, 요청은 문구로 중복 제거되므로 멱등이다.
    let current: { base: AgentResult | null; openRequests: OpenRequest[] } = { base: state.base, openRequests: [...state.openRequests] };
    const salvaged = (value: unknown) => accumulate(current.base, salvageResultFields(value, setup.kind), current.openRequests, setup.inputSequence);
    const first = salvaged(raw);
    await this.core.checkpoints.record(topic, {
      work, phase: "turn-result", raw, accumulated: first.result, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
      openRequests: first.openRequests, confirmations: 0,
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
          inputSequence: setup.inputSequence, openRequests: acc.openRequests, confirmations: 0, pendingCorrection: "contract",
        }, signal);
      },
    });
    await this.assertBaselineIntact(topic, setup.baselineHead, "계약 교정 중");
    this.assertToolTreesIntact(topic, setup.toolTreesBefore, "계약 교정 중");
    const checked = await this.enforceTolerance({
      topicId, topic: this.core.dependencies.database.getTopic(topicId), plan: setup.plan, result: contracted, sessionId, signal,
      inputSequence: setup.inputSequence, resumeState: setup.work.resumeState, check: setup.check, baselineHead: setup.baselineHead,
      readablePaths: setup.readablePaths, normalize, previousLedger: state.verifiedLedger, expected, writeGuards, openRequests: state.openRequests,
      beforeCorrection: async (original) => {
        await this.core.checkpoints.record(topic, {
          work, phase: "before-tolerance-correction", raw: original, accumulated: original, verifiedLedger: state.verifiedLedger,
          inputSequence: setup.inputSequence, openRequests: latestRequests(), confirmations: 0, pendingCorrection: "tolerance",
        }, signal);
      },
    });
    if (!checked) {
      // 허용 오차 위반이 남아 정지했다 — 마지막 누적본을 보존한다(인터럽트는 enforceTolerance 가 했다).
      await this.core.checkpoints.record(topic, {
        work, phase: "paused", accumulated: contracted, verifiedLedger: state.verifiedLedger, inputSequence: setup.inputSequence,
        openRequests: latestRequests(), confirmations: 0,
      }, signal);
      return null;
    }
    await this.assertBaselineIntact(topic, setup.baselineHead, "허용 오차 교정 중");
    this.assertToolTreesIntact(topic, setup.toolTreesBefore, "허용 오차 교정 중");
    const acc = last as Accumulation | null;
    if (acc) this.reportAccumulation(topicId, acc);
    const next: WorkState = {
      base: checked, openRequests: latestRequests(), verifiedLedger: [...(checked.toleranceLedger ?? [])], confirmations: 0,
    };
    await this.core.checkpoints.record(topic, {
      work, phase: "verified", accumulated: next.base, verifiedLedger: next.verifiedLedger, inputSequence: setup.inputSequence,
      openRequests: next.openRequests, confirmations: 0,
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
    // 채택·전이 직전의 현재성 검사 — 저장하는 사이 새 결정·증거가 왔으면 결과는 보존됐지만 채택하지 않는다(CF-01). 재개는 수락 checkpoint 를
    // 보고 반영할 쓰기 턴을 연다.
    if (this.core.interruptForNewUserInput(topic, setup.inputSequence)) {
      this.core.event(topic.id, "system", "system", "수락 절차 도중 새 결정·증거가 도착해 채택·전이를 멈췄습니다(결과·산출물은 보존됨) — 재시도가 결정을 반영하는 턴을 엽니다.",
        { acceptInterrupted: accepting.revision });
      return;
    }
    await setup.onAccepted(acceptResult(base, verdict), accepting.revision);
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
      await this.core.checkpoints.record(topic, {
        work: checkpoint.work, phase: "accepted", accumulated: base, verifiedLedger: checkpoint.verifiedLedger, inputSequence: checkpoint.inputSequence,
        openRequests: checkpoint.openRequests, confirmations: checkpoint.confirmations, acceptId,
      }, signal);
    }
    await setup.onAccepted(acceptResult(base, verdict), acceptId);
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

  private adjudicatedFinalReviewIDs(topic: Topic): Set<string> {
    const events = this.core.dependencies.database.getTimeline(topic.id)
      .filter((event) => event.scopeGeneration === topic.scopeGeneration);
    const adjudicated = new Set<string>();
    for (let index = 0; index < events.length; index += 1) {
      const ids = events[index].payload?.finalReviewNewFindingIDs;
      if (!Array.isArray(ids)) continue;
      if (!events.slice(index + 1).some((later) => later.actor === "user" && later.kind === "decision")) continue;
      for (const id of ids) if (typeof id === "string") adjudicated.add(id);
    }
    return adjudicated;
  }

  async resumeDelivery(topicId: string, state: WorkflowState, signal: AbortSignal): Promise<void> {
    if (state === "IMPLEMENTING") return this.runImplementation(topicId, signal);
    if (state === "CODEX_REVIEW") {
      if (await this.openFixFromStoredReview(topicId, false, signal)) return;
      return this.runReview(topicId, signal, false);
    }
    if (state === "CLAUDE_FIX") {
      // 2차 패스(첫 패스 소비 뒤)는 최종 리뷰 결과를 고친다.
      const kind = this.core.dependencies.database.getFlags(topicId).fixPassUsed ? "codex-final-review" : "codex-review";
      const review = await this.core.latestResult(topicId, kind);
      // 수정 턴이 멈춘 뒤 결정이 올라왔으면 저장된 수정 결과를 재사용한다(수정 턴 재구매 방지) — 단, 논리 작업의 checkpoint 가 있으면
      // runWork 가 거기서 복구하므로 옛 산출물 경로는 쓰지 않는다.
      const flags = this.core.dependencies.database.getFlags(topicId);
      const topic = this.core.dependencies.database.getTopic(topicId);
      const hasCheckpoint = flags.implementationSessionId
        ? await this.core.checkpoints.recoverFor(topicId, this.core.checkpoints.binding(topic, "FIX", flags.implementationSessionId, this.fixSource(topicId, flags.fixPassUsed))).then((r) => r !== null).catch(() => true)
        : false;
      if (!hasCheckpoint && await this.finishStoredFix(topicId, review, kind, signal)) return;
      return this.runFix(topicId, signal, review);
    }
    if (state === "CODEX_FINAL_REVIEW") {
      // 가드로 멈춘 최종 리뷰가 그 뒤의 사용자 결정으로 통과 조건을 만족하면 Codex 턴을 다시 사지 않는다.
      if (await this.finalizeStoredFinalReview(topicId)) return;
      // 확정 결함이 남은 채 결정이 올라왔으면 저장된 리뷰의 finding 을 바로 수정으로 보낸다(리뷰 재구매 방지, Codex 피드백 ②).
      if (await this.openFixFromStoredReview(topicId, true, signal)) return;
      return this.runReview(topicId, signal, true);
    }
    throw new Error(`지원하지 않는 재개 단계입니다: ${state}`);
  }

  private async runReview(topicId: string, signal: AbortSignal, finalPass: boolean): Promise<void> {
    let topic = this.core.dependencies.database.getTopic(topicId);
    const expected = finalPass ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW";
    this.core.requireState(topicId, expected);
    const plan = await this.core.requireStoredPlan(topicId);
    const implementation = await this.core.latestResult(topicId, finalPass ? "claude-fix" : "implementation-result");
    const originalReview = finalPass ? await this.core.latestResult(topicId, "codex-review") : null;
    const reviewedSnapshot = await this.core.dependencies.git.snapshot(topic.worktreePath);
    // 리뷰 시점 작업 트리를 객체로 남긴다 — 최종 리뷰가 '직전 리뷰 이후 변경분' 만 다시 보게 하는 근거(Codex 피드백 ①).
    const previousFlags = this.core.dependencies.database.getFlags(topicId);
    const reviewedTree = await this.core.dependencies.git.writeWorkingTree(topic.worktreePath, `${topicId.slice(0, 8)}-${finalPass ? "final" : "first"}`)
      .catch(() => null);
    const reviewSessionId = this.core.dependencies.database.getCodexReviewSession(topicId);
    const resumedSession = reviewSessionId !== null;
    // 동일한 tree도 확인된 결과다. 세션이나 snapshot이 없으면 전체 리뷰로 돌아간다.
    const deltaSinceLastReview = finalPass && resumedSession && previousFlags.reviewedTreeOID && reviewedTree
      ? previousFlags.reviewedTreeOID === reviewedTree
        ? { files: [], patch: "" }
        : await this.core.dependencies.git.diffTrees(topic.worktreePath, previousFlags.reviewedTreeOID, reviewedTree).catch(() => null)
      : null;
    // 재개 세션에는 직전 리뷰 턴 이후의 결정·증거만 싣는다(2026-09-08 Codex 제안 ⑥). 값은 턴이 돌아온 뒤에 적는다.
    const reviewInputSequence = this.core.latestSequence(topicId);
    const reviewSince = resumedSession ? (this.core.dependencies.database.getCodexReviewPromptSequence(topicId) ?? 0) : 0;
    const planPath = await this.core.dependencies.artifacts.verifiedPath(topicId, "plan");
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
    // 구현/수정 결과의 settled 쟁점(주로 TODO-n 이연)과 첫 리뷰의 no-action 쟁점은 서버가 승계한다. RESOLVED_BY_FIX 주장은 승계하지 않는다(리뷰가 판정).
    // 두 원본은 **최신(수정 결과) 우선으로 합친 뒤** 승계를 판단한다 — 따로 승계하면 첫 리뷰의 AGREED_NO_ACTION 이 수정 결과의
    // AGREED_ACTION·RESOLVED_BY_FIX 를 덮어 누락된 쟁점이 검사를 통과한다(2026-09-13 Codex 지적 1).
    const reviewLabel = finalPass ? "Codex final review" : "Codex review";
    const reviewNormalizer = this.core.carryForwardNormalizer(
      mergeFindingSources(implementation.findings, originalReview?.findings), reviewLabel, { forReview: true });
    let review = await this.core.turn("codex", topic, buildCodexReviewPrompt({
      planMarkdown: plan, planSHA256: topic.planSHA256!, implementation, finalPass, resumedSession, tolerance, planPath,
      timeline: this.reviewTimeline(topicId, topic.scopeGeneration, reviewSince),
      planningFindings: closeout?.planSHA256 === topic.planSHA256 ? closeout.findings : undefined,
      planningEvidenceRefs: closeout?.planSHA256 === topic.planSHA256 ? closeout.evidenceRefs : undefined,
      originalReviewFindings: originalReview?.findings,
      deltaSinceLastReview, verificationReceipts: receipts?.text,
    }), signal, false, {
      readablePaths: [planPath, ...(receipts?.readablePaths ?? [])],
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
    await this.core.saveAgentOutput(topic, "codex", review, finalPass ? "codex-final-review" : "codex-review", signal);
    if (this.core.interruptForLatestTurnInput(topic)) return;
    if (this.core.pauseForResult(topicId, review, expected, "코드 리뷰 결과에 사용자 결정이 필요합니다.")) {
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
        [...implementation.findings, ...(originalReview?.findings ?? [])].map((finding) => [finding.id, finding]),
      ).values()];
      // 사용자 결정이 이미 소비한 신규 쟁점은 다시 사용자에게 보내지 않는다. 인터럽트 이벤트에 실린
      // ID 목록과 그 뒤에 도착한 사용자 결정의 짝으로만 판정하므로, 결정 없는 재실행(인프라 재시도)은
      // 여전히 인터럽트된다 — 조용한 종결은 불가능하다(2026-09-01 S1.1 R4 무변경 fix 패스 루프의 프로그램적 방지).
      const adjudicated = this.adjudicatedFinalReviewIDs(topic);
      const addedIDs = new Set(newFindingIDs(knownFindings, review.findings, "Codex final review").filter((id) => !adjudicated.has(id)));
      const added = review.findings.filter((finding) => addedIDs.has(finding.id));
      // 새 쟁점은 발견 시점이 아니라 처분으로 분류한다(2026-09-07 Codex 피드백 ④): 범위 밖은 후속 목록에 기록만,
      // 확정 결함(AGREED_ACTION)은 남은 수정 회차에서 바로 수정, 결정이 필요하거나 처분이 없거나 수정 없이 닫힌
      // (RESOLVED_BY_FIX — 고칠 기회가 없었다) 쟁점만 사용자에게 보낸다.
      const deferredNew = added.filter((finding) =>
        finding.disposition === "DEFERRED_OUT_OF_SCOPE" || finding.disposition === "AGREED_NO_ACTION");
      if (deferredNew.length > 0) await this.core.recordDeferredFindings(topic, deferredNew, "final-review", signal);
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
      const overruled = originalReview ? this.userOverruledFindings(topic, "codex-review", originalReview.findings) : new Set<string>();
      this.noteOverruled(topicId, overruled, originalReview?.findings ?? [], review.findings);
      const withdrawn = originalReview ? dispositionRegressions(originalReview.findings, review.findings, overruled) : [];
      if (withdrawn.length > 0) {
        this.core.interrupt(
          topicId,
          "USER_DECISION_REQUIRED",
          `최종 리뷰가 첫 리뷰에서 고치기로 합의한 쟁점을 수정 확인 없이 닫았습니다(${withdrawn.join(", ")}). 전달 준비로 넘기지 않았습니다.`,
          expected,
        );
        return;
      }
      if (shouldRunFixPass(review.findings)) {
        const flags = this.core.dependencies.database.getFlags(topicId);
        const remaining = review.findings
          .filter((finding) => finding.disposition === "AGREED_ACTION").map((finding) => finding.id);
        // 남은 수정 회차 안에서는 결정 없이 바로 고친다(2026-09-07 Codex 피드백 ④ — 종전엔 2차도 사용자 결정 뒤에만 열렸다).
        // 회차를 다 썼으면 최신 코드와 남은 필수 쟁점을 보존한 채 한 번 결정받고, 그 결정이 추가 회차 1회를 연다(runFix 의 해제 규칙).
        if (!flags.secondFixPassUsed || this.userDecisionAfterLastFixInterrupt(topic)) {
          this.core.transition(topicId, "CLAUDE_FIX",
            flags.secondFixPassUsed ? "사용자 결정으로 추가 수정 회차를 열어 남은 확정 결함을 수정합니다." : "남은 확정 결함을 2차 자동 수정으로 바로 고칩니다.");
          await this.runFix(topicId, signal, review);
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
        this.markReady(topicId, reviewedSnapshot, "최종 읽기 전용 리뷰를 통과했습니다.");
      }
      return;
    }
    if (!shouldRunFixPass(review.findings)) {
      this.markReady(topicId, reviewedSnapshot, "구현 리뷰에서 수정할 확정 결함이 없습니다.");
      return;
    }
    if (this.core.dependencies.database.getFlags(topicId).fixPassUsed) {
      this.core.interrupt(topicId, "USER_DECISION_REQUIRED", "자동 수정 횟수를 이미 사용했습니다.", expected);
      return;
    }
    topic = this.core.transition(topicId, "CLAUDE_FIX", "Claude가 합의된 결함을 한 번 수정합니다.");
    await this.runFix(topicId, signal, review);
  }

  // 사용자 결정이 뒤집은 쟁점: 원본 리뷰(그 finding 을 낸 codex 산출물, revision = 타임라인 sequence)보다 뒤에 올라온
  // 사용자 decision 본문이 finding id 를 통째로 적으면 그 쟁점의 하향 처분을 허용한다. 사용자만 뒤집을 수 있다는
  // 가드의 성질은 그대로다 — 에이전트 출력·note 는 세지 않는다(2026-09-07, 네 번의 sqlite 우회 대체).
  private userOverruledFindings(topic: Topic, sourceKind: string, findings: readonly Finding[]): Set<string> {
    const source = this.core.dependencies.database.latestArtifact(topic.id, sourceKind);
    const decisions = this.core.dependencies.database.getTimeline(topic.id, source?.revision ?? 0)
      .filter((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    const overruled = new Set<string>();
    for (const finding of findings) {
      const escaped = finding.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const token = new RegExp(`(^|[^A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`);
      if (decisions.some((event) => token.test(event.body))) overruled.add(finding.id);
    }
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
    const implementationKind = finalPass ? "claude-fix" : "implementation-result";
    const implementation = database.latestArtifact(topicId, implementationKind);
    if (!stored || !implementation || stored.revision <= implementation.revision) return false;
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
    this.core.event(topicId, "system", "system",
      `결정이 올라온 저장된 ${finalPass ? "최종 " : ""}리뷰(#${stored.revision})의 확정 결함을 바로 수정으로 보냅니다 — 리뷰를 다시 사지 않습니다.`);
    this.core.transition(topicId, "CLAUDE_FIX", "Claude가 합의된 결함을 수정합니다.");
    await this.runFix(topicId, signal, review);
    return true;
  }

  // 가드로 멈춘 최종 리뷰를 사용자 결정 뒤에 재사용한다: 저장된 최종 리뷰가 현재 수정 결과보다 뒤이고, 리뷰가 본
  // 스냅샷이 지금 worktree 와 같고, 결정을 반영한 가드가 전부 통과하면 Codex 턴 없이 전달 준비로 넘긴다.
  // 하나라도 어긋나면 false — 호출자가 리뷰를 다시 돌린다.
  private async finalizeStoredFinalReview(topicId: string): Promise<boolean> {
    const database = this.core.dependencies.database;
    const topic = this.core.requireState(topicId, "CODEX_FINAL_REVIEW");
    const stored = database.latestArtifact(topicId, "codex-final-review");
    const fix = database.latestArtifact(topicId, "claude-fix");
    if (!stored || !fix || stored.revision <= fix.revision) return false;
    const flags = database.getFlags(topicId);
    if (!flags.reviewedHead || !flags.reviewedDiffSHA256) return false;
    const current = await this.core.dependencies.git.snapshot(topic.worktreePath);
    if (current.head !== flags.reviewedHead || current.diffSHA256 !== flags.reviewedDiffSHA256) return false;
    const review = await this.core.latestResult(topicId, "codex-final-review");
    const fixResult = await this.core.latestResult(topicId, "claude-fix");
    const originalReview = await this.core.latestResult(topicId, "codex-review");
    if (review.findings.some((finding) => !finding.disposition || finding.disposition === "EXTERNAL_EVIDENCE")) return false;
    const decisionsAfter = database.getTimeline(topicId, stored.revision)
      .some((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    if (!decisionsAfter) return false;
    const knownFindings = [...new Map(
      [...fixResult.findings, ...originalReview.findings].map((finding) => [finding.id, finding]),
    ).values()];
    const adjudicated = this.adjudicatedFinalReviewIDs(topic);
    if (newFindingIDs(knownFindings, review.findings, "Codex final review").some((id) => !adjudicated.has(id))) return false;
    const overruled = this.userOverruledFindings(topic, "codex-review", originalReview.findings);
    if (dispositionRegressions(originalReview.findings, review.findings, overruled).length > 0) return false;
    if (shouldRunFixPass(review.findings)) return false;
    this.noteOverruled(topicId, overruled, originalReview.findings, review.findings);
    this.core.event(topicId, "system", "system",
      `저장된 최종 리뷰(#${stored.revision})가 사용자 결정으로 통과 조건을 만족해 Codex 턴 없이 전달 준비로 넘깁니다.`);
    this.markReady(topicId, current, "최종 읽기 전용 리뷰를 통과했습니다(저장된 리뷰 재사용).");
    return true;
  }

  // 계획의 탐색·왕복 보고는 제외한다. 사용자 제약·결정·외부 증거는 오래된 note도 남기며,
  // 구현·수정 보고와 첫 리뷰 findings는 프롬프트의 전용 항목으로 전달한다.
  private reviewTimeline(topicId: string, scopeGeneration: number, afterSequence = 0): TimelineEvent[] {
    return this.core.dependencies.database.getScopedTimeline(topicId, scopeGeneration, afterSequence).filter((event) =>
      ["scope_change", "evidence", "decision"].includes(event.kind) || (event.actor === "user" && event.kind === "note"));
  }

  private async runFix(topicId: string, signal: AbortSignal, review: AgentResult): Promise<void> {
    const topic = this.core.requireState(topicId, "CLAUDE_FIX");
    const flags = this.core.dependencies.database.getFlags(topicId);
    if (flags.fixPassUsed && flags.secondFixPassUsed && !this.userDecisionAfterLastFixInterrupt(topic)) {
      throw new Error("Claude 자동 수정은 두 번까지만 허용됩니다. 결정을 올리고 재시도하면 추가 회차 1회가 열립니다.");
    }
    // 2차 패스는 최종 리뷰 잔여 결함에 사용자 결정이 붙은 뒤에만 열린다(runReview 가 판정). 회차는 시작이 아니라
    // **완주(최종 리뷰로 전이) 시점에 소비**한다 — 시작 시 소비하면 컨텍스트 한도 같은 일시 실패 뒤 retry 가 에이전트를
    // 부르지도 않고 "두 번까지만" 에 막힌다(2026-09-07 S7 #158 실측, Codex 제안 ①).
    const secondPass = flags.fixPassUsed;
    if (!flags.implementationSessionId) throw new Error("Claude 구현 세션을 찾을 수 없습니다.");
    const plan = await this.core.requireStoredPlan(topicId);
    if (!topic.branchName) throw new Error("수정할 작업 브랜치가 없습니다.");
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName);
    const baselineHead = await this.requirePinnedBaseline(topicId, topic.worktreePath);
    const inputSequence = this.core.latestSequence(topicId);
    const planPath = await this.core.dependencies.artifacts.verifiedPath(topicId, "plan");
    const decisionsPath = await this.writeDecisionsDigest(topic, signal);
    const fixReadable = [planPath, decisionsPath];
    const toolTreesBefore = await this.toolTreeBaseline(topic, signal);
    this.assertToolTreesIntact(topic, toolTreesBefore, "수정 재개 전");
    const fixBase = { planMarkdown: plan, planSHA256: topic.planSHA256, reviewFindings: review.findings, planPath, decisionsPath };
    const check = (r: AgentResult) => {
      this.core.assertKind(r, "FIX");
      assertFindingCoverage(review.findings, r.findings, "Claude fix");
      assertDispositionsResolved(review.findings, r, "Claude fix");
    };
    await this.runWork({
      topicId, topic, kind: "FIX", work: this.core.checkpoints.binding(topic, "FIX", flags.implementationSessionId, this.fixSource(topicId, secondPass)),
      plan, planPath, readablePaths: fixReadable, baselineHead, toolTreesBefore, inputSequence, check,
      // 판단이 끝난 리뷰 쟁점은 서버가 승계한다 — 러너가 되돌려 담지 않아도 재제출을 사지 않는다(2026-09-13).
      carry: this.core.carryForwardNormalizer(review.findings, "Claude fix"),
      progressKind: "fix-progress", resultKind: "claude-fix", deferredSource: "fix",
      pauseFallbackMessage: "수정 범위를 넓히려면 사용자 결정이 필요합니다.",
      prompts: (openRequests) => ({
        fresh: buildClaudeFixPrompt({ ...fixBase, openRequests, timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration) }),
        resume: buildClaudeFixPrompt({
          ...fixBase, openRequests, resumedSession: true,
          timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, flags.implementationPromptSequence ?? 0),
        }),
      }),
      sessionId: flags.implementationSessionId,
      persistSession: (sessionId) => this.core.dependencies.database.setImplementationSession(topicId, sessionId),
      initialTurn: true,
      legacyBase: async () => ({ base: await this.legacyPendingOriginal(topicId, topic, "CLAUDE_FIX"), ledger: await this.legacyAcceptedLedger(topicId) }),
      onAccepted: async (accepted) => { await this.finishFix(topicId, topic, review, accepted, secondPass, signal); },
    }, signal);
  }

  // 수정 작업의 원본 리뷰 식별자(종류#산출물 revision) — 논리 작업 id 의 일부. 회차 번호가 아니라 실제 리뷰 산출물이라 사용자 승인으로 연 3차 수정도
  // 2차와 다른 작업이다(CF-03: 회차 번호는 2차·3차가 같아 완료 기록을 재사용했다).
  private fixSource(topicId: string, secondPass: boolean): string {
    const kind = secondPass ? "codex-final-review" : "codex-review";
    return `${kind}#${this.core.dependencies.database.latestArtifact(topicId, kind)?.revision ?? 0}`;
  }

  // 수정 결과가 확정된 뒤의 공통 꼬리: 되돌림 가드(결정으로 뒤집힌 쟁점 제외) → 회차 소비 + 최종 리뷰 전이(한 트랜잭션) → 최종 리뷰.
  // AcceptedResult 만 받는다 — 완료 판정을 거치지 않은 결과는 타입이 막는다.
  private async finishFix(
    topicId: string, topic: Topic, review: AgentResult, fixResult: AcceptedResult, secondPass: boolean, signal: AbortSignal,
  ): Promise<void> {
    const overruled = this.userOverruledFindings(topic, secondPass ? "codex-final-review" : "codex-review", review.findings);
    this.noteOverruled(topicId, overruled, review.findings, fixResult.findings);
    const downgraded = dispositionRegressions(review.findings, fixResult.findings, overruled);
    if (downgraded.length > 0) {
      this.core.interrupt(
        topicId,
        "USER_DECISION_REQUIRED",
        `수정 단계가 고치기로 합의한 쟁점의 처분을 되돌렸습니다(${downgraded.join(", ")}). 최종 리뷰로 넘기지 않았습니다.`,
        "CLAUDE_FIX",
      );
      return;
    }
    // 회차 소비와 상태 전이는 한 트랜잭션이다 — 그 사이에서 종료되면 회차만 소비되거나 전이만 된 채 남는다(PLAN §2 검증 조건 3).
    const current = this.core.dependencies.database.getTopic(topicId);
    assertTransition(current.state, "CODEX_FINAL_REVIEW");
    this.core.dependencies.database.applyTopicTransition({
      topicId,
      changes: { ...(secondPass ? { secondFixPassUsed: true } : { fixPassUsed: true }), state: "CODEX_FINAL_REVIEW", lastError: null, resumeState: null },
      events: [{ actor: "system", kind: "system", state: "CODEX_FINAL_REVIEW", body: "Codex가 수정 결과를 마지막으로 검토합니다.",
        payload: { from: current.state, to: "CODEX_FINAL_REVIEW", fixPassConsumed: secondPass ? 2 : 1 } }],
    });
    await this.runReview(topicId, signal, true);
  }

  // 멈춘 수정 결과 재사용(2026-09-07, 계획·최종 리뷰 재사용과 같은 계열): 저장된 claude-fix 가 지금 고치는 리뷰보다 뒤이고, 그 뒤 사용자 decision 이 있고,
  // 그 결과가 수정 계약(kind·쟁점 커버·처분 해소)을 만족하고 **완료 판정을 통과**하면 수정 턴을 다시 사지 않는다. 완료 판정이 "상태 확인 필요"
  // (status 없음·모순)면 읽기 전용 확인 턴 1회를 거친다(PLAN §3 기존 결과 보존 후 확인). 하나라도 어긋나면 false — 호출자가 수정 턴을 돈다.
  // 논리 작업의 checkpoint 가 있으면 이 경로를 쓰지 않는다(runWork 가 checkpoint 에서 복구한다).
  private async finishStoredFix(topicId: string, review: AgentResult, reviewKind: string, signal: AbortSignal): Promise<boolean> {
    const database = this.core.dependencies.database;
    const topic = this.core.requireState(topicId, "CLAUDE_FIX");
    const flags = database.getFlags(topicId);
    if (flags.fixPassUsed && flags.secondFixPassUsed && !this.userDecisionAfterLastFixInterrupt(topic)) return false;
    const storedFix = database.latestArtifact(topicId, "claude-fix");
    const storedReview = database.latestArtifact(topicId, reviewKind);
    if (!storedFix || !storedReview || storedFix.revision <= storedReview.revision) return false;
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
    // 저장된 결과도 같은 승계 규칙으로 본다 — 되돌려 담지 않은 settled 쟁점 때문에 재사용을 포기하지 않는다.
    const fixResult = { ...storedResult, findings: carryForwardFindings(review.findings, storedResult.findings).findings };
    try {
      this.core.assertKind(fixResult, "FIX");
      assertFindingCoverage(review.findings, fixResult.findings, "Claude fix");
      assertDispositionsResolved(review.findings, fixResult, "Claude fix");
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
    const secondPass = flags.fixPassUsed;
    const plan = await this.core.requireStoredPlan(topicId);
    const planPath = await this.core.dependencies.artifacts.verifiedPath(topicId, "plan");
    const toolTreesBefore = await this.toolTreeBaseline(topic, signal);
    this.core.event(topicId, "system", "system",
      verdict.kind === "completed"
        ? `결정이 올라온 저장된 수정 결과(#${storedFix.revision})를 재사용해 최종 리뷰로 넘깁니다 — 수정 턴을 다시 사지 않습니다.`
        : `결정이 올라온 저장된 수정 결과(#${storedFix.revision})의 완료 상태가 불명확합니다(${verdict.message}) — 읽기 전용 확인 턴 1회로 확인합니다.`);
    // 완료 판정 루프만 돈다(initialTurn=false): 완료면 수락, 확인 필요면 읽기 전용 확인 1회, 그래도 불명확하면 보존한 채 멈춘다.
    await this.runWork({
      topicId, topic, kind: "FIX", work: this.core.checkpoints.binding(topic, "FIX", flags.implementationSessionId, this.fixSource(topicId, secondPass)),
      plan, planPath, readablePaths: [planPath], baselineHead, toolTreesBefore, inputSequence: this.core.latestSequence(topicId),
      check: (r) => { this.core.assertKind(r, "FIX"); assertFindingCoverage(review.findings, r.findings, "Claude fix"); assertDispositionsResolved(review.findings, r, "Claude fix"); },
      carry: this.core.carryForwardNormalizer(review.findings, "Claude fix"),
      progressKind: "fix-progress", resultKind: "claude-fix", deferredSource: "fix",
      pauseFallbackMessage: "수정 범위를 넓히려면 사용자 결정이 필요합니다.",
      prompts: () => ({ fresh: "", resume: "" }),
      sessionId: flags.implementationSessionId, persistSession: () => undefined, initialTurn: false,
      legacyBase: async () => ({ base: fixResult, ledger: [...(fixResult.toleranceLedger ?? [])] }),
      onAccepted: async (accepted) => { await this.finishFix(topicId, topic, review, accepted, secondPass, signal); },
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

  // 반환: 위반이 남아 사용자 결정으로 멈췄으면 null, 아니면 (1회 교정을 거쳤을 수 있는) 결과.
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
  }): Promise<AgentResult | null> {
    const policy = parseTolerancePolicy(input.plan);
    if (!policy) return input.result;
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
        readablePaths: input.readablePaths, normalize: mergeNormalizer, writeGuards: input.writeGuards,
      });
      if (preservedParts.length > 0) {
        this.core.event(input.topicId, "system", "system",
          `허용 오차 교정 재제출에 본 턴 보고를 병합했습니다(서버 보존): ${preservedParts.join(" · ")}`, { correctionPreserved: preservedParts });
      }
      // 계약 교정이 한 번 더 돌았을 수 있다 — 그 호출도 커밋을 만들 수 있으므로 다시 본다(Codex 후속 지적 1).
      await this.assertBaselineIntact(input.topic, input.baselineHead, "허용 오차 교정 뒤 계약 교정 중");
      ({ result, evaluation } = await evaluateWithCarry(contracted));
      if (evaluation.violations.length > 0) {
        this.core.interrupt(input.topicId, "USER_DECISION_REQUIRED",
          `교정 뒤에도 허용 오차 위반이 남았습니다 — 되돌릴지, 규칙을 넓힐지(계획 개정) 결정이 필요합니다.\n${renderToleranceSummary(evaluation)}`,
          input.resumeState, { toleranceViolations: evaluation.violations });
        return null;
      }
    }
    this.core.event(input.topicId, "system", "system", renderToleranceSummary(evaluation), { toleranceUsage: evaluation.usage });
    return result;
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
  ): void {
    this.core.dependencies.database.updateTopic(topicId, {
      reviewedHead: snapshot.head,
      reviewedDiffSHA256: snapshot.diffSHA256,
      committedOID: null,
      pushedOID: null,
    });
    this.core.transition(topicId, "READY_TO_DELIVER", message);
    void this.announceDeferredForDelivery(topicId);
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

  async commit(topicId: string, message: string, paths: string[]): Promise<string> {
    return this.withDeliveryLock(topicId, async (topic) => {
      if (!topic.branchName) throw new Error("커밋할 작업 브랜치가 없습니다.");
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.reviewedHead || !flags.reviewedDiffSHA256) throw new Error("최종 리뷰가 확인한 변경 스냅샷이 없습니다.");
      // stage와 사후 검증이 같은 정규화 결과를 봐야 한다. 다르면 커밋은 남고 기록은 없는 고아 커밋이 생긴다.
      const selectedPaths = normalizeCommitPaths(topic.worktreePath, paths);
      const current = await this.core.dependencies.git.snapshot(topic.worktreePath);
      if (current.head !== flags.reviewedHead || current.diffSHA256 !== flags.reviewedDiffSHA256) {
        throw new Error("최종 리뷰 뒤 worktree가 바뀌었습니다. 다시 리뷰해야 커밋할 수 있습니다.");
      }
      const oid = await this.core.dependencies.git.commit(topic.worktreePath, topic.branchName, message, paths);
      this.assertDeliverySnapshot(topic);
      if (await this.core.dependencies.git.commitParent(topic.worktreePath, oid) !== flags.reviewedHead) {
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
      this.core.event(topicId, "user", "decision", "선택한 변경을 커밋했습니다.", { oid, paths });
      return oid;
    });
  }

  async push(topicId: string): Promise<string> {
    return this.withDeliveryLock(topicId, async (topic) => {
      if (!topic.branchName) throw new Error("push할 작업 브랜치가 없습니다.");
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.committedOID) throw new Error("Consensus Room에서 확정한 커밋이 없습니다.");
      if (await this.core.dependencies.git.head(topic.worktreePath) !== flags.committedOID) {
        throw new Error("확정한 커밋 뒤 HEAD가 바뀌어 push를 중단했습니다.");
      }
      const oid = await this.core.dependencies.git.push(topic.worktreePath, topic.branchName);
      this.assertDeliverySnapshot(topic);
      this.core.dependencies.database.updateTopic(topicId, { pushedOID: oid });
      this.core.event(topicId, "user", "decision", "작업 브랜치를 원격 저장소에 push했습니다.", { oid, branchName: topic.branchName });
      return oid;
    });
  }

  // 사후 검증으로 거부한 커밋은 이 경로에서만, 되돌려도 안전하다는 것을 전부 확인한 뒤에 되돌린다.
  async discardOrphanCommit(topicId: string): Promise<Topic> {
    return this.withDeliveryLock(topicId, async (topic) => {
      const flags = this.core.dependencies.database.getFlags(topicId);
      if (!flags.orphanCommitOID) throw new Error("되돌릴 로컬 커밋이 원장에 기록되어 있지 않습니다.");
      if (flags.committedOID) throw new Error("이미 확정한 커밋이 있어 되돌리지 않았습니다.");
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
      if (head !== flags.orphanCommitOID) {
        // update-ref는 됐는데 index 재정렬 전에 중단된 되돌리기가 남긴 상태다. HEAD가 이미 부모를
        // 가리키면 index만 마저 맞추고 끝낸다 — 여기서 막으면 반쪽 상태에서 커밋·닫기까지 전부 봉쇄된다.
        if (head === restoredHead) {
          this.assertDeliverySnapshot(topic);
          await this.core.dependencies.git.resyncIndex(topic.worktreePath, topic.branchName);
          this.core.dependencies.database.updateTopic(topicId, { orphanCommitOID: null });
          this.core.event(topicId, "user", "decision", "중단됐던 되돌리기를 마저 끝냈습니다. 파일 변경은 그대로 남았습니다.", {
            discardedCommitOID: flags.orphanCommitOID,
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
        discardedCommitOID: flags.orphanCommitOID,
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
        if (head === flags.reviewedHead) throw new Error("현재 HEAD는 커밋 전 리뷰 기준과 같아 커밋 성공이 아닙니다.");
        if (await this.core.dependencies.git.commitParent(topic.worktreePath, head) !== flags.reviewedHead) {
          throw new Error("현재 커밋의 부모가 리뷰 기준 HEAD와 다릅니다.");
        }
        const reviewedContent = await this.core.dependencies.git.snapshot(topic.worktreePath, flags.reviewedHead);
        if (reviewedContent.diffSHA256 !== flags.reviewedDiffSHA256) {
          throw new Error("현재 파일 내용이 최종 리뷰가 확인한 변경과 다릅니다.");
        }
        const request = DeliveryInputSchema.parse(recovery.request);
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

  private async withDeliveryLock<T>(topicId: string, work: (topic: Topic) => Promise<T>): Promise<T> {
    this.core.assertNoMaintenanceLock();
    if (this.core.active.has(topicId) || this.core.scopeChangeActive.has(topicId) || this.core.deliveryActive.has(topicId)) {
      throw new Error("이 주제에서 다른 작업이 진행 중입니다.");
    }
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
