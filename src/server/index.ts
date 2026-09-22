import { ClaudeAdapter } from "./adapters/claude.js";
import { CodexAdapter } from "./adapters/codex.js";
import { buildApp } from "./app.js";
import { ConsensusDatabase } from "./database.js";
import type { MemoryReaderOptions } from "./projectMemory.js";
import { loadConfig } from "./config.js";
import { SpawnCommandRunner } from "./processRunner.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const config = loadConfig();
const runner = new SpawnCommandRunner();
const database = new ConsensusDatabase(config.databasePath);
const memoryReaderOptions: MemoryReaderOptions = { resolveEvidenceStatus: dependencies => database.evidence.status(dependencies) };
const app = await buildApp({
  config,
  database,
  runner,
  claude: new ClaudeAdapter(runner, config.memoryDirectory, {
    memoryReaderOptions,
    protectedWritePaths: [config.dataDirectory, config.memoryDirectory],
    figmaMcpUrl: config.figmaMcpUrl,
    skillsDirectories: config.claudeSkillDirectories,
    managedPluginDirectory: join(config.dataDirectory, "claude-plugin"),
    repositoryPath: config.repositoryPath,
    onZeroTurnRetry: () => console.warn("[claude] 0턴 합성 결과(num_turns=0) — 같은 호출을 한 번 더 돌립니다"),
  }),
  codex: new CodexAdapter(
    runner,
    join(config.dataDirectory, "agent-result.schema.json"),
    undefined,
    config.memoryDirectory,
    { memoryReaderOptions, skillsDirectories: config.codexSkillDirectories, repositoryPath: config.repositoryPath, maxConcurrentTurns: config.codexConcurrency },
  ),
});

await app.listen({ host: config.host, port: config.port });
const launchURL = `http://${config.host}:${config.port}/?token=${config.launchToken}`;
// 토큰이 재시작마다 바뀌므로, 사용자가 세션에 묻지 않고 브라우저를 열 수 있게 현재 URL을 고정 위치에 남긴다.
writeFileSync(join(config.dataDirectory, "consensus-room.url"), `${launchURL}\n`, { mode: 0o600 });
process.stdout.write(`Consensus Room: ${launchURL}\n`);

// SIGTERM/SIGINT 는 app.close() 로 흘려 onClose 훅(에이전트 중단 → 원장 마감 → DB 닫기)이 돌게 한다.
// 훅이 25초 안에 못 끝나면 강제 종료한다 — 무한 대기보다 재시작 회수에 맡기는 편이 낫다.
for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, () => {
    process.stdout.write(`${signal}: 실행 중인 에이전트를 중단하고 종료합니다.\n`);
    setTimeout(() => process.exit(1), 25_000).unref();
    void app.close().then(() => process.exit(0), (error: unknown) => {
      process.stderr.write(`종료 처리 실패: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
  });
}
