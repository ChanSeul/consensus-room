// 계획 필수 검사 선언(2026-10-06 사용자 결정) — 계획 본문의 fenced 블록 ```checks {JSON} 이 구현·수정 결과를 받아들이기 전에 반드시 충족돼야 하는
// 검사를 선언한다. 엔진은 수락 경계 한 곳(engine/planCheckGate)에서 kind 별 충족 판정을 묻고, 러너가 고칠 실패면 같은 작업 세션의 계속 진행으로 돌려보내고
// 호스트 문제면 결과를 보존한 채 멈춘다.
// 리뷰는 그 결과(호스트 영수증)만 소비한다 — 리뷰어 좌석은 읽기 전용이라 실행 검사를 직접 돌릴 수 없다(2026-10-03 f82dbc0e: swiftc -parse permissionDenied).
// 블록이 없으면 필수 검사가 없다(이 계약 전에 승인된 계획 포함). kind 를 더하면 게이트의 판정표(PlanCheckSatisfiers)가 컴파일 오류로 항목을 요구한다.
import { z } from "zod";

// 엔진이 직접 실행하는 등록 프로필 — 가벼운 정적 검사만이다. 빌드·시뮬레이터·E2E 같은 무거운 게이트는 여기 없으므로 계획이 선언할 수 없다(중재자 실행 게이트로 남는다).
export const VERIFICATION_PROFILE_IDS = ["swift-concurrency-policy", "swift-parse"] as const;
export type VerificationProfileId = typeof VERIFICATION_PROFILE_IDS[number];
// 프로필이 무엇을 검사하는가 — 리뷰 영수증(verifications)이 이 문장을 쓴다.
export const VERIFICATION_PROFILE_LABELS: Record<VerificationProfileId, string> = {
  "swift-concurrency-policy": "Swift 동시성 정책 정적 검사(ci/check_swift_concurrency_policy.sh — Modules·SampleApp 의 Swift 전체)",
  "swift-parse": "바뀐 Swift 파일의 구문 검사(swift-frontend -parse — 타입 검사·빌드 아님)",
};

export const VerificationCheckSchema = z.object({
  id: z.string().min(1),
  kind: z.literal("verification"),
  profile: z.enum(VERIFICATION_PROFILE_IDS),
}).strict();
export const PlanCheckItemSchema = z.discriminatedUnion("kind", [VerificationCheckSchema]);
export type PlanCheckItem = z.infer<typeof PlanCheckItemSchema>;
const PlanChecksSchema = z.object({ version: z.literal(1), items: z.array(PlanCheckItemSchema).max(20) }).strict()
  .refine((value) => new Set(value.items.map((item) => item.id)).size === value.items.length, "checks 항목 id 가 겹칩니다.");

const CHECKS_FENCE = /```checks[^\n]*\n([\s\S]*?)\n```/g;

// 모델이 문자열 리터럴 안에 탭·줄바꿈 같은 제어 문자를 그대로 넣는 일이 잦다(2026-09-13 S11 개정 2회 연속 "Bad control
// character in string literal" → FAILED, 턴 2개 소각). 문자열 **안**의 제어 문자만 공백으로 바꾼다 — 문자열 밖(구조 공백)은 그대로,
// 이스케이프(`\n`)는 건드리지 않는다. 의미가 바뀌는 치환이 아니므로(공백↔공백류) 계약 완화가 아니다.
function sanitizeChecksControlCharacters(text: string): string {
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

// Only remove trailing commas outside strings. Missing keys/brackets are never inferred.
function normalizeChecksJSON(text: string): string {
  return sanitizeChecksControlCharacters(text).replace(/"(?:\\.|[^"\\])*"|,(?=\s*[}\]])/g, token => token === "," ? "" : token);
}

function checkedItems(raw: unknown, label: string): PlanCheckItem[] {
  const parsed = PlanChecksSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`계획 필수 검사 블록(${label}) 형식 오류: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown"} — `
      + `{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"${VERIFICATION_PROFILE_IDS.join("|")}"}]}`);
  }
  return parsed.data.items;
}

// 블록이 없으면 빈 목록. 형식이 틀리면 throw — 계획 계약 검사(assertPlanContract)가 저장 전에 거른다.
// 계획 묶음은 여러 MD 를 이어 붙인다(server/planBundle.serializePlanBundle) — 모든 블록을 읽어 선언 순서로 합친다. 블록마다 형식을 검사하고, 합친 선언도 같은
// 스키마로 검사한다(파일 사이의 같은 id·계획 전체 20개 초과는 형식 오류, 79fc4fc5 F007). 첫 블록만 받거나 다중 파일 계획을 막지 않는다.
export function parsePlanChecks(planMarkdown: string): PlanCheckItem[] {
  const blocks = [...planMarkdown.matchAll(CHECKS_FENCE)];
  const items = blocks.flatMap((match, index) => {
    const label = blocks.length > 1 ? `${index + 1}번째 \`\`\`checks` : "```checks";
    let raw: unknown;
    try {
      raw = JSON.parse(normalizeChecksJSON(match[1]));
    } catch (error) {
      throw new Error(`계획 필수 검사 블록(${label})이 JSON 이 아닙니다: ${error instanceof Error ? error.message : String(error)}`);
    }
    return checkedItems(raw, label);
  });
  return blocks.length > 1 ? checkedItems({ version: 1, items }, "여러 ```checks 를 합친 선언") : items;
}

// 계획이 선언한 엔진 실행 검사 프로필(중복 없음, 선언 순서).
export function declaredVerificationProfiles(items: readonly PlanCheckItem[]): VerificationProfileId[] {
  return [...new Set(items.filter((item) => item.kind === "verification").map((item) => item.profile))];
}
