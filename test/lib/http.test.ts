import { describe, expect, it, vi } from "vitest";

import { UpstreamError } from "../../src/lib/errors.js";
import { cookieHeaderFrom, request, USER_AGENT } from "../../src/lib/http.js";
import { createLogger } from "../../src/lib/log.js";
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

describe("request logging", () => {
  function recorder() {
    const lines: string[] = [];
    return { lines, logger: createLogger({ debug: true, sink: (_, line) => lines.push(line) }) };
  }

  it("logs one response line per successful request", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => jsonResponse({ ok: true })] },
    ]);

    await request("https://example.com/x", {}, { fetchImpl, ...fast, logger: log.logger, label: "GET /x" });

    const responseLines = log.lines.filter((line) => line.includes("http: response"));
    expect(responseLines).toHaveLength(1);
    expect(responseLines[0]).toContain("status=200");
    expect(responseLines[0]).toContain("label=\"GET /x\"");
    expect(responseLines[0]).toMatch(/ms=\d+/);
  });

  it("logs the request before it goes out, with the attempt number", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => jsonResponse({})] },
    ]);

    await request("https://example.com/x", { method: "POST", body: "a=1" }, { fetchImpl, ...fast, logger: log.logger });

    const line = log.lines.find((entry) => entry.includes("http: request"));
    expect(line).toContain("method=POST");
    expect(line).toContain("url=https://example.com/x");
    expect(line).toContain("attempt=1");
    expect(line).toContain("bodyBytes=3");
  });

  it("records each retry and the eventual give-up", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => errorResponse(503)] },
    ]);

    await expect(
      request("https://example.com/x", {}, { fetchImpl, ...fast, retries: 2, logger: log.logger }),
    ).rejects.toThrow(UpstreamError);

    expect(log.lines.filter((line) => line.includes("http: error response"))).toHaveLength(3);
    expect(log.lines.filter((line) => line.includes("http: retrying"))).toHaveLength(2);
    expect(log.lines.some((line) => line.includes("http: giving up"))).toBe(true);
  });

  it("marks whether a status was treated as retryable", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => errorResponse(404)] },
    ]);

    await expect(
      request("https://example.com/x", {}, { fetchImpl, ...fast, logger: log.logger }),
    ).rejects.toThrow(UpstreamError);

    expect(log.lines.find((line) => line.includes("http: error response"))).toContain(
      "retryable=false",
    );
  });

  it("logs a network failure as no response", async () => {
    const log = recorder();
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;

    await expect(
      request("https://example.com/x", {}, { fetchImpl, ...fast, retries: 0, logger: log.logger }),
    ).rejects.toThrow(UpstreamError);

    expect(log.lines.find((line) => line.includes("http: no response"))).toContain("reason=network");
  });

  // Cookies are session tokens. Logging that one was attached is useful; logging
  // its value would put __cf_bm in Workers Logs.
  it("reports that a cookie was sent without logging its value", async () => {
    const log = recorder();
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => jsonResponse({})] },
    ]);

    await request(
      "https://example.com/x",
      { headers: { cookie: "__cf_bm=super-secret-value" } },
      { fetchImpl, ...fast, logger: log.logger },
    );

    expect(log.lines.find((line) => line.includes("http: request"))).toContain("cookies=yes");
    expect(log.lines.join("\n")).not.toContain("super-secret-value");
  });

  it("stays silent when no logger is supplied", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { fetch: fetchImpl } = stubFetch([
      { match: "example.com", responses: [() => jsonResponse({})] },
    ]);

    await request("https://example.com/x", {}, { fetchImpl, ...fast });

    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
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
