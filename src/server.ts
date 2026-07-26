import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import type { Env } from "./env.js";
import { createCache } from "./lib/cache.js";
import { createLogger, debugEnabled } from "./lib/log.js";
import { SERVER_NAME, SERVER_VERSION } from "./meta.js";
import { BogClient } from "./sources/bog/client.js";
import { registerBogTools } from "./sources/bog/tools.js";
import { GseClient } from "./sources/gse/client.js";
import { registerGseTools } from "./sources/gse/tools.js";
import { ImfClient } from "./sources/imf/client.js";
import { registerImfTools } from "./sources/imf/tools.js";

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
        "Public Ghana data. Tools are namespaced by source. `gse_*` covers the Ghana Stock " +
        "Exchange: company directory, daily share prices, market index and fixed-income " +
        "issuers. Share codes are required for price lookups — resolve a company name with " +
        "gse_search_company first. `bog_*` covers Bank of Ghana treasury data: interbank FX " +
        "rates, Treasury and central-bank bill rates, and interbank money-market rates. " +
        "`imf_*` covers IMF macroeconomic indicators for Ghana — resolve a name to a code with " +
        "imf_list_indicators first, and always flag IMF's own forward projections as such. " +
        "Every result carries a `meta.origin` field; when it is `stale-cache` or " +
        "`static-seed`, tell the user the data may be behind.",
    },
  );

  // `info` and above always emit; set the DEBUG var to "1" for request bodies,
  // nonces, retry delays and cache keys.
  const logger = createLogger({ debug: debugEnabled(env.DEBUG) });
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
    client: new GseClient({ timeoutMs: 15_000, retries: 2, logger }),
    cache,
    logger,
  });

  registerBogTools(server, {
    client: new BogClient({ timeoutMs: 15_000, retries: 2, logger }),
    cache,
    logger,
  });

  registerImfTools(server, {
    client: new ImfClient({ timeoutMs: 15_000, retries: 2, logger }),
    cache,
    logger,
  });

  return server;
}
