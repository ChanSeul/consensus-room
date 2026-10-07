// 테스트는 호스트에 설치된 codex·claude CLI 에 기대지 않는다 — 이 파일이 그 불변식의 유일한 집행점이다(vitest.config.ts setupFiles).
// 어댑터는 실행 파일을 쓸 때마다 PATH 에서 풀고, 못 찾으면 bare 이름 대신 HostRuntimeUnavailable 로 멈춘다(src/server/hostRuntime.ts).
// 그래서 워커마다 가짜 CLI 를 PATH 앞에 둔다. 가짜 CLI 는 실행되면 사유를 stderr 에 쓰고 실패하므로, 테스트가 실제 공급자를 띄우려 하면 바로 드러난다.
// PATH 를 직접 바꾸는 테스트(CLI 소실 재현 등)는 자기 값을 그대로 쓴다. golden 은 이 디렉터리를 자리표시자로 정규화한다.
// 실제 CLI 를 요구하는 opt-in 검사(CONSENSUS_CODEX_SANDBOX_TEST)만 hostCliPath() 로 이 디렉터리를 뺀 호스트 PATH 를 선언한다.
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const TEST_CLI_DIRECTORY_ENV = "CONSENSUS_ROOM_TEST_CLI_DIRECTORY";

// 가짜 CLI 디렉터리를 뺀 PATH. 어댑터가 쓸 때마다 PATH 에서 풀므로, opt-in 검사는 어댑터를 부르기 전에 vi.stubEnv("PATH", hostCliPath()) 를 한다.
export function hostCliPath(): string {
  const directory = process.env[TEST_CLI_DIRECTORY_ENV];
  return (process.env.PATH ?? "").split(":").filter(entry => entry !== directory).join(":");
}

// 같은 프로세스가 여러 테스트 파일을 돌려도 디렉터리와 PATH 항목은 하나다. 실제 경로로 만들어 링크 경로와 실제 경로가 같게 한다.
const existing = process.env[TEST_CLI_DIRECTORY_ENV];
if (!existing || !existsSync(existing)) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "consensus-room-test-cli-")));
  for (const name of ["codex", "claude"]) {
    writeFileSync(join(directory, name), `#!/bin/sh\necho "test stub: the real ${name} CLI must not run in tests" >&2\nexit 97\n`, { mode: 0o755 });
  }
  process.env[TEST_CLI_DIRECTORY_ENV] = directory;
  process.env.PATH = `${directory}:${process.env.PATH ?? ""}`;
  process.once("exit", () => rmSync(directory, { recursive: true, force: true }));
}
