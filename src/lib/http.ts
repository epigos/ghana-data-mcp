import { REPO_URL, SERVER_NAME, SERVER_VERSION } from "../meta.js";
import { UpstreamError } from "./errors.js";

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
    fetchImpl = fetch,
    sleepImpl = defaultSleep,
  } = options;

  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("user-agent", USER_AGENT);

  let lastError: UpstreamError | undefined;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) await sleepImpl(backoffDelay(attempt - 1, baseDelayMs));

    let response: Response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers,
        signal: init.signal ?? AbortSignal.timeout(timeoutMs),
      });
    } catch (cause) {
      const aborted = cause instanceof Error && cause.name === "TimeoutError";
      lastError = new UpstreamError(
        aborted ? `${label} timed out after ${timeoutMs}ms` : `${label} could not be reached`,
        { retryable: true, cause },
      );
      continue;
    }

    if (response.ok) return response;

    const retryable = RETRYABLE_STATUSES.has(response.status);
    lastError = new UpstreamError(`${label} returned ${response.status}`, {
      status: response.status,
      retryable,
    });

    // Nothing reads the body of a failed attempt; release it explicitly.
    await response.body?.cancel().catch(() => {});
    if (!retryable) throw lastError;
  }

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
