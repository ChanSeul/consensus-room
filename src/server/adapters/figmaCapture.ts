import { createHash, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
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
function canonical(value: any): any {
  return Array.isArray(value) ? value.map(canonical) : value && typeof value === "object"
    ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
type Reply = { result?: any; error?: any };
type SharedRead = { promise: Promise<Reply | undefined>; consumers: Set<ServerResponse>; abort: AbortController };

// Observe the shared MCP transport: Workflow children do not emit their tool results to the parent stream.
// This endpoint exists only for one turn, listens on loopback, and forwards only to the configured server.
export async function captureFigma(upstream: string, methods: readonly string[], turn: Omit<SessionTurn, "sessionId">) {
  const path = `/${randomUUID()}`;
  const abort = new AbortController();
  const signal = turn.signal ? AbortSignal.any([turn.signal, abort.signal]) : abort.signal;
  let failure: unknown;
  const pending = new Set<symbol>();
  // One read-only turn is one source snapshot. Never reuse a body across turns or MCP/auth sessions.
  const completed = new Map<string, { reply: Reply; bytes: number }>();
  const inFlight = new Map<string, SharedRead>();
  const throttled = new Map<string, { reply: Reply; until: number }>();
  let cachedBytes = 0;
  let sourceEpoch = 0;
  const server = createServer((request, response) => {
    const key = Symbol();
    let sharedKey: string | undefined;
    let complete: ((reply?: Reply) => void) | undefined;
    let shared: SharedRead | undefined;
    const leave = () => {
      if (!shared) return;
      shared.consumers.delete(response);
      if (!shared.consumers.size) {
        shared.abort.abort();
        if (sharedKey && inFlight.get(sharedKey) === shared) inFlight.delete(sharedKey);
      }
    };
    void (async () => {
      if (request.url !== path || !["POST", "GET", "DELETE"].includes(request.method ?? "")) {
        response.writeHead(404).end(); return;
      }
      const bytes = request.method === "POST" ? await body(request) : undefined;
      if (request.method === "DELETE") { sourceEpoch++; completed.clear(); cachedBytes = 0; }
      const rpc = bytes ? JSON.parse(bytes.toString("utf8")) : undefined;
      if (Array.isArray(rpc)) { response.writeHead(400).end(); return; }
      const call = rpc?.method === "tools/call" ? rpc.params : undefined;
      if (call && !methods.includes(call.name)) { response.writeHead(403).end(); return; }
      const observation = call ? { tool: `mcp__figma-desktop__${call.name}`, input: call.arguments ?? {} } : undefined;
      if (observation) { pending.add(key); turn.onFigmaRequest?.(observation); }
      const identity = createHash("sha256").update(JSON.stringify([
        request.headers.authorization ?? null, request.headers.cookie ?? null,
      ])).digest("hex");
      const emit = (reply: Reply) => {
        if (reply.result && Array.isArray(reply.result.content)) {
          if (!turn.onFigmaResult) throw new Error("Figma observation sink is unavailable.");
          turn.onFigmaResult({ ...observation!, content: reply.result.content, isError: reply.result.isError === true });
        }
        if (reply.error) turn.onFigmaResult?.({ ...observation!, content: reply.error, isError: true });
        const message = JSON.stringify({ jsonrpc: "2.0", id: rpc.id, ...reply });
        const sse = request.headers.accept?.includes("text/event-stream") && !request.headers.accept.includes("application/json");
        response.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" })
          .end(sse ? `data: ${message}\n\n` : message);
      };
      if (observation) {
        const { progressToken: _progress, ...meta } = rpc.params._meta ?? {};
        const { _meta, ...parameters } = rpc.params;
        sharedKey = createHash("sha256").update(JSON.stringify([sourceEpoch, identity, request.headers["mcp-session-id"] ?? null,
          canonical({ ...parameters, ...(Object.keys(meta).length ? { _meta: meta } : {}) })])).digest("hex");
        const cached = completed.get(sharedKey);
        if (cached) { emit(cached.reply); return; }
        const limit = throttled.get(identity);
        if (limit && Date.now() < limit.until) { emit(limit.reply); return; }
        if (limit) throttled.delete(identity);
        const ongoing = inFlight.get(sharedKey);
        if (ongoing) {
          shared = ongoing; shared.consumers.add(response); response.once("close", leave);
          const reply = await ongoing.promise;
          if (reply) emit(reply); else response.writeHead(502).end();
          return;
        }
        shared = { promise: new Promise(resolve => { complete = resolve; }), consumers: new Set([response]), abort: new AbortController() };
        inFlight.set(sharedKey, shared); response.once("close", leave);
      }
      let result: Response;
      try {
        result = await fetch(upstream, { method: request.method, headers: headers(request.headers), body: bytes?.toString("utf8"), signal: shared ? AbortSignal.any([signal, shared.abort.signal]) : signal, redirect: "error" });
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
      const readBody = async (): Promise<Buffer | undefined> => {
        try { return result.body ? await body(Readable.fromWeb(result.body as never)) : Buffer.alloc(0); }
        catch (error) {
          if (shared?.abort.signal.aborted && (error as Error).name === "AbortError") return undefined;
          throw error;
        }
      };
      const throttle = (reply: Reply) => {
        const retry = result.headers.get("retry-after");
        const until = retry && /^\d+(\.\d+)?$/.test(retry) ? Date.now() + Number(retry) * 1000
          : retry && Number.isFinite(Date.parse(retry)) ? Date.parse(retry) : Infinity;
        throttled.set(identity, { reply, until });
      };
      if (!result.ok) {
        const content = await readBody();
        if (content === undefined) return;
        const reply = { result: { isError: true, content: [{ type: "text",
          text: `Figma HTTP ${result.status}: ${content.toString("utf8")}` }] } };
        if (!turn.onFigmaResult) throw new Error("Figma observation sink is unavailable.");
        turn.onFigmaResult({ ...observation, content: reply.result.content, isError: true });
        if (result.status === 429) throttle(reply);
        complete?.(reply);
        response.writeHead(result.status, headers(result.headers)).end(content);
        return;
      }
      const observe = (message: any) => {
        if (message.id !== rpc.id || (!message.result && !message.error)) return;
        if (result.ok && message.result && Array.isArray(message.result.content)) {
          if (!turn.onFigmaResult) throw new Error("Figma observation sink is unavailable.");
          turn.onFigmaResult({ ...observation, content: message.result.content, isError: message.result.isError === true });
          const reply: Reply = { result: message.result };
          if (message.result.isError === true && message.result.content.some((item: any) => item.type === "text" &&
              /rate limit|too many requests|quota exceeded/i.test(item.text ?? ""))) throttle(reply);
          if (message.result.isError !== true) {
            const size = Buffer.byteLength(JSON.stringify(reply));
            if (size <= LIMIT) {
              while (cachedBytes + size > LIMIT && completed.size) {
                const oldest = completed.keys().next().value!;
                cachedBytes -= completed.get(oldest)!.bytes; completed.delete(oldest);
              }
              completed.set(sharedKey!, { reply: structuredClone(reply), bytes: size }); cachedBytes += size;
            }
          }
          complete?.(reply);
        } else if (result.ok && !message.error) {
          throw new Error("Figma response was not captured from the shared MCP transport.");
        } else if (message.error) {
          const reply = { error: message.error };
          turn.onFigmaResult?.({ ...observation!, content: message.error, isError: true });
          if (/rate limit|too many requests|quota exceeded/i.test(message.error.message ?? "")) throttle(reply);
          complete?.(reply);
        }
        pending.delete(key);
      };
      if (result.headers.get("content-type")?.includes("text/event-stream") && result.body) {
        response.writeHead(result.status, headers(result.headers));
        const reader = result.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let interrupted = false;
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
              if (!response.destroyed) response.write(event);
            }
            if (Buffer.byteLength(buffer) > LIMIT) throw new Error("Figma event exceeds the observation limit.");
            if (chunk.done) break;
          }
          if (pending.has(key) && result.ok && !interrupted) throw new Error("Figma response was not captured from the shared MCP transport.");
          response.end();
        } finally { await reader.cancel().catch(() => {}); }
      } else {
        const content = await readBody();
        if (content === undefined) return;
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
    }).finally(() => {
      pending.delete(key);
      response.off("close", leave);
      leave();
      if (complete) { complete(); if (sharedKey && inFlight.get(sharedKey) === shared) inFlight.delete(sharedKey); }
    });
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
