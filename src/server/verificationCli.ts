import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rename, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { executeVerification } from "./verificationRunner.js";
import { STATIC_PROFILE_ID, STATIC_SCRIPT_SHA256, staticProfileSchema } from "./verificationInputs.js";
import type { PreparedVerification, VerificationCompletion, VerificationRun } from "./verifications.js";

type Request = <T>(path: string, body?: unknown, key?: string) => Promise<T>;

export async function runMediatorVerification(topicId: string, request: Request, pendingDirectory: string, signal?: AbortSignal) {
  const base = `/api/topics/${encodeURIComponent(topicId)}/verifications`;
  let prepared: PreparedVerification;
  while (true) {
    if (signal?.aborted) throw new Error("검사 대기가 취소되었습니다.");
    prepared = await request<PreparedVerification>(`${base}/prepare`, {}, randomUUID());
    if (prepared.disposition !== "busy") break;
    const deadline = Date.now() + 95_000;
    while (Date.now() < deadline) {
      await wait(300, signal);
      const runs = await request<VerificationRun[]>(base);
      const current = runs.find((run) => run.id === prepared.run.id);
      if (!current) throw new Error("대기 중인 검사 기록이 사라졌습니다.");
      if (current.status === "running") continue;
      if (current.status !== "succeeded") return { reused: false, run: current };
      break;
    }
  }
  if (prepared.disposition === "reused") return { reused: true, run: prepared.run };
  if (!prepared.execution) throw new Error("검사 실행 명세가 없습니다.");
  const completion = await executeVerification(prepared.execution, signal);
  await mkdir(pendingDirectory, { recursive: true, mode: 0o700 });
  const path = join(pendingDirectory, `${prepared.run.id}.json`);
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify({ topicId, runId: prepared.run.id, completion }), { mode: 0o600 });
  await rename(temporary, path);
  const run = await request<VerificationRun>(`${base}/${prepared.run.id}/complete`, completion, prepared.run.id);
  await unlink(path);
  return { reused: false, run };
}

async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("검사 대기가 취소되었습니다.");
  await new Promise<void>((resolveWait, reject) => {
    const finish = () => { signal?.removeEventListener("abort", abort); resolveWait(); };
    const timer = setTimeout(finish, ms);
    const abort = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(new Error("검사 대기가 취소되었습니다.")); };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

async function installProfile(dataDirectory: string, python: string) {
  const executable = await realpath(python);
  const { stdout } = await promisify(execFile)(executable, ["-I", "-S", "-B", "-c",
    "import json,sys,sysconfig,os; print(json.dumps(dict(paths=sys.path, prefix=sys.base_prefix, framework=sysconfig.get_config_var('PYTHONFRAMEWORK') or '', shared=bool(sysconfig.get_config_var('Py_ENABLE_SHARED')), library=os.path.join(sysconfig.get_config_var('LIBDIR') or '', sysconfig.get_config_var('LDLIBRARY') or ''))))"],
  { env: { PATH: "/usr/bin:/bin", LANG: "C" }, maxBuffer: 100_000 });
  const runtime = z.object({ paths: z.array(z.string()), prefix: z.string(), framework: z.string(), shared: z.boolean(), library: z.string() })
    .parse(JSON.parse(stdout));
  const libraries = [...runtime.paths, runtime.library].filter((path) => path.startsWith("/"));
  if (runtime.framework) {
    // macOS의 bin/python은 launcher일 수 있다. 실제 framework와 Python.app도 함께 묶는다.
    const prefixes = [...new Set([dirname(dirname(executable)), runtime.prefix])];
    const cores = prefixes.map((prefix) => join(prefix, runtime.framework));
    const present = await Promise.all(cores.map(async (path) => (await stat(path).catch(() => null))?.isFile() ?? false));
    if (!present.some(Boolean)) throw new Error("Python 프레임워크 실행 코어를 찾을 수 없습니다.");
    libraries.push(...cores, ...prefixes.flatMap((prefix) => [
      join(prefix, "Resources/Python.app/Contents/MacOS/Python"), join(prefix, "Resources/Python.app/Contents/Info.plist"),
    ]));
  } else if (runtime.shared && !(await stat(runtime.library).catch(() => null))?.isFile()) {
    throw new Error("Python 공유 라이브러리 경로를 확인할 수 없습니다.");
  }
  for (const directory of [dirname(executable), dirname(dirname(executable))]) {
    libraries.push(join(directory, "pyvenv.cfg"), join(directory, "python._pth"), join(directory, `${basename(executable)}._pth`));
  }
  const profile = staticProfileSchema.parse({ id: STATIC_PROFILE_ID, version: 1, scriptSHA256: STATIC_SCRIPT_SHA256,
    bash: await realpath("/bin/bash"), python: executable, pythonLibraries: [...new Set(libraries)].sort() });
  const directory = join(dataDirectory, "verification-profiles");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, `${STATIC_PROFILE_ID}.json`), JSON.stringify(profile, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  process.stdout.write(`정적 검사 프로필을 등록했습니다: ${STATIC_PROFILE_ID}\n`);
}

async function main() {
  const { values } = parseArgs({ options: {
    "data-dir": { type: "string" }, topic: { type: "string" }, complete: { type: "string" },
    "install-profile": { type: "boolean" }, python: { type: "string" },
  } });
  const dataDirectory = resolve(values["data-dir"] ?? process.env.CONSENSUS_ROOM_DATA_DIR ??
    join(homedir(), "Library", "Application Support", "ConsensusRoom"));
  if (values["install-profile"]) {
    if (!values.python) throw new Error("--python에 Python 실행 파일의 절대 경로를 지정하세요.");
    return installProfile(dataDirectory, values.python);
  }
  const launch = new URL((await readFile(join(dataDirectory, "consensus-room.url"), "utf8")).trim());
  if (launch.protocol !== "http:" || launch.hostname !== "127.0.0.1" || launch.username || launch.password) {
    throw new Error("로컬 Consensus Room 시작 URL이 필요합니다.");
  }
  const token = launch.searchParams.get("token");
  if (!token) throw new Error("시작 URL에 인증 토큰이 없습니다.");
  const request: Request = async <T>(path: string, body?: unknown, key?: string): Promise<T> => {
    const response = await fetch(`${launch.origin}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(120_000),
      headers: { "x-consensus-token": token, ...(body === undefined ? {} : { "content-type": "application/json", "idempotency-key": key! }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`검사 API 요청 실패 (${response.status}). 완료 등록 실패 시 --complete로 같은 실행을 재등록하세요.`);
    return await response.json() as T;
  };
  const pending = join(dataDirectory, "verification-pending");
  if (values.complete) {
    const runId = z.string().uuid().parse(values.complete);
    const path = join(pending, `${runId}.json`);
    const saved = JSON.parse(await readFile(path, "utf8")) as { topicId: string; runId: string; completion: VerificationCompletion };
    if (saved.runId !== runId) throw new Error("보류 중인 실행 ID가 다릅니다.");
    // HTTP 실패 원장은 같은 키를 재실행하지 않는다. 실행 ID와 본문은 유지하고 등록 요청 키만 새로 만든다.
    const run = await request<VerificationRun>(`/api/topics/${encodeURIComponent(saved.topicId)}/verifications/${runId}/complete`, saved.completion, randomUUID());
    await unlink(path);
    process.stdout.write(`${JSON.stringify({ runId, status: run.status })}\n`);
    process.exitCode = run.status === "succeeded" ? 0 : 1;
    return;
  }
  if (!values.topic) throw new Error("--topic에 주제 ID를 지정하세요.");
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const result = await runMediatorVerification(values.topic, request, pending, controller.signal);
    process.stdout.write(`${JSON.stringify({ runId: result.run.id, status: result.run.status, reused: result.reused, durationMs: result.run.durationMs })}\n`);
    process.exitCode = result.run.status === "succeeded" ? 0 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => { process.stderr.write(`${error instanceof Error ? error.message : "검사 CLI 실패"}\n`); process.exitCode = 1; });
}
