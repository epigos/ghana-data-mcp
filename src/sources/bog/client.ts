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
import { MAX_DAYS } from "./types.js";

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
 * The two weekly auction-result datasets are deliberately absent: BoG publishes
 * those as one PDF per tender rather than as tables, and PDF table extraction inside
 * a Worker is a different and much larger job. See docs/BOG.md.
 *
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
  historicalInterbankFxRates: "/treasury-and-the-markets/historical-interbank-fx-rates/",
  interbankInterestRates: "/treasury-and-the-markets/interbank-interest-rates/",
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
  /**
   * historical-interbank-fx-rates: the full series — 144,457 rows back to
   * 02 Jan 1996, same six columns as table 31, and it *does* accept a date range.
   */
  historicalInterbankFxRates: 40,
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

/** Column names for the bill-rate tables (2 and 3), in index order. */
export const BILL_RATE_COLUMN_NAMES = [
  "dt_issue_date",
  "cd_tender_number",
  "ds_security_type",
  "vl_discount_rate",
  "vl_interest_rate",
] as const;

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
    /** The bill tables declare ordered columns; the FX table does not. */
    orderable?: boolean;
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
      orderable = false,
    } = params;

    const body = buildDataTablesBody({
      columnNames,
      columnSearches,
      length,
      orderColumn,
      orderDir,
      orderable,
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

  /**
   * Bill and bond rates from one of the two rate tables, filtered upstream to a
   * date window.
   *
   * Unlike the FX table, these accept a real date-range search on the issue-date
   * column — in BoG's own `dd MMM yyyy` format, pipe-separated. Table 2 holds 1355
   * rows back to 2013 and table 3 holds 585 back to 2016, so filtering upstream
   * rather than fetching everything is worth doing.
   *
   * The security-type column is *not* filtered here even though the page's request
   * offers it: despite `regex=true`, the upstream matches the whole value exactly,
   * so `364 DAY` finds nothing while `364 DAY BILL` finds 289 rows. That is a sharp
   * edge to hand a caller, so the parser filters types in memory instead — the
   * windowed payload is small enough that it costs nothing.
   */
  async fetchBillRates(params: {
    tableId: number;
    pagePath: string;
    days: number;
    now?: Date;
  }): Promise<unknown> {
    const { tableId, pagePath, days, now } = params;
    const boundedDays = Math.min(Math.max(Math.round(days), 1), MAX_DAYS);
    const range = bogDateRange(boundedDays, now);

    this.logger.info("bog: fetching bill rates", { table: tableId, days: boundedDays, range });

    const session = await this.createSession(pagePath, [tableId]);

    return this.fetchTable({
      tableId,
      session,
      pagePath,
      columnNames: BILL_RATE_COLUMN_NAMES,
      columnSearches: { 0: { value: range, regex: false } },
      // Three securities per weekly tender, so a generous bound on the window.
      length: Math.min(5000, Math.max(100, boundedDays * 3)),
      orderColumn: 0,
      orderDir: "desc",
      orderable: true,
    });
  }

  /**
   * Historical interbank FX rates from table 40, windowed by date.
   *
   * A different page and table from the latest-day snapshot: table 31 is pinned to
   * the most recent publication, while this one holds the whole series and takes a
   * real date-range search.
   *
   * `pair` filters upstream when given, and matters more here than it looks. The
   * unfiltered table is 144,457 rows — about 4,700 per year across 19 currencies —
   * and a Worker on the free tier has a 10ms CPU budget, so parsing a multi-year
   * unfiltered window is not something to do casually. One exact pair cuts the
   * payload 19-fold.
   *
   * Like the security-type column on the bill tables, this search matches the whole
   * value exactly: `USDGHS` returns rows, `USD` returns none, and `regex: true`
   * does not change that. So the caller-facing tool resolves a loose input to an
   * exact pair before it gets here, and falls back to filtering in memory when it
   * cannot.
   */
  async fetchHistoricalInterbankFxRates(params: {
    days: number;
    pair?: string;
    maxRows?: number;
    now?: Date;
  }): Promise<unknown> {
    const { days, pair, maxRows = 20_000, now } = params;
    const boundedDays = Math.min(Math.max(Math.round(days), 1), MAX_DAYS);
    const range = bogDateRange(boundedDays, now);

    this.logger.info("bog: fetching historical FX rates", {
      days: boundedDays,
      range,
      pair: pair ?? "all",
    });

    const session = await this.createSession(BOG_PAGES.historicalInterbankFxRates, [
      BOG_TABLES.historicalInterbankFxRates,
    ]);

    const columnSearches: Record<number, ColumnSearch> = { 0: { value: range, regex: false } };
    if (pair) columnSearches[2] = { value: pair, regex: false };

    return this.fetchTable({
      tableId: BOG_TABLES.historicalInterbankFxRates,
      session,
      pagePath: BOG_PAGES.historicalInterbankFxRates,
      columnNames: FX_COLUMN_NAMES,
      columnSearches,
      length: maxRows,
      orderColumn: 0,
      orderDir: "desc",
      orderable: true,
    });
  }

  private notImplemented(dataset: string, page: keyof typeof BOG_PAGES): never {
    throw new NotImplementedError(
      `Bank of Ghana ${dataset} is not implemented yet. The data is published at ${this.pageUrl(page)}.`,
    );
  }

  /** Government of Ghana Treasury securities (table 2). */
  async fetchTreasuryBillRates(days: number, now?: Date): Promise<unknown> {
    return this.fetchBillRates({
      tableId: BOG_TABLES.treasuryBillRates,
      pagePath: BOG_PAGES.treasuryBillRates,
      days,
      now,
    });
  }

  /** Securities the Bank of Ghana issues itself (table 3). */
  async fetchCentralBankBillRates(days: number, now?: Date): Promise<unknown> {
    return this.fetchBillRates({
      tableId: BOG_TABLES.centralBankBillRates,
      pagePath: BOG_PAGES.centralBankBillRates,
      days,
      now,
    });
  }

  async fetchInterbankInterestRates(): Promise<unknown> {
    this.notImplemented("interbank interest rates", "interbankInterestRates");
  }

  async fetchExternalFacilities(): Promise<unknown> {
    this.notImplemented("project administration and external facilities", "externalFacilities");
  }
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

/** `01 May 2026` — the format BoG's own date filter expects. */
export function formatBogDate(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${day} ${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
}

/** `01 May 2026|25 Jul 2026`, the pipe-separated range the filter expects. */
export function bogDateRange(days: number, now: Date = new Date()): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return `${formatBogDate(start)}|${formatBogDate(now)}`;
}
