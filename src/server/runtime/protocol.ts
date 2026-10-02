import { isAbsolute } from "node:path";
import { z } from "zod";
import { AgentExecutionSettingsSchema, type AgentResult, type PlanRepair } from "../../shared/contracts.js";
import { AgentProviderSchema, TURN_OPERATIONS, providerOptionsProblem, turnAccess, type TurnJob } from "../../shared/roles.js";
import type { TurnUsage } from "../types.js";

const PathSchema = z.string().min(1).refine(isAbsolute, "절대 경로가 필요합니다.");
const JobSchema = z.object({
  role: z.enum(["planner", "reviewer", "implementer"]), operation: z.string(),
}).strict().refine(job => (TURN_OPERATIONS[job.role] as readonly string[]).includes(job.operation),
  "역할이 지원하지 않는 작업입니다.").transform(job => job as TurnJob);
// 이 요청은 이미 고른 한 턴의 프로필이다. 단계별 implementation 중첩 설정은 어댑터가 해석하지 않으므로 받지 않는다.
const SettingsSchema = AgentExecutionSettingsSchema.pick({ model: true, effort: true }).strict();

// 호스트가 작성한 실행 요청이다. 모델 출력이나 HTTP 요청을 이 CLI에 곧바로 전달하면 안 된다.
// 콜백이 필요한 Figma 관측/계획 제어는 후속 소비처 전환에서 다룬다. 모르는 필드는 거부한다.
// E2e(운영 도구): resultKind "json" + outputSchema(소비처 schema, 의미 검증은 소비처), workspace "snapshot"(Git 없는 호스트 snapshot),
// isolated(호스트 밖 입력 차단 — turnPolicy.ts TurnPolicy.isolated). 셋 다 정책을 넓히지 않는다(E2e.md 규칙 1·3·4).
export const RuntimeRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(200),
  provider: AgentProviderSchema,
  session: z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("create") }).strict(),
    z.object({ mode: z.literal("resume"), sessionId: z.uuid() }).strict(),
  ]),
  resultKind: z.enum(["agent", "plan-repair", "json"]),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  job: JobSchema,
  cwd: PathSchema,
  workspace: z.enum(["git", "snapshot"]).default("git"),
  isolated: z.boolean().optional(),
  // 호스트가 소유한 공급자 세션 홈(E2e-1 host-review F001) — 운영 도구가 작업마다 쓰던 기존 홈을 그대로 이어 써서 설치 전후·구버전이 만든 스레드를
  // 같은 ID 로 재개한다. Codex 의 격리 snapshot 턴에만 받는다(엔진 턴으로 임의 홈 주입이 번지지 않게).
  sessionHome: PathSchema.optional(),
  prompt: z.string().min(1),
  freshSessionPrompt: z.string().optional(),
  settings: SettingsSchema,
  providerOptions: z.record(z.string(), z.unknown()).default({}),
  planMode: z.boolean().optional(),
  evidenceManaged: z.boolean().optional(),
  readablePaths: z.array(PathSchema).optional(),
  // 승인 경로만 쓰기(E2e-3) — 쓰기 job 에서만 받는다. 경로의 의미 검증(작업 폴더 안·링크·Git·러너 제어 경로)은 어댑터 입구 한 곳(writeScopeProblem)이 한다.
  writablePaths: z.array(PathSchema).min(1).optional(),
}).strict().superRefine((request, context) => {
  const problem = providerOptionsProblem(request.provider, request.providerOptions);
  if (problem) context.addIssue({ code: "custom", path: ["providerOptions"], message: problem });
  if (request.resultKind === "plan-repair" && (request.session.mode !== "resume" || request.job.operation !== "plan-repair")) {
    context.addIssue({ code: "custom", path: ["resultKind"], message: "계획 교정은 기존 세션의 plan-repair 작업으로만 엽니다." });
  }
  if (request.resultKind !== "plan-repair" && request.job.operation === "plan-repair") {
    context.addIssue({ code: "custom", path: ["resultKind"], message: "plan-repair 작업에는 plan-repair 결과 형식이 필요합니다." });
  }
  if (request.sessionHome !== undefined && !(request.provider === "codex" && request.isolated === true && request.workspace === "snapshot")) {
    context.addIssue({ code: "custom", path: ["sessionHome"], message: "sessionHome 은 Codex 의 격리(isolated) snapshot 턴에만 씁니다." });
  }
  // 잘못된 job 은 JobSchema 가 이미 보고한다 — 여기서는 접근을 판정만 한다.
  const access = (() => { try { return turnAccess(request.job); } catch { return null; } })();
  if (request.writablePaths !== undefined && access !== "write") {
    context.addIssue({ code: "custom", path: ["writablePaths"], message: "writablePaths 는 쓰기 작업(job)에서만 씁니다." });
  }
  if ((request.resultKind === "json") !== (request.outputSchema !== undefined)) {
    context.addIssue({ code: "custom", path: ["outputSchema"], message: "outputSchema 는 json 결과 형식과 함께만 씁니다." });
  }
});
export type RuntimeRequest = z.infer<typeof RuntimeRequestSchema>;

// 세션 확인 요청(엔진 개편 E2e-2) — 모델·공급자 프로세스를 띄우지 않고, 호스트 소유 세션 홈에 이 작업 폴더의 native 세션 기록이 있는지만 본다.
// 운영 도구가 재개할지 새 세션을 만들지 정하기 전에 쓴다(판단 규칙은 소비처 몫). Codex 의 격리 snapshot 경계만 받는다.
export const RuntimeCheckRequestSchema = z.object({
  version: z.literal(1),
  requestId: z.string().min(1).max(200),
  provider: z.literal("codex"),
  check: z.object({
    kind: z.literal("session"),
    // 공급자가 돌려주는 정규형(소문자) UUID 만 — 옵션처럼 해석되거나 다른 표기로 같은 기록을 가리키는 값을 받지 않는다.
    sessionId: z.uuid().refine(id => id === id.toLowerCase(), "소문자 정규형 UUID 가 필요합니다."),
  }).strict(),
  cwd: PathSchema,
  workspace: z.literal("snapshot"),
  sessionHome: PathSchema,
}).strict();
export type RuntimeCheckRequest = z.infer<typeof RuntimeCheckRequestSchema>;
export type RuntimeErrorCode = "INVALID_REQUEST" | "INVALID_CONFIGURATION" | "EXECUTION_FAILED" | "CANCELLED";
type EventPayload =
  | { type: "session"; sessionId: string }
  | { type: "usage"; usage: TurnUsage }
  | { type: "result"; sessionId: string; result: AgentResult | PlanRepair | Record<string, unknown> }
  | { type: "error"; code: RuntimeErrorCode; message: string }
  // 실제 공급자 프로세스가 떴다(E2e-2) — 호출자는 이 이벤트로만 모델 호출을 센다. pid 는 공급자 프로세스, at 은 epoch ms.
  | { type: "spawn"; pid: number; at: number }
  | { type: "environment"; environment: import("../../shared/sessionSettings.js").SessionEnvironment }
  // 공급자가 보고한 원시 사용량(E2e-2, Codex turn.completed.usage) — 합산·보정하지 않는다.
  | { type: "provider-usage"; usage: Record<string, unknown> }
  | { type: "session-status"; sessionId: string; exists: boolean; reason: string };
export type RuntimeEvent = EventPayload & { version: 1; requestId: string | null; sequence: number };
export type RuntimeEventPayload = EventPayload;
