import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  AgentSettingsSchema,
  DEFAULT_AGENT_SETTINGS,
  type AgentSettings,
} from "../shared/contracts.js";

export const SAMPLE_IOS_REPOSITORY = "/Users/example/sample-ios";
export const SAMPLE_IOS_MEMORY_DIRECTORY = join(
  homedir(),
  "Library",
  "Mobile Documents",
  "com~apple~CloudDocs",
  "shared-ai",
  "memory",
);
export const CLAUDE_SKILL_DIRECTORIES = [
  join(homedir(), ".claude", "skills"),
] as const;
export const CODEX_SKILL_DIRECTORIES = [
  join(
    homedir(),
    "Library",
    "Mobile Documents",
    "com~apple~CloudDocs",
    "codex-config",
    "skills",
  ),
  join(homedir(), ".codex", "skills", ".system"),
] as const;

export interface ServerConfig {
  host: "127.0.0.1";
  port: number;
  launchToken: string;
  dataDirectory: string;
  topicsDirectory: string;
  worktreesDirectory: string;
  databasePath: string;
  webDirectory: string;
  repositoryPath: string;
  memoryDirectory: string;
  claudeSkillDirectories: string[];
  codexSkillDirectories: string[];
  defaultAgentSettings: AgentSettings;
  // v1 MCP allowlist: Figma 읽기전용. 빈 문자열 env로 끌 수 있다.
  figmaMcpUrl: string | null;
  // 전체 동시 Codex 턴 상한(토픽 간). 토픽 안은 항상 직렬.
  codexConcurrency: number;
}

export function loadConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
  const dataDirectory = resolve(
    overrides.dataDirectory ??
      process.env.CONSENSUS_ROOM_DATA_DIR ??
      join(homedir(), "Library", "Application Support", "ConsensusRoom"),
  );
  // 환경변수로 지정한 데이터 디렉터리가 없으면 새로 만들지 않고 거부한다. 2026-09-08 실측: 재시작 스크립트가
  // 공백이 든 경로를 잘라 넘겨(`…/Library/Application`) 서버가 빈 DB 로 2분간 떠 있었다. 오타·잘림으로 빈 방이
  // 조용히 생기는 것보다 기동 실패가 낫다. 새 디렉터리를 쓰려면 먼저 만들어 두거나 변수를 지운다(기본 경로는 자동 생성).
  if (overrides.dataDirectory === undefined && process.env.CONSENSUS_ROOM_DATA_DIR && !existsSync(dataDirectory)) {
    throw new Error(
      `CONSENSUS_ROOM_DATA_DIR 이 없는 디렉터리를 가리킵니다: ${dataDirectory} — 빈 데이터 디렉터리를 새로 만들지 않습니다. ` +
      "경로를 확인하거나(공백·잘림), 의도한 것이면 먼저 mkdir 하십시오.",
    );
  }
  const defaultAgentSettings = AgentSettingsSchema.parse(overrides.defaultAgentSettings ?? {
    claude: {
      model: process.env.CONSENSUS_ROOM_CLAUDE_MODEL ?? DEFAULT_AGENT_SETTINGS.claude.model,
      effort: process.env.CONSENSUS_ROOM_CLAUDE_EFFORT ?? DEFAULT_AGENT_SETTINGS.claude.effort,
    },
    codex: {
      model: process.env.CONSENSUS_ROOM_CODEX_MODEL ?? DEFAULT_AGENT_SETTINGS.codex.model,
      effort: process.env.CONSENSUS_ROOM_CODEX_EFFORT ?? DEFAULT_AGENT_SETTINGS.codex.effort,
    },
  });
  return {
    host: "127.0.0.1",
    port: overrides.port ?? Number(process.env.CONSENSUS_ROOM_PORT ?? 4317),
    codexConcurrency: overrides.codexConcurrency ?? Math.max(1, Number(process.env.CONSENSUS_ROOM_CODEX_CONCURRENCY ?? 2) || 2),
    launchToken:
      overrides.launchToken ?? process.env.CONSENSUS_ROOM_TOKEN ?? randomBytes(32).toString("hex"),
    dataDirectory,
    topicsDirectory: resolve(overrides.topicsDirectory ?? join(dataDirectory, "topics")),
    worktreesDirectory: resolve(overrides.worktreesDirectory ?? join(dataDirectory, "worktrees")),
    databasePath: resolve(overrides.databasePath ?? join(dataDirectory, "consensus-room.sqlite")),
    webDirectory: resolve(overrides.webDirectory ?? join(process.cwd(), "dist")),
    repositoryPath: resolve(overrides.repositoryPath ?? SAMPLE_IOS_REPOSITORY),
    memoryDirectory: resolve(overrides.memoryDirectory ?? SAMPLE_IOS_MEMORY_DIRECTORY),
    claudeSkillDirectories: (overrides.claudeSkillDirectories ?? CLAUDE_SKILL_DIRECTORIES).map((path) => resolve(path)),
    codexSkillDirectories: (overrides.codexSkillDirectories ?? CODEX_SKILL_DIRECTORIES).map((path) => resolve(path)),
    defaultAgentSettings,
    figmaMcpUrl: overrides.figmaMcpUrl !== undefined
      ? overrides.figmaMcpUrl
      : (process.env.CONSENSUS_ROOM_FIGMA_MCP_URL ?? "http://127.0.0.1:3845/mcp") || null,
  };
}
