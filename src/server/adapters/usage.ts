import type { TurnUsage } from "../types.js";

// 2026-09-07 Codex 자기 최적화 제안 ④: 단계별 사용량을 방에 남긴다. 두 CLI 모두 마지막 이벤트에 토큰 수를
// 실어 보내므로(codex exec --json 의 turn.completed, claude stream-json 의 result) 별도 호출 없이 읽는다.
type TurnCounts = Omit<TurnUsage, "durationMs">;

function integer(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.round(value) : 0;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

// {"type":"turn.completed","usage":{"input_tokens","cached_input_tokens","output_tokens"}} — 턴당 하나, 마지막 것을 쓴다.
export function codexTurnUsage(jsonLines: readonly unknown[]): TurnCounts | null {
  for (const line of [...jsonLines].reverse()) {
    const event = record(line);
    if (event?.type !== "turn.completed") continue;
    const usage = record(event.usage);
    if (!usage) return null;
    return {
      inputTokens: integer(usage.input_tokens),
      cachedInputTokens: integer(usage.cached_input_tokens),
      outputTokens: integer(usage.output_tokens),
    };
  }
  return null;
}

// {"type":"result", "usage":{input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens},
//  "total_cost_usd", "num_turns"} — claude 의 input_tokens 는 캐시 밖 입력만 세므로 캐시 읽기·생성을 더해 총 입력으로 만든다.
export function claudeTurnUsage(jsonLines: readonly unknown[]): TurnCounts | null {
  for (const line of [...jsonLines].reverse()) {
    const event = record(line);
    if (event?.type !== "result") continue;
    const usage = record(event.usage);
    if (!usage) return null;
    const cached = integer(usage.cache_read_input_tokens);
    return {
      inputTokens: integer(usage.input_tokens) + cached + integer(usage.cache_creation_input_tokens),
      cachedInputTokens: cached,
      outputTokens: integer(usage.output_tokens),
      ...(typeof event.total_cost_usd === "number" ? { costUSD: event.total_cost_usd } : {}),
      ...(typeof event.num_turns === "number" ? { modelTurns: integer(event.num_turns) } : {}),
      // API 시간은 CLI 가 직접 잰 모델 응답 시간이다 — 도구·빌드 시간이 섞인 durationMs 와 분리해 기록한다(2026-09-08).
      ...(typeof event.duration_api_ms === "number" ? { apiDurationMs: integer(event.duration_api_ms) } : {}),
    };
  }
  return null;
}

export function withModel(counts: TurnCounts | null, model: string): TurnCounts | null {
  return counts ? { ...counts, model } : null;
}

// 사용량 통지는 부가 기록이다 — 관찰자가 던져도 이미 받은 턴 결과를 잃지 않는다.
export function notifyUsage(
  onUsage: ((usage: TurnUsage) => void) | undefined,
  counts: TurnCounts | null,
  startedAt: number,
  // 러너가 잰 도구 실행 창(adapters/toolTime.ts). 도구를 한 번도 안 부른 턴은 0 으로 기록된다.
  toolTime?: { toolDurationMs: number; toolCalls: number },
): void {
  if (!onUsage || !counts) return;
  try {
    onUsage({ ...counts, ...(toolTime ?? {}), durationMs: Math.max(0, Date.now() - startedAt) });
  } catch (error) {
    console.warn(`턴 사용량 기록 실패: ${error instanceof Error ? error.message : String(error)}`);
  }
}
