import { z } from "zod";

export const BudgetVectorSchema = z.object({
  inputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  outputTokens: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  durationMs: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
}).strict();
export type BudgetVector = z.infer<typeof BudgetVectorSchema>;
export const BUDGET_KEYS = ["inputTokens", "outputTokens", "durationMs"] as const;
export const zeroBudget = (): BudgetVector => ({ inputTokens: 0, outputTokens: 0, durationMs: 0 });
export const BudgetPolicySchema = z.object({ execution: BudgetVectorSchema, total: BudgetVectorSchema }).strict();
export type BudgetPolicy = z.infer<typeof BudgetPolicySchema>;
export interface BudgetPause {
  reason: string;
  executionId?: string;
  detectedAt: number;
  deadline: number;
}
export interface BudgetAccount {
  id: string;
  policy: BudgetPolicy;
  used: BudgetVector;
  startedAt: number;
  pause: BudgetPause | null;
  version: number;
  source: string;
}
export const BudgetSampleSchema = z.object({
  executionId:z.string().min(1),stage:z.string().min(1),role:z.string().min(1),model:z.string().min(1),effort:z.string().min(1),
  verified:z.boolean(),successful:z.boolean(),completeness:z.enum(["complete","partial"]),mismatch:z.boolean(),usage:BudgetVectorSchema,
}).strict();
export type BudgetSample = z.infer<typeof BudgetSampleSchema>;
export function calibrateBudget(samples: BudgetSample[], target: Pick<BudgetSample, "stage" | "role" | "model" | "effort">) {
  const parsed = z.array(BudgetSampleSchema).parse(samples);
  const conflicts = new Set<string>();
  const seen = new Map<string,string>();
  for (const s of parsed) {
    const value = JSON.stringify(s);
    if (seen.has(s.executionId) && seen.get(s.executionId) !== value) conflicts.add(s.executionId);
    seen.set(s.executionId,value);
  }
  const valid = parsed.filter(s => !conflicts.has(s.executionId)).filter(s => s.verified && s.successful && s.completeness === "complete" && !s.mismatch
    && BudgetVectorSchema.safeParse(s.usage).success && s.role === target.role && s.model === target.model);
  const exact = valid.filter(s => s.stage === target.stage && s.effort === target.effort);
  const selected = exact.length ? exact : valid;
  const unique = [...new Map(selected.map(s => [s.executionId, s])).values()];
  if (!unique.length) return null;
  const values = Object.fromEntries(BUDGET_KEYS.map(key => {
    const sorted = unique.map(s => s.usage[key]).sort((a, b) => a - b);
    const index = exact.length && unique.length >= 20 ? Math.ceil(sorted.length * 0.95) - 1 : sorted.length - 1;
    return [key, Math.min(Number.MAX_SAFE_INTEGER, Math.ceil(sorted[index] * 2))];
  })) as BudgetVector;
  return { limit: values, sampleCount: unique.length, provisional: exact.length === 0 || unique.length < 20,
    sourceIds: unique.map(s => s.executionId), method: exact.length && unique.length >= 20 ? "p95-times-two" : "maximum-times-two" };
}
