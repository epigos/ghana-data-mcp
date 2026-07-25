import { z } from "zod";

/**
 * The result envelope every source shares.
 *
 * This lived under `sources/gse/` while there was only one source. It belongs
 * here now: `meta.origin` is a promise the whole server makes to its callers, and
 * two sources answering it differently would be worse than not answering it.
 */

/** Where a result came from, so a stale or seeded answer is never passed off as live. */
export const DataOriginSchema = z.enum(["live", "cache", "stale-cache", "static-seed"]);
export type DataOrigin = z.infer<typeof DataOriginSchema>;

export const ResultMetaSchema = z.object({
  origin: DataOriginSchema.describe(
    "live = freshly fetched; cache = fresh cached copy; stale-cache = upstream failed, expired copy served; static-seed = built-in fallback list.",
  ),
  ageSeconds: z.number().describe("How long ago the data was fetched from the source site."),
  warning: z
    .string()
    .optional()
    .describe("Present when the data may be behind or incomplete. Pass this on to the user."),
  skippedRows: z
    .number()
    .optional()
    .describe("Rows dropped because required fields were missing or malformed."),
});
export type ResultMeta = z.infer<typeof ResultMetaSchema>;

/**
 * MCP results carry both `structuredContent` (typed, validated against the tool's
 * outputSchema) and a text block, because not every client reads the former.
 */
export function toolResult(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** An error the model can act on, rather than an exception at the transport. */
export function toolError(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}
