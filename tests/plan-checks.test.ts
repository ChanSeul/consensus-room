import { describe, expect, it, vi } from "vitest";

import { REQUIRED_PLAN_HEADINGS } from "../src/shared/contracts";
import { declaredVerificationProfiles, parsePlanChecks, planChecksGuide, VERIFICATION_PROFILE_IDS } from "../src/shared/planChecks";
import { assertPlanContract } from "../src/shared/workflow";
import { planCheckGate, verificationSatisfier } from "../src/server/engine/planCheckGate";
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

  it("계획 계약 안내는 kind 별 목록에 등록 프로필 전부를 싣고, 무거운 검사는 선언할 수 없다고 말한다", () => {
    const guide = planChecksGuide();
    for (const id of VERIFICATION_PROFILE_IDS) expect(guide).toContain(`\`${id}\``);
    expect(guide).toContain("- verification:");
    expect(guide).toContain("빌드·Simulator·E2E");
    expect(guide).toContain("블록이 없으면 필수 실행 검사가 없는 계획");
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
    expect(await planCheckGate([], { verification: verificationSatisfier(ensure) }, new AbortController().signal)).toEqual({ kind: "satisfied" });
    expect(ensure).not.toHaveBeenCalled();
  });

  it("성공·대상 없음은 충족이다", async () => {
    for (const outcome of [{ status: "succeeded", run: run(), reused: true }, { status: "no-targets" }] as VerificationOutcome[]) {
      const ensure = vi.fn(async () => outcome);
      expect(await planCheckGate(parseCheck, { verification: verificationSatisfier(ensure) }, new AbortController().signal)).toEqual({ kind: "satisfied" });
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
    expect(await planCheckGate(parseCheck, { verification: verificationSatisfier(once) }, new AbortController().signal)).toEqual({ kind: "satisfied" });
    expect(once).toHaveBeenCalledTimes(2);
    const twice = vi.fn(async () => stale);
    expect((await planCheckGate(parseCheck, { verification: verificationSatisfier(twice) }, new AbortController().signal)).kind).toBe("unavailable");
    expect(twice).toHaveBeenCalledTimes(2);
  });

  it("작업 취소는 판정하지 않고 그대로 던진다", async () => {
    const controller = new AbortController();
    const ensure = vi.fn(async () => { controller.abort(new Error("취소")); throw new Error("검사 대기가 취소되었습니다."); });
    await expect(planCheckGate(parseCheck, { verification: verificationSatisfier(ensure) }, controller.signal)).rejects.toThrow("취소");
  });
});
