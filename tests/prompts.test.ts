import { describe, expect, it } from "vitest";

import type { AgentResult, Finding, TimelineEvent } from "../src/shared/contracts";
import { buildCodexAuditPrompt, buildCodexCloseoutPrompt, buildClaudeFixPrompt, buildCodexReviewPrompt, buildImplementationPrompt } from "../src/shared/prompts";

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
