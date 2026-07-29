import type { Granularity } from "./types.js";

/**
 * The StatsBank table registry.
 *
 * StatsBank is a PxWeb instance, and PxWeb is self-describing: a GET on a table
 * returns its variables and their allowed values. So why hardcode a registry at
 * all?
 *
 * Because three things a caller needs are *not* in the schema response:
 *
 *  - **Which variable is the time axis.** PxWeb has a `time: true` flag for this,
 *    but StatsBank only sets it on 8 of these 16 tables. `agdp_p_p.Year`,
 *    `fiscal_data.Time_Period` and `mieg.Month` are all plainly time axes with no
 *    flag, so the flag cannot be trusted and the axis has to be named here.
 *  - **Whether the time axis mixes granularities.** `fiscal_data` and
 *    `macro_trade` interleave annual, quarterly and monthly codes in one variable
 *    (`2024Q2`, `2024M06`, `2023` …). A caller asking for "the last 5 periods"
 *    of those tables without saying which granularity gets a series that mixes a
 *    quarter with the months inside it — the same money counted twice. Tables
 *    flagged `mixedGranularity` require an explicit `granularity`.
 *  - **Which direction the axis runs.** Documented on `chronological` below.
 *
 * Keeping the registry static also means `gss_list_tables` answers with no network
 * call at all, and `gss_get_data` knows a table's path and time axis without a
 * discovery round trip first. Only the *values* (which periods exist today) need
 * the live schema, and those are cached.
 */

export interface TableDef {
  /** Stable short id a caller passes as `table`. Ours, not upstream's. */
  id: string;
  /** Upstream ids and other spellings a caller might reasonably try. */
  aliases: readonly string[];
  /** Path under /api/v1/en/, unencoded. */
  path: string;
  title: string;
  sector: string;
  /** The variable holding the time axis — see the class doc on why this is here. */
  timeVariable: string;
  /**
   * True when the time axis interleaves granularities and a caller must pick one.
   * Verified live: `macro_trade` top-5 returns 2025Q4, 2025M12, 2025M11, 2025M10,
   * 2025Q3 — a quarter and three of its own months in one series.
   */
  mixedGranularity: boolean;
  /** Non-time variables, in the order the upstream schema lists them. */
  dimensions: readonly string[];
  /** One line on what the table covers, for `gss_list_tables` and tool descriptions. */
  summary: string;
}

/**
 * `Prices and Inflation/commodity_price.px` is the one upstream filename that
 * differs from its logical name; the MIEG table is worse — its filename carries a
 * publication vintage (`April_26_MIEG_Px.px`) and will change when GSS publishes a
 * new one. The live canary test is what catches that; there is no way to pin it
 * from here. If MIEG starts 404ing, re-read the folder listing at
 * `/api/v1/en/Macroeconomic Indicators/Monthly Indicator of Economic Growth(MIEG)/`
 * and update the path.
 */
export const TABLES: readonly TableDef[] = [
  {
    id: "cpi",
    aliases: ["consumer_price_index", "inflation", "cpi.px"],
    path: "Macroeconomic Indicators/Prices and Inflation/cpi.px",
    title: "Consumer Price Index (CPI) and Inflation",
    sector: "Prices and Inflation",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Indicator", "Region", "Product", "Source"],
    summary:
      "Headline and regional inflation. CPI level plus year-on-year and month-on-month rates, " +
      "for Ghana and all 16 regions, split by product group and by local/imported source.",
  },
  {
    id: "ppi",
    aliases: ["producer_price_index", "ppi.px"],
    path: "Macroeconomic Indicators/Prices and Inflation/ppi.px",
    title: "Producer Price Index (PPI)",
    sector: "Prices and Inflation",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Indicator", "Industry"],
    summary: "Factory-gate prices by industry, as an index and as year-on-year / month-on-month change.",
  },
  {
    id: "commodity_prices",
    aliases: ["commodity_price", "commodities", "commodity_price.px"],
    path: "Macroeconomic Indicators/Prices and Inflation/commodity_price.px",
    title: "Commodity Prices",
    sector: "Prices and Inflation",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Price", "Commodity"],
    summary:
      "Monthly gold (USD/oz), cocoa (USD/tonne), Brent crude (USD/barrel), and domestic petrol and " +
      "diesel pump prices (GHC/litre), on both an indicative and a realised basis.",
  },
  {
    id: "iip",
    aliases: ["industrial_production", "index_of_industrial_production", "iip.px"],
    path: "Macroeconomic Indicators/Prices and Inflation/iip.px",
    title: "Index of Industrial Production (IIP)",
    sector: "Prices and Inflation",
    timeVariable: "Quarter",
    mixedGranularity: false,
    dimensions: ["Indicator", "Sector"],
    summary: "Quarterly industrial output index across 34 mining, manufacturing, utility and water sectors.",
  },
  {
    id: "xmpi",
    aliases: ["macro_xmpi", "export_import_prices", "macro_xmpi.px"],
    path: "Macroeconomic Indicators/Prices and Inflation/macro_xmpi.px",
    title: "Export and Import Price Indices (XMPI)",
    sector: "Prices and Inflation",
    timeVariable: "Quarter",
    mixedGranularity: false,
    dimensions: ["Indicator", "Tradeflow", "Product_Classification"],
    summary: "Quarterly unit-value indices for exports and imports, by product class. Terms-of-trade input.",
  },
  {
    id: "gdp_production",
    aliases: ["agdp_p_p", "gdp", "annual_gdp_production", "agdp_p_p.px"],
    path: "Macroeconomic Indicators/Real Sector (GDP)/Annual GDP/agdp_p_p.px",
    title: "Annual GDP, production approach",
    sector: "Real Sector (GDP)",
    timeVariable: "Year",
    mixedGranularity: false,
    dimensions: ["GDP_Series", "Variable"],
    summary:
      "Annual GDP by industry (33 activities from Cocoa to Financial services), as nominal level, " +
      "real level, year-on-year growth, or share of GDP.",
  },
  {
    id: "gdp_expenditure",
    aliases: ["agdp_e_px", "annual_gdp_expenditure", "agdp_e_px.px"],
    path: "Macroeconomic Indicators/Real Sector (GDP)/Annual GDP/agdp_e_px.px",
    title: "Annual GDP, expenditure approach",
    sector: "Real Sector (GDP)",
    timeVariable: "Year",
    mixedGranularity: false,
    dimensions: ["GDP_Series", "Variable"],
    summary:
      "Annual GDP by expenditure component: household and government consumption, capital formation, " +
      "exports and imports. Nominal, real, or growth rate.",
  },
  {
    id: "mieg",
    aliases: ["monthly_growth", "monthly_indicator_of_economic_growth"],
    path: "Macroeconomic Indicators/Monthly Indicator of Economic Growth(MIEG)/April_26_MIEG_Px.px",
    title: "Monthly Indicator of Economic Growth (MIEG)",
    sector: "Real Sector (GDP)",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["GDP_Series", "Variable"],
    summary:
      "Monthly growth proxy for agriculture, industry, services and the total economy, as an index " +
      "or a growth rate. Higher frequency than annual GDP but a narrower series.",
  },
  {
    id: "debt",
    aliases: ["debt_data", "public_debt", "debt_data.px"],
    path: "Macroeconomic Indicators/Fiscal Sector/debt_data.px",
    title: "Debt Data",
    sector: "Fiscal Sector",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Variable"],
    summary:
      "Public debt stock split external (multilateral, bilateral, commercial, capital-market) and " +
      "domestic (by tenor and by holder: banking, non-bank, foreign).",
  },
  {
    id: "fiscal",
    aliases: ["fiscal_data", "budget", "revenue", "fiscal_data.px"],
    path: "Macroeconomic Indicators/Fiscal Sector/fiscal_data.px",
    title: "Fiscal Data",
    sector: "Fiscal Sector",
    timeVariable: "Time_Period",
    mixedGranularity: true,
    dimensions: ["Valuation_Parameter", "Variable"],
    summary:
      "Government revenue, grants, expenditure and the deficit, in cedis or as a share of annual GDP. " +
      "Annual, quarterly and monthly periods share one axis, so a granularity is required.",
  },
  {
    id: "interest_rates",
    aliases: ["interest", "rates", "interest.px"],
    path: "Macroeconomic Indicators/Monetary and Financial Sector/interest.px",
    title: "Interest Rates",
    sector: "Monetary and Financial Sector",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Rate"],
    summary:
      "Monetary policy rate, 91-day Treasury bill, average lending rate, Ghana reference rate, " +
      "interbank weighted average and savings deposit rate. Monthly back to 1971.",
  },
  {
    id: "monetary",
    aliases: ["monetary_data", "money_supply", "credit", "monetary.px"],
    path: "Macroeconomic Indicators/Monetary and Financial Sector/monetary.px",
    title: "Monetary Data",
    sector: "Monetary and Financial Sector",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Variable"],
    summary:
      "Money supply (M1, M2, currency outside banks) and bank credit broken out by the sector " +
      "borrowing it: agriculture, cocoa, manufacturing, construction, services, trade and more.",
  },
  {
    id: "financial_soundness",
    aliases: ["fin_sound", "banking", "fin_sound.px"],
    path: "Macroeconomic Indicators/Monetary and Financial Sector/fin_sound.px",
    title: "Financial Soundness Indicators",
    sector: "Monetary and Financial Sector",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Indicator"],
    summary:
      "Banking-sector health: capital adequacy ratio, non-performing loan ratio, return on assets " +
      "and equity, liquidity and cost-to-income ratios.",
  },
  {
    id: "trade",
    aliases: ["macro_trade", "merchandise_trade", "exports", "imports", "macro_trade.px"],
    path: "Macroeconomic Indicators/External Sector/macro_trade.px",
    title: "International Merchandise Trade",
    sector: "External Sector",
    timeVariable: "Time_Period",
    mixedGranularity: true,
    dimensions: ["Valuation_Parameter", "Tradeflow", "Product_Classification"],
    summary:
      "Exports, imports and total trade by product class (gold, cocoa, mineral fuels, machinery …), " +
      "valued in cedis (nominal or real), US dollars, or net kilograms. Annual, quarterly and " +
      "monthly periods share one axis, so a granularity is required.",
  },
  {
    id: "international_finance",
    aliases: ["int_fin", "balance_of_payments", "bop", "current_account", "int_fin.px"],
    path: "Macroeconomic Indicators/External Sector/int_fin.px",
    title: "International Finance",
    sector: "External Sector",
    timeVariable: "Time_Period",
    mixedGranularity: false,
    dimensions: ["Variable"],
    summary:
      "Balance of payments: overall balance, current, capital and financial account balances, " +
      "net FDI, and private and official transfers. Quarterly.",
  },
  {
    id: "fuel",
    aliases: ["fuel_consumption", "petroleum", "fuel.px"],
    path: "Macroeconomic Indicators/fuel.px",
    title: "Fuel Consumption",
    sector: "Other",
    timeVariable: "Month",
    mixedGranularity: false,
    dimensions: ["Fuel"],
    summary:
      "Monthly petroleum consumption by product: petrol, diesel, LPG, aviation kerosene, marine " +
      "gasoil, premix and mining-sector gasoil.",
  },
];

const BY_KEY = new Map<string, TableDef>();
for (const table of TABLES) {
  BY_KEY.set(table.id.toLowerCase(), table);
  for (const alias of table.aliases) BY_KEY.set(alias.toLowerCase(), table);
}

/** Resolves a table id or alias, case- and separator-insensitively. */
export function findTable(requested: string): TableDef | undefined {
  const trimmed = requested.trim().toLowerCase();
  if (!trimmed) return undefined;
  return BY_KEY.get(trimmed) ?? BY_KEY.get(trimmed.replace(/[\s-]+/g, "_"));
}

/** Every distinct sector, in registry order. */
export function sectors(): string[] {
  return [...new Set(TABLES.map((t) => t.sector))];
}

/**
 * Granularities a table can actually serve, for the `gss_list_tables` output and
 * for validating a `granularity` argument before a request is made.
 */
export function likelyGranularities(table: TableDef): Granularity[] {
  if (table.mixedGranularity) return ["annual", "quarterly", "monthly"];
  if (table.timeVariable === "Year") return ["annual"];
  if (table.timeVariable === "Quarter") return ["quarterly"];
  return ["monthly"];
}
