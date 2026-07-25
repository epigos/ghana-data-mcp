import { z } from "zod";

/**
 * Bank of Ghana types.
 *
 * Row schemas land with each dataset's implementation, once the real payload is
 * known — see the note in tools.ts on why guessing an output shape would be a
 * disservice to callers.
 *
 * The shared result envelope (`ResultMetaSchema`, `DataOrigin`) comes from
 * lib/results.ts and applies here unchanged.
 */

/**
 * Twenty years, which comfortably covers everything BoG publishes: the Treasury
 * rate table reaches back to 26 Aug 2013 and the interbank reverse-repo series to
 * 2002. An earlier five-year ceiling silently put most of that out of reach.
 */
export const MAX_DAYS = 7300;
export const DEFAULT_DAYS = 90;

/**
 * One interbank reference rate for the cedi against another currency.
 *
 * These are the Bank of Ghana's official interbank reference rates, quoted as
 * cedi per unit of the foreign currency. They are not retail or forex-bureau
 * rates, which are usually worse and differ between providers.
 */
export const InterbankFxRateSchema = z.object({
  date: z.string().describe("Publication date, ISO 8601 (YYYY-MM-DD)."),
  currency: z.string().describe("Currency name as BoG publishes it, e.g. US Dollar."),
  code: z
    .string()
    .describe("Currency code taken from the pair, e.g. USD. Not always ISO 4217 — see `pair`."),
  pair: z.string().describe("Currency pair as published, e.g. USDGHS."),
  bid: z.number().describe("Bid rate: cedis per unit of the foreign currency."),
  offer: z.number().describe("Offer (ask) rate: cedis per unit of the foreign currency."),
  mid: z.number().describe("Mid rate — the one to quote if only one number is wanted."),
});
export type InterbankFxRate = z.infer<typeof InterbankFxRateSchema>;

/**
 * One published rate for a government or central-bank security.
 *
 * Note that BoG's "Treasury Bill Rate" table is not only bills: alongside the 91,
 * 182 and 364-day bills it carries notes and bonds (`2 YR FXR NOTE`,
 * `7 YR FXR BOND`). `securityType` is verbatim so nothing is lost, and `tenorDays`
 * is filled in only where the label states a tenor in days.
 */
export const BillRateSchema = z.object({
  date: z.string().describe("Issue date, ISO 8601 (YYYY-MM-DD)."),
  tenderNumber: z
    .string()
    .describe("BoG's tender number for the auction that set this rate. An identifier, not a quantity."),
  securityType: z
    .string()
    .describe("Security as published, e.g. \"91 DAY BILL\", \"2 YR FXR NOTE\", \"7 YR FXR BOND\"."),
  tenorDays: z
    .number()
    .optional()
    .describe("Tenor in days, when the security is quoted in days. Absent for notes and bonds quoted in years."),
  discountRate: z.number().describe("Discount rate, percent per annum."),
  interestRate: z.number().describe("Interest rate, percent per annum. The yield most callers want."),
});
export type BillRate = z.infer<typeof BillRateSchema>;
