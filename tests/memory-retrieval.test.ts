import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectMemoryReader } from "../src/server/projectMemory";
import { buildClaudePlanPrompt, buildCodexAuditPrompt } from "../src/shared/prompts";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-retrieval-"));
  roots.push(root);
  mkdirSync(join(root, "claude-only"));
  mkdirSync(join(root, "codex-only"));
  const entries = [
    ["houseregist-form.md", "매물등록 단계 입력 폼 검증", "# 매물등록 폼\n## 저장 요청과 검증"],
    ["shortform-media.md", "숏폼 카드 재생 미디어 계약", "# 숏폼 미디어\n## 캐러셀 재생"],
    ["consensus-room-review.md", "Consensus Room 계획 승인 해시 리뷰 세션 재개", "# Consensus Room 리뷰\n## 승인 해시와 리뷰 세션"],
    ["consensus-room-recovery.md", "Consensus Room 실행 취소 재시작 복구", "# Consensus Room 복구\n## 실행 취소와 재시작"],
    ["account-identity-source.md", "계정 승인 구조", "# 계정 승인"],
    ["agency-verification.md", "중개사 승인 확인 구조", "# 중개사 승인"],
    ["cancellationerror.md", "Swift Concurrency 취소 오류", "# Swift 취소"],
    ["leaf-topic.md", "독립 자료", "# 원자적 체크포인트\n## 파일 교체 실패"],
    ["telemetry-cost.md", "실행 비용 자료", "# 실행 시간 관측"],
    ["codex-only/review.md", "Codex 리뷰 실행", "# Codex 리뷰 실행"],
    ["claude-only/review.md", "Claude 리뷰 실행", "# Claude 리뷰 실행"],
  ];
  writeFileSync(join(root, "context-router.md"), "# Router\n");
  writeFileSync(join(root, "MEMORY.md"), entries.map(([path, label]) => `- [${label}](${path})`).join("\n"));
  for (const [path, , body] of entries) writeFileSync(join(root, path), body);
  return root;
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

// Expected documents come from the fixture's subjects, not the ranking implementation.
// Public boundary: buildPrompt -> adapter stdin; select -> diagnostic evaluation.
const cases: Array<[string, string, string[]]> = [
  ["매물등록 폼 검증", "houseregist-form.md", ["account-identity-source.md"]],
  ["매물 등록 단계 입력", "houseregist-form.md", ["agency-verification.md"]],
  ["HouseRegister 저장 요청", "houseregist-form.md", ["consensus-room-review.md"]],
  ["house-register 폼 검증", "houseregist-form.md", ["shortform-media.md"]],
  ["숏폼 카드 재생", "shortform-media.md", ["agency-verification.md"]],
  ["숏 폼 캐러셀 재생", "shortform-media.md", ["houseregist-form.md"]],
  ["ShortForm 미디어 계약", "shortform-media.md", ["account-identity-source.md"]],
  ["short-form 재생 확인", "shortform-media.md", ["consensus-room-review.md"]],
  ["consensus-room 계획 승인 해시와 리뷰 세션 재개 처리 구조를 확인해줘", "consensus-room-review.md", ["account-identity-source.md", "agency-verification.md"]],
  ["Consensus Room 승인 리뷰", "consensus-room-review.md", ["agency-verification.md"]],
  ["컨센서스룸 리뷰 세션", "consensus-room-review.md", ["account-identity-source.md"]],
  ["consensusroom 승인 해시", "consensus-room-review.md", ["agency-verification.md"]],
  ["Consensus Room 실행 취소 후 재시작", "consensus-room-recovery.md", ["cancellationerror.md"]],
  ["consensus-room 복구", "consensus-room-recovery.md", ["agency-verification.md"]],
  ["컨센서스 룸 취소 복구", "consensus-room-recovery.md", ["cancellationerror.md"]],
  ["consensusroom 재시작 복구", "consensus-room-recovery.md", ["houseregist-form.md"]],
  ["계정 승인", "account-identity-source.md", ["consensus-room-review.md"]],
  ["중개사 승인", "agency-verification.md", ["consensus-room-review.md"]],
  ["Swift Concurrency 취소 오류", "cancellationerror.md", ["consensus-room-recovery.md"]],
  ["원자적 체크포인트 파일 교체", "leaf-topic.md", ["agency-verification.md"]],
  ["Codex 리뷰 실행", "codex-only/review.md", ["claude-only/review.md"]],
  ["해양 조류 관측", "", ["consensus-room-review.md"]],
  ["구조를 확인해줘", "", ["account-identity-source.md", "agency-verification.md"]],
  ["승인", "", ["account-identity-source.md", "agency-verification.md"]],
];

describe("memory retrieval: 24 independently labelled questions", () => {
  it.each(cases)("%s", async (query, required, forbidden) => {
    const root = fixture();
    for (const role of ["claude", "codex"] as const) {
      const prompt = await new ProjectMemoryReader(root).buildPrompt(query, role);
      if (required && !(required.startsWith("codex-only/") && role === "claude")) {
        expect(prompt).toContain(`메모리 문서 시작: ${required}`);
      }
      for (const path of forbidden.filter(path => !path.startsWith(`${role}-only/`))) {
        expect(prompt).not.toContain(`메모리 문서 시작: ${path}`);
      }
      expect(prompt).not.toContain(`메모리 문서 시작: ${role === "codex" ? "claude" : "codex"}-only/`);
      if (!required) expect((prompt.match(/메모리 문서 시작:/g) ?? []).length).toBe(1);
    }
  });

  it("generated plan/audit boilerplate does not turn a feature question into a Consensus Room query", async () => {
    const reader = new ProjectMemoryReader(fixture());
    const plan = buildClaudePlanPrompt({ title: "매물 등록 폼 검증", worktreePath: "/tmp/example", sourceRepositoryPath: "/tmp/source", baseRef: "main", scopeGeneration: 1, timeline: [] });
    const audit = buildCodexAuditPrompt({ title: "숏 폼 카드 재생", planMarkdown: "# 숏폼 카드 재생", planSHA256: "a".repeat(64), scopeGeneration: 1, timeline: [] });
    for (const [prompt, expected] of [[plan, "houseregist-form.md"], [audit, "shortform-media.md"]]) {
      const docs = await reader.select(prompt, "codex");
      expect(docs.map(d => d.path)).toContain(expected);
      expect(docs.some(d => d.path.startsWith("consensus-room"))).toBe(false);
    }
  });

  it("a generic generated title retains the user's multi-paragraph request", async () => {
    const reader = new ProjectMemoryReader(fixture());
    const prompt = buildClaudePlanPrompt({ title: "결함 수정", worktreePath: "/tmp/example", sourceRepositoryPath: "/tmp/source", baseRef: "main", scopeGeneration: 1,
      timeline: [{ id: 1, topicId: "topic", sequence: 1, scopeGeneration: 1, actor: "user", kind: "note", state: "DRAFT", body: "화면을 확인했어.\n\n숏폼 카드 재생을 고쳐줘.", payload: {}, createdAt: "2026-09-22T00:00:00Z" }] });
    const paths = (await reader.select(prompt, "codex")).map(d => d.path);
    expect(paths).toContain("shortform-media.md");
    expect(paths).not.toContain("consensus-room-review.md");
  });

  it("diagnostics preserve the four-document limit and never duplicate the router/index", async () => {
    const root = fixture();
    let index = "- [Router](context-router.md)\n- [Index](MEMORY.md)\n";
    for (let i = 0; i < 6; i++) {
      const path = `sample-document-${i}.md`;
      index += `- [SampleDocument](${path})\n`;
      writeFileSync(join(root, path), "# SampleDocument\n");
    }
    writeFileSync(join(root, "MEMORY.md"), index);
    const result = await new ProjectMemoryReader(root).selectWithDiagnostics("SampleDocument", "codex");
    expect(result.snapshots).toHaveLength(5);
    expect(result.decisions.filter(d => d.reason === "document-limit")).toHaveLength(2);
    expect(result.snapshots.some(d => d.path === "MEMORY.md")).toBe(false);
    expect(new Set(result.snapshots.map(d => d.path)).size).toBe(result.snapshots.length);
  });

  it("oversized and aggregate-budget documents are excluded before prompt delivery", async () => {
    const root = fixture();
    let index = "";
    for (let i = 0; i < 4; i++) {
      const path = `sample-document-${i}.md`;
      index += `- [SampleDocument](${path})\n`;
      writeFileSync(join(root, path), "# SampleDocument\n" + "x".repeat(i === 0 ? 80_000 : 75_000));
    }
    writeFileSync(join(root, "MEMORY.md"), index);
    const result = await new ProjectMemoryReader(root).selectWithDiagnostics("SampleDocument", "codex");
    expect(result.bytes).toBeLessThanOrEqual(180_000);
    expect(result.snapshots).toHaveLength(3);
    expect(result.decisions.find(d => d.path === "sample-document-0.md")?.reason).toBe("unreadable");
    expect(result.decisions.filter(d => d.reason === "byte-limit")).toHaveLength(1);
  });
});

// Public boundary: evaluator CLI -> comparable corpus hash -> before/after comparison consumer.
// No UI/async request lifecycle contract applies; subprocess completion is the synchronization boundary.
describe("evaluation corpus identity", () => {
  it("tracks nested readable documents but excludes symlinks and unrelated directories", () => {
    const root = fixture();
    const nested = "codex-only/maps/deep/route.md";
    mkdirSync(join(root, "codex-only/maps/deep"), { recursive: true });
    writeFileSync(join(root, nested), "# RouteDocument\nBefore");
    writeFileSync(join(root, "MEMORY.md"), `- [RouteDocument](${nested})`);
    mkdirSync(join(root, "excluded"));
    writeFileSync(join(root, "excluded/source.md"), "Before");
    symlinkSync(join(root, "excluded"), join(root, "codex-only/linked"));
    const cases = join(root, "cases.json");
    writeFileSync(cases, JSON.stringify([{ id: "nested", query: "RouteDocument", required: [nested], forbidden: [] }]));
    const evaluate = (reader?: string) => {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/evaluate-memory.ts",
        "--memory", root, "--cases", cases, ...(reader ? ["--reader", reader] : [])], { encoding: "utf8" });
      if (!result.stdout) throw new Error(result.stderr || String(result.error));
      return { code: result.status, report: JSON.parse(result.stdout) };
    };
    const before = evaluate();
    expect(before.code).toBe(0);
    expect(before.report.results.find((r: { role: string }) => r.role === "codex").paths).toContain(nested);
    writeFileSync(join(root, nested), "# RouteDocument\nAfter");
    const after = evaluate();
    expect(after.code).toBe(0);
    expect(after.report.corpusSHA256).not.toBe(before.report.corpusSHA256);
    writeFileSync(join(root, "excluded/source.md"), "Changed outside readable scope");
    expect(evaluate().report.corpusSHA256).toBe(after.report.corpusSHA256);
    const reader = join(root, "mutating-reader.mjs");
    writeFileSync(reader, `import {writeFileSync} from 'node:fs';
      export class ProjectMemoryReader {
        async select() { writeFileSync(${JSON.stringify(join(root, nested))}, '# RouteDocument\\nDuring evaluation'); return []; }
      }`);
    const changedDuringRun = evaluate(reader);
    expect(changedDuringRun.code).toBe(1);
    expect(changedDuringRun.report.comparable).toBe(false);
  });
});
