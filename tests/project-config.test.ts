import { afterEach, expect, it, vi } from "vitest";
import { join } from "node:path";
import { homedir } from "node:os";
import { defaultDataDirectory, loadConfig } from "../src/server/config";
afterEach(() => vi.unstubAllEnvs());
it("uses macOS and Linux user data conventions without a personal repository", () => {
  expect(defaultDataDirectory("darwin", "/home/user", {})).toBe("/home/user/Library/Application Support/ConsensusRoom");
  expect(defaultDataDirectory("linux", "/home/user", {})).toBe("/home/user/.local/share/consensus-room");
  expect(defaultDataDirectory("linux", "/home/user", { XDG_DATA_HOME: "/data" })).toBe("/data/consensus-room");
  vi.stubEnv("CONSENSUS_ROOM_REPOSITORY", undefined); vi.stubEnv("CONSENSUS_ROOM_MEMORY_DIR", undefined);
  vi.stubEnv("CONSENSUS_ROOM_CODEX_SKILL_DIRS", undefined);
  const config = loadConfig({ dataDirectory: "/tmp/config-fixture" });
  expect(config.repositoryPath).toBe(process.cwd());
  expect(config.memoryDirectory).toBe(join(process.cwd(), ".consensus-room", "memory"));
  expect(config.codexSkillDirectories[0]).toBe(join(homedir(), ".codex", "skills"));
});
it("isolates project and optional context paths; explicit caller configuration wins", () => {
  vi.stubEnv("CONSENSUS_ROOM_REPOSITORY", "/workspace/my python project");
  vi.stubEnv("CONSENSUS_ROOM_MEMORY_DIR", "/workspace/project notes");
  vi.stubEnv("CONSENSUS_ROOM_CODEX_SKILL_DIRS", "/workspace/shared skills:/workspace/local");
  vi.stubEnv("CONSENSUS_ROOM_CLAUDE_SKILL_DIRS", "");
  const config = loadConfig({ dataDirectory: "/tmp/config-fixture" });
  expect(config.repositoryPath).toBe("/workspace/my python project");
  expect(config.memoryDirectory).toBe("/workspace/project notes");
  expect(config.codexSkillDirectories).toEqual(["/workspace/shared skills", "/workspace/local"]);
  expect(config.claudeSkillDirectories).toEqual([]);
  expect(loadConfig({ dataDirectory: "/tmp/config-fixture", repositoryPath: "/workspace/override" }).repositoryPath).toBe("/workspace/override");
});
