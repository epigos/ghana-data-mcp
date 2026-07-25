import { describe, expect, it } from "vitest";

import { UpstreamError } from "../../../src/lib/errors.js";
import { GseClient } from "../../../src/sources/gse/client.js";
import {
  COMPANY_SEED,
  fetchCompanyDirectory,
  searchCompanies,
} from "../../../src/sources/gse/companies.js";
import { fixture, fixtureJson } from "../../helpers/fixtures.js";
import { errorResponse, htmlResponse, jsonResponse, stubFetch } from "../../helpers/stubFetch.js";

const listedCompaniesHtml = fixture("listed-companies.trimmed.html");
const mainMarketPayload = fixtureJson("companies-main-market.json");
const etfPayload = fixtureJson("companies-etf.json");
const gaxPayload = fixtureJson("companies-gax.json");

const top = (query: string, limit = 10) =>
  searchCompanies(COMPANY_SEED, query, limit)[0]?.symbol;

function directoryClient(overrides: Partial<Record<number, () => Response>> = {}) {
  const { fetch: fetchImpl } = stubFetch([
    { match: "/listed-companies/", responses: [() => htmlResponse(listedCompaniesHtml)] },
    { match: "table_id=34", responses: [overrides[34] ?? (() => jsonResponse(mainMarketPayload))] },
    { match: "table_id=35", responses: [overrides[35] ?? (() => jsonResponse(etfPayload))] },
    { match: "table_id=36", responses: [overrides[36] ?? (() => jsonResponse(gaxPayload))] },
  ]);
  return new GseClient({ fetchImpl, baseDelayMs: 0, retries: 0 });
}

describe("COMPANY_SEED", () => {
  it("has no duplicate share codes", () => {
    const symbols = COMPANY_SEED.map((company) => company.symbol);
    expect(new Set(symbols).size).toBe(symbols.length);
  });

  it("has a name, symbol and market on every entry", () => {
    for (const company of COMPANY_SEED) {
      expect(company.name.trim()).not.toBe("");
      expect(company.symbol.trim()).not.toBe("");
      expect(company.market).toBe("main");
    }
  });

  // The seed only earns its place as a fallback if it is a subset of what is
  // actually listed — an entry that has been delisted would be misinformation.
  it("is a subset of the live directory", async () => {
    const { companies } = await fetchCompanyDirectory(directoryClient());
    const live = new Set(companies.map((company) => company.symbol));

    expect(COMPANY_SEED.filter((company) => !live.has(company.symbol))).toEqual([]);
  });
});

describe("fetchCompanyDirectory", () => {
  it("merges all three markets, sorted by share code", async () => {
    const { companies, skipped, failedMarkets } = await fetchCompanyDirectory(directoryClient());

    expect(skipped).toBe(0);
    expect(failedMarkets).toEqual([]);
    expect(companies).toHaveLength(40); // 34 main + 5 GAX + 1 ETF
    expect(companies.map((company) => company.symbol)).toEqual(
      [...companies.map((company) => company.symbol)].sort(),
    );
  });

  // The whole reason for reading tables 35 and 36 as well as 34: these six
  // symbols trade and appear in the price table, so a main-market-only directory
  // would hide them.
  it("includes the GAX companies and the ETF the main table omits", async () => {
    const { companies } = await fetchCompanyDirectory(directoryClient());
    const bySymbol = new Map(companies.map((company) => [company.symbol, company]));

    expect(bySymbol.get("DIGICUT")?.market).toBe("gax");
    expect(bySymbol.get("SAMBA")?.market).toBe("gax");
    expect(bySymbol.get("GLD")?.market).toBe("etf");
    expect(bySymbol.get("MTNGH")?.market).toBe("main");
    // Two Main Market listings the hardcoded seed never had.
    expect(bySymbol.has("FAB")).toBe(true);
    expect(bySymbol.has("ZEN")).toBe(true);
  });

  it("returns a partial directory and names what is missing", async () => {
    const { companies, failedMarkets } = await fetchCompanyDirectory(
      directoryClient({ 36: () => errorResponse(500) }),
    );

    expect(failedMarkets).toEqual(["gax"]);
    expect(companies.length).toBeGreaterThan(30);
    expect(companies.some((company) => company.market === "gax")).toBe(false);
  });

  it("reports a market whose payload is unparseable as failed", async () => {
    const { failedMarkets } = await fetchCompanyDirectory(
      directoryClient({ 35: () => jsonResponse({ notATable: true }) }),
    );

    expect(failedMarkets).toEqual(["etf"]);
  });

  it("throws when no table could be read at all", async () => {
    const client = directoryClient({
      34: () => errorResponse(500),
      35: () => errorResponse(500),
      36: () => errorResponse(500),
    });

    await expect(fetchCompanyDirectory(client)).rejects.toThrow(UpstreamError);
  });
});

describe("searchCompanies", () => {
  it("scores an exact share code highest", () => {
    const [match] = searchCompanies(COMPANY_SEED, "MTNGH");
    expect(match).toMatchObject({ symbol: "MTNGH", score: 1 });
  });

  it("is case- and punctuation-insensitive", () => {
    expect(top("mtngh")).toBe("MTNGH");
    expect(top("cal-bank")).toBe("CAL");
    expect(top("goil plc.")).toBe("GOIL");
  });

  it("resolves the shorthands people actually type", () => {
    expect(top("MTN")).toBe("MTNGH");
    expect(top("gcb bank")).toBe("GCB");
    expect(top("standard chartered")).toBe("SCB");
    expect(top("stanchart")).toBe("SCB");
    expect(top("societe generale")).toBe("SOGEGH");
    expect(top("fan milk")).toBe("FML");
    expect(top("tullow")).toBe("TLW");
    expect(top("unilever")).toBe("UNIL");
    expect(top("totalenergies")).toBe("TOTAL");
  });

  it("matches on a word inside a longer name", () => {
    expect(top("aluworks")).toBe("ALW");
    expect(top("cocoa")).toBe("CPC");
    expect(top("lithium")).toBe("ALLGH");
  });

  it("ranks matches in descending score", () => {
    const scores = searchCompanies(COMPANY_SEED, "bank").map((match) => match.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  it("returns every plausible candidate for a generic query", () => {
    const matches = searchCompanies(COMPANY_SEED, "bank", 30);
    expect(matches.length).toBeGreaterThan(3);
    expect(matches.map((match) => match.symbol)).toContain("GCB");
  });

  it("caps results at the limit", () => {
    expect(searchCompanies(COMPANY_SEED, "bank", 2)).toHaveLength(2);
  });

  it("returns nothing for an unrelated query", () => {
    expect(searchCompanies(COMPANY_SEED, "zzzzzzzzz")).toEqual([]);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(searchCompanies(COMPANY_SEED, "")).toEqual([]);
    expect(searchCompanies(COMPANY_SEED, "   ")).toEqual([]);
  });

  it("scores between 0 and 1", () => {
    for (const query of ["MTN", "bank", "ghana", "standard chartered", "aluwrks"]) {
      for (const match of searchCompanies(COMPANY_SEED, query, 30)) {
        expect(match.score).toBeGreaterThan(0);
        expect(match.score).toBeLessThanOrEqual(1);
      }
    }
  });

  it("still finds a company through a typo in its name", () => {
    expect(searchCompanies(COMPANY_SEED, "aluwrks").map((m) => m.symbol)).toContain("ALW");
  });

  it("distinguishes the preference listing from the ordinary one", () => {
    const symbols = searchCompanies(COMPANY_SEED, "standard chartered", 5).map((m) => m.symbol);
    expect(symbols).toContain("SCB");
    expect(symbols).toContain("SCB PREF");
    // The plain listing is what a caller asking for "standard chartered" wants.
    expect(symbols[0]).toBe("SCB");
  });
});
