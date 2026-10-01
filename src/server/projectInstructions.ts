import { readInstructionFiles } from "./userFileReader.js";
import { join } from "node:path";
import { PROJECT_INSTRUCTION_PRECEDENCE_NOTE } from "../shared/prompts.js";
import { redactSecrets } from "../shared/workflow.js";

export const INSTRUCTION_FILE_LIMIT_BYTES = 32_000;

// Authors opt into a worker view; unmarked project rules remain intact.
// Only a standalone HTML comment is a boundary, not examples mentioning the marker.
export function workerInstructionText(raw: string): string {
  const lines = raw.split(/\r?\n/);
  let fence: { character: string; length: number } | undefined;
  for (const [index, line] of lines.entries()) {
    const delimiter = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (delimiter) {
      if (!fence) fence = { character: delimiter[1][0], length: delimiter[1].length };
      else if (delimiter[1][0] === fence.character && delimiter[1].length >= fence.length && !delimiter[2].trim()) fence = undefined;
      continue;
    }
    if (!fence && /^<!-- interactive-session-only(?::[^\r\n]*)? -->\s*$/.test(line)) return lines.slice(0, index).join("\n").trimEnd();
  }
  return raw;
}

// Ignored project instructions may be absent from a topic worktree. Read the original
// repository only in that case, then apply the same worker view and task precedence.
export interface AppliedInstructionInput {
  strict?: boolean;
  // Guarded planning delivers the complete text through its required input queue when needed.
  chunkedDelivery?: boolean;
  signal?: AbortSignal;
  workspace: string;
  fileName: string;
  // 원본 저장소. worktree 에 파일이 없을 때만 쓴다.
  repositoryPath?: string | null;
  // Provider-specific global rules; native discovery is disabled in both managed adapters.
  globalPath?: string | null;
  // Include the worktree body in the host-managed instruction context.
  injectWorkspaceFile: boolean;
}

export interface AppliedInstructions {
  blocks: string[];
  // 어느 파일이 프로젝트 지시문으로 쓰였는지(없으면 null). 로그·테스트용.
  projectSource: "workspace" | "repository" | null;
}

export async function readAppliedInstructions(input: AppliedInstructionInput): Promise<AppliedInstructions> {
  const files = await readInstructionFiles({ workspacePath: join(input.workspace, input.fileName),
    repositoryPath: input.repositoryPath ? join(input.repositoryPath, input.fileName) : undefined,
    globalPath: input.globalPath ?? undefined, injectWorkspaceFile: input.injectWorkspaceFile }, { signal: input.signal });
  const blocks: string[] = [];
  const globalBlock = instructionBlock(`사용자 전역 ${input.fileName}`, files.global, input.strict, input.chunkedDelivery);
  if (globalBlock) blocks.push(globalBlock);
  const projectSource = files.source;
  const label = projectSource === "repository"
    ? `작업 저장소 ${input.fileName} (원본 저장소 사본 — worktree 에는 gitignored 라 없음)` : `작업 저장소 ${input.fileName}`;
  const projectBlock = instructionBlock(label, files.project, input.strict, input.chunkedDelivery);
  if (projectBlock) blocks.push(projectBlock, PROJECT_INSTRUCTION_PRECEDENCE_NOTE);
  return { blocks, projectSource };
}

function instructionBlock(label: string, raw: string | null, strict = false, chunked = false): string | null {
  if (!raw) return null;
  raw = workerInstructionText(raw);
  if (!raw.trim()) return null;
  if (!chunked && strict && Buffer.byteLength(raw) > INSTRUCTION_FILE_LIMIT_BYTES) {
    throw new Error("Mandatory instruction file exceeds the planning limit; it must not be silently truncated.");
  }
  const bounded = !chunked && Buffer.byteLength(raw, "utf8") > INSTRUCTION_FILE_LIMIT_BYTES
    ? `${raw.slice(0, INSTRUCTION_FILE_LIMIT_BYTES)}\n[이하 생략: 지시문이 32KB를 넘었습니다.]`
    : raw;
  return [`적용되는 지시문 시작: ${label}`, redactSecrets(bounded).trim(), `적용되는 지시문 끝: ${label}`].join("\n");
}
