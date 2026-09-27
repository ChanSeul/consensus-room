import { join } from "node:path";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "../adapters/claude.js";
import { CodexAdapter, type CodexAdapterOptions } from "../adapters/codex.js";
import type { AgentAdapter, CommandRunner } from "../types.js";
import type { AgentProvider } from "../../shared/roles.js";

export interface RuntimeOptions {
  dataDirectory: string;
  memoryDirectory?: string;
  claude?: Omit<ClaudeAdapterOptions, "managedPluginDirectory">;
  codex?: CodexAdapterOptions;
}

// 생성 설정만 공유한다. 실행 설정·CLI 인자·출력 해석은 기존 어댑터 한 곳에 남긴다.
export function createRuntimeAdapters(runner: CommandRunner, options: RuntimeOptions): Record<AgentProvider, AgentAdapter> {
  return {
    claude: new ClaudeAdapter(runner, options.memoryDirectory, {
      ...options.claude,
      managedPluginDirectory: join(options.dataDirectory, "claude-plugin"),
      protectedWritePaths: [options.dataDirectory, ...(options.memoryDirectory ? [options.memoryDirectory] : []),
        ...(options.claude?.protectedWritePaths ?? [])],
    }),
    codex: new CodexAdapter(runner, join(options.dataDirectory, "agent-result.schema.json"), undefined,
      options.memoryDirectory, options.codex),
  };
}
