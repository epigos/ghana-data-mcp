import { describe, expect, it } from "vitest";

import { ParseError, UpstreamError } from "../../../src/lib/errors.js";
import { ImfClient } from "../../../src/sources/imf/client.js";
import { fixtureJson } from "../../helpers/fixtures.js";
import { errorResponse, jsonResponse, stubFetch } from "../../helpers/stubFetch.js";

const indicatorsPayload = fixtureJson("imf-indicators.json");
const seriesPayload = fixtureJson("imf-series-headline.json");
const countriesPayload = fixtureJson("imf-countries.json");
const regionsPayload = fixtureJson("imf-regions.json");
const groupsPayload = fixtureJson("imf-groups.json");

const fast = { baseDelayMs: 0 };

function client(fetchImpl: typeof fetch, overrides = {}) {
  return new ImfClient({ fetchImpl, ...fast, ...overrides });
}

describe("ImfClient.fetchIndicators", () => {
  it("fetches the catalog with a single GET, no query string", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "/api/v2/indicators", responses: [() => jsonResponse(indicatorsPayload)] },
    ]);

    const payload = await client(fetchImpl).fetchIndicators();

    expect(payload).toEqual(indicatorsPayload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).not.toContain("?");
  });

  it("retries a transient failure", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      {
        match: "/api/v2/indicators",
        responses: [() => errorResponse(503), () => jsonResponse(indicatorsPayload)],
      },
    ]);

    await expect(client(fetchImpl).fetchIndicators()).resolves.toEqual(indicatorsPayload);
    expect(calls).toHaveLength(2);
  });

  // The DataMapper site sits behind Akamai, whose bot mitigation answers a burst
  // of requests with a 403 that clears on its own — worth one retry, not a hard
  // failure.
  it("treats 403 as retryable", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      {
        match: "/api/v2/indicators",
        responses: [() => errorResponse(403), () => jsonResponse(indicatorsPayload)],
      },
    ]);

    await expect(client(fetchImpl).fetchIndicators()).resolves.toEqual(indicatorsPayload);
    expect(calls).toHaveLength(2);
  });
});

describe("ImfClient.fetchEntities", () => {
  it.each([
    ["country", "countries", countriesPayload],
    ["region", "regions", regionsPayload],
    ["group", "groups", groupsPayload],
  ] as const)("fetches the %s catalog from /%s, no query string", async (kind, path, payload) => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: `/api/v2/${path}`, responses: [() => jsonResponse(payload)] },
    ]);

    const result = await client(fetchImpl).fetchEntities(kind);

    expect(result).toEqual(payload);
    expect(calls[0]?.url).toContain(`/api/v2/${path}`);
    expect(calls[0]?.url).not.toContain("?");
  });
});

describe("ImfClient.fetchSeries", () => {
  it("builds one path segment per indicator id, in the order given", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "/api/v2/NGDP_RPCH/PCPIPCH", responses: [() => jsonResponse(seriesPayload)] },
    ]);

    const payload = await client(fetchImpl).fetchSeries(["NGDP_RPCH", "PCPIPCH"]);

    expect(payload).toEqual(seriesPayload);
    expect(calls[0]?.url).toContain("/api/v2/NGDP_RPCH/PCPIPCH");
    expect(calls[0]?.url).not.toContain("?");
  });

  // The documented country/period filters are silently ignored by the real API and
  // an unsupported querystring param trips its WAF instead of erroring cleanly —
  // so this client must never send one. This is the test that would catch a
  // regression if a future edit tried to "helpfully" add ?periods= or ?countries=.
  it("never sends a query string", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "/api/v2/NGDP_RPCH", responses: [() => jsonResponse(seriesPayload)] },
    ]);

    await client(fetchImpl).fetchSeries(["NGDP_RPCH"]);

    expect(calls[0]?.url).not.toContain("?");
    expect(calls[0]?.url).not.toContain("periods");
    expect(calls[0]?.url).not.toContain("countries");
  });

  it("URL-encodes an indicator id that needs it", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "/api/v2/", responses: [() => jsonResponse({ indicators: {}, values: {} })] },
    ]);

    await client(fetchImpl).fetchSeries(["A B"]);
    expect(calls[0]?.url).toContain("A%20B");
  });

  it("rejects an empty indicator list before making a request", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([]);
    await expect(client(fetchImpl).fetchSeries([])).rejects.toThrow(/at least one indicator/);
    expect(calls).toHaveLength(0);
  });

  it("raises ParseError when the response is not JSON", async () => {
    const { fetch: fetchImpl } = stubFetch([
      {
        match: "/api/v2/NGDP_RPCH",
        responses: [() => new Response("<html>Request Rejected</html>", { status: 200 })],
      },
    ]);

    await expect(client(fetchImpl).fetchSeries(["NGDP_RPCH"])).rejects.toThrow(ParseError);
  });

  it("surfaces a non-retryable status as an UpstreamError", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/api/v2/NGDP_RPCH", responses: [() => errorResponse(404)] },
    ]);

    await expect(client(fetchImpl).fetchSeries(["NGDP_RPCH"])).rejects.toThrow(UpstreamError);
  });
});
