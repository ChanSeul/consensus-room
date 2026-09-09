import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

import type { MemoryUpdate } from "../shared/contracts.js";
import { redactSecrets } from "../shared/workflow.js";
import type { AppliedMemoryChange, ParticipantRole, ProjectMemoryWriter } from "./types.js";

const ALLOWED_MEMORY_TYPES = new Set(["user", "feedback", "project", "reference"]);
const MAX_TOTAL_UPDATE_BYTES = 500_000;

interface PreparedUpdate {
  source: MemoryUpdate;
  relativePath: string;
  target: string;
  previousContent: string | null;
  previousSHA256: string | null;
  desiredSHA256: string;
  mode: number;
  unchanged: boolean;
  temporaryPath: string | null;
}

export class MemoryConflictError extends Error {}

export class ProjectMemoryStore implements ProjectMemoryWriter {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly memoryDirectory: string) {}

  apply(role: ParticipantRole, updates: readonly MemoryUpdate[]): Promise<AppliedMemoryChange[]> {
    const operation = this.queue.then(() => this.applySerially(role, updates));
    this.queue = operation.catch(() => undefined);
    return operation;
  }

  private async applySerially(
    role: ParticipantRole,
    updates: readonly MemoryUpdate[],
  ): Promise<AppliedMemoryChange[]> {
    if (updates.length === 0) return [];
    const root = await realpath(this.memoryDirectory);
    const seen = new Set<string>();
    for (const update of updates) {
      const relativePath = validateRelativePath(update.path, role);
      if (seen.has(relativePath)) throw new Error(`같은 메모리 파일을 한 응답에서 두 번 바꿀 수 없습니다: ${relativePath}`);
      seen.add(relativePath);
    }
    const expandedUpdates = await this.withIndexUpdate(root, updates);
    const totalBytes = expandedUpdates.reduce(
      (sum, update) => sum + Buffer.byteLength(update.content, "utf8"),
      0,
    );
    if (totalBytes > MAX_TOTAL_UPDATE_BYTES) throw new Error("한 턴의 메모리 변경 내용이 500KB를 넘었습니다.");

    const prepared: PreparedUpdate[] = [];
    for (const update of expandedUpdates) {
      const relativePath = validateRelativePath(update.path, role);
      prepared.push(await this.prepare(root, relativePath, role, update));
    }

    const changes = prepared.filter((update) => !update.unchanged);
    try {
      for (const update of changes) {
        const temporaryPath = `${update.target}.consensus-room-${randomUUID()}.tmp`;
        await writeFile(temporaryPath, update.source.content, { encoding: "utf8", flag: "wx", mode: 0o600 });
        await chmod(temporaryPath, update.mode);
        update.temporaryPath = temporaryPath;
      }
      await this.recheck(prepared);
      for (const update of changes) {
        await rename(update.temporaryPath!, update.target);
        update.temporaryPath = null;
      }
    } finally {
      await Promise.all(prepared
        .map((update) => update.temporaryPath)
        .filter((path): path is string => Boolean(path))
        .map((path) => unlink(path).catch(() => undefined)));
    }

    return prepared.map((update) => ({
      path: update.relativePath,
      previousSHA256: update.previousSHA256,
      sha256: update.desiredSHA256,
      reason: update.source.reason,
      status: update.unchanged ? "unchanged" : "written",
    }));
  }

  private async withIndexUpdate(
    root: string,
    updates: readonly MemoryUpdate[],
  ): Promise<MemoryUpdate[]> {
    const newDocuments = updates.filter((update) =>
      update.expectedSHA256 === null && update.path !== "MEMORY.md");
    if (newDocuments.length === 0) return [...updates];

    const explicitIndex = updates.find((update) => update.path === "MEMORY.md");
    const currentIndex = await readFile(resolve(root, "MEMORY.md"), "utf8").catch(() => null);
    if (currentIndex === null) {
      throw new Error("새 메모리 문서를 연결할 MEMORY.md가 없습니다.");
    }
    let nextIndex = explicitIndex?.content ?? currentIndex;
    for (const document of newDocuments) {
      const frontmatter = parseFrontmatter(document.content);
      if (!frontmatter) throw new Error(`새 메모리 문서의 frontmatter를 해석할 수 없습니다: ${document.path}`);
      nextIndex = appendIndexEntry(nextIndex, document.path, frontmatter.name, frontmatter.description);
    }
    const indexUpdate: MemoryUpdate = {
      path: "MEMORY.md",
      expectedSHA256: explicitIndex?.expectedSHA256 ?? sha256(currentIndex),
      content: nextIndex,
      reason: `새 메모리 문서를 인덱스에 연결: ${newDocuments.map((document) => document.path).join(", ")}`,
    };
    return explicitIndex
      ? updates.map((update) => update.path === "MEMORY.md" ? indexUpdate : update)
      : [...updates, indexUpdate];
  }

  private async prepare(
    root: string,
    relativePath: string,
    role: ParticipantRole,
    source: MemoryUpdate,
  ): Promise<PreparedUpdate> {
    const target = resolve(root, relativePath);
    if (!isInside(root, target)) throw new Error(`메모리 루트 밖 경로입니다: ${relativePath}`);
    const expectedParent = dirname(target);
    const actualParent = await realpath(expectedParent).catch(() => null);
    if (!actualParent) throw new Error(`메모리 하위 폴더가 존재하지 않습니다: ${dirname(relativePath)}`);
    if (actualParent !== expectedParent) throw new Error(`심볼릭 링크를 거치는 메모리 경로는 쓸 수 없습니다: ${relativePath}`);

    const stat = await lstat(target).catch(() => null);
    if (stat?.isSymbolicLink()) throw new Error(`심볼릭 링크 메모리 파일은 쓸 수 없습니다: ${relativePath}`);
    if (stat && !stat.isFile()) throw new Error(`일반 파일이 아닌 메모리 경로입니다: ${relativePath}`);
    const previousContent = stat ? await readFile(target, "utf8") : null;
    const previousSHA256 = previousContent === null ? null : sha256(previousContent);
    const desiredSHA256 = sha256(source.content);

    if (redactSecrets(source.content) !== source.content) {
      throw new Error(`민감값으로 보이는 내용을 메모리에 쓸 수 없습니다: ${relativePath}`);
    }
    if (previousContent !== null && redactSecrets(previousContent) !== previousContent) {
      throw new Error(`민감값이 가려져 전달된 기존 메모리는 자동으로 바꿀 수 없습니다: ${relativePath}`);
    }
    validateFrontmatter(source.content, relativePath, role, previousContent);

    const unchanged = previousSHA256 === desiredSHA256;
    if (!unchanged && source.expectedSHA256 !== previousSHA256) {
      throw new MemoryConflictError(
        previousSHA256 === null
          ? `이미 없는 파일을 기존 파일로 가정했습니다: ${relativePath}`
          : source.expectedSHA256 === null
            ? `이미 존재하는 메모리 파일입니다: ${relativePath}`
            : `메모리 파일이 스냅샷 뒤 바뀌었습니다: ${relativePath}`,
      );
    }

    return {
      source,
      relativePath,
      target,
      previousContent,
      previousSHA256,
      desiredSHA256,
      mode: stat ? stat.mode & 0o777 : 0o644,
      unchanged,
      temporaryPath: null,
    };
  }

  private async recheck(updates: readonly PreparedUpdate[]): Promise<void> {
    for (const update of updates) {
      if (update.unchanged) continue;
      const stat = await lstat(update.target).catch(() => null);
      if (stat?.isSymbolicLink() || (stat && !stat.isFile())) {
        throw new MemoryConflictError(`메모리 파일 형식이 검사 뒤 바뀌었습니다: ${update.relativePath}`);
      }
      const currentSHA256 = stat ? sha256(await readFile(update.target, "utf8")) : null;
      if (currentSHA256 !== update.previousSHA256) {
        throw new MemoryConflictError(`메모리 파일이 쓰기 직전에 바뀌었습니다: ${update.relativePath}`);
      }
    }
  }
}

function validateRelativePath(input: string, role: ParticipantRole): string {
  if (input !== input.trim() || input.includes("\0") || input.includes("\\") || isAbsolute(input)) {
    throw new Error(`잘못된 메모리 상대 경로입니다: ${input}`);
  }
  const path = normalize(input).replaceAll("\\", "/");
  if (path !== input || path.startsWith("../") || !path.endsWith(".md")) {
    throw new Error(`허용되지 않은 메모리 경로입니다: ${input}`);
  }
  const segments = path.split("/");
  if (segments.length === 1) return path;
  const ownDirectory = role === "claude" ? "claude-only" : "codex-only";
  if (segments[0] !== ownDirectory || segments.length < 2) {
    throw new Error(`${role}는 ${segments[0]} 경로에 메모리를 쓸 수 없습니다.`);
  }
  return path;
}

function validateFrontmatter(
  content: string,
  relativePath: string,
  role: ParticipantRole,
  previousContent: string | null,
): void {
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter) throw new Error(`메모리 문서에 정본 frontmatter가 없습니다: ${relativePath}`);
  const expectedPlatform = relativePath.includes("/") ? role : "shared";
  if (frontmatter.platform !== expectedPlatform) {
    throw new Error(`메모리 platform이 경로와 다릅니다: ${relativePath} (${frontmatter.platform})`);
  }
  if (!ALLOWED_MEMORY_TYPES.has(frontmatter.type)) {
    throw new Error(`허용되지 않은 메모리 type입니다: ${relativePath} (${frontmatter.type})`);
  }
  if (!frontmatter.description) throw new Error(`메모리 description이 비어 있습니다: ${relativePath}`);

  if (previousContent === null) {
    if (frontmatter.name !== basename(relativePath, ".md")) {
      throw new Error(`새 메모리 name은 파일명과 같아야 합니다: ${relativePath}`);
    }
    return;
  }
  const previous = parseFrontmatter(previousContent);
  if (!previous) throw new Error(`기존 메모리 frontmatter를 해석할 수 없습니다: ${relativePath}`);
  if (frontmatter.name !== previous.name) {
    throw new Error(`기존 메모리 name은 바꿀 수 없습니다: ${relativePath}`);
  }
}

function parseFrontmatter(content: string): {
  name: string;
  description: string;
  platform: string;
  type: string;
} | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return null;
  const lines = match[1].split(/\r?\n/);
  const top = new Map<string, string>();
  const metadata = new Map<string, string>();
  let inMetadata = false;
  for (const line of lines) {
    const topMatch = line.match(/^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/);
    if (topMatch) {
      inMetadata = topMatch[1] === "metadata";
      if (!inMetadata) top.set(topMatch[1], unquote(topMatch[2]));
      continue;
    }
    const metadataMatch = inMetadata
      ? line.match(/^\s{2,}([A-Za-z_][A-Za-z0-9_-]*):\s*(.*?)\s*$/)
      : null;
    if (metadataMatch) metadata.set(metadataMatch[1], unquote(metadataMatch[2]));
  }
  const name = top.get("name");
  const description = top.get("description");
  const platform = metadata.get("platform");
  const type = metadata.get("type");
  return name && description && platform && type ? { name, description, platform, type } : null;
}

function unquote(value: string): string {
  return value.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, double, single) => double ?? single ?? value).trim();
}

function appendIndexEntry(content: string, path: string, name: string, description: string): string {
  if (content.includes(`](${path})`)) return content;
  const safeName = name.replace(/[\[\]\r\n]/g, " ").trim();
  // description에 Markdown 링크가 들어가면 라우터의 링크 추출이 그 대상을 후보로 승격한다(감사 부차 지적).
  // 링크 문법을 평문으로 접고 대괄호를 제거해 인덱스 줄이 링크로 해석될 수 없게 한다.
  const safeDescription = description
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[\[\]\r\n]/g, " ")
    .trim();
  const entry = `- [${safeName}](${path}) - ${safeDescription}\n`;
  const heading = "## Consensus Room additions";
  const headingIndex = content.indexOf(heading);
  if (headingIndex < 0) return `${content.trimEnd()}\n\n${heading}\n\n${entry}`;
  const sectionContentStart = headingIndex + heading.length;
  const nextHeading = content.indexOf("\n## ", sectionContentStart);
  const insertAt = nextHeading >= 0 ? nextHeading : content.length;
  const before = content.slice(0, insertAt).trimEnd();
  const after = content.slice(insertAt);
  return `${before}\n${entry}${after.startsWith("\n") || after.length === 0 ? after : `\n${after}`}`;
}

function sha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
