import { describe, expect, it } from "vitest";

import { historyTtlSeconds, isTradingWindow } from "../../src/lib/tradingHours.js";

/** Ghana keeps GMT year-round, so these UTC timestamps are also local time. */
const at = (iso: string) => new Date(iso);

describe("isTradingWindow", () => {
  it("is true during the session on a weekday", () => {
    expect(isTradingWindow(at("2026-07-24T12:00:00Z"))).toBe(true); // Friday noon
    expect(isTradingWindow(at("2026-07-20T09:30:00Z"))).toBe(true); // Monday, at open
  });

  it("is false before and after the session", () => {
    expect(isTradingWindow(at("2026-07-24T09:29:00Z"))).toBe(false);
    expect(isTradingWindow(at("2026-07-24T15:30:00Z"))).toBe(false);
    expect(isTradingWindow(at("2026-07-24T23:00:00Z"))).toBe(false);
  });

  it("is false at the weekend", () => {
    expect(isTradingWindow(at("2026-07-25T12:00:00Z"))).toBe(false); // Saturday
    expect(isTradingWindow(at("2026-07-26T12:00:00Z"))).toBe(false); // Sunday
  });
});

describe("historyTtlSeconds", () => {
  it("caches briefly while the market is open", () => {
    expect(historyTtlSeconds(at("2026-07-24T12:00:00Z"))).toBe(15 * 60);
  });

  it("caches for hours once the day's rows are settled", () => {
    expect(historyTtlSeconds(at("2026-07-24T20:00:00Z"))).toBe(12 * 60 * 60);
    expect(historyTtlSeconds(at("2026-07-25T12:00:00Z"))).toBe(12 * 60 * 60);
  });
});
