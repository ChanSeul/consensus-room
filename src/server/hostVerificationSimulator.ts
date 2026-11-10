import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { drainProcessGroup, terminateProcessGroup } from "./processRunner.js";

// 호스트 검증 한 실행이 소유하는 iOS 시뮬레이터 기기와 그 기기의 log stream 수명.
// 소유 경계: 이 모듈은 자기가 `simctl create` 로 만든 기기(실행마다 난수가 든 고유 이름, UDID 로 식별)와 자기가 띄운 `simctl spawn … log stream` 프로세스 그룹만
// 끝내고 지운다. 이미 있던 기기·다른 실행의 기기·외부에서 띄운 스트림은 찾지도 끄지도 않는다(Booted 목록 비교·shutdown all·광역 kill 없음).
// 기기를 띄운 프로세스(launchd_sim)는 CoreSimulatorService 가 만들므로 검증 명령의 프로세스 그룹 밖이다 — 그래서 명령 그룹 종료만으로는 기기가 남는다.
// log stream 출력은 파일 리다이렉트가 아니라 이 프로세스가 파이프로 읽어 증거 파일에 상한(바이트)까지만 쓴다. 상한 뒤의 출력은 계속 읽어 버리고 양을 기록한다
// (파이프를 읽지 않으면 스트림이 막힌다). 지운 파일을 기기 쪽 프로세스가 계속 붙잡아 공간이 회수되지 않는 경로(삭제된 inode 보유)를 만들지 않는다.
// 정리 순서는 스트림 종료 → shutdown → delete → 목록에서 UDID 부재 확인이다. 각 단계의 실패는 기록에 남고 다음 단계는 계속한다.
// 한계: 이 프로세스가 SIGKILL·OS 종료로 finally 를 못 돌면 기기는 남는다. 그때를 위해 기기 이름·UDID 를 만들자마자 호출자의 점유 기록(command.json)에 적는다.

export const SIMULATOR_ENV = "CR_VERIFY_SIMULATOR_UDID";
export const SIMULATOR_TOKEN = "{simulator}";
export const SIMULATOR_LOG_FILE = "simulator-log.txt";
// 고정 상한 — 설정 옵션이 아니다. 테스트만 limits 로 줄인다.
export const SIMULATOR_LIMITS = {
  logMaxBytes: 64 * 1024 * 1024,
  // create 뒤 boot + bootstatus 가 끝나야 하는 시간.
  bootTimeoutMs: 300_000,
  // create·shutdown·delete·list 한 번의 상한.
  controlTimeoutMs: 120_000,
} as const;
export type SimulatorLimits = { [K in keyof typeof SIMULATOR_LIMITS]: number };
const CONTROL_OUTPUT_MAX = 16 * 1024;
const UDID = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/i;

export interface SimulatorRequest {
  // simctl create 의 device type(이름 또는 식별자, 예: "iPhone 17 Pro").
  deviceType: string;
  // simctl create 의 runtime(생략하면 simctl 이 그 기기에 맞는 최신 runtime 을 고른다).
  runtime?: string;
  // log stream --predicate. 생략하면 필터 없이 받고 상한에서 자른다.
  logPredicate?: string;
}

export interface SimulatorControlRecord {
  args: string[]; exitCode: number | null; signal: string | null; timedOut: boolean; cancelled: boolean;
  stdout: string; stderr: string; error: string | null; durationMs: number;
}
export interface SimulatorLogRecord {
  path: string; predicate: string | null; pid: number | null;
  // captured = 정리 시작까지 스트림이 살아 있었고 쓰기 오류가 없었다 · failed = 시작·쓰기 실패 또는 정리 전 종료(error 에 사유). 수집 실패는 complete 를 막는다.
  status: "running" | "captured" | "failed";
  maxBytes: number;
  // bytesDropped·truncated = 상한(maxBytes)을 넘어 읽고 버린 양(정상) · bytesUnwritten = 쓰기 실패로 기록하지 못한 양(수집 실패).
  bytesWritten: number; bytesDropped: number; bytesUnwritten: number; truncated: boolean;
  exitCode: number | null; signal: string | null; stderr: string; error: string | null;
}
export interface SimulatorRecord {
  name: string; deviceType: string; runtime: string | null; udid: string | null;
  setup: { status: "ready" | "failed" | "cancelled"; error: string | null; steps: SimulatorControlRecord[] };
  log: SimulatorLogRecord | null;
  teardown: {
    // removed = 소유 기기를 지우고 목록에서 부재 확인 + 스트림 회수 완료 · not_created = 기기가 만들어지지 않았음을 목록으로 확인 · failed = 그 밖.
    status: "removed" | "not_created" | "failed" | "pending";
    stream: { status: "stopped" | "not_started" | "failed"; error: string | null };
    steps: SimulatorControlRecord[];
    error: string | null;
  };
}

export interface SimulatorOwnership { name: string; udid: string | null }
export interface SimulatorHandle {
  readonly record: SimulatorRecord;
  readonly ready: boolean;
  // 여러 번 불러도 정리는 한 번만 한다. 예외를 던지지 않고 결과를 record.teardown 에 남긴다.
  release(): Promise<SimulatorRecord>;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export async function acquireSimulator(input: {
  label: string; request: SimulatorRequest; logPath: string; simctl: readonly string[];
  limits?: Partial<SimulatorLimits>; signal?: AbortSignal;
  // 소유 사실을 남길 자리 — 기기 이름을 정한 직후(udid null)와 UDID 를 안 직후에 부른다. 실패하면 준비 실패로 보고 만든 기기를 정리한다.
  onOwnership: (ownership: SimulatorOwnership) => Promise<void>;
  // 증거 폴더에 쓰기 직전마다(소유 기록 두 번·로그 파일 열기) 부른다 — 호출자가 차지한 증거 폴더가 그대로인지 확인하고 아니면 던진다.
  // 기기 준비는 비동기라 그사이 폴더가 바뀔 수 있다. 던지면 준비 실패로 보고, 그 뒤로는 증거 폴더에 아무것도 쓰지 않고 만든 기기를 정리한다.
  guard: () => Promise<void>;
}): Promise<SimulatorHandle> {
  const limits: SimulatorLimits = { ...SIMULATOR_LIMITS, ...input.limits };
  const name = `cr-verify-${input.label}-${randomBytes(6).toString("hex")}`;
  const record: SimulatorRecord = {
    name, deviceType: input.request.deviceType, runtime: input.request.runtime ?? null, udid: null,
    setup: { status: "failed", error: null, steps: [] }, log: null,
    teardown: { status: "pending", stream: { status: "not_started", error: null }, steps: [], error: null },
  };
  const control = (args: string[], timeoutMs: number, signal?: AbortSignal) => runControl(input.simctl, args, timeoutMs, signal);
  let stream: LogStream | null = null;
  // 기기 존재 여부를 모르는 상태(create 시간 초과 등)에서 목록 확인으로 정리 대상을 정할 수 있는지.
  let creationUnknown = false;
  const fail = (status: "failed" | "cancelled", error: string) => { record.setup.status = status; record.setup.error = error; };
  try {
    await input.guard();
    await input.onOwnership({ name, udid: null });
    // create 는 취소 신호로 끊지 않는다(짧고, 끊으면 기기 생성 여부를 모르게 된다). 상한은 둔다.
    const create = await control(["create", name, input.request.deviceType, ...(input.request.runtime ? [input.request.runtime] : [])], limits.controlTimeoutMs);
    record.setup.steps.push(create);
    const printed = create.stdout.trim();
    if (create.exitCode === 0 && UDID.test(printed)) record.udid = printed;
    else {
      // create 가 UDID 를 돌려주지 않았다 — 이 실행만 아는 난수 이름으로 목록에서 찾는다. 찾으면 이 실행이 만든 기기이고 UDID 로 정리한다.
      const found = await findByName(control, limits.controlTimeoutMs, name, record.setup.steps);
      if (found.udid) record.udid = found.udid;
      else creationUnknown = !found.listed;
      fail("failed", `simctl create 실패: ${describeControl(create)}${found.udid ? ` — 같은 이름의 기기(${found.udid})가 있어 정리 대상으로 기록했습니다` : ""}`);
      if (!found.udid) return handle();
    }
    await input.guard();
    await input.onOwnership({ name, udid: record.udid });
    if (record.setup.error) return handle();
    if (input.signal?.aborted) { fail("cancelled", "기기 부팅 전에 취소됐습니다."); return handle(); }
    const deadline = Date.now() + limits.bootTimeoutMs;
    for (const args of [["boot", record.udid!], ["bootstatus", record.udid!, "-b"]]) {
      const step = await control(args, Math.max(1, deadline - Date.now()), input.signal);
      record.setup.steps.push(step);
      if (step.cancelled) { fail("cancelled", `simctl ${args[0]} 중에 취소됐습니다.`); return handle(); }
      if (step.exitCode !== 0) { fail("failed", `simctl ${args[0]} 실패: ${describeControl(step)}`); return handle(); }
    }
    if (input.signal?.aborted) { fail("cancelled", "log stream 시작 전에 취소됐습니다."); return handle(); }
    await input.guard();
    const predicate = input.request.logPredicate ?? null;
    stream = startLogStream(input.simctl, record.udid!, predicate, input.logPath, limits.logMaxBytes);
    record.log = stream.record;
    if (stream.record.error) { fail("failed", `log stream 시작 실패: ${stream.record.error}`); return handle(); }
    record.setup.status = "ready";
    return handle();
  } catch (error) {
    fail("failed", message(error));
    return handle();
  }

  function handle(): SimulatorHandle {
    let released: Promise<SimulatorRecord> | null = null;
    return {
      record, ready: record.setup.status === "ready",
      release: () => released ??= teardown(),
    };
  }

  async function teardown(): Promise<SimulatorRecord> {
    const errors: string[] = [];
    try {
      if (stream) {
        record.teardown.stream = await stream.stop();
        if (record.teardown.stream.status === "failed") errors.push(`log stream 회수 실패: ${record.teardown.stream.error}`);
      }
      if (!record.udid) {
        if (creationUnknown) {
          // create 결과를 모르고 목록도 못 읽었다 — 다시 한 번 이름으로 찾는다.
          const found = await findByName(control, limits.controlTimeoutMs, name, record.teardown.steps);
          if (found.udid) record.udid = found.udid;
          else if (!found.listed) errors.push(`기기 생성 여부를 확인하지 못했습니다(이름 ${name}).`);
        }
        if (!record.udid) {
          record.teardown.status = errors.length ? "failed" : "not_created";
          record.teardown.error = errors.join(" ") || null;
          return record;
        }
      }
      const udid = record.udid;
      const shutdown = await control(["shutdown", udid], limits.controlTimeoutMs);
      record.teardown.steps.push(shutdown);
      // 이미 꺼진 기기에 shutdown 하면 simctl 은 실패를 돌려준다 — 실패는 기록만 하고 delete 로 넘어간다(판정은 마지막 목록 확인으로 한다).
      const removed = await control(["delete", udid], limits.controlTimeoutMs);
      record.teardown.steps.push(removed);
      const listed = await listDevices(control, limits.controlTimeoutMs, record.teardown.steps);
      if (!listed) errors.push(`기기 목록을 읽지 못해 삭제를 확인하지 못했습니다(UDID ${udid}). delete: ${describeControl(removed)}`);
      else if (listed.some((device) => device.udid === udid)) {
        const state = listed.find((device) => device.udid === udid)?.state ?? "알 수 없음";
        errors.push(`기기가 남아 있습니다(UDID ${udid}, 상태 ${state}). shutdown: ${describeControl(shutdown)}; delete: ${describeControl(removed)}`);
      }
    } catch (error) {
      errors.push(message(error));
    }
    record.teardown.status = errors.length ? "failed" : "removed";
    record.teardown.error = errors.join(" ") || null;
    return record;
  }
}

// 이 실행의 시뮬레이터 몫이 끝났는가 — 기기 정리(삭제 확인 또는 미생성 확인)와 로그 수집(시작했다면 captured)이 모두 맞아야 한다. complete 의 조건이다.
export function simulatorComplete(record: SimulatorRecord | null): boolean {
  if (!record) return true;
  const settled = record.teardown.status === "removed" || record.teardown.status === "not_created";
  return settled && (record.log === null || record.log.status === "captured");
}

// 요약 한 줄 — 호스트 검증 요약(describeHostVerification)에 붙인다.
export function describeSimulator(record: SimulatorRecord): string {
  const device = `시뮬레이터 ${record.udid ?? record.name}`;
  const setup = record.setup.status === "ready" ? "" : ` 준비 ${record.setup.status}(${record.setup.error})`;
  const log = record.log ? ` 로그 ${record.log.bytesWritten}B${record.log.truncated ? `(상한 초과 ${record.log.bytesDropped}B 버림)` : ""}`
    + `${record.log.status === "failed" ? ` 수집 실패(${record.log.error})` : ""}` : "";
  const teardown = record.teardown.status === "removed" ? "삭제됨" : record.teardown.status === "not_created" ? "생성 안 됨" : `정리 ${record.teardown.status}: ${record.teardown.error}`;
  return `${device}:${setup}${log} ${teardown}`;
}

type Control = (args: string[], timeoutMs: number, signal?: AbortSignal) => Promise<SimulatorControlRecord>;

async function listDevices(control: Control, timeoutMs: number, steps: SimulatorControlRecord[]): Promise<{ udid: string; name: string; state: string }[] | null> {
  const list = await control(["list", "devices", "-j"], timeoutMs);
  // 목록 JSON 은 길 수 있어 기록에는 요약만 남긴다(전체 stdout 은 파싱에만 쓴다).
  steps.push({ ...list, stdout: list.stdout.length > 200 ? `${list.stdout.slice(0, 200)}…` : list.stdout });
  // 출력 상한을 넘으면 잘림 표시가 붙어 JSON 파싱이 실패한다 — 그때도 목록을 모르는 것으로 본다.
  if (list.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(list.stdout) as { devices?: Record<string, { udid?: unknown; name?: unknown; state?: unknown }[]> };
    if (!parsed.devices || typeof parsed.devices !== "object") return null;
    return Object.values(parsed.devices).flat().filter((device) => typeof device.udid === "string")
      .map((device) => ({ udid: String(device.udid), name: String(device.name ?? ""), state: String(device.state ?? "") }));
  } catch { return null; }
}

async function findByName(control: Control, timeoutMs: number, name: string, steps: SimulatorControlRecord[]): Promise<{ listed: boolean; udid: string | null }> {
  const devices = await listDevices(control, timeoutMs, steps);
  if (!devices) return { listed: false, udid: null };
  const matches = devices.filter((device) => device.name === name);
  return { listed: true, udid: matches.length === 1 ? matches[0].udid : null };
}

function describeControl(step: SimulatorControlRecord): string {
  const outcome = step.error ?? (step.timedOut ? "시간 초과" : step.cancelled ? "취소" : step.exitCode !== null ? `exit ${step.exitCode}` : `signal ${step.signal}`);
  const detail = step.stderr.trim().split("\n").at(-1);
  return detail ? `${outcome} — ${detail}` : outcome;
}

// 출력 상한이 있는 짧은 simctl 호출. 자기 프로세스 그룹으로 띄우고, 시간 초과·취소면 그 그룹만 끝낸다.
function runControl(simctl: readonly string[], args: string[], timeoutMs: number, signal?: AbortSignal): Promise<SimulatorControlRecord> {
  const [command, ...prefix] = simctl;
  const started = performance.now();
  const base = { args, exitCode: null, signal: null, timedOut: false, cancelled: false, stdout: "", stderr: "", error: null, durationMs: 0 };
  if (signal?.aborted) return Promise.resolve({ ...base, cancelled: true });
  return new Promise((resolveControl) => {
    // list 결과는 파싱해야 하므로 출력 상한을 넉넉히 둔다(그래도 무제한은 아니다).
    const limit = args[0] === "list" ? 16 * 1024 * 1024 : CONTROL_OUTPUT_MAX;
    const out = capture(limit), err = capture(CONTROL_OUTPUT_MAX);
    let child: ChildProcess;
    try {
      child = spawn(command, [...prefix, ...args], { detached: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolveControl({ ...base, error: message(error), durationMs: performance.now() - started });
      return;
    }
    child.stdout!.on("data", out.add);
    child.stderr!.on("data", err.add);
    let stopped: "timedOut" | "cancelled" | null = null;
    let drain: Promise<unknown> | undefined;
    let done = false;
    let exit: { code: number | null; signal: NodeJS.Signals | null } | null = null;
    let spawnError: Error | null = null;
    const stop = (reason: NonNullable<typeof stopped>) => {
      if (stopped || done) return;
      stopped = reason;
      try { terminateProcessGroup(child.pid, "SIGTERM"); } catch { /* 그룹이 이미 없음 */ }
      drain = drainProcessGroup(child.pid);
    };
    const onAbort = () => stop("cancelled");
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => stop("timedOut"), timeoutMs);
    const finish = async () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (drain) await drain;
      resolveControl({
        args, exitCode: exit?.code ?? null, signal: exit?.signal ?? null, timedOut: stopped === "timedOut", cancelled: stopped === "cancelled",
        stdout: out.text(), stderr: err.text(), error: spawnError ? spawnError.message : null, durationMs: performance.now() - started,
      });
    };
    child.once("error", (error) => { spawnError = error; void finish(); });
    // close 는 stdout·stderr 가 모두 닫힌 뒤에 온다(출력을 다 읽은 뒤 판정). 손자가 파이프를 붙잡아도 2초 뒤에는 끝낸다.
    child.once("close", () => { void finish(); });
    child.once("exit", (code, exitSignal) => {
      exit = { code, signal: exitSignal };
      setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); void finish(); }, 2_000).unref();
    });
  });
}

function capture(limit: number) {
  const chunks: Buffer[] = [];
  let size = 0, over = false;
  return {
    add: (chunk: Buffer) => {
      if (size >= limit) { over = true; return; }
      const part = chunk.subarray(0, limit - size);
      if (part.length < chunk.length) over = true;
      chunks.push(part); size += part.length;
    },
    text: () => Buffer.concat(chunks).toString("utf8") + (over ? "\n…(출력 상한 초과로 잘림)" : ""),
  };
}

interface LogStream { record: SimulatorLogRecord; stop(): Promise<SimulatorRecord["teardown"]["stream"]> }

function startLogStream(simctl: readonly string[], udid: string, predicate: string | null, path: string, maxBytes: number): LogStream {
  const [command, ...prefix] = simctl;
  const record: SimulatorLogRecord = { path, predicate, pid: null, status: "running", maxBytes, bytesWritten: 0, bytesDropped: 0, bytesUnwritten: 0, truncated: false,
    exitCode: null, signal: null, stderr: "", error: null };
  const notStarted = async (): Promise<SimulatorRecord["teardown"]["stream"]> => { record.status = "failed"; return { status: "not_started", error: null }; };
  let fd: number;
  try { fd = openSync(path, "wx", 0o600); } catch (error) { record.error = `로그 파일을 만들지 못했습니다: ${message(error)}`; return { record, stop: notStarted }; }
  let child: ChildProcess;
  try {
    child = spawn(command, [...prefix, "spawn", udid, "log", "stream", "--style", "compact", ...(predicate ? ["--predicate", predicate] : [])],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    closeSync(fd);
    record.error = message(error);
    return { record, stop: notStarted };
  }
  record.pid = child.pid ?? null;
  const err = capture(CONTROL_OUTPUT_MAX);
  // accepting = 파일에 계속 쓸 수 있는가(쓰기 실패·정리 뒤 false). 상한으로 버린 양과 쓰기 실패로 못 쓴 양은 따로 센다 — 상한은 정상, 쓰기 실패는 수집 실패다.
  let accepting = true;
  let stopping = false;
  let earlyExit = false;
  child.stdout!.on("data", (chunk: Buffer) => {
    const part = accepting ? chunk.subarray(0, Math.max(0, maxBytes - record.bytesWritten)) : chunk.subarray(0, 0);
    let written = 0;
    try {
      // writeSync 는 요청보다 적게 쓸 수 있다 — 돌려준 바이트로 남은 부분을 이어 쓴다.
      while (written < part.length) {
        const count = writeSync(fd, part, written, part.length - written);
        if (count <= 0) throw new Error("0 바이트를 썼습니다.");
        written += count;
      }
    } catch (error) {
      record.error ??= `로그 파일 쓰기 실패: ${message(error)}`;
      accepting = false;
    }
    record.bytesWritten += written;
    if (accepting) {
      const dropped = chunk.length - part.length;
      if (dropped > 0) { record.bytesDropped += dropped; record.truncated = true; }
    } else record.bytesUnwritten += chunk.length - written;
  });
  child.stderr!.on("data", (chunk: Buffer) => { err.add(chunk); record.stderr = err.text(); });
  const closed = new Promise<void>((resolveClosed) => {
    child.once("close", () => resolveClosed());
    child.once("error", (error) => { record.error ??= `log stream 실행 오류: ${message(error)}`; resolveClosed(); });
  });
  child.once("exit", (code, signal) => {
    record.exitCode = code; record.signal = signal;
    // 이 실행이 끝내기 전에 스트림이 끝났다 — 그 뒤 기간의 로그는 받지 못했다(잘못된 predicate·기기 쪽 종료 등). 사유는 stderr 를 다 읽은 뒤 stop 에서 적는다.
    if (!stopping) earlyExit = true;
  });
  if (!child.pid) record.error ??= "log stream 프로세스를 만들지 못했습니다.";
  return {
    record,
    async stop() {
      stopping = true;
      let error: string | null = null;
      if (child.pid) {
        try { terminateProcessGroup(child.pid, "SIGTERM"); } catch (cause) { error = message(cause); }
        const drained = await drainProcessGroup(child.pid);
        if (drained) error = message(drained);
      }
      // 남은 출력을 다 읽거나(close) 2초가 지나면 파이프를 닫는다 — 그룹 밖의 프로세스가 파이프를 붙잡아도 여기서 끝난다.
      await Promise.race([closed, new Promise<void>((resolveWait) => setTimeout(resolveWait, 2_000).unref())]);
      accepting = false;
      child.stdout?.destroy(); child.stderr?.destroy();
      try { closeSync(fd); } catch (cause) { record.error ??= `로그 파일 닫기 실패: ${message(cause)}`; }
      if (earlyExit) {
        const exit = record.exitCode !== null ? `exit ${record.exitCode}` : `signal ${record.signal}`;
        const detail = record.stderr.trim().split("\n").at(-1);
        record.error ??= `log stream 이 정리 전에 끝났습니다(${exit})${detail ? ` — ${detail}` : ""}.`;
      }
      record.status = record.error ? "failed" : "captured";
      return { status: error ? "failed" : "stopped", error };
    },
  };
}
