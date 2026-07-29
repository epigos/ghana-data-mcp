import { describe, expect, it } from "vitest";

import { GssClient } from "../../src/sources/gss/client.js";
import { parseTableData, parseTableSchema } from "../../src/sources/gss/parser.js";
import { filterByGranularity, latestPeriods } from "../../src/sources/gss/period.js";
import { findTable, TABLES, type TableDef } from "../../src/sources/gss/tables.js";

/**
 * Live canary for StatsBank — skipped unless GSE_LIVE=1.
 *
 * statsbank.statsghana.gov.gh has a normal TLS chain and needs no workaround, so
 * this rides the same GSE_LIVE flag as the GSE and IMF canaries.
 *
 * What these protect, in rough order of how likely each is to break:
 *
 *  - **Every table path still resolves.** The MIEG table's upstream filename carries
 *    a publication vintage (`April_26_MIEG_Px.px`) and *will* change when GSS
 *    publishes a new one. That is a 404 the registry cannot predict, so the test
 *    below walks the folder listing to tell you the new name when it happens.
 *  - The two-step contract: GET returns a schema, POST returns data for it.
 *  - The three quirks the source is built around — an axis stored oldest-first, an
 *    axis mixing granularities, and asterisk-marked provisional years — all still
 *    behave as the parser assumes.
 */
const live = process.env.GSE_LIVE === "1";

const client = new GssClient({ timeoutMs: 30_000, retries: 1 });
const table = (id: string) => findTable(id) as TableDef;

/** Politeness: these run sequentially against someone else's server. */
const pause = () => new Promise((resolve) => setTimeout(resolve, 1200));

describe.skipIf(!live)("StatsBank (live)", () => {
  it("still serves a parseable schema for every registered table", async () => {
    const failures: string[] = [];

    for (const def of TABLES) {
      try {
        const parsed = parseTableSchema(await client.fetchTableSchema(def.path), def);
        expect(parsed.periods.length, def.id).toBeGreaterThan(0);
        expect(parsed.dimensions.map((d) => d.code), def.id).toEqual([...def.dimensions]);
      } catch (error) {
        failures.push(`${def.id}: ${(error as Error).message}`);
      }
      await pause();
    }

    // Reported together so one moved table does not hide the state of the other 15.
    expect(failures, failures.join("\n")).toEqual([]);
  }, 180_000);

  it("still returns Ghana's headline inflation for the latest published month", async () => {
    const cpi = table("cpi");
    const schema = parseTableSchema(await client.fetchTableSchema(cpi.path), cpi);
    await pause();

    const [latest] = latestPeriods(schema.periods, 1);
    expect(latest).toBeDefined();

    const data = parseTableData(
      await client.fetchTableData(cpi.path, [
        { code: "Month", selection: { filter: "item", values: [latest!.code] } },
        { code: "Region", selection: { filter: "item", values: ["Ghana"] } },
        { code: "Product", selection: { filter: "item", values: ["All products"] } },
        { code: "Source", selection: { filter: "item", values: ["All sources"] } },
        {
          code: "Indicator",
          selection: { filter: "item", values: ["Year-on-year inflation (%)"] },
        },
      ]),
      cpi,
    );

    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]?.dimensions.Region).toBe("Ghana");
    // A plausibility band, not a fixed number — this is live data.
    expect(data.rows[0]?.value).toBeGreaterThan(-20);
    expect(data.rows[0]?.value).toBeLessThan(200);
    expect(data.source.length).toBeGreaterThan(0);
  }, 90_000);

  // The trap that motivated period.ts. If StatsBank ever reorders this axis
  // newest-first, this test still passes — it asserts the outcome, not the storage
  // order. It fails only if latestPeriods stops being correct.
  it("still stores the MIEG axis oldest-first, and latestPeriods still beats filter:top", async () => {
    const mieg = table("mieg");
    const raw = (await client.fetchTableSchema(mieg.path)) as {
      variables: Array<{ code: string; values: string[] }>;
    };
    const axis = raw.variables.find((v) => v.code === "Month")!.values;
    const parsed = parseTableSchema(raw, mieg);

    const [newest] = latestPeriods(parsed.periods, 1);
    // Whatever order upstream uses, our newest must be >= every code on the axis.
    for (const code of axis) {
      expect(code.localeCompare(newest!.code) <= 0, `${code} > ${newest!.code}`).toBe(true);
    }
  }, 90_000);

  it("still mixes granularities on the trade axis, so granularity stays required", async () => {
    const trade = table("trade");
    const parsed = parseTableSchema(await client.fetchTableSchema(trade.path), trade);

    expect(filterByGranularity(parsed.periods, "quarterly").length).toBeGreaterThan(0);
    expect(filterByGranularity(parsed.periods, "monthly").length).toBeGreaterThan(0);
  }, 90_000);

  it("still marks unfinalized GDP years with asterisks that the API requires", async () => {
    const gdp = table("gdp_expenditure");
    const parsed = parseTableSchema(await client.fetchTableSchema(gdp.path), gdp);
    const provisional = parsed.periods.filter((p) => p.provisional);

    expect(provisional.length).toBeGreaterThan(0);
    // The label is the clean year; the code keeps the marker the API insists on.
    for (const period of provisional) {
      expect(period.code).not.toBe(period.label);
      expect(period.code.startsWith(period.label)).toBe(true);
    }
  }, 90_000);

  // The documented filter that must never be used. If StatsBank ever makes `top`
  // mean "latest", this test starts failing and the guard in period.ts could be
  // simplified — until then it documents why it exists.
  it("still resolves filter:top against storage order, not chronology", async () => {
    const mieg = table("mieg");
    const payload = (await client.fetchTableData(mieg.path, [
      // Cast: `top` is deliberately outside PxQuerySelection's type, since no
      // production path may send it.
      { code: "Month", selection: { filter: "top" as "item", values: ["1"] } },
      { code: "Variable", selection: { filter: "item", values: ["TOTAL"] } },
      { code: "GDP_Series", selection: { filter: "item", values: ["GROWTH"] } },
    ])) as { data: Array<{ key: string[] }> };

    const returned = payload.data[0]?.key[0];
    expect(returned).toBe("2023M01"); // the oldest month, not the newest
  }, 90_000);

  it("can rediscover a table filename from the folder listing", async () => {
    // This is the recovery path for the MIEG vintage problem: if its path 404s,
    // this listing is where the new filename comes from.
    const listing = (await client.fetchFolder(
      "Macroeconomic Indicators/Monthly Indicator of Economic Growth(MIEG)",
    )) as Array<{ id: string; type: string }>;

    const tables = listing.filter((entry) => entry.type === "t").map((entry) => entry.id);
    expect(tables.length).toBeGreaterThan(0);
    expect(tables, `MIEG filename moved; update tables.ts to one of: ${tables.join(", ")}`).toContain(
      "April_26_MIEG_Px.px",
    );
  }, 90_000);
});
