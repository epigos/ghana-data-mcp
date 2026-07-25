# Ghana Stock Exchange (`gse_*`)

Share prices, the listed-company directory, market-wide index history, and the
fixed-income issuer list — scraped from [gse.com.gh](https://gse.com.gh). Six
tools, all read-only.

Figures in this document were captured on **2026-07-25** and are there to show
the shape of a response, not as current market data.

- [Setup](#setup)
- [Sample chat queries](#sample-chat-queries)
- [Tool reference](#tool-reference)
- [Reading the data correctly](#reading-the-data-correctly)
- [Knowing whether the data is fresh](#knowing-whether-the-data-is-fresh)
- [Troubleshooting](#troubleshooting)
- [Symbol reference](#symbol-reference)
- [How the scrape works](#how-the-scrape-works)

## Setup

Start the server (see the [README](../README.md#quick-start) for install), then
connect a client.

**Claude Code**

```bash
claude mcp add --transport http ghana-data http://localhost:8787/mcp
```

**Claude Desktop** — in `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ghana-data": {
      "type": "http",
      "url": "http://localhost:8787/mcp"
    }
  }
}
```

Swap the URL for your `workers.dev` URL once deployed. No API key, no auth — the
data is public.

Confirm the connection with a question that needs no scraping:

> Use the ping tool on the ghana-data server.

## Sample chat queries

These are worth running after any change to the source — together they exercise
every tool, the fuzzy search, the cache, and the awkward data cases.

### Getting oriented

> **What companies can I look up on the Ghana Stock Exchange?**

Calls `gse_list_companies`. Expect 40 companies: 34 Main Market, 5 Ghana
Alternative Market, 1 ETF.

> **Which companies trade on the Ghana Alternative Market?**

Calls `gse_list_companies` with `market: "gax"`. Expect exactly five: `DIGICUT`,
`HORDS`, `IIL`, `MMH`, `SAMBA`.

> **Are there any ETFs on the GSE?**

`market: "etf"` — one, `GLD` (NewGold Issuer Ltd.).

> **What's the ticker for Standard Chartered in Ghana?**

Calls `gse_search_company`. Returns `SCB` at 0.98, and `SCB PREF` further down —
the preference listing. `SCB` is the one you want for prices; see
[Troubleshooting](#troubleshooting) for why `SCB PREF` returns nothing.

### Price history

> **How has MTN Ghana's share price moved over the last month?**

Two calls: `gse_search_company("MTN")` resolves `MTNGH`, then
`gse_get_stock_history`. Expect ~21 rows for 30 calendar days — GSE publishes one
row per trading day, so a month is about 21, not 30.

> **Give me GCB Bank's closing prices for the last 90 days.**

`gse_get_stock_history` with `symbol: "GCB"`. The default `days` is 90 if you
don't say.

> **What did MTN Ghana close at on its most recent trading day?**

One row is enough, but the tool always returns the window — the model should read
the last element, since rows are **oldest first**.

### Comparison and analysis

> **Compare GCB, Ecobank Ghana and TotalEnergies over the last 30 days. Which
> performed best?**

Three `gse_get_stock_history` calls. On 2026-07-25 this gave roughly +10.8%,
+13.8% and +11.1% — Ecobank ahead. A good test that the model reads `close` from
the first and last rows rather than trusting `high`/`low`.

> **Which of the banks listed on the GSE had the highest trading volume yesterday?**

Needs the directory plus one history call per bank, so it is the most expensive
query here — a reasonable check that the cache is working, since a second run
should be near-instant and log no HTTP requests.

> **Has MTN Ghana traded near its 52-week high recently?**

Tests whether the model correctly reads `high` as the *annual* high rather than
the day's. On 2026-07-25, `MTNGH` closed at 7.00 against a year high of 7.00 and
a year low of 4.20.

### Company facts

> **When did First Atlantic Bank list on the GSE, and what's its share code?**

`gse_search_company("first atlantic")` → `FAB`, listed 2025-12-19. Worth keeping
in the set: `FAB` is a recent listing that the built-in fallback list does not
contain, so if this one comes back empty the live directory scrape has broken and
the seed is being served.

> **What's AngloGold Ashanti's stated capital?**

Returns `ZAR 4,899,021,716.98` — a South African rand figure on a Ghanaian
exchange. The model should quote it verbatim, currency included, and not convert
or compute with it. See [free-text fields](#the-capital-and-share-count-fields-are-free-text).

> **Which GSE companies listed before 2000?**

`gse_list_companies` and filter on `dateListed`. Note that nine of the forty rows
have no listing date at all, so the honest answer mentions the gap.

### The market as a whole

> **How is the Ghanaian stock market doing overall this month?**

Calls `gse_get_market_index` — not `gse_get_stock_history`, which only covers one
company. Over the 21 sessions to 2026-07-24 the GSE Composite Index went
14,744.72 → 15,330.57, about +4.0%.

> **What's the total market capitalisation of the GSE?**

Same tool, latest row. On 2026-07-24: `marketCapGhsMillion: 292058.49` — that is
GHS **292 billion**, since the figure is in millions. A good check that the model
reads the unit off the field name rather than reporting "292,058".

> **Has the Financial Stock Index moved with the main index this year?**

`gse_get_market_index` with a longer `days`. Both series come from the same rows,
so this needs one call, not two.

### Fixed income

> **Which companies have issued bonds on the Ghana Fixed Income Market?**

Calls `gse_list_fixed_income_issuers`. Expect 14 issuers. These are debt issuers
with no share code — a model that tries to follow up with
`gse_get_stock_history` for one of them has misread the tool.

> **Who has raised the most on GFIM, and over how many tranches?**

Same call, sorted on `amountRaisedGhsMillion`. On 2026-07-25: ESLA Plc at GHS
10,500m over 6 tranches, then Ghana Cocoa Board at GHS 3,289.56m over 3.

> **Is Ghana Cocoa Board listed on the stock exchange?**

A useful trap. It appears in `gse_list_fixed_income_issuers` but *not* in
`gse_list_companies` — it has listed debt, not equity. The correct answer draws
that distinction rather than saying yes or no.

## Tool reference

### `gse_get_stock_history`

Daily price history for one share code, **oldest first**.

| Input    | Type   | Notes                                            |
| -------- | ------ | ------------------------------------------------ |
| `symbol` | string | GSE share code, e.g. `MTNGH`. Case-insensitive.  |
| `days`   | number | Calendar days back. Default 90, max 1825.        |

Each row:

```json
{
  "date": "2026-07-24",
  "symbol": "MTNGH",
  "high": 7,
  "low": 4.2,
  "open": 6.98,
  "close": 7,
  "change": 0.02,
  "volume": 903387
}
```

| Field    | Meaning                                                              |
| -------- | -------------------------------------------------------------------- |
| `date`   | Trading date, ISO 8601                                               |
| `high`   | **Year** high (rolling 52-week), GHS — *not* the day's high           |
| `low`    | **Year** low (rolling 52-week), GHS — *not* the day's low             |
| `open`   | Opening price that day, GHS                                          |
| `close`  | Closing price that day (VWAP), GHS                                   |
| `change` | Change against the previous close, GHS. Negative when the price fell |
| `volume` | Shares traded that day. `0` means quoted but untraded                |

`days` is a *calendar* window, so expect about 21 rows for 30 days.

### `gse_list_companies`

| Input     | Type    | Notes                                          |
| --------- | ------- | ---------------------------------------------- |
| `market`  | enum    | `main`, `gax`, or `etf`. Omit for all three.   |
| `refresh` | boolean | Bypass the 7-day cache. Rarely needed.         |

```json
{
  "symbol": "AGA",
  "name": "AngloGold Ashanti Plc",
  "market": "main",
  "dateListed": "2004-04-27",
  "statedCapital": "ZAR 4,899,021,716.98",
  "issuedShares": "417,339,100 (Ordinary Shares)",
  "authorisedShares": "600.000.000"
}
```

Everything after `market` is optional and absent when GSE publishes nothing.

### `gse_search_company`

| Input   | Type   | Notes                                        |
| ------- | ------ | -------------------------------------------- |
| `query` | string | Name, partial name, or share code.           |
| `limit` | number | Max matches, 1–30. Default 10.               |

Returns matches with a `score` from 0 to 1. An exact share code scores 1.0, a
known shorthand 0.98, a name word 0.85, and the fuzzy fallback below 0.5 — so a
low score is a hint the match is a guess.

Handled shorthands include `MTN`, `stanchart`, `gcb bank`, `socgen`, `newgold`
and `first atlantic`.

### `gse_get_market_index`

Market-wide daily statistics, **oldest first**. Use this for the market as a
whole; `gse_get_stock_history` is per-company.

| Input  | Type   | Notes                                     |
| ------ | ------ | ----------------------------------------- |
| `days` | number | Calendar days back. Default 90, max 1825.  |

```json
{
  "date": "2026-07-24",
  "volume": 3210763,
  "compositeIndex": 15330.57,
  "marketCapGhsMillion": 292058.49,
  "financialStockIndex": 8281.03
}
```

| Field                 | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `volume`              | Shares traded across the whole exchange that day               |
| `compositeIndex`      | GSE Composite Index (GSE-CI) closing level                     |
| `marketCapGhsMillion` | Total market cap in **millions** of GHS. 292058.49 = GHS 292bn |
| `financialStockIndex` | GSE Financial Stock Index (GSE-FSI) closing level              |

Unlike the company table's capital columns, these are clean numbers with the unit
declared in the column header, so they are parsed rather than passed through as
text.

### `gse_list_fixed_income_issuers`

Corporate issuers admitted to the **Ghana Fixed Income Market** (GFIM). This is
debt, not equity: these issuers have no share code, no price history, and they do
not appear in `gse_list_companies`.

| Input     | Type    | Notes                                  |
| --------- | ------- | -------------------------------------- |
| `refresh` | boolean | Bypass the 7-day cache. Rarely needed. |

```json
{
  "name": "ESLA Plc",
  "admittedYear": 2017,
  "tranches": 6,
  "amountRaisedGhsMillion": 10500,
  "shelfRegistrationGhsMillion": 10500
}
```

Everything after `name` is optional. `admittedYear` is a year only — GSE does not
publish a full admission date — and is omitted when the value is not a plausible
year. Both amounts are in **millions** of GHS.

### `ping`

No input. Returns `{ ok, server, version }`. For checking connectivity.

## Reading the data correctly

Three things about GSE's published data will mislead a reader who assumes the
obvious. The tool schemas carry these warnings too, so a model reading the tool
definition should get them right — these queries are how you check that it does.

### `high` and `low` are annual, not daily

They are GSE's **Year High** and **Year Low** columns — rolling 52-week extremes.
GSE does not publish an intraday range anywhere, so there is nothing else to map
them to. They barely change from row to row, which is the giveaway.

They are also not always consistent with `close`: on 2026-07-25 the `GLD` ETF
closed at 462.39 against a reported year low of 466.72 — below its own floor.
Treat them as indicative, not as bounds.

### A row does not mean a trade

GSE publishes a row for every listed security on every trading day, whether or
not it changed hands. `volume: 0` means quoted but untraded. Over 30 days to
2026-07-25, `TBL` had 21 rows and **every one** had zero volume.

So "how many days did it trade?" is `rows.filter(r => r.volume > 0).length`, not
`rows.length`, and a volume ranking must exclude the zeroes or it will report
ties at nothing.

### The capital and share-count fields are free text

`statedCapital`, `issuedShares` and `authorisedShares` are strings, passed
through exactly as GSE stores them, and they must not be parsed into numbers.
Real values from one scrape:

| Value                                              | Problem                          |
| -------------------------------------------------- | -------------------------------- |
| `ZAR 4,899,021,716.98`, `US$867,714,000`, `DALASIS 200,000,000` | Five different currencies |
| `2.9 million` next to `118,093,134`                | Mixed units                      |
| `600.000.000`                                      | Dots as thousands separators     |
| `Pre-Listing: GHS40,000 Post-Listing: GHS616,730,000.00` | Prose                      |
| `GHS400milliion`, `GH(`                            | Typos in the source              |

Any parser confident enough to turn those into numbers would be wrong by a factor
of a million on some rows. Quoting the text is the honest option.

## Knowing whether the data is fresh

Every result carries a `meta` block:

```json
{ "origin": "live", "ageSeconds": 0, "skippedRows": 0 }
```

| `origin`      | Means                                                                |
| ------------- | -------------------------------------------------------------------- |
| `live`        | Just scraped from gse.com.gh                                         |
| `cache`       | A fresh cached copy; `ageSeconds` says how old                       |
| `stale-cache` | The scrape failed, so an expired copy was served. `meta.warning` says why |
| `static-seed` | The directory scrape failed entirely; built-in fallback list         |

`stale-cache` and `static-seed` always set `meta.warning`, and a good answer
passes that on to the user rather than presenting the numbers as current.

To see the difference yourself, ask the same price question twice — the first
answer is `live`, the second `cache`, and the server logs no HTTP request for the
second.

## Troubleshooting

**A price query returns no rows.** Two different causes, and the `warning` text
does not distinguish them:

- *Wrong share code.* `MTN` is not a code — `MTNGH` is. Resolve names through
  `gse_search_company` first.
- *It genuinely did not trade.* `SWL` returned zero rows over 30 days to
  2026-07-25. Widen `days` before concluding the code is wrong.

**`SCB PREF` never returns prices.** The preference listing is in the directory
and has a row in the price table, but its price fields are empty, so the row is
dropped and `meta.skippedRows` reports it. This is missing data upstream, not a
bug. Use `SCB` for Standard Chartered prices.

**A company you know exists is not in the directory.** It may be a *debt* issuer
rather than a listed equity. Ghana Cocoa Board and ESLA Plc, for instance, appear
only in `gse_list_fixed_income_issuers` — they have listed bonds, no shares, and so
no share code and no price history.

**Results are labelled `static-seed`.** The live directory scrape failed and you
are seeing the built-in fallback — 32 Main Market companies as of 2026-07-25, with
no GAX companies and no ETFs. `meta.warning` carries the reason. If this persists,
gse.com.gh has likely changed: run `npm run test:live` to find out which
assumption broke.

**A whole board is missing.** If the GAX or ETF table fails while the Main Market
one succeeds, you get a partial directory plus a warning naming the missing board.
That is deliberate — a directory short five rows beats no directory.

**Everything is slow the first time.** A cold cache means a page fetch plus a POST
per table. Once warm, repeats are served from KV for 7 days (directory) or 15
minutes to 12 hours (prices, depending on whether the market is open).

## Symbol reference

40 listings as of 2026-07-25. Always prefer `gse_list_companies` — this table is
a convenience, and it dates.

**Main Market (34)** — `ACCESS` `ADB` `AGA` `ALLGH` `ALW` `ASG` `BOPP` `CAL`
`CLYD` `CMLT` `CPC` `DASPHARMA` `EGH` `EGL` `ETI` `FAB` `FML` `GCB` `GGBL` `GOIL`
`MAC` `MTNGH` `PBC` `RBGH` `SCB` `SCB PREF` `SIC` `SOGEGH` `SWL` `TBL` `TLW`
`TOTAL` `UNIL` `ZEN`

**Ghana Alternative Market (5)** — `DIGICUT` `HORDS` `IIL` `MMH` `SAMBA`

**Exchange Traded Fund (1)** — `GLD`

GFIM fixed-income issuers are deliberately absent: they have no share code, so
there is nothing here to look a price up by. Use
`gse_list_fixed_income_issuers` for those.

## How the scrape works

gse.com.gh is a WordPress site using wpDataTables, with no documented API, so the
client reproduces what the page's own JavaScript does:

1. `GET` the page → a `__cf_bm` cookie and a `wdtNonce` per table on that page
2. `POST /wp-admin/admin-ajax.php?action=get_wdtable&table_id=<id>` with both →
   the rows as JSON

Neither step is optional; without the cookie/nonce pair the endpoint refuses.

Two pages carry six tables, all of which are now read:

| Page                 | Table | Contents                           | Tool                            |
| -------------------- | ----- | ---------------------------------- | ------------------------------- |
| `/trading-and-data/` | 39    | Daily share prices                 | `gse_get_stock_history`         |
| `/trading-and-data/` | 47    | GSE-CI, market cap, GSE-FSI        | `gse_get_market_index`          |
| `/listed-companies/` | 34    | Main Market companies              | `gse_list_companies`            |
| `/listed-companies/` | 35    | Exchange Traded Funds              | `gse_list_companies`            |
| `/listed-companies/` | 36    | Ghana Alternative Market companies | `gse_list_companies`            |
| `/listed-companies/` | 37    | Fixed-income corporate issuers     | `gse_list_fixed_income_issuers` |

Nonces are per-table but issued per page load, so the three-table directory scrape
costs one page fetch, not three.

The two date-filtered tables do **not** agree on which column carries the range:
it is column 1 on the price table and column 2 on the market-index table. Getting
that wrong returns the entire history instead of the window asked for, silently.

Reading all three company tables matters: the Main Market table alone misses six
tradeable symbols that *do* appear in the price table, so a caller could otherwise
look up history for a company the directory never mentioned.

### Quirks worth knowing before you touch this code

- The `Symbol` column arrives as HTML: `<a href='ACCESS' ...>ACCESS</a>`.
- `recordsTotal` and `recordsFiltered` arrive as JSON *strings* (`"183595"`),
  not the numbers the DataTables protocol specifies.
- A rejected nonce is answered with a bare `-1` or `0` and a **200** status. Both
  are valid JSON, so this has to be detected explicitly.
- Responses are labelled `Content-Type: text/html` even when the body is JSON, so
  the content type is never worth checking.
- The share-code search is a substring regex server-side, so a query for `SCB` can
  also match `SCB PREF`; the parser narrows it to an exact match afterwards.
- The market-index table has a weekday-name column whose values are inconsistently
  padded (`"Thursday "`). It is skipped — the date already carries that.

### Caching

| Key                                 | Fresh for                               |
| ----------------------------------- | --------------------------------------- |
| `gse:companies:v1`                  | 7 days                                  |
| `gse:fixed-income-issuers:v1`       | 7 days                                  |
| `gse:history:v1:{symbol}:{days}`    | 15 min during GSE hours, 12 h otherwise |
| `gse:market-index:v1:{days}`        | 15 min during GSE hours, 12 h otherwise |

GSE trades weekdays, roughly 09:30–15:30 GMT (Ghana keeps GMT year-round). Outside
that window the day's rows are settled, so the longer TTL applies.
