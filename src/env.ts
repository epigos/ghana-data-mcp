/** Worker bindings. Mirrors wrangler.toml — keep the two in step. */

import type { KVLike } from "./lib/cache.js";

export interface RateLimiterBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  /** Cache for every source's scrapes. Optional so local dev works unbound. */
  GSE_CACHE?: KVLike;
  /** Cloudflare rate-limiting binding (plan §8.1). Optional; absent = no limit. */
  RATE_LIMITER?: RateLimiterBinding;
  /** Set to "1" to log every upstream request. */
  DEBUG?: string;
}
