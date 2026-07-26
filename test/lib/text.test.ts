import { describe, expect, it } from "vitest";

import { stripHtml } from "../../src/lib/text.js";

describe("stripHtml", () => {
  // GSE wraps its Symbol column in an anchor tag.
  it("pulls text out of an anchor tag", () => {
    expect(stripHtml("<a href='ACCESS' rel='' target='_self'>ACCESS</a>")).toBe("ACCESS");
  });

  // IMF descriptions carry inline formatting, e.g. the Gender Development Index entry.
  it("strips inline formatting tags", () => {
    expect(stripHtml("The GDI ranges 0-1.<b>Note</b>: higher is better")).toBe(
      "The GDI ranges 0-1.Note: higher is better",
    );
  });

  it("leaves plain text alone", () => {
    expect(stripHtml("Access Bank Ghana Plc")).toBe("Access Bank Ghana Plc");
  });

  // IMF labels carry stray embedded newlines, e.g. "GDP per capita, current prices\n".
  it("collapses embedded newlines and repeated whitespace", () => {
    expect(stripHtml("GDP per capita, current prices\n")).toBe("GDP per capita, current prices");
    expect(stripHtml("Current account balance\nU.S. dollars")).toBe(
      "Current account balance U.S. dollars",
    );
    expect(stripHtml("  MTN   Ghana \n")).toBe("MTN Ghana");
  });

  it("returns empty for non-strings and markup with no text", () => {
    expect(stripHtml("<a href='x'></a>")).toBe("");
    expect(stripHtml(null)).toBe("");
    expect(stripHtml(undefined)).toBe("");
    expect(stripHtml(42)).toBe("");
  });
});
