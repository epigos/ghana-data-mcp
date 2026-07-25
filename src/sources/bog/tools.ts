import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readThrough, type Cache, type ReadThroughResult } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { ResultMetaSchema, toolError, toolResult, type DataOrigin } from "../../lib/results.js";
import { BogClient, INTERBANK_SERIES, type InterbankSeries } from "./client.js";
import {
  parseBillRatePayload,
  parseInterbankFxPayload,
  parseInterestRatePayload,
  resolveCurrencyPair,
  type ParsedFxRates,
} from "./parser.js";
import {
  BillRateSchema,
  CEDI_REDENOMINATION_DATE,
  DEFAULT_DAYS,
  InterbankFxRateSchema,
  InterestRatePointSchema,
  MAX_DAYS,
} from "./types.js";

/** FX is published once a day, so an hour of freshness is plenty. */
const FX_CACHE_KEY = "bog:interbank-fx:v1";
const FX_TTL_SECONDS = 60 * 60;

/** Bill rates are set at weekly tenders, so a day of freshness is generous. */
const BILL_RATE_TTL_SECONDS = 12 * 60 * 60;

/** A past window never changes, so it can be held far longer than the snapshot. */
const FX_HISTORY_TTL_SECONDS = 12 * 60 * 60;

/**
 * Upper bound on rows fetched for one historical FX window.
 *
 * The unfiltered table is 144,457 rows (~4,700 a year across 19 currencies) and a
 * Worker on the free tier gets 10ms of CPU, so an unbounded parse is a real risk
 * rather than a theoretical one. Truncation is reported in `meta.warning` instead of
 * being hidden.
 */
const FX_HISTORY_MAX_ROWS = 20_000;

/**
 * Interest-rate series are cached whole, not per window.
 *
 * These tables reject a date-range search, so the fetch always returns the entire
 * series and the window is applied in memory — which means one entry answers every
 * `days` a caller might ask for. The largest series is 1712 rows.
 */
const INTEREST_RATE_TTL_SECONDS = 6 * 60 * 60;

/**
 * MCP tool surface for Bank of Ghana data, namespaced `bog_`.
 *
 * Four tools over four datasets: interbank FX rates (latest or historical), the two
 * bill-rate series, and the interbank money-market rates.
 */

export interface BogDeps {
  client: BogClient;
  cache: Cache;
  logger?: Logger;
}

export function registerBogTools(server: McpServer, deps: BogDeps): void {
  const log = (deps.logger ?? silentLogger).child({ source: "bog" });

  server.registerTool(
    "bog_get_interbank_fx_rates",
    {
      title: "Ghana interbank FX rates",
      description:
        "Bank of Ghana interbank reference rates for the Ghana cedi against 19 currencies, " +
        "with bid, offer and mid for each. These are the official interbank reference rates, " +
        "not retail or forex-bureau rates, which are usually worse and differ by provider. " +
        "Rates are cedis per unit of the foreign currency. " +
        "Without `days` this returns the latest published day. With `days` it returns the " +
        "historical series, which BoG publishes back to January 1996 — pass a `currency` too " +
        "for long windows, since the full table is very large. Rates before 1 July 2007 are in " +
        "OLD cedis and are about 10,000 times larger, because Ghana redenominated and BoG does " +
        "not adjust the series; never compare or chart across that date without saying so.",
      inputSchema: {
        currency: z
          .string()
          .optional()
          .describe(
            "Restrict to one currency, by code (USD, GBP, EUR) or published name (\"US Dollar\"). " +
              "Omit for all 19. Strongly recommended together with `days`.",
          ),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_DAYS)
          .optional()
          .describe(
            "Calendar days of history to return, ending today. Omit for just the latest " +
              "published day. Data goes back to January 1996.",
          ),
      },
      outputSchema: {
        date: z
          .string()
          .describe("Most recent publication date in the result, ISO 8601. Each row carries its own."),
        rateCount: z.number(),
        rates: z.array(InterbankFxRateSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ currency, days }) => {
      log.info("tool: bog_get_interbank_fx_rates", {
        currency: currency ?? "all",
        days: days ?? "latest",
      });

      try {
        // Two different tables. Without a window, table 31 gives the latest
        // publication directly, which is robust across weekends and holidays in a
        // way "the last day or two of history" would not be. With a window, table 40
        // holds the whole series.
        const result = days
          ? await loadFxHistory(deps, { days, currency })
          : await readThrough(deps.cache, FX_CACHE_KEY, FX_TTL_SECONDS, async () =>
              parseInterbankFxPayload(await deps.client.fetchInterbankFxRates()),
            );

        const { rows, skipped } = result.value;
        const wanted = currency?.trim().toUpperCase();
        const rates = wanted
          ? rows.filter((row) => row.code === wanted || row.currency.toUpperCase() === wanted)
          : rows;

        log.info("tool: bog_get_interbank_fx_rates done", {
          rates: rates.length,
          skipped: skipped || undefined,
          origin: result.origin,
        });

        const warnings: string[] = [];
        if (result.origin === "stale-cache") {
          warnings.push(
            `bog.gov.gh could not be reached (${result.staleReason}); serving a cached copy from ${Math.round(result.ageSeconds / 60)} minutes ago.`,
          );
        }
        if (skipped > 0) {
          warnings.push(`${skipped} row(s) were dropped because required rate fields were missing.`);
        }
        if (rates.length >= FX_HISTORY_MAX_ROWS) {
          warnings.push(
            `Results were capped at ${FX_HISTORY_MAX_ROWS} rows, so the oldest part of the window is missing. Narrow the window or pass a currency.`,
          );
        }
        if (currency && rates.length === 0) {
          warnings.push(
            `No interbank rate published for "${currency}". Call this tool without a currency to see all 19.`,
          );
        }
        // Detected rather than left to the reader: a window reaching past the
        // redenomination mixes two units in one series, and the jump looks like a
        // currency collapse instead of an arithmetic change.
        if (rates.some((rate) => rate.date < CEDI_REDENOMINATION_DATE)) {
          warnings.push(
            `This window crosses Ghana's redenomination on ${CEDI_REDENOMINATION_DATE}: rates before that date are in OLD cedis (10,000 old = 1 new), so they are ~10,000x larger and are NOT comparable with later rates. Do not chart or compute a change across that boundary without converting.`,
          );
        }

        return toolResult({
          date: rates.at(-1)?.date ?? rows.at(-1)?.date ?? "",
          rateCount: rates.length,
          rates,
          meta: {
            origin: result.origin as DataOrigin,
            ageSeconds: result.ageSeconds,
            skippedRows: skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: bog_get_interbank_fx_rates failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "bog_get_interbank_interest_rates",
    {
      title: "Ghana interbank interest rates",
      description:
        "Bank of Ghana interbank money-market interest rates, oldest first. Four separate " +
        "series, chosen with `series`: `daily` is the daily interbank weighted average; " +
        "`weekly` is its weekly average, dated by week ending; `reverse-repo` and `depo` are " +
        "the Bank of Ghana's standing facility rates, which sit either side of the Monetary " +
        "Policy Committee's policy rate. This is NOT the MPC policy rate itself, which BoG " +
        "publishes separately and this server does not cover.",
      inputSchema: {
        series: z
          .enum(["daily", "weekly", "reverse-repo", "depo"])
          .optional()
          .describe("Which series to return. Default daily."),
        days: z
          .number()
          .int()
          .min(1)
          .max(MAX_DAYS)
          .optional()
          .describe(
            `Calendar days of history to return. Default ${DEFAULT_DAYS}. The daily and ` +
              "weekly series start in 2019; the reverse-repo and depo series reach back to 2002.",
          ),
      },
      outputSchema: {
        series: z.string(),
        seriesLabel: z.string().describe("The label BoG uses for this series on its own page."),
        days: z.number(),
        rowCount: z.number(),
        rows: z.array(InterestRatePointSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ series, days }) => {
      const chosen: InterbankSeries = series ?? "daily";
      const requestedDays = days ?? DEFAULT_DAYS;
      log.info("tool: bog_get_interbank_interest_rates", { series: chosen, days: requestedDays });

      try {
        // Cached whole, then windowed in memory: these tables reject a date-range
        // search, so the fetch returns everything regardless of what was asked.
        const key = `bog:interbank-interest:v1:${chosen}`;
        const result = await readThrough(deps.cache, key, INTEREST_RATE_TTL_SECONDS, async () =>
          parseInterestRatePayload(await deps.client.fetchInterbankInterestRates(chosen)),
        );

        const from = new Date(Date.now() - requestedDays * 24 * 60 * 60 * 1000)
          .toISOString()
          .slice(0, 10);
        const { rows: allRows, skipped } = result.value;
        const rows = allRows.filter((row) => row.date >= from);

        log.info("tool: bog_get_interbank_interest_rates done", {
          series: chosen,
          rows: rows.length,
          ofTotal: allRows.length,
          skipped: skipped || undefined,
          origin: result.origin,
        });

        const warnings: string[] = [];
        if (result.origin === "stale-cache") {
          warnings.push(
            `bog.gov.gh could not be reached (${result.staleReason}); serving a cached copy from ${Math.round(result.ageSeconds / 3600)} hour(s) ago.`,
          );
        }
        if (rows.length === 0 && allRows.length > 0) {
          warnings.push(
            `No ${INTERBANK_SERIES[chosen].label} published in the last ${requestedDays} days. The series runs ${allRows[0]?.date} to ${allRows.at(-1)?.date}; try a longer window.`,
          );
        }

        return toolResult({
          series: chosen,
          seriesLabel: INTERBANK_SERIES[chosen].label,
          days: requestedDays,
          rowCount: rows.length,
          rows,
          meta: {
            origin: result.origin as DataOrigin,
            ageSeconds: result.ageSeconds,
            // Blank-dated rows are normal in the MPC-derived series, so this is
            // reported without being dressed up as a problem.
            skippedRows: skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: bog_get_interbank_interest_rates failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  const billRateTools = [
    {
      name: "bog_get_treasury_bill_rates",
      title: "Ghana Treasury bill rates",
      issuer: "Government of Ghana",
      cacheKey: "bog:treasury-bill-rates:v1",
      description:
        "Discount and interest rates for Government of Ghana Treasury securities, oldest first, " +
        "as published by the Bank of Ghana. Covers the 91-, 182- and 364-day bills and also the " +
        "longer FXR notes and bonds that appear in the same table. Use this for Ghanaian T-bill " +
        "yields or a risk-free rate. For securities the central bank issues itself, use " +
        "bog_get_central_bank_bill_rates.",
      fetch: (client: BogClient, days: number) => client.fetchTreasuryBillRates(days),
    },
    {
      name: "bog_get_central_bank_bill_rates",
      title: "Bank of Ghana bill rates",
      issuer: "Bank of Ghana",
      cacheKey: "bog:central-bank-bill-rates:v1",
      description:
        "Discount and interest rates for securities issued by the Bank of Ghana itself — BOG " +
        "bills, typically short tenors such as 14-day — oldest first. These are NOT Government " +
        "of Ghana Treasury bills; for those use bog_get_treasury_bill_rates.",
      fetch: (client: BogClient, days: number) => client.fetchCentralBankBillRates(days),
    },
  ] as const;

  for (const tool of billRateTools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: {
          days: z
            .number()
            .int()
            .min(1)
            .max(MAX_DAYS)
            .optional()
            .describe(`Calendar days of history to look back. Default ${DEFAULT_DAYS}.`),
          securityType: z
            .string()
            .optional()
            .describe(
              "Restrict to one security. Matched leniently, so \"91\", \"91 DAY\" and " +
                "\"91 DAY BILL\" all work. Omit for every security in the window.",
            ),
        },
        outputSchema: {
          days: z.number(),
          rowCount: z.number(),
          rows: z.array(BillRateSchema),
          meta: ResultMetaSchema,
        },
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async ({ days, securityType }) => {
        const requestedDays = days ?? DEFAULT_DAYS;
        log.info(`tool: ${tool.name}`, { days: requestedDays, securityType: securityType ?? "all" });

        try {
          // Cached unfiltered for the window, then filtered in memory, so asking
          // for one tenor after another does not re-scrape.
          const key = `${tool.cacheKey}:${requestedDays}`;
          const result = await readThrough(deps.cache, key, BILL_RATE_TTL_SECONDS, async () =>
            parseBillRatePayload(await tool.fetch(deps.client, requestedDays)),
          );

          const { rows: allRows, skipped } = result.value;
          const wanted = securityType?.trim().toUpperCase();
          const rows = wanted
            ? allRows.filter((row) => row.securityType.toUpperCase().startsWith(wanted))
            : allRows;

          log.info(`tool: ${tool.name} done`, {
            rows: rows.length,
            skipped: skipped || undefined,
            origin: result.origin,
          });

          const warnings: string[] = [];
          if (result.origin === "stale-cache") {
            warnings.push(
              `bog.gov.gh could not be reached (${result.staleReason}); serving a cached copy from ${Math.round(result.ageSeconds / 3600)} hour(s) ago.`,
            );
          }
          if (skipped > 0) {
            warnings.push(`${skipped} row(s) were dropped because required rate fields were missing.`);
          }
          if (rows.length === 0) {
            const available = [...new Set(allRows.map((row) => row.securityType))].sort();
            warnings.push(
              wanted && available.length > 0
                ? `No "${securityType}" security in the last ${requestedDays} days. Available: ${available.join(", ")}.`
                : `${tool.issuer} published no rates in the last ${requestedDays} days. Try a longer window.`,
            );
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
          log.error(`tool: ${tool.name} failed`, { reason: describeError(error) });
          return toolError(describeError(error));
        }
      },
    );
  }
}

/**
 * Historical FX window, filtered upstream by pair where possible.
 *
 * The upstream pair filter matches whole values exactly, so a code resolves to
 * `USDGHS` and is pushed upstream; a currency *name* cannot be resolved without the
 * published list, so those windows come back unfiltered and are narrowed in memory.
 * The cache key records which happened, so the two never collide.
 */
async function loadFxHistory(
  deps: BogDeps,
  options: { days: number; currency?: string },
): Promise<ReadThroughResult<ParsedFxRates>> {
  const pair = options.currency ? resolveCurrencyPair(options.currency) : null;
  const key = `bog:interbank-fx-history:v1:${options.days}:${pair ?? "all"}`;

  return readThrough<ParsedFxRates>(deps.cache, key, FX_HISTORY_TTL_SECONDS, async () =>
    parseInterbankFxPayload(
      await deps.client.fetchHistoricalInterbankFxRates({
        days: options.days,
        ...(pair ? { pair } : {}),
        maxRows: FX_HISTORY_MAX_ROWS,
      }),
    ),
  );
}

/** Every tool this source registers. Exported so tests and docs stay in step. */
export const BOG_TOOL_NAMES: readonly string[] = [
  "bog_get_interbank_fx_rates",
  "bog_get_treasury_bill_rates",
  "bog_get_central_bank_bill_rates",
  "bog_get_interbank_interest_rates",
];
