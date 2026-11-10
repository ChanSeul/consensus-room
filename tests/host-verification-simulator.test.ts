import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHostVerification, type HostVerificationOptions, type HostVerificationResult } from "../src/server/hostVerification";
import { exitCodeFor } from "../src/server/hostVerificationCli";
import { SIMULATOR_ENV, SIMULATOR_LOG_FILE } from "../src/server/hostVerificationSimulator";

// 호스트 검증이 소유하는 시뮬레이터·log stream 의 수명 계약을 가짜 simctl(실제 node 자식 프로세스)로 확인한다. 실제 simctl 은 부르지 않는다.
// 가짜 simctl 은 기기마다 상태 파일 하나(devices/<udid>.json)를 두므로 병렬 실행이 서로의 기기를 덮어쓰지 않는다. 모드는 modes/<이름> 파일로 켠다.
// 순서는 자식이 쓰는 ready 파일·로그 파일 크기로 제어하고 임의 sleep 으로 추정하지 않는다.
const FAKE_SIMCTL = `
const fs = require("node:fs"), path = require("node:path"), crypto = require("node:crypto");
const [state, ...args] = process.argv.slice(2);
const devices = path.join(state, "devices");
fs.mkdirSync(devices, { recursive: true });
fs.appendFileSync(path.join(state, "calls.log"), args.join(" ") + "\\n");
const mode = (name) => fs.existsSync(path.join(state, "modes", name));
const file = (udid) => path.join(devices, udid + ".json");
const read = (udid) => fs.existsSync(file(udid)) ? JSON.parse(fs.readFileSync(file(udid), "utf8")) : null;
const write = (device) => fs.writeFileSync(file(device.udid), JSON.stringify(device));
const fail = (code, text) => { process.stderr.write(text + "\\n"); process.exit(code); };
const hang = (ready) => { fs.writeFileSync(path.join(state, ready), JSON.stringify({ pid: process.pid })); setInterval(() => {}, 1000); };
// paused 를 알린 뒤 resume 파일이 생기면 then 을 이어 실행한다(증거 폴더 교체 같은 외부 개입을 그 사이에 넣는다).
const pause = (name, then) => {
  fs.writeFileSync(path.join(state, name + "-paused"), JSON.stringify({ pid: process.pid }));
  const timer = setInterval(() => { if (fs.existsSync(path.join(state, name + "-resume"))) { clearInterval(timer); then(); } }, 10);
};
const [command, udid] = args;
if (command === "create") {
  if (mode("fail-create")) fail(1, "Invalid device type: " + args[2]);
  const device = { udid: crypto.randomUUID().toUpperCase(), name: args[1], type: args[2], runtime: args[3] || null, state: "Shutdown" };
  write(device);
  if (mode("create-hang")) hang("create-ready");
  else if (mode("pause-create")) pause("create", () => process.stdout.write(device.udid + "\\n"));
  else process.stdout.write(device.udid + "\\n");
} else if (command === "boot") {
  const device = read(udid); if (!device) fail(2, "Invalid device: " + udid);
  if (mode("hang-boot")) hang("boot-ready");
  else if (mode("fail-boot")) fail(149, "Unable to boot device");
  else if (mode("pause-boot")) pause("boot", () => write({ ...device, state: "Booted" }));
  else write({ ...device, state: "Booted" });
} else if (command === "bootstatus") {
  const device = read(udid); if (!device || device.state !== "Booted") fail(1, "not booted");
} else if (command === "spawn") {
  const device = read(udid); if (!device || device.state !== "Booted") fail(149, "Unable to lookup in current state");
  fs.mkdirSync(path.join(state, "streams"), { recursive: true });
  fs.writeFileSync(path.join(state, "streams", process.pid + ".json"), JSON.stringify({ pid: process.pid, udid, args: args.slice(2) }));
  // 잘못된 predicate 처럼 스트림이 시작 직후 끝나는 경우 — stderr 를 남기고 exit 12, 끝났다는 신호 파일을 쓴다.
  if (mode("log-exit")) { process.stderr.write("invalid log stream predicate\\n"); fs.writeFileSync(path.join(state, "log-ended"), "ended"); process.exitCode = 12; }
  else if (mode("flood")) { const chunk = Buffer.alloc(100000, 0x61); const pump = () => process.stdout.write(chunk, () => setImmediate(pump)); pump(); }
  else { let n = 0; setInterval(() => process.stdout.write("log line " + (n++) + " " + udid + "\\n"), 10); }
} else if (command === "shutdown") {
  const device = read(udid); if (!device) fail(2, "Invalid device: " + udid);
  if (device.state === "Shutdown") fail(149, "Unable to shutdown device in current state: Shutdown");
  write({ ...device, state: "Shutdown" });
} else if (command === "delete") {
  if (mode("fail-delete")) fail(1, "delete refused (injected)");
  if (!read(udid)) fail(2, "Invalid device: " + udid);
  fs.rmSync(file(udid));
} else if (command === "list") {
  const all = fs.readdirSync(devices).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(devices, name), "utf8")));
  process.stdout.write(JSON.stringify({ devices: { "com.apple.CoreSimulator.SimRuntime.iOS-27-2": all } }));
} else fail(64, "unknown command " + command);
`;
// 검증 명령 — UDID 를 환경 변수·인자로 받고 그 순간 기기 상태를 stdout 에 남긴다. 인자: [state, udid 토큰, 종료 코드, 기다릴 로그 바이트, marker]
const CHECKER = `
const fs = require("node:fs"), path = require("node:path");
const [state, arg, code, waitBytes, marker, waitFile] = process.argv.slice(2);
if (marker) fs.writeFileSync(marker, "ran");
const fileDeadline = Date.now() + 10000;
while (waitFile && !fs.existsSync(waitFile)) {
  if (Date.now() > fileDeadline) { console.error("never saw " + waitFile); process.exit(91); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const udid = process.env.CR_VERIFY_SIMULATOR_UDID;
const log = path.join(process.env.CR_VERIFY_EVIDENCE_DIR, "simulator-log.txt");
const deadline = Date.now() + 10000;
while (Number(waitBytes) > 0 && !(fs.existsSync(log) && fs.statSync(log).size >= Number(waitBytes))) {
  if (Date.now() > deadline) { console.error("log never reached " + waitBytes); process.exit(90); }
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
}
const device = JSON.parse(fs.readFileSync(path.join(state, "devices", udid + ".json"), "utf8"));
console.log(JSON.stringify({ udid, arg, state: device.state }));
process.exitCode = Number(code);
`;
const HOLDER = `
require("node:fs").writeFileSync(process.argv[2], JSON.stringify({ pid: process.pid, udid: process.env.CR_VERIFY_SIMULATOR_UDID }));
setInterval(() => {}, 1000);
`;

const roots: string[] = [];
const stragglers: number[] = [];
afterEach(() => {
  for (const pid of stragglers.splice(0)) { try { process.kill(pid, "SIGKILL"); } catch { /* 이미 종료 */ } }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function waitFor(path: string, timeoutMs = 10_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) { const text = readFileSync(path, "utf8"); if (text.length) return text; }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`신호 파일이 오지 않았습니다: ${path}`);
}

// 미리 Booted 인 "다른 작업의 기기" 를 심어 두고, 모든 실행 뒤 그대로인지 본다.
const OTHER = { udid: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", name: "user device", type: "iPhone 18 Pro Max", runtime: null, state: "Booted" };
function fixture(modes: string[] = []) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "host-verify-sim-"))); roots.push(root);
  const state = join(root, "simctl"); mkdirSync(join(state, "devices"), { recursive: true }); mkdirSync(join(state, "modes"));
  for (const mode of modes) writeFileSync(join(state, "modes", mode), "");
  writeFileSync(join(state, "devices", `${OTHER.udid}.json`), JSON.stringify(OTHER));
  const base = join(root, "base"); mkdirSync(base);
  const source = join(root, "source"); mkdirSync(source);
  const script = (name: string, body: string) => { const path = join(root, `${name}.cjs`); writeFileSync(path, body); return path; };
  const simctl = [process.execPath, script("fake-simctl", FAKE_SIMCTL), state];
  let evidenceCount = 0;
  const options = (overrides: Partial<HostVerificationOptions> & Pick<HostVerificationOptions, "args">): HostVerificationOptions => ({
    label: "sim", command: process.execPath, cwd: source, evidenceDirectory: join(root, `evidence-${evidenceCount++}`), scratchBase: base,
    simulator: { deviceType: "iPhone 18 Pro" }, ...overrides,
    hooks: { simctl, ...overrides.hooks },
  });
  const devices = () => readdirSync(join(state, "devices")).map((name) => JSON.parse(readFileSync(join(state, "devices", name), "utf8")) as typeof OTHER);
  const calls = () => readFileSync(join(state, "calls.log"), "utf8").trim().split("\n").map((line) => line.split(" ")[0]);
  const streams = () => existsSync(join(state, "streams"))
    ? readdirSync(join(state, "streams")).map((name) => JSON.parse(readFileSync(join(state, "streams", name), "utf8")) as { pid: number; udid: string; args: string[] }) : [];
  // 다른 기기는 그대로(존재·Booted)이고, 이 픽스처에서 이 실행이 만든 기기는 남지 않았다.
  const onlyOtherRemains = () => expect(devices()).toEqual([OTHER]);
  return { root, state, source, script, options, devices, calls, streams, onlyOtherRemains, checker: script("checker", CHECKER), holder: script("holder", HOLDER) };
}
function expectRemoved(result: HostVerificationResult) {
  expect(result.simulator?.teardown).toMatchObject({ status: "removed", error: null });
  expect(existsSync(result.scratch.root)).toBe(false);
}
const stdoutJson = (result: HostVerificationResult) => JSON.parse(readFileSync(result.evidence.stdout, "utf8").trim()) as { udid: string; arg: string; state: string };

describe("호스트 검증 — 소유 시뮬레이터와 log stream 의 수명", () => {
  it("성공: 전용 기기를 만들어 띄우고 UDID 를 토큰·환경 변수로 넘기며, 끝나면 스트림 종료 → shutdown → delete 뒤 부재를 확인한다 — 다른 기기는 그대로다", async () => {
    const f = fixture();
    const result = await runHostVerification(f.options({ args: [f.checker, f.state, "id={simulator}", "0", "1"],
      simulator: { deviceType: "iPhone 18 Pro", runtime: "iOS-27-2", logPredicate: 'process == "App"' } }));
    expect(result).toMatchObject({ status: "succeeded", complete: true, cleanup: { status: "removed" } });
    expectRemoved(result);
    const sim = result.simulator!;
    expect(sim.name).toMatch(/^cr-verify-sim-[0-9a-f]{12}$/);
    expect(sim.setup).toMatchObject({ status: "ready", error: null });
    // 명령은 실행 중 Booted 인 소유 기기를 환경 변수와 토큰으로 받았다.
    expect(stdoutJson(result)).toEqual({ udid: sim.udid, arg: `id=${sim.udid}`, state: "Booted" });
    expect(result.environment[SIMULATOR_ENV]).toBe(sim.udid);
    expect(result.args).toContain(`id=${sim.udid}`);
    // 점유 기록에 기기 이름·UDID 가 남는다(finally 를 못 도는 종료 대비).
    expect((JSON.parse(readFileSync(result.evidence.command, "utf8")) as { simulator: unknown }).simulator).toEqual({ name: sim.name, udid: sim.udid });
    expect(f.calls()).toEqual(["create", "boot", "bootstatus", "spawn", "shutdown", "delete", "list"]);
    const [stream] = f.streams();
    expect(stream.args).toEqual(["log", "stream", "--style", "compact", "--predicate", 'process == "App"']);
    expect(sim.log).toMatchObject({ pid: stream.pid, status: "captured", error: null, truncated: false, bytesDropped: 0, bytesUnwritten: 0, predicate: 'process == "App"' });
    expect(alive(stream.pid)).toBe(false);
    expect(sim.teardown.stream).toEqual({ status: "stopped", error: null });
    const log = readFileSync(join(result.evidence.directory, SIMULATOR_LOG_FILE), "utf8");
    expect(log.length).toBe(sim.log!.bytesWritten);
    expect(log).toContain(`log line 0 ${sim.udid}`);
    f.onlyOtherRemains();
    expect(exitCodeFor(result)).toBe(0);
  });

  it("실패: 명령이 실패해도 기기와 스트림을 똑같이 회수한다", async () => {
    const f = fixture();
    const result = await runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "7", "0"] }));
    expect(result).toMatchObject({ status: "failed", exitCode: 7, complete: false });
    expectRemoved(result);
    expect(alive(result.simulator!.log!.pid!)).toBe(false);
    f.onlyOtherRemains();
    expect(exitCodeFor(result)).toBe(1);
  });

  it("명령 중 취소·시간 초과: 프로세스 그룹을 끝낸 뒤 기기와 스트림을 회수한다", async () => {
    const f = fixture();
    const ready = join(f.root, "ready.json");
    const controller = new AbortController();
    const pending = runHostVerification(f.options({ args: [f.holder, ready], signal: controller.signal }));
    const { pid, udid } = JSON.parse(await waitFor(ready)) as { pid: number; udid: string };
    stragglers.push(pid);
    controller.abort(new Error("stop"));
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ status: "cancelled", pid, complete: false });
    expect(cancelled.simulator!.udid).toBe(udid);
    expectRemoved(cancelled);
    expect(alive(pid)).toBe(false);
    expect(alive(cancelled.simulator!.log!.pid!)).toBe(false);
    f.onlyOtherRemains();

    const ready2 = join(f.root, "ready2.json");
    const timedOut = await runHostVerification(f.options({ args: [f.holder, ready2], timeoutMs: 300 }));
    stragglers.push((JSON.parse(readFileSync(ready2, "utf8")) as { pid: number }).pid);
    expect(timedOut).toMatchObject({ status: "timed_out", complete: false });
    expectRemoved(timedOut);
    expect(alive(timedOut.simulator!.log!.pid!)).toBe(false);
    f.onlyOtherRemains();
    expect(exitCodeFor(timedOut)).toBe(1);
  }, 20_000);

  it("명령 spawn 실패에도 만든 기기와 스트림을 회수한다", async () => {
    const f = fixture();
    const result = await runHostVerification(f.options({ command: join(f.root, "missing-binary"), args: [] }));
    expect(result).toMatchObject({ status: "spawn_failed", complete: false });
    expectRemoved(result);
    f.onlyOtherRemains();
    expect(exitCodeFor(result)).toBe(2);
  });

  it("준비 실패: create 가 실패하면 명령을 실행하지 않고 setup_failed(종료 코드 2), 만든 기기가 없음을 목록으로 확인한다", async () => {
    const f = fixture(["fail-create"]);
    const marker = join(f.root, "ran");
    const result = await runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "0", "0", marker] }));
    expect(result).toMatchObject({ status: "setup_failed", pid: null, complete: false });
    expect(result.error).toContain("simctl create 실패");
    expect(result.error).toContain("Invalid device type");
    expect(result.simulator).toMatchObject({ udid: null, log: null, teardown: { status: "not_created", error: null } });
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(result.scratch.root)).toBe(false);
    f.onlyOtherRemains();
    expect(exitCodeFor(result)).toBe(2);
  });

  it("준비 실패: boot 가 실패하면 만든 기기를 지우고, create 가 UDID 를 돌려주지 못하면 이 실행의 난수 이름으로 찾아 지운다", async () => {
    const f = fixture(["fail-boot"]);
    const marker = join(f.root, "ran");
    const booted = await runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "0", "0", marker] }));
    expect(booted).toMatchObject({ status: "setup_failed", complete: false });
    expect(booted.error).toContain("simctl boot 실패");
    expect(booted.simulator!.udid).toMatch(/^[0-9A-F-]{36}$/);
    expectRemoved(booted);
    expect(existsSync(marker)).toBe(false);
    expect(f.streams()).toEqual([]);
    f.onlyOtherRemains();

    const g = fixture(["create-hang"]);
    const adopted = await runHostVerification(g.options({ args: [g.checker, g.state, "{simulator}", "0", "0"], hooks: { simulatorLimits: { controlTimeoutMs: 1_500 } } }));
    const { pid: createPid } = JSON.parse(readFileSync(join(g.state, "create-ready"), "utf8")) as { pid: number };
    stragglers.push(createPid);
    expect(alive(createPid)).toBe(false);
    expect(adopted).toMatchObject({ status: "setup_failed", complete: false });
    expect(adopted.error).toContain("같은 이름의 기기");
    expect(adopted.simulator!.setup.steps[0]).toMatchObject({ args: expect.arrayContaining(["create"]), timedOut: true });
    expectRemoved(adopted);
    g.onlyOtherRemains();
  }, 20_000);

  it("부팅 중 취소·부팅 시간 초과: 부팅 프로세스를 끝내고 만든 기기를 지운다", async () => {
    const f = fixture(["hang-boot"]);
    const controller = new AbortController();
    const pending = runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "0", "0"], signal: controller.signal }));
    const { pid: bootPid } = JSON.parse(await waitFor(join(f.state, "boot-ready"))) as { pid: number };
    stragglers.push(bootPid);
    controller.abort(new Error("stop"));
    const cancelled = await pending;
    expect(cancelled).toMatchObject({ status: "cancelled", pid: null, complete: false });
    expect(cancelled.simulator!.setup).toMatchObject({ status: "cancelled" });
    expect(alive(bootPid)).toBe(false);
    expectRemoved(cancelled);
    f.onlyOtherRemains();
    expect(exitCodeFor(cancelled)).toBe(1);

    rmSync(join(f.state, "boot-ready"));
    const timedOut = await runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "0", "0"], hooks: { simulatorLimits: { bootTimeoutMs: 400 } } }));
    const { pid: bootPid2 } = JSON.parse(readFileSync(join(f.state, "boot-ready"), "utf8")) as { pid: number };
    stragglers.push(bootPid2);
    expect(timedOut).toMatchObject({ status: "setup_failed", complete: false });
    expect(timedOut.error).toContain("시간 초과");
    expect(alive(bootPid2)).toBe(false);
    expectRemoved(timedOut);
    f.onlyOtherRemains();
  }, 20_000);

  it("정리 실패: delete 가 거부되면 result.json 의 simulator.teardown 에 남고 complete=false·종료 코드 3 이다(성공으로 가리지 않는다)", async () => {
    const f = fixture(["fail-delete"]);
    const result = await runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "0", "0"] }));
    expect(result).toMatchObject({ status: "succeeded", complete: false, cleanup: { status: "removed" } });
    expect(result.simulator!.teardown.status).toBe("failed");
    expect(result.simulator!.teardown.error).toContain("기기가 남아 있습니다");
    expect(result.simulator!.teardown.error).toContain("delete refused");
    expect(alive(result.simulator!.log!.pid!)).toBe(false);
    const saved = JSON.parse(readFileSync(result.evidence.result, "utf8")) as HostVerificationResult;
    expect(saved.simulator!.teardown.status).toBe("failed");
    expect(exitCodeFor(result)).toBe(3);
    // 남은 기기는 이 실행의 것 하나뿐이고 꺼져 있다. 다른 기기는 그대로다.
    expect(f.devices().sort((a, b) => a.udid.localeCompare(b.udid))).toEqual(
      [OTHER, { udid: result.simulator!.udid, name: result.simulator!.name, type: "iPhone 18 Pro", runtime: null, state: "Shutdown" }]
        .sort((a, b) => a.udid!.localeCompare(b.udid!)));
  });

  it("로그 상한: 넘친 출력은 읽어서 버리고 바이트 수와 truncated 를 기록하며, 증거 파일은 상한을 넘지 않는다", async () => {
    const f = fixture(["flood"]);
    const result = await runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "0", "4096"], hooks: { simulatorLimits: { logMaxBytes: 4096 } } }));
    expect(result).toMatchObject({ status: "succeeded", complete: true });
    expectRemoved(result);
    const log = result.simulator!.log!;
    // 상한 초과는 정상 수집이다(captured) — 버린 양만 기록한다.
    expect(log).toMatchObject({ status: "captured", error: null, maxBytes: 4096, bytesWritten: 4096, bytesUnwritten: 0, truncated: true });
    expect(log.bytesDropped).toBeGreaterThan(0);
    expect(statSync(join(result.evidence.directory, SIMULATOR_LOG_FILE)).size).toBe(4096);
    expect(alive(log.pid!)).toBe(false);
    f.onlyOtherRemains();
  });

  // R1 — 스트림이 정리 전에 끝나면(잘못된 predicate 등) 그 뒤 기간의 로그는 없다. 명령이 성공해도 수집 실패로 기록하고 complete 를 막는다.
  it("log stream 이 정리 전에 끝나면 log.status=failed·사유를 남기고 complete=false·종료 코드 3 이다 — 기기는 그대로 회수한다", async () => {
    const f = fixture(["log-exit"]);
    const result = await runHostVerification(f.options({ args: [f.checker, f.state, "{simulator}", "0", "0", "", join(f.state, "log-ended")] }));
    expect(result).toMatchObject({ status: "succeeded", exitCode: 0, complete: false, cleanup: { status: "removed" } });
    expect(result.simulator!.log).toMatchObject({ status: "failed", exitCode: 12, bytesWritten: 0 });
    expect(result.simulator!.log!.error).toContain("정리 전에 끝났습니다(exit 12)");
    expect(result.simulator!.log!.error).toContain("invalid log stream predicate");
    expectRemoved(result);
    const saved = JSON.parse(readFileSync(result.evidence.result, "utf8")) as HostVerificationResult;
    expect(saved).toMatchObject({ complete: false, simulator: { log: { status: "failed" } } });
    f.onlyOtherRemains();
    expect(exitCodeFor(result)).toBe(3);
  });

  // R2 — 기기 준비(비동기) 중 차지한 증거 폴더가 다른 폴더로 바뀌면, 그 자리에는 점유 기록·로그·명령 출력·결과를 쓰지 않고 명령도 실행하지 않는다. 만든 기기는 회수한다.
  it.each(["create", "boot"])("기기 준비(%s) 중 증거 폴더가 바뀌면 새 폴더에 아무것도 쓰지 않고 명령을 실행하지 않으며 기기를 회수한다", async (stage) => {
    const f = fixture([`pause-${stage}`]);
    const marker = join(f.root, "ran");
    const evidence = join(f.root, "evidence-swap");
    const pending = runHostVerification(f.options({ evidenceDirectory: evidence, args: [f.checker, f.state, "{simulator}", "0", "0", marker] }));
    await waitFor(join(f.state, `${stage}-paused`));
    renameSync(evidence, `${evidence}-original`);
    mkdirSync(evidence); writeFileSync(join(evidence, "foreign-marker"), "keep");
    writeFileSync(join(f.state, `${stage}-resume`), "go");
    const result = await pending;
    expect(result).toMatchObject({ status: "setup_failed", pid: null, complete: false, recorded: false });
    expect(result.error).toContain("증거 폴더의 신원");
    expect(readdirSync(evidence)).toEqual(["foreign-marker"]);
    expect(existsSync(marker)).toBe(false);
    expect(result.simulator!.log).toBeNull();
    expect(result.simulator!.teardown).toMatchObject({ status: "removed", error: null });
    // 기존 신원 정책 그대로 — 증거 폴더가 바뀌면 스크래치는 보존·삭제하지 않는다(소유 스크래치이므로 테스트가 지운다).
    expect(result.cleanup.status).toBe("kept");
    expect(result.cleanup.reason).toContain("증거 폴더");
    rmSync(result.scratch.root, { recursive: true, force: true });
    // 옮겨진 원래 폴더에는 이 실행의 점유 기록만 있다(교체 전까지 쓴 것). 로그 파일·명령 출력은 열지 않았다.
    const original = `${evidence}-original`;
    expect(readdirSync(original)).toEqual(["command.json"]);
    const claim = JSON.parse(readFileSync(join(original, "command.json"), "utf8")) as { simulator: { name: string; udid: string | null } };
    expect(claim.simulator.name).toBe(result.simulator!.name);
    expect(claim.simulator.udid).toBe(stage === "boot" ? result.simulator!.udid : null);
    f.onlyOtherRemains();
    expect(exitCodeFor(result)).toBe(2);
  });

  // R2(스크래치) — 같은 원인: 기기 준비 중 만든 스크래치 루트가 다른 폴더로 바뀌면 명령을 띄우지 않는다(명령이 교체 폴더에 쓰지 못하게). 교체 폴더는 쓰지도 지우지도 않고 기기는 회수한다.
  it("기기 준비 중 스크래치 루트가 바뀌면 명령을 실행하지 않고 교체 폴더를 그대로 두며 기기를 회수한다", async () => {
    const f = fixture(["pause-create"]);
    const evidence = join(f.root, "evidence-scratch-swap");
    const pending = runHostVerification(f.options({ evidenceDirectory: evidence,
      args: ["-e", "require('node:fs').writeFileSync(process.env.CR_VERIFY_BUILD_DIR + '/intrusion', 'foreign write')"] }));
    await waitFor(join(f.state, "create-paused"));
    const scratch = (JSON.parse(readFileSync(join(evidence, "command.json"), "utf8")) as { scratch: { root: string } }).scratch.root;
    renameSync(scratch, `${scratch}-original`);
    for (const name of ["build", "cache", "work", "tmp"]) mkdirSync(join(scratch, name), { recursive: true });
    writeFileSync(join(scratch, "foreign-marker"), "keep");
    writeFileSync(join(f.state, "create-resume"), "go");
    const result = await pending;
    try {
      expect(result).toMatchObject({ status: "setup_failed", pid: null, complete: false, recorded: true, cleanup: { status: "kept" } });
      expect(result.error).toContain("스크래치 루트의 신원");
      expect(result.error).not.toContain("증거 폴더");
      expect(existsSync(join(scratch, "build", "intrusion"))).toBe(false);
      expect(readdirSync(scratch).sort()).toEqual(["build", "cache", "foreign-marker", "tmp", "work"]);
      expect(readdirSync(join(scratch, "build"))).toEqual([]);
      expect(result.simulator!.log).toBeNull();
      expect(result.simulator!.teardown).toMatchObject({ status: "removed", error: null });
      f.onlyOtherRemains();
      expect(exitCodeFor(result)).toBe(2);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
      rmSync(`${scratch}-original`, { recursive: true, force: true });
    }
  });

  it("병렬 실행: 같은 simctl 상태를 쓰는 두 실행이 각자 만든 기기만 쓰고 지우며 다른 기기는 그대로다", async () => {
    const f = fixture();
    const [a, b] = await Promise.all([
      runHostVerification(f.options({ label: "par-a", args: [f.checker, f.state, "{simulator}", "0", "1"] })),
      runHostVerification(f.options({ label: "par-b", args: [f.checker, f.state, "{simulator}", "0", "1"] })),
    ]);
    for (const result of [a, b]) {
      expect(result).toMatchObject({ status: "succeeded", complete: true });
      expectRemoved(result);
      expect(stdoutJson(result)).toMatchObject({ udid: result.simulator!.udid, state: "Booted" });
      expect(readFileSync(join(result.evidence.directory, SIMULATOR_LOG_FILE), "utf8")).not.toContain(a === result ? b.simulator!.udid : a.simulator!.udid);
    }
    expect(a.simulator!.udid).not.toBe(b.simulator!.udid);
    expect(f.streams().map((stream) => stream.udid).sort()).toEqual([a.simulator!.udid, b.simulator!.udid].sort());
    f.onlyOtherRemains();
  });

  it("시뮬레이터를 요청하지 않은 실행의 {simulator} 토큰은 시작 전에 거절한다", async () => {
    const f = fixture();
    const evidence = join(f.root, "evidence-token");
    await expect(runHostVerification({ label: "tok", command: process.execPath, args: ["-e", "0", "{simulator}"], cwd: f.source, evidenceDirectory: evidence }))
      .rejects.toThrow("{simulator}");
    expect(existsSync(evidence)).toBe(false);
    f.onlyOtherRemains();
  });
});

describe("호스트 검증 CLI — 시뮬레이터 옵션", () => {
  const cli = join(import.meta.dirname, "../src/server/hostVerificationCli.ts");
  const run = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", cli, ...args], { cwd: join(import.meta.dirname, ".."), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.once("close", (code) => resolveRun({ code, stdout, stderr }));
  });

  it("--help 가 관리형 시뮬레이터 iOS 예를 보여 주고, --simulator-device 없는 하위 옵션은 사용법 오류(2)다", async () => {
    const help = await run(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--simulator-device");
    expect(help.stdout).toContain("-destination id={simulator}");
    const misuse = await run(["--label", "x", "--simulator-runtime", "iOS-27-2", "--", process.execPath, "-e", "0"]);
    expect(misuse.code).toBe(2);
    expect(misuse.stderr).toContain("--simulator-device 와 함께");
  }, 30_000);
});
