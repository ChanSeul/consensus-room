import { describe, expect, it } from "vitest";

import { ClaudeAdapter } from "../src/server/adapters/claude";
import { createToolTimeMeter } from "../src/server/adapters/toolTime";
import type { CommandResult, CommandRunner, CommandSpec, TurnUsage } from "../src/server/types";

// 2026-09-08 Codex 지적: usage 의 durationMs 는 CLI 전체 실행시간이라 도구·빌드 시간이 섞인다. 도구 창을 따로 잰다.
describe("도구 실행 시간 측정기", () => {
  it("claude: tool_use 가 창을 열고 마지막 tool_result 가 닫는다(병렬 호출은 미결 수로 센다)", () => {
    const meter = createToolTimeMeter("claude");
    meter.observe({ type: "system", subtype: "init" }, 0);
    meter.observe({ type: "assistant", message: { content: [{ type: "text", text: "읽겠습니다" }, { type: "tool_use", id: "t1", name: "Read" }] } }, 1_000);
    meter.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } }, 2_500);
    meter.observe({ type: "assistant", message: { content: [{ type: "tool_use", id: "t2" }, { type: "tool_use", id: "t3" }] } }, 4_000);
    meter.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t2" }] } }, 4_500);
    meter.observe({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t3" }] } }, 7_000);
    meter.observe({ type: "result", duration_ms: 8_000 }, 8_000);
    expect(meter.summary()).toEqual({ toolDurationMs: 1_500 + 3_000, toolCalls: 3 });
  });

  it("codex: 도구 종류의 item.started/completed 만 세고 reasoning·agent_message 는 무시한다", () => {
    const meter = createToolTimeMeter("codex");
    meter.observe({ type: "item.started", item: { id: "r1", type: "reasoning" } }, 0);
    meter.observe({ type: "item.completed", item: { id: "r1", type: "reasoning" } }, 900);
    meter.observe({ type: "item.started", item: { id: "c1", type: "command_execution", command: "git diff" } }, 1_000);
    meter.observe({ type: "item.completed", item: { id: "c1", type: "command_execution", exit_code: 0 } }, 3_200);
    meter.observe({ type: "item.completed", item: { id: "m1", type: "agent_message" } }, 3_300);
    meter.observe({ type: "turn.completed", usage: {} }, 3_400);
    expect(meter.summary()).toEqual({ toolDurationMs: 2_200, toolCalls: 1 });
  });

  it("짝이 안 맞는 결과(열린 창 없음)와 끝까지 안 닫힌 창은 더하지 않는다", () => {
    const meter = createToolTimeMeter("claude");
    meter.observe({ type: "user", message: { content: [{ type: "tool_result" }] } }, 100);
    meter.observe({ type: "assistant", message: { content: [{ type: "tool_use" }] } }, 200);
    expect(meter.summary()).toEqual({ toolDurationMs: 0, toolCalls: 1 });
  });
});

// 러너가 줄마다 onJSONLine 을 부르는 것을 흉내 낸다(도착 시각은 줄 순서대로 1초 간격).
class StreamingRunner implements CommandRunner {
  constructor(private readonly lines: unknown[]) {}
  async run(spec: CommandSpec): Promise<CommandResult> {
    this.lines.forEach((line, index) => spec.onJSONLine?.(line, 10_000 + index * 1_000));
    return { exitCode: 0, stdout: "", stderr: "", jsonLines: this.lines };
  }
}

const planResult = {
  type: "result", subtype: "success", duration_ms: 9_000, duration_api_ms: 6_500, num_turns: 2,
  usage: { input_tokens: 10, cache_read_input_tokens: 90, cache_creation_input_tokens: 0, output_tokens: 20 },
  structured_output: { kind: "PLAN", summary: "계획", findings: [], evidenceRefs: [], planMarkdown: "# 계획" },
};

describe("어댑터 사용량 통지의 시간 분리", () => {
  it("Claude: 도구 창 합·호출 수와 CLI 가 잰 API 시간을 함께 알린다", async () => {
    const runner = new StreamingRunner([
      { type: "system", subtype: "init" },
      { type: "assistant", message: { content: [{ type: "tool_use", id: "t1" }] } },
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1" }] } },
      planResult,
    ]);
    const seen: TurnUsage[] = [];
    await new ClaudeAdapter(runner).createSession({ prompt: "계획", cwd: "/tmp", onUsage: (usage) => seen.push(usage) });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ toolDurationMs: 1_000, toolCalls: 1, apiDurationMs: 6_500, modelTurns: 2 });
  });
});
