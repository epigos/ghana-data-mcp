# ghana-data-mcp

[![CI](https://github.com/epigos/ghana-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/epigos/ghana-data-mcp/actions/workflows/ci.yml)
[![Upstream canary](https://github.com/epigos/ghana-data-mcp/actions/workflows/upstream-canary.yml/badge.svg)](https://github.com/epigos/ghana-data-mcp/actions/workflows/upstream-canary.yml)

An MCP server that gives AI tools access to public Ghana data. It runs on
Cloudflare Workers as a remote MCP server over Streamable HTTP.

v1 covers the **Ghana Stock Exchange**: daily price history and a company
directory. Tools are namespaced by source (`gse_*`), so further Ghana data
sources can be added without restructuring anything — see
[CONTRIBUTING.md](CONTRIBUTING.md).

## Tools

| Tool                    | Input                          | Returns                                                   |
| ----------------------- | ------------------------------ | --------------------------------------------------------- |
| `gse_get_stock_history` | `symbol`, `days` (default 90)  | Daily OHLC + volume rows, oldest first                    |
| `gse_list_companies`    | `market?`, `refresh?`          | Every listed company: share code, name, board, listing date |
| `gse_search_company`    | `query`, `limit?`              | Best-matching companies with a confidence score           |
| `ping`                  | –                              | Health check                                              |

The directory covers all three boards — 34 Main Market companies, 5 on the Ghana
Alternative Market, and 1 ETF, 40 in total as of 2026-07-25.

Every result carries a `meta.origin` field — `live`, `cache`, `stale-cache`, or
`static-seed` — plus a `meta.warning` when the data may be behind. Nothing is
ever presented as fresh when it isn't.

### Two caveats on GSE's own data

**`high` and `low` are annual, not daily.** GSE's price table publishes a **Year
High** and **Year Low** — the rolling 52-week extremes — and no intraday range.
`high` and `low` are those columns. They barely move from row to row. The tool's
schema says so too, so a model reading it will not misreport them.

**`statedCapital`, `issuedShares` and `authorisedShares` are free text.** They
are passed through verbatim as strings and must not be calculated with. What GSE
stores there is genuinely inconsistent: five different currencies (`ZAR
4,899,021,716.98`, `US$867,714,000`, `DALASIS 200,000,000`), mixed units (`2.9
million` next to `118,093,134`), dots as thousands separators (`600.000.000`),
prose (`Pre-Listing: GHS40,000 Post-Listing: …`), and typos (`GHS400milliion`,
`GH(`). Parsing that would produce numbers wrong by orders of magnitude, which is
worse for a caller than text they can see is approximate.

## Quick start

```bash
git clone git@github.com:epigos/ghana-data-mcp.git
cd ghana-data-mcp
npm install
npm test
```

Run it locally:

```bash
npm run dev
```

Then point any MCP client at `http://localhost:8787/mcp`.

### Claude Code

```bash
claude mcp add --transport http ghana-data http://localhost:8787/mcp
```

### Claude Desktop

`claude_desktop_config.json`:

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

Swap the URL for your `workers.dev` URL once deployed.

## Deploying

1. Create your own KV namespace — the id in `wrangler.toml` belongs to the
   maintainer's account and will not work in yours:

   ```bash
   npx wrangler kv namespace create GSE_CACHE
   ```

   Paste the id it prints over the `id` under `[[kv_namespaces]]`.

2. Deploy:

   ```bash
   npm run deploy
   ```

The Worker needs no secrets and no authentication — the data is public. It fits
comfortably in the Workers free tier: KV absorbs the repeat queries, and the
scraper is I/O-bound, so billed CPU time stays low.

## How it works

```
MCP client ──► Worker /mcp ──► sources/gse ──► lib/{http,cache,rateLimit} ──► gse.com.gh
                                                       │
                                                  Workers KV
```

gse.com.gh is a WordPress site using wpDataTables. There is no documented API,
so the client reproduces what the page's own JavaScript does:

1. `GET` the page → a `__cf_bm` cookie and a `wdtNonce` per table on it
2. `POST /wp-admin/admin-ajax.php?action=get_wdtable&table_id=<id>` with both →
   the table rows as JSON

Neither step is optional; without the cookie/nonce pair the endpoint refuses.

Two pages and five tables are involved:

| Page                 | Table | Contents                            | Used |
| -------------------- | ----- | ----------------------------------- | ---- |
| `/trading-and-data/` | 39    | Daily share prices                  | yes  |
| `/trading-and-data/` | 47    | GSE Composite Index, market cap     | no   |
| `/listed-companies/` | 34    | Main Market companies               | yes  |
| `/listed-companies/` | 35    | Exchange Traded Funds               | yes  |
| `/listed-companies/` | 36    | Ghana Alternative Market companies  | yes  |
| `/listed-companies/` | 37    | Fixed-income corporate issuers      | no   |

Nonces are per-table but issued per page load, so the three-table company scrape
takes one page fetch, not three. Reading all three matters: the Main Market table
alone misses six tradeable symbols that do appear in the price table, so a caller
could otherwise look up history for a company the directory never mentioned.

### Caching

| Key                                | Fresh for                                      |
| ---------------------------------- | ---------------------------------------------- |
| `gse:companies:v1`                 | 7 days                                         |
| `gse:history:v1:{symbol}:{days}`   | 15 min during GSE hours, 12 h otherwise        |

Entries are retained in KV for 30 days past their freshness window. That is what
makes the stale fallback work: when a scrape fails and an expired copy is on
hand, the copy is served with `origin: "stale-cache"` and a warning, rather than
failing the call.

### Logging

Every outbound request is logged, because `lib/http.ts` is the single choke point
for network traffic — no source can reach the internet unobserved. Workers routes
`console.*` into Workers Logs, so there is nothing to configure.

Two levels, split by what they cost:

- **`info` and above are always on.** One line per upstream request is cheap,
  since the cache absorbs the repeats, and it is the first thing you want when a
  tool misbehaves.
- **`debug` needs `DEBUG = "1"`** in `wrangler.toml` (or `wrangler dev --var
  DEBUG:1`). This is the noisy detail: request bodies, nonces, cache keys, retry
  delays.

A cache hit is visible by its absence of HTTP lines:

```
info  | tool: gse_get_stock_history | source=gse symbol=GCB days=14
info  | gse: fetching stock history | source=gse symbol=GCB days=14
info  | http: response | source=gse method=GET label="GET /trading-and-data/" status=200 ms=897 attempt=1
info  | gse: session created | source=gse page=/trading-and-data/ tables=39 htmlBytes=196440
info  | http: response | source=gse method=POST label="POST admin-ajax.php (table 39)" status=200 ms=470 attempt=1
info  | gse: table fetched | source=gse table=39 rows=10 recordsTotal=183595 recordsFiltered=10
info  | tool: gse_get_stock_history done | source=gse symbol=GCB rows=10 origin=live ageSeconds=0

info  | tool: gse_get_stock_history | source=gse symbol=GCB days=14
info  | tool: gse_get_stock_history done | source=gse symbol=GCB rows=10 origin=cache ageSeconds=0
```

Every line carries `source=gse`, so a second data source stays greppable apart.

**Cookies are never logged** — `__cf_bm` is a session token, so the request line
records only `cookies=yes|no`, and the debug line lists cookie *names*. Nonces
*are* logged: they come from the public page HTML, are scoped to one page load,
and are exactly what you need to diagnose a rejected POST.

### Being a good citizen upstream

- A descriptive `User-Agent` that names the project and links to this repo.
- Cache-first, so repeat questions never reach gse.com.gh.
- Jittered exponential backoff on 403/429/5xx instead of retrying immediately.
- An inbound per-IP limit of 30 requests/minute, to stop a looping client from
  turning into a load problem for someone else's website.

## Testing

```bash
npm test          # unit tests, no network
npm run typecheck
npm run test:live # optional: hits gse.com.gh to catch upstream markup changes
```

The unit tests run against saved fixtures in `test/fixtures/`, so CI never
depends on a third-party site being up. `test:live` is the canary for upstream
changes and is skipped by default.

Requires Node 22 or newer.

### CI

| Workflow                                                    | Trigger                          | Does                                             |
| ----------------------------------------------------------- | -------------------------------- | ------------------------------------------------ |
| [`ci.yml`](.github/workflows/ci.yml)                         | push to `main`, PRs, manual      | Typecheck + unit tests on Node 22 and 24, plus a `wrangler deploy --dry-run` bundle check |
| [`upstream-canary.yml`](.github/workflows/upstream-canary.yml) | 16:30 UTC Mon & Thu, manual      | The live tests against gse.com.gh                |

The split is the point: CI stays green or red on **our** code, never on whether
gse.com.gh happens to be up. The canary is the only job that touches the live
site, and a failure there usually means GSE changed its markup rather than that
this code broke — `test/integration/gse.live.test.ts` shows which assumption
stopped holding. Neither workflow needs any secret.

## Degradation

The tools try, in order: a live scrape, a fresh cached copy, an expired cached
copy, and — for the directory only — a built-in seed list of the 32 Main Market
companies. Each outcome is labelled in `meta.origin`, so a caller can always tell
what it is holding.

A partial failure degrades partially rather than wholly: if the GAX table errors
while the Main Market table succeeds, the directory returns 35 companies and a
warning naming the missing board, instead of nothing at all.

## Status

Complete: price history, the live company directory across all three boards,
fuzzy company search, caching, stale and seed fallbacks, rate limiting.

Not implemented: the market-index table (47) and fixed-income issuers (37) are
identified in the client but unused — they are the obvious next tools if wanted.

## License

MIT
