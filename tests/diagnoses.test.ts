// 중재자 진단(2026-09-14 진단 계획) — 공개 API 에서 시작해 실제 러너 요청과 최종 상태까지 본다(실제 git·DB·산출물, 통제 가능한 가짜 어댑터).
// 고정하는 것: 진단 등록만으로 재개·완료되지 않음 · 수정이 필요한데 확인 턴만 실행하지 않음 · 다른 질문이 사라지지 않음 · 낡은 진단은 보존하고 재확인 요구 ·
// 인도 대기의 미해결 진단은 커밋·푸시·종료를 막음 · 인도 대기 반환은 완료 판정을 취소하고 새 최종 리뷰를 거침.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/server/app";
import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import { REQUIRED_PLAN_HEADINGS, type AgentResult, type Finding } from "../src/shared/contracts";
import { hashPlan } from "../src/shared/workflow";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const TOKEN = "launch-token-for-diagnosis-test";
const TOLERANCE_BLOCK = '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';
const plan = () => REQUIRED_PLAN_HEADINGS.map((heading) => `## ${heading}\n\n검증할 내용${heading === "허용 오차" ? TOLERANCE_BLOCK : ""}`).join("\n\n");
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const result = (kind: AgentResult["kind"], summary: string, extra: Partial<AgentResult> = {}): AgentResult =>
  ({ kind, summary, findings: [], evidenceRefs: ["검증"], ...extra });
const requestIdsIn = (text: string) => [...new Set([...text.matchAll(/\[(Q-[0-9a-f]{8})\]/g)].map((match) => match[1]))];

interface ClaudeTurn { mode: "create" | "resume"; prompt: string; protocolOnly: boolean; readablePaths: readonly string[] }
type Step = (turn: ClaudeTurn) => AgentResult;

// 프로세스를 띄운 것처럼 onProcessSpawn 을 부른다 — 전달 기록(spawn 시점)을 실제 경로로 지나게 한다.
const spawned = (turn: SessionTurn) => turn.onProcessSpawn?.({ pid: 4242, pgid: 4242, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });

class ScriptedClaude implements AgentAdapter {
  readonly role = "claude" as const;
  readonly turns: ClaudeTurn[] = [];
  constructor(private readonly steps: Step[]) {}
  async validateExistingSession() { return true; }
  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    turn.onSessionCreated?.("impl-session");
    return { sessionId: "impl-session", result: this.next("create", turn as SessionTurn) };
  }
  async resumeTurn(turn: SessionTurn) { return this.next("resume", turn); }
  private next(mode: ClaudeTurn["mode"], turn: SessionTurn): AgentResult {
    spawned(turn);
    const recorded = { mode, prompt: turn.prompt, protocolOnly: Boolean(turn.protocolOnly), readablePaths: turn.readablePaths ?? [] };
    this.turns.push(recorded);
    const step = this.steps.shift();
    if (!step) throw new Error(`예상하지 않은 Claude 턴 #${this.turns.length}: ${turn.prompt.slice(0, 160)}`);
    return step(recorded);
  }
}

// 구현 보고의 쟁점을 빠짐없이 되돌려 담는 리뷰어. 최종 리뷰는 반영 주장(RESOLVED_BY_FIX)을 확인 처분으로 되돌려 준다.
class EchoCodex implements AgentAdapter {
  readonly role = "codex" as const;
  readonly prompts: string[] = [];
  async validateExistingSession() { return true; }
  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    return { sessionId: "codex-review", result: await this.resumeTurn({ ...turn, sessionId: "codex-review" } as SessionTurn) };
  }
  async resumeTurn(turn: SessionTurn) {
    spawned(turn);
    this.prompts.push(turn.prompt);
    const final = turn.prompt.includes("반환 kind는 FINAL_REVIEW");
    const marker = "Claude 구현 보고:\n";
    const start = turn.prompt.indexOf(marker) + marker.length;
    const report = JSON.parse(turn.prompt.slice(start, turn.prompt.indexOf("\n\n", start))) as AgentResult;
    const findings: Finding[] = report.findings.map((finding) => ({
      ...finding, rationale: "수정과 검증 근거를 확인했습니다.",
      disposition: final && finding.disposition === "RESOLVED_BY_FIX" ? "RESOLVED_BY_FIX" : "AGREED_NO_ACTION",
    }));
    return result(final ? "FINAL_REVIEW" : "REVIEW", "확인했습니다.", { findings });
  }
}

async function waitFor(predicate: () => boolean, label: string, timeout = 15_000, describe: () => string = () => ""): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`시간 초과: ${label}${describe() ? `\n${describe()}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function room(label: string, steps: Step[], options: { autonomy?: "on" | "off" } = {}) {
  const root = mkdtempSync(join(tmpdir(), `consensus-room-diagnosis-${label}-`));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const worktree = join(root, "worktrees", "topic");
  const data = join(root, "data");
  git(root, ["init", "--initial-branch=develop", repository]);
  git(repository, ["config", "user.name", "Consensus Room Test"]);
  git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
  writeFileSync(join(repository, "feature.txt"), "기준\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "baseline"]);
  const runner = new SpawnCommandRunner();
  const gitService = new GitService(runner);
  await gitService.createDetachedWorktree(repository, worktree, "develop");
  const database = new ConsensusDatabase(join(data, "room.sqlite"));
  const artifacts = new ArtifactStore(join(data, "topics"), database);
  const markdown = plan();
  const planSHA256 = hashPlan(markdown);
  const topicId = "11111111-2222-4333-8444-777777777777";
  const timestamp = "2026-09-14T00:00:00.000Z";
  database.createTopic({
    id: topicId, slug: "diagnosis", title: "중재자 진단", repositoryPath: repository, baseRef: "develop", worktreePath: worktree,
    branchName: null, state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 2, planSHA256, approvedPlanSHA256: planSHA256,
    createdAt: timestamp, updatedAt: timestamp, lastError: null,
  });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant(topicId, { role, sessionId: `${role}-plan-session`, mode: "attached", acknowledgedPlanSHA256: planSHA256 });
  }
  await artifacts.write(topicId, "plan", 2, `${markdown.trim()}\n`);
  writeFileSync(join(data, "mediation-autonomy.json"), JSON.stringify({ autonomy: options.autonomy ?? "on", set_at: "2026-09-14T00:00:00Z" }));
  const claude = new ScriptedClaude(steps);
  const codex = new EchoCodex();
  const app = await buildApp({
    config: {
      host: "127.0.0.1" as const, port: 0, launchToken: TOKEN, dataDirectory: data, topicsDirectory: join(data, "topics"),
      worktreesDirectory: join(root, "worktrees"), databasePath: join(data, "room.sqlite"), webDirectory: join(root, "missing-web"),
      repositoryPath: repository, memoryDirectory: join(root, "memory"), claudeSkillDirectories: [], codexSkillDirectories: [],
      defaultAgentSettings: { claude: { model: "opus", effort: "xhigh" as const }, codex: { model: "gpt-6", effort: "xhigh" as const } },
      figmaMcpUrl: null, codexConcurrency: 2, enforceBudgets: false,
    },
    database, runner, claude, codex,
  });
  let keys = 0;
  const call = async (method: "GET" | "POST", url: string, body?: unknown, extra: { key?: string; mediator?: boolean } = {}) => {
    const response = await app.inject({
      method, url,
      headers: {
        "x-consensus-token": TOKEN,
        ...(method === "POST" ? { "idempotency-key": extra.key ?? `key-${label}-${++keys}`, "content-type": "application/json" } : {}),
        ...(extra.mediator ? { "x-consensus-actor": "mediator" } : {}),
      },
      ...(body === undefined ? (method === "POST" ? { payload: "{}" } : {}) : { payload: JSON.stringify(body) }),
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  // 시간 초과면 어디서 멈췄는지(상태·오류·러너 턴·타임라인 끝)를 함께 보인다.
  const where = () => {
    const topic = database.getTopic(topicId);
    const tail = database.getTimeline(topicId).slice(-8).map((event) => `  #${event.sequence} ${event.actor}/${event.kind} ${event.body.replace(/\n/g, " ").slice(0, 200)}`);
    return [`state=${topic.state} resume=${database.getFlags(topicId).resumeState ?? "-"} running=${Boolean(database.runningAction(topicId))} claudeTurns=${claude.turns.length}`,
      `lastError=${(topic.lastError ?? "-").replace(/\n/g, " ").slice(0, 300)}`, ...tail].join("\n");
  };
  const idle = (state: string) => waitFor(() => database.getTopic(topicId).state === state && database.runningAction(topicId) === null, `${label} → ${state}`, 15_000, where);
  const diagnoses = async () => (await call("GET", `/api/topics/${topicId}/diagnoses`)).body.diagnoses as Array<{ id: string; status: string; history: Array<{ status: string }>; binding: Record<string, unknown> }>;
  return { app, database, artifacts, topicId, worktree, claude, codex, call, idle, diagnoses };
}

function fixDiagnosis(extra: Record<string, unknown> = {}) {
  return {
    kind: "fix", title: "클러스터 전략 witness 의 격리", observedFailure: "게이트 2 F1 에서 SIGTRAP(백그라운드 큐가 MainActor witness 를 부름).",
    evidenceRefs: ["evidence/gate2-F1-a2-crash-1.ips"], cause: "D1 기본 격리로 추론된 @objc witness 의 실행자 검사.", uncertainty: "다른 전략 witness 도 같은지 미확인.",
    instructions: "mergeTag 를 nonisolated 로 바꾸고 같은 부류를 감사하세요.", verificationCriteria: ["게이트 2 F1 재실행 green", "커버 A post 경고 0"],
    planChange: { required: false, reason: "승인 범위·접근·검증 기준 안의 수정입니다." }, ...extra,
  };
}

// 첫 구현 턴: 파일을 바꾸고 결정 하나를 물으며 멈춘다(열린 요청 1개).
function askingTurn(worktree: string, question = "배포 채널을 A 로 할까요?"): Step {
  return () => {
    writeFileSync(join(worktree, "feature.txt"), "구현 1\n");
    return result("IMPLEMENTATION", "구현했고 결정 하나가 필요합니다.", { status: "completed", requestedUserDecision: question });
  };
}

const resolved = (id: string, extra: Partial<Finding> = {}): Finding => ({
  id, title: "진단 반영", severity: "HIGH", disposition: "RESOLVED_BY_FIX", rationale: `${id} 반영`,
  evidenceRefs: [`${id} → 원인 → feature.txt:1 → 게이트 재실행 green → 미확인 없음`], requiresUserDecision: false, ...extra,
});

describe("중재자 진단 — 저장·조회·동일 계획 재개(1단계)", () => {
  it("등록은 멱등이고 조회되며, 등록만으로는 재개·완료되지 않는다(적용 전 retry 거부)", { timeout: 30_000 }, async () => {
    const r = await room("register", []);
    r.claude["steps"].push(askingTurn(r.worktree));
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    const openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect(openId).toBeTruthy();

    const body = fixDiagnosis({ relatedRequestIds: [openId] });
    const first = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { key: "dg-1", mediator: true });
    expect(first.status).toBe(201);
    expect(first.body.id).toBe("DG-1");
    const replay = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { key: "dg-1", mediator: true });
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe("DG-1");
    const reused = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, { ...body, title: "다른 본문" }, { key: "dg-1", mediator: true });
    expect(reused.status).toBe(409);
    const unknownRequest = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ relatedRequestIds: ["Q-deadbeef"] }), { mediator: true });
    expect(unknownRequest.status).toBe(409);

    const listed = await r.diagnoses();
    expect(listed.map((item) => [item.id, item.status])).toEqual([["DG-1", "registered"]]);
    const binding = listed[0].binding as { planSHA256: string; worktree: { head: string; diffSHA256: string }; failure: { actionId: string }; openRequestIds: string[] };
    expect(binding.planSHA256).toBe(r.database.getTopic(r.topicId).planSHA256);
    expect(binding.worktree.head).toMatch(/^[0-9a-f]{40}$/);
    expect(binding.failure.actionId).toBeTruthy();
    expect(binding.openRequestIds).toContain(openId);

    // 등록만으로는 재개되지 않는다 — retry 는 거부되고 러너는 불리지 않는다.
    const retry = await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(retry.status).toBe(409);
    expect(String(retry.body.error)).toContain("DG-1");
    expect(r.claude.turns).toHaveLength(1);
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    r.database.close();
  });

  it("적용하면 결정이 올라와 있어도 확인 턴이 아니라 실제 수정 턴으로 반환되고, 열린 요청은 러너가 id 로 해소해야만 닫힌다", { timeout: 30_000 }, async () => {
    let openId = "";
    const r = await room("apply", []);
    r.claude["steps"].push(
      askingTurn(r.worktree),
      // 적용 뒤 첫 턴: 쓰기 턴(확인 턴이 아님) — 진단을 반영하지만 열린 요청은 해소하지 않는다.
      (turn) => {
        expect(turn.protocolOnly).toBe(false);
        expect(turn.prompt).toContain("[DG-1]");
        expect(turn.prompt).toContain("검증 기준: 1) 게이트 2 F1 재실행 green");
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        // 원문 경로(sha 검증 blob)가 프롬프트에 실리고 이 턴의 읽기 허용에 들어 있다.
        const original = /원문: `([^`]+)`/.exec(turn.prompt)?.[1];
        expect(original).toBeTruthy();
        expect(turn.readablePaths).toContain(original);
        writeFileSync(join(r.worktree, "feature.txt"), "진단 반영\n");
        return result("IMPLEMENTATION", "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
      // 요청이 여전히 열려 있고 그 뒤 결정이 있다 → 읽기 전용 확인 턴에서 러너가 id 로 해소한다.
      (turn) => {
        expect(turn.protocolOnly).toBe(true);
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        return result("IMPLEMENTATION", "요청을 해소했습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    // 일반 결정이 먼저 올라와 있다 — 진단이 없으면 재개는 읽기 전용 확인 턴으로 갔을 상황이다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ relatedRequestIds: [openId] }), { mediator: true })).status).toBe(201);
    expect((await r.diagnoses())[0].status).toBe("registered");

    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(applied.status).toBe(200);
    await r.idle("READY_TO_DELIVER");

    expect(r.claude.turns.map((turn) => turn.protocolOnly)).toEqual([false, false, true]);
    const [dg] = await r.diagnoses();
    expect(dg.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    const timeline = r.database.getTimeline(r.topicId);
    expect(timeline.some((event) => event.payload?.resolvedRequest === openId)).toBe(true);
    // 리뷰어는 구현 보고의 진단 쟁점을 판정했다.
    expect(r.codex.prompts[0]).toContain('"id": "DG-1"');
    r.database.close();
  });

  it("등록 뒤 코드가 바뀐 진단은 적용하지 않고 기록을 보존한 채 재확인을 요구한다 — 정정 진단으로만 넘어간다", { timeout: 30_000 }, async () => {
    let openId = "";
    const r = await room("stale", []);
    r.claude["steps"].push(askingTurn(r.worktree), (turn) => {
      expect(turn.prompt).toContain("[DG-2]");
      expect(turn.prompt).not.toContain("[DG-1]");
      writeFileSync(join(r.worktree, "feature.txt"), "정정 진단 반영\n");
      return result("IMPLEMENTATION", "정정 진단을 반영했습니다.", {
        status: "completed", findings: [resolved("DG-2")], resolvesRequestedDecision: true, resolvedRequestId: openId,
      });
    });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    writeFileSync(join(r.worktree, "feature.txt"), "중재자가 등록 뒤 바꾼 코드\n");

    const stale = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(stale.status).toBe(409);
    expect(String(stale.body.error)).toContain("코드(작업 트리)");
    expect((await r.diagnoses())[0].status).toBe("stale");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    expect(r.claude.turns).toHaveLength(1);

    const corrected = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ supersedes: "DG-1", title: "정정: 지금 코드 기준" }), { mediator: true });
    expect(corrected.status).toBe(201);
    expect((await r.diagnoses()).map((item) => [item.id, item.status])).toEqual([["DG-1", "superseded"], ["DG-2", "registered"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(409);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((item) => item.status)).toEqual(["superseded", "resolved"]);
    r.database.close();
  });

  it("인도 대기 중 등록된 실패는 커밋·푸시·종료를 막고, 적용하면 완료 판정을 취소한 뒤 진단 수정 → 최종 리뷰를 거쳐야 커밋된다", { timeout: 30_000 }, async () => {
    const r = await room("ready", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        expect(turn.protocolOnly).toBe(false);
        expect(turn.prompt).toContain("중재자 진단(수정 지시)을 반영하세요");
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "외부 검증 실패 수정\n");
        return result("FIX", "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId).reviewedHead).toBeTruthy();

    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    for (const action of ["commit", "push", "close"] as const) {
      const response = await r.call("POST", `/api/topics/${r.topicId}/actions/${action}`, action === "commit" ? { message: "진단 전 커밋", paths: ["feature.txt"] } : undefined);
      expect(response.status, action).toBe(409);
      expect(String(response.body.error), action).toContain("DG-1");
    }
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");

    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.prompts[1]).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.codex.prompts[1]).toContain('"id": "DG-1"');
    expect((await r.diagnoses())[0].status).toBe("resolved");
    // 진단 수정은 자동 수정 회차를 소비하지도 초기화하지도 않는다.
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    const committed = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 수정 포함", paths: ["feature.txt"] });
    expect(committed.status).toBe(200);
    r.database.close();
  });

  it("원인 미확정의 조사 기록은 적용할 수 없고 재개를 막는다 — 수정 불필요 결론(정정)이 닫는다", { timeout: 30_000 }, async () => {
    const r = await room("investigation", []);
    r.claude["steps"].push(askingTurn(r.worktree), () => result("IMPLEMENTATION", "이어서 끝냈습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: "Q-00000000" }));
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    const investigation = { kind: "investigation", title: "원인 조사 중", observedFailure: "간헐 실패", cause: "가설: 시뮬레이터 열화", uncertainty: "재현 안 됨" };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, investigation, { mediator: true })).status).toBe(201);
    const apply = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(apply.status).toBe(409);
    expect(String(apply.body.error)).toContain("조사");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);

    const noEvidence = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, { kind: "no_action", title: "수정 불필요", observedFailure: "간헐 실패", cause: "환경", supersedes: "DG-1" }, { mediator: true });
    expect(noEvidence.status).toBe(400);
    const closing = { kind: "no_action", title: "수정 불필요", observedFailure: "간헐 실패", cause: "시뮬레이터 열화 — 새 기기에서 3회 green", evidenceRefs: ["gate2-rerun.log"], supersedes: "DG-1" };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, closing, { mediator: true })).status).toBe(201);
    expect((await r.diagnoses()).map((item) => [item.id, item.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.claude.turns.length === 2, "재개 턴");
    // 실행이 끝난 뒤에 DB 를 닫는다 — 실행 중에 닫으면 엔진의 뒤이은 기록이 닫힌 DB 에 부딪힌다(ERR_INVALID_STATE).
    await waitFor(() => r.database.runningAction(r.topicId) === null, "재개 실행 종료");
    r.database.close();
  });

  it("위임이 꺼져 있으면 중재자 호출의 등록·적용은 403 이고 조회는 된다. 등록 가능한 상태가 아니면 거부한다", { timeout: 30_000 }, async () => {
    const r = await room("delegation", [], { autonomy: "off" });
    const draftRegister = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis());
    expect(draftRegister.status).toBe(409);
    expect(String(draftRegister.body.error)).toContain("멈춘 상태");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(403);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(403);
    expect((await r.call("GET", `/api/topics/${r.topicId}/diagnoses`)).status).toBe(200);
    r.database.close();
  });
});
