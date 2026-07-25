import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { createCache, createMemoryKV, type Cache } from "../../../src/lib/cache.js";
import { BOG_PAGES, BogClient } from "../../../src/sources/bog/client.js";
import { InterbankFxRateSchema } from "../../../src/sources/bog/types.js";
import {
  BOG_STUB_TOOL_NAMES,
  BOG_TOOL_NAMES,
  registerBogTools,
} from "../../../src/sources/bog/tools.js";
import { fixture, fixtureJson } from "../../helpers/fixtures.js";
import { errorResponse, htmlResponse, jsonResponse, stubFetch } from "../../helpers/stubFetch.js";

const fxPageHtml = fixture("bog-interbank-fx.trimmed.html");
const fxPayload = fixtureJson("bog-interbank-fx.json");

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * The fetch stub has no routes at all, so any attempt to reach the network throws
 * "no route matches" — which is how these tests prove the stubs never make an
 * upstream request.
 */
async function harness() {
  const { fetch: fetchImpl, calls } = stubFetch([]);
  const server = new McpServer({ name: "test", version: "0.0.0" });

  registerBogTools(server, {
    client: new BogClient({ fetchImpl, baseDelayMs: 0, retries: 0 }),
    cache: createCache(createMemoryKV()),
  });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, calls };
}

/** Harness with the FX routes wired, for the one implemented tool. */
async function fxHarness(
  options: { tableResponses?: Array<() => Response>; cache?: Cache } = {},
) {
  const { fetch: fetchImpl, calls } = stubFetch([
    { match: "/daily-interbank-fx-rates/", responses: [() => htmlResponse(fxPageHtml, [])] },
    {
      match: "table_id=31",
      responses: options.tableResponses ?? [() => jsonResponse(fxPayload)],
    },
  ]);

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerBogTools(server, {
    client: new BogClient({ fetchImpl, baseDelayMs: 0, retries: 0 }),
    cache: options.cache ?? createCache(createMemoryKV()),
  });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, calls };
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe("BoG tool registration", () => {
  it("registers one tool per published dataset", async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "bog_get_central_bank_auction_results",
      "bog_get_central_bank_bill_rates",
      "bog_get_interbank_fx_rates",
      "bog_get_interbank_interest_rates",
      "bog_get_treasury_auction_results",
      "bog_get_treasury_bill_rates",
      "bog_list_external_facilities",
    ]);
    // One tool per dataset listed on BoG's Treasury and the Markets section.
    expect(names).toHaveLength(Object.keys(BOG_PAGES).length);
  });

  it("namespaces every tool, so it cannot collide with another source", async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names.every((name) => name.startsWith("bog_"))).toBe(true);
  });

  it("keeps the exported name list in step with what it registers", async () => {
    const { client } = await harness();
    const registered = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect([...BOG_TOOL_NAMES].sort()).toEqual(registered);
  });

  it("marks every tool read-only", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
    }
  });

  // A model reading the tool list should be able to skip these without calling
  // one and burning a turn.
  it("says up front in the description which tools are not available", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      const isStub = BOG_STUB_TOOL_NAMES.includes(tool.name);
      expect(/^NOT YET AVAILABLE/.test(tool.description ?? ""), tool.name).toBe(isStub);
    }
  });

  // The row shape is unknown until the real payload is; declaring a guess would
  // have callers coding against fields that may not survive contact with it.
  // Stubs have no output schema — the row shape is unknown until the real payload
  // is. An implemented tool must have one.
  it("declares an output schema only where the shape is known", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      if (BOG_STUB_TOOL_NAMES.includes(tool.name)) {
        expect(tool.outputSchema, tool.name).toBeUndefined();
      } else {
        expect(tool.outputSchema, tool.name).toBeDefined();
      }
    }
  });
});

describe("BoG stub behaviour", () => {
  it.each([...BOG_STUB_TOOL_NAMES])("%s reports an error rather than data", async (name) => {
    const { client } = await harness();
    const result = await call(client, name);

    expect(result.isError, name).toBe(true);
    expect(result.content[0]?.text).toMatch(/not implemented yet/i);
  });

  // This is the failure mode that matters: `rows: []` reads as "there is no such
  // data", which is a different and false claim from "I cannot fetch it".
  it.each([...BOG_STUB_TOOL_NAMES])("%s never returns an empty result set", async (name) => {
    const { client } = await harness();
    const result = await call(client, name);

    expect(result.structuredContent).toBeUndefined();
    expect(result.content[0]?.text).not.toMatch(/^\s*[[{]/);
  });

  // These are interest rates and exchange rates. A plausible-looking number
  // recalled from training data is worse than no answer.
  it.each([...BOG_STUB_TOOL_NAMES])("%s tells the model not to answer from memory", async (name) => {
    const { client } = await harness();
    const text = (await call(client, name)).content[0]?.text ?? "";

    expect(text).toMatch(/do not estimate/i);
    expect(text).toMatch(/memory/i);
  });

  it("points at the public page for the dataset", async () => {
    const { client } = await harness();

    const cases: Array<[string, string]> = [
      ["bog_get_treasury_bill_rates", BOG_PAGES.treasuryBillRates],
      ["bog_get_central_bank_bill_rates", BOG_PAGES.centralBankBillRates],
      ["bog_get_interbank_interest_rates", BOG_PAGES.interbankInterestRates],
      ["bog_get_treasury_auction_results", BOG_PAGES.treasuryAuctionResults],
      ["bog_get_central_bank_auction_results", BOG_PAGES.centralBankAuctionResults],
      ["bog_list_external_facilities", BOG_PAGES.externalFacilities],
    ];

    for (const [name, page] of cases) {
      const text = (await call(client, name)).content[0]?.text ?? "";
      expect(text, name).toContain(`https://www.bog.gov.gh${page}`);
    }
  });

  it("makes no upstream request at all", async () => {
    const { client, calls } = await harness();
    for (const name of BOG_STUB_TOOL_NAMES) await call(client, name);

    expect(calls).toHaveLength(0);
  });

  it("does not blame the source site for a gap in this server", async () => {
    const { client } = await harness();
    const text = (await call(client, "bog_get_treasury_bill_rates")).content[0]?.text ?? "";

    // "Upstream request failed" would send someone debugging bog.gov.gh.
    expect(text).not.toMatch(/upstream request failed|could not be reached|returned \d{3}/i);
  });
});

describe("BoG stub inputs", () => {
  // The inputs are the part that is settled, so they are validated now — a caller
  // can code against them before the data lands.
  it("accepts a day window on the rate series", async () => {
    const { client } = await harness();
    const result = await call(client, "bog_get_treasury_bill_rates", { days: 30 });

    // Still an error, but a *not-implemented* error rather than a validation one.
    expect(result.content[0]?.text).toMatch(/not implemented yet/i);
  });

  it("rejects a day window outside the supported range", async () => {
    const { client } = await harness();
    const result = await call(client, "bog_get_treasury_bill_rates", { days: 99_999 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toMatch(/not implemented yet/i);
  });

  it("rejects an unknown frequency on the interbank rates", async () => {
    const { client } = await harness();
    const result = await call(client, "bog_get_interbank_interest_rates", { frequency: "hourly" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).not.toMatch(/not implemented yet/i);
  });

  it("accepts an auction limit", async () => {
    const { client } = await harness();
    const result = await call(client, "bog_get_treasury_auction_results", { limit: 4 });

    expect(result.content[0]?.text).toMatch(/not implemented yet/i);
  });
});

interface FxPayload {
  date: string;
  rateCount: number;
  rates: Array<{ currency: string; code: string; pair: string; bid: number; offer: number; mid: number }>;
  meta: { origin: string; warning?: string };
}

describe("bog_get_interbank_fx_rates", () => {
  it("returns every published currency, matching the row schema", async () => {
    const { client } = await fxHarness();
    const result = await call(client, "bog_get_interbank_fx_rates");
    const payload = result.structuredContent as unknown as FxPayload;

    expect(result.isError).toBeFalsy();
    expect(payload.meta.origin).toBe("live");
    expect(payload.rateCount).toBe(payload.rates.length);
    expect(payload.rateCount).toBe(19);
    expect(payload.date).toBe("2026-07-24");
    for (const rate of payload.rates) {
      expect(() => InterbankFxRateSchema.parse(rate)).not.toThrow();
    }
  });

  it("reads bid, offer and mid for the dollar", async () => {
    const { client } = await fxHarness();
    const payload = (await call(client, "bog_get_interbank_fx_rates"))
      .structuredContent as unknown as FxPayload;
    const usd = payload.rates.find((rate) => rate.code === "USD");

    expect(usd).toEqual({
      date: "2026-07-24",
      currency: "US Dollar",
      code: "USD",
      pair: "USDGHS",
      bid: 11.6292,
      offer: 11.6408,
      mid: 11.635,
    });
  });

  it("filters by currency code", async () => {
    const { client } = await fxHarness();
    const payload = (await call(client, "bog_get_interbank_fx_rates", { currency: "GBP" }))
      .structuredContent as unknown as FxPayload;

    expect(payload.rateCount).toBe(1);
    expect(payload.rates[0]?.pair).toBe("GBPGHS");
  });

  it("also accepts the published currency name, case-insensitively", async () => {
    const { client } = await fxHarness();
    const payload = (await call(client, "bog_get_interbank_fx_rates", { currency: "us dollar" }))
      .structuredContent as unknown as FxPayload;

    expect(payload.rates[0]?.code).toBe("USD");
  });

  it("explains an unmatched currency rather than returning a bare empty list", async () => {
    const { client } = await fxHarness();
    const payload = (await call(client, "bog_get_interbank_fx_rates", { currency: "XYZ" }))
      .structuredContent as unknown as FxPayload;

    expect(payload.rateCount).toBe(0);
    expect(payload.meta.warning).toMatch(/No interbank rate published for "XYZ"/);
  });

  // The upstream returns all 19 rows whatever we ask for, so one cache entry
  // serves every currency query — a per-currency key would multiply the scrapes.
  it("serves a filtered query from the same cache entry", async () => {
    const { client, calls } = await fxHarness();

    await call(client, "bog_get_interbank_fx_rates");
    const afterFirst = calls.length;
    const second = await call(client, "bog_get_interbank_fx_rates", { currency: "EUR" });

    expect(calls.length).toBe(afterFirst);
    expect((second.structuredContent as unknown as FxPayload).meta.origin).toBe("cache");
  });

  it("takes two upstream requests: the nonce page, then the table", async () => {
    const { client, calls } = await fxHarness();
    await call(client, "bog_get_interbank_fx_rates");

    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(1);
    expect(calls[1]?.url).toContain("table_id=31");
  });

  // bog.gov.gh accepts the nonce without a cookie, unlike gse.com.gh — verified
  // live. The fixture page therefore sets none, and this must still work.
  it("works when the page sets no cookie", async () => {
    const { client, calls } = await fxHarness();
    const result = await call(client, "bog_get_interbank_fx_rates");

    expect(result.isError).toBeFalsy();
    expect(calls[1]?.headers.get("cookie")).toBeNull();
  });

  it("reports an upstream failure as a tool error", async () => {
    const { client } = await fxHarness({ tableResponses: [() => errorResponse(503)] });
    const result = await call(client, "bog_get_interbank_fx_rates");

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/503/);
  });
});
