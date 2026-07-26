import { describe, expect, it } from "vitest";

import { ImfClient } from "../../src/sources/imf/client.js";
import { parseIndicatorsPayload, parseSeriesPayload } from "../../src/sources/imf/parser.js";

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
    const { series, skipped } = parseSeriesPayload(await client.fetchSeries(["NGDP_RPCH"]), [
      "NGDP_RPCH",
    ]);

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
    const { series } = parseSeriesPayload(await client.fetchSeries(["NGDP_RPCH", "PCPIPCH"]), [
      "NGDP_RPCH",
      "PCPIPCH",
    ]);

    expect(series).toHaveLength(2);
    for (const s of series) expect(s.rowCount).toBeGreaterThan(0);
  }, 45_000);

  // If IMF ever starts honoring these, the tool should switch to pushing the
  // filter upstream instead of fetching everything — this is the test that would
  // catch that and prompt the change.
  it("still ignores the documented country and period filters", async () => {
    const withoutFilter = (await fetchRaw("/external/datamapper/api/v2/NGDP_RPCH")) as {
      values: { NGDP_RPCH: Record<string, unknown> };
    };
    const withFilter = (await fetchRaw(
      "/external/datamapper/api/v2/NGDP_RPCH/GHA?periods=2020,2021",
    )) as { values: { NGDP_RPCH: Record<string, unknown> } };

    const unfilteredCountries = Object.keys(withoutFilter.values.NGDP_RPCH).length;
    const filteredCountries = Object.keys(withFilter.values.NGDP_RPCH).length;
    expect(filteredCountries).toBe(unfilteredCountries);

    const ghanaYears = Object.keys(withFilter.values.NGDP_RPCH.GHA as Record<string, unknown>);
    expect(ghanaYears.length).toBeGreaterThan(2); // more than just 2020/2021
  }, 45_000);

  async function fetchRaw(path: string): Promise<unknown> {
    const response = await fetch(`https://www.imf.org${path}`, {
      headers: { accept: "application/json" },
    });
    return response.json();
  }
});
