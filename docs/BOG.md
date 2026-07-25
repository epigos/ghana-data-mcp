# Bank of Ghana (`bog_*`)

Treasury and money-market data published by the Bank of Ghana at
[bog.gov.gh](https://www.bog.gov.gh/treasury-and-the-markets/). Seven tools.

> **Status: stubs.** Every tool below is registered with its final input schema,
> but calling one returns an error. No Bank of Ghana data is available from this
> server yet.
>
> There is a certificate problem on BoG's server that stops the Workers runtime
> fetching it at all — see [TLS blocker](#blocker-bogs-tls-chain-is-incomplete).
> It has a safe local fix and does **not** block writing the parsers, but read it
> before starting.

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

### Not the answer: disabling certificate verification

Worth stating plainly, because it is the first thing that comes to mind:

- **On Workers it is not even available.** The runtime's `fetch()` has no
  equivalent of `rejectUnauthorized: false`. There is no flag to reach for.
- **It would be the wrong trade anyway.** These are official financial reference
  rates on a government host — precisely the case where a man-in-the-middle
  matters. "Trust anything" is a much bigger hole than the one being patched.

### Node and tests: fixed properly, today

Node can be unblocked without weakening anything, by *supplying* the certificate
BoG omits rather than by skipping the check. The leaf's own AIA extension names it:

```bash
curl -sO http://cacerts.digicert.com/DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt
openssl x509 -inform DER -in DigiCertGlobalG2TLSRSASHA2562020CA1-1.crt \
  -out bog-intermediate.pem -outform PEM
```

```bash
NODE_EXTRA_CA_CERTS=$PWD/bog-intermediate.pem BOG_LIVE=1 npm run test:live:bog
```

Verified 2026-07-25: without it, `UNABLE_TO_VERIFY_LEAF_SIGNATURE`; with it, HTTP
200 and all 13 live tests pass. Verification stays fully on — the intermediate is
the genuine DigiCert one, itself signed by a root Node already trusts, so this
completes the chain instead of ignoring it.

### Workers: still open

`NODE_EXTRA_CA_CERTS` has no counterpart in the Workers runtime, so this does not
help the deployed path. Two things could:

1. **Ask BoG to serve the intermediate.** A one-line web-server change that fixes
   every strict client, not just this one. This is the real fix.
2. **Check whether production already works.** Only the local `workerd` runtime was
   tested. Cloudflare's edge may resolve the chain where local does not — one
   deployed probe answers it:

   ```js
   export default { async fetch() {
     try { const r = await fetch("https://www.bog.gov.gh/treasury-and-the-markets/treasury-bill-rates/");
           return Response.json({ ok: r.ok, status: r.status }); }
     catch (e) { return Response.json({ error: String(e.message) }); }
   }};
   ```

Failing both, a proxy that completes the chain would work, at the cost of a hop and
a component to maintain.

### Meanwhile, this is not blocking

The blocker only affects the *last mile* — a live fetch from Workers. Everything
else can be built and tested now, because the architecture already separates them:
`parser.ts` is pure and tested against saved fixtures, so payloads captured with
`curl` (which works, since macOS completes the chain) are enough to write and verify
the whole parsing layer. When the certificate is fixed, live fetching starts
working and no parsing code changes.

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
series — and it turns out they do not need one.

### The rate pages are wpDataTables, like GSE

Fetching `/treasury-and-the-markets/treasury-bill-rates/` on 2026-07-25 shows the
current data already in the page HTML, in a `wpDataTable` — the same plugin
gse.com.gh uses, with `admin-ajax` and a nonce present. So the GSE playbook applies:
the first page comes free with the HTML, and the paginated history very likely comes
from the same `admin-ajax.php?action=get_wdtable` POST.

Columns, verbatim from the page:

| Issue Date  | Tender | Security Type | Discount Rate | Interest Rate |
| ----------- | ------ | ------------- | ------------- | ------------- |
| 20 Jul 2026 | 2016   | 364 DAY BILL  | 11.5008       | 12.9954       |
| 20 Jul 2026 | 2016   | 182 DAY BILL  | 7.3926        | 7.6763        |
| 20 Jul 2026 | 2016   | 91 DAY BILL   | 5.7020        | 5.7845        |

Two things to note before writing the parser:

- **The date format differs from GSE.** BoG writes `20 Jul 2026`, not `20/07/2026`,
  so `parseDayFirstDate` from the GSE parser does not apply. This needs its own
  month-name parser — and it should be strict, not `Date.parse`, for the same
  reason GSE's is.
- **Tenor is a string to be interpreted**, not a number: `364 DAY BILL`. Whether to
  expose it verbatim or as `{ tenorDays: 364 }` is a design call; a numeric field is
  far more useful for filtering, and unlike GSE's stated-capital column this one is
  regular enough to parse safely.

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
