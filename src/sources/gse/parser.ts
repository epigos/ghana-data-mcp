import { parseHTML } from "linkedom";

import { ParseError, UpstreamError } from "../../lib/errors.js";
import { stripHtml } from "../../lib/text.js";
import type {
  Company,
  FixedIncomeIssuer,
  Market,
  MarketIndexRow,
  StockPriceRow,
} from "./types.js";

/**
 * Pure transformation of what gse.com.gh sends back. No network, no bindings —
 * everything here is unit-testable against the fixtures in test/fixtures.
 */

/**
 * Column indices in the wpDataTables payload for table 39, confirmed against
 * the live `<thead>`:
 *
 *   0 wdt_ID              7 Last Transaction Price
 *   1 Daily Date          8 Closing Price - VWAP
 *   2 Share Code          9 Price Change
 *   3 Year High          10 Closing Bid Price
 *   4 Year Low           11 Closing Offer Price
 *   5 Previous Close     12 Total Shares Traded
 *   6 Opening Price      13 Total Value Traded
 */
export const HISTORY_COLUMNS = {
  date: 1,
  symbol: 2,
  high: 3,
  low: 4,
  open: 6,
  close: 8,
  change: 9,
  volume: 12,
  valueTraded: 13,
} as const;

/**
 * Highest index we *require*; a shorter row cannot be a price row.
 *
 * Deliberately still 13, not 14, even though `valueTraded` reads index 13. That
 * field is optional: raising this to 14 would start discarding any row GSE happens
 * to send short, which would silently shrink results from a tool that works today.
 * A missing index 13 simply yields `undefined`, and the field is omitted.
 */
const MIN_ROW_LENGTH = 13;

/**
 * Strips GSE's own annotation markers off a share code.
 *
 * The price table stores some codes decorated — `**ALW**` and `PBC**` are both
 * live examples — while the company directory lists them plain. Grouping rows by
 * the raw string would split one security in two, so everything downstream
 * compares normalized codes.
 *
 * Only leading and trailing markers are removed. Interior spaces and dots survive,
 * because `SCB PREF` is a genuinely different security from `SCB` and collapsing
 * them would merge a preference share into an ordinary one.
 */
export function normalizeShareCode(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/^[*#†\s]+/, "")
    .replace(/[*#†\s]+$/, "");
}

/**
 * Column indices for the listed-companies tables (34 main market, 35 ETFs,
 * 36 Ghana Alternative Market), which share one layout:
 *
 *   0 wdt_ID              4 Stated Capital
 *   1 Symbol              5 Issued Shares
 *   2 Company             6 Authorised Shares
 *   3 Date Listed
 */
export const COMPANY_COLUMNS = {
  symbol: 1,
  name: 2,
  dateListed: 3,
  statedCapital: 4,
  issuedShares: 5,
  authorisedShares: 6,
} as const;

const MIN_COMPANY_ROW_LENGTH = 7;

/**
 * Column indices for the market-summary table (47):
 *
 *   0 wdt_ID    3 Volume                       5 Market Capitalization (GH¢ million)
 *   1 Day       4 GSE Composite Index (GSE-CI) 6 Financial Stock Index
 *   2 Date
 *
 * Column 1 (the weekday name) is skipped: it is derivable from the date, and
 * GSE's own values are inconsistently padded (`"Thursday "`).
 */
export const MARKET_INDEX_COLUMNS = {
  date: 2,
  volume: 3,
  compositeIndex: 4,
  marketCapGhsMillion: 5,
  financialStockIndex: 6,
} as const;

const MIN_MARKET_INDEX_ROW_LENGTH = 7;

/**
 * Column indices for the GFIM corporate-issuer table (37):
 *
 *   0 wdt_ID           2 Admitted on GFIM     4 Amount Raised (GHS Million)
 *   1 Name Of Issuer   3 Number Of Tranches   5 Shelf Registration (GHS Million)
 */
export const FIXED_INCOME_COLUMNS = {
  name: 1,
  admittedYear: 2,
  tranches: 3,
  amountRaisedGhsMillion: 4,
  shelfRegistrationGhsMillion: 5,
} as const;

const MIN_FIXED_INCOME_ROW_LENGTH = 6;

/**
 * Pulls the wpDataTables edit nonce out of the page. The nonce is per-table, so
 * `tableId` picks between the price table (39) and the market-index table (47)
 * that share the page.
 *
 * A missing nonce is an `UpstreamError`, not a `ParseError`: in practice it
 * means we were served an interstitial or error page instead of the real one,
 * which a retry can fix.
 */
export function extractNonce(html: string, tableId: number): string {
  const { document } = parseHTML(html);
  const selector = `input#wdtNonceFrontendEdit_${tableId}`;
  const input = document.querySelector(selector);

  if (!input) {
    throw new UpstreamError(
      `no ${selector} element on the page — gse.com.gh may have served an error or challenge page`,
    );
  }

  const nonce = input.getAttribute("value")?.trim();
  if (!nonce) {
    throw new UpstreamError(`${selector} has no value attribute`);
  }
  return nonce;
}

/**
 * Reads several tables' nonces from one page. The listed-companies page carries
 * four tables, so parsing the document once and taking every nonce we need
 * saves three redundant page fetches.
 */
export function extractNonces(html: string, tableIds: readonly number[]): Record<number, string> {
  const { document } = parseHTML(html);
  const nonces: Record<number, string> = {};

  for (const tableId of tableIds) {
    const selector = `input#wdtNonceFrontendEdit_${tableId}`;
    const value = document.querySelector(selector)?.getAttribute("value")?.trim();
    if (!value) {
      throw new UpstreamError(
        `no usable ${selector} on the page — gse.com.gh may have served an error or challenge page`,
      );
    }
    nonces[tableId] = value;
  }

  return nonces;
}

/**
 * wpDataTables renders the company Symbol column as a link —
 * `<a href='ACCESS' ...>ACCESS</a>` — so the raw cell is markup rather than the
 * plain share code. `stripHtml` itself lives in lib/text.ts, shared with BoG and
 * IMF, which need the same cleanup on their own messy cells and labels. Re-exported
 * here since it is part of this module's established public surface.
 */
export { stripHtml };

/**
 * Parses a GSE-formatted number: thousands separators stripped, leading `+`
 * tolerated, negatives preserved. Returns `null` for anything blank or
 * unreadable so the caller can decide whether the row is still usable.
 */
export function parseNumber(raw: unknown): number | null {
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== "string") return null;

  const cleaned = raw.replace(/,/g, "").replace(/\s/g, "").replace(/^\+/, "");
  if (cleaned === "" || cleaned === "-" || cleaned === "N/A") return null;

  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parses GSE's day-first dates (`24/07/2026`, occasionally dash-separated) into
 * ISO `YYYY-MM-DD`. Day-first is unambiguous here, so this is a strict pattern
 * match rather than a general date parser — `Date.parse` would read `04/07/2026`
 * as 4 July in some runtimes and 7 April in others.
 */
export function parseDayFirstDate(raw: unknown): string | null {
  if (typeof raw !== "string") return null;

  const match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(raw.trim());
  if (!match) return null;

  const day = Number(match[1]);
  const month = Number(match[2]);
  const year = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;

  // Round-trip through UTC to reject impossible dates like 31/02.
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
    return null;
  }
  return date.toISOString().slice(0, 10);
}

export interface ParsedHistory {
  rows: StockPriceRow[];
  /** Rows dropped for missing or malformed required fields (plan §9). */
  skipped: number;
}

export interface ParseHistoryOptions {
  /**
   * When set, only rows whose share code matches exactly are kept. The upstream
   * search is a substring regex, so a query for `SCB` can also return codes
   * like `SCB PREF`; filtering here makes the result mean what the caller asked.
   */
  symbol?: string;
}

/**
 * Normalizes the DataTables `data` array into typed rows, ascending by date.
 *
 * Malformed rows are counted and skipped rather than failing the whole call —
 * a single bad row in three months of history should not cost the caller the
 * other eighty-nine days.
 */
export function parseHistoryPayload(
  payload: unknown,
  options: ParseHistoryOptions = {},
): ParsedHistory {
  const data = extractDataArray(payload);
  const wanted = options.symbol ? normalizeShareCode(options.symbol) : undefined;

  const rows: StockPriceRow[] = [];
  let skipped = 0;

  for (const raw of data) {
    if (!Array.isArray(raw) || raw.length < MIN_ROW_LENGTH) {
      skipped++;
      continue;
    }

    const symbol = typeof raw[HISTORY_COLUMNS.symbol] === "string"
      ? (raw[HISTORY_COLUMNS.symbol] as string).trim()
      : "";
    if (!symbol) {
      skipped++;
      continue;
    }
    // Both sides normalized, so a request for `ALW` matches the stored `**ALW**`.
    if (wanted && normalizeShareCode(symbol) !== wanted) continue; // filtered, not malformed

    const date = parseDayFirstDate(raw[HISTORY_COLUMNS.date]);
    if (!date) {
      skipped++;
      continue;
    }

    const numbers = {
      high: parseNumber(raw[HISTORY_COLUMNS.high]),
      low: parseNumber(raw[HISTORY_COLUMNS.low]),
      open: parseNumber(raw[HISTORY_COLUMNS.open]),
      close: parseNumber(raw[HISTORY_COLUMNS.close]),
      change: parseNumber(raw[HISTORY_COLUMNS.change]),
      volume: parseNumber(raw[HISTORY_COLUMNS.volume]),
    };

    if (Object.values(numbers).some((value) => value === null)) {
      skipped++;
      continue;
    }

    // Optional, and kept out of the all-or-nothing check above on purpose: a blank
    // turnover cell must not cost the caller the rest of the row.
    const valueTraded = parseNumber(raw[HISTORY_COLUMNS.valueTraded]);

    rows.push({
      date,
      symbol: normalizeShareCode(symbol),
      high: numbers.high as number,
      low: numbers.low as number,
      open: numbers.open as number,
      close: numbers.close as number,
      change: numbers.change as number,
      volume: numbers.volume as number,
      ...(valueTraded !== null ? { valueTraded } : {}),
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, skipped };
}

export interface ParsedCompanies {
  companies: Company[];
  skipped: number;
}

/**
 * Normalizes one listed-companies table into typed companies.
 *
 * Only `symbol` and `name` are required; a row missing either is skipped. The
 * rest of the columns are optional because GSE leaves them blank often enough
 * that requiring them would throw away real companies — nine of the forty rows
 * have no listing date at all.
 *
 * The capital and share-count columns are passed through **verbatim as strings**
 * rather than parsed into numbers, and that is deliberate. What GSE actually
 * stores there is free text: five different currencies (`ZAR 4,899,021,716.98`,
 * `US$867,714,000`, `DALASIS 200,000,000`), mixed units (`2.9 million` next to
 * `118,093,134`), dots as thousands separators (`600.000.000`), prose
 * (`Pre-Listing: GHS40,000 Post-Listing: GHS616,730,000.00`), and outright typos
 * (`GHS400milliion`, `GH(`). Any parser would turn a good fraction of that into
 * numbers wrong by three or six orders of magnitude, which is far worse for a
 * caller than plain text it can see is approximate.
 */
export function parseCompanyPayload(payload: unknown, market: Market): ParsedCompanies {
  const data = extractDataArray(payload);

  const companies: Company[] = [];
  let skipped = 0;

  for (const raw of data) {
    if (!Array.isArray(raw) || raw.length < MIN_COMPANY_ROW_LENGTH) {
      skipped++;
      continue;
    }

    const symbol = stripHtml(raw[COMPANY_COLUMNS.symbol]);
    const name = stripHtml(raw[COMPANY_COLUMNS.name]);
    if (!symbol || !name) {
      skipped++;
      continue;
    }

    const dateListed = parseDayFirstDate(stripHtml(raw[COMPANY_COLUMNS.dateListed]));
    const statedCapital = stripHtml(raw[COMPANY_COLUMNS.statedCapital]);
    const issuedShares = stripHtml(raw[COMPANY_COLUMNS.issuedShares]);
    const authorisedShares = stripHtml(raw[COMPANY_COLUMNS.authorisedShares]);

    companies.push({
      symbol,
      name,
      market,
      ...(dateListed ? { dateListed } : {}),
      ...(statedCapital ? { statedCapital } : {}),
      ...(issuedShares ? { issuedShares } : {}),
      ...(authorisedShares ? { authorisedShares } : {}),
    });
  }

  return { companies, skipped };
}

export interface ParsedMarketIndex {
  rows: MarketIndexRow[];
  skipped: number;
}

/**
 * Normalizes the market-summary table into typed rows, ascending by date.
 *
 * Every numeric column is required here — unlike the company table, a row with a
 * missing index level is not partially useful, it is just noise on a chart.
 */
export function parseMarketIndexPayload(payload: unknown): ParsedMarketIndex {
  const data = extractDataArray(payload);

  const rows: MarketIndexRow[] = [];
  let skipped = 0;

  for (const raw of data) {
    if (!Array.isArray(raw) || raw.length < MIN_MARKET_INDEX_ROW_LENGTH) {
      skipped++;
      continue;
    }

    const date = parseDayFirstDate(stripHtml(raw[MARKET_INDEX_COLUMNS.date]));
    if (!date) {
      skipped++;
      continue;
    }

    const numbers = {
      volume: parseNumber(raw[MARKET_INDEX_COLUMNS.volume]),
      compositeIndex: parseNumber(raw[MARKET_INDEX_COLUMNS.compositeIndex]),
      marketCapGhsMillion: parseNumber(raw[MARKET_INDEX_COLUMNS.marketCapGhsMillion]),
      financialStockIndex: parseNumber(raw[MARKET_INDEX_COLUMNS.financialStockIndex]),
    };

    if (Object.values(numbers).some((value) => value === null)) {
      skipped++;
      continue;
    }

    rows.push({
      date,
      volume: numbers.volume as number,
      compositeIndex: numbers.compositeIndex as number,
      marketCapGhsMillion: numbers.marketCapGhsMillion as number,
      financialStockIndex: numbers.financialStockIndex as number,
    });
  }

  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { rows, skipped };
}

export interface ParsedFixedIncomeIssuers {
  issuers: FixedIncomeIssuer[];
  skipped: number;
}

/**
 * Normalizes the GFIM corporate-issuer table.
 *
 * Only the issuer name is required. The numeric columns *are* parsed into numbers
 * here — in contrast to the company table's `statedCapital`, which stays a string
 * — because these arrive clean and consistently formatted (`10,500.00`, `1,200`)
 * with the unit declared in the column header rather than embedded per-value.
 */
export function parseFixedIncomeIssuersPayload(payload: unknown): ParsedFixedIncomeIssuers {
  const data = extractDataArray(payload);

  const issuers: FixedIncomeIssuer[] = [];
  let skipped = 0;

  for (const raw of data) {
    if (!Array.isArray(raw) || raw.length < MIN_FIXED_INCOME_ROW_LENGTH) {
      skipped++;
      continue;
    }

    const name = stripHtml(raw[FIXED_INCOME_COLUMNS.name]);
    if (!name) {
      skipped++;
      continue;
    }

    const admittedYear = parseNumber(raw[FIXED_INCOME_COLUMNS.admittedYear]);
    const tranches = parseNumber(raw[FIXED_INCOME_COLUMNS.tranches]);
    const amountRaised = parseNumber(raw[FIXED_INCOME_COLUMNS.amountRaisedGhsMillion]);
    const shelf = parseNumber(raw[FIXED_INCOME_COLUMNS.shelfRegistrationGhsMillion]);

    issuers.push({
      name,
      // A year outside this range means the cell holds something other than the
      // year it claims to, so it is better omitted than reported.
      ...(admittedYear !== null && admittedYear >= 1990 && admittedYear <= 2100
        ? { admittedYear }
        : {}),
      ...(tranches !== null ? { tranches } : {}),
      ...(amountRaised !== null ? { amountRaisedGhsMillion: amountRaised } : {}),
      ...(shelf !== null ? { shelfRegistrationGhsMillion: shelf } : {}),
    });
  }

  return { issuers, skipped };
}

/** Distinct share codes present in a payload, sorted. Used to seed the directory. */
export function extractSymbols(payload: unknown): string[] {
  const symbols = new Set<string>();
  for (const raw of extractDataArray(payload)) {
    if (!Array.isArray(raw)) continue;
    const symbol = raw[HISTORY_COLUMNS.symbol];
    // Deliberately NOT normalized: this reports what codes upstream literally
    // stores, annotation markers and all, which is what a caller needs in order to
    // ask for one back. `normalizeShareCode` is for comparison, not for querying.
    if (typeof symbol === "string" && symbol.trim()) symbols.add(symbol.trim());
  }
  return [...symbols].sort();
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
