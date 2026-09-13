import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionMetrics, codexHomeUsage, exceededLimits } from "../src/server/adapters/executionMetrics";

describe("실행별 사용량 계측", () => {
  it("같은 응답 ID를 두 번 받아도 누적 요청을 중복 기록하지 않는다", () => {
    const meter = new ExecutionMetrics("codex", 42, "gpt-test", "high", false, Date.now());
    const event = { type: "turn.completed", response_id: "r1", usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 } };
    meter.observe(event);
    meter.observe(event);
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputBytes: 42, inputTokens: 10, outputTokens: 3, internalRequests: 1, completeness: "complete" });
  });

  it("서로 다른 응답의 사용량은 각각 보존해 합산한다", () => {
    const meter = new ExecutionMetrics("codex", 42, "gpt-test", "high", false, Date.now());
    meter.observe({ type: "turn.completed", response_id: "r1", usage: { input_tokens: 10, output_tokens: 3 } });
    meter.observe({ type: "turn.completed", response_id: "r2", usage: { input_tokens: 20, output_tokens: 4 } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 30, outputTokens: 7, internalRequests: 2 });
  });

  it("Claude assistant 응답 사용량은 final result 전에 수집해 abort 뒤에도 남긴다", () => {
    const meter = new ExecutionMetrics("claude", 42, "fable", "high", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 4, output_tokens: 2 } } });
    meter.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 6, output_tokens: 3 } } });
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 4, output_tokens: 2 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 10, outputTokens: 5, internalRequests: 2, completeness: "partial" });
  });

  it("Claude final cumulative usage는 이미 받은 assistant response에 더하지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 2 } } });
    meter.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 2 }, num_turns: 1 });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 5, outputTokens: 2, internalRequests: 1, modelTurns: 1, completeness: "complete" });
  });

  it("Claude final cumulative usage는 여러 assistant 관측을 정확히 대체한다", () => {
    const meter = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 4, output_tokens: 2 } } });
    meter.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 6, output_tokens: 3 } } });
    meter.observe({ type: "result", usage: { input_tokens: 9, output_tokens: 6 }, num_turns: 2 });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({
      inputTokens: 9, outputTokens: 6, internalRequests: 2, completeness: "complete",
    });
  });

  it("불완전한 Claude final은 앞서 관측한 토큰 필드를 지우지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 13, cache_read_input_tokens: 3, output_tokens: 4 } } });
    meter.observe({ type: "result", usage: { output_tokens: 8 }, num_turns: 1 });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({
      inputTokens: 16, cachedInputTokens: 3, outputTokens: 8, completeness: "partial",
    });
  });

  it("동일 Claude 메시지의 갱신·재전송·역순과 누락 필드를 병합한다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    const event = (usage: Record<string, number>) => ({ type: "assistant", message: { id: "m1", usage } });
    const first = event({ input_tokens: 10, output_tokens: 2 });
    meter.observe(first);
    meter.observe(event({ cache_read_input_tokens: 20, output_tokens: 2637 }));
    meter.observe(first);
    meter.observe(event({ output_tokens: 2637 }));
    meter.observe({ type: "assistant", message: { id: "m2", usage: { output_tokens: 3 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({
      inputTokens: 30, cachedInputTokens: 20, outputTokens: 2640, internalRequests: 2, completeness: "partial",
    });
  });

  it("최종 result 후 버퍼의 미관측 assistant도 최종 합계를 바꾸지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 8 } });
    meter.observe({ type: "assistant", message: { id: "late", usage: { output_tokens: 3 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final").outputTokens).toBe(8);
  });

  it("Claude 부분 스트림의 message_delta로 출력 갱신을 수집하고 result 불일치를 드러낸다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    const start = { type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 2 } } } };
    const delta = { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 2637 } } };
    meter.observe(start); meter.observe(delta);
    meter.observe({ type: "stream_event", event: { type: "message_stop" } });
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, output_tokens: 2 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "progress").outputTokens).toBe(2637);
    meter.observe({ type: "result", usage: { input_tokens: 10, output_tokens: 52 } });
    meter.observe(start); meter.observe(delta);
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({
      outputTokens: 52, completeness: "partial", sourceUsage: {
        status: "mismatch", cli: { outputTokens: 52 }, claudeStream: { outputTokens: 2637 },
      },
    });
  });

  it("final source 뒤에는 진행 이벤트를 다시 만들지 않는다", () => {
    const meter = new ExecutionMetrics("codex", 1, "gpt", "low", false, Date.now());
    meter.observe({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    expect(meter.hasFinalSource()).toBe(true);
  });

  it("토큰 이벤트가 없는 취소 구간은 0 토큰으로 위장하지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 9, "fable", "high", true, Date.now());
    meter.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1" }] } });
    const usage = meter.snapshot({ toolDurationMs: 1, toolCalls: 1 }, "final");
    expect(usage).toMatchObject({ completeness: "partial", toolCalls: 1 });
    expect(usage.inputTokens).toBeUndefined();
    expect(usage.outputTokens).toBeUndefined();
  });

  it("미설정 한도는 평가하지 않고 완료 시 토큰 경고 시점을 구분한다", () => {
    const warnings = exceededLimits({ inputTokens: 11, outputTokens: 2, durationMs: 5, recordKind: "final" } as never, { inputTokens: 10 });
    expect(warnings).toEqual([{ key: "inputTokens", value: 11, limit: 10, timing: "completion" }]);
  });

  it("Codex home 중복 레코드는 한 번만 대조하고 모르는 토큰을 0으로 채우지 않는다", async () => {
    const home = await mkdtemp(join(tmpdir(), "consensus-home-usage-"));
    try {
      const sessionId = "thread-1";
      await mkdir(join(home, "sessions"), { recursive: true });
      const timestamp = new Date().toISOString();
      const record = { type: "token_usage_record", timestamp, payload: {
        thread_id: sessionId, response_id: "response-1", usage: { input_tokens: 12, output_tokens: 3 },
      } };
    await writeFile(join(home, "sessions", `${sessionId}.jsonl`), `${JSON.stringify(record)}\n${JSON.stringify({ ...record, timestamp: new Date(Date.now() + 1).toISOString() })}\n`);
      await expect(codexHomeUsage(home, sessionId, Date.now() - 1_000, Date.now() + 1_000)).resolves.toEqual({
        inputTokens: 12, outputTokens: 3, source: "codex-home",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  it("Codex home의 같은 response 부분 레코드는 필드별로 합산한다", async () => {
    const home = await mkdtemp(join(tmpdir(), "consensus-home-usage-"));
    try {
      const sessionId = "thread-2";
      await mkdir(join(home, "sessions"), { recursive: true });
      const timestamp = new Date().toISOString();
      const record = (usage: Record<string, number>) => ({ type: "token_usage_record", timestamp, payload: {
        thread_id: sessionId, response_id: "response-2", usage,
      } });
      await writeFile(join(home, "sessions", `${sessionId}.jsonl`), [
        record({ input_tokens: 10, cached_input_tokens: 3, output_tokens: 2 }),
        record({ output_tokens: 7 }),
        record({ input_tokens: 5, output_tokens: 1 }),
      ].map((item) => JSON.stringify(item)).join("\n"));
      await expect(codexHomeUsage(home, sessionId, Date.now() - 1_000, Date.now() + 1_000)).resolves.toEqual({
        inputTokens: 15, cachedInputTokens: 3, outputTokens: 10, source: "codex-home",
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});


it("최종 input 일부만 주어져도 앞선 캐시 생성·읽기 관측을 지우지 않는다", () => {
  const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
  meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 2 } } });
  meter.observe({ type: "result", usage: { input_tokens: 11, output_tokens: 3 } });
  expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 61, cachedInputTokens: 20, outputTokens: 3 });
});

it("익명화한 실제 실패 실행 transcript의 입력 범위와 출력 합계를 재현한다", () => {
  // 2026-09-13 06:26:42–06:28:43 UTC. 원본 stdout이 아닌 transcript의 usage만 보존.
  // DB 입력 1,315,697과 일치한다. DB 출력 52와 마지막 메시지 2,637은 서로 다른 집계 범위다.
  const rows = [
    [2, 37201, 98854, 2245], [2, 5236, 136055, 614], [2, 897, 141291, 275],
    [2, 474, 142188, 449], [2, 2231, 142662, 862], [2, 2388, 144893, 997],
    [2, 3376, 147281, 882], [2, 1666, 150657, 275], [2, 6006, 152323, 2637],
  ];
  const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
  for (const [index, [input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens]] of rows.entries()) {
    const event = { type: "assistant", message: { id: `anonymous-${index}`, usage: { input_tokens, cache_creation_input_tokens, cache_read_input_tokens, output_tokens } } };
    meter.observe(event); meter.observe(event);
  }
  expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 1315697, outputTokens: 9236, internalRequests: 9, completeness: "partial" });
});


it("불일치 진단의 CLI 원본에는 final이 실제로 준 필드만 보관한다", () => {
  const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
  meter.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 2 } } } });
  meter.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 15 } } });
  meter.observe({ type: "result", usage: { input_tokens: 11, output_tokens: 3 } });
  const usage = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
  expect(usage).toMatchObject({ inputTokens: 61, cachedInputTokens: 20, outputTokens: 3, completeness: "partial" });
  expect(usage.sourceUsage?.cli).toEqual({ inputTokens: 11, outputTokens: 3 });
  expect(usage.sourceUsage?.claudeStream).toEqual({ inputTokens: 60, cachedInputTokens: 20, outputTokens: 15 });
});
