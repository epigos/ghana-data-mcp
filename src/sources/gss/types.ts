import { z } from "zod";

/**
 * Ghana Statistical Service (StatsBank) types.
 *
 * The shared result envelope (`ResultMetaSchema`, `DataOrigin`) comes from
 * lib/results.ts and applies here unchanged.
 */

/** How many periods one call may return. Guards against pulling a whole table by accident. */
export const MAX_PERIODS_PER_CALL = 240;
/** Default when a caller names no period at all: the most recent year of monthly data. */
export const DEFAULT_LATEST_PERIODS = 12;
/** Ceiling on rows returned, after the dimension cross-product is applied. */
export const MAX_ROWS_PER_CALL = 3000;

export const GranularitySchema = z.enum(["annual", "quarterly", "monthly"]);
export type Granularity = z.infer<typeof GranularitySchema>;

/**
 * A parsed period from a table's time axis.
 *
 * `code` is what goes back to the API; `label` is the same period with provisional
 * markers stripped and separators normalized, which is what a caller sees and can
 * pass back in. `year`/`index` exist to sort chronologically — see period.ts on why
 * the upstream axis order cannot be trusted.
 */
export const PeriodMetaSchema = z.object({
  code: z.string().describe("Exact upstream period code, including any provisional asterisks."),
  label: z.string().describe("Normalized period, e.g. \"2024M06\", \"2024Q2\", \"2024\"."),
  granularity: GranularitySchema,
  year: z.number(),
  index: z.number().describe("Month 1-12, quarter 1-4, or 1 for an annual period."),
  provisional: z
    .boolean()
    .describe(
      "True when GSS marks the period unfinalized (a single asterisk upstream) or a forecast " +
        "(double asterisk). Say so when reporting a value from one of these.",
    ),
});
export type PeriodMeta = z.infer<typeof PeriodMetaSchema>;

/** One filterable non-time variable and the values it accepts. */
export const DimensionMetaSchema = z.object({
  code: z.string().describe("Pass this as a key in `filters`."),
  label: z.string().describe("Upstream display name for the variable."),
  valueCount: z.number(),
  values: z.array(z.string()).describe("Every accepted value, exactly as the API spells it."),
});
export type DimensionMeta = z.infer<typeof DimensionMetaSchema>;

/**
 * A table in the registry, as `gss_list_tables` returns it. No network needed —
 * see tables.ts on why the registry is static.
 */
export const TableMetaSchema = z.object({
  id: z.string().describe("Pass this as `table` to gss_describe_table or gss_get_data."),
  title: z.string(),
  sector: z.string(),
  summary: z.string(),
  timeVariable: z.string().describe("The variable holding the time axis for this table."),
  dimensions: z.array(z.string()).describe("Filterable non-time variables."),
  granularities: z.array(GranularitySchema).describe("Period granularities this table can serve."),
  granularityRequired: z
    .boolean()
    .describe(
      "True when the table interleaves annual, quarterly and monthly periods on one axis, so " +
        "`granularity` must be given or the series would mix a quarter with its own months.",
    ),
});
export type TableMeta = z.infer<typeof TableMetaSchema>;

/** A table's live schema: what periods exist right now and what each dimension accepts. */
export const TableSchemaSchema = z.object({
  id: z.string(),
  title: z.string(),
  sector: z.string(),
  timeVariable: z.string(),
  granularityRequired: z.boolean(),
  periodCount: z.number(),
  granularities: z.array(GranularitySchema),
  earliestPeriod: z.string().optional(),
  latestPeriod: z.string().optional(),
  /** Trimmed to the most recent slice; the full axis is rarely what a caller needs. */
  recentPeriods: z.array(z.string()).describe("Most recent periods, newest first."),
  dimensions: z.array(DimensionMetaSchema),
});
export type TableSchema = z.infer<typeof TableSchemaSchema>;

/**
 * One observation.
 *
 * `dimensions` maps each non-time variable to the value for this row, so a row is
 * self-describing without the caller having to re-derive it from a key array.
 * `measure` names the content column, which matters on the few tables that publish
 * more than one.
 */
export const DataRowSchema = z.object({
  period: z.string().describe("Normalized period label."),
  granularity: GranularitySchema,
  provisional: z
    .boolean()
    .describe("True when GSS has not finalized this period. Report it as provisional if so."),
  dimensions: z.record(z.string(), z.string()).describe("Non-time variable values for this row."),
  measure: z.string().describe("The content column this value came from."),
  value: z.number(),
});
export type DataRow = z.infer<typeof DataRowSchema>;

/**
 * A `gss_get_data` result.
 *
 * `source` and `updated` come from the response's own metadata block, so the
 * publishing agency (Bank of Ghana, National Petroleum Authority, GSS itself) and
 * the last-revised timestamp are always attributable rather than assumed.
 */
export const DataResultSchema = z.object({
  table: z.string(),
  title: z.string(),
  source: z.string().describe("Publishing agency, per the table's own metadata."),
  updated: z.string().optional().describe("When GSS last revised this table, ISO 8601."),
  granularity: GranularitySchema,
  periods: z.array(z.string()).describe("Periods actually returned, oldest first."),
  rowCount: z.number(),
  rows: z.array(DataRowSchema).describe("Oldest period first."),
});
export type DataResult = z.infer<typeof DataResultSchema>;
