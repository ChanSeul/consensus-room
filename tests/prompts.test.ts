import { describe, expect, it } from "vitest";

import type { AgentResult, Finding, TimelineEvent } from "../src/shared/contracts";
import { buildClaudePlanPrompt, buildCodexAuditPrompt, buildCodexCloseoutPrompt, buildClaudeFixPrompt, buildCodexReviewPrompt, buildImplementationPrompt,
  buildContinuationPrompt, buildContractCorrectionPrompt, buildDispositionConfirmationPrompt, completionStatusContract, dispositionConfirmationQuestion,
  resultPlanIdentity, buildDiagnosisPlanRevisionPrompt, planTimelineDelivery,
  DEFERRED_FINDINGS_INLINE_BYTES } from "../src/shared/prompts";
import type { DeferredFinding } from "../src/shared/contracts";
import type { DiagnosisPrompt } from "../src/shared/diagnoses";

const implementation: AgentResult = { kind: "IMPLEMENTATION", summary: "구현을 마쳤습니다.", findings: [], evidenceRefs: [] };
const finding: Finding = {
  id: "F-1", title: "보완할 동작", severity: "MEDIUM", disposition: "AGREED_ACTION",
  rationale: "긴 근거 RATIONALE-MARKER", evidenceRefs: ["feature.txt"], requiresUserDecision: false,
};
const planMarkdown = "## 범위\n\nPLAN-BODY-MARKER";
const planSHA256 = "a".repeat(64);

// 2026-09-07 Codex 자기 최적화 제안 ①: 같은 세션을 이어 쓰는 검토는 이미 본 계획 전문·자기 findings 전문을 다시 받지 않는다.
describe("Codex 리뷰 프롬프트 — 이어 쓰는 세션 축소", () => {
  it("새 세션에는 계획 전문과 첫 리뷰 findings 전문을 싣는다", () => {
    const prompt = buildCodexReviewPrompt({
      planMarkdown, planSHA256, implementation, finalPass: true, timeline: [], originalReviewFindings: [finding],
    });

    expect(prompt).toContain(planSHA256);
    expect(prompt).toContain("PLAN-BODY-MARKER");
    expect(prompt).toContain("RATIONALE-MARKER");
    expect(prompt).not.toContain("본문은 다시 싣지 않습니다");
  });

  it("이어 쓰는 세션에는 계획 SHA 만 주고 findings 는 id·심각도·제목·처분 색인만 준다", () => {
    const prompt = buildCodexReviewPrompt({
      planMarkdown, planSHA256, implementation, finalPass: true, timeline: [], originalReviewFindings: [finding],
      resumedSession: true,
    });

    expect(prompt).toContain(planSHA256);
    expect(prompt).toContain("본문은 다시 싣지 않습니다");
    expect(prompt).not.toContain("PLAN-BODY-MARKER");
    expect(prompt).toContain("- F-1 [MEDIUM] 보완할 동작 → AGREED_ACTION");
    expect(prompt).not.toContain("RATIONALE-MARKER");
    // 구현(수정) 보고는 이 세션이 아직 못 본 새 정보라 그대로 싣는다.
    expect(prompt).toContain("구현을 마쳤습니다.");
    // 검토 계약(kind·처분)은 세션 상태와 무관하게 매번 붙는다.
    expect(prompt).toContain("반환 kind는 FINAL_REVIEW입니다.");
  });
});

describe("정지 정책 — requestedUserDecision 은 드물게", () => {
  it("구현 프롬프트는 범위 밖을 to-do 로 남기고 계속하라고 하며 정지 사유를 셋으로 제한한다", async () => {
    const { buildImplementationPrompt } = await import("../src/shared/prompts");
    const prompt = buildImplementationPrompt({
      planMarkdown: "# 계획", planSHA256: "a".repeat(64), worktreePath: "/tmp/wt", branchName: "consensus/x", timeline: [],
    });
    expect(prompt).toContain("정지 정책");
    expect(prompt).toContain("to-do 로 남기고 계속");
    expect(prompt).toContain("한 턴에 한 번, 턴 끝에 모아서");
    expect(prompt).not.toContain("승인 범위 밖 변경은 멈추고 사용자 결정을 요청하세요");
    // 남은 승인 작업은 in_progress로 이어가며 사용자 결정을 요구하지 않는다.
    expect(prompt).toContain("완료 선언 계약");
    expect(prompt).toContain("requestedUserDecision 없이 status=in_progress 와 remainingSteps");
  });
  it("허용 오차 교정 프롬프트는 재제출이 최종 보고임을 알리고 본 턴 보고 유지를 요구한다", async () => {
    const { buildToleranceCorrectionPrompt } = await import("../src/shared/prompts");
    const prompt = buildToleranceCorrectionPrompt(["x: 위반"], { scopePaths: ["a/**"], rules: [] }, "IMPLEMENTATION");
    expect(prompt).toContain("최종 보고");
    expect(prompt).toContain("직전 제출의 summary·findings·evidenceRefs·requestedUserDecision·status·remainingSteps 를 그대로 유지");
    expect(prompt).toContain("resolvesRequestedDecision: true");
    expect(prompt).toContain("resolvedRequestIds");
    expect(prompt).toContain("서버가 승계합니다");
  });

  it("수정 프롬프트도 같은 정지 정책을 싣는다", async () => {
    const { buildClaudeFixPrompt } = await import("../src/shared/prompts");
    const prompt = buildClaudeFixPrompt({ planMarkdown: "# 계획", reviewFindings: [], timeline: [] });
    expect(prompt).toContain("정지 정책");
    expect(prompt).not.toContain("범위 확대가 필요하면 코드를 건드리지 말고 requestedUserDecision으로 보고하세요");
  });
});

// 2026-09-08 Codex 제안 ⑥: 같은 세션의 이어지는 턴에는 새 정보만 보낸다 — 계획은 SHA + 파일 경로, 타임라인은 직전 턴 이후.
describe("이어지는 턴의 프롬프트 축소(구현·수정·리뷰)", () => {
  const event = (sequence: number, body: string): TimelineEvent => ({
    id: sequence, topicId: "topic-1", sequence, scopeGeneration: 1, actor: "user", kind: "decision", state: "IMPLEMENTING",
    body, payload: {}, createdAt: "2026-09-08T00:00:00.000Z",
  });

  it("구현 첫 턴은 계획 전문을, 이어지는 턴은 SHA·경로와 직전 턴 이후 이벤트만 싣는다", () => {
    const base = { planMarkdown, planSHA256, worktreePath: "/w", branchName: "b", planPath: "/topics/t/plan.md" };
    const first = buildImplementationPrompt({ ...base, timeline: [event(1, "OLD-DECISION")] });
    expect(first).toContain("PLAN-BODY-MARKER");
    expect(first).toContain("OLD-DECISION");
    expect(first).not.toContain("본문은 다시 싣지 않습니다");

    const resumed = buildImplementationPrompt({ ...base, resumedSession: true, timeline: [event(2, "NEW-DECISION")] });
    expect(resumed).not.toContain("PLAN-BODY-MARKER");
    expect(resumed).toContain(planSHA256);
    expect(resumed).toContain("본문은 다시 싣지 않습니다");
    expect(resumed).toContain("`/topics/t/plan.md` 를 읽으세요");
    expect(resumed).toContain("직전 턴 이후 방에 추가된 사용자 결정과 증거");
    expect(resumed).toContain("NEW-DECISION");
    // 계약(처분·정지 정책)은 세션 상태와 무관하게 매번 붙는다.
    expect(resumed).toContain("DEFERRED_OUT_OF_SCOPE");
    expect(resumed).toContain("requestedUserDecision");

    const quiet = buildImplementationPrompt({ ...base, resumedSession: true, timeline: [] });
    expect(quiet).toContain("(직전 턴 이후 새 결정·증거 없음)");
  });

  it("수정 턴도 같은 규칙을 따르고, 세션 유실 폴백(resumedSession 없음)은 전문을 싣는다", () => {
    const base = { planMarkdown, planSHA256, reviewFindings: [finding], planPath: "/topics/t/plan.md" };
    const resumed = buildClaudeFixPrompt({ ...base, resumedSession: true, timeline: [] });
    expect(resumed).not.toContain("PLAN-BODY-MARKER");
    expect(resumed).toContain(`승인된 계획 SHA-256: ${planSHA256}`);
    expect(resumed).toContain("`/topics/t/plan.md` 를 읽으세요");
    expect(resumed).toContain("RATIONALE-MARKER"); // 수정 대상은 새 정보라 전문
    const fresh = buildClaudeFixPrompt({ ...base, timeline: [event(1, "OLD-DECISION")] });
    expect(fresh).toContain("PLAN-BODY-MARKER");
    expect(fresh).toContain("OLD-DECISION");
  });

  it("리뷰 재개 세션에는 계획 경로와 '직전 리뷰 턴 이후' 이벤트 절이 붙는다", () => {
    const resumed = buildCodexReviewPrompt({
      planMarkdown, planSHA256, implementation, finalPass: true, timeline: [], resumedSession: true, planPath: "/topics/t/plan.md",
    });
    expect(resumed).toContain("`/topics/t/plan.md` 를 읽으세요");
    expect(resumed).toContain("이 리뷰 세션의 직전 턴 이후 방에 추가된 사용자 결정과 증거");
    expect(resumed).toContain("(직전 리뷰 턴 이후 새 결정·증거 없음)");
    const first = buildCodexReviewPrompt({ planMarkdown, planSHA256, implementation, finalPass: false, timeline: [], planPath: "/topics/t/plan.md" });
    expect(first).not.toContain("를 읽으세요");
    expect(first).toContain("(아직 메시지가 없습니다.)");
  });
});


describe("최종 리뷰 변경분 확인", () => {
  it("확인된 빈 변경분도 finding 판정을 유지하며 재검토 범위를 좁힌다", () => {
    const prompt = buildCodexReviewPrompt({
      planMarkdown, planSHA256, implementation, finalPass: true, timeline: [],
      resumedSession: true, deltaSinceLastReview: { files: [], patch: "" }, originalReviewFindings: [finding],
    });
    expect(prompt).toContain("파일 0개");
    expect(prompt).toContain("finding 별 수정 근거");
    expect(prompt).toContain("F-1");
    expect(prompt).toContain("반환 kind는 FINAL_REVIEW입니다.");
  });

  it.each([undefined, false])("이전 리뷰 세션이 없으면 빈 변경분으로 리뷰를 축소하지 않는다 (%s)", (resumedSession) => {
    const prompt = buildCodexReviewPrompt({
      planMarkdown, planSHA256, implementation, finalPass: true, timeline: [],
      resumedSession, deltaSinceLastReview: { files: [], patch: "" },
    });
    expect(prompt).toContain("현재 diff와 테스트 증거를 직접 확인");
    expect(prompt).not.toContain("재검토 범위");
  });

  it("변경분 조회에 실패하면 유효한 세션에서도 전체 검토한다", () => {
    const prompt = buildCodexReviewPrompt({
      planMarkdown, planSHA256, implementation, finalPass: true, timeline: [], resumedSession: true,
      deltaSinceLastReview: null,
    });
    expect(prompt).toContain("현재 diff와 테스트 증거를 직접 확인");
  });
});

// 전달 범위는 계획 변경분 선택과 함께 바뀌어야 한다.
it.each(["full", "delta"] as const)("계획 감사·종결의 %s 타임라인이 전달 범위를 설명한다", (planningContextMode) => {
  const audit = buildCodexAuditPrompt({ title: "계획", planMarkdown, planSHA256, scopeGeneration: 1,
    timeline: [], planningContextMode });
  const closeout = buildCodexCloseoutPrompt({ revisedPlan: planMarkdown, revisedPlanSHA256: planSHA256,
    claudeRevision: { ...implementation, kind: "REVISION" }, timeline: [], planningContextMode });
  for (const prompt of [audit, closeout]) {
    if (planningContextMode === "delta") {
      expect(prompt).toContain("직전 전달 이후 추가된 결정과 증거:");
      expect(prompt).toContain("직전 전달 이후 새 결정·증거 없음");
      expect(prompt).not.toContain("아직 메시지가 없습니다");
    } else {
      expect(prompt).not.toContain("직전 전달 이후");
      expect(prompt).toContain("아직 메시지가 없습니다");
    }
  }
});

// 2026-09-13 Codex 지적 2: RESOLVED_BY_FIX 판정 문구가 fixAware 로 묶여 FINAL_REVIEW(fixAware) 에서 빠졌다. 리뷰 단계 여부는 별도 축이다.
describe("Codex 리뷰 프롬프트 — RESOLVED_BY_FIX 주장은 승계되지 않는다는 문구", () => {
  it("첫 리뷰와 최종 리뷰 모두 앞 단계의 RESOLVED_BY_FIX 주장을 직접 판정하라고 말한다", () => {
    for (const finalPass of [false, true]) {
      const prompt = buildCodexReviewPrompt({ planMarkdown, planSHA256, implementation, finalPass, timeline: [], originalReviewFindings: finalPass ? [finding] : undefined });
      expect(prompt, String(finalPass)).toContain("RESOLVED_BY_FIX 로 주장한 쟁점은 승계되지 않습니다");
      expect(prompt).toContain("리뷰는 미확정·근거 부족으로 제외한 항목의 조사 근거를 확인하세요");
      expect(prompt, String(finalPass)).toContain("서버가 같은 처분으로 승계합니다");
    }
  });
});

// 2026-09-13 사용자 규칙: 경미 지적은 개정 없이 구현 노트로 러너에게 간다 — 프롬프트가 그 목록과 심각도 정책을 말해야 한다.
describe("구현 노트와 심각도 정책", () => {
  const note = { id: "A-M", title: "문서 표기 보완", severity: "MEDIUM" as const, rationale: "NOTE-RATIONALE", source: "audit" as const, topicId: "topic-1", recordedAt: "2026-09-13T00:00:00Z" };
  it("구현 프롬프트는 첫 턴에만 구현 노트를 싣고 id 별 처분을 요구한다", () => {
    const base = { planMarkdown, planSHA256, worktreePath: "/tmp/wt", branchName: "topic/x", timeline: [], implementationNotes: [note] };
    const fresh = buildImplementationPrompt(base);
    expect(fresh).toContain("개정 없이 넘어온 경미 지적(구현 노트)");
    expect(fresh).toContain("A-M [MEDIUM] 문서 표기 보완");
    expect(fresh).toContain("NOTE-RATIONALE");
    expect(buildImplementationPrompt({ ...base, resumedSession: true })).not.toContain("A-M [MEDIUM]");
  });
  it("감사·종결 프롬프트는 심각도 정책을 말하고 종결은 구현 노트 목록을 받는다", () => {
    const audit = buildCodexAuditPrompt({ title: "t", planMarkdown, planSHA256, scopeGeneration: 1, timeline: [] });
    expect(audit).toContain("개정**을 여는 지적은 BLOCKER·HIGH 뿐");
    const closeout = buildCodexCloseoutPrompt({ revisedPlan: planMarkdown, revisedPlanSHA256: planSHA256, claudeRevision: { kind: "REVISION", summary: "s", findings: [], evidenceRefs: [] }, timeline: [], implementationNotes: [note] });
    expect(closeout).toContain("같은 항목을 새 쟁점으로 다시 내지 마세요");
    expect(closeout).toContain("A-M [MEDIUM]");
    expect(closeout).toContain("BLOCKER·HIGH 뿐");
  });
});

// Public prompt boundaries: every implementation/review turn must receive the same decision policy.
describe("중재 판단 정책 전달", () => {
  for (const resumedSession of [false, true]) {
    const inputs = { planMarkdown, planSHA256, timeline: [], resumedSession };
    const prompts = [
      ["구현", buildImplementationPrompt({ ...inputs, worktreePath: "/w", branchName: "b" })],
      ["수정", buildClaudeFixPrompt({ ...inputs, reviewFindings: [] })],
      ["첫 리뷰", buildCodexReviewPrompt({ ...inputs, implementation, finalPass: false })],
      ["최종 리뷰", buildCodexReviewPrompt({ ...inputs, implementation, finalPass: true })],
    ];
    for (const [stage, prompt] of prompts) {
      it(`${stage} ${resumedSession ? "재개" : "최초"}: 실행 판단과 승인 경계를 함께 전달한다`, () => {
        expect(prompt.match(/작업 판단과 종료 기준:/g)).toHaveLength(1);
        expect(prompt.match(/검증 범위와 재사용:/g)).toHaveLength(1);
        expect(prompt).toContain("관련 변경·새 실패·새 반증이 생겼을 때만 영향 범위를 다시 실행");
        expect(prompt).toContain("명시된 필수 검사·권한 경계는 유지");
        expect(prompt).toContain("실행 순서·동등한 방법은 기존 승인과 명시된 계획 조건 안에서 판단");
        expect(prompt).toContain("기존 결함이라는 이유로 필수 검증 실패를 면제");
        expect(prompt).toContain("위임 OFF·명시적 금지·승인 및 예산 한도는 그대로");
        expect(prompt).toContain("기존 요청 ID 해소 절차");
        expect(prompt).toContain("단계별 커밋 구조를 바꾸는 것은 동등한 실행 방법으로 간주하지");
        expect(prompt).not.toContain("인도 전에 사용자가 처분(후속 토픽·다음 계획 포함·폐기)을 정합니다");
      });
    }
  }
  it("계획·감사·종결도 최소 검증과 통과 결과 재사용 기준을 받는다", () => {
    const prompts = [
      buildClaudePlanPrompt({ title: "t", worktreePath: "/w", sourceRepositoryPath: "/r", baseRef: "HEAD", scopeGeneration: 1, timeline: [] }),
      buildCodexAuditPrompt({ title: "t", planMarkdown, planSHA256, scopeGeneration: 1, timeline: [] }),
      buildCodexCloseoutPrompt({ revisedPlan: planMarkdown, revisedPlanSHA256: planSHA256,
        claudeRevision: { kind: "REVISION", summary: "s", findings: [], evidenceRefs: [] }, timeline: [] }),
    ];
    for (const prompt of prompts) {
      expect(prompt.match(/검증 범위와 재사용:/g)).toHaveLength(1);
      expect(prompt).toContain("기존 관련 검사를 사용");
      expect(prompt).toContain("명시된 필수 검사·권한 경계는 유지");
    }
  });
});

// E4 2차 보완 F012 — 이연 쟁점 목록은 근거를 자르지 않는다. 인라인 예산 안이면 근거 전문, 넘으면 예산 안까지의 색인 + 남은 건수 + 원문 산출물 참조.
describe("이연 쟁점 목록 — 절단 없는 인라인 예산과 원문 산출물 참조", () => {
  const deferred = (id: string, rationale: string, topicId = "topic-aaaa-1111"): DeferredFinding =>
    ({ id, title: `${id} 제목`, severity: "MEDIUM", rationale, source: "review", topicId, recordedAt: "2026-09-27T00:00:00Z" });
  const planWith = (findings: DeferredFinding[], deferredFindingsPath?: string) => buildClaudePlanPrompt({ title: "t", worktreePath: "/w",
    sourceRepositoryPath: "/r", baseRef: "HEAD", scopeGeneration: 1, timeline: [], deferredFindings: findings, ...(deferredFindingsPath ? { deferredFindingsPath } : {}) });
  const auditWith = (findings: DeferredFinding[], deferredFindingsPath?: string) => buildCodexAuditPrompt({ title: "t", planMarkdown, planSHA256,
    scopeGeneration: 1, timeline: [], deferredFindings: findings, ...(deferredFindingsPath ? { deferredFindingsPath } : {}) });

  it("작은 목록은 400자를 넘는 근거도 끝까지 인라인으로 싣고, 기존 제목·ID 표시를 유지한다", () => {
    const long = `${"긴 근거 ".repeat(120)}LONG-RATIONALE-END`;
    const findings = [deferred("DF-1", long), deferred("DF-2", "짧은 근거")];
    for (const [prompt, heading] of [[planWith(findings, "/artifacts/deferred.md"), "**이연된 쟁점**"], [auditWith(findings, "/artifacts/deferred.md"), "이미 이연 판정을 받은 쟁점"]]) {
      expect(prompt).toContain(heading);
      expect(prompt).toContain(`- DF-1 [MEDIUM] DF-1 제목 (review, topic-aa): ${long}`);
      expect(prompt).toContain("LONG-RATIONALE-END");
      expect(prompt).toContain("- DF-2 [MEDIUM] DF-2 제목 (review, topic-aa): 짧은 근거");
      expect(prompt).not.toContain("kind=artifact");
    }
  });

  it("큰 목록은 예산 안까지의 색인과 남은 건수, 원문 산출물 참조를 싣고 근거를 인라인으로 싣지 않는다 — 조용히 빠지는 항목이 없다", () => {
    const findings = Array.from({ length: 120 }, (_, index) => deferred(`DF-${String(index).padStart(3, "0")}`,
      `근거 ${index} `.repeat(40) + (index === 119 ? "LAST-RATIONALE-END" : "")));
    const path = "/data/topics/t/artifacts/deferred-findings-digest.md";
    for (const prompt of [planWith(findings, path), auditWith(findings, path)]) {
      expect(prompt).toContain(`kind=search selector=artifact::${path}::<ID 또는 관련 키워드>`);
      expect(prompt).toContain("전체를 순서대로 읽는 필수 과제가 아닙니다");
      expect(prompt).not.toContain("null 이 될 때까지 이어 읽으세요");
      expect(prompt).toContain(`근거 전문 ${findings.length}건은 원문 산출물에 보존되어 있습니다`);
      expect(prompt).not.toContain("LAST-RATIONALE-END");
      expect(prompt).not.toContain("근거 0 근거 0");
      const indexed = findings.filter((finding) => prompt.includes(`- ${finding.id} [MEDIUM] ${finding.id} 제목 (review, topic-aa)`));
      const rest = Number(/- … 외 (\d+)건/.exec(prompt)?.[1] ?? 0);
      // 색인은 앞에서부터 예산 안까지, 나머지는 건수로 — 합이 전체와 같다.
      expect(indexed.map((finding) => finding.id)).toEqual(findings.slice(0, indexed.length).map((finding) => finding.id));
      expect(indexed.length).toBeGreaterThan(0);
      expect(indexed.length + rest).toBe(findings.length);
      const indexBytes = Buffer.byteLength(indexed.map((finding) => `- ${finding.id} [MEDIUM] ${finding.id} 제목 (review, topic-aa)`).join("\n"));
      expect(indexBytes).toBeLessThanOrEqual(DEFERRED_FINDINGS_INLINE_BYTES);
    }
  });

  it("원문 산출물 경로가 없으면 참조할 곳이 없으므로 예산과 무관하게 근거 전문을 모두 싣는다", () => {
    const findings = Array.from({ length: 60 }, (_, index) => deferred(`DF-${index}`, `근거 ${index} `.repeat(40) + `END-${index}`));
    const prompt = planWith(findings);
    for (const finding of findings) expect(prompt).toContain(`${finding.rationale}`);
    expect(prompt).not.toContain("kind=artifact");
  });
});

// 2026-10-06 리뷰 단계 불필요 정지 — 실행 검사는 엔진이 수락 경계에서 하고 리뷰는 영수증만 소비한다(리뷰어 좌석은 읽기 전용). 합의 유지 규칙은 한 문단을
// 감사·종결·수정·최종 리뷰가 공유한다.
describe("리뷰 실행 검사 계약과 합의 유지 규칙", () => {
  it.each([false, true])("리뷰 프롬프트는 영수증을 싣고, 직접 실행 금지·checks 없으면 실행 증거 요구 금지·remainingSteps 외부 요청 금지를 말한다(최종: %s)", (finalPass) => {
    const prompt = buildCodexReviewPrompt({ planMarkdown, planSHA256, implementation, finalPass, timeline: [],
      verificationReceipts: "호스트 실행 검사 영수증(RECEIPT-MARKER)" });
    expect(prompt).toContain("호스트 실행 검사 영수증(RECEIPT-MARKER)");
    expect(prompt).toContain("이 리뷰 좌석은 읽기 전용입니다. 컴파일러·빌드·테스트·스크립트 같은 실행 검사를 직접 돌리지 마세요");
    expect(prompt).toContain("계획에 ```checks 블록이 없으면 필수 실행 검사가 없는 계획입니다");
    expect(prompt).toContain("remainingSteps 에 외부 실행·증거 요청을 적지 마세요");
  });

  it("계획·감사 프롬프트는 checks 선언 안내를 싣고, 감사는 리뷰어 좌석이 못 돌리는 검사를 리뷰 의무로 적었는지 본다", () => {
    const plan = buildClaudePlanPrompt({ title: "계획", worktreePath: "/w", sourceRepositoryPath: "/r", baseRef: "HEAD", scopeGeneration: 1, timeline: [] });
    const audit = buildCodexAuditPrompt({ title: "계획", planMarkdown, planSHA256, scopeGeneration: 1, timeline: [] });
    expect(plan).toContain("필수 검사 선언(선택)");
    expect(audit).toContain("필수 검사 선언(```checks)도 검토하세요");
    expect(audit).toContain("필수 검사 선언(선택)");
  });

  it("합의 유지 규칙은 감사·종결·수정·최종 리뷰가 같은 문단을 쓰고, 단계별 이행 문장만 다르다", () => {
    const audit = buildCodexAuditPrompt({ title: "계획", planMarkdown, planSHA256, scopeGeneration: 1, timeline: [] });
    const closeout = buildCodexCloseoutPrompt({ revisedPlan: planMarkdown, revisedPlanSHA256: planSHA256,
      claudeRevision: { ...implementation, kind: "REVISION" }, timeline: [] });
    const fix = buildClaudeFixPrompt({ planMarkdown, reviewFindings: [finding], timeline: [] });
    const final = buildCodexReviewPrompt({ planMarkdown, planSHA256, implementation, finalPass: true, timeline: [] });
    for (const prompt of [audit, closeout, fix, final]) expect(prompt).toContain("합의 유지 규칙(앞 단계가 AGREED_ACTION 으로 합의한 쟁점):");
    expect(audit).toContain("planImpact=implementation");
    expect(closeout).toContain("같은 세션에 한 번 되묻고, 그래도 같은 처분이면 합의 종결 없이");
    expect(fix).toContain("같은 세션에 한 번 되묻고, 그래도 같은 처분이면 최종 리뷰로 넘기지 않고");
    // 감사의 planImpact 문단이 두 벌로 남지 않는다.
    expect(audit.split("planImpact=implementation").length - 1).toBe(1);
  });

  it("확인형 교정 질문·턴은 하향 쟁점과 단계 규칙·처분 계약을 싣는다", () => {
    const question = dispositionConfirmationQuestion("FIX", ["F-1", "F-2"]);
    expect(question).toContain("F-1, F-2");
    expect(question).toContain("RESOLVED_BY_FIX");
    const prompt = buildDispositionConfirmationPrompt(question, "FIX");
    expect(prompt).toContain("계약 위반은 아닙니다");
    expect(prompt).toContain("같은 처분과 그 근거를 그대로 다시 제출하세요");
    expect(prompt).toContain("처분(disposition)은 다음 값만 씁니다");
  });

  it("종결 확인과 그 후속 턴(계약 교정·처분 확인)은 같은 문장으로 확인할 계획 SHA 를 본문에 싣는다", () => {
    const sha = "b".repeat(64);
    const identity = resultPlanIdentity(sha);
    expect(identity).toContain(`SHA-256(${sha})`);
    const closeout = buildCodexCloseoutPrompt({ revisedPlan: planMarkdown, revisedPlanSHA256: sha,
      claudeRevision: { ...implementation, kind: "REVISION" }, timeline: [] });
    expect(closeout).toContain(identity);
    expect(buildContractCorrectionPrompt("위반", ["CLOSEOUT"], sha)).toContain(identity);
    expect(buildDispositionConfirmationPrompt("질문", "CLOSEOUT", sha)).toContain(identity);
    // 계획 SHA 를 적지 않는 결과(수정 등)의 후속 턴에는 싣지 않는다.
    expect(buildContractCorrectionPrompt("위반", ["FIX"])).not.toContain("planSHA256에 넣어");
    expect(buildDispositionConfirmationPrompt("질문", "FIX")).not.toContain("planSHA256에 넣어");
  });

  it("계획 필수 검사 실패의 계속 진행 턴은 실패 내용을 싣고 직접 실행·중재자 요청이 필요 없다고 말한다", () => {
    const prompt = buildContinuationPrompt([], 1, "FIX", [], undefined, [{ id: "C-1", detail: "C-1(swift-parse) 실패: A.swift:1:1: error" }]);
    expect(prompt).toContain("필수 검사 1회차");
    expect(prompt).toContain("실패한 필수 검사(서버 실행 결과):\n- C-1(swift-parse) 실패: A.swift:1:1: error");
    expect(prompt).not.toContain("남은 단계(직전 제출)");
    expect(completionStatusContract()).toContain("그 검사의 실행을 requestedMediatorAction 으로 요청하거나");
  });
});

// 2026-10-07 입력 효율화 ① — 진단 계획 개정 과제가 같은 직전 보고를 상태 절(요약)과 타임라인 절(agent_output 원문)에 두 번 실었다(DG-4 실측 3,547B).
describe("진단 계획 개정 — 직전 보고는 타임라인에 원문이 실리면 상태 절에 다시 싣지 않는다", () => {
  const report = "REPORT-MARKER 신규 진입 흐름을 대조했습니다.";
  const output = (sequence: number, body: string): TimelineEvent => ({
    id: sequence, topicId: "topic-1", sequence, scopeGeneration: 1, actor: "claude", kind: "agent_output", state: "IMPLEMENTING",
    body, payload: {}, createdAt: "2026-10-07T00:00:00.000Z",
  });
  const diagnosis: DiagnosisPrompt = {
    id: "DG-4", title: "진입 경로 연결", severity: "HIGH", observedFailure: "관찰", cause: "원인", uncertainty: "", instructions: "지시",
    verificationCriteria: ["기준"], evidenceRefs: [], relatedRequestIds: [], supersedes: null, planChange: { required: true, reason: "계획 변경" }, path: null,
  };
  const build = (timeline: TimelineEvent[], delivery?: ReturnType<typeof planTimelineDelivery>) => buildDiagnosisPlanRevisionPrompt({
    planMarkdown, scopeGeneration: 1, worktreePath: "/w", branchName: "b", diagnoses: [diagnosis],
    carry: { remainingSteps: [], openRequests: [], changedPaths: [], lastSummary: report, verifiedLedgerRows: 0 },
    timeline, ...(delivery ? { timelineDelivery: delivery } : {}),
  });
  const occurrences = (prompt: string) => prompt.split("REPORT-MARKER").length - 1;

  it.each([["기존 렌더", false], ["참조 모드 인라인", true]] as const)("%s: 보고 원문을 타임라인에만 싣고 상태 절은 그 이벤트를 가리킨다", (_, referenced) => {
    const events = [output(7, report)];
    const prompt = build(events, referenced ? planTimelineDelivery(events) : undefined);
    expect(occurrences(prompt)).toBe(1);
    expect(prompt).toContain("- 직전 보고 요약: 아래 '방에 추가된 결정과 증거'의 [7] 원문과 같습니다");
  });

  it("그 요약을 인용한 다른 보고는 같은 원문으로 가리키지 않는다", () => {
    const quoted = output(11, `Claude 보고 '${report}'는 사실과 다릅니다 — 실패 2건이 남았습니다.`);
    for (const events of [[output(10, report), quoted], [quoted]]) {
      const prompt = build(events);
      expect(prompt).not.toContain("[11] 원문과 같습니다");
      if (events.length === 2) expect(prompt).toContain("- 직전 보고 요약: 아래 '방에 추가된 결정과 증거'의 [10] 원문과 같습니다");
      else expect(prompt).toContain(`- 직전 보고 요약: ${report}`);
    }
  });

  it("보고가 참조로만 실리거나, 타임라인에 없거나, 다른 보고뿐이면 지금처럼 요약을 싣는다", () => {
    const events = [output(7, report)];
    const referenced = build(events, planTimelineDelivery(events, { inlineBytes: 10, referenceBytes: 6 * 1024 }));
    expect(referenced).toContain(`- 직전 보고 요약: ${report}`);
    expect(referenced).toContain("selector=timeline:7@");
    expect(build([])).toContain(`- 직전 보고 요약: ${report}`);
    const other = build([output(8, "다른 턴의 보고")]);
    expect(other).toContain(`- 직전 보고 요약: ${report}`);
    expect(other).not.toContain("원문과 같습니다");
  });
});
