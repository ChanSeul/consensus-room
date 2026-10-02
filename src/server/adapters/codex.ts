import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, readlink, realpath, rename, symlink, unlink, writeFile } from "node:fs/promises";
import { PlanningPaused } from "../../shared/planningControl.js";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  AgentResultJsonSchema,
  CodexPlanningAgentResultJsonSchema,
  DEFAULT_AGENT_SETTINGS,
  type AgentResult,
} from "../../shared/contracts.js";
import { executionPolicyNote } from "../../shared/prompts.js";
import { readAppliedInstructions } from "../projectInstructions.js";
import type { AgentAdapter, CommandRunner, CreatedSession, OutputSchema, SessionTurn } from "../types.js";
import { defaultDataDirectory } from "../config.js";
import { agentEnvironment } from "../security.js";
import { ProjectMemoryReader, type MemoryReaderOptions } from "../projectMemory.js";
import { agentRunError, parseAgentResult, parseStructuredResult, SessionIdentityMismatch } from "./resultParser.js";
import { codexHomeUsage, ExecutionMetrics } from "./executionMetrics.js";
import { createToolTimeMeter } from "./toolTime.js";
import { resolveSupportedTurn, runnerControlPaths, type TurnPolicy } from "./turnPolicy.js";
import { nativeFigma, NATIVE_FIGMA_READS } from "./nativeFigma.js";

export interface CodexAdapterOptions {
  memoryReaderOptions?: MemoryReaderOptions;
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
  // 역할 정책(turnPolicy.ts)의 웹·하위 에이전트 팬아웃 값 — 이 파일은 그대로 옮기기만 한다.
  web: boolean;
  fanout: boolean;
  writable: boolean;
  toolsDisabled: boolean;
  // 호스트 격리 입력(E2e.md 규칙 2) — 읽기 경로를 작업 폴더·실행 파일·요청 경로로 좁히고, 프로젝트 문서·메모리·플러그인·skill 검색을 끈다.
  isolated: boolean;
  // 턴 단위 추가 읽기 허용(주제 plan.md 등).
  readablePaths: readonly string[];
  // 승인 경로만 쓰기(E2e-3) — 작업 폴더의 실제 경로 기준. 있으면 작업 폴더는 읽기, 이 경로만 쓰기, Git 메타데이터는 거부한다. 없으면 기존 쓰기 턴이다.
  writablePaths?: readonly string[];
}

// 관리형 CODEX_HOME에 매 턴 덮어쓰는 최소 설정. 사용자 mcp_servers/notify/plugins/marketplaces/shell_environment_policy를
// 물려받지 않는다. 승인된 Figma만 턴별 호스트 MCP로 연결한다. 구형 sandbox_mode는 읽을 수 있는 경로를 좁히지 못하므로 쓰지 않고,
// permission profile이 worktree·Git metadata·검토된 skill만 읽게 한다.
// 모델과 추론 강도는 이 파일에 복사하지 않고 각 CLI 호출의 명시 인자로 전달한다.
const MANAGED_CONFIG_HEADER = [
  "# Consensus Room이 턴마다 다시 쓰는 파일이다. 손으로 고쳐도 다음 턴에 사라진다.",
  'approval_policy = "never"',
];

// V2 하위 에이전트는 별도 모델 override를 받지 않고 그 턴의 Root 모델·추론 강도를 상속한다.
// max_concurrent_threads_per_session은 Root를 포함하므로 3이면 동시에 하위 에이전트 2개까지 실행할 수 있다.
function managedConfigBody(boundary: CodexPermissionBoundary): string {
  const profile = boundary.writable ? "consensus-implement" : "consensus-review";
  // 승인 경로만 쓰기(E2e-3) — 경로 검증은 어댑터 입구(turnPolicy.writeScopeProblem)가 끝냈다. 여기는 경로별 권한으로 옮기기만 한다.
  const scopedWrite = boundary.writable && boundary.writablePaths !== undefined ? boundary.writablePaths : null;
  // 쓰기 턴에도 Git 상태 변경과 실행 설정·skill 변경은 호스트가 소유한다. 승인 경로만 쓰기 턴은 Git 메타데이터를 읽기까지 막는다(자동 수정 인계의 기존 경계).
  // 러너 제어 경로(지시문·실행 설정·단계 도구 트리)는 두 어댑터가 같은 목록을 쓴다(turnPolicy.runnerControlPaths, E2c).
  const hostOwned = boundary.writable
    ? [...(scopedWrite ? [] : [join(boundary.workspace, ".git")]), ...runnerControlPaths(boundary.workspace)] : [];
  // 거부할 Git 메타데이터는 작업 폴더의 .git 과 공통 Git 디렉터리다 — 연결 worktree 의 .git 은 파일이고 메타데이터는 작업 폴더 밖 원본 저장소에 있다.
  // 이 안의 경로는 읽기 목록에서 빼서 deny 만 남긴다(같은 키를 read·deny 로 두 번 쓰면 설정 파싱이 실패한다, host-review E2e-3 1차 F001).
  const gitMetadata = scopedWrite ? uniquePaths([join(boundary.workspace, ".git"), boundary.gitCommonDirectory]) : [];
  // 격리 턴은 운영 도구가 쓰던 권한 경계와 같다 — 작업 폴더·실행 파일(자기 재실행)·요청 경로만 읽는다. 관리형 홈·skill·지시문·Git 설정은 넣지 않는다.
  const readablePaths = (boundary.isolated
    ? uniquePaths([boundary.workspace, ...boundary.readablePaths, boundary.codexExecutable, ...hostOwned])
    : uniquePaths([
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
    ...hostOwned,
  ])).filter(path => !scopedWrite?.includes(path) && !gitMetadata.some(git => isPathInside(git, path)));
  // 도구를 닫은 턴과 격리 턴은 프로젝트 문서를 싣지 않는다. 격리 턴은 도구를 쓰더라도 호스트 밖 입력(메모리·플러그인·앱·skill 검색)을 끈다.
  const disabledFeatures = [
    ...(boundary.toolsDisabled ? ["shell_tool", "unified_exec", "multi_agent", "view_image", "apps", "browser_use", "computer_use",
      "plugins", "memories", "code_mode_host", "workspace_dependencies", "skill_search", "image_generation"] : []),
    // 팬아웃을 금지한 모든 턴은 하위 에이전트 경로를 모두 닫는다 — multi_agent_v2 표만 끄면 별도 기능 multi_agent가 켜진 채 남는다
    // (host-review F004, CLI 0.155 `codex features list` 실효값: multi_agent=true, multi_agent_v2=false).
    ...(!boundary.fanout ? ["multi_agent"] : []),
    ...(boundary.isolated ? ["memories", "plugins", "apps", "skill_search"] : []),
    // Apps are available only through the scoped, observed host transport below. Remote plugin state must not expose unobserved tools.
    "apps", "plugins",
  ].filter((feature, index, all) => all.indexOf(feature) === index);
  const deniedPaths = uniquePaths([join(boundary.topicHome, "auth.json"), boundary.managedAuthPath, boundary.sourceAuthPath, ...gitMetadata]);
  return [
    ...MANAGED_CONFIG_HEADER,
    `default_permissions = ${tomlString(profile)}`,
    // 웹 차단은 최상위 web_search 다 — [tools] web_search=false 만으로는 웹 도구(web__run)가 남았다(2026-09-25 호스트 실제 CLI 탐침, CLI 0.155:
    // "Set `web_search` to live/indexed/cached/disabled at the top level"). 최상위 키라 표보다 앞에 둔다.
    ...(!boundary.web ? ['web_search = "disabled"'] : []),
    // A single scoped instruction source prevents native discovery from restoring interactive-only rules.
    "project_doc_max_bytes = 0",
    ...(disabledFeatures.length ? ["[features]", ...disabledFeatures.map(feature => `${feature} = false`)] : []),
    // 격리 턴의 skill 차단 — 내장(.system) skill 을 끄고 skill 목록을 싣지 않는다. 사용자 skill 은 발견 경로($HOME/.agents/skills)를 격리 HOME 으로
    // 없앤다(prepareIsolatedHome). 근거: codex debug prompt-input 실측(E2e.md "격리 입력 실측").
    ...(boundary.isolated ? ["", "[skills]", "include_instructions = false", "", "[skills.bundled]", "enabled = false"] : []),
    "",
    // 웹 검색·하위 에이전트는 역할 정책(policy.web·policy.fanout)을 옮긴다 — 프로토콜 확인 턴은 판단에 필요한 값을 프롬프트가 다 담고 있으므로
    // 정책이 둘 다 닫는다(계획 제어 턴도 같다).
    "# 정책: 웹 검색과 공개 문서 읽기는 기본 개방. 확장 서버·알림 훅은 계속 차단(sandbox 밖 프로세스).",
    "[tools]",
    `web_search = ${boundary.web ? "true" : "false"}`,
    "",
    "[features.multi_agent_v2]",
    `enabled = ${boundary.fanout ? "true" : "false"}`,
    "max_concurrent_threads_per_session = 3",
    "expose_spawn_agent_model_overrides = false",
    `subagent_developer_instructions = ${tomlString("전달받은 범위만 직접 처리하고 추가 하위 에이전트를 생성하거나 위임하지 마세요. 파일을 수정하지 마세요.")}`,
    "",
    "# Codex host는 인증 파일을 사용하지만 model-generated shell에는 worktree와 검토된 skill만 보인다.",
    `[permissions.${profile}]`,
    `description = ${tomlString(boundary.writable ? "Consensus Room scoped implementation" : "Consensus Room read-only review")}`,
    "",
    `[permissions.${profile}.workspace_roots]`,
    `${tomlString(boundary.workspace)} = true`,
    "",
    `[permissions.${profile}.filesystem]`,
    '":minimal" = "read"',
    ...readablePaths.map((path) => `${tomlString(path)} = "${boundary.writable && !scopedWrite && path === boundary.workspace ? "write" : "read"}"`),
    ...uniquePaths(scopedWrite ?? []).map((path) => `${tomlString(path)} = "write"`),
    ...deniedPaths.map((path) => `${tomlString(path)} = "deny"`),
    "",
    `[permissions.${profile}.network]`,
    "enabled = false",
    "",
  ].join("\n");
}

export class CodexAdapter implements AgentAdapter {
  readonly role = "codex" as const;
  private readonly memory: ProjectMemoryReader | null;

  constructor(
    private readonly runner: CommandRunner,
    private readonly schemaPath = join(process.env.CONSENSUS_ROOM_DATA_DIR ?? defaultDataDirectory(), "agent-result.schema.json"),
    // 앱 수명 동안 유지되는 단일 관리형 홈. 액션마다 임시 디렉터리를 만들면 이 아래 세션이 사라져 exec resume이 깨진다.
    // 기본값을 schemaPath 옆에 두면 index.ts가 주는 dataDirectory를 그대로 따라간다.
    private readonly codexHome = join(dirname(schemaPath), "codex-home"),
    memoryDirectory?: string,
    private readonly options: CodexAdapterOptions = {},
  ) {
    this.memory = memoryDirectory ? new ProjectMemoryReader(memoryDirectory, options.memoryReaderOptions) : null;
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

  // 소비처 schema 의 결과(엔진 개편 E2e) — 같은 실행 경로에 schema 파일만 바꾼다. 턴 완료 이벤트가 없으면 결과로 채택하지 않는다(운영 도구의 "정상 완료" 조건).
  async createStructuredSession(turn: Omit<SessionTurn, "sessionId">, schema: OutputSchema): Promise<{ sessionId: string; value: Record<string, unknown> }> {
    const output = await this.invoke(turn, ["exec", "--json", "--output-schema", this.schemaPath, "-"], true, schema);
    const sessionId = extractThreadId(output.jsonLines);
    if (!sessionId) throw new Error("Codex 응답에서 thread ID를 찾지 못했습니다.");
    return { sessionId, value: structuredValue(output) };
  }

  async resumeStructuredTurn(turn: SessionTurn, schema: OutputSchema): Promise<Record<string, unknown>> {
    const output = await this.invoke(turn, ["exec", "resume", turn.sessionId, "--json", "--output-schema", this.schemaPath, "-"], false, schema);
    return structuredValue(output);
  }

  // 호스트 소유 세션 홈의 native 세션 기록 확인(E2e-2) — 읽기만 한다(홈에 쓰거나 만들지 않고, 공급자를 띄우지 않는다).
  // 재개할 수 있는 기록: 홈의 sessions 아래(심볼릭 링크를 따라가지 않고, 실제 경로가 홈 안), 파일명에 ID 가 든 JSONL 의 첫 줄이 session_meta 이고
  // 그 id·cwd 가 요청과 같다. thread.started 이벤트나 색인 한 줄만으로는 재개할 수 없다(운영 도구가 써 온 판정과 같다).
  async inspectSession(sessionHome: string, cwd: string, sessionId: string): Promise<{ exists: boolean; reason: string }> {
    if (sessionId !== sessionId.toLowerCase()) return { exists: false, reason: "세션 ID 가 정규형이 아닙니다" };
    const home = await realpath(resolve(sessionHome)).catch(() => null);
    if (!home) return { exists: false, reason: "세션 홈이 없습니다" };
    const candidates: string[] = [];
    const visit = async (directory: string, depth: number): Promise<void> => {
      if (depth > 6 || candidates.length >= 50) return;
      for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
        const path = join(directory, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) await visit(path, depth + 1);
        else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) candidates.push(path);
      }
    };
    await visit(join(home, "sessions"), 0);
    for (const path of candidates) {
      const real = await realpath(path).catch(() => null);
      if (!real || !isPathInside(home, real)) continue;
      const handle = await open(real, "r").catch(() => null);
      if (!handle) continue;
      try {
        // 첫 줄은 base_instructions 를 포함해 크다 — 상한 안에서 첫 개행까지만 읽는다.
        const buffer = Buffer.alloc(4 * 1024 * 1024);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const text = buffer.subarray(0, bytesRead).toString("utf8");
        const end = text.indexOf("\n");
        if (end < 0) continue;
        const meta = JSON.parse(text.slice(0, end)) as { type?: unknown; payload?: { id?: unknown; cwd?: unknown } };
        if (meta.type === "session_meta" && meta.payload?.id === sessionId && meta.payload?.cwd === resolve(cwd)) {
          return { exists: true, reason: "native 세션 기록이 있습니다" };
        }
      } catch { /* 읽을 수 없거나 JSON 이 아닌 기록은 재개 근거가 아니다 */ } finally {
        await handle.close();
      }
    }
    return { exists: false, reason: candidates.length ? "세션 기록이 요청 ID·cwd 와 맞지 않습니다" : "세션 기록이 없습니다" };
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
    outputSchema?: OutputSchema,
  ): ReturnType<CodexAdapter["invokeExclusively"]> {
    const key = resolve(turn.cwd);
    const previous = this.topicQueues.get(key) ?? Promise.resolve();
    const run = waitWithSignal(previous, turn.signal).then(async () => {
      const release = await this.slots.acquire(turn.signal);
      try {
        return await this.invokeExclusively(turn, commandArgs, newSession, outputSchema);
      } finally {
        release();
      }
    });
    this.topicQueues.set(key, Promise.allSettled([previous, run]));
    return run;
  }

  private async invokeExclusively(
    turn: Omit<SessionTurn, "sessionId"> | SessionTurn,
    commandArgs: string[],
    newSession: boolean,
    outputSchema?: OutputSchema,
  ) {
    // 명시적 job 의 도구 접근을 권한 프로필로 옮긴다. 확인·계획 제어 턴은 쓰기 job 이어도 파일을 쓸 수 없다.
    const { policy, protocolOnly } = resolveSupportedTurn("codex", turn);
    // -s/-a are top-level Codex options. resume 뒤에 놓으면 CLI가 거부한다.
    await mkdir(dirname(this.schemaPath), { recursive: true });
    // Separate immutable contents prevent parallel normal/controlled topics from replacing each other's schema.
    // 소비처 schema 는 내용 해시 파일이다 — 같은 데이터 폴더를 쓰는 다른 소비처의 schema 를 덮지 않는다(E2e.md 규칙 4).
    const schemaContents = JSON.stringify(outputSchema ?? (turn.planningControl ? CodexPlanningAgentResultJsonSchema : AgentResultJsonSchema), null, 2);
    const schemaPath = outputSchema
      ? join(dirname(this.schemaPath), "output-schemas", `${createHash("sha256").update(schemaContents).digest("hex")}.json`)
      : turn.planningControl ? `${this.schemaPath}.planning.json` : this.schemaPath;
    await mkdir(dirname(schemaPath), { recursive: true });
    const schemaTemp = `${schemaPath}.${randomUUID()}.tmp`;
    await writeFile(schemaTemp, schemaContents, { mode: 0o600 });
    await rename(schemaTemp, schemaPath);
    commandArgs = commandArgs.map(arg => arg === this.schemaPath ? schemaPath : arg);
    if (turn.planningControl?.image) commandArgs.splice(commandArgs.length - 1, 0, "--image", turn.planningControl.image.path);
    // snapshot 작업 폴더는 Git 저장소가 아니다(E2e.md 규칙 3). 격리 턴은 실행 규칙(.rules) 파일을 읽지 않는다 — 지시문 차단은 관리형 홈·project_doc_max_bytes 가 맡는다.
    if (turn.snapshotWorkspace) commandArgs.splice(commandArgs.length - 1, 0, "--skip-git-repo-check");
    if (policy.isolated) commandArgs.splice(commandArgs.length - 1, 0, "--ignore-rules");
    // 호스트 소유 세션 홈은 격리 턴에만 쓴다 — 런타임 요청 검증과 별개로 어댑터 입구에서도 막는다(엔진 턴에 임의 홈이 들어오지 않게).
    if (turn.sessionHome !== undefined && !policy.isolated) throw new Error("sessionHome 은 격리 턴에만 쓸 수 있습니다.");
    const topicHome = await this.prepareManagedHome(turn.cwd, policy, turn.readablePaths ?? [], turn.sessionHome,
      policy.scopedWrite ? turn.writablePaths : undefined);
    // 격리 턴은 프롬프트가 입력 전부다 — 메모리·지시문·실행 정책 안내문을 싣지 않는다(E2e.md 규칙 2). HOME 도 격리 홈 안의 빈 폴더로 바꿔 사용자
    // 수준 skill($HOME/.agents/skills)·셸 시작 파일이 끼어들지 못하게 한다(인증은 CODEX_HOME 의 auth.json 이다).
    if (policy.isolated) return this.run(turn, commandArgs, newSession, topicHome, turn.prompt, topicHome, { HOME: join(topicHome, "home") });
    // 메모리는 세션 생성 턴에만 주입한다(claude 어댑터와 같은 근거 — resume은 스레드가 이미 기억,
    // 매 턴 재주입은 턴당 ~20K자 중복). protocolOnly 턴은 새 세션이어도 주입하지 않는다. 예외 하나(E3-4c F004): 프로토콜 턴이 만든 세션은 본문을 받지
    // 않았다 — 엔진이 그 세션의 첫 일반 resume 에 memoryBodies 를 실으면 그 resume 에 한 번 싣는다(매니페스트 없이).
    const injectMemory = Boolean(this.memory) && !protocolOnly && !turn.planningControl && (newSession || turn.memoryBodies === true);
    const enriched = injectMemory
      ? await this.memory!.buildPrompt(turn.prompt, this.role, turn.signal)
      : turn.planningControl ? turn.prompt : await this.withMemoryManifest(turn, protocolOnly);
    // 프로토콜 확인 턴은 판단에 필요한 값을 프롬프트가 다 담고 있어 프로젝트 지시문(AGENTS.md)도 싣지 않는다
    // (2026-09-07 Codex 자기 최적화 제안 ②: ACK 턴마다 지시문 블록을 재전송하던 낭비).
    const { blocks: instructions } = protocolOnly || turn.planningControl?.instructionsProvided || (!newSession && turn.planningControl?.instructionsInSession)
      ? { blocks: [] as string[] }
      : await readAppliedInstructions({
        strict: Boolean(turn.planningControl), signal: turn.signal,
        workspace: turn.cwd, fileName: "AGENTS.md", repositoryPath: this.options.repositoryPath ?? null,
        globalPath: join(this.userCodexHome(), "AGENTS.md"),
        injectWorkspaceFile: true,
      });
    // Config instructions are session context, not another user message on every resume.
    // Controlled input remains in the host's measured/required fragment queue.
    const controlled = protocolOnly || Boolean(turn.planningControl);
    const systemInstructions = controlled ? "" : [executionPolicyNote(turn.engineDefectFix), ...instructions].join("\n\n");
    if (!controlled) commandArgs = ["-c", `developer_instructions=${tomlString(systemInstructions)}`, ...commandArgs];
    const instructionBytes = Buffer.byteLength(systemInstructions, "utf8");
    const stdin = controlled ? [executionPolicyNote(turn.engineDefectFix), ...instructions, enriched].join("\n\n") : enriched;
    if (turn.planningControl && Buffer.byteLength(stdin) > turn.planningControl.maxPromptBytes) {
      throw new PlanningPaused("Final planning input including mandatory instructions exceeds its byte limit.");
    }
    if (!policy.figma) return this.run(turn, commandArgs, newSession, topicHome, stdin, this.codexHome, {}, instructionBytes);
    const figma = await nativeFigma(resolveCodexExecutable(), join(this.codexHome, "auth.json"), turn.cwd, turn);
    try {
      const mcp = ["-c", `mcp_servers.figma-native.url=${JSON.stringify(figma.url)}`, "-c", `mcp_servers.figma-native.enabled_tools=${JSON.stringify(NATIVE_FIGMA_READS)}`];
      const result = await this.run(turn, [...mcp, ...commandArgs], newSession, topicHome, stdin, this.codexHome, {}, instructionBytes);
      figma.assertCaptured(); return result;
    } finally { await figma.close(); }
  }

  // 준비가 끝난 턴의 실행 — 사용량 관측·세션 알림·실패 판정. usageHome 은 세션 기록 원본이 있는 홈이다(격리 홈은 자기 안에 둔다).
  private async run(
    turn: Omit<SessionTurn, "sessionId"> | SessionTurn,
    commandArgs: string[],
    newSession: boolean,
    topicHome: string,
    stdin: string,
    usageHome: string,
    environment: NodeJS.ProcessEnv,
    instructionBytes = 0,
  ) {
    const executionSettings = turn.settings ?? DEFAULT_AGENT_SETTINGS.codex;
    const startedAt = Date.now();
    const toolTime = createToolTimeMeter("codex");
    const metrics = new ExecutionMetrics("codex", Buffer.byteLength(stdin, "utf8") + instructionBytes, executionSettings.model, executionSettings.effort, !newSession, startedAt);
    // 재개 턴의 실제 공급자 세션(E2e-2 host-review F001) — 재개 스트림의 thread.started 는 요청 ID 와 같은 문자열이어야 한다. 다른 ID·ID 없음·
    // null·숫자·빈 문자열이면 그 응답은 이 세션의 결과가 아니다. thread.started 이벤트 자체가 없으면(전환 전 운영 도구와 같은 조건) 요청 세션으로 둔다.
    const requestedSessionId = !newSession && "sessionId" in turn ? turn.sessionId : undefined;
    const foreignThreads: string[] = [];
    let returnedThread: string | null = null;
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
      beforeSpawn: turn.beforeSpawn, admitSync: turn.admitSync,   // 슬롯 대기·관리형 홈 준비가 끝난 뒤, spawn 직전
        onInterruptedOutput: turn.onInterruptedOutput,
      onJSONLine: (value, at) => {
        toolTime.observe(value, at); metrics.observe(value);
        if (typeof value === "object" && value !== null && "type" in value && value.type === "thread.started") {
          const threadId = (value as { thread_id?: unknown }).thread_id;
          if (newSession) {
            if (typeof threadId === "string") turn.onSessionCreated?.(threadId);
          } else if (requestedSessionId !== undefined && threadId !== requestedSessionId) {
            foreignThreads.push(threadId === undefined ? "ID 없음" : JSON.stringify(threadId));
            returnedThread ??= typeof threadId === "string" ? threadId : foreignThreads.at(-1)!;
          }
        }
        // 공급자가 보고한 원시 사용량(E2e-2) — 합산·보정 없이 그대로 알린다. 관찰자가 던져도 턴은 계속된다.
        if (turn.onProviderUsage && typeof value === "object" && value !== null && (value as { type?: unknown }).type === "turn.completed") {
          const usage = (value as { usage?: unknown }).usage;
          if (usage && typeof usage === "object" && !Array.isArray(usage)) {
            try { turn.onProviderUsage(usage as Record<string, unknown>); } catch { /* observer is non-fatal */ }
          }
        }
      },
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
      environment: agentEnvironment({ ...environment, CODEX_HOME: topicHome }),
    });
    for (const value of output.jsonLines) metrics.observe(value);
    // CLI 스트림 값과 관리형 홈 원본을 합산하지 않는다. 새 세션의 id는 stream에서만 알 수 있어
    // 이 실행 구간의 thread.started를 사용하고, 대조 불가 상태도 명시한다.
    const sessionId = newSession
      ? output.jsonLines.find((value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "thread.started" && typeof (value as { thread_id?: unknown }).thread_id === "string") as { thread_id?: string } | undefined
      : undefined;
    const resumedSessionId = "sessionId" in turn ? turn.sessionId : undefined;
    metrics.setCodexHomeUsage(await codexHomeUsage([usageHome, topicHome], resumedSessionId ?? sessionId?.thread_id, startedAt));
    recordFinal();
    if (foreignThreads.length > 0) {
      throw new SessionIdentityMismatch("codex", requestedSessionId!, returnedThread!,
        `재개한 Codex 세션(${foreignThreads[0]})이 요청한 세션(${requestedSessionId})과 다릅니다. 다른 대화의 응답을 이 세션의 결과로 채택하지 않습니다.`);
    }
    if (output.exitCode !== 0) {
      throw agentRunError("codex", output.exitCode, output.stderr, output.stdout);
    }
    return output;
    } finally {
      clearInterval(progressTimer);
      recordFinal();
    }
  }


  // resume·fork 턴에는 본문 대신 매니페스트만 덧붙인다. protocolOnly 턴(resolveTurn 이 job 에서 유도한 값)은 메모리 자체가 필요 없다.
  private async withMemoryManifest(
    turn: Omit<SessionTurn, "sessionId"> | SessionTurn,
    protocolOnly: boolean,
  ): Promise<string> {
    if (!this.memory || protocolOnly) return turn.prompt;
    const manifest = await this.memory.buildManifest(turn.prompt, this.role, turn.signal);
    return manifest ? `${turn.prompt}\n\n${manifest}` : turn.prompt;
  }

  // 홈 자체는 지속되지만 설정은 턴마다 다시 쓴다. 외부에서 드리프트가 생겨도 다음 턴에 사라지게 하려는 것이고,
  // schemaPath를 매번 쓰는 위 패턴과 같다. 공유 홈(인증·skills·전역 규칙·세션 상태)을 먼저 정리한 뒤 토픽 홈을 그 위에 얹는다.
  private async prepareManagedHome(cwd: string, policy: Pick<TurnPolicy, "web" | "fanout" | "tools" | "isolated">, readablePaths: readonly string[] = [],
    sessionHome?: string, writablePaths?: readonly string[]): Promise<string> {
    // 쓰기 턴의 권한 경계는 작업 폴더의 실제 경로로 쓴다(E2c) — Codex CLI 는 심볼릭 링크가 든 쓰기 루트를 거부하고("writable root … contains symlink
    // component …; symlinked writable roots are not supported", 2026-09-25 호스트 OS 검사), sandbox 는 커널의 실제 경로로 대조한다. 그 거부는 쓰기
    // 루트에 대한 것이라 읽기 턴의 경계는 그대로 둔다. 관리형 홈 키는 넘겨받은 경로 그대로다 — 세션 저장소 위치를 바꾸지 않는다.
    const given = resolve(cwd);
    const writable = policy.tools === "write";
    const workspace = writable ? await realpath(given) : given;
    // 승인 경로는 작업 폴더 아래 링크가 없음을 입구가 확인했다 — 같은 상대 경로를 작업 폴더의 실제 경로에 붙이면 쓰기 루트의 실제 경로가 된다.
    const scoped = writable && writablePaths ? writablePaths.map(path => join(workspace, relative(given, path))) : undefined;
    if (policy.isolated) return this.prepareIsolatedHome(given, workspace, policy, readablePaths, sessionHome, scoped);
    if (writable) {
      // 작업 디렉터리 안에 관리형 홈을 두면 broad write 로 다음 턴의 설정·세션을 바꿀 수 있다.
      const canonicalWorkspace = workspace;
      await mkdir(this.codexHome, { recursive: true });
      const canonicalHome = await realpath(this.codexHome);
      if (isPathInside(canonicalWorkspace, canonicalHome) || isPathInside(canonicalHome, canonicalWorkspace)) {
        throw new Error("Codex 쓰기 작업 폴더와 관리형 홈은 서로 겹칠 수 없습니다.");
      }
    }
    const shared = this.sharedHomeQueue.then(() => this.prepareSharedHome());
    this.sharedHomeQueue = shared.catch(() => undefined);
    const { skillSourceDirectories, globalInstructionPaths } = await shared;
    const instructionPaths = uniquePaths([
      ...globalInstructionPaths,
      ...await findInstructionPaths(workspace),
    ]);
    const topicHome = this.managedHomeFor(given);
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
      web: policy.web,
      fanout: policy.fanout,
      writable,
      // 계획 제어와 확인 전용 턴 모두 공통 정책의 tools=none을 실제 CLI 기능 차단으로 옮긴다.
      toolsDisabled: policy.tools === "none",
      isolated: false,
      readablePaths,
      writablePaths: scoped,
    };
    await writeFile(join(topicHome, "config.toml"), managedConfigBody(boundary), { mode: 0o600 });
    return topicHome;
  }

  // 호스트 격리 입력의 관리형 홈(E2e.md 규칙 2) — 운영 도구가 작업마다 쓰던 홈과 같은 구성이다: 인증 링크와 이 설정 파일만 둔다. 공유 홈의 세션·
  // 전역 AGENTS·skills 를 링크하지 않고, 세션은 이 홈 안에 쌓인다(같은 cwd 가 같은 홈이라 재개된다). 전역 지시문 파일이 생겨 있으면 싣지 않고 멈춘다.
  // 호스트가 세션 홈을 넘기면(sessionHome, 운영 도구의 작업별 기존 홈) 그 홈을 그대로 쓴다 — 설정은 매 턴 다시 쓰고, 기존 세션·인증 링크는 둔다.
  private async prepareIsolatedHome(given: string, workspace: string, policy: Pick<TurnPolicy, "web" | "fanout" | "tools">,
    readablePaths: readonly string[], sessionHome?: string, writablePaths?: readonly string[]): Promise<string> {
    const home = sessionHome ? resolve(sessionHome) : join(this.codexHome, "isolated", managedHomeKey(given));
    // 공급자 프로세스의 HOME — 비어 있는 호스트 소유 폴더다(사용자 수준 skill·셸 시작 파일·Git 설정이 없다).
    await mkdir(join(home, "home"), { recursive: true });
    for (const name of ["AGENTS.md", "AGENTS.override.md"]) {
      if (await lstat(join(home, name)).catch(() => null)) throw new Error(`격리 턴의 관리형 Codex 홈에 전역 지시문이 있습니다: ${join(home, name)}`);
    }
    const sourceAuth = join(this.userCodexHome(), "auth.json");
    // 이미 있으면 건드리지 않는다(갱신된 자격증명일 수 있다). 내용은 읽지 않는다.
    if (!await lstat(join(home, "auth.json")).catch(() => null)) await symlink(sourceAuth, join(home, "auth.json")).catch(() => undefined);
    // 격리 턴은 공통 Git 디렉터리를 읽기에 넣지 않는다. 승인 경로만 쓰기 턴에서는 그 경로를 거부 대상으로만 쓴다(연결 worktree 의 메타데이터).
    const boundary: CodexPermissionBoundary = {
      topicHome: home, workspace, gitCommonDirectory: writablePaths ? findGitCommonDirectory(workspace) : null,
      managedSkillsDirectory: join(home, "skills"), skillSourceDirectories: [],
      instructionPaths: [], managedAuthPath: join(home, "auth.json"), sourceAuthPath: sourceAuth, codexExecutable: resolveCodexExecutable(),
      web: policy.web, fanout: policy.fanout, writable: policy.tools === "write", toolsDisabled: policy.tools === "none", isolated: true,
      readablePaths: [...readablePaths, join(home, "home")],
      writablePaths,
    };
    await writeFile(join(home, "config.toml"), managedConfigBody(boundary), { mode: 0o600 });
    return home;
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
export function resolveCodexExecutable(): string {
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

  async acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted();
    if (this.active >= this.limit) await new Promise<void>((resolve,reject) => {
      const ready=()=>{signal?.removeEventListener("abort",abort);resolve();};
      const abort=()=>{const index=this.waiters.indexOf(ready);if(index>=0)this.waiters.splice(index,1);reject(signal?.reason);};
      signal?.addEventListener("abort",abort,{once:true});
      this.waiters.push(ready);
    });
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

function waitWithSignal<T>(promise:Promise<T>,signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal?.reason);
    signal?.addEventListener("abort",abort,{once:true});
    promise.then(value=>{signal?.removeEventListener("abort",abort);resolve(value);},error=>{signal?.removeEventListener("abort",abort);reject(error);});
  });
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
  return scope === "" || (scope !== ".." && !scope.startsWith(`..${sep}`) && !isAbsolute(scope));
}

function uniquePaths(paths: readonly (string | null)[]): string[] {
  return [...new Set(paths.filter((path): path is string => Boolean(path)).map((path) => resolve(path)))];
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

// 턴 완료 이벤트가 있는 실행의 마지막 응답만 결과로 채택한다(E2e.md 규칙 4 — 운영 도구가 요구하던 turn.completed 조건).
function structuredValue(output: { jsonLines: unknown[]; stdout: string }): Record<string, unknown> {
  const completed = output.jsonLines.some(line => Boolean(line) && typeof line === "object" && (line as { type?: unknown }).type === "turn.completed");
  if (!completed) throw new Error("Codex 턴이 완료 이벤트(turn.completed) 없이 끝났습니다. 결과를 채택하지 않습니다.");
  return parseStructuredResult(output.jsonLines, output.stdout);
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
