import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { AgentResult, Finding, Participant, TimelineEvent } from "../src/shared/contracts";
import { BranchNameSchema, CreateTopicInputSchema, REQUIRED_PLAN_HEADINGS } from "../src/shared/contracts";
import {
  buildClaudeFixPrompt,
  buildImplementationPrompt,
  buildClaudePlanPrompt,
  buildClaudeRevisionPrompt,
  buildCodexAuditPrompt,
  buildCodexCloseoutPrompt,
} from "../src/shared/prompts";
import {
  applyPlanEdits,
  assertImplementationGate,
  assertDispositionsResolved,
  assertFindingCoverage,
  assertFixDispositionAllowed,
  assertPlanContract,
  assertTransition,
  bothAgentsAcknowledged,
  classifyCloseout,
  dispositionRegressions,
  newFindingIDs,
  hashPlan,
  normalizePlan,
  redactSecrets,
  resetParticipantsForScopeChange,
  resolveBranchName,
  shouldRunFixPass,
  CARRIED_RATIONALE_PREFIX,
  CORRECTION_SUMMARY_SEPARATOR,
  carryForwardFindings,
  mergeCorrectionResult,
  salvageResultFields,
  implementationInProgress,
  isSettledFinding,
  mergeAgreedSources, mergeFindingSources, overruleDirectiveIDs
} from "../src/shared/workflow";

function completePlan(extra = ""): string {
  return `${REQUIRED_PLAN_HEADINGS.map((heading) => `## ${heading}\n\n내용${heading === "허용 오차" ? '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```' : ""}`).join("\n\n")}\n${extra}`;
}

function participants(sha: string | null): Participant[] {
  return [
    { role: "claude", sessionId: "claude-1", mode: "created", acknowledgedPlanSHA256: sha },
    { role: "codex", sessionId: "codex-1", mode: "created", acknowledgedPlanSHA256: sha },
  ];
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F-1",
    title: "취소 뒤 결과 반영",
    severity: "HIGH",
    disposition: "AGREED_ACTION",
    rationale: "늦게 도착한 결과가 현재 화면을 덮습니다.",
    evidenceRefs: ["src/view-model.ts:42"],
    requiresUserDecision: false,
    ...overrides,
  };
}

function closeout(overrides: Partial<AgentResult> = {}): AgentResult {
  return {
    kind: "CLOSEOUT",
    summary: "검토가 끝났습니다.",
    findings: [],
    evidenceRefs: [],
    ...overrides,
  };
}

describe("구현 브랜치 이름", () => {
  const base = {
    requestedBranchName: null as string | null,
    branchPrefix: "consensus",
    slug: "devscrum-9071-s0-1-rx-removal",
    id: "0f56d712-370c-400f-a834-d24b18980237",
    scopeGeneration: 1,
  };

  it("이름을 지정하지 않으면 접두사와 id·세대 접미사로 만든다", () => {
    expect(resolveBranchName(base))
      .toBe("consensus/devscrum-9071-s0-1-rx-removal-0f56d712-g1");
    expect(resolveBranchName({ ...base, branchPrefix: "refactoring", scopeGeneration: 2 }))
      .toBe("refactoring/devscrum-9071-s0-1-rx-removal-0f56d712-g2");
  });

  it("이름을 지정하면 접두사·slug 없이 그 이름을 base로 쓴다", () => {
    expect(resolveBranchName({ ...base, requestedBranchName: "refactoring/PROJECT-123" }))
      .toBe("refactoring/PROJECT-123-g1");
  });

  // 세대 접미사는 지정 이름에도 붙는다. 없으면 범위가 바뀌어도 이전 세대 브랜치를 이어 쓴다.
  it("범위 세대가 올라가면 지정 이름도 다른 브랜치가 된다", () => {
    const pinned = { ...base, requestedBranchName: "refactoring/PROJECT-123" };
    expect(resolveBranchName({ ...pinned, scopeGeneration: 3 })).toBe("refactoring/PROJECT-123-g3");
    expect(resolveBranchName({ ...pinned, scopeGeneration: 3 })).not.toBe(resolveBranchName(pinned));
  });
});

describe("계획 검토 상태", () => {
  it("사용자가 계획 검토를 시작하면 정해진 네 번의 왕복 순서만 허용한다", () => {
    const path = [
      ["DRAFT", "CLAUDE_PLAN"],
      ["CLAUDE_PLAN", "CODEX_AUDIT"],
      ["CODEX_AUDIT", "CLAUDE_REVISION"],
      ["CLAUDE_REVISION", "CODEX_CLOSEOUT"],
      ["CODEX_CLOSEOUT", "CONSENSUS_ACK"],
    ] as const;

    for (const [from, to] of path) {
      expect(() => assertTransition(from, to)).not.toThrow();
    }
  });

  it("사용자가 승인하지 않았는데 구현으로 건너뛰면 거부한다", () => {
    expect(() => assertTransition("CODEX_CLOSEOUT", "IMPLEMENTING")).toThrow(
      "허용되지 않은 상태 전이",
    );
  });
});

describe("계획 본문과 버전", () => {
  it("사용자가 완성된 계획을 제출하면 필수 절을 모두 확인한다", () => {
    expect(() => assertPlanContract(completePlan())).not.toThrow();
  });

  it("계획에서 실패·취소·복구 절이 빠지면 합의 단계로 보내지 않는다", () => {
    const incomplete = completePlan().replace("## 실패·취소·복구\n\n내용\n\n", "");

    expect(() => assertPlanContract(incomplete)).toThrow("실패·취소·복구");
  });

  it("같은 계획의 줄바꿈과 마지막 공백만 달라도 같은 SHA-256 버전으로 본다", () => {
    const plan = completePlan();
    const windowsLineEndings = `  ${plan.replace(/\n/g, "\r\n")}   `;

    expect(hashPlan(windowsLineEndings)).toBe(hashPlan(plan));
    expect(normalizePlan(windowsLineEndings)).toBe(normalizePlan(plan));
  });

  it("계획 내용이 실제로 바뀌면 새 버전으로 본다", () => {
    expect(hashPlan(completePlan("첫 안"))).not.toBe(hashPlan(completePlan("둘째 안")));
  });
});

describe("동일 계획 ACK와 사용자 승인", () => {
  it("두 모델과 사용자가 같은 계획 버전을 확인하면 구현을 시작할 수 있다", () => {
    const sha = hashPlan(completePlan());

    expect(bothAgentsAcknowledged(participants(sha), sha)).toBe(true);
    expect(() =>
      assertImplementationGate({
        state: "AWAITING_USER_APPROVAL",
        participants: participants(sha),
        planSHA256: sha,
        approvedPlanSHA256: sha,
      }),
    ).not.toThrow();
  });

  it("Claude만 새 계획을 확인하고 Codex는 예전 계획을 확인한 상태면 구현을 막는다", () => {
    const current = hashPlan(completePlan("현재"));
    const old = hashPlan(completePlan("이전"));
    const mismatched = participants(current);
    mismatched[1] = { ...mismatched[1], acknowledgedPlanSHA256: old };

    expect(() =>
      assertImplementationGate({
        state: "AWAITING_USER_APPROVAL",
        participants: mismatched,
        planSHA256: current,
        approvedPlanSHA256: current,
      }),
    ).toThrow("같은 계획 버전");
  });

  it("사용자가 이전 계획을 승인했다면 새 계획 구현을 막는다", () => {
    const current = hashPlan(completePlan("현재"));
    const approved = hashPlan(completePlan("승인했던 이전 계획"));

    expect(() =>
      assertImplementationGate({
        state: "AWAITING_USER_APPROVAL",
        participants: participants(current),
        planSHA256: current,
        approvedPlanSHA256: approved,
      }),
    ).toThrow("현재 계획 버전");
  });

  it("사용자가 범위를 바꾸면 기존 ACK를 모두 지운다", () => {
    const sha = hashPlan(completePlan());
    const reset = resetParticipantsForScopeChange(participants(sha));

    expect(reset.map((participant) => participant.acknowledgedPlanSHA256)).toEqual([null, null]);
    expect(bothAgentsAcknowledged(reset, sha)).toBe(false);
  });
});

describe("Codex 종결 판정", () => {
  it("Claude나 Codex가 앞 단계 finding을 조용히 빼면 합의로 닫지 않는다", () => {
    const source = [finding({ id: "F-1" }), finding({ id: "F-2" })];

    expect(() => assertFindingCoverage(source, [finding({ id: "F-2" })], "Claude revision"))
      .toThrow("F-1");
  });

  it("같은 응답에 finding ID가 중복되면 집계 전에 거부한다", () => {
    const response = [finding({ id: "F-1" }), finding({ id: "F-1" })];

    expect(() => assertFindingCoverage([], response, "Codex closeout"))
      .toThrow("중복된 finding ID");
  });

  it("마지막 검토가 Claude 개정에 없던 새 finding을 만들면 별도 재수렴 대상으로 찾는다", () => {
    const source = [finding({ id: "F-1" })];
    const response = [finding({ id: "F-1" }), finding({ id: "F-new" })];

    expect(newFindingIDs(source, response, "Codex closeout")).toEqual(["F-new"]);
  });

  it("모든 지적의 처분이 정해지면 합의 ACK로 이동한다", () => {
    const result = closeout({
      findings: [
        finding({ disposition: "AGREED_ACTION" }),
        finding({ id: "F-2", disposition: "REFUTED" }),
      ],
    });

    expect(classifyCloseout(result).state).toBe("CONSENSUS_ACK");
  });

  it("실행으로 확인해야 하는 지적이 남으면 근거 대기 상태로 멈춘다", () => {
    const result = closeout({ findings: [finding({ disposition: "EXTERNAL_EVIDENCE" })] });

    expect(classifyCloseout(result).state).toBe("BLOCKED_ON_EVIDENCE");
  });

  it("사용자가 정할 내용이 남으면 모델끼리 합의했다고 처리하지 않는다", () => {
    const result = closeout({ requestedUserDecision: "서버 계약을 바꿀까요?" });

    expect(classifyCloseout(result).state).toBe("USER_DECISION_REQUIRED");
  });

  it("실제로 고치기로 합의한 결함이 있을 때만 한 번의 수정 단계가 필요하다", () => {
    expect(shouldRunFixPass([finding({ disposition: "AGREED_ACTION" })])).toBe(true);
    expect(shouldRunFixPass([finding({ disposition: "AGREED_NO_ACTION" })])).toBe(false);
    expect(shouldRunFixPass([finding({ severity: "INFO", disposition: "AGREED_ACTION" })])).toBe(false);
  });
});

describe("단계 사이 처분 보존", () => {
  it("처분하지 않은 쟁점이 남은 응답은 다음 단계로 넘기지 않는다", () => {
    const result = closeout({
      kind: "REVISION",
      findings: [finding({ id: "F-1" }), finding({ id: "F-2", disposition: undefined })],
    });

    expect(() => assertDispositionsResolved(result.findings, result, "Claude revision")).toThrow("F-2");
  });

  it("모든 쟁점을 처분한 응답은 그대로 통과시킨다", () => {
    const result = closeout({
      findings: [finding({ id: "F-1", disposition: "REFUTED" }), finding({ id: "F-2" })],
    });

    expect(() => assertDispositionsResolved(result.findings, result, "Codex closeout")).not.toThrow();
  });

  it("앞 단계가 고치기로 합의한 쟁점을 뒤 단계가 강등하면 그 ID를 알려준다", () => {
    const source = [finding({ id: "F-1", disposition: "AGREED_ACTION" })];

    expect(dispositionRegressions(source, [finding({ id: "F-1", disposition: "AGREED_NO_ACTION" })])).toEqual(["F-1"]);
    expect(dispositionRegressions(source, [finding({ id: "F-1", disposition: "REFUTED" })])).toEqual(["F-1"]);
    expect(dispositionRegressions(source, [finding({ id: "F-1", disposition: "DEFERRED_OUT_OF_SCOPE" })]))
      .toEqual(["F-1"]);
  });

  it("수정 대상이 아닌 INFO 쟁점의 처분 변화는 강등으로 보지 않는다", () => {
    const source = [finding({ id: "F-1", severity: "INFO", disposition: "AGREED_ACTION" })];
    const response = [finding({ id: "F-1", severity: "INFO", disposition: "AGREED_NO_ACTION" })];

    expect(dispositionRegressions(source, response)).toEqual([]);
  });

  it("처분을 유지했거나 아직 처분하지 않았거나 외부 증거로 남긴 응답은 강등이 아니다", () => {
    const source = [finding({ id: "F-1", disposition: "AGREED_ACTION" })];

    expect(dispositionRegressions(source, [finding({ id: "F-1", disposition: "AGREED_ACTION" })])).toEqual([]);
    expect(dispositionRegressions(source, [finding({ id: "F-1", disposition: undefined })])).toEqual([]);
    expect(dispositionRegressions(source, [finding({ id: "F-1", disposition: "EXTERNAL_EVIDENCE" })])).toEqual([]);
  });
});

describe("수정으로 종결한 처분", () => {
  it("수정으로 종결한 처분은 강등으로 세지 않는다", () => {
    const source = [finding({ id: "F-1", disposition: "AGREED_ACTION" })];
    const response = [finding({ id: "F-1", disposition: "RESOLVED_BY_FIX" })];

    expect(dispositionRegressions(source, response)).toEqual([]);
    expect(shouldRunFixPass(response)).toBe(false);
  });

  it("수정이 아직 일어나지 않은 단계에서는 수정 종결 처분을 쓸 수 없다", () => {
    const claimed = [finding({ id: "F-1", disposition: "RESOLVED_BY_FIX" })];

    expect(() => assertFixDispositionAllowed(closeout({ findings: claimed }), "CLOSEOUT")).toThrow("F-1");
    expect(() => assertFixDispositionAllowed(closeout({ kind: "AUDIT", findings: claimed }), "AUDIT"))
      .toThrow("RESOLVED_BY_FIX");
    expect(() => assertFixDispositionAllowed(closeout({ kind: "FIX", findings: claimed }), "FIX")).not.toThrow();
    expect(() => assertFixDispositionAllowed(closeout({ kind: "FINAL_REVIEW", findings: claimed }), "FINAL_REVIEW"))
      .not.toThrow();
    // 구현도 수정이 실제로 일어나는 단계다 — 금지하면 정상 구현 턴이 통째로 거부된다(2026-09-01 S1.1 재현).
    expect(() => assertFixDispositionAllowed(closeout({ kind: "IMPLEMENTATION", findings: claimed }), "IMPLEMENTATION"))
      .not.toThrow();
  });

  it("수정으로 종결한 처분도 처분한 것으로 본다", () => {
    const result = closeout({ kind: "FIX", findings: [finding({ id: "F-1", disposition: "RESOLVED_BY_FIX" })] });

    expect(() => assertDispositionsResolved(result.findings, result, "Claude fix")).not.toThrow();
  });

  it("수정 중 새로 발견한 쟁점은 처분 전이어도 다음 단계로 넘긴다", () => {
    const carried = [finding({ id: "F-1", disposition: "AGREED_ACTION" })];
    const result = closeout({
      kind: "FIX",
      findings: [
        finding({ id: "F-1", disposition: "RESOLVED_BY_FIX" }),
        finding({ id: "F-NEW", disposition: undefined }),
      ],
    });

    expect(() => assertDispositionsResolved(carried, result, "Claude fix")).not.toThrow();
  });

  it("앞 단계 쟁점을 처분하지 않았으면 새 쟁점과 무관하게 막는다", () => {
    const carried = [finding({ id: "F-1", disposition: "AGREED_ACTION" })];
    const result = closeout({
      kind: "FIX",
      findings: [finding({ id: "F-1", disposition: undefined }), finding({ id: "F-NEW", disposition: undefined })],
    });

    expect(() => assertDispositionsResolved(carried, result, "Claude fix")).toThrow("F-1");
    expect(() => assertDispositionsResolved(carried, result, "Claude fix")).not.toThrow("F-NEW");
  });

  it("처분을 유지한 채 심각도만 조치 대상 밖으로 낮추는 것도 강등으로 본다", () => {
    const source = [finding({ id: "F-1", severity: "HIGH", disposition: "AGREED_ACTION" })];
    const lowered = [finding({ id: "F-1", severity: "INFO", disposition: "AGREED_ACTION" })];

    expect(dispositionRegressions(source, lowered)).toEqual(["F-1"]);
    // 심각도만 낮추면 이 판정이 false가 되어 전달 준비까지 통과한다 — 그래서 강등으로 세야 한다.
    expect(shouldRunFixPass(lowered)).toBe(false);
    expect(dispositionRegressions(source, [finding({ id: "F-1", severity: "LOW", disposition: "AGREED_ACTION" })]))
      .toEqual([]);
  });
});

describe("기록 전 비밀 값 제거", () => {
  it("사용자가 근거 로그를 올리면 인증값을 가리고 나머지 문장은 유지한다", () => {
    const raw = [
      "Authorization: Bearer abc.def.ghi",
      "api_key=secret-value",
      "password: hunter2",
      "OpenAI key sk-proj-1234567890abcdef",
      "GitHub ghp_12345678901234567890",
      "요청은 500으로 실패했습니다.",
    ].join("\n");

    const redacted = redactSecrets(raw);

    expect(redacted).not.toContain("abc.def.ghi");
    expect(redacted).not.toContain("secret-value");
    expect(redacted).not.toContain("hunter2");
    expect(redacted).not.toContain("sk-proj-");
    expect(redacted).not.toContain("ghp_");
    expect(redacted).toContain("요청은 500으로 실패했습니다.");
    expect(redacted.match(/\[REDACTED\]/g)?.length).toBe(5);
  });
});

// 서버는 감사 응답에 앞 단계 finding ID가 전부 있는지 assertFindingCoverage로 검사한다. 그 요구가
// 프롬프트에 없으면 Codex는 자기 쟁점만 반환하고 max 강도 턴이 통째로 버려진다(2026-08-29 실측 실패).
describe("Codex 감사 프롬프트와 ID 강제의 정합", () => {
  const auditFindings: Finding[] = ["R1", "E1-RESOLVED", "M1"].map((id) => ({
    id,
    title: `${id} 제목`,
    severity: "MEDIUM" as const,
    rationale: "근거",
    evidenceRefs: [],
    requiresUserDecision: false,
  }));

  function auditPrompt(findings: Finding[]): string {
    return buildCodexAuditPrompt({
      title: "주제",
      planMarkdown: "# 계획",
      planSHA256: "a".repeat(64),
      scopeGeneration: 1,
      timeline: [],
      claudePlan: { kind: "PLAN", summary: "요약", findings, evidenceRefs: [] } as AgentResult,
    });
  }

  it("계획의 모든 finding ID를 프롬프트에 명시하고 누락이 거부됨을 알린다", () => {
    const prompt = auditPrompt(auditFindings);

    for (const finding of auditFindings) expect(prompt).toContain(finding.id);
    // 나열만으로는 부족하다 — 누락하면 거부된다는 사실 자체를 프롬프트가 말해야 한다.
    expect(prompt).toContain("서버가 ID 누락을 기계적으로 검사해");
  });

  it("쟁점이 없으면 빈 목록 대신 '없음'을 넣어 문장이 깨지지 않게 한다", () => {
    expect(auditPrompt([])).toContain("없음");
  });
});

// agent_output payload(findings 배열)는 각 단계 프롬프트가 이미 명시적으로 전달하므로 타임라인 경유는
// 순수 중복이다(2026-08-30 실측: 타임라인 렌더 77K자 중 57K자). 사용자 메시지 payload는 유지한다.
describe("타임라인 렌더는 agent_output payload를 다시 싣지 않는다", () => {
  function event(overrides: Partial<TimelineEvent>): TimelineEvent {
    return {
      id: 1, topicId: "topic-1", sequence: 1, scopeGeneration: 1,
      actor: "claude", kind: "note", state: "CLAUDE_PLAN",
      body: "본문", payload: {}, createdAt: "2026-08-30T00:00:00.000Z",
      ...overrides,
    };
  }

  it("agent_output은 body만 싣고 payload의 findings는 뺀다", () => {
    const prompt = buildClaudePlanPrompt({
      title: "주제", worktreePath: "/tmp/worktree", sourceRepositoryPath: "/tmp/repo",
      baseRef: "develop", scopeGeneration: 1,
      timeline: [
        event({ id: 1, sequence: 1, kind: "agent_output", body: "감사 요약",
          payload: { findings: [{ id: "F-DUP", rationale: "타임라인 경유 중복 데이터" }] } }),
        event({ id: 2, sequence: 2, actor: "user", kind: "decision", body: "결정 본문",
          payload: { requestKey: "user-decision-1" } }),
      ],
    });

    expect(prompt).toContain("감사 요약");
    expect(prompt).not.toContain("F-DUP");
    expect(prompt).not.toContain("타임라인 경유 중복 데이터");
    // 사용자 메시지의 메타데이터는 계속 싣는다 — 프롬프트가 따로 전달하지 않는 유일한 출처다.
    expect(prompt).toContain("user-decision-1");
  });
});

// 세 번 같은 유형으로 깨졌다: 서버가 기계적으로 강제하는 규칙이 프롬프트에 없어 에이전트가 값을 추측했다.
// 처분 규칙은 assertFixDispositionAllowed가 검사하므로, 처분을 요구하는 모든 프롬프트가 그 규칙을 말해야 한다.
describe("처분 프롬프트와 단계 제약의 정합", () => {
  const revisionPrompt = buildClaudeRevisionPrompt({
    planMarkdown: "# 계획", audit: { kind: "AUDIT", summary: "s", findings: [], evidenceRefs: [] } as AgentResult,
    scopeGeneration: 1, timeline: [],
  });
  const closeoutPrompt = buildCodexCloseoutPrompt({
    revisedPlan: "# 계획", revisedPlanSHA256: "a".repeat(64),
    claudeRevision: { kind: "REVISION", summary: "s", findings: [], evidenceRefs: [] } as AgentResult,
    timeline: [],
  });
  const fixPrompt = buildClaudeFixPrompt({ planMarkdown: "# 계획", reviewFindings: [], timeline: [] });
  const implementationPrompt = buildImplementationPrompt({
    planMarkdown: "# 계획", planSHA256: "a".repeat(64), worktreePath: "/tmp/wt", branchName: "topic/x", timeline: [],
  });

  // 검사기(FIX_AWARE_KINDS)가 허용하는 단계는 프롬프트도 같은 계약을 말해야 한다 — 계약이 프롬프트에
  // 없으면 에이전트가 값을 추측하고 턴이 통째로 거부된다(2026-09-01 S1.1 구현 턴 거부 재현).
  it("수정이 일어나는 단계는 RESOLVED_BY_FIX를 쓸 수 있다는 사실을 말한다", () => {
    for (const prompt of [implementationPrompt, fixPrompt]) {
      expect(prompt).toContain("RESOLVED_BY_FIX를 쓸 수 있습니다");
      const allowed = prompt.slice(prompt.indexOf("처분(disposition)은 다음 값만 씁니다:"));
      expect(allowed.split("\n")[0]).toContain("RESOLVED_BY_FIX");
    }
  });

  it("수정 전 단계는 RESOLVED_BY_FIX가 거부된다는 사실을 말한다", () => {
    for (const prompt of [revisionPrompt, closeoutPrompt]) {
      expect(prompt).toContain("RESOLVED_BY_FIX를 쓰면 서버가 응답 전체를 거부합니다");
      // 허용값 목록에서도 빠져 있어야 한다 — 금지 문구만으로는 모델이 목록에서 골라 쓴다.
      const allowed = prompt.slice(prompt.indexOf("처분(disposition)은 다음 값만 씁니다:"));
      expect(allowed.split("\n")[0]).not.toContain("RESOLVED_BY_FIX");
    }
  });

  // 패치 계약도 같은 짝 규칙을 따른다 — 서버가 applyPlanEdits로 유일 일치를 강제하므로
  // 개정 프롬프트가 그 규칙(정확히 한 번, 순서 적용, 실패 시 거부)을 말해야 한다.
  // 한국어는 실측 2.0바이트/토큰(영어 ~4.4) — 대량 방출 지점의 언어를 프롬프트가 지정해야 한다.
  const planPrompt = buildClaudePlanPrompt({
    title: "t", worktreePath: "/tmp/wt", sourceRepositoryPath: "/tmp/repo", baseRef: "develop",
    scopeGeneration: 1, timeline: [],
  });

  // 첫 계획 프롬프트에 언어 계약이 빠져 가장 큰 산출물(계획 본문)이 한국어로 방출되고, 개정의
  // '기존 언어 유지' 규칙이 그것을 영구화했다(2026-09-01 발견). 계획 본문을 만드는 프롬프트는
  // 본문 언어 규칙(planBody)까지 말해야 한다.
  it("에이전트 산출물 프롬프트는 출력 언어 계약을 말한다", () => {
    for (const prompt of [planPrompt, revisionPrompt, closeoutPrompt, fixPrompt]) {
      expect(prompt).toContain("title과 rationale은 영어로");
      expect(prompt).toContain("requestedUserDecision은 사용자가 직접 읽으므로 한국어로");
      expect(prompt).toContain("번역하지 말고 그대로 인용");
    }
    // 계획 본문을 쓰는 프롬프트는 기존 문서 번역 금지까지 말해야 한다
    expect(revisionPrompt).toContain("기존 언어를 따르고");
    expect(revisionPrompt).toContain("필수 절 제목은 위의 한국어 제목을 글자 그대로");
  });

  it("개정 프롬프트는 planEdits 패치 규칙을 말한다", () => {
    expect(revisionPrompt).toContain("planEdits 패치");
    expect(revisionPrompt).toContain("정확히 한 번");
    expect(revisionPrompt).toContain("응답을 거부합니다");
    expect(revisionPrompt).toContain("둘 다 있으면 planEdits가 적용됩니다");
  });

  it("실제 수정이 일어난 단계는 RESOLVED_BY_FIX를 허용값으로 제시한다", () => {
    expect(fixPrompt).toContain("RESOLVED_BY_FIX를 쓸 수 있습니다");
    const allowed = fixPrompt.slice(fixPrompt.indexOf("처분(disposition)은 다음 값만 씁니다:"));
    expect(allowed.split("\n")[0]).toContain("RESOLVED_BY_FIX");
  });

  it("앞 단계 쟁점에 처분이 필요하다는 것과 새 쟁점은 예외라는 것을 둘 다 말한다", () => {
    for (const prompt of [revisionPrompt, closeoutPrompt, fixPrompt]) {
      expect(prompt).toContain("빠짐없이 처분을 붙이세요");
      // 2026-09-13: 판단이 끝난 쟁점은 서버가 승계한다고 알려 되돌려 담는 출력 토큰을 줄인다.
      expect(prompt).toContain("서버가 같은 처분으로 승계합니다");
      expect(prompt).toContain("새로 발견한 쟁점은 처분을 비워 둬도 됩니다");
    }
    // 리뷰가 아닌 단계에는 RESOLVED_BY_FIX 판정 문구가 없다(리뷰 단계 문구는 prompts.test 에서 확인).
    for (const prompt of [revisionPrompt, closeoutPrompt, fixPrompt]) expect(prompt).not.toContain("주장한 쟁점은 승계되지 않습니다");
  });
});


// 감사 부차 지적: OPENAI_API_KEY=... 같은 환경 변수 표기와 { "token": "..." } JSON 표기가 가려지지 않았다.
describe("시크릿 마스킹 확장", () => {
  it("환경 변수 표기의 키·토큰을 가린다", () => {
    const redacted = redactSecrets("OPENAI_API_KEY=abc123def 그리고 SENTRY_AUTH_TOKEN=xyz789");

    expect(redacted).not.toContain("abc123def");
    expect(redacted).not.toContain("xyz789");
    expect(redacted).toContain("OPENAI_API_KEY=[REDACTED]");
    expect(redacted).toContain("SENTRY_AUTH_TOKEN=[REDACTED]");
  });

  it("JSON 문자열 값의 토큰을 가린다", () => {
    const redacted = redactSecrets('{ "token": "secret-abc", "access_token": "secret-def" }');

    expect(redacted).not.toContain("secret-abc");
    expect(redacted).not.toContain("secret-def");
  });

  it("일반 대문자 환경 변수는 건드리지 않는다", () => {
    expect(redactSecrets("CONSENSUS_ROOM_PORT=4317")).toBe("CONSENSUS_ROOM_PORT=4317");
  });
});

// 감사 부차 지적: git은 세그먼트 단위로도 ref를 거부한다. 끝만 검사하면 승인 단계까지 통과한 뒤 터진다.
describe("브랜치 이름 세그먼트 검증", () => {
  it("숨김 세그먼트와 중간 .lock 세그먼트를 거부한다", () => {
    expect(BranchNameSchema.safeParse("feature/.hidden").success).toBe(false);
    expect(BranchNameSchema.safeParse("feature.lock/next").success).toBe(false);
    expect(BranchNameSchema.safeParse("refactoring/PROJECT-123").success).toBe(true);
  });

  it("baseRef가 '-'로 시작하면 git 옵션 주입으로 보고 거부한다", () => {
    expect(CreateTopicInputSchema.safeParse({ title: "옵션 주입", baseRef: "--force" }).success).toBe(false);
    expect(CreateTopicInputSchema.safeParse({ title: "정상 참조", baseRef: "develop" }).success).toBe(true);
  });
});

// 감사 ⑨ 후반: 종결 재시도 때 새로 올라온 결정·증거가 프롬프트에 실리지 않으면 재시도의 의미가 없다.
describe("종결 프롬프트와 새 증거", () => {
  it("타임라인의 결정·증거가 종결 프롬프트에 실린다", () => {
    const prompt = buildCodexCloseoutPrompt({
      revisedPlan: "# 계획", revisedPlanSHA256: "a".repeat(64),
      claudeRevision: { kind: "REVISION", summary: "s", findings: [], evidenceRefs: [] } as AgentResult,
      timeline: [{
        id: 1, topicId: "topic-1", sequence: 9, scopeGeneration: 1,
        actor: "user", kind: "evidence", state: "BLOCKED_ON_EVIDENCE",
        body: "새로 확보한 실행 증거 CLOSEOUT-EVIDENCE-MARKER",
        payload: {}, createdAt: "2026-08-30T00:00:00.000Z",
      }],
    });

    expect(prompt).toContain("CLOSEOUT-EVIDENCE-MARKER");
  });
});

// 개정 패치 적용의 강제 규칙. 0회 일치는 베이스 불일치, 복수 일치는 앵커 부족 — 둘 다 어느 편집인지
// 명시하고 거부해야 다음 시도가 교정할 수 있다(2026-08-31 출력 상한 병목의 해소 장치).
describe("applyPlanEdits", () => {
  it("순서대로 적용하고, 앞 편집이 만든 본문에 뒤 편집이 일치할 수 있다", () => {
    const base = "## A\n원래 내용\n## B\n그대로";
    const out = applyPlanEdits(base, [
      { find: "원래 내용", replace: "고친 내용" },
      { find: "고친 내용\n## B", replace: "고친 내용\n## A2\n추가 절\n## B" },
    ]);
    expect(out).toBe("## A\n고친 내용\n## A2\n추가 절\n## B\n그대로");
  });

  it("0회 일치면 어느 편집인지 명시하고 거부한다", () => {
    expect(() => applyPlanEdits("본문", [{ find: "없는 문구", replace: "x" }]))
      .toThrow(/planEdits\[0\].*0회 일치/);
  });

  it("복수 일치면 어느 편집인지 명시하고 거부한다", () => {
    expect(() => applyPlanEdits("중복 중복", [{ find: "중복", replace: "x" }]))
      .toThrow(/planEdits\[0\].*2회 일치/);
  });

  it("replace의 $ 패턴을 문자 그대로 넣는다", () => {
    expect(applyPlanEdits("값: 원본", [{ find: "원본", replace: "a$'b$1c" }])).toBe("값: a$'b$1c");
  });

  it("빈 replace는 삭제다", () => {
    expect(applyPlanEdits("앞 지울것 뒤", [{ find: " 지울것", replace: "" }])).toBe("앞 뒤");
  });
});

// 짝 드리프트 원천 차단: finding을 방출하는 모든 단계 프롬프트는 처분 계약(dispositionContract)을
// 소스 수준에서 포함해야 한다. 새 빌더가 계약 없이 추가되면 이 스위프가 즉시 잡는다
// (2026-09-01 S1.1: 구현 프롬프트에 계약이 없어 에이전트가 처분을 추측, 턴 전체 거부).
describe("프롬프트 처분 계약 스위프", () => {
  it("finding을 방출하는 모든 build*Prompt는 dispositionContract를 포함한다", () => {
    const source = readFileSync(join(__dirname, "..", "src", "shared", "prompts.ts"), "utf8");
    // finding을 방출하지 않는 빌더만 예외: ACK·리뷰 답변 확인(프로토콜 확인), 교정(메타 프롬프트).
    const exempt = new Set(["buildPlanAckPrompt", "buildContractCorrectionPrompt", "buildReviewAnswerConfirmationPrompt"]);
    const names = [...source.matchAll(/export function (build\w*Prompt)/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThanOrEqual(8);
    const boundaries = [...source.matchAll(/export function build\w*Prompt/g)].map((match) => match.index!);
    for (let index = 0; index < names.length; index += 1) {
      const body = source.slice(boundaries[index], boundaries[index + 1] ?? source.length);
      if (exempt.has(names[index])) continue;
      expect(body, `${names[index]}에 dispositionContract가 없습니다`).toContain("dispositionContract(");
    }
  });
});

// 2026-09-07 #7: 사용자 결정이 명시적으로 뒤집은 쟁점은 하향 처분이 되돌림이 아니다.
describe("dispositionRegressions 의 overruled 집합", () => {
  const agreed: Finding = {
    id: "F-1", title: "고치기로 한 결함", severity: "LOW", disposition: "AGREED_ACTION",
    rationale: "첫 리뷰", evidenceRefs: [], requiresUserDecision: false,
  };
  const closed: Finding = { ...agreed, disposition: "AGREED_NO_ACTION", rationale: "중재자 예외" };

  it("overruled 에 든 id 는 되돌림으로 세지 않고, 나머지는 그대로 센다", () => {
    expect(dispositionRegressions([agreed], [closed])).toEqual(["F-1"]);
    expect(dispositionRegressions([agreed], [closed], new Set(["F-1"]))).toEqual([]);
    expect(dispositionRegressions([agreed], [closed], new Set(["F-2"]))).toEqual(["F-1"]);
  });
});

// 2026-09-13 S10 #120: 러너가 판단이 끝난 리뷰 쟁점 13건을 되돌려 담지 않아 재제출 1회를 샀다. 서버가 승계하면 재제출이 없다.
describe("settled 쟁점 승계(carryForwardFindings)", () => {
  const f = (id: string, disposition: string | undefined, extra: Record<string, unknown> = {}) => ({
    id, title: id, severity: "MEDIUM", disposition, rationale: `근거 ${id}`, evidenceRefs: [], requiresUserDecision: false, ...extra,
  }) as unknown as import("../src/shared/contracts").Finding;

  it("처분이 있고 행동이 필요 없는 쟁점만 settled 다", () => {
    expect(isSettledFinding(f("A", "AGREED_NO_ACTION"))).toBe(true);
    expect(isSettledFinding(f("B", "REFUTED"))).toBe(true);
    expect(isSettledFinding(f("C", "DEFERRED_OUT_OF_SCOPE"))).toBe(true);
    expect(isSettledFinding(f("D", "RESOLVED_BY_FIX"))).toBe(true);
    expect(isSettledFinding(f("D", "RESOLVED_BY_FIX"), { forReview: true })).toBe(false); // 리뷰는 주장을 판정해야 한다
    expect(isSettledFinding(f("E", "AGREED_ACTION"))).toBe(false);
    expect(isSettledFinding(f("F", "EXTERNAL_EVIDENCE"))).toBe(false);
    expect(isSettledFinding(f("G", undefined))).toBe(false);
    expect(isSettledFinding(f("H", "AGREED_NO_ACTION", { requiresUserDecision: true }))).toBe(false);
  });

  it("응답에 없는 settled 쟁점만 같은 처분으로 덧붙이고, 응답이 적은 쟁점은 응답이 우선한다", () => {
    const source = [f("F-1", "AGREED_ACTION"), f("F-2", "AGREED_NO_ACTION"), f("TODO-1", "DEFERRED_OUT_OF_SCOPE"), f("F-3", "REFUTED")];
    const response = [f("F-1", "RESOLVED_BY_FIX"), f("F-3", "AGREED_ACTION", { rationale: "다시 열기" })];
    const { findings, carried } = carryForwardFindings(source, response);
    expect(carried).toEqual(["F-2", "TODO-1"]);
    expect(findings.map((x) => [x.id, x.disposition])).toEqual([
      ["F-1", "RESOLVED_BY_FIX"], ["F-3", "AGREED_ACTION"], ["F-2", "AGREED_NO_ACTION"], ["TODO-1", "DEFERRED_OUT_OF_SCOPE"],
    ]);
    expect(findings.find((x) => x.id === "F-2")!.rationale.startsWith(CARRIED_RATIONALE_PREFIX)).toBe(true);
    // 행동 필요 쟁점(F-1 이 빠진 응답)은 승계되지 않아 커버리지 검사에 그대로 걸린다.
    const missingActionable = carryForwardFindings(source, [f("F-2", "AGREED_NO_ACTION")]);
    expect(missingActionable.carried).toEqual(["TODO-1", "F-3"]);
    expect(() => assertFindingCoverage(source, missingActionable.findings, "Claude fix")).toThrow("F-1");
    // 승계는 멱등 — 이미 접두가 붙은 쟁점을 다시 승계해도 접두가 겹치지 않는다.
    const again = carryForwardFindings(missingActionable.findings, []);
    expect(again.findings.find((x) => x.id === "TODO-1")!.rationale.split(CARRIED_RATIONALE_PREFIX).length).toBe(2);
  });

  // 2026-09-13 Codex 지적 1: 원본마다 따로 승계하면 첫 리뷰의 AGREED_NO_ACTION 이 수정 결과의 최신 판단을 덮는다.
  it("원본이 여럿이면 최신 우선으로 합친 뒤 승계한다 — 옛 no-action 이 최신 AGREED_ACTION·RESOLVED_BY_FIX 를 덮지 않는다", () => {
    const firstReview = [f("F-1", "AGREED_NO_ACTION"), f("F-2", "AGREED_NO_ACTION")];
    for (const latest of ["AGREED_ACTION", "RESOLVED_BY_FIX"]) {
      const fix = [f("F-1", latest), f("F-2", "AGREED_NO_ACTION")];
      const merged = mergeFindingSources(fix, firstReview);
      expect(merged.map((x) => [x.id, x.disposition])).toEqual([["F-1", latest], ["F-2", "AGREED_NO_ACTION"]]);
      const { carried, findings } = carryForwardFindings(merged, [], { forReview: true });
      expect(carried).toEqual(["F-2"]);
      expect(() => assertFindingCoverage(firstReview, findings, "Codex final review")).toThrow("F-1");
    }
    expect(mergeFindingSources(undefined, firstReview, undefined)).toHaveLength(2);
  });
});

// 2026-09-14 S11: 허용 오차 교정 재제출("코드 변경 없음 — 원장 공란")이 $6.35 짜리 본 턴 보고와 남은 단계를 적은 결정 요청을
// 통째로 덮어써 엔진이 구현 완료로 보고 리뷰로 넘겼다. 교정은 본 턴 결과 위에 병합한다.
describe("mergeCorrectionResult — 교정 재제출을 본 턴 결과 위에 병합", () => {
  const original: AgentResult = {
    kind: "IMPLEMENTATION", summary: "P3 완료. 남은 단계 P3.5·P3.6.",
    findings: [
      { id: "TODO-1", title: "이연", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE", rationale: "범위 밖", evidenceRefs: [], requiresUserDecision: false },
      { id: "F-1", title: "고침", severity: "MEDIUM", disposition: "RESOLVED_BY_FIX", rationale: "본 턴", evidenceRefs: [], requiresUserDecision: false },
    ],
    evidenceRefs: ["cover-A-post.log errors=0", "gate4 OK"], requestedUserDecision: "남은 단계 P3.5·P3.6 — 계속 진행 요청",
    toleranceLedger: [],
  };
  it("교정이 비운 쟁점·증거·요청 결정을 보존하고 요약은 뒤에 붙이며 원장은 교정 것을 쓴다", () => {
    const corrected: AgentResult = {
      kind: "IMPLEMENTATION", summary: "원장 6행 재기재(코드 변경 없음)", findings: [], evidenceRefs: ["git diff -- Tests/A.swift"],
      toleranceLedger: [{ ruleId: "T-5", file: "Tests/A.swift", note: "재기재" }],
    };
    const { result, preserved } = mergeCorrectionResult(original, corrected);
    expect(preserved).toEqual(["findings 2건", "evidence 2건", "요청 결정", "summary"]);
    expect(result.findings.map((finding) => finding.id)).toEqual(["TODO-1", "F-1"]);
    expect(result.evidenceRefs).toEqual(["git diff -- Tests/A.swift", "cover-A-post.log errors=0", "gate4 OK"]);
    expect(result.requestedUserDecision).toBe(original.requestedUserDecision);
    expect(result.summary).toBe(`원장 6행 재기재(코드 변경 없음)${CORRECTION_SUMMARY_SEPARATOR}P3 완료. 남은 단계 P3.5·P3.6.`);
    expect(result.toleranceLedger).toEqual(corrected.toleranceLedger);
  });
  it("교정이 같은 id 를 다시 적으면 교정이 우선하고, 본 턴 요약을 담고 있으면 덧붙이지 않는다", () => {
    const corrected: AgentResult = {
      kind: "IMPLEMENTATION", summary: "P3 완료. 남은 단계 P3.5·P3.6. (원장 보완)",
      findings: [{ id: "F-1", title: "고침", severity: "MEDIUM", disposition: "AGREED_ACTION", rationale: "되돌림", evidenceRefs: [], requiresUserDecision: false }],
      evidenceRefs: ["cover-A-post.log errors=0", "gate4 OK"], requestedUserDecision: "다른 결정",
    };
    const { result, preserved } = mergeCorrectionResult(original, corrected);
    expect(preserved).toEqual(["findings 1건"]);
    expect(result.findings.map((finding) => [finding.id, finding.disposition])).toEqual([["F-1", "AGREED_ACTION"], ["TODO-1", "DEFERRED_OUT_OF_SCOPE"]]);
    expect(result.requestedUserDecision).toBe("다른 결정");
    expect(result.summary).toBe(corrected.summary);
  });
  it("본 턴에 요청 결정이 없었고 교정도 없으면 요청 결정 필드를 만들지 않는다", () => {
    const { result } = mergeCorrectionResult({ ...original, requestedUserDecision: undefined }, { kind: "IMPLEMENTATION", summary: "x", findings: [], evidenceRefs: [] });
    expect("requestedUserDecision" in result).toBe(false);
  });
});

// 2026-09-14 Codex 감사 R07·R01②·D01 — 요청 결정의 명시적 해소, 계약을 어긴 원본의 필드 구제, 진행 상태 판정.
describe("mergeCorrectionResult — resolvesRequestedDecision / salvageResultFields / implementationInProgress", () => {
  const base = { kind: "IMPLEMENTATION" as const, summary: "s", findings: [], evidenceRefs: [] };
  it("교정이 resolvesRequestedDecision:true 를 적으면 본 턴의 요청 결정을 복원하지 않는다", () => {
    const original: AgentResult = { ...base, requestedUserDecision: "범위 밖 변경을 유지할까?" };
    const corrected: AgentResult = { ...base, summary: "전부 되돌렸다", resolvesRequestedDecision: true };
    const merged = mergeCorrectionResult(original, corrected);
    expect(merged.result.requestedUserDecision).toBeUndefined();
    expect(merged.result.resolvesRequestedDecision).toBe(true); // 중첩 병합까지 해소 표식 유지(F08)
    expect(merged.preserved).not.toContain("요청 결정");
    const outer = mergeCorrectionResult({ ...base, requestedUserDecision: "원래 질문(실패 원본)" }, merged.result);
    expect(outer.result.requestedUserDecision).toBeUndefined();
  });
  it("salvageResultFields 는 개별로 유효한 필드만 건진다(깨진 쟁점은 버리고 유효한 결정·증거·상태는 남긴다)", () => {
    const raw = { kind: "FIX", summary: "실제 작업", requestedUserDecision: "ORIGINAL-DECISION", evidenceRefs: ["PROOF", 3],
      findings: [{ id: "ok", title: "t", severity: "LOW", disposition: "AGREED_NO_ACTION", rationale: "r", evidenceRefs: [], requiresUserDecision: false }, { id: "broken" }],
      status: "in_progress", remainingSteps: ["P4", 7] };
    const salvaged = salvageResultFields(raw, "IMPLEMENTATION");
    expect(salvaged).toMatchObject({ kind: "IMPLEMENTATION", summary: "실제 작업", requestedUserDecision: "ORIGINAL-DECISION", evidenceRefs: ["PROOF"], status: "in_progress", remainingSteps: ["P4"] });
    expect(salvaged.findings.map((finding) => finding.id)).toEqual(["ok"]);
    const merged = mergeCorrectionResult(salvaged, { ...base, summary: "kind 만 고침" });
    expect(merged.result.requestedUserDecision).toBe("ORIGINAL-DECISION");
    expect(merged.result.evidenceRefs).toContain("PROOF");
  });
  it("implementationInProgress: in_progress 이거나 completed 가 아닌데 남은 단계가 있으면 진행 중", () => {
    expect(implementationInProgress({ ...base, status: "in_progress" })).toBe(true);
    expect(implementationInProgress({ ...base, remainingSteps: ["P4"] })).toBe(true);
    expect(implementationInProgress({ ...base, status: "completed", remainingSteps: ["메모"] })).toBe(false);
    expect(implementationInProgress({ ...base })).toBe(false);
  });

  it("OVERRULE 지시의 기본 형식 — 줄 머리 `OVERRULE <id>[, <id>]`(키워드 뒤 콜론·끝 쉼표 허용)는 적은 id 만 내고, 여러 줄 본문에서는 지시 줄만 센다(2026-09-15 감사 4차 #6)", () => {
    const ids = (body: string) => [...overruleDirectiveIDs(body)].sort();
    expect(ids("OVERRULE F-1")).toEqual(["F-1"]);
    expect(ids("OVERRULE F-1, F-2")).toEqual(["F-1", "F-2"]);
    expect(ids("OVERRULE: F-1")).toEqual(["F-1"]);
    expect(ids("OVERRULE F-1,")).toEqual(["F-1"]);
    // 설명은 다음 줄 — 다음 줄의 id(수정 요구)는 지시가 아니다.
    expect(ids("OVERRULE F-1\nF-2 는 반드시 고쳐 주세요")).toEqual(["F-1"]);
  });

  it("OVERRULE 줄에 설명 문장·괄호 설명·콜론 설명이 붙거나 id 를 공백으로 나열하면 지시 전체가 무효이고(id 0개), 지시는 다음 줄로 넘어가지 않으며, 키워드가 줄 머리가 아니면 지시가 아니다 — 수정을 요구한 문장 속 id 를 면제로 세지 않는다(2026-09-15 감사 4차 #6)", () => {
    const bodies = [
      "OVERRULE F-3 — F-1 은 반드시 고쳐 주세요.",
      "OVERRULE F-3 (F-1 은 반드시 고쳐 주세요)",
      "OVERRULE F-3: F-1 과 달리 F-3 은 고치지 않는다",
      "OVERRULE\nF-1 은 반드시 고쳐 주세요.",
      "OVERRULE F-1 F-2",
      "  xOVERRULE F-1",
      "OVERRULEF-1",
      // 키워드를 백틱으로 감싼 줄은 지시어를 언급한 문장이다 — REFIX·REPLAN 과 같은 줄 머리 규칙이라 지시로 세지 않는다.
      "`OVERRULE` F-1",
    ];
    expect(Object.fromEntries(bodies.map((body) => [body, [...overruleDirectiveIDs(body)]])))
      .toEqual(Object.fromEntries(bodies.map((body) => [body, []])));
  });

  it("OVERRULE 지시의 id 형식은 제한하지 않는다 — 점·콜론·비ASCII 가 든 스키마상 유효한 finding id(S6.5-GATE2, R3:01, 리뷰-1)와 백틱으로 감싼 id(`F-1` → F-1)도 지시한 id 로 센다(2026-09-15 감사 4차 #11)", () => {
    const cases: Array<[string, string[]]> = [
      ["OVERRULE S6.5-GATE2", ["S6.5-GATE2"]],
      ["OVERRULE R3:01", ["R3:01"]],
      ["OVERRULE 리뷰-1", ["리뷰-1"]],
      ["OVERRULE `F-1`", ["F-1"]],
      ["OVERRULE S7P-01, S6.5-GATE2", ["S7P-01", "S6.5-GATE2"]],
    ];
    const directed = (body: string, expected: string[]) => expected.every((id) => overruleDirectiveIDs(body).has(id));
    expect(Object.fromEntries(cases.map(([body, expected]) => [body, directed(body, expected)])))
      .toEqual(Object.fromEntries(cases.map(([body]) => [body, true])));
  });

  // ---- 2026-09-15 감사 5차 #7 (g4) ----
  it("OVERRULE 지시에서 따옴표(\" ')·백틱으로 감싼 토큰은 안의 공백·쉼표까지 그대로 하나의 id 다 — 스키마상 유효한 공백·쉼표 포함 id(GATE 2, A, B)를 지시할 수 있고, 감싼 id 를 조각(GATE·2·A·B)으로 쪼개 세지 않는다(2026-09-15 감사 5차 #7)", () => {
    const cases: Array<[string, string[], string[]]> = [
      ['OVERRULE "GATE 2"', ["GATE 2"], ["GATE", "2", '"GATE', '2"']],
      ["OVERRULE 'A, B', F-3", ["A, B", "F-3"], ["A", "B", "'A", "B'"]],
      ["OVERRULE `GATE 2`", ["GATE 2"], ["GATE", "2", "`GATE", "2`"]],
      ['OVERRULE: "GATE 2",', ["GATE 2"], ["GATE", "2"]],
    ];
    const observed = (body: string, expected: string[], fragments: string[]) => {
      const ids = overruleDirectiveIDs(body);
      return { directed: expected.filter((id) => ids.has(id)), fragments: fragments.filter((id) => ids.has(id)) };
    };
    expect(Object.fromEntries(cases.map(([body, expected, fragments]) => [body, observed(body, expected, fragments)])))
      .toEqual(Object.fromEntries(cases.map(([body, expected]) => [body, { directed: expected, fragments: [] }])));
  });

  it("따옴표로 감싼 id 에도 줄 머리 지시 규칙은 그대로다 — 감싼 id 뒤에 설명 문장이 붙거나(OVERRULE \"GATE 2\" 는 고치지 않는다) 감싼 토큰을 쉼표 없이 나열하면 지시 전체가 무효(id 0개)다(2026-09-15 감사 5차 #7)", () => {
    const bodies = [
      'OVERRULE "GATE 2" 는 고치지 않는다',
      "OVERRULE `GATE 2` — GATE 3 은 반드시 고쳐 주세요.",
      "OVERRULE 'A, B' F-3",
      'OVERRULE "GATE 2" "GATE 3"',
    ];
    expect(Object.fromEntries(bodies.map((body) => [body, [...overruleDirectiveIDs(body)]])))
      .toEqual(Object.fromEntries(bodies.map((body) => [body, []])));
  });

  it("닫히지 않은 따옴표('OVERRULE \"GATE')는 감싼 토큰이 아니라 감싸지 않은 토큰으로 읽혀 원 토큰(\"GATE)과 앞 따옴표를 벗긴 GATE 를 내고, 감싸지 않은 토큰은 종전 규칙 그대로다(쉼표 목록·공백 나열 무효·괄호와 끝 구두점 벗김)(2026-09-15 감사 5차 #7)", () => {
    const ids = (body: string) => [...overruleDirectiveIDs(body)].sort();
    expect(ids('OVERRULE "GATE')).toEqual(['"GATE', "GATE"]);
    expect(ids("OVERRULE F-1, F-2")).toEqual(["F-1", "F-2"]);
    expect(ids("OVERRULE F-1 F-2")).toEqual([]);
    expect(ids("OVERRULE (F-1).")).toEqual(["(F-1).", "F-1"]);
  });

  // ---- 2026-09-15 감사 6차 #5·#6·#9 (g6d) ----
  it("합의 기준 병합(mergeAgreedSources)은 최신 우선이되, 판정이 끝나지 않은 새 처분(처분 없음·EXTERNAL_EVIDENCE·사용자 판정 필요)은 앞선 층의 같은 id 합의(AGREED_ACTION)를 가리지 못해 그 합의 판(심각도·근거 포함)이 그대로 남고, 새 합의와 판정이 끝난 새 처분(수정 불필요·수정 확인·반박)은 앞선 합의보다 우선한다(2026-09-15 감사 6차 #5)", () => {
    const agreed = finding({ id: "F-2", severity: "HIGH", rationale: "FC-2 원본: 고치기로 합의", requiresUserDecision: true });
    // 1) 판정이 끝나지 않은 새 처분은 앞선 합의를 가리지 못한다 — 앞선 합의 판이 그대로 남는다.
    const unjudged: Record<string, Finding> = {
      "처분 없음": finding({ id: "F-2", severity: "LOW", disposition: undefined, rationale: "처분 없음" }),
      EXTERNAL_EVIDENCE: finding({ id: "F-2", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE", rationale: "게이트 로그 없이는 확인 불가" }),
      "사용자 판정 필요(AGREED_NO_ACTION)": finding({ id: "F-2", severity: "MEDIUM", disposition: "AGREED_NO_ACTION", requiresUserDecision: true, rationale: "수정 불필요 — 판정 필요" }),
      "사용자 판정 필요(REFUTED)": finding({ id: "F-2", severity: "MEDIUM", disposition: "REFUTED", requiresUserDecision: true, rationale: "반박 — 판정 필요" }),
    };
    expect(Object.fromEntries(Object.entries(unjudged).map(([label, newer]) => [label, mergeAgreedSources([newer], [agreed])])))
      .toEqual(Object.fromEntries(Object.keys(unjudged).map((label) => [label, [agreed]])));
    // 2) 새 합의(판정 필요여도)와 판정이 끝난 새 처분은 최신 우선 그대로다.
    const decided: Record<string, Finding> = {
      "새 합의(AGREED_ACTION, 판정 필요)": finding({ id: "F-2", severity: "MEDIUM", rationale: "최종 리뷰 재판정", requiresUserDecision: true }),
      "수정 불필요(AGREED_NO_ACTION)": finding({ id: "F-2", disposition: "AGREED_NO_ACTION", rationale: "OVERRULE 뒤 수정 불필요" }),
      "수정 확인(RESOLVED_BY_FIX)": finding({ id: "F-2", disposition: "RESOLVED_BY_FIX", rationale: "수정 확인" }),
      "반박(REFUTED)": finding({ id: "F-2", disposition: "REFUTED", rationale: "반박 확정" }),
    };
    expect(Object.fromEntries(Object.entries(decided).map(([label, newer]) => [label, mergeAgreedSources([newer], [agreed])])))
      .toEqual(Object.fromEntries(Object.entries(decided).map(([label, newer]) => [label, [newer]])));
    // 3) 앞선 합의가 없으면 판정이 끝나지 않은 새 처분도 그대로 남는다 — 앞선 층의 판정 끝난 처분으로 되돌리지 않는다.
    const evidence = unjudged.EXTERNAL_EVIDENCE;
    expect(mergeAgreedSources([evidence], [finding({ id: "F-2", disposition: "AGREED_NO_ACTION", rationale: "첫 리뷰: 수정 불필요" })])).toEqual([evidence]);
    expect(mergeAgreedSources([evidence])).toEqual([evidence]);
    // 4) 여러 층: 빈 층을 건너뛰고 id 순서·다른 id 의 판은 mergeFindingSources 와 같다 — 판정이 끝나지 않은 처분이 겹겹이 있어도 가려진 id 만 가장 최신 합의 판으로 남는다.
    const layers: Array<Finding[] | undefined> = [
      undefined,
      [evidence, finding({ id: "F-1", disposition: "RESOLVED_BY_FIX", rationale: "F-1 수정 확인" })],
      [unjudged["처분 없음"], finding({ id: "F-3", disposition: "AGREED_NO_ACTION", rationale: "F-3 경미" })],
      undefined,
      [agreed, finding({ id: "F-1", rationale: "F-1 합의" })],
      [finding({ id: "F-2", severity: "BLOCKER", rationale: "첫 리뷰: 고치기로 합의" }), finding({ id: "F-4", rationale: "F-4 합의" })],
    ];
    const view = (merged: Finding[]) => merged.map((x) => [x.id, x.disposition ?? null, x.severity, x.rationale]);
    expect(view(mergeFindingSources(...layers))).toEqual([
      ["F-2", "EXTERNAL_EVIDENCE", "MEDIUM", "게이트 로그 없이는 확인 불가"], ["F-1", "RESOLVED_BY_FIX", "HIGH", "F-1 수정 확인"],
      ["F-3", "AGREED_NO_ACTION", "HIGH", "F-3 경미"], ["F-4", "AGREED_ACTION", "HIGH", "F-4 합의"],
    ]);
    expect(view(mergeAgreedSources(...layers))).toEqual([
      ["F-2", "AGREED_ACTION", "HIGH", "FC-2 원본: 고치기로 합의"], ["F-1", "RESOLVED_BY_FIX", "HIGH", "F-1 수정 확인"],
      ["F-3", "AGREED_NO_ACTION", "HIGH", "F-3 경미"], ["F-4", "AGREED_ACTION", "HIGH", "F-4 합의"],
    ]);
    // 되돌림 검사는 이 병합 결과의 합의만 본다 — 가려지지 않은 F-2 합의를 수정 확인 없이 닫으면 되돌림이다.
    const closed = [finding({ id: "F-2", disposition: "AGREED_NO_ACTION", rationale: "수정 확인 없이 닫음" })];
    expect([dispositionRegressions(mergeFindingSources(...layers), closed), dispositionRegressions(mergeAgreedSources(...layers), closed)]).toEqual([[], ["F-2"]]);
  });

  // 퇴행 감지 사다리: 크기를 2개씩 늘려 가며 잰다 — 지수 역추적으로 퇴행하면 한도(1초)를 처음 넘는 크기에서 실패하므로(한 칸에 약 4배) 40개 입력으로 곧장 수십 시간
  // 멈추는 대신 수 초 안에 끝난다. 858c974 정규식 실측(무효 줄, 큰따옴표): 16개 6ms · 18개 22ms · 20개 89ms · 22개 357ms, 새 스캐너 40개 0.3ms 미만.
  it("OVERRULE 지시 줄 판정은 토큰 수에 선형이다 — 따옴표·작은따옴표·백틱으로 감싼 id 40개 뒤에 같은 줄 설명을 붙인 무효 줄은 id 0개, 설명을 다음 줄로 뺀 유효 줄은 그 40개를 정확히 내고, 크기마다 둘 다 1초 안에 끝난다(옛 정규식은 무효 줄에서 id 2개마다 약 4배로 늘었다)(2026-09-15 감사 6차 #6·#9)", () => {
    for (let n = 2; n <= 40; n += 2) {
      const ids = Array.from({ length: n }, (_, index) => `G-${index + 1}`);
      for (const quote of ['"', "'", "`"]) {
        const list = ids.map((id) => `${quote}${id}${quote}`).join(", ");
        const invalidStarted = performance.now();
        const invalid = [...overruleDirectiveIDs(`OVERRULE ${list} 은 고치지 않는다\nG-1 은 고치세요.`)];
        const invalidMs = performance.now() - invalidStarted;
        const validStarted = performance.now();
        const valid = [...overruleDirectiveIDs(`OVERRULE ${list}\nG-1 은 고치세요.`)].sort();
        const validMs = performance.now() - validStarted;
        expect({ n, quote, invalid, valid, invalidUnderOneSecond: invalidMs < 1000, validUnderOneSecond: validMs < 1000 },
          `n=${n} ${quote} 무효 ${invalidMs.toFixed(1)}ms · 유효 ${validMs.toFixed(1)}ms`)
          .toEqual({ n, quote, invalid: [], valid: [...ids].sort(), invalidUnderOneSecond: true, validUnderOneSecond: true });
      }
    }
  });

  it("OVERRULE 지시 줄 스캐너는 문서화된 문법 그대로다 — 줄 머리 OVERRULE(뒤에 콜론 또는 공백·탭), 토큰은 닫는 문자 뒤가 쉼표·줄 끝인 따옴표·작은따옴표·백틱 감싼 토큰(안의 문자 그대로 + 앞뒤 공백을 벗긴 형태) 또는 공백·쉼표 없는 감싸지 않은 토큰(원 토큰 + 앞 따옴표·백틱·괄호와 끝 따옴표·괄호·구두점을 벗긴 형태), 토큰 사이 쉼표(앞뒤 공백·탭), 끝 쉼표 하나, 줄 끝 CR 무시이고 어긋나면 그 줄 전체가 무효다 — 기존 OVERRULE 사례와 경계(감싼 토큰 뒤 설명·다른 감싼 토큰 속 쉼표·탭·CRLF·빈 따옴표·연속 쉼표·선행 쉼표·유니코드 따옴표)의 id 집합이 정확히 이것이다(2026-09-15 감사 6차 #6·#9)", () => {
    const cases: Array<[string, string[]]> = [
      // 기존 사례(감사 4차 #6·#11, 5차 #7) — 정확한 집합
      ["OVERRULE F-1", ["F-1"]],
      ["OVERRULE F-1, F-2", ["F-1", "F-2"]],
      ["OVERRULE: F-1", ["F-1"]],
      ["OVERRULE F-1,", ["F-1"]],
      ["OVERRULE F-1\nF-2 는 반드시 고쳐 주세요", ["F-1"]],
      ["OVERRULE F-3 — F-1 은 반드시 고쳐 주세요.", []],
      ["OVERRULE F-3 (F-1 은 반드시 고쳐 주세요)", []],
      ["OVERRULE F-3: F-1 과 달리 F-3 은 고치지 않는다", []],
      ["OVERRULE\nF-1 은 반드시 고쳐 주세요.", []],
      ["OVERRULE F-1 F-2", []],
      ["  xOVERRULE F-1", []],
      ["OVERRULEF-1", []],
      ["`OVERRULE` F-1", []],
      ["OVERRULE S6.5-GATE2", ["S6.5-GATE2"]],
      ["OVERRULE R3:01", ["R3:01"]],
      ["OVERRULE 리뷰-1", ["리뷰-1"]],
      ["OVERRULE `F-1`", ["F-1"]],
      ["OVERRULE S7P-01, S6.5-GATE2", ["S7P-01", "S6.5-GATE2"]],
      ['OVERRULE "GATE 2"', ["GATE 2"]],
      ["OVERRULE 'A, B', F-3", ["A, B", "F-3"]],
      ["OVERRULE `GATE 2`", ["GATE 2"]],
      ['OVERRULE: "GATE 2",', ["GATE 2"]],
      ['OVERRULE "GATE 2" 는 고치지 않는다', []],
      ["OVERRULE `GATE 2` — GATE 3 은 반드시 고쳐 주세요.", []],
      ["OVERRULE 'A, B' F-3", []],
      ['OVERRULE "GATE 2" "GATE 3"', []],
      ['OVERRULE "GATE', ['"GATE', "GATE"]],
      ["OVERRULE (F-1).", ["(F-1).", "F-1"]],
      // 감싼 토큰 뒤 설명 — 같은 줄 설명은 공백이 없는 id 여도 줄 전체를 무효로 만든다.
      ['OVERRULE "F-1" 은 고치지 않는다', []],
      ['OVERRULE "F-1"은 고치지 않는다', []],
      ["OVERRULE `F-1`, 'F-2' — 설명", []],
      ["OVERRULE 'A', 'B, C' 설명", []],
      // 닫는 따옴표 뒤 쉼표, 다른 감싼 토큰 속 쉼표 — 감싼 토큰 속 쉼표는 구분자가 아니다.
      ['OVERRULE "F-1", "F-2, F-3"', ["F-1", "F-2, F-3"]],
      ['OVERRULE "A", B"', ["A", 'B"', "B"]],
      // 탭
      ["OVERRULE\tF-1\t,\tF-2\t", ["F-1", "F-2"]],
      ["OVERRULE:\t\"GATE 2\",\t'A, B'", ["GATE 2", "A, B"]],
      ["\tOVERRULE F-1", ["F-1"]],
      ["OVERRULE F-1\tF-2", []],
      ['OVERRULE "GATE\t2"', ["GATE\t2"]],
      // CRLF — 줄 끝 CR 만 벗긴다. 줄 가운데 CR 은 구분자가 아니다.
      ["OVERRULE F-1, F-2\r\nF-3 은 고치세요\r\n", ["F-1", "F-2"]],
      ['OVERRULE "GATE 2"\r\nOVERRULE `A, B`\r\n', ["GATE 2", "A, B"]],
      ["OVERRULE F-3 — 설명\r\nOVERRULE F-1\r\n", ["F-1"]],
      ["OVERRULE F-1 \r", ["F-1"]],
      ["OVERRULE F-1\r, F-2", []],
      // 빈 따옴표 — 감싼 토큰은 한 글자 이상이다. 빈 따옴표는 감싸지 않은 토큰("")이고, 벗긴 형태가 비면 원 토큰만 남는다.
      ['OVERRULE ""', ['""']],
      ['OVERRULE "", F-1', ['""', "F-1"]],
      ["OVERRULE ''", ["''"]],
      ['OVERRULE " "', [" "]],
      ['OVERRULE "" 은 고치지 않는다', []],
      // 연속 쉼표·선행 쉼표·빈 토큰
      ["OVERRULE F-1,,", []],
      ["OVERRULE , F-1", []],
      ["OVERRULE ,", []],
      ["OVERRULE F-1, ,F-2", []],
      // 유니코드 따옴표는 감싸는 문자가 아니다 — 감싸지 않은 토큰으로 읽혀 공백이 들면 줄 전체가 무효이고, 쉼표가 들면 두 토큰으로 갈린다.
      ["OVERRULE “GATE 2”", []],
      ["OVERRULE “GATE 2”, F-3", []],
      ["OVERRULE “F-1”", ["“F-1”"]],
      ["OVERRULE “F-1”, “F-2”", ["“F-1”", "“F-2”"]],
      ["OVERRULE ‘A, B’", ["‘A", "B’"]],
      // 여러 지시 줄은 합친다.
      ['OVERRULE F-1\nOVERRULE "GATE 2"', ["F-1", "GATE 2"]],
    ];
    expect(new Set(cases.map(([body]) => body)).size).toBe(cases.length);
    expect(Object.fromEntries(cases.map(([body]) => [body, [...overruleDirectiveIDs(body)].sort()])))
      .toEqual(Object.fromEntries(cases.map(([body, expected]) => [body, [...expected].sort()])));
  });

  it("감싼 토큰은 닫는 따옴표·백틱 바로 뒤가 쉼표나 줄 끝일 때만 감싼 토큰이다 — 닫는 문자 뒤에 다른 문자가 붙으면 줄 판정과 id 추출이 같은 한 번의 훑기로 그 자리를 감싸지 않은 토큰으로 읽고, 줄은 감싸지 않은 토큰으로 통과시킨 뒤 id 는 감싼 토큰으로 뽑아 줄에 토큰으로 적히지 않은 조각(OVERRULE \"F-1\"은 의 F-1·은, OVERRULE 'F-1, F-2'x 의 F-1, F-2·x)을 면제로 세지 않는다(2026-09-15 감사 6차 #6·#9)", () => {
    const cases: Array<[string, string[]]> = [
      ['OVERRULE "F-1"은', ['"F-1"은', 'F-1"은']],
      ["OVERRULE 'F-1, F-2'x", ["'F-1", "F-1", "F-2'x"]],
      ['OVERRULE "a"b, c', ['"a"b', 'a"b', "c"]],
      ['OVERRULE "A, "B"', ['"A', "A", "B"]],
    ];
    expect(Object.fromEntries(cases.map(([body]) => [body, [...overruleDirectiveIDs(body)].sort()])))
      .toEqual(Object.fromEntries(cases.map(([body, expected]) => [body, [...expected].sort()])));
  });
});
