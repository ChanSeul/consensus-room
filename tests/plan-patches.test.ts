import { describe, expect, it } from "vitest";
import { applyPlanLineEdits, applyPlanRepair, numberedPlan, repairablePlan } from "../src/shared/planPatches";
import { hashPlan, normalizePlan } from "../src/shared/workflow";
import { AgentResultSchema } from "../src/shared/contracts";

const base = "첫 줄\r\n둘째 줄\r\n끝\r\n";
describe("계획 줄 패치", () => {
  it("같은 원문 기준의 수정·삽입·삭제를 뒤에서 적용한다", () => {
    expect(applyPlanLineEdits(base, { baseSHA256: hashPlan(base), edits: [
      { startLine: 1, endLineExclusive: 2, replacement: "수정\n" },
      { startLine: 2, endLineExclusive: 3, replacement: "" },
      { startLine: 4, endLineExclusive: 4, replacement: "추가\n" },
    ] })).toBe("수정\n끝\n추가\n");
    expect(numberedPlan(base)).toContain("2 | 둘째 줄");
  });
  it("오래된 해시·범위 밖·겹침·같은 위치 삽입을 거부한다", () => {
    const edit = { startLine: 1, endLineExclusive: 3, replacement: "" };
    expect(() => applyPlanLineEdits(base, { baseSHA256: "0".repeat(64), edits: [] })).toThrow();
    for (const edits of [[{ ...edit, startLine: 0 }], [{ ...edit, endLineExclusive: 5 }], [edit, { ...edit, startLine: 2 }],
      [{ ...edit, endLineExclusive: 1 }, { ...edit, endLineExclusive: 1 }]]) {
      expect(() => applyPlanLineEdits(base, { baseSHA256: hashPlan(base), edits })).toThrow();
    }
  });
  it("빈 패치와 마지막 줄의 줄바꿈을 보존하고 새 형식 혼용을 거부한다", () => {
    expect(applyPlanLineEdits("한 줄", { baseSHA256: hashPlan("한 줄"), edits: [] })).toBe(normalizePlan("한 줄"));
    expect(AgentResultSchema.safeParse({ kind: "REVISION", summary: "x", planMarkdown: "x", planLineEdits: { baseSHA256: hashPlan(base), edits: [] } }).success).toBe(false);
  });
});

describe("허용 오차 부분 교정", () => {
  const plan = '앞 문맥\n```tolerance\n{"scopePaths":["src/**"],"rules":[],}\n```\n뒤 문맥\n';
  it("블록 내부만 교정하고 다른 계획 문장을 보존한다", () => {
    const result = applyPlanRepair(plan, { baseSHA256: hashPlan(plan), edits: [{ find: '"rules":[],', replace: '"rules":[]' }] });
    expect(result).toBe(plan.replace('"rules":[],', '"rules":[]'));
  });
  it("블록 밖·중복 블록·오래된 해시·남은 오류를 거부한다", () => {
    for (const repair of [
      { baseSHA256: "0".repeat(64), edits: [] },
      { baseSHA256: hashPlan(plan), edits: [{ find: "앞 문맥", replace: "변경" }] },
      { baseSHA256: hashPlan(plan), edits: [] },
    ]) expect(() => applyPlanRepair(plan, repair)).toThrow();
    expect(repairablePlan({ kind: "PLAN", summary: "x", findings: [], evidenceRefs: [], planMarkdown: plan + plan })).toBeNull();
  });
});

it("형식 교정으로 승인 범위나 허용 상한을 넓힐 수 없다", () => {
  const plan = '```tolerance\n{"scopePaths":["src/**"],"rules":[],}\n```\n';
  expect(() => applyPlanRepair(plan, { baseSHA256: hashPlan(plan), edits: [
    { find: '"src/**"', replace: '"**"' }, { find: '"rules":[],', replace: '"rules":[]' },
  ] })).toThrow();
});

it("리터럴이 같아도 중괄호를 옮겨 허용 상한을 바꾸는 교정을 거부한다", () => {
  const original = '{"scopePaths":["src/**"],"rules":[{"id":"T-1","title":"bounded","paths":["other/**"],"hunk":"any","maxFiles":1,"extra":{"maxFiles":100},"maxHunks":1}],}';
  const plan = '```tolerance\n' + original + '\n```\n';
  const replace = original.replace('"extra":{"maxFiles":100}', '"extra":{},"maxFiles":100').replace('],}', ']}');
  expect(() => applyPlanRepair(plan, { baseSHA256: hashPlan(plan), edits: [{ find: original, replace }] })).toThrow();
});

it("구조를 확정할 수 없는 문법 오류는 부분 교정 대상으로 고르지 않는다", () => {
  const planMarkdown = '```tolerance\n{"scopePaths":["src/**"] "rules":[]}\n```\n';
  expect(repairablePlan({ kind: "PLAN", summary: "x", findings: [], evidenceRefs: [], planMarkdown })).toBeNull();
});

it("실제 큰 개정을 익명화한 사례에서 동일 결과를 더 작은 패치로 전달한다", async () => {
  const { readFile } = await import("node:fs/promises");
  const fixture = JSON.parse(await readFile(new URL("./fixtures/plan-line-comparison.json", import.meta.url), "utf8"));
  expect(applyPlanLineEdits(fixture.base, fixture.patch)).toBe(fixture.expected);
  expect(hashPlan(applyPlanLineEdits(fixture.base, fixture.patch))).toBe(hashPlan(fixture.expected));
  const linePatchBytes = Buffer.byteLength(JSON.stringify(fixture.patch));
  expect(linePatchBytes + fixture.numberedInputExtraBytes).toBeLessThan(fixture.legacyPatchBytes);
});

it("정책 값이 잘못되면 값 보존 부분 교정을 호출할 후보로 고르지 않는다", () => {
  const planMarkdown = '```tolerance\n{"scopePaths":[],"rules":[]}\n```\n';
  expect(repairablePlan({kind:"PLAN",summary:"x",findings:[],evidenceRefs:[],planMarkdown})).toBeNull();
});
