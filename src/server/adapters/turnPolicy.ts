import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import { parseProviderOptions, turnAccess, turnFlags, type ProviderOptions, type TurnAccess, type TurnJob } from "../../shared/roles.js";
import { toolTreeDirectories } from "../toolTree.js";
import type { AgentAdapter, OutputSchema, SessionTurn } from "../types.js";

// 역할 정책(엔진 개편 E2a) — job 과 턴 형태에서 계산한다. 공급자 이름을 입력으로 받지 않는다(plan §2.2·§2.3: 정책은 엔진, 변환은 어댑터).
// 두 어댑터는 이 값을 자기 CLI 인자·설정으로 변환만 하고, 표현할 수 없는 정책은 조용히 바꾸지 않고 실행 전에 거부한다.
// 문맥 압축 창·ultracode 같은 공급자 고유 옵션과 모델·추론 설정은 여기서 정하지 않는다(Claude 변환층·프로필 경계).
export interface TurnShape {
  planMode?: boolean;
  // 프로토콜 확인 턴 — job 이 있으면 job 에서 유도한 값이다(resolveTurn).
  protocolOnly?: boolean;
  evidenceManaged?: boolean;
  planningControl?: boolean;
  // 호스트가 Figma 읽기를 열고 관측 수신처를 붙였다(증거 관리 래퍼).
  figmaRequested?: boolean;
  // 호스트 격리 입력(엔진 개편 E2e) — 운영 도구가 입력 전체(스냅샷·프롬프트)를 고정한 턴. 정책을 좁히기만 한다(E2e.md 규칙 1).
  isolated?: boolean;
  // 승인 경로만 쓰기(엔진 개편 E2e-3) — 쓰기 턴의 쓰기 범위를 호스트가 준 경로로 좁힌다(SessionTurn.writablePaths). 나머지는 읽기, Git 메타데이터는 거부.
  scopedWrite?: boolean;
}

export interface TurnPolicy {
  // job 의 접근 — 작업 환경(쓰기 sandbox 등)의 기준이다.
  access: TurnAccess;
  // 이번 턴에 노출하는 도구 — 프로토콜 확인·계획 제어 턴은 도구를 전부 닫는다.
  tools: TurnAccess;
  planMode: boolean;
  web: boolean;
  // 하위 에이전트 팬아웃 — 쓰기 턴과 검토자의 읽기 턴에서 연다(계획자 읽기 턴은 닫는다).
  fanout: boolean;
  figma: boolean;
  // 호스트 밖 입력 차단 — 프로젝트·전역 지시문, 메모리, skill, 실행 규칙 파일, 실행 정책 안내문을 싣지 않는다. 웹·팬아웃도 닫는다.
  // 운영 도구(착수 검사 등)가 기존 job 위에 얹는 좁은 계약이다 — 새 역할·작업을 만들지 않는다(엔진 라우팅·UI 에 노출하지 않는다).
  isolated: boolean;
  // 승인 경로만 쓰기 — 쓰기 턴에서만 뜻이 있다(쓰기 턴이 아니면 writeScopeProblem 이 실행 전에 거부한다). 정책을 좁히기만 한다.
  scopedWrite: boolean;
}

export function turnPolicy(job: TurnJob, shape: TurnShape): TurnPolicy {
  const access = turnAccess(job);
  const tools: TurnAccess = shape.protocolOnly || shape.planningControl ? "none" : access;
  const isolated = Boolean(shape.isolated);
  return {
    access,
    tools,
    planMode: Boolean(shape.planMode) && access !== "write",
    web: tools === "read" && !shape.evidenceManaged && !isolated,
    fanout: !isolated && (tools === "write" || (tools === "read" && job.role === "reviewer")),
    figma: tools === "write" && Boolean(shape.figmaRequested),
    isolated,
    scopedWrite: Boolean(shape.scopedWrite),
  };
}

// 공급자 어댑터의 기능표(엔진 개편 E2c) — 어댑터가 자기 CLI 로 표현할 수 있는 정책 기능. 지원 판정은 정책이 요구하는 기능과 이 표의 대조다(공급자
// 이름 분기가 아니다). 값은 실제 CLI 로 확인한 동작만 true 로 둔다 — 가짜 어댑터 테스트는 근거가 아니다.
// - Claude: 쓰기·쓰기 턴 팬아웃(Workflow)·웹·Figma 는 기존 실측. 읽기 턴 팬아웃은 E2c C2 에서 Workflow 허용·ultracode 를 쓰기 접근에서 떼어 연다 —
//   하위 에이전트가 부모의 --tools 상한을 물려받는 것은 기존 실측이고, 읽기 턴 Workflow 호출·하위 에이전트 쓰기 차단의 실제 CLI 확인은 E2c.md C2 기록.
// - Codex: 쓰기는 E2c-codex-write.md 실측(실제 exec → exec resume). 관측 가능한 Figma MCP 연결은 아직 없다. 호스트 격리 입력은 E2e-1 변환(관리형 홈에
//   인증·설정만, project_doc_max_bytes=0, --ignore-rules)과 호스트 실제 CLI 확인(E2e.md)이 근거다.
// - Claude 의 호스트 격리 입력 변환은 아직 없다 — 실행 전에 거부한다(E2e.md "이번에 하지 않는 것").
// - 승인 경로만 쓰기(E2e-3): Codex 는 권한 프로필의 경로별 write·deny 로 표현한다(자동 수정 인계가 쓰던 경계, 실제 CLI 확인은 E2e.md E2e-3).
//   Claude 변환은 아직 없다 — 실행 전에 거부한다.
export interface ProviderCapabilities {
  // 작업 폴더 쓰기(구현·수정 job).
  write: boolean;
  // 쓰기 턴의 하위 에이전트 팬아웃.
  writeFanout: boolean;
  // 도구가 열린 읽기 턴의 하위 에이전트 팬아웃(검토자).
  readFanout: boolean;
  // 읽기 턴의 웹 조회.
  web: boolean;
  // 구현 턴의 Figma 관측 연결(증거 관리 래퍼가 관측을 받는다).
  figma: boolean;
  // 호스트 격리 입력(운영 도구 턴) — 호스트 밖 지시문·메모리·skill·실행 규칙을 싣지 않는 실행.
  isolatedInput: boolean;
  // 승인 경로만 쓰기(운영 도구의 수정 턴) — 작업 폴더는 읽기, 지정 경로만 쓰기, Git 메타데이터 거부.
  scopedWrite: boolean;
}

export const PROVIDER_CAPABILITIES: Readonly<Record<"claude" | "codex", Readonly<ProviderCapabilities>>> = {
  claude: { write: true, writeFanout: true, readFanout: true, web: true, figma: true, isolatedInput: false, scopedWrite: false },
  codex: { write: true, writeFanout: true, readFanout: true, web: true, figma: false, isolatedInput: true, scopedWrite: true },
};

// 공급자 문맥 압축(E3-3a 복구 절차 2단계) — 확인된 기능만 쓴다. 호스트가 호출 단위로 부를 수 있는 압축은 두 공급자 모두 없다. Claude 는 CLI 자동 압축
// 설정(RUNNER_AUTO_COMPACT_WINDOW)만 이미 적용 중이다(automatic-only). 합성 프롬프트를 줄이는 것은 공급자 압축이 아니다. 복구는 이 사실을 기록하고
// 같은 route 의 새 세션으로 인계한다.
export const PROVIDER_COMPACTION: Readonly<Record<"claude" | "codex", "automatic-only" | "none">> = { claude: "automatic-only", codex: "none" };

// 거부 사유에 쓰는 어댑터 이름 — 역할 이름이 아니라 실행 도구 이름이다.
const ADAPTER_NAME: Readonly<Record<"claude" | "codex", string>> = { claude: "Claude", codex: "Codex" };

// 공급자가 이 정책을 자기 CLI 로 표현할 수 있는가(엔진 개편 E2b·E2c). 표현할 수 없으면 사유, 있으면 null.
// 어댑터 가드와 실행 전 판정(turnRouting.ts)·프로필 적합성 조회가 같은 함수를 쓴다 — 정책이 요구하는 기능을 기능표와 대조한다.
export function providerSupport(provider: "claude" | "codex", policy: TurnPolicy): string | null {
  const can = PROVIDER_CAPABILITIES[provider];
  const name = ADAPTER_NAME[provider];
  if (policy.access === "write" && !can.write) return `${name} 어댑터는 쓰기 턴을 실행할 수 없습니다`;
  if (policy.fanout && policy.tools === "write" && !can.writeFanout) return `${name} 어댑터는 쓰기 턴의 하위 에이전트 팬아웃을 표현할 수 없습니다`;
  if (policy.fanout && policy.tools === "read" && !can.readFanout) return `${name} 어댑터는 읽기 턴의 하위 에이전트 팬아웃을 표현할 수 없습니다`;
  if (policy.web && !can.web) return `${name} 어댑터는 웹 조회를 표현할 수 없습니다`;
  if (policy.figma && !can.figma) return `${name} 어댑터는 Figma 관측 연결을 지원하지 않습니다`;
  if (policy.isolated && !can.isolatedInput) return `${name} 어댑터는 호스트 격리 입력(지시문·메모리·skill·실행 규칙 차단)을 표현할 수 없습니다`;
  if (policy.scopedWrite && !can.scopedWrite) return `${name} 어댑터는 승인 경로만 쓰기(나머지 읽기·Git 메타데이터 거부)를 표현할 수 없습니다`;
  return null;
}

// 승인 경로만 쓰기의 경로 검증(엔진 개편 E2e-3) — 두 어댑터 입구(resolveSupportedTurn)가 부르는 한 곳이다. 런타임 CLI 도 서비스 → 어댑터로 여기를
// 지나므로 같은 사유로 공급자 실행 전에 거부된다. 경로는 작업 폴더 안의 절대 경로이고, 작업 폴더 아래에 심볼릭 링크가 없어야 한다(아직 없는 파일은 있는
// 조상까지) — 공급자 CLI 는 링크가 든 쓰기 루트를 받지 않고, 링크는 쓰기 범위를 작업 폴더 밖으로 넓힌다. 작업 폴더 자체는 기존 쓰기 턴이다.
// Git 메타데이터(.git, 대소문자 무관)와 러너 제어 경로(지시문·실행 설정·단계 도구 트리, runnerControlPaths)는 호스트 소유라 겹치면 거부한다 —
// 쓰기 턴 뒤 guardRunnerControl 이 어차피 그 변경을 위반으로 막으므로 모델 호출 전에 사유를 준다.
export function writeScopeProblem(workspace: string, writablePaths: readonly string[] | undefined, policy: TurnPolicy): string | null {
  if (writablePaths === undefined) return null;
  if (policy.tools !== "write") return "승인 경로 쓰기(writablePaths)는 쓰기 턴에만 쓸 수 있습니다.";
  if (writablePaths.length === 0) return "승인 경로 쓰기(writablePaths)가 비어 있습니다.";
  const root = resolve(workspace);
  const inside = (parent: string, child: string) => child === parent || child.startsWith(parent.endsWith(sep) ? parent : `${parent}${sep}`);
  const control = runnerControlPaths(root).map(path => resolve(path).toLowerCase());
  const realRoot = (() => { try { return realpathSync(root).toLowerCase(); } catch { return root.toLowerCase(); } })();
  for (const path of writablePaths) {
    if (!isAbsolute(path) || resolve(path) !== path) return `승인 경로는 정규화된 절대 경로여야 합니다: ${path}`;
    if (path === root || !inside(root, path)) return `승인 경로는 작업 폴더 안의 하위 경로여야 합니다: ${path}`;
    const parts = relative(root, path).split(sep);
    if (parts.some(part => part.toLowerCase() === ".git")) return `승인 경로가 Git 메타데이터를 지납니다: ${path}`;
    let current = root;
    for (const part of parts) {
      current = join(current, part);
      let stat;
      try { stat = lstatSync(current); } catch { break; }
      if (stat.isSymbolicLink()) return `승인 경로가 심볼릭 링크를 지납니다: ${current}`;
    }
    // 대소문자를 구분하지 않는 볼륨(macOS APFS 기본)에서 claude.md 도 CLAUDE.md 다 — 소문자로 대조한다. 경로는 작업 폴더의 실제 경로로도 맞춘다.
    const candidates = [path.toLowerCase(), join(realRoot, relative(root, path)).toLowerCase()];
    const overlap = control.find(entry => candidates.some(candidate => inside(entry, candidate) || inside(candidate, entry)));
    if (overlap) return `승인 경로가 러너 제어 경로와 겹칩니다: ${path} — 지시문·실행 설정·단계 도구 트리(${overlap})는 호스트가 소유합니다.`;
  }
  return null;
}

// 러너 제어 경로(엔진 개편 E2c) — 쓰기 턴에서도 러너가 바꾸지 못하는 작업 폴더 안의 지시문·실행 설정. 공급자와 무관하게 러너가 읽는 것을 막는다:
// 지시문 파일은 worktree 에 생기면 원본 저장소 사본 대신 주입되고(projectInstructions.ts, Codex CLI 는 cwd 의 AGENTS.md 를 직접 읽는다), 역할 배정으로
// 공급자를 섞으면 한 공급자의 구현자가 다른 공급자 검토자의 지시문을 심을 수 있다(host-review F002 계열). 두 어댑터가 이 목록을 같이 써서 한쪽만
// 갱신되는 누락을 막는다. 단계 도구 트리("러너는 앱 코드만", Codex 감사 R02)도 함께 돌려준다. Git 메타데이터는 어댑터마다 공통 디렉터리까지 따로 막는다.
// .claude 는 Claude 의 프로젝트 실행 설정 자리다(settings·agents·hooks·skills·commands·workflows) — 엔진 러너는 --setting-sources "" 로 읽지 않지만 다음
// 실행(다른 방식의 Claude 실행 포함)의 설정을 바꿀 수 있는 경로라 막는다. Claude CLI 는 턴마다 그 안에 자기 쓰기 기록(.claude/.cc-writes)을 만든다
// (2026-09-25 호스트 실측, CLI 2.1.280) — CLI 자신의 쓰기는 sandbox·권한 규칙 밖이라 이 보호와 부딪히지 않고, git 기준 감시만 그 경로를 좁게 뺀다.
export const RUNNER_CONTROL_ENTRIES = ["CLAUDE.md", "AGENTS.md", "AGENTS.override.md", ".claude", ".codex", ".agents"] as const;

// git 기준 감시에서 빼는 CLI 자기 기록 — 정확한 경로와 그 아래만(대소문자 변형은 빼지 않는다).
const CLI_OWNED_CONTROL_PATHS = [".claude/.cc-writes"] as const;

// 경로는 작업 폴더의 실제 경로(realpath) 기준이다. sandbox 는 커널이 보는 실제 경로로 규칙을 대조하는데, Claude CLI 는 규칙 경로를 realpath 가 성공할
// 때만 바꾼다 — 아직 없는 파일은 넘긴 문자열 그대로 남아, 작업 폴더가 심볼릭 링크 아래(/var → /private/var)면 거부 규칙이 걸리지 않았다(2026-09-25
// 호스트 탐침: Bash 가 CLAUDE.md·AGENTS.override.md·.codex·.agents 를 만들었다. CLI 2.1.280 의 경로 정규화 Ck 확인).
export function runnerControlPaths(workspace: string): string[] {
  let base = workspace;
  try { base = realpathSync(workspace); } catch { /* 없는 작업 폴더 — 넘긴 경로 그대로 */ }
  return [...RUNNER_CONTROL_ENTRIES.map(entry => join(base, entry)), ...toolTreeDirectories(workspace)];
}

const RUNNER_CONTROL_NAMES = new Set<string>(RUNNER_CONTROL_ENTRIES.map(entry => entry.toLowerCase()));

const isCliOwned = (path: string) => CLI_OWNED_CONTROL_PATHS.some(owned => path === owned || path.startsWith(`${owned}/`));

// 작업 폴더의 러너 제어 항목이 git HEAD 와 다른가 — 다른 경로와 git 상태(??·!!·M·D 등)를 돌려준다. 이름은 대소문자를 무시하고 맞춘다: 대소문자를
// 구분하지 않는 파일 시스템(macOS APFS 기본)에서는 claude.md 도 CLAUDE.md 로 읽히는데(projectInstructions·Codex CLI 의 AGENTS.md), 경로 문자열로 쓰기를
// 막는 두 sandbox 는 아직 없는 이름의 대소문자 변형 생성을 표현하지 못한다(사전 검증 0dd90d2). 기준은 git HEAD 다 — 재시작 뒤에도 같고, 저장소가
// 추적하는 지시문은 그대로 통과한다. 엔진 worktree 는 git 체크아웃이다.
// - 조회 경로는 디스크에 있는 이름이 아니라 고정 목록의 대소문자 무시 literal pathspec 이다 — 추적 중인 항목이 삭제돼 디스크에 이름이 없어도 잡는다
//   (host-review F002: 삭제되면 지시문이 원본 저장소 사본으로 바뀌거나 빠진다).
// - --ignored=traditional + --untracked-files=all 은 무시된 디렉터리 안의 파일을 경로마다 보여 준다 — CLI 자기 기록만 정확히 뺀다(host-review F001:
//   matching 모드는 무시된 .claude/ 를 디렉터리 하나로 돌려줘 .cc-writes 까지 막았다).
export function runnerControlDeviations(workspace: string): string[] {
  let status: string;
  try {
    status = execFileSync("git", ["-C", workspace, "status", "--porcelain=v1", "-z", "--ignored=traditional", "--untracked-files=all", "--",
      ...RUNNER_CONTROL_ENTRIES.map(entry => `:(icase,literal)${entry}`)], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    // git 저장소가 아닌(또는 없는) 작업 폴더 — 제어 항목이 없으면 대조할 것이 없다. 있으면 대조할 수 없으므로 그대로 실패시킨다.
    let names: string[] = [];
    try { names = readdirSync(workspace).filter(name => RUNNER_CONTROL_NAMES.has(name.toLowerCase())); } catch { /* 작업 폴더 없음 */ }
    if (names.length === 0) return [];
    throw error;
  }
  return status.split("\0").filter(Boolean)
    .filter(entry => !isCliOwned(entry.slice(3)))
    .map(entry => `${entry.slice(3)}(${entry.slice(0, 2).trim()})`)
    .sort();
}

// 러너 제어 경로 감시(엔진 개편 E2c) — 두 어댑터를 같은 방식으로 감싼다(app.ts). 턴을 시작하기 전(모든 역할)과 쓰기 턴이 끝난 뒤, 작업 폴더 루트의
// 러너 제어 항목이 git HEAD 와 다르면 멈춘다: 앞의 것은 이미 심긴 지시문을 어떤 러너도 읽지 않게, 뒤의 것은 심은 턴의 결과를 채택하지 않게 한다.
// 러너가 띄운 자식이 턴이 끝난 뒤에 쓴 것도 다음 턴 전에 잡는다(정상 종료 때 프로세스 그룹을 정리하지 않는다 — processRunner). 자동으로 지우지 않는다 —
// 단계 도구 트리 대조(delivery.assertToolTreesIntact)처럼 사람이 확인해 되돌리고 재시도한다.
export function guardRunnerControl(adapter: AgentAdapter): AgentAdapter {
  const check = (turn: Omit<SessionTurn, "sessionId">, when: string) => {
    const deviations = runnerControlDeviations(turn.cwd);
    if (deviations.length === 0) return;
    throw new Error(`작업 폴더의 러너 제어 경로가 git HEAD 와 다릅니다(${when}: ${deviations.join(", ")}) — 지시문·실행 설정(${RUNNER_CONTROL_ENTRIES.join("·")}, `
      + "대소문자 무관)은 러너가 만들거나 고치지 않는다. 확인 뒤 지우거나 되돌리고 재시도하세요.");
  };
  async function guarded<T>(turn: Omit<SessionTurn, "sessionId">, run: () => Promise<T>): Promise<T> {
    check(turn, "턴 시작 전");
    if (!turnFlags(jobOfTurn(adapter.role, turn)).write) return run();
    try {
      return await run();
    } finally {
      // 쓰기 턴은 실패로 끝나도 대조한다 — 심은 뒤 죽은 턴을 재시도가 그대로 이어받지 않게. 위반이 원래 오류보다 앞선다.
      check(turn, "쓰기 턴 뒤");
    }
  }
  return { role: adapter.role, validateExistingSession: id => adapter.validateExistingSession(id),
    ...(adapter.isSessionMissing ? { isSessionMissing: (id: string) => adapter.isSessionMissing!(id) } : {}),
    createSession: turn => guarded(turn, () => adapter.createSession(turn)),
    resumeTurn: turn => guarded(turn, () => adapter.resumeTurn(turn)),
    ...(adapter.resumePlanRepair ? { resumePlanRepair: (turn: SessionTurn) => guarded(turn, () => adapter.resumePlanRepair!(turn)) } : {}),
    ...(adapter.createStructuredSession ? { createStructuredSession: (turn: Omit<SessionTurn, "sessionId">, schema: OutputSchema) =>
      guarded(turn, () => adapter.createStructuredSession!(turn, schema)) } : {}),
    ...(adapter.resumeStructuredTurn ? { resumeStructuredTurn: (turn: SessionTurn, schema: OutputSchema) =>
      guarded(turn, () => adapter.resumeStructuredTurn!(turn, schema)) } : {}) };
}

export interface ResolvedTurn { job: TurnJob; policy: TurnPolicy; protocolOnly: boolean }

// job 없는 직접 호출의 호환 경계 — 공급자 슬롯과 플래그로 E2b 이전 엔진이 쓰던 job 을 되살린다. Codex 는 implementation 플래그를 읽지 않던
// 읽기 전용 검토자라 호환 경로에서도 검토자다. 래퍼(budgetController·guardedPlanning)도 job 이 없을 때 같은 규칙을 쓴다.
export function compatibleJob(provider: "claude" | "codex", turn: { implementation?: boolean }): TurnJob {
  return provider === "codex" ? { role: "reviewer", operation: "audit" }
    : turn.implementation ? { role: "implementer", operation: "implement" } : { role: "planner", operation: "plan" };
}

// 래퍼가 판정에 쓰는 job — 엔진 호출은 job 을 싣고, 직접 호출은 호환 규칙으로 되살린다.
export function jobOfTurn(provider: "claude" | "codex", turn: { job?: TurnJob; implementation?: boolean }): TurnJob {
  return turn.job ?? compatibleJob(provider, turn);
}

// 어댑터 입구 — job 이 있으면 함께 온 implementation·protocolOnly 가 job 유도값과 같은지 확인하고, 없으면(직접 호출·기존 테스트) 공급자 슬롯과
// 플래그로 엔진이 쓰던 job 을 되살린다(호환 경계). Codex 는 implementation 플래그를 읽지 않던 읽기 전용 검토자라 호환 경로에서도 검토자다.
export function resolveTurn(provider: "claude" | "codex", turn: Omit<SessionTurn, "sessionId">): ResolvedTurn {
  let job: TurnJob;
  let protocolOnly: boolean;
  if (turn.job) {
    job = turn.job;
    const flags = turnFlags(job);
    if (turn.implementation !== undefined && turn.implementation !== flags.implementation) {
      throw new Error(`턴의 implementation(${turn.implementation})이 job ${job.role}/${job.operation} 과 다릅니다.`);
    }
    if (turn.protocolOnly !== undefined && turn.protocolOnly !== flags.protocolOnly) {
      throw new Error(`턴의 protocolOnly(${turn.protocolOnly})가 job ${job.role}/${job.operation} 과 다릅니다.`);
    }
    protocolOnly = flags.protocolOnly;
  } else {
    protocolOnly = Boolean(turn.protocolOnly);
    job = compatibleJob(provider, turn);
  }
  const policy = turnPolicy(job, {
    planMode: turn.planMode, protocolOnly, evidenceManaged: turn.evidenceManaged, planningControl: Boolean(turn.planningControl),
    figmaRequested: Boolean(turn.figmaReadEnabled && turn.onFigmaResult), isolated: turn.isolated,
    scopedWrite: turn.writablePaths !== undefined,
  });
  return { job, policy, protocolOnly };
}

// 어댑터 입구의 판정 — resolveTurn 뒤 공급자 표현 가능 여부와 프로필 옵션을 확인하고, 표현할 수 없으면 실행 전에 거부한다(조용히 낮추거나 바꾸지
// 않는다). 옵션은 경로 판정(turnRouting.resolveRoute)이 이미 검증했지만 이 공급자의 스펙으로 다시 읽는다 — 다른 공급자 옵션이 넘어오면 여기서 멈춘다.
export function resolveSupportedTurn<P extends "claude" | "codex">(provider: P, turn: Omit<SessionTurn, "sessionId">):
  ResolvedTurn & { options: ProviderOptions<P> } {
  const resolved = resolveTurn(provider, turn);
  const reason = providerSupport(provider, resolved.policy);
  if (reason) throw new Error(`${reason}(job ${resolved.job.role}/${resolved.job.operation}).`);
  const scope = writeScopeProblem(turn.cwd, turn.writablePaths, resolved.policy);
  if (scope) throw new Error(scope);
  return { ...resolved, options: parseProviderOptions(provider, turn.providerOptions) };
}
