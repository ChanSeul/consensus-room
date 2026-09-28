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
    const tree = await this.workingTreeOID(worktreePath);
    await this.run(worktreePath, ["update-ref", `refs/consensus/reviewed/${label}`, tree]);
    return tree;
  }

  // 작업 트리 전체(추적 안 된 파일 포함, 무시 규칙 적용)의 트리 OID — writeWorkingTree 와 같은 계산이되 ref 를 남기지 않는다. 합류 병합 준비의 멱등 판정·
  // 병합 커밋의 리뷰 트리 대조·허용 오차의 준비 트리 대비 변경 계산이 쓴다(엔진 개편 E4 보완 F001).
  async workingTreeOID(worktreePath: string): Promise<string> {
    return this.withTemporaryIndex(worktreePath, async (environment) => {
      await this.run(worktreePath, ["read-tree", "HEAD"], undefined, environment);
      await this.run(worktreePath, ["add", "-A", "--", "."], undefined, environment);
      return (await this.run(worktreePath, ["write-tree"], undefined, environment)).stdout.trim();
    });
  }

  // 합류 병합 준비(E4 보완 F001) — base 위에 targets 커밋을 순서대로 병합한 트리를 계산해 작업 트리에 **커밋 없이** 적용한다. 충돌 파일은 git 의 충돌
  // 표식을 담은 채 적용되고 이름을 돌려준다 — 러너가 해소하고 리뷰가 확인한 뒤, 인도 때 엔진이 부모 [기준, 합류 대상…] 병합 커밋을 만든다.
  //  - 병합 트리: mergeTree(아래). 작업 트리·index 불변.
  //  - 적용: 임시 index(HEAD 로 읽고 stat 갱신) 위에서 read-tree -m -u HEAD <트리> — HEAD·실제 index 는 그대로라 기존 가드(기준 HEAD 고정, staged 없음)가
  //    유지된다. 새 파일은 추적 안 된 파일로, 지운 파일은 작업 트리에서 빠진다.
  //  - 작업 트리가 이미 그 트리이면 아무것도 바꾸지 않는다. HEAD 가 base 가 아니거나 작업 트리가 깨끗한 base 도 결과 트리도 아니면 거부하고, 적용 뒤
  //    작업 트리 트리(무시 규칙 적용)가 결과 트리와 다르면(무시 규칙에 걸린 파일 등) 병합 결과를 온전히 재현할 수 없으므로 거부한다.
  //  - 준비 트리는 단계가 쓰는 동안(허용 오차 대조·재개·범위 변경) 계속 읽힌다. DB 의 OID 만으로는 객체가 GC 에서 살아남지 않으므로 리뷰 트리처럼 ref
  //    (refs/consensus/prepared/<tree>)로 잡는다(E4 2차 보완 F015). 수명도 리뷰 트리 ref 와 같다(지우지 않는다).
  async prepareMerge(worktreePath: string, base: string, targets: readonly string[]): Promise<{ tree: string; conflicts: string[] }> {
    await this.assertNoActiveRepositoryHooks(worktreePath);
    if (targets.length === 0) throw new Error("병합할 합류 대상이 없습니다.");
    if (await this.head(worktreePath) !== base) throw new Error("작업 트리 HEAD 가 단계 기준 커밋이 아니어서 합류 병합을 준비하지 않았습니다.");
    const baseTree = (await this.run(worktreePath, ["rev-parse", `${base}^{tree}`])).stdout.trim();
    const { tree, conflicts } = await this.mergeTree(worktreePath, base, targets);
    await this.run(worktreePath, ["update-ref", preparedRef(tree), tree]);
    const current = await this.workingTreeOID(worktreePath);
    if (current !== tree) {
      if (current !== baseTree) throw new Error("작업 트리가 단계 기준 커밋에서 바뀌어 합류 병합을 준비하지 않았습니다.");
      await this.withTemporaryIndex(worktreePath, async (environment) => {
        await this.run(worktreePath, ["read-tree", "HEAD"], undefined, environment);
        const refreshed = await this.runner.run({ command: "git", args: ["update-index", "-q", "--refresh"], cwd: worktreePath, environment });
        if (refreshed.exitCode !== 0 && refreshed.exitCode !== 1) throw new Error(`git update-index 실패: ${refreshed.stderr || refreshed.stdout}`);
        await this.run(worktreePath, ["read-tree", "-m", "-u", "HEAD", tree], undefined, environment);
      });
      if (await this.workingTreeOID(worktreePath) !== tree) {
        throw new Error("합류 병합 결과를 작업 트리에 온전히 재현하지 못했습니다(무시 규칙에 걸린 파일 등). 병합 준비를 중단합니다.");
      }
    }
    return { tree, conflicts };
  }

  // 준비 트리를 읽기 전에 부른다(E4 2차 보완 F015) — 객체가 있으면 ref 를 보장하고, ref 가 지워져 객체가 GC 된 경우에는 같은 기준·대상으로 병합 트리를
  // 다시 계산해(결정적) 기록된 트리와 같을 때만 ref 로 되살린다. 다르면 준비를 재현할 수 없으므로 던진다(다른 트리를 준비 트리로 쓰지 않는다).
  async ensurePreparedTree(worktreePath: string, base: string, targets: readonly string[], tree: string): Promise<void> {
    const present = await this.runner.run({ command: "git", args: ["cat-file", "-e", `${tree}^{tree}`], cwd: worktreePath, maxOutputBytes: 64 * 1024 });
    if (present.exitCode !== 0 && (await this.mergeTree(worktreePath, base, targets)).tree !== tree) {
      throw new Error(`합류 병합 준비 트리 ${tree} 가 저장소에 없고, 같은 기준·합류 대상으로 다시 계산한 트리도 다릅니다. 병합 준비를 재현할 수 없습니다.`);
    }
    await this.run(worktreePath, ["update-ref", preparedRef(tree), tree]);
  }

  // 병합 트리 계산(작업 트리·index·ref 불변) — merge-tree --write-tree. 둘째 대상부터는 앞 결과를 고정 신원·시각의 임시 병합 커밋(ref 없음)으로 만들어
  // 이어 병합한다 — 병합 기준을 git 이 계보로 계산하고, 다시 계산해도 같은 트리가 나온다(재시도·재생성 멱등).
  private async mergeTree(worktreePath: string, base: string, targets: readonly string[]): Promise<{ tree: string; conflicts: string[] }> {
    const conflicts = new Set<string>();
    const fixedIdentity = {
      ...process.env, GIT_AUTHOR_NAME: "Consensus Room", GIT_AUTHOR_EMAIL: "consensus-room@localhost", GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
      GIT_COMMITTER_NAME: "Consensus Room", GIT_COMMITTER_EMAIL: "consensus-room@localhost", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
    };
    let accumulated = base;
    let tree = "";
    for (const [index, target] of targets.entries()) {
      const merged = await this.runner.run({
        command: "git", args: ["merge-tree", "--write-tree", "--name-only", "-z", "--no-messages", accumulated, target],
        cwd: worktreePath, maxOutputBytes: 128 * 1024 * 1024,
      });
      if (merged.exitCode !== 0 && merged.exitCode !== 1) throw new Error(`git merge-tree 실패: ${merged.stderr || merged.stdout}`);
      const [treeOID, ...names] = merged.stdout.split("\0").filter(Boolean);
      if (!treeOID || !/^[a-f0-9]{40,64}$/.test(treeOID)) throw new Error("git merge-tree 가 병합 트리를 돌려주지 않았습니다.");
      if (merged.exitCode === 1) for (const name of names) conflicts.add(name);
      tree = treeOID;
      if (index < targets.length - 1) {
        accumulated = (await this.run(worktreePath, ["commit-tree", tree, "-p", accumulated, "-p", target, "-m", "consensus-room merge preparation"],
          undefined, fixedIdentity)).stdout.trim();
      }
    }
    return { tree, conflicts: [...conflicts].sort() };
  }

  // 합류 병합 커밋 객체를 만든다(ref·index·작업 트리 불변, hook 없음) — 호출자가 리뷰 트리·승인된 부모를 확인한 뒤 부른다. 브랜치 이동(moveBranch)과
  // index 정렬(resyncIndex)은 따로 부른다: 호출자가 커밋 OID 를 브랜치를 옮기기 **전에** 기록해, 그 뒤 어느 단계에서 멈춰도 복구가 그 OID 를 안다(F014).
  async writeMergeCommit(worktreePath: string, tree: string, parents: readonly string[], message: string): Promise<string> {
    if (parents.length < 2) throw new Error("병합 커밋에는 기준과 합류 대상이 하나 이상 있어야 합니다.");
    return (await this.run(worktreePath, ["commit-tree", tree, ...parents.flatMap((parent) => ["-p", parent]), "-m", message])).stdout.trim();
  }

  // 브랜치를 expectedHead 에서만 oid 로 옮긴다(update-ref 세 인자). 옮기기 전 index 에 stage 된 변경이 없어야 한다(엔진 전달의 불변식). index·작업 트리는
  // 건드리지 않는다 — 정렬은 resyncIndex.
  async moveBranch(worktreePath: string, branchName: string, oid: string, expectedHead: string): Promise<void> {
    await this.assertNoActiveRepositoryHooks(worktreePath);
    await this.assertCurrentBranch(worktreePath, branchName);
    const staged = await this.run(worktreePath, ["diff", "--cached", "--name-only", "-z"]);
    if (staged.stdout.trim()) throw new Error("이미 stage된 변경이 있어 안전하게 커밋할 수 없습니다.");
    await this.run(worktreePath, ["update-ref", `refs/heads/${branchName}`, oid, expectedHead]);
  }

  // 두 트리 사이 한 파일의 문맥 0줄 패치 — 합류 준비 트리 대비 허용 오차 대조(E4 보완 F001).
  async treeFileDiff(worktreePath: string, fromTree: string, toTree: string, file: string): Promise<string> {
    return (await this.run(worktreePath, ["diff-tree", "-r", "-p", "-U0", "--no-color", "--no-renames", fromTree, toTree, "--", file], 16 * 1024 * 1024)).stdout;
  }

  private async withTemporaryIndex<T>(worktreePath: string, work: (environment: NodeJS.ProcessEnv) => Promise<T>): Promise<T> {
    const gitDirectory = (await this.run(worktreePath, ["rev-parse", "--absolute-git-dir"])).stdout.trim();
    const indexFile = resolve(gitDirectory, `consensus-index-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    try {
      return await work({ ...process.env, GIT_INDEX_FILE: indexFile });
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

  // ref(커밋 OID·브랜치·태그 등)를 커밋 OID 로 해석한다 — 작업 묶음의 명시 기준 커밋. 커밋이 아니거나 없으면 던진다. '-' 로 시작하는 입력은
  // 호출 전 스키마가 막는다(옵션 해석 방지).
  async resolveCommit(repositoryPath: string, ref: string): Promise<string> {
    return (await this.run(repositoryPath, ["rev-parse", "--verify", `${ref}^{commit}`])).stdout.trim();
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

  // ancestor 가 descendant 의 조상(또는 같은 커밋)인가 — 작업 묶음 단계 결과의 계보 확인(엔진 개편 E4). 부모를 거슬러 걷는 대신
  // merge-base --is-ancestor 로 판정한다: 비후손이면 저장소 전체 이력을 걷거나 임의 상한으로 거부해야 하기 때문이다. 종료 코드 1 은
  // "조상 아님", 그 밖의 실패(없는 커밋 등)는 판정할 수 없으므로 던진다.
  async isAncestor(worktreePath: string, ancestor: string, descendant: string): Promise<boolean> {
    const result = await this.runner.run({
      command: "git", args: ["merge-base", "--is-ancestor", ancestor, descendant], cwd: worktreePath, maxOutputBytes: 64 * 1024,
    });
    if (result.exitCode === 0) return true;
    if (result.exitCode === 1) return false;
    throw new Error(`git merge-base 실패: ${result.stderr || result.stdout}`);
  }

  // 병합 커밋(엔진의 합류 병합 커밋)은 첫 부모 대비 경로다 — 기본 diff-tree 는 병합 커밋에 아무 경로도 내지 않는다. 일반 커밋은 그대로다.
  async commitChangedPaths(worktreePath: string, oid: string): Promise<string[]> {
    return (await this.run(
      worktreePath,
      ["diff-tree", "--diff-merges=first-parent", "--no-renames", "--no-commit-id", "--name-only", "-r", "-z", oid, "--"],
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

// 합류 병합 준비 트리의 보존 ref(F015) — 트리 OID 로 이름 짓는다(같은 준비는 같은 ref, 범위 변경 재준비·재생성도 멱등).
function preparedRef(tree: string): string {
  return `refs/consensus/prepared/${tree}`;
}
