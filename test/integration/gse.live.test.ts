import { describe, expect, it } from "vitest";

import { GseClient, PAGES, TABLE_IDS } from "../../src/sources/gse/client.js";
import { fetchCompanyDirectory } from "../../src/sources/gse/companies.js";
import { parseHistoryPayload } from "../../src/sources/gse/parser.js";

/**
 * Live smoke test against gse.com.gh — the canary for upstream markup changes
 * (plan §11). Skipped by default so CI never depends on a third-party site:
 *
 *   npm run test:live
 */
const live = process.env.GSE_LIVE === "1";

describe.skipIf(!live)("gse.com.gh (live)", () => {
  const client = new GseClient({ timeoutMs: 30_000, retries: 1 });

  it("still hands out a cookie and a nonce for the price table", async () => {
    const session = await client.createSession(PAGES.tradingAndData, [TABLE_IDS.dailyPrices]);

    expect(session.nonces[TABLE_IDS.dailyPrices]).toMatch(/^[a-f0-9]{8,}$/i);
    expect(session.cookie).not.toBe("");
  }, 45_000);

  it("still carries all three company tables on the listed-companies page", async () => {
    const session = await client.createSession(PAGES.listedCompanies, [
      TABLE_IDS.mainMarket,
      TABLE_IDS.gax,
      TABLE_IDS.etf,
    ]);

    for (const tableId of [TABLE_IDS.mainMarket, TABLE_IDS.gax, TABLE_IDS.etf]) {
      expect(session.nonces[tableId], `no nonce for table ${tableId}`).toMatch(/^[a-f0-9]{8,}$/i);
    }
  }, 45_000);

  it("returns a company directory covering every market", async () => {
    const { companies, failedMarkets } = await fetchCompanyDirectory(client);

    expect(failedMarkets).toEqual([]);
    expect(companies.length).toBeGreaterThan(30);

    const markets = new Set(companies.map((company) => company.market));
    expect(markets).toEqual(new Set(["main", "gax", "etf"]));

    // MTNGH is the most liquid listing on the exchange; if it is missing, the
    // scrape is broken rather than the market having changed.
    const mtn = companies.find((company) => company.symbol === "MTNGH");
    expect(mtn?.name).toMatch(/MTN/i);
    expect(mtn?.market).toBe("main");
  }, 60_000);

  it("keeps the 7-column layout the company parser assumes", async () => {
    const results = await client.fetchCompanyTables();

    for (const result of results) {
      const payload = result.payload as { data: unknown[][] } | undefined;
      expect(payload, `${result.market} table failed`).toBeDefined();
      for (const row of payload!.data) expect(row).toHaveLength(7);
    }
  }, 60_000);

  it("returns parseable price history for a liquid symbol", async () => {
    const payload = await client.fetchStockHistory({ symbol: "MTNGH", days: 30 });
    const { rows } = parseHistoryPayload(payload, { symbol: "MTNGH" });

    expect(rows.length).toBeGreaterThan(0);

    const latest = rows.at(-1)!;
    expect(latest.symbol).toBe("MTNGH");
    expect(latest.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(latest.close).toBeGreaterThan(0);
    expect(latest.volume).toBeGreaterThanOrEqual(0);
    // Ascending, oldest first.
    expect(rows.map((row) => row.date)).toEqual([...rows.map((row) => row.date)].sort());
  }, 45_000);

  it("keeps the 14-column layout the parser depends on", async () => {
    const payload = (await client.fetchStockHistory({ symbol: "GCB", days: 14 })) as {
      data: unknown[][];
    };

    expect(Array.isArray(payload.data)).toBe(true);
    for (const row of payload.data) expect(row).toHaveLength(14);
  }, 45_000);
});
