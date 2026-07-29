import { describe, expect, it } from "vitest";

import { ParseError } from "../../../src/lib/errors.js";
import { granularitiesOf, parseTableData, parseTableSchema } from "../../../src/sources/gss/parser.js";
import { findTable, type TableDef } from "../../../src/sources/gss/tables.js";
import { fixtureJson } from "../../helpers/fixtures.js";

const fuelSchema = fixtureJson("gss-fuel-schema.json");
const cpiSchema = fixtureJson("gss-cpi-schema.json");
const tradeSchema = fixtureJson("gss-trade-schema.json");
const gdpSchema = fixtureJson("gss-gdp-expenditure-schema.json");
const fuelData = fixtureJson("gss-fuel-data.json");
const cpiData = fixtureJson("gss-cpi-data.json");
const gdpData = fixtureJson("gss-gdp-expenditure-data.json");

const FUEL = findTable("fuel") as TableDef;
const CPI = findTable("cpi") as TableDef;
const TRADE = findTable("trade") as TableDef;
const GDP = findTable("gdp_expenditure") as TableDef;

describe("parseTableSchema", () => {
  it("splits the time axis from the filterable dimensions", () => {
    const parsed = parseTableSchema(fuelSchema, FUEL);

    expect(parsed.title).toBe("Fuel Consumption");
    expect(parsed.dimensions.map((d) => d.code)).toEqual(["Fuel"]);
    expect(parsed.periods.length).toBeGreaterThan(300);
    expect(parsed.dimensions[0]?.values).toContain("Total petroleum consumption");
    expect(parsed.dimensions[0]?.valueCount).toBe(parsed.dimensions[0]?.values.length);
  });

  it("returns the axis oldest-first regardless of how upstream stored it", () => {
    const parsed = parseTableSchema(fuelSchema, FUEL);
    const first = parsed.periods[0]!;
    const last = parsed.periods[parsed.periods.length - 1]!;

    expect(first.label).toBe("1999M01");
    expect(last.label).toBe("2024M06");
  });

  // cpi lists Indicator before Month; a parser keyed on position rather than the
  // declared time variable would treat "Consumer Price Index" as a period.
  it("finds the time axis by name even when it is not the first variable", () => {
    const parsed = parseTableSchema(cpiSchema, CPI);

    expect(parsed.dimensions.map((d) => d.code)).toEqual(["Indicator", "Region", "Product", "Source"]);
    expect(parsed.periods.every((p) => p.granularity === "monthly")).toBe(true);
    expect(parsed.dimensions.find((d) => d.code === "Region")?.values).toContain("Ashanti");
  });

  it("keeps the provisional markers on the GDP axis codes", () => {
    const parsed = parseTableSchema(gdpSchema, GDP);
    const codes = parsed.periods.map((p) => p.code);

    expect(codes).toContain("2024*");
    expect(codes).toContain("2025**");
    expect(parsed.periods.find((p) => p.code === "2024*")?.provisional).toBe(true);
    expect(parsed.periods.find((p) => p.code === "2023")?.provisional).toBe(false);
  });

  it("reports both granularities on a mixed axis", () => {
    const parsed = parseTableSchema(tradeSchema, TRADE);
    const granularities = granularitiesOf(parsed.periods);

    expect(granularities).toContain("quarterly");
    expect(granularities).toContain("monthly");
  });

  it("throws ParseError when the variables array is missing or the payload is not an object", () => {
    expect(() => parseTableSchema({ title: "x" }, FUEL)).toThrow(ParseError);
    expect(() => parseTableSchema("not json", FUEL)).toThrow(ParseError);
    expect(() => parseTableSchema(null, FUEL)).toThrow(ParseError);
  });

  // A renamed or removed time axis must fail loudly; silently treating it as a
  // dimension would produce a table with no periods and a confusing empty result.
  it("throws ParseError when the declared time variable is absent", () => {
    const noMonth = { title: "x", variables: [{ code: "Fuel", text: "Fuel", values: ["a"] }] };
    expect(() => parseTableSchema(noMonth, FUEL)).toThrow(/no readable `Month` axis/);
  });
});

describe("parseTableData", () => {
  it("flattens observations into self-describing rows", () => {
    const parsed = parseTableData(fuelData, FUEL);

    expect(parsed.source).toBe("National Petroleum Authority (NPA)");
    expect(parsed.updated).toBe("2024-08-26T13:08:00Z");
    expect(parsed.skipped).toBe(0);
    expect(parsed.rows.length).toBe(22);

    const row = parsed.rows.find(
      (r) => r.period === "2024M06" && r.dimensions.Fuel === "Total petroleum consumption",
    );
    expect(row).toMatchObject({
      period: "2024M06",
      granularity: "monthly",
      provisional: false,
      measure: "Fuel Consumption",
      value: 410505.11,
    });
  });

  // PxWeb returns storage order, which is newest-first for cpi. DataResultSchema
  // promises oldest-first, matching every other source in this repo, so the parser
  // has to normalize rather than pass the table's own order through.
  it("returns rows oldest-first even though PxWeb sends them newest-first", () => {
    const raw = (cpiData as { data: Array<{ key: string[] }> }).data;
    // Guard the premise: the fixture really is newest-first upstream.
    expect(raw[0]!.key).toContain("2026M01");
    expect(raw[raw.length - 1]!.key).toContain("2025M12");

    const parsed = parseTableData(cpiData, CPI);
    const periods = [...new Set(parsed.rows.map((r) => r.period))];
    expect(periods).toEqual(["2025M12", "2026M01"]);
  });

  it("keeps rows sharing a period in their original order so dimensions stay grouped", () => {
    const parsed = parseTableData(cpiData, CPI);
    const jan = parsed.rows.filter((r) => r.period === "2026M01").map((r) => r.dimensions.Region);
    expect(jan).toEqual(["Ghana", "Ashanti"]);
  });

  it("carries every non-time dimension onto each row", () => {
    const parsed = parseTableData(cpiData, CPI);
    const ghana = parsed.rows.find((r) => r.period === "2026M01" && r.dimensions.Region === "Ghana");

    expect(ghana?.dimensions).toEqual({
      Indicator: "Year-on-year inflation (%)",
      Region: "Ghana",
      Product: "All products",
      Source: "All sources",
    });
    expect(ghana?.value).toBe(3.8);
  });

  it("reads each region's own value rather than reusing one", () => {
    const parsed = parseTableData(cpiData, CPI);
    const byRegion = Object.fromEntries(
      parsed.rows.filter((r) => r.period === "2026M01").map((r) => [r.dimensions.Region, r.value]),
    );

    expect(byRegion.Ghana).toBe(3.8);
    expect(byRegion.Ashanti).toBe(4.0);
  });

  // The reason provisional is per-row rather than per-table: one response can hold a
  // final year, a provisional one and a forecast.
  it("flags provisional and forecast years while leaving finalized ones alone", () => {
    const parsed = parseTableData(gdpData, GDP);
    const byPeriod = Object.fromEntries(parsed.rows.map((r) => [r.period, r]));

    expect(byPeriod["2023"]).toMatchObject({ provisional: false, value: 3.1 });
    expect(byPeriod["2024"]).toMatchObject({ provisional: true, value: 5.8 });
    expect(byPeriod["2025"]).toMatchObject({ provisional: true, value: 6.0 });
  });

  // A genuine 0.00 and an unavailable ".." must not become the same number. Averaging
  // a fabricated zero into a series is the failure this guards.
  it("keeps a real zero but drops a missing-data marker, counting it skipped", () => {
    const withMarkers = {
      columns: [
        { code: "Month", text: "Month", type: "t" },
        { code: "Fuel", text: "Fuel", type: "d" },
        { code: "Fuel Consumption", text: "Fuel Consumption", type: "c" },
      ],
      data: [
        { key: ["2024M01", "Kerosene"], values: ["0.00"] },
        { key: ["2024M02", "Kerosene"], values: [".."] },
        { key: ["2024M03", "Kerosene"], values: ["-"] },
        { key: ["2024M04", "Kerosene"], values: [""] },
      ],
      metadata: [{ label: "Fuel Consumption", source: "NPA" }],
    };
    const parsed = parseTableData(withMarkers, FUEL);

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]).toMatchObject({ period: "2024M01", value: 0 });
    expect(parsed.skipped).toBe(3);
  });

  it("drops an observation whose period does not parse and counts it", () => {
    const dirty = {
      columns: [
        { code: "Month", text: "Month", type: "t" },
        { code: "Fuel", text: "Fuel", type: "d" },
        { code: "Fuel Consumption", text: "Fuel Consumption", type: "c" },
      ],
      data: [
        { key: ["notaperiod", "Kerosene"], values: ["1.0"] },
        { key: ["2024M01", "Kerosene"], values: ["2.0"] },
      ],
      metadata: [{ source: "NPA" }],
    };
    const parsed = parseTableData(dirty, FUEL);

    expect(parsed.rows).toHaveLength(1);
    expect(parsed.skipped).toBe(1);
  });

  it("emits one row per content column when a table has several", () => {
    const twoMeasures = {
      columns: [
        { code: "Month", text: "Month", type: "t" },
        { code: "Fuel", text: "Fuel", type: "d" },
        { code: "Volume", text: "Volume", type: "c" },
        { code: "Value", text: "Value", type: "c" },
      ],
      data: [{ key: ["2024M01", "Kerosene"], values: ["10.5", "99.1"] }],
      metadata: [{ source: "NPA" }],
    };
    const parsed = parseTableData(twoMeasures, FUEL);

    expect(parsed.rows.map((r) => [r.measure, r.value])).toEqual([
      ["Volume", 10.5],
      ["Value", 99.1],
    ]);
  });

  it("throws ParseError on a payload with no usable columns", () => {
    expect(() => parseTableData({ data: [] }, FUEL)).toThrow(ParseError);
    expect(() => parseTableData("not json", FUEL)).toThrow(ParseError);
    expect(() => parseTableData(null, FUEL)).toThrow(ParseError);
  });

  it("throws ParseError when the response has no column for the declared time axis", () => {
    const noTime = {
      columns: [
        { code: "Fuel", text: "Fuel", type: "d" },
        { code: "Fuel Consumption", text: "Fuel Consumption", type: "c" },
      ],
      data: [],
      metadata: [],
    };
    expect(() => parseTableData(noTime, FUEL)).toThrow(/no `Month` column/);
  });

  it("falls back to the PxWeb time-typed column if the axis was renamed upstream", () => {
    const renamed = {
      columns: [
        { code: "Periode", text: "Periode", type: "t" },
        { code: "Fuel", text: "Fuel", type: "d" },
        { code: "Fuel Consumption", text: "Fuel Consumption", type: "c" },
      ],
      data: [{ key: ["2024M01", "Kerosene"], values: ["1.5"] }],
      metadata: [{ source: "NPA" }],
    };
    const parsed = parseTableData(renamed, FUEL);
    expect(parsed.rows[0]).toMatchObject({ period: "2024M01", value: 1.5 });
  });
});

describe("fixture integrity", () => {
  it("confirms the cpi fixture really lists Month after Indicator", () => {
    // Guards the "finds the time axis by name" test above: if the fixture were ever
    // replaced with one where Month comes first, that test would pass for free.
    const codes = (cpiSchema as { variables: Array<{ code: string }> }).variables.map((v) => v.code);
    expect(codes.indexOf("Month")).toBeGreaterThan(0);
  });

  it("confirms the cpi data fixture also puts Month after Indicator", () => {
    const codes = (cpiData as { columns: Array<{ code: string }> }).columns.map((c) => c.code);
    expect(codes.indexOf("Month")).toBeGreaterThan(0);
  });

  it("confirms the gdp fixture carries all three finality states", () => {
    const codes = (gdpSchema as { variables: Array<{ code: string; values: string[] }> }).variables
      .find((v) => v.code === "Year")!
      .values;
    expect(codes).toContain("2023");
    expect(codes.some((c) => /^\d{4}\*$/.test(c))).toBe(true);
    expect(codes.some((c) => /^\d{4}\*\*$/.test(c))).toBe(true);
  });
});
