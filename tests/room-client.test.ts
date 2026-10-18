import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { apiPath, RoomClient } from "../src/cli/client.js";
import { createRoomConfig } from "../src/cli/config.js";

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function fixture(transport: typeof fetch) {
  const root = mkdtempSync(join(tmpdir(), "cr-cli-client-")); roots.push(root);
  const config = createRoomConfig({ repositoryPath: join(root, "repo"), dataDirectory: join(root, "data"), claudeModel: "account-claude", codexModel: "account-codex" });
  mkdirSync(config.dataDirectory);
  writeFileSync(join(config.dataDirectory, "consensus-room.url"), "http://127.0.0.1:4317/?token=private-test-token", { mode: 0o600 });
  const verifiedTransport: typeof fetch = (input, options) => new URL(String(input)).pathname === "/api/config"
    ? Promise.resolve(new Response(JSON.stringify({ repositoryPath: config.repositoryPath }))) : transport(input, options);
  return { config, client: new RoomClient(config, verifiedTransport) };
}

it("confines requests to the local API and does not allow token query or external redirects", async () => {
  for (const path of ["https://example.com/api/x", "//example.com/api/x", "/api/../../other", "/api/x?token=secret", "/api/x#fragment", "/api\\x"]) {
    expect(() => apiPath(path)).toThrow();
  }
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"ok":true}'));
  const { client } = fixture(transport);
  await expect(client.request("GET", "/api/health")).resolves.toEqual({ ok: true });
  const [url, options] = transport.mock.calls[0];
  expect(String(url)).toBe("http://127.0.0.1:4317/api/health");
  expect(options?.headers).toMatchObject({ "x-consensus-token": "private-test-token" });
  expect(options?.redirect).toBe("error");
});

it("preserves the request ID after an ambiguous mutation and rejects different reuse before dispatch", async () => {
  const transport = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("socket lost private-test-token"))
    .mockResolvedValueOnce(new Response('{"id":"same-topic"}'));
  const { client, config } = fixture(transport);
  await expect(client.request("POST", "/api/topics", { title: "kept" }, { requestId: "request-1" })).rejects.toThrow("--request-id request-1");
  const receipt = readFileSync(join(config.dataDirectory, "cli-requests/request-1.json"), "utf8");
  expect(receipt).not.toContain("private-test-token");
  await expect(client.request("POST", "/api/topics", { title: "kept" }, { requestId: "request-1" })).resolves.toEqual({ id: "same-topic" });
  await expect(client.request("POST", "/api/topics", { title: "changed" }, { requestId: "request-1" })).rejects.toThrow("저장된 요청이 다릅니다");
  expect(transport).toHaveBeenCalledTimes(2);
});

it("redacts HTTP failures and transmits only the saved mediator identity", async () => {
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"error":"rejected private-test-token","code":"STALE_MEDIATOR_ASSIGNMENT"}', { status: 409 }));
  const { client } = fixture(transport);
  const binding = { provider: "codex" as const, participant: "owner", sessionId: "session", profileId: "profile", scope: "global", version: 4 };
  await expect(client.request("POST", "/api/topics/t/actions/resume", { decision: "keep" }, { actor: "mediator", binding })).rejects.toThrow("[REDACTED]");
  expect(transport.mock.calls[0][1]?.headers).toMatchObject({ "x-consensus-actor": "mediator", "x-consensus-mediator": "owner", "x-consensus-mediator-version": "4" });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("preserves retry evidence when a response body fails after HTTP headers arrive", async () => {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
    start(controller) { controller.error(new Error("body connection lost private-test-token")); },
  })));
  const { client, config } = fixture(transport);
  await expect(client.request("POST", "/api/topics", { title: "partial" }, { requestId: "body-lost" })).rejects.toThrow("--request-id body-lost");
  expect(readFileSync(join(config.dataDirectory, "cli-requests/body-lost.json"), "utf8")).toContain('"title": "partial"');
});

it("refuses mutations against a running server for the previous configured project", async () => {
  const { config } = fixture(vi.fn());
  const transport = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ repositoryPath: "/a/different/project" })));
  const client = new RoomClient(config, transport);
  await expect(client.request("POST", "/api/topics", { title: "wrong project" })).rejects.toThrow("프로젝트 경로가 로컬 설정과 다릅니다");
  expect(transport).toHaveBeenCalledTimes(1);
  expect(new URL(String(transport.mock.calls[0][0])).pathname).toBe("/api/config");
});

it("does not promise replay for force-collection endpoints without a request ledger", async () => {
  const { client } = fixture(vi.fn<typeof fetch>().mockRejectedValue(new Error("response lost")));
  await expect(client.request("POST", "/api/evidence/source-1/check", { force: true }, { requestId: "force-check" }))
    .rejects.toThrow("중복 실행 방지는 확인되지 않았으므로 자동 재호출하지 마세요");
});
