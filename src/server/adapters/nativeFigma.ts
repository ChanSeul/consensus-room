import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { agentEnvironment } from "../security.js";
import type { SessionTurn } from "../types.js";

export const NATIVE_FIGMA_READS = ["get_metadata", "get_design_context", "get_screenshot", "get_variable_defs", "get_motion_context", "get_code_connect_map"] as const;
const APP = "connector_68df038e0ba48191908c8434991bbac2";
const LIMIT = 32 * 1024 * 1024;

// The host calls installed app tools through the documented app-server RPC. It never starts a model turn.
// The model sees this small, observed MCP surface rather than the user's full app/plugin inventory.
export async function nativeFigma(command: string, authPath: string, cwd: string, turn: Omit<SessionTurn, "sessionId">) {
  if (turn.signal?.aborted) throw Error("Figma 앱 연결이 취소됐습니다.");
  if (!turn.figmaFileKeys?.length || !turn.onFigmaResult) throw new Error("승인된 Figma 파일과 관측 저장 경로가 필요합니다.");
  const allowedFiles = new Set(turn.figmaFileKeys);
  const home = await mkdtemp(join(tmpdir(), "consensus-figma-"));
  const calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0, pendingReads = 0, failure: unknown;
  try {
    await symlink(authPath, join(home, "auth.json"));
    await writeFile(join(home, "config.toml"), [
    'approval_policy = "never"', 'web_search = "disabled"', "[features]", "plugins = false", "memories = false", "hooks = false",
    "[apps._default]", "enabled = false", `[apps.${APP}]`, "enabled = true", "default_tools_enabled = false", "destructive_enabled = false",
    ...NATIVE_FIGMA_READS.flatMap(tool => [`[apps.${APP}.tools.${JSON.stringify(`figma.${tool}`)}]`, "enabled = true"]), "",
    ].join("\n"), { mode: 0o600 });
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
  const child = spawn(command, ["app-server", "--strict-config", "--stdio"], {
    cwd, detached: true, stdio: ["pipe", "pipe", "ignore"],
    env: agentEnvironment({ CODEX_HOME: home }),
  });
  const lines = createInterface({ input: child.stdout! });
  const rejectCalls = () => { for (const call of calls.values()) { clearTimeout(call.timer); call.reject(new Error("Figma 앱 연결이 종료됐습니다.")); } calls.clear(); };
  let ended = false;
  const end = () => { ended = true; rejectCalls(); };
  child.once("error", end); child.once("exit", end);
  lines.on("line", line => {
    try {
      if (Buffer.byteLength(line) > LIMIT) throw Error("Native Figma response exceeds the observation limit.");
      const message = JSON.parse(line);
      // An unexpected interactive/auth request is not approved by this bridge.
      if (message.method && message.id !== undefined) {
        child.stdin!.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Interactive requests are unavailable in the read-only Figma bridge." } }) + "\n");
        return;
      }
      const call = calls.get(message.id); if (!call) return;
      calls.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error("공식 Figma 앱 연결을 확인하세요.")); else call.resolve(message.result);
    } catch (error) { failure ??= error; rejectCalls(); }
  });
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (ended || turn.signal?.aborted) { reject(Error("Figma 앱 연결이 종료됐습니다.")); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { calls.delete(id); reject(Error("Figma 앱 연결 응답 시간이 지났습니다.")); }, 120_000);
    calls.set(id, { resolve, reject, timer });
    child.stdin!.write(JSON.stringify({ id, method, params }) + "\n", error => {
      if (error) { calls.delete(id); clearTimeout(timer); reject(error); }
    });
  });
  const path = `/${randomUUID()}`;
  const server = createServer();
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    turn.signal?.removeEventListener("abort", abort);
    lines.close(); rejectCalls(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (child.pid && !ended) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        try { process.kill(-child.pid!, "SIGTERM"); } catch { clearTimeout(timer); resolve(); }
      });
    }
    await rm(home, { recursive: true, force: true });
  })();
  const abort = () => { failure ??= Error("Figma 앱 연결이 취소됐습니다."); void stop(); };
  turn.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (turn.signal?.aborted) throw Error("Figma 앱 연결이 취소됐습니다.");
    await rpc("initialize", { clientInfo: { name: "consensus-figma-reader", version: "1.0" }, capabilities: { experimentalApi: true } });
    child.stdin!.write('{"method":"initialized"}\n');
    const { thread } = await rpc("thread/start", { cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: "Read-only Figma app transport. No model turn is started." });
    const installed = await rpc("app/installed", { threadId: thread.id, forceRefresh: true });
    if (!installed.apps?.some((app: any) => app.id === APP && app.enabled && app.callable)) throw Error("공식 Figma 앱이 연결되지 않았습니다. 앱에서 연결을 확인하세요.");
    const inventory = await rpc("mcpServerStatus/list", { threadId: thread.id, serverName: "codex_apps", detail: "toolsAndAuthOnly", limit: 100 });
    const available = inventory.data?.find((entry: any) => entry.name === "codex_apps")?.tools ?? {};
    const tools = NATIVE_FIGMA_READS.flatMap(name => {
      const tool = available[`figma.${name}`];
      return tool?.annotations?.readOnlyHint === true ? [{ ...tool, name }] : [];
    });
    if (!tools.some(tool => tool.name === "get_design_context")) throw Error("공식 Figma 디자인 읽기 도구가 없습니다.");
    server.on("request", (request, response) => {
      void (async () => {
        if (request.url !== path || request.method !== "POST") { response.writeHead(404).end(); return; }
        let bytes = 0; const chunks: Buffer[] = [];
        for await (const chunk of request) { bytes += chunk.length; if (bytes > LIMIT) throw Error("Figma request exceeds the limit."); chunks.push(Buffer.from(chunk)); }
        const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        if (message.id === undefined) { response.writeHead(204).end(); return; }
        let result: unknown;
        if (message.method === "initialize") result = { protocolVersion: message.params?.protocolVersion ?? "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "consensus-native-figma", version: "1.0" } };
        else if (message.method === "ping") result = {};
        else if (message.method === "tools/list") result = { tools };
        else if (message.method === "tools/call") {
          const name = message.params?.name, args = message.params?.arguments;
          if (!tools.some(tool => tool.name === name) || !allowedFiles.has(args?.fileKey) || typeof args?.nodeId !== "string" || !/^\d+[:-]\d+$/.test(args.nodeId)) {
            response.writeHead(403).end(); return;
          }
          const observation = { tool: `mcp__figma-native__${name}`, input: args };
          turn.onFigmaRequest?.(observation);
          pendingReads++;
          try {
            result = await rpc("mcpServer/tool/call", { threadId: thread.id, server: "codex_apps", tool: `figma.${name}`, arguments: args });
            const native = result as { isError?: boolean };
            // Retain the full native result, including structured content and images, before returning it to the model.
            turn.onFigmaResult!({ ...observation, content: native, isError: native.isError === true });
          } finally { pendingReads--; }
        } else { response.writeHead(400).end(); return; }
        const body = JSON.stringify({ jsonrpc: "2.0", id: message.id, result });
        if (Buffer.byteLength(body) > LIMIT) throw Error("Figma response exceeds the observation limit.");
        response.writeHead(200, { "content-type": "application/json" }).end(body);
      })().catch(error => { failure ??= error; if (!response.headersSent) response.writeHead(502); response.end(); });
    });
    if (turn.signal?.aborted) throw Error("Figma 앱 연결이 취소됐습니다.");
    await new Promise<void>((resolve, reject) => {
      const cancelled = () => reject(Error("Figma 앱 연결이 취소됐습니다."));
      server.once("close", cancelled); server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.off("close", cancelled); server.off("error", reject);
        if (turn.signal?.aborted) cancelled(); else resolve();
      });
    });
    const address = server.address(); if (!address || typeof address === "string") throw Error("Figma observation endpoint unavailable.");
    return { url: `http://127.0.0.1:${address.port}${path}`, assertCaptured() {
      if (failure) throw failure; if (pendingReads) throw Error("Figma 앱 관측이 끝나지 않았습니다.");
    }, close: stop };
  } catch (error) { await stop(); throw error; }
}
