import { NotImplementedError, ParseError } from "../../lib/errors.js";
import { cookieHeaderFrom, request, type RequestOptions } from "../../lib/http.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import {
  buildDataTablesBody,
  extractTableNonces,
  nonceFor,
  summarizeTablePayload,
  type ColumnSearch,
  type TableSession,
} from "../../lib/wpDataTables.js";

/**
 * Bank of Ghana upstream access.
 *
 * bog.gov.gh runs the same wpDataTables plugin as gse.com.gh, so the flow is the
 * one in lib/wpDataTables: GET the page for a per-table nonce, then POST it to
 * admin-ajax.php. Two differences from GSE, both discovered the hard way:
 *
 *  - The nonce is exposed as `wdtNonceFrontendServerSide_<id>`, not
 *    `wdtNonceFrontendEdit_<id>`. Looking for the wrong name reads exactly like
 *    "there is no table here", which is a misleading way to fail.
 *  - **No cookie is required.** The POST succeeds with the nonce alone; verified
 *    by issuing it both with and without the PHPSESSID the page hands out. The
 *    cookie is still sent when the page gives one, to stay close to what a browser
 *    does, but it is not treated as mandatory the way GSE's is.
 */

export const BOG_BASE_URL = "https://www.bog.gov.gh";
export const ADMIN_AJAX_PATH = "/wp-admin/admin-ajax.php";

/** bog.gov.gh exposes its table nonces as wdtNonceFrontendServerSide_<id>. */
const BOG_NONCE_FLAVOUR = "frontendServerSide" as const;

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
 * wpDataTables table ids, grouped by the page that carries them. Surveyed
 * 2026-07-25 by reading the nonce inputs on each page and querying every table.
 *
 * The `interbankInterestRates` page carries four separate series; their labels
 * come from the page's own tab titles, in document order, not from guesswork.
 */
export const BOG_TABLES = {
  /** treasury-bill-rates: 1355 rows back to 2013. Includes bonds, not just bills. */
  treasuryBillRates: 2,
  /** bank-of-ghana-bill-rates: 585 rows back to 2016. */
  centralBankBillRates: 3,
  /** daily-interbank-fx-rates: per-currency bid/offer/mid. Latest date only. */
  interbankFxRates: 31,
  /** daily-interbank-fx-rates: a one-cell "weighted median" summary widget. */
  interbankFxSummary: 32,
  /** interbank-interest-rates, tab "Daily Interest Rates". */
  dailyInterestRates: 69,
  /** interbank-interest-rates, tab "Weekly Interest Rates". */
  weeklyInterestRates: 70,
  /** interbank-interest-rates, tab "Reverse Repo Rates". */
  reverseRepoRates: 62,
  /** interbank-interest-rates, tab "Depo Rates". */
  depoRates: 63,
} as const;

/** Column names for the interbank FX table (31), in index order. */
export const FX_COLUMN_NAMES = [
  "dt_date",
  "ds_currency",
  "cd_currency_pair",
  "vl_bid",
  "vl_offer",
  "vl_mid",
] as const;

/**
 * WordPress REST collections on the same site. Kept for the auction datasets,
 * where they are the right index — each record's `link` resolves to a PDF. They
 * carry no figures themselves: `content.rendered` is empty. See docs/BOG.md.
 */
export const BOG_REST_COLLECTIONS = {
  treasuryAuctionResults: "/wp-json/wp/v2/gog_auction_results",
  centralBankAuctionResults: "/wp-json/wp/v2/bog_auction_results",
  dailyInterestRate: "/wp-json/wp/v2/daily_interest_rate",
  averageInterestRate: "/wp-json/wp/v2/avg_interest_rate",
  exchangeRates: "/wp-json/wp/v2/exchange_rates",
} as const;

export type BogSession = TableSession;

export interface BogClientOptions extends RequestOptions {
  baseUrl?: string;
  logger?: Logger;
}

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

  /** Step 1: fetch a page and take the nonces (and cookie, if offered). */
  async createSession(pagePath: string, tableIds: readonly number[]): Promise<BogSession> {
    const response = await request(
      `${this.baseUrl}${pagePath}`,
      {
        headers: {
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "en-US,en;q=0.9",
        },
      },
      { ...this.requestOptions, label: `GET ${pagePath}` },
    );

    const html = await response.text();
    const nonces = extractTableNonces(html, tableIds, BOG_NONCE_FLAVOUR);
    // Unlike GSE, an absent cookie is fine here — the nonce alone is accepted.
    const cookie = cookieHeaderFrom(response.headers);

    this.logger.info("bog: session created", {
      page: pagePath,
      tables: tableIds.join(","),
      htmlBytes: html.length,
      cookie: cookie ? "yes" : "no",
    });
    this.logger.debug("bog: session detail", {
      nonces: Object.entries(nonces)
        .map(([table, nonce]) => `${table}:${nonce}`)
        .join(","),
    });

    return { cookie, nonces };
  }

  /** Step 2: POST the DataTables query for one table. */
  async fetchTable(params: {
    tableId: number;
    session: BogSession;
    pagePath: string;
    columnNames: readonly string[];
    columnSearches?: Record<number, ColumnSearch>;
    length?: number;
    orderColumn?: number;
    orderDir?: "asc" | "desc";
  }): Promise<unknown> {
    const {
      tableId,
      session,
      pagePath,
      columnNames,
      columnSearches = {},
      // -1 means "no client-side limit"; what comes back is whatever the table's
      // own definition allows, which for some BoG tables is a fixed window.
      length = -1,
      orderColumn,
      orderDir = "desc",
    } = params;

    const body = buildDataTablesBody({
      columnNames,
      columnSearches,
      length,
      orderColumn,
      orderDir,
      // These tables declare every column non-orderable, matching the page's own
      // request; sending orderable=true invites a sort the table does not support.
      orderable: false,
      rangeSeparator: "|",
      nonce: nonceFor(session, tableId),
    });

    this.logger.debug("bog: table query", { table: tableId, length });

    const response = await request(
      `${this.baseUrl}${ADMIN_AJAX_PATH}?action=get_wdtable&table_id=${tableId}`,
      {
        method: "POST",
        headers: {
          accept: "application/json, text/javascript, */*; q=0.01",
          "accept-language": "en-US,en;q=0.9",
          "content-type": "application/x-www-form-urlencoded; charset=UTF-8",
          "x-requested-with": "XMLHttpRequest",
          referer: `${this.baseUrl}${pagePath}`,
          ...(session.cookie ? { cookie: session.cookie } : {}),
        },
        body,
      },
      { ...this.requestOptions, label: `POST admin-ajax.php (table ${tableId})` },
    );

    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      this.logger.error("bog: table response was not JSON", {
        table: tableId,
        hint: "usually a rejected wdtNonce",
      });
      throw new ParseError("admin-ajax.php did not return JSON", { cause });
    }

    // WordPress answers a failed nonce with a bare `-1` or `0` and a 200 status.
    // Both are valid JSON, so this has to be caught explicitly.
    if (payload === null || typeof payload !== "object") {
      this.logger.error("bog: table response was a WordPress error sentinel", {
        table: tableId,
        payload: typeof payload === "number" || typeof payload === "string" ? payload : typeof payload,
        hint: "usually a rejected or expired wdtNonce",
      });
      throw new ParseError(
        `admin-ajax.php returned ${JSON.stringify(payload)} instead of a table — the wdtNonce was probably rejected`,
      );
    }

    const summary = summarizeTablePayload(payload);
    this.logger.info("bog: table fetched", { table: tableId, ...summary });

    return payload;
  }

  /**
   * The interbank FX reference rates: one row per currency for the most recently
   * published date.
   *
   * Deliberately takes no date window. Table 31 reports
   * `recordsTotal: 144457, recordsFiltered: 19` for an *unfiltered* query, which
   * means the table's own definition restricts it to the latest date — no request
   * parameter widens that, and date-range searches on the date column return zero
   * rows. So this is a snapshot endpoint, and pretending otherwise in the tool
   * signature would promise history the source will not give.
   */
  async fetchInterbankFxRates(): Promise<unknown> {
    const session = await this.createSession(BOG_PAGES.interbankFxRates, [
      BOG_TABLES.interbankFxRates,
    ]);

    return this.fetchTable({
      tableId: BOG_TABLES.interbankFxRates,
      session,
      pagePath: BOG_PAGES.interbankFxRates,
      columnNames: FX_COLUMN_NAMES,
      length: -1,
    });
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
