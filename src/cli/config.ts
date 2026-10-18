import { constants, closeSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { delimiter, dirname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { defaultDataDirectory } from "../server/config.js";
import { AgentEffortSchema } from "../shared/contracts.js";

export interface RoomConfig {
  version: 1;
  repositoryPath: string;
  dataDirectory: string;
  port: number;
  memoryDirectory?: string;
  standingReferencePath?: string;
  claudeSkillDirectories?: string[];
  codexSkillDirectories?: string[];
  codexHome?: string;
  claudeConfigDirectory?: string;
  figmaMcpUrl: string | null;
  agents: {
    claude: {
      model: string;
      effort: string;
      implementation: { model: string; effort: string };
      advisorModel: string | null;
      ultracode: boolean;
    };
    codex: { model: string; effort: string };
  };
}

const absolutePath = z.string().min(1).refine(value => isAbsolute(value) && !/[\0\r\n]/.test(value),
  "Use an absolute local path without control characters.").transform(value => normalize(value));
const skillPath = absolutePath.refine(value => !value.includes(delimiter), "Skill paths cannot contain the PATH delimiter.");
const model = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9._:-]+$/, "Use a model identifier, not credentials or a URL.");
const execution = z.object({ model, effort: AgentEffortSchema }).strict();
const figmaUrl = z.string().url().refine(value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      && !url.username && !url.password && !url.search && !url.hash;
  } catch { return false; }
}, "Figma must use a credential-free localhost HTTP(S) URL.");

const schema = z.object({
  version: z.literal(1), repositoryPath: absolutePath, dataDirectory: absolutePath,
  port: z.number().int().min(1).max(65535),
  memoryDirectory: absolutePath.optional(), standingReferencePath: absolutePath.optional(),
  claudeSkillDirectories: z.array(skillPath).optional(), codexSkillDirectories: z.array(skillPath).optional(),
  codexHome: absolutePath.optional(), claudeConfigDirectory: absolutePath.optional(),
  figmaMcpUrl: figmaUrl.nullable(),
  agents: z.object({
    claude: execution.extend({ implementation: execution, advisorModel: model.nullable(), ultracode: z.boolean() }).strict(),
    codex: execution,
  }).strict(),
}).strict();

function validated(value: unknown): RoomConfig {
  const result = schema.safeParse(value);
  if (!result.success) {
    // Never include the rejected JSON or credential values in CLI errors.
    throw new Error(`Invalid room configuration: ${result.error.issues.map(issue => `${issue.path.join(".") || "config"}: ${issue.message}`).join("; ")}`);
  }
  return result.data;
}

export function defaultConfigPath(): string {
  return join(defaultDataDirectory(), "room.json");
}

export function createRoomConfig(input: {
  repositoryPath: string; dataDirectory?: string; port?: number;
  claudeModel: string; codexModel: string; claudeEffort?: string; codexEffort?: string;
  implementationModel?: string; implementationEffort?: string;
}): RoomConfig {
  const claudeEffort = input.claudeEffort ?? "medium";
  return validated({
    version: 1, repositoryPath: input.repositoryPath, dataDirectory: input.dataDirectory ?? defaultDataDirectory(),
    port: input.port ?? 4317, figmaMcpUrl: null,
    agents: {
      claude: { model: input.claudeModel, effort: claudeEffort,
        implementation: { model: input.implementationModel ?? input.claudeModel, effort: input.implementationEffort ?? claudeEffort },
        advisorModel: null, ultracode: false },
      codex: { model: input.codexModel, effort: input.codexEffort ?? "medium" },
    },
  });
}

export function readRoomConfig(file: string): RoomConfig {
  let value: unknown;
  try { value = JSON.parse(readFileSync(file, "utf8")); }
  catch { throw new Error(`Cannot read room configuration JSON: ${file}`); }
  return validated(value);
}

function privateDirectory(directory: string): void {
  const parent = dirname(directory);
  if (parent !== directory) privateDirectory(parent);
  const existing = lstatSync(directory, { throwIfNoEntry: false });
  if (existing) {
    if (existing.isSymbolicLink() || !existing.isDirectory()) throw new Error(`Config parent must be a directory, not a symlink: ${directory}`);
    return;
  }
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const created = lstatSync(directory);
  if (created.isSymbolicLink() || !created.isDirectory()) throw new Error(`Config parent must be a directory, not a symlink: ${directory}`);
}

export function writeInitialConfig(file: string, config: RoomConfig): void {
  const checked = validated(config);
  if (!isAbsolute(file) || /[\0\r\n]/.test(file)) throw new Error("The config file must have an absolute local path.");
  const within = (directory: string) => {
    const path = relative(directory, file);
    return path === "" || (path !== ".." && !path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && !isAbsolute(path));
  };
  let repository = checked.repositoryPath;
  try { repository = realpathSync(repository); } catch { /* A repository need not exist at config creation time. */ }
  if ([checked.repositoryPath, repository, resolve(dirname(fileURLToPath(import.meta.url)), "../..")].some(within)) {
    throw new Error("Keep personal room configuration outside the target repository and Consensus Room checkout; use the default config directory.");
  }
  if (lstatSync(file, { throwIfNoEntry: false })) throw new Error(`Refusing to overwrite an existing config or symlink: ${file}`);
  privateDirectory(dirname(file));
  // Exclusive creation also rejects a file/symlink created after the existence check.
  const fd = openSync(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${JSON.stringify(checked, null, 2)}\n`, "utf8");
  } catch (error) {
    unlinkSync(file);
    throw error;
  } finally { closeSync(fd); }
}

export function roomEnvironment(config: RoomConfig): NodeJS.ProcessEnv {
  const checked = validated(config);
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("CONSENSUS_ROOM_")) delete env[key];
  Object.assign(env, {
    CONSENSUS_ROOM_REPOSITORY: checked.repositoryPath,
    CONSENSUS_ROOM_DATA_DIR: checked.dataDirectory,
    CONSENSUS_ROOM_PORT: String(checked.port),
    CONSENSUS_ROOM_MEMORY_DIR: checked.memoryDirectory ?? join(checked.repositoryPath, ".consensus-room", "memory"),
    CONSENSUS_ROOM_STANDING_REFERENCE: checked.standingReferencePath ?? "",
    CONSENSUS_ROOM_CLAUDE_SKILL_DIRS: (checked.claudeSkillDirectories ?? []).join(delimiter),
    CONSENSUS_ROOM_CODEX_SKILL_DIRS: (checked.codexSkillDirectories ?? []).join(delimiter),
    CONSENSUS_ROOM_FIGMA_MCP_URL: checked.figmaMcpUrl ?? "",
    CONSENSUS_ROOM_CLAUDE_MODEL: checked.agents.claude.model,
    CONSENSUS_ROOM_CLAUDE_EFFORT: checked.agents.claude.effort,
    CONSENSUS_ROOM_CODEX_MODEL: checked.agents.codex.model,
    CONSENSUS_ROOM_CODEX_EFFORT: checked.agents.codex.effort,
  });
  if (checked.codexHome) env.CODEX_HOME = checked.codexHome;
  if (checked.claudeConfigDirectory) env.CLAUDE_CONFIG_DIR = checked.claudeConfigDirectory;
  return env;
}
