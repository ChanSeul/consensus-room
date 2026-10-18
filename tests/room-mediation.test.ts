import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { buildApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { ConsensusDatabase } from "../src/server/database.js";
import { SpawnCommandRunner } from "../src/server/processRunner.js";
import type { AgentAdapter } from "../src/server/types.js";
import { createRoomConfig } from "../src/cli/config.js";
import { RoomClient } from "../src/cli/client.js";
import { claudeMcpConfig, configureWorkers, connectMediator, createTopic, prepareParticipants, verifyMediator } from "../src/cli/mediation.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cr-cli-mediate-")), repo = join(root, "project"), data = join(root, "data");
  mkdirSync(repo); mkdirSync(data);
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q"); git("config", "user.name", "Test"); git("config", "user.email", "test@example.invalid");
  writeFileSync(join(repo, "README.md"), "fixture\n"); git("add", "README.md"); git("commit", "-qm", "fixture");
  const config = createRoomConfig({ repositoryPath: repo, dataDirectory: data, claudeModel: "my-planner", implementationModel: "my-implementer", codexModel: "my-reviewer" });
  writeFileSync(join(data, "consensus-room.url"), "http://127.0.0.1:4317/?token=fixture-token", { mode: 0o600 });
  let modelCalls = 0;
  const refuse = async (): Promise<never> => { modelCalls++; throw new Error("Setup must not run a model"); };
  const adapter = (role: "claude" | "codex"): AgentAdapter => ({ role, createSession: refuse, resumeTurn: refuse, validateExistingSession: refuse });
  const server = loadConfig({ dataDirectory: data, repositoryPath: repo, memoryDirectory: join(root, "memory"),
    launchToken: "fixture-token", enforceBudgets: false, webDirectory: join(root, "no-web") });
  const db = new ConsensusDatabase(server.databasePath);
  const app = await buildApp({ config: server, database: db, runner: new SpawnCommandRunner(), claude: adapter("claude"), codex: adapter("codex") });
  cleanups.push(async () => { await app.close(); rmSync(root, { recursive: true, force: true }); });
  const transport: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    const response = await app.inject({ method: options!.method as "GET" | "POST", url: url.pathname + url.search,
      headers: options!.headers as Record<string, string>, ...(options?.body ? { payload: String(options.body) } : {}) });
    return new Response(response.body, { status: response.statusCode });
  };
  return { config, api: new RoomClient(config, transport), get modelCalls() { return modelCalls; } };
}

it("configures effective worker roles and creates a ready planned topic through authenticated APIs without model calls", async () => {
  const f = await fixture();
  const first = await configureWorkers(f.api, f.config);
  expect((await configureWorkers(f.api, f.config)).map(row => row.version)).toEqual(first.map(row => row.version));
  const binding = await connectMediator(f.api, f.config, { provider: "codex", participant: "me", sessionId: "actual-session", model: "my-mediator", effort: "medium" });
  const topic = await createTopic(f.api, { title: "First planned", mode: "planned", requestId: "stable-topic" });
  const replay = await createTopic(f.api, { title: "First planned", mode: "planned", requestId: "stable-topic" });
  expect(replay.id).toBe(topic.id);
  const before = await f.api.request<{ topic: { participants: unknown[] }; routing: unknown }>("GET", `/api/topics/${topic.id}`);
  expect(before.topic.participants).toHaveLength(2);
  await prepareParticipants(f.api, topic.id);
  const after = await f.api.request<{ topic: { participants: unknown[] } }>("GET", `/api/topics/${topic.id}`);
  expect(after.topic.participants).toEqual(before.topic.participants);
  expect(JSON.stringify(before.routing)).toContain("my-implementer");
  expect(await verifyMediator(f.api, f.config, topic.id)).toEqual(binding);
  expect(topic.nextCommand).toContain("/actions/plan");
  expect(f.modelCalls).toBe(0);
});

it("preserves existing role choices and refuses stale mediator bindings after an explicit reassignment", async () => {
  const f = await fixture();
  await configureWorkers(f.api, f.config);
  const changed = structuredClone(f.config); changed.agents.claude.implementation.model = "changed-model";
  await expect(configureWorkers(f.api, changed)).rejects.toThrow("--replace");
  await configureWorkers(f.api, changed, true);
  await connectMediator(f.api, f.config, { provider: "codex", participant: "me", sessionId: "first-session", model: "my-mediator", effort: "medium" });
  const topic = await createTopic(f.api, { title: "First ticket", mode: "ticket" });
  expect(topic.nextCommand).toContain("/actions/implement");
  const saved = readFileSync(join(f.config.dataDirectory, "mediator.json"));
  await expect(connectMediator(f.api, f.config, { provider: "codex", participant: "me", sessionId: "second-session", model: "my-mediator", effort: "medium" })).rejects.toThrow("--replace");
  await connectMediator(f.api, f.config, { provider: "codex", participant: "me", sessionId: "second-session", model: "my-mediator", effort: "medium", replace: true });
  writeFileSync(join(f.config.dataDirectory, "mediator.json"), saved);
  await expect(verifyMediator(f.api, f.config, topic.id)).rejects.toThrow("중재자 배정이 저장된 연결과 다릅니다");
});

it("creates token-free Claude MCP configuration that resolves its runtime independently of the caller cwd", () => {
  const value = claudeMcpConfig("/private/config/room.json", "topic-1");
  const entry = (value as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers["consensus-room"];
  expect(entry.command).toBe(process.execPath);
  expect(entry.args[1]).toMatch(/^\//);
  expect(entry.args).toContain("/private/config/room.json");
  expect(JSON.stringify(value)).not.toContain("token");
});
