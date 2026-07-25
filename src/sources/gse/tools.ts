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
  parseFixedIncomeIssuersPayload,
  parseHistoryPayload,
  parseMarketIndexPayload,
} from "./parser.js";
import {
  CompanyMatchSchema,
  CompanySchema,
  DEFAULT_HISTORY_DAYS,
  FixedIncomeIssuerSchema,
  MARKET_LABELS,
  MarketIndexRowSchema,
  MarketSchema,
  MAX_HISTORY_DAYS,
  StockPriceRowSchema,
  type Company,
} from "./types.js";

/** GFIM admissions change a few times a year at most. */
const FIXED_INCOME_CACHE_KEY = "gse:fixed-income-issuers:v1";
const FIXED_INCOME_TTL_SECONDS = 7 * 24 * 60 * 60;

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
        const key = `gse:history:v1:${normalizedSymbol}:${requestedDays}`;
        const ttl = historyTtlSeconds(now());
        log.debug("cache: lookup", { key, ttlSeconds: ttl });

        const result = await readThrough(deps.cache, key, ttl, async () => {
          const payload = await deps.client.fetchStockHistory({
            symbol: normalizedSymbol,
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

