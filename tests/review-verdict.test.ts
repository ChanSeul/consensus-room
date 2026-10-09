import { describe, expect, it } from "vitest";

import type { AgentResult, Finding } from "../src/shared/contracts";
import { resultPause } from "../src/server/engine/completion";

const finding = (id: string, overrides: Partial<Finding> = {}): Finding => ({
  id, title: `${id} 제목`, severity: "HIGH", disposition: "AGREED_ACTION", rationale: `${id} 근거`, evidenceRefs: [], requiresUserDecision: false, ...overrides,
});
const review = (overrides: Partial<AgentResult> = {}): AgentResult => ({
  kind: "REVIEW", summary: "리뷰", status: "completed", findings: [], evidenceRefs: [], ...overrides,
});
const evidence = finding("E-1", { disposition: "EXTERNAL_EVIDENCE", rationale: "Figma 원문이 필요합니다." });

describe("resultPause — 결과가 요청한 정지의 단일 판정", () => {
  it("중재자 → 결정(요청·blocked·결정 쟁점) → 외부 증거 순서", () => {
    expect(resultPause(review({ requestedMediatorAction: " 빌드 ", requestedUserDecision: "범위" }))).toEqual({ kind: "mediator", action: "빌드" });
    expect(resultPause(review({ requestedUserDecision: "범위", findings: [evidence] }))).toMatchObject({ kind: "decision", message: "범위", blocked: false });
    expect(resultPause(review({ status: "blocked", remainingSteps: ["입력"] }))).toMatchObject({ kind: "decision", blocked: true, remainingSteps: ["입력"] });
    expect(resultPause(review({ findings: [finding("D-1", { requiresUserDecision: true, rationale: "선택 필요" })] })))
      .toMatchObject({ kind: "decision", message: "선택 필요" });
    expect(resultPause(review({ findings: [evidence] }))).toEqual({ kind: "evidence", message: "Figma 원문이 필요합니다." });
    expect(resultPause(review())).toBeNull();
  });
});
