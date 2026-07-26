import { ParseError } from "../../lib/errors.js";
import { stripHtml } from "../../lib/text.js";
import type { BillRate, InterbankFxRate, InterestRatePoint } from "./types.js";

/**
 * Pure transformation of Bank of Ghana responses. No network, no bindings —
 * everything here is unit-testable against the fixtures in test/fixtures.
 */

/**
 * Column indices for the interbank FX table (31):
 *
 *   0 dt_date            3 vl_bid
 *   1 ds_currency        4 vl_offer
 *   2 cd_currency_pair   5 vl_mid
 */
export const FX_COLUMNS = {
  date: 0,
  currency: 1,
  pair: 2,
  bid: 3,
  offer: 4,
  mid: 5,
} as const;

const MIN_FX_ROW_LENGTH = 6;

/**
 * Column indices for the bill-rate tables (2 and 3), which share one layout:
 *
 *   0 dt_issue_date      3 vl_discount_rate
 *   1 cd_tender_number   4 vl_interest_rate
 *   2 ds_security_type
 */
export const BILL_RATE_COLUMNS = {
  date: 0,
  tenderNumber: 1,
  securityType: 2,
  discountRate: 3,
  interestRate: 4,
} as const;

const MIN_BILL_ROW_LENGTH = 5;

const MONTHS: Readonly<Record<string, number>> = Object.freeze({
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
});

/**
 * Parses BoG's date format into ISO `YYYY-MM-DD`.
 *
 * BoG writes `24 Jul 2026` — a month *name*, where GSE writes `24/07/2026`. The
 * page's own wpDataTables config confirms the format as `dd M yy`. So the GSE
 * day-first parser does not apply here, and this is deliberately a strict pattern
 * match rather than `Date.parse`, which is locale- and runtime-dependent on
 * exactly this kind of input.
 */
export function parseBogDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const match = /^(\d{1,2})\s+([A-Za-z]{3,})\s+(\d{4})$/.exec(raw.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[(match[2] as string).slice(0, 3).toLowerCase()];
  const year = Number(match[3]);
  if (!month || day < 1 || day > 31) return null;

  // Round-trip through UTC to reject impossible dates like 31 Feb.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

/**
 * Parses a BoG-formatted number: thousands separators stripped, negatives kept.
 * Returns `null` for anything blank or unreadable.
 */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;

  const cleaned = raw.replace(/,/g, "").replace(/\s/g, "").replace(/^\+/, "");
  if (cleaned === "" || cleaned === "-" || cleaned.toUpperCase() === "N/A") return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

export interface ParsedFxRates {
  rows: InterbankFxRate[];
  skipped: number;
}

export interface ParseFxOptions {
  /**
   * Restrict to one currency. Matched against both the ISO-ish pair prefix
   * (`USD` from `USDGHS`) and the currency name, so `USD` and `dollar` both work.
   */
  currency?: string;
}

/**
 * Normalizes the interbank FX table into typed rows, oldest first.
 *
 * All three prices are required: a row with a bid but no mid is not partially
 * useful for a caller quoting a rate, it is a row to leave out.
 */
export function parseInterbankFxPayload(
  payload: unknown,
  options: ParseFxOptions = {},
): ParsedFxRates {
  const data = extractDataArray(payload);
  const wanted = options.currency?.trim().toUpperCase();

  const rows: InterbankFxRate[] = [];
  let skipped = 0;

  for (const raw of data) {
    if (!Array.isArray(raw) || raw.length < MIN_FX_ROW_LENGTH) {
      skipped++;
      continue;
    }

    const date = parseBogDate(raw[FX_COLUMNS.date]);
    const currency = stripHtml(raw[FX_COLUMNS.currency]);
    const pair = stripHtml(raw[FX_COLUMNS.pair]).toUpperCase();
    if (!date || !currency || !pair) {
      skipped++;
      continue;
    }

    const bid = parseNumber(raw[FX_COLUMNS.bid]);
    const offer = parseNumber(raw[FX_COLUMNS.offer]);
    const mid = parseNumber(raw[FX_COLUMNS.mid]);
    if (bid === null || offer === null || mid === null) {
      skipped++;
      continue;
    }

    // `USDGHS` → `USD`. Every pair on this table is quoted against the cedi.
    const code = pair.endsWith("GHS") ? pair.slice(0, -3) : pair;

    if (wanted && code !== wanted && currency.toUpperCase() !== wanted) continue;

    rows.push({ date, currency, code, pair, bid, offer, mid });
  }

  // Date first, then pair. With a single-date snapshot this is just the pair sort,
  // but a historical window arrives newest-first from upstream, and every other tool
  // in this project returns oldest-first — so leaving it would have made `rates`
  // silently disagree with the rest and put the newest row where callers look for
  // the oldest.
  rows.sort((a, b) =>
    a.date === b.date ? a.pair.localeCompare(b.pair) : a.date < b.date ? -1 : 1,
  );
  return { rows, skipped };
}

function extractDataArray(payload: unknown): unknown[] {
  if (!payload || typeof payload !== "object") {
    throw new ParseError("expected a JSON object from admin-ajax.php");
  }
  const data = (payload as { data?: unknown }).data;
  if (!Array.isArray(data)) {
    throw new ParseError("response has no `data` array — the table layout may have changed");
  }
  return data;
}

/**
 * Reads a tenor in days out of BoG's security label.
 *
 * `91 DAY BILL` → 91. Returns null for anything quoted in years (`2 YR FXR NOTE`),
 * because converting those to days would invent precision BoG does not publish —
 * a "2 YR" note is not exactly 730 days and nothing here knows its real maturity.
 */
export function parseTenorDays(securityType: string): number | null {
  const match = /^(\d+)\s*DAY\b/i.exec(securityType.trim());
  if (!match) return null;
  const days = Number(match[1]);
  return Number.isFinite(days) && days > 0 ? days : null;
}

/**
 * Resolves a loose currency input to the exact pair the upstream filter needs.
 *
 * `USD`, `usd` and `usdghs` all give `USDGHS`. A currency *name* ("US Dollar")
 * cannot be resolved without the published list, so it returns null and the caller
 * filters in memory instead.
 */
export function resolveCurrencyPair(currency: string): string | null {
  const cleaned = currency.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!cleaned) return null;
  if (cleaned.endsWith("GHS") && cleaned.length > 3) return cleaned;
  // Codes on this table run 2-4 characters (WAU, XOF, USD, ZAR).
  return /^[A-Z0-9]{2,4}$/.test(cleaned) ? `${cleaned}GHS` : null;
}

export interface ParsedBillRates {
  rows: BillRate[];
  skipped: number;
}

export interface ParseBillRateOptions {
  /**
   * Restrict to one security. Matched leniently — `91`, `91 DAY` and
   * `91 DAY BILL` all work, case-insensitively.
   *
   * Filtering happens here rather than upstream on purpose: the site's own
   * security-type search matches the whole value exactly despite advertising
   * regex, so `364 DAY` silently returns nothing. Doing it in memory lets a caller
   * say the obvious thing and get the obvious answer.
   */
  securityType?: string;
}

/** Normalizes a bill-rate table into typed rows, ascending by date. */
export function parseBillRatePayload(
  payload: unknown,
  options: ParseBillRateOptions = {},
): ParsedBillRates {
  const data = extractDataArray(payload);
  const wanted = options.securityType?.trim().toUpperCase();

  const rows: BillRate[] = [];
  let skipped = 0;

  for (const raw of data) {
    if (!Array.isArray(raw) || raw.length < MIN_BILL_ROW_LENGTH) {
      skipped++;
      continue;
    }

    const date = parseBogDate(raw[BILL_RATE_COLUMNS.date]);
    const securityType = stripHtml(raw[BILL_RATE_COLUMNS.securityType]);
    if (!date || !securityType) {
      skipped++;
      continue;
    }

    const discountRate = parseNumber(raw[BILL_RATE_COLUMNS.discountRate]);
    const interestRate = parseNumber(raw[BILL_RATE_COLUMNS.interestRate]);
    if (discountRate === null || interestRate === null) {
      skipped++;
      continue;
    }

    if (wanted && !securityType.toUpperCase().startsWith(wanted)) continue;

    const tenorDays = parseTenorDays(securityType);
    // Tender numbers arrive with thousands separators (`1,517`); they are
    // identifiers, so the separator is noise rather than magnitude.
    const tenderNumber = stripHtml(raw[BILL_RATE_COLUMNS.tenderNumber]).replace(/,/g, "");

    rows.push({
      date,
      tenderNumber,
      securityType,
      ...(tenorDays !== null ? { tenorDays } : {}),
      discountRate,
      interestRate,
    });
  }

  rows.sort((a, b) =>
    a.date === b.date ? a.securityType.localeCompare(b.securityType) : a.date < b.date ? -1 : 1,
  );
  return { rows, skipped };
}

/**
 * Column indices for all four interbank interest-rate tables, which share a layout:
 *
 *   0 <post_type>_ID   1 date   2 rate
 *
 * Column 0 is wpDataTables' internal row id, not anything a caller wants, so it is
 * dropped rather than surfaced as a field that invites use.
 */
export const INTEREST_RATE_COLUMNS = { date: 1, rate: 2 } as const;

const MIN_INTEREST_ROW_LENGTH = 3;

export interface ParsedInterestRates {
  rows: InterestRatePoint[];
  skipped: number;
}

export interface ParseInterestRateOptions {
  /** Drop anything published before this ISO date. Applied here, not upstream. */
  from?: string;
}

/**
 * Normalizes an interbank interest-rate series into typed points, oldest first.
 *
 * Rows with a blank date are dropped and counted: the two MPC-derived series each
 * carry a couple of them (a rate with no effective date is not placeable on a
 * timeline), so `skipped` is expected to be non-zero for those and does not indicate
 * a parsing fault.
 */
export function parseInterestRatePayload(
  payload: unknown,
  options: ParseInterestRateOptions = {},
): ParsedInterestRates {
  const data = extractDataArray(payload);

  const rows: InterestRatePoint[] = [];
  let skipped = 0;

  for (const raw of data) {
    if (!Array.isArray(raw) || raw.length < MIN_INTEREST_ROW_LENGTH) {
      skipped++;
      continue;
    }

    const date = parseBogDate(stripHtml(raw[INTEREST_RATE_COLUMNS.date]));
    const rate = parseNumber(raw[INTEREST_RATE_COLUMNS.rate]);
    if (!date || rate === null) {
      skipped++;
      continue;
    }

    // Filtered, not malformed — the window is applied after the fetch because these
    // tables reject a date-range search.
    if (options.from && date < options.from) continue;

    rows.push({ date, rate });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, skipped };
}
