import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PLAN_HEADINGS } from "../src/shared/contracts";
import { declaredVerificationProfiles, parsePlanChecks } from "../src/shared/planChecks";
import { assertPlanContract } from "../src/shared/workflow";
import { planCheckGate, verificationSatisfier } from "../src/server/engine/planCheckGate";
import { serializePlanBundle } from "../src/server/planBundle";
import type { VerificationOutcome, VerificationRun } from "../src/server/verifications";

const checks = (json: string) => `## 테스트\n\n\`\`\`checks\n${json}\n\`\`\`\n`;
const plan = (extra = "") => REQUIRED_PLAN_HEADINGS.map((heading) => heading === "허용 오차"
  ? `## ${heading}\n\n\`\`\`tolerance\n{"scopePaths":["Modules/**"],"rules":[]}\n\`\`\`\n`
  : `## ${heading}\n\n내용\n`).join("\n") + extra;

describe("계획 필수 검사 선언(```checks)", () => {
  it("블록이 없으면 필수 검사가 없다 — 이 계약 전에 승인된 계획(1fd0cc86 등)은 그대로 통과한다", () => {
    expect(parsePlanChecks(plan())).toEqual([]);
    expect(() => assertPlanContract(plan())).not.toThrow();
  });

  it("등록 프로필 id 만 선언할 수 있고, 선언 순서·중복 제거로 프로필을 고른다", () => {
    const items = parsePlanChecks(checks(`{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"swift-parse"},`
      + `{"id":"C-2","kind":"verification","profile":"swift-concurrency-policy"},{"id":"C-3","kind":"verification","profile":"swift-parse"}]}`));
    expect(items.map((item) => item.id)).toEqual(["C-1", "C-2", "C-3"]);
    expect(declaredVerificationProfiles(items)).toEqual(["swift-parse", "swift-concurrency-policy"]);
  });

  it.each([
    ["JSON 아님", "{version:1", "JSON 이 아닙니다"],
    ["미등록 프로필(임의 명령 불가)", `{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"xcodebuild"}]}`, "형식 오류"],
    ["모르는 kind", `{"version":1,"items":[{"id":"C-1","kind":"figma","profile":"swift-parse"}]}`, "형식 오류"],
    ["추가 필드(argv 주입)", `{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"swift-parse","args":["rm"]}]}`, "형식 오류"],
    ["id 중복", `{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"swift-parse"},{"id":"C-1","kind":"verification","profile":"swift-parse"}]}`, "겹칩니다"],
    ["버전", `{"version":2,"items":[]}`, "형식 오류"],
  ])("형식이 틀리면 계획 계약 검사가 저장 전에 거른다(%s)", (_label, json, message) => {
    expect(() => parsePlanChecks(checks(json))).toThrow(message);
    expect(() => assertPlanContract(plan(checks(json)))).toThrow(message);
  });

  // 2026-09-13 S11: 문자열 리터럴 안의 탭·줄바꿈으로 개정 턴 2개가 소각됐다 — 문자열 안 제어 문자만 공백으로 흡수한다.
  it("문자열 안의 탭·줄바꿈은 공백이 되고, 이스케이프·값은 그대로다", () => {
    const raw = '{\n  "version": 1,\n  "items": [{"id": "탭\t있음\n줄바꿈", "kind": "verification", "profile": "swift-parse"}, '
      + '{"id": "이스케이프 \\n 유지", "kind": "verification", "profile": "swift-parse"}]\n}';
    expect(parsePlanChecks(checks(raw)).map((item) => item.id)).toEqual(["탭 있음 줄바꿈", "이스케이프 \n 유지"]); // JSON 이스케이프 \n 은 실제 줄바꿈으로 남는다
  });

  it("긴 문자열과 마지막 쉼표를 허용하고 문자열 안 쉼표는 보존한다", () => {
    const id = "설명,}".repeat(100);
    const raw = JSON.stringify({ version: 1, items: [{ id, kind: "verification", profile: "swift-parse" }] }).replace(/}$/, ",}");
    expect(parsePlanChecks(checks(raw))[0].id).toBe(id);
  });

  // 79fc4fc5 F007 — 계획 묶음은 여러 MD 를 이어 붙인다(serializePlanBundle). 두 번째 파일부터의 선언도 읽고, 파일 사이의 같은 id 는 명시적으로 거부한다.
  it("여러 파일 계획 묶음의 checks 선언을 모두 읽고, 같은 id·계획 전체 20개 초과는 거부한다", () => {
    const item = (id: string, profile: string) => `{"id":"${id}","kind":"verification","profile":"${profile}"}`;
    const block = (...items: string[]) => checks(`{"version":1,"items":[${items.join(",")}]}`);
    const bundle = serializePlanBundle([{ path: "a.md", content: block(item("C-1", "swift-parse")) },
      { path: "b.md", content: block(item("C-2", "swift-concurrency-policy")) }]);
    expect(parsePlanChecks(bundle).map((entry) => [entry.id, entry.profile])).toEqual([["C-1", "swift-parse"], ["C-2", "swift-concurrency-policy"]]);
    const duplicated = serializePlanBundle([{ path: "a.md", content: block(item("C-1", "swift-parse")) },
      { path: "b.md", content: block(item("C-1", "swift-concurrency-policy")) }]);
    expect(() => parsePlanChecks(duplicated)).toThrow("겹칩니다");
    const eleven = (prefix: string) => block(...Array.from({ length: 11 }, (_, index) => item(`${prefix}-${index}`, "swift-parse")));
    expect(() => parsePlanChecks(serializePlanBundle([{ path: "a.md", content: eleven("A") }, { path: "b.md", content: eleven("B") }]))).toThrow("형식 오류");
  });
});

const run = (overrides: Partial<VerificationRun> = {}): VerificationRun => ({
  id: "00000000-0000-4000-8000-000000000001", topicId: "topic-1", cacheKey: "k", profileId: "swift-parse", executor: "engine",
  status: "succeeded", scopeGeneration: 1, planEpoch: 0, planSHA256: "p", inputSHA256: "input-1", toolSHA256: "tool", startedAt: 0, ...overrides,
});
const parseCheck = parsePlanChecks(checks(`{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"swift-parse"}]}`));

describe("수락 경계 게이트(planCheckGate)", () => {
  it("선언이 없으면 검사를 부르지 않는다", async () => {
    const ensure = vi.fn();
    expect(await planCheckGate([], { verification: verificationSatisfier(ensure) }, new AbortController().signal)).toEqual({ kind: "satisfied", results: [] });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("성공·대상 없음은 충족이다", async () => {
    for (const outcome of [{ status: "succeeded", run: run(), reused: true }, { status: "no-targets" }] as VerificationOutcome[]) {
      const ensure = vi.fn(async () => outcome);
      expect(await planCheckGate(parseCheck, { verification: verificationSatisfier(ensure) }, new AbortController().signal)).toEqual({ kind: "satisfied",
        results: [expect.objectContaining({ item: expect.objectContaining({ id: "C-1" }), status: "satisfied" })] });
      expect(ensure).toHaveBeenCalledWith("swift-parse", expect.any(AbortSignal));
    }
  });

  it("검사가 돌고 실패하면 러너 몫이다 — 실패 로그 끝부분과 입력 신원(정체 판정용)을 돌려준다", async () => {
    const stderr = `${"x".repeat(7_000)}\nModules/A.swift:3:1: error: expected '}'`;
    const ensure = vi.fn(async (): Promise<VerificationOutcome> => ({ status: "failed", run: run({ status: "failed" }), log: { stdout: "", stderr } }));
    const gate = await planCheckGate(parseCheck, { verification: verificationSatisfier(ensure) }, new AbortController().signal);
    expect(gate.kind).toBe("unsatisfied");
    if (gate.kind !== "unsatisfied") return;
    expect(gate.failures[0].detail).toContain("Modules/A.swift:3:1: error: expected '}'");
    expect(gate.failures[0].detail).toContain("앞 1041자 생략");
    expect(gate.inputKey).toBe(JSON.stringify([["C-1", "input-1"]]));
  });

  it("러너가 고칠 수 없는 호스트 문제는 정지 사유다 — 검사 서비스 없음·실행 불가(도구 미해석)·시간 초과", async () => {
    const signal = new AbortController().signal;
    const cases: Array<Parameters<typeof verificationSatisfier>[0]> = [
      undefined,
      vi.fn(async () => { throw new Error("swiftc 를 찾을 수 없습니다"); }),
      vi.fn(async (): Promise<VerificationOutcome> => ({ status: "timed_out", run: run({ status: "timed_out" }), log: null })),
    ];
    const details = [];
    for (const ensure of cases) {
      const gate = await planCheckGate(parseCheck, { verification: verificationSatisfier(ensure) }, signal);
      expect(gate.kind).toBe("unavailable");
      if (gate.kind === "unavailable") details.push(gate.failures[0].detail);
    }
    expect(details[0]).toContain("연결되지 않아");
    expect(details[1]).toContain("swiftc 를 찾을 수 없습니다");
    expect(details[2]).toContain("timed_out");
  });

  it("검사 중 입력이 바뀌면(stale) 한 번만 다시 돌리고, 두 번째도 stale 이면 정지한다", async () => {
    const stale = { status: "stale", run: run({ status: "stale" }), log: null } as VerificationOutcome;
    const once = vi.fn<(...args: unknown[]) => Promise<VerificationOutcome>>()
      .mockResolvedValueOnce(stale).mockResolvedValueOnce({ status: "succeeded", run: run(), reused: false });
    expect(await planCheckGate(parseCheck, { verification: verificationSatisfier(once) }, new AbortController().signal)).toEqual({ kind: "satisfied",
      results: [expect.objectContaining({ item: expect.objectContaining({ id: "C-1" }), status: "satisfied" })] });
    expect(once).toHaveBeenCalledTimes(2);
    const twice = vi.fn(async () => stale);
    expect((await planCheckGate(parseCheck, { verification: verificationSatisfier(twice) }, new AbortController().signal)).kind).toBe("unavailable");
    expect(twice).toHaveBeenCalledTimes(2);
  });

  // 79fc4fc5 F006 — 상태 전이는 집계(실행 불가가 있으면 정지)로 정하되, 사실에 쓸 항목별 실제 결과는 버리지 않는다.
  it("실패와 실행 불가가 섞이면 집계는 실행 불가이고, 항목별 실제 결과를 함께 돌려준다", async () => {
    const two = parsePlanChecks(checks(`{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"swift-parse"},`
      + `{"id":"C-2","kind":"verification","profile":"swift-concurrency-policy"}]}`));
    const ensure = vi.fn(async (profile: string): Promise<VerificationOutcome> => {
      if (profile === "swift-parse") return { status: "failed", run: run({ status: "failed" }), log: { stdout: "", stderr: "a.swift:1:1: error" } };
      throw new Error("swift-frontend 를 찾을 수 없습니다");
    });
    const gate = await planCheckGate(two, { verification: verificationSatisfier(ensure) }, new AbortController().signal);
    expect(gate.kind).toBe("unavailable");
    expect(gate.results.map((result) => [result.item.id, result.status])).toEqual([["C-1", "unsatisfied"], ["C-2", "unavailable"]]);
  });

  it("작업 취소는 판정하지 않고 그대로 던진다", async () => {
    const controller = new AbortController();
    const ensure = vi.fn(async () => { controller.abort(new Error("취소")); throw new Error("검사 대기가 취소되었습니다."); });
    await expect(planCheckGate(parseCheck, { verification: verificationSatisfier(ensure) }, controller.signal)).rejects.toThrow("취소");
  });
});
