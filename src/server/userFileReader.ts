import { spawn } from "node:child_process";

export class UserFileAccessBlocked extends Error {
  constructor(readonly path: string, detail: string) {
    super(`User file access blocked: ${path} (${detail}). Check the server's file access; the file was not skipped.`);
    this.name = "UserFileAccessBlocked";
  }
}

export interface UserFileReadOptions { signal?: AbortSignal; timeoutMs?: number }
type Request = { path: string; operation: "resolve" | "text" | "memory" | "memoryBatch" | "instructions"; maxBytes?: number; paths?: string[];
  workspacePath?: string; repositoryPath?: string; globalPath?: string; injectWorkspaceFile?: boolean };
export interface InstructionFiles { global: string | null; project: string | null; source: "workspace" | "repository" | null }

// FileProvider/TCC can block open/realpath inside libuv even after AbortSignal or SIGTERM.
// The child performs the actual read, not a probe followed by another open in the server.
// No shell, altered permissions, or inherited Node hooks; a stuck child is killed and reaped.
const worker = String.raw`
const fs = require('node:fs/promises');
const { dirname, basename, join } = require('node:path');
const input = JSON.parse(process.argv[1]);
// A parent crash must not leave a blocked reader forever. Async filesystem I/O keeps this
// watchdog runnable; SIGKILL also terminates libuv work that process.exit cannot drain.
setTimeout(() => process.kill(process.pid, 'SIGKILL'), input.deadlineMs + 1000).unref();
let activePath = input.path;
async function optional(path, operation) {
  activePath = path;
  try { return await operation(path); }
  catch (error) { if (['ENOENT', 'ENOTDIR'].includes(error.code)) return null; throw error; }
}
async function memory(path) {
  return optional(path, async p => {
    const parent = await fs.realpath(dirname(p)), stat = await fs.lstat(p);
    if (parent !== dirname(p) || !stat.isFile() || stat.isSymbolicLink() || stat.size > input.maxBytes) return null;
    const value = await fs.readFile(p, 'utf8');
    return Buffer.byteLength(value) > input.maxBytes ? null : value;
  });
}
(async () => { try {
  let value;
  if (input.operation === 'instructions') {
    const text = path => optional(path, p => fs.readFile(p, 'utf8'));
    // Match Codex's override precedence even when native discovery is disabled.
    const instruction = async path => {
      if (basename(path) === 'AGENTS.md') {
        const override = await text(join(dirname(path), 'AGENTS.override.md'));
        if (override && override.trim()) return override;
      }
      return text(path);
    };
    const global = input.globalPath ? await instruction(input.globalPath) : null;
    const workspace = input.injectWorkspaceFile ? await instruction(input.workspacePath)
      : await optional(input.workspacePath, p => fs.realpath(p));
    let project = null, source = null;
    if (workspace !== null && input.injectWorkspaceFile) { project = workspace; source = 'workspace'; }
    else if (workspace === null && input.repositoryPath) { project = await instruction(input.repositoryPath); source = 'repository'; }
    value = JSON.stringify({ global, project, source: project ? source : null });
  } else if (input.operation === 'resolve') value = await fs.realpath(input.path);
  else if (input.operation === 'memory') value = await memory(input.path);
  else if (input.operation === 'memoryBatch') {
    const values = [];
    for (const path of input.paths) values.push(await memory(path));
    value = JSON.stringify(values);
  } else value = await fs.readFile(input.path, 'utf8');
  process.stdout.write(JSON.stringify({ value }));
} catch (error) {
  process.stdout.write(JSON.stringify({ error: { code: error.code || 'READ_FAILED', path: activePath } }));
} })();
`;

async function read(request: Request, options: UserFileReadOptions): Promise<string | null> {
  options.signal?.throwIfAborted();
  const timeoutMs = options.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("User file deadline must be positive and finite.");
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_OPTIONS;
    const child = spawn(process.execPath, ["-e", worker, JSON.stringify({ ...request, deadlineMs: timeoutMs })], { env, stdio: ["ignore", "pipe", "ignore"] });
    child.once("error", reject);
    if (!child.stdout) return;
    const chunks: Buffer[] = [];
    const outputLimit = request.operation === "memoryBatch" ? 1024 + request.paths!.length * request.maxBytes! * 16 : 2 * 1024 * 1024;
    let size = 0;
    let failure: unknown;
    const stop = (error: unknown) => {
      if (failure === undefined) failure = error;
      child.kill("SIGKILL");
    };
    const abort = () => stop(options.signal?.reason ?? new Error("User file read cancelled."));
    const timer = setTimeout(() => stop(new UserFileAccessBlocked(request.path, `read deadline ${timeoutMs}ms exceeded`)), timeoutMs);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > outputLimit) stop(new UserFileAccessBlocked(request.path, "reader output exceeds its bound"));
      else chunks.push(chunk);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      if (failure !== undefined) { reject(failure); return; }
      if (code !== 0) { reject(new UserFileAccessBlocked(request.path, signal ?? `reader exited ${code}`)); return; }
      try {
        const reply = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { value?: string | null; error?: { code: string; path: string } };
        if (reply.error) {
          if (["ENOENT", "ENOTDIR"].includes(reply.error.code)) { resolve(null); return; }
          throw new UserFileAccessBlocked(reply.error.path, reply.error.code);
        }
        if (reply.value !== null && typeof reply.value !== "string") throw new Error("Invalid reader response.");
        resolve(reply.value);
      } catch (error) { reject(error); }
    });
  });
}

export const resolveUserPath = (path: string, options: UserFileReadOptions = {}) => read({ path, operation: "resolve" }, options);
export const readUserFile = (path: string, options: UserFileReadOptions = {}) => read({ path, operation: "text" }, options);
export const readMemoryFile = (path: string, maxBytes: number, options: UserFileReadOptions = {}) =>
  read({ path, operation: "memory", maxBytes }, options);

export async function readMemoryFiles(paths: string[], maxBytes: number, options: UserFileReadOptions = {}): Promise<Array<string | null>> {
  options.signal?.throwIfAborted();
  const result: Array<string | null> = [];
  // Bounds each process and IPC response without spawning one Node runtime for every wiki page.
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32);
    result.push(...JSON.parse((await read({ path: batch.join(", "), paths: batch, operation: "memoryBatch", maxBytes }, options))!));
  }
  return result;
}

// One killable process for the complete precedence lookup; no parent-side re-open or stale cache.
export async function readInstructionFiles(input: { workspacePath: string; repositoryPath?: string; globalPath?: string;
  injectWorkspaceFile: boolean }, options: UserFileReadOptions = {}): Promise<InstructionFiles> {
  const path = [input.globalPath, input.workspacePath, input.repositoryPath].filter(Boolean).join(", ");
  return JSON.parse((await read({ ...input, path, operation: "instructions" }, options))!) as InstructionFiles;
}
