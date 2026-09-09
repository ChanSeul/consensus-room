import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import { PROJECT_INSTRUCTION_PRECEDENCE_NOTE } from "../shared/prompts.js";
import { redactSecrets } from "../shared/workflow.js";

export const INSTRUCTION_FILE_LIMIT_BYTES = 32_000;

// 프로젝트 지시문(CLAUDE.md·AGENTS.md)은 sample-ios 에서 gitignored 라 토픽 worktree 체크아웃에 **존재하지 않는다**
// (2026-09-02 실측: S1.1~S5.2 의 모든 에이전트가 전역 지시문만 받았다). worktree 에 파일이 없으면 원본 저장소의
// 파일을 대신 읽는다 — 항상 현재 내용이고 worktree 마다 복사할 필요가 없다. 원본 지시문에는 방 계약과 충돌하는
// 조항(요청 없이 빌드 금지·시뮬 실행·훅 ack·홈 경로 참조)이 있으므로 주입 뒤에 우선순위 규칙을 붙인다.
export interface AppliedInstructionInput {
  workspace: string;
  fileName: string;
  // 원본 저장소. worktree 에 파일이 없을 때만 쓴다.
  repositoryPath?: string | null;
  // 전역 지시문 경로. Claude 는 CLI 탐색을 꺼 두었으므로 서버가 넣고, Codex 는 CLI 가 직접 읽으므로 null.
  globalPath?: string | null;
  // worktree 에 파일이 있을 때 그 내용을 stdin 에 넣을지. Codex 는 cwd 의 AGENTS.md 를 CLI 가 직접 읽으므로 false.
  injectWorkspaceFile: boolean;
}

export interface AppliedInstructions {
  blocks: string[];
  // 어느 파일이 프로젝트 지시문으로 쓰였는지(없으면 null). 로그·테스트용.
  projectSource: "workspace" | "repository" | null;
}

export async function readAppliedInstructions(input: AppliedInstructionInput): Promise<AppliedInstructions> {
  const blocks: string[] = [];
  if (input.globalPath) {
    const block = await readInstructionBlock(`사용자 전역 ${input.fileName}`, input.globalPath);
    if (block) blocks.push(block);
  }
  const workspacePath = join(input.workspace, input.fileName);
  const workspaceHasFile = Boolean(await realpath(workspacePath).catch(() => null));
  let projectSource: AppliedInstructions["projectSource"] = null;
  let projectBlock: string | null = null;
  if (workspaceHasFile) {
    if (input.injectWorkspaceFile) {
      projectBlock = await readInstructionBlock(`작업 저장소 ${input.fileName}`, workspacePath);
      if (projectBlock) projectSource = "workspace";
    }
  } else if (input.repositoryPath) {
    projectBlock = await readInstructionBlock(
      `작업 저장소 ${input.fileName} (원본 저장소 사본 — worktree 에는 gitignored 라 없음)`,
      join(input.repositoryPath, input.fileName),
    );
    if (projectBlock) projectSource = "repository";
  }
  if (projectBlock) blocks.push(projectBlock, PROJECT_INSTRUCTION_PRECEDENCE_NOTE);
  return { blocks, projectSource };
}

async function readInstructionBlock(label: string, path: string): Promise<string | null> {
  const raw = await readFile(path, "utf8").catch(() => null);
  if (!raw) return null;
  const bounded = Buffer.byteLength(raw, "utf8") > INSTRUCTION_FILE_LIMIT_BYTES
    ? `${raw.slice(0, INSTRUCTION_FILE_LIMIT_BYTES)}\n[이하 생략: 지시문이 32KB를 넘었습니다.]`
    : raw;
  return [`적용되는 지시문 시작: ${label}`, redactSecrets(bounded).trim(), `적용되는 지시문 끝: ${label}`].join("\n");
}
