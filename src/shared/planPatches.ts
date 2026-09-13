import { PlanLineEditsSchema, PlanRepairSchema, type AgentResult, type PlanLineEdits, type PlanRepair } from "./contracts";
import { applyPlanEdits, hashPlan, normalizePlan } from "./workflow";
import { TolerancePolicySchema, sanitizeJSONControlCharacters, parseTolerancePolicy } from "./tolerance";

export function numberedPlan(plan: string): string {
  const text = normalizePlan(plan);
  return `기준 SHA-256: ${hashPlan(text)}\n${text.slice(0, -1).split("\n").map((line, index) => `${index + 1} | ${line}`).join("\n")}`;
}

export function applyPlanLineEdits(base: string, input: PlanLineEdits): string {
  const patch = PlanLineEditsSchema.parse(input);
  const normalized = normalizePlan(base);
  if (patch.baseSHA256 !== hashPlan(normalized)) throw new Error("계획 패치 기준 SHA가 다릅니다.");
  const lines = normalized.slice(0, -1).split("\n");
  const edits = [...patch.edits].sort((a, b) => a.startLine - b.startLine || a.endLineExclusive - b.endLineExclusive);
  for (const [index, edit] of edits.entries()) {
    if (edit.endLineExclusive < edit.startLine || edit.endLineExclusive > lines.length + 1) throw new Error("계획 패치 줄 범위가 잘못됐습니다.");
    if (edit.replacement && edit.endLineExclusive <= lines.length && !edit.replacement.endsWith("\n")) throw new Error("대체 줄 끝에 줄바꿈이 필요합니다.");
    const previous = edits[index - 1];
    if (previous && (previous.endLineExclusive > edit.startLine || previous.startLine === edit.startLine)) throw new Error("계획 패치 범위가 겹칩니다.");
  }
  let text = normalized;
  const offsets = [0];
  for (const line of lines) offsets.push(offsets.at(-1)! + line.length + 1);
  for (const edit of edits.reverse()) {
    text = text.slice(0, offsets[edit.startLine - 1]) + edit.replacement.replace(/\r\n/g, "\n") + text.slice(offsets[edit.endLineExclusive - 1]);
  }
  return normalizePlan(text);
}

// Only one fenced policy block can be repaired. A second fence or an ambiguous boundary is not guessed.
function toleranceBlock(plan: string): { start: number; end: number; text: string } | null {
  const matches = [...plan.matchAll(/^```tolerance[^\S\r\n]*\r?\n([\s\S]*?)^```[^\S\r\n]*$/gm)];
  if (matches.length !== 1) return null;
  const match = matches[0];
  const start = match.index! + match[0].indexOf("\n") + 1;
  return { start, end: start + match[1].length, text: match[1] };
}

export function repairablePlan(result: AgentResult, base?: string): string | null {
  if (result.kind !== "PLAN" && result.kind !== "REVISION") return null;
  let text: string;
  try {
    if (result.planLineEdits && base !== undefined) text = applyPlanLineEdits(base, result.planLineEdits);
    else if (result.planEdits && base !== undefined) text = applyPlanEdits(base, result.planEdits);
    else if (result.planMarkdown && !result.planEdits && !result.planLineEdits) text = result.planMarkdown;
    else return null;
  } catch { return null; }
  text = normalizePlan(text);
  const block = toleranceBlock(text);
  if (!block) return null;
  try { return TolerancePolicySchema.safeParse(parseRepairBaseline(block.text)).success ? text : null; } catch { return null; }
}

export function planRepairPrompt(plan: string, violation: string): string {
  const block = toleranceBlock(plan);
  if (!block) throw new Error("교정할 허용 오차 블록을 특정할 수 없습니다.");
  return `직전 계획의 허용 오차 JSON 형식만 교정하세요. 도구를 호출하거나 파일을 수정하지 마세요.
거부 사유: ${violation}
기준 SHA-256: ${hashPlan(plan)}
수정 가능한 블록 내용:
${block.text}
PlanRepair {baseSHA256, edits:[{find,replace}]}만 반환하세요. 각 find는 위 블록에서 순서대로 정확히 한 번 일치해야 합니다.
계획 전문과 이미 제출한 쟁점·근거는 서버가 보존합니다. 불변 조건의 의미, 승인 범위, 허용 상한, 금지 조건을 완화하지 마세요.
길이 제한은 의미를 유지해 표현을 다듬되 자동 잘라내기로 맞추지 마세요. 변경할 필요 없는 내용은 다시 출력하지 마세요.`;
}

export function applyPlanRepair(plan: string, input: PlanRepair): string {
  const patch = PlanRepairSchema.parse(input);
  if (patch.baseSHA256 !== hashPlan(plan)) throw new Error("교정 기준 SHA가 다릅니다.");
  const block = toleranceBlock(plan);
  if (!block) throw new Error("교정할 블록이 모호합니다.");
  const fixed = applyPlanEdits(block.text, patch.edits);
  // A model may not add a new fence to escape the permitted block.
  if (fixed.includes("```")) throw new Error("교정에 새 코드 블록 경계를 넣을 수 없습니다.");
  assertPolicyValuesPreserved(block.text, fixed);
  const merged = plan.slice(0, block.start) + fixed + plan.slice(block.end);
  if (!parseTolerancePolicy(merged)) throw new Error("교정 후 허용 오차 블록이 없습니다.");
  return merged;
}


// Only trailing commas outside strings have an unambiguous syntax repair. Never infer missing brackets or keys.
function parseRepairBaseline(original: string): unknown {
  const sanitized = sanitizeJSONControlCharacters(original);
  const canonical = sanitized.replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token === "," ? "" : token);
  return JSON.parse(canonical);
}

function assertPolicyValuesPreserved(original: string, fixed: string): void {
  const before = parseRepairBaseline(original);
  const after: unknown = JSON.parse(sanitizeJSONControlCharacters(fixed));
  const equal = (a: unknown, b: unknown, path: Array<string | number>): boolean => {
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return a === b;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    const aa = a as Record<string, unknown>, bb = b as Record<string, unknown>;
    const keys = Object.keys(aa);
    return keys.length === Object.keys(bb).length && keys.every(key => Object.hasOwn(bb, key)
      && equal(aa[key], bb[key], [...path, Array.isArray(a) ? Number(key) : key]));
  };
  if (!equal(before, after, [])) throw new Error("형식 교정에서 오류가 아닌 정책 필드를 변경했습니다.");
}
