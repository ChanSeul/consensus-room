import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { SessionTurn } from "../types.js";
import { nativeApps } from "./nativeApps.js";

export const NATIVE_FIGMA_READS = ["get_metadata", "get_design_context", "get_screenshot", "get_variable_defs", "get_motion_context", "get_code_connect_map"] as const;
const APP = "connector_68df038e0ba48191908c8434991bbac2";
const LIMIT = 32 * 1024 * 1024;

export async function nativeFigma(command: string, authPath: string, cwd: string, turn: Omit<SessionTurn, "sessionId">) {
  turn.signal?.throwIfAborted();
  if (!turn.figmaFileKeys?.length || !turn.onFigmaResult) throw new Error("승인된 Figma 파일과 관측 저장 경로가 필요합니다.");
  const allowedFiles = new Set(turn.figmaFileKeys);
  const client = await nativeApps(command, authPath, cwd, { [APP]: NATIVE_FIGMA_READS.map(name => `figma.${name}`) }, turn.signal);
  const tools = client.tools.map(tool => ({ ...tool, name: tool.name.replace(/^figma\./, "") }));
  const path = `/${randomUUID()}`, server = createServer();
  let failure: unknown, pendingReads = 0, stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    turn.signal?.removeEventListener("abort", abort);
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await client.close();
  })();
  const abort = () => { failure ??= Error("Figma 앱 연결이 취소됐습니다."); void stop(); };
  turn.signal?.addEventListener("abort", abort, { once: true });
  try {
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
            result = await client.call(`figma.${name}`, args);
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
