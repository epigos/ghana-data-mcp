import { z } from "zod";

/**
 * One row of the GSE daily-price table, normalized.
 *
 * A caveat worth knowing, because the column names on gse.com.gh are easy to
 * misread: `high` and `low` are the table's **Year High** and **Year Low**
 * columns — the rolling 52-week extremes — not that day's intraday range. GSE
 * does not publish an intraday high/low in this table. The field names are kept
 * short for callers, and the descriptions below carry the real meaning through
 * to the MCP schema so a model reading the tool never gets this wrong.
 */
export const StockPriceRowSchema = z.object({
  date: z.string().describe("Trading date, ISO 8601 (YYYY-MM-DD)."),
  symbol: z.string().describe("GSE share code, e.g. MTNGH."),
  high: z.number().describe("Year high (52-week), in GHS — NOT the day's intraday high."),
  low: z.number().describe("Year low (52-week), in GHS — NOT the day's intraday low."),
  open: z.number().describe("Opening price for the day, in GHS."),
  close: z.number().describe("Closing price for the day (VWAP), in GHS."),
  change: z.number().describe("Price change versus the previous close, in GHS. May be negative."),
  volume: z.number().describe("Total shares traded that day."),
});
export type StockPriceRow = z.infer<typeof StockPriceRowSchema>;

/** Which GSE board a security is listed on. */
export const MarketSchema = z.enum(["main", "gax", "etf"]);
export type Market = z.infer<typeof MarketSchema>;

export const MARKET_LABELS: Record<Market, string> = {
  main: "Main Market",
  gax: "Ghana Alternative Market",
  etf: "Exchange Traded Fund",
};

/**
 * A listed company (or ETF).
 *
 * The three free-text fields at the end are exactly what gse.com.gh publishes,
 * passed through unchanged. They are *not* numbers and must not be treated as
 * such — see the note in parser.ts on why parsing them would do more harm than
 * leaving them alone.
 */
export const CompanySchema = z.object({
  symbol: z.string().describe("GSE share code, e.g. MTNGH."),
  name: z.string().describe("Listed company name."),
  market: MarketSchema.describe(
    "main = Main Market; gax = Ghana Alternative Market (smaller companies); etf = Exchange Traded Fund.",
  ),
  dateListed: z
    .string()
    .optional()
    .describe("Listing date, ISO 8601 (YYYY-MM-DD). Absent when GSE does not publish one."),
  statedCapital: z
    .string()
    .optional()
    .describe(
      "Stated capital, verbatim from GSE. Free text of inconsistent quality — mixed currencies, " +
        "mixed units, and occasional typos. Quote it, do not calculate with it.",
    ),
  issuedShares: z
    .string()
    .optional()
    .describe("Issued shares, verbatim from GSE. Free text — same caveat as statedCapital."),
  authorisedShares: z
    .string()
    .optional()
    .describe("Authorised shares, verbatim from GSE. Free text — same caveat as statedCapital."),
});
export type Company = z.infer<typeof CompanySchema>;

export const CompanyMatchSchema = CompanySchema.extend({
  score: z.number().describe("Match confidence from 0 to 1; 1 is an exact symbol match."),
});
export type CompanyMatch = z.infer<typeof CompanyMatchSchema>;

/** Where a result came from, so a stale or seeded answer is never passed off as live. */
export const DataOriginSchema = z.enum(["live", "cache", "stale-cache", "static-seed"]);
export type DataOrigin = z.infer<typeof DataOriginSchema>;

export const ResultMetaSchema = z.object({
  origin: DataOriginSchema.describe(
    "live = freshly scraped; cache = fresh cached copy; stale-cache = upstream failed, expired copy served; static-seed = built-in fallback list.",
  ),
  ageSeconds: z.number().describe("How long ago the data was fetched from gse.com.gh."),
  warning: z
    .string()
    .optional()
    .describe("Present when the data may be behind or incomplete. Pass this on to the user."),
  skippedRows: z
    .number()
    .optional()
    .describe("Rows dropped because required fields were missing or malformed."),
});
export type ResultMeta = z.infer<typeof ResultMetaSchema>;

export const MAX_HISTORY_DAYS = 1825; // five years
export const DEFAULT_HISTORY_DAYS = 90;
