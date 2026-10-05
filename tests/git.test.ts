import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GitService, normalizeCommitPaths } from "../src/server/git";
import { SpawnCommandRunner } from "../src/server/processRunner";
import type { CommandSpec } from "../src/server/types";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function makeRepository(): string {
  const repository = mkdtempSync(join(tmpdir(), "consensus-room-git-"));
  temporaryDirectories.push(repository);
  git(repository, ["init", "--initial-branch=develop"]);
  git(repository, ["config", "user.name", "Consensus Room Test"]);
  git(repository, ["config", "user.email", "consensus-room@example.invalid"]);
  writeFileSync(join(repository, "owned.txt"), "처음\n");
  writeFileSync(join(repository, "unrelated.txt"), "처음\n");
  git(repository, ["add", "--", "owned.txt", "unrelated.txt"]);
  git(repository, ["commit", "-m", "baseline"]);
  return repository;
}

it("isolates Git cancellation across parallel action contexts and later requests", async () => {
  const controllers = [new AbortController(), new AbortController()];
  const pending = new Map<string, { spec: CommandSpec; finish: () => void }>();
  const service = new GitService({ run: spec => new Promise((resolve, reject) => {
    pending.set(spec.cwd, { spec, finish: () => resolve({ exitCode: 0, stdout: spec.cwd, stderr: "", jsonLines: [] }) });
    spec.signal?.addEventListener("abort", () => reject(spec.signal!.reason), { once: true });
  }) });
  const first = service.withSignal(controllers[0].signal, () => service.head("first"));
  const second = service.withSignal(controllers[1].signal, () => service.head("second"));
  const rejected = expect(first).rejects.toThrow("first stopped");
  controllers[0].abort(new Error("first stopped"));
  pending.get("second")!.finish();
  await rejected;
  expect(await second).toBe("second");
  expect(pending.get("second")!.spec.signal?.aborted).toBe(false);
  const later = service.head("later");
  expect(pending.get("later")!.spec.signal).toBeUndefined();
  pending.get("later")!.finish();
  expect(await later).toBe("later");
});

describe("전용 worktree", () => {
  it("구현을 승인하면 기준 리비전에서 detached worktree를 만들고 그 안에서만 브랜치를 만든다", async () => {
    const repository = makeRepository();
    const worktree = `${repository}-worktree`;
    temporaryDirectories.push(worktree);
    const service = new GitService(new SpawnCommandRunner());

    await service.createDetachedWorktree(repository, worktree, "develop");

    expect(() => git(worktree, ["symbolic-ref", "--short", "HEAD"])).toThrow();
    await service.createBranch(worktree, "consensus/cancel-review-ab12");
    expect(git(worktree, ["branch", "--show-current"])).toBe("consensus/cancel-review-ab12");
  });

  it("실행 가능한 저장소 hook이 있으면 topic worktree를 만들기 전에 중단한다", async () => {
    const repository = makeRepository();
    const marker = join(repository, "hook-ran.txt");
    const hook = join(repository, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    const service = new GitService(new SpawnCommandRunner());

    await expect(service.createDetachedWorktree(
      repository, `${repository}-worktree`, "develop",
    )).rejects.toThrow("실행 가능한 Git hook");

    expect(() => readFileSync(marker, "utf8")).toThrow();
  });
});

describe("범위를 고른 커밋", () => {
  it("사용자가 한 파일만 커밋하면 다른 세션의 수정은 stage하거나 되돌리지 않는다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "owned.txt"), "내 변경\n");
    writeFileSync(join(repository, "unrelated.txt"), "다른 세션 변경\n");
    const service = new GitService(new SpawnCommandRunner());

    const commit = await service.commit(repository, "develop", "선택한 변경", ["owned.txt"]);

    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    expect(git(repository, ["show", "--pretty=format:", "--name-only", "HEAD"])).toBe("owned.txt");
    expect(git(repository, ["status", "--porcelain"])).toBe("M unrelated.txt");
    expect(readFileSync(join(repository, "unrelated.txt"), "utf8")).toBe("다른 세션 변경\n");
  });

  it("비ASCII 파일명을 골라도 선택 범위 검증을 통과해 그 파일만 커밋한다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "한글파일.txt"), "처음\n");
    git(repository, ["add", "--", "한글파일.txt"]);
    git(repository, ["commit", "-m", "비ASCII 파일 추가"]);
    writeFileSync(join(repository, "한글파일.txt"), "내 변경\n");
    writeFileSync(join(repository, "unrelated.txt"), "다른 세션 변경\n");
    const service = new GitService(new SpawnCommandRunner());

    const commit = await service.commit(repository, "develop", "선택한 변경", ["한글파일.txt"]);

    expect(commit).toMatch(/^[a-f0-9]{40}$/);
    expect(git(repository, ["show", "--pretty=format:", "--name-only", "-z", "HEAD"])
      .split("\0").filter(Boolean)).toEqual(["한글파일.txt"]);
    expect(readFileSync(join(repository, "unrelated.txt"), "utf8")).toBe("다른 세션 변경\n");
  });

  it("검토한 파일 rename을 그대로 커밋해도 같은 변경 스냅샷으로 확인한다", async () => {
    const repository = makeRepository();
    const service = new GitService(new SpawnCommandRunner());
    const baseline = await service.head(repository);
    renameSync(join(repository, "owned.txt"), join(repository, "renamed.txt"));
    const reviewed = await service.snapshot(repository);

    const commit = await service.commit(
      repository,
      "develop",
      "파일 이름 변경",
      ["owned.txt", "renamed.txt"],
    );
    const committed = await service.snapshot(repository, baseline);

    expect(commit).not.toBe(baseline);
    expect(committed.diffSHA256).toBe(reviewed.diffSHA256);
    expect(await service.commitChangedPaths(repository, commit)).toEqual(["owned.txt", "renamed.txt"]);
  });

  it("파일 rename과 원본을 남긴 copy는 같은 스냅샷으로 취급하지 않는다", async () => {
    const repository = makeRepository();
    const service = new GitService(new SpawnCommandRunner());
    renameSync(join(repository, "owned.txt"), join(repository, "renamed.txt"));
    const renamed = await service.snapshot(repository);
    git(repository, ["restore", "--", "owned.txt"]);
    rmSync(join(repository, "renamed.txt"));
    copyFileSync(join(repository, "owned.txt"), join(repository, "renamed.txt"));

    const copied = await service.snapshot(repository);

    expect(copied.diffSHA256).not.toBe(renamed.diffSHA256);
  });

  it("커밋 hook이 있으면 승인만으로 hook이나 커밋을 실행하지 않는다", async () => {
    const repository = makeRepository();
    const marker = join(repository, "hook-ran.txt");
    const hook = join(repository, ".git", "hooks", "post-commit");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);
    writeFileSync(join(repository, "owned.txt"), "검토한 변경\n");
    const before = git(repository, ["rev-parse", "HEAD"]);
    const service = new GitService(new SpawnCommandRunner());

    await expect(service.commit(repository, "develop", "선택한 변경", ["owned.txt"]))
      .rejects.toThrow("실행 가능한 Git hook");

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(before);
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it("이미 다른 파일이 stage되어 있으면 새 커밋을 만들지 않는다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "owned.txt"), "내 변경\n");
    writeFileSync(join(repository, "unrelated.txt"), "이미 stage된 변경\n");
    git(repository, ["add", "--", "unrelated.txt"]);
    const before = git(repository, ["rev-parse", "HEAD"]);
    const service = new GitService(new SpawnCommandRunner());

    await expect(service.commit(repository, "develop", "선택한 변경", ["owned.txt"])).rejects.toThrow(
      "이미 stage된 변경",
    );

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("unrelated.txt");
  });

  it("사용자가 worktree 밖 경로를 고르면 git add를 실행하기 전에 거부한다", async () => {
    const repository = makeRepository();
    const before = git(repository, ["rev-parse", "HEAD"]);
    const service = new GitService(new SpawnCommandRunner());

    await expect(service.commit(repository, "develop", "범위 밖", ["../outside.txt"])).rejects.toThrow(
      "worktree 밖 경로",
    );

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(before);
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("");
  });
});

describe("커밋 경로 정규화", () => {
  it("호출부가 사후 검증에 쓸 수 있도록 stage 전과 같은 정규화 결과를 돌려준다", () => {
    expect(normalizeCommitPaths("/repo", ["./feature.txt", "a/../feature.txt", "src/nested/x.ts"]))
      .toEqual(["feature.txt", "feature.txt", "src/nested/x.ts"]);
  });

  it("빈 경로·절대경로·worktree 밖 경로는 stage 전과 같은 이유로 거부한다", () => {
    expect(() => normalizeCommitPaths("/repo", ["   "])).toThrow("잘못된 커밋 경로");
    expect(() => normalizeCommitPaths("/repo", ["/abs/path"])).toThrow("잘못된 커밋 경로");
    expect(() => normalizeCommitPaths("/repo", ["../escape"])).toThrow("worktree 밖 경로");
    expect(() => normalizeCommitPaths("/repo", ["."])).toThrow("worktree 밖 경로");
  });

  it("./ 접두 경로로 커밋해도 정규화 결과와 실제 커밋 경로가 그대로 대조된다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "owned.txt"), "내 변경\n");
    const service = new GitService(new SpawnCommandRunner());

    const commit = await service.commit(repository, "develop", "선택한 변경", ["./owned.txt"]);

    expect(await service.commitChangedPaths(repository, commit))
      .toEqual(normalizeCommitPaths(repository, ["./owned.txt"]));
  });
});

describe("고아 커밋 되돌리기", () => {
  it("HEAD만 되돌리고 작업 트리 내용은 남긴 채 index를 커밋 직전 상태로 만든다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "owned.txt"), "내 변경\n");
    const service = new GitService(new SpawnCommandRunner());
    const before = git(repository, ["rev-parse", "HEAD"]);
    const orphan = await service.commit(repository, "develop", "사후 검증에서 거부될 커밋", ["owned.txt"]);

    await service.resetToCommit(repository, "develop", before, orphan);

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(before);
    expect(readFileSync(join(repository, "owned.txt"), "utf8")).toBe("내 변경\n");
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("");
    expect(git(repository, ["status", "--porcelain"])).toBe("M owned.txt");
    expect(git(repository, ["cat-file", "-t", orphan])).toBe("commit");
  });

  it("실행 가능한 저장소 hook이 있으면 HEAD를 되돌리지 않는다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "owned.txt"), "내 변경\n");
    const service = new GitService(new SpawnCommandRunner());
    const before = git(repository, ["rev-parse", "HEAD"]);
    await service.commit(repository, "develop", "사후 검증에서 거부될 커밋", ["owned.txt"]);
    const orphan = git(repository, ["rev-parse", "HEAD"]);
    const marker = join(repository, "hook-ran.txt");
    const hook = join(repository, ".git", "hooks", "post-checkout");
    writeFileSync(hook, `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`);
    chmodSync(hook, 0o755);

    await expect(service.resetToCommit(repository, "develop", before, orphan))
      .rejects.toThrow("실행 가능한 Git hook");

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(orphan);
    expect(() => readFileSync(marker, "utf8")).toThrow();
  });

  it("확인한 뒤 HEAD가 움직였으면 되돌리지 않는다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "owned.txt"), "내 변경\n");
    const service = new GitService(new SpawnCommandRunner());
    const before = git(repository, ["rev-parse", "HEAD"]);
    const observed = await service.commit(repository, "develop", "호출부가 확인한 커밋", ["owned.txt"]);
    writeFileSync(join(repository, "owned.txt"), "그 뒤에 또 바뀐 내용\n");
    await service.commit(repository, "develop", "확인 뒤에 끼어든 커밋", ["owned.txt"]);
    const moved = git(repository, ["rev-parse", "HEAD"]);

    await expect(service.resetToCommit(repository, "develop", before, observed)).rejects.toThrow();

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(moved);
  });

  it("현재 브랜치가 되돌릴 브랜치와 다르면 HEAD를 되돌리지 않는다", async () => {
    const repository = makeRepository();
    writeFileSync(join(repository, "owned.txt"), "내 변경\n");
    const service = new GitService(new SpawnCommandRunner());
    const before = git(repository, ["rev-parse", "HEAD"]);
    await service.commit(repository, "develop", "사후 검증에서 거부될 커밋", ["owned.txt"]);
    const orphan = git(repository, ["rev-parse", "HEAD"]);

    await expect(service.resetToCommit(repository, "consensus/other-branch", before, orphan))
      .rejects.toThrow("현재 worktree 브랜치가 다릅니다");

    expect(git(repository, ["rev-parse", "HEAD"])).toBe(orphan);
  });
});


// 감사 ⑦: 같은 이름의 브랜치가 이미 있으면 기존 브랜치로 switch돼 detached 기준 리비전이 버려졌다.
describe("브랜치 이름 충돌", () => {
  it("요청한 브랜치가 이미 있으면 기준 리비전을 버리지 않고 실패한다", async () => {
    const repository = makeRepository();
    git(repository, ["branch", "refactoring/DUP-1"]); // 오래된 동명 브랜치
    writeFileSync(join(repository, "owned.txt"), "새 기준\n");
    git(repository, ["add", "--", "owned.txt"]);
    git(repository, ["commit", "-m", "new base"]);
    const service = new GitService(new SpawnCommandRunner());
    const worktree = join(repository, "..", `${Math.random().toString(36).slice(2)}-worktree`);
    temporaryDirectories.push(worktree);
    await service.createDetachedWorktree(repository, worktree, "develop");
    const baseline = git(worktree, ["rev-parse", "HEAD"]);

    await expect(service.createBranch(worktree, "refactoring/DUP-1"))
      .rejects.toThrow("이미 존재합니다");
    // 기준 HEAD가 옛 브랜치 HEAD로 바뀌지 않았어야 한다.
    expect(git(worktree, ["rev-parse", "HEAD"])).toBe(baseline);
  });

  it("현재 worktree가 이미 그 브랜치면 재시도로 허용한다", async () => {
    const repository = makeRepository();
    const service = new GitService(new SpawnCommandRunner());
    const worktree = join(repository, "..", `${Math.random().toString(36).slice(2)}-worktree2`);
    temporaryDirectories.push(worktree);
    await service.createDetachedWorktree(repository, worktree, "develop");
    await service.createBranch(worktree, "refactoring/RETRY-1");

    await expect(service.createBranch(worktree, "refactoring/RETRY-1")).resolves.toBeUndefined();
  });
});

// 2026-09-07 Codex 피드백 ①: 최종 리뷰에 "직전 리뷰 이후 변경분" 을 주기 위한 리뷰 시점 트리 스냅샷.
describe("리뷰 시점 트리 스냅샷", () => {
  it("writeWorkingTree 는 index·worktree 를 건드리지 않고 트리를 남기며, diffTrees 는 그 사이 변경만 준다", async () => {
    const repository = makeRepository();
    const service = new GitService(new SpawnCommandRunner());
    writeFileSync(join(repository, "owned.txt"), "첫 리뷰\n");
    writeFileSync(join(repository, "new.txt"), "추가\n");

    const first = await service.writeWorkingTree(repository, "t1-first");

    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe(""); // 실제 index 그대로
    expect(git(repository, ["status", "--porcelain"])).toContain("?? new.txt"); // untracked 그대로
    expect(git(repository, ["rev-parse", "refs/consensus/reviewed/t1-first"])).toBe(first);

    writeFileSync(join(repository, "owned.txt"), "수정 뒤\n");
    const second = await service.writeWorkingTree(repository, "t1-final");
    const delta = await service.diffTrees(repository, first, second);

    expect(delta.files).toEqual(["owned.txt"]);
    expect(delta.patch).toContain("+수정 뒤");
    expect(delta.patch).not.toContain("new.txt");
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("");
  });
});

// 엔진 개편 E4 보완(F001) — 합류 병합은 엔진이 준비하고(작업 트리에 커밋 없이), 인도 때 엔진이 리뷰 트리·승인된 부모로 병합 커밋을 만든다.
describe("합류 병합 준비와 병합 커밋", () => {
  // develop(기준) 에서 갈라진 두 결과 A(owned.txt 수정·a.txt 추가)와 B(unrelated.txt 삭제·b.txt 추가, conflict 이면 owned.txt 도 수정).
  function divergedResults(conflict: boolean) {
    const repository = makeRepository();
    const base = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["switch", "-c", "result-a"]);
    writeFileSync(join(repository, "owned.txt"), "A 결과\n");
    writeFileSync(join(repository, "a.txt"), "A\n");
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-m", "A"]);
    const a = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["switch", "--detach", base]);
    git(repository, ["switch", "-c", "result-b"]);
    if (conflict) writeFileSync(join(repository, "owned.txt"), "B 결과\n");
    writeFileSync(join(repository, "b.txt"), "B\n");
    git(repository, ["rm", "-q", "unrelated.txt"]);
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-m", "B"]);
    const b = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["switch", "--detach", a]);
    return { repository, base, a, b };
  }

  it("충돌 없는 합류를 작업 트리에 커밋 없이 적용하고 HEAD·index 는 그대로 둔다 — 다시 불러도 같은 트리로 멈춘다", async () => {
    const { repository, a, b } = divergedResults(false);
    const service = new GitService(new SpawnCommandRunner());
    const prepared = await service.prepareMerge(repository, a, [b]);
    expect(prepared.conflicts).toEqual([]);
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(a);
    expect(git(repository, ["diff", "--cached", "--name-only"])).toBe("");
    expect(readFileSync(join(repository, "b.txt"), "utf8")).toBe("B\n");
    expect(git(repository, ["ls-files", "--deleted"])).toBe("unrelated.txt");
    expect(git(repository, ["ls-files", "--others", "--exclude-standard"])).toBe("b.txt");
    expect(await service.workingTreeOID(repository)).toBe(prepared.tree);
    // 멱등: 이미 준비된 작업 트리는 바꾸지 않는다.
    expect(await service.prepareMerge(repository, a, [b])).toEqual(prepared);
  });

  it("충돌은 표식을 담은 채 적용하고 파일 이름을 돌려준다 — 기준에서 바뀐 작업 트리·다른 HEAD 에서는 준비하지 않는다", async () => {
    const { repository, a, b } = divergedResults(true);
    const service = new GitService(new SpawnCommandRunner());
    writeFileSync(join(repository, "stray.txt"), "러너가 먼저 쓴 파일\n");
    await expect(service.prepareMerge(repository, a, [b])).rejects.toThrow("작업 트리가 단계 기준 커밋에서 바뀌어");
    rmSync(join(repository, "stray.txt"));
    await expect(service.prepareMerge(repository, b, [a])).rejects.toThrow("단계 기준 커밋이 아니어서");
    const prepared = await service.prepareMerge(repository, a, [b]);
    expect(prepared.conflicts).toEqual(["owned.txt"]);
    expect(readFileSync(join(repository, "owned.txt"), "utf8")).toMatch(/^<<<<<<< [\s\S]*A 결과[\s\S]*=======[\s\S]*B 결과[\s\S]*>>>>>>> /);
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(a);
  });

  it("여러 합류 대상을 차례로 병합하고, 리뷰한 트리·승인된 부모로 병합 커밋을 만든다 — 첫 부모 대비 경로를 돌려준다", async () => {
    const { repository, base, a, b } = divergedResults(false);
    git(repository, ["switch", "--detach", base]);
    git(repository, ["switch", "-c", "result-c"]);
    writeFileSync(join(repository, "c.txt"), "C\n");
    git(repository, ["add", "-A"]);
    git(repository, ["commit", "-m", "C"]);
    const c = git(repository, ["rev-parse", "HEAD"]);
    git(repository, ["switch", "--detach", a]);
    git(repository, ["switch", "-c", "stage"]);
    const service = new GitService(new SpawnCommandRunner());
    const prepared = await service.prepareMerge(repository, a, [b, c]);
    expect(prepared.conflicts).toEqual([]);
    writeFileSync(join(repository, "stage.txt"), "이 단계 변경\n");
    const reviewed = await service.workingTreeOID(repository);
    await expect(service.writeMergeCommit(repository, reviewed, [a], "합류")).rejects.toThrow("합류 대상이 하나 이상");
    const merge = await service.writeMergeCommit(repository, reviewed, [a, b, c], "합류 병합");
    // 커밋 객체만 만들었다 — 브랜치·index 는 그대로다(호출자가 OID 를 기록한 뒤 옮긴다).
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(a);
    await expect(service.moveBranch(repository, "stage", merge, b)).rejects.toThrow();
    await service.moveBranch(repository, "stage", merge, a);
    // 브랜치만 옮겼다 — index 는 옛 HEAD 라 정렬 전에는 변경이 보인다.
    expect(git(repository, ["status", "--porcelain"])).not.toBe("");
    await service.resyncIndex(repository, "stage");
    expect(await service.commitParents(repository, merge)).toEqual([a, b, c]);
    expect(git(repository, ["rev-parse", "HEAD^{tree}"])).toBe(reviewed);
    expect(git(repository, ["status", "--porcelain"])).toBe("");
    expect(await service.commitChangedPaths(repository, merge)).toEqual(["b.txt", "c.txt", "stage.txt", "unrelated.txt"]);
    // 일반 커밋은 기존과 같다.
    expect(await service.commitChangedPaths(repository, b)).toEqual(["b.txt", "unrelated.txt"]);
  });

  it("병합 커밋은 기대한 HEAD 에서만 브랜치를 옮기고 stage 된 변경이 있으면 옮기지 않는다", async () => {
    const { repository, a, b } = divergedResults(false);
    git(repository, ["switch", "-c", "stage"]);
    const service = new GitService(new SpawnCommandRunner());
    const prepared = await service.prepareMerge(repository, a, [b]);
    const merge = await service.writeMergeCommit(repository, prepared.tree, [a, b], "합류");
    git(repository, ["add", "b.txt"]);
    await expect(service.moveBranch(repository, "stage", merge, a)).rejects.toThrow("이미 stage된 변경");
    git(repository, ["restore", "--staged", "b.txt"]);
    await expect(service.moveBranch(repository, "stage", merge, b)).rejects.toThrow();
    expect(git(repository, ["rev-parse", "HEAD"])).toBe(a);
  });

  // E4 2차 보완 F015 — 준비 트리는 DB 의 OID 만으로는 GC 에서 살아남지 않는다. ref 로 잡고, ref 가 지워져 사라졌으면 같은 기준·대상으로 다시 만든다.
  it("준비 트리를 ref 로 보존해 GC 뒤에도 읽고, ref 가 지워져 사라진 트리는 다시 계산해 같은 트리일 때만 되살린다", async () => {
    const { repository, a, b } = divergedResults(true);
    const service = new GitService(new SpawnCommandRunner());
    const prepared = await service.prepareMerge(repository, a, [b]);
    const ref = `refs/consensus/prepared/${prepared.tree}`;
    expect(git(repository, ["rev-parse", ref])).toBe(prepared.tree);
    const collect = () => { git(repository, ["reflog", "expire", "--expire=now", "--all"]); git(repository, ["gc", "--prune=now", "--quiet"]); };
    const present = () => { try { git(repository, ["cat-file", "-e", `${prepared.tree}^{tree}`]); return true; } catch { return false; } };
    collect();
    expect(present()).toBe(true);
    // ref 를 지우고 GC 하면 준비 트리가 사라진다(작업 트리·index 는 이 트리를 가리키지 않는다).
    git(repository, ["update-ref", "-d", ref]);
    collect();
    expect(present()).toBe(false);
    await service.ensurePreparedTree(repository, a, [b], prepared.tree);
    expect(present()).toBe(true);
    expect(git(repository, ["rev-parse", ref])).toBe(prepared.tree);
    // 되살린 트리 대비로 변경 파일을 수집한다(허용 오차 대조의 계산) — 사라진 트리였다면 이 diff 가 git 오류로 끊겼다.
    writeFileSync(join(repository, "resolved.txt"), "해소\n");
    expect((await service.diffTrees(repository, prepared.tree, await service.workingTreeOID(repository))).files).toEqual(["resolved.txt"]);
    // 다른 트리를 준비 트리로 주장하면(재계산과 다르면) 되살리지 않는다.
    await expect(service.ensurePreparedTree(repository, a, [b], "0".repeat(40))).rejects.toThrow("병합 준비를 재현할 수 없습니다");
  });
});
