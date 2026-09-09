// 구현·리뷰·전달 파이프라인: IMPLEMENTING → CODEX_REVIEW → (CLAUDE_FIX → CODEX_FINAL_REVIEW) →
// READY_TO_DELIVER → commit/push. git 사후 검증(고아 커밋 처분 포함)이 이 파일의 계약이다.
import {
  DeliveryInputSchema, type AgentResult, type Finding, type TimelineEvent, type Topic, type WorkflowState,
} from "../../shared/contracts.js";
import {
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
  shouldRunFixPass,
} from "../../shared/workflow.js";
import { normalizeCommitPaths } from "../git.js";
import { redactAgentResult } from "../security.js";
import {
  evaluateTolerance, parseTolerancePolicy, parseUnifiedDiff, renderToleranceSummary, type ChangedFile,
} from "../../shared/tolerance.js";
import type { EngineCore } from "./core.js";

function renderReport(result: AgentResult): string {
  return `# ${result.kind}\n\n${result.summary}\n\n## Findings\n\n\`\`\`json\n${JSON.stringify(result.findings, null, 2)}\n\`\`\`\n\n## Evidence\n\n${result.evidenceRefs.map((item) => `- ${item}`).join("\n") || "- 없음"}\n`;
}

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
    const promptBase = {
      planMarkdown: plan, planSHA256: topic.planSHA256!, worktreePath: topic.worktreePath, branchName: topic.branchName!, planPath,
    };
    // 이어지는 턴은 계획 본문과 이미 받은 이벤트를 다시 싣지 않는다(2026-09-08 Codex 제안 ⑥). 세션 유실로 새 세션이 되면
    // resumeImplementationSession 이 전문 프롬프트로 바꿔 쓴다. '전달한 sequence' 는 턴이 실제로 돌아온 뒤에만 적는다 —
    // 429 로 끊긴 턴이 못 본 이벤트를 다음 retry 가 다시 싣게 하기 위해서다.
    const prompts = {
      fresh: buildImplementationPrompt({
        ...promptBase, timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration),
      }),
      resume: buildImplementationPrompt({
        ...promptBase, resumedSession: true,
        timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, sessionFlags.implementationPromptSequence ?? 0),
      }),
    };
    const fork = existingImplementationSession
      ? await this.resumeImplementationSession(topicId, existingImplementationSession, prompts, topic.worktreePath, signal, [planPath])
      : await this.createFreshImplementationSession(topicId, prompts.fresh, topic.worktreePath, signal, [planPath]);
    this.core.assertCurrent(topicId, signal, topic.scopeGeneration, "IMPLEMENTING");
    // 세션 저장이 검증보다 먼저다 — 검증이 턴을 거부해도 세션이 남아야 재시도가 재구현 없이 resume된다
    // (2026-09-01 S1.1: 저장 전에 거부돼 수동 DB 복구가 필요했던 사건의 프로그램적 방지).
    this.core.dependencies.database.setImplementationSession(topicId, fork.sessionId);
    this.core.dependencies.database.updateTopic(topicId, { implementationPromptSequence: inputSequence });
    let implementationResult = await this.core.enforceResultContract("claude", topic, fork.result, fork.sessionId, {
      signal, implementation: true, planMode: false, startedAfter: inputSequence,
      check: (r) => this.core.assertKind(r, "IMPLEMENTATION"), readablePaths: [planPath],
    });
    await this.assertBaselineIntact(topic, baselineHead, "구현 중");
    const toleranceChecked = await this.enforceTolerance({
      topicId, topic: this.core.dependencies.database.getTopic(topicId), plan, result: implementationResult, sessionId: fork.sessionId,
      signal, inputSequence, resumeState: "IMPLEMENTING", check: (r) => this.core.assertKind(r, "IMPLEMENTATION"), baselineHead,
      readablePaths: [planPath],
    });
    if (!toleranceChecked) return;
    implementationResult = toleranceChecked;
    // 코드를 바꿀 수 있는 마지막 호출(허용 오차 교정 → 계약 교정) 뒤에 다시 본다 — 검사가 마지막 호출보다 먼저 끝나면 뚫린다(Codex 후속 지적 1).
    await this.assertBaselineIntact(topic, baselineHead, "구현 교정 중");
    // 러너가 범위 밖으로 판정해 to-do 로 남긴 쟁점(DEFERRED_OUT_OF_SCOPE)은 후속 목록에 올린다 — 인도 전 사용자가 처분한다.
    await this.core.recordDeferredFindings(topic,
      implementationResult.findings.filter((finding) => finding.disposition === "DEFERRED_OUT_OF_SCOPE"), "implementation", signal);
    if (await this.core.interruptPreservingResult(topic, "claude", implementationResult, inputSequence, signal)) return;
    await this.core.writeArtifact(topic, "implementation", 1, renderReport(implementationResult), signal);
    await this.core.saveAgentOutput(topic, "claude", implementationResult, "implementation-result", signal);
    if (this.core.interruptForNewUserInput(topic, inputSequence)) return;
    if (this.core.pauseForResult(topicId, implementationResult, "IMPLEMENTING", "구현 중 승인 범위 밖 결정이 필요합니다.")) {
      return;
    }
    this.core.transition(topicId, "CODEX_REVIEW", "Codex가 구현 결과를 읽기 전용으로 검토합니다.");
    await this.runReview(topicId, signal, false);
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
      // 수정 턴이 requestedUserDecision 으로 멈춘 뒤 결정이 올라왔으면 저장된 수정 결과를 재사용한다(수정 턴 재구매 방지).
      if (await this.finishStoredFix(topicId, review, kind, signal)) return;
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
    const deltaSinceLastReview = finalPass && previousFlags.reviewedTreeOID && reviewedTree && previousFlags.reviewedTreeOID !== reviewedTree
      ? await this.core.dependencies.git.diffTrees(topic.worktreePath, previousFlags.reviewedTreeOID, reviewedTree).catch(() => null)
      : null;
    const reviewSessionId = this.core.dependencies.database.getCodexReviewSession(topicId);
    const resumedSession = reviewSessionId !== null;
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
    const review = await this.core.turn("codex", topic, buildCodexReviewPrompt({
      planMarkdown: plan, planSHA256: topic.planSHA256!, implementation, finalPass, resumedSession, tolerance, planPath,
      timeline: this.reviewTimeline(topicId, topic.scopeGeneration, reviewSince),
      planningFindings: closeout?.planSHA256 === topic.planSHA256 ? closeout.findings : undefined,
      planningEvidenceRefs: closeout?.planSHA256 === topic.planSHA256 ? closeout.evidenceRefs : undefined,
      originalReviewFindings: originalReview?.findings,
      deltaSinceLastReview,
    }), signal, false, {
      readablePaths: [planPath],
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
    const fixBase = { planMarkdown: plan, planSHA256: topic.planSHA256, reviewFindings: review.findings, planPath };
    const fixPrompts = {
      fresh: buildClaudeFixPrompt({
        ...fixBase, timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration),
      }),
      resume: buildClaudeFixPrompt({
        ...fixBase, resumedSession: true,
        timeline: this.core.dependencies.database.getPromptTimeline(topicId, topic.scopeGeneration, flags.implementationPromptSequence ?? 0),
      }),
    };
    const fixFork = await this.resumeImplementationSession(
      topicId, flags.implementationSessionId, fixPrompts, topic.worktreePath, signal, [planPath],
    );
    if (fixFork.sessionId !== flags.implementationSessionId) {
      this.core.dependencies.database.setImplementationSession(topicId, fixFork.sessionId);
    }
    this.core.dependencies.database.updateTopic(topicId, { implementationPromptSequence: inputSequence });
    const result = fixFork.result;
    this.core.assertCurrent(topicId, signal, topic.scopeGeneration, "CLAUDE_FIX");
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName);
    if (await this.core.dependencies.git.head(topic.worktreePath) !== baselineHead) {
      throw new Error("Claude가 자동 수정 중 승인되지 않은 git commit을 만들었습니다.");
    }
    if (await this.core.interruptPreservingResult(topic, "claude", result, inputSequence, signal)) return;
    const fixResult = await this.core.enforceResultContract("claude", topic, result, fixFork.sessionId, {
      signal, implementation: true, planMode: false, startedAfter: inputSequence, readablePaths: [planPath],
      check: (r) => {
        this.core.assertKind(r, "FIX");
        assertFindingCoverage(review.findings, r.findings, "Claude fix");
        assertDispositionsResolved(review.findings, r, "Claude fix");
      },
    });
    // 계약 교정 턴도 코드를 바꿀 수 있다 — 교정 뒤 HEAD 를 다시 본다(Codex 후속 지적 1, runFix 경로).
    await this.assertBaselineIntact(topic, baselineHead, "자동 수정 교정 중");
    const fixChecked = await this.enforceTolerance({
      topicId, topic: this.core.dependencies.database.getTopic(topicId), plan, result: fixResult, sessionId: fixFork.sessionId,
      signal, inputSequence, resumeState: "CLAUDE_FIX", baselineHead, readablePaths: [planPath],
      check: (r) => {
        this.core.assertKind(r, "FIX");
        assertFindingCoverage(review.findings, r.findings, "Claude fix");
        assertDispositionsResolved(review.findings, r, "Claude fix");
      },
    });
    if (!fixChecked) return;
    await this.assertBaselineIntact(topic, baselineHead, "자동 수정 교정 중");
    await this.core.recordDeferredFindings(topic,
      fixChecked.findings.filter((finding) => finding.disposition === "DEFERRED_OUT_OF_SCOPE"), "fix", signal);
    await this.core.pruneDeferredFindings(topic, resolvedIDs(fixChecked), signal);
    await this.core.saveAgentOutput(topic, "claude", fixChecked, "claude-fix", signal);
    if (this.core.interruptForNewUserInput(topic, inputSequence)) return;
    if (this.core.pauseForResult(topicId, fixChecked, "CLAUDE_FIX", "수정 범위를 넓히려면 사용자 결정이 필요합니다.")) {
      return;
    }
    await this.finishFix(topicId, topic, review, fixChecked, secondPass, signal);
  }

  // 수정 결과가 확정된 뒤의 공통 꼬리: 되돌림 가드(결정으로 뒤집힌 쟁점 제외) → 회차 소비 → 최종 리뷰.
  private async finishFix(
    topicId: string, topic: Topic, review: AgentResult, fixResult: AgentResult, secondPass: boolean, signal: AbortSignal,
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
    this.core.dependencies.database.updateTopic(topicId, secondPass ? { secondFixPassUsed: true } : { fixPassUsed: true });
    this.core.transition(topicId, "CODEX_FINAL_REVIEW", "Codex가 수정 결과를 마지막으로 검토합니다.");
    await this.runReview(topicId, signal, true);
  }

  // 멈춘 수정 결과 재사용(2026-09-07, 계획·최종 리뷰 재사용과 같은 계열): 저장된 claude-fix 가 지금 고치는 리뷰보다 뒤이고,
  // 그 뒤 사용자 decision 이 있고, 그 결과가 수정 계약(kind·쟁점 커버·처분 해소)을 만족하면 수정 턴을 다시 사지 않는다.
  // 하나라도 어긋나면 false — 호출자가 수정 턴을 돈다. HEAD 가 구현 기준에서 움직였으면 runFix 와 같은 이유로 던진다.
  private async finishStoredFix(topicId: string, review: AgentResult, reviewKind: string, signal: AbortSignal): Promise<boolean> {
    const database = this.core.dependencies.database;
    const topic = this.core.requireState(topicId, "CLAUDE_FIX");
    const flags = database.getFlags(topicId);
    if (flags.fixPassUsed && flags.secondFixPassUsed && !this.userDecisionAfterLastFixInterrupt(topic)) return false;
    const storedFix = database.latestArtifact(topicId, "claude-fix");
    const storedReview = database.latestArtifact(topicId, reviewKind);
    if (!storedFix || !storedReview || storedFix.revision <= storedReview.revision) return false;
    if (storedFix.scopeGeneration !== topic.scopeGeneration) return false;
    const decided = database.getTimeline(topicId, storedFix.revision)
      .some((event) => event.scopeGeneration === topic.scopeGeneration && event.actor === "user" && event.kind === "decision");
    if (!decided) return false;
    const fixResult = await this.core.latestResult(topicId, "claude-fix");
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
    this.core.event(topicId, "system", "system",
      `결정이 올라온 저장된 수정 결과(#${storedFix.revision})를 재사용해 최종 리뷰로 넘깁니다 — 수정 턴을 다시 사지 않습니다.`);
    await this.finishFix(topicId, topic, review, fixResult, flags.fixPassUsed, signal);
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
  }): Promise<AgentResult | null> {
    const policy = parseTolerancePolicy(input.plan);
    if (!policy) return input.result;
    let result = input.result;
    let evaluation = evaluateTolerance(policy, await this.collectChangedFiles(input.topic), result.toleranceLedger ?? []);
    if (evaluation.violations.length > 0) {
      this.core.event(input.topicId, "system", "system",
        `${renderToleranceSummary(evaluation)}\n같은 세션에 돌려보내 1회 교정합니다(되돌리기 또는 원장 보완).`,
        { toleranceViolations: evaluation.violations });
      const corrected = await this.core.dependencies.claude.resumeTurn({
        sessionId: input.sessionId, prompt: buildToleranceCorrectionPrompt(evaluation.violations, policy, input.resumeState === "CLAUDE_FIX" ? "FIX" : "IMPLEMENTATION"), cwd: input.topic.worktreePath,
        signal: input.signal, implementation: true, settings: this.core.executionSettings(input.topicId, "claude", true),
        readablePaths: input.readablePaths,
        onProcessSpawn: this.core.processObserver(input.topicId),
        onUsage: this.core.usageObserver(input.topicId, "claude", "계약 교정 재제출"),
      });
      this.core.assertCurrent(input.topicId, input.signal, input.topic.scopeGeneration, input.resumeState);
      // 교정 턴도 커밋을 만들 수 있다 — 범위 밖 변경을 커밋해 버리면 작업 트리 대조에서 사라진다(2026-09-08 Codex 지적 2).
      await this.assertBaselineIntact(input.topic, input.baselineHead, "허용 오차 교정 중");
      result = await this.core.enforceResultContract("claude", input.topic, corrected, input.sessionId, {
        signal: input.signal, implementation: true, planMode: false, startedAfter: input.inputSequence, check: input.check,
        readablePaths: input.readablePaths,
      });
      // 계약 교정이 한 번 더 돌았을 수 있다 — 그 호출도 커밋을 만들 수 있으므로 다시 본다(Codex 후속 지적 1).
      await this.assertBaselineIntact(input.topic, input.baselineHead, "허용 오차 교정 뒤 계약 교정 중");
      evaluation = evaluateTolerance(policy, await this.collectChangedFiles(input.topic), result.toleranceLedger ?? []);
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

  // 브랜치가 그대로이고 HEAD 가 구현 기준과 같은지 — 에이전트 호출(교정 포함) 뒤마다 부른다. 커밋으로 범위 밖 변경을 숨기면 여기서 멈춘다.
  private async assertBaselineIntact(topic: Topic, baselineHead: string, phase: string): Promise<void> {
    await this.core.dependencies.git.assertCurrentBranch(topic.worktreePath, topic.branchName!);
    if (await this.core.dependencies.git.head(topic.worktreePath) !== baselineHead) {
      throw new Error(`Claude가 ${phase} 승인되지 않은 git commit을 만들었습니다. 중단합니다.`);
    }
  }

  // 저장된 세션 id 로 resume 하되, CLI 가 대화 파일을 못 찾으면(턴 시작 직후 stop 되면 id 만 남고 파일이 없다 —
  // 2026-09-08 S10 실측 "No conversation found with session ID") 실패 대신 새 세션으로 시작하고 그 사실을 남긴다.
  // prompts.resume 은 세션이 이미 받은 것을 뺀 짧은 프롬프트, prompts.fresh 는 전문이다 — 세션 유실 폴백은 전문을 쓴다.
  private async resumeImplementationSession(
    topicId: string, sessionId: string, prompts: { resume: string; fresh: string }, cwd: string, signal: AbortSignal,
    readablePaths: readonly string[] = [],
  ): Promise<{ sessionId: string; result: AgentResult }> {
    try {
      const result = await this.core.dependencies.claude.resumeTurn({
        sessionId, prompt: prompts.resume, cwd, signal, implementation: true, readablePaths,
        settings: this.core.executionSettings(topicId, "claude", true),
        onProcessSpawn: this.core.processObserver(topicId),
        onUsage: this.core.usageObserver(topicId, "claude", "턴"),
      });
      return { sessionId, result };
    } catch (error) {
      if (!isMissingSessionError(error) || signal.aborted) throw error;
      this.core.event(topicId, "system", "system",
        `저장된 구현 세션 ${sessionId} 의 대화 파일을 CLI 가 찾지 못해 새 세션으로 시작합니다(직전 턴이 시작 직후 중단됐을 때 생기는 상태).`,
        { missingSessionId: sessionId });
      return this.createFreshImplementationSession(topicId, prompts.fresh, cwd, signal, readablePaths);
    }
  }

  private async createFreshImplementationSession(
    topicId: string, prompt: string, cwd: string, signal: AbortSignal, readablePaths: readonly string[] = [],
  ) {
    return this.core.dependencies.claude.createSession({
      prompt, cwd, signal, implementation: true, readablePaths,
      settings: this.core.executionSettings(topicId, "claude", true),
      onProcessSpawn: this.core.processObserver(topicId),
      onUsage: this.core.usageObserver(topicId, "claude", "턴"),
      // 세션 id 를 실행 전에 저장한다 — 429·stop 으로 턴이 끊겨도 retry 가 같은 세션을 resume 한다(2026-09-03 실측: 완료 뒤 저장이라 NULL 로 남았음).
      onSessionCreated: (sessionId) => this.core.dependencies.database.setImplementationSession(topicId, sessionId),
    });
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

export function isMissingSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /No conversation found with session ID/i.test(message);
}


// 후속 목록에서 빼야 할 쟁점 id — 뒤 단계가 DEFERRED_OUT_OF_SCOPE 가 아닌 처분(해결·불필요·반박·수정 합의)을 붙인 것.
function resolvedIDs(result: AgentResult): string[] {
  return result.findings
    .filter((finding) => finding.disposition && finding.disposition !== "DEFERRED_OUT_OF_SCOPE" && finding.disposition !== "EXTERNAL_EVIDENCE")
    .map((finding) => finding.id);
}
