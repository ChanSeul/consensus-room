import { join } from "node:path";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "../adapters/claude.js";
import { CodexAdapter, type CodexAdapterOptions } from "../adapters/codex.js";
import type { MemoryReaderOptions } from "../projectMemory.js";
import type { AgentAdapter, CommandRunner } from "../types.js";
import type { AgentProvider } from "../../shared/roles.js";

export interface RuntimeOptions {
  dataDirectory: string;
  memoryDirectory?: string;
  claude?: Omit<ClaudeAdapterOptions, "managedPluginDirectory">;
  codex?: CodexAdapterOptions;
}

// 생성 설정만 공유한다. 실행 설정·CLI 인자·출력 해석은 기존 어댑터 한 곳에 남긴다.
// 메모리 본문 재열람 사본(엔진 결함 dffeb33f)은 두 공급자가 데이터 폴더의 한 내용 주소 폴더를 함께 쓴다. 쓰기는 sandbox 가 막는다 — Claude 는 데이터 폴더
// 쓰기 거부(protectedWritePaths), Codex 는 관리형 프로필의 읽기 항목이다. 기존 판독기 옵션(위키 원문 상태 안내)은 그대로 두고 폴더만 병합한다.
// 사본 생성·전달(판독기의 snapshotDirectory)은 메모리 폴더가 있을 때만 두고, 사본 루트의 읽기 거부는 메모리와 관계없이 두 공급자에 항상 넘긴다 — 메모리 없이
// 데이터 폴더만 받는 런타임(runtime/cli.ts)도 같은 데이터 폴더에 게시된 사본을 읽지 못해야 한다(F003). Codex 의 `":minimal" = "read"` 는 /private/tmp 같은
// 위치를 품어, 데이터 폴더가 거기 있으면 읽기 목록 밖의 사본도 읽혔다(자문 49 실측). 그래서 Codex 도 루트를 명시 deny 한다.
export function createRuntimeAdapters(runner: CommandRunner, options: RuntimeOptions): Record<AgentProvider, AgentAdapter> {
  const snapshotRoot = join(options.dataDirectory, "memory-snapshots");
  const snapshotDirectory = options.memoryDirectory ? snapshotRoot : undefined;
  const memoryReader = (given: MemoryReaderOptions | undefined) => snapshotDirectory ? { memoryReaderOptions: { ...given, snapshotDirectory } } : {};
  return {
    claude: new ClaudeAdapter(runner, options.memoryDirectory, {
      ...options.claude,
      ...memoryReader(options.claude?.memoryReaderOptions),
      managedPluginDirectory: join(options.dataDirectory, "claude-plugin"),
      protectedWritePaths: [options.dataDirectory, ...(options.memoryDirectory ? [options.memoryDirectory] : []),
        ...(options.claude?.protectedWritePaths ?? [])],
      protectedReadPaths: [snapshotRoot, ...(options.claude?.protectedReadPaths ?? [])],
    }),
    codex: new CodexAdapter(runner, join(options.dataDirectory, "agent-result.schema.json"), undefined,
      options.memoryDirectory, { ...options.codex, ...memoryReader(options.codex?.memoryReaderOptions),
        protectedReadPaths: [snapshotRoot, ...(options.codex?.protectedReadPaths ?? [])] }),
  };
}
