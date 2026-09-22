import { createHash } from "node:crypto";
import { lstat, readdir, readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";
import { ProjectMemoryReader } from "../src/server/projectMemory.js";
import { buildClaudePlanPrompt, buildCodexAuditPrompt } from "../src/shared/prompts.js";
import { z } from "zod";

// Only queries/labels/paths/hashes/counts are emitted. Never emit source contents or diagnostic excerpts.
const Case = z.object({
  id: z.string(), query: z.string(), required: z.array(z.string()), forbidden: z.array(z.string()),
  mode: z.enum(["raw", "plan", "audit"]).default("raw"),
  expectEmpty: z.boolean().default(false),
});
const args = process.argv.slice(2);
function argument(name: string): string | undefined { const at = args.indexOf(name); return at < 0 ? undefined : args[at + 1]; }
const rootArg = argument("--memory");
const casesArg = argument("--cases");
if (!rootArg || !casesArg) throw new Error("Usage: tsx scripts/evaluate-memory.ts --memory DIR --cases JSON [--reader baseline.ts]");
const root = resolve(rootArg);
const casesText = await readFile(casesArg, "utf8");
const cases = z.array(Case).min(1).parse(JSON.parse(casesText));
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
async function fingerprint(): Promise<string> {
  const entries: string[] = [];
  async function visit(directory: string, prefix: string) {
    for (const entry of (await readdir(directory)).sort()) {
      const path = join(directory, entry);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory() && (prefix !== "" || ["claude-only", "codex-only"].includes(entry))) {
        await visit(path, `${prefix}${entry}/`);
      }
      if (stat.isFile() && entry.endsWith(".md")) entries.push(`${prefix}${entry}:${hash(await readFile(path, "utf8"))}`);
    }
  }
  await visit(root, "");
  return hash(entries.join("\n"));
}
const before = await fingerprint();
const modulePath = argument("--reader");
const Reader: typeof ProjectMemoryReader = modulePath
  ? (await import(pathToFileURL(resolve(modulePath)).href)).ProjectMemoryReader : ProjectMemoryReader;
const reader = new Reader(root);
const results = [];
for (const item of cases) {
  let query = item.query;
  if (item.mode === "plan") query = buildClaudePlanPrompt({ title: query, worktreePath: "/tmp/example", sourceRepositoryPath: "/tmp/source", baseRef: "main", scopeGeneration: 1, timeline: [] });
  if (item.mode === "audit") query = buildCodexAuditPrompt({ title: query, planMarkdown: `# ${query}`, planSHA256: "a".repeat(64), scopeGeneration: 1, timeline: [] });
  for (const role of ["claude", "codex"] as const) {
    const snapshots = await reader.select(query, role);
    const paths = snapshots.map(s => s.path);
    const required = item.required.filter(path => !path.startsWith(`${role === "codex" ? "claude" : "codex"}-only/`));
    const missing = required.filter(path => !paths.includes(path));
    const forbidden = paths.filter(path => item.forbidden.includes(path));
    const unexpected = item.expectEmpty ? paths.filter(path => path !== "context-router.md") : [];
    results.push({ id: item.id, role, paths, missing, forbidden, required: required.length,
      unexpected, bytes: snapshots.reduce((sum, s) => sum + Buffer.byteLength(s.content), 0),
      pass: missing.length === 0 && forbidden.length === 0 && unexpected.length === 0 });
  }
}
const after = await fingerprint();
const comparable = before === after;
const required = results.reduce((sum, r) => sum + r.required, 0);
const missing = results.reduce((sum, r) => sum + r.missing.length, 0);
console.log(JSON.stringify({ corpusSHA256: before, casesSHA256: hash(casesText), comparable,
  summary: { cases: results.length, passed: results.filter(r => r.pass).length, required, missing,
    requiredRecall: required === 0 ? null : (required - missing) / required,
    forbidden: results.reduce((sum, r) => sum + r.forbidden.length, 0),
    unexpected: results.reduce((sum, r) => sum + r.unexpected.length, 0),
    totalBytes: results.reduce((sum, r) => sum + r.bytes, 0) }, results }, null, 2));
if (!comparable || results.some(r => !r.pass)) process.exitCode = 1;
