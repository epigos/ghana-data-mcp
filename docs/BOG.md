# Bank of Ghana (`bog_*`)

Treasury and money-market data published by the Bank of Ghana at
[bog.gov.gh](https://www.bog.gov.gh/treasury-and-the-markets/). Seven tools.

> **Status: stubs.** Every tool below is registered with its final input schema,
> but calling one returns an error. No Bank of Ghana data is available from this
> server yet. There is also an unresolved blocker on BoG's side — see
> [TLS blocker](#blocker-bogs-tls-chain-is-incomplete), which you should read
> before starting implementation.

- [Datasets and tools](#datasets-and-tools)
- [Blocker: BoG's TLS chain is incomplete](#blocker-bogs-tls-chain-is-incomplete)
- [What the upstream looks like](#what-the-upstream-looks-like)
- [Implementing a dataset](#implementing-a-dataset)
- [What the stubs do when called](#what-the-stubs-do-when-called)

## Datasets and tools

One tool per dataset in BoG's Treasury and the Markets section. All seven page
URLs were fetched and returned HTTP 200 on 2026-07-25.

| Tool                                    | Dataset                                  | Page                                                                |
| --------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------- |
| `bog_get_treasury_bill_rates`           | Treasury Bill Rate                       | `/treasury-and-the-markets/treasury-bill-rates/`                    |
| `bog_get_central_bank_bill_rates`       | Bank of Ghana Bill Rates                 | `/treasury-and-the-markets/bank-of-ghana-bill-rates/`               |
| `bog_get_interbank_fx_rates`            | Daily Interbank FX Rates                 | `/treasury-and-the-markets/daily-interbank-fx-rates/`               |
| `bog_get_interbank_interest_rates`      | Interbank Interest Rates                 | `/treasury-and-the-markets/interbank-interest-rates/`               |
| `bog_get_treasury_auction_results`      | Weekly GOG T-Bill Auction Results        | `/gog_auction_results/`                                             |
| `bog_get_central_bank_auction_results`  | Weekly BOG Bill Auction Results          | `/bog_auction_results/`                                             |
| `bog_list_external_facilities`          | Project Administration & External Facilities | `/treasury-and-the-markets/project-administration-and-external-facilities/` |

Two naming decisions worth stating, since both pairs are easy to confuse and a
model picking the wrong one would answer a different question:

- **Treasury vs central-bank bills.** `treasury` means Government of Ghana
  securities; `central_bank` means bills the Bank of Ghana issues itself. BoG
  publishes these as separate series and so do we.
- **Rates vs auction results.** The rate tools give the published rate series; the
  auction tools give the outcome of a specific weekly tender — amounts tendered
  and accepted, and what cleared. Related, but not interchangeable.

### Inputs (settled)

The input contracts are final and can be coded against now:

| Tool                                   | Input                                             |
| -------------------------------------- | ------------------------------------------------- |
| Rate series (bills, FX, interbank)     | `days` — calendar days back, default 90, max 1825 |
| `bog_get_interbank_fx_rates`           | plus `currency` — ISO code, e.g. `USD`            |
| `bog_get_interbank_interest_rates`     | plus `frequency` — `daily` or `weekly`            |
| Auction results                        | `limit` — most recent auctions, default 12        |
| `bog_list_external_facilities`         | `refresh`                                         |

### Outputs (deliberately undeclared)

None of these tools declares an `outputSchema` yet. The row shapes land with each
implementation, once the real payload is in hand. Publishing a guessed schema would
invite callers to code against fields that may not survive contact with the data —
worse than publishing nothing.

## Blocker: BoG's TLS chain is incomplete

**www.bog.gov.gh cannot currently be fetched from Cloudflare Workers or from
Node.** This is a misconfiguration on BoG's server, not something this repo can
work around in code.

The server presents only its leaf certificate and omits the DigiCert intermediate
that signed it:

```
$ openssl s_client -connect www.bog.gov.gh:443 -servername www.bog.gov.gh
Certificate chain
 0 s:C=GH, L=Accra, O=Bank of Ghana, CN=*.bog.gov.gh
   i:C=US, O=DigiCert Inc, CN=DigiCert Global G2 TLS RSA SHA256 2020 CA1   <-- not sent
verify error:num=21:unable to verify the first certificate
```

A client that fetches the missing issuer itself (macOS, and browsers) papers over
it. A client that does not, fails:

| Client                          | Result                                        |
| ------------------------------- | --------------------------------------------- |
| `curl` on macOS                 | 200 — the OS supplies the missing intermediate |
| Node / undici (so vitest too)   | `UNABLE_TO_VERIFY_LEAF_SIGNATURE`             |
| Workers runtime (`wrangler dev`)| fetch throws                                  |
| Workers runtime → gse.com.gh    | 200 — same probe, so it is not the runtime      |

That last row is the one that matters: a single probe worker fetched gse.com.gh
successfully and bog.gov.gh unsuccessfully, which rules out a general outbound
problem and points squarely at the chain.

**Unverified:** this was tested against the local `workerd` runtime. Cloudflare's
production edge may have the intermediate cached and succeed where local does not —
that cannot be confirmed without deploying, so treat production as unknown rather
than broken.

Plain HTTP is not an escape hatch: `http://www.bog.gov.gh/` resets the connection.

### What to do about it

In rough order of preference:

1. **Ask BoG to fix it.** Serving the intermediate is a one-line web-server change
   and fixes every strict client, not just this one.
2. **Confirm production behaviour** by deploying a probe worker and fetching one
   page. If Cloudflare's edge resolves the chain, the blocker only affects local
   development and tests.
3. **Fetch through something that completes the chain** — a small proxy, or a
   Worker with a bundled CA. This adds a hop and a component to maintain.

Disabling certificate verification is not on that list. These are official
financial reference rates, and unverified TLS on a government host is exactly the
case where a man-in-the-middle matters most.

The live tests in `test/integration/bog.live.test.ts` are written and correct, but
gated behind their own env var so the twice-weekly canary does not sit permanently
red on a defect nobody here can fix:

```bash
npm run test:live:bog
```

## What the upstream looks like

bog.gov.gh is WordPress, like gse.com.gh, but it differs in one useful way: it
exposes a working REST API at `/wp-json/wp/v2/`, with custom post types that line
up with several of these datasets.

| REST collection                        | Likely dataset                       |
| -------------------------------------- | ------------------------------------ |
| `/wp-json/wp/v2/gog_auction_results`   | GOG T-bill auction results           |
| `/wp-json/wp/v2/bog_auction_results`   | BOG bill auction results             |
| `/wp-json/wp/v2/daily_interest_rate`   | Interbank interest rates (daily)     |
| `/wp-json/wp/v2/avg_interest_rate`     | Interbank interest rates (averaged)  |
| `/wp-json/wp/v2/exchange_rates`        | Interbank FX rates                   |

This is a better index than scraping list pages — paginated, date-ordered, and no
nonce or cookie handshake of the kind gse.com.gh requires.

**But it is not a data API.** Probing it on 2026-07-25: `acf` comes back empty and
the figures live in `content.rendered` as an HTML table. So the REST API replaces
the *discovery* half of the GSE approach, not the *parsing* half. And
`exchange_rates` returned an empty array, so FX likely needs a different route.

No REST collection obviously corresponds to the treasury-bill or BOG-bill **rate**
series, so those may need the page itself.

## Implementing a dataset

The scaffolding is in place, so each dataset is a self-contained change:

1. Add the fetch to `BogClient`, replacing the `notImplemented` call. Go through
   `request()` from `lib/http` — never a bare `fetch` — so it inherits the
   User-Agent, timeout, retry policy and request logging.
2. Add a `parse…Payload` function to a new `sources/bog/parser.ts`, pure and
   testable, and save a real response under `test/fixtures/`.
3. Add the row schema to `sources/bog/types.ts`.
4. Swap the stub handler in `tools.ts` for a cached read via `readThrough`, and
   declare the `outputSchema` you now know.
5. Pick a cache key and TTL, and document them here.

The [GSE source](GSE.md#how-the-scrape-works) is the worked example, and
[CONTRIBUTING.md](../CONTRIBUTING.md) has the house rules.

Rate data has a natural TTL shape worth thinking about up front: T-bill rates
change weekly at auction, interbank FX daily, and the external-facilities listing
rarely. Caching a weekly series for 15 minutes would be pointless load on a
central bank's website.

## What the stubs do when called

Each returns an MCP error naming the dataset and its public URL:

```
Bank of Ghana treasury bill rates is not implemented yet. The data is published
at https://www.bog.gov.gh/treasury-and-the-markets/treasury-bill-rates/. This
server cannot retrieve it yet. Do not estimate these figures or recall them from
memory — they are financial data and a wrong number is worse than none. Tell the
user the tool is not implemented yet and refer them to the page above.
```

Two properties of that message are load-bearing, and both are covered by tests:

- **It is not an empty result.** Returning `rows: []` would read as "there is no
  such data", a different and false claim from "this server cannot fetch it".
- **It tells the model not to answer from memory.** These are interest and
  exchange rates; a plausible-looking figure recalled from training data is worse
  than a refusal, and a model that has just been told a tool failed is exactly when
  that temptation arises.

Descriptions are also prefixed `NOT YET AVAILABLE`, so a model reading the tool
list can skip them without spending a call to find out.
