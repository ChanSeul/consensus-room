import { execFile } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { createConnection } from "node:net";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { roomEnvironment, type RoomConfig } from "./config.js";

export type DoctorCheck = { check: string; status: "pass" | "warn" | "fail"; detail: string; remedy?: string };
export type ProbeResult = { code: number | null; stdout: string; stderr?: string; error?: "missing" | "timeout" | "failed" };
export type DoctorProbe = (command: string, args: readonly string[], options: {
  env: NodeJS.ProcessEnv; cwd?: string; timeoutMs: number;
}) => Promise<ProbeResult>;

// These seams cover host boundaries; production and tests use the same diagnostic decisions.
export interface DoctorDependencies {
  platform: NodeJS.Platform;
  nodeVersion: string;
  homeDirectory: string;
  codeDirectory: string;
  probe: DoctorProbe;
  dependencyAvailable: (module: string) => boolean;
  endpointAvailable: (url: URL) => Promise<boolean>;
}

const require = createRequire(import.meta.url);
const probe: DoctorProbe = (command, args, options) => new Promise(done => {
  execFile(command, [...args], { env: options.env, cwd: options.cwd, timeout: options.timeoutMs,
    killSignal: "SIGKILL", maxBuffer: 64 * 1024, encoding: "utf8" }, (error, stdout, stderr) => {
    const failure = error as (Error & { killed?: boolean; code?: string | number }) | null;
    // Raw error messages, stdout and stderr are never included in diagnostic failures.
    done({ code: failure ? typeof failure.code === "number" ? failure.code : null : 0, stdout, stderr,
      ...(failure ? { error: failure.code === "ENOENT" ? "missing" : failure.killed ? "timeout" : "failed" } as const : {}) });
  });
});

function endpointAvailable(url: URL): Promise<boolean> {
  return new Promise(done => {
    const socket = createConnection({ host: url.hostname.replace(/^\[|\]$/g, ""),
      port: Number(url.port || (url.protocol === "https:" ? 443 : 80)) });
    const finish = (available: boolean) => { socket.destroy(); done(available); };
    socket.setTimeout(1500, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

function kind(path: string): "file" | "directory" | "missing" | "other" {
  try { const stat = statSync(path); return stat.isFile() ? "file" : stat.isDirectory() ? "directory" : "other"; }
  catch { return "missing"; }
}

function failureDetail(result: ProbeResult): string {
  return result.error === "missing" ? "Executable was not found on PATH."
    : result.error === "timeout" ? "Probe exceeded its time limit."
    : `Probe failed${typeof result.code === "number" ? ` (exit ${result.code})` : ""}; command output was withheld.`;
}

function advertised(output: string, flag: string): boolean {
  return new RegExp(`(^|[\\s,])${flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=[\\s,=<\\[]|$)`, "m").test(output);
}

/** Read-only host diagnostics. Never starts a provider session, sends a queue item, or reads credential contents. */
export async function doctor(config: RoomConfig, dependencies: Partial<DoctorDependencies> = {}): Promise<DoctorCheck[]> {
  const deps: DoctorDependencies = {
    platform: process.platform, nodeVersion: process.versions.node, homeDirectory: homedir(),
    codeDirectory: resolve(dirname(fileURLToPath(import.meta.url)), "../.."), probe,
    dependencyAvailable: module => { try { require.resolve(module); return true; } catch { return false; } },
    endpointAvailable, ...dependencies,
  };
  const env = roomEnvironment(config);
  // Host runtime resolution ignores relative PATH entries too; diagnostics must use the same executable sources.
  env.PATH = (env.PATH ?? "").split(":").filter(entry => isAbsolute(entry)).join(":");
  const checks: DoctorCheck[] = [];
  const add = (check: string, status: DoctorCheck["status"], detail: string, remedy?: string) => {
    checks.push({ check, status, detail, ...(remedy && status !== "pass" ? { remedy } : {}) });
  };
  const run = async (command: string, args: readonly string[], cwd?: string): Promise<ProbeResult> => {
    try { return await deps.probe(command, args, { env, cwd, timeoutMs: 3000 }); }
    catch { return { code: null, stdout: "", error: "failed" }; }
  };
  const supported = deps.platform === "darwin" || deps.platform === "linux";
  add("platform", supported ? "pass" : "fail", `Local-only operation: ${deps.platform}.`, "Use macOS or Linux; the server binds to 127.0.0.1.");
  if (deps.platform === "linux") add("linux-runtime", "warn", "Linux host checks do not establish provider E2E compatibility.", "Verify the provider flow on this Linux host before relying on it.");
  const major = Number(deps.nodeVersion.replace(/^v/, "").split(".")[0]);
  add("node", Number.isInteger(major) && major >= 26 ? "pass" : "fail",
    `Node ${/^v?\d+(\.\d+){0,2}$/.test(deps.nodeVersion) ? deps.nodeVersion : "version unavailable"}; version 26 or newer is required.`, "Install Node.js 26 or newer.");

  const modules = ["tsx/cli", "fastify", "@fastify/cookie", "@fastify/static", "@modelcontextprotocol/sdk/client/index.js", "@babel/parser", "zod", "node:sqlite"];
  const missingModules = modules.filter(module => !deps.dependencyAvailable(module));
  add("runtime-dependencies", missingModules.length ? "fail" : "pass", missingModules.length
    ? `Missing runtime dependencies: ${missingModules.join(", ")}.` : "Runtime dependencies resolve from this checkout.", "Run npm ci in the Consensus Room checkout.");
  const sources = ["src/server/index.ts", "src/server/runtime/cli.ts", "src/server/mediation/interruptBridge.ts"];
  const missingSources = sources.filter(path => kind(join(deps.codeDirectory, path)) !== "file");
  add("code", missingSources.length ? "fail" : "pass", missingSources.length
    ? `Missing code entry points: ${missingSources.join(", ")}.` : "Server, runtime and mediation code entry points are present.", "Use a complete Consensus Room checkout.");
  const missingWebModules = ["typescript", "vite", "@vitejs/plugin-react", "react", "react-dom"]
    .filter(module => !deps.dependencyAvailable(module));
  add("web-assets", missingWebModules.length ? "fail" : "pass", missingWebModules.length
    ? `Missing web candidate build dependencies: ${missingWebModules.join(", ")}.`
    : `Web candidate build dependencies resolve. cr start creates a fresh candidate under ${join(config.dataDirectory, "web-dist")}; the active serving directory was not checked.`,
    "Run npm ci with development dependencies in the Consensus Room checkout.");

  const directory = (check: string, path: string, required: boolean) => add(check, kind(path) === "directory" ? "pass" : required ? "fail" : "warn",
    kind(path) === "directory" ? `Directory is present: ${path}` : `Directory is missing or inaccessible: ${path}`,
    required ? "Select an existing local Git repository." : "Create the configured directory or correct its path; doctor does not create it.");
  directory("repository-path", config.repositoryPath, true);
  directory("data-directory", config.dataDirectory, false);
  const actualPath = (path: string): string => {
    try { return realpathSync(path); }
    catch {
      const parent = dirname(path);
      return parent === path ? path : join(actualPath(parent), relative(parent, path));
    }
  };
  const privateData = [config.repositoryPath, deps.codeDirectory].every(directory => {
    return [relative(directory, config.dataDirectory), relative(actualPath(directory), actualPath(config.dataDirectory))]
      .every(path => path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path));
  });
  add("data-location", privateData ? "pass" : "fail", privateData
    ? "Runtime data is configured outside the target repository and Consensus Room checkout."
    : "Runtime data is configured inside the target repository or Consensus Room checkout.",
    "Select a private data directory outside both checkouts, such as the platform default data directory.");
  directory("memory-directory", config.memoryDirectory ?? join(config.repositoryPath, ".consensus-room", "memory"), false);
  if (config.standingReferencePath) add("standing-reference", kind(config.standingReferencePath) === "file" ? "pass" : "warn",
    kind(config.standingReferencePath) === "file" ? `Reference file is present: ${config.standingReferencePath}` : `Configured reference file is missing or inaccessible: ${config.standingReferencePath}`,
    "Select an existing reference file or remove the optional setting.");
  for (const provider of ["claude", "codex"] as const) {
    const paths = provider === "claude" ? config.claudeSkillDirectories : config.codexSkillDirectories;
    if (!paths?.length) add(`${provider}-skills`, "warn", "No optional native skill directories are configured.");
    else paths.forEach((path, index) => directory(`${provider}-skills-${index + 1}`, path, false));
    const settings = config.agents[provider];
    add(`${provider}-model`, settings.model.trim() ? "pass" : "fail", `Configured model: ${settings.model}; effort: ${settings.effort}. Account access is not verified.`);
  }
  add("claude-implementation-model", "pass", `Configured implementation model: ${config.agents.claude.implementation.model}; effort: ${config.agents.claude.implementation.effort}. Account access is not verified.`);
  const codexHome = resolve(env.CODEX_HOME ?? join(deps.homeDirectory, ".codex"));
  const claudeHome = resolve(env.CLAUDE_CONFIG_DIR || join(deps.homeDirectory, ".claude"));
  for (const [provider, home, credential] of [["codex", codexHome, "auth.json"], ["claude", claudeHome, ".credentials.json"]]) {
    directory(`${provider}-config-directory`, home, false);
    const path = join(home, credential);
    add(`${provider}-authentication`, "warn", kind(path) === "file"
      ? `Credential file is present at ${path}; its contents and login state were not checked.`
      : `No credential file was found at ${path}; keychain or other authentication may still be available. Login state is unknown.`,
    `Check ${provider} authentication separately using its supported login flow.`);
  }

  const systemChecks = async () => {
    const programs = [
      { name: "npm", args: ["--version"], valid: [0] }, { name: "git", args: ["--version"], valid: [0] },
      { name: "ps", args: ["-p", String(process.pid), "-o", "pid="], valid: [0] },
      { name: "pgrep", args: ["-f", "__consensus_room_doctor_no_process__"], valid: [0, 1] },
    ];
    const results = await Promise.all(programs.map(async program => ({ program, result: await run(program.name, program.args) })));
    for (const { program, result } of results) {
      const ok = result.code !== null && program.valid.includes(result.code) && result.error !== "missing" && result.error !== "timeout";
      const version = ["npm", "git"].includes(program.name) ? result.stdout.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/)?.[0] : undefined;
      add(program.name, ok ? "pass" : "fail", ok ? `${program.name} is available${version ? ` (${version})` : ""}.` : failureDetail(result), `Install ${program.name} and make it available on PATH.`);
    }
    if (results.find(item => item.program.name === "git")?.result.code === 0) {
      const repository = await run("git", ["-C", config.repositoryPath, "rev-parse", "--verify", "HEAD"]);
      const head = repository.stdout.trim();
      add("git-head", repository.code === 0 && /^[a-f0-9]{40,64}$/i.test(head) ? "pass" : "fail",
        repository.code === 0 && /^[a-f0-9]{40,64}$/i.test(head) ? `Git HEAD resolves (${head.slice(0, 12)}).` : "The configured repository has no readable Git HEAD.",
        "Select a Git repository with at least one commit and check repository access.");
    }
  };
  const helpCheck = async (provider: string, args: string[], check: string, flags: string[], required: boolean) => {
    const result = await run(provider, [...args, "--help"]);
    if (result.code !== 0) { add(check, required ? "fail" : "warn", failureDetail(result), `Check ${provider} ${args.join(" ")} --help with the installed CLI.`); return ""; }
    const output = `${result.stdout}\n${result.stderr ?? ""}`;
    const missing = flags.filter(flag => !advertised(output, flag));
    add(check, missing.length ? required ? "fail" : "warn" : "pass", missing.length
      ? `Help does not advertise: ${missing.join(", ")}.` : `Help advertises: ${flags.join(", ")}.`,
      missing.length ? `Install a ${provider} CLI exposing these capabilities; no minimum version is inferred.` : undefined);
    return output;
  };
  const providerChecks = async (provider: "claude" | "codex") => {
    const result = await run(provider, ["--version"]);
    const version = `${result.stdout}\n${result.stderr ?? ""}`.match(/\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?/)?.[0];
    add(`${provider}-cli`, result.code === 0 ? version ? "pass" : "warn" : "fail", result.code === 0
      ? `${provider} --version succeeded${version ? ` (${version})` : "; version text was not recognized"}.` : failureDetail(result), `Install ${provider} and make it available on PATH.`);
    if (result.code !== 0) return;
    if (provider === "claude") {
      const help = await helpCheck(provider, [], "claude-capabilities", ["--model", "--effort", "--output-format", "--json-schema", "--permission-mode", "--setting-sources", "--strict-mcp-config", "--tools", "--settings"], true);
      if (config.agents.claude.advisorModel) add("claude-advisor", "warn", advertised(help, "--advisor")
        ? "Help advertises --advisor; configured advisor account access remains unverified."
        : "Configured advisor is unverified; --advisor may be hidden from help. Its absence is not a failure.");
      if (config.agents.claude.ultracode) add("claude-ultracode", "warn", "Ultracode is configured; runtime support is not verified by a read-only help probe.");
    } else {
      await Promise.all([
        helpCheck(provider, [], "codex-capabilities", ["--strict-config"], true),
        helpCheck(provider, ["exec"], "codex-exec-capabilities", ["--json", "--output-schema"], true),
        helpCheck(provider, ["app-server"], "codex-app-server", ["--strict-config", "--stdio"], false),
        helpCheck(provider, ["app-server", "proxy"], "codex-app-server-proxy", ["--sock"], false),
        helpCheck(provider, ["queue"], "codex-queue", ["--thread", "--message"], false),
      ]);
    }
  };
  const figmaCheck = async () => {
    if (!config.figmaMcpUrl) { add("figma", "warn", "Optional Figma MCP is disabled."); return; }
    let url: URL;
    try { url = new URL(config.figmaMcpUrl); } catch { add("figma", "fail", "Figma MCP URL is invalid."); return; }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !["http:", "https:"].includes(url.protocol)
      || url.username || url.password || url.search || url.hash) { add("figma", "fail", "Figma MCP must use a credential-free localhost HTTP(S) URL."); return; }
    const reachable = await deps.endpointAvailable(url).catch(() => false);
    add("figma", reachable ? "pass" : "warn", reachable
      ? "A local TCP listener is reachable; MCP service identity, Figma access and account usability were not checked."
      : "No local TCP listener could be reached for optional Figma MCP.", "Open the intended Figma MCP service if Figma evidence is needed.");
  };
  await Promise.all([systemChecks(), providerChecks("claude"), providerChecks("codex"), figmaCheck()]);

  const evidenceFile = join(config.dataDirectory, "evidence-apps.json");
  if (kind(evidenceFile) === "file") {
    try {
      if (statSync(evidenceFile).size > 64 * 1024) throw new Error("oversized");
      const value: unknown = JSON.parse(readFileSync(evidenceFile, "utf8"));
      const link = value && typeof value === "object" && "googleDriveLinkId" in value ? value.googleDriveLinkId : undefined;
      add("evidence-apps", "warn", typeof link === "string" && /^link_[a-zA-Z0-9]+$/.test(link)
        ? "A googleDriveLinkId is configured; identifier values, credentials and account access were not inspected or reported."
        : "No valid googleDriveLinkId is configured in evidence-apps.json; values were withheld.");
    } catch { add("evidence-apps", "warn", "Optional evidence-apps.json could not be inspected as bounded JSON; contents were withheld."); }
  } else add("evidence-apps", "warn", "Optional evidence-apps.json is absent; no external account binding was verified.");
  add("account-and-model-access", "warn", "No model calls or external app requests were made. Authentication, account permissions and actual model usability remain unverified.");
  return checks.sort((left, right) => left.check.localeCompare(right.check));
}
