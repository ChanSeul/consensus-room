import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { chmodSync, closeSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { systemProcessControl, type ProcessIdentity } from "../server/processSupervisor.js";
import { redactSecrets } from "../shared/workflow.js";
import { roomEnvironment, type RoomConfig } from "./config.js";

export interface RoomStatus {
  state: "stopped" | "running" | "unhealthy" | "unknown";
  pid?: number;
  /** Safe to print: authentication is never included. */
  url?: string;
  detail?: string;
}

interface ServerRecord extends ProcessIdentity {
  pid: number;
  repositoryPath: string;
  dataDirectory: string;
  executable: string;
}
type Ownership = { state: "owned"; record: ServerRecord } | { state: "stopped" | "unknown"; detail: string };
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const runFile = promisify(execFile);
const pause = (milliseconds: number) => new Promise<void>(done => setTimeout(done, milliseconds));
const operationTimeout = 30_000;

function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.startedAt === right.startedAt && left.commandLine === right.commandLine && left.pgid === right.pgid;
}

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw new Error("프로세스 생존 여부를 확인할 권한이 없습니다.");
  }
}

function ownership(config: RoomConfig): Ownership {
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(join(config.dataDirectory, "server-process.json"), "utf8")); }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { state: "stopped", detail: "서버 프로세스 기록이 없습니다." }
      : { state: "unknown", detail: "서버 프로세스 기록을 읽을 수 없습니다." };
  }
  const record = parsed as Partial<ServerRecord> | null;
  if (!record || !Number.isInteger(record.pid) || record.pid! <= 1 || !Number.isInteger(record.pgid) || record.pgid! <= 1 ||
      typeof record.startedAt !== "string" || !record.startedAt || typeof record.commandLine !== "string" || !record.commandLine ||
      record.repositoryPath !== sourceRoot || record.dataDirectory !== resolve(config.dataDirectory) ||
      typeof record.executable !== "string" || !isAbsolute(record.executable) || record.executable !== process.execPath) {
    return { state: "unknown", detail: "프로세스 기록이 이 Consensus Room 소스·데이터 경로와 일치하지 않습니다." };
  }
  try {
    if (!alive(record.pid!)) return { state: "stopped", detail: "기록된 서버 프로세스가 종료됐습니다." };
    const observed = systemProcessControl.inspect(record.pid!);
    if (!observed || !sameIdentity(record as ServerRecord, observed)) {
      return { state: "unknown", detail: "프로세스 신원을 확인할 수 없거나 PID가 재사용됐습니다." };
    }
    return { state: "owned", record: record as ServerRecord };
  } catch {
    return { state: "unknown", detail: "프로세스 생존 여부를 확인할 권한이 없습니다." };
  }
}

/** Only the private, local launch URL is accepted; never include its contents in errors. */
export function readLaunchConnection(config: RoomConfig): { baseURL: string; token: string } {
  try {
    const path = join(config.dataDirectory, "consensus-room.url");
    const stat = lstatSync(path);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 16_384 ||
        (process.getuid && stat.uid !== process.getuid())) throw new Error();
    const input = readFileSync(path, "utf8").trim();
    if (/\s/.test(input) || !/^http:\/\/(?:127\.0\.0\.1|localhost|\[::1\])(?::[1-9]\d{0,4})?\/\?token=[^&#]+$/.test(input)) throw new Error();
    const url = new URL(input);
    const token = url.searchParams.get("token");
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
        Number(url.port || 80) !== config.port || url.username || url.password || url.pathname !== "/" || url.hash ||
        [...url.searchParams.keys()].length !== 1 || !token || /[\s\u0000-\u001f\u007f]/.test(token)) throw new Error();
    return { baseURL: url.origin, token };
  } catch {
    throw new Error("비공개 시작 URL을 읽을 수 없거나 localhost·포트·인증 형식이 올바르지 않습니다.");
  }
}

async function request(connection: ReturnType<typeof readLaunchConnection>, path: string): Promise<unknown> {
  const response = await fetch(`${connection.baseURL}${path}`, {
    headers: { "x-consensus-token": connection.token }, redirect: "error", signal: AbortSignal.timeout(2_000),
  });
  if (!response.ok) throw new Error("인증된 서버 API 조회에 실패했습니다.");
  return response.json();
}

export async function roomStatus(config: RoomConfig): Promise<RoomStatus> {
  const owner = ownership(config);
  if (owner.state !== "owned") return owner;
  const status = { pid: owner.record.pid, url: `http://127.0.0.1:${config.port}` };
  try {
    const connection = readLaunchConnection(config);
    const health = await request(connection, "/api/health");
    if (!health || typeof health !== "object" || !("ok" in health) || health.ok !== true) throw new Error();
    const runningConfig = await request(connection, "/api/config");
    if (!runningConfig || typeof runningConfig !== "object" || !("repositoryPath" in runningConfig) ||
        typeof runningConfig.repositoryPath !== "string") throw new Error();
    const latest = ownership(config);
    if (latest.state !== "owned" || latest.record.pid !== owner.record.pid || !sameIdentity(latest.record, owner.record)) {
      return { state: "unknown", detail: "상태 조회 중 서버 프로세스 신원이 바뀌었습니다." };
    }
    if (runningConfig.repositoryPath !== resolve(config.repositoryPath)) {
      return { state: "unhealthy", ...status,
        detail: "실행 중인 서버의 대상 저장소가 현재 설정과 다릅니다. 기존 서버를 중지한 뒤 다시 시작하세요." };
    }
    return { state: "running", ...status };
  } catch {
    return { state: "unhealthy", ...status, detail: "프로세스는 살아 있지만 인증된 준비 상태를 확인하지 못했습니다." };
  }
}

// Separate from server-ownership.sqlite: the spawned server needs its own lease.
async function withOperationLock<T>(config: RoomConfig, operation: () => Promise<T>): Promise<T> {
  mkdirSync(config.dataDirectory, { recursive: true, mode: 0o700 });
  const path = join(config.dataDirectory, "cli-lifecycle.sqlite");
  const lease = new DatabaseSync(path);
  chmodSync(path, 0o600);
  const deadline = Date.now() + 10_000;
  try {
    while (true) {
      try { lease.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE"); break; }
      catch (error) {
        if ((error as { errcode?: number }).errcode !== 5 || Date.now() >= deadline) {
          throw new Error("다른 CLI 시작·중지 작업이 진행 중이거나 작업 잠금을 얻지 못했습니다.");
        }
        await pause(100);
      }
    }
    return await operation();
  } finally { lease.close(); }
}

function maintenanceLock(config: RoomConfig): () => void {
  const path = join(config.dataDirectory, "maintenance.lock");
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  const content = JSON.stringify({ at: new Date().toISOString(), reason: "restart_room", pid: process.pid, mode: "idle-restart", owner: "public-cli" });
  writeFileSync(temporary, content, { flag: "wx", mode: 0o600 });
  try {
    try { linkSync(temporary, path); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !recoverExpiredCliLock(path)) throw error;
      // Called only under cli-lifecycle.sqlite. Retry exclusive publication once;
      // a newly published foreign lock must still win over this operation.
      linkSync(temporary, path);
    }
  }
  catch { throw new Error("다른 유지보수 잠금이 있습니다. 소유자가 해제한 뒤 다시 시도하세요."); }
  finally { unlinkSync(temporary); }
  return () => {
    try { if (readFileSync(path, "utf8") === content) unlinkSync(path); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  };
}

function recoverExpiredCliLock(path: string): boolean {
  try {
    const before = lstatSync(path);
    if (!before.isFile() || before.size > 16_384 || (before.mode & 0o077) !== 0 ||
        (process.getuid && before.uid !== process.getuid())) return false;
    const content = readFileSync(path, "utf8");
    const info = JSON.parse(content) as { at?: unknown; reason?: unknown; pid?: unknown; mode?: unknown; owner?: unknown } | null;
    if (!info || info.owner !== "public-cli" || info.reason !== "restart_room" || info.mode !== "idle-restart" ||
        typeof info.at !== "string" || typeof info.pid !== "number" || !Number.isInteger(info.pid) || info.pid <= 1) return false;
    const at = Date.parse(info.at);
    if (!Number.isFinite(at) || new Date(at).toISOString() !== info.at || Date.now() - at <= 60 * 60_000) return false;
    try { process.kill(info.pid, 0); return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
    const currentContent = readFileSync(path, "utf8");
    const latest = lstatSync(path);
    if (!latest.isFile() || latest.dev !== before.dev || latest.ino !== before.ino || latest.size !== before.size ||
        latest.mtimeMs !== before.mtimeMs || latest.ctimeMs !== before.ctimeMs ||
        currentContent !== content) return false;
    unlinkSync(path);
    return true;
  } catch { return false; }
}

async function assertIdle(config: RoomConfig, connection: ReturnType<typeof readLaunchConnection>): Promise<void> {
  const topics = await request(connection, "/api/topics");
  if (!Array.isArray(topics)) throw new Error("서버 작업 목록의 형식을 확인할 수 없습니다.");
  for (const topic of topics) {
    if (!topic || typeof topic.id !== "string" || !topic.id) throw new Error("토픽 식별자를 확인할 수 없습니다.");
    const info = await request(connection, `/api/topics/${encodeURIComponent(topic.id)}/resume`) as Record<string, unknown> | null;
    if (!info || typeof info !== "object" || !("runningAction" in info) || !("autoRetryAt" in info) ||
        !("continuation" in info) || !("evidenceResume" in info)) throw new Error("토픽 작업 상태의 형식을 확인할 수 없습니다.");
    const continuation = info.continuation as { status?: unknown } | null;
    // Pending continuation intent survives graceful shutdown. A running step does not
    // qualify as idle even if it is between action admissions. Due retries can be
    // consumed by the maintenance guard, so require those to be resolved first.
    if (info.runningAction !== null || info.autoRetryAt !== null || info.evidenceResume !== null ||
        (continuation !== null && !["pending", "blocked", "awaiting-approval", "cancelled", "complete"].includes(String(continuation.status)))) {
      throw new Error("실행 중이거나 예약된 작업이 있습니다. 토픽에서 작업 상태를 정리한 뒤 다시 시도하세요.");
    }
  }
  // A final authenticated collection probe also catches shutdown/recovery failures.
  await request(connection, "/api/topics");
  const owner = ownership(config);
  if (owner.state !== "owned") throw new Error("작업 확인 중 서버 프로세스 신원을 확인할 수 없게 됐습니다.");
}

async function waitForExit(pid: number, identity: ProcessIdentity): Promise<void> {
  const deadline = Date.now() + operationTimeout;
  let identityUnconfirmed = false;
  while (alive(pid)) {
    const observed = systemProcessControl.inspect(pid);
    // This function only observes after the one identity-checked SIGTERM. ps can
    // become incomplete or show a defunct command while the process exits. Never
    // signal again; wait boundedly for ESRCH even if the identity changes. A reused
    // or uninspectable PID that remains alive is still a timeout, never success.
    if (!observed || !sameIdentity(identity, observed)) identityUnconfirmed = true;
    if (Date.now() >= deadline) {
      throw new Error("서버의 정상 종료를 확인하지 못했습니다. 강제 종료하지 않았습니다." +
        (identityUnconfirmed ? " 종료 대기 중 프로세스 신원이 바뀌거나 확인되지 않았습니다." : ""));
    }
    await pause(100);
  }
}

async function stopOwned(config: RoomConfig): Promise<void> {
  const owner = ownership(config);
  if (owner.state === "stopped") return;
  if (owner.state !== "owned") throw new Error(owner.detail);
  const connection = readLaunchConnection(config);
  // Refuse existing scheduled work before publishing a lock that could consume a due retry.
  await assertIdle(config, connection);
  const release = maintenanceLock(config);
  try {
    await assertIdle(config, connection);
    const latest = ownership(config);
    if (latest.state !== "owned" || latest.record.pid !== owner.record.pid || !sameIdentity(latest.record, owner.record)) {
      throw new Error("종료 직전 서버 프로세스 신원이 바뀌었습니다.");
    }
    // Only this exact server PID. Never signal a process group or a port owner.
    try { process.kill(latest.record.pid, "SIGTERM"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw new Error("서버에 정상 종료 신호를 보내지 못했습니다."); }
    await waitForExit(latest.record.pid, latest.record);
  } finally { release(); }
}

async function buildCandidate(config: RoomConfig): Promise<string> {
  const webDirectory = join(config.dataDirectory, "web-dist", `${Date.now()}-${randomUUID()}`);
  mkdirSync(webDirectory, { recursive: true, mode: 0o700 });
  const options = { cwd: sourceRoot, env: { ...process.env, CONSENSUS_ROOM_TOKEN: undefined }, timeout: 180_000, maxBuffer: 8 * 1024 * 1024 };
  try { await runFile("npm", ["run", "typecheck"], options); }
  catch (error) { throw buildFailure(config, "typecheck", error); }
  // Vite's publicDir is disabled explicitly: an export tree must never be recursively
  // copied into a candidate that may itself live under the configured data directory.
  try {
    await runFile(process.execPath, ["--input-type=module", "--eval",
      "const {build}=await import('vite');await build({publicDir:false,build:{outDir:process.env.CONSENSUS_ROOM_CANDIDATE_WEB_DIR,emptyOutDir:true}});"],
    { ...options, env: { ...options.env, CONSENSUS_ROOM_CANDIDATE_WEB_DIR: webDirectory } });
    if (!lstatSync(join(webDirectory, "index.html")).isFile()) throw new Error();
  } catch (error) { throw buildFailure(config, "web", error); }
  return webDirectory;
}

function buildFailure(config: RoomConfig, stage: "typecheck" | "web", error: unknown): Error {
  const failure = error as { stdout?: unknown; stderr?: unknown; message?: unknown } | null;
  const text = [
    `stage: ${stage}`,
    `stdout:\n${failure?.stdout ?? ""}`,
    `stderr:\n${failure?.stderr ?? ""}`,
    `error:\n${failure?.message ?? "후보 출력 파일을 확인하지 못했습니다."}`,
  ].join("\n");
  // Preserve diagnostics, but never archive known inherited credentials or the
  // running room's token, including when a tool echoes just the raw value.
  const secrets = Object.entries(process.env).filter(([key, value]) =>
    value && /(?:_KEY|_TOKEN|_SECRET|_PASSWORD|_PASSWD|_CREDENTIALS?)$/.test(key)).map(([, value]) => value!);
  try { secrets.push(readLaunchConnection(config).token); } catch { /* No readable launch token before the first start. */ }
  let safe = redactSecrets(text);
  for (const secret of secrets) safe = safe.split(secret).join("[redacted]");
  const logs = join(config.dataDirectory, "build-logs");
  const log = join(logs, `${Date.now()}-${randomUUID()}-${stage}.log`);
  const message = `후보 ${stage === "typecheck" ? "서버 typecheck" : "웹 빌드"}에 실패했습니다. 기존 서버는 유지했습니다.`;
  try {
    mkdirSync(logs, { recursive: true, mode: 0o700 });
    writeFileSync(log, safe, { flag: "wx", mode: 0o600 });
    return new Error(`${message} 비공개 빌드 로그: ${log}`);
  } catch { return new Error(`${message} 비공개 빌드 로그를 저장하지 못했습니다.`); }
}

// A detached server cannot depend on its parent's pipe for logging. Redaction is
// installed inside the child before importing the server, which prints its launch
// URL. Buffer complete lines so split writes cannot expose a partial token.
const launchBootstrap = `
const secret=process.env.CONSENSUS_ROOM_TOKEN;
for(const stream of [process.stdout,process.stderr]){
 const write=stream.write.bind(stream);let pending='';
 const emit=value=>write(secret?value.split(secret).join('[redacted]'):value);
 stream.write=(chunk,encoding,callback)=>{pending+=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk);let end;
  while((end=pending.indexOf('\\n'))!==-1){emit(pending.slice(0,end+1));pending=pending.slice(end+1);}
  const done=typeof encoding==='function'?encoding:callback;if(done)queueMicrotask(done);return true;};
 process.once('exit',()=>{if(pending)emit(pending);});
}
await import(process.env.CONSENSUS_ROOM_SERVER_ENTRY);
`;

async function launch(config: RoomConfig, webDirectory: string): Promise<RoomStatus> {
  const token = randomBytes(32).toString("hex");
  const logs = join(config.dataDirectory, "server-logs");
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const log = join(logs, `${Date.now()}-${randomUUID()}.log`);
  const descriptor = openSync(log, "wx", 0o600);
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", launchBootstrap], {
      cwd: sourceRoot, detached: true, stdio: ["ignore", descriptor, descriptor],
      env: { ...roomEnvironment(config), CONSENSUS_ROOM_TOKEN: token, CONSENSUS_ROOM_WEB_DIR: webDirectory,
        CONSENSUS_ROOM_SERVER_ENTRY: pathToFileURL(join(sourceRoot, "src", "server", "index.ts")).href },
    });
  } finally { closeSync(descriptor); }
  let exited = false;
  let launchError = false;
  child.once("exit", () => { exited = true; });
  child.on("error", () => { launchError = true; });
  let identity: ProcessIdentity | null = null;
  try {
    await new Promise<void>((done, fail) => {
      child.once("spawn", done);
      child.once("error", () => fail(new Error("서버 프로세스를 시작하지 못했습니다.")));
    });
    if (!child.pid || !(identity = systemProcessControl.inspect(child.pid))) throw new Error("시작한 프로세스 신원을 확인하지 못했습니다.");
    const deadline = Date.now() + operationTimeout;
    while (Date.now() < deadline) {
      if (exited || launchError) throw new Error("서버가 준비되기 전에 종료됐습니다.");
      const owner = ownership(config);
      if (owner.state === "owned" && owner.record.pid === child.pid && sameIdentity(owner.record, identity)) {
        const connection = readLaunchConnection(config);
        if (connection.token !== token) throw new Error("시작한 서버의 인증 기록이 일치하지 않습니다.");
        const status = await roomStatus(config);
        if (status.state === "running") { child.unref(); return status; }
      }
      await pause(100);
    }
    throw new Error("서버 준비 상태를 제한 시간 안에 확인하지 못했습니다.");
  } catch (error) {
    if (!exited && child.pid) {
      const observed = systemProcessControl.inspect(child.pid);
      if (!identity || !observed || !sameIdentity(identity, observed)) {
        child.unref();
        throw new Error(`서버 시작 실패 후 자식 신원을 확인하지 못해 종료하지 않았습니다. 비공개 로그: ${log}`);
      }
      try { process.kill(child.pid, "SIGTERM"); await waitForExit(child.pid, identity); }
      catch { child.unref(); throw new Error(`서버 시작 실패 후 정상 종료를 확인하지 못했습니다. 비공개 로그: ${log}`); }
    }
    throw new Error(`${error instanceof Error ? error.message : "서버 시작에 실패했습니다."} 비공개 로그: ${log}`);
  }
}

export async function startRoom(config: RoomConfig): Promise<RoomStatus> {
  return withOperationLock(config, async () => {
    const status = await roomStatus(config);
    if (status.state === "running") return status;
    if (status.state !== "stopped") throw new Error(status.detail);
    const candidate = await buildCandidate(config);
    const latest = ownership(config);
    if (latest.state !== "stopped") throw new Error("빌드 중 다른 서버가 시작됐거나 소유권을 확인할 수 없게 됐습니다.");
    return launch(config, candidate);
  });
}

export async function stopRoom(config: RoomConfig): Promise<void> {
  return withOperationLock(config, () => stopOwned(config));
}

export async function restartRoom(config: RoomConfig): Promise<RoomStatus> {
  return withOperationLock(config, async () => {
    const owner = ownership(config);
    if (owner.state === "unknown") throw new Error(owner.detail);
    const candidate = await buildCandidate(config);
    await stopOwned(config);
    return launch(config, candidate);
  });
}

export async function openRoom(config: RoomConfig): Promise<void> {
  const status = await roomStatus(config);
  if (status.state !== "running") throw new Error(status.detail || "실행 중인 서버가 없습니다.");
  const connection = readLaunchConnection(config);
  const url = `${connection.baseURL}/?token=${encodeURIComponent(connection.token)}`;
  const program = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  try { await runFile(program, args, { timeout: 10_000 }); }
  catch { throw new Error("브라우저 열기 요청에 실패했습니다."); }
}
