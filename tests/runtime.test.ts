import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, unlinkSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentResult, PlanRepair } from "../src/shared/contracts.js";
import { runRuntimeCLI } from "../src/server/runtime/cli.js";
import { invokeAdapter } from "../src/server/runtime/invoke.js";
import { createRuntimeAdapters } from "../src/server/runtime/providers.js";
import type { RuntimeEvent } from "../src/server/runtime/protocol.js";
import type { AgentAdapter, CommandSpec, SessionTurn } from "../src/server/types.js";
import { SpawnCommandRunner } from "../src/server/processRunner.js";
import type { TurnJob } from "../src/shared/roles.js";

const roots: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "cr-runtime-")); roots.push(root);
  const cwd = join(root, "repo"); mkdirSync(cwd);
  execFileSync("git", ["-C", cwd, "init", "-q"], { stdio: "pipe" });
  return { root, cwd, data: join(root, "data") };
}
const result: AgentResult = { kind: "IMPLEMENTATION", summary: "ok", findings: [], evidenceRefs: [], status: "completed" };
const id = "11111111-1111-4111-8111-111111111111";
function fakeAdapter(): AgentAdapter {
  return { role: "claude", createSession: vi.fn(async () => ({ sessionId: id, result })),
    resumeTurn: vi.fn(async () => result), validateExistingSession: vi.fn(async () => true) };
}
function request(cwd: string) {
  return { version: 1, requestId: "request-1", provider: "claude", session: { mode: "create" },
    resultKind: "agent", job: { role: "implementer", operation: "implement" }, cwd, prompt: "한글 입력 유지",
    settings: { model: "opus", effort: "xhigh" }, providerOptions: { ultracode: true } };
}
function sink() {
  const events: RuntimeEvent[] = [];
  const output = new Writable({ write(chunk, _encoding, callback) {
    events.push(JSON.parse(chunk.toString())); callback();
  } });
  return { output, events };
}
async function execute(input: unknown, data: string, adapter: AgentAdapter = fakeAdapter(), signal?: AbortSignal) {
  const { output, events } = sink();
  const factory = vi.fn(() => adapter);
  const status = await runRuntimeCLI({ input: Readable.from([typeof input === "string" ? input : JSON.stringify(input)]),
    output, args: ["--data-directory", data], adapterFactory: factory, signal });
  return { status, events, factory };
}

describe("runtime CLI 요청과 이벤트 계약", () => {
  it("Codex 확인 턴은 도구를 닫고 같은 세션의 다음 구현 턴에서만 다시 연다", async () => {
    const f = fixture();
    vi.stubEnv("CODEX_HOME", join(f.root, "user-home"));
    const calls: Array<{ config: string; spec: CommandSpec }> = [];
    const adapter = createRuntimeAdapters({ run: async spec => {
      calls.push({ spec, config: readFileSync(join(spec.environment!.CODEX_HOME!, "config.toml"), "utf8") });
      const jsonLines = [{ type: "thread.started", thread_id: id },
        { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }];
      return { exitCode: 0, stdout: jsonLines.map(line => JSON.stringify(line)).join("\n"), stderr: "", jsonLines };
    } }, { dataDirectory: f.data }).codex;
    // 공개 요청부터 실제 어댑터가 CLI 소비자에게 넘기는 설정까지 검사한다. 다음 일반 턴에 제한이 남지 않는지도 확인한다.
    const jobs: TurnJob[] = [{ role: "planner", operation: "ack" }, { role: "reviewer", operation: "ack" },
      { role: "reviewer", operation: "answer-confirmation" }, { role: "implementer", operation: "completion-confirmation" },
      // 리뷰 읽기(E3-4c)도 서버가 실은 쪽만 받는 확인 턴이다 — 도구·지시문을 닫는다.
      { role: "reviewer", operation: "review-read" },
      { role: "implementer", operation: "implement" }];
    for (const [index, job] of jobs.entries()) {
      const actual = await execute({ ...request(f.cwd), provider: "codex", providerOptions: {}, job,
        settings: { model: "gpt-6-astra", effort: "medium" },
        session: index === 0 ? { mode: "create" } : { mode: "resume", sessionId: id } }, f.data, adapter);
      expect(actual.status).toBe(0);
      expect(actual.events.at(-1)).toMatchObject({ type: "result", sessionId: id });
      const { config, spec } = calls[index];
      if (index < 5) {
        expect(config).toContain("project_doc_max_bytes = 0");
        for (const feature of ["shell_tool", "unified_exec", "multi_agent", "view_image", "apps", "browser_use",
          "computer_use", "plugins", "memories", "code_mode_host", "workspace_dependencies", "skill_search", "image_generation"]) {
          expect(config, `${job.role}/${job.operation}: ${feature}`).toContain(`${feature} = false`);
        }
        expect(config).toContain("web_search = false");
        expect(config).toContain("[features.multi_agent_v2]\nenabled = false");
        expect(config).toContain('default_permissions = "consensus-review"');
      } else {
        expect(config).not.toContain("shell_tool = false");
        expect(config).toContain("project_doc_max_bytes = 0");
        expect(config).toContain('default_permissions = "consensus-implement"');
      }
      expect(spec.args).toContain('model_reasoning_effort="medium"');
      if (index > 0) {
        const resume = spec.args.indexOf("resume");
        expect(resume).toBeGreaterThan(0);
        expect(spec.args.slice(resume - 1, resume + 2)).toEqual(["exec", "resume", id]);
      }
    }
  });

  it("세션을 즉시 알리고 원 사용량과 결과를 한 번씩 전달하며 설정은 그대로 보낸다", async () => {
    const f = fixture(); const adapter = fakeAdapter();
    adapter.createSession = vi.fn(async turn => {
      expect(turn).toMatchObject({ job: { role: "implementer", operation: "implement" }, implementation: true,
        protocolOnly: false, prompt: "한글 입력 유지", settings: { model: "opus", effort: "xhigh" },
        providerOptions: { ultracode: true } });
      turn.onSessionCreated?.(id);
      turn.onUsage?.({ executionId: "exec1", recordKind: "progress", inputTokens: 8 });
      turn.onUsage?.({ executionId: "exec1", recordKind: "final", inputTokens: 12, cachedInputTokens: 8 });
      return { sessionId: id, result };
    });
    const actual = await execute(request(f.cwd), f.data, adapter);
    expect(actual.status).toBe(0);
    expect(actual.events).toEqual([
      { version: 1, requestId: "request-1", sequence: 1, type: "session", sessionId: id },
      { version: 1, requestId: "request-1", sequence: 2, type: "usage", usage: { executionId: "exec1", recordKind: "progress", inputTokens: 8 } },
      { version: 1, requestId: "request-1", sequence: 3, type: "usage", usage: { executionId: "exec1", recordKind: "final", inputTokens: 12, cachedInputTokens: 8 } },
      { version: 1, requestId: "request-1", sequence: 4, type: "result", sessionId: id, result },
    ]);
  });

  it.each([
    { version: 2 }, { unexpected: true }, { job: { role: "planner", operation: "implement" } },
    { providerOptions: { ultracod: true } }, { settings: { model: "opus", effort: "ultracode" } },
    { settings: { model: "opus", effort: "xhigh", implementation: { model: "opus", effort: "xhigh" } } },
    { session: { mode: "resume" } }, { session: { mode: "resume", sessionId: "--dangerously-skip-permissions" } },
    { session: { mode: "resume", sessionId: " " } }, { cwd: "relative" }, { readablePaths: ["relative"] },
    { resultKind: "plan-repair" }, { job: { role: "planner", operation: "plan-repair" } },
    { figmaReadEnabled: true }, { session: { mode: "create", sessionId: id } },
  ])("해석할 수 없는 요청은 어댑터 생성 전에 거부한다: %j", async patch => {
    const f = fixture(); const actual = await execute({ ...request(f.cwd), ...patch }, f.data);
    expect(actual.status).toBe(1);
    expect(actual.factory).not.toHaveBeenCalled();
    expect(actual.events).toEqual([expect.objectContaining({ type: "error", code: "INVALID_REQUEST" })]);
  });

  it("잘못된 JSON·두 요청·잘못된 인자는 실행하지 않는다", async () => {
    const f = fixture();
    for (const source of ["{", `${JSON.stringify(request(f.cwd))}\n${JSON.stringify(request(f.cwd))}`]) {
      const actual = await execute(source, f.data);
      expect(actual.factory).not.toHaveBeenCalled(); expect(actual.status).toBe(1);
    }
    const actual = await execute(request(f.cwd), "relative-data");
    expect(actual.factory).not.toHaveBeenCalled();
    expect(actual.events[0]).toMatchObject({ type: "error", code: "INVALID_CONFIGURATION" });
  });

  it("Git 루트가 아닌 폴더는 공통 제어 검사에 들어가기 전에 거부한다", async () => {
    const f = fixture(); const subdir = join(f.cwd, "nested"); mkdirSync(subdir);
    for (const cwd of [f.root, subdir]) {
      const actual = await execute(request(cwd), f.data);
      expect(actual.factory).not.toHaveBeenCalled(); expect(actual.status).toBe(1);
      expect(actual.events[0]).toMatchObject({ type: "error", code: "INVALID_CONFIGURATION" });
    }
  });

  it("작업 폴더와 데이터의 포함 관계는 심볼릭 링크 뒤에도 거부한다", async () => {
    const f = fixture(); symlinkSync(f.cwd, join(f.root, "alias"));
    for (const data of [f.cwd, f.root, join(f.cwd, "..managed-home"), join(f.root, "alias", "new-data")]) {
      const actual = await execute(request(f.cwd), data);
      expect(actual.factory).not.toHaveBeenCalled(); expect(actual.status).toBe(1);
      expect(actual.events[0]).toMatchObject({ type: "error", code: "INVALID_CONFIGURATION" });
    }
  });

  it("대소문자를 구분하지 않는 볼륨에서도 데이터 폴더가 작업 폴더 안에 들어갈 수 없다", async ({ skip }) => {
    const f = fixture(); const alias = join(f.root, "REPO");
    if (!existsSync(alias)) skip();
    for (const data of [alias, join(alias, "runtime-data")]) {
      const actual = await execute(request(f.cwd), data);
      expect(actual.factory).not.toHaveBeenCalled();
      expect(actual.events[0]).toMatchObject({ type: "error", code: "INVALID_CONFIGURATION" });
    }
  });

  it("실패한 호출의 세션·부분 사용량을 보존하고 이후 같은 세션을 재개한다", async () => {
    const f = fixture(); const adapter = fakeAdapter();
    adapter.createSession = vi.fn(async turn => {
      turn.onSessionCreated?.(id); turn.onUsage?.({ completeness: "partial", inputTokens: 17 });
      throw new Error("provider interrupted");
    });
    const first = await execute(request(f.cwd), f.data, adapter);
    expect(first.events.map(event => event.type)).toEqual(["session", "usage", "error"]);
    expect(first.status).toBe(1);
    const second = await execute({ ...request(f.cwd), session: { mode: "resume", sessionId: id } }, f.data, adapter);
    expect(adapter.createSession).toHaveBeenCalledTimes(1);
    expect(adapter.resumeTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
    expect(second.events.at(-1)).toMatchObject({ type: "result", sessionId: id });
  });

  it("resume 실패는 새 호출로 바뀌지 않으며 잘못 배정된 공급자도 호출하지 않는다", async () => {
    const f = fixture(); const adapter = fakeAdapter();
    adapter.resumeTurn = vi.fn(async () => { throw new Error("No conversation found with session ID"); });
    const actual = await execute({ ...request(f.cwd), session: { mode: "resume", sessionId: id } }, f.data, adapter);
    expect(actual.status).toBe(1); expect(adapter.createSession).not.toHaveBeenCalled();
    const mismatch = await execute({ ...request(f.cwd), provider: "codex", providerOptions: {} }, f.data, adapter);
    expect(mismatch.status).toBe(1); expect(adapter.createSession).not.toHaveBeenCalled();
  });

  it("계획 교정은 지원하는 어댑터의 기존 세션으로만 전달한다", async () => {
    const f = fixture(); const adapter = fakeAdapter();
    const repair: PlanRepair = { baseSHA256: "a".repeat(64), edits: [{ find: "old", replace: "new" }] };
    adapter.resumePlanRepair = vi.fn(async turn => { expect(turn.protocolOnly).toBe(true); return repair; });
    const input = { ...request(f.cwd), resultKind: "plan-repair", job: { role: "planner", operation: "plan-repair" },
      session: { mode: "resume", sessionId: id } };
    const actual = await execute(input, f.data, adapter);
    expect(actual.events.at(-1)).toMatchObject({ type: "result", result: repair, sessionId: id });
    const unsupported = await execute(input, f.data);
    expect(unsupported.status).toBe(1);
    expect(unsupported.events[0]).toMatchObject({ type: "error", code: "EXECUTION_FAILED" });
  });

  it("CLI도 제어 파일 변경을 시작 전과 쓰기 후 거부하고 복구 뒤 같은 세션을 재개한다", async () => {
    const f = fixture();
    for (const args of [["init", "-q"], ["-c", "user.name=Test", "-c", "user.email=test@example.invalid",
      "commit", "--allow-empty", "-qm", "baseline"]]) {
      execFileSync("git", ["-C", f.cwd, ...args], { stdio: "pipe" });
    }
    const planted = join(f.cwd, "aGeNtS.md");
    const adapter = fakeAdapter();
    writeFileSync(planted, "untrusted instructions");
    const before = await execute(request(f.cwd), f.data, adapter);
    expect(before.status).toBe(1); expect(adapter.createSession).not.toHaveBeenCalled();
    expect(before.events[0]).toMatchObject({ type: "error", code: "EXECUTION_FAILED" });
    unlinkSync(planted);
    adapter.createSession = vi.fn(async turn => {
      turn.onSessionCreated?.(id); writeFileSync(planted, "untrusted instructions");
      return { sessionId: id, result };
    });
    const after = await execute(request(f.cwd), f.data, adapter);
    expect(after.status).toBe(1);
    expect(after.events.map(event => event.type)).toEqual(["session", "error"]);
    expect(after.events.at(-1)).toMatchObject({ message: expect.stringContaining("러너 제어 경로") });
    unlinkSync(planted);
    const recovered = await execute({ ...request(f.cwd), session: { mode: "resume", sessionId: id } }, f.data, adapter);
    expect(recovered.status).toBe(0);
    expect(adapter.resumeTurn).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id }));
  });

  it("이미 취소된 요청은 실행하지 않고 입력 대기 중 취소도 끝난다", async () => {
    const f = fixture(); const controller = new AbortController(); controller.abort();
    const actual = await execute(request(f.cwd), f.data, fakeAdapter(), controller.signal);
    expect(actual.status).toBe(130); expect(actual.factory).not.toHaveBeenCalled();
    const waitingController = new AbortController(); const input = new Readable({ read() {} });
    const { output, events } = sink();
    const waiting = runRuntimeCLI({ input, output, args: ["--data-directory", f.data], signal: waitingController.signal });
    waitingController.abort();
    expect(await waiting).toBe(130);
    expect(events).toEqual([expect.objectContaining({ type: "error", code: "CANCELLED" })]);
  });

  it("실행 중 취소는 프로세스 종료까지 기다리고 성공 결과를 내보내지 않는다", async () => {
    const f = fixture(); const controller = new AbortController(); const adapter = fakeAdapter();
    let onSpawn!: (pid: number) => void;
    const spawned = new Promise<number>(resolve => { onSpawn = resolve; });
    adapter.createSession = async turn => {
      turn.onSessionCreated?.(id);
      await new SpawnCommandRunner().run({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd: f.cwd,
        signal: turn.signal, onSpawn: process => onSpawn(process.pid) });
      return { sessionId: id, result };
    };
    const running = execute(request(f.cwd), f.data, adapter, controller.signal);
    const pid = await spawned; controller.abort();
    const actual = await running;
    expect(actual.status).toBe(130);
    expect(actual.events.map(event => event.type)).toEqual(["session", "error"]);
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("공통 호출과 공급자 생성", () => {
  it("허용 검사·관찰·세션 콜백은 교체하지 않고 같은 객체로 전달한다", async () => {
    const adapter = fakeAdapter();
    const turn: SessionTurn = { cwd: "/tmp", sessionId: id, prompt: "p", job: { role: "planner", operation: "plan" },
      beforeSpawn: vi.fn(), admitSync: vi.fn(), onProcessSpawn: vi.fn(), onUsage: vi.fn(), onSessionCreated: vi.fn(),
      onFigmaResult: vi.fn() };
    await invokeAdapter(adapter, { method: "resume", turn });
    expect(vi.mocked(adapter.resumeTurn).mock.calls[0][0]).toBe(turn);
    const blocked = new Error("admission");
    adapter.resumeTurn = async passed => { passed.admitSync?.(); return result; };
    turn.admitSync = () => { throw blocked; };
    await expect(invokeAdapter(adapter, { method: "resume", turn })).rejects.toBe(blocked);
  });

  it.each(["claude", "codex"] as const)("%s factory는 기존 어댑터 명령·설정·권한을 쓴다", async provider => {
    const f = fixture(); const calls: CommandSpec[] = [];
    const adapters = createRuntimeAdapters({ run: async spec => {
      calls.push(spec);
      const lines = provider === "claude" ? [{ type: "result", subtype: "success", num_turns: 1, structured_output: result }]
        : [{ type: "thread.started", thread_id: id }, { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }];
      return { exitCode: 0, stdout: lines.map(line => JSON.stringify(line)).join("\n"), stderr: "", jsonLines: lines };
    } }, { dataDirectory: f.data });
    const created = await invokeAdapter(adapters[provider], { method: "create", turn: {
      cwd: f.cwd, prompt: "p", job: { role: "implementer", operation: "implement" },
      settings: { model: provider === "claude" ? "opus" : "gpt-6-astra", effort: "xhigh" },
    } });
    expect(created.result).toEqual(result);
    expect(calls).toHaveLength(1);
    if (provider === "claude") {
      const settings = JSON.parse(calls[0].args[calls[0].args.indexOf("--settings") + 1]);
      expect(settings.sandbox.filesystem.denyWrite).toContain(f.data);
      expect(calls[0].args).toContain("xhigh");
    } else {
      expect(calls[0].args).toContain(join(f.data, "agent-result.schema.json"));
      expect(calls[0].args).toContain('model_reasoning_effort="xhigh"');
    }
  });
});

describe("실제 어댑터 spawn 환경 관측", () => {
  it.each(["claude", "codex"] as const)("%s: spawn과 SID 순서를 결합하고 spawn 거부는 기록하지 않는다", async provider => {
    const f = fixture();
    let denied = false;
    const adapters = createRuntimeAdapters({ run: async spec => {
      await spec.beforeSpawn?.(); spec.admitSync?.();
      if (denied) throw new Error("spawn denied");
      spec.onSpawn?.({ pid: 123, pgid: 123, executable: provider, commandLine: provider, startedAt: "2026-01-01T00:00:00.000Z" });
      const jsonLines = provider === "claude"
        ? [{ type: "result", subtype: "success", num_turns: 1, structured_output: result }]
        : [{ type: "thread.started", thread_id: id }, { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }];
      for (const value of jsonLines) spec.onJSONLine?.(value, Date.now());
      return { exitCode: 0, stdout: jsonLines.map(line => JSON.stringify(line)).join("\n"), stderr: "", jsonLines };
    } }, { dataDirectory: f.data });
    const input = { ...request(f.cwd), provider, providerOptions: {}, settings: { model: provider === "claude" ? "opus" : "gpt-6-astra", effort: "high" } };
    const first = await execute(input, f.data, adapters[provider]);
    expect(first.status).toBe(0);
    const environments = first.events.filter(event => event.type === "environment").map(event => event.environment);
    expect(environments.length).toBeGreaterThan(0);
    expect(environments.at(-1)).toMatchObject({ provider, cwd: f.cwd, consumer: "runtime-cli", access: "write",
      model: input.settings.model, effort: "high", hostname: expect.any(String), hostOS: { platform: process.platform, arch: process.arch } });
    expect(environments.at(-1)!.sessionId).toBe(first.events.find(event => event.type === "result")!.sessionId);
    if (provider === "codex") expect(environments[0].sessionId).toBeNull();
    else expect(environments[0].sessionId).toBeTruthy(); // Claude issues ID before spawn.
    denied = true;
    const refused = await execute(input, f.data, adapters[provider]);
    expect(refused.status).not.toBe(0);
    expect(refused.events.filter(event => event.type === "environment" || event.type === "spawn")).toEqual([]);
  });
});


it("keeps the failed Claude spawn under its old SID when recovery allocates and spawns a new session", async () => {
  const f = fixture();
  const environments: import("../src/shared/sessionSettings").SessionEnvironment[] = [];
  let spawns = 0;
  const claude = createRuntimeAdapters({ run: async spec => {
    spawns++;
    spec.onSpawn?.({ pid: 120 + spawns, pgid: 120 + spawns, executable: "claude", commandLine: "claude", startedAt: `2026-01-01T00:00:0${spawns}.000Z` });
    if (spawns === 1) throw new Error("resume failed");
    const jsonLines = [{ type: "result", subtype: "success", num_turns: 1, structured_output: result }];
    return { exitCode: 0, stdout: jsonLines.map(line => JSON.stringify(line)).join("\n"), stderr: "", jsonLines };
  } }, { dataDirectory: f.data }).claude;
  let recoveredId: string | undefined;
  const recovering = { ...claude, resumeTurn: async (turn: SessionTurn) => {
    await expect(claude.resumeTurn(turn)).rejects.toThrow("resume failed");
    const { sessionId: _old, ...fresh } = turn;
    const created = await claude.createSession(fresh);
    recoveredId = created.sessionId;
    return created.result;
  } } as AgentAdapter;
  await expect(invokeAdapter(recovering, { method: "resume", turn: {
    sessionId: id, cwd: f.cwd, prompt: "recover", job: { role: "implementer", operation: "implement" },
    settings: { model: "opus", effort: "high" },
    onExecutionEnvironment: record => environments.push(record),
    onSessionCreated: (_next, phase) => {
      expect(phase).toBe("allocated");
      expect(environments).toHaveLength(1);
      expect(environments[0].sessionId).toBe(id);
    },
  } })).resolves.toEqual(result);
  expect(spawns).toBe(2);
  expect(environments).toHaveLength(2);
  expect(environments.map(record => record.sessionId)).toEqual([id, recoveredId]);
  expect(recoveredId).not.toBe(id);
  expect(environments[0].executionId).not.toBe(environments[1].executionId);
});

it.each(["create", "create-structured"] as const)("does not adopt a rejected Codex SID after the real JSON observer swallows the rejection (%s)", async method => {
  const f = fixture(), runner = new SpawnCommandRunner();
  const environments: import("../src/shared/sessionSettings").SessionEnvironment[] = [];
  const lines = [{ type: "thread.started", thread_id: id }, { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }, { type: "turn.completed", usage: {} }];
  const adapter = createRuntimeAdapters({ run: spec => runner.run({ ...spec, command: process.execPath,
    args: ["-e", `console.log(${JSON.stringify(lines.map(line => JSON.stringify(line)).join("\n"))})`] }) }, { dataDirectory: f.data }).codex;
  const reject = vi.fn(() => { throw new Error("caller rejects SID"); });
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    const turn = { cwd: f.cwd, prompt: "create", job: { role: "implementer", operation: "implement" } as const,
      onSessionCreated: reject, onExecutionEnvironment: (record: import("../src/shared/sessionSettings").SessionEnvironment) => environments.push(record) };
    if (method === "create") await invokeAdapter(adapter, { method, turn });
    else await invokeAdapter(adapter, { method, turn, schema: { type: "object" } });
    expect(reject).toHaveBeenCalled(); expect(warn).toHaveBeenCalledWith(expect.stringContaining("caller rejects SID"));
    expect(environments).toHaveLength(1); expect(environments[0].sessionId).toBeNull();
  } finally { warn.mockRestore(); }
});

it.each([false, true])("keeps a recovered Codex create unknown until its SID is confirmed (%s)", async confirms => {
  const f = fixture();
  const environments: import("../src/shared/sessionSettings").SessionEnvironment[] = [];
  let spawns = 0;
  const next = "22222222-2222-4222-8222-222222222222";
  const codex = createRuntimeAdapters({ run: async spec => {
    spawns++;
    spec.onSpawn?.({ pid: 100 + spawns, pgid: 100 + spawns, executable: "codex", commandLine: "codex", startedAt: "2026-01-01T00:00:00.000Z" });
    if (spawns === 1 || !confirms) throw new Error("stream failed before thread.started");
    const jsonLines = [{ type: "thread.started", thread_id: next }, { type: "item.completed", item: { type: "agent_message", text: JSON.stringify(result) } }];
    for (const value of jsonLines) spec.onJSONLine?.(value, Date.now());
    return { exitCode: 0, stdout: jsonLines.map(line => JSON.stringify(line)).join("\n"), stderr: "", jsonLines };
  } }, { dataDirectory: f.data }).codex;
  const recovering = { ...codex, resumeTurn: async (turn: SessionTurn) => {
    await expect(codex.resumeTurn(turn)).rejects.toThrow("stream failed");
    const { sessionId: _old, ...fresh } = turn;
    return (await codex.createSession(fresh)).result;
  } } as AgentAdapter;
  const promise = invokeAdapter(recovering, { method: "resume", turn: { sessionId: id, cwd: f.cwd, prompt: "recover",
    job: { role: "implementer", operation: "implement" }, onExecutionEnvironment: record => environments.push(record) } });
  if (confirms) await expect(promise).resolves.toEqual(result); else await expect(promise).rejects.toThrow("stream failed");
  expect(spawns).toBe(2);
  expect(environments.map(record => record.sessionId)).toEqual(confirms ? [id, null, next] : [id, null]);
  expect(environments[0].executionId).not.toBe(environments[1].executionId);
  if (confirms) expect(environments[2].executionId).toBe(environments[1].executionId);
});

it.each([true, false])("resume SID rotation changes environment ownership only after caller acceptance (%s)", async accepted => {
  const environments: import("../src/shared/sessionSettings").SessionEnvironment[] = [];
  const next = "22222222-2222-4222-8222-222222222222";
  const observed: import("../src/shared/sessionSettings").SessionEnvironment = {
    executionId: "actual-spawn-1", sessionId: null, provider: "claude", consumer: "consensus-engine",
    spawnedAt: "2026-01-01T00:00:00.000Z", cwd: "/tmp", hostname: "test-host",
    hostOS: { platform: "darwin", release: "test", arch: "arm64" }, isolated: false,
    workspace: "git", access: "read", sandbox: "observed", model: "opus", effort: "high",
  };
  const adapter = fakeAdapter();
  adapter.resumeTurn = async turn => {
    turn.onExecutionEnvironment?.(observed);
    turn.onSessionCreated?.(next);
    return result;
  };
  const promise = invokeAdapter(adapter, { method: "resume", turn: {
    sessionId: id, cwd: "/tmp", prompt: "resume", job: { role: "reviewer", operation: "audit" },
    onExecutionEnvironment: record => environments.push(record),
    onSessionCreated: returned => {
      expect(returned).toBe(next);
      expect(environments.at(-1)?.sessionId).toBe(id); // not reassigned before identity validation
      if (!accepted) throw new Error("identity mismatch");
    },
  } });
  if (accepted) {
    await expect(promise).resolves.toEqual(result);
    expect(environments.map(record => record.sessionId)).toEqual([id, next]);
  } else {
    await expect(promise).rejects.toThrow("identity mismatch");
    expect(environments.map(record => record.sessionId)).toEqual([id]);
  }
  expect(environments.every(record => record.executionId === observed.executionId)).toBe(true);
});
