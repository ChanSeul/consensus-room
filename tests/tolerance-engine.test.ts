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

describe("허용 오차 — 엔진이 리뷰 전에 git diff 로 대조한다", () => {
  it("규칙 술어를 만족하는 범위 밖 표기 변경은 원장과 함께 통과하고 Codex 프롬프트에 대조 결과가 실린다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("pass");
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "nonisolated func a() {}\nfunc b() {}\n");
        return result("IMPLEMENTATION", "구현", {
          toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "S9 소유 파일 표기 1줄" }],
          findings: [{
            id: "TODO-1", title: "FilterCategory 프로토콜 격리 재설계(소유 밖)", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE",
            rationale: "진단 x:1 · 원인 선언 service/F.swift:527 · 필요한 변경 nonisolated protocol · 권장 형태 후속 토픽",
            evidenceRefs: [], requiresUserDecision: false,
          }],
        });
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
    await waitUntil(() => database.getTimeline(topicId).some((event) => event.body.startsWith("인도 전 처분이 필요한 후속 목록")));
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.some((body) => body.startsWith("허용 오차 대조 통과 — 범위 밖 파일 1개 (T-1: 파일 1·hunk 1)"))).toBe(true);
    // 러너 to-do 는 후속 목록에 출처 implementation 으로 오르고, 인도 전 처분 안내가 한 번 뜬다.
    expect(bodies.some((body) => body.startsWith("후속 목록에 기록(이번 범위 밖, 구현 to-do): TODO-1"))).toBe(true);
    const deferred = JSON.parse((await artifacts.readLatest(topicId, "deferred-findings"))!);
    expect(deferred.findings).toMatchObject([{ id: "TODO-1", source: "implementation" }]);
    expect(bodies.some((body) => body.includes("인도 전 처분이 필요한 후속 목록 1건") && body.includes("TODO-1"))).toBe(true);
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
        return result("IMPLEMENTATION", "구현(범위 밖 변경 포함)");
      },
      correct: () => {
        writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n"); // 되돌림
        return result("IMPLEMENTATION", "범위 밖 변경을 되돌리고 to-do 로 옮겼습니다.");
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
        return result("IMPLEMENTATION", "구현(범위 밖 변경 포함)");
      },
      correct: () => {
        git(worktree, ["config", "user.name", "t"]); git(worktree, ["config", "user.email", "t@example.invalid"]);
        git(worktree, ["add", "service/S.swift"]); git(worktree, ["commit", "-m", "몰래 커밋"]);
        return result("IMPLEMENTATION", "커밋으로 숨김");
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
        return result("IMPLEMENTATION", "구현", {
          findings: [{
            id: "TODO-1", title: "범위 밖 표기", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE",
            rationale: "to-do", evidenceRefs: [], requiresUserDecision: false,
          }],
        });
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
    expect(bodies.some((body) => body.startsWith("인도 전 처분이 필요한 후속 목록"))).toBe(false);
    database.close();
  });

  it("교정 뒤에도 위반이 남으면 리뷰로 넘기지 않고 사용자 결정으로 멈춘다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("block");
    const claude = claudeAdapter(worktree, {
      implement: () => {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "nonisolated func a() {}\nnonisolated func b() {}\nnonisolated func c() {}\n");
        return result("IMPLEMENTATION", "구현", { toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "" }] });
      },
      correct: () => result("IMPLEMENTATION", "그대로 둠", { toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "" }] }),
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
describe("허용 오차 교정 뒤 계약 교정이 커밋을 만들면", () => {
  it("HEAD 재확인에 걸려 실패하고 리뷰로 넘어가지 않는다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("late-commit");
    let resumes = 0;
    const claude: AgentAdapter = {
      role: "claude",
      async createSession() {
        writeFileSync(join(worktree, "feature.txt"), "구현\n");
        writeFileSync(join(worktree, "service", "S.swift"), "func aa() {}\nfunc b() {}\n"); // 범위 밖, 술어 밖
        return { sessionId: "claude-implementation-session", result: result("IMPLEMENTATION", "구현(범위 밖 변경 포함)") };
      },
      async resumeTurn() {
        resumes += 1;
        if (resumes === 1) {
          // 허용 오차 교정: 되돌리되 kind 를 틀리게 내 계약 교정을 한 번 더 부르게 한다.
          writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n");
          return result("FIX", "되돌렸습니다(종류 틀림)");
        }
        // 계약 교정: 범위 밖 변경을 다시 넣고 커밋으로 숨긴 뒤 정상 종류로 답한다.
        writeFileSync(join(worktree, "service", "S.swift"), "func aa() {}\nfunc b() {}\n");
        git(worktree, ["config", "user.name", "t"]); git(worktree, ["config", "user.email", "t@example.invalid"]);
        git(worktree, ["add", "service/S.swift"]); git(worktree, ["commit", "-m", "교정 뒤 몰래 커밋"]);
        return result("IMPLEMENTATION", "정상 종류");
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
        return { ...result("IMPLEMENTATION", "문자열 값 변경을 표기로 위장"), toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "표기" }] };
      },
      correct: () => {
        writeFileSync(join(worktree, "service", "S.swift"), 'let text = """\nfunc a() {}\n"""\nfunc b() {}\n');
        return result("IMPLEMENTATION", "되돌렸습니다.");
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
describe("허용 오차 — 턴을 넘어 살아야 할 상태는 엔진이 든다", () => {
  function scriptedClaude(turns: Array<() => AgentResult>) {
    const prompts: string[] = [];
    let index = 0;
    const next = () => { const turn = turns[index]; if (!turn) throw new Error(`턴 ${index + 1} 을 기대하지 않았습니다.`); index += 1; return turn(); };
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { prompts.push(turn.prompt); return { sessionId: "claude-implementation-session", result: next() }; },
      async resumeTurn(turn) { prompts.push(turn.prompt); return next(); },
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
        return result("IMPLEMENTATION", "P3 완료", {
          toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "S9 소유 파일 표기 1줄" }],
          requestedUserDecision: "남은 단계 P3.5 — 계속 진행 요청",
        });
      },
      () => {
        writeFileSync(join(worktree, "feature.txt"), "구현 2\n");
        return result("IMPLEMENTATION", "P3.5 완료(원장을 비워 냈다)"); // 원장 없음 — 서버가 승계해야 한다
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
        return result("IMPLEMENTATION", "P3 완료 — 커버 A–D errors=0", {
          evidenceRefs: ["cover-A-post.log errors=0"],
          findings: [{ id: "TODO-1", title: "이연", severity: "LOW", disposition: "DEFERRED_OUT_OF_SCOPE", rationale: "범위 밖", evidenceRefs: [], requiresUserDecision: false }],
          requestedUserDecision: "남은 단계 P3.5·P3.6 — 계속 진행 요청",
        });
      },
      () => {
        writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n"); // 되돌림
        return result("IMPLEMENTATION", "범위 밖 변경을 되돌렸다(코드 변경 없음)", { evidenceRefs: ["git diff -- service/S.swift"] });
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
describe("Codex 감사 2026-09-14 — 결과 수명·진행 상태·도구 트리·원장 경계", () => {
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
        return result("IMPLEMENTATION", "본 턴 작업", { requestedUserDecision: "P4 가 남았다 — 계속 진행 요청", evidenceRefs: ["ORIGINAL-ONLY"] }); },
      () => { corrections += 1; writeFileSync(join(worktree, "service", "S.swift"), "func a() {}\nfunc b() {}\n"); throw new Error("교정 전송 실패"); },
      () => result("IMPLEMENTATION", "원장 보완만"),
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    expect(database.getTopic(topicId).state).toBe("FAILED");
    expect(await artifacts.readLatest(topicId, "tolerance-correction-source")).toContain("ORIGINAL-ONLY");
    engine.retry(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state, topic.lastError ?? "").toBe("USER_DECISION_REQUIRED");
    const bodies = database.getTimeline(topicId).map((event) => event.body);
    expect(bodies.some((body) => body.includes("보존해 둔 본 턴 보고"))).toBe(true);
    expect(bodies.some((body) => body.includes("P4 가 남았다"))).toBe(true);
    const saved = JSON.parse((await artifacts.readLatest(topicId, "implementation-result"))!);
    expect(saved.evidenceRefs).toContain("ORIGINAL-ONLY");
    expect(saved.requestedUserDecision).toBe("P4 가 남았다 — 계속 진행 요청");
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
        return result("IMPLEMENTATION", "구현", { toleranceLedger: [{ ruleId: "T-1", file: "service/S.swift", note: "x".repeat(2001) }] }); },
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
      () => { writeFileSync(join(tool, "gate.py"), "print('changed by runner')\n"); writeFileSync(join(worktree, "feature.txt"), "x\n"); return result("IMPLEMENTATION", "done"); },
    ]);
    const engine = new WorkflowEngine({ database, artifacts, git: gitService, claude: claude.adapter, codex: new PassingCodex() });
    engine.startImplementation(topicId); await settled(database, topicId);
    const topic = database.getTopic(topicId);
    expect(topic.state).toBe("FAILED");
    expect(topic.lastError ?? "").toContain("도구 트리가");
    expect(database.getTimeline(topicId).map((event) => event.body).some((body) => body.includes("러너는 앱 코드만 고친다"))).toBe(true);
    database.close();
  });

  it("D02: 구현·재개 턴은 결정·증거 원문 산출물(decisions)을 읽기 허용 경로로 받고 프롬프트가 그 경로를 안내한다", async () => {
    const { worktree, database, artifacts, gitService, topicId } = await setup("decisions");
    const seen: Array<readonly string[] | undefined> = [];
    const adapter: AgentAdapter = {
      role: "claude",
      async createSession(turn) { seen.push(turn.readablePaths); writeFileSync(join(worktree, "feature.txt"), "x\n"); return { sessionId: "s", result: result("IMPLEMENTATION", "done") }; },
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
