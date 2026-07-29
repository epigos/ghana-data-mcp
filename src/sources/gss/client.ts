import { ParseError } from "../../lib/errors.js";
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

  constructor(options: GssClientOptions = {}) {
    const { baseUrl = STATSBANK_BASE_URL, logger = silentLogger, ...requestOptions } = options;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.logger = logger.child({ source: "gss" });
    this.requestOptions = { ...requestOptions, logger: this.logger };
  }

  /** A table's variables and their legal values. */
  async fetchTableSchema(tablePath: string): Promise<unknown> {
    this.logger.info("gss: fetching table schema", { table: tablePath });
    return this.getJson(this.urlFor(tablePath), `GET ${tablePath}`);
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
    return this.postJson(this.urlFor(tablePath), body, `POST ${tablePath}`);
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

  private urlFor(path: string): string {
    const encoded = path
      .split("/")
      .filter((segment) => segment.length > 0)
      .map(encodeURIComponent)
      .join("/");
    return `${this.baseUrl}${API_PATH}/${encoded}`;
  }

  private async getJson(url: string, label: string): Promise<unknown> {
    const response = await request(url, { headers: { accept: "application/json" } }, {
      ...this.requestOptions,
      label,
    });
    return this.readJson(response, label);
  }

  private async postJson(url: string, body: string, label: string): Promise<unknown> {
    const response = await request(
      url,
      { method: "POST", body, headers: { accept: "application/json" } },
      { ...this.requestOptions, label },
    );
    return this.readJson(response, label);
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
