import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readThrough, type Cache } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { ResultMetaSchema, toolError, toolResult, type DataOrigin } from "../../lib/results.js";
import { historyTtlSeconds } from "../../lib/tradingHours.js";
import { GseClient, sanitizeSymbol } from "./client.js";
import {
  COMPANIES_CACHE_KEY,
  COMPANIES_TTL_SECONDS,
  COMPANY_SEED,
  fetchCompanyDirectory,
  searchCompanies,
  type CompanyDirectory,
} from "./companies.js";
import {
  extractSymbols,
  normalizeShareCode,
  parseFixedIncomeIssuersPayload,
  parseHistoryPayload,
  parseMarketIndexPayload,
} from "./parser.js";
import {
  rankStocks,
  summarizeWindow,
  trimToWindow,
  windowBucket,
  windowStartDate,
} from "./ranking.js";
import {
  CompanyMatchSchema,
  CompanySchema,
  DEFAULT_HISTORY_DAYS,
  DEFAULT_MIN_TRADING_DAYS,
  DEFAULT_RANK_DAYS,
  DEFAULT_RANK_LIMIT,
  FixedIncomeIssuerSchema,
  MARKET_LABELS,
  MarketIndexRowSchema,
  MarketSchema,
  MAX_HISTORY_DAYS,
  MAX_RANK_DAYS,
  MAX_RANK_LIMIT,
  MAX_RANK_SYMBOLS,
  RankedStockSchema,
  RankExclusionSchema,
  RankMetricSchema,
  RankOrderSchema,
  StockPriceRowSchema,
  type Company,
  type StockPriceRow,
} from "./types.js";

/** GFIM admissions change a few times a year at most. */
const FIXED_INCOME_CACHE_KEY = "gse:fixed-income-issuers:v1";
const FIXED_INCOME_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * The share codes the price table literally stores, annotation markers and all.
 *
 * Needed because the column search is a whole-value literal comparison — measured,
 * not assumed: `SCB` returns only `SCB` and never `SCBPREF`, and `.*SCB.*` with the
 * regex flag set returns nothing at all. So asking for `ALW` finds nothing, because
 * upstream stores `**ALW**`.
 *
 * One short unfiltered window (~200 rows) yields every stored code, and annotations
 * change about as often as a listing does, so this is cached for a week and shared
 * by every symbol lookup.
 */
const PRICE_SYMBOLS_CACHE_KEY = "gse:price-symbols:v1";
const PRICE_SYMBOLS_TTL_SECONDS = 7 * 24 * 60 * 60;
const PRICE_SYMBOLS_WINDOW_DAYS = 7;

/**
 * MCP tool surface for the GSE source. Every tool is prefixed `gse_` so a future
 * source (Bank of Ghana FX, Ghana Statistical Service, …) can add its own
 * namespace without collisions — see CONTRIBUTING.md.
 */

export interface GseDeps {
  client: GseClient;
  cache: Cache;
  logger?: Logger;
  now?: () => Date;
}

export function registerGseTools(server: McpServer, deps: GseDeps): void {
  const now = deps.now ?? (() => new Date());
  const log = (deps.logger ?? silentLogger).child({ source: "gse" });

  server.registerTool(
    "gse_get_stock_history",
    {
      title: "GSE stock price history",
      description:
        "Daily price history for one company listed on the Ghana Stock Exchange, oldest first. " +
        "Takes a GSE share code (e.g. MTNGH, GCB, TOTAL) — use gse_search_company first if you " +
        "only have a company name. Prices are in Ghana cedis (GHS). Note that `high`/`low` are " +
        "the rolling 52-week high and low, not the day's intraday range, which GSE does not publish.",
      inputSchema: {
        symbol: z
          .string()
          .min(1)
          .describe("GSE share code, e.g. MTNGH. Case-insensitive."),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_HISTORY_DAYS)
          .optional()
          .describe(`Calendar days of history to look back. Default ${DEFAULT_HISTORY_DAYS}.`),
      },
      outputSchema: {
        symbol: z.string(),
        days: z.number(),
        rowCount: z.number(),
        rows: z.array(StockPriceRowSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ symbol, days }) => {
      const requestedDays = days ?? DEFAULT_HISTORY_DAYS;
      const normalizedSymbol = sanitizeSymbol(symbol);

      if (!normalizedSymbol) {
        return toolError(
          `"${symbol}" is not a usable GSE share code. Call gse_search_company to find the right code.`,
        );
      }

      log.info("tool: gse_get_stock_history", { symbol: normalizedSymbol, days: requestedDays });

      try {
        // Upstream compares the share code literally, so it has to be spelled the
        // way upstream spells it. Best-effort: if the lookup fails, fall back to
        // the caller's code, which is right for the 39 securities GSE stores plain.
        const storedSymbol = await resolveStoredSymbol(deps, normalizedSymbol, log);

        // Keyed on the *stored* code, not the caller's. If the resolution above
        // transiently failed and fell back to the plain code, the empty result that
        // produces is cached under a different key than the correct one — so a later
        // successful resolution recovers immediately instead of being shadowed by a
        // poisoned entry for the rest of the TTL. For the 39 securities GSE stores
        // plain the two are identical and nothing changes.
        const key = `gse:history:v1:${storedSymbol}:${requestedDays}`;
        const ttl = historyTtlSeconds(now());
        log.debug("cache: lookup", { key, ttlSeconds: ttl, storedSymbol });

        const result = await readThrough(deps.cache, key, ttl, async () => {
          const payload = await deps.client.fetchStockHistory({
            symbol: storedSymbol,
            days: requestedDays,
          });
          return parseHistoryPayload(payload, { symbol: normalizedSymbol });
        });

        const { rows, skipped } = result.value;
        log.info("tool: gse_get_stock_history done", {
          symbol: normalizedSymbol,
          rows: rows.length,
          skipped: skipped || undefined,
          origin: result.origin,
          ageSeconds: result.ageSeconds,
        });
        const warnings: string[] = [];
        if (result.origin === "stale-cache") {
          warnings.push(
            `gse.com.gh could not be reached (${result.staleReason}); serving a cached copy from ${Math.round(result.ageSeconds / 60)} minutes ago.`,
          );
        }
        if (skipped > 0) {
          warnings.push(`${skipped} row(s) were dropped because required price fields were missing.`);
        }
        if (rows.length === 0) {
          warnings.push(
            `No rows for "${normalizedSymbol}" in the last ${requestedDays} days. The share code may be wrong (try gse_search_company) or the stock may not have traded in that window.`,
          );
        }

        return toolResult({
          symbol: normalizedSymbol,
          days: requestedDays,
          rowCount: rows.length,
          rows,
          meta: {
            origin: result.origin as DataOrigin,
            ageSeconds: result.ageSeconds,
            skippedRows: skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: gse_get_stock_history failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "gse_rank_stocks",
    {
      title: "Rank or compare GSE stocks by performance",
      description:
        "Ranks every security on the Ghana Stock Exchange by performance over a window, or " +
        "compares a named basket. Use this for \"best performing stocks\", \"biggest fallers\", " +
        "\"most actively traded\", or any comparison of two or more companies — it covers the " +
        "whole exchange in ONE request, so never loop gse_get_stock_history over symbols to " +
        "build a comparison yourself. Sort by percentReturn (default), priceChange, volume or " +
        "valueTraded; every one of those is reported for every result regardless of which you " +
        "sort by. Prices are Ghana cedis (GHS). IMPORTANT: GSE publishes a row for every listed " +
        "security every trading day whether or not it traded, carrying the last close forward " +
        "when it did not — so securities that never traded in the window are excluded by " +
        "default, and any result where tradingDays is below quotedDays has a return resting " +
        "partly on a stale price. Check startIsCarriedForward before describing a move as " +
        "having happened during the window.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(2)
          .max(MAX_RANK_DAYS)
          .optional()
          .describe(
            `Calendar days to measure over. Default ${DEFAULT_RANK_DAYS}, which is about 21 ` +
              `trading sessions. Maximum ${MAX_RANK_DAYS}; for anything longer use ` +
              "gse_get_stock_history on the specific symbols you care about.",
          ),
        symbols: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_RANK_SYMBOLS)
          .optional()
          .describe(
            "Restrict to these securities — share codes (\"GCB\") or company names " +
              "(\"ecobank\"), case-insensitive. Omit to rank the entire exchange, which costs " +
              "exactly the same one request. Anything named here is always returned, even if it " +
              "never traded, so a comparison never silently drops one of its subjects.",
          ),
        metric: RankMetricSchema.optional().describe(
          "Sort key. Default percentReturn. Every metric is computed for every result either way.",
        ),
        order: RankOrderSchema.optional().describe(
          "desc (default) = best first. asc = worst first, for \"which stocks fell the most\".",
        ),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_RANK_LIMIT)
          .optional()
          .describe(
            `How many to return when ranking the whole market. Default ${DEFAULT_RANK_LIMIT}. ` +
              "Ignored when `symbols` is given — a basket always comes back whole.",
          ),
        minTradingDays: z
          .number()
          .int()
          .min(0)
          .max(MAX_RANK_DAYS)
          .optional()
          .describe(
            `Minimum sessions a security must have actually traded on to enter a market-wide ` +
              `ranking. Default ${DEFAULT_MIN_TRADING_DAYS}, which drops securities that were ` +
              "quoted but never changed hands — including them would report ties at zero volume " +
              "and 0.00% return. Raise it to filter thin trading; set 0 to see everything. Never " +
              "applied to securities named in `symbols`.",
          ),
      },
      outputSchema: {
        metric: RankMetricSchema,
        order: RankOrderSchema,
        days: z.number(),
        window: z.object({
          startDate: z.string().optional(),
          endDate: z.string().optional(),
          sessions: z.number().int().describe("Trading sessions GSE published in the window."),
        }),
        universe: z.object({
          quoted: z.number().int().describe("Securities quoted in the window, before filtering."),
          ranked: z.number().int(),
          excluded: z.number().int(),
        }),
        rankings: z.array(RankedStockSchema),
        excluded: z
          .array(RankExclusionSchema)
          .describe(
            "Securities left out and why. Worth reporting — \"quoted but nobody traded it\" is a " +
              "different answer from \"no data\".",
          ),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ days, symbols, metric, order, limit, minTradingDays }) => {
      const requestedDays = days ?? DEFAULT_RANK_DAYS;
      const chosenMetric = metric ?? "percentReturn";
      const chosenOrder = order ?? "desc";

      log.info("tool: gse_rank_stocks", {
        days: requestedDays,
        metric: chosenMetric,
        order: chosenOrder,
        symbols: symbols?.length ?? 0,
      });

      try {
        const warnings: string[] = [];

        // The directory serves two jobs: resolving a caller's names to share codes,
        // and labelling the results. It is cached for a week and has a static seed,
        // so a failure here degrades to codes-only rather than failing the ranking.
        const directory = await loadCompanies(deps, {});
        const names = new Map(
          directory.companies.map((company) => [normalizeShareCode(company.symbol), company.name]),
        );

        let resolved: string[] | undefined;
        if (symbols && symbols.length > 0) {
          const unresolved: string[] = [];
          const codes = new Set<string>();

          for (const raw of symbols) {
            const code = resolveShareCode(raw, directory.companies);
            if (code) codes.add(code);
            else unresolved.push(raw);
          }

          if (codes.size === 0) {
            return toolError(
              `None of these matched a listed security: ${unresolved.join(", ")}. Use ` +
                "gse_search_company to find the right share code.",
            );
          }
          if (unresolved.length > 0) {
            warnings.push(
              `These were not recognized and were skipped: ${unresolved.join(", ")}. Use ` +
                "gse_search_company to find the right share code.",
            );
          }
          resolved = [...codes].sort();
        }

        // Cached by bucket, not by the exact `days`, so 30 and 31 do not become two
        // separate scrapes of someone else's site. The wider bucket is trimmed to the
        // requested window below.
        const bucket = windowBucket(requestedDays);
        const key = `gse:market-history:v1:${bucket}`;
        const ttl = historyTtlSeconds(now());
        log.debug("cache: lookup", { key, ttlSeconds: ttl, bucket });

        const result = await readThrough(deps.cache, key, ttl, async () => {
          const payload = await deps.client.fetchMarketHistory({ days: bucket });
          const parsed = parseHistoryPayload(payload);
          // Truncation has to be recorded here, inside the cached value: a warning
          // logged at fetch time would not survive a cache hit, and a truncated
          // window silently shifts startClose for every security at once.
          return { ...parsed, truncation: detectTruncation(payload) };
        });

        const { rows: allRows, skipped, truncation } = result.value;
        const rows: StockPriceRow[] = trimToWindow(
          allRows,
          windowStartDate(requestedDays, now()),
        );

        const summary = summarizeWindow(rows);
        const ranked = rankStocks(summary, {
          metric: chosenMetric,
          order: chosenOrder,
          limit: limit ?? DEFAULT_RANK_LIMIT,
          minTradingDays: minTradingDays ?? DEFAULT_MIN_TRADING_DAYS,
          names,
          ...(resolved ? { symbols: resolved } : {}),
        });

        warnings.push(...rankingWarnings(summary, ranked, truncation, directory.meta.warning));

        log.info("tool: gse_rank_stocks done", {
          quoted: ranked.quoted,
          ranked: ranked.rankings.length,
          excluded: ranked.excluded.length,
          sessions: summary.sessions,
          origin: result.origin,
        });

        if (result.origin === "stale-cache") {
          warnings.unshift(
            `gse.com.gh could not be reached (${result.staleReason}); serving cached prices from ${Math.round(result.ageSeconds / 3600)} hour(s) ago.`,
          );
        }

        return toolResult({
          metric: chosenMetric,
          order: chosenOrder,
          days: requestedDays,
          window: {
            ...(summary.startDate ? { startDate: summary.startDate } : {}),
            ...(summary.endDate ? { endDate: summary.endDate } : {}),
            sessions: summary.sessions,
          },
          universe: {
            quoted: ranked.quoted,
            ranked: ranked.rankings.length,
            excluded: ranked.excluded.length,
          },
          rankings: ranked.rankings,
          excluded: ranked.excluded,
          meta: {
            origin: result.origin as DataOrigin,
            ageSeconds: result.ageSeconds,
            skippedRows: skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: gse_rank_stocks failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "gse_get_market_index",
    {
      title: "GSE market index history",
      description:
        "Daily market-wide statistics for the Ghana Stock Exchange, oldest first: the GSE " +
        "Composite Index (GSE-CI), the Financial Stock Index, total market capitalization and " +
        "exchange-wide traded volume. Use this for questions about the market as a whole — " +
        "'how is the Ghanaian stock market doing' — rather than gse_get_stock_history, which " +
        "covers one company. Market capitalization is in MILLIONS of cedis.",
      inputSchema: {
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_HISTORY_DAYS)
          .optional()
          .describe(`Calendar days of history to look back. Default ${DEFAULT_HISTORY_DAYS}.`),
      },
      outputSchema: {
        days: z.number(),
        rowCount: z.number(),
        rows: z.array(MarketIndexRowSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ days }) => {
      const requestedDays = days ?? DEFAULT_HISTORY_DAYS;
      log.info("tool: gse_get_market_index", { days: requestedDays });

      try {
        const key = `gse:market-index:v1:${requestedDays}`;
        const ttl = historyTtlSeconds(now());
        log.debug("cache: lookup", { key, ttlSeconds: ttl });

        const result = await readThrough(deps.cache, key, ttl, async () =>
          parseMarketIndexPayload(await deps.client.fetchMarketIndex({ days: requestedDays })),
        );

        const { rows, skipped } = result.value;
        log.info("tool: gse_get_market_index done", {
          rows: rows.length,
          skipped: skipped || undefined,
          origin: result.origin,
        });

        const warnings: string[] = [];
        if (result.origin === "stale-cache") {
          warnings.push(
            `gse.com.gh could not be reached (${result.staleReason}); serving a cached copy from ${Math.round(result.ageSeconds / 60)} minutes ago.`,
          );
        }
        if (skipped > 0) {
          warnings.push(`${skipped} row(s) were dropped because required index values were missing.`);
        }
        if (rows.length === 0) {
          warnings.push(`No market data published in the last ${requestedDays} days.`);
        }

        return toolResult({
          days: requestedDays,
          rowCount: rows.length,
          rows,
          meta: {
            origin: result.origin as DataOrigin,
            ageSeconds: result.ageSeconds,
            skippedRows: skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: gse_get_market_index failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "gse_list_fixed_income_issuers",
    {
      title: "GSE fixed-income issuers",
      description:
        "Corporate issuers admitted to the Ghana Fixed Income Market (GFIM) — companies that " +
        "have listed bonds or notes, with the year admitted, number of tranches, amount raised " +
        "and registered shelf size. This is DEBT, not equity: these issuers have no share code " +
        "and no price history, and they do not appear in gse_list_companies. Amounts are in " +
        "MILLIONS of cedis.",
      inputSchema: {
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the cache and re-fetch. Rarely needed."),
      },
      outputSchema: {
        issuerCount: z.number(),
        issuers: z.array(FixedIncomeIssuerSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ refresh }) => {
      log.info("tool: gse_list_fixed_income_issuers", { refresh: refresh ?? false });

      try {
        const result = await readThrough(
          deps.cache,
          FIXED_INCOME_CACHE_KEY,
          FIXED_INCOME_TTL_SECONDS,
          async () => parseFixedIncomeIssuersPayload(await deps.client.fetchFixedIncomeIssuers()),
          { refresh },
        );

        const { issuers, skipped } = result.value;
        log.info("tool: gse_list_fixed_income_issuers done", {
          issuers: issuers.length,
          skipped: skipped || undefined,
          origin: result.origin,
        });

        const warnings: string[] = [];
        if (result.origin === "stale-cache") {
          warnings.push(
            `gse.com.gh could not be reached (${result.staleReason}); serving a cached copy from ${Math.round(result.ageSeconds / 3600)} hour(s) ago.`,
          );
        }
        if (skipped > 0) {
          warnings.push(`${skipped} row(s) were dropped because the issuer name was missing.`);
        }

        return toolResult({
          issuerCount: issuers.length,
          issuers,
          meta: {
            origin: result.origin as DataOrigin,
            ageSeconds: result.ageSeconds,
            skippedRows: skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: gse_list_fixed_income_issuers failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "gse_list_companies",
    {
      title: "List GSE-listed companies",
      description:
        "Every company listed on the Ghana Stock Exchange, with its share code, board and " +
        "listing date. Covers the Main Market, the Ghana Alternative Market, and exchange " +
        "traded funds. Use this to discover what can be queried; use gse_search_company when " +
        "you already have a name in mind.",
      inputSchema: {
        market: MarketSchema.optional().describe(
          "Restrict to one board. Omit for all of them.",
        ),
        refresh: z
          .boolean()
          .optional()
          .describe("Bypass the cache and re-fetch the directory. Rarely needed."),
      },
      outputSchema: {
        companyCount: z.number(),
        companies: z.array(CompanySchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ market, refresh }) => {
      try {
        const loaded = await loadCompanies(deps, { refresh });
        const companies = market
          ? loaded.companies.filter((company) => company.market === market)
          : loaded.companies;

        const emptyNote =
          companies.length === 0 && market
            ? `No companies on the ${MARKET_LABELS[market]} board in the directory.`
            : undefined;

        return toolResult({
          companyCount: companies.length,
          companies,
          meta: mergeWarning(loaded.meta, emptyNote),
        });
      } catch (error) {
        log.error("tool: gse_list_companies failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "gse_search_company",
    {
      title: "Search GSE companies",
      description:
        "Find a GSE share code from a company name or partial name — 'MTN', 'gcb bank', " +
        "'standard chartered' all resolve. Returns the best matches with a confidence score; " +
        "feed the top symbol into gse_get_stock_history.",
      inputSchema: {
        query: z.string().min(1).describe("Company name, partial name, or share code."),
        limit: z.number().int().min(1).max(30).optional().describe("Maximum matches. Default 10."),
      },
      outputSchema: {
        query: z.string(),
        matches: z.array(CompanyMatchSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      try {
        const { companies, meta } = await loadCompanies(deps, {});
        const matches = searchCompanies(companies, query, limit ?? 10);

        const noMatchNote =
          matches.length === 0
            ? `No company matched "${query}". Call gse_list_companies to see every available company.`
            : undefined;

        return toolResult({
          query,
          matches,
          meta: mergeWarning(meta, noMatchNote),
        });
      } catch (error) {
        log.error("tool: gse_search_company failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );
}

/**
 * Shared directory loader: live scrape, then cache, then stale cache, then the
 * built-in seed — always saying which one it used, so a seeded or stale answer
 * is never mistaken for a current one.
 *
 * The seed fallback catches any failure, not a specific error type. If
 * gse.com.gh is unreachable and nothing is cached, a slightly dated list of
 * share codes still lets a caller look up prices; a tool error would leave them
 * with nothing.
 */
/**
 * Maps a plain share code onto the form the price table actually stores.
 *
 * `ALW` → `**ALW**`, `PBC` → `PBC**`, and every other code onto itself. Falls back
 * to the caller's code if the lookup fails: a stale or missing map must not break a
 * lookup for the 39 securities that are stored plain anyway.
 */
async function resolveStoredSymbol(
  deps: GseDeps,
  normalizedSymbol: string,
  log: Logger,
): Promise<string> {
  try {
    const result = await readThrough(
      deps.cache,
      PRICE_SYMBOLS_CACHE_KEY,
      PRICE_SYMBOLS_TTL_SECONDS,
      async () =>
        extractSymbols(await deps.client.fetchMarketHistory({ days: PRICE_SYMBOLS_WINDOW_DAYS })),
    );

    const stored = result.value.find((code) => normalizeShareCode(code) === normalizedSymbol);
    if (stored && stored !== normalizedSymbol) {
      log.debug("gse: share code is stored annotated upstream", {
        requested: normalizedSymbol,
        stored,
      });
    }
    return stored ?? normalizedSymbol;
  } catch (error) {
    log.warn("gse: could not resolve the stored share code; using it as given", {
      symbol: normalizedSymbol,
      reason: describeError(error),
    });
    return normalizedSymbol;
  }
}

/**
 * Resolves one caller-supplied token to a share code.
 *
 * An exact code match wins outright. Failing that the directory's own fuzzy search
 * runs — it already carries the alias table (`mtn` → MTNGH, `stanchart` → SCB), so
 * a caller can write a company name and skip the gse_search_company round trip that
 * this whole tool exists to remove.
 *
 * The 0.6 floor is `searchCompanies`' "the query appears in the company name" tier,
 * which admits "access bank" → ACCESS. Everything below it is guesswork not worth
 * acting on unprompted: a coincidental substring of a share code scores 0.5, and the
 * bigram fallback can never exceed 0.5.
 *
 * An unmatched but plausible-looking code is passed through rather than rejected —
 * the directory can lag a new listing, and the price table is the fresher source. If
 * it really does not exist, it simply ranks nothing and the caller is told.
 */
function resolveShareCode(raw: string, companies: readonly Company[]): string | undefined {
  const normalized = normalizeShareCode(raw);
  if (!normalized) return undefined;

  if (companies.some((company) => normalizeShareCode(company.symbol) === normalized)) {
    return normalized;
  }

  const [best] = searchCompanies(companies, raw, 1);
  if (best && best.score >= 0.6) return normalizeShareCode(best.symbol);

  return /^[A-Z0-9][A-Z0-9 .-]*$/.test(normalized) ? normalized : undefined;
}

interface Truncation {
  truncated: boolean;
  rows?: number;
  recordsFiltered?: number;
}

/**
 * wpDataTables reports how many rows matched before paging. Fewer rows than that
 * means the window is incomplete, which for a ranking is far more damaging than for
 * a single-symbol history: it moves `startClose` for every security at once.
 */
function detectTruncation(payload: unknown): Truncation {
  if (!payload || typeof payload !== "object") return { truncated: false };
  const body = payload as { data?: unknown; recordsFiltered?: unknown };
  const rows = Array.isArray(body.data) ? body.data.length : undefined;
  const recordsFiltered = Number(body.recordsFiltered);

  if (rows === undefined || !Number.isFinite(recordsFiltered)) return { truncated: false };
  return { truncated: rows < recordsFiltered, rows, recordsFiltered };
}

/** Caps a symbol list so one warning cannot swamp the response. */
function nameList(symbols: readonly string[], max = 5): string {
  if (symbols.length <= max) return symbols.join(", ");
  return `${symbols.slice(0, max).join(", ")} and ${symbols.length - max} more`;
}

/**
 * Everything a reader needs to know before quoting one of these figures. The
 * carried-forward warnings deliberately only fire for securities that are actually
 * in `rankings` — warning about rows the caller cannot see is noise.
 */
function rankingWarnings(
  summary: ReturnType<typeof summarizeWindow>,
  ranked: ReturnType<typeof rankStocks>,
  truncation: Truncation,
  directoryWarning: string | undefined,
): string[] {
  const warnings: string[] = [];

  if (truncation.truncated) {
    warnings.push(
      `gse.com.gh returned ${truncation.rows} of ${truncation.recordsFiltered} matching rows, so ` +
        "this window is incomplete and the ranking may be wrong. Ask for fewer days.",
    );
  }

  if (summary.sessions <= 1) {
    warnings.push(
      `This window contains only ${summary.sessions} trading session(s), so every return is ` +
        "0.00%. Ask for more days.",
    );
  }

  const untraded = ranked.excluded.filter((entry) => entry.reason === "untraded");
  if (untraded.length > 0) {
    warnings.push(
      `${untraded.length} securit${untraded.length === 1 ? "y was" : "ies were"} quoted but never ` +
        `traded in this window and ${untraded.length === 1 ? "is" : "are"} not ranked: ` +
        `${nameList(untraded.map((entry) => entry.symbol))}. GSE publishes a row for every listed ` +
        "security whether or not it changed hands.",
    );
  }

  const thin = ranked.excluded.filter((entry) => entry.reason === "too-few-trading-days");
  if (thin.length > 0) {
    warnings.push(
      `${nameList(thin.map((entry) => entry.symbol))} traded on fewer sessions than ` +
        "minTradingDays and were not ranked.",
    );
  }

  const noBaseline = ranked.excluded.filter((entry) => entry.reason === "no-baseline-price");
  if (noBaseline.length > 0) {
    warnings.push(
      `${nameList(noBaseline.map((entry) => entry.symbol))} opened the window at zero, so no ` +
        "percentage return could be computed.",
    );
  }

  const staleStart = ranked.rankings.filter((entry) => entry.startIsCarriedForward);
  if (staleStart.length > 0) {
    warnings.push(
      `${nameList(staleStart.map((entry) => entry.symbol))} had not traded at the start of the ` +
        "window, so the move shown may have happened before it rather than during it.",
    );
  }

  const staleEnd = ranked.rankings.filter(
    (entry) => entry.endIsCarriedForward && !entry.startIsCarriedForward,
  );
  if (staleEnd.length > 0) {
    warnings.push(
      `${nameList(staleEnd.map((entry) => entry.symbol))} did not trade on the last session, so ` +
        "the closing price is carried forward — see lastTradedDate.",
    );
  }

  if (directoryWarning) warnings.push(directoryWarning);

  return warnings;
}

async function loadCompanies(
  deps: GseDeps,
  options: { refresh?: boolean },
): Promise<{ companies: Company[]; meta: z.infer<typeof ResultMetaSchema> }> {
  const log = (deps.logger ?? silentLogger).child({ source: "gse" });

  try {
    log.debug("cache: lookup", {
      key: COMPANIES_CACHE_KEY,
      ttlSeconds: COMPANIES_TTL_SECONDS,
      refresh: options.refresh ?? false,
    });

    const result = await readThrough<CompanyDirectory>(
      deps.cache,
      COMPANIES_CACHE_KEY,
      COMPANIES_TTL_SECONDS,
      () => fetchCompanyDirectory(deps.client, log),
      { refresh: options.refresh },
    );

    const { companies, skipped, failedMarkets } = result.value;
    log.info("gse: company directory ready", {
      companies: companies.length,
      skipped: skipped || undefined,
      origin: result.origin,
      ageSeconds: result.ageSeconds,
      failedMarkets: failedMarkets.length ? failedMarkets.join(",") : undefined,
    });

    const warnings: string[] = [];
    if (result.origin === "stale-cache") {
      warnings.push(
        `gse.com.gh could not be reached (${result.staleReason}); serving a cached directory from ${Math.round(result.ageSeconds / 3600)} hour(s) ago.`,
      );
    }
    if (failedMarkets.length > 0) {
      warnings.push(
        `The ${failedMarkets.map((market) => MARKET_LABELS[market as keyof typeof MARKET_LABELS] ?? market).join(" and ")} listing(s) could not be read, so this directory is incomplete.`,
      );
    }

    return {
      companies,
      meta: {
        origin: result.origin as DataOrigin,
        ageSeconds: result.ageSeconds,
        ...(skipped > 0 ? { skippedRows: skipped } : {}),
        ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
      },
    };
  } catch (error) {
    log.warn("gse: falling back to the built-in company seed", {
      reason: describeError(error),
    });
    return {
      companies: [...COMPANY_SEED],
      meta: {
        origin: "static-seed",
        ageSeconds: 0,
        warning:
          `The live company directory could not be fetched (${describeError(error)}) — this is the ` +
          "built-in fallback list, covering the Main Market as of 2026-07-25. It may miss recent " +
          "listings, and omits the Ghana Alternative Market and ETFs entirely.",
      },
    };
  }
}

function mergeWarning(
  meta: z.infer<typeof ResultMetaSchema>,
  extra?: string,
): z.infer<typeof ResultMetaSchema> {
  if (!extra) return meta;
  return { ...meta, warning: meta.warning ? `${meta.warning} ${extra}` : extra };
}

