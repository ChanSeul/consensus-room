import { randomUUID } from "node:crypto";
import { readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
  AgentResultJsonSchema,
  DEFAULT_AGENT_SETTINGS,
  type AgentResult,
} from "../../shared/contracts.js";
import { EXECUTION_POLICY_NOTE } from "../../shared/prompts.js";
import type { AgentAdapter, CommandRunner, CreatedSession, SessionTurn } from "../types.js";
import { agentEnvironment } from "../security.js";
import { ProjectMemoryReader } from "../projectMemory.js";
import { readAppliedInstructions } from "../projectInstructions.js";
import { describeCommandFailure, parseAgentResult } from "./resultParser.js";
import { ExecutionMetrics } from "./executionMetrics.js";
import { createToolTimeMeter } from "./toolTime.js";

export interface ClaudeAdapterOptions {
  // 정책 3(자기 규칙 변경 차단) 방어 심층화: sandbox 기본 거부에만 의존하지 않고 명시 deny로 회귀를 막는다.
  protectedWritePaths?: readonly string[];
  // v1 MCP allowlist: Figma Dev Mode 서버의 읽기 메서드만. null이면 MCP 전면 차단(기존과 동일).
  figmaMcpUrl?: string | null;
  // 서버가 검토한 native skill 디렉터리만 관리형 플러그인 아래에 연결한다(codex 미러).
  skillsDirectories?: readonly string[];
  // 관리형 플러그인의 위치. 세션이 이어지는 동안 유지되어야 하므로 액션 임시 디렉터리가 아니라 데이터 디렉터리를 쓴다.
  managedPluginDirectory?: string;
  // 원본 저장소. worktree 에 CLAUDE.md 가 없으면(gitignored) 여기 것을 주입한다(projectInstructions.ts).
  repositoryPath?: string | null;
}

// --plugin-dir로 로드되는 유일한 스킬 원천. 다른 원천은 --safe-mode와 빈 --setting-sources가 계속 차단한다.
const MANAGED_PLUGIN_MANIFEST = JSON.stringify({
  name: "consensus-room",
  description: "Consensus Room이 검토해 연결한 스킬만 담는 관리형 플러그인",
  version: "1.0.0",
}, null, 2);

// 지시문은 파일 접근 권한이 아니라 서버가 읽어 프롬프트로 주입한다. --add-dir는 쓰기 경로를 넓혀 정책 1이 금지한다.

// Figma MCP에서 열어 주는 읽기 메서드. 이 밖의 메서드는 allow에 없어 permission mode(plan/dontAsk)가 거부하고,
// 알려진 쓰기 계열은 이중으로 명시 deny한다.
const FIGMA_READ_METHODS = [
  "get_design_context",
  "get_metadata",
  "get_screenshot",
  "get_variable_defs",
  "get_code_connect_map",
] as const;
const FIGMA_WRITE_METHODS = ["use_figma", "create_new_file", "generate_diagram"] as const;

// 하위 에이전트(Task)는 열지 않는다. 실측(2.1.239, 2026-08-24): --agents로 커스텀 정의를 줘도 Task 도구 설명에
// built-in 4종(claude, Explore, general-purpose, Plan)이 그대로 나열됐다 — general-purpose는 Task를 가지므로
// 중첩 증식(정책 7)을 구조적으로 막을 수 없다. built-in 배제 수단이 생기면 재검토한다.

const FINAL_RESULT_TIMEOUT_MS = 120_000;

export class ClaudeAdapter implements AgentAdapter {
  readonly role = "claude" as const;

  private readonly memory: ProjectMemoryReader | null;

  constructor(
    private readonly runner: CommandRunner,
    memoryDirectory?: string,
    private readonly options: ClaudeAdapterOptions = {},
  ) {
    this.memory = memoryDirectory ? new ProjectMemoryReader(memoryDirectory) : null;
  }

  async createSession(turn: Omit<SessionTurn, "sessionId">): Promise<CreatedSession> {
    const sessionId = randomUUID();
    turn.onSessionCreated?.(sessionId);
    return { sessionId, result: await this.invoke(turn, ["--session-id", sessionId], true) };
  }

  resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    return this.invoke(turn, ["--resume", turn.sessionId], false);
  }

  async validateExistingSession(sessionId: string): Promise<boolean> {
    if (!isUUID(sessionId)) return false;
    return findFile(join(homedir(), ".claude", "projects"), `${sessionId}.jsonl`, 3);
  }

  private async invoke(
    turn: Omit<SessionTurn, "sessionId"> | SessionTurn,
    sessionArgs: string[],
    newSession: boolean,
  ): Promise<AgentResult> {
    const workspace = resolve(turn.cwd);
    const actionTemp = await mkdtemp(join(tmpdir(), "consensus-room-claude-"));
    try {
      const permissionMode = turn.implementation ? "dontAsk" : (turn.planMode ? "plan" : "dontAsk");
      const executionSettings = turn.settings ?? DEFAULT_AGENT_SETTINGS.claude;
      const figmaMcpUrl = this.options.figmaMcpUrl ?? null;
      // 빈 객체 {}는 실 CLI가 "Invalid MCP configuration"으로 거부한다(실측). mcpServers 키는 항상 있어야 한다.
      const mcpConfig = {
        mcpServers: figmaMcpUrl ? { "figma-desktop": { type: "http", url: figmaMcpUrl } } : {},
      };
      // 웹은 도구로만 연다(WebSearch/WebFetch는 CLI 프로세스 소관). Bash의 네트워크는 sandbox가 계속 전면 차단한다.
      // Skill 도구가 목록에 없으면 관리형 플러그인 스킬이 로드돼도 쓸 수 없다(실측).
      // 웹은 계획 턴에만 연다 — 외부 증거(1차 자료) 수집이 계획 수렴의 정당한 기능이라서다.
      // 구현 턴은 코드 쓰기 접근과 웹이 결합해 유출 표면이 가장 커서 닫는다(2026-08-31 Codex 지적, 정책 c).
      const baseTools = "Read,Glob,Grep,Bash,Skill";
      const planningTools = `${baseTools},WebSearch,WebFetch`;
      const { pluginDirectory, skillSourceDirectories } = await this.prepareManagedPlugin();
      const args = [
        "-p",
        "--model", executionSettings.model,
        "--effort", executionSettings.effort,
        // --safe-mode는 쓰지 않는다. 관리형 플러그인 스킬까지 죽이기 때문이다(실측). safe-mode가 끄던 유입원은
        // 개별 격리가 대체하며 각각 실측으로 확인했다: 사용자·프로젝트 스킬과 hooks·커스텀 설정은 빈
        // --setting-sources가 차단(사용자 스킬 5종 미노출 확인), CLAUDE.md는 미유입 확인(서버 주입이 대신 담당),
        // MCP는 --strict-mcp-config, 자동 메모리는 settings와 env. 잔존: CLI 내장 스킬 문서 12종(제거 수단 없음,
        // 실행형 동작은 sandbox가 차단).
        "--no-chrome",
        "--strict-mcp-config",
        "--mcp-config", JSON.stringify(mcpConfig),
        "--setting-sources", "",
        "--settings", JSON.stringify(buildIsolationSettings(
          workspace, actionTemp, Boolean(turn.implementation),
          {
            protectedWritePaths: this.options.protectedWritePaths,
            figmaMcpEnabled: Boolean(figmaMcpUrl),
            skillSourceDirectories,
            readablePaths: turn.readablePaths,
          },
        )),
        // 구현 턴만 Workflow를 연다. 계획 턴은 읽기 전용 계약이라 에이전트 팬아웃을 열지 않는다.
        // Workflow 하위 에이전트는 부모의 --tools 상한을 물려받는다(실측: Read만 준 부모의 에이전트가 Read만 받음).
        // 프로토콜 확인 턴은 도구를 전부 닫는다 — 판단에 필요한 값은 프롬프트가 이미 다 담고 있다.
        "--tools", turn.protocolOnly
          ? ""
          : turn.implementation ? `${baseTools},Edit,Write,Workflow` : planningTools,
        ...(pluginDirectory ? ["--plugin-dir", pluginDirectory] : []),
        "--permission-mode", permissionMode,
        "--output-format", "stream-json",
        "--verbose",
        "--json-schema", JSON.stringify(AgentResultJsonSchema),
        ...sessionArgs,
      ];
      // 프로토콜 확인 턴은 판단에 필요한 값을 프롬프트가 다 담고 있어 지시문(CLAUDE.md)도 싣지 않는다
      // (2026-09-07 Codex 자기 최적화 제안 ②: ACK 턴마다 전역·프로젝트 지시문 블록을 재전송하던 낭비).
      const { blocks: instructions } = turn.protocolOnly
        ? { blocks: [] as string[] }
        : await readAppliedInstructions({
          workspace, fileName: "CLAUDE.md", repositoryPath: this.options.repositoryPath ?? null,
          globalPath: join(homedir(), ".claude", "CLAUDE.md"), injectWorkspaceFile: true,
        });
      // 메모리 문서는 세션이 처음 만들어질 때 한 번만 주입한다. resume 턴은 세션이 이미 그 문서를
      // 기억하고 있고, 매 턴 다시 붙이면 턴당 ~20K자가 중복 과금된다(2026-08-30 실측: 55자 프롬프트가
      // 20,735자로 불어남). protocolOnly 턴은 판단에 메모리가 필요 없어 새 세션이어도 주입하지 않는다.
      // 트레이드오프: 주제 진행 중 메모리 문서가 갱신돼도 기존 세션은 예전 내용을 기억한다.
      const injectMemory = Boolean(this.memory) && newSession && !turn.protocolOnly;
      const enriched = injectMemory
        ? await this.memory!.buildPrompt(turn.prompt, this.role)
        : await this.withMemoryManifest(turn);
      const stdin = [EXECUTION_POLICY_NOTE, ...instructions, enriched].join("\n\n");
      const startedAt = Date.now();
      const toolTime = createToolTimeMeter("claude");
      const metrics = new ExecutionMetrics("claude", Buffer.byteLength(stdin, "utf8"), executionSettings.model, executionSettings.effort, !newSession, startedAt);
      let finalRecorded = false;
      const recordFinal = () => {
        if (finalRecorded) return;
        finalRecorded = true;
        // abort/error라도 이미 스트림에서 받은 관측값과 실행 메타데이터는 남긴다. 이벤트가 전혀 없으면
        // 토큰을 0으로 만들지 않고 completeness=partial로만 기록한다.
        try { turn.onUsage?.(metrics.snapshot(toolTime.summary(), "final")); } catch { /* observer is non-fatal */ }
      };
      const progressTimer = setInterval(() => {
        if (!metrics.hasFinalSource()) {
          try { turn.onUsage?.(metrics.snapshot(toolTime.summary(), "progress")); } catch { /* observer is non-fatal */ }
        }
      }, 10_000);
      try {
      const output = await this.runner.run({
        command: "claude", args, cwd: workspace, stdin,
        signal: turn.signal, onSpawn: turn.onProcessSpawn,
        onJSONLine: (value, at) => { toolTime.observe(value, at); metrics.observe(value); },
        // stream-json 의 마지막 줄은 {"type":"result"} 다. 그 뒤 2분 안에 프로세스가 안 끝나면 hang 으로 보고 정리한다.
        finalResultTimeoutMs: FINAL_RESULT_TIMEOUT_MS,
        isFinalResult: (value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result",
        environment: agentEnvironment({
          TMPDIR: actionTemp,
          XDG_CACHE_HOME: join(actionTemp, "cache"),
          CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
        }),
      });
      // 테스트용 runner가 onJSONLine을 생략해도 최종 버퍼를 한 번 관찰한다.
      for (const value of output.jsonLines) metrics.observe(value);
      recordFinal();
      if (output.exitCode !== 0) {
        throw new Error(describeCommandFailure("Claude", output.exitCode, output.stderr, output.stdout));
      }
      return parseAgentResult(output.jsonLines, output.stdout);
      } finally {
        clearInterval(progressTimer);
        recordFinal();
      }
    } finally {
      await rm(actionTemp, { recursive: true, force: true });
    }
  }


  // resume·fork 턴에는 본문 대신 매니페스트만 덧붙인다. protocolOnly 턴은 메모리 자체가 필요 없다.
  private async withMemoryManifest(
    turn: Omit<SessionTurn, "sessionId"> | SessionTurn,
  ): Promise<string> {
    if (!this.memory || turn.protocolOnly) return turn.prompt;
    const manifest = await this.memory.buildManifest(turn.prompt, this.role);
    return manifest ? `${turn.prompt}\n\n${manifest}` : turn.prompt;
  }

  // 플러그인 홈은 유지하되 구성은 턴마다 다시 맞춘다. 외부에서 스킬이 추가·오염돼도 다음 턴에 원상 복구된다(codex 미러).
  private async prepareManagedPlugin(): Promise<{
    pluginDirectory: string | null;
    skillSourceDirectories: string[];
  }> {
    const pluginDirectory = this.options.managedPluginDirectory;
    if (!pluginDirectory) return { pluginDirectory: null, skillSourceDirectories: [] };
    const manifestDirectory = join(pluginDirectory, ".claude-plugin");
    const managedSkills = join(pluginDirectory, "skills");
    await mkdir(manifestDirectory, { recursive: true });
    await mkdir(managedSkills, { recursive: true });
    await writeFile(join(manifestDirectory, "plugin.json"), `${MANAGED_PLUGIN_MANIFEST}\n`, { mode: 0o600 });

    const sourceDirectories: string[] = [];
    const desired = new Map<string, string>();
    for (const configured of this.options.skillsDirectories ?? []) {
      const sourceRoot = await realpath(resolve(configured)).catch(() => null);
      if (!sourceRoot) continue;
      sourceDirectories.push(sourceRoot);
      const entries = await readdir(sourceRoot, { withFileTypes: true });
      for (const entry of entries.sort((lhs, rhs) => lhs.name.localeCompare(rhs.name))) {
        if (entry.name.startsWith(".") || desired.has(entry.name)) continue;
        const candidate = await realpath(join(sourceRoot, entry.name)).catch(() => null);
        if (!candidate || !isPathInside(sourceRoot, candidate)) continue;
        const skillFile = await realpath(join(candidate, "SKILL.md")).catch(() => null);
        if (!skillFile || !isPathInside(candidate, skillFile)) continue;
        desired.set(entry.name, candidate);
      }
    }

    const existing = await readdir(managedSkills, { withFileTypes: true });
    for (const entry of existing) {
      if (entry.name.startsWith(".")) continue;
      const managedPath = join(managedSkills, entry.name);
      const metadata = await lstat(managedPath);
      if (!metadata.isSymbolicLink()) {
        throw new Error(`관리형 Claude skill 경로가 심볼릭 링크가 아닙니다: ${managedPath}`);
      }
      const target = desired.get(entry.name);
      const current = resolve(managedSkills, await readlink(managedPath));
      if (target && current === target) {
        desired.delete(entry.name);
        continue;
      }
      await unlink(managedPath);
    }
    for (const [name, target] of desired) {
      await symlink(target, join(managedSkills, name), "dir");
    }
    return { pluginDirectory, skillSourceDirectories: uniquePaths(sourceDirectories) };
  }

}

// 보호 경로가 workspace를 포함하면, 그 경로 자체를 막는 대신 workspace로 내려가는 경로의 형제들만 막는다.
// workspace를 포함하지 않으면 그대로 둔다. 읽을 수 없는 디렉터리는 안전한 쪽(원래 경로 유지)으로 접는다.
function carveOutWorkspace(protectedPath: string, workspace: string): string[] {
  if (protectedPath === workspace) return [];
  if (!isPathInside(protectedPath, workspace)) return [protectedPath];
  let entries: string[];
  try {
    entries = readdirSync(protectedPath);
  } catch {
    return [protectedPath];
  }
  return entries.flatMap((entry) => {
    const child = join(protectedPath, entry);
    if (child === workspace) return [];
    return isPathInside(child, workspace) ? carveOutWorkspace(child, workspace) : [child];
  });
}

// tuist가 매니페스트 파싱 자식에 TMPDIR을 전달하지 않아 자식이 Darwin 사용자 임시 디렉터리로
// 폴백한다(2026-08-31 S0.2 실측: env -u TMPDIR로 재현, 쓰기 거부 시 swift가 permissionDenied로 죽어
// tuist install/generate 둘 다 exit 1). 사용자별 경로라 getconf로 1회 계산한다.
const darwinUserTempDir = (() => {
  try {
    return execFileSync("getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).trim().replace(/\/$/, "");
  } catch {
    return null;
  }
})();

export function buildIsolationSettings(
  workspace: string,
  actionTemp: string,
  implementation = true,
  options: {
    protectedWritePaths?: readonly string[];
    figmaMcpEnabled?: boolean;
    skillSourceDirectories?: readonly string[];
    // 턴 단위 추가 읽기 허용(주제 plan.md 등). 쓰기는 열지 않는다 — denyWrite(dataDirectory carve-out)가 그대로 막는다.
    readablePaths?: readonly string[];
  } = {},
): Record<string, unknown> {
  const home = homedir();
  const gitCommonDirectory = findGitCommonDirectory(workspace);
  const protectedGitPaths = [join(workspace, ".git"), gitCommonDirectory].filter(Boolean) as string[];
  // 정책 3: 에이전트가 자기 실행 규칙(원장 DB·관리형 codex-home·공용 메모리)을 바꾸지 못한다.
  const protectedRulePaths = [...(options.protectedWritePaths ?? [])];
  // 구현 턴은 워크트리를 고쳐야 한다. 보호 경로가 워크트리를 품고 있으면(dataDirectory가 그렇다) 그대로
  // deny할 수 없다 — permissions 층에서도 deny가 allow를 이겨 Edit은 경로 deny로, Write는 dontAsk 기본
  // 거부로 막힌다(2026-08-30 실측). sandbox와 같은 carve-out을 여기에도 적용한다.
  const deniedEditPaths = implementation
    ? [...protectedGitPaths, ...protectedRulePaths.flatMap((path) => carveOutWorkspace(path, workspace))]
    : [...protectedGitPaths, ...protectedRulePaths];
  const editRules = ["Edit", "Write"].flatMap((tool) =>
    deniedEditPaths.flatMap((path) => [
      `${tool}(${permissionPath(path)})`,
      `${tool}(${permissionPath(path)}/**)`,
    ]));
  const figmaRules = options.figmaMcpEnabled
    ? {
        allow: FIGMA_READ_METHODS.map((method) => `mcp__figma-desktop__${method}`),
        deny: FIGMA_WRITE_METHODS.map((method) => `mcp__figma-desktop__${method}`),
      }
    : { allow: [], deny: [] };

  // 인증 파일은 홈 전체 차단에 이미 포함되지만, allowRead가 확장되는 추세라 명시 deny로 회귀를 막는다(codex 미러).
  const credentialPath = join(home, ".claude", ".credentials.json");
  return {
    autoMemoryEnabled: false,
    // ultracode는 effort 값이 아니라 session-start 설정 키다. `--effort ultracode`는 CLI가 경고만 찍고
    // 조용히 기본 effort로 떨어뜨린다(실측: "Valid values: low, medium, high, xhigh, max").
    // 구현 턴에서만 켠다 — 계획 턴은 Workflow를 열지 않아 켜 봐야 동작할 도구가 없다.
    ...(implementation ? { ultracode: true } : {}),
    permissions: {
      allow: [
        `Read(${permissionPath(workspace)}/**)`,
        `Edit(${permissionPath(workspace)}/**)`,
        `Write(${permissionPath(workspace)}/**)`,
        "Glob",
        "Grep",
        "Bash",
        // 도구가 목록에 있어도 allow 규칙이 없으면 plan/dontAsk 모드가 자동 거부한다(실측). 웹 도구는
        // 계획 턴에만 명시로 연다(정책 c — 구현 턴은 --tools에서도 빠져 이중으로 닫힌다).
        ...(implementation ? [] : ["WebSearch", "WebFetch"]),
        "Skill",
        // 도구 목록에 Workflow가 있어도 allow 규칙이 없으면 dontAsk가 거부한다(실측: 계획 없이 열었을 때 차단됨).
        ...(implementation ? ["Workflow"] : []),
        ...figmaRules.allow,
      ],
      deny: [...editRules, ...figmaRules.deny, `Read(${permissionPath(credentialPath)})`],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // xcodebuild는 actool이 CoreSimulatorService XPC를 요구해 sandbox 안에서는 에셋 가진 타깃이
      // Swift 컴파일 전에 죽는다(2026-08-31 실측: 에셋 없는 타깃은 SwiftCompile 236건 정상, 에셋 타깃은
      // actool에서 사망). XPC는 filesystem·network 설정으로 열 수 없어 이 명령 하나만 sandbox 밖에서
      // 실행한다 — 구현 턴 한정, simctl은 제외(런타임 게이트 강등은 유지).
      // 매칭 의미론(CLI 2.1.251 실물 확인): 와일드카드 없는 항목은 명령 문자열 전체와 exact 비교라
      // "xcodebuild" 단독은 인자가 붙는 순간 불일치한다. "xcodebuild *"는 ^xcodebuild( .*)?$로 컴파일되고,
      // 복합 명령은 세그먼트 하나만 맞아도 전체가 면제된다. 래퍼 스크립트 안에 숨은 xcodebuild는
      // 매칭되지 않는다 — Bash 명령 문자열 최상위에 xcodebuild가 그대로 등장해야 한다.
      excludedCommands: implementation ? ["xcodebuild *", "xcrun xcodebuild *"] : [],
      filesystem: {
        // 구현 턴은 worktree를 고쳐야 하므로 쓰기를 연다. permissions.allow만으로는 부족하다 —
        // sandbox가 별도 층이라 allowWrite에 없으면 Edit·Write·Bash 세 경로 모두에서 거부된다
        // (2026-08-30 실측: 첫 구현 턴이 이 이유로 한 줄도 못 고치고 멈췄다).
        // 구현(측정) 턴의 빌드 인프라: mise·tuist가 홈 아래 state를 쓰고(계획 P0 실측: 없으면
        // trusted-config·세션 기록에서 즉시 실패), 런타임 게이트는 CoreSimulator 로그를 쓴다(2026-08-31).
        allowWrite: implementation
          ? [
              workspace, actionTemp,
              join(home, ".local", "state", "mise"),
              join(home, ".local", "state", "tuist"),
              join(home, ".cache", "tuist"),
              join(home, "Library", "Developer", "CoreSimulator"),
              join(home, "Library", "Logs", "CoreSimulator"),
              // SPM resolve 캐시(없어도 동작하지만 경고·재다운로드 발생 — 같은 실측 보고의 선택 항목).
              join(home, "Library", "Caches", "org.swift.swiftpm"),
              join(home, "Library", "org.swift.swiftpm"),
              join(home, ".swiftpm"),
              ...(darwinUserTempDir ? [darwinUserTempDir] : []),
            ]
          : [actionTemp],
        // 보호 경로가 worktree를 품고 있으면(dataDirectory가 그렇다) 통째로 deny할 수 없다 — deny가
        // allowWrite를 이기기 때문이다. 그렇다고 통째로 빼면 원장 DB·다른 주제 worktree·codex-home까지
        // 열린다. 그래서 worktree로 가는 길만 열고 형제 항목은 그대로 막는다(carveOutWorkspace).
        denyWrite: implementation
          ? [...protectedGitPaths, ...protectedRulePaths.flatMap((path) => carveOutWorkspace(path, workspace))]
          : [workspace, ...protectedGitPaths, ...protectedRulePaths],
        denyRead: [home, credentialPath],
        allowRead: [
          workspace,
          actionTemp,
          ...(implementation
            ? [
                join(home, ".local", "state", "mise"),
                join(home, ".local", "state", "tuist"),
                join(home, ".local", "share", "mise"),
                join(home, ".cache", "tuist"),
                join(home, "Library", "Developer", "CoreSimulator"),
                join(home, "Library", "Caches", "org.swift.swiftpm"),
                join(home, "Library", "org.swift.swiftpm"),
                join(home, ".swiftpm"),
                // tuist.dev 인증 토큰(credentials/tuist.dev.json). 읽기만 — 유출 표면은 network
                // allowlist(github·tuist.dev)로 한정된다.
                join(home, ".config", "tuist"),
              ]
            : []),
          join(home, ".gitconfig"),
          join(home, ".config", "git"),
          // 정책: 스킬은 서버가 검토해 관리형 플러그인으로만 로드한다. 심링크 대상(소스)을 읽을 수 있어야 하고,
          // denyRead(home + 인증 파일)가 유지되므로 인증·설정 경로는 이 allowRead로 열리지 않는다.
          join(home, ".claude", "skills"),
          ...(options.skillSourceDirectories ?? []),
          ...(gitCommonDirectory ? [gitCommonDirectory] : []),
          ...(options.readablePaths ?? []),
        ],
      },
      network: {
        // 계획 턴은 전면 차단 유지. 구현 턴만 빌드 의존성 호스트를 연다(tuist install → SPM fetch,
        // Package.resolved 실측 호스트 github.com + git 전송이 타는 codeload/objects 리다이렉트).
        // 정책 c로 닫은 WebFetch/WebSearch와 별개의 최소 allowlist다 — 전면 개방이 아니다.
        allowedDomains: implementation
          ? [
              "github.com", "api.github.com", "codeload.github.com",
              "objects.githubusercontent.com", "raw.githubusercontent.com",
              // tuist generate가 Tuist.swift의 fullHandle 때문에 서버 인증을 호출한다(--no-binary-cache로도
              // getCacheEndpoints가 나감 — 2026-08-31 4단계 실측). 캐시 hit도 빌드 시간을 크게 줄인다.
              "tuist.dev",
            ]
          : [],
        deniedDomains: implementation ? [] : ["*"],
        allowAllUnixSockets: false,
        allowLocalBinding: false,
      },
    },
  };
}

function isPathInside(root: string, target: string): boolean {
  const scope = relative(root, target);
  return scope === "" || (!scope.startsWith("..") && !isAbsolute(scope));
}

function uniquePaths(paths: readonly (string | null)[]): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)).map((path) => resolve(path)))];
}

function permissionPath(path: string): string {
  return `//${path.replace(/^\/+/, "")}`;
}

function findGitCommonDirectory(workspace: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: workspace,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    return null;
  }
}

function isUUID(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

async function findFile(root: string, target: string, remainingDepth: number): Promise<boolean> {
  if (remainingDepth < 0) return false;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return false; }
  for (const entry of entries) {
    if (entry.isFile() && entry.name === target) return true;
    if (entry.isDirectory() && await findFile(join(root, entry.name), target, remainingDepth - 1)) return true;
  }
  return false;
}
