import { z } from "zod";

// The shared result envelope (ResultMetaSchema, DataOrigin) lives in lib/results.ts,
// since every source reports it.

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
  volume: z.number().describe("Total shares traded that day. Zero means the security was quoted but did not trade."),
  valueTraded: z
    .number()
    .optional()
    .describe(
      "Turnover that day in GHS (shares traded x price). Omitted when GSE published no " +
        "figure — never read an absent value as zero.",
    ),
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

/**
 * One day of market-wide statistics (table 47).
 *
 * Unlike the company table's capital columns, these values are clean and
 * consistently formatted, so they are parsed into numbers. The unit is baked
 * into the field name where there is one, because "market cap 292,058" is
 * meaningless — and off by a factor of a million — without it.
 */
export const MarketIndexRowSchema = z.object({
  date: z.string().describe("Trading date, ISO 8601 (YYYY-MM-DD)."),
  volume: z.number().describe("Total shares traded across the whole exchange that day."),
  compositeIndex: z.number().describe("GSE Composite Index (GSE-CI) closing level."),
  marketCapGhsMillion: z
    .number()
    .describe("Total market capitalization in MILLIONS of Ghana cedis. 292058.49 means GHS 292 billion."),
  financialStockIndex: z.number().describe("GSE Financial Stock Index (GSE-FSI) closing level."),
});
export type MarketIndexRow = z.infer<typeof MarketIndexRowSchema>;

/**
 * A corporate issuer admitted to the Ghana Fixed Income Market (table 37).
 *
 * This is debt, not equity: these issuers have listed bonds or notes and have no
 * share code, so they never appear in the price table or the company directory.
 */
export const FixedIncomeIssuerSchema = z.object({
  name: z.string().describe("Issuer name."),
  admittedYear: z
    .number()
    .optional()
    .describe("Year the issuer was admitted to GFIM. GSE publishes a year only, not a full date."),
  tranches: z.number().optional().describe("Number of tranches issued to date."),
  amountRaisedGhsMillion: z
    .number()
    .optional()
    .describe("Total raised, in MILLIONS of Ghana cedis."),
  shelfRegistrationGhsMillion: z
    .number()
    .optional()
    .describe("Registered shelf programme size, in MILLIONS of Ghana cedis."),
});
export type FixedIncomeIssuer = z.infer<typeof FixedIncomeIssuerSchema>;

export const CompanyMatchSchema = CompanySchema.extend({
  score: z.number().describe("Match confidence from 0 to 1; 1 is an exact symbol match."),
});
export type CompanyMatch = z.infer<typeof CompanyMatchSchema>;

/**
 * Twenty years, which clears the start of the data: GSE's price table goes back to
 * at least 25 Jun 2007 (4065 rows for GCB alone). A five-year ceiling silently put
 * most of that out of reach.
 */
export const MAX_HISTORY_DAYS = 7300;
export const DEFAULT_HISTORY_DAYS = 90;

/**
 * What `gse_rank_stocks` sorts by. Every metric is computed for every returned
 * security regardless — they all come from the same rows — so this only picks the
 * sort key, never what is measured.
 */
export const RANK_METRICS = ["percentReturn", "priceChange", "volume", "valueTraded"] as const;
export const RankMetricSchema = z.enum(RANK_METRICS);
export type RankMetric = z.infer<typeof RankMetricSchema>;

export const RankOrderSchema = z.enum(["desc", "asc"]);
export type RankOrder = z.infer<typeof RankOrderSchema>;

export const DEFAULT_RANK_DAYS = 30;
/**
 * Deliberately far below `MAX_HISTORY_DAYS`. A ranking query is unfiltered by share
 * code, so a 20-year window would pull most of a 184,000-row table on every cache
 * miss. 400 days is the largest window measured to come back untruncated (10,671
 * rows) and covers any plausible "best performing" question; longer windows belong
 * to gse_get_stock_history on a named symbol.
 */
export const MAX_RANK_DAYS = 400;
export const DEFAULT_RANK_LIMIT = 10;
export const MAX_RANK_LIMIT = 50;
/** Roughly the whole listed universe, so a basket can name every security if it wants. */
export const MAX_RANK_SYMBOLS = 40;
export const DEFAULT_MIN_TRADING_DAYS = 1;

/** Why a security was quoted in the window but left out of the ranking. */
export const RankExclusionSchema = z.object({
  symbol: z.string(),
  reason: z
    .enum(["untraded", "too-few-trading-days", "no-baseline-price"])
    .describe(
      "untraded = quoted every session but never changed hands; too-few-trading-days = it " +
        "traded, but on fewer sessions than minTradingDays; no-baseline-price = its first " +
        "close was zero, so a percentage return is undefined.",
    ),
});
export type RankExclusion = z.infer<typeof RankExclusionSchema>;

/**
 * One security's performance over the requested window.
 *
 * The liquidity fields are not decoration. GSE publishes a row for every listed
 * security every trading day whether or not it traded, carrying the last close
 * forward when it did not. So a return can be perfectly real arithmetic over two
 * prices that are months apart. `tradingDays`, `lastTradedDate` and the two
 * carried-forward flags are what let a reader tell those apart.
 */
export const RankedStockSchema = z.object({
  rank: z.number().int().describe("1 is best under the chosen metric and order. Ties break by share code."),
  symbol: z.string().describe("GSE share code, with GSE's own annotation markers stripped."),
  name: z.string().optional().describe("Company name, when the directory could match the code."),

  startDate: z
    .string()
    .describe(
      "First session in the window this security was quoted on — later than the window start " +
        "if it listed recently.",
    ),
  startClose: z.number().describe("Closing price on startDate, GHS."),
  endDate: z.string().describe("Last session in the window it was quoted on."),
  endClose: z.number().describe("Closing price on endDate, GHS."),

  percentReturn: z
    .number()
    .nullable()
    .describe("(endClose - startClose) / startClose x 100. Null when startClose was zero."),
  priceChange: z
    .number()
    .nullable()
    .describe("endClose - startClose, GHS. Not the sum of the daily `change` column."),
  totalVolume: z.number().describe("Shares traded across the window."),
  totalValueTraded: z
    .number()
    .optional()
    .describe(
      "Turnover across the window in GHS. Omitted rather than partially summed when GSE left " +
        "the figure blank on any session that traded.",
    ),

  quotedDays: z.number().int().describe("Sessions GSE published a row for this security."),
  tradingDays: z
    .number()
    .int()
    .describe(
      "Sessions it actually traded on (volume > 0). Lower than quotedDays is normal and means " +
        "the price was carried forward on the difference.",
    ),
  lastTradedDate: z
    .string()
    .optional()
    .describe("Most recent session with volume > 0. Absent means it never traded in the window."),
  startIsCarriedForward: z
    .boolean()
    .describe(
      "True when it did not trade on startDate, so startClose predates the window and the " +
        "return may cover a move that happened before it.",
    ),
  endIsCarriedForward: z
    .boolean()
    .describe("True when it did not trade on endDate, so endClose is stale — see lastTradedDate."),
});
export type RankedStock = z.infer<typeof RankedStockSchema>;
