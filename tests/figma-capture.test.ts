import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeAdapter } from "../src/server/adapters/claude";
import type { CommandRunner } from "../src/server/types";

// Public entrypoint: ClaudeAdapter.createSession -> shared MCP connection -> evidence sink.
// The runner reproduces a Workflow child: it calls MCP but emits no parent tool messages.
// The evidence service consumes these callbacks; this test claims transport retention, not UI design correctness.
const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); vi.unstubAllEnvs(); });
async function endpoint(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`;
}
async function invoke(upstream: string, run: (url: string) => Promise<void>, onResult = vi.fn()) {
  const root = mkdtempSync(join(tmpdir(), "figma-capture-"));
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "home")); vi.stubEnv("HOME", join(root, "home"));
  const onRequest = vi.fn();
  const runner: CommandRunner = { run: async spec => {
    const config = JSON.parse(spec.args[spec.args.indexOf("--mcp-config") + 1]);
    await run(config.mcpServers["figma-desktop"].url);
    const result = { type: "result", structured_output: { kind: "PLAN", summary: "done", findings: [], evidenceRefs: [] } };
    return { exitCode: 0, stdout: JSON.stringify(result), stderr: "", jsonLines: [result] };
  } };
  await new ClaudeAdapter(runner, undefined, { figmaMcpUrl: upstream }).createSession({ cwd: root, prompt: "Implement",
    implementation: true, figmaReadEnabled: true, onFigmaRequest: onRequest, onFigmaResult: onResult });
  return { onRequest, onResult };
}
const rpc = (id = 1, name = "get_design_context") => ({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: { nodeId: "5:1" } } });
const post = (url: string, message = rpc()) => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(message) });

describe("Workflow Figma capture", () => {
  it.each([false, true])("retains a child response absent from the parent stream (SSE=%s)", async sse => {
    const answer = { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "EXACT CHILD DESIGN" }] } };
    const upstream = await endpoint((_request, response) => response.writeHead(200, { "content-type": sse ? "text/event-stream" : "application/json" })
      .end(sse ? `event: message\r\ndata: ${JSON.stringify(answer)}\r\n\r\n` : JSON.stringify(answer)));
    let address = "";
    const { onRequest, onResult } = await invoke(upstream, async url => {
      address = url;
      expect((await post(url)).status).toBe(200);
    });
    expect(onRequest).toHaveBeenCalledExactlyOnceWith({ tool: "mcp__figma-desktop__get_design_context", input: { nodeId: "5:1" } });
    expect(onResult).toHaveBeenCalledExactlyOnceWith({ tool: "mcp__figma-desktop__get_design_context", input: { nodeId: "5:1" }, content: answer.result.content, isError: false });
    await expect(post(address)).rejects.toThrow(); // Per-turn endpoint must be closed.
  });
  it("keeps denied tools and wrong endpoint paths away from upstream", async () => {
    const received = vi.fn();
    const upstream = await endpoint((_request, response) => { received(); response.end("{}"); });
    const { onResult, onRequest } = await invoke(upstream, async url => {
      expect((await post(url, rpc(1, "use_figma"))).status).toBe(403);
      expect((await post(new URL("/wrong", url).href)).status).toBe(404);
    });
    expect(received).not.toHaveBeenCalled(); expect(onResult).not.toHaveBeenCalled(); expect(onRequest).not.toHaveBeenCalled();
  });
  it.each(["missing", "sink"])("does not accept an uncaptured child result (%s)", async failure => {
    const upstream = await endpoint((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: failure === "missing" ? {} : { content: [{ type: "text", text: "design" }] } }));
    });
    const sink = vi.fn(() => { if (failure === "sink") throw new Error("Evidence storage failed"); });
    await expect(invoke(upstream, async url => { expect((await post(url)).status).toBe(502); }, sink)).rejects.toThrow();
  });
  it("preserves error responses without claiming successful evidence", async () => {
    const upstream = await endpoint((_request, response) => response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Missing node" }], isError: true } })));
    const { onResult } = await invoke(upstream, async url => { await post(url); });
    expect(onResult.mock.calls[0][0].isError).toBe(true);
  });
});

it("retains completed child evidence even if the parent turn is interrupted", async () => {
  const upstream = await endpoint((_request, response) => response.writeHead(200, { "content-type": "application/json" })
    .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "RETAIN AFTER INTERRUPT" }] } })));
  const sink = vi.fn(); let address = "";
  await expect(invoke(upstream, async url => { address = url; await post(url); throw new Error("Parent interrupted"); }, sink))
    .rejects.toThrow("Parent interrupted");
  expect(sink).toHaveBeenCalledOnce();
  await expect(post(address)).rejects.toThrow();
});

it("separates concurrent child calls even when their RPC ids match", async () => {
  const upstream = await endpoint((request, response) => {
    void (async () => {
      let text = ""; for await (const chunk of request) text += chunk;
      const message = JSON.parse(text);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: 1,
        result: { content: [{ type: "text", text: message.params.arguments.nodeId === "5:1" ? "FIRST DESIGN" : "SECOND DESIGN" }] } }));
    })();
  });
  const { onResult } = await invoke(upstream, async url => {
    const second = rpc(); second.params.arguments.nodeId = "5:2";
    await Promise.all([post(url), post(url, second)]);
  });
  expect(onResult.mock.calls.map(([value]) => value.content[0].text).sort()).toEqual(["FIRST DESIGN", "SECOND DESIGN"]);
});

it("allows cached work when MCP initialization cannot connect", async () => {
  const { onResult } = await invoke("http://127.0.0.1:1/mcp", async url => {
    const result = await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) });
    expect(result.status).toBe(502);
  });
  expect(onResult).not.toHaveBeenCalled();
});

it.each(["http", "rpc", "redirect"])("accepts successful retry after a terminal %s error", async mode => {
  let calls = 0;
  const upstream = await endpoint((_request, response) => {
    if (++calls === 1) {
      if (mode === "redirect") { response.writeHead(302, { location: "http://127.0.0.1:1" }).end(); return; }
      response.writeHead(mode === "http" ? 503 : 200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: "Try again" } }));
    } else response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Recovered design" }] } }));
  });
  const { onResult } = await invoke(upstream, async url => { await post(url); await post(url); });
  expect(onResult).toHaveBeenCalledOnce();
});

it("forwards SSE requests and captures a result before the stream closes", async () => {
  let finish: (() => void) | undefined;
  const upstream = await endpoint((request, response) => {
    void (async () => {
      let raw = ""; for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      if (message.method === "tools/call") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        finish = () => response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Live result" }] } })}\n\n`);
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n\n`);
      } else { finish?.(); response.writeHead(202).end(); }
    })();
  });
  const sink = vi.fn();
  await invoke(upstream, async url => {
    const response = await fetch(url, { method: "POST", body: JSON.stringify(rpc()), signal: AbortSignal.timeout(1500) });
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(Buffer.from(first.value!).toString()).toContain('"method":"ping"');
    await fetch(url, { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 99, result: {} }) });
    const second = await reader.read();
    expect(Buffer.from(second.value!).toString()).toContain("Live result");
    expect(sink).toHaveBeenCalledOnce();
    await reader.cancel();
  }, sink);
});

it("recovers when a child cancels SSE before the result and retries", async () => {
  let calls = 0;
  let closed!: () => void;
  const disconnected = new Promise<void>(resolve => { closed = resolve; });
  const upstream = await endpoint((_request, response) => {
    if (++calls === 1) {
      response.once("close", closed);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write('data: {"jsonrpc":"2.0","method":"notifications/progress","params":{}}\n\n');
    } else response.writeHead(200, { "content-type": "application/json" })
      .end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "Recovered after cancellation" }] } }));
  });
  const { onResult } = await invoke(upstream, async url => {
    const first = await post(url);
    const reader = first.body!.getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    await disconnected;
    expect((await post(url)).status).toBe(200);
  });
  expect(onResult).toHaveBeenCalledOnce();
});
