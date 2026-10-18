import { lstatSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRoomConfig, defaultConfigPath, readRoomConfig, roomEnvironment, writeInitialConfig, type RoomConfig } from "../src/cli/config.js";
import { defaultDataDirectory } from "../src/server/config.js";

// Public configuration boundary -> startup environment / persisted settings. No provider or runtime claims.
const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "room-config-")));
  temporary.push(root);
  const config = createRoomConfig({ repositoryPath: join(root, "repository"), dataDirectory: join(root, "data"),
    claudeModel: "claude-user-choice", codexModel: "codex-user-choice" });
  return { root, config };
}

it("creates portable opt-in settings with explicit models, without requiring a Git checkout", () => {
  const { config } = fixture();
  expect(config.agents).toEqual({ claude: { model: "claude-user-choice", effort: "medium",
    implementation: { model: "claude-user-choice", effort: "medium" }, advisorModel: null, ultracode: false },
  codex: { model: "codex-user-choice", effort: "medium" } });
  expect(config.figmaMcpUrl).toBeNull();
  expect(defaultConfigPath()).toBe(join(defaultDataDirectory(), "room.json"));
  expect(() => createRoomConfig({ repositoryPath: "/uncreated/repo", claudeModel: "opus", codexModel: "gpt-custom" })).not.toThrow();
});

it.each(["", "   "])("requires a model choice instead of a private default: %j", value => {
  expect(() => createRoomConfig({ repositoryPath: "/repo", claudeModel: value, codexModel: "gpt-custom" })).toThrow("Invalid room configuration");
  expect(() => createRoomConfig({ repositoryPath: "/repo", claudeModel: "opus", codexModel: value })).toThrow("Invalid room configuration");
});

it.each([0, 65536, 4317.5, NaN])("rejects an invalid listening port: %s", port => {
  expect(() => createRoomConfig({ repositoryPath: "/repo", port, claudeModel: "opus", codexModel: "gpt-custom" })).toThrow();
});

it("normalizes absolute paths and keeps implementation settings distinct", () => {
  const config = createRoomConfig({ repositoryPath: "/workspace/other/../repo", port: 65535, claudeModel: "opus",
    codexModel: "gpt-custom", claudeEffort: "high", implementationModel: "sonnet", implementationEffort: "medium" });
  expect(config.repositoryPath).toBe("/workspace/repo");
  expect(config.agents.claude.implementation).toEqual({ model: "sonnet", effort: "medium" });
  expect(() => createRoomConfig({ repositoryPath: "relative/repo", claudeModel: "opus", codexModel: "gpt-custom" })).toThrow();
});

it("writes once with private file and newly-created directory modes", () => {
  const { root, config } = fixture();
  const file = join(root, "new-parent", "nested", "room.json");
  writeInitialConfig(file, config);
  expect(readRoomConfig(file)).toEqual(config);
  expect(statSync(file).mode & 0o777).toBe(0o600);
  expect(statSync(join(root, "new-parent")).mode & 0o777).toBe(0o700);
  expect(statSync(join(root, "new-parent", "nested")).mode & 0o777).toBe(0o700);
  const before = readFileSync(file, "utf8");
  expect(() => writeInitialConfig(file, { ...config, port: 9999 })).toThrow("Refusing to overwrite");
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("refuses existing and dangling config symlinks, and symlink parents", () => {
  const { root, config } = fixture();
  const target = join(root, "target.json"), link = join(root, "room.json");
  writeFileSync(target, "preserve me");
  symlinkSync(target, link);
  expect(() => writeInitialConfig(link, config)).toThrow();
  expect(lstatSync(link).isSymbolicLink()).toBe(true);
  expect(readFileSync(target, "utf8")).toBe("preserve me");
  const dangling = join(root, "dangling.json");
  symlinkSync(join(root, "missing.json"), dangling);
  expect(() => writeInitialConfig(dangling, config)).toThrow();
  const actual = join(root, "actual-parent"), parent = join(root, "linked-parent");
  mkdirSync(actual); symlinkSync(actual, parent);
  expect(() => writeInitialConfig(join(parent, "room.json"), config)).toThrow("symlink");
});

it("keeps personal configuration outside the target and tool source repositories", () => {
  const { config } = fixture();
  expect(() => writeInitialConfig(join(config.repositoryPath, "room.json"), config)).toThrow("outside the target repository");
  expect(() => writeInitialConfig(join(process.cwd(), "personal-room.json"), config)).toThrow("outside the target repository");
});

it("rejects unknown secret fields and malformed JSON without echoing their values", () => {
  const { root, config } = fixture(), file = join(root, "room.json");
  writeFileSync(file, JSON.stringify({ ...config, token: "DO_NOT_PRINT_SECRET" }));
  expect(() => readRoomConfig(file)).toThrow("Invalid room configuration");
  try { readRoomConfig(file); } catch (error) { expect(String(error)).not.toContain("DO_NOT_PRINT_SECRET"); }
  writeFileSync(file, '{"secret":"DO_NOT_PRINT_SECRET"');
  expect(() => readRoomConfig(file)).toThrow("Cannot read room configuration JSON");
  try { readRoomConfig(file); } catch (error) { expect(String(error)).not.toContain("DO_NOT_PRINT_SECRET"); }
  expect(() => writeInitialConfig(join(root, "other.json"), { ...config, auth: "DO_NOT_PRINT_SECRET" } as RoomConfig)).toThrow();
});

it("replaces stale room state and tokens while retaining HOME and explicit provider homes", () => {
  const { root, config } = fixture();
  vi.stubEnv("CONSENSUS_ROOM_REPOSITORY", "/stale/repo"); vi.stubEnv("CONSENSUS_ROOM_TOKEN", "stale-secret");
  vi.stubEnv("CONSENSUS_ROOM_PORT", "9999"); vi.stubEnv("CONSENSUS_ROOM_WEB_DIR", "/stale/dist");
  vi.stubEnv("CONSENSUS_ROOM_TOPIC_ID", "stale-topic"); vi.stubEnv("CODEX_HOME", "/stale/codex");
  vi.stubEnv("CLAUDE_CONFIG_DIR", "/stale/claude");
  const env = roomEnvironment({ ...config, codexHome: join(root, "codex"), claudeConfigDirectory: join(root, "claude"),
    agents: { ...config.agents, claude: { ...config.agents.claude, implementation: { model: "sonnet", effort: "high" } } } });
  expect(env.CONSENSUS_ROOM_REPOSITORY).toBe(config.repositoryPath);
  expect(env.CONSENSUS_ROOM_PORT).toBe("4317");
  expect(env.CONSENSUS_ROOM_TOKEN).toBeUndefined(); expect(env.CONSENSUS_ROOM_TOPIC_ID).toBeUndefined();
  expect(env.CONSENSUS_ROOM_WEB_DIR).toBeUndefined();
  expect(env.HOME).toBe(process.env.HOME);
  expect(env.CODEX_HOME).toBe(join(root, "codex")); expect(env.CLAUDE_CONFIG_DIR).toBe(join(root, "claude"));
  // Implementation settings are applied through the role profile API by configure,
  // not through environment variables the server does not consume.
  expect(env.CONSENSUS_ROOM_CLAUDE_IMPLEMENTATION_MODEL).toBeUndefined();
  expect(env.CONSENSUS_ROOM_CLAUDE_IMPLEMENTATION_EFFORT).toBeUndefined();
  expect(env.CONSENSUS_ROOM_CLAUDE_SKILL_DIRS).toBe(""); expect(env.CONSENSUS_ROOM_CODEX_SKILL_DIRS).toBe("");
  expect(env.CONSENSUS_ROOM_FIGMA_MCP_URL).toBe("");
  expect(process.env.CONSENSUS_ROOM_TOKEN).toBe("stale-secret");
});

it.each(["http://remote.example/mcp", "http://localhost/mcp?token=secret", "http://user:secret@localhost/mcp"])("rejects unsafe Figma endpoints before startup: %s", figmaMcpUrl => {
  const { config } = fixture();
  expect(() => roomEnvironment({ ...config, figmaMcpUrl })).toThrow("Invalid room configuration");
});
