import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactStore } from "../src/server/artifacts";
import { buildApp } from "../src/server/app";
import { loadConfig } from "../src/server/config";
import { ConsensusDatabase } from "../src/server/database";
import { runMediatorVerification } from "../src/server/verificationCli";
import { executeVerification } from "../src/server/verificationRunner";
import { collectStaticInputs, inputSHA, STATIC_PROFILE_ID, STATIC_SCRIPT, STATIC_SCRIPT_SHA256, toolSHA } from "../src/server/verificationInputs";
import { VerificationService, type VerificationCompletion } from "../src/server/verifications";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const pythonRuntime = JSON.parse(execFileSync("python3", ["-I", "-S", "-B", "-c",
  "import sys,sysconfig,json; print(json.dumps(dict(executable=sys.executable,prefix=sys.base_prefix,framework=sysconfig.get_config_var('PYTHONFRAMEWORK') or '',version='%d.%d'%sys.version_info[:2])))"],
{ encoding: "utf8" })) as { executable: string; prefix: string; framework: string; version: string };
const python = pythonRuntime.executable;
const success: VerificationCompletion = { status: "succeeded", exitCode: 0, durationMs: 1, stdout: "", stderr: "" };

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "consensus-verification-"));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  const worktree = join(root, "worktree");
  const data = join(root, "data");
  for (const path of ["Modules", "SampleApp", "ci"]) await mkdir(join(worktree, path), { recursive: true });
  await writeFile(join(worktree, STATIC_SCRIPT), await readFile(join(import.meta.dirname, "fixtures/swift-concurrency-policy.sh")));
  await writeFile(join(worktree, "Modules/Feature.swift"), "func feature() {}\n");
  await writeFile(join(worktree, ".gitignore"), "*.swift\n");
  const library = join(root, "declared-runtime");
  await mkdir(library);
  await writeFile(join(library, "dependency"), "runtime-v1");
  await mkdir(join(data, "verification-profiles"), { recursive: true });
  await writeFile(join(data, "verification-profiles", `${STATIC_PROFILE_ID}.json`), JSON.stringify({
    id: STATIC_PROFILE_ID, version: 1, scriptSHA256: STATIC_SCRIPT_SHA256, bash: "/bin/bash", python,
    pythonLibraries: [library],
  }));
  const database = new ConsensusDatabase(join(data, "room.sqlite"));
  let dbClosed = false;
  cleanup.push(async () => { if (!dbClosed) database.close(); });
  database.createTopic({ id: "topic-1", slug: "static", title: "정적 검사", repositoryPath: worktree,
    worktreePath: worktree, baseRef: "HEAD", branchName: null, state: "IMPLEMENTING", scopeGeneration: 1,
    planRevision: 1, planSHA256: "a".repeat(64), approvedPlanSHA256: "a".repeat(64),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), lastError: null });
  const artifacts = new ArtifactStore(join(data, "topics"), database);
  let clock = Date.now();
  const service = new VerificationService(database, artifacts, data, () => clock);
  return { root, data, worktree, library, database, artifacts, service, advance: (ms: number) => { clock += ms; },
    markClosed: () => { dbClosed = true; } };
}

describe("정적 검사 실행 기록", () => {
  it("실제 중재자 프로세스가 복사본을 검사하고 같은 입력의 성공만 DB 재연결 뒤 재사용한다", async () => {
    const f = await fixture();
    const prepared = await f.service.prepare("topic-1");
    expect(prepared.disposition).toBe("run");
    expect(prepared.execution!.cwd).not.toBe(f.worktree);
    const output = await executeVerification(prepared.execution!);
    expect(output.status).toBe("succeeded");
    const completed = await f.service.complete("topic-1", prepared.run.id, output);
    expect(completed.status).toBe("succeeded");
    const reopened = new ConsensusDatabase(join(f.data, "room.sqlite"));
    try {
      const service = new VerificationService(reopened, new ArtifactStore(join(f.data, "topics"), reopened), f.data);
      expect((await service.prepare("topic-1")).disposition).toBe("reused");
      expect((await service.receipts("topic-1")).text).toContain(completed.id);
    } finally { reopened.close(); }
    expect(f.database.getTopic("topic-1").state).toBe("IMPLEMENTING");
    expect(f.database.getPromptTimeline("topic-1", 1)).toEqual([]);
    await writeFile(join(f.worktree, "Modules/Ignored.swift"), "let value = try? await operation()\n");
    expect((await f.service.prepare("topic-1")).disposition).toBe("run");
  });

  it("중복 prepare는 단일 실행을 공유하고 중재자 프로세스 실패는 캐시되지 않는다", async () => {
    const f = await fixture();
    await writeFile(join(f.worktree, "SampleApp/Bad.swift"), "try? await operation()\n");
    const [first, second] = await Promise.all([f.service.prepare("topic-1"), f.service.prepare("topic-1")]);
    expect([first.disposition, second.disposition]).toEqual(["run", "busy"]);
    expect(first.run.id).toBe(second.run.id);
    const output = await executeVerification(first.execution!);
    expect(output).toMatchObject({ status: "failed", exitCode: 1 });
    expect(output.stderr).toContain("Bad.swift:1");
    await f.service.complete("topic-1", first.run.id, output);
    expect((await f.service.prepare("topic-1")).disposition).toBe("run");
  });

  it.each(["source", "snapshot", "tool", "scope", "approval"])("실행 중 %s 변경은 성공 등록을 재사용하지 못하게 한다", async (change) => {
    const f = await fixture();
    const prepared = await f.service.prepare("topic-1");
    if (change === "source") await writeFile(join(f.worktree, "Modules/Feature.swift"), "changed");
    if (change === "snapshot") await writeFile(join(prepared.execution!.cwd, "Modules/Feature.swift"), "changed");
    if (change === "tool") await writeFile(join(f.library, "dependency"), "runtime-v2");
    if (change === "scope") f.database.updateTopic("topic-1", { scopeGeneration: 2 });
    if (change === "approval") f.database.updateTopic("topic-1", { approvedPlanSHA256: null });
    expect((await f.service.complete("topic-1", prepared.run.id, success)).status).toBe("stale");
    expect((await f.service.receipts("topic-1")).text).toBe("");
  });

  it("손상된 로그·만료된 실행을 재사용하지 않고 같은 완료 요청만 재등록한다", async () => {
    const f = await fixture();
    const first = await f.service.prepare("topic-1");
    const completed = await f.service.complete("topic-1", first.run.id, success);
    expect(await f.service.complete("topic-1", first.run.id, success)).toEqual(completed);
    await expect(f.service.complete("topic-1", first.run.id, { ...success, stdout: "다른 결과" })).rejects.toThrow("다른 결과");
    const log = f.database.latestArtifact("topic-1", `verification-log-${first.run.id}`)!;
    await writeFile(log.path, "corrupt");
    const second = await f.service.prepare("topic-1");
    expect(second.disposition).toBe("run");
    f.advance(90_001);
    const third = await f.service.prepare("topic-1");
    expect(third.disposition).toBe("run");
    expect(third.run.id).not.toBe(second.run.id);
    await expect(f.service.complete("topic-1", second.run.id, success)).rejects.toThrow("이미 종료");
  });

  it("입력 루트 누락·symlink·바뀐 검사기는 빈 검사 성공으로 처리하지 않는다", async () => {
    const f = await fixture();
    const before = inputSHA(await collectStaticInputs(f.worktree));
    await writeFile(join(f.worktree, "Modules/Feature.swift"), "new");
    expect(inputSHA(await collectStaticInputs(f.worktree))).not.toBe(before);
    await symlink(join(f.worktree, "Modules/Feature.swift"), join(f.worktree, "Modules/Link.swift"));
    await expect(f.service.prepare("topic-1")).rejects.toThrow("symlink");
    await rm(join(f.worktree, "Modules/Link.swift"));
    await rm(join(f.worktree, "SampleApp"), { recursive: true });
    await expect(f.service.prepare("topic-1")).rejects.toThrow();
    await mkdir(join(f.worktree, "SampleApp"));
    await mkdir(join(f.worktree, "Modules/Empty.swift"));
    await expect(f.service.prepare("topic-1")).rejects.toThrow("일반 파일");
    await rm(join(f.worktree, "Modules/Empty.swift"), { recursive: true });
    await writeFile(join(f.worktree, STATIC_SCRIPT), "exit 0");
    await expect(f.service.prepare("topic-1")).rejects.toThrow("별도 검토");
  });

  it.each(["changed-input", "unapproved-restart"])("%s에서도 만료된 실행과 복사본을 정리한다", async (scenario) => {
    const f = await fixture();
    const first = await f.service.prepare("topic-1");
    f.advance(90_001);
    if (scenario === "changed-input") {
      await writeFile(join(f.worktree, "Modules/Feature.swift"), "changed");
      expect((await f.service.prepare("topic-1")).disposition).toBe("run");
    } else {
      f.database.updateTopic("topic-1", { approvedPlanSHA256: null });
      const reopened = new ConsensusDatabase(join(f.data, "room.sqlite"));
      try {
        await new VerificationService(reopened, new ArtifactStore(join(f.data, "topics"), reopened), f.data,
          () => first.run.startedAt + 90_001).recoverExpired();
      } finally { reopened.close(); }
    }
    expect(f.service.list("topic-1").find((run) => run.id === first.run.id)?.status).toBe("timed_out");
    await expect(stat(first.execution!.cwd)).rejects.toThrow();
  });

  it("CLI→인증 API→SQLite에서 완료 응답 유실을 같은 run ID로 복구한다", async () => {
    const f = await fixture();
    const unused = async () => { throw new Error("서버가 검사를 실행하면 안 됩니다."); };
    const app = await buildApp({ database: f.database,
      config: loadConfig({ dataDirectory: f.data, databasePath: join(f.data, "room.sqlite"),
        topicsDirectory: join(f.data, "topics"), worktreesDirectory: join(f.root, "worktrees"),
        webDirectory: join(f.root, "no-web"), repositoryPath: f.worktree, launchToken: "test-token" }),
      runner: { run: unused },
      claude: { role: "claude", createSession: unused, resumeTurn: unused, validateExistingSession: unused },
      codex: { role: "codex", createSession: unused, resumeTurn: unused, validateExistingSession: unused },
    });
    cleanup.push(async () => { await app.close(); f.markClosed(); });
    expect((await app.inject({ method: "POST", url: "/api/topics/topic-1/verifications/prepare", payload: {} })).statusCode).toBe(401);
    const headers = { "x-consensus-token": "test-token", "idempotency-key": "invalid-command" };
    expect((await app.inject({ method: "POST", url: "/api/topics/topic-1/verifications/prepare", headers, payload: { command: "false" } })).statusCode).toBe(400);
    let loseResponse = true;
    const request = async <T>(path: string, body?: unknown, key?: string): Promise<T> => {
      const response = await app.inject({ method: body === undefined ? "GET" : "POST", url: path,
        headers: { "x-consensus-token": "test-token", "idempotency-key": key ?? "unused" }, payload: body as object });
      expect(response.statusCode).toBe(200);
      if (path.endsWith("/complete") && loseResponse) { loseResponse = false; throw new Error("response lost"); }
      return response.json() as T;
    };
    const pending = join(f.data, "verification-pending");
    await expect(runMediatorVerification("topic-1", request, pending)).rejects.toThrow("response lost");
    const run = f.service.list("topic-1")[0];
    const saved = JSON.parse(await readFile(join(pending, `${run.id}.json`), "utf8"));
    expect((await request<{ id: string }>(`/api/topics/topic-1/verifications/${run.id}/complete`, saved.completion, run.id)).id).toBe(run.id);
    const result = await runMediatorVerification("topic-1", request, pending);
    expect(result.reused).toBe(true);
    expect(f.service.list("topic-1")).toHaveLength(1);
    // 실제 CLI 진입점·시작 URL 읽기·프로필 등록·HTTP 왕복까지 별도 프로세스로 확인한다.
    const address = await app.listen({ host: "127.0.0.1", port: 0 });
    await writeFile(join(f.data, "consensus-room.url"), `${address}/?token=test-token`);
    const cli = (...args: string[]) => promisify(execFile)(process.execPath,
      ["--import", "tsx", join(import.meta.dirname, "../src/server/verificationCli.ts"), "--data-dir", f.data, ...args],
      { cwd: join(import.meta.dirname, ".."), timeout: 25_000 });
    await cli("--complete", run.id);
    await expect(readFile(join(pending, `${run.id}.json`))).rejects.toThrow();
    await writeFile(join(f.worktree, "Modules/Feature.swift"), "// new input\n");
    const addArtifact = f.database.addArtifact.bind(f.database);
    let failOnce = true;
    f.database.addArtifact = (...args: Parameters<ConsensusDatabase["addArtifact"]>) => {
      if (failOnce && args[1].kind.startsWith("verification-log-")) { failOnce = false; throw new Error("transient storage failure"); }
      return addArtifact(...args);
    };
    await expect(cli("--topic", "topic-1")).rejects.toThrow();
    const pendingRun = f.service.list("topic-1")[0];
    expect(pendingRun.status).toBe("running");
    expect(JSON.parse((await cli("--complete", pendingRun.id)).stdout)).toMatchObject({ runId: pendingRun.id, status: "succeeded" });
    await rm(join(f.data, "verification-profiles", `${STATIC_PROFILE_ID}.json`));
    await cli("--install-profile", "--python", python);
    expect(JSON.parse((await cli("--topic", "topic-1")).stdout)).toMatchObject({ status: "succeeded", reused: false });
    expect(JSON.parse((await cli("--topic", "topic-1")).stdout)).toMatchObject({ status: "succeeded", reused: true });
  }, 30_000);
});

describe("중재자 검사 프로세스 종료", () => {
  it("시간 초과와 이미 취소된 요청은 성공하지 않는다", async () => {
    const command = { command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: tmpdir(), environment: {}, timeoutMs: 30 };
    expect((await executeVerification(command)).status).toBe("timed_out");
    expect((await executeVerification(command, AbortSignal.abort())).status).toBe("cancelled");
  });
  it("출력 한도를 넘으면 종료 코드가 0이어도 성공하지 않는다", async () => {
    const output = await executeVerification({ command: process.execPath, args: ["-e", "process.stdout.write('x'.repeat(400000))"],
      cwd: tmpdir(), environment: {}, timeoutMs: 1000 });
    expect(output.status).toBe("failed");
    expect(output.stderr).toContain("출력 한도 초과");
  });
});

it.skipIf(!pythonRuntime.framework)("등록한 실제 Python 프레임워크와 launcher 교체·삭제가 도구 해시에 반영된다", async () => {
  const f = await fixture();
  const runtime = join(f.root, "copied-runtime");
  const executable = join(runtime, "bin", `python${pythonRuntime.version}`);
  await mkdir(join(runtime, "bin"), { recursive: true });
  await copyFile(join(pythonRuntime.prefix, "bin", `python${pythonRuntime.version}`), executable);
  const core = join(runtime, pythonRuntime.framework);
  await copyFile(join(pythonRuntime.prefix, pythonRuntime.framework), core);
  const launcherRelative = "Resources/Python.app/Contents/MacOS/Python";
  const sourceLauncher = join(pythonRuntime.prefix, launcherRelative);
  const hasLauncher = !!await stat(sourceLauncher).catch(() => null);
  if (hasLauncher) {
    await mkdir(join(runtime, "Resources/Python.app/Contents/MacOS"), { recursive: true });
    await copyFile(sourceLauncher, join(runtime, launcherRelative));
  }
  await symlink(join(pythonRuntime.prefix, "lib"), join(runtime, "lib"));
  const data = join(f.root, "runtime-profile");
  await promisify(execFile)(process.execPath, ["--import", "tsx", join(import.meta.dirname, "../src/server/verificationCli.ts"),
    "--data-dir", data, "--install-profile", "--python", executable]);
  const profile = JSON.parse(await readFile(join(data, "verification-profiles", `${STATIC_PROFILE_ID}.json`), "utf8"));
  expect(profile.pythonLibraries).toContain(await realpath(core));
  expect((await promisify(execFile)(executable, ["-I", "-S", "-B", "-c", "print('ok')"])).stdout.trim()).toBe("ok");
  const before = await toolSHA(profile, f.worktree);
  if (hasLauncher) {
    await writeFile(join(runtime, launcherRelative), "changed launcher");
    expect(await toolSHA(profile, f.worktree)).not.toBe(before);
    await copyFile(sourceLauncher, join(runtime, launcherRelative));
  }
  await rm(core);
  expect(await toolSHA(profile, f.worktree)).not.toBe(before);
  await expect(promisify(execFile)(executable, ["-I", "-S", "-B", "-c", "print('ok')"])).rejects.toThrow();
}, 30_000);
