import { lstat, readdir, realpath, rm } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

const CACHE_NAMES = new Set(["Build", "Index", "Index.noindex", "ModuleCache", "ModuleCache.noindex"]);
const protectedName = (name: string) => /(?:-logs|-work)$/i.test(name) || /^(?:logs|testresults)$/i.test(name) || /(?:\.lock|^lock)$/i.test(name);
export interface BuildTreeCandidate { path: string; bytes: number; removed: boolean; reason?: string; incomplete?: boolean }
export interface BuildTreePruneReport {
  dryRun: boolean;
  cancelled?: boolean;
  candidates: BuildTreeCandidate[];
  removed: string[];
  incomplete: string[];
  kept: string[];
  // 완전히 삭제된 후보의 파일 크기 합. 부분 실패는 제외하며 물리적 여유 공간 변화는 아니다.
  freedBytes: number;
}
export interface BuildTreePruneOptions {
  dryRun?: boolean;
  signal?: AbortSignal;
  protection?: () => string[];
}

// worktree와 증거 폴더는 남기고 명시된 재생성 가능 캐시만 수동으로 정리한다.
export async function pruneBuildTrees(worktreePath: string, options: BuildTreePruneOptions = {}): Promise<BuildTreePruneReport> {
  const report: BuildTreePruneReport = { dryRun: options.dryRun ?? false, candidates: [], removed: [], incomplete: [], kept: [], freedBytes: 0 };
  const root = resolve(worktreePath);
  const protect = () => {
    options.signal?.throwIfAborted();
    try { return options.protection?.() ?? []; }
    catch { return ["활성 작업 보호 상태를 확인할 수 없습니다."]; }
  };
  const rootInfo = await lstat(root).catch(() => null);
  if (!rootInfo?.isDirectory() || rootInfo.isSymbolicLink()) {
    report.kept.push("작업 폴더가 없거나 실제 디렉터리가 아닙니다.");
    return report;
  }
  const canonicalRoot = await realpath(root);
  const protectedAtStart = protect();
  if (protectedAtStart.length) { report.kept.push(...protectedAtStart); return report; }
  const paths: string[] = [];
  const derived = join(root, "DerivedData");
  const derivedInfo = await lstat(derived).catch(() => null);
  if (derivedInfo?.isDirectory() && !derivedInfo.isSymbolicLink()) {
    for (const name of (await readdir(derived)).sort()) {
      const path = join(derived, name), info = await lstat(path);
      if (protectedName(name) || info.isSymbolicLink()) { report.kept.push(relative(root, path)); continue; }
      if (!info.isDirectory()) continue;
      if (CACHE_NAMES.has(name)) paths.push(path);
      else {
        for (const child of (await readdir(path)).sort()) {
          if (CACHE_NAMES.has(child)) paths.push(join(path, child));
          else report.kept.push(relative(root, join(path, child)));
        }
      }
    }
  } else if (derivedInfo) report.kept.push("DerivedData (실제 디렉터리가 아님)");
  if (await lstat(join(root, "Tuist", ".build")).catch(() => null)) paths.push(join(root, "Tuist", ".build"));

  for (const path of paths) {
    const candidate: BuildTreeCandidate = { path: relative(root, path), bytes: 0, removed: false };
    report.candidates.push(candidate);
    let deleting = false;
    try {
      const before = await validatePath(path);
      candidate.bytes = await inspectTree(path);
      const after = await validatePath(path);
      if (before.dev !== after.dev || before.ino !== after.ino) throw new Error("검사 중 캐시 경로가 바뀌었습니다.");
      const reasons = protect(); // 마지막 파일 검사 뒤, 실제 삭제 바로 전에 원장을 다시 확인한다.
      if (reasons.length) throw new Error(reasons.join(" / "));
      options.signal?.throwIfAborted();
      if (!report.dryRun) {
        deleting = true;
        await rm(path, { recursive: true, force: false });
        candidate.removed = true;
        report.removed.push(candidate.path);
        report.freedBytes += candidate.bytes;
      }
    } catch (error) {
      if (options.signal?.aborted) report.cancelled = true;
      candidate.reason = error instanceof Error ? error.message : String(error);
      if (deleting) {
        candidate.incomplete = true;
        report.incomplete.push(`${candidate.path}: ${candidate.reason}`);
        break; // 삭제 결과가 불명확하면 다음 후보까지 계속 지우지 않는다.
      }
      report.kept.push(`${candidate.path}: ${candidate.reason}`);
      if (report.cancelled) break;
    }
  }
  return report;

  async function validatePath(path: string) {
    const currentRoot = await lstat(root);
    if (!currentRoot.isDirectory() || currentRoot.isSymbolicLink() || currentRoot.dev !== rootInfo!.dev || currentRoot.ino !== rootInfo!.ino ||
      await realpath(root) !== canonicalRoot) throw new Error("검사 중 작업 폴더 경로가 바뀌었습니다.");
    const parts = relative(root, path).split(sep);
    if (parts.includes("..") || !parts.length) throw new Error("작업 폴더 밖의 경로입니다.");
    let current = root, info = currentRoot;
    for (const part of parts) {
      current = join(current, part);
      info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("심볼릭 링크 또는 디렉터리가 아닌 경로를 보존합니다.");
    }
    return info;
  }

  async function inspectTree(path: string): Promise<number> {
    options.signal?.throwIfAborted();
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error("하위 심볼릭 링크가 있어 캐시 전체를 보존합니다.");
    if (info.isFile()) return info.size;
    if (!info.isDirectory()) throw new Error("일반 파일이 아닌 항목이 있어 보존합니다.");
    let bytes = 0;
    for (const name of await readdir(path)) {
      if (protectedName(name)) throw new Error(`보존 대상 ${name}이 들어 있어 캐시 전체를 보존합니다.`);
      bytes += await inspectTree(join(path, name));
    }
    return bytes;
  }
}

export function describePrune(report: BuildTreePruneReport): string {
  const ready = report.candidates.filter(candidate => !candidate.reason);
  const bytes = report.dryRun ? ready.reduce((sum, candidate) => sum + candidate.bytes, 0) : report.freedBytes;
  const count = report.dryRun ? ready.length : report.removed.length;
  const names = (report.dryRun ? ready.map(candidate => candidate.path) : report.removed).join(", ") || "(없음)";
  return `빌드 트리 정리${report.dryRun ? " 미리보기" : ""}: ${count}개 ${report.dryRun ? "삭제 예정" : "삭제"}(파일 크기 약 ${(bytes / 1024 ** 3).toFixed(1)} GiB) — ${names}. 보존: ${report.kept.join(", ") || "(없음)"}.${report.incomplete.length ? ` 삭제 도중 실패(일부 삭제 가능, 크기 미확정): ${report.incomplete.join(", ")}.` : ""}`;
}
