// 계획 필수 검사 선언(2026-10-06 사용자 결정) — 계획 본문의 fenced 블록 ```checks {JSON} 이 구현·수정 결과를 받아들이기 전에 반드시 충족돼야 하는
// 검사를 선언한다. 엔진은 수락 경계 한 곳(engine/planCheckGate)에서 kind 별 충족 판정을 묻고, 러너가 고칠 실패면 같은 작업 세션의 계속 진행으로 돌려보내고
// 호스트 문제면 결과를 보존한 채 멈춘다.
// 리뷰는 그 결과(호스트 영수증)만 소비한다 — 리뷰어 좌석은 읽기 전용이라 실행 검사를 직접 돌릴 수 없다(2026-10-03 f82dbc0e: swiftc -parse permissionDenied).
// 블록이 없으면 필수 검사가 없다(이 계약 전에 승인된 계획 포함). kind 를 더하면 게이트의 판정표(PlanCheckSatisfiers)가 컴파일 오류로 항목을 요구한다.
import { z } from "zod";
import { normalizeToleranceJSON } from "./tolerance.js";

// 엔진이 직접 실행하는 등록 프로필 — 가벼운 정적 검사만이다. 빌드·시뮬레이터·E2E 같은 무거운 게이트는 여기 없으므로 계획이 선언할 수 없다(중재자 실행 게이트로 남는다).
export const VERIFICATION_PROFILE_IDS = ["swift-concurrency-policy", "swift-parse"] as const;
export type VerificationProfileId = typeof VERIFICATION_PROFILE_IDS[number];
// 프로필이 무엇을 검사하는가 — 계획 계약 안내와 리뷰 영수증이 같은 문장을 쓴다.
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

const CHECKS_FENCE = /```checks[^\n]*\n([\s\S]*?)\n```/;

// 블록이 없으면 빈 목록. 형식이 틀리면 throw — 계획 계약 검사(assertPlanContract)가 저장 전에 거른다.
export function parsePlanChecks(planMarkdown: string): PlanCheckItem[] {
  const match = CHECKS_FENCE.exec(planMarkdown);
  if (!match) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(normalizeToleranceJSON(match[1]));
  } catch (error) {
    throw new Error(`계획 필수 검사 블록(\`\`\`checks)이 JSON 이 아닙니다: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = PlanChecksSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(`계획 필수 검사 블록(\`\`\`checks) 형식 오류: ${issue ? `${issue.path.join(".")} ${issue.message}` : "unknown"} — `
      + `{"version":1,"items":[{"id":"C-1","kind":"verification","profile":"${VERIFICATION_PROFILE_IDS.join("|")}"}]}`);
  }
  return parsed.data.items;
}

// kind 별 선언 안내 — 계획 계약(prompts.planContract)이 이 표를 그대로 나열한다. kind 를 더하면 여기 항목이 없어 컴파일되지 않는다.
const PLAN_CHECK_KIND_GUIDES: { [K in PlanCheckItem["kind"]]: string } = {
  verification: `서버가 수락 직전에 이 작업 트리에서 직접 실행하는 등록 프로필 — profile 은 ${VERIFICATION_PROFILE_IDS.map((id) => `\`${id}\`(${VERIFICATION_PROFILE_LABELS[id]})`).join(" · ")}`,
};

export function planChecksGuide(): string {
  return "필수 검사 선언(선택): 구현·수정 결과를 받아들이기 전에 서버가 반드시 확인해야 하는 검사는 `## 테스트` 절에 fenced 블록 ```checks {JSON} ``` 으로 선언합니다 — "
    + `{"version":1,"items":[{"id":"C-1","kind":"…", …}]}. 서버가 수락 직전에 판정하고, 실패하면 결과를 받지 않고 같은 작업 세션으로 돌려보냅니다. kind 별:\n`
    + Object.entries(PLAN_CHECK_KIND_GUIDES).map(([kind, guide]) => `- ${kind}: ${guide}`).join("\n")
    + "\n빌드·Simulator·E2E·외부 원문 대조는 이 블록으로 선언할 수 없습니다(중재자 게이트·리뷰 판단으로 남습니다). 블록이 없으면 필수 실행 검사가 없는 계획입니다. "
    + "코드 리뷰어 좌석은 읽기 전용이라 실행 검사를 돌릴 수 없습니다 — 실행이 필요한 검사를 리뷰어의 의무나 리뷰 통과 조건으로 적지 말고 이 블록으로 선언하세요.";
}

// 계획이 선언한 엔진 실행 검사 프로필(중복 없음, 선언 순서).
export function declaredVerificationProfiles(items: readonly PlanCheckItem[]): VerificationProfileId[] {
  return [...new Set(items.filter((item) => item.kind === "verification").map((item) => item.profile))];
}
