import { z } from "zod";
import { maxCharacters } from "./textLimits.js";

export const EngineDefectReportSchema = z.object({
  key: maxCharacters(z.string().trim().min(1), 120),
  title: maxCharacters(z.string().trim().min(1), 500),
  evidence: maxCharacters(z.string().trim().min(1), 30_000),
  workaround: maxCharacters(z.string(), 5_000).default(""),
}).strict();

// A person takes a defect out of the queue with its evidence: an engine commit that already fixed it, or the defect it
// duplicates (user instruction 2026-10-07). Each reason carries only its own evidence.
const closureNote = z.string().trim().min(1).max(2_000).optional();
export const EngineDefectClosureSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("fixed"), commit: z.string().trim().regex(/^[0-9a-f]{7,40}$/i), note: closureNote }).strict(),
  z.object({ reason: z.literal("duplicate"), representativeId: z.string().trim().min(1).max(200), note: closureNote }).strict(),
]);
export type EngineDefectClosureInput = z.infer<typeof EngineDefectClosureSchema>;
