import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../src/server/runtime/protocol.js";

const roots: string[] = [];
const children = new Set<ChildProcessWithoutNullStreams>();
afterEach(() => {
  for (const child of children) child.kill("SIGKILL"); children.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function setup(mode: "success" | "wait") {
  const root = mkdtempSync(join(tmpdir(), "cr-runtime-cli-")); roots.push(root);
  const repo = join(root, "repo"); const bin = join(root, "bin"); mkdirSync(repo); mkdirSync(bin);
  execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "pipe" });
  const started = join(root, "started.json");
  // 실제 모델 호출을 제어 가능한 공급자 프로세스로 치환한다. CLI/어댑터/프로세스 runner는 생산 경로다.
  writeFileSync(join(bin, "claude"), `#!${process.execPath}
const fs = require('node:fs');
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', x => input += x);
process.stdin.on('end', () => {
  const marker = ${JSON.stringify(started)};
  fs.writeFileSync(marker + '.tmp', JSON.stringify({pid:process.pid,args:process.argv.slice(2),input}));
  fs.renameSync(marker + '.tmp', marker);
  if (${JSON.stringify(mode)} === 'wait') { setInterval(() => {},1000); return; }
  console.log(JSON.stringify({type:'result',subtype:'success',num_turns:1,usage:{input_tokens:4,output_tokens:2},
    structured_output:{kind:'IMPLEMENTATION',summary:'fixture done',findings:[],evidenceRefs:[],status:'completed'}}));
});
`, { mode: 0o755 });
  return { root, repo, bin, started, data: join(root, "data") };
}
function launch(f: ReturnType<typeof setup>, session: object = { mode: "create" }) {
  const child = spawn(process.execPath, ["--import", "tsx", join(process.cwd(), "src/server/runtime/cli.ts"),
    "--data-directory", f.data], { env: { ...process.env, PATH: `${f.bin}:${process.env.PATH}` }, stdio: "pipe" });
  children.add(child);
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
  const completion = new Promise<{ code: number | null; events: RuntimeEvent[]; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => {
      children.delete(child);
      try { resolve({ code, events: stdout.trim().split("\n").filter(Boolean).map(line => JSON.parse(line)), stderr }); }
      catch (error) { reject(error); }
    });
  });
  child.stdin.end(JSON.stringify({ version: 1, requestId: "subprocess-1", provider: "claude", session,
    resultKind: "agent", job: { role: "implementer", operation: "implement" }, cwd: f.repo,
    prompt: "한글 CLI 입력", settings: { model: "opus", effort: "xhigh" }, providerOptions: { ultracode: false } }));
  return { child, completion };
}
function waitForFile(path: string, directory: string): { ready: Promise<void>; close: () => void } {
  let resolveReady!: () => void;
  const ready = new Promise<void>(resolve => { resolveReady = resolve; });
  const watcher = watch(directory, () => { if (existsSync(path)) resolveReady(); });
  if (existsSync(path)) resolveReady();
  return { ready, close: () => watcher.close() };
}

describe("서버 없는 runtime CLI subprocess", () => {
  it("stdin을 공급자에 전달하고 순수 JSONL을 내보내며 같은 ID를 다음 프로세스에서 재개한다", async () => {
    const f = setup("success");
    const first = await launch(f).completion;
    expect(first.code).toBe(0);
    expect(first.events.at(-1)).toMatchObject({ type: "result", result: { summary: "fixture done" } });
    const terminal = first.events.at(-1);
    if (terminal?.type !== "result") throw new Error("missing result");
    expect(first.events.filter(event => event.type === "session")).toHaveLength(1);
    const second = await launch(f, { mode: "resume", sessionId: terminal.sessionId }).completion;
    expect(second.code).toBe(0);
    expect(second.events.at(-1)).toMatchObject({ type: "result", sessionId: terminal.sessionId });
    const invocation = JSON.parse(readFileSync(f.started, "utf8"));
    expect(invocation.args).toContain("--resume");
    expect(invocation.args).toContain(terminal.sessionId);
    expect(invocation.input).toContain("한글 CLI 입력");
    expect(invocation.args).toContain("xhigh");
    const settings = JSON.parse(invocation.args[invocation.args.indexOf("--settings") + 1]);
    expect(settings).not.toHaveProperty("ultracode");
  }, 20_000);

  it("SIGTERM은 실행 중 공급자를 종료한 다음 CANCELLED와 종료 코드 130을 반환한다", async () => {
    const f = setup("wait"); const started = waitForFile(f.started, f.root);
    const running = launch(f);
    try {
      // 공급자가 stdin을 읽었다는 실제 경계. 일찍 죽은 프로세스도 기다림에서 풀린다.
      await Promise.race([started.ready, running.completion.then(() => { throw new Error("provider did not start"); })]);
      const { pid } = JSON.parse(readFileSync(f.started, "utf8"));
      running.child.kill("SIGTERM");
      const actual = await running.completion;
      expect(actual.code).toBe(130);
      expect(actual.events.at(-1)).toMatchObject({ type: "error", code: "CANCELLED" });
      expect(actual.events.some(event => event.type === "result")).toBe(false);
      expect(() => process.kill(pid, 0)).toThrow();
    } finally { started.close(); }
  }, 20_000);
});
