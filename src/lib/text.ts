/**
 * Strips HTML tags and collapses whitespace, including embedded newlines.
 *
 * Shared because three sources independently needed the same cleanup: GSE wraps
 * its Symbol column in an `<a>` tag, BoG's currency and security-type cells carry
 * stray whitespace, and IMF's indicator labels and descriptions contain both —
 * `"GDP per capita, current prices\n"` and `"...<b>Note</b>..."` are both real
 * values from the IMF DataMapper catalog.
 */
export function stripHtml(value: unknown): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/<[^>]*>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
