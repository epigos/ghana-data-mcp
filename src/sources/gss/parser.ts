import { ParseError } from "../../lib/errors.js";
import { stripHtml } from "../../lib/text.js";
import { parsePeriod, parsePeriods, sortChronologically } from "./period.js";
import type { TableDef } from "./tables.js";
import type { DataRow, DimensionMeta, Granularity, PeriodMeta } from "./types.js";

/**
 * Pure transformation of PxWeb responses. No network, no bindings — everything
 * here is unit-testable against the fixtures in test/fixtures.
 */

export interface ParsedTableSchema {
  title: string;
  periods: PeriodMeta[];
  dimensions: DimensionMeta[];
  /** Axis codes that did not parse as a period, so a shape change is visible rather than silent. */
  unparsedPeriods: string[];
}

/**
 * Normalizes a GET table-schema response.
 *
 * The response is `{ title, variables: [{ code, text, values, valueTexts, time? }] }`.
 * The time axis is taken from `table.timeVariable` rather than the `time` flag,
 * because StatsBank only sets that flag on half its tables — see tables.ts.
 *
 * `values` and `valueTexts` are parallel arrays: `values` is what the API accepts in
 * a query, `valueTexts` is the display form. They are identical on every StatsBank
 * table checked, so only `values` is kept — sending a `valueText` back would be the
 * bug, and keeping both invites it.
 */
export function parseTableSchema(payload: unknown, table: TableDef): ParsedTableSchema {
  if (!payload || typeof payload !== "object") {
    throw new ParseError("expected a JSON object from the StatsBank API");
  }
  const variables = (payload as { variables?: unknown }).variables;
  if (!Array.isArray(variables)) {
    throw new ParseError("schema response has no `variables` array — the API shape may have changed");
  }

  const title = stripHtml((payload as { title?: unknown }).title) || table.title;
  let periods: PeriodMeta[] = [];
  let unparsedPeriods: string[] = [];
  const dimensions: DimensionMeta[] = [];

  for (const entry of variables) {
    if (!entry || typeof entry !== "object") continue;
    const variable = entry as Record<string, unknown>;
    const code = typeof variable.code === "string" ? variable.code : "";
    if (!code) continue;

    const values = Array.isArray(variable.values)
      ? variable.values.filter((v): v is string => typeof v === "string")
      : [];

    if (code === table.timeVariable) {
      periods = sortChronologically(parsePeriods(values));
      unparsedPeriods = values.filter((value) => !parsePeriod(value));
      continue;
    }

    dimensions.push({
      code,
      label: stripHtml(variable.text) || code,
      valueCount: values.length,
      values,
    });
  }

  if (periods.length === 0) {
    throw new ParseError(
      `schema response has no readable \`${table.timeVariable}\` axis for table "${table.id}" — ` +
        "the table may have been restructured upstream",
    );
  }

  return { title, periods, dimensions, unparsedPeriods };
}

export interface ParsedTableData {
  title: string;
  source: string;
  updated?: string;
  rows: DataRow[];
  /** Observations dropped for a non-numeric or unreadable value. */
  skipped: number;
}

interface ColumnDef {
  code: string;
  text: string;
  type: string;
}

/**
 * Normalizes a POST data response into flat, self-describing rows.
 *
 * The response shape is:
 *
 * ```
 * columns: [{ code, text, type }]   type "t" = time, "d" = dimension, "c" = content
 * data:    [{ key: [...], values: [...] }]
 * metadata:[{ updated, label, source }]
 * ```
 *
 * `key` aligns positionally with the non-content columns; `values` aligns with the
 * content columns. Most StatsBank tables have exactly one content column (the
 * measure a caller selected via an `Indicator` dimension), but the layout allows
 * several, so each content column becomes its own row tagged with `measure`.
 *
 * Two behaviours worth knowing:
 *
 *  - **Missing observations are dropped, not zeroed.** PxWeb writes an unavailable
 *    value as `".."`, `"."` or `"-"`, and a real zero as `"0.00"`. Coercing the
 *    former to 0 would put a fabricated zero into a series a caller might average.
 *    Dropped observations are counted into `skipped` and reported as
 *    `meta.skippedRows`.
 *  - **`provisional` is carried per row**, from the asterisks on the period code, so
 *    a caller can tell a finalized figure from one GSS may still revise.
 */
export function parseTableData(payload: unknown, table: TableDef): ParsedTableData {
  if (!payload || typeof payload !== "object") {
    throw new ParseError("expected a JSON object from the StatsBank API");
  }
  const body = payload as Record<string, unknown>;

  const columns = Array.isArray(body.columns) ? (body.columns as unknown[]) : [];
  const parsedColumns: ColumnDef[] = [];
  for (const entry of columns) {
    if (!entry || typeof entry !== "object") continue;
    const column = entry as Record<string, unknown>;
    parsedColumns.push({
      code: typeof column.code === "string" ? column.code : "",
      text: stripHtml(column.text),
      type: typeof column.type === "string" ? column.type : "",
    });
  }

  const contentColumns = parsedColumns.filter((c) => c.type === "c");
  const keyColumns = parsedColumns.filter((c) => c.type !== "c");
  if (contentColumns.length === 0 || keyColumns.length === 0) {
    throw new ParseError(
      "data response has no usable `columns` — expected at least one key column and one content column",
    );
  }

  // Prefer the registry's declared time variable; fall back to whatever PxWeb
  // typed as "t" for a table whose axis was renamed upstream.
  let timeIndex = keyColumns.findIndex((c) => c.code === table.timeVariable);
  if (timeIndex === -1) timeIndex = keyColumns.findIndex((c) => c.type === "t");
  if (timeIndex === -1) {
    throw new ParseError(
      `data response has no \`${table.timeVariable}\` column for table "${table.id}"`,
    );
  }

  const metadata = Array.isArray(body.metadata) ? (body.metadata as unknown[]) : [];
  const firstMeta = (metadata[0] ?? {}) as Record<string, unknown>;
  const updated = typeof firstMeta.updated === "string" ? firstMeta.updated : undefined;

  const data = Array.isArray(body.data) ? (body.data as unknown[]) : [];
  const rows: DataRow[] = [];
  let skipped = 0;

  for (const entry of data) {
    if (!entry || typeof entry !== "object") {
      skipped++;
      continue;
    }
    const observation = entry as Record<string, unknown>;
    const key = Array.isArray(observation.key) ? observation.key.map((k) => String(k)) : [];
    const values = Array.isArray(observation.values) ? observation.values : [];

    const period = parsePeriod(key[timeIndex] ?? "");
    if (!period) {
      skipped++;
      continue;
    }

    const dimensions: Record<string, string> = {};
    keyColumns.forEach((column, index) => {
      if (index === timeIndex) return;
      dimensions[column.code] = key[index] ?? "";
    });

    contentColumns.forEach((column, index) => {
      const numeric = toNumber(values[index]);
      if (numeric === undefined) {
        skipped++;
        return;
      }
      rows.push({
        period: period.label,
        granularity: period.granularity,
        provisional: period.provisional,
        dimensions,
        measure: column.text || column.code,
        value: numeric,
      });
    });
  }

  return {
    title: stripHtml(firstMeta.label) || table.title,
    source: stripHtml(firstMeta.source),
    ...(updated ? { updated } : {}),
    // PxWeb returns rows in the table's own storage order, which is newest-first on
    // most StatsBank tables and oldest-first on mieg. Every other source in this repo
    // promises oldest-first and `DataResultSchema` says so, so normalize here rather
    // than leaving the order to whichever table was asked for. Rows sharing a period
    // keep their relative order, so dimension groupings stay intact.
    rows: sortRowsChronologically(rows),
    skipped,
  };
}

function sortRowsChronologically(rows: readonly DataRow[]): DataRow[] {
  const rank: Record<Granularity, number> = { annual: 0, quarterly: 1, monthly: 2 };
  return rows
    .map((row, position) => ({ row, position, period: parsePeriod(row.period) }))
    .sort((a, b) => {
      const left = a.period;
      const right = b.period;
      if (left && right) {
        if (left.year !== right.year) return left.year - right.year;
        if (left.granularity !== right.granularity) {
          return rank[left.granularity] - rank[right.granularity];
        }
        if (left.index !== right.index) return left.index - right.index;
      }
      return a.position - b.position;
    })
    .map((entry) => entry.row);
}

/**
 * PxWeb ships every value as a string. A real figure parses; the missing-data
 * markers (`".."`, `"."`, `"-"`, `":"`, empty) and anything else non-finite do not,
 * and become a dropped observation rather than a zero.
 */
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  // Thousands separators appear in some PxWeb deployments; StatsBank does not use
  // them today, but stripping them costs nothing and avoids a silent drop if it starts.
  const cleaned = trimmed.replace(/,/g, "");
  if (!/^[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?$/.test(cleaned)) return undefined;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Distinct granularities present on an axis, in coarsest-first order. */
export function granularitiesOf(periods: readonly PeriodMeta[]): Granularity[] {
  const order: Granularity[] = ["annual", "quarterly", "monthly"];
  const present = new Set(periods.map((p) => p.granularity));
  return order.filter((g) => present.has(g));
}
