import { normalizeShareCode } from "./parser.js";
import type { RankedStock, RankExclusion, RankMetric, RankOrder, StockPriceRow } from "./types.js";

/**
 * Performance aggregation and ranking for the GSE price table. Pure: no network,
 * no clock, no bindings, so every rule below is unit-testable against a fixture.
 *
 * The whole module exists because of one property of the upstream data: **GSE
 * publishes a row for every listed security on every trading day, whether or not
 * it traded.** An untraded session carries the previous close forward and reports
 * `volume: 0` and `change: 0.00`. Measured live, 12 of 41 securities were quoted
 * but untraded on a single session, and three never traded across a whole month.
 *
 * Two consequences run through everything here:
 *
 *  - A naive ranking is mostly noise. On volume it returns a pile of ties at zero;
 *    on return it returns a pile of ties at 0.00% that look like real flat
 *    performers. Hence the liquidity filter in `rankStocks`.
 *  - A return can be arithmetically correct over two prices that are months apart.
 *    A security that last traded at 5.00 two hundred days ago and at 8.00 last week
 *    reports "+60% over 30 days". That cannot be prevented — the carried-forward
 *    close genuinely is the market's last valuation — so instead it is made
 *    *visible*, via `tradingDays`, `lastTradedDate` and the two carried-forward
 *    flags.
 */

/** One security's rows collapsed to a single window summary. No policy applied. */
export interface SymbolWindow {
  symbol: string;
  startDate: string;
  startClose: number;
  endDate: string;
  endClose: number;
  percentReturn: number | null;
  priceChange: number | null;
  totalVolume: number;
  totalValueTraded?: number;
  quotedDays: number;
  tradingDays: number;
  lastTradedDate?: string;
  startIsCarriedForward: boolean;
  endIsCarriedForward: boolean;
}

export interface WindowSummary {
  /** Sorted by share code, so output ordering never depends on upstream ordering. */
  symbols: SymbolWindow[];
  /** Distinct trading sessions anywhere in the payload. */
  sessions: number;
  startDate?: string;
  endDate?: string;
}

/**
 * Groups rows by normalized share code and reduces each group to one summary.
 *
 * Rows are expected date-ascending, which `parseHistoryPayload` already guarantees;
 * this sorts defensively anyway rather than trusting an ordering it did not
 * establish, because getting first/last backwards silently inverts every return.
 */
export function summarizeWindow(rows: readonly StockPriceRow[]): WindowSummary {
  const grouped = new Map<string, StockPriceRow[]>();
  const sessions = new Set<string>();

  for (const row of rows) {
    const symbol = normalizeShareCode(row.symbol);
    if (!symbol) continue;
    let bucket = grouped.get(symbol);
    if (!bucket) grouped.set(symbol, (bucket = []));
    bucket.push(row);
    sessions.add(row.date);
  }

  const symbols = [...grouped.entries()]
    .map(([symbol, group]) => summarizeSymbol(symbol, group))
    .sort((a, b) => a.symbol.localeCompare(b.symbol));

  const allDates = [...sessions].sort();

  return {
    symbols,
    sessions: allDates.length,
    ...(allDates[0] ? { startDate: allDates[0] } : {}),
    ...(allDates.at(-1) ? { endDate: allDates.at(-1) as string } : {}),
  };
}

function summarizeSymbol(symbol: string, group: readonly StockPriceRow[]): SymbolWindow {
  const ordered = [...group].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const first = ordered[0] as StockPriceRow;
  const last = ordered.at(-1) as StockPriceRow;

  let totalVolume = 0;
  let tradingDays = 0;
  let lastTradedDate: string | undefined;

  // Turnover is summed only if every session that traded reported one. A partial
  // sum would understate liquidity while looking authoritative, which is worse
  // than declining to answer.
  let totalValueTraded = 0;
  let valueTradedComplete = true;

  for (const row of ordered) {
    totalVolume += row.volume;
    if (row.volume > 0) {
      tradingDays++;
      lastTradedDate = row.date;
      if (row.valueTraded === undefined) valueTradedComplete = false;
      else totalValueTraded += row.valueTraded;
    }
  }

  // Guarded rather than assumed: a zero baseline would yield Infinity or NaN, and
  // neither may reach an output schema that promises a number.
  const hasBaseline = Number.isFinite(first.close) && first.close > 0;
  const percentReturn = hasBaseline ? ((last.close - first.close) / first.close) * 100 : null;

  return {
    symbol,
    startDate: first.date,
    startClose: first.close,
    endDate: last.date,
    endClose: last.close,
    percentReturn,
    // endClose - startClose, never sum(row.change). The `change` column is a delta
    // against the previous close, so summing it drifts whenever a session is
    // missing from the window — and sessions are missing all the time.
    priceChange: hasBaseline ? last.close - first.close : null,
    totalVolume,
    ...(valueTradedComplete && tradingDays > 0 ? { totalValueTraded } : {}),
    quotedDays: ordered.length,
    tradingDays,
    ...(lastTradedDate ? { lastTradedDate } : {}),
    startIsCarriedForward: first.volume === 0,
    endIsCarriedForward: last.volume === 0,
  };
}

export interface RankOptions {
  metric: RankMetric;
  order: RankOrder;
  limit: number;
  /**
   * Already resolved to normalized share codes. Present means basket mode, where
   * the liquidity filter is not applied — see `rankStocks`.
   */
  symbols?: readonly string[];
  minTradingDays: number;
  /** Normalized share code to company name, best-effort. */
  names?: ReadonlyMap<string, string>;
}

export interface RankResult {
  rankings: RankedStock[];
  excluded: RankExclusion[];
  /** Distinct securities quoted in the window, before any filtering. */
  quoted: number;
}

/**
 * Filters, sorts and numbers a window summary.
 *
 * The liquidity filter applies **only when ranking the whole market**. If a caller
 * named the securities they want compared, every one of them comes back even if it
 * never traded — silently dropping one of three securities somebody explicitly
 * asked about would be a worse failure than any warning text.
 */
export function rankStocks(summary: WindowSummary, options: RankOptions): RankResult {
  const requested = options.symbols?.map(normalizeShareCode).filter(Boolean);
  const basketMode = requested !== undefined && requested.length > 0;
  const wanted = basketMode ? new Set(requested) : undefined;

  const candidates = wanted
    ? summary.symbols.filter((entry) => wanted.has(entry.symbol))
    : summary.symbols;

  const excluded: RankExclusion[] = [];
  const kept: SymbolWindow[] = [];

  for (const entry of candidates) {
    const reason = basketMode ? undefined : exclusionReasonFor(entry, options.minTradingDays);
    if (reason) excluded.push({ symbol: entry.symbol, reason });
    else kept.push(entry);
  }

  const sorted = kept.sort((a, b) => compareByMetric(a, b, options.metric, options.order));
  const limited = basketMode ? sorted : sorted.slice(0, options.limit);

  return {
    rankings: limited.map((entry, index) => toRankedStock(entry, index + 1, options.names)),
    excluded: excluded.sort((a, b) => a.symbol.localeCompare(b.symbol)),
    quoted: candidates.length,
  };
}

function exclusionReasonFor(
  entry: SymbolWindow,
  minTradingDays: number,
): RankExclusion["reason"] | undefined {
  if (entry.percentReturn === null) return "no-baseline-price";
  if (entry.tradingDays === 0 && minTradingDays > 0) return "untraded";
  if (entry.tradingDays < minTradingDays) return "too-few-trading-days";
  return undefined;
}

function metricValue(entry: SymbolWindow, metric: RankMetric): number | null {
  switch (metric) {
    case "percentReturn":
      return entry.percentReturn;
    case "priceChange":
      return entry.priceChange;
    case "volume":
      return entry.totalVolume;
    case "valueTraded":
      return entry.totalValueTraded ?? null;
  }
}

/**
 * Securities with no computable value for the chosen metric always sort last, in
 * both directions. Under `asc` they would otherwise masquerade as the worst
 * performers, which is a different claim from "we could not measure this".
 */
function compareByMetric(
  a: SymbolWindow,
  b: SymbolWindow,
  metric: RankMetric,
  order: RankOrder,
): number {
  const left = metricValue(a, metric);
  const right = metricValue(b, metric);

  if (left === null && right === null) return a.symbol.localeCompare(b.symbol);
  if (left === null) return 1;
  if (right === null) return -1;

  const delta = order === "asc" ? left - right : right - left;
  return delta !== 0 ? delta : a.symbol.localeCompare(b.symbol);
}

function toRankedStock(
  entry: SymbolWindow,
  rank: number,
  names?: ReadonlyMap<string, string>,
): RankedStock {
  const name = names?.get(entry.symbol);
  return {
    rank,
    symbol: entry.symbol,
    ...(name ? { name } : {}),
    startDate: entry.startDate,
    startClose: entry.startClose,
    endDate: entry.endDate,
    endClose: entry.endClose,
    percentReturn: round(entry.percentReturn, 2),
    priceChange: round(entry.priceChange, 4),
    totalVolume: entry.totalVolume,
    ...(entry.totalValueTraded !== undefined
      ? { totalValueTraded: round(entry.totalValueTraded, 2) as number }
      : {}),
    quotedDays: entry.quotedDays,
    tradingDays: entry.tradingDays,
    ...(entry.lastTradedDate ? { lastTradedDate: entry.lastTradedDate } : {}),
    startIsCarriedForward: entry.startIsCarriedForward,
    endIsCarriedForward: entry.endIsCarriedForward,
  };
}

/** Keeps float noise out of the output; nulls pass through untouched. */
function round(value: number | null, places: number): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/**
 * Cached window buckets.
 *
 * Keying the cache on the raw `days` would make 30 and 31 two separate scrapes of
 * someone else's WordPress install. Quantizing caps this tool's entire upstream
 * footprint at five distinct queries no matter how many windows callers ask for,
 * which is the trade CONTRIBUTING's scraping-etiquette rules ask for: one larger
 * response beats many small ones.
 */
export const WINDOW_BUCKETS = [7, 30, 90, 180, 400] as const;

export function windowBucket(days: number): number {
  const largest = WINDOW_BUCKETS[WINDOW_BUCKETS.length - 1] as number;
  return WINDOW_BUCKETS.find((bucket) => bucket >= days) ?? largest;
}

/** Narrows a wider cached bucket to the window actually asked for. Inclusive. */
export function trimToWindow(rows: readonly StockPriceRow[], onOrAfter: string): StockPriceRow[] {
  return rows.filter((row) => row.date >= onOrAfter);
}

/** ISO date `days` before `now`, in UTC — Ghana is GMT year-round. */
export function windowStartDate(days: number, now: Date): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return start.toISOString().slice(0, 10);
}
