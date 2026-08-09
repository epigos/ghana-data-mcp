import { describe, expect, it, vi } from "vitest";

import { ParseError, UpstreamError } from "../../../src/lib/errors.js";
import { USER_AGENT } from "../../../src/lib/http.js";
import { createLogger } from "../../../src/lib/log.js";
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
const marketIndexPayload = fixtureJson("market-index.json");
const fixedIncomePayload = fixtureJson("fixed-income-issuers.json");

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

  // GSE annotates two of its own share codes: the price table stores `**ALW**` and
  // `PBC**`, and the column search compares the whole value literally. Stripping
  // the asterisks — as this used to — made both securities unreachable.
  it("keeps the annotation markers GSE puts in real share codes", () => {
    expect(sanitizeSymbol("**ALW**")).toBe("**ALW**");
    expect(sanitizeSymbol("PBC**")).toBe("PBC**");
  });

  // The search is a literal comparison, not a regex — verified against the live
  // table, where `.*SCB.*` matches nothing while `SCB` matches. So these characters
  // cannot widen a query; they are dropped because no real share code contains them.
  it("drops characters no share code uses", () => {
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

describe("GseClient.fetchMarketIndex", () => {
  function indexStub() {
    return stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "table_id=47", responses: [() => jsonResponse(marketIndexPayload)] },
    ]);
  }

  it("handshakes on the trading page and queries table 47", async () => {
    const { fetch: fetchImpl, calls } = indexStub();
    const payload = await client(fetchImpl).fetchMarketIndex({ days: 90 });

    expect(payload).toEqual(marketIndexPayload);
    expect(calls[1]?.url).toContain("table_id=47");
    expect(formOf(calls[1]!)["wdtNonce"]).toBe("ecee03bd2a"); // table 47's own nonce
  });

  // The price table filters dates on column 1; this one on column 2. Getting it
  // wrong returns the whole 749-row history instead of the window asked for.
  it("puts the date range on column 2, not column 1", async () => {
    const { fetch: fetchImpl, calls } = indexStub();
    await client(fetchImpl).fetchMarketIndex({ days: 30 });

    const form = formOf(calls[1]!);
    expect(form["columns[2][search][value]"]).toMatch(/^\d{2}\/\d{2}\/\d{4}\|\d{2}\/\d{2}\/\d{4}$/);
    expect(form["columns[1][search][value]"]).toBe("");
    expect(form["columns[2][name]"]).toBe("date");
    expect(form["order[0][column]"]).toBe("2");
    expect(form["sRangeSeparator"]).toBe("|");
  });

  it("clamps an absurd day count", async () => {
    const { fetch: fetchImpl, calls } = indexStub();
    await client(fetchImpl).fetchMarketIndex({ days: 100_000 });

    expect(Number(formOf(calls[1]!)["length"])).toBeLessThanOrEqual(10_000);
  });
});

describe("GseClient.fetchFixedIncomeIssuers", () => {
  function gfimStub() {
    return stubFetch([
      { match: "/listed-companies/", responses: [() => htmlResponse(listedCompaniesHtml)] },
      { match: "table_id=37", responses: [() => jsonResponse(fixedIncomePayload)] },
    ]);
  }

  it("handshakes on the listed-companies page and queries table 37", async () => {
    const { fetch: fetchImpl, calls } = gfimStub();
    const payload = await client(fetchImpl).fetchFixedIncomeIssuers();

    expect(payload).toEqual(fixedIncomePayload);
    expect(calls[1]?.url).toContain("table_id=37");
    expect(formOf(calls[1]!)["wdtNonce"]).toBe("40d6e4ec79");
    expect(calls[1]?.headers.get("referer")).toContain("/listed-companies/");
  });

  it("declares the GFIM column names and no date filter", async () => {
    const { fetch: fetchImpl, calls } = gfimStub();
    await client(fetchImpl).fetchFixedIncomeIssuers();

    const form = formOf(calls[1]!);
    expect(form["columns[1][name]"]).toBe("nameofissuer");
    expect(form["columns[5][name]"]).toBe("shelfregistration");
    expect(form["columns[6][name]"]).toBeUndefined();
    // No range filter on this table, so no separator for one.
    expect(form["sRangeSeparator"]).toBeUndefined();
  });
});

describe("client logging", () => {
  function recorder() {
    const lines: string[] = [];
    return {
      lines,
      text: () => lines.join("\n"),
      find: (needle: string) => lines.find((line) => line.includes(needle)),
      logger: createLogger({ debug: true, sink: (_, line) => lines.push(line) }),
    };
  }

  function loggingClient(log: ReturnType<typeof recorder>) {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "admin-ajax.php", responses: [() => jsonResponse(historyPayload)] },
    ]);
    return new GseClient({ fetchImpl, ...fast, logger: log.logger });
  }

  it("tags every line with its source, so a second source stays distinguishable", async () => {
    const log = recorder();
    await loggingClient(log).fetchStockHistory({ symbol: "MTNGH", days: 30 });

    expect(log.lines.length).toBeGreaterThan(0);
    for (const line of log.lines) expect(line).toContain("source=gse");
  });

  it("announces the fetch it is about to make", async () => {
    const log = recorder();
    await loggingClient(log).fetchStockHistory({ symbol: "mtngh", days: 30 });

    const line = log.find("gse: fetching stock history");
    expect(line).toContain("symbol=MTNGH");
    expect(line).toContain("days=30");
  });

  it("logs the session handshake and the row count that came back", async () => {
    const log = recorder();
    await loggingClient(log).fetchStockHistory({ symbol: "MTNGH", days: 30 });

    expect(log.find("gse: session created")).toContain("page=/trading-and-data/");
    const fetched = log.find("gse: table fetched");
    expect(fetched).toContain("table=39");
    expect(fetched).toContain("rows=12");
    expect(fetched).toContain("recordsTotal=183595");
  });

  // The nonce comes from public page HTML and is what you need to debug a
  // rejected POST; the cookie is a session token and must not be logged.
  it("logs nonces but never the cookie value", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      {
        match: "/trading-and-data/",
        responses: [() => htmlResponse(tradingPageHtml, ["__cf_bm=super-secret-value; Path=/"])],
      },
      { match: "admin-ajax.php", responses: [() => jsonResponse(historyPayload)] },
    ]);

    await new GseClient({ fetchImpl, ...fast, logger: log.logger }).fetchStockHistory({
      symbol: "MTNGH",
      days: 30,
    });

    expect(log.find("gse: session detail")).toContain("39:0f8398a525");
    expect(log.find("gse: session detail")).toContain("cookieNames=__cf_bm");
    expect(log.text()).not.toContain("super-secret-value");
  });

  it("warns when the response held fewer rows than the search matched", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      {
        match: "admin-ajax.php",
        // 12 rows returned, but the filter says 500 matched — the page was cut short.
        responses: [() => jsonResponse({ ...(historyPayload as object), recordsFiltered: 500 })],
      },
    ]);

    await new GseClient({ fetchImpl, ...fast, logger: log.logger }).fetchStockHistory({
      symbol: "MTNGH",
      days: 30,
    });

    const line = log.find("gse: table response was truncated");
    expect(line).toContain("rows=12");
    expect(line).toContain("recordsFiltered=500");
  });

  it("does not cry truncation when the whole result came back", async () => {
    const log = recorder();
    await loggingClient(log).fetchStockHistory({ symbol: "MTNGH", days: 30 });

    expect(log.find("gse: table response was truncated")).toBeUndefined();
  });

  it("names the likely cause when a table response is not JSON at all", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "admin-ajax.php", responses: [() => new Response("<html>error</html>")] },
    ]);

    await expect(
      new GseClient({ fetchImpl, ...fast, logger: log.logger }).fetchStockHistory({
        symbol: "MTNGH",
        days: 30,
      }),
    ).rejects.toThrow(ParseError);

    expect(log.find("gse: table response was not JSON")).toContain("rejected wdtNonce");
  });

  it("summarises the company directory fetch, including a failed board", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "/listed-companies/", responses: [() => htmlResponse(listedCompaniesHtml)] },
      { match: "table_id=34", responses: [() => jsonResponse(mainMarketPayload)] },
      { match: "table_id=35", responses: [() => jsonResponse(etfPayload)] },
      { match: "table_id=36", responses: [() => errorResponse(500)] },
    ]);

    await new GseClient({ fetchImpl, ...fast, retries: 0, logger: log.logger }).fetchCompanyTables();

    expect(log.find("gse: fetching company directory")).toContain("markets=main,gax,etf");
    expect(log.find("gse: company table failed")).toContain("market=gax");
    const done = log.find("gse: company directory fetched");
    expect(done).toContain("ok=2");
    expect(done).toContain("failedMarkets=gax");
  });

  it("logs nothing at all when no logger is given", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "admin-ajax.php", responses: [() => jsonResponse(historyPayload)] },
    ]);

    await new GseClient({ fetchImpl, ...fast }).fetchStockHistory({ symbol: "MTNGH", days: 30 });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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

    expect(Number(formOf(calls[1]!)["length"])).toBeLessThanOrEqual(10_000);
  });

  // The page bound has to clear a full-history window — GSE holds ~4000 rows for a
  // liquid symbol since 2007 — or the truncation warning fires on every long query.
  it("asks for a page large enough to hold two decades of one symbol", async () => {
    const { fetch: fetchImpl, calls } = historyStub();
    await client(fetchImpl).fetchStockHistory({ symbol: "MTNGH", days: 7300 });

    expect(Number(formOf(calls[1]!)["length"])).toBeGreaterThanOrEqual(5000);
  });

  // One way WordPress rejects a request: a 200 carrying an HTML error page.
  it("raises ParseError when admin-ajax returns non-JSON", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "admin-ajax.php", responses: [() => new Response("<html>-1</html>", { status: 200 })] },
    ]);

    await expect(client(fetchImpl).fetchStockHistory({ symbol: "MTNGH", days: 90 })).rejects.toThrow(
      ParseError,
    );
  });

  // The other way, and the sneaky one: admin-ajax.php answers a failed nonce
  // with a bare `-1` and a 200. That is valid JSON, so it parses fine and would
  // reach the parser as a confusing "no data array" error if not caught here.
  it.each(["-1", "0"])("raises a nonce-specific ParseError for the %s sentinel", async (body) => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "/trading-and-data/", responses: [() => htmlResponse(tradingPageHtml)] },
      { match: "admin-ajax.php", responses: [() => new Response(body, { status: 200 })] },
    ]);

    await expect(
      client(fetchImpl).fetchStockHistory({ symbol: "MTNGH", days: 90 }),
    ).rejects.toThrow(/wdtNonce was probably rejected/);
  });
});
