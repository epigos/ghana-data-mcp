import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Cache } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { toolError } from "../../lib/results.js";
import { BogClient } from "./client.js";
import { DEFAULT_DAYS, MAX_DAYS } from "./types.js";

/**
 * MCP tool surface for Bank of Ghana data, namespaced `bog_`.
 *
 * ## These are stubs
 *
 * Every tool here is registered with its final input schema and a description of
 * what it will return, but calling one returns an MCP error. That is deliberate:
 * it fixes the contract — names, inputs, which dataset belongs in which tool —
 * before the parsing work, and it means the registration, caching and docs
 * scaffolding is in place and tested for when each one is filled in.
 *
 * Two rules the stub errors follow, because this is financial data:
 *
 *  1. They never return an empty result set. An empty `rows: []` reads as "there
 *     is no data", which is a different and false claim.
 *  2. They tell the model not to answer from memory, and give the public URL
 *     instead. A plausible-looking T-bill rate recalled from training data is
 *     worse than no answer at all.
 *
 * Each description is prefixed NOT YET AVAILABLE so a model reading the tool list
 * can avoid calling it in the first place.
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
    name: "bog_get_interbank_fx_rates",
    title: "Ghana interbank FX rates",
    description:
      "Daily Bank of Ghana interbank reference rates for the Ghana cedi (GHS) against major " +
      "currencies — US dollar, pound sterling, euro. These are the official reference rates, " +
      "not retail or forex-bureau rates, which differ.",
    inputSchema: {
      ...daysInput("rate history"),
      currency: z
        .string()
        .optional()
        .describe("ISO 4217 code to filter to, e.g. USD, GBP, EUR. Omit for all currencies."),
    },
    probe: (client) => client.fetchInterbankFxRates(),
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

/** Tool names this source registers. Exported so tests and docs stay in step. */
export const BOG_TOOL_NAMES: readonly string[] = STUBS.map((stub) => stub.name);
