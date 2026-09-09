import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { describeCommandFailure, parseAgentResult } from "../src/server/adapters/resultParser";
import { SpawnCommandRunner } from "../src/server/processRunner";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const firstResult = {
  kind: "AUDIT",
  summary: "첫 검토",
  findings: [],
  evidenceRefs: [],
};

const finalResult = {
  kind: "CLOSEOUT",
  summary: "마지막 검토",
  findings: [
    {
      id: "F-1",
      title: "오래된 결과",
      severity: "MEDIUM",
      disposition: "REFUTED",
      rationale: "현재 코드에서는 재현되지 않습니다.",
      evidenceRefs: ["src/model.ts:12"],
      requiresUserDecision: false,
    },
  ],
  evidenceRefs: ["src/model.ts:12"],
};

describe("CLI JSONL 처리", () => {
  it("가짜 CLI가 여러 조각과 잘못된 JSON을 섞어 보내도 마지막 계약 결과를 읽는다", async () => {
    const script = [
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(firstResult)}\n`)});`,
      `process.stdout.write(${JSON.stringify('{"type":"progress"}\n')});`,
      `process.stdout.write(${JSON.stringify('{"broken":\n')});`,
      `process.stdout.write(${JSON.stringify(`${JSON.stringify({ result: finalResult })}\n`)});`,
    ].join("");
    const runner = new SpawnCommandRunner();

    const command = await runner.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
    });
    const parsed = parseAgentResult(command.jsonLines, command.stdout);

    expect(command.exitCode).toBe(0);
    expect(command.stdout).toContain('{"broken":');
    expect(parsed).toMatchObject({ kind: "CLOSEOUT", summary: "마지막 검토" });
    expect(parsed.findings).toHaveLength(1);
  });

  it("같은 종류의 결과가 중복되면 가장 나중에 완결된 결과를 사용한다", () => {
    const parsed = parseAgentResult([firstResult, finalResult], "");

    expect(parsed.summary).toBe("마지막 검토");
  });

  it("잘린 마지막 줄만 있고 완결된 계약 결과가 없으면 성공으로 처리하지 않는다", () => {
    expect(() => parseAgentResult([{ type: "progress" }], '{"kind":"PLAN"')).toThrow(
      "계약된 구조",
    );
  });

  it("에이전트 메시지 안의 JSON 코드 블록도 같은 계약으로 검증한다", () => {
    const candidate = {
      item: {
        type: "agent_message",
        text: `결과입니다.\n\`\`\`json\n${JSON.stringify(finalResult)}\n\`\`\``,
      },
    };

    expect(parseAgentResult([candidate], "")).toMatchObject({
      kind: "CLOSEOUT",
      summary: "마지막 검토",
    });
  });

  // AgentResultJsonSchema가 선택 필드를 "required + null 허용"으로 표현하므로 모델은 값이 없을 때
  // null을 보낸다. 아래 문자열은 실제 codex(gpt-5.6-sol)가 --output-schema로 돌려준 응답이다(2026-08-29).
  it("선택 필드가 null인 구조화 응답도 파싱한다", () => {
    // planEdits:null 누락이 2026-08-31 closeout 재실행을 통째로 거부시켰다(스키마에 키를 추가하며
    // OPTIONAL_KEYS 갱신을 빠뜨림). 스키마의 null 허용 키는 반드시 이 테스트에도 함께 추가한다.
    const text = '{"kind":"AUDIT","summary":"probe","planMarkdown":null,"planEdits":null,"planSHA256":null,'
      + '"findings":[],"evidenceRefs":[],"requestedUserDecision":null,"memoryUpdates":null}';

    const parsed = parseAgentResult([{ item: { type: "agent_message", text } }], "");

    expect(parsed).toMatchObject({ kind: "AUDIT", summary: "probe", findings: [], evidenceRefs: [] });
    expect(parsed.planMarkdown).toBeUndefined();
    expect(parsed.planEdits).toBeUndefined();
    expect(parsed.memoryUpdates).toBeUndefined();
  });

  // stderr만 담으면 "실행 실패(1): "만 남아 스키마 거부인지 사용량 소진인지 구별할 수 없다.
  it("실패 메시지에 stdout 꼬리를 실어 원인을 남긴다", () => {
    const stdout = [
      '{"type":"turn.started"}',
      '{"type":"error","message":"invalid_json_schema: Missing \'disposition\'"}',
    ].join("\n");

    const message = describeCommandFailure("Codex", 1, "", stdout);

    expect(message).toContain("Codex 실행 실패(1)");
    expect(message).toContain("invalid_json_schema");
  });

  it("stderr와 stdout이 둘 다 비어도 빈 사유를 남기지 않는다", () => {
    expect(describeCommandFailure("Claude", 1, "", "")).toContain("stderr와 stdout 모두 비어 있습니다");
  });

  // 아래는 실제로 이 방에서 fable 턴을 죽인 응답이다(2026-08-29). 원장에는 4KB짜리 JSON 꼬리가 아니라
  // 사람이 읽을 한 줄이 남아야 사용량 소진과 계약 위반을 구별할 수 있다.
  it("사용량 한도로 죽으면 그 문장과 상태 코드를 뽑아낸다", () => {
    const stdout = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"무관한 앞줄"}]}}',
      JSON.stringify({
        type: "result",
        is_error: true,
        api_error_status: 429,
        result: "You've hit your org's monthly spend limit · your session limit resets 10:50am (Asia/Seoul)",
      }),
    ].join("\n");

    const message = describeCommandFailure("Claude", 1, "", stdout);

    expect(message).toContain("monthly spend limit");
    expect(message).toContain("429");
    // 원인 한 줄이면 충분하다 — JSON 덩어리를 그대로 싣지 않는다.
    expect(message.length).toBeLessThan(400);
  });

  it("finding의 disposition이 null이어도 파싱하고, expectedSHA256의 null은 값으로 보존한다", () => {
    const text = JSON.stringify({
      kind: "PLAN",
      summary: "계획",
      planMarkdown: "# 계획",
      planSHA256: null,
      findings: [{
        id: "F1", title: "t", severity: "LOW", disposition: null,
        rationale: "r", evidenceRefs: [], requiresUserDecision: false,
      }],
      evidenceRefs: [],
      requestedUserDecision: null,
      // expectedSHA256는 null이 "새 파일"을 뜻하는 유효한 값이라 지우면 안 된다.
      memoryUpdates: [{ path: "a.md", expectedSHA256: null, content: "본문", reason: "이유" }],
    });

    const parsed = parseAgentResult([{ item: { type: "agent_message", text } }], "");

    expect(parsed.findings[0].disposition).toBeUndefined();
    expect(parsed.memoryUpdates?.[0].expectedSHA256).toBeNull();
  });
});

// 감사 ④: CLI가 stdin을 읽기 전에 종료하면 write EPIPE가 스트림 'error'로 올라오는데,
// 리스너가 없으면 프로세스 전역 예외가 되어 서버가 통째로 죽는다.
describe("stdin 조기 종료", () => {
  it("자식이 stdin을 받기 전에 종료해도 서버가 죽지 않고 exit code로 정리한다", async () => {
    const runner = new SpawnCommandRunner();
    const bigInput = "x".repeat(512 * 1024); // 파이프 버퍼를 확실히 넘기는 크기

    const result = await runner.run({
      command: process.execPath,
      args: ["-e", "process.exit(7)"], // stdin을 읽지 않고 즉시 종료
      cwd: process.cwd(),
      stdin: bigInput,
    });

    expect(result.exitCode).toBe(7);
  });
});

describe("CLI 취소", () => {
  it("사용자가 실행 중지를 누르면 가짜 CLI를 끝내고 결과를 성공으로 반환하지 않는다", async () => {
    const controller = new AbortController();
    const runner = new SpawnCommandRunner();
    const pending = runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      signal: controller.signal,
    });

    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });

  it("프로세스 기록 callback이 실패해도 이미 뜬 CLI를 고아로 남기지 않는다", async () => {
    const runner = new SpawnCommandRunner();
    let spawnedPID = 0;
    const pending = runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      onSpawn: (spawned) => {
        spawnedPID = spawned.pid;
        throw new Error("PID 원장 기록 실패");
      },
    });

    await expect(pending).rejects.toThrow("PID 원장 기록 실패");
    await waitUntil(() => spawnedPID > 0 && !isRunning(spawnedPID));
    expect(isRunning(spawnedPID)).toBe(false);
  });

  it("사용자가 중단하면 CLI가 만든 자식 프로세스까지 같은 process group에서 종료한다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-process-group-"));
    temporaryDirectories.push(root);
    const pidFile = join(root, "pids.json");
    const controller = new AbortController();
    const runner = new SpawnCommandRunner();
    let parentPID = 0;
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const pending = runner.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: root,
      signal: controller.signal,
      onSpawn: (process) => { parentPID = process.pid; },
    });

    await waitUntil(() => {
      try { return Boolean(readFileSync(pidFile, "utf8")); } catch { return false; }
    });
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number };
    expect(pids.parent).toBe(parentPID);

    controller.abort(new Error("테스트 중단"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    await waitUntil(() => !isRunning(pids.parent) && !isRunning(pids.child));

    expect(isRunning(pids.parent)).toBe(false);
    expect(isRunning(pids.child)).toBe(false);
  });

  it("직속 자식이 먼저 죽어도 SIGTERM을 무시한 손자는 SIGKILL 승격으로 끝낸다", async () => {
    const root = mkdtempSync(join(tmpdir(), "consensus-room-sigkill-promotion-"));
    temporaryDirectories.push(root);
    const pidFile = join(root, "pids.json");
    const readyFile = join(root, "ready");
    const controller = new AbortController();
    const runner = new SpawnCommandRunner();
    // 손자가 SIGTERM 핸들러를 실제로 등록한 뒤에 ready를 남긴다. 부팅 중 SIGTERM을 받으면
    // 기본 동작으로 죽어 버려 승격 경로를 검증하지 못한다.
    const stubborn = [
      "process.on('SIGTERM', () => {});",
      `require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const script = [
      "const { spawn } = require('node:child_process');",
      "const { writeFileSync } = require('node:fs');",
      `const child = spawn(process.execPath, ['-e', ${JSON.stringify(stubborn)}], { stdio: 'ignore' });`,
      `writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ parent: process.pid, child: child.pid }));`,
      "setInterval(() => {}, 1000);",
    ].join("\n");
    const pending = runner.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: root,
      signal: controller.signal,
    });

    await waitUntil(() => existsSync(readyFile) && existsSync(pidFile));
    const pids = JSON.parse(readFileSync(pidFile, "utf8")) as { parent: number; child: number };

    controller.abort(new Error("테스트 중단"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });

    // 실행이 끝난 시점에는 group이 이미 비어 있어야 한다. 승격이 분리된 타이머로 나중에 돌면
    // 여기서 손자가 아직 살아 있어 실패한다 — "프로세스가 실제로 닫힐 때까지 running 유지" 계약의 본체다.
    expect(isRunning(pids.parent)).toBe(false);
    expect(isRunning(pids.child)).toBe(false);
  });

  it("중단 뒤 process group이 이미 비었으면 SIGKILL을 보내지 않는다", async () => {
    const killSpy = vi.spyOn(process, "kill");
    const controller = new AbortController();
    const runner = new SpawnCommandRunner();
    let spawnedPID = 0;
    const pending = runner.run({
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
      signal: controller.signal,
      onSpawn: (spawned) => { spawnedPID = spawned.pid; },
    });

    expect(spawnedPID).toBeGreaterThan(0);
    controller.abort(new Error("테스트 중단"));
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(isRunning(spawnedPID)).toBe(false);

    // drain은 group 생존을 signal 0으로 여러 번 확인할 수 있지만, 비어 있으면 SIGKILL은 절대 보내지 않는다.
    const signals = groupSignals(killSpy.mock.calls, spawnedPID);
    expect(signals[0]).toBe("SIGTERM");
    expect(signals).not.toContain("SIGKILL");
    expect(signals.slice(1).every((signal) => signal === 0)).toBe(true);
  });
});

describe("프로세스 신원 기록", () => {
  it("서버 로케일이 한국어여도 시작 시각을 로케일 중립 포맷으로 남긴다", async () => {
    const originalLocale = process.env.LC_ALL;
    process.env.LC_ALL = "ko_KR.UTF-8";
    let startedAt = "";
    try {
      await new SpawnCommandRunner().run({
        command: process.execPath,
        args: ["-e", "setTimeout(() => {}, 300)"],
        cwd: process.cwd(),
        onSpawn: (spawned) => { startedAt = spawned.startedAt; },
      });
    } finally {
      if (originalLocale === undefined) delete process.env.LC_ALL;
      else process.env.LC_ALL = originalLocale;
    }

    expect(startedAt).toMatch(C_LOCALE_START_TIME);
  });
});

describe("CLI 출력 상한", () => {
  it("장시간 에이전트 JSONL은 누적 8MB를 넘어도 끝의 계약 결과를 보존한다", async () => {
    const line = JSON.stringify({ type: "progress", body: "x".repeat(1_000) });
    const script = [
      `const line = ${JSON.stringify(`${line}\n`)};`,
      "for (let index = 0; index < 9_000; index += 1) process.stdout.write(line);",
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(finalResult)}\n`)});`,
    ].join("\n");
    const output = await new SpawnCommandRunner().run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
    });

    expect(parseAgentResult(output.jsonLines, output.stdout).summary).toBe("마지막 검토");
  });

  it("큰 JSON progress가 이어져도 파싱 결과 보관량을 바이트 단위로 제한한다", async () => {
    const script = [
      `process.stdout.write(${JSON.stringify(`${JSON.stringify({ type: "thread.started", thread_id: "thread-1" })}\n`)});`,
      "const progress = JSON.stringify({ type: 'progress', body: 'x'.repeat(1_000_000) }) + '\\n';",
      "for (let index = 0; index < 24; index += 1) process.stdout.write(progress);",
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(finalResult)}\n`)});`,
    ].join("\n");
    const output = await new SpawnCommandRunner().run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
    });

    const retainedBytes = output.jsonLines.reduce<number>(
      (total, value) => total + Buffer.byteLength(JSON.stringify(value), "utf8"),
      0,
    );
    expect(output.exitCode).toBe(0);
    expect(output.jsonLines[0]).toMatchObject({ type: "thread.started", thread_id: "thread-1" });
    expect(retainedBytes).toBeLessThanOrEqual(17 * 1024 * 1024);
    expect(parseAgentResult(output.jsonLines, output.stdout).summary).toBe("마지막 검토");
  });

  it("전체 출력이 필요한 호출은 명시한 상한을 넘으면 조용히 자르지 않고 실패한다", async () => {
    const script = "for (let i = 0; i < 20; i += 1) console.log('x'.repeat(100));";

    await expect(new SpawnCommandRunner().run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      maxOutputBytes: 1_024,
    })).rejects.toThrow("손실 없이");
  });
});

// C 로케일 `ps -o lstart=` 포맷: "Sun Aug 23 18:38:50 2026"
const C_LOCALE_START_TIME = /^[A-Za-z]{3} [A-Za-z]{3}\s+\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/;

function groupSignals(
  calls: readonly Parameters<typeof process.kill>[],
  pid: number,
): Array<string | number> {
  return calls.filter(([target]) => target === -pid).map(([, signal]) => signal ?? 0);
}

async function waitUntil(predicate: () => boolean, timeoutMilliseconds = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMilliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("조건을 기다리는 동안 제한 시간을 넘었습니다.");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error && typeof error === "object" && "code" in error && error.code === "ESRCH");
  }
}

describe("최종 결과 뒤 유휴 종료 (2026-09-03 hang 처방)", () => {
  it("결과 줄을 받은 뒤 타임아웃 안에 프로세스가 안 끝나면 종료시키고 exitCode 0 으로 정규화한다", async () => {
    const script = [
      `process.stdout.write(${JSON.stringify('{"type":"result","subtype":"success"}\n')});`,
      "setTimeout(() => {}, 30_000);",
    ].join("");
    const runner = new SpawnCommandRunner();
    const startedAt = Date.now();

    const command = await runner.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      finalResultTimeoutMs: 300,
      isFinalResult: (value) => typeof value === "object" && value !== null && (value as { type?: unknown }).type === "result",
    });

    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(command.exitCode).toBe(0);
    expect(command.terminatedAfterResult).toBe(true);
    expect(command.jsonLines).toContainEqual({ type: "result", subtype: "success" });
  });

  it("결과 줄 뒤 프로세스가 스스로 끝나면 타임아웃과 무관하게 원래 종료 코드를 쓴다", async () => {
    const script = `process.stdout.write(${JSON.stringify('{"type":"result"}\n')}); process.exit(3);`;
    const runner = new SpawnCommandRunner();

    const command = await runner.run({
      command: process.execPath,
      args: ["-e", script],
      cwd: process.cwd(),
      finalResultTimeoutMs: 5_000,
      isFinalResult: (value) => (value as { type?: unknown } | null)?.type === "result",
    });

    expect(command.exitCode).toBe(3);
    expect(command.terminatedAfterResult).toBeUndefined();
  });
});
