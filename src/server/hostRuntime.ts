import { execFile } from "node:child_process";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { redactSecrets } from "../shared/workflow.js";

// 에이전트 턴이 기대는 호스트 실행 파일(사용자 파일 리더의 node, 공급자 CLI, 계획 필수 검사의 swiftc)의 유일한 해석·분류 소유자다.
// 부팅 때 경로를 고정하지 않는다 — brew 가 node keg 를 바꾸거나 앱 업데이트가 CLI 링크를 옮기면 고정 경로는 서버 수명 내내 깨진 채 남았다
// (2026-10-05 1fd0cc86 리더 dyld SIGABRT, 2026-09-29 'spawn codex ENOENT'). 쓸 때마다 풀고, 못 풀면 bare 이름으로 폴백하지 않고
// HostRuntimeUnavailable 를 던진다. 그 오류는 core.startAction 한 분기에서 resource 정지(admissionRefused: "host-runtime")가 된다.
// Codex 는 sandbox 안에서 자기 자신을 다시 실행하므로 PATH 의 심볼릭 링크가 아니라 실제 경로를 읽기 허용·실행에 함께 써야 한다(2026-08-29 실측).
export type HostExecutable = "node" | "codex" | "claude" | "swiftc";

export interface HostExecutableInfo { name: HostExecutable; path: string; realPath: string; version?: string }

const REMEDY: Record<HostExecutable, string> = {
  node: "node 설치·업그레이드가 끝났는지 확인한 뒤 retry 하세요 — 서버 재시작은 필요 없습니다",
  codex: "PATH 의 codex CLI 설치(링크)를 확인한 뒤 retry 하세요",
  claude: "PATH 의 claude CLI 설치(링크)를 확인한 뒤 retry 하세요",
  swiftc: "Xcode Command Line Tools(`xcrun --find swiftc`)를 확인한 뒤 retry 하세요",
};

export class HostRuntimeUnavailable extends Error {
  readonly remedy: string;
  constructor(readonly item: HostExecutable, readonly executable: string, readonly detail: string) {
    const remedy = REMEDY[item];
    // stderr 꼬리가 실릴 수 있다 — 정지 이벤트 본문은 다시 가리지 않으므로 여기서 한 번 가린다.
    super(redactSecrets(`Host runtime unavailable: ${item} (${executable}): ${detail}. ${remedy}.`));
    this.name = "HostRuntimeUnavailable";
    this.remedy = remedy;
  }
}

const run = promisify(execFile);

async function executableOnPath(name: string, env: NodeJS.ProcessEnv): Promise<{ path: string; realPath: string } | null> {
  for (const directory of (env.PATH ?? "").split(":")) {
    // 상대 PATH 항목은 서버 작업 폴더에 따라 뜻이 바뀌므로 보지 않는다.
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    try {
      // 끊어진 링크(옛 keg·옮겨진 CLI)는 stat 이 실패해 다음 항목으로 넘어간다.
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return { path: candidate, realPath: await realpath(candidate) };
    } catch { /* 다음 PATH 항목 */ }
  }
  return null;
}

export async function resolveHostExecutable(name: HostExecutable, options: { version?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<HostExecutableInfo> {
  const env = options.env ?? process.env;
  let found: { path: string; realPath: string } | null;
  if (name === "swiftc") {
    const located = await run("/usr/bin/xcrun", ["--find", "swiftc"], { env, timeout: 30_000 })
      .then(({ stdout }) => stdout.trim(), (error: Error & { stderr?: string }) => {
        throw new HostRuntimeUnavailable(name, "xcrun --find swiftc", (error.stderr || error.message).trim().slice(-2000));
      });
    found = located ? await realpath(located).then(realPath => ({ path: located, realPath }), () => null) : null;
    if (!found) throw new HostRuntimeUnavailable(name, "xcrun --find swiftc", `no usable path (${located || "empty output"})`);
  } else {
    found = await executableOnPath(name, env);
    if (!found) throw new HostRuntimeUnavailable(name, name, "not found on PATH");
  }
  if (!options.version) return { name, ...found };
  const version = await run(found.realPath, ["--version"], { env, timeout: 30_000 })
    .then(({ stdout, stderr }) => (stdout || stderr).split("\n")[0].trim(), (error: Error) => {
      throw new HostRuntimeUnavailable(name, found!.realPath, `--version failed: ${error.message}`);
    });
  return { name, ...found, version };
}
