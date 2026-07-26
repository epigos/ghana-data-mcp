import { describe, expect, it } from "vitest";

import { ParseError } from "../../../src/lib/errors.js";
import { parseIndicatorsPayload, parseSeriesPayload } from "../../../src/sources/imf/parser.js";
import { fixtureJson } from "../../helpers/fixtures.js";

const indicatorsPayload = fixtureJson("imf-indicators.json");
const seriesPayload = fixtureJson("imf-series-headline.json");

describe("parseIndicatorsPayload", () => {
  it("maps the real catalog onto typed metadata, one entry per indicator", () => {
    const { indicators } = parseIndicatorsPayload(indicatorsPayload);
    expect(Object.keys(indicators)).toHaveLength(132);
  });

  it("reads label, description, unit, source and dataset", () => {
    const { indicators } = parseIndicatorsPayload(indicatorsPayload);

    expect(indicators.NGDP_RPCH).toEqual({
      id: "NGDP_RPCH",
      label: "Real GDP growth",
      description: expect.stringContaining("Gross domestic product"),
      unit: "Annual percent change",
      source: "World Economic Outlook (April 2026)",
      dataset: "WEO",
    });
  });

  // `rgc` genuinely has unit: null in the live catalog (a bare growth-rate percent
  // in the FPP dataset). A schema hole would be worse than an empty string here.
  it("turns a null unit into an empty string rather than a hole", () => {
    const { indicators } = parseIndicatorsPayload(indicatorsPayload);
    expect(indicators.rgc?.unit).toBe("");
    expect(typeof indicators.rgc?.unit).toBe("string");
  });

  // GDI_TC's real description carries a stray newline and an inline <b> tag.
  it("cleans embedded HTML and newlines out of the description", () => {
    const { indicators } = parseIndicatorsPayload(indicatorsPayload);
    expect(indicators.GDI_TC?.description).not.toMatch(/<[^>]+>/);
    expect(indicators.GDI_TC?.description).toBe(
      "The GDI generally ranges from 0-1, with higher numbers signifying more equality Note: Line charts below indicate average index value in each group",
    );
  });

  // NGDPDPC's real label in the catalog is "GDP per capita, current prices\n".
  it("cleans a trailing newline out of a label", () => {
    const { indicators } = parseIndicatorsPayload(indicatorsPayload);
    expect(indicators.NGDPDPC?.label).toBe("GDP per capita, current prices");
  });

  it("throws ParseError when the response has no indicators object", () => {
    expect(() => parseIndicatorsPayload({ values: {} })).toThrow(ParseError);
    expect(() => parseIndicatorsPayload("not json")).toThrow(ParseError);
    expect(() => parseIndicatorsPayload(null)).toThrow(ParseError);
  });
});

describe("parseSeriesPayload", () => {
  it("returns one series per requested id, oldest first", () => {
    const { series, skipped } = parseSeriesPayload(seriesPayload, ["NGDP_RPCH", "PCPIPCH"]);

    expect(skipped).toBe(0);
    expect(series).toHaveLength(2);
    expect(series[0]?.id).toBe("NGDP_RPCH");
    const years = series[0]?.rows.map((r) => r.year) ?? [];
    expect(years).toEqual([...years].sort((a, b) => a - b));
  });

  it("carries label, unit, source and dataset through per indicator", () => {
    const { series } = parseSeriesPayload(seriesPayload, ["GGXWDG_NGDP"]);

    expect(series[0]).toMatchObject({
      id: "GGXWDG_NGDP",
      label: "General government gross debt",
      unit: "Percent of GDP",
      source: "World Economic Outlook (April 2026)",
      dataset: "WEO",
    });
  });

  it("reads Ghana's own row, not another country's", () => {
    const { series } = parseSeriesPayload(seriesPayload, ["NGDP_RPCH"]);
    const row2026 = series[0]?.rows.find((r) => r.year === 2026);

    // Fixture also carries NGA (Nigeria) and AFQ (Africa region) under the same
    // indicator, at different values — this proves we read GHA specifically.
    expect(row2026?.value).toBe(4.8);
  });

  // The whole reason isProjection exists: April-2026-vintage WEO data has 2026 as
  // an in-progress estimate and 2027-2031 as genuine forecasts, not actuals.
  it("flags years at or after projectionStartYear as projections", () => {
    const { series } = parseSeriesPayload(seriesPayload, ["NGDP_RPCH"]);
    const [s] = series;

    expect(s?.projectionStartYear).toBe(2026);
    expect(s?.rows.find((r) => r.year === 2025)?.isProjection).toBe(false);
    expect(s?.rows.find((r) => r.year === 2026)?.isProjection).toBe(true);
    expect(s?.rows.find((r) => r.year === 2031)?.isProjection).toBe(true);
  });

  // Verified against the real API: an indicator with genuinely no forecast horizon
  // (a historical-only dataset) never has any row at or after its own
  // projection-year, so this must not need special-casing to come out false.
  it("never flags a row when the indicator has no data past its projection year", () => {
    const historicalOnly = {
      indicators: { ka_new: { label: "x", "projection-year": 2014, dataset: "CL", source: "s", unit: "u" } },
      values: { ka_new: { GHA: { "2012": 0.5, "2013": 0.5 } } },
    };
    const { series } = parseSeriesPayload(historicalOnly, ["ka_new"]);
    expect(series[0]?.rows.every((r) => !r.isProjection)).toBe(true);
  });

  // Confirmed against the live API: LUR (unemployment) covers 122 countries and
  // Ghana is not one of them. That is ordinary "no data", not malformed input.
  it("returns an empty series for a valid indicator with no Ghana data, without counting it skipped", () => {
    const noGhana = { indicators: { LUR: { label: "Unemployment", dataset: "WEO", source: "s", unit: "u" } }, values: { LUR: { USA: { "2020": 5 } } } };
    const { series, skipped } = parseSeriesPayload(noGhana, ["LUR"]);

    expect(series[0]?.rowCount).toBe(0);
    expect(series[0]?.rows).toEqual([]);
    expect(skipped).toBe(0);
  });

  // Confirmed against the live API: an id the API did not recognize is silently
  // absent from both `indicators` and `values` — no error, no placeholder.
  it("returns an empty, id-labelled series for an unrecognized indicator id", () => {
    const { series } = parseSeriesPayload(seriesPayload, ["NOT_A_REAL_INDICATOR"]);

    expect(series[0]).toMatchObject({
      id: "NOT_A_REAL_INDICATOR",
      label: "NOT_A_REAL_INDICATOR",
      unit: "",
      source: "",
      dataset: "",
      rowCount: 0,
      rows: [],
    });
  });

  // A request made of nothing but bad ids comes back {"api": {...}} with neither
  // `indicators` nor `values` present at all — confirmed against the live API.
  it("handles a response with neither indicators nor values present", () => {
    const { series, skipped } = parseSeriesPayload({ api: { version: "2" } }, ["NOT_REAL"]);

    expect(series).toEqual([
      { id: "NOT_REAL", label: "NOT_REAL", unit: "", source: "", dataset: "", rowCount: 0, rows: [] },
    ]);
    expect(skipped).toBe(0);
  });

  it("drops a non-numeric or unreadable year/value pair and counts it", () => {
    const dirty = {
      indicators: { X: { label: "X", dataset: "D", source: "s", unit: "u" } },
      values: { X: { GHA: { "2020": 1.5, "2021": "n/a", notayear: 2 } } },
    };
    const { series, skipped } = parseSeriesPayload(dirty, ["X"]);

    expect(series[0]?.rows).toEqual([{ year: 2020, value: 1.5, isProjection: false }]);
    expect(skipped).toBe(2);
  });

  it("throws ParseError when the payload itself is not an object", () => {
    expect(() => parseSeriesPayload("not json", ["X"])).toThrow(ParseError);
    expect(() => parseSeriesPayload(null, ["X"])).toThrow(ParseError);
  });
});

describe("fixture integrity", () => {
  it("confirms the headline fixture carries more than one country per indicator", () => {
    // Guards the "reads Ghana specifically" test above: if the fixture were ever
    // trimmed down to GHA alone, that test would pass for the wrong reason.
    const raw = seriesPayload as { values: Record<string, Record<string, unknown>> };
    for (const id of ["NGDP_RPCH", "PCPIPCH", "BCA_NGDPD", "GGXWDG_NGDP"]) {
      const countries = Object.keys(raw.values[id] ?? {});
      expect(countries.length, id).toBeGreaterThan(1);
      expect(countries).toContain("GHA");
    }
  });
});
