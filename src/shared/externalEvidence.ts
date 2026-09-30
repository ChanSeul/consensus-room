import { z } from "zod";

export const EvidenceSourceInputSchema = z.object({
  url: z.string().url().max(2048),
  label: z.string().trim().min(1).max(160),
  mode: z.enum(["connector", "rest"]).default("connector"),
  intervalSeconds: z.number().int().min(300).max(86400).default(900),
}).strict();
export type EvidenceSourceInput = z.infer<typeof EvidenceSourceInputSchema>;
export type EvidenceProvider = "slack" | "jira" | "figma" | "sheets" | "confluence" | "document";
export type EvidenceStatus = "current" | "changed" | "unavailable" | "missing";
export const EvidenceDependencySchema = z.object({ sourceId: z.string().regex(/^[a-f0-9]{64}$/), contentHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export type EvidenceDependency = z.infer<typeof EvidenceDependencySchema>;

export const EvidenceUnitSchema = z.object({
  id: z.string().min(1).max(200),
  kind: z.enum(["issue", "comment", "message", "design", "render", "document", "cells", "api"]),
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
export const EvidenceHostImportSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/), rootId: z.string().uuid(),
  sourceId: z.string().regex(/^[a-f0-9]{64}$/),
  previousHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), previousCheckedAt: z.number().int().nonnegative().nullable(),
  observedAt: z.number().int().nonnegative(), revision: z.string().min(1).max(300),
  units: EvidenceSnapshotInputSchema.shape.units,
  // Missing comments/pages remain a collection failure, even when the captured cells are searchable.
  missing: z.array(z.string().trim().min(1).max(200)).max(30),
}).strict();
export type EvidenceHostImport = z.infer<typeof EvidenceHostImportSchema>;
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

export const EvidenceScopeSchema = z.enum(["workspace", "group", "topic"]);
export type EvidenceScope = z.infer<typeof EvidenceScopeSchema>;
export const EvidenceRootInputSchema = EvidenceSourceInputSchema.extend({
  scope: EvidenceScopeSchema.default("group"),
  required: z.boolean().default(true),
}).strict();
export type EvidenceRootInput = z.infer<typeof EvidenceRootInputSchema>;
export interface EvidenceRoot {
  id: string; scope: EvidenceScope; owner: string; sourceId: string; required: boolean;
  status: "proposed" | "approved" | "removed"; version: number; createdAt: number;
  approvedAt: number | null; lastCompleteAt: number | null; nextCheckAt: number; scanStartedAt?: number;
}
export interface EvidenceDiscoveryLink { url: string; label: string; unitId: string; relation: "child" | "link" }
export interface EvidenceDiscoveryPage {
  units: EvidenceUnitInput[]; links: EvidenceDiscoveryLink[]; cursor: string | null; revision: string;
}
export interface EvidenceCatalogEntry {
  rootId: string; source: EvidenceSource; state: "approved" | "candidate" | "rejected";
  progress: "pending" | "reading" | "complete" | "failed"; error: string | null;
  discoveredFrom: Array<{ sourceId: string; unitId: string; relation: string }>;
}
export interface EvidenceCatalog {
  version: string; groupId: string | null; roots: Array<EvidenceRoot & { source: EvidenceSource }>;
  unresolvedLinks?: Array<{ rootId: string; id: string; url: string; error: string }>;
  entries: EvidenceCatalogEntry[]; history: Array<{ at: number; action: string; url: string; scope: EvidenceScope }>;
  coverage: { sources: number; units: number; complete: number; pending: number; failed: number; candidates: number; ready: boolean };
}
// A collection request contains metadata only. It does not grant source selection or claim a successful read.
export interface EvidenceHostRead {
  rootId: string; sourceId: string; url: string; label: string; provider: EvidenceProvider;
  resource: string; selector: string; previousHash: string | null; previousCheckedAt: number | null;
  integration: string; requiredReads: string[];
}
export interface EvidenceHostPlan {
  version: string; requests: EvidenceHostRead[]; total: number; nextCursor: string | null;
  pendingReview: number;
}
export interface EvidenceCollectionResult extends EvidenceCatalog { hostPlan: EvidenceHostPlan }
export const EvidenceSelectionInputSchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/), rootId: z.string().uuid(),
  action: z.enum(["approve", "remove", "accept", "reject", "dismiss"]), sourceId: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();
export const EvidenceSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(500), offset: z.number().int().nonnegative().default(0),
  limit: z.number().int().min(1).max(50).default(20),
}).strict();
export interface EvidenceSearchHit { sourceId: string; unitId: string; hash: string; url: string; label: string; excerpt: string }

// URL query fragments and display names are not resource identity. Reject credentials and arbitrary hosts.
export function parseEvidenceSource(input: EvidenceSourceInput): Pick<EvidenceSource, "provider" | "resource" | "selector" | "url"> {
  const url = new URL(input.url);
  if (url.protocol !== "https:" || url.username || url.password || url.port) throw new Error("HTTPS 원문 링크만 등록할 수 있습니다.");
  if (/\.(?:slack\.com|atlassian\.net|figma\.com)\./.test(url.hostname)) throw new Error("원문 서비스 주소가 올바르지 않습니다.");
  const channel = /^\/archives\/([CG][A-Z0-9]+)\/?$/.exec(url.pathname);
  if (url.hostname.endsWith(".slack.com") && channel) return { provider: "slack", resource: `${url.hostname}/${channel[1]}`,
    selector: "", url: `https://${url.hostname}/archives/${channel[1]}` };
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
  const sheet = /^\/spreadsheets\/d\/([a-zA-Z0-9_-]+)(?:\/.*)?$/.exec(url.pathname);
  if (url.hostname === "docs.google.com" && sheet) return { provider: "sheets", resource: sheet[1], selector: "",
    url: `https://docs.google.com/spreadsheets/d/${sheet[1]}/edit${url.searchParams.has("gid") ? `?gid=${url.searchParams.get("gid")}` : ""}` };
  const page = /^\/wiki\/spaces\/[^/]+\/pages\/(\d+)(?:\/.*)?$/.exec(url.pathname);
  if (url.hostname.endsWith(".atlassian.net") && page) return { provider: "confluence", resource: `${url.hostname}/${page[1]}`, selector: "", url: url.href };
  if (["figma.com", "www.figma.com"].includes(url.hostname)) throw new Error("Figma는 작업할 페이지·노드의 node-id가 필요합니다.");
  if (url.hostname.endsWith(".slack.com") || url.hostname.endsWith(".atlassian.net")) throw new Error("지원하는 채널·스레드·이슈·문서 주소를 입력하세요.");
  if (!url.hostname.includes(".") || /^(localhost|127\.|0\.|169\.254\.|10\.|192\.168\.|\[)/.test(url.hostname) || url.hostname.endsWith(".local"))
    throw new Error("공개 HTTPS 문서 주소를 입력하세요.");
  url.hash = "";
  return { provider: "document", resource: url.href, selector: "", url: url.href };
}

// 근거 한 쪽의 최대 크기(E3-1). 쪽 크기는 소비처가 실제로 받는 포장(중재자 응답 본문·러너 근거 블록)의 UTF-8 바이트다.
// 요청자는 자기 도구 한도에 맞춰 더 작은 쪽을 고를 수 있다(중재자 batch 의 pageBytes).
export const EVIDENCE_PAGE_BYTES = 240_000;
// 단위 안 구간 — 유니코드 코드 포인트 오프셋 [offset, end), total 은 단위 본문의 코드 포인트 수. 서로게이트 쌍을 가르지 않는다.
export interface EvidenceRange { offset: number; end: number; total: number }
// 이 쪽 다음에 전달할 첫 항목. 단위 삭제는 unitId, 원문 삭제는 unitId null, offset 은 구간 시작이다.
export interface EvidenceCursor { sourceId: string; unitId: string | null; offset: number }

export const MediatorEvidenceInputSchema = z.object({ sessionId: z.string().trim().min(1).max(200) }).strict();
export const MediatorEvidenceBatchInputSchema = MediatorEvidenceInputSchema.extend({
  pageBytes: z.number().int().min(1).max(EVIDENCE_PAGE_BYTES).optional(),
});
export const MediatorEvidenceAckSchema = MediatorEvidenceInputSchema.extend({ batchId: z.string().uuid() });
export interface MediatorEvidenceBatch {
  batchId: string | null;
  digest: string;
  sources: Array<Pick<EvidenceSource, "id" | "url" | "contentHash" | "checkedAt">>;
  // range 가 있으면 content 는 그 구간만 담는다. 구간을 순서대로 이으면 단위 본문과 같다.
  changes: Array<EvidenceUnit & { sourceId: string; range?: EvidenceRange }>;
  removedSources: string[];
  removedUnits: Array<{ sourceId: string; unitId: string }>;
  images: Array<{ hash: string; path: string }>;
  // 이 쪽 뒤에 남은 항목 수(부분 전달한 단위는 1)와 다음 항목 위치. 남은 항목은 ack 뒤 다음 batch 가 잇는다.
  remaining: number;
  nextCursor: EvidenceCursor | null;
}
export interface MediatorEvidenceResponse extends MediatorEvidenceBatch {
  corpus?: { sources: number; units: number; search: string; read: string; guidance: string };
  currentDigest: string;
  superseded: boolean;
}
