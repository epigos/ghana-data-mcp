import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ParseError, UpstreamError } from "../../../src/lib/errors.js";
import {
  extractNonce,
  extractNonces,
  extractSymbols,
  parseCompanyPayload,
  parseDayFirstDate,
  parseFixedIncomeIssuersPayload,
  parseHistoryPayload,
  parseMarketIndexPayload,
  parseNumber,
  stripHtml,
} from "../../../src/sources/gse/parser.js";
import { fixture, fixtureJson } from "../../helpers/fixtures.js";

const tradingPageHtml = fixture("trading-and-data.trimmed.html");
const listedCompaniesHtml = fixture("listed-companies.trimmed.html");
const historyPayload = fixtureJson<{ data: string[][] }>("history-mtngh.json");
const mainMarketPayload = fixtureJson<{ data: string[][] }>("companies-main-market.json");
const etfPayload = fixtureJson<{ data: string[][] }>("companies-etf.json");
const gaxPayload = fixtureJson<{ data: string[][] }>("companies-gax.json");
const marketIndexPayload = fixtureJson<{ data: string[][] }>("market-index.json");
const fixedIncomePayload = fixtureJson<{ data: string[][] }>("fixed-income-issuers.json");

describe("extractNonce", () => {
  it("reads the nonce for the requested table", () => {
    expect(extractNonce(tradingPageHtml, 39)).toBe("0f8398a525");
  });

  it("distinguishes between the two tables sharing the page", () => {
    expect(extractNonce(tradingPageHtml, 47)).toBe("ecee03bd2a");
    expect(extractNonce(tradingPageHtml, 47)).not.toBe(extractNonce(tradingPageHtml, 39));
  });

  // A challenge or error page is the realistic cause here, so it must be
  // retryable rather than a permanent parse failure.
  it("throws a retryable UpstreamError when the input is absent", () => {
    expect(() => extractNonce("<html><body>Just a moment...</body></html>", 39)).toThrow(
      UpstreamError,
    );
    try {
      extractNonce("<html></html>", 39);
    } catch (error) {
      expect((error as UpstreamError).retryable).toBe(true);
    }
  });

  it("throws when the input exists but carries no value", () => {
    const html = '<html><body><input id="wdtNonceFrontendEdit_39" value=""></body></html>';
    expect(() => extractNonce(html, 39)).toThrow(/no value attribute/);
  });
});

describe("extractNonces", () => {
  it("reads all four tables from the listed-companies page in one parse", () => {
    expect(extractNonces(listedCompaniesHtml, [34, 35, 36, 37])).toEqual({
      34: "4304a15ea7",
      35: "d8594dbc56",
      36: "cbedea695c",
      37: "40d6e4ec79",
    });
  });

  it("returns only the tables asked for", () => {
    expect(extractNonces(listedCompaniesHtml, [34])).toEqual({ 34: "4304a15ea7" });
  });

  it("names the table it could not find", () => {
    expect(() => extractNonces(listedCompaniesHtml, [34, 99])).toThrow(
      /wdtNonceFrontendEdit_99/,
    );
  });

  it("is retryable, since a challenge page is the likely cause", () => {
    try {
      extractNonces("<html></html>", [34]);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UpstreamError);
      expect((error as UpstreamError).retryable).toBe(true);
    }
  });

  it("accepts an empty request", () => {
    expect(extractNonces(listedCompaniesHtml, [])).toEqual({});
  });
});

describe("stripHtml", () => {
  // wpDataTables renders the company Symbol column as a link, so the raw cell is
  // markup rather than a share code.
  it("pulls the share code out of the anchor GSE wraps it in", () => {
    expect(stripHtml("<a href='ACCESS' rel='' target='_self'>ACCESS</a>")).toBe("ACCESS");
  });

  it("leaves plain text alone", () => {
    expect(stripHtml("Access Bank Ghana Plc")).toBe("Access Bank Ghana Plc");
  });

  it("collapses whitespace and trims", () => {
    expect(stripHtml("  MTN   Ghana \n")).toBe("MTN Ghana");
  });

  it("returns empty for non-strings and empty markup", () => {
    expect(stripHtml("<a href='x'></a>")).toBe("");
    expect(stripHtml(null)).toBe("");
    expect(stripHtml(42)).toBe("");
  });
});

describe("parseNumber", () => {
  it("strips thousands separators", () => {
    expect(parseNumber("903,387")).toBe(903_387);
    expect(parseNumber("6,323,717.10")).toBe(6_323_717.1);
  });

  it("keeps negatives, which the price-change column uses", () => {
    expect(parseNumber("-0.24")).toBe(-0.24);
  });

  it("accepts zero rather than treating it as missing", () => {
    expect(parseNumber("0.00")).toBe(0);
  });

  it("returns null for blanks and placeholders", () => {
    for (const input of ["", "   ", "-", "N/A", "n/a ", undefined, null, {}]) {
      expect(parseNumber(input as unknown)).toBeNull();
    }
  });

  it("returns null for text that is not a number", () => {
    expect(parseNumber("suspended")).toBeNull();
    expect(parseNumber("1.2.3")).toBeNull();
  });

  it("passes finite numbers through and rejects NaN/Infinity", () => {
    expect(parseNumber(4.2)).toBe(4.2);
    expect(parseNumber(Number.NaN)).toBeNull();
    expect(parseNumber(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("parseDayFirstDate", () => {
  it("reads GSE's day-first format", () => {
    expect(parseDayFirstDate("24/07/2026")).toBe("2026-07-24");
  });

  // The whole reason this is a strict pattern and not Date.parse: 04/07 is
  // 4 July on gse.com.gh, and 7 April to a US-locale parser.
  it("does not fall back to month-first for ambiguous dates", () => {
    expect(parseDayFirstDate("04/07/2026")).toBe("2026-07-04");
  });

  it("accepts single-digit and dash-separated variants", () => {
    expect(parseDayFirstDate("4/7/2026")).toBe("2026-07-04");
    expect(parseDayFirstDate("24-07-2026")).toBe("2026-07-24");
  });

  it("rejects impossible and malformed dates", () => {
    for (const input of ["31/02/2026", "32/01/2026", "24/13/2026", "2026-07-24", "", "n/a", 42]) {
      expect(parseDayFirstDate(input as unknown)).toBeNull();
    }
  });
});

describe("parseHistoryPayload", () => {
  it("maps the live fixture onto typed rows", () => {
    const { rows, skipped } = parseHistoryPayload(historyPayload, { symbol: "MTNGH" });

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(historyPayload.data.length);
    // Oldest first, per the tool contract.
    expect(rows[0]?.date).toBe("2026-07-09");
    expect(rows.at(-1)?.date).toBe("2026-07-24");
  });

  it("reads the columns the GSE table actually uses", () => {
    // Fixture row: ['484225','24/07/2026','MTNGH','7.00','4.20','6.98','6.98',
    //               '7.00','7.00','0.02','7.00','7.20','903,387','6,323,717.10']
    const { rows } = parseHistoryPayload(historyPayload, { symbol: "MTNGH" });
    const latest = rows.at(-1);

    expect(latest).toEqual({
      date: "2026-07-24",
      symbol: "MTNGH",
      high: 7, // Year High (col 3)
      low: 4.2, // Year Low (col 4)
      open: 6.98, // Opening Price (col 6)
      close: 7, // Closing Price VWAP (col 8)
      change: 0.02, // Price Change (col 9)
      volume: 903_387, // Total Shares Traded (col 12)
    });
  });

  it("sorts ascending by date regardless of upstream order", () => {
    const dates = parseHistoryPayload(historyPayload, { symbol: "MTNGH" }).rows.map((r) => r.date);
    expect(dates).toEqual([...dates].sort());
  });

  it("drops rows with a missing required field and counts them", () => {
    const good = historyPayload.data[0] as string[];
    const missingClose = [...good];
    missingClose[8] = "";
    const missingVolume = [...good];
    missingVolume[12] = "";

    const { rows, skipped } = parseHistoryPayload({ data: [good, missingClose, missingVolume] });

    expect(rows).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("drops rows that are too short to be price rows", () => {
    const { rows, skipped } = parseHistoryPayload({ data: [["1", "24/07/2026", "MTNGH"], "junk", null] });
    expect(rows).toHaveLength(0);
    expect(skipped).toBe(3);
  });

  it("drops rows whose date is unreadable", () => {
    const bad = [...(historyPayload.data[0] as string[])];
    bad[1] = "not-a-date";
    expect(parseHistoryPayload({ data: [bad] })).toEqual({ rows: [], skipped: 1 });
  });

  // Upstream searches share codes as a substring regex, so a query for SCB can
  // come back with SCB PREF rows attached.
  it("keeps only exact symbol matches when a symbol is given", () => {
    const base = historyPayload.data[0] as string[];
    const other = [...base];
    other[2] = "MTNGH PREF";

    const filtered = parseHistoryPayload({ data: [base, other] }, { symbol: "MTNGH" });
    expect(filtered.rows).toHaveLength(1);
    // A filtered row is not a malformed row.
    expect(filtered.skipped).toBe(0);

    const unfiltered = parseHistoryPayload({ data: [base, other] });
    expect(unfiltered.rows).toHaveLength(2);
  });

  it("matches symbols case-insensitively", () => {
    expect(parseHistoryPayload(historyPayload, { symbol: "mtngh" }).rows.length).toBeGreaterThan(0);
  });

  it("throws ParseError when the response shape is wrong", () => {
    expect(() => parseHistoryPayload({ rows: [] })).toThrow(ParseError);
    expect(() => parseHistoryPayload("<html>nonce rejected</html>")).toThrow(ParseError);
    expect(() => parseHistoryPayload(null)).toThrow(ParseError);
  });
});

describe("parseCompanyPayload", () => {
  it("maps the main-market fixture onto typed companies", () => {
    const { companies, skipped } = parseCompanyPayload(mainMarketPayload, "main");

    expect(skipped).toBe(0);
    expect(companies).toHaveLength(mainMarketPayload.data.length);
    expect(companies.every((company) => company.market === "main")).toBe(true);
  });

  it("reads symbol, name and listing date", () => {
    const { companies } = parseCompanyPayload(mainMarketPayload, "main");
    const access = companies.find((company) => company.symbol === "ACCESS");

    expect(access).toMatchObject({
      symbol: "ACCESS",
      name: "Access Bank Ghana Plc",
      market: "main",
      dateListed: "2022-12-21",
    });
  });

  it("tags each table with its own market", () => {
    expect(parseCompanyPayload(etfPayload, "etf").companies[0]).toMatchObject({
      symbol: "GLD",
      name: "NewGold Issuer Ltd.",
      market: "etf",
    });
    expect(parseCompanyPayload(gaxPayload, "gax").companies[0]?.market).toBe("gax");
  });

  // Nine of the forty live rows have no listing date; requiring one would throw
  // away real companies.
  it("keeps a company that has no listing date", () => {
    const { companies, skipped } = parseCompanyPayload(gaxPayload, "gax");
    const hords = companies.find((company) => company.symbol === "HORDS");

    expect(hords).toBeDefined();
    expect(hords?.dateListed).toBeUndefined();
    expect(skipped).toBe(0);
  });

  // These columns are free text upstream — mixed currencies, mixed units, typos.
  // Passing them through verbatim beats parsing them into wrong numbers.
  it("passes the capital and share columns through as raw strings", () => {
    const { companies } = parseCompanyPayload(mainMarketPayload, "main");
    const aga = companies.find((company) => company.symbol === "AGA");

    expect(aga?.statedCapital).toBe("ZAR 4,899,021,716.98");
    expect(aga?.issuedShares).toBe("417,339,100 (Ordinary Shares)");
    expect(typeof aga?.statedCapital).toBe("string");
  });

  it("omits a blank optional column rather than reporting an empty string", () => {
    const { companies } = parseCompanyPayload(mainMarketPayload, "main");
    const adb = companies.find((company) => company.symbol === "ADB");

    expect(adb).toBeDefined();
    expect(adb).not.toHaveProperty("statedCapital");
    expect(adb).not.toHaveProperty("issuedShares");
  });

  it("skips a row missing its symbol or name", () => {
    const good = mainMarketPayload.data[0] as string[];
    const noSymbol = [...good];
    noSymbol[1] = "<a href='' rel='' target='_self'></a>";
    const noName = [...good];
    noName[2] = "   ";

    const { companies, skipped } = parseCompanyPayload({ data: [good, noSymbol, noName] }, "main");
    expect(companies).toHaveLength(1);
    expect(skipped).toBe(2);
  });

  it("skips rows that are the wrong shape", () => {
    const { companies, skipped } = parseCompanyPayload(
      { data: [["1", "<a>X</a>", "Short row"], null, "junk"] },
      "main",
    );
    expect(companies).toHaveLength(0);
    expect(skipped).toBe(3);
  });

  it("throws ParseError when the response is not a table payload", () => {
    expect(() => parseCompanyPayload({ companies: [] }, "main")).toThrow(ParseError);
    expect(() => parseCompanyPayload("<html>nonce rejected</html>", "main")).toThrow(ParseError);
  });

  it("produces no duplicate symbols across the three markets", () => {
    const all = [
      ...parseCompanyPayload(mainMarketPayload, "main").companies,
      ...parseCompanyPayload(gaxPayload, "gax").companies,
      ...parseCompanyPayload(etfPayload, "etf").companies,
    ];
    const symbols = all.map((company) => company.symbol);

    expect(new Set(symbols).size).toBe(symbols.length);
  });
});

describe("parseMarketIndexPayload", () => {
  it("maps the fixture onto typed rows", () => {
    const { rows, skipped } = parseMarketIndexPayload(marketIndexPayload);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(marketIndexPayload.data.length);
  });

  it("reads the columns the market table actually uses", () => {
    // Fixture row: ['750','Friday','24/07/2026','3,210,763.00','15,330.57',
    //               '292,058.49','8,281.03']
    const { rows } = parseMarketIndexPayload(marketIndexPayload);

    expect(rows.at(-1)).toEqual({
      date: "2026-07-24",
      volume: 3_210_763,
      compositeIndex: 15_330.57,
      marketCapGhsMillion: 292_058.49,
      financialStockIndex: 8_281.03,
    });
  });

  it("sorts ascending by date", () => {
    const dates = parseMarketIndexPayload(marketIndexPayload).rows.map((row) => row.date);
    expect(dates).toEqual([...dates].sort());
  });

  // Column 1 is the weekday name, which GSE pads inconsistently ("Thursday ").
  // It is derivable from the date, so it is skipped rather than cleaned.
  it("ignores the weekday column entirely", () => {
    const [first] = parseMarketIndexPayload(marketIndexPayload).rows;
    expect(first).not.toHaveProperty("day");
    expect(JSON.stringify(first)).not.toMatch(/day/i);
  });

  it("drops a row missing any index value", () => {
    const good = marketIndexPayload.data[0] as string[];
    const noIndex = [...good];
    noIndex[4] = "";

    const { rows, skipped } = parseMarketIndexPayload({ data: [good, noIndex] });
    expect(rows).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("drops rows that are the wrong shape or have an unreadable date", () => {
    const bad = [...(marketIndexPayload.data[0] as string[])];
    bad[2] = "not-a-date";

    expect(parseMarketIndexPayload({ data: [bad, ["1", "Mon"], null] })).toEqual({
      rows: [],
      skipped: 3,
    });
  });

  it("throws ParseError when the response is not a table payload", () => {
    expect(() => parseMarketIndexPayload({ index: [] })).toThrow(ParseError);
  });
});

describe("parseFixedIncomeIssuersPayload", () => {
  it("maps the fixture onto typed issuers", () => {
    const { issuers, skipped } = parseFixedIncomeIssuersPayload(fixedIncomePayload);

    expect(skipped).toBe(0);
    expect(issuers).toHaveLength(14);
  });

  // These columns are parsed into numbers, unlike the company table's
  // statedCapital, because GSE writes them cleanly with the unit in the header.
  it("parses the amounts into numbers", () => {
    const { issuers } = parseFixedIncomeIssuersPayload(fixedIncomePayload);
    const esla = issuers.find((issuer) => issuer.name === "ESLA Plc");

    expect(esla).toEqual({
      name: "ESLA Plc",
      admittedYear: 2017,
      tranches: 6,
      amountRaisedGhsMillion: 10_500,
      shelfRegistrationGhsMillion: 10_500,
    });
  });

  it("strips thousands separators from the amounts", () => {
    const { issuers } = parseFixedIncomeIssuersPayload(fixedIncomePayload);
    const cocobod = issuers.find((issuer) => issuer.name === "Ghana Cocoa Board");

    expect(cocobod?.amountRaisedGhsMillion).toBe(3_289.56);
    expect(cocobod?.shelfRegistrationGhsMillion).toBe(5_500);
  });

  it("skips a row with no issuer name", () => {
    const good = fixedIncomePayload.data[0] as string[];
    const nameless = [...good];
    nameless[1] = "  ";

    const { issuers, skipped } = parseFixedIncomeIssuersPayload({ data: [good, nameless] });
    expect(issuers).toHaveLength(1);
    expect(skipped).toBe(1);
  });

  it("keeps an issuer whose numeric columns are blank", () => {
    const sparse = ["1", "Some Issuer Plc", "", "", "", ""];
    const { issuers, skipped } = parseFixedIncomeIssuersPayload({ data: [sparse] });

    expect(skipped).toBe(0);
    expect(issuers[0]).toEqual({ name: "Some Issuer Plc" });
  });

  // A cell that does not hold a plausible year is more likely mislabelled data
  // than a real admission date.
  it("omits an implausible admission year", () => {
    const rows = [
      ["1", "A Plc", "1899", "1", "1", "1"],
      ["2", "B Plc", "12", "1", "1", "1"],
      ["3", "C Plc", "2024", "1", "1", "1"],
    ];
    const { issuers } = parseFixedIncomeIssuersPayload({ data: rows });

    expect(issuers[0]).not.toHaveProperty("admittedYear");
    expect(issuers[1]).not.toHaveProperty("admittedYear");
    expect(issuers[2]?.admittedYear).toBe(2024);
  });

  it("throws ParseError when the response is not a table payload", () => {
    expect(() => parseFixedIncomeIssuersPayload({ issuers: [] })).toThrow(ParseError);
  });
});

describe("extractSymbols", () => {
  it("returns distinct sorted share codes", () => {
    const base = historyPayload.data[0] as string[];
    const other = [...base];
    other[2] = "GCB";

    expect(extractSymbols({ data: [base, other, base] })).toEqual(["GCB", "MTNGH"]);
  });
});

describe("fixture integrity", () => {
  const raw = JSON.parse(
    readFileSync(new URL("../../fixtures/history-mtngh.json", import.meta.url), "utf8"),
  ) as { data: string[][]; recordsTotal: unknown; recordsFiltered: unknown };

  // Guards against a future edit quietly reshaping the fixtures the suite leans on.
  it("keeps the saved payload in the 14-column layout the parser assumes", () => {
    expect(raw.data.length).toBeGreaterThan(0);
    for (const row of raw.data) expect(row).toHaveLength(14);
  });

  // GSE sends these as JSON strings even though DataTables specifies numbers.
  // The fixture must preserve that, or the string-handling path goes untested.
  it("keeps the record counts as strings, the way GSE sends them", () => {
    expect(typeof raw.recordsTotal).toBe("string");
    expect(typeof raw.recordsFiltered).toBe("string");
  });

  // The fixture was trimmed from a larger response; if recordsFiltered still
  // claimed the original count, the client would rightly log it as truncated.
  it("has a recordsFiltered that matches the rows it actually holds", () => {
    expect(Number(raw.recordsFiltered)).toBe(raw.data.length);
  });
});
