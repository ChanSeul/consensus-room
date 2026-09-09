import { parseUsageLimit } from "../../shared/usageLimit.js";
import type { AutoRetryState } from "../types.js";
import type { EngineCore } from "./core.js";

// 사용 한도(429)로 FAILED 가 된 주제를 리셋 시각에 스스로 retry 한다(2026-09-08 Codex 제안 ①). 사람이 리셋 시각까지
// 깨어 있다가 retry 를 누르던 대기가 그대로 작업 시간이었다(S6 08:50 리셋·S9 새벽 429 실측).
// 타이머는 메모리에, **시도 수·마지막 발화·예약 시각·사용자 취소는 DB(topics.auto_retry_json)** 에 둔다 — 재시작이 3회 상한이나
// stop 취소를 지우지 않게(Codex 후속 지적 4·5). 발화 전에는 다른 작업(실행·범위 변경·인도)이 없는지 확인하고, 있으면 건너뛴다
// (Codex 후속 지적 2: 범위 변경 잠금 중 발화 → 상태만 바꾸고 action 거부 → 고착).
export interface RetryClock {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export const SYSTEM_CLOCK: RetryClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => {
    const handle = setTimeout(callback, delayMs);
    handle.unref();
    return handle;
  },
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

// 리셋 시각 뒤 여유(한도 창이 시각 단위로 열린다), 리셋 시각을 못 읽었을 때의 대기, 연속 자동 재시도 상한, 상한 초기화 창.
export const USAGE_LIMIT_RETRY = {
  graceMs: 90_000,
  fallbackDelayMs: 30 * 60_000,
  maxDelayMs: 7 * 24 * 60 * 60_000,
  minDelayMs: 60_000,
  maxConsecutive: 3,
  progressWindowMs: 60 * 60_000,
} as const;

interface PendingRetry { handle: unknown; at: number; attempt: number }

export class UsageLimitRetryScheduler {
  private readonly pending = new Map<string, PendingRetry>();

  constructor(
    private readonly core: EngineCore,
    private readonly retry: (topicId: string) => string,
    private readonly clock: RetryClock = SYSTEM_CLOCK,
  ) {}

  private get database() { return this.core.dependencies.database; }

  // 실행 실패 직후 호출된다. 한도 실패가 아니면 지속 상태를 지운다(다른 종류의 실패는 사람이 본다).
  // failedAt: 메시지의 리셋 시각은 실패 시점 기준으로 읽어야 한다 — 재시작 복원처럼 한참 뒤에 읽으면 "8:50am" 이 이미 지난
  // 시각이라 다음 날로 밀린다. 대기 시간 자체는 지금 기준이다.
  consider(topicId: string, message: string, failedAt?: number): void {
    const now = this.clock.now();
    const limit = parseUsageLimit(message, new Date(failedAt ?? now));
    if (!limit) {
      this.cancel(topicId);
      this.database.setAutoRetry(topicId, null);
      return;
    }
    if (!limit.retryable) {
      this.core.event(topicId, "system", "system",
        "사용 한도 중 지출 한도(spend limit)는 관리자 조치가 필요해 자동 재시도하지 않습니다. 조치 뒤 retry 하세요.",
        { autoRetry: { skipped: "monthly-spend" } });
      return;
    }
    const stored = this.database.getAutoRetry(topicId);
    // 직전 자동 재시도 뒤 한 시간 넘게 진행했으면 새 한도 사건으로 본다 — 주간 한도가 여러 날에 걸쳐 여러 번 걸릴 수 있다.
    const recent = stored?.lastFiredAt !== null && stored?.lastFiredAt !== undefined && now - stored.lastFiredAt < USAGE_LIMIT_RETRY.progressWindowMs;
    const count = stored && recent ? stored.attempts : 0;
    if (count >= USAGE_LIMIT_RETRY.maxConsecutive) {
      this.database.setAutoRetry(topicId, { attempts: count, lastFiredAt: stored?.lastFiredAt ?? null, scheduledAt: null, cancelled: false });
      this.core.event(topicId, "system", "system",
        `사용 한도 자동 재시도를 연속 ${USAGE_LIMIT_RETRY.maxConsecutive}회 썼는데도 같은 실패입니다. 원인을 확인한 뒤 직접 retry 하세요.`,
        { autoRetry: { skipped: "max-consecutive", attempts: count } });
      return;
    }
    const delay = Math.min(USAGE_LIMIT_RETRY.maxDelayMs, limit.resetAt
      ? Math.max(USAGE_LIMIT_RETRY.minDelayMs, limit.resetAt.getTime() + USAGE_LIMIT_RETRY.graceMs - now)
      : USAGE_LIMIT_RETRY.fallbackDelayMs);
    const at = now + delay;
    const attempt = count + 1;
    this.arm(topicId, at, attempt);
    this.database.setAutoRetry(topicId, { attempts: count, lastFiredAt: stored?.lastFiredAt ?? null, scheduledAt: at, cancelled: false });
    const when = new Date(at).toISOString();
    this.core.event(topicId, "system", "system",
      `사용 한도(${limit.kind})로 멈춘 실행을 ${when} 에 자동 재시도합니다(${attempt}/${USAGE_LIMIT_RETRY.maxConsecutive}). ` +
        `${limit.resetAt ? `메시지의 리셋 시각 ${limit.resetAt.toISOString()} + ${Math.round(USAGE_LIMIT_RETRY.graceMs / 1000)}초. ` : "리셋 시각을 읽지 못해 기본 대기를 씁니다. "}` +
        "그 전에 retry·범위 변경을 하면 예약은 무효가 되고, stop 은 예약을 취소합니다.",
      { autoRetry: { at: when, attempt, kind: limit.kind, resetAt: limit.resetAt?.toISOString() ?? null } });
  }

  // 타이머만 거둔다(새 action 시작 등). 지속 상태의 예약 시각은 지운다 — 재시작 복원이 낡은 예약을 되살리지 않게.
  cancel(topicId: string): void {
    const pending = this.pending.get(topicId);
    if (pending) {
      this.clock.clearTimeout(pending.handle);
      this.pending.delete(topicId);
    }
    const stored = this.database.getAutoRetry(topicId);
    if (stored?.scheduledAt != null) this.database.setAutoRetry(topicId, { ...stored, scheduledAt: null });
  }

  // 사용자 stop: 예약을 취소하고 취소 사실을 남긴다(복원 대상에서 제외). 예약이 없었으면 false.
  cancelByUser(topicId: string): boolean {
    const stored = this.database.getAutoRetry(topicId);
    const had = this.pending.has(topicId) || stored?.scheduledAt != null;
    if (!had) return false;
    const pending = this.pending.get(topicId);
    if (pending) {
      this.clock.clearTimeout(pending.handle);
      this.pending.delete(topicId);
    }
    this.database.setAutoRetry(topicId, {
      attempts: stored?.attempts ?? 0, lastFiredAt: stored?.lastFiredAt ?? null, scheduledAt: null, cancelled: true,
    });
    this.core.event(topicId, "system", "system", "예약된 사용 한도 자동 재시도를 사용자가 취소했습니다. 재시작해도 되살리지 않습니다.",
      { autoRetry: { cancelled: true } });
    return true;
  }

  // 범위 변경: 예약과 지속 상태를 모두 지운다(새 세대는 새 사건).
  reset(topicId: string): void {
    const pending = this.pending.get(topicId);
    if (pending) {
      this.clock.clearTimeout(pending.handle);
      this.pending.delete(topicId);
    }
    this.database.setAutoRetry(topicId, null);
  }

  scheduledAt(topicId: string): string | null {
    const pending = this.pending.get(topicId);
    return pending ? new Date(pending.at).toISOString() : null;
  }

  // 재시작 뒤: FAILED 인 채 남은 주제의 예약을 지속 상태에서 복원한다. 사용자가 취소했거나 상한에 닿은 주제는 건드리지 않는다.
  restore(): number {
    let restored = 0;
    const now = this.clock.now();
    for (const topic of this.database.listTopics()) {
      if (topic.state !== "FAILED" || !topic.lastError) continue;
      if (!this.database.getFlags(topic.id).resumeState) continue;
      const stored = this.database.getAutoRetry(topic.id);
      if (stored?.cancelled) continue;
      if (stored?.scheduledAt != null) {
        const attempt = stored.attempts + 1;
        const at = Math.max(now + USAGE_LIMIT_RETRY.minDelayMs, stored.scheduledAt);
        this.arm(topic.id, at, attempt);
        this.core.event(topic.id, "system", "system",
          `재시작 뒤 사용 한도 자동 재시도 예약을 복원했습니다 — ${new Date(at).toISOString()} (${attempt}/${USAGE_LIMIT_RETRY.maxConsecutive}).`,
          { autoRetry: { restored: true, at: new Date(at).toISOString(), attempt } });
        restored += 1;
        continue;
      }
      if (stored && stored.attempts >= USAGE_LIMIT_RETRY.maxConsecutive) continue;
      if (!parseUsageLimit(topic.lastError, new Date(now))?.retryable) continue;
      const failedAt = Date.parse(topic.updatedAt);
      this.consider(topic.id, topic.lastError, Number.isFinite(failedAt) ? failedAt : undefined);
      if (this.pending.has(topic.id)) restored += 1;
    }
    return restored;
  }

  // 서버 종료: 타이머만 거둔다. 지속 상태는 남겨 재시작 복원이 잇는다.
  shutdown(): void {
    for (const [topicId, pending] of this.pending) this.clock.clearTimeout(pending.handle);
    this.pending.clear();
  }

  private arm(topicId: string, at: number, attempt: number): void {
    const pending = this.pending.get(topicId);
    if (pending) this.clock.clearTimeout(pending.handle);
    const handle = this.clock.setTimeout(() => this.fire(topicId, attempt), Math.max(0, at - this.clock.now()));
    this.pending.set(topicId, { handle, at, attempt });
  }

  private fire(topicId: string, attempt: number): void {
    this.pending.delete(topicId);
    const topic = this.database.getTopic(topicId);
    let blocked: string | null = topic.state !== "FAILED" ? `주제가 이미 ${topic.state} 상태` : null;
    if (!blocked) {
      try {
        this.core.assertNoActiveWork(topicId);
      } catch (error) {
        blocked = error instanceof Error ? error.message : String(error);
      }
    }
    if (blocked) {
      const stored = this.database.getAutoRetry(topicId);
      if (stored?.scheduledAt != null) this.database.setAutoRetry(topicId, { ...stored, scheduledAt: null });
      this.core.event(topicId, "system", "system", `예약된 자동 재시도를 건너뜁니다 — ${blocked}.`,
        { autoRetry: { skipped: "state", state: topic.state } });
      return;
    }
    const stored = this.database.getAutoRetry(topicId);
    this.database.setAutoRetry(topicId, {
      attempts: attempt, lastFiredAt: this.clock.now(), scheduledAt: null, cancelled: false,
      ...(stored ? {} : {}),
    });
    try {
      const actionId = this.retry(topicId);
      this.core.event(topicId, "system", "system", `사용 한도 리셋 뒤 자동 재시도를 시작했습니다(${attempt}/${USAGE_LIMIT_RETRY.maxConsecutive}).`,
        { autoRetry: { started: actionId, attempt } });
    } catch (error) {
      this.core.event(topicId, "system", "system",
        `자동 재시도를 시작하지 못했습니다: ${error instanceof Error ? error.message : String(error)}`, { autoRetry: { failed: attempt } });
    }
  }
}
