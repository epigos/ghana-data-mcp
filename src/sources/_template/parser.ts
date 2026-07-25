import { ParseError } from "../../lib/errors.js";

/**
 * Pure response → typed rows. No fetch, no bindings, no clock — that is what
 * lets the tests run against a saved fixture with no network.
 *
 * Drop malformed rows and count them (plan §9) instead of throwing: one bad row
 * should not cost the caller the good ones. Throw `ParseError` only when the
 * whole response is unusable.
 */

export interface TemplateRow {
  id: string;
  value: number;
}

export interface ParsedTemplate {
  rows: TemplateRow[];
  skipped: number;
}

export function parseTemplatePayload(payload: unknown): ParsedTemplate {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { data?: unknown }).data)) {
    throw new ParseError("response has no `data` array");
  }

  const rows: TemplateRow[] = [];
  let skipped = 0;

  for (const raw of (payload as { data: unknown[] }).data) {
    const row = raw as Partial<TemplateRow>;
    if (typeof row?.id !== "string" || typeof row?.value !== "number") {
      skipped++;
      continue;
    }
    rows.push({ id: row.id, value: row.value });
  }

  return { rows, skipped };
}
