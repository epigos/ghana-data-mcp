import type { Granularity, PeriodMeta } from "./types.js";

/**
 * Period codes on StatsBank, and why they need their own module.
 *
 * PxWeb stores the time axis as opaque strings. StatsBank uses three shapes:
 *
 *   `2023`      annual
 *   `2024Q2`    quarterly
 *   `2024M06`   monthly
 *
 * plus an asterisk suffix on the GDP tables marking data GSS has not finalized:
 * `2024*` is provisional and `2025**` is a forecast. The asterisks are part of the
 * value, not decoration — a POST asking for `"2024"` on `agdp_e_px` returns 404
 * while `"2024*"` returns 200 (verified live). So a caller who types the obvious
 * thing gets an error unless something maps `2024` onto `2024*`, which is what
 * `matchPeriod` below is for.
 *
 * **The ordering trap.** PxWeb's documented `filter: "top"` takes the first N
 * values *in the order the table happens to store them*. Most StatsBank tables are
 * newest-first, so `top` looks like "latest N" and works by accident. `mieg` is
 * stored oldest-first, and there `top: 3` returns 2023M01-2023M03 — three months
 * whose growth values are all 0.0. Silently wrong data, no error. That is why this
 * source never sends `filter: "top"`: it reads the axis from the cached schema,
 * sorts it chronologically here, picks the periods itself, and sends them as
 * explicit `filter: "item"` values.
 */

const ANNUAL = /^(\d{4})(\*{1,2})?$/;
const QUARTERLY = /^(\d{4})Q([1-4])(\*{1,2})?$/i;
const MONTHLY = /^(\d{4})M(\d{1,2})(\*{1,2})?$/i;

/**
 * Parses one upstream period code. Returns undefined for anything that does not
 * match a known shape, so an unrecognized axis degrades to "no periods resolved"
 * with a readable error rather than a wrong series.
 */
export function parsePeriod(code: string): PeriodMeta | undefined {
  const raw = code.trim();
  if (!raw) return undefined;

  const annual = ANNUAL.exec(raw);
  if (annual) {
    return {
      code: raw,
      label: annual[1]!,
      granularity: "annual",
      year: Number(annual[1]),
      index: 1,
      provisional: Boolean(annual[2]),
    };
  }

  const quarterly = QUARTERLY.exec(raw);
  if (quarterly) {
    return {
      code: raw,
      label: `${quarterly[1]}Q${quarterly[2]}`,
      granularity: "quarterly",
      year: Number(quarterly[1]),
      index: Number(quarterly[2]),
      provisional: Boolean(quarterly[3]),
    };
  }

  const monthly = MONTHLY.exec(raw);
  if (monthly) {
    const month = Number(monthly[2]);
    if (month < 1 || month > 12) return undefined;
    return {
      code: raw,
      label: `${monthly[1]}M${String(month).padStart(2, "0")}`,
      granularity: "monthly",
      year: Number(monthly[1]),
      index: month,
      provisional: Boolean(monthly[3]),
    };
  }

  return undefined;
}

/** Parses a whole axis, dropping codes that do not match a known shape. */
export function parsePeriods(codes: readonly string[]): PeriodMeta[] {
  const parsed: PeriodMeta[] = [];
  for (const code of codes) {
    const period = parsePeriod(code);
    if (period) parsed.push(period);
  }
  return parsed;
}

/**
 * Chronological sort key. Granularity is the tiebreak so that on a mixed axis an
 * annual `2023` sorts before `2023Q1` rather than interleaving unpredictably —
 * though a mixed axis should have been narrowed to one granularity before this
 * matters. See `tables.ts` on `mixedGranularity`.
 */
const GRANULARITY_RANK: Record<Granularity, number> = { annual: 0, quarterly: 1, monthly: 2 };

function compareChronologically(a: PeriodMeta, b: PeriodMeta): number {
  if (a.year !== b.year) return a.year - b.year;
  if (a.granularity !== b.granularity) {
    return GRANULARITY_RANK[a.granularity] - GRANULARITY_RANK[b.granularity];
  }
  return a.index - b.index;
}

/** Oldest first, regardless of the order upstream stored the axis in. */
export function sortChronologically(periods: readonly PeriodMeta[]): PeriodMeta[] {
  return [...periods].sort(compareChronologically);
}

/**
 * The N most recent periods, oldest first.
 *
 * This is the function that replaces `filter: "top"`. It sorts first, so it is
 * correct on `mieg` (stored oldest-first) and on every other table alike.
 */
export function latestPeriods(periods: readonly PeriodMeta[], count: number): PeriodMeta[] {
  const sorted = sortChronologically(periods);
  return count >= sorted.length ? sorted : sorted.slice(sorted.length - count);
}

export function filterByGranularity(
  periods: readonly PeriodMeta[],
  granularity: Granularity,
): PeriodMeta[] {
  return periods.filter((p) => p.granularity === granularity);
}

/**
 * Matches a caller-supplied period against an axis, tolerantly.
 *
 * Accepts the exact upstream code (`2024*`), the same code without its provisional
 * markers (`2024`), and common spelling variants of the separators — `2024-Q2`,
 * `2024q2`, `2024-06` and `2024M6` all reach `2024M06`. Anything a caller is
 * likely to type for a period they saw in a `gss_describe_table` response should
 * land here rather than becoming a 404.
 */
export function matchPeriod(
  requested: string,
  periods: readonly PeriodMeta[],
): PeriodMeta | undefined {
  const exact = requested.trim().toLowerCase();
  for (const period of periods) {
    if (period.code.toLowerCase() === exact) return period;
  }

  // `normalizeRequestedPeriod` returns the canonical label casing (`2024M06`), so
  // both sides are lowercased here rather than assuming either already is.
  const wanted = normalizeRequestedPeriod(requested)?.toLowerCase();
  if (!wanted) return undefined;
  for (const period of periods) {
    if (period.label.toLowerCase() === wanted) return period;
  }
  return undefined;
}

/**
 * Folds a caller's spelling onto the canonical `label` form: markers stripped,
 * separators removed, month zero-padded, `Q`/`M` upper-cased.
 */
function normalizeRequestedPeriod(requested: string): string | undefined {
  const cleaned = requested.trim().replace(/\*+$/, "").replace(/[\s\-_/]+/g, "");
  if (!cleaned) return undefined;

  const quarterly = /^(\d{4})q([1-4])$/i.exec(cleaned);
  if (quarterly) return `${quarterly[1]}Q${quarterly[2]}`;

  const monthly = /^(\d{4})m(\d{1,2})$/i.exec(cleaned);
  if (monthly) {
    const month = Number(monthly[2]);
    if (month < 1 || month > 12) return undefined;
    return `${monthly[1]}M${String(month).padStart(2, "0")}`;
  }

  // A bare `2024-06` reads as a month; `2024` alone reads as a year.
  const bareMonth = /^(\d{4})(\d{2})$/.exec(cleaned);
  if (bareMonth) {
    const month = Number(bareMonth[2]);
    if (month >= 1 && month <= 12) return `${bareMonth[1]}M${bareMonth[2]}`;
  }

  if (/^\d{4}$/.test(cleaned)) return cleaned;
  return undefined;
}

/**
 * Inclusive range filter. Either bound may be omitted, and both are matched with
 * the same tolerance as `matchPeriod` so `startPeriod: "2024"` works on a GDP
 * table whose axis actually reads `2024*`.
 */
export function periodsInRange(
  periods: readonly PeriodMeta[],
  startPeriod: string | undefined,
  endPeriod: string | undefined,
): { periods: PeriodMeta[]; unmatched: string[] } {
  const sorted = sortChronologically(periods);
  const unmatched: string[] = [];

  let start: PeriodMeta | undefined;
  if (startPeriod !== undefined) {
    start = matchPeriod(startPeriod, sorted);
    if (!start) unmatched.push(startPeriod);
  }

  let end: PeriodMeta | undefined;
  if (endPeriod !== undefined) {
    end = matchPeriod(endPeriod, sorted);
    if (!end) unmatched.push(endPeriod);
  }

  const selected = sorted.filter((period) => {
    if (start && compareChronologically(period, start) < 0) return false;
    if (end && compareChronologically(period, end) > 0) return false;
    return true;
  });

  return { periods: selected, unmatched };
}
