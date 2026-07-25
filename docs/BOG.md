# Bank of Ghana (`bog_*`)

Treasury and money-market data published by the Bank of Ghana at
[bog.gov.gh](https://www.bog.gov.gh/treasury-and-the-markets/). Five tools.

> **Status: 4 of 5 implemented.** Everything except project administration and
> external facilities, which remains a registered stub — final input schema, but
> calling it returns an error.
>
> There is a certificate problem on BoG's server that stops the Workers runtime
> fetching it at all — see [TLS blocker](#blocker-bogs-tls-chain-is-incomplete).
> It has a safe local fix and does **not** block writing the parsers, but read it
> before starting.

- [Datasets and tools](#datasets-and-tools)
- [Blocker: BoG's TLS chain is incomplete](#blocker-bogs-tls-chain-is-incomplete)
- [What the upstream looks like](#what-the-upstream-looks-like)
  - [The rate pages are wpDataTables](#the-rate-pages-are-wpdatatables-after-all)
  - [The tables, surveyed](#the-tables-surveyed)
  - [The auction results are PDFs (out of scope)](#the-auction-results-are-pdfs)
  - [The REST API carries no figures](#the-rest-api-carries-no-figures)
- [Implementing a dataset](#implementing-a-dataset)
- [What the stubs do when called](#what-the-stubs-do-when-called)

## Datasets and tools

One tool per dataset in BoG's Treasury and the Markets section. All seven page
URLs were fetched and returned HTTP 200 on 2026-07-25.

| Tool                                   | Dataset                                  | Status |
| -------------------------------------- | ---------------------------------------- | ------ |
| `bog_get_interbank_fx_rates`           | Daily Interbank FX Rates                 | **live** |
| `bog_get_treasury_bill_rates`          | Treasury Bill Rate                       | **live** |
| `bog_get_central_bank_bill_rates`      | Bank of Ghana Bill Rates                 | **live** |
| `bog_get_interbank_interest_rates`     | Interbank Interest Rates                 | **live** |
| `bog_list_external_facilities`         | Project Administration & External Facilities | stub |

Page URLs are in `BOG_PAGES` in `src/sources/bog/client.ts`.

**Not covered:** the two weekly auction-result datasets (GOG T-Bill and BOG Bill).
BoG publishes those only as [one PDF per tender](#the-auction-results-are-pdfs), and
extracting tables from PDFs inside a Worker is a different and much larger job than
parsing HTML. Excluded deliberately rather than left as a stub, so the tool list does
not advertise something nobody intends to build.

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
| `bog_get_interbank_fx_rates`           | `currency` only — **no date window**, see below   |
| Bill rates                             | `days` (default 90, max 7300) plus `securityType` |
| `bog_get_interbank_interest_rates`     | `days`, plus `series` — one of four               |
| `bog_get_interbank_interest_rates`     | plus `frequency` — `daily` or `weekly`            |
| `bog_list_external_facilities`         | `refresh`                                         |

### Outputs

The four implemented tools declare a full `outputSchema`. The remaining stub declares
none: their row shapes land with each implementation, once the real payload is in
hand. Publishing a guessed schema would invite callers to code against fields that
may not survive contact with the data — worse than publishing nothing.

## Implemented tools

### `bog_get_interbank_fx_rates`

Bank of Ghana interbank reference rates for the cedi, for the most recently
published day. Nineteen currencies, each with bid, offer and mid.

| Input      | Type   | Notes                                                                     |
| ---------- | ------ | ------------------------------------------------------------------------- |
| `currency` | string | Code (`USD`) or published name (`US Dollar`). Omit for all 19.             |
| `days`     | number | Calendar days of history. Omit for just the latest published day. Max 7300. |

```json
{
  "date": "2026-07-24",
  "currency": "US Dollar",
  "code": "USD",
  "pair": "USDGHS",
  "bid": 11.6292,
  "offer": 11.6408,
  "mid": 11.635
}
```

Rates are **cedis per unit of the foreign currency**, and these are the official
interbank reference rates — not retail or forex-bureau rates, which are usually
worse and differ by provider. Quote `mid` if only one number is wanted.

Coverage goes beyond the majors: alongside USD, GBP, EUR, CHF, JPY and CNY it
carries Naira, Leone, Dalasi, Ouguiya, and the BCEAO and ECOWAS units — which
matter more than the majors for some questions and are easy to lose to a parser
that assumes ISO majors only.

**History comes from a different table.** Without `days`, the tool reads table 31,
which BoG pins to the latest publication — the robust way to answer "what is the rate
today" across weekends and holidays. With `days`, it reads table 40 on the
`historical-interbank-fx-rates` page, which holds the whole series: 144,457 rows back
to **02 Jan 1996**, and does accept a date range.

Rows come back **oldest first**, and `date` reports the newest row in the result.

**Pass a `currency` with long windows.** The unfiltered table is about 4,700 rows a
year across 19 currencies, and a Worker on the free tier has a 10ms CPU budget. A
currency filter is pushed upstream and cuts the payload 19-fold. It only works for
codes — `USD` becomes `USDGHS` — because that search matches whole values exactly, the
same trap as the bill tables. A currency *name* cannot be resolved to a pair, so those
windows are fetched whole and narrowed in memory. Results are capped at 20,000 rows and
`meta.warning` says so if the cap bites.

### ⚠️ The series crosses Ghana's 2007 redenomination

On **1 July 2007** the cedi was redenominated: 10,000 old cedis (GHC) became 1 new
cedi (GHS). **BoG's historical series runs straight through it without adjusting**, so
a long window mixes two units:

| Date       | USD mid  | Unit       |
| ---------- | -------- | ---------- |
| 2006-07-31 | 9166.18  | old cedis  |
| 2026-07-24 | 11.635   | new cedis  |

Unflagged, that reads as a currency collapse rather than an arithmetic change. The tool
detects any window reaching before that date and says so in `meta.warning`; a good
answer never charts or computes a change across the boundary without converting.

Caching: the latest-day snapshot is held one hour under `bog:interbank-fx:v1`, and each
historical window is held 12 hours under
`bog:interbank-fx-history:v1:{days}:{pair|all}` — a past window does not change.

#### Sample chat queries

> **What's the cedi trading at against the dollar?**

Returns `USD` with bid/offer/mid. A good answer quotes the mid and says it is the
BoG interbank reference rate, not a rate anyone would get at a bureau.

> **Show me all the Bank of Ghana interbank FX rates.**

All 19 currencies for the latest published date.

> **How has the cedi moved against the pound this month?**

`currency: "GBP", days: 30`. About 21 rows, oldest first.

> **Chart USD/GHS over the last ten years.**

`currency: "USD", days: 3650` — 2,475 rows, from 3.9463 in July 2016 to 11.635 in
July 2026. A useful reminder that the answer should quote the window, not just the
endpoints.

> **What has the cedi done against the dollar over the last twenty years?**

The one to watch. `days: 7300` reaches 2006, before the redenomination, so the series
opens at 9166.18 and the tool attaches a `meta.warning`. A correct answer explains the
10,000-to-1 change instead of reporting a collapse.

> **What's the cedi worth in Naira?**

Tests the non-major coverage: `NGN`-side rates are published under `Naira`.

### `bog_get_treasury_bill_rates` and `bog_get_central_bank_bill_rates`

Two series with one shape. **Treasury** is Government of Ghana issuance (table 2,
1355 rows back to 2013); **central bank** is what the Bank of Ghana issues itself
(table 3, 585 rows back to 2016, typically 14-day). They are not interchangeable and
a caller asking for one never gets the other.

| Input          | Type   | Notes                                                              |
| -------------- | ------ | ------------------------------------------------------------------ |
| `days`         | number | Calendar days back. Default 90, max 7300 — see coverage below.      |
| `securityType` | string | Matched leniently: `91`, `91 DAY` and `91 DAY BILL` all work.       |

Rows come back oldest first:

```json
{
  "date": "2026-07-20",
  "tenderNumber": "2016",
  "securityType": "91 DAY BILL",
  "tenorDays": 91,
  "discountRate": 5.702,
  "interestRate": 5.7845
}
```

Real output for the 60 days to 2026-07-25 — 24 rows, three securities per weekly
tender:

```
2026-07-13  tender 2015  182 DAY BILL   discount 7.4965   interest 7.7884
2026-07-13  tender 2015  364 DAY BILL   discount 11.4978  interest 12.9915
2026-07-13  tender 2015  91 DAY BILL    discount 5.777    interest 5.8617
2026-07-20  tender 2016  182 DAY BILL   discount 7.3926   interest 7.6763
2026-07-20  tender 2016  364 DAY BILL   discount 11.5008  interest 12.9954
2026-07-20  tender 2016  91 DAY BILL    discount 5.702    interest 5.7845
```

Three things worth knowing:

- **It is not only bills.** The same table carries longer securities — a 2020 window
  returns `2 YR FXR NOTE` and `3`, `5`, `6` and `7 YR FXR BOND` alongside the bills.
  `securityType` is verbatim so nothing is lost.
- **`tenorDays` is absent for anything quoted in years.** Converting `2 YR` to days
  would invent precision BoG does not publish; a two-year note is not exactly 730
  days and nothing here knows its real maturity.
- **`tenderNumber` is an identifier, not a quantity.** It arrives with thousands
  separators (`1,517`), which are stripped so a caller matching the string does not
  have to guess.

**Coverage.** `days` goes up to 7300 (20 years), which is what it takes to reach the
start of the data: the Treasury table begins 26 Aug 2013 and holds 1355 rows across
13 security types. A shorter ceiling hides most of that — a 5-year window returns 758
rows and only 7 types.

Cached for 12 hours per `days` window — rates are set at weekly tenders, so hitting a
central bank's site more often than that would be rude for no gain. The window is
cached unfiltered, so asking for one tenor after another does not re-scrape.

#### Sample chat queries

> **What's the current 91-day Treasury bill rate in Ghana?**

`securityType: "91"` is enough. The answer to quote is `interestRate` — the yield —
with `discountRate` alongside if the distinction matters.

> **How have Ghana's 364-day T-bill yields moved over the past year?**

`days: 365, securityType: "364"`. About 52 rows, one per weekly tender.

> **Compare the 91, 182 and 364-day rates from the latest tender.**

One call with no `securityType`; the model reads the last three rows, which share a
tender number.

> **What rate does the Bank of Ghana pay on its own bills?**

`bog_get_central_bank_bill_rates`. Worth keeping in the set because BoG's issuance
is intermittent — the most recent as of 2026-07-25 was 16 March — so a 90-day window
can legitimately come back empty, and the honest answer widens the window rather
than reporting no such data.

> **Did Ghana issue any bonds in 2020?**

`days` reaching back to 2020 surfaces the FXR notes and bonds, showing the table is
broader than its name.

> **What was the 7-year bond rate when Ghana last issued one?**

`securityType: "7 YR"` with a long window. The most recent as of 2026-07-25 was
26 Aug 2013 at 17.5% — a good check that the model reports the date rather than
implying the rate is current.

### `bog_get_interbank_interest_rates`

Four separate money-market series, one page, one table each.

| Input    | Type   | Notes                                                          |
| -------- | ------ | -------------------------------------------------------------- |
| `series` | enum   | `daily`, `weekly`, `reverse-repo`, `depo`. Default `daily`.      |
| `days`   | number | Calendar days back. Default 90, max 7300.                      |

```json
{ "date": "2026-07-24", "rate": 10.23 }
```

Real coverage on 2026-07-25:

| `series`       | BoG's label            | Table | Rows | Span                  | Latest |
| -------------- | ---------------------- | ----- | ---- | --------------------- | ------ |
| `daily`        | Daily Interest Rates   | 69    | 1712 | 2019-08-05 → 2026-07-24 | 10.23  |
| `weekly`       | Weekly Interest Rates  | 70    | 362  | 2019-07-26 → 2026-07-24 | 10.23  |
| `reverse-repo` | Reverse Repo Rates     | 62    | 117  | 2002-11-21 → 2026-07-22 | 15.00  |
| `depo`         | Depo Rates             | 63    | 117  | 2002-11-21 → 2026-07-22 | 13.00  |

`daily` and `weekly` are the interbank weighted average — the rate banks actually lend
to each other at — the second being the first averaged over a week, and dated by week
ending rather than effective date. `reverse-repo` and `depo` are BoG's standing
facility rates, which sit either side of the Monetary Policy Committee's policy rate:
15.00 and 13.00 around a 14.00 policy rate as of 2026-07-25.

**This is not the MPC policy rate.** BoG publishes that separately and this server does
not cover it. A question about "Ghana's interest rate" most often means the policy rate,
so the honest answer names which of these it is quoting.

Three implementation notes:

- **The window is applied in memory.** Alone among BoG's tables, these four reject a
  date-range search: a range returns `recordsFiltered: 3` with zero rows. So the fetch
  takes the whole series — 1712 rows at most, against 144,457 for the FX table — and
  narrows it here. One cache entry per series therefore answers every `days`.
- **`skippedRows: 2` is normal for `reverse-repo` and `depo`.** Both carry two rows with
  no effective date. A rate that cannot be placed on a timeline is not usable, so it is
  dropped and counted rather than silently included.
- **Column names differ per series**, because each table is built over a different
  JetEngine post type and wpDataTables rejects a mismatched query. The two MPC-derived
  series share their column names exactly, so those cannot tell them apart — the
  labels come from DOM containment instead.

#### Sample chat queries

> **What's the interbank interest rate in Ghana right now?**

Default series, short window. The answer should say it is the interbank weighted
average, not the policy rate.

> **How has Ghana's interbank rate moved over the past year?**

`days: 365`. About 250 points on the daily series, or 52 on the weekly.

> **What's the gap between the Bank of Ghana's reverse repo and depo rates?**

Two calls. On 2026-07-25: 15.00 and 13.00, a two-point corridor around the 14.00 policy
rate. A good check that the model does not present either as *the* policy rate.

> **When did Ghana's reverse repo rate peak?**

`series: "reverse-repo", days: 7300` reaches 2002. Also exercises the undated-row
handling, since `meta.skippedRows` will be 2.

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

The blocker only affects the *last mile* — a live fetch from Workers. The parsing
layer can be written and verified now, because the architecture already separates
them: `parser.ts` is pure and fixture-tested, and payloads captured with `curl`
(which works, since macOS completes the chain) are enough. When the certificate is
fixed, live fetching starts working and no parsing code changes.

## What the upstream looks like

Surveyed on 2026-07-25. The seven datasets are **not** published the same way, and
the differences decide how much work each one is.

| Dataset                  | Where the figures actually are                          | Difficulty |
| ------------------------ | ------------------------------------------------------- | ---------- |
| Treasury bill rates      | HTML table in the page — ~10 most recent rows           | easy       |
| BOG bill rates           | HTML table in the page                                  | easy       |
| Interbank interest rates | HTML table in the page                                  | easy       |
| Interbank FX rates       | Only a weighted average/median summary is in the page    | unclear    |
| GOG T-bill auctions      | **A PDF per tender**                                    | hard       |
| BOG bill auctions        | Very likely a PDF per tender too                        | hard       |
| External facilities      | No table and no PDF in the page — mechanism unknown     | unclear    |

### The rate pages are wpDataTables after all

An earlier revision of this file concluded the GSE playbook did not transfer,
because the pages have no `wdtNonceFrontendEdit_<id>` input. That was the wrong
thing to look for. **bog.gov.gh exposes its nonce as
`wdtNonceFrontendServerSide_<id>`**, and with that name every rate page turns out
to be a server-side wpDataTable queryable exactly like GSE's:

```
GET  /treasury-and-the-markets/daily-interbank-fx-rates/   → wdtNonceFrontendServerSide_31
POST /wp-admin/admin-ajax.php?action=get_wdtable&table_id=31
```

Looking for the wrong input name fails in the most misleading way available — it
looks precisely like "there is no table here".

One genuine difference from GSE: **no cookie is required.** The POST succeeds on the
nonce alone, verified by issuing it both with and without the `PHPSESSID` the page
hands out. The cookie is still forwarded when offered, but is not treated as
mandatory the way GSE's `__cf_bm` is.

#### The tables, surveyed

Every table on every rate page was queried on 2026-07-25:

| Page                     | Table | Series                   | Rows | Span        |
| ------------------------ | ----- | ------------------------ | ---- | ----------- |
| treasury-bill-rates      | 2     | GOG bills and bonds      | 1355 | 2013 → 2026 |
| bank-of-ghana-bill-rates | 3     | BOG bills and bonds      | 585  | 2016 → 2026 |
| daily-interbank-fx-rates | 31    | Per-currency bid/offer/mid | 19 | latest day only |
| daily-interbank-fx-rates | 32    | Weighted-median summary  | 1    | one cell    |
| historical-interbank-fx-rates | 40 | Per-currency bid/offer/mid | 144457 | 1996 → 2026 |
| interbank-interest-rates | 69    | Daily Interest Rates     | 1712 | 2019 → 2026 |
| interbank-interest-rates | 70    | Weekly Interest Rates    | 362  | 2019 → 2026 |
| interbank-interest-rates | 62    | Reverse Repo Rates       | 119  | 2002 → 2026 |
| interbank-interest-rates | 63    | Depo Rates               | 119  | 2002 → 2026 |

The four interbank series carry no label in the table config, but the mapping is
**confirmed, not inferred**. Each Jet-tabs panel declares a `data-tab` index matching
its control, and each panel contains exactly one table, read from the live DOM on
2026-07-25:

| Panel | Tab label             | Table |
| ----- | --------------------- | ----- |
| 1     | Daily Interest Rates  | 69    |
| 2     | Weekly Interest Rates | 70    |
| 3     | Reverse Repo Rates    | 62    |
| 4     | Depo Rates            | 63    |

The data agrees: reverse repo at 15.00 sits above depo at 13.00, straddling the 14.00
policy rate.

So **history is available** for the bill rates and the interbank series: 1355 rows
back to 2013 in one request. Those three datasets need no further discovery work.

#### The FX snapshot table is latest-date-only — but there is a second table

Table 31 answers an *unfiltered* query with `recordsTotal: 144457,
recordsFiltered: 19`. A filter that narrow with no search supplied means the table's
own definition restricts it to the latest date; `length=-1` still returns 19, and
date-range searches on its date column return zero rows.

An earlier revision of this file concluded from that BoG publishes no FX history. It
does — on a **different page**, `/treasury-and-the-markets/historical-interbank-fx-rates/`,
as **table 40**. Same six columns, the full 144,457 rows back to 02 Jan 1996, and a
working date-range filter. The `recordsTotal` was the clue: table 31 could see all
144,457 rows and was choosing to return 19 of them.

Both are used, for different questions — see
[`bog_get_interbank_fx_rates`](#bog_get_interbank_fx_rates).

#### Two parsing differences from GSE

- **Dates are `24 Jul 2026`**, not `24/07/2026` — the page's own table config says
  `dd M yy`. `parseBogDate` handles month names and deliberately rejects the slash
  format rather than half-reading it.
- **Tenor is a string to interpret**: `364 DAY BILL`. Regular enough to parse into
  `{ tenorDays: 364 }` when the bill-rate tools land, unlike GSE's stated-capital
  column.

### The auction results are PDFs

Each weekly tender is its own post whose page contains no table — just a link to a
PDF:

```
https://www.bog.gov.gh/wp-content/uploads/2026/07/Auctresults-2017.pdf
```

Extracting tabular figures from PDFs inside a Cloudflare Worker means bundling a
text-extraction library inside the size limit and reconstructing tables from
positioned text runs, which is fragile in a way HTML parsing is not. So these two
datasets are **out of scope** and have no tools.

Most of what a caller would want from them is available anyway: the rate series that
each auction sets is exactly what `bog_get_treasury_bill_rates` and
`bog_get_central_bank_bill_rates` return, including the tender number. What the PDFs
add is amounts tendered and accepted — demand, rather than price.

### The REST API carries no figures

Worth recording so nobody re-investigates: `/wp-json/wp/v2/` is open and exposes
custom post types that look promising — `gog_auction_results`, `bog_auction_results`,
`daily_interest_rate`, `avg_interest_rate`, `exchange_rates`. None of them carry data.

- **`content.rendered` is empty** — zero bytes, verified on `daily_interest_rate` and
  `gog_auction_results`. Not "HTML to parse".
- **`acf` is empty and `meta` holds only analytics keys.** The values live in
  JetEngine post meta, which is not registered for REST exposure.
- **`exchange_rates` returns an empty array.**
- **There is no BoG data API.** All 18 namespaces were enumerated; every custom one
  belongs to a third-party plugin (Elementor, JetEngine, Contact Form 7, analytics).

The wpDataTables route above is strictly better for everything still in scope.

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
