import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/server/adapters/claude";
import { parseAgentResult, ResponseLimitViolation, UnverifiedAgentResult, isUnverifiedResult, unverifiedResponse, validateAgentResult } from "../src/server/adapters/resultParser";
import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { EngineCore, isFormatOnlyViolation } from "../src/server/engine/core";
import { EvidenceAssessmentPipeline } from "../src/server/engine/evidenceAssessment";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import { WorkflowEngine } from "../src/server/workflow";
import { bindingOf } from "../src/server/turnRouting";
import { RevisionBlocked } from "../src/server/revisionLedger";
import { BudgetBlocked } from "../src/server/budgetLedger";
import { AdmissionRefused } from "../src/server/engine/turnExecutor";
import type { AgentAdapter, CommandResult, CommandRunner, CommandSpec, SessionTurn } from "../src/server/types";
import { REQUIRED_PLAN_HEADINGS, RESPONSE_RESOLVED_IDS_LIMIT, type AgentResult } from "../src/shared/contracts";
import { hashPlan, mergeCorrectionResult, salvageResultFields } from "../src/shared/workflow";

// 2026-10-07 R3: 서버 형식 검사(zod)에 걸린 최종 구조화 응답이 어댑터에서 버려지지 않고, 결과를 곧바로 계약 검사로 넘기는 호출자에서만 같은 세션 교정으로
// 간다. 재현 사례와 같은 모양의 합성 결과 — 505자 단계·status completed·requestedMediatorAction·쟁점·엔진 결함 보고. 모델 호출 0(가짜 어댑터).
const roots: string[] = []; const dbs: ConsensusDatabase[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const db of dbs.splice(0)) { try { db.close(); } catch {} } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

const longStep = "Runner: reread the root frames before the affected rows. ".padEnd(505, "x");
function rejectedAssessment(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "EVIDENCE_REPLAN", summary: "Root A diverged from root B, so the plan's reread trigger misses changes to B.",
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
const unverified = (value: Record<string, unknown>) => {
  try { parseAgentResult([resultEvent(value)], ""); } catch (error) { if (error instanceof UnverifiedAgentResult) return error; throw error; }
  throw new Error("expected an unverified result");
};
const cleanReplan = (): AgentResult => ({ kind: "EVIDENCE_REPLAN", summary: "Root B changes must also trigger the reread; follow-up: revise the trigger.",
  findings: [], evidenceRefs: ["plan artifact"], status: "completed" });

describe("parseAgentResult 가 검증에 실패한 최종 구조화 응답을 버리지 않는다", () => {
  it.each([true, false])("Claude result 이벤트(structured_output %s)의 응답을 기존 문구 그대로 UnverifiedAgentResult 로 던진다", withStructured => {
    let thrown: unknown;
    try { parseAgentResult([resultEvent(rejectedAssessment(), withStructured)], ""); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(UnverifiedAgentResult);
    const error = thrown as UnverifiedAgentResult;
    expect(error.message).toMatch(/^에이전트가 계약된 구조의 결과를 반환하지 않았습니다\. \(subtype=success · is_error=false · num_turns=38 · stop_reason=tool_use/);
    expect(error.raw).toMatchObject({ kind: "EVIDENCE_REPLAN", remainingSteps: expect.arrayContaining([longStep]) });
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
    const value = cleanReplan() as unknown as Record<string, unknown>;
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
    state: "IMPLEMENTING", scopeGeneration: 1, planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  const source = database.evidence.register(topic.id, { url: "https://team.atlassian.net/browse/APP-1", label: "Feature", mode: "connector", intervalSeconds: 300 });
  const check = database.evidence.begin(source.id, true)!;
  database.evidence.ingest(source.id, { checkId: check.checkId, revision: "initial", units: [{ id: "issue", kind: "issue", content: "initial" }] });
  database.evidence.review(topic, database.evidence.topic(topic).digest, "Compared with plan", topic);
  const runner: CommandRunner = { run: vi.fn(async () => ({ exitCode: 0, stdout: "", stderr: "", jsonLines: [] })) };
  const corrections: SessionTurn[] = [];
  let correct: (turn: SessionTurn) => Promise<AgentResult> = async () => cleanReplan();
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
async function reviewPlan(f: ReturnType<typeof fixture>, core: EngineCore) {
  if (f.database.getTopic("t").state !== "AWAITING_USER_APPROVAL") {
    const plan = await f.dependencies.artifacts.write("t", "plan", 1, "Current plan");
    f.database.updateTopic("t", { state: "AWAITING_USER_APPROVAL", planSHA256: plan.sha256, approvedPlanSHA256: null });
  }
  new EvidenceAssessmentPipeline(core).reviewCurrent("t", `review-${f.corrections.length}`);
  await core.active.get("t")!.completion;
  return f.database.evidence.automation.jobs("t")[0];
}

describe("근거 영향 검토의 검증 안 된 결과는 같은 세션 교정 1회로 간다", () => {
  it("영수증을 교정 전에 남기고, 형식 위반과 완료 조건을 한 교정 지시에 실어 추론 low 로 고친 뒤 원본 쟁점을 보존해 받아들인다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    let receiptAtCorrection: unknown;
    f.setCorrection(async () => {
      receiptAtCorrection = structuredClone(f.database.evidence.automation.receipt(f.database.evidence.automation.jobs("t")[0].id));
      return cleanReplan();
    });
    const job = await reviewPlan(f, core);
    expect(job).toMatchObject({ status: "complete", outcome: "replan" });
    expect(f.adapter.createSession).toHaveBeenCalledTimes(1);
    // 교정은 생성 세션을 이어 쓰고(새 세션으로 전체 재검토가 아니다) 표기 교정이라 추론 low 다.
    expect(f.corrections).toHaveLength(1);
    expect(f.corrections[0]).toMatchObject({ sessionId: "review", settings: expect.objectContaining({ effort: "low" }) });
    expect(f.corrections[0].prompt).toContain("remainingSteps");
    expect(f.corrections[0].prompt).toContain("근거 검토 미완료(remainingSteps 3개 · requestedMediatorAction 있음)");
    // 영수증은 교정 전에 세션 id 와 원본으로 남는다 — retry 가 이 세션에서 이어 간다.
    expect(receiptAtCorrection).toMatchObject({ sessionId: "review", raw: { kind: "EVIDENCE_REPLAN", remainingSteps: expect.arrayContaining([longStep]) } });
    const accepted = f.database.evidence.automation.receipt(job.id)!.accepted!;
    expect(accepted).not.toHaveProperty("remainingSteps");
    expect(accepted).not.toHaveProperty("requestedMediatorAction");
    expect(accepted.findings.map(finding => finding.id)).toEqual(["EV-1"]);
    expect(accepted.engineDefects).toEqual([expect.objectContaining({ key: "design-units-identical" })]);
    const bodies = f.database.getTimeline("t").map(event => event.body);
    expect(bodies.some(body => body.startsWith("기계 계약 위반을 같은 세션에 돌려보내 1회 교정합니다(표기 교정 — 추론 low)"))).toBe(true);
    // 근거 검토의 원본은 영수증이 갖는다 — 단계의 교정 원본(구현 재개·진단 개정이 소비)을 쓰지 않는다.
    expect(f.database.latestArtifact("t", "contract-repair-source")).toBeNull();
  });

  it("교정 뒤에도 완료 조건을 어기면 두 번째 교정 없이 실패하고, 위반문이 고칠 필드를 말한다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    f.setCorrection(async () => ({ ...cleanReplan(), remainingSteps: ["Planner: revise the trigger"] }));
    const job = await reviewPlan(f, core);
    expect(f.corrections).toHaveLength(1);
    expect(job).toMatchObject({ status: "failed", summary: expect.stringContaining("근거 검토 미완료(remainingSteps 1개): 근거 검토 결과는 status=completed 이고") });
    expect(job.summary).not.toContain("Root B changes must also trigger");   // 요약 본문을 위반문에 싣지 않는다
  });

  it("교정이 끊긴 retry 는 새 세션을 만들지 않고 영수증의 세션에서 교정한다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    f.setCorrection(async () => { throw new Error("correction interrupted"); });
    expect(await reviewPlan(f, core)).toMatchObject({ status: "failed" });
    f.setCorrection(async () => cleanReplan());
    expect(await reviewPlan(f, core)).toMatchObject({ status: "complete", outcome: "replan" });
    expect(f.adapter.createSession).toHaveBeenCalledTimes(1);
    expect(f.corrections.map(turn => turn.sessionId)).toEqual(["review", "review"]);
  });

  it("원본이 진행 중(in_progress)이어도 교정이 status 를 비우면 받아들인다 — 병합이 원본 status 를 되살리지 않는다(R3d)", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    f.setOriginal(rejectedAssessment({ status: "in_progress" }));
    f.setCorrection(async () => { const { status: _status, ...rest } = cleanReplan(); return rest as AgentResult; });
    const job = await reviewPlan(f, core);
    expect(job).toMatchObject({ status: "complete", outcome: "replan" });
    expect(f.corrections).toHaveLength(1);
    expect(f.database.evidence.automation.receipt(job.id)!.accepted).not.toHaveProperty("status");
  });

  it("교정 영수증은 본 경로와 같은 병합이라 교정이 비운 필드를 되살리지 않는다 — retry 가 이미 고친 위반으로 교정을 다시 열지 않게(R3d)", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    f.setOriginal(rejectedAssessment({ status: "in_progress" }));
    const job = await reviewPlan(f, core);
    expect(job).toMatchObject({ status: "complete" });
    const receipt = f.database.evidence.automation.receipt(job.id)!;
    expect(receipt.raw).not.toHaveProperty("requestedMediatorAction");
    expect(receipt.raw).not.toHaveProperty("remainingSteps");
    expect(receipt.raw).not.toHaveProperty("status", "in_progress");
    expect(receipt.raw.findings.map(finding => finding.id)).toEqual(["EV-1"]);   // 원본의 유효한 쟁점은 그대로 보존한다
  });

  it("응답 한도 위반도 조용히 받아들이지 않고 표기 교정으로 간다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    f.setOriginal({ ...cleanReplan(), resolvesRequestedDecision: true, resolvedRequestIds: Array.from({ length: RESPONSE_RESOLVED_IDS_LIMIT + 1 }, (_, i) => `Q-${i}`) });
    expect(await reviewPlan(f, core)).toMatchObject({ status: "complete" });
    expect(f.corrections).toHaveLength(1);
    expect(f.corrections[0].prompt).toContain(`resolvedRequestIds 가 한 번 응답 한도 ${RESPONSE_RESOLVED_IDS_LIMIT}개를 넘습니다`);
    expect(f.corrections[0].settings).toMatchObject({ effort: "low" });
  });
});

// 엔진 호출은 실행 중인 action 안에서만 현재 응답이다 — 실제 경로처럼 action 안에서 부르고 던진 오류를 받는다.
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
  const context = (signal: AbortSignal) => ({ signal, planMode: false, startedAfter: core.latestSequence("t"), evidenceDigest: f.database.evidence.topic(topic).digest });
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
  it("isolatedTurn(프로토콜 확인)은 검증 안 된 응답을 결과로 받지 않는다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    const topic = f.database.getTopic("t");
    const thrown = await inAction(core, signal => core.isolatedTurn(core.route(topic, { role: "planner", operation: "ack" }), topic, "Acknowledge", signal));
    expect(thrown).toBeInstanceOf(UnverifiedAgentResult);
    expect((thrown as Error).message).toContain("에이전트가 계약된 구조의 결과를 반환하지 않았습니다");
    expect(f.adapter.resumeTurn).not.toHaveBeenCalled();
  });

  it("계획 제어 턴은 참여 표식이 있어도 결과로 바꾸지 않는다(체크포인트 루프가 응답을 관리한다)", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CLAUDE_PLAN" });
    f.database.planning.enable("t");
    const core = new EngineCore(f.dependencies);
    const topic = f.database.getTopic("t");
    const route = core.route(topic, { role: "planner", operation: "plan" });
    const thrown = await inAction(core, signal => core.executor.execute({ route, topic, signal, purpose: "턴", inputSequence: core.latestSequence("t"),
      expected: core.expectationOf(topic), session: { mode: "create" }, prompt: "Plan", settings: route.settings, acceptUnverified: true }));
    expect(thrown).toBeInstanceOf(UnverifiedAgentResult);
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
    expect(outcome).toMatchObject({ sessionId: "review", created: true, result: { kind: "EVIDENCE_REPLAN" } });
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

// R3b: 구현 작업 턴·계속 진행 턴도 참여한다 — 결과를 곧바로 absorbTurn(원본은 salvage·checkpoint, 계약 검사로)으로 넘긴다.
describe("구현·계속 진행 턴의 검증 안 된 결과도 같은 세션 교정으로 간다(R3b)", { timeout: 30_000 }, () => {
  const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  async function implementationRoom(label: string) {
    const root = mkdtempSync(join(tmpdir(), `unverified-implementation-${label}-`)); roots.push(root);
    const repository = join(root, "repository"), worktree = join(root, "worktrees", "topic");
    git(root, ["init", "--initial-branch=develop", repository]);
    git(repository, ["config", "user.name", "Consensus Room Test"]);
    git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
    writeFileSync(join(repository, "feature.txt"), "기준\n");
    git(repository, ["add", "."]); git(repository, ["commit", "-m", "baseline"]);
    const gitService = new GitService(new SpawnCommandRunner());
    await gitService.createDetachedWorktree(repository, worktree, "develop");
    mkdirSync(join(root, "data"), { recursive: true });
    const database = new ConsensusDatabase(join(root, "data", "room.sqlite")); dbs.push(database);
    const artifacts = new ArtifactStore(join(root, "data", "topics"), database);
    const plan = REQUIRED_PLAN_HEADINGS.map(heading => heading === "허용 오차"
      ? `## ${heading}\n\n규칙은 아래 블록\n\n\`\`\`tolerance\n{"scopePaths":["feature.txt"],"rules":[]}\n\`\`\`\n` : `## ${heading}\n\n검증할 내용`).join("\n\n");
    const planSHA256 = hashPlan(plan), topicId = "11111111-2222-4333-8444-777777777777", timestamp = "2026-10-07T00:00:00.000Z";
    database.createTopic({ id: topicId, slug: "unverified", title: "검증 안 된 구현 결과", repositoryPath: repository, baseRef: "develop", worktreePath: worktree,
      branchName: null, state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 2, planSHA256, approvedPlanSHA256: planSHA256,
      createdAt: timestamp, updatedAt: timestamp, lastError: null });
    for (const role of ["claude", "codex"] as const) database.upsertParticipant(topicId, { role, sessionId: `${role}-plan-session`, mode: "attached", acknowledgedPlanSHA256: planSHA256 });
    await artifacts.write(topicId, "plan", 2, `${plan.trim()}\n`);
    return { worktree, database, artifacts, gitService, topicId };
  }
  const implementation = (extra: Partial<AgentResult> = {}): AgentResult => ({ kind: "IMPLEMENTATION", summary: "구현", findings: [], evidenceRefs: ["검증"], status: "completed", ...extra });
  const codex: AgentAdapter = { role: "codex", validateExistingSession: async () => true,
    createSession: async () => ({ sessionId: "codex-review", result: { kind: "REVIEW", summary: "수정할 것이 없습니다.", findings: [], evidenceRefs: [] } }),
    resumeTurn: async () => ({ kind: "REVIEW", summary: "수정할 것이 없습니다.", findings: [], evidenceRefs: [] }) };
  // 리뷰가 구현 결과의 이연 지적을 그대로 다룬다(검토 쟁점 누락 검사 통과) — 구현 단계의 이연 여부만 비교하려고.
  const reviewerCovering = (finding: AgentResult["findings"][number]): AgentAdapter => {
    const reviewed = (): AgentResult => ({ kind: "REVIEW", summary: "이연된 근거 공백만 남았습니다.", findings: [{ ...finding, disposition: "DEFERRED_OUT_OF_SCOPE" }], evidenceRefs: [] });
    return { role: "codex", validateExistingSession: async () => true,
      createSession: async () => ({ sessionId: "codex-review", result: reviewed() }), resumeTurn: async () => reviewed() };
  };
  async function settle(room: Awaited<ReturnType<typeof implementationRoom>>) {
    const deadline = Date.now() + 15_000;
    while (!(room.database.runningAction(room.topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED", "BLOCKED_ON_EVIDENCE"].includes(room.database.getTopic(room.topicId).state))) {
      if (Date.now() >= deadline) throw new Error("구현 흐름이 끝나지 않았습니다.");
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    return room.database.getTopic(room.topicId);
  }

  it("첫 구현 턴의 검증 안 된 결과는 원본을 보존하고 같은 세션 추론 low 교정 1회 뒤 전달 준비로 간다", async () => {
    const room = await implementationRoom("first");
    const resumes: SessionTurn[] = [];
    const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
      createSession: async turn => {
        writeFileSync(join(room.worktree, "feature.txt"), "구현\n");
        turn.onSessionCreated?.("claude-implementation-session", "allocated");
        return { sessionId: "claude-implementation-session", result: parseAgentResult([resultEvent(implementation({ summary: "" }) as unknown as Record<string, unknown>)], "") };
      },
      resumeTurn: async turn => { resumes.push(turn); return implementation({ summary: "남은 단계 표기를 고쳤습니다." }); } };
    new WorkflowEngine({ database: room.database, artifacts: room.artifacts, git: room.gitService, claude, codex }).startImplementation(room.topicId);
    const topic = await settle(room);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(resumes).toHaveLength(1);
    expect(resumes[0]).toMatchObject({ sessionId: "claude-implementation-session", settings: expect.objectContaining({ effort: "low" }) });
    expect(resumes[0].prompt).toContain("summary");
    expect(room.database.getTimeline(room.topicId).some(event => event.body.startsWith("기계 계약 위반을 같은 세션에 돌려보내 1회 교정합니다(표기 교정 — 추론 low)"))).toBe(true);
    // 구현자 자신의 교정 원본은 지금처럼 단계의 교정 원본으로 남는다(교정이 끊기면 재개가 소비한다).
    const source = JSON.parse((await room.artifacts.readLatest(room.topicId, "contract-repair-source"))!);
    expect(source).toMatchObject({ state: "IMPLEMENTING", original: { kind: "IMPLEMENTATION", summary: "" } });
  });

  it("R3i F003 대조: 같은 등록 출처 근거 공백을 실은 정상 구현 응답은 이연돼 전달 준비로 간다", async () => {
    const room = await implementationRoom("normal-gap");
    const source = room.database.evidence.register(room.topicId, { url: "https://team.atlassian.net/browse/APP-9", label: "Feature", mode: "connector", intervalSeconds: 300 });
    const check = room.database.evidence.begin(source.id, true)!;
    room.database.evidence.ingest(source.id, { checkId: check.checkId, revision: "initial", units: [{ id: "issue", kind: "issue", content: "initial" }] });
    const topic = room.database.getTopic(room.topicId);
    room.database.evidence.review(topic, room.database.evidence.topic(topic).digest, "Compared with plan", topic);
    const gap = { id: "EV-GAP", title: "Source not collected", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE", rationale: "Registered source missing.",
      evidenceRefs: ["https://team.atlassian.net/browse/APP-9"], requiresUserDecision: false, evidenceGap: "insufficient" } as AgentResult["findings"][number];
    const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
      createSession: async turn => {
        writeFileSync(join(room.worktree, "feature.txt"), "구현\n");
        turn.onSessionCreated?.("claude-implementation-session", "allocated");
        return { sessionId: "claude-implementation-session", result: implementation({ findings: [gap] }) };
      },
      resumeTurn: async () => implementation({ summary: "unused" }) };
    new WorkflowEngine({ database: room.database, artifacts: room.artifacts, git: room.gitService, claude, codex: reviewerCovering(gap) }).startImplementation(room.topicId);
    const after = await settle(room);
    expect(after.state, after.lastError ?? "").toBe("READY_TO_DELIVER");
    const result = JSON.parse((await room.artifacts.readLatest(room.topicId, "implementation-result"))!);
    expect(result.findings).toEqual([expect.objectContaining({ id: "EV-GAP", disposition: "DEFERRED_OUT_OF_SCOPE" })]);
  });

  it("R3i F003: 교정이 끊겨 구현 checkpoint 에 보존된 등록 출처 근거 공백도, retry 뒤 최종 누적본에서 이연된다", async () => {
    const room = await implementationRoom("checkpoint-gap");
    const source = room.database.evidence.register(room.topicId, { url: "https://team.atlassian.net/browse/APP-9", label: "Feature", mode: "connector", intervalSeconds: 300 });
    const check = room.database.evidence.begin(source.id, true)!;
    room.database.evidence.ingest(source.id, { checkId: check.checkId, revision: "initial", units: [{ id: "issue", kind: "issue", content: "initial" }] });
    const topic = room.database.getTopic(room.topicId);
    room.database.evidence.review(topic, room.database.evidence.topic(topic).digest, "Compared with plan", topic);
    const gap = { id: "EV-GAP", title: "Source not collected", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE", rationale: "Registered source missing.",
      evidenceRefs: ["https://team.atlassian.net/browse/APP-9"], requiresUserDecision: false, evidenceGap: "insufficient" };
    let resumes = 0;
    const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
      createSession: async turn => {
        writeFileSync(join(room.worktree, "feature.txt"), "구현\n");
        turn.onSessionCreated?.("claude-implementation-session", "allocated");
        return { sessionId: "claude-implementation-session", result: parseAgentResult([resultEvent(implementation({ summary: "", findings: [gap] as AgentResult["findings"] }) as unknown as Record<string, unknown>)], "") };
      },
      resumeTurn: async () => { resumes++; if (resumes === 1) throw new Error("correction interrupted"); return implementation({ summary: "교정했습니다." }); } };
    const engine = new WorkflowEngine({ database: room.database, artifacts: room.artifacts, git: room.gitService, claude, codex: reviewerCovering(gap as AgentResult["findings"][number]) });
    engine.startImplementation(room.topicId);
    expect((await settle(room)).state).toBe("FAILED");
    engine.retry(room.topicId);
    const after = await settle(room);
    expect(after.state, after.lastError ?? "").toBe("READY_TO_DELIVER");
    const result = JSON.parse((await room.artifacts.readLatest(room.topicId, "implementation-result"))!);
    expect(result.findings).toEqual([expect.objectContaining({ id: "EV-GAP", disposition: "DEFERRED_OUT_OF_SCOPE" })]);
  });

  it("R3l 대조: implementer 교정 응답이 blocked·등록 출처 공백을 다시 내도 응답 단위로 해제돼 막힘 요청 없이 이어 가고 전달 준비로 간다(지금 동작 그대로)", async () => {
    const room = await implementationRoom("correction-gap");
    const source = room.database.evidence.register(room.topicId, { url: "https://team.atlassian.net/browse/APP-9", label: "Feature", mode: "connector", intervalSeconds: 300 });
    const check = room.database.evidence.begin(source.id, true)!;
    room.database.evidence.ingest(source.id, { checkId: check.checkId, revision: "initial", units: [{ id: "issue", kind: "issue", content: "initial" }] });
    const topic = room.database.getTopic(room.topicId);
    room.database.evidence.review(topic, room.database.evidence.topic(topic).digest, "Compared with plan", topic);
    const gap = { id: "EV-GAP", title: "Source not collected", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE", rationale: "Registered source missing.",
      evidenceRefs: ["https://team.atlassian.net/browse/APP-9"], requiresUserDecision: false, evidenceGap: "insufficient" } as AgentResult["findings"][number];
    const resumes: SessionTurn[] = [];
    const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
      createSession: async turn => {
        writeFileSync(join(room.worktree, "feature.txt"), "구현\n");
        turn.onSessionCreated?.("claude-implementation-session", "allocated");
        return { sessionId: "claude-implementation-session", result: parseAgentResult([resultEvent(implementation({ summary: "", status: "blocked", findings: [gap],
          remainingSteps: ["Finish after the source"] }) as unknown as Record<string, unknown>)], "") };
      },
      resumeTurn: async turn => {
        resumes.push(turn);
        return resumes.length === 1
          ? implementation({ summary: "표기를 고쳤습니다.", status: "blocked", findings: [gap], remainingSteps: ["Finish after the source"] })
          : implementation({ summary: "끝냈습니다.", findings: [{ ...gap, disposition: "DEFERRED_OUT_OF_SCOPE" }] });
      } };
    new WorkflowEngine({ database: room.database, artifacts: room.artifacts, git: room.gitService, claude, codex: reviewerCovering(gap) }).startImplementation(room.topicId);
    const after = await settle(room);
    expect(after.state, after.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(resumes).toHaveLength(2);   // 교정 1회 + 해제 뒤 계속 진행 1회
    expect(room.database.getTimeline(room.topicId).some(event => event.body.includes("러너가 막힘(blocked)으로 정지했습니다"))).toBe(false);
  });

  it("계속 진행 턴의 검증 안 된 결과도 작업 세션에서 교정한다", async () => {
    const room = await implementationRoom("continue");
    const resumes: SessionTurn[] = [];
    const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
      createSession: async turn => {
        writeFileSync(join(room.worktree, "feature.txt"), "구현 중\n");
        turn.onSessionCreated?.("claude-implementation-session", "allocated");
        return { sessionId: "claude-implementation-session", result: implementation({ status: "in_progress", remainingSteps: ["마무리"] }) };
      },
      resumeTurn: async turn => {
        resumes.push(turn);
        if (resumes.length === 1) {
          writeFileSync(join(room.worktree, "feature.txt"), "구현\n");
          return parseAgentResult([resultEvent(implementation({ summary: "" }) as unknown as Record<string, unknown>)], "");
        }
        return implementation({ summary: "마무리했습니다." });
      } };
    new WorkflowEngine({ database: room.database, artifacts: room.artifacts, git: room.gitService, claude, codex }).startImplementation(room.topicId);
    const topic = await settle(room);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(resumes.map(turn => turn.sessionId)).toEqual(["claude-implementation-session", "claude-implementation-session"]);
    expect(resumes[1].settings).toMatchObject({ effort: "low" });
    expect(resumes[1].prompt).toContain("summary");
  });

  // R3c: 운영 사례와 같은 505자 단계 — 건지기(salvageResultFields)가 길이 한도를 넘는 단계를 누적본·병합에 넣지 않아야 교정까지 간다.
  it.each([["첫 구현 턴", false], ["계속 진행 턴", true]] as const)("%s의 505자 단계도 교정 전에 죽지 않고 같은 세션 교정 1회 뒤 전달 준비로 간다", async (_label, continuation) => {
    const room = await implementationRoom(continuation ? "long-continue" : "long-first");
    const resumes: SessionTurn[] = [];
    const longResult = () => parseAgentResult([resultEvent(implementation({ remainingSteps: [longStep] }) as unknown as Record<string, unknown>)], "");
    const claude: AgentAdapter = { role: "claude", validateExistingSession: async () => true,
      createSession: async turn => {
        writeFileSync(join(room.worktree, "feature.txt"), continuation ? "구현 중\n" : "구현\n");
        turn.onSessionCreated?.("claude-implementation-session", "allocated");
        return { sessionId: "claude-implementation-session", result: continuation ? implementation({ status: "in_progress", remainingSteps: ["마무리"] }) : longResult() };
      },
      resumeTurn: async turn => {
        resumes.push(turn);
        if (continuation && resumes.length === 1) { writeFileSync(join(room.worktree, "feature.txt"), "구현\n"); return longResult(); }
        return implementation({ summary: "남은 단계를 짧게 고쳤습니다." });
      } };
    new WorkflowEngine({ database: room.database, artifacts: room.artifacts, git: room.gitService, claude, codex }).startImplementation(room.topicId);
    const topic = await settle(room);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    const correction = resumes.at(-1)!;
    expect(resumes).toHaveLength(continuation ? 2 : 1);
    expect(correction).toMatchObject({ sessionId: "claude-implementation-session", settings: expect.objectContaining({ effort: "low" }) });
    expect(correction.prompt).toContain("remainingSteps");
    // 원본(505자 단계 그대로)은 단계의 교정 원본에 남는다 — 건지기가 버린 것은 누적본에서뿐이다.
    const source = JSON.parse((await room.artifacts.readLatest(room.topicId, "contract-repair-source"))!);
    expect(source.original.remainingSteps).toEqual([longStep]);
  });
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

  it("F002(근거 검토 영수증): 교정 영수증(병합본) 재사용은 응답 한도를 걸지 않고 id 를 잃지 않는다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    f.setOriginal(rejectedAssessment({ resolvesRequestedDecision: true, resolvedRequestIds: ids(0) }));
    f.setCorrection(async () => ({ ...cleanReplan(), remainingSteps: ["Planner: revise"], resolvesRequestedDecision: true, resolvedRequestIds: ids(100) }));
    expect(await reviewPlan(f, core)).toMatchObject({ status: "failed" });
    f.setCorrection(async () => cleanReplan());
    const job = await reviewPlan(f, core);
    expect(job).toMatchObject({ status: "complete" });
    expect(f.corrections[1].prompt).not.toContain("한 번 응답 한도");
    expect(f.database.evidence.automation.receipt(job.id)!.accepted!.resolvedRequestIds).toHaveLength(200);
  });

  it("F003: 교정 병합으로 되살린 원본의 등록 출처 근거 공백도 이연 처리된다", async () => {
    const gap = { id: "EV-GAP", title: "Source not collected", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE", rationale: "Registered source missing.",
      evidenceRefs: ["https://team.atlassian.net/browse/APP-1"], requiresUserDecision: false, evidenceGap: "insufficient" };
    // 대조: 정상 응답의 같은 지적은 실행기가 이연한다.
    const valid = fixture();
    valid.database.updateTopic("t", { state: "CODEX_REVIEW" });
    valid.setOriginal(review({ findings: [gap] }));
    expect((await reviewTurn(valid).run()).accepted?.findings).toEqual([expect.objectContaining({ id: "EV-GAP", disposition: "DEFERRED_OUT_OF_SCOPE" })]);
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    f.setOriginal(review({ summary: "", findings: [gap] }));
    f.setCorrection(async () => review({ summary: "Fixed summary" }) as unknown as AgentResult);
    const { accepted, thrown } = await reviewTurn(f).run();
    expect(thrown).toBeNull();
    expect(f.corrections).toHaveLength(1);
    expect(accepted?.findings).toEqual([expect.objectContaining({ id: "EV-GAP", disposition: "DEFERRED_OUT_OF_SCOPE" })]);
  });

  it("F003: 이연으로 blocked 가 풀리면 교정 병합 경로도 정상 경로처럼 같은 원장으로 리뷰를 이어 가 같은 다음 상태가 된다", async () => {
    const gap = { id: "EV-GAP", title: "Source not collected", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE", rationale: "Registered source missing.",
      evidenceRefs: ["https://team.atlassian.net/browse/APP-1"], requiresUserDecision: false, evidenceGap: "insufficient" };
    const continued = review({ summary: "Continued the supported scope" }) as unknown as AgentResult;
    const run = async (original: Record<string, unknown>, responses: AgentResult[]) => {
      const f = fixture();
      f.database.updateTopic("t", { state: "CODEX_REVIEW" });
      f.setOriginal(original);
      f.setCorrection(async () => responses.shift()!);
      const outcome = await reviewTurn(f).run();
      return { ...outcome, prompts: f.corrections.map(turn => turn.prompt), deferredArtifact: f.database.latestArtifact("t", "review-evidence-deferred") };
    };
    // 정상: blocked 리뷰의 등록 출처 공백이 이연되면 같은 세션으로 리뷰를 이어 간다(계속 진행 1회).
    const normal = await run(review({ status: "blocked", findings: [gap] }), [continued]);
    // 교정 병합: summary 만 틀린 원본 → 교정이 summary 만 고치고 blocked 유지 → 병합본에 원본 공백이 되살아남 → 같은 이연·계속 진행.
    const restored = await run(review({ summary: "", status: "blocked", findings: [gap] }),
      [review({ summary: "Fixed summary", status: "blocked" }) as unknown as AgentResult, review({ summary: "Continued the supported scope" }) as unknown as AgentResult]);
    expect(normal.thrown).toBeNull(); expect(restored.thrown).toBeNull();
    expect(normal.prompts).toHaveLength(1);
    expect(restored.prompts).toHaveLength(2);   // 교정 1회 + 계속 진행 1회 — 차이는 교정 호출뿐이다.
    expect(restored.prompts[1]).toContain("Continue reviewing the supported scope in this same review ledger");
    for (const outcome of [normal, restored]) {
      expect(outcome.deferredArtifact).not.toBeNull();
      expect(outcome.accepted).toMatchObject({ summary: expect.stringContaining("Continued the supported scope"), status: "completed" });
      expect(outcome.accepted?.findings).toEqual([expect.objectContaining({ id: "EV-GAP", disposition: "DEFERRED_OUT_OF_SCOPE" })]);
    }
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
    f.setCorrection(async () => { throw new RevisionBlocked("t"); });
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    expect((await run()).thrown).toBeInstanceOf(RevisionBlocked);
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

  it("F002 호환: 출처 표시(rawAccumulated)가 없는 근거 검토 영수증(원본)은 지금처럼 재사용 때 응답 한도로 교정한다", async () => {
    const f = fixture();
    const core = new EngineCore(f.dependencies);
    f.setOriginal({ ...cleanReplan(), resolvesRequestedDecision: true, resolvedRequestIds: ids(0, RESPONSE_RESOLVED_IDS_LIMIT + 1) });
    f.setCorrection(async () => { throw new Error("correction interrupted"); });
    expect(await reviewPlan(f, core)).toMatchObject({ status: "failed" });
    const saved = f.database.evidence.automation.receipt(f.database.evidence.automation.jobs("t")[0].id)!;
    expect(saved).not.toHaveProperty("rawAccumulated");
    f.setCorrection(async () => cleanReplan());
    expect(await reviewPlan(f, core)).toMatchObject({ status: "complete" });
    expect(f.corrections[1].prompt).toContain(`resolvedRequestIds 가 한 번 응답 한도 ${RESPONSE_RESOLVED_IDS_LIMIT}개를 넘습니다`);
  });

  // R3l(R3 전체 재리뷰 c6029c8a F001): 리뷰 교정 응답이 blocked·등록 출처 공백을 포함한 전체 findings 를 다시 내도, 병합본이 정상 응답처럼 같은 원장으로
  // 리뷰를 이어 간다. 완료 보고 계약(delivery.reviewContractViolation)과 같은 모양으로 요청 없는 in_progress 를 거부해 다음 상태를 비교한다.
  const r3lGap = { id: "EV-GAP", title: "Source not collected", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE", rationale: "Registered source missing.",
    evidenceRefs: ["https://team.atlassian.net/browse/APP-1"], requiresUserDecision: false, evidenceGap: "insufficient" };
  const reviewContract = (result: AgentResult) => {
    if (result.status === "in_progress" && !result.remainingSteps?.length && !result.requestedMediatorAction?.trim() && !result.requestedUserDecision?.trim())
      throw new Error("재현용 완료 보고 계약: 요청 없는 in_progress");
  };
  const r3lRun = async (original: Record<string, unknown>, responses: AgentResult[], f = fixture()) => {
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    f.setOriginal(original);
    f.setCorrection(async () => responses.shift()!);
    const outcome = await reviewTurn(f, reviewContract).run();
    return { ...outcome, f, prompts: f.corrections.map(turn => turn.prompt) };
  };

  it("R3l F001: 리뷰 교정 응답이 blocked·등록 출처 공백을 포함한 전체 findings 를 다시 내도 병합본이 정상 응답처럼 같은 원장으로 리뷰를 이어 간다", async () => {
    const continued = () => review({ summary: "Continued the supported scope" }) as unknown as AgentResult;
    const normal = await r3lRun(review({ status: "blocked", findings: [r3lGap] }), [continued()]);
    const corrected = await r3lRun(review({ summary: "", status: "blocked", findings: [r3lGap] }),
      [review({ summary: "Fixed summary", status: "blocked", findings: [r3lGap] }) as unknown as AgentResult, continued()]);
    for (const outcome of [normal, corrected]) {
      expect(outcome.thrown).toBeNull();
      expect(outcome.accepted).toMatchObject({ summary: expect.stringContaining("Continued the supported scope"), status: "completed" });
      expect(outcome.accepted?.findings).toEqual([expect.objectContaining({ id: "EV-GAP", disposition: "DEFERRED_OUT_OF_SCOPE" })]);
    }
    expect(normal.prompts).toHaveLength(1);
    expect(corrected.prompts).toHaveLength(2);   // 교정 1회 + 계속 진행 1회
    expect(corrected.prompts[1]).toContain("Continue reviewing the supported scope in this same review ledger");
  });

  // R3j(재리뷰 032c0273 F002·F005, 884 모양): 이 턴이 보존할 최신 값·출처·세션은 기록 하나에서 읽는다. 누적 대기본(교정 병합본)을 직접 두고, 재개가
  // 등록 출처 근거 공백을 이연해 같은 원장으로 리뷰를 이어 가는 모양을 만든다. resumeTurn 은 계속 진행·교정 호출을 순서대로 받는다(모델 호출 0).
  const gapFinding = (source = "APP-1") => ({ id: `EV-GAP-${source}`, title: "Source not collected", severity: "MEDIUM", disposition: "EXTERNAL_EVIDENCE",
    rationale: "Registered source missing.", evidenceRefs: [`https://team.atlassian.net/browse/${source}`], requiresUserDecision: false, evidenceGap: "insufficient" });
  const keepAccumulated = async (f: ReturnType<typeof fixture>, core: EngineCore, raw: Record<string, unknown>) => {
    const topic = f.database.getTopic("t");
    await f.dependencies.artifacts.write("t", "pending-contract-repair", core.latestSequence("t") + 1, JSON.stringify({
      role: "codex", binding: bindingOf(core.route(topic, { role: "reviewer", operation: "review" })), stage: "CODEX_REVIEW", scopeGeneration: topic.scopeGeneration,
      planEpoch: topic.planEpoch, planSHA256: topic.planSHA256, participantSessionId: "codex-seat", sessionId: "review", raw, contextKey: null,
      startedAfter: core.latestSequence("t"), evidenceDigest: f.database.evidence.topic(topic).digest, accumulated: true,
    }));
  };
  const pendingOf = async (f: ReturnType<typeof fixture>) => JSON.parse((await f.dependencies.artifacts.readLatest("t", "pending-contract-repair")) ?? "null");
  const respond = (f: ReturnType<typeof fixture>, steps: Array<() => AgentResult>) => f.setCorrection(async () => steps.shift()!());
  const failsOnContinued = (result: AgentResult) => { if (result.summary.startsWith("Continued")) throw new Error("재현용 계약 위반: 계속 진행 응답"); };

  it("R3j F002: 누적 대기본을 재개해 리뷰를 계속 진행한 응답은 한 번 응답이다 — 교정 뒤 위반으로 다시 보존해도 누적 표시가 없고, 다음 재개가 응답 한도로 교정한다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    const { core, run } = reviewTurn(f);
    await keepAccumulated(f, core, review({ status: "blocked", findings: [gapFinding()] }));
    respond(f, [
      () => { throw unverified(review({ summary: "Continued the supported scope", resolvesRequestedDecision: true, resolvedRequestIds: ids(0, RESPONSE_RESOLVED_IDS_LIMIT + 1) })); },
      () => { throw new UnverifiedAgentResult({ kind: "REVIEW", summary: 7 }, "에이전트 응답 형식이 올바르지 않습니다: summary"); },
    ]);
    expect((await run()).thrown).toBeTruthy();
    const pending = await pendingOf(f);
    expect(pending.raw).toMatchObject({ summary: "Continued the supported scope" });
    expect(pending.raw.resolvedRequestIds).toHaveLength(RESPONSE_RESOLVED_IDS_LIMIT + 1);
    expect(pending).not.toHaveProperty("accumulated");
    respond(f, [() => review({ summary: "Within the limit" }) as unknown as AgentResult]);
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    expect((await run()).thrown).toBeNull();
    expect(f.corrections).toHaveLength(3);
    expect(f.corrections[2].prompt).toContain(`resolvedRequestIds 가 한 번 응답 한도 ${RESPONSE_RESOLVED_IDS_LIMIT}개를 넘습니다`);
  });

  it("R3j F005: 누적 대기본 재개의 계속 진행 응답을 교정하기 전에 예산으로 멈추면, 대기본은 진입 값이 아니라 그 최신 응답·세션이다(BudgetBlocked·예산 AdmissionRefused)", async () => {
    for (const blocked of [() => new BudgetBlocked("account", "budget"), () => new AdmissionRefused("budget", "예산 소진으로 계약 교정 재제출을 열지 않습니다.")]) {
      const f = fixture();
      f.database.updateTopic("t", { state: "CODEX_REVIEW" });
      const { core, run } = reviewTurn(f, failsOnContinued);
      await keepAccumulated(f, core, review({ status: "blocked", findings: [gapFinding()] }));
      respond(f, [
        () => review({ summary: "Continued with a new finding", findings: [{ id: "F-NEW", title: "New defect", severity: "HIGH", disposition: "AGREED_ACTION",
          rationale: "Found while continuing.", evidenceRefs: [], requiresUserDecision: false }] }) as unknown as AgentResult,
        () => { throw blocked(); },
      ]);
      const { thrown } = await run();
      expect(thrown).toBeInstanceOf(blocked().constructor);
      const pending = await pendingOf(f);
      expect(pending).toMatchObject({ sessionId: "review", raw: { summary: "Continued with a new finding" } });
      expect(pending.raw.findings).toEqual(expect.arrayContaining([expect.objectContaining({ id: "F-NEW" })]));
      expect(pending).not.toHaveProperty("accumulated");
    }
  });

  it("R3j 884·882: 교정 병합 뒤 계속 진행 응답이 검사·검증에 실패하면 그 응답을 한 번 응답(누적 표시 없음)·'계속 진행 응답'으로 보존한다", async () => {
    for (const variant of ["check", "unverified"] as const) {
      const f = fixture();
      f.database.updateTopic("t", { state: "CODEX_REVIEW" });
      f.setOriginal(review({ summary: "", status: "blocked", findings: [gapFinding()] }));
      const continued = { summary: "Continued the supported scope" };
      respond(f, [
        () => review({ summary: "Fixed summary", status: "blocked" }) as unknown as AgentResult,
        variant === "check" ? () => review(continued) as unknown as AgentResult
          : () => { throw unverified(review({ ...continued, resolvesRequestedDecision: true, resolvedRequestIds: ids(0, RESPONSE_RESOLVED_IDS_LIMIT + 1) })); },
      ]);
      const { thrown } = await reviewTurn(f, failsOnContinued).run();
      expect(String((thrown as Error | null)?.message)).toMatch(/보존 위치: pending-contract-repair#\d+\(계속 진행 응답, 세션 review\)/);
      const pending = await pendingOf(f);
      expect(pending.raw).toMatchObject(continued);
      expect(pending).not.toHaveProperty("accumulated");
    }
  });

  it("R3j: 새 리뷰 턴의 첫 응답 뒤 계속 진행이 예산으로 멈추면 그 첫 응답을 대기본으로 남기고, 재개는 리뷰를 다시 사지 않는다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    f.setOriginal(review({ status: "blocked", findings: [gapFinding()] }));
    respond(f, [() => { throw new BudgetBlocked("account", "budget"); }]);
    const { run } = reviewTurn(f);
    expect((await run()).thrown).toBeInstanceOf(BudgetBlocked);
    const pending = await pendingOf(f);
    expect(pending).toMatchObject({ sessionId: "review", raw: { summary: "Reviewed", status: "blocked" } });
    expect(pending).not.toHaveProperty("accumulated");
    respond(f, [() => review({ summary: "Continued the supported scope" }) as unknown as AgentResult]);
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    const second = await run();
    expect(second.thrown).toBeNull();
    expect(f.adapter.createSession).toHaveBeenCalledTimes(1);
    expect(second.accepted?.summary).toContain("Continued the supported scope");
  });

  it("R3j: 계속 진행 루프의 2회차 호출이 예산으로 멈추면 1회차 계속 진행 응답을 대기본으로 남긴다", async () => {
    const f = fixture();
    const second = f.database.evidence.register("t", { url: "https://team.atlassian.net/browse/APP-2", label: "Second", mode: "connector", intervalSeconds: 300 });
    const check = f.database.evidence.begin(second.id, true)!;
    f.database.evidence.ingest(second.id, { checkId: check.checkId, revision: "initial", units: [{ id: "issue", kind: "issue", content: "second" }] });
    f.database.evidence.review(f.database.getTopic("t"), f.database.evidence.topic(f.database.getTopic("t")).digest, "Compared with plan", f.database.getTopic("t"));
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    const { core, run } = reviewTurn(f);
    await keepAccumulated(f, core, review({ status: "blocked", findings: [gapFinding()] }));
    respond(f, [
      () => review({ summary: "Continued once", status: "blocked", findings: [gapFinding("APP-2")] }) as unknown as AgentResult,
      () => { throw new BudgetBlocked("account", "budget"); },
    ]);
    expect((await run()).thrown).toBeInstanceOf(BudgetBlocked);
    expect(f.corrections).toHaveLength(2);
    const pending = await pendingOf(f);
    expect(pending).toMatchObject({ sessionId: "review", raw: { summary: "Continued once" } });
    expect(pending).not.toHaveProperty("accumulated");
  });

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

  it("R3j: usage-limit 은 자동 retry 와 같은 판정으로 최신 값을 보존한다 — 분류 없는 전송 실패는 지금처럼 대기본을 쓰지 않는다", async () => {
    const f = fixture();
    f.database.updateTopic("t", { state: "CODEX_REVIEW" });
    const { core, run } = reviewTurn(f, failsOnContinued);
    await keepAccumulated(f, core, review({ status: "blocked", findings: [gapFinding()] }));
    respond(f, [
      () => review({ summary: "Continued the supported scope" }) as unknown as AgentResult,
      () => { throw new Error("Claude 실행 실패(1): You've hit your session limit · resets 8:50am (Asia/Seoul) (429)"); },
    ]);
    expect(String(((await run()).thrown as Error).message)).toContain("session limit");
    const pending = await pendingOf(f);
    expect(pending).toMatchObject({ sessionId: "review", raw: { summary: "Continued the supported scope" } });
    expect(pending).not.toHaveProperty("accumulated");
    // 대조: 분류 없는 일반 Error(전송 실패)는 위반도 아니고 대기본도 남기지 않는다(R3h F004 대조와 같은 계약).
    const transport = fixture();
    transport.database.updateTopic("t", { state: "CODEX_REVIEW" });
    transport.setOriginal(review({ summary: "" }));
    respond(transport, [() => { throw new Error("socket hang up"); }]);
    expect(String(((await reviewTurn(transport).run()).thrown as Error).message)).toBe("socket hang up");
    expect(await pendingOf(transport)).toBeNull();
  });
});
