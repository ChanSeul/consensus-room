import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { afterEach } from "vitest";
import { describe, expect, it } from "vitest";

import { buildIsolationSettings, ClaudeAdapter } from "../src/server/adapters/claude";
import { CodexAdapter } from "../src/server/adapters/codex";
import type { CommandResult, CommandRunner, CommandSpec, TurnUsage } from "../src/server/types";
import { agentEnvironment } from "../src/server/security";
import { DEFAULT_AGENT_SETTINGS } from "../src/shared/contracts";

const planResult = {
  kind: "PLAN",
  summary: "계획을 작성했습니다.",
  findings: [],
  evidenceRefs: [],
};

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function codexAdapter(
  runner: CommandRunner,
  options: ConstructorParameters<typeof CodexAdapter>[4] = {},
): { adapter: CodexAdapter; codexHome: string } {
  const directory = mkdtempSync(join(tmpdir(), "consensus-room-codex-schema-"));
  temporaryDirectories.push(directory);
  const codexHome = join(directory, "codex-home");
  return {
    adapter: new CodexAdapter(runner, join(directory, "agent-result.schema.json"), codexHome, undefined, options),
    codexHome,
  };
}

class RecordingRunner implements CommandRunner {
  readonly calls: CommandSpec[] = [];

  constructor(private readonly result: CommandResult) {}

  async run(spec: CommandSpec): Promise<CommandResult> {
    this.calls.push(spec);
    return this.result;
  }
}

function successfulResult(jsonLines: unknown[]): CommandResult {
  return {
    exitCode: 0,
    stdout: jsonLines.map((line) => JSON.stringify(line)).join("\n"),
    stderr: "",
    jsonLines,
  };
}

function memoryDocument(name: string, body: string): string {
  return `---\nname: ${name}\ndescription: 테스트 메모리\nmetadata:\n  platform: shared\n  type: reference\n---\n\n${body}\n`;
}

describe("에이전트별 권한 경계", () => {
  it("Claude와 Codex에는 선별된 메모리 본문만 주고 메모리 폴더 직접 접근 권한은 주지 않는다", async () => {
    const memoryRoot = mkdtempSync(join(tmpdir(), "consensus-room-adapter-memory-"));
    temporaryDirectories.push(memoryRoot);
    mkdirSync(join(memoryRoot, "claude-only"));
    mkdirSync(join(memoryRoot, "codex-only"));
    writeFileSync(join(memoryRoot, "context-router.md"), memoryDocument(
      "context-router",
      "- 숏폼: [미디어 계약](shortform-media-contract.md)",
    ));
    writeFileSync(join(memoryRoot, "shortform-media-contract.md"), memoryDocument(
      "shortform-media-contract",
      "숏폼 영상 재생 계약",
    ));
    const claudeRunner = new RecordingRunner(successfulResult([planResult]));
    const codexRunner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      planResult,
    ]));
    const codexDirectory = mkdtempSync(join(tmpdir(), "consensus-room-codex-memory-"));
    temporaryDirectories.push(codexDirectory);

    await new ClaudeAdapter(claudeRunner, memoryRoot).createSession({
      prompt: "숏폼 계획",
      cwd: "/tmp",
    });
    await new CodexAdapter(
      codexRunner,
      join(codexDirectory, "schema.json"),
      join(codexDirectory, "home"),
      memoryRoot,
    ).createSession({ prompt: "숏폼 검토", cwd: "/tmp" });

    for (const call of [claudeRunner.calls[0], codexRunner.calls[0]]) {
      expect(call.stdin).toContain("메모리 문서 시작: context-router.md");
      expect(call.stdin).toContain("메모리 문서 시작: shortform-media-contract.md");
      expect(call.stdin).toContain("모델 프로세스에는 메모리 폴더 접근 권한이 없습니다");
      expect(call.args).not.toContain("--add-dir");
      expect(call.args).not.toContain(memoryRoot);
    }
    const claudeArgs = claudeRunner.calls[0].args;
    const claudeSettings = JSON.parse(claudeArgs[claudeArgs.indexOf("--settings") + 1]) as {
      sandbox: { filesystem: { allowRead: string[]; allowWrite: string[] } };
    };
    expect(claudeSettings.sandbox.filesystem.allowRead).not.toContain(memoryRoot);
    expect(claudeSettings.sandbox.filesystem.allowWrite).not.toContain(memoryRoot);
  });

  it("사용자가 Codex 계획 검토를 시작하면 항상 세밀한 읽기 전용 프로필·승인 없음으로 실행한다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      planResult,
    ]));
    const { adapter, codexHome } = codexAdapter(runner);

    await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: "/tmp" });

    expect(runner.calls).toHaveLength(1);
    expect(runner.calls[0]).toMatchObject({ cwd: "/tmp" });
    // PATH가 준 심볼릭 링크가 아니라 실제 경로로 실행해야 한다. codex가 AGENTS.md를 읽을 때 자기
    // 실행 파일을 sandbox-exec로 재실행하는데, 링크가 profile이 열지 않은 홈 아래에 있으면 거부된다.
    const command = runner.calls[0].command;
    expect(command.endsWith("/codex") || command === "codex").toBe(true);
    if (command !== "codex") {
      expect(isAbsolute(command)).toBe(true);
      // 실제 경로로 실행하는 것만으로는 부족하다 — 그 경로가 profile의 읽기 허용에도 있어야 한다.
      const content = readFileSync(join(adapter.managedHomeFor("/tmp"), "config.toml"), "utf8");
      expect(content).toContain(`"${command}" = "read"`);
    }
    expect(runner.calls[0].args.slice(0, 3)).toEqual(["--strict-config", "-a", "never"]);
    expect(runner.calls[0].args).not.toContain("-s");
    expect(runner.calls[0].args).not.toContain("workspace-write");
    expect(runner.calls[0].args).not.toContain("danger-full-access");
  });

  it("사용자가 Codex 기존 세션을 이어도 읽기 전용 옵션을 resume 앞에 둔다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const { adapter } = codexAdapter(runner);

    await adapter.resumeTurn({
      sessionId: "codex-thread-1",
      prompt: "수정 계획을 다시 검토해 주세요.",
      cwd: "/tmp",
    });

    // 2026-09-06 사용자 지시로 service_tier="priority" 를 뺐다(prolite 플랜 사용량 보호) — 기본(normal) 티어는 키를 넘기지 않는다.
    // 모델·추론은 정본(DEFAULT_AGENT_SETTINGS)에서 읽는다 — 리터럴로 박으면 기본값을 바꿀 때마다 이 단정이 어긋난다.
    expect(runner.calls[0].args.slice(0, 12)).toEqual([
      "--strict-config", "-a", "never",
      "-m", DEFAULT_AGENT_SETTINGS.codex.model, "-c", `model_reasoning_effort="${DEFAULT_AGENT_SETTINGS.codex.effort}"`,
      "exec", "resume", "codex-thread-1", "--json", "--output-schema",
    ]);
    expect(runner.calls[0].args.at(-1)).toBe("-");
    expect(runner.calls[0].stdin).toContain("실행 규칙:");
    expect(runner.calls[0].stdin?.endsWith("수정 계획을 다시 검토해 주세요.")).toBe(true);
  });

  it("Codex 턴은 사용자 홈이 아니라 앱이 관리하는 CODEX_HOME으로 실행한다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      planResult,
    ]));
    const { adapter, codexHome } = codexAdapter(runner);

    await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: "/tmp" });

    // 토픽(worktree)별 관리형 홈 — 공유 홈 아래 topics/<sha256(cwd)[:16]> (2026-09-07 병렬화).
    expect(runner.calls[0].environment?.CODEX_HOME).toBe(adapter.managedHomeFor("/tmp"));
    expect(runner.calls[0].environment?.CODEX_HOME?.startsWith(codexHome)).toBe(true);
    expect(runner.calls[0].environment?.CODEX_HOME).not.toBe(join(homedir(), ".codex"));
    expect(runner.calls[0].args.slice(0, 3)).toEqual(["--strict-config", "-a", "never"]);
  });

  it("관리형 CODEX_HOME의 config.toml에는 MCP·notify·plugins·설정출처 항목이 없다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      planResult,
    ]));
    const { adapter, codexHome } = codexAdapter(runner);

    await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: "/tmp" });

    const configPath = join(adapter.managedHomeFor("/tmp"), "config.toml");
    const content = readFileSync(configPath, "utf8");
    for (const section of ["mcp_servers", "notify", "plugins", "marketplaces", "shell_environment_policy"]) {
      expect(content).not.toContain(section);
    }
    expect(content).toContain('default_permissions = "consensus-review"');
    expect(content).toContain('[permissions.consensus-review.filesystem]');
    expect(content).not.toContain('sandbox_mode = "read-only"');
    expect(content).toContain('approval_policy = "never"');
    expect(content).not.toContain("danger-full-access");
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  it("관리형 config.toml이 방 밖에서 오염돼도 다음 턴에 사라진다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      planResult,
    ]));
    const { adapter } = codexAdapter(runner);
    const topicHome = adapter.managedHomeFor("/tmp");
    mkdirSync(topicHome, { recursive: true });
    writeFileSync(
      join(topicHome, "config.toml"),
      'sandbox_mode = "danger-full-access"\n[mcp_servers.node_repl]\ncommand = "node_repl"\n',
    );

    await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: "/tmp" });

    const content = readFileSync(join(topicHome, "config.toml"), "utf8");
    expect(content).not.toContain("mcp_servers");
    expect(content).not.toContain("danger-full-access");
  });

  it("Codex 모델 설정은 사용자 config를 복사하지 않고 매 호출 CLI 인자로 명시한다", async () => {
    const userCodexHome = mkdtempSync(join(tmpdir(), "consensus-room-codex-user-home-"));
    temporaryDirectories.push(userCodexHome);
    writeFileSync(join(userCodexHome, "config.toml"), [
      'model = "gpt-5.6-sol"',
      'model_reasoning_effort = "xhigh"',
      'model_provider = "third-party"',
      'sandbox_mode = "danger-full-access"',
      'notify = ["/tmp/turn-ended"]',
      "",
      "[mcp_servers.node_repl]",
      'command = "/tmp/node_repl"',
      'model = "섹션 안의 값"',
      "",
    ].join("\n"));
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = userCodexHome;
    try {
      const runner = new RecordingRunner(successfulResult([
        { type: "thread.started", thread_id: "codex-thread-1" },
        planResult,
      ]));
      const { adapter, codexHome } = codexAdapter(runner);

      await adapter.createSession({
        prompt: "계획을 검토해 주세요.",
        cwd: "/tmp",
        settings: { model: "gpt-5.6-terra", effort: "high" },
      });

      const content = readFileSync(join(adapter.managedHomeFor("/tmp"), "config.toml"), "utf8");
      // 사용자 모델 설정은 CLI 인자로만 간다. V2 하위 에이전트는 별도 override 없이 Root 설정을 상속한다.
      expect(content).not.toMatch(/^model =/m);
      expect(content).not.toContain("default_subagent_model");
      expect(content).not.toContain("model_reasoning_effort");
      expect(content).toContain('default_permissions = "consensus-review"');
      expect(content).not.toContain('sandbox_mode = "read-only"');
      expect(content).not.toContain("model_provider");
      expect(content).not.toContain("danger-full-access");
      expect(content).not.toContain("notify");
      expect(content).not.toContain("mcp_servers");
      expect(content).not.toContain("섹션 안의 값");
      expect(runner.calls[0].args).toContain("gpt-5.6-terra");
      expect(runner.calls[0].args).toContain('model_reasoning_effort="high"');
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
    }
  });

  it("Codex 세션을 유지한 채 모델과 추론 강도를 바꾸면 다음 resume 호출부터 새 값을 쓴다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const { adapter } = codexAdapter(runner);

    await adapter.resumeTurn({
      sessionId: "codex-thread-1",
      prompt: "첫 검토",
      cwd: "/tmp",
      settings: { model: "gpt-5.6-sol", effort: "max" },
    });
    await adapter.resumeTurn({
      sessionId: "codex-thread-1",
      prompt: "다음 검토",
      cwd: "/tmp",
      settings: { model: "gpt-5.6-luna", effort: "medium" },
    });

    expect(runner.calls.map((call) => call.args.slice(3, 7))).toEqual([
      ["-m", "gpt-5.6-sol", "-c", 'model_reasoning_effort="max"'],
      ["-m", "gpt-5.6-luna", "-c", 'model_reasoning_effort="medium"'],
    ]);
    expect(runner.calls.every((call) => call.args.includes("codex-thread-1"))).toBe(true);
  });

  it("관리형 홈은 사용자 홈의 auth.json을 링크로 참조하고 이미 있는 자격증명은 파괴하지 않는다", async () => {
    const userCodexHome = mkdtempSync(join(tmpdir(), "consensus-room-codex-user-home-"));
    temporaryDirectories.push(userCodexHome);
    writeFileSync(join(userCodexHome, "auth.json"), '{"note":"테스트용 가짜 값"}');
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = userCodexHome;
    try {
      const runner = new RecordingRunner(successfulResult([
        { type: "thread.started", thread_id: "codex-thread-1" },
        planResult,
      ]));
      const { adapter, codexHome } = codexAdapter(runner);
      const managedAuth = join(codexHome, "auth.json");

      await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: "/tmp" });

      expect(lstatSync(managedAuth).isSymbolicLink()).toBe(true);
      expect(readlinkSync(managedAuth)).toBe(join(userCodexHome, "auth.json"));

      rmSync(managedAuth);
      writeFileSync(managedAuth, '{"note":"이미 있던 값"}');
      await adapter.createSession({ prompt: "계획을 다시 검토해 주세요.", cwd: "/tmp" });

      expect(lstatSync(managedAuth).isSymbolicLink()).toBe(false);
      expect(readFileSync(managedAuth, "utf8")).toBe('{"note":"이미 있던 값"}');
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
    }
  });

  it("Codex shell은 worktree·필요한 스킬만 읽고 원본·관리형 인증파일은 읽지 못한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-codex-profile-"));
    temporaryDirectories.push(root);
    const userCodexHome = join(root, "user-codex-home");
    const worktree = join(root, "topic-worktree");
    const skillsRoot = join(root, "global-skills");
    mkdirSync(userCodexHome, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    mkdirSync(join(skillsRoot, "safe-skill"), { recursive: true });
    writeFileSync(join(userCodexHome, "auth.json"), '{"note":"test credential"}');
    writeFileSync(join(skillsRoot, "safe-skill", "SKILL.md"), "---\nname: safe-skill\ndescription: test\n---\n");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = userCodexHome;
    try {
      const runner = new RecordingRunner(successfulResult([
        { type: "thread.started", thread_id: "codex-thread-1" },
        planResult,
      ]));
      const { adapter, codexHome } = codexAdapter(runner, { skillsDirectories: [skillsRoot] });

      await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: worktree });

      const content = readFileSync(join(adapter.managedHomeFor(worktree), "config.toml"), "utf8");
      expect(content).toContain('default_permissions = "consensus-review"');
      expect(content).toContain(`${JSON.stringify(worktree)} = true`);
      // 토픽 홈 자체는 읽기 허용, 그 안의 auth.json 링크는 거부.
      expect(content).toContain(`${JSON.stringify(adapter.managedHomeFor(worktree))} = "read"`);
      expect(content).toContain(`${JSON.stringify(join(adapter.managedHomeFor(worktree), "auth.json"))} = "deny"`);
      expect(content).toContain(`${JSON.stringify(worktree)} = "read"`);
      expect(content).toContain(`${JSON.stringify(join(codexHome, "auth.json"))} = "deny"`);
      expect(content).toContain(`${JSON.stringify(join(userCodexHome, "auth.json"))} = "deny"`);
      expect(content).toContain(`${JSON.stringify(realpathSync(skillsRoot))} = "read"`);
      expect(content).toContain(`${JSON.stringify(join(codexHome, "skills"))} = "read"`);
      expect(content).toContain("[permissions.consensus-review.network]\nenabled = false");
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
    }
  });

  it("승인된 전역 Codex 스킬은 관리형 CODEX_HOME에 native skill로 연결한다", async () => {
    const skillsRoot = mkdtempSync(join(tmpdir(), "consensus-room-codex-skills-"));
    temporaryDirectories.push(skillsRoot);
    mkdirSync(join(skillsRoot, "approved-skill"));
    writeFileSync(join(skillsRoot, "approved-skill", "SKILL.md"), "---\nname: approved-skill\ndescription: test\n---\n");
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      planResult,
    ]));
    const { adapter, codexHome } = codexAdapter(runner, { skillsDirectories: [skillsRoot] });

    await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: "/tmp" });

    const managedSkill = join(codexHome, "skills", "approved-skill");
    expect(lstatSync(managedSkill).isSymbolicLink()).toBe(true);
    expect(readlinkSync(managedSkill)).toBe(realpathSync(join(skillsRoot, "approved-skill")));
  });

  it("전역·프로젝트 AGENTS 규칙은 심볼릭 링크 대상까지 읽되 관리형 홈에서만 발견한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-codex-instructions-"));
    temporaryDirectories.push(root);
    const userCodexHome = join(root, "user-codex-home");
    const workspace = join(root, "workspace");
    const instructionSources = join(root, "instruction-sources");
    mkdirSync(userCodexHome, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(instructionSources, { recursive: true });
    const globalInstructions = join(instructionSources, "global-AGENTS.md");
    const projectInstructions = join(instructionSources, "project-AGENTS.md");
    writeFileSync(globalInstructions, "# global rules\n");
    writeFileSync(projectInstructions, "# project rules\n");
    symlinkSync(globalInstructions, join(userCodexHome, "AGENTS.md"));
    symlinkSync(projectInstructions, join(workspace, "AGENTS.md"));

    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = userCodexHome;
    try {
      const runner = new RecordingRunner(successfulResult([
        { type: "thread.started", thread_id: "codex-thread-1" },
        planResult,
      ]));
      const { adapter, codexHome } = codexAdapter(runner);

      await adapter.createSession({ prompt: "계획을 검토해 주세요.", cwd: workspace });

      const managedInstructions = join(codexHome, "AGENTS.md");
      expect(lstatSync(managedInstructions).isSymbolicLink()).toBe(true);
      expect(readlinkSync(managedInstructions)).toBe(realpathSync(globalInstructions));
      const content = readFileSync(join(adapter.managedHomeFor(workspace), "config.toml"), "utf8");
      expect(content).toContain(`${JSON.stringify(realpathSync(globalInstructions))} = "read"`);
      expect(content).toContain(`${JSON.stringify(realpathSync(projectInstructions))} = "read"`);
    } finally {
      restoreEnvironment("CODEX_HOME", previousCodexHome);
    }
  });

  it("Codex 세션 검증은 관리형 홈의 session_index.jsonl만 본다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const { adapter, codexHome } = codexAdapter(runner);

    expect(await adapter.validateExistingSession("codex-thread-1")).toBe(false);

    mkdirSync(codexHome, { recursive: true });
    writeFileSync(
      join(codexHome, "session_index.jsonl"),
      `${JSON.stringify({ id: "codex-thread-1" })}\n${JSON.stringify({ thread_id: "codex-thread-2" })}\n`,
    );

    expect(await adapter.validateExistingSession("codex-thread-1")).toBe(true);
    expect(await adapter.validateExistingSession("codex-thread-2")).toBe(true);
    expect(await adapter.validateExistingSession("codex-thread-3")).toBe(false);
  });

  it("planMode 턴은 코드 편집이 아닌 plan 권한으로 실행한다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: "/tmp", planMode: true });

    const args = runner.calls[0].args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
    expect(args).not.toContain("bypassPermissions");
    expect(args).not.toContain("acceptEdits");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      sandbox: { filesystem: { denyWrite: string[] } };
    };
    expect(settings.sandbox.filesystem.denyWrite).toContain("/tmp");
  });

  // plan 모드를 끈 읽기 전용 턴도 워크트리를 못 고친다. 쓰기 차단은 plan 모드가 아니라 두 층이 담당한다 —
  // --tools에 Edit/Write가 없고, sandbox가 denyWrite:[workspace]로 Edit·Write·Bash 세 경로를 모두 막는다.
  // 구현(측정) 턴의 빌드 인프라 권한(2026-08-31 S0.2 실측: 없으면 P0에서 즉시 차단).
  // 계획 턴은 전면 차단 유지 — 이 경계가 무너지면 읽기 전용 계약이 깨진다.
  it("구현 턴만 빌드 인프라(state 쓰기·github 네트워크)가 열리고 계획 턴은 닫힌다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "측정을 실행해 주세요.", cwd: "/tmp", implementation: true });
    await adapter.createSession({ prompt: "계획을 감사해 주세요.", cwd: "/tmp" });

    type Settings = {
      sandbox: {
        filesystem: { allowWrite: string[] };
        network: { allowedDomains: string[]; deniedDomains: string[] };
      };
    };
    const implArgs = runner.calls[0].args;
    const impl = JSON.parse(implArgs[implArgs.indexOf("--settings") + 1]) as Settings;
    expect(impl.sandbox.network.allowedDomains).toContain("github.com");
    expect(impl.sandbox.network.allowedDomains).toContain("tuist.dev");
    // actool의 CoreSimulator XPC 요구 — xcodebuild만 sandbox 밖. 계획 턴은 빈 목록이어야 한다.
    // 와일드카드 필수 — "xcodebuild" exact는 인자 붙은 실제 호출과 불일치한다(2026-08-31 실측: 미적용).
    expect((impl.sandbox as unknown as { excludedCommands: string[] }).excludedCommands).toEqual(["xcodebuild *", "xcrun xcodebuild *"]);
    expect(impl.sandbox.network.deniedDomains).toEqual([]);
    expect(impl.sandbox.filesystem.allowWrite.some((path) => path.endsWith("/.local/state/mise"))).toBe(true);
    expect(impl.sandbox.filesystem.allowWrite.some((path) => path.endsWith("/Logs/CoreSimulator"))).toBe(true);
    // tuist 자식 프로세스의 TMPDIR 폴백 경로(getconf DARWIN_USER_TEMP_DIR) — 없으면 install/generate 즉시 실패.
    expect(impl.sandbox.filesystem.allowWrite.some((path) => path.startsWith("/var/folders/"))).toBe(true);
    expect(impl.sandbox.filesystem.allowWrite.some((path) => path.endsWith("org.swift.swiftpm"))).toBe(true);

    const planArgs = runner.calls[1].args;
    const plan = JSON.parse(planArgs[planArgs.indexOf("--settings") + 1]) as Settings;
    expect((plan.sandbox as unknown as { excludedCommands: string[] }).excludedCommands).toEqual([]);
    expect(plan.sandbox.network.allowedDomains).toEqual([]);
    expect(plan.sandbox.network.deniedDomains).toEqual(["*"]);
    expect(plan.sandbox.filesystem.allowWrite.some((path) => path.includes(".local/state"))).toBe(false);
  });

  // 정책 c(2026-08-31): 코드 쓰기 접근이 있는 구현 턴은 웹 도구를 닫는다(유출 표면 최대 조합 제거).
  // 계획 턴은 외부 증거 수집이 정당한 기능이라 웹을 유지한다.
  it("구현 턴은 웹 도구가 닫히고 계획 턴은 열린다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "구현해 주세요.", cwd: "/tmp", implementation: true });
    await adapter.createSession({ prompt: "감사를 반영해 주세요.", cwd: "/tmp" });

    const implArgs = runner.calls[0].args;
    const implTools = implArgs[implArgs.indexOf("--tools") + 1];
    expect(implTools).not.toContain("WebSearch");
    expect(implTools).not.toContain("WebFetch");
    const implSettings = JSON.parse(implArgs[implArgs.indexOf("--settings") + 1]) as { permissions: { allow: string[] } };
    expect(implSettings.permissions.allow).not.toContain("WebSearch");
    expect(implSettings.permissions.allow).not.toContain("WebFetch");

    const planArgs = runner.calls[1].args;
    const planTools = planArgs[planArgs.indexOf("--tools") + 1];
    expect(planTools).toContain("WebSearch");
    expect(planTools).toContain("WebFetch");
  });

  it("planMode가 아닌 읽기 전용 턴은 dontAsk로 돌되 워크트리 쓰기는 sandbox가 막는다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "감사를 반영해 주세요.", cwd: "/tmp" });

    const args = runner.calls[0].args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args[args.indexOf("--tools") + 1]).not.toContain("Edit");
    expect(args[args.indexOf("--tools") + 1]).not.toContain("Write");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      sandbox: { filesystem: { denyWrite: string[]; allowWrite: string[] } };
    };
    expect(settings.sandbox.filesystem.denyWrite).toContain("/tmp");
    expect(settings.sandbox.filesystem.allowWrite).not.toContain("/tmp");
  });

  it("Claude 세션을 유지한 채 모델과 추론 강도를 바꾸면 다음 resume 호출부터 새 값을 쓴다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);
    const sessionId = "11111111-1111-4111-8111-111111111111";

    await adapter.resumeTurn({
      sessionId,
      prompt: "첫 계획",
      cwd: "/tmp",
      settings: { model: "opus", effort: "max" },
    });
    await adapter.resumeTurn({
      sessionId,
      prompt: "다음 계획",
      cwd: "/tmp",
      settings: { model: "sonnet", effort: "medium" },
    });

    expect(runner.calls.map((call) => [
      call.args[call.args.indexOf("--model") + 1],
      call.args[call.args.indexOf("--effort") + 1],
      call.args[call.args.indexOf("--resume") + 1],
    ])).toEqual([
      ["opus", "max", sessionId],
      ["sonnet", "medium", sessionId],
    ]);
  });

  it("사용자가 구현을 승인하면 Claude 구현을 새 세션으로 worktree 전용 격리에서 실행한다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { ...planResult, kind: "IMPLEMENTATION", summary: "구현했습니다." },
    ]));
    const adapter = new ClaudeAdapter(runner);

    const created = await adapter.createSession({
      prompt: "승인한 계획만 구현해 주세요.",
      cwd: "/tmp",
      implementation: true,
    });

    const args = runner.calls[0].args;
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    // 계획 세션을 fork하지 않는다(2026-09-02) — 이력 없는 새 세션 id로 시작하고 resume·fork 인자가 없어야 한다.
    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(created.sessionId);
    expect(args).not.toContain("--fork-session");
    expect(args).not.toContain("--resume");
    // safe-mode는 관리형 플러그인 스킬을 죽여 제거했다(실측). 대체 격리 인자가 전부 있는지로 단정한다.
    expect(args).not.toContain("--safe-mode");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    expect(args).toContain("--strict-mcp-config");
    expect(args).toContain("--no-chrome");
    expect(args).toContain("--strict-mcp-config");
    expect(args[args.indexOf("--setting-sources") + 1]).toBe("");
    // 정책 c(2026-08-31): 구현 턴은 코드 쓰기 접근과 웹의 결합(최대 유출 표면)을 막기 위해 웹 도구를 뺀다.
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Bash,Skill,Edit,Write,Workflow");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      ultracode?: boolean;
      permissions: { allow: string[]; deny: string[] };
      sandbox: { enabled: boolean; failIfUnavailable: boolean; allowUnsandboxedCommands: boolean; network: { deniedDomains: string[] } };
    };
    // 구현 턴만 ultracode를 켠다. effort로 넣으면 CLI가 경고만 찍고 기본값으로 떨어지므로 설정 키여야 한다.
    expect(settings.ultracode).toBe(true);
    // Workflow는 도구 목록만으로는 dontAsk에서 거부된다. allow 규칙이 함께 있어야 실제로 쓸 수 있다.
    expect(settings.permissions.allow).toContain("Workflow");
    expect(settings.permissions.allow).toContain("Edit(//tmp/**)");
    expect(settings.permissions.deny).toContain("Edit(//tmp/.git)");
    expect(settings.sandbox).toMatchObject({
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      // 구현 턴은 빌드 의존성 호스트만 allowlist로 연다(2026-08-31 — 전면 개방 아님).
      network: { deniedDomains: [], allowedDomains: expect.arrayContaining(["github.com"]) },
    });
    expect(runner.calls[0].stdin).toContain("실행 규칙:");
    expect((runner.calls[0].stdin)?.endsWith("승인한 계획만 구현해 주세요.")).toBe(true);
    expect(args).not.toContain("승인한 계획만 구현해 주세요.");
    expect(created.result.kind).toBe("IMPLEMENTATION");
  });

  it("스킬은 관리형 플러그인으로만 로드하고 전면 비활성 플래그는 쓰지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-claude-plugin-"));
    temporaryDirectories.push(root);
    const source = join(root, "source-skills");
    mkdirSync(join(source, "probe"), { recursive: true });
    writeFileSync(join(source, "probe", "SKILL.md"), "---\nname: probe\n---\n검증용 스킬");
    mkdirSync(join(source, "no-manifest"), { recursive: true });
    const pluginDirectory = join(root, "claude-plugin");
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, undefined, {
      skillsDirectories: [source],
      managedPluginDirectory: pluginDirectory,
    });

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: "/tmp" });

    const args = runner.calls[0].args;
    expect(args).not.toContain("--disable-slash-commands");
    expect(args[args.indexOf("--plugin-dir") + 1]).toBe(pluginDirectory);
    const manifest = JSON.parse(readFileSync(join(pluginDirectory, ".claude-plugin", "plugin.json"), "utf8")) as {
      name: string;
    };
    expect(manifest.name).toBe("consensus-room");
    // SKILL.md가 있는 항목만 연결되고, 없는 항목은 검토 실패로 제외된다.
    expect(lstatSync(join(pluginDirectory, "skills", "probe")).isSymbolicLink()).toBe(true);
    expect(() => lstatSync(join(pluginDirectory, "skills", "no-manifest"))).toThrow();
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      sandbox: { filesystem: { allowRead: string[] } };
    };
    expect(settings.sandbox.filesystem.allowRead.some((path) => path.includes("source-skills"))).toBe(true);
  });

  it("관리형 플러그인의 스킬 오염은 다음 턴에 원상 복구되고 비심링크는 거부한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-claude-plugin-drift-"));
    temporaryDirectories.push(root);
    const source = join(root, "source-skills");
    mkdirSync(join(source, "probe"), { recursive: true });
    writeFileSync(join(source, "probe", "SKILL.md"), "---\nname: probe\n---\n검증용 스킬");
    const pluginDirectory = join(root, "claude-plugin");
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, undefined, {
      skillsDirectories: [source],
      managedPluginDirectory: pluginDirectory,
    });
    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: "/tmp" });

    // 방 밖에서 끼워 넣은 스킬 심링크는 다음 턴에 사라진다.
    const outside = join(root, "outside-skill");
    mkdirSync(outside, { recursive: true });
    writeFileSync(join(outside, "SKILL.md"), "---\nname: outside\n---\n허가 안 된 스킬");
    symlinkSync(outside, join(pluginDirectory, "skills", "smuggled"));
    await adapter.createSession({ prompt: "다시 계획해 주세요.", cwd: "/tmp" });
    expect(() => lstatSync(join(pluginDirectory, "skills", "smuggled"))).toThrow();

    // 심링크가 아닌 실제 디렉터리가 있으면 조용히 삼키지 않고 거부한다.
    mkdirSync(join(pluginDirectory, "skills", "planted"), { recursive: true });
    await expect(adapter.createSession({ prompt: "또 계획해 주세요.", cwd: "/tmp" }))
      .rejects.toThrow("심볼릭 링크가 아닙니다");
  });

  it("적용되는 지시문을 서버가 읽어 프롬프트에 넣고 파일 접근 권한은 주지 않는다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-claude-instructions-"));
    temporaryDirectories.push(root);
    const worktree = join(root, "worktree");
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(worktree, "CLAUDE.md"), "# 대상 저장소 규칙\n- indent 2칸");
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: worktree });

    const stdin = runner.calls[0].stdin ?? "";
    expect(stdin).toContain("적용되는 지시문 시작: 작업 저장소 CLAUDE.md");
    expect(stdin).toContain("indent 2칸");
    // 전역 CLAUDE.md는 이 머신에 실제로 있으므로 함께 주입된다. 홈 읽기 차단은 그대로다.
    const settings = JSON.parse(runner.calls[0].args[runner.calls[0].args.indexOf("--settings") + 1]) as {
      sandbox: { filesystem: { denyRead: string[] } };
    };
    expect(settings.sandbox.filesystem.denyRead).toContain(homedir());
  });

  it("인증 파일은 홈 차단과 별도로 명시 거부한다", () => {
    const settings = buildIsolationSettings("/tmp/worktree", "/tmp/action") as {
      permissions: { deny: string[] };
      sandbox: { filesystem: { denyRead: string[] } };
    };
    const credentialPath = join(homedir(), ".claude", ".credentials.json");
    expect(settings.sandbox.filesystem.denyRead).toContain(credentialPath);
    expect(settings.permissions.deny.some((rule) => rule.includes(".credentials.json"))).toBe(true);
  });

  it("웹은 도구로만 열고 Bash 네트워크 차단은 유지한다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: "/tmp" });

    const args = runner.calls[0].args;
    expect(args[args.indexOf("--tools") + 1]).toBe("Read,Glob,Grep,Bash,Skill,WebSearch,WebFetch");
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      ultracode?: boolean;
      sandbox: { network: { deniedDomains: string[]; allowedDomains: string[] } };
    };
    expect(settings.sandbox.network.deniedDomains).toEqual(["*"]);
    expect(settings.sandbox.network.allowedDomains).toEqual([]);
    // 계획 턴은 읽기 전용 계약이므로 에이전트 팬아웃을 열지 않는다. ultracode도 켜지 않는다.
    expect(settings.ultracode).toBeUndefined();
    // 도구 존재만으로는 부족하다 — allow 규칙이 없으면 자동 거부된다(실측 확인).
    const permissions = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      permissions: { allow: string[] };
    };
    expect(permissions.permissions.allow).toContain("WebFetch");
    expect(permissions.permissions.allow).not.toContain("Workflow");
    expect(permissions.permissions.allow).toContain("WebSearch");
  });

  it("Task와 커스텀 에이전트는 닫혀 있다 — built-in 배제 실패 실측의 회귀 방지", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: "/tmp" });

    const args = runner.calls[0].args;
    expect(args[args.indexOf("--tools") + 1]).not.toContain("Task");
    expect(args).not.toContain("--agents");
  });

  it("스킬 문서 읽기는 열되 홈의 인증·설정 경로 차단은 유지한다", () => {
    const settings = buildIsolationSettings("/tmp/worktree", "/tmp/action") as {
      sandbox: { filesystem: { allowRead: string[]; denyRead: string[] } };
    };
    expect(settings.sandbox.filesystem.allowRead).toContain(join(homedir(), ".claude", "skills"));
    expect(settings.sandbox.filesystem.denyRead).toContain(homedir());
    expect(settings.sandbox.filesystem.allowRead).not.toContain(join(homedir(), ".claude"));
    expect(settings.sandbox.filesystem.allowRead).not.toContain(join(homedir(), ".codex"));
  });

  it("에이전트는 원장·관리형 홈·공용 메모리 등 자기 실행 규칙을 쓸 수 없다", () => {
    const dataDirectory = "/tmp/consensus-data";
    const memoryDirectory = "/tmp/shared-memory";
    const settings = buildIsolationSettings("/tmp/worktree", "/tmp/action", true, {
      protectedWritePaths: [dataDirectory, memoryDirectory],
    }) as {
      permissions: { deny: string[] };
      sandbox: { filesystem: { denyWrite: string[] } };
    };
    expect(settings.sandbox.filesystem.denyWrite).toContain(dataDirectory);
    expect(settings.sandbox.filesystem.denyWrite).toContain(memoryDirectory);
    expect(settings.permissions.deny).toContain(`Write(//${dataDirectory.slice(1)}/**)`);
  });

  it("MCP는 Figma 읽기 메서드만 허용하고 쓰기 계열은 명시 거부한다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, undefined, { figmaMcpUrl: "http://127.0.0.1:3845/mcp" });

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: "/tmp" });

    const args = runner.calls[0].args;
    expect(args).toContain("--strict-mcp-config");
    const mcp = JSON.parse(args[args.indexOf("--mcp-config") + 1]) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(Object.keys(mcp.mcpServers)).toEqual(["figma-desktop"]);
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      permissions: { allow: string[]; deny: string[] };
    };
    expect(settings.permissions.allow).toContain("mcp__figma-desktop__get_design_context");
    expect(settings.permissions.allow.filter((rule) => rule.startsWith("mcp__"))
      .every((rule) => /^mcp__figma-desktop__get_/.test(rule))).toBe(true);
    expect(settings.permissions.deny).toContain("mcp__figma-desktop__use_figma");
    expect(settings.permissions.deny).toContain("mcp__figma-desktop__create_new_file");
  });

  it("MCP URL을 끄면 기존처럼 MCP를 전면 차단한다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, undefined, { figmaMcpUrl: null });

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: "/tmp" });

    const args = runner.calls[0].args;
    // 빈 객체 {}는 실 CLI가 거부한다(실측 확인). 서버 없음 = 빈 mcpServers 형태여야 한다.
    expect(args[args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
    const settings = JSON.parse(args[args.indexOf("--settings") + 1]) as {
      permissions: { allow: string[] };
    };
    expect(settings.permissions.allow.some((rule) => rule.startsWith("mcp__"))).toBe(false);
  });

  it("Codex 관리형 config는 웹 검색을 열고 V2 하위 에이전트 수·상속 정책을 강제한다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      planResult,
    ]));
    const { adapter, codexHome } = codexAdapter(runner);

    await adapter.createSession({
      prompt: "계획을 검토해 주세요.", cwd: "/tmp",
      settings: { model: "gpt-5.6-luna", effort: "medium" },
    });

    const content = readFileSync(join(adapter.managedHomeFor("/tmp"), "config.toml"), "utf8");
    expect(content).toMatch(/^web_search = true$/m);
    expect(content).toContain("[features.multi_agent_v2]");
    expect(content).toMatch(/^enabled = true$/m);
    expect(content.match(/^max_concurrent_threads_per_session = 3$/gm)).toHaveLength(1);
    expect(content.slice(0, content.indexOf("[tools]")))
      .not.toContain("max_concurrent_threads_per_session");
    expect(content).toMatch(/^expose_spawn_agent_model_overrides = false$/m);
    expect(content).toMatch(/^subagent_developer_instructions = ".+추가 하위 에이전트를 생성하거나 위임하지 마세요.+"$/m);
    expect(content).not.toContain("[orchestrator]");
    expect(content).not.toContain("default_subagent_model");
    expect(content).not.toContain("default_subagent_reasoning_effort");
  });

  it("격리 설정은 worktree Git 메타데이터 쓰기와 모든 Bash 외부 통신을 막는다", () => {
    const settings = buildIsolationSettings("/tmp/topic-worktree", "/tmp/topic-agent-temp") as {
      permissions: { allow: string[]; deny: string[] };
      sandbox: {
        filesystem: { allowWrite: string[]; denyWrite: string[] };
        network: { allowedDomains: string[]; deniedDomains: string[] };
      };
    };

    expect(settings.permissions.allow).toContain("Write(//tmp/topic-worktree/**)");
    expect(settings.permissions.deny).toContain("Write(//tmp/topic-worktree/.git)");
    // 이 호출은 implementation 기본값(true)이다. 구현 턴은 worktree를 고쳐야 하므로 쓰기가 열리고,
    // .git만 막힌다. 계획 턴이 worktree 쓰기를 안 여는 것은 아래 "구현 턴 sandbox 쓰기 경계"가 검사한다.
    // 빌드 인프라 경로(mise·tuist state, CoreSimulator 로그)가 추가된다(2026-08-31 S0.2 실측 근거).
    expect(settings.sandbox.filesystem.allowWrite.slice(0, 2)).toEqual(["/tmp/topic-worktree", "/tmp/topic-agent-temp"]);
    expect(settings.sandbox.filesystem.allowWrite.some((path) => path.endsWith("/.local/state/tuist"))).toBe(true);
    expect(settings.sandbox.filesystem.denyWrite).toContain("/tmp/topic-worktree/.git");
    expect(settings.sandbox.network).toEqual({
      allowedDomains: ["github.com", "api.github.com", "codeload.github.com", "objects.githubusercontent.com", "raw.githubusercontent.com", "tuist.dev"],
      deniedDomains: [], allowAllUnixSockets: false, allowLocalBinding: false,
    });
  });

  it("계획 단계의 Bash는 worktree 전체를 읽기 전용으로 본다", () => {
    const settings = buildIsolationSettings(
      "/tmp/topic-worktree",
      "/tmp/topic-agent-temp",
      false,
    ) as { sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[] } } };

    expect(settings.sandbox.filesystem.denyWrite).toContain("/tmp/topic-worktree");
    expect(settings.sandbox.filesystem.allowWrite).toEqual(["/tmp/topic-agent-temp"]);
  });

  it("서버 전용 환경변수와 임의 credential을 에이전트 프로세스에 넘기지 않는다", () => {
    const previousConsensusToken = process.env.CONSENSUS_ROOM_TOKEN;
    const previousSentryToken = process.env.SENTRY_AUTH_TOKEN;
    process.env.CONSENSUS_ROOM_TOKEN = "server-only";
    process.env.SENTRY_AUTH_TOKEN = "arbitrary-secret";
    try {
      const environment = agentEnvironment({ TMPDIR: "/tmp/agent" });

      expect(environment.CONSENSUS_ROOM_TOKEN).toBeUndefined();
      expect(environment.SENTRY_AUTH_TOKEN).toBeUndefined();
      expect(environment.TMPDIR).toBe("/tmp/agent");
      expect(environment.PATH).toBe(process.env.PATH);
    } finally {
      restoreEnvironment("CONSENSUS_ROOM_TOKEN", previousConsensusToken);
      restoreEnvironment("SENTRY_AUTH_TOKEN", previousSentryToken);
    }
  });
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

// 메모리 문서 재주입은 턴당 ~20K자를 중복 과금한다(2026-08-30 실측: 55자 프롬프트가 20,735자로 불어남).
// 세션 생성 턴에만 주입하고, resume은 세션 기억에 맡기고, protocolOnly는 새 세션이어도 주입하지 않는다.
describe("메모리 주입은 세션 생성 턴에만 한다", () => {
  function memoryFixture(): string {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-memory-once-"));
    temporaryDirectories.push(root);
    writeFileSync(join(root, "context-router.md"), [
      "# Context Router",
      "- [스위프트 동시성](swift-concurrency.md) — swift 전환 시 참조",
    ].join("\n"));
    writeFileSync(join(root, "swift-concurrency.md"), "# 스위프트 동시성 규칙\n\nMEMORY-MARKER-BODY");
    return root;
  }

  it("Claude: createSession에만 붙고 resume·protocolOnly에는 안 붙는다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, memoryFixture());

    await adapter.createSession({ prompt: "swift 전환 계획을 쓰세요.", cwd: "/tmp" });
    await adapter.resumeTurn({ sessionId: "11111111-1111-4111-8111-111111111111", prompt: "swift 개정하세요.", cwd: "/tmp" });
    await adapter.createSession({ prompt: "swift 해시를 확인하세요.", cwd: "/tmp", protocolOnly: true });

    expect(runner.calls[0].stdin).toContain("메모리 문서 시작");
    expect(runner.calls[1].stdin).not.toContain("메모리 문서 시작");
    expect(runner.calls[2].stdin).not.toContain("메모리 문서 시작");
  });

  // 본문을 한 번만 실으면 해시도 그 시점 값에 머문다. 그대로 두면 낡은 expectedSHA256으로 쓰기를 제안해
  // 서버가 거부한다(닫히는 방향이라 오염은 아니지만 교훈이 유실된다). 매니페스트로 해시만 매 턴 갱신한다.
  it("resume 턴에는 본문 대신 현재 SHA-256 매니페스트를 싣는다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, memoryFixture());

    await adapter.resumeTurn({
      sessionId: "11111111-1111-4111-8111-111111111111", prompt: "swift 개정하세요.", cwd: "/tmp",
    });

    const stdin = runner.calls[0].stdin ?? "";
    expect(stdin).toContain("메모리 스냅샷 갱신");
    expect(stdin).toContain("이전 턴의 값이 아니라 아래 값을 쓰세요");
    expect(stdin).toMatch(/- swift-concurrency\.md @ [a-f0-9]{64}/);
    // 본문은 여전히 싣지 않는다 — 비용을 되돌리면 최적화가 무의미해진다.
    expect(stdin).not.toContain("MEMORY-MARKER-BODY");
  });

  it("protocolOnly 턴에는 매니페스트도 싣지 않는다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, memoryFixture());

    await adapter.resumeTurn({
      sessionId: "11111111-1111-4111-8111-111111111111", prompt: "해시를 확인하세요.",
      cwd: "/tmp", protocolOnly: true,
    });

    expect(runner.calls[0].stdin).not.toContain("메모리 스냅샷 갱신");
  });

  it("Codex: createSession에만 붙고 resume에는 안 붙는다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "thread-1" },
      planResult,
    ]));
    const directory = mkdtempSync(join(tmpdir(), "consensus-room-codex-memory-"));
    temporaryDirectories.push(directory);
    const adapter = new CodexAdapter(
      runner, join(directory, "schema.json"), join(directory, "codex-home"), memoryFixture(),
    );

    await adapter.createSession({ prompt: "swift 계획을 감사하세요.", cwd: "/tmp" });
    await adapter.resumeTurn({ sessionId: "thread-1", prompt: "swift 종결하세요.", cwd: "/tmp" });

    expect(runner.calls[0].stdin).toContain("메모리 문서 시작");
    expect(runner.calls[1].stdin).not.toContain("메모리 문서 시작");
  });
});


// 2026-08-30: 첫 구현 턴이 한 줄도 못 고치고 멈췄다. permissions.allow는 Edit/Write를 허용했지만
// sandbox가 별도 층이라 allowWrite에 worktree가 없어 Edit·Write·Bash 세 경로 모두에서 거부됐다.
describe("구현 턴 sandbox 쓰기 경계", () => {
  function settingsFor(workspace: string, dataDirectory: string, implementation: boolean) {
    return buildIsolationSettings(workspace, join(dataDirectory, "action-temp"), implementation, {
      protectedWritePaths: [dataDirectory],
    }) as {
      sandbox: { filesystem: { allowWrite: string[]; denyWrite: string[] } };
    };
  }

  function room(): { dataDirectory: string; workspace: string; sibling: string } {
    const dataDirectory = mkdtempSync(join(tmpdir(), "consensus-room-sandbox-"));
    temporaryDirectories.push(dataDirectory);
    const workspace = join(dataDirectory, "worktrees", "topic-a");
    const sibling = join(dataDirectory, "worktrees", "topic-b");
    mkdirSync(workspace, { recursive: true });
    mkdirSync(sibling, { recursive: true });
    mkdirSync(join(dataDirectory, "codex-home"), { recursive: true });
    writeFileSync(join(dataDirectory, "consensus-room.sqlite"), "");
    return { dataDirectory, workspace, sibling };
  }

  it("구현 턴은 worktree를 쓸 수 있다", () => {
    const { dataDirectory, workspace } = room();

    const sandbox = settingsFor(workspace, dataDirectory, true).sandbox.filesystem;

    expect(sandbox.allowWrite).toContain(workspace);
    // deny가 allow를 이기므로 worktree를 덮는 상위 경로가 남아 있으면 안 된다.
    expect(sandbox.denyWrite).not.toContain(dataDirectory);
  });

  it("worktree를 열어도 원장·다른 주제 worktree·codex-home은 계속 막힌다", () => {
    const { dataDirectory, workspace, sibling } = room();

    const sandbox = settingsFor(workspace, dataDirectory, true).sandbox.filesystem;

    expect(sandbox.denyWrite).toContain(sibling);
    expect(sandbox.denyWrite).toContain(join(dataDirectory, "codex-home"));
    expect(sandbox.denyWrite).toContain(join(dataDirectory, "consensus-room.sqlite"));
    expect(sandbox.denyWrite).not.toContain(workspace);
  });

  // sandbox만 고치고 permissions를 놔뒀더니 여전히 막혔다(2026-08-30 2차 실측). deny가 allow를 이겨
  // Edit은 경로 deny, Write는 dontAsk 기본 거부로 나타났다. 두 층 모두 carve-out이 필요하다.
  it("구현 턴 deny 규칙이 worktree를 덮지 않는다", () => {
    const { dataDirectory, workspace, sibling } = room();

    const settings = buildIsolationSettings(workspace, join(dataDirectory, "action-temp"), true, {
      protectedWritePaths: [dataDirectory],
    }) as { permissions: { allow: string[]; deny: string[] } };

    const covering = settings.permissions.deny.filter((rule) =>
      /^(Edit|Write)\(/.test(rule) && rule.includes(`${dataDirectory}/**`));
    expect(covering).toEqual([]);
    // 워크트리는 열리되 .git과 형제 워크트리는 계속 막혀야 한다.
    expect(settings.permissions.allow).toContain(`Write(/${workspace}/**)`);
    expect(settings.permissions.deny).toContain(`Write(/${workspace}/.git/**)`);
    expect(settings.permissions.deny).toContain(`Write(/${sibling}/**)`);
  });

  it("계획 턴은 worktree 쓰기를 열지 않는다", () => {
    const { dataDirectory, workspace } = room();

    const sandbox = settingsFor(workspace, dataDirectory, false).sandbox.filesystem;

    expect(sandbox.allowWrite).not.toContain(workspace);
    expect(sandbox.denyWrite).toContain(workspace);
  });
});


// 감사 ①(2026-08)에서는 모든 주제가 하나의 CODEX_HOME/config.toml 을 덮어써 전체 직렬로 막았다. 2026-09-07 부터는
// worktree 마다 관리형 홈을 두므로 다른 주제는 **동시에** 돌고(상한 maxConcurrentTurns), 같은 주제는 직렬이며,
// 세션·스레드 상태는 공유 홈의 실물을 심링크로 가리킨다.
describe("Codex 토픽별 관리형 홈과 동시 실행", () => {
  function gatedRunner(codexHome: string) {
    let inFlight = 0;
    let peak = 0;
    let counter = 0;
    const order: string[] = [];
    const homes: string[] = [];
    const releases: Array<() => void> = [];
    const runner: CommandRunner = {
      run: async (spec) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        order.push(`start:${spec.cwd}`);
        homes.push(spec.environment?.CODEX_HOME ?? "");
        // 각 실행은 테스트가 풀어 줄 때까지 붙잡힌다 — 동시성 관측 창.
        await new Promise<void>((resolve) => { releases.push(resolve); });
        inFlight -= 1;
        order.push(`end:${spec.cwd}`);
        const config = readFileSync(join(spec.environment?.CODEX_HOME ?? codexHome, "config.toml"), "utf8");
        if (!config.includes(`"${spec.cwd}" = true`)) throw new Error(`profile 이 자기 worktree 를 가리키지 않는다: ${spec.cwd}`);
        counter += 1;
        return successfulResult([{ type: "thread.started", thread_id: `thread-${counter}` }, planResult]);
      },
    };
    const releaseNext = () => { releases.shift()?.(); };
    return { runner, releaseNext, order, homes, peak: () => peak, pending: () => releases.length };
  }

  // 홈 준비는 실제 파일 작업(git rev-parse·realpath·링크)이라 몇 tick 으로는 안 끝난다 — 조건을 폴링한다.
  async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error("조건을 기다리다 시간이 초과됐습니다.");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  it("다른 worktree 두 턴은 각자의 홈 config 로 동시에 돌고, 홈은 공유 홈 아래 topics/ 에 있다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consensus-room-codex-concurrency-"));
    temporaryDirectories.push(directory);
    const codexHome = join(directory, "codex-home");
    const workspaceA = mkdtempSync(join(tmpdir(), "consensus-room-ws-a-"));
    const workspaceB = mkdtempSync(join(tmpdir(), "consensus-room-ws-b-"));
    temporaryDirectories.push(workspaceA, workspaceB);
    const gate = gatedRunner(codexHome);
    const adapter = new CodexAdapter(gate.runner, join(directory, "schema.json"), codexHome, undefined, { maxConcurrentTurns: 2 });

    const turns = Promise.all([
      adapter.createSession({ prompt: "A 주제", cwd: workspaceA }),
      adapter.createSession({ prompt: "B 주제", cwd: workspaceB }),
    ]);
    await waitFor(() => gate.pending() === 2); // 둘 다 동시에 실행 중
    gate.releaseNext(); gate.releaseNext();
    await turns;

    expect(gate.peak()).toBe(2);
    // 시작 순서는 비결정적이라 집합으로 비교한다.
    expect(new Set(gate.homes)).toEqual(new Set([adapter.managedHomeFor(workspaceA), adapter.managedHomeFor(workspaceB)]));
    expect(gate.homes.every((home) => home.startsWith(join(codexHome, "topics")))).toBe(true);
    // 토픽 홈에는 자기 config 만 실물이고, 나머지는 공유 홈으로 가는 심링크다.
    expect(lstatSync(join(gate.homes[0], "config.toml")).isSymbolicLink()).toBe(false);
    for (const shared of ["skills", "auth.json"]) {
      const link = join(gate.homes[0], shared);
      if (lstatSync(link, { throwIfNoEntry: false })) expect(readlinkSync(link)).toBe(join(codexHome, shared));
    }
  });

  it("같은 worktree 의 턴은 직렬이고, 전체 동시 상한을 넘지 않는다", async () => {
    const directory = mkdtempSync(join(tmpdir(), "consensus-room-codex-cap-"));
    temporaryDirectories.push(directory);
    const codexHome = join(directory, "codex-home");
    const workspaces = ["a", "b", "c"].map((name) => {
      const path = mkdtempSync(join(tmpdir(), `consensus-room-ws-${name}-`));
      temporaryDirectories.push(path);
      return path;
    });
    const gate = gatedRunner(codexHome);
    const adapter = new CodexAdapter(gate.runner, join(directory, "schema.json"), codexHome, undefined, { maxConcurrentTurns: 2 });

    const turns = Promise.all([
      adapter.createSession({ prompt: "A1", cwd: workspaces[0] }),
      adapter.resumeTurn({ sessionId: "thread-a", prompt: "A2", cwd: workspaces[0] }),
      adapter.createSession({ prompt: "B", cwd: workspaces[1] }),
      adapter.createSession({ prompt: "C", cwd: workspaces[2] }),
    ]);
    await waitFor(() => gate.pending() === 2);
    await settle();
    expect(gate.pending()).toBe(2); // 상한 2: A1·B 만 실행 중, A2 는 같은 worktree 라 A1 뒤, C 는 자리 대기
    // A1·B 는 자리를 동시에 얻고 각자 홈 준비(파일 작업)를 마친 순서대로 실행되므로 둘의 시작 순서는 비결정적이다.
    expect(new Set(gate.order.filter((item) => item.startsWith("start:")))).toEqual(
      new Set([`start:${workspaces[0]}`, `start:${workspaces[1]}`]),
    );
    gate.releaseNext(); // 첫 실행 끝 → 자리 대기 순서(FIFO)대로 C 가 먼저, A2 는 A1 이 끝난 뒤 그다음 자리
    await waitFor(() => gate.order.filter((item) => item.startsWith("start:")).length === 3);
    expect(gate.order.filter((item) => item.startsWith("start:")).at(-1)).toBe(`start:${workspaces[2]}`);
    await settle();
    expect(gate.pending()).toBe(2);
    gate.releaseNext(); // B 끝 → A2 시작
    await waitFor(() => gate.order.filter((item) => item.startsWith("start:")).length === 4);
    expect(gate.order.filter((item) => item.startsWith("start:")).at(-1)).toBe(`start:${workspaces[0]}`);
    gate.releaseNext(); gate.releaseNext();
    await turns;

    expect(gate.peak()).toBe(2);
    const starts = gate.order.filter((item) => item.startsWith("start:"));
    expect(starts).toHaveLength(4);
    // 같은 worktree(A)의 두 턴은 겹치지 않는다: A2 start 는 A1 end 뒤.
    expect(gate.order.indexOf(`end:${workspaces[0]}`)).toBeLessThan(gate.order.lastIndexOf(`start:${workspaces[0]}`));
  });
});

// 2026-09-02: sample-ios 의 CLAUDE.md·AGENTS.md 는 gitignored 라 토픽 worktree 에 없다. S1.1~S5.2 의 모든 에이전트가
// 전역 지시문만 받았다(실측). worktree 에 파일이 없으면 원본 저장소의 파일을 서버가 읽어 넣고, 방 계약 우선 규칙을 붙인다.
describe("프로젝트 지시문 — worktree 에 없으면 원본 저장소에서 읽는다", () => {
  function instructionFixture(): { repository: string; worktree: string } {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-instructions-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    mkdirSync(repository, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repository, "CLAUDE.md"), "# CLAUDE.md\n- 원본 저장소 규칙 마커 ALPHA\n");
    writeFileSync(join(repository, "AGENTS.md"), "# AGENTS.md\n- 원본 저장소 규칙 마커 GAMMA\n");
    return { repository, worktree };
  }

  it("Claude: worktree 에 CLAUDE.md 가 없으면 원본 저장소 CLAUDE.md 를 주입하고 우선순위 규칙을 붙인다", async () => {
    const { repository, worktree } = instructionFixture();
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, undefined, { repositoryPath: repository });

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: worktree });

    const stdin = runner.calls[0].stdin ?? "";
    expect(stdin).toContain("원본 저장소 규칙 마커 ALPHA");
    expect(stdin).toContain("작업 저장소 CLAUDE.md (원본 저장소 사본 — worktree 에는 gitignored 라 없음)");
    expect(stdin).toContain("프로젝트 지시문 적용 규칙");
    // 지시문은 프롬프트 앞에 오고 프롬프트 본문이 stdin 을 닫는다.
    expect(stdin.indexOf("마커 ALPHA")).toBeLessThan(stdin.indexOf("계획을 작성해 주세요."));
    expect(stdin.endsWith("계획을 작성해 주세요.")).toBe(true);
  });

  it("Claude: worktree 에 CLAUDE.md 가 있으면 그것을 쓰고 원본 저장소 것은 넣지 않는다", async () => {
    const { repository, worktree } = instructionFixture();
    writeFileSync(join(worktree, "CLAUDE.md"), "# CLAUDE.md\n- worktree 규칙 마커 BETA\n");
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, undefined, { repositoryPath: repository });

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: worktree });

    const stdin = runner.calls[0].stdin ?? "";
    expect(stdin).toContain("worktree 규칙 마커 BETA");
    expect(stdin).not.toContain("마커 ALPHA");
    expect(stdin).toContain("적용되는 지시문 시작: 작업 저장소 CLAUDE.md\n");
    expect(stdin).toContain("프로젝트 지시문 적용 규칙");
  });

  it("Claude: repositoryPath 가 없으면 예전과 같이 worktree 파일만 본다", async () => {
    const { worktree } = instructionFixture();
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);

    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: worktree });

    const stdin = runner.calls[0].stdin ?? "";
    expect(stdin).not.toContain("마커 ALPHA");
    expect(stdin).not.toContain("프로젝트 지시문 적용 규칙");
  });

  it("Codex: worktree 에 AGENTS.md 가 없으면 원본 저장소 AGENTS.md 를 stdin 에 넣고, 있으면 CLI 가 읽으므로 넣지 않는다", async () => {
    const { repository, worktree } = instructionFixture();
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "codex-thread-1" },
      { ...planResult, kind: "AUDIT", summary: "감사했습니다." },
    ]));
    const { adapter } = codexAdapter(runner, { repositoryPath: repository });

    await adapter.createSession({ prompt: "계획을 감사하세요.", cwd: worktree });
    const missing = runner.calls[0].stdin ?? "";
    expect(missing).toContain("원본 저장소 규칙 마커 GAMMA");
    expect(missing).toContain("프로젝트 지시문 적용 규칙");
    expect(missing.endsWith("계획을 감사하세요.")).toBe(true);

    writeFileSync(join(worktree, "AGENTS.md"), "# AGENTS.md\n- worktree 규칙 마커 DELTA\n");
    await adapter.createSession({ prompt: "다시 감사하세요.", cwd: worktree });
    const present = runner.calls[1].stdin ?? "";
    expect(present).not.toContain("마커 GAMMA");
    expect(present).not.toContain("마커 DELTA");
    expect(present).not.toContain("프로젝트 지시문 적용 규칙");
  });
});

describe("세션 id 즉시 통지 (2026-09-03 429·stop 뒤 resume 불가 처방)", () => {
  it("createSession 은 프로세스 실행 전에 onSessionCreated 로 같은 세션 id 를 알린다", async () => {
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner);
    const seen: string[] = [];
    let callsWhenNotified = -1;

    const created = await adapter.createSession({
      prompt: "계획을 작성해 주세요.", cwd: "/tmp", planMode: true,
      onSessionCreated: (sessionId) => { seen.push(sessionId); callsWhenNotified = runner.calls.length; },
    });

    expect(seen).toEqual([created.sessionId]);
    expect(callsWhenNotified).toBe(0);
    expect(runner.calls[0].args).toContain(created.sessionId);
  });
});

// 2026-09-07 Codex 자기 최적화 제안 ②: 프로토콜 확인(ACK) 턴은 판단에 필요한 값을 프롬프트가 다 담고 있으므로
// 전역·프로젝트 지시문 블록도 싣지 않는다. 제안 ④: 모든 턴은 CLI 마지막 이벤트의 토큰 수를 onUsage 로 알린다.
describe("프로토콜 확인 턴의 지시문 생략과 턴 사용량 통지", () => {
  function instructionRepository(): { repository: string; worktree: string } {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-ack-instructions-"));
    temporaryDirectories.push(root);
    const repository = join(root, "repository");
    const worktree = join(root, "worktree");
    mkdirSync(repository, { recursive: true });
    mkdirSync(worktree, { recursive: true });
    writeFileSync(join(repository, "CLAUDE.md"), "# CLAUDE.md\n- 원본 저장소 규칙 마커 ALPHA\n");
    writeFileSync(join(repository, "AGENTS.md"), "# AGENTS.md\n- 원본 저장소 규칙 마커 GAMMA\n");
    return { repository, worktree };
  }

  it("Claude: protocolOnly 턴에는 지시문 블록이 하나도 없고 프롬프트만 남는다", async () => {
    const { repository, worktree } = instructionRepository();
    const runner = new RecordingRunner(successfulResult([planResult]));
    const adapter = new ClaudeAdapter(runner, undefined, { repositoryPath: repository });

    await adapter.createSession({ prompt: "해시를 확인하세요.", cwd: worktree, protocolOnly: true });
    await adapter.createSession({ prompt: "계획을 작성해 주세요.", cwd: worktree });

    const ack = runner.calls[0].stdin ?? "";
    expect(ack).not.toContain("마커 ALPHA");
    expect(ack).not.toContain("적용되는 지시문 시작");
    expect(ack).not.toContain("프로젝트 지시문 적용 규칙");
    expect(ack.endsWith("해시를 확인하세요.")).toBe(true);
    // 대조군: 일반 턴은 그대로 싣는다 — 생략이 protocolOnly 에만 걸려야 한다.
    expect(runner.calls[1].stdin ?? "").toContain("마커 ALPHA");
  });

  it("Codex: protocolOnly 턴에는 AGENTS.md 블록이 없고 일반 턴에는 있다", async () => {
    const { repository, worktree } = instructionRepository();
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "thread-ack" },
      planResult,
    ]));
    const { adapter } = codexAdapter(runner, { repositoryPath: repository });

    await adapter.createSession({ prompt: "해시를 확인하세요.", cwd: worktree, protocolOnly: true });
    await adapter.createSession({ prompt: "계획을 감사하세요.", cwd: worktree });

    const ack = runner.calls[0].stdin ?? "";
    expect(ack).not.toContain("마커 GAMMA");
    expect(ack).not.toContain("적용되는 지시문 시작");
    expect(ack.endsWith("해시를 확인하세요.")).toBe(true);
    expect(runner.calls[1].stdin ?? "").toContain("마커 GAMMA");
  });

  it("Codex: turn.completed 의 토큰 수를 onUsage 로 알린다", async () => {
    const runner = new RecordingRunner(successfulResult([
      { type: "thread.started", thread_id: "thread-usage" },
      { type: "turn.completed", usage: { input_tokens: 1200, cached_input_tokens: 1000, output_tokens: 50 } },
      planResult,
    ]));
    const { adapter } = codexAdapter(runner);
    const seen: TurnUsage[] = [];

    await adapter.createSession({ prompt: "계획을 감사하세요.", cwd: "/tmp", onUsage: (usage) => seen.push(usage) });
    await adapter.resumeTurn({ sessionId: "thread-usage", prompt: "종결하세요.", cwd: "/tmp", onUsage: (usage) => seen.push(usage) });

    expect(seen).toHaveLength(2);
    expect(seen[0]).toMatchObject({ inputTokens: 1200, cachedInputTokens: 1000, outputTokens: 50 });
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
    expect(seen[0].costUSD).toBeUndefined();
  });

  it("Codex: 종료 코드가 0이 아니어도 마지막 turn.completed 사용량은 onUsage 로 알린다", async () => {
    const runner = new RecordingRunner({
      exitCode: 1,
      stdout: [
        JSON.stringify({ type: "thread.started", thread_id: "thread-usage" }),
        JSON.stringify({ type: "turn.completed", usage: { input_tokens: 320, cached_input_tokens: 90, output_tokens: 42 } }),
        JSON.stringify({ type: "error", message: "timeout" }),
      ].join("\n"),
      stderr: "",
      jsonLines: [
        { type: "thread.started", thread_id: "thread-usage" },
        { type: "turn.completed", usage: { input_tokens: 320, cached_input_tokens: 90, output_tokens: 42 } },
        { type: "error", message: "timeout" },
      ],
    });
    const { adapter } = codexAdapter(runner);
    const seen: TurnUsage[] = [];

    await expect(adapter.createSession({
      prompt: "계획을 감사하세요.", cwd: "/tmp", onUsage: (usage) => seen.push(usage),
    })).rejects.toThrow("Codex 실행 실패(1)");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ inputTokens: 320, cachedInputTokens: 90, outputTokens: 42 });
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("Claude: result 이벤트의 usage·비용·턴 수를 onUsage 로 알리고 캐시 읽기·생성을 총 입력에 더한다", async () => {
    const runner = new RecordingRunner(successfulResult([{
      type: "result", subtype: "success", num_turns: 3, total_cost_usd: 0.1234,
      usage: { input_tokens: 10, cache_read_input_tokens: 900, cache_creation_input_tokens: 90, output_tokens: 40 },
      structured_output: planResult,
    }]));
    const adapter = new ClaudeAdapter(runner);
    const seen: TurnUsage[] = [];

    await adapter.createSession({ prompt: "계획을 작성하세요.", cwd: "/tmp", onUsage: (usage) => seen.push(usage) });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ inputTokens: 1000, cachedInputTokens: 900, outputTokens: 40, costUSD: 0.1234, modelTurns: 3 });
  });

  it("Claude: 종료 코드가 0이 아니어도 result 이벤트의 사용량은 onUsage 로 알린다", async () => {
    const runner = new RecordingRunner({
      exitCode: 1,
      stdout: JSON.stringify({
        type: "result",
        subtype: "error",
        usage: { input_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 1 },
        structured_output: planResult,
      }),
      stderr: "",
      jsonLines: [{
        type: "result",
        subtype: "error",
        usage: { input_tokens: 3, cache_read_input_tokens: 1, cache_creation_input_tokens: 2, output_tokens: 1 },
        structured_output: planResult,
      }],
    });
    const adapter = new ClaudeAdapter(runner);
    const seen: TurnUsage[] = [];

    await expect(adapter.createSession({
      prompt: "계획을 작성하세요.", cwd: "/tmp", onUsage: (usage) => seen.push(usage),
    })).rejects.toThrow("Claude 실행 실패(1)");

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ inputTokens: 6, cachedInputTokens: 1, outputTokens: 1 });
    expect(seen[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("사용량 이벤트가 없으면 알리지 않고, 관찰자가 던져도 턴 결과는 돌아온다", async () => {
    const silent = new RecordingRunner(successfulResult([planResult]));
    const seen: TurnUsage[] = [];
    await new ClaudeAdapter(silent).createSession({ prompt: "계획", cwd: "/tmp", onUsage: (usage) => seen.push(usage) });
    expect(seen).toHaveLength(0);

    const noisy = new RecordingRunner(successfulResult([
      { type: "result", subtype: "success", usage: { input_tokens: 1, output_tokens: 1 }, structured_output: planResult },
    ]));
    const created = await new ClaudeAdapter(noisy).createSession({
      prompt: "계획", cwd: "/tmp", onUsage: () => { throw new Error("기록 실패"); },
    });
    expect(created.result.kind).toBe("PLAN");
  });
});
