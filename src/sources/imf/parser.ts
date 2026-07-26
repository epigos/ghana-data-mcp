import { ParseError } from "../../lib/errors.js";
import { stripHtml } from "../../lib/text.js";
import type { IndicatorMeta, IndicatorPoint, IndicatorSeries } from "./types.js";

/**
 * Pure transformation of IMF DataMapper responses. No network, no bindings —
 * everything here is unit-testable against the fixtures in test/fixtures.
 */

const GHANA_COUNTRY_CODE = "GHA";

export interface ParsedIndicatorCatalog {
  indicators: Record<string, IndicatorMeta>;
}

/**
 * Normalizes the `/indicators` catalog response.
 *
 * Labels and descriptions arrive with embedded newlines and, in at least one case
 * (the Gender Development Index entry), inline HTML — the same `stripHtml` every
 * source uses. `unit` is `null` for a couple of indicators (e.g. `rgc`, a bare
 * growth-rate percent in the FPP dataset); that becomes an empty string rather than
 * a hole a caller has to special-case.
 */
export function parseIndicatorsPayload(payload: unknown): ParsedIndicatorCatalog {
  const raw = extractIndicatorsDict(payload);
  const indicators: Record<string, IndicatorMeta> = {};

  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;

    indicators[id] = {
      id,
      label: stripHtml(e.label) || id,
      description: stripHtml(e.description),
      unit: stripHtml(e.unit),
      source: stripHtml(e.source),
      dataset: typeof e.dataset === "string" ? e.dataset : "",
    };
  }

  return { indicators };
}

function extractIndicatorsDict(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new ParseError("expected a JSON object from the DataMapper API");
  }
  const indicators = (payload as { indicators?: unknown }).indicators;
  if (!indicators || typeof indicators !== "object") {
    throw new ParseError("response has no `indicators` object — the API shape may have changed");
  }
  return indicators as Record<string, unknown>;
}

export interface ParseSeriesOptions {
  startYear?: number;
  endYear?: number;
}

export interface ParsedSeriesResult {
  series: IndicatorSeries[];
  /** Year/value pairs dropped for being malformed — not the same as "no data". */
  skipped: number;
}

/**
 * Normalizes a `/api/v2/{id1}/{id2}/...` response into one series per requested id,
 * Ghana only.
 *
 * Two things this defends against, both observed directly from the live API rather
 * than assumed:
 *
 *  - **An unrecognized indicator id is silently absent from the response.** Wrong
 *    case, a typo, or a genuinely invalid code all produce the same thing: no entry
 *    in `indicators`, no entry in `values` — not an error, not a placeholder. A
 *    request made of nothing but bad ids comes back `{"api": {...}}` with neither
 *    key at all. This parser does not distinguish that case from "legitimately no
 *    data" — it can't, the response looks the same either way — which is why
 *    `tools.ts` validates every id against the cached catalog *before* a request is
 *    ever made, and only calls this parser with ids already known to be real.
 *  - **A perfectly valid indicator can still have no Ghana row.** Not every one of
 *    IMF's 132 indicators covers every country — unemployment (`LUR`), for
 *    instance, covers 122 countries and Ghana is not one of them. That is a normal
 *    "no data" outcome, not a parse failure: the series comes back with zero rows,
 *    and nothing is counted as skipped for it.
 */
export function parseSeriesPayload(
  payload: unknown,
  indicatorIds: readonly string[],
  options: ParseSeriesOptions = {},
): ParsedSeriesResult {
  if (!payload || typeof payload !== "object") {
    throw new ParseError("expected a JSON object from the DataMapper API");
  }

  const metaById = ((payload as { indicators?: unknown }).indicators ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;
  const valuesById = ((payload as { values?: unknown }).values ?? {}) as Record<
    string,
    Record<string, unknown> | undefined
  >;

  let skipped = 0;
  const series = indicatorIds.map((id) => {
    const meta = metaById[id];
    const ghana = valuesById[id]?.[GHANA_COUNTRY_CODE] as Record<string, unknown> | undefined;

    const projectionStartYear = toYear(meta?.["projection-year"]);
    const { rows, skipped: rowsSkipped } = parseYearValueRows(ghana, options);
    skipped += rowsSkipped;

    return buildSeries(id, meta, projectionStartYear, rows);
  });

  return { series, skipped };
}

function buildSeries(
  id: string,
  meta: Record<string, unknown> | undefined,
  projectionStartYear: number | null,
  rows: Array<{ year: number; value: number }>,
): IndicatorSeries {
  // isProjection is safe to compute unconditionally: for an indicator with no
  // forecast horizon at all, no row's year ever reaches projectionStartYear, so the
  // flag simply never fires — verified directly against a historical-only
  // indicator (Wang-Jahan capital-openness index) alongside a WEO series that does
  // carry real forecasts.
  const pointRows: IndicatorPoint[] = rows.map((row) => ({
    ...row,
    isProjection: projectionStartYear !== null && row.year >= projectionStartYear,
  }));

  return {
    id,
    label: stripHtml(meta?.label) || id,
    unit: stripHtml(meta?.unit),
    source: stripHtml(meta?.source),
    dataset: typeof meta?.dataset === "string" ? meta.dataset : "",
    ...(projectionStartYear !== null ? { projectionStartYear } : {}),
    rowCount: pointRows.length,
    rows: pointRows,
  };
}

function parseYearValueRows(
  ghana: Record<string, unknown> | undefined,
  options: ParseSeriesOptions,
): { rows: Array<{ year: number; value: number }>; skipped: number } {
  if (!ghana) return { rows: [], skipped: 0 };

  const rows: Array<{ year: number; value: number }> = [];
  let skipped = 0;

  for (const [yearKey, raw] of Object.entries(ghana)) {
    const year = toYear(yearKey);
    if (year === null) {
      skipped++;
      continue;
    }
    if (typeof raw !== "number" || !Number.isFinite(raw)) {
      skipped++;
      continue;
    }
    if (options.startYear !== undefined && year < options.startYear) continue;
    if (options.endYear !== undefined && year > options.endYear) continue;
    rows.push({ year, value: raw });
  }

  rows.sort((a, b) => a.year - b.year);
  return { rows, skipped };
}

function toYear(value: unknown): number | null {
  const year = Number(value);
  return Number.isInteger(year) ? year : null;
}
