import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { posix } from "node:path";
import { PLANNING_LIMITS, PlanningPaused, type PlanningFragment, type PlanningRead } from "../shared/planningControl.js";
import { planningHash } from "./planningStore.js";
import { deferredFindingSections } from "./deferredFindingsDigest.js";

const execute = promisify(execFile);
const SNAPSHOT_READ_BYTES = 2 * 1024 * 1024;
// Malformed offsets and directory-as-file requests are correctable. Access failures remain hard stops.
export class InvalidPlanningOffset extends PlanningPaused {
  constructor(message = "Invalid UTF-8 continuation offset; reuse the returned nextOffset, or start at offset 0. Do not guess byte offsets.") { super(message); }
}
export class PlanningDirectoryRead extends PlanningPaused {
  constructor() { super("Requested path is a directory, not file evidence. Request a regular file inside it or use a path::literal search."); }
}
export class UnavailablePlanningEvidence extends PlanningPaused {
  constructor() { super("External evidence is unavailable in this snapshot. Defer this source and dependent work as To-do; continue with available evidence."); }
}
// A request that names a source outside the pinned sources, or whose selector is malformed, is decided by the request alone. The model
// corrects it: stopping the topic instead left the request queued, so every retry replayed it into the same stop (1fd0cc86, 2026-10-07).
export class InvalidPlanningRequest extends PlanningPaused {}
// The requested source is absent from the pinned sources: no tree entry at the path, or no pinned document under the selector. A deferred
// read whose source was readable when deferred is then a missing source; a request never readable is a request error like the others.
export class MissingPlanningSource extends InvalidPlanningRequest {}
// Hard stops. `blocked` is the cause alone; the message adds the next action for a queued read. A deferred read words its own next action,
// because a decision or evidence does not clear a deferred read (R1 engine review F001).
export class PlanningReadRefused extends PlanningPaused {
  constructor(readonly blocked: string) { super(`${blocked} ${REFUSED_NEXT}`); }
}
export class PlanningReadFailed extends PlanningPaused {
  constructor(readonly blocked: string) { super(`${blocked} ${FAILED_NEXT}`); }
}
// A hard stop names what was blocked, what it affects, what is kept and the next action. The read stays queued. A refusal decided by the
// request repeats on every retry; a git failure or timeout is read again by a retry. A new decision or evidence resumes the attempt without
// the queued reads (R1 engine review F002).
const HARD_STOP_KEPT = "This read was not delivered and the planning round is paused; the checkpoint, its logical attempt, session and queued " +
  "reads are kept.";
const AWAY_FROM_READ = "post a decision or evidence that directs the planner away from this read; the next retry then resumes the same attempt " +
  "without the queued reads, and drops the current draft and facts.";
const REFUSED_NEXT = `${HARD_STOP_KEPT} A plain retry repeats this stop because the read stays queued. To continue, ${AWAY_FROM_READ}`;
const FAILED_NEXT = `${HARD_STOP_KEPT} A retry runs the read again and continues without new input once git works or answers in time. ` +
  `If the same failure repeats, ${AWAY_FROM_READ}`;
const UNPINNED_SOURCE = "Requested source is not in the pinned manifest. A manifest id is kind:selector; request its kind and the selector " +
  "after the prefix (id context:<name> is kind=context selector=<name>, and the manifest itself is kind=context selector=manifest). " +
  "If the source is not listed, record it as unavailable and continue.";
// The packer returns these as read errors and drops the request. Credential paths, snapshot read failures and timeouts remain hard stops.
export function isCorrectableReadError(error: unknown): error is PlanningPaused {
  return error instanceof InvalidPlanningOffset || error instanceof PlanningDirectoryRead || error instanceof UnavailablePlanningEvidence ||
    error instanceof InvalidPlanningRequest;
}
export function utf8Slice(text: string, offset: number, limit: number): { text: string; next: number | null } {
  return sliceBytes(Buffer.from(text), offset, limit);
}
function sliceBytes(bytes: Buffer, offset: number, limit: number): { text: string; next: number | null } {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || (offset < bytes.length && (bytes[offset] & 0xc0) === 0x80)) {
    throw new InvalidPlanningOffset();
  }
  let end = Math.min(bytes.length, offset + limit);
  while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end--;
  return { text: bytes.subarray(offset, end).toString("utf8"), next: end < bytes.length ? end : null };
}
// 한 번 읽은 원문의 쪽 — 범위 읽기가 같은 원문의 연속 쪽을 자를 때 쪽마다 git show·git grep 을 다시 돌리지 않는다. 쪽 신원과 크기 규칙은 read 와 같다.
export interface PlanningSource { hash: string; page(offset: number): PlanningFragment }

function safeSelector(path: string): void {
  if (path.startsWith("/") || path.includes("\\") || path.includes("\0") || path.split("/").includes("..") ||
      path.split("/").some(p => p === ".git" || p.startsWith(".env") || /^(credentials|auth)\.json$/.test(p))) {
    throw new PlanningReadRefused("Planning reads must stay in the approved snapshot and exclude credential paths.");
  }
}

export class PlanningReader {
  constructor(private readonly root: string, private readonly tree: string,
    readonly documents: ReadonlyMap<string, string>, private readonly evidenceAvailable: (selector: string) => boolean = () => true) {
    if (!/^[a-f0-9]{40,64}$/.test(tree)) throw new Error("Invalid snapshot tree");
  }
  private async git(args: string[]): Promise<string> {
    try {
      const { stdout } = await execute("git", args, { cwd: this.root, maxBuffer: SNAPSHOT_READ_BYTES,
        timeout: 10_000, encoding: "utf8" });
      return stdout;
    } catch (error) {
      const code = (error as { code?: number | string }).code;
      if (code === 1 && args[0] === "grep") return "";
      // Output beyond the limit is decided by the request's breadth; the model narrows it. A git failure or timeout still stops.
      if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw new InvalidPlanningRequest(
        `Snapshot read output exceeds the ${SNAPSHOT_READ_BYTES / 1024 / 1024} MiB limit for one request. Use a narrower path or a more specific ` +
        "path::literal search (a search within a large file returns only its matching lines), then request again.");
      throw new PlanningReadFailed("Snapshot read unavailable for this request (git failed or timed out).");
    }
  }
  assertAvailable(request: Pick<PlanningRead, "kind" | "selector">): void {
    if (request.kind === "evidence" && !this.evidenceAvailable(request.selector)) throw new UnavailablePlanningEvidence();
  }
  async read(request: PlanningRead): Promise<PlanningFragment> {
    return (await this.source(request)).page(request.offset);
  }
  async source(request: Omit<PlanningRead, "offset">): Promise<PlanningSource> {
    this.assertAvailable(request);
    if (request.kind === "image") throw new PlanningReadRefused("Images must use the pinned evidence image broker (kind=image with a pinned imageHash).");
    let text: string;
    if (["context", "memory", "evidence", "artifact"].includes(request.kind)) {
      const value = this.documents.get(`${request.kind}:${request.selector}`);
      if (value === undefined) {
        if (request.kind === "evidence") throw new UnavailablePlanningEvidence();
        throw new MissingPlanningSource(UNPINNED_SOURCE);
      }
      text = value;
    } else if (request.kind === "search" && request.selector.startsWith("artifact::")) {
      const selector = request.selector.slice("artifact::".length);
      // Resolve the pinned path first: the remaining literal may itself contain "::".
      let path = "", body: string | undefined;
      for (const [key, value] of this.documents) {
        if (!key.startsWith("artifact:")) continue;
        const candidate = key.slice("artifact:".length);
        if (candidate.length > path.length && selector.startsWith(`${candidate}::`)) { path = candidate; body = value; }
      }
      const needle = selector.slice(path.length + 2).trim().toLocaleLowerCase();
      if (!path || !needle || body === undefined) throw new InvalidPlanningRequest("Artifact search requires a pinned artifact path and a non-empty literal.");
      // Search only host-pinned text; return byte offsets into its original body, never filesystem reads.
      const matches: string[] = [];
      const sourceHash = planningHash(body);
      let offset = 0, sectionOffset = 0;
      const seen = new Set<number>();
      const sections = deferredFindingSections(body);
      let section = 0;
      const lines = body.split(/(?<=\n)/);
      for (const line of lines) {
        if (offset < sections.contentOffset) { offset += Buffer.byteLength(line); continue; }
        // Use producer-owned boundaries, never headings quoted inside a rationale.
        // Legacy or malformed indexes conservatively return the original document start.
        while (section < sections.starts.length && sections.starts[section]! <= offset) sectionOffset = sections.starts[section++]!;
        if (line.toLocaleLowerCase().includes(needle) && !seen.has(sectionOffset)) {
          seen.add(sectionOffset);
          // end: 그 항목의 끝(다음 항목 시작, 마지막 항목·색인 없는 옛 원장은 문서 끝) — kind=artifact 범위 읽기의 end 로 그대로 쓰면 항목 전체가 실린다.
          const sectionEnd = sections.starts[section] ?? Buffer.byteLength(body);
          matches.push(JSON.stringify({ selector: path, hash: sourceHash, offset: sectionOffset, end: sectionEnd, excerpt: line.trim().slice(0, 800) }));
        }
        offset += Buffer.byteLength(line);
      }
      text = matches.join("\n");
    } else if (request.kind === "search" && request.selector.startsWith("evidence::")) {
      const needle = request.selector.slice("evidence::".length).trim().toLocaleLowerCase();
      if (!needle) throw new InvalidPlanningRequest("Evidence search literal is empty.");
      text = [...this.documents].filter(([key, body]) => key.startsWith("evidence:") && this.evidenceAvailable(key.slice("evidence:".length)) && `${key}\n${body}`.toLocaleLowerCase().includes(needle))
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
      if (!entry) throw new MissingPlanningSource("Only regular files in the pinned tree may be read.");
      const entryPath = entry.slice(entry.indexOf("\t") + 1);
      if (/^040000 tree [a-f0-9]+\t/.test(entry) && entryPath === lookupPath) {
        throw new PlanningDirectoryRead();
      }
      if (!/^100[0-7]{3} blob [a-f0-9]+\t/.test(entry) || entryPath !== path) {
        throw new InvalidPlanningRequest("Only regular files in the pinned tree may be read.");
      }
      text = await this.git(["show", `${this.tree}:${path}`]);
      if (text.includes("\0")) throw new InvalidPlanningRequest("Binary files require a separately approved visual source.");
    } else {
      const split = request.selector.indexOf("::");
      if (split < 1) throw new InvalidPlanningRequest("Search selector must be path::literal (use . for repository root).");
      const path = request.selector.slice(0, split), needle = request.selector.slice(split + 2);
      safeSelector(path);
      if (!needle.trim()) throw new InvalidPlanningRequest("Search literal is empty.");
      // Literal argv, never a model-authored command. Git grep reads the immutable tree, including dirty files captured in it.
      text = await this.git(["grep", "-n", "-I", "-F", "-e", needle, this.tree, "--", `:(literal)${path}`,
        ":(glob,exclude)**/.env*", ":(glob,exclude)**/credentials.json", ":(glob,exclude)**/auth.json"]);
    }
    const hash = planningHash(text), bytes = Buffer.from(text);
    return { hash, page: offset => {
      let limit = PLANNING_LIMITS.fragmentBytes - 1500;
      while (limit > 0) {
        const part = sliceBytes(bytes, offset, limit);
        const fragment = { id: planningHash(JSON.stringify([request.kind, request.selector, hash, offset])),
          kind: request.kind, selector: request.selector, hash, offset, nextOffset: part.next, content: part.text };
        if (Buffer.byteLength(JSON.stringify(fragment)) <= PLANNING_LIMITS.fragmentBytes) return fragment;
        limit = Math.floor(limit / 2);
      }
      throw new PlanningPaused("Fragment metadata cannot fit its transfer limit.");
    } };
  }
}
