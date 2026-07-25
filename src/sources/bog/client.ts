import { NotImplementedError } from "../../lib/errors.js";
import type { RequestOptions } from "../../lib/http.js";
import { silentLogger, type Logger } from "../../lib/log.js";

/**
 * Bank of Ghana upstream access.
 *
 * ## Status: endpoints mapped, fetching not implemented
 *
 * The URLs below are verified — each one was fetched and returns HTTP 200 — but
 * no data is read from them yet. The tools in tools.ts are registered stubs so
 * the contract can be agreed before the parsing work lands.
 *
 * ## What is known about the upstream so far
 *
 * bog.gov.gh is WordPress, like gse.com.gh, but it differs in one important way:
 * it exposes a working REST API at `/wp-json/wp/v2/`, including custom post types
 * that line up with several of these datasets:
 *
 *   gog_auction_results   → weekly GOG T-bill auction results
 *   bog_auction_results   → weekly BOG bill auction results
 *   daily_interest_rate   → interbank interest rates (daily)
 *   avg_interest_rate     → interbank interest rates (averaged)
 *   exchange_rates        → interbank FX rates
 *
 * That is a better index than scraping list pages: it is paginated, ordered by
 * date, and needs no nonce or cookie handshake.
 *
 * The catch, from probing it on 2026-07-25: the figures are not exposed as
 * fields. `acf` comes back empty and the numbers live in `content.rendered` as an
 * HTML table, so a parsing step is still needed — the REST API replaces the
 * *discovery* half of the GSE approach, not the *parsing* half. And
 * `exchange_rates` returned an empty array, so FX may need a different route.
 */

export const BOG_BASE_URL = "https://www.bog.gov.gh";

/** Human-facing pages, one per dataset. Verified 2026-07-25. */
export const BOG_PAGES = {
  treasuryBillRates: "/treasury-and-the-markets/treasury-bill-rates/",
  centralBankBillRates: "/treasury-and-the-markets/bank-of-ghana-bill-rates/",
  interbankFxRates: "/treasury-and-the-markets/daily-interbank-fx-rates/",
  interbankInterestRates: "/treasury-and-the-markets/interbank-interest-rates/",
  treasuryAuctionResults: "/gog_auction_results/",
  centralBankAuctionResults: "/bog_auction_results/",
  externalFacilities: "/treasury-and-the-markets/project-administration-and-external-facilities/",
} as const;

/**
 * WordPress REST collections that look like they back the pages above. Confirmed
 * to exist and return 200; not yet confirmed to be the best route for each
 * dataset.
 */
export const BOG_REST_COLLECTIONS = {
  treasuryAuctionResults: "/wp-json/wp/v2/gog_auction_results",
  centralBankAuctionResults: "/wp-json/wp/v2/bog_auction_results",
  dailyInterestRate: "/wp-json/wp/v2/daily_interest_rate",
  averageInterestRate: "/wp-json/wp/v2/avg_interest_rate",
  exchangeRates: "/wp-json/wp/v2/exchange_rates",
} as const;

export interface BogClientOptions extends RequestOptions {
  baseUrl?: string;
  logger?: Logger;
}

/**
 * Placeholder client. Each method throws until the request shape for its dataset
 * is known; `tools.ts` turns that into a clear MCP error rather than a crash.
 *
 * When implementing one: add the fetch through `request()` from lib/http (never a
 * bare `fetch` — see CONTRIBUTING), a `parse…Payload` function in parser.ts, and
 * swap the stub tool's handler for a cached read. Nothing else needs to change.
 */
export class BogClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly requestOptions: RequestOptions;

  constructor(options: BogClientOptions = {}) {
    const { baseUrl = BOG_BASE_URL, logger = silentLogger, ...requestOptions } = options;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.logger = logger.child({ source: "bog" });
    this.requestOptions = { ...requestOptions, logger: this.logger };
  }

  /** The page a dataset is published on, for error messages and citations. */
  pageUrl(page: keyof typeof BOG_PAGES): string {
    return `${this.baseUrl}${BOG_PAGES[page]}`;
  }

  /** Options the eventual fetches will use. Referenced so the field is not dead. */
  get options(): RequestOptions {
    return this.requestOptions;
  }

  private notImplemented(dataset: string, page: keyof typeof BOG_PAGES): never {
    throw new NotImplementedError(
      `Bank of Ghana ${dataset} is not implemented yet. The data is published at ${this.pageUrl(page)}.`,
    );
  }

  async fetchTreasuryBillRates(): Promise<unknown> {
    this.notImplemented("treasury bill rates", "treasuryBillRates");
  }

  async fetchCentralBankBillRates(): Promise<unknown> {
    this.notImplemented("bill rates", "centralBankBillRates");
  }

  async fetchInterbankFxRates(): Promise<unknown> {
    this.notImplemented("interbank FX rates", "interbankFxRates");
  }

  async fetchInterbankInterestRates(): Promise<unknown> {
    this.notImplemented("interbank interest rates", "interbankInterestRates");
  }

  async fetchTreasuryAuctionResults(): Promise<unknown> {
    this.notImplemented("GOG T-bill auction results", "treasuryAuctionResults");
  }

  async fetchCentralBankAuctionResults(): Promise<unknown> {
    this.notImplemented("BOG bill auction results", "centralBankAuctionResults");
  }

  async fetchExternalFacilities(): Promise<unknown> {
    this.notImplemented("project administration and external facilities", "externalFacilities");
  }
}
