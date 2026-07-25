/**
 * KV-backed cache with a two-level lifetime (plan §7).
 *
 * The logical TTL ("is this fresh?") is stored *inside* the value, while the KV
 * entry itself is kept for much longer. That is what makes the stale-fallback
 * possible: if KV expired the entry at the logical TTL there would be nothing
 * left to serve when an upstream scrape fails.
 */

/** Minimum KV `expirationTtl`, imposed by the platform. */
const MIN_KV_TTL_SECONDS = 60;

/** How long an entry survives past its freshness window, to back a stale read. */
export const DEFAULT_RETAIN_SECONDS = 30 * 24 * 60 * 60;

interface Envelope<T> {
  /** Cached payload. */
  v: T;
  /** Epoch millis the entry was written. */
  s: number;
  /** Epoch millis the entry stops being fresh. */
  f: number;
}

export interface CacheHit<T> {
  value: T;
  fresh: boolean;
  ageSeconds: number;
  storedAt: string;
}

export interface Cache {
  get<T>(key: string): Promise<CacheHit<T> | null>;
  put<T>(key: string, value: T, freshSeconds: number, retainSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
}

/** The slice of `KVNamespace` this module needs — keeps tests free of workerd. */
export interface KVLike {
  get(key: string, type: "text"): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface CacheOptions {
  /** Injectable clock, for tests. */
  now?: () => number;
}

export function createCache(kv: KVLike | undefined, options: CacheOptions = {}): Cache {
  const store = kv ?? createMemoryKV();
  const now = options.now ?? (() => Date.now());

  return {
    async get<T>(key: string): Promise<CacheHit<T> | null> {
      let raw: string | null;
      try {
        raw = await store.get(key, "text");
      } catch (error) {
        // A cache outage must never take the tool down with it.
        console.warn(`cache: read failed for ${key}`, error);
        return null;
      }
      if (raw === null) return null;

      let envelope: Envelope<T>;
      try {
        envelope = JSON.parse(raw) as Envelope<T>;
      } catch {
        console.warn(`cache: dropping unreadable entry ${key}`);
        return null;
      }
      if (typeof envelope?.s !== "number" || typeof envelope?.f !== "number") return null;

      const at = now();
      return {
        value: envelope.v,
        fresh: at < envelope.f,
        ageSeconds: Math.max(0, Math.round((at - envelope.s) / 1000)),
        storedAt: new Date(envelope.s).toISOString(),
      };
    },

    async put<T>(
      key: string,
      value: T,
      freshSeconds: number,
      retainSeconds = DEFAULT_RETAIN_SECONDS,
    ): Promise<void> {
      const at = now();
      const envelope: Envelope<T> = { v: value, s: at, f: at + freshSeconds * 1000 };
      const expirationTtl = Math.max(MIN_KV_TTL_SECONDS, Math.round(retainSeconds));
      try {
        await store.put(key, JSON.stringify(envelope), { expirationTtl });
      } catch (error) {
        console.warn(`cache: write failed for ${key}`, error);
      }
    },

    async delete(key: string): Promise<void> {
      try {
        await store.delete(key);
      } catch (error) {
        console.warn(`cache: delete failed for ${key}`, error);
      }
    },
  };
}

/**
 * Per-isolate fallback used when no KV namespace is bound (local dev, tests).
 * It only lives as long as the isolate, which is fine — it is a nicety, not a
 * correctness requirement.
 */
export function createMemoryKV(): KVLike {
  const map = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const entry = map.get(key);
      if (!entry) return null;
      if (entry.expiresAt <= Date.now()) {
        map.delete(key);
        return null;
      }
      return entry.value;
    },
    async put(key, value, options) {
      const ttl = options?.expirationTtl ?? DEFAULT_RETAIN_SECONDS;
      map.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    },
    async delete(key) {
      map.delete(key);
    },
  };
}

/**
 * The read-through pattern every tool uses: fresh cache wins, then a live
 * fetch, and if the fetch throws we fall back to a stale entry rather than
 * failing the call. Callers get told which of the three happened so they can
 * label the response honestly.
 */
export interface ReadThroughResult<T> {
  value: T;
  origin: "cache" | "live" | "stale-cache";
  ageSeconds: number;
  /** Present when `origin` is `stale-cache`: why the live fetch was abandoned. */
  staleReason?: string;
}

export async function readThrough<T>(
  cache: Cache,
  key: string,
  freshSeconds: number,
  load: () => Promise<T>,
  options: { refresh?: boolean; retainSeconds?: number } = {},
): Promise<ReadThroughResult<T>> {
  const cached = options.refresh ? null : await cache.get<T>(key);
  if (cached?.fresh) {
    return { value: cached.value, origin: "cache", ageSeconds: cached.ageSeconds };
  }

  try {
    const value = await load();
    await cache.put(key, value, freshSeconds, options.retainSeconds);
    return { value, origin: "live", ageSeconds: 0 };
  } catch (error) {
    const fallback = cached ?? (await cache.get<T>(key));
    if (!fallback) throw error;
    return {
      value: fallback.value,
      origin: "stale-cache",
      ageSeconds: fallback.ageSeconds,
      staleReason: error instanceof Error ? error.message : String(error),
    };
  }
}
