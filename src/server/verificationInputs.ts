import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { arch, release } from "node:os";
import { z } from "zod";
import { resolveHostExecutable } from "./hostRuntime.js";

export const STATIC_PROFILE_ID = "swift-concurrency-policy";
export const STATIC_SCRIPT = "ci/check_swift_concurrency_policy.sh";
export const STATIC_SCRIPT_SHA256 = "a4f54f8226af2aab2b0f194e6a4a0a3d2866f945713e9ce507b118646ec81698";
const absolute = z.string().refine(isAbsolute, "절대 경로가 필요합니다.");
export const staticProfileSchema = z.object({
  id: z.literal(STATIC_PROFILE_ID), version: z.literal(1), scriptSHA256: z.literal(STATIC_SCRIPT_SHA256),
  bash: absolute, python: absolute, pythonLibraries: z.array(absolute).min(1),
}).strict();
export type StaticProfile = z.infer<typeof staticProfileSchema>;
export const sha = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export type InputFile = { path: string; content: Buffer; mode: number };

// Git의 tracked/ignored 구분과 무관하게 검사기가 실제로 읽는 파일 전체를 수집한다.
export async function collectStaticInputs(root: string): Promise<InputFile[]> {
  const files: InputFile[] = [];
  let bytes = 0;
  const add = async (path: string) => {
    const info = await lstat(join(root, path));
    if (!info.isFile()) throw new Error(`정적 검사 입력은 일반 파일이어야 합니다: ${path}`);
    bytes += info.size;
    if (bytes > 256 * 1024 * 1024 || files.length >= 100_000) throw new Error("정적 검사 입력 한도를 초과했습니다.");
    files.push({ path, content: await readFile(join(root, path)), mode: info.mode & 0o777 });
  };
  const walk = async (path: string) => {
    const info = await lstat(join(root, path));
    if (!info.isDirectory()) throw new Error(`입력 디렉터리가 없거나 symlink입니다: ${path}`);
    for (const entry of (await readdir(join(root, path), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = `${path}/${entry.name}`;
      if (entry.isSymbolicLink()) throw new Error(`정적 검사 입력 symlink를 지원하지 않습니다: ${child}`);
      if (entry.isDirectory() && entry.name.endsWith(".swift")) throw new Error(`Swift 입력은 일반 파일이어야 합니다: ${child}`);
      if (entry.isDirectory()) await walk(child);
      else if (entry.name.endsWith(".swift")) await add(child);
    }
  };
  for (const path of ["Modules", "SampleApp"]) await walk(path);
  if (!(await lstat(join(root, "ci"))).isDirectory()) throw new Error("검사기 디렉터리는 일반 디렉터리여야 합니다.");
  await add(STATIC_SCRIPT);
  if (sha(files.find((file) => file.path === STATIC_SCRIPT)!.content) !== STATIC_SCRIPT_SHA256) {
    throw new Error("등록된 정적 검사 스크립트와 다릅니다. 변경된 검사기는 별도 검토가 필요합니다.");
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function inputSHA(files: readonly InputFile[]): string {
  return sha(JSON.stringify(files.map((file) => [file.path, file.mode, sha(file.content)])));
}

export async function loadStaticProfile(dataDirectory: string, worktree: string): Promise<StaticProfile> {
  const profilePath = await realpath(join(dataDirectory, "verification-profiles", `${STATIC_PROFILE_ID}.json`));
  assertOutside(profilePath, await realpath(worktree));
  return staticProfileSchema.parse(JSON.parse(await readFile(profilePath, "utf8")));
}

function assertOutside(path: string, root: string) {
  const rel = relative(root, path);
  if (rel === "" || (!rel.startsWith("../") && !isAbsolute(rel))) throw new Error("검사 프로필과 도구는 worktree 밖에 있어야 합니다.");
}

export async function toolSHA(profile: StaticProfile, worktree: string): Promise<string> {
  const entries: Array<[string, number, string]> = [];
  const visited = new Set<string>();
  const root = await realpath(worktree);
  const walk = async (path: string): Promise<void> => {
    let actual: string;
    try { actual = await realpath(path); }
    catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        entries.push([resolve(path), 0, "missing"]);
        return;
      }
      throw error;
    }
    assertOutside(actual, root);
    if (visited.has(actual)) return;
    visited.add(actual);
    const stat = await lstat(actual);
    if (stat.isDirectory()) {
      for (const name of (await readdir(actual)).sort()) {
        // -I -S로 site는 사용하지 않는다. -B도 기존 bytecode를 읽을 수 있어 pyc는 해시에 포함한다.
        if (name === "site-packages") continue;
        await walk(join(actual, name));
      }
    } else if (stat.isFile()) entries.push([JSON.stringify([resolve(path), actual]), stat.mode & 0o777, sha(await readFile(actual))]);
    else throw new Error("검사 도구에 지원하지 않는 파일이 있습니다.");
  };
  for (const path of [profile.bash, profile.python, ...profile.pythonLibraries]) await walk(path);
  return sha(JSON.stringify({ profile, entries, platform: process.platform, arch: arch(), release: release(), runner: 1 }));
}

// ---- swift-parse(계획 필수 검사 프로필) — 구현 기준 대비 바뀐 Swift 파일의 구문만 검사한다(타입 검사·빌드 아님). 실행 파일은 호스트 전제의 단일 소유자
// (hostRuntime.resolveHostExecutable("swiftc"))가 쓸 때마다 푼다. swiftc 는 swift-frontend 의 심볼릭 링크이고, 드라이버 모드는 첫 실패 파일 뒤의 오류를
// 버리고 같은 이름의 파일 둘(sample-ios Step 5/SpecialPickType.swift 등)을 문법 오류 없이도 거부해 frontend 모드(-frontend -parse)로 한 번에 돌린다. ----
export const SWIFT_PARSE_PROFILE_ID = "swift-parse";
export interface SwiftParseProfile { id: typeof SWIFT_PARSE_PROFILE_ID; version: 1; frontend: string; versionText: string }

export async function loadSwiftParseProfile(): Promise<SwiftParseProfile> {
  const swiftc = await resolveHostExecutable("swiftc", { version: true });
  return { id: SWIFT_PARSE_PROFILE_ID, version: 1, frontend: swiftc.realPath, versionText: swiftc.version ?? "" };
}

// 검사 대상 — 작업 트리에서 바뀐 경로(구현 기준 대비; 수락 경계에서는 HEAD 가 구현 기준에 고정돼 HEAD 대비 변경과 같다) 중 지금 존재하는 일반 *.swift 파일.
// 삭제된 경로는 대상이 아니다. symlink·디렉터리 이름의 .swift 는 검사 입력으로 받지 않는다.
export async function collectSwiftParseInputs(root: string, changedPaths: readonly string[]): Promise<InputFile[]> {
  const files: InputFile[] = [];
  for (const path of [...new Set(changedPaths)].filter((path) => path.endsWith(".swift")).sort()) {
    if (isAbsolute(path) || path.split("/").includes("..")) throw new Error(`검사 입력 경로가 작업 트리 밖입니다: ${path}`);
    const info = await lstat(join(root, path)).catch(() => null);
    if (!info) continue;
    if (!info.isFile()) throw new Error(`Swift 검사 입력은 일반 파일이어야 합니다: ${path}`);
    files.push({ path, content: await readFile(join(root, path)), mode: info.mode & 0o777 });
  }
  return files;
}

// 도구 신원 — frontend 실행 파일 내용·버전 문자열·플랫폼. 실행 파일(~170MB)은 같은 inode·크기·수정 시각이면 프로세스 안에서 해시를 다시 쓰지 않는다.
const binaryHashes = new Map<string, Promise<string>>();
export async function swiftParseToolSHA(profile: SwiftParseProfile): Promise<string> {
  const info = await stat(profile.frontend);
  const key = JSON.stringify([profile.frontend, info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs]);
  let hashed = binaryHashes.get(key);
  if (!hashed) {
    hashed = new Promise<string>((resolveHash, reject) => {
      const hash = createHash("sha256");
      createReadStream(profile.frontend).on("data", (chunk) => hash.update(chunk)).on("error", reject).on("end", () => resolveHash(hash.digest("hex")));
    });
    binaryHashes.set(key, hashed);
    hashed.catch(() => binaryHashes.delete(key));
  }
  return sha(JSON.stringify({ profile, binary: await hashed, platform: process.platform, arch: arch(), release: release(), runner: 1 }));
}
