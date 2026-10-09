import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/server/adapters/claude";
import { parseAgentResult, ResponseLimitViolation, UnverifiedAgentResult, isUnverifiedResult, unverifiedResponse, validateAgentResult } from "../src/server/adapters/resultParser";
import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { EngineCore, isFormatOnlyViolation } from "../src/server/engine/core";
import { GitService } from "../src/server/git";
import { bindingOf } from "../src/server/turnRouting";
import { BudgetBlocked } from "../src/server/budgetLedger";
import { AdmissionRefused } from "../src/server/engine/turnExecutor";
import type { AgentAdapter, CommandResult, CommandRunner, CommandSpec, SessionTurn } from "../src/server/types";
import { RESPONSE_RESOLVED_IDS_LIMIT, type AgentResult } from "../src/shared/contracts";
import { mergeCorrectionResult, salvageResultFields } from "../src/shared/workflow";

// 2026-10-07 R3: 서버 형식 검사(zod)에 걸린 최종 구조화 응답이 어댑터에서 버려지지 않고, 결과를 곧바로 계약 검사로 넘기는 호출자에서만 같은 세션 교정으로
// 간다. 재현 사례와 같은 모양의 합성 결과 — 505자 단계·status completed·requestedMediatorAction·쟁점·엔진 결함 보고. 모델 호출 0(가짜 어댑터).
const roots: string[] = []; const dbs: ConsensusDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const longStep = "Runner: reread the root frames before the affected rows. ".padEnd(505, "x");
function rejectedAssessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "REVIEW", summary: "Root A diverged from root B, so the plan's reread trigger misses changes to B.",
    planMarkdown: null, planEdits: null, planLineEdits: null, planSHA256: null,
    findings: [{ id: "EV-1", title: "Reread trigger misses root B", severity: "HIGH", disposition: null, rationale: "Only root A changes trigger a reread.",
      evidenceRefs: ["change packet"], requiresUserDecision: false, evidenceGap: null, planImpact: null }],
    engineDefects: [{ key: "design-units-identical", title: "Design units are identical at root scale", evidence: "Both units hash the same.", workaround: "" }],
    evidenceRefs: ["plan artifact"], requestedUserDecision: null, requestedMediatorAction: "Ask the planner to revise the reread trigger.",
    memoryUpdates: null, toleranceLedger: null, status: "completed", remainingSteps: ["Planner: revise the trigger", longStep, "Runner: record both roots"],
    resolvesRequestedDecision: null, resolvedRequestId: null, resolvedRequestIds: null, reviewDecisionAnswers: null, decisionAssessments: null,
    ...overrides,
  };
}
// Claude stream-json 의 최종 result 이벤트(운영 실측과 같은 subtype=success · stop_reason=tool_use).
const resultEvent = (value: Record<string, unknown>, withStructured = true) => ({ type: "result", subtype: "success", is_error: false, num_turns: 38,
  stop_reason: "tool_use", result: JSON.stringify(value), ...(withStructured ? { structured_output: value } : {}) });
const cleanReview = (): AgentResult => ({ kind: "REVIEW", summary: "Root B changes must also trigger the reread; follow-up: revise the trigger.",
  findings: [], evidenceRefs: ["plan artifact"], status: "completed" });

describe("parseAgentResult 가 검증에 실패한 최종 구조화 응답을 버리지 않는다", () => {
  it.each([true, false])("Claude result 이벤트(structured_output %s)의 응답을 기존 문구 그대로 UnverifiedAgentResult 로 던진다", withStructured => {
    let thrown: unknown;
    try { parseAgentResult([resultEvent(rejectedAssessment(), withStructured)], ""); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(UnverifiedAgentResult);
    const error = thrown as UnverifiedAgentResult;
    expect(error.message).toMatch(/^에이전트가 계약된 구조의 결과를 반환하지 않았습니다\. \(subtype=success · is_error=false · num_turns=38 · stop_reason=tool_use/);
    expect(error.raw).toMatchObject({ kind: "REVIEW", remainingSteps: expect.arrayContaining([longStep]) });
    expect(error.raw).not.toHaveProperty("planMarkdown");   // null 선택 필드는 지금처럼 지운다
    expect(isUnverifiedResult(error.raw)).toBe(true);
  });

  it("Codex 의 마지막 agent_message 응답도 같다", () => {
    const item = { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(rejectedAssessment()) } };
    expect(() => parseAgentResult([item, { type: "turn.completed" }], "")).toThrow(UnverifiedAgentResult);
  });

  it("구조화 응답이 없으면(결과 종류 없는 객체·글) 지금처럼 일반 오류다", () => {
    for (const result of [{ type: "result", subtype: "success", result: "I could not finish." }, { type: "result", subtype: "success", result: JSON.stringify({ summary: "no kind" }) }]) {
      let thrown: unknown;
      try { parseAgentResult([result], ""); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(UnverifiedAgentResult);
      expect((thrown as Error).message).toContain("계약된 구조의 결과를 반환하지 않았습니다");
    }
  });

  it("응답 한도(zod 밖)도 같은 검증 함수가 걸러 형식 위반으로 분류한다", () => {
    const ids = Array.from({ length: RESPONSE_RESOLVED_IDS_LIMIT + 1 }, (_, index) => `Q-${index}`);
    const value = cleanReview() as unknown as Record<string, unknown>;
    let thrown: unknown;
    try { validateAgentResult({ ...value, resolvesRequestedDecision: true, resolvedRequestIds: ids }); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(ResponseLimitViolation);
    expect(isFormatOnlyViolation(thrown)).toBe(true);
    expect(() => parseAgentResult([resultEvent({ ...value, resolvesRequestedDecision: true, resolvedRequestIds: ids })], "")).toThrow(UnverifiedAgentResult);
  });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "unverified-result-")); roots.push(root);
  const database = new ConsensusDatabase(join(root, "room.sqlite")); dbs.push(database);
  const topic = database.createTopic({ id: "t", slug: "t", title: "Feature", repositoryPath: root, worktreePath: root, baseRef: "main", branchName: "work",
    state: "IMPLEMENTING", workflowMode: "planned", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  const source = database.evidence.register(topic.id, { url: "https://team.atlassian.net/browse/APP-1", label: "Feature", mode: "connector", intervalSeconds: 300 });
  const check = database.evidence.begin(source.id, true)!;
  database.evidence.ingest(source.id, { checkId: check.checkId, revision: "initial", units: [{ id: "issue", kind: "issue", content: "initial" }] });
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const corrections: SessionTurn[] = [];
  let correct: (turn: SessionTurn) => Promise<AgentResult> = async () => cleanReview();
  let original: Record<string, unknown> = rejectedAssessment();
  const adapter: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
    // 실제 Claude 어댑터처럼 실행 전에 세션 id 를 알리고, 최종 응답을 실제 파서로 읽는다.
    createSession: vi.fn(async turn => {
      turn.onSessionCreated?.("review", "allocated");
      await turn.beforeSpawn?.(); turn.admitSync?.();
      return { sessionId: "review", result: parseAgentResult([resultEvent(original)], "") };
    }),
    resumeTurn: vi.fn(async turn => { corrections.push(turn); return correct(turn); }) };
  const dependencies = { database, artifacts: new ArtifactStore(join(root, "topics"), database), git: new GitService(runner), claude: adapter,
    codex: { ...adapter, role: "codex" as const }, enforceBudgets: false };
  return { root, database, adapter, dependencies, corrections,
    setCorrection: (fn: typeof correct) => { correct = fn; }, setOriginal: (value: Record<string, unknown>) => { original = value; } };
}
async function inAction(core: EngineCore, work: (signal: AbortSignal) => Promise<unknown>): Promise<unknown> {
  let thrown: unknown = null;
  core.startAction("t", "test", async signal => { try { await work(signal); } catch (error) { thrown = error; } });
  await core.active.get("t")!.completion;
  return thrown;
}

it("응답 한도는 한 번 응답에만 건다 — 여러 턴을 합친 결과(재대조의 누적본)는 한도를 넘어도 교정으로 보내지 않는다", async () => {
  const f = fixture();
  f.database.updateTopic("t", { state: "CODEX_REVIEW" });
  const core = new EngineCore(f.dependencies);
  const topic = f.database.getTopic("t");
  const route = core.route(topic, { role: "reviewer", operation: "review" });
  const ids = Array.from({ length: RESPONSE_RESOLVED_IDS_LIMIT + 1 }, (_, i) => `Q-${i}`);
  const merged = (): AgentResult => ({ kind: "REVIEW", summary: "Merged across turns", findings: [], evidenceRefs: [], status: "completed", resolvesRequestedDecision: true, resolvedRequestIds: ids });
  const context = (signal: AbortSignal) => ({ signal, planMode: false, startedAfter: core.latestSequence("t") });
  let accepted: AgentResult | undefined;
  expect(await inAction(core, async signal => { accepted = await core.enforceResultContract(route, topic, merged(), "review", context(signal)); })).toBeNull();
  expect(accepted?.resolvedRequestIds).toHaveLength(RESPONSE_RESOLVED_IDS_LIMIT + 1);
  expect(f.corrections).toHaveLength(0);
  f.setCorrection(async () => ({ kind: "REVIEW", summary: "Only this turn's ids", findings: [], evidenceRefs: [], status: "completed" }));
  expect(await inAction(core, signal => core.enforceResultContract(route, topic, unverifiedResponse(merged()), "review", context(signal)))).toBeNull();
  expect(f.corrections).toHaveLength(1);
  expect(f.corrections[0].prompt).toContain(`resolvedRequestIds 가 한 번 응답 한도 ${RESPONSE_RESOLVED_IDS_LIMIT}개를 넘습니다`);
});

describe("결과를 계약 검사로 넘기지 않는 호출은 지금처럼 오류를 받는다", () => {
  it("acceptUnverified 없이 부른 실행기 호출(planner/ack 프로토콜 확인)은 검증 안 된 응답을 결과로 받지 않는다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    const topic = f.database.getTopic("t");
    const route = core.route(topic, { role: "planner", operation: "ack" });
    const thrown = await inAction(core, signal => core.executor.execute({ route, topic, signal, purpose: "프로토콜 확인",
      inputSequence: core.latestSequence("t"), expected: core.expectationOf(topic), session: { mode: "create" }, prompt: "Acknowledge",
      settings: { ...route.settings, effort: "low" } }));
    expect(thrown).toBeInstanceOf(UnverifiedAgentResult);
    expect((thrown as Error).message).toContain("에이전트가 계약된 구조의 결과를 반환하지 않았습니다");
    expect(f.adapter.resumeTurn).not.toHaveBeenCalled();
  });


  it("대조: 계획 제어가 아니면 같은 참여 호출은 답한 세션과 함께 검증 안 된 결과로 정착한다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CLAUDE_PLAN" });
    const core = new EngineCore(f.dependencies);
    const topic = f.database.getTopic("t");
    const route = core.route(topic, { role: "planner", operation: "plan" });
    let outcome: Awaited<ReturnType<typeof core.executor.execute>> | undefined;
    const thrown = await inAction(core, async signal => { outcome = await core.executor.execute({ route, topic, signal, purpose: "턴",
      inputSequence: core.latestSequence("t"), expected: core.expectationOf(topic), session: { mode: "create" }, prompt: "Plan", settings: route.settings,
      acceptUnverified: true, onResponse: response => expect(response.sessionId).toBe("review") }); });
    expect(thrown).toBeNull();
    expect(outcome).toMatchObject({ sessionId: "review", created: true, result: { kind: "REVIEW" } });
    expect(isUnverifiedResult(outcome!.result)).toBe(true);
  });
});

class RecordingRunner implements CommandRunner {
  constructor(private readonly result: CommandResult) {}
  async run(_spec: CommandSpec): Promise<CommandResult> { return this.result; }
}

it("Figma 응답을 받지 못한 구현 턴의 검증 안 된 결과는 차단 보고로 인정하지 않고 Figma 오류로 멈춘다(교정으로 새지 않는다)", async () => {
  const blocked = { kind: "IMPLEMENTATION", summary: "", findings: [], evidenceRefs: [], status: "blocked" };   // summary 가 비어 검증 실패
  const lines = [
    { type: "assistant", message: { content: [{ type: "tool_use", id: "missing", name: "mcp__figma-desktop__get_screenshot", input: { nodeId: "1:2" } }] } },
    resultEvent(blocked),
  ];
  const runner = new RecordingRunner({ exitCode: 0, stdout: lines.map(line => JSON.stringify(line)).join("\n"), stderr: "", jsonLines: lines });
  let thrown: unknown;
  try {
    await new ClaudeAdapter(runner, undefined, { figmaMcpUrl: "http://127.0.0.1:3845/mcp" })
      .createSession({ cwd: "/tmp", prompt: "Implement", implementation: true, figmaReadEnabled: true });
  } catch (error) { thrown = error; }
  expect((thrown as Error).message).toContain("Figma response was not captured");
  expect(thrown).not.toBeInstanceOf(UnverifiedAgentResult);
});


it("교정 응답이 in_progress 로 남은 단계를 비워도 병합이 원본의 한도 넘는 단계를 되살리지 않는다(R3c)", async () => {
  const original = { kind: "REVIEW", summary: "Review in progress", findings: [], evidenceRefs: [], status: "in_progress", remainingSteps: ["Check A", longStep] };
  const salvaged = salvageResultFields(original, "REVIEW");
  expect(salvaged.remainingSteps).toEqual(["Check A"]);
  const merged = mergeCorrectionResult(salvaged, { kind: "REVIEW", summary: "Still reviewing", findings: [], evidenceRefs: [], status: "in_progress" }).result;
  expect(merged.remainingSteps).toEqual(["Check A"]);
  expect(() => validateAgentResult(merged)).not.toThrow();
});

// R3h(R3 묶음 리뷰 7374d106 지적 F001~F003) — 최종 응답 우선, 원응답·누적본 출처 구분, 교정 뒤 공통 정착 처리. 187e029 에서 실패하던 재현이다.
describe("최종 응답 보존과 원응답·누적본의 구분, 교정 뒤 공통 처리(R3h)", () => {
  const review = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({ kind: "REVIEW", summary: "Reviewed", findings: [], evidenceRefs: [], status: "completed", ...overrides });
  const ids = (from: number, count = RESPONSE_RESOLVED_IDS_LIMIT) => Array.from({ length: count }, (_, i) => `Q-${from + i}`);
  const reviewTurn = (f: ReturnType<typeof fixture>, check?: (result: AgentResult) => void) => {
    if (!f.database.getTopic("t").participants.some(p => p.role === "codex")) {
      f.database.upsertParticipant("t", { role: "codex", sessionId: "codex-seat", mode: "attached", acknowledgedPlanSHA256: null });
    }
    const core = new EngineCore(f.dependencies);
    return { core, run: async () => {
      let accepted: AgentResult | undefined;
      const thrown = await inAction(core, async signal => {
        const topic = f.database.getTopic("t");
        accepted = await core.turn(core.route(topic, { role: "reviewer", operation: "review" }), topic, "Review", signal, { freshSession: true, check });
      });
      return { accepted, thrown };
    } };
  };

  it("F001: 같은 호출의 앞선 유효 JSON 이 있어도 검증에 실패한 마지막 응답을 보존한다", () => {
    const earlier = { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(review({ summary: "Stale verdict" })) } };
    const latest = { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(review({ summary: "Latest verdict",
      findings: [{ id: "F-NEW", title: "New defect", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "Found last.", evidenceRefs: [], requiresUserDecision: false }],
      status: "in_progress", remainingSteps: [longStep] })) } };
    let thrown: unknown; let parsed: AgentResult | undefined;
    try { parsed = parseAgentResult([earlier, latest, { type: "turn.completed" }], ""); } catch (error) { thrown = error; }
    expect(parsed?.summary).toBeUndefined();
    expect(thrown).toBeInstanceOf(UnverifiedAgentResult);
    expect((thrown as UnverifiedAgentResult).raw).toMatchObject({ summary: "Latest verdict" });
  });

  it("F002(core.turn): 병합 교정 대기본(해소 id 200개)의 재개는 응답 한도로 교정하지 않고 id 를 잃지 않는다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    f.setOriginal(review({ resolvesRequestedDecision: true, resolvedRequestIds: ids(0) }));
    f.setCorrection(async () => review({ summary: "Corrected", resolvesRequestedDecision: true, resolvedRequestIds: ids(100) }) as unknown as AgentResult);
    let checks = 0;
    const { run } = reviewTurn(f, () => { if (++checks <= 2) throw new Error("재현용 계약 위반"); });
    expect((await run()).thrown).toBeTruthy();
    expect(JSON.parse((await f.dependencies.artifacts.readLatest("t", "pending-contract-repair"))!).raw.resolvedRequestIds).toHaveLength(200);
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    const second = await run();
    expect(second.thrown).toBeNull();
    expect(f.corrections).toHaveLength(1);   // 재개에서 추가 교정 없음
    expect(second.accepted?.resolvedRequestIds).toHaveLength(200);
  });


  it("R3i F001: 최종 이벤트가 있으면 kind 가 없는 JSON·일반 문장이어도 앞선 유효 판정으로 물러서지 않고 일반 오류로 멈춘다", () => {
    const earlier = { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(review({ summary: "Stale verdict" })) } };
    for (const text of [JSON.stringify({ summary: "No kind here" }), "I could not finish the review."]) {
      const latest = { type: "item.completed", item: { type: "agent_message", text } };
      let thrown: unknown; let parsed: AgentResult | undefined;
      try { parsed = parseAgentResult([earlier, latest, { type: "turn.completed" }], ""); } catch (error) { thrown = error; }
      expect(parsed?.summary).toBeUndefined();
      expect(thrown).toBeInstanceOf(Error);
      expect(thrown).not.toBeInstanceOf(UnverifiedAgentResult);
    }
  });

  it("R3i F002: 누적 대기본을 재개한 교정이 형식 오류로 다시 멈춰도 누적 출처를 승계한다 — 다음 재개도 응답 한도·id 절단 없이 잇는다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    f.setOriginal(review({ resolvesRequestedDecision: true, resolvedRequestIds: ids(0) }));
    f.setCorrection(async () => review({ summary: "Corrected", resolvesRequestedDecision: true, resolvedRequestIds: ids(100) }) as unknown as AgentResult);
    let checks = 0;
    const { run } = reviewTurn(f, () => { if (++checks <= 3) throw new Error("재현용 계약 위반"); });
    expect((await run()).thrown).toBeTruthy();   // 원본·병합본 위반 → 누적 대기본
    const pending = async () => JSON.parse((await f.dependencies.artifacts.readLatest("t", "pending-contract-repair"))!);
    expect(await pending()).toMatchObject({ accumulated: true });
    f.setCorrection(async () => { throw new UnverifiedAgentResult({ kind: "REVIEW", summary: 7 }, "에이전트 응답 형식이 올바르지 않습니다: summary"); });
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    expect((await run()).thrown).toBeTruthy();   // 재개 → 남은 위반 → 교정 응답 형식 오류
    expect(await pending()).toMatchObject({ accumulated: true });
    expect((await pending()).raw.resolvedRequestIds).toHaveLength(200);
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    const third = await run();
    expect(third.thrown).toBeNull();
    expect(f.corrections).toHaveLength(2);   // 세 번째 재개는 교정 없이 받아들인다
    expect(third.accepted?.resolvedRequestIds).toHaveLength(200);
  });

  it("R3i F002: 누적 대기본을 재개한 교정이 한도로 멈춰 다시 저장해도 누적 출처를 승계한다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    f.setOriginal(review({ resolvesRequestedDecision: true, resolvedRequestIds: ids(0) }));
    f.setCorrection(async () => review({ summary: "Corrected", resolvesRequestedDecision: true, resolvedRequestIds: ids(100) }) as unknown as AgentResult);
    let checks = 0;
    const { run } = reviewTurn(f, () => { if (++checks <= 3) throw new Error("재현용 계약 위반"); });
    expect((await run()).thrown).toBeTruthy();
    // 한도 정지는 예산 정지로 재현한다 — 옛 재작성 회차 정지(RevisionBlocked)는 ⑦-2 에서 지웠고, 보존 규칙(preservesLatest)은 같다.
    f.setCorrection(async () => { throw new BudgetBlocked("account", "budget"); });
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    expect((await run()).thrown).toBeInstanceOf(BudgetBlocked);
    const pending = JSON.parse((await f.dependencies.artifacts.readLatest("t", "pending-contract-repair"))!);
    expect(pending).toMatchObject({ accumulated: true });
    expect(pending.raw.resolvedRequestIds).toHaveLength(200);
  });

  it("F002 호환: 출처 표시(accumulated)가 없는 옛 교정 대기본은 지금처럼 한 번 응답이라 응답 한도로 교정한다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    const { core, run } = reviewTurn(f);
    const topic = f.database.getTopic("t");
    const route = core.route(topic, { role: "reviewer", operation: "review" });
    await f.dependencies.artifacts.write("t", "pending-contract-repair", core.latestSequence("t") + 1, JSON.stringify({
      role: "codex", binding: bindingOf(route), stage: "CODEX_REVIEW", scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, planSHA256: topic.planSHA256,
      participantSessionId: "codex-seat", sessionId: "review", raw: review({ resolvesRequestedDecision: true, resolvedRequestIds: ids(0, RESPONSE_RESOLVED_IDS_LIMIT + 1) }),
      contextKey: null, startedAfter: core.latestSequence("t"), evidenceDigest: f.database.evidence.topic(topic).digest,
    }));
    f.setCorrection(async () => review({ summary: "Within the limit" }) as unknown as AgentResult);
    expect((await run()).thrown).toBeNull();
    expect(f.adapter.createSession).not.toHaveBeenCalled();
    expect(f.corrections).toHaveLength(1);
    expect(f.corrections[0].prompt).toContain(`resolvedRequestIds 가 한 번 응답 한도 ${RESPONSE_RESOLVED_IDS_LIMIT}개를 넘습니다`);
  });

  // R3j(재리뷰 032c0273): 보존 쓰기가 거부돼도 원래 정지 오류를 올리는지 — 대기본(pending-contract-repair)과 응답 순서를 읽고 둔다(모델 호출 0).
  const pendingOf = async (f: ReturnType<typeof fixture>) => JSON.parse((await f.dependencies.artifacts.readLatest("t", "pending-contract-repair")) ?? "null");
  const respond = (f: ReturnType<typeof fixture>, steps: Array<() => AgentResult>) => f.setCorrection(async () => steps.shift()!());

  it("R3j: 보존 쓰기가 중단된 실행이라 거부돼도(StaleArtifactError) 원래 정지 오류를 그대로 올린다", async () => {
    for (const blocked of [() => new BudgetBlocked("account", "budget"), () => new AdmissionRefused("cancelled", "실행이 취소되었습니다.")]) {
      const f = fixture();
      f.database.updateTopic("t", { state: "CODEX_REVIEW" });
      f.setOriginal(review({ summary: "" }));
      const { core, run } = reviewTurn(f);
      respond(f, [() => { core.active.get("t")!.controller.abort(); throw blocked(); }]);
      expect((await run()).thrown).toBeInstanceOf(blocked().constructor);
      expect(await pendingOf(f)).toBeNull();
    }
  });

});
