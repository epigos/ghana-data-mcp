import { describe, expect, it } from "vitest";

import { ParseError, UpstreamError } from "../../../src/lib/errors.js";
import { USER_AGENT } from "../../../src/lib/http.js";
import {
  buildDataTablesBody,
  COMPANY_COLUMN_NAMES,
  dateRange,
  GseClient,
  nonceFor,
  PAGES,
  PRICE_COLUMN_NAMES,
  sanitizeSymbol,
  TABLE_IDS,
} from "../../../src/sources/gse/client.js";
import { fixture, fixtureJson } from "../../helpers/fixtures.js";
import {
  errorResponse,
  formOf,
  htmlResponse,
  jsonResponse,
  stubFetch,
} from "../../helpers/stubFetch.js";

const tradingPageHtml = fixture("trading-and-data.trimmed.html");
const listedCompaniesHtml = fixture("listed-companies.trimmed.html");
const historyPayload = fixtureJson("history-mtngh.json");
const mainMarketPayload = fixtureJson("companies-main-market.json");
const etfPayload = fixtureJson("companies-etf.json");
const gaxPayload = fixtureJson("companies-gax.json");

/** No real backoff in tests; retries should be exercised, not waited on. */
const fast = { baseDelayMs: 0 };

function client(fetchImpl: typeof fetch, overrides = {}) {
  return new GseClient({ fetchImpl, ...fast, ...overrides });
}

describe("sanitizeSymbol", () => {
  it("upcases and trims", () => {
    expect(sanitizeSymbol(" mtngh ")).toBe("MTNGH");
  });

  it("keeps the space and dot real codes use", () => {
    expect(sanitizeSymbol("SCB PREF")).toBe("SCB PREF");
    expect(sanitizeSymbol("Dannex.")).toBe("DANNEX.");
  });

  // The share-code search runs as a regex upstream, so an unescaped `.*` would
  // silently widen the query to every listed company.
  it("strips regex metacharacters", () => {
    expect(sanitizeSymbol(".*")).toBe(".");
    expect(sanitizeSymbol("MTN|GCB")).toBe("MTNGCB");
    expect(sanitizeSymbol("^MTNGH$")).toBe("MTNGH");
    expect(sanitizeSymbol("(a)[b]{c}")).toBe("ABC");
  });

  it("returns empty for input with nothing usable left", () => {
    expect(sanitizeSymbol("!!!")).toBe("");
  });
});

describe("dateRange", () => {
  it("formats a pipe-separated day-first range", () => {
    const now = new Date("2026-07-25T12:00:00Z");
    expect(dateRange(90, now)).toBe("26/04/2026|25/07/2026");
  });

  it("zero-pads days and months", () => {
    expect(dateRange(1, new Date("2026-03-05T00:00:00Z"))).toBe("04/03/2026|05/03/2026");
  });
});

describe("buildDataTablesBody", () => {
  const body = () =>
    new URLSearchParams(
      buildDataTablesBody({
        columnNames: PRICE_COLUMN_NAMES,
        columnSearches: { 1: { value: "01/01/2026|31/01/2026" }, 2: { value: "MTNGH", regex: true } },
        length: 100,
        orderColumn: 1,
        orderDir: "desc",
        rangeSeparator: "|",
        nonce: "abc123",
      }),
    );

  it("declares every column from index 0 without gaps", () => {
    const form = body();
    // wpDataTables ignores searches on columns that follow a gap in the sequence.
    expect(form.get("columns[0][name]")).toBe("wdt_ID");
    expect(form.get("columns[1][name]")).toBe("dailydate");
    expect(form.get("columns[2][name]")).toBe("sharecode");
  });

  it("puts the date range on column 1 and the share code on column 2", () => {
    const form = body();
    expect(form.get("columns[1][search][value]")).toBe("01/01/2026|31/01/2026");
    expect(form.get("columns[1][search][regex]")).toBe("false");
    expect(form.get("columns[2][search][value]")).toBe("MTNGH");
    expect(form.get("columns[2][search][regex]")).toBe("true");
  });

  it("carries the nonce and the range separator the endpoint requires", () => {
    const form = body();
    expect(form.get("wdtNonce")).toBe("abc123");
    expect(form.get("sRangeSeparator")).toBe("|");
    expect(form.get("start")).toBe("0");
    expect(form.get("length")).toBe("100");
  });

  it("declares the company columns when given their names", () => {
    const form = new URLSearchParams(
      buildDataTablesBody({
        columnNames: COMPANY_COLUMN_NAMES,
        length: 500,
        orderColumn: 0,
        orderDir: "asc",
        nonce: "abc123",
      }),
    );

    expect(form.get("columns[1][name]")).toBe("symbol");
    expect(form.get("columns[2][name]")).toBe("company");
    expect(form.get("columns[6][name]")).toBe("authorisedshares");
    expect(form.get("columns[7][name]")).toBeNull();
    expect(form.get("order[0][dir]")).toBe("asc");
  });

  // The company request the page itself sends has no range filter, so it should
  // not carry a separator for one.
  it("omits sRangeSeparator when no range filter is in play", () => {
    const form = new URLSearchParams(
      buildDataTablesBody({
        columnNames: COMPANY_COLUMN_NAMES,
        length: 500,
        orderColumn: 0,
        orderDir: "asc",
        nonce: "abc123",
      }),
    );

    expect(form.get("sRangeSeparator")).toBeNull();
  });
});

describe("GseClient.createSession", () => {
  const priceSession = (fetchImpl: typeof fetch) =>
    client(fetchImpl).createSession(PAGES.tradingAndData, [TABLE_IDS.dailyPrices]);

  it("returns the nonces and a cookie header built from Set-Cookie", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      {
        match: "/trading-and-data/",
        responses: [
          () =>
            htmlResponse(tradingPageHtml, [
              "__cf_bm=abc; HttpOnly; SameSite=None; Secure; Path=/; Expires=Sat, 25 Jul 2026 16:45:18 GMT",
              "wordpress_test_cookie=WP; Path=/",
            ]),
        ],
      },
    ]);

    const session = await priceSession(fetchImpl);

    expect(session.nonces[39]).toBe("0f8398a525");
    // Response-only attributes must not leak into the request header.
    expect(session.cookie).toBe("__cf_bm=abc; wordpress_test_cookie=WP");
    expect(session.cookie).not.toMatch(/HttpOnly|Path|Expires/);
    expect(calls[0]?.headers.get("user-agent")).toBe(USER_AGENT);
  });

  it("selects the nonce belonging to the requested table", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
    ]);
    const session = await client(fetchImpl).createSession(PAGES.tradingAndData, [47]);
    expect(session.nonces[47]).toBe("ecee03bd2a");
  });

  // Nonces are per-table but issued per page load, so one handshake serves every
  // table on the page — that is what keeps the 3-table company scrape to a
  // single page fetch instead of three.
  it("collects several tables' nonces from a single page fetch", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "/listed-companies/", responses: [() => htmlResponse(listedCompaniesHtml)] },
    ]);

    const session = await client(fetchImpl).createSession(PAGES.listedCompanies, [34, 35, 36]);

    expect(session.nonces).toEqual({ 34: "4304a15ea7", 35: "d8594dbc56", 36: "cbedea695c" });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain("/listed-companies/");
  });

  it("fails when a requested table's nonce is not on the page", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
    ]);

    // Table 34 lives on /listed-companies/, not here.
    await expect(client(fetchImpl).createSession(PAGES.tradingAndData, [34])).rejects.toThrow(
      /wdtNonceFrontendEdit_34/,
    );
  });

  it("fails when no cookie is set, since admin-ajax needs one", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml, [])] },
    ]);
    await expect(priceSession(fetchImpl)).rejects.toThrow(/did not set any cookie/);
  });

  it("retries a 503 and succeeds on a later attempt", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      {
        match: "/trading-and-data/",
        responses: [() => errorResponse(503), () => htmlResponse(tradingPageHtml)],
      },
    ]);

    const session = await priceSession(fetchImpl);
    expect(session.nonces[39]).toBe("0f8398a525");
    expect(calls).toHaveLength(2);
  });

  it("gives up after exhausting retries", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "/trading-and-data/", responses: [() => errorResponse(503)] },
    ]);

    await expect(
      client(fetchImpl, { retries: 2 }).createSession(PAGES.tradingAndData, [39]),
    ).rejects.toThrow(UpstreamError);
    expect(calls).toHaveLength(3); // initial attempt + 2 retries
  });

  it("does not retry a status that will not change", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "/trading-and-data/", responses: [() => errorResponse(404)] },
    ]);

    await expect(priceSession(fetchImpl)).rejects.toThrow(/returned 404/);
    expect(calls).toHaveLength(1);
  });
});

describe("nonceFor", () => {
  it("returns the nonce for a table", () => {
    expect(nonceFor({ cookie: "c", nonces: { 34: "abc" } }, 34)).toBe("abc");
  });

  it("throws rather than posting an undefined nonce", () => {
    expect(() => nonceFor({ cookie: "c", nonces: {} }, 34)).toThrow(/no nonce for table 34/);
  });
});

describe("GseClient.fetchCompanyTables", () => {
  function companyStub(overrides: Partial<Record<number, () => Response>> = {}) {
    return stubFetch([
      { match: "/listed-companies/", responses: [() => htmlResponse(listedCompaniesHtml)] },
      { match: "table_id=34", responses: [overrides[34] ?? (() => jsonResponse(mainMarketPayload))] },
      { match: "table_id=35", responses: [overrides[35] ?? (() => jsonResponse(etfPayload))] },
      { match: "table_id=36", responses: [overrides[36] ?? (() => jsonResponse(gaxPayload))] },
    ]);
  }

  it("fetches every company table from one handshake", async () => {
    const { fetch: fetchImpl, calls } = companyStub();
    const results = await client(fetchImpl).fetchCompanyTables();

    expect(results.map((result) => result.market)).toEqual(["main", "gax", "etf"]);
    for (const result of results) expect(result.payload).toBeDefined();

    // One page GET plus one POST per table — no redundant handshakes.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(1);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("sends each table its own nonce", async () => {
    const { fetch: fetchImpl, calls } = companyStub();
    await client(fetchImpl).fetchCompanyTables();

    const nonceByTable = Object.fromEntries(
      calls
        .filter((c) => c.method === "POST")
        .map((c) => [new URL(c.url).searchParams.get("table_id"), formOf(c)["wdtNonce"]]),
    );

    expect(nonceByTable).toEqual({ "34": "4304a15ea7", "35": "d8594dbc56", "36": "cbedea695c" });
  });

  it("declares the company column names and orders by id", async () => {
    const { fetch: fetchImpl, calls } = companyStub();
    await client(fetchImpl).fetchCompanyTables();

    const form = formOf(calls.find((c) => c.method === "POST")!);
    expect(form["columns[1][name]"]).toBe("symbol");
    expect(form["columns[2][name]"]).toBe("company");
    expect(form["columns[6][name]"]).toBe("authorisedshares");
    expect(form["order[0][column]"]).toBe("0");
    expect(form["order[0][dir]"]).toBe("asc");
    // Every table is well under 100 rows, so one request gets all of it.
    expect(Number(form["length"])).toBeGreaterThanOrEqual(100);
  });

  it("references the listed-companies page and carries the session cookie", async () => {
    const { fetch: fetchImpl, calls } = companyStub();
    await client(fetchImpl).fetchCompanyTables();

    const post = calls.find((c) => c.method === "POST")!;
    expect(post.headers.get("referer")).toContain("/listed-companies/");
    expect(post.headers.get("cookie")).toBe("__cf_bm=stub");
  });

  // One small table failing should not cost the caller the 34-row main list.
  it("reports a failed table instead of failing them all", async () => {
    const { fetch: fetchImpl } = companyStub({ 36: () => errorResponse(500) });
    const results = await client(fetchImpl, { retries: 0 }).fetchCompanyTables();

    const gax = results.find((result) => result.market === "gax");
    expect(gax?.payload).toBeUndefined();
    expect(gax?.error).toBeInstanceOf(UpstreamError);
    expect(results.find((result) => result.market === "main")?.payload).toBeDefined();
  });

  it("propagates a handshake failure, since no table can be read without it", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/listed-companies/", responses: [() => errorResponse(503)] },
    ]);

    await expect(client(fetchImpl).fetchCompanyTables()).rejects.toThrow(UpstreamError);
  });
});

describe("GseClient.fetchStockHistory", () => {
  function historyStub() {
    return stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "admin-ajax.php", responses: [() => jsonResponse(historyPayload)] },
    ]);
  }

  it("performs the handshake then posts the table query", async () => {
    const { fetch: fetchImpl, calls } = historyStub();

    const payload = await client(fetchImpl).fetchStockHistory({ symbol: "mtngh", days: 90 });

    expect(payload).toEqual(historyPayload);
    expect(calls).toHaveLength(2);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[1]?.method).toBe("POST");
    expect(calls[1]?.url).toContain("action=get_wdtable&table_id=39");
  });

  it("sends the session cookie and nonce taken from step one", async () => {
    const { fetch: fetchImpl, calls } = historyStub();
    await client(fetchImpl).fetchStockHistory({ symbol: "MTNGH", days: 30 });

    const post = calls[1];
    expect(post?.headers.get("cookie")).toBe("__cf_bm=stub");
    expect(post?.headers.get("x-requested-with")).toBe("XMLHttpRequest");
    expect(post?.headers.get("content-type")).toContain("application/x-www-form-urlencoded");
    expect(formOf(post!)["wdtNonce"]).toBe("0f8398a525");
  });

  it("upcases the symbol into the share-code search", async () => {
    const { fetch: fetchImpl, calls } = historyStub();
    await client(fetchImpl).fetchStockHistory({ symbol: " mtngh ", days: 30 });

    expect(formOf(calls[1]!)["columns[2][search][value]"]).toBe("MTNGH");
  });

  it("requests a page long enough to hold the window", async () => {
    const { fetch: fetchImpl, calls } = historyStub();
    await client(fetchImpl).fetchStockHistory({ symbol: "MTNGH", days: 365 });

    // At most ~5 trading rows per week, so `days` is a safe upper bound.
    expect(Number(formOf(calls[1]!)["length"])).toBeGreaterThanOrEqual(365);
  });

  it("clamps an absurd day count instead of asking for everything", async () => {
    const { fetch: fetchImpl, calls } = historyStub();
    await client(fetchImpl).fetchStockHistory({ symbol: "MTNGH", days: 100_000 });

    expect(Number(formOf(calls[1]!)["length"])).toBeLessThanOrEqual(2000);
  });

  // WordPress answers a rejected nonce with a 200 carrying HTML.
  it("raises ParseError when admin-ajax returns non-JSON", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "admin-ajax.php", responses: [() => new Response("<html>-1</html>", { status: 200 })] },
    ]);

    await expect(client(fetchImpl).fetchStockHistory({ symbol: "MTNGH", days: 90 })).rejects.toThrow(
      ParseError,
    );
  });
});
