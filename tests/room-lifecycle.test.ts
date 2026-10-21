import { EventEmitter } from "node:events";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess, SpawnOptions } from "node:child_process";

const commands = vi.hoisted(() => ({ run: vi.fn(), spawn: vi.fn() }));
vi.mock("node:child_process", async importOriginal => ({
  ...await importOriginal<typeof import("node:child_process")>(),
  execFile: (file: string, args: string[], options: unknown, callback: (error: unknown, stdout: string, stderr: string) => void) => {
    void commands.run(file, args, options).then(() => callback(null, "", ""), (error: unknown) => callback(error, "", ""));
  },
  spawn: commands.spawn,
}));

import { openRoom, readLaunchConnection, restartRoom, roomStatus, startRoom, stopRoom } from "../src/cli/lifecycle.js";
import type { RoomConfig } from "../src/cli/config.js";
import { systemProcessControl, type ProcessIdentity } from "../src/server/processSupervisor.js";

// Public boundary: CLI lifecycle functions. Consumers: command dispatch JSON and
// authenticated API client. Contract: own server only, no busy interruption,
// candidate failure keeps the live server, concurrent starts create one child,
// and credentials never reach printable status/errors/logs.
// The fake OS/API reproduces PID reuse, EPERM, failed health and startup failure;
// SQLite locking and the redacting child bootstrap also run as real boundaries.
// New feature: restoring a pre-existing bug is not applicable. Browser rendering,
// real server recovery/model execution and full application build are not claimed.
describe("public room lifecycle", () => {
  const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const pid = 41002;
  const identity: ProcessIdentity = { pgid: pid, commandLine: `node ${sourceRoot}/src/server/index.ts`, startedAt: "Sun Oct 18 10:00:00 2026" };
  let directory: string;
  let config: RoomConfig;
  let serverRepositoryPath: string;
  let processes: Map<number, ProcessIdentity>;
  let signals: Array<{ pid: number; signal: NodeJS.Signals }>;
  let activity: Record<string, unknown>;
  let fetchMock: ReturnType<typeof vi.fn<(input: string, init: RequestInit) => Promise<Response>>>;
  let child: ChildProcess;

  function registry(overrides: Record<string, unknown> = {}): void {
    writeFileSync(join(directory, "server-process.json"), JSON.stringify({ pid, ...identity,
      repositoryPath: sourceRoot, dataDirectory: directory, executable: process.execPath, ...overrides }), { mode: 0o600 });
  }
  function connection(url = `http://127.0.0.1:${config.port}/?token=private-test-token`): void {
    writeFileSync(join(directory, "consensus-room.url"), `${url}\n`, { mode: 0o600 });
  }
  function live(): void { processes.set(pid, identity); registry(); connection(); }
  function deferred<T>() {
    let resolve!: (value: T | PromiseLike<T>) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
  }

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "room-lifecycle-"));
    config = { version: 1, repositoryPath: join(directory, "user-project"), dataDirectory: directory, port: 43817,
      figmaMcpUrl: null, agents: { claude: { model: "claude-test", effort: "high", implementation: { model: "claude-test", effort: "high" },
        advisorModel: null, ultracode: false }, codex: { model: "codex-test", effort: "high" } } };
    serverRepositoryPath = config.repositoryPath;
    processes = new Map(); signals = [];
    activity = { runningAction: null, autoRetryAt: null, continuation: null, evidenceResume: null };
    vi.spyOn(systemProcessControl, "inspect").mockImplementation(value => processes.get(value) ?? null);
    vi.spyOn(process, "kill").mockImplementation((value, signal) => {
      if (!processes.has(value)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal === 0) return true;
      signals.push({ pid: value, signal: signal as NodeJS.Signals });
      processes.delete(value);
      if (existsSync(join(directory, "server-process.json"))) unlinkSync(join(directory, "server-process.json"));
      child?.emit("exit", 0, signal);
      return true;
    });
    fetchMock = vi.fn(async (input: string, init: RequestInit) => {
      expect(init.redirect).toBe("error");
      const token = new URL(readFileSync(join(directory, "consensus-room.url"), "utf8").trim()).searchParams.get("token");
      expect(init.headers).toEqual({ "x-consensus-token": token });
      if (input.endsWith("/api/health")) return Response.json({ ok: true });
      if (input.endsWith("/api/config")) return Response.json({ repositoryPath: serverRepositoryPath });
      if (input.endsWith("/api/topics")) return Response.json([{ id: "fixture-topic" }]);
      if (input.endsWith("/api/topics/fixture-topic/resume")) return Response.json(activity);
      throw new Error("unexpected request");
    });
    vi.stubGlobal("fetch", fetchMock);
    commands.run.mockReset().mockImplementation(async (_file: string, _args: string[], options: { env?: NodeJS.ProcessEnv }) => {
      const out = options.env?.CONSENSUS_ROOM_CANDIDATE_WEB_DIR;
      if (out) writeFileSync(join(out, "index.html"), "<html>candidate</html>");
    });
    commands.spawn.mockReset().mockImplementation((_file: string, _args: string[], options: SpawnOptions) => {
      child = Object.assign(new EventEmitter(), { pid, unref: vi.fn() }) as unknown as ChildProcess;
      processes.set(pid, identity);
      queueMicrotask(() => {
        serverRepositoryPath = options.env!.CONSENSUS_ROOM_REPOSITORY!;
        registry();
        connection(`http://127.0.0.1:${config.port}/?token=${options.env!.CONSENSUS_ROOM_TOKEN}`);
        child.emit("spawn");
      });
      return child;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers();
    rmSync(directory, { recursive: true, force: true });
  });

  it("reports stopped, authenticated live and unhealthy states without exposing a token", async () => {
    expect((await roomStatus(config)).state).toBe("stopped");
    live();
    expect(await roomStatus(config)).toEqual({ state: "running", pid, url: `http://127.0.0.1:${config.port}` });
    fetchMock.mockResolvedValueOnce(Response.json({ error: "no" }, { status: 401 }));
    const status = await roomStatus(config);
    expect(status.state).toBe("unhealthy");
    expect(JSON.stringify(status)).not.toContain("private-test-token");
    expect(signals).toEqual([]);
  });

  it("refuses readiness for an old project, allows its safe stop and starts the newly configured project", async () => {
    live();
    config = { ...config, repositoryPath: join(directory, "next-project") };
    expect(await roomStatus(config)).toMatchObject({ state: "unhealthy", detail: expect.stringContaining("대상 저장소가 현재 설정과 다릅니다") });
    await expect(startRoom(config)).rejects.toThrow("대상 저장소가 현재 설정과 다릅니다");
    expect(commands.run).not.toHaveBeenCalled();
    expect(commands.spawn).not.toHaveBeenCalled();
    expect(signals).toEqual([]);
    await stopRoom(config);
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect((await startRoom(config)).state).toBe("running");
    expect(serverRepositoryPath).toBe(config.repositoryPath);
  });

  it.each([
    ["another checkout", { repositoryPath: "/different/consensus-room" }],
    ["another data directory", { dataDirectory: "/different/data" }],
    ["a non-absolute executable", { executable: "node" }],
    ["reused PID", { startedAt: "Sun Oct 18 11:00:00 2026" }],
    ["changed command", { commandLine: "unrelated process" }],
  ])("does not adopt or signal %s", async (_label, replacement) => {
    live(); registry(replacement);
    expect((await roomStatus(config)).state).toBe("unknown");
    await expect(stopRoom(config)).rejects.toThrow();
    await expect(startRoom(config)).rejects.toThrow();
    expect(signals).toEqual([]);
    expect(commands.spawn).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // engine-review 0d1b8c76 F003: Homebrew·nvm 으로 Node 를 갱신하면 CLI 의 실행 파일이 서버 기록의 executable 과 달라진다.
  // 소유권은 기록한 checkout·데이터 폴더와 기록한 프로세스 신원으로 정한다 — 같은 서버를 계속 다루고, 끝난 기록 뒤에는 새 Node 로 시작한다.
  it("keeps controlling a server recorded under an older Node and restarts it on the current Node", async () => {
    live(); registry({ executable: "/old/node/bin/node" });
    expect(await roomStatus(config)).toEqual({ state: "running", pid, url: `http://127.0.0.1:${config.port}` });
    expect((await restartRoom(config)).state).toBe("running");
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(JSON.parse(readFileSync(join(directory, "server-process.json"), "utf8")).executable).toBe(process.execPath);
  });

  it("starts on the current Node after a crashed server recorded an older Node", async () => {
    registry({ executable: "/old/node/bin/node" }); connection();
    expect((await roomStatus(config)).state).toBe("stopped");
    expect((await startRoom(config)).state).toBe("running");
    expect(commands.spawn).toHaveBeenCalledTimes(1);
    expect(signals).toEqual([]);
  });

  it("fails closed on EPERM and unreadable process identity", async () => {
    live();
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error("denied"), { code: "EPERM" }); });
    expect((await roomStatus(config)).state).toBe("unknown");
    await expect(stopRoom(config)).rejects.toThrow();
    vi.mocked(process.kill).mockReturnValue(true);
    vi.mocked(systemProcessControl.inspect).mockReturnValue(null);
    expect((await roomStatus(config)).state).toBe("unknown");
    await expect(stopRoom(config)).rejects.toThrow();
    expect(signals).toEqual([]);
  });

  it.each([
    { runningAction: { id: "action", kind: "implementation" } },
    { autoRetryAt: "2026-10-18T11:00:00Z" },
    { evidenceResume: { step: "evidence" } },
    { continuation: { status: "running" } },
  ])("refuses active or scheduled work before sending a signal: %j", async busy => {
    live(); Object.assign(activity, busy);
    await expect(stopRoom(config)).rejects.toThrow("실행 중이거나 예약된 작업");
    expect(signals).toEqual([]);
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
    expect(processes.has(pid)).toBe(true);
  });

  it("checks work again under the engine maintenance lock and keeps a newly busy server alive", async () => {
    live();
    const defaultFetch = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation(async (input: string, init: RequestInit) => {
      if (existsSync(join(directory, "maintenance.lock"))) activity.runningAction = { id: "newly-admitted" };
      return defaultFetch(input, init);
    });
    await expect(stopRoom(config)).rejects.toThrow("실행 중이거나 예약된 작업");
    expect(signals).toEqual([]);
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
  });

  it("gracefully stops the exact PID and allows durable pending continuation intent", async () => {
    live(); activity.continuation = { status: "pending", step: "evidence" };
    const defaultFetch = fetchMock.getMockImplementation()!;
    let observedEngineLock = false;
    fetchMock.mockImplementation(async (input: string, init: RequestInit) => {
      const path = join(directory, "maintenance.lock");
      if (existsSync(path)) {
        expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ reason: "restart_room", mode: "idle-restart", pid: process.pid });
        observedEngineLock = true;
      }
      return defaultFetch(input, init);
    });
    await stopRoom(config);
    expect(observedEngineLock).toBe(true);
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect((await roomStatus(config)).state).toBe("stopped");
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
    expect(activity.continuation).toEqual({ status: "pending", step: "evidence" });
  });

  it("preserves a foreign maintenance lock and never signals its server", async () => {
    live(); const lock = join(directory, "maintenance.lock");
    const original = JSON.stringify({ pid: 17, at: "2026-10-18T01:00:00Z", reason: "other-maintenance" });
    writeFileSync(lock, original);
    await expect(stopRoom(config)).rejects.toThrow("다른 유지보수 잠금");
    expect(readFileSync(lock, "utf8")).toBe(original);
    expect(signals).toEqual([]);
  });

  function expiredCliLock(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({ owner: "public-cli", reason: "restart_room", mode: "idle-restart", pid: 41003,
      at: new Date(Date.now() - 2 * 60 * 60_000).toISOString(), ...overrides });
  }

  it("recovers only an expired public CLI maintenance lock whose owner is confirmed dead", async () => {
    live(); const path = join(directory, "maintenance.lock");
    writeFileSync(path, expiredCliLock(), { mode: 0o600 });
    const defaultFetch = fetchMock.getMockImplementation()!;
    let observedReplacement = false;
    fetchMock.mockImplementation(async (input: string, init: RequestInit) => {
      const lock = JSON.parse(readFileSync(path, "utf8"));
      if (lock.pid === process.pid) {
        expect(lock.owner).toBe("public-cli");
        observedReplacement = true;
      }
      return defaultFetch(input, init);
    });
    await stopRoom(config);
    expect(observedReplacement).toBe(true);
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(existsSync(path)).toBe(false);
  });

  it.each([
    ["foreign", { owner: "other-cli" }], ["untagged", { owner: undefined }],
    ["different reason", { reason: "other-maintenance" }], ["different mode", { mode: "force" }],
    ["young", { at: new Date(Date.now() - 30 * 60_000).toISOString() }],
    ["invalid timestamp", { at: "not-a-date" }], ["invalid PID", { pid: "41003" }],
    ["live owner", { pid }],
  ])("preserves a %s maintenance lock", async (_label, overrides) => {
    live(); const path = join(directory, "maintenance.lock");
    const content = expiredCliLock(overrides);
    writeFileSync(path, content, { mode: 0o600 });
    await expect(stopRoom(config)).rejects.toThrow("다른 유지보수 잠금");
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(signals).toEqual([]);
    expect(processes.has(pid)).toBe(true);
  });

  it.each(["reused PID", "EPERM", "corrupt JSON", "symlink"])("preserves an expired lock with unconfirmed ownership: %s", async condition => {
    live(); const path = join(directory, "maintenance.lock");
    const content = condition === "corrupt JSON" ? "{" : expiredCliLock();
    if (condition === "symlink") {
      const target = join(directory, "foreign-maintenance.lock");
      writeFileSync(target, content, { mode: 0o600 }); symlinkSync(target, path);
    } else writeFileSync(path, content, { mode: 0o600 });
    if (condition === "reused PID") processes.set(41003, { ...identity, startedAt: "Sun Oct 18 15:00:00 2026" });
    if (condition === "EPERM") {
      const defaultKill = vi.mocked(process.kill).getMockImplementation()!;
      vi.mocked(process.kill).mockImplementation((value, signal) => {
        if (value === 41003) throw Object.assign(new Error("denied"), { code: "EPERM" });
        return defaultKill(value, signal);
      });
    }
    await expect(stopRoom(config)).rejects.toThrow("다른 유지보수 잠금");
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(signals).toEqual([]);
    if (condition === "symlink") expect(lstatSync(path).isSymbolicLink()).toBe(true);
  });

  it.each(["inode", "content"])("preserves an expired lock changed during dead-owner verification: %s", async changed => {
    live(); const path = join(directory, "maintenance.lock");
    const original = expiredCliLock();
    const replacement = changed === "content" ? expiredCliLock({ owner: "new-owner" }) : original;
    writeFileSync(path, original, { mode: 0o600 });
    const defaultKill = vi.mocked(process.kill).getMockImplementation()!;
    vi.mocked(process.kill).mockImplementation((value, signal) => {
      if (value === 41003) {
        if (changed === "inode") renameSync(path, join(directory, "preserved-old-lock"));
        writeFileSync(path, replacement, { mode: 0o600 });
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return defaultKill(value, signal);
    });
    await expect(stopRoom(config)).rejects.toThrow("다른 유지보수 잠금");
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(signals).toEqual([]);
  });

  it("keeps an unresponsive server alive when graceful exit times out", async () => {
    live(); vi.useFakeTimers();
    vi.mocked(process.kill).mockImplementation((value, signal) => {
      if (signal !== 0) signals.push({ pid: value, signal: signal as NodeJS.Signals });
      return true;
    });
    const failure = expect(stopRoom(config)).rejects.toThrow("정상 종료를 확인하지 못했습니다");
    await vi.advanceTimersByTimeAsync(30_100);
    await failure;
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(processes.has(pid)).toBe(true);
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
  });

  it("confirms graceful exit when the process disappears between kill(0) and identity inspection", async () => {
    live(); let exiting = false;
    vi.mocked(process.kill).mockImplementation((value, signal) => {
      if (!processes.has(value)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal !== 0) { signals.push({ pid: value, signal: signal as NodeJS.Signals }); exiting = true; }
      return true;
    });
    vi.mocked(systemProcessControl.inspect).mockImplementation(value => {
      if (exiting) {
        processes.delete(value);
        unlinkSync(join(directory, "server-process.json"));
        return null;
      }
      return processes.get(value) ?? null;
    });
    await stopRoom(config);
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect((await roomStatus(config)).state).toBe("stopped");
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
  });

  it.each(["missing", "defunct"])("waits through a transient exit identity until ESRCH: %s", async condition => {
    live(); vi.useFakeTimers(); let exiting = false; let exitInspections = 0;
    const signalled = deferred<void>();
    vi.mocked(process.kill).mockImplementation((value, signal) => {
      if (!processes.has(value)) throw Object.assign(new Error("gone"), { code: "ESRCH" });
      if (signal !== 0) {
        signals.push({ pid: value, signal: signal as NodeJS.Signals }); exiting = true; signalled.resolve();
      }
      return true;
    });
    vi.mocked(systemProcessControl.inspect).mockImplementation(value => {
      if (exiting) {
        exitInspections++;
        return condition === "missing" ? null : { ...identity, commandLine: "[node] <defunct>" };
      }
      return processes.get(value) ?? null;
    });
    const result = stopRoom(config).then(() => ({ ok: true }), error => ({ ok: false, error }));
    await signalled.promise;
    expect(exitInspections).toBeGreaterThan(0);
    processes.delete(pid); unlinkSync(join(directory, "server-process.json"));
    await vi.advanceTimersToNextTimerAsync();
    expect(await result).toEqual({ ok: true });
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
  });

  it.each(["still-alive", "reused PID", "EPERM"])("fails without another signal when exit remains unconfirmed: %s", async condition => {
    live(); vi.useFakeTimers(); let exiting = false; let missingIdentity = false;
    vi.mocked(process.kill).mockImplementation((value, signal) => {
      if (signal !== 0) { signals.push({ pid: value, signal: signal as NodeJS.Signals }); exiting = true; }
      if (missingIdentity && condition === "EPERM") throw Object.assign(new Error("denied"), { code: "EPERM" });
      return true;
    });
    vi.mocked(systemProcessControl.inspect).mockImplementation(value => {
      if (exiting) {
        missingIdentity = true;
        return condition === "reused PID" ? { ...identity, startedAt: "Sun Oct 18 15:00:00 2026" } : null;
      }
      return processes.get(value) ?? null;
    });
    const failure = expect(stopRoom(config)).rejects.toThrow(condition === "EPERM" ? "권한" : "정상 종료를 확인하지 못했습니다");
    await vi.advanceTimersByTimeAsync(30_100);
    await failure;
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(processes.has(pid)).toBe(true);
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
  });

  it("fails closed on malformed activity and preserves someone else's replacement maintenance lock", async () => {
    live(); const path = join(directory, "maintenance.lock");
    const defaultFetch = fetchMock.getMockImplementation()!;
    const replacement = JSON.stringify({ pid: 73, at: "2026-10-18T02:00:00Z", reason: "replacement" });
    fetchMock.mockImplementation(async (input: string, init: RequestInit) => {
      if (existsSync(path)) {
        writeFileSync(path, replacement);
        return Response.json({ state: "idle" });
      }
      return defaultFetch(input, init);
    });
    await expect(stopRoom(config)).rejects.toThrow("목록의 형식");
    expect(readFileSync(path, "utf8")).toBe(replacement);
    expect(signals).toEqual([]);
  });

  it.each(["typecheck", "web"])("keeps the current server alive when candidate %s fails", async stage => {
    live();
    if (stage === "web") commands.run.mockResolvedValueOnce(undefined);
    commands.run.mockRejectedValueOnce(new Error("candidate failed"));
    await expect(restartRoom(config)).rejects.toThrow("기존 서버는 유지");
    expect(processes.has(pid)).toBe(true);
    expect(signals).toEqual([]);
    expect(commands.spawn).not.toHaveBeenCalled();
    expect(existsSync(join(directory, "maintenance.lock"))).toBe(false);
  });

  it("preserves failed build diagnostics in a private log while redacting the live authentication token", async () => {
    live();
    commands.run.mockRejectedValueOnce(Object.assign(new Error("typecheck exit 2"), {
      stdout: "compiler diagnostics: file.ts(4,8) TS2349", stderr: "raw credential private-test-token",
    }));
    await expect(restartRoom(config)).rejects.toThrow("비공개 빌드 로그");
    const log = join(directory, "build-logs", readdirSync(join(directory, "build-logs"))[0]);
    const output = readFileSync(log, "utf8");
    expect(output).toContain("file.ts(4,8) TS2349");
    expect(output).toContain("typecheck exit 2");
    expect(output).not.toContain("private-test-token");
    expect(lstatSync(log).mode & 0o077).toBe(0);
    expect(processes.has(pid)).toBe(true);
    expect(signals).toEqual([]);
  });

  it("releases its lifecycle lease after a failed candidate so a corrected retry can start", async () => {
    commands.run.mockRejectedValueOnce(new Error("first candidate failed"));
    await expect(startRoom(config)).rejects.toThrow("typecheck");
    expect((await startRoom(config)).state).toBe("running");
    expect(commands.spawn).toHaveBeenCalledTimes(1);
  });

  it("serializes overlapping starts through a separate SQLite lease and starts only one child", async () => {
    const building = deferred<void>();
    const entered = deferred<void>();
    commands.run.mockImplementationOnce(async () => { entered.resolve(); await building.promise; });
    const first = startRoom(config);
    await entered.promise;
    const second = startRoom(config);
    const competing = new DatabaseSync(join(directory, "cli-lifecycle.sqlite"));
    try { expect(() => competing.exec("BEGIN EXCLUSIVE")).toThrow(); }
    finally { competing.close(); }
    expect(commands.spawn).not.toHaveBeenCalled();
    building.resolve();
    const statuses = await Promise.all([first, second]);
    expect(statuses.map(status => status.state)).toEqual(["running", "running"]);
    expect(commands.spawn).toHaveBeenCalledTimes(1);
    expect(commands.run).toHaveBeenCalledTimes(2);
    expect(commands.run.mock.calls.every(call => call[2].cwd === sourceRoot)).toBe(true);
    const args = commands.spawn.mock.calls[0][1] as string[];
    const options = commands.spawn.mock.calls[0][2] as SpawnOptions;
    expect(options.cwd).toBe(sourceRoot);
    expect(options.env!.CONSENSUS_ROOM_REPOSITORY).toBe(config.repositoryPath);
    expect(options.env!.CONSENSUS_ROOM_WEB_DIR).toMatch(`${directory}/web-dist/`);
    expect(args.join(" ")).not.toContain(options.env!.CONSENSUS_ROOM_TOKEN);
    expect(commands.run.mock.calls[1][1].join(" ")).toContain("publicDir:false");
  });

  it("builds a restart candidate before stopping the old server", async () => {
    live();
    const defaultRun = commands.run.getMockImplementation()!;
    commands.run.mockImplementation(async (...args: unknown[]) => {
      expect(processes.has(pid)).toBe(true);
      expect(signals).toEqual([]);
      return defaultRun(...args);
    });
    const status = await restartRoom(config);
    expect(status.state).toBe("running");
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(commands.spawn).toHaveBeenCalledTimes(1);
  });

  it("keeps startup failure as failure and does not signal another process", async () => {
    commands.spawn.mockImplementation(() => {
      child = Object.assign(new EventEmitter(), { pid, unref: vi.fn() }) as unknown as ChildProcess;
      processes.set(pid, identity);
      queueMicrotask(() => { child.emit("spawn"); child.emit("exit", 1, null); processes.delete(pid); });
      return child;
    });
    await expect(startRoom(config)).rejects.toThrow("비공개 로그");
    expect(signals).toEqual([]);
    expect(existsSync(join(directory, "cli-lifecycle.sqlite"))).toBe(true);
  });

  it("cleans up only its identified child when launch authentication is wrong", async () => {
    const defaultSpawn = commands.spawn.getMockImplementation()!;
    commands.spawn.mockImplementation((...args: unknown[]) => {
      const result = defaultSpawn(...args);
      queueMicrotask(() => connection("http://127.0.0.1:43817/?token=other-token"));
      return result;
    });
    await expect(startRoom(config)).rejects.toThrow("인증 기록이 일치하지");
    expect(signals).toEqual([{ pid, signal: "SIGTERM" }]);
    expect(processes.has(pid)).toBe(false);
  });

  it.each([
    "https://127.0.0.1:43817/?token=secret", "http://example.com:43817/?token=secret",
    "http://127.0.0.1:43818/?token=secret", "http://user@127.0.0.1:43817/?token=secret",
    "http://127.0.0.1:43817/arbitrary?token=secret", "http://127.0.0.1:43817/?token=secret&extra=1",
    "http://127.0.0.1:43817/?token=one&token=two", "http://127.0.0.1:43817/?token=secret#fragment",
    "http://127.0.0.1:43817/?token=%0Asecret", "not a URL", "http://2130706433:43817/?token=secret",
  ])("rejects unsafe launch URLs without exposing them: %s", url => {
    connection(url);
    expect(() => readLaunchConnection(config)).toThrow("localhost");
    try { readLaunchConnection(config); } catch (error) { expect(String(error)).not.toContain("secret"); }
  });

  it("requires private URL permissions and opens an authenticated local URL without a shell", async () => {
    live();
    expect(readLaunchConnection(config)).toEqual({ baseURL: "http://127.0.0.1:43817", token: "private-test-token" });
    chmodSync(join(directory, "consensus-room.url"), 0o644);
    expect(() => readLaunchConnection(config)).toThrow();
    chmodSync(join(directory, "consensus-room.url"), 0o600);
    await openRoom(config);
    const [program, args, options] = commands.run.mock.calls.at(-1)!;
    expect(program).toBe(process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open");
    expect(args.at(-1)).toBe("http://127.0.0.1:43817/?token=private-test-token");
    expect(options.shell).toBeUndefined();
  });

  it("redacts split launch tokens inside a real detached-child bootstrap", async () => {
    await startRoom(config);
    const bootstrap = commands.spawn.mock.calls[0][1].at(-1) as string;
    const entry = join(directory, "log-fixture.mjs");
    writeFileSync(entry, "process.stdout.write('launch ?token=private-');process.stdout.write('split-token\\n');process.stderr.write('private-split-');process.stderr.write('token');");
    const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const fixture = actual.spawn(process.execPath, ["--input-type=module", "--eval", bootstrap], {
      env: { ...process.env, CONSENSUS_ROOM_TOKEN: "private-split-token", CONSENSUS_ROOM_SERVER_ENTRY: pathToFileURL(entry).href }, stdio: "pipe",
    });
    let output = "";
    fixture.stdout!.on("data", chunk => { output += chunk; });
    fixture.stderr!.on("data", chunk => { output += chunk; });
    await new Promise<void>((done, fail) => { fixture.once("error", fail); fixture.once("close", code => code === 0 ? done() : fail(new Error(`fixture exit ${code}`))); });
    expect(output).toContain("launch ?token=[redacted]");
    expect(output).not.toContain("private-split-token");
    expect(output.match(/\[redacted\]/g)).toHaveLength(2);
  });
});
