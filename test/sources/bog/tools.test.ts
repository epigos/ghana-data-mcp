import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";

import { createCache, createMemoryKV, type Cache } from "../../../src/lib/cache.js";
import { BOG_PAGES, BogClient } from "../../../src/sources/bog/client.js";
import {
  BillRateSchema,
  InterbankFxRateSchema,
  InterestRatePointSchema,
} from "../../../src/sources/bog/types.js";
import { BOG_TOOL_NAMES, registerBogTools } from "../../../src/sources/bog/tools.js";
import { fixture, fixtureJson } from "../../helpers/fixtures.js";
import { errorResponse, htmlResponse, jsonResponse, stubFetch } from "../../helpers/stubFetch.js";

const fxPageHtml = fixture("bog-interbank-fx.trimmed.html");
const fxPayload = fixtureJson("bog-interbank-fx.json");
const fxHistoryPageHtml = fixture("bog-historical-fx.trimmed.html");
const fxHistoryPayload = fixtureJson("bog-historical-fx-usd.json");
const interbankPageHtml = fixture("bog-interbank-interest.trimmed.html");
const dailyPayload = fixtureJson("bog-interbank-daily.json");
const weeklyPayload = fixtureJson("bog-interbank-weekly.json");
const repoPayload = fixtureJson("bog-interbank-reverse-repo.json");
const depoPayload = fixtureJson("bog-interbank-depo.json");
const tbillPageHtml = fixture("bog-treasury-bill-rates.trimmed.html");
const tbillPayload = fixtureJson("bog-treasury-bill-rates.json");
const bogBillPageHtml = fixture("bog-central-bank-bill-rates.trimmed.html");
const bogBillPayload = fixtureJson("bog-central-bank-bill-rates.json");

interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
}

/**
 * Registration-only harness: the fetch stub has no routes, so this is for inspecting
 * the tool list rather than calling anything.
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
    // The historical page must match before the daily one: both contain
    // "interbank-fx-rates".
    {
      match: "/historical-interbank-fx-rates/",
      responses: [() => htmlResponse(fxHistoryPageHtml, [])],
    },
    { match: "/daily-interbank-fx-rates/", responses: [() => htmlResponse(fxPageHtml, [])] },
    {
      match: "table_id=31",
      responses: options.tableResponses ?? [() => jsonResponse(fxPayload)],
    },
    { match: "table_id=40", responses: [() => jsonResponse(fxHistoryPayload)] },
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

/** Harness with the bill-rate routes wired. */
async function billHarness(options: { tableResponses?: Array<() => Response> } = {}) {
  const { fetch: fetchImpl, calls } = stubFetch([
    { match: "/treasury-bill-rates/", responses: [() => htmlResponse(tbillPageHtml, [])] },
    { match: "/bank-of-ghana-bill-rates/", responses: [() => htmlResponse(bogBillPageHtml, [])] },
    { match: "table_id=2", responses: options.tableResponses ?? [() => jsonResponse(tbillPayload)] },
    { match: "table_id=3", responses: [() => jsonResponse(bogBillPayload)] },
  ]);

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

const call = (client: Client, name: string, args: Record<string, unknown> = {}) =>
  client.callTool({ name, arguments: args }) as Promise<ToolResult>;

describe("BoG tool registration", () => {
  it("registers one tool per published dataset", async () => {
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "bog_get_central_bank_bill_rates",
      "bog_get_interbank_fx_rates",
      "bog_get_interbank_interest_rates",
      "bog_get_treasury_bill_rates",
    ]);
    // Not one tool per page: the FX tool spans two, the latest-day snapshot and the
    // historical series.
    expect(Object.keys(BOG_PAGES)).toContain("historicalInterbankFxRates");
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
  it("declares an input and output schema for every tool", async () => {
    const { client } = await harness();
    for (const tool of (await client.listTools()).tools) {
      expect(tool.inputSchema, tool.name).toBeDefined();
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });
});

interface FxPayload {
  date: string;
  rateCount: number;
  rates: Array<{ date: string; currency: string; code: string; pair: string; bid: number; offer: number; mid: number }>;
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

interface BillPayload {
  days: number;
  rowCount: number;
  rows: Array<{
    date: string;
    tenderNumber: string;
    securityType: string;
    tenorDays?: number;
    discountRate: number;
    interestRate: number;
  }>;
  meta: { origin: string; warning?: string };
}

describe("bog_get_treasury_bill_rates", () => {
  it("returns rows matching the published schema", async () => {
    const { client } = await billHarness();
    const result = await call(client, "bog_get_treasury_bill_rates");
    const payload = result.structuredContent as unknown as BillPayload;

    expect(result.isError).toBeFalsy();
    expect(payload.meta.origin).toBe("live");
    expect(payload.days).toBe(90);
    expect(payload.rowCount).toBe(payload.rows.length);
    expect(payload.rowCount).toBe(36);
    for (const row of payload.rows) expect(() => BillRateSchema.parse(row)).not.toThrow();
  });

  it("reads the columns the bill table uses", async () => {
    const { client } = await billHarness();
    const payload = (await call(client, "bog_get_treasury_bill_rates"))
      .structuredContent as unknown as BillPayload;

    // Fixture row: ['20 Jul 2026','2016','364 DAY BILL','11.5008','12.9954']
    expect(payload.rows.at(-1)).toEqual({
      date: "2026-07-20",
      tenderNumber: "2016",
      securityType: "91 DAY BILL",
      tenorDays: 91,
      discountRate: 5.702,
      interestRate: 5.7845,
    });
  });

  it("returns rows oldest first", async () => {
    const { client } = await billHarness();
    const dates = (
      (await call(client, "bog_get_treasury_bill_rates")).structuredContent as unknown as BillPayload
    ).rows.map((row) => row.date);

    expect(dates).toEqual([...dates].sort());
  });

  // The upstream security-type search matches whole values exactly, so filtering
  // in memory is what lets "91" work as well as "91 DAY BILL".
  it("filters leniently by security type", async () => {
    const { client } = await billHarness();

    for (const query of ["91", "91 DAY", "91 DAY BILL", "91 day bill"]) {
      const payload = (await call(client, "bog_get_treasury_bill_rates", { securityType: query }))
        .structuredContent as unknown as BillPayload;

      expect(payload.rowCount, query).toBeGreaterThan(0);
      expect(
        payload.rows.every((row) => row.securityType === "91 DAY BILL"),
        query,
      ).toBe(true);
    }
  });

  it("lists what is available when the requested security is not there", async () => {
    const { client } = await billHarness();
    const payload = (await call(client, "bog_get_treasury_bill_rates", { securityType: "5 YR" }))
      .structuredContent as unknown as BillPayload;

    expect(payload.rowCount).toBe(0);
    expect(payload.meta.warning).toMatch(/Available: 182 DAY BILL, 364 DAY BILL, 91 DAY BILL/);
  });

  it("serves a type-filtered query from the same cache entry", async () => {
    const { client, calls } = await billHarness();

    await call(client, "bog_get_treasury_bill_rates");
    const afterFirst = calls.length;
    const second = await call(client, "bog_get_treasury_bill_rates", { securityType: "364" });

    expect(calls.length).toBe(afterFirst);
    expect((second.structuredContent as unknown as BillPayload).meta.origin).toBe("cache");
  });

  it("sends a BoG-formatted date range upstream", async () => {
    const { client, calls } = await billHarness();
    await call(client, "bog_get_treasury_bill_rates", { days: 90 });

    const form = Object.fromEntries(new URLSearchParams(calls[1]?.body ?? ""));
    expect(form["columns[0][search][value]"]).toMatch(
      /^\d{2} [A-Z][a-z]{2} \d{4}\|\d{2} [A-Z][a-z]{2} \d{4}$/,
    );
    expect(form["sRangeSeparator"]).toBe("|");
    // These tables declare ordered columns, unlike the FX one.
    expect(form["columns[0][orderable]"]).toBe("true");
  });

  it("reports an upstream failure as a tool error", async () => {
    const { client } = await billHarness({ tableResponses: [() => errorResponse(503)] });
    const result = await call(client, "bog_get_treasury_bill_rates");

    expect(result.isError).toBe(true);
  });
});

describe("bog_get_central_bank_bill_rates", () => {
  // The two series must not be confused: these are BoG's own issuance at much
  // shorter tenors, and a caller asking for one should never get the other.
  it("returns the central bank's own series, not the Treasury one", async () => {
    const { client } = await billHarness();
    const payload = (await call(client, "bog_get_central_bank_bill_rates"))
      .structuredContent as unknown as BillPayload;

    expect(payload.rowCount).toBe(5);
    expect(payload.rows.every((row) => row.securityType === "14 DAY BILL")).toBe(true);
    expect(payload.rows[0]?.tenorDays).toBe(14);
  });

  it("queries its own table, on its own page", async () => {
    const { client, calls } = await billHarness();
    await call(client, "bog_get_central_bank_bill_rates");

    expect(calls[0]?.url).toContain("/bank-of-ghana-bill-rates/");
    expect(calls[1]?.url).toContain("table_id=3");
  });

  it("caches separately from the Treasury series", async () => {
    const { client } = await billHarness();

    const treasury = (await call(client, "bog_get_treasury_bill_rates"))
      .structuredContent as unknown as BillPayload;
    const central = (await call(client, "bog_get_central_bank_bill_rates"))
      .structuredContent as unknown as BillPayload;

    expect(treasury.rowCount).not.toBe(central.rowCount);
    expect(central.meta.origin).toBe("live");
  });
});

describe("bog_get_interbank_fx_rates history", () => {
  // Table 31 is pinned to the latest publication; table 40 holds the series. The
  // presence of `days` is what chooses between them.
  it("uses the snapshot table when no window is given", async () => {
    const { client, calls } = await fxHarness();
    await call(client, "bog_get_interbank_fx_rates");

    expect(calls[0]?.url).toContain("/daily-interbank-fx-rates/");
    expect(calls[1]?.url).toContain("table_id=31");
  });

  it("uses the historical table when a window is given", async () => {
    const { client, calls } = await fxHarness();
    const result = await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "USD" });

    expect(result.isError).toBeFalsy();
    expect(calls[0]?.url).toContain("/historical-interbank-fx-rates/");
    expect(calls[1]?.url).toContain("table_id=40");
  });

  it("returns a dated series, oldest first", async () => {
    const { client } = await fxHarness();
    const payload = (await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "USD" }))
      .structuredContent as unknown as FxPayload;

    expect(payload.rateCount).toBe(17);
    const dates = payload.rates.map((rate) => rate.date);
    expect(new Set(dates).size).toBeGreaterThan(1);
    // Oldest first, like every other series tool here.
    expect(dates).toEqual([...dates].sort());
    // `date` reports the NEWEST row, which is the last one.
    expect(payload.date).toBe([...dates].sort().at(-1));
    expect(payload.date).toBe("2026-07-24");
  });

  it("sends a BoG-formatted date range and an exact pair upstream", async () => {
    const { client, calls } = await fxHarness();
    await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "usd" });

    const form = Object.fromEntries(new URLSearchParams(calls[1]?.body ?? ""));
    expect(form["columns[0][search][value]"]).toMatch(
      /^\d{2} [A-Z][a-z]{2} \d{4}\|\d{2} [A-Z][a-z]{2} \d{4}$/,
    );
    // Resolved from "usd" — the upstream filter matches whole values only, so the
    // bare code would silently return nothing.
    expect(form["columns[2][search][value]"]).toBe("USDGHS");
  });

  // A currency *name* cannot be resolved to a pair without the published list, so
  // the window comes back unfiltered and is narrowed here instead.
  it("does not push an unresolvable currency name upstream", async () => {
    const { client, calls } = await fxHarness();
    await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "US Dollar" });

    const form = Object.fromEntries(new URLSearchParams(calls[1]?.body ?? ""));
    expect(form["columns[2][search][value]"]).toBe("");
  });

  it("caches history separately per window and pair", async () => {
    const { client, calls } = await fxHarness();

    await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "USD" });
    const afterFirst = calls.length;

    // Same window and pair: cached.
    await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "USD" });
    expect(calls.length).toBe(afterFirst);

    // Different window: fetched.
    await call(client, "bog_get_interbank_fx_rates", { days: 60, currency: "USD" });
    expect(calls.length).toBeGreaterThan(afterFirst);
  });

  it("does not let a history result serve a snapshot query", async () => {
    const { client } = await fxHarness();

    const history = (await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "USD" }))
      .structuredContent as unknown as FxPayload;
    const snapshot = (await call(client, "bog_get_interbank_fx_rates"))
      .structuredContent as unknown as FxPayload;

    expect(history.rateCount).toBe(17);
    expect(snapshot.rateCount).toBe(19);
  });

  it("rejects a window beyond the supported range", async () => {
    const { client } = await fxHarness();
    expect(
      (await call(client, "bog_get_interbank_fx_rates", { days: 99_999 })).isError,
    ).toBe(true);
  });
});

describe("cedi redenomination", () => {
  // A 20-year window mixes old and new cedis: USD/GHS reads ~9166 in 2006 and ~11.6
  // today. Unflagged, that looks like a currency collapse rather than a
  // redenomination, so the tool detects it instead of trusting the reader to know.
  it("warns when the window crosses 1 July 2007", async () => {
    const oldRow = ["31 Jul 2006", "US Dollar", "USDGHS", "9166.00", "9166.36", "9166.18"];
    const newRow = ["24 Jul 2026", "US Dollar", "USDGHS", "11.6292", "11.6408", "11.6350"];

    const { fetch: fetchImpl } = stubFetch([
      {
        match: "/historical-interbank-fx-rates/",
        responses: [() => htmlResponse(fxHistoryPageHtml, [])],
      },
      { match: "table_id=40", responses: [() => jsonResponse({ data: [newRow, oldRow] })] },
    ]);

    const server = new McpServer({ name: "test", version: "0.0.0" });
    registerBogTools(server, {
      client: new BogClient({ fetchImpl, baseDelayMs: 0, retries: 0 }),
      cache: createCache(createMemoryKV()),
    });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await Promise.all([client.connect(ct), server.connect(st)]);

    const payload = (await call(client, "bog_get_interbank_fx_rates", { days: 7300, currency: "USD" }))
      .structuredContent as unknown as FxPayload;

    expect(payload.rateCount).toBe(2);
    expect(payload.meta.warning).toMatch(/OLD cedis/);
    expect(payload.meta.warning).toMatch(/2007-07-01/);
  });

  it("does not warn for a window entirely after the redenomination", async () => {
    const { client } = await fxHarness();
    const payload = (await call(client, "bog_get_interbank_fx_rates", { days: 30, currency: "USD" }))
      .structuredContent as unknown as FxPayload;

    expect(payload.meta.warning ?? "").not.toMatch(/OLD cedis/);
  });
});

interface RatePayload {
  series: string;
  seriesLabel: string;
  days: number;
  rowCount: number;
  rows: Array<{ date: string; rate: number }>;
  meta: { origin: string; warning?: string; skippedRows?: number };
}

/** Harness with all four interbank series wired. */
async function interbankHarness() {
  const { fetch: fetchImpl, calls } = stubFetch([
    { match: "/interbank-interest-rates/", responses: [() => htmlResponse(interbankPageHtml, [])] },
    { match: "table_id=69", responses: [() => jsonResponse(dailyPayload)] },
    { match: "table_id=70", responses: [() => jsonResponse(weeklyPayload)] },
    { match: "table_id=62", responses: [() => jsonResponse(repoPayload)] },
    { match: "table_id=63", responses: [() => jsonResponse(depoPayload)] },
  ]);

  const server = new McpServer({ name: "test", version: "0.0.0" });
  registerBogTools(server, {
    client: new BogClient({ fetchImpl, baseDelayMs: 0, retries: 0 }),
    cache: createCache(createMemoryKV()),
  });
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(ct), server.connect(st)]);
  return { client, calls };
}

describe("bog_get_interbank_interest_rates", () => {
  it("defaults to the daily series", async () => {
    const { client, calls } = await interbankHarness();
    const result = await call(client, "bog_get_interbank_interest_rates", { days: 7300 });
    const payload = result.structuredContent as unknown as RatePayload;

    expect(result.isError).toBeFalsy();
    expect(payload.series).toBe("daily");
    expect(payload.seriesLabel).toBe("Daily Interest Rates");
    expect(calls[1]?.url).toContain("table_id=69");
    for (const row of payload.rows) expect(() => InterestRatePointSchema.parse(row)).not.toThrow();
  });

  // The mapping was confirmed from DOM containment; these pin it so a future edit
  // cannot quietly swap which table answers which series.
  it.each([
    ["daily", 69, "Daily Interest Rates"],
    ["weekly", 70, "Weekly Interest Rates"],
    ["reverse-repo", 62, "Reverse Repo Rates"],
    ["depo", 63, "Depo Rates"],
  ] as const)("maps %s to table %i", async (series, tableId, label) => {
    const { client, calls } = await interbankHarness();
    const payload = (await call(client, "bog_get_interbank_interest_rates", { series, days: 7300 }))
      .structuredContent as unknown as RatePayload;

    expect(calls[1]?.url).toContain(`table_id=${tableId}`);
    expect(payload.seriesLabel).toBe(label);
  });

  // Reverse repo sits above depo, straddling the policy rate. If the two ever came
  // back the same way round, the mapping has broken.
  it("keeps reverse repo above depo", async () => {
    const { client } = await interbankHarness();
    const repo = (await call(client, "bog_get_interbank_interest_rates", { series: "reverse-repo", days: 7300 }))
      .structuredContent as unknown as RatePayload;
    const depo = (await call(client, "bog_get_interbank_interest_rates", { series: "depo", days: 7300 }))
      .structuredContent as unknown as RatePayload;

    expect(repo.rows.at(-1)!.rate).toBeGreaterThan(depo.rows.at(-1)!.rate);
  });

  it("returns points oldest first", async () => {
    const { client } = await interbankHarness();
    const dates = (
      (await call(client, "bog_get_interbank_interest_rates", { days: 7300 }))
        .structuredContent as unknown as RatePayload
    ).rows.map((row) => row.date);

    expect(dates).toEqual([...dates].sort());
  });

  // These tables reject a date-range search, so the window is applied in memory —
  // which means one cache entry per series answers every window.
  it("applies the window in memory, from a single cached fetch", async () => {
    const { client, calls } = await interbankHarness();

    const wide = (await call(client, "bog_get_interbank_interest_rates", { days: 7300 }))
      .structuredContent as unknown as RatePayload;
    const afterFirst = calls.length;
    const narrow = (await call(client, "bog_get_interbank_interest_rates", { days: 7 }))
      .structuredContent as unknown as RatePayload;

    expect(calls.length).toBe(afterFirst);
    expect(narrow.meta.origin).toBe("cache");
    expect(narrow.rowCount).toBeLessThan(wide.rowCount);
  });

  it("sends no date range upstream", async () => {
    const { client, calls } = await interbankHarness();
    await call(client, "bog_get_interbank_interest_rates", { days: 30 });

    const form = Object.fromEntries(new URLSearchParams(calls[1]?.body ?? ""));
    expect(form["columns[1][search][value]"]).toBe("");
  });

  it("declares the column names the chosen table expects", async () => {
    const { client, calls } = await interbankHarness();
    await call(client, "bog_get_interbank_interest_rates", { series: "weekly", days: 30 });

    const form = Object.fromEntries(new URLSearchParams(calls[1]?.body ?? ""));
    // Each series is built over a different post type; wpDataTables rejects a query
    // whose column names do not match.
    expect(form["columns[1][name]"]).toBe("avg_interest_rate_meta_end_date");
    expect(form["columns[2][name]"]).toBe("avg_interest_rate_meta_rate");
  });

  // The MPC-derived series each carry a couple of rows with no effective date. That
  // is upstream data, not a parsing fault, so it is reported rather than hidden.
  it("counts undated rows as skipped without failing", async () => {
    const { client } = await interbankHarness();
    const payload = (await call(client, "bog_get_interbank_interest_rates", { series: "depo", days: 7300 }))
      .structuredContent as unknown as RatePayload;

    expect(payload.rowCount).toBeGreaterThan(0);
    expect(payload.meta.skippedRows).toBeGreaterThan(0);
  });

  it("explains an empty window by naming the span that does exist", async () => {
    const { client } = await interbankHarness();
    const payload = (await call(client, "bog_get_interbank_interest_rates", { series: "reverse-repo", days: 1 }))
      .structuredContent as unknown as RatePayload;

    if (payload.rowCount === 0) {
      expect(payload.meta.warning).toMatch(/The series runs \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
    }
  });

  it("rejects an unknown series", async () => {
    const { client } = await interbankHarness();
    expect(
      (await call(client, "bog_get_interbank_interest_rates", { series: "policy" })).isError,
    ).toBe(true);
  });
});
