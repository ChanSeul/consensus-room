import { z } from "zod";
import { BudgetPolicySchema } from "./budgets.js";
export const WorkStageSchema = z
  .object({
    kind: z.enum(["work", "integration"]).default("work"),
    id: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .refine(
        (id) => !Object.hasOwn(Object.prototype, id),
        "예약된 단계 이름입니다.",
      ),
    title: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    acceptance: z.string().trim().min(1),
    dependsOn: z.array(z.string()).default([]),
    budget: BudgetPolicySchema,
  })
  .strict();
export const WorkGroupInputSchema = z
  .object({
    title: z.string().trim().min(1),
    goal: z.string().trim().min(1),
    contracts: z.string().trim().min(1),
    stages: z.array(WorkStageSchema).min(2).max(20),
  })
  .strict()
  .superRefine((g, ctx) => {
    if (g.stages.at(-1)?.kind !== "integration")
      ctx.addIssue({
        code: "custom",
        message: "마지막 단계는 전체 통합 검증이어야 합니다.",
      });
    const seen = new Set<string>();
    for (const s of g.stages) {
      if (seen.has(s.id) || s.dependsOn.some((id) => !seen.has(id)))
        ctx.addIssue({
          code: "custom",
          message: "단계 ID는 고유해야 하고 의존 단계는 앞에 있어야 합니다.",
        });
      seen.add(s.id);
    }
  });
export type WorkGroupInput = z.infer<typeof WorkGroupInputSchema>;
export interface WorkGroup extends WorkGroupInput {
  id: string;
  repositoryPath: string;
  baseOID: string;
  version: number;
  createdAt: string;
  pending?: Record<
    string,
    { topicId: string; worktreePath: string; baseOID: string }
  >;
  links: Record<
    string,
    { topicId: string; baseOID: string; groupVersion: number }
  >;
}
