import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HOST_VERIFICATION_ENV, runHostVerification, type HostVerificationResult } from "../src/server/hostVerification";
import { exitCodeFor } from "../src/server/hostVerificationCli";

// 호스트 검증 실행의 소유·종료·보존·삭제 계약을 실제 자식 프로세스로 확인한다. 순서는 자식이 쓰는 ready 파일과 exit 이벤트로 제어하고 임의 sleep 으로 추정하지 않는다.
const roots: string[] = [];
const stragglers: number[] = [];
afterEach(() => {
  for (const pid of stragglers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료 */ } }
  for (const root of roots.splice(0)) {
    // 읽기 금지로 만든 픽스처도 지울 수 있게 권한을 되돌린다.
    try { for (const path of walk(root)) chmodSync(path, 0o700); } catch { /* 없는 경로 */ }
    rmSync(root, { recursive: true, force: true });
  }
});
function walk(path: string): string[] {
  if (!existsSync(path)) return [];
  const out = [path];
  try { for (const name of readdirSync(path, { withFileTypes: true })) if (name.isDirectory() && !name.isSymbolicLink()) out.push(...walk(join(path, name.name))); } catch { /* 파일 */ }
  return out;
}
const sha = (buffer: Buffer | string) => createHash("sha256").update(buffer).digest("hex");
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const RAW = Buffer.from([0, 1, 2, 255, 254, 10, 13, 0x41]);

// 실행 중 폴더: 스크래치 상위(base)에 "다른 실행" 과 "공유 캐시" 를 미리 둬 이 실행의 정리가 그것들을 건드리지 않는지 본다.
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-verify-test-"))); roots.push(root);
  const base = join(root, "base"); mkdirSync(base);
  const other = join(base, "cr-host-verify-other-abc123"); mkdirSync(join(other, "build"), { recursive: true });
  writeFileSync(join(other, "build", "keep"), "other run");
  const shared = join(base, "shared-cache"); mkdirSync(shared); writeFileSync(join(shared, "keep"), "shared");
  const source = join(root, "source"); mkdirSync(source); writeFileSync(join(source, "main.txt"), "source stays");
  const evidence = join(root, "evidence");
  const script = (name: string, body: string) => { const path = join(root, `${name}.cjs`); writeFileSync(path, body); return path; };
  const untouched = () => {
    expect(readFileSync(join(other, "build", "keep"), "utf8")).toBe("other run");
    expect(readFileSync(join(shared, "keep"), "utf8")).toBe("shared");
    expect(readFileSync(join(source, "main.txt"), "utf8")).toBe("source stays");
    expect(readdirSync(base).sort()).toEqual(["cr-host-verify-other-abc123", "shared-cache"]);
  };
  return { root, base, source, evidence, script, untouched };
}
// 소유 경로에 빌드 산출·캐시·바이너리 로그를 쓰고 환경·인자를 stdout 에 JSON 으로 남기는 자식. 인자: [종료 코드, ...echo 인자]
const BUILDER = `
const fs = require("node:fs"), path = require("node:path");
const build = process.env.CR_VERIFY_BUILD_DIR, cache = process.env.CR_VERIFY_CACHE_DIR, work = process.env.CR_VERIFY_WORK_DIR;
fs.mkdirSync(path.join(build, "Logs", "nested"), { recursive: true });
fs.writeFileSync(path.join(build, "Logs", "raw.log"), Buffer.from([0, 1, 2, 255, 254, 10, 13, 0x41]));
fs.writeFileSync(path.join(build, "Logs", "nested", "unicode.txt"), "검증 로그\\n");
fs.symlinkSync("raw.log", path.join(build, "Logs", "link-to-raw"));
fs.writeFileSync(path.join(build, "product.bin"), Buffer.alloc(4096, 7));
fs.mkdirSync(path.join(cache, "ModuleCache"), { recursive: true }); fs.writeFileSync(path.join(cache, "ModuleCache", "a.pcm"), "cache");
fs.writeFileSync(path.join(work, "scratch.txt"), "work");
fs.writeFileSync(path.join(process.env.TMPDIR, "temp.txt"), "temp");
console.log(JSON.stringify({ argv: process.argv.slice(2), cwd: process.cwd(), env: Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("CR_VERIFY_") || ["TMPDIR","XDG_CACHE_HOME","CLANG_MODULE_CACHE_PATH"].includes(k))) }));
console.error("stderr line");
process.exitCode = Number(process.argv[2] ?? 0);
`;
// 표준 증거 자리에만 쓰는 자식(선언 없는 보존 확인용). 인자: [라벨]
const LOGGER = `
const fs = require("node:fs"), path = require("node:path");
const build = process.env.CR_VERIFY_BUILD_DIR, label = process.argv[2];
fs.mkdirSync(path.join(build, "Logs"), { recursive: true }); fs.writeFileSync(path.join(build, "Logs", "important.log"), label + " important log\\n");
fs.mkdirSync(path.join(build, "TestResults"), { recursive: true }); fs.writeFileSync(path.join(build, "TestResults", "summary.txt"), label + " tests");
fs.mkdirSync(path.join(build, "Report.xcresult"), { recursive: true }); fs.writeFileSync(path.join(build, "Report.xcresult", "data"), Buffer.from([9, 8, 7]));
fs.writeFileSync(path.join(build, "big.o"), Buffer.alloc(1024, 1));
console.log(label + " original log");
`;
// ready 파일을 쓴 뒤 끝나지 않는 자식(취소·시간 초과용). 인자로 pid 파일을 주면 자기 pid 를 적는다.
const HOLDER = `
const fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(path.join(process.env.CR_VERIFY_BUILD_DIR, "partial.log"), "partial");
fs.writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, build: process.env.CR_VERIFY_BUILD_DIR }));
setInterval(() => {}, 1000);
`;
async function waitFor(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) { const text = readFileSync(path, "utf8"); if (text.length) return text; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`신호 파일이 오지 않았습니다: ${path}`);
}
function expectRemoved(result: HostVerificationResult) {
  expect(result.cleanup).toEqual({ status: "removed", reason: null, error: null });
  expect(existsSync(result.scratch.root)).toBe(false);
}
function parsedStdout(result: HostVerificationResult) {
  return JSON.parse(readFileSync(result.evidence.stdout, "utf8").trim().split("\n").at(-1)!) as { argv: string[]; cwd: string; env: Record<string, string> };
}
const byPath = (result: HostVerificationResult, path: string) => result.preserved.find((entry) => entry.path === path)!;

describe("호스트 검증 실행 — 소유 스크래치의 수명", () => {
  it("성공: 명령이 소유 경로를 환경 변수·토큰으로 받고, 지정한 로그만 바이트 그대로 보존된 뒤 스크래치가 지워지며 다른 폴더는 그대로다", async () => {
    const f = fixture();
    const result = await runHostVerification({
      label: "ok", command: process.execPath, args: [f.script("builder", BUILDER), "0", "--derived={build}", "{cache}/mods", "{work}", "{evidence}"],
      cwd: f.source, evidenceDirectory: f.evidence, scratchBase: f.base,
      preserve: [{ path: "build/Logs", required: true }, { path: "work/scratch.txt", required: true }, { path: "build/TestResults", required: false }],
    });
    expect(result).toMatchObject({ status: "succeeded", exitCode: 0, signal: null, complete: true, processGroup: { drained: true, error: null } });
    expectRemoved(result);
    expect(result.scratch.root.startsWith(`${f.base}/cr-host-verify-ok-`)).toBe(true);
    const out = parsedStdout(result);
    expect(out.cwd).toBe(f.source);
    expect(out.argv).toEqual(["0", `--derived=${result.scratch.build}`, `${result.scratch.cache}/mods`, result.scratch.work, result.evidence.directory]);
    expect(out.env).toEqual({
      [HOST_VERIFICATION_ENV.build]: result.scratch.build, [HOST_VERIFICATION_ENV.cache]: result.scratch.cache, [HOST_VERIFICATION_ENV.work]: result.scratch.work,
      [HOST_VERIFICATION_ENV.tmp]: result.scratch.tmp, [HOST_VERIFICATION_ENV.evidence]: result.evidence.directory,
      TMPDIR: result.scratch.tmp, XDG_CACHE_HOME: join(result.scratch.cache, "xdg"), CLANG_MODULE_CACHE_PATH: join(result.scratch.cache, "clang-modules"),
    });
    expect(readFileSync(result.evidence.stderr, "utf8")).toBe("stderr line\n");
    const preserved = join(f.evidence, "preserved");
    expect(sha(readFileSync(join(preserved, "build/Logs/raw.log")))).toBe(sha(RAW));
    expect(readFileSync(join(preserved, "build/Logs/nested/unicode.txt"), "utf8")).toBe("검증 로그\n");
    // 보존 트리 안의 상대 링크는 사본에서도 같은 바이트로 읽힌다.
    expect(sha(readFileSync(join(preserved, "build/Logs/link-to-raw")))).toBe(sha(RAW));
    expect(readFileSync(join(preserved, "work/scratch.txt"), "utf8")).toBe("work");
    expect(existsSync(join(preserved, "build/product.bin"))).toBe(false);
    expect(result.preserved).toEqual([
      { path: "build/Logs", required: true, status: "preserved", destination: join(preserved, "build/Logs"), files: 2, bytes: 8 + Buffer.byteLength("검증 로그\n"), error: null },
      { path: "work/scratch.txt", required: true, status: "preserved", destination: join(preserved, "work/scratch.txt"), files: 1, bytes: 4, error: null },
      { path: "build/TestResults", required: false, status: "missing", destination: null, files: 0, bytes: 0, error: null },
    ]);
    const saved = JSON.parse(readFileSync(result.evidence.result, "utf8")) as HostVerificationResult;
    expect(saved).toEqual(result);
    const command = JSON.parse(readFileSync(result.evidence.command, "utf8")) as { scratch: unknown; args: string[]; state: string };
    expect(command.scratch).toEqual(result.scratch);
    expect(command.state).toBe("running");
    expect(readdirSync(f.evidence).sort()).toEqual(["command.json", "preserved", "result.json", "stderr.log", "stdout.log"]);
    f.untouched();
    expect(exitCodeFor(result)).toBe(0);
  });

  it("실패: 종료 코드가 0이 아니면 failed 로 기록하되 로그 보존과 스크래치 삭제는 똑같이 한다", async () => {
    const f = fixture();
    const result = await runHostVerification({ label: "fail", command: process.execPath, args: [f.script("builder", BUILDER), "23"], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base, preserve: [{ path: "build/Logs", required: true }] });
    expect(result).toMatchObject({ status: "failed", exitCode: 23, complete: false });
    expectRemoved(result);
    expect(existsSync(join(f.evidence, "preserved/build/Logs/raw.log"))).toBe(true);
    f.untouched();
    expect(exitCodeFor(result)).toBe(1);
  });

  it("명시적 취소: 자식이 준비 신호를 보낸 뒤 abort 하면 프로세스 그룹을 끝내고 부분 로그를 보존한 뒤 스크래치를 지운다", async () => {
    const f = fixture();
    const ready = join(f.root, "ready.json");
    const controller = new AbortController();
    const pending = runHostVerification({ label: "cancel", command: process.execPath, args: [f.script("holder", HOLDER), ready], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base, signal: controller.signal, preserve: [{ path: "build/partial.log", required: true }] });
    const { pid, build } = JSON.parse(await waitFor(ready)) as { pid: number; build: string };
    stragglers.push(pid);
    expect(existsSync(join(build, "partial.log"))).toBe(true);
    controller.abort(new Error("stop"));
    const result = await pending;
    expect(result).toMatchObject({ status: "cancelled", exitCode: null, signal: "SIGTERM", pid, processGroup: { drained: true, error: null } });
    expect(alive(pid)).toBe(false);
    expectRemoved(result);
    expect(readFileSync(join(f.evidence, "preserved/build/partial.log"), "utf8")).toBe("partial");
    f.untouched();
    expect(exitCodeFor(result)).toBe(1);
  });

  it("시간 초과: 제한을 넘기면 timed_out 으로 끝내고 같은 정리를 한다 — 이미 취소된 요청은 프로세스를 만들지 않는다", async () => {
    const f = fixture();
    const ready = join(f.root, "ready.json");
    const result = await runHostVerification({ label: "timeout", command: process.execPath, args: [f.script("holder", HOLDER), ready], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base, timeoutMs: 300 });
    const { pid } = JSON.parse(readFileSync(ready, "utf8")) as { pid: number };
    expect(result).toMatchObject({ status: "timed_out", pid, processGroup: { drained: true } });
    expect(alive(pid)).toBe(false);
    expectRemoved(result);
    const aborted = await runHostVerification({ label: "pre", command: process.execPath, args: ["-e", "process.exit(0)"], cwd: f.source,
      evidenceDirectory: join(f.root, "evidence-pre"), scratchBase: f.base, signal: AbortSignal.abort() });
    expect(aborted).toMatchObject({ status: "cancelled", pid: null, exitCode: null });
    expectRemoved(aborted);
    f.untouched();
  });

  // 직속 자식은 끝났지만 같은 그룹의 손자(SIGTERM 무시)가 남은 경우 — 그룹이 빈 뒤에만 지운다.
  it("직속 자식 종료 뒤 남은 손자는 그룹 종료 계약(SIGTERM→SIGKILL)으로 끝낸 뒤 지우고, 그룹이 남아 있으면 지우지 않는다", async () => {
    const f = fixture();
    // 손자가 SIGTERM 핸들러를 건 뒤 pid 파일을 쓰면 그때 직속 자식이 끝난다 — 핸들러가 걸리기 전에 SIGTERM 이 닿아 기본 동작으로 죽는 경우를 배제한다.
    const spawner = f.script("spawner", `
      const { spawn } = require("node:child_process"); const fs = require("node:fs");
      const pidFile = process.argv[2];
      const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); require('node:fs').writeFileSync(process.argv[1], JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000)", pidFile], { stdio: "ignore" });
      child.unref();
      const deadline = Date.now() + 10000;
      while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, "utf8").length) {
        if (Date.now() > deadline) throw new Error("grandchild not ready");
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
      }
    `);
    const pidFile = join(f.root, "grandchild.json");
    const result = await runHostVerification({ label: "orphan", command: process.execPath, args: [spawner, pidFile], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base });
    const { pid: grandchild } = JSON.parse(readFileSync(pidFile, "utf8")) as { pid: number };
    stragglers.push(grandchild);
    expect(result).toMatchObject({ status: "succeeded", exitCode: 0, processGroup: { drained: true, error: null } });
    expect(alive(grandchild)).toBe(false);
    expectRemoved(result);

    const pidFile2 = join(f.root, "grandchild2.json");
    const kept = await runHostVerification({ label: "alive", command: process.execPath, args: [spawner, pidFile2], cwd: f.source,
      evidenceDirectory: join(f.root, "evidence-alive"), scratchBase: f.base,
      hooks: { drainProcessGroup: async () => new Error("그룹이 끝나지 않았습니다(주입)") } });
    const { pid: survivor } = JSON.parse(readFileSync(pidFile2, "utf8")) as { pid: number };
    stragglers.push(survivor);
    expect(alive(survivor)).toBe(true);
    expect(kept).toMatchObject({ status: "succeeded", complete: false, processGroup: { drained: false, error: "그룹이 끝나지 않았습니다(주입)" },
      cleanup: { status: "kept", error: "그룹이 끝나지 않았습니다(주입)" } });
    expect(kept.cleanup.reason).toContain("프로세스 그룹");
    expect(existsSync(kept.scratch.root)).toBe(true);
    expect(exitCodeFor(kept)).toBe(3);
    process.kill(survivor, "SIGKILL");
    rmSync(kept.scratch.root, { recursive: true, force: true });
    f.untouched();
  }, 20_000);

  it("spawn 실패는 spawn_failed 로 기록하고 빈 스크래치를 지운다", async () => {
    const f = fixture();
    const result = await runHostVerification({ label: "nocmd", command: join(f.root, "missing-binary"), args: [], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base });
    expect(result).toMatchObject({ status: "spawn_failed", pid: null, exitCode: null, complete: false });
    expect(result.error).toContain("ENOENT");
    expectRemoved(result);
    expect(existsSync(result.evidence.result)).toBe(true);
    f.untouched();
    expect(exitCodeFor(result)).toBe(2);
  });

  it("보존 실패(필수 경로 없음·사본 만들 수 없음)면 스크래치를 지우지 않고 사유를 남긴다 — 선택 경로 누락은 삭제를 막지 않는다", async () => {
    const f = fixture();
    const missing = await runHostVerification({ label: "missing", command: process.execPath, args: [f.script("builder", BUILDER), "0"], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base, preserve: [{ path: "build/Logs", required: true }, { path: "build/Report.xcresult", required: true }] });
    expect(missing).toMatchObject({ status: "succeeded", complete: false, cleanup: { status: "kept" } });
    expect(missing.cleanup.reason).toContain("보존");
    expect(missing.preserved.map((entry) => [entry.path, entry.status])).toEqual([["build/Logs", "preserved"], ["build/Report.xcresult", "missing"], ["build/TestResults", "missing"]]);
    expect(existsSync(join(missing.scratch.build, "Logs/raw.log"))).toBe(true);
    expect(exitCodeFor(missing)).toBe(3);
    rmSync(missing.scratch.root, { recursive: true, force: true });

    const unreadable = f.script("unreadable", `${BUILDER}\nrequire("node:fs").chmodSync(require("node:path").join(process.env.CR_VERIFY_BUILD_DIR, "Logs", "raw.log"), 0);`);
    const failed = await runHostVerification({ label: "unreadable", command: process.execPath, args: [unreadable, "0"], cwd: f.source,
      evidenceDirectory: join(f.root, "evidence-unreadable"), scratchBase: f.base, preserve: [{ path: "build/Logs", required: true }] });
    expect(failed).toMatchObject({ status: "succeeded", complete: false, cleanup: { status: "kept" } });
    expect(byPath(failed, "build/Logs")).toMatchObject({ status: "failed" });
    expect(byPath(failed, "build/Logs").error).toMatch(/EACCES|permission/i);
    expect(existsSync(join(failed.scratch.build, "product.bin"))).toBe(true);
    chmodSync(join(failed.scratch.build, "Logs/raw.log"), 0o600);
    rmSync(failed.scratch.root, { recursive: true, force: true });

    const optional = await runHostVerification({ label: "optional", command: process.execPath, args: [f.script("builder", BUILDER), "0"], cwd: f.source,
      evidenceDirectory: join(f.root, "evidence-optional"), scratchBase: f.base, preserve: [{ path: "build/TestResults", required: false }] });
    expect(optional).toMatchObject({ status: "succeeded", complete: true });
    expect(byPath(optional, "build/TestResults")).toMatchObject({ status: "missing", required: false });
    expectRemoved(optional);
    f.untouched();
  });

  // R3 — 선언이 없어도 표준 증거(build/Logs·build/TestResults·build/*.xcresult)는 보존된다. 산출물(big.o)은 보존하지 않는다.
  it("보존 선언이 없어도 표준 증거는 기본 보존된 뒤 스크래치를 지운다", async () => {
    const f = fixture();
    const result = await runHostVerification({ label: "defaults", command: process.execPath, args: [f.script("logger", LOGGER), "defaults"], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base });
    expect(result).toMatchObject({ status: "succeeded", complete: true });
    expectRemoved(result);
    expect(result.preserved.map((entry) => [entry.path, entry.required, entry.status])).toEqual([
      ["build/Logs", false, "preserved"], ["build/TestResults", false, "preserved"], ["build/Report.xcresult", false, "preserved"],
    ]);
    const preserved = join(f.evidence, "preserved");
    expect(readFileSync(join(preserved, "build/Logs/important.log"), "utf8")).toBe("defaults important log\n");
    expect(readFileSync(join(preserved, "build/TestResults/summary.txt"), "utf8")).toBe("defaults tests");
    expect([...readFileSync(join(preserved, "build/Report.xcresult/data"))]).toEqual([9, 8, 7]);
    expect(existsSync(join(preserved, "build/big.o"))).toBe(false);
    f.untouched();
  });

  // R3 — 명시 경로가 표준 증거와 겹쳐도(자손·조상) 같은 자리를 두 번 만들지 않고 모두 보존으로 적는다. 명시 자손이 없으면 missing(필수면 보존 실패)이다.
  it("명시 보존 경로가 표준 증거와 겹치면 조상 사본으로 충족하고, 없는 필수 자손은 보존 실패다", async () => {
    const f = fixture();
    const logger = f.script("logger", LOGGER);
    const nested = await runHostVerification({ label: "nested", command: process.execPath, args: [logger, "nested"], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base,
      preserve: [{ path: "build/TestResults/summary.txt", required: true }, { path: "build", required: false }] });
    expect(nested).toMatchObject({ status: "succeeded", complete: true });
    expectRemoved(nested);
    expect(nested.preserved.map((entry) => [entry.path, entry.status, entry.files])).toEqual([
      ["build", "preserved", 4], ["build/Logs", "preserved", 1], ["build/TestResults", "preserved", 1], ["build/Report.xcresult", "preserved", 1],
      ["build/TestResults/summary.txt", "preserved", 1],
    ]);
    expect(readFileSync(join(f.evidence, "preserved/build/TestResults/summary.txt"), "utf8")).toBe("nested tests");
    expect(readFileSync(join(f.evidence, "preserved/build/big.o")).length).toBe(1024);

    const absent = await runHostVerification({ label: "absent", command: process.execPath, args: [logger, "absent"], cwd: f.source,
      evidenceDirectory: join(f.root, "evidence-absent"), scratchBase: f.base, preserve: [{ path: "build/TestResults/none.xcresult", required: true }] });
    expect(absent).toMatchObject({ status: "succeeded", complete: false, cleanup: { status: "kept" } });
    expect(byPath(absent, "build/TestResults")).toMatchObject({ status: "preserved" });
    expect(byPath(absent, "build/TestResults/none.xcresult")).toMatchObject({ status: "missing", required: true });
    rmSync(absent.scratch.root, { recursive: true, force: true });
    f.untouched();
  });

  // R1 — 보존 트리 밖(지워질 cache)을 가리키는 링크·절대 경로 링크는 사본에서 읽을 수 없으므로 보존 실패이고 스크래치를 남긴다.
  it("보존 트리 밖을 가리키는 링크가 있으면 보존 실패로 기록하고 원본 로그가 남아 있다", async () => {
    const f = fixture();
    const linker = f.script("linker", `${LOGGER}
      const cache = process.env.CR_VERIFY_CACHE_DIR; fs.writeFileSync(path.join(cache, "original.log"), "only copy of the log");
      fs.symlinkSync("../../cache/original.log", path.join(build, "Logs", "cache-link"));
    `);
    const result = await runHostVerification({ label: "escape", command: process.execPath, args: [linker, "escape"], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base });
    expect(result).toMatchObject({ status: "succeeded", complete: false, cleanup: { status: "kept" } });
    expect(byPath(result, "build/Logs")).toMatchObject({ status: "failed" });
    expect(byPath(result, "build/Logs").error).toContain("보존 트리 밖");
    expect(readFileSync(join(result.scratch.cache, "original.log"), "utf8")).toBe("only copy of the log");
    expect(existsSync(join(f.evidence, "preserved/build/Logs/cache-link"))).toBe(false);
    expect(exitCodeFor(result)).toBe(3);
    rmSync(result.scratch.root, { recursive: true, force: true });

    const absolute = f.script("absolute", `${LOGGER}
      fs.symlinkSync(path.join(build, "Logs", "important.log"), path.join(build, "Logs", "abs-link"));
    `);
    const second = await runHostVerification({ label: "absolute", command: process.execPath, args: [absolute, "absolute"], cwd: f.source,
      evidenceDirectory: join(f.root, "evidence-absolute"), scratchBase: f.base });
    expect(second).toMatchObject({ complete: false, cleanup: { status: "kept" } });
    expect(byPath(second, "build/Logs").error).toContain("절대 경로 링크");
    rmSync(second.scratch.root, { recursive: true, force: true });
    f.untouched();
  });

  // R2 — 명령이 소유 루트를 옮기고 다른 폴더를 그 자리에 두면 그 폴더는 소유가 아니다. 보존도 삭제도 하지 않는다.
  it("스크래치 루트가 다른 디렉터리로 바뀌면 그 디렉터리를 보존하고 삭제하지 않는다", async () => {
    const f = fixture();
    const decoy = join(f.root, "decoy"); mkdirSync(join(decoy, "build", "Logs"), { recursive: true });
    writeFileSync(join(decoy, "build", "Logs", "victim.log"), "not yours");
    const swapper = f.script("swapper", `${LOGGER}
      const root = path.dirname(build);
      fs.renameSync(root, root + ".original");
      fs.renameSync(process.argv[3], root);
    `);
    const result = await runHostVerification({ label: "swap", command: process.execPath, args: [swapper, "swap", decoy], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base });
    expect(result).toMatchObject({ status: "succeeded", complete: false, cleanup: { status: "kept" } });
    expect(result.cleanup.reason).toContain("신원");
    expect(result.preserved.every((entry) => entry.status === "failed" && entry.error?.includes("신원"))).toBe(true);
    expect(readFileSync(join(result.scratch.root, "build", "Logs", "victim.log"), "utf8")).toBe("not yours");
    expect(readFileSync(join(`${result.scratch.root}.original`, "build", "Logs", "important.log"), "utf8")).toBe("swap important log\n");
    expect(existsSync(join(f.evidence, "preserved"))).toBe(false);
    expect(exitCodeFor(result)).toBe(3);
    rmSync(result.scratch.root, { recursive: true, force: true });
    rmSync(`${result.scratch.root}.original`, { recursive: true, force: true });
    f.untouched();
  });

  // R2 오류 경로 — 명령이 증거 폴더를 옮기고 그 자리에 다른 작업의 폴더를 두면, 그 자리에는 결과를 쓰지 않고 스크래치·다른 작업의 파일을 모두 보존한다.
  // 루트까지 함께 바뀐 경우도 같다(두 신원은 따로 본다). 어느 쪽도 "실행 전 되돌리기"로 오인해 지우지 않는다.
  it.each([false, true])("증거 폴더가 다른 디렉터리로 바뀌면(루트 함께 교체=%s) 결과를 그 자리에 쓰지 않고 스크래치와 다른 작업 파일을 보존한다", async (replaceRoot) => {
    const f = fixture();
    const swapper = f.script("evidence-swapper", `${LOGGER}
      const evidence = process.env.CR_VERIFY_EVIDENCE_DIR;
      fs.renameSync(evidence, evidence + ".original");
      fs.mkdirSync(evidence);
      fs.writeFileSync(path.join(evidence, "command.json"), "another job receipt");
      if (process.argv[3] === "true") {
        const root = path.dirname(build);
        fs.renameSync(root, root + ".original");
        fs.mkdirSync(root);
        fs.writeFileSync(path.join(root, "important"), "another job directory");
      }
    `);
    const result = await runHostVerification({ label: "evswap", command: process.execPath, args: [swapper, "evswap", String(replaceRoot)], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base });
    expect(result).toMatchObject({ status: "succeeded", complete: false, recorded: false, cleanup: { status: "kept" } });
    expect(result.cleanup.reason).toContain("증거 폴더");
    expect(result.cleanup.reason).toContain("result.json");
    if (replaceRoot) expect(result.cleanup.reason).toContain("스크래치 루트");
    expect(result.preserved.length).toBeGreaterThan(0);
    expect(result.preserved.every((entry) => entry.status === "failed")).toBe(true);
    // 바뀐 자리의 다른 작업 파일은 그대로이고 결과는 쓰지 않았다.
    expect(readFileSync(join(f.evidence, "command.json"), "utf8")).toBe("another job receipt");
    expect(readdirSync(f.evidence)).toEqual(["command.json"]);
    // 원래 증거 폴더(옮겨진 것)에는 이 실행의 점유 파일·로그가 남아 있고, 소유한 스크래치의 로그도 남아 있다.
    const original = `${f.evidence}.original`;
    expect((JSON.parse(readFileSync(join(original, "command.json"), "utf8")) as { label: string }).label).toBe("evswap");
    expect(readFileSync(join(original, "stdout.log"), "utf8")).toBe("evswap original log\n");
    const ownedRoot = replaceRoot ? `${result.scratch.root}.original` : result.scratch.root;
    expect(readFileSync(join(ownedRoot, "build", "Logs", "important.log"), "utf8")).toBe("evswap important log\n");
    if (replaceRoot) expect(readFileSync(join(result.scratch.root, "important"), "utf8")).toBe("another job directory");
    expect(exitCodeFor(result)).toBe(3);
    rmSync(ownedRoot, { recursive: true, force: true });
    if (replaceRoot) rmSync(result.scratch.root, { recursive: true, force: true });
    f.untouched();
  });

  // R2 — 증거 폴더 안의 보존 자리(preserved)가 바깥을 가리키는 링크면 그쪽에 쓰지 않는다.
  it("보존 사본의 조상이 링크면 보존 실패로 기록하고 링크 대상에는 아무것도 쓰지 않는다", async () => {
    const f = fixture();
    const outside = join(f.root, "outside"); mkdirSync(outside);
    const planter = f.script("planter", `${LOGGER}
      fs.symlinkSync(process.argv[3], path.join(process.env.CR_VERIFY_EVIDENCE_DIR, "preserved"));
    `);
    const result = await runHostVerification({ label: "planted", command: process.execPath, args: [planter, "planted", outside], cwd: f.source,
      evidenceDirectory: f.evidence, scratchBase: f.base });
    expect(result).toMatchObject({ status: "succeeded", complete: false, cleanup: { status: "kept" } });
    expect(byPath(result, "build/Logs").error).toContain("조상 경로");
    expect(readdirSync(outside)).toEqual([]);
    expect(readFileSync(join(result.scratch.build, "Logs", "important.log"), "utf8")).toBe("planted important log\n");
    rmSync(result.scratch.root, { recursive: true, force: true });
    f.untouched();
  });

  // R4 — 같은 증거 폴더를 두 실행이 동시에 요구하면 command.json 을 먼저 만든 하나만 그 폴더를 쓰고, 다른 하나는 아무것도 쓰지 않고 거절된다.
  it("같은 증거 폴더의 동시 실행은 하나만 차지하고 다른 하나는 거절된다", async () => {
    const f = fixture();
    const logger = f.script("logger", LOGGER);
    const run = (label: string) => runHostVerification({ label, command: process.execPath, args: [logger, label], cwd: f.source, evidenceDirectory: f.evidence, scratchBase: f.base });
    const outcomes = await Promise.allSettled([run("race-a"), run("race-b")]);
    const winners = outcomes.filter((outcome): outcome is PromiseFulfilledResult<HostVerificationResult> => outcome.status === "fulfilled");
    const losers = outcomes.filter((outcome): outcome is PromiseRejectedResult => outcome.status === "rejected");
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    expect(losers[0].reason.message).toContain("이미 다른 실행이 차지");
    const winner = winners[0].value;
    expect(winner).toMatchObject({ status: "succeeded", complete: true });
    expectRemoved(winner);
    expect(readFileSync(winner.evidence.stdout, "utf8")).toBe(`${winner.label} original log\n`);
    expect(readFileSync(join(f.evidence, "preserved/build/Logs/important.log"), "utf8")).toBe(`${winner.label} important log\n`);
    expect((JSON.parse(readFileSync(winner.evidence.result, "utf8")) as HostVerificationResult).label).toBe(winner.label);
    expect(readdirSync(f.evidence).sort()).toEqual(["command.json", "preserved", "result.json", "stderr.log", "stdout.log"]);
    f.untouched();
    // 끝난 실행의 폴더를 다시 쓰려는 요청도 같은 이유로 거절되고 기존 증거는 그대로다.
    await expect(run("reuse")).rejects.toThrow("이미 다른 실행이 차지");
    expect(readFileSync(winner.evidence.stdout, "utf8")).toBe(`${winner.label} original log\n`);
    f.untouched();
  });

  it("증거 폴더가 비어 있지 않거나 스크래치와 겹치거나 보존 경로가 루트 밖이면 시작하지 않고 자기 점유 파일만 거둔다", async () => {
    const f = fixture();
    mkdirSync(f.evidence); writeFileSync(join(f.evidence, "old.log"), "x");
    const base = { label: "guard", command: process.execPath, args: ["-e", "0"], cwd: f.source, scratchBase: f.base };
    await expect(runHostVerification({ ...base, evidenceDirectory: f.evidence })).rejects.toThrow("비어 있어야");
    expect(readdirSync(f.evidence)).toEqual(["old.log"]);
    const empty = join(f.root, "empty"); mkdirSync(empty);
    await expect(runHostVerification({ ...base, evidenceDirectory: empty, scratchBase: empty })).rejects.toThrow("서로 안에");
    expect(readdirSync(empty)).toEqual([]);
    await expect(runHostVerification({ ...base, evidenceDirectory: join(f.root, "e2"), preserve: [{ path: "../outside", required: true }] })).rejects.toThrow("상대 경로");
    await expect(runHostVerification({ ...base, label: "bad label", evidenceDirectory: join(f.root, "e3") })).rejects.toThrow("label");
    await expect(runHostVerification({ ...base, evidenceDirectory: join(f.root, "e4"), cwd: join(f.root, "nowhere") })).rejects.toThrow("작업 폴더");
    expect(readdirSync(join(f.root, "e4"))).toEqual([]);
    f.untouched();
  });
});

describe("호스트 검증 CLI 프로세스", () => {
  const cli = join(import.meta.dirname, "../src/server/hostVerificationCli.ts");
  // tsx 는 저장소에서 풀리므로 CLI 프로세스의 cwd 는 저장소다 — 명령의 작업 폴더는 --cwd 로 넘긴다.
  function run(args: string[], cwd: string): { child: ChildProcess; done: Promise<{ code: number | null; stdout: string; stderr: string }> } {
    const child = spawn(process.execPath, ["--import", "tsx", cli, "--cwd", cwd, ...args], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout!.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveDone) => child.once("close", (code) => resolveDone({ code, stdout, stderr })));
    return { child, done };
  }

  it("`--` 뒤 명령을 실행해 종료 코드 0 과 기본 증거 경로(<data-dir>/host-verification)를 남기고, 보존·삭제 실패는 3 으로 드러낸다", async () => {
    const f = fixture();
    const data = join(f.root, "data");
    const ok = await run(["--label", "cli-ok", "--data-dir", data, "--scratch-base", f.base, "--preserve", "build/Logs", "--",
      process.execPath, f.script("builder", BUILDER), "0", "{build}"], f.source).done;
    expect(ok.code, ok.stderr).toBe(0);
    const result = JSON.parse(ok.stdout) as HostVerificationResult;
    expect(result.evidence.directory.startsWith(join(data, "host-verification", "cli-ok-"))).toBe(true);
    expect(result).toMatchObject({ status: "succeeded", complete: true, cleanup: { status: "removed" } });
    expect(existsSync(join(result.evidence.directory, "preserved/build/Logs/raw.log"))).toBe(true);
    expect(parsedStdout(result).argv).toEqual(["0", result.scratch.build]);
    expect(ok.stderr).toContain("호스트 검증 cli-ok: succeeded");
    const kept = await run(["--label", "cli-kept", "--data-dir", data, "--scratch-base", f.base, "--preserve", "build/none", "--",
      process.execPath, f.script("builder", BUILDER), "0"], f.source).done;
    expect(kept.code).toBe(3);
    const keptResult = JSON.parse(kept.stdout) as HostVerificationResult;
    expect(keptResult.cleanup.status).toBe("kept");
    rmSync(keptResult.scratch.root, { recursive: true, force: true });
    const usage = await run(["--label", "x"], f.source).done;
    expect(usage.code).toBe(2);
    expect(usage.stderr).toContain("사용법");
    f.untouched();
  }, 30_000);

  // R3 — 보존 플래그 없이 부른 production CLI 도 표준 증거를 보존한다.
  it("보존 플래그 없이도 build/Logs·TestResults·*.xcresult 를 보존하고 종료 코드 0 을 낸다", async () => {
    const f = fixture();
    const outcome = await run(["--label", "cli-defaults", "--evidence-dir", f.evidence, "--scratch-base", f.base, "--",
      process.execPath, f.script("logger", LOGGER), "cli-defaults"], f.source).done;
    expect(outcome.code, outcome.stderr).toBe(0);
    const result = JSON.parse(outcome.stdout) as HostVerificationResult;
    expect(result).toMatchObject({ complete: true, cleanup: { status: "removed" } });
    expect(readFileSync(join(f.evidence, "preserved/build/Logs/important.log"), "utf8")).toBe("cli-defaults important log\n");
    expect(existsSync(join(f.evidence, "preserved/build/TestResults/summary.txt"))).toBe(true);
    expect(existsSync(join(f.evidence, "preserved/build/Report.xcresult/data"))).toBe(true);
    expect(existsSync(result.scratch.root)).toBe(false);
    f.untouched();
  }, 30_000);

  it("SIGINT 는 취소로 전달된다 — 자식 그룹을 끝내고 스크래치를 지운 뒤 종료 코드 1 과 result.json 을 남긴다", async () => {
    const f = fixture();
    const ready = join(f.root, "ready.json");
    const { child, done } = run(["--label", "cli-cancel", "--evidence-dir", f.evidence, "--scratch-base", f.base, "--preserve-optional", "build/partial.log", "--",
      process.execPath, f.script("holder", HOLDER), ready], f.source);
    const { pid } = JSON.parse(await waitFor(ready)) as { pid: number };
    stragglers.push(pid);
    child.kill("SIGINT");
    const outcome = await done;
    expect(outcome.code, outcome.stderr).toBe(1);
    const result = JSON.parse(readFileSync(join(f.evidence, "result.json"), "utf8")) as HostVerificationResult;
    expect(result).toMatchObject({ status: "cancelled", pid, cleanup: { status: "removed" } });
    expect(byPath(result, "build/partial.log").status).toBe("preserved");
    expect(alive(pid)).toBe(false);
    expect(existsSync(result.scratch.root)).toBe(false);
    f.untouched();
  }, 30_000);
});
