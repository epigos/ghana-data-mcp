# Bank of Ghana (`bog_*`)

Treasury and money-market data published by the Bank of Ghana at
[bog.gov.gh](https://www.bog.gov.gh/treasury-and-the-markets/). Four tools, all
read-only.

Figures in this document were captured on **2026-07-25** and show the shape of a
response, not current market data.

Running the server and connecting a client are covered once in the
[README](../README.md#connecting-an-mcp-client).

- [Tools](#tools)
  - [`bog_get_interbank_fx_rates`](#bog_get_interbank_fx_rates)
  - [Bill rates](#bog_get_treasury_bill_rates-and-bog_get_central_bank_bill_rates)
  - [`bog_get_interbank_interest_rates`](#bog_get_interbank_interest_rates)
- [How the data is published](#how-the-data-is-published)

## Tools

| Tool | Dataset | Coverage |
| ---- | ------- | -------- |
| `bog_get_interbank_fx_rates` | Interbank FX rates | Latest day, or history to 1996 |
| `bog_get_treasury_bill_rates` | Treasury bill, note and bond rates | Back to 2013 |
| `bog_get_central_bank_bill_rates` | Bank of Ghana bill rates | Back to 2016 |
| `bog_get_interbank_interest_rates` | Interbank money-market rates | Back to 2002 |

Two pairs are easy to confuse, and picking the wrong one answers a different question:

- **Treasury vs central bank.** `treasury` means Government of Ghana securities;
  `central_bank` means bills the Bank of Ghana issues itself. BoG publishes these as
  separate series and so do we.
- **Interbank FX vs interbank interest.** The first is exchange rates, the second is
  the rate banks lend cedis to each other at.

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

## How the data is published

Everything here comes from BoG's own wpDataTables endpoints, surveyed on 2026-07-25.
Two of BoG's treasury datasets — the weekly GOG and BOG auction results — are not
covered, because BoG publishes those only as one PDF per tender. The rate series each
auction sets is covered by the bill-rate tools regardless; what the PDFs add is amounts
tendered and accepted.

### The pages are wpDataTables

bog.gov.gh runs the same wpDataTables plugin as gse.com.gh, and exposes its nonce as
`wdtNonceFrontendServerSide_<id>` — a different input name from GSE's
`wdtNonceFrontendEdit_<id>`, which is worth knowing because looking for the wrong one
fails in the most misleading way available: it looks exactly like "there is no table
here".

```
GET  /treasury-and-the-markets/daily-interbank-fx-rates/   → wdtNonceFrontendServerSide_31
POST /wp-admin/admin-ajax.php?action=get_wdtable&table_id=31
```

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

#### FX lives in two tables

Table 31 answers an *unfiltered* query with `recordsTotal: 144457,
recordsFiltered: 19`. A filter that narrow with no search supplied means the table's
own definition restricts it to the latest date; `length=-1` still returns 19, and
date-range searches on its date column return zero rows.

The history is on a **different page**,
`/treasury-and-the-markets/historical-interbank-fx-rates/`, as **table 40**: same six
columns, the full 144,457 rows back to 02 Jan 1996, and a working date-range filter.

Both are used, for different questions — see
[`bog_get_interbank_fx_rates`](#bog_get_interbank_fx_rates).

#### Two parsing differences from GSE

- **Dates are `24 Jul 2026`**, not `24/07/2026` — the page's own table config says
  `dd M yy`. `parseBogDate` handles month names and deliberately rejects the slash
  format rather than half-reading it.
- **Tenor is a string to interpret**: `364 DAY BILL`. Regular enough to parse into
  `{ tenorDays: 364 }` when the bill-rate tools land, unlike GSE's stated-capital
  column.
