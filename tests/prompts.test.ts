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
  // 원문 사실의 두 절 머리말과, 프롬프트에서 한 절(머리말부터 다음 빈 줄 전까지)만 잘라 보는 도구 — 절이 없으면 빈 문자열이다.
  const CHANGED_SOURCES = "바뀐 원문(영향은 이 세션이 판단합니다):";
  const SOURCE_ERRORS = "이 전달 구간의 원문 조회 오류 — 내용 변경을 뜻하지 않으며 현재 복구 여부는 별도입니다:";
  const section = (prompt: string, heading: string) => {
    const start = prompt.indexOf(heading);
    if (start < 0) return "";
    const end = prompt.indexOf("\n\n", start);
    return prompt.slice(start, end < 0 ? undefined : end);
  };

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
      sourceChanges: [{ sourceId: "jira:PROJECT-1", title: "요구사항", previousRevision: "3", revision: "4", changePath: "/d/sources/jira-4.diff" }],
      sourceErrors: [{ sourceId: "figma:node-9", error: "429 rate limited" }],
      checks: [{ id: "npm test", status: "failed", logPath: "/d/checks/1.log", summary: "2 failed" }],
    });

    expect(prompt.split(reviewerMessage)).toHaveLength(2);
    expect(prompt).toContain("코드 리뷰어 응답 원문 시작");
    for (const part of ["[#12 codex/decision]", "jira:PROJECT-1 (요구사항): revision 3 → 4 · 변경분 `/d/sources/jira-4.diff`",
      "figma:node-9: 조회 오류: 429 rate limited", "npm test: failed · 로그 `/d/checks/1.log`", "2 failed"]) expect(prompt).toContain(part);
    // 실제 변경과 조회 오류가 섞이면 두 절로 나뉜다 — 「바뀐 원문」 절에는 변경 줄만, 조회 오류 절에는 오류 줄만 있다(1214e8c1).
    const changed = section(prompt, CHANGED_SOURCES);
    const failed = section(prompt, SOURCE_ERRORS);
    expect(changed).toContain("jira:PROJECT-1 (요구사항)");
    expect(changed).not.toContain("figma:node-9");
    expect(failed).toContain("figma:node-9: 조회 오류: 429 rate limited");
    expect(failed).not.toContain("jira:PROJECT-1");
    for (const part of ["역할:", "과제:", "작업 폴더:", "outcome:"]) expect(prompt).not.toContain(part);
    expectNoRetiredObligation(prompt);
  });

  // 1214e8c1 — 조회 오류만 있는 구간을 「바뀐 원문」으로 보이지 않는다. 오류 줄은 사건마다 한 줄인 기존 형식 그대로 별도 절에 둔다.
  it("조회 오류만 있으면 「바뀐 원문」 머리말 없이 조회 오류 절만 싣고, 변경만 있으면 기존 절 하나다 — 첫 턴과 이어지는 턴이 같다", () => {
    const errors = [{ sourceId: "bfe60abc", error: "앱 연결 응답 시간이 지났습니다." }, { sourceId: "bfe60abc", error: "앱 연결 응답 시간이 지났습니다." },
      { sourceId: "bf7ccdef", error: "다른 수집이 먼저 갱신한 원문입니다. 처음부터 다시 수집하세요." }];
    const relay = buildRelayPrompt({ sourceErrors: errors });
    const first = buildFirstTurnPrompt({ role: "implementer", title: "지역 조회 전환", worktreePath: "/w/t", sourceErrors: errors });
    for (const prompt of [relay, first]) {
      expect(prompt).not.toContain("바뀐 원문");
      expect(section(prompt, SOURCE_ERRORS).split("\n").slice(1)).toEqual([
        "- bfe60abc: 조회 오류: 앱 연결 응답 시간이 지났습니다.", "- bfe60abc: 조회 오류: 앱 연결 응답 시간이 지났습니다.",
        "- bf7ccdef: 조회 오류: 다른 수집이 먼저 갱신한 원문입니다. 처음부터 다시 수집하세요."]);
    }

    const changedOnly = buildRelayPrompt({ sourceChanges: [{ sourceId: "jira:A-1", previousRevision: "3", revision: "4" }] });
    expect(changedOnly).toBe(`${CHANGED_SOURCES}\n- jira:A-1: revision 3 → 4`);
  });

  it("새 입력이 없는 계속 턴은 한 줄이다", () => {
    expect(buildRelayPrompt({})).toBe("새 입력이 없습니다. 이어서 진행하세요.");
  });

  // 결정 원문 묶음(2026-10-14 자문 8) — 사용자 결정은 색인으로 본문 공유·파일 위치를 정하고, 색인·경로는 새 입력이 없어도 매 턴 싣는다.
  it("같은 본문의 결정은 처음 순번을, 긴 고유 본문은 원문 파일 구간을 가리키고 순번·출처는 남긴다 — 짧은 고유 결정은 종전과 같다", () => {
    const long = `LONG-DESIGN ${"설계 문단. ".repeat(700)}`;
    const origin = { stageId: "cp0-prep", topicId: "cp0-topic", sequence: 3, scopeGeneration: 1 };
    const decisionSources = { path: "/d/topics/t/artifacts/abc", version: 2, sha256: "f".repeat(64), entries: [
      { sequence: 3, origin: null, sha256: "a".repeat(64), chars: long.length, sameAs: null },
      { sequence: 7, origin: null, sha256: "b".repeat(64), chars: 14, sameAs: null },
      { sequence: 9, origin, sha256: "a".repeat(64), chars: long.length, sameAs: 3 },
    ] };
    const prompt = buildRelayPrompt({ decisionSources, messages: [
      { sequence: 3, actor: "user", kind: "decision", body: long },
      { sequence: 7, actor: "user", kind: "decision", body: "SHORT-DECISION" },
      { sequence: 9, actor: "user", kind: "decision", body: `승계 결정 — 단계 cp0-prep(…):\n\n${long}` },
      { sequence: 10, actor: "user", kind: "note", body: "NOTE-BODY" },
    ] });

    expect(prompt).not.toContain("LONG-DESIGN");
    expect(prompt).toContain(`[#3 user/decision] 이 토픽 · ${long.length}자 · sha256 ${"a".repeat(12)}\n본문이 길어 결정 원문 파일의 \`===== 결정 #3 원문 시작 · sha256 ${"a".repeat(12)} =====\` 구간에 둡니다.`);
    expect(prompt).toContain(`[#9 user/decision] 승계: 단계 cp0-prep(토픽 cp0-topic #3, 범위 세대 1) · ${long.length}자 · sha256 ${"a".repeat(12)}\n본문은 #3 결정과 같습니다 — 결정 원문 파일의 \`===== 결정 #3 원문 시작 · sha256 ${"a".repeat(12)} =====\` 구간.`);
    expect(prompt).toContain("[#7 user/decision]\nSHORT-DECISION");
    expect(prompt).toContain("[#10 user/note]\nNOTE-BODY");
    expect(prompt).toContain(`결정 원문 파일(읽기 허용 · 판 2 · sha256 ${"f".repeat(12)} · 결정 3건): \`/d/topics/t/artifacts/abc\``);
    expect(prompt).toContain(`- #9 승계: 단계 cp0-prep(토픽 cp0-topic #3, 범위 세대 1) · ${long.length}자 · 본문은 #3 과 같음`);
    expectNoRetiredObligation(prompt);
    // 색인은 새 사실이 아니다 — 새 입력이 없는 계속 턴은 종전 문구 뒤에 색인만 붙는다. 첫 턴도 같은 색인을 싣는다.
    const idle = buildRelayPrompt({ decisionSources });
    expect(idle.startsWith("새 입력이 없습니다. 이어서 진행하세요.\n\n결정 원문 파일(읽기 허용")).toBe(true);
    expect(buildFirstTurnPrompt({ role: "implementer", title: "T", worktreePath: "/w", decisionSources })).toContain("- #3 이 토픽 ·");
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

  // 계획 항목 coverage(2026-10-11) — 승인 계획 사실은 항목 id 를 매 턴 싣고(기존 세션도 의무를 안다), 역할 지침은 plan-items 선언·항목별 보고·판정을 설명한다.
  it("승인 계획 사실은 항목 id 를 매 턴 싣고, 역할 지침은 plan-items 선언·항목별 보고·판정을 설명한다", () => {
    const relay = buildRelayPrompt({ plan: { status: "approved", version: "e".repeat(64), snapshotPath: "/d/plan-v1", items: ["R-1", "R-2"] } });
    expect(relay).toContain("승인 계획 항목(2개): R-1, R-2");
    expect(relay).toContain("planItems");
    expect(buildRelayPrompt({ plan: { status: "approved", version: "e".repeat(64), snapshotPath: "/d/plan-v1" } })).not.toContain("승인 계획 항목");
    expectNoRetiredObligation(relay);
    const planner = buildFirstTurnPrompt({ role: "planner", title: "t", worktreePath: "/w", planDirectory: "/d/plan" });
    expect(planner).toContain("```plan-items");
    expect(planner).toContain('"requirement"');
    const reviewer = buildFirstTurnPrompt({ role: "plan-reviewer", title: "t", worktreePath: "/w" });
    expect(reviewer).toContain("plan-items");
    const implementer = buildFirstTurnPrompt({ role: "implementer", title: "t", worktreePath: "/w" });
    expect(implementer).toContain("implemented 또는 not-implemented");
    const codeReviewer = buildFirstTurnPrompt({ role: "code-reviewer", title: "t", worktreePath: "/w" });
    expect(codeReviewer).toContain("전 항목 satisfied");
    for (const prompt of [planner, reviewer, implementer, codeReviewer]) expectNoRetiredObligation(prompt);
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
      sourceChanges: [{ sourceId: "jira:A-1", previousRevision: "3", revision: "4", previousHash: "h3", hash: "h4", changePath: "/s/a.diff" }],
      sourceErrors: [{ sourceId: "figma:9", error: "429" }],
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

// host-review F001 — 상대 봉투의 항목별 보고·판정(planItems)은 원문 경계 줄 뒤에 그대로 목록으로 실린다. 없으면 그 절이 없다.
describe("상대 봉투의 항목별 보고·판정(planItems) 전달", () => {
  it("리뷰어의 항목별 판정 원문(id·status·evidence)을 구현자 프롬프트에 그대로 싣고, 없으면 싣지 않는다", () => {
    const withItems = buildRelayPrompt({ counterpart: { role: "code-reviewer", message: "R-2 를 보완하세요.",
      planItems: [{ id: "R-1", status: "satisfied", evidence: "feature.txt 확인" }, { id: "R-2", status: "unimplemented", evidence: "REV-EV README 가 없습니다" }] } });
    expect(withItems).toContain("코드 리뷰어 응답 원문 시작");
    expect(withItems).toContain("코드 리뷰어의 항목별 보고·판정(planItems):\n- R-1 satisfied — feature.txt 확인\n- R-2 unimplemented — REV-EV README 가 없습니다");
    for (const planItems of [undefined, null, []]) {
      expect(buildRelayPrompt({ counterpart: { role: "implementer", message: "구현했습니다.", planItems } })).not.toContain("항목별 보고·판정");
    }
    expect(buildRelayPrompt({ counterpart: { role: "implementer", message: "구현했습니다.", planItems: [{ id: "R-1", status: "implemented", evidence: "IMPL-EV 12행" }] } }))
      .toContain("구현자의 항목별 보고·판정(planItems):\n- R-1 implemented — IMPL-EV 12행");
  });
});
