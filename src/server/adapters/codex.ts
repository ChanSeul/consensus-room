import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, readlink, realpath, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  AgentResultJsonSchema,
  DEFAULT_AGENT_SETTINGS,
  type AgentResult,
} from "../../shared/contracts.js";
import { EXECUTION_POLICY_NOTE } from "../../shared/prompts.js";
import { readAppliedInstructions } from "../projectInstructions.js";
import type { AgentAdapter, CommandRunner, CreatedSession, SessionTurn } from "../types.js";
import { agentEnvironment } from "../security.js";
import { ProjectMemoryReader } from "../projectMemory.js";
import { describeCommandFailure, parseAgentResult } from "./resultParser.js";
import { codexHomeUsage, ExecutionMetrics } from "./executionMetrics.js";
import { createToolTimeMeter } from "./toolTime.js";

export interface CodexAdapterOptions {
  // 서버가 검토한 native skill 디렉터리만 관리형 CODEX_HOME/skills 아래에 연결한다.
  skillsDirectories?: readonly string[];
  // 원본 저장소. worktree 에 AGENTS.md 가 없으면(gitignored) 여기 것을 stdin 에 넣는다(projectInstructions.ts).
  // worktree 에 있으면 codex CLI 가 cwd 에서 직접 읽으므로 넣지 않는다(중복 방지).
  repositoryPath?: string | null;
  // 토픽(worktree)별 관리형 홈이 서로 다른 config.toml 을 가지므로 토픽 간 동시 실행이 가능하다. 이 값은 전체
  // 동시 Codex 턴 상한이다(토픽 안은 항상 직렬). 기본 2 — 2026-09-07 S9·S10 병렬 계획이 Codex 턴에서 직렬화되던 것의 해소.
  maxConcurrentTurns?: number;
}

interface CodexPermissionBoundary {
  topicHome: string;
  workspace: string;
  gitCommonDirectory: string | null;
  managedSkillsDirectory: string;
  skillSourceDirectories: readonly string[];
  instructionPaths: readonly string[];
  managedAuthPath: string;
  sourceAuthPath: string;
  codexExecutable: string;
  protocolOnly: boolean;
  // 턴 단위 추가 읽기 허용(주제 plan.md 등).
  readablePaths: readonly string[];
}

// 관리형 CODEX_HOME에 매 턴 덮어쓰는 최소 설정. mcp_servers/notify/plugins/marketplaces/shell_environment_policy
// 섹션이 "없다"는 것이 이 파일의 목적이다. 구형 sandbox_mode는 읽을 수 있는 경로를 좁히지 못하므로 쓰지 않고,
// permission profile이 worktree·Git metadata·검토된 skill만 읽게 한다.
// 모델과 추론 강도는 이 파일에 복사하지 않고 각 CLI 호출의 명시 인자로 전달한다.
const MANAGED_CONFIG_HEADER = [
  "# Consensus Room이 턴마다 다시 쓰는 파일이다. 손으로 고쳐도 다음 턴에 사라진다.",
  'approval_policy = "never"',
  'default_permissions = "consensus-review"',
];

// V2 하위 에이전트는 별도 모델 override를 받지 않고 그 턴의 Root 모델·추론 강도를 상속한다.
// max_concurrent_threads_per_session은 Root를 포함하므로 3이면 동시에 하위 에이전트 2개까지 실행할 수 있다.
function managedConfigBody(boundary: CodexPermissionBoundary): string {
  const readablePaths = uniquePaths([
    boundary.topicHome,
    boundary.workspace,
    boundary.gitCommonDirectory,
    boundary.managedSkillsDirectory,
    ...boundary.skillSourceDirectories,
    ...boundary.instructionPaths,
    ...boundary.readablePaths,
    join(homedir(), ".gitconfig"),
    join(homedir(), ".config", "git"),
    // 자기 재실행 대상. 빠지면 AGENTS.md 로드 단계에서 sandbox-exec가 exec을 거부한다.
    boundary.codexExecutable,
  ]);
  const deniedPaths = uniquePaths([join(boundary.topicHome, "auth.json"), boundary.managedAuthPath, boundary.sourceAuthPath]);
  return [
    ...MANAGED_CONFIG_HEADER,
    "",
    // 프로토콜 확인 턴은 판단에 필요한 값을 프롬프트가 다 담고 있으므로 웹 검색과 하위 에이전트를 닫는다.
    "# 정책: 웹 검색과 공개 문서 읽기는 기본 개방. 확장 서버·알림 훅은 계속 차단(sandbox 밖 프로세스).",
    "[tools]",
    `web_search = ${boundary.protocolOnly ? "false" : "true"}`,
    "",
    "[features.multi_agent_v2]",
    `enabled = ${boundary.protocolOnly ? "false" : "true"}`,
    "max_concurrent_threads_per_session = 3",
    "expose_spawn_agent_model_overrides = false",
    `subagent_developer_instructions = ${tomlString("전달받은 범위만 직접 처리하고 추가 하위 에이전트를 생성하거나 위임하지 마세요. 파일을 수정하지 마세요.")}`,
    "",
    "# Codex host는 인증 파일을 사용하지만 model-generated shell에는 worktree와 검토된 skill만 보인다.",
    "[permissions.consensus-review]",
    'description = "Consensus Room read-only review"',
    "",
    "[permissions.consensus-review.workspace_roots]",
    `${tomlString(boundary.workspace)} = true`,
    "",
    "[permissions.consensus-review.filesystem]",
    '":minimal" = "read"',
    ...readablePaths.map((path) => `${tomlString(path)} = "read"`),
    ...deniedPaths.map((path) => `${tomlString(path)} = "deny"`),
    "",
    "[permissions.consensus-review.network]",
    "enabled = false",
    "",
  ].join("\n");
}

export class CodexAdapter implements AgentAdapter {
  readonly role = "codex" as const;
  private readonly memory: ProjectMemoryReader | null;

  constructor(
    private readonly runner: CommandRunner,
    private readonly schemaPath = join(homedir(), "Library", "Application Support", "ConsensusRoom", "agent-result.schema.json"),
    // 앱 수명 동안 유지되는 단일 관리형 홈. 액션마다 임시 디렉터리를 만들면 이 아래 세션이 사라져 exec resume이 깨진다.
    // 기본값을 schemaPath 옆에 두면 index.ts가 주는 dataDirectory를 그대로 따라간다.
    private readonly codexHome = join(dirname(schemaPath), "codex-home"),
    memoryDirectory?: string,
    private readonly options: CodexAdapterOptions = {},
  ) {
    this.memory = memoryDirectory ? new ProjectMemoryReader(memoryDirectory) : null;
    this.slots = new Semaphore(Math.max(1, options.maxConcurrentTurns ?? 2));
  }

  async createSession(turn: Omit<SessionTurn, "sessionId">): Promise<CreatedSession> {
    const output = await this.invoke(turn, ["exec", "--json", "--output-schema", this.schemaPath, "-"], true);
    const sessionId = extractThreadId(output.jsonLines);
    if (!sessionId) throw new Error("Codex 응답에서 thread ID를 찾지 못했습니다.");
    return { sessionId, result: parseAgentResult(output.jsonLines, output.stdout) };
  }

  async resumeTurn(turn: SessionTurn): Promise<AgentResult> {
    const output = await this.invoke(turn, ["exec", "resume", turn.sessionId, "--json", "--output-schema", this.schemaPath, "-"], false);
    return parseAgentResult(output.jsonLines, output.stdout);
  }

  async validateExistingSession(sessionId: string): Promise<boolean> {
    // 세션은 관리형 홈이 소유한다. 사용자가 자기 터미널에서 만든 세션은 여기 없으므로 attach되지 않는다 —
    // 외부 세션을 붙이면 그 대화 이력과 방 밖 지시문이 그대로 들어와 이 방의 격리 약속과 정면으로 어긋난다.
    try {
      const index = await readFile(join(this.codexHome, "session_index.jsonl"), "utf8");
      return index.split(/\r?\n/).some((line) => {
        if (!line.trim()) return false;
        try {
          const value = JSON.parse(line) as Record<string, unknown>;
          return value.id === sessionId || value.thread_id === sessionId || value.session_id === sessionId;
        } catch { return false; }
      });
    } catch { return false; }
  }

  // 2026-09-07 토픽별 관리형 홈: 예전에는 모든 주제가 하나의 CODEX_HOME/config.toml 을 공유해 동시 실행이 서로의
  // permission profile 을 덮어썼고(감사 ①), 그래서 홈 준비부터 CLI 종료까지 **전체 직렬**이었다. 이제 worktree(cwd)마다
  // `<codexHome>/topics/<sha256(cwd)[:16]>/` 홈을 두고 config.toml 만 거기 쓴다. 세션·스레드 상태(sessions/, *.sqlite,
  // cache/ …)는 공유 홈의 실물을 심링크로 가리킨다 — SQLite 는 심링크로 연 DB 의 WAL/SHM 을 실물 옆에 만들므로
  // (2026-09-07 sqlite 3.51 실측) 여러 프로세스가 같은 DB 를 안전하게 쓴다. 토픽 안은 여전히 직렬(같은 스레드 resume 은
  // 순서가 계약), 전체는 maxConcurrentTurns 로 상한을 둔다.
  private readonly topicQueues = new Map<string, Promise<unknown>>();
  private readonly slots: Semaphore;
  // 공유 홈(인증·skills·전역 규칙 링크)을 손보는 구간만 토픽 간 직렬 — 동시 mkdir/링크 정리가 서로를 지운다(2026-09-07 테스트 실측 ENOENT).
  private sharedHomeQueue: Promise<unknown> = Promise.resolve();

  managedHomeFor(cwd: string): string {
    return join(this.codexHome, "topics", managedHomeKey(cwd));
  }

  private invoke(
    turn: Omit<SessionTurn, "sessionId"> | SessionTurn,
    commandArgs: string[],
    newSession: boolean,
  ): ReturnType<CodexAdapter["invokeExclusively"]> {
    const key = resolve(turn.cwd);
    const previous = this.topicQueues.get(key) ?? Promise.resolve();
    const run = previous.then(async () => {
      const release = await this.slots.acquire();
      try {
        return await this.invokeExclusively(turn, commandArgs, newSession);
      } finally {
        release();
      }
    });
    this.topicQueues.set(key, run.catch(() => undefined));
    return run;
  }

  private async invokeExclusively(
    turn: Omit<SessionTurn, "sessionId"> | SessionTurn,
    commandArgs: string[],
    newSession: boolean,
  ) {
    // -s/-a are top-level Codex options. resume 뒤에 놓으면 CLI가 거부한다.
    await mkdir(dirname(this.schemaPath), { recursive: true });
    await writeFile(this.schemaPath, JSON.stringify(AgentResultJsonSchema, null, 2), { mode: 0o600 });
    const executionSettings = turn.settings ?? DEFAULT_AGENT_SETTINGS.codex;
    const topicHome = await this.prepareManagedHome(turn.cwd, Boolean(turn.protocolOnly), turn.readablePaths ?? []);
    // 메모리는 세션 생성 턴에만 주입한다(claude 어댑터와 같은 근거 — resume은 스레드가 이미 기억,
    // 매 턴 재주입은 턴당 ~20K자 중복). protocolOnly 턴은 새 세션이어도 주입하지 않는다.
    const injectMemory = Boolean(this.memory) && newSession && !turn.protocolOnly;
    const enriched = injectMemory
      ? await this.memory!.buildPrompt(turn.prompt, this.role)
      : await this.withMemoryManifest(turn);
    // 프로토콜 확인 턴은 판단에 필요한 값을 프롬프트가 다 담고 있어 프로젝트 지시문(AGENTS.md)도 싣지 않는다
    // (2026-09-07 Codex 자기 최적화 제안 ②: ACK 턴마다 지시문 블록을 재전송하던 낭비).
    const { blocks: instructions } = turn.protocolOnly
      ? { blocks: [] as string[] }
      : await readAppliedInstructions({
        workspace: turn.cwd, fileName: "AGENTS.md", repositoryPath: this.options.repositoryPath ?? null,
        globalPath: null, injectWorkspaceFile: false,
      });
    const stdin = [EXECUTION_POLICY_NOTE, ...instructions, enriched].join("\n\n");
    const startedAt = Date.now();
    const toolTime = createToolTimeMeter("codex");
    const metrics = new ExecutionMetrics("codex", Buffer.byteLength(stdin, "utf8"), executionSettings.model, executionSettings.effort, !newSession, startedAt);
    let finalRecorded = false;
    const recordFinal = () => {
      if (finalRecorded) return;
      finalRecorded = true;
      try { turn.onUsage?.(metrics.snapshot(toolTime.summary(), "final")); } catch { /* observer is non-fatal */ }
    };
    const progressTimer = setInterval(() => {
      if (!metrics.hasFinalSource()) {
        try { turn.onUsage?.(metrics.snapshot(toolTime.summary(), "progress")); } catch { /* observer is non-fatal */ }
      }
    }, 10_000);
    try {
    const output = await this.runner.run({
      onJSONLine: (value, at) => { toolTime.observe(value, at); metrics.observe(value); },
      // PATH가 준 심볼릭 링크가 아니라 실제 경로로 실행한다(resolveCodexExecutable 주석 참조).
      command: resolveCodexExecutable(),
      args: [
        "--strict-config",
        "-a", "never",
        "-m", executionSettings.model,
        "-c", `model_reasoning_effort=\"${executionSettings.effort}\"`,
        // 2026-09-01 사용자 지시로 1.5x 속도 티어(`-c service_tier="priority"`, "Fast")를 썼으나
        // 2026-09-06 사용자 지시 "코덱스 fast 모드는 normal 모드로" 로 제거 — 새 플랜(prolite)의 사용량 한도를
        // priority 티어가 더 빨리 소모하기 때문. 기본(normal) 티어 = service_tier 키를 넘기지 않는다.
        // (speed_tier 는 --strict-config 가 미지 필드로 거부한다는 실측은 그대로 유효.)
        ...commandArgs,
      ],
      cwd: turn.cwd,
      stdin,
      signal: turn.signal,
      onSpawn: turn.onProcessSpawn,
      // HOME은 git·keychain 경로 때문에 그대로 두고, codex 설정 출처만 CODEX_HOME으로 잘라낸다.
      environment: agentEnvironment({ CODEX_HOME: topicHome }),
    });
    for (const value of output.jsonLines) metrics.observe(value);
    // CLI 스트림 값과 관리형 홈 원본을 합산하지 않는다. 새 세션의 id는 stream에서만 알 수 있어
    // 이 실행 구간의 thread.started를 사용하고, 대조 불가 상태도 명시한다.
    const sessionId = newSession
      ? output.jsonLines.find((value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "thread.started" && typeof (value as { thread_id?: unknown }).thread_id === "string") as { thread_id?: string } | undefined
      : undefined;
    const resumedSessionId = "sessionId" in turn ? turn.sessionId : undefined;
    metrics.setCodexHomeUsage(await codexHomeUsage(this.codexHome, resumedSessionId ?? sessionId?.thread_id, startedAt));
    recordFinal();
    if (output.exitCode !== 0) {
      throw new Error(describeCommandFailure("Codex", output.exitCode, output.stderr, output.stdout));
    }
    return output;
    } finally {
      clearInterval(progressTimer);
      recordFinal();
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

  // 홈 자체는 지속되지만 설정은 턴마다 다시 쓴다. 외부에서 드리프트가 생겨도 다음 턴에 사라지게 하려는 것이고,
  // schemaPath를 매번 쓰는 위 패턴과 같다. 공유 홈(인증·skills·전역 규칙·세션 상태)을 먼저 정리한 뒤 토픽 홈을 그 위에 얹는다.
  private async prepareManagedHome(cwd: string, protocolOnly: boolean, readablePaths: readonly string[] = []): Promise<string> {
    const workspace = resolve(cwd);
    const shared = this.sharedHomeQueue.then(() => this.prepareSharedHome());
    this.sharedHomeQueue = shared.catch(() => undefined);
    const { skillSourceDirectories, globalInstructionPaths } = await shared;
    const instructionPaths = uniquePaths([
      ...globalInstructionPaths,
      ...await findInstructionPaths(workspace),
    ]);
    const topicHome = this.managedHomeFor(workspace);
    await mkdir(topicHome, { recursive: true });
    await this.linkSharedState(topicHome);
    const boundary: CodexPermissionBoundary = {
      topicHome,
      workspace,
      gitCommonDirectory: findGitCommonDirectory(workspace),
      managedSkillsDirectory: join(this.codexHome, "skills"),
      skillSourceDirectories,
      instructionPaths,
      managedAuthPath: join(this.codexHome, "auth.json"),
      sourceAuthPath: join(this.userCodexHome(), "auth.json"),
      codexExecutable: resolveCodexExecutable(),
      protocolOnly,
      readablePaths,
    };
    await writeFile(join(topicHome, "config.toml"), managedConfigBody(boundary), { mode: 0o600 });
    return topicHome;
  }

  private async prepareSharedHome(): Promise<{ skillSourceDirectories: string[]; globalInstructionPaths: string[] }> {
    await mkdir(this.codexHome, { recursive: true });
    await this.linkAuthentication();
    const skillSourceDirectories = await this.linkSkills();
    const globalInstructionPaths = await this.linkGlobalInstructions();
    return { skillSourceDirectories, globalInstructionPaths };
  }

  // 공유 홈의 항목(세션·스레드 DB·캐시·skills·auth·AGENTS 링크 …)을 토픽 홈에 심링크로 건다. config.toml 과 topics/ 는
  // 제외하고, SQLite 부속 파일(-wal/-shm/-journal)은 실물 옆에 있어야 하므로 걸지 않는다. 토픽 홈에 codex 가 실물로
  // 만든 파일(새 스키마 등)은 건드리지 않는다 — 그 토픽만의 상태로 남는다.
  private async linkSharedState(topicHome: string): Promise<void> {
    const entries = await readdir(this.codexHome, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === "config.toml" || entry.name === "topics") continue;
      if (/\.sqlite-(wal|shm|journal)$/.test(entry.name)) continue;
      const target = join(this.codexHome, entry.name);
      const link = join(topicHome, entry.name);
      const existing = await lstat(link).catch(() => null);
      if (existing) {
        if (!existing.isSymbolicLink()) continue;
        if (await readlink(link) === target) continue;
        await unlink(link);
      }
      await symlink(target, link, entry.isDirectory() ? "dir" : "file");
    }
  }

  private userCodexHome(): string {
    return process.env.CODEX_HOME ?? join(homedir(), ".codex");
  }

  private async linkAuthentication(): Promise<void> {
    const managedAuth = join(this.codexHome, "auth.json");
    const userAuth = join(this.userCodexHome(), "auth.json");
    if (resolve(userAuth) === resolve(managedAuth)) return;
    // 이미 있으면 건드리지 않는다 — 더 새로운 자격증명일 수 있다. 내용은 읽지 않는다.
    try {
      await lstat(managedAuth);
      return;
    } catch { /* 없을 때만 아래에서 연결한다 */ }
    // 복사 대신 심볼릭 링크: codex가 토큰을 갱신하면 사용자 홈과 같은 파일을 갱신한다.
    try {
      await symlink(userAuth, managedAuth);
    } catch { /* 인증이 없으면 codex 자신이 로그인 요구로 실패한다 */ }
  }

  private async linkGlobalInstructions(): Promise<string[]> {
    const readable: string[] = [];
    for (const name of ["AGENTS.override.md", "AGENTS.md"] as const) {
      const sourceLink = join(this.userCodexHome(), name);
      const source = await realpath(sourceLink).catch(() => null);
      const managed = join(this.codexHome, name);
      const existing = await lstat(managed).catch(() => null);

      if (!source) {
        if (existing?.isSymbolicLink()) await unlink(managed);
        else if (existing) throw new Error(`관리형 Codex 규칙 경로가 심볼릭 링크가 아닙니다: ${managed}`);
        continue;
      }

      if (existing) {
        if (!existing.isSymbolicLink()) {
          throw new Error(`관리형 Codex 규칙 경로가 심볼릭 링크가 아닙니다: ${managed}`);
        }
        const current = await realpath(managed).catch(() => null);
        if (current !== source) {
          await unlink(managed);
          await symlink(source, managed);
        }
      } else {
        await symlink(source, managed);
      }
      readable.push(managed, source);
    }
    return readable;
  }

  private async linkSkills(): Promise<string[]> {
    const managedSkills = join(this.codexHome, "skills");
    await mkdir(managedSkills, { recursive: true });

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
      const target = desired.get(entry.name);
      const metadata = await lstat(managedPath);
      if (!metadata.isSymbolicLink()) {
        throw new Error(`관리형 Codex skill 경로가 심볼릭 링크가 아닙니다: ${managedPath}`);
      }
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
    return uniquePaths(sourceDirectories);
  }
}

async function findInstructionPaths(workspace: string): Promise<string[]> {
  const readable: string[] = [];
  let directory = resolve(workspace);
  while (true) {
    for (const name of ["AGENTS.override.md", "AGENTS.md"] as const) {
      const candidate = join(directory, name);
      const target = await realpath(candidate).catch(() => null);
      if (target) readable.push(candidate, target);
    }
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return uniquePaths(readable);
}

// codex는 AGENTS.md를 읽을 때 자기 실행 파일을 fs sandbox helper로 재실행한다. 그때 exec 대상은
// PATH가 찾아준 경로 그대로이므로, 심볼릭 링크가 permission profile이 열지 않은 곳(예: 홈 아래
// ~/.local/bin)에 있으면 sandbox-exec가 "Operation not permitted"로 죽는다(2026-08-29 실측:
// ~/.local/bin/codex는 실패, 같은 config로 /Applications/ChatGPT.app/.../codex는 성공).
// 그래서 실제 경로로 풀어서 실행하고, 그 경로를 profile의 읽기 허용에도 넣는다.
function resolveCodexExecutable(): string {
  const found = (() => {
    try {
      return execFileSync("/usr/bin/which", ["codex"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return "";
    }
  })();
  if (!found) return "codex";
  try {
    return realpathSync(found);
  } catch {
    return found;
  }
}

// worktree 경로의 sha256 앞 16자 — 토픽 홈 디렉터리 이름. 경로에 공백·한글이 있어도 안전하고 결정적이다.
export function managedHomeKey(cwd: string): string {
  return createHash("sha256").update(resolve(cwd)).digest("hex").slice(0, 16);
}

// 전체 동시 Codex 턴 상한. acquire 는 자리가 날 때까지 기다리고, 반환된 release 를 finally 에서 부른다.
class Semaphore {
  private readonly waiters: Array<() => void> = [];
  private active = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.limit) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
      this.waiters.shift()?.();
    };
  }
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

function isPathInside(root: string, target: string): boolean {
  const scope = relative(root, target);
  return scope === "" || (!scope.startsWith("..") && !isAbsolute(scope));
}

function uniquePaths(paths: readonly (string | null)[]): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)).map((path) => resolve(path)))];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function extractThreadId(lines: unknown[]): string | null {
  for (const line of lines) {
    if (!line || typeof line !== "object") continue;
    const value = line as Record<string, unknown>;
    if (value.type === "thread.started" && typeof value.thread_id === "string") return value.thread_id;
    if (value.type === "thread_started" && typeof value.threadId === "string") return value.threadId;
  }
  return null;
}
