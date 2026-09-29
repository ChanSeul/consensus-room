import { z } from "zod";

// 역할(무엇을 하는가)·프로필(어떤 AI 를 어떻게 실행하는가)·참여자(누구)·세션(어느 대화)·배정 버전(언제부터)을 분리한다(엔진 개편 E1).
// E1 은 중재자(mediator) 배정만 서버 판정에 쓰고, 러너 역할은 기존 토픽별 participants 로 호환 유지한다(E2 에서 옮긴다).
export const AGENT_ROLES = ["mediator", "planner", "implementer", "reviewer", "verifier"] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export const AgentProviderSchema = z.enum(["claude", "codex"]);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

const IdentifierSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

// 공급자별 프로필 옵션(엔진 개편 E2c, plan §2.3) — 그 공급자 어댑터가 실제로 해석하는 키만 받는다. 모르는 키·잘못된 값은 조용히 무시하지 않고
// 프로필을 만들 때(API 400)와 경로를 정할 때(실행 전 거부), 어댑터 입구에서 거부한다. 다른 공급자의 같은 이름 옵션으로 바꿔 읽지 않는다 —
// 공급자마다 스키마가 따로다. 세션 저장소를 가르는 옵션은 없다 — 그런 옵션을 더하면 세션 정체(turnRouting.sameBinding)에 넣는다.
export const PROVIDER_OPTION_SCHEMAS = {
  // ultracode: 하위 에이전트 팬아웃(Workflow)을 연 턴에서 오케스트레이션 모드를 켤지. 없으면 켠다(E2c 이전 동작). 팬아웃이 닫힌 턴에는 적용되지 않는다 —
  // 엔진 정책이 닫은 것이라 다른 설정으로 대체하는 것이 아니다.
  claude: z.object({ ultracode: z.boolean().optional(),
    // Planner 전용 서버 advisor. null은 명시적 비활성화이며 추론 강도 옵션은 CLI가 지원하지 않는다.
    advisorModel: IdentifierSchema.nullable().optional(),
  }).strict(),
  codex: z.object({}).strict(),
} as const;

type OptionProvider = keyof typeof PROVIDER_OPTION_SCHEMAS;
export type ProviderOptions<P extends OptionProvider> = z.infer<(typeof PROVIDER_OPTION_SCHEMAS)[P]>;

// 옵션의 문제(없으면 null) — 어느 키가 왜 거부됐는지 그대로 적는다.
export function providerOptionsProblem(provider: OptionProvider, options: unknown): string | null {
  const parsed = PROVIDER_OPTION_SCHEMAS[provider].safeParse(options ?? {});
  if (parsed.success) return null;
  return parsed.error.issues.map(issue => issue.code === "unrecognized_keys"
    ? `${provider} 공급자가 해석하지 않는 옵션 ${issue.keys.join(", ")}`
    : `옵션 ${issue.path.join(".") || "(전체)"}: ${issue.message}`).join("; ");
}

// 검증된 옵션 — 문제가 있으면 던진다(어댑터 입구의 이중 방어).
export function parseProviderOptions<P extends OptionProvider>(provider: P, options: unknown): ProviderOptions<P> {
  const problem = providerOptionsProblem(provider, options);
  if (problem) throw new Error(`프로필 옵션을 실행할 수 없습니다: ${problem}.`);
  return PROVIDER_OPTION_SCHEMAS[provider].parse(options ?? {}) as ProviderOptions<P>;
}

export const AgentProfileInputSchema = z.object({
  id: IdentifierSchema,
  provider: AgentProviderSchema,
  model: z.string().trim().min(1).max(120),
  effort: z.string().trim().min(1).max(40),
  // 공급자별 옵션 — 그 공급자 어댑터가 해석하는 키만 받는다(위 PROVIDER_OPTION_SCHEMAS, E2c). 다른 공급자의 같은 이름 옵션으로 바꿔 읽지 않는다(plan §2.3).
  options: z.record(z.string(), z.unknown()).default({}),
}).strict().superRefine((profile, context) => {
  const problem = providerOptionsProblem(profile.provider, profile.options);
  if (problem) context.addIssue({ code: "custom", path: ["options"], message: problem });
});
export type AgentProfileInput = z.infer<typeof AgentProfileInputSchema>;
export interface AgentProfile extends AgentProfileInput { createdAt: string }

// scope: 전역 또는 토픽. 토픽 배정이 있으면 전역 배정보다 우선한다.
export const AssignmentScopeSchema = z.string().regex(/^(global|topic:[A-Za-z0-9-]{1,80})$/);
export const RoleAssignmentInputSchema = z.object({
  scope: AssignmentScopeSchema,
  role: AgentRoleSchema,
  operation: z.string().trim().max(60).default(""),
  participant: IdentifierSchema,
  profileId: IdentifierSchema.nullable().default(null),
  sessionId: z.string().trim().min(1).max(200).nullable().default(null),
  note: z.string().trim().max(500).default(""),
  // 기대 버전 — 현재 배정 버전(없으면 0)과 같아야 바꾼다. 동시에 두 사람이 바꾸거나 오래된 화면에서 바꾸는 것을 막는다.
  expectedVersion: z.number().int().nonnegative(),
}).strict();
export type RoleAssignmentInput = z.infer<typeof RoleAssignmentInputSchema>;

export interface RoleAssignment {
  scope: string;
  role: AgentRole;
  operation: string;
  participant: string;
  profileId: string | null;
  sessionId: string | null;
  version: number;
  assignedAt: string;
  note: string;
}

// 중재자 요청이 어느 배정으로 수락됐는가 — 호출 기록(origin)에 남긴다.
export interface MediatorIdentity {
  participant: string;
  version: number;
  scope: string;
}

export const MEDIATOR_HEADER = "x-consensus-mediator";
export const MEDIATOR_VERSION_HEADER = "x-consensus-mediator-version";

// 엔진 턴의 역할·작업(엔진 개편 E2a). 역할은 참여자 슬롯(claude/codex)과 다르다 — 슬롯은 세션을, job 은 정책을 정한다.
// 엔진은 모든 모델 턴에 job 을 명시하고, 쓰기 접근·구현 모델 선택·프로토콜 전용 여부는 호출자가 따로 적지 않고 job 에서 유도한다(turnFlags).
// review-read(E3-4c): 한 리뷰 호출의 쪽 예산을 넘는 필수 타임라인 구간을 판정 전에 나눠 싣는 읽기 호출 — 판정(REVIEW·FINAL_REVIEW)은 하지 않고 ACK 만 답한다.
export const TURN_OPERATIONS = {
  planner: ["brainstorm", "plan", "diagnosis-revision", "revision", "ack", "plan-repair", "contract-correction"],
  reviewer: ["brainstorm", "audit", "closeout", "review", "final-review", "answer-confirmation", "review-read", "ack", "plan-repair", "contract-correction"],
  implementer: ["implement", "fix", "continue", "tolerance-correction", "completion-confirmation", "contract-correction"],
} as const;
export type TurnRole = keyof typeof TURN_OPERATIONS;
export type TurnJob = { [R in TurnRole]: { role: R; operation: (typeof TURN_OPERATIONS)[R][number] } }[TurnRole];
export type TurnAccess = "none" | "read" | "write";

// 판단에 필요한 값을 프롬프트가 다 담는 확인 턴 — 도구·지시문·메모리를 싣지 않는다. 리뷰 읽기(review-read)도 서버가 실은 쪽을 받기만 하는 턴이라 같다.
const PROTOCOL_OPERATIONS: ReadonlySet<string> = new Set(["ack", "plan-repair", "completion-confirmation", "answer-confirmation", "review-read"]);

export function turnAccess(job: TurnJob): TurnAccess {
  if (!(TURN_OPERATIONS[job.role] as readonly string[]).includes(job.operation)) {
    throw new Error(`역할 ${job.role} 에는 작업 ${job.operation} 이 없습니다.`);
  }
  if (PROTOCOL_OPERATIONS.has(job.operation)) return "none";
  return job.role === "implementer" ? "write" : "read";
}

// 엔진 턴 요청·SessionTurn 에 싣는 파생 값. implementationModel: 주제의 구현 전용 모델(있으면)을 쓴다 — 구현자의 모든 턴(완료 확인 포함).
export interface TurnFlags { write: boolean; implementation: boolean; protocolOnly: boolean; implementationModel: boolean }
export function turnFlags(job: TurnJob): TurnFlags {
  const access = turnAccess(job);
  return { write: access === "write", implementation: access === "write", protocolOnly: access === "none", implementationModel: job.role === "implementer" };
}
