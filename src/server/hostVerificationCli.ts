import { randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { defaultDataDirectory } from "./config.js";
import { DEFAULT_PRESERVE_PATHS, describeHostVerification, HOST_VERIFICATION_ENV, runHostVerification, type HostVerificationResult } from "./hostVerification.js";

// 중재자 CLI 의 호스트 검증 실행 — `npm run verify:host -- --label <이름> [옵션] -- <명령> [인자...]`.
// 명령은 소유 스크래치(build·cache·work·tmp)를 환경 변수와 인자 토큰으로 받고, 끝나면 지정한 로그·결과가 증거 폴더로 보존된 뒤 스크래치가 지워진다
// (hostVerification.ts). 종료 코드: 0 = 검증 성공 + 보존 + 삭제 완료 · 1 = 검증 실패·취소·시간 초과 · 2 = 사용법·spawn 실패 ·
// 3 = 검증은 성공했으나 보존 또는 삭제 실패(성공으로 가리지 않는다). stdout 에 result JSON, stderr 에 한 줄 요약.
export const HOST_VERIFICATION_USAGE = `사용법: npm run verify:host -- --label <이름> [--cwd DIR] [--evidence-dir DIR | --data-dir DIR] [--scratch-base DIR]
                                   [--timeout-seconds N] [--preserve REL]... [--preserve-optional REL]... -- <명령> [인자...]
  --label             증거 폴더·스크래치 이름에 쓰는 식별자(영문·숫자·._-, 40자 이내).
  --cwd               명령의 작업 폴더(기본: 현재 폴더). {work} 토큰을 쓰면 소유 work 폴더에서 실행한다.
  --evidence-dir      이 실행 전용 영구 증거 폴더(없으면 만들고, 있으면 비어 있어야 하며 command.json 을 먼저 만든 실행 하나만 쓴다).
                      없으면 <data-dir>/host-verification/<label>-<시각>-<난수>.
  --scratch-base      스크래치 루트를 만들 상위 폴더(기본: 시스템 임시 폴더).
  --timeout-seconds   초과하면 프로세스 그룹을 끝내고 timed_out 으로 기록한다(기본: 제한 없음).
  --preserve          스크래치 기준 상대 경로를 증거 폴더 preserved/ 아래로 더 보존한다(없으면 보존 실패 → 스크래치 보존).
  --preserve-optional 같은 보존이지만 없으면 missing 으로만 기록하고 삭제를 막지 않는다.
  표준 증거 ${DEFAULT_PRESERVE_PATHS.join("·")} 와 build 바로 아래 *.xcresult 는 선언 없이도 있으면 보존한다. 보존 트리 밖·절대 경로·끊긴 링크가
  들어 있으면 그 항목은 보존 실패다. 명령이 스크래치 루트를 다른 폴더로 바꾸면(dev/ino 불일치) 보존도 삭제도 하지 않는다.
  명령 인자의 {build} {cache} {work} {tmp} {evidence} 는 소유 경로로 바뀐다. 환경 변수 ${Object.values(HOST_VERIFICATION_ENV).join(" ")} 와
  TMPDIR·XDG_CACHE_HOME·CLANG_MODULE_CACHE_PATH 도 스크래치를 가리킨다. SIGINT·SIGTERM·SIGHUP 은 취소로 전달돼 프로세스 그룹을 끝낸 뒤 정리한다.
예: npm run verify:host -- --label cpa --cwd /path/to/worktree --preserve build/Logs --preserve-optional build/TestResults -- \\
      xcodebuild -workspace App.xcworkspace -scheme App -derivedDataPath {build} build
`;

export function exitCodeFor(result: HostVerificationResult): number {
  if (result.status === "spawn_failed") return 2;
  if (result.status !== "succeeded") return 1;
  return result.complete ? 0 : 3;
}

function evidenceDirectoryFor(dataDirectory: string, label: string): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(dataDirectory, "host-verification", `${label}-${stamp}-${randomBytes(3).toString("hex")}`);
}

export async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      label: { type: "string" }, cwd: { type: "string" }, "evidence-dir": { type: "string" }, "data-dir": { type: "string" },
      "scratch-base": { type: "string" }, "timeout-seconds": { type: "string" },
      preserve: { type: "string", multiple: true }, "preserve-optional": { type: "string", multiple: true }, help: { type: "boolean" },
    },
  });
  if (values.help) { process.stdout.write(HOST_VERIFICATION_USAGE); return 0; }
  if (!values.label) throw new Error("--label 이 필요합니다.");
  const [command, ...args] = positionals;
  if (!command) throw new Error("`--` 뒤에 실행할 명령이 필요합니다.");
  const timeoutSeconds = values["timeout-seconds"] === undefined ? 0 : Number(values["timeout-seconds"]);
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) throw new Error("--timeout-seconds 는 0 이상의 수여야 합니다.");
  const dataDirectory = resolve(values["data-dir"] ?? process.env.CONSENSUS_ROOM_DATA_DIR ?? defaultDataDirectory());
  const controller = new AbortController();
  const cancel = () => controller.abort(new Error("중재자가 취소했습니다."));
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, cancel);
  try {
    const result = await runHostVerification({
      label: values.label, command, args, cwd: values.cwd ?? process.cwd(),
      evidenceDirectory: values["evidence-dir"] ?? evidenceDirectoryFor(dataDirectory, values.label),
      scratchBase: values["scratch-base"], timeoutMs: Math.round(timeoutSeconds * 1000),
      preserve: [...(values.preserve ?? []).map((path) => ({ path, required: true })),
        ...(values["preserve-optional"] ?? []).map((path) => ({ path, required: false }))],
      signal: controller.signal,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.stderr.write(`${describeHostVerification(result)}\n`);
    return exitCodeFor(result);
  } finally {
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.off(signal, cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }, (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "호스트 검증 CLI 실패"}\n${HOST_VERIFICATION_USAGE}`);
    process.exitCode = 2;
  });
}
