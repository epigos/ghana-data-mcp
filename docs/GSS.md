# Ghana Statistical Service (`gss_*`)

Official national statistics from [StatsBank](https://statsbank.statsghana.gov.gh/),
the Ghana Statistical Service's PxWeb data portal — CPI and inflation for Ghana and
all 16 regions, GDP, public debt, the fiscal accounts, money and credit, interest
rates, banking soundness, merchandise trade, the balance of payments, industrial
production and fuel consumption. Sixteen tables, three read-only tools.

Figures in this document were captured live on **2026-07-29** and show the shape of a
response, not current figures.

Running the server and connecting a client are covered once in the
[README](../README.md#connecting-an-mcp-client).

- [Tools](#tools)
  - [`gss_list_tables`](#gss_list_tables)
  - [`gss_describe_table`](#gss_describe_table)
  - [`gss_get_data`](#gss_get_data)
- [The three tables of tables](#the-three-tables-of-tables)
- [Reading the data correctly](#reading-the-data-correctly)
- [Sample chat queries](#sample-chat-queries)
- [How the data is fetched](#how-the-data-is-fetched)

## Tools

Three tools rather than one per table. Sixteen tools for one source would nearly
triple this server's tool count and make selection worse for every other source, so
the shape mirrors the API instead: browse, describe, fetch.

| Tool | Returns |
| ---- | ------- |
| `gss_list_tables` | The 16-table catalog, filterable by keyword or sector. No network call |
| `gss_describe_table` | One table's filterable dimensions, every value each accepts, and which periods are published |
| `gss_get_data` | Observations for a table, narrowed by period and by dimension |

Most questions need only `gss_get_data` — it resolves table ids, period spellings
and dimension values tolerantly, and names the valid options when something does not
resolve. Reach for `gss_describe_table` when you need the exact spelling of a value
or the full period axis.

### `gss_list_tables`

| Input    | Type   | Notes                                                              |
| -------- | ------ | ------------------------------------------------------------------ |
| `query`  | string | Keyword matched against id, aliases, title, sector and summary.    |
| `sector` | string | One of: Prices and Inflation, Real Sector (GDP), Fiscal Sector, Monetary and Financial Sector, External Sector, Other. |

The registry ships with the Worker, so this answers instantly and works even when
StatsBank is down. `meta.origin` is always `static-seed` for that reason.

```json
{
  "id": "cpi",
  "title": "Consumer Price Index (CPI) and Inflation",
  "sector": "Prices and Inflation",
  "summary": "Headline and regional inflation. CPI level plus year-on-year and month-on-month rates, for Ghana and all 16 regions, split by product group and by local/imported source.",
  "timeVariable": "Month",
  "dimensions": ["Indicator", "Region", "Product", "Source"],
  "granularities": ["monthly"],
  "granularityRequired": false
}
```

Real output for `query: "inflation"`:

```
cpi                Consumer Price Index (CPI) and Inflation
ppi                Producer Price Index (PPI)
commodity_prices   Commodity Prices
iip                Index of Industrial Production (IIP)
xmpi               Export and Import Price Indices (XMPI)
```

Upstream table names work as aliases, so a `query` of `fin_sound` (the filename in
StatsBank's own API) resolves to `financial_soundness`.

**Sample chat queries**

> **What Ghana statistics can you get from the Statistical Service?**

`gss_list_tables({})` — all 16, grouped by sector. A good answer names the sectors
rather than reciting every table.

> **Do you have anything on Ghana's banking sector?**

`gss_list_tables({ query: "banking" })` → `financial_soundness`. The summary names
what is in it (capital adequacy, NPL ratio, return on assets) so the follow-up can
go straight to `gss_get_data`.

> **What's in the external sector data?**

`gss_list_tables({ sector: "External Sector" })` → `trade` and
`international_finance`.

### `gss_describe_table`

| Input   | Type   | Notes                                  |
| ------- | ------ | -------------------------------------- |
| `table` | string | Table id or alias. Required.           |

```json
{
  "id": "cpi",
  "title": "Consumer Price Index (CPI) and Inflation",
  "timeVariable": "Month",
  "granularityRequired": false,
  "periodCount": 337,
  "granularities": ["monthly"],
  "earliestPeriod": "1998M01",
  "latestPeriod": "2026M01",
  "recentPeriods": ["2026M01", "2025M12", "2025M11", "…"],
  "dimensions": [
    { "code": "Indicator", "valueCount": 3, "values": ["Consumer Price Index", "Year-on-year inflation (%)", "Month-on-month inflation (%)"] },
    { "code": "Region", "valueCount": 17, "values": ["Ghana", "Western", "Central", "Greater Accra", "…"] },
    { "code": "Product", "valueCount": 16, "values": ["All products", "Food", "Non-food", "…"] },
    { "code": "Source", "valueCount": 3, "values": ["All sources", "Local", "Import"] }
  ]
}
```

Real axis bounds for `fuel`: 306 monthly periods, `1999M01` to `2024M06`.

**Sample chat queries**

> **Which regions can you break Ghana's inflation down by?**

`gss_describe_table({ table: "cpi" })` and read the `Region` dimension: Ghana plus
all 16 administrative regions.

> **How far back does Ghana's interest rate data go?**

`gss_describe_table({ table: "interest_rates" })` → 643 monthly periods starting
`1971M01`. The longest series on StatsBank.

> **What can I slice the trade data by?**

`gss_describe_table({ table: "trade" })` → `Tradeflow` (export/import/total),
`Product_Classification` (11 classes), and `Valuation_Parameter` (cedis nominal or
real, US dollars, or net kilograms). The response also warns that this table needs
an explicit `granularity`.

### `gss_get_data`

| Input         | Type     | Notes                                                                 |
| ------------- | -------- | --------------------------------------------------------------------- |
| `table`       | string   | Table id or alias. Required.                                          |
| `latest`      | number   | Most recent N periods. Defaults to 12 when no period argument is given. |
| `startPeriod` | string   | Inclusive start, e.g. `2023M01`, `2023Q1`, `2019`.                    |
| `endPeriod`   | string   | Inclusive end, same formats.                                          |
| `periods`     | string[] | Explicit periods. Takes precedence over `latest` and the range.        |
| `granularity` | enum     | `annual` \| `quarterly` \| `monthly`. Required for `fiscal` and `trade`. |
| `filters`     | object   | Dimension → value or values, e.g. `{"Region": "Ashanti", "Product": ["Food", "Transport"]}`. |

```json
{
  "table": "cpi",
  "title": "Consumer Price Index (CPI) and Inflation by Indicator, Month, Region, Product and Source",
  "source": "GSS",
  "updated": "2026-02-05T04:02:00Z",
  "granularity": "monthly",
  "periods": ["2025M11", "2025M12", "2026M01"],
  "rowCount": 3,
  "rows": [
    { "period": "2025M11", "granularity": "monthly", "provisional": false, "dimensions": { "Indicator": "Year-on-year inflation (%)", "Region": "Ghana", "Product": "All products", "Source": "All sources" }, "measure": "Consumer Price Index and Inflation", "value": 6.3 }
  ]
}
```

Real output for headline inflation, `latest: 3`:

```
source="GSS"  updated=2026-02-05T04:02:00Z  monthly
  2025M11   6.3   Region=Ghana Product=All products
  2025M12   5.4   Region=Ghana Product=All products
  2026M01   3.8   Region=Ghana Product=All products
```

Real output comparing regions for the latest month:

```
  2026M01   3.8   Region=Ghana
  2026M01   4.0   Region=Ashanti
  2026M01   4.6   Region=Upper West
```

Rows are always oldest-first, whatever order the table stores internally.

**Sample chat queries**

> **What's Ghana's inflation rate right now?**

`gss_get_data({ table: "cpi", latest: 3, filters: { Indicator: "Year-on-year inflation (%)", Region: "Ghana", Product: "All products", Source: "All sources" } })`.
Read the last row. This is the *official GSS* figure, which is the one quoted in
Ghanaian press and policy documents — prefer it over `imf_get_indicator_history` for
a question about what inflation *is*, and use the IMF tool for what it is *forecast*
to be.

> **Is inflation worse in the north than in Accra?**

Same call with `Region: ["Greater Accra", "Northern", "Upper West", "Upper East"]`.
One call, one row per region.

> **What's food inflation doing versus non-food?**

`filters: { Product: ["Food", "Non-food"], Region: "Ghana", Indicator: "Year-on-year inflation (%)" }`.
Note `Food` and `Food and non-alcoholic beverages` are different baskets; an exact
value always wins over a longer one that merely contains it.

> **Where is the policy rate and the 91-day T-bill?**

`gss_get_data({ table: "interest_rates", latest: 3, filters: { Rate: ["Monetary policy rate", "Treasury bill rate (91-day)"] } })`:

```
source="BOG"  monthly
  2024M05   29.0  Monetary policy rate      25.2  T-bill (91-day)
  2024M06   29.0  Monetary policy rate      24.9  T-bill (91-day)
  2024M07   29.0  Monetary policy rate      24.8  T-bill (91-day)
```

> **How much has Ghana's public debt grown, and how much of it is external?**

`gss_get_data({ table: "debt", latest: 1, filters: { Variable: ["Total public debt", "External debt", "Domestic debt"] } })`:

```
source="MOF: mofep.gov.gh/public-debt/debt-data"
  2024M06   50929.4   Total public debt
  2024M06   31023.9   External debt
  2024M06   19905.5   Domestic debt
```

> **What did Ghana earn from gold exports last year?**

`gss_get_data({ table: "trade", latest: 4, granularity: "quarterly", filters: { Tradeflow: "Export", Product_Classification: "Gold", Valuation_Parameter: "Value in US Dollars" } })`:

```
source="Customs Division of the Ghana Revenue Authority"
  2025Q1   3,904,243,495 USD
  2025Q2   4,800,567,073 USD
  2025Q3   5,274,434,164 USD
  2025Q4   6,531,854,366 USD
```

> **How healthy are Ghana's banks?**

`gss_get_data({ table: "financial_soundness", latest: 2, filters: { Indicator: ["Non performing loan ratio", "Capital adequacy ratio"] } })`:

```
source="BOG"
  2024M06   14.3  Capital adequacy ratio
  2024M06   24.1  Non performing loan ratio
```

> **What was Ghana's GDP growth in 2024?**

`gss_get_data({ table: "gdp_production", periods: ["2023", "2024", "2025"], filters: { GDP_Series: "Real GDP growth rate (year-on-year %)", Variable: "Overall GDP" } })`:

```
  2023   3.1
  2024   5.9   provisional
  2025   6.0   provisional
```

A good answer says 2024 is **provisional** and 2025 is a **forecast** — see below.

## The three tables of tables

Sixteen tables, grouped as StatsBank groups them.

| Sector | Tables |
| ------ | ------ |
| Prices and Inflation | `cpi`, `ppi`, `commodity_prices`, `iip`, `xmpi` |
| Real Sector (GDP) | `gdp_production`, `gdp_expenditure`, `mieg` |
| Fiscal Sector | `debt`, `fiscal` |
| Monetary and Financial Sector | `interest_rates`, `monetary`, `financial_soundness` |
| External Sector | `trade`, `international_finance` |
| Other | `fuel` |

**StatsBank is an aggregator, and the attribution matters.** Each table's `source`
field names who actually produced the numbers, and it is rarely GSS itself:

| Table | `source` |
| ----- | -------- |
| `cpi`, `gdp_production` | GSS / Ghana Statistical Service |
| `interest_rates`, `monetary`, `financial_soundness` | BOG |
| `debt` | MOF: mofep.gov.gh/public-debt/debt-data |
| `trade` | Customs Division of the Ghana Revenue Authority |
| `fuel` | National Petroleum Authority (NPA) |
| `commodity_prices` | BOG (Reuters) for cocoa, oil and gold, NPA for petrol and diesel |

Pass that through when citing a figure. Note the overlap with `bog_*`: StatsBank
republishes Bank of Ghana rates monthly, while `bog_*` reads BoG's own tables
directly. Use `bog_*` for the latest daily FX and auction detail, `gss_*` for a long
consistent monthly series (interest rates run back to **1971**).

## Reading the data correctly

### Recent GDP years are provisional, and one is a forecast

GSS marks unfinalized periods with asterisks in the raw API — `2024*` is
provisional, `2025**` is a projection. Every row carries `provisional: true` for
those, and `meta.warning` counts them.

This is the same caveat as IMF's `isProjection` and it matters just as much: *"Ghana
grew 5.9% in 2024"* overstates what GSS has actually published. Say *"provisionally
5.9%"*. The asterisks are also part of the value the API accepts, which is why
`periods: ["2024"]` works — the tool maps a bare year onto `2024*` for you.

### Two tables need a granularity, and getting it wrong double-counts

`fiscal` and `trade` interleave annual, quarterly and monthly periods on a single
axis. `trade`'s axis holds 4 annual, 20 quarterly and 60 monthly codes together, so
"the last 5 periods" without a granularity would return `2025Q4`, `2025M12`,
`2025M11`, `2025M10`, `2025Q3` — a quarter and three of the months inside it. Summing
or charting that counts the same trade twice.

`gss_get_data` refuses rather than guessing:

```
Table "trade" mixes annual, quarterly, monthly periods on one axis, so `granularity`
is required. Pass one of those values. Without it a series could contain both a
quarter and the months inside it, double-counting the same activity.
```

Every other table has one granularity and infers it.

### A missing observation is not zero

PxWeb writes an unavailable value as `..`, `.` or `-`, and a real zero as `0.00`.
Those are dropped rather than coerced, and counted in `meta.skippedRows` — a
fabricated zero averaged into a series is worse than a shorter series. Kerosene
consumption genuinely reads `0.00` in some months and that is kept.

### Coverage varies enormously

`interest_rates` runs to 643 monthly periods (from 1971). `iip` has 15 quarters.
`mieg` has 40 months. Always read what came back rather than assuming a window.

## How the data is fetched

PxWeb is a two-step API: a `GET` on a table returns its variables and legal values, a
`POST` with a query built from those returns the data. The 16 table paths live in
[`tables.ts`](../src/sources/gss/tables.ts); the folder listing described below is how
you rediscover one whose upstream filename has changed.

```
GET  /api/v1/en/Macroeconomic Indicators/Prices and Inflation/cpi.px   -> schema
POST /api/v1/en/Macroeconomic Indicators/Prices and Inflation/cpi.px   -> data
```

Four things about StatsBank shape this source, all verified against the live API:

- **An invalid query returns 404 with an HTML error page.** Not a JSON error and not
  a 400. A variable that does not exist and a legal variable with an illegal value
  both produce an IIS "File or directory not found" page. So every code, value and
  period is validated against the cached schema *before* a POST goes out, and a
  non-JSON body is reported as a parse failure rather than crashing.
- **`filter: "top"` is not "latest N".** PxWeb's documented `top` filter takes the
  first N values *in storage order*. Most StatsBank tables are stored newest-first so
  it looks correct by accident — but `mieg` is stored oldest-first, and there
  `top: 3` returns 2023M01–2023M03, whose growth values are all `0.0`. Silently wrong
  data with no error. This source never sends `top`: it reads the axis, sorts it
  chronologically itself, and sends explicit `filter: "item"` period codes.
- **PxWeb's own `time: true` flag is unreliable here.** StatsBank sets it on only 8
  of the 16 tables, so the time axis is named per-table in
  [`tables.ts`](../src/sources/gss/tables.ts) rather than discovered.
- **One table's filename carries a publication vintage.** MIEG lives at
  `April_26_MIEG_Px.px` and that name will change when GSS publishes a new vintage.
  The live canary walks the folder listing so a 404 there tells you the new filename.

### A note on local development

StatsBank negotiates **TLS 1.2 with CBC-only cipher suites** (`ECDHE-RSA-AES256-SHA384`
and `ECDHE-RSA-AES128-SHA`; it offers no AEAD/GCM suite and no TLS 1.3). Cloudflare's
production runtime connects to it fine, and so does Node — but **local `wrangler dev`
cannot**, and every `gss_*` call that needs the network fails there with
`Network connection lost` after about 400ms.

That is a cipher-overlap limitation in the local runtime, not a bug in this source
and not something a code change here can fix.

**The fix for local development is `--remote`:**

```bash
npx wrangler dev --remote
```

That runs your Worker on Cloudflare's edge instead of in local workerd, so it reaches
StatsBank normally while you keep the usual local dev loop. Verified: `gss_describe_table`
on `ppi` returns all 236 monthly periods under `--remote` and fails under plain
`wrangler dev`.

Other ways round it:

- The deployed Worker works — StatsBank is reachable from Cloudflare's production runtime.
- `npm run test:live` runs under plain Node, which negotiates the older ciphers fine.
- `gss_list_tables` works everywhere, since it never leaves the Worker.

A connection failure here says all of this in the error itself rather than suggesting a
retry, because retrying under plain `wrangler dev` never succeeds.

### Caching

| Key | Fresh for | Notes |
| --- | --------- | ----- |
| `gss:schema:v1:{table}` | 24 hours | The schema carries the period axis, so it cannot be cached for a week or a newly published month would be invisible to `latest` |
| `gss:data:v2:{table}:{granularity}:{periods}:{filters}` | 24 hours | Periods and filter values are sorted into the key, so the same slice asked two ways shares one entry |

Per-call ceilings: 240 periods, 3000 rows. A truncated result says so in
`meta.warning` rather than quietly returning less than was asked for.
