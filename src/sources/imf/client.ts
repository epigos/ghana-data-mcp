import { ParseError } from "../../lib/errors.js";
import { request, type RequestOptions } from "../../lib/http.js";
import { silentLogger, type Logger } from "../../lib/log.js";

/**
 * IMF DataMapper access.
 *
 * A plain JSON REST API — no nonce, no cookie, none of GSE's or BoG's wpDataTables
 * handshake. The one thing that makes it awkward is that its documented filtering
 * does not work:
 *
 *  - Path segments for country/region/group (`/{indicator}/GHA`) are silently
 *    ignored. Every request returns every one of the ~229 countries, regions and
 *    analytical groups DataMapper tracks, for every year the indicator has.
 *  - The documented `?periods=2019,2020` querystring is likewise ignored — the
 *    full year range comes back regardless.
 *  - An **unsupported** querystring parameter (e.g. `?countries=GHA`, which is not
 *    documented but a plausible guess) does not 404 or ignore — it trips the site's
 *    WAF, which serves a 200 with an HTML "Request Rejected" body instead of JSON.
 *
 * So this client sends indicator ids only, never a country/region/group segment and
 * never any querystring, and leaves both the country slice and the year window to
 * `parser.ts` to apply after the fact. See docs/IMF.md for how each of these was
 * verified against the live API.
 *
 * Multiple indicator ids in one path *does* work — `/NGDP_RPCH/PCPIPCH` returns
 * both under their own keys — which is what lets one call fetch several indicators
 * in a single request instead of one round trip each.
 */

export const IMF_BASE_URL = "https://www.imf.org";
const API_PATH = "/external/datamapper/api/v2";

export interface ImfClientOptions extends RequestOptions {
  baseUrl?: string;
  logger?: Logger;
}

export class ImfClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly requestOptions: RequestOptions;

  constructor(options: ImfClientOptions = {}) {
    const { baseUrl = IMF_BASE_URL, logger = silentLogger, ...requestOptions } = options;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.logger = logger.child({ source: "imf" });
    this.requestOptions = { ...requestOptions, logger: this.logger };
  }

  /** The full indicator catalog: id, label, description, unit, source, dataset. */
  async fetchIndicators(): Promise<unknown> {
    this.logger.info("imf: fetching indicator catalog");
    return this.getJson(`${API_PATH}/indicators`, "GET /indicators");
  }

  /**
   * One or more indicators' full time series, every country, every year. The
   * caller narrows to Ghana and to a year window after the fact — see the class
   * doc for why that cannot be pushed upstream.
   */
  async fetchSeries(indicatorIds: readonly string[]): Promise<unknown> {
    if (indicatorIds.length === 0) {
      throw new Error("fetchSeries requires at least one indicator id");
    }

    this.logger.info("imf: fetching indicator series", {
      indicators: indicatorIds.join(","),
      count: indicatorIds.length,
    });
    const path = `${API_PATH}/${indicatorIds.map(encodeURIComponent).join("/")}`;
    return this.getJson(path, `GET /${indicatorIds.join("/")}`);
  }

  private async getJson(path: string, label: string): Promise<unknown> {
    const response = await request(
      `${this.baseUrl}${path}`,
      { headers: { accept: "application/json" } },
      { ...this.requestOptions, label },
    );

    // The WAF's "Request Rejected" page comes back as HTTP 200 with an HTML body,
    // so a non-2xx check alone would miss it — only a JSON-parse attempt catches it.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      this.logger.error("imf: response was not JSON", { label });
      throw new ParseError(
        `${label} did not return JSON — the DataMapper API may have rejected the request`,
        { cause },
      );
    }

    this.logger.info("imf: response parsed", { label });
    return payload;
  }
}
