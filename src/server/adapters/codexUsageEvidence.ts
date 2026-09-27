// Provider-owned request records prove the scope of Codex's counters. A completion may report
// session totals even when the process resumed just one turn. Never infer a delta from size alone.
export type TokenCounts = { inputTokens: number; cachedInputTokens: number; outputTokens: number };
export interface CodexTurnEvidence {
  id: string;
  usage: TokenCounts;
  reported: TokenCounts;
  cliReported?: TokenCounts;
  requestIds: string[];
}
export interface CodexUsageEvidence {
  usage: TokenCounts;
  peak: TokenCounts;
  reported: TokenCounts;
  lastThread: TokenCounts;
  turnCount: number;
  requestIds: string[];
  // token_count is the CLI's counter scope, which can exclude compaction requests.
  // It is corroboration only; billing always uses the complete request ledger above.
  cliReported?: TokenCounts;
  turns: CodexTurnEvidence[];
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
    const usage = zero(), peak = zero(), reported = zero(), cliReported = zero();
    const completedTurns: CodexTurnEvidence[] = [];
    let previousCli: TokenCounts | undefined;
    const pendingCli = zero();
    let pendingLastRequest: TokenCounts | undefined;
    let lastThread = zero(), turnCount = 0;
    let active: { id: string; sum: TokenCounts; baseline?: TokenCounts; final?: TokenCounts; thread?: TokenCounts;
      lastRequest?: TokenCounts; cliReported?: TokenCounts; requestIds: string[] } | null = null;
    const requests = new Map<string, string>();
    const turns = new Set<string>();
    for (const event of events) {
      const at = Date.parse(String(event?.timestamp ?? ""));
      if (!Number.isFinite(at) || at > end) continue;
      const p = object(event.payload); if (!p) continue;
      if (at < start) {
        // A counter preceding the requested window anchors its delta. An intervening unreported
        // request invalidates that anchor; never silently charge it to this window.
        if (event.type === "token_usage_record") previousCli = undefined;
        if (event.type === "event_msg" && p.type === "token_count" && object(p.info)) {
          previousCli = counts(object(p.info)?.total_token_usage) ?? undefined;
        }
        continue;
      }
      if (event.type === "event_msg" && p.type === "task_started") {
        if (active || typeof p.turn_id !== "string" || turns.has(p.turn_id)) return null;
        active = { id: p.turn_id, sum: zero(), requestIds: [] }; turns.add(p.turn_id);
      } else if (event.type === "token_usage_record") {
        if (!active || p.thread_id !== sessionId || p.turn_id !== active.id || typeof p.response_id !== "string") return null;
        const request = counts(p.usage), total = counts(p.turn_token_usage), thread = counts(p.thread_token_usage);
        if (!request || !total || !thread) return null;
        const signature = JSON.stringify([active.id, request, total, thread]);
        if (requests.has(p.response_id)) { if (requests.get(p.response_id) !== signature) return null; continue; }
        requests.set(p.response_id, signature);
        active.requestIds.push(p.response_id);
        active.lastRequest = request;
        pendingLastRequest = request;
        for (const k of keys) pendingCli[k] += request[k];
        active.cliReported = undefined; // an earlier counter cannot prove this completion
        for (const k of keys) active.sum[k] += request[k];
        if (!sameTokenCounts(active.sum, total)) return null; // missing/reordered request records cannot lower a bill
        const baseline = active.baseline ?? (turnCount > 0 ? lastThread : {
          inputTokens: thread.inputTokens - total.inputTokens, cachedInputTokens: thread.cachedInputTokens - total.cachedInputTokens,
          outputTokens: thread.outputTokens - total.outputTokens,
        });
        if (keys.some(k => baseline[k] < 0 || thread[k] !== baseline[k] + total[k])) return null;
        // Only a genuinely fresh session has an implicit zero CLI baseline. A resumed session
        // needs its independent preceding counter; equality with the request ledger is not proof.
        if (!previousCli && turnCount === 0 && keys.every(k => baseline[k] === 0)) previousCli = zero();
        active.baseline = baseline;
        active.final = total; active.thread = thread;
      } else if (event.type === "compacted" && active) {
        // The CLI omits only the explicitly recorded compaction request. Its cost remains in
        // active.sum. A compaction without its request record is incomplete evidence.
        if (!pendingLastRequest) return null;
        for (const k of keys) pendingCli[k] -= pendingLastRequest[k];
        pendingLastRequest = undefined;
      } else if (event.type === "event_msg" && p.type === "token_count" && active) {
        const info = object(p.info), total = counts(info?.total_token_usage), last = counts(info?.last_token_usage);
        if (!info) continue; // rate-limit-only notification, no usage observation
        if (!total || !last) return null;
        // Even equal-sized adjacent requests must have separate ledger records. Matching only
        // last_token_usage would accept a missing request while the cumulative counter advances.
        if (!previousCli || keys.some(k => total[k] - previousCli![k] !== pendingCli[k])) return null;
        previousCli = total;
        for (const k of keys) pendingCli[k] = 0;
        pendingLastRequest = undefined;
        active.cliReported = active.lastRequest && active.thread &&
          sameTokenCounts(last, active.lastRequest) && keys.every(k => total[k] >= last[k] && total[k] <= active!.thread![k])
          ? total : undefined;
      } else if (event.type === "event_msg" && p.type === "task_complete") {
        if (!active || p.turn_id !== active.id || !active.final || !active.thread || !active.cliReported) return null;
        for (const k of keys) { usage[k] += active.sum[k]; peak[k] = Math.max(peak[k], active.sum[k]); reported[k] += active.thread[k]; }
        for (const k of keys) cliReported[k] += active.cliReported[k];
        completedTurns.push({ id: active.id, usage: active.sum, reported: active.thread,
          ...(active.cliReported ? { cliReported: active.cliReported } : {}), requestIds: active.requestIds });
        lastThread = active.thread; turnCount++; active = null;
      } else if (event.type === "event_msg" && p.type === "turn_aborted") return null;
    }
    if (active || !turnCount || keys.some(k => !Number.isSafeInteger(usage[k]) || !Number.isSafeInteger(reported[k]) || !Number.isSafeInteger(cliReported[k]))) return null;
    return { usage, peak, reported, lastThread, turnCount, requestIds: [...requests.keys()], turns: completedTurns,
      cliReported };
  } catch { return null; }
}
