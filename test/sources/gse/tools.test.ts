import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { createCache, createMemoryKV, type Cache } from "../../../src/lib/cache.js";
import { GseClient } from "../../../src/sources/gse/client.js";
import { registerGseTools } from "../../../src/sources/gse/tools.js";
import {
  MarketIndexRowSchema,
  StockPriceRowSchema,
} from "../../../src/sources/gse/types.js";
import { fixture, fixtureJson } from "../../helpers/fixtures.js";
import { errorResponse, htmlResponse, jsonResponse, stubFetch } from "../../helpers/stubFetch.js";

const tradingPageHtml = fixture("trading-and-data.trimmed.html");
const listedCompaniesHtml = fixture("listed-companies.trimmed.html");
const historyPayload = fixtureJson("history-mtngh.json");
const mainMarketPayload = fixtureJson("companies-main-market.json");
const etfPayload = fixtureJson("companies-etf.json");
const gaxPayload = fixtureJson("companies-gax.json");
const marketIndexPayload = fixtureJson("market-index.json");
const fixedIncomePayload = fixtureJson("fixed-income-issuers.json");

interface Harness {
  client: Client;
  cache: Cache;
  calls: () => number;
}

/**
 * Wires the GSE toolset to a real MCP client over an in-memory transport, so the
 * assertions below go through actual tool dispatch and output-schema validation
 * rather than calling the handlers directly.
 */
async function harness(
  options: {
    /** Responses for the price table; the default serves the history fixture. */
    responses?: Array<() => Response>;
    /** Per-table overrides for the company tables, keyed by table id. */
    companyResponses?: Partial<Record<number, () => Response>>;
    /** Responses for the market-index table (47). */
    marketIndexResponses?: Array<() => Response>;
    /** Responses for the GFIM issuer table (37). */
    fixedIncomeResponses?: Array<() => Response>;
    cache?: Cache;
  } = {},
): Promise<Harness> {
  const companies = options.companyResponses ?? {};
  const { fetch: fetchImpl, calls } = stubFetch([
    { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
    { match: "/listed-companies/", responses: [() => htmlResponse(listedCompaniesHtml)] },
    { match: "table_id=34", responses: [companies[34] ?? (() => jsonResponse(mainMarketPayload))] },
    { match: "table_id=35", responses: [companies[35] ?? (() => jsonResponse(etfPayload))] },
    { match: "table_id=36", responses: [companies[36] ?? (() => jsonResponse(gaxPayload))] },
    {
      match: "table_id=47",
      responses: options.marketIndexResponses ?? [() => jsonResponse(marketIndexPayload)],
    },
    {
      match: "table_id=37",
      responses: options.fixedIncomeResponses ?? [() => jsonResponse(fixedIncomePayload)],
    },
    { match: "admin-ajax.php", responses: options.responses ?? [() => jsonResponse(historyPayload)] },
  ]);

  const server = new McpServer({ name: "test", version: "0.0.0" });
  const cache = options.cache ?? createCache(createMemoryKV());
  registerGseTools(server, {
    client: new GseClient({ fetchImpl, baseDelayMs: 0, retries: 1 }),
    cache,
  });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, cache, calls: () => calls.length };
}

// The SDK types the result loosely; these narrow it for readable assertions.
interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe("tool registration", () => {
  it("exposes the namespaced GSE tools", async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "gse_get_market_index",
      "gse_get_stock_history",
      "gse_list_companies",
      "gse_list_fixed_income_issuers",
      "gse_search_company",
    ]);
    // Namespacing is the convention that lets a second source coexist (plan §4).
    expect(names.every((name) => name.startsWith("gse_"))).toBe(true);
  });

  it("declares input and output schemas for every tool", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.inputSchema).toBeDefined();
      expect(tool.outputSchema, `${tool.name} has no output schema`).toBeDefined();
      expect(tool.annotations?.readOnlyHint).toBe(true);
    }
  });
});

describe("gse_get_stock_history", () => {
  it("returns rows matching the published row schema", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_get_stock_history", { symbol: "MTNGH" });

    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as {
      symbol: string;
      days: number;
      rowCount: number;
      rows: unknown[];
      meta: { origin: string };
    };

    expect(payload.symbol).toBe("MTNGH");
    expect(payload.days).toBe(90);
    expect(payload.rowCount).toBe(payload.rows.length);
    expect(payload.meta.origin).toBe("live");
    for (const row of payload.rows) expect(() => StockPriceRowSchema.parse(row)).not.toThrow();
  });

  it("also serialises the payload as text, for clients that ignore structured content", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_get_stock_history", { symbol: "MTNGH" });

    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it("accepts a lowercase symbol", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_get_stock_history", { symbol: "mtngh" });
    expect((result.structuredContent as { rowCount: number }).rowCount).toBeGreaterThan(0);
  });

  it("serves the second identical call from cache without re-scraping", async () => {
    const { client, calls } = await harness();

    await call(client, "gse_get_stock_history", { symbol: "MTNGH" });
    const afterFirst = calls();
    const second = await call(client, "gse_get_stock_history", { symbol: "MTNGH" });

    expect(calls()).toBe(afterFirst);
    expect((second.structuredContent as { meta: { origin: string } }).meta.origin).toBe("cache");
  });

  it("keys the cache by day count, so a different window still hits upstream", async () => {
    const { client, calls } = await harness();

    await call(client, "gse_get_stock_history", { symbol: "MTNGH", days: 30 });
    const afterFirst = calls();
    await call(client, "gse_get_stock_history", { symbol: "MTNGH", days: 60 });

    expect(calls()).toBeGreaterThan(afterFirst);
  });

  // Plan §7: an upstream outage with a cached copy on hand returns the copy,
  // labelled, rather than failing the call.
  it("serves stale data with a warning when upstream is down", async () => {
    // The clock has to advance *between* the write and the read, otherwise the
    // entry is still fresh and never reaches the stale path.
    let now = Date.parse("2026-07-25T10:00:00Z");
    const cache = createCache(createMemoryKV(), { now: () => now });

    const warm = await harness({ cache });
    await call(warm.client, "gse_get_stock_history", { symbol: "MTNGH" });

    now += 24 * 60 * 60 * 1000; // past the longest freshness window

    const broken = await harness({ cache, responses: [() => errorResponse(503)] });
    const result = await call(broken.client, "gse_get_stock_history", { symbol: "MTNGH" });

    expect(result.isError).toBeFalsy();
    const meta = (result.structuredContent as { meta: { origin: string; warning?: string } }).meta;
    expect(meta.origin).toBe("stale-cache");
    expect(meta.warning).toMatch(/could not be reached/);
  });

  it("reports an upstream failure as a tool error when nothing is cached", async () => {
    const { client } = await harness({ responses: [() => errorResponse(503)] });
    const result = await call(client, "gse_get_stock_history", { symbol: "MTNGH" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/503/);
    // The message should tell the model what to do next, like ModelRetry did.
    expect(result.content[0]?.text).toMatch(/retry/i);
  });

  it("explains an empty result instead of returning a bare empty list", async () => {
    const { client } = await harness({ responses: [() => jsonResponse({ data: [] })] });
    const result = await call(client, "gse_get_stock_history", { symbol: "NOSUCH" });

    const payload = result.structuredContent as { rowCount: number; meta: { warning?: string } };
    expect(payload.rowCount).toBe(0);
    expect(payload.meta.warning).toMatch(/gse_search_company/);
  });

  it("counts dropped rows in the response metadata", async () => {
    const rows = (historyPayload as { data: string[][] }).data;
    const broken = [...(rows[0] as string[])];
    broken[8] = "";

    const { client } = await harness({
      responses: [() => jsonResponse({ data: [rows[1], broken] })],
    });
    const result = await call(client, "gse_get_stock_history", { symbol: "MTNGH" });

    const payload = result.structuredContent as { meta: { skippedRows?: number; warning?: string } };
    expect(payload.meta.skippedRows).toBe(1);
    expect(payload.meta.warning).toMatch(/dropped/);
  });

  it("rejects a symbol with nothing usable in it before making a request", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "gse_get_stock_history", { symbol: "!!!" });

    expect(result.isError).toBe(true);
    expect(calls()).toBe(0);
  });

  it("rejects a day count outside the supported range at the schema layer", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_get_stock_history", { symbol: "MTNGH", days: 99_999 });
    expect(result.isError).toBe(true);
  });
});

describe("gse_get_market_index", () => {
  it("returns market-wide rows matching the published schema", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_get_market_index", {});
    const payload = result.structuredContent as {
      days: number;
      rowCount: number;
      rows: unknown[];
      meta: { origin: string };
    };

    expect(result.isError).toBeFalsy();
    expect(payload.days).toBe(90);
    expect(payload.rowCount).toBe(payload.rows.length);
    expect(payload.meta.origin).toBe("live");
    for (const row of payload.rows) expect(() => MarketIndexRowSchema.parse(row)).not.toThrow();
  });

  it("carries the index levels and market cap through", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_get_market_index", { days: 30 });
    const rows = (result.structuredContent as { rows: Array<Record<string, number>> }).rows;

    expect(rows.at(-1)).toEqual({
      date: "2026-07-24",
      volume: 3_210_763,
      compositeIndex: 15_330.57,
      marketCapGhsMillion: 292_058.49,
      financialStockIndex: 8_281.03,
    });
  });

  it("caches by day count", async () => {
    const { client, calls } = await harness();

    await call(client, "gse_get_market_index", { days: 30 });
    const afterFirst = calls();
    await call(client, "gse_get_market_index", { days: 30 });
    expect(calls()).toBe(afterFirst);

    await call(client, "gse_get_market_index", { days: 60 });
    expect(calls()).toBeGreaterThan(afterFirst);
  });

  // The index cache must not collide with the price cache, which is keyed on
  // symbol and days — a bare `days` key would have crossed them.
  it("does not share a cache entry with the price history tool", async () => {
    const { client } = await harness();

    await call(client, "gse_get_market_index", { days: 90 });
    const history = await call(client, "gse_get_stock_history", { symbol: "MTNGH", days: 90 });

    expect(history.structuredContent).toHaveProperty("symbol", "MTNGH");
    expect(history.structuredContent).not.toHaveProperty("compositeIndex");
  });

  it("reports an upstream failure as a tool error", async () => {
    const { client } = await harness({ marketIndexResponses: [() => errorResponse(503)] });
    const result = await call(client, "gse_get_market_index", {});

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/503/);
  });

  it("rejects a day count outside the supported range", async () => {
    const { client } = await harness();
    expect((await call(client, "gse_get_market_index", { days: 99_999 })).isError).toBe(true);
  });
});

describe("gse_list_fixed_income_issuers", () => {
  it("returns the GFIM issuers with their amounts as numbers", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_list_fixed_income_issuers", {});
    const payload = result.structuredContent as {
      issuerCount: number;
      issuers: Array<Record<string, unknown>>;
      meta: { origin: string };
    };

    expect(result.isError).toBeFalsy();
    expect(payload.issuerCount).toBe(payload.issuers.length);
    expect(payload.issuerCount).toBe(14);
    expect(payload.meta.origin).toBe("live");
    expect(payload.issuers).toContainEqual({
      name: "ESLA Plc",
      admittedYear: 2017,
      tranches: 6,
      amountRaisedGhsMillion: 10_500,
      shelfRegistrationGhsMillion: 10_500,
    });
  });

  // These are debt issuers with no share code; mixing them into the equity
  // directory would make gse_get_stock_history look broken for them.
  it("keeps fixed-income issuers out of the equity directory", async () => {
    const { client } = await harness();
    const companies = (
      (await call(client, "gse_list_companies")).structuredContent as {
        companies: Array<{ name: string }>;
      }
    ).companies;

    expect(companies.map((company) => company.name)).not.toContain("ESLA Plc");
    expect(companies.map((company) => company.name)).not.toContain("Ghana Cocoa Board");
  });

  it("caches, and re-fetches on refresh", async () => {
    const { client, calls } = await harness();

    await call(client, "gse_list_fixed_income_issuers", {});
    const afterFirst = calls();
    await call(client, "gse_list_fixed_income_issuers", {});
    expect(calls()).toBe(afterFirst);

    await call(client, "gse_list_fixed_income_issuers", { refresh: true });
    expect(calls()).toBeGreaterThan(afterFirst);
  });

  it("reports an upstream failure as a tool error", async () => {
    const { client } = await harness({ fixedIncomeResponses: [() => errorResponse(503)] });
    const result = await call(client, "gse_list_fixed_income_issuers", {});

    expect(result.isError).toBe(true);
  });
});

interface CompanyListPayload {
  companyCount: number;
  companies: Array<{ name: string; symbol: string; market: string; dateListed?: string }>;
  meta: { origin: string; warning?: string };
}

describe("gse_list_companies", () => {
  it("returns the live directory across all three markets", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_list_companies");
    const payload = result.structuredContent as unknown as CompanyListPayload;

    expect(result.isError).toBeFalsy();
    expect(payload.meta.origin).toBe("live");
    expect(payload.meta.warning).toBeUndefined();
    expect(payload.companyCount).toBe(payload.companies.length);
    expect(payload.companyCount).toBe(40);
    expect(new Set(payload.companies.map((company) => company.market))).toEqual(
      new Set(["main", "gax", "etf"]),
    );
  });

  it("carries the symbol, name and listing date through to the caller", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_list_companies");
    const payload = result.structuredContent as unknown as CompanyListPayload;

    expect(payload.companies).toContainEqual(
      expect.objectContaining({ symbol: "MTNGH", name: "MTN Ghana", market: "main" }),
    );
    expect(payload.companies.find((company) => company.symbol === "ACCESS")?.dateListed).toBe(
      "2022-12-21",
    );
  });

  it("filters to one board on request", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_list_companies", { market: "gax" });
    const payload = result.structuredContent as unknown as CompanyListPayload;

    expect(payload.companyCount).toBe(5);
    expect(payload.companies.every((company) => company.market === "gax")).toBe(true);
  });

  it("rejects a board that does not exist at the schema layer", async () => {
    const { client } = await harness();
    expect((await call(client, "gse_list_companies", { market: "nasdaq" })).isError).toBe(true);
  });

  it("caches the directory, then re-fetches when asked to refresh", async () => {
    const { client, calls } = await harness();

    await call(client, "gse_list_companies");
    const afterFirst = calls();
    await call(client, "gse_list_companies");
    expect(calls()).toBe(afterFirst); // served from cache

    await call(client, "gse_list_companies", { refresh: true });
    expect(calls()).toBeGreaterThan(afterFirst);
  });

  it("returns a partial directory with a warning when one board fails", async () => {
    const { client } = await harness({ companyResponses: { 36: () => errorResponse(500) } });
    const result = await call(client, "gse_list_companies");
    const payload = result.structuredContent as unknown as CompanyListPayload;

    expect(result.isError).toBeFalsy();
    expect(payload.meta.warning).toMatch(/Ghana Alternative Market/);
    expect(payload.companies.some((company) => company.market === "gax")).toBe(false);
  });

  // With no cache to fall back on, a dated list of share codes still lets the
  // caller look up prices; a bare error would leave them with nothing.
  it("falls back to the built-in seed when the scrape fails entirely", async () => {
    const { client } = await harness({
      companyResponses: {
        34: () => errorResponse(503),
        35: () => errorResponse(503),
        36: () => errorResponse(503),
      },
    });
    const result = await call(client, "gse_list_companies");
    const payload = result.structuredContent as unknown as CompanyListPayload;

    expect(result.isError).toBeFalsy();
    expect(payload.meta.origin).toBe("static-seed");
    expect(payload.meta.warning).toMatch(/built-in fallback list/);
    expect(payload.companies.length).toBeGreaterThan(20);
    expect(payload.companies.every((company) => company.market === "main")).toBe(true);
  });
});

describe("gse_search_company", () => {
  it("resolves a common shorthand to a share code", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_search_company", { query: "MTN" });

    const matches = (result.structuredContent as { matches: Array<{ symbol: string; score: number }> })
      .matches;
    expect(matches[0]?.symbol).toBe("MTNGH");
    expect(matches[0]?.score).toBeGreaterThan(0.9);
  });

  // Search runs over the live directory, so it can find a company the built-in
  // seed has never heard of.
  it("finds a company that only exists in the live directory", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_search_company", { query: "first atlantic" });
    const matches = (result.structuredContent as { matches: Array<{ symbol: string }> }).matches;

    expect(matches[0]?.symbol).toBe("FAB");
  });

  it("reports which board a match is listed on", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_search_company", { query: "digicut" });
    const matches = (result.structuredContent as { matches: Array<{ market: string }> }).matches;

    expect(matches[0]?.market).toBe("gax");
  });

  it("resolves a partial company name", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_search_company", { query: "gcb bank" });
    expect(
      (result.structuredContent as { matches: Array<{ symbol: string }> }).matches[0]?.symbol,
    ).toBe("GCB");
  });

  it("honours the limit", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_search_company", { query: "bank", limit: 2 });
    expect((result.structuredContent as { matches: unknown[] }).matches).toHaveLength(2);
  });

  it("points at the full list when nothing matches", async () => {
    const { client } = await harness();
    const result = await call(client, "gse_search_company", { query: "zzzzzzz" });

    const payload = result.structuredContent as { matches: unknown[]; meta: { warning?: string } };
    expect(payload.matches).toEqual([]);
    expect(payload.meta.warning).toMatch(/gse_list_companies/);
  });
});
