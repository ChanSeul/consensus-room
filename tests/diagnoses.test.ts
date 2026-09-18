// 중재자 진단(2026-09-14 진단 계획) — 공개 API 에서 시작해 실제 러너 요청과 최종 상태까지 본다(실제 git·DB·산출물, 통제 가능한 가짜 어댑터).
// 고정하는 것: 진단 등록만으로 재개·완료되지 않음 · 수정이 필요한데 확인 턴만 실행하지 않음 · 다른 질문이 사라지지 않음 · 낡은 진단은 보존하고 재확인 요구 ·
// 인도 대기의 미해결 진단은 커밋·푸시·종료를 막음 · 인도 대기 반환은 완료 판정을 취소하고 새 최종 리뷰를 거침.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

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
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const TOKEN = "launch-token-for-diagnosis-test";
const TOLERANCE_BLOCK = '\n\n```tolerance\n{"scopePaths":["**"],"rules":[]}\n```';
// 승인 범위를 feature.txt 하나로 좁힌 허용 오차 — 그 밖의 파일 변경은 위반이다.
const TIGHT_TOLERANCE = '\n\n```tolerance\n{"scopePaths":["feature.txt"],"rules":[]}\n```';
const plan = (tolerance = TOLERANCE_BLOCK) => REQUIRED_PLAN_HEADINGS.map((heading) => `## ${heading}\n\n검증할 내용${heading === "허용 오차" ? tolerance : ""}`).join("\n\n");
const git = (cwd: string, args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const result = (kind: AgentResult["kind"], summary: string, extra: Partial<AgentResult> = {}): AgentResult =>
  ({ kind, summary, findings: [], evidenceRefs: ["검증"], ...extra });
const requestIdsIn = (text: string) => [...new Set([...text.matchAll(/\[(Q-[0-9a-f]{8})\]/g)].map((match) => match[1]))];

interface ClaudeTurn { mode: "create" | "resume"; prompt: string; protocolOnly: boolean; planMode: boolean; readablePaths: readonly string[] }
type Step = (turn: ClaudeTurn) => AgentResult;

// 프로세스를 띄운 것처럼 onProcessSpawn 을 부른다 — 전달 기록(spawn 시점)을 실제 경로로 지나게 한다.
const spawned = (turn: SessionTurn) => turn.onProcessSpawn?.({ pid: 4242, pgid: 4242, executable: "fake", commandLine: "fake", startedAt: new Date().toISOString() });

class ScriptedClaude implements AgentAdapter {
  readonly role = "claude" as const;
  readonly turns: ClaudeTurn[] = [];
  constructor(private readonly steps: Step[]) {}
  async validateExistingSession() { return true; }
  private created = 0;
  // 첫 세션은 구현 세션(impl-session), 그 뒤 새 세션(일회용 개정·ACK·새 세대 계획)은 서로 다른 id — 세션 충돌 검사를 실제 경로로 지난다.
  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    this.created += 1;
    const id = this.created === 1 ? "impl-session" : `claude-s${this.created}`;
    turn.onSessionCreated?.(id);
    return { sessionId: id, result: this.next("create", turn as SessionTurn) };
  }
  async resumeTurn(turn: SessionTurn) { return this.next("resume", turn); }
  private next(mode: ClaudeTurn["mode"], turn: SessionTurn): AgentResult {
    spawned(turn);
    const recorded = { mode, prompt: turn.prompt, protocolOnly: Boolean(turn.protocolOnly), planMode: Boolean(turn.planMode), readablePaths: turn.readablePaths ?? [] };
    this.turns.push(recorded);
    const step = this.steps.shift();
    if (!step) throw new Error(`예상하지 않은 Claude 턴 #${this.turns.length}: ${turn.prompt.slice(0, 160)}`);
    return step(recorded);
  }
}

// 구현 보고의 쟁점을 빠짐없이 되돌려 담는 리뷰어. 최종 리뷰는 반영 주장(RESOLVED_BY_FIX)을 확인 처분으로 되돌려 준다.
class EchoCodex implements AgentAdapter {
  readonly role = "codex" as const;
  readonly answerConfirmations: SessionTurn[] = [];
  readonly answerHandlers: Array<(input: { requests: Array<{ id: string; sequence: number; question: string }>; decisions: Array<{ sequence: number; body: string }> }) => NonNullable<AgentResult["reviewDecisionAnswers"]> | Promise<NonNullable<AgentResult["reviewDecisionAnswers"]>>> = [];
  readonly prompts: string[] = [];
  readonly readable: Array<readonly string[]> = [];
  async validateExistingSession() { return true; }
  async createSession(turn: Omit<SessionTurn, "sessionId">) {
    return { sessionId: "codex-review", result: await this.resumeTurn({ ...turn, sessionId: "codex-review" } as SessionTurn) };
  }
  async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    spawned(turn);
    this.prompts.push(turn.prompt);
    this.readable.push(turn.readablePaths ?? []);
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

// 계획 수렴(감사·종결·ACK)까지 답하는 Codex — 감사는 Claude 계획의 쟁점을 판단이 끝난 것으로 처분하고, 종결·ACK 는 프롬프트의 SHA 를 돌려준다.
class PlanningCodex extends EchoCodex {
  private created = 0;
  override async createSession(turn: Omit<SessionTurn, "sessionId">) {
    this.created += 1;
    const id = `codex-s${this.created}`;
    return { sessionId: id, result: await this.resumeTurn({ ...turn, sessionId: id } as SessionTurn) };
  }
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const prompt = turn.prompt;
    const record = () => { spawned(turn); this.prompts.push(prompt); this.readable.push(turn.readablePaths ?? []); };
    if (prompt.includes("반환 kind는 AUDIT")) {
      record();
      const marker = "Claude가 계획과 함께 기록한 쟁점:\n";
      const after = prompt.slice(prompt.indexOf(marker) + marker.length);
      const claudeFindings = JSON.parse(after.startsWith("[]") ? "[]" : after.slice(0, after.indexOf("\n]") + 2)) as Finding[];
      return result("AUDIT", "감사했습니다.", {
        findings: claudeFindings.map((finding) => ({ ...finding, disposition: "AGREED_NO_ACTION" as const, rationale: "개정 계획이 진단을 반영했습니다." })),
      });
    }
    if (prompt.includes("반환 kind는 CLOSEOUT")) {
      record();
      return result("CLOSEOUT", "의견 수렴을 종료합니다.", { planSHA256: /개정 계획 SHA-256: ([0-9a-f]{64})/.exec(prompt)?.[1] });
    }
    if (prompt.includes("프로토콜 확인 단계입니다")) {
      record();
      return result("ACK", "해시 확인", { planSHA256: /서버가 계산한 SHA-256: ([0-9a-f]{64})/.exec(prompt)?.[1] });
    }
    return super.resumeTurn(turn);
  }
}

// 종결마다 새 필수(HIGH) 쟁점을 내는 Codex — 개정 2회차 뒤에도 남아 필수 쟁점 잔존 인터럽트(REPLAN 결정의 전제)를 만든다.
class EssentialCloseoutCodex extends PlanningCodex {
  private closeouts = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    if (!turn.prompt.includes("반환 kind는 CLOSEOUT")) return super.resumeTurn(turn);
    spawned(turn);
    this.prompts.push(turn.prompt);
    this.readable.push(turn.readablePaths ?? []);
    this.closeouts += 1;
    const essential = (id: string): Finding => ({
      id, title: `배포 전제 누락 ${id}`, severity: "HIGH", disposition: "AGREED_ACTION", rationale: "배포 전제가 계획에 없습니다.", evidenceRefs: [], requiresUserDecision: false,
    });
    const findings: Finding[] = this.closeouts === 1
      ? [essential("C-1")]
      : [{ ...essential("C-1"), disposition: "AGREED_NO_ACTION", rationale: "개정 2회차가 반영했습니다." }, essential(`C-${this.closeouts}`)];
    return result("CLOSEOUT", "필수 쟁점이 남았습니다.", { planSHA256: /개정 계획 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1], findings });
  }
}

// 첫 리뷰가 프로세스 시작 뒤 한 번 죽는 Codex — 리뷰 정지(FAILED, 재개 CODEX_REVIEW)를 만든다.
class FlakyCodex extends EchoCodex {
  private failures = 1;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    if (this.failures > 0) {
      this.failures -= 1;
      spawned(turn);
      throw new Error("리뷰 프로세스 비정상 종료");
    }
    return super.resumeTurn(turn);
  }
}

// 계획 감사를 한 번 거친 뒤(범위 변경으로 새 세대 계획을 수렴한 뒤) 첫 리뷰에 새 필수 쟁점 F-1(AGREED_ACTION)을 더하는 Codex —
// 새 세대에서 일반 수정 작업(runFix, 재개 CLAUDE_FIX)을 연다. 이전 세대의 리뷰와 모든 최종 리뷰는 EchoCodex 그대로다.
class ScopeFindingCodex extends PlanningCodex {
  private audited = false;
  private raised = false;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    if (turn.prompt.includes("반환 kind는 AUDIT")) this.audited = true;
    const reply = await super.resumeTurn(turn);
    if (!this.audited || this.raised || reply.kind !== "REVIEW") return reply;
    this.raised = true;
    const defect: Finding = {
      id: "F-1", title: "새 범위 결함", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "새 범위 구현에 고쳐야 할 결함이 있습니다.", evidenceRefs: [], requiresUserDecision: false,
    };
    return { ...reply, summary: "고쳐야 할 결함이 있습니다.", findings: [...reply.findings, defect] };
  }
}

// 최종 리뷰 정지에서 새로 나오는 쟁점 — 수정 합의(AGREED_ACTION)지만 사용자 판정이 필요하다(2026-09-15 감사 #8).
const FINAL_REVIEW_DECISION_FINDING: Finding = {
  id: "F-2", title: "로그 경로 결함", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "로그 경로 결함 — 사용자 판정이 필요합니다.",
  evidenceRefs: [], requiresUserDecision: true,
};

// 첫 최종 리뷰에서만 새 쟁점 F-2 를 더하는 Codex — 반영 확인과 함께 최종 리뷰 정지(USER_DECISION_REQUIRED, 재개 CODEX_FINAL_REVIEW)를 만든다.
// 그 뒤의 최종 리뷰는 EchoCodex 처럼 보고를 되돌려 준다.
class FinalReviewDecisionCodex extends EchoCodex {
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    return this.finals === 1 ? { ...review, findings: [...review.findings, FINAL_REVIEW_DECISION_FINDING] } : review;
  }
}

// 첫 리뷰가 확정 결함 F-1(수정 합의)을 내 일반 수정(리뷰 수정 계약)을 열고, 첫 최종 리뷰가 새 쟁점 F-2(수정 합의 + 사용자 판정 필요)로 멈추는 Codex
// (2026-09-15 감사 2차 #4). 그 뒤의 최종 리뷰는 "판단이 끝난 쟁점은 되돌려 적지 않아도 된다"는 프롬프트 계약대로 F-2 를 적지 않고 F-1 반영만 확인한다.
// 서버 기계 검사가 누락을 거부해 교정을 요구하면 F-2 를 판정 필요인 채(AGREED_ACTION + requiresUserDecision) 다시 낸다 — 리뷰어가 F-2 를 미결로 유지한다.
const REVIEW_FIX_FINDING: Finding = {
  id: "F-1", title: "첫 리뷰 결함", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "고쳐야 할 결함입니다.", evidenceRefs: [], requiresUserDecision: false,
};
const STOP_FINDING_KEPT_UNDECIDED = "F-2 로그 경로 결함은 여전히 사용자 판정이 필요합니다.";

class ReviewFixFinalStopCodex extends EchoCodex {
  private reviews = 0;
  private finals = 0;
  private lastFinal: AgentResult | null = null;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    if (turn.prompt.includes("서버 기계 검사가 방금 응답을 거부했습니다") && this.lastFinal) {
      spawned(turn);
      this.prompts.push(turn.prompt);
      this.readable.push(turn.readablePaths ?? []);
      const kept: Finding = { ...FINAL_REVIEW_DECISION_FINDING, rationale: STOP_FINDING_KEPT_UNDECIDED };
      return { ...this.lastFinal, findings: [...this.lastFinal.findings.filter((finding) => finding.id !== "F-2"), kept] };
    }
    const review = await super.resumeTurn(turn);
    if (review.kind === "REVIEW") {
      this.reviews += 1;
      return this.reviews === 1 ? { ...review, summary: "고쳐야 할 결함이 있습니다.", findings: [...review.findings, REVIEW_FIX_FINDING] } : review;
    }
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    if (this.finals === 1) return { ...review, findings: [...review.findings, FINAL_REVIEW_DECISION_FINDING] };
    const findings = review.findings.filter((finding) => finding.id !== "F-2");
    if (!findings.some((finding) => finding.id === "F-1")) findings.push({ ...REVIEW_FIX_FINDING, disposition: "RESOLVED_BY_FIX", rationale: "F-1 수정을 확인했습니다." });
    this.lastFinal = { ...review, findings };
    return this.lastFinal;
  }
}

// 리뷰 프롬프트가 싣는 대조 보고("Claude 구현 보고")를 꺼낸다.
const reviewReportIn = (prompt: string): AgentResult => {
  const marker = "Claude 구현 보고:\n";
  const start = prompt.indexOf(marker) + marker.length;
  return JSON.parse(prompt.slice(start, prompt.indexOf("\n\n", start))) as AgentResult;
};

// 사용자가 판정한 대로 최종 리뷰 정지 쟁점 F-2 를 수정 불필요로 처분한 러너 보고(2026-09-15 감사 2차 #1).
const F2_DECIDED_NO_ACTION: Finding = {
  ...FINAL_REVIEW_DECISION_FINDING, disposition: "AGREED_NO_ACTION", requiresUserDecision: false, rationale: "사용자 결정대로 F-2 는 수정하지 않습니다.",
};

// 첫 최종 리뷰에서만 반영 보고된 진단 DG-1 을 되돌리는 Codex — 검증 기준 불충족으로 AGREED_ACTION + 사용자 판정 필요로 판정해 최종 리뷰 정지
// (USER_DECISION_REQUIRED, 재개 CODEX_FINAL_REVIEW)를 만든다. 그 뒤의 최종 리뷰는 EchoCodex 처럼 보고를 되돌려 준다(2026-09-15 감사 2차 #3).
const DIAGNOSIS_FINAL_VERDICT = "DG-1 수정이 검증 기준을 만족하지 않습니다 — 사용자 판정이 필요합니다.";
class DiagnosisVerdictFinalCodex extends EchoCodex {
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    if (this.finals !== 1) return review;
    return {
      ...review, summary: "DG-1 반영이 불충분합니다.",
      findings: review.findings.map((finding) => finding.id === "DG-1"
        ? { ...finding, disposition: "AGREED_ACTION" as const, requiresUserDecision: true, rationale: DIAGNOSIS_FINAL_VERDICT } : finding),
    };
  }
}

// 첫 리뷰에서만 반영 보고된 진단 DG-1 을 수정 합의(AGREED_ACTION)로 되돌리는 Codex — 리뷰 수정 작업(리뷰 경로 계약, 재개 CLAUDE_FIX)을 연다.
// 그 뒤의 리뷰·최종 리뷰는 EchoCodex 그대로다(2026-09-15 감사 2차 #13).
class DiagnosisKeptActionReviewCodex extends EchoCodex {
  private reviews = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "REVIEW") return review;
    this.reviews += 1;
    if (this.reviews !== 1) return review;
    return {
      ...review, summary: "DG-1 반영 근거가 부족합니다.",
      findings: review.findings.map((finding) => finding.id === "DG-1"
        ? { ...finding, disposition: "AGREED_ACTION" as const, rationale: "반영 근거 부족 — 게이트 로그로 입증하세요." } : finding),
    };
  }
}

// 최종 리뷰가 새로 내는 확정 결함 — 수정 합의(AGREED_ACTION)이고 사용자 판정은 필요 없다(2026-09-15 감사 2차 #6~#8).
const FINAL_REVIEW_DEFECT_FINDING: Finding = {
  id: "F-9", title: "최종 리뷰 신규 결함", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "F-9 최종 리뷰가 찾은 결함 — 고쳐야 합니다.",
  evidenceRefs: [], requiresUserDecision: false,
};

// 첫 최종 리뷰에서만 확정 결함 F-9 를 더하는 Codex — runReview(final) 가 그 최종 리뷰를 원본으로 한 일반 수정 작업(재개 CLAUDE_FIX)을 곧장 연다.
// 그 뒤의 최종 리뷰는 EchoCodex 처럼 보고를 되돌려 준다.
class FinalReviewDefectCodex extends EchoCodex {
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    return this.finals === 1 ? { ...review, findings: [...review.findings, FINAL_REVIEW_DEFECT_FINDING] } : review;
  }
}

// 리뷰가 고치기로 합의한 결함 — 첫 리뷰(REVIEW)에서만 나와 리뷰 수정 작업(runFix, 재개 CLAUDE_FIX)을 연다(2026-09-15 감사 2차 #10).
const REVIEW_DEFECT_FINDING: Finding = {
  id: "F-1", title: "첫 리뷰 결함", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "첫 리뷰 결함 — 고쳐야 합니다.", evidenceRefs: [], requiresUserDecision: false,
};

// 첫 리뷰에서만 REVIEW_DEFECT_FINDING 을 더하는 Codex — 그 뒤 리뷰와 모든 최종 리뷰는 EchoCodex 그대로다.
class ReviewDefectCodex extends EchoCodex {
  private reviews = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "REVIEW") return review;
    this.reviews += 1;
    return this.reviews === 1 ? { ...review, summary: "고쳐야 할 결함이 있습니다.", findings: [...review.findings, REVIEW_DEFECT_FINDING] } : review;
  }
}

// 계획 수렴(감사·종결·ACK)에 답하면서 첫 최종 리뷰에서만 F-2(수정 합의 + 사용자 판정 필요)를 더하는 Codex — 최종 리뷰 정지 뒤 진단 계획 개정을
// 거치는 흐름을 만든다(2026-09-15 감사 3차 #12). 그 뒤의 최종 리뷰는 EchoCodex 처럼 보고를 되돌려 준다.
class PlanningFinalDecisionCodex extends PlanningCodex {
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    return this.finals === 1 ? { ...review, findings: [...review.findings, FINAL_REVIEW_DECISION_FINDING] } : review;
  }
}

async function waitFor(predicate: () => boolean, label: string, timeout = 15_000, describe: () => string = () => ""): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`시간 초과: ${label}${describe() ? `\n${describe()}` : ""}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function room(label: string, steps: Step[], options: { autonomy?: "on" | "off"; codex?: "echo" | "planning" | "flaky" | "essential-closeout" | "scope-finding" | "final-review-decision" | "review-fix-final-stop" | "final-diagnosis-verdict" | "review-keeps-diagnosis" | "final-review-defect" | "review-defect" | "planning-final-decision"; tolerance?: string; codexInstance?: EchoCodex } = {}) {
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
  const markdown = plan(options.tolerance);
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
  const codex = options.codexInstance ?? (options.codex === "planning" ? new PlanningCodex() : options.codex === "essential-closeout" ? new EssentialCloseoutCodex()
    : options.codex === "flaky" ? new FlakyCodex() : options.codex === "scope-finding" ? new ScopeFindingCodex()
    : options.codex === "final-review-decision" ? new FinalReviewDecisionCodex()
    : options.codex === "review-fix-final-stop" ? new ReviewFixFinalStopCodex()
    : options.codex === "final-diagnosis-verdict" ? new DiagnosisVerdictFinalCodex()
    : options.codex === "review-keeps-diagnosis" ? new DiagnosisKeptActionReviewCodex()
    : options.codex === "final-review-defect" ? new FinalReviewDefectCodex()
    : options.codex === "review-defect" ? new ReviewDefectCodex()
    : options.codex === "planning-final-decision" ? new PlanningFinalDecisionCodex() : new EchoCodex());
  const codeReviewTurn = codex.resumeTurn.bind(codex);
  codex.resumeTurn = async (turn) => {
    if (!turn.prompt.includes("REVIEW_ANSWER_INPUT\n")) return codeReviewTurn(turn);
    spawned(turn);
    codex.answerConfirmations.push(turn);
    const input = JSON.parse(turn.prompt.split("REVIEW_ANSWER_INPUT\n")[1].split("\nEND_REVIEW_ANSWER_INPUT")[0]);
    const handler = codex.answerHandlers.shift();
    // 정상 fixture 의 답변이다. 거부 사례는 테스트가 부분·빈·잘못된 확인 결과를 명시한다.
    const answers = handler ? await handler(input) : input.requests.map((request: { id: string }) => ({ requestId: request.id, decisionSequence: input.decisions.at(-1).sequence }));
    return result("REVIEW", "질문 답변 확인", { status: "completed", reviewDecisionAnswers: answers });
  };
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

// 계획 변경이 필요한 진단 — 승인 범위에 단계와 검증 기준을 더해야 한다.
function planDiagnosis(extra: Record<string, unknown> = {}) {
  return fixDiagnosis({
    title: "계획 변경: witness 감사 단계 추가", planChange: { required: true, reason: "승인 계획에 없는 감사 단계와 검증 기준이 필요합니다." }, ...extra,
  });
}

const ackWith = (turn: ClaudeTurn) => result("ACK", "해시 확인", { planSHA256: /서버가 계산한 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1] });

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

// 감사 2차 K1~K3 공통 전제: 구현 → 인도 대기(첫 리뷰 쟁점 0건, 자동 수정 회차 미사용) → DG-1 진단 전용 수정이 반영 보고(fix_reported)로 수락 →
// 최종 리뷰 #1 이 확정 결함 F-9 를 내 그 리뷰를 원본으로 한 일반 수정 작업을 연다 → 그 수정 턴이 응답 전에 죽는다(FAILED, 재개 CLAUDE_FIX).
async function stoppedFinalReviewFix(label: string) {
  const r = await room(label, [], { codex: "final-review-defect" });
  let stoppedFixPrompt = "";
  r.claude["steps"].push(
    () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
    () => {
      writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n");
      return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
    },
    (turn) => { stoppedFixPrompt = turn.prompt; throw new Error("일반 수정 턴 프로세스 비정상 종료"); },
  );
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
  await r.idle("READY_TO_DELIVER");
  expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-review")) ?? "{}") as AgentResult).findings).toEqual([]);
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
  await r.idle("FAILED");
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
  expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
  expect(r.claude.turns).toHaveLength(3);
  expect(r.codex.prompts.map((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toEqual([false, true]);
  expect(stoppedFixPrompt).toContain('"id": "F-9"');
  expect((await r.diagnoses()).map((record) => record.history.map((entry) => entry.status))).toEqual([["registered", "applied", "delivered", "fix_reported"]]);
  return r;
}

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
    // 리뷰어는 진단 원문(지시·검증 기준)과 원문 파일 읽기 권한을 함께 받는다(host-review R4).
    expect(r.codex.prompts[0]).toContain("중재자 진단 원문");
    expect(r.codex.prompts[0]).toContain("검증 기준: 1) 게이트 2 F1 재실행 green");
    const reviewOriginal = /원문: `([^`]+)`/.exec(r.codex.prompts[0])?.[1];
    expect(reviewOriginal).toBeTruthy();
    expect(r.codex.readable[0]).toContain(reviewOriginal);
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

// ---- 2026-09-15 감사 3차 #2·#3·#7 회귀 테스트 공용 ----

// 멈춤 상태(인도 대기·결정 대기·실패·증거 대기) 중 하나에 실행 없이 머물 때까지 기다린다 — 어느 상태로 멈췄는지 자체를 단언한다.
async function settledState(r: Awaited<ReturnType<typeof room>>, label: string): Promise<string> {
  const stops = ["READY_TO_DELIVER", "USER_DECISION_REQUIRED", "FAILED", "BLOCKED_ON_EVIDENCE"];
  await waitFor(() => r.database.runningAction(r.topicId) === null && stops.includes(r.database.getTopic(r.topicId).state), `${label} → 멈춤`);
  return r.database.getTopic(r.topicId).state;
}

// 최종 리뷰 프롬프트가 싣는 "…수정 작업의 원본 쟁점" 절의 쟁점 — 절이 없으면 null.
const contractSourceIn = (prompt: string): Finding[] | null => {
  const at = prompt.indexOf("수정 작업의 원본 쟁점");
  if (at < 0) return null;
  const start = prompt.indexOf(":\n[", at) + 2;
  return JSON.parse(prompt.slice(start, prompt.indexOf("\n]", start) + 2)) as Finding[];
};

// 수정 턴 프롬프트의 "수정 대상" 쟁점.
const fixTargetsIn = (prompt: string): Finding[] => {
  const marker = "수정 대상:\n";
  const start = prompt.indexOf(marker) + marker.length;
  return JSON.parse(prompt.slice(start, prompt.indexOf("\n\n", start))) as Finding[];
};

// 감사 3차 #2: 첫 리뷰는 F-2 를 경미(수정 불필요, settled)로 닫고, 최종 리뷰 #1 은 같은 id F-2 를 수정 합의 + 사용자 판정 필요로 재판정해 멈춘다(정지 쟁점).
// 그 뒤 최종 리뷰는 F-2 를 생략하거나(omit) 첫 리뷰 처분 그대로 수정 불필요로 되돌려 적는다(explicit). 누락 교정 요청에는 F-2 를 판정 필요인 채 다시 낸다.
const SHADOWED_F2_SETTLED: Finding = {
  id: "F-2", title: "로그 경로 처리", severity: "MEDIUM", disposition: "AGREED_NO_ACTION", rationale: "첫 리뷰: 경미 — 수정 불필요.", evidenceRefs: [], requiresUserDecision: false,
};
const SHADOWED_F2_VERDICT = "최종 리뷰 재판정: F-2 는 데이터 유실 위험 — 수정 여부에 사용자 판정이 필요합니다.";
const SHADOWED_F2_STOP: Finding = { ...SHADOWED_F2_SETTLED, severity: "HIGH", disposition: "AGREED_ACTION", requiresUserDecision: true, rationale: SHADOWED_F2_VERDICT };
const SHADOWED_F2_KEPT = "F-2 데이터 유실 위험은 여전히 사용자 판정이 필요합니다.";
class ShadowedStopVerdictCodex extends EchoCodex {
  private reviews = 0;
  private finals = 0;
  private lastFinal: AgentResult | null = null;
  constructor(private readonly second: "omit" | "explicit") { super(); }
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    if (turn.prompt.includes("서버 기계 검사가 방금 응답을 거부했습니다") && this.lastFinal) {
      spawned(turn);
      this.prompts.push(turn.prompt);
      this.readable.push(turn.readablePaths ?? []);
      return { ...this.lastFinal, findings: [...this.lastFinal.findings.filter((finding) => finding.id !== "F-2"), { ...SHADOWED_F2_STOP, rationale: SHADOWED_F2_KEPT }] };
    }
    const review = await super.resumeTurn(turn);
    if (review.kind === "REVIEW") {
      this.reviews += 1;
      return this.reviews === 1 ? { ...review, findings: [...review.findings, SHADOWED_F2_SETTLED] } : review;
    }
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    const others = review.findings.filter((finding) => finding.id !== "F-2");
    if (this.finals === 1) return { ...review, findings: [...others, SHADOWED_F2_STOP] };
    this.lastFinal = this.second === "omit" ? { ...review, findings: others }
      : { ...review, findings: [...others, { ...SHADOWED_F2_SETTLED, rationale: "최종 리뷰 #2: 경미 — 수정 불필요." }] };
    return this.lastFinal;
  }
}

// 감사 3차 #2 공통 전제: 구현 → 첫 리뷰 F-2 settled → 인도 대기 → DG-1 진단 전용 수정(수락) → 최종 리뷰 #1 이 F-2 를 정지 쟁점으로 재판정해 멈춤 →
// DG-2 진단 전용 수정(원본 = 정지 쟁점 F-2) 턴이 spawn 뒤 죽음 → DG-2 를 수정 불필요로 정정(계약 종결, 재개 = 최종 리뷰) → retry. 사용자 결정은 없다.
async function shadowedStopRetry(label: string, second: "omit" | "explicit") {
  const r = await room(label, [], { codexInstance: new ShadowedStopVerdictCodex(second) });
  r.claude["steps"].push(
    () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
    () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
    () => { throw new Error("진단 수정 턴 프로세스 비정상 종료"); },
  );
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
  await r.idle("READY_TO_DELIVER");
  expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-review"))!) as AgentResult).findings.map((finding) => [finding.id, finding.disposition]))
    .toEqual([["F-2", "AGREED_NO_ACTION"]]);
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
  await r.idle("USER_DECISION_REQUIRED");
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
  expect(r.database.getTopic(r.topicId).lastError).toContain(SHADOWED_F2_VERDICT);
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "다른 외부 검증 실패" }), { mediator: true })).status).toBe(201);
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
  await r.idle("FAILED");
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
  expect(r.claude.turns).toHaveLength(3);
  expect(r.claude.turns[2].prompt).toContain('"id": "F-2"');
  const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
    fixDiagnosis({ kind: "no_action", title: "DG-2 는 외부 원인 — 수정 불필요", supersedes: "DG-2" }), { mediator: true });
  expect(closed.status).toBe(201);
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
  const codexBefore = r.codex.prompts.length;
  const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
  const settled = await settledState(r, label);
  const finals = r.codex.prompts.slice(codexBefore)
    .filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW") && !prompt.includes("서버 기계 검사가 방금 응답을 거부했습니다"));
  return { r, settled, finals, retrySequence };
}

// 감사 3차 #3: 최종 리뷰 #1 에서만 해결된 진단 DG-1 을 회귀(수정 합의, HIGH)로 판정하는 Codex — 그 뒤 최종 리뷰는 EchoCodex 그대로다.
const REGRESSED_DG1_VERDICT = "DG-2 수정이 DG-1 반영(mergeTag nonisolated)을 되돌렸습니다 — 다시 고쳐야 합니다.";
const REGRESSED_DG1: Finding = {
  id: "DG-1", title: "중재자 진단: DG-1 반영 회귀", severity: "HIGH", disposition: "AGREED_ACTION", rationale: REGRESSED_DG1_VERDICT,
  evidenceRefs: ["feature.txt:1"], requiresUserDecision: false,
};
class RegressionVerdictFinalCodex extends EchoCodex {
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    return this.finals === 1 ? { ...review, findings: [...review.findings.filter((finding) => finding.id !== "DG-1"), REGRESSED_DG1] } : review;
  }
}

// 감사 3차 #7: 첫 리뷰가 확정 결함 F-1(수정 합의)과 사용자 판정 쟁점 F-3 을 함께 내 리뷰 정지(USER_DECISION_REQUIRED, 재개 CODEX_REVIEW)를 만드는 Codex.
// 그 뒤 리뷰·최종 리뷰는 EchoCodex 그대로다.
const DEMANDED_F1: Finding = {
  id: "F-1", title: "캐시 무효화 누락", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "고쳐야 합니다.", evidenceRefs: [], requiresUserDecision: false,
};
const CHANNEL_F3: Finding = {
  id: "F-3", title: "배포 채널", severity: "MEDIUM", disposition: "AGREED_NO_ACTION", rationale: "채널 A/B 중 사용자 판정 필요", evidenceRefs: [], requiresUserDecision: true,
};
class FixAndChannelReviewCodex extends EchoCodex {
  private reviews = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "REVIEW") return review;
    this.reviews += 1;
    return this.reviews === 1 ? { ...review, findings: [...review.findings, DEMANDED_F1, CHANNEL_F3] } : review;
  }
}

// 감사 3차 #7 공통 전제: 구현 → 첫 리뷰 F-1·F-3 으로 멈춤 → 사용자 결정 → retry(저장된 리뷰로 리뷰 수정 작업) → 러너가 F-1 을 수정 불필요로 내린다.
async function downgradeAfterDecision(label: string, decision: string) {
  const r = await room(label, [], { codexInstance: new FixAndChannelReviewCodex() });
  r.claude["steps"].push(
    () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
    () => result("FIX", "F-1 은 고치지 않겠습니다.", {
      status: "completed", findings: [
        { ...DEMANDED_F1, disposition: "AGREED_NO_ACTION", rationale: "F-1 은 영향이 없어 고치지 않습니다." },
        { ...CHANNEL_F3, requiresUserDecision: false, rationale: "사용자 결정대로 채널 A." },
      ],
    }),
  );
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
  await r.idle("USER_DECISION_REQUIRED");
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_REVIEW");
  expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: decision })).status).toBe(200);
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
  return { r, settled: await settledState(r, label) };
}

// 계약 도입 전(구 엔진) 토픽 흉내 — 계약 행을 지우고, 마지막 checkpoint 의 작업 id 를 옛 엔진이 적던 형식으로 되돌린다(진단 전용 수정
// `diagnosis#<id+id>` — b08210b delivery.ts:1183, 리뷰 수정 `<리뷰 종류>#<revision>` — 같은 파일 fixSource()). 행만 지우면 새 엔진이 적은 계약 id(FC-n)의
// checkpoint 가 계약 없이 남는다 — 운영에서 생기지 않는 상태라 그 위의 동작은 회귀의 근거가 되지 않는다(2026-09-15 감사 3차 회귀 테스트).
async function legacyTopic(r: Awaited<ReturnType<typeof room>>) {
  const topic = r.database.getTopic(r.topicId);
  const legacyIds = new Map(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId,
    contract.route === "diagnosis" ? `diagnosis#${contract.diagnosisIds.join("+")}` : `${contract.origin.review?.kind}#${contract.origin.review?.revision}`]));
  const raw = Object.values(r.database as unknown as Record<string, unknown>)
    .find((v) => v && typeof (v as { exec?: unknown }).exec === "function" && typeof (v as { prepare?: unknown }).prepare === "function") as { exec(sql: string): void };
  raw.exec("DELETE FROM fix_contracts");
  const latest = r.database.latestArtifact(r.topicId, "work-checkpoint");
  if (!latest) return;
  const checkpoint = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint")) ?? "{}") as { work: { kind: string; fixSource?: string } };
  const legacy = checkpoint.work.fixSource ? legacyIds.get(checkpoint.work.fixSource) : undefined;
  if (legacy) {
    await r.artifacts.write(r.topicId, "work-checkpoint", latest.revision + 1, JSON.stringify({ ...checkpoint, work: { ...checkpoint.work, fixSource: legacy } }, null, 2));
  }
}

// 감사 3차 #4·#6 공통 전제: 구현 → 인도 대기 → DG-1 진단 전용 수정 적용 → 러너가 DG-1 을 반박(REFUTED) → USER_DECISION_REQUIRED(재개 CLAUDE_FIX), DG-1 refuted.
async function refutedDiagnosisFixStop(label: string) {
  const r = await room(label, []);
  r.claude["steps"].push(
    () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
    () => result("FIX", "진단이 틀렸습니다.", {
      status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "외부 검증 실패는 이 변경과 무관합니다." }],
    }),
  );
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
  await r.idle("READY_TO_DELIVER");
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
  expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
  await r.idle("USER_DECISION_REQUIRED");
  expect((await r.diagnoses()).map((record) => record.status)).toEqual(["refuted"]);
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
  expect(r.claude.turns).toHaveLength(2);
  return r;
}

// 감사 4차 #4·#5·#8 공통 전제(작업 주기 경계): 구현 → 인도 대기 → DG-1 진단 전용 수정 수락(FC-1, 'DG-1 반영') → 최종 리뷰 #1 이 F-2(수정 합의 + 사용자 판정
// 필요)로 멈춤 → DG-2 진단 전용 수정을 러너가 반박 → DG-3(계획 변경, DG-2 정정) 개정 저장·감사·ACK → 승인 → 개정 계획 구현('개정 계획대로 구현했습니다.', DG-3) →
// 첫 리뷰 통과 → 인도 대기. 최신 최종 리뷰(F-2 정지)와 수락 계약 FC-1 은 모두 개정 계획의 구현 결과보다 앞선다(이전 작업 주기).
// 이 fixture 는 사용자 결정 뒤 러너가 승계된 요청 하나의 해소를 확인한다.
function resolvePromptRequest(turn: ClaudeTurn): Pick<AgentResult, "resolvesRequestedDecision" | "resolvedRequestId"> {
  const ids = requestIdsIn(turn.prompt);
  expect(ids).toHaveLength(1);
  return { resolvesRequestedDecision: true, resolvedRequestId: ids[0] };
}

async function revisedCycleReady(label: string) {
  const r = await room(label, [], { codex: "planning-final-decision" });
  r.claude["steps"].push(
    () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
    () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
    () => result("FIX", "DG-2 는 틀렸습니다.", { status: "completed", findings: [{ ...resolved("DG-2"), disposition: "REFUTED", rationale: "원인이 다릅니다." }, FINAL_REVIEW_DECISION_FINDING] }),
    (turn) => {
      const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
      return result("REVISION", "진단을 계획에 반영했습니다.", {
        planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: "진단 DG-3: 감사 단계를 추가한다.\n" }] },
        findings: [{ id: "DG-3", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 반영", evidenceRefs: [], requiresUserDecision: false }],
      });
    },
    () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
    ackWith,
    (turn) => { writeFileSync(join(r.worktree, "feature.txt"), "개정 계획 구현\n"); return result("IMPLEMENTATION", "개정 계획대로 구현했습니다.", { status: "completed", ...resolvePromptRequest(turn), findings: [resolved("DG-3")] }); },
  );
  const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
  const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
  expect(await g6aSettleWithGrants(r, "개정 구현 추가 승인")).toBe("READY_TO_DELIVER");
  expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
  expect((await apply("DG-1")).status).toBe(200);
  await r.idle("USER_DECISION_REQUIRED");
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
  expect(r.database.getTopic(r.topicId).lastError).toContain(FINAL_REVIEW_DECISION_FINDING.rationale);
  expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
  expect((await apply("DG-2")).status).toBe(200);
  await r.idle("USER_DECISION_REQUIRED");
  expect((await r.diagnoses()).find((record) => record.id === "DG-2")?.status).toBe("refuted");
  expect((await register(planDiagnosis({ supersedes: "DG-2" }))).status).toBe(201);
  expect((await apply("DG-3")).status).toBe(200);
  await r.idle("AWAITING_USER_APPROVAL");
  const revisedSHA = r.database.getTopic(r.topicId).planSHA256;
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: revisedSHA })).status).toBe(200);
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
  expect(await g6aSettleWithGrants(r, "개정 구현 추가 승인")).toBe("READY_TO_DELIVER");
  expect(r.claude.turns).toHaveLength(7);
  // 전제 확인: 개정 계획의 구현 결과가 최신 구현 결과이고, 수락 계약 FC-1 과 최신 최종 리뷰(F-2 정지)는 그보다 앞선다.
  const topic = r.database.getTopic(r.topicId);
  const cycleStart = r.database.latestArtifact(r.topicId, "implementation-result")!.revision;
  expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "implementation-result"))!) as AgentResult).summary).toBe("개정 계획대로 구현했습니다.");
  const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
  expect(contracts.map((contract) => [contract.contractId, contract.diagnosisIds, contract.status])).toEqual([["FC-1", ["DG-1"], "accepted"], ["FC-2", ["DG-2"], "abandoned"]]);
  expect(contracts[0].settledAfter ?? Number.POSITIVE_INFINITY).toBeLessThan(cycleStart);
  expect(r.database.latestArtifact(r.topicId, "codex-final-review")!.revision).toBeLessThan(cycleStart);
  return { r, register, apply };
}

// 구현 리뷰 한도 정지는 리뷰 1회 추가 승인(review-resume) + retry 로 넘기고, 그 밖의 멈춤 상태를 돌려준다.
async function g6aSettleWithGrants(r: Awaited<ReturnType<typeof room>>, label: string): Promise<string> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const settled = await settledState(r, label);
    if (settled !== "USER_DECISION_REQUIRED" || !(r.database.getTopic(r.topicId).lastError ?? "").includes("구현 리뷰 한도")) return settled;
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
  }
  return settledState(r, label);
}

// 감사 5차 #1: 개정 계획 구현(새 작업 주기)이 DG-1 의 수정을 덮었다 — DG-1 을 확인한 리뷰는 개정 전 최종 리뷰뿐이라 이번 주기 리뷰의 확인이 없다. DG-1 은 반영
// 보고로 열린 채 커밋을 막고(해결 기록 없음), 중재자가 정정(수정 불필요 — 개정 계획이 대체)으로 닫아야 인도한다.
async function closeRevisedAwayDG1(r: Awaited<ReturnType<typeof room>>, message: string) {
  expect((await r.diagnoses()).find((record) => record.id === "DG-1")?.status).toBe("fix_reported");
  expect(r.database.getTimeline(r.topicId).some((event) => {
    const ids = event.payload?.diagnosisUnconfirmed;
    return Array.isArray(ids) && ids.includes("DG-1");
  })).toBe(true);
  const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message, paths: ["feature.txt"] });
  expect(blocked.status).toBe(409);
  expect(JSON.stringify(blocked.body)).toContain("DG-1");
  const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
    fixDiagnosis({ kind: "no_action", title: "개정 계획 구현이 DG-1 수정을 대체", supersedes: "DG-1" }), { mediator: true });
  expect(closed.status).toBe(201);
}

// 감사 4차 #11: 점이 든 finding id — FindingSchema.id 는 임의 문자열이고 운영 산출물도 `S6.5-GATE2`·`S7P-01` 형식을 썼다.
const DOTTED_GATE_FINDING: Finding = {
  id: "S6.5-GATE2", title: "게이트 2 결함", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "고쳐야 합니다.", evidenceRefs: [], requiresUserDecision: false,
};
// 첫 리뷰가 DOTTED_GATE_FINDING(수정 합의)과 사용자 판정 쟁점 F-3 을 함께 내 리뷰 정지(USER_DECISION_REQUIRED, 재개 CODEX_REVIEW)를 만드는 Codex —
// FixAndChannelReviewCodex 에서 확정 결함의 id 형식만 바꿨다. 그 뒤 리뷰·최종 리뷰는 EchoCodex 그대로다.
class DottedIdReviewCodex extends EchoCodex {
  private reviews = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "REVIEW") return review;
    this.reviews += 1;
    return this.reviews === 1 ? { ...review, findings: [...review.findings, DOTTED_GATE_FINDING, CHANNEL_F3] } : review;
  }
}

// 감사 5차 #2·#5: 첫 최종 리뷰에서 F-2(수정 합의 + 사용자 판정 필요)를 더해 멈추고, 그 뒤 최종 리뷰는 매번 F-2 를 수정 확인 없이 수정 불필요로 닫는 Codex —
// 보고에 F-2 가 있으면(FC-2 수락 보고) 그 판을 대신하고, 없어도(무관한 계약의 보고) F-2 를 같은 처분으로 적는다(리뷰어가 판정을 유지한다).
const WITHDRAWN_F2_VERDICT = "F-2 는 수정이 필요 없다고 봅니다(수정 확인 안 함).";
class WithdrawnSourceFinalCodex extends EchoCodex {
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    if (this.finals === 1) return { ...review, findings: [...review.findings, FINAL_REVIEW_DECISION_FINDING] };
    const withdrawn: Finding = { ...FINAL_REVIEW_DECISION_FINDING, disposition: "AGREED_NO_ACTION", requiresUserDecision: false, rationale: WITHDRAWN_F2_VERDICT };
    return { ...review, findings: [...review.findings.filter((finding) => finding.id !== "F-2"), withdrawn] };
  }
}

// 감사 5차 #2·#5 공통 전제: 구현 → 첫 리뷰 쟁점 0건 → 인도 대기 → DG-1 진단 전용 수정 수락(FC-1, 인도 대기 출처) → 최종 리뷰 #A 가 F-2(수정 합의 + 사용자
// 판정 필요)로 멈춤(재개 CODEX_FINAL_REVIEW) → DG-2 진단 전용 수정(FC-2, 출처 #A, 원본 [F-2])을 러너가 DG-2·F-2 반영으로 보고해 수락 → 최종 리뷰 #B 가 F-2 를
// 수정 확인 없이 수정 불필요로 닫아 되돌림 가드로 멈춤(재개 CODEX_FINAL_REVIEW). 사용자 결정은 없다. 러너 넷째 턴(DG-3 반영, other.txt)은 호출자가 적용할 때 쓴다.
async function withdrawnSourceGuardStop(label: string) {
  const r = await room(label, [], { codexInstance: new WithdrawnSourceFinalCodex() });
  let dg3Prompt = "";
  r.claude["steps"].push(
    () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
    () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
    () => {
      writeFileSync(join(r.worktree, "feature.txt"), "DG-2·F-2 반영\n");
      return result("FIX", "DG-2·F-2 반영", {
        status: "completed",
        findings: [resolved("DG-2"), { ...FINAL_REVIEW_DECISION_FINDING, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "F-2 로그 경로를 고쳤습니다." }],
      });
    },
    (turn) => { dg3Prompt = turn.prompt; writeFileSync(join(r.worktree, "other.txt"), "DG-3 반영\n"); return result("FIX", "DG-3 반영", { status: "completed", findings: [resolved("DG-3")] }); },
  );
  const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
  const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
  expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
  await r.idle("READY_TO_DELIVER");
  expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
  expect((await apply("DG-1")).status).toBe(200);
  await r.idle("USER_DECISION_REQUIRED");
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
  expect(r.database.getTopic(r.topicId).lastError).toContain(FINAL_REVIEW_DECISION_FINDING.rationale);
  const stopA = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
  expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
  expect((await apply("DG-2")).status).toBe(200);
  await r.idle("USER_DECISION_REQUIRED");
  expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
  expect(r.database.getTopic(r.topicId).lastError).toContain("수정 확인 없이 닫았습니다(F-2)");
  const stopB = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
  expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
  return { r, register, apply, stopA, stopB, dg3Prompt: () => dg3Prompt };
}

// 감사 5차 #5 A1: 첫 리뷰가 확정 결함 F-1 을, 첫 최종 리뷰가 F-2(수정 합의 + 사용자 판정 필요)를 내고, 두 번째 최종 리뷰는 프로세스 시작 뒤 죽는 Codex —
// 정지 #F1 을 원본으로 연 리뷰 수정 계약(FC-2)이 수락된 뒤 FAILED(재개 CODEX_FINAL_REVIEW)를 만든다. 그 밖의 턴은 EchoCodex 그대로다.
class ConsumedFinalStopCodex extends EchoCodex {
  private reviews = 0;
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    if (turn.prompt.includes("반환 kind는 FINAL_REVIEW")) {
      this.finals += 1;
      if (this.finals === 2) {
        spawned(turn);
        this.prompts.push(turn.prompt);
        this.readable.push(turn.readablePaths ?? []);
        throw new Error("최종 리뷰 프로세스 비정상 종료");
      }
    }
    const review = await super.resumeTurn(turn);
    if (review.kind === "REVIEW") {
      this.reviews += 1;
      return this.reviews === 1 ? { ...review, summary: "고쳐야 할 결함이 있습니다.", findings: [...review.findings, REVIEW_FIX_FINDING] } : review;
    }
    return review.kind === "FINAL_REVIEW" && this.finals === 1 ? { ...review, findings: [...review.findings, FINAL_REVIEW_DECISION_FINDING] } : review;
  }
}

// 감사 5차 #5 A2: 첫 최종 리뷰에서만 참고 쟁점 F-8(INFO 수정 합의 — 수정 회차 대상이 아니라 통과한다)을 더하는 Codex. 그 뒤 리뷰는 EchoCodex 그대로다.
const PASSING_INFO_F8: Finding = {
  id: "F-8", title: "참고 사항", severity: "INFO", disposition: "AGREED_ACTION", rationale: "INFO — 조치 대상 아님(참고).", evidenceRefs: [], requiresUserDecision: false,
};
class PassingInfoFinalReviewCodex extends EchoCodex {
  private finals = 0;
  override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const review = await super.resumeTurn(turn);
    if (review.kind !== "FINAL_REVIEW") return review;
    this.finals += 1;
    return this.finals === 1 ? { ...review, findings: [...review.findings, PASSING_INFO_F8] } : review;
  }
}

describe("중재자 진단 — 작업을 보존하는 계획 개정(2단계)과 복구 경로", () => {
  it("계획 변경 진단은 미커밋 코드·구현 기준·브랜치·세션을 보존한 채 계획을 개정하고, 새 계획 승인 전에는 실행하지 않으며 이전 승인을 재사용하지 않는다", { timeout: 60_000 }, async () => {
    let openId = "";
    const revisedLine = "진단 DG-1: 클러스터 전략 witness 를 nonisolated 로 바꾸는 단계와 감사 단계를 추가한다.";
    const r = await room("plan-revision", [], { codex: "planning" });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      // 진단 계획 개정 1차 — 프로세스가 뜬 뒤 죽는다(인프라). retry 는 전체 재계획이 아니라 이 개정 턴을 다시 연다.
      (turn) => { expect(turn.prompt).toContain("[DG-1]"); throw new Error("개정 턴 일시 장애"); },
      (turn) => {
        expect(turn.planMode).toBe(true);
        expect(turn.prompt).toContain("승인된 계획의 변경");
        expect(turn.prompt).toContain("[DG-1]");
        expect(turn.prompt).toContain("계획 변경: 필요");
        expect(turn.prompt).toContain("feature.txt");
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: `${revisedLine}\n` }] },
          findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 단계와 검증 기준을 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      // 감사 답변 개정(무변경) — 감사가 DG-1 을 판단이 끝난 것으로 처분했다.
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
      // 승인 뒤 구현 — 같은 구현 세션(resume)에 개정 계획 전문·개정 알림·진단·승계된 열린 요청이 실린다.
      (turn) => {
        expect(turn.mode).toBe("resume");
        expect(turn.protocolOnly).toBe(false);
        expect(turn.prompt).toContain("계획 개정 알림(중재자 진단 DG-1)");
        expect(turn.prompt).toContain(revisedLine);
        expect(turn.prompt).toContain("[DG-1]");
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        writeFileSync(join(r.worktree, "feature.txt"), "개정 계획 구현\n");
        return result("IMPLEMENTATION", "개정 계획대로 구현했습니다.", {
          status: "completed", findings: [resolved("DG-1")], resolvesRequestedDecision: true, resolvedRequestId: openId,
        });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    const before = { topic: r.database.getTopic(r.topicId), flags: r.database.getFlags(r.topicId), head: git(r.worktree, ["rev-parse", "HEAD"]) };
    const revisionsBefore = r.database.revisions.account(r.topicId).used;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis({ relatedRequestIds: [openId] }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    // 개정 저장 전: 옛 승인 계획이 그대로이고, 구현 재개 우회는 막힌다.
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(r.database.getTopic(r.topicId).approvedPlanSHA256).toBe(before.topic.planSHA256);
    expect((await r.diagnoses())[0].status).toBe("applied");
    const bypass = await r.call("POST", `/api/topics/${r.topicId}/actions/resume-implementation`,
      { expectedState: "FAILED", expectedScopeGeneration: 1, reason: "우회 시도" }, { mediator: true });
    expect(bypass.status).toBe(409);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");

    const topic = r.database.getTopic(r.topicId);
    const flags = r.database.getFlags(r.topicId);
    expect(topic.planSHA256).not.toBe(before.topic.planSHA256);
    expect(topic.approvedPlanSHA256).toBeNull();
    expect(topic.planEpoch).toBe(before.topic.planEpoch);
    expect(topic.planRevision).toBeGreaterThan(before.topic.planRevision);
    expect(topic.branchName).toBe(before.topic.branchName);
    expect(topic.worktreePath).toBe(before.topic.worktreePath);
    expect(flags.implementationBaseOID).toBe(before.flags.implementationBaseOID);
    expect(flags.implementationSessionId).toBe(before.flags.implementationSessionId);
    expect(flags.closeoutRevisionUsed).toBe(false);
    expect(git(r.worktree, ["rev-parse", "HEAD"])).toBe(before.head);
    expect(readFileSync(join(r.worktree, "feature.txt"), "utf8")).toBe("구현 1\n");
    expect(topic.participants.every((participant) => participant.acknowledgedPlanSHA256 === topic.planSHA256)).toBe(true);
    // 저장된 최신 계획이 곧 ACK 한 계획이다(개정 뒤 감사 답변 저장이 진단 개정본에 가려지지 않는다).
    expect(await r.artifacts.readLatest(r.topicId, "plan")).toContain(revisedLine);
    expect(hashPlan((await r.artifacts.readLatest(r.topicId, "plan"))!)).toBe(topic.planSHA256);
    // 한도는 초기화하지 않고 소비한다(개정 턴 2회 + 감사 답변 1회).
    expect(r.database.revisions.account(r.topicId).used).toBeGreaterThanOrEqual(revisionsBefore + 2);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised"]);
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("Claude가 첫 계획을 작성합니다"))).toBe(false);
    // 감사는 구현 도중의 개정 맥락(진단·이전 승인 계획·바뀐 파일)을 받았다.
    const audit = r.codex.prompts.find((prompt) => prompt.includes("반환 kind는 AUDIT"));
    expect(audit).toContain("구현 도중의 계획 개정입니다(중재자 진단 DG-1");
    expect(audit).toContain(before.topic.planSHA256!);
    expect(audit).toContain("feature.txt");

    // 새 계획 승인 전에는 실행하지 않고, 이전 승인은 재사용하지 않는다.
    const turnsBefore = r.claude.turns.length;
    // 구현 게이트(assertImplementationGate)가 승인되지 않은 계획 버전을 거부한다 — 러너 턴 0회.
    const early = await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    expect(early.status).not.toBe(200);
    expect(String(early.body.error)).toContain("승인하지 않았습니다");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: before.topic.planSHA256 })).status).not.toBe(200);
    expect(r.claude.turns.length).toBe(turnsBefore);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: topic.planSHA256 })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status))
      .toEqual(["registered", "applied", "plan_revised", "delivered", "fix_reported", "resolved"]);
    expect(r.database.getFlags(r.topicId).implementationBaseOID).toBe(before.flags.implementationBaseOID);
    expect(r.database.getTopic(r.topicId).branchName).toBe(before.topic.branchName);
    expect(git(r.worktree, ["rev-parse", "HEAD"])).toBe(before.head);
    r.database.close();
  });

  it("개정 턴의 반박은 진단을 중재자에게 돌려보내고, 저장 전 정정은 옛 승인 계획으로 멈췄던 구현 단계를 되살린다(전체 재계획 없음)", { timeout: 60_000 }, async () => {
    let openId = "";
    const r = await room("plan-refute", [], { codex: "planning" });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      () => result("REVISION", "진단이 틀렸습니다.", {
        planEdits: [],
        findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "REFUTED", rationale: "계획 R-3 이 이미 같은 감사를 요구합니다.", evidenceRefs: ["plan:R-3"], requiresUserDecision: false }],
      }),
      (turn) => {
        expect(turn.protocolOnly).toBe(true);
        return result("IMPLEMENTATION", "요청을 해소했습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    const before = r.database.getTopic(r.topicId);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect((await r.diagnoses())[0].status).toBe("refuted");
    expect(r.database.getTopic(r.topicId).approvedPlanSHA256).toBe(before.planSHA256);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    const closing = {
      kind: "no_action", title: "계획 변경 불필요", observedFailure: "게이트 2 F1 SIGTRAP", cause: "계획 R-3 이 이미 같은 감사를 요구합니다.",
      evidenceRefs: ["plan:R-3"], supersedes: "DG-1",
    };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, closing, { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const after = r.database.getTopic(r.topicId);
    expect(after.planSHA256).toBe(before.planSHA256);
    expect(after.planEpoch).toBe(before.planEpoch);
    expect(r.codex.prompts.some((prompt) => prompt.includes("반환 kind는 AUDIT"))).toBe(false);
    expect((await r.diagnoses()).map((item) => item.status)).toEqual(["superseded", "closed_no_action"]);
    r.database.close();
  });

  it("범위 변경 뒤 이전 세대의 미해결 진단은 새 세대의 구현·인도를 막지 않는다(기록은 조회에 남는다 — host-review R1)", { timeout: 60_000 }, async () => {
    const r = await room("scope", [], { codex: "planning" });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      () => result("PLAN", "새 범위 계획입니다.", { planMarkdown: plan() }),
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
      () => {
        writeFileSync(join(r.database.getTopic(r.topicId).worktreePath, "feature.txt"), "새 범위 구현\n");
        return result("IMPLEMENTATION", "새 범위를 구현했습니다.", { status: "completed" });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "scope_change", body: "범위를 바꿉니다." })).status).toBe(200);
    expect(r.database.getTopic(r.topicId).scopeGeneration).toBe(2);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/plan`)).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    const sha = r.database.getTopic(r.topicId).planSHA256!;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: sha })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((item) => [item.id, item.status, item.binding.scopeGeneration])).toEqual([["DG-1", "registered", 1]]);
    const committed = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "새 범위", paths: ["feature.txt"] });
    expect(committed.status).toBe(200);
    r.database.close();
  });

  it("진단 전용 수정 도중 추가된 진단은 같은 수정 작업(계약)에 실려 앞 턴의 열린 요청을 잃지 않는다(host-review R2)", { timeout: 60_000 }, async () => {
    let openId = "";
    const r = await room("rework-requests", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // DG-1 진단 수정 — 질문 하나를 남기고 멈춘다.
      () => result("FIX", "로그 레벨 결정이 필요합니다.", {
        status: "in_progress", remainingSteps: ["결정 뒤 반영"], requestedUserDecision: "로그 레벨을 debug 로 올릴까요?",
        findings: [{ ...resolved("DG-1"), disposition: "AGREED_ACTION", rationale: "결정 뒤 반영합니다." }],
      }),
      // DG-2 가 같은 진단 전용 수정 계약(FC-1)에 실린 턴 — 앞 턴의 열린 요청이 실려야 한다. 해소하지 않고 완료를 주장하면 최종 리뷰로 가지 않는다.
      (turn) => {
        expect(turn.prompt).toContain("[DG-2]");
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        writeFileSync(join(r.worktree, "feature.txt"), "두 진단 반영\n");
        return result("FIX", "두 진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1"), resolved("DG-2")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect(openId).toBeTruthy();
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "같은 실패의 두 번째 원인" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")).toContain(openId);
    expect(r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toHaveLength(0);
    // 두 진단은 같은 진단 전용 수정 계약에 실렸다 — 요청은 다른 작업에서 승계되는 것이 아니라 같은 작업의 checkpoint 에서 그대로 복구된다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1", "DG-2"], "open"]]);
    r.database.close();
  });

  it("러너가 진단을 반박하면 refuted 로 기록하고 결과를 보존한 채 멈춘다 — 중재자 정정 전 재개는 막히고 같은 지시를 반복하지 않는다(host-review R3)", { timeout: 30_000 }, async () => {
    const r = await room("refute", []);
    r.claude["steps"].push(askingTurn(r.worktree), () => result("IMPLEMENTATION", "진단이 틀렸습니다.", {
      status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "SIGTRAP 는 다른 witness 에서 났습니다." }],
    }));
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses())[0].status).toBe("refuted");
    expect(r.database.getTopic(r.topicId).lastError).toContain("DG-1 반박");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    expect(r.claude.turns).toHaveLength(2);
    r.database.close();
  });

  // 허용 오차 위반이 교정 뒤에도 남으면 absorbTurn 이 null 로 끝나 일반 반환 경로(returnDiagnosesToMediator)에 닿지 않는다 — 그 정지에서도 기록돼야 한다.
  for (const [disposition, status] of [["REFUTED", "refuted"], ["EXTERNAL_EVIDENCE", "needs_evidence"]] as const) {
    it(`허용 오차 정지에서도 러너의 진단 ${disposition} 처분을 ${status} 로 기록한다 — 중재자 정정 전 재개는 막히고 같은 지시를 다시 싣지 않는다(host-review R3 잔여)`, { timeout: 30_000 }, async () => {
      const r = await room(`tolerance-${status}`, [], { tolerance: TIGHT_TOLERANCE });
      const returned = { ...resolved("DG-1"), disposition, rationale: disposition === "REFUTED" ? "SIGTRAP 는 다른 witness 에서 났습니다." : "크래시 리포트 원본이 필요합니다." };
      r.claude["steps"].push(
        askingTurn(r.worktree),
        () => {
          // 진단 턴: 승인 범위(feature.txt) 밖 파일을 만들고 진단을 돌려보낸다.
          writeFileSync(join(r.worktree, "stray.txt"), "범위 밖\n");
          return result("IMPLEMENTATION", "진단을 돌려보냅니다.", { status: "completed", findings: [returned] });
        },
        // 허용 오차 교정 턴: 되돌리지 않는다 → 교정 뒤에도 위반이 남아 정지한다.
        () => result("IMPLEMENTATION", "되돌리지 않았습니다.", { status: "completed", findings: [returned] }),
      );
      await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
      await r.idle("USER_DECISION_REQUIRED");
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
      await r.idle("USER_DECISION_REQUIRED");
      expect(r.database.getTopic(r.topicId).lastError).toContain("허용 오차 위반이 남았습니다");
      expect(r.database.getTopic(r.topicId).lastError).toContain(`DG-1 ${disposition === "REFUTED" ? "반박" : "추가 증거 필요"}`);
      expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", status]);
      expect(r.database.getTimeline(r.topicId).some((event) =>
        Array.isArray(event.payload?.diagnosisReturned) && (event.payload?.diagnosisReturned as string[]).includes("DG-1"))).toBe(true);
      expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
      expect(r.claude.turns).toHaveLength(3);
      r.database.close();
    });
  }

  it("허용 오차 교정 도중 끊긴 턴의 진단 반박은 retry 가 새 턴을 열기 전에 중재자에게 돌려보낸다 — 같은 지시를 다시 싣지 않는다(host-review R3 잔여)", { timeout: 30_000 }, async () => {
    const r = await room("tolerance-crash", [], { tolerance: TIGHT_TOLERANCE });
    const refuted = { ...resolved("DG-1"), disposition: "REFUTED" as const, rationale: "SIGTRAP 는 다른 witness 에서 났습니다." };
    r.claude["steps"].push(
      askingTurn(r.worktree),
      () => {
        writeFileSync(join(r.worktree, "stray.txt"), "범위 밖\n");
        return result("IMPLEMENTATION", "진단을 반박합니다.", { status: "completed", findings: [refuted] });
      },
      () => { throw new Error("허용 오차 교정 턴 프로세스 비정상 종료"); },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect((await r.diagnoses())[0].status).toBe("delivered");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "refuted"]);
    expect(r.database.getTopic(r.topicId).lastError).toContain("DG-1 반박");
    expect(r.claude.turns).toHaveLength(3);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    r.database.close();
  });

  it("재대조가 연 허용 오차 교정 턴의 진단 반박도 수락 전에 중재자에게 돌려보낸다 — 리뷰·인도 대기로 새지 않는다(2026-09-14 감사)", { timeout: 30_000 }, async () => {
    let openId = "";
    const r = await room("reverify-refute", [], { tolerance: TIGHT_TOLERANCE });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      // 진단 턴: 반영을 보고하지만 열린 요청은 해소하지 않는다 → 요청 때문에 멈춘다(DG-1 delivered).
      () => {
        writeFileSync(join(r.worktree, "feature.txt"), "진단 반영\n");
        return result("IMPLEMENTATION", "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
      // 결정 뒤 복구 — 읽기 전용 확인 턴이 요청을 해소한다.
      (turn) => {
        expect(turn.protocolOnly).toBe(true);
        return result("IMPLEMENTATION", "요청을 해소했습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId });
      },
      // 수락 전 재대조가 범위 밖 변경(stray.txt)을 잡아 연 교정 턴 — 되돌리면서 진단을 반박한다.
      (turn) => {
        expect(turn.protocolOnly).toBe(false);
        rmSync(join(r.worktree, "stray.txt"));
        return result("IMPLEMENTATION", "되돌렸습니다. 진단은 틀렸습니다.", {
          status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "SIGTRAP 는 다른 witness 에서 났습니다." }],
        });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses())[0].status).toBe("delivered");
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    writeFileSync(join(r.worktree, "stray.txt"), "범위 밖\n");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "refuted"]);
    expect(r.database.getTopic(r.topicId).lastError).toContain("DG-1 반박");
    expect(r.codex.prompts).toHaveLength(0);
    expect(r.claude.turns).toHaveLength(4);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    r.database.close();
  });

  it("진단 전용 수정이 반박된 뒤 수정 불필요로 정정하면 일반 수정이 아니라 최종 리뷰로 돌아간다 — 자동 수정 회차를 쓰지 않는다(2026-09-14 감사)", { timeout: 30_000 }, async () => {
    const r = await room("diagnosis-fix-no-action", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        return result("FIX", "진단이 틀렸습니다.", {
          status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "외부 검증 실패는 이 변경과 무관합니다." }],
        });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses())[0].status).toBe("refuted");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("전체 재계획은 이전 계획에 묶인 진행 중 진단을 재확인(stale)으로 돌린다 — 새 계획에 옛 개정을 싣지 않는다(2026-09-14 감사)", { timeout: 60_000 }, async () => {
    const r = await room("replan-stale", [], { codex: "essential-closeout" });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: "진단 DG-1: 감사 단계를 추가한다.\n" }] },
          findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      // 감사 답변 개정(무변경) — 뒤이은 종결이 새 필수 쟁점(C-1)을 낸다.
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      // 개정 2회차(C-1 반영) — 종결 2회차가 또 새 필수 쟁점(C-2)을 내 필수 쟁점 잔존으로 멈춘다.
      () => result("REVISION", "종결 쟁점을 반영했습니다.", {
        planEdits: [], findings: [{ id: "C-1", title: "배포 전제 누락 C-1", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "계획에 배포 전제를 적었습니다.", evidenceRefs: [], requiresUserDecision: false }],
      }),
      // 전체 재계획의 첫 계획 턴 — 이 테스트는 재계획 진입까지만 본다.
      () => { throw new Error("재계획 턴 일시 장애"); },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses())[0].status).toBe("plan_revised");
    expect(r.database.getTimeline(r.topicId).some((event) => Array.isArray(event.payload?.closeoutEssentialFindingIDs))).toBe(true);
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "전제가 바뀌었습니다.\nREPLAN" })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("FAILED");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status).at(-1)).toBe("stale");
    expect(r.database.getTimeline(r.topicId).some((event) =>
      Array.isArray(event.payload?.diagnosisStaleOnReplan) && (event.payload?.diagnosisStaleOnReplan as string[]).includes("DG-1"))).toBe(true);
    // 재확인 대상 진단이 막는 것은 구현 전달이지 계획 수렴 재시도가 아니다(host-review R9) — 재시도는 진단 검사를 지나 다음 관문(계획 재작성
    // 한도)에서 멈춘다. 한도는 초기화·추가 승인하지 않는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("계획 재작성 한도");
    // 계획 단계에서도 수정 불필요로 닫을 수 있다 — 닫지 못하면 구현 시작이 영영 막힌다(host-review R9). 새 수정 진단은 적용할 수 없는 단계라 받지 않는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "계획 단계의 새 진단" }), { mediator: true })).status).toBe(409);
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "재계획으로 무효 — 새 계획에서 다시 진단", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action"]);
    r.database.close();
  });

  it.each(["question", "finding", "blocked"] as const)("R10 러너 요청(%s): 진단 전용 수정 작업에 열린 요청이 남으면 수정 불필요 정정을 받지 않고, 요청 해소를 지시한 정정이 같은 경로로 이어간다(host-review R10)", { timeout: 30_000 }, async (form) => {
    let openId = "";
    const r = await room("diagnosis-fix-open-request", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 진단 전용 수정 턴: 진단을 반박하면서 별도의 결정을 묻는다.
      () => result("FIX", "진단이 틀렸고, 배포 채널 결정이 필요합니다.", {
        status: form === "blocked" ? "blocked" : "completed", requestedUserDecision: form === "question" ? "배포 채널을 A 로 할까요?" : undefined,
        findings: [{ ...resolved("DG-1"), disposition: "REFUTED", requiresUserDecision: form === "finding", rationale: "외부 검증 실패는 이 변경과 무관합니다." }],
      }),
      // 정정 진단(DG-2) 턴: 코드를 바꾸지 않고 승계된 열린 요청을 해소한 뒤 반영을 보고한다.
      (turn) => {
        expect(turn.prompt).toContain("[DG-2]");
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        return result("FIX", "요청을 해소했습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId, findings: [resolved("DG-2")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses())[0].status).toBe(form === "finding" ? "needs_evidence" : "refuted");
    // 열린 요청이 남은 채 수정 불필요로 닫으면 그 요청을 해소할 작업이 사라진다 — 받지 않는다.
    const refused = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }), { mediator: true });
    expect(refused.status).toBe(409);
    openId = /Q-[0-9a-f]{8}/.exec(String(refused.body.error))?.[0] ?? "";
    expect(openId).toMatch(/^Q-[0-9a-f]{8}$/);
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ title: "진단 철회 — 코드 변경 없이 열린 요청만 해소", instructions: "코드를 바꾸지 말고 열린 요청을 결정대로 해소하세요.", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "resolved"]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.resolvedRequest === openId)).toBe(true);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "요청 해소 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("진단 전용 수정이 응답 전에 끊긴 뒤 수정 불필요로 정정하면 구현 결과로 최종 리뷰를 다시 한다(host-review R11)", { timeout: 30_000 }, async () => {
    const r = await room("diagnosis-fix-crash-no-action", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => { expect(turn.prompt).toContain("[DG-1]"); throw new Error("진단 수정 턴 프로세스 비정상 종료"); },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    // 첫 리뷰에서 곧장 인도 대기에 이르렀다 — 수정 결과(claude-fix)가 없다.
    expect(r.database.latestArtifact(r.topicId, "claude-fix")).toBeFalsy();
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect((await r.diagnoses())[0].status).toBe("delivered");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 외부 원인", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.codex.prompts.at(-1)).toContain("구현을 마쳤습니다.");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // 적용 뒤 곧바로 여는 재개가 막힐 조건(순차 적용을 기다리는 수정 진단이 아닌 다른 처리 대기 진단 — 여기서는 원인 미확정 조사)이면 적용 자체를 기록하지 않는다
  // — 계획 변경·수정 진단 모두. 등록된 다른 수정 진단은 막지 않는다(순차 적용, 아래 감사 2차 #9).
  for (const [label, first] of [["계획 변경", planDiagnosis()], ["수정", fixDiagnosis()]] as const) {
    it(`다른 진단이 처리 대기면 ${label} 진단 적용을 기록하지 않는다 — 인도 대기의 완료 판정이 남아 정정 뒤 커밋할 수 있다(2026-09-15 감사)`, { timeout: 30_000 }, async () => {
      const r = await room(`apply-refused-${label === "수정" ? "fix" : "plan"}`, []);
      r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
      await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
      await r.idle("READY_TO_DELIVER");
      const reviewedHead = r.database.getFlags(r.topicId).reviewedHead;
      expect(reviewedHead).toBeTruthy();
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, first, { mediator: true })).status).toBe(201);
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ kind: "investigation", title: "원인 미확정 조사" }), { mediator: true })).status).toBe(201);
      const refused = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
      expect(refused.status).toBe(409);
      expect(String(refused.body.error)).toContain("DG-2");
      expect((await r.diagnoses()).map((record) => record.status)).toEqual(["registered", "registered"]);
      expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
      expect(r.database.getFlags(r.topicId).reviewedHead).toBe(reviewedHead);
      for (const id of ["DG-1", "DG-2"]) {
        expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ kind: "no_action", title: `${id} 수정 불필요`, supersedes: id }), { mediator: true })).status).toBe(201);
      }
      expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 정리 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
      expect(r.claude.turns).toHaveLength(1);
      r.database.close();
    });
  }

  it("등록된 수정 진단 둘은 순차로 적용한다 — 먼저 적용한 진단은 기록만 하고 재개하지 않으며, 마지막 적용이 두 진단을 한 진단 전용 수정 작업으로 재개한다(2026-09-15 감사 2차 #9)", { timeout: 30_000 }, async () => {
    const r = await room("sequential-apply", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        expect(turn.prompt).toContain("[DG-2]");
        writeFileSync(join(r.worktree, "feature.txt"), "두 진단 반영\n");
        return result("FIX", "두 진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1"), resolved("DG-2")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "첫 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "둘째 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    // 먼저 적용한 DG-1: 적용은 기록하고(완료 판정 취소) 실행은 열지 않는다 — DG-2 가 적용을 기다린다.
    const first = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(first.status).toBe(200);
    expect(first.body.actionId).toBeNull();
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["applied", "registered"]);
    expect(r.claude.turns).toHaveLength(1);
    expect(r.database.getFlags(r.topicId).reviewedHead).toBeNull();
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "열린 진단", paths: ["feature.txt"] })).status).not.toBe(200);
    // 마지막 적용이 재개한다 — 두 진단이 같은 진단 전용 수정 계약으로 한 턴에 실린다.
    const second = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true });
    expect(second.status).toBe(200);
    expect(second.body.actionId).toBeTruthy();
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["resolved", "resolved"]);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1", "DG-2"], "accepted"]]);
    r.database.close();
  });

  it("진단 전용 수정 결과가 전이 가드에 걸리면 반영 보고(fix_reported)를 남기지 않는다 — 진단은 전달됨으로 남고 retry 도 일반 수정으로 빠지지 않는다(2026-09-15 감사)", { timeout: 30_000 }, async () => {
    const r = await room("accept-guard-order", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 반영을 보고하면서 심각도를 비실행 등급으로 낮춘다 — 전이 가드(처분 되돌림)가 최종 리뷰로 넘기지 않는다.
      () => result("FIX", "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1", { severity: "INFO" })] }),
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("처분을 되돌렸습니다");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.claude.turns).toHaveLength(2);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.diagnoses())[0].status).toBe("delivered");
    r.database.close();
  });

  it("진단 턴이 응답 전에 죽으면 retry 는 이전 수락 결과로 건너뛰지 않고 진단을 다시 싣는다(host-review R5)", { timeout: 60_000 }, async () => {
    const r = await room("spawn-crash", [], { codex: "flaky" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => { expect(turn.prompt).toContain("[DG-1]"); throw new Error("진단 턴 프로세스 비정상 종료"); },
      (turn) => {
        expect(turn.protocolOnly).toBe(false);
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "진단 반영\n");
        return result("IMPLEMENTATION", "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect((await r.diagnoses())[0].status).toBe("delivered");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(3);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    r.database.close();
  });

  it("승인 대기 중 메시지로 일어나는 전체 재계획도 진행 중인 계획 변경 진단을 먼저 재확인(stale)으로 돌린다 — 새 계획 주기로 넘기지 않고, 계획 단계에서도 수정 불필요 정정으로 닫힌다(2026-09-15 감사 #2)", { timeout: 60_000 }, async () => {
    const r = await room("message-replan-stale", [], { codex: "planning" });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      // 진단 계획 개정 — 승인 계획에 단계를 더한다.
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: "진단 DG-1: 감사 단계를 추가한다.\n" }] },
          findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      // 감사 답변 개정(무변경) → 종결 → ACK 로 승인 대기에 이른다.
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    const openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect(openId).toBeTruthy();
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis({ relatedRequestIds: [openId] }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    // 개정 계획은 두 에이전트가 ACK 했지만 사용자는 아직 승인하지 않았다 — DG-1 은 개정 저장(plan_revised)에 머문다.
    const before = r.database.getTopic(r.topicId);
    expect(before.planSHA256).toBeTruthy();
    expect(before.approvedPlanSHA256).toBeNull();
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised"]);
    const turnsBefore = r.claude.turns.length;
    expect(turnsBefore).toBe(4);
    const sequenceBefore = r.database.getTimeline(r.topicId).at(-1)!.sequence;

    // 승인 대기 중 메모 — 계획 확인·승인을 취소하는 전체 재계획(계획 주기 +1, DRAFT)이다. 러너 턴은 열지 않는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "note", body: "배포 조건을 하나 더 적습니다." })).status).toBe(200);
    const after = r.database.getTopic(r.topicId);
    expect(after.state).toBe("DRAFT");
    expect(after.planEpoch).toBe(before.planEpoch + 1);
    expect(after.planSHA256).toBeNull();
    expect(after.approvedPlanSHA256).toBeNull();
    expect(r.database.getFlags(r.topicId).resumeState).toBeNull();
    expect(r.claude.turns).toHaveLength(turnsBefore);
    // 재계획은 먼저 DG-1 을 재확인(stale, 사유 replan)으로 돌린다 — 이력의 마지막 항목이다.
    const [record] = await r.diagnoses();
    expect(record.status).toBe("stale");
    expect(record.history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised", "stale"]);
    expect((record.history.at(-1) as { status: string; detail: Record<string, unknown> }).detail)
      .toEqual({ reason: "replan", fromPlanEpoch: before.planEpoch, toPlanEpoch: before.planEpoch + 1 });
    // 재확인 기록은 재계획 전이(메모·DRAFT)보다 먼저, 승인 대기 상태에서 남는다.
    const events = r.database.getTimeline(r.topicId, sequenceBefore);
    const staleEvent = events.find((event) =>
      Array.isArray(event.payload?.diagnosisStaleOnReplan) && (event.payload?.diagnosisStaleOnReplan as string[]).includes("DG-1"));
    const noteEvent = events.find((event) => event.actor === "user" && event.kind === "note");
    expect(staleEvent).toBeDefined();
    expect(noteEvent).toBeDefined();
    expect(staleEvent!.state).toBe("AWAITING_USER_APPROVAL");
    expect(noteEvent!.payload?.planEpoch).toBe(before.planEpoch + 1);
    expect(staleEvent!.sequence).toBeLessThan(noteEvent!.sequence);

    // 계획 단계(DRAFT)에서 새 수정 진단은 받지 않지만, 재계획 stale 진단의 수정 불필요 정정은 받는다 — 닫지 못하면 새 계획의 구현 시작이 영영 막힌다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "계획 단계의 새 진단" }), { mediator: true })).status).toBe(409);
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "재계획으로 무효 — 새 계획에서 다시 진단", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect((await r.diagnoses()).map((entry) => entry.status)).toEqual(["superseded", "closed_no_action"]);
    expect(r.database.getTopic(r.topicId).state).toBe("DRAFT");
    expect(r.claude.turns).toHaveLength(turnsBefore);
    r.database.close();
  });

  it("진단 전용 수정 작업의 열린 요청은 허용 오차 개정으로 계획 sha 가 바뀌어도 수정 불필요 정정을 막고, 요청 해소를 지시한 정정만 같은 경로를 잇는다(2026-09-15 감사 #3)", { timeout: 30_000 }, async () => {
    let openId = "";
    const r = await room("diagnosis-fix-open-request-amend", [], { tolerance: TIGHT_TOLERANCE });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 진단 전용 수정 턴: 범위 밖 파일을 만들고 범위 결정을 묻는다(열린 요청 1개).
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "stray.txt"), "범위 밖\n");
        return result("FIX", "진단을 반영했고 범위 결정이 필요합니다.", { status: "completed", requestedUserDecision: "stray.txt 를 범위에 넣어도 될까요?", findings: [resolved("DG-1")] });
      },
      // 허용 오차 교정 턴: 되돌리지 않는다 — 허용 오차 정지는 paused checkpoint 만 남기고 claude-fix 산출물을 쓰지 않는다.
      () => result("FIX", "되돌리지 않았습니다.", { status: "completed", findings: [resolved("DG-1")] }),
      // 정정 진단(DG-2) 턴: 개정 뒤에도 승계된 열린 요청을 id 로 해소한다.
      (turn) => {
        expect(turn.prompt).toContain("[DG-2]");
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        return result("FIX", "요청을 해소했습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId, findings: [resolved("DG-2")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(3);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);
    // 옛 산출물 폴백으로는 요청을 찾을 수 없는 조건 — 구현 결과에는 요청이 없고 claude-fix 는 없다. 열린 요청은 paused checkpoint 에만 있다.
    expect(r.database.latestArtifact(r.topicId, "claude-fix")).toBeFalsy();
    const noAction = () => r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 외부 원인", supersedes: "DG-1" }), { mediator: true });
    const control = await noAction();
    expect(control.status).toBe(409);
    openId = /Q-[0-9a-f]{8}/.exec(String(control.body.error))?.[0] ?? "";
    expect(openId).toMatch(/^Q-[0-9a-f]{8}$/);
    const paused = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint")) ?? "{}") as { work: { planSHA256: string; planEpoch: number }; openRequests: Array<{ id: string }> };
    expect(paused.openRequests.map((request) => request.id)).toEqual([openId]);
    // 허용 오차 개정은 계획 sha 만 바꾸고 계획 주기(epoch)는 그대로 둔다 — checkpoint 의 계획 sha 와 어긋나게 된다.
    const before = r.database.getTopic(r.topicId);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/amend-tolerance`,
      { tolerance: { scopePaths: ["feature.txt", "stray.txt"], rules: [] }, reason: "stray.txt 허용" }, { mediator: true })).status).toBe(200);
    const amended = r.database.getTopic(r.topicId);
    expect(amended.planSHA256).not.toBe(before.planSHA256);
    expect(amended.planEpoch).toBe(before.planEpoch);
    expect(paused.work.planSHA256).not.toBe(amended.planSHA256);
    expect(paused.work.planEpoch).toBe(amended.planEpoch);
    // 같은 수정 불필요 정정은 개정 뒤에도 거부된다 — 기록도 재개 단계도 바뀌지 않는다.
    const refused = await noAction();
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toContain(openId);
    expect((await r.diagnoses()).map((record) => `${record.id}:${record.status}`)).toEqual(["DG-1:delivered"]);
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    // 요청 해소를 지시한 정정은 개정 뒤에도 그 요청을 열린 요청으로 결속하고(관련 요청으로 받음), 같은 진단 전용 수정 경로로 이어간다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "stray.txt 를 범위에 넣으세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({
      title: "진단 철회 — 코드 변경 없이 열린 요청만 해소", instructions: "코드를 바꾸지 말고 열린 요청을 결정대로 해소하세요.", supersedes: "DG-1", relatedRequestIds: [openId],
    }), { mediator: true })).status).toBe(201);
    expect((await r.diagnoses())[1].binding.openRequestIds).toEqual([openId]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "resolved"]);
    expect(r.claude.turns).toHaveLength(4);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.resolvedRequest === openId)).toBe(true);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "요청 해소 뒤 인도", paths: ["feature.txt", "stray.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("진단 전용 수정의 허용 오차 교정 턴이 끊긴 뒤 새 진단이 같은 수정 작업(계약)에 실려도 그 작업 checkpoint 에만 남은 반박을 refuted 로 기록하고 새 턴 없이 멈춘다 — 반박한 진단을 다시 싣지 않는다(2026-09-15 감사 #7)", { timeout: 30_000 }, async () => {
    const r = await room("diagnosis-fix-rework-refute", [], { tolerance: TIGHT_TOLERANCE });
    const refuted = { ...resolved("DG-1"), disposition: "REFUTED" as const, rationale: "SIGTRAP 는 다른 witness 에서 났습니다." };
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // DG-1 진단 전용 수정 턴: 승인 범위(feature.txt) 밖 파일을 만들고 진단을 반박한다 — 허용 오차 위반이라 반박은 교정 전 checkpoint 누적본에만 남는다.
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "stray.txt"), "범위 밖\n");
        return result("FIX", "진단을 반박합니다.", { status: "completed", findings: [refuted] });
      },
      // 허용 오차 교정 턴: 처분을 기록하기 전에 죽는다.
      () => { throw new Error("허용 오차 교정 턴 프로세스 비정상 종료"); },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);
    expect(r.claude.turns).toHaveLength(3);
    // 반박은 DG-1 진단 전용 수정 작업(계약 FC-1)의 최신 checkpoint 누적본에만 있다 — 같은 세대·같은 계획 주기다.
    const topic = r.database.getTopic(r.topicId);
    const checkpointRevision = r.database.latestArtifact(r.topicId, "work-checkpoint")?.revision;
    const checkpoint = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as {
      work: { fixSource?: string; scopeGeneration: number; planEpoch: number }; accumulated: AgentResult;
    };
    expect(checkpoint.work.fixSource).toBe("FC-1");
    expect([checkpoint.work.scopeGeneration, checkpoint.work.planEpoch]).toEqual([topic.scopeGeneration, topic.planEpoch]);
    expect(checkpoint.accumulated.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("REFUTED");
    const codexBefore = r.codex.prompts.length;
    // 정정이 아닌 새 진단(supersedes 없음)도 같은 진단 전용 수정 계약(FC-1)에 실린다 — 재개는 그 작업의 checkpoint 에서 반박을 먼저 본다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "같은 실패의 두 번째 원인" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    // 새 Claude 턴 없이 직전 작업 checkpoint 의 반박을 기록하고 중재자에게 돌려보냈다 — DG-1 도 DG-2 도 다시 전달되지 않았다.
    expect(r.claude.turns).toHaveLength(3);
    expect(r.claude.turns.some((turn) => turn.prompt.includes("[DG-2]"))).toBe(false);
    expect(r.codex.prompts).toHaveLength(codexBefore);
    const [first, second] = await r.diagnoses();
    expect(first.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "refuted"]);
    expect(second.history.map((entry) => entry.status)).toEqual(["registered", "applied"]);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1", "DG-2"], "open"]]);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain("DG-1 반박");
    const returned = r.database.getTimeline(r.topicId).filter((event) => Array.isArray(event.payload?.diagnosisReturned));
    expect(returned.map((event) => [event.payload?.diagnosisReturned, event.payload?.checkpointResumed])).toEqual([[["DG-1"], checkpointRevision]]);
    // 반박이 기록됐으므로 중재자 정정 전 재개는 막힌다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    expect(r.claude.turns).toHaveLength(3);
    r.database.close();
  });

  it("needs_evidence 로 돌아온 진단을 정정(supersedes)해 적용하면 누적본에 남은 닫힌 진단의 옛 증거 요청이 완료 판정을 막지 않는다 — 정정 진단 반영이 리뷰를 거쳐 인도 대기에 이른다(2026-09-15 감사 #5)", { timeout: 30_000 }, async () => {
    const r = await room("superseded-evidence", []);
    const needsEvidence: Finding = { ...resolved("DG-1"), disposition: "EXTERNAL_EVIDENCE", rationale: "크래시 리포트 원본이 필요합니다." };
    r.claude["steps"].push(
      // 첫 구현 턴은 프로세스가 뜬 뒤 죽는다 → FAILED(재개 IMPLEMENTING). 진단이 구현 작업(work) 경로로 실린다 — 이 작업 id 에는 진단 id 가 들어가지 않는다.
      () => { throw new Error("구현 턴 프로세스 비정상 종료"); },
      // DG-1 턴: 파일을 바꾸고 status=completed 로 끝내면서 DG-1 에는 증거를 요구한다 → needs_evidence 로 돌아가고 paused checkpoint 누적본에 이 처분이 남는다.
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "구현\n");
        return result("IMPLEMENTATION", "증거가 필요합니다.", { status: "completed", findings: [needsEvidence] });
      },
      // DG-2 턴: 같은 작업 id 라 DG-1 턴의 누적본에서 복구된다. 정정 진단만 실리고, 러너는 DG-2 만 반영 보고한다(닫힌 DG-1 은 다시 처분하지 않는다).
      (turn) => {
        expect(turn.protocolOnly).toBe(false);
        expect(turn.prompt).toContain("[DG-2]");
        expect(turn.prompt).toContain("DG-1 정정");
        expect(turn.prompt).not.toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "증거 반영 정정\n");
        return result("IMPLEMENTATION", "정정 진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-2")] });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(r.database.getTopic(r.topicId).lastError).toContain("DG-1 추가 증거 필요");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "needs_evidence"]);
    // 정정 전 재개는 막힌다 — 러너는 불리지 않는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    expect(r.claude.turns).toHaveLength(2);

    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "evidence", body: "크래시 리포트 원본: evidence/crash-full.ips" })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "증거 반영 정정", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect((await r.diagnoses()).map((item) => [item.id, item.status])).toEqual([["DG-1", "superseded"], ["DG-2", "registered"]]);
    const beforeApply = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    // 수정 전: 복구 누적본에 남은 DG-1 EXTERNAL_EVIDENCE 가 completionVerdict 에서 external-evidence 로 판정돼 BLOCKED_ON_EVIDENCE 로 멈췄다(retry 마다 같은 정지).
    await r.idle("READY_TO_DELIVER");

    expect(r.database.getTimeline(r.topicId, beforeApply).filter((event) => event.state === "BLOCKED_ON_EVIDENCE")).toEqual([]);
    expect(r.database.getFlags(r.topicId).resumeState ?? null).toBeNull();
    expect(r.claude.turns).toHaveLength(3);
    expect(r.claude.turns.map((turn) => turn.protocolOnly)).toEqual([false, false, false]);
    const [dg1, dg2] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "needs_evidence", "superseded"]);
    expect(dg2.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    // 리뷰어는 정정 진단 DG-2 의 반영을 판정했고, 구현 보고에 닫힌 DG-1 의 증거 대기 처분이 남아 있지 않다.
    expect(r.codex.prompts).toHaveLength(1);
    expect(r.codex.prompts[0]).toContain('"id": "DG-2"');
    expect(r.codex.prompts[0]).not.toContain('"disposition": "EXTERNAL_EVIDENCE"');
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "정정 진단 반영 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // 러너가 진단 쟁점을 미반영 처분(AGREED_ACTION)인 채 status=completed 로 돌려주면 완료가 아니다 — 수락·전이하지 않고 같은 세션의 계속 진행 턴이
  // 그 진단을 다시 묻는다. 구현 작업(구현 정지에서 반환 → 리뷰)과 진단 전용 수정(인도 대기에서 반환 → 최종 리뷰) 두 경로 모두.
  it("최종 리뷰 정지에서 적용한 진단 전용 수정은 그 정지의 사용자 판정 쟁점을 러너 프롬프트와 결과 커버리지에 싣고, 러너가 판정 필요를 유지하면 인도 대기로 넘기지 않고 멈춘다(2026-09-15 감사 #8)", { timeout: 30_000 }, async () => {
    const r = await room("final-stop-carry", [], { codex: "final-review-decision" });
    let diagnosisFixPrompt = "";
    let correctionPrompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n");
        return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
      // DG-2 진단 수정 턴 — 진단만 반영하고 최종 리뷰 정지의 F-2 는 빠뜨린다. 서버 커버리지 검사가 거부해 1회 교정을 요구해야 한다.
      (turn) => {
        diagnosisFixPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영\n");
        return result("FIX", "DG-2 를 반영했습니다.", { status: "completed", findings: [resolved("DG-2")] });
      },
      // 계약 교정 재제출 — F-2 를 담되 고치지 않고 사용자 판정 필요를 유지한다.
      (turn) => {
        correctionPrompt = turn.prompt;
        return result("FIX", "F-2 는 사용자 판정이 필요해 고치지 않았습니다.", {
          status: "completed",
          findings: [resolved("DG-2"), { ...FINAL_REVIEW_DECISION_FINDING, rationale: "F-2 로그 경로는 사용자 판정이 필요해 고치지 않았습니다." }],
        });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 A" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    // 첫 최종 리뷰가 DG-1 반영을 확인하면서 새 쟁점 F-2(수정 합의 + 사용자 판정 필요)를 내 최종 리뷰 정지에 멈춘다.
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(FINAL_REVIEW_DECISION_FINDING.rationale);
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.prompts[1]).toContain("반환 kind는 FINAL_REVIEW");

    // 그 정지에서 새 진단 DG-2 를 적용하면 진단 전용 수정으로 반환된다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 B" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");

    // 러너 프롬프트: 진단 DG-2 와 함께 최종 리뷰 정지의 F-2 가 수정 대상에 실린다.
    expect(diagnosisFixPrompt).toContain("중재자 진단(수정 지시)을 반영하세요");
    expect(diagnosisFixPrompt).toContain("[DG-2]");
    expect(diagnosisFixPrompt).toContain('"id": "F-2"');
    // 결과 커버리지: F-2 를 빠뜨린 보고는 거부되고 같은 세션에 1회 교정을 요구받는다.
    expect(correctionPrompt).toContain("검토 쟁점을 누락했습니다: F-2");
    expect(r.claude.turns).toHaveLength(4);
    // 러너가 F-2 의 사용자 판정 필요를 유지했다 — 최종 리뷰·인도 대기로 넘기지 않고 수정 단계에서 멈춘다.
    const topic = r.database.getTopic(r.topicId);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(topic.lastError).toContain("F-2 로그 경로는 사용자 판정이 필요해 고치지 않았습니다.");
    expect(r.codex.prompts).toHaveLength(2);
    // 보존된 수정 결과(다음 최종 리뷰의 대조 원본)에 F-2 가 판정 필요인 채 남는다.
    const storedFix = JSON.parse((await r.artifacts.readLatest(r.topicId, "claude-fix")) ?? "{}") as AgentResult;
    expect(storedFix.findings.find((finding) => finding.id === "F-2")).toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true });
    const [dg1, dg2] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    expect(dg2.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);
    // 커밋은 인도 대기에서만 열린다 — 수정 단계 정지에서는 상태 요구로 거부된다(감사 관측: 판정 없이 READY 에 이르러 200).
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 전 커밋", paths: ["feature.txt"] });
    expect(commit.status).toBeGreaterThanOrEqual(400);
    expect(String(commit.body.error)).toContain("READY_TO_DELIVER");
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    r.database.close();
  });

  for (const path of ["구현 작업", "진단 전용 수정"] as const) {
    it(`진단 쟁점을 AGREED_ACTION 인 채 completed 로 돌려준 ${path} 결과는 수락하지 않고 계속 진행 턴으로 그 진단을 다시 묻는다 — 반영 보고 뒤에야 리뷰를 거쳐 인도 대기·해결에 이른다(2026-09-15 감사 #11)`, { timeout: 30_000 }, async () => {
      const fixPath = path === "진단 전용 수정";
      const kind = fixPath ? "FIX" : "IMPLEMENTATION";
      const workState = fixPath ? "CLAUDE_FIX" : "IMPLEMENTING";
      const reviewState = fixPath ? "CODEX_FINAL_REVIEW" : "CODEX_REVIEW";
      const r = await room(`agreed-action-${fixPath ? "dfix" : "work"}`, []);
      let openId = "";
      const atContinuation = { state: "", diagnosis: "", codexPrompts: -1 };
      const pending = { ...resolved("DG-1"), disposition: "AGREED_ACTION" as const, rationale: "아직 반영하지 않았습니다 — 반영 예정" };
      r.claude["steps"].push(
        fixPath
          ? () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); }
          : askingTurn(r.worktree),
        // 진단이 실린 턴: 진단을 미반영 처분(AGREED_ACTION)으로 둔 채 completed 를 주장한다(구현 경로는 열린 요청을 id 로 해소한다).
        () => result(kind, "진단은 아직 반영하지 않았습니다.", {
          status: "completed", findings: [pending], ...(fixPath ? {} : { resolvesRequestedDecision: true, resolvedRequestId: openId }),
        }),
        // 계속 진행 턴 — 이 시점에 앞 결과가 수락됐으면 리뷰 전이·리뷰어 호출·반영 보고가 이미 있었을 것이다.
        () => {
          atContinuation.state = r.database.getTopic(r.topicId).state;
          atContinuation.diagnosis = r.database.diagnoses.get(r.topicId, "DG-1")?.status ?? "";
          atContinuation.codexPrompts = r.codex.prompts.length;
          writeFileSync(join(r.worktree, "feature.txt"), "진단 반영\n");
          return result(kind, "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
        },
      );
      await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
      if (fixPath) {
        await r.idle("READY_TO_DELIVER");
      } else {
        await r.idle("USER_DECISION_REQUIRED");
        openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
        expect(openId).toBeTruthy();
        expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
      }
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(fixPath ? { title: "인도 대기 중 외부 검증 실패" } : {}), { mediator: true })).status).toBe(201);
      const codexBeforeApply = r.codex.prompts.length;
      const applySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
      await r.idle("READY_TO_DELIVER");

      // 1) AGREED_ACTION 결과는 수락되지 않았다 — 같은 세션의 계속 진행 턴이 DG-1 을 다시 물었고, 그때 주제는 작업 상태·리뷰어 미호출·진단은 전달됨이었다.
      expect(r.claude.turns).toHaveLength(3);
      const [, diagnosisTurn, continuation] = r.claude.turns;
      expect(diagnosisTurn.protocolOnly).toBe(false);
      expect(diagnosisTurn.prompt).toContain("[DG-1]");
      expect(continuation.mode).toBe("resume");
      expect(continuation.protocolOnly).toBe(false);
      expect(continuation.prompt).toContain("계속 진행 1/");
      expect(continuation.prompt).toContain(`반환 kind 는 ${kind}`);
      expect(continuation.prompt).toContain("중재자 진단 DG-1");
      expect(atContinuation).toEqual({ state: workState, diagnosis: "delivered", codexPrompts: codexBeforeApply });
      const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > applySequence);
      const continued = after.find((event) => event.payload?.continuation === 1);
      expect(continued).toBeTruthy();
      expect((continued!.payload?.remainingSteps as string[]).some((step) => step.includes("DG-1"))).toBe(true);
      // 2) 리뷰 전이는 계속 진행 뒤에야 일어났다 — 작업 → 리뷰 → 인도 대기 순이고, 리뷰어가 받은 보고의 DG-1 은 반영(RESOLVED_BY_FIX)이다.
      const transitions = after.filter((event) => typeof event.payload?.to === "string");
      expect(transitions.map((event) => event.payload?.to)).toEqual([workState, reviewState, "READY_TO_DELIVER"]);
      expect(transitions[1].sequence).toBeGreaterThan(continued!.sequence);
      expect(r.codex.prompts).toHaveLength(codexBeforeApply + 1);
      const review = r.codex.prompts.at(-1)!;
      expect(review.includes("반환 kind는 FINAL_REVIEW")).toBe(fixPath);
      const marker = "Claude 구현 보고:\n";
      const start = review.indexOf(marker) + marker.length;
      const report = JSON.parse(review.slice(start, review.indexOf("\n\n", start))) as AgentResult;
      expect(report.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("RESOLVED_BY_FIX");
      // 3) 최종: 인도 대기·재개 단계 없음, DG-1 은 반영 보고 → 해결, 자동 수정 회차 미사용, 커밋 가능.
      expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
      expect(r.database.getFlags(r.topicId).resumeState).toBeNull();
      expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
      expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
      expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 반영 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
      r.database.close();
    });
  }

  it("저장 전 계획 개정이 개정 계획 산출물 저장과 개정 기록 사이에서 끊긴 뒤 수정 불필요 정정으로 구현을 되살리면, 구현·리뷰는 승인·ACK 되지 않은 최신 계획이 아니라 현재 계획 sha 의 승인 계획을 싣는다(2026-09-15 감사 #12)", { timeout: 60_000 }, async () => {
    const unapprovedLine = "미승인 개정 DG-1: 승인·ACK 전에 저장만 된 감사 단계 — 이 문구가 구현·리뷰에 실리면 안 된다.";
    const r = await room("unapproved-revised-plan", []);
    r.claude["steps"].push(
      // 첫 구현 턴 — 구현 세션(impl-session)을 만든 뒤 프로세스가 죽는다(FAILED, 재개 IMPLEMENTING).
      () => { throw new Error("구현 턴 프로세스 비정상 종료"); },
      // 진단 계획 개정 턴(일회용 세션) — 프로세스가 죽는다(FAILED, 재개 CLAUDE_PLAN). 개정 계획은 아직 저장 전이다.
      () => { throw new Error("개정 턴 프로세스 비정상 종료"); },
      // 정정 뒤 retry 의 구현 턴 — 직전 턴이 시작 직후 죽어 CLI 가 구현 세션을 찾지 못한다. 실행기가 전문 프롬프트의 새 세션으로 폴백한다.
      () => { throw new Error("No conversation found with session ID impl-session"); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "승인 계획 구현\n"); return result("IMPLEMENTATION", "승인 계획대로 구현했습니다.", { status: "completed" }); },
    );
    const approvedSHA = r.database.getTopic(r.topicId).planSHA256!;
    const approved = (await r.artifacts.readLatest(r.topicId, "plan"))!;
    expect(hashPlan(approved)).toBe(approvedSHA);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(r.database.getFlags(r.topicId).implementationSessionId).toBe("impl-session");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(r.claude.turns[1].planMode).toBe(true);
    expect(r.claude.turns[1].prompt).toContain("[DG-1]");

    // 중단 모사: saveDiagnosisRevisedPlan 의 writeArtifact("plan") 까지만 되고 markPlanRevised 전에 끊겼다 — 같은 DB·디렉터리의 산출물 저장소에 직접 쓴다.
    const lines = approved.trimEnd().split("\n");
    const unapproved = `${[lines[0], unapprovedLine, ...lines.slice(1)].join("\n")}\n`;
    const unapprovedArtifact = await r.artifacts.write(r.topicId, "plan", r.database.latestArtifactRevision(r.topicId, "plan") + 1, unapproved);
    expect(hashPlan((await r.artifacts.readLatest(r.topicId, "plan"))!)).not.toBe(approvedSHA);
    expect(r.database.getTopic(r.topicId).planSHA256).toBe(approvedSHA);
    expect(r.database.getTopic(r.topicId).approvedPlanSHA256).toBe(approvedSHA);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied"]);

    // 저장 전 개정의 정정(수정 불필요) — 멈췄던 구현 단계로 재개 단계를 되돌린다(옛 승인 계획 유지).
    const closing = {
      kind: "no_action", title: "계획 변경 불필요", observedFailure: "게이트 2 F1 SIGTRAP", cause: "승인 계획 범위 안에서 해결됩니다.",
      evidenceRefs: ["gate2-rerun.log"], supersedes: "DG-1",
    };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, closing, { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");

    const after = r.database.getTopic(r.topicId);
    expect(after.planSHA256).toBe(approvedSHA);
    expect(after.approvedPlanSHA256).toBe(approvedSHA);
    expect(r.claude.turns.map((turn) => turn.mode)).toEqual(["create", "create", "resume", "create"]);
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.missingSessionId === "impl-session")).toBe(true);
    const [, , resumed, implementation] = r.claude.turns;
    for (const turn of [resumed, implementation]) {
      expect(turn.protocolOnly).toBe(false);
      expect(turn.prompt).toContain(`계획 SHA-256: ${approvedSHA}`);
      expect(turn.prompt).not.toContain(unapprovedLine);
      expect(turn.prompt).not.toContain("계획 개정 알림");
    }
    // 폴백한 새 세션의 전문 프롬프트는 현재 계획 sha 의 승인 원문을 싣는다(최신 산출물인 미승인 개정본이 아니다).
    expect(implementation.prompt).toContain(`승인된 계획:\n---\n${approved}\n---`);
    // 러너·리뷰어에게 넘기는 계획 경로(읽기 허용·재읽기 안내)도 같은 승인 산출물이다 — 본문만 승인본이고 경로가 미승인 개정본을 가리키면 안 된다.
    const approvedPath = (await r.artifacts.verifiedRevision(r.topicId, "plan", approvedSHA))!.path;
    expect(approvedPath).not.toBe(unapprovedArtifact.path);
    for (const turn of [resumed, implementation]) {
      expect(turn.readablePaths).toContain(approvedPath);
      expect(turn.readablePaths).not.toContain(unapprovedArtifact.path);
      expect(turn.prompt).not.toContain(unapprovedArtifact.path);
    }
    const reviews = r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 REVIEW"));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(`승인된 계획 SHA-256: ${approvedSHA}\n승인된 계획:\n---\n${approved}\n---`);
    expect(reviews[0]).not.toContain(unapprovedLine);
    const reviewReadable = r.codex.readable[r.codex.prompts.indexOf(reviews[0])];
    expect(reviewReadable).toContain(approvedPath);
    expect(reviewReadable).not.toContain(unapprovedArtifact.path);
    expect(reviews[0]).not.toContain(unapprovedArtifact.path);
    expect(r.codex.prompts.some((prompt) => prompt.includes("반환 kind는 AUDIT"))).toBe(false);
    const records = await r.diagnoses();
    expect(records.map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    expect(records[0].history.map((entry) => entry.status)).not.toContain("plan_revised");
    r.database.close();
  });

  it("저장만 되고 기록되지 않은 개정 계획 산출물이 최신으로 남아 있어도 새 계획 변경 진단은 승인 계획을 기준으로 개정한다 — 최신 산출물과 다르다고 적용을 막지 않는다(2026-09-15 감사 #12 후속)", { timeout: 60_000 }, async () => {
    const unapprovedLine = "미승인 개정 DG-1: 저장만 된 감사 단계 — 새 개정의 기준이 되면 안 된다.";
    const r = await room("orphan-revision-base", []);
    r.claude["steps"].push(
      () => { throw new Error("구현 턴 프로세스 비정상 종료"); },
      () => { throw new Error("개정 턴 프로세스 비정상 종료"); },
      // 새 계획 변경 진단(DG-3)의 개정 턴 — 기준 계획만 확인하고 끝낸다.
      () => { throw new Error("두 번째 개정 턴 종료"); },
    );
    const approvedSHA = r.database.getTopic(r.topicId).planSHA256!;
    const approved = (await r.artifacts.readLatest(r.topicId, "plan"))!;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    // 개정 턴이 계획 산출물 저장과 개정 기록 사이에서 끊긴 모사 — 미승인 개정본이 최신 plan 산출물로 남는다.
    const lines = approved.trimEnd().split("\n");
    await r.artifacts.write(r.topicId, "plan", r.database.latestArtifactRevision(r.topicId, "plan") + 1, `${[lines[0], unapprovedLine, ...lines.slice(1)].join("\n")}\n`);
    const closing = {
      kind: "no_action", title: "계획 변경 불필요", observedFailure: "게이트 2 F1 SIGTRAP", cause: "승인 계획 범위 안에서 해결됩니다.",
      evidenceRefs: ["gate2-rerun.log"], supersedes: "DG-1",
    };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, closing, { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");

    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis({ title: "다시 계획 변경" }), { mediator: true })).status).toBe(201);
    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-3/apply`, undefined, { mediator: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    await r.idle("FAILED");
    const revision = r.claude.turns[2];
    expect(revision.planMode).toBe(true);
    expect(revision.prompt).toContain("[DG-3]");
    expect(/기준 SHA-256: ([0-9a-f]{64})/.exec(revision.prompt)?.[1]).toBe(approvedSHA);
    expect(revision.prompt).not.toContain(unapprovedLine);
    expect(r.database.getTopic(r.topicId).planSHA256).toBe(approvedSHA);
    r.database.close();
  });

  it("진단 계획 개정 턴의 반박이 계약 교정 턴 사망으로 교정 원본에만 남으면 retry 는 새 개정 턴을 사지 않고 refuted 로 기록해 중재자에게 돌려보낸다(2026-09-15 감사 #14)", { timeout: 30_000 }, async () => {
    const r = await room("plan-refute-repair-crash", []);
    const refuted: Finding = {
      id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "REFUTED", rationale: "계획 R-3 이 이미 같은 감사를 요구합니다.",
      evidenceRefs: ["plan:R-3"], requiresUserDecision: false,
    };
    r.claude["steps"].push(
      // 구현 턴이 파일을 바꾼 뒤 죽는다 — FAILED/IMPLEMENTING(브랜치·구현 기준 커밋·구현 세션은 생성됨).
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); throw new Error("구현 턴 프로세스 비정상 종료"); },
      // 진단 계획 개정 턴: DG-1 을 반박하면서 계획 단계에서 쓸 수 없는 RESOLVED_BY_FIX 를 함께 낸다 → 계약 교정으로 간다(교정 원본에 REFUTED 가 남는다).
      () => result("REVISION", "진단이 틀렸습니다.", { planEdits: [], findings: [refuted, resolved("N-1", { title: "노트", severity: "LOW", rationale: "고쳤음" })] }),
      // 계약 교정 턴이 spawn 뒤 죽는다 — FAILED/CLAUDE_PLAN, DG-1 은 적용됨(applied)에 머문다.
      () => { throw new Error("계약 교정 턴 프로세스 비정상 종료"); },
      // 수정 전 코드라면 retry 가 같은 지시로 이 개정 턴을 다시 샀다 — 소비되면 안 된다.
      () => result("REVISION", "진단이 틀렸습니다.", { planEdits: [], findings: [refuted] }),
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    const before = r.database.getTopic(r.topicId);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    // 교정 사망 뒤: 반박은 교정 원본(contract-repair-source)에만 있고 진단은 적용됨에 머문다. 옛 승인 계획이 그대로다.
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied"]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.claude.turns[1].planMode).toBe(true);
    expect(r.claude.turns[1].prompt).toContain("[DG-1]");
    expect(r.claude.turns[2].prompt).toContain("RESOLVED_BY_FIX 처분을 쓸 수 없습니다");
    const source = JSON.parse((await r.artifacts.readLatest(r.topicId, "contract-repair-source"))!) as { state: string; original: { findings: Finding[] } };
    expect(source.state).toBe("CLAUDE_PLAN");
    expect(source.original.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("REFUTED");
    const revisionsBefore = r.database.revisions.account(r.topicId).used;

    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    // 새 개정 턴 없이 교정 원본의 반박을 기록하고 멈춘다 — 러너 턴 수·재작성 집계가 그대로다.
    expect(r.claude.turns).toHaveLength(3);
    expect(r.database.revisions.account(r.topicId).used).toBe(revisionsBefore);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "refuted"]);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(r.database.getTopic(r.topicId).lastError).toContain("교정 도중 끊긴 응답");
    expect(r.database.getTopic(r.topicId).lastError).toContain("DG-1 반박");
    expect(r.database.getTimeline(r.topicId).some((event) =>
      Array.isArray(event.payload?.diagnosisReturned) && (event.payload?.diagnosisReturned as string[]).includes("DG-1"))).toBe(true);
    const after = r.database.getTopic(r.topicId);
    expect(after.planSHA256).toBe(before.planSHA256);
    expect(after.approvedPlanSHA256).toBe(before.approvedPlanSHA256);
    // 반박된 진단은 중재자 정정 전의 재개를 막는다 — 같은 지시를 다시 싣지 않는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    expect(r.claude.turns).toHaveLength(3);
    r.database.close();
  });

  it("계획 변경 진단의 개정 계획으로 여는 첫 구현 턴이 spawn 뒤 죽으면 retry 턴도 진단과 함께 개정 알림·개정 계획 전문을 다시 싣는다 — 같은 계획이라고 안내하지 않는다(2026-09-15 감사 #15)", { timeout: 60_000 }, async () => {
    const revisedLine = "진단 DG-1: witness 감사 단계를 추가한다.";
    const notice = "계획 개정 알림(중재자 진단 DG-1)";
    const r = await room("plan-revision-first-turn-crash", [], { codex: "planning" });
    r.claude["steps"].push(
      // 구현 턴이 파일을 바꾼 뒤 죽는다 — 구현 세션(impl-session)이 생긴 채 FAILED(재개 IMPLEMENTING)로 멈춰, 개정 뒤 구현이 이 세션을 이어받는다(세션 유실 폴백 없음).
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); throw new Error("구현 턴 프로세스 비정상 종료"); },
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: `${revisedLine}\n` }] },
          findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 감사 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
      // 개정 계획 승인 뒤 첫 구현 턴 — 개정 알림·전문을 받은 채 처분 보고 전에 죽는다(spawn 뒤라 DG-1 은 전달됨으로 기록된다).
      () => { throw new Error("개정 계획 첫 구현 턴 프로세스 비정상 종료"); },
      () => {
        writeFileSync(join(r.worktree, "feature.txt"), "개정 계획 구현\n");
        return result("IMPLEMENTATION", "개정 계획대로 구현했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(r.database.getFlags(r.topicId).implementationSessionId).toBe("impl-session");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised"]);
    const revised = r.database.getTopic(r.topicId);
    expect(await r.artifacts.readLatest(r.topicId, "plan")).toContain(revisedLine);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: revised.planSHA256 })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    // 첫 전달은 개정 알림·전문을 실었고, 처분 보고 전에 끊겨 DG-1 은 전달됨(delivered)에 머문다 — 구현 세션은 그대로다.
    expect(r.claude.turns).toHaveLength(5);
    expect(r.claude.turns[4].mode).toBe("resume");
    expect(r.claude.turns[4].prompt).toContain(notice);
    expect(r.claude.turns[4].prompt).toContain(revisedLine);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(r.database.getFlags(r.topicId).implementationSessionId).toBe("impl-session");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised", "delivered"]);

    // retry — 같은 세션을 이어받지만 개정을 받았다는 보장이 없으므로(처분 미보고) R5 와 같은 기준으로 개정 알림과 개정 계획 전문을 다시 싣는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(6);
    const retried = r.claude.turns[5];
    expect(retried.mode).toBe("resume");
    expect(retried.protocolOnly).toBe(false);
    expect(retried.prompt).toContain("[DG-1]");
    expect(retried.prompt).toContain(notice);
    expect(retried.prompt).toContain(revisedLine);
    expect(retried.prompt).not.toContain("이 세션에 이미 전달한 계획과 같은 전문입니다");
    expect(retried.prompt).not.toContain("이 구현 세션의 이어지는 턴입니다");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status))
      .toEqual(["registered", "applied", "plan_revised", "delivered", "fix_reported", "resolved"]);
    expect(r.database.getTopic(r.topicId).planSHA256).toBe(revised.planSHA256);
    r.database.close();
  });

  it("이전 범위 세대의 진단은 현재 세대에서 정정(supersedes)으로 받지 않는다 — 409 로 거부하고 현재 세대 수정 정지의 재개 단계(CLAUDE_FIX)를 바꾸지 않는다(2026-09-15 감사 #16)", { timeout: 60_000 }, async () => {
    const r = await room("previous-generation-supersedes", [], { codex: "scope-finding" });
    r.claude["steps"].push(
      // 1세대: 구현 → 인도 대기에서 적용한 진단 전용 수정 DG-1 을 러너가 반박한다(DG-1 은 1세대 refuted 로 남는다).
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        return result("FIX", "진단이 틀렸습니다.", {
          status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "외부 검증 실패는 이 변경과 무관합니다." }],
        });
      },
      // 2세대: 새 범위 계획·감사 답변·ACK·구현. 첫 리뷰가 F-1 을 내고, 일반 수정 턴이 응답 전에 죽는다(FAILED/CLAUDE_FIX).
      () => result("PLAN", "새 범위 계획입니다.", { planMarkdown: plan() }),
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
      () => {
        writeFileSync(join(r.database.getTopic(r.topicId).worktreePath, "feature.txt"), "새 범위 구현\n");
        return result("IMPLEMENTATION", "새 범위를 구현했습니다.", { status: "completed" });
      },
      (turn) => { expect(turn.prompt).toContain('"id": "F-1"'); throw new Error("수정 턴 프로세스 비정상 종료"); },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses()).map((item) => [item.id, item.status, item.binding.scopeGeneration])).toEqual([["DG-1", "refuted", 1]]);

    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "scope_change", body: "범위를 바꿉니다." })).status).toBe(200);
    expect(r.database.getTopic(r.topicId).scopeGeneration).toBe(2);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/plan`)).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: r.database.getTopic(r.topicId).planSHA256 })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    // 2세대 일반 수정 정지(재개 CLAUDE_FIX) — 인도 단계의 정지라 진단 등록 자체는 받는 상태다.
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(7);
    const historyBefore = (await r.diagnoses())[0].history.map((entry) => entry.status);
    const timelineBefore = r.database.getTimeline(r.topicId).length;

    // 이전 세대 DG-1 을 정정하는 등록은 종류(수정 불필요·수정)와 무관하게 거부한다 — 옛 사슬의 진단 전용 수정 경로를 현재 세대로 물려받지 않는다.
    for (const [kind, title] of [["no_action", "옛 세대 진단 정리"], ["fix", "옛 세대 진단 정정"]] as const) {
      const refused = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ kind, title, supersedes: "DG-1" }), { mediator: true });
      expect(refused.status, kind).toBe(409);
      expect(String(refused.body.error), kind).toContain("이전 범위 세대");
      expect(r.database.getTopic(r.topicId).state, kind).toBe("FAILED");
      expect(r.database.getFlags(r.topicId).resumeState, kind).toBe("CLAUDE_FIX");
    }
    const listed = await r.diagnoses();
    expect(listed.map((item) => [item.id, item.status, item.binding.scopeGeneration])).toEqual([["DG-1", "refuted", 1]]);
    expect(listed[0].history.map((entry) => entry.status)).toEqual(historyBefore);
    expect(r.database.getTimeline(r.topicId)).toHaveLength(timelineBefore);

    // retry 는 최종 리뷰가 아니라 멈췄던 일반 수정 턴을 다시 연다 — 그 앞에 Codex 턴이 끼지 않고, 옛 세대 진단을 싣지 않는다.
    const codexBefore = r.codex.prompts.length;
    r.claude["steps"].push((turn) => {
      expect(r.codex.prompts).toHaveLength(codexBefore);
      expect(turn.protocolOnly).toBe(false);
      expect(turn.prompt).toContain('"id": "F-1"');
      expect(turn.prompt).not.toContain("[DG-1]");
      writeFileSync(join(r.database.getTopic(r.topicId).worktreePath, "feature.txt"), "새 범위 결함 수정\n");
      return result("FIX", "F-1 을 고쳤습니다.", { status: "completed", findings: [resolved("F-1")] });
    });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(8);
    expect(r.codex.prompts.slice(codexBefore).map((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toEqual([true]);
    r.database.close();
  });

  it("저장·승인까지 끝난 계획 변경 진단이 개정 계획의 구현 턴에서 반박되면 '저장 전 개정'으로 분류하지 않는다 — 허용 오차 개정은 미저장 사유로 막히지 않고, 다른 진단 적용은 반박된 DG-1 처리 대기만을 사유로 막힌다(2026-09-15 감사 #17)", { timeout: 60_000 }, async () => {
    let openId = "";
    const r = await room("plan-refuted-after-save", [], { codex: "planning", tolerance: TIGHT_TOLERANCE });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: "진단 DG-1: witness 감사 단계를 추가한다.\n" }] },
          findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 감사 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
      // 승인된 개정 계획의 구현 턴 — 러너가 DG-1 을 반박하고, 승계된 열린 요청은 해소한다.
      (turn) => {
        expect(turn.prompt).toContain("계획 개정 알림(중재자 진단 DG-1)");
        return result("IMPLEMENTATION", "DG-1 은 불필요해 반박합니다.", {
          status: "completed", findings: [resolved("DG-1", { disposition: "REFUTED", rationale: "개정 계획의 감사 단계는 불필요합니다." })],
          resolvesRequestedDecision: true, resolvedRequestId: openId,
        });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    const revised = r.database.getTopic(r.topicId);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: revised.planSHA256 }, { mediator: true })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");

    // 개정 계획은 저장·승인됐고, 그 구현 턴이 DG-1 을 반박해 멈췄다(재개 단계 IMPLEMENTING).
    const stopped = r.database.getTopic(r.topicId);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(stopped.planSHA256).toBe(revised.planSHA256);
    expect(stopped.approvedPlanSHA256).toBe(revised.planSHA256);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised", "delivered", "refuted"]);
    const turns = r.claude.turns.length;
    expect(turns).toBe(5);

    // 허용 오차 개정은 '개정 계획이 아직 저장·승인되지 않았다'는 사실과 다른 사유로 막히지 않는다 — 넓히기가 그대로 적용된다.
    const amend = await r.call("POST", `/api/topics/${r.topicId}/actions/amend-tolerance`,
      { tolerance: { scopePaths: ["feature.txt", "docs/**"], rules: [] }, reason: "문서 경로까지 넓힙니다." }, { mediator: true });
    expect(String(amend.body.error ?? "")).not.toContain("아직 저장");
    expect(amend.status).toBe(200);
    const amended = r.database.getTopic(r.topicId);
    expect(amended.planSHA256).not.toBe(revised.planSHA256);
    expect(amended.approvedPlanSHA256).toBe(amended.planSHA256);
    expect(await r.artifacts.readLatest(r.topicId, "plan")).toContain("docs/**");
    expect(amended.state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");

    // retry 는 반박된 DG-1(중재자 처리 대기)에만 막힌다 — 미저장 개정을 사유로 들지 않는다.
    const retry = await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(retry.status).toBe(409);
    expect(String(retry.body.error)).toContain("DG-1(러너 반박)");
    expect(String(retry.body.error)).not.toContain("아직 저장");

    // 다른 진단의 적용은 먼저 처리할 DG-1 을 사유로만 거부되고, 기록(적용)을 남기지 않는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "다른 witness 의 격리" }), { mediator: true })).status).toBe(201);
    const applyOther = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true });
    expect(applyOther.status).toBe(409);
    expect(String(applyOther.body.error)).toContain("먼저 처리할 진단");
    expect(String(applyOther.body.error)).toContain("DG-1(러너 반박)");
    expect(String(applyOther.body.error)).not.toContain("아직 저장");
    const records = await r.diagnoses();
    expect(records.map((item) => [item.id, item.status])).toEqual([["DG-1", "refuted"], ["DG-2", "registered"]]);
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(r.claude.turns).toHaveLength(turns);
    r.database.close();
  });

  it("진단 개정 계획 저장 직후 새 입력으로 멈추면 retry 는 저장된 개정 계획으로 감사부터 잇는다 — 개정 턴을 다시 사지 않고 전체 재계획으로 DG-1 을 재확인(stale)으로 돌리지 않는다(2026-09-15 감사 #19)", { timeout: 60_000 }, async () => {
    const revisedLine = "진단 DG-1: 클러스터 전략 witness 감사 단계를 추가한다.";
    const evidenceBody = "개정 저장 직후 도착한 외부 증거: 게이트 2 F1 재실행 로그";
    const isDiagnosisRevisionTurn = (turn: ClaudeTurn) => turn.prompt.includes("승인된 계획의 변경");
    const r = await room("saved-revision-interrupt", [], { codex: "planning" });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      // 진단 계획 개정 턴 — 이 시나리오에서 단 한 번만 열린다.
      (turn) => {
        expect(isDiagnosisRevisionTurn(turn)).toBe(true);
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: `${revisedLine}\n` }] },
          findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      // retry 뒤: 감사 답변 개정(무변경) → ACK. 진단 개정 턴이 다시 열리면 여기서 드러난다.
      (turn) => {
        expect(isDiagnosisRevisionTurn(turn)).toBe(false);
        return result("REVISION", "감사에 답했습니다.", { planEdits: [] });
      },
      ackWith,
    );
    // markPlanRevised 의 plan_revised 기록(개정 계획 저장 transaction) 직후 사용자 증거가 같은 DB 에 도착한다 — 저장 뒤 interruptForLatestTurnInput 이
    // USER_DECISION_REQUIRED(resume CLAUDE_PLAN)로 멈춘다(감사가 지목한 저장 await 사이의 좁은 창).
    const recordStatus = r.database.recordDiagnosisStatus.bind(r.database);
    let injected = 0;
    r.database.recordDiagnosisStatus = (input: Parameters<ConsensusDatabase["recordDiagnosisStatus"]>[0]) => {
      recordStatus(input);
      if (injected > 0 || !input.entries.some((entry) => entry.status === "plan_revised")) return;
      injected += 1;
      r.database.appendEvent({ topicId: r.topicId, actor: "user", kind: "evidence", state: r.database.getTopic(r.topicId).state, body: evidenceBody });
    };
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    const before = r.database.getTopic(r.topicId);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");

    // 개정 계획은 저장됐고(plan_revised·새 planSHA·승인 무효화) 감사 전에 새 입력으로 멈췄다.
    expect(injected).toBe(1);
    const stopped = r.database.getTopic(r.topicId);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(stopped.lastError).toContain("새 메시지가 추가되었습니다");
    expect(stopped.approvedPlanSHA256).toBeNull();
    expect(stopped.planSHA256).not.toBe(before.planSHA256);
    expect(stopped.planRevision).toBe(before.planRevision + 1);
    const savedPlan = (await r.artifacts.readLatest(r.topicId, "plan"))!;
    expect(savedPlan).toContain(revisedLine);
    expect(hashPlan(savedPlan)).toBe(stopped.planSHA256);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised"]);
    expect(r.codex.prompts.some((prompt) => prompt.includes("반환 kind는 AUDIT"))).toBe(false);
    expect(r.claude.turns).toHaveLength(2);

    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    // 개정 턴을 다시 사지 않았다 — 진단 개정 턴 1회 뒤에는 감사 답변 개정과 ACK 만 있다.
    expect(r.claude.turns.filter(isDiagnosisRevisionTurn)).toHaveLength(1);
    expect(r.claude.turns).toHaveLength(4);
    // 전체 재계획이 없었다 — 계획 주기가 그대로이고 "처음부터" 재시도·첫 계획 턴·재계획 stale 기록이 없으며 DG-1 은 plan_revised 로 남는다.
    const after = r.database.getTopic(r.topicId);
    expect(after.planEpoch).toBe(stopped.planEpoch);
    const timeline = r.database.getTimeline(r.topicId);
    expect(timeline.some((event) => event.body.includes("처음부터"))).toBe(false);
    expect(timeline.some((event) => event.body.includes("Claude가 첫 계획을 작성합니다"))).toBe(false);
    expect(timeline.some((event) => Array.isArray(event.payload?.diagnosisStaleOnReplan))).toBe(false);
    expect(timeline.some((event) => event.body.includes("저장된 진단 개정 계획으로 감사부터 이어갑니다"))).toBe(true);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "plan_revised"]);
    // 감사는 저장된 개정 계획(SHA)·진단 개정 맥락·저장 직후 도착한 증거를 받았다.
    const audits = r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 AUDIT"));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toContain(stopped.planSHA256!);
    expect(audits[0]).toContain("구현 도중의 계획 개정입니다(중재자 진단 DG-1");
    expect(audits[0]).toContain(evidenceBody);
    // 승인 대기 계획은 저장된 개정 계획이다(개정본을 버리지 않았고 판 번호도 되돌아가지 않았다).
    const pendingPlan = (await r.artifacts.readLatest(r.topicId, "plan"))!;
    expect(pendingPlan).toContain(revisedLine);
    expect(hashPlan(pendingPlan)).toBe(after.planSHA256);
    expect(after.planRevision).toBeGreaterThanOrEqual(stopped.planRevision);
    expect(after.approvedPlanSHA256).toBeNull();
    expect(after.participants.every((participant) => participant.acknowledgedPlanSHA256 === after.planSHA256)).toBe(true);
    r.database.close();
  });

  it("최종 리뷰 정지 쟁점을 사용자가 판정한 뒤 적용한 진단 전용 수정에서 러너가 그 결정대로 쟁점을 수정 불필요로 처분하면 수락돼 최종 리뷰를 거쳐 인도 대기·해결에 이른다 — 처분 되돌림 가드가 사용자 판정을 거부하지 않는다(2026-09-15 감사 2차 #1)", { timeout: 60_000 }, async () => {
    const r = await room("stop-adjudicated-before-apply", [], { codex: "final-review-decision" });
    let diagnosisFixPrompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
      // DG-2 진단 수정 턴 — 진단을 반영하고, 최종 리뷰 정지의 F-2 는 사용자 결정대로 수정 불필요로 처분한다(감사 RA 재현의 러너 응답).
      (turn) => {
        diagnosisFixPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영\n");
        return result("FIX", "DG-2 를 반영했고, F-2 는 사용자 결정대로 수정하지 않습니다.", { status: "completed", findings: [resolved("DG-2"), F2_DECIDED_NO_ACTION] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    expect(await g6aSettleWithGrants(r, "stop-adjudicated-before-apply 답변 확인 추가 승인")).toBe("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 A" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    // 첫 최종 리뷰가 DG-1 반영을 확인하면서 F-2(수정 합의 + 사용자 판정 필요)를 내 최종 리뷰 정지에 멈춘다.
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(FINAL_REVIEW_DECISION_FINDING.rationale);
    // DG-2 적용 전에 사용자가 F-2 를 판정한다(수정 불필요).
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "OVERRULE F-2\nF-2 는 결함이 아닙니다 — 수정하지 않습니다." })).status).toBe(200);
    const decisionSequence = r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision").at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 B" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "stop-adjudicated-before-apply 답변 확인 추가 승인")).toBe("READY_TO_DELIVER");

    // 1) 진단 전용 수정 턴(사용자 결정이 보이는 턴) 한 번의 보고가 그대로 수락됐다 — 교정·재시도 턴이 없다.
    expect(diagnosisFixPrompt).toContain("[DG-2]");
    expect(diagnosisFixPrompt).toContain("F-2 는 결함이 아닙니다");
    expect(r.claude.turns).toHaveLength(3);
    // 2) 처분 되돌림 정지가 없었다 — 결정 뒤 전이는 수정 → 최종 리뷰 → 인도 대기 순이다.
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > decisionSequence);
    expect(after.some((event) => event.body.includes("처분을 되돌렸습니다"))).toBe(false);
    expect(after.filter((event) => typeof event.payload?.to === "string").map((event) => event.payload?.to))
      .toEqual(["CLAUDE_FIX", "CODEX_FINAL_REVIEW", "CODEX_FINAL_REVIEW", "READY_TO_DELIVER"]); // 확인 예산 추가 승인 후 같은 리뷰 단계 재개
    // 3) 최종 리뷰는 수락된 결과(DG-2 반영·F-2 수정 불필요)를 대조했고, 두 진단은 반영 보고 → 해결에 이르렀다. 진단 전용 수정은 자동 수정 회차를 쓰지 않는다.
    expect(r.codex.prompts).toHaveLength(3);
    expect(r.codex.prompts[2]).toContain("반환 kind는 FINAL_REVIEW");
    const report = reviewReportIn(r.codex.prompts[2]);
    expect(report.findings.find((finding) => finding.id === "DG-2")?.disposition).toBe("RESOLVED_BY_FIX");
    expect(report.findings.find((finding) => finding.id === "F-2")).toMatchObject({ disposition: "AGREED_NO_ACTION", requiresUserDecision: false });
    const [dg1, dg2] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect(dg2.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    // (보조) 계약 기록: DG-2 의 진단 전용 수정 계약은 최종 리뷰 정지에서 열려 정지 쟁점 F-2 를 원본에 싣고, 사용자 결정의 면제로 수락됐다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.route, contract.origin.stage, contract.diagnosisIds, contract.source.map((finding) => finding.id), contract.status]))
      .toEqual([["diagnosis", "READY_TO_DELIVER", ["DG-1"], [], "accepted"], ["diagnosis", "CODEX_FINAL_REVIEW", ["DG-2"], ["F-2"], "accepted"]]);
    r.database.close();
  });

  it("최종 리뷰 정지 쟁점의 판정 필요를 유지해 멈춘 진단 전용 수정은 사용자가 그 쟁점 id 를 적은 결정을 올리고 retry 하면 러너의 수정 불필요 처분이 수락돼 최종 리뷰를 거쳐 인도 대기·해결에 이른다 — '처분을 되돌렸습니다' 정지로 되돌아가지 않는다(2026-09-15 감사 2차 #1)", { timeout: 60_000 }, async () => {
    const r = await room("stop-adjudicated-after-pause", [], { codex: "final-review-decision" });
    let decisionTurn: ClaudeTurn | undefined;
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
      // DG-2 진단 수정 턴 — 진단만 반영하고 F-2 를 빠뜨려 커버리지 교정을 받는다(감사 #8 흐름).
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영\n"); return result("FIX", "DG-2 를 반영했습니다.", { status: "completed", findings: [resolved("DG-2")] }); },
      // 교정 재제출 — F-2 를 고치지 않고 사용자 판정 필요를 유지한다(감사 #8: 인도 대기로 넘기지 않고 멈춘다).
      () => result("FIX", "F-2 는 사용자 판정이 필요해 고치지 않았습니다.", {
        status: "completed", findings: [resolved("DG-2"), { ...FINAL_REVIEW_DECISION_FINDING, rationale: "F-2 로그 경로는 사용자 판정이 필요해 고치지 않았습니다." }],
      }),
      // 사용자 결정 뒤 retry 가 여는 턴 — 결정대로 F-2 를 수정 불필요(판정 필요 해제)로 처분한다.
      (turn) => { decisionTurn = turn; return result("FIX", "사용자 결정대로 F-2 는 수정하지 않습니다.", { status: "completed", ...resolvePromptRequest(turn), findings: [resolved("DG-2"), F2_DECIDED_NO_ACTION] }); },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    expect(await g6aSettleWithGrants(r, "stop-adjudicated-after-pause 답변 확인 추가 승인")).toBe("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 A" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 B" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    // 감사 #8 의 정지: 러너가 F-2 의 판정 필요를 유지해 수정 단계에서 멈췄다.
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain("F-2 로그 경로는 사용자 판정이 필요해 고치지 않았습니다.");
    expect(r.claude.turns).toHaveLength(4);
    expect(r.codex.prompts).toHaveLength(2);

    // 사용자가 F-2 를 적은 결정을 올리고 retry 한다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "OVERRULE F-2\nF-2 는 결함이 아닙니다 — 수정하지 않습니다." })).status).toBe(200);
    const decisionSequence = r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision").at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "stop-adjudicated-after-pause 답변 확인 추가 승인")).toBe("READY_TO_DELIVER");

    // 1) 결정을 받은 러너 턴(같은 세션)이 F-2 를 수정 불필요로 처분했고, 그 결과가 수락됐다 — 처분 되돌림 정지가 없었다.
    expect(r.claude.turns).toHaveLength(5);
    expect(decisionTurn?.mode).toBe("resume");
    expect(decisionTurn?.prompt).toContain("F-2 는 결함이 아닙니다");
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > decisionSequence);
    expect(after.some((event) => event.body.includes("처분을 되돌렸습니다"))).toBe(false);
    expect(after.filter((event) => typeof event.payload?.to === "string").map((event) => event.payload?.to))
      .toEqual(["CLAUDE_FIX", "CODEX_FINAL_REVIEW", "CODEX_FINAL_REVIEW", "READY_TO_DELIVER"]); // 확인 예산 추가 승인 후 같은 리뷰 단계 재개
    // 2) 최종 리뷰는 수락된 결과(F-2 수정 불필요)를 대조했고, 저장된 최종 리뷰의 F-2 는 판정 필요가 풀린 수정 불필요다.
    expect(r.codex.prompts).toHaveLength(3);
    expect(r.codex.prompts[2]).toContain("반환 kind는 FINAL_REVIEW");
    expect(reviewReportIn(r.codex.prompts[2]).findings.find((finding) => finding.id === "F-2")).toMatchObject({ disposition: "AGREED_NO_ACTION", requiresUserDecision: false });
    const storedFinal = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review")) ?? "{}") as AgentResult;
    expect(storedFinal.findings.find((finding) => finding.id === "F-2")).toMatchObject({ disposition: "AGREED_NO_ACTION", requiresUserDecision: false });
    // 3) 두 진단은 반영 보고 → 해결에 이르렀고 자동 수정 회차는 쓰지 않았다. 커밋이 열린다.
    const [dg1, dg2] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect(dg2.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    // (보조) 계약 기록: DG-2 계약은 정지 쟁점 F-2 를 원본에 실은 채 수락됐다(사용자 결정이 F-2 를 면제했다).
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.route, contract.diagnosisIds, contract.source.map((finding) => finding.id), contract.status]))
      .toEqual([["diagnosis", ["DG-1"], [], "accepted"], ["diagnosis", ["DG-2"], ["F-2"], "accepted"]]);
    r.database.close();
  });

  it("수정 불필요 정정으로 최종 리뷰에 돌아가도 대조 보고는 수락된 수정 결과이고 반환된 진단 전용 수정 결과가 아니다 — 정지 쟁점 F-2 는 커버리지가 판정을 요구하고, 리뷰어가 미결로 두면 사용자 결정 없이 닫히거나 커밋되지 않는다(2026-09-15 감사 2차 #4)", { timeout: 60_000 }, async () => {
    const runnerAlone = "러너 단독 판단: 로그 경로는 그대로 둬도 됩니다.";
    const r = await room("closed-contract-final-source", [], { codex: "review-fix-final-stop" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 일반 수정(리뷰 수정 계약) — F-1 을 고친다. 이 결과는 수락돼 최종 리뷰로 넘어간다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "F-1 수정\n"); return result("FIX", "F-1 을 고쳤습니다.", { status: "completed", findings: [resolved("F-1")] }); },
      // 최종 리뷰 정지에서 적용한 진단 전용 수정 — DG-1 은 반박하고, 정지 쟁점 F-2 는 사용자 결정 없이 러너 혼자 수정 불필요로 내린다(수락 가드를 거치지 않는 반환 결과).
      () => result("FIX", "DG-1 은 무관합니다. F-2 는 조치 불필요로 봅니다.", {
        status: "completed", findings: [
          { ...resolved("DG-1"), disposition: "REFUTED", rationale: "외부 검증 실패는 이 변경과 무관합니다." },
          { ...FINAL_REVIEW_DECISION_FINDING, disposition: "AGREED_NO_ACTION", requiresUserDecision: false, rationale: runnerAlone },
        ],
      }),
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    // 첫 리뷰 F-1 → 일반 수정 → 첫 최종 리뷰가 F-2 로 멈춘다(재개 CODEX_FINAL_REVIEW, 자동 수정 1회차 소비).
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect(r.database.getTopic(r.topicId).lastError).toContain(FINAL_REVIEW_DECISION_FINDING.rationale);
    expect(r.claude.turns).toHaveLength(2);
    // 진단 전용 수정 — 러너가 DG-1 을 반박해 결과가 수락되지 않고 반환된다(refuted, 재개 CLAUDE_FIX). 이 턴에는 F-2 가 실렸다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.claude.turns).toHaveLength(3);
    expect(r.claude.turns[2].prompt).toContain('"id": "F-2"');
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses())[0].status).toBe("refuted");
    // 러너 반박을 수용해 수정 불필요로 정정하면 최종 리뷰 단계로 돌아간다.
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const codexBeforeRetry = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    // 인도 대기로 가지 않는다 — F-2 를 적지 않은 최종 리뷰는 커버리지 검사에 걸려 교정을 요구받고, 이 흐름에서는 그 교정 호출이 구현 리뷰 한도에 걸려 멈춘다.
    await r.idle("USER_DECISION_REQUIRED");

    // 1) 러너 턴은 더 열리지 않았다. 최종 리뷰의 대조 보고는 수락된 F-1 수정 결과다 — 반환된 결과(DG-1 반박·F-2 러너 단독 하향)가 아니다.
    expect(r.claude.turns).toHaveLength(3);
    const finalReviews = r.codex.prompts.slice(codexBeforeRetry).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finalReviews).toHaveLength(1);
    expect(reviewReportIn(finalReviews[0]).findings.map((finding) => [finding.id, finding.disposition])).toEqual([["F-1", "RESOLVED_BY_FIX"]]);
    // 최종 리뷰 프롬프트는 서버가 처분을 요구하는 정지 쟁점 F-2 를 "수정 작업의 원본 쟁점" 절로 싣는다 — 리뷰어가 모른 채 답해 누락 교정을 사지 않게(감사 2차 후속).
    expect(finalReviews[0]).toContain("수정 작업의 원본 쟁점");
    expect(finalReviews[0]).toContain('"id": "F-2"');
    expect(finalReviews[0]).not.toContain(runnerAlone);
    // 2) F-2 는 최종 리뷰의 커버리지가 요구한다 — F-2 를 적지 않은 리뷰는 러너 처분으로 승계되지 않고 계약 위반으로 거부됐다. 통과(인도 대기) 기록이 없다.
    const afterRetry = r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence);
    expect(afterRetry.some((event) => event.body.includes("검토 쟁점을 누락했습니다: F-2"))).toBe(true);
    expect(afterRetry.some((event) => event.body.includes("최종 읽기 전용 리뷰를 통과했습니다"))).toBe(false);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 3) 저장된 최종 리뷰에 러너 단독 처분(F-2 수정 불필요)이 승계되지 않았다 — F-2 는 여전히 수정 합의 + 판정 필요다. 커밋은 거부된다.
    const finalAfterRetry = (await r.artifacts.readLatest(r.topicId, "codex-final-review")) ?? "{}";
    expect(finalAfterRetry).not.toContain(runnerAlone);
    expect((JSON.parse(finalAfterRetry) as AgentResult).findings.find((finding) => finding.id === "F-2")).toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true });
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 없이 인도", paths: ["feature.txt"] });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(String(blocked.body.error)).toContain("READY_TO_DELIVER");

    // 리뷰 1회를 추가 승인하고 재개하면 같은 세션의 교정이 F-2 를 지목하고, 리뷰어는 F-2 를 판정 필요인 채 유지한다.
    // (review-resume 은 승인을 기록하지만 이 방에는 토큰·시간 예산 계정이 없어 재개를 보류(resumeBlocked)한다 — retry 로 재개한다.)
    const codexBeforeGrant = r.codex.prompts.length;
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    const correction = r.codex.prompts.slice(codexBeforeGrant).find((prompt) => prompt.includes("서버 기계 검사가 방금 응답을 거부했습니다"));
    expect(correction).toBeTruthy();
    expect(correction).toContain("검토 쟁점을 누락했습니다: F-2");
    // 4) 리뷰어가 미결로 둔 F-2 는 최종 리뷰 정지로 남는다 — 저장된 최종 리뷰의 F-2 는 리뷰어 자신의 판정(수정 합의 + 판정 필요)이다.
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(STOP_FINDING_KEPT_UNDECIDED);
    const storedFinal = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review")) ?? "{}") as AgentResult;
    expect(storedFinal.findings.find((finding) => finding.id === "F-2"))
      .toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true, rationale: STOP_FINDING_KEPT_UNDECIDED });
    expect(r.claude.turns).toHaveLength(3);
    // 5) 사용자 결정은 한 건도 없었다 — 커밋은 인도 대기 요구로 거부되고 상태는 그대로다.
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 없이 인도", paths: ["feature.txt"] });
    expect(commit.status).toBeGreaterThanOrEqual(400);
    expect(String(commit.body.error)).toContain("READY_TO_DELIVER");
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    // (보조) 계약 기록: F-1 리뷰 수정 계약만 수락됐고, F-2 를 원본으로 실은 진단 전용 수정 계약은 수정 없이 닫혔다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.route, contract.source.map((finding) => finding.id), contract.status]))
      .toEqual([["review", ["F-1"], "accepted"], ["diagnosis", ["F-2"], "closed"]]);
    r.database.close();
  });

  it("최종 리뷰 정지가 되돌린 반영 보고 진단(DG-1)의 판정은 다음 진단 전용 수정(DG-2)의 원본에 실려 러너가 처분해야 하고, 다음 최종 리뷰가 DG-1 을 판정하기 전에는 DG-1 이 해결되지도 커밋되지도 않는다(2026-09-15 감사 2차 #3)", { timeout: 60_000 }, async () => {
    const r = await room("final-stop-diagnosis-verdict", [], { codex: "final-diagnosis-verdict" });
    let diagnosisFixPrompt = "";
    let correctionPrompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n");
        return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
      // DG-2 진단 전용 수정 턴 — DG-1 도 다시 고쳤지만 보고에는 DG-2 만 담는다. 원본에 실린 DG-1 판정을 빠뜨렸으니 서버 커버리지 검사가 1회 교정을 요구해야 한다.
      (turn) => {
        diagnosisFixPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-1 재수정 · DG-2 반영\n");
        return result("FIX", "DG-2 를 반영했습니다.", { status: "completed", findings: [resolved("DG-2")] });
      },
      // 계약 교정 재제출 — 최종 리뷰가 되돌린 DG-1 의 처분을 담는다.
      (turn) => {
        correctionPrompt = turn.prompt;
        return result("FIX", "DG-1 을 다시 고치고 DG-2 를 반영했습니다.", {
          status: "completed", findings: [resolved("DG-1", { rationale: "DG-1 검증 기준을 다시 맞췄습니다." }), resolved("DG-2")],
        });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    expect(await g6aSettleWithGrants(r, "final-stop-diagnosis-verdict 답변 확인 추가 승인")).toBe("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 A" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    // 첫 최종 리뷰가 DG-1 반영을 검증 기준 불충족(AGREED_ACTION + 사용자 판정 필요)으로 되돌려 최종 리뷰 정지에 멈춘다.
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(DIAGNOSIS_FINAL_VERDICT);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 재판정 전 커밋", paths: ["feature.txt"] })).status).toBeGreaterThanOrEqual(400);

    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "DG-1 검증 기준을 다시 맞춰 진행하세요." })).status).toBe(200);
    // 그 정지에서 무관한 새 진단 DG-2(정정 아님)를 적용하면 진단 전용 수정으로 반환된다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패 B" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "final-stop-diagnosis-verdict 답변 확인 추가 승인")).toBe("READY_TO_DELIVER");

    // 1) DG-2 수정 원본(러너 프롬프트의 수정 대상)에 최종 리뷰의 DG-1 판정이 실린다 — 타임라인 문구로만 남지 않는다.
    const targetsMarker = "수정 대상:\n";
    const targetsStart = diagnosisFixPrompt.indexOf(targetsMarker) + targetsMarker.length;
    const targets = JSON.parse(diagnosisFixPrompt.slice(targetsStart, diagnosisFixPrompt.indexOf("\n\n", targetsStart))) as Finding[];
    expect(targets.map((finding) => finding.id)).toEqual(expect.arrayContaining(["DG-2", "DG-1"]));
    expect(targets.find((finding) => finding.id === "DG-1")).toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true, rationale: DIAGNOSIS_FINAL_VERDICT });
    // 2) 커버리지: DG-1 을 빠뜨린 보고는 거부되고 같은 세션에 DG-1 을 적은 1회 교정을 요구받는다.
    expect(correctionPrompt).toContain("검토 쟁점을 누락했습니다: DG-1");
    expect(r.claude.turns).toHaveLength(4);
    // 3) 다음 최종 리뷰가 DG-1 을 판정했다 — 대조 보고에 DG-1 이 실렸고, 리뷰 결과가 DG-1 반영을 확인했다.
    const finals = r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(2);
    const reportMarker = "Claude 구현 보고:\n";
    const reportStart = finals[1].indexOf(reportMarker) + reportMarker.length;
    const report = JSON.parse(finals[1].slice(reportStart, finals[1].indexOf("\n\n", reportStart))) as AgentResult;
    expect(report.findings.map((finding) => finding.id).sort()).toEqual(["DG-1", "DG-2"]);
    const finalReview = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(finalReview.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("RESOLVED_BY_FIX");
    // 4) DG-1 해결 기록은 DG-1 을 판정한 그 최종 리뷰 뒤에만 남고, 그 뒤에야 커밋된다.
    const resolvedEvent = r.database.getTimeline(r.topicId).find((event) =>
      Array.isArray(event.payload?.diagnosisResolved) && (event.payload?.diagnosisResolved as string[]).includes("DG-1"));
    expect(resolvedEvent?.sequence).toBeGreaterThan(r.database.latestArtifact(r.topicId, "codex-final-review")!.revision);
    const [dg1, dg2] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect(dg2.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 재판정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    // 보조: DG-2 진단 전용 수정 계약(FC-2)의 동결 원본에 최종 리뷰의 DG-1 판정이 있다.
    const topic = r.database.getTopic(r.topicId);
    const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(contracts.map((contract) => [contract.contractId, contract.route, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", "diagnosis", ["DG-1"], "accepted"], ["FC-2", "diagnosis", ["DG-2"], "accepted"]]);
    expect(contracts[1].source.map((finding) => finding.id)).toEqual(["DG-1"]);
    r.database.close();
  });

  it("리뷰 수정 작업이 증거 대기로 멈춘 뒤 반영 보고 진단 DG-1 을 정정(supersedes)한 DG-2 를 실어 수락하면, 정정으로 닫힌 DG-1 의 옛 처분은 러너의 처분 되돌림으로 보지 않는다 — 최종 리뷰를 거쳐 인도 대기에 이르고 DG-2 가 해결된다(2026-09-15 감사 2차 #13)", { timeout: 60_000 }, async () => {
    const r = await room("closed-diagnosis-review-fix", [], { codex: "review-keeps-diagnosis" });
    r.claude["steps"].push(
      // 첫 구현 턴은 프로세스가 뜬 뒤 죽는다 → FAILED(재개 IMPLEMENTING). DG-1 은 구현 작업(work) 경로로 실린다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); throw new Error("구현 턴 프로세스 비정상 종료"); },
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n");
        return result("IMPLEMENTATION", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] });
      },
      // 리뷰 수정 턴(원본 = 첫 리뷰의 DG-1 AGREED_ACTION) — 게이트 로그를 요구한다 → BLOCKED_ON_EVIDENCE(재개 CLAUDE_FIX).
      () => result("FIX", "게이트 로그가 필요합니다.", {
        status: "completed", findings: [{ ...resolved("DG-1"), disposition: "EXTERNAL_EVIDENCE", rationale: "게이트 2 재실행 로그가 필요합니다." }],
      }),
      // DG-2 가 멈춘 리뷰 수정 작업에 실린 턴 — 정정 진단만 반영 보고한다(닫힌 DG-1 은 다시 처분하지 않는다).
      (turn) => {
        expect(turn.prompt).toContain("[DG-2]");
        writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영\n");
        return result("FIX", "DG-2 를 반영했습니다.", { status: "completed", findings: [resolved("DG-2")] });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("BLOCKED_ON_EVIDENCE");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    expect(r.codex.prompts).toHaveLength(1);
    expect(r.claude.turns).toHaveLength(3);

    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "게이트 로그로 입증", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "registered"]]);
    const beforeApply = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    // 수정 전: 수락 가드가 서버가 AGREED_NO_ACTION 으로 정리한 닫힌 DG-1 을 러너의 처분 되돌림으로 보고 USER_DECISION_REQUIRED(재개 CLAUDE_FIX)로 멈췄다.
    const settled = await Promise.any((["READY_TO_DELIVER", "USER_DECISION_REQUIRED"] as const).map((state) => r.idle(state).then(() => state)));
    expect(r.database.getTopic(r.topicId).lastError ?? "").not.toContain("처분을 되돌렸습니다");
    expect(settled).toBe("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId).resumeState ?? null).toBeNull();

    // 수정 작업 → 최종 리뷰 → 인도 대기. 수락 가드 정지는 없었다.
    const after = r.database.getTimeline(r.topicId, beforeApply);
    expect(after.some((event) => event.body.includes("처분을 되돌렸습니다"))).toBe(false);
    const transitions = after.filter((event) => typeof event.payload?.to === "string").map((event) => event.payload?.to);
    expect(transitions.slice(-2)).toEqual(["CODEX_FINAL_REVIEW", "READY_TO_DELIVER"]);
    expect(transitions).not.toContain("USER_DECISION_REQUIRED");
    expect(r.claude.turns).toHaveLength(4);
    expect(r.codex.prompts).toHaveLength(2);
    const finalPrompt = r.codex.prompts[1];
    expect(finalPrompt).toContain("반환 kind는 FINAL_REVIEW");
    const marker = "Claude 구현 보고:\n";
    const start = finalPrompt.indexOf(marker) + marker.length;
    const report = JSON.parse(finalPrompt.slice(start, finalPrompt.indexOf("\n\n", start))) as AgentResult;
    expect(report.findings.find((finding) => finding.id === "DG-2")?.disposition).toBe("RESOLVED_BY_FIX");
    // DG-2 는 해결, DG-1 은 정정으로 닫힌 채 남는다. 커밋이 열린다.
    const [dg1, dg2] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "superseded"]);
    expect(dg2.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "정정 진단 반영 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    // 보조: DG-2 는 멈춘 리뷰 수정 계약(FC-1)에 실려 수락됐다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.route, contract.diagnosisIds, contract.status])).toEqual([["FC-1", "review", ["DG-2"], "accepted"]]);
    r.database.close();
  });
  it("진단 전용 수정 뒤 최종 리뷰가 연 일반 수정이 응답 전에 끊기면 retry 는 그 최종 리뷰의 확정 결함 F-9 를 원본으로 수정 턴을 다시 연다 — 쟁점 0건인 첫 리뷰로 바꿔 F-9 를 버리지 않고, F-9 를 빠뜨린 결과로는 인도 대기에 이르지 않는다(2026-09-15 감사 2차 #6)", { timeout: 30_000 }, async () => {
    const r = await stoppedFinalReviewFix("final-fix-retry");
    let retriedPrompt = "";
    let correctionPrompt = "";
    r.claude["steps"].push(
      // retry 가 연 수정 턴 — 감사 재현처럼 쟁점 없이 완료로 돌려준다(F-9 를 빠뜨림).
      (turn) => { retriedPrompt = turn.prompt; return result("FIX", "수정을 재개했습니다.", { status: "completed" }); },
      // 원본 커버리지 교정 — 같은 세션에서 F-9 를 고친다.
      (turn) => {
        correctionPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "F-9 수정\n");
        return result("FIX", "F-9 를 고쳤습니다.", { status: "completed", findings: [resolved("F-9")] });
      },
    );
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // retry 는 최종 리뷰 #1(F-9)을 원본으로 쓰기 턴을 열었다 — 쟁점 0건인 첫 리뷰를 원본으로 고르지 않는다.
    expect(retriedPrompt).toContain('"id": "F-9"');
    expect(r.claude.turns[3].protocolOnly).toBe(false);
    // F-9 를 빠뜨린 결과는 수락되지 않고 같은 세션에서 교정을 요구받는다 — 판정 없이 인도 대기로 넘어가지 않는다.
    expect(correctionPrompt).toMatch(/검토 쟁점을 누락했습니다: [^\n]*F-9/);
    expect(r.claude.turns).toHaveLength(5);
    // 최종 리뷰 #2 는 F-9 를 대조했다(수정 결과·원본 커버리지에 F-9 가 남는다). 일반 수정이므로 자동 수정 회차를 소비했다.
    expect(r.codex.prompts.slice(codexBefore)).toHaveLength(1);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.codex.prompts.at(-1)).toContain('"id": "F-9"');
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["resolved"]);
    // 보조: 멈춘 작업은 최종 리뷰 #1 을 원본으로 한 리뷰 수정 계약이다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.route, contract.origin.review?.kind ?? null, contract.status]))
      .toEqual([["FC-1", "diagnosis", null, "accepted"], ["FC-2", "review", "codex-final-review", "accepted"]]);
    r.database.close();
  });

  it("최종 리뷰가 연 일반 수정 정지에서 반영 보고(fix_reported)된 DG-1 을 정정한 수정 진단 DG-2 는 멈춘 그 수정 작업에 수정 지시로 실린다 — 다음 수정 턴이 F-9 와 DG-2 를 함께 받고 F-9 가 사라지지 않는다(2026-09-15 감사 2차 #7)", { timeout: 30_000 }, async () => {
    const r = await stoppedFinalReviewFix("final-fix-correction");
    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "F-9 와 DG-2 수정\n");
      return result("FIX", "F-9 와 DG-2 를 고쳤습니다.", { status: "completed", findings: [resolved("F-9"), resolved("DG-2")] });
    });
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "DG-1 정정 — 다른 witness", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 다음 수정 턴은 멈춘 일반 수정 작업이다 — 최종 리뷰 #1 의 F-9 와 정정 진단 DG-2 를 함께 받고, 진단 전용 수정 안내로 바뀌지 않는다.
    expect(r.claude.turns).toHaveLength(4);
    expect(r.claude.turns[3].protocolOnly).toBe(false);
    expect(fixPrompt).toContain('"id": "F-9"');
    expect(fixPrompt).toContain("[DG-2]");
    expect(fixPrompt).not.toContain("중재자 진단(수정 지시)을 반영하세요");
    const [dg1, dg2] = await r.diagnoses();
    expect(dg2.history.find((entry) => entry.status === "applied")).toMatchObject({ detail: { mode: "work", target: "CLAUDE_FIX" } });
    // 최종 리뷰 #2 는 F-9 를 대조했고, 일반 수정이므로 자동 수정 회차를 소비했다.
    expect(r.codex.prompts.slice(codexBefore)).toHaveLength(1);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.codex.prompts.at(-1)).toContain('"id": "F-9"');
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "superseded"]);
    expect(dg2.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    // 보조: DG-2 는 새 진단 전용 계약이 아니라 멈춘 리뷰 수정 계약(FC-2)에 덧붙었다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.route, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", "diagnosis", ["DG-1"], "accepted"], ["FC-2", "review", ["DG-2"], "accepted"]]);
    r.database.close();
  });

  it("최종 리뷰가 연 일반 수정 정지에서 반영 보고(fix_reported)된 DG-1 을 수정 불필요로 정정해도 재개 단계는 CLAUDE_FIX 로 남는다 — 최종 리뷰로 되돌려 F-9 를 판정 없이 버리지 않고, retry 가 F-9 수정 턴을 거친 뒤에야 커밋이 열린다(2026-09-15 감사 2차 #8)", { timeout: 30_000 }, async () => {
    const r = await stoppedFinalReviewFix("final-fix-no-action");
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ kind: "no_action", title: "DG-1 수정 불필요", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    // 멈춘 작업은 최종 리뷰 #1(F-9)을 원본으로 한 일반 수정이다 — 진단 전용 수정 사슬을 닫아도 재개 단계를 최종 리뷰로 되돌리지 않는다.
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action"]);
    // F-9 를 고치기 전에는 커밋할 수 없다.
    const early = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-9 수정 전 커밋", paths: ["feature.txt"] });
    expect(early.status).toBeGreaterThanOrEqual(400);
    expect(String(early.body.error)).toContain("READY_TO_DELIVER");

    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "F-9 수정\n");
      return result("FIX", "F-9 를 고쳤습니다.", { status: "completed", findings: [resolved("F-9")] });
    });
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // retry 는 최종 리뷰가 아니라 멈췄던 F-9 수정 턴을 먼저 연다 — 그 앞에 Codex 턴이 끼지 않는다.
    expect(r.claude.turns).toHaveLength(4);
    expect(r.claude.turns[3].protocolOnly).toBe(false);
    expect(fixPrompt).toContain('"id": "F-9"');
    expect(r.codex.prompts.slice(codexBefore)).toHaveLength(1);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.codex.prompts.at(-1)).toContain('"id": "F-9"');
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    // F-9 수정과 최종 리뷰를 거친 뒤에야 커밋이 열린다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-9 수정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    // 보조: 리뷰 수정 계약(FC-2)은 닫히지(closed) 않고 수정 결과로 수락됐다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.route, contract.status]))
      .toEqual([["FC-1", "diagnosis", "accepted"], ["FC-2", "review", "accepted"]]);
    r.database.close();
  });
  it("저장만 되고 기록되지 않은 개정 계획 산출물이 최신이어도 허용 오차 개정은 현재 계획 sha 의 승인 계획을 바탕으로 넓힌다 — 미승인 문구는 개정 계획과 이후 구현·리뷰 프롬프트에 실리지 않는다(2026-09-15 감사 2차 #2)", { timeout: 60_000 }, async () => {
    const unapprovedLine = "미승인 개정 DG-1: 승인·ACK 전에 저장만 된 감사 단계 — 허용 오차 개정의 바탕이 되면 안 된다.";
    const r = await room("amend-over-orphan-revision", [], { tolerance: TIGHT_TOLERANCE });
    r.claude["steps"].push(
      // 첫 구현 턴 — 구현 세션(impl-session)을 만든 뒤 죽는다(FAILED, 재개 IMPLEMENTING).
      () => { throw new Error("구현 턴 프로세스 비정상 종료"); },
      // 진단 계획 개정 턴 — 죽는다(FAILED, 재개 CLAUDE_PLAN).
      () => { throw new Error("개정 턴 프로세스 비정상 종료"); },
      // 허용 오차 개정 뒤 retry 의 구현 턴(같은 구현 세션).
      () => { writeFileSync(join(r.worktree, "feature.txt"), "승인 계획 구현\n"); return result("IMPLEMENTATION", "승인 계획대로 구현했습니다.", { status: "completed" }); },
    );
    const approvedSHA = r.database.getTopic(r.topicId).planSHA256!;
    const approved = (await r.artifacts.readLatest(r.topicId, "plan"))!;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");

    // 중단 모사(감사 #12 와 같다): saveDiagnosisRevisedPlan 의 writeArtifact("plan") 뒤, markPlanRevised 전에 끊겼다 — 미승인 개정본이 최신 plan 산출물이다.
    const lines = approved.trimEnd().split("\n");
    const orphan = await r.artifacts.write(r.topicId, "plan", r.database.latestArtifactRevision(r.topicId, "plan") + 1, `${[lines[0], unapprovedLine, ...lines.slice(1)].join("\n")}\n`);
    expect(await r.artifacts.readLatest(r.topicId, "plan")).toContain(unapprovedLine);
    expect(r.database.getTopic(r.topicId).planSHA256).toBe(approvedSHA);
    // 저장 전 개정의 정정(수정 불필요) — 멈췄던 구현 단계로 되돌린다(승인 계획 sha 그대로).
    const closing = {
      kind: "no_action", title: "계획 변경 불필요", observedFailure: "게이트 2 F1 SIGTRAP", cause: "승인 계획 범위 안에서 해결됩니다.",
      evidenceRefs: ["gate2-rerun.log"], supersedes: "DG-1",
    };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, closing, { mediator: true })).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");

    // 허용 오차 개정(넓히기)은 받는다(200) — 바탕은 최신 산출물(미승인 개정본)이 아니라 topic.planSHA256 에 결속된 승인 계획이다.
    const amend = await r.call("POST", `/api/topics/${r.topicId}/actions/amend-tolerance`,
      { tolerance: { scopePaths: ["feature.txt", "docs/**"], rules: [] }, reason: "문서 경로까지 넓힙니다." });
    expect(amend.status, JSON.stringify(amend.body)).toBe(200);
    const amended = r.database.getTopic(r.topicId);
    const amendedPlan = (await r.artifacts.readLatest(r.topicId, "plan"))!;
    expect(amendedPlan).not.toContain(unapprovedLine);
    expect(amendedPlan).toContain("docs/**");
    // 허용 오차 블록 밖은 승인 계획 그대로다(넓힌 블록만 바뀌었다).
    const outsideTolerance = (text: string) => text.replace(/```tolerance\n[\s\S]*?\n```/, "```tolerance```").trim();
    expect(outsideTolerance(amendedPlan)).toBe(outsideTolerance(approved));
    expect(hashPlan(amendedPlan)).toBe(amended.planSHA256);
    expect(amended.planSHA256).not.toBe(approvedSHA);
    expect(amended.approvedPlanSHA256).toBe(amended.planSHA256);
    expect(amended.participants.every((participant) => participant.acknowledgedPlanSHA256 === amended.planSHA256)).toBe(true);
    expect(amended.state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");

    // 이후 구현·리뷰는 넓힌 승인 계획을 싣고, 미승인 문구·미승인 산출물 경로는 어디에도 싣지 않는다. 감사 턴은 없다(개정은 넓히기 결정이다).
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(3);
    const implementation = r.claude.turns[2];
    expect(implementation.prompt).not.toContain(unapprovedLine);
    expect(implementation.prompt).not.toContain(orphan.path);
    expect(implementation.readablePaths).not.toContain(orphan.path);
    const reviews = r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 REVIEW"));
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toContain(`승인된 계획 SHA-256: ${amended.planSHA256}\n승인된 계획:\n---\n${amendedPlan}\n---`);
    expect(reviews[0]).not.toContain(unapprovedLine);
    expect(reviews[0]).not.toContain(orphan.path);
    expect(r.codex.readable[r.codex.prompts.indexOf(reviews[0])]).not.toContain(orphan.path);
    expect(r.codex.prompts.some((prompt) => prompt.includes("반환 kind는 AUDIT"))).toBe(false);
    const after = r.database.getTopic(r.topicId);
    expect(after.planSHA256).toBe(amended.planSHA256);
    expect(after.approvedPlanSHA256).toBe(amended.planSHA256);
    const records = await r.diagnoses();
    expect(records.map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    expect(records[0].history.map((entry) => entry.status)).not.toContain("plan_revised");
    r.database.close();
  });

  it("대체된 계획 변경 진단의 개정 턴이 재작성 한도에 막혀 남긴 교정 대기본은 정정한 새 계획 변경 진단이 재사용하지 않는다 — 추가 승인 뒤 retry 의 첫 Claude 턴은 새 진단 원문을 실은 새 개정 턴이다(2026-09-15 감사 2차 #5)", { timeout: 60_000 }, async () => {
    const dg2Instruction = "DG2 전용 지시: witness 목록 표를 계획의 검증 기준에 추가하세요.";
    const dg2Line = "진단 DG-2: witness 목록 표를 검증 기준에 추가한다.";
    const dgVerdict = (id: string, rationale: string): Finding => ({
      id, title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale, evidenceRefs: [], requiresUserDecision: false,
    });
    const r = await room("superseding-plan-revision-pending-repair", [], { codex: "planning" });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      // DG-1 개정 턴 — AGREED_ACTION 인데 계획을 바꾸지 않았다(계약 위반). 교정 재제출이 재작성 한도에 막혀 이 응답이 교정 대기본으로 남는다.
      () => result("REVISION", "DG-1 을 반영했습니다.", { planEdits: [], findings: [dgVerdict("DG-1", "DG-1 수용")] }),
      // 추가 승인 뒤 retry 의 첫 Claude 턴 — 기준 계획에 DG-2 단계를 더한다.
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1] ?? r.database.getTopic(r.topicId).planSHA256!;
        return result("REVISION", "DG-2 를 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base, edits: [{ startLine: 2, endLineExclusive: 2, replacement: `${dg2Line}\n` }] },
          findings: [dgVerdict("DG-2", "검증 기준에 witness 목록 표를 추가했습니다.")],
        });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    // 앞선 재작성 2회를 원장에 모사한다 — 남은 1회를 DG-1 개정 턴이 쓰면 교정 재제출은 한도에 걸린다.
    for (let used = 0; r.database.revisions.account(r.topicId).limit - r.database.revisions.account(r.topicId).used > 1; used += 1) {
      r.database.revisions.admit(r.topicId, `prior-rewrite-${used}`, "revision");
    }
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(r.claude.turns).toHaveLength(2);
    const pending = JSON.parse((await r.artifacts.readLatest(r.topicId, "pending-contract-repair"))!) as { stage: string; raw: AgentResult };
    expect(pending.stage).toBe("CLAUDE_PLAN");
    expect(pending.raw.findings.map((finding) => finding.id)).toEqual(["DG-1"]);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied"]);

    // DG-1 을 정정하는 새 계획 변경 진단 — 저장 전 개정의 정정이라 등록되고, 적용된다.
    const dg2 = planDiagnosis({ title: "계획 변경: witness 목록 표", instructions: dg2Instruction, supersedes: "DG-1" });
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, dg2, { mediator: true })).status).toBe(201);
    const applyDg2 = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true });
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.claude.turns, JSON.stringify(applyDg2.body)).toHaveLength(2);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "applied"]]);
    const allowance = r.database.revisions.account(r.topicId);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/revision-resume`, { version: allowance.version })).status).toBe(200);
    const sequenceBeforeRetry = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");

    // 세 번째 Claude 턴은 DG-2 원문을 실은 새 개정 턴이다 — DG-1 응답의 교정 재개(같은 세션 resume·계약 교정문)가 아니다.
    expect(r.claude.turns.length).toBeGreaterThanOrEqual(3);
    const third = r.claude.turns[2];
    expect(third.mode).toBe("create");
    expect(third.planMode).toBe(true);
    expect(third.protocolOnly).toBe(false);
    expect(third.prompt).not.toContain("서버 기계 검사가 방금 응답을 거부했습니다");
    expect(third.prompt).toContain("[DG-2]");
    expect(third.prompt).toContain(dg2Instruction);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequenceBeforeRetry)
      .some((event) => event.body.includes("저장된 응답의 교정을 같은 세션에서 재개합니다"))).toBe(false);
    // DG-2 개정 결과가 개정 계획으로 저장됐다 — 옛 교정 대기본은 비워졌다.
    expect(await r.artifacts.readLatest(r.topicId, "plan")).toContain(dg2Line);
    expect((await r.diagnoses()).map((record) => [record.id, record.history.map((entry) => entry.status)])).toEqual([
      ["DG-1", ["registered", "applied", "superseded"]], ["DG-2", ["registered", "applied", "plan_revised"]],
    ]);
    expect(await r.artifacts.readLatest(r.topicId, "pending-contract-repair")).toBe("null");
    // 개정 계획 저장 뒤 감사까지 갔고, 감사 답변 개정 턴은 추가 승인한 재작성 한도(4/4)에 막혀 멈췄다 — Claude 턴은 3회에서 끝난다.
    expect(r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 AUDIT"))).toHaveLength(1);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_REVISION");
    expect(r.claude.turns).toHaveLength(3);
    r.database.close();
  });

  it("진단 계획 개정 턴의 계약 교정이 끝나 결정 요청으로 멈춘 뒤 retry 는 교정 원본의 철회된 반박을 재생하지 않는다 — 사용자 결정을 실은 새 개정 턴을 열고 DG-1 을 refuted 로 기록하지 않는다(2026-09-15 감사 2차 #12)", { timeout: 60_000 }, async () => {
    const question = "감사 단계를 A(게이트 앞)와 B(게이트 뒤) 중 어디에 넣을까요?";
    const decisionBody = "B 안(게이트 뒤)으로 넣으세요.";
    const bLine = "진단 DG-1: witness 감사 단계를 게이트 뒤(B 안)에 둔다.";
    const r = await room("completed-repair-not-salvaged", [], { codex: "planning" });
    const refuted: Finding = {
      id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "REFUTED", rationale: "원본 응답의 반박(교정 재제출로 철회됨)",
      evidenceRefs: ["plan:R-3"], requiresUserDecision: false,
    };
    const agreed: Finding = { ...refuted, disposition: "AGREED_ACTION", rationale: "진단에 동의 — 개정 위치 결정이 필요합니다." };
    const note = resolved("N-1", { title: "노트", severity: "LOW", rationale: "고쳤음" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); throw new Error("구현 턴 프로세스 비정상 종료"); },
      // 개정 턴 원응답: DG-1 반박 + 계획 단계에서 쓸 수 없는 RESOLVED_BY_FIX → 계약 교정(교정 원본에 REFUTED 가 남는다).
      () => result("REVISION", "진단이 틀렸습니다.", { planEdits: [], findings: [refuted, note] }),
      // 교정 재제출: 반박을 철회하고(AGREED_ACTION) 위치 결정을 요청한다 → 검사 통과, 개정 결과로 저장된 뒤 결정 대기로 멈춘다.
      () => result("REVISION", "교정: 진단에 동의합니다. 개정 위치 결정이 필요합니다.", {
        planEdits: [], findings: [agreed, { ...note, disposition: "AGREED_NO_ACTION", rationale: "해당 없음" }], requestedUserDecision: question,
      }),
      // 결정 뒤 retry 의 새 개정 턴 — B 안으로 계획을 고친다.
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1] ?? r.database.getTopic(r.topicId).planSHA256!;
        return result("REVISION", "B 안으로 개정합니다.", {
          planLineEdits: { baseSHA256: base, edits: [{ startLine: 2, endLineExclusive: 2, replacement: `${bLine}\n` }] },
          findings: [{ ...agreed, rationale: "사용자 결정대로 B 안에 감사 단계를 추가했습니다." }],
        });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    // 교정이 끝나 저장된 개정 응답(DG-1 AGREED_ACTION + 질문)이 러너의 최종 답이다. 교정 원본에는 철회된 REFUTED 가 남아 있다.
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(r.database.getTopic(r.topicId).lastError).toContain(question);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.claude.turns[2].prompt).toContain("RESOLVED_BY_FIX 처분을 쓸 수 없습니다");
    const saved = JSON.parse((await r.artifacts.readLatest(r.topicId, "diagnosis-plan-revision"))!) as AgentResult;
    expect(saved.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("AGREED_ACTION");
    const source = JSON.parse((await r.artifacts.readLatest(r.topicId, "contract-repair-source"))!) as { original: { findings: Finding[] } };
    expect(source.original.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("REFUTED");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied"]);

    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: decisionBody })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");

    // 새 개정 턴이 열렸다 — 일회용 세션·계획 모드로 DG-1 과 사용자 결정을 싣는다.
    expect(r.claude.turns.length).toBeGreaterThanOrEqual(4);
    const reopened = r.claude.turns[3];
    expect(reopened.mode).toBe("create");
    expect(reopened.planMode).toBe(true);
    expect(reopened.prompt).toContain("[DG-1]");
    expect(reopened.prompt).toContain(decisionBody);
    expect(reopened.prompt).not.toContain("서버 기계 검사가 방금 응답을 거부했습니다");
    // 철회된 반박은 refuted 로 기록되지 않고, 중재자에게 거짓 반박을 돌려보내지 않는다.
    const history = (await r.diagnoses())[0].history.map((entry) => entry.status);
    expect(history).not.toContain("refuted");
    expect(history).toEqual(["registered", "applied", "plan_revised"]);
    expect(r.database.getTopic(r.topicId).lastError ?? "").not.toContain("교정 도중 끊긴 응답");
    expect(r.database.getTimeline(r.topicId).some((event) => Array.isArray(event.payload?.diagnosisReturned))).toBe(false);
    expect(await r.artifacts.readLatest(r.topicId, "plan")).toContain(bLine);
    // 개정 계획 저장 뒤 감사까지 갔고, 감사 답변 개정 턴은 재작성 한도(개정 1 + 교정 1 + 새 개정 1 = 3/3)에 막혀 멈췄다.
    expect(r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 AUDIT"))).toHaveLength(1);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_REVISION");
    expect(r.claude.turns).toHaveLength(4);
    r.database.close();
  });

  it("수정 작업에 실린 진단이 처분 보고 전(전달됨)이면 구현 재개(resume-implementation)는 409 로 그 진단을 알리고 재개 단계를 바꾸지 않는다 — 이어진 retry 는 교정 전 checkpoint 에만 남은 반박을 refuted 로 기록하고 새 턴 없이 멈춰 반박된 지시를 다시 싣지 않는다(2026-09-15 감사 2차 #10)", { timeout: 30_000 }, async () => {
    const refuted = { ...resolved("DG-1"), disposition: "REFUTED" as const, rationale: "REFUTE-MARK: SIGTRAP 는 다른 witness 에서 났습니다." };
    const r = await room("resume-implementation-carried", [], { codex: "review-defect" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 첫 리뷰의 F-1 로 열린 수정 턴 — spawn 뒤 죽는다(FAILED, 재개 CLAUDE_FIX).
      () => { throw new Error("수정 턴 프로세스 비정상 종료"); },
      // DG-1 을 실은 수정 턴: 진단을 반박하고 F-1 을 빠뜨린다(계약 위반 → 계약 교정).
      (turn) => {
        expect(turn.protocolOnly).toBe(false);
        expect(turn.prompt).toContain("[DG-1]");
        return result("FIX", "진단을 반박합니다.", { status: "completed", findings: [refuted] });
      },
      // 계약 교정 턴 — spawn 뒤 죽는다. 반박은 교정 전 checkpoint 누적본에만 남는다.
      () => { throw new Error("계약 교정 턴 프로세스 비정상 종료"); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(2);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(4);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);

    // 구현 재개는 처분 보고 전인 실린 진단(DG-1)을 알리며 거부된다 — 상태·재개 단계는 그대로이고 재개 기록도 남지 않는다.
    const resume = await r.call("POST", `/api/topics/${r.topicId}/actions/resume-implementation`,
      { expectedState: "FAILED", expectedScopeGeneration: 1, reason: "구현부터 다시" }, { mediator: true });
    expect(resume.status).toBe(409);
    expect(String(resume.body.error)).toContain("DG-1");
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.implementationResume !== undefined)).toBe(false);

    // retry 는 같은 수정 작업을 이어 checkpoint 누적본의 반박을 refuted 로 기록하고, 새 턴을 열지 않고 멈춘다(DG-1 재전달 없음).
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    const [dg] = await r.diagnoses();
    expect(dg.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "refuted"]);
    expect(JSON.stringify(dg.history.at(-1))).toContain("REFUTE-MARK");
    expect(r.database.getTopic(r.topicId).lastError).toContain("DG-1 반박");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(4);
    // 반박된 진단은 정정 전까지 재개를 막는다 — 같은 지시가 다시 실리는 길이 없다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(409);
    expect(r.claude.turns).toHaveLength(4);
    // 보조: 리뷰 수정 계약은 DG-1 을 실은 채 열려 있다(구현 재개가 버리지 않았다).
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.route, contract.status, contract.diagnosisIds]))
      .toEqual([["review", "open", ["DG-1"]]]);
    r.database.close();
  });

  it("재작성 한도로 멈춘 진단 계획 개정을 수정 불필요로 정정해 재개 단계가 구현(IMPLEMENTING)으로 돌아오면 retry 는 재작성 추가 승인 없이 구현 턴을 잇는다 — 재작성 원장(사용량·한도)은 그대로다(2026-09-15 감사 2차 #11)", { timeout: 30_000 }, async () => {
    let openId = "";
    const r = await room("revision-pause-corrected", []);
    r.claude["steps"].push(
      askingTurn(r.worktree),
      // retry 가 잇는 구현 턴 — 계획 개정 턴이 아니고, 정정으로 닫힌 DG-1 을 싣지 않는다.
      (turn) => {
        expect(turn.planMode).toBe(false);
        expect(turn.prompt).not.toContain("승인된 계획의 변경");
        expect(turn.prompt).not.toContain("[DG-1]");
        writeFileSync(join(r.worktree, "feature.txt"), "구현 2\n");
        return result("IMPLEMENTATION", "구현을 이어 마쳤습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    // 전제: 계획 재작성 한도 소진(정상 흐름이면 앞선 재작성들의 몫) — 원장의 공개 연산(admit)으로 소비한다.
    let account = r.database.revisions.account(r.topicId);
    for (let n = 0; account.used < account.limit; n += 1) {
      r.database.revisions.admit(r.topicId, `exhaust-${n}`, "revision");
      account = r.database.revisions.account(r.topicId);
    }
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    // 진단 계획 개정이 재작성 한도에 막혀 멈췄다 — 개정 턴 없이 재개 단계 CLAUDE_PLAN, 재작성 한도 정지.
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(r.database.getTopic(r.topicId).lastError).toContain("계획 재작성 한도");
    const pause = r.database.getTimeline(r.topicId).filter((event) => event.actor === "system" && event.payload?.resumeState).at(-1);
    expect(pause?.payload).toMatchObject({ resumeState: "CLAUDE_PLAN", revisionPause: true });
    expect(r.claude.turns).toHaveLength(1);

    const closing = { kind: "no_action", title: "계획 개정 불필요", observedFailure: "SIGTRAP", cause: "승인 계획 범위 안에서 해결됩니다.", evidenceRefs: ["gate2-rerun.log"], supersedes: "DG-1" };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, closing, { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    const paused = r.database.revisions.account(r.topicId);

    // 재작성이 일어나지 않을 재개다 — 재작성 한도에 막히지 않고 구현 턴을 잇는다.
    const retry = await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(retry.status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    const after = r.database.revisions.account(r.topicId);
    expect({ used: after.used, limit: after.limit, version: after.version }).toEqual({ used: paused.used, limit: paused.limit, version: paused.version });
    expect((await r.diagnoses()).map((item) => [item.id, item.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    r.database.close();
  });

  it("커밋 뒤 인도 대기에서는 수정·조사 진단 등록을 409 로 거부하고 쓸 수 있는 경로(no_action 정정·범위 변경)를 안내한다 — 적용할 수 없는 진단이 남지 않아 push·close 가 막히지 않는다(2026-09-15 감사 2차 #14)", { timeout: 30_000 }, async () => {
    const r = await room("committed-register", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
    // push 가 실제로 도는 원격(bare) — room 의 저장소에는 원격이 없다.
    const remote = mkdtempSync(join(tmpdir(), "consensus-room-diagnosis-remote-"));
    temporaryDirectories.push(remote);
    git(remote, ["init", "--bare"]);
    git(r.worktree, ["remote", "add", "origin", remote]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "인도", paths: ["feature.txt"] })).status).toBe(200);
    const committedOID = r.database.getFlags(r.topicId).committedOID;
    expect(committedOID).toMatch(/^[0-9a-f]{40}$/);

    const fix = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "커밋 뒤 외부 검증 실패" }), { mediator: true });
    expect(fix.status).toBe(409);
    expect(String(fix.body.error)).toContain("커밋");
    expect(String(fix.body.error)).toContain("no_action");
    expect(String(fix.body.error)).toContain("scope_change");
    const investigation = { kind: "investigation", title: "커밋 뒤 원인 조사", observedFailure: "간헐 실패", cause: "가설: 시뮬레이터 열화", uncertainty: "재현 안 됨" };
    const investigated = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, investigation, { mediator: true });
    expect(investigated.status).toBe(409);
    expect(String(investigated.body.error)).toContain("커밋");
    expect(await r.diagnoses()).toEqual([]);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");

    // 거부된 등록은 인도를 막지 않는다 — push 와 close 가 그대로 된다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/push`)).status).toBe(200);
    expect(r.database.getFlags(r.topicId).pushedOID).toBe(committedOID);
    expect(git(remote, ["rev-parse", `refs/heads/${r.database.getTopic(r.topicId).branchName}`])).toBe(committedOID);
    // push 뒤에도 같은 규칙으로 거부한다.
    const afterPush = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "push 뒤 외부 검증 실패" }), { mediator: true });
    expect(afterPush.status).toBe(409);
    expect(String(afterPush.body.error)).toContain("커밋");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/close`)).status).toBe(200);
    expect(r.database.getTopic(r.topicId).state).toBe("CLOSED");
    expect(await r.diagnoses()).toEqual([]);
    r.database.close();
  });

  it("진단 전용 수정의 수락은 최종 리뷰 전이·계약 수락·반영 보고(fix_reported)를 한 transaction 으로 쓴다 — 반영 보고 기록이 실패하면 전이도 남지 않아 retry 가 수락을 다시 해 반영 보고를 잃지 않고 커밋에 이른다(2026-09-15 감사 2차 #15)", { timeout: 30_000 }, async () => {
    const r = await room("accept-atomic", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "외부 검증 실패 수정\n"); return result("FIX", "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    // 수락의 반영 보고 기록을 한 번 실패시킨다 — 전이와 반영 보고 사이에서 끊기는 창을 같은 저장 경계(진단 상태 기록)에서 모사한다.
    const log = r.database.diagnoses.log.bind(r.database.diagnoses);
    let faults = 0;
    r.database.diagnoses.log = (...args: Parameters<typeof log>) => {
      if (faults === 0 && args[2] === "fix_reported") {
        faults += 1;
        throw new Error("반영 보고 기록 중단(모사)");
      }
      log(...args);
    };
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(faults).toBe(1);
    // 전이가 반영 보고와 함께 없던 일이 됐다 — 재개 단계는 수정(CLAUDE_FIX)이고 최종 리뷰는 열리지 않았다.
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain("반영 보고 기록 중단(모사)");
    expect(r.codex.prompts).toHaveLength(1);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.from === "CLAUDE_FIX" && event.payload?.to === "CODEX_FINAL_REVIEW")).toBe(false);
    const topic = r.database.getTopic(r.topicId);
    const contracts = () => r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.route, contract.status]);
    // 보조: 계약도 수락되지 않고 열린 채다.
    expect(contracts()).toEqual([["diagnosis", "open"]]);

    // retry 는 수락 checkpoint 에서 수락만 다시 한다(러너 턴 없음) — 반영 보고 → 최종 리뷰 → 해결 → 커밋.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.prompts[1]).toContain("반환 kind는 FINAL_REVIEW");
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported", "resolved"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 수정 포함", paths: ["feature.txt"] })).status).toBe(200);
    expect(contracts()).toEqual([["diagnosis", "accepted"]]);
    r.database.close();
  });

  it("수락 전이 transaction 은 상태·회차·계약 행·진단 기록을 함께 쓰거나 함께 버린다 — 진단 기록 하나가 거부되면 앞선 반영 보고·상태 전이·회차 소비·계약 행이 하나도 남지 않는다(2026-09-15 감사 2차 #15)", { timeout: 30_000 }, async () => {
    const r = await room("transition-atomic", []);
    const topic = r.database.getTopic(r.topicId);
    type Registration = Parameters<ConsensusDatabase["registerDiagnosis"]>[0];
    type Transition = Parameters<ConsensusDatabase["applyTopicTransition"]>[0];
    r.database.registerDiagnosis({
      topicId: r.topicId, diagnosis: fixDiagnosis() as Registration["diagnosis"],
      binding: { scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch } as Registration["binding"], origin: null, initialStatus: "registered",
      event: (id) => ({ actor: "system", kind: "system", state: topic.state, body: `${id} 등록(원자성 검사 준비)` }),
    });
    const body = "수락 전이(원자성 검사)";
    const acceptance = (entries: Transition["diagnosisEntries"]) => r.database.applyTopicTransition({
      topicId: r.topicId, changes: { state: "CODEX_FINAL_REVIEW", resumeState: null, fixPassUsed: true },
      contracts: [{
        contractId: "FC-1", scopeGeneration: topic.scopeGeneration, planEpoch: topic.planEpoch, route: "review",
        origin: { stage: "CODEX_REVIEW", review: { kind: "codex-review", revision: 1 } }, source: [], diagnosisIds: ["DG-1"], adjudicated: [], decisionFrom: 1,
        pass: "first", status: "accepted", acceptId: 1, settledAfter: 1,
      }],
      diagnosisEntries: entries,
      events: [{ actor: "system", kind: "system", state: "CODEX_FINAL_REVIEW", body, payload: { fixContract: "FC-1" } }],
    });
    const statuses = () => r.database.diagnoses.get(r.topicId, "DG-1")!.history.map((entry) => entry.status);

    // 유효한 반영 보고 뒤에 거부되는 기록 하나 — 전부 되돌아간다.
    expect(() => acceptance([{ diagnosisId: "DG-1", status: "fix_reported", detail: { acceptId: 1 } }, { diagnosisId: "DG-1", status: "not-a-status" as never }]))
      .toThrow(/알 수 없는 진단 상태/);
    expect(r.database.getTopic(r.topicId).state).toBe(topic.state);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect(statuses()).toEqual(["registered"]);
    expect(r.database.getTimeline(r.topicId).some((event) => event.body === body)).toBe(false);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);

    // 대조: 모두 유효하면 상태·회차·반영 보고·이벤트·계약 행이 함께 남는다.
    acceptance([{ diagnosisId: "DG-1", status: "fix_reported", detail: { acceptId: 1 } }]);
    expect(r.database.getTopic(r.topicId).state).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect(statuses()).toEqual(["registered", "fix_reported"]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.body === body)).toHaveLength(1);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.status])).toEqual([["FC-1", "accepted"]]);
    r.database.close();
  });

  it("인도 대기 순차 적용 뒤 두 수정 진단을 모두 수정 불필요로 정정하면 마지막 정정이 진단 전용 수정 작업을 닫고 정지(FAILED, 재개 = 최종 리뷰)로 옮긴다 — retry 는 러너 턴 없이 지금 작업 트리를 최종 리뷰해 인도 대기에 이르고 커밋이 열린다(2026-09-15 감사 3차 #1)", { timeout: 30_000 }, async () => {
    const r = await room("ready-sequential-close-all", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const noAction = (id: string) => fixDiagnosis({ kind: "no_action", title: `${id} 수정 불필요`, supersedes: id });
    expect((await register(fixDiagnosis({ title: "첫 외부 검증 실패" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ title: "둘째 외부 검증 실패" }))).status).toBe(201);
    // 순차 적용 대기: DG-1 적용은 기록만 한다(완료 판정 취소, 재개 단계 CLAUDE_FIX) — DG-2 가 적용을 기다린다.
    const first = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(first.status).toBe(200);
    expect(first.body.actionId).toBeNull();
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    // 대기 중인 DG-2 를 먼저 닫는다 — 작업에 실린 DG-1 이 열려 있으므로 인도 대기·재개 단계는 그대로다.
    expect((await register(noAction("DG-2"))).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    // 작업에 실린 마지막 진단 DG-1 을 닫으면 작업은 수정 없이 끝난다 — 인도 대기 → 최종 리뷰 전이가 없으므로 정지(재개 = 최종 리뷰)로 옮긴다.
    expect((await register(noAction("DG-1"))).status).toBe(201);
    const stopped = r.database.getTopic(r.topicId);
    expect(stopped.state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(stopped.lastError).toContain("진단 전용 수정의 진단이 모두 정정으로 닫혔습니다");
    expect((await r.diagnoses()).map((record) => [record.id, record.history.map((entry) => entry.status)])).toEqual([
      ["DG-1", ["registered", "applied", "superseded"]], ["DG-2", ["registered", "superseded"]], ["DG-3", ["closed_no_action"]], ["DG-4", ["closed_no_action"]],
    ]);
    expect(r.database.fixContracts.list(r.topicId, stopped.scopeGeneration, stopped.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1"], "closed"]]);
    // retry 는 러너 턴 없이 지금 작업 트리(구현 결과)를 최종 리뷰한다 — 한 번에 인도 대기에 이르고 커밋이 열린다.
    expect(r.codex.prompts).toHaveLength(1);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(1);
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.prompts[1]).toContain("반환 kind는 FINAL_REVIEW");
    expect(reviewReportIn(r.codex.prompts[1]).summary).toBe("구현을 마쳤습니다.");
    expect(r.database.getFlags(r.topicId).reviewedHead).toBeTruthy();
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("인도 대기 순차 적용 뒤 작업에 실린 DG-1 부터 수정 불필요로 닫아도 그 정정이 진단 전용 수정 작업을 닫고 정지(FAILED, 재개 = 최종 리뷰)로 옮긴다 — 대기 중인 DG-2 가 남은 동안 retry 는 409 로 막히고, DG-2 를 닫은 뒤 retry 가 러너 턴 없이 최종 리뷰해 커밋이 열린다(2026-09-15 감사 3차 #1)", { timeout: 30_000 }, async () => {
    const r = await room("ready-sequential-close-carried-first", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const noAction = (id: string) => fixDiagnosis({ kind: "no_action", title: `${id} 수정 불필요`, supersedes: id });
    expect((await register(fixDiagnosis({ title: "첫 외부 검증 실패" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ title: "둘째 외부 검증 실패" }))).status).toBe(201);
    const first = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(first.status).toBe(200);
    expect(first.body.actionId).toBeNull();
    // 작업에 실린 유일한 진단 DG-1 을 닫으면 작업은 수정 없이 끝난다 — DG-2 는 작업에 실리지 않은 등록 상태로 남는다.
    expect((await register(noAction("DG-1"))).status).toBe(201);
    const stopped = r.database.getTopic(r.topicId);
    expect(stopped.state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(stopped.lastError).toContain("진단 전용 수정의 진단이 모두 정정으로 닫혔습니다");
    expect(r.database.fixContracts.list(r.topicId, stopped.scopeGeneration, stopped.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1"], "closed"]]);
    // 등록만 된 DG-2 가 남아 있는 동안 재개는 막힌다(등록만으로는 재개·완료되지 않는다) — 재개 단계는 그대로다.
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(blocked.status).toBe(409);
    expect(String(blocked.body.error)).toContain("DG-2");
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 정지 상태에서 DG-2 를 닫는다 — 열린 수정 작업이 없으므로 재개 단계(최종 리뷰)는 바뀌지 않는다.
    expect((await register(noAction("DG-2"))).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([
      ["DG-1", "superseded"], ["DG-2", "superseded"], ["DG-3", "closed_no_action"], ["DG-4", "closed_no_action"],
    ]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(1);
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.prompts[1]).toContain("반환 kind는 FINAL_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("진단 전용 수정 정지에서 계획 변경 정정의 저장 전 개정을 수정 불필요로 되돌려 실은 진단이 모두 닫힌 진단 전용 수정 작업에 재개 단계 CLAUDE_FIX 가 복원돼도, retry 는 throw·영구 FAILED 없이 러너 턴 없이 그 작업을 닫고 지금 작업 트리를 최종 리뷰해 인도 대기에 이르고 커밋이 열린다(2026-09-15 감사 3차 #8)", { timeout: 30_000 }, async () => {
    const r = await room("zero-carried-contract", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => result("FIX", "진단이 틀렸습니다.", { status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "원인이 다릅니다." }] }),
      () => result("REVISION", "계획 변경은 필요 없습니다.", {
        planEdits: [],
        findings: [{ id: "DG-2", title: "중재자 진단", severity: "HIGH", disposition: "REFUTED", rationale: "계획이 이미 허용합니다.", evidenceRefs: ["plan:R-3"], requiresUserDecision: false }],
      }),
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await register(fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    // 반박된 DG-1 을 계획 변경 진단 DG-2 로 정정·적용한다 — 개정 턴도 반박해 저장 전 개정으로 멈춘다.
    expect((await register(planDiagnosis({ supersedes: "DG-1" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    // 저장 전 개정을 수정 불필요로 정정하면 멈췄던 수정 단계(CLAUDE_FIX)로 되돌아간다 — 그 진단 전용 수정 작업에 실린 진단(DG-1)은 이미 닫혔다.
    expect((await register(fixDiagnosis({ kind: "no_action", title: "계획 변경 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "superseded"], ["DG-3", "closed_no_action"]]);
    expect(r.codex.prompts).toHaveLength(1);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.database.runningAction(r.topicId) === null && ["READY_TO_DELIVER", "USER_DECISION_REQUIRED", "FAILED"].includes(r.database.getTopic(r.topicId).state),
      "zero-carried retry 정지");
    const settled = r.database.getTopic(r.topicId);
    expect(settled.lastError ?? "").not.toContain("열린 진단이 없습니다");
    expect(settled.state).toBe("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.prompts[1]).toContain("반환 kind는 FINAL_REVIEW");
    expect(reviewReportIn(r.codex.prompts[1]).summary).toBe("구현을 마쳤습니다.");
    expect(r.database.fixContracts.list(r.topicId, settled.scopeGeneration, settled.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1"], "closed"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "진단 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("실은 진단이 모두 닫힌 진단 전용 수정 작업에 CLAUDE_FIX 가 복원됐어도 그 작업의 열린 요청이 남았으면 retry 는 작업을 닫거나 최종 리뷰로 넘기지 않고 USER_DECISION_REQUIRED(재개 CLAUDE_FIX)로 멈춘다 — 요청 해소를 지시한 새 수정 진단이 같은 작업을 이어 요청을 해소한 뒤에야 인도 대기·커밋에 이른다(2026-09-15 감사 3차 #8)", { timeout: 30_000 }, async () => {
    let openId = "";
    const r = await room("zero-carried-open-request", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 진단 전용 수정 턴: 진단을 반박하면서 별도의 결정을 묻는다(열린 요청).
      () => result("FIX", "진단이 틀렸고, 배포 채널 결정이 필요합니다.", {
        status: "completed", requestedUserDecision: "배포 채널을 A 로 할까요?",
        findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "원인이 다릅니다." }],
      }),
      () => result("REVISION", "계획 변경은 필요 없습니다.", {
        planEdits: [],
        findings: [{ id: "DG-2", title: "중재자 진단", severity: "HIGH", disposition: "REFUTED", rationale: "계획이 이미 허용합니다.", evidenceRefs: ["plan:R-3"], requiresUserDecision: false }],
      }),
      // 요청 해소를 지시한 새 수정 진단(DG-4) 턴: 같은 작업의 열린 요청을 해소하고 반영을 보고한다.
      (turn) => {
        expect(turn.prompt).toContain("[DG-4]");
        expect(requestIdsIn(turn.prompt)).toContain(openId);
        return result("FIX", "요청을 해소했습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId, findings: [resolved("DG-4")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await register(fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await register(planDiagnosis({ supersedes: "DG-1" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect((await register(fixDiagnosis({ kind: "no_action", title: "계획 변경 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.database.runningAction(r.topicId) === null && ["READY_TO_DELIVER", "USER_DECISION_REQUIRED", "FAILED"].includes(r.database.getTopic(r.topicId).state),
      "zero-carried open-request retry 정지");
    const paused = r.database.getTopic(r.topicId);
    expect(paused.lastError ?? "").not.toContain("열린 진단이 없습니다");
    expect(paused.state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(paused.lastError).toContain("열린 요청");
    openId = /Q-[0-9a-f]{8}/.exec(paused.lastError ?? "")?.[0] ?? "";
    expect(openId).toMatch(/^Q-[0-9a-f]{8}$/);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts).toHaveLength(1);
    expect(r.database.fixContracts.list(r.topicId, paused.scopeGeneration, paused.planEpoch).map((contract) => [contract.contractId, contract.status])).toEqual([["FC-1", "open"]]);
    // 결정을 올리고 요청 해소를 지시한 새 수정 진단을 적용한다 — 같은 진단 전용 수정 작업이 요청을 해소한 뒤 최종 리뷰를 거쳐 인도 대기에 이른다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    expect((await register(fixDiagnosis({ title: "열린 요청 해소", instructions: "코드를 바꾸지 말고 열린 요청을 결정대로 해소하세요." }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-4/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(4);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.resolvedRequest === openId)).toBe(true);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "superseded"], ["DG-3", "closed_no_action"], ["DG-4", "resolved"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "요청 해소 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("진단 계획 개정이 저장되면 개정 전 계획에서 연 진단 전용 수정 작업은 버려진다 — 개정 계획 구현 뒤 인도 대기에서 적용한 새 수정 진단은 새 작업을 열고, 그 수정 턴은 개정 전 최종 리뷰 정지 쟁점 F-2 를 원본으로 싣지 않는다(2026-09-15 감사 3차 #12)", { timeout: 60_000 }, async () => {
    const r = await room("revision-abandons-contract", [], { codex: "planning-final-decision" });
    let staleFixPrompt = "";
    let lateFixPrompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
      // 최종 리뷰 정지에서 적용한 DG-2 진단 전용 수정 — DG-2 는 반박하고 정지 쟁점 F-2 는 판정 필요인 채 둔다.
      (turn) => {
        staleFixPrompt = turn.prompt;
        return result("FIX", "DG-2 는 틀렸습니다.", { status: "completed", findings: [{ ...resolved("DG-2"), disposition: "REFUTED", rationale: "원인이 다릅니다." }, FINAL_REVIEW_DECISION_FINDING] });
      },
      // DG-3(계획 변경, DG-2 정정) 개정 턴.
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: "진단 DG-3: 감사 단계를 추가한다.\n" }] },
          findings: [{ id: "DG-3", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 반영", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
      (turn) => { writeFileSync(join(r.worktree, "feature.txt"), "개정 계획 구현\n"); return result("IMPLEMENTATION", "개정 계획대로 구현했습니다.", { status: "completed", ...resolvePromptRequest(turn), findings: [resolved("DG-3")] }); },
      // 개정 뒤 인도 대기에서 적용한 DG-4 진단 전용 수정.
      (turn) => {
        lateFixPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-4 반영\n");
        return result("FIX", "DG-4 를 반영했습니다.", { status: "completed", findings: [resolved("DG-4")] });
      },
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    expect(await g6aSettleWithGrants(r, "revision-abandons-contract 추가 승인")).toBe("READY_TO_DELIVER");
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(FINAL_REVIEW_DECISION_FINDING.rationale);
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await apply("DG-2")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    // 개정 전 진단 전용 수정 작업은 최종 리뷰 정지 쟁점 F-2 를 원본으로 실었다.
    expect(staleFixPrompt).toContain("[DG-2]");
    expect(staleFixPrompt).toContain('"id": "F-2"');
    expect((await r.diagnoses()).find((record) => record.id === "DG-2")?.status).toBe("refuted");
    expect((await register(planDiagnosis({ supersedes: "DG-2" }))).status).toBe(201);
    expect((await apply("DG-3")).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    const revisedSHA = r.database.getTopic(r.topicId).planSHA256;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: revisedSHA })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "revision-abandons-contract 추가 승인")).toBe("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(7);
    // 개정 계획 구현 뒤 인도 대기에서 새 수정 진단 DG-4 를 적용한다.
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await apply("DG-4")).status).toBe(200);
    await waitFor(() => lateFixPrompt !== "" && r.database.runningAction(r.topicId) === null, "DG-4 수정 턴 뒤 정지");
    expect(lateFixPrompt).toContain("[DG-4]");
    expect(lateFixPrompt).not.toContain("[DG-2]");
    expect(lateFixPrompt).not.toContain('"id": "F-2"');
    expect(r.claude.turns).toHaveLength(8);
    const dg4 = (await r.diagnoses()).find((record) => record.id === "DG-4");
    expect(dg4?.history.map((entry) => entry.status).slice(0, 4)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    // 보조 확인: 개정 전 계약(FC-2)은 버려졌고 DG-4 는 인도 대기에서 연 새 계약(원본 없음)에 실렸다.
    const topic = r.database.getTopic(r.topicId);
    const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(contracts.map((contract) => [contract.contractId, contract.diagnosisIds, contract.status])).toEqual([
      ["FC-1", ["DG-1"], "accepted"], ["FC-2", ["DG-2"], "abandoned"], ["FC-3", ["DG-4"], "accepted"],
    ]);
    expect(contracts[2].origin.stage).toBe("READY_TO_DELIVER");
    expect(contracts[2].source).toEqual([]);
    // DG-4 수락 뒤 최종 리뷰는 구현 리뷰 한도(첫 리뷰·최종 리뷰 #1·개정 계획 리뷰로 3회 소진)에 막혀 멈춘다 — 한도 정지이지 F-2 정지가 아니다.
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(topic.lastError).toContain("리뷰 한도");
    expect(r.codex.prompts).toHaveLength(6);
    // 리뷰 1회를 추가 승인하고 재개하면 최종 리뷰도 개정 전 정지 쟁점 F-2 를 싣지 않고 DG-4 반영을 대조해 인도 대기에 이르고 커밋이 열린다.
    // (review-resume 은 승인을 기록하지만 이 방에는 토큰·시간 예산 계정이 없어 재개를 보류한다 — retry 로 재개한다.)
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "revision-abandons-contract 추가 승인")).toBe("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(8);
    expect(r.codex.prompts).toHaveLength(7);
    expect(r.codex.prompts[6]).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.codex.prompts[6]).not.toContain('"id": "F-2"');
    expect(reviewReportIn(r.codex.prompts[6]).findings.map((finding) => finding.id)).toEqual(["DG-4"]);
    expect((await r.diagnoses()).find((record) => record.id === "DG-4")?.status).toBe("resolved");
    await closeRevisedAwayDG1(r, "개정 계획 인도");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "개정 계획 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("최종 리뷰 정지 쟁점(F-2 수정 합의 + 사용자 판정 필요)을 원본으로 연 진단 전용 수정이 수정 불필요 정정으로 닫힌 뒤 최종 리뷰가 F-2 를 생략하면, 첫 리뷰의 같은 id 옛 처분(수정 불필요)이 승계되지 않는다 — 프롬프트는 F-2 의 최신 판정을 싣고, 누락은 교정 대상이 되어 사용자 결정 없이 인도 대기·커밋에 이르지 않는다(2026-09-15 감사 3차 #2)", { timeout: 60_000 }, async () => {
    const { r, settled, finals, retrySequence } = await shadowedStopRetry("shadowed-stop-omit", "omit");
    // 1) 인도 대기로 가지 않는다 — 판정 없이 닫힌 F-2 로 통과하지 않는다.
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 2) 최종 리뷰 #2 프롬프트의 계약 원본 절이 F-2 의 최신 판정(정지 쟁점)을 싣는다 — 보고·첫 리뷰에 같은 id 가 있어도 걸러지지 않는다.
    expect(finals).toHaveLength(1);
    const shown = contractSourceIn(finals[0]);
    expect(shown?.map((finding) => finding.id)).toEqual(["F-2"]);
    expect(shown?.[0]).toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true, rationale: SHADOWED_F2_VERDICT });
    // 3) F-2 누락은 첫 리뷰 처분 승계로 메워지지 않고 검토 쟁점 누락으로 거부된다. 통과 기록이 없다.
    const afterRetry = r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence);
    expect(afterRetry.some((event) => event.body.includes("검토 쟁점을 누락했습니다: F-2"))).toBe(true);
    expect(afterRetry.some((event) => event.body.includes("최종 읽기 전용 리뷰를 통과했습니다"))).toBe(false);
    // 4) 저장된 최종 리뷰의 F-2 는 여전히 수정 합의 + 판정 필요다 — "리뷰 처분 승계" 로 수정 불필요가 된 적이 없다.
    const saved = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(saved.findings.find((finding) => finding.id === "F-2")).toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true });
    // 5) 러너 턴은 더 열리지 않았고 사용자 결정은 없었다 — 커밋은 인도 대기 요구로 거부된다.
    expect(r.claude.turns).toHaveLength(3);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 없이 인도", paths: ["feature.txt"] });
    expect(commit.status).toBeGreaterThanOrEqual(400);
    expect(String(commit.body.error)).toContain("READY_TO_DELIVER");
    // 6) 리뷰 1회를 추가 승인하고 재개하면(이 방은 예산 계정이 없어 retry 로 재개) 같은 세션의 교정이 F-2 를 지목하고, 리뷰어가 F-2 를 판정 필요인 채
    // 유지하면 최종 리뷰 정지로 남는다 — 멈춤이 리뷰 한도 덕이 아니라 F-2 판정 요구 때문임을 확인한다.
    const codexBeforeGrant = r.codex.prompts.length;
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "shadowed-stop-omit 추가 승인")).toBe("USER_DECISION_REQUIRED");
    const correction = r.codex.prompts.slice(codexBeforeGrant).find((prompt) => prompt.includes("서버 기계 검사가 방금 응답을 거부했습니다"));
    expect(correction).toContain("검토 쟁점을 누락했습니다: F-2");
    expect(r.database.getTopic(r.topicId).lastError).toContain(SHADOWED_F2_KEPT);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.claude.turns).toHaveLength(3);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    // (보조) F-2 를 원본으로 실은 진단 전용 계약은 수정 없이 닫혔다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.route, contract.status, contract.source.map((finding) => finding.id)]))
      .toEqual([["diagnosis", "accepted", []], ["diagnosis", "closed", ["F-2"]]]);
    r.database.close();
  });

  it("최종 리뷰 정지 쟁점(F-2 수정 합의 + 사용자 판정 필요)을 원본으로 연 진단 전용 수정이 수정 불필요 정정으로 닫힌 뒤 최종 리뷰가 F-2 를 첫 리뷰 처분대로 수정 불필요로 적으면, 되돌림 가드가 옛 settled 처분이 아니라 최신 판정(수정 합의)과 대조해 멈춘다 — 사용자 결정 없이 인도 대기·커밋에 이르지 않는다(2026-09-15 감사 3차 #2)", { timeout: 60_000 }, async () => {
    const { r, settled, finals } = await shadowedStopRetry("shadowed-stop-explicit", "explicit");
    // 1) 되돌림 가드가 F-2 를 지목해 멈춘다(재개 = 최종 리뷰).
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("수정 확인 없이 닫았습니다(F-2)");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 2) 최종 리뷰 #2 프롬프트의 계약 원본 절이 F-2 의 최신 판정(정지 쟁점)을 싣는다.
    expect(finals).toHaveLength(1);
    const shown = contractSourceIn(finals[0]);
    expect(shown?.map((finding) => finding.id)).toEqual(["F-2"]);
    expect(shown?.[0]).toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true, rationale: SHADOWED_F2_VERDICT });
    // 3) 러너 턴은 더 열리지 않았고 사용자 결정은 없었다 — 커밋은 거부된다.
    expect(r.claude.turns).toHaveLength(3);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 없이 인도", paths: ["feature.txt"] });
    expect(commit.status).toBeGreaterThanOrEqual(400);
    expect(String(commit.body.error)).toContain("READY_TO_DELIVER");
    r.database.close();
  });

  it("해결(resolved)된 진단 DG-1 을 뒤 최종 리뷰가 회귀(수정 합의)로 판정해 연 리뷰 수정 작업은 DG-1 을 수정 대상에 싣고, 러너가 DG-1 을 빠뜨리면 DG-1 을 지목한 교정을 요구한다 — 회귀 판정을 버린 채 수락·인도 대기에 이르지 않고, 다음 최종 리뷰가 DG-1 재반영 보고를 판정한 뒤에야 커밋된다(2026-09-15 감사 3차 #3)", { timeout: 60_000 }, async () => {
    const r = await room("resolved-regression-review-fix", [], { codexInstance: new RegressionVerdictFinalCodex() });
    let reviewFixPrompt = "";
    let correctionPrompt = "";
    r.claude["steps"].push(
      // 첫 구현 턴은 프로세스가 뜬 뒤 죽는다 → FAILED(재개 IMPLEMENTING). DG-1 은 구현 작업(work) 경로로 실린다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); throw new Error("구현 턴 프로세스 비정상 종료"); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("IMPLEMENTATION", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
      // 인도 대기에서 적용한 DG-2 진단 전용 수정 — DG-1 반영을 되돌린다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영(DG-1 되돌림)\n"); return result("FIX", "DG-2 를 반영했습니다.", { status: "completed", findings: [resolved("DG-2")] }); },
      // 최종 리뷰 #1 이 연 리뷰 수정 턴 — 쟁점을 하나도 보고하지 않는다.
      (turn) => { reviewFixPrompt = turn.prompt; return result("FIX", "수정 대상을 확인했습니다.", { status: "completed" }); },
      // 계약 교정 재제출 — DG-1 을 다시 반영하고 처분을 담는다.
      (turn) => {
        correctionPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-1 재반영 · DG-2 반영\n");
        return result("FIX", "DG-1 을 다시 반영했습니다.", {
          status: "completed", findings: [resolved("DG-1", { rationale: "DG-2 수정이 되돌린 DG-1 반영을 복구했습니다." }), resolved("DG-2")],
        });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "resolved"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    const settled = await settledState(r, "resolved-regression-review-fix");

    // 1) 최종 리뷰 #1 이 연 리뷰 수정 턴의 수정 대상에 회귀 판정 DG-1 이 실린다 — 해결된 진단이라고 원본에서 걸러지지 않는다.
    const targets = fixTargetsIn(reviewFixPrompt);
    expect(targets.map((finding) => finding.id)).toEqual(expect.arrayContaining(["DG-2", "DG-1"]));
    expect(targets.find((finding) => finding.id === "DG-1")).toMatchObject({ disposition: "AGREED_ACTION", rationale: REGRESSED_DG1_VERDICT });
    // 2) DG-1 을 빠뜨린 보고는 수락되지 않고 같은 세션에 DG-1 을 지목한 교정을 요구받는다.
    expect(correctionPrompt).toContain("검토 쟁점을 누락했습니다: DG-1");
    expect(r.claude.turns).toHaveLength(5);
    // 3) 다음 최종 리뷰의 대조 보고에 DG-1 재반영 보고가 실려 리뷰어가 DG-1 을 판정했다 — 그 판정 뒤에야 인도 대기다.
    const finals = r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(2);
    expect(reviewReportIn(finals[1]).findings.find((finding) => finding.id === "DG-1")).toMatchObject({ disposition: "RESOLVED_BY_FIX" });
    expect(settled).toBe("READY_TO_DELIVER");
    const finalReview = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(finalReview.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("RESOLVED_BY_FIX");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "resolved"], ["DG-2", "resolved"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 회귀 판정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    // (보조) 리뷰 수정 계약(FC-2)의 동결 원본에 회귀 판정 DG-1 이 있다.
    const topic = r.database.getTopic(r.topicId);
    const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(contracts.map((contract) => [contract.contractId, contract.route, contract.status])).toEqual([["FC-1", "diagnosis", "accepted"], ["FC-2", "review", "accepted"]]);
    expect(contracts[1].source.map((finding) => finding.id)).toEqual(expect.arrayContaining(["DG-2", "DG-1"]));
    r.database.close();
  });

  it("수정을 요구하는 결정('F-1 은 반드시 고쳐 주세요')은 줄 머리 OVERRULE 지시어가 아니어서 러너의 F-1 하향(수정 불필요)을 허용하지 않는다 — 수락하지 않고 F-1 을 지목해 멈추며, 최종 리뷰·인도 대기·커밋에 이르지 않는다(2026-09-15 감사 3차 #7)", { timeout: 60_000 }, async () => {
    const { r, settled } = await downgradeAfterDecision("demand-is-not-overrule", "F-3 은 채널 A 로 하세요. F-1 은 반드시 고쳐 주세요.");
    // 1) 수락 가드가 F-1 하향을 되돌림으로 잡아 멈춘다(재개 = 수정 작업).
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain("처분을 되돌렸습니다(F-1)");
    // 2) 최종 리뷰는 열리지 않았고(첫 리뷰 1회뿐) 러너 턴은 구현·수정 2회다. 결정이 하향을 허용했다는 기록도 없다.
    expect(r.codex.prompts).toHaveLength(1);
    expect(r.claude.turns).toHaveLength(2);
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("사용자 결정이 처분 변경을 허용한 쟁점"))).toBe(false);
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-1 미수정 인도", paths: ["feature.txt"] });
    expect(commit.status).toBeGreaterThanOrEqual(400);
    // (보조) 리뷰 수정 계약은 수락되지 않았고 자동 수정 회차도 소비되지 않았다.
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.route, contract.status])).toEqual([["review", "open"]]);
    r.database.close();
  });

  it("줄 머리 OVERRULE F-1 지시가 있는 결정이면 같은 러너의 F-1 하향(수정 불필요)이 수락되고 최종 리뷰를 거쳐 인도 대기·커밋에 이른다 — 지시어 한정 규칙의 양성 대조(2026-09-15 감사 3차 #7)", { timeout: 60_000 }, async () => {
    const { r, settled } = await downgradeAfterDecision("overrule-directive", "OVERRULE F-1\nF-3 은 채널 A 로 하세요. F-1 은 이번 범위에서 고치지 않습니다.");
    expect(settled).toBe("READY_TO_DELIVER");
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("사용자 결정이 처분 변경을 허용한 쟁점: F-1(AGREED_ACTION → AGREED_NO_ACTION)"))).toBe(true);
    expect(r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toHaveLength(1);
    expect(r.claude.turns).toHaveLength(2);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    const finalReview = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(finalReview.findings.find((finding) => finding.id === "F-1")?.disposition).toBe("AGREED_NO_ACTION");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-1 은 사용자 지시로 미수정", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계약 도입 전 엔진이 남긴 진단 전용 수정 checkpoint(fixSource diagnosis#DG-1)에서 러너 반박으로 멈춘 토픽을 수정 불필요로 정정하면 그 작업 id 그대로 진단 전용 수정 계약으로 이관·종결돼 최종 리뷰로 돌아간다 — retry 는 Claude 수정 턴 없이 최종 리뷰만 돌리고 자동 수정 회차를 쓰지 않는다(2026-09-15 감사 3차 #4)", { timeout: 30_000 }, async () => {
    const r = await refutedDiagnosisFixStop("legacy-checkpoint-no-action");
    await legacyTopic(r);
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    expect(r.codex.prompts.slice(codexBefore).map((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toEqual([true]);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action"]);
    const topic = r.database.getTopic(r.topicId);
    // 보조: 이관 계약 id 는 옛 checkpoint 의 작업 id(diagnosis#DG-1)이고 진단 전용 수정(회차 없음)으로 닫혔다.
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.route, contract.pass, contract.status]))
      .toEqual([["diagnosis#DG-1", "diagnosis", "none", "closed"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "옛 토픽 진단 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계약 도입 전 엔진이 남긴 진단 전용 수정 checkpoint(fixSource diagnosis#DG-1)에서 러너 반박으로 멈춘 토픽의 정정 수정 진단 DG-2 는 그 진단 전용 수정 작업에 실려 진단 전용 수정으로 적용된다 — 러너 프롬프트가 진단 전용 수정 머리말로 DG-2 를 싣고, 최종 리뷰를 거쳐 인도 대기에 이르러도 자동 수정 회차를 쓰지 않는다(2026-09-15 감사 3차 #6)", { timeout: 30_000 }, async () => {
    const r = await refutedDiagnosisFixStop("legacy-checkpoint-correction");
    await legacyTopic(r);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "정정: 진짜 원인", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영\n");
      return result("FIX", "DG-2 를 반영했습니다.", { status: "completed", findings: [resolved("DG-2")] });
    });
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    const listed = (await r.call("GET", `/api/topics/${r.topicId}/diagnoses`)).body.diagnoses as Array<{ id: string; history: Array<{ status: string; detail?: Record<string, unknown> }> }>;
    expect(listed.find((record) => record.id === "DG-2")?.history.find((entry) => entry.status === "applied")?.detail).toMatchObject({ mode: "diagnosis-fix", target: "CLAUDE_FIX" });
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(3);
    expect(fixPrompt).toContain("승인된 계획 범위 안에서 중재자 진단(수정 지시)을 반영하세요");
    expect(fixPrompt).toContain("[DG-2]");
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.database.getFlags(r.topicId)).toMatchObject({ fixPassUsed: false, secondFixPassUsed: false });
    expect((await r.diagnoses()).map((record) => [record.id, record.history.map((entry) => entry.status)])).toEqual([
      ["DG-1", ["registered", "applied", "delivered", "refuted", "superseded"]],
      ["DG-2", ["registered", "applied", "delivered", "fix_reported", "resolved"]],
    ]);
    const topic = r.database.getTopic(r.topicId);
    // 보조: DG-2 는 옛 작업 id(diagnosis#DG-1)의 진단 전용 수정 계약에 덧붙어 수락됐다.
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.route, contract.pass, contract.diagnosisIds, contract.status]))
      .toEqual([["diagnosis#DG-1", "diagnosis", "none", ["DG-1", "DG-2"], "accepted"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "옛 토픽 정정 진단 반영", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계약 도입 전 엔진이 인도 대기에 반쯤 적용한 진단 DG-1(적용됨·재개 CLAUDE_FIX·완료 판정 취소, 계약 없음)은 다음 진단 DG-2 적용이 여는 진단 전용 수정에 함께 실린다 — 러너 프롬프트가 두 진단을 싣고, 두 진단 모두 반영 보고·해결에 이르러 DG-1 이 적용됨으로 남지 않고 커밋이 열린다(2026-09-15 감사 3차 #11)", { timeout: 30_000 }, async () => {
    const r = await room("legacy-half-applied-ready", []);
    let fixPrompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        fixPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "두 진단 반영\n");
        return result("FIX", "두 진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1"), resolved("DG-2")] });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "DG-1 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "DG-2 다른 실패" }), { mediator: true })).status).toBe(201);
    // 옛 엔진(7219c1f..2ddd57d)이 재개 거부로 남긴 반쯤 적용된 상태: DG-1 applied(진단 전용 수정) + 재개 CLAUDE_FIX + 완료 판정 취소, 상태는 인도 대기, 계약 없음.
    r.database.recordDiagnosisStatus({
      topicId: r.topicId,
      entries: [{ diagnosisId: "DG-1", status: "applied", detail: { mode: "diagnosis-fix", target: "CLAUDE_FIX", fromState: "READY_TO_DELIVER", fromResume: null } }],
      changes: { resumeState: "CLAUDE_FIX", reviewedHead: null, reviewedDiffSHA256: null },
    });
    await legacyTopic(r);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId)).toMatchObject({ resumeState: "CLAUDE_FIX", reviewedHead: null });
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["applied", "registered"]);
    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true });
    expect(applied.status).toBe(200);
    expect(applied.body.actionId).toBeTruthy();
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    expect(fixPrompt).toContain("승인된 계획 범위 안에서 중재자 진단(수정 지시)을 반영하세요");
    expect(fixPrompt).toContain("[DG-2]");
    expect(fixPrompt).toContain("[DG-1]");
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.diagnoses()).map((record) => [record.id, record.history.map((entry) => entry.status)])).toEqual([
      ["DG-1", ["registered", "applied", "delivered", "fix_reported", "resolved"]],
      ["DG-2", ["registered", "applied", "delivered", "fix_reported", "resolved"]],
    ]);
    const topic = r.database.getTopic(r.topicId);
    // 보조: 옛 반쯤 적용된 DG-1 과 DG-2 가 한 진단 전용 수정 계약에 실려 수락됐다.
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.route, contract.diagnosisIds, contract.status]))
      .toEqual([["diagnosis", ["DG-1", "DG-2"], "accepted"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "옛 반쯤 적용 진단까지 반영", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계약 도입 전(구 엔진)에 진단 전용 수정 뒤 최종 리뷰가 연 일반 수정이 응답 전에 끊긴 토픽을 retry 하면 이관한 수정 작업의 원본은 그 최종 리뷰의 확정 결함 F-9 다 — 쟁점 0건인 첫 리뷰로 이관해 F-9 를 버리지 않고, F-9 를 빠뜨린 결과는 교정을 받아 판정 없이 인도 대기에 이르지 않는다(2026-09-15 감사 3차 #5)", { timeout: 30_000 }, async () => {
    const r = await stoppedFinalReviewFix("legacy-final-fix-retry");
    await legacyTopic(r);
    let retriedPrompt = "";
    let correctionPrompt = "";
    r.claude["steps"].push(
      // retry 가 연 수정 턴 — 쟁점 없이 완료로 돌려준다(F-9 를 빠뜨림).
      (turn) => { retriedPrompt = turn.prompt; return result("FIX", "수정을 재개했습니다.", { status: "completed" }); },
      // 원본 커버리지 교정 — 같은 세션에서 F-9 를 고친다.
      (turn) => {
        correctionPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "F-9 수정\n");
        return result("FIX", "F-9 를 고쳤습니다.", { status: "completed", findings: [resolved("F-9")] });
      },
    );
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 이관한 수정 작업은 최종 리뷰 #1(F-9)을 원본으로 쓰기 턴을 연다 — 자동 수정 회차 플래그(false)로 고른 첫 리뷰(쟁점 0건)가 아니다.
    expect(retriedPrompt).toContain('"id": "F-9"');
    expect(r.claude.turns[3].protocolOnly).toBe(false);
    // F-9 를 빠뜨린 결과는 수락되지 않고 같은 세션에서 교정을 요구받는다.
    expect(correctionPrompt).toMatch(/검토 쟁점을 누락했습니다: [^\n]*F-9/);
    expect(r.claude.turns).toHaveLength(5);
    // 최종 리뷰 #2 는 F-9 를 대조했다 — F-9 는 처분(RESOLVED_BY_FIX)을 받은 뒤에야 인도 대기에 이른다.
    expect(r.codex.prompts.slice(codexBefore)).toHaveLength(1);
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(reviewReportIn(r.codex.prompts.at(-1)!).findings.find((finding) => finding.id === "F-9")?.disposition).toBe("RESOLVED_BY_FIX");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["resolved"]);
    // 보조: 이관 계약은 최종 리뷰 #1 을 원본으로 한 리뷰 수정 계약이다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.route, contract.origin.review?.kind ?? null, contract.source.some((finding) => finding.id === "F-9"), contract.status]))
      .toEqual([["review", "codex-final-review", true, "accepted"]]);
    r.database.close();
  });

  it("계약 도입 전(구 엔진)의 같은 정지에서 사용자 결정을 올리고 retry 해도 최종 리뷰 #1 보다 먼저 저장된 진단 전용 수정 결과를 이 수정 작업의 결과로 재사용하지 않는다 — F-9 를 실은 수정 턴을 열고, F-9 판정 없이 인도 대기에 이르지 않는다(2026-09-15 감사 3차 #5)", { timeout: 30_000 }, async () => {
    const r = await stoppedFinalReviewFix("legacy-final-fix-decision");
    await legacyTopic(r);
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "계속 진행하세요." })).status).toBe(200);
    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "F-9 수정\n");
      return result("FIX", "F-9 를 고쳤습니다.", { status: "completed", findings: [resolved("F-9")] });
    });
    const codexBefore = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 저장된 수정 결과(DG-1 진단 전용 수정 — 최종 리뷰 #1 보다 먼저)는 이 작업의 결과가 아니다. 수정 턴이 열려 F-9 를 받았다.
    expect(fixPrompt).toContain('"id": "F-9"');
    expect(r.claude.turns).toHaveLength(4);
    expect(r.claude.turns[3].protocolOnly).toBe(false);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence)
      .some((event) => event.body.includes("를 재사용해 최종 리뷰로 넘깁니다"))).toBe(false);
    // 최종 리뷰 #2 는 F-9 반영을 대조했다.
    expect(r.codex.prompts.slice(codexBefore)).toHaveLength(1);
    expect(reviewReportIn(r.codex.prompts.at(-1)!).findings.find((finding) => finding.id === "F-9")?.disposition).toBe("RESOLVED_BY_FIX");
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["resolved"]);
    r.database.close();
  });

  it("계약 도입 전(구 엔진)의 멈춘 수정 작업에 실린 진단이 처분 보고 전(전달됨)이면 열린 계약이 없어도 구현 재개(resume-implementation)는 409 로 그 진단을 알리고 상태·재개 단계를 바꾸지 않는다 — 재구현 뒤로 진단을 묻지 않는다(2026-09-15 감사 3차 #9)", { timeout: 30_000 }, async () => {
    const refuted = { ...resolved("DG-1"), disposition: "REFUTED" as const, rationale: "REFUTE-MARK: SIGTRAP 는 다른 witness 에서 났습니다." };
    const r = await room("legacy-resume-implementation-carried", [], { codex: "review-defect" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 첫 리뷰의 F-1 로 열린 수정 턴 — spawn 뒤 죽는다(FAILED, 재개 CLAUDE_FIX).
      () => { throw new Error("수정 턴 프로세스 비정상 종료"); },
      // DG-1 을 실은 수정 턴: 진단을 반박하고 F-1 을 빠뜨린다(계약 위반 → 계약 교정).
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        return result("FIX", "진단을 반박합니다.", { status: "completed", findings: [refuted] });
      },
      // 계약 교정 턴 — spawn 뒤 죽는다.
      () => { throw new Error("계약 교정 턴 프로세스 비정상 종료"); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(4);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);
    await legacyTopic(r);
    const lastError = r.database.getTopic(r.topicId).lastError;

    // 열린 계약이 없어도(계약 도입 전 작업) 멈춘 수정 작업에 실린 처분 전 진단 DG-1 을 알리며 거부한다 — 상태·재개 단계·오류는 그대로이고 재개 기록도 없다.
    const resume = await r.call("POST", `/api/topics/${r.topicId}/actions/resume-implementation`,
      { expectedState: "FAILED", expectedScopeGeneration: 1, reason: "구현부터 다시" }, { mediator: true });
    expect(resume.status).toBe(409);
    expect(String(resume.body.error)).toContain("DG-1");
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toBe(lastError);
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.implementationResume !== undefined)).toBe(false);
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered"]);
    expect(r.claude.turns).toHaveLength(4);
    r.database.close();
  });

  it("계약 도입 전(구 엔진)에 리뷰 수정 결과가 수락된 토픽에서 인도 대기 중 적용한 진단 전용 수정이 끊긴 뒤 수정 불필요로 정정해 최종 리뷰로 돌아가면, 대조 보고는 수락된 옛 수정 결과('F-1 수정 보고', F-1 RESOLVED_BY_FIX)다 — 닫힌 진단 전용 계약이 생겼다고 구현 결과로 바꾸지 않고 인도 대기·커밋에 이른다(2026-09-15 감사 3차 #10)", { timeout: 30_000 }, async () => {
    const r = await room("legacy-accepted-fix-report", [], { codex: "review-defect" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 첫 리뷰 F-1 의 리뷰 수정 — 수락돼 최종 리뷰를 거쳐 인도 대기에 이른다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "F-1 수정\n"); return result("FIX", "F-1 수정 보고", { status: "completed", findings: [resolved("F-1")] }); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect(r.claude.turns).toHaveLength(2);
    // 수락된 수정 결과는 계약 도입 전(구 엔진)의 것이다.
    await legacyTopic(r);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    r.claude["steps"].push((turn) => { expect(turn.prompt).toContain("[DG-1]"); throw new Error("진단 수정 턴 프로세스 비정상 종료"); });
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses())[0].status).toBe("delivered");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 외부 원인", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.codex.prompts.length > codexBefore && r.database.runningAction(r.topicId) === null
      && ["READY_TO_DELIVER", "USER_DECISION_REQUIRED"].includes(r.database.getTopic(r.topicId).state), "retry 뒤 최종 리뷰 정지");
    // 최종 리뷰의 대조 보고는 수락된 옛 수정 결과다 — 구현 결과('구현을 마쳤습니다.', 쟁점 0건)가 아니다.
    const finalReview = r.codex.prompts[codexBefore];
    expect(finalReview).toContain("반환 kind는 FINAL_REVIEW");
    const report = reviewReportIn(finalReview);
    expect([report.kind, report.summary, report.findings.map((finding) => [finding.id, finding.disposition])])
      .toEqual(["FIX", "F-1 수정 보고", [["F-1", "RESOLVED_BY_FIX"]]]);
    // F-1 반영을 대조한 최종 리뷰는 커버리지 교정 없이 통과해 인도 대기·커밋에 이른다.
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect(r.codex.prompts.slice(codexBefore)).toHaveLength(1);
    expect(r.claude.turns).toHaveLength(3);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계약 도입 전(구 엔진)에 리뷰 수정이 수락되고 최종 리뷰 정지(사용자 판정 필요, 재개 CODEX_FINAL_REVIEW)에 있던 토픽에서 적용한 진단 전용 수정이 끊긴 뒤 수정 불필요로 닫혀도, 다음 최종 리뷰의 대조 보고는 수락된 옛 수정 결과다 — 수정 단계에서만 기록한 쟁점(F-8)까지 실리고 정지 쟁점 F-2 는 원본 절로 함께 실린다(2026-09-15 감사 3차 #14)", { timeout: 60_000 }, async () => {
    const fixOnly: Finding = {
      id: "F-8", title: "수정 단계에서 새로 기록한 확인 사항", severity: "LOW", disposition: "AGREED_NO_ACTION", rationale: "F-8 수정 단계 확인 — 조치 불필요.",
      evidenceRefs: ["feature.txt:1"], requiresUserDecision: false,
    };
    const r = await room("legacy-stop-accepted-fix-report", [], { codex: "review-fix-final-stop" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 첫 리뷰 F-1 의 리뷰 수정 — 수정 단계에서만 기록한 F-8 을 함께 보고한다. 수락돼 첫 최종 리뷰가 F-2 로 멈춘다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "F-1 수정\n"); return result("FIX", "F-1 을 고쳤습니다.", { status: "completed", findings: [resolved("F-1"), fixOnly] }); },
      // 최종 리뷰 정지에서 적용한 진단 전용 수정 — spawn 뒤 죽는다(FAILED, 재개 CLAUDE_FIX).
      (turn) => { expect(turn.prompt).toContain("[DG-1]"); throw new Error("진단 수정 턴 프로세스 비정상 종료"); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect(r.claude.turns).toHaveLength(2);
    // 수락된 수정 결과·최종 리뷰 정지는 계약 도입 전(구 엔진)의 것이다(계약 0건).
    await legacyTopic(r);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(3);
    expect(r.claude.turns[2].prompt).toContain('"id": "F-2"');
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 외부 원인", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.codex.prompts.length > codexBefore && r.database.runningAction(r.topicId) === null
      && ["READY_TO_DELIVER", "USER_DECISION_REQUIRED"].includes(r.database.getTopic(r.topicId).state), "retry 뒤 최종 리뷰 정지");
    // 최종 리뷰의 대조 보고는 수락된 옛 수정 결과다 — 수정 단계에서만 기록한 F-8 까지 담는다. 구현 결과(쟁점 0건)가 아니다.
    const finalReview = r.codex.prompts[codexBefore];
    expect(finalReview).toContain("반환 kind는 FINAL_REVIEW");
    const report = reviewReportIn(finalReview);
    expect([report.kind, report.summary, report.findings.map((finding) => [finding.id, finding.disposition])])
      .toEqual(["FIX", "F-1 을 고쳤습니다.", [["F-1", "RESOLVED_BY_FIX"], ["F-8", "AGREED_NO_ACTION"]]]);
    // 닫힌 진단 전용 계약의 원본(정지 쟁점 F-2)은 보고와 따로 원본 절로 실린다.
    expect(finalReview).toContain("수정 작업의 원본 쟁점");
    expect(finalReview).toContain('"id": "F-2"');
    expect(r.claude.turns).toHaveLength(3);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action"]);
    r.database.close();
  });

  it("계약 도입 전(구 엔진) 토픽에서 러너 반박으로 멈춘 진단 전용 수정(diagnosis#DG-1)을 수정 불필요로 닫은 뒤 최종 리뷰가 연 리뷰 수정(F-9)이 응답 전에 끊겼으면, retry 의 이관은 낡은 진단 checkpoint 를 잇는 진단 전용 계약이 아니라 그 최종 리뷰를 원본으로 한 리뷰 경로다 — F-9 를 실은 수정 턴을 열고 F-9 를 빠뜨리면 F-9 를 지목한 교정을 요구하며, F-9 판정 없이 인도 대기·커밋에 이르지 않는다(2026-09-15 감사 4차 #1·#2)", { timeout: 30_000 }, async () => {
    const r = await room("legacy-stale-diagnosis-checkpoint", [], { codex: "final-review-defect" });
    let stoppedFixPrompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 인도 대기에서 적용한 DG-1 진단 전용 수정 — 러너가 반박한다(paused checkpoint, USER_DECISION_REQUIRED/CLAUDE_FIX).
      () => result("FIX", "진단이 틀렸습니다.", {
        status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "외부 검증 실패는 이 변경과 무관합니다." }],
      }),
      // 최종 리뷰 #1(F-9)이 연 리뷰 수정 턴 — spawn 뒤 응답 전에 죽는다(FAILED, 재개 CLAUDE_FIX).
      (turn) => { stoppedFixPrompt = turn.prompt; throw new Error("일반 수정 턴 프로세스 비정상 종료"); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const refutedCheckpoint = r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(stoppedFixPrompt).toContain('"id": "F-9"');
    expect(r.claude.turns).toHaveLength(3);
    // 죽은 리뷰 수정 턴은 checkpoint 를 남기지 않았다(옛 엔진도 턴 응답 뒤에만 기록했다) — 최신 checkpoint 는 반박으로 멈춘 진단 전용 수정의 paused 기록이다.
    expect(r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision).toBe(refutedCheckpoint);
    const finalReview = r.database.latestArtifact(r.topicId, "codex-final-review")!;
    await legacyTopic(r);
    const legacy = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; inputSequence: number; work: { kind: string; fixSource?: string } };
    expect([legacy.work.kind, legacy.phase, legacy.work.fixSource]).toEqual(["FIX", "paused", "diagnosis#DG-1"]);
    expect(legacy.inputSequence).toBeLessThan(finalReview.revision);
    let retriedPrompt = "";
    let correctionPrompt = "";
    r.claude["steps"].push(
      // retry 가 연 수정 턴 — 쟁점 없이 완료로 돌려준다(F-9 를 빠뜨림).
      (turn) => { retriedPrompt = turn.prompt; return result("FIX", "수정을 재개했습니다.", { status: "completed" }); },
      // 원본 커버리지 교정 — 같은 세션에서 F-9 를 고친다.
      (turn) => {
        correctionPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "F-9 수정\n");
        return result("FIX", "F-9 를 고쳤습니다.", { status: "completed", findings: [resolved("F-9")] });
      },
    );
    const codexBefore = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    const settled = await settledState(r, "legacy-stale-diagnosis-checkpoint");
    // 이관은 최종 리뷰 #1 을 원본으로 한 리뷰 경로다 — 그 최종 리뷰보다 앞선 낡은 진단 checkpoint 의 작업 id(diagnosis#DG-1)가 아니다.
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence).map((event) => event.payload?.fixContractMigrated).filter(Boolean))
      .toEqual([`codex-final-review#${finalReview.revision}`]);
    // F-9 를 수정 대상으로 실은 쓰기 턴이 열리고, F-9 를 빠뜨린 결과는 수락되지 않고 같은 세션에서 F-9 를 지목한 교정을 받는다.
    expect(fixTargetsIn(retriedPrompt).map((finding) => finding.id)).toContain("F-9");
    expect(r.claude.turns[3].protocolOnly).toBe(false);
    expect(correctionPrompt).toMatch(/검토 쟁점을 누락했습니다: [^\n]*F-9/);
    expect(r.claude.turns).toHaveLength(5);
    // 인도 대기에 이른 최종 리뷰는 F-9 반영(RESOLVED_BY_FIX)을 대조한 #2 하나뿐이다 — F-9 판정 없이 인도 대기에 이르지 않았다.
    expect(settled).toBe("READY_TO_DELIVER");
    const finals = r.codex.prompts.slice(codexBefore);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toContain("반환 kind는 FINAL_REVIEW");
    expect(reviewReportIn(finals[0]).findings.find((finding) => finding.id === "F-9")?.disposition).toBe("RESOLVED_BY_FIX");
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.route, contract.source.some((finding) => finding.id === "F-9"), contract.status]))
      .toEqual([[`codex-final-review#${finalReview.revision}`, "review", true, "accepted"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-9 수정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    expect(git(r.worktree, ["show", "HEAD:feature.txt"])).toBe("F-9 수정");
    r.database.close();
  });

  it("계약 도입 전(구 엔진) 토픽에서 러너 반박으로 멈춘 진단 전용 수정 checkpoint(diagnosis#DG-1) 뒤에 수정 불필요 정정과 통과한 최종 리뷰로 인도 대기에 이르렀으면, 그 뒤 순차 적용이 여는 진단 전용 수정은 낡은 checkpoint 의 작업 id 를 잇지 않는다 — 이관 계약은 대기 중이던 새 진단의 작업 id 이고, 낡은 누적본(DG-1 반박)에서 이어가지 않은 채 새 진단만 대조한 최종 리뷰를 거쳐 인도 대기·커밋에 이른다(2026-09-15 감사 4차 #1)", { timeout: 30_000 }, async () => {
    const r = await refutedDiagnosisFixStop("legacy-stale-checkpoint-ready");
    const refutedCheckpoint = r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(2);
    // 최종 리뷰는 러너 턴 없이 통과했다 — 최신 checkpoint 는 여전히 반박으로 멈춘 진단 전용 수정의 paused 기록이고, 최종 리뷰가 그보다 뒤다.
    expect(r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision).toBe(refutedCheckpoint);
    const finalReview = r.database.latestArtifact(r.topicId, "codex-final-review")!;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "DG-3 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "DG-4 다른 실패" }), { mediator: true })).status).toBe(201);
    // 옛 엔진(7219c1f..2ddd57d)이 재개 거부로 남긴 반쯤 적용된 순차 적용 상태(감사 3차 #11 과 같은 흉내): DG-3 applied(진단 전용 수정) + 재개 CLAUDE_FIX +
    // 완료 판정 취소, 상태는 인도 대기, 계약 없음.
    r.database.recordDiagnosisStatus({
      topicId: r.topicId,
      entries: [{ diagnosisId: "DG-3", status: "applied", detail: { mode: "diagnosis-fix", target: "CLAUDE_FIX", fromState: "READY_TO_DELIVER", fromResume: null } }],
      changes: { resumeState: "CLAUDE_FIX", reviewedHead: null, reviewedDiffSHA256: null },
    });
    await legacyTopic(r);
    const legacy = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; inputSequence: number; work: { kind: string; fixSource?: string } };
    expect([legacy.work.kind, legacy.phase, legacy.work.fixSource]).toEqual(["FIX", "paused", "diagnosis#DG-1"]);
    expect(legacy.inputSequence).toBeLessThan(finalReview.revision);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action", "applied", "registered"]);
    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "두 진단 반영\n");
      return result("FIX", "두 진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-3"), resolved("DG-4")] });
    });
    const applySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-4/apply`, undefined, { mediator: true });
    expect(applied.status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > applySequence);
    // 이관 계약은 대기 중이던 DG-3 의 작업 id 다 — 통과한 최종 리뷰보다 앞선 낡은 checkpoint 의 작업 id(diagnosis#DG-1)가 아니다.
    expect(after.map((event) => event.payload?.fixContractMigrated).filter(Boolean)).toEqual(["diagnosis#DG-3"]);
    // 새 진단 전용 수정은 낡은 누적본(반박으로 멈춘 checkpoint)에서 이어가지 않는다.
    expect(after.filter((event) => event.payload?.checkpointResumed !== undefined).map((event) => event.body)).toEqual([]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.claude.turns[2].protocolOnly).toBe(false);
    expect(fixPrompt).toContain("[DG-3]");
    expect(fixPrompt).toContain("[DG-4]");
    // 최종 리뷰의 대조 보고는 새 진단 반영만 담는다 — 낡은 누적본의 DG-1 반박이 섞이지 않는다.
    expect(r.codex.prompts.at(-1)).toContain("반환 kind는 FINAL_REVIEW");
    expect(reviewReportIn(r.codex.prompts.at(-1)!).findings.map((finding) => [finding.id, finding.disposition]))
      .toEqual([["DG-3", "RESOLVED_BY_FIX"], ["DG-4", "RESOLVED_BY_FIX"]]);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action", "resolved", "resolved"]);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.route, contract.diagnosisIds, contract.status]))
      .toEqual([["diagnosis#DG-3", "diagnosis", ["DG-3", "DG-4"], "accepted"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "새 진단 반영 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계약 도입 전(구 엔진)에 리뷰 수정 결과('F-1 수정 보고')가 수락된 토픽에서 인도 대기 중 적용한 진단 전용 수정을 러너가 반박해 멈춘 뒤 수정 불필요로 정정해 최종 리뷰로 돌아가면, 대조 보고는 수락된 옛 수정 결과다 — 반박으로 멈추며 저장한 수정 결과('진단이 틀렸습니다.', 수락 기록 없음)를 보고로 싣지 않아 F-1 누락 교정 없이 인도 대기·커밋에 이른다(2026-09-15 감사 4차 #9)", { timeout: 30_000 }, async () => {
    const fixOnly: Finding = {
      id: "F-8", title: "수정 단계에서 새로 기록한 확인 사항", severity: "LOW", disposition: "AGREED_NO_ACTION", rationale: "F-8 수정 단계 확인 — 조치 불필요.",
      evidenceRefs: ["feature.txt:1"], requiresUserDecision: false,
    };
    const r = await room("legacy-refuted-fix-report", [], { codex: "review-defect" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 첫 리뷰 F-1 의 리뷰 수정 — 수정 단계에서만 기록한 F-8 을 함께 보고한다. 수락돼 최종 리뷰를 거쳐 인도 대기에 이른다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "F-1 수정\n"); return result("FIX", "F-1 수정 보고", { status: "completed", findings: [resolved("F-1"), fixOnly] }); },
      // 인도 대기에서 적용한 DG-1 진단 전용 수정 — 러너가 반박한다(결과는 수락 없이 보존된 채 멈춘다).
      (turn) => {
        expect(turn.prompt).toContain("[DG-1]");
        return result("FIX", "진단이 틀렸습니다.", {
          status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "외부 검증 실패는 이 변경과 무관합니다." }],
        });
      },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    expect(r.claude.turns).toHaveLength(2);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["refuted"]);
    // 반박으로 멈추며 저장한 수정 결과가 최신 claude-fix 지만 수락 기록(acceptId)이 없다 — 수락된 수정 결과는 'F-1 수정 보고' 하나다.
    expect(r.database.getTimeline(r.topicId).filter((event) => event.kind === "agent_output" && event.actor === "claude" && event.payload?.resultKind === "FIX")
      .map((event) => [event.body, typeof event.payload?.acceptId === "number"])).toEqual([["F-1 수정 보고", true], ["진단이 틀렸습니다.", false]]);
    expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "claude-fix"))!) as AgentResult).summary).toBe("진단이 틀렸습니다.");
    // 수락된 수정 결과·반박 정지는 계약 도입 전(구 엔진)의 것이다(계약 0건, 최신 checkpoint 는 diagnosis#DG-1 의 paused 기록).
    await legacyTopic(r);
    const legacy = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; work: { fixSource?: string } };
    expect([legacy.phase, legacy.work.fixSource]).toEqual(["paused", "diagnosis#DG-1"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }), { mediator: true })).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.codex.prompts.length > codexBefore && r.database.runningAction(r.topicId) === null
      && ["READY_TO_DELIVER", "USER_DECISION_REQUIRED"].includes(r.database.getTopic(r.topicId).state), "retry 뒤 최종 리뷰 정지");
    // 최종 리뷰의 대조 보고는 수락된 옛 수정 결과다(수정 단계에서만 기록한 F-8 까지) — 반박으로 멈추며 저장한 결과(DG-1 REFUTED)가 아니다.
    const finalReview = r.codex.prompts[codexBefore];
    expect(finalReview).toContain("반환 kind는 FINAL_REVIEW");
    const report = reviewReportIn(finalReview);
    expect([report.kind, report.summary, report.findings.map((finding) => [finding.id, finding.disposition])])
      .toEqual(["FIX", "F-1 수정 보고", [["F-1", "RESOLVED_BY_FIX"], ["F-8", "AGREED_NO_ACTION"]]]);
    // F-1 반영을 대조한 최종 리뷰는 커버리지 교정 없이 통과해 인도 대기·커밋에 이른다.
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect(r.codex.prompts.slice(codexBefore)).toHaveLength(1);
    expect(r.claude.turns).toHaveLength(3);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계획 개정을 구현한 뒤 인도 대기 순차 적용 창을 수정 불필요 정정으로 닫아(인도 대기 → 실패, 재개 = 최종 리뷰) 대기 중이던 수정 진단을 적용하면, 새 진단 전용 계약은 인도 대기에서 연 계약(원본 없음)이고 수정 턴은 개정 전 최종 리뷰의 정지 쟁점 F-2 를 싣지 않는다 — 그 수정은 되돌림 정지 없이 수락되고 최종 리뷰를 거쳐 인도 대기·커밋에 이른다(2026-09-15 감사 4차 #4)", { timeout: 60_000 }, async () => {
    const { r, register, apply } = await revisedCycleReady("cycle-window-stale-stop");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 D" }))).status).toBe(201);
    // 다른 수정 진단(DG-5)이 대기 중이라 DG-4 적용은 기록만 한다(순차 적용 창). 그 창을 수정 불필요 정정으로 닫으면 재개 단계가 최종 리뷰가 된다.
    const waiting = await apply("DG-4");
    expect(waiting.status).toBe(200);
    expect(waiting.body.actionId).toBeNull();
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-4 수정 불필요", supersedes: "DG-4" }))).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "DG-5 반영\n");
      return result("FIX", "DG-5 를 반영했습니다.", { status: "completed", findings: [resolved("DG-5")] });
    });
    const codexBefore = r.codex.prompts.length;
    expect((await apply("DG-5")).status).toBe(200);
    await waitFor(() => fixPrompt !== "" && r.database.runningAction(r.topicId) === null
      && ["USER_DECISION_REQUIRED", "FAILED", "READY_TO_DELIVER"].includes(r.database.getTopic(r.topicId).state), "DG-5 수정 턴 뒤 정지");
    // 1) DG-5 의 새 계약은 인도 대기에서 연 계약이다 — 개정 전 최종 리뷰(정지 쟁점 F-2)를 원본으로 동결하지 않는다.
    const topic = r.database.getTopic(r.topicId);
    const contract = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((row) => row.diagnosisIds.includes("DG-5"));
    expect([contract?.origin, contract?.source.map((finding) => finding.id)]).toEqual([{ stage: "READY_TO_DELIVER", review: null }, []]);
    // 2) 수정 턴은 DG-5 만 싣고 개정 전 정지 쟁점 F-2 를 싣지 않는다.
    expect(fixPrompt).toContain("[DG-5]");
    expect(fixPrompt).not.toContain('"id": "F-2"');
    // 3) 수정은 수락된다(되돌림·계약 교정 정지 없음). 최종 리뷰는 구현 리뷰 한도(첫 리뷰·최종 리뷰 #1·개정 계획 리뷰로 3회 소진)에 막혀 멈춘다 — F-2 정지가 아니다.
    expect(contract?.status).toBe("accepted");
    expect(r.claude.turns).toHaveLength(8);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(topic.lastError).toContain("리뷰 한도");
    expect(r.codex.prompts).toHaveLength(codexBefore);
    // 4) 리뷰 1회를 추가 승인하고 재개하면 최종 리뷰도 F-2 없이 DG-5 반영을 대조해 인도 대기에 이르고 커밋이 열린다.
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(1);
    expect(finals[0]).not.toContain('"id": "F-2"');
    expect(reviewReportIn(finals[0]).findings.map((finding) => [finding.id, finding.disposition])).toEqual([["DG-5", "RESOLVED_BY_FIX"]]);
    expect(r.claude.turns).toHaveLength(8);
    expect((await r.diagnoses()).find((record) => record.id === "DG-5")?.status).toBe("resolved");
    await closeRevisedAwayDG1(r, "개정 계획 인도");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "개정 계획 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계획 개정을 구현한 뒤 인도 대기 순차 적용 창의 수정 진단을 모두 수정 불필요 정정으로 닫고 재시도하면, 최종 리뷰의 대조 보고는 개정 계획의 구현 결과('개정 계획대로 구현했습니다.', DG-3)다 — 개정 전에 수락된 진단 전용 계약 FC-1 의 누적본('DG-1 반영')이 아니다(2026-09-15 감사 4차 #5)", { timeout: 60_000 }, async () => {
    const { r, register, apply } = await revisedCycleReady("cycle-window-closed-report");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 D" }))).status).toBe(201);
    const waiting = await apply("DG-4");
    expect(waiting.status).toBe(200);
    expect(waiting.body.actionId).toBeNull();
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-4 수정 불필요", supersedes: "DG-4" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-5 수정 불필요", supersedes: "DG-5" }))).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 보조 확인: 수락 계약은 개정 전의 FC-1 뿐이고, 개정 뒤 인도 대기에서 연 FC-3 은 수정 없이 닫혔다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1"], "accepted"], ["FC-2", ["DG-2"], "abandoned"], ["FC-3", ["DG-4"], "closed"]]);
    const codexBefore = r.codex.prompts.length;
    // 재시도는 구현 리뷰 한도에 막혀 멈춘다 — 리뷰 1회를 추가 승인하고 재개한다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("리뷰 한도");
    expect(r.codex.prompts).toHaveLength(codexBefore);
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 최종 리뷰의 대조 보고는 개정 계획의 구현 결과다.
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(1);
    const report = reviewReportIn(finals[0]);
    expect([report.kind, report.summary, report.findings.map((finding) => [finding.id, finding.disposition])])
      .toEqual(["IMPLEMENTATION", "개정 계획대로 구현했습니다.", [["DG-3", "RESOLVED_BY_FIX"]]]);
    expect(finals[0]).not.toContain("DG-1 반영");
    expect(r.claude.turns).toHaveLength(7);
    await closeRevisedAwayDG1(r, "개정 계획 인도");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "개정 계획 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계획 개정을 구현한 뒤 인도 대기에서 적용한 진단 전용 수정 턴이 죽고 그 진단을 수정 불필요 정정으로 닫아 재시도하면, 최종 리뷰의 대조 보고는 개정 계획의 구현 결과다 — 계약 역순 탐색이 닫힌 FC-3·버린 FC-2 를 지나 개정 전 수락 계약 FC-1 의 누적본('DG-1 반영')에 닿지 않는다(2026-09-15 감사 4차 #8)", { timeout: 60_000 }, async () => {
    const { r, register, apply } = await revisedCycleReady("cycle-crashed-fix-report");
    let crashedPrompt = "";
    r.claude["steps"].push((turn) => { crashedPrompt = turn.prompt; throw new Error("DG-4 진단 수정 턴 프로세스 비정상 종료"); });
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await apply("DG-4")).status).toBe(200);
    await r.idle("FAILED");
    expect(crashedPrompt).toContain("[DG-4]");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await register(fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 외부 원인", supersedes: "DG-4" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 보조 확인: 개정 뒤 계약 FC-3 은 수정 없이 닫혔고, 수락 계약은 개정 전의 FC-1 뿐이다.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1"], "accepted"], ["FC-2", ["DG-2"], "abandoned"], ["FC-3", ["DG-4"], "closed"]]);
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("리뷰 한도");
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(1);
    const report = reviewReportIn(finals[0]);
    expect([report.kind, report.summary, report.findings.map((finding) => [finding.id, finding.disposition])])
      .toEqual(["IMPLEMENTATION", "개정 계획대로 구현했습니다.", [["DG-3", "RESOLVED_BY_FIX"]]]);
    expect(finals[0]).not.toContain("DG-1 반영");
    expect(r.claude.turns).toHaveLength(8);
    await closeRevisedAwayDG1(r, "개정 계획 인도");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "개정 계획 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("최종 리뷰 정지(F-2, 재개 = 최종 리뷰)에서 구현 재개(resume-implementation)로 다시 구현하고 첫 리뷰를 통과한 뒤 인도 대기에서 적용한 진단 전용 수정이 반박되고 수정 불필요 정정으로 닫혀 재시도하면, 최종 리뷰의 대조 보고는 재구현 결과('구현을 다시 했습니다.')다 — 구현 재개 전에 수락된 리뷰 수정 계약 FC-1 의 누적본('F-1 반영')이 아니고, 재개 전 주기의 F-1 을 커버리지·알려진 쟁점으로 삼지 않는다(2026-09-15 감사 4차 #13)", { timeout: 60_000 }, async () => {
    const r = await room("resume-implementation-cycle-report", [], { codex: "review-fix-final-stop" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 1\n"); return result("IMPLEMENTATION", "구현 1 을 마쳤습니다.", { status: "completed" }); },
      () => {
        writeFileSync(join(r.worktree, "feature.txt"), "F-1 반영\n");
        return result("FIX", "F-1 반영", { status: "completed", findings: [{ ...REVIEW_FIX_FINDING, disposition: "RESOLVED_BY_FIX", rationale: "F-1 수정" }] });
      },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "재구현\n"); return result("IMPLEMENTATION", "구현을 다시 했습니다.", { status: "completed" }); },
      () => result("FIX", "DG-1 은 틀렸습니다.", { status: "completed", findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "원인이 다릅니다." }] }),
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    // 첫 리뷰 F-1 → 리뷰 수정 FC-1 수락('F-1 반영') → 최종 리뷰 #1 이 F-2 로 멈춘다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 구현부터 다시 한다 — 재구현 뒤 첫 리뷰를 통과해 인도 대기에 이른다.
    const resumed = await r.call("POST", `/api/topics/${r.topicId}/actions/resume-implementation`,
      { expectedState: "USER_DECISION_REQUIRED", expectedScopeGeneration: 1, reason: "구현부터 다시" }, { mediator: true });
    expect(resumed.status).toBe(200);
    // 공식 재개 이벤트는 F-2 답변이 아니므로 사용자의 별도 결정을 제공한다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-2 로그 경로는 재구현한 방식으로 진행하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "resume-implementation-cycle-report 추가 승인")).toBe("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(3);
    // 인도 대기에서 적용한 진단 전용 수정을 러너가 반박하고, 중재자가 수정 불필요 정정으로 닫는다(재개 = 최종 리뷰).
    expect((await register(fixDiagnosis({ title: "외부 검증 실패" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await register(fixDiagnosis({ kind: "no_action", title: "수정 불필요", supersedes: "DG-1" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 보조 확인: 수락 계약은 구현 재개 전의 리뷰 수정 FC-1 뿐이고 재구현 결과보다 앞선다. 재구현 뒤 계약 FC-2 는 수정 없이 닫혔다.
    const topic = r.database.getTopic(r.topicId);
    const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(contracts.map((contract) => [contract.contractId, contract.route, contract.status])).toEqual([["FC-1", "review", "accepted"], ["FC-2", "diagnosis", "closed"]]);
    expect(contracts[0].settledAfter ?? Number.POSITIVE_INFINITY).toBeLessThan(r.database.latestArtifact(r.topicId, "implementation-result")!.revision);
    const codexBefore = r.codex.prompts.length;
    // 재시도는 구현 리뷰 한도(첫 리뷰·최종 리뷰 #1·재구현 리뷰로 3회 소진)에 막혀 멈춘다 — 리뷰 1회를 추가 승인하고 재개한다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.database.runningAction(r.topicId) === null && r.database.getTopic(r.topicId).state === "USER_DECISION_REQUIRED"
      && (r.database.getTopic(r.topicId).lastError ?? "").includes("리뷰 한도"), "재시도 뒤 리뷰 한도 정지");
    expect(r.codex.prompts).toHaveLength(codexBefore);
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    const retryAt = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await waitFor(() => r.codex.prompts.length > codexBefore && r.database.runningAction(r.topicId) === null
      && ["READY_TO_DELIVER", "USER_DECISION_REQUIRED", "FAILED"].includes(r.database.getTopic(r.topicId).state), "재시도 뒤 최종 리뷰 정지");
    // 최종 리뷰의 대조 보고는 재구현 결과다.
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals.length).toBeGreaterThan(0);
    const report = reviewReportIn(finals[0]);
    expect([report.kind, report.summary, report.findings.map((finding) => finding.id)]).toEqual(["IMPLEMENTATION", "구현을 다시 했습니다.", []]);
    expect(finals[0]).not.toContain("F-1 반영");
    // 재개 전 주기의 F-1 은 이 최종 리뷰가 대조하는 쟁점(보고·원본)이 아니다 — 옛 F-1 을 커버리지 교정으로 요구하지 않는다. 이 가짜 리뷰어는 뒤 최종 리뷰마다
    // F-1 을 해결로 덧붙이므로, 대조할 보고 쟁점이 없는 F-1 은 새 쟁점으로 사용자 판단을 기다린다(옛 누적본으로 F-1 을 대조해 인도 대기로 넘기지 않는다).
    expect(finals).toHaveLength(1);
    expect(r.codex.prompts.slice(codexBefore).some((prompt) => prompt.includes("서버 기계 검사가 방금 응답을 거부했습니다"))).toBe(false);
    const afterRetry = r.database.getTimeline(r.topicId).filter((event) => event.sequence > retryAt);
    expect(afterRetry.map((event) => event.payload?.finalReviewNewFindingIDs).filter((ids) => ids !== undefined)).toEqual([["F-1"]]);
    expect(afterRetry.some((event) => event.body.includes("최종 읽기 전용 리뷰를 통과했습니다"))).toBe(false);
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.claude.turns).toHaveLength(4);
    r.database.close();
  });

  it("OVERRULE 줄에 설명 문장이 붙은 결정('OVERRULE F-3 — F-1 은 반드시 고쳐 주세요.')은 지시 전체가 무효라 문장 속 F-1 을 면제로 세지 않는다 — 러너의 F-1 하향(수정 불필요)을 수락하지 않고 F-1 을 지목해 멈추며, 최종 리뷰·인도 대기·커밋에 이르지 않는다(2026-09-15 감사 4차 #6)", { timeout: 60_000 }, async () => {
    const { r, settled } = await downgradeAfterDecision("overrule-prose-line", "OVERRULE F-3 — F-1 은 반드시 고쳐 주세요.");
    // 1) 수락 가드가 F-1 하향을 되돌림으로 잡아 멈춘다(재개 = 수정 작업).
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain("처분을 되돌렸습니다(F-1)");
    // 2) 최종 리뷰는 열리지 않았고(첫 리뷰 1회뿐) 결정이 하향을 허용했다는 기록도 없다. 커밋은 막힌다.
    expect(r.codex.prompts).toHaveLength(1);
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("사용자 결정이 처분 변경을 허용한 쟁점"))).toBe(false);
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-1 미수정 인도", paths: ["feature.txt"] });
    expect(commit.status).toBeGreaterThanOrEqual(400);
    // (보조) 리뷰 수정 계약은 열린 채이고 자동 수정 회차도 소비되지 않았다.
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(false);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.route, contract.status])).toEqual([["review", "open"]]);
    r.database.close();
  });

  it("키워드만 있는 OVERRULE 줄은 다음 줄로 넘어가지 않는다 — 다음 줄에 'F-1 은 반드시 고쳐 주세요.' 를 적은 결정은 F-1 을 면제로 세지 않아 러너의 F-1 하향을 수락하지 않고 멈추며, 최종 리뷰·커밋에 이르지 않는다(2026-09-15 감사 4차 #6)", { timeout: 60_000 }, async () => {
    const { r, settled } = await downgradeAfterDecision("overrule-line-cross", "OVERRULE\nF-1 은 반드시 고쳐 주세요.");
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain("처분을 되돌렸습니다(F-1)");
    expect(r.codex.prompts).toHaveLength(1);
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("사용자 결정이 처분 변경을 허용한 쟁점"))).toBe(false);
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-1 미수정 인도", paths: ["feature.txt"] });
    expect(commit.status).toBeGreaterThanOrEqual(400);
    r.database.close();
  });

  it("점이 든 finding id(S6.5-GATE2 — 스키마상 유효한 운영 형식)도 줄 머리 'OVERRULE S6.5-GATE2' 결정이면 면제된다 — 러너의 S6.5-GATE2 하향(수정 불필요)이 수락 가드와 최종 리뷰 되돌림 검사를 통과해 인도 대기·커밋에 이른다(2026-09-15 감사 4차 #11)", { timeout: 60_000 }, async () => {
    const r = await room("overrule-dotted-id", [], { codexInstance: new DottedIdReviewCodex() });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => result("FIX", "S6.5-GATE2 는 사용자 지시대로 고치지 않습니다.", {
        status: "completed", findings: [
          { ...DOTTED_GATE_FINDING, disposition: "AGREED_NO_ACTION", rationale: "사용자 지시대로 S6.5-GATE2 는 이번 범위에서 고치지 않습니다." },
          { ...CHANNEL_F3, requiresUserDecision: false, rationale: "사용자 결정대로 채널 A." },
        ],
      }),
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_REVIEW");
    const decision = "OVERRULE S6.5-GATE2\nS6.5-GATE2 는 이번 범위에서 고치지 않습니다. F-3 은 채널 A 로 하세요.";
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: decision })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    const settled = await settledState(r, "overrule-dotted-id");
    expect(settled, r.database.getTopic(r.topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("사용자 결정이 처분 변경을 허용한 쟁점: S6.5-GATE2(AGREED_ACTION → AGREED_NO_ACTION)"))).toBe(true);
    expect(r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toHaveLength(1);
    const finalReview = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(finalReview.findings.find((finding) => finding.id === "S6.5-GATE2")?.disposition).toBe("AGREED_NO_ACTION");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "S6.5-GATE2 는 사용자 지시로 미수정", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("수락 가드의 처분 되돌림 정지는 폐기된 'id 를 적은 결정' 규칙이 아니라 줄 머리 OVERRULE 지시어를 해법으로 안내하고, 그 안내대로('OVERRULE F-1' 한 줄, 설명은 다음 줄) 결정을 올려 retry 하면 같은 정지로 돌아가지 않고 최종 리뷰를 거쳐 인도 대기·커밋에 이른다(2026-09-15 감사 4차 #3·#10)", { timeout: 60_000 }, async () => {
    const { r, settled } = await downgradeAfterDecision("overrule-guidance", "F-3 은 채널 A 로 하세요.");
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const stop = r.database.getTopic(r.topicId).lastError ?? "";
    expect(stop).toContain("처분을 되돌렸습니다(F-1)");
    // 1) 멈춤 안내가 실제로 통하는 해법(줄 머리 OVERRULE 지시어)을 알린다 — 따르면 같은 정지로 돌아오던 "쟁점 id 를 적은 결정" 규칙이 아니다.
    expect(stop).toContain("OVERRULE <id>");
    expect(stop).not.toContain("쟁점 id 를 적은 결정");
    // 2) 안내대로 결정을 올리고 retry — 러너는 결정대로 F-1 을 다시 수정 불필요로 낸다.
    r.claude["steps"].push(() => result("FIX", "사용자 지시대로 F-1 은 고치지 않습니다.", {
      status: "completed", findings: [
        { ...DEMANDED_F1, disposition: "AGREED_NO_ACTION", rationale: "사용자 지시대로 F-1 은 이번 범위에서 고치지 않습니다." },
        { ...CHANNEL_F3, requiresUserDecision: false, rationale: "사용자 결정대로 채널 A." },
      ],
    }));
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "OVERRULE F-1\nF-1 은 영향이 없으니 이번 범위에서 고치지 않습니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "overrule-guidance-retry")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("구현 리뷰 한도");
    const after = await g6aSettleWithGrants(r, "overrule-guidance-retry");
    expect(after, r.database.getTopic(r.topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    const bodies = r.database.getTimeline(r.topicId).map((event) => event.body);
    expect(bodies.filter((body) => body.includes("처분을 되돌렸습니다"))).toHaveLength(1);
    expect(bodies.some((body) => body.includes("사용자 결정이 처분 변경을 허용한 쟁점: F-1(AGREED_ACTION → AGREED_NO_ACTION)"))).toBe(true);
    expect(r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toHaveLength(1);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-1 은 사용자 지시로 미수정", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // ---- 2026-09-15 감사 4차 #7·#12 (g4) ----
  // 감사 4차 #7: 최종 리뷰에서만 반영 보고된 진단 DG-1 을 범위 밖(DEFERRED_OUT_OF_SCOPE)으로 판정하는 Codex — 그 밖에는 EchoCodex 처럼 보고를 되돌려 통과시킨다.
  class DeferredDiagnosisFinalCodex extends EchoCodex {
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "FINAL_REVIEW") return review;
      return {
        ...review, findings: review.findings.map((finding) => finding.id === "DG-1"
          ? { ...finding, disposition: "DEFERRED_OUT_OF_SCOPE" as const, rationale: "검증 기준(게이트 2 F1 재실행)을 이 리뷰에서 확인할 수 없어 범위 밖으로 미룹니다." } : finding),
      };
    }
  }

  // 감사 4차 #7(첫 리뷰 경로): 첫 리뷰에서만 반영 보고된 진단 DG-1 을 반박(REFUTED)으로 판정하는 Codex — 수정할 확정 결함은 없어 첫 리뷰가 곧장 인도 대기로 넘긴다.
  class RefutedDiagnosisFirstReviewCodex extends EchoCodex {
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "REVIEW") return review;
      return {
        ...review, findings: review.findings.map((finding) => finding.id === "DG-1"
          ? { ...finding, disposition: "REFUTED" as const, rationale: "DG-1 반영 주장이 검증 기준과 맞지 않습니다 — 반영을 확인하지 못했습니다." } : finding),
      };
    }
  }

  // 감사 4차 #12: 최신 work-checkpoint 위에 JSON 이 아닌 새 revision 을 쓴다 — 원장 sha 는 맞고 본문이 깨진 checkpoint(CheckpointCorrupt "JSON 아님").
  async function corruptLatestCheckpoint(r: Awaited<ReturnType<typeof room>>): Promise<number> {
    const latest = r.database.latestArtifact(r.topicId, "work-checkpoint");
    expect(latest).toBeTruthy();
    return (await r.artifacts.write(r.topicId, "work-checkpoint", latest!.revision + 1, '{"kind":"work-checkpoint","version":1,"work":')).revision;
  }

  // 감사 4차 #12(sha 불일치): 최신 work-checkpoint 의 정본 blob 을 원장 sha 와 다른 내용으로 덮는다 — readVerified 가 "기록된 SHA-256과 다릅니다" 로 거부하는
  // 손상(감사 4차 #12 재현 절의 "sha 불일치").
  function tamperLatestCheckpointBlob(r: Awaited<ReturnType<typeof room>>): number {
    const latest = r.database.latestArtifact(r.topicId, "work-checkpoint");
    expect(latest).toBeTruthy();
    writeFileSync(latest!.path, '{"kind":"work-checkpoint","version":1,"work":');
    return latest!.revision;
  }

  // 감사 4차 #12 (b)·(c) 공통 전제: 감사 2차 K 전제(최종 리뷰 #1 의 F-9 수정 턴이 응답 전에 죽어 FAILED, 재개 CLAUDE_FIX)를 계약 도입 전 토픽으로 바꾸고(legacyTopic)
  // 최신 checkpoint 를 손상시킨다. 옛 엔진은 FIX checkpoint 를 턴 응답 뒤에만 썼고 죽은 F-9 턴은 응답이 없으므로, 옛 엔진이 남겼을 최신 checkpoint 는 DG-1 진단
  // 전용 수정의 수락 checkpoint(fixSource diagnosis#DG-1)다 — 새 엔진도 같은 것을 남긴다(아래 확인). 그 최신 checkpoint 를 손상시킨다(corruption — json: 깨진 본문의
  // 새 revision, sha: 최신 revision 의 blob 변조). registerFix 면 legacyTopic 전에 수정 진단 DG-2 를 등록해 둔다 — 열린 계약이 있으면 등록은 계약을 읽기만 하고
  // 계약 행을 쓰지 않아 옛 엔진의 등록과 같은 행을 남긴다.
  async function legacyCorruptFixStop(label: string, registerFix: boolean, corruption: "json" | "sha" = "json") {
    const r = await stoppedFinalReviewFix(label);
    if (registerFix) {
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "다른 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    }
    await legacyTopic(r);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    const legacy = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { work: { kind: string; fixSource?: string }; phase: string };
    expect([legacy.work.kind, legacy.work.fixSource, legacy.phase]).toEqual(["FIX", "diagnosis#DG-1", "accepted"]);
    const corruptRevision = corruption === "json" ? await corruptLatestCheckpoint(r) : tamperLatestCheckpointBlob(r);
    return { r, corruptRevision };
  }

  it("통과한 최종 리뷰가 반영 보고된 진단 DG-1 을 범위 밖(DEFERRED_OUT_OF_SCOPE)으로 판정하면 DG-1 은 해결로 기록되지 않고 반영 보고(fix_reported)로 남아 '반영을 확인하지 않았습니다' 기록과 함께 커밋이 409 로 막힌다 — 중재자가 수정 불필요 정정(no_action, supersedes DG-1)으로 닫은 뒤에야 커밋이 열린다(2026-09-15 감사 4차 #7)", { timeout: 60_000 }, async () => {
    const r = await room("g4-final-deferred-dg", [], { codexInstance: new DeferredDiagnosisFinalCodex() });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 1) 진단 전용 수정이 수락돼 최종 리뷰를 거쳤고, 최종 리뷰는 DG-1 을 범위 밖으로 판정한 채 통과했다(수정 합의 쟁점 없음).
    expect(r.claude.turns).toHaveLength(2);
    expect(r.codex.prompts.map((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toEqual([false, true]);
    const storedFinal = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(storedFinal.findings.map((finding) => [finding.id, finding.disposition])).toEqual([["DG-1", "DEFERRED_OUT_OF_SCOPE"]]);
    // 2) 리뷰가 반영을 확인하지 않은 DG-1 은 해결이 아니다 — 반영 보고로 남고, 확인하지 않았다는 기록이 남는다.
    const [dg1] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    const unconfirmed = r.database.getTimeline(r.topicId).filter((event) => event.body.includes("반영을 확인하지 않았습니다"));
    expect(unconfirmed.map((event) => event.payload?.diagnosisUnconfirmed)).toEqual([["DG-1"]]);
    expect(unconfirmed[0].body).toContain("DG-1(DEFERRED_OUT_OF_SCOPE)");
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.diagnosisResolved !== undefined)).toBe(false);
    // 3) 열린 진단이라 커밋이 막힌다.
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 미확인 인도", paths: ["feature.txt"] });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain("해결되지 않은 진단");
    expect(JSON.stringify(blocked.body)).toContain("DG-1");
    // 4) 중재자가 수정 불필요 정정으로 DG-1 을 닫으면 인도 대기(완료 판정)는 그대로이고 커밋이 열린다.
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "DG-1 검증 기준은 인도 뒤 게이트에서 확인 — 수정 불필요", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("첫 리뷰 경로도 같다 — 멈춘 구현에 적용한 진단 DG-1 의 반영 보고를 통과한 첫 리뷰가 반박(REFUTED)으로 판정하면 DG-1 은 해결로 기록되지 않고 반영 보고(fix_reported)로 남아 커밋이 409 로 막힌다(2026-09-15 감사 4차 #7)", { timeout: 30_000 }, async () => {
    let openId = "";
    const r = await room("g4-first-review-refuted-dg", [], { codexInstance: new RefutedDiagnosisFirstReviewCodex() });
    r.claude["steps"].push(
      askingTurn(r.worktree),
      () => { writeFileSync(join(r.worktree, "feature.txt"), "진단 반영\n"); return result("IMPLEMENTATION", "진단을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
      () => result("IMPLEMENTATION", "요청을 해소했습니다.", { status: "completed", resolvesRequestedDecision: true, resolvedRequestId: openId }),
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ relatedRequestIds: [openId] }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 첫 리뷰만 돌았고(수정할 확정 결함 없음 → 인도 대기), 첫 리뷰는 DG-1 을 반박으로 판정했다.
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts).toHaveLength(1);
    expect(r.codex.prompts[0]).not.toContain("반환 kind는 FINAL_REVIEW");
    const storedReview = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-review"))!) as AgentResult;
    expect(storedReview.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("REFUTED");
    const [dg1] = await r.diagnoses();
    expect(dg1.history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.body.includes("반영을 확인하지 않았습니다")).map((event) => event.payload?.diagnosisUnconfirmed))
      .toEqual([["DG-1"]]);
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 미확인 인도", paths: ["feature.txt"] });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain("DG-1");
    r.database.close();
  });

  it("실은 진단이 모두 닫힌 진단 전용 수정 작업에 CLAUDE_FIX 가 복원된 채 최신 checkpoint 가 손상되면 retry 는 손상을 삼켜 열린 요청을 없는 것으로 보지 않는다 — 작업을 닫거나 최종 리뷰로 넘기지 않고 USER_DECISION_REQUIRED(재개 CLAUDE_FIX, checkpointCorrupt)로 멈춘다(2026-09-15 감사 4차 #12)", { timeout: 30_000 }, async () => {
    const r = await room("g4-zero-carried-corrupt", []);
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      // 진단 전용 수정 턴: 진단을 반박하면서 별도의 결정을 묻는다(열린 요청).
      () => result("FIX", "진단이 틀렸고, 배포 채널 결정이 필요합니다.", {
        status: "completed", requestedUserDecision: "배포 채널을 A 로 할까요?",
        findings: [{ ...resolved("DG-1"), disposition: "REFUTED", rationale: "원인이 다릅니다." }],
      }),
      () => result("REVISION", "계획 변경은 필요 없습니다.", {
        planEdits: [],
        findings: [{ id: "DG-2", title: "중재자 진단", severity: "HIGH", disposition: "REFUTED", rationale: "계획이 이미 허용합니다.", evidenceRefs: ["plan:R-3"], requiresUserDecision: false }],
      }),
    );
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await register(fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await register(planDiagnosis({ supersedes: "DG-1" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect((await register(fixDiagnosis({ kind: "no_action", title: "계획 변경 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    // 전제: 진단 전용 수정 작업 FC-1 은 열려 있고 실은 DG-1 은 정정으로 닫혔으며, 그 작업의 최신 checkpoint 에 열린 요청이 있다(감사 3차 #8 의 두 번째 흐름).
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", ["DG-1"], "open"]]);
    const intact = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { openRequests: unknown[] };
    expect(intact.openRequests).toHaveLength(1);
    // 그 최신 checkpoint 가 손상됐다.
    const corruptRevision = await corruptLatestCheckpoint(r);
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "g4-zero-carried-corrupt")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence);
    expect(after.filter((event) => event.payload?.checkpointCorrupt !== undefined).map((event) => [event.payload?.checkpointCorrupt, event.payload?.fixContract]))
      .toEqual([[corruptRevision, "FC-1"]]);
    // 작업을 닫지 않았고 최종 리뷰도 새 러너 턴도 없다.
    expect(after.some((event) => event.payload?.to === "CODEX_FINAL_REVIEW" || event.payload?.fixContractClosed === true)).toBe(false);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.status])).toEqual([["FC-1", "open"]]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts).toHaveLength(1);
    r.database.close();
  });

  it("계약 도입 전(구 엔진) 토픽의 멈춘 수정 작업(열린 계약 없음)에서 최신 checkpoint 가 손상되면 retry 는 손상을 삼킨 채 계약을 추정·이관하지 않는다 — 계약 행 없이 USER_DECISION_REQUIRED(재개 CLAUDE_FIX, checkpointCorrupt)로 멈추고 러너·리뷰 턴을 열지 않는다(2026-09-15 감사 4차 #12)", { timeout: 30_000 }, async () => {
    const { r, corruptRevision } = await legacyCorruptFixStop("g4-legacy-corrupt-retry", false);
    const codexBefore = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "g4-legacy-corrupt-retry")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence);
    // 손상된 checkpoint 로 계약을 추정해 이관하지 않았다 — 이관 기록도 계약 행도 없다.
    expect(after.filter((event) => event.payload?.fixContractMigrated !== undefined).map((event) => event.payload?.fixContractMigrated)).toEqual([]);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    expect(after.filter((event) => event.payload?.checkpointCorrupt !== undefined).map((event) => event.payload?.checkpointCorrupt)).toEqual([corruptRevision]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts).toHaveLength(codexBefore);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["fix_reported"]);
    r.database.close();
  });

  it("같은 손상 상태(계약 도입 전 토픽의 멈춘 수정 작업, 최신 checkpoint 손상)에서 수정 불필요 정정 등록(no_action, supersedes DG-1)은 409 로 거부된다 — 손상을 삼킨 채 계약을 추정·이관해 등록하지 않고 진단·상태·재개 단계를 바꾸지 않는다(2026-09-15 감사 4차 #12)", { timeout: 30_000 }, async () => {
    const { r, corruptRevision } = await legacyCorruptFixStop("g4-legacy-corrupt-register", false);
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "DG-1 은 외부 원인 — 수정 불필요", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(409);
    expect(JSON.stringify(closed.body)).toContain("최신 수정 checkpoint 가 손상돼 열린 수정 작업을 판정할 수 없습니다");
    expect(JSON.stringify(closed.body)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "fix_reported"]]);
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    r.database.close();
  });

  it("같은 손상 상태에서 등록해 둔 수정 진단 DG-2 의 적용(apply)도 409 로 거부된다 — 손상을 삼킨 채 계약을 추정·이관해 적용·재개하지 않고 진단·상태·재개 단계를 바꾸지 않는다(2026-09-15 감사 4차 #12)", { timeout: 30_000 }, async () => {
    const { r, corruptRevision } = await legacyCorruptFixStop("g4-legacy-corrupt-apply", true);
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true });
    expect(applied.status).toBe(409);
    // 감사 6차 #2: 적용은 이관 판정 전에 손상 checkpoint 로 거부된다(적용 뒤 재개가 멈추고 되돌릴 길이 없으므로) — 409·무변경은 그대로다.
    expect(JSON.stringify(applied.body)).toContain("최신 수정 checkpoint 가 손상돼 적용하지 않습니다");
    expect(JSON.stringify(applied.body)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "fix_reported"], ["DG-2", "registered"]]);
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    expect(r.claude.turns).toHaveLength(3);
    r.database.close();
  });

  it("최신 checkpoint 의 손상이 JSON 파손이 아니라 원장 sha 불일치(blob 변조·손상)여도 계약 도입 전 토픽의 멈춘 수정 작업에서 수정 불필요 정정 등록(no_action, supersedes DG-1)은 409 로 거부된다 — 손상을 삼킨 채 열린 계약을 판정하지 않고 등록·정정하지 않는다(2026-09-15 감사 4차 #12)", { timeout: 30_000 }, async () => {
    const { r } = await legacyCorruptFixStop("g4-legacy-sha-register", false, "sha");
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "DG-1 은 외부 원인 — 수정 불필요", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(409);
    expect(JSON.stringify(closed.body)).toContain("최신 수정 checkpoint 가 손상돼 열린 수정 작업을 판정할 수 없습니다");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "fix_reported"]]);
    expect(r.database.getTopic(r.topicId).state).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    r.database.close();
  });

  it("구현 재개(resume-implementation) 전 최종 리뷰의 반영 확인은 재구현 주기의 판정이 아니다 — 재구현이 DG-1 수정을 되돌리고 첫 리뷰가 DG-1 을 판정하지 않은 채 통과하면 DG-1 은 해결되지 않고 반영 보고(fix_reported)로 남아 '반영을 확인하지 않았습니다' 기록과 함께 커밋이 409 로 막히며, 수정 불필요 정정(no_action, supersedes DG-1)으로 닫은 뒤에야 커밋된다(2026-09-15 감사 5차 #1)", { timeout: 60_000 }, async () => {
    const r = await room("g5-resume-impl-stale-verdict", [], { codex: "final-review-decision" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
      // 재구현 턴 — DG-1 반영을 되돌린다. 이 작업에 실린 진단이 아니므로 구현 보고에 DG-1 이 없다.
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 다시 했습니다.", { status: "completed" }); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g5-resume-impl-stale-verdict 추가 승인")).toBe("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    // 최종 리뷰 #1 이 DG-1 반영을 확인(RESOLVED_BY_FIX)하면서 F-2(사용자 판정 필요)로 멈춘다 — DG-1 은 반영 보고로 남는다.
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const stoppedFinal = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(stoppedFinal.findings.map((finding) => [finding.id, finding.disposition])).toEqual([["DG-1", "RESOLVED_BY_FIX"], ["F-2", "AGREED_ACTION"]]);
    const stoppedFinalRevision = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "fix_reported"]]);
    // 구현부터 다시 한다 — 재구현이 DG-1 수정을 되돌리고, 첫 리뷰는 DG-1 을 판정하지 않은 채 통과해 인도 대기에 이른다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/resume-implementation`,
      { expectedState: "USER_DECISION_REQUIRED", expectedScopeGeneration: 1, reason: "구현부터 다시" }, { mediator: true })).status).toBe(200);
    // 공식 재개 이벤트는 F-2 답변이 아니므로 사용자의 별도 결정을 제공한다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-2 로그 경로는 재구현한 방식으로 진행하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g5-resume-impl-stale-verdict 추가 승인")).toBe("READY_TO_DELIVER");
    expect(r.claude.turns).toHaveLength(3);
    expect(readFileSync(join(r.worktree, "feature.txt"), "utf8")).toBe("구현 완료\n");
    expect(r.codex.prompts.map((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toEqual([false, true, false]);
    expect(r.database.latestArtifact(r.topicId, "implementation-result")!.revision).toBeGreaterThan(stoppedFinalRevision);
    expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-review"))!) as AgentResult).findings).toEqual([]);
    // 1) DG-1 을 확인한 리뷰는 재구현 전 주기의 최종 리뷰 #1 뿐이다 — 해결이 아니다. 반영 보고로 남고, 미확인 기록이 DG-1 을 지목한다.
    expect((await r.diagnoses())[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.diagnosisResolved !== undefined)).toBe(false);
    const unconfirmed = r.database.getTimeline(r.topicId).filter((event) => event.payload?.diagnosisUnconfirmed !== undefined);
    expect(unconfirmed.map((event) => event.payload?.diagnosisUnconfirmed)).toEqual([["DG-1"]]);
    expect(unconfirmed[0].body).toContain("통과한 리뷰가 중재자 진단 DG-1(판정 없음) 의 반영을 확인하지 않았습니다");
    // 2) 열린 진단이라 DG-1 수정이 빠진 코드는 커밋되지 않는다.
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "재구현 뒤 인도", paths: ["feature.txt"] });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain("해결되지 않은 진단");
    expect(JSON.stringify(blocked.body)).toContain("DG-1");
    // 3) 중재자가 수정 불필요 정정으로 DG-1 을 닫으면 인도 대기(완료 판정)는 그대로이고 커밋이 열린다.
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "DG-1 은 재구현이 다룬다 — 수정 불필요", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("계획 개정 전 최종 리뷰의 반영 확인은 개정 계획 구현 주기의 판정이 아니다 — 개정 구현의 첫 리뷰가 DG-3 만 판정하고 통과하면 DG-1 은 해결되지 않고 반영 보고(fix_reported)로 남아 '반영을 확인하지 않았습니다' 기록과 함께 커밋이 409 로 막히며, 수정 불필요 정정(no_action, supersedes DG-1)으로 닫은 뒤에야 커밋된다(2026-09-15 감사 5차 #1)", { timeout: 60_000 }, async () => {
    const { r, register } = await revisedCycleReady("g5-revised-cycle-stale-verdict");
    // 전제: DG-1 을 확인한 리뷰는 개정 전 최종 리뷰(F-2 정지) 하나뿐이고, 통과한 개정 구현의 첫 리뷰는 DG-3 만 판정했다.
    const staleFinal = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(staleFinal.findings.find((finding) => finding.id === "DG-1")?.disposition).toBe("RESOLVED_BY_FIX");
    const passingFirst = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-review"))!) as AgentResult;
    expect(passingFirst.findings.map((finding) => [finding.id, finding.disposition])).toEqual([["DG-3", "AGREED_NO_ACTION"]]);
    expect(r.database.latestArtifact(r.topicId, "codex-review")!.revision).toBeGreaterThan(r.database.latestArtifact(r.topicId, "implementation-result")!.revision);
    // 1) DG-1 은 해결이 아니다 — 반영 보고로 남는다. 해결 기록은 이번 주기 리뷰가 확인한 DG-3 뿐이고, 미확인 기록이 DG-1 을 지목한다.
    const records = await r.diagnoses();
    expect(records.map((record) => [record.id, record.status])).toEqual([["DG-1", "fix_reported"], ["DG-2", "superseded"], ["DG-3", "resolved"]]);
    expect(records[0].history.map((entry) => entry.status)).toEqual(["registered", "applied", "delivered", "fix_reported"]);
    const timeline = r.database.getTimeline(r.topicId);
    expect(timeline.filter((event) => event.payload?.diagnosisResolved !== undefined).map((event) => event.payload?.diagnosisResolved)).toEqual([["DG-3"]]);
    const unconfirmed = timeline.filter((event) => event.payload?.diagnosisUnconfirmed !== undefined);
    expect(unconfirmed.map((event) => event.payload?.diagnosisUnconfirmed)).toEqual([["DG-1"]]);
    expect(unconfirmed[0].body).toContain("통과한 리뷰가 중재자 진단 DG-1(판정 없음) 의 반영을 확인하지 않았습니다");
    // 2) 열린 진단이라 커밋이 막힌다.
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "개정 계획 인도", paths: ["feature.txt"] });
    expect(blocked.status).toBe(409);
    expect(JSON.stringify(blocked.body)).toContain("해결되지 않은 진단");
    expect(JSON.stringify(blocked.body)).toContain("DG-1");
    // 3) 중재자가 수정 불필요 정정으로 DG-1 을 닫으면 인도 대기는 그대로이고 커밋이 열린다.
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-1 은 개정 계획이 다룬다 — 수정 불필요", supersedes: "DG-1" }))).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status]))
      .toEqual([["DG-1", "superseded"], ["DG-2", "superseded"], ["DG-3", "resolved"], ["DG-4", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 정정 뒤 개정 계획 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("진단 전용 계약 FC-2 원본의 합의 쟁점 F-2 를 최종 리뷰가 수정 확인 없이 닫아 되돌림 가드로 멈춘 뒤 OVERRULE 없이 무관한 진단 DG-3 을 적용·수락해도 F-2 는 다음 최종 리뷰의 원본 절에 합의 기준으로 남는다 — 대조 보고는 FC-3 의 수락 결과이고, 리뷰어가 다시 수정 불필요로 닫으면 되돌림 가드가 다시 멈춰 인도 대기·커밋에 이르지 않으며, 'OVERRULE F-2' 결정 뒤에야 인도 대기·커밋에 이른다(2026-09-15 감사 5차 #2)", { timeout: 90_000 }, async () => {
    const { r, register, apply, dg3Prompt } = await withdrawnSourceGuardStop("g2-withdrawn-source-kept");
    // 1) 사용자 OVERRULE 없이 F-2 와 무관한 DG-3 을 적용한다 — 수락된 뒤 리뷰 한도로 멈춘다(최종 리뷰 #C 전).
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C(F-2 와 무관)" }))).status).toBe(201);
    expect((await apply("DG-3")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("리뷰 한도에 도달했습니다");
    expect(dg3Prompt()).toContain("DG-3");
    const topic = r.database.getTopic(r.topicId);
    const fc3 = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((contract) => contract.diagnosisIds.includes("DG-3"))!;
    expect([fc3.contractId, fc3.route, fc3.status]).toEqual(["FC-3", "diagnosis", "accepted"]);
    // 2) 리뷰 1회를 추가 승인하고 재개하면 최종 리뷰 #C 가 돈다.
    const codexBefore = r.codex.prompts.length;
    const resumedAt = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    const settledC = await settledState(r, "g2-withdrawn-source-kept 최종 리뷰 #C");
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(1);
    // 3) #C 의 원본 절에 F-2 가 FC-2 원본의 합의 판(수정 합의 + 판정 필요) 그대로 남는다 — 무관한 FC-3(원본 없음)이 최신 수락 계약이어도 빠지지 않는다.
    const shown = contractSourceIn(finals[0]);
    expect(shown?.map((finding) => finding.id)).toEqual(["F-2"]);
    expect(shown?.[0]).toMatchObject({ disposition: "AGREED_ACTION", requiresUserDecision: true, rationale: FINAL_REVIEW_DECISION_FINDING.rationale });
    expect(finals[0]).toContain("고치기로 합의한 기준입니다");
    // 4) 대조 보고는 여전히 최신 수락 계약 FC-3 의 수락 결과(acceptId checkpoint 누적본)다.
    const accepting = await r.artifacts.verifiedByRevision(r.topicId, "work-checkpoint", fc3.acceptId!);
    const accepted = (JSON.parse(accepting!.content) as { accumulated: AgentResult }).accumulated;
    const report = reviewReportIn(finals[0]);
    expect(report.summary).toBe(accepted.summary);
    expect(report.findings.map((finding) => [finding.id, finding.disposition])).toEqual(accepted.findings.map((finding) => [finding.id, finding.disposition]));
    expect(report.findings.map((finding) => [finding.id, finding.disposition])).toEqual([["DG-3", "RESOLVED_BY_FIX"]]);
    // 5) 리뷰어가 F-2 를 다시 수정 불필요로 닫자 되돌림 가드가 다시 멈춘다 — 통과·인도 대기 없이 커밋은 거부된다.
    expect(settledC).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("수정 확인 없이 닫았습니다(F-2)");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > resumedAt)
      .some((event) => event.body.includes("최종 읽기 전용 리뷰를 통과했습니다"))).toBe(false);
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 없이 인도", paths: ["feature.txt", "other.txt"] });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(String(blocked.body.error)).toContain("READY_TO_DELIVER");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    // 6) 사용자가 줄 머리 'OVERRULE F-2' 결정을 올리고 재시도해야 인도 대기·커밋에 이른다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "OVERRULE F-2\nF-2 는 수정하지 않아도 됩니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g2-withdrawn-source-kept OVERRULE")).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "resolved"], ["DG-2", "resolved"], ["DG-3", "resolved"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "OVERRULE F-2 뒤 인도", paths: ["feature.txt", "other.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("최종 리뷰 정지 #F1 을 원본으로 연 리뷰 수정 계약 FC-2 가 수락돼 그 정지를 소비한 뒤 다음 최종 리뷰가 죽으면(FAILED, 재개 = 최종 리뷰) 적용한 진단 DG-1 의 새 계약은 인도 대기 출처(review null)·원본 없음이다 — 소비된 정지의 F-2 를 러너 프롬프트에 다시 싣지 않고 계약 교정 턴을 사지 않는다(2026-09-15 감사 5차 #5)", { timeout: 60_000 }, async () => {
    const r = await room("g2-consumed-stop", [], { codexInstance: new ConsumedFinalStopCodex() });
    let diagnosisPrompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => {
        writeFileSync(join(r.worktree, "feature.txt"), "F-1 반영\n");
        return result("FIX", "F-1 반영", { status: "completed", findings: [{ ...REVIEW_FIX_FINDING, disposition: "RESOLVED_BY_FIX", rationale: "F-1 수정" }] });
      },
      () => {
        writeFileSync(join(r.worktree, "feature.txt"), "F-2 반영\n");
        return result("FIX", "F-2 반영(사용자 결정대로)", {
          status: "completed", findings: [{ ...FINAL_REVIEW_DECISION_FINDING, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "사용자 결정대로 F-2 수정" }],
        });
      },
      (turn) => {
        diagnosisPrompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n");
        return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] });
      },
      // 소비된 정지의 F-2 를 원본으로 동결하면 이 계약 교정 턴이 열린다 — 경계가 맞으면 쓰이지 않는다.
      () => result("FIX", "DG-1 반영(교정)", {
        status: "completed",
        findings: [resolved("DG-1"), { ...FINAL_REVIEW_DECISION_FINDING, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "이미 FC-2 에서 고쳤습니다" }],
      }),
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const stop = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-2 는 고치세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g2-consumed-stop 추가 승인")).toBe("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain("최종 리뷰 프로세스 비정상 종료");
    const topic = r.database.getTopic(r.topicId);
    const before = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(before.map((contract) => [contract.contractId, contract.route, contract.status])).toEqual([["FC-1", "review", "accepted"], ["FC-2", "review", "accepted"]]);
    const fc2 = before[1];
    // 전제: 정지 #F1 은 FC-2 수락(정산)이 이미 소비했다 — 그 뒤 저장된 최종 리뷰는 없다(죽은 턴은 산출물을 남기지 않았다).
    expect(fc2.origin).toEqual({ stage: "CODEX_FINAL_REVIEW", review: { kind: "codex-final-review", revision: stop } });
    expect(fc2.settledAfter!).toBeGreaterThan(stop);
    expect(r.database.latestArtifact(r.topicId, "codex-final-review")!.revision).toBe(stop);
    const applySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "최종 리뷰 크래시 뒤 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await settledState(r, "g2-consumed-stop");
    const fc3 = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((contract) => contract.diagnosisIds.includes("DG-1"))!;
    expect([fc3.contractId, fc3.route]).toEqual(["FC-3", "diagnosis"]);
    // 1) 새 계약은 인도 대기 출처(review null)·원본 없음 — 결정 시작점도 소비된 정지(#F1)가 아니라 적용 시점이다.
    expect(fc3.origin).toEqual({ stage: "READY_TO_DELIVER", review: null });
    expect(fc3.source).toEqual([]);
    expect(fc3.decisionFrom).toBeGreaterThan(fc2.settledAfter!);
    // 2) 러너 프롬프트에 소비된 정지의 F-2 가 없고, 교정 턴 없이 DG-1 보고만으로 수락됐다.
    expect(diagnosisPrompt).toContain("DG-1");
    expect(diagnosisPrompt).not.toContain('"id": "F-2"');
    expect(fc3.status).toBe("accepted");
    expect(r.claude.turns).toHaveLength(4);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > applySequence)
      .some((event) => event.body.includes("검토 쟁점을 누락했습니다"))).toBe(false);
    r.database.close();
  });

  it("통과한 최종 리뷰(참고 쟁점 F-8) 뒤 인도 대기에서 연 진단 전용 계약이 수정 불필요 정정으로 닫힌(재개 = 최종 리뷰) 다음 적용한 진단 DG-4 의 새 계약은 인도 대기 출처(review null)·원본 없음이다 — 통과 리뷰를 정지로 보지 않아 F-8 을 원본·러너 프롬프트에 동결하지 않고 교정 턴 없이 인도 대기에 이른다(2026-09-15 감사 5차 #5)", { timeout: 60_000 }, async () => {
    const r = await room("g2-passing-review-not-stop", [], { codexInstance: new PassingInfoFinalReviewCodex() });
    let dg4Prompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
      () => result("FIX", "DG-2 는 틀렸습니다.", { status: "completed", findings: [{ ...resolved("DG-2"), disposition: "REFUTED", rationale: "원인이 다릅니다." }] }),
      (turn) => {
        dg4Prompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-4 반영\n");
        return result("FIX", "DG-4 반영", { status: "completed", findings: [resolved("DG-4")] });
      },
      // 통과 리뷰의 F-8 을 원본으로 동결하면 이 계약 교정 턴이 열린다 — 경계가 맞으면 쓰이지 않는다.
      () => result("FIX", "DG-4 반영(교정)", { status: "completed", findings: [resolved("DG-4"), { ...PASSING_INFO_F8, disposition: "AGREED_NO_ACTION", rationale: "참고 사항" }] }),
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 전제: 최종 리뷰 #P 는 참고 쟁점 F-8(INFO 수정 합의)을 담고 통과해 인도 대기에 이르렀다.
    const passing = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult).findings.map((finding) => [finding.id, finding.disposition]))
      .toEqual([["DG-1", "RESOLVED_BY_FIX"], ["F-8", "AGREED_ACTION"]]);
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await apply("DG-2")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses()).find((record) => record.id === "DG-2")?.status).toBe("refuted");
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-2 수정 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const topic = r.database.getTopic(r.topicId);
    const fc2 = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((contract) => contract.diagnosisIds.includes("DG-2"))!;
    expect([fc2.contractId, fc2.status, fc2.origin]).toEqual(["FC-2", "closed", { stage: "READY_TO_DELIVER", review: null }]);
    expect(fc2.settledAfter!).toBeGreaterThan(passing);
    const applySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await apply("DG-4")).status).toBe(200);
    const settled = await settledState(r, "g2-passing-review-not-stop");
    const fc3 = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((contract) => contract.diagnosisIds.includes("DG-4"))!;
    expect([fc3.contractId, fc3.route]).toEqual(["FC-3", "diagnosis"]);
    // 1) 새 계약은 인도 대기 출처(review null)·원본 없음 — 통과 리뷰 #P 는 정지가 아니고, 결정 시작점도 그 리뷰가 아니라 적용 시점이다.
    expect(fc3.origin).toEqual({ stage: "READY_TO_DELIVER", review: null });
    expect(fc3.source).toEqual([]);
    expect(fc3.decisionFrom).toBeGreaterThan(fc2.settledAfter!);
    // 2) F-8 은 러너 프롬프트에 실리지 않고, 교정 턴 없이 DG-4 보고만으로 수락돼 최종 리뷰를 거쳐 인도 대기에 이른다.
    expect(dg4Prompt).toContain("DG-4");
    expect(dg4Prompt).not.toContain('"id": "F-8"');
    expect(fc3.status).toBe("accepted");
    expect(r.claude.turns).toHaveLength(4);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > applySequence)
      .some((event) => event.body.includes("검토 쟁점을 누락했습니다"))).toBe(false);
    expect(settled).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).find((record) => record.id === "DG-4")?.status).toBe("resolved");
    r.database.close();
  });

  it("마지막 정산 뒤에 저장된 최종 리뷰 정지는 여전히 정지다 — FC-1 수락 뒤 정지 #A 에서 연 FC-2 와 FC-2 수락 뒤 되돌림 가드 정지 #B 에서 연 FC-3 은 각각 그 리뷰를 출처·결정 시작점으로 가지고, FC-2 는 #A 의 판정 필요 쟁점 F-2 를 원본으로 싣는다(2026-09-15 감사 5차 #5)", { timeout: 60_000 }, async () => {
    const { r, register, apply, stopA, stopB } = await withdrawnSourceGuardStop("g2-genuine-stop-kept");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C(F-2 와 무관)" }))).status).toBe(201);
    expect((await apply("DG-3")).status).toBe(200);
    await settledState(r, "g2-genuine-stop-kept");
    const topic = r.database.getTopic(r.topicId);
    const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(contracts.map((contract) => [contract.contractId, contract.route, contract.status, contract.diagnosisIds]))
      .toEqual([["FC-1", "diagnosis", "accepted", ["DG-1"]], ["FC-2", "diagnosis", "accepted", ["DG-2"]], ["FC-3", "diagnosis", "accepted", ["DG-3"]]]);
    const [fc1, fc2, fc3] = contracts;
    // 전제: #A 는 FC-1 정산 뒤, #B 는 FC-2 정산 뒤에 저장됐다 — 뒤 계약이 소비하지 않은 진짜 정지다.
    expect(stopA).toBeGreaterThan(fc1.settledAfter!);
    expect(fc2.settledAfter!).toBeGreaterThan(stopA);
    expect(stopB).toBeGreaterThan(fc2.settledAfter!);
    expect(fc1.origin).toEqual({ stage: "READY_TO_DELIVER", review: null });
    expect(fc2.origin).toEqual({ stage: "CODEX_FINAL_REVIEW", review: { kind: "codex-final-review", revision: stopA } });
    expect(fc2.decisionFrom).toBe(stopA);
    expect(fc2.source.map((finding) => [finding.id, finding.disposition, finding.requiresUserDecision])).toEqual([["F-2", "AGREED_ACTION", true]]);
    expect(fc3.origin).toEqual({ stage: "CODEX_FINAL_REVIEW", review: { kind: "codex-final-review", revision: stopB } });
    expect(fc3.decisionFrom).toBe(stopB);
    expect(fc3.source).toEqual([]);
    r.database.close();
  });

  // ---- 2026-09-15 감사 5차 #3·#4 (g3) ----
  // 감사 5차 #3 공통 전제(E1): 허용 오차를 feature.txt 로 좁힌 토픽 → 인도 대기 → DG-1 진단 전용 수정 적용 → 수정 턴이 범위 밖 파일(stray.txt)을 만들고 범위
  // 결정을 묻는다(열린 요청) → 허용 오차 교정 턴도 되돌리지 않아 허용 오차 정지(USER_DECISION_REQUIRED, 재개 CLAUDE_FIX). 진단 전용 계약 FC-1 은 열려 있고, 열린
  // 요청은 최신 checkpoint(paused, fixSource FC-1)에만 있다 — 구현 결과에는 요청이 없고 claude-fix 산출물도 없어 옛 산출물 폴백으로는 찾을 수 없다. 손상 전에는
  // 수정 불필요 정정(no_action, supersedes DG-1)이 열린 요청(R10)으로 409 인 것을 대조군으로 확인한다.
  async function openRequestDiagnosisFixStop(label: string) {
    const r = await room(label, [], { tolerance: TIGHT_TOLERANCE });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => {
        writeFileSync(join(r.worktree, "stray.txt"), "범위 밖\n");
        return result("FIX", "진단을 반영했고 범위 결정이 필요합니다.", { status: "completed", requestedUserDecision: "stray.txt 를 범위에 넣어도 될까요?", findings: [resolved("DG-1")] });
      },
      () => result("FIX", "되돌리지 않았습니다.", { status: "completed", findings: [resolved("DG-1")] }),
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(3);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.route, contract.diagnosisIds, contract.status]))
      .toEqual([["FC-1", "diagnosis", ["DG-1"], "open"]]);
    expect(r.database.latestArtifact(r.topicId, "claude-fix")).toBeFalsy();
    const paused = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; work: { fixSource?: string }; openRequests: Array<{ id: string }> };
    expect([paused.phase, paused.work.fixSource, paused.openRequests.length]).toEqual(["paused", "FC-1", 1]);
    const openId = paused.openRequests[0].id;
    const noAction = () => r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 외부 원인", supersedes: "DG-1" }), { mediator: true });
    const control = await noAction();
    expect(control.status).toBe(409);
    expect(String(control.body.error)).toContain(`열린 요청 ${openId}`);
    return { r, noAction };
  }

  // 감사 5차 #3(E1): 위 전제에서 최신 checkpoint 를 손상시키고(corruption — json: 깨진 본문의 새 revision, sha: 최신 revision 의 blob 변조) 같은 수정 불필요 정정을
  // 다시 등록한다. 결속이 손상을 삼키면 열린 요청이 없는 것으로 보여 201 로 계약이 닫히고, 요청을 해소하지 않은 채 최종 리뷰·커밋까지 갔다.
  async function corruptCheckpointClosingRefused(label: string, corruption: "json" | "sha") {
    const { r, noAction } = await openRequestDiagnosisFixStop(label);
    const corruptRevision = corruption === "json" ? await corruptLatestCheckpoint(r) : tamperLatestCheckpointBlob(r);
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const refused = await noAction();
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toContain("최신 수정 checkpoint 가 손상돼");
    expect(String(refused.body.error)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다`);
    // 등록하지 않았다 — 진단·계약·상태·재개 단계가 그대로이고 기록도 없다.
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "delivered"]]);
    const topic = r.database.getTopic(r.topicId);
    const contracts = () => r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.status]);
    expect(contracts()).toEqual([["FC-1", "open"]]);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    // 결정을 올리고 재시도해도 손상은 삼켜지지 않고 보고된다 — 최종 리뷰·러너 턴 없이 USER_DECISION_REQUIRED(재개 CLAUDE_FIX, checkpointCorrupt)로 멈춘다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "stray.txt 를 범위에 넣으세요." })).status).toBe(200);
    const codexBefore = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, label)).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence && event.payload?.checkpointCorrupt !== undefined)
      .map((event) => event.payload?.checkpointCorrupt)).toEqual([corruptRevision]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts).toHaveLength(codexBefore);
    expect(contracts()).toEqual([["FC-1", "open"]]);
    r.database.close();
  }

  it("열린 요청이 최신 checkpoint 에만 있는 진단 전용 수정 작업(FC-1)에서 그 checkpoint 본문이 손상되면 수정 불필요 정정(no_action, supersedes DG-1)은 손상을 삼킨 채 열린 요청이 없는 것으로 보고 작업을 닫지 않는다 — 409('최신 수정 checkpoint 가 손상돼')로 거부해 FC-1 은 열린 채, 재개 단계는 CLAUDE_FIX 로 남고, 재시도는 최종 리뷰·러너 턴 없이 손상(checkpointCorrupt)으로 멈춘다(2026-09-15 감사 5차 #3)", { timeout: 30_000 }, async () => {
    await corruptCheckpointClosingRefused("g3-corrupt-close-json", "json");
  });

  it("같은 진단 전용 수정 작업에서 최신 checkpoint 의 손상이 원장 sha 불일치(blob 변조)여도 수정 불필요 정정(no_action, supersedes DG-1)은 409('최신 수정 checkpoint 가 손상돼')로 거부된다 — FC-1 은 열린 채, 재개 단계는 CLAUDE_FIX 로 남고, 재시도는 손상(checkpointCorrupt)으로 멈춘다(2026-09-15 감사 5차 #3)", { timeout: 30_000 }, async () => {
    await corruptCheckpointClosingRefused("g3-corrupt-close-sha", "sha");
  });

  it("최신 checkpoint 가 손상되면 관련 요청(relatedRequestIds)을 지정한 진단 등록은 손상을 삼킨 채 '지금 열린 요청이 아니다'로 판정하지 않는다 — 손상을 알리는 409('최신 수정 checkpoint 가 손상돼 열린 요청을 판정할 수 없습니다')로 거부하고, 요청과 무관한 등록은 그대로 받는다(2026-09-15 감사 5차 #3)", { timeout: 30_000 }, async () => {
    const r = await room("g3-corrupt-related-request", []);
    r.claude["steps"].push(askingTurn(r.worktree));
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    const openId = requestIdsIn(r.database.getTopic(r.topicId).lastError ?? "")[0];
    expect(openId).toMatch(/^Q-[0-9a-f]{8}$/);
    // 열린 요청은 최신 checkpoint(멈춘 구현 작업)에 있다.
    const paused = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { openRequests: Array<{ id: string }> };
    expect(paused.openRequests.map((request) => request.id)).toEqual([openId]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "A 로 하세요." })).status).toBe(200);
    const corruptRevision = await corruptLatestCheckpoint(r);
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const refused = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ relatedRequestIds: [openId] }), { mediator: true });
    expect(refused.status).toBe(409);
    expect(String(refused.body.error)).toContain("최신 수정 checkpoint 가 손상돼 열린 요청을 판정할 수 없습니다");
    expect(String(refused.body.error)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    expect(await r.diagnoses()).toEqual([]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    // 요청과 무관한 등록은 받는다 — 손상은 그 checkpoint 에 기대는 판단만 막는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "registered"]]);
    r.database.close();
  });

  it("인도 대기에서 최신 checkpoint 가 손상되면 계획 변경 진단의 적용은 손상을 삼킨 채 옛 산출물의 요청만 승계한 계획 개정으로 보내지 않는다 — 409('최신 수정 checkpoint 가 손상돼 적용하지 않습니다')로 거부하고 진단·상태·완료 판정·승계 기록·러너 턴을 바꾸지 않는다(2026-09-15 감사 5차 #3)", { timeout: 30_000 }, async () => {
    const r = await room("g3-corrupt-plan-carry", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const corruptRevision = await corruptLatestCheckpoint(r);
    // 요청과 무관한 등록(계획 변경 진단)은 손상 checkpoint 가 있어도 받는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    const before = r.database.getFlags(r.topicId);
    expect(before.reviewedHead).toBeTruthy();
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(applied.status).toBe(409);
    // 감사 6차 #2: 모든 적용이 승계 기록을 만들기 전에 손상 checkpoint 로 거부된다 — 409·무변경은 그대로다.
    expect(String(applied.body.error)).toContain("최신 수정 checkpoint 가 손상돼 적용하지 않습니다");
    expect(String(applied.body.error)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "registered"]]);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    const after = r.database.getFlags(r.topicId);
    expect([after.resumeState, after.reviewedHead, after.reviewedDiffSHA256]).toEqual([before.resumeState, before.reviewedHead, before.reviewedDiffSHA256]);
    expect(r.database.latestArtifact(r.topicId, "diagnosis-carry-DG-1")).toBeFalsy();
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    expect(r.claude.turns).toHaveLength(1);
    r.database.close();
  });

  it("인도 대기에서 최신 checkpoint 가 손상돼도 통과한 최종 리뷰가 확인하지 않은 반영 보고(fix_reported) 진단을 수정 불필요 정정(no_action, supersedes DG-1)으로 닫는 등록은 받고(201) 커밋이 열린다 — 요청에 기대지 않는 종결까지 손상으로 막으면 커밋이 영구히 막힌다(2026-09-15 감사 5차 #3)", { timeout: 60_000 }, async () => {
    const r = await room("g3-corrupt-ready-no-action", [], { codexInstance: new DeferredDiagnosisFinalCodex() });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => record.history.map((entry) => entry.status))).toEqual([["registered", "applied", "delivered", "fix_reported"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 미확인 인도", paths: ["feature.txt"] })).status).toBe(409);
    await corruptLatestCheckpoint(r);
    const closed = await r.call("POST", `/api/topics/${r.topicId}/diagnoses`,
      fixDiagnosis({ kind: "no_action", title: "DG-1 검증 기준은 인도 뒤 게이트에서 확인 — 수정 불필요", supersedes: "DG-1" }), { mediator: true });
    expect(closed.status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // 감사 5차 #4: 옛 엔진(b08210b)이 남긴 상태 — 러너가 반박해 멈춘 진단 전용 수정(DG-1, paused checkpoint fixSource diagnosis#DG-1)을 중재자가 수정 불필요
  // 정정(DG-2)으로 닫아 재개 단계가 최종 리뷰가 됐고, 최종 리뷰 전에 적용한 새 진단 DG-3 의 수정 턴이 spawn 뒤 응답 전에 죽었다(FAILED, 재개 CLAUDE_FIX, DG-3
  // delivered). 옛 엔진은 FIX checkpoint 를 턴 응답 뒤에만 썼으므로 최신 checkpoint 는 DG-1 의 반박 paused 기록 그대로다 — 새 엔진도 같은 checkpoint 를 남긴다
  // (아래 확인). legacyTopic 이 계약 행을 지우고 그 checkpoint 의 작업 id 를 옛 형식(diagnosis#DG-1)으로 되돌린다.
  it("계약 도입 전(구 엔진) 토픽에서 러너 반박으로 멈춘 진단 전용 수정(diagnosis#DG-1)을 수정 불필요로 닫은 뒤 최종 리뷰 전에 적용한 새 진단 DG-3 의 수정 턴이 응답 전에 끊겼으면, retry 의 이관은 중재자가 닫은 DG-1 작업의 checkpoint 를 잇지 않는다 — 옛 엔진의 작업 id diagnosis#DG-3(진단 DG-3 만)으로 바탕 없이 시작해 최종 리뷰 대조 보고에 DG-1 반박 누적본('진단이 틀렸습니다.', DG-1 REFUTED)이 섞이지 않은 채 인도 대기·커밋에 이른다(2026-09-15 감사 5차 #4)", { timeout: 30_000 }, async () => {
    const r = await refutedDiagnosisFixStop("g3-legacy-closed-checkpoint");
    const refutedCheckpoint = r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision;
    r.claude["steps"].push(() => { throw new Error("DG-3 수정 턴 프로세스 비정상 종료"); });
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await register(fixDiagnosis({ kind: "no_action", title: "수정 불필요 — 러너 반박 수용", supersedes: "DG-1" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await register(fixDiagnosis({ title: "진짜 원인" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-3/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.claude.turns).toHaveLength(3);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"], ["DG-3", "delivered"]]);
    // 죽은 DG-3 턴은 checkpoint 를 남기지 않았다 — 최신 checkpoint 는 반박으로 멈춘 DG-1 진단 전용 수정의 paused 기록이고, 그 뒤에 저장된 리뷰가 없다.
    expect(r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision).toBe(refutedCheckpoint);
    expect(r.database.latestArtifact(r.topicId, "codex-final-review")).toBeFalsy();
    await legacyTopic(r);
    const legacy = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; work: { kind: string; fixSource?: string }; accumulated: AgentResult };
    expect([legacy.work.kind, legacy.phase, legacy.work.fixSource, legacy.accumulated.summary]).toEqual(["FIX", "paused", "diagnosis#DG-1", "진단이 틀렸습니다."]);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "DG-3 반영\n");
      return result("FIX", "DG-3 반영", { status: "completed", findings: [resolved("DG-3")] });
    });
    const codexBefore = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "g3-legacy-closed-checkpoint")).toBe("READY_TO_DELIVER");
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence);
    // 이관 계약은 옛 엔진의 진행 중 작업 id(diagnosis#DG-3)다 — 중재자가 닫은 DG-1 작업의 id 가 아니다.
    expect(after.map((event) => event.payload?.fixContractMigrated).filter(Boolean)).toEqual(["diagnosis#DG-3"]);
    // DG-3 수정은 닫힌 작업의 누적본(DG-1 반박)에서 이어가지 않고 바탕 없이 시작한다.
    expect(after.filter((event) => event.payload?.checkpointResumed !== undefined).map((event) => event.body)).toEqual([]);
    expect(r.claude.turns).toHaveLength(4);
    expect(r.claude.turns[3].protocolOnly).toBe(false);
    expect(fixPrompt).toContain("[DG-3]");
    // 최종 리뷰의 대조 보고는 DG-3 수정 보고뿐이다 — 반박 누적본의 요약·처분이 섞이지 않는다.
    const finals = r.codex.prompts.slice(codexBefore);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toContain("반환 kind는 FINAL_REVIEW");
    const report = reviewReportIn(finals[0]);
    expect(report.summary).toBe("DG-3 반영");
    expect(report.summary).not.toContain("진단이 틀렸습니다");
    expect(report.findings.map((finding) => [finding.id, finding.disposition])).toEqual([["DG-3", "RESOLVED_BY_FIX"]]);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.route, contract.diagnosisIds, contract.status]))
      .toEqual([["diagnosis#DG-3", "diagnosis", ["DG-3"], "accepted"]]);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["superseded", "closed_no_action", "resolved"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-3 반영 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // 감사 5차 #4 대조군: 옛 엔진이 남길 수 있는 상태 — 러너가 반박해 멈춘 진단 전용 수정(DG-1, paused checkpoint diagnosis#DG-1)에 계획 변경 진단 DG-2(supersedes
  // DG-1)를 적용했고, 개정 턴이 DG-2 를 반박해 계획 개정 단계에서 멈춘 뒤 중재자가 수정 불필요 정정(DG-3, supersedes DG-2)으로 저장 전 개정을 취소해 재개 단계가
  // CLAUDE_FIX 로 돌아왔다(restoreResume). 개정 턴은 work-checkpoint 를 쓰지 않으므로 최신 checkpoint 는 DG-1 의 반박 paused 기록이다. checkpoint 의 진단은 모두
  // 중재자가 닫았지만 대기 진단은 없다.
  it("계약 도입 전 토픽의 멈춘 진단 전용 수정 checkpoint(diagnosis#DG-1)의 진단이 모두 중재자 정정으로 닫혔어도 대기 진단이 없으면 이관은 그 checkpoint 의 작업 id 를 그대로 잇는다 — 실린 진단이 모두 닫힌 계약(diagnosis#DG-1)은 러너 턴 없이 닫혀 지금 작업 트리의 최종 리뷰를 거쳐 인도 대기·커밋에 이른다(2026-09-15 감사 5차 #4)", { timeout: 30_000 }, async () => {
    const r = await refutedDiagnosisFixStop("g3-legacy-closed-no-pending");
    const refutedCheckpoint = r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision;
    r.claude["steps"].push(() => result("REVISION", "계획 변경은 필요 없습니다.", {
      planEdits: [],
      findings: [{ id: "DG-2", title: "중재자 진단", severity: "HIGH", disposition: "REFUTED", rationale: "계획이 이미 허용합니다.", evidenceRefs: ["plan:R-3"], requiresUserDecision: false }],
    }));
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await register(planDiagnosis({ supersedes: "DG-1" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect((await register(fixDiagnosis({ kind: "no_action", title: "계획 변경 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "superseded"], ["DG-3", "closed_no_action"]]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.database.latestArtifact(r.topicId, "work-checkpoint")!.revision).toBe(refutedCheckpoint);
    await legacyTopic(r);
    const legacy = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; work: { kind: string; fixSource?: string }; openRequests: unknown[] };
    expect([legacy.work.kind, legacy.phase, legacy.work.fixSource, legacy.openRequests]).toEqual(["FIX", "paused", "diagnosis#DG-1", []]);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    const codexBefore = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "g3-legacy-closed-no-pending")).toBe("READY_TO_DELIVER");
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence);
    expect(after.map((event) => event.payload?.fixContractMigrated).filter(Boolean)).toEqual(["diagnosis#DG-1"]);
    expect(after.filter((event) => event.payload?.fixContractClosed === true).map((event) => event.payload?.fixContract)).toEqual(["diagnosis#DG-1"]);
    expect(r.claude.turns).toHaveLength(3);
    const finals = r.codex.prompts.slice(codexBefore);
    expect(finals).toHaveLength(1);
    expect(finals[0]).toContain("반환 kind는 FINAL_REVIEW");
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.route, contract.diagnosisIds, contract.status]))
      .toEqual([["diagnosis#DG-1", "diagnosis", ["DG-1"], "closed"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "정정으로 닫힌 진단 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // ---- 2026-09-15 감사 5차 #7 (g4) ----
  // 공백이 든 finding id — FindingSchema.id 는 z.string().min(1) 이라 `GATE 2` 도 스키마상 유효하다. 첫 리뷰가 이 id 의 확정 결함(수정 합의)과 사용자 판정 쟁점
  // F-3 을 함께 내 리뷰 정지(USER_DECISION_REQUIRED, 재개 CODEX_REVIEW)를 만드는 Codex — DottedIdReviewCodex 에서 id 형식만 바꿨다. 그 뒤는 EchoCodex 그대로다.
  const SPACED_GATE_FINDING: Finding = {
    id: "GATE 2", title: "게이트 2 결함", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "고쳐야 합니다.", evidenceRefs: [], requiresUserDecision: false,
  };
  class SpacedIdReviewCodex extends EchoCodex {
    private reviews = 0;
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "REVIEW") return review;
      this.reviews += 1;
      return this.reviews === 1 ? { ...review, findings: [...review.findings, SPACED_GATE_FINDING, CHANNEL_F3] } : review;
    }
  }

  it("공백이 든 finding id(GATE 2)는 따옴표로 감싼 줄 머리 'OVERRULE \"GATE 2\"' 결정으로 면제된다 — 수락 가드의 처분 되돌림 정지가 감싸는 문법을 안내하고, 그 안내대로 결정을 올려 retry 하면 같은 정지로 돌아가지 않고 러너의 GATE 2 하향이 최종 리뷰 되돌림 검사까지 통과해 인도 대기·커밋에 이른다(2026-09-15 감사 5차 #7)", { timeout: 60_000 }, async () => {
    const r = await room("overrule-quoted-id", [], { codexInstance: new SpacedIdReviewCodex() });
    const downgrade = () => result("FIX", "GATE 2 는 고치지 않겠습니다.", {
      status: "completed", findings: [
        { ...SPACED_GATE_FINDING, disposition: "AGREED_NO_ACTION", rationale: "GATE 2 는 영향이 없어 이번 범위에서 고치지 않습니다." },
        { ...CHANNEL_F3, requiresUserDecision: false, rationale: "사용자 결정대로 채널 A." },
      ],
    });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      downgrade,
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_REVIEW");
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-3 은 채널 A 로 하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    // 1) 러너의 GATE 2 하향을 수락 가드가 멈춘다.
    expect(await settledState(r, "overrule-quoted-id")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const stop = r.database.getTopic(r.topicId).lastError ?? "";
    expect(stop).toContain("처분을 되돌렸습니다(GATE 2)");
    // 2) 감싼 id 로 지시하고 retry — 러너는 결정대로 GATE 2 를 다시 수정 불필요로 낸다.
    r.claude["steps"].push(downgrade);
    const decision = "OVERRULE \"GATE 2\"\nGATE 2 는 영향이 없으니 이번 범위에서 고치지 않습니다.";
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: decision })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "overrule-quoted-id-retry")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("구현 리뷰 한도");
    const after = await g6aSettleWithGrants(r, "overrule-quoted-id-retry");
    expect(after, r.database.getTopic(r.topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    const timeline = r.database.getTimeline(r.topicId);
    expect(timeline.filter((event) => event.body.includes("처분을 되돌렸습니다"))).toHaveLength(1);
    const allowed = timeline.filter((event) => event.body.includes("사용자 결정이 처분 변경을 허용한 쟁점: GATE 2(AGREED_ACTION → AGREED_NO_ACTION)"));
    expect(allowed.length).toBeGreaterThanOrEqual(1);
    expect(allowed.every((event) => (event.payload.overruledFindingIDs as string[]).includes("GATE 2"))).toBe(true);
    expect(r.codex.prompts.filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"))).toHaveLength(1);
    const finalReview = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(finalReview.findings.find((finding) => finding.id === "GATE 2")?.disposition).toBe("AGREED_NO_ACTION");
    // 3) 멈춤 안내는 공백·쉼표가 든 id 를 감싸는 문법까지 알린다(흐름 확인 뒤에 본다 — 옛 엔진에서는 위 파서 결함이 먼저 드러난다).
    expect(stop).toContain("OVERRULE <id>");
    expect(stop).toContain("따옴표나 백틱으로 감싼다");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "GATE 2 는 사용자 지시로 미수정", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // ---- 2026-09-15 감사 6차 #1·#11 (g6a) ----
  // 감사 6차 #1: 1주기 최종 리뷰가 새 쟁점 F-3(캐시 무효화)을 내 사용자가 판정하고, 계획 개정 뒤 2주기 최종 리뷰가 같은 id F-3 으로 다른 결함(권한 검사 누락)을
  // 내는 Codex. 계획 개정은 planSHA 를 바꿔 Codex 리뷰 세션을 새로 열므로 새 세션이 id 를 다시 매기는 일은 흔하다 — 엔진은 id 를 세션별로 나누지 않는다.
  // second "stop": 2주기 최종 리뷰가 F-3·F-9(같은 모양의 대조군)를 수정 합의 + 사용자 판정 필요로 내 멈춘다.
  // second "new": 2주기 최종 리뷰가 F-3 을 새 RESOLVED_BY_FIX 쟁점(수정 기회가 없던 쟁점)으로만 낸다. 그 밖의 턴은 PlanningCodex 그대로다.
  const G6A_CYCLE1_F3: Finding = {
    id: "F-3", title: "캐시 무효화 누락(1주기)", severity: "HIGH", disposition: "RESOLVED_BY_FIX", rationale: "1주기 최종 리뷰의 새 쟁점 — 이미 고쳐졌다고 봅니다.",
    evidenceRefs: [], requiresUserDecision: false,
  };
  const G6A_CYCLE2_F3: Finding = {
    id: "F-3", title: "권한 검사 누락(2주기 — 다른 결함)", severity: "HIGH", disposition: "AGREED_ACTION",
    rationale: "2주기 정지 — 권한 검사 누락은 수정 여부에 사용자 판정이 필요합니다.", evidenceRefs: [], requiresUserDecision: true,
  };
  const G6A_CYCLE2_F9: Finding = { ...G6A_CYCLE2_F3, id: "F-9", title: "대조군(같은 모양·다른 id)", rationale: "대조군 — 사용자 판정이 필요합니다." };
  const G6A_F3_KEPT = "F-3 권한 검사 누락은 여전히 사용자 판정이 필요합니다.";
  class G6aIdReuseCodex extends PlanningCodex {
    private finals = 0;
    constructor(private readonly second: "stop" | "new") { super(); }
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "FINAL_REVIEW") return review;
      this.finals += 1;
      if (this.finals === 1) return { ...review, findings: [...review.findings, G6A_CYCLE1_F3] };
      if (this.finals !== 2) return review;
      const raised: Finding[] = this.second === "stop" ? [G6A_CYCLE2_F3, G6A_CYCLE2_F9]
        : [{ ...G6A_CYCLE2_F3, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "2주기 새 쟁점 — 권한 검사 누락(수정 기회 없음)." }];
      return { ...review, findings: [...review.findings, ...raised] };
    }
  }



  // 감사 6차 #1 공통 전제: 구현 → 인도 대기 → DG-1 진단 전용 수정 → 최종 리뷰 #1 이 새 쟁점 F-3(캐시 무효화)을 내 finalReviewNewFindingIDs 인터럽트로 멈춤 →
  // 사용자 결정 → retry(저장 리뷰로 인도 대기) → 계획 변경 진단 DG-2 → 개정 계획 승인 → 개정 구현(새 작업 주기) → 첫 리뷰 통과 → 인도 대기 → DG-3 진단 전용
  // 수정 → 2주기 최종 리뷰 #2(second 에 따라 정지 또는 새 쟁점). 1주기의 인터럽트와 결정은 모두 2주기 시작(개정 구현 결과) 전이다.
  async function g6aCycle2FinalReview(label: string, second: "stop" | "new") {
    const r = await room(label, [], { codexInstance: new G6aIdReuseCodex(second) });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: "진단 DG-2: 감사 단계를 추가한다.\n" }] },
          findings: [{ id: "DG-2", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 반영", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
      () => { writeFileSync(join(r.worktree, "feature.txt"), "개정 계획 구현\n"); return result("IMPLEMENTATION", "개정 계획대로 구현했습니다.", { status: "completed", findings: [resolved("DG-2")] }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-3 반영\n"); return result("FIX", "DG-3 반영", { status: "completed", findings: [resolved("DG-3")] }); },
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    const newFindingAsks = () => r.database.getTimeline(r.topicId).filter((event) => Array.isArray(event.payload?.finalReviewNewFindingIDs));
    // 1주기: 최종 리뷰 #1 의 새 쟁점 F-3(캐시 무효화)을 사용자가 판정한다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(newFindingAsks().map((event) => event.payload?.finalReviewNewFindingIDs)).toEqual([["F-3"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-3(캐시 무효화)는 확인했습니다 — 그대로 둡니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 계획 개정 → 개정 구현(새 작업 주기) → 첫 리뷰 통과 → 인도 대기.
    expect((await register(planDiagnosis())).status).toBe(201);
    expect((await apply("DG-2")).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    const revisedSHA = r.database.getTopic(r.topicId).planSHA256;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: revisedSHA })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const cycleStart = r.database.latestArtifact(r.topicId, "implementation-result")!.revision;
    expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "implementation-result"))!) as AgentResult).summary).toBe("개정 계획대로 구현했습니다.");
    // 전제 확인: 1주기의 새 쟁점 인터럽트와 그 판정 결정은 모두 2주기 시작 전이다(사용자 decision 은 F-3 판정과 개정 계획 승인뿐이다).
    const decisions = r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision");
    expect(decisions.map((event) => event.body)).toEqual(["F-3(캐시 무효화)는 확인했습니다 — 그대로 둡니다.", "현재 계획 버전의 구현을 승인했습니다."]);
    expect(decisions.every((event) => event.sequence < cycleStart)).toBe(true);
    expect(newFindingAsks().every((event) => event.sequence < cycleStart)).toBe(true);
    // 2주기: DG-3 진단 전용 수정 → 최종 리뷰 #2.
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await apply("DG-3")).status).toBe(200);
    const settled = await g6aSettleWithGrants(r, `${label}-dg3`);
    return { r, register, apply, cycleStart, settled, newFindingAsks };
  }

  it("계획 개정 뒤 새 작업 주기의 최종 리뷰가 이전 주기에 사용자가 판정한 쟁점과 같은 id(F-3)로 다른 결함을 내 멈추면 이전 주기의 판정은 그 쟁점을 면제하지 않는다 — 사용자 결정 없이 무관한 진단 DG-4 를 적용하면 새 진단 전용 계약의 원본은 [F-3, F-9] 이고 수정 턴이 F-3 을 싣고, 러너가 F-3 을 판정 필요로 남기면 인도 대기·커밋에 이르지 않는다(2026-09-15 감사 6차 #1)", { timeout: 120_000 }, async () => {
    const { r, register, apply, cycleStart, settled } = await g6aCycle2FinalReview("g6a-adjudicated-cycle-stop", "stop");
    // 전제: 2주기 최종 리뷰 #2 가 F-3(권한 검사 누락)·F-9 로 멈췄다(재개 = 최종 리뷰).
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const stop2 = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect(stop2).toBeGreaterThan(cycleStart);
    const stored = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(stored.findings.filter((finding) => finding.requiresUserDecision).map((finding) => [finding.id, finding.title])).toEqual([["F-3", G6A_CYCLE2_F3.title], ["F-9", G6A_CYCLE2_F9.title]]);
    const decisionsBefore = r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision").length;
    // 러너는 받은 수정 대상대로 답한다 — F-9 는 고치고, F-3 이 대상에 있으면 판정 필요로 남긴다.
    let dg4Prompt = "";
    r.claude["steps"].push((turn) => {
      dg4Prompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "DG-4·F-9 반영\n");
      const targets = fixTargetsIn(turn.prompt).map((finding) => finding.id);
      return result("FIX", "DG-4·F-9 반영", {
        status: "completed", findings: [resolved("DG-4"), { ...G6A_CYCLE2_F9, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "F-9 수정" },
          ...(targets.includes("F-3") ? [{ ...G6A_CYCLE2_F3, rationale: G6A_F3_KEPT }] : [])],
      });
    });
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await apply("DG-4")).status).toBe(200);
    const state = await g6aSettleWithGrants(r, "g6a-adjudicated-cycle-stop-dg4");
    // 1) 새 진단 전용 계약(출처 = 2주기 정지 #2)의 원본은 F-3 과 F-9 다 — 1주기 F-3(캐시 무효화) 판정이 2주기 F-3(권한 검사 누락)을 빼지 않는다.
    const topic = r.database.getTopic(r.topicId);
    const contract = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((row) => row.diagnosisIds.includes("DG-4"));
    expect([contract?.origin, contract?.source.map((finding) => finding.id)])
      .toEqual([{ stage: "CODEX_FINAL_REVIEW", review: { kind: "codex-final-review", revision: stop2 } }, ["F-3", "F-9"]]);
    expect(contract?.source.find((finding) => finding.id === "F-3")?.title).toBe(G6A_CYCLE2_F3.title);
    // 2) 수정 턴은 F-3 을 수정 대상으로 싣는다.
    expect(fixTargetsIn(dg4Prompt).map((finding) => finding.id)).toEqual(["DG-4", "F-3", "F-9"]);
    // 3) F-3 판정 없이 인도 대기·커밋에 이르지 않는다 — 러너가 남긴 판정 필요로 멈추고, 2주기 정지 뒤 사용자 결정은 없다.
    expect(state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain(G6A_F3_KEPT);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(decisionsBefore);
    const commit = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "2주기 F-3 판정 없이 인도", paths: ["feature.txt"] });
    expect(commit.status).not.toBe(200);
    expect(r.database.getFlags(r.topicId).committedOID).toBeFalsy();
    r.database.close();
  });

  it("계획 개정 뒤 새 작업 주기의 최종 리뷰가 이전 주기에 사용자가 판정한 쟁점과 같은 id(F-3)를 새 쟁점(RESOLVED_BY_FIX, 수정 기회 없음)으로 내면 이전 주기의 판정은 그 쟁점을 면제하지 않는다 — finalReviewNewFindingIDs=[F-3] 인터럽트로 사용자에게 보내 인도 대기·커밋에 이르지 않고, 이번 주기의 결정을 올려 재시도해야 인도 대기에 이른다(2026-09-15 감사 6차 #1)", { timeout: 120_000 }, async () => {
    const { r, cycleStart, settled, newFindingAsks } = await g6aCycle2FinalReview("g6a-adjudicated-cycle-new", "new");
    const stored = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect(stored.findings.find((finding) => finding.id === "F-3")?.title).toBe(G6A_CYCLE2_F3.title);
    // 1) 2주기의 새 쟁점 F-3 은 이번 주기의 신규 쟁점 인터럽트로 사용자에게 간다.
    expect(newFindingAsks().filter((event) => event.sequence > cycleStart).map((event) => event.payload?.finalReviewNewFindingIDs)).toEqual([["F-3"]]);
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "2주기 F-3 판정 없이 인도", paths: ["feature.txt"] });
    expect(blocked.status).not.toBe(200);
    // 2) 이번 주기의 결정은 이번 주기의 새 쟁점을 판정한다 — 결정 뒤 retry 는 저장 리뷰로 인도 대기에 이르고 커밋이 열린다.
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-3(권한 검사 누락)도 확인했습니다 — 그대로 둡니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(codexBefore);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "2주기 F-3 판정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  // 감사 6차 #11 공통 전제: 구현 → 인도 대기 → DG-1 진단 전용 수정 수락(FC-1) → 최종 리뷰 #1 이 F-2(수정 합의 + 사용자 판정 필요)로 멈춤(재개 CODEX_FINAL_REVIEW)
  // → DG-2·DG-3 등록 → DG-2 적용(다른 진단 대기 — 순차 적용, actionId null; FC-2 출처 = 정지 리뷰, 원본 [F-2]) → DG-3 적용(FC-2 에 덧붙어 재개) → 러너가 DG-2·DG-3
  // 을 반박 → USER_DECISION_REQUIRED(재개 CLAUDE_FIX). FC-2[DG-2, DG-3] 은 열린 채다.
  async function g6aRefutedPairStop(label: string) {
    const r = await room(label, [], { codex: "final-review-decision" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
      () => result("FIX", "DG-2·DG-3 는 틀렸습니다.", {
        status: "completed", findings: [
          { ...resolved("DG-2"), disposition: "REFUTED", rationale: "원인이 다릅니다(2)." },
          { ...resolved("DG-3"), disposition: "REFUTED", rationale: "원인이 다릅니다(3)." },
          { ...FINAL_REVIEW_DECISION_FINDING, requiresUserDecision: false, rationale: "F-2 는 아직 고치지 않았습니다." },
        ],
      }),
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const stop = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    const waiting = await apply("DG-2");
    expect(waiting.status).toBe(200);
    expect(waiting.body.actionId).toBeNull();
    expect((await apply("DG-3")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "fix_reported"], ["DG-2", "refuted"], ["DG-3", "refuted"]]);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.status, contract.diagnosisIds, contract.origin, contract.source.map((finding) => finding.id)]))
      .toEqual([["FC-1", "accepted", ["DG-1"], { stage: "READY_TO_DELIVER", review: null }, []],
        ["FC-2", "open", ["DG-2", "DG-3"], { stage: "CODEX_FINAL_REVIEW", review: { kind: "codex-final-review", revision: stop } }, ["F-2"]]]);
    return { r, register, apply };
  }
  const g6aContracts = (r: Awaited<ReturnType<typeof room>>) => {
    const topic = r.database.getTopic(r.topicId);
    return r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.status, contract.diagnosisIds, contract.source.map((finding) => finding.id)]);
  };

  it("진단 전용 계약 FC-2[DG-2, DG-3](원본 F-2)에서 DG-3 을 대체하는 수정 정정(DG-4)이 등록만 된 채 남아 있으면 DG-2 를 대체하는 수정 불필요 정정(DG-5)은 FC-2 를 닫지 않는다 — 재개 단계는 CLAUDE_FIX 로 남고, DG-4 를 적용하면 FC-2 에 덧붙어 수정 턴이 DG-4 와 정지 원본 F-2 를 함께 싣는다(정정 등록 순서와 무관하게 같은 작업, 2026-09-15 감사 6차 #11)", { timeout: 60_000 }, async () => {
    const { r, register, apply } = await g6aRefutedPairStop("g6a-pending-correction");
    expect((await register(fixDiagnosis({ title: "DG-3 정정", supersedes: "DG-3" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-2 수정 불필요", supersedes: "DG-2" }))).status).toBe(201);
    // 1) DG-4 가 적용 대기 중이라 FC-2 는 열린 채고 재개 단계는 CLAUDE_FIX 다(수정 불필요 종결 기록 없음).
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(g6aContracts(r)).toEqual([["FC-1", "accepted", ["DG-1"], []], ["FC-2", "open", ["DG-2", "DG-3"], ["F-2"]]]);
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("수정 불필요로 닫았습니다"))).toBe(false);
    expect((await r.diagnoses()).map((record) => [record.id, record.status]))
      .toEqual([["DG-1", "fix_reported"], ["DG-2", "superseded"], ["DG-3", "superseded"], ["DG-4", "registered"], ["DG-5", "closed_no_action"]]);
    // 2) DG-4 적용은 FC-2 에 덧붙는다 — 수정 턴이 DG-4 와 F-2 를 싣고, 새 계약(인도 대기 출처, 원본 없음)을 열지 않는다.
    let fixPrompt = "";
    r.claude["steps"].push((turn) => {
      fixPrompt = turn.prompt;
      writeFileSync(join(r.worktree, "feature.txt"), "DG-4·F-2 반영\n");
      return result("FIX", "DG-4·F-2 반영", {
        status: "completed",
        findings: [resolved("DG-4"), { ...FINAL_REVIEW_DECISION_FINDING, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "F-2 로그 경로를 고쳤습니다." }],
      });
    });
    expect((await apply("DG-4")).status).toBe(200);
    const settled = await settledState(r, "g6a-pending-correction-dg4");
    expect(fixTargetsIn(fixPrompt).map((finding) => finding.id)).toEqual(["DG-4", "F-2"]);
    expect(g6aContracts(r)).toEqual([["FC-1", "accepted", ["DG-1"], []], ["FC-2", "accepted", ["DG-2", "DG-3", "DG-4"], ["F-2"]]]);
    expect(settled).toBe("USER_DECISION_REQUIRED");
    const beforeAnswer = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-2 로그 경로 수정을 확인했습니다. 진행하세요." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g6a-pending-correction 추가 승인")).toBe("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(beforeAnswer);
    r.database.close();
  });

  it("대조군: 같은 전제에서 등록만 된 수정 정정 DG-4(DG-3 대체) 자신을 수정 불필요 정정 DG-6 으로 대체하면 — 사슬의 마지막 고리를 닫는 정정 — 계약의 다른 진단도 모두 닫혔으므로 FC-2 는 닫히고 재개 단계는 최종 리뷰(CODEX_FINAL_REVIEW)가 된다(2026-09-15 감사 6차 #11)", { timeout: 60_000 }, async () => {
    const { r, register } = await g6aRefutedPairStop("g6a-pending-correction-closed");
    expect((await register(fixDiagnosis({ title: "DG-3 정정", supersedes: "DG-3" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-2 수정 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-3 정정도 불필요", supersedes: "DG-4" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).state).toBe("USER_DECISION_REQUIRED");
    expect(g6aContracts(r)).toEqual([["FC-1", "accepted", ["DG-1"], []], ["FC-2", "closed", ["DG-2", "DG-3"], ["F-2"]]]);
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("수정 불필요로 닫았습니다"))).toBe(true);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "fix_reported"], ["DG-2", "superseded"], ["DG-3", "superseded"],
      ["DG-4", "superseded"], ["DG-5", "closed_no_action"], ["DG-6", "closed_no_action"]]);
    r.database.close();
  });

  // ---- 2026-09-15 감사 6차 #2·#4·#7 (g6b) ----
  // 감사 6차 #4: 최신 work-checkpoint 의 원장 행은 두고 본문 blob 파일만 지운다(외부 유실 — 수동 삭제·부분 복사·DB 만 복원). blob 은 sha 이름이라 같은 내용의
  // 다른 산출물 행이 같은 파일을 가리킬 수 있으므로, 지우기 전에 이 파일을 가리키는 원장 행이 이 checkpoint 하나뿐인지 확인한다.
  function g6bUnlinkLatestCheckpointBlob(r: Awaited<ReturnType<typeof room>>): number {
    const latest = r.database.latestArtifact(r.topicId, "work-checkpoint");
    expect(latest).toBeTruthy();
    const raw = Object.values(r.database as unknown as Record<string, unknown>)
      .find((v) => v && typeof (v as { exec?: unknown }).exec === "function" && typeof (v as { prepare?: unknown }).prepare === "function") as
      { prepare(sql: string): { get(...values: unknown[]): unknown } };
    expect(raw.prepare("SELECT COUNT(*) AS n FROM artifacts WHERE path = ?").get(latest!.path)).toEqual({ n: 1 });
    rmSync(latest!.path);
    return latest!.revision;
  }

  // 감사 6차 #7 공통 전제: 구현 → 인도 대기 → 계획 변경 진단 DG-1 적용 → 개정 턴·감사 답변·ACK → 승인 대기 → 개정 계획 승인. 개정 턴은 work-checkpoint 를
  // 쓰지 않으므로 최신 checkpoint 는 구현 작업의 수락 기록이고, DG-1 은 개정 저장(plan_revised) 상태로 첫 구현 턴의 전달을 기다린다.
  async function g6bApprovedPlanRevision(label: string) {
    const r = await room(label, [], { codex: "planning" });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      (turn) => {
        const base = /기준 SHA-256: ([0-9a-f]{64})/.exec(turn.prompt)?.[1];
        return result("REVISION", "진단을 계획에 반영했습니다.", {
          planLineEdits: { baseSHA256: base!, edits: [{ startLine: 2, endLineExclusive: 2, replacement: "진단 DG-1: witness 감사 단계를 추가한다.\n" }] },
          findings: [{ id: "DG-1", title: "중재자 진단", severity: "HIGH", disposition: "AGREED_ACTION", rationale: "개정 계획에 감사 단계를 추가했습니다.", evidenceRefs: [], requiresUserDecision: false }],
        });
      },
      () => result("REVISION", "감사에 답했습니다.", { planEdits: [] }),
      ackWith,
    );
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, planDiagnosis(), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("AWAITING_USER_APPROVAL");
    expect((await r.diagnoses()).map((record) => record.history.map((entry) => entry.status))).toEqual([["registered", "applied", "plan_revised"]]);
    const latest = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; work: { kind: string } };
    expect([latest.work.kind, latest.phase]).toEqual(["IMPLEMENTATION", "accepted"]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/approve`, { planSHA256: r.database.getTopic(r.topicId).planSHA256 })).status).toBe(200);
    expect(r.claude.turns).toHaveLength(4);
    return r;
  }

  // 감사 6차 #7: 개정 계획 승인 뒤 구현 시작(implement)이 최신 checkpoint 손상에서 멈췄는지 — 러너·리뷰 턴 없이 USER_DECISION_REQUIRED(재개 IMPLEMENTING,
  // checkpointCorrupt)이고, 개정 첫 전달이 일어나지 않아 DG-1 은 개정 저장(plan_revised)에 머물며 승계 기록에서 시작한다는 기록·도구 트리 기록도 없다.
  async function g6bImplementStopsOnCorrupt(r: Awaited<ReturnType<typeof room>>, label: string, corruptRevision: number) {
    const codexBefore = r.codex.prompts.length;
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    const state = await settledState(r, label);
    expect(state, r.database.getTopic(r.topicId).lastError ?? "").toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(r.database.getTopic(r.topicId).lastError).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    const after = r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence);
    expect(after.filter((event) => event.payload?.checkpointCorrupt !== undefined).map((event) => [event.payload?.checkpointCorrupt, event.payload?.resumeState]))
      .toEqual([[corruptRevision, "IMPLEMENTING"]]);
    expect(after.filter((event) => event.payload?.planRevisionCarry !== undefined || event.payload?.toolTreeDrift !== undefined).map((event) => event.body)).toEqual([]);
    expect(r.claude.turns).toHaveLength(4);
    expect(r.codex.prompts).toHaveLength(codexBefore);
    expect((await r.diagnoses()).map((record) => record.history.map((entry) => entry.status))).toEqual([["registered", "applied", "plan_revised"]]);
  }

  it("인도 대기(커밋 가능)에서 최신 checkpoint 가 손상돼 있으면 수정 진단(계획 변경 없음)의 적용은 409('최신 수정 checkpoint 가 손상돼 적용하지 않습니다')로 거부되고 아무것도 기록하지 않는다 — 인도 대기·완료 판정(reviewedHead)·재개 단계가 그대로이고 계약이 열리지 않으며 진단은 등록 상태로 남아, 그 진단을 수정 불필요 정정으로 닫으면 커밋할 수 있다(2026-09-15 감사 6차 #2)", { timeout: 30_000 }, async () => {
    const r = await room("g6b-corrupt-apply-fix", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const corruptRevision = await corruptLatestCheckpoint(r);
    // 요청과 무관한 등록은 손상 checkpoint 가 있어도 받는다(감사 5차 #3).
    expect((await register(fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }))).status).toBe(201);
    const topic = r.database.getTopic(r.topicId);
    const before = r.database.getFlags(r.topicId);
    expect(before.reviewedHead).toBeTruthy();
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(409);
    expect(String(applied.body.error)).toContain("최신 수정 checkpoint 가 손상돼 적용하지 않습니다");
    expect(String(applied.body.error)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    // 기록하지 않았다 — 진단은 등록 상태, 인도 대기·완료 판정·재개 단계 그대로, 계약 없음, 기록·실행·러너 턴 없음.
    expect((await r.diagnoses()).map((record) => [record.id, record.history.map((entry) => entry.status)])).toEqual([["DG-1", ["registered"]]]);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    const after = r.database.getFlags(r.topicId);
    expect([after.resumeState, after.reviewedHead, after.reviewedDiffSHA256]).toEqual([before.resumeState, before.reviewedHead, before.reviewedDiffSHA256]);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    expect(r.database.runningAction(r.topicId)).toBeNull();
    expect(r.claude.turns).toHaveLength(1);
    // 적용 전의 커밋 가능한 인도 대기가 보존됐다 — 그 진단을 수정 불필요로 닫으면 커밋이 열린다.
    expect((await register(fixDiagnosis({ kind: "no_action", title: "손상 checkpoint 복구 전에는 적용하지 않음 — 수정 불필요", supersedes: "DG-1" }))).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "손상 checkpoint 인 채 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("통과한 최종 리뷰가 확인하지 않은 반영 보고(fix_reported) 진단 DG-1 을 기록의 안내대로 수정 정정(fix, supersedes DG-1)으로 다시 고치려 해도 최신 checkpoint 가 손상돼 있으면 그 정정의 적용은 409('최신 수정 checkpoint 가 손상돼 적용하지 않습니다')로 거부된다 — 인도 대기·완료 판정·기존 계약(FC-1 수락)이 그대로이고 새 진단 전용 계약이 열리지 않아, 정정을 수정 불필요로 닫으면 커밋할 수 있다(2026-09-15 감사 6차 #2)", { timeout: 60_000 }, async () => {
    const r = await room("g6b-corrupt-apply-correction", [], { codexInstance: new DeferredDiagnosisFinalCodex() });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 전제: 통과한 최종 리뷰가 DG-1 을 범위 밖으로 판정해 DG-1 은 반영 보고로 열려 있고 커밋이 막힌다.
    expect((await r.diagnoses()).map((record) => record.history.map((entry) => entry.status))).toEqual([["registered", "applied", "delivered", "fix_reported"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 미확인 인도", paths: ["feature.txt"] })).status).toBe(409);
    const corruptRevision = await corruptLatestCheckpoint(r);
    expect((await register(fixDiagnosis({ title: "DG-1 재검증", supersedes: "DG-1" }))).status).toBe(201);
    const topic = r.database.getTopic(r.topicId);
    const contracts = () => r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.diagnosisIds, contract.status]);
    expect(contracts()).toEqual([["FC-1", ["DG-1"], "accepted"]]);
    const before = r.database.getFlags(r.topicId);
    expect(before.reviewedHead).toBeTruthy();
    const codexBefore = r.codex.prompts.length;
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const applied = await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-2/apply`, undefined, { mediator: true });
    expect(applied.status, JSON.stringify(applied.body)).toBe(409);
    expect(String(applied.body.error)).toContain("최신 수정 checkpoint 가 손상돼 적용하지 않습니다");
    expect(String(applied.body.error)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    // 기록하지 않았다 — 정정은 등록 상태, 인도 대기·완료 판정 그대로, 새 계약·기록·실행·러너 턴 없음.
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "registered"]]);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    const after = r.database.getFlags(r.topicId);
    expect([after.resumeState, after.reviewedHead, after.reviewedDiffSHA256]).toEqual([before.resumeState, before.reviewedHead, before.reviewedDiffSHA256]);
    expect(contracts()).toEqual([["FC-1", ["DG-1"], "accepted"]]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    expect(r.database.runningAction(r.topicId)).toBeNull();
    expect(r.claude.turns).toHaveLength(2);
    expect(r.codex.prompts).toHaveLength(codexBefore);
    // 정정을 수정 불필요로 닫으면 사슬이 모두 닫혀 커밋이 열린다.
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-1 검증 기준은 인도 뒤 게이트에서 확인 — 수정 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "superseded"], ["DG-3", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("인도 대기에서 최신 checkpoint 가 손상돼 있으면 계획 변경 진단의 적용과 조사 기록의 적용도 409 로 거부되고 아무것도 기록하지 않는다 — 인도 대기·완료 판정·재개 단계·진단 상태가 그대로이고 승계 기록·계약·러너 턴이 없어, 두 진단을 수정 불필요 정정으로 닫으면 커밋할 수 있다(2026-09-15 감사 6차 #2)", { timeout: 30_000 }, async () => {
    const r = await room("g6b-corrupt-apply-other-kinds", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    const eventsSince = (sequence: number) => r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    const corruptRevision = await corruptLatestCheckpoint(r);
    const topic = r.database.getTopic(r.topicId);
    const before = r.database.getFlags(r.topicId);
    expect(before.reviewedHead).toBeTruthy();
    // 계획 변경 진단: 다른 대기 진단 없이 적용해 손상 판정에 이르게 한다.
    expect((await register(planDiagnosis())).status).toBe(201);
    let sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const planApplied = await apply("DG-1");
    expect(planApplied.status, JSON.stringify(planApplied.body)).toBe(409);
    expect(String(planApplied.body.error)).toContain("최신 수정 checkpoint 가 손상돼");
    expect(String(planApplied.body.error)).toContain(`누적 checkpoint #${corruptRevision} 을 읽을 수 없습니다(JSON 아님)`);
    expect(eventsSince(sequence)).toEqual([]);
    expect(r.database.latestArtifact(r.topicId, "diagnosis-carry-DG-1")).toBeFalsy();
    // 조사 기록: 적용 대상이 아니다 — 손상과 무관하게 거부된다.
    expect((await register(fixDiagnosis({ kind: "investigation", title: "원인 조사 — 재현 조건 미확정" }))).status).toBe(201);
    sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const investigationApplied = await apply("DG-2");
    expect(investigationApplied.status, JSON.stringify(investigationApplied.body)).toBe(409);
    expect(String(investigationApplied.body.error)).toContain("조사 기록은 구현 재개를 허용하지 않습니다");
    expect(eventsSince(sequence)).toEqual([]);
    expect((await r.diagnoses()).map((record) => [record.id, record.history.map((entry) => entry.status)])).toEqual([["DG-1", ["registered"]], ["DG-2", ["registered"]]]);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    const after = r.database.getFlags(r.topicId);
    expect([after.resumeState, after.reviewedHead, after.reviewedDiffSHA256]).toEqual([before.resumeState, before.reviewedHead, before.reviewedDiffSHA256]);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    expect(r.database.runningAction(r.topicId)).toBeNull();
    expect(r.claude.turns).toHaveLength(1);
    for (const id of ["DG-1", "DG-2"]) {
      expect((await register(fixDiagnosis({ kind: "no_action", title: `${id} 는 손상 checkpoint 복구 전에는 적용하지 않음 — 수정 불필요`, supersedes: id }))).status, id).toBe(201);
    }
    expect((await r.diagnoses()).map((record) => [record.id, record.status]))
      .toEqual([["DG-1", "superseded"], ["DG-2", "superseded"], ["DG-3", "closed_no_action"], ["DG-4", "closed_no_action"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "손상 checkpoint 인 채 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("인도 대기에서 최신 checkpoint 의 본문 파일이 사라져도(원장 행은 남고 blob 만 유실) 통과한 최종 리뷰가 확인하지 않은 반영 보고(fix_reported) 진단을 수정 불필요 정정(no_action, supersedes DG-1)으로 닫는 등록은 500 없이 받고(201) 커밋이 열린다 — 파일 없음은 손상으로 분류돼, 관련 요청을 지정한 등록은 손상 판정 409('… 본문 파일이 없음')로 거부된다(2026-09-15 감사 6차 #4)", { timeout: 60_000 }, async () => {
    const r = await room("g6b-missing-ready-no-action", [], { codexInstance: new DeferredDiagnosisFinalCodex() });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "인도 대기 중 외부 검증 실패" }))).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => record.history.map((entry) => entry.status))).toEqual([["registered", "applied", "delivered", "fix_reported"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 미확인 인도", paths: ["feature.txt"] })).status).toBe(409);
    const missingRevision = g6bUnlinkLatestCheckpointBlob(r);
    const closed = await register(fixDiagnosis({ kind: "no_action", title: "DG-1 검증 기준은 인도 뒤 게이트에서 확인 — 수정 불필요", supersedes: "DG-1" }));
    expect(closed.status, JSON.stringify(closed.body)).toBe(201);
    expect(r.database.getTopic(r.topicId).state).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "superseded"], ["DG-2", "closed_no_action"]]);
    // 파일 없음을 삼키지 않고 손상으로 분류했다 — 그 checkpoint 에 기대는 판단(관련 요청)은 손상 판정으로 거부된다.
    const related = await register(fixDiagnosis({ title: "요청 관련 진단", relatedRequestIds: ["Q-0000abcd"] }));
    expect(related.status, JSON.stringify(related.body)).toBe(409);
    expect(String(related.body.error)).toContain("최신 수정 checkpoint 가 손상돼 열린 요청을 판정할 수 없습니다");
    expect(String(related.body.error)).toContain(`누적 checkpoint #${missingRevision} 을 읽을 수 없습니다(원장 행은 있는데 본문 파일이 없음)`);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "DG-1 정정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("열린 요청이 최신 checkpoint 에만 있는 진단 전용 수정 작업(FC-1)에서 그 checkpoint 의 본문 파일이 사라지면(원장 행은 남음) 수정 불필요 정정(no_action, supersedes DG-1)은 500 이 아니라 409('최신 수정 checkpoint 가 손상돼 … 본문 파일이 없음')로 거부된다 — FC-1 은 열린 채 재개 단계는 CLAUDE_FIX 로 남고, 결정 뒤 재시도는 일반 실패(FAILED)가 아니라 최종 리뷰·러너 턴 없이 손상 정지(USER_DECISION_REQUIRED, checkpointCorrupt)로 멈춘다(2026-09-15 감사 6차 #4)", { timeout: 30_000 }, async () => {
    const { r, noAction } = await openRequestDiagnosisFixStop("g6b-missing-close");
    const missingRevision = g6bUnlinkLatestCheckpointBlob(r);
    const missing = `누적 checkpoint #${missingRevision} 을 읽을 수 없습니다(원장 행은 있는데 본문 파일이 없음)`;
    const sequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const refused = await noAction();
    expect(refused.status, JSON.stringify(refused.body)).toBe(409);
    expect(String(refused.body.error)).toContain("최신 수정 checkpoint 가 손상돼");
    expect(String(refused.body.error)).toContain(missing);
    // 등록하지 않았다 — 진단·계약·상태·재개 단계가 그대로이고 기록도 없다.
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "delivered"]]);
    const topic = r.database.getTopic(r.topicId);
    const contracts = () => r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).map((contract) => [contract.contractId, contract.status]);
    expect(contracts()).toEqual([["FC-1", "open"]]);
    expect(topic.state).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > sequence).map((event) => event.body)).toEqual([]);
    // 결정을 올리고 재시도해도 파일 없음은 일반 실패가 아니라 손상 정지로 보고된다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "stray.txt 를 범위에 넣으세요." })).status).toBe(200);
    const codexBefore = r.codex.prompts.length;
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    const state = await settledState(r, "g6b-missing-close");
    expect(state, r.database.getTopic(r.topicId).lastError ?? "").toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect(r.database.getTopic(r.topicId).lastError).toContain(missing);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence && event.payload?.checkpointCorrupt !== undefined)
      .map((event) => event.payload?.checkpointCorrupt)).toEqual([missingRevision]);
    expect(r.claude.turns).toHaveLength(3);
    expect(r.codex.prompts).toHaveLength(codexBefore);
    expect(contracts()).toEqual([["FC-1", "open"]]);
    r.database.close();
  });

  it("계획 변경 진단의 개정 계획이 승인된 뒤 최신 checkpoint 가 손상돼 있으면 구현 시작은 손상에서 멈춘다 — 러너·리뷰 턴 없이 USER_DECISION_REQUIRED(재개 IMPLEMENTING, checkpointCorrupt)이고 진단은 개정 저장(plan_revised)에 머물며, 재시도해도 같은 손상 정지로 돌아온다(2026-09-15 감사 6차 #7)", { timeout: 60_000 }, async () => {
    const r = await g6bApprovedPlanRevision("g6b-corrupt-revised-implement");
    const corruptRevision = await corruptLatestCheckpoint(r);
    await g6bImplementStopsOnCorrupt(r, "g6b-corrupt-revised-implement", corruptRevision);
    const retrySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "g6b-corrupt-revised-implement-retry")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("IMPLEMENTING");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > retrySequence && event.payload?.checkpointCorrupt !== undefined)
      .map((event) => event.payload?.checkpointCorrupt)).toEqual([corruptRevision]);
    expect(r.claude.turns).toHaveLength(4);
    expect((await r.diagnoses()).map((record) => record.status)).toEqual(["plan_revised"]);
    r.database.close();
  });

  // ---- 2026-09-15 감사 6차 #3·#10 (g6c) ----
  // 최종 리뷰(revision) 뒤에 그 리뷰가 인도 대기로 넘어간 전이(CODEX_FINAL_REVIEW → READY_TO_DELIVER)가 있는지 — 통과 리뷰인지의 전제 확인.
  const g6cPassedToReady = (r: Awaited<ReturnType<typeof room>>, revision: number) => r.database.getTimeline(r.topicId, revision)
    .some((event) => event.payload?.from === "CODEX_FINAL_REVIEW" && event.payload?.to === "READY_TO_DELIVER");

  // 감사 6차 #10: 첫 리뷰가 확정 결함 F-1(REVIEW_FIX_FINDING)을 내 리뷰 수정 작업(첫 회차)을 열고, 첫 최종 리뷰는 F-1 반영 확인과 함께 참고 쟁점 F-8(INFO 수정
  // 합의 — 수정 회차 대상이 아니라 통과한다)을 담아 인도 대기에 이르게 하는 Codex. 뒤 최종 리뷰는 보고를 되돌려 주되, 첫 리뷰 합의 F-1 의 반영 확인이 보고에
  // 없으면 덧붙인다(리뷰어가 앞선 판정을 유지한다 — ReviewFixFinalStopCodex 와 같은 규칙).
  class G6cReviewFixThenPassingInfoCodex extends EchoCodex {
    private reviews = 0;
    private finals = 0;
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind === "REVIEW") {
        this.reviews += 1;
        return this.reviews === 1 ? { ...review, summary: "고쳐야 할 결함이 있습니다.", findings: [...review.findings, REVIEW_FIX_FINDING] } : review;
      }
      if (review.kind !== "FINAL_REVIEW") return review;
      this.finals += 1;
      if (this.finals === 1) return { ...review, findings: [...review.findings, PASSING_INFO_F8] };
      return review.findings.some((finding) => finding.id === "F-1") ? review
        : { ...review, findings: [...review.findings, { ...REVIEW_FIX_FINDING, disposition: "RESOLVED_BY_FIX", rationale: "F-1 수정을 확인했습니다." }] };
    }
  }

  // 감사 6차 #10 대조군: 첫 최종 리뷰는 참고 쟁점 F-8 을 담고 통과(인도 대기)시키고, 둘째 최종 리뷰는 F-2(수정 합의 + 사용자 판정 필요)로 멈추는(재개
  // CODEX_FINAL_REVIEW) Codex. 그 뒤 최종 리뷰는 EchoCodex 그대로다.
  class G6cPassThenStopFinalCodex extends EchoCodex {
    private finals = 0;
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "FINAL_REVIEW") return review;
      this.finals += 1;
      if (this.finals === 1) return { ...review, findings: [...review.findings, PASSING_INFO_F8] };
      return this.finals === 2 ? { ...review, findings: [...review.findings, FINAL_REVIEW_DECISION_FINDING] } : review;
    }
  }

  // 옛 엔진(b08210b)이 남기는 상태: 인도 대기 → DG-1 진단 전용 수정 수락 → 최종 리뷰 #P 가 참고 쟁점 F-8 을 담고 통과(인도 대기) → DG-2 적용을 러너가 반박 →
  // 수정 불필요 정정(DG-3, supersedes DG-2)이 계약 행 없이 재개 단계만 최종 리뷰로 바꿨다(옛 closesDiagnosisFix). 새 엔진으로 같은 흐름을 만든 뒤 legacyTopic 으로
  // 계약 행을 지우고 최신 checkpoint(DG-2 반박 paused)의 작업 id 를 옛 형식 diagnosis#DG-2 로 되돌린다 — 옛 엔진은 수정 checkpoint 를 턴 응답 뒤에만 적었고
  // 이 흐름의 마지막 수정 턴은 DG-2 반박 응답이다. 계약 행이 없어 cycle 은 정산 시점을 모르고 옛 수락(DG-1)만 보고 시점으로 센다.
  it("계약 도입 전(옛 엔진) 토픽에서 인도 대기에 이른 통과 최종 리뷰(참고 쟁점 F-8) 뒤 연 진단 전용 수정을 옛 엔진이 수정 불필요 정정으로 닫았어도(계약 행 없음, 재개 = 최종 리뷰) 그 통과 리뷰는 정지가 아니다 — 다음 진단 DG-4 의 새 계약은 인도 대기 출처(review null)·원본 없음이고 F-8 을 러너 프롬프트·다음 최종 리뷰의 원본에 싣지 않으며 교정 턴 없이 인도 대기에 이른다(2026-09-15 감사 6차 #3)", { timeout: 60_000 }, async () => {
    const r = await room("g6c-legacy-passing-not-stop", [], { codexInstance: new PassingInfoFinalReviewCodex() });
    let dg4Prompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
      () => result("FIX", "DG-2 는 틀렸습니다.", { status: "completed", findings: [{ ...resolved("DG-2"), disposition: "REFUTED", rationale: "원인이 다릅니다." }] }),
      (turn) => {
        dg4Prompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-4 반영\n");
        return result("FIX", "DG-4 반영", { status: "completed", findings: [resolved("DG-4")] });
      },
      // 통과 리뷰의 F-8 을 원본으로 동결하면 이 계약 교정 턴이 열린다 — 경계가 맞으면 쓰이지 않는다.
      () => result("FIX", "DG-4 반영(교정)", { status: "completed", findings: [resolved("DG-4"), { ...PASSING_INFO_F8, disposition: "AGREED_NO_ACTION", rationale: "참고 사항" }] }),
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 전제: DG-1 수정의 수락 출력(agent_output FIX, acceptId) → CLAUDE_FIX → 최종 리뷰 전이 → 최종 리뷰 #P 가 F-8 을 담고 통과해 인도 대기로 넘어갔다.
    // 옛 엔진도 같은 기록을 남긴다(옛 수락 판정 legacyAcceptedFix 가 읽는 형식, 실제 b08210b 토픽: 수락 출력 #15 → 최종 리뷰 #18 → 인도 대기 전이 #19).
    const passing = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult).findings.map((finding) => [finding.id, finding.disposition]))
      .toEqual([["DG-1", "RESOLVED_BY_FIX"], ["F-8", "AGREED_ACTION"]]);
    const timeline = r.database.getTimeline(r.topicId);
    const acceptOutput = timeline.find((event) => event.kind === "agent_output" && event.actor === "claude" && event.payload?.resultKind === "FIX"
      && typeof event.payload?.acceptId === "number")!;
    expect(acceptOutput.sequence).toBeLessThan(passing);
    expect(timeline.some((event) => event.sequence > acceptOutput.sequence && event.sequence < passing
      && event.payload?.from === "CLAUDE_FIX" && event.payload?.to === "CODEX_FINAL_REVIEW")).toBe(true);
    expect(g6cPassedToReady(r, passing)).toBe(true);
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await apply("DG-2")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-2 수정 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    await legacyTopic(r);
    // 옛 엔진 상태와 같다: 계약 행 0건 · 최신 checkpoint = DG-2 반박 paused(diagnosis#DG-2) · 진단 [해결, 대체, 수정 불필요] · 재개 = 최종 리뷰 · 최신 최종 리뷰 = #P.
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)).toEqual([]);
    const legacy = JSON.parse((await r.artifacts.readLatest(r.topicId, "work-checkpoint"))!) as { phase: string; work: { kind: string; fixSource?: string } };
    expect([legacy.work.kind, legacy.phase, legacy.work.fixSource]).toEqual(["FIX", "paused", "diagnosis#DG-2"]);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "resolved"], ["DG-2", "superseded"], ["DG-3", "closed_no_action"]]);
    expect([topic.state, r.database.getFlags(r.topicId).resumeState]).toEqual(["USER_DECISION_REQUIRED", "CODEX_FINAL_REVIEW"]);
    expect(r.database.latestArtifact(r.topicId, "codex-final-review")!.revision).toBe(passing);
    const applySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const codexBefore = r.codex.prompts.length;
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await apply("DG-4")).status).toBe(200);
    const settled = await settledState(r, "g6c-legacy-passing-not-stop");
    const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(contracts.map((contract) => [contract.route, contract.diagnosisIds])).toEqual([["diagnosis", ["DG-4"]]]);
    const [contract] = contracts;
    // 1) 새 계약은 인도 대기 출처(review null)·원본 없음 — 통과 리뷰 #P 는 정지가 아니고, 결정 시작점도 그 리뷰가 아니라 적용 시점이다.
    expect(contract.origin).toEqual({ stage: "READY_TO_DELIVER", review: null });
    expect(contract.source).toEqual([]);
    expect(contract.decisionFrom).toBeGreaterThan(applySequence);
    // 2) F-8 은 러너 프롬프트에 실리지 않고, 교정 턴 없이 DG-4 보고만으로 수락된다 — 다음 최종 리뷰의 원본에도 누적되지 않고 인도 대기에 이른다.
    expect(fixTargetsIn(dg4Prompt).map((finding) => finding.id)).toEqual(["DG-4"]);
    expect(dg4Prompt).not.toContain('"id": "F-8"');
    expect(contract.status).toBe("accepted");
    expect(r.claude.turns).toHaveLength(4);
    expect(r.database.getTimeline(r.topicId, applySequence).some((event) => event.body.includes("검토 쟁점을 누락했습니다"))).toBe(false);
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(1);
    expect((contractSourceIn(finals[0]) ?? []).map((finding) => finding.id)).not.toContain("F-8");
    expect(settled).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).find((record) => record.id === "DG-4")?.status).toBe("resolved");
    r.database.close();
  });

  it("인도 대기에 이른 통과 최종 리뷰(참고 쟁점 F-8) 뒤 인도 대기에서 적용한 계획 변경 진단 DG-1 의 개정 턴이 죽고(FAILED, 재개 CLAUDE_PLAN) 수정 정정 DG-2 가 재개 단계를 최종 리뷰로 되돌려도 그 통과 리뷰는 정지가 아니다 — DG-2 의 새 진단 전용 계약은 인도 대기 출처(review null)·원본 없음이고 F-8 을 러너 프롬프트·다음 최종 리뷰의 원본에 싣지 않으며 교정 턴 없이 수락돼 인도 대기에 이른다(2026-09-15 감사 6차 #10)", { timeout: 60_000 }, async () => {
    const codex = new G6cReviewFixThenPassingInfoCodex();
    const r = await room("g6c-plan-change-corrected-not-stop", [], { codexInstance: codex });
    let dg2Prompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "F-1 반영\n"); return result("FIX", "F-1 반영", { status: "completed", findings: [{ ...REVIEW_FIX_FINDING, disposition: "RESOLVED_BY_FIX", rationale: "F-1 수정" }] }); },
      () => { throw new Error("개정 턴 프로세스 비정상 종료"); },
      (turn) => {
        dg2Prompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영\n");
        return result("FIX", "DG-2 반영", { status: "completed", findings: [resolved("DG-2")] });
      },
      // 통과 리뷰의 F-8 을 원본으로 동결하면 이 계약 교정 턴이 열린다 — 경계가 맞으면 쓰이지 않는다.
      () => result("FIX", "DG-2 반영(교정)", { status: "completed", findings: [resolved("DG-2"), { ...PASSING_INFO_F8, disposition: "AGREED_NO_ACTION", rationale: "참고 사항" }] }),
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    // 전제: 리뷰 수정 계약 FC-1(F-1, 첫 회차)이 수락된 뒤 최종 리뷰 #P 가 F-1 반영 확인과 참고 쟁점 F-8 을 담고 통과해 인도 대기로 넘어갔다.
    const passing = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult).findings.map((finding) => [finding.id, finding.disposition]))
      .toEqual([["F-1", "RESOLVED_BY_FIX"], ["F-8", "AGREED_ACTION"]]);
    expect(g6cPassedToReady(r, passing)).toBe(true);
    expect(r.database.getFlags(r.topicId).fixPassUsed).toBe(true);
    const topic = r.database.getTopic(r.topicId);
    const [fc1] = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect([fc1.contractId, fc1.route, fc1.status]).toEqual(["FC-1", "review", "accepted"]);
    expect(fc1.settledAfter!).toBeLessThan(passing);
    // 인도 대기에서 계획 변경 진단을 적용하면 완료 판정이 취소되고(재개 복원 = 최종 리뷰) 개정 턴이 응답 전에 죽는다 → FAILED(재개 CLAUDE_PLAN).
    expect((await register(planDiagnosis())).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_PLAN");
    expect(r.claude.turns).toHaveLength(3);
    // 수정 정정(DG-2, supersedes DG-1)이 저장 전 개정을 취소해 재개 단계를 최종 리뷰로 되돌린다. 최신 최종 리뷰는 여전히 통과 리뷰 #P 다.
    expect((await register(fixDiagnosis({ title: "계획 변경 불필요 — 범위 안 수정", supersedes: "DG-1" }))).status).toBe(201);
    expect([r.database.getTopic(r.topicId).state, r.database.getFlags(r.topicId).resumeState]).toEqual(["FAILED", "CODEX_FINAL_REVIEW"]);
    expect(r.database.latestArtifact(r.topicId, "codex-final-review")!.revision).toBe(passing);
    const applySequence = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const codexBefore = codex.prompts.length;
    expect((await apply("DG-2")).status).toBe(200);
    const settled = await settledState(r, "g6c-plan-change-corrected-not-stop");
    const fc2 = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((contract) => contract.diagnosisIds.includes("DG-2"))!;
    expect([fc2.contractId, fc2.route]).toEqual(["FC-2", "diagnosis"]);
    // 1) 새 계약은 인도 대기 출처(review null)·원본 없음 — 통과 리뷰 #P 는 정지가 아니다.
    expect(fc2.origin).toEqual({ stage: "READY_TO_DELIVER", review: null });
    expect(fc2.source).toEqual([]);
    expect(fc2.decisionFrom).toBeGreaterThanOrEqual(applySequence);
    // 2) F-8 은 러너 프롬프트에 실리지 않고, 교정 턴 없이 DG-2 보고만으로 수락된다 — 다음 최종 리뷰의 원본에도 누적되지 않고 인도 대기에 이른다.
    expect(fixTargetsIn(dg2Prompt).map((finding) => finding.id)).toEqual(["DG-2"]);
    expect(dg2Prompt).not.toContain('"id": "F-8"');
    expect(fc2.status).toBe("accepted");
    expect(r.claude.turns).toHaveLength(4);
    expect(r.database.getTimeline(r.topicId, applySequence).some((event) => event.body.includes("검토 쟁점을 누락했습니다"))).toBe(false);
    const finals = codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals.length).toBeGreaterThanOrEqual(1);
    expect(finals.flatMap((prompt) => (contractSourceIn(prompt) ?? []).map((finding) => finding.id))).not.toContain("F-8");
    expect(settled, r.database.getTopic(r.topicId).lastError ?? "").toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).find((record) => record.id === "DG-2")?.status).toBe("resolved");
    r.database.close();
  });

  it("통과한 최종 리뷰(참고 쟁점 F-8)가 인도 대기에 이른 뒤에 저장된 최종 리뷰 정지는 여전히 정지다 — 인도 대기에서 적용한 DG-2 수정이 수락된 뒤 최종 리뷰 #S 가 F-2(수정 합의 + 사용자 판정 필요)로 멈추면, 그 정지에서 적용한 DG-3 의 새 계약은 #S 를 출처·결정 시작점으로 가지고 F-2 만 원본·수정 대상으로 싣는다(통과 리뷰의 F-8 은 싣지 않는다)(2026-09-15 감사 6차 #10)", { timeout: 60_000 }, async () => {
    const r = await room("g6c-stop-after-ready-kept", [], { codexInstance: new G6cPassThenStopFinalCodex() });
    let dg3Prompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-2 반영\n"); return result("FIX", "DG-2 반영", { status: "completed", findings: [resolved("DG-2")] }); },
      (turn) => {
        dg3Prompt = turn.prompt;
        writeFileSync(join(r.worktree, "feature.txt"), "DG-3·F-2 반영\n");
        return result("FIX", "DG-3·F-2 반영", {
          status: "completed",
          findings: [resolved("DG-3"), { ...FINAL_REVIEW_DECISION_FINDING, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "F-2 로그 경로를 고쳤습니다." }],
        });
      },
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g6c-stop-after-ready-kept 추가 승인")).toBe("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g6c-stop-after-ready-kept 추가 승인")).toBe("READY_TO_DELIVER");
    const passing = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect((JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult).findings.map((finding) => [finding.id, finding.disposition]))
      .toEqual([["DG-1", "RESOLVED_BY_FIX"], ["F-8", "AGREED_ACTION"]]);
    const readyAfterPass = r.database.getTimeline(r.topicId, passing)
      .find((event) => event.payload?.from === "CODEX_FINAL_REVIEW" && event.payload?.to === "READY_TO_DELIVER")!.sequence;
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await apply("DG-2")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(FINAL_REVIEW_DECISION_FINDING.rationale);
    // 전제: 정지 #S 는 통과 리뷰 #P 의 인도 대기 전이 뒤에 저장됐고, 그 자신은 인도 대기로 넘어가지 않았다.
    const stop = r.database.latestArtifact(r.topicId, "codex-final-review")!.revision;
    expect(stop).toBeGreaterThan(readyAfterPass);
    expect(g6cPassedToReady(r, stop)).toBe(false);
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 C" }))).status).toBe(201);
    expect((await apply("DG-3")).status).toBe(200);
    const settled = await settledState(r, "g6c-stop-after-ready-kept");
    const topic = r.database.getTopic(r.topicId);
    const contracts = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch);
    expect(contracts.map((contract) => [contract.contractId, contract.route, contract.status, contract.diagnosisIds]))
      .toEqual([["FC-1", "diagnosis", "accepted", ["DG-1"]], ["FC-2", "diagnosis", "accepted", ["DG-2"]], ["FC-3", "diagnosis", "accepted", ["DG-3"]]]);
    const fc3 = contracts[2];
    expect(contracts[1].origin).toEqual({ stage: "READY_TO_DELIVER", review: null });
    // 정지 #S 를 출처·결정 시작점으로 가지고, 그 판정 필요 쟁점 F-2 만 원본으로 싣는다 — 앞선 통과 리뷰 #P 의 F-8 은 싣지 않는다.
    expect(fc3.origin).toEqual({ stage: "CODEX_FINAL_REVIEW", review: { kind: "codex-final-review", revision: stop } });
    expect(fc3.decisionFrom).toBe(stop);
    expect(fc3.source.map((finding) => [finding.id, finding.disposition, finding.requiresUserDecision])).toEqual([["F-2", "AGREED_ACTION", true]]);
    expect(fixTargetsIn(dg3Prompt).map((finding) => finding.id).sort()).toEqual(["DG-3", "F-2"]);
    expect(dg3Prompt).not.toContain('"id": "F-8"');
    // DG-3 수락 뒤 최종 리뷰는 구현 리뷰 한도(첫 리뷰·최종 리뷰 #P·#S 로 3회 소진)에 막혀 멈춘다. 리뷰 1회를 추가 승인하고 재개하면(이 방은 예산 계정이 없어
    // retry 로 재개) 최종 리뷰가 원본 F-2 의 반영을 확인해 인도 대기에 이른다 — 그 최종 리뷰의 원본 쟁점도 정지 #S 의 F-2 뿐이다.
    expect([settled, r.database.getFlags(r.topicId).resumeState]).toEqual(["USER_DECISION_REQUIRED", "CODEX_FINAL_REVIEW"]);
    expect(r.database.getTopic(r.topicId).lastError).toContain("리뷰 한도");
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "F-2 로그 경로 수정으로 진행하세요." })).status).toBe(200);
    const codexBefore = r.codex.prompts.length;
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g6c-stop-after-ready-kept 추가 승인")).toBe("READY_TO_DELIVER");
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(1);
    expect((contractSourceIn(finals[0]) ?? []).map((finding) => finding.id)).toEqual(["F-2"]);
    r.database.close();
  });

  // ---- 2026-09-15 감사 6차 #5 (g6d) ----
  // 감사 6차 #5: 첫 최종 리뷰(R1)가 F-2(수정 합의 + 사용자 판정 필요)로 멈추고, 두 번째(R2)는 F-2 를 증거 필요(EXTERNAL_EVIDENCE)로, 세 번째 이후는 수정 확인 없이
  // 수정 불필요(AGREED_NO_ACTION)로 판정하는 Codex. 그 밖의 쟁점(반영 보고된 진단)은 EchoCodex 그대로 확인한다.
  const G6D_F2_EVIDENCE = "F-2 수정 여부는 게이트 로그 없이는 확인할 수 없습니다.";
  class G6dEvidenceThenWithdrawnCodex extends EchoCodex {
    private finals = 0;
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "FINAL_REVIEW") return review;
      this.finals += 1;
      if (this.finals === 1) return { ...review, findings: [...review.findings, FINAL_REVIEW_DECISION_FINDING] };
      const f2: Finding = this.finals === 2
        ? { ...FINAL_REVIEW_DECISION_FINDING, disposition: "EXTERNAL_EVIDENCE", requiresUserDecision: false, rationale: G6D_F2_EVIDENCE }
        : { ...FINAL_REVIEW_DECISION_FINDING, disposition: "AGREED_NO_ACTION", requiresUserDecision: false, rationale: WITHDRAWN_F2_VERDICT };
      return { ...review, findings: [...review.findings.filter((finding) => finding.id !== "F-2"), f2] };
    }
  }

  // 감사 6차 #5 공통 전제: 구현 → 첫 리뷰 쟁점 0건 → 인도 대기 → DG-1 진단 전용 수정 수락(FC-1) → R1 이 F-2(수정 합의 + 판정 필요)로 멈춤(재개 CODEX_FINAL_REVIEW)
  // → DG-2 진단 전용 수정(FC-2, 원본 [F-2 AGREED_ACTION])을 러너가 DG-2·F-2 반영으로 보고해 수락 → R2 가 F-2 를 증거 필요로 판정해 BLOCKED_ON_EVIDENCE(재개
  // CODEX_FINAL_REVIEW). 사용자 메시지는 없다.
  async function g6dEvidenceStop(label: string) {
    const r = await room(label, [], { codexInstance: new G6dEvidenceThenWithdrawnCodex() });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }); },
      () => {
        writeFileSync(join(r.worktree, "feature.txt"), "DG-2·F-2 반영\n");
        return result("FIX", "DG-2·F-2 반영", {
          status: "completed",
          findings: [resolved("DG-2"), { ...FINAL_REVIEW_DECISION_FINDING, disposition: "RESOLVED_BY_FIX", requiresUserDecision: false, rationale: "F-2 로그 경로를 고쳤습니다." }],
        });
      },
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g6c-stop-after-ready-kept 추가 승인")).toBe("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await apply("DG-2")).status).toBe(200);
    await r.idle("BLOCKED_ON_EVIDENCE");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(G6D_F2_EVIDENCE);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.status, contract.source.map((finding) => [finding.id, finding.disposition])]))
      .toEqual([["FC-1", "accepted", []], ["FC-2", "accepted", [["F-2", "AGREED_ACTION"]]]]);
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user")).toHaveLength(0);
    return { r, register, apply };
  }

  // 감사 6차 #5 변형: 첫 리뷰가 확정 결함 F-1(수정 합의)을 내 리뷰 수정 계약(FC-1)을 열고, 첫 최종 리뷰(R1)는 반영 보고된 F-1 을 증거 필요로, 그 뒤 최종 리뷰는 F-1 을
  // 수정 확인 없이 수정 불필요로 판정하는 Codex. 그 밖의 턴은 EchoCodex 그대로다.
  class G6dFirstReviewEvidenceCodex extends EchoCodex {
    private reviews = 0;
    private finals = 0;
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind === "REVIEW") {
        this.reviews += 1;
        return this.reviews === 1 ? { ...review, summary: "고쳐야 할 결함이 있습니다.", findings: [...review.findings, REVIEW_DEFECT_FINDING] } : review;
      }
      if (review.kind !== "FINAL_REVIEW") return review;
      this.finals += 1;
      const f1: Finding = this.finals === 1
        ? { ...REVIEW_DEFECT_FINDING, disposition: "EXTERNAL_EVIDENCE", rationale: "F-1 수정은 게이트 로그 없이는 확인할 수 없습니다." }
        : { ...REVIEW_DEFECT_FINDING, disposition: "AGREED_NO_ACTION", rationale: "F-1 은 고칠 필요가 없다고 봅니다(수정 확인 안 함)." };
      return { ...review, findings: [...review.findings.filter((finding) => finding.id !== "F-1"), f1] };
    }
  }

  it("진단 전용 계약 FC-2 가 고치기로 합의한 F-2(AGREED_ACTION)는 뒤 증거 정지에서 적용한 DG-3 의 계약 원본에 증거 필요(EXTERNAL_EVIDENCE)로 동결돼도 가려지지 않는다 — 러너가 F-2 를 수정 불필요로 내려 FC-3 이 수락되고 다음 최종 리뷰가 수정 확인 없이 닫으면, 그 리뷰 프롬프트의 원본 절은 F-2 를 FC-2 의 합의 판으로 싣고 되돌림 가드가 멈춰 인도 대기·커밋에 이르지 않으며, 'OVERRULE F-2' 결정 뒤에야 인도 대기·커밋에 이른다(2026-09-15 감사 6차 #5)", { timeout: 90_000 }, async () => {
    const { r, register, apply } = await g6dEvidenceStop("g6d-agreed-not-shadowed");
    let dg3Prompt = "";
    r.claude["steps"].push((turn) => {
      dg3Prompt = turn.prompt;
      writeFileSync(join(r.worktree, "other.txt"), "DG-3 반영\n");
      return result("FIX", "DG-3 반영, F-2 는 고칠 필요 없음", {
        status: "completed",
        findings: [resolved("DG-3"), { ...FINAL_REVIEW_DECISION_FINDING, disposition: "AGREED_NO_ACTION", requiresUserDecision: false, rationale: "로그 경로는 고칠 필요가 없습니다." }],
      });
    });
    // 1) 증거 정지(R2)에서 DG-3 을 적용한다 — FC-3 원본은 R2 의 F-2(증거 필요)이고, 러너의 수정 불필요 보고는 그 원본 기준으로 수락된 뒤 리뷰 한도로 멈춘다.
    expect((await register(fixDiagnosis({ title: "게이트 로그 경로 보강" }))).status).toBe(201);
    expect((await apply("DG-3")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("리뷰 한도에 도달했습니다");
    expect(fixTargetsIn(dg3Prompt).map((finding) => [finding.id, finding.disposition])).toEqual([["DG-3", "AGREED_ACTION"], ["F-2", "EXTERNAL_EVIDENCE"]]);
    const topic = r.database.getTopic(r.topicId);
    const fc3 = r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch).find((contract) => contract.diagnosisIds.includes("DG-3"))!;
    expect([fc3.contractId, fc3.status, fc3.source.map((finding) => [finding.id, finding.disposition])]).toEqual(["FC-3", "accepted", [["F-2", "EXTERNAL_EVIDENCE"]]]);
    // 2) 리뷰 1회를 추가 승인하고 재개하면 최종 리뷰 R3 이 돈다.
    const codexBefore = r.codex.prompts.length;
    const resumedAt = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    const settled = await settledState(r, "g6d-agreed-not-shadowed R3");
    const finals = r.codex.prompts.slice(codexBefore).filter((prompt) => prompt.includes("반환 kind는 FINAL_REVIEW"));
    expect(finals).toHaveLength(1);
    // 3) R3 가 F-2 를 수정 확인 없이 닫자 되돌림 가드가 멈춘다 — 인도 대기 전이가 없고 커밋은 거부된다.
    expect(settled, r.database.getTopic(r.topicId).lastError ?? "").toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("수정 확인 없이 닫았습니다(F-2)");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > resumedAt).some((event) => event.payload?.to === "READY_TO_DELIVER")).toBe(false);
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-2 판정 없이 인도", paths: ["feature.txt", "other.txt"] });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(String(blocked.body.error)).toContain("READY_TO_DELIVER");
    // 4) R3 프롬프트의 원본 절은 F-2 를 FC-2 가 합의한 판(수정 합의 + 판정 필요, HIGH) 그대로 싣는다 — FC-3 의 증거 필요 동결본이 가리지 않는다.
    const shown = contractSourceIn(finals[0]);
    expect(shown?.map((finding) => [finding.id, finding.disposition])).toEqual([["F-2", "AGREED_ACTION"]]);
    expect(shown?.[0]).toMatchObject({ severity: "HIGH", requiresUserDecision: true, rationale: FINAL_REVIEW_DECISION_FINDING.rationale });
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    // 5) 사용자가 줄 머리 'OVERRULE F-2' 결정을 올리고 재시도해야 인도 대기·커밋에 이른다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "OVERRULE F-2\nF-2 는 수정하지 않아도 됩니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await g6aSettleWithGrants(r, "g6d-agreed-not-shadowed OVERRULE")).toBe("READY_TO_DELIVER");
    expect(r.database.getTimeline(r.topicId).some((event) => event.body.includes("사용자 결정이 처분 변경을 허용한 쟁점: F-2(AGREED_ACTION → AGREED_NO_ACTION)"))).toBe(true);
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "resolved"], ["DG-2", "resolved"], ["DG-3", "resolved"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "OVERRULE F-2 뒤 인도", paths: ["feature.txt", "other.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("대조군: 같은 증거 정지(R2)에서 진단 없이 증거만 올리고 재시도해도 다음 최종 리뷰가 FC-2 의 합의 쟁점 F-2 를 수정 확인 없이 닫으면 되돌림 가드가 멈춘다 — 진단 적용 여부만 다른 두 경로의 판정이 같아야 한다(2026-09-15 감사 6차 #5)", { timeout: 90_000 }, async () => {
    const { r } = await g6dEvidenceStop("g6d-evidence-control");
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "evidence", body: "게이트 로그: logs/gate2.log — F-2 경로 확인용" })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("리뷰 한도에 도달했습니다");
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "g6d-evidence-control R3")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("수정 확인 없이 닫았습니다(F-2)");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    r.database.close();
  });

  it("첫 리뷰가 고치기로 합의한 F-1(AGREED_ACTION)도 최종 리뷰 증거 정지에서 적용한 진단 DG-1 의 계약 원본에 증거 필요로 동결된 판에 가려지지 않는다 — 러너가 F-1 을 수정 불필요로 내려 FC-2 가 수락되고 다음 최종 리뷰가 수정 확인 없이 닫으면 되돌림 가드가 멈춰 인도 대기·커밋에 이르지 않고, 'OVERRULE F-1' 결정 뒤에야 인도 대기·커밋에 이른다(2026-09-15 감사 6차 #5)", { timeout: 60_000 }, async () => {
    const r = await room("g6d-first-review-agreed", [], { codexInstance: new G6dFirstReviewEvidenceCodex() });
    let dg1Prompt = "";
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => {
        writeFileSync(join(r.worktree, "feature.txt"), "F-1 수정\n");
        return result("FIX", "F-1 수정", { status: "completed", findings: [{ ...REVIEW_DEFECT_FINDING, disposition: "RESOLVED_BY_FIX", rationale: "F-1 을 고쳤습니다.", evidenceRefs: ["feature.txt:1"] }] });
      },
      (turn) => {
        dg1Prompt = turn.prompt;
        writeFileSync(join(r.worktree, "other.txt"), "DG-1 반영\n");
        return result("FIX", "DG-1 반영, F-1 은 고칠 필요 없음", {
          status: "completed", findings: [resolved("DG-1"), { ...REVIEW_DEFECT_FINDING, disposition: "AGREED_NO_ACTION", rationale: "F-1 은 고칠 필요가 없습니다." }],
        });
      },
    );
    // 전제: 첫 리뷰 F-1 합의 → 리뷰 수정 계약 FC-1 수락 → 최종 리뷰 R1 이 F-1 을 증거 필요로 판정해 멈춘다(재개 CODEX_FINAL_REVIEW).
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("BLOCKED_ON_EVIDENCE");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    // 1) 증거 정지에서 DG-1 을 적용한다 — FC-2 원본은 R1 의 F-1(증거 필요)이고, 러너의 수정 불필요 보고는 그 원본 기준으로 수락된다.
    const appliedAt = r.database.getTimeline(r.topicId).at(-1)!.sequence;
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis({ title: "게이트 로그 경로 보강" }), { mediator: true })).status).toBe(201);
    expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true })).status).toBe(200);
    const settled = await settledState(r, "g6d-first-review-agreed R2");
    expect(fixTargetsIn(dg1Prompt).map((finding) => [finding.id, finding.disposition])).toEqual([["DG-1", "AGREED_ACTION"], ["F-1", "EXTERNAL_EVIDENCE"]]);
    const topic = r.database.getTopic(r.topicId);
    expect(r.database.fixContracts.list(r.topicId, topic.scopeGeneration, topic.planEpoch)
      .map((contract) => [contract.contractId, contract.route, contract.status, contract.source.map((finding) => [finding.id, finding.disposition])]))
      .toEqual([["FC-1", "review", "accepted", [["F-1", "AGREED_ACTION"]]], ["FC-2", "diagnosis", "accepted", [["F-1", "EXTERNAL_EVIDENCE"]]]]);
    // 2) 최종 리뷰 R2 가 F-1 을 수정 확인 없이 닫자 되돌림 가드가 멈춘다 — 인도 대기 전이가 없고 커밋은 거부된다.
    expect(settled, r.database.getTopic(r.topicId).lastError ?? "").toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("수정 확인 없이 닫았습니다(F-1)");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.sequence > appliedAt).some((event) => event.payload?.to === "READY_TO_DELIVER")).toBe(false);
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "F-1 판정 없이 인도", paths: ["feature.txt", "other.txt"] });
    expect(blocked.status).toBeGreaterThanOrEqual(400);
    expect(String(blocked.body.error)).toContain("READY_TO_DELIVER");
    expect(r.database.getTimeline(r.topicId).filter((event) => event.actor === "user" && event.kind === "decision")).toHaveLength(0);
    // 3) 사용자가 줄 머리 'OVERRULE F-1' 결정을 올리고 재시도해야 인도 대기·커밋에 이른다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "OVERRULE F-1\nF-1 은 수정하지 않아도 됩니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "g6d-first-review-agreed OVERRULE")).toBe("READY_TO_DELIVER");
    expect((await r.diagnoses()).map((record) => [record.id, record.status])).toEqual([["DG-1", "resolved"]]);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "OVERRULE F-1 뒤 인도", paths: ["feature.txt", "other.txt"] })).status).toBe(200);
    r.database.close();
  });

  // ---- host-review R10 잔여(2026-09-15): 리뷰(Codex)가 finding 과 별개로 requestedUserDecision 으로 사용자에게 물은 질문 ----
  // 계열 불변식: 결정 요청은 누가 했든(러너 결과·checkpoint, 첫 리뷰, 최종 리뷰) 사용자가 답하기 전에는 인도 대기로 넘어가지 않는다. 러너 요청은 열린 요청
  // (checkpoint)으로 추적되지만(원래 R10), 리뷰의 단독 질문은 추적되지 않아 진단 우회·결정 없는 재시도로 사라졌다.
  const R10_FINAL_QUESTION = "배포 창을 오늘 저녁으로 잡아도 되는지 사용자 확인이 필요합니다.";
  const R10_REVIEW_QUESTION = "외부 API 키 회전 일정을 사용자에게 확인해야 합니다.";
  // 첫 최종 리뷰만 반영 확인과 함께 질문(requestedUserDecision)을 남기고 멈추는 Codex — 판정 필요 finding 은 없다. 그 뒤 최종 리뷰는 질문 없이 통과한다.
  class R10FinalQuestionCodex extends EchoCodex {
    constructor(private readonly findingQuestion = false) { super(); }
    private finals = 0;
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "FINAL_REVIEW") return review;
      this.finals += 1;
      return this.finals === 1 ? this.findingQuestion
        ? { ...review, findings: review.findings.map((finding) => ({ ...finding, requiresUserDecision: true, rationale: R10_FINAL_QUESTION })) }
        : { ...review, requestedUserDecision: R10_FINAL_QUESTION } : review;
    }
  }
  // 첫 리뷰 한 번만 질문을 남기고 멈추는 Codex(같은 계열의 첫 리뷰 경로).
  class R10ReviewQuestionCodex extends EchoCodex {
    private reviews = 0;
    override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
      const review = await super.resumeTurn(turn);
      if (review.kind !== "REVIEW") return review;
      this.reviews += 1;
      return this.reviews === 1 ? { ...review, requestedUserDecision: R10_REVIEW_QUESTION } : review;
    }
  }

  // 공통 전제: 구현 → 인도 대기 → DG-1 진단 전용 수정 수락 → 최종 리뷰 #1 이 DG-1 반영을 확인하며 질문으로 멈춘다(재개 = 최종 리뷰).
  async function r10FinalQuestionStop(label: string, findingQuestion = false) {
    const r = await room(label, [], { codexInstance: new R10FinalQuestionCodex(findingQuestion) });
    r.claude["steps"].push(
      () => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); },
      () => { writeFileSync(join(r.worktree, "feature.txt"), "DG-1 반영\n"); return result("FIX", "DG-1 을 반영했습니다.", { status: "completed", findings: [resolved("DG-1")] }); },
    );
    const register = (body: unknown) => r.call("POST", `/api/topics/${r.topicId}/diagnoses`, body, { mediator: true });
    const apply = (id: string) => r.call("POST", `/api/topics/${r.topicId}/diagnoses/${id}/apply`, undefined, { mediator: true });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 A" }))).status).toBe(201);
    expect((await apply("DG-1")).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(R10_FINAL_QUESTION);
    const stored = JSON.parse((await r.artifacts.readLatest(r.topicId, "codex-final-review"))!) as AgentResult;
    expect([stored.requestedUserDecision, stored.findings.some((finding) => finding.requiresUserDecision)]).toEqual(findingQuestion ? [undefined, true] : [R10_FINAL_QUESTION, false]);
    return { r, register, apply };
  }

  it.each([false, true])("R10 요청 형식(%s): 최종 리뷰가 finding 과 별개로 사용자에게 물은 질문(requestedUserDecision)은 진단 적용 → 수정 턴 응답 전 실패 → 수정 불필요 정정으로 우회해도 사라지지 않는다 — 다음 최종 리뷰가 질문 없이 통과해도 사용자 결정이 없으면 인도 대기·커밋에 이르지 않고, 결정을 올려 재시도하면 저장된 리뷰를 재사용해 인도 대기·커밋에 이른다(2026-09-15 host-review R10 잔여)", { timeout: 60_000 }, async (findingQuestion) => {
    const { r, register, apply } = await r10FinalQuestionStop("r10-final-question-bypass", findingQuestion);
    r.claude["steps"].push(() => { throw new Error("DG-2 진단 수정 턴 프로세스 비정상 종료"); });
    expect((await register(fixDiagnosis({ title: "외부 검증 실패 B" }))).status).toBe(201);
    expect((await apply("DG-2")).status).toBe(200);
    await r.idle("FAILED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CLAUDE_FIX");
    // 수정 턴이 응답 전에 죽어 러너의 열린 요청은 없다 — 수정 불필요 정정은 계약을 닫는다(러너 요청에 대한 원래 R10 검사는 통과한다).
    expect((await register(fixDiagnosis({ kind: "no_action", title: "DG-2 수정 불필요", supersedes: "DG-2" }))).status).toBe(201);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    const settled = await settledState(r, "r10-final-question-bypass-retry");
    // 다음 최종 리뷰는 질문 없이 통과했지만(Codex 1턴) 질문에 사용자 결정이 없어 인도 대기로 넘어가지 않는다.
    expect(r.codex.prompts).toHaveLength(codexBefore + 1);
    expect(settled).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_FINAL_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(R10_FINAL_QUESTION);
    const blocked = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "질문 미해소 인도", paths: ["feature.txt"] });
    expect(blocked.status).not.toBe(200);
    expect(r.database.getFlags(r.topicId).committedOID).toBeFalsy();
    // 사용자가 결정을 올리고 재시도하면 저장된 최종 코드 리뷰를 재사용해(답변 확인 턴만 실행) 인도 대기에 이르고 커밋이 열린다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "오늘 저녁 배포 창으로 진행합니다." })).status).toBe(200);
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("리뷰");
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(codexBefore + 1);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "질문 해소 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("첫 리뷰가 사용자에게 물은 질문도 같은 계열이다 — 결정 없이 재시도해 다시 돈 첫 리뷰가 질문 없이 통과해도 인도 대기로 넘어가지 않고, 결정을 올려 재시도해야 인도 대기·커밋에 이른다(2026-09-15 host-review R10 잔여)", { timeout: 60_000 }, async () => {
    const r = await room("r10-review-question-retry", [], { codexInstance: new R10ReviewQuestionCodex() });
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현 완료\n"); return result("IMPLEMENTATION", "구현을 마쳤습니다.", { status: "completed" }); });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/implement`)).status).toBe(200);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(R10_REVIEW_QUESTION);
    // 결정 없이 재시도 — 첫 리뷰가 다시 돌아 질문 없이 통과해도 인도 대기로 넘어가지 않는다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    expect(await settledState(r, "r10-review-question-retry-1")).toBe("USER_DECISION_REQUIRED");
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.database.getFlags(r.topicId).resumeState).toBe("CODEX_REVIEW");
    expect(r.database.getTopic(r.topicId).lastError).toContain(R10_REVIEW_QUESTION);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "질문 미해소 인도", paths: ["feature.txt"] })).status).not.toBe(200);
    // 결정을 올리고 재시도하면 인도 대기에 이르고 커밋이 열린다.
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "키 회전은 다음 주에 합니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(2);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "질문 해소 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it("대조군: 최종 리뷰가 질문으로 멈춘 뒤 사용자가 결정을 올리고 재시도하면 그 결정이 질문의 답이다 — 저장된 최종 코드 리뷰를 재사용해(답변 확인 턴만 실행) 인도 대기·커밋에 이른다(2026-09-15 host-review R10 잔여)", { timeout: 60_000 }, async () => {
    const { r } = await r10FinalQuestionStop("r10-final-question-answered");
    const codexBefore = r.codex.prompts.length;
    expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "오늘 저녁 배포 창으로 진행합니다." })).status).toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/retry`)).status).toBe(200);
    await r.idle("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(codexBefore);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "결정 뒤 인도", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });
  it.each(["보류하고 다른 작업만 계속", "무관한 배포 공지 작성만 승인"])("R10 답변 보존: %s — 확인 뒤에도 요청과 커밋 차단이 남고 같은 결정은 다시 호출하지 않는다", async (body) => {
    const { r } = await r10FinalQuestionStop("r10-unanswered-decision");
    r.codex.answerHandlers.push(() => []);
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await settledState(r, "답변 미해소 재시도")).toBe("USER_DECISION_REQUIRED");
    expect(r.codex.answerConfirmations).toHaveLength(1);
    expect(r.database.getTopic(r.topicId).lastError).toContain(R10_FINAL_QUESTION);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "보류 중", paths: ["feature.txt"] })).status).not.toBe(200);
    // 같은 결정으로 재시도해도 확인을 다시 사지 않는다(원장에 추가 실행 예약 자체가 없다).
    const used = r.database.reviews.account(r.topicId, "implementation").used;
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await settledState(r, "답변 미해소 재시도")).toBe("USER_DECISION_REQUIRED");
    expect(r.codex.answerConfirmations).toHaveLength(1);
    expect(r.database.reviews.account(r.topicId, "implementation").used).toBe(used);
    expect(r.database.getTopic(r.topicId).lastError).toContain(R10_FINAL_QUESTION);
    r.database.close();
  });

  it("R10 공식 구현 재개 승인은 리뷰 질문의 답변이 아니고 확인 호출도 만들지 않는다", async () => {
    const { r } = await r10FinalQuestionStop("r10-resume-not-answer");
    const topic = r.database.getTopic(r.topicId);
    const response = await r.call("POST", `/api/topics/${r.topicId}/actions/resume-implementation`, {
      expectedState: topic.state, expectedScopeGeneration: topic.scopeGeneration, reason: "질문은 보류하고 다른 작업을 계속",
    }, { mediator: true });
    expect(response.status).toBe(200);
    const { pendingReviewRequests } = await import("../src/server/engine/reviewRequests");
    expect(pendingReviewRequests(r.database.getTimeline(r.topicId), topic.scopeGeneration)).toHaveLength(1);
    expect(r.codex.answerConfirmations).toHaveLength(0);
    r.database.close();
  });

  it.each([false, true])("R10 여러 질문의 부분 답변과 이전 승인 취소를 재확인한다(revoked=%s)", async (revoked) => {
    class TwoQuestions extends EchoCodex {
      override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
        const review = await super.resumeTurn(turn);
        return { ...review, requestedUserDecision: this.prompts.length === 1 ? "배포 채널?" : undefined,
          findings: [{ id: "Q-TIME", title: "배포 시간?", rationale: "배포 시간?", severity: "LOW", disposition: "AGREED_NO_ACTION", requiresUserDecision: this.prompts.length === 1, evidenceRefs: [] }] };
      }
    }
    const r = await room("r10-partial-answer", [], { codexInstance: new TwoQuestions() });
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현\n"); return result("IMPLEMENTATION", "완료", { status: "completed" }); });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("USER_DECISION_REQUIRED");
    // 코드 검토는 완료됐지만 이전 질문 두 개가 남아 전달은 막힌 상태로 만든다.
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle("USER_DECISION_REQUIRED");
    r.codex.answerHandlers.push(({ requests, decisions }) => [{ requestId: requests.find((request) => request.question === "배포 채널?")!.id, decisionSequence: decisions.at(-1)!.sequence }]);
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "채널 A, 시간은 보류" });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.database.getTopic(r.topicId).lastError).toContain("배포 시간?");
    expect(r.database.getTopic(r.topicId).lastError).not.toContain("배포 채널?");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "미답변", paths: ["feature.txt"] })).status).not.toBe(200);
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: revoked ? "채널 A 승인은 취소, 배포 시간은 오후 8시" : "배포 시간은 오후 8시" });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.codex.answerConfirmations).toHaveLength(1); // 답변 확인도 3회 한도를 우회하지 않는다.
    if (revoked) r.codex.answerHandlers.push(({ requests, decisions }) => [{ requestId: requests.find(request => request.question.includes("배포 시간?"))!.id, decisionSequence: decisions.at(-1)!.sequence }]);
    const { version } = r.database.reviews.account(r.topicId, "implementation");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/review-resume`, { scope: "implementation", version })).status).toBe(200);
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    if (revoked) {
      await r.idle("USER_DECISION_REQUIRED");
      expect(r.database.getTopic(r.topicId).lastError).toContain("배포 채널?");
      expect(r.codex.answerConfirmations.at(-1)?.prompt).toContain("배포 채널?");
      expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "취소", paths: ["feature.txt"] })).status).not.toBe(200);
      r.database.close();
      return;
    }
    await r.idle("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.answerConfirmations).toHaveLength(2);
    for (const turn of r.codex.answerConfirmations) {
      expect(turn.sessionId).toBe("codex-review");
      expect(turn.protocolOnly).toBe(true);
      expect(turn.implementation).toBe(false);
      expect(turn.readablePaths).toEqual([]);
    }
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "모든 답변 확인", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it.each(["unknown-id", "unknown-decision", "duplicate", "failed"])("R10 잘못된 확인 또는 실행 실패(%s)는 요청을 보존하고 같은 입력을 재호출하지 않는다", async (mode) => {
    const { r } = await r10FinalQuestionStop(`r10-invalid-${mode}`);
    r.codex.answerHandlers.push(({ requests, decisions }) => {
      if (mode === "failed") throw new Error("답변 확인 프로세스 종료");
      const answer = { requestId: mode === "unknown-id" ? "RQ-unknown" : requests[0].id,
        decisionSequence: mode === "unknown-decision" ? 999999 : decisions.at(-1)!.sequence };
      return mode === "duplicate" ? [answer, answer] : [answer];
    });
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "오늘 저녁 배포" });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle(mode === "failed" ? "FAILED" : "USER_DECISION_REQUIRED");
    const used = r.database.reviews.account(r.topicId, "implementation").used;
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.codex.answerConfirmations).toHaveLength(1);
    expect(r.database.reviews.account(r.topicId, "implementation").used).toBe(used);
    expect(r.database.getTopic(r.topicId).lastError).toContain(R10_FINAL_QUESTION);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "잘못된 확인", paths: ["feature.txt"] })).status).not.toBe(200);
    r.database.close();
  });

  it("R12 질문 필드 없이 blocked 만 반환한 리뷰도 다음 리뷰가 생략하면 계속 커밋을 막는다", async () => {
    class BlockedReview extends EchoCodex {
      override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
        const review = await super.resumeTurn(turn);
        return this.prompts.length === 1 ? { ...review, status: "blocked", summary: "운영 담당자의 배포 승인을 기다립니다." } : review;
      }
    }
    const r = await room("r12-blocked-review", [], { codexInstance: new BlockedReview() });
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현\n"); return result("IMPLEMENTATION", "완료", { status: "completed" }); });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    expect(await settledState(r, "blocked 리뷰 보존")).toBe("USER_DECISION_REQUIRED");
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await settledState(r, "blocked 리뷰 보존")).toBe("USER_DECISION_REQUIRED");
    expect(r.database.getTimeline(r.topicId).some((event) => event.actor === "codex" && event.payload?.status === "blocked")).toBe(true);
    expect(r.database.getTopic(r.topicId).lastError).toContain("운영 담당자의 배포 승인");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "blocked 우회", paths: ["feature.txt"] })).status).not.toBe(200);
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "운영 담당자가 오늘 배포를 승인했습니다." });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(2);
    expect(r.codex.answerConfirmations).toHaveLength(1);
    r.database.close();
  });

  it("R10 답변 확인 중 새 메시지가 도착하면 이전 답변 확인 결과를 채택하지 않는다", async () => {
    const { r } = await r10FinalQuestionStop("r10-answer-new-input");
    r.codex.answerHandlers.push(async ({ requests, decisions }) => {
      expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "직전 답변은 취소하고 배포를 보류합니다." })).status).toBe(200);
      return [{ requestId: requests[0].id, decisionSequence: decisions.at(-1)!.sequence }];
    });
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "오늘 저녁 배포 승인" });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    await r.idle("USER_DECISION_REQUIRED");
    expect(r.codex.answerConfirmations).toHaveLength(1);
    expect(r.database.getTopic(r.topicId).lastError).toContain("새 메시지");
    expect(r.database.getTimeline(r.topicId).some((event) => event.payload?.reviewRequestAnswers)).toBe(false);
    expect(r.database.latestArtifact(r.topicId, "codex-interrupted")).toBeTruthy();
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "취소된 답변", paths: ["feature.txt"] })).status).not.toBe(200);
    r.database.close();
  });

  it.each([[false, "evidence"], [false, "note"], [true, "evidence"], [true, "note"]] as const)("R13 새 실패 자료는 저장된 리뷰를 재사용하지 않는다(최종=%s, 종류=%s)", async (finalPass, messageKind) => {
    const failure = "현재 후보 smoke 검사에서 인증 회귀가 재현됐습니다.";
    class EvidenceReview extends EchoCodex {
      private relevant = 0;
      override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
        const review = await super.resumeTurn(turn);
        if ((review.kind === "FINAL_REVIEW") !== finalPass) return review;
        this.relevant += 1;
        if (turn.prompt.includes(failure)) return { ...review, findings: [...review.findings, {
          id: "NEW-EVIDENCE", title: "인증 회귀 검증", severity: "HIGH", disposition: "EXTERNAL_EVIDENCE",
          rationale: failure, evidenceRefs: ["smoke 로그"], requiresUserDecision: false,
        }] };
        return this.relevant === 1 ? { ...review, requestedUserDecision: "배포 시간?" } : review;
      }
    }
    const r = await room(`r13-evidence-${finalPass}-${messageKind}`, [], { codexInstance: new EvidenceReview() });
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현\n"); return result("IMPLEMENTATION", "완료", { status: "completed" }); });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle(finalPass ? "READY_TO_DELIVER" : "USER_DECISION_REQUIRED");
    if (finalPass) {
      r.claude["steps"].push(() => result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }));
      await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true });
      await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
      await r.idle("USER_DECISION_REQUIRED");
    }
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await g6aSettleWithGrants(r, "코드 판정 보존")).toBe("USER_DECISION_REQUIRED");
    const before = r.codex.prompts.length;
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: messageKind, body: failure });
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "배포 시간은 오후 8시" });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await g6aSettleWithGrants(r, "새 실패 자료 검토")).toBe("BLOCKED_ON_EVIDENCE");
    expect(r.codex.prompts).toHaveLength(before + 1);
    expect(r.codex.prompts.at(-1)).toContain(failure);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "실패 증거 있음", paths: ["feature.txt"] })).status).not.toBe(200);
    r.database.close();
  });

  it.each(["blocked", "in_progress", "completed"] as const)("R14 남은 검토가 있는 최종 리뷰(%s)는 정상 리뷰 완료 전 재사용하지 않는다", async (status) => {
    class IncompleteFinal extends EchoCodex {
      finalCalls = 0;
      override async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
        const review = await super.resumeTurn(turn);
        if (review.kind !== "FINAL_REVIEW") return review;
        this.finalCalls += 1;
        return this.finalCalls === 1 ? { ...review, status, remainingSteps: ["새 자료에서 인증 계약을 검토해야 합니다."] }
          : { ...review, status: "completed", remainingSteps: [] };
      }
    }
    const codex = new IncompleteFinal();
    const r = await room(`r14-incomplete-${status}`, [], { codexInstance: codex });
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현\n"); return result("IMPLEMENTATION", "완료", { status: "completed" }); });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    r.claude["steps"].push(() => result("FIX", "DG-1 반영", { status: "completed", findings: [resolved("DG-1")] }));
    await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true });
    await r.call("POST", `/api/topics/${r.topicId}/diagnoses/DG-1/apply`, undefined, { mediator: true });
    expect(await settledState(r, "미완료 최종 리뷰")).toBe("USER_DECISION_REQUIRED");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "미완료", paths: ["feature.txt"] })).status).not.toBe(200);
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "자료는 docs/auth.md 에 있습니다. 남은 검토를 실행하세요." });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await g6aSettleWithGrants(r, "미완료 리뷰 재개")).toBe("READY_TO_DELIVER");
    expect(codex.finalCalls).toBe(2);
    expect(r.codex.prompts.at(-1)).not.toContain("바뀌지 않은 부분은 앞선 리뷰 결과를 이어받고");
    expect(r.codex.prompts.at(-1)).toContain("새 자료에서 인증 계약을 검토해야 합니다.");
    expect(r.codex.prompts.at(-1)).toContain("자료는 docs/auth.md");
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "완료 리뷰 확인", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

describe("R1/R2 delivery admission", () => {
  it("R1 진단 등록 대기 중 commit은 Git 진입 전 거부한다", async () => {
    const r = await room("r1-registration-race", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현\n"); return result("IMPLEMENTATION", "완료", { status: "completed" }); });
    await r.call("POST", `/api/topics/${r.topicId}/actions/implement`);
    await r.idle("READY_TO_DELIVER");
    const committedOID = r.database.getFlags(r.topicId).committedOID;
    const original = GitService.prototype.snapshot;
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    let first = true;
    vi.spyOn(GitService.prototype, "snapshot").mockImplementation(async function (this: GitService, ...args) { if (first && args[0] === r.worktree) { first = false; entered(); await held; } return original.apply(this, args); });
    const before = git(r.worktree, ["rev-parse", "HEAD"]);
    const registration = r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true });
    await started;
    let response;
    try { response = await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "race", paths: ["feature.txt"] }); }
    finally { release(); }
    await registration;
    expect(response.status).not.toBe(200);
    expect(git(r.worktree, ["rev-parse", "HEAD"])).toBe(before);
    expect(r.database.getFlags(r.topicId).committedOID).toBe(committedOID);
    r.database.close();
  });

  it("R1 commit 대기 중 진단·결정은 거부하고 실패 후 잠금을 해제한다", async () => {
    const r = await room("r1-delivery-race", []);
    r.claude["steps"].push(() => { writeFileSync(join(r.worktree, "feature.txt"), "구현\n"); return result("IMPLEMENTATION", "완료", { status: "completed" }); });
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
      expect((await r.call("POST", `/api/topics/${r.topicId}/diagnoses`, fixDiagnosis(), { mediator: true })).status).not.toBe(200);
      expect((await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "전달 중 취소" })).status).not.toBe(200);
      expect(r.database.getTimeline(r.topicId).some(event => event.body === "전달 중 취소")).toBe(false);
    } finally { release(); }
    expect((await commit).status).not.toBe(200);
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "retry", paths: ["feature.txt"] })).status).toBe(200);
    r.database.close();
  });

  it.each([false, true])("R2 READY 이후 승인 취소와 재승인은 코드 재리뷰 없이 복구한다(committed=%s)", async (committed) => {
    const { r } = await r10FinalQuestionStop("r2-ready-revoke");
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "오늘 배포 승인" });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await g6aSettleWithGrants(r, "최초 승인")).toBe("READY_TO_DELIVER");
    if (committed) expect((await r.call("POST", `/api/topics/${r.topicId}/actions/commit`, { message: "approved", paths: ["feature.txt"] })).status).toBe(200);
    const oid = r.database.getFlags(r.topicId).committedOID;
    const reviews = r.codex.prompts.length;
    r.codex.answerHandlers.push(() => []);
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "앞선 배포 승인 취소, 보류" });
    expect((await r.call("POST", `/api/topics/${r.topicId}/actions/${committed ? "push" : "commit"}`, committed ? undefined : { message: "revoked", paths: ["feature.txt"] })).status).not.toBe(200);
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    const stopped = await g6aSettleWithGrants(r, "취소 확인");
    expect(stopped).toBe("USER_DECISION_REQUIRED");
    expect(r.codex.answerConfirmations.at(-1)?.prompt).toContain(R10_FINAL_QUESTION);
    await r.call("POST", `/api/topics/${r.topicId}/messages`, { kind: "decision", body: "내일 오후 8시 배포 재승인" });
    await r.call("POST", `/api/topics/${r.topicId}/actions/retry`);
    expect(await g6aSettleWithGrants(r, "재승인 확인")).toBe("READY_TO_DELIVER");
    expect(r.codex.prompts).toHaveLength(reviews);
    expect(r.database.getFlags(r.topicId).committedOID).toBe(oid);
    if (committed) {
      const remote = mkdtempSync(join(tmpdir(), "r2-push-remote-"));
      temporaryDirectories.push(remote);
      git(remote, ["init", "--bare"]);
      git(r.worktree, ["remote", "add", "origin", remote]);
      expect((await r.call("POST", `/api/topics/${r.topicId}/actions/push`)).status).toBe(200);
      expect(r.database.getFlags(r.topicId).pushedOID).toBe(oid);
      expect(git(remote, ["rev-parse", `refs/heads/${r.database.getTopic(r.topicId).branchName}`])).toBe(oid);
    }
    r.database.close();
  });
});

});
