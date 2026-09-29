import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import type { SessionTurn } from "../types.js";

const LIMIT = 32 * 1024 * 1024;
const HOP_HEADERS = new Set(["host", "connection", "content-length", "transfer-encoding", "keep-alive", "content-encoding"]);
async function body(stream: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > LIMIT) throw new Error("Figma response exceeds the observation limit.");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function headers(input: Headers | IncomingMessage["headers"]): Record<string, string> {
  const entries = input instanceof Headers ? [...input.entries()] : Object.entries(input);
  return Object.fromEntries(entries.filter(([key, value]) => value !== undefined && !HOP_HEADERS.has(key.toLowerCase()))
    .map(([key, value]) => [key, Array.isArray(value) ? value.join(", ") : String(value)]));
}

// Observe the shared MCP transport: Workflow children do not emit their tool results to the parent stream.
// This endpoint exists only for one turn, listens on loopback, and forwards only to the configured server.
export async function captureFigma(upstream: string, methods: readonly string[], turn: Omit<SessionTurn, "sessionId">) {
  const path = `/${randomUUID()}`;
  const abort = new AbortController();
  const signal = turn.signal ? AbortSignal.any([turn.signal, abort.signal]) : abort.signal;
  let failure: unknown;
  const pending = new Set<symbol>();
  const server = createServer((request, response) => {
    const key = Symbol();
    void (async () => {
      if (request.url !== path || !["POST", "GET", "DELETE"].includes(request.method ?? "")) {
        response.writeHead(404).end(); return;
      }
      const bytes = request.method === "POST" ? await body(request) : undefined;
      const rpc = bytes ? JSON.parse(bytes.toString("utf8")) : undefined;
      if (Array.isArray(rpc)) { response.writeHead(400).end(); return; }
      const call = rpc?.method === "tools/call" ? rpc.params : undefined;
      if (call && !methods.includes(call.name)) { response.writeHead(403).end(); return; }
      const observation = call ? { tool: `mcp__figma-desktop__${call.name}`, input: call.arguments ?? {} } : undefined;
      if (observation) { pending.add(key); turn.onFigmaRequest?.(observation); }
      let result: Response;
      try {
        result = await fetch(upstream, { method: request.method, headers: headers(request.headers), body: bytes?.toString("utf8"), signal, redirect: "error" });
      } catch {
        // Connection failures are reported to the CLI, which may retry or use cached evidence.
        response.writeHead(502).end(); return;
      }
      if (!observation) {
        response.writeHead(result.status, headers(result.headers));
        if (result.body) Readable.fromWeb(result.body as never).on("error", () => response.destroy()).pipe(response);
        else response.end();
        return;
      }
      const observe = (message: any) => {
        if (message.id !== rpc.id || (!message.result && !message.error)) return;
        if (result.ok && message.result && Array.isArray(message.result.content)) {
          if (!turn.onFigmaResult) throw new Error("Figma observation sink is unavailable.");
          turn.onFigmaResult({ ...observation, content: message.result.content, isError: message.result.isError === true });
        } else if (result.ok && !message.error) {
          throw new Error("Figma response was not captured from the shared MCP transport.");
        }
        pending.delete(key);
      };
      if (result.headers.get("content-type")?.includes("text/event-stream") && result.body) {
        response.writeHead(result.status, headers(result.headers));
        const reader = result.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let interrupted = false;
        const cancel = () => { interrupted = true; void reader.cancel().catch(() => {}); };
        response.once("close", cancel);
        try {
          while (true) {
            // Transport cancellation/reset is recoverable; parsing and sink failures below are not.
            const chunk = await reader.read().catch(() => { interrupted = true; return { done: true, value: undefined }; });
            buffer += decoder.decode(chunk.value, { stream: !chunk.done });
            let boundary: RegExpExecArray | null;
            while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
              const event = buffer.slice(0, boundary.index + boundary[0].length);
              buffer = buffer.slice(event.length);
              if (Buffer.byteLength(event) > LIMIT) throw new Error("Figma event exceeds the observation limit.");
              const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
                .map(line => line.slice(5).trimStart()).join("\n");
              if (data) observe(JSON.parse(data));
              response.write(event);
            }
            if (Buffer.byteLength(buffer) > LIMIT) throw new Error("Figma event exceeds the observation limit.");
            if (chunk.done) break;
          }
          if (pending.has(key) && result.ok && !interrupted) throw new Error("Figma response was not captured from the shared MCP transport.");
          response.end();
        } finally { response.off("close", cancel); await reader.cancel().catch(() => {}); }
      } else {
        const content = result.body ? await body(Readable.fromWeb(result.body as never)) : Buffer.alloc(0);
        if (result.ok) {
          if (content.length) observe(JSON.parse(content.toString("utf8")));
          if (pending.has(key)) throw new Error("Figma response was not captured from the shared MCP transport.");
        }
        response.writeHead(result.status, headers(result.headers)).end(content);
      }
    })().catch(error => {
      failure ??= error;
      if (!response.headersSent) response.writeHead(502);
      response.end();
    }).finally(() => pending.delete(key));
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Figma observation endpoint unavailable.");
  return {
    url: `http://127.0.0.1:${address.port}${path}`,
    hasPending() { return pending.size > 0; },
    assertCaptured() { if (failure) throw failure; },
    async close() {
      abort.abort();
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}
