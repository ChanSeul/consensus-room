import { spawn } from "node:child_process";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentEnvironment } from "../security.js";
import { createTailBuffer } from "../processRunner.js";
import { redactSecrets } from "../../shared/workflow.js";
const LIMIT = 32 * 1024 * 1024;

// Transport only: callers cannot start a model turn or invoke unlisted tools.
export async function nativeApps(command: string, authPath: string, cwd: string,
  apps: Record<string, readonly string[]>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const home = await mkdtemp(join(tmpdir(), "consensus-app-reader-"));
  const calls = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  let sequence = 0, failure: unknown;
  try {
    await symlink(authPath, join(home, "auth.json"));
    await writeFile(join(home, "config.toml"), [
    'approval_policy = "never"', 'web_search = "disabled"', "[features]", "plugins = false", "memories = false", "hooks = false",
    "[apps._default]", "enabled = false", ...Object.entries(apps).flatMap(([id, names]) => [
      `[apps.${id}]`, "enabled = true", "default_tools_enabled = false", "destructive_enabled = false",
      ...names.flatMap(name => [`[apps.${id}.tools.${JSON.stringify(name)}]`, "enabled = true"]),
    ]), "",
    ].join("\n"), { mode: 0o600 });
  } catch (error) { await rm(home, { recursive: true, force: true }); throw error; }
  const child = spawn(command, ["app-server", "--strict-config", "--stdio"], {
    cwd, detached: true, stdio: ["pipe", "pipe", "pipe"],
    env: agentEnvironment({ CODEX_HOME: home }),
  });
  // 연결이 응답 전에 끊기면 사유(dyld·인증·설정 오류)는 stderr 에만 있다 — 꼬리를 남겨 종료 오류에 싣는다.
  const stderr = createTailBuffer(4096);
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => stderr.push(chunk));
  const stderrClosed = new Promise<void>(resolve => { if (child.stderr) child.stderr.once("close", () => resolve()); else resolve(); });
  const rejectCalls = (reason = new Error("앱 연결이 종료됐습니다.")) => { for (const call of calls.values()) { clearTimeout(call.timer); call.reject(reason); } calls.clear(); };
  let ended = false;
  const end = (error?: unknown) => {
    ended = true;
    if (error instanceof Error) failure ??= error;
    rejectCalls(failure instanceof Error ? failure : undefined);
  };
  child.once("error", end);
  child.once("exit", (code, exitSignal) => {
    ended = true;
    // exit 시점에는 stderr 파이프가 아직 열려 있을 수 있다. 닫힐 때까지(손자 프로세스가 붙잡으면 길어야 1초) 기다린 뒤 대기 호출을 사유와 함께 거부한다.
    void Promise.race([stderrClosed, new Promise(resolve => setTimeout(resolve, 1000).unref())]).then(() => {
      const tail = stderr.join().trim();
      failure ??= new Error(redactSecrets(`앱 연결이 종료됐습니다(${exitSignal ?? `exit ${code}`})${tail ? `: ${tail}` : "."}`));
      rejectCalls(failure as Error);
    });
  });
  child.stdin?.on("error", error => { failure ??= error; rejectCalls(error); });
  const receive = (line: Buffer) => {
    try {
      if (Buffer.byteLength(line) > LIMIT) throw Error("MCP 응답이 32 MiB를 넘었습니다. 수집 범위를 더 작게 나누세요.");
      const message = JSON.parse(line.toString("utf8"));
      // An unexpected interactive/auth request is not approved by this bridge.
      if (message.method && message.id !== undefined) {
        child.stdin!.write(JSON.stringify({ id: message.id, error: { code: -32601, message: "Interactive requests are unavailable in the read-only app bridge." } }) + "\n");
        return;
      }
      const call = calls.get(message.id); if (!call) return;
      calls.delete(message.id); clearTimeout(call.timer);
      if (message.error) call.reject(new Error("공식 앱 연결을 확인하세요.")); else call.resolve(message.result);
    } catch (error) { failure ??= error instanceof SyntaxError ? new Error("MCP 응답이 JSON 형식이 아닙니다.") : error; rejectCalls(failure as Error); }
  };
  // JSONL is delimited by LF bytes. Unicode line/paragraph separators inside JSON strings are source content.
  let pending = Buffer.alloc(0);
  const onData = (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    let end: number;
    while ((end = pending.indexOf(10)) !== -1) {
      receive(pending.subarray(0, end));
      pending = pending.subarray(end + 1);
    }
    if (pending.length > LIMIT) {
      failure ??= new Error("MCP 응답이 32 MiB를 넘었습니다. 수집 범위를 더 작게 나누세요.");
      pending = Buffer.alloc(0); rejectCalls(failure as Error);
    }
  };
  child.stdout?.on("data", onData);
  const rpc = (method: string, params: unknown): Promise<any> => new Promise((resolve, reject) => {
    if (ended || failure || signal?.aborted) { reject(failure ?? Error("앱 연결이 종료됐습니다.")); return; }
    if (!child.stdin) { child.once("error", reject); return; }
    const id = ++sequence;
    const timer = setTimeout(() => { calls.delete(id); reject(Error("앱 연결 응답 시간이 지났습니다.")); }, 120_000);
    calls.set(id, { resolve, reject, timer });
    child.stdin!.write(JSON.stringify({ id, method, params }) + "\n", error => {
      if (error) { calls.delete(id); clearTimeout(timer); reject(error); }
    });
  });
  let stopping: Promise<void> | undefined;
  const stop = () => stopping ??= (async () => {
    signal?.removeEventListener("abort", abort);
    child.stdout?.removeListener("data", onData); rejectCalls();
    if (child.pid && !ended) {
      await new Promise<void>(resolve => {
        const timer = setTimeout(() => { try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ } }, 2000);
        child.once("exit", () => { clearTimeout(timer); resolve(); });
        try { process.kill(-child.pid!, "SIGTERM"); } catch { clearTimeout(timer); resolve(); }
      });
    }
    await rm(home, { recursive: true, force: true });
  })();
  const abort = () => { failure ??= Error("앱 연결이 취소됐습니다."); void stop(); };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) throw Error("앱 연결이 취소됐습니다.");
    await rpc("initialize", { clientInfo: { name: "consensus-app-reader", version: "1.0" }, capabilities: { experimentalApi: true } });
    child.stdin!.write('{"method":"initialized"}\n');
    const { thread } = await rpc("thread/start", { cwd, ephemeral: true, approvalPolicy: "never", sandbox: "read-only",
      baseInstructions: "Read-only app transport. No model turn is started." });
    const installed = await rpc("app/installed", { threadId: thread.id, forceRefresh: true });
    if (!Object.keys(apps).every(id => installed.apps?.some((app: any) => app.id === id && app.enabled && app.callable))) throw Error("공식 앱이 연결되지 않았습니다. 앱에서 연결을 확인하세요.");
    const inventory = await rpc("mcpServerStatus/list", { threadId: thread.id, serverName: "codex_apps", detail: "toolsAndAuthOnly", limit: 100 });
    const available = inventory.data?.find((entry: any) => entry.name === "codex_apps")?.tools ?? {};
    const allowed = new Set(Object.values(apps).flat());
    const tools = [...allowed].flatMap(name => {
      const tool = available[name];
      return tool?.annotations?.readOnlyHint === true ? [{ ...tool, name }] : [];
    });
    return { tools, async call(name: string, args: Record<string, unknown>) {
      if (!tools.some(tool => tool.name === name)) throw Error("허용된 읽기 도구가 없습니다: " + name);
      if (failure) throw failure;
      return rpc("mcpServer/tool/call", { threadId: thread.id, server: "codex_apps", tool: name, arguments: args });
    }, close: stop };
  } catch (error) { await stop(); throw error; }
}
