import { z } from "zod";
import { maxCharacters } from "./textLimits.js";

export const EngineDefectReportSchema = z.object({
  key: maxCharacters(z.string().trim().min(1), 120),
  title: maxCharacters(z.string().trim().min(1), 500),
  evidence: maxCharacters(z.string().trim().min(1), 30_000),
  workaround: maxCharacters(z.string(), 5_000).default(""),
}).strict();

// A person takes a defect out of the queue with its evidence: an engine commit that already fixed it, or the defect it
// duplicates (user instruction 2026-10-07), or a judgment that it needs no engine repair (CR Engine Advisor 자문 54 §2).
// Each reason carries only its own evidence.
// not_applicable kinds: not_engine — the confirmed cause and responsibility lie outside the engine; intended — the
// behavior matches the confirmed current contract; no_repair_needed — it satisfies the current contract and needs no
// separate engine repair (not for closing a valid unrepaired defect only because a workaround exists or its priority is
// low). basis identifies the contract, record or version the judgment used. decidedBy records where the judgment came
// from; it grants no authority and authenticates no one. A cause not yet confirmed has no kind: that defect stays todo or
// blocked. The server records the judgment as given and does not check its wording.
const closureNote = z.string().trim().min(1).max(2_000).optional();
export const EngineDefectNotApplicableKindSchema = z.enum(["not_engine", "intended", "no_repair_needed"]);
export type EngineDefectNotApplicableKind = z.infer<typeof EngineDefectNotApplicableKindSchema>;
export const EngineDefectClosureSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("fixed"), commit: z.string().trim().regex(/^[0-9a-f]{7,40}$/i), note: closureNote }).strict(),
  z.object({ reason: z.literal("duplicate"), representativeId: z.string().trim().min(1).max(200), note: closureNote }).strict(),
  z.object({ reason: z.literal("not_applicable"), kind: EngineDefectNotApplicableKindSchema,
    finding: z.string().trim().min(1).max(2_000), basis: z.string().trim().min(1).max(2_000),
    decidedBy: z.string().trim().min(1).max(200), note: closureNote }).strict(),
]);
export type EngineDefectClosureInput = z.infer<typeof EngineDefectClosureSchema>;
