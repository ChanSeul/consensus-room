import { randomUUID } from "node:crypto";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { RoomConfig } from "./config.js";
import { readLaunchConnection } from "./lifecycle.js";
import { redactSecrets } from "../shared/workflow.js";

export interface MediatorBinding {
  provider: "claude" | "codex";
  participant: string;
  sessionId: string;
  profileId: string;
  scope: string;
  version: number;
}
export interface RequestOptions {
  actor?: "user" | "mediator";
  binding?: MediatorBinding;
  requestId?: string;
}
export interface RoomAPI {
  request<T>(method: string, path: string, body?: unknown, options?: RequestOptions): Promise<T>;
}

// Only these public API boundaries have a verified server-side request ledger.
// A header alone does not make every endpoint safe to replay.
function supportsReplay(method: string, path: string): boolean {
  return method === "POST" && (/^\/api\/(topics|agent-profiles|role-assignments)$/.test(path)
    || /^\/api\/topics\/[^/?]+\/actions\/[^/?]+$/.test(path)
    || /^\/api\/topics\/[^/?]+\/participants\/(claude|codex)$/.test(path));
}

export function apiPath(path: string): string {
  if (!path.startsWith("/api/") || path.includes("\\") || /[\r\n]/.test(path)) throw new Error("API 경로는 /api/로 시작해야 합니다.");
  const url = new URL(path, "http://127.0.0.1");
  if (url.origin !== "http://127.0.0.1" || !url.pathname.startsWith("/api/") || url.hash || url.searchParams.has("token")) {
    throw new Error("같은 방의 /api/ 경로만 요청할 수 있습니다. 토큰은 헤더로 전달됩니다.");
  }
  return `${url.pathname}${url.search}`;
}

export function readBinding(config: RoomConfig): MediatorBinding {
  const raw = JSON.parse(readFileSync(join(config.dataDirectory, "mediator.json"), "utf8")) as MediatorBinding;
  if (!["claude", "codex"].includes(raw.provider) || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(raw.participant)
    || typeof raw.sessionId !== "string" || !raw.sessionId.trim() || typeof raw.profileId !== "string"
    || !/^(global|topic:[A-Za-z0-9-]{1,80})$/.test(raw.scope) || !Number.isInteger(raw.version) || raw.version < 1) {
    throw new Error("중재자 연결 파일이 유효하지 않습니다. connect로 실제 세션을 다시 연결하세요.");
  }
  return raw;
}

export class RoomClient implements RoomAPI {
  private validatedToken?: string;
  constructor(private readonly config: RoomConfig, private readonly transport: typeof fetch = fetch) {}

  async request<T>(method: string, path: string, body?: unknown, options: RequestOptions = {}): Promise<T> {
    method = method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(method)) throw new Error("지원하지 않는 HTTP 메서드입니다.");
    path = apiPath(path);
    const { baseURL, token } = readLaunchConnection(this.config);
    const mutation = method !== "GET";
    if (mutation && this.validatedToken !== token) {
      let target: { repositoryPath?: unknown };
      try {
        const proof = await this.transport(new URL("/api/config", baseURL), { headers: { "x-consensus-token": token },
          redirect: "error", signal: AbortSignal.timeout(5000) });
        if (!proof.ok) throw new Error();
        target = await proof.json() as { repositoryPath?: unknown };
      } catch { throw new Error("서버의 대상 프로젝트를 확인하지 못해 변경 요청을 보내지 않았습니다. status를 확인하세요."); }
      if (typeof target.repositoryPath !== "string" || resolve(target.repositoryPath) !== resolve(this.config.repositoryPath)) {
        throw new Error("서버의 프로젝트 경로가 로컬 설정과 다릅니다. 기존 설정으로 stop한 뒤 새 설정으로 start하세요. 변경 요청은 보내지 않았습니다.");
      }
      this.validatedToken = token;
    }
    const headers: Record<string, string> = { "x-consensus-token": token };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (options.actor === "mediator") {
      const binding = options.binding ?? readBinding(this.config);
      headers["x-consensus-actor"] = "mediator";
      headers["x-consensus-mediator"] = binding.participant;
      headers["x-consensus-mediator-version"] = String(binding.version);
    }
    const requestId = options.requestId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(requestId)) throw new Error("request-id는 영문·숫자·._:- 1~120자여야 합니다.");
    if (mutation) headers["Idempotency-Key"] = requestId;
    // Preserve the exact request before dispatch. A lost response is not a failed mutation.
    // Safe replay is an endpoint contract, not a property of this local journal.
    let receipt: string | undefined;
    if (mutation) {
      const directory = join(this.config.dataDirectory, "cli-requests");
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      receipt = join(directory, `${requestId}.json`);
      const serialized = JSON.stringify({ method, path, body: body ?? null, actor: options.actor ?? "user",
        ...(options.actor === "mediator" ? { binding: options.binding ?? readBinding(this.config) } : {}), requestId }, null, 2);
      try { writeFileSync(receipt, serialized, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST" || readFileSync(receipt, "utf8") !== serialized) {
          throw new Error("같은 request-id의 저장된 요청이 다릅니다. 원래 요청을 확인하세요.");
        }
      }
    }
    let response: Response;
    let raw: string;
    try {
      response = await this.transport(new URL(path, baseURL), { method, headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error", signal: AbortSignal.timeout(30_000) });
      raw = await response.text();
    } catch {
      throw new Error(mutation
        ? `API 응답을 확인하지 못했습니다. 적용 여부를 먼저 확인하세요. ${supportsReplay(method, path)
          ? `서버 원장이 있는 경로입니다. 같은 요청 재사용: --request-id ${requestId}`
          : `요청 식별자=${requestId}. 이 경로의 중복 실행 방지는 확인되지 않았으므로 자동 재호출하지 마세요.`}; 기록: ${receipt}`
        : "서버 응답을 확인하지 못했습니다. cr status로 같은 방의 기동 상태를 확인하세요.");
    }
    let value: unknown;
    try { value = raw ? JSON.parse(raw) : null; }
    catch { throw new Error(`API가 JSON 응답을 반환하지 않았습니다(HTTP ${response.status}).${mutation ? ` request-id=${requestId}` : ""}`); }
    if (!response.ok) {
      const failure = value as { error?: unknown; code?: unknown } | null;
      const detail = typeof failure?.error === "string" ? failure.error : "요청이 거부됐습니다.";
      throw Object.assign(new Error(`HTTP ${response.status}: ${redactSecrets(detail).split(token).join("[REDACTED]")}${mutation ? ` (request-id=${requestId})` : ""}`),
        { statusCode: response.status, code: failure?.code, requestId });
    }
    return value as T;
  }
}
