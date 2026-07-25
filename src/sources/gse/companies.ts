import { UpstreamError } from "../../lib/errors.js";
import type { GseClient } from "./client.js";
import { parseCompanyPayload } from "./parser.js";
import type { Company, CompanyMatch } from "./types.js";

/**
 * The listed-company directory, scraped from https://gse.com.gh/listed-companies/.
 *
 * That page carries four wpDataTables. Three share one layout and are read here:
 * 34 (Main Market), 36 (Ghana Alternative Market), 35 (Exchange Traded Funds).
 * The fourth, 37, lists Ghana Fixed Income Market corporate issuers — different
 * columns, no share codes — so it is left alone.
 *
 * Reading all three matters: the Main Market table alone misses six tradeable
 * symbols (the GAX companies and the GLD ETF), and those symbols do appear in
 * the price table, so a caller could look up history for a company the directory
 * had never mentioned.
 */

/**
 * Fallback for when the scrape breaks (plan §10) — the Python reference's
 * `COMPANY_SYMBOLS` map, which is all Main Market.
 *
 * Verified on 2026-07-25 to be a strict subset of the live directory: all 32
 * entries are still listed, and the live scrape adds 8 more. Its role is purely
 * to keep the tool useful during an upstream outage.
 */
export const COMPANY_SEED: readonly Company[] = Object.freeze(
  (
    [
      ["ACCESS", "Access Bank Ghana Plc"],
      ["ADB", "Agricultural Development Bank"],
      ["AGA", "AngloGold Ashanti Plc"],
      ["ALLGH", "Atlantic Lithium Limited"],
      ["ALW", "Aluworks LTD"],
      ["ASG", "Asante Gold Corporation"],
      ["BOPP", "Benso Oil Palm Plantation Ltd"],
      ["CAL", "CalBank PLC"],
      ["CLYD", "Clydestone (Ghana) Limited"],
      ["CMLT", "Camelot Ghana Ltd"],
      ["CPC", "Cocoa Processing Company"],
      ["DASPHARMA", "Dannex Ayrton Starwin Plc."],
      ["EGH", "Ecobank Ghana PLC"],
      ["EGL", "Enterprise Group PLC"],
      ["ETI", "Ecobank Transnational Incorporation"],
      ["FML", "Fan Milk Limited"],
      ["GCB", "Ghana Commercial Bank Limited"],
      ["GGBL", "Guinness Ghana Breweries Plc"],
      ["GOIL", "GOIL PLC"],
      ["MAC", "Mega African Capital Limited"],
      ["MTNGH", "MTN Ghana"],
      ["PBC", "Produce Buying Company Ltd."],
      ["RBGH", "Republic Bank (Ghana) PLC."],
      ["SCB", "Standard Chartered Bank Ghana Ltd."],
      ["SCB PREF", "Standard Chartered Bank Ghana PLC"],
      ["SIC", "SIC Insurance Company Limited"],
      ["SOGEGH", "Societe Generale Ghana Limited"],
      ["SWL", "Sam Wood Ltd."],
      ["TBL", "Trust Bank Limited (THE GAMBIA)"],
      ["TLW", "Tullow Oil Plc"],
      ["TOTAL", "TotalEnergies Ghana PLC"],
      ["UNIL", "Unilever Ghana PLC"],
    ] as const
  ).map(([symbol, name]): Company => ({ symbol, name, market: "main" })),
);

export const COMPANIES_CACHE_KEY = "gse:companies:v1";
export const COMPANIES_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface CompanyDirectory {
  companies: Company[];
  /** Rows dropped for a missing symbol or name. */
  skipped: number;
  /** Markets whose table failed, so a partial directory can say what is absent. */
  failedMarkets: string[];
}

/**
 * Scrapes the directory: one page handshake, three table queries, merged and
 * sorted by share code.
 *
 * If some tables succeed and others fail we return what we got and name the
 * missing markets — a directory short its five GAX rows is far more useful than
 * no directory. If *every* table fails, that is an upstream failure and throws,
 * which lets the caller fall back to cache or seed.
 */
export async function fetchCompanyDirectory(client: GseClient): Promise<CompanyDirectory> {
  const results = await client.fetchCompanyTables();

  const companies: Company[] = [];
  const failedMarkets: string[] = [];
  let skipped = 0;

  for (const result of results) {
    if (result.payload === undefined) {
      failedMarkets.push(result.market);
      continue;
    }
    try {
      const parsed = parseCompanyPayload(result.payload, result.market);
      companies.push(...parsed.companies);
      skipped += parsed.skipped;
    } catch (error) {
      console.warn(`gse: could not parse the ${result.market} company table`, error);
      failedMarkets.push(result.market);
    }
  }

  if (companies.length === 0) {
    throw new UpstreamError(
      `no company tables could be read (${failedMarkets.join(", ") || "empty response"})`,
    );
  }

  companies.sort((a, b) => a.symbol.localeCompare(b.symbol));
  return { companies, skipped, failedMarkets };
}

/** Common shorthands a user is likely to type that no substring match would catch. */
const ALIASES: Readonly<Record<string, string>> = Object.freeze({
  mtn: "MTNGH",
  scancom: "MTNGH",
  gcb: "GCB",
  "gcb bank": "GCB",
  ecobank: "EGH",
  calbank: "CAL",
  "cal bank": "CAL",
  stanchart: "SCB",
  "standard chartered": "SCB",
  socgen: "SOGEGH",
  "societe generale": "SOGEGH",
  total: "TOTAL",
  totalenergies: "TOTAL",
  unilever: "UNIL",
  goil: "GOIL",
  guinness: "GGBL",
  tullow: "TLW",
  anglogold: "AGA",
  "fan milk": "FML",
  fanmilk: "FML",
  republic: "RBGH",
  access: "ACCESS",
  enterprise: "EGL",
  "first atlantic": "FAB",
  newgold: "GLD",
  "new gold": "GLD",
});

/**
 * Ranks companies against a free-text query so a caller can go from "MTN" or
 * "gcb bank" to a share code without knowing the directory (plan §6).
 *
 * Deliberately not a generic fuzzy-search library: the corpus is ~30 rows, and
 * the cases that matter — exact symbol, common alias, word-prefix — are better
 * served by explicit rules than by an edit-distance score that would rank
 * "SIC" close to "SICO".
 */
export function searchCompanies(
  companies: readonly Company[],
  query: string,
  limit = 10,
): CompanyMatch[] {
  const normalized = normalize(query);
  if (!normalized) return [];

  const aliasSymbol = ALIASES[normalized];

  const matches = companies
    .map((company) => ({ ...company, score: scoreCompany(company, normalized, aliasSymbol) }))
    .filter((match) => match.score > 0)
    .sort((a, b) => b.score - a.score || a.symbol.localeCompare(b.symbol))
    .slice(0, limit);

  return matches;
}

function scoreCompany(company: Company, query: string, aliasSymbol?: string): number {
  const symbol = normalize(company.symbol);
  const name = normalize(company.name);

  if (symbol === query) return 1;
  if (aliasSymbol && company.symbol === aliasSymbol) return 0.98;
  if (name === query) return 0.95;
  if (symbol.startsWith(query)) return 0.9;
  if (wordsOf(name).some((word) => word === query)) return 0.85;
  if (wordsOf(name).some((word) => word.startsWith(query))) return 0.75;
  if (name.includes(query)) return 0.6;
  if (query.length >= 3 && symbol.includes(query)) return 0.5;

  // Last resort: how much of the query's bigram set the name covers. Cheap,
  // order-insensitive, and good enough to catch a typo in a long name.
  const similarity = diceCoefficient(query, name);
  return similarity >= 0.4 ? similarity * 0.5 : 0;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, " ").replace(/\s+/g, " ").trim();
}

function wordsOf(value: string): string[] {
  return value.split(" ").filter(Boolean);
}

function diceCoefficient(a: string, b: string): number {
  const bigrams = (value: string) => {
    const set = new Set<string>();
    for (let i = 0; i < value.length - 1; i++) set.add(value.slice(i, i + 2));
    return set;
  };
  const first = bigrams(a);
  const second = bigrams(b);
  if (first.size === 0 || second.size === 0) return 0;

  let shared = 0;
  for (const gram of first) if (second.has(gram)) shared++;
  return (2 * shared) / (first.size + second.size);
}
