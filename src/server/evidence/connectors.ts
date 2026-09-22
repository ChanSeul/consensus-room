import type { EvidenceSnapshot, EvidenceSource, EvidenceUnitInput } from "../../shared/externalEvidence.js";
import { evidenceHash, stableJSON } from "./store.js";

type JSONRecord = Record<string, any>;
export interface EvidenceFetchResult { revision: string; units?: EvidenceUnitInput[]; unchanged?: boolean }
export interface EvidenceConnector { fetch(source: EvidenceSource, previous: EvidenceSnapshot | null, signal: AbortSignal): Promise<EvidenceFetchResult> }
export interface EvidenceCredentials { slackToken?: string; slackWorkspace?: string; jiraSite?: string; jiraEmail?: string; jiraToken?: string; figmaToken?: string }
export class EvidenceFetchError extends Error { constructor(message: string, readonly retryAfterSeconds = 300) { super(message); } }

// These credentials belong to the host collector. Never add them to a model process environment.
export function evidenceCredentials(env = process.env): EvidenceCredentials {
  return { slackToken: env.CONSENSUS_EVIDENCE_SLACK_TOKEN, slackWorkspace: env.CONSENSUS_EVIDENCE_SLACK_WORKSPACE,
    jiraSite: env.CONSENSUS_EVIDENCE_JIRA_SITE, jiraEmail: env.CONSENSUS_EVIDENCE_JIRA_EMAIL,
    jiraToken: env.CONSENSUS_EVIDENCE_JIRA_TOKEN, figmaToken: env.CONSENSUS_EVIDENCE_FIGMA_TOKEN };
}
async function boundedBody(response: Response, limit: number): Promise<Buffer> {
  if (!response.body) throw new EvidenceFetchError("원문 응답이 비어 있습니다.");
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      size += result.value.length;
      if (size > limit) throw new EvidenceFetchError("원문이 너무 큽니다. 확인 범위를 나누세요.");
      chunks.push(result.value);
    }
  } finally { await reader.cancel().catch(() => undefined); }
  return Buffer.concat(chunks);
}
export class RestEvidenceConnector implements EvidenceConnector {
  constructor(private readonly credentials: EvidenceCredentials, private readonly request: typeof fetch = fetch) {}
  private async json(url: URL, headers: Record<string, string>, signal: AbortSignal): Promise<JSONRecord> {
    const response = await this.request(url, { headers, signal, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      const retry = response.headers.get("retry-after");
      const seconds = retry && /^\d+$/.test(retry) ? Number(retry) : retry ? Math.ceil((Date.parse(retry) - Date.now()) / 1000) : 300;
      throw new EvidenceFetchError(`원문 조회 실패 (HTTP ${response.status}). 연결 권한과 요청 한도를 확인하세요.`, Number.isFinite(seconds) ? seconds : 300);
    }
    return JSON.parse((await boundedBody(response, 12_000_000)).toString("utf8"));
  }
  async fetch(source: EvidenceSource, previous: EvidenceSnapshot | null, signal: AbortSignal): Promise<EvidenceFetchResult> {
    const bounded = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
    if (source.provider === "slack") return this.slack(source, bounded);
    if (source.provider === "jira") return this.jira(source, previous, bounded);
    return this.figma(source, previous, bounded);
  }
  private async slack(source: EvidenceSource, signal: AbortSignal): Promise<EvidenceFetchResult> {
    const [workspace, channel] = source.resource.split("/");
    if (!this.credentials.slackToken || this.credentials.slackWorkspace !== workspace) throw new EvidenceFetchError("Slack 호스트 연결이 없습니다. connector 방식으로 수집하거나 해당 워크스페이스 연결을 설정하세요.");
    const units: EvidenceUnitInput[] = []; let cursor = ""; const cursors = new Set<string>();
    for (let page = 0; page < 100; page++) {
      const url = new URL("https://slack.com/api/conversations.replies");
      url.search = new URLSearchParams({ channel, ts: source.selector, limit: "100", ...(cursor ? { cursor } : {}) }).toString();
      const data = await this.json(url, { Authorization: `Bearer ${this.credentials.slackToken}` }, signal);
      if (!data.ok || !Array.isArray(data.messages)) throw new EvidenceFetchError("Slack 스레드를 읽지 못했습니다. 읽기 권한과 원문 존재 여부를 확인하세요.");
      for (const message of data.messages) {
        units.push({ id: String(message.ts), kind: "message", author: message.user ?? message.bot_id,
          changedAt: message.edited?.ts ?? message.ts,
          content: stableJSON({ text: message.text, blocks: message.blocks, attachments: message.attachments,
            files: message.files?.map((file: JSONRecord) => ({ id: file.id, name: file.name, permalink: file.permalink, timestamp: file.timestamp })) }) });
      }
      cursor = data.response_metadata?.next_cursor ?? "";
      if (!cursor) {
        if (data.has_more) throw new EvidenceFetchError("Slack 페이지가 일부만 도착했습니다.");
        if (!units.some(u => u.id === source.selector)) throw new EvidenceFetchError("Slack 원문 메시지를 찾지 못했습니다.");
        return { revision: evidenceHash(stableJSON(units)), units };
      }
      if (cursors.has(cursor)) break; cursors.add(cursor);
    }
    throw new EvidenceFetchError("Slack 스레드가 너무 크거나 페이지가 반복됩니다. 일부 내용으로 갱신하지 않았습니다.");
  }
  private async jira(source: EvidenceSource, previous: EvidenceSnapshot | null, signal: AbortSignal): Promise<EvidenceFetchResult> {
    const [site, key] = source.resource.split("/"); const credentials = this.credentials;
    if (credentials.jiraSite !== `https://${site}` || !credentials.jiraEmail || !credentials.jiraToken) throw new EvidenceFetchError("Jira 호스트 연결이 없습니다. connector 방식으로 수집하거나 해당 사이트 연결을 설정하세요.");
    const headers = { Authorization: `Basic ${Buffer.from(`${credentials.jiraEmail}:${credentials.jiraToken}`).toString("base64")}`, Accept: "application/json" };
    const issueURL = `https://${site}/rest/api/3/issue/${encodeURIComponent(key)}`;
    const probe = await this.json(new URL(`${issueURL}?fields=updated`), headers, signal);
    const revision = probe.fields?.updated;
    if (typeof revision !== "string") throw new EvidenceFetchError("Jira 변경 시각을 확인하지 못했습니다.");
    const cachedIssue = previous?.units.find(unit => unit.id === key && unit.kind === "issue");
    const units: EvidenceUnitInput[] = [];
    if (cachedIssue && revision === source.revision) {
      units.push({ id: key, kind: "issue", content: cachedIssue.content, changedAt: cachedIssue.changedAt });
    } else {
      const issue = await this.json(new URL(`${issueURL}?fields=summary,description,status,assignee,reporter,issuelinks,subtasks,attachment,updated`), headers, signal);
      if (issue.fields?.updated !== revision) throw new EvidenceFetchError("Jira를 읽는 동안 원문이 바뀌었습니다. 다음 확인에서 다시 읽습니다.");
      const { updated: _updated, ...fields } = issue.fields;
      units.push({ id: key, kind: "issue", content: stableJSON(fields), changedAt: revision });
    }
    // An issue timestamp alone does not prove that every comment is unchanged.
    let total: number | undefined;
    for (let startAt = 0; startAt < 5000;) {
      const page = await this.json(new URL(`${issueURL}/comment?startAt=${startAt}&maxResults=100&orderBy=created`), headers, signal);
      if (!Array.isArray(page.comments) || !Number.isInteger(page.total) || page.total < 0 || page.startAt !== startAt) throw new EvidenceFetchError("Jira 댓글 페이지가 올바르지 않습니다.");
      if (total !== undefined && page.total !== total) throw new EvidenceFetchError("Jira 댓글 목록이 수집 중 바뀌었습니다. 다음 확인에서 다시 읽습니다.");
      total = page.total;
      for (const comment of page.comments) units.push({ id: `comment:${comment.id}`, kind: "comment", content: stableJSON(comment.body), author: comment.author?.displayName ?? comment.author?.accountId, changedAt: comment.updated });
      startAt += page.comments.length;
      if (startAt >= page.total) {
        const end = await this.json(new URL(`${issueURL}?fields=updated`), headers, signal);
        if (end.fields?.updated !== revision) throw new EvidenceFetchError("Jira 댓글 수집 중 변경이 생겼습니다. 일부 버전을 채택하지 않았습니다.");
        return { revision, units };
      }
      if (!page.comments.length) break;
    }
    throw new EvidenceFetchError("Jira 댓글을 끝까지 읽지 못했습니다.");
  }
  private async figma(source: EvidenceSource, previous: EvidenceSnapshot | null, signal: AbortSignal): Promise<EvidenceFetchResult> {
    if (!this.credentials.figmaToken) throw new EvidenceFetchError("Figma 호스트 연결이 없습니다. connector 방식으로 수집하거나 읽기 토큰을 설정하세요.");
    const headers = { "X-Figma-Token": this.credentials.figmaToken };
    const base = `https://api.figma.com/v1/files/${source.resource}`;
    const meta = await this.json(new URL(`${base}/meta`), headers, signal);
    const revision = meta.file?.version;
    if (typeof revision !== "string" || !revision) throw new EvidenceFetchError("Figma 파일 버전을 확인하지 못했습니다.");
    const units: EvidenceUnitInput[] = [];
    // Comments can change without a design version bump. Always check them independently.
    const comments = await this.json(new URL(`${base}/comments`), headers, signal);
    if (!Array.isArray(comments.comments)) throw new EvidenceFetchError("Figma 댓글을 확인하지 못했습니다.");
    let nodeIds = new Set<string>();
    if (previous && source.revision === revision) {
      for (const unit of previous.units.filter(u => u.kind === "design" || u.kind === "render")) {
        const { contentHash: _hash, imageHash: _image, ...plain } = unit; units.push(plain);
        if (unit.kind === "design") nodeIds.add(unit.id.replace(/^node:/, ""));
      }
    } else {
      const url = new URL(`${base}/nodes`); url.search = new URLSearchParams({ ids: source.selector, version: revision }).toString();
      const data = await this.json(url, headers, signal);
      const node = data.nodes?.[source.selector];
      if (!node?.document) throw new EvidenceFetchError("선택한 Figma 노드가 없거나 접근할 수 없습니다.");
      const visit = (current: JSONRecord): void => {
        const { children, ...properties } = current;
        if (typeof current.id !== "string" || nodeIds.has(current.id)) throw new EvidenceFetchError("Figma 노드 구조가 올바르지 않습니다.");
        nodeIds.add(current.id);
        units.push({ id: `node:${current.id}`, kind: "design", content: stableJSON({ ...properties, children: children?.map((child: JSONRecord) => child.id) }) });
        for (const child of children ?? []) visit(child);
      };
      visit(node.document);
      units.push({ id: "dependencies", kind: "design", content: stableJSON({ components: node.components, componentSets: node.componentSets, styles: node.styles }) });
      const subtreeHash = evidenceHash(stableJSON(units));
      const previousRender = previous?.units.find(u => u.id === `render:${source.selector}`);
      const render: EvidenceUnitInput = { id: `render:${source.selector}`, kind: "render", content: subtreeHash };
      if (previousRender?.content !== subtreeHash || !previousRender.imageHash) {
        const imageURL = new URL(`https://api.figma.com/v1/images/${source.resource}`);
        imageURL.search = new URLSearchParams({ ids: source.selector, version: revision, format: "png", scale: "1" }).toString();
        const response = await this.json(imageURL, headers, signal);
        const target = response.images?.[source.selector];
        if (typeof target !== "string") throw new EvidenceFetchError("Figma 화면 렌더링에 실패했습니다.");
        const asset = new URL(target);
        if (asset.protocol !== "https:" || asset.port || asset.username || asset.password ||
          ![".amazonaws.com", ".figma.com"].some(suffix => asset.hostname.endsWith(suffix))) throw new EvidenceFetchError("허용하지 않은 Figma 이미지 주소입니다.");
        const image = await this.request(asset, { signal, redirect: "error" });
        if (!image.ok) { await image.body?.cancel(); throw new EvidenceFetchError("Figma 이미지를 받지 못했습니다."); }
        render.imageBase64 = (await boundedBody(image, 4_000_000)).toString("base64");
      }
      units.push(render);
    }
    for (const comment of comments.comments) {
      // File-wide comments are retained because unanchored decisions may apply to the watched screen.
      if (comment.client_meta?.node_id && !nodeIds.has(comment.client_meta.node_id)) continue;
      units.push({ id: `comment:${comment.id}`, kind: "comment", author: comment.user?.handle,
        changedAt: comment.created_at, content: stableJSON({ message: comment.message, parent_id: comment.parent_id, resolved_at: comment.resolved_at, client_meta: comment.client_meta }) });
    }
    return { revision, units };
  }
}
