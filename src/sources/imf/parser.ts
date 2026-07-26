import { ParseError } from "../../lib/errors.js";
import { stripHtml } from "../../lib/text.js";
import type { EntityKind, EntityMeta, IndicatorMeta, IndicatorPoint, IndicatorSeries } from "./types.js";

/**
 * Pure transformation of IMF DataMapper responses. No network, no bindings —
 * everything here is unit-testable against the fixtures in test/fixtures.
 */

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
  const raw = extractDict(payload, "indicators");
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

/**
 * Normalizes a `/countries`, `/regions` or `/groups` catalog response — all three
 * share the same `{ [id]: { label } }` shape, just under a different top-level key
 * and with a different `kind` tag applied here, since the response itself does not
 * say which one it is.
 *
 * A few region/group labels carry a stray trailing space in the real catalog (e.g.
 * `"Sub-Saharan Africa (Region) "`), which is exactly the kind of mess `stripHtml`
 * already exists to clean up.
 */
export function parseEntitiesPayload(payload: unknown, kind: EntityKind): Record<string, EntityMeta> {
  const key = kind === "country" ? "countries" : kind === "region" ? "regions" : "groups";
  const raw = extractDict(payload, key);
  const entities: Record<string, EntityMeta> = {};

  for (const [id, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object") continue;
    const label = stripHtml((entry as Record<string, unknown>).label) || id;
    entities[id] = { id, label, kind };
  }

  return entities;
}

function extractDict(payload: unknown, key: string): Record<string, unknown> {
  if (!payload || typeof payload !== "object") {
    throw new ParseError("expected a JSON object from the DataMapper API");
  }
  const dict = (payload as Record<string, unknown>)[key];
  if (!dict || typeof dict !== "object") {
    throw new ParseError(`response has no \`${key}\` object — the API shape may have changed`);
  }
  return dict as Record<string, unknown>;
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
 * Normalizes a `/api/v2/{id1}/{id2}/...` response into one series per
 * (indicator, entity) pair, ordered indicators-major then entities.
 *
 * `entities` is metadata the caller already resolved (country name or code, region,
 * or analytical group) — this function only reads the matching row out of
 * `values[indicatorId][entityId]`; it does not know or care how that id was
 * chosen. A country, a region and a group all sit in the exact same place in the
 * response, which is what makes supporting all three free once one works.
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
 *  - **A perfectly valid indicator can still have no row for a given entity.** Not
 *    every one of IMF's ~130 indicators covers every country, and region/group
 *    aggregates are dataset-dependent rather than universal — `ECOWAS` has no row
 *    on the general WEO GDP-growth indicator but does on the Africa-specific
 *    AFRREO equivalent. That is a normal "no data" outcome, not a parse failure:
 *    the series comes back with zero rows, and nothing is counted as skipped.
 */
export function parseSeriesPayload(
  payload: unknown,
  indicatorIds: readonly string[],
  entities: readonly EntityMeta[],
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
  const series: IndicatorSeries[] = [];

  for (const indicatorId of indicatorIds) {
    const meta = metaById[indicatorId];
    const projectionStartYear = toYear(meta?.["projection-year"]);
    const countryValues = valuesById[indicatorId];

    for (const entity of entities) {
      const entityRow = countryValues?.[entity.id] as Record<string, unknown> | undefined;
      const { rows, skipped: rowsSkipped } = parseYearValueRows(entityRow, options);
      skipped += rowsSkipped;

      series.push(buildSeries(indicatorId, meta, projectionStartYear, entity, rows));
    }
  }

  return { series, skipped };
}

function buildSeries(
  indicatorId: string,
  meta: Record<string, unknown> | undefined,
  projectionStartYear: number | null,
  entity: EntityMeta,
  rows: Array<{ year: number; value: number }>,
): IndicatorSeries {
  // isProjection is safe to compute unconditionally: for an indicator with no
  // forecast horizon at all, no row's year ever reaches projectionStartYear, so the
  // flag simply never fires — verified directly against a historical-only
  // indicator (Wang-Jahan capital-openness index) alongside a WEO series that does
  // carry real forecasts. It is an indicator-level property, so it applies the
  // same way regardless of which entity's row this is.
  const pointRows: IndicatorPoint[] = rows.map((row) => ({
    ...row,
    isProjection: projectionStartYear !== null && row.year >= projectionStartYear,
  }));

  return {
    indicatorId,
    indicatorLabel: stripHtml(meta?.label) || indicatorId,
    unit: stripHtml(meta?.unit),
    source: stripHtml(meta?.source),
    dataset: typeof meta?.dataset === "string" ? meta.dataset : "",
    ...(projectionStartYear !== null ? { projectionStartYear } : {}),
    entityId: entity.id,
    entityLabel: entity.label,
    entityKind: entity.kind,
    rowCount: pointRows.length,
    rows: pointRows,
  };
}

function parseYearValueRows(
  entityRow: Record<string, unknown> | undefined,
  options: ParseSeriesOptions,
): { rows: Array<{ year: number; value: number }>; skipped: number } {
  if (!entityRow) return { rows: [], skipped: 0 };

  const rows: Array<{ year: number; value: number }> = [];
  let skipped = 0;

  for (const [yearKey, raw] of Object.entries(entityRow)) {
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
