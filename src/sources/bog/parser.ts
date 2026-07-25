import { ParseError } from "../../lib/errors.js";
import type { InterbankFxRate } from "./types.js";

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
