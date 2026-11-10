import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, createReadStream, openSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { acquireSimulator, describeSimulator, simulatorComplete, SIMULATOR_ENV, SIMULATOR_LOG_FILE, SIMULATOR_TOKEN, type SimulatorHandle, type SimulatorLimits,
  type SimulatorRecord, type SimulatorRequest } from "./hostVerificationSimulator.js";
import { drainProcessGroup, processGroupAlive, terminateProcessGroup } from "./processRunner.js";

// 중재자가 호스트에서 실행하는 검증 명령(xcodebuild·swiftc·테스트 러너 등)의 임시 빌드·캐시 수명을 코드가 소유한다.
// 실행마다 mkdtemp 로 스크래치 루트 하나를 만들고(build·cache·work·tmp), 명령은 환경 변수와 인자 토큰으로 그 경로를 받는다. 명령이 끝나는
// 경계(정상 종료·실패·취소·시간 초과·spawn 실패)에서 (1) 소유 프로세스 그룹이 빌 때까지 기다리고, (2) 표준 증거(build/Logs·build/TestResults·
// build/*.xcresult)와 지정한 경로를 영구 증거 폴더로 복사해 바이트를 대조한 뒤, (3) 그때만 스크래치 루트를 지운다. 정리하지 않은 이유(그룹 생존·
// 보존 실패·신원 변경·삭제 오류)는 result.json 에 남고 성공으로 가려지지 않는다.
// 소유 경계: 자기가 만든 루트(mkdtemp 로 받은 dev/ino)만 지운다 — /tmp 순회·이름·나이로 남의 폴더를 추정하지 않고, 명령의 작업 폴더(원본 소스)와
// 공유 캐시는 건드리지 않는다. 보존 복사는 스크래치 루트 안에서 읽고 증거 폴더 안에만 쓴다(조상 링크·루트 교체는 거부). 증거 폴더는 실행 하나가
// 원자적으로 차지한다(command.json 을 wx 로 만든 실행만 그 폴더에 쓴다).
// iOS 시뮬레이터: simulator 요청이 있으면 이 실행 전용 기기를 만들어 띄우고 log stream 을 소유한 뒤(hostVerificationSimulator.ts), 명령이 어떻게 끝나든
// 보존·스크래치 삭제 전에 스트림 종료 → 기기 shutdown·delete 를 한다. 기기 이름·UDID 는 만들자마자 command.json 에 적는다. 명령이 직접 `simctl boot` 한
// 기기나 직접 띄운 스트림은 이 실행의 소유로 추정하지 않는다(정리하지 않는다). 서버는 이 모듈을 부르지 않는다(서버는 등록 프로필만 실행한다 —
// verifications.ts). 진입점은 중재자 CLI(hostVerificationCli.ts, `npm run verify:host`)다.

export const HOST_VERIFICATION_ENV = {
  build: "CR_VERIFY_BUILD_DIR", cache: "CR_VERIFY_CACHE_DIR", work: "CR_VERIFY_WORK_DIR", tmp: "CR_VERIFY_TMP_DIR", evidence: "CR_VERIFY_EVIDENCE_DIR",
} as const;
// 인자·작업 폴더 안의 자리표시자 — 셸 없이 경로를 넘긴다(`-derivedDataPath {build}`, `-module-cache-path {cache}`).
export const HOST_VERIFICATION_TOKENS = ["build", "cache", "work", "tmp", "evidence"] as const;
export type HostVerificationToken = typeof HOST_VERIFICATION_TOKENS[number];
// 선언 없이도 늘 보존하는 표준 증거(있을 때만) — xcodebuild 의 DerivedData 로그·테스트 결과 자리다. 여기에 더해 build 바로 아래 `*.xcresult` 도 보존한다.
// 선언 누락이 조용한 로그 손실이 되지 않게 한다(R3). 추가 경로는 옵션으로 받는다.
export const DEFAULT_PRESERVE_PATHS = ["build/Logs", "build/TestResults"] as const;
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
export const HOST_VERIFICATION_RESULT_VERSION = 2;
const CLAIM_FILE = "command.json";

export interface PreserveRequest { path: string; required: boolean }
export interface HostVerificationOptions {
  label: string;
  command: string;
  args: readonly string[];
  cwd: string;
  // 이 실행 전용 폴더 — 없으면 만들고, 있으면 비어 있어야 하며, 어느 쪽이든 command.json 을 먼저 만든 실행 하나만 쓴다.
  evidenceDirectory: string;
  scratchBase?: string;
  // 0 또는 생략이면 시간 제한 없음(취소는 signal 로).
  timeoutMs?: number;
  // 표준 증거(DEFAULT_PRESERVE_PATHS·build/*.xcresult)에 더해 보존할 스크래치 상대 경로. 같은 경로를 주면 여기 값(required)이 우선한다.
  preserve?: readonly PreserveRequest[];
  environment?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  // 이 실행 전용 iOS 시뮬레이터 — 있으면 기기를 만들어 띄운 뒤 명령에 UDID 를 넘기고({simulator} 토큰·CR_VERIFY_SIMULATOR_UDID), 끝나면 끄고 지운다.
  simulator?: SimulatorRequest;
  // 테스트 주입 — 그룹 소멸 대기의 결과를 바꿔 "살아 있으면 지우지 않는다" 를 확인하고, simctl 대신 가짜 실행 파일·작은 상한을 쓴다. 운영 호출은 쓰지 않는다.
  hooks?: { drainProcessGroup?: (pid: number | undefined) => Promise<unknown>; simctl?: readonly string[]; simulatorLimits?: Partial<SimulatorLimits> };
}
// setup_failed = 시뮬레이터 준비(create·boot·bootstatus·log stream)가 실패해 명령을 실행하지 않았다.
export type HostVerificationStatus = "succeeded" | "failed" | "cancelled" | "timed_out" | "spawn_failed" | "setup_failed";
export interface PreservedEntry {
  path: string; required: boolean; status: "preserved" | "missing" | "failed";
  destination: string | null; files: number; bytes: number; error: string | null;
}
export interface HostVerificationResult {
  version: typeof HOST_VERIFICATION_RESULT_VERSION;
  label: string;
  status: HostVerificationStatus;
  command: string; args: string[]; cwd: string;
  pid: number | null; exitCode: number | null; signal: string | null;
  startedAt: string; finishedAt: string; durationMs: number;
  error: string | null;
  scratch: { root: string; build: string; cache: string; work: string; tmp: string };
  evidence: { directory: string; command: string; stdout: string; stderr: string; result: string };
  environment: Record<string, string>;
  processGroup: { drained: boolean; error: string | null };
  preserved: PreservedEntry[];
  cleanup: { status: "removed" | "kept" | "failed"; reason: string | null; error: string | null };
  // 이 실행이 소유한 시뮬레이터(요청이 없으면 null). 기기 정리가 removed·not_created 가 아니거나 시작한 로그 수집이 captured 가 아니면 complete 는 false 다.
  simulator: SimulatorRecord | null;
  // 검증 성공·보존 성공·삭제 완료(시뮬레이터 정리 포함)가 모두 맞을 때만 true — CLI 종료 코드 0 의 조건.
  complete: boolean;
  // result.json 을 차지한 증거 폴더에 썼는가 — 증거 폴더의 신원이 실행 중 바뀌었으면 false 이고 그 자리에는 아무것도 쓰지 않았다.
  recorded: boolean;
}

interface Identity { dev: number; ino: number }
const message = (error: unknown) => error instanceof Error ? error.message : String(error);
const code = (error: unknown) => (error && typeof error === "object" && "code" in error ? String(error.code) : "");
const isENOENT = (error: unknown) => code(error) === "ENOENT";

export async function runHostVerification(options: HostVerificationOptions): Promise<HostVerificationResult> {
  if (!LABEL.test(options.label)) throw new Error("label 은 영문·숫자로 시작하는 1~40자(영문·숫자·._-)여야 합니다.");
  if (!options.command) throw new Error("실행할 명령이 없습니다.");
  const timeoutMs = options.timeoutMs ?? 0;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new Error("timeoutMs 는 0 이상의 수여야 합니다.");
  const extraPreserve = (options.preserve ?? []).map((request) => ({ ...request, path: normalizePreservePath(request.path) }));
  if (options.simulator && !options.simulator.deviceType.trim()) throw new Error("시뮬레이터 device type 이 비어 있습니다.");
  if (!options.simulator && options.args.some((arg) => arg.includes(SIMULATOR_TOKEN))) {
    throw new Error(`${SIMULATOR_TOKEN} 토큰은 시뮬레이터를 요청한 실행(--simulator-device)에서만 쓸 수 있습니다.`);
  }
  const scratchBase = await realpath(options.scratchBase ?? tmpdir());
  // 증거 폴더 점유(R4) — 폴더가 없으면 만들고, command.json 을 O_EXCL 로 만든 실행만 이 폴더의 주인이다. 진 쪽은 아무것도 쓰지 않고 거절된다.
  const claimedDirectory = resolve(options.evidenceDirectory);
  await mkdir(dirname(claimedDirectory), { recursive: true, mode: 0o700 });
  await mkdir(claimedDirectory, { mode: 0o700 }).catch((error: unknown) => { if (code(error) !== "EEXIST") throw error; });
  const claimPath = join(claimedDirectory, CLAIM_FILE);
  try {
    await writeFile(claimPath, JSON.stringify({ version: HOST_VERIFICATION_RESULT_VERSION, label: options.label, state: "claimed", pid: process.pid,
      claimedAt: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  } catch (error) {
    if (code(error) === "EEXIST") throw new Error(`증거 폴더를 이미 다른 실행이 차지했습니다(command.json 있음): ${claimedDirectory}`);
    throw error;
  }
  const evidence = await realpath(claimedDirectory);
  const evidenceIdentity = await identityOf(evidence);
  const files = { command: join(evidence, CLAIM_FILE), stdout: join(evidence, "stdout.log"), stderr: join(evidence, "stderr.log"), result: join(evidence, "result.json") };
  let root: string | null = null;
  let rootIdentity: Identity | null = null;
  // 실행 단계는 명시적으로 추적한다 — 파일 유무로 추정하지 않는다. 프로세스를 띄우려 한 뒤의 예외는 스크래치·점유 파일을 되돌리지 않는다.
  let phase: "preparing" | "running" = "preparing";
  try {
    const entries = await readdir(evidence);
    if (entries.length !== 1 || entries[0] !== CLAIM_FILE) throw new Error(`증거 폴더는 비어 있어야 합니다: ${evidence}`);
    root = await realpath(await mkdtemp(join(scratchBase, `cr-host-verify-${options.label}-`)));
    rootIdentity = await identityOf(root);
    const scratch = { root, build: join(root, "build"), cache: join(root, "cache"), work: join(root, "work"), tmp: join(root, "tmp") };
    const paths = { ...scratch, evidence };
    if (inside(evidence, root) || inside(root, evidence)) throw new Error("증거 폴더와 스크래치 폴더는 서로 안에 있을 수 없습니다.");
    const environment: Record<string, string> = {
      [HOST_VERIFICATION_ENV.build]: scratch.build, [HOST_VERIFICATION_ENV.cache]: scratch.cache, [HOST_VERIFICATION_ENV.work]: scratch.work,
      [HOST_VERIFICATION_ENV.tmp]: scratch.tmp, [HOST_VERIFICATION_ENV.evidence]: evidence,
      // 도구가 기본 위치에 두는 임시 파일·캐시를 스크래치로 돌린다(모델 턴의 actionTemp 와 같은 방식). 다른 위치를 쓰는 도구(xcodebuild 의 기본 DerivedData 등)는
      // 인자 토큰({build}·{cache})으로 명시해야 한다 — 이 변수만으로 모든 도구의 캐시가 스크래치에 들어간다고 보지 않는다.
      TMPDIR: scratch.tmp, XDG_CACHE_HOME: join(scratch.cache, "xdg"), CLANG_MODULE_CACHE_PATH: join(scratch.cache, "clang-modules"),
    };
    const args = options.args.map((arg) => substitute(arg, paths));
    for (const path of [scratch.build, scratch.cache, scratch.work, scratch.tmp]) await mkdir(path, { mode: 0o700 });
    const cwd = resolve(substitute(options.cwd, paths));
    if (!(await stat(cwd).catch(() => null))?.isDirectory()) throw new Error(`작업 폴더가 디렉터리가 아닙니다: ${cwd}`);
    // 프로세스를 띄우기 전에 소유 경로를 점유 파일에 적는다 — 이 프로세스가 죽어도 어느 폴더가 이 실행의 것이었는지 남는다.
    // 시뮬레이터를 쓰면 기기 이름을 정한 직후와 UDID 를 안 직후에 같은 파일을 다시 쓴다 — finally 를 못 도는 종료(SIGKILL·OS)에서도 어느 기기가 이 실행의 것이었는지 남는다.
    const claim = { version: HOST_VERIFICATION_RESULT_VERSION, label: options.label, state: "running", pid: process.pid,
      command: options.command, args, cwd, scratch, scratchIdentity: rootIdentity, evidence, environment, timeoutMs,
      preserve: extraPreserve, defaultPreserve: DEFAULT_PRESERVE_PATHS, simulatorRequest: options.simulator ?? null, createdAt: new Date().toISOString() };
    const writeClaim = (extra: Record<string, unknown>) => writeFile(files.command, JSON.stringify({ ...claim, ...extra }, null, 2) + "\n", { mode: 0o600 });
    await writeClaim({});
    const drain = options.hooks?.drainProcessGroup ?? ((pid: number | undefined) => drainProcessGroup(pid));
    const startedAt = new Date();
    phase = "running";
    let simulator: SimulatorHandle | null = null;
    let simulatorRecord: SimulatorRecord | null = null;
    let execution: Execution;
    // 결과에는 실제로 넘긴 인자({simulator} 를 UDID 로 바꾼 뒤)를 적는다.
    let runArgs = args;
    // 차지한 증거 폴더와 만든 스크래치 루트가 그대로인지 — 시뮬레이터 준비(비동기) 중의 쓰기와 명령을 띄우기 직전에 확인한다.
    // 어느 쪽이든 바뀌었으면 명령을 실행하지 않는다(명령은 스크래치에 쓰고, 출력은 증거 폴더에 쓴다). 바뀐 자리의 폴더는 소유가 아니므로 쓰지도 지우지도 않는다.
    const ownedPathsChanged = async (): Promise<string | null> => {
      const changed = [
        ...(await identityHolds(root!, rootIdentity!)) ? [] : ["스크래치 루트"],
        ...(await identityHolds(evidence, evidenceIdentity)) ? [] : ["증거 폴더"],
      ];
      return changed.length ? `${changed.join("·")}의 신원(dev/ino·실제 경로)이 만든·차지한 것과 달라 명령을 실행하지 않았습니다.` : null;
    };
    const guardOwnedPaths = async () => { const changed = await ownedPathsChanged(); if (changed) throw new Error(changed); };
    try {
      if (options.simulator) {
        simulator = await acquireSimulator({ label: options.label, request: options.simulator, logPath: join(evidence, SIMULATOR_LOG_FILE),
          simctl: options.hooks?.simctl ?? ["xcrun", "simctl"], limits: options.hooks?.simulatorLimits, signal: options.signal,
          onOwnership: (ownership) => writeClaim({ simulator: ownership }), guard: guardOwnedPaths });
      }
      const changed = await ownedPathsChanged();
      if (changed) {
        execution = { status: "setup_failed", pid: null, exitCode: null, signal: null, durationMs: 0, error: changed, processGroup: { drained: true, error: null } };
      } else if (simulator && !simulator.ready) {
        execution = { status: simulator.record.setup.status === "cancelled" ? "cancelled" : "setup_failed", pid: null, exitCode: null, signal: null, durationMs: 0,
          error: simulator.record.setup.error, processGroup: { drained: true, error: null } };
      } else {
        const udid = simulator?.record.udid ?? null;
        if (udid) environment[SIMULATOR_ENV] = udid;
        if (udid) runArgs = args.map((arg) => arg.split(SIMULATOR_TOKEN).join(udid));
        execution = await execute({ command: options.command, args: runArgs, cwd,
          environment: { ...(options.environment ?? process.env), ...environment }, stdout: files.stdout, stderr: files.stderr, timeoutMs, signal: options.signal, drain });
      }
    } finally {
      // 명령이 어떻게 끝나든(예외 포함) 보존·삭제보다 먼저 스트림과 기기를 회수한다. release 는 예외를 던지지 않는다.
      if (simulator) simulatorRecord = await simulator.release();
    }
    const finishedAt = new Date();
    // 보존·삭제는 만든 루트와 차지한 증거 폴더가 그대로일 때만 한다(R2) — 명령이 루트를 옮기고 다른 폴더를 그 자리에 두면 그 폴더는 소유가 아니다.
    // 두 신원은 따로 본다: 증거 폴더가 바뀌었으면 그 자리에는 결과도 쓰지 않는다(그 폴더의 파일은 다른 작업의 것일 수 있다).
    const rootError = (await identityHolds(root, rootIdentity)) ? null : "스크래치 루트의 신원(dev/ino·실제 경로)이 만든 것과 다릅니다.";
    const evidenceError = (await identityHolds(evidence, evidenceIdentity)) ? null : "증거 폴더의 신원(dev/ino·실제 경로)이 차지한 것과 다릅니다.";
    const identityError = [rootError, evidenceError].filter((value): value is string => value !== null).join(" ") || null;
    const requests = await preserveRequests(scratch.build, extraPreserve);
    const preserved: PreservedEntry[] = [];
    for (const request of requests) {
      if (identityError) {
        preserved.push({ path: request.path, required: request.required, status: "failed", destination: null, files: 0, bytes: 0, error: identityError });
        continue;
      }
      // 겹치는 요청은 조상 사본으로 충족한다 — 명시한 `build/TestResults/test.xcresult` 와 표준 `build/TestResults` 처럼. 조상이 이미 보존됐으면 그 사본 안의 항목을 대조해 적는다.
      const cover = preserved.find((entry) => entry.status === "preserved" && (entry.path === request.path || request.path.startsWith(`${entry.path}/`)));
      preserved.push(cover ? await coveredEntry(root, evidence, request) : await preserveOne(root, evidence, request));
    }
    const preservationFailed = preserved.some((entry) => entry.status === "failed" || (entry.status === "missing" && entry.required));
    let cleanup: HostVerificationResult["cleanup"];
    if (identityError) {
      cleanup = { status: "kept", reason: `${identityError} 보존·삭제를 하지 않았습니다.${evidenceError ? " 결과(result.json)도 기록하지 않았습니다." : ""}`, error: null };
    } else if (!execution.processGroup.drained) {
      cleanup = { status: "kept", reason: "소유 프로세스 그룹이 아직 살아 있어 스크래치를 지우지 않았습니다.", error: execution.processGroup.error };
    } else if (preservationFailed) {
      cleanup = { status: "kept", reason: "증거 보존에 실패한 항목이 있어 스크래치를 지우지 않았습니다(보존 대상이 안에 있습니다).", error: null };
    } else {
      cleanup = await removeScratch(root, rootIdentity);
    }
    const result: HostVerificationResult = {
      version: HOST_VERIFICATION_RESULT_VERSION, label: options.label, status: execution.status, command: options.command, args: runArgs, cwd,
      pid: execution.pid, exitCode: execution.exitCode, signal: execution.signal, simulator: simulatorRecord,
      startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), durationMs: execution.durationMs, error: execution.error,
      scratch, evidence: { directory: evidence, ...files }, environment, processGroup: execution.processGroup, preserved, cleanup,
      complete: execution.status === "succeeded" && !preservationFailed && cleanup.status === "removed" && simulatorComplete(simulatorRecord),
      // 차지한 폴더가 아닌 곳에는 결과를 쓰지 않는다 — 호출자(CLI stdout)에게만 돌려준다.
      recorded: evidenceError === null,
    };
    if (result.recorded) await writeFile(files.result, JSON.stringify(result, null, 2) + "\n", { mode: 0o600 });
    return result;
  } catch (error) {
    // 프로세스를 띄우려 하기 전의 실패만 되돌린다. 그때도 만든 루트와 차지한 증거 폴더의 신원이 그대로일 때만 — 그 자리에 다른 폴더가 와 있으면 손대지 않는다.
    if (phase === "preparing") {
      if (root && rootIdentity && await identityHolds(root, rootIdentity)) await rm(root, { recursive: true, force: true });
      if (await identityHolds(evidence, evidenceIdentity)) await rm(files.command, { force: true });
    }
    throw error;
  }
}

// 한 줄 요약 — CLI 의 stderr 와 중재자의 evidence 메시지에 쓴다.
export function describeHostVerification(result: HostVerificationResult): string {
  const exit = result.exitCode !== null ? `exit ${result.exitCode}` : result.signal ? `signal ${result.signal}` : "미실행";
  const kept = result.preserved.filter((entry) => entry.status === "preserved").length;
  const problems = result.preserved.filter((entry) => entry.status === "failed" || (entry.status === "missing" && entry.required)).map((entry) => `${entry.path}: ${entry.status}`);
  return `호스트 검증 ${result.label}: ${result.status}(${exit}, ${(result.durationMs / 1000).toFixed(1)}초) — 보존 ${kept}/${result.preserved.length}`
    + `${problems.length ? `(실패: ${problems.join(", ")})` : ""}, 스크래치 ${result.cleanup.status === "removed" ? "삭제됨" : `${result.cleanup.status}: ${result.cleanup.reason ?? result.cleanup.error}`}`
    + `${result.processGroup.error ? `, 프로세스 그룹: ${result.processGroup.error}` : ""}${result.simulator ? `, ${describeSimulator(result.simulator)}` : ""}. 증거 ${result.evidence.directory}${result.recorded ? "" : "(result.json 미기록 — 증거 폴더 신원 변경)"}`;
}

function substitute(value: string, paths: Record<HostVerificationToken, string>): string {
  return value.replace(/\{(build|cache|work|tmp|evidence)\}/g, (_, token: HostVerificationToken) => paths[token]);
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

// 보존 경로는 스크래치 루트 기준 상대 경로다(`build/Logs`, `work/report.json`). 루트 밖·절대 경로·루트 자체는 받지 않는다.
function normalizePreservePath(path: string): string {
  const parts = path.split("/").filter((part) => part !== "" && part !== ".");
  if (isAbsolute(path) || parts.length === 0 || parts.includes("..")) throw new Error(`보존 경로는 스크래치 루트 기준 상대 경로여야 합니다: ${path}`);
  return parts.join("/");
}

// 보존 목록 — 명시 경로가 먼저(같은 경로는 명시 값이 우선), 그다음 표준 증거(선택)와 build 바로 아래의 *.xcresult(선택). 조상이 자손보다 먼저 오도록
// 깊이순으로 안정 정렬한다 — 자손 요청은 조상 사본으로 충족되므로 같은 자리를 두 번 만들지 않는다.
async function preserveRequests(build: string, extra: readonly PreserveRequest[]): Promise<PreserveRequest[]> {
  const requests = new Map<string, PreserveRequest>();
  for (const request of extra) requests.set(request.path, request);
  for (const path of DEFAULT_PRESERVE_PATHS) if (!requests.has(path)) requests.set(path, { path, required: false });
  const bundles = await readdir(build, { withFileTypes: true }).catch(() => []);
  for (const entry of bundles.filter((entry) => entry.name.endsWith(".xcresult")).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `build/${entry.name}`;
    if (!requests.has(path)) requests.set(path, { path, required: false });
  }
  return [...requests.values()].map((request, index) => ({ request, index, depth: request.path.split("/").length }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index).map((item) => item.request);
}

// 이미 보존된 조상 사본 안에 든 요청 — 원본이 있으면 사본의 같은 자리를 세어 preserved 로, 없으면 missing 으로 적는다(조상 사본은 매니페스트로 대조가 끝났다).
async function coveredEntry(root: string, evidence: string, request: PreserveRequest): Promise<PreservedEntry> {
  const destination = join(evidence, "preserved", request.path);
  const entry: PreservedEntry = { path: request.path, required: request.required, status: "failed", destination, files: 0, bytes: 0, error: null };
  try {
    const info = await lstat(join(root, request.path)).catch((error: unknown) => { if (isENOENT(error)) return null; throw error; });
    if (!info) return { ...entry, status: "missing", destination: null };
    if (info.isSymbolicLink()) throw new Error("보존 대상 자체가 심볼릭 링크입니다 — 링크 대상은 스크래치 소유가 아닐 수 있어 복사하지 않습니다.");
    const copy = await manifest(destination);
    return { ...entry, status: "preserved", files: copy.files, bytes: copy.bytes };
  } catch (error) {
    return { ...entry, error: message(error) };
  }
}

async function identityOf(path: string): Promise<Identity> {
  const info = await stat(path);
  return { dev: info.dev, ino: info.ino };
}

async function identityHolds(path: string, identity: Identity): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink() && info.dev === identity.dev && info.ino === identity.ino && await realpath(path) === path;
  } catch { return false; }
}

interface Execution {
  status: HostVerificationStatus; pid: number | null; exitCode: number | null; signal: string | null; durationMs: number; error: string | null;
  processGroup: { drained: boolean; error: string | null };
}

function execute(input: { command: string; args: string[]; cwd: string; environment: NodeJS.ProcessEnv; stdout: string; stderr: string; timeoutMs: number;
  signal?: AbortSignal; drain: (pid: number | undefined) => Promise<unknown> }): Promise<Execution> {
  const idle: Execution = { status: "cancelled", pid: null, exitCode: null, signal: null, durationMs: 0, error: null, processGroup: { drained: true, error: null } };
  if (input.signal?.aborted) return Promise.resolve(idle);
  return new Promise<Execution>((resolveExecution) => {
    // 출력은 증거 폴더의 파일 디스크립터로 받는다 — 파이프가 아니라서 손자가 물려받아도 종료 판정이 EOF 에 묶이지 않고, 큰 빌드 로그도 메모리에 두지 않는다.
    const out = openSync(input.stdout, "w", 0o600);
    const err = openSync(input.stderr, "w", 0o600);
    const started = performance.now();
    const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.environment, detached: true, stdio: ["ignore", out, err] });
    const pid = child.pid;
    let stopped: "cancelled" | "timed_out" | null = null;
    let drainPromise: Promise<unknown> | undefined;
    let terminateError: string | null = null;
    let settled = false;
    const stop = (reason: NonNullable<typeof stopped>) => {
      if (stopped || settled) return;
      stopped = reason;
      try { terminateProcessGroup(pid, "SIGTERM"); } catch (error) { terminateError = message(error); }
      drainPromise ??= input.drain(pid);
    };
    const cancel = () => stop("cancelled");
    input.signal?.addEventListener("abort", cancel, { once: true });
    const timer = input.timeoutMs > 0 ? setTimeout(() => stop("timed_out"), input.timeoutMs) : undefined;
    const finish = async (exit: { code: number | null; signal: NodeJS.Signals | null } | null, spawnError: Error | null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      input.signal?.removeEventListener("abort", cancel);
      const durationMs = performance.now() - started;
      closeSync(out);
      closeSync(err);
      // 직속 자식이 끝나도 같은 그룹의 손자가 남아 있을 수 있다 — 소유 그룹이 빌 때까지 기다린 뒤에만 완료로 본다(processRunner 와 같은 계약).
      if (!drainPromise && pid && processGroupAlive(pid)) {
        try { terminateProcessGroup(pid, "SIGTERM"); } catch (error) { terminateError = message(error); }
        drainPromise = input.drain(pid);
      }
      const drainError = drainPromise ? await drainPromise : undefined;
      const alive = pid ? processGroupAlive(pid) : false;
      const groupError = drainError ? message(drainError) : alive ? "SIGKILL 뒤에도 프로세스 그룹이 남아 있습니다." : terminateError;
      const processGroup = { drained: !drainError && !alive, error: groupError };
      // pid 가 없으면 프로세스가 뜨지 않은 것이다(ENOENT·EACCES — Node 는 error 뒤에 exit 를 낼 수도 있다). 어느 이벤트가 먼저 와도 spawn 실패다.
      if (!pid) {
        resolveExecution({ status: "spawn_failed", pid: null, exitCode: null, signal: null, durationMs,
          error: spawnError?.message ?? "프로세스를 만들지 못했습니다.", processGroup });
        return;
      }
      const exitCode = exit?.code ?? null;
      const signal = exit?.signal ?? null;
      resolveExecution({
        status: stopped ?? (exitCode === 0 && !spawnError ? "succeeded" : "failed"), pid: pid ?? null, exitCode, signal,
        durationMs, error: spawnError ? spawnError.message : null, processGroup,
      });
    };
    child.once("error", (error) => { void finish(null, error); });
    child.once("exit", (exitCode, signal) => { void finish({ code: exitCode, signal }, null); });
  });
}

// 조상 검증 — base 아래의 각 구성 요소가 링크가 아닌 실제 디렉터리인지 확인한다(소유 루트 안에서만 읽고 증거 폴더 안에만 쓰기 위해, R2).
// create 가 true 면 없는 구성 요소를 만든다(증거 폴더 쪽). false 면 없는 구성 요소에서 null 을 돌려준다(원본 쪽 — 대상이 없는 것과 같다). 마지막 구성 요소는 호출자가 다룬다.
async function realChain(base: string, parts: readonly string[], create: boolean): Promise<string | null> {
  let current = base;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current).catch((error: unknown) => { if (isENOENT(error)) return null; throw error; });
    if (!info) {
      if (!create) return null;
      await mkdir(current, { mode: 0o700 });
      continue;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`조상 경로가 실제 디렉터리가 아닙니다(링크 또는 파일): ${current}`);
  }
  return current;
}

async function preserveOne(root: string, evidence: string, request: PreserveRequest): Promise<PreservedEntry> {
  const parts = request.path.split("/");
  const source = join(root, request.path);
  const destination = join(evidence, "preserved", request.path);
  const entry: PreservedEntry = { path: request.path, required: request.required, status: "failed", destination, files: 0, bytes: 0, error: null };
  try {
    if (!(await realChain(root, parts.slice(0, -1), false))) return { ...entry, status: "missing", destination: null };
    const info = await lstat(source).catch((error: unknown) => { if (isENOENT(error)) return null; throw error; });
    if (!info) return { ...entry, status: "missing", destination: null };
    if (info.isSymbolicLink()) throw new Error("보존 대상 자체가 심볼릭 링크입니다 — 링크 대상은 스크래치 소유가 아닐 수 있어 복사하지 않습니다.");
    await realChain(evidence, ["preserved", ...parts.slice(0, -1)], true);
    if (await lstat(destination).catch(() => null)) throw new Error(`보존 사본 자리가 이미 있습니다: ${destination}`);
    // 원본을 먼저 검사한다 — 보존 트리 밖(지워질 cache 등)을 가리키는 링크는 사본에서 읽을 수 없으므로 보존 실패다(R1).
    const before = await manifest(source);
    // 링크는 링크 그대로(verbatim) 복사한다 — 대상을 따라가 스크래치 밖 파일을 끌어오지 않는다. 사본은 원본과 항목·바이트·링크 해석이 같아야 보존으로 친다.
    await cp(source, destination, { recursive: true, errorOnExist: true, force: false, dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
    const after = await manifest(destination);
    if (JSON.stringify(before.entries) !== JSON.stringify(after.entries)) throw new Error("사본이 원본과 다릅니다(항목·바이트·링크 해석 불일치).");
    return { ...entry, status: "preserved", files: before.files, bytes: before.bytes };
  } catch (error) {
    return { ...entry, error: message(error) };
  }
}

// 트리 목록 — 상대 경로·종류·내용 해시(파일)·링크 대상과 해석 결과(링크). 원본과 사본을 같은 규칙으로 걷어 비교한다.
// 링크는 상대 링크이고 같은 트리 안의 실제 항목으로 풀려야 한다 — 그래야 사본에서도 같은 상대 위치로 읽힌다. 그 밖(절대 링크·트리 밖·끊긴 링크)은 거부한다.
async function manifest(path: string): Promise<{ entries: unknown[]; files: number; bytes: number }> {
  const entries: unknown[] = [];
  const treeRoot = await realpath(path);
  let files = 0, bytes = 0;
  const walk = async (current: string, rel: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) {
      const target = await readlink(current);
      if (isAbsolute(target)) throw new Error(`절대 경로 링크는 보존할 수 없습니다: ${rel}`);
      const resolved = await realpath(current).catch(() => { throw new Error(`끊어진 링크는 보존할 수 없습니다: ${rel}`); });
      if (!inside(resolved, treeRoot) || resolved === treeRoot) throw new Error(`보존 트리 밖을 가리키는 링크는 보존할 수 없습니다: ${rel} -> ${target}`);
      entries.push([rel, "link", target, relative(treeRoot, resolved)]);
    } else if (info.isDirectory()) {
      entries.push([rel, "dir"]);
      for (const name of (await readdir(current)).sort()) await walk(join(current, name), rel ? `${rel}/${name}` : name);
    } else if (info.isFile()) {
      files += 1; bytes += info.size;
      entries.push([rel, "file", info.size, await hashFile(current)]);
    } else throw new Error(`보존할 수 없는 항목 종류입니다: ${rel || path}`);
  };
  await walk(path, "");
  return { entries, files, bytes };
}

// 스트림 해시 — xcresult·빌드 로그는 수백 MB 일 수 있어 파일을 통째로 메모리에 올리지 않는다.
function hashFile(path: string): Promise<string> {
  return new Promise<string>((resolveHash, reject) => {
    const hash = createHash("sha256");
    createReadStream(path).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolveHash(hash.digest("hex")));
  });
}

async function removeScratch(root: string, identity: Identity): Promise<HostVerificationResult["cleanup"]> {
  // 삭제 직전에 신원을 다시 본다 — 보존과 삭제 사이에 루트가 바뀌었으면 그 자리의 폴더는 소유가 아니다.
  if (!(await identityHolds(root, identity))) return { status: "kept", reason: "삭제 직전 스크래치 루트의 신원이 만든 것과 달라 지우지 않았습니다.", error: null };
  try {
    await rm(root, { recursive: true, force: false });
    const remains = await lstat(root).then(() => true, (error: unknown) => { if (isENOENT(error)) return false; throw error; });
    if (remains) throw new Error("rm 뒤에도 스크래치 루트가 남아 있습니다.");
    return { status: "removed", reason: null, error: null };
  } catch (error) {
    return { status: "failed", reason: "스크래치 삭제가 끝나지 않았습니다(일부 삭제됐을 수 있음).", error: message(error) };
  }
}
