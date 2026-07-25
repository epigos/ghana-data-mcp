import { REPO_URL, SERVER_NAME, SERVER_VERSION } from "../meta.js";
import { UpstreamError } from "./errors.js";
import { silentLogger, type Logger } from "./log.js";

/**
 * Identifies the project to the sites we scrape, with a link a webmaster can
 * follow to find out what we are and how to reach us (plan §8, outbound
 * politeness). Verified against gse.com.gh — it is served happily, so there is
 * no reason to pretend to be a browser.
 */
export const USER_AGENT = `${SERVER_NAME}/${SERVER_VERSION} (+${REPO_URL})`;

export interface RequestOptions {
  /** Per-attempt timeout. */
  timeoutMs?: number;
  /** Additional attempts after the first. */
  retries?: number;
  /** Base for exponential backoff; set to 0 in tests. */
  baseDelayMs?: number;
  /** Shown in error messages so a failure names the call that produced it. */
  label?: string;
  /** Where request/response lines go. Defaults to discarding them. */
  logger?: Logger;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
}

const RETRYABLE_STATUSES = new Set([403, 408, 425, 429, 500, 502, 503, 504, 521, 522, 524]);

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Full jitter: pick uniformly from [0, base * 2^attempt], capped. */
function backoffDelay(attempt: number, baseDelayMs: number): number {
  if (baseDelayMs <= 0) return 0;
  const ceiling = Math.min(baseDelayMs * 2 ** attempt, 10_000);
  return Math.random() * ceiling;
}

/**
 * `fetch` with a timeout, a descriptive User-Agent, and jittered retry on the
 * statuses that mean "come back later". Non-retryable statuses (404, 400, …)
 * fail immediately rather than burning attempts on a request that cannot work.
 *
 * A retried response has its body cancelled so the connection is not leaked.
 *
 * Every attempt is logged. This is the one choke point for outbound traffic, so
 * logging here means no source can reach the network unobserved — and the
 * `attempt`/`ms`/`status` fields are usually enough to tell a slow site from a
 * failing one without reaching for a debugger.
 */
export async function request(
  url: string,
  init: RequestInit = {},
  options: RequestOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 15_000,
    retries = 2,
    baseDelayMs = 300,
    label = url,
    logger = silentLogger,
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
  } = options;

  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);

  const method = init.method ?? "GET";
  const bodyBytes = typeof init.body === "string" ? init.body.length : undefined;

  let lastError: UpstreamError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const delay = backoffDelay(attempt - 1, baseDelayMs);
      logger.debug("http: retrying", { label, attempt: attempt + 1, delayMs: Math.round(delay) });
      await sleepImpl(delay);
    }

    logger.debug("http: request", {
      method,
      url,
      attempt: attempt + 1,
      of: retries + 1,
      bodyBytes,
      cookies: headers.has("cookie") ? "yes" : "no",
    });

    const startedAt = Date.now();
    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "TimeoutError";
      logger.warn("http: no response", {
        label,
        attempt: attempt + 1,
        ms: Date.now() - startedAt,
        reason: aborted ? "timeout" : "network",
      });
      lastError = new UpstreamError(
        aborted ? `${label} timed out after ${timeoutMs}ms` : `${label} could not be reached`,
        { retryable: true, cause },
      );
      continue;
    }

    const ms = Date.now() - startedAt;

    if (response.ok) {
      logger.info("http: response", {
        method,
        label,
        status: response.status,
        ms,
        attempt: attempt + 1,
        contentType: response.headers.get("content-type") ?? undefined,
        bytes: response.headers.get("content-length") ?? undefined,
      });
      return response;
    }

    const retryable = RETRYABLE_STATUSES.has(response.status);
    logger.warn("http: error response", {
      method,
      label,
      status: response.status,
      ms,
      attempt: attempt + 1,
      retryable,
    });

    lastError = new UpstreamError(`${label} returned ${response.status}`, {
      status: response.status,
      retryable,
    });

    // Nothing reads the body of a failed attempt; release it explicitly.
    await response.body?.cancel().catch(() => {});
    if (!retryable) throw lastError;
  }

  logger.error("http: giving up", { label, attempts: retries + 1 });
  throw lastError ?? new UpstreamError(`${label} failed`, { retryable: true });
}

/**
 * Collects `Set-Cookie` values into a single `Cookie` request header, dropping
 * the attributes (Path, HttpOnly, …) that only belong on the response side.
 *
 * Runtimes disagree on how to read repeated Set-Cookie headers: workerd and
 * undici expose `getSetCookie()`, some older runtimes only `getAll()`, and the
 * spec-minimal fallback folds them into one comma-joined `get()` value.
 */
export function cookieHeaderFrom(headers: Headers): string {
  const raw = readSetCookies(headers);
  const pairs = new Map<string, string>();

  for (const entry of raw) {
    // A folded header may contain several cookies; only split on the commas
    // that separate them, not the ones inside `Expires=Sat, 25 Jul ...`.
    for (const chunk of splitFoldedCookies(entry)) {
      const [pair] = chunk.split(";");
      const eq = pair?.indexOf("=") ?? -1;
      if (!pair || eq <= 0) continue;
      pairs.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  }

  return [...pairs].map(([name, value]) => `${name}=${value}`).join("; ");
}

function readSetCookies(headers: Headers): string[] {
  const withGetSetCookie = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof withGetSetCookie.getSetCookie === "function") {
    return withGetSetCookie.getSetCookie();
  }
  const withGetAll = headers as Headers & { getAll?: (name: string) => string[] };
  if (typeof withGetAll.getAll === "function") {
    return withGetAll.getAll("set-cookie");
  }
  const single = headers.get("set-cookie");
  return single ? [single] : [];
}

function splitFoldedCookies(value: string): string[] {
  // Split on a comma that is followed by `token=`, which can only be the start
  // of the next cookie — date attributes never have `=` after their comma.
  return value.split(/,\s*(?=[^\s=;,]+=)/);
}
