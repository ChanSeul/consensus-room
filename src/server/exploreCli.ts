#!/usr/bin/env node
// 운영 모델·캐시·인덱스와 연결하지 않는 일회성 rg 탐색기. HEAD 아카이브만 읽어 검색과 문맥이 같은
// immutable snapshot을 바라보게 하고, JSON만 stdout으로 내보내 자동 비교에 쓸 수 있다.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

export interface ExploreLocation { file: string; line: number; content: string; contentHash: string; }
export interface ExploreResult {
  repository: string;
  symbol: string;
  scope: string | null;
  locations: ExploreLocation[];
  omitted: boolean;
  returnedBytes: number;
  limits: { locations: number; contextLines: number; bytes: number };
}

const MAX_LOCATIONS = 20;
const CONTEXT = 5;
const MAX_BYTES = 16 * 1024;
const LIMITS = { locations: MAX_LOCATIONS, contextLines: CONTEXT, bytes: MAX_BYTES };

function inside(root: string, value: string): boolean {
  const rel = relative(root, value);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function safePath(root: string, requested?: string): string {
  const target = resolve(root, requested ?? ".");
  if (!inside(root, target)) throw new Error("탐색 범위가 저장소 밖을 가리킵니다.");
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) throw new Error("심볼릭 링크는 탐색 범위로 사용할 수 없습니다.");
  const canonical = realpathSync(target);
  if (!inside(root, canonical)) throw new Error("실제 경로가 저장소 밖을 가리킵니다.");
  return canonical;
}

function validate(repository: string, symbol: string, requestedPath?: string): { root: string; scopeRelative: string } {
  if (!symbol.trim()) throw new Error("symbol이 비어 있습니다.");
  if (Buffer.byteLength(symbol, "utf8") > 1_024) throw new Error("symbol이 결과 한도에 비해 너무 깁니다.");
  const requestedRoot = resolve(repository);
  if (lstatSync(requestedRoot).isSymbolicLink()) throw new Error("repository는 심볼릭 링크가 아닌 디렉터리여야 합니다.");
  const root = realpathSync(requestedRoot);
  if (!lstatSync(root).isDirectory()) throw new Error("repository는 심볼릭 링크가 아닌 디렉터리여야 합니다.");
  const scope = safePath(root, requestedPath);
  return { root, scopeRelative: relative(root, scope) || "." };
}

async function archiveHead(root: string): Promise<string> {
  const snapshot = await mkdtemp(join(tmpdir(), "consensus-explore-head-"));
  try {
    await new Promise<void>((resolvePromise, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    const extract = spawn("tar", ["-x", "-C", snapshot], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = "";
    archive.stderr.setEncoding("utf8");
    extract.stderr.setEncoding("utf8");
    archive.stderr.on("data", (chunk: string) => { stderr += chunk; });
    extract.stderr.on("data", (chunk: string) => { stderr += chunk; });
    archive.stdout.pipe(extract.stdin);
    const fail = (error: Error) => {
      archive.kill("SIGTERM");
      extract.kill("SIGTERM");
      reject(error);
    };
    archive.once("error", fail);
    extract.once("error", fail);
    let archiveResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    let extractResult: { code: number | null; signal: NodeJS.Signals | null } | undefined;
    const finish = () => {
      if (!archiveResult || !extractResult) return;
      if (archiveResult.code === 0 && extractResult.code === 0) resolvePromise();
      else reject(new Error(`HEAD 스냅샷을 만들지 못했습니다: ${stderr.trim() || `${archiveResult.code ?? archiveResult.signal}/${extractResult.code ?? extractResult.signal}`}`));
    };
    archive.once("close", (code, signal) => { archiveResult = { code, signal }; finish(); });
    extract.once("close", (code, signal) => { extractResult = { code, signal }; finish(); });
    });
    return realpathSync(snapshot);
  } catch (error) {
    await rm(snapshot, { recursive: true, force: true });
    throw error;
  }
}

type RgMatch = { path: string; line: number };

async function rgMatches(snapshot: string, scopeRelative: string, symbol: string): Promise<{ matches: RgMatch[]; omitted: boolean }> {
  const scope = resolve(snapshot, scopeRelative);
  try {
    const stat = lstatSync(scope);
    if (stat.isSymbolicLink()) throw new Error("HEAD 스냅샷의 심볼릭 링크는 탐색할 수 없습니다.");
  } catch (error) {
    if (error instanceof Error && error.message.includes("심볼릭 링크")) throw error;
    throw new Error("요청한 경로가 HEAD 스냅샷에 없습니다.");
  }
  const child = spawn("rg", ["--json", "--color", "never", "--fixed-strings", "--", symbol, scope], {
    cwd: snapshot, stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolvePromise({ code, signal }));
  });
  const matches: RgMatch[] = [];
  let omitted = false;
  let stoppedForLimit = false;
  let pending = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  try {
    for await (const chunk of child.stdout) {
      pending += chunk as string;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        let event: { type?: unknown; data?: { path?: { text?: unknown }; line_number?: unknown } } | undefined;
        try {
          event = JSON.parse(raw) as typeof event;
        } catch { continue; }
        if (!event || event.type !== "match" || typeof event.data?.path?.text !== "string" || !Number.isInteger(event.data.line_number)) continue;
        if (matches.length >= MAX_LOCATIONS) {
          omitted = true;
          stoppedForLimit = true;
          child.kill("SIGTERM");
          break;
        }
        const absolute = isAbsolute(event.data.path.text) ? event.data.path.text : resolve(snapshot, event.data.path.text);
        const path = relative(snapshot, absolute);
        if (!path || path.startsWith("..") || isAbsolute(path)) {
          omitted = true;
          continue;
        }
        matches.push({ path, line: event.data.line_number as number });
      }
    }
  } catch (error) {
    child.kill("SIGTERM");
    await closed.catch(() => undefined);
    throw error;
  }
  const result = await closed;
  if (result.code === 0 || result.code === 1 || (stoppedForLimit && result.signal === "SIGTERM")) return { matches, omitted };
  throw new Error(`rg failed: ${stderr.trim() || String(result.code)}`);
}

async function location(snapshot: string, match: RgMatch): Promise<ExploreLocation | null> {
  const file = resolve(snapshot, match.path);
  if (!inside(snapshot, file)) return null;
  try {
    const parent = realpathSync(dirname(file));
    if (!inside(snapshot, parent) || lstatSync(file).isSymbolicLink()) return null;
    const canonical = realpathSync(file);
    if (!inside(snapshot, canonical)) return null;
    const lines = (await readFile(canonical, "utf8")).split(/\r?\n/);
    const start = Math.max(0, match.line - 1 - CONTEXT);
    const end = Math.min(lines.length, match.line + CONTEXT);
    const content = lines.slice(start, end).map((value, index) => `${start + index + 1}: ${value}`).join("\n");
    return {
      file: relative(snapshot, canonical), line: match.line, content,
      contentHash: createHash("sha256").update(content).digest("hex"),
    };
  } catch { return null; }
}

function serializedBytes(result: ExploreResult): number {
  return Buffer.byteLength(`${JSON.stringify(result, null, 2)}\n`, "utf8");
}

// 검색·문맥 모두 호출 시점 HEAD에서 만든 private archive를 쓴다. 따라서 untracked·미커밋 작업 트리 파일은
// 의도적으로 보이지 않으며, 결과를 만들 동안 symlink 교체로 저장소 밖 내용을 읽을 수 없다.
export async function explore(repository: string, symbol: string, requestedPath?: string): Promise<ExploreResult> {
  const { root, scopeRelative } = validate(repository, symbol, requestedPath);
  const snapshot = await archiveHead(root);
  try {
    const searched = await rgMatches(snapshot, scopeRelative, symbol);
    const locations: ExploreLocation[] = [];
    let returnedBytes = 0;
    let omitted = searched.omitted;
    for (const match of searched.matches) {
      const item = await location(snapshot, match);
      if (!item) { omitted = true; continue; }
      const nextBytes = returnedBytes + Buffer.byteLength(item.content, "utf8");
      const candidate: ExploreResult = {
        repository: root, symbol, scope: requestedPath ?? null, locations: [...locations, item], omitted: true,
        returnedBytes: nextBytes, limits: LIMITS,
      };
      if (serializedBytes(candidate) > MAX_BYTES) { omitted = true; break; }
      locations.push(item);
      returnedBytes = nextBytes;
    }
    if (locations.length < searched.matches.length) omitted = true;
    let result: ExploreResult = { repository: root, symbol, scope: requestedPath ?? null, locations, omitted, returnedBytes, limits: LIMITS };
    while (locations.length && serializedBytes(result) > MAX_BYTES) {
      const removed = locations.pop()!;
      returnedBytes -= Buffer.byteLength(removed.content, "utf8");
      result = { ...result, locations, omitted: true, returnedBytes };
    }
    if (serializedBytes(result) > MAX_BYTES) throw new Error("탐색 결과가 출력 한도를 초과합니다.");
    return result;
  } finally {
    await rm(snapshot, { recursive: true, force: true });
  }
}

// 별도 버퍼링 경로를 두지 않는다. explore 자체가 rg JSON을 스트리밍하며 최대 21번째 위치에서 프로세스를 끊는다.
export const exploreStreaming = explore;

function args(argv: string[]): { repository: string; symbol: string; path?: string } {
  const read = (name: string) => { const index = argv.indexOf(name); return index < 0 ? undefined : argv[index + 1]; };
  const repository = read("--repository");
  const symbol = read("--symbol");
  if (!repository || !symbol || argv.some((item) => item.startsWith("--") && !["--repository", "--symbol", "--path"].includes(item))) {
    throw new Error("사용법: explore --repository <path> --symbol <text> [--path <repository-relative-path>]");
  }
  return { repository, symbol, path: read("--path") };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void (async () => { try { const input = args(process.argv.slice(2)); process.stdout.write(`${JSON.stringify(await explore(input.repository, input.symbol, input.path), null, 2)}\n`); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 2; }
  })();
}
