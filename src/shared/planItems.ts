// 계획 항목 선언(plan-items, 2026-10-11 사용자 요청) — planned 토픽의 계획 묶음이 fenced 블록 ```plan-items {JSON} 으로 "무엇을 구현하고 무엇으로 끝났다고
// 보는가"를 안정된 id 의 목록으로 선언한다. 엔진은 이 목록을 기준으로 구현자 보고·코드 리뷰어 판정의 **정확한 집합 일치**만 기계적으로 확인한다
// (server/engine/planCoverage). 항목의 의미·구현의 정확성·근거의 진실성은 리뷰어·중재자·사용자 판단이다.
// 기존 ```checks(planChecks — 엔진이 실행하는 정적 검사 프로필)와 별개 계약이다. 블록이 없으면 "선언 없음"이고, planned 수락 경계가 그것을 막는다.
// 목록 자체의 버전은 계획 판 sha(planSHA256)다 — 블록이 계획 바이트의 일부라 따로 해시하지 않는다.
import { z } from "zod";

const TEXT_LIMIT = 2_000;
// id 는 묶음 전체에서 유일하고 안정적이어야 한다(개정에서 항목을 바꿔도 같은 요구는 같은 id). 항목 수 상한은 없다 — 상한이 요구 누락·임의 병합을 부른다(Root 2026-10-11).
const ITEM_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const NonBlank = (limit: number) => z.string().min(1).max(limit).refine((text) => text.trim().length > 0, { message: "공백이 아닌 내용이 있어야 합니다." });

export const PlanItemSchema = z.object({
  id: z.string().regex(ITEM_ID, "id 는 영문·숫자로 시작하는 40자 이하의 [A-Za-z0-9._-] 문자열입니다."),
  requirement: NonBlank(TEXT_LIMIT),
  done: NonBlank(TEXT_LIMIT),
}).strict();
export type PlanItem = z.infer<typeof PlanItemSchema>;
const PlanItemsSchema = z.object({ version: z.literal(1), items: z.array(PlanItemSchema).min(1) }).strict()
  .refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length, "plan-items 항목 id 가 겹칩니다.");

export const PLAN_ITEMS_FENCE = "plan-items";
// 여는 줄·닫는 줄은 줄 머리 공백(들여쓰기)과 3개 이상의 백틱을 허용한다 — 옛 정규식이 읽던 들여쓴 선언을 ^ 앵커가 조용히 제외하던 회귀(Root 표적 재대조, 2026-10-11).
const OPEN_FENCE = /^\s*`{3,}plan-items(?:\s.*)?$/;
const CLOSE_FENCE = /^\s*`{3,}\s*$/;
const OPEN_TOKEN = "```plan-items";
// 기존 세션·새 세션이 같은 한 줄로 형식을 알 수 있게 피드백과 매 턴 사실이 함께 싣는 최소 예시.
export const PLAN_ITEMS_EXAMPLE = '```plan-items\n{"version":1,"items":[{"id":"R-1","requirement":"구현할 요구","done":"완료로 보는 조건"}]}\n```';

// 모델이 문자열 리터럴 안에 탭·줄바꿈을 그대로 넣는 일이 잦다(planChecks 와 같은 관측). 문자열 **안**의 제어 문자만 공백으로 바꾸고 이스케이프는 그대로 둔다.
function sanitizeControlCharacters(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) { escaped = false; out += ch; continue; }
      if (ch === "\\") { escaped = true; out += ch; continue; }
      if (ch === '"') { inString = false; out += ch; continue; }
      out += ch.charCodeAt(0) < 0x20 ? " " : ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
}

// 문자열 밖의 마지막 쉼표만 지운다. 빠진 키·괄호는 추측하지 않는다.
function normalizeJSON(text: string): string {
  return sanitizeControlCharacters(text).replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, (token) => token === "," ? "" : token);
}

export class PlanItemsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanItemsError";
  }
}

function checkedItems(raw: unknown, label: string): PlanItem[] {
  const parsed = PlanItemsSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new PlanItemsError(`계획 항목 블록(${label}) 형식 오류: ${issue ? `${issue.path.join(".") || "(전체)"} ${issue.message}` : "unknown"} — 예시 ${PLAN_ITEMS_EXAMPLE}`);
  }
  return parsed.data.items;
}

// 블록 추출 — 줄 단위 상태 기계. 여는 줄(```plan-items)부터 닫는 줄(```)까지가 본문이다. 닫는 줄 없이 본문이 끝나거나 그 전에 다음 여는 줄을 만나면 미완성
// 선언이라 전체를 거부한다 — lazy 정규식은 닫히지 않은 블록을 조용히 무시하거나 다음 블록의 여는 줄을 닫는 줄로 삼아 그 블록을 삼켰다(Root 인수 검토 1,
// 2026-10-11). 여러 .md 를 이은 본문에서 파일 경계를 넘는 미완성 블록도 같은 판정이다. plan-items 가 아닌 펜스는 보지 않는다.
function planItemBlocks(planMarkdown: string): string[] {
  const blocks: string[] = [];
  let open: { line: number; body: string[] } | null = null;
  const unclosed = (reason: string) =>
    new PlanItemsError(`닫히지 않은 \`\`\`plan-items 블록(${open?.line}번째 줄에서 열림): ${reason}. 닫는 줄 \`\`\` 로 블록을 닫으세요 — 예시 ${PLAN_ITEMS_EXAMPLE}`);
  for (const [index, line] of planMarkdown.split("\n").entries()) {
    if (OPEN_FENCE.test(line)) {
      if (open) throw unclosed(`${index + 1}번째 줄에서 다음 \`\`\`plan-items 를 만났습니다`);
      open = { line: index + 1, body: [] };
    } else if (open && CLOSE_FENCE.test(line)) {
      blocks.push(open.body.join("\n"));
      open = null;
    } else if (open) {
      open.body.push(line);
    } else if (line.includes(OPEN_TOKEN)) {
      // 블록 밖의 여는 줄이 아닌 토큰(앞에 다른 내용이 있거나 이름이 plan-items 가 아닌 줄) — 조용히 지나치면 그 선언이 빠진 부분 목록이 통과하므로 형식 오류로 전체를 거부한다.
      throw new PlanItemsError(`올바른 여는 줄이 아닌 \`\`\`plan-items 토큰(${index + 1}번째 줄): 여는 줄은 들여쓰기 외에 앞에 다른 내용 없이, 이름은 정확히 plan-items 로 한 줄에 씁니다 — 예시 ${PLAN_ITEMS_EXAMPLE}`);
    }
  }
  if (open) throw unclosed("본문이 끝났습니다");
  return blocks;
}

// 계획 묶음(여러 .md 를 이어 붙인 직렬화 본문)의 모든 ```plan-items 블록을 선언 순서로 합친다. 블록마다 형식을 검사하고 합친 선언도 같은 스키마로 검사한다
// (파일 사이의 같은 id 는 형식 오류). 블록이 없으면 빈 목록 — "선언 없음"의 판정은 호출자(수락 경계)가 한다. 형식이 틀리면 PlanItemsError 를 던진다.
export function parsePlanItems(planMarkdown: string): PlanItem[] {
  const blocks = planItemBlocks(planMarkdown);
  const items = blocks.flatMap((body, index) => {
    const label = blocks.length > 1 ? `${index + 1}번째 \`\`\`plan-items` : "```plan-items";
    let raw: unknown;
    try {
      raw = JSON.parse(normalizeJSON(body));
    } catch (error) {
      throw new PlanItemsError(`계획 항목 블록(${label})이 JSON 이 아닙니다: ${error instanceof Error ? error.message : String(error)} — 예시 ${PLAN_ITEMS_EXAMPLE}`);
    }
    return checkedItems(raw, label);
  });
  return blocks.length > 1 ? checkedItems({ version: 1, items }, "여러 ```plan-items 를 합친 선언") : items;
}

// ---- 봉투의 항목별 보고·판정 ----
// 구현자는 항목마다 구현 위치·실행한 검증을 evidence 로 적고 status 를 고른다. 코드 리뷰어는 실제 코드·근거로 독립 판정한다. "해당 없음"은 없다 —
// 범위에서 빼려면 계획 개정(return-to-planning)으로 목록을 바꾼다.
export const IMPLEMENTER_ITEM_STATUSES = ["implemented", "not-implemented"] as const;
export const REVIEWER_ITEM_STATUSES = ["satisfied", "unimplemented", "unverified"] as const;
export const PLAN_ITEM_STATUSES = [...IMPLEMENTER_ITEM_STATUSES, ...REVIEWER_ITEM_STATUSES] as const;
export type PlanItemStatus = (typeof PLAN_ITEM_STATUSES)[number];

export function planItemReportSchema<const S extends readonly [PlanItemStatus, ...PlanItemStatus[]]>(statuses: S) {
  return z.array(z.object({ id: z.string().min(1), status: z.enum(statuses), evidence: NonBlank(TEXT_LIMIT) }).strict());
}
export const PlanItemReportSchema = planItemReportSchema(PLAN_ITEM_STATUSES);
export type PlanItemReport = z.infer<typeof PlanItemReportSchema>;

// 봉투의 CLI 출력 스키마 조각 — OpenAI 구조화 출력 규칙대로 모든 키를 required 에 두고 선택성(보고 없음)은 null 로 표현한다.
export function planItemsOutputSchema(statuses: readonly PlanItemStatus[]) {
  return {
    anyOf: [{
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["id", "status", "evidence"],
        properties: { id: { type: "string", minLength: 1, pattern: "\\S" }, status: { enum: [...statuses] }, evidence: { type: "string", minLength: 1, pattern: "\\S" } },
      },
    }, { type: "null" }],
  } as const;
}

// 집합 대조 — 선언한 id 집합과 보고한 id 집합이 정확히 같아야 한다(누락·미지·중복 전부 불일치). 공백 근거도 불일치다. 기계적 교정 대상(format)과
// 아직 충족되지 않은 항목(unmet: 기대 status 가 아닌 항목)을 나눠 돌려준다 — 둘 다 비어야 coverage 가 성립한다.
// violations 는 정규화한 위반 집합(정렬·중복 제거) — 반복 판정 키의 재료다. 보고 순서·evidence 문구는 들어가지 않는다(host-review F002).
export interface PlanItemViolations {
  absent: boolean;
  missing: string[];
  unknown: string[];
  duplicated: string[];
  blank: string[];
}
export interface PlanItemCoverage {
  format: string[];
  unmet: PlanItemReport;
  violations: PlanItemViolations;
}
const sortedUnique = (ids: readonly string[]) => [...new Set(ids)].sort();
export function planItemCoverage(declared: readonly PlanItem[], reported: PlanItemReport | null | undefined, satisfied: PlanItemStatus): PlanItemCoverage {
  const format: string[] = [];
  if (!reported) {
    return { format: [`항목별 보고(planItems)가 없습니다 — 선언한 항목 ${declared.map((item) => item.id).join(", ")} 마다 status·evidence 를 적으세요.`], unmet: [],
      violations: { absent: true, missing: sortedUnique(declared.map((item) => item.id)), unknown: [], duplicated: [], blank: [] } };
  }
  const declaredIds = new Set(declared.map((item) => item.id));
  const seen = new Set<string>();
  const duplicated: string[] = [];
  const unknown: string[] = [];
  const blank: string[] = [];
  for (const entry of reported) {
    if (seen.has(entry.id)) duplicated.push(entry.id);
    seen.add(entry.id);
    if (!declaredIds.has(entry.id)) unknown.push(entry.id);
    if (entry.evidence.trim().length === 0) blank.push(entry.id);
  }
  const missing = declared.map((item) => item.id).filter((id) => !seen.has(id));
  if (missing.length) format.push(`보고에 빠진 항목: ${missing.join(", ")}`);
  if (unknown.length) format.push(`계획에 없는 항목: ${unknown.join(", ")}`);
  if (duplicated.length) format.push(`중복 보고한 항목: ${[...new Set(duplicated)].join(", ")}`);
  if (blank.length) format.push(`근거(evidence)가 비어 있는 항목: ${[...new Set(blank)].join(", ")}`);
  const unmet = reported.filter((entry) => declaredIds.has(entry.id) && entry.status !== satisfied);
  return { format, unmet,
    violations: { absent: false, missing: sortedUnique(missing), unknown: sortedUnique(unknown), duplicated: sortedUnique(duplicated), blank: sortedUnique(blank) } };
}
