import { createMcpHandler } from "agents/mcp";

import type { Env } from "./env.js";
import { checkRateLimit, rateLimitedResponse } from "./lib/rateLimit.js";
import { REPO_URL, SERVER_NAME, SERVER_VERSION } from "./meta.js";
import { createServer } from "./server.js";

/**
 * Worker entrypoint.
 *
 * MCP is served over Streamable HTTP at `/mcp` by `createMcpHandler`, which is
 * stateless — no Durable Object needed. That suits this server: every tool is an
 * independent read-only scrape, so there is no per-session state worth keeping
 * (and no DO class to deploy, migrate, or pay for). If a future tool needs
 * sessions or SSE resumability, `McpAgent` from the same package is the upgrade
 * path, and it is a drop-in swap here.
 */

const MCP_ROUTE = "/mcp";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/health") {
      return Response.json({
        ok: true,
        server: SERVER_NAME,
        version: SERVER_VERSION,
        mcp: { endpoint: MCP_ROUTE, transport: "streamable-http" },
        docs: REPO_URL,
      });
    }

    if (url.pathname === MCP_ROUTE) {
      const decision = await checkRateLimit(request, env);
      if (!decision.allowed) {
        console.warn(`rate limit hit for ${decision.key}`);
        return rateLimitedResponse();
      }

      const handler = createMcpHandler(createServer(env), { route: MCP_ROUTE });
      return handler(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
