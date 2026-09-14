import { describe, expect, it } from "vitest";

import {
  CARRIED_LEDGER_NOTE_PREFIX,
  LEX_START,
  carryForwardLedger,
  evaluateTolerance,
  globToRegExp,
  hunkSatisfies,
  lexLine,
  matchesAny,
  parseTolerancePolicy,
  parseUnifiedDiff,
  renderToleranceSummary,
  stateAtLine,
  ToleranceFormatError,
  sanitizeJSONControlCharacters,
  normalizeToleranceBlocks,
} from "../src/shared/tolerance";

const policyBlock = `## 허용 오차

\`\`\`tolerance
{"scopePaths":["SampleApp/Features/**","docs/swift6/S10-app/**"],
 "rules":[{"id":"T-1","title":"S9 파일 nonisolated 표기","paths":["SampleApp/Service/**"],"hunk":"insert-token","tokens":["nonisolated"],"maxFiles":2,"maxHunks":5,"invariants":["Service 0 유지"]},
          {"id":"T-2","title":"모듈 표기","paths":["Modules/**"],"hunk":"annotation-only","tokens":["@Sendable","@MainActor"],"maxFiles":1,"maxHunks":3}]}
\`\`\`
`;

describe("허용 오차 정책 파싱", () => {
  it("계획의 tolerance 블록을 읽는다 — 없으면 null", () => {
    const policy = parseTolerancePolicy(policyBlock);
    expect(policy?.rules.map((rule) => rule.id)).toEqual(["T-1", "T-2"]);
    expect(parseTolerancePolicy("# 계획\n규칙 없음")).toBeNull();
  });

  it("형식이 틀린 블록은 던진다(계획 계약에서 거부)", () => {
    expect(() => parseTolerancePolicy("```tolerance\n{not json}\n```")).toThrow("JSON 이 아닙니다");
    expect(() => parseTolerancePolicy('```tolerance\n{"scopePaths":["a/**"],"rules":[{"id":"T-1","title":"x","paths":["b/**"],"hunk":"insert-token","tokens":[],"maxFiles":1,"maxHunks":1}]}\n```')).toThrow("tokens 가 필요");
    expect(() => parseTolerancePolicy('```tolerance\n{"scopePaths":["a/**"],"rules":[{"id":"T-1","title":"x","paths":["b/**"],"hunk":"any","maxFiles":1,"maxHunks":1},{"id":"T-1","title":"y","paths":["c/**"],"hunk":"any","maxFiles":1,"maxHunks":1}]}\n```')).toThrow("중복");
  });
});

describe("glob", () => {
  it("**·*·? 를 지원하고 경로 구분자를 넘지 않는다", () => {
    expect(globToRegExp("SampleApp/Service/**").test("SampleApp/Service/Filter/FilterService.swift")).toBe(true);
    expect(globToRegExp("SampleApp/Service/**").test("SampleApp/Features/X.swift")).toBe(false);
    expect(globToRegExp("Modules/*/Sources/*.swift").test("Modules/A/Sources/B.swift")).toBe(true);
    expect(globToRegExp("Modules/*/Sources/*.swift").test("Modules/A/Sources/deep/B.swift")).toBe(false);
    expect(globToRegExp("**/*.md").test("docs/a/b.md")).toBe(true);
    expect(matchesAny("Project.swift", ["Project.swift", "Tuist/**"])).toBe(true);
  });
});

describe("hunk 술어", () => {
  const diff = `diff --git a/x.swift b/x.swift
--- a/x.swift
+++ b/x.swift
@@ -10 +10 @@
-  static let shared = Foo()
+  nonisolated static let shared = Foo()
@@ -20 +20 @@
-  func identifierId() -> String {
+  nonisolated func identifierId() -> String {
`;
  it("insert-token 은 토큰 삽입만 통과시킨다", () => {
    const { hunks } = parseUnifiedDiff(diff);
    expect(hunks).toHaveLength(2);
    const rule = { hunk: "insert-token" as const, tokens: ["nonisolated"] };
    expect(hunks.every((hunk) => hunkSatisfies(hunk, rule))).toBe(true);
    expect(hunkSatisfies({ removed: ["  let a = 1"], added: ["  let a = 2"] }, rule)).toBe(false);
    // 토큰 삭제나 교체는 insert-token 이 아니다.
    expect(hunkSatisfies({ removed: ["  nonisolated func f()"], added: ["  func f()"] }, rule)).toBe(false);
    // 줄 수가 다르면(본문 추가) 거부.
    expect(hunkSatisfies({ removed: ["  func f()"], added: ["  nonisolated func f()", "  // 주석"] }, rule)).toBe(false);
  });

  it("annotation-only 는 토큰 추가·삭제·교체를 통과시키되 다른 변경은 거부한다", () => {
    const rule = { hunk: "annotation-only" as const, tokens: ["@Sendable", "@MainActor"] };
    expect(hunkSatisfies({ removed: ["  _ operation: () -> Void"], added: ["  _ operation: @Sendable () -> Void"] }, rule)).toBe(true);
    expect(hunkSatisfies({ removed: ["  @MainActor func f()"], added: ["  func f()"] }, rule)).toBe(true);
    expect(hunkSatisfies({ removed: ["  func f()"], added: ["  func g()"] }, rule)).toBe(false);
  });

  it("any 는 상한만 본다", () => {
    expect(hunkSatisfies({ removed: [], added: ["완전히 새 줄"] }, { hunk: "any", tokens: [] })).toBe(true);
  });
});

describe("hunk 술어 — 동작 변경을 표기로 위장할 수 없다(Codex 지적 4·5)", () => {
  const rule = { hunk: "insert-token" as const, tokens: ["nonisolated"] };
  it("문자열 리터럴이 바뀌면 토큰을 함께 넣어도 거부한다", () => {
    expect(hunkSatisfies({ removed: ['  func a() { print("a b") }'], added: ['  nonisolated func a() { print("a  b") }'] }, rule)).toBe(false);
    expect(hunkSatisfies({ removed: ['  let s = "x"'], added: ['  let s = "x nonisolated"'] }, rule)).toBe(false);
  });
  it("공백만 달라도 거부한다(정규화 없음)", () => {
    expect(hunkSatisfies({ removed: ["  func a()"], added: ["   nonisolated func a()"] }, rule)).toBe(false);
    expect(hunkSatisfies({ removed: ["  func a()"], added: ["  nonisolated func a()"] }, rule)).toBe(true);
  });
  it("annotation-only 도 문자열 안 토큰은 지우지 않는다", () => {
    const annotation = { hunk: "annotation-only" as const, tokens: ["@Sendable"] };
    expect(hunkSatisfies({ removed: ['  log("@Sendable")'], added: ['  log("")'] }, annotation)).toBe(false);
    expect(hunkSatisfies({ removed: ["  f(_ op: () -> Void)"], added: ["  f(_ op: @Sendable () -> Void)"] }, annotation)).toBe(true);
  });
  it("바이너리·모드 변경·hunk 없음은 any 가 아니면 위반", () => {
    const policy = parseTolerancePolicy(policyBlock)!;
    const binary = parseUnifiedDiff("diff --git a/service/x.png b/service/x.png\nBinary files a/service/x.png and b/service/x.png differ\n");
    expect(binary).toMatchObject({ binary: true, hunks: [] });
    const mode = parseUnifiedDiff("diff --git a/service/s.sh b/service/s.sh\nold mode 100644\nnew mode 100755\n");
    expect(mode).toMatchObject({ modeChanged: true, hunks: [] });
    const evaluation = evaluateTolerance(policy, [
      { file: "SampleApp/Service/x.png", untracked: false, hunks: [], binary: true },
      { file: "SampleApp/Service/s.sh", untracked: false, hunks: [], modeChanged: true },
      { file: "SampleApp/Service/empty.swift", untracked: false, hunks: [] },
    ], [
      { ruleId: "T-1", file: "SampleApp/Service/x.png", note: "" },
      { ruleId: "T-1", file: "SampleApp/Service/s.sh", note: "" },
      { ruleId: "T-1", file: "SampleApp/Service/empty.swift", note: "" },
    ]);
    const text = evaluation.violations.join("\n");
    expect(text).toContain("바이너리 변경은 T-1");
    expect(text).toContain("파일 모드(실행 권한) 변경은 T-1");
    expect(text).toContain("텍스트 변경 구간을 찾지 못해 T-1");
  });
});

describe("평가기", () => {
  const policy = parseTolerancePolicy(policyBlock)!;
  const nonisolatedHunk = { removed: ["  func a()"], added: ["  nonisolated func a()"] };

  it("범위 안 파일은 보지 않고, 범위 밖은 원장+술어+상한을 모두 만족해야 한다", () => {
    const evaluation = evaluateTolerance(policy, [
      { file: "SampleApp/Features/Home/A.swift", untracked: false, hunks: [{ removed: ["x"], added: ["y"] }] },
      { file: "SampleApp/Service/Push/P.swift", untracked: false, hunks: [nonisolatedHunk, nonisolatedHunk] },
    ], [{ ruleId: "T-1", file: "SampleApp/Service/Push/P.swift", note: "" }]);
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.usage["T-1"]).toEqual({ files: ["SampleApp/Service/Push/P.swift"], hunks: 2 });
  });

  it("원장에 없는 범위 밖 변경·규칙 술어 위반·상한 초과·새 파일·가짜 원장 행을 각각 위반으로 낸다", () => {
    const evaluation = evaluateTolerance(policy, [
      { file: "SampleApp/Service/Push/P.swift", untracked: false, hunks: [nonisolatedHunk] },          // 원장 없음
      { file: "SampleApp/Service/Filter/F.swift", untracked: false, hunks: [{ removed: ["a"], added: ["b"] }] }, // 술어 위반
      { file: "SampleApp/Service/New.swift", untracked: true, hunks: [] },                              // 새 파일
      { file: "Modules/X/A.swift", untracked: false, hunks: [{ removed: ["f()"], added: ["@Sendable f()"] }] },
      { file: "Modules/X/B.swift", untracked: false, hunks: [{ removed: ["f()"], added: ["@Sendable f()"] }] }, // T-2 파일 상한 1 초과
    ], [
      { ruleId: "T-1", file: "SampleApp/Service/Filter/F.swift", note: "" },
      { ruleId: "T-1", file: "SampleApp/Service/New.swift", note: "" },
      { ruleId: "T-2", file: "Modules/X/A.swift", note: "" },
      { ruleId: "T-2", file: "Modules/X/B.swift", note: "" },
      { ruleId: "T-9", file: "SampleApp/Features/Home/Z.swift", note: "" }, // 바뀌지 않은 파일
    ]);
    const text = evaluation.violations.join("\n");
    expect(text).toContain("P.swift: 승인 범위 밖 변경인데 toleranceLedger 에 없습니다");
    expect(text).toContain("F.swift: 1개 hunk 가 규칙 T-1");
    expect(text).toContain("New.swift: 새 파일은 T-1");
    expect(text).toContain("규칙 T-2: 파일 2개 > 상한 1");
    expect(text).not.toContain("Z.swift");
    expect(evaluation.ledgerNotes.join("\n")).toContain("Z.swift 은 실제로 바뀌지 않았습니다");
  });

  // 2026-09-14 S11: 범위 안 파일·바뀌지 않은 파일의 원장 행은 판정에 영향이 없다 — 교정 재제출을 만들지 않고 메모로만 남긴다.
  it("범위 안 파일의 원장 행은 위반이 아니라 정리 메모다", () => {
    const policy = parseTolerancePolicy(policyBlock)!;
    const evaluation = evaluateTolerance(policy, [
      { file: "SampleApp/Features/Home/A.swift", untracked: false, binary: false, modeChanged: false, baseLines: [], hunks: [{ oldStart: 1, removed: [], added: ["let a = 1"] }] },
    ], [{ ruleId: "T-1", file: "SampleApp/Features/Home/A.swift", note: "범위 안인데 적었다" }]);
    expect(evaluation.violations).toEqual([]);
    expect(evaluation.ledgerNotes).toHaveLength(1);
    expect(evaluation.ledgerNotes[0]).toContain("승인 범위 안 파일");
    expect(renderToleranceSummary(evaluation)).toContain("허용 오차 대조 통과");
    expect(renderToleranceSummary(evaluation)).toContain("원장 정리 1건(위반 아님)");
  });
});

// 2026-09-08 Codex 후속 지적 3: 여러 줄 문자열·raw 문자열·주석은 줄 경계를 넘는다 — 기준 파일의 앞 줄로 상태를 재구성한다.
describe("Swift 어휘 문맥 — 여러 줄·raw 문자열·주석 안은 코드가 아니다", () => {
  const rule = { hunk: "insert-token" as const, tokens: ["nonisolated"] };

  it("lexLine 은 한 줄 문자열·raw 문자열·주석을 마스크에서 뺀다", () => {
    const plain = lexLine('  let s = "a \\" b"; func a() {}');
    expect(plain.mask.slice(0, 2)).toEqual([true, true]);
    expect(plain.mask[plain.mask.length - 1]).toBe(true);
    expect(plain.next).toEqual(LEX_START);
    const raw = lexLine('  let r = #"say " func a() {}"#; x');
    expect(raw.mask.filter(Boolean).length).toBe('  let r = ; x'.length);
    expect(raw.next.stack).toEqual([]);
    const comment = lexLine("  func a() {} // nonisolated 주석");
    expect(tokenSeen(comment.mask, "  func a() {} // nonisolated 주석", "nonisolated")).toBe(false);
  });

  it("\"\"\" 와 #\"\"\" 는 닫힐 때까지 다음 줄로 상태를 이어 가고 블록 주석도 같다", () => {
    const opened = lexLine('  let s = """').next;
    expect(opened.stack).toEqual([{ kind: "string", hashes: 0, multiline: true }]);
    const inside = lexLine("func a() {}", opened);
    expect(inside.mask.some(Boolean)).toBe(false);
    expect(lexLine('  """', opened).next.stack).toEqual([]);
    const rawOpened = lexLine('  let r = #"""').next;
    expect(rawOpened.stack).toEqual([{ kind: "string", hashes: 1, multiline: true }]);
    expect(lexLine('  """', rawOpened).next.stack).toEqual([{ kind: "string", hashes: 1, multiline: true }]); // # 없이는 안 닫힌다
    expect(lexLine('  """#', rawOpened).next.stack).toEqual([]);
    const block = lexLine("  /* 시작").next;
    expect(block.stack).toEqual([{ kind: "comment" }]);
    expect(lexLine("  func a() {}", block).mask.some(Boolean)).toBe(false);
    expect(lexLine("  끝 */ func b() {}", block).next.stack).toEqual([]);
  });

  it("여러 줄 문자열 안의 줄을 바꾸면 토큰 삽입이라도 거부한다(기준 파일 문맥으로 판정)", () => {
    const baseLines = ['let text = """', "func a() {}", '"""', "func b() {}"];
    const inside = stateAtLine(baseLines, 2);
    expect(inside.stack).toEqual([{ kind: "string", hashes: 0, multiline: true }]);
    expect(hunkSatisfies({ removed: ["func a() {}"], added: ["nonisolated func a() {}"] }, rule, inside)).toBe(false);
    // 같은 hunk 가 문자열 밖(4번째 줄)에 있으면 통과 — 문맥 없이(LEX_START) 판정하던 예전 동작도 이와 같다.
    expect(hunkSatisfies({ removed: ["func b() {}"], added: ["nonisolated func b() {}"] }, rule, stateAtLine(baseLines, 4))).toBe(true);
    expect(hunkSatisfies({ removed: ["func a() {}"], added: ["nonisolated func a() {}"] }, rule)).toBe(true);
  });

  it("raw 문자열 값 변경은 한 줄이어도 거부한다", () => {
    expect(hunkSatisfies({ removed: ['let r = #"say " func a() {}"#'], added: ['let r = #"say " nonisolated func a() {}"#'] }, rule)).toBe(false);
    expect(hunkSatisfies({ removed: ['let r = #"x"#; func a() {}'], added: ['let r = #"x"#; nonisolated func a() {}'] }, rule)).toBe(true);
  });

  it("evaluateTolerance 는 baseLines 로 hunk 의 문맥을 잡고, 기준 내용을 못 읽으면(null) 위반이다", () => {
    const policy = parseTolerancePolicy(policyBlock)!;
    const ledger = [{ ruleId: "T-1", file: "SampleApp/Service/A.swift", note: "표기" }];
    const patch = "@@ -2,1 +2,1 @@\n-func a() {}\n+nonisolated func a() {}\n";
    const { hunks } = parseUnifiedDiff(patch);
    expect(hunks[0].oldStart).toBe(2);
    const insideString = evaluateTolerance(policy, [{
      file: "SampleApp/Service/A.swift", untracked: false, hunks, baseLines: ['let text = """', "func a() {}", '"""'],
    }], ledger);
    expect(insideString.violations.join("\n")).toContain("술어를 만족하지 않습니다");
    const outsideString = evaluateTolerance(policy, [{
      file: "SampleApp/Service/A.swift", untracked: false, hunks, baseLines: ["import Foundation", "func a() {}", ""],
    }], ledger);
    expect(outsideString.violations).toEqual([]);
    const unreadable = evaluateTolerance(policy, [{ file: "SampleApp/Service/A.swift", untracked: false, hunks, baseLines: null }], ledger);
    expect(unreadable.violations.join("\n")).toContain("문맥을 증명할 수 없습니다");
  });
});

function tokenSeen(mask: boolean[], line: string, token: string): boolean {
  const index = line.indexOf(token);
  return index >= 0 && mask[index];
}

// 2026-09-08 Codex 재리뷰 1: 보간식 \( … ) 안의 중첩 문자열.
describe("Swift 문자열 보간 — 보간식 안은 값이다", () => {
  const rule = { hunk: "insert-token" as const, tokens: ["nonisolated"] };

  it("보간식 안 중첩 문자열의 값 변경은 표기 삽입으로 인정하지 않는다", () => {
    const before = 'let text = "\\(String("func a() {}"))"';
    const after = 'let text = "\\(String("nonisolated func a() {}"))"';
    expect(hunkSatisfies({ removed: [before], added: [after] }, rule)).toBe(false);
    // 보간식이 끝난 뒤의 코드는 여전히 표기 가능하다.
    expect(hunkSatisfies({ removed: ['let t = "\\(x)"; func a() {}'], added: ['let t = "\\(x)"; nonisolated func a() {}'] }, rule)).toBe(true);
    const lexed = lexLine('let t = "\\(f("(", ")"))" + g()');
    expect(lexed.next.stack).toEqual([]);
    expect(lexed.mask.slice(-5).every(Boolean)).toBe(true); // ` g()` 는 코드
  });

  it("raw 문자열의 보간은 \\#( 이고, 여러 줄 문자열의 보간식은 줄을 넘어 이어진다", () => {
    const raw = lexLine('let r = #"a \\#(String("x")) b"#; func a() {}');
    expect(raw.next.stack).toEqual([]);
    expect(tokenSeen(raw.mask, 'let r = #"a \\#(String("x")) b"#; func a() {}', "func")).toBe(true);
    const opened = lexLine('let m = """').next;
    const midInterpolation = lexLine('  \\(String(', opened).next;
    expect(midInterpolation.stack).toEqual([{ kind: "string", hashes: 0, multiline: true }, { kind: "interpolation", depth: 2 }]);
    const closed = lexLine('  "y"))', midInterpolation).next;
    expect(closed.stack).toEqual([{ kind: "string", hashes: 0, multiline: true }]);
    expect(lexLine('"""', closed).next.stack).toEqual([]);
  });
});

// 2026-09-13 S10H: invariants 300자 초과가 plain Error 라 xhigh 교정으로 갔다 — 형식 오류는 전용 타입으로 구분한다.
describe("허용 오차 블록 형식 오류는 ToleranceFormatError 다", () => {
  it("설명은 길어도 보존하고 기계 규칙과 JSON 오류는 거부한다", () => {
    const long = "가".repeat(301);
    const schemaBad = "## 허용 오차\n```tolerance\n" + JSON.stringify({ scopePaths: ["a/**"], rules: [{ id: "T-1", title: "t", paths: ["a/**"], hunk: "any", maxFiles: 1, maxHunks: 1, invariants: [long] }] }) + "\n```\n";
    expect(parseTolerancePolicy(schemaBad)?.rules[0].invariants).toEqual([long]);
    expect(() => parseTolerancePolicy(schemaBad.replace('"maxFiles":1', '"maxFiles":-1'))).toThrow(ToleranceFormatError);
    expect(() => parseTolerancePolicy("## 허용 오차\n```tolerance\n{not json\n```\n")).toThrow(ToleranceFormatError);
  });
});

// 2026-09-13 S11: 문자열 리터럴 안의 탭·줄바꿈으로 개정 턴 2개가 소각됐다 — 문자열 안 제어 문자만 공백으로 흡수한다.
describe("허용 오차 블록의 문자열 안 제어 문자", () => {
  it("문자열 안의 탭·줄바꿈은 공백이 되고, 구조 공백·이스케이프·값은 그대로다", () => {
    const raw = '{\n  "scopePaths": ["a/**"],\n  "rules": [{"id": "T-1", "title": "탭\t있음\n줄바꿈", "paths": ["a/**"], "hunk": "any", "maxFiles": 1, "maxHunks": 1, "invariants": ["이스케이프 \\n 유지"]}]\n}';
    const cleaned = sanitizeJSONControlCharacters(raw);
    expect(cleaned).toContain('"title": "탭 있음 줄바꿈"');
    expect(cleaned).toContain("\\n 유지");
    expect(cleaned.startsWith("{\n  ")).toBe(true);
    const policy = parseTolerancePolicy("## 허용 오차\n```tolerance\n" + raw + "\n```\n");
    expect(policy?.rules[0]?.title).toBe("탭 있음 줄바꿈");
    expect(policy?.rules[0]?.invariants[0]).toBe("이스케이프 \n 유지"); // JSON 이스케이프 \n 은 실제 줄바꿈으로 남는다
  });
});

 it("긴 제목과 마지막 쉼표를 허용하고 문자열 안 쉼표는 보존한다", () => {
   const title = "설명,}".repeat(100);
   const raw = JSON.stringify({scopePaths:["a/**"],rules:[{id:"T-1",title,paths:["b/**"],hunk:"any",maxFiles:1,maxHunks:1}]}).replace(/}$/, ",}");
   expect(parseTolerancePolicy("```tolerance\n" + raw + "\n```")?.rules[0].title).toBe(title);
 });

it("기존 계획 해시 규칙은 보존하고 새 본문만 정규화한다", async () => {
  const { hashPlan } = await import("../src/shared/workflow");
  const { createHash } = await import("node:crypto");
  const old = '```tolerance\n{"scopePaths":["a/**"],"rules":[],}\n```\n';
  expect(hashPlan(old)).toBe(createHash("sha256").update(old).digest("hex"));
  expect(normalizeToleranceBlocks(old)).toBe(old.replace("[],}","[]}"));
});

// 2026-09-14 S11: 앞 턴에 T-5 로 받아들인 6개 파일을 러너가 다음 턴 원장에서 빼먹어 교정 턴 1회($0.38)를 샀다 —
// 승인된 원장은 엔진이 승계한다. 술어·상한 판정은 승계된 원장으로 evaluateTolerance 가 다시 한다.
describe("carryForwardLedger — 앞 턴에서 받아들인 원장 행 승계", () => {
  const previous = [
    { ruleId: "T-5", file: "Tests/A.swift", note: "클래스 @MainActor" },
    { ruleId: "T-5", file: "Tests/B.swift", note: "클래스 @MainActor" },
    { ruleId: "T-1", file: "service/S.swift", note: "nonisolated" },
  ];
  it("여전히 범위 밖으로 바뀐 채이고 이번 원장에 없는 파일만 승계하고, 승계 표식을 note 에 붙인다", () => {
    const { ledger, carried } = carryForwardLedger(previous, [{ ruleId: "T-5", file: "Tests/A.swift", note: "다시 적음" }], ["Tests/A.swift", "Tests/B.swift"]);
    expect(carried).toEqual(["Tests/B.swift"]);
    expect(ledger).toEqual([
      { ruleId: "T-5", file: "Tests/A.swift", note: "다시 적음" },
      { ruleId: "T-5", file: "Tests/B.swift", note: `${CARRIED_LEDGER_NOTE_PREFIX}클래스 @MainActor` },
    ]);
  });
  it("되돌려져 더는 바뀌지 않은 파일은 승계하지 않는다(원장은 실제 변경만 적는다)", () => {
    const { ledger, carried } = carryForwardLedger(previous, [], ["Tests/A.swift"]);
    expect(carried).toEqual(["Tests/A.swift"]);
    expect(ledger.map((entry) => entry.file)).toEqual(["Tests/A.swift"]);
  });
  it("승계된 행도 술어 판정을 받는다 — 같은 파일이 규칙 밖 모양으로 바뀌었으면 위반이다", () => {
    const policy = parseTolerancePolicy(`## 허용 오차\n\`\`\`tolerance\n${JSON.stringify({ scopePaths: ["app/**"], rules: [{ id: "T-1", title: "표기", paths: ["service/**"], hunk: "insert-token", tokens: ["nonisolated"], maxFiles: 2, maxHunks: 4, invariants: ["x"] }] })}\n\`\`\`\n`)!;
    const parsed = parseUnifiedDiff("diff --git a/service/S.swift b/service/S.swift\n--- a/service/S.swift\n+++ b/service/S.swift\n@@ -1,1 +1,1 @@\n-func a() {}\n+func renamed() {}\n");
    const changed = [{ file: "service/S.swift", untracked: false, binary: parsed.binary, modeChanged: parsed.modeChanged, hunks: parsed.hunks, baseLines: ["func a() {}"] }];
    const carried = carryForwardLedger(previous, [], changed.map((item) => item.file));
    expect(carried.carried).toEqual(["service/S.swift"]);
    const evaluation = evaluateTolerance(policy, changed, carried.ledger);
    expect(evaluation.violations.join("\n")).toContain("술어를 만족하지 않습니다");
  });
  it("승계 표식은 중첩되지 않고 같은 규칙·파일 중복은 한 번만 승계한다", () => {
    const twice = [{ ruleId: "T-1", file: "s/X.swift", note: `${CARRIED_LEDGER_NOTE_PREFIX}원래` }, { ruleId: "T-1", file: "s/X.swift", note: "원래" }];
    const { ledger } = carryForwardLedger(twice, [], ["s/X.swift"]);
    expect(ledger).toEqual([{ ruleId: "T-1", file: "s/X.swift", note: `${CARRIED_LEDGER_NOTE_PREFIX}원래` }]);
  });
});

// 2026-09-14 Codex 감사 R06: 누적 원장은 모델 한 번 응답 상한이 아니라 저장 계약이다 — 501행도 다시 읽힌다.
describe("누적 원장 저장 계약", () => {
  it("승계로 501행이 된 원장은 결과 스키마로 다시 읽힌다", async () => {
    const { AgentResultSchema } = await import("../src/shared/contracts");
    const old = Array.from({ length: 500 }, (_, i) => ({ ruleId: "T-1", file: `service/${i}.swift`, note: "approved" }));
    const current = [{ ruleId: "T-1", file: "service/new.swift", note: "current" }];
    const carried = carryForwardLedger(old, current, [...old, ...current].map((entry) => entry.file));
    expect(carried.ledger).toHaveLength(501);
    expect(AgentResultSchema.safeParse({ kind: "IMPLEMENTATION", summary: "s", findings: [], evidenceRefs: [], toleranceLedger: carried.ledger }).success).toBe(true);
  });
});
