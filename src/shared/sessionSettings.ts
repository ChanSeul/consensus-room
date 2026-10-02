import { z } from "zod";
import { AgentEffortSchema, type AgentEffort } from "./contracts.js";

export const SessionSettingsTargetSchema = z.enum(["planner", "implementer", "plan-review", "code-review", "mediator", "verifier", "host-reviewer"]);
export type SessionSettingsTarget = z.infer<typeof SessionSettingsTargetSchema>;
export const REVIEW_CRITERIA = [
  { id: "correctness", label: "정확성·경계 조건", instruction: "정확성, 경계 조건, 실패·취소·복구 경로를 확인하세요." },
  { id: "security", label: "보안·권한", instruction: "민감 정보, 입력 검증, 권한 및 격리 경계를 확인하세요." },
  { id: "tests", label: "검증 근거", instruction: "변경 계약을 검증하는 테스트와 실제 소비처의 증거를 확인하세요." },
  { id: "efficiency", label: "시간·토큰 효율", instruction: "불필요한 모델 호출, 입력 확대, 반복 조회와 직렬 대기를 확인하세요. 측정 없는 성능 향상을 단정하지 마세요." },
  { id: "maintainability", label: "구조·유지보수", instruction: "책임 분리, 의존 방향, 불필요한 복잡성과 중복을 확인하세요." },
] as const;
export const ReviewCriteriaSchema = z.object({
  selectedIds: z.array(z.enum(["correctness", "security", "tests", "efficiency", "maintainability"])).max(5)
    .refine(ids => new Set(ids).size === ids.length, "중복 기준은 허용하지 않습니다."),
  additionalText: z.string().trim().max(4000),
}).strict();
export type ReviewCriteria = z.infer<typeof ReviewCriteriaSchema>;
export const SessionSettingsUpdateSchema = z.object({
  target: SessionSettingsTargetSchema, revision: z.string().min(1).max(128),
  model: z.string().trim().min(1).max(120), effort: AgentEffortSchema, criteria: ReviewCriteriaSchema.optional(),
}).strict();
export type SessionSettingsUpdate = z.infer<typeof SessionSettingsUpdateSchema>;
export interface SessionSettingsView {
  target: SessionSettingsTarget;
  editable: boolean;
  reason?: string;
  revision: string;
  appliesTo: "next-execution";
  mixed: boolean;
  models: string[];
  efforts: AgentEffort[];
  operations: Array<{ operation: string; provider: string; model: string; effort: AgentEffort; scope: string }>;
  criteria?: ReviewCriteria & { catalog: Array<{ id: string; label: string }>; mixed: boolean };
}

// Observed at an actual provider spawn. Legacy/external sessions do not inherit current host values.
export interface SessionEnvironment {
  executionId: string;
  sessionId: string | null;
  provider: string;
  consumer: string;
  spawnedAt: string;
  cwd: string;
  hostname: string;
  hostOS: { platform: string; release: string; arch: string };
  isolated: boolean;
  workspace: "git" | "snapshot";
  access: "none" | "read" | "write";
  sandbox: string;
  model: string;
  effort: string;
}
