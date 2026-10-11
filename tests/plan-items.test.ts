import { describe, expect, it } from "vitest";

import type { TimelineEvent, Topic } from "../src/shared/contracts";
import { parsePlanItems, planItemCoverage, PLAN_ITEMS_EXAMPLE, PlanItemsError } from "../src/shared/planItems";
import { coverageInputKey, coverageReceipt, declaredPlanItems, deliveryCoverageProblem, implementerCoverage, latestCoverageReceipt, planItemsFact,
  requireDeclaredPlanItems, reviewerCoverage } from "../src/server/engine/planCoverage";
import type { InternalTopicFlags } from "../src/server/types";
import { serializePlanBundle } from "../src/server/planBundle";

// 계획 항목 coverage(2026-10-11) — planned 승인 계획의 ```plan-items 선언과 구현자 보고·리뷰어 판정의 정확한 집합 일치, 승인 판·검토 트리에 결속된 영수증.
const block = (items: unknown[]) => `\`\`\`plan-items\n${JSON.stringify({ version: 1, items })}\n\`\`\``;
const ITEM = { id: "R-1", requirement: "오류 문구를 정리한다", done: "화면에서 확인" };
const ITEM2 = { id: "R-2", requirement: "로그를 남긴다", done: "로그 파일 확인" };

describe("계획 항목 선언(```plan-items)", () => {
  it("블록이 없으면 빈 목록이고, 한 블록은 선언 순서 그대로 읽는다", () => {
    expect(parsePlanItems("# 계획\n\n본문만 있다.\n")).toEqual([]);
    expect(parsePlanItems(`# 계획\n\n${block([ITEM, ITEM2])}\n`)).toEqual([ITEM, ITEM2]);
  });

  it("여러 파일 묶음의 블록을 모두 합치고, 파일 사이의 같은 id·형식 오류·빈 목록은 예시와 함께 거부한다", () => {
    const bundle = `<!-- plan-file "plan.md" 10 -->\n${block([ITEM])}\n<!-- plan-file "steps.md" 10 -->\n${block([ITEM2])}\n`;
    expect(parsePlanItems(bundle).map((item) => item.id)).toEqual(["R-1", "R-2"]);
    const duplicated = `${block([ITEM])}\n\n${block([ITEM])}`;
    expect(() => parsePlanItems(duplicated)).toThrow(PlanItemsError);
    expect(() => parsePlanItems(duplicated)).toThrow("id 가 겹칩니다");
    expect(() => parsePlanItems(block([{ id: "bad id", requirement: "x", done: "y" }]))).toThrow("id 는");
    expect(() => parsePlanItems(block([{ id: "R-1", requirement: "x" }]))).toThrow("done");
    expect(() => parsePlanItems(block([]))).toThrow(PLAN_ITEMS_EXAMPLE);
    expect(() => parsePlanItems("```plan-items\n{not json\n```")).toThrow("JSON 이 아닙니다");
  });

  it("닫히지 않은 블록은 뒤·앞·파일 경계 어디에 있든 선언 전체를 거부하고, 여는 줄의 뒤 공백·다른 이름의 펜스는 그대로 구분한다", () => {
    // Root 인수 검토 1(2026-10-11): lazy 정규식은 정상 R-1 뒤의 미완성 R-2 를 조용히 버리고(R-1 만 반환), 앞의 미완성 블록은 다음 블록의 여는 줄을 닫는 줄로 삼았다.
    const unclosed = `\`\`\`plan-items\n${JSON.stringify({ version: 1, items: [ITEM2] })}\n`;
    expect(() => parsePlanItems(`${block([ITEM])}\n\n${unclosed}`)).toThrow(PlanItemsError);
    expect(() => parsePlanItems(`${block([ITEM])}\n\n${unclosed}`)).toThrow("닫히지 않은");
    expect(() => parsePlanItems(`${unclosed}\n${block([ITEM])}\n`)).toThrow("다음 ```plan-items 를 만났습니다");
    expect(() => parsePlanItems(serializePlanBundle([{ path: "plan.md", content: `# 계획\n\n${unclosed}` }, { path: "steps.md", content: `## 단계\n\n${block([ITEM])}\n` }])))
      .toThrow("닫히지 않은");
    expect(parsePlanItems(`\`\`\`plan-items  \n${JSON.stringify({ version: 1, items: [ITEM] })}\n\`\`\`  \n`)).toEqual([ITEM]);
    // 이름이 다른 펜스는 선언이 아니지만 토큰을 담고 있어 조용히 지나치지 않는다 — 옛 정규식은 이것도 블록으로 읽었으므로 빈 목록으로 통과시키면 부분 목록이다.
    expect(() => parsePlanItems("```plan-items-old\n{}\n```\n")).toThrow("올바른 여는 줄이 아닌");
    expect(parsePlanItems("```checks\n{}\n```\n")).toEqual([]);
  });

  it("들여쓴 여는 줄·닫는 줄과 3개 이상 백틱 펜스는 읽고, 줄 머리가 아닌 곳의 토큰은 선언 전체를 거부한다", () => {
    // Root 표적 재대조(a2c32ae): ^ 앵커가 공백 두 칸 들여쓴 여는 줄을 여는 줄로 보지 않아 옛 정규식이 읽던 R-2 가 조용히 빠졌다([R-1] 만) — 부분 목록 통과는 금지.
    const r2 = JSON.stringify({ version: 1, items: [ITEM2] });
    expect(parsePlanItems(`${block([ITEM])}\n\n  \`\`\`plan-items\n${r2}\n\`\`\`\n`).map((item) => item.id)).toEqual(["R-1", "R-2"]);
    expect(parsePlanItems(`  \`\`\`plan-items\n  ${r2}\n  \`\`\`\n`)).toEqual([ITEM2]);
    expect(parsePlanItems(`\`\`\`\`plan-items\n${r2}\n\`\`\`\`\n`)).toEqual([ITEM2]);
    expect(() => parsePlanItems(`${block([ITEM])}\n\n  \`\`\`plan-items\n${r2}\n`)).toThrow("닫히지 않은");
    expect(() => parsePlanItems(`${block([ITEM])}\n\n- \`\`\`plan-items\n${r2}\n\`\`\`\n`)).toThrow("올바른 여는 줄이 아닌");
  });

  it("문자열 안의 제어 문자와 마지막 쉼표는 정리하고, 항목 수 상한은 두지 않는다", () => {
    const text = '```plan-items\n{"version":1,"items":[{"id":"R-1","requirement":"줄\n바꿈","done":"탭\t포함",},],}\n```';
    expect(parsePlanItems(text)).toEqual([{ id: "R-1", requirement: "줄 바꿈", done: "탭 포함" }]);
    const many = Array.from({ length: 120 }, (_, index) => ({ id: `R-${index + 1}`, requirement: `요구 ${index + 1}`, done: "확인" }));
    expect(parsePlanItems(block(many))).toHaveLength(120);
  });

  it("선언 판정은 없음·형식 오류·선언을 구분하고, 승인 경계용 요구는 없음·오류를 사유와 함께 던진다", () => {
    expect(declaredPlanItems("# 계획\n")).toMatchObject({ kind: "undeclared" });
    expect(String((declaredPlanItems("# 계획\n") as { message: string }).message)).toContain("return-to-planning");
    expect(declaredPlanItems("```plan-items\n{}\n```")).toMatchObject({ kind: "invalid" });
    expect(declaredPlanItems(block([ITEM]))).toEqual({ kind: "declared", items: [ITEM] });
    expect(() => requireDeclaredPlanItems("# 계획\n")).toThrow("plan-items");
    expect(requireDeclaredPlanItems(block([ITEM]))).toEqual([ITEM]);
  });
});

describe("항목별 보고·판정의 집합 대조", () => {
  const declared = [ITEM, ITEM2];

  it("누락·미지·중복·빈 근거는 형식 불일치이고, 기대 status 가 아닌 항목은 미충족이다", () => {
    expect(planItemCoverage(declared, null, "implemented").format[0]).toContain("planItems");
    const coverage = planItemCoverage(declared, [
      { id: "R-1", status: "implemented", evidence: " " }, { id: "R-1", status: "implemented", evidence: "x" }, { id: "R-9", status: "implemented", evidence: "y" },
    ], "implemented");
    expect(coverage.format).toEqual(["보고에 빠진 항목: R-2", "계획에 없는 항목: R-9", "중복 보고한 항목: R-1", "근거(evidence)가 비어 있는 항목: R-1"]);
    const unmet = planItemCoverage(declared, [{ id: "R-1", status: "implemented", evidence: "a" }, { id: "R-2", status: "not-implemented", evidence: "b" }], "implemented");
    expect(unmet.format).toEqual([]);
    expect(unmet.unmet.map((entry) => entry.id)).toEqual(["R-2"]);
  });

  it("구현자는 전부 implemented 여야 통과하고, 그 밖은 같은 보고의 반복 판정 키와 교정 안내를 돌려준다", () => {
    expect(implementerCoverage(declared, [{ id: "R-1", status: "implemented", evidence: "a" }, { id: "R-2", status: "implemented", evidence: "b" }])).toEqual({ ok: true });
    const partial = implementerCoverage(declared, [{ id: "R-1", status: "implemented", evidence: "a" }]);
    expect(partial).toMatchObject({ ok: false, violations: { absent: false, missing: ["R-2"], unknown: [], duplicated: [], blank: [] }, unmet: [] });
    expect((partial as { summary: string }).summary).toContain("빠진 항목: R-2");
    expect(implementerCoverage(declared, [{ id: "R-2", status: "not-implemented", evidence: "b" }, { id: "R-1", status: "implemented", evidence: "a" }]))
      .toMatchObject({ ok: false, violations: { missing: [] }, unmet: ["R-2"] });
    expect(implementerCoverage(declared, null)).toMatchObject({ ok: false, violations: { absent: true, missing: ["R-1", "R-2"] } });
    expect((implementerCoverage(declared, null) as { summary: string }).summary).toContain("needs-mediator");
    const fact = planItemsFact("요약", "key-1");
    expect(fact.payload).toMatchObject({ workerFact: { kind: "check-result", checks: [{ id: "plan-items", status: "failed", summary: "요약" }] }, planCheckInput: "key-1" });
  });

  // host-review F002 — 반복 키는 역할·승인 판·planEpoch·실제 코드 스냅샷·선언 id·정규화한 위반 집합으로만 만든다. 보고 순서·evidence 문구는 키를 바꾸지 못하고,
  // 위반 집합이 줄거나({R-2,R-3}→{R-3}→{}) 코드·승인 판이 바뀌면 새 입력이다.
  it("반복 키는 같은 트리의 같은 위반 집합이면 순서·문구가 달라도 같고, 위반 집합·코드 스냅샷·승인 판·역할이 다르면 다르다", () => {
    const three = [ITEM, ITEM2, { id: "R-3", requirement: "문서를 갱신한다", done: "README 확인" }];
    const input = { planSHA256: "a".repeat(64), planEpoch: 1, snapshot: { head: "h1", diffSHA256: "d1" } };
    const report = (...entries: Array<[string, "implemented" | "not-implemented", string]>): import("../src/shared/planItems").PlanItemReport =>
      entries.map(([id, status, evidence]) => ({ id, status, evidence }));
    const key = (reported: import("../src/shared/planItems").PlanItemReport, override: Partial<typeof input> = {}, role: "implementer" | "code-reviewer" = "implementer") => {
      const coverage = implementerCoverage(three, reported);
      if (coverage.ok) throw new Error("실패 보고만 키를 만든다");
      return coverageInputKey(role, { ...input, ...override }, three, coverage.violations, coverage.unmet);
    };
    const missingR3 = key(report(["R-1", "implemented", "첫 근거"], ["R-2", "implemented", "둘째 근거"]));
    expect(key(report(["R-2", "implemented", "다른 문구"], ["R-1", "implemented", "또 다른 문구"]))).toBe(missingR3);
    expect(key(report(["R-1", "implemented", "a"]))).not.toBe(missingR3);                                                      // {R-2,R-3} 누락 → 다른 위반 집합
    expect(key(report(["R-1", "implemented", "a"], ["R-2", "implemented", "b"], ["R-3", "not-implemented", "c"]))).not.toBe(missingR3);   // 누락 대신 미구현
    expect(key(report(["R-1", "implemented", "a"], ["R-2", "implemented", "b"]), { snapshot: { head: "h1", diffSHA256: "d2" } })).not.toBe(missingR3);   // 코드가 바뀜
    expect(key(report(["R-1", "implemented", "a"], ["R-2", "implemented", "b"]), { planSHA256: "b".repeat(64) })).not.toBe(missingR3);              // 승인 판이 바뀜
    expect(key(report(["R-1", "implemented", "a"], ["R-2", "implemented", "b"]), { planEpoch: 2 })).not.toBe(missingR3);
    expect(key(report(["R-1", "implemented", "a"], ["R-2", "implemented", "b"]), {}, "code-reviewer")).not.toBe(missingR3);
    const unmet = (reported: import("../src/shared/planItems").PlanItemReport) => key(reported);
    expect(unmet(report(["R-1", "implemented", "a"], ["R-2", "not-implemented", "아직"], ["R-3", "not-implemented", "아직"])))
      .toBe(unmet(report(["R-3", "not-implemented", "다른 말"], ["R-2", "not-implemented", "다른 말"], ["R-1", "implemented", "b"])));
    expect(unmet(report(["R-1", "implemented", "a"], ["R-2", "implemented", "했다"], ["R-3", "not-implemented", "아직"])))
      .not.toBe(unmet(report(["R-1", "implemented", "a"], ["R-2", "not-implemented", "아직"], ["R-3", "not-implemented", "아직"])));
  });

  it("리뷰어는 집합·근거가 맞아야 하고(format), 전부 satisfied 가 아니면 미충족(unmet)이며, 맞으면 판정 원문을 돌려준다", () => {
    expect(reviewerCoverage(declared, [{ id: "R-1", status: "satisfied", evidence: "a" }])).toMatchObject({ kind: "format", violations: { missing: ["R-2"] } });
    const unmet = reviewerCoverage(declared, [{ id: "R-1", status: "satisfied", evidence: "a" }, { id: "R-2", status: "unverified", evidence: "로그를 못 봤다" }]);
    expect(unmet).toMatchObject({ kind: "unmet", unmet: [{ id: "R-2", status: "unverified" }] });
    expect((unmet as { summary: string }).summary).toContain("R-2(unverified: 로그를 못 봤다)");
    const verdicts = [{ id: "R-2", status: "satisfied" as const, evidence: "b" }, { id: "R-1", status: "satisfied" as const, evidence: "a" }];
    expect(reviewerCoverage(declared, verdicts)).toEqual({ kind: "ok", items: verdicts });
  });
});

describe("영수증 — 승인 판·범위 세대·planEpoch·검토 트리에 결속된 전 항목 충족 판정", () => {
  const sha = (prefix: string) => prefix.repeat(64).slice(0, 64);
  const receipt = coverageReceipt({ planSHA256: sha("a"), scopeGeneration: 1, planEpoch: 1, reviewedHead: "h1", reviewedDiffSHA256: "d1", reviewedTreeOID: "t1",
    reviewSessionId: "codex-review", reviewLedgerId: "ledger-1", items: [{ id: "R-1", status: "satisfied", evidence: "a" }] });
  const event = (sequence: number, payload: Record<string, unknown>, scopeGeneration = 1): TimelineEvent =>
    ({ id: sequence, topicId: "t", sequence, scopeGeneration, actor: "system", kind: "system", state: "READY_TO_DELIVER", body: "", payload, createdAt: "2026-10-11T00:00:00.000Z" });
  const topic = (overrides: Partial<Topic> = {}): Topic => ({
    id: "t", slug: "t", title: "t", repositoryPath: "/r", baseRef: "develop", worktreePath: "/w", branchName: "b", state: "READY_TO_DELIVER", workflowMode: "planned",
    scopeGeneration: 1, planEpoch: 1, planRevision: 1, planSHA256: sha("a"), approvedPlanSHA256: sha("a"), agentSettings: {} as Topic["agentSettings"], participants: [],
    createdAt: "2026-10-11T00:00:00.000Z", updatedAt: "2026-10-11T00:00:00.000Z", lastError: null, branchPrefix: "consensus", requestedBranchName: null,
    predecessorTopicId: null, ...overrides,
  } as Topic);
  const flags = (overrides: Partial<InternalTopicFlags> = {}): InternalTopicFlags => ({
    fixPassUsed: false, secondFixPassUsed: false, closeoutRevisionUsed: false, resumeState: null, implementationSessionId: null, implementationBaseOID: null,
    implementationPromptSequence: null, reviewedHead: "h1", reviewedDiffSHA256: "d1", reviewedTreeOID: "t1", committedOID: null, pushedOID: null, orphanCommitOID: null, ...overrides,
  });
  const timeline = [event(3, { from: "CODEX_REVIEW", to: "READY_TO_DELIVER", planCoverage: receipt })];

  it("READY 전이 사건의 영수증만 읽고, 일치하면 전달을 막지 않는다", () => {
    expect(latestCoverageReceipt(timeline)).toEqual(receipt);
    expect(latestCoverageReceipt([event(2, { from: "IMPLEMENTING", to: "CODEX_REVIEW" })])).toBeNull();
    expect(deliveryCoverageProblem(topic(), flags(), timeline)).toBeNull();
    expect(receipt.recordedAt).toMatch(/^\d{4}-/);
  });

  it("영수증이 없으면 보완 경로(재리뷰·계획 보완·ticket)를 안내하고, ticket 토픽은 대조하지 않는다", () => {
    const problem = deliveryCoverageProblem(topic(), flags(), [])!;
    for (const part of ["항목 영수증", "reentry CODEX_REVIEW", "return-to-planning", "ticket"]) expect(problem).toContain(part);
    expect(deliveryCoverageProblem(topic({ workflowMode: "ticket" }), flags(), [])).toBeNull();
  });

  it("승인 판·범위 세대·planEpoch·검토 트리 가운데 하나라도 다르면 낡은 영수증이라 거부한다", () => {
    expect(deliveryCoverageProblem(topic({ approvedPlanSHA256: null }), flags(), timeline)).toContain("승인 계획 판");
    expect(deliveryCoverageProblem(topic({ planSHA256: sha("b") }), flags(), timeline)).toContain("승인 계획 판");
    expect(deliveryCoverageProblem(topic({ planEpoch: 2 }), flags(), timeline)).toContain("계획 epoch");
    expect(deliveryCoverageProblem(topic({ scopeGeneration: 2 }), flags(), [event(3, { to: "READY_TO_DELIVER", planCoverage: receipt }, 2)])).toContain("범위 세대");
    expect(deliveryCoverageProblem(topic(), flags({ reviewedHead: "h2" }), timeline)).toContain("검토 트리");
    expect(deliveryCoverageProblem(topic(), flags({ reviewedTreeOID: null }), timeline)).toContain("검토 트리");
  });
});
