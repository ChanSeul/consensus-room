import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

import { redactSecrets } from "../shared/workflow.js";
import type { ParticipantRole } from "./types.js";
import { memoryRelevance } from "./memoryRetrieval.js";
import { wikiEvidenceNotice, type MemoryReaderOptions } from "./wikiEvidence.js";
export type { MemoryReaderOptions, MemoryEvidenceDependency, MemoryEvidenceStatus } from "./wikiEvidence.js";

const ROUTER_FILE = "context-router.md";
const MAX_ROUTED_DOCUMENTS = 4;
const MAX_DOCUMENT_BYTES = 80_000;
const MAX_CONTEXT_BYTES = 180_000;
export interface MemoryDocumentSnapshot {
  path: string;
  sha256: string;
  content: string;
  redacted: boolean;
}

export interface MemorySelection {
  snapshots: MemoryDocumentSnapshot[];
  decisions: Array<{ path: string; score: number; reason: string; selected: boolean }>;
  bytes: number;
}

export class ProjectMemoryReader {
  constructor(private readonly memoryDirectory: string, private readonly options: MemoryReaderOptions = {}) {}

  // 본문 없이 현재 SHA-256만 다시 알려 준다. 문서 본문은 세션 생성 턴에 한 번만 싣지만(턴당 ~20K자 중복),
  // 해시는 그 사이 바뀔 수 있어 그대로 두면 에이전트가 낡은 expectedSHA256으로 쓰기를 제안하고 거부당한다.
  // 매니페스트는 수백 바이트라 매 턴 실어도 비용이 없다.
  async buildManifest(prompt: string, role: ParticipantRole): Promise<string> {
    const snapshots = await this.select(prompt, role);
    if (snapshots.length === 0) return "";
    const rows = (await Promise.all(snapshots.map(async (snapshot) => {
      const notice = await wikiEvidenceNotice(snapshot.content, this.options);
      return `- ${snapshot.path} @ ${snapshot.sha256}${snapshot.redacted ? " (민감값 가림)" : ""}${notice ? ` — ${notice}` : ""}`;
    }))).join("\n");
    return [
      "## 메모리 스냅샷 갱신",
      "",
      "아래는 지금 시점의 파일별 SHA-256입니다. 이 턴에서 memoryUpdates를 제안한다면 expectedSHA256에",
      "이전 턴의 값이 아니라 아래 값을 쓰세요. 목록에 없는 파일의 변경은 제안하지 마세요.",
      "",
      rows,
    ].join("\n");
  }

  async buildPrompt(prompt: string, role: ParticipantRole): Promise<string> {
    const snapshots = await this.select(prompt, role);
    if (snapshots.length === 0) return `${prompt}\n\n${memoryUsageRules(role, this.memoryDirectory, [])}`;
    const rendered = (await Promise.all(snapshots.map(async (snapshot) => [
      await wikiEvidenceNotice(snapshot.content, this.options) ?? "",
      `--- 메모리 문서 시작: ${snapshot.path} ---`,
      `SHA-256: ${snapshot.sha256} / UTF-8 바이트: ${Buffer.byteLength(snapshot.content, "utf8")} / 민감값 가림: ${snapshot.redacted ? "예" : "아니오"}`,
      snapshot.content,
      `--- 메모리 문서 끝: ${snapshot.path} ---`,
    ].filter(Boolean).join("\n")))).join("\n\n");
    return `${prompt}\n\n${memoryUsageRules(role, this.memoryDirectory, snapshots)}\n\n${rendered}`;
  }

  async select(prompt: string, role: ParticipantRole): Promise<MemoryDocumentSnapshot[]> {
    return (await this.selectWithDiagnostics(prompt, role)).snapshots;
  }

  async selectWithDiagnostics(prompt: string, role: ParticipantRole): Promise<MemorySelection> {
    const empty = (): MemorySelection => ({ snapshots: [], decisions: [], bytes: 0 });
    const root = await realpath(this.memoryDirectory).catch(() => null);
    if (!root) return empty();
    const router = await this.readSnapshot(root, ROUTER_FILE, role);
    if (!router) return empty();
    const index = await this.readSnapshot(root, "MEMORY.md", role);
    const contexts = new Map<string, string[]>();
    for (const source of [router.content, index?.content ?? ""]) {
      for (const candidate of extractMarkdownLinks(source)) {
        if (candidate.path === ROUTER_FILE || candidate.path === "MEMORY.md") continue;
        contexts.set(candidate.path, [...contexts.get(candidate.path) ?? [], candidate.context]);
      }
    }
    const decisions: MemorySelection["decisions"] = [];
    const candidates: Array<{ snapshot: MemoryDocumentSnapshot; score: number; decision: MemorySelection["decisions"][number] }> = [];
    for (const [path, labels] of contexts) {
      if (!isReadableMemoryPath(path, role)) continue;
      const snapshot = await this.readSnapshot(root, path, role);
      if (!snapshot) { decisions.push({ path, score: 0, reason: "unreadable", selected: false }); continue; }
      const relevance = memoryRelevance(prompt, path, labels.join("\n"), snapshot.content);
      const decision = { path, score: relevance.score, reason: relevance.reason as string, selected: false };
      decisions.push(decision);
      if (relevance.score > 0) candidates.push({ snapshot, score: relevance.score, decision });
    }
    candidates.sort((a, b) => b.score - a.score || a.snapshot.path.localeCompare(b.snapshot.path));
    const snapshots = [router];
    let bytes = Buffer.byteLength(router.content);
    for (const { snapshot, decision } of candidates) {
      if (snapshots.length >= MAX_ROUTED_DOCUMENTS + 1) { decision.reason = "document-limit"; continue; }
      const size = Buffer.byteLength(snapshot.content);
      if (bytes + size > MAX_CONTEXT_BYTES) { decision.reason = "byte-limit"; continue; }
      decision.selected = true;
      snapshots.push(snapshot);
      bytes += size;
    }
    return { snapshots, decisions, bytes };
  }

  private async readSnapshot(
    root: string,
    relativePath: string,
    role: ParticipantRole,
  ): Promise<MemoryDocumentSnapshot | null> {
    if (!isReadableMemoryPath(relativePath, role)) return null;
    const target = resolve(root, relativePath);
    if (!isInside(root, target)) return null;
    try {
      const parent = await realpath(dirname(target));
      if (parent !== dirname(target)) return null;
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_DOCUMENT_BYTES) return null;
      const rawContent = await readFile(target, "utf8");
      if (Buffer.byteLength(rawContent, "utf8") > MAX_DOCUMENT_BYTES) return null;
      const content = redactSecrets(rawContent);
      return {
        path: relativePath,
        sha256: createHash("sha256").update(rawContent, "utf8").digest("hex"),
        content,
        redacted: content !== rawContent,
      };
    } catch {
      return null;
    }
  }
}

function memoryUsageRules(
  role: ParticipantRole,
  memoryDirectory: string,
  snapshots: readonly MemoryDocumentSnapshot[],
): string {
  const ownDirectory = role === "claude" ? "claude-only" : "codex-only";
  const otherDirectory = role === "claude" ? "codex-only" : "claude-only";
  const available = snapshots
    .map((snapshot) => `${snapshot.path}@${snapshot.sha256}${snapshot.redacted ? "(민감값 가림)" : ""}`)
    .join(", ") || "없음";
  return `## Duse iOS 프로젝트 메모리 사용 규칙

사용자가 이 방에서 프로젝트 메모리 읽기와 통제된 쓰기를 허용했습니다. 중앙 서버가 현재 주제에 맞는 문서만 골라 아래에 붙였습니다. 모델 프로세스에는 메모리 폴더 접근 권한이 없습니다.

- 정본 위치: ${memoryDirectory}
- 이번 턴에 제공된 스냅샷: ${available}
- 루트 문서는 공용이고, 역할 전용 문서는 ${ownDirectory}/만 적용합니다. ${otherDirectory}/의 내용은 제공되지 않으며 추정해서도 안 됩니다.
- 현재 사용자 지시, 현재 저장소 코드, 현재 실행 증거가 메모리보다 우선합니다. 메모리를 확정 사실의 대체물로 쓰지 마세요.
- **턴을 마치기 전에 이번 턴에서 얻은 것 중 다음 작업에도 재사용할 교훈이 있는지 반드시 한 번 판단하세요.** 있으면 반환 JSON의 memoryUpdates에 전체 파일 내용을 제안합니다. 다음이 전형적인 기록 대상입니다: 실측이 기존 전제를 뒤집은 경우, 도구·CLI·SDK의 계약을 알아낸 경우(어떤 명령이 무엇을 증명하고 무엇을 증명하지 못하는지 포함), 같은 함정을 다음에도 밟을 것 같은 경우. 일회성 상태, 추측, 비밀, 개인정보, 이 주제에서만 의미 있는 진행 상황은 기록하지 마세요.
- 제공된 기존 파일을 바꿀 때만 표시된 SHA-256을 expectedSHA256에 넣으세요. 제공되지 않은 기존 파일의 변경은 제안하지 마세요. 새 파일은 expectedSHA256을 null로 두세요.
- '민감값 가림: 예'인 기존 문서는 원문과 다르므로 변경을 제안하지 마세요.
- 허용 경로는 루트의 단일 .md 파일 또는 ${ownDirectory}/ 아래 .md 파일뿐입니다. 새 문서는 정본 frontmatter(name, description, metadata.platform, metadata.type)를 포함해야 합니다.
- 새 문서의 MEMORY.md 연결은 중앙 서버가 함께 처리합니다. 제공되지 않은 MEMORY.md를 추정해서 직접 제안하지 마세요.
- 메모리 파일을 도구로 직접 쓰지 마세요. 판단한 결과 재사용할 교훈이 없다면 memoryUpdates를 비워 두는 것이 맞습니다 — 채우려고 없는 교훈을 만들지 마세요.`;
}

const MARKDOWN_LINK = /\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/g;
// MEMORY.md 가 한 줄에 여러 문서를 묶을 때 쓰는 구분자(`- 주제: [문서](경로) · [문서](경로)`).
const GROUPED_LINK_SEPARATOR = " · ";

function extractMarkdownLinks(markdown: string): Array<{ path: string; context: string }> {
  const links = new Map<string, string>();
  for (const line of markdown.split(/\r?\n/)) {
    for (const { target, context } of linkContexts(line)) {
      const path = normalize(target).replaceAll("\\", "/");
      if (!path.startsWith("../") && !path.startsWith("/")) links.set(path, context);
    }
  }
  return [...links].map(([path, context]) => ({ path, context }));
}

// 여러 문서를 ` · `로 묶은 줄에서 줄 전체를 모든 링크의 문맥으로 쓰면 한 문서에 맞은 키워드가 같은 줄의 다른 문서
// 점수까지 올려 라우팅 상한을 채운다. 그런 줄은 링크 밖의 구분자로 나눈 조각을 그 조각 링크의 문맥으로 쓰고, 첫 링크
// 앞의 주제 라벨만 모든 조각이 공유한다. 구분자로 묶지 않은 줄(라우터의 `, `·` + ` 나열 포함)은 줄 전체가 문맥이다.
function linkContexts(line: string): Array<{ target: string; context: string }> {
  const matches = [...line.matchAll(MARKDOWN_LINK)];
  const cuts = matches.length < 2 ? [] : separatorsOutsideLinks(line, matches);
  if (cuts.length === 0) return matches.map((match) => ({ target: match[1], context: line }));

  const label = line.slice(0, matches[0].index).trim();
  const starts = [0, ...cuts.map((cut) => cut + GROUPED_LINK_SEPARATOR.length)];
  const ends = [...cuts, line.length];
  return starts.flatMap((start, index) => {
    const segment = line.slice(start, ends[index]).trim();
    const context = index === 0 ? segment : `${label} ${segment}`.trim();
    return [...segment.matchAll(MARKDOWN_LINK)].map((match) => ({ target: match[1], context }));
  });
}

function separatorsOutsideLinks(line: string, links: readonly RegExpExecArray[]): number[] {
  const cuts: number[] = [];
  let at = line.indexOf(GROUPED_LINK_SEPARATOR);
  while (at >= 0) {
    const cut = at;
    if (!links.some((link) => cut > link.index && cut < link.index + link[0].length)) cuts.push(cut);
    at = line.indexOf(GROUPED_LINK_SEPARATOR, at + 1);
  }
  return cuts;
}

function isReadableMemoryPath(path: string, role: ParticipantRole): boolean {
  if (!path.endsWith(".md") || path.includes("\0")) return false;
  const normalizedPath = normalize(path).replaceAll("\\", "/");
  if (normalizedPath !== path || normalizedPath.startsWith("../") || normalizedPath.startsWith("/")) return false;
  const segments = normalizedPath.split("/");
  if (segments.length === 1) return true;
  const ownDirectory = role === "claude" ? "claude-only" : "codex-only";
  return segments[0] === ownDirectory && segments.length >= 2;
}

function isInside(root: string, target: string): boolean {
  const child = relative(root, target);
  return child !== "" && child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}
