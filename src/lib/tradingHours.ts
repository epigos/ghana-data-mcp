/**
 * GSE session awareness, used only to pick a cache TTL (plan §7).
 *
 * Ghana keeps GMT (UTC+0) all year with no DST, so UTC arithmetic is exact and
 * no timezone database is needed.
 *
 * NOTE (plan §13, open question): the window below is padded around the
 * continuous-trading session on purpose. Getting it slightly wrong only means a
 * marginally shorter or longer TTL, never wrong data — so an approximate window
 * is safe until the exact hours are confirmed.
 */

/** Inclusive start of the padded session window, in minutes past 00:00 UTC. */
const SESSION_START_MINUTES = 9 * 60 + 30; // 09:30 GMT
/** Exclusive end of the padded session window. */
const SESSION_END_MINUTES = 15 * 60 + 30; // 15:30 GMT

export function isTradingWindow(now: Date = new Date()): boolean {
  const day = now.getUTCDay();
  if (day === 0 || day === 6) return false; // Sunday / Saturday

  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return minutes >= SESSION_START_MINUTES && minutes < SESSION_END_MINUTES;
}

/** 15 minutes while the market moves, 12 hours once the day's rows are settled. */
export function historyTtlSeconds(now: Date = new Date()): number {
  return isTradingWindow(now) ? 15 * 60 : 12 * 60 * 60;
}
