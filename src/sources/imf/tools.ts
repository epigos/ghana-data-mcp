import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readThrough, type Cache } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { ResultMetaSchema, toolError, toolResult, type DataOrigin } from "../../lib/results.js";
import { ImfClient } from "./client.js";
import { parseEntitiesPayload, parseIndicatorsPayload, parseSeriesPayload } from "./parser.js";
import {
  IndicatorMetaSchema,
  IndicatorSeriesSchema,
  MAX_COUNTRIES_PER_CALL,
  MAX_INDICATORS_PER_CALL,
  MAX_YEAR,
  MIN_YEAR,
  type EntityMeta,
} from "./types.js";

/**
 * MCP tool surface for IMF DataMapper data, namespaced `imf_`.
 *
 * Two tools: a catalog search (`imf_list_indicators`) and the timeseries fetch
 * (`imf_get_indicator_history`). Both go through the same cached indicator
 * catalog, since the history tool needs it anyway to validate the ids a caller
 * asks for — see below on why that validation has to happen here rather than
 * upstream. The history tool also draws on a second, similarly cached catalog of
 * countries, regions and analytical groups, for the same reason.
 */

export interface ImfDeps {
  client: ImfClient;
  cache: Cache;
  logger?: Logger;
}

const INDICATORS_CACHE_KEY = "imf:indicators:v1";
/** The catalog changes a few times a year at most. */
const INDICATORS_TTL_SECONDS = 7 * 24 * 60 * 60;

const ENTITIES_CACHE_KEY = "imf:entities:v1";
/** Country, region and group lists change even less often than indicators. */
const ENTITIES_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A past request never changes, so the whole series is cached, not per-window. */
const SERIES_TTL_SECONDS = 24 * 60 * 60;

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

/** Ghana's own data if a caller names no `countries` at all. */
const DEFAULT_COUNTRIES = ["GHA"];

export function registerImfTools(server: McpServer, deps: ImfDeps): void {
  const log = (deps.logger ?? silentLogger).child({ source: "imf" });

  server.registerTool(
    "imf_list_indicators",
    {
      title: "Search IMF indicators for Ghana",
      description:
        "Search the IMF DataMapper indicator catalog by keyword — matches against the label, " +
        "description and dataset (e.g. \"gdp\", \"inflation\", \"debt\", \"current account\"). " +
        "Returns each match's `id`, which is what to pass to imf_get_indicator_history. Omit " +
        "`query` to browse the catalog. Covers ~130 macroeconomic and financial indicators " +
        "spanning the World Economic Outlook and several other IMF datasets.",
      inputSchema: {
        query: z.string().optional().describe("Keyword to search for. Omit to list everything."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(MAX_LIST_LIMIT)
          .optional()
          .describe(`Maximum matches. Default ${DEFAULT_LIST_LIMIT}.`),
      },
      outputSchema: {
        indicatorCount: z.number(),
        indicators: z.array(IndicatorMetaSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ query, limit }) => {
      log.info("tool: imf_list_indicators", { query: query ?? "(none)" });

      try {
        const { catalog, meta } = await loadIndicatorCatalog(deps);
        const all = Object.values(catalog);
        const ranked = query
          ? rankByQuery(all, query, scoreIndicator, (i) => i.label)
          : all.slice().sort((a, b) => a.id.localeCompare(b.id));
        const indicators = ranked.slice(0, limit ?? DEFAULT_LIST_LIMIT);

        const warning = query && indicators.length === 0 ? `No indicator matched "${query}".` : undefined;

        return toolResult({
          indicatorCount: indicators.length,
          indicators,
          meta: mergeWarning(meta, warning),
        });
      } catch (error) {
        log.error("tool: imf_list_indicators failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );

  server.registerTool(
    "imf_get_indicator_history",
    {
      title: "IMF macroeconomic indicator history",
      description:
        "Time series for one or more IMF indicators, for Ghana and — optionally — other " +
        "countries, regions or analytical groups, oldest first. Use imf_list_indicators first " +
        "if you don't already know the indicator code — codes like NGDP_RPCH are not guessable " +
        "from the name. Most indicators include IMF's OWN forward projections alongside " +
        "historical actuals; each row's `isProjection` says which — always tell the user when a " +
        "figure quoted is a projection rather than an outturn. Coverage varies a lot: some " +
        "indicators run 1980-2031, some cover only a handful of recent years, and not every " +
        "indicator has data for every country. Region/group aggregates (e.g. Sub-Saharan " +
        "Africa, ECOWAS) exist for some indicators and not others — this is not something to " +
        "guess at, check `rowCount`.",
      inputSchema: {
        indicators: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_INDICATORS_PER_CALL)
          .describe(
            `One to ${MAX_INDICATORS_PER_CALL} indicator codes, e.g. ["NGDP_RPCH", "PCPIPCH"]. ` +
              "Case-insensitive.",
          ),
        countries: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_COUNTRIES_PER_CALL)
          .optional()
          .describe(
            `Which countries, regions or groups to compare — up to ${MAX_COUNTRIES_PER_CALL}. ` +
              "Accepts an IMF code (\"NGA\"), a plain country name (\"Nigeria\"), or a " +
              "region/group name (\"Sub-Saharan Africa\", \"ECOWAS\"). Case-insensitive. Omit " +
              "for Ghana alone.",
          ),
        startYear: z.number().int().min(MIN_YEAR).max(MAX_YEAR).optional().describe("Omit for earliest available."),
        endYear: z.number().int().min(MIN_YEAR).max(MAX_YEAR).optional().describe("Omit for latest available, including projections."),
      },
      outputSchema: {
        series: z.array(IndicatorSeriesSchema),
        meta: ResultMetaSchema,
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ indicators, countries, startYear, endYear }) => {
      log.info("tool: imf_get_indicator_history", {
        indicators: indicators.join(","),
        countries: (countries ?? DEFAULT_COUNTRIES).join(","),
        startYear: startYear ?? "(earliest)",
        endYear: endYear ?? "(latest)",
      });

      if (startYear !== undefined && endYear !== undefined && startYear > endYear) {
        return toolError(`startYear (${startYear}) must not be after endYear (${endYear}).`);
      }

      try {
        const [{ catalog: indicatorCatalog }, { catalog: entityCatalog }] = await Promise.all([
          loadIndicatorCatalog(deps),
          loadEntityCatalog(deps),
        ]);

        const { resolved: resolvedIndicators, unresolved: unresolvedIndicators } = resolveAll(
          indicators,
          (requested) => resolveIndicatorId(indicatorCatalog, requested),
        );
        if (resolvedIndicators.length === 0) {
          return toolError(
            `None of these are recognized IMF indicator codes: ${unresolvedIndicators.join(", ")}. ` +
              "Call imf_list_indicators to find the right code.",
          );
        }

        const requestedCountries = countries ?? DEFAULT_COUNTRIES;
        const { resolved: resolvedEntities, unresolved: unresolvedCountries } = resolveAll(
          requestedCountries,
          (requested) => resolveEntityId(entityCatalog, requested),
        );
        if (resolvedEntities.length === 0) {
          return toolError(
            `None of these are recognized countries, regions or groups: ${unresolvedCountries.join(", ")}. ` +
              "Try an IMF code (e.g. \"NGA\") or the plain country name.",
          );
        }

        // Dedupe and sort both dimensions so the same request always hits the same
        // cache entry regardless of the order or repetition a caller happened to use.
        const indicatorIds = [...new Set(resolvedIndicators)].sort();
        const entities = dedupeEntitiesById(resolvedEntities).sort((a, b) => a.id.localeCompare(b.id));
        const key = `imf:series:v1:${indicatorIds.join(",")}:${entities.map((e) => e.id).join(",")}`;

        const result = await readThrough(deps.cache, key, SERIES_TTL_SECONDS, async () =>
          parseSeriesPayload(await deps.client.fetchSeries(indicatorIds), indicatorIds, entities),
        );

        const { series: fullSeries, skipped } = result.value;
        const series = fullSeries.map((s) => ({
          ...s,
          rows: s.rows.filter(
            (row) =>
              (startYear === undefined || row.year >= startYear) &&
              (endYear === undefined || row.year <= endYear),
          ),
        }));
        for (const s of series) s.rowCount = s.rows.length;

        log.info("tool: imf_get_indicator_history done", {
          indicators: indicatorIds.join(","),
          countries: entities.map((e) => e.id).join(","),
          rows: series.reduce((sum, s) => sum + s.rowCount, 0),
          skipped: skipped || undefined,
          origin: result.origin,
        });

        const warnings: string[] = [];
        if (result.origin === "stale-cache") {
          warnings.push(
            `The IMF DataMapper API could not be reached (${result.staleReason}); serving a cached copy from ${Math.round(result.ageSeconds / 3600)} hour(s) ago.`,
          );
        }
        if (unresolvedIndicators.length > 0) {
          warnings.push(
            `These indicator codes were not recognized and were skipped: ${unresolvedIndicators.join(", ")}. Call imf_list_indicators to find the right code.`,
          );
        }
        if (unresolvedCountries.length > 0) {
          warnings.push(
            `These countries/regions/groups were not recognized and were skipped: ${unresolvedCountries.join(", ")}.`,
          );
        }
        for (const s of series) {
          if (s.rowCount === 0) {
            warnings.push(`${s.indicatorId} has no published data for ${s.entityLabel}.`);
          }
        }

        return toolResult({
          series,
          meta: {
            origin: result.origin as DataOrigin,
            ageSeconds: result.ageSeconds,
            skippedRows: skipped,
            ...(warnings.length > 0 ? { warning: warnings.join(" ") } : {}),
          },
        });
      } catch (error) {
        log.error("tool: imf_get_indicator_history failed", { reason: describeError(error) });
        return toolError(describeError(error));
      }
    },
  );
}

/** Shared indicator-catalog loader: both tools need it, one cached fetch serves both. */
async function loadIndicatorCatalog(
  deps: ImfDeps,
): Promise<{ catalog: Record<string, z.infer<typeof IndicatorMetaSchema>>; meta: z.infer<typeof ResultMetaSchema> }> {
  const result = await readThrough(deps.cache, INDICATORS_CACHE_KEY, INDICATORS_TTL_SECONDS, async () => {
    const { indicators } = parseIndicatorsPayload(await deps.client.fetchIndicators());
    return indicators;
  });

  return {
    catalog: result.value,
    meta: {
      origin: result.origin as DataOrigin,
      ageSeconds: result.ageSeconds,
      ...(result.origin === "stale-cache"
        ? { warning: `Serving a cached indicator catalog; live fetch failed (${result.staleReason}).` }
        : {}),
    },
  };
}

/**
 * Merges the countries, regions and groups catalogs into one lookup, tagging each
 * entry with which kind it is. Cached and fetched as a single unit — three catalogs
 * that together change a handful of times a year don't need three separate cache
 * entries and TTLs.
 *
 * Merge order is groups, then regions, then countries, so that in the unlikely
 * event an id were ever reused across catalogs, the country reading wins — that is
 * overwhelmingly the more common intent behind a bare code like "NGA". No such
 * collision has been observed in practice.
 */
async function loadEntityCatalog(
  deps: ImfDeps,
): Promise<{ catalog: Record<string, EntityMeta> }> {
  const result = await readThrough(deps.cache, ENTITIES_CACHE_KEY, ENTITIES_TTL_SECONDS, async () => {
    const [groups, regions, countries] = await Promise.all([
      deps.client.fetchEntities("group"),
      deps.client.fetchEntities("region"),
      deps.client.fetchEntities("country"),
    ]);
    return {
      ...parseEntitiesPayload(groups, "group"),
      ...parseEntitiesPayload(regions, "region"),
      ...parseEntitiesPayload(countries, "country"),
    };
  });

  return { catalog: result.value };
}

/** Resolves a caller-supplied id case-insensitively; the API itself is case-sensitive. */
function resolveIndicatorId(
  catalog: Record<string, z.infer<typeof IndicatorMetaSchema>>,
  requested: string,
): string | undefined {
  const wanted = requested.trim().toUpperCase();
  if (catalog[requested]) return requested;
  return Object.keys(catalog).find((id) => id.toUpperCase() === wanted);
}

/**
 * Resolves a caller-supplied country/region/group to its canonical entity.
 *
 * An exact code match (case-insensitive) always wins outright — a caller who
 * already knows "NGA" should never have that overridden by a coincidental label
 * match. Failing that, the best-scoring label match is used, which is what lets a
 * model just write "Nigeria" or "Sub-Saharan Africa" without knowing IMF's codes at
 * all. On a genuine tie the first-found candidate wins silently; a caller who needs
 * to disambiguate should use the precise code instead.
 */
function resolveEntityId(
  catalog: Record<string, EntityMeta>,
  requested: string,
): EntityMeta | undefined {
  const trimmed = requested.trim();
  if (!trimmed) return undefined;

  const exactByCode = catalog[trimmed] ?? Object.values(catalog).find(
    (entity) => entity.id.toLowerCase() === trimmed.toLowerCase(),
  );
  if (exactByCode) return exactByCode;

  const wanted = trimmed.toLowerCase();
  let best: EntityMeta | undefined;
  let bestScore = 0;
  for (const entity of Object.values(catalog)) {
    const score = scoreEntity(entity, wanted);
    if (score > bestScore) {
      bestScore = score;
      best = entity;
    }
  }
  return best;
}

/** Runs `resolve` over every requested string, splitting hits from misses. */
function resolveAll<T>(
  requested: readonly string[],
  resolve: (value: string) => T | undefined,
): { resolved: T[]; unresolved: string[] } {
  const resolved: T[] = [];
  const unresolved: string[] = [];

  for (const value of requested) {
    const hit = resolve(value);
    if (hit !== undefined) resolved.push(hit);
    else unresolved.push(value);
  }

  return { resolved, unresolved };
}

function dedupeEntitiesById(entities: readonly EntityMeta[]): EntityMeta[] {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  return [...byId.values()];
}

/**
 * Ranks catalog entries for a keyword query. Both catalogs here are small
 * (~130 indicators, ~400 entities across countries/regions/groups combined) and
 * mostly distinguished by plain-English labels, so a simple tiered substring match
 * — not GSE's fuzzy scoring, built for genuine name ambiguity across 40 companies —
 * is the right amount of machinery for either. Ties are broken alphabetically by
 * label so the result order is deterministic rather than an accident of whatever
 * order the catalog happened to arrive in.
 */
function rankByQuery<T>(
  items: readonly T[],
  query: string,
  score: (item: T, query: string) => number,
  labelOf: (item: T) => string,
): T[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];

  return items
    .map((item) => ({ item, score: score(item, wanted) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || labelOf(a.item).localeCompare(labelOf(b.item)))
    .map((entry) => entry.item);
}

function scoreIndicator(indicator: z.infer<typeof IndicatorMetaSchema>, query: string): number {
  const id = indicator.id.toLowerCase();
  const label = indicator.label.toLowerCase();

  if (id === query) return 1;
  if (label === query) return 0.95;
  if (label.split(/\W+/).includes(query)) return 0.85;
  if (label.startsWith(query)) return 0.8;
  if (label.includes(query)) return 0.6;
  if (indicator.dataset.toLowerCase() === query) return 0.5;
  if (indicator.description.toLowerCase().includes(query)) return 0.3;
  return 0;
}

function scoreEntity(entity: EntityMeta, query: string): number {
  const id = entity.id.toLowerCase();
  const label = entity.label.toLowerCase();

  if (id === query) return 1;
  if (label === query) return 0.95;
  if (label.split(/\W+/).includes(query)) return 0.85;
  if (label.startsWith(query)) return 0.8;
  if (label.includes(query)) return 0.6;
  return 0;
}

function mergeWarning(
  meta: z.infer<typeof ResultMetaSchema>,
  extra?: string,
): z.infer<typeof ResultMetaSchema> {
  if (!extra) return meta;
  return { ...meta, warning: meta.warning ? `${meta.warning} ${extra}` : extra };
}
