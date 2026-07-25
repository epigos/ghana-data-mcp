import type { Env } from "../env.js";

/**
 * Inbound per-IP limiting (plan §8.1).
 *
 * Backed by Cloudflare's rate-limiting binding rather than a Durable Object:
 * same token-bucket semantics, no DO class to deploy or bill, and it is
 * configured declaratively in wrangler.toml. When the binding is absent — local
 * `wrangler dev` without it, or unit tests — this degrades to "allow", because
 * a missing safety net should not stop the server from serving.
 */

export interface RateLimitDecision {
  allowed: boolean;
  /** Identifier the limiter keyed on, for logging. */
  key: string;
  /** True when no limiter was available and the request was allowed by default. */
  bypassed: boolean;
}

export async function checkRateLimit(
  request: Request,
  env: Pick<Env, "RATE_LIMITER">,
): Promise<RateLimitDecision> {
  const key = clientKey(request);
  const limiter = env.RATE_LIMITER;
  if (!limiter) return { allowed: true, key, bypassed: true };

  try {
    const { success } = await limiter.limit({ key });
    return { allowed: success, key, bypassed: false };
  } catch (error) {
    // Fail open: the limiter protects against runaway clients, it is not an
    // authorization control, so an outage in it must not deny real traffic.
    console.warn("rateLimit: limiter unavailable, allowing request", error);
    return { allowed: true, key, bypassed: true };
  }
}

/**
 * `CF-Connecting-IP` is set by Cloudflare's edge and cannot be spoofed by the
 * client; `X-Forwarded-For` is only consulted for local dev, where there is no
 * edge to set the former.
 */
function clientKey(request: Request): string {
  return (
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    "unknown"
  );
}

export function rateLimitedResponse(retryAfterSeconds = 60): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: {
        code: -32_029,
        message: `Rate limit exceeded. Retry after ${retryAfterSeconds}s.`,
      },
      id: null,
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "retry-after": String(retryAfterSeconds),
      },
    },
  );
}
