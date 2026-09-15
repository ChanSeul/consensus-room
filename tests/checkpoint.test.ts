import { describe, expect, it } from "vitest";

import { accumulate, checkpointOpenRequests, requestId, workId, type WorkBinding } from "../src/server/engine/checkpoint";
import { completionVerdict, acceptResult, type OpenRequest } from "../src/server/engine/completion";
import type { AgentResult } from "../src/shared/contracts";

// PLAN §2 — 요청별 보존·id 결속 해소·논리 작업 id·완료 판정표.
function result(extra: Partial<AgentResult> = {}): AgentResult {
  return { kind: "IMPLEMENTATION", summary: "s", findings: [], evidenceRefs: [], ...extra };
}

describe("accumulate — 요청별 보존", () => {
  it("새 요청은 열린 요청 목록에 추가되고(덮지 않음), 같은 문구가 열린 채면 같은 요청이다", () => {
    const a = accumulate(null, result({ requestedUserDecision: "A?" }), [], 10);
    expect(a.openRequests.map((r) => r.text)).toEqual(["A?"]);
    const b = accumulate(a.result, result({ requestedUserDecision: "B?" }), a.openRequests, 20);
    expect(b.openRequests.map((r) => r.text)).toEqual(["A?", "B?"]);
    expect(b.result.requestedUserDecision).toContain(`[${b.openRequests[0].id}] A?`);
    expect(b.result.requestedUserDecision).toContain(`[${b.openRequests[1].id}] B?`);
    const again = accumulate(b.result, result({ requestedUserDecision: "A?" }), b.openRequests, 30);
    expect(again.openRequests).toHaveLength(2);
    expect(again.openRequests[0].id).toBe(a.openRequests[0].id);
  });
  it("요청 id 는 문구+제시 시점이다 — 해소된 뒤 나중에 다시 하면 새 요청", () => {
    expect(requestId("A?", 10)).not.toBe(requestId("A?", 40));
    expect(requestId("A?", 10)).toBe(requestId(" A? ", 10));
  });
  it("해소는 resolvedRequestId 가 열린 요청과 일치할 때만 그 요청 하나를 닫는다 — id 없음·불일치는 유지(진단 기록)", () => {
    const a = accumulate(null, result({ requestedUserDecision: "A?" }), [], 10);
    const b = accumulate(a.result, result({ requestedUserDecision: "B?" }), a.openRequests, 20);
    const noId = accumulate(b.result, result({ resolvesRequestedDecision: true }), b.openRequests, 30);
    expect(noId.openRequests).toHaveLength(2);
    expect(noId.unmatchedResolution).toContain("resolvedRequestId 가 없어");
    const wrong = accumulate(b.result, result({ resolvesRequestedDecision: true, resolvedRequestId: "Q-deadbeef" }), b.openRequests, 30);
    expect(wrong.openRequests).toHaveLength(2);
    expect(wrong.unmatchedResolution).toContain("Q-deadbeef");
    const right = accumulate(b.result, result({ resolvesRequestedDecision: true, resolvedRequestId: b.openRequests[0].id }), b.openRequests, 30);
    expect(right.openRequests.map((r) => r.text)).toEqual(["B?"]);
    expect(right.resolvedRequests.map((r) => r.text)).toEqual(["A?"]);
    expect(right.result.requestedUserDecision).toContain("B?");
    expect(right.result.requestedUserDecision).not.toContain("A?");
    expect(right.result.resolvesRequestedDecision).toBeUndefined();
  });
  it("결정이 도착했다는 사실만으로는 아무 요청도 지워지지 않는다(보류 결정) — accumulate 는 결정을 보지 않는다", () => {
    const a = accumulate(null, result({ requestedUserDecision: "A?" }), [], 10);
    const next = accumulate(a.result, result({ status: "completed", summary: "다른 것부터 했다" }), a.openRequests, 20);
    expect(next.openRequests).toHaveLength(1);
    expect(next.result.requestedUserDecision).toContain("A?");
  });
});

describe("workId — 논리 작업 id", () => {
  const base: WorkBinding = { kind: "FIX", resumeState: "CLAUDE_FIX", scopeGeneration: 1, planEpoch: 2, planSHA256: "a".repeat(64), sessionId: "s" };
  it("수정 작업은 원본 리뷰 산출물(종류#revision)로 구분된다 — 사용자 승인으로 연 3차 수정도 2차와 다른 작업; 세션 id 는 작업 id 에 들어가지 않는다", () => {
    expect(workId({ ...base, fixSource: "codex-final-review#1" })).not.toBe(workId({ ...base, fixSource: "codex-final-review#2" }));
    expect(workId({ ...base, fixSource: "codex-review#1" })).not.toBe(workId({ ...base, fixSource: "codex-final-review#1" }));
    expect(workId({ ...base, fixSource: "codex-review#1", sessionId: "other" })).toBe(workId({ ...base, fixSource: "codex-review#1" }));
    expect(workId({ ...base, planEpoch: 3 })).not.toBe(workId(base));
    expect(workId({ ...base, kind: "IMPLEMENTATION", resumeState: "IMPLEMENTING" })).not.toContain("codex-");
  });
});

describe("completionVerdict — 판정표", () => {
  const open: OpenRequest = { id: "Q-00000001", text: "A?", askedAfterSequence: 1 };
  it("blocked → 입력 대기; 열린 요청+결정 없음 → 입력 대기; 열린 요청+결정 있음 → 상태 확인 필요", () => {
    expect(completionVerdict(result({ status: "blocked" }), { openRequests: [], decisionAfterRequest: false }).kind).toBe("await-input");
    const waiting = completionVerdict(result({ status: "completed" }), { openRequests: [open], decisionAfterRequest: false });
    expect(waiting).toMatchObject({ kind: "await-input", reason: "requested-decision" });
    const confirm = completionVerdict(result({ status: "completed" }), { openRequests: [open], decisionAfterRequest: true });
    expect(confirm).toMatchObject({ kind: "needs-confirmation", reason: "open-request-after-decision" });
  });
  it("status 없음 → 상태 확인 필요(신규·기존 구분 없음); completed+remainingSteps → 모순; in_progress → 계속; completed → 완료", () => {
    expect(completionVerdict(result(), { openRequests: [], decisionAfterRequest: false })).toMatchObject({ kind: "needs-confirmation", reason: "status-missing" });
    expect(completionVerdict(result({ status: "completed", remainingSteps: ["P4"] }), { openRequests: [], decisionAfterRequest: false })).toMatchObject({ kind: "needs-confirmation", reason: "contradiction" });
    expect(completionVerdict(result({ status: "in_progress", remainingSteps: ["P4"] }), { openRequests: [], decisionAfterRequest: false })).toMatchObject({ kind: "continue", remainingSteps: ["P4"] });
    expect(completionVerdict(result({ status: "completed" }), { openRequests: [], decisionAfterRequest: false }).kind).toBe("completed");
  });
  it("requiresUserDecision 쟁점·EXTERNAL_EVIDENCE 처분은 status 보다 먼저 입력·증거 대기다", () => {
    const finding = { id: "F-1", title: "t", severity: "HIGH" as const, disposition: "EXTERNAL_EVIDENCE" as const, rationale: "증거 필요", evidenceRefs: [], requiresUserDecision: false };
    expect(completionVerdict(result({ status: "completed", findings: [finding] }), { openRequests: [], decisionAfterRequest: false })).toMatchObject({ kind: "await-input", reason: "external-evidence" });
    expect(completionVerdict(result({ status: "completed", findings: [{ ...finding, disposition: "AGREED_ACTION", requiresUserDecision: true }] }), { openRequests: [], decisionAfterRequest: false })).toMatchObject({ kind: "await-input", reason: "finding-decision" });
  });
  it("acceptResult 는 완료 판정에서만 만들 수 있다", () => {
    const verdict = completionVerdict(result({ status: "completed" }), { openRequests: [], decisionAfterRequest: false });
    expect(acceptResult(result({ status: "completed" }), verdict).kind).toBe("IMPLEMENTATION");
    expect(() => acceptResult(result(), { kind: "continue", remainingSteps: [] })).toThrow("완료 판정이 아닌");
  });
});


describe("R10 runner request preservation", () => {
  it.each(["finding", "blocked"] as const)("%s survives a later completed response until its request id is resolved", (form) => {
    const input = form === "blocked" ? result({ status: "blocked", summary: "사용자 승인 필요" })
      : result({ status: "completed", findings: [{ id: "F-1", title: "승인", severity: "HIGH", disposition: "AGREED_NO_ACTION", rationale: "사용자 승인 필요", evidenceRefs: [], requiresUserDecision: true }] });
    const first = accumulate(null, input, [], 10);
    expect(first.openRequests).toHaveLength(1);
    expect(checkpointOpenRequests({ accumulated: input, openRequests: [], inputSequence: 10 })).toEqual(first.openRequests);
    const next = accumulate(first.result, result({ status: "completed" }), first.openRequests, 20);
    expect(next.openRequests).toEqual(first.openRequests);
    expect(completionVerdict(next.result, { openRequests: next.openRequests, decisionAfterRequest: false }).kind).toBe("await-input");
    const resolved = accumulate(next.result, result({ status: "completed", resolvesRequestedDecision: true, resolvedRequestId: first.openRequests[0].id }), next.openRequests, 30);
    expect(resolved.openRequests).toEqual([]);
  });
});
