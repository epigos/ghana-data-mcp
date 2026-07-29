import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { createCache, createMemoryKV, type Cache } from "../../../src/lib/cache.js";
import { GssClient } from "../../../src/sources/gss/client.js";
import { registerGssTools } from "../../../src/sources/gss/tools.js";
import { fixtureJson } from "../../helpers/fixtures.js";
import { errorResponse, jsonResponse, stubFetch, type RecordedCall } from "../../helpers/stubFetch.js";

const fuelSchema = fixtureJson("gss-fuel-schema.json");
const cpiSchema = fixtureJson("gss-cpi-schema.json");
const tradeSchema = fixtureJson("gss-trade-schema.json");
const gdpSchema = fixtureJson("gss-gdp-expenditure-schema.json");
const miegSchema = fixtureJson("gss-mieg-schema.json");
const fuelData = fixtureJson("gss-fuel-data.json");
const cpiData = fixtureJson("gss-cpi-data.json");
const gdpData = fixtureJson("gss-gdp-expenditure-data.json");

interface Harness {
  client: Client;
  calls: RecordedCall[];
}

/**
 * Routes are matched by substring on the URL, and PxWeb uses the same URL for the
 * schema GET and the data POST — so each table gets one route that answers with its
 * schema or its data depending on the method.
 */
async function harness(
  options: {
    dataResponses?: Array<() => Response>;
    schemaResponse?: () => Response;
    cache?: Cache;
  } = {},
): Promise<Harness> {
  const byTable: Array<[string, unknown, unknown]> = [
    ["fuel.px", fuelSchema, fuelData],
    ["cpi.px", cpiSchema, cpiData],
    ["macro_trade.px", tradeSchema, { columns: [], data: [], metadata: [] }],
    ["agdp_e_px.px", gdpSchema, gdpData],
    ["MIEG_Px.px", miegSchema, { columns: [], data: [], metadata: [] }],
  ];

  const { fetch: fetchImpl, calls } = stubFetch(
    byTable.map(([match, schema, data]) => ({
      match,
      responses: [
        () => {
          const last = calls[calls.length - 1];
          if (last?.method === "POST") {
            const queued = options.dataResponses?.shift();
            return queued ? queued() : jsonResponse(data);
          }
          return options.schemaResponse ? options.schemaResponse() : jsonResponse(schema);
        },
      ],
    })),
  );

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerGssTools(server, {
    client: new GssClient({ fetchImpl, baseDelayMs: 0, retries: 1 }),
    cache: options.cache ?? createCache(createMemoryKV()),
  });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);

  return { client, calls };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

const bodyOf = (calls: RecordedCall[]) =>
  JSON.parse(calls.filter((c) => c.method === "POST").at(-1)!.body!) as {
    query: Array<{ code: string; selection: { filter: string; values: string[] } }>;
  };

const selectionFor = (calls: RecordedCall[], code: string) =>
  bodyOf(calls).query.find((q) => q.code === code);

interface ListPayload {
  tableCount: number;
  tables: Array<{ id: string; title: string; sector: string; granularityRequired: boolean }>;
  meta: { origin: string; warning?: string };
}

interface DescribePayload {
  schema: {
    id: string;
    latestPeriod?: string;
    earliestPeriod?: string;
    recentPeriods: string[];
    granularities: string[];
    granularityRequired: boolean;
    dimensions: Array<{ code: string; values: string[] }>;
  };
  meta: { origin: string; warning?: string };
}

interface DataPayload {
  result: {
    table: string;
    source: string;
    updated?: string;
    granularity: string;
    periods: string[];
    rowCount: number;
    rows: Array<{
      period: string;
      provisional: boolean;
      dimensions: Record<string, string>;
      measure: string;
      value: number;
    }>;
  };
  meta: { origin: string; warning?: string; skippedRows?: number };
}

describe("tool registration", () => {
  it("registers the three namespaced tools", async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual(["gss_describe_table", "gss_get_data", "gss_list_tables"]);
    expect(names.every((n) => n.startsWith("gss_"))).toBe(true);
  });

  it("declares input and output schemas for all three", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });
});

describe("gss_list_tables", () => {
  it("lists all sixteen tables without touching the network", async () => {
    const { client, calls } = await harness();
    const payload = (await call(client, "gss_list_tables")).structuredContent as unknown as ListPayload;

    expect(payload.tableCount).toBe(16);
    expect(payload.meta.origin).toBe("static-seed");
    expect(calls).toHaveLength(0);
  });

  it("finds a table by a keyword in its summary rather than only its id", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_list_tables", { query: "non-performing loan" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.tables.map((t) => t.id)).toContain("financial_soundness");
  });

  it("matches an upstream alias so a caller reading the Postman collection lands right", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_list_tables", { query: "fin_sound" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.tables.map((t) => t.id)).toEqual(["financial_soundness"]);
  });

  it("filters by sector", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_list_tables", { sector: "External Sector" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.tables.map((t) => t.id).sort()).toEqual(["international_finance", "trade"]);
  });

  it("names the known sectors when given one that does not exist", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_list_tables", { sector: "Nope" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.tables).toEqual([]);
    expect(payload.meta.warning).toMatch(/Known sectors/);
  });

  it("flags which tables need an explicit granularity", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_list_tables")).structuredContent as unknown as ListPayload;
    const needsIt = payload.tables.filter((t) => t.granularityRequired).map((t) => t.id).sort();

    expect(needsIt).toEqual(["fiscal", "trade"]);
  });

  it("explains an unmatched query instead of returning a bare empty list", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_list_tables", { query: "zzzznope" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.tables).toEqual([]);
    expect(payload.meta.warning).toMatch(/No table matched/);
  });
});

describe("gss_describe_table", () => {
  it("returns the axis bounds and every dimension value", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_describe_table", { table: "fuel" }))
      .structuredContent as unknown as DescribePayload;

    expect(payload.schema.id).toBe("fuel");
    expect(payload.schema.earliestPeriod).toBe("1999M01");
    expect(payload.schema.latestPeriod).toBe("2024M06");
    expect(payload.schema.recentPeriods[0]).toBe("2024M06");
    expect(payload.schema.dimensions.find((d) => d.code === "Fuel")?.values).toContain("Kerosene");
  });

  it("resolves a table by alias", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_describe_table", { table: "fuel_consumption" }))
      .structuredContent as unknown as DescribePayload;

    expect(payload.schema.id).toBe("fuel");
  });

  it("warns on a mixed-granularity table that granularity will be required", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_describe_table", { table: "trade" }))
      .structuredContent as unknown as DescribePayload;

    expect(payload.schema.granularityRequired).toBe(true);
    expect(payload.schema.granularities).toEqual(expect.arrayContaining(["quarterly", "monthly"]));
    expect(payload.meta.warning).toMatch(/requires an explicit `granularity`/);
  });

  it("caches the schema across calls", async () => {
    const { client, calls } = await harness();

    await call(client, "gss_describe_table", { table: "fuel" });
    const afterFirst = calls.length;
    await call(client, "gss_describe_table", { table: "fuel" });

    expect(calls.length).toBe(afterFirst);
  });

  it("rejects an unknown table before any network call", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "gss_describe_table", { table: "not_a_table" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a StatsBank table/);
    expect(calls).toHaveLength(0);
  });
});

describe("gss_get_data", () => {
  it("returns rows with source and updated attribution", async () => {
    const { client } = await harness();
    const payload = (await call(client, "gss_get_data", { table: "fuel", latest: 2 }))
      .structuredContent as unknown as DataPayload;

    expect(payload.result.source).toBe("National Petroleum Authority (NPA)");
    expect(payload.result.updated).toBe("2024-08-26T13:08:00Z");
    expect(payload.result.granularity).toBe("monthly");
    expect(payload.result.rowCount).toBeGreaterThan(0);
    expect(payload.meta.origin).toBe("live");
  });

  it("sends explicit period codes, never PxWeb's filter:top", async () => {
    // filter:"top" takes the first N in storage order, which is the latest only by
    // accident. This asserts the client never relies on it.
    const { client, calls } = await harness();
    await call(client, "gss_get_data", { table: "fuel", latest: 2 });

    const month = selectionFor(calls, "Month");
    expect(month?.selection.filter).toBe("item");
    expect(month?.selection.values).toEqual(["2024M05", "2024M06"]);
    expect(JSON.stringify(bodyOf(calls))).not.toContain("top");
  });

  it("asks for the genuinely latest periods on a table stored oldest-first", async () => {
    // mieg's axis runs 2023M01 -> 2026M04. filter:top 3 would have asked for the 2023
    // months, whose growth values are all 0.0.
    const { client, calls } = await harness();
    await call(client, "gss_get_data", { table: "mieg", latest: 3 });

    const month = selectionFor(calls, "Month");
    expect(month?.selection.values).toEqual(["2026M02", "2026M03", "2026M04"]);
    expect(month?.selection.values).not.toContain("2023M01");
  });

  it("defaults to the last twelve periods when none are named", async () => {
    const { client, calls } = await harness();
    await call(client, "gss_get_data", { table: "fuel" });

    expect(selectionFor(calls, "Month")?.selection.values).toHaveLength(12);
  });

  it("resolves a start/end range inclusively", async () => {
    const { client, calls } = await harness();
    await call(client, "gss_get_data", {
      table: "fuel",
      startPeriod: "2024M01",
      endPeriod: "2024M03",
    });

    expect(selectionFor(calls, "Month")?.selection.values).toEqual(["2024M01", "2024M02", "2024M03"]);
  });

  it("accepts explicit periods in a tolerant spelling", async () => {
    const { client, calls } = await harness();
    await call(client, "gss_get_data", { table: "fuel", periods: ["2024-05", "2024M6"] });

    expect(selectionFor(calls, "Month")?.selection.values).toEqual(["2024M05", "2024M06"]);
  });

  it("maps a bare year onto the provisional-marked code the API requires", async () => {
    // agdp's axis stores "2024*"; asking for "2024" would 404 without this.
    const { client, calls } = await harness();
    await call(client, "gss_get_data", { table: "gdp_expenditure", periods: ["2023", "2024", "2025"] });

    expect(selectionFor(calls, "Year")?.selection.values).toEqual(["2023", "2024*", "2025**"]);
  });

  it("flags provisional rows in the warning so a forecast is never reported as settled", async () => {
    const { client } = await harness();
    const payload = (
      await call(client, "gss_get_data", { table: "gdp_expenditure", periods: ["2023", "2024", "2025"] })
    ).structuredContent as unknown as DataPayload;

    const provisional = payload.result.rows.filter((r) => r.provisional).map((r) => r.period);
    expect(provisional.sort()).toEqual(["2024", "2025"]);
    expect(payload.meta.warning).toMatch(/provisional or forecast/);
  });

  it("requires granularity on a mixed-granularity table, before any POST", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "gss_get_data", { table: "trade", latest: 4 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/`granularity` is required/);
    expect(result.content[0]?.text).toMatch(/double-counting/);
    // The schema GET happened; no data POST did.
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("returns a single-granularity series once granularity is given", async () => {
    const { client, calls } = await harness();
    await call(client, "gss_get_data", { table: "trade", latest: 3, granularity: "quarterly" });

    const values = selectionFor(calls, "Time_Period")!.selection.values;
    expect(values.every((v) => /^\d{4}Q[1-4]$/.test(v))).toBe(true);
  });

  it("rejects a granularity the table does not publish", async () => {
    const { client } = await harness();
    const result = await call(client, "gss_get_data", { table: "fuel", granularity: "annual" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/publishes no annual periods/);
  });

  it("passes dimension filters through as exactly-spelled values", async () => {
    const { client, calls } = await harness();
    await call(client, "gss_get_data", {
      table: "cpi",
      latest: 1,
      filters: { Region: ["Ghana", "Ashanti"], Product: "All products" },
    });

    expect(selectionFor(calls, "Region")?.selection.values).toEqual(["Ghana", "Ashanti"]);
    expect(selectionFor(calls, "Product")?.selection.values).toEqual(["All products"]);
  });

  it("resolves a filter value and dimension code case-insensitively", async () => {
    const { client, calls } = await harness();
    await call(client, "gss_get_data", {
      table: "cpi",
      latest: 1,
      filters: { region: "ashanti" },
    });

    expect(selectionFor(calls, "Region")?.selection.values).toEqual(["Ashanti"]);
  });

  // "Food" is a real CPI basket and so is "Food and non-alcoholic beverages". A
  // substring match that silently picked the longer one would answer a different
  // question than the caller asked.
  it("prefers an exact value over a longer one that merely contains it", async () => {
    const { client, calls } = await harness();
    await call(client, "gss_get_data", { table: "cpi", latest: 1, filters: { Product: "Food" } });

    expect(selectionFor(calls, "Product")?.selection.values).toEqual(["Food"]);
  });

  it("errors with the accepted values when a filter value cannot be resolved", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "gss_get_data", {
      table: "cpi",
      latest: 1,
      filters: { Region: "Atlantis" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a value of `Region`/);
    expect(result.content[0]?.text).toMatch(/Accepts:/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("errors on an unknown dimension rather than silently dropping the filter", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "gss_get_data", {
      table: "fuel",
      latest: 1,
      filters: { Region: "Ghana" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not a dimension of this table/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("errors when no requested period exists on the axis", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "gss_get_data", { table: "fuel", periods: ["1899M01"] });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/None of these periods exist/);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("proceeds with the periods that do exist and warns about the rest", async () => {
    const { client, calls } = await harness();
    const payload = (
      await call(client, "gss_get_data", { table: "fuel", periods: ["2024M06", "1899M01"] })
    ).structuredContent as unknown as DataPayload;

    expect(selectionFor(calls, "Month")?.selection.values).toEqual(["2024M06"]);
    expect(payload.meta.warning).toMatch(/1899M01/);
  });

  it("errors when a range bound cannot be placed on the axis", async () => {
    const { client } = await harness();
    const result = await call(client, "gss_get_data", { table: "fuel", startPeriod: "1899M01" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Could not place these period bounds/);
  });

  it("keys the cache so the same slice asked two ways is fetched once", async () => {
    const { client, calls } = await harness();

    await call(client, "gss_get_data", { table: "fuel", periods: ["2024M05", "2024M06"] });
    const afterFirst = calls.length;
    // Same two periods, reversed and differently spelled.
    await call(client, "gss_get_data", { table: "fuel", periods: ["2024M6", "2024-05"] });

    expect(calls.length).toBe(afterFirst);
  });

  it("reports an unknown table without a network call", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "gss_get_data", { table: "nope" });

    expect(result.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("surfaces an upstream failure as a tool error", async () => {
    // 503 is retryable and the client is configured for one retry, so both attempts
    // have to fail for the error to reach the caller.
    const { client } = await harness({
      dataResponses: [() => errorResponse(503), () => errorResponse(503)],
    });
    const result = await call(client, "gss_get_data", { table: "fuel", latest: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/503/);
  });

  // StatsBank answers an invalid query with 404 and an IIS HTML page. Even though the
  // tools validate first, a shape change upstream could still produce one, and it must
  // read as a parse failure rather than an unhandled crash.
  it("reports an HTML error page as a parse failure", async () => {
    const { client } = await harness({
      dataResponses: [
        () =>
          new Response("<!DOCTYPE html><title>404 - File or directory not found.</title>", {
            status: 200,
            headers: { "content-type": "text/html" },
          }),
      ],
    });
    const result = await call(client, "gss_get_data", { table: "fuel", latest: 1 });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/did not return JSON/);
  });

  it("says so plainly when a valid query simply has no published data", async () => {
    const { client } = await harness({
      dataResponses: [
        () =>
          jsonResponse({
            columns: [
              { code: "Month", text: "Month", type: "t" },
              { code: "Fuel", text: "Fuel", type: "d" },
              { code: "Fuel Consumption", text: "Fuel Consumption", type: "c" },
            ],
            data: [],
            metadata: [{ source: "NPA" }],
          }),
      ],
    });
    const payload = (await call(client, "gss_get_data", { table: "fuel", latest: 1 }))
      .structuredContent as unknown as DataPayload;

    expect(payload.result.rowCount).toBe(0);
    expect(payload.meta.warning).toMatch(/GSS simply publishes nothing here/);
  });

  it("rejects a latest above the per-call ceiling", async () => {
    const { client } = await harness();
    const result = await call(client, "gss_get_data", { table: "fuel", latest: 5000 });

    expect(result.isError).toBe(true);
  });
});
