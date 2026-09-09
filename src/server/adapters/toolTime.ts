// 턴 소요시간을 모델 응답과 도구 실행으로 가른다(2026-09-08 Codex 지적: usage 의 durationMs 는 CLI 전체 실행시간이라
// 빌드·도구 시간이 섞여 "모델 속도" 결론의 근거가 되지 못한다). 러너가 JSON 줄을 받은 시각으로 도구 창을 잰다 —
// claude stream-json: assistant 메시지의 tool_use 블록이 창을 열고 user 메시지의 tool_result 가 닫는다.
// codex exec --json: item.started(도구 종류) 가 열고 같은 종류의 item.completed 가 닫는다.
// 병렬 호출은 미결 수로 센다 — 마지막 결과가 도착해야 창이 닫힌다. 러너의 ring buffer 와 무관하게 줄이 도착하는 즉시 누적한다.

export interface ToolTimeMeter {
  observe(value: unknown, at: number): void;
  summary(): { toolDurationMs: number; toolCalls: number };
}

const CODEX_TOOL_ITEMS = new Set(["command_execution", "file_change", "mcp_tool_call", "web_search", "custom_tool_call", "collab_agent_tool_call"]);

export function createToolTimeMeter(kind: "claude" | "codex"): ToolTimeMeter {
  let outstanding = 0;
  let windowStart: number | undefined;
  let toolDurationMs = 0;
  let toolCalls = 0;
  const open = (at: number, count: number) => {
    if (count <= 0) return;
    if (outstanding === 0) windowStart = at;
    outstanding += count;
    toolCalls += count;
  };
  const close = (at: number, count: number) => {
    if (count <= 0 || outstanding === 0) return;
    outstanding = Math.max(0, outstanding - count);
    if (outstanding === 0 && windowStart !== undefined) {
      toolDurationMs += Math.max(0, at - windowStart);
      windowStart = undefined;
    }
  };
  return {
    observe(value, at) {
      const event = record(value);
      if (!event) return;
      if (kind === "claude") {
        if (event.type === "assistant") open(at, countBlocks(event, "tool_use"));
        else if (event.type === "user") close(at, countBlocks(event, "tool_result"));
        return;
      }
      const item = record(event.item);
      if (!item || typeof item.type !== "string" || !CODEX_TOOL_ITEMS.has(item.type)) return;
      if (event.type === "item.started") open(at, 1);
      else if (event.type === "item.completed") close(at, 1);
    },
    summary() {
      return { toolDurationMs, toolCalls };
    },
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function countBlocks(event: Record<string, unknown>, blockType: string): number {
  const message = record(event.message);
  const content = message?.content;
  if (!Array.isArray(content)) return 0;
  return content.filter((block) => record(block)?.type === blockType).length;
}
