import { describe, expect, it } from "vitest";

import { request, USER_AGENT } from "../../src/lib/http.js";
import { BOG_BASE_URL, BOG_PAGES, BOG_REST_COLLECTIONS } from "../../src/sources/bog/client.js";

/**
 * Live canary for the Bank of Ghana source.
 *
 * Nothing is implemented yet, so there is no parsing to verify. What these tests
 * protect is the mapping in client.ts: seven dataset URLs and the REST collections
 * that look like they back them.
 *
 * ## Why this has its own env var instead of riding on GSE_LIVE
 *
 * These tests currently **fail from Node**, and not because of anything in this
 * repo: www.bog.gov.gh serves only its leaf certificate and omits the DigiCert
 * intermediate, so any client that does not chase the missing issuer rejects the
 * chain. Node/undici reports `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; `curl` on macOS
 * succeeds only because the OS fills the gap.
 *
 * Running them on the twice-weekly canary would mean a permanently red workflow
 * reporting a defect on BoG's server that we cannot fix, which trains everyone to
 * ignore it. So they are opt-in:
 *
 *   BOG_LIVE=1 npm run test:live:bog
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

  it.each(Object.entries(BOG_REST_COLLECTIONS))(
    "%s REST collection still responds",
    async (_name, path) => {
      const response = await request(
        `${BOG_BASE_URL}${path}?per_page=1`,
        { headers: { accept: "application/json" } },
        { timeoutMs: 30_000, retries: 1, label: `GET ${path}` },
      );

      expect(response.status).toBe(200);
      // An array is what a WP collection returns; contents may legitimately be
      // empty (exchange_rates was, on 2026-07-25), so shape is all we assert.
      expect(Array.isArray(await response.json())).toBe(true);
    },
    45_000,
  );

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
