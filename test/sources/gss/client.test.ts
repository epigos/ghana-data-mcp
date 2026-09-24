import { describe, expect, it } from "vitest";

import { UpstreamError } from "../../../src/lib/errors.js";
import { GssClient } from "../../../src/sources/gss/client.js";
import { errorResponse, jsonResponse, stubFetch } from "../../helpers/stubFetch.js";

/**
 * Covers `withPathRecovery`, the fallback that keeps a table reachable after its
 * upstream filename changes.
 *
 * The motivating case is real: MIEG's filename carries a publication vintage, and
 * when GSS republished it as `mieg_px_May26.px` in August 2026 the pinned
 * `April_26_MIEG_Px.px` started 404ing and took four live canary tests with it.
 * These tests pin the recovery itself, which the live canary cannot exercise —
 * once tables.ts is corrected the pinned path resolves and the fallback never runs.
 */

const FOLDER = "Macroeconomic Indicators/Monthly Indicator of Economic Growth(MIEG)";
const MOVED = `${FOLDER}/April_26_MIEG_Px.px`;
const CURRENT_FILE = "mieg_px_May26.px";

const schema = { title: "MIEG", variables: [] };
const data = { columns: [], data: [], metadata: [] };

const fast = { baseDelayMs: 0 };

/** Routes are matched by substring in declaration order, so the two filenames are
 *  declared before the folder — every file URL also contains the folder path. */
function routes(listing: unknown, options: { movedStatus?: number } = {}) {
  return [
    { match: "April_26_MIEG_Px.px", responses: [() => errorResponse(options.movedStatus ?? 404)] },
    { match: CURRENT_FILE, responses: [() => jsonResponse(schema), () => jsonResponse(data)] },
    { match: "Growth(MIEG)/", responses: [() => jsonResponse(listing)] },
  ];
}

const oneTable = [{ id: CURRENT_FILE, type: "t", text: "MIEG" }];

describe("GssClient path recovery", () => {
  it("re-reads the folder listing and retries when a pinned filename 404s", async () => {
    const { fetch: fetchImpl, calls } = stubFetch(routes(oneTable));

    const payload = await new GssClient({ fetchImpl, ...fast }).fetchTableSchema(MOVED);

    expect(payload).toEqual(schema);
    // The 404, the folder listing, then the retry against the discovered filename.
    expect(calls).toHaveLength(3);
    expect(calls[0]?.url).toContain("April_26_MIEG_Px.px");
    expect(calls[1]?.url).toMatch(/Growth\(MIEG\)\/$/);
    expect(calls[2]?.url).toContain(CURRENT_FILE);
  });

  it("reuses a discovered filename for the POST that follows, without listing again", async () => {
    const { fetch: fetchImpl, calls } = stubFetch(routes(oneTable));
    const client = new GssClient({ fetchImpl, ...fast });

    await client.fetchTableSchema(MOVED);
    const body = await client.fetchTableData(MOVED, [
      { code: "Month", selection: { filter: "item", values: ["2026-05"] } },
    ]);

    expect(body).toEqual(data);
    // One extra call only: the POST. No second folder listing.
    expect(calls).toHaveLength(4);
    expect(calls[3]?.method).toBe("POST");
    expect(calls[3]?.url).toContain(CURRENT_FILE);
    expect(calls.filter((c) => c.url.endsWith("Growth(MIEG)/"))).toHaveLength(1);
  });

  it("rethrows the original 404 when the folder still lists only the pinned name", async () => {
    // The table is genuinely gone rather than renamed — there is nothing to recover to.
    const { fetch: fetchImpl } = stubFetch(
      routes([{ id: "April_26_MIEG_Px.px", type: "t", text: "MIEG" }]),
    );

    await expect(new GssClient({ fetchImpl, ...fast }).fetchTableSchema(MOVED)).rejects.toThrow(
      /returned 404/,
    );
  });

  it("refuses to guess when the folder holds more than one table", async () => {
    // Reading the wrong table silently would be worse than failing loudly.
    const { fetch: fetchImpl } = stubFetch(
      routes([
        { id: CURRENT_FILE, type: "t", text: "MIEG" },
        { id: "mieg_px_Jun26.px", type: "t", text: "MIEG" },
      ]),
    );

    await expect(new GssClient({ fetchImpl, ...fast }).fetchTableSchema(MOVED)).rejects.toThrow(
      /returned 404/,
    );
  });

  it("ignores subfolders when picking the replacement", async () => {
    const { fetch: fetchImpl } = stubFetch(
      routes([
        { id: "Archive", type: "l", text: "Archive" },
        { id: CURRENT_FILE, type: "t", text: "MIEG" },
      ]),
    );

    await expect(
      new GssClient({ fetchImpl, ...fast }).fetchTableSchema(MOVED),
    ).resolves.toEqual(schema);
  });

  it("does not go looking after a failure that is not a 404", async () => {
    // A 500 says the server is unwell, not that the file moved. Listing the folder
    // would just be a second request against a host already returning errors.
    const { fetch: fetchImpl, calls } = stubFetch(routes(oneTable, { movedStatus: 500 }));

    await expect(
      new GssClient({ fetchImpl, retries: 0, ...fast }).fetchTableSchema(MOVED),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(calls).toHaveLength(1);
  });
});
