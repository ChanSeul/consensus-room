import type { EvidenceDiscoveryLink, EvidenceDiscoveryPage, EvidenceSource, EvidenceUnitInput } from "../../shared/externalEvidence.js";
import { EvidenceFetchError, type EvidenceConnector } from "./connectors.js";
import { discoverLinks } from "./discovery.js";
import { appData, readerIdentity, validateReaderIdentity, type AppProvider, type AppReader, type ReaderIdentity } from "./nativeReader.js";
import { evidenceHash, stableJSON } from "./store.js";

type Data = Record<string, any>;
const requireArray = (value: unknown, label: string): any[] => {
  if (!Array.isArray(value)) throw new EvidenceFetchError(`${label} 전체 목록을 확인하지 못했습니다.`);
  return value;
};
function column(index: number): string {
  let result = "";
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) result = String.fromCharCode(65 + (n - 1) % 26) + result;
  return result;
}
function content(value: unknown): string { return typeof value === "string" ? value : stableJSON(value); }
function unit(id: string, kind: EvidenceUnitInput["kind"], value: unknown, author?: string, changedAt?: string): EvidenceUnitInput {
  return { id, kind, content: content(value), ...(author ? { author } : {}), ...(changedAt ? { changedAt } : {}) };
}
// Keep user-authored text intact. Remove only transport fields from structured responses.
function normalized(value: any): any {
  if (Array.isArray(value)) return value.map(normalized);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["self", "avatarUrls", "avatarUrl", "iconUrl", "_links", "updated", "modifiedTime", "fetchedAt"].includes(key)).map(([key, item]) => [key, normalized(item)]));
}
export class NativeEvidenceConnector implements EvidenceConnector {
  private readonly completedIdentities = new Map<string, ReaderIdentity>();
  constructor(private readonly reader: AppReader, private readonly onCall: (sourceId: string) => void = () => {}) {}
  configured(source: EvidenceSource): boolean { return source.provider !== "document"; }
  async fetch(): Promise<never> { throw new EvidenceFetchError("MCP 원문은 페이지별 루트 수집으로 읽으세요."); }
  async validateCachedSource(source: EvidenceSource, connectionKey: string, signal: AbortSignal): Promise<void> {
    const provider: AppProvider = source.provider === "jira" || source.provider === "confluence" ? "atlassian" : source.provider as AppProvider;
    const identity = await readerIdentity(this.reader, provider, signal, () => this.onCall(source.id));
    await validateReaderIdentity(this.reader, provider, identity, signal);
    const previous = this.completedIdentities.get(source.id);
    if (previous && previous.generation !== identity.generation) throw new EvidenceFetchError("수집 중 연결 계정이 바뀌었습니다. 전체 원문을 다시 확인해야 합니다.", 300, true);
    if (evidenceHash(stableJSON([provider, identity.account])) !== connectionKey) throw new EvidenceFetchError("MCP 연결 계정이 바뀌었습니다. 전체 원문을 다시 확인하세요.", 300, true);
  }
  async close(): Promise<void> { await this.reader.close(); }
  async discover(source: EvidenceSource, raw: string | null, signal: AbortSignal): Promise<EvidenceDiscoveryPage> {
    try { return await this.discoverPage(source, raw, signal); }
    catch (error) {
      // Reader transport/identity failures invalidate their own generation. A stale root cursor or
      // malformed page must not invalidate fresh cursors belonging to other roots of that provider.
      this.completedIdentities.delete(source.id); throw error;
    }
  }
  private async discoverPage(source: EvidenceSource, raw: string | null, signal: AbortSignal): Promise<EvidenceDiscoveryPage> {
    const cursor: Data = raw ? JSON.parse(raw) : {};
    const provider: AppProvider = source.provider === "jira" || source.provider === "confluence" ? "atlassian" : source.provider as AppProvider;
    if (!this.configured(source)) throw new EvidenceFetchError("이 문서는 등록된 MCP 수집기를 지원하지 않습니다.");
    const identity = await readerIdentity(this.reader, provider, signal, () => this.onCall(source.id));
    const { config, account } = identity;
    const call = async (name: string, args: Data, rawResult = false) => {
      this.onCall(source.id);
      const result = await this.reader.call(provider, name, args, signal);
      await validateReaderIdentity(this.reader, provider, identity, signal);
      return rawResult ? result as Data : appData(result);
    };
    const connectionKey = evidenceHash(stableJSON([provider, account]));
    if ((cursor.connectionKey && cursor.connectionKey !== connectionKey) || (cursor.identityGeneration && cursor.identityGeneration !== identity.generation)) throw new EvidenceFetchError("수집 중 연결 계정이 바뀌었습니다. 전체 원문을 다시 확인해야 합니다.", 300, true);
    const page = async (units: EvidenceUnitInput[], next: Data | null = null, links: EvidenceDiscoveryLink[] = []): Promise<EvidenceDiscoveryPage> => {
      await validateReaderIdentity(this.reader, provider, identity, signal);
      const discovered = discoverLinks(units, source.url);
      const chunks = units.flatMap(item => {
        const points = Array.from(item.content);
        if (item.content.length <= 150_000) return [item];
        const result: EvidenceUnitInput[] = [];
        for (let offset = 0; offset < points.length; offset += 60_000) result.push({ ...item, id: `${item.id.slice(0,110)}:${offset}`, content: points.slice(offset, offset + 60_000).join("") });
        return result;
      });
      if (next === null) this.completedIdentities.set(source.id, identity);
      return { units: chunks, links: [...links, ...discovered], cursor: next ? JSON.stringify({ ...next, connectionKey, identityGeneration: identity.generation }) : null,
        revision: evidenceHash(stableJSON(chunks)), ...(provider === "figma" ? { missing: ["현재 Figma 읽기 도구는 댓글을 제공하지 않습니다."] } : {}), connectionKey, accountConfirmed: Boolean(provider === "sheets" || config.accountIds?.[provider]) };
    };
    if (provider === "sheets") {
      const args = { link_id: account, spreadsheet_id: source.resource };
      if (!cursor.phase) {
        const data = await call("google_drive.get_spreadsheet_metadata", args);
        const sheets = requireArray(data.sheets, "시트").map(sheet => sheet.properties);
        if (sheets.some(sheet => !Number.isInteger(sheet?.sheetId) || !sheet.title || !Number.isInteger(sheet.gridProperties?.rowCount) || sheet.gridProperties.rowCount < 1 || !Number.isInteger(sheet.gridProperties?.columnCount) || sheet.gridProperties.columnCount < 1)) throw new EvidenceFetchError("시트의 탭과 범위를 확인하지 못했습니다.");
        return page([unit("workbook", "cells", { properties: data.properties, sheets })], { phase: "cells", sheets, sheet: 0, row: 0, col: 0 });
      }
      if (cursor.phase === "cells") {
        const sheet = cursor.sheets[cursor.sheet];
        if (!sheet) return page([], { phase: "comments" });
        const columns = sheet.gridProperties.columnCount, rows = sheet.gridProperties.rowCount;
        const colEnd = Math.min(columns, cursor.col + 100), rowEnd = Math.min(rows, cursor.row + Math.max(1, Math.floor(10000 / (colEnd - cursor.col))));
        const range = `'${sheet.title.replaceAll("'", "''")}'!${column(cursor.col + 1)}${cursor.row + 1}:${column(colEnd)}${rowEnd}`;
        const data = await call("google_drive.get_spreadsheet_cells", { ...args, ranges: [range], cell_fields: "userEnteredValue,effectiveValue,formattedValue,note,hyperlink,textFormatRuns,dataValidation" });
        const returned = requireArray(data.sheets, "셀").find(value => value.properties?.sheetId === sheet.sheetId);
        if (!returned) throw new EvidenceFetchError("시트 구성이 바뀌었습니다. 전체 원문을 다시 확인해야 합니다.", 300, true);
        if (!Array.isArray(returned.data)) throw new EvidenceFetchError("요청한 시트 범위의 응답이 없습니다.");
        const units: EvidenceUnitInput[] = [];
        for (const grid of returned.data) for (const [r, row] of (grid.rowData ?? []).entries()) for (const [c, cell] of (row.values ?? []).entries()) {
          if (Object.keys(cell).length) units.push(unit(`${sheet.sheetId}:${(grid.startRow ?? cursor.row) + r}:${(grid.startColumn ?? cursor.col) + c}`, "cells", cell));
        }
        const next: Data = { ...cursor, row: rowEnd, col: cursor.col };
        if (rowEnd === rows) { next.row = 0; next.col = colEnd; }
        if (next.col === columns) { next.col = 0; next.sheet++; }
        return page(units, next.sheet >= cursor.sheets.length ? { phase: "comments" } : next);
      }
      const data = await call("google_drive.get_spreadsheet_comments", { ...args, include_deleted: true, page_size: 100, ...(cursor.token ? { page_token: cursor.token } : {}) });
      const comments = requireArray(data.comments, "시트 댓글");
      return page(comments.map(c => unit(`comment:${c.id}`, "comment", normalized(c), c.author?.emailAddress ?? c.author?.displayName, c.modifiedTime)), data.nextPageToken ? { phase: "comments", token: data.nextPageToken } : null);
    }
    if (provider === "slack") {
      const [workspace, channel] = source.resource.split("/");
      const data = await call(source.selector ? "slack.slack_read_thread" : "slack.slack_read_channel", { channel_id: channel,
        ...(source.selector ? { message_ts: source.selector } : {}), limit: 100, response_format: "detailed", ...(cursor.token ? { cursor: cursor.token } : {}) });
      const units: EvidenceUnitInput[] = [];
      if (Array.isArray(data.messages)) {
        for (const message of data.messages) units.push(unit(message.ts, "message", normalized(message), message.user, message.edited?.ts ?? message.ts));
      } else if (typeof data.messages === "string") {
        const parts = data.messages.split(/(?=^=== Message from |^=== THREAD PARENT MESSAGE ===|^--- Reply \d+ of \d+ ---)/m)
          .filter((part: string) => /^(?:=== Message from |=== THREAD PARENT MESSAGE ===|--- Reply \d+ of \d+ ---)/m.test(part));
        for (const part of parts) {
          const ts = /^Message TS: (\d+\.\d+)/m.exec(part)?.[1];
          if (!ts) throw new EvidenceFetchError("Slack 메시지 식별자가 누락됐습니다.");
          units.push(unit(ts, "message", part.replace(/^=== THREAD REPLIES \(\d+ total\) ===\s*$/gm, "").replace(/^--- Reply \d+ of \d+ ---$/gm, "--- Reply ---").trim()));
        }
        if (!parts.length && !/no messages|empty/i.test(data.messages)) throw new EvidenceFetchError("Slack 메시지 응답 형식을 확인하지 못했습니다.");
      } else throw new EvidenceFetchError("Slack 메시지를 읽지 못했습니다.");
      const pagination = data.pagination_info ?? "";
      const token = data.response_metadata?.next_cursor || data.next_cursor || /cursor:\s*`([^`]+)`/.exec(pagination)?.[1];
      if (!token && (data.has_more || (/more messages|next page/i.test(pagination) && !/no more messages/i.test(pagination)))) throw new EvidenceFetchError("Slack 다음 페이지 커서가 없습니다.");
      const links = source.selector ? [] : units.map(item => ({ url: `https://${workspace}/archives/${channel}/p${item.id.replace(".", "")}`, label: `Slack ${item.id}`, unitId: item.id, relation: "child" as const }));
      return page(units, token ? { token } : null, links);
    }
    if (provider === "atlassian") {
      const [site, key] = source.resource.split("/");
      const cloudId = `https://${site}`;
      const read = (name: string, inputs: Data) => call("atlassian_rovo.executeRead", { cloudId, name, inputs, view: "full" });
      if (source.provider === "jira") {
        if (!cursor.phase) {
          const data = await call("atlassian_rovo.getJiraIssue", { cloudId, issueIdOrKey: key, view: "full", responseContentFormat: "html" });
          if (!data.key && !data.fields && !data.issue) throw new EvidenceFetchError("Jira 이슈 본문이 없습니다.");
          const issue = data.issue ?? data;
          const updated = issue.fields?.updated ?? issue.updated;
          if (typeof updated !== "string") throw new EvidenceFetchError("Jira 이슈 버전을 확인하지 못했습니다.");
          const links = [...(issue.fields?.subtasks ?? issue.subtasks ?? []), ...(issue.fields?.issuelinks ?? issue.links ?? []).flatMap((l: Data) => [l.inwardIssue, l.outwardIssue].filter(Boolean))]
            .filter((item: Data) => /^[A-Z][A-Z0-9_]*-\d+$/.test(item.key)).map((item: Data) => ({ url: `https://${site}/browse/${item.key}`, label: item.key, unitId: key, relation: "child" as const }));
          return page([unit(key, "issue", normalized(issue))], { phase: "comments", start: 0, updated }, links);
        }
        if (cursor.phase === "comments") {
          const data = await read("listJiraIssueComments", { issueIdOrKey: key, startAt: cursor.start, maxResults: 20, orderBy: "created", responseContentFormat: "html" });
          const comments = requireArray(data.comments, "Jira 댓글");
          if (!Number.isInteger(data.total) || data.startAt !== cursor.start || (cursor.total !== undefined && cursor.total !== data.total)) throw new EvidenceFetchError("Jira 댓글 목록이 수집 중 바뀌었습니다.", 300, true);
          const end = cursor.start + comments.length;
          if (end < data.total && !comments.length) throw new EvidenceFetchError("Jira 댓글 페이지가 누락됐습니다.");
          return page(comments.map(c => unit(`comment:${c.id}`, "comment", normalized(c), c.author?.accountId, c.updated)), end < data.total ? { phase: "comments", start: end, total: data.total, updated: cursor.updated } : { phase: "children", updated: cursor.updated });
        }
        if (cursor.phase === "children") {
          const data = await call("atlassian_rovo.searchJiraIssuesUsingJql", { cloudId, jql: `parent = "${key}" ORDER BY key`, maxResults: 100, fields: ["summary"], ...(cursor.token ? { nextPageToken: cursor.token } : {}) });
          const issues = requireArray(data.issues, "Jira 하위 티켓");
          if (!data.isLast && !data.nextPageToken) throw new EvidenceFetchError("Jira 하위 티켓 페이지가 완전하지 않습니다.");
          return page([], data.nextPageToken ? { phase: "children", token: data.nextPageToken, updated: cursor.updated } : { phase: "remote", updated: cursor.updated }, issues.map(issue => ({ url: `https://${site}/browse/${issue.key}`, label: issue.key, unitId: key, relation: "child" as const })));
        }
        const data = await read("listJiraIssueRemoteIssueLinks", { issueIdOrKey: key });
        const links = requireArray(Array.isArray(data) ? data : data.links ?? data.remoteIssueLinks, "Jira 외부 링크");
        const verified = await call("atlassian_rovo.getJiraIssue", { cloudId, issueIdOrKey: key, fields: ["updated"], view: "full" });
        const end = verified.issue ?? verified;
        if (typeof cursor.updated !== "string" || (end.fields?.updated ?? end.updated) !== cursor.updated) throw new EvidenceFetchError("수집 중 Jira 원문이 바뀌었습니다. 처음부터 다시 확인합니다.", 300, true);
        return page([unit("remote-links", "issue", normalized(links))], null, links.filter(link => link.object?.url).map(link => ({ url: link.object.url, label: link.object.title ?? link.object.url, unitId: "remote-links", relation: "link" as const })));
      }
      if (!cursor.phase) {
        const data = await call("atlassian_rovo.getConfluenceContent", { cloudId, content_id: key, detail: "full", content_format: "html" });
        if (!data.body && !data.content) throw new EvidenceFetchError("Confluence 본문이 없습니다.");
        const canonical = normalized(data);
        if (canonical.metadata) delete canonical.metadata.totalViews;
        return page([unit(key, "document", canonical)], { phase: "comments" });
      }
      if (cursor.phase === "comments") {
        const data = await read("listConfluenceComments", { "content-id": key, "include-replies": true, "body-format": "html", limit: 100, ...(cursor.token ? { cursor: cursor.token } : {}) });
        const comments = requireArray(data.comments ?? data.results, "Confluence 댓글");
        if (data.hasMore && !data.nextCursor) throw new EvidenceFetchError("Confluence 댓글 페이지가 누락됐습니다.");
        return page(comments.map(c => unit(`comment:${c.id}`, "comment", normalized(c))), data.nextCursor ? { phase: "comments", token: data.nextCursor } : { phase: "children" });
      }
      const data = await read("getConfluenceContentDescendants", { contentId: key, depth: 1, limit: 100, ...(cursor.token ? { cursor: cursor.token } : {}) });
      const children = requireArray(data.results ?? data.descendants, "Confluence 하위 페이지");
      const token = data.nextCursor || (data._links?.next ? new URL(data._links.next, source.url).searchParams.get("cursor") : null);
      if (data._links?.next && !token) throw new EvidenceFetchError("Confluence 하위 페이지 커서가 없습니다.");
      return page([], token ? { phase: "children", token } : null, children.map(child => ({ url: `https://${site}/wiki/pages/${child.id}`, label: child.title ?? child.id, unitId: key, relation: "child" as const })));
    }
    const args = { fileKey: source.resource, nodeId: source.selector };
    const tool = cursor.phase ?? "get_metadata";
    const allowed = ["get_metadata", "get_design_context", "get_variable_defs", "get_screenshot"];
    if (!allowed.includes(tool)) throw new EvidenceFetchError("알 수 없는 Figma 수집 단계입니다.");
    const data = await call(`figma.${tool}`, { ...args, ...(tool === "get_design_context" ? { excludeScreenshot: true, disableCodeConnect: true } : {}) }, true);
    const parts = requireArray(data.content, "Figma 원문");
    const units = parts.map((part, index) => {
      if (part.type === "image") {
        if (part.mimeType !== "image/png") throw new EvidenceFetchError("Figma 이미지 형식을 확인하세요.");
        return { ...unit(`${tool}:${index}`, "render", "Figma node screenshot"), imageBase64: part.data };
      }
      if (part.type !== "text") throw new EvidenceFetchError("Figma 원문 일부를 읽지 못했습니다.");
      return unit(`${tool}:${index}`, "design", part.text.replace(/https:\/\/www\.figma\.com\/api\/mcp\/asset\/[^\s"'<>`)]+/g, "[Figma asset; see captured screenshot]"));
    });
    const next = allowed[allowed.indexOf(tool) + 1];
    return page(units, next ? { phase: next } : null);
  }
}
