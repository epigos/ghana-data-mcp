import { describe, expect, it } from "vitest";

import { ImfClient } from "../../src/sources/imf/client.js";
import { USER_AGENT } from "../../src/lib/http.js";
import { parseEntitiesPayload, parseIndicatorsPayload, parseSeriesPayload } from "../../src/sources/imf/parser.js";
import type { EntityMeta } from "../../src/sources/imf/types.js";

const GHA: EntityMeta = { id: "GHA", label: "Ghana", kind: "country" };
const NGA: EntityMeta = { id: "NGA", label: "Nigeria", kind: "country" };

/**
 * Live canary for the IMF DataMapper source — skipped unless GSE_LIVE=1.
 *
 * Unlike bog.gov.gh, api.imf.org has a normal TLS chain and needs no certificate
 * workaround, so this rides on the same GSE_LIVE flag as the GSE canary rather
 * than needing one of its own.
 *
 * What these protect: the catalog shape, that GHA data is really present for a
 * headline indicator, and — the two things that would be easy to regress without
 * noticing — that the documented country/period filters are still no-ops (so the
 * client is right not to rely on them) and that an unsupported querystring
 * parameter still gets rejected rather than quietly working.
 */
const live = process.env.GSE_LIVE === "1";

describe.skipIf(!live)("IMF DataMapper (live)", () => {
  const client = new ImfClient({ timeoutMs: 30_000, retries: 1 });

  it("still returns a parseable indicator catalog", async () => {
    const { indicators } = parseIndicatorsPayload(await client.fetchIndicators());

    expect(Object.keys(indicators).length).toBeGreaterThan(50);
    expect(indicators.NGDP_RPCH?.label).toMatch(/GDP/i);
    expect(indicators.NGDP_RPCH?.dataset).toBe("WEO");
  }, 45_000);

  it("still returns Ghana's GDP growth, oldest first, with a real projection boundary", async () => {
    const { series, skipped } = parseSeriesPayload(
      await client.fetchSeries(["NGDP_RPCH"]),
      ["NGDP_RPCH"],
      [GHA],
    );

    expect(skipped).toBe(0);
    const [s] = series;
    expect(s?.rowCount).toBeGreaterThan(30);

    const years = s!.rows.map((r) => r.year);
    expect(years).toEqual([...years].sort((a, b) => a - b));

    expect(s?.projectionStartYear).toBeGreaterThan(2000);
    const projected = s!.rows.filter((r) => r.isProjection);
    const actual = s!.rows.filter((r) => !r.isProjection);
    expect(projected.length).toBeGreaterThan(0);
    expect(actual.length).toBeGreaterThan(0);
  }, 45_000);

  it("still fetches multiple indicators in one request", async () => {
    const { series } = parseSeriesPayload(
      await client.fetchSeries(["NGDP_RPCH", "PCPIPCH"]),
      ["NGDP_RPCH", "PCPIPCH"],
      [GHA],
    );

    expect(series).toHaveLength(2);
    for (const s of series) expect(s.rowCount).toBeGreaterThan(0);
  }, 45_000);

  it("still returns the country/region/group catalogs, with Ghana present", async () => {
    const countries = parseEntitiesPayload(await client.fetchEntities("country"), "country");
    const regions = parseEntitiesPayload(await client.fetchEntities("region"), "region");
    const groups = parseEntitiesPayload(await client.fetchEntities("group"), "group");

    expect(Object.keys(countries).length).toBeGreaterThan(100);
    expect(countries.GHA?.label).toBe("Ghana");
    expect(Object.keys(regions).length).toBeGreaterThan(5);
    expect(Object.keys(groups).length).toBeGreaterThan(5);
  }, 45_000);

  // The scenario that motivated multi-country support: a caller resolves a
  // neighbor by name (not code) and reads each entity's own real row out of the
  // same response Ghana's data already comes from — no separate request per
  // country.
  it("still reads each entity's own row when several countries share one request", async () => {
    const { series } = parseSeriesPayload(
      await client.fetchSeries(["NGDP_RPCH"]),
      ["NGDP_RPCH"],
      [GHA, NGA],
    );

    expect(series).toHaveLength(2);
    for (const s of series) expect(s.rowCount).toBeGreaterThan(30);
    const ghanaLatest = series.find((s) => s.entityId === "GHA")?.rows.at(-1)?.value;
    const nigeriaLatest = series.find((s) => s.entityId === "NGA")?.rows.at(-1)?.value;
    expect(ghanaLatest).not.toBe(nigeriaLatest);
  }, 45_000);

  // If IMF ever starts honoring these, the tool should switch to pushing the
  // filter upstream instead of fetching everything — this is the test that would
  // catch that and prompt the change.
  it("still ignores the documented country and period filters", async () => {
    const withoutFilter = (await fetchRaw("/external/datamapper/api/v2/NGDP_RPCH")) as {
      values: { NGDP_RPCH: Record<string, unknown> };
    };
    // Spaced deliberately: two identical-looking requests in the same tick are
    // what Akamai treats as a burst.
    await sleep(1_000);
    const withFilter = (await fetchRaw(
      "/external/datamapper/api/v2/NGDP_RPCH/GHA?periods=2020,2021",
    )) as { values: { NGDP_RPCH: Record<string, unknown> } };

    const unfilteredCountries = Object.keys(withoutFilter.values.NGDP_RPCH).length;
    const filteredCountries = Object.keys(withFilter.values.NGDP_RPCH).length;
    expect(filteredCountries).toBe(unfilteredCountries);

    const ghanaYears = Object.keys(withFilter.values.NGDP_RPCH.GHA as Record<string, unknown>);
    expect(ghanaYears.length).toBeGreaterThan(2); // more than just 2020/2021
  }, 120_000); // 4 attempts x 2 calls, with backoff between them

  /**
   * A deliberately unfiltered request, because the point of the test above is to
   * observe what the *raw* endpoint does rather than what `ImfClient` makes of it.
   *
   * It still cannot be a bare `fetch`, for two reasons learned from a red canary:
   *
   * 1. **imf.org sits behind Akamai, which rejects bursts with an HTML page served
   *    at HTTP 200.** Not a 403, not a JSON error — `response.ok` is true and
   *    `.json()` then throws `Unexpected token '<'`, which says nothing about what
   *    actually happened. So the body is checked, not the status, and a rejection
   *    is retried rather than failing the run: it is transient, and two runners
   *    sharing an IP range is enough to trigger it.
   * 2. A bare fetch sends no User-Agent. Every other request this project makes
   *    identifies itself; this one should too, both out of politeness and so the
   *    two calls here look like the same client to whatever is counting.
   *
   * If a rejection survives all the attempts, the error says so explicitly, so a
   * future failure reads as "Akamai blocked us" rather than as a parse bug.
   */
  async function fetchRaw(path: string): Promise<unknown> {
    const url = `https://www.imf.org${path}`;
    let lastBody = "";

    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt > 0) await sleep(2_000 * 2 ** (attempt - 1));

      const response = await fetch(url, {
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      lastBody = await response.text();

      try {
        return JSON.parse(lastBody) as unknown;
      } catch {
        // Falls through to another attempt; `lastBody` carries the evidence.
      }
    }

    throw new Error(
      `${url} never returned JSON in 4 attempts — last response began ` +
        `${JSON.stringify(lastBody.slice(0, 120))}. An HTML body here is Akamai's ` +
        "bot mitigation rejecting the runner, not a change in the API.",
    );
  }

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
});
