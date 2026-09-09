// 사용 한도(429) 실패 메시지의 해석. 이 방에서 429 는 일시적 과부하가 아니라 **세션·주간 한도 + 리셋 시각** 형태로
// 온다(2026-09-03·09-07 실측: "You've hit your session limit · resets 8:50am (Asia/Seoul) (429)",
// "You've hit your weekly limit · resets Sep 6 at 1pm (Asia/Seoul) (429)"). 리셋 시각을 알면 사람이 깨어서 retry 를
// 누를 이유가 없다 — 엔진이 그 시각에 같은 세션을 resume 한다(2026-09-08 Codex 제안 ①: 시스템 오류 때문에 생기는
// 재시도 제거). 지출 한도("monthly spend limit")는 관리자 조치가 필요하므로 자동 재시도 대상이 아니다.

export interface UsageLimitFailure {
  kind: "session" | "weekly" | "monthly-spend" | "unknown";
  // 메시지가 실은 리셋 시각. 없으면 null — 호출자가 기본 대기(FALLBACK)를 쓴다.
  resetAt: Date | null;
  retryable: boolean;
}

const LIMIT_PATTERN = /\(429\)|\b429\b|usage limit|hit your (?:[\w']+ ){0,3}limit|rate[ -]?limit/i;
const RESET_PATTERN =
  /resets?\s+(?:(?:on\s+)?([A-Za-z]{3,9})\s+(\d{1,2})\s+at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

export function parseUsageLimit(message: string, now: Date = new Date()): UsageLimitFailure | null {
  if (!LIMIT_PATTERN.test(message)) return null;
  const spend = /spend limit/i.test(message);
  const kind: UsageLimitFailure["kind"] = spend
    ? "monthly-spend"
    : /weekly limit/i.test(message) ? "weekly" : /session limit/i.test(message) ? "session" : "unknown";
  return { kind, resetAt: parseResetTime(message, now), retryable: !spend };
}

// "resets 8:50am (Asia/Seoul)" · "resets Sep 6 at 1pm (Asia/Seoul)" · "resets 15:20". 시간대 괄호가 IANA 이름이면 그 시간대로,
// 아니면 서버 로컬 시간대로 해석한다. 날짜 없는 시각이 이미 지났으면 다음 날로 본다.
export function parseResetTime(message: string, now: Date = new Date()): Date | null {
  const match = RESET_PATTERN.exec(message);
  if (!match) return null;
  const [, monthName, dayText, hourText, minuteText, meridiem, zoneText] = match;
  let hour = Number(hourText);
  if (!Number.isFinite(hour) || hour > 23) return null;
  if (meridiem) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (meridiem.toLowerCase() === "pm" ? 12 : 0);
  }
  const minute = minuteText ? Number(minuteText) : 0;
  const timeZone = resolveTimeZone(zoneText);
  const current = zonedComponents(now, timeZone);
  let year = current.year;
  let month = current.month;
  let day = current.day;
  if (monthName && dayText) {
    const index = MONTHS.indexOf(monthName.slice(0, 3).toLowerCase());
    if (index < 0) return null;
    month = index + 1;
    day = Number(dayText);
  }
  let instant = zonedToUTC({ year, month, day, hour, minute }, timeZone);
  if (monthName && dayText) {
    // 연도가 없는 날짜: 하루 넘게 지난 과거면 다음 해로 본다(연말 경계).
    if (instant < now.getTime() - 24 * 60 * 60 * 1000) instant = zonedToUTC({ year: year + 1, month, day, hour, minute }, timeZone);
  } else if (instant <= now.getTime()) {
    instant = zonedToUTC({ year, month, day: day + 1, hour, minute }, timeZone);
  }
  return new Date(instant);
}

function resolveTimeZone(zoneText: string | undefined): string {
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
  if (!zoneText || !/^[A-Za-z_]+(?:\/[A-Za-z_+-]+)+$/.test(zoneText.trim())) return local;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zoneText.trim() });
    return zoneText.trim();
  } catch {
    return local;
  }
}

interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second?: number }

function zonedComponents(date: Date, timeZone: string): Required<WallClock> {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
  }).formatToParts(date);
  const read = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? "0");
  return { year: read("year"), month: read("month"), day: read("day"), hour: read("hour") % 24, minute: read("minute"), second: read("second") };
}

// 벽시계 → UTC 순간. UTC 로 가정한 값에서 시작해 그 순간의 시간대 벽시계와의 차이로 두 번 보정한다(DST 경계 포함).
function zonedToUTC(wall: WallClock, timeZone: string): number {
  const target = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
  let guess = target;
  for (let round = 0; round < 2; round += 1) {
    const seen = zonedComponents(new Date(guess), timeZone);
    const asUTC = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute, seen.second);
    guess += target - asUTC;
  }
  return guess;
}
