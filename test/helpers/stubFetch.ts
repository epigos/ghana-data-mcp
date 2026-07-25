/**
 * A recording `fetch` stub. Routes are matched by substring against the URL in
 * the order they were declared, so a test can queue several responses for the
 * same route to exercise retries.
 */

export interface RecordedCall {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

export interface StubRoute {
  /** Substring the request URL must contain. */
  match: string;
  /** Consumed in order; the last entry is reused once the queue is drained. */
  responses: Array<() => Response>;
}

export interface StubFetch {
  fetch: typeof fetch;
  calls: RecordedCall[];
}

export function stubFetch(routes: StubRoute[]): StubFetch {
  const calls: RecordedCall[] = [];
  const queues = new Map<string, Array<() => Response>>(
    routes.map((route) => [route.match, [...route.responses]]),
  );

  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof init?.body === "string" ? init.body : undefined,
    });

    const route = routes.find((candidate) => url.includes(candidate.match));
    if (!route) throw new Error(`stubFetch: no route matches ${url}`);

    const queue = queues.get(route.match) as Array<() => Response>;
    const next = queue.length > 1 ? (queue.shift() as () => Response) : (queue[0] as () => Response);
    return next();
  }) as typeof fetch;

  return { fetch: impl, calls };
}

export function htmlResponse(body: string, cookies: string[] = ["__cf_bm=stub; Path=/"]): Response {
  const headers = new Headers({ "content-type": "text/html" });
  for (const cookie of cookies) headers.append("set-cookie", cookie);
  return new Response(body, { status: 200, headers });
}

export function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function errorResponse(status: number): Response {
  return new Response(`error ${status}`, { status });
}

/** Parses a recorded urlencoded body into a plain object for assertions. */
export function formOf(call: RecordedCall): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(call.body ?? ""));
}
