import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { readThrough, type Cache } from "../../lib/cache.js";
import { describeError } from "../../lib/errors.js";
import { TemplateClient } from "./client.js";
import { parseTemplatePayload } from "./parser.js";

/**
 * MCP registration for a new source.
 *
 * Conventions to keep (see CONTRIBUTING.md):
 *   - prefix every tool name with the source namespace, e.g. `bog_get_fx_rate`
 *   - cache through `readThrough` so an upstream outage degrades to stale data
 *   - report `meta.origin` so a caller can tell live data from a cached copy
 *   - return `isError: true` with a readable message; never throw at the client
 */

export interface TemplateDeps {
  client: TemplateClient;
  cache: Cache;
}

const NAMESPACE = "template";
const TTL_SECONDS = 15 * 60;

export function registerTemplateTools(server: McpServer, deps: TemplateDeps): void {
  server.registerTool(
    `${NAMESPACE}_get_something`,
    {
      title: "Get something",
      description: "One sentence on what this returns and when a model should reach for it.",
      inputSchema: {
        id: z.string().min(1).describe("What the caller must supply."),
      },
      outputSchema: {
        rows: z.array(z.object({ id: z.string(), value: z.number() })),
        meta: z.object({ origin: z.string(), ageSeconds: z.number(), warning: z.string().optional() }),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        const result = await readThrough(deps.cache, `${NAMESPACE}:something:v1:${id}`, TTL_SECONDS, async () =>
          parseTemplatePayload(await deps.client.fetchSomething()),
        );

        const payload = {
          rows: result.value.rows,
          meta: {
            origin: result.origin,
            ageSeconds: result.ageSeconds,
            ...(result.origin === "stale-cache"
              ? { warning: `Upstream failed (${result.staleReason}); serving a cached copy.` }
              : {}),
          },
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        };
      } catch (error) {
        console.error(`${NAMESPACE}_get_something failed`, error);
        return {
          content: [{ type: "text" as const, text: describeError(error) }],
          isError: true as const,
        };
      }
    },
  );
}
