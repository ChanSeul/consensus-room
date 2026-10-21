import advisorFixture from "./fixtures/claude-advisor-usage.json";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionMetrics, codexHomeUsage, exceededLimits } from "../src/server/adapters/executionMetrics";
import { reportBackgroundFailure } from "../src/server/backgroundTask";

vi.mock("../src/server/backgroundTask", async importOriginal => ({
  ...(await importOriginal<typeof import("../src/server/backgroundTask")>()),
  reportBackgroundFailure: vi.fn(),
}));

describe("실행별 사용량 계측", () => {
  it("separates request peak from cumulative/cache input and leaves unobserved request sizes unknown", () => {
    const meter = new ExecutionMetrics("claude", 42, "test", "xhigh", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 10, cache_read_input_tokens: 90, output_tokens: 2 } } });
    meter.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 20, cache_read_input_tokens: 100, output_tokens: 3 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({
      inputTokens: 220, cachedInputTokens: 190, lastRequestInputTokens: 120, peakRequestInputTokens: 120,
    });
    const codex = new ExecutionMetrics("codex", 42, "test", "xhigh", false, Date.now());
    codex.observe({ type: "turn.completed", usage: { input_tokens: 220, output_tokens: 5 } });
    expect(codex.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final").peakRequestInputTokens).toBeUndefined();
  });
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
    meter.observe({ type: "result", usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 2 }, num_turns: 1 });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 5, outputTokens: 2, internalRequests: 1, modelTurns: 1, completeness: "complete" });
  });

  // CR Engine Advisor 자문 48: result 가 관측 합 이상이면 그 값이 정하고, 더 작으면 관측을 낮추지 않고 불일치·partial 로 남긴다.
  it("Claude final cumulative usage는 관측 합 이상이면 그 값으로 정하고, 더 작으면 관측을 낮추지 않는다", () => {
    const observe = (result: Record<string, number>) => {
      const meter = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
      meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 4, output_tokens: 2 } } });
      meter.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 6, output_tokens: 3 } } });
      meter.observe({ type: "result", usage: { cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...result }, num_turns: 2 });
      return meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
    };
    expect(observe({ input_tokens: 10, output_tokens: 6 })).toMatchObject({ inputTokens: 10, outputTokens: 6, internalRequests: 2, completeness: "complete" });
    expect(observe({ input_tokens: 9, output_tokens: 6 })).toMatchObject({ inputTokens: 10, outputTokens: 6, completeness: "partial", sourceUsage: { status: "mismatch" } });
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

  // engine-review 1d47a14d F001: result 뒤 같은 호출이 작업을 이어 가면(2026-10-19 71818d7f) 그 result 는 사용량의 최종 확정도 아니다.
  // 종료 버퍼는 스트림으로 이미 관찰했으면 어댑터가 다시 넣지 않는다(claude.ts) — 그래서 여기서 result 뒤에 오는 작업 줄은 실제 후속 작업이다.
  it("최종 result 뒤 새 assistant 사용량이 오면 확정을 풀고 더해 partial 로 남긴다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 8 } });
    meter.observe({ type: "assistant", message: { id: "late", usage: { output_tokens: 3 } } });
    expect(meter.hasFinalSource()).toBe(false);
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 5, outputTokens: 11, completeness: "partial" });
  });

  it("최종 result 뒤 부분 스트림 사용량도 확정을 풀고 더한다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 8 } });
    meter.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m2", usage: { input_tokens: 2, output_tokens: 1 } } } });
    meter.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 3 } } });
    meter.observe({ type: "stream_event", event: { type: "message_stop" } });
    expect(meter.hasFinalSource()).toBe(false);
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 7, outputTokens: 11, completeness: "partial" });
  });

  it("합성 0턴 result 뒤 실제 사용량을 0 토큰 complete 로 확정하지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", true, Date.now());
    meter.observe({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "No response requested.", usage: { input_tokens: 0, output_tokens: 0 } });
    meter.observe({ type: "assistant", message: { id: "real", usage: { input_tokens: 4, output_tokens: 6 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 4, outputTokens: 6, completeness: "partial" });
  });

  // CR Engine Advisor 자문 46: result 는 그때까지 관측한 메시지의 사용량을 이미 집계했다. 확정이 풀린 뒤 그 메시지의 늦은 갱신을 다시 더하면
  // 중복이다(partial 이어도 예산이 이 값으로 차감된다). 새 메시지만 더한다.
  it("최종 result 가 이미 집계한 메시지의 늦은 갱신은 다시 더하지 않고 새 메시지만 더한다", () => {
    const tool = { toolDurationMs: 0, toolCalls: 0 };
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 4 } } });
    meter.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 8 } });
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 8 } } });
    expect(meter.snapshot(tool, "final")).toMatchObject({ inputTokens: 5, outputTokens: 8, completeness: "partial" });
    meter.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 2, output_tokens: 3 } } });
    expect(meter.snapshot(tool, "final")).toMatchObject({ inputTokens: 7, outputTokens: 11, completeness: "partial" });
    const streamed = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    streamed.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 1 } } } });
    streamed.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 4 } } });
    streamed.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 8 } });
    streamed.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 8 } } });
    streamed.observe({ type: "stream_event", event: { type: "message_stop" } });
    expect(streamed.snapshot(tool, "final")).toMatchObject({ inputTokens: 5, outputTokens: 8, completeness: "partial" });
  });

  // engine-review e3c80e71 F002: result 가 실제로 집계한 필드·출처만 중복 방지 대상이다. result usage 에 없는 필드의 늦은 갱신은 새 관측값이다.
  it("result 가 싣지 않은 필드의 늦은 갱신은 보존하고, 관측과 충돌하는 0 은 관측을 낮추지 않는다", () => {
    const tool = { toolDurationMs: 0, toolCalls: 0 };
    const missing = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
    missing.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 13, cache_read_input_tokens: 3, output_tokens: 4 } } });
    missing.observe({ type: "result", usage: { output_tokens: 8 }, num_turns: 1 });
    missing.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 13, cache_read_input_tokens: 7, output_tokens: 8 } } });
    expect(missing.snapshot(tool, "final")).toMatchObject({ inputTokens: 20, cachedInputTokens: 7, outputTokens: 8, completeness: "partial" });
    const zero = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
    zero.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 13, cache_read_input_tokens: 3, output_tokens: 4 } } });
    zero.observe({ type: "result", usage: { input_tokens: 13, cache_read_input_tokens: 0, output_tokens: 8 }, num_turns: 1 });
    zero.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 13, cache_read_input_tokens: 7, output_tokens: 8 } } });
    // 자문 48 정정: 양수 관측(3·7)과 충돌하는 result 의 0 은 관측을 낮추지 않는다 — 7 과 불일치·partial.
    expect(zero.snapshot(tool, "final")).toMatchObject({ inputTokens: 20, cachedInputTokens: 7, outputTokens: 8, completeness: "partial" });
  });

  // result usage 는 advisor 반복을 빼고 집계한다. 세션 기준점 대조로 확정했을 때만 advisor 토큰까지 집계된 것이다.
  it("advisor 토큰의 늦은 갱신은 세션 기준점으로 확정한 result 뒤에는 더하지 않고, executor 전용 result 뒤에는 보존한다", () => {
    const tool = { toolDurationMs: 0, toolCalls: 0 };
    const usage = (output: number, advisorOutput: number) => ({ input_tokens: 5, output_tokens: output, iterations: [
      { type: "message", input_tokens: 5, output_tokens: output }, { type: "advisor_message", input_tokens: 10, output_tokens: advisorOutput }] });
    const session = new ExecutionMetrics("claude", 1, "test", "low", true, Date.now());
    session.setClaudeBaseline({ sessionId: "same", modelUsage: {}, totalCostUSD: 0, totalAPIDuration: 0 });
    session.observe({ type: "assistant", message: { id: "m1", usage: usage(4, 2) } });
    session.observe({ type: "result", session_id: "same", usage: { input_tokens: 5, output_tokens: 8 },
      modelUsage: { fable: { inputTokens: 15, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 11 } } });
    expect(session.snapshot(tool, "final")).toMatchObject({ inputTokens: 15, outputTokens: 11, completeness: "complete" });
    session.observe({ type: "assistant", message: { id: "m1", usage: usage(8, 3) } });
    expect(session.snapshot(tool, "final")).toMatchObject({ inputTokens: 15, outputTokens: 11, completeness: "partial" });
    // 자문 47 재현: executor 출력 8·advisor 출력 2 → executor 전용 result 8 → advisor 가 3 으로 갱신 → 8 + 3 = 11.
    const executorOnly = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    executorOnly.observe({ type: "assistant", message: { id: "m1", usage: usage(8, 2) } });
    executorOnly.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 8 } });
    executorOnly.observe({ type: "assistant", message: { id: "m1", usage: usage(8, 3) } });
    expect(executorOnly.snapshot(tool, "final")).toMatchObject({ inputTokens: 15, outputTokens: 11, completeness: "partial" });
  });

  // 자문 48 정정: 캐시 읽기 result 3 뒤 같은 메시지의 5 관측도 버리지 않는다(불일치·partial).
  it("캐시 읽기만 집계한 result 는 캐시 생성 필드까지 덮지 않고, 그 뒤 더 큰 캐시 읽기 관측도 버리지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 13, cache_read_input_tokens: 3, cache_creation_input_tokens: 2, output_tokens: 4 } } });
    meter.observe({ type: "result", usage: { output_tokens: 8, cache_read_input_tokens: 3 } });
    meter.observe({ type: "assistant", message: { id: "m1", usage: { cache_read_input_tokens: 5, cache_creation_input_tokens: 6 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 24, cachedInputTokens: 5, outputTokens: 8, completeness: "partial" });
  });

  it("연속 result 가 서로 다른 필드를 집계하면 메시지별·필드별 범위를 합쳐 유지한다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, cache_read_input_tokens: 1, output_tokens: 4 } } });
    meter.observe({ type: "result", usage: { output_tokens: 8 } });
    meter.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 2, output_tokens: 3 } } });
    meter.observe({ type: "result", usage: { input_tokens: 9 } });
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 6, cache_read_input_tokens: 2, output_tokens: 5 } } });
    meter.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 2, output_tokens: 4 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 11, cachedInputTokens: 2, outputTokens: 12, completeness: "partial" });
  });

  it("토큰 필드 없이 하위 객체만 실은 result usage 는 어떤 필드도 덮지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 4 } } });
    meter.observe({ type: "result", usage: { server_tool_use: { web_search_requests: 1 } } });
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 8 } } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 5, outputTokens: 8, completeness: "partial" });
  });

  it("합성 0턴 result 만 받은 호출을 완전한 최종 사용량으로 확정하지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", true, Date.now());
    meter.observe({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "No response requested.", usage: { input_tokens: 0, output_tokens: 0 } });
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 0, outputTokens: 0, completeness: "partial" });
  });

  it("사용량 없는 도구 결과 줄도 확정을 풀고, 앞 result 의 비용·요청 수를 확정값으로 남기지 않는다", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    meter.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 8 } } });
    meter.observe({ type: "result", usage: { input_tokens: 5, output_tokens: 8 }, total_cost_usd: 0.5, num_turns: 3, duration_api_ms: 900 });
    // 자문 48: 진행 스냅숏은 호출이 끝나기 전이라 partial 이다. 비용·턴·요청 수는 작업 뒤가 아닌 마지막 result 의 값이다.
    expect(meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "progress")).toMatchObject({ completeness: "partial", costUSD: 0.5, modelTurns: 3, internalRequests: 3 });
    meter.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } });
    const snapshot = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
    expect(snapshot).toMatchObject({ inputTokens: 5, outputTokens: 8, completeness: "partial", internalRequests: 1 });
    expect([snapshot.costUSD, snapshot.modelTurns, snapshot.apiDurationMs]).toEqual([undefined, undefined, undefined]);
  });

  it("유지: 최종 result 뒤 진단·사용량 줄만 오면 확정을 유지하고, 작업 뒤 새 result 는 기존 규칙으로 다시 확정한다", () => {
    const quiet = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    quiet.observe({ type: "result", usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 } });
    quiet.observe({ type: "system", subtype: "status" });
    quiet.observe({ type: "rate_limit_event" });
    expect(quiet.hasFinalSource()).toBe(true);
    expect(quiet.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ outputTokens: 8, completeness: "complete" });
    const resumed = new ExecutionMetrics("claude", 1, "test", "low", false, Date.now());
    resumed.observe({ type: "assistant", message: { id: "m1", usage: { input_tokens: 5, output_tokens: 8 } } });
    resumed.observe({ type: "result", usage: { input_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 8 } });
    resumed.observe({ type: "assistant", message: { id: "m2", usage: { input_tokens: 2, output_tokens: 3 } } });
    resumed.observe({ type: "result", usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 11 } });
    expect(resumed.hasFinalSource()).toBe(true);
    expect(resumed.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final")).toMatchObject({ inputTokens: 7, outputTokens: 11, completeness: "complete" });
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
      outputTokens: 2637, completeness: "partial", sourceUsage: {
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
  expect(usage).toMatchObject({ inputTokens: 61, cachedInputTokens: 20, outputTokens: 15, completeness: "partial" });
  expect(usage.sourceUsage?.cli).toEqual({ inputTokens: 11, outputTokens: 3 });
  expect(usage.sourceUsage?.claudeStream).toEqual({ inputTokens: 60, cachedInputTokens: 20, outputTokens: 15 });
});


describe("advisor usage", () => {
  it.each([false, true])("counts streamed advisor usage once and reconciles final totals (baseline=%s)", baseline => {
    const meter = new ExecutionMetrics("claude", 1, "claude-opus-5-5", "max", !baseline, Date.now());
    if (baseline) meter.setClaudeBaseline({ sessionId: "same", modelUsage: {}, totalCostUSD: 0, totalAPIDuration: 0 });
    meter.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m1", usage: {
      input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 0,
    } } } });
    const delta = { type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 7, iterations: [
      { type: "message", input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 },
      { type: "advisor_message", model: "fable", input_tokens: 40, cache_read_input_tokens: 5,
        cache_creation_input_tokens: 0, output_tokens: 9 },
    ] } } };
    meter.observe(delta);
    meter.observe(delta);
    const partial = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
    expect(partial).toMatchObject({ inputTokens: 165, cachedInputTokens: 25, outputTokens: 16,
      lastRequestInputTokens: 120, completeness: "partial" });
    expect(exceededLimits(partial, { inputTokens: 150 })).not.toHaveLength(0);
    meter.observe({ type: "result", session_id: "same", usage: {
      input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 0, output_tokens: 7,
    }, modelUsage: {
      opus: { inputTokens: 100, cacheReadInputTokens: 20, cacheCreationInputTokens: 0, outputTokens: 7 },
      fable: { inputTokens: 40, cacheReadInputTokens: 5, cacheCreationInputTokens: 0, outputTokens: 9 },
    }, total_cost_usd: 0.4, duration_api_ms: 200 });
    const final = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
    expect(final).toMatchObject({ inputTokens: 165, cachedInputTokens: 25, outputTokens: 16,
      completeness: baseline ? "complete" : "partial" });
    expect(final.costUSD).toBe(baseline ? 0.4 : undefined);
  });
});

it("keeps raw CLI usage distinct from corrected advisor observations", () => {
  const meter = new ExecutionMetrics("claude", 1, "claude-opus-5-5", "max", false, Date.now());
  meter.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m", usage: {
    input_tokens: 100, cache_read_input_tokens: 20, cache_creation_input_tokens: 30, output_tokens: 0,
  } } } });
  meter.observe({ type: "stream_event", event: { type: "message_delta", usage: { output_tokens: 7, iterations: [
    { type: "advisor_message", input_tokens: 40, cache_read_input_tokens: 5, output_tokens: 9 },
  ] } } });
  meter.observe({ type: "result", usage: { input_tokens: 11, output_tokens: 3 } });
  const usage = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
  expect(usage.sourceUsage?.cli).toEqual({ inputTokens: 11, outputTokens: 3 });
  expect(usage).toMatchObject({ inputTokens: 195, cachedInputTokens: 25, outputTokens: 16, completeness: "partial" });
});

it("reconciles captured CLI advisor execution and disabled resume without rebilling the previous turn", () => {
  let baseline = { sessionId: advisorFixture.runs[0].events.at(-1)!.session_id!, modelUsage: {}, totalCostUSD: 0, totalAPIDuration: 0 };
  const totals = [[9754, 2543, 652], [2167, 0, 178]];
  for (const [index, run] of advisorFixture.runs.entries()) {
    const meter = new ExecutionMetrics("claude", 1, "test", "max", index > 0, Date.now());
    meter.setClaudeBaseline(baseline);
    for (const event of run.events) meter.observe(event);
    const usage = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
    expect([usage.inputTokens, usage.cachedInputTokens, usage.outputTokens]).toEqual(totals[index]);
    expect(usage.completeness).toBe("complete");
    const result = run.events.at(-1)!;
    baseline = { sessionId: result.session_id!, modelUsage: result.modelUsage!, totalCostUSD: result.total_cost_usd!, totalAPIDuration: result.duration_api_ms! };
  }
});

describe("request input with advisor iterations", () => {
  // With server-side advisor calls the top-level usage of one message sums its executor requests; count each request.
  it("uses the largest executor iteration of the captured CLI advisor run", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "max", false, Date.now());
    for (const event of advisorFixture.runs[0].events) meter.observe(event);
    const usage = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "final");
    expect([usage.lastRequestInputTokens, usage.peakRequestInputTokens]).toEqual([2958, 2958]);
    expect(usage.inputTokens).toBe(9754);
  });

  it("does not report the summed executor iterations of a production planning response as one request", () => {
    // Usage of a fable planning response with one advisor call (runner transcript c1877317, 2026-10-07 01:13).
    const meter = new ExecutionMetrics("claude", 1, "test", "max", true, Date.now());
    meter.observe({ type: "stream_event", event: { type: "message_start", message: { id: "m", usage: {
      input_tokens: 2, cache_read_input_tokens: 443473, cache_creation_input_tokens: 45158, output_tokens: 1 } } } });
    meter.observe({ type: "stream_event", event: { type: "message_delta", usage: {
      input_tokens: 4, cache_read_input_tokens: 932104, cache_creation_input_tokens: 47739, output_tokens: 33737, iterations: [
        { type: "message", input_tokens: 2, cache_read_input_tokens: 443473, cache_creation_input_tokens: 45158, output_tokens: 784 },
        { type: "advisor_message", input_tokens: 489562, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 13426 },
        { type: "message", input_tokens: 2, cache_read_input_tokens: 488631, cache_creation_input_tokens: 2581, output_tokens: 32953 },
      ] } } });
    meter.observe({ type: "assistant", message: { id: "m", usage: {
      input_tokens: 4, cache_read_input_tokens: 932104, cache_creation_input_tokens: 47739, output_tokens: 33737 } } });
    const usage = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "progress");
    expect([usage.lastRequestInputTokens, usage.peakRequestInputTokens]).toEqual([491214, 491214]);
    expect(usage.inputTokens).toBe(4 + 932104 + 47739 + 489562);
  });

  it("falls back to the top-level usage when iterations are empty", () => {
    const meter = new ExecutionMetrics("claude", 1, "test", "max", true, Date.now());
    meter.observe({ type: "assistant", message: { id: "m", usage: {
      input_tokens: 2, cache_read_input_tokens: 343017, cache_creation_input_tokens: 2481, output_tokens: 417, iterations: [] } } });
    const usage = meter.snapshot({ toolDurationMs: 0, toolCalls: 0 }, "progress");
    expect([usage.lastRequestInputTokens, usage.peakRequestInputTokens]).toEqual([345500, 345500]);
  });
});

// CR Engine Advisor 자문 48: Claude 사용량은 관측 근거에서 닫힌 규칙으로 계산한다.
// - 원천 필드 p(input)·r(cache_read)·c(cache_creation)·o(output)를 출처 E(executor)·A(advisor)·G(검증된 세션 차분)별로 본다.
// - 메시지 값은 같은 메시지의 최대값(갱신·재전송 합산 없음)이고, 스트림 합은 서로 다른 메시지의 합이다.
// - result 는 필드별 집계점 {출처, 필드, 값, 그때까지 시작한 메시지 수}를 남긴다. 생략한 필드는 집계점을 만들지도, 지우지도 않는다.
// - Q = 집계값 + 그 뒤 시작한 메시지의 그 필드 합. E필드 = max(E 스트림 합, E 집계점 Q). 전체 = max(E필드 + A 스트림 합, G 집계점 Q).
// - 공개 값: inputTokens = p+r+c, cachedInputTokens = r, outputTokens = o.
describe("Claude 사용량 닫힌 규칙(자문 48)", () => {
  type Fields = { p?: number; r?: number; c?: number; o?: number };
  const usageOf = (fields: Fields) => ({
    ...(fields.p === undefined ? {} : { input_tokens: fields.p }), ...(fields.r === undefined ? {} : { cache_read_input_tokens: fields.r }),
    ...(fields.c === undefined ? {} : { cache_creation_input_tokens: fields.c }), ...(fields.o === undefined ? {} : { output_tokens: fields.o }) });
  const M = (id: string, executor: Fields, advisor?: Fields) => ({ type: "assistant", message: { id, usage: { ...usageOf(executor),
    ...(advisor ? { iterations: [{ type: "message", ...usageOf(executor) }, { type: "advisor_message", ...usageOf(advisor) }] } : {}) } } });
  let resultNumber = 0;
  const R = (fields: Fields, extra: Record<string, unknown> = {}) =>
    ({ type: "result", subtype: "success", is_error: false, num_turns: 1, uuid: `r${++resultNumber}`, usage: usageOf(fields), ...extra });
  const full = (p: number, r: number, c: number, o: number) => ({ p, r, c, o });
  const session = (p: number, r: number, c: number, o: number) => ({ session_id: "same",
    modelUsage: { fable: { inputTokens: p, cacheReadInputTokens: r, cacheCreationInputTokens: c, outputTokens: o } } });
  const synthetic = (usage?: Fields) => ({ type: "result", subtype: "success", is_error: false, num_turns: 0, result: "No response requested.",
    ...(usage ? { usage: usageOf(usage) } : {}) });
  const start = (id: string, fields: Fields) => ({ type: "stream_event", event: { type: "message_start", message: { id, usage: usageOf(fields) } } });
  const delta = (fields: Fields) => ({ type: "stream_event", event: { type: "message_delta", usage: usageOf(fields) } });
  const stop = { type: "stream_event", event: { type: "message_stop" } };
  const toolResult = { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t", content: "ok" }] } };
  const tool = { toolDurationMs: 0, toolCalls: 0 };
  type Expected = [number | undefined, number | undefined, number | undefined, "complete" | "partial"];
  const run = (events: unknown[], baseline = false) => {
    const meter = new ExecutionMetrics("claude", 1, "fable", "high", baseline, Date.now());
    if (baseline) meter.setClaudeBaseline({ sessionId: "same", modelUsage: {}, totalCostUSD: 0, totalAPIDuration: 0 });
    for (const event of events) meter.observe(event);
    const usage = meter.snapshot(tool, "final");
    return [usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, usage.completeness];
  };

  // 기대값은 위 규칙으로 손계산했다(코드와 독립). 출처: 자문 48 표, 보고서 「반례 전체 표」(자문 48 의 두 정정 반영).
  const cases: Array<[string, unknown[], Expected, boolean?]> = [
    ["48 같은 메시지 늦은 갱신", [M("m1", { o: 4 }), R({ o: 8 }), M("m1", { o: 8 })], [undefined, undefined, 8, "partial"]],
    ["48 새 메시지", [M("m1", { p: 5, o: 8 }), R({ p: 5, o: 8 }), M("m2", { p: 2, o: 3 })], [7, undefined, 11, "partial"]],
    ["48 누락 캐시(F002 반례)", [M("m1", { p: 13, r: 3, o: 4 }), R({ o: 8 }), M("m1", { r: 7 })], [20, 7, 8, "partial"]],
    ["48 뒤 result 의 캐시 생략(F002 잔여)", [M("m1", { p: 13, r: 3, o: 4 }), R({ p: 13, r: 7, o: 8 }), M("m2", { p: 2, o: 3 }), R({ p: 15, o: 11 }), M("m1", { r: 7 })], [22, 7, 11, "partial"]],
    ["48 뒤 result 가 모두 확정", [M("m1", { p: 13, r: 3, o: 4 }), R(full(13, 7, 0, 8)), M("m2", { p: 2, o: 3 }), R(full(15, 7, 0, 11))], [22, 7, 11, "complete"]],
    ["48 충돌 없는 0", [M("m1", { p: 13, r: 0, o: 4 }), R(full(13, 0, 0, 8))], [13, 0, 8, "complete"]],
    ["48 앞 양수와 충돌하는 0", [M("m1", { p: 13, r: 3, o: 4 }), R(full(13, 0, 0, 8)), M("m1", { r: 7 })], [20, 7, 8, "partial"]],
    ["48 캐시 생성·읽기 충돌", [M("m1", { p: 13, r: 3, c: 2, o: 4 }), R({ o: 8, r: 3 }), M("m1", { r: 5, c: 6 })], [24, 5, 8, "partial"]],
    ["48 advisor 늦은 갱신", [M("m1", { p: 5, o: 8 }, { p: 10, o: 2 }), R({ p: 5, o: 8 }), M("m1", {}, { o: 3 })], [15, undefined, 11, "partial"]],
    ["48 세션 차분 뒤 늦은 갱신", [M("m1", { p: 5, o: 8 }, { p: 10, o: 2 }), R({ p: 5, o: 8 }, session(15, 0, 0, 11)), M("m1", {}, { o: 3 })], [15, 0, 11, "partial"], true],
    ["48 합성 0턴만", [synthetic(full(0, 0, 0, 0))], [0, 0, 0, "partial"]],
    ["48 합성 0턴 뒤 실제 작업", [synthetic(), M("m1", { p: 7, o: 11 })], [7, undefined, 11, "partial"]],
    ["48 관측 없음", [], [undefined, undefined, undefined, "partial"]],
    ["F001-a result 뒤 새 출력", [R({ p: 5, o: 8 }), M("m2", { o: 3 })], [5, undefined, 11, "partial"]],
    ["F001-b result 뒤 부분 스트림", [R({ p: 5, o: 8 }), start("m2", { p: 2, o: 1 }), delta({ o: 3 }), stop], [7, undefined, 11, "partial"]],
    ["F001-c 합성 0턴 뒤 실제", [synthetic({ p: 0, o: 0 }), M("real", { p: 4, o: 6 })], [4, undefined, 6, "partial"]],
    ["F001-d result 뒤 도구 결과만", [M("m1", { p: 5, o: 8 }), R({ p: 5, o: 8 }), toolResult], [5, undefined, 8, "partial"]],
    ["46-1c 부분 스트림 늦은 갱신", [start("m1", { p: 5, o: 1 }), delta({ o: 4 }), R({ p: 5, o: 8 }), delta({ o: 8 }), stop], [5, undefined, 8, "partial"]],
    ["47-2 정정: 0 은 앞 양수를 지우지 않음", [M("m1", { p: 13, r: 3, o: 4 }), R({ p: 13, r: 0, o: 8 }), M("m1", { p: 13, r: 7, o: 8 })], [20, 7, 8, "partial"]],
    ["47-4b executor 4→result 8, advisor 2→3", [M("m1", { p: 5, o: 4 }, { p: 10, o: 2 }), R({ p: 5, o: 8 }), M("m1", { p: 5, o: 8 }, { p: 10, o: 3 })], [15, undefined, 11, "partial"]],
    ["47-4c 세션 확정 직후", [M("m1", { p: 5, o: 4 }, { p: 10, o: 2 }), R({ p: 5, o: 8 }, session(15, 0, 0, 11))], [15, 0, 11, "complete"], true],
    ["47-5 연속 result 의 필드별 범위", [M("m1", { p: 5, r: 1, o: 4 }), R({ o: 8 }), M("m2", { p: 2, o: 3 }), R({ p: 9 }), M("m1", { p: 6, r: 2, o: 5 }), M("m2", { p: 2, o: 4 })], [11, 2, 12, "partial"]],
    ["47-6 하위 객체만 실은 usage", [M("m1", { p: 5, o: 4 }), { type: "result", usage: { server_tool_use: { web_search_requests: 1 } } }, M("m1", { p: 5, o: 8 })], [5, undefined, 8, "partial"]],
    ["대조 정상 호출", [M("m1", { p: 5, o: 8 }), R(full(5, 0, 0, 8))], [5, 0, 8, "complete"]],
    ["대조 진단 줄만 뒤따름", [R(full(5, 0, 0, 8)), { type: "system", subtype: "status" }, { type: "rate_limit_event" }], [5, 0, 8, "complete"]],
    ["대조 입력·출력만 실은 result", [M("m1", { p: 5, o: 8 }), R({ p: 5, o: 8 })], [5, undefined, 8, "partial"]],
  ];
  it.each(cases)("%s", (_name, events, expected, baseline) => {
    expect(run(events, baseline)).toEqual(expected);
  });

  it("검증된 세션 차분이 관측보다 작으면 관측을 낮추지 않고 불일치로 남긴다", () => {
    const meter = new ExecutionMetrics("claude", 1, "fable", "high", true, Date.now());
    meter.setClaudeBaseline({ sessionId: "same", modelUsage: {}, totalCostUSD: 0, totalAPIDuration: 0 });
    meter.observe(M("m1", { p: 5, r: 0, c: 0, o: 8 }, { p: 10, o: 3 }));
    meter.observe(R(full(5, 0, 0, 8), session(15, 0, 0, 10)));
    expect(meter.snapshot(tool, "final")).toMatchObject({ inputTokens: 15, outputTokens: 11, completeness: "partial", sourceUsage: { status: "mismatch" } });
  });

  it("메시지·집계점 상한(구현 제안값)을 넘으면 관측값을 보존하고 partial 과 진단을 남긴다", () => {
    vi.mocked(reportBackgroundFailure).mockClear();
    const meter = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
    for (let index = 0; index < 16_384; index += 1) meter.observe(M(`m${index}`, { p: 1, r: 0, c: 0, o: 1 }));
    expect(meter.snapshot(tool, "final")).toMatchObject({ inputTokens: 16_384, outputTokens: 16_384 });
    meter.observe(M("overflow", { p: 1, r: 0, c: 0, o: 1 }));
    meter.observe(R(full(16_384, 0, 0, 16_384)));
    expect(meter.snapshot(tool, "final")).toMatchObject({ inputTokens: 16_384, outputTokens: 16_384, completeness: "partial" });
    expect(vi.mocked(reportBackgroundFailure)).toHaveBeenCalledTimes(1);
    const anchors = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
    anchors.observe(M("m1", { p: 1, r: 0, c: 0, o: 1 }));
    for (let index = 0; index < 1_025; index += 1) anchors.observe(R(full(1, 0, 0, 1)));
    expect(anchors.snapshot(tool, "final")).toMatchObject({ inputTokens: 1, outputTokens: 1, completeness: "partial" });
    expect(vi.mocked(reportBackgroundFailure)).toHaveBeenCalledTimes(2);
  });

  // 독립 기준 함수: 자문 48 의 reference.py 를 옮긴 것이다. 프로덕션 계측기의 helper 를 쓰지 않는다(executor 출처·비합성 result 만).
  type RefEvent = { kind: "M"; id: string; fields: Fields } | { kind: "R"; fields: Fields };
  const FIELDS = ["p", "r", "c", "o"] as const;
  const reference = (events: RefEvent[]) => {
    const born = new Map<string, number>(); const values = new Map<string, number>(); const anchors: Array<[string, number, number]> = [];
    let terminal: { seq: number; fields: Fields } | undefined; let activity = -1;
    const total = (field: string, cut = -1) => [...values.entries()].reduce((sum, [key, value]) => {
      const [id, f] = key.split("|"); return f === field && born.get(id)! > cut ? sum + value : sum; }, 0);
    events.forEach((event, seq) => {
      if (event.kind === "M") {
        activity = seq; if (!born.has(event.id)) born.set(event.id, born.size + 1);
        for (const f of FIELDS) { const v = event.fields[f]; if (v !== undefined) values.set(`${event.id}|${f}`, Math.max(values.get(`${event.id}|${f}`) ?? 0, v)); }
      } else {
        for (const f of FIELDS) { const v = event.fields[f]; if (v !== undefined) anchors.push([f, born.size, v]); }
        terminal = { seq, fields: event.fields };
      }
    });
    const parts = Object.fromEntries(FIELDS.map(f => [f, Math.max(total(f), ...anchors.filter(([key]) => key === f).map(([, cut, v]) => v + total(f, cut)))]));
    const known = (f: string) => [...values.keys()].some(key => key.endsWith(`|${f}`)) || anchors.some(([key]) => key === f);
    const complete = terminal !== undefined && terminal.seq > activity && FIELDS.every(f => terminal!.fields[f] !== undefined && terminal!.fields[f] === parts[f]);
    return [known("p") || known("r") || known("c") ? parts.p + parts.r + parts.c : undefined, known("r") ? parts.r : undefined,
      known("o") ? parts.o : undefined, complete ? "complete" : "partial"];
  };
  const random = (seed: number) => () => { seed = (seed + 0x6d2b79f5) | 0; let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };

  it("고정 시드 500개×30이벤트에서 독립 기준 함수와 같고, 단조·멱등·포함 관계를 지킨다", () => {
    const next = random(48);
    const pick = (n: number) => Math.floor(next() * n);
    for (let trial = 0; trial < 500; trial += 1) {
      const meter = new ExecutionMetrics("claude", 1, "fable", "high", false, Date.now());
      const events: RefEvent[] = []; let previous: unknown[] = [undefined, undefined, undefined];
      for (let step = 0; step < 30; step += 1) {
        const fields: Fields = {}; for (const f of FIELDS) if (next() < 0.5) fields[f] = pick(15);
        const event: RefEvent = next() < 0.7 ? { kind: "M", id: `m${pick(5)}`, fields } : { kind: "R", fields };
        const line = event.kind === "M" ? M(event.id, fields) : R(fields);
        events.push(event); meter.observe(line);
        const snapshot = meter.snapshot(tool, "final");
        const now = [snapshot.inputTokens, snapshot.cachedInputTokens, snapshot.outputTokens, snapshot.completeness];
        expect(now, `trial ${trial} step ${step}`).toEqual(reference(events));
        for (const index of [0, 1, 2]) if (previous[index] !== undefined) expect(now[index] as number).toBeGreaterThanOrEqual(previous[index] as number);
        if (now[1] !== undefined) expect(now[0] as number).toBeGreaterThanOrEqual(now[1] as number);
        meter.observe(line);
        const repeated = meter.snapshot(tool, "final");
        expect([repeated.inputTokens, repeated.cachedInputTokens, repeated.outputTokens]).toEqual(now.slice(0, 3));
        previous = now;
      }
    }
  });
});
