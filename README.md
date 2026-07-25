# ghana-data-mcp

[![CI](https://github.com/epigos/ghana-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/epigos/ghana-data-mcp/actions/workflows/ci.yml)
[![Upstream canary](https://github.com/epigos/ghana-data-mcp/actions/workflows/upstream-canary.yml/badge.svg)](https://github.com/epigos/ghana-data-mcp/actions/workflows/upstream-canary.yml)

An MCP server that gives AI tools access to public Ghana data. It runs on
Cloudflare Workers as a remote MCP server over Streamable HTTP.

Tools are namespaced by source, so further Ghana data sources can be added
without restructuring anything — see [CONTRIBUTING.md](CONTRIBUTING.md).

## Data sources

| Source                              | Prefix | Tools | Covers                                                                                  |
| ----------------------------------- | ------ | ----- | --------------------------------------------------------------------------------------- |
| [Ghana Stock Exchange](docs/GSE.md) | `gse_` | 5     | Share prices, company directory, market index, fixed-income issuers                     |

Each source has its own guide with a full tool reference, sample chat queries, and
the data caveats specific to it. **Start with [docs/GSE.md](docs/GSE.md).**

## Tools

| Tool                                                                            | Returns                                                          |
| ------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| [`gse_get_stock_history`](docs/GSE.md#gse_get_stock_history)                     | Daily prices and volume for one share code, oldest first         |
| [`gse_list_companies`](docs/GSE.md#gse_list_companies)                           | Every listed company: share code, name, board, listing date      |
| [`gse_search_company`](docs/GSE.md#gse_search_company)                           | Best-matching companies for a name, with a confidence score      |
| [`gse_get_market_index`](docs/GSE.md#gse_get_market_index)                       | Market-wide daily GSE-CI, market cap, GSE-FSI and volume         |
| [`gse_list_fixed_income_issuers`](docs/GSE.md#gse_list_fixed_income_issuers)     | Corporate bond issuers on the Ghana Fixed Income Market          |
| `ping`                                                                          | Health check. No input; returns `{ ok, server, version }`        |

`ping` is the only tool that belongs to no source — it touches nothing upstream,
which is what makes it a clean connectivity check.

Equities and debt are kept apart: GFIM issuers have no share code and no price
history, so they get their own tool rather than being mixed into the company
directory where `gse_get_stock_history` would appear to fail for them.

Some of what GSE publishes is easy to misread — `high`/`low` are annual rather
than daily, a price row does not mean the stock traded, and the capital columns are
free text. The tool schemas carry those warnings, and
[docs/GSE.md](docs/GSE.md#reading-the-data-correctly) explains each one.

### Is the data fresh?

Every result from every source carries a `meta` block:

```json
{ "origin": "live", "ageSeconds": 0, "skippedRows": 0 }
```

| `origin`      | Means                                                                     |
| ------------- | ------------------------------------------------------------------------- |
| `live`        | Just scraped from the source site                                         |
| `cache`       | A fresh cached copy; `ageSeconds` says how old                            |
| `stale-cache` | The scrape failed, so an expired copy was served. `meta.warning` says why  |
| `static-seed` | The scrape failed entirely and a built-in fallback list was used           |

`stale-cache` and `static-seed` always set `meta.warning`, and a good answer passes
that on rather than presenting the numbers as current. Nothing is ever presented as
fresh when it isn't.

Which origins a given tool can return, and how long each stays fresh, is documented
per source — for GSE, see
[knowing whether the data is fresh](docs/GSE.md#knowing-whether-the-data-is-fresh).

## Quick start

```bash
git clone git@github.com:epigos/ghana-data-mcp.git
cd ghana-data-mcp
npm install
npm test
npm run dev
```

That serves MCP at `http://localhost:8787/mcp`. Requires Node 22 or newer.

## Connecting an MCP client

The transport is Streamable HTTP and there is no authentication — the data is
public, so there is no API key to configure. Any MCP client that speaks HTTP will
work; the two most common are below.

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

**Anything else** — point it at the `/mcp` endpoint and let it negotiate. There is
also a plain `GET /health` that returns the server version and needs no MCP client
at all:

```bash
curl http://localhost:8787/health
```

Swap `localhost:8787` for your `workers.dev` URL once [deployed](#deploying).

### Checking it works

Ask the model to run the `ping` tool — it confirms the connection without
scraping anything:

> Use the ping tool on the ghana-data server.

Then try a real question. Each source's guide has a set of queries chosen to
exercise its tools and data quirks — for GSE, see
[sample chat queries](docs/GSE.md#sample-chat-queries).

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

MCP is served at `/mcp` by the Cloudflare Agents SDK's stateless handler, so there
is no Durable Object to deploy: every tool is an independent read-only scrape with
no session state worth keeping.

Each source owns a folder under `src/sources/` with the same internal shape —
`client.ts` talks upstream, `parser.ts` is pure transformation, `tools.ts`
registers the MCP tools — and shares the infrastructure in `src/lib/`. The
upstream mechanics for GSE specifically are in
[docs/GSE.md](docs/GSE.md#how-the-scrape-works).

### Caching and degradation

Cached in Workers KV, with the logical freshness window stored *inside* the value
and a 30-day retention on the entry itself. That is what makes the stale fallback
possible: if KV expired entries at the TTL there would be nothing left to serve
when a scrape fails.

The tools try, in order: a live scrape, a fresh cached copy, an expired cached
copy, and — where a source provides one — a built-in seed list, reporting which
they used in [`meta.origin`](#is-the-data-fresh).

A partial failure degrades partially rather than wholly: if one company table
errors while another succeeds, the directory returns what it got plus a warning
naming the missing board, instead of nothing at all.

Per-source cache keys and TTLs are documented with the source.

### Logging

Every outbound request is logged, because `lib/http.ts` is the single choke point
for network traffic — no source can reach the internet unobserved. Workers routes
`console.*` into Workers Logs, so there is nothing to configure.

- **`info` and above are always on.** One line per upstream request is cheap,
  since the cache absorbs the repeats, and it is the first thing you want when a
  tool misbehaves.
- **`debug` needs `DEBUG = "1"`** in `wrangler.toml` (or `wrangler dev --var
  DEBUG:1`) — request bodies, nonces, cache keys, retry delays.

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

Every line carries its `source`, so a second data source stays greppable apart.

**Cookies are never logged** — a session cookie would be a liability in a log
aggregator, so the request line records only `cookies=yes|no`. Nonces *are*
logged: they come from public page HTML and are what you need to diagnose a
rejected POST.

### Being a good citizen upstream

- A descriptive `User-Agent` that names the project and links to this repo.
- Cache-first, so repeat questions never reach the source site.
- Jittered exponential backoff on 403/429/5xx instead of retrying immediately.
- An inbound per-IP limit of 30 requests/minute, to stop a looping client from
  turning into a load problem for someone else's website.

## Testing

```bash
npm test          # unit tests, no network
npm run typecheck
npm run test:live # optional: hits gse.com.gh to catch upstream markup changes
```

The unit tests run against saved fixtures in `test/fixtures/`, so CI never depends
on a third-party site being up. `test:live` is the canary for upstream changes and
is skipped by default.

For end-to-end checks through a real MCP client, the query set in
[docs/GSE.md](docs/GSE.md#sample-chat-queries) exercises every tool, the fuzzy
search, the cache, and the awkward data cases.

### CI

| Workflow                                                       | Trigger                     | Does                                                                                      |
| -------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------- |
| [`ci.yml`](.github/workflows/ci.yml)                           | push to `main`, PRs, manual | Typecheck + unit tests on Node 22 and 24, plus a `wrangler deploy --dry-run` bundle check |
| [`upstream-canary.yml`](.github/workflows/upstream-canary.yml) | 16:30 UTC Mon & Thu, manual | The live tests against gse.com.gh                                                         |

The split is the point: CI stays green or red on **our** code, never on whether
gse.com.gh happens to be up. The canary is the only job that touches the live site,
and a failure there usually means GSE changed its markup rather than that this code
broke — `test/integration/gse.live.test.ts` shows which assumption stopped holding.
Neither workflow needs any secret.

## Status

The GSE source is feature-complete: all six wpDataTables on gse.com.gh are read —
price history, the company directory across all three boards, the market index,
and GFIM fixed-income issuers — with fuzzy company search, caching, stale and seed
fallbacks, rate limiting and logging.

Further sources (Bank of Ghana FX rates, Ghana Statistical Service indicators) are
what the namespacing exists for; see [CONTRIBUTING.md](CONTRIBUTING.md) for the
walkthrough.

## License

MIT
