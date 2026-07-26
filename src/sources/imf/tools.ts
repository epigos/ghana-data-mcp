import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readThrough, type Cache } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { ResultMetaSchema, toolError, toolResult, type DataOrigin } from "../../lib/results.js";
import { ImfClient } from "./client.js";
import { parseIndicatorsPayload, parseSeriesPayload } from "./parser.js";
import {
  IndicatorMetaSchema,
  IndicatorSeriesSchema,
  MAX_INDICATORS_PER_CALL,
  MAX_YEAR,
  MIN_YEAR,
} from "./types.js";

/**
 * MCP tool surface for IMF DataMapper data, namespaced `imf_`.
 *
 * Two tools: a catalog search (`imf_list_indicators`) and the timeseries fetch
 * (`imf_get_indicator_history`). Both go through the same cached indicator
 * catalog, since the history tool needs it anyway to validate the ids a caller
 * asks for — see below on why that validation has to happen here rather than
 * upstream.
 */

export interface ImfDeps {
  client: ImfClient;
  cache: Cache;
  logger?: Logger;
}

const INDICATORS_CACHE_KEY = "imf:indicators:v1";
/** The catalog changes a few times a year at most. */
const INDICATORS_TTL_SECONDS = 7 * 24 * 60 * 60;

/** A past request never changes, so the whole series is cached, not per-window. */
const SERIES_TTL_SECONDS = 24 * 60 * 60;

const DEFAULT_LIST_LIMIT = 25;
const MAX_LIST_LIMIT = 100;

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
        const { catalog, meta } = await loadCatalog(deps);
        const all = Object.values(catalog);
        const ranked = query ? rankByQuery(all, query) : all.slice().sort((a, b) => a.id.localeCompare(b.id));
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
      title: "Ghana macroeconomic indicator history",
      description:
        "Time series for one or more IMF indicators, for Ghana, oldest first. Use " +
        "imf_list_indicators first if you don't already know the indicator code — codes like " +
        "NGDP_RPCH are not guessable from the name. Most indicators include IMF's OWN forward " +
        "projections alongside historical actuals; each row's `isProjection` says which — " +
        "always tell the user when a figure quoted is a projection rather than an outturn. " +
        "Coverage varies a lot: some indicators run 1980-2031, some only cover a handful of " +
        "recent years, and not every indicator has Ghana data at all.",
      inputSchema: {
        indicators: z
          .array(z.string().min(1))
          .min(1)
          .max(MAX_INDICATORS_PER_CALL)
          .describe(
            `One to ${MAX_INDICATORS_PER_CALL} indicator codes, e.g. ["NGDP_RPCH", "PCPIPCH"]. ` +
              "Case-insensitive.",
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
    async ({ indicators, startYear, endYear }) => {
      log.info("tool: imf_get_indicator_history", {
        indicators: indicators.join(","),
        startYear: startYear ?? "(earliest)",
        endYear: endYear ?? "(latest)",
      });

      if (startYear !== undefined && endYear !== undefined && startYear > endYear) {
        return toolError(`startYear (${startYear}) must not be after endYear (${endYear}).`);
      }

      try {
        const { catalog } = await loadCatalog(deps);
        const resolved: string[] = [];
        const unresolved: string[] = [];

        for (const requested of indicators) {
          const canonical = resolveIndicatorId(catalog, requested);
          if (canonical) resolved.push(canonical);
          else unresolved.push(requested);
        }

        if (resolved.length === 0) {
          return toolError(
            `None of these are recognized IMF indicator codes: ${unresolved.join(", ")}. ` +
              "Call imf_list_indicators to find the right code.",
          );
        }

        // Dedupe and sort so the same set of indicators always hits the same cache
        // entry regardless of the order or repetition a caller happened to use.
        const ids = [...new Set(resolved)].sort();
        const key = `imf:series:v1:${ids.join(",")}`;

        const result = await readThrough(deps.cache, key, SERIES_TTL_SECONDS, async () =>
          parseSeriesPayload(await deps.client.fetchSeries(ids), ids),
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
          indicators: ids.join(","),
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
        if (unresolved.length > 0) {
          warnings.push(
            `These were not recognized and were skipped: ${unresolved.join(", ")}. Call imf_list_indicators to find the right code.`,
          );
        }
        for (const s of series) {
          if (s.rowCount === 0) {
            warnings.push(`${s.id} has no published data for Ghana.`);
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

/** Shared catalog loader: both tools need it, one cached fetch serves both. */
async function loadCatalog(
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
 * Ranks indicators for a keyword query. The catalog is small (~130 entries) and
 * mostly distinguished by plain-English labels, so a simple tiered substring match
 * — not GSE's fuzzy scoring, built for genuine name ambiguity across 40 companies —
 * is the right amount of machinery here.
 */
function rankByQuery(
  indicators: readonly z.infer<typeof IndicatorMetaSchema>[],
  query: string,
): z.infer<typeof IndicatorMetaSchema>[] {
  const wanted = query.trim().toLowerCase();
  if (!wanted) return [];

  const scored = indicators
    .map((indicator) => ({ indicator, score: scoreIndicator(indicator, wanted) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.indicator.label.localeCompare(b.indicator.label));

  return scored.map((entry) => entry.indicator);
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

function mergeWarning(
  meta: z.infer<typeof ResultMetaSchema>,
  extra?: string,
): z.infer<typeof ResultMetaSchema> {
  if (!extra) return meta;
  return { ...meta, warning: meta.warning ? `${meta.warning} ${extra}` : extra };
}
