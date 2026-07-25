import { parseHTML } from "linkedom";

import { UpstreamError } from "./errors.js";

/**
 * Shared client for the wpDataTables WordPress plugin.
 *
 * Both gse.com.gh and bog.gov.gh publish their tables with it, and the request
 * format is fiddly enough — see the column-declaration rule below — that having
 * two copies would be asking for a subtle divergence.
 *
 * The two sites differ in exactly one way, which is why the nonce lookup is
 * parameterised: they expose the nonce under different input names.
 */

/**
 * Which hidden input the page puts the nonce in.
 *
 *  - `frontendEdit` → `wdtNonceFrontendEdit_<id>`, used by gse.com.gh
 *  - `frontendServerSide` → `wdtNonceFrontendServerSide_<id>`, used by bog.gov.gh
 *
 * A page can carry either or both; the name reflects how the table was configured,
 * not anything about the data. Guessing wrong looks exactly like "no table here",
 * which is a confusing way to fail, so callers state which they expect.
 */
export type NonceFlavour = "frontendEdit" | "frontendServerSide";

const NONCE_INPUT_PREFIX: Record<NonceFlavour, string> = {
  frontendEdit: "wdtNonceFrontendEdit_",
  frontendServerSide: "wdtNonceFrontendServerSide_",
};

/** A page's cookie plus every table nonce taken from it. */
export interface TableSession {
  cookie: string;
  nonces: Record<number, string>;
}

/**
 * Reads several tables' nonces from one page. Nonces are per-table but issued per
 * page load, so one fetch serves every table on the page.
 */
export function extractTableNonces(
  html: string,
  tableIds: readonly number[],
  flavour: NonceFlavour,
): Record<number, string> {
  const { document } = parseHTML(html);
  const prefix = NONCE_INPUT_PREFIX[flavour];
  const nonces: Record<number, string> = {};

  for (const tableId of tableIds) {
    const selector = `input#${prefix}${tableId}`;
    const value = document.querySelector(selector)?.getAttribute("value")?.trim();
    if (!value) {
      throw new UpstreamError(
        `no usable ${selector} on the page — the site may have served an error or challenge page`,
      );
    }
    nonces[tableId] = value;
  }

  return nonces;
}

/** Nonce for a table, or a clear failure if the handshake did not include it. */
export function nonceFor(session: TableSession, tableId: number): string {
  const nonce = session.nonces[tableId];
  if (!nonce) {
    throw new UpstreamError(`session has no nonce for table ${tableId}`);
  }
  return nonce;
}

export interface ColumnSearch {
  value: string;
  regex?: boolean;
}

export interface DataTablesQuery {
  /** Column names in index order, as the page's own request sends them. */
  columnNames: readonly string[];
  columnSearches?: Record<number, ColumnSearch>;
  length: number;
  orderColumn?: number;
  orderDir?: "asc" | "desc";
  /** Whether the server may reorder; some tables declare every column fixed. */
  orderable?: boolean;
  /** Sent as `sRangeSeparator`; only needed by tables with a range filter. */
  rangeSeparator?: string;
  nonce: string;
}

/**
 * Builds the DataTables server-side form payload.
 *
 * Every column the query touches has to be declared, in order and from index 0,
 * or wpDataTables ignores the searches on the ones that follow a gap.
 */
export function buildDataTablesBody(query: DataTablesQuery): string {
  const {
    columnNames,
    columnSearches = {},
    length,
    orderColumn,
    orderDir = "desc",
    orderable = true,
    rangeSeparator,
    nonce,
  } = query;

  const highestSearched = Math.max(-1, ...Object.keys(columnSearches).map(Number));
  const columnCount = Math.max(columnNames.length, highestSearched + 1);

  const form = new URLSearchParams();
  form.set("draw", "1");

  for (let index = 0; index < columnCount; index++) {
    const search = columnSearches[index];
    form.set(`columns[${index}][data]`, String(index));
    form.set(`columns[${index}][name]`, columnNames[index] ?? `column_${index}`);
    form.set(`columns[${index}][searchable]`, "true");
    form.set(`columns[${index}][orderable]`, String(orderable));
    form.set(`columns[${index}][search][value]`, search?.value ?? "");
    form.set(`columns[${index}][search][regex]`, String(search?.regex ?? false));
  }

  if (orderColumn !== undefined) {
    form.set("order[0][column]", String(orderColumn));
    form.set("order[0][dir]", orderDir);
  }
  form.set("start", "0");
  form.set("length", String(length));
  form.set("search[value]", "");
  form.set("search[regex]", "false");
  form.set("wdtNonce", nonce);
  if (rangeSeparator) form.set("sRangeSeparator", rangeSeparator);

  return form.toString();
}

export interface TablePayloadSummary {
  rows?: number;
  recordsTotal?: number;
  recordsFiltered?: number;
}

/**
 * The counts wpDataTables reports alongside the rows.
 *
 * It sends them as JSON *strings* (`"recordsTotal": "183595"`) even though the
 * DataTables protocol specifies numbers, so both forms are accepted — reading only
 * numbers would silently drop the counts.
 */
export function summarizeTablePayload(payload: unknown): TablePayloadSummary {
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
