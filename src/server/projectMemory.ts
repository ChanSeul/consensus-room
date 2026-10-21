import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { readMemoryFile, readMemoryFiles, resolveUserPath } from "./userFileReader.js";
import { isAbsolute, join, normalize, relative, resolve, sep } from "node:path";

import { redactSecrets } from "../shared/workflow.js";
import type { ParticipantRole } from "./types.js";
import { reportBackgroundFailure } from "./backgroundTask.js";
import { memoryRelevance, memorySearch, type MemorySearchInput } from "./memoryRetrieval.js";
import { wikiEvidenceNotice, type MemoryReaderOptions as WikiMemoryReaderOptions } from "./wikiEvidence.js";
export type { MemoryEvidenceDependency, MemoryEvidenceStatus } from "./wikiEvidence.js";

export interface MemoryReaderOptions extends WikiMemoryReaderOptions {
  // 본문 재열람 사본 폴더(엔진 결함 dffeb33f, 자문 40) — 있으면 메모리 갱신을 허용하는 턴에서 이번 턴에 고른 가림 없는 문서 본문을 `<원문 SHA-256>.md`
  // 로 두고, 그 파일만 이번 턴 읽기로 연다(MemoryDelivery.readablePaths). 없으면(검사·격리 런타임) 사본 없이 행을 만들고, 본문 파일이 없는 기존 문서는
  // 바꾸지 말라고 안내한다.
  snapshotDirectory?: string;
}

// 메모리 안내 문장과 그 안내가 가리키는 사본 파일 — 어댑터가 readablePaths 를 이번 턴 읽기 허용(Claude --settings, Codex 관리형 프로필)에 더한다.
export interface MemoryDelivery {
  text: string;
  readablePaths: string[];
}

// 문서 한 건의 사본 상태. file 은 확인을 마친 일반 파일 경로, redacted 는 가린 본문이라 교체용 사본을 주지 않음, unavailable 은 사본 제공 실패,
// none 은 사본을 쓰지 않는 턴(폴더 미설정 또는 갱신을 허용하지 않는 턴)이다.
type SnapshotCopy = { kind: "file"; path: string } | { kind: "redacted" } | { kind: "unavailable" } | { kind: "none" };

const ROUTER_FILE = "context-router.md";
// 라우터·MEMORY.md 의 이 절에 링크된 문서가 기능 위키다(자문 7) — 검색 주제가 그 기능이면 일반 문서의 부수적 단어 점수와 경쟁하지 않고 먼저 고른다.
const FEATURE_WIKI_SECTION = "기능별 위키 안내";
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

// 허용 색인의 한 항목(E3-5) — 라우터·MEMORY.md 링크 대상 가운데 이 역할이 읽을 수 있는 문서 하나. 버전은 **가린 본문**의 SHA-256 이다(원문 해시
// `MemoryDocumentSnapshot.sha256` 은 memoryUpdates 의 expectedSHA256 용이라 따로 둔다). 계획 제어는 가린 본문을 조각으로 싣고 조각 hash 도
// 가린 본문 해시라, 이 버전과 조각 hash 가 같은 값이 된다.
export interface MemoryIndexEntry {
  path: string;
  version: string;
  bytes: number;
  contexts: string[];
  content: string;
  redacted: boolean;
}

export class ProjectMemoryReader {
  constructor(private readonly memoryDirectory: string, private readonly options: MemoryReaderOptions = {}) {}

  // 본문 없이 현재 SHA-256만 다시 알려 준다. 문서 본문은 세션 생성 턴에 한 번만 싣지만(턴당 ~20K자 중복),
  // 해시는 그 사이 바뀔 수 있어 그대로 두면 에이전트가 낡은 expectedSHA256으로 쓰기를 제안하고 거부당한다.
  // 매니페스트는 수백 바이트라 매 턴 실어도 비용이 없다.
  // search 는 문서를 고를 검색 입력이다(엔진 턴은 SessionTurn.memorySearch). 생략하면 프롬프트 전체가 검색어다.
  async buildManifest(prompt: string, role: ParticipantRole, signal?: AbortSignal, allowUpdates = true,
    search: string | MemorySearchInput = prompt): Promise<string> {
    return (await this.buildManifestDelivery(prompt, role, signal, allowUpdates, search)).text;
  }

  // SHA 만으로는 그 본문을 알 수 없다(엔진 결함 dffeb33f) — 행마다 그 SHA 본문의 사본 경로를 함께 주고, 사본이 없는 기존 문서는 바꾸지 말라고 한다.
  // 한 번 고른 snapshots 로 행·사본·readablePaths 를 모두 만든다. 경로를 만들려고 다시 고르거나 원문을 다시 읽지 않는다.
  async buildManifestDelivery(prompt: string, role: ParticipantRole, signal?: AbortSignal, allowUpdates = true,
    search: string | MemorySearchInput = prompt): Promise<MemoryDelivery> {
    const snapshots = await this.select(search, role, signal);
    if (snapshots.length === 0) {
      return { text: allowUpdates ? "" : "이 턴의 메모리는 읽기 참고용입니다. 이전 세션의 저장 안내와 관계없이 memoryUpdates는 비워 두세요.", readablePaths: [] };
    }
    const copies = await this.snapshotCopies(snapshots, allowUpdates, signal);
    const rows = (await Promise.all(snapshots.map(async (snapshot, index) => {
      const notice = await wikiEvidenceNotice(snapshot.content, this.options);
      return `- ${snapshot.path} @ ${snapshot.sha256}${manifestCopyNote(copies[index])}${notice ? ` — ${notice}` : ""}`;
    }))).join("\n");
    return {
      text: [
        "## 메모리 스냅샷 갱신",
        "",
        allowUpdates ? "아래는 지금 시점의 파일별 SHA-256입니다. 이 턴에서 memoryUpdates를 제안한다면 expectedSHA256에\n이전 턴의 값이 아니라 아래 값을 쓰세요. "
          + "기존 파일을 바꾸려면 먼저 그 행의 본문 파일을 읽고, 읽은 본문을 바탕으로 전체 내용을 제안하세요. 본문 파일이 없는 행과 목록에 없는 파일은 바꾸지 마세요."
          : "이 턴의 메모리는 읽기 참고용입니다. 이전 세션의 저장 안내와 관계없이 memoryUpdates는 비워 두세요.",
        "",
        rows,
      ].join("\n"),
      readablePaths: copyPaths(copies),
    };
  }

  async buildPrompt(prompt: string, role: ParticipantRole, signal?: AbortSignal, allowUpdates = true,
    search: string | MemorySearchInput = prompt): Promise<string> {
    return (await this.buildPromptDelivery(prompt, role, signal, allowUpdates, search)).text;
  }

  // 본문을 싣는 턴(세션 생성 턴·memoryBodies 첫 일반 resume)도 갱신을 허용하면 사본 경로를 문서 머리에 적는다 — 같은 턴 안에서 문맥이 압축돼도 바꿀
  // 문서의 그 SHA 본문을 다시 읽을 수 있다.
  async buildPromptDelivery(prompt: string, role: ParticipantRole, signal?: AbortSignal, allowUpdates = true,
    search: string | MemorySearchInput = prompt): Promise<MemoryDelivery> {
    const snapshots = await this.select(search, role, signal);
    if (snapshots.length === 0) return { text: `${prompt}\n\n${memoryUsageRules(role, this.memoryDirectory, [], allowUpdates)}`, readablePaths: [] };
    const copies = await this.snapshotCopies(snapshots, allowUpdates, signal);
    const rendered = (await Promise.all(snapshots.map(async (snapshot, index) => {
      const copy = copies[index];
      return [
        await wikiEvidenceNotice(snapshot.content, this.options) ?? "",
        `--- 메모리 문서 시작: ${snapshot.path} ---`,
        `SHA-256: ${snapshot.sha256} / UTF-8 바이트: ${Buffer.byteLength(snapshot.content, "utf8")} / 민감값 가림: ${snapshot.redacted ? "예" : "아니오"}`
          + (copy.kind === "file" ? ` / 본문 파일: \`${copy.path}\`` : ""),
        snapshot.content,
        `--- 메모리 문서 끝: ${snapshot.path} ---`,
      ].filter(Boolean).join("\n");
    }))).join("\n\n");
    return { text: `${prompt}\n\n${memoryUsageRules(role, this.memoryDirectory, snapshots, allowUpdates)}\n\n${rendered}`, readablePaths: copyPaths(copies) };
  }

  // 이 사본은 메모리 갱신을 위한 재열람 복구다(엔진 결함 dffeb33f) — 갱신을 허용하는 턴(turnContract memoryUpdates)에만 만든다. 갱신을 허용하지 않는
  // 턴(브레인스토밍)의 압축 뒤 재열람은 이 수리의 범위 밖이다(자문 44). 가린 문서는 원문 SHA 와 짝지을 교체용 사본을 주지 않는다(memoryStore 도 그
  // 변경을 거부한다).
  private async snapshotCopies(snapshots: readonly MemoryDocumentSnapshot[], allowUpdates: boolean, signal?: AbortSignal): Promise<SnapshotCopy[]> {
    const directory = this.options.snapshotDirectory;
    const copies: SnapshotCopy[] = [];
    for (const snapshot of snapshots) {
      if (snapshot.redacted) copies.push({ kind: "redacted" });
      else if (!directory || !allowUpdates) copies.push({ kind: "none" });
      else {
        const path = await publishSnapshotCopy(directory, snapshot, signal);
        copies.push(path ? { kind: "file", path } : { kind: "unavailable" });
      }
    }
    return copies;
  }

  async select(input: string | MemorySearchInput, role: ParticipantRole, signal?: AbortSignal): Promise<MemoryDocumentSnapshot[]> {
    return (await this.selectWithDiagnostics(input, role, signal)).snapshots;
  }

  async selectWithDiagnostics(input: string | MemorySearchInput, role: ParticipantRole, signal?: AbortSignal): Promise<MemorySelection> {
    const empty = (): MemorySelection => ({ snapshots: [], decisions: [], bytes: 0 });
    const targets = await this.linkTargets(role, signal);
    if (!targets) return empty();
    const { root, router, contexts, wikis } = targets;
    const search = memorySearch(input);
    const decisions: MemorySelection["decisions"] = [];
    const candidates: Array<{ snapshot: MemoryDocumentSnapshot; score: number; subjects: string[]; decision: MemorySelection["decisions"][number] }> = [];
    const current = await this.readSnapshots(root, [...contexts.keys()], role, signal);
    for (const [path, labels] of contexts) {
      if (!isReadableMemoryPath(path, role)) continue;
      const snapshot = current.get(path);
      if (!snapshot) { decisions.push({ path, score: 0, reason: "unreadable", selected: false }); continue; }
      const relevance = memoryRelevance(search, path, labels.join("\n"), snapshot.content);
      const decision = { path, score: relevance.score, reason: relevance.reason as string, selected: false };
      decisions.push(decision);
      if (relevance.score > 0) candidates.push({ snapshot, score: relevance.score, subjects: relevance.subjects, decision });
    }
    candidates.sort((a, b) => b.score - a.score || a.snapshot.path.localeCompare(b.snapshot.path));
    // 검색 주제마다 대표 문서 하나를 문서 수 상한 전에 먼저 고른다 — 그 기능의 위키가 있으면 위키, 없으면 정체성이 그 주제인 최고 점수 문서다.
    // 같은 주제의 일반 문서끼리 점수로 4자리를 다투다 위키가 빠지거나(자문 7 제목 단독 대조), 주제가 둘일 때 한쪽 문서가 자리를 다 차지하지 않게 한다.
    const representatives = new Set(search.subjects.flatMap(subject => {
      const owned = candidates.filter(candidate => candidate.subjects.includes(subject));
      const chosen = owned.find(candidate => wikis.has(candidate.snapshot.path)) ?? owned[0];
      if (chosen && wikis.has(chosen.snapshot.path)) chosen.decision.reason = "feature-wiki";
      return chosen ? [chosen] : [];
    }));
    const ordered = [...candidates.filter(candidate => representatives.has(candidate)), ...candidates.filter(candidate => !representatives.has(candidate))];
    const snapshots = [router];
    let bytes = Buffer.byteLength(router.content);
    for (const { snapshot, decision } of ordered) {
      if (snapshots.length >= MAX_ROUTED_DOCUMENTS + 1) { decision.reason = "document-limit"; continue; }
      const size = Buffer.byteLength(snapshot.content);
      if (bytes + size > MAX_CONTEXT_BYTES) { decision.reason = "byte-limit"; continue; }
      decision.selected = true;
      snapshots.push(snapshot);
      bytes += size;
    }
    return { snapshots, decisions, bytes };
  }

  // 허용 색인(E3-5) — 선택과 같은 링크 대상(라우터·MEMORY.md 의 `.md` 링크, 두 문서 자신 제외) 가운데 이 역할이 읽을 수 있는 문서 전부의 스냅숏이다.
  // 관련도 점수·문서 수·전체 바이트 한도는 적용하지 않는다(선택이 고르지 않은 문서를 찾는 목록이다). 역할 폴더·심볼릭 링크·문서당 80KB·가림은 선택과
  // 같은 readSnapshot 규칙이라, 읽을 수 없는 문서는 목록에 오르지 않는다. 순서는 링크가 처음 나온 순서(라우터 다음 MEMORY.md)다.
  async index(role: ParticipantRole, signal?: AbortSignal): Promise<MemoryIndexEntry[]> {
    const targets = await this.linkTargets(role, signal);
    if (!targets) return [];
    const entries: MemoryIndexEntry[] = [];
    const current = await this.readSnapshots(targets.root, [...targets.contexts.keys()], role, signal);
    for (const [path, contexts] of targets.contexts) {
      const snapshot = current.get(path);
      if (!snapshot) continue;
      entries.push({ path, version: createHash("sha256").update(snapshot.content, "utf8").digest("hex"),
        bytes: Buffer.byteLength(snapshot.content, "utf8"), contexts, content: snapshot.content, redacted: snapshot.redacted });
    }
    return entries;
  }

  // 라우터와 MEMORY.md 의 링크 대상과 링크 문맥 — 선택(selectWithDiagnostics)과 허용 색인(index)이 같은 목록을 쓴다. 라우터가 없으면 둘 다 비어 있다.
  private async linkTargets(role: ParticipantRole, signal?: AbortSignal): Promise<{ root: string; router: MemoryDocumentSnapshot; contexts: Map<string, string[]>; wikis: Set<string> } | null> {
    const root = await resolveUserPath(this.memoryDirectory, { signal });
    if (!root) return null;
    const router = await this.readSnapshot(root, ROUTER_FILE, role, signal);
    if (!router) return null;
    const index = await this.readSnapshot(root, "MEMORY.md", role, signal);
    const contexts = new Map<string, string[]>();
    const wikis = new Set<string>();
    for (const source of [router.content, index?.content ?? ""]) {
      for (const candidate of extractMarkdownLinks(source)) {
        if (candidate.path === ROUTER_FILE || candidate.path === "MEMORY.md") continue;
        contexts.set(candidate.path, [...contexts.get(candidate.path) ?? [], candidate.context]);
        if (candidate.wiki) wikis.add(candidate.path);
      }
    }
    return { root, router, contexts, wikis };
  }

  private async readSnapshots(root: string, paths: string[], role: ParticipantRole, signal?: AbortSignal): Promise<Map<string, MemoryDocumentSnapshot>> {
    const allowed = paths.filter(path => isReadableMemoryPath(path, role) && isInside(root, resolve(root, path)));
    const contents = await readMemoryFiles(allowed.map(path => resolve(root, path)), MAX_DOCUMENT_BYTES, { signal });
    return new Map(allowed.flatMap((path, index) => {
      const raw = contents[index];
      return raw === null ? [] : [[path, this.snapshot(path, raw)]];
    }));
  }

  private snapshot(path: string, rawContent: string): MemoryDocumentSnapshot {
    const content = redactSecrets(rawContent);
    return { path, sha256: createHash("sha256").update(rawContent, "utf8").digest("hex"), content, redacted: content !== rawContent };
  }

  private async readSnapshot(
    root: string,
    relativePath: string,
    role: ParticipantRole,
    signal?: AbortSignal,
  ): Promise<MemoryDocumentSnapshot | null> {
    if (!isReadableMemoryPath(relativePath, role)) return null;
    const target = resolve(root, relativePath);
    if (!isInside(root, target)) return null;
    const rawContent = await readMemoryFile(target, MAX_DOCUMENT_BYTES, { signal });
    if (rawContent === null) return null;
    return this.snapshot(relativePath, rawContent);
  }
}

// 매니페스트 행의 사본 표시. 사본을 쓰지 않는 턴(none)은 경로 없이 둔다 — 안내가 "본문 파일이 없는 행은 바꾸지 마세요" 다.
function manifestCopyNote(copy: SnapshotCopy): string {
  if (copy.kind === "file") return ` — 본문: \`${copy.path}\``;
  if (copy.kind === "redacted") return " — 민감값 가림 / 변경 제안 불가";
  if (copy.kind === "unavailable") return " — 본문 재열람 불가 / 기존 파일 변경 제안 금지";
  return "";
}

// 내용이 같은 두 문서는 같은 사본 파일을 가리킨다 — 읽기 허용에는 한 번만 넣는다.
function copyPaths(copies: readonly SnapshotCopy[]): string[] {
  return [...new Set(copies.flatMap(copy => copy.kind === "file" ? [copy.path] : []))];
}

// 내용 주소 사본(엔진 결함 dffeb33f, 자문 40) — `<directory>/<원문 SHA-256>.md` 에 가림 없는 본문 바이트를 그대로 둔다. 같은 내용은 한 파일을 공유하고,
// 지우거나 다른 내용으로 덮지 않는다(이전 버전은 원문이 바뀌면 다시 만들 수 없다). 폴더 자리가 심볼릭 링크·일반 파일이면, 또는 쓰기·게시·확인이
// 실패하면 null 이다 — 그 문서는 경로 없이 "본문 재열람 불가" 로 표시하고 턴은 계속한다(선택적 메모리 갱신의 실패가 제품 턴을 막지 않는다).
// 손상된 파일이나 이전 본문을 대신 주지 않는다. 취소만 그대로 던진다. 넘기는 경로는 확인을 마친 일반 파일 하나다(폴더·링크가 아니다).
async function publishSnapshotCopy(directory: string, snapshot: MemoryDocumentSnapshot, signal?: AbortSignal): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw new Error(`메모리 사본 폴더가 일반 폴더가 아닙니다: ${directory}`);
    // 위쪽 경로의 링크(/var → /private/var)는 실제 경로로 푼다 — sandbox 가 커널의 실제 경로로 대조한다.
    const target = join(await realpath(directory), `${snapshot.sha256}.md`);
    if (await holdsSnapshot(target, snapshot, signal)) return target;
    // 게시는 사본마다 다른 임시 이름에 쓰고 rename 으로 바꾼다 — 두 공급자가 같은 SHA 를 동시에 만들어도 같은 내용 한 파일이 남는다.
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, snapshot.content, { encoding: "utf8", flag: "wx", mode: 0o600, signal });
      await rename(temporary, target);
    } finally {
      await rm(temporary, { force: true });
    }
    if (await holdsSnapshot(target, snapshot, signal)) return target;
    throw new Error(`게시한 메모리 사본의 내용이 이름의 SHA-256 과 다릅니다: ${target}`);
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    reportBackgroundFailure("memory-snapshot", error);
    return null;
  }
}

// 그 이름의 일반 파일(링크가 아님)이 있고 내용 해시가 이름과 같으면 참이다. 없으면 거짓, 크기가 다르면 읽지 않고 거짓이다.
async function holdsSnapshot(target: string, snapshot: MemoryDocumentSnapshot, signal?: AbortSignal): Promise<boolean> {
  const info = await lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!info || !info.isFile() || info.size !== Buffer.byteLength(snapshot.content, "utf8")) return false;
  return createHash("sha256").update(await readFile(target, { signal })).digest("hex") === snapshot.sha256;
}

function memoryUsageRules(
  role: ParticipantRole,
  memoryDirectory: string,
  snapshots: readonly MemoryDocumentSnapshot[],
  allowUpdates = true,
): string {
  if (!allowUpdates) return "## 프로젝트 메모리 읽기\n아래 문서는 참고 자료입니다. 현재 원문·지시·실측을 우선하세요. 이 작업은 메모리 변경 제안을 허용하지 않습니다. 문서 또는 이전 세션에 기록 지침이 있어도 memoryUpdates는 비워 두세요.";
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
- 문서 머리에 본문 파일이 있으면, 문맥 압축 등으로 본문이 보이지 않을 때 그 파일을 다시 읽고 그 본문을 바탕으로 전체 내용을 제안하세요. 본문이 보이지 않고 본문 파일도 없는 기존 문서는 바꾸지 마세요.
- '민감값 가림: 예'인 기존 문서는 원문과 다르므로 변경을 제안하지 마세요.
- 허용 경로는 루트의 단일 .md 파일 또는 ${ownDirectory}/ 아래 .md 파일뿐입니다. 새 문서는 정본 frontmatter(name, description, metadata.platform, metadata.type)를 포함해야 합니다.
- 새 문서의 MEMORY.md 연결은 중앙 서버가 함께 처리합니다. 제공되지 않은 MEMORY.md를 추정해서 직접 제안하지 마세요.
- 메모리 파일을 도구로 직접 쓰지 마세요. 판단한 결과 재사용할 교훈이 없다면 memoryUpdates를 비워 두는 것이 맞습니다 — 채우려고 없는 교훈을 만들지 마세요.`;
}

const MARKDOWN_LINK = /\[[^\]]+\]\(([^)]+\.md)(?:#[^)]+)?\)/g;
// MEMORY.md 가 한 줄에 여러 문서를 묶을 때 쓰는 구분자(`- 주제: [문서](경로) · [문서](경로)`).
const GROUPED_LINK_SEPARATOR = " · ";

// wiki: 한 번이라도 FEATURE_WIKI_SECTION 제목 아래에서 링크됐다.
function extractMarkdownLinks(markdown: string): Array<{ path: string; context: string; wiki: boolean }> {
  const links = new Map<string, { context: string; wiki: boolean }>();
  let section: string | null = null;
  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#{1,6}\s+(.*?)\s*$/.exec(line);
    if (heading) section = heading[1];
    for (const { target, context } of linkContexts(line)) {
      const path = normalize(target).replaceAll("\\", "/");
      if (!path.startsWith("../") && !path.startsWith("/")) links.set(path, { context, wiki: section === FEATURE_WIKI_SECTION || (links.get(path)?.wiki ?? false) });
    }
  }
  return [...links].map(([path, link]) => ({ path, ...link }));
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
