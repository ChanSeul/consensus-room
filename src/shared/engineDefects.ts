import { z } from "zod";

export const EngineDefectReportSchema = z.object({
  key: z.string().trim().min(1).max(120),
  title: z.string().trim().min(1).max(500),
  evidence: z.string().trim().min(1).max(30_000),
  workaround: z.string().max(5_000).default(""),
}).strict();
