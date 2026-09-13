import { z } from "zod";
export const ReviewScopeSchema = z.enum(["planning", "implementation"]);
export type ReviewScope = z.infer<typeof ReviewScopeSchema>;
export const ReviewAllowanceSchema = z.object({
  topicId: z.string(),
  scope: ReviewScopeSchema,
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  version: z.number().int().positive(),
  historyIncomplete: z.boolean(),
});
export type ReviewAllowance = z.infer<typeof ReviewAllowanceSchema>;
export const ReviewGrantInputSchema = z
  .object({ scope: ReviewScopeSchema, version: z.number().int().positive() })
  .strict();
export function reviewScope(stage: string): ReviewScope | undefined {
  if (["CODEX_AUDIT", "CODEX_CLOSEOUT"].includes(stage)) return "planning";
  if (["CODEX_REVIEW", "CODEX_FINAL_REVIEW"].includes(stage))
    return "implementation";
}
