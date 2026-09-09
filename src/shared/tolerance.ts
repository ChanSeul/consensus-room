import { z } from "zod";

// 허용 오차(tolerance) — 승인 범위 밖 변경을 "파일 단위 결정" 대신 "부류 규칙 + 기계 술어 + 원장" 으로 허용한다.
// 2026-09-08 사용자 요청: 러너가 구현 중 만나는 범위 밖 요구(다른 단계 소유 파일의 표기 한 줄 등)마다 멈추면
// 정지 1회에 15~25분이 들고, 미리 구현하면 리뷰가 되돌리게 한다. 계획이 규칙(id·경로·hunk 술어·상한)을 선언하면
// 러너는 술어를 만족하는 변경을 구현하고 toleranceLedger 에 규칙 id 로 적는다. 엔진은 리뷰 전에 git diff 로
// 범위 밖 hunk 를 규칙과 대조한다 — 추적 사슬은 "계획 승인 → 규칙 id → 원장 행 → hunk" 다.
//
// 계획의 `## 허용 오차` 절 안 fenced 블록 형식:
// ```tolerance
// {"scopePaths":["SampleApp/Features/**"],
//  "rules":[{"id":"T-1","title":"다른 단계 소유 앱 파일의 nonisolated 표기","paths":["SampleApp/Service/**"],
//            "hunk":"insert-token","tokens":["nonisolated"],"maxFiles":5,"maxHunks":20,
//            "invariants":["같은 콜드 로그에서 SampleApp/Service/** 진단 0 유지"]}]}
// ```
// 규칙이 없는 단계는 `{"scopePaths":[…],"rules":[]}` 로 쓴다 — 그러면 범위 밖 변경은 전부 위반이다.

export const TOLERANCE_HUNK_KINDS = ["insert-token", "annotation-only", "any"] as const;
export const ToleranceHunkKindSchema = z.enum(TOLERANCE_HUNK_KINDS);
export type ToleranceHunkKind = z.infer<typeof ToleranceHunkKindSchema>;

export const ToleranceRuleSchema = z.object({
  id: z.string().regex(/^T-\d{1,3}$/, "규칙 id 는 T-1, T-2 … 형식"),
  title: z.string().trim().min(1).max(200),
  // 이 규칙이 적용되는 파일 glob(승인 범위 밖 영역). `**`·`*`·`?` 를 지원한다.
  paths: z.array(z.string().trim().min(1)).min(1).max(50),
  // insert-token: 삭제줄→추가줄이 tokens 중 하나의 삽입만으로 다르다(표기 추가만).
  // annotation-only: 양쪽에서 tokens 를 지운 뒤 같다(표기 추가·삭제·교체).
  // any: hunk 내용을 보지 않는다(상한만).
  hunk: ToleranceHunkKindSchema,
  tokens: z.array(z.string().trim().min(1).max(80)).max(20).default([]),
  maxFiles: z.number().int().min(0).max(1000),
  maxHunks: z.number().int().min(0).max(10000),
  // 사람이 읽는 불변식(도구가 따로 검사하는 조건의 이름). 엔진은 기록만 한다.
  invariants: z.array(z.string().trim().min(1).max(300)).max(20).default([]),
}).superRefine((rule, context) => {
  if (rule.hunk !== "any" && rule.tokens.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${rule.id}: ${rule.hunk} 규칙은 tokens 가 필요합니다.` });
  }
});
export type ToleranceRule = z.infer<typeof ToleranceRuleSchema>;

export const TolerancePolicySchema = z.object({
  scopePaths: z.array(z.string().trim().min(1)).min(1).max(200),
  rules: z.array(ToleranceRuleSchema).max(50),
}).superRefine((policy, context) => {
  const seen = new Set<string>();
  for (const rule of policy.rules) {
    if (seen.has(rule.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: `규칙 id 중복: ${rule.id}` });
    seen.add(rule.id);
  }
});
export type TolerancePolicy = z.infer<typeof TolerancePolicySchema>;

export const ToleranceLedgerEntrySchema = z.object({
  ruleId: z.string().trim().min(1).max(20),
  file: z.string().trim().min(1).max(500),
  note: z.string().max(2000).default(""),
});
export type ToleranceLedgerEntry = z.infer<typeof ToleranceLedgerEntrySchema>;

const TOLERANCE_FENCE = /```tolerance[^\n]*\n([\s\S]*?)\n```/;

// 계획 본문에서 tolerance 블록을 꺼낸다. 블록이 없으면 null(정책 없음 — 엔진 대조 생략, 승계 계획 호환).
// 블록이 있는데 형식이 틀리면 던진다 — 계획 계약 검사에서 잡혀 그 계획은 저장되지 않는다.
export function parseTolerancePolicy(planMarkdown: string): TolerancePolicy | null {
  const match = TOLERANCE_FENCE.exec(planMarkdown);
  if (!match) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(match[1]);
  } catch (error) {
    throw new Error(`허용 오차 블록이 JSON 이 아닙니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = TolerancePolicySchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`허용 오차 블록 형식 오류: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown"}`);
  }
  return parsed.data;
}

export function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index];
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` 는 0개 이상의 디렉터리, 끝의 `**` 는 나머지 전부.
        if (glob[index + 2] === "/") { pattern += "(?:.*/)?"; index += 2; } else { pattern += ".*"; index += 1; }
      } else {
        pattern += "[^/]*";
      }
    } else if (char === "?") {
      pattern += "[^/]";
    } else {
      pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${pattern}$`);
}

export function matchesAny(path: string, globs: readonly string[]): boolean {
  return globs.some((glob) => globToRegExp(glob).test(path));
}

export interface DiffHunk {
  removed: string[];
  added: string[];
  // `@@ -a,b +c,d @@` 의 a — 삭제줄이 기준 파일에서 시작하는 줄 번호(1부터). 문자열·주석 문맥을 기준 파일에서 재구성할 때 쓴다.
  // parseUnifiedDiff 는 항상 채운다. 없으면(단위 테스트가 손으로 만든 hunk) 1로 본다.
  oldStart?: number;
}

export interface ParsedDiff {
  hunks: DiffHunk[];
  // `Binary files … differ` / `GIT binary patch` — 텍스트 hunk 가 없어도 내용이 바뀐 것이다.
  binary: boolean;
  // `old mode`/`new mode` — 실행 권한 등 모드 변경.
  modeChanged: boolean;
}

// `git diff -U0` 한 파일분 패치를 hunk 목록으로 만든다. 문맥 줄이 없으므로 -/+ 줄만 모으면 된다.
// 바이너리·모드 변경은 hunk 가 없어도 "변경 없음" 이 아니다(2026-09-08 Codex 지적 5).
export function parseUnifiedDiff(patch: string): ParsedDiff {
  const hunks: DiffHunk[] = [];
  let current: DiffHunk | null = null;
  let binary = false;
  let modeChanged = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) { binary = true; continue; }
    if (line.startsWith("old mode ") || line.startsWith("new mode ")) { modeChanged = true; continue; }
    if (line.startsWith("@@")) {
      const header = /^@@ -(\d+)(?:,\d+)? \+\d+(?:,\d+)? @@/.exec(line);
      current = { removed: [], added: [], oldStart: header ? Number(header[1]) : 1 };
      hunks.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("---") || line.startsWith("+++")) continue;
    if (line.startsWith("-")) current.removed.push(line.slice(1));
    else if (line.startsWith("+")) current.added.push(line.slice(1));
  }
  return { hunks, binary, modeChanged };
}

// Swift 어휘 문맥 — 문자열 리터럴과 주석 **밖** 위치만 코드다. 문자열 안의 토큰은 표기가 아니라 값이고(2026-09-08 Codex 지적 4),
// 여러 줄 문자열("""…""")·raw 문자열(#"…"#, #"""…"""#)·블록 주석은 줄 경계를 넘으므로 줄마다 상태를 초기화하면 놓친다
// (2026-09-08 Codex 후속 지적 3: 실제 Swift 로 값이 달라짐을 확인). 상태는 기준 파일의 앞 줄들을 훑어 재구성한다(stateAtLine).
// 어휘 상태는 **프레임 스택**이다 — 문자열 안의 보간식 \( … ) 은 코드 문맥이고 그 안에 다시 문자열이 올 수 있다
// (2026-09-08 Codex 재리뷰 1: `"\(String("func a() {}"))"` 의 안쪽 따옴표를 바깥 문자열의 닫힘으로 읽어 값 변경이 표기로 통과).
// 보간식 안은 코드지만 그 결과가 문자열 값이므로 마스크는 false 다 — 보간식 어디를 바꿔도 표기가 아니라 값 변경이다.
export type LexFrame =
  | { kind: "string"; hashes: number; multiline: boolean }
  // 바로 아래 문자열 프레임의 보간식. depth = 열린 괄호 수(0 이 되면 닫힘).
  | { kind: "interpolation"; depth: number }
  // 블록 주석 한 겹(Swift 는 중첩 허용 — 겹마다 프레임 하나).
  | { kind: "comment" };

export interface LexState { stack: readonly LexFrame[] }

export const LEX_START: LexState = { stack: [] };

function hashRun(line: string, index: number): number {
  let count = 0;
  while (line[index + count] === "#") count += 1;
  return count;
}

// index 에서 문자열 리터럴이 시작하면 그 프레임과 여는 길이를 돌려준다(`"`, `"""`, `#"`, `#"""` …).
function stringOpener(line: string, index: number): { frame: LexFrame; length: number } | null {
  const hashes = line[index] === "#" ? hashRun(line, index) : 0;
  const quoteAt = index + hashes;
  if (line[quoteAt] !== '"') return null;
  const multiline = line.startsWith('"""', quoteAt);
  return { frame: { kind: "string", hashes, multiline }, length: hashes + (multiline ? 3 : 1) };
}

// 줄 끝: 닫히지 않은 한 줄 문자열(과 그 보간식)은 Swift 오류다 — 다음 줄을 오염시키지 않도록 닫힌 것으로 본다. 여러 줄 문자열과 주석은 이어진다.
function closeUnterminated(stack: LexFrame[]): void {
  for (;;) {
    const top = stack[stack.length - 1];
    if (!top || top.kind === "comment") return;
    if (top.kind === "string") {
      if (top.multiline) return;
      stack.pop();
      continue;
    }
    const owner = [...stack].reverse().find((frame): frame is Extract<LexFrame, { kind: "string" }> => frame.kind === "string");
    if (!owner || owner.multiline) return;
    stack.pop();
  }
}

// 한 줄을 훑어 코드 위치 마스크(true = 문자열·보간식·주석 밖)와 줄 끝 상태를 돌려준다.
export function lexLine(line: string, start: LexState = LEX_START): { mask: boolean[]; next: LexState } {
  const mask: boolean[] = new Array(line.length).fill(false);
  const stack: LexFrame[] = start.stack.map((frame) => ({ ...frame }));
  let index = 0;
  while (index < line.length) {
    const top = stack[stack.length - 1];
    if (top?.kind === "string") {
      const hashes = "#".repeat(top.hashes);
      const interpolation = `\\${hashes}(`;
      const escape = `\\${hashes}`;
      const closer = (top.multiline ? '"""' : '"') + hashes;
      if (line.startsWith(interpolation, index)) { stack.push({ kind: "interpolation", depth: 1 }); index += interpolation.length; continue; }
      if (line.startsWith(escape, index)) { index += escape.length + 1; continue; }
      if (line.startsWith(closer, index)) { stack.pop(); index += closer.length; continue; }
      index += 1;
      continue;
    }
    if (top?.kind === "comment") {
      if (line.startsWith("/*", index)) { stack.push({ kind: "comment" }); index += 2; continue; }
      if (line.startsWith("*/", index)) { stack.pop(); index += 2; continue; }
      index += 1;
      continue;
    }
    // 코드 문맥(최상위 또는 보간식 안): 주석·문자열 시작을 인식하고, 보간식은 괄호 깊이로 닫는다.
    if (line.startsWith("//", index)) break;
    if (line.startsWith("/*", index)) { stack.push({ kind: "comment" }); index += 2; continue; }
    const opener = stringOpener(line, index);
    if (opener) { stack.push(opener.frame); index += opener.length; continue; }
    if (top?.kind === "interpolation") {
      if (line[index] === "(") top.depth += 1;
      else if (line[index] === ")") {
        top.depth -= 1;
        if (top.depth === 0) stack.pop();
      }
      index += 1;
      continue;
    }
    mask[index] = true;
    index += 1;
  }
  closeUnterminated(stack);
  return { mask, next: { stack } };
}

// 기준 파일에서 lineNumber(1부터) 줄이 시작할 때의 어휘 상태.
export function stateAtLine(lines: readonly string[], lineNumber: number): LexState {
  let state = LEX_START;
  for (let index = 0; index < Math.min(lines.length, Math.max(0, lineNumber - 1)); index += 1) state = lexLine(lines[index], state).next;
  return state;
}

const WORD = /[A-Za-z0-9_@]/;

// 줄 안에서 토큰이 단어 경계로 나타나는(문자열·주석 밖) 시작 위치들. state 는 이 줄이 시작할 때의 어휘 상태.
function tokenOccurrences(line: string, token: string, state: LexState = LEX_START): number[] {
  const mask = lexLine(line, state).mask;
  const positions: number[] = [];
  let from = 0;
  for (;;) {
    const index = line.indexOf(token, from);
    if (index < 0) break;
    from = index + 1;
    if (!mask[index]) continue;
    const before = index > 0 ? line[index - 1] : "";
    const after = index + token.length < line.length ? line[index + token.length] : "";
    if ((before && WORD.test(before)) || (after && /[A-Za-z0-9_]/.test(after))) continue;
    positions.push(index);
  }
  return positions;
}

// 토큰 하나와 인접 공백 하나를 지운다(뒤 공백 우선, 없으면 앞 공백). 공백 정규화는 하지 않는다 — 정확히 삽입만 허용.
function removeTokenAt(line: string, index: number, token: string): string {
  const end = index + token.length;
  if (line[end] === " ") return line.slice(0, index) + line.slice(end + 1);
  if (index > 0 && line[index - 1] === " ") return line.slice(0, index - 1) + line.slice(end);
  return line.slice(0, index) + line.slice(end);
}

function stripAllTokens(line: string, tokens: readonly string[], state: LexState = LEX_START): string {
  let result = line;
  for (let guard = 0; guard < 100; guard += 1) {
    let changed = false;
    for (const token of tokens) {
      const positions = tokenOccurrences(result, token, state);
      if (positions.length === 0) continue;
      result = removeTokenAt(result, positions[0], token);
      changed = true;
      break;
    }
    if (!changed) break;
  }
  return result;
}

// startState: hunk 첫 줄이 시작할 때의 어휘 상태(기준 파일에서 재구성). 삭제줄·추가줄은 각자 순서대로 상태를 이어 간다 —
// 여러 줄 문자열 안에서 시작하는 hunk 는 마스크가 전부 false 라 어떤 토큰 삽입도 표기로 인정되지 않는다.
export function hunkSatisfies(
  hunk: Pick<DiffHunk, "removed" | "added">,
  rule: Pick<ToleranceRule, "hunk" | "tokens">,
  startState: LexState = LEX_START,
): boolean {
  if (rule.hunk === "any") return true;
  if (hunk.removed.length !== hunk.added.length || hunk.removed.length === 0) return false;
  let oldState = startState;
  let newState = startState;
  for (let index = 0; index < hunk.removed.length; index += 1) {
    const before = hunk.removed[index];
    const after = hunk.added[index];
    if (before === after) return false;
    if (rule.hunk === "insert-token") {
      // 추가줄에서 토큰 하나(+인접 공백 하나)를 지우면 삭제줄과 **정확히** 같아야 한다 — 다른 글자 하나라도 바뀌면 거부.
      const ok = rule.tokens.some((token) =>
        tokenOccurrences(after, token, newState).some((position) => removeTokenAt(after, position, token) === before));
      if (!ok) return false;
    } else if (stripAllTokens(after, rule.tokens, newState) !== stripAllTokens(before, rule.tokens, oldState)) {
      return false;
    }
    oldState = lexLine(before, oldState).next;
    newState = lexLine(after, newState).next;
  }
  return true;
}

export interface ChangedFile {
  file: string;
  // untracked(새 파일)이면 hunk 를 만들 수 없다 — `any` 규칙만 통과한다.
  untracked: boolean;
  hunks: DiffHunk[];
  binary?: boolean;
  modeChanged?: boolean;
  // 기준 커밋의 파일 내용(줄 배열). hunk 의 문자열·주석 문맥을 재구성하는 근거다. null = 읽지 못함(문맥을 증명할 수 없어
  // any 가 아닌 규칙은 위반), undefined = 문맥 없이 판정(단위 테스트 전용 — 엔진은 항상 채운다).
  baseLines?: readonly string[] | null;
}

export interface ToleranceEvaluation {
  violations: string[];
  outOfScopeFiles: string[];
  usage: Record<string, { files: string[]; hunks: number }>;
}

// 규칙 대조. 범위 안 파일은 보지 않는다. 범위 밖 파일마다 원장 행이 있어야 하고, 그 규칙의 경로·술어·상한을 만족해야 한다.
export function evaluateTolerance(
  policy: TolerancePolicy,
  changed: readonly ChangedFile[],
  ledger: readonly ToleranceLedgerEntry[],
): ToleranceEvaluation {
  const violations: string[] = [];
  const usage: Record<string, { files: string[]; hunks: number }> = {};
  const rules = new Map(policy.rules.map((rule) => [rule.id, rule]));
  const ledgerByFile = new Map<string, ToleranceLedgerEntry[]>();
  for (const entry of ledger) {
    const list = ledgerByFile.get(entry.file) ?? [];
    list.push(entry);
    ledgerByFile.set(entry.file, list);
  }
  const outOfScope = changed.filter((item) => !matchesAny(item.file, policy.scopePaths));
  for (const item of outOfScope) {
    const entries = ledgerByFile.get(item.file) ?? [];
    if (entries.length === 0) {
      violations.push(`${item.file}: 승인 범위 밖 변경인데 toleranceLedger 에 없습니다(되돌리거나 to-do 로 옮기세요).`);
      continue;
    }
    for (const entry of entries) {
      const rule = rules.get(entry.ruleId);
      if (!rule) { violations.push(`${item.file}: 원장의 규칙 ${entry.ruleId} 가 계획에 없습니다.`); continue; }
      if (!matchesAny(item.file, rule.paths)) { violations.push(`${item.file}: 규칙 ${rule.id} 의 경로(${rule.paths.join(", ")}) 밖입니다.`); continue; }
      if (item.untracked && rule.hunk !== "any") { violations.push(`${item.file}: 새 파일은 ${rule.id}(${rule.hunk}) 로 허용되지 않습니다.`); continue; }
      if (rule.hunk !== "any") {
        if (item.binary) { violations.push(`${item.file}: 바이너리 변경은 ${rule.id}(${rule.hunk}) 로 허용되지 않습니다.`); continue; }
        if (item.modeChanged) { violations.push(`${item.file}: 파일 모드(실행 권한) 변경은 ${rule.id}(${rule.hunk}) 로 허용되지 않습니다.`); continue; }
        if (item.baseLines === null) {
          violations.push(`${item.file}: 기준 커밋의 파일 내용을 읽지 못해 문자열·주석 문맥을 증명할 수 없습니다 — ${rule.id}(${rule.hunk}) 로 허용되지 않습니다.`);
          continue;
        }
        if (!item.untracked && item.hunks.length === 0) { violations.push(`${item.file}: 텍스트 변경 구간을 찾지 못해 ${rule.id}(${rule.hunk}) 술어를 판정할 수 없습니다(삭제·필터·속성 변경?).`); continue; }
      }
      const bad = item.hunks.filter((hunk) => !hunkSatisfies(hunk, rule, item.baseLines ? stateAtLine(item.baseLines, hunk.oldStart ?? 1) : LEX_START));
      if (bad.length > 0) {
        const sample = bad[0];
        violations.push(`${item.file}: ${bad.length}개 hunk 가 규칙 ${rule.id}(${rule.hunk}${rule.tokens.length ? `: ${rule.tokens.join("|")}` : ""}) 술어를 만족하지 않습니다 — 예: -${(sample.removed[0] ?? "").trim().slice(0, 80)} / +${(sample.added[0] ?? "").trim().slice(0, 80)}`);
        continue;
      }
      const used = usage[rule.id] ?? { files: [], hunks: 0 };
      if (!used.files.includes(item.file)) used.files.push(item.file);
      used.hunks += item.untracked ? 1 : item.hunks.length;
      usage[rule.id] = used;
    }
  }
  for (const entry of ledger) {
    if (!changed.some((item) => item.file === entry.file)) {
      violations.push(`원장의 ${entry.file} 은 실제로 바뀌지 않았습니다(원장은 실제 변경만 적습니다).`);
    } else if (matchesAny(entry.file, policy.scopePaths)) {
      violations.push(`원장의 ${entry.file} 은 승인 범위 안 파일이라 원장에 적지 않습니다.`);
    }
  }
  for (const [ruleId, used] of Object.entries(usage)) {
    const rule = rules.get(ruleId)!;
    if (used.files.length > rule.maxFiles) violations.push(`규칙 ${ruleId}: 파일 ${used.files.length}개 > 상한 ${rule.maxFiles}`);
    if (used.hunks > rule.maxHunks) violations.push(`규칙 ${ruleId}: hunk ${used.hunks}개 > 상한 ${rule.maxHunks}`);
  }
  return { violations, outOfScopeFiles: outOfScope.map((item) => item.file), usage };
}

export function renderToleranceSummary(evaluation: ToleranceEvaluation): string {
  const usage = Object.entries(evaluation.usage)
    .map(([ruleId, used]) => `${ruleId}: 파일 ${used.files.length}·hunk ${used.hunks}`)
    .join(", ");
  return evaluation.violations.length === 0
    ? `허용 오차 대조 통과 — 범위 밖 파일 ${evaluation.outOfScopeFiles.length}개${usage ? ` (${usage})` : ""}`
    : `허용 오차 위반 ${evaluation.violations.length}건:\n${evaluation.violations.map((line) => `- ${line}`).join("\n")}`;
}
