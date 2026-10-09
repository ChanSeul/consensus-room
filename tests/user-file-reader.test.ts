import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readUserFile, readMemoryFile, resolveUserPath, UserFileAccessBlocked } from "../src/server/userFileReader";
import { readAppliedInstructions, workerInstructionText } from "../src/server/projectInstructions";
import { ProjectMemoryReader } from "../src/server/projectMemory";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "user-file-read-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

it("filters explicitly marked operator instructions before bounds and preserves Codex override precedence", async () => {
  const dir = root(), global = join(dir, "global-AGENTS.md");
  writeFileSync(global, "REQUIRED_GLOBAL\n<!-- interactive-session-only: local workflow -->\n" + "x".repeat(40000));
  writeFileSync(join(dir, "AGENTS.md"), "BASE_RULE");
  writeFileSync(join(dir, "AGENTS.override.md"), "OVERRIDE_RULE\n<!-- interactive-session-only: local workflow -->\nOPERATOR_RULE");
  const result = await readAppliedInstructions({ workspace: dir, fileName: "AGENTS.md", globalPath: global,
    injectWorkspaceFile: true });
  expect(result.blocks.join("\n")).toContain("REQUIRED_GLOBAL");
  expect(result.blocks.join("\n")).toContain("OVERRIDE_RULE");
  expect(result.blocks.join("\n")).not.toContain("BASE_RULE");
  expect(result.blocks.join("\n")).not.toContain("OPERATOR_RULE");
  expect(result.blocks.join("\n")).not.toContain("[이하 생략");
  expect(workerInstructionText('Reference `<!-- interactive-session-only: example -->`\nUNMARKED_RULE')).toContain("UNMARKED_RULE");
  expect(workerInstructionText('```html\n<!-- interactive-session-only: example -->\n```\nUNMARKED_RULE')).toContain("UNMARKED_RULE");
});

// Public reader -> real filesystem -> prompt/memory consumers. FIFO reproduces a blocked open;
// resolving this Promise requires the child to close. This does not claim to grant TCC access.
it("ends a blocked open at its deadline and still reads the next file", async () => {
  const dir = root(), fifo = join(dir, "blocked");
  execFileSync("mkfifo", [fifo]);
  await expect(readUserFile(fifo, { timeoutMs: 100 })).rejects.toThrow(UserFileAccessBlocked);
  writeFileSync(join(dir, "next"), "next read succeeds");
  expect(await readUserFile(join(dir, "next"))).toBe("next read succeeds");
});

it("cancels a blocked instruction read instead of silently omitting it", async () => {
  const dir = root(), fifo = join(dir, "AGENTS.md");
  execFileSync("mkfifo", [fifo]);
  const signal = AbortSignal.timeout(150);
  await expect(readAppliedInstructions({ workspace: dir, fileName: "AGENTS.md", injectWorkspaceFile: true, signal }))
    .rejects.toMatchObject({ name: "TimeoutError" });
});

it("preserves allowed instruction symlinks and excludes symlinked memory documents", async () => {
  const dir = root(), text = join(dir, "real.md");
  writeFileSync(text, "Required rule"); symlinkSync(text, join(dir, "AGENTS.md"));
  expect((await readAppliedInstructions({ workspace: dir, fileName: "AGENTS.md", injectWorkspaceFile: true })).blocks.join("\n"))
    .toContain("Required rule");
  expect(await readMemoryFile(join(dir, "AGENTS.md"), 80_000)).toBeNull();
  expect(await readMemoryFile(text, 3)).toBeNull();
  expect(await readUserFile(join(dir, "missing"))).toBeNull();
  expect(await resolveUserPath(join(dir, "missing"))).toBeNull();
});

it("propagates already cancelled reads through every memory entry point", async () => {
  const reason = new Error("turn cancelled"), signal = AbortSignal.abort(reason);
  const reader = new ProjectMemoryReader(root());
  for (const read of [() => reader.select("task", "codex", signal), () => reader.index("codex", signal),
    () => reader.buildManifest("task", "codex", signal), () => reader.buildPrompt("task", "codex", signal)]) {
    await expect(read()).rejects.toBe(reason);
  }
});

// 10-05 1fd0cc86: brew 가 node keg 를 바꾸는 동안 리더 자식이 dyld 단계에서 SIGABRT 로 죽었다. 파일 접근 차단이 아니라 호스트 런타임 고장이고, 사유(stderr)가 남아야 한다.
it("classifies a reader runtime that dies before replying as a host runtime failure and keeps its stderr", async () => {
  const dir = root(), bin = root();
  writeFileSync(join(bin, "node"), "#!/bin/sh\necho 'dyld[1]: Library not loaded: /opt/homebrew/opt/simdjson/lib/libsimdjson.33.dylib' >&2\nkill -ABRT $$\n", { mode: 0o755 });
  writeFileSync(join(dir, "AGENTS.md"), "rule");
  // 리더는 읽을 때마다 PATH 의 node 를 띄운다(hostRuntime.ts) — PATH 앞에 가짜 런타임을 둔다.
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ""}`;
  let failure: unknown;
  try {
    failure = await readAppliedInstructions({ workspace: dir, fileName: "AGENTS.md", injectWorkspaceFile: true }).catch((error: unknown) => error);
  } finally {
    if (path === undefined) delete process.env.PATH; else process.env.PATH = path;
  }
  expect(failure).not.toBeInstanceOf(UserFileAccessBlocked);
  expect(failure).toMatchObject({ name: "HostRuntimeUnavailable" });
  expect((failure as Error).message).toContain("libsimdjson.33.dylib");
});
