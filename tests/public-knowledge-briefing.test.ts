import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { createRoomConfig } from "../src/cli/config.js";

// The consumer here is an already-open interactive mediator, so the observable
// delivery boundary is the real CLI's stdout, not a provider model turn.
const runFile = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const sourcePolicy = readFileSync(resolve("docs/mediation/policy.md"), "utf8");
const version = (text: string) => createHash("sha256").update(text).digest("hex");

async function fixture(provider: "claude" | "codex", policy = { text: sourcePolicy as string | null, version: version(sourcePolicy) as string | null, error: null as string | null }) {
  const root = mkdtempSync(join(tmpdir(), "cr-briefing-empty-"));
  const home = join(root, "empty-home"), data = join(root, "data"), project = join(root, "project");
  for (const path of [home, data, project, join(home, ".codex"), join(home, ".claude"), join(root, "empty-memory")]) mkdirSync(path, { recursive: true });
  const binding = { provider, participant: "mediator", sessionId: `${provider}-existing-session`, profileId: "profile", scope: "global", version: 1 };
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    if (request.headers["x-consensus-token"] !== "private-launch-canary") { response.writeHead(401); response.end("{}"); return; }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ assignment: { ...binding, role: "mediator", operation: "" }, profile: { provider }, policy }));
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const config = createRoomConfig({ repositoryPath: project, dataDirectory: data, port, claudeModel: "fixture-claude", codexModel: "fixture-codex" });
  config.memoryDirectory = join(root, "empty-memory"); config.claudeSkillDirectories = []; config.codexSkillDirectories = [];
  const configFile = join(root, "room.json");
  writeFileSync(configFile, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(data, "mediator.json"), JSON.stringify(binding), { mode: 0o600 });
  writeFileSync(join(data, "consensus-room.url"), `http://127.0.0.1:${port}/?token=private-launch-canary`, { mode: 0o600 });
  cleanups.push(async () => {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    rmSync(root, { recursive: true, force: true });
  });
  const run = () => runFile(process.execPath, ["--import", import.meta.resolve("tsx"), resolve("src/cli/room.ts"), "briefing", "--config", configFile, "--topic", "topic-1"], {
    cwd: project,
    // This is only the child's home. The host's home, instructions and account remain untouched.
    env: { PATH: process.env.PATH, HOME: home, CODEX_HOME: join(home, ".codex"), CLAUDE_CONFIG_DIR: join(home, ".claude"), LANG: "C" },
    timeout: 15_000, maxBuffer: 512 * 1024,
  });
  return { run, requests, root, home };
}

it.each(["claude", "codex"] as const)("delivers the full current policy to a %s mediator through CLI stdout with an empty home", async provider => {
  const f = await fixture(provider);
  const { stdout, stderr } = await f.run();
  expect(stderr).toBe("");
  expect(stdout).toContain(`공통 정책 본문 시작 · SHA-256 ${version(sourcePolicy)}\n${sourcePolicy}\n공통 정책 본문 끝`);
  expect(stdout).toContain(`${provider}-existing-session`);
  expect(stdout).not.toContain("private-launch-canary");
  expect(f.requests).toEqual(["/api/mediation/context?topic=topic-1"]);
});

it.each([
  { text: null, version: null, error: "missing policy" },
  { text: sourcePolicy, version: "0".repeat(64), error: null },
  { text: "An older policy without portable worker knowledge", version: version("An older policy without portable worker knowledge"), error: null },
])("does not emit a successful briefing when current knowledge is unavailable or inconsistent %#", async policy => {
  const f = await fixture("codex", policy);
  try { await f.run(); throw new Error("briefing unexpectedly succeeded"); }
  catch (error) {
    const failure = error as { code?: number; stdout?: string; stderr?: string };
    expect(failure.code).toBe(1);
    expect(failure.stdout).toBe("");
    expect(failure.stderr).toBeTruthy();
    expect(failure.stderr).not.toContain("private-launch-canary");
  }
});
