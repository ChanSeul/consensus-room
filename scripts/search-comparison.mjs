import { execFileSync } from "node:child_process";

const room = process.cwd();
const duse = "/Users/example/sample-ios";
// 각 probe는 단일 HEAD 파일 안에서 선언·사용·테스트 경계 중 하나를 확인한다. 넓은 디렉터리 검색의
// 결과 개수 비교는 20개 상한 때문에 의미가 없으므로, 같은 immutable HEAD에서 위치를 정확히 대조한다.
const probes = [
  [room, "TurnUsage", "src/server/types.ts"],
  [room, "ClaudeAdapter", "src/server/adapters/claude.ts"],
  [room, "getPromptTimeline", "src/server/database.ts"],
  [room, "loadConfig", "src/server/config.ts"],
  [room, "AbortError", "src/server/processRunner.ts"],
  [room, "runMediatorVerification", "src/server/verificationCli.ts"],
  [duse, "NotiFilterViewModel", "Modules/Shared/FilterUI/NotiFilterViewModel.swift"],
  [duse, "AppRouterTrackingIntegrationTests", "AppRouteContractTests/AppRouterTrackingIntegrationTests.swift"],
  [duse, "NetworkCore", "Modules/Shared/StaticMap/StaticMapAPI.swift"],
  [duse, "DesignSystem", "Modules/Shared/DesignSystem/Components/AppBar/SUAppBar.swift"],
  [duse, "SwiftUI", "Modules/Shared/FilterUI/NotiFilterScreen.swift"],
  [duse, "XCTest", "AppRouteContractTests/AppRouteCatalogTests.swift"],
];

function output(command, args, cwd) {
  try {
    return execFileSync(command, args, { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    if (error && typeof error === "object" && error.status === 1) return "";
    throw error;
  }
}

function baseline(repository, symbol, path) {
  const text = output("git", ["grep", "-n", "--fixed-strings", "--", symbol, "HEAD", "--", path], repository);
  return text.split(/\r?\n/).filter(Boolean).map((line) => {
    const match = line.match(/^HEAD:(.+?):(\d+):/);
    if (!match) throw new Error(`git grep 결과를 읽지 못했습니다: ${line}`);
    return { file: match[1], line: Number(match[2]) };
  });
}

let failures = 0;
for (const [repository, symbol, path] of probes) {
  const expected = baseline(repository, symbol, path);
  const raw = output("npm", ["run", "explore", "--silent", "--", "--repository", repository, "--symbol", symbol, "--path", path], room);
  const explorer = JSON.parse(raw);
  const actual = new Set(explorer.locations.map((item) => `${item.file}:${item.line}`));
  const missing = expected.filter((item) => !actual.has(`${item.file}:${item.line}`));
  const serializedBytes = Buffer.byteLength(`${JSON.stringify(explorer, null, 2)}\n`, "utf8");
  const valid = expected.length > 0 && missing.length === 0 && serializedBytes <= 16 * 1024 && explorer.omitted === false;
  console.log(JSON.stringify({
    symbol, path, baseline: { count: expected.length }, explorer: {
      count: explorer.locations.length, bytes: serializedBytes, omitted: explorer.omitted,
    }, missing, pass: valid,
  }));
  if (!valid) failures += 1;
}
if (failures) process.exitCode = 1;
