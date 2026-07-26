import { describe, expect, it } from "vitest";

import { ParseError } from "../../../src/lib/errors.js";
import {
  parseEntitiesPayload,
  parseIndicatorsPayload,
  parseSeriesPayload,
} from "../../../src/sources/imf/parser.js";
import type { EntityMeta } from "../../../src/sources/imf/types.js";
import { fixtureJson } from "../../helpers/fixtures.js";

const indicatorsPayload = fixtureJson("imf-indicators.json");
const seriesPayload = fixtureJson("imf-series-headline.json");
const multiCountryPayload = fixtureJson("imf-series-multi-country.json");
const countriesPayload = fixtureJson("imf-countries.json");
const regionsPayload = fixtureJson("imf-regions.json");
const groupsPayload = fixtureJson("imf-groups.json");

const GHA: EntityMeta = { id: "GHA", label: "Ghana", kind: "country" };
const NGA: EntityMeta = { id: "NGA", label: "Nigeria", kind: "country" };
const SEN: EntityMeta = { id: "SEN", label: "Senegal", kind: "country" };
const AFQ: EntityMeta = { id: "AFQ", label: "Africa (Region)", kind: "region" };
const SSA: EntityMeta = { id: "SSA", label: "Sub-Saharan Africa", kind: "group" };
const ECOWAS: EntityMeta = {
  id: "ECOWAS",
  label: "Economic Community of West African States",
  kind: "group",
};

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

describe("parseEntitiesPayload", () => {
  it("maps the real countries catalog, tagging every entry \"country\"", () => {
    const entities = parseEntitiesPayload(countriesPayload, "country");

    expect(Object.keys(entities)).toHaveLength(241);
    expect(entities.GHA).toEqual({ id: "GHA", label: "Ghana", kind: "country" });
  });

  it("maps the real regions catalog, tagging every entry \"region\"", () => {
    const entities = parseEntitiesPayload(regionsPayload, "region");

    expect(Object.keys(entities)).toHaveLength(27);
    expect(entities.AFQ).toEqual({ id: "AFQ", label: "Africa (Region)", kind: "region" });
  });

  it("maps the real groups catalog, tagging every entry \"group\"", () => {
    const entities = parseEntitiesPayload(groupsPayload, "group");

    expect(Object.keys(entities)).toHaveLength(129);
    expect(entities.ECOWAS).toEqual({
      id: "ECOWAS",
      label: "Economic Community of West African States",
      kind: "group",
    });
  });

  // The real regions catalog has "Sub-Saharan Africa (Region) " (trailing space) and
  // the real groups catalog has "East African Community " (also trailing) — the
  // same messy-label problem stripHtml already exists to solve.
  it("trims a trailing space off a real region/group label", () => {
    const regions = parseEntitiesPayload(regionsPayload, "region");
    const groups = parseEntitiesPayload(groupsPayload, "group");

    expect(regions.SSQ?.label).toBe("Sub-Saharan Africa (Region)");
    expect(groups.EAC?.label).toBe("East African Community");
  });

  it("throws ParseError when the response has no matching key", () => {
    expect(() => parseEntitiesPayload({ indicators: {} }, "country")).toThrow(ParseError);
    expect(() => parseEntitiesPayload("not json", "region")).toThrow(ParseError);
  });
});

describe("parseSeriesPayload", () => {
  it("returns one series per (indicator, entity) pair, oldest first", () => {
    const { series, skipped } = parseSeriesPayload(seriesPayload, ["NGDP_RPCH", "PCPIPCH"], [GHA]);

    expect(skipped).toBe(0);
    expect(series).toHaveLength(2);
    expect(series[0]?.indicatorId).toBe("NGDP_RPCH");
    expect(series[0]?.entityId).toBe("GHA");
    const years = series[0]?.rows.map((r) => r.year) ?? [];
    expect(years).toEqual([...years].sort((a, b) => a - b));
  });

  it("orders the flat list indicators-major, then entities", () => {
    const { series } = parseSeriesPayload(multiCountryPayload, ["NGDP_RPCH", "PCPIPCH"], [NGA, GHA]);

    expect(series.map((s) => `${s.indicatorId}:${s.entityId}`)).toEqual([
      "NGDP_RPCH:NGA",
      "NGDP_RPCH:GHA",
      "PCPIPCH:NGA",
      "PCPIPCH:GHA",
    ]);
  });

  it("carries indicator label, unit, source and dataset through per series", () => {
    const { series } = parseSeriesPayload(seriesPayload, ["GGXWDG_NGDP"], [GHA]);

    expect(series[0]).toMatchObject({
      indicatorId: "GGXWDG_NGDP",
      indicatorLabel: "General government gross debt",
      unit: "Percent of GDP",
      source: "World Economic Outlook (April 2026)",
      dataset: "WEO",
    });
  });

  it("carries entity id, label and kind through per series", () => {
    const { series } = parseSeriesPayload(multiCountryPayload, ["NGDP_RPCH"], [SSA]);

    expect(series[0]).toMatchObject({
      entityId: "SSA",
      entityLabel: "Sub-Saharan Africa",
      entityKind: "group",
    });
  });

  it("reads each entity's own row, not another's", () => {
    const { series } = parseSeriesPayload(multiCountryPayload, ["NGDP_RPCH"], [GHA, NGA, SEN]);
    const byEntity = Object.fromEntries(series.map((s) => [s.entityId, s.rows.find((r) => r.year === 2024)?.value]));

    // Three distinct real values for the same indicator and year — proves each
    // series reads its own entity's row rather than reusing one.
    expect(new Set(Object.values(byEntity)).size).toBe(3);
  });

  // The whole reason isProjection exists: April-2026-vintage WEO data has 2026 as
  // an in-progress estimate and 2027-2031 as genuine forecasts, not actuals. It is
  // an indicator-level property, so it applies identically across entities.
  it("flags years at or after projectionStartYear as projections, for every entity", () => {
    const { series } = parseSeriesPayload(seriesPayload, ["NGDP_RPCH"], [GHA, NGA]);

    for (const s of series) {
      expect(s.projectionStartYear).toBe(2026);
      expect(s.rows.find((r) => r.year === 2025)?.isProjection).toBe(false);
      expect(s.rows.find((r) => r.year === 2026)?.isProjection).toBe(true);
    }
  });

  // Verified against the real API: an indicator with genuinely no forecast horizon
  // (a historical-only dataset) never has any row at or after its own
  // projection-year, so this must not need special-casing to come out false.
  it("never flags a row when the indicator has no data past its projection year", () => {
    const historicalOnly = {
      indicators: { ka_new: { label: "x", "projection-year": 2014, dataset: "CL", source: "s", unit: "u" } },
      values: { ka_new: { GHA: { "2012": 0.5, "2013": 0.5 } } },
    };
    const { series } = parseSeriesPayload(historicalOnly, ["ka_new"], [GHA]);
    expect(series[0]?.rows.every((r) => !r.isProjection)).toBe(true);
  });

  // Confirmed against the live API: LUR (unemployment) covers 122 countries and
  // Ghana is not one of them. That is ordinary "no data", not malformed input.
  it("returns an empty series for a valid indicator with no data for the entity, without counting it skipped", () => {
    const noGhana = {
      indicators: { LUR: { label: "Unemployment", dataset: "WEO", source: "s", unit: "u" } },
      values: { LUR: { USA: { "2020": 5 } } },
    };
    const { series, skipped } = parseSeriesPayload(noGhana, ["LUR"], [GHA]);

    expect(series[0]?.rowCount).toBe(0);
    expect(series[0]?.rows).toEqual([]);
    expect(skipped).toBe(0);
  });

  // Confirmed against the live API: ECOWAS has no aggregate on the general WEO GDP
  // indicator but does on the Africa-specific AFRREO equivalent — region/group
  // coverage is dataset-dependent, not universal, and that must not look like an error.
  it("returns empty for a group with no aggregate on this indicator, but real rows on one that has it", () => {
    const noAggregate = parseSeriesPayload(multiCountryPayload, ["NGDP_RPCH"], [ECOWAS]);
    const hasAggregate = parseSeriesPayload(multiCountryPayload, ["NGDP_R_PCH"], [ECOWAS]);

    expect(noAggregate.series[0]?.rowCount).toBe(0);
    expect(hasAggregate.series[0]?.rowCount).toBeGreaterThan(0);
    expect(hasAggregate.series[0]?.entityKind).toBe("group");
  });

  // The gap runs the other way too: AFQ (a region, not a group) has an aggregate on
  // the general WEO indicator but not on the Africa-specific one — confirming this
  // is genuinely per-(indicator, entity), not just "ECOWAS is special".
  it("returns real rows for a region with an aggregate, empty where it has none", () => {
    const hasAggregate = parseSeriesPayload(multiCountryPayload, ["NGDP_RPCH"], [AFQ]);
    const noAggregate = parseSeriesPayload(multiCountryPayload, ["NGDP_R_PCH"], [AFQ]);

    expect(hasAggregate.series[0]?.rowCount).toBeGreaterThan(0);
    expect(hasAggregate.series[0]?.entityKind).toBe("region");
    expect(noAggregate.series[0]?.rowCount).toBe(0);
  });

  // Confirmed against the live API: an id the API did not recognize is silently
  // absent from both `indicators` and `values` — no error, no placeholder.
  it("returns an empty, id-labelled series for an unrecognized indicator id", () => {
    const { series } = parseSeriesPayload(seriesPayload, ["NOT_A_REAL_INDICATOR"], [GHA]);

    expect(series[0]).toMatchObject({
      indicatorId: "NOT_A_REAL_INDICATOR",
      indicatorLabel: "NOT_A_REAL_INDICATOR",
      unit: "",
      source: "",
      dataset: "",
      entityId: "GHA",
      rowCount: 0,
      rows: [],
    });
  });

  // A request made of nothing but bad ids comes back {"api": {...}} with neither
  // `indicators` nor `values` present at all — confirmed against the live API.
  it("handles a response with neither indicators nor values present", () => {
    const { series, skipped } = parseSeriesPayload({ api: { version: "2" } }, ["NOT_REAL"], [GHA]);

    expect(series).toEqual([
      {
        indicatorId: "NOT_REAL",
        indicatorLabel: "NOT_REAL",
        unit: "",
        source: "",
        dataset: "",
        entityId: "GHA",
        entityLabel: "Ghana",
        entityKind: "country",
        rowCount: 0,
        rows: [],
      },
    ]);
    expect(skipped).toBe(0);
  });

  it("drops a non-numeric or unreadable year/value pair and counts it", () => {
    const dirty = {
      indicators: { X: { label: "X", dataset: "D", source: "s", unit: "u" } },
      values: { X: { GHA: { "2020": 1.5, "2021": "n/a", notayear: 2 } } },
    };
    const { series, skipped } = parseSeriesPayload(dirty, ["X"], [GHA]);

    expect(series[0]?.rows).toEqual([{ year: 2020, value: 1.5, isProjection: false }]);
    expect(skipped).toBe(2);
  });

  it("throws ParseError when the payload itself is not an object", () => {
    expect(() => parseSeriesPayload("not json", ["X"], [GHA])).toThrow(ParseError);
    expect(() => parseSeriesPayload(null, ["X"], [GHA])).toThrow(ParseError);
  });
});

describe("fixture integrity", () => {
  it("confirms the headline fixture carries more than one country per indicator", () => {
    // Guards the "reads Ghana specifically" tests above: if the fixture were ever
    // trimmed down to GHA alone, those tests would pass for the wrong reason.
    const raw = seriesPayload as { values: Record<string, Record<string, unknown>> };
    for (const id of ["NGDP_RPCH", "PCPIPCH", "BCA_NGDPD", "GGXWDG_NGDP"]) {
      const countries = Object.keys(raw.values[id] ?? {});
      expect(countries.length, id).toBeGreaterThan(1);
      expect(countries).toContain("GHA");
    }
  });

  it("confirms the multi-country fixture reproduces the real dataset-dependent ECOWAS gap", () => {
    const raw = multiCountryPayload as { values: Record<string, Record<string, unknown>> };
    expect(Object.keys(raw.values.NGDP_RPCH ?? {})).not.toContain("ECOWAS");
    expect(Object.keys(raw.values.NGDP_R_PCH ?? {})).toContain("ECOWAS");
  });
});
