import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ArtifactStore } from "../src/server/artifacts";
import { ConsensusDatabase } from "../src/server/database";
import { GitService } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { AgentAdapter, SessionTurn } from "../src/server/types";
import { WorkflowEngine } from "../src/server/workflow";
import { REQUIRED_PLAN_HEADINGS, type AgentResult } from "../src/shared/contracts";
import { hashPlan } from "../src/shared/workflow";

const temporaryDirectories: string[] = [];
afterEach(() => { for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

const TOLERANCE_PLAN_TAIL = `

\`\`\`tolerance
{"scopePaths":["feature.txt"],
 "rules":[{"id":"T-1","title":"소유 밖 파일의 nonisolated 표기","paths":["service/**"],"hunk":"insert-token","tokens":["nonisolated"],"maxFiles":1,"maxHunks":2,"invariants":["소유 폴더 진단 0 유지"]}]}
\`\`\`
`;

// 서버가 프롬프트에 적어 준 열린 요청 id(`[Q-xxxxxxxx]`) — 러너는 이 id 로만 요청을 해소한다(PLAN §2 요청별 보존).
function requestIdsIn(prompt: string): string[] {
  return [...new Set([...prompt.matchAll(/\[(Q-[0-9a-f]{8})\]/g)].map((match) => match[1]))];
}

function planWithTolerance(): string {
  return REQUIRED_PLAN_HEADINGS
    .map((heading) => heading === "허용 오차" ? `## ${heading}\n\n규칙은 아래 블록${TOLERANCE_PLAN_TAIL}` : `## ${heading}\n\n검증할 내용`)
    .join("\n\n");
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function result(kind: AgentResult["kind"], summary: string, extra: Partial<AgentResult> = {}): AgentResult {
  return { kind, summary, findings: [], evidenceRefs: ["검증"], ...extra };
}

// 리뷰 답변 확인 프롬프트(REVIEW_ANSWER_INPUT)에 대한 정상 fixture 응답 — 인도 대기·재개의 모든 새 결정은 확인자의 결정별 판정을 거친다(host-review 2026-09-21 R1·R7):
// 열린 질문은 마지막 결정으로 답하고 결정 전부를 "구현 변경 요구 아님(false)" 으로 판정한다. 확인 프롬프트가 아니면 null.
function confirmAnswers(prompt: string): AgentResult | null {
  if (!prompt.includes("REVIEW_ANSWER_INPUT\n")) return null;
  const input = JSON.parse(prompt.split("REVIEW_ANSWER_INPUT\n")[1].split("\nEND_REVIEW_ANSWER_INPUT")[0]) as { requests: Array<{ id: string }>; decisions: Array<{ sequence: number }>; answerEvidence?: Array<{ sequence: number }> };
  const last = [...(input.answerEvidence ?? []), ...input.decisions].sort((a, b) => a.sequence - b.sequence).at(-1);
  return result("REVIEW", "질문 답변 확인", {
    status: "completed", findings: [], evidenceRefs: [],
    reviewDecisionAnswers: last ? input.requests.map((request) => ({ requestId: request.id, decisionSequence: last.sequence })) : [],
    decisionAssessments: input.decisions.map((decision) => ({ decisionSequence: decision.sequence, changesImplementation: false })),
  });
}

async function setup(label: string) {
  const root = mkdtempSync(join(tmpdir(), `consensus-room-tolerance-${label}-`));
  temporaryDirectories.push(root);
  const repository = join(root, "repository");
  const worktree = join(root, "worktrees", "topic");
  git(root, ["init", "--initial-branch=develop", repository]);
  git(repository, ["config", "user.name", "Consensus Room Test"]);
  git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
  writeFileSync(join(repository, "feature.txt"), "기준\n");
  mkdirSync(join(repository, "service"));
  writeFileSync(join(repository, "service", "S.swift"), "func a() {}\nfunc b() {}\n");
  git(repository, ["add", "."]);
  git(repository, ["commit", "-m", "baseline"]);
  const gitService = new GitService(new SpawnCommandRunner());
  await gitService.createDetachedWorktree(repository, worktree, "develop");
  const database = new ConsensusDatabase(join(root, "data", "room.sqlite"));
  const artifacts = new ArtifactStore(join(root, "data", "topics"), database);
  const plan = planWithTolerance();
  const planSHA256 = hashPlan(plan);
  const topicId = "11111111-2222-4333-8444-666666666666";
  const timestamp = "2026-09-08T00:00:00.000Z";
  database.createTopic({
    id: topicId, slug: "tolerance", title: "허용 오차", repositoryPath: repository, baseRef: "develop", worktreePath: worktree,
    branchName: null, state: "AWAITING_USER_APPROVAL", scopeGeneration: 1, planRevision: 2, planSHA256, approvedPlanSHA256: planSHA256,
    createdAt: timestamp, updatedAt: timestamp, lastError: null,
  });
  for (const role of ["claude", "codex"] as const) {
    database.upsertParticipant(topicId, { role, sessionId: `${role}-plan-session`, mode: "attached", acknowledgedPlanSHA256: planSHA256 });
  }
  await artifacts.write(topicId, "plan", 2, `${plan.trim()}\n`);
  return { root, worktree, gitService, database, artifacts, topicId };
}

// 실제 Codex 처럼 구현 보고의 쟁점 id 를 빠짐없이 다시 담는다(서버가 누락을 거부한다) — 여기서는 to-do 를 그대로 이연 처분한다.
class PassingCodex implements AgentAdapter {
  readonly role = "codex" as const;
  readonly prompts: string[] = [];
  constructor(private readonly echo: AgentResult["findings"] = []) {}
  async createSession(turn: Parameters<AgentAdapter["createSession"]>[0]) {
    return { sessionId: "codex-code-review", result: await this.resumeTurn({ ...turn, sessionId: "codex-code-review" }) };
  }
  async resumeTurn(turn: SessionTurn) {
    this.prompts.push(turn.prompt);
    return result("REVIEW", "수정할 것이 없습니다.", { findings: this.echo });
  }
  async validateExistingSession() { return true; }
}

function claudeAdapter(worktree: string, script: { implement: () => AgentResult; correct?: () => AgentResult }) {
  const prompts: string[] = [];
  const adapter: AgentAdapter = {
    role: "claude",
    async createSession(turn) { prompts.push(turn.prompt); return { sessionId: "claude-implementation-session", result: script.implement() }; },
    async resumeTurn(turn) {
      prompts.push(turn.prompt);
      if (!script.correct) throw new Error("교정 호출을 기대하지 않았습니다.");
      return script.correct();
    },
    async validateExistingSession() { return true; },
  };
  return { adapter, prompts, worktree };
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("조건을 기다리는 동안 제한 시간을 넘었습니다.");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

describe("허용 오차 — 엔진이 리뷰 전에 git diff 로 대조한다", { timeout: 30_000 }, () => {
  it("규칙 술어를 만족하는 범위 밖 표기 변경은 원장과 함께 통과하고 Codex 프롬프트에 대조 결과가 실린다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("pass");
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "nonisolated func a() {}\nfunc b() {}\n");
        return result("IMPLEMENTATION", "구현", { status: "completed", toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "S9 소유 파일 표기 1줄" }],
          findings: [{
            id: "TODO-1", title: "FilterCategory 프로토콜 격리 재설계(소유 밖)", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE",
            rationale: "진단 x:1 · 원인 선언 service/F.swift:527 · 필요한 변경 nonisolated protocol · 권장 형태 후속 토픽",
            evidenceRefs: [], requiresUserDecision: false,
          }], });
      },
    });
    const codex = new PassingCodex([{
      id: "TODO-1", title: "FilterCategory 프로토콜 격리 재설계(소유 밖)", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE",
      rationale: "구현 보고의 to-do 를 이연으로 확인", evidenceRefs: [], requiresUserDecision: false,
    }]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));

    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    await waitUntil(() => database.getTimeline(topicId).some((event) => Array.isArray(event.payload.deferredForDelivery)));
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.some((body) => body.startsWith("허용 오차 대조 통과 — 범위 밖 파일 1개 (T-1: 파일 1·hunk 1)"))).toBe(true);
    // 러너 to-do 는 후속 목록에 출처 implementation 으로 오르고, 인도를 막지 않는 후속 목록 안내가 뜬다.
    expect(bodies.some((body) => body.startsWith("후속 목록에 기록(이번 범위 밖, 구현 to-do): TODO-1"))).toBe(true);
    const deferred = JSON.parse((await artifacts.readLatest(topicId, "deferred-findings"))!);
    expect(deferred.findings).toMatchObject([{ id: "TODO-1", source: "implementation" }]);
    expect(bodies.some((body) => body.includes("현재 완료 조건과 별개로 보존한 후속 목록 1건") && body.includes("TODO-1"))).toBe(true);
    expect(codex.prompts[0]).toContain("허용 오차 대조(서버가 git diff 로 판정한 결과");
    expect(codex.prompts[0]).toContain("T-1");
    expect(claude.prompts).toHaveLength(1);
    database.close();
  });

  it("술어 밖 변경(원장 없음)은 같은 세션에 한 번 돌려보내고, 되돌리면 통과한다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("correct");
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "func aa() {}\nfunc b() {}\n"); // 이름 변경 — 표기가 아니다
        return result("IMPLEMENTATION", "구현(범위 밖 변경 포함)", { status: "completed" });
      },
      correct: () => {
        writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n"); // 되돌림
        return result("IMPLEMENTATION", "범위 밖 변경을 되돌리고 to-do 로 옮겼습니다.", { status: "completed" });
      },
    });
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));

    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.prompts).toHaveLength(2);
    expect(claude.prompts[1]).toContain("허용 오차 규칙과 git diff 로 대조했더니");
    expect(claude.prompts[1]).toContain("service/S.swift: 승인 범위 밖 변경인데 toleranceLedger 에 없습니다");
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.some((body) => body.includes("허용 오차 위반 1건"))).toBe(true);
    expect(bodies.some((body) => body.startsWith("허용 오차 대조 통과 — 범위 밖 파일 0개"))).toBe(true);
    expect(readFileSync(join(worktree, "service", "S.swift"), "utf8")).toBe("func a() {}\nfunc b() {}\n");
    database.close();
  });

  it("교정 턴이 범위 밖 변경을 커밋으로 숨기면 HEAD 재확인에 걸려 실패한다(Codex 지적 2)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("commit");
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "func aa() {}\nfunc b() {}\n");
        return result("IMPLEMENTATION", "구현(범위 밖 변경 포함)", { status: "completed" });
      },
      correct: () => {
        git(worktree, ["config", "user.name", "t"]); git(worktree, ["config", "user.email", "t@example.invalid"]);
        git(worktree, ["add", "service/S.swift"]); git(worktree, ["commit", "-m", "몰래 커밋"]);
        return result("IMPLEMENTATION", "커밋으로 숨김", { status: "completed" });
      },
    });
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));

    const topic = database.getTopic(topicId);
    expect(topic.state).toBe("FAILED");
    expect(topic.lastError).toContain("승인되지 않은 git commit");
    expect(codex.prompts).toHaveLength(0);
    database.close();
  });

  it("리뷰가 to-do 를 다른 처분으로 닫으면 후속 목록에서 빠지고 인도 전 안내도 뜨지 않는다(Codex 지적 9)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("prune");
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        return result("IMPLEMENTATION", "구현", { status: "completed", findings: [{
            id: "TODO-1", title: "범위 밖 표기", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE",
            rationale: "to-do", evidenceRefs: [], requiresUserDecision: false,
          }], });
      },
    });
    const codex = new PassingCodex([{
      id: "TODO-1", title: "범위 밖 표기", severity: "LOW", disposition: "AGREED_NO_ACTION",
      rationale: "이미 필요 없음", evidenceRefs: [], requiresUserDecision: false,
    }]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));
    await new Promise((resolve) => setTimeout(resolve, 200));

    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.some((body) => body.startsWith("후속 목록에 기록(이번 범위 밖, 구현 to-do): TODO-1"))).toBe(true);
    expect(bodies.some((body) => body.startsWith("후속 목록에서 제외(뒤 단계에서 처분됨): TODO-1"))).toBe(true);
    expect(JSON.parse((await artifacts.readLatest(topicId, "deferred-findings"))!).findings).toEqual([]);
    expect(bodies.some((body) => body.startsWith("현재 완료 조건과 별개로 보존한 후속 목록"))).toBe(false);
    database.close();
  });

  it("교정 뒤에도 위반이 남으면 리뷰로 넘기지 않고 사용자 결정으로 멈춘다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("block");
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "nonisolated func a() {}\nnonisolated func b() {}\nnonisolated func c() {}\n");
        return result("IMPLEMENTATION", "구현", { status: "completed", toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "" }] });
      },
      correct: () => result("IMPLEMENTATION", "그대로 둠", { status: "completed", toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "" }] }),
    });
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));

    const topic = database.getTopic(topicId);
    // 세 번째 줄 추가는 삭제줄 없이 추가만 있는 hunk → insert-token 위반. 교정도 그대로 두므로 결정 요청.
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(topic.lastError).toContain("허용 오차 위반");
    expect(database.getFlags(topicId).resumeState).toBe("IMPLEMENTING");
    expect(codex.prompts).toHaveLength(0);
    database.close();
  });
});

// 2026-09-08 Codex 후속 지적 1: 코드를 바꿀 수 있는 마지막 호출(허용 오차 교정 → 계약 교정) 뒤에도 HEAD 를 봐야 한다.
describe("허용 오차 교정 뒤 계약 교정이 커밋을 만들면", { timeout: 30_000 }, () => {
  it("HEAD 재확인에 걸려 실패하고 리뷰로 넘어가지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("late-commit");
    let resumes = 0;
    const claude: AgentAdapter = {
      role: "claude",
      async createSession() {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "func aa() {}\nfunc b() {}\n"); // 범위 밖, 술어 밖
        return { sessionId: "claude-implementation-session", result: result("IMPLEMENTATION", "구현(범위 밖 변경 포함)", { status: "completed" }) };
      },
      async resumeTurn() {
        resumes += 1;
        if (resumes === 1) {
          // 허용 오차 교정: 되돌리되 kind 를 틀리게 내 계약 교정을 한 번 더 부르게 한다.
          writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n");
          return result("FIX", "되돌렸습니다(종류 틀림)", { status: "completed" });
        }
        // 계약 교정: 범위 밖 변경을 다시 넣고 커밋으로 숨긴 뒤 정상 종류로 답한다.
        writeFileSync(join(worktree, "service", "S.swift"), "func aa() {}\nfunc b() {}\n");
        git(worktree, ["config", "user.name", "t"]); git(worktree, ["config", "user.email", "t@example.invalid"]);
        git(worktree, ["add", "service/S.swift"]); git(worktree, ["commit", "-m", "교정 뒤 몰래 커밋"]);
        return result("IMPLEMENTATION", "정상 종류", { status: "completed" });
      },
      async validateExistingSession() { return true; },
    };
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude, codex });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));

    const topic = database.getTopic(topicId);
    expect(resumes).toBe(2);
    expect(topic.state).toBe("FAILED");
    expect(topic.lastError).toContain("승인되지 않은 git commit");
    expect(codex.prompts).toHaveLength(0);
    database.close();
  });

  it("여러 줄 문자열 안의 범위 밖 변경은 원장이 있어도 술어 위반이다(기준 커밋 내용으로 문맥 판정)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("multiline");
    // 기준 커밋의 S.swift 를 여러 줄 문자열이 있는 내용으로 바꿔 둔다(구현 기준 HEAD 가 이 커밋이 되도록 브랜치 생성 전에 커밋).
    writeFileSync(join(worktree, "service", "S.swift"), 'let text = """\nfunc a() {}\n"""\nfunc b() {}\n');
    git(worktree, ["config", "user.name", "t"]); git(worktree, ["config", "user.email", "t@example.invalid"]);
    git(worktree, ["add", "service/S.swift"]); git(worktree, ["commit", "-m", "여러 줄 문자열 기준"]);
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), 'let text = """\nnonisolated func a() {}\n"""\nfunc b() {}\n');
        return { ...result("IMPLEMENTATION", "문자열 값 변경을 표기로 위장", { status: "completed" }), toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "표기" }] };
      },
      correct: () => {
        writeFileSync(join(worktree, "service", "S.swift"), 'let text = """\nfunc a() {}\n"""\nfunc b() {}\n');
        return result("IMPLEMENTATION", "되돌렸습니다.", { status: "completed" });
      },
    });
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });

    engine.startImplementation(topicId);
    await waitUntil(() => database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));

    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.prompts).toHaveLength(2);
    expect(claude.prompts[1]).toContain("술어를 만족하지 않습니다");
    database.close();
  });
});

// 2026-09-14 S11 실측 두 건 — (1) 앞 턴에 T-5 로 받아들인 원장을 러너가 다음 턴에서 빼먹어 교정 턴을 샀다,
// (2) 교정 재제출이 본 턴 보고·남은 단계 결정 요청을 덮어써 엔진이 구현 완료로 보고 리뷰로 넘겼다.
describe("허용 오차 — 턴을 넘어 살아야 할 상태는 엔진이 든다", { timeout: 30_000 }, () => {
  function scriptedClaude(turns: Array<(prompt: string) => AgentResult>) {
    const prompts: string[] = [];
    let index = 0;
    const next = (prompt: string) => { const turn = turns[index]; if (!turn) throw new Error(`턴 ${index + 1} 을 기대하지 않았습니다.`); index += 1; return turn(prompt); };
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { prompts.push(turn.prompt); return { sessionId: "claude-implementation-session", result: next(turn.prompt) }; },
      async resumeTurn(turn) { prompts.push(turn.prompt); return next(turn.prompt); },
      async validateExistingSession() { return true; },
    };
    return { adapter, prompts };
  }
  const settled = (topicId: string, database: ConsensusDatabase) => waitUntil(() =>
    database.runningAction(topicId) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(database.getTopic(topicId).state));

  it("앞 턴에서 받아들인 원장 행은 다음 턴이 비워 내도 승계돼 교정 턴 없이 통과한다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("carry");
    const claude = scriptedClaude([
      () => {
        writeFileSync(join(worktree, "feature.txt"), "구현 1\n");
        writeFileSync(join(worktree, "service", "S.swift"), "nonisolated func a() {}\nfunc b() {}\n");
        // 재시도 fixture: 남은 단계가 있어 멈춘다(status=blocked + 요청) — 다음 턴이 남은 일을 하는 쓰기 턴이다(완료 선언 계약).
        return result("IMPLEMENTATION", "P3 완료", { status: "blocked", remainingSteps: ["P3.5"], toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "S9 소유 파일 표기 1줄" }],
          requestedUserDecision: "남은 단계 P3.5 — 계속 진행 요청", });
      },
      (prompt) => {
        writeFileSync(join(worktree, "feature.txt"), "구현 2\n");
        // 원장 없음 — 서버가 승계해야 한다. 앞 턴의 요청은 결정이 왔다고 닫히지 않으므로 러너가 id 로 해소를 명시한다.
        return result("IMPLEMENTATION", "P3.5 완료(원장을 비워 냈다)", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: requestIdsIn(prompt)[0] });
      },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId);
    await settled(topicId, database);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    await engine.postMessage(topicId, "decision", "계속 진행");
    engine.retry(topicId);
    await settled(topicId, database);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.prompts).toHaveLength(2); // 교정 턴 없음
    expect(claude.prompts.some((prompt) => prompt.includes("허용 오차 규칙과 git diff 로 대조했더니"))).toBe(false);
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.filter((body) => body.startsWith("허용 오차 원장 승계 1건")).length).toBe(1);
    expect(bodies.some((body) => body.startsWith("허용 오차 대조 통과 — 범위 밖 파일 1개 (T-1: 파일 1·hunk 1)"))).toBe(true);
    const stored = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(stored.toleranceLedger).toEqual([{ ruleId: "T-1", file: "service/S.swift", note: "앞 턴 원장 승계(엔진 자동): S9 소유 파일 표기 1줄" }]);
    database.close();
  });

  it("교정 재제출이 본 턴 보고를 비워도 쟁점·증거·요청 결정이 병합돼 남고, 남은 단계 결정으로 멈춘다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("merge");
    const claude = scriptedClaude([
      () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "func aa() {}\nfunc b() {}\n"); // 이름 변경 — 위반
        return result("IMPLEMENTATION", "P3 완료 — 커버 A–D errors=0", { status: "completed", evidenceRefs: ["cover-A-post.log errors=0"],
          findings: [{ id: "TODO-1", title: "이연", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE", rationale: "범위 밖", evidenceRefs: [], requiresUserDecision: false }],
          requestedUserDecision: "남은 단계 P3.5·P3.6 — 계속 진행 요청", });
      },
      () => {
        writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n"); // 되돌림
        return result("IMPLEMENTATION", "범위 밖 변경을 되돌렸다(코드 변경 없음)", { status: "completed", evidenceRefs: ["git diff -- service/S.swift"] });
      },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId);
    await settled(topicId, database);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("USER_DECISION_REQUIRED"); // 리뷰로 새지 않는다
    expect(claude.prompts).toHaveLength(2);
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.some((body) => body.startsWith("허용 오차 교정 재제출에 본 턴 보고를 병합했습니다(서버 보존): findings 1건 · evidence 1건 · 요청 결정 · summary"))).toBe(true);
    expect(bodies.some((body) => body.includes("남은 단계 P3.5·P3.6 — 계속 진행 요청"))).toBe(true);
    const stored = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(stored.findings.map((finding: { id: string }) => finding.id)).toEqual(["TODO-1"]);
    expect(stored.evidenceRefs).toEqual(["git diff -- service/S.swift", "cover-A-post.log errors=0"]);
    expect(stored.summary).toContain("교정 전 턴 보고(서버 보존):\nP3 완료 — 커버 A–D errors=0");
    database.close();
  });
});

// 2026-09-14 Codex 감사(R01·R02·R05·R06·R07·R08·D01) — 실패 때 결과·진행 상태를 잃지 않고, 도구 트리는 러너 권한 밖이며, 설명 길이는 실패 사유가 아니다.
describe("Codex 감사 2026-09-14 — 결과 수명·진행 상태·도구 트리·원장 경계", { timeout: 30_000 }, () => {
  function scripted(turns: Array<(prompt: string) => AgentResult>) {
    const prompts: string[] = [];
    let index = 0;
    const next = (prompt: string) => { const turn = turns[index]; if (!turn) throw new Error(`턴 ${index + 1} 을 기대하지 않았습니다.`); index += 1; return turn(prompt); };
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { prompts.push(turn.prompt); return { sessionId: "claude-implementation-session", result: next(turn.prompt) }; },
      async resumeTurn(turn) { prompts.push(turn.prompt); return next(turn.prompt); },
      async validateExistingSession() { return true; },
    };
    return { adapter, prompts };
  }
  const settled = (db: ConsensusDatabase, id: string) => waitUntil(() =>
    db.runningAction(id) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(db.getTopic(id).state));

  it("R01: 허용 오차 교정 호출이 실패해도 본 턴 보고·요청 결정이 보존돼 재개 결과에 병합되고 리뷰로 새지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("r01");
    let corrections = 0;
    const claude = scripted([
      () => { writeFileSync(join(worktree, "service", "S.swift"), "func renamed() {}\nfunc b() {}\n");
        return result("IMPLEMENTATION", "본 턴 작업", { status: "completed", requestedUserDecision: "P4 가 남았다 — 계속 진행 요청", evidenceRefs: ["ORIGINAL-ONLY"] }); },
      () => { corrections += 1; writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n"); throw new Error("교정 전송 실패"); },
      () => result("IMPLEMENTATION", "원장 보완만", { status: "completed" }),
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(await artifacts.readLatest(topicId, "tolerance-correction-source")).toContain("ORIGINAL-ONLY");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("USER_DECISION_REQUIRED");
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.some((body) => body.includes("누적 checkpoint #") && body.includes("에서 이어갑니다"))).toBe(true);   // 복구의 정본은 checkpoint
    expect(bodies.some((body) => body.includes("P4 가 남았다"))).toBe(true);
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.evidenceRefs).toContain("ORIGINAL-ONLY");
    expect(saved.requestedUserDecision).toContain("P4 가 남았다 — 계속 진행 요청");   // 열린 요청은 id 와 함께 렌더된다
    database.close();
  });

  it("D01: status=in_progress 는 같은 세션에서 계속 진행 턴을 열고, completed 가 되면 리뷰로 간다(중간 결과 보존·병합)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("d01");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "1\n"); return result("IMPLEMENTATION", "P3 완료", { status: "in_progress", remainingSteps: ["P3.5 문서 동결", "P3.6"], evidenceRefs: ["p3"] }); },
      (prompt) => { expect(prompt).toContain("status=in_progress 였습니다(계속 진행 1/4)"); expect(prompt).toContain("- P3.5 문서 동결");
        writeFileSync(join(worktree, "feature.txt"), "2\n"); return result("IMPLEMENTATION", "P3.5 완료", { status: "in_progress", remainingSteps: ["P3.6"], evidenceRefs: ["p35"] }); },
      () => { writeFileSync(join(worktree, "feature.txt"), "3\n"); return result("IMPLEMENTATION", "P3.6 완료 — 전부 끝", { status: "completed", evidenceRefs: ["p36"] }); },
    ]);
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.prompts).toHaveLength(3);
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.filter((body) => body.includes("같은 세션에서 계속 진행합니다")).length).toBe(2);
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.status).toBe("completed");
    expect(saved.evidenceRefs).toEqual(expect.arrayContaining(["p36", "p35", "p3"]));
    expect(saved.summary).toContain("P3 완료");
    expect(await artifacts.readLatest(topicId, "implementation-progress")).toContain("P3.5 완료");
    database.close();
  });

  it("D01: 요약이 미완을 말해도 status 가 없고 요청 결정도 없으면 종전대로 완료로 본다(자연어 해석 없음) — status=blocked 는 정지한다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("blocked");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "P3 완료, P4 는 아직", { status: "blocked", remainingSteps: ["P4 게이트(중재자)"] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(database.getTimeline(topicId).map((event) => event.body).some((body) => body.includes("막힘(blocked)") && body.includes("P4 게이트(중재자)"))).toBe(true);
    database.close();
  });

  it("R08: 원장 메모가 2,001자여도 턴은 거부되지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("note");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "service", "S.swift"), "nonisolated func a() {}\nfunc b() {}\n");
        return result("IMPLEMENTATION", "구현", { status: "completed", toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "x".repeat(2001) }] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.prompts).toHaveLength(1);
    database.close();
  });

  it("R02: 러너 턴 도중 도구 트리(DerivedData/*-logs/scripts)가 바뀌면 턴이 실패한다(git 은 ignored 라 못 본다)", async () => {
    const { root, worktree, database, artifacts, gitService, topicId } = await setup("tooltree");
    writeFileSync(join(root, "repository", ".git", "info", "exclude"), "DerivedData/\n");
    const tool = join(worktree, "DerivedData", "s11-logs", "scripts"); mkdirSync(tool, { recursive: true });
    writeFileSync(join(tool, "gate.py"), "print('tool')\n");
    const claude = scripted([
      () => { writeFileSync(join(tool, "gate.py"), "print('changed by runner')\n"); writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { status: "completed" }); },
      () => result("IMPLEMENTATION", "done after restore", { status: "completed" }),
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state).toBe("FAILED");
    expect(topic.lastError ?? "").toContain("도구 트리가");
    expect(database.getTimeline(topicId).map((event) => event.body).some((body) => body.includes("러너는 앱 코드만 고친다"))).toBe(true);
    // F04: 복구(재동기화) 없이 retry 하면 기준 산출물(tool-tree-baseline)과 여전히 달라 다시 실패한다 — 현재 디스크를 새 기준으로 잡지 않는다.
    engine.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(database.getTopic(topicId).lastError ?? "").toContain("재개 전");
    // 중재자가 되돌린 뒤(여기서는 파일 원복) rebaseline 없이도 기준과 같아지면 통과한다 — 원복이 곧 복구다.
    writeFileSync(join(tool, "gate.py"), "print('tool')\n");
    engine.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("READY_TO_DELIVER");
    database.close();
  });

  it("F04: 중재자가 새 도구 핀을 배치했으면 tool-tree-rebaseline 으로만 새 기준이 된다", async () => {
    const { root, worktree, database, artifacts, gitService, topicId } = await setup("rebaseline");
    writeFileSync(join(root, "repository", ".git", "info", "exclude"), "DerivedData/\n");
    const tool = join(worktree, "DerivedData", "s11-logs", "scripts"); mkdirSync(tool, { recursive: true });
    writeFileSync(join(tool, "gate.py"), "print('v1')\n");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "P3", { status: "blocked", remainingSteps: ["P4"], requestedUserDecision: "P4 요청" }); },
      (prompt) => { writeFileSync(join(worktree, "feature.txt"), "y\n"); return result("IMPLEMENTATION", "done", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: requestIdsIn(prompt)[0] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    writeFileSync(join(tool, "gate.py"), "print('v2 — mediator tools_sync')\n");   // 중재자 재동기화(정당한 변경)
    await engine.postMessage(topicId, "decision", "계속");
    engine.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("FAILED"); // rebaseline 전엔 기준 불일치
    await engine.rebaselineToolTree(topicId, "tools_sync r11");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(database.getTimeline(topicId).map((event) => event.body).some((body) => body.includes("도구 트리 기준 #2 — tools_sync r11"))).toBe(true);
    database.close();
  });

  it("F02: 결정이 필요한 쟁점(requiresUserDecision)이 있으면 in_progress 여도 계속 진행 턴을 열지 않고 정지한다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("f02");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "진행 중", { status: "in_progress", remainingSteps: ["P3.5"],
        findings: [{ id: "Q-1", title: "결정 필요", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "범위 밖 파일을 고칠지 결정해달라", evidenceRefs: [], requiresUserDecision: true }] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(claude.prompts).toHaveLength(1);
    expect(database.getTimeline(topicId).map((event) => event.body).some((body) => body.includes("같은 세션에서 계속 진행합니다"))).toBe(false);
    database.close();
  });

  it("F03: 일반 계약 교정이 실패해도 원본의 요청 결정·증거가 retry 결과에 병합돼 리뷰로 새지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("f03");
    let calls = 0;
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("FIX" as AgentResult["kind"], "실제 작업", { requestedUserDecision: "ORIGINAL-DECISION P4 remains", evidenceRefs: ["ORIGINAL-PROOF"] }); },
      () => { calls += 1; throw new Error("교정 전송 실패"); },
      () => result("IMPLEMENTATION", "짧은 완료 응답", { status: "completed" }),
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("USER_DECISION_REQUIRED");
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.requestedUserDecision).toContain("ORIGINAL-DECISION P4 remains");   // 열린 요청은 id 와 함께 렌더된다
    expect(saved.evidenceRefs).toContain("ORIGINAL-PROOF");
    database.close();
  });

  it("F03(진행 중 결과): 계속 진행 턴이 끊긴 뒤 retry 하면 progress 산출물의 증거가 최종 결과에 병합된다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("progress");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "1\n"); return result("IMPLEMENTATION", "P3", { status: "in_progress", remainingSteps: ["P3.5"], evidenceRefs: ["P3-PROOF"] }); },
      () => { throw new Error("계속 진행 전송 실패"); },
      () => { writeFileSync(join(worktree, "feature.txt"), "2\n"); return result("IMPLEMENTATION", "P3.5 끝", { status: "completed", evidenceRefs: ["P35-PROOF"] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.evidenceRefs).toEqual(expect.arrayContaining(["P35-PROOF", "P3-PROOF"]));
    database.close();
  });

  it("F08: 실패 원본 복구와 허용 오차 교정 병합이 겹쳐도 resolvesRequestedDecision 은 유지돼 원래 질문이 되살아나지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("f08");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "service", "S.swift"), "func renamed() {}\nfunc b() {}\n"); return result("IMPLEMENTATION", "본 턴", { status: "completed", requestedUserDecision: "범위 밖 변경을 유지할까?" }); },
      () => { throw new Error("교정 전송 실패"); },                                  // 실패 → tolerance-correction-source 보존
      () => { return result("IMPLEMENTATION", "재개 — 아직 범위 밖 변경 있음", { status: "completed" }); }, // 재개 턴: 원본 병합(질문 복원) → 위반 → 교정
      (prompt) => { writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n"); return result("IMPLEMENTATION", "전부 되돌림", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: requestIdsIn(prompt)[0] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    database.close();
  });

  it("F09·F10: 20,001자 메모와 5,001행 승계 원장도 결과 파서·저장 계약을 통과한다", async () => {
    const { parseAgentResult } = await import("../src/server/adapters/resultParser");
    const { AgentResultSchema } = await import("../src/shared/contracts");
    const long = { kind: "IMPLEMENTATION", status: "completed", summary: "s", findings: [], evidenceRefs: [], toleranceLedger: [{ ruleId: "T-1", file: "a.swift", note: "x".repeat(20001) }] };
    expect(parseAgentResult([long], "").toleranceLedger?.[0].note.length).toBe(20001);
    const rows = Array.from({ length: 5001 }, (_, i) => ({ ruleId: "T-1", file: `s/${i}.swift`, note: "" }));
    expect(AgentResultSchema.safeParse({ ...long, toleranceLedger: rows }).success).toBe(true);
    const tooMany = { ...long, toleranceLedger: Array.from({ length: 501 }, (_, i) => ({ ruleId: "T-1", file: `s/${i}.swift`, note: "" })) };
    expect(() => parseAgentResult([tooMany], "")).toThrow();
  });


  it("D02: 구현·재개 턴은 결정·증거 원문 산출물(decisions)을 읽기 허용 경로로 받고 프롬프트가 그 경로를 안내한다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("decisions");
    const seen: Array<readonly string[] | undefined> = [];
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { seen.push(turn.readablePaths); writeFileSync(join(worktree, "feature.txt"), "x\n"); return { sessionId: "s", result: result("IMPLEMENTATION", "done", { status: "completed" }) }; },
      async resumeTurn() { throw new Error("no"); },
      async validateExistingSession() { return true; },
    };
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId, undefined, "[d01] 첫 결정 원문");
    await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("READY_TO_DELIVER");
    const decisions = await artifacts.readLatest(topicId, "decisions");
    expect(decisions).toContain("[d01] 첫 결정 원문");
    expect(seen[0]?.some((path) => path.includes("decisions"))).toBe(true);
    database.close();
  });
});

// 2026-09-14 Codex 3차 감사(R3-02·R3-03·R3-10) — 진단(결함 관찰)을 정상 기대값으로 뒤집은 회귀 테스트.
describe("Codex 3차 감사 2026-09-14 — 중첩 교정 실패 복구·계속 진행 입장 재검사·수정 진행 원장 승계", { timeout: 30_000 }, () => {
  function scripted(turns: Array<(prompt: string) => AgentResult>) {
    const prompts: string[] = [];
    let index = 0;
    const next = (prompt: string) => { const turn = turns[index]; if (!turn) throw new Error(`턴 ${index + 1} 을 기대하지 않았습니다.`); index += 1; return turn(prompt); };
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { prompts.push(turn.prompt); return { sessionId: "claude-implementation-session", result: next(turn.prompt) }; },
      async resumeTurn(turn) { prompts.push(turn.prompt); return next(turn.prompt); },
      async validateExistingSession() { return true; },
    };
    return { adapter, prompts };
  }
  const settled = (db: ConsensusDatabase, id: string) => waitUntil(() =>
    db.runningAction(id) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED"].includes(db.getTopic(id).state));

  it("R3-02: 허용 오차 교정 원본의 요청 결정은 그 뒤 일반 계약 교정이 실패해도 retry 결과에 순서대로 병합돼 리뷰로 새지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("r3-02");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "service/S.swift"), "func renamed() {}\nfunc b() {}\n"); return result("IMPLEMENTATION", "original", { status: "completed", requestedUserDecision: "ORIGINAL-DECISION", evidenceRefs: ["ORIGINAL-PROOF"] }); },
      () => { writeFileSync(join(worktree, "service/S.swift"), "func a() {}\nfunc b() {}\n"); return result("FIX", "short corrected raw", { status: "completed" }); },   // 되돌렸지만 kind 가 틀림 → 계약 교정
      () => { throw new Error("generic repair failed"); },
      () => result("IMPLEMENTATION", "retry complete", { status: "completed" }),
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(await artifacts.readLatest(topicId, "tolerance-correction-source")).toContain("ORIGINAL-DECISION");
    expect(await artifacts.readLatest(topicId, "contract-repair-source")).not.toContain("ORIGINAL-DECISION");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, database.getTimeline(topicId).map((event) => `#${event.sequence} ${event.body.slice(0, 160)}`).join("\n")).toBe("USER_DECISION_REQUIRED");
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.requestedUserDecision).toContain("ORIGINAL-DECISION");
    expect(saved.evidenceRefs).toContain("ORIGINAL-PROOF");
    expect(claude.prompts).toHaveLength(4);
    database.close();
  });

  it("R3-02(진행 중): 계속 진행 응답의 계약 교정이 실패해도 progress 원본의 증거가 retry 최종 결과에 남는다", async () => {
    const { database, artifacts, gitService, topicId } = await setup("r3-02p");
    const claude = scripted([
      () => result("IMPLEMENTATION", "P3", { status: "in_progress", remainingSteps: ["P4"], evidenceRefs: ["P3-PROOF"] }),
      () => result("FIX", "P4 short report", { status: "completed" }),
      () => { throw new Error("contract failure"); },
      () => result("IMPLEMENTATION", "P4 done", { status: "completed" }),
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(await artifacts.readLatest(topicId, "implementation-progress")).toContain("P3-PROOF");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.evidenceRefs).toContain("P3-PROOF");
    expect(saved.status).toBe("completed");
    expect(saved.remainingSteps ?? []).toEqual([]);
    database.close();
  });

  it("R3-03: 진행 결과를 저장하는 사이 새 결정이 도착하면 다음 계속 진행 턴(쓰기 호출)을 열지 않는다", async () => {
    const { database, artifacts, gitService, topicId } = await setup("r3-03");
    let resumed = 0; let posted = false;
    let engine: WorkflowEngine;
    const originalWrite = artifacts.write.bind(artifacts);
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      const saved = await originalWrite(...args);
      if (args[1] === "implementation-progress" && !posted) { posted = true; await engine.postMessage(topicId, "decision", "Stop and apply the new user decision"); }
      return saved;
    };
    const adapter: AgentAdapter = {
      role: "claude",
      createSession: async () => ({ sessionId: "s", result: result("IMPLEMENTATION", "P3", { status: "in_progress", remainingSteps: ["P4"] }) }),
      resumeTurn: async () => { resumed += 1; throw new Error("R3_WRITE_AFTER_NEW_DECISION"); },
      validateExistingSession: async () => true,
    };
    engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(posted, database.getTimeline(topicId).map((event) => event.body).join(" | ")).toBe(true);
    expect(resumed).toBe(0);
    const topic = database.getTopic(topicId);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(topic.lastError ?? "").not.toContain("R3_WRITE_AFTER_NEW_DECISION");
    // 거부는 공통 실행기가 spawn 직전(adapter 호출 전) 검사에서 한다 — 사유는 구조화된 이벤트로 남는다.
    expect(database.getTimeline(topicId).some((event) => event.body.includes("계속 진행 턴 을 열기 직전에 새 결정·증거가 도착해 실행하지 않습니다") && event.payload?.admissionRefused === "new-user-input")).toBe(true);
    expect(await artifacts.readLatest(topicId, "implementation-progress")).toContain("P3");
    database.close();
  });

  it("R3-10: 수정 계속 진행(fix-progress)에서 받아들인 원장은 다음 수정 턴이 생략해도 승계돼 교정 턴을 사지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("r3-10");
    const agreed: AgentResult["findings"][number] = { id: "F-1", title: "fix", severity: "MEDIUM", disposition: "AGREED_ACTION", rationale: "fix", evidenceRefs: ["feature.txt"], requiresUserDecision: false };
    const resolved = { ...agreed, disposition: "RESOLVED_BY_FIX" as const };
    let resumes = 0; let reviews = 0; const resumePrompts: string[] = [];
    const claude: AgentAdapter = {
      role: "claude", validateExistingSession: async () => true,
      createSession: async () => ({ sessionId: "implementation", result: result("IMPLEMENTATION", "done", { status: "completed" }) }),
      resumeTurn: async (turn) => {
        resumes += 1; resumePrompts.push(turn.prompt);
        if (resumes === 1) { writeFileSync(join(worktree, "service/S.swift"), "nonisolated func a() {}\nfunc b() {}\n"); return result("FIX", "P3 fixed", { status: "in_progress", remainingSteps: ["P4"], findings: [resolved], toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "accepted outside change" }] }); }
        if (resumes === 2) return result("FIX", "P4 done", { status: "completed", findings: [resolved] });
        throw new Error("R3_UNNECESSARY_TOLERANCE_REPAIR");
      },
    };
    const codex: AgentAdapter = {
      role: "codex", validateExistingSession: async () => true,
      createSession: async () => { reviews += 1; return { sessionId: "review", result: result("REVIEW", "fix requested", { findings: [agreed] }) }; },
      resumeTurn: async () => { reviews += 1; return result("FINAL_REVIEW", "done", { findings: [resolved] }); },
    };
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude, codex });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(await artifacts.readLatest(topicId, "fix-progress")).toContain("accepted outside change");
    expect(resumes).toBe(2);
    expect(reviews).toBe(2);
    expect(database.getTimeline(topicId).some((event) => event.body.includes("허용 오차 원장 승계 1건"))).toBe(true);
    // 계속 진행 프롬프트는 원장 전체 재제출이 아니라 변경분만 요구한다(R3-11 — 파서 500행 한도와 일치).
    expect(resumePrompts[1]).toContain("이번 턴에 새로 생기거나 바뀐 범위 밖 변경만");
    expect(resumePrompts[1]).not.toContain("전부를 다시 적으세요");
    database.close();
  });
});

// 2026-09-14 PLAN — 공통 실행기·checkpoint·완료 판정의 검증 조건. 정상 완료 fixture(status=completed)와 상태 누락·보류·재시도 fixture 를 구분한다.
describe("PLAN 2026-09-14 — 완료 판정·상태 확인·요청별 보존·checkpoint 복구·멱등 수락", { timeout: 30_000 }, () => {
  function scripted(turns: Array<(turn: { prompt: string; protocolOnly?: boolean }) => AgentResult>) {
    const prompts: string[] = []; const turnsSeen: Array<{ prompt: string; protocolOnly?: boolean }> = [];
    let index = 0;
    const next = (turn: { prompt: string; protocolOnly?: boolean }) => {
      const script = turns[index]; if (!script) throw new Error(`턴 ${index + 1} 을 기대하지 않았습니다.`); index += 1; turnsSeen.push(turn); return script(turn);
    };
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { prompts.push(turn.prompt); turn.onSessionCreated?.("claude-implementation-session"); return { sessionId: "claude-implementation-session", result: next(turn) }; },
      async resumeTurn(turn) { prompts.push(turn.prompt); return next(turn); },
      async validateExistingSession() { return true; },
    };
    return { adapter, prompts, turnsSeen, calls: () => index };
  }
  const settled = (db: ConsensusDatabase, id: string) => waitUntil(() =>
    db.runningAction(id) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED", "BLOCKED_ON_EVIDENCE"].includes(db.getTopic(id).state));

  it("상태 누락(신규 결과): 쓰기 턴이 아니라 읽기 전용 확인 턴 1회로 완료를 확인하고, 확인이 completed 면 리뷰로 간다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("status-missing");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "다 했다(하지만 status 없음)"); },   // 상태 누락 fixture
      (turn) => { if (!turn.protocolOnly) throw new Error("확인 턴은 읽기 전용이어야 한다"); return result("IMPLEMENTATION", "다 했다", { status: "completed" }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.calls()).toBe(2);
    expect(claude.turnsSeen[1].protocolOnly).toBe(true);
    expect(claude.turnsSeen[1].prompt).toContain("완료로 판정하지 못했습니다");
    expect(database.getTimeline(topicId).some((event) => event.body.includes("완료 판정 보류") && event.body.includes("읽기 전용 확인 턴을 1회"))).toBe(true);
    database.close();
  });

  it("상태 누락 + 확인 뒤에도 불명확: 같은 확인을 반복하지 않고 결과를 보존한 채 멈춘다(FAILED 아님)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("status-unclear");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "status 없음", { evidenceRefs: ["PROOF-1"] }); },
      () => result("IMPLEMENTATION", "여전히 status 없음"),   // 확인 턴도 상태를 못 밝힘
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(topic.lastError).toContain("읽기 전용 확인 1회 소진");
    expect(claude.calls()).toBe(2);
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.evidenceRefs).toContain("PROOF-1");                       // 보존
    const checkpoint = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(checkpoint.phase).toBe("paused"); expect(checkpoint.confirmations).toBe(1);
    database.close();
  });

  it("모순(completed + remainingSteps)은 완료가 아니다 — 확인 턴이 in_progress 로 바로잡으면 계속 진행 턴이 남은 단계를 한다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("contradiction");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "P3", { status: "completed", remainingSteps: ["P4"] }); },
      (turn) => { expect(turn.protocolOnly).toBe(true); return result("IMPLEMENTATION", "P3", { status: "in_progress", remainingSteps: ["P4"] }); },
      (turn) => { expect(turn.protocolOnly).toBeFalsy(); expect(turn.prompt).toContain("계속 진행"); return result("IMPLEMENTATION", "P4 done", { status: "completed" }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.calls()).toBe(3);
    database.close();
  });

  it("보류 결정: 결정이 왔어도 러너가 해소를 확인하지 않은 요청은 열린 채 남고, 다른 요청만 id 로 닫힌다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("hold");
    let ids: string[] = [];
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "두 가지 판단 필요", { status: "completed", requestedUserDecision: "A: 모듈 경계를 바꿀까?" }); },
      (turn) => { ids = requestIdsIn(turn.prompt); expect(turn.protocolOnly).toBe(true); return result("IMPLEMENTATION", "A 는 보류", { status: "completed" }); }, // 확인 턴: 해소 표식 없음 → A 유지
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    await engine.postMessage(topicId, "decision", "A 는 보류하고 다른 것부터 확인해");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(topic.lastError).toContain("A: 모듈 경계를 바꿀까?");   // 요청은 결정만으로 지워지지 않는다
    expect(ids).toHaveLength(1);
    expect(claude.calls()).toBe(2);
    const checkpoint = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(checkpoint.openRequests.map((request: { id: string }) => request.id)).toEqual(ids);
    database.close();
  });

  it("여러 요청: 두 질문이 차례로 쌓이고 각각 자기 id 로만 닫힌다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("multi");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "P3", { status: "blocked", remainingSteps: ["P4"], requestedUserDecision: "A?" }); },
      (turn) => { const [a] = requestIdsIn(turn.prompt); return result("IMPLEMENTATION", "P4 하다가 B 질문", { status: "blocked", remainingSteps: ["P5"], requestedUserDecision: "B?", resolvesRequestedDecision: true, resolvedRequestId: a }); },
      (turn) => { const ids = requestIdsIn(turn.prompt); expect(ids).toHaveLength(1); return result("IMPLEMENTATION", "P5 done", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: ids[0] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).lastError).toContain("A?");
    await engine.postMessage(topicId, "decision", "A 답"); engine.retry(topicId); await settled(database, topicId);
    const mid = database.getTopic(topicId);
    expect(mid.state).toBe("USER_DECISION_REQUIRED");
    expect(mid.lastError).toContain("B?"); expect(mid.lastError).not.toContain("A?");
    await engine.postMessage(topicId, "decision", "B 답"); engine.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    expect(database.getTimeline(topicId).filter((event) => event.body.includes("해소로 확인해 닫았습니다"))).toHaveLength(2);
    database.close();
  });

  it("여러 요청을 한 응답으로 닫는다 — resolvedRequestIds 에 나열한 id 가 각각 닫히고 확인 턴 없이 인도 대기로 간다(2026-09-21)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("multi-resolve");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "P3", { status: "blocked", remainingSteps: ["P4"], requestedUserDecision: "A?" }); },
      // 결정 없이 같은 요청을 다시 물어 stale 중복이 쌓인 상황: A 를 닫지 않고 B 를 새로 연다.
      (turn) => { expect(requestIdsIn(turn.prompt)).toHaveLength(1); return result("IMPLEMENTATION", "P4 하다가 B 질문", { status: "blocked", remainingSteps: ["P5"], requestedUserDecision: "B?" }); },
      (turn) => {
        const ids = requestIdsIn(turn.prompt);
        expect(ids).toHaveLength(2);
        expect(turn.prompt).toContain("resolvedRequestIds");
        return result("IMPLEMENTATION", "P5 done — A·B 모두 같은 결정으로 해소", { status: "completed", resolvesRequestedDecision: true, resolvedRequestIds: ids });
      },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).lastError).toContain("A?");
    await engine.postMessage(topicId, "decision", "일단 계속"); engine.retry(topicId); await settled(database, topicId);
    const mid = database.getTopic(topicId);
    expect(mid.state).toBe("USER_DECISION_REQUIRED");
    expect(mid.lastError).toContain("A?"); expect(mid.lastError).toContain("B?");
    await engine.postMessage(topicId, "decision", "A·B 둘 다 답"); engine.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.calls()).toBe(3);   // 읽기 전용 확인 턴 없음
    expect(database.getTimeline(topicId).filter((event) => event.body.includes("해소로 확인해 닫았습니다"))).toHaveLength(2);
    expect(database.getTimeline(topicId).filter((event) => event.body.includes("해소 표식을 적용하지 않았습니다"))).toHaveLength(0);
    const checkpoint = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(checkpoint.openRequests).toEqual([]);
    database.close();
  });

  it("허용 오차 교정 프롬프트는 이번 턴이 새로 연 요청의 id 도 싣는다 — 교정이 원인을 되돌렸으면 그 요청을 resolvedRequestIds 로 닫을 수 있다(host-review R03)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("r03-latest");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "service", "S.swift"), "func renamed() {}\nfunc b() {}\n");
        return result("IMPLEMENTATION", "범위 밖 변경 + 질문", { status: "completed", requestedUserDecision: "renamed 를 유지할까?" }); },
      (turn) => {
        const ids = requestIdsIn(turn.prompt);
        expect(ids, "교정 프롬프트에 이번 턴 질문의 서버 id 가 없다").toHaveLength(1);
        writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n");
        return result("IMPLEMENTATION", "되돌려 질문이 사라짐", { status: "completed", resolvesRequestedDecision: true, resolvedRequestIds: ids });
      },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.calls()).toBe(2);   // 교정 1회, 확인 턴 없음
    const checkpoint = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(checkpoint.openRequests).toEqual([]);
    database.close();
  });

  it("서버 재시작(새 엔진 인스턴스) 뒤에도 checkpoint 에서 이어간다 — 계속 진행 턴이 죽은 자리부터, 증거·원장 보존", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("restart");
    const first = scripted([
      () => { writeFileSync(join(worktree, "service", "S.swift"), "nonisolated func a() {}\nfunc b() {}\n"); writeFileSync(join(worktree, "feature.txt"), "1\n");
        return result("IMPLEMENTATION", "P3", { status: "in_progress", remainingSteps: ["P4"], evidenceRefs: ["P3-PROOF"], toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "표기" }] }); },
      () => { throw new Error("서버 종료로 실행을 중단했습니다."); },   // 계속 진행 턴 도중 종료
    ]);
    const engine1 = new WorkflowEngine({ database, artifacts, git: gitService, claude: first.adapter, codex: new PassingCodex() });
    engine1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    const checkpoint = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(checkpoint.phase).toBe("before-continuation"); expect(checkpoint.verifiedLedger).toHaveLength(1);
    const second = scripted([
      (turn) => { expect(turn.prompt).toContain("이어지는 턴"); writeFileSync(join(worktree, "feature.txt"), "2\n"); return result("IMPLEMENTATION", "P4 done", { status: "completed", evidenceRefs: ["P4-PROOF"] }); }, // 원장 생략 → 승계
    ]);
    const engine2 = new WorkflowEngine({ database, artifacts, git: gitService, claude: second.adapter, codex: new PassingCodex() });
    engine2.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.evidenceRefs).toEqual(expect.arrayContaining(["P3-PROOF", "P4-PROOF"]));
    expect(saved.toleranceLedger).toHaveLength(1);
    expect(database.getTimeline(topicId).some((event) => event.body.includes("누적 checkpoint #") && event.body.includes("before-continuation"))).toBe(true);
    database.close();
  });

  it("수락 도중 종료(산출물·메모리 반영 뒤, accepted 기록·전이 전) → 재개는 모델 호출 0회, agent_output 1회, 메모리 1회, 전이 완료", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("kill-accept");
    const memoryApplied: string[] = [];
    const memory = { apply: async (_role: string, updates: readonly { path: string; reason: string }[]) => { memoryApplied.push(...updates.map((u) => u.path)); return updates.map((u) => ({ path: u.path, previousSHA256: null, sha256: "0".repeat(64), reason: u.reason, status: "written" as const })); } };
    const originalWrite = artifacts.write.bind(artifacts);
    let killed = false;
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (args[1] === "work-checkpoint" && !killed && args[3].includes('"phase": "accepted"')) { killed = true; throw new Error("서버 종료로 실행을 중단했습니다."); }
      return originalWrite(...args);
    };
    const first = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { status: "completed", memoryUpdates: [{ path: "notes/a.md", content: "a", expectedSHA256: null, reason: "r" }] }); },
    ]);
    const engine1 = new WorkflowEngine({ database, artifacts, git: gitService, claude: first.adapter, codex: new PassingCodex(), memory });
    engine1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(memoryApplied).toEqual(["notes/a.md"]);
    const second = scripted([]);   // 재개는 모델을 부르지 않는다
    const engine2 = new WorkflowEngine({ database, artifacts, git: gitService, claude: second.adapter, codex: new PassingCodex(), memory });
    engine2.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(second.calls()).toBe(0);
    expect(memoryApplied).toEqual(["notes/a.md"]);   // 두 번 반영되지 않는다
    const outputs = database.getTimeline(topicId).filter((event) => event.kind === "agent_output" && event.actor === "claude");
    expect(outputs).toHaveLength(1);
    expect(outputs[0].payload?.acceptId).toBeTypeOf("number");
    expect(database.getTimeline(topicId).some((event) => event.body.includes("받아들인 결과(acceptId") && event.body.includes("모델 호출 없음"))).toBe(true);
    const checkpoint = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(checkpoint.phase).toBe("accepted"); expect(checkpoint.acceptId).toBe(outputs[0].payload?.acceptId);
    database.close();
  });

  it("수정 회차 소비와 최종 리뷰 전이는 한 트랜잭션이다 — 재개는 회차를 두 번 소비하지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("fixpass");
    const agreed: AgentResult["findings"][number] = { id: "F-1", title: "fix", severity: "MEDIUM", disposition: "AGREED_ACTION", rationale: "fix", evidenceRefs: ["feature.txt"], requiresUserDecision: false };
    const resolved = { ...agreed, disposition: "RESOLVED_BY_FIX" as const };
    const originalWrite = artifacts.write.bind(artifacts);
    let killed = false;
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (args[1] === "work-checkpoint" && !killed && args[3].includes('"phase": "accepted"') && args[3].includes('"kind": "FIX"')) { killed = true; throw new Error("서버 종료"); }
      return originalWrite(...args);
    };
    const claude: AgentAdapter = {
      role: "claude", validateExistingSession: async () => true,
      createSession: async (turn) => { turn.onSessionCreated?.("implementation"); writeFileSync(join(worktree, "feature.txt"), "x\n"); return { sessionId: "implementation", result: result("IMPLEMENTATION", "done", { status: "completed" }) }; },
      resumeTurn: async () => { writeFileSync(join(worktree, "feature.txt"), "y\n"); return result("FIX", "fixed", { status: "completed", findings: [resolved] }); },
    };
    let reviews = 0;
    const codex: AgentAdapter = {
      role: "codex", validateExistingSession: async () => true,
      createSession: async () => { reviews += 1; return { sessionId: "review", result: result("REVIEW", "fix requested", { findings: [agreed] }) }; },
      resumeTurn: async () => { reviews += 1; return result("FINAL_REVIEW", "done", { findings: [resolved] }); },
    };
    const engine1 = new WorkflowEngine({ database, artifacts, git: gitService, claude, codex });
    engine1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(database.getFlags(topicId).fixPassUsed).toBe(false);   // 전이 전 종료 — 회차도 소비되지 않았다
    const engine2 = new WorkflowEngine({ database, artifacts, git: gitService, claude: { ...claude, resumeTurn: async () => { throw new Error("재개는 수정 턴을 다시 부르지 않는다"); } }, codex });
    engine2.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(database.getFlags(topicId).fixPassUsed).toBe(true);
    expect(reviews).toBe(2);
    expect(database.getTimeline(topicId).filter((event) => event.kind === "agent_output" && event.payload?.resultKind === "FIX")).toHaveLength(1);
    expect(database.getTimeline(topicId).filter((event) => event.body === "Codex가 수정 결과를 마지막으로 검토합니다.")).toHaveLength(1);
    database.close();
  });

  it("검증 원장 500행 + 새 1행: 다음 턴이 새 1행만 제출해도 서버 누적 501행이 유지되고 재제출·교정 호출이 없다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("ledger-501");
    const { AgentResultSchema } = await import("../src/shared/contracts");
    const bigLedger = Array.from({ length: 500 }, (_, i) => ({ ruleId: "T-1", file: `service/${i}.swift`, note: "" }));
    // 워킹트리에 실제 범위 밖 파일 1개만 있고, 원장 500행은 앞 턴이 검증했다고 가정한 누적본을 checkpoint 로 심는다(이 정책은 파일 수 상한이 1 이라
    // 실제 501 파일을 만들 수 없다 — 누적 저장·승계 계약만 본다).
    const engineBoot = new WorkflowEngine({ database, artifacts, git: gitService, claude: { role: "claude", validateExistingSession: async () => true, createSession: async () => { throw new Error("x"); }, resumeTurn: async () => { throw new Error("x"); } }, codex: new PassingCodex() });
    void engineBoot;
    const accumulated = AgentResultSchema.parse({ kind: "IMPLEMENTATION", summary: "s", findings: [], evidenceRefs: [], status: "completed", toleranceLedger: bigLedger });
    expect(accumulated.toleranceLedger).toHaveLength(500);
    const { accumulate } = await import("../src/server/engine/checkpoint");
    const next = { kind: "IMPLEMENTATION" as const, summary: "s2", findings: [], evidenceRefs: [], status: "completed" as const, toleranceLedger: [{ ruleId: "T-1", file: "service/new.swift", note: "" }] };
    const { carryForwardLedger } = await import("../src/shared/tolerance");
    // 서버 승계 규칙: 앞 턴 검증 원장 + 이번 턴 변경분 = 501행(파서 500행 한도는 한 번 응답에만 적용된다).
    const carry = carryForwardLedger(accumulated.toleranceLedger ?? [], next.toleranceLedger, [...bigLedger.map((row) => row.file), "service/new.swift"]);
    expect(carry.ledger).toHaveLength(501);
    expect(carry.carried).toHaveLength(500);
    expect(AgentResultSchema.safeParse({ ...accumulate(accumulated, next, [], 0).result, toleranceLedger: carry.ledger }).success).toBe(true);
    void worktree;
    database.close();
  });
});

// 2026-09-14 Astra 리뷰(CF-01~CF-08) — 수락·복구·누적·확인·작업 id 경계의 반례를 정상 기대값으로.
describe("Astra 리뷰 2026-09-14 — 수락 현재성·재판정·작업 id·요청 누적·확인 복구", { timeout: 30_000 }, () => {
  function scripted(turns: Array<(turn: { prompt: string; protocolOnly?: boolean }) => AgentResult>) {
    const turnsSeen: Array<{ prompt: string; protocolOnly?: boolean }> = [];
    let index = 0;
    const next = (turn: { prompt: string; protocolOnly?: boolean }) => {
      const script = turns[index]; if (!script) throw new Error(`턴 ${index + 1} 을 기대하지 않았습니다.`); index += 1; turnsSeen.push(turn); return script(turn);
    };
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { turn.onSessionCreated?.("claude-implementation-session"); return { sessionId: "claude-implementation-session", result: next(turn) }; },
      async resumeTurn(turn) { return next(turn); },
      async validateExistingSession() { return true; },
    };
    return { adapter, turnsSeen, calls: () => index };
  }
  const settled = (db: ConsensusDatabase, id: string) => waitUntil(() =>
    db.runningAction(id) === null && ["READY_TO_DELIVER", "FAILED", "USER_DECISION_REQUIRED", "BLOCKED_ON_EVIDENCE"].includes(db.getTopic(id).state));

  it("CF-01: 수락 절차 도중 새 결정이 오면 채택·전이하지 않는다(리뷰 0회)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf01-input");
    const claude = scripted([() => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { status: "completed" }); }]);
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });
    const originalWrite = artifacts.write.bind(artifacts); let injected = false;
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (!injected && args[1] === "work-checkpoint" && args[3].includes('"phase": "accepted"')) {
        injected = true; await engine.postMessage(topicId, "decision", "완료하지 말고 추가 수정 필요: REFIX 새 결정부터 반영");
      }
      return originalWrite(...args);
    };
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(codex.prompts).toHaveLength(0);
    database.close();
  });

  it.each(["tree-change", "new-decision"] as const)("CF-01: accepting checkpoint 재개도 현재성 검사를 거친다 — %s", async (scenario) => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf01-restart");
    const originalWrite = artifacts.write.bind(artifacts); let killed = false;
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (!killed && args[1] === "work-checkpoint" && args[3].includes('"phase": "accepted"')) { killed = true; throw new Error("종료"); }
      return originalWrite(...args);
    };
    const first = scripted([() => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { status: "completed" }); }]);
    const engine1 = new WorkflowEngine({ database, artifacts, git: gitService, claude: first.adapter, codex: new PassingCodex() });
    engine1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!).phase).toBe("accepting");
    if (scenario === "tree-change") writeFileSync(join(worktree, "service/S.swift"), "func forbiddenChange() {}\n");
    else await engine1.postMessage(topicId, "decision", "REFIX feature.txt 재수정 — 완료 처리 멈추고 새 요구 반영");
    // tree-change: 모델 호출 없이 현재 변경분을 다시 대조 → 범위 밖 변경 → 교정 턴 1회(되돌리지 않음) → 정지. new-decision: 결정을 반영할 쓰기 턴이 열린다.
    const second = scripted(scenario === "tree-change"
      ? [(turn) => { expect(turn.protocolOnly).toBeFalsy(); return result("IMPLEMENTATION", "cannot revert", { status: "completed" }); }]
      : [(turn) => { expect(turn.protocolOnly).toBeFalsy(); expect(turn.prompt).toContain("REFIX"); return result("IMPLEMENTATION", "reworked", { status: "blocked", remainingSteps: ["재수정 확인"], requestedUserDecision: "재수정 범위 확인" }); }]);
    const codex = new PassingCodex();
    const engine2 = new WorkflowEngine({ database, artifacts, git: gitService, claude: second.adapter, codex });
    engine2.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").not.toBe("READY_TO_DELIVER");
    expect(codex.prompts).toHaveLength(0);
    expect(database.getTimeline(topicId).some((event) => event.body.includes("수락을 그대로 이어가지 않습니다"))).toBe(true);
    database.close();
  });

  it("CF-02: 확인 뒤 재대조가 쓰기 교정을 열고 그 응답이 in_progress 면 다시 판정한다(이전 completed 판정으로 수락하지 않음)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf02");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done awaiting A", { status: "completed", requestedUserDecision: "A?" }); },
      (turn) => { expect(turn.protocolOnly).toBe(true); const [id] = requestIdsIn(turn.prompt); return result("IMPLEMENTATION", "done", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: id }); },
      (turn) => { expect(turn.protocolOnly).toBeFalsy(); writeFileSync(join(worktree, "service/S.swift"), "func a() {}\nfunc b() {}\n"); return result("IMPLEMENTATION", "rollback done, P4 still pending", { status: "in_progress", remainingSteps: ["P4"] }); },
      (turn) => { expect(turn.prompt).toContain("계속 진행"); return result("IMPLEMENTATION", "P4 done", { status: "completed" }); },
    ]);
    const codex = new PassingCodex();
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    await engine.postMessage(topicId, "decision", "A approved");
    writeFileSync(join(worktree, "service/S.swift"), "func forbiddenChange() {}\n");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.calls()).toBe(4);   // 확인 + 교정 + 계속 진행 — 교정 응답(in_progress)을 완료로 수락하지 않았다
    expect(JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!).status).toBe("completed");
    database.close();
  });

  it("CF-03: 사용자 승인으로 연 3차 FIX 는 2차 완료 기록을 재사용하지 않고 실제 수정 턴을 돈다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf03");
    const agreed: AgentResult["findings"][number] = { id: "F-1", title: "bug", severity: "MEDIUM", disposition: "AGREED_ACTION", rationale: "still broken", evidenceRefs: ["feature.txt"], requiresUserDecision: false };
    const resolved = { ...agreed, disposition: "RESOLVED_BY_FIX" as const };
    let fixes = 0, reviews = 0;
    const claude: AgentAdapter = {
      role: "claude", validateExistingSession: async () => true,
      createSession: async (turn) => { turn.onSessionCreated?.("impl-session"); writeFileSync(join(worktree, "feature.txt"), "impl\n"); return { sessionId: "impl-session", result: result("IMPLEMENTATION", "done", { status: "completed" }) }; },
      resumeTurn: async () => { fixes++; writeFileSync(join(worktree, "feature.txt"), `fix${fixes}\n`); return result("FIX", `fix${fixes}`, { status: "completed", findings: [resolved] }); },
    };
    const codex: AgentAdapter = {
      role: "codex", validateExistingSession: async () => true,
      createSession: async () => { reviews++; return { sessionId: "review-session", result: result("REVIEW", "bug", { findings: [agreed] }) }; },
      // 답변 확인(프로토콜 확인)은 리뷰 턴이 아니다 — 리뷰 카운터를 올리지 않는다.
      resumeTurn: async (turn) => confirmAnswers(turn.prompt) ?? (() => { reviews++; return result("FINAL_REVIEW", "review", { findings: [reviews >= 4 ? resolved : agreed] }); })(),
    };
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude, codex });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(fixes).toBe(2);
    await engine.postMessage(topicId, "decision", "F-1 추가 수정 회차 승인. REFIX feature.txt 실제 수정 필요");
    engine.retry(topicId); await settled(database, topicId);
    // 그 결정은 확인자가 판정한다(host-review 2026-09-21 5회차) — 리뷰 세 번을 다 쓴 주제라 그 확인 호출에 리뷰 승인 1회가 필요하다(답변 확인도 한도를 우회하지 않는다, R10).
    expect(database.getTopic(topicId).lastError).toContain("구현 리뷰 한도");
    expect(fixes).toBe(2);
    database.reviews.grant(topicId, "implementation", "cf03-confirm-grant", database.reviews.account(topicId, "implementation").version);
    engine.retry(topicId); await settled(database, topicId);
    expect(fixes).toBe(3);
    expect(readFileSync(join(worktree, "feature.txt"), "utf8")).toBe("fix3\n");
    database.close();
  });

  it("CF-04: 같은 턴의 계약 교정이 새 질문을 내도 앞 질문이 남는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf04");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("FIX", "wrong kind", { status: "completed", requestedUserDecision: "A?" }); },
      () => result("IMPLEMENTATION", "corrected kind", { status: "completed", requestedUserDecision: "B?" }),
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    const checkpoint = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(checkpoint.openRequests.map((request: { text: string }) => request.text)).toEqual(expect.arrayContaining(["A?", "B?"]));
    expect(database.getTopic(topicId).lastError).toContain("A?");
    expect(database.getTopic(topicId).lastError).toContain("B?");
    database.close();
  });

  it("CF-05: before-confirmation checkpoint 직후 종료 → 재개는 쓰기 턴이 아니라 읽기 전용 확인이다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf05-restart");
    const originalWrite = artifacts.write.bind(artifacts); let killed = false;
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      const output = await originalWrite(...args);
      if (!killed && args[1] === "work-checkpoint" && args[3].includes('"phase": "before-confirmation"')) { killed = true; throw new Error("확인 호출 전 종료"); }
      return output;
    };
    const first = scripted([() => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "status missing"); }]);
    const engine1 = new WorkflowEngine({ database, artifacts, git: gitService, claude: first.adapter, codex: new PassingCodex() });
    engine1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    const second = scripted([() => result("IMPLEMENTATION", "done", { status: "completed" })]);
    const engine2 = new WorkflowEngine({ database, artifacts, git: gitService, claude: second.adapter, codex: new PassingCodex() });
    engine2.retry(topicId); await settled(database, topicId);
    expect(second.turnsSeen.every((turn) => turn.protocolOnly === true)).toBe(true);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    database.close();
  });

  it("CF-05: 보류로 확인 1회를 소진한 뒤 새 승인 결정 + retry 는 확인 1회를 다시 허용해 완료로 간다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf05-hold");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "A?", { status: "completed", requestedUserDecision: "A?" }); },
      (turn) => { expect(turn.protocolOnly).toBe(true); return result("IMPLEMENTATION", "held", { status: "completed" }); },
      (turn) => { expect(turn.protocolOnly).toBe(true); return result("IMPLEMENTATION", "approved", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: requestIdsIn(turn.prompt)[0] }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    await engine.postMessage(topicId, "decision", "A는 보류"); engine.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).lastError).toContain("1회 소진");
    await engine.postMessage(topicId, "decision", "이제 A 승인, 요청 해소하고 완료 진행"); engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("READY_TO_DELIVER");
    expect(claude.calls()).toBe(3);
    database.close();
  });

  // ---- 2차 재검토(r2) — 저장·재시작까지 포함한 같은 경계의 반례.
  it.each(["normal-report", "recovery-checkpoint"] as const)("CF-01(r2): 마지막 비동기 저장 도중 도착한 결정은 전이 직전 동기 검사가 잡는다 — %s", async (scenario) => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf01-final");
    const write = artifacts.write.bind(artifacts); let stopped = false, injected = false;
    const initial = scripted([() => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { status: "completed" }); }]);
    const codex = new PassingCodex(); let engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: initial.adapter, codex });
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (scenario === "recovery-checkpoint" && !stopped && args[1] === "work-checkpoint" && args[3].includes('"phase": "accepted"')) { stopped = true; throw new Error("accepted 전 종료"); }
      if (scenario === "normal-report" && !injected && args[1] === "implementation") { injected = true; await engine.postMessage(topicId, "decision", "REFIX feature.txt 재수정 — 새 요구부터 반영"); }
      return write(...args);
    };
    engine.startImplementation(topicId); await settled(database, topicId);
    if (scenario === "recovery-checkpoint") {
      expect(database.getTopic(topicId).state).toBe("FAILED");
      engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: scripted([]).adapter, codex });
      artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
        if (!injected && args[1] === "work-checkpoint" && args[3].includes('"phase": "accepted"')) { injected = true; await engine.postMessage(topicId, "decision", "REFIX feature.txt 새 요구부터 반영"); }
        return write(...args);
      };
      engine.retry(topicId); await settled(database, topicId);
    }
    expect(injected).toBe(true);
    expect(codex.prompts).toHaveLength(0);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    database.close();
  });

  it("CF-01(r2): 복구 저장도 워킹트리를 보존해 또 한 번의 재시작이 같은 결과를 다시 수락하지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf01-worktree");
    const write = artifacts.write.bind(artifacts); let failures = 0, memoryCalls = 0;
    const memory = { apply: async (_role: string, updates: readonly { path: string; reason: string }[]) => { memoryCalls++; return updates.map((u) => ({ path: u.path, previousSHA256: null, sha256: "0".repeat(64), reason: u.reason, status: "written" as const })); } };
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (failures === 0 && args[1] === "work-checkpoint" && args[3].includes('"phase": "accepted"')) { failures++; throw new Error("accepted 전 종료"); }
      if (failures === 1 && args[1] === "implementation") { failures++; throw new Error("복구 보고서 저장 중 종료"); }
      return write(...args);
    };
    const first = scripted([() => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { status: "completed", memoryUpdates: [{ path: "notes/a.md", content: "a", expectedSHA256: null, reason: "r" }] }); }]);
    const codex = new PassingCodex(); const deps = { database, artifacts, git: gitService, codex, memory };
    const e1 = new WorkflowEngine({ ...deps, claude: first.adapter }); e1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED"); expect(memoryCalls).toBe(1);
    const e2 = new WorkflowEngine({ ...deps, claude: scripted([]).adapter }); e2.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    const middle = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(middle.phase).toBe("accepted"); expect(middle.worktree).toBeTruthy();
    const e3 = new WorkflowEngine({ ...deps, claude: scripted([]).adapter }); e3.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    const outputs = database.getTimeline(topicId).filter((e) => e.actor === "claude" && e.kind === "agent_output" && e.payload?.acceptId).map((e) => e.payload?.acceptId);
    expect(memoryCalls).toBe(1); expect(outputs).toHaveLength(1);
    database.close();
  });

  it("CF-04(r2): 재대조가 연 교정 응답의 새 질문 B 는 중첩 계약 교정이 실패해도 복구 목록에 남아 승인 없이 완료되지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf04-nested");
    const first = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { status: "completed", requestedUserDecision: "A?" }); },
      (turn) => result("IMPLEMENTATION", "confirmed", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: requestIdsIn(turn.prompt)[0] }),
      () => { writeFileSync(join(worktree, "service/S.swift"), "func a() {}\nfunc b() {}\n"); return result("FIX", "wrong kind from tolerance correction", { status: "completed", requestedUserDecision: "B?" }); },
      () => { throw new Error("B 보고 뒤 계약 교정 실패"); },
    ]);
    const e1 = new WorkflowEngine({ database, artifacts, git: gitService, claude: first.adapter, codex: new PassingCodex() });
    e1.startImplementation(topicId); await settled(database, topicId);
    await e1.postMessage(topicId, "decision", "A approved");
    writeFileSync(join(worktree, "service/S.swift"), "func forbiddenChange() {}\n");
    e1.retry(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    const failed = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(failed.openRequests.map((r: { text: string }) => r.text)).toContain("B?");
    const second = scripted([() => result("IMPLEMENTATION", "resumed", { status: "completed" })]);
    const codex = new PassingCodex();
    const e2 = new WorkflowEngine({ database, artifacts, git: gitService, claude: second.adapter, codex });
    e2.retry(topicId); await settled(database, topicId);
    const cp = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(cp.openRequests.map((r: { text: string }) => r.text)).toContain("B?");
    expect(codex.prompts).toHaveLength(0);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    database.close();
  });

  it("CF-04(r2): 허용 오차 교정이 질문을 생략해도 표시 문자열이 두 번째 질문으로 등록되지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf04-render");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); writeFileSync(join(worktree, "service/S.swift"), "func forbiddenChange() {}\n"); return result("IMPLEMENTATION", "done awaiting A", { status: "completed", requestedUserDecision: "A?" }); },
      () => { writeFileSync(join(worktree, "service/S.swift"), "func a() {}\nfunc b() {}\n"); return result("IMPLEMENTATION", "fixed violation", { status: "completed" }); },
      (turn) => result("IMPLEMENTATION", "A approved", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: requestIdsIn(turn.prompt)[0] }),
    ]);
    const codex = new PassingCodex(); const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });
    engine.startImplementation(topicId); await settled(database, topicId);
    const before = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(before.openRequests).toHaveLength(1);
    await engine.postMessage(topicId, "decision", "A approved"); engine.retry(topicId); await settled(database, topicId);
    const after = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(after.openRequests).toHaveLength(0);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    database.close();
  });

  it("CF-05(r2): 확인 호출이 끝난 뒤 결과 저장에 실패하면 재개는 그 확인을 다시 사지 않는다(실행 기록으로 판단)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf05-ran");
    const originalWrite = artifacts.write.bind(artifacts); let completedConfirmations = 0, killed = false;
    artifacts.write = async (...args: Parameters<ArtifactStore["write"]>) => {
      if (!killed && completedConfirmations === 1 && args[1] === "work-checkpoint" && args[3].includes('"phase": "verified"')) { killed = true; throw new Error("확인 뒤 결과 저장 전 종료"); }
      return originalWrite(...args);
    };
    const first = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "status missing"); },
      (turn) => { expect(turn.protocolOnly).toBe(true); completedConfirmations++; return result("IMPLEMENTATION", "still unclear"); },
    ]);
    const e1 = new WorkflowEngine({ database, artifacts, git: gitService, claude: first.adapter, codex: new PassingCodex() });
    e1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!).phase).toBe("before-confirmation");
    const second = scripted([(turn) => { expect(turn.protocolOnly).toBe(true); completedConfirmations++; return result("IMPLEMENTATION", "still unclear"); }]);
    const e2 = new WorkflowEngine({ database, artifacts, git: gitService, claude: second.adapter, codex: new PassingCodex() });
    e2.retry(topicId); await settled(database, topicId);
    expect(completedConfirmations).toBe(1);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(database.getTopic(topicId).lastError).toContain("1회 소진");
    database.close();
  });

  // ---- 3차 재검토(r3)
  it("CF-04(r3): 기존 질문 id 를 인용하며 다른 문구를 적으면 새 질문이다 — A 해소와 B 등록이 함께 보존된다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf04-r3");
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "partial\n"); return result("IMPLEMENTATION", "P2 needs A", { status: "in_progress", remainingSteps: ["P2"], requestedUserDecision: "A 파일 변경을 승인하나요?" }); },
      (turn) => { const id = requestIdsIn(turn.prompt)[0]; expect(id).toBeTruthy(); writeFileSync(join(worktree, "feature.txt"), "A complete\n");
        return result("IMPLEMENTATION", "A done, B needs approval", { status: "completed", requestedUserDecision: `[${id}] A는 승인됐습니다. 추가로 B 파일도 변경하나요?`, resolvesRequestedDecision: true, resolvedRequestId: id }); },
    ]);
    const codex = new PassingCodex(); const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    await engine.postMessage(topicId, "decision", "A 파일 변경만 승인합니다. P2를 진행하세요."); engine.retry(topicId); await settled(database, topicId);
    const cp = JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!);
    expect(cp.openRequests.map((r: { text: string }) => r.text).join("\n")).toContain("B 파일도 변경하나요?");
    expect(cp.openRequests).toHaveLength(1);   // A 는 닫혔다
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(codex.prompts).toHaveLength(0);
    database.close();
  });

  it("CF-05(r3): 프로세스가 뜬 뒤 오류로 끝난 확인은 실행으로 소비된다 — 새 결정 없는 재시도가 확인을 다시 띄우지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf05-r3");
    const { SpawnCommandRunner } = await import("../src/server/processRunner");
    let spawned = 0; const runner = new SpawnCommandRunner();
    const claude: AgentAdapter = {
      role: "claude", validateExistingSession: async () => true,
      createSession: async (turn) => { turn.onSessionCreated?.("implementation-session"); writeFileSync(join(worktree, "feature.txt"), "x\n"); return { sessionId: "implementation-session", result: result("IMPLEMENTATION", "status missing") }; },
      resumeTurn: async (turn) => {
        expect(turn.protocolOnly).toBe(true);
        const output = await runner.run({ command: process.execPath, args: ["-e", "process.stdout.write('confirmation ran\\n'); process.exit(1)"], cwd: turn.cwd, signal: turn.signal, beforeSpawn: turn.beforeSpawn, admitSync: turn.admitSync, onSpawn: (p) => { spawned++; turn.onProcessSpawn?.(p); } });
        if (output.exitCode !== 0) throw new Error(`confirmation command exited ${output.exitCode} after running`);
        return result("IMPLEMENTATION", "unreachable");
      },
    };
    const deps = { database, artifacts, git: gitService, claude, codex: new PassingCodex() };
    const e1 = new WorkflowEngine(deps); e1.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED"); expect(spawned).toBe(1);
    expect(JSON.parse((await artifacts.readLatest(topicId, "work-checkpoint"))!).phase).toBe("before-confirmation");
    expect(database.getTimeline(topicId).filter((e) => typeof e.payload?.confirmationExecuted === "number")).toHaveLength(1);
    const e2 = new WorkflowEngine(deps); e2.retry(topicId); await settled(database, topicId);
    expect(spawned).toBe(1);
    expect(database.getTopic(topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(database.getTopic(topicId).lastError).toContain("1회 소진");
    database.close();
  });

  it("CF-06: 상태 확인은 원본의 memoryUpdates 를 보존한다(메모리 1회 반영)", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("cf06");
    const applied: string[] = [];
    const memory = { apply: async (_role: string, updates: readonly { path: string; reason: string }[]) => { applied.push(...updates.map((u) => u.path)); return updates.map((u) => ({ path: u.path, previousSHA256: null, sha256: "0".repeat(64), reason: u.reason, status: "written" as const })); } };
    const claude = scripted([
      () => { writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done", { memoryUpdates: [{ path: "notes/a.md", content: "a", expectedSHA256: null, reason: "r" }] }); },
      (turn) => { expect(turn.protocolOnly).toBe(true); return result("IMPLEMENTATION", "done", { status: "completed" }); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex(), memory });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state, database.getTopic(topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    expect(applied).toEqual(["notes/a.md"]);
    expect(JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!).memoryUpdates).toHaveLength(1);
    database.close();
  });
});
