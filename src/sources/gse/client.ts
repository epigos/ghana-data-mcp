import { ParseError, UpstreamError } from "../../lib/errors.js";
import { cookieHeaderFrom, request, type RequestOptions } from "../../lib/http.js";
import { silentLogger, type Logger } from "../../lib/log.js";
import { extractNonces } from "./parser.js";
import { MAX_HISTORY_DAYS, type Market } from "./types.js";

/**
 * Raw access to gse.com.gh. Knows the two-step handshake and nothing about MCP,
 * caching, or normalization.
 *
 * The site is a WordPress install using wpDataTables; there is no documented
 * API, so the flow mirrors what the page's own JavaScript does:
 *
 *   1. GET the page  → a `__cf_bm` cookie plus a per-table `wdtNonce`
 *   2. POST both back to admin-ajax.php → the table rows as JSON
 *
 * Neither step is optional: without the cookie/nonce pair the endpoint returns
 * an error instead of data.
 */

export const GSE_BASE_URL = "https://gse.com.gh";
export const ADMIN_AJAX_PATH = "/wp-admin/admin-ajax.php";

/** Pages that host the tables we read. A nonce is only valid for its own page. */
export const PAGES = {
  tradingAndData: "/trading-and-data/",
  listedCompanies: "/listed-companies/",
} as const;

/** wpDataTables table ids, grouped by the page that carries them. */
export const TABLE_IDS = {
  /** trading-and-data: daily share prices, one row per share code per day. */
  dailyPrices: 39,
  /** trading-and-data: GSE Composite Index, market capitalization, volume. */
  marketIndex: 47,
  /** listed-companies: Main Market companies. */
  mainMarket: 34,
  /** listed-companies: Exchange Traded Funds. */
  etf: 35,
  /** listed-companies: Ghana Alternative Market companies. */
  gax: 36,
  /**
   * listed-companies: Ghana Fixed Income Market corporate issuers. Not read —
   * it has a different layout (issuer, tranches, amount raised) and no share
   * codes, so it does not belong in an equity directory.
   */
  gfimCorporate: 37,
} as const;

/** The company tables, with the market each one represents. */
export const COMPANY_TABLES: ReadonlyArray<{ tableId: number; market: Market }> = [
  { tableId: TABLE_IDS.mainMarket, market: "main" },
  { tableId: TABLE_IDS.gax, market: "gax" },
  { tableId: TABLE_IDS.etf, market: "etf" },
];

/**
 * A page's cookie plus every table nonce taken from it.
 *
 * Nonces are per-table but issued per-page-load, so one handshake serves any
 * number of tables on that page — which is what keeps the three-table company
 * directory down to a single page fetch.
 */
export interface GseSession {
  cookie: string;
  nonces: Record<number, string>;
}

/** Nonce for a table, or a clear failure if the handshake did not include it. */
export function nonceFor(session: GseSession, tableId: number): string {
  const nonce = session.nonces[tableId];
  if (!nonce) {
    throw new UpstreamError(`session has no nonce for table ${tableId}`);
  }
  return nonce;
}

export interface GseClientOptions extends RequestOptions {
  baseUrl?: string;
  logger?: Logger;
}

export interface FetchHistoryParams {
  symbol: string;
  days: number;
}

export class GseClient {
  private readonly baseUrl: string;
  private readonly logger: Logger;
  private readonly requestOptions: RequestOptions;

  constructor(options: GseClientOptions = {}) {
    const { baseUrl = GSE_BASE_URL, logger = silentLogger, ...requestOptions } = options;
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.logger = logger.child({ source: "gse" });
    // The logger travels with the request options so lib/http logs every attempt.
    this.requestOptions = { ...requestOptions, logger: this.logger };
  }

  /** Step 1: fetch a page and take the cookie + the nonces it hands out. */
  async createSession(pagePath: string, tableIds: readonly number[]): Promise<GseSession> {
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

    const cookie = cookieHeaderFrom(response.headers);
    if (!cookie) {
      throw new UpstreamError(`gse.com.gh did not set any cookie on ${pagePath}`);
    }

    const html = await response.text();
    const nonces = extractNonces(html, tableIds);

    this.logger.info("gse: session created", {
      page: pagePath,
      tables: tableIds.join(","),
      htmlBytes: html.length,
    });
    // Cookie *names* only — __cf_bm is a session token and does not belong in
    // logs. The nonces are safe: they come from the public page HTML, are scoped
    // to that page load, and are exactly what you need to debug a rejected POST.
    this.logger.debug("gse: session detail", {
      cookieNames: cookie
        .split(";")
        .map((pair) => pair.split("=")[0]?.trim())
        .filter(Boolean)
        .join(","),
      nonces: Object.entries(nonces)
        .map(([table, nonce]) => `${table}:${nonce}`)
        .join(","),
    });

    return { cookie, nonces };
  }

  /**
   * Step 2: POST the DataTables query. `columnSearches` maps a column index to
   * the value searched on it — column 1 is the date range, column 2 the share
   * code, matching the table layout in parser.ts.
   */
  async fetchTable(params: {
    tableId: number;
    session: GseSession;
    /** Column names in index order, as the page's own request sends them. */
    columnNames: readonly string[];
    columnSearches?: Record<number, { value: string; regex?: boolean }>;
    length?: number;
    orderColumn?: number;
    orderDir?: "asc" | "desc";
    /** Sent as `sRangeSeparator`; only needed by tables with a range filter. */
    rangeSeparator?: string;
    /** Page the request should claim to come from. */
    pagePath?: string;
  }): Promise<unknown> {
    const {
      tableId,
      session,
      columnNames,
      columnSearches = {},
      length = 100,
      orderColumn = 1,
      orderDir = "desc",
      rangeSeparator,
      pagePath = PAGES.tradingAndData,
    } = params;

    const body = buildDataTablesBody({
      columnNames,
      columnSearches,
      length,
      orderColumn,
      orderDir,
      rangeSeparator,
      nonce: nonceFor(session, tableId),
    });

    this.logger.debug("gse: table query", {
      table: tableId,
      length,
      order: `${orderColumn} ${orderDir}`,
      searches: Object.entries(columnSearches)
        .map(([index, search]) => `${index}=${search.value}`)
        .join(" "),
    });

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
          cookie: session.cookie,
        },
        body,
      },
      { ...this.requestOptions, label: `POST admin-ajax.php (table ${tableId})` },
    );

    // Note: admin-ajax.php labels these responses `text/html` even when the body
    // is JSON, so the content type is never worth checking — parse and see.
    let payload: unknown;
    try {
      payload = await response.json();
    } catch (cause) {
      // A 200 carrying an HTML error page is one way WordPress rejects a request.
      this.logger.error("gse: table response was not JSON", {
        table: tableId,
        hint: "usually a rejected wdtNonce",
      });
      throw new ParseError("admin-ajax.php did not return JSON", { cause });
    }

    // The other way: admin-ajax.php answers a failed nonce or capability check
    // with a bare `-1` or `0` and a 200 status. Both are *valid* JSON, so
    // `response.json()` succeeds and the sentinel would otherwise slip through to
    // the parser as a baffling "no data array" error.
    if (payload === null || typeof payload !== "object") {
      this.logger.error("gse: table response was a WordPress error sentinel", {
        table: tableId,
        payload: typeof payload === "number" || typeof payload === "string" ? payload : typeof payload,
        hint: "usually a rejected or expired wdtNonce",
      });
      throw new ParseError(
        `admin-ajax.php returned ${JSON.stringify(payload)} instead of a table — the wdtNonce was probably rejected`,
      );
    }

    // `recordsFiltered` vs the row count is the tell for a truncated page: if
    // they differ, the search matched more rows than `length` asked for.
    const summary = summarizeTablePayload(payload);
    this.logger.info("gse: table fetched", { table: tableId, ...summary });
    if (summary.rows !== undefined && summary.recordsFiltered !== undefined && summary.rows < summary.recordsFiltered) {
      this.logger.warn("gse: table response was truncated", {
        table: tableId,
        rows: summary.rows,
        recordsFiltered: summary.recordsFiltered,
        length,
      });
    }

    return payload;
  }

  /** Convenience wrapper: handshake plus one price-table query for a symbol. */
  async fetchStockHistory({ symbol, days }: FetchHistoryParams): Promise<unknown> {
    const boundedDays = Math.min(Math.max(Math.round(days), 1), MAX_HISTORY_DAYS);
    this.logger.info("gse: fetching stock history", {
      symbol: sanitizeSymbol(symbol),
      days: boundedDays,
      clamped: boundedDays !== Math.round(days) ? true : undefined,
    });

    const session = await this.createSession(PAGES.tradingAndData, [TABLE_IDS.dailyPrices]);

    return this.fetchTable({
      tableId: TABLE_IDS.dailyPrices,
      session,
      pagePath: PAGES.tradingAndData,
      columnNames: PRICE_COLUMN_NAMES,
      rangeSeparator: "|",
      columnSearches: {
        1: { value: dateRange(boundedDays), regex: false },
        // Upstream treats this as a substring regex; parser.ts narrows it to an
        // exact match afterwards. Regex metacharacters are stripped so a symbol
        // can never turn into a pattern that matches everything.
        2: { value: sanitizeSymbol(symbol), regex: true },
      },
      // At most ~5 trading days per calendar week, so `days` is always a
      // generous upper bound on the row count for the window.
      length: Math.min(2000, Math.max(100, boundedDays)),
      orderColumn: 1,
      orderDir: "desc",
    });
  }

  /**
   * Handshake once on /listed-companies/, then query each company table with the
   * nonce that page issued. Returns the raw payload per market, for parser.ts to
   * normalize.
   *
   * A table that fails is reported rather than thrown: the Main Market list is
   * still worth returning if the five-row GAX table happens to error.
   */
  async fetchCompanyTables(
    tables: ReadonlyArray<{ tableId: number; market: Market }> = COMPANY_TABLES,
  ): Promise<Array<{ market: Market; payload?: unknown; error?: unknown }>> {
    this.logger.info("gse: fetching company directory", {
      markets: tables.map((table) => table.market).join(","),
    });

    const session = await this.createSession(
      PAGES.listedCompanies,
      tables.map((table) => table.tableId),
    );

    const results = await Promise.all(
      tables.map(async ({ tableId, market }) => {
        try {
          const payload = await this.fetchTable({
            tableId,
            session,
            pagePath: PAGES.listedCompanies,
            columnNames: COMPANY_COLUMN_NAMES,
            // Every table is well under 100 rows; 500 is headroom for growth
            // without asking the site for a page it has to work to build.
            length: 500,
            orderColumn: 0,
            orderDir: "asc",
          });
          return { market, payload };
        } catch (error) {
          this.logger.warn("gse: company table failed", {
            table: tableId,
            market,
            reason: error instanceof Error ? error.message : String(error),
          });
          return { market, error };
        }
      }),
    );

    const failed = results.filter((result) => result.payload === undefined);
    this.logger.info("gse: company directory fetched", {
      ok: results.length - failed.length,
      failed: failed.length || undefined,
      failedMarkets: failed.length ? failed.map((result) => result.market).join(",") : undefined,
    });

    return results;
  }
}

/**
 * The counts wpDataTables reports alongside the rows.
 *
 * It sends them as JSON *strings* (`"recordsTotal": "183595"`) even though the
 * DataTables protocol specifies numbers, so both forms are accepted — reading
 * only numbers would silently drop the counts and disable the truncation check.
 */
function summarizeTablePayload(payload: unknown): {
  rows?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
} {
  if (!payload || typeof payload !== "object") return {};
  const table = payload as { data?: unknown; recordsTotal?: unknown; recordsFiltered?: unknown };
  return {
    rows: Array.isArray(table.data) ? table.data.length : undefined,
    recordsTotal: asCount(table.recordsTotal),
    recordsFiltered: asCount(table.recordsFiltered),
  };
}

function asCount(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Column names for the daily-price table (39), in index order. */
export const PRICE_COLUMN_NAMES = ["wdt_ID", "dailydate", "sharecode"] as const;

/** Column names for the listed-companies tables (34/35/36), in index order. */
export const COMPANY_COLUMN_NAMES = [
  "wdt_ID",
  "symbol",
  "company",
  "datelisted",
  "statedcapital",
  "issuedshares",
  "authorisedshares",
] as const;

/** GSE searches share codes as a regex; keep only characters real codes use. */
export function sanitizeSymbol(symbol: string): string {
  return symbol.trim().toUpperCase().replace(/[^A-Z0-9 .-]/g, "");
}

/** `dd/mm/yyyy|dd/mm/yyyy`, the format wpDataTables' range filter expects. */
export function dateRange(days: number, now: Date = new Date()): string {
  const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  return `${formatDayFirst(start)}|${formatDayFirst(now)}`;
}

function formatDayFirst(date: Date): string {
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}/${date.getUTCFullYear()}`;
}

/**
 * Builds the DataTables server-side form payload. Every column the query
 * touches has to be declared, in order and from index 0, or wpDataTables
 * ignores the searches on the ones that follow a gap.
 */
export function buildDataTablesBody(params: {
  columnNames: readonly string[];
  columnSearches?: Record<number, { value: string; regex?: boolean }>;
  length: number;
  orderColumn: number;
  orderDir: "asc" | "desc";
  rangeSeparator?: string;
  nonce: string;
}): string {
  const {
    columnNames,
    columnSearches = {},
    length,
    orderColumn,
    orderDir,
    rangeSeparator,
    nonce,
  } = params;
  const highestSearched = Math.max(-1, ...Object.keys(columnSearches).map(Number));
  const columnCount = Math.max(columnNames.length, highestSearched + 1);

  const form = new URLSearchParams();
  form.set("draw", "1");

  for (let index = 0; index < columnCount; index++) {
    const search = columnSearches[index];
    form.set(`columns[${index}][data]`, String(index));
    form.set(`columns[${index}][name]`, columnNames[index] ?? `column_${index}`);
    form.set(`columns[${index}][searchable]`, "true");
    form.set(`columns[${index}][orderable]`, "true");
    form.set(`columns[${index}][search][value]`, search?.value ?? "");
    form.set(`columns[${index}][search][regex]`, String(search?.regex ?? false));
  }

  form.set("order[0][column]", String(orderColumn));
  form.set("order[0][dir]", orderDir);
  form.set("start", "0");
  form.set("length", String(length));
  form.set("search[value]", "");
  form.set("search[regex]", "false");
  form.set("wdtNonce", nonce);
  if (rangeSeparator) form.set("sRangeSeparator", rangeSeparator);

  return form.toString();
}
