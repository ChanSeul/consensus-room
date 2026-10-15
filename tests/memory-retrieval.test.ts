import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConsensusDatabase } from "../src/server/database";
import { memorySearch, topicMemorySearch } from "../src/server/memoryRetrieval";
import { ProjectMemoryReader } from "../src/server/projectMemory";
import { buildFirstTurnPrompt } from "../src/shared/prompts";

const roots: string[] = [];
const databases: ConsensusDatabase[] = [];
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
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

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

  it("generated planner/plan-reviewer first-turn boilerplate does not turn a feature question into a Consensus Room query", async () => {
    const reader = new ProjectMemoryReader(fixture());
    const plan = buildFirstTurnPrompt({ role: "planner", title: "매물 등록 폼 검증", worktreePath: "/tmp/example", baseRef: "main", planDirectory: "/tmp/example-plan" });
    const audit = buildFirstTurnPrompt({ role: "plan-reviewer", title: "숏 폼 카드 재생", worktreePath: "/tmp/example", baseRef: "main",
      plan: { status: "current", version: "a".repeat(64), snapshotPath: "/tmp/example-plan/plan.md", diffPath: null } });
    for (const [prompt, expected] of [[plan, "houseregist-form.md"], [audit, "shortform-media.md"]]) {
      const docs = await reader.select(prompt, "codex");
      expect(docs.map(d => d.path)).toContain(expected);
      expect(docs.some(d => d.path.startsWith("consensus-room"))).toBe(false);
    }
  });

  it("a generic generated title retains the user's multi-paragraph request", async () => {
    const reader = new ProjectMemoryReader(fixture());
    const prompt = buildFirstTurnPrompt({ role: "planner", title: "결함 수정", worktreePath: "/tmp/example", baseRef: "main", planDirectory: "/tmp/example-plan",
      discussion: [{ sequence: 1, actor: "user", kind: "note", body: "화면을 확인했어.\n\n숏폼 카드 재생을 고쳐줘." }] });
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

// Advisor 7: a reduced copy of the three HouseRegister sessions' corpus. The router links two houseregist documents from
// its SwiftUI section and the wiki from the feature-wiki section. Several general notes mention features only in headings.
function featureFixture() {
  const root = mkdtempSync(join(tmpdir(), "memory-feature-"));
  roots.push(root);
  writeFileSync(join(root, "context-router.md"), [
    "# Router", "## SwiftUI",
    "- HouseRegister: [houseregist-swiftui-conversion.md](houseregist-swiftui-conversion.md), [houseregist-folder-architecture.md](houseregist-folder-architecture.md)",
    "## Build, CI, E2E", "- 러너 빌드: [runner-sandbox-build-constraints.md](runner-sandbox-build-constraints.md)",
    "## 기능별 위키 안내",
    "- [매물등록 폼 검증과 제출 흐름을 확인하는 순서](houseregister-wiki.md)",
    "- [숏폼 카드와 전체화면 재생을 나눠 확인하는 순서](shortform-wiki.md)",
  ].join("\n"));
  writeFileSync(join(root, "MEMORY.md"), [
    "- 모듈 추출: [공통 패턴](feature-module-assembly-pattern.md) · [HouseRegister](houseregister-module-extraction.md)",
    "- 매물등록: [전환 parity·노출 정책 소유권](houseregist-swiftui-conversion.md) · [폴더 아키텍처](houseregist-folder-architecture.md) · [Validator·wire parity](houseregist-validator-parity.md) · [17106 작업 묶음·체크포인트](houseregist-17106-work-group-transition.md)",
    "- 진행 중: [매물등록 TCA 전환 설계와 구현 묶음](tca-app-wide-conversion-work-group.md)",
    "- 러너 환경·SDK: [러너 샌드박스 빌드 제약(매크로·XPC)](runner-sandbox-build-constraints.md) · [Sendbird SDK 경계(binaryTarget·LLDB 전사)](sendbird-sdk-boundary.md)",
    "- [Swift Concurrency 데드락](feedback-swift-concurrency-deadlock.md) - lock 안 resume 금지",
    "- 지도·상세: [매물상세 섹션 스크롤 앵커](housedetail-section-scroll-anchor.md)",
    "- 환경: [Consensus Room 앱(실행·API·재시작)](consensus-room-app.md)",
    "", "## 기능별 위키 안내",
    "- [매물등록 폼 검증과 제출 흐름을 확인하는 순서](houseregister-wiki.md)",
    "- [숏폼 카드와 전체화면 재생을 나눠 확인하는 순서](shortform-wiki.md)",
  ].join("\n"));
  const documents: Record<string, string> = {
    "houseregister-wiki.md": "# 매물등록 폼 검증과 제출 흐름\n## 먼저 읽을 코드\nHOUSE-WIKI-BODY",
    "shortform-wiki.md": "# 숏폼 카드와 전체화면 재생\n## 재생 소유자",
    "houseregist-swiftui-conversion.md": "# 매물등록 SwiftUI 전환\n## 전환 parity\n## 노출 정책",
    "houseregist-folder-architecture.md": "# 매물등록 폴더\n## 책임 경계",
    "houseregist-validator-parity.md": "# Validator parity\n## 요청값 비교",
    "houseregist-17106-work-group-transition.md": "# 17106 작업 묶음\n## 체크포인트",
    "houseregister-module-extraction.md": "# HouseRegister 모듈 추출\n## 의존 방향",
    "feature-module-assembly-pattern.md": "# 모듈 조립 공통 패턴",
    "tca-app-wide-conversion-work-group.md": "# TCA 전환 작업 묶음\n## 단계\n## 리듀서 전환",
    "runner-sandbox-build-constraints.md": "# 러너 샌드박스 빌드 제약\n## 매크로 빌드\n## XPC",
    "sendbird-sdk-boundary.md": "# Sendbird SDK 경계\n## 로그인 뒤 연결\n## 알림 토큰\n## 동시성 콜백\n## 채팅 화면\n## 빌드 설정",
    "feedback-swift-concurrency-deadlock.md": "# Swift Concurrency 데드락\n## lock 안 resume",
    "housedetail-section-scroll-anchor.md": "# 매물상세 섹션 스크롤\n## 지도 섹션\n## 매물등록 버튼 위치",
    "consensus-room-app.md": "# Consensus Room 앱\n## 재시작\n## 빌드와 배포",
  };
  for (const [path, body] of Object.entries(documents)) writeFileSync(join(root, path), body);
  return root;
}
const UNRELATED = ["sendbird-sdk-boundary.md", "housedetail-section-scroll-anchor.md", "consensus-room-app.md", "shortform-wiki.md"];
const ROOT_GOAL = "sample-ios 매물등록(Modules/Features/HouseRegister) 모듈의 상태 관리를 동작 변경 없이 TCA(The Composable Architecture) 구조로 완전히 전환한다. "
  + "구현은 토픽 example-topic(PROJECT-123 샘플 기능 통합)의 공식 전달 커밋 위에서 한다.";
// The measured user decisions relay whole design documents that mention many features in passing.
const RELAYED_DESIGN = "설계 원문: 로그인 계정 확인, 알림 권한, Sendbird 채팅 연결, 동시성 격리 규칙, 매물상세 지도 섹션, "
  + "Consensus Room 재시작 뒤 복구, 빌드와 배포 검증을 다룬다.";

function topicDatabase(): ConsensusDatabase {
  const root = mkdtempSync(join(tmpdir(), "memory-search-db-"));
  roots.push(root);
  const db = new ConsensusDatabase(join(root, "db.sqlite"));
  databases.push(db);
  return db;
}
function createTopic(db: ConsensusDatabase, id: string, title: string, goal: string | null, parentTopicId: string | null = null) {
  return db.createTopic({ workflowMode: "ticket", id, slug: id, title, parentTopicId, topicKind: parentTopicId ? "task" : "group",
    workEntry: { mode: "goal", goal, sourceIds: [], evidenceDigest: null }, baseRef: "HEAD", repositoryPath: "/tmp/example",
    worktreePath: "/Users/me/Library/Application Support/ConsensusRoom/worktrees/stage", state: "DRAFT", branchName: null,
    scopeGeneration: 1, planRevision: 0, planSHA256: null, approvedPlanSHA256: null, createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(), lastError: null });
}

describe("memory search input chosen by the engine (advisor 7)", () => {
  it("builds the search from topic titles, goals and user messages, never from paths or relayed records", () => {
    const db = topicDatabase();
    createTopic(db, "root", "매물등록 TCA 전환", ROOT_GOAL);
    const stage = createTopic(db, "cp1", "매물등록 TCA 전환 구현 · CP1 말단 리듀서 5종", "매물등록 TCA 전환 구현 · CP1 말단 리듀서 5종", "root");
    db.appendEvent({ topicId: "cp1", actor: "user", kind: "decision", state: "DRAFT", body: RELAYED_DESIGN });
    db.appendEvent({ topicId: "cp1", actor: "system", kind: "system", state: "DRAFT", body: "숏폼 시스템 기록" });
    expect(topicMemorySearch(db, db.getTopic(stage.id))).toEqual({
      subject: ["매물등록 TCA 전환 구현 · CP1 말단 리듀서 5종", "매물등록 TCA 전환", ROOT_GOAL].join("\n"), request: RELAYED_DESIGN });
    expect(memorySearch(topicMemorySearch(db, db.getTopic(stage.id))).subjects).toEqual(["매물등록"]);
  });

  it.each([
    "매물등록 TCA 전환 · 설계",
    "매물등록 TCA 전환 구현 · CP0 준비: 격리·준수 정리와 의존성 키",
    "매물등록 TCA 전환 구현 · CP1 말단 리듀서 5종",
  ])("injects the feature wiki and keeps incidental notes out: %s", async (title) => {
    const reader = new ProjectMemoryReader(featureFixture());
    const search = { subject: [title, "매물등록 TCA 전환", ROOT_GOAL].join("\n"), request: RELAYED_DESIGN };
    // The prompt still carries the role guide, a ConsensusRoom worktree path and the relayed design.
    const prompt = buildFirstTurnPrompt({ role: "implementer", title, worktreePath: "/Users/me/Library/Application Support/ConsensusRoom/worktrees/stage",
      messages: [{ sequence: 3, actor: "user", kind: "decision", body: RELAYED_DESIGN }] });
    for (const role of ["claude", "codex"] as const) {
      const enriched = await reader.buildPrompt(prompt, role, undefined, true, search);
      expect(enriched).toContain("메모리 문서 시작: houseregister-wiki.md");
      expect(enriched).toContain("HOUSE-WIKI-BODY");
      for (const path of UNRELATED) expect(enriched).not.toContain(`메모리 문서 시작: ${path}`);
      // Resume prompts carry no title. The manifest must list the same documents the session received.
      const manifest = await reader.buildManifest("코드 리뷰어 응답 원문: 로그인·알림·Consensus Room 재시작을 확인했습니다.", role, undefined, true, search);
      const injected = [...enriched.matchAll(/메모리 문서 시작: (\S+) ---/g)].map(match => match[1]);
      expect([...manifest.matchAll(/^- (\S+) @/gm)].map(match => match[1])).toEqual(injected);
    }
  });

  it("keeps the build and concurrency notes the subject names, beside the feature wiki", async () => {
    const reader = new ProjectMemoryReader(featureFixture());
    const selection = await reader.selectWithDiagnostics({ subject: "매물등록 리듀서 빌드 실패와 Swift Concurrency 동시성 경고" }, "codex");
    const paths = selection.snapshots.map(document => document.path);
    expect(paths).toEqual(expect.arrayContaining(["houseregister-wiki.md", "runner-sandbox-build-constraints.md", "feedback-swift-concurrency-deadlock.md"]));
    expect(paths).toHaveLength(5);
    for (const path of UNRELATED) expect(paths).not.toContain(path);
    expect(selection.decisions.find(decision => decision.path === "houseregister-wiki.md")?.reason).toBe("feature-wiki");
  });

  it("completes a generic subject with the user's request, and ignores the request when the subject names a feature", async () => {
    const reader = new ProjectMemoryReader(fixture());
    const generic = (await reader.select({ subject: "결함 수정", request: "화면을 확인했어.\n\n숏폼 카드 재생을 고쳐줘." }, "codex")).map(d => d.path);
    expect(generic).toContain("shortform-media.md");
    expect(generic).not.toContain("consensus-room-review.md");
    const named = (await reader.select({ subject: "숏폼 카드 재생", request: "Consensus Room 계획 승인 해시와 리뷰 세션 재개" }, "codex")).map(d => d.path);
    expect(named).toContain("shortform-media.md");
    expect(named.some(path => path.startsWith("consensus-room"))).toBe(false);
  });

  // engine-review F005 (advisor 25): a technical word or a short English alias in the title does not name a feature, so the
  // user's feature request stays in the search and its wiki is selected.
  it("keeps the feature request when the subject only names a technical area", async () => {
    const reader = new ProjectMemoryReader(featureFixture());
    const search = { subject: "빌드 오류 수정", request: "HouseRegister 매물등록 모듈의 빌드 실패를 고쳐줘" };
    expect(memorySearch(search).text).toContain(search.request);
    const selection = await reader.selectWithDiagnostics(search, "codex");
    const paths = selection.snapshots.map(document => document.path);
    expect(paths).toEqual(expect.arrayContaining(["houseregister-wiki.md", "runner-sandbox-build-constraints.md"]));
    expect(selection.decisions.find(decision => decision.path === "houseregister-wiki.md")?.reason).toBe("feature-wiki");
  });

  it.each([
    ["author 표시 정리", "매물등록 폼 검증을 고쳐줘", "houseregist-form.md"],
    ["ChatGPT 응답 비교", "숏폼 카드 재생을 고쳐줘", "shortform-media.md"],
  ])("a short English alias inside another word does not drop the request: %s", async (subject, request, expected) => {
    expect(memorySearch({ subject, request }).text).toContain(request);
    const paths = (await new ProjectMemoryReader(fixture()).select({ subject, request }, "codex")).map(d => d.path);
    expect(paths).toContain(expected);
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
