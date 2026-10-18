import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createRoomConfig } from "../src/cli/config.js";
import { doctor, type DoctorDependencies, type DoctorProbe } from "../src/cli/doctor.js";

// Public doctor boundary -> actionable host readiness, not provider/account/E2E success.
const temporary: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); temporary.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })); });
const help = ["--model", "--effort", "--output-format", "--json-schema", "--permission-mode", "--setting-sources",
  "--strict-mcp-config", "--tools", "--settings", "--strict-config", "--json", "--output-schema", "--stdio", "--sock", "--thread", "--message"].join("\n");
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "room-doctor-"))); temporary.push(root);
  const config = createRoomConfig({ repositoryPath: join(root, "repo"), dataDirectory: join(root, "data"), claudeModel: "opus", codexModel: "gpt-custom" });
  for (const directory of [config.repositoryPath, config.dataDirectory, join(root, "home", ".codex"), join(root, "home", ".claude")]) mkdirSync(directory, { recursive: true });
  for (const file of ["src/server/index.ts", "src/server/runtime/cli.ts", "src/server/mediation/interruptBridge.ts"]) {
    const path = join(root, "checkout", file); mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "fixture");
  }
  const probe = vi.fn<DoctorProbe>(async (command, args) => {
    if (args.at(-1) === "--help") return { code: 0, stdout: help };
    if (command === "git" && args[0] === "-C") return { code: 0, stdout: "a".repeat(40) };
    if (command === "pgrep") return { code: 1, stdout: "", error: "failed" };
    return { code: 0, stdout: `${command} 2.3.4` };
  });
  const deps: DoctorDependencies = { platform: "darwin", nodeVersion: "26.0.0", homeDirectory: join(root, "home"),
    codeDirectory: join(root, "checkout"), probe, dependencyAvailable: () => true, endpointAvailable: vi.fn(async () => true) };
  // Isolate inherited provider homes while retaining the configuration's production environment behavior.
  vi.stubEnv("CODEX_HOME", undefined); vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  return { root, config, probe, deps };
}

it("reports observed local capabilities but leaves authentication and model access unverified", async () => {
  const { config, probe, deps } = fixture();
  const checks = await doctor(config, deps);
  for (const check of ["node", "npm", "git", "ps", "pgrep", "git-head", "code", "runtime-dependencies", "web-assets", "data-location", "claude-capabilities", "codex-exec-capabilities", "codex-app-server-proxy", "codex-queue"])
    expect(checks.find(result => result.check === check)?.status, check).toBe("pass");
  expect(checks.find(result => result.check === "codex-authentication")).toMatchObject({ status: "warn", detail: expect.stringContaining("Login state is unknown") });
  expect(checks.find(result => result.check === "account-and-model-access")?.status).toBe("warn");
  expect(checks.find(result => result.check === "figma")?.status).toBe("warn");
  const providerCalls = probe.mock.calls.filter(([command]) => ["claude", "codex"].includes(command));
  expect(providerCalls.length).toBeGreaterThan(0);
  expect(providerCalls.every(([, args, options]) => ["--version", "--help"].includes(args.at(-1)!) && options.timeoutMs <= 3000)).toBe(true);
});

it.each([false, true])("checks web build readiness without requiring checkout/dist or claiming a candidate is active: candidate exists %s", async candidateExists => {
  const { config, deps } = fixture();
  if (candidateExists) {
    const candidate = join(config.dataDirectory, "web-dist", "existing-candidate");
    mkdirSync(candidate, { recursive: true }); writeFileSync(join(candidate, "index.html"), "candidate");
  }
  const check = (await doctor(config, deps)).find(result => result.check === "web-assets");
  expect(check).toMatchObject({ status: "pass", detail: expect.stringContaining("cr start creates a fresh candidate") });
  expect(check?.detail).toContain(join(config.dataDirectory, "web-dist"));
  expect(check?.detail).toContain("active serving directory was not checked");
});

it.each(["typescript", "vite", "@vitejs/plugin-react"])("reports a missing web startup build dependency: %s", async missing => {
  const { config, deps } = fixture();
  deps.dependencyAvailable = module => module !== missing;
  expect((await doctor(config, deps)).find(result => result.check === "web-assets"))
    .toMatchObject({ status: "fail", detail: expect.stringContaining(missing), remedy: expect.stringContaining("development dependencies") });
});

it("fails missing host executables and Git HEAD without leaking subprocess diagnostics", async () => {
  const { config, deps } = fixture(), normal = deps.probe;
  deps.probe = async (command, args, options) => {
    if (["claude", "npm"].includes(command)) return { code: null, stdout: "DO_NOT_PRINT_SECRET", stderr: "DO_NOT_PRINT_SECRET", error: "missing" };
    if (command === "git" && args[0] === "-C") return { code: 128, stdout: "", stderr: "DO_NOT_PRINT_SECRET" };
    return normal(command, args, options);
  };
  const checks = await doctor(config, deps);
  expect(checks.find(result => result.check === "claude-cli")).toMatchObject({ status: "fail", detail: expect.stringContaining("PATH") });
  expect(checks.find(result => result.check === "npm")?.status).toBe("fail");
  expect(checks.find(result => result.check === "git-head")?.status).toBe("fail");
  expect(JSON.stringify(checks)).not.toContain("DO_NOT_PRINT_SECRET");
});

it("reports missing configured files and dependencies at the owning boundary", async () => {
  const { root, config, deps } = fixture();
  rmSync(join(deps.codeDirectory, "src/server/runtime/cli.ts"));
  deps.dependencyAvailable = module => module !== "fastify";
  const checks = await doctor({ ...config, memoryDirectory: join(root, "missing-memory"),
    standingReferencePath: join(root, "missing-reference.md"), claudeSkillDirectories: [join(root, "missing-skills")] }, deps);
  expect(checks.find(result => result.check === "runtime-dependencies")).toMatchObject({ status: "fail", detail: expect.stringContaining("fastify") });
  expect(checks.find(result => result.check === "code")).toMatchObject({ status: "fail", detail: expect.stringContaining("src/server/runtime/cli.ts") });
  for (const check of ["memory-directory", "standing-reference", "claude-skills-1"]) expect(checks.find(result => result.check === check)?.status).toBe("warn");
});

it("fails runtime data inside either checkout instead of treating it as a private store", async () => {
  const { root, config, deps } = fixture();
  for (const dataDirectory of [join(config.repositoryPath, "runtime"), join(deps.codeDirectory, "runtime")]) {
    const checks = await doctor({ ...config, dataDirectory }, deps);
    expect(checks.find(result => result.check === "data-location")?.status).toBe("fail");
  }
  symlinkSync(config.repositoryPath, join(root, "linked-data"));
  expect((await doctor({ ...config, dataDirectory: join(root, "linked-data") }, deps)).find(result => result.check === "data-location")?.status).toBe("fail");
  expect((await doctor({ ...config, dataDirectory: join(root, "linked-data", "not-created") }, deps)).find(result => result.check === "data-location")?.status).toBe("fail");
});

it("uses configured auth homes without reading their contents or inheriting a room token", async () => {
  const { root, config, deps, probe } = fixture();
  vi.stubEnv("CONSENSUS_ROOM_TOKEN", "DO_NOT_PRINT_SECRET"); vi.stubEnv("CONSENSUS_ROOM_REPOSITORY", "/stale/repo");
  const codexHome = join(root, "separate-codex"), claudeConfigDirectory = join(root, "separate-claude");
  mkdirSync(codexHome); mkdirSync(claudeConfigDirectory);
  writeFileSync(join(codexHome, "auth.json"), "DO_NOT_PRINT_SECRET");
  writeFileSync(join(claudeConfigDirectory, ".credentials.json"), "DO_NOT_PRINT_SECRET");
  writeFileSync(join(config.dataDirectory, "evidence-apps.json"), JSON.stringify({ googleDriveLinkId: "link_private123", token: "DO_NOT_PRINT_SECRET", accountIds: { slack: "private-account" } }));
  const checks = await doctor({ ...config, codexHome, claudeConfigDirectory }, deps);
  for (const provider of ["codex", "claude"]) expect(checks.find(result => result.check === `${provider}-authentication`)).toMatchObject({ status: "warn", detail: expect.stringContaining("contents and login state were not checked") });
  for (const [, , options] of probe.mock.calls) {
    expect(options.env.CODEX_HOME).toBe(codexHome); expect(options.env.CLAUDE_CONFIG_DIR).toBe(claudeConfigDirectory);
    expect(options.env.CONSENSUS_ROOM_TOKEN).toBeUndefined(); expect(options.env.CONSENSUS_ROOM_REPOSITORY).toBe(config.repositoryPath);
    expect(options.env.HOME).toBe(process.env.HOME);
  }
  expect(checks.find(result => result.check === "evidence-apps")?.detail).toContain("googleDriveLinkId is configured");
  expect(JSON.stringify(checks)).not.toMatch(/DO_NOT_PRINT_SECRET|link_private123|private-account/);
});

it("distinguishes optional proxy/queue support from required execution capabilities and hidden advisor support", async () => {
  const { config, deps } = fixture(), normal = deps.probe;
  deps.probe = async (command, args, options) => {
    if (command === "codex" && ["queue", "app-server"].includes(args[0])) return { code: 2, stdout: "", stderr: "unrecognized command" };
    if (command === "codex" && args[0] === "exec") return { code: 0, stdout: "--json" };
    return normal(command, args, options);
  };
  const checks = await doctor({ ...config, agents: { ...config.agents, claude: { ...config.agents.claude, advisorModel: "user-advisor" } } }, deps);
  expect(checks.find(result => result.check === "codex-queue")?.status).toBe("warn");
  expect(checks.find(result => result.check === "codex-app-server-proxy")?.status).toBe("warn");
  expect(checks.find(result => result.check === "codex-exec-capabilities")).toMatchObject({ status: "fail", detail: expect.stringContaining("--output-schema") });
  expect(checks.find(result => result.check === "claude-advisor")).toMatchObject({ status: "warn", detail: expect.stringContaining("absence is not a failure") });
  expect(checks.find(result => result.check === "claude-capabilities")?.status).toBe("pass");
});

it("reports probe timeouts and thrown failures with bounded, redacted output", async () => {
  const { config, deps } = fixture(), normal = deps.probe;
  deps.probe = async (command, args, options) => {
    if (command === "npm") return { code: null, stdout: "secret-output", error: "timeout" };
    if (command === "claude") throw new Error("secret-output");
    return normal(command, args, options);
  };
  const checks = await doctor(config, deps);
  expect(checks.find(result => result.check === "npm")).toMatchObject({ status: "fail", detail: expect.stringContaining("time limit") });
  expect(checks.find(result => result.check === "claude-cli")?.status).toBe("fail");
  expect(JSON.stringify(checks)).not.toContain("secret-output");
});

it("limits Figma to a local availability probe and labels Linux E2E as unverified", async () => {
  const { config, deps } = fixture(); deps.platform = "linux";
  const checks = await doctor({ ...config, figmaMcpUrl: "http://127.0.0.1:3845/mcp" }, deps);
  expect(deps.endpointAvailable).toHaveBeenCalledTimes(1);
  expect(checks.find(result => result.check === "figma")).toMatchObject({ status: "pass", detail: expect.stringContaining("MCP service identity") });
  expect(checks.find(result => result.check === "linux-runtime")?.status).toBe("warn");
  deps.endpointAvailable = async () => false;
  expect((await doctor({ ...config, figmaMcpUrl: "http://localhost:3845/mcp" }, deps)).find(result => result.check === "figma")?.status).toBe("warn");
});

it("fails unsupported Node and OS independently of otherwise healthy probes", async () => {
  const { config, deps } = fixture(); deps.nodeVersion = "24.2.0"; deps.platform = "win32";
  const checks = await doctor(config, deps);
  expect(checks.find(result => result.check === "node")?.status).toBe("fail");
  expect(checks.find(result => result.check === "platform")?.status).toBe("fail");
});
