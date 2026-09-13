import { z } from "zod";
export const RewriteKindSchema = z.enum(["plan", "revision", "repair"]);
export type RewriteKind = z.infer<typeof RewriteKindSchema>;
export const RevisionAllowanceSchema = z.object({
  topicId: z.string(),
  used: z.number().int().nonnegative(),
  limit: z.number().int().nonnegative(),
  firstPlanUsed: z.boolean(),
  historyIncomplete: z.boolean(),
  startedAt: z.string(),
  version: z.number().int().positive(),
});
export type RevisionAllowance = z.infer<typeof RevisionAllowanceSchema>;

export const RevisionGrantInputSchema = z
  .object({ version: z.number().int().positive() })
  .strict();
