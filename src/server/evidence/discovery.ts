import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import type { EvidenceDiscoveryLink, EvidenceDiscoveryPage, EvidenceSource, EvidenceUnitInput } from "../../shared/externalEvidence.js";
import { EvidenceFetchError, jiraApiBase, type EvidenceCredentials, type EvidenceFetchResult } from "./connectors.js";
import { evidenceHash, stableJSON } from "./store.js";

type ObjectData = Record<string, any>;
export function discoverLinks(units: EvidenceUnitInput[], baseURL?: string): EvidenceDiscoveryLink[] {
  const stripTransportMetadata = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripTransportMetadata);
    if (!value || typeof value !== "object") return value;
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["self","avatarUrls","avatarUrl","iconUrl","thumbnail","_links"].includes(key))
      .map(([key,item]) => [key,stripTransportMetadata(item)]));
  };
  return units.flatMap(unit => {
    let body = unit.content;
    try { body = JSON.stringify(stripTransportMetadata(JSON.parse(body))); } catch { /* Plain text. */ }
    const rawLinks = [...body.matchAll(/https?:\/\/[^\s<>"'\\]+/g)].map(match=>match[0]);
    const html = body.replaceAll('\\"','"');
    for (const match of html.matchAll(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
      const value=match[1] ?? match[2] ?? match[3];
      if (value.startsWith("#")) continue;
      try { rawLinks.push(new URL(value.replaceAll("&amp;","&"),baseURL).href); } catch { /* Unsupported reference stays outside the HTTPS graph. */ }
    }
    return [...new Set(rawLinks.map(value=>value.replace(/[),.;\]}]+$/, "").replaceAll("&amp;", "&").split("|")[0]))]
      .filter(url=>url.startsWith("https://") && !/\.(?:png|jpe?g|gif|svg|webp|css|js)(?:[?#]|$)/i.test(url))
      .map(url=>({url,label:url,unitId:unit.id,relation:"link" as const}));
  });
}

function assemblePage(units: EvidenceUnitInput[], next: unknown = null, links: EvidenceDiscoveryLink[] = [], baseURL?: string): EvidenceDiscoveryPage {
  units = units.flatMap(item => {
    if (item.content.length <= 150_000) return [item];
    const points = Array.from(item.content), chunks: EvidenceUnitInput[] = [];
    for (let offset = 0; offset < points.length; offset += 60000)
      chunks.push({ ...item, id: `${item.id.slice(0,110)}:${evidenceHash(item.id)}:${offset}`, content: points.slice(offset,offset+60000).join("") });
    return chunks;
  });
  return { units, links: [...links, ...discoverLinks(units,baseURL)], cursor: next === null ? null : JSON.stringify(next), revision: evidenceHash(stableJSON(units)) };
}
const unit = (id: string, kind: EvidenceUnitInput["kind"], content: unknown, author?: string, changedAt?: string): EvidenceUnitInput =>
  ({ id, kind, content: typeof content === "string" ? content : stableJSON(content), author, changedAt });
export function publicAddress(address: string): boolean {
  if (isIP(address) !== 4) return false;
  const [a,b,c] = address.split(".").map(Number);
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113));
}
// Pin the validated address to the socket: a second DNS lookup must not reach an internal address.
export async function readPublicDocument(url: URL, signal: AbortSignal): Promise<string> {
  const addresses = await lookup(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicAddress(a.address))) throw new EvidenceFetchError("내부 네트워크 문서는 자동 수집하지 않습니다.");
  return new Promise((resolve, reject) => {
    const req = httpsRequest(url, { signal, agent: false, family: 4, lookup: (_host, _options, callback) => {
      callback(null, addresses[0].address, 4);
    } }, response => {
      if (response.statusCode !== 200) { response.destroy(); reject(new EvidenceFetchError(`문서 조회 실패 (HTTP ${response.statusCode}). 리다이렉트는 자동으로 따르지 않습니다.`)); return; }
      const chunks: Buffer[] = []; let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > 12_000_000) response.destroy(new EvidenceFetchError("문서가 페이지 크기 제한을 넘었습니다. 완료로 처리하지 않았습니다."));
        else chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    });
    req.on("error", reject); req.end();
  });
}
export async function collectPage(source: EvidenceSource, rawCursor: string | null, credentials: EvidenceCredentials,
  request: typeof fetch, signal: AbortSignal, fallback: () => Promise<EvidenceFetchResult>,
  documentReader = readPublicDocument): Promise<EvidenceDiscoveryPage> {
  const cursor: ObjectData = rawCursor === null ? {} : JSON.parse(rawCursor);
  const page=(units:EvidenceUnitInput[],next:unknown=null,links:EvidenceDiscoveryLink[]=[])=>assemblePage(units,next,links,source.url);
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(90_000)]);
  const read = async (url: string, headers: Record<string,string> = {}): Promise<string> => {
    const response = await request(url, { headers, signal: bounded, redirect: "error" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new EvidenceFetchError(`원문 조회 실패 (HTTP ${response.status}). 이전 수집 결과는 보존했습니다.`, Number(response.headers.get("retry-after")) || 300, [400,410].includes(response.status));
    }
    const reader = response.body?.getReader(); if (!reader) throw new EvidenceFetchError("원문 응답이 비었습니다.");
    const parts: Uint8Array[] = []; let bytes = 0;
    try {
      for (;;) { const p = await reader.read(); if (p.done) break;
        bytes += p.value.length; if (bytes > 12_000_000) throw new EvidenceFetchError("이 페이지는 수집 크기 제한을 넘었습니다. 완료로 처리하지 않았습니다.");
        parts.push(p.value);
      }
    } finally { await reader.cancel().catch(() => undefined); }
    return Buffer.concat(parts).toString("utf8");
  };
  const json = async (url: string, headers?: Record<string,string>): Promise<ObjectData> => JSON.parse(await read(url, headers));
  if (source.provider === "slack") {
    const [workspace, channel] = source.resource.split("/");
    const slack = async (method: string, args: Record<string,string> = {}) => {
      const data = await json(`https://slack.com/api/${method}?${new URLSearchParams({ channel, ...args })}`, { Authorization: `Bearer ${credentials.slackToken}` });
      if (!data.ok) throw new EvidenceFetchError("Slack 원문·답글 읽기에 실패했습니다. 연결과 접근 범위를 확인하세요.", 300, data.error === "invalid_cursor");
      return data;
    };
    if (!source.selector && !cursor.stage) {
      const info = await slack("conversations.info"), pins = await slack("pins.list");
      return page([unit("channel", "document", { name: info.channel?.name, topic: info.channel?.topic, purpose: info.channel?.purpose, pins: pins.items })], { stage: "messages" });
    }
    const data = await slack(source.selector ? "conversations.replies" : "conversations.history",
      { limit: "100", ...(source.selector ? { ts: source.selector } : {}), ...(cursor.next ? { cursor: cursor.next } : {}) });
    if (!Array.isArray(data.messages)) throw new EvidenceFetchError("Slack 메시지 목록이 없습니다.");
    const parentSeen = cursor.parentSeen || !source.selector || data.messages.some((m:ObjectData)=>m.ts===source.selector);
    const units = data.messages.map((m: ObjectData) => unit(String(m.ts), "message", {
      text: m.text, blocks: m.blocks, attachments: m.attachments, files: m.files?.map((f: ObjectData) => ({ id: f.id, name: f.name, permalink: f.permalink })),
    }, m.user ?? m.bot_id, m.edited?.ts ?? m.ts));
    const links: EvidenceDiscoveryLink[] = source.selector ? [] : data.messages.filter((m: ObjectData) => Number(m.reply_count) > 0).map((m: ObjectData) => ({
      url: `https://${workspace}/archives/${channel}/p${String(m.ts).replace(".", "")}`, label: `Slack ${m.ts}`, unitId: String(m.ts), relation: "child" }));
    const next = data.response_metadata?.next_cursor;
    if (!next && data.has_more) throw new EvidenceFetchError("Slack 다음 페이지를 확인할 수 없습니다.");
    if (!next && !parentSeen) throw new EvidenceFetchError("Slack 원문 메시지를 찾지 못했습니다.",300,true);
    return page(units, next ? { stage: "messages", next, parentSeen } : null, links);
  }
  if (source.provider === "jira" || source.provider === "confluence") {
    const [host, key] = source.resource.split("/");
    const headers = { Authorization: `Basic ${Buffer.from(`${credentials.jiraEmail}:${credentials.jiraToken}`).toString("base64")}`, Accept: "application/json" };
    if (source.provider === "confluence") {
      if (!cursor.stage) {
        const doc = await json(`https://${host}/wiki/api/v2/pages/${key}?body-format=storage`, headers);
        return page([unit(`page:${key}`, "document", doc)], { stage: "comments" });
      }
      const suffix = cursor.kind === "inline" || cursor.stage === "inline" ? "inline-comments" : "footer-comments";
      const endpoint = cursor.stage === "replies" ? `${suffix}/${encodeURIComponent(cursor.queue[0])}/children` : `pages/${key}/${suffix}`;
      const data = await json(`https://${host}/wiki/api/v2/${endpoint}?body-format=storage&limit=100${cursor.next ? `&cursor=${encodeURIComponent(cursor.next)}` : ""}`, headers);
      if (!Array.isArray(data.results)) throw new EvidenceFetchError("Confluence 댓글 목록이 없습니다.");
      const nextLink = data._links?.next;
      const next = nextLink ? new URL(nextLink, `https://${host}`).searchParams.get("cursor") : null;
      if (nextLink && !next) throw new EvidenceFetchError("Confluence 다음 댓글 페이지를 확인하지 못했습니다.");
      const seen: string[] = cursor.seen ?? [];
      const ids = data.results.map((c: ObjectData) => String(c.id)).filter((id: string) => !seen.includes(id));
      const queue = [...(cursor.queue ?? []), ...ids];
      let continuation: ObjectData | null;
      if (next) continuation = { ...cursor, queue, seen: [...seen, ...ids], next };
      else {
        if (cursor.stage === "replies") queue.shift();
        continuation = queue.length ? { stage: "replies", kind: suffix === "inline-comments" ? "inline" : "footer", queue, seen: [...seen, ...ids] }
          : suffix === "footer-comments" ? { stage: "inline" } : null;
      }
      return page(data.results.map((c: ObjectData) => unit(`comment:${c.id}`, "comment", c)), continuation);
    }

    const apiBase = jiraApiBase(host, credentials);
    const base = `${apiBase}/issue/${encodeURIComponent(key)}`;
    if (!cursor.stage) {
      const issue = await json(`${base}?fields=*all`, headers);
      const links: EvidenceDiscoveryLink[] = (issue.fields?.subtasks ?? []).map((child: ObjectData) => ({
        url: `https://${host}/browse/${child.key}`, label: child.fields?.summary ?? child.key, unitId: key, relation: "child" }));
      for (const link of issue.fields?.issuelinks ?? []) for (const child of [link.inwardIssue, link.outwardIssue].filter(Boolean))
        links.push({ url: `https://${host}/browse/${child.key}`, label: child.fields?.summary ?? child.key, unitId: key, relation: "link" });
      return page([unit(key, "issue", issue.fields, issue.fields?.reporter?.displayName, issue.fields?.updated)], { stage: "comments", start: 0, updated: issue.fields?.updated }, links);
    }
    if (cursor.stage === "comments") {
      const data = await json(`${base}/comment?startAt=${cursor.start}&maxResults=100&orderBy=created`, headers);
      if (!Array.isArray(data.comments) || data.startAt !== cursor.start || !Number.isInteger(data.total) || (cursor.total !== undefined && cursor.total !== data.total)) throw new EvidenceFetchError("Jira 댓글 페이지가 불완전합니다.",300,true);
      const next = cursor.start + data.comments.length;
      if (next < data.total && !data.comments.length) throw new EvidenceFetchError("Jira 댓글 페이지 진행이 멈췄습니다.");
      return page(data.comments.map((c: ObjectData) => unit(`comment:${c.id}`, "comment", c.body, c.author?.displayName, c.updated)),
        next < data.total ? { ...cursor, start: next, total: data.total } : { stage: "children", updated: cursor.updated });
    }
    if (cursor.stage === "children") {
      const data = await json(`${apiBase}/search/jql?${new URLSearchParams({ jql: `parent = "${key}"`, fields: "summary", maxResults: "100", ...(cursor.next ? { nextPageToken: cursor.next } : {}) })}`, headers);
      if (!Array.isArray(data.issues) || (!data.isLast && !data.nextPageToken)) throw new EvidenceFetchError("Jira 하위 티켓 검색이 불완전합니다.");
      return page([], data.nextPageToken ? { ...cursor, next: data.nextPageToken } : { stage: "remote", updated: cursor.updated },
        data.issues.map((child: ObjectData) => ({ url: `https://${host}/browse/${child.key}`, label: child.fields?.summary ?? child.key, unitId: key, relation: "child" })));
    }
    const remote = await json(`${base}/remotelink`, headers);
    if (!Array.isArray(remote)) throw new EvidenceFetchError("Jira 연결 문서 목록이 없습니다.");
    const end = await json(`${base}?fields=updated`, headers);
    if (typeof cursor.updated !== "string" || end.fields?.updated !== cursor.updated) throw new EvidenceFetchError("수집 중 Jira 원문이 바뀌었습니다. 처음부터 다시 확인합니다.",300,true);
    return page([unit(`${key}:remote-links`, "document", remote)]);
  }
  if (source.provider === "sheets") {
    const headers = { Authorization: `Bearer ${credentials.googleToken}` };
    const base = `https://sheets.googleapis.com/v4/spreadsheets/${source.resource}`;
    const versionURL = `https://www.googleapis.com/drive/v3/files/${source.resource}?fields=version,modifiedTime`;
    if (!cursor.stage) {
      const version = await json(versionURL, headers);
      if (typeof version.version !== "string") throw new EvidenceFetchError("정책서 버전을 확인하지 못했습니다.");
      const meta = await json(`${base}?includeGridData=false&fields=spreadsheetId,properties,sheets(properties),namedRanges`, headers);
      if (!Array.isArray(meta.sheets)) throw new EvidenceFetchError("정책서 탭 목록이 없습니다.");
      const tabs = meta.sheets.filter((s: ObjectData) => s.properties.gridProperties).map((s: ObjectData) => s.properties);
      return page([unit("workbook", "document", meta)], { stage: "cells", tabs, tab: 0, row: 0, column: 0, version: version.version });
    }
    if (cursor.stage === "cells" && cursor.tab < cursor.tabs.length) {
      const tab = cursor.tabs[cursor.tab], grid = tab.gridProperties;
      const endRow = Math.min(cursor.row + 100, grid.rowCount), endColumn = Math.min(cursor.column + 40, grid.columnCount);
      const col = (n: number): string => { let s = ""; for (n++; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + (n - 1) % 26) + s; return s; };
      const range = `'${String(tab.title).replaceAll("'", "''")}'!${col(cursor.column)}${cursor.row + 1}:${col(endColumn - 1)}${endRow}`;
      const data = await json(`${base}?${new URLSearchParams({ ranges: range, includeGridData: "true", fields: "sheets(data(startRow,startColumn,rowData(values(formattedValue,userEnteredValue,note,hyperlink,textFormatRuns,chipRuns))),merges)" })}`, headers);
      let next: ObjectData = { ...cursor, column: endColumn };
      if (endColumn >= grid.columnCount) next = { ...cursor, column: 0, row: endRow };
      if (next.row >= grid.rowCount) next = { ...cursor, tab: cursor.tab + 1, row: 0, column: 0 };
      if (next.tab >= cursor.tabs.length) next = { stage: "comments", version: cursor.version };
      return page([unit(`sheet:${tab.sheetId}:${cursor.row}:${cursor.column}`, "cells", { sheetId: tab.sheetId, title: tab.title, range, data })], next);
    }
    const data = await json(`https://www.googleapis.com/drive/v3/files/${source.resource}/comments?${new URLSearchParams({
      fields: "nextPageToken,comments(id,content,modifiedTime,createdTime,deleted,resolved,author(displayName),replies,anchor,quotedFileContent)", includeDeleted: "true", pageSize: "100", ...(cursor.next ? { pageToken: cursor.next } : {}) })}`, headers);
    if (!Array.isArray(data.comments)) throw new EvidenceFetchError("정책서 댓글 목록을 확인하지 못했습니다.");
    if (!data.nextPageToken && (await json(versionURL, headers)).version !== cursor.version) throw new EvidenceFetchError("수집 중 정책서가 바뀌었습니다. 처음부터 다시 확인합니다.",300,true);
    return page(data.comments.map((c: ObjectData) => unit(`comment:${c.id}`, "comment", c, c.author?.displayName, c.modifiedTime)),
      data.nextPageToken ? { stage: "comments", next: data.nextPageToken, version: cursor.version } : null);
  }
  if (source.provider === "document") {
    const url = new URL(source.url);
    const body = await documentReader(url, bounded);
    const embedded = /apiDescriptionDocument\s*=\s*("(?:[^"\\]|\\.)*")\s*;/.exec(body);
    let spec: ObjectData | null = null;
    try { spec = JSON.parse(embedded ? JSON.parse(embedded[1]) : body); } catch { /* Read ordinary HTML below. */ }
    if (spec?.openapi && spec.paths) {
      const {paths:_paths,components:_components,...metadata}=spec;
      const units = [unit("api:document", "api", metadata)];
      // Keep every path item, including $ref-only paths and inherited servers/parameters.
      for (const [path, item] of Object.entries(spec.paths) as Array<[string,ObjectData]>) {
        units.push(unit(`path:${evidenceHash(path)}`,"api",{path,item}));
        for (const method of ["get","post","put","patch","delete","head","options","trace"]) if (item[method])
          units.push(unit(`api:${method}:${path}`.slice(0,130) + ":" + evidenceHash(path), "api", { path, method, servers:item[method].servers ?? item.servers ?? spec.servers, parameters: item.parameters, operation: item[method] }));
      }
      for (const [kind, values] of Object.entries(spec.components ?? {})) for (const [name, value] of Object.entries(values as ObjectData))
        units.push(unit(`component:${kind}:${name}`.slice(0,130) + ":" + evidenceHash(`${kind}:${name}`), "api", value));
      return page(units);
    }
    if (body.includes("\0") || body.startsWith("%PDF")) throw new EvidenceFetchError("이 문서 형식은 아직 자동으로 읽을 수 없습니다. 원문 확인이 필요합니다.");
    const text = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    const points = Array.from(text), units: EvidenceUnitInput[] = [];
    for (let i = 0; i < points.length; i += 32_000) units.push(unit(`section:${i}`, "document", points.slice(i,i+32_000).join("")));
    const links=discoverLinks([unit("document:links", "document", body)],source.url);
    if (links.length) units.push(unit("document:links","document",links));
    return page(units, null, links);
  }
  const result = await fallback();
  return page(result.units ?? []);
}
