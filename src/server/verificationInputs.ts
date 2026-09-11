import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { arch, release } from "node:os";
import { z } from "zod";

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
