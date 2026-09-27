// Provider-owned request records prove the scope of Codex's counters. A completion may report
// session totals even when the process resumed just one turn. Never infer a delta from size alone.
export type TokenCounts = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export interface CodexUsageEvidence {
  usage: TokenCounts;
  peak: TokenCounts;
  reported: TokenCounts;
  lastThread: TokenCounts;
  turnCount: number;
  requestIds: string[];
}
const keys = ["inputTokens", "cachedInputTokens", "outputTokens"] as const;
const zero = (): TokenCounts => ({ inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 });
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
function counts(value: unknown): TokenCounts | null {
  const v = object(value); if (!v) return null;
  const result = { inputTokens: v.input_tokens, cachedInputTokens: v.cached_input_tokens, outputTokens: v.output_tokens };
  if (Object.values(result).some(n => typeof n !== "number" || !Number.isSafeInteger(n) || n < 0)) return null;
  if ((result.cachedInputTokens as number) > (result.inputTokens as number)) return null;
  return result as TokenCounts;
}
export const sameTokenCounts = (a: Partial<TokenCounts>, b: TokenCounts) => keys.every(k => a[k] === b[k]);

export function codexUsageEvidence(text: string, sessionId: string, start: number, end: number): CodexUsageEvidence | null {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  try {
    const events = text.split(/\r?\n/).filter(line => line.trim()).map(line => object(JSON.parse(line))!);
    if (events[0]?.type !== "session_meta" || object(events[0].payload)?.id !== sessionId) return null;
    const usage = zero(), peak = zero(), reported = zero();
    let lastThread = zero(), turnCount = 0;
    let active: { id: string; sum: TokenCounts; baseline?: TokenCounts; final?: TokenCounts; thread?: TokenCounts } | null = null;
    const requests = new Map<string, string>();
    const turns = new Set<string>();
    for (const event of events) {
      const at = Date.parse(String(event?.timestamp ?? ""));
      if (!Number.isFinite(at) || at < start || at > end) continue;
      const p = object(event.payload); if (!p) continue;
      if (event.type === "event_msg" && p.type === "task_started") {
        if (active || typeof p.turn_id !== "string" || turns.has(p.turn_id)) return null;
        active = { id: p.turn_id, sum: zero() }; turns.add(p.turn_id);
      } else if (event.type === "token_usage_record") {
        if (!active || p.thread_id !== sessionId || p.turn_id !== active.id || typeof p.response_id !== "string") return null;
        const request = counts(p.usage), total = counts(p.turn_token_usage), thread = counts(p.thread_token_usage);
        if (!request || !total || !thread) return null;
        const signature = JSON.stringify([active.id, request, total, thread]);
        if (requests.has(p.response_id)) { if (requests.get(p.response_id) !== signature) return null; continue; }
        requests.set(p.response_id, signature);
        for (const k of keys) active.sum[k] += request[k];
        if (!sameTokenCounts(active.sum, total)) return null; // missing/reordered request records cannot lower a bill
        const baseline = active.baseline ?? (turnCount > 0 ? lastThread : {
          inputTokens: thread.inputTokens - total.inputTokens, cachedInputTokens: thread.cachedInputTokens - total.cachedInputTokens,
          outputTokens: thread.outputTokens - total.outputTokens,
        });
        if (keys.some(k => baseline[k] < 0 || thread[k] !== baseline[k] + total[k])) return null;
        active.baseline = baseline;
        active.final = total; active.thread = thread;
      } else if (event.type === "event_msg" && p.type === "task_complete") {
        if (!active || p.turn_id !== active.id || !active.final || !active.thread) return null;
        for (const k of keys) { usage[k] += active.sum[k]; peak[k] = Math.max(peak[k], active.sum[k]); reported[k] += active.thread[k]; }
        lastThread = active.thread; turnCount++; active = null;
      } else if (event.type === "event_msg" && p.type === "turn_aborted") return null;
    }
    if (active || !turnCount || keys.some(k => !Number.isSafeInteger(usage[k]) || !Number.isSafeInteger(reported[k]))) return null;
    return { usage, peak, reported, lastThread, turnCount, requestIds: [...requests.keys()] };
  } catch { return null; }
}
