import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { createCache, createMemoryKV, type Cache } from "../../../src/lib/cache.js";
import { ImfClient } from "../../../src/sources/imf/client.js";
import { registerImfTools } from "../../../src/sources/imf/tools.js";
import { IndicatorMetaSchema, IndicatorSeriesSchema } from "../../../src/sources/imf/types.js";
import { fixtureJson } from "../../helpers/fixtures.js";
import { errorResponse, jsonResponse, stubFetch } from "../../helpers/stubFetch.js";

const indicatorsPayload = fixtureJson<{ indicators: Record<string, unknown> }>("imf-indicators.json");
const seriesPayload = fixtureJson("imf-series-headline.json");

interface Harness {
  client: Client;
  cache: Cache;
  calls: () => number;
}

async function harness(
  options: { seriesResponses?: Array<() => Response>; cache?: Cache } = {},
): Promise<Harness> {
  const { fetch: fetchImpl, calls } = stubFetch([
    // Order matters: stubFetch matches the first route whose substring is found,
    // so the specific "/indicators" catalog route must be listed before the broad
    // series fallback below — a multi-indicator call sorts its ids alphabetically,
    // so the series URL's shape (which id comes first) isn't something a test
    // should need to know.
    { match: "/api/v2/indicators", responses: [() => jsonResponse(indicatorsPayload)] },
    {
      match: "/api/v2/",
      responses: options.seriesResponses ?? [() => jsonResponse(seriesPayload)],
    },
  ]);

  const server = new McpServer({ name: "test", version: "0.0.0" });
  const cache = options.cache ?? createCache(createMemoryKV());
  registerImfTools(server, { client: new ImfClient({ fetchImpl, baseDelayMs: 0, retries: 1 }), cache });

  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);

  return { client, cache, calls: () => calls.length };
}

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe("tool registration", () => {
  it("registers the two namespaced tools", async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual(["imf_get_indicator_history", "imf_list_indicators"]);
    expect(names.every((n) => n.startsWith("imf_"))).toBe(true);
  });

  it("declares input and output schemas for both", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });
});

interface ListPayload {
  indicatorCount: number;
  indicators: Array<{ id: string; label: string; unit: string; dataset: string }>;
  meta: { origin: string; warning?: string };
}

describe("imf_list_indicators", () => {
  it("returns matches validating against the published schema", async () => {
    const { client } = await harness();
    const result = await call(client, "imf_list_indicators", { query: "gdp" });
    const payload = result.structuredContent as unknown as ListPayload;

    expect(result.isError).toBeFalsy();
    expect(payload.indicatorCount).toBe(payload.indicators.length);
    expect(payload.indicatorCount).toBeGreaterThan(0);
    for (const ind of payload.indicators) expect(() => IndicatorMetaSchema.parse(ind)).not.toThrow();
  });

  it("ranks an exact id match first", async () => {
    const { client } = await harness();
    const payload = (await call(client, "imf_list_indicators", { query: "NGDP_RPCH" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.indicators[0]?.id).toBe("NGDP_RPCH");
  });

  it("finds an indicator by a keyword in its label", async () => {
    const { client } = await harness();
    const payload = (await call(client, "imf_list_indicators", { query: "inflation" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.indicators.map((i) => i.id)).toContain("PCPIPCH");
  });

  it("also matches on dataset code", async () => {
    const { client } = await harness();
    const payload = (await call(client, "imf_list_indicators", { query: "WEO" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.indicators.length).toBeGreaterThan(5);
    expect(payload.indicators.every((i) => i.dataset === "WEO")).toBe(true);
  });

  it("lists everything, sorted by id, when no query is given", async () => {
    const { client } = await harness();
    const payload = (await call(client, "imf_list_indicators", {}))
      .structuredContent as unknown as ListPayload;
    const ids = payload.indicators.map((i) => i.id);

    expect(ids).toEqual([...ids].sort((a, b) => a.localeCompare(b)));
  });

  it("respects the limit", async () => {
    const { client } = await harness();
    const payload = (await call(client, "imf_list_indicators", { limit: 3 }))
      .structuredContent as unknown as ListPayload;

    expect(payload.indicators).toHaveLength(3);
  });

  it("explains an unmatched query rather than returning a bare empty list", async () => {
    const { client } = await harness();
    const payload = (await call(client, "imf_list_indicators", { query: "zzzznotarealterm" }))
      .structuredContent as unknown as ListPayload;

    expect(payload.indicators).toEqual([]);
    expect(payload.meta.warning).toMatch(/No indicator matched/);
  });

  it("caches the catalog across calls", async () => {
    const { client, calls } = await harness();

    await call(client, "imf_list_indicators", { query: "gdp" });
    const afterFirst = calls();
    await call(client, "imf_list_indicators", { query: "inflation" });

    expect(calls()).toBe(afterFirst); // second query reused the cached catalog
  });
});

interface HistoryPayload {
  series: Array<{
    id: string;
    label: string;
    unit: string;
    projectionStartYear?: number;
    rowCount: number;
    rows: Array<{ year: number; value: number; isProjection: boolean }>;
  }>;
  meta: { origin: string; warning?: string; skippedRows?: number };
}

describe("imf_get_indicator_history", () => {
  it("returns a series matching the published schema", async () => {
    const { client } = await harness();
    const result = await call(client, "imf_get_indicator_history", { indicators: ["NGDP_RPCH"] });
    const payload = result.structuredContent as unknown as HistoryPayload;

    expect(result.isError).toBeFalsy();
    expect(payload.meta.origin).toBe("live");
    expect(payload.series).toHaveLength(1);
    expect(() => IndicatorSeriesSchema.parse(payload.series[0])).not.toThrow();
  });

  it("resolves an indicator id case-insensitively", async () => {
    const { client } = await harness();
    const payload = (
      await call(client, "imf_get_indicator_history", { indicators: ["ngdp_rpch"] })
    ).structuredContent as unknown as HistoryPayload;

    expect(payload.series[0]?.id).toBe("NGDP_RPCH");
    expect(payload.series[0]?.rowCount).toBeGreaterThan(0);
  });

  it("returns oldest-first rows, flagging projected years", async () => {
    const { client } = await harness();
    const payload = (
      await call(client, "imf_get_indicator_history", { indicators: ["NGDP_RPCH"] })
    ).structuredContent as unknown as HistoryPayload;
    const [series] = payload.series;
    const years = series!.rows.map((r) => r.year);

    expect(years).toEqual([...years].sort((a, b) => a - b));
    expect(series!.projectionStartYear).toBe(2026);
    expect(series!.rows.find((r) => r.year === 2025)?.isProjection).toBe(false);
    expect(series!.rows.find((r) => r.year === 2026)?.isProjection).toBe(true);
  });

  it("applies startYear and endYear after the cached fetch", async () => {
    const { client, calls } = await harness();

    await call(client, "imf_get_indicator_history", { indicators: ["NGDP_RPCH"] });
    const afterFirst = calls();
    const windowed = (
      await call(client, "imf_get_indicator_history", {
        indicators: ["NGDP_RPCH"],
        startYear: 2020,
        endYear: 2022,
      })
    ).structuredContent as unknown as HistoryPayload;

    // Same underlying series, so the windowed call must not re-fetch.
    expect(calls()).toBe(afterFirst);
    expect(windowed.series[0]?.rows.map((r) => r.year)).toEqual([2020, 2021, 2022]);
    expect(windowed.series[0]?.rowCount).toBe(3);
  });

  it("rejects startYear after endYear before any network call", async () => {
    const { client, calls } = await harness();
    const result = await call(client, "imf_get_indicator_history", {
      indicators: ["NGDP_RPCH"],
      startYear: 2025,
      endYear: 2020,
    });

    expect(result.isError).toBe(true);
    expect(calls()).toBe(0);
  });

  it("fetches several indicators in one request", async () => {
    const { client, calls } = await harness();
    const payload = (
      await call(client, "imf_get_indicator_history", {
        indicators: ["NGDP_RPCH", "PCPIPCH", "BCA_NGDPD"],
      })
    ).structuredContent as unknown as HistoryPayload;

    expect(payload.series.map((s) => s.id)).toEqual(["BCA_NGDPD", "NGDP_RPCH", "PCPIPCH"]);
    // One page GET (catalog) + one series POST/GET, not one per indicator.
    expect(calls()).toBe(2);
  });

  it("keys the cache by the sorted, deduped indicator set", async () => {
    const { client, calls } = await harness();

    await call(client, "imf_get_indicator_history", { indicators: ["PCPIPCH", "NGDP_RPCH"] });
    const afterFirst = calls();
    // Same two indicators, different order and a duplicate: same cache entry.
    await call(client, "imf_get_indicator_history", {
      indicators: ["NGDP_RPCH", "PCPIPCH", "ngdp_rpch"],
    });

    expect(calls()).toBe(afterFirst);
  });

  it("rejects every unrecognized id before making a series request", async () => {
    const { client, calls } = await harness();
    const beforeIndicatorFetch = calls();

    const result = await call(client, "imf_get_indicator_history", {
      indicators: ["NOT_A_REAL_CODE"],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/NOT_A_REAL_CODE/);
    expect(result.content[0]?.text).toMatch(/imf_list_indicators/);
    // Only the catalog lookup happened; no series request for an all-bad list.
    expect(calls()).toBe(beforeIndicatorFetch + 1);
  });

  it("proceeds with the recognized ids and warns about the rest", async () => {
    const { client } = await harness();
    const payload = (
      await call(client, "imf_get_indicator_history", {
        indicators: ["NGDP_RPCH", "NOT_A_REAL_CODE"],
      })
    ).structuredContent as unknown as HistoryPayload;

    expect(payload.series.map((s) => s.id)).toEqual(["NGDP_RPCH"]);
    expect(payload.meta.warning).toMatch(/NOT_A_REAL_CODE/);
  });

  it("reports a valid indicator's empty Ghana coverage without an error", async () => {
    const { client } = await harness({
      seriesResponses: [
        () => jsonResponse({ indicators: { NGDP_RPCH: indicatorsPayload.indicators.NGDP_RPCH }, values: { NGDP_RPCH: { USA: { "2020": 1 } } } }),
      ],
    });
    const payload = (
      await call(client, "imf_get_indicator_history", { indicators: ["NGDP_RPCH"] })
    ).structuredContent as unknown as HistoryPayload;

    expect(payload.series[0]?.rowCount).toBe(0);
    expect(payload.meta.warning).toMatch(/NGDP_RPCH has no published data for Ghana/);
  });

  it("rejects more than the maximum indicators per call", async () => {
    const { client } = await harness();
    const result = await call(client, "imf_get_indicator_history", {
      indicators: Array.from({ length: 9 }, (_, i) => `IND_${i}`),
    });

    expect(result.isError).toBe(true);
  });

  it("reports an upstream failure as a tool error", async () => {
    const { client } = await harness({ seriesResponses: [() => errorResponse(503)] });
    const result = await call(client, "imf_get_indicator_history", { indicators: ["NGDP_RPCH"] });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/503/);
  });
});
