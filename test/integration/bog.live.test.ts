import { describe, expect, it } from "vitest";

import { request, USER_AGENT } from "../../src/lib/http.js";
import { BOG_BASE_URL, BOG_PAGES, BogClient } from "../../src/sources/bog/client.js";
import {
  parseBillRatePayload,
  parseInterbankFxPayload,
} from "../../src/sources/bog/parser.js";

/**
 * Live canary for the Bank of Ghana source.
 *
 * These protect the mapping in client.ts (five dataset URLs) and the three
 * implemented datasets: interbank FX — including the evidence that its table is
 * restricted to a single date, which is why that tool takes no date range — and the
 * two bill-rate series, including that the upstream date filter really does bound
 * what comes back.
 *
 * ## Why this has its own env var instead of riding on GSE_LIVE
 *
 * www.bog.gov.gh serves only its leaf certificate and omits the DigiCert
 * intermediate, so a client that does not chase the missing issuer rejects the
 * chain. Node reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE` unless the intermediate is
 * supplied, which is a per-machine setup step rather than something the repo can
 * carry. Running these on the twice-weekly canary would leave it permanently red
 * over a defect on BoG's server, so they are opt-in:
 *
 *   NODE_EXTRA_CA_CERTS=/path/to/bog-intermediate.pem npm run test:live:bog
 *
 * Once BoG serves a complete chain, this can be folded back into GSE_LIVE and the
 * canary. See docs/BOG.md for the full diagnosis.
 */
const live = process.env.BOG_LIVE === "1";

describe.skipIf(!live)("bog.gov.gh (live)", () => {
  it.each(Object.entries(BOG_PAGES))("%s page is still published", async (_name, path) => {
    const response = await request(
      `${BOG_BASE_URL}${path}`,
      { headers: { accept: "text/html" } },
      { timeoutMs: 30_000, retries: 1, label: `GET ${path}` },
    );

    expect(response.status).toBe(200);
    expect((await response.text()).length).toBeGreaterThan(1000);
  }, 45_000);

  it("still returns parseable interbank FX rates", async () => {
    const client = new BogClient({ timeoutMs: 30_000, retries: 1 });
    const { rows, skipped } = parseInterbankFxPayload(await client.fetchInterbankFxRates());

    expect(skipped).toBe(0);
    expect(rows.length).toBeGreaterThan(10);

    const usd = rows.find((row) => row.code === "USD");
    expect(usd?.currency).toMatch(/dollar/i);
    expect(usd?.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // A sanity band, not a forecast: if USD/GHS leaves this range the parser is
    // far more likely wrong than the cedi.
    expect(usd?.mid).toBeGreaterThan(1);
    expect(usd?.mid).toBeLessThan(1000);
    expect(usd?.bid).toBeLessThanOrEqual(usd?.offer ?? 0);
  }, 60_000);

  // The tool takes no date range because the table refuses to give one. If BoG
  // ever lifts that, this fails and the tool can grow a `days` input.
  it("still restricts the FX table to a single date", async () => {
    const client = new BogClient({ timeoutMs: 30_000, retries: 1 });
    const payload = (await client.fetchInterbankFxRates()) as {
      recordsTotal?: unknown;
      recordsFiltered?: unknown;
      data: unknown[][];
    };

    expect(Number(payload.recordsFiltered)).toBe(payload.data.length);
    expect(Number(payload.recordsTotal)).toBeGreaterThan(Number(payload.recordsFiltered));
    expect(new Set(payload.data.map((row) => row[0])).size).toBe(1);
  }, 60_000);

  it("still returns parseable Treasury bill rates for a date window", async () => {
    const client = new BogClient({ timeoutMs: 30_000, retries: 1 });
    const { rows, skipped } = parseBillRatePayload(await client.fetchTreasuryBillRates(120));

    expect(skipped).toBe(0);
    expect(rows.length).toBeGreaterThan(5);

    // The date filter is the point of this test: everything must fall in the window.
    const oldest = new Date(Date.now() - 130 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    for (const row of rows) expect(row.date >= oldest, `${row.date} outside window`).toBe(true);

    const bill = rows.find((row) => row.tenorDays === 91);
    expect(bill?.securityType).toBe("91 DAY BILL");
    // A sanity band, not a forecast: Ghanaian T-bill yields have run 5-40% for
    // years, so anything outside it means the parser, not the market.
    expect(bill?.interestRate).toBeGreaterThan(0);
    expect(bill?.interestRate).toBeLessThan(100);
  }, 60_000);

  it("still returns parseable Bank of Ghana bill rates", async () => {
    const client = new BogClient({ timeoutMs: 30_000, retries: 1 });
    // BoG's own issuance is intermittent, so this needs a wide window to be sure
    // of finding anything at all.
    const { rows, skipped } = parseBillRatePayload(await client.fetchCentralBankBillRates(730));

    expect(skipped).toBe(0);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.interestRate).toBeGreaterThan(0);
  }, 60_000);

  it("serves bog.gov.gh to our identifying User-Agent", async () => {
    const response = await request(
      `${BOG_BASE_URL}${BOG_PAGES.treasuryBillRates}`,
      {},
      { timeoutMs: 30_000, retries: 1 },
    );

    // Worth pinning: if BoG starts refusing the honest UA, that is a decision to
    // make deliberately rather than by quietly pretending to be a browser.
    expect(response.status).toBe(200);
    expect(USER_AGENT).toContain("ghana-data-mcp");
  }, 45_000);
});
