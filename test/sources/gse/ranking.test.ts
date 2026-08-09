import { describe, expect, it } from "vitest";

import { parseHistoryPayload } from "../../../src/sources/gse/parser.js";
import {
  rankStocks,
  summarizeWindow,
  trimToWindow,
  windowBucket,
  windowStartDate,
  WINDOW_BUCKETS,
} from "../../../src/sources/gse/ranking.js";
import type { StockPriceRow } from "../../../src/sources/gse/types.js";
import { fixtureJson } from "../../helpers/fixtures.js";

/**
 * The fixture is five real consecutive GSE sessions (3–7 Aug 2026) for ten real
 * securities, chosen because between them they carry every hazard this module
 * exists to handle:
 *
 *   ACCESS, ALLGH   traded on all five sessions
 *   ALW, ASG, PBC,
 *   TBL, SAMBA      quoted all five sessions, never traded
 *   BOPP            untraded on the first two sessions, then traded
 *   CMLT            traded on the first session only
 *   SCBPREF         a preference share that must not collapse into SCB
 *
 * ALW and PBC are stored upstream as `**ALW**` and `PBC**`.
 */
const marketPayload = fixtureJson("market-history-5d.json");

const rowsOf = () => parseHistoryPayload(marketPayload).rows;
const summaryOf = () => summarizeWindow(rowsOf());
const bySymbol = (summary = summaryOf()) =>
  Object.fromEntries(summary.symbols.map((entry) => [entry.symbol, entry]));

const defaults = { metric: "percentReturn" as const, order: "desc" as const, limit: 10, minTradingDays: 1 };

/** Minimal row builder for the pathological cases real data does not contain. */
function row(over: Partial<StockPriceRow> & { symbol: string; date: string }): StockPriceRow {
  return {
    high: 1, low: 1, open: 1, close: 1, change: 0, volume: 0,
    ...over,
  } as StockPriceRow;
}

describe("summarizeWindow", () => {
  it("groups five sessions of ten securities into ten summaries", () => {
    const summary = summaryOf();

    expect(summary.sessions).toBe(5);
    expect(summary.symbols).toHaveLength(10);
    expect(summary.startDate).toBe("2026-08-03");
    expect(summary.endDate).toBe("2026-08-07");
  });

  it("returns summaries sorted by share code, not by upstream order", () => {
    const codes = summaryOf().symbols.map((entry) => entry.symbol);
    expect(codes).toEqual([...codes].sort());
  });

  // GSE stores these two decorated. Grouping on the raw string would split one
  // security into two series and corrupt startClose for both.
  it("collapses GSE's annotated share codes onto their plain form", () => {
    const codes = summaryOf().symbols.map((entry) => entry.symbol);

    expect(codes).toContain("ALW");
    expect(codes).toContain("PBC");
    expect(codes.some((code) => code.includes("*"))).toBe(false);
  });

  it("keeps a preference share distinct from the ordinary share", () => {
    const codes = summaryOf().symbols.map((entry) => entry.symbol);
    expect(codes).toContain("SCBPREF");
    expect(codes).not.toContain("SCB");
  });

  it("computes return from the first and last close, matching hand arithmetic", () => {
    // ALLGH ran 6.37 -> 5.43 across the window: (5.43 - 6.37) / 6.37 * 100.
    const allgh = bySymbol().ALLGH!;

    expect(allgh.startClose).toBe(6.37);
    expect(allgh.endClose).toBe(5.43);
    expect(allgh.percentReturn).toBeCloseTo(-14.7566, 3);
    expect(allgh.priceChange).toBeCloseTo(-0.94, 6);
  });

  // The obvious-looking wrong implementation. `change` is a delta against the
  // *previous* close, so the first row in a window carries a move that happened
  // before the window started. Summing the column therefore double-counts that
  // move; endClose - startClose cannot.
  it("does not compute priceChange by summing the daily change column", () => {
    const summary = summarizeWindow([
      // Opened the window already up 2.00 on a close that sits outside it.
      row({ symbol: "W", date: "2026-01-01", close: 12, change: 2, volume: 5 }),
      row({ symbol: "W", date: "2026-01-02", close: 13, change: 1, volume: 5 }),
    ]);
    const entry = summary.symbols[0]!;
    const summedChange = 2 + 1;

    expect(entry.priceChange).toBe(1); // 13 - 12
    expect(entry.priceChange).not.toBe(summedChange);
  });

  it("counts sessions quoted separately from sessions actually traded", () => {
    const map = bySymbol();

    expect(map.ACCESS).toMatchObject({ quotedDays: 5, tradingDays: 5 });
    expect(map.BOPP).toMatchObject({ quotedDays: 5, tradingDays: 3 });
    expect(map.CMLT).toMatchObject({ quotedDays: 5, tradingDays: 1 });
    expect(map.ALW).toMatchObject({ quotedDays: 5, tradingDays: 0 });
  });

  it("flags a stale opening price, which is how a return lands in the wrong window", () => {
    // BOPP did not trade on the first two sessions, so its startClose predates the
    // window and any move it shows may have happened before the window began.
    const bopp = bySymbol().BOPP!;

    expect(bopp.startIsCarriedForward).toBe(true);
    expect(bopp.endIsCarriedForward).toBe(false);
  });

  it("flags a stale closing price and reports when the price was last real", () => {
    // CMLT traded on the first session only; the other four closes are carried forward.
    const cmlt = bySymbol().CMLT!;

    expect(cmlt.endIsCarriedForward).toBe(true);
    expect(cmlt.lastTradedDate).toBe("2026-08-03");
    expect(cmlt.endDate).toBe("2026-08-07");
  });

  it("leaves lastTradedDate absent for a security that never traded", () => {
    expect(bySymbol().ALW!.lastTradedDate).toBeUndefined();
    expect(bySymbol().ALW!.totalVolume).toBe(0);
  });

  it("sums turnover only across sessions that actually traded", () => {
    const access = bySymbol().ACCESS!;
    expect(access.totalValueTraded).toBeGreaterThan(0);
  });

  // A partial sum would understate liquidity while looking authoritative.
  it("omits turnover entirely when any trading session is missing its figure", () => {
    const summary = summarizeWindow([
      row({ symbol: "X", date: "2026-01-01", volume: 10, valueTraded: 100, close: 1 }),
      row({ symbol: "X", date: "2026-01-02", volume: 10, close: 1 }), // no valueTraded
    ]);

    expect(summary.symbols[0]?.totalVolume).toBe(20);
    expect(summary.symbols[0]?.totalValueTraded).toBeUndefined();
  });

  it("yields a null return rather than Infinity when the baseline close is zero", () => {
    const summary = summarizeWindow([
      row({ symbol: "Z", date: "2026-01-01", close: 0, volume: 5 }),
      row({ symbol: "Z", date: "2026-01-02", close: 3, volume: 5 }),
    ]);
    const entry = summary.symbols[0]!;

    expect(entry.percentReturn).toBeNull();
    expect(entry.priceChange).toBeNull();
    expect(JSON.stringify(entry)).not.toMatch(/Infinity|NaN/);
  });

  it("orders by date even when rows arrive newest-first", () => {
    const summary = summarizeWindow([
      row({ symbol: "Y", date: "2026-01-05", close: 8, volume: 1 }),
      row({ symbol: "Y", date: "2026-01-01", close: 4, volume: 1 }),
    ]);

    expect(summary.symbols[0]).toMatchObject({ startClose: 4, endClose: 8 });
    expect(summary.symbols[0]?.percentReturn).toBeCloseTo(100, 6);
  });
});

describe("rankStocks", () => {
  it("excludes never-traded securities from a market-wide ranking by default", () => {
    const { rankings, excluded } = rankStocks(summaryOf(), defaults);
    const ranked = rankings.map((r) => r.symbol);

    for (const dormant of ["ALW", "ASG", "PBC", "TBL", "SAMBA"]) {
      expect(ranked, dormant).not.toContain(dormant);
      expect(excluded.find((e) => e.symbol === dormant)?.reason).toBe("untraded");
    }
    expect(ranked).toContain("ACCESS");
    expect(ranked).toContain("ALLGH");
  });

  it("includes them when the liquidity filter is switched off", () => {
    const { rankings, excluded } = rankStocks(summaryOf(), { ...defaults, minTradingDays: 0 });

    expect(rankings.map((r) => r.symbol)).toContain("ALW");
    expect(excluded).toEqual([]);
  });

  it("raising minTradingDays excludes the thinly traded, with a distinct reason", () => {
    const { rankings, excluded } = rankStocks(summaryOf(), { ...defaults, minTradingDays: 3 });

    expect(rankings.map((r) => r.symbol)).not.toContain("CMLT"); // traded once
    expect(excluded.find((e) => e.symbol === "CMLT")?.reason).toBe("too-few-trading-days");
    expect(rankings.map((r) => r.symbol)).toContain("BOPP"); // traded three times
  });

  // Silently returning two of the three securities somebody asked about would be a
  // worse failure than any warning.
  it("never drops a security the caller named, however illiquid", () => {
    const { rankings, excluded } = rankStocks(summaryOf(), {
      ...defaults,
      symbols: ["ACCESS", "ALW", "CMLT"],
    });

    expect(rankings.map((r) => r.symbol).sort()).toEqual(["ACCESS", "ALW", "CMLT"]);
    expect(excluded).toEqual([]);
  });

  it("resolves a named security through GSE's annotation markers", () => {
    const { rankings } = rankStocks(summaryOf(), { ...defaults, symbols: ["**ALW**"] });
    expect(rankings.map((r) => r.symbol)).toEqual(["ALW"]);
  });

  it("ignores limit in basket mode so a comparison is never truncated", () => {
    const { rankings } = rankStocks(summaryOf(), {
      ...defaults,
      limit: 1,
      symbols: ["ACCESS", "ALLGH", "BOPP"],
    });
    expect(rankings).toHaveLength(3);
  });

  it("sorts best-first by default and worst-first under asc", () => {
    const best = rankStocks(summaryOf(), defaults).rankings;
    const worst = rankStocks(summaryOf(), { ...defaults, order: "asc" }).rankings;

    expect(best[0]?.percentReturn).toBeGreaterThanOrEqual(best.at(-1)?.percentReturn ?? 0);
    // ALLGH fell ~14.8%, the sharpest move in the window.
    expect(worst[0]?.symbol).toBe("ALLGH");
    expect(best.map((r) => r.rank)).toEqual(best.map((_, i) => i + 1));
    expect(worst.map((r) => r.rank)).toEqual(worst.map((_, i) => i + 1));
  });

  it("ranks by volume without a pile of ties at zero", () => {
    const { rankings } = rankStocks(summaryOf(), { ...defaults, metric: "volume" });

    expect(rankings.every((r) => r.totalVolume > 0)).toBe(true);
    const volumes = rankings.map((r) => r.totalVolume);
    expect(volumes).toEqual([...volumes].sort((a, b) => b - a));
  });

  it("ranks by turnover", () => {
    const { rankings } = rankStocks(summaryOf(), { ...defaults, metric: "valueTraded" });
    const turnovers = rankings.map((r) => r.totalValueTraded ?? -1);
    expect(turnovers).toEqual([...turnovers].sort((a, b) => b - a));
  });

  // "We could not measure this" is a different claim from "this was the worst".
  it("sorts unmeasurable securities last in both directions", () => {
    const summary = summarizeWindow([
      row({ symbol: "GOOD", date: "2026-01-01", close: 10, volume: 5 }),
      row({ symbol: "GOOD", date: "2026-01-02", close: 12, volume: 5 }),
      row({ symbol: "NOBASE", date: "2026-01-01", close: 0, volume: 5 }),
      row({ symbol: "NOBASE", date: "2026-01-02", close: 5, volume: 5 }),
    ]);

    for (const order of ["desc", "asc"] as const) {
      const { rankings } = rankStocks(summary, {
        ...defaults,
        order,
        minTradingDays: 0,
        symbols: ["GOOD", "NOBASE"],
      });
      expect(rankings.at(-1)?.symbol, order).toBe("NOBASE");
    }
  });

  it("excludes a zero-baseline security from a market-wide ranking, with its own reason", () => {
    const summary = summarizeWindow([
      row({ symbol: "NOBASE", date: "2026-01-01", close: 0, volume: 5 }),
      row({ symbol: "NOBASE", date: "2026-01-02", close: 5, volume: 5 }),
    ]);
    const { excluded } = rankStocks(summary, defaults);

    expect(excluded).toEqual([{ symbol: "NOBASE", reason: "no-baseline-price" }]);
  });

  it("applies the limit when ranking the whole market", () => {
    expect(rankStocks(summaryOf(), { ...defaults, limit: 2 }).rankings).toHaveLength(2);
  });

  it("attaches company names when the directory supplies them", () => {
    const { rankings } = rankStocks(summaryOf(), {
      ...defaults,
      names: new Map([["ACCESS", "Access Bank Ghana Plc"]]),
    });
    expect(rankings.find((r) => r.symbol === "ACCESS")?.name).toBe("Access Bank Ghana Plc");
  });

  it("produces byte-identical output across runs, so ties never reorder", () => {
    const once = JSON.stringify(rankStocks(summaryOf(), defaults));
    const twice = JSON.stringify(rankStocks(summaryOf(), defaults));
    expect(once).toBe(twice);
  });

  // The 52-week extremes are documented as inconsistent with close, so no ranking
  // arithmetic may reference them.
  it("ignores the 52-week high and low entirely", () => {
    const rows = rowsOf();
    const baseline = JSON.stringify(rankStocks(summarizeWindow(rows), defaults));
    const mangled = rows.map((r) => ({ ...r, high: 9999, low: -9999 }));

    expect(JSON.stringify(rankStocks(summarizeWindow(mangled), defaults))).toBe(baseline);
  });
});

describe("window helpers", () => {
  it("quantizes a requested window onto the smallest covering bucket", () => {
    expect(windowBucket(1)).toBe(7);
    expect(windowBucket(30)).toBe(30);
    expect(windowBucket(31)).toBe(90);
    expect(windowBucket(400)).toBe(400);
    expect(windowBucket(9999)).toBe(WINDOW_BUCKETS[WINDOW_BUCKETS.length - 1]);
  });

  it("trims a wider bucket down to the window asked for, inclusively", () => {
    const rows = rowsOf();
    const trimmed = trimToWindow(rows, "2026-08-06");

    expect(trimmed.every((r) => r.date >= "2026-08-06")).toBe(true);
    expect(trimmed.some((r) => r.date === "2026-08-06")).toBe(true);
    expect(trimmed.length).toBeLessThan(rows.length);
  });

  it("computes the window start in UTC", () => {
    expect(windowStartDate(30, new Date("2026-08-07T12:00:00Z"))).toBe("2026-07-08");
  });
});
