import { z } from "zod";
export const InterruptDeliveryStateSchema = z.enum(["waiting", "sending", "sent", "acknowledged", "failed", "unknown", "unconfigured"]);
export const MediatorInterruptStatusSchema = z.object({
  id: z.string(), state: InterruptDeliveryStateSchema, reason: z.string(), error: z.string().nullable(),
});
export type MediatorInterruptStatus = z.infer<typeof MediatorInterruptStatusSchema>;
export const MediatorConnectionStatusSchema = z.object({
  state: z.enum(["unconfigured", "unreported", "connected", "unavailable", "stale", "scope-mismatch"]),
  subscriptionTopicId: z.string().nullable(), checkedAt: z.string().nullable(), error: z.string().nullable(),
});
export type MediatorConnectionStatus = z.infer<typeof MediatorConnectionStatusSchema>;
export const MediatorInterventionStatusSchema = z.object({
  id: z.string(), delivery: InterruptDeliveryStateSchema, handlingAt: z.string().nullable(),
  resumedAt: z.string().nullable(), actionId: z.string().nullable(), closed: z.boolean(),
});
export type MediatorInterventionStatus = z.infer<typeof MediatorInterventionStatusSchema>;
export const MediatorSessionSchema = z.object({ provider: z.enum(["claude", "codex"]), sessionId: z.string().trim().min(1).max(200) });
export type MediatorSession = z.infer<typeof MediatorSessionSchema>;
export interface MediatorInterrupt {
  id: string; topicId: string; title: string; state: string; reason: string; sequence: number; createdAt: string;
  sourceRole: "planner" | "runner" | "reviewer" | "system";
}

const attentionStates = new Set(["USER_DECISION_REQUIRED", "BLOCKED_ON_EVIDENCE", "FAILED", "AWAITING_USER_APPROVAL", "READY_TO_DELIVER", "BRAINSTORM_READY"]);
export function needsMediatorAttention(state: string): boolean { return attentionStates.has(state); }
