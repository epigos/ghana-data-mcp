import { describe, expect, it } from "vitest";

import { GseClient, PAGES, TABLE_IDS } from "../../src/sources/gse/client.js";
import { fetchCompanyDirectory } from "../../src/sources/gse/companies.js";
import {
  parseFixedIncomeIssuersPayload,
  parseHistoryPayload,
  parseMarketIndexPayload,
} from "../../src/sources/gse/parser.js";
import { rankStocks, summarizeWindow } from "../../src/sources/gse/ranking.js";

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

  it("returns parseable market-index history", async () => {
    const { rows } = parseMarketIndexPayload(await client.fetchMarketIndex({ days: 30 }));

    expect(rows.length).toBeGreaterThan(0);

    const latest = rows.at(-1)!;
    expect(latest.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(latest.compositeIndex).toBeGreaterThan(0);
    // Market cap is published in millions of cedis; a value below 1,000 would
    // mean the unit changed and every downstream number is off by 10^6.
    expect(latest.marketCapGhsMillion).toBeGreaterThan(1_000);
    expect(rows.map((row) => row.date)).toEqual([...rows.map((row) => row.date)].sort());
  }, 45_000);

  it("returns parseable GFIM corporate issuers", async () => {
    const { issuers } = parseFixedIncomeIssuersPayload(await client.fetchFixedIncomeIssuers());

    expect(issuers.length).toBeGreaterThan(5);
    for (const issuer of issuers) expect(issuer.name).not.toBe("");

    // ESLA Plc is the largest GFIM programme and has been listed since 2017; if
    // it is missing, the scrape is broken rather than the market having moved.
    const esla = issuers.find((issuer) => issuer.name.includes("ESLA"));
    expect(esla?.amountRaisedGhsMillion).toBeGreaterThan(0);
  }, 45_000);

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

  /**
   * The premise the whole ranking tool rests on: one unfiltered query on table 39
   * returns the entire exchange. If GSE ever starts paging this or filtering it
   * server-side, gse_rank_stocks silently starts ranking a subset — so this asserts
   * the row count matches what upstream says matched, not just that rows arrived.
   */
  it("still returns every listed security from one unfiltered price query", async () => {
    const payload = (await client.fetchMarketHistory({ days: 30 })) as {
      data: unknown[];
      recordsFiltered: string;
    };
    const { rows } = parseHistoryPayload(payload);
    const summary = summarizeWindow(rows);

    expect(payload.data.length).toBe(Number(payload.recordsFiltered)); // not truncated
    expect(summary.symbols.length).toBeGreaterThan(30);
    expect(summary.sessions).toBeGreaterThan(10);
  }, 60_000);

  /**
   * The assumption behind excluding untraded securities by default. If this ever
   * fails, GSE changed how it publishes dormant securities and the default needs
   * revisiting — which is exactly what a canary is for.
   */
  it("still publishes rows for securities that did not trade", async () => {
    const { rows } = parseHistoryPayload(await client.fetchMarketHistory({ days: 30 }));
    const summary = summarizeWindow(rows);

    const dormant = summary.symbols.filter((entry) => entry.tradingDays === 0);
    expect(dormant.length).toBeGreaterThan(0);
    expect(dormant.every((entry) => entry.totalVolume === 0)).toBe(true);

    // And the default filter really removes them.
    const ranked = rankStocks(summary, {
      metric: "percentReturn",
      order: "desc",
      limit: 50,
      minTradingDays: 1,
    });
    expect(ranked.rankings.every((entry) => entry.tradingDays > 0)).toBe(true);
    expect(ranked.excluded.some((entry) => entry.reason === "untraded")).toBe(true);
  }, 60_000);

  it("still populates the turnover column this source now reads", async () => {
    const { rows } = parseHistoryPayload(await client.fetchMarketHistory({ days: 7 }));
    const traded = rows.filter((row) => row.volume > 0);

    expect(traded.length).toBeGreaterThan(0);
    expect(traded.some((row) => typeof row.valueTraded === "number" && row.valueTraded > 0)).toBe(true);
  }, 60_000);
});
