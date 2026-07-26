import { z } from "zod";

/**
 * IMF DataMapper types.
 *
 * The shared result envelope (`ResultMetaSchema`, `DataOrigin`) comes from
 * lib/results.ts and applies here unchanged.
 */

/**
 * The DataMapper's own multi-indicator ceiling isn't documented, but a request this
 * size stays comfortably under it and under a sensible per-call payload — see
 * client.ts for what one indicator costs.
 */
export const MAX_INDICATORS_PER_CALL = 8;

/** Sanity bounds on a year filter — wide enough that no real IMF series exceeds them. */
export const MIN_YEAR = 1900;
export const MAX_YEAR = 2100;

/**
 * Metadata for one indicator in the DataMapper catalog.
 *
 * `id` is what `imf_get_indicator_history` expects — not obvious from the label
 * alone (`NGDP_RPCH` for "Real GDP growth"), so it is always included.
 */
export const IndicatorMetaSchema = z.object({
  id: z.string().describe("Code to pass as one of the `indicators` to imf_get_indicator_history."),
  label: z.string().describe("Human-readable indicator name."),
  description: z.string().describe("What the indicator measures, in IMF's own words."),
  unit: z.string().describe("Unit of measurement, e.g. \"Annual percent change\", \"Percent of GDP\"."),
  source: z
    .string()
    .describe("Publication and vintage this figure was last drawn from, e.g. \"World Economic Outlook (April 2026)\"."),
  dataset: z.string().describe("IMF dataset code the indicator belongs to — WEO, GDD, AFRREO, and others."),
});
export type IndicatorMeta = z.infer<typeof IndicatorMetaSchema>;

/**
 * One year of one indicator for Ghana.
 *
 * `isProjection` is derived from the indicator's own `projection-year` boundary —
 * see parser.ts for why `year >= projectionYear` is safe to apply universally, even
 * for indicators with no forecast horizon at all.
 */
export const IndicatorPointSchema = z.object({
  year: z.number().describe("Calendar year."),
  value: z.number(),
  isProjection: z
    .boolean()
    .describe(
      "True if IMF has not finalized this year yet — an estimate or forecast, not an actual " +
        "outturn. Say so when reporting a value where this is true.",
    ),
});
export type IndicatorPoint = z.infer<typeof IndicatorPointSchema>;

/** One indicator's Ghana time series, with enough metadata to report it honestly. */
export const IndicatorSeriesSchema = z.object({
  id: z.string(),
  label: z.string(),
  unit: z.string(),
  source: z.string(),
  dataset: z.string(),
  projectionStartYear: z
    .number()
    .optional()
    .describe("First year IMF treats as non-final for this indicator. Absent if unknown."),
  rowCount: z.number(),
  rows: z.array(IndicatorPointSchema).describe("Oldest first."),
});
export type IndicatorSeries = z.infer<typeof IndicatorSeriesSchema>;
