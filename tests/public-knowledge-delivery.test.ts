// 공개 정책의 공통 작업 지식이 빈 지침·메모리 환경의 각 역할 입력에 실제로 실리는지 — 실제 어댑터 → SpawnCommandRunner → 가짜 공급자 실행 파일이
// 받은 stdin·argv 를 관찰한다. 가짜 claude·codex 는 받은 입력을 기록하고 정해진 결과만 돌려준다(실제 모델·계정 호출 없음).
// 공급자 프로세스의 HOME·CODEX_HOME·CLAUDE_CONFIG_DIR 은 빈 임시 홈이다. 같은 값을 테스트 프로세스 환경에도 두어 어댑터가 읽는 전역 지침 위치가
// 그 빈 홈을 가리키게 한다(호스트 홈·개인 파일은 읽지도 바꾸지도 않는다). 정본 대조값은 docs/mediation/policy.md 를 이 파일에서 직접 잘라 만든다.
// 역할 턴은 엔진 실행기(turnExecutor.executeEnvelope)와 같은 호출 경계 invokeAdapter create-envelope/resume-envelope 로 부른다.
// 수신 기록은 테스트가 끝나면 지운다. CR_RECEIVED_EVIDENCE_DIR 를 주면 그 아래 summary.jsonl 에 호출별 요약(해시·횟수)만 남긴다.
import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ClaudeAdapter } from "../src/server/adapters/claude";
import { CodexAdapter } from "../src/server/adapters/codex";
import { SpawnCommandRunner } from "../src/server/processRunner";
import { readAppliedInstructions } from "../src/server/projectInstructions";
import { invokeAdapter } from "../src/server/runtime/invoke";
import { envelopeRole } from "../src/shared/turnContract";
import { turnFlags, type TurnJob } from "../src/shared/roles";
import { WORKER_KNOWLEDGE_END, WORKER_KNOWLEDGE_START, extractWorkerKnowledge } from "../src/shared/workerKnowledge";

const SOURCE = join(import.meta.dirname, "..");
const POLICY = join(SOURCE, "docs", "mediation", "policy.md");
const RESULT = { kind: "PLAN", summary: "fixture", findings: [], evidenceRefs: [] };
const PERSONAL_LABELS = ["적용되는 지시문 시작: 사용자 전역", "적용되는 지시문 시작: 작업 저장소"];

// 파서와 독립된 대조값 — standalone 표식 줄 사이의 바이트.
function canonicalSection(): string {
  const text = readFileSync(POLICY, "utf8");
  const start = text.indexOf(`\n${WORKER_KNOWLEDGE_START}\n`) + WORKER_KNOWLEDGE_START.length + 2;
  const end = text.indexOf(`\n${WORKER_KNOWLEDGE_END}\n`);
  expect(start).toBeGreaterThan(WORKER_KNOWLEDGE_START.length + 1);
  expect(end).toBeGreaterThan(start);
  return text.slice(start, end);
}

interface Invocation { provider: "claude" | "codex"; argv: string[]; stdin: string; env: Record<string, string | null>; outcome: string | null }

const roots: string[] = [];
let root = "", home = "", bin = "", log = "", data = "", workspace = "";

// 받은 argv·stdin·홈 환경을 호출마다 파일로 남기고 정해진 결과를 낸다. 결과 형식은 어댑터가 넘긴 출력 스키마(Claude --json-schema, Codex
// --output-schema 파일)로 고른다 — outcome 이 있는 봉투 스키마면 그 역할의 첫 outcome 으로 유효한 봉투를, 아니면 기존 결과를 낸다.
function writeFakeProvider(directory: string, provider: "claude" | "codex", logDirectory: string): void {
  writeFileSync(join(directory, provider), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path');
const argv = process.argv.slice(2);
const schemaText = '${provider}' === 'claude' ? argv[argv.indexOf('--json-schema') + 1] : fs.readFileSync(argv[argv.indexOf('--output-schema') + 1], 'utf8');
const schema = JSON.parse(schemaText);
const outcome = schema.properties && schema.properties.outcome ? schema.properties.outcome.enum[0] : null;
const response = outcome === null ? ${JSON.stringify(RESULT)} : { message: 'fixture envelope', outcome, mediatorRequest: null, memoryUpdates: null,
  engineDefects: null, ...(schema.required.includes('planItems') ? { planItems: null } : {}) };
let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
  const env = {}; for (const key of ['HOME', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) env[key] = process.env[key] ?? null;
  const record = path.join(${JSON.stringify(logDirectory)}, Date.now() + '-' + process.pid + '-${provider}.json');
  fs.writeFileSync(record, JSON.stringify({ provider: '${provider}', argv, stdin: input, env, outcome }));
  const lines = '${provider}' === 'claude'
    ? [{ type: 'result', subtype: 'success', num_turns: 1, usage: { input_tokens: 4, output_tokens: 2 }, structured_output: response }]
    : [{ type: 'thread.started', thread_id: 'codex-thread-fixture' },
      outcome === null ? response : { type: 'item.completed', item: { type: 'agent_message', text: JSON.stringify(response) } }];
  for (const line of lines) console.log(JSON.stringify(line));
});
`, { mode: 0o755 });
}

function invocations(directory = log): Invocation[] {
  return readdirSync(directory).sort().map(name => JSON.parse(readFileSync(join(directory, name), "utf8")) as Invocation);
}

// 공급자가 실제로 받은 지시문 문맥 — Claude 는 stdin, Codex 는 developer_instructions 설정 값과 stdin.
function receivedContext(call: Invocation): string {
  const config = call.argv.find(arg => arg.startsWith("developer_instructions="));
  return [config ? JSON.parse(config.slice("developer_instructions=".length)) as string : "", call.stdin].join("\n");
}

function expectDelivered(call: Invocation, knowledge: string): void {
  const context = call.provider === "claude" ? call.stdin : receivedContext(call);
  expect(context.split(knowledge).length - 1).toBe(1);
  for (const label of PERSONAL_LABELS) expect(context).not.toContain(label);
  expectEmptyHome(call);
}

function expectAbsent(call: Invocation, knowledge: string): void {
  const context = receivedContext(call);
  expect(context).not.toContain(knowledge);
  expect(context).not.toContain("적용되는 지시문 시작:");
  expectEmptyHome(call);
}

// 공급자 프로세스가 본 홈은 이 테스트의 빈 임시 홈(또는 어댑터가 그 안팎에 만든 관리형 홈)이다 — 호스트 홈이 아니다.
function expectEmptyHome(call: Invocation): void {
  const forms = [root, realpathSync(root)];
  for (const [key, value] of Object.entries(call.env)) {
    if (value !== null) expect(forms.some(form => value.startsWith(form)), `${key}=${value}`).toBe(true);
  }
  expect(call.env.HOME).not.toBe(process.env.CR_TEST_HOST_HOME);
}

function adapters() {
  const runner = new SpawnCommandRunner();
  return {
    claude: new ClaudeAdapter(runner, undefined, { managedPluginDirectory: join(data, "claude-plugin"), protectedWritePaths: [data] }),
    codex: new CodexAdapter(runner, join(data, "agent-result.schema.json"), undefined, undefined, {}),
  };
}

function turnFor(job: TurnJob, extra: Record<string, unknown> = {}) {
  const flags = turnFlags(job);
  return { job, implementation: flags.implementation, protocolOnly: flags.protocolOnly, planMode: job.role === "planner" ? true : undefined,
    readablePaths: [], cwd: workspace, prompt: `fixture ${job.role}/${job.operation}`, settings: { model: "fixture-model", effort: "high" as const }, ...extra };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "cr-public-knowledge-")); roots.push(root);
  home = join(root, "home"); bin = join(root, "bin"); log = join(root, "received"); data = join(root, "data");
  workspace = join(data, "worktrees", "topic");
  // 빈 홈 — 전역 지침·메모리·skills 가 없는 새 사용자. 디렉터리만 있고 파일은 없다.
  for (const directory of [join(home, ".claude", "skills"), join(home, ".codex", "skills"), join(home, ".claude", "projects"), bin, log, workspace]) {
    mkdirSync(directory, { recursive: true });
  }
  writeFakeProvider(bin, "claude", log); writeFakeProvider(bin, "codex", log);
  vi.stubEnv("CR_TEST_HOST_HOME", process.env.HOME ?? "");
  vi.stubEnv("HOME", home);
  vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", join(home, ".claude"));
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
});

afterEach(() => {
  // 수신 요약(선택): 원문 대신 호출별 해시·정본 구간 등장 횟수·봉투 outcome 만 남긴다. 수신 기록 원본은 아래에서 임시 루트와 함께 지운다.
  const keep = process.env.CR_RECEIVED_EVIDENCE_DIR;
  if (keep && existsSync(log)) {
    const knowledge = canonicalSection();
    const sha = (text: string) => createHash("sha256").update(text).digest("hex");
    mkdirSync(keep, { recursive: true });
    appendFileSync(join(keep, "summary.jsonl"), `${JSON.stringify({ test: expect.getState().currentTestName, knowledgeSha256: sha(knowledge),
      calls: invocations().map(call => ({ provider: call.provider, outcome: call.outcome, stdinSha256: sha(call.stdin),
        receivedContextSha256: sha(receivedContext(call)), canonicalOccurrences: receivedContext(call).split(knowledge).length - 1,
        revisionA: receivedContext(call).includes(REVISION_A), revisionB: receivedContext(call).includes(REVISION_B) })) })}\n`);
  }
  vi.unstubAllEnvs();
  for (const directory of roots.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const REVISION_A = "PUBLIC_KNOWLEDGE_REVISION_A";
const REVISION_B = "PUBLIC_KNOWLEDGE_REVISION_B";

// 정책 본문 판 — 정본 구간 첫 줄에 판 표식을 넣는다. 반환값은 그 판의 구간 본문(공급자가 받아야 할 바이트)이다.
function writePolicyRevision(path: string, revision: string): string {
  const text = readFileSync(POLICY, "utf8").replace(`${WORKER_KNOWLEDGE_START}\n`, `${WORKER_KNOWLEDGE_START}\n${revision}\n`);
  writeFileSync(path, text);
  return `${revision}\n${canonicalSection()}`;
}

const ROLES: TurnJob[] = [
  { role: "planner", operation: "plan" }, { role: "reviewer", operation: "audit" },
  { role: "implementer", operation: "implement" }, { role: "reviewer", operation: "review" },
];

describe("공개 공통 작업 지식 — 실제 어댑터 입력 전달", () => {
  it("정본 구간은 standalone 표식 한 쌍 사이 바이트이고, 리더는 그 본문을 개인 지침 없이도 첫 블록으로 싣는다", async () => {
    const knowledge = canonicalSection();
    expect(extractWorkerKnowledge(readFileSync(POLICY, "utf8"))).toBe(knowledge);
    const { blocks } = await readAppliedInstructions({ workspace, fileName: "CLAUDE.md", globalPath: join(home, ".claude", "CLAUDE.md"), injectWorkspaceFile: true });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].split(knowledge).length - 1).toBe(1);
    // 개인 전역 지침이 생기면 공통 지식 뒤에 붙고, 공통 지식은 그대로 첫 블록이다.
    writeFileSync(join(home, ".claude", "CLAUDE.md"), "PERSONAL_GLOBAL_RULE");
    const withPersonal = await readAppliedInstructions({ workspace, fileName: "CLAUDE.md", globalPath: join(home, ".claude", "CLAUDE.md"), injectWorkspaceFile: true });
    expect(withPersonal.blocks[0]).toBe(blocks[0]);
    expect(withPersonal.blocks[1]).toContain("PERSONAL_GLOBAL_RULE");
  });

  it("표식이 없거나 비었거나 중복·역순이면 조용히 빼지 않고 실패한다", () => {
    const body = "## 본문";
    expect(() => extractWorkerKnowledge("# 정책\n본문만 있음")).toThrow(/정확히 한 쌍/);
    expect(() => extractWorkerKnowledge(`${WORKER_KNOWLEDGE_START}\n  \n${WORKER_KNOWLEDGE_END}`)).toThrow(/비어 있습니다/);
    expect(() => extractWorkerKnowledge(`${WORKER_KNOWLEDGE_START}\n${body}\n${WORKER_KNOWLEDGE_END}\n${WORKER_KNOWLEDGE_START}\n${body}\n${WORKER_KNOWLEDGE_END}`)).toThrow(/정확히 한 쌍/);
    expect(() => extractWorkerKnowledge(`${WORKER_KNOWLEDGE_END}\n${body}\n${WORKER_KNOWLEDGE_START}`)).toThrow(/앞에 있습니다/);
    // 문장 안에서 표식을 언급한 줄은 경계가 아니다.
    expect(() => extractWorkerKnowledge(`예: \`${WORKER_KNOWLEDGE_START}\`\n${body}`)).toThrow(/정확히 한 쌍/);
    expect(extractWorkerKnowledge(`앞\r\n${WORKER_KNOWLEDGE_START}\r\n${body}\r\n${WORKER_KNOWLEDGE_END}\r\n뒤`)).toBe(body);
  });

  for (const job of ROLES) {
    for (const provider of ["claude", "codex"] as const) {
      it(`${provider} ${job.role}/${job.operation}: 봉투 생성 턴과 영수증 없는 봉투 재개 턴의 공급자 입력에 정본 구간 전체가 한 번 실린다`, async () => {
        const knowledge = canonicalSection();
        const adapter = adapters()[provider];
        const created = await invokeAdapter(adapter, { method: "create-envelope", turn: turnFor(job) });
        const resumed = await invokeAdapter(adapter, { method: "resume-envelope",
          turn: { ...turnFor(job), sessionId: provider === "claude" ? randomUUID() : "codex-thread-fixture" } });
        const calls = invocations();
        expect(calls.map(call => call.provider)).toEqual([provider, provider]);
        // 가짜 공급자는 어댑터가 넘긴 이 역할의 봉투 스키마로 답했고, 어댑터는 그 봉투를 이 역할의 결과로 받아들였다.
        const outcomes = calls.map(call => call.outcome);
        expect(outcomes[0]).not.toBeNull();
        expect([created.envelope.outcome, resumed.outcome]).toEqual(outcomes);
        expect(envelopeRole(job)).not.toBeNull();
        for (const call of calls) expectDelivered(call, knowledge);
      });
    }
  }

  it("임시 소스 사본의 정책을 A→B 로 바꾸면 같은 어댑터의 다음 턴이 B 만 받고, 바뀌지 않은 Claude 재개는 다시 보내지 않으며, 깨지거나 없는 정본은 공급자 전에 실패한다", async () => {
    // 공용 작업 트리의 정책은 건드리지 않는다. src 와 실행 설정을 임시 사본으로 옮기고 의존성만 링크해, 사본의 실제 리더가 사본의 정책을 읽게 한다.
    const copy = join(root, "source");
    cpSync(join(SOURCE, "src"), join(copy, "src"), { recursive: true });
    for (const name of ["package.json", "tsconfig.json"]) cpSync(join(SOURCE, name), join(copy, name));
    symlinkSync(realpathSync(join(SOURCE, "node_modules")), join(copy, "node_modules"), "dir");
    mkdirSync(join(copy, "docs", "mediation"), { recursive: true });
    const policy = join(copy, "docs", "mediation", "policy.md");
    const load = <T>(path: string): Promise<T> => import(/* @vite-ignore */ pathToFileURL(join(copy, "src", path)).href) as Promise<T>;
    const { ClaudeAdapter: CopiedClaude } = await load<typeof import("../src/server/adapters/claude")>("server/adapters/claude.ts");
    const { CodexAdapter: CopiedCodex } = await load<typeof import("../src/server/adapters/codex")>("server/adapters/codex.ts");
    const { SpawnCommandRunner: CopiedRunner } = await load<typeof import("../src/server/processRunner")>("server/processRunner.ts");
    const { invokeAdapter: copiedInvoke } = await load<typeof import("../src/server/runtime/invoke")>("server/runtime/invoke.ts");
    const runner = new CopiedRunner();
    const claude = new CopiedClaude(runner, undefined, { managedPluginDirectory: join(data, "claude-plugin"), protectedWritePaths: [data] });
    const codex = new CopiedCodex(runner, join(data, "agent-result.schema.json"), undefined, undefined, {});
    const job: TurnJob = { role: "implementer", operation: "implement" };
    const bodyA = writePolicyRevision(policy, REVISION_A);
    const { sessionId } = await copiedInvoke(claude, { method: "create-envelope", turn: turnFor(job) });
    await copiedInvoke(codex, { method: "create-envelope", turn: turnFor(job) });
    await copiedInvoke(claude, { method: "resume-envelope", turn: { ...turnFor(job), sessionId } });
    const receipts = join(data, "claude-plugin", "instruction-receipts");
    const [receipt] = readdirSync(receipts);
    const receiptA = readFileSync(join(receipts, receipt), "utf8");
    expect(receiptA).toMatch(/^[0-9a-f]{64}$/);
    const bodyB = writePolicyRevision(policy, REVISION_B);
    await copiedInvoke(claude, { method: "resume-envelope", turn: { ...turnFor(job), sessionId } });
    await copiedInvoke(codex, { method: "resume-envelope", turn: { ...turnFor(job), sessionId: "codex-thread-fixture" } });
    const [claudeA, codexA, claudeUnchanged, claudeB, codexB] = invocations();
    expect([claudeA, codexA, claudeUnchanged, claudeB, codexB].map(call => call.provider)).toEqual(["claude", "codex", "claude", "claude", "codex"]);
    for (const call of [claudeA, codexA]) expectDelivered(call, bodyA);
    expect(claudeUnchanged.stdin).not.toContain(REVISION_A);
    expect(claudeUnchanged.stdin).not.toContain("적용되는 지시문 시작:");
    for (const call of [claudeB, codexB]) {
      expectDelivered(call, bodyB);
      expect(receivedContext(call)).not.toContain(REVISION_A);
    }
    // 같은 세션의 영수증은 자연 갱신된다 — 테스트는 영수증 파일을 쓰지 않았다.
    expect(readdirSync(receipts)).toEqual([receipt]);
    expect(readFileSync(join(receipts, receipt), "utf8")).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(join(receipts, receipt), "utf8")).not.toBe(receiptA);

    // 깨진 표식·없는 정본: 사본의 실제 리더·어댑터가 공급자를 띄우기 전에 실패한다.
    const before = invocations().length;
    writeFileSync(policy, `${readFileSync(policy, "utf8")}\n${WORKER_KNOWLEDGE_START}\n중복\n${WORKER_KNOWLEDGE_END}\n`);
    await expect(copiedInvoke(claude, { method: "resume-envelope", turn: { ...turnFor(job), sessionId } })).rejects.toThrow(/정확히 한 쌍/);
    await expect(copiedInvoke(codex, { method: "create-envelope", turn: turnFor(job) })).rejects.toThrow(/정확히 한 쌍/);
    rmSync(policy);
    await expect(copiedInvoke(claude, { method: "resume-envelope", turn: { ...turnFor(job), sessionId } })).rejects.toThrow(/정본을 읽지 못했습니다/);
    await expect(copiedInvoke(codex, { method: "create-envelope", turn: turnFor(job) })).rejects.toThrow(/정본을 읽지 못했습니다/);
    expect(invocations()).toHaveLength(before);
  }, 30_000);

  it("프로토콜 확인 턴과 Codex 격리 턴에는 싣지 않고, Claude 격리 턴은 공급자를 띄우기 전에 거부한다", async () => {
    const knowledge = canonicalSection();
    const { claude, codex } = adapters();
    await claude.createSession(turnFor({ role: "planner", operation: "ack" }, { readablePaths: undefined }));
    await codex.createSession(turnFor({ role: "reviewer", operation: "ack" }, { readablePaths: undefined }));
    await codex.createSession(turnFor({ role: "reviewer", operation: "review" }, { isolated: true }));
    await expect(claude.createSession(turnFor({ role: "reviewer", operation: "review" }, { isolated: true }))).rejects.toThrow(/격리 입력/);
    const calls = invocations();
    expect(calls.map(call => call.provider)).toEqual(["claude", "codex", "codex"]);
    for (const call of calls) expectAbsent(call, knowledge);
    expect(calls[2].stdin.trim()).toBe("fixture reviewer/review");
  });
});

describe("독립 번들 — 소스 체크아웃 없는 위치의 공급자 수신", () => {
  it("빌더가 내장한 같은 구간을 일반 턴에 싣고 격리 턴에는 싣지 않는다", async () => {
    const knowledge = canonicalSection();
    // CLI 진입 확인은 argv 경로와 import.meta.url(실제 경로)을 비교한다 — 설치기처럼 링크를 푼 실제 경로로 실행한다.
    const release = join(realpathSync(root), "release");
    mkdirSync(release);
    const bundle = join(release, "agent-runtime.mjs");
    execFileSync(process.execPath, [join(SOURCE, "scripts", "build-agent-runtime.mjs"), "--out", bundle], { cwd: SOURCE, stdio: "pipe" });
    // 번들 옆에는 소스·정책 문서·node_modules 가 없다.
    for (const missing of ["docs", "src", "node_modules", join("..", "docs"), join("..", "..", "docs")]) expect(existsSync(join(release, missing))).toBe(false);
    const repo = join(root, "repo");
    mkdirSync(repo);
    execFileSync("git", ["-C", repo, "init", "-q"], { stdio: "pipe" });
    const environment: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH ?? ""}`, HOME: home, CODEX_HOME: join(home, ".codex"),
      CLAUDE_CONFIG_DIR: join(home, ".claude"), TMPDIR: process.env.TMPDIR };
    const run = (request: object) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const child = spawn(process.execPath, [bundle, "--data-directory", join(root, "bundle-data")], { cwd: release, env: environment, stdio: "pipe" });
      let stdout = "", stderr = "";
      child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
      child.stdout.on("data", value => stdout += value); child.stderr.on("data", value => stderr += value);
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
      child.stdin.end(JSON.stringify(request));
    });
    const base = { version: 1, session: { mode: "create" }, resultKind: "agent", cwd: repo, settings: { model: "fixture-model", effort: "high" } };
    const runs = [
      await run({ ...base, requestId: "bundle-claude", provider: "claude", job: { role: "implementer", operation: "implement" },
        prompt: "bundle claude", providerOptions: { ultracode: false } }),
      await run({ ...base, requestId: "bundle-codex", provider: "codex", job: { role: "reviewer", operation: "review" }, prompt: "bundle codex" }),
      await run({ ...base, requestId: "bundle-codex-isolated", provider: "codex", job: { role: "reviewer", operation: "review" },
        prompt: "bundle isolated", isolated: true }),
    ];
    for (const result of runs) expect(result.code, result.stderr + result.stdout).toBe(0);
    const calls = invocations();
    expect(calls.map(call => call.provider)).toEqual(["claude", "codex", "codex"]);
    expectDelivered(calls[0], knowledge);
    expectDelivered(calls[1], knowledge);
    expectAbsent(calls[2], knowledge);
    expect(calls[2].stdin.trim()).toBe("bundle isolated");
  }, 60_000);
});
