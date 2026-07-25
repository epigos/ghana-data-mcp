import { describe, expect, it } from "vitest";

import { ParseError } from "../../../src/lib/errors.js";
import {
  parseBillRatePayload,
  parseBogDate,
  parseInterbankFxPayload,
  parseNumber,
  parseTenorDays,
  resolveCurrencyPair,
} from "../../../src/sources/bog/parser.js";
import { fixtureJson } from "../../helpers/fixtures.js";

const fxPayload = fixtureJson<{ data: string[][] }>("bog-interbank-fx.json");
const tbillPayload = fixtureJson<{ data: string[][] }>("bog-treasury-bill-rates.json");
const bogBillPayload = fixtureJson<{ data: string[][] }>("bog-central-bank-bill-rates.json");
const historyPayload = fixtureJson<{ data: string[][] }>("bog-historical-fx-usd.json");

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

  it("sorts by currency pair within a single date", () => {
    const pairs = parseInterbankFxPayload(fxPayload).rows.map((row) => row.pair);
    expect(pairs).toEqual([...pairs].sort());
  });

  // Upstream returns a historical window newest-first. Every other tool here is
  // oldest-first, and the tool reports `date` from the last row, so getting this
  // backwards would have put the oldest date in a field documented as the newest.
  it("sorts a multi-date window oldest first", () => {
    const { rows } = parseInterbankFxPayload(historyPayload);
    const dates = rows.map((row) => row.date);

    expect(new Set(dates).size).toBeGreaterThan(1);
    expect(dates).toEqual([...dates].sort());
    expect(rows.at(-1)?.date).toBe([...dates].sort().at(-1));
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

describe("parseTenorDays", () => {
  it("reads a day tenor out of the label", () => {
    expect(parseTenorDays("91 DAY BILL")).toBe(91);
    expect(parseTenorDays("364 DAY BILL")).toBe(364);
    expect(parseTenorDays("14 DAY BILL")).toBe(14);
  });

  // Converting "2 YR" to days would invent precision BoG does not publish — a
  // 2-year note is not exactly 730 days and nothing here knows its real maturity.
  it("returns null for securities quoted in years", () => {
    expect(parseTenorDays("2 YR FXR NOTE")).toBeNull();
    expect(parseTenorDays("7 YR FXR BOND")).toBeNull();
  });

  it("returns null for anything it cannot read", () => {
    expect(parseTenorDays("")).toBeNull();
    expect(parseTenorDays("BILL")).toBeNull();
    expect(parseTenorDays("0 DAY BILL")).toBeNull();
  });
});

describe("parseBillRatePayload", () => {
  it("maps the Treasury fixture onto typed rows", () => {
    const { rows, skipped } = parseBillRatePayload(tbillPayload);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(tbillPayload.data.length);
  });

  it("reads the columns the bill tables use", () => {
    const { rows } = parseBillRatePayload(tbillPayload, { securityType: "364 DAY BILL" });

    expect(rows.at(-1)).toEqual({
      date: "2026-07-20",
      tenderNumber: "2016",
      securityType: "364 DAY BILL",
      tenorDays: 364,
      discountRate: 11.5008,
      interestRate: 12.9954,
    });
  });

  it("sorts ascending by date, then by security for a stable order", () => {
    const rows = parseBillRatePayload(tbillPayload).rows;
    const keys = rows.map((row) => `${row.date} ${row.securityType}`);

    expect(keys).toEqual([...keys].sort());
  });

  it("matches a security type by prefix, so partial queries work", () => {
    for (const query of ["91", "91 DAY", "91 DAY BILL", "91 day"]) {
      const { rows } = parseBillRatePayload(tbillPayload, { securityType: query });
      expect(rows.length, query).toBeGreaterThan(0);
      expect(rows.every((row) => row.securityType === "91 DAY BILL"), query).toBe(true);
    }
  });

  it("does not count a filtered-out row as malformed", () => {
    const { rows, skipped } = parseBillRatePayload(tbillPayload, { securityType: "999 DAY" });
    expect(rows).toEqual([]);
    expect(skipped).toBe(0);
  });

  it("handles the central-bank table with the same parser", () => {
    const { rows, skipped } = parseBillRatePayload(bogBillPayload);

    expect(skipped).toBe(0);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toMatchObject({ securityType: "14 DAY BILL", tenorDays: 14 });
  });

  // Tender numbers arrive with thousands separators (`1,517`). They are
  // identifiers, so the separator is noise — and a caller matching on the string
  // should not have to guess whether it is there.
  it("strips thousands separators from the tender number", () => {
    const row = [...(tbillPayload.data[0] as string[])];
    row[1] = "1,517";
    const { rows } = parseBillRatePayload({ data: [row] });

    expect(rows[0]?.tenderNumber).toBe("1517");
  });

  it("omits tenorDays for notes and bonds rather than guessing", () => {
    const row = [...(tbillPayload.data[0] as string[])];
    row[2] = "7 YR FXR BOND";
    const { rows } = parseBillRatePayload({ data: [row] });

    expect(rows[0]?.securityType).toBe("7 YR FXR BOND");
    expect(rows[0]).not.toHaveProperty("tenorDays");
  });

  it("drops a row missing either rate", () => {
    const good = tbillPayload.data[0] as string[];
    for (const index of [3, 4]) {
      const broken = [...good];
      broken[index] = "";
      const { rows, skipped } = parseBillRatePayload({ data: [good, broken] });
      expect(rows, `column ${index}`).toHaveLength(1);
      expect(skipped, `column ${index}`).toBe(1);
    }
  });

  it("drops rows that are the wrong shape or have an unreadable date", () => {
    const bad = [...(tbillPayload.data[0] as string[])];
    bad[0] = "2026-07-20";

    expect(parseBillRatePayload({ data: [bad, ["1"], null] })).toEqual({ rows: [], skipped: 3 });
  });

  it("throws ParseError when the response is not a table payload", () => {
    expect(() => parseBillRatePayload({ rates: [] })).toThrow(ParseError);
  });
});

describe("resolveCurrencyPair", () => {
  // The upstream pair filter matches whole values exactly, so a bare code has to
  // become USDGHS before it is sent or it silently matches nothing.
  it("turns a code into the pair the upstream filter needs", () => {
    expect(resolveCurrencyPair("USD")).toBe("USDGHS");
    expect(resolveCurrencyPair("usd")).toBe("USDGHS");
    expect(resolveCurrencyPair(" gbp ")).toBe("GBPGHS");
  });

  it("passes a full pair through", () => {
    expect(resolveCurrencyPair("USDGHS")).toBe("USDGHS");
    expect(resolveCurrencyPair("usdghs")).toBe("USDGHS");
  });

  it("handles the short west-African codes on this table", () => {
    expect(resolveCurrencyPair("WAU")).toBe("WAUGHS");
  });

  // A name cannot be mapped to a pair without the published list, so the caller
  // filters in memory rather than sending something that matches nothing.
  it("returns null for a currency name", () => {
    expect(resolveCurrencyPair("US Dollar")).toBeNull();
    expect(resolveCurrencyPair("Pound Sterling")).toBeNull();
    expect(resolveCurrencyPair("")).toBeNull();
  });
});
