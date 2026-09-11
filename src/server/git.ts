import { createHash } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { access, lstat, mkdir, readdir, readlink, realpath, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CommandRunner } from "./types.js";

export class GitService {
  constructor(private readonly runner: CommandRunner) {}

  async createDetachedWorktree(repositoryPath: string, worktreePath: string, baseRef: string): Promise<void> {
    const repository = await realpath(repositoryPath);
    await this.assertGitRepository(repository);
    await this.assertNoActiveRepositoryHooks(repository);
    try {
      await access(worktreePath);
      throw new Error(`worktree 경로가 이미 존재합니다: ${worktreePath}`);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("worktree 경로")) throw error;
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    await mkdir(dirname(worktreePath), { recursive: true });
    await this.run(repository, ["worktree", "add", "--detach", worktreePath, baseRef]);
  }

  async createBranch(worktreePath: string, branchName: string): Promise<void> {
    await this.assertNoActiveRepositoryHooks(worktreePath);
    const current = (await this.run(worktreePath, ["branch", "--show-current"])).stdout.trim();
    if (current === branchName) return;
    const exists = await this.runner.run({
      command: "git", args: ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], cwd: worktreePath,
    });
    if (exists.exitCode === 0) {
      // 기존 브랜치로 switch하면 detached 기준 리비전(승인된 계획의 전제)이 그 브랜치의 HEAD로 바뀐다(감사 ⑦).
      // 같은 이름 재시도는 위의 current === branchName 경로만 허용한다.
      throw new Error(`브랜치가 이미 존재합니다: ${branchName}. 다른 이름을 지정하거나 기존 브랜치를 정리해 주세요.`);
    }
    await this.run(worktreePath, ["switch", "-c", branchName]);
  }

  async commit(worktreePath: string, branchName: string, message: string, paths: string[]): Promise<string> {
    await this.assertNoActiveRepositoryHooks(worktreePath);
    await this.assertCurrentBranch(worktreePath, branchName);
    const normalized = normalizeCommitPaths(worktreePath, paths);
    const preexisting = await this.run(worktreePath, ["diff", "--cached", "--name-only", "-z"]);
    if (preexisting.stdout.trim()) {
      throw new Error("이미 stage된 변경이 있어 안전하게 커밋할 수 없습니다.");
    }
    try {
      await this.run(worktreePath, ["add", "--", ...normalized]);
      const staged = (await this.run(worktreePath, ["diff", "--cached", "--name-only", "-z"])).stdout
        .split("\0").filter(Boolean);
      if (staged.length === 0) throw new Error("선택한 경로에 커밋할 변경이 없습니다.");
      const allowed = normalized.map((path) => path.endsWith("/") ? path : `${path}${sep}`);
      const outside = staged.filter((path) => !normalized.includes(path) && !allowed.some((root) => path.startsWith(root)));
      if (outside.length > 0) throw new Error(`선택 범위 밖 파일이 stage되었습니다: ${outside.join(", ")}`);
      await this.run(worktreePath, ["commit", "-m", message, "--", ...normalized]);
    } catch (error) {
      await this.run(worktreePath, ["restore", "--staged", "--", ...normalized]).catch(() => undefined);
      throw error;
    }
    return (await this.run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async push(worktreePath: string, branchName: string): Promise<string> {
    await this.assertNoActiveRepositoryHooks(worktreePath);
    if (!branchName) throw new Error("push할 작업 브랜치가 없습니다.");
    await this.assertCurrentBranch(worktreePath, branchName);
    await this.run(worktreePath, ["push", "--set-upstream", "origin", branchName]);
    return (await this.run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  }

  // update-ref는 됐는데 index 재정렬 전에 중단된 되돌리기를 마저 끝낸다. 작업 트리는 건드리지 않는다.
  async resyncIndex(worktreePath: string, branchName: string): Promise<void> {
    await this.assertNoActiveRepositoryHooks(worktreePath);
    await this.assertCurrentBranch(worktreePath, branchName);
    await this.run(worktreePath, ["reset", "--mixed"]);
  }

  async resetToCommit(worktreePath: string, branchName: string, oid: string, expectedHead: string): Promise<void> {
    await this.assertNoActiveRepositoryHooks(worktreePath);
    await this.assertCurrentBranch(worktreePath, branchName);
    // update-ref의 세 인자 형태는 현재 값이 expectedHead와 다르면 실패한다. 호출부가 확인한 뒤와
    // 실제로 되돌리는 사이에 HEAD가 움직여도 엉뚱한 커밋을 브랜치에서 떼지 않는다.
    await this.run(worktreePath, ["update-ref", `refs/heads/${branchName}`, oid, expectedHead]);
    // 작업 트리는 건드리지 않고 index만 새 HEAD로 맞춘다. 커밋 직전 상태(staged 없음)가 그대로 재현된다.
    await this.run(worktreePath, ["reset", "--mixed"]);
  }

  // 리뷰 시점의 작업 트리를 git 트리 객체로 남긴다(2026-09-07 Codex 피드백 ①: 최종 리뷰에 '직전 리뷰 이후 변경분' 을 주기 위해).
  // 임시 index 에 add -A 한 뒤 write-tree 하므로 실제 index·worktree·stash 는 건드리지 않는다(사용자 규칙: stash 금지).
  // 트리는 refs/consensus/reviewed/<label> 로 잡아 gc 에 지워지지 않게 한다.
  async writeWorkingTree(worktreePath: string, label: string): Promise<string> {
    const gitDirectory = (await this.run(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    const indexFile = resolve(gitDirectory, `consensus-index-${process.pid}-${Date.now()}`);
    const environment = { ...process.env, GIT_INDEX_FILE: indexFile };
    try {
      await this.run(worktreePath, ["read-tree", "HEAD"], undefined, environment);
      await this.run(worktreePath, ["add", "-A", "--", "."], undefined, environment);
      const tree = (await this.run(worktreePath, ["write-tree"], undefined, environment)).stdout.trim();
      await this.run(worktreePath, ["update-ref", `refs/consensus/reviewed/${label}`, tree]);
      return tree;
    } finally {
      await rm(indexFile, { force: true }).catch(() => undefined);
    }
  }

  // 두 트리 사이의 통합 diff(파일 목록 + 패치). 최종 리뷰가 "직전 리뷰 이후 실제 변경분" 만 다시 보게 한다.
  async diffTrees(worktreePath: string, fromTree: string, toTree: string): Promise<{ files: string[]; patch: string }> {
    const files = (await this.run(worktreePath, ["diff-tree", "-r", "--no-renames", "--name-only", "-z", fromTree, toTree]))
      .stdout.split("\0").filter(Boolean).sort();
    const patch = (await this.run(worktreePath, ["diff-tree", "-r", "-p", "--no-color", "--no-renames", fromTree, toTree], 64 * 1024 * 1024)).stdout;
    return { files, patch };
  }

  async head(worktreePath: string): Promise<string> {
    return (await this.run(worktreePath, ["rev-parse", "HEAD"])).stdout.trim();
  }

  async diffPlanFiles(cwd: string, previous: string, current: string): Promise<string> {
    const result = await this.runner.run({
      command: "git", args: ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", previous, current],
      cwd, maxOutputBytes: 64 * 1024 * 1024,
    });
    if (result.exitCode !== 0 && result.exitCode !== 1) throw new Error("계획 변경분을 계산하지 못했습니다.");
    return result.stdout;
  }

  async snapshot(worktreePath: string, baseRef?: string): Promise<{ head: string; diffSHA256: string }> {
    const head = await this.head(worktreePath);
    const base = baseRef
      ? (await this.run(worktreePath, ["rev-parse", baseRef])).stdout.trim()
      : head;
    const tracked = (await this.run(
      worktreePath, ["diff", "--no-renames", "--name-only", "-z", base, "--"], 128 * 1024 * 1024,
    )).stdout.split("\0").filter(Boolean);
    const untracked = (await this.run(worktreePath, ["ls-files", "--others", "--exclude-standard", "-z"])).stdout
      .split("\0").filter(Boolean).sort();
    const paths = [...new Set([...tracked, ...untracked])].sort();
    const hash = createHash("sha256").update(`BASE\0${base}\0`, "utf8");
    for (const path of paths) {
      const absolutePath = resolve(worktreePath, path);
      let metadata;
      try {
        metadata = await lstat(absolutePath);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
          hash.update(`FILE\0${path}\0MISSING\0`, "utf8");
          continue;
        }
        throw error;
      }
      hash.update(`FILE\0${path}\0MODE\0${metadata.mode & 0o7777}\0`, "utf8");
      if (metadata.isSymbolicLink()) {
        hash.update(`SYMLINK\0${await readlink(absolutePath)}\0`, "utf8");
      } else if (metadata.isFile()) {
        hash.update("REGULAR\0", "utf8");
        for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
      } else {
        throw new Error(`지원하지 않는 untracked 파일 종류입니다: ${path}`);
      }
      hash.update("\0", "utf8");
    }
    return { head, diffSHA256: hash.digest("hex") };
  }

  async commitParent(worktreePath: string, oid: string): Promise<string> {
    return (await this.run(worktreePath, ["rev-parse", `${oid}^`])).stdout.trim();
  }

  // 되돌리기는 부모가 하나인 커밋만 대상으로 한다. merge나 root 커밋을 같은 방식으로 떼면 안 되므로 개수를 함께 본다.
  async commitParents(worktreePath: string, oid: string): Promise<string[]> {
    const line = (await this.run(worktreePath, ["rev-list", "--parents", "-n", "1", oid])).stdout.trim();
    return line.split(/\s+/).filter(Boolean).slice(1);
  }

  async commitChangedPaths(worktreePath: string, oid: string): Promise<string[]> {
    return (await this.run(
      worktreePath,
      ["diff-tree", "--no-renames", "--no-commit-id", "--name-only", "-r", "-z", oid, "--"],
      128 * 1024 * 1024,
    )).stdout.split("\0").filter(Boolean).sort();
  }

  async remoteBranchOID(worktreePath: string, branchName: string): Promise<string | null> {
    const result = await this.run(worktreePath, ["ls-remote", "--heads", "origin", `refs/heads/${branchName}`]);
    const oid = result.stdout.trim().split(/\s+/, 1)[0];
    return oid && /^[a-f0-9]{40,64}$/.test(oid) ? oid : null;
  }

  // 허용 오차 대조용(2026-09-08). 인자로 준 경로 중 git 이 추적하는 것만 돌려준다(없는 파일·untracked 는 제외).
  async trackedPaths(worktreePath: string, paths: readonly string[]): Promise<string[]> {
    if (paths.length === 0) return [];
    const raw = (await this.run(worktreePath, ["ls-files", "-z", "--", ...paths])).stdout;
    return raw.split("\0").filter(Boolean);
  }

  // 구현 기준 커밋 대비 작업 트리의 한 파일 패치(문맥 0줄) — hunk 술어 대조에 쓴다.
  async fileDiffSinceBase(worktreePath: string, baseOID: string, file: string): Promise<string> {
    return (await this.run(worktreePath, ["diff", "-U0", "--no-color", "--no-renames", baseOID, "--", file], 16 * 1024 * 1024)).stdout;
  }

  // 기준 커밋 시점의 파일 내용. 그 커밋에 없는 파일(새로 추가돼 index 에만 있는 경우 등)은 null.
  async fileAtCommit(worktreePath: string, oid: string, file: string): Promise<string | null> {
    try {
      return (await this.run(worktreePath, ["show", `${oid}:${file}`], 16 * 1024 * 1024)).stdout;
    } catch {
      return null;
    }
  }

  async changedPaths(worktreePath: string): Promise<string[]> {
    const raw = (await this.run(worktreePath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"])).stdout;
    const entries = raw.split("\0").filter(Boolean);
    const paths: string[] = [];
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (entry.length < 4) continue;
      const status = entry.slice(0, 2);
      paths.push(entry.slice(3));
      if (/[RC]/.test(status) && entries[index + 1]) index += 1;
    }
    return [...new Set(paths)].sort();
  }

  async assertCurrentBranch(worktreePath: string, branchName: string): Promise<void> {
    const current = (await this.run(worktreePath, ["branch", "--show-current"])).stdout.trim();
    if (current !== branchName) {
      throw new Error(`현재 worktree 브랜치가 다릅니다: ${current || "detached"} (예상 ${branchName})`);
    }
  }

  private async assertGitRepository(repository: string): Promise<void> {
    const result = await this.runner.run({
      command: "git", args: ["rev-parse", "--show-toplevel"], cwd: repository,
    });
    if (result.exitCode !== 0) throw new Error(`Git 저장소가 아닙니다: ${repository}`);
  }

  private async assertNoActiveRepositoryHooks(cwd: string): Promise<void> {
    const configured = await this.runner.run({
      command: "git", args: ["config", "--path", "--get", "core.hooksPath"], cwd,
      maxOutputBytes: 1024 * 1024,
    });
    if (configured.exitCode !== 0 && configured.exitCode !== 1) {
      throw new Error(`Git hook 경로를 확인하지 못했습니다: ${configured.stderr || configured.stdout}`);
    }
    const common = await this.runner.run({
      command: "git", args: ["rev-parse", "--path-format=absolute", "--git-common-dir"], cwd,
      maxOutputBytes: 1024 * 1024,
    });
    if (common.exitCode !== 0) throw new Error(`Git 공용 디렉터리를 확인하지 못했습니다: ${common.stderr || common.stdout}`);
    const hookDirectory = configured.stdout.trim()
      ? resolve(cwd, configured.stdout.trim())
      : resolve(common.stdout.trim(), "hooks");
    let entries;
    try {
      entries = await readdir(hookDirectory, { withFileTypes: true });
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
      throw error;
    }
    const active: string[] = [];
    for (const entry of entries) {
      if (entry.name.endsWith(".sample") || (!entry.isFile() && !entry.isSymbolicLink())) continue;
      try {
        await access(resolve(hookDirectory, entry.name), constants.X_OK);
        active.push(entry.name);
      } catch { /* 실행 권한이 없으면 Git도 hook으로 실행하지 않는다. */ }
    }
    if (active.length > 0) {
      throw new Error(
        `저장소의 실행 가능한 Git hook은 승인과 별개로 명령을 실행할 수 있어 중단했습니다: ${active.sort().join(", ")}. ` +
        "필요한 검증은 별도 명령으로 실행한 뒤 hook이 없는 환경에서 전달하세요.",
      );
    }
  }

  private async run(cwd: string, args: string[], maxOutputBytes?: number, environment?: NodeJS.ProcessEnv) {
    const result = await this.runner.run({
      command: "git",
      args,
      cwd,
      maxOutputBytes: maxOutputBytes ?? 128 * 1024 * 1024,
      ...(environment ? { environment } : {}),
    });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} 실패: ${result.stderr || result.stdout}`);
    return result;
  }
}

export function normalizeCommitPaths(worktreePath: string, inputs: readonly string[]): string[] {
  return inputs.map((input) => validateScopedPath(worktreePath, input));
}

function validateScopedPath(worktreePath: string, input: string): string {
  if (!input.trim() || isAbsolute(input)) throw new Error(`잘못된 커밋 경로입니다: ${input}`);
  const target = resolve(worktreePath, input);
  const scope = relative(resolve(worktreePath), target);
  if (scope === "" || scope === ".." || scope.startsWith(`..${sep}`)) {
    throw new Error(`worktree 밖 경로는 커밋할 수 없습니다: ${input}`);
  }
  return scope;
}
