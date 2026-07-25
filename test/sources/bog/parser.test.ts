import { describe, expect, it } from "vitest";

import { ParseError } from "../../../src/lib/errors.js";
import {
  parseBogDate,
  parseInterbankFxPayload,
  parseNumber,
} from "../../../src/sources/bog/parser.js";
import { fixtureJson } from "../../helpers/fixtures.js";

const fxPayload = fixtureJson<{ data: string[][] }>("bog-interbank-fx.json");

describe("parseBogDate", () => {
  // BoG writes month names (`dd M yy` per its own table config), where GSE writes
  // `24/07/2026`. The two parsers are not interchangeable.
  it("reads BoG's month-name format", () => {
    expect(parseBogDate("24 Jul 2026")).toBe("2026-07-24");
    expect(parseBogDate("07 Aug 2019")).toBe("2019-08-07");
  });

  it("accepts a single-digit day and a full month name", () => {
    expect(parseBogDate("4 Jul 2026")).toBe("2026-07-04");
    expect(parseBogDate("24 July 2026")).toBe("2026-07-24");
  });

  it("is case-insensitive about the month", () => {
    expect(parseBogDate("24 JUL 2026")).toBe("2026-07-24");
    expect(parseBogDate("24 jul 2026")).toBe("2026-07-24");
  });

  it("rejects GSE's slash format, rather than half-reading it", () => {
    expect(parseBogDate("24/07/2026")).toBeNull();
  });

  it("rejects impossible and malformed dates", () => {
    for (const input of ["31 Feb 2026", "32 Jan 2026", "24 Xxx 2026", "2026-07-24", "", 42, null]) {
      expect(parseBogDate(input as unknown), String(input)).toBeNull();
    }
  });
});

describe("parseNumber", () => {
  it("strips thousands separators", () => {
    expect(parseNumber("11,568.42")).toBe(11_568.42);
  });

  it("keeps small decimals exactly", () => {
    expect(parseNumber("0.0126")).toBe(0.0126);
  });

  it("returns null for blanks and non-numbers", () => {
    for (const input of ["", "  ", "-", "N/A", "n/a", undefined, {}]) {
      expect(parseNumber(input as unknown)).toBeNull();
    }
  });
});

describe("parseInterbankFxPayload", () => {
  it("maps the live fixture onto typed rows", () => {
    const { rows, skipped } = parseInterbankFxPayload(fxPayload);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(19);
  });

  it("reads the columns the FX table uses", () => {
    // Fixture row: ['24 Jul 2026','US Dollar','USDGHS','11.6292','11.6408','11.6350']
    const { rows } = parseInterbankFxPayload(fxPayload, { currency: "USD" });

    expect(rows[0]).toEqual({
      date: "2026-07-24",
      currency: "US Dollar",
      code: "USD",
      pair: "USDGHS",
      bid: 11.6292,
      offer: 11.6408,
      mid: 11.635,
    });
  });

  it("derives the currency code by stripping the GHS quote side", () => {
    const { rows } = parseInterbankFxPayload(fxPayload);
    const codes = rows.map((row) => row.code);

    expect(codes).toContain("USD");
    expect(codes).toContain("GBP");
    expect(codes).toContain("EUR");
    // Every pair on this table is quoted against the cedi, so no code keeps it.
    expect(codes.every((code) => !code.endsWith("GHS"))).toBe(true);
  });

  it("sorts by currency pair for a stable order", () => {
    const pairs = parseInterbankFxPayload(fxPayload).rows.map((row) => row.pair);
    expect(pairs).toEqual([...pairs].sort());
  });

  it("covers the west-African currencies BoG publishes alongside the majors", () => {
    const { rows } = parseInterbankFxPayload(fxPayload);
    const names = rows.map((row) => row.currency);

    // Naira, Leone and the CFA/ECOWAS units matter for a Ghanaian audience and are
    // easy to lose if a parser assumes ISO majors only.
    expect(names).toContain("Naira");
    expect(names).toContain("Leone");
  });

  it("filters by code or by published name", () => {
    expect(parseInterbankFxPayload(fxPayload, { currency: "gbp" }).rows).toHaveLength(1);
    expect(parseInterbankFxPayload(fxPayload, { currency: "Pound Sterling" }).rows).toHaveLength(1);
  });

  it("returns nothing for an unknown currency, without counting it as malformed", () => {
    const { rows, skipped } = parseInterbankFxPayload(fxPayload, { currency: "XYZ" });
    expect(rows).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("drops a row missing any of bid, offer or mid", () => {
    const good = fxPayload.data[0] as string[];
    for (const index of [3, 4, 5]) {
      const broken = [...good];
      broken[index] = "";
      const { rows, skipped } = parseInterbankFxPayload({ data: [good, broken] });
      expect(rows, `column ${index}`).toHaveLength(1);
      expect(skipped, `column ${index}`).toBe(1);
    }
  });

  it("drops rows that are the wrong shape or have an unreadable date", () => {
    const bad = [...(fxPayload.data[0] as string[])];
    bad[0] = "not-a-date";

    expect(parseInterbankFxPayload({ data: [bad, ["1", "2"], null] })).toEqual({
      rows: [],
      skipped: 3,
    });
  });

  it("throws ParseError when the response is not a table payload", () => {
    expect(() => parseInterbankFxPayload({ rates: [] })).toThrow(ParseError);
    expect(() => parseInterbankFxPayload("-1")).toThrow(ParseError);
  });
});

describe("fixture integrity", () => {
  // recordsFiltered (19) being far below recordsTotal (144457) is the evidence
  // that BoG restricts this table to the latest date — the reason the tool takes
  // no date range. If a future fixture loses that, the reasoning is unverifiable.
  it("preserves the counts that show the table is latest-date-only", () => {
    const raw = fxPayload as unknown as { recordsTotal: string; recordsFiltered: string };
    expect(Number(raw.recordsFiltered)).toBe(fxPayload.data.length);
    expect(Number(raw.recordsTotal)).toBeGreaterThan(Number(raw.recordsFiltered) * 100);
  });

  it("keeps the 6-column layout the parser assumes", () => {
    for (const row of fxPayload.data) expect(row).toHaveLength(6);
  });

  it("holds a single publication date", () => {
    expect(new Set(fxPayload.data.map((row) => row[0])).size).toBe(1);
  });
});
