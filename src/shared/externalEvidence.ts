import { z } from "zod";

export const EvidenceSourceInputSchema = z.object({
  url: z.string().url().max(2048),
  label: z.string().trim().min(1).max(160),
  mode: z.enum(["connector", "rest"]).default("connector"),
  intervalSeconds: z.number().int().min(300).max(86400).default(900),
}).strict();
export type EvidenceSourceInput = z.infer<typeof EvidenceSourceInputSchema>;
export type EvidenceProvider = "slack" | "jira" | "figma";
export type EvidenceStatus = "current" | "changed" | "unavailable" | "missing";
export const EvidenceDependencySchema = z.object({ sourceId: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type EvidenceDependency = z.infer<typeof EvidenceDependencySchema>;

export const EvidenceUnitSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["issue", "comment", "message", "design", "render"]),
  // Source text is data, never an instruction or a confirmed product decision.
  content: z.string().max(160_000),
  author: z.string().max(200).optional(),
  changedAt: z.string().max(100).optional(),
  imageBase64: z.string().max(6_000_000).optional(),
}).strict();
export type EvidenceUnitInput = z.infer<typeof EvidenceUnitSchema>;
export const EvidenceSnapshotInputSchema = z.object({
  checkId: z.string().uuid(),
  revision: z.string().max(300),
  units: z.array(EvidenceUnitSchema).max(5000),
}).strict();
export type EvidenceSnapshotInput = z.infer<typeof EvidenceSnapshotInputSchema>;
export interface EvidenceUnit extends Omit<EvidenceUnitInput, "imageBase64"> { contentHash: string; imageHash?: string }
export interface EvidenceSnapshot { sourceId: string; contentHash: string; units: EvidenceUnit[] }
export interface EvidenceSource extends EvidenceSourceInput {
  id: string; provider: EvidenceProvider; resource: string; selector: string;
  revision: string | null; contentHash: string | null; checkedAt: number | null;
  error: string | null; nextCheckAt: number;
}
export interface EvidenceCheck { source: EvidenceSource; checkId: string }
export const EvidencePlanBindingSchema = z.object({
  scopeGeneration: z.number().int().nonnegative(),
  planEpoch: z.number().int().nonnegative(),
  planSHA256: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
}).strict();
export type EvidencePlanBinding = z.infer<typeof EvidencePlanBindingSchema>;
export const EvidenceReviewInputSchema = z.object({
  digest: z.string().regex(/^[a-f0-9]{64}$/),
  plan: EvidencePlanBindingSchema,
  reason: z.string().trim().min(1).max(2000),
}).strict();
export type EvidenceReviewInput = z.infer<typeof EvidenceReviewInputSchema>;
export interface EvidenceTopicState {
  digest: string;
  plan: EvidencePlanBinding;
  reviewed: boolean;
  ready: boolean;
  sources: EvidenceSource[];
  connections?: Array<{ sourceId: string; configured: boolean; sharedTopics: number }>;
}

// URL query fragments and display names are not resource identity. Reject credentials and arbitrary hosts.
export function parseEvidenceSource(input: EvidenceSourceInput): Pick<EvidenceSource, "provider" | "resource" | "selector" | "url"> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("HTTPS 원문 링크만 등록할 수 있습니다.");
  const slack = /^\/archives\/([CG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/.exec(url.pathname);
  if (url.hostname.endsWith(".slack.com") && slack) {
    const thread = url.searchParams.get("thread_ts") ?? `${slack[2]}.${slack[3]}`;
    if (!/^\d{10}\.\d{6}$/.test(thread)) throw new Error("Slack 스레드 주소가 올바르지 않습니다.");
    return { provider: "slack", resource: `${url.hostname}/${slack[1]}`, selector: thread,
      url: `https://${url.hostname}/archives/${slack[1]}/p${thread.replace(".", "")}` };
  }
  const jira = /^\/browse\/([A-Z][A-Z0-9_]*-\d+)\/?$/.exec(url.pathname);
  if (url.hostname.endsWith(".atlassian.net") && jira) {
    return { provider: "jira", resource: `${url.hostname}/${jira[1]}`, selector: "", url: `https://${url.hostname}/browse/${jira[1]}` };
  }
  const figma = /^\/(?:design|file)\/([a-zA-Z0-9]+)(?:\/[^/]*)?\/?$/.exec(url.pathname);
  const node = url.searchParams.get("node-id")?.replace(/-/g, ":");
  if (["www.figma.com", "figma.com"].includes(url.hostname) && figma && node && /^\d+:\d+$/.test(node)) {
    return { provider: "figma", resource: figma[1], selector: node,
      url: `https://www.figma.com/design/${figma[1]}?node-id=${node.replace(":", "-")}` };
  }
  throw new Error("Slack 스레드, Jira 이슈, Figma 노드 링크를 입력하세요. Figma는 node-id가 필요합니다.");
}

export const MediatorEvidenceInputSchema = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict();
export const MediatorEvidenceAckSchema = MediatorEvidenceInputSchema.extend({ batchId: z.string().uuid() });
export interface MediatorEvidenceBatch {
  batchId: string | null;
  digest: string;
  sources: Array<Pick<EvidenceSource, "id" | "url" | "contentHash" | "checkedAt">>;
  changes: Array<EvidenceUnit & { sourceId: string }>;
  removedSources: string[];
  removedUnits: Array<{ sourceId: string; unitId: string }>;
  images: Array<{ hash: string; path: string }>;
}
export interface MediatorEvidenceResponse extends MediatorEvidenceBatch {
  currentDigest: string;
  superseded: boolean;
}
