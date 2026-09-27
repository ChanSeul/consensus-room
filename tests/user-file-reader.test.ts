import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readUserFile, readMemoryFile, resolveUserPath, UserFileAccessBlocked } from "../src/server/userFileReader";
import { readAppliedInstructions } from "../src/server/projectInstructions";
import { ProjectMemoryReader } from "../src/server/projectMemory";

const roots: string[] = [];
const root = () => { const path = mkdtempSync(join(tmpdir(), "user-file-read-")); roots.push(path); return path; };
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

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
