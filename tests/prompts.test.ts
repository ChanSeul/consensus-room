import { describe, expect, it } from "vitest";

import type { TimelineEvent } from "../src/shared/contracts";
import { buildFirstTurnPrompt, buildRelayPrompt, relayFactsFrom, buildEnvelopeCorrectionPrompt } from "../src/shared/prompts";

describe("역할별 원문 왕복 프롬프트", () => {
  // 옛 계획 의무(처분·허용 오차·ACK·계획 해시·필수 절·완료 선언·심각도 정책)가 새 빌더에 옮겨 오지 않았는지 본다.
  const RETIRED_OBLIGATIONS = ["disposition", "AGREED_ACTION", "RESOLVED_BY_FIX", "DEFERRED_OUT_OF_SCOPE", "toleranceLedger", "허용 오차", "ACK",
    "planSHA256", "SHA-256", "findings", "requestedUserDecision", "remainingSteps", "status=", "목표와 완료 기준", "planMarkdown", "planEdits", "심각도"];
  // 결과 형식(CLI 스키마)과 memoryUpdates·engineDefects 쓰임(어댑터의 실행 규칙·메모리 안내)을 다시 설명하지 않는다.
  const DUPLICATED_FORMAT = ["봉투 JSON", "memoryUpdates", "engineDefects"];
  const expectNoRetiredObligation = (prompt: string) => {
    for (const phrase of [...RETIRED_OBLIGATIONS, ...DUPLICATED_FORMAT]) expect(prompt, phrase).not.toContain(phrase);
  };
  const reviewerMessage = "## 지적\n\n1. `src/a.ts:12` 취소 경로에서 잠금을 놓지 않습니다 — **고쳐 주세요**.\n```ts\nawait lock.release()\n```\n";

  it("구현자 첫 턴은 과제·작업 폴더·근거 위치·지금까지의 메시지를 싣고 ticket 전환 토픽의 남은 계획은 참고 경로로만 알린다", () => {
    const prompt = buildFirstTurnPrompt({
      role: "implementer", title: "매물등록 Step2 수정", task: "TASK-BODY-MARKER", worktreePath: "/w/topic", branchName: "consensus/topic-g1",
      baseRef: "b".repeat(40), references: [{ label: "결정 원문", path: "/d/decisions.md" }],
      messages: [{ sequence: 7, actor: "user", kind: "decision", body: "DECISION-MARKER" }],
      plan: { status: "reference", version: "c".repeat(64), snapshotPath: "/d/generation-1/plan" },
    });

    for (const part of ["역할: 구현자", "TASK-BODY-MARKER", "/w/topic", "consensus/topic-g1", "b".repeat(40), "/d/decisions.md", "[#7 user/decision]", "DECISION-MARKER",
      "/d/generation-1/plan", "따를 의무는 없습니다", "outcome: done"]) expect(prompt).toContain(part);
    expect(prompt).not.toContain("구현 범위입니다");
    expectNoRetiredObligation(prompt);
  });

  it("이어지는 턴은 상대 응답 원문을 그대로 한 번 싣고 새 사실만 덧붙인다 — 과제·지침을 다시 싣지 않는다", () => {
    const prompt = buildRelayPrompt({
      counterpart: { role: "code-reviewer", message: reviewerMessage },
      messages: [{ sequence: 12, actor: "codex", kind: "decision", body: "중재자 결정: 잠금 해제는 finally 에서." }],
      sourceChanges: [{ sourceId: "jira:DEVSCRUM-1", title: "요구사항", previousRevision: "3", revision: "4", changePath: "/d/sources/jira-4.diff" },
        { sourceId: "figma:node-9", error: "429 rate limited" }],
      checks: [{ id: "npm test", status: "failed", logPath: "/d/checks/1.log", summary: "2 failed" }],
    });

    expect(prompt.split(reviewerMessage)).toHaveLength(2);
    expect(prompt).toContain("코드 리뷰어 응답 원문 시작");
    for (const part of ["[#12 codex/decision]", "jira:DEVSCRUM-1 (요구사항): revision 3 → 4 · 변경분 `/d/sources/jira-4.diff`",
      "figma:node-9: 조회 오류: 429 rate limited", "npm test: failed · 로그 `/d/checks/1.log`", "2 failed"]) expect(prompt).toContain(part);
    for (const part of ["역할:", "과제:", "작업 폴더:", "outcome:"]) expect(prompt).not.toContain(part);
    expectNoRetiredObligation(prompt);
  });

  it("새 입력이 없는 계속 턴은 한 줄이다", () => {
    expect(buildRelayPrompt({})).toBe("새 입력이 없습니다. 이어서 진행하세요.");
  });

  it("계획 리뷰어는 같은 계획의 버전과 직전 판 대비 변경분 경로를 받고, 플래너 첫 턴은 계획 폴더 없이 만들지 않는다", () => {
    const relay = buildRelayPrompt({
      counterpart: { role: "planner", message: "리뷰 지적 1·2 를 반영했습니다." },
      plan: { status: "current", version: "d".repeat(64), snapshotPath: "/d/plan-v3", diffPath: "/d/plan-v3.diff" },
    });
    expect(relay).toContain(`계획 버전 ${"d".repeat(64)}: \`/d/plan-v3\` · 직전 판 대비 변경분: \`/d/plan-v3.diff\``);
    expectNoRetiredObligation(relay);

    const planner = buildFirstTurnPrompt({ role: "planner", title: "Swift 6 전환", worktreePath: "/w/t", planDirectory: "/d/generation-1/plan" });
    expect(planner).toContain("`/d/generation-1/plan` 폴더의 Markdown 파일");
    expectNoRetiredObligation(planner);
    expect(() => buildFirstTurnPrompt({ role: "planner", title: "Swift 6 전환", worktreePath: "/w/t" })).toThrow("planDirectory");
  });

  it("논의 발언 원문은 첫 턴에만 그대로 싣고, 없으면 절을 만들지 않는다 — 이어지는 턴의 사실 렌더에는 논의 절이 없다", () => {
    const discussion = [
      { sequence: 4, actor: "planner", kind: "brainstorm", body: "DISCUSSION-A\n- 비교 실험부터" },
      { sequence: 5, actor: "reviewer", kind: "brainstorm", body: "DISCUSSION-B" },
    ];
    const planner = buildFirstTurnPrompt({ role: "planner", title: "Swift 6 전환", worktreePath: "/w/t", planDirectory: "/d/plan", discussion,
      messages: [{ sequence: 6, actor: "user", kind: "decision", body: "DECISION-MARKER" }] });
    expect(planner).toContain("논의 발언 원문:\n[#4 planner]\nDISCUSSION-A\n- 비교 실험부터\n\n[#5 reviewer]\nDISCUSSION-B");
    expect(planner.indexOf("논의 발언 원문")).toBeLessThan(planner.indexOf("중재자·사용자 메시지"));
    expectNoRetiredObligation(planner);

    expect(buildFirstTurnPrompt({ role: "plan-reviewer", title: "Swift 6 전환", worktreePath: "/w/t", discussion: [] })).not.toContain("논의 발언 원문");
    expect(buildRelayPrompt({ messages: [{ sequence: 6, actor: "user", kind: "decision", body: "DECISION-MARKER" }] })).not.toContain("논의 발언 원문");
  });

  it("사실 이벤트는 사용자 메시지·최신 계획 판·원문 변경·검사 결과로 옮기고, 형식이 다른 사실 표식은 빼지 않고 원본째 메시지로 보인다", () => {
    const event = (sequence: number, actor: TimelineEvent["actor"], body: string, payload: Record<string, unknown> = {}, kind: TimelineEvent["kind"] = "system"): TimelineEvent =>
      ({ id: sequence, topicId: "t", sequence, scopeGeneration: 1, actor, kind, state: "IMPLEMENTING", body, payload, createdAt: "2026-10-08T00:00:00.000Z" });
    const facts = relayFactsFrom([
      event(5, "user", "중재자 결정 본문", {}, "decision"),
      event(4, "system", "엔진 내부 기록 — 사실 아님"),
      event(6, "system", "v1", { workerFact: { kind: "plan-version", version: "v1", snapshotPath: "/p/v1", diffPath: null, previous: null } }),
      event(7, "system", "v2", { workerFact: { kind: "plan-version", version: "v2", snapshotPath: "/p/v2", diffPath: "/p/v2.diff", previous: "v1" } }),
      event(8, "system", "원문", { workerFact: { kind: "source-change", sourceId: "jira:A-1", before: { revision: "3", contentHash: "h3" }, after: { revision: "4", contentHash: "h4" }, diffPath: "/s/a.diff" } }),
      event(9, "system", "오류", { workerFact: { kind: "source-error", sourceId: "figma:9", error: "429" } }),
      event(10, "system", "모드", { workerFact: { kind: "workflow-mode", from: "planned", to: "ticket", resumeState: "IMPLEMENTING", reason: "작은 수정" } }),
      event(11, "system", "검사", { workerFact: { kind: "check-result", checks: [{ id: "npm test", status: "failed", summary: "2 failed" }] } }),
    ]);

    expect(facts).toEqual({
      messages: [{ sequence: 5, actor: "user", kind: "decision", body: "중재자 결정 본문" },
        { sequence: 10, actor: "system", kind: "workflow-mode", body: "작업 방식이 planned 에서 ticket 로 바뀌었습니다. 사유: 작은 수정" }],
      plan: { status: "current", version: "v2", snapshotPath: "/p/v2", diffPath: "/p/v2.diff" },
      sourceChanges: [{ sourceId: "jira:A-1", previousRevision: "3", revision: "4", previousHash: "h3", hash: "h4", changePath: "/s/a.diff" },
        { sourceId: "figma:9", error: "429" }],
      checks: [{ id: "npm test", status: "failed", summary: "2 failed" }],
    });
    const broken = relayFactsFrom([event(3, "system", "깨진 표식", { workerFact: { kind: "source-change" } })]);
    expect(broken.messages).toEqual([expect.objectContaining({ sequence: 3, actor: "system", kind: "worker-fact-invalid" })]);
    expect(broken.messages![0].body).toContain('"kind":"source-change"');
    expect(broken.messages![0].body).toContain("sourceId");
  });

  // 작업 묶음 개정 사실(v3.18 (33')·(33'a)) — 본문은 개정 시점의 단계 문맥 전체이고, 한 번에 받은 개정 가운데 가장 최근 하나만 싣는다.
  it("작업 묶음 개정 사실은 단계 문맥 본문 전체를 system 메시지로 싣고, 여러 개정이 함께 오면 최근 것만 남기며, 형식이 틀리면 원본째 보인다", () => {
    const event = (sequence: number, actor: TimelineEvent["actor"], body: string, payload: Record<string, unknown> = {}, kind: TimelineEvent["kind"] = "system"): TimelineEvent =>
      ({ id: sequence, topicId: "t", sequence, scopeGeneration: 1, actor, kind, state: "IMPLEMENTING", body, payload, createdAt: "2026-10-09T00:00:00.000Z" });
    const revision = (version: number, context: string) => ({ workerFact: { kind: "work-group-revision", groupId: "g-1", stageId: "api", version, context } });
    const oldContext = "## 단계 api\n목표: 옛 목표 OLD-GOAL\n";
    const newContext = "## 단계 api\n목표: 새 목표 NEW-GOAL\n\n## 공통 계약\n- 응답은 JSON 이다.\n- 질문: 페이지 크기는? → 50\n";
    const facts = relayFactsFrom([
      event(5, "system", "개정 v2", revision(2, oldContext)),
      event(6, "user", "중재자 결정 본문", {}, "decision"),
      event(8, "system", "개정 v3", revision(3, newContext)),
    ]);

    expect(facts.messages).toEqual([
      { sequence: 6, actor: "user", kind: "decision", body: "중재자 결정 본문" },
      { sequence: 8, actor: "system", kind: "work-group-revision", body: `작업 묶음 g-1 이 v3 로 개정됐습니다. 단계 api 의 개정 시점 문맥:\n${newContext}` },
    ]);
    const prompt = buildRelayPrompt(facts);
    expect(prompt).toContain(newContext);
    expect(prompt).not.toContain("OLD-GOAL");
    expectNoRetiredObligation(prompt);

    for (const broken of [
      { kind: "work-group-revision", groupId: "g-1", version: 3, context: newContext },
      { kind: "work-group-revision", groupId: "g-1", stageId: "api", version: "3", context: newContext },
      { kind: "work-group-revision", groupId: "g-1", stageId: "api", version: 1.5, context: newContext },
      { kind: "work-group-revision", groupId: "g-1", stageId: "api", version: 3, context: "" },
    ]) {
      const result = relayFactsFrom([event(9, "system", "깨진 개정", { workerFact: broken })]);
      expect(result.messages).toEqual([expect.objectContaining({ sequence: 9, actor: "system", kind: "worker-fact-invalid" })]);
      expect(result.messages![0].body).toContain('"kind":"work-group-revision"');
    }
  });

  // 근거 선택 변경 사실(79fc4fc5 F011) — 실제 변경(카탈로그 버전·작업 그룹 연결)만 system 메시지로 싣는다. 재계획·세션 지시는 없다.
  it("근거 선택 변경 사실은 카탈로그 버전과 작업 그룹 연결만 system 메시지로 싣는다", () => {
    const event = (sequence: number, payload: Record<string, unknown>): TimelineEvent =>
      ({ id: sequence, topicId: "t", sequence, scopeGeneration: 1, actor: "system", kind: "system", state: "IMPLEMENTING", body: "근거 선택", payload,
        createdAt: "2026-10-09T00:00:00.000Z" });
    const version = "c".repeat(64);
    const { messages } = relayFactsFrom([
      event(3, { workerFact: { kind: "evidence-selection", catalogVersion: version } }),
      event(4, { workerFact: { kind: "evidence-selection", catalogVersion: version, groupId: "g-1" } }),
      event(5, { workerFact: { kind: "evidence-selection", catalogVersion: version, groupId: null } }),
    ]);
    expect(messages!.map(message => [message.sequence, message.actor, message.kind]))
      .toEqual([[3, "system", "evidence-selection"], [4, "system", "evidence-selection"], [5, "system", "evidence-selection"]]);
    expect(messages![0].body).toContain(version.slice(0, 12));
    expect(messages![1].body).toContain("g-1");
    for (const message of messages!) {
      expectNoRetiredObligation(message.body);
      for (const phrase of ["다시 계획", "세션"]) expect(message.body).not.toContain(phrase);
    }
  });

  it("봉투 교정 문구는 위반과 이 역할의 outcome 만 싣고 작업을 다시 하라고 하지 않는다", () => {
    const prompt = buildEnvelopeCorrectionPrompt("code-reviewer", ["outcome: Invalid option"]);
    expect(prompt).toContain("outcome: Invalid option");
    expect(prompt).toContain("changes · approve · needs-mediator");
    expect(prompt).toContain("작업을 다시 하지 말고");
    expectNoRetiredObligation(prompt);
  });
});
