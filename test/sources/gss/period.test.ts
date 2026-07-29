import { describe, expect, it } from "vitest";

import {
  filterByGranularity,
  latestPeriods,
  matchPeriod,
  parsePeriod,
  parsePeriods,
  periodsInRange,
  sortChronologically,
} from "../../../src/sources/gss/period.js";
import { fixtureJson } from "../../helpers/fixtures.js";

interface PxSchema {
  title: string;
  variables: Array<{ code: string; values: string[]; time?: boolean }>;
}

const miegSchema = fixtureJson<PxSchema>("gss-mieg-schema.json");
const tradeSchema = fixtureJson<PxSchema>("gss-trade-schema.json");
const gdpSchema = fixtureJson<PxSchema>("gss-gdp-expenditure-schema.json");

const axisOf = (schema: PxSchema, code: string) =>
  schema.variables.find((v) => v.code === code)!.values;

describe("parsePeriod", () => {
  it("reads the three period shapes StatsBank uses", () => {
    expect(parsePeriod("2023")).toMatchObject({ granularity: "annual", year: 2023, index: 1 });
    expect(parsePeriod("2024Q2")).toMatchObject({ granularity: "quarterly", year: 2024, index: 2 });
    expect(parsePeriod("2024M06")).toMatchObject({ granularity: "monthly", year: 2024, index: 6 });
  });

  // The GDP tables mark unfinalized years with asterisks, and the asterisks are part
  // of the value the API accepts. Both facts have to survive parsing.
  it("keeps the exact code but strips markers from the label, flagging provisional", () => {
    expect(parsePeriod("2024*")).toMatchObject({ code: "2024*", label: "2024", provisional: true });
    expect(parsePeriod("2025**")).toMatchObject({ code: "2025**", label: "2025", provisional: true });
    expect(parsePeriod("2023")).toMatchObject({ code: "2023", label: "2023", provisional: false });
  });

  it("zero-pads a single-digit month so labels sort as strings too", () => {
    expect(parsePeriod("2024M6")?.label).toBe("2024M06");
  });

  it("rejects a shape it does not recognize rather than guessing", () => {
    for (const bad of ["", "   ", "not-a-period", "2024M13", "2024M00", "2024Q5", "24M01"]) {
      expect(parsePeriod(bad), bad).toBeUndefined();
    }
  });

  it("drops unparseable codes when parsing a whole axis", () => {
    expect(parsePeriods(["2024M01", "junk", "2024M02"]).map((p) => p.label)).toEqual([
      "2024M01",
      "2024M02",
    ]);
  });
});

describe("sortChronologically", () => {
  it("puts an axis stored newest-first back into oldest-first order", () => {
    const sorted = sortChronologically(parsePeriods(["2024M06", "2024M05", "2023M12"]));
    expect(sorted.map((p) => p.label)).toEqual(["2023M12", "2024M05", "2024M06"]);
  });

  it("sorts a coarser period before the finer ones inside the same year", () => {
    const sorted = sortChronologically(parsePeriods(["2023Q1", "2023", "2023M02"]));
    expect(sorted.map((p) => p.label)).toEqual(["2023", "2023Q1", "2023M02"]);
  });
});

describe("latestPeriods", () => {
  // This is the whole reason the module exists. PxWeb's documented `filter: "top"`
  // takes the first N values in *storage* order. Most StatsBank tables are stored
  // newest-first so it looks like "latest N" — but mieg is stored oldest-first, and
  // there `top: 3` returns 2023M01-M03, whose growth values are all 0.0. Silently
  // wrong data with no error. latestPeriods sorts first, so it cannot make that
  // mistake on any table.
  it("returns the genuinely most recent periods on an axis stored oldest-first", () => {
    const axis = parsePeriods(axisOf(miegSchema, "Month"));
    const raw = axisOf(miegSchema, "Month");

    // Guard the premise: this fixture really is stored oldest-first.
    expect(raw[0]).toBe("2023M01");
    expect(raw[raw.length - 1]).toBe("2026M04");

    const latest = latestPeriods(axis, 3);
    expect(latest.map((p) => p.label)).toEqual(["2026M02", "2026M03", "2026M04"]);
    // What `filter: "top"` would have returned instead:
    expect(latest.map((p) => p.label)).not.toContain("2023M01");
  });

  it("returns oldest-first within the selection", () => {
    const axis = parsePeriods(["2024M03", "2024M01", "2024M02"]);
    expect(latestPeriods(axis, 2).map((p) => p.label)).toEqual(["2024M02", "2024M03"]);
  });

  it("returns the whole axis when asked for more than exists", () => {
    expect(latestPeriods(parsePeriods(["2024M01", "2024M02"]), 99)).toHaveLength(2);
  });
});

describe("filterByGranularity", () => {
  // macro_trade interleaves quarters and months on one axis: a live top-5 returns
  // 2025Q4, 2025M12, 2025M11, 2025M10, 2025Q3. Charting that sums a quarter and the
  // months inside it, double-counting the same trade.
  it("separates the interleaved granularities on a mixed axis", () => {
    const axis = parsePeriods(axisOf(tradeSchema, "Time_Period"));
    const quarterly = filterByGranularity(axis, "quarterly");
    const monthly = filterByGranularity(axis, "monthly");

    expect(quarterly.length).toBeGreaterThan(0);
    expect(monthly.length).toBeGreaterThan(0);
    expect(quarterly.every((p) => p.granularity === "quarterly")).toBe(true);
    expect(monthly.every((p) => p.granularity === "monthly")).toBe(true);
    // Neither slice alone equals the raw axis — proving the mix is real.
    expect(quarterly.length + monthly.length).toBeLessThanOrEqual(axis.length);
  });

  it("makes latest-N meaningful once a granularity is chosen", () => {
    const axis = parsePeriods(axisOf(tradeSchema, "Time_Period"));
    const latest = latestPeriods(filterByGranularity(axis, "quarterly"), 3);
    expect(latest.every((p) => p.granularity === "quarterly")).toBe(true);
  });
});

describe("matchPeriod", () => {
  const gdpAxis = parsePeriods(axisOf(gdpSchema, "Year"));
  const monthlyAxis = parsePeriods(["2024M06", "2024M05"]);

  // A caller who asks for "2024" on a GDP table would otherwise get a 404, because
  // the axis actually reads "2024*".
  it("matches a bare year against a provisional-marked axis value", () => {
    const hit = matchPeriod("2024", gdpAxis);
    expect(hit?.code).toBe("2024*");
    expect(hit?.provisional).toBe(true);
  });

  it("matches the exact upstream code too", () => {
    expect(matchPeriod("2025**", gdpAxis)?.code).toBe("2025**");
  });

  it("tolerates separator and case variants of a month", () => {
    for (const spelling of ["2024M06", "2024m06", "2024M6", "2024-06", "2024 M06"]) {
      expect(matchPeriod(spelling, monthlyAxis)?.label, spelling).toBe("2024M06");
    }
  });

  it("tolerates quarter variants", () => {
    const axis = parsePeriods(["2024Q2"]);
    for (const spelling of ["2024Q2", "2024q2", "2024-Q2"]) {
      expect(matchPeriod(spelling, axis)?.label, spelling).toBe("2024Q2");
    }
  });

  it("returns undefined for a period the axis does not have", () => {
    expect(matchPeriod("1899M01", monthlyAxis)).toBeUndefined();
    expect(matchPeriod("garbage", monthlyAxis)).toBeUndefined();
  });
});

describe("periodsInRange", () => {
  const axis = parsePeriods(["2024M01", "2024M02", "2024M03", "2024M04"]);

  it("filters inclusively on both bounds", () => {
    const { periods, unmatched } = periodsInRange(axis, "2024M02", "2024M03");
    expect(periods.map((p) => p.label)).toEqual(["2024M02", "2024M03"]);
    expect(unmatched).toEqual([]);
  });

  it("treats an omitted bound as open-ended", () => {
    expect(periodsInRange(axis, "2024M03", undefined).periods.map((p) => p.label)).toEqual([
      "2024M03",
      "2024M04",
    ]);
    expect(periodsInRange(axis, undefined, "2024M02").periods.map((p) => p.label)).toEqual([
      "2024M01",
      "2024M02",
    ]);
  });

  it("reports a bound it could not place instead of silently widening the range", () => {
    const { unmatched } = periodsInRange(axis, "1999M01", undefined);
    expect(unmatched).toEqual(["1999M01"]);
  });

  it("resolves bounds through the provisional-marker tolerance", () => {
    const gdpAxis = parsePeriods(axisOf(gdpSchema, "Year"));
    const { periods, unmatched } = periodsInRange(gdpAxis, "2023", "2025");
    expect(unmatched).toEqual([]);
    expect(periods.map((p) => p.code)).toEqual(["2023", "2024*", "2025**"]);
  });
});
