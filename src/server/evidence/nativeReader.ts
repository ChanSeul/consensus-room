import { createHash } from "node:crypto";
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
export type IdentityMetric = "identityCalls" | "identityReuse" | "identityInvalidations";
export interface ReaderIdentity { account: string; config: NativeReaderConfig; generation: string }
export interface AppReader {
  identity?(provider: AppProvider, signal: AbortSignal, onCall: () => void): Promise<ReaderIdentity>;
  validateIdentity?(provider: AppProvider, identity: ReaderIdentity, signal: AbortSignal): Promise<void>;
  invalidateIdentity?(provider: AppProvider): void;
  call(provider: AppProvider, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  config(): Promise<NativeReaderConfig>;
  close(): Promise<void>;
}
const identityFlights = new WeakMap<AppReader, Map<AppProvider, Promise<ReaderIdentity>>>();
const configKey = (config: NativeReaderConfig) => JSON.stringify([config.googleDriveLinkId, Object.entries(config.accountIds ?? {}).sort()]);
const identityTool = (provider: AppProvider) => provider === "slack" ? "slack.slack_read_user_profile" : provider === "figma" ? "figma.whoami" : "atlassian_rovo.atlassianUserInfo";
function identityAccount(raw: unknown): string {
  const identity = appData(raw), who = identity.whoami ?? identity;
  const account = who.accountId ?? who.id ?? who.email ?? who.user?.id ?? who.profile?.email ?? who.user?.profile?.email ??
    (typeof who.result === "string" ? /^User ID: (\S+)/m.exec(who.result)?.[1] : undefined);
  if (typeof account !== "string" || !account) throw new EvidenceFetchError("수집할 연결 계정을 확인하세요.");
  return account;
}
function checkAccount(provider: AppProvider, account: string | undefined, config: NativeReaderConfig): string {
  if (!account) throw new EvidenceFetchError("수집할 연결 계정을 확인하세요. Google Drive는 evidence-apps.json에 googleDriveLinkId가 필요합니다.");
  if (config.accountIds?.[provider] && config.accountIds[provider] !== account) throw new EvidenceFetchError("설정된 계정과 MCP 연결 계정이 다릅니다.", 300, true);
  return account;
}
// Older readers still verify every page. Only simultaneous identity reads share a result.
export async function readerIdentity(reader: AppReader, provider: AppProvider, signal: AbortSignal, onCall: () => void): Promise<ReaderIdentity> {
  if (reader.identity) return reader.identity(provider, signal, onCall);
  let flights = identityFlights.get(reader);
  if (!flights) { flights = new Map(); identityFlights.set(reader, flights); }
  let flight = flights.get(provider);
  if (!flight) {
    flight = (async () => {
      const config = await reader.config();
      const account = provider === "sheets" ? config.googleDriveLinkId : (onCall(), identityAccount(await reader.call(provider, identityTool(provider), {}, signal)));
      return { account: checkAccount(provider, account, config), config, generation: createHash("sha256").update(configKey(config)).digest("hex") };
    })();
    flights.set(provider, flight);
    const current = flight;
    void flight.finally(() => { if (flights!.get(provider) === current) flights!.delete(provider); }).catch(() => {});
  }
  const result = await flight; signal.throwIfAborted(); return result;
}
export async function validateReaderIdentity(reader: AppReader, provider: AppProvider, identity: ReaderIdentity, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  if (reader.validateIdentity) return reader.validateIdentity(provider, identity, signal);
  if (createHash("sha256").update(configKey(await reader.config())).digest("hex") !== identity.generation) throw new EvidenceFetchError("수집 중 연결 계정이 바뀌었습니다. 전체 원문을 다시 확인해야 합니다.", 300, true);
  signal.throwIfAborted();
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
  private signature?: string;
  private readonly epochs = new Map<AppProvider, number>();
  private readonly identities = new Map<AppProvider, Promise<ReaderIdentity>>();
  private readonly cached = new Map<AppProvider, ReaderIdentity>();
  constructor(private readonly directory: string, private readonly command: string, private readonly authPath = join(homedir(), ".codex", "auth.json"),
    private readonly metric: (provider: AppProvider, name: IdentityMetric, value: number) => void = () => {}) {}
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
  invalidateIdentity(provider: AppProvider): void {
    this.epochs.set(provider, (this.epochs.get(provider) ?? 0) + 1);
    this.identities.delete(provider); this.cached.delete(provider);
    this.metric(provider, "identityInvalidations", 1);
  }
  private async state(): Promise<{ config: NativeReaderConfig; signature: string }> {
    try {
      const config = await this.config();
      const auth = await readFile(this.authPath);
      const signature = createHash("sha256").update(configKey(config)).update(auth).digest("hex");
      if (this.signature !== undefined && this.signature !== signature) {
        for (const provider of Object.keys(APP_READS) as AppProvider[]) this.invalidateIdentity(provider);
        const clients = [...this.clients.values()]; this.clients.clear();
        await Promise.allSettled(clients.map(async client => (await client).close()));
      }
      this.signature = signature;
      return { config, signature };
    } catch (error) {
      for (const provider of Object.keys(APP_READS) as AppProvider[]) this.invalidateIdentity(provider);
      throw error;
    }
  }
  private generation(provider: AppProvider, signature: string): string { return `${signature}:${this.epochs.get(provider) ?? 0}`; }
  async identity(provider: AppProvider, signal: AbortSignal, onCall: () => void): Promise<ReaderIdentity> {
    signal.throwIfAborted();
    const state = await this.state(), generation = this.generation(provider, state.signature);
    const cached = this.cached.get(provider);
    if (cached?.generation === generation) { this.metric(provider, "identityReuse", 1); return cached; }
    let flight = this.identities.get(provider);
    if (flight) this.metric(provider, "identityReuse", 1);
    else {
      flight = (async () => {
        let account = state.config.googleDriveLinkId;
        if (provider !== "sheets") {
          this.metric(provider, "identityCalls", 1); onCall();
          account = identityAccount(await this.call(provider, identityTool(provider), {}, signal));
        }
        const identity = { account: checkAccount(provider, account, state.config), config: state.config, generation };
        await this.validateIdentity(provider, identity, signal);
        // The bridge has no verified account-change notification, so account pins alone cannot enable a cross-page cache.
        if (provider === "sheets") this.cached.set(provider, identity);
        return identity;
      })();
      this.identities.set(provider, flight);
      const current = flight;
      void flight.finally(() => { if (this.identities.get(provider) === current) this.identities.delete(provider); }).catch(() => {});
    }
    try { const result = await flight; await this.validateIdentity(provider, result, signal); return result; }
    catch (error) { this.invalidateIdentity(provider); throw error; }
  }
  async validateIdentity(provider: AppProvider, identity: ReaderIdentity, signal: AbortSignal): Promise<void> {
    const state = await this.state(); signal.throwIfAborted();
    if (identity.generation !== this.generation(provider, state.signature)) throw new EvidenceFetchError("수집 중 연결 계정이 바뀌었습니다. 전체 원문을 다시 확인해야 합니다.", 300, true);
  }
  async call(provider: AppProvider, name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted();
    const state = await this.state(), generation = this.generation(provider, state.signature);
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
      const latest = await this.state();
      if (generation !== this.generation(provider, latest.signature)) throw new EvidenceFetchError("수집 중 연결 계정이 바뀌었습니다. 전체 원문을 다시 확인해야 합니다.", 300, true);
      if (result?.isError) throw new EvidenceFetchError("MCP 원문 조회 실패: " + name + ". 앱 연결과 읽기 권한을 확인하세요.");
      return result;
    } catch (error) {
      this.invalidateIdentity(provider);
      if (this.clients.get(provider) === client) this.clients.delete(provider);
      await client.then(value => value.close(), () => undefined);
      throw error;
    }
  }
  async close(): Promise<void> {
    this.controller.abort();
    for (const provider of Object.keys(APP_READS) as AppProvider[]) this.invalidateIdentity(provider);
    await Promise.allSettled([...this.clients.values()].map(async client => (await client).close()));
    this.clients.clear();
  }
}
