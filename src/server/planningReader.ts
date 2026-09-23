import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import { PLANNING_LIMITS, PlanningPaused, type PlanningFragment, type PlanningRead } from "../shared/planningControl.js";
import { planningHash } from "./planningStore.js";

const execute = promisify(execFile);
export function utf8Slice(text: string, offset: number, limit: number): { text: string; next: number | null } {
  const bytes = Buffer.from(text);
  if (offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
    throw new PlanningPaused("Invalid UTF-8 continuation offset; reuse the returned nextOffset.");
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
    } else if (request.kind === "file") {
      safeSelector(request.selector);
      const path = posix.normalize(request.selector);
      const entry = await this.git(["ls-tree", this.tree, "--", path]);
      if (!/^100[0-7]{3} blob [a-f0-9]+\t/.test(entry) || entry.trimEnd().split("\t").at(-1) !== path) {
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
