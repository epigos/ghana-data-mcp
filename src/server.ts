import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Env } from "./env.js";
import { createCache } from "./lib/cache.js";
import { SERVER_NAME, SERVER_VERSION } from "./meta.js";
import { GseClient } from "./sources/gse/client.js";
import { registerGseTools } from "./sources/gse/tools.js";

/**
 * Builds the MCP server and registers every source's toolset.
 *
 * Adding a data source means one import and one `register…Tools(server, …)` line
 * here — nothing else in the Worker changes.
 */
export function createServer(env: Env): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        "Public Ghana data. Tools are namespaced by source: `gse_*` covers the Ghana Stock " +
        "Exchange (company directory and daily price history). Share codes are required for " +
        "price lookups — resolve a company name with gse_search_company first. Every result " +
        "carries a `meta.origin` field; when it is `stale-cache` or `static-seed`, tell the " +
        "user the data may be behind.",
    },
  );

  const cache = createCache(env.GSE_CACHE);

  server.registerTool(
    "ping",
    {
      title: "Health check",
      description: "Returns ok plus the server version. Useful for confirming connectivity.",
      inputSchema: {},
      outputSchema: { ok: z.boolean(), server: z.string(), version: z.string() },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async () => {
      const payload = { ok: true, server: SERVER_NAME, version: SERVER_VERSION };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(payload) }],
        structuredContent: payload,
      };
    },
  );

  registerGseTools(server, {
    client: new GseClient({ timeoutMs: 15_000, retries: 2 }),
    cache,
  });

  return server;
}
