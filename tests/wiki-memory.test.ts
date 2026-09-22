import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ProjectMemoryReader, type MemoryEvidenceStatus, type MemoryReaderOptions } from "../src/server/projectMemory";

// Contract: buildPrompt/buildManifest -> adapter stdin. External source status must not change local
// document bytes/hash or silently certify a stale conclusion. The resolver reproduces success/failure;
// no model, UI, network, session authority, or iOS runtime is claimed by these tests.
const roots: string[] = [];
const dependency = { sourceId: "a".repeat(64), contentHash: "b".repeat(64) };
function fixture(block = JSON.stringify({ dependencies: [dependency] })) {
  const root = mkdtempSync(join(tmpdir(), "wiki-memory-")); roots.push(root);
  const content = `# Wiki guide\n\nVERIFIED-CONTENT\n\n\`\`\`wiki-evidence\n${block}\n\`\`\`\n`;
  writeFileSync(join(root, "context-router.md"), "# Router\n- [Wiki guide](wiki-guide.md)\n");
  writeFileSync(join(root, "MEMORY.md"), "# Index\n");
  writeFileSync(join(root, "wiki-guide.md"), content);
  return { root, content };
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("wiki source status at the prompt boundary", () => {
  it.each<MemoryEvidenceStatus>(["current", "changed", "unavailable", "missing"])("%s is visible without mutating the document", async status => {
    const { root, content } = fixture();
    const resolve = vi.fn(() => status);
    const reader = new ProjectMemoryReader(root, { resolveEvidenceStatus: resolve });
    const prompt = await reader.buildPrompt("wiki-guide", "claude");
    expect(prompt).toContain(`외부 근거: ${status}`);
    expect(prompt).toContain(content.trim());
    expect(prompt.indexOf("외부 근거:")).toBeLessThan(prompt.indexOf("메모리 문서 시작: wiki-guide.md"));
    expect(resolve).toHaveBeenCalledWith([dependency]);
    const snapshot = (await reader.select("wiki-guide", "claude"))[1];
    expect(snapshot.sha256).toBe(createHash("sha256").update(content).digest("hex"));
    expect(readFileSync(join(root, "wiki-guide.md"), "utf8")).toBe(content);
    const manifest = await reader.buildManifest("wiki-guide", "claude");
    expect(manifest).toContain(`외부 근거: ${status}`);
    expect(manifest).not.toContain("VERIFIED-CONTENT");
    expect(manifest).toContain(snapshot.sha256);
  });

  it("a subsequent failure does not reuse an earlier current result", async () => {
    const { root } = fixture();
    const resolver = vi.fn().mockResolvedValueOnce("current").mockRejectedValueOnce(new Error("unavailable"));
    const reader = new ProjectMemoryReader(root, { resolveEvidenceStatus: resolver });
    expect(await reader.buildPrompt("wiki-guide", "codex")).toContain("외부 근거: current");
    expect(await reader.buildManifest("wiki-guide", "codex")).toContain("외부 근거: unavailable");
  });

  it.each(["{}", "not-json", '{"dependencies":[]}', JSON.stringify({ dependencies: [{ ...dependency, contentHash: "bad" }] }), JSON.stringify({ dependencies: [dependency, dependency] })])("invalid dependency %s is not sent to the resolver", async block => {
    const { root } = fixture(block);
    const resolver = vi.fn(() => "current" as const);
    const prompt = await new ProjectMemoryReader(root, { resolveEvidenceStatus: resolver }).buildPrompt("wiki-guide", "codex");
    expect(prompt).toContain("외부 근거: unavailable");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("an unconfigured resolver cannot certify a source", async () => {
    const { root } = fixture();
    expect(await new ProjectMemoryReader(root).buildPrompt("wiki-guide", "codex")).toContain("외부 근거: unavailable");
  });

  it("legacy documents need no evidence block and never invoke the resolver", async () => {
    const { root } = fixture();
    writeFileSync(join(root, "wiki-guide.md"), "# Wiki guide\nLegacy content\n");
    const resolver = vi.fn(() => "current" as const);
    expect(await new ProjectMemoryReader(root, { resolveEvidenceStatus: resolver }).buildPrompt("wiki-guide", "codex")).toContain("Legacy content");
    expect(resolver).not.toHaveBeenCalled();
  });

  it("unclosed, duplicated and invalid runtime status stay unavailable", async () => {
    for (const suffix of ["\n```wiki-evidence\n", "\n```wiki-evidence\n{}\n```\n"]) {
      const { root, content } = fixture();
      writeFileSync(join(root, "wiki-guide.md"), content + suffix);
      const resolver = vi.fn(() => "current" as const);
      const prompt = await new ProjectMemoryReader(root, { resolveEvidenceStatus: resolver }).buildPrompt("wiki-guide", "codex");
      expect(prompt).toContain("외부 근거: unavailable");
      expect(resolver).not.toHaveBeenCalled();
    }
    const { root } = fixture();
    const options = { resolveEvidenceStatus: () => "unexpected" } as unknown as MemoryReaderOptions;
    expect(await new ProjectMemoryReader(root, options).buildPrompt("wiki-guide", "codex")).toContain("외부 근거: unavailable");
  });
});
