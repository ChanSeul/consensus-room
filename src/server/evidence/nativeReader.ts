import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { nativeApps } from "../adapters/nativeApps.js";
import { EvidenceFetchError } from "./connectors.js";

export const APP_READS = {
  slack: { id: "asdk_app_69a1d78e929881919bba0dbda1f6436d", names: ["slack.slack_read_channel", "slack.slack_read_thread", "slack.slack_read_user_profile"] },
  atlassian: { id: "asdk_app_6a83901dde988191b3f3cefdcc19acfa", names: ["atlassian_rovo.getJiraIssue", "atlassian_rovo.searchJiraIssuesUsingJql", "atlassian_rovo.getConfluenceContent", "atlassian_rovo.executeRead", "atlassian_rovo.atlassianUserInfo"] },
  sheets: { id: "connector_5f3c8c41a1e54ad7a76272c89e2554fa", names: ["google_drive.get_spreadsheet_metadata", "google_drive.get_spreadsheet_cells", "google_drive.get_spreadsheet_comments"] },
  figma: { id: "connector_68df038e0ba48191908c8434991bbac2", names: ["figma.whoami", "figma.get_design_context", "figma.get_metadata", "figma.get_variable_defs", "figma.get_screenshot"] },
} as const;
export type AppProvider = keyof typeof APP_READS;
export interface NativeReaderConfig { googleDriveLinkId?: string; accountIds?: Partial<Record<AppProvider, string>> }
export interface AppReader {
  call(provider: AppProvider, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  config(): Promise<NativeReaderConfig>;
  close(): Promise<void>;
}
// Tool output is source data, never a command, an approval, or an instruction.
export function appData(raw: any): any {
  if (!raw || raw.isError || raw.error) throw new EvidenceFetchError("연결 도구가 원문을 반환하지 못했습니다. 연결 상태와 접근 권한을 확인하세요.");
  if (raw.structuredContent) return appData(raw.structuredContent);
  if (raw.data && typeof raw.data === "object") return appData(raw.data);
  if (Array.isArray(raw.content)) {
    const texts = raw.content.filter((part: any) => part.type === "text");
    if (texts.length === 1) { try { return appData(JSON.parse(texts[0].text)); } catch (error) { if (error instanceof EvidenceFetchError) throw error; } }
  }
  return raw;
}
export class NativeAppReader implements AppReader {
  private clients = new Map<AppProvider, Promise<Awaited<ReturnType<typeof nativeApps>>>>();
  private readonly controller = new AbortController();
  constructor(private readonly directory: string, private readonly command: string, private readonly authPath = join(homedir(), ".codex", "auth.json")) {}
  async config(): Promise<NativeReaderConfig> {
    try {
      const data = JSON.parse(await readFile(join(this.directory, "evidence-apps.json"), "utf8"));
      if (data.googleDriveLinkId !== undefined && (typeof data.googleDriveLinkId !== "string" || !/^link_[a-zA-Z0-9]+$/.test(data.googleDriveLinkId))) throw Error("invalid link");
      if (data.accountIds !== undefined && (!data.accountIds || typeof data.accountIds !== "object" || Object.values(data.accountIds).some(id => typeof id !== "string"))) throw Error("invalid accounts");
      return data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new EvidenceFetchError("로컬 evidence-apps.json 연결 설정을 확인하세요.");
    }
  }
  async call(provider: AppProvider, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const app = APP_READS[provider];
    if (!(app.names as readonly string[]).includes(name)) throw new EvidenceFetchError("허용되지 않은 수집 도구입니다.");
    if (name === "atlassian_rovo.executeRead" && !["listJiraIssueComments", "listJiraIssueRemoteIssueLinks", "getConfluenceContentDescendants", "listConfluenceComments"].includes(String(args.name))) throw new EvidenceFetchError("허용되지 않은 원문 읽기 작업입니다.");
    let client = this.clients.get(provider);
    if (!client) {
      client = nativeApps(this.command, this.authPath, this.directory, { [app.id]: [...app.names] }, this.controller.signal);
      this.clients.set(provider, client);
    }
    try {
      const connection = await client;
      signal.throwIfAborted();
      const result = await connection.call(name, args);
      signal.throwIfAborted();
      if (result?.isError) throw new EvidenceFetchError("MCP 원문 조회 실패: " + name + ". 앱 연결과 읽기 권한을 확인하세요.");
      return result;
    } catch (error) {
      if (this.clients.get(provider) === client) this.clients.delete(provider);
      await client.then(value => value.close(), () => undefined);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.controller.abort();
    await Promise.allSettled([...this.clients.values()].map(async client => (await client).close()));
    this.clients.clear();
  }
}
