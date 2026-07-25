import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readThrough, type Cache } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { ResultMetaSchema, toolError, toolResult, type DataOrigin } from "../../lib/results.js";
import { BogClient } from "./client.js";
import { parseInterbankFxPayload } from "./parser.js";
import { DEFAULT_DAYS, InterbankFxRateSchema, MAX_DAYS } from "./types.js";

/** FX is published once a day, so an hour of freshness is plenty. */
const FX_CACHE_KEY = "bog:interbank-fx:v1";
const FX_TTL_SECONDS = 60 * 60;

/**
 * MCP tool surface for Bank of Ghana data, namespaced `bog_`.
 *
 * Interbank FX rates are implemented. The remaining six are registered stubs:
 * final input schemas and descriptions, but calling one returns an error. That
 * fixes the contract — names, inputs, which dataset belongs in which tool — before
 * the parsing work, and keeps the registration and docs scaffolding tested.
 *
 * Two rules the stub errors follow, because this is financial data:
 *
 *  1. They never return an empty result set. An empty `rows: []` reads as "there
 *     is no data", which is a different and false claim.
 *  2. They tell the model not to answer from memory, and give the public URL
 *     instead. A plausible-looking T-bill rate recalled from training data is
 *     worse than no answer at all.
 *
 * Stub descriptions are prefixed NOT YET AVAILABLE so a model reading the tool
 * list can avoid calling them in the first place.
 */

export interface BogDeps {
  client: BogClient;
  cache: Cache;
  logger?: Logger;
}

const NOT_AVAILABLE = "NOT YET AVAILABLE (stub — returns an error).";

const daysInput = (what: string) => ({
  days: z
    .number()
    .int()
    .min(1)
    .max(MAX_DAYS)
    .optional()
    .describe(`Calendar days of ${what} to look back. Default ${DEFAULT_DAYS}.`),
});

const limitInput = (what: string) => ({
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(`Maximum number of ${what}, most recent first. Default 12.`),
});

interface StubDefinition {
  name: string;
  title: string;
  /** What the tool will return once implemented. */
  description: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  /** Called to produce the NotImplementedError, so the message names the page. */
  probe: (client: BogClient) => Promise<unknown>;
}

const STUBS: readonly StubDefinition[] = [
  {
    name: "bog_get_treasury_bill_rates",
    title: "Ghana Treasury bill rates",
    description:
      "Discount and interest rates for Government of Ghana Treasury securities (91-day, " +
      "182-day and 364-day bills), as published by the Bank of Ghana. Use this for questions " +
      "about Ghanaian T-bill yields or the risk-free rate.",
    inputSchema: daysInput("rate history"),
    probe: (client) => client.fetchTreasuryBillRates(),
  },
  {
    name: "bog_get_central_bank_bill_rates",
    title: "Bank of Ghana bill rates",
    description:
      "Discount and interest rates for securities issued by the Bank of Ghana itself (BOG " +
      "bills), as distinct from Government of Ghana Treasury bills — for those use " +
      "bog_get_treasury_bill_rates.",
    inputSchema: daysInput("rate history"),
    probe: (client) => client.fetchCentralBankBillRates(),
  },
  {
    name: "bog_get_interbank_interest_rates",
    title: "Ghana interbank interest rates",
    description:
      "Bank of Ghana interbank market interest rates: the interbank weighted average rate, " +
      "reverse repo rate and deposit rates, daily and weekly. Not the Monetary Policy " +
      "Committee policy rate, which is published separately.",
    inputSchema: {
      ...daysInput("rate history"),
      frequency: z
        .enum(["daily", "weekly"])
        .optional()
        .describe("BoG publishes both. Default daily."),
    },
    probe: (client) => client.fetchInterbankInterestRates(),
  },
  {
    name: "bog_get_treasury_auction_results",
    title: "GOG T-bill auction results",
    description:
      "Results of the weekly Government of Ghana Treasury bill auctions: amounts tendered and " +
      "accepted, and the rates cleared, per tenor. Use this for auction outcomes and demand; " +
      "use bog_get_treasury_bill_rates for the resulting rate series.",
    inputSchema: limitInput("auctions"),
    probe: (client) => client.fetchTreasuryAuctionResults(),
  },
  {
    name: "bog_get_central_bank_auction_results",
    title: "BOG bill auction results",
    description:
      "Results of the weekly Bank of Ghana bill auctions — the central bank's own issuance, " +
      "as distinct from the Government of Ghana auctions covered by " +
      "bog_get_treasury_auction_results.",
    inputSchema: limitInput("auctions"),
    probe: (client) => client.fetchCentralBankAuctionResults(),
  },
  {
    name: "bog_list_external_facilities",
    title: "Project administration and external facilities",
    description:
      "Bank of Ghana records on project administration and external facilities — externally " +
      "funded facilities the central bank administers.",
    inputSchema: {
      refresh: z.boolean().optional().describe("Bypass the cache and re-fetch. Rarely needed."),
    },
    probe: (client) => client.fetchExternalFacilities(),
  },
];

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
        "Returns the LATEST published day only — BoG does not expose history on this table, so " +
        "there is no date range to ask for.",
      inputSchema: {
        currency: z
          .string()
          .optional()
          .describe(
            "Restrict to one currency, by code (USD, GBP, EUR) or published name (\"US Dollar\"). " +
              "Omit for all 19.",
          ),
      },
      outputSchema: {
        date: z.string().describe("Publication date of these rates, ISO 8601."),
        rateCount: z.number(),
        rates: z.array(InterbankFxRateSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ currency }) => {
      log.info("tool: bog_get_interbank_fx_rates", { currency: currency ?? "all" });

      try {
        // Cached unfiltered, then filtered in memory: the upstream returns all 19
        // rows regardless, so one cache entry serves every currency query.
        const result = await readThrough(deps.cache, FX_CACHE_KEY, FX_TTL_SECONDS, async () =>
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
        if (currency && rates.length === 0) {
          warnings.push(
            `No interbank rate published for "${currency}". Call this tool without a currency to see all 19.`,
          );
        }

        return toolResult({
          date: rates[0]?.date ?? rows[0]?.date ?? "",
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

  for (const stub of STUBS) {
    server.registerTool(
      stub.name,
      {
        title: stub.title,
        description: `${NOT_AVAILABLE} ${stub.description}`,
        inputSchema: stub.inputSchema,
        // No outputSchema: the row shape lands with the implementation, once the
        // real payload is known. Declaring a guess now would mean callers coding
        // against fields that may not survive contact with the data.
        annotations: { readOnlyHint: true, openWorldHint: true },
      },
      async () => {
        log.info("tool: stub called", { tool: stub.name });
        try {
          await stub.probe(deps.client);
          // Unreachable while the client throws; guards against a half-finished
          // implementation silently returning nothing.
          return toolError(
            `${stub.name} returned no data. This tool is not fully implemented — do not guess the figures.`,
          );
        } catch (error) {
          return toolError(
            `${describeError(error)} This server cannot retrieve it yet. Do not estimate these ` +
              "figures or recall them from memory — they are financial data and a wrong number is " +
              "worse than none. Tell the user the tool is not implemented yet and refer them to " +
              "the page above.",
          );
        }
      },
    );
  }
}

/** Datasets still awaiting an implementation. */
export const BOG_STUB_TOOL_NAMES: readonly string[] = STUBS.map((stub) => stub.name);

/** Every tool this source registers. Exported so tests and docs stay in step. */
export const BOG_TOOL_NAMES: readonly string[] = [
  "bog_get_interbank_fx_rates",
  ...BOG_STUB_TOOL_NAMES,
];
