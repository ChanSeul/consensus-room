import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import { PLANNING_LIMITS, PlanningPaused, type PlanningFragment, type PlanningRead } from "../shared/planningControl.js";
import { planningHash } from "./planningStore.js";

const execute = promisify(execFile);
// Malformed offsets and directory-as-file requests are correctable. Access failures remain hard stops.
export class InvalidPlanningOffset extends PlanningPaused {
  constructor() { super("Invalid UTF-8 continuation offset; reuse the returned nextOffset, or start at offset 0. Do not guess byte offsets."); }
}
export class PlanningDirectoryRead extends PlanningPaused {
  constructor() { super("Requested path is a directory, not file evidence. Request a regular file inside it or use a path::literal search."); }
}
export function utf8Slice(text: string, offset: number, limit: number): { text: string; next: number | null } {
  const bytes = Buffer.from(text);
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
    throw new InvalidPlanningOffset();
  }
  let end = Math.min(bytes.length, offset + limit);
  while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(offset, end).toString("utf8"), next: end < bytes.length ? end : null };
}

function safeSelector(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..") ||
      path.split("/").some(p => p === ".git" || p.startsWith(".env") || /^(credentials|auth)\.json$/.test(p))) {
    throw new PlanningPaused("Planning reads must stay in the approved snapshot and exclude credential paths.");
  }
}

export class PlanningReader {
  constructor(private readonly root: string, private readonly tree: string,
    readonly documents: ReadonlyMap<string, string>) {
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("Invalid snapshot tree");
  }
  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execute("git", args, { cwd: this.root, maxBuffer: 2 * 1024 * 1024,
        timeout: 10_000, encoding: "utf8" });
      return stdout;
    } catch (error) {
      if ((error as { code?: number }).code === 1 && args[0] === "grep") return "";
      throw new PlanningPaused("Snapshot read unavailable or too large; narrow the requested path or search.");
    }
  }
  async read(request: PlanningRead): Promise<PlanningFragment> {
    if (request.kind === "image") throw new PlanningPaused("Images must use the pinned evidence image broker.");
    let text: string;
    if (["context", "memory", "evidence", "artifact"].includes(request.kind)) {
      const value = this.documents.get(`${request.kind}:${request.selector}`);
      if (value === undefined) throw new PlanningPaused("Requested source is not in the pinned manifest.");
      text = value;
    } else if (request.kind === "search" && request.selector.startsWith("evidence::")) {
      const needle = request.selector.slice("evidence::".length).trim().toLocaleLowerCase();
      if (!needle) throw new PlanningPaused("Evidence search literal is empty.");
      text = [...this.documents].filter(([key, body]) => key.startsWith("evidence:") && `${key}\n${body}`.toLocaleLowerCase().includes(needle))
        .map(([key, body]) => {
          const at = Math.max(0, body.toLocaleLowerCase().indexOf(needle) - 120);
          return JSON.stringify({ selector: key.slice("evidence:".length), hash: planningHash(body), excerpt: body.slice(at, at + 800) });
        }).join("\n");
    } else if (request.kind === "file") {
      safeSelector(request.selector);
      const path = posix.normalize(request.selector);
      const lookupPath = path.replace(/\/$/, "");
      if (lookupPath === ".") throw new PlanningDirectoryRead();
      const entries = (await this.git(["ls-tree", "-z", this.tree, "--", lookupPath])).split("\0");
      const entry = entries.length === 2 && entries[1] === "" ? entries[0]! : "";
      const entryPath = entry.slice(entry.indexOf("\t") + 1);
      if (/^040000 tree [a-f0-9]+\t/.test(entry) && entryPath === lookupPath) {
        throw new PlanningDirectoryRead();
      }
      if (!/^100[0-7]{3} blob [a-f0-9]+\t/.test(entry) || entryPath !== path) {
        throw new PlanningPaused("Only regular files in the pinned tree may be read.");
      }
      text = await this.git(["show", `${this.tree}:${path}`]);
      if (text.includes("\0")) throw new PlanningPaused("Binary files require a separately approved visual source.");
    } else {
      const split = request.selector.indexOf("::");
      if (split < 1) throw new PlanningPaused("Search selector must be path::literal (use . for repository root).");
      const path = request.selector.slice(0, split), needle = request.selector.slice(split + 2);
      safeSelector(path);
      if (!needle.trim()) throw new PlanningPaused("Search literal is empty.");
      // Literal argv, never a model-authored command. Git grep reads the immutable tree, including dirty files captured in it.
      text = await this.git(["grep", "-n", "-I", "-F", "-e", needle, this.tree, "--", `:(literal)${path}`,
        ":(glob,exclude)**/.env*", ":(glob,exclude)**/credentials.json", ":(glob,exclude)**/auth.json"]);
    }
    const hash = planningHash(text);
    let limit = PLANNING_LIMITS.fragmentBytes - 1500;
    while (limit > 0) {
      const part = utf8Slice(text, request.offset, limit);
      const fragment = { id: planningHash(JSON.stringify([request.kind, request.selector, hash, request.offset])),
        kind: request.kind, selector: request.selector, hash, offset: request.offset, nextOffset: part.next, content: part.text };
      if (Buffer.byteLength(JSON.stringify(fragment)) <= PLANNING_LIMITS.fragmentBytes) return fragment;
      limit = Math.floor(limit / 2);
    }
    throw new PlanningPaused("Fragment metadata cannot fit its transfer limit.");
  }
}
