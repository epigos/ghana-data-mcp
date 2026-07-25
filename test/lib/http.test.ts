import { describe, expect, it, vi } from "vitest";

import { UpstreamError } from "../../src/lib/errors.js";
import { cookieHeaderFrom, request, USER_AGENT } from "../../src/lib/http.js";
import { errorResponse, jsonResponse, stubFetch } from "../helpers/stubFetch.js";

const fast = { baseDelayMs: 0 };

describe("request", () => {
  it("sends the project User-Agent", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "example.com", responses: [() => jsonResponse({ ok: true })] },
    ]);

    await request("https://example.com/x", {}, { fetchImpl, ...fast });
    expect(calls[0]?.headers.get("user-agent")).toBe(USER_AGENT);
    // Identifies the project and where to complain (plan §8, outbound politeness).
    expect(USER_AGENT).toMatch(/^ghana-data-mcp\/\d+\.\d+\.\d+ \(\+https:\/\//);
  });

  it("does not overwrite an explicit User-Agent", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "example.com", responses: [() => jsonResponse({})] },
    ]);

    await request("https://example.com/x", { headers: { "user-agent": "custom/1" } }, { fetchImpl, ...fast });
    expect(calls[0]?.headers.get("user-agent")).toBe("custom/1");
  });

  it("retries retryable statuses and returns the eventual success", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      {
        match: "example.com",
        responses: [() => errorResponse(429), () => errorResponse(503), () => jsonResponse({ ok: true })],
      },
    ]);

    const response = await request("https://example.com/x", {}, { fetchImpl, ...fast, retries: 2 });
    expect(response.status).toBe(200);
    expect(calls).toHaveLength(3);
  });

  // gse.com.gh sits behind Cloudflare, which answers a challenged request with
  // 403 — worth one more try rather than surfacing as a hard failure.
  it("treats 403 as retryable", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "example.com", responses: [() => errorResponse(403), () => jsonResponse({})] },
    ]);

    await expect(request("https://example.com/x", {}, { fetchImpl, ...fast })).resolves.toMatchObject({
      status: 200,
    });
    expect(calls).toHaveLength(2);
  });

  it("fails fast on a status a retry cannot fix", async () => {
    const { fetch: fetchImpl, calls } = stubFetch([
      { match: "example.com", responses: [() => errorResponse(400)] },
    ]);

    await expect(request("https://example.com/x", {}, { fetchImpl, ...fast })).rejects.toThrow(
      UpstreamError,
    );
    expect(calls).toHaveLength(1);
  });

  it("retries a network error", async () => {
    let attempts = 0;
    const fetchImpl = (async () => {
      attempts++;
      if (attempts < 2) throw new TypeError("fetch failed");
      return jsonResponse({ ok: true });
    }) as unknown as typeof fetch;

    await expect(request("https://example.com/x", {}, { fetchImpl, ...fast })).resolves.toMatchObject({
      status: 200,
    });
    expect(attempts).toBe(2);
  });

  it("labels the failure with the call that produced it", async () => {
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => errorResponse(500)] },
    ]);

    await expect(
      request("https://example.com/x", {}, { fetchImpl, ...fast, retries: 0, label: "GET /thing" }),
    ).rejects.toThrow("GET /thing returned 500");
  });

  it("backs off between attempts", async () => {
    const sleepImpl = vi.fn(async (_ms: number) => {});
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => errorResponse(503)] },
    ]);

    await expect(
      request("https://example.com/x", {}, { fetchImpl, sleepImpl, retries: 2, baseDelayMs: 100 }),
    ).rejects.toThrow(UpstreamError);

    expect(sleepImpl).toHaveBeenCalledTimes(2);
    // Jittered, and growing: the ceiling doubles each attempt.
    for (const [delay] of sleepImpl.mock.calls) expect(delay).toBeLessThanOrEqual(400);
  });

  it("surfaces a timeout as a retryable UpstreamError", async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      init?.signal?.throwIfAborted();
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const promise = request("https://example.com/x", {}, { fetchImpl, ...fast, timeoutMs: 5, retries: 0 });
    await expect(promise).rejects.toThrow(UpstreamError);
  });

  it("releases the body of a discarded attempt", async () => {
    const cancel = vi.fn(async () => {});
    const failing = () => {
      const response = errorResponse(503);
      Object.defineProperty(response, "body", { value: { cancel } });
      return response;
    };
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [failing, () => jsonResponse({})] },
    ]);

    await request("https://example.com/x", {}, { fetchImpl, ...fast });
    expect(cancel).toHaveBeenCalled();
  });
});

describe("cookieHeaderFrom", () => {
  function headersWith(...cookies: string[]): Headers {
    const headers = new Headers();
    for (const cookie of cookies) headers.append("set-cookie", cookie);
    return headers;
  }

  it("keeps only the name=value pair", () => {
    const headers = headersWith(
      "__cf_bm=abc.def-123; HttpOnly; SameSite=None; Secure; Path=/; Domain=gse.com.gh",
    );
    expect(cookieHeaderFrom(headers)).toBe("__cf_bm=abc.def-123");
  });

  it("joins several cookies", () => {
    const headers = headersWith("a=1; Path=/", "b=2; Secure");
    expect(cookieHeaderFrom(headers)).toBe("a=1; b=2");
  });

  it("keeps the last value when a cookie repeats", () => {
    expect(cookieHeaderFrom(headersWith("a=1", "a=2"))).toBe("a=2");
  });

  it("returns empty when nothing was set", () => {
    expect(cookieHeaderFrom(new Headers())).toBe("");
  });

  // A runtime without getSetCookie() folds repeated headers into one comma-joined
  // value — and Expires dates contain commas of their own.
  it("splits a folded header without being fooled by a date comma", () => {
    const headers = {
      get: (name: string) =>
        name === "set-cookie"
          ? "__cf_bm=abc; Expires=Sat, 25 Jul 2026 16:45:18 GMT; Path=/, other=xyz; Path=/"
          : null,
    } as unknown as Headers;

    expect(cookieHeaderFrom(headers)).toBe("__cf_bm=abc; other=xyz");
  });

  it("ignores a malformed entry with no equals sign", () => {
    expect(cookieHeaderFrom(headersWith("novalue", "a=1"))).toBe("a=1");
  });
});
