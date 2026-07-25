import { describe, expect, it, vi } from "vitest";

import { createCache, createMemoryKV, readThrough, type KVLike } from "../../src/lib/cache.js";

/** Cache with a clock the test drives, so TTL behaviour needs no waiting. */
function cacheAt(start: number) {
  let now = start;
  return {
    cache: createCache(createMemoryKV(), { now: () => now }),
    advanceSeconds(seconds: number) {
      now += seconds * 1000;
    },
  };
}

describe("createCache", () => {
  it("round-trips a value with its age and stored-at time", async () => {
    const { cache } = cacheAt(Date.parse("2026-07-25T10:00:00Z"));
    await cache.put("k", { a: 1 }, 60);

    const hit = await cache.get<{ a: number }>("k");
    expect(hit).toMatchObject({ value: { a: 1 }, fresh: true, ageSeconds: 0 });
    expect(hit?.storedAt).toBe("2026-07-25T10:00:00.000Z");
  });

  it("returns null for a key that was never written", async () => {
    const { cache } = cacheAt(0);
    expect(await cache.get("missing")).toBeNull();
  });

  // The point of the two-level lifetime: past the logical TTL the entry is not
  // fresh, but it is still *there* to back a stale-fallback read.
  it("marks an entry stale past its freshness window but keeps it readable", async () => {
    const { cache, advanceSeconds } = cacheAt(0);
    await cache.put("k", "v", 60);

    advanceSeconds(59);
    expect(await cache.get("k")).toMatchObject({ fresh: true });

    advanceSeconds(2);
    expect(await cache.get<string>("k")).toMatchObject({
      value: "v",
      fresh: false,
      ageSeconds: 61,
    });
  });

  it("honours the retain window when dropping an entry entirely", async () => {
    const kv = createMemoryKV();
    const cache = createCache(kv);
    await cache.put("k", "v", 1, 60);

    expect(await kv.get("k", "text")).not.toBeNull();
  });

  it("raises the KV floor of 60s rather than sending a rejected TTL", async () => {
    const put = vi.fn(async () => {});
    const kv = { get: async () => null, put, delete: async () => {} } as unknown as KVLike;

    await createCache(kv).put("k", "v", 5, 5);
    expect(put).toHaveBeenCalledWith("k", expect.any(String), { expirationTtl: 60 });
  });

  it("deletes", async () => {
    const { cache } = cacheAt(0);
    await cache.put("k", "v", 60);
    await cache.delete("k");
    expect(await cache.get("k")).toBeNull();
  });

  it("treats an unreadable entry as a miss instead of throwing", async () => {
    const kv = createMemoryKV();
    await kv.put("k", "not json");
    expect(await createCache(kv).get("k")).toBeNull();
  });

  it("treats an entry written by an older envelope format as a miss", async () => {
    const kv = createMemoryKV();
    await kv.put("k", JSON.stringify({ v: "legacy" }));
    expect(await createCache(kv).get("k")).toBeNull();
  });

  // A KV outage must degrade to "no cache", never to a failed tool call.
  it("survives a KV that throws on read and on write", async () => {
    const kv = {
      get: async () => {
        throw new Error("KV down");
      },
      put: async () => {
        throw new Error("KV down");
      },
      delete: async () => {
        throw new Error("KV down");
      },
    } as unknown as KVLike;
    const cache = createCache(kv);

    expect(await cache.get("k")).toBeNull();
    await expect(cache.put("k", "v", 60)).resolves.toBeUndefined();
    await expect(cache.delete("k")).resolves.toBeUndefined();
  });
});

describe("readThrough", () => {
  it("loads and caches on a miss", async () => {
    const { cache } = cacheAt(0);
    const load = vi.fn(async () => "fresh");

    expect(await readThrough(cache, "k", 60, load)).toMatchObject({ value: "fresh", origin: "live" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("serves a fresh cache hit without calling upstream", async () => {
    const { cache } = cacheAt(0);
    const load = vi.fn(async () => "fresh");

    await readThrough(cache, "k", 60, load);
    const second = await readThrough(cache, "k", 60, load);

    expect(second).toMatchObject({ value: "fresh", origin: "cache" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("re-loads once the entry stops being fresh", async () => {
    const { cache, advanceSeconds } = cacheAt(0);
    let value = "first";
    const load = vi.fn(async () => value);

    await readThrough(cache, "k", 60, load);
    advanceSeconds(61);
    value = "second";

    expect(await readThrough(cache, "k", 60, load)).toMatchObject({ value: "second", origin: "live" });
  });

  it("bypasses a fresh entry when refresh is set", async () => {
    const { cache } = cacheAt(0);
    const load = vi.fn(async () => "v");

    await readThrough(cache, "k", 60, load);
    await readThrough(cache, "k", 60, load, { refresh: true });

    expect(load).toHaveBeenCalledTimes(2);
  });

  // Plan §7: a failed scrape with a stale copy on hand returns the copy.
  it("falls back to a stale entry when the loader throws, and says why", async () => {
    const { cache, advanceSeconds } = cacheAt(0);
    await readThrough(cache, "k", 60, async () => "cached");
    advanceSeconds(120);

    const result = await readThrough(cache, "k", 60, async () => {
      throw new Error("gse.com.gh returned 503");
    });

    expect(result).toMatchObject({ value: "cached", origin: "stale-cache", ageSeconds: 120 });
    expect(result.staleReason).toBe("gse.com.gh returned 503");
  });

  it("still falls back when refresh skipped the initial cache read", async () => {
    const { cache } = cacheAt(0);
    await readThrough(cache, "k", 60, async () => "cached");

    const result = await readThrough(
      cache,
      "k",
      60,
      async () => {
        throw new Error("down");
      },
      { refresh: true },
    );

    expect(result).toMatchObject({ value: "cached", origin: "stale-cache" });
  });

  it("propagates the error when there is nothing cached to fall back to", async () => {
    const { cache } = cacheAt(0);
    await expect(
      readThrough(cache, "k", 60, async () => {
        throw new Error("down");
      }),
    ).rejects.toThrow("down");
  });
});
