import { z } from "zod";

// 역할(무엇을 하는가)·프로필(어떤 AI 를 어떻게 실행하는가)·참여자(누구)·세션(어느 대화)·배정 버전(언제부터)을 분리한다(엔진 개편 E1).
// E1 은 중재자(mediator) 배정만 서버 판정에 쓰고, 러너 역할은 기존 토픽별 participants 로 호환 유지한다(E2 에서 옮긴다).
export const AGENT_ROLES = ["mediator", "planner", "implementer", "reviewer", "verifier"] as const;
export const AgentRoleSchema = z.enum(AGENT_ROLES);
export type AgentRole = z.infer<typeof AgentRoleSchema>;
export const AgentProviderSchema = z.enum(["claude", "codex"]);
export type AgentProvider = z.infer<typeof AgentProviderSchema>;

const IdentifierSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

export const AgentProfileInputSchema = z.object({
  id: IdentifierSchema,
  provider: AgentProviderSchema,
  model: z.string().trim().min(1).max(120),
  effort: z.string().trim().min(1).max(40),
  // 공급자별 옵션은 해석하지 않고 보존한다(다른 공급자의 같은 이름 옵션으로 바꿔 읽지 않는다 — plan §2.3).
  options: z.record(z.string(), z.unknown()).default({}),
}).strict();
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
