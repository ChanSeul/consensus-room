// 인도 대기의 전달 잠금 — 공개 API 에서 시작해 실제 git·DB·산출물로 본다(통제 가능한 가짜 어댑터, 봉투 턴).
// 고정하는 것: 커밋이 진행 중인 동안 들어온 사용자 결정은 거부하고 기록하지 않으며, 커밋이 실패하면 잠금을 풀어 다시 커밋할 수 있다.
// 옛 중재자 진단 실행 흐름(수락 가드·OVERRULE 지시어·답변 확인·최종 리뷰·저장 리뷰 재사용)의 검사는 그 흐름과 함께 지웠다(CR 흐름 단순화 ⑥).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/server/app";
import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import { REQUIRED_PLAN_HEADINGS } from "../src/shared/contracts";
import type { TurnEnvelope } from "../src/shared/turnContract";
import { hashPlan } from "../src/shared/workflow";

const temporaryDirectories: string[] = [];
const openApps: Awaited<ReturnType<typeof buildApp>>[] = [];
afterEach(async () => {
  for (const app of openApps.splice(0)) await app.close();
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const TOKEN = "launch-token-for-diagnosis-test";
const TOLERANCE_BLOCK = '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';
const plan = () => REQUIRED_PLAN_HEADINGS.map((heading) => `## ${heading}\n\n검증할 내용${heading === "허용 오차" ? TOLERANCE_BLOCK : ""}`).join("\n\n");
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// 구현자: 차례대로 정해진 동작을 하고 완료 봉투를 낸다. 리뷰어: 승인 봉투를 낸다.
type Step = () => TurnEnvelope;
class ScriptedClaude implements AgentAdapter {
  readonly role = "claude" as const;
  constructor(private readonly steps: Step[]) {}
  async validateExistingSession() { return true; }
  async createSession(): Promise<never> { throw new Error("봉투 턴만 부릅니다."); }
  async resumeTurn(): Promise<never> { throw new Error("봉투 턴만 부릅니다."); }
  async createEnvelopeSession(_turn: Omit<SessionTurn, "sessionId">) { return { sessionId: "impl-session", envelope: this.next() }; }
  async resumeEnvelopeTurn(_turn: SessionTurn) { return this.next(); }
  private next(): TurnEnvelope {
    const step = this.steps.shift();
    if (!step) throw new Error("예상하지 않은 Claude 턴입니다.");
    return step();
  }
}
class ApprovingCodex implements AgentAdapter {
  readonly role = "codex" as const;
  async validateExistingSession() { return true; }
  async createSession(): Promise<never> { throw new Error("봉투 턴만 부릅니다."); }
  async resumeTurn(): Promise<never> { throw new Error("봉투 턴만 부릅니다."); }
  async createEnvelopeSession(_turn: Omit<SessionTurn, "sessionId">) { return { sessionId: "codex-review", envelope: { message: "확인했습니다.", outcome: "approve" } satisfies TurnEnvelope }; }
  async resumeEnvelopeTurn(_turn: SessionTurn): Promise<TurnEnvelope> { return { message: "확인했습니다.", outcome: "approve" }; }
}

async function waitFor(predicate: () => boolean, label: string, timeout = 15_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`시간 초과: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function room(label: string) {
  const steps: Step[] = [];
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
  await new GitService(runner).createDetachedWorktree(repository, worktree, "develop");
  const database = new ConsensusDatabase(join(data, "room.sqlite"));
  const artifacts = new ArtifactStore(join(data, "topics"), database);
  const markdown = plan();
  const planSHA256 = hashPlan(markdown);
  const topicId = "11111111-2222-4333-8444-777777777777";
  const timestamp = "2026-09-14T00:00:00.000Z";
  database.createTopic({
    workflowMode: "planned",
    id: topicId, slug: "diagnosis", title: "중재자 진단", repositoryPath: repository, baseRef: "develop", worktreePath: worktree,
    branchName: null, state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 2, planSHA256, approvedPlanSHA256: planSHA256,
    createdAt: timestamp, updatedAt: timestamp, lastError: null,
  });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant(topicId, { role, sessionId: `${role}-plan-session`, mode: "attached", acknowledgedPlanSHA256: planSHA256 });
  }
  await artifacts.write(topicId, "plan", 2, `${markdown.trim()}\n`);
  const app = await buildApp({
    config: {
      host: "127.0.0.1" as const, port: 0, launchToken: TOKEN, dataDirectory: data, topicsDirectory: join(data, "topics"),
      worktreesDirectory: join(root, "worktrees"), databasePath: join(data, "room.sqlite"), webDirectory: join(root, "missing-web"),
      repositoryPath: repository, memoryDirectory: join(root, "memory"), claudeSkillDirectories: [], codexSkillDirectories: [],
      defaultAgentSettings: { claude: { model: "opus", effort: "xhigh" as const }, codex: { model: "gpt-6", effort: "xhigh" as const } },
      figmaMcpUrl: null, codexConcurrency: 2, enforceBudgets: false,
    },
    database, runner, claude: new ScriptedClaude(steps), codex: new ApprovingCodex(),
  });
  let keys = 0;
  openApps.push(app);
  const call = async (method: "GET" | "POST", url: string, body?: unknown) => {
    const response = await app.inject({
      method, url,
      headers: { "x-consensus-token": TOKEN, ...(method === "POST" ? { "idempotency-key": `key-${label}-${++keys}`, "content-type": "application/json" } : {}) },
      ...(body === undefined ? (method === "POST" ? { payload: "{}" } : {}) : { payload: JSON.stringify(body) }),
    });
    return { status: response.statusCode, body: response.json() as Record<string, unknown> };
  };
  const idle = (state: string) => waitFor(() => database.getTopic(topicId).state === state && database.runningAction(topicId) === null, `${label} → ${state}`);
  return { app, database, topicId, worktree, steps, call, idle };
}

describe("R1/R2 delivery admission", () => {
  it("R1 commit 대기 중 결정은 거부하고 실패 후 잠금을 해제한다", async () => {
    const r = await room("r1-delivery-race");
    r.steps.push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현\n"); return { message: "완료", outcome: "done" }; });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    const original = GitService.prototype.snapshot;
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    vi.spyOn(GitService.prototype, "snapshot").mockImplementation(async function (this: GitService, ...args) {
      if (first && args[0] === r.worktree) { first = false; entered(); await held; throw new Error("snapshot failure"); }
      return original.apply(this, args);
    });
    const commit = r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "race", paths: ["feature.txt"] });
    await started;
    try {
      expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "전달 중 취소" })).status).not.toBe(200);
      expect(r.database.getTimeline(r.topicId).some(event => event.body === "전달 중 취소")).toBe(false);
    } finally { release(); }
    expect((await commit).status).not.toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "retry", paths: ["feature.txt"] })).status).toBe(200);
    await r.app.close();
  });
});
