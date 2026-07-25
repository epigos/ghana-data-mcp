import { ParseError } from "../../lib/errors.js";
import type { BillRate, InterbankFxRate } from "./types.js";

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
 * Normalizes the interbank FX table into typed rows, sorted by currency pair.
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
    const currency = text(raw[FX_COLUMNS.currency]);
    const pair = text(raw[FX_COLUMNS.pair]).toUpperCase();
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

  rows.sort((a, b) => a.pair.localeCompare(b.pair));
  return { rows, skipped };
}

function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    const securityType = text(raw[BILL_RATE_COLUMNS.securityType]);
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
    const tenderNumber = text(raw[BILL_RATE_COLUMNS.tenderNumber]).replace(/,/g, "");

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
