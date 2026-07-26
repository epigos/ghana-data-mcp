# IMF (`imf_*`)

Macroeconomic indicators from the [IMF DataMapper](https://www.imf.org/external/datamapper/profile/GHA)
— GDP, inflation, government debt, the current account, and around 130 others
spanning the World Economic Outlook and several other IMF datasets. Defaults to
Ghana, but any country, region, or analytical group (e.g. Nigeria, Sub-Saharan
Africa, ECOWAS) DataMapper tracks can be requested alongside it, by code or by
plain name. Two tools, both read-only.

Figures in this document were captured on **2026-07-26** and show the shape of a
response, not current figures.

Running the server and connecting a client are covered once in the
[README](../README.md#connecting-an-mcp-client).

- [Tools](#tools)
  - [`imf_list_indicators`](#imf_list_indicators)
  - [`imf_get_indicator_history`](#imf_get_indicator_history)
- [Reading the data correctly](#reading-the-data-correctly)
- [Sample chat queries](#sample-chat-queries)
- [How the data is fetched](#how-the-data-is-fetched)

## Tools

| Tool | Returns |
| ---- | ------- |
| `imf_list_indicators` | Search the ~130-indicator catalog by keyword; returns the code each match needs |
| `imf_get_indicator_history` | Time series for one or more indicators, for Ghana and — optionally — other countries, regions or analytical groups |

### `imf_list_indicators`

Indicator codes are not guessable from their name — real GDP growth is
`NGDP_RPCH` — so this is how a caller finds the code to pass to
`imf_get_indicator_history`.

| Input   | Type   | Notes                                              |
| ------- | ------ | --------------------------------------------------- |
| `query` | string | Keyword, matched against label, description and dataset. Omit to list everything. |
| `limit` | number | Maximum matches. Default 25, max 100.               |

```json
{
  "id": "NGDP_RPCH",
  "label": "Real GDP growth",
  "description": "Gross domestic product is the most commonly used single measure of a country's overall economic activity...",
  "unit": "Annual percent change",
  "source": "World Economic Outlook (April 2026)",
  "dataset": "WEO"
}
```

Real matches for `query: "gdp"`:

```
GDP          Nominal GDP                                       CF
FMB_GDP      Broad Money (% of GDP)                            AFRREO
FDSAOP_GDP   Claims on Nonfinancial Private Sector (% of GDP)   AFRREO
BCA_NGDPD    Current account balance, percent of GDP            WEO
```

An exact id match ranks first, then a whole-word match in the label, then a plain
substring — a small, deliberately simple ranking, since the catalog is short enough
that fuzzy scoring like `gse_search_company` uses would be solving a problem this
data doesn't have.

`unit` is sometimes an empty string — a couple of indicators (e.g. `rgc`, a bare
growth-rate percent in the FPP dataset) genuinely publish no unit.

### `imf_get_indicator_history`

One series per (indicator, country/region/group) pair, oldest first.

| Input        | Type     | Notes                                                          |
| ------------ | -------- | ---------------------------------------------------------------- |
| `indicators` | string[] | 1–8 codes, e.g. `["NGDP_RPCH", "PCPIPCH"]`. Case-insensitive.     |
| `countries`  | string[] | 1–8 countries, regions or groups to compare. Accepts an IMF code (`"NGA"`), a plain name (`"Nigeria"`), or a region/group name (`"Sub-Saharan Africa"`, `"ECOWAS"`). Case-insensitive. Omit for Ghana alone. |
| `startYear`  | number   | Omit for the earliest year available.                            |
| `endYear`    | number   | Omit for the latest — which usually means IMF's own forecasts, see below. |

```json
{
  "indicatorId": "NGDP_RPCH",
  "indicatorLabel": "Real GDP growth",
  "unit": "Annual percent change",
  "source": "World Economic Outlook (April 2026)",
  "dataset": "WEO",
  "projectionStartYear": 2026,
  "entityId": "GHA",
  "entityLabel": "Ghana",
  "entityKind": "country",
  "rowCount": 10,
  "rows": [
    { "year": 2018, "value": 6.2, "isProjection": false },
    { "year": 2025, "value": 6, "isProjection": false },
    { "year": 2026, "value": 4.8, "isProjection": true },
    { "year": 2027, "value": 4.9, "isProjection": true }
  ]
}
```

Real output for `indicators: ["NGDP_RPCH", "PCPIPCH"], startYear: 2018, endYear: 2027`:

```
NGDP_RPCH (Real GDP growth, % change) — Ghana
  2018  6.2    2022  3.8    2026  4.8  ← projection
  2019  6.5    2023  3.1    2027  4.9  ← projection
  2020  0.5    2024  5.8
  2021  5.1    2025  6.0

PCPIPCH (Inflation, average consumer prices, % change) — Ghana
  2018  9.8    2022  31.9   2026  5.8  ← projection
  2019  7.2    2023  39.2   2027  7.8  ← projection
  2020  9.9    2024  22.9
  2021  10.0   2025  14.2
```

Passing several indicators, several countries, or both fetches everything in a
single upstream request rather than one per indicator or per country — see
[how the data is fetched](#how-the-data-is-fetched). The result is a flat list of
series, one per (indicator, entity) pair, ordered indicators-major then entities —
for two indicators and two countries, that's four series in the order
`[ind1×countryA, ind1×countryB, ind2×countryA, ind2×countryB]`.

### Comparing across countries

`countries` accepts three kinds of things DataMapper tracks as the same shape of
code: individual countries (`GHA`, `NGA`, or by name — `"Nigeria"`), IMF regions
(`AFQ` — "Africa (Region)"), and analytical groups (`SSA` — "Sub-Saharan Africa",
`ECOWAS`). An exact code always wins outright; otherwise the best label match is
used, so `"Nigeria"`, `"nigeria"`, and `"NGA"` all resolve to the same entity.

**Region and group aggregates are published per-indicator, not universally** —
this is the one thing worth checking rather than assuming. Confirmed directly
against the live API: `ECOWAS` has no aggregate on the general WEO real-GDP-growth
indicator (`NGDP_RPCH`) but does have one on the Africa-specific REO equivalent
(`NGDP_R_PCH`). A region/group series with `rowCount: 0` means exactly that — IMF
never published an aggregate for it on this particular indicator — the same "no
data" outcome as a country lacking coverage, not an error. Always check `rowCount`
before reporting a comparison; don't assume a regional bloc has a figure just
because the countries in it do.

A country you name that isn't recognized is skipped with a warning rather than
failing the whole call, as long as at least one requested country/indicator
resolves — the same behavior `imf_list_indicators`-style typo tolerance gives on
the indicator side.

## Reading the data correctly

### Most series include IMF's own forecasts, not just history

This is the one caveat that matters most here, the same spirit as GSE's
`high`/`low` or BoG's redenomination note: **a row being present does not mean the
figure is a finalized outturn.**

Each indicator publishes a `projection-year` boundary — the first year IMF has not
yet closed the books on. `isProjection` is `year >= projectionStartYear`. For
`NGDP_RPCH` above, `projectionStartYear: 2026` means 2026 itself (the current year
as of this WEO vintage) is still an in-progress estimate, and 2027 onward is a
genuine multi-year forecast.

A good answer says so: *"Ghana's GDP is forecast to grow 4.9% in 2027"*, not
*"Ghana's GDP grew 4.9% in 2027."* This was verified to hold for indicators with no
forecast horizon at all too — a historical-only series (the Wang-Jahan capital
account openness index, last updated 2016) simply never has a row at or after its
own `projection-year`, so the flag correctly never fires for it without any special
casing.

### Not every indicator covers every country

Of the ~130 published indicators, several have no Ghana row at all — unemployment
(`LUR`), for one, covers 122 countries and Ghana is not among them. That comes back
as `rowCount: 0` with `meta.warning` naming which entity was empty, not as an
error: the indicator is real, it simply has no data for this country (or, per
above, this region/group).

### Coverage varies a lot by indicator

Some series run 1980–2031 (52 years, including the forecast tail); others cover a
handful of recent years. A capital-account openness sub-index might span
2007–2015. Always check `rowCount` and the years actually returned rather than
assuming a fixed window.

## Sample chat queries

> **What's Ghana's GDP growth been over the last few years?**

`imf_get_indicator_history({ indicators: ["NGDP_RPCH"] })`. Read the last few rows;
the most recent one or two are likely `isProjection: true`.

> **How does that compare to other West African economies?**

`imf_get_indicator_history({ indicators: ["NGDP_RPCH"], countries: ["GHA", "Nigeria", "Senegal", "ECOWAS"] })`.
Four series come back, one per entity, in the order requested after
deduping/sorting. Check each one's `rowCount` before comparing — a region/group
aggregate like `ECOWAS` may be `0` on this particular indicator even though every
individual country in it has data (see [Comparing across countries](#comparing-across-countries));
report that as "no ECOWAS-wide figure published for this indicator," not as a gap
in the tool.

> **How does Ghana's current account balance compare with its government debt?**

Two indicators in one call:
`{ indicators: ["BCA_NGDPD", "GGXWDG_NGDP"] }`. Confirms multi-indicator fetching
and that each keeps its own unit (`Percent of GDP` for both, here, though that
won't always be true across two arbitrary indicators).

> **What's Ghana's inflation forecast for next year?**

`imf_get_indicator_history({ indicators: ["PCPIPCH"] })`, then read the row whose
`isProjection` is `true` — and say it's a forecast, not a reported figure.

> **What was Ghana's GDP growth in 2015?**

`startYear: 2015, endYear: 2015` on `NGDP_RPCH`. Tests that a single-year window
still returns a one-row series rather than nothing.

> **What's the IMF's outlook for Ghana's economy?**

Deliberately open-ended: a good answer picks two or three headline indicators (GDP
growth, inflation, maybe the fiscal or current account balance) rather than
dumping the whole 130-indicator catalog, and clearly separates the historical
years from IMF's own projections.

> **Find me an IMF indicator about government debt.**

`imf_list_indicators({ query: "debt" })` — several matches across different
datasets (WEO's `GGXWDG_NGDP`, the Global Debt Database's `GG_DEBT_GDP`, and
others); the descriptions distinguish which is which.

## How the data is fetched

The DataMapper's own API help page documents filtering that, verified directly
against the live API, **does not work**:

- A country/region/group path segment (`/{indicator}/GHA`) is silently ignored —
  every request returns every one of the ~229 countries, regions and analytical
  groups DataMapper tracks.
- The documented `?periods=2019,2020` querystring is likewise ignored — the full
  year range comes back regardless.
- An **unsupported** querystring parameter — `?countries=GHA` is a plausible guess,
  but not documented — does not 404 or get ignored. It trips the site's WAF, which
  answers with a 200 status and an HTML "Request Rejected" body instead of JSON.

So this client sends indicator ids only, never a country segment and never any
querystring, and leaves the entity slice (Ghana, or whichever countries/regions/
groups were requested) and the year window to be applied after the fact. Multiple
indicator ids in one path *does* work — `/NGDP_RPCH/PCPIPCH` returns both under
their own keys in one response — which is what lets `imf_get_indicator_history`
fetch several indicators in a single request rather than one round trip each. Since
every request already returns every country, region and group regardless, reading
out several entities from that same response was free once one worked — no
additional upstream capability was needed to support `countries`.

A separate `/countries`, `/regions` and `/groups` catalog (241, 27 and 129 entries
respectively, as of this writing) is fetched once and cached to resolve a plain
name like `"Nigeria"` or `"ECOWAS"` to its code — the same shape of validate-before-
fetch that `imf_list_indicators`'s catalog already does for indicator ids.

Two silent-failure modes worth knowing if you touch this code:

- **An unrecognized indicator id is dropped without an error.** Wrong case, a
  typo, or a genuinely invalid code all produce the same thing: no entry for it
  anywhere in the response. A request made of nothing but bad ids returns
  `{"api": {...}}` with no `indicators` or `values` key at all. That's why
  `imf_get_indicator_history` validates every id against the cached catalog
  *before* making a request, rather than trusting the API to say what went wrong.
- **Every indicator's metadata always includes an extra empty-string key** in the
  response's `values` object, alongside the real indicator ids — an artifact of
  the API itself. Harmless here, since nothing in this codebase enumerates
  `values`' keys; every lookup goes by the specific id requested.

The API sits behind Akamai, whose bot mitigation can answer a burst of requests
with a temporary 403 that clears on its own within minutes — the same retryable
status GSE and BoG can return, already handled by the shared request logic in
`lib/http.ts`.

### Caching

| Key                                          | Fresh for | Notes                                    |
| --------------------------------------------- | --------- | ------------------------------------------ |
| `imf:indicators:v1`                           | 7 days    | The indicator catalog changes a few times a year at most |
| `imf:entities:v1`                             | 7 days    | Countries, regions and groups combined — changes even less often |
| `imf:series:v1:{ids}:{countries}`             | 24 hours  | Whole series cached; `startYear`/`endYear` applied after retrieval |

The series cache key is built from both the requested indicator ids and the
resolved country/region/group ids, each deduped and sorted independently, so
`{ indicators: ["PCPIPCH", "NGDP_RPCH"], countries: ["NGA", "GHA"] }` and
`{ indicators: ["NGDP_RPCH", "PCPIPCH", "ngdp_rpch"], countries: ["GHA", "nga", "NGA"] }`
share one cache entry — order, case and repetition don't fragment the cache.
