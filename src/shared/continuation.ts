import { z } from "zod";

// Permission is for this exact plan, not arbitrary future plans or remote delivery.
export const ContinuationInputSchema = z.object({
  planSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  reason: z.string().trim().min(1).max(8000),
  localDelivery: z.object({ message: z.string().trim().min(1).max(4000), paths: z.array(z.string().min(1)) }).strict().optional(),
  nextStage: z.object({ groupId: z.string(), version: z.number().int().positive(), stageId: z.string().min(1) }).strict().optional(),
}).strict().refine(input => !input.nextStage || input.localDelivery, "다음 단계 착수에는 현재 단계의 로컬 완료 승인이 필요합니다.");
export type ContinuationInput = z.infer<typeof ContinuationInputSchema>;
export interface ContinuationRecord extends ContinuationInput {
  id: string;
  topicId: string;
  scopeGeneration: number;
  planEpoch: number;
  mediator: string;
  inputSequence: number;
  status: "pending" | "running" | "blocked" | "awaiting-approval" | "cancelled" | "complete";
  step: "evidence" | "approve" | "implement" | "commit" | "close" | "next-plan" | "complete";
  actionId: string | null;
  nextTopicId: string | null;
  error: string | null;
  updatedAt: string;
}
