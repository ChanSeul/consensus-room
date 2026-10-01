import { createRuntimeAdapters } from "./runtime/providers.js";
import { buildApp, probeNestedSandbox } from "./app.js";
import { ConsensusDatabase } from "./database.js";
import type { MemoryReaderOptions } from "./projectMemory.js";
import { loadConfig } from "./config.js";
import { SpawnCommandRunner } from "./processRunner.js";
import { writeFileSync, renameSync, existsSync, readFileSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { systemProcessControl } from "./processSupervisor.js";

import { NativeAppReader } from "./evidence/nativeReader.js";
import { NativeEvidenceConnector } from "./evidence/nativeConnector.js";
import { resolveCodexExecutable } from "./adapters/codex.js";

const config = loadConfig();
const runner = new SpawnCommandRunner();
const database = new ConsensusDatabase(config.databasePath);
const memoryReaderOptions: MemoryReaderOptions = { resolveEvidenceStatus: dependencies => database.evidence.status(dependencies) };
// 샌드박스 안에서 뜬 서버는 러너·Codex 의 sandbox-exec 를 막는다. 방(UI·API)은 그대로 띄우고, 실행 허용 검사가 모든 에이전트 실행을 거부한다.
const hostSandbox = probeNestedSandbox();
if (hostSandbox.kind === "unavailable") {
  console.warn(`[host-sandbox] 서버가 macOS 샌드박스 안에서 실행 중입니다(${hostSandbox.detail}). 러너·Codex 실행을 거부합니다 — 샌드박스 밖(사용자 터미널)에서 재시작하세요.`);
}
const app = await buildApp({
  config,
  database,
  runner,
  hostSandbox,
  nativeEvidenceConnector: new NativeEvidenceConnector(new NativeAppReader(config.dataDirectory, resolveCodexExecutable(), undefined,
    (provider, metric, value) => database.evidence.measure(`identity:${provider}`, metric, value)), id => database.evidence.measure(id, "toolCalls", 1)),
  ...createRuntimeAdapters(runner, {
    dataDirectory: config.dataDirectory,
    memoryDirectory: config.memoryDirectory,
    claude: {
      memoryReaderOptions,
      figmaMcpUrl: config.figmaMcpUrl,
      skillsDirectories: config.claudeSkillDirectories,
      repositoryPath: config.repositoryPath,
      onZeroTurnRetry: () => console.warn("[claude] 0턴 합성 결과(num_turns=0) — 같은 호출을 한 번 더 돌립니다"),
    },
    codex: { memoryReaderOptions, skillsDirectories: config.codexSkillDirectories,
      repositoryPath: config.repositoryPath, maxConcurrentTurns: config.codexConcurrency },
  }),
});

const registry = join(config.dataDirectory, "server-process.json");
const identity = systemProcessControl.inspect(process.pid);
if (!identity) throw new Error("서버 프로세스 신원을 기록할 수 없습니다.");
app.addHook("onClose", async () => {
  if (existsSync(registry)) {
    try {
      const owner = JSON.parse(readFileSync(registry, "utf8"));
      if (owner.pid === process.pid && owner.startedAt === identity.startedAt) unlinkSync(registry);
    } catch { /* Leave an unrecognized process registry for the operator. */ }
  }
});
await app.listen({ host: config.host, port: config.port });
const registryTemporary = `${registry}.${process.pid}.tmp`;
writeFileSync(registryTemporary, JSON.stringify({ pid: process.pid, ...identity,
  executable: process.execPath, repositoryPath: resolve(import.meta.dirname, "../.."),
  dataDirectory: resolve(config.dataDirectory) }), { mode: 0o600 });
renameSync(registryTemporary, registry);
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
