import { z } from "zod";

export const PLANNING_LIMITS = {
  promptBytes: 64 * 1024, fragmentBytes: 8 * 1024, batchBytes: 24 * 1024,
  checkpointBytes: 12 * 1024, requests: 4, rounds: 8, stalledRounds: 2,
} as const;

export const PlanningReadSchema = z.object({
  kind: z.enum(["file", "search", "evidence", "memory", "context", "artifact", "image"]),
  selector: z.string().min(1).max(1024),
  question: z.string().min(1).max(500),
  offset: z.number().int().nonnegative(),
}).strict();
export type PlanningRead = z.infer<typeof PlanningReadSchema>;
export const PlanningStepSchema = z.object({
  draft: z.string(),
  facts: z.array(z.object({ statement: z.string(), refs: z.array(z.string()).min(1) }).strict()),
  contradictions: z.array(z.string()),
  questions: z.array(z.string()),
  requests: z.array(PlanningReadSchema).max(PLANNING_LIMITS.requests),
  complete: z.boolean(),
}).strict();
export type PlanningStep = z.infer<typeof PlanningStepSchema>;
export const PlanningStepJsonSchema = z.toJSONSchema(PlanningStepSchema);

export interface PlanningFragment {
  id: string;
  kind: PlanningRead["kind"];
  selector: string;
  hash: string;
  offset: number;
  nextOffset: number | null;
  content: string;
}
export interface PlanningUsage {
  inputTokens: number; cachedInputTokens: number; outputTokens: number; durationMs: number;
}
export const PLANNING_METRIC_KEYS = ["inputBytes", "apiDurationMs", "toolDurationMs", "toolCalls", "costUSD", "modelTurns", "internalRequests"] as const;
export type PlanningMetrics = Partial<Record<typeof PLANNING_METRIC_KEYS[number], number>>;
export interface PlanningCheckpoint {
  version: 1; id: string; key: string; topicId: string; role: "claude" | "codex";
  stage: string; tree: string; evidenceDigest: string; instructionHash: string;
  scopeGeneration: number; planEpoch: number; prompt: string; inputSequence: number;
  planSHA256: string | null;
  admissionId: string; round: number; stalled: number; sessionId: string | null;
  step: PlanningStep; fragments: PlanningFragment[]; delivered: string[];
  usage: PlanningUsage; updatedAt: string; stopped: string | null;
  finalized: boolean; finalAttempted: boolean;
  started: boolean; injectedBytes: number;
  sourceHash?: string;
  peakStep?: PlanningUsage;
  lastRequestInputTokens?: number;
  peakRequestInputTokens?: number;
  imageBytes?: number;
  responseBytes?: number;
  usageIncomplete?: boolean;
  metrics?: PlanningMetrics;
  sessions?: string[];
  lastResponse?: import("./contracts.js").AgentResult;
  imageHash?: string;
  finalResult?: import("./contracts.js").AgentResult;
}

export class PlanningPaused extends Error {
  constructor(message: string) { super(message); this.name = "PlanningPaused"; }
}
