/**
 * Bank of Ghana types.
 *
 * Only the request-side bounds are settled. The row schemas for each dataset land
 * with their implementation, once the real payloads are known — see the note in
 * tools.ts on why guessing an output shape now would be a disservice to callers.
 *
 * The shared result envelope (`ResultMetaSchema`, `DataOrigin`) comes from
 * lib/results.ts and applies here unchanged.
 */

export const MAX_DAYS = 1825; // five years
export const DEFAULT_DAYS = 90;

/** Default number of auctions returned by the auction-result tools. */
export const DEFAULT_AUCTION_LIMIT = 12;
