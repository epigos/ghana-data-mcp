import { ParseError, UpstreamError } from "../../lib/errors.js";
import { request, type RequestOptions } from "../../lib/http.js";
import { silentLogger, type Logger } from "../../lib/log.js";

/**
 * StatsBank (Ghana Statistical Service) access.
 *
 * StatsBank runs PxWeb, which is a two-step API by design:
 *
 *   GET  /api/v1/en/<path>/<table>.px    -> the table's variables and legal values
 *   POST /api/v1/en/<path>/<table>.px    -> the data, for a query built from those
 *
 * Two things about it shape this client.
 *
 * **Invalid queries 404 with an HTML body.** Not a JSON error, not a 400 — a
 * naming a variable that does not exist, or a legal variable with an illegal value,
 * both return `404` and an IIS "File or directory not found" page. Verified live:
 * `{"code":"Nope",...}` and `{"code":"Month","values":["1899M01"]}` both 404 on
 * `fuel.px`. Two consequences: `tools.ts` validates every code and value against the
 * cached schema *before* posting, and `postJson` below treats a non-JSON body as a
 * `ParseError` rather than letting `response.json()` throw something opaque. A 404
 * is also not in `lib/http.ts`'s retryable set, so a bad query fails on the first
 * attempt instead of burning three.
 *
 * **No Content-Type is needed or wanted.** The Postman collection this was built
 * from sends none, and the API accepts the raw body as-is. Sending
 * `application/json` is harmless but unnecessary; sending `text/plain` would be a
 * lie. This client sends the body with no Content-Type, exactly as verified.
 *
 * Path segments are encoded per-segment: table paths contain spaces, parentheses
 * and an ampersand-free but bracket-bearing folder name
 * ("Monthly Indicator of Economic Growth(MIEG)"), and `encodeURIComponent` on the
 * whole path would eat the slashes.
 */

export const STATSBANK_BASE_URL = "https://statsbank.statsghana.gov.gh";
const API_PATH = "/api/v1/en";

/**
 * Replaces the generic "could not be reached, retrying often works" message with the
 * cause that actually explains it here.
 *
 * StatsBank serves TLS 1.2 with CBC-only cipher suites (`ECDHE-RSA-AES256-SHA384`,
 * `ECDHE-RSA-AES128-SHA`) and offers no AEAD suite and no TLS 1.3. Cloudflare's
 * production runtime and Node both negotiate that fine; local `wrangler dev` has no
 * cipher in common with it and every connection dies at the handshake in ~500ms.
 *
 * `lib/http.ts` correctly classifies a handshake failure as a transient network fault,
 * because for every other source that is what it is. Under local dev against this host
 * it is permanent, and telling someone to retry sends them in a loop — which is exactly
 * what happened the first time this was tested. So a connection-level failure (an
 * `UpstreamError` carrying no HTTP status, meaning no response ever arrived) is
 * re-thrown here as non-retryable with the workaround attached.
 *
 * A failure that *did* get an HTTP response is passed through untouched: a 404 or a 503
 * from StatsBank means something else entirely and `lib/http.ts` already describes it
 * correctly.
 */
function explainConnectionFailure(error: unknown, label: string): unknown {
  const noResponseArrived = error instanceof UpstreamError && error.status === undefined;
  if (!noResponseArrived) return error;

  return new UpstreamError(
    `${label} could not connect to StatsBank. StatsBank only offers TLS 1.2 with CBC ` +
      "ciphers, which the local `wrangler dev` runtime cannot negotiate — if you are " +
      "running locally, use `npx wrangler dev --remote` (runs on Cloudflare's edge, which " +
      "can reach it), the deployed Worker, or `npm run test:live`. If this is the deployed " +
      "Worker, StatsBank itself is unreachable and the outage is upstream",
    { retryable: false, cause: error },
  );
}

export interface GssClientOptions extends RequestOptions {
  baseUrl?: string;
  logger?: Logger;
}

/** A PxWeb query: one selection per variable being narrowed. */
export interface PxQuerySelection {
  code: string;
  selection: { filter: "item"; values: string[] };
}

export class GssClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly requestOptions: RequestOptions;
  /** Pinned path -> the filename it actually lives at now. See withPathRecovery. */
  private readonly resolvedPaths = new Map<string, string>();

  constructor(options: GssClientOptions = {}) {
    const { baseUrl = STATSBANK_BASE_URL, logger = silentLogger, ...requestOptions } = options;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.logger = logger.child({ source: "gss" });
    this.requestOptions = { ...requestOptions, logger: this.logger };
  }

  /** A table's variables and their legal values. */
  async fetchTableSchema(tablePath: string): Promise<unknown> {
    this.logger.info("gss: fetching table schema", { table: tablePath });
    return this.withPathRecovery(tablePath, (path) =>
      this.getJson(this.urlFor(path), `GET ${path}`),
    );
  }

  /**
   * Data for a query.
   *
   * An empty `query` is legal upstream and returns the whole table, but callers
   * should not rely on that: `fuel.px` alone is 3,366 rows and 233 KB. `tools.ts`
   * always narrows the time axis before calling this.
   */
  async fetchTableData(tablePath: string, query: readonly PxQuerySelection[]): Promise<unknown> {
    const body = JSON.stringify({ query, response: { format: "json" } });
    this.logger.info("gss: fetching table data", {
      table: tablePath,
      variables: query.map((q) => q.code).join(","),
      bodyBytes: body.length,
    });
    return this.withPathRecovery(tablePath, (path) =>
      this.postJson(this.urlFor(path), body, `POST ${path}`),
    );
  }

  /**
   * A folder listing: `{ id, type, text }` entries where `type` is "l" for a
   * subfolder and "t" for a table. Not used by the tools — the registry in
   * tables.ts is static — but it is how you rediscover a table whose upstream
   * filename has changed, which the MIEG table's vintage-stamped name makes a real
   * possibility. The live canary uses it for exactly that.
   */
  async fetchFolder(folderPath: string): Promise<unknown> {
    this.logger.info("gss: fetching folder listing", { folder: folderPath });
    return this.getJson(`${this.urlFor(folderPath)}/`, `GET ${folderPath}/`);
  }

  /**
   * Runs an operation against `tablePath`, and if the path 404s, re-reads its
   * folder listing to find the filename it moved to and runs the operation again.
   *
   * This exists because MIEG's filename carries a publication vintage. It has
   * already moved once — `April_26_MIEG_Px.px` to `mieg_px_May26.px` — which 404ed
   * the pinned path and took four canary tests with it. Without recovery, every
   * new vintage takes the table offline until a human edits tables.ts.
   *
   * **A 404 here is ambiguous** and that shapes the design. For a GET it can only
   * mean the path is wrong, but for a POST it can also mean an invalid query —
   * StatsBank answers a bad variable or value with 404 and an HTML body (see the
   * module comment). `tools.ts` validates against the cached schema before
   * posting, so the moved-file case is the likely one, and when discovery finds
   * nothing new the original error is rethrown untouched. The cost of guessing
   * wrong is therefore one folder listing on a request that was already failing.
   *
   * The memo is per-instance, so a Worker handling one request pays at most one
   * discovery for a moved table and reuses it for the POST that follows. It is
   * deliberately not cached in KV: a stale *resolved* path would be far harder to
   * reason about than a stale pinned one, and the canary prompts a tables.ts
   * update anyway, which ends the extra request entirely.
   */
  private async withPathRecovery<T>(
    tablePath: string,
    operation: (path: string) => Promise<T>,
  ): Promise<T> {
    const pinned = this.resolvedPaths.get(tablePath) ?? tablePath;
    try {
      return await operation(pinned);
    } catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 404) throw error;

      const discovered = await this.discoverTablePath(pinned);
      if (!discovered || discovered === pinned) throw error;

      this.logger.warn("gss: table filename moved; recovered from folder listing", {
        pinned,
        discovered,
      });
      this.resolvedPaths.set(tablePath, discovered);
      return operation(discovered);
    }
  }

  /**
   * The current filename for a table whose pinned path 404ed, from its folder
   * listing. Returns undefined when the folder holds no tables or more than one —
   * with several candidates there is no basis for picking, and quietly reading the
   * wrong table would be worse than failing.
   */
  private async discoverTablePath(pinnedPath: string): Promise<string | undefined> {
    const lastSlash = pinnedPath.lastIndexOf("/");
    if (lastSlash <= 0) return undefined;
    const folder = pinnedPath.slice(0, lastSlash);

    let listing: unknown;
    try {
      listing = await this.fetchFolder(folder);
    } catch {
      // Discovery is best-effort; the caller rethrows the original 404.
      return undefined;
    }
    if (!Array.isArray(listing)) return undefined;

    const tables = listing.filter(
      (entry): entry is { id: string; type: string } =>
        typeof entry === "object" &&
        entry !== null &&
        (entry as { type?: unknown }).type === "t" &&
        typeof (entry as { id?: unknown }).id === "string",
    );
    if (tables.length !== 1) return undefined;
    return `${folder}/${tables[0]!.id}`;
  }

  private urlFor(path: string): string {
    const encoded = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(encodeURIComponent)
      .join("/");
    return `${this.baseUrl}${API_PATH}/${encoded}`;
  }

  private async getJson(url: string, label: string): Promise<unknown> {
    const response = await this.send(url, { headers: { accept: "application/json" } }, label);
    return this.readJson(response, label);
  }

  private async postJson(url: string, body: string, label: string): Promise<unknown> {
    const response = await this.send(
      url,
      { method: "POST", body, headers: { accept: "application/json" } },
      label,
    );
    return this.readJson(response, label);
  }

  private async send(url: string, init: RequestInit, label: string): Promise<Response> {
    try {
      return await request(url, init, { ...this.requestOptions, label });
    } catch (error) {
      throw explainConnectionFailure(error, label);
    }
  }

  private async readJson(response: Response, label: string): Promise<unknown> {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      this.logger.error("gss: response was not JSON", { label });
      throw new ParseError(
        `${label} did not return JSON — StatsBank answers an invalid query with an HTML error page`,
        { cause },
      );
    }
    this.logger.info("gss: response parsed", { label });
    return payload;
  }
}
