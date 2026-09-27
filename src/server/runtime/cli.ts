import { execFileSync } from "node:child_process";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Readable, Writable } from "node:stream";
import { RUNNER_CONTROL_ENTRIES } from "../adapters/turnPolicy.js";
import { SpawnCommandRunner } from "../processRunner.js";
import { createRuntimeAdapters } from "./providers.js";
import { RuntimeCheckRequestSchema, RuntimeRequestSchema, type RuntimeEventPayload, type RuntimeErrorCode } from "./protocol.js";
import { executeRuntimeCheck, executeRuntimeRequest, type RuntimeAdapterFactory } from "./service.js";

function canonicalPath(path: string): string {
  try { return realpathSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const parent = dirname(path);
    if (parent === path) throw error;
    return join(canonicalPath(parent), relative(parent, path));
  }
}
function contains(parent: string, child: string): boolean {
  // realpath도 APFS의 대소문자 별칭은 원래 표기로 돌려준다. 문자열 대신 폴더 신원과 조상을 비교한다.
  const identity = (path: string) => {
    try { return statSync(path, { bigint: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  };
  const expected = identity(parent);
  if (!expected) return false;
  for (let current = child; ; current = dirname(current)) {
    const actual = identity(current);
    if (actual && actual.dev === expected.dev && actual.ino === expected.ino) return true;
    if (dirname(current) === current) return false;
  }
}

const USAGE = "사용법: agent-runtime --data-directory <절대 경로> [--process-group own|caller] (stdin: version 1 JSON)";

// 인자: --data-directory(필수, 절대 경로), --process-group(선택). caller 는 호스트가 이 CLI 를 새 프로세스 그룹으로 띄우고 끝나면 그룹 전체를
// 정리할 때만 쓴다(E2e.md 규칙 5, SpawnCommandRunnerOptions). 같은 인자 반복·모르는 인자는 거부한다.
function parseArguments(args: readonly string[]): { dataDirectory: string; processGroup: "own" | "caller" } {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const [name, value] = [args[index], args[index + 1]];
    if (!["--data-directory", "--process-group"].includes(name) || value === undefined || values.has(name)) throw new Error(USAGE);
    values.set(name, value);
  }
  const dataDirectory = values.get("--data-directory");
  const processGroup = values.get("--process-group") ?? "own";
  if (!dataDirectory || !isAbsolute(dataDirectory) || (processGroup !== "own" && processGroup !== "caller")) throw new Error(USAGE);
  return { dataDirectory, processGroup };
}

// 작업 폴더 기준(E2e.md 규칙 3). git: D1 규칙 — 공유 제어 경로 검사가 Git HEAD 를 기준으로 하므로 체크아웃 루트만 받는다(모델 호출 뒤에야 전제가
// 깨지는 일을 막는다). snapshot: 호스트가 만든 Git 없는 사본 — Git 작업 트리 안이면 상위 저장소의 지시문·기준이 끼어드므로 거부하고, 루트에 러너 제어
// 항목(대소문자 무관)이 있으면 대조할 기준이 없으므로 거부한다(기준 = "루트에 제어 항목 없음", turnPolicy.runnerControlDeviations 의 비 Git 분기).
function checkWorkspace(workspace: string, kind: "git" | "snapshot"): void {
  let gitRoot: string | null = null;
  try {
    gitRoot = realpathSync(execFileSync("git", ["-C", workspace, "rev-parse", "--show-toplevel"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim());
  } catch { gitRoot = null; }
  if (kind === "git") {
    if (gitRoot !== workspace) throw new Error("cwd는 Git 체크아웃의 루트여야 합니다.");
    return;
  }
  if (gitRoot !== null) throw new Error("snapshot 작업 폴더는 Git 작업 트리 밖이어야 합니다.");
  const control = new Set<string>(RUNNER_CONTROL_ENTRIES.map(entry => entry.toLowerCase()));
  const found = readdirSync(workspace).filter(name => control.has(name.toLowerCase()));
  if (found.length > 0) throw new Error(`snapshot 작업 폴더 루트에 러너 제어 항목이 있습니다: ${found.sort().join(", ")}`);
}

// 호스트 소유 세션 홈의 경계(E2e-1 host-review F001). 공급자 설정·세션·인증 링크가 사는 곳이라 모델이 읽는 작업 폴더·런타임 데이터와 서로
// 포함할 수 없다. 경로는 심볼릭 링크를 거치지 않는 실제 경로여야 한다 — 링크로 다른 홈(사용자 ~/.codex 등)을 가리키게 할 수 없고, 공급자 CLI 도
// 실제 경로로 규칙을 대조한다. 아직 없으면 어댑터가 만든다(부모까지 같은 규칙).
function checkSessionHome(sessionHome: string, workspace: string, dataDirectory: string): void {
  const given = resolve(sessionHome);
  if (canonicalPath(given) !== given) throw new Error("sessionHome 은 심볼릭 링크를 거치지 않는 실제 경로여야 합니다.");
  try {
    if (!statSync(given).isDirectory()) throw new Error("sessionHome 은 디렉터리여야 합니다.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // 폴더 신원(dev/ino) 대조는 아직 없는 폴더를 보지 못한다 — 실제 경로 문자열도 대조한다(대소문자를 구분하지 않는 볼륨을 위해 대소문자 무시).
  const inside = (parent: string, child: string) => {
    const [p, c] = [canonicalPath(parent).toLowerCase(), canonicalPath(child).toLowerCase()];
    return c === p || c.startsWith(p.endsWith("/") ? p : `${p}/`);
  };
  for (const other of [workspace, dataDirectory]) {
    if (contains(given, other) || contains(other, given) || inside(given, other) || inside(other, given)) {
      throw new Error("sessionHome 은 작업 폴더·런타임 데이터와 서로 포함할 수 없습니다.");
    }
  }
}

// 단일 JSON 요청을 EOF까지 읽고 이벤트만 stdout에 쓴다. 서버 프로세스/DB/운영 설치는 필요 없다.
// 취소 시 어댑터 → SpawnCommandRunner의 process group 종료를 기다린 다음 error/비정상 종료를 반환한다.
export async function runRuntimeCLI(io: {
  input: Readable; output: Writable; args: readonly string[]; signal?: AbortSignal;
  adapterFactory?: RuntimeAdapterFactory;
}): Promise<number> {
  let requestId: string | null = null;
  let sequence = 0;
  let code: RuntimeErrorCode = "INVALID_REQUEST";
  const emit = (event: RuntimeEventPayload) => {
    io.output.write(`${JSON.stringify({ version: 1, requestId, sequence: ++sequence, ...event })}\n`);
  };
  try {
    // 대기 중 SIGTERM도 입력을 끝낸다. UTF-8 경계를 임의로 자르지 않는다.
    const abortInput = () => io.input.destroy(new Error("실행이 취소되었습니다."));
    io.signal?.throwIfAborted();
    io.signal?.addEventListener("abort", abortInput, { once: true });
    let source = "";
    try {
      io.input.setEncoding("utf8");
      for await (const chunk of io.input) source += chunk;
    } finally { io.signal?.removeEventListener("abort", abortInput); }
    const parsed: unknown = JSON.parse(source);
    // check 필드가 있으면 세션 확인 요청(E2e-2), 없으면 턴 요청이다. 두 schema 모두 모르는 필드를 거부한다.
    const isCheck = typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && "check" in parsed;
    const request = isCheck ? RuntimeCheckRequestSchema.parse(parsed) : RuntimeRequestSchema.parse(parsed);
    requestId = request.requestId;
    code = "INVALID_CONFIGURATION";
    const options = parseArguments(io.args);
    const workspace = realpathSync(request.cwd);
    if (!statSync(workspace).isDirectory()) throw new Error("cwd는 디렉터리여야 합니다.");
    checkWorkspace(workspace, request.workspace);
    const dataDirectory = canonicalPath(resolve(options.dataDirectory));
    if (contains(workspace, dataDirectory) || contains(dataDirectory, workspace)) {
      throw new Error("런타임 데이터와 작업 폴더는 서로 포함할 수 없습니다.");
    }
    if (request.sessionHome) checkSessionHome(request.sessionHome, workspace, dataDirectory);
    io.signal?.throwIfAborted();
    const adapter = io.adapterFactory ? io.adapterFactory(request.provider)
      : createRuntimeAdapters(new SpawnCommandRunner({ processGroup: options.processGroup }), { dataDirectory })[request.provider];
    code = "EXECUTION_FAILED";
    if ("check" in request) await executeRuntimeCheck(request, adapter, emit);
    else await executeRuntimeRequest(request, adapter, emit, io.signal);
    return 0;
  } catch (error) {
    emit({ type: "error", code: io.signal?.aborted ? "CANCELLED" : code,
      message: error instanceof Error ? error.message : String(error) });
    return io.signal?.aborted ? 130 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = () => controller.abort(new Error("실행이 취소되었습니다."));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // 소비자가 stdout을 닫으면 결과를 보낼 수 없으므로 실행도 중단한다.
  process.stdout.on("error", stop);
  try {
    process.exitCode = await runRuntimeCLI({ input: process.stdin, output: process.stdout, args: process.argv.slice(2),
      signal: controller.signal });
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}
