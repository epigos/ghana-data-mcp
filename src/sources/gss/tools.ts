import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readThrough, type Cache } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { ResultMetaSchema, toolError, toolResult, type DataOrigin } from "../../lib/results.js";
import { GssClient, type PxQuerySelection } from "./client.js";
import { granularitiesOf, parseTableData, parseTableSchema } from "./parser.js";
import { filterByGranularity, latestPeriods, matchPeriod, periodsInRange } from "./period.js";
import { findTable, likelyGranularities, sectors, TABLES, type TableDef } from "./tables.js";
import {
  DataResultSchema,
  DEFAULT_LATEST_PERIODS,
  GranularitySchema,
  MAX_PERIODS_PER_CALL,
  MAX_ROWS_PER_CALL,
  TableMetaSchema,
  TableSchemaSchema,
  type DimensionMeta,
  type Granularity,
  type PeriodMeta,
} from "./types.js";

/**
 * MCP tool surface for Ghana Statistical Service StatsBank data, namespaced `gss_`.
 *
 * Three tools rather than one per table. StatsBank publishes 16 macroeconomic
 * tables and a tool each would nearly triple this server's tool count for one
 * source, which makes tool selection worse for every other source too. Instead the
 * shape mirrors the API: browse the catalog, describe a table's filters, fetch data.
 *
 * The cost of a generic surface is discovery round trips, so both are cut down:
 * `gss_list_tables` answers from the static registry with no network call, and
 * `gss_get_data` resolves table ids, period spellings and dimension values
 * tolerantly enough that most questions land in one call without a describe first.
 *
 * All validation happens against the cached schema *before* a POST goes out, because
 * StatsBank answers an invalid query with a 404 and an HTML error page rather than
 * anything a caller could act on. See client.ts.
 */

export interface GssDeps {
  client: GssClient;
  cache: Cache;
  logger?: Logger;
}

/**
 * 24 hours, not the 7 days the IMF catalog gets. A table's schema carries its period
 * axis, so a stale schema means a month GSS published yesterday is invisible to
 * `latest`. One day is the compromise between that and re-fetching a 300-value axis
 * on every call.
 */
const SCHEMA_TTL_SECONDS = 24 * 60 * 60;
const DATA_TTL_SECONDS = 24 * 60 * 60;

/** How many of the most recent periods `gss_describe_table` echoes back. */
const RECENT_PERIODS_SHOWN = 24;

/** A one-line catalog for the tool descriptions, so a model can usually skip discovery. */
const TABLE_INDEX = TABLES.map((t) => `${t.id} (${t.title})`).join("; ");

export function registerGssTools(server: McpServer, deps: GssDeps): void {
  const log = (deps.logger ?? silentLogger).child({ source: "gss" });

  server.registerTool(
    "gss_list_tables",
    {
      title: "Browse Ghana Statistical Service tables",
      description:
        "Lists the official StatsBank macroeconomic tables published by the Ghana Statistical " +
        "Service, optionally filtered by keyword or sector. Use this to find the right `table` id " +
        "for gss_describe_table or gss_get_data. Covers inflation (national and all 16 regions), " +
        "GDP, public debt, fiscal accounts, money and credit, interest rates, banking soundness, " +
        "merchandise trade, balance of payments, industrial production and fuel consumption. " +
        `Tables: ${TABLE_INDEX}.`,
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe("Keyword matched against id, title, sector and summary. Omit to list all."),
        sector: z
          .string()
          .optional()
          .describe(`Restrict to one sector. One of: ${sectors().join(", ")}.`),
      },
      outputSchema: {
        tableCount: z.number(),
        tables: z.array(TableMetaSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query, sector }) => {
      log.info("tool: gss_list_tables", { query: query ?? "(none)", sector: sector ?? "(all)" });

      const wantedSector = sector?.trim().toLowerCase();
      const wanted = query?.trim().toLowerCase();

      let matches = TABLES.filter((table) => {
        if (wantedSector && table.sector.toLowerCase() !== wantedSector) return false;
        if (!wanted) return true;
        const haystack = `${table.id} ${table.aliases.join(" ")} ${table.title} ${table.sector} ${table.summary}`;
        return haystack.toLowerCase().includes(wanted);
      });

      // An unmatched sector is a caller error worth naming, not a silent empty list.
      const warnings: string[] = [];
      if (wantedSector && !sectors().some((s) => s.toLowerCase() === wantedSector)) {
        warnings.push(`Unknown sector "${sector}". Known sectors: ${sectors().join(", ")}.`);
        matches = [];
      }
      if (wanted && matches.length === 0 && warnings.length === 0) {
        warnings.push(`No table matched "${query}". Call gss_list_tables with no query to see all 16.`);
      }

      return toolResult({
        tableCount: matches.length,
        tables: matches.map(toTableMeta),
        meta: {
          // The registry ships with the Worker, so this answer never depends on
          // StatsBank being reachable.
          origin: "static-seed" as DataOrigin,
          ageSeconds: 0,
          ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
        },
      });
    },
  );

  server.registerTool(
    "gss_describe_table",
    {
      title: "Filters and periods for one StatsBank table",
      description:
        "Returns one table's filterable dimensions with every value each accepts, plus which " +
        "periods are currently published. Call this when gss_get_data reports a value it could " +
        "not resolve, or when you need to know exactly what a table can be sliced by. " +
        "Dimension values must be passed to gss_get_data as spelled here.",
      inputSchema: {
        table: z.string().describe(`Table id or alias, e.g. "cpi", "debt", "trade". One of: ${TABLE_INDEX}.`),
      },
      outputSchema: { schema: TableSchemaSchema, meta: ResultMetaSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ table }) => {
      log.info("tool: gss_describe_table", { table });

      const def = findTable(table);
      if (!def) return toolError(unknownTableMessage(table));

      try {
        const loaded = await loadSchema(deps, def);
        const { periods, dimensions } = loaded.value;
        const newestFirst = [...periods].reverse();

        return toolResult({
          schema: {
            id: def.id,
            title: loaded.value.title,
            sector: def.sector,
            timeVariable: def.timeVariable,
            granularityRequired: def.mixedGranularity,
            periodCount: periods.length,
            granularities: granularitiesOf(periods),
            ...(periods[0] ? { earliestPeriod: periods[0].label } : {}),
            ...(newestFirst[0] ? { latestPeriod: newestFirst[0].label } : {}),
            recentPeriods: newestFirst.slice(0, RECENT_PERIODS_SHOWN).map((p) => p.label),
            dimensions,
          },
          meta: originMeta(loaded, def.mixedGranularity ? mixedGranularityNote(def) : undefined),
        });
      } catch (error) {
        log.error("tool: gss_describe_table failed", { table: def.id, reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "gss_get_data",
    {
      title: "Ghana Statistical Service data",
      description:
        "Official Ghana macroeconomic data from StatsBank, oldest period first. Pick a `table`, " +
        "then narrow it: `latest` for the most recent N periods, `startPeriod`/`endPeriod` for a " +
        "range, or `periods` for named ones. `filters` slices the non-time dimensions — CPI by " +
        "region and product, trade by product class and tradeflow, credit by borrowing sector, and " +
        "so on; call gss_describe_table for the exact values a table accepts. Rows carry " +
        "`provisional: true` where GSS has not finalized the period, which happens on the most " +
        "recent GDP years; always report those as provisional rather than settled. " +
        `Tables: ${TABLE_INDEX}.`,
      inputSchema: {
        table: z.string().describe("Table id or alias, e.g. \"cpi\", \"interest_rates\", \"debt\"."),
        latest: z
          .number()
          .int()
          .min(1)
          .max(MAX_PERIODS_PER_CALL)
          .optional()
          .describe(
            `Most recent N periods. Defaults to ${DEFAULT_LATEST_PERIODS} when no period argument ` +
              "is given. Ignored if `periods` or a start/end range is supplied.",
          ),
        startPeriod: z
          .string()
          .optional()
          .describe("Inclusive start, e.g. \"2023M01\", \"2023Q1\", \"2019\". Provisional asterisks optional."),
        endPeriod: z.string().optional().describe("Inclusive end, same formats as startPeriod."),
        periods: z
          .array(z.string())
          .min(1)
          .max(MAX_PERIODS_PER_CALL)
          .optional()
          .describe("Explicit periods. Takes precedence over `latest` and the range arguments."),
        granularity: GranularitySchema.optional().describe(
          "Required for tables whose periods mix granularities (`fiscal`, `trade`) — without it a " +
            "series would contain both a quarter and the months inside it. Optional elsewhere.",
        ),
        filters: z
          .record(z.string(), z.union([z.string(), z.array(z.string())]))
          .optional()
          .describe(
            "Dimension filters, e.g. {\"Region\": \"Ashanti\", \"Product\": [\"Food\", \"Transport\"]}. " +
              "Values are matched case-insensitively. Omit a dimension to get all of its values.",
          ),
      },
      outputSchema: { result: DataResultSchema, meta: ResultMetaSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ table, latest, startPeriod, endPeriod, periods, granularity, filters }) => {
      log.info("tool: gss_get_data", {
        table,
        latest: latest ?? "(default)",
        range: startPeriod || endPeriod ? `${startPeriod ?? "*"}..${endPeriod ?? "*"}` : "(none)",
        explicitPeriods: periods?.length ?? 0,
        granularity: granularity ?? "(auto)",
        filters: filters ? Object.keys(filters).join(",") : "(none)",
      });

      const def = findTable(table);
      if (!def) return toolError(unknownTableMessage(table));

      try {
        const loaded = await loadSchema(deps, def);
        const warnings: string[] = [];

        const resolvedGranularity = resolveGranularity(def, loaded.value.periods, granularity);
        if (!resolvedGranularity.ok) return toolError(resolvedGranularity.message);

        const axis = filterByGranularity(loaded.value.periods, resolvedGranularity.granularity);
        if (axis.length === 0) {
          return toolError(
            `Table "${def.id}" has no ${resolvedGranularity.granularity} periods. Available: ` +
              `${granularitiesOf(loaded.value.periods).join(", ")}.`,
          );
        }

        const selection = selectPeriods({ axis, latest, startPeriod, endPeriod, periods });
        if (!selection.ok) return toolError(selection.message);
        if (selection.warning) warnings.push(selection.warning);

        const resolvedFilters = resolveFilters(loaded.value.dimensions, filters);
        if (!resolvedFilters.ok) return toolError(resolvedFilters.message);
        if (resolvedFilters.warning) warnings.push(resolvedFilters.warning);

        const query: PxQuerySelection[] = [
          {
            code: def.timeVariable,
            selection: { filter: "item", values: selection.periods.map((p) => p.code) },
          },
          ...resolvedFilters.selections,
        ];

        const key = dataCacheKey(def, resolvedGranularity.granularity, selection.periods, resolvedFilters.selections);
        const fetched = await readThrough(deps.cache, key, DATA_TTL_SECONDS, async () =>
          parseTableData(await deps.client.fetchTableData(def.path, query), def),
        );

        let rows = fetched.value.rows;
        if (rows.length > MAX_ROWS_PER_CALL) {
          warnings.push(
            `Result truncated to the first ${MAX_ROWS_PER_CALL} of ${rows.length} rows. Narrow ` +
              "`filters` or ask for fewer periods to see the rest.",
          );
          rows = rows.slice(0, MAX_ROWS_PER_CALL);
        }

        if (fetched.origin === "stale-cache") {
          warnings.push(
            `StatsBank could not be reached (${fetched.staleReason}); serving a cached copy from ` +
              `${Math.round(fetched.ageSeconds / 3600)} hour(s) ago.`,
          );
        }
        if (rows.length === 0) {
          warnings.push(
            "No observations for this combination. The periods and filters were all valid, so " +
              "GSS simply publishes nothing here — check gss_describe_table for a coarser slice.",
          );
        }
        const provisional = rows.filter((r) => r.provisional).length;
        if (provisional > 0) {
          warnings.push(
            `${provisional} row(s) are provisional or forecast (GSS has not finalized them). ` +
              "Report those figures as provisional.",
          );
        }

        log.info("tool: gss_get_data done", {
          table: def.id,
          periods: selection.periods.length,
          rows: rows.length,
          skipped: fetched.value.skipped || undefined,
          origin: fetched.origin,
        });

        return toolResult({
          result: {
            table: def.id,
            title: fetched.value.title,
            source: fetched.value.source,
            ...(fetched.value.updated ? { updated: fetched.value.updated } : {}),
            granularity: resolvedGranularity.granularity,
            periods: selection.periods.map((p) => p.label),
            rowCount: rows.length,
            rows,
          },
          meta: {
            origin: fetched.origin as DataOrigin,
            ageSeconds: fetched.ageSeconds,
            skippedRows: fetched.value.skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: gss_get_data failed", { table: def.id, reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );
}

function toTableMeta(table: TableDef) {
  return {
    id: table.id,
    title: table.title,
    sector: table.sector,
    summary: table.summary,
    timeVariable: table.timeVariable,
    dimensions: [...table.dimensions],
    granularities: likelyGranularities(table),
    granularityRequired: table.mixedGranularity,
  };
}

function unknownTableMessage(requested: string): string {
  return (
    `"${requested}" is not a StatsBank table. Call gss_list_tables to see all 16, or use one of: ` +
    `${TABLES.map((t) => t.id).join(", ")}.`
  );
}

function mixedGranularityNote(table: TableDef): string {
  return (
    `This table interleaves annual, quarterly and monthly periods on its \`${table.timeVariable}\` ` +
    "axis, so gss_get_data requires an explicit `granularity`. Mixing them would put a quarter and " +
    "the months inside it in the same series."
  );
}

/** Shared loader so both tools hit one cached schema per table. */
async function loadSchema(deps: GssDeps, table: TableDef) {
  return readThrough(deps.cache, `gss:schema:v1:${table.id}`, SCHEMA_TTL_SECONDS, async () =>
    parseTableSchema(await deps.client.fetchTableSchema(table.path), table),
  );
}

function originMeta(
  loaded: { origin: string; ageSeconds: number; staleReason?: string },
  extra?: string,
) {
  const warnings: string[] = [];
  if (loaded.origin === "stale-cache") {
    warnings.push(
      `StatsBank could not be reached (${loaded.staleReason}); serving a cached copy from ` +
        `${Math.round(loaded.ageSeconds / 3600)} hour(s) ago.`,
    );
  }
  if (extra) warnings.push(extra);
  return {
    origin: loaded.origin as DataOrigin,
    ageSeconds: loaded.ageSeconds,
    ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
  };
}

type GranularityResult =
  | { ok: true; granularity: Granularity }
  | { ok: false; message: string };

/**
 * Picks the granularity to serve.
 *
 * A mixed-axis table must be told explicitly — defaulting one would mean quietly
 * choosing which of three plausible series the caller meant, and a wrong choice
 * there is a double-counted total rather than an obvious error.
 */
function resolveGranularity(
  table: TableDef,
  periods: readonly PeriodMeta[],
  requested: Granularity | undefined,
): GranularityResult {
  const available = granularitiesOf(periods);

  if (requested) {
    if (!available.includes(requested)) {
      return {
        ok: false,
        message:
          `Table "${table.id}" publishes no ${requested} periods. Available: ${available.join(", ")}.`,
      };
    }
    return { ok: true, granularity: requested };
  }

  if (available.length === 1) return { ok: true, granularity: available[0]! };

  return {
    ok: false,
    message:
      `Table "${table.id}" mixes ${available.join(", ")} periods on one axis, so \`granularity\` is ` +
      "required. Pass one of those values. Without it a series could contain both a quarter and " +
      "the months inside it, double-counting the same activity.",
  };
}

type PeriodSelection =
  | { ok: true; periods: PeriodMeta[]; warning?: string }
  | { ok: false; message: string };

function selectPeriods(input: {
  axis: PeriodMeta[];
  latest?: number;
  startPeriod?: string;
  endPeriod?: string;
  periods?: string[];
}): PeriodSelection {
  const { axis, latest, startPeriod, endPeriod, periods } = input;

  if (periods && periods.length > 0) {
    const matched: PeriodMeta[] = [];
    const unmatched: string[] = [];
    for (const requested of periods) {
      const hit = matchPeriod(requested, axis);
      if (hit) matched.push(hit);
      else unmatched.push(requested);
    }
    if (matched.length === 0) {
      return {
        ok: false,
        message:
          `None of these periods exist on this table: ${unmatched.join(", ")}. Latest available is ` +
          `${axis[axis.length - 1]?.label}. Call gss_describe_table for the full axis.`,
      };
    }
    return {
      ok: true,
      periods: dedupePeriods(matched),
      ...(unmatched.length > 0
        ? { warning: `These periods do not exist on this table and were skipped: ${unmatched.join(", ")}.` }
        : {}),
    };
  }

  if (startPeriod !== undefined || endPeriod !== undefined) {
    const range = periodsInRange(axis, startPeriod, endPeriod);
    if (range.unmatched.length > 0) {
      return {
        ok: false,
        message:
          `Could not place these period bounds on this table's axis: ${range.unmatched.join(", ")}. ` +
          `It runs ${axis[0]?.label} to ${axis[axis.length - 1]?.label}.`,
      };
    }
    if (range.periods.length === 0) {
      return {
        ok: false,
        message: `No periods fall in ${startPeriod ?? "the start"}..${endPeriod ?? "the end"} on this table.`,
      };
    }
    if (range.periods.length > MAX_PERIODS_PER_CALL) {
      const trimmed = range.periods.slice(range.periods.length - MAX_PERIODS_PER_CALL);
      return {
        ok: true,
        periods: trimmed,
        warning:
          `That range covers ${range.periods.length} periods; returning the most recent ` +
          `${MAX_PERIODS_PER_CALL}. Narrow the range to see earlier ones.`,
      };
    }
    return { ok: true, periods: range.periods };
  }

  return { ok: true, periods: latestPeriods(axis, latest ?? DEFAULT_LATEST_PERIODS) };
}

function dedupePeriods(periods: readonly PeriodMeta[]): PeriodMeta[] {
  const byCode = new Map(periods.map((p) => [p.code, p]));
  return [...byCode.values()].sort((a, b) =>
    a.year !== b.year ? a.year - b.year : a.index - b.index,
  );
}

type FilterResult =
  | { ok: true; selections: PxQuerySelection[]; warning?: string }
  | { ok: false; message: string };

/**
 * Maps caller-supplied dimension filters onto exactly-spelled upstream values.
 *
 * An unknown dimension code or an unresolvable value is a hard error rather than a
 * warning, because sending either would produce a 404 and an HTML page — and
 * because silently dropping a filter would return a broader series than asked for,
 * which a caller might not notice.
 */
function resolveFilters(
  dimensions: readonly DimensionMeta[],
  filters: Record<string, string | string[]> | undefined,
): FilterResult {
  if (!filters || Object.keys(filters).length === 0) return { ok: true, selections: [] };

  const byCode = new Map(dimensions.map((d) => [d.code.toLowerCase(), d]));
  const selections: PxQuerySelection[] = [];

  for (const [requestedCode, rawValues] of Object.entries(filters)) {
    const dimension = byCode.get(requestedCode.trim().toLowerCase());
    if (!dimension) {
      return {
        ok: false,
        message:
          `"${requestedCode}" is not a dimension of this table. Filterable dimensions: ` +
          `${dimensions.map((d) => d.code).join(", ")}.`,
      };
    }

    const wanted = Array.isArray(rawValues) ? rawValues : [rawValues];
    const resolved: string[] = [];
    for (const value of wanted) {
      const hit = matchDimensionValue(dimension, value);
      if (!hit) {
        return {
          ok: false,
          message:
            `"${value}" is not a value of \`${dimension.code}\`. ` +
            `${describeValues(dimension)} Call gss_describe_table for the full list.`,
        };
      }
      resolved.push(hit);
    }

    selections.push({
      code: dimension.code,
      selection: { filter: "item", values: [...new Set(resolved)] },
    });
  }

  return { ok: true, selections };
}

/**
 * Exact match wins outright, case-insensitively. Only then is a substring tried, and
 * only when it is unambiguous — "Food" must resolve to `Food` and not silently to
 * `Food and non-alcoholic beverages`, which is a different CPI basket.
 */
function matchDimensionValue(dimension: DimensionMeta, requested: string): string | undefined {
  const wanted = requested.trim().toLowerCase();
  if (!wanted) return undefined;

  const exact = dimension.values.find((value) => value.toLowerCase() === wanted);
  if (exact) return exact;

  const partial = dimension.values.filter((value) => value.toLowerCase().includes(wanted));
  return partial.length === 1 ? partial[0] : undefined;
}

function describeValues(dimension: DimensionMeta): string {
  const shown = dimension.values.slice(0, 8).join(", ");
  const more = dimension.values.length > 8 ? `, … (${dimension.values.length} total)` : "";
  return `Accepts: ${shown}${more}.`;
}

/**
 * Cache key covering everything that changes the response: table, granularity, the
 * exact period codes, and the resolved filters. Periods and filter values are
 * sorted so two callers who ask for the same slice in a different order share one
 * entry.
 */
function dataCacheKey(
  table: TableDef,
  granularity: Granularity,
  periods: readonly PeriodMeta[],
  selections: readonly PxQuerySelection[],
): string {
  const periodPart = periods.map((p) => p.code).sort().join(",");
  const filterPart = [...selections]
    .sort((a, b) => a.code.localeCompare(b.code))
    .map((s) => `${s.code}=${[...s.selection.values].sort().join("|")}`)
    .join(";");
  // v2: the parser began sorting rows oldest-first. What is cached is the *parsed*
  // value, so entries written before that change still hold the old row order and a
  // key bump is the only way to stop serving them for up to a day.
  return `gss:data:v2:${table.id}:${granularity}:${periodPart}:${filterPart}`;
}
