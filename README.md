# ghana-data-mcp

[![CI](https://github.com/epigos/ghana-data-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/epigos/ghana-data-mcp/actions/workflows/ci.yml)
[![Upstream canary](https://github.com/epigos/ghana-data-mcp/actions/workflows/upstream-canary.yml/badge.svg)](https://github.com/epigos/ghana-data-mcp/actions/workflows/upstream-canary.yml)

An MCP server that gives AI tools access to public Ghana data — share prices from the
Ghana Stock Exchange, treasury data from the Bank of Ghana, official national
statistics from the Ghana Statistical Service, and macroeconomic indicators from the
IMF. It runs on Cloudflare Workers as a remote MCP server over
Streamable HTTP.

## Tools

Fifteen tools, all read-only, namespaced by source.

**Ghana Stock Exchange** — [full reference and sample queries](docs/GSE.md)

| Tool | Returns |
| ---- | ------- |
| [`gse_get_stock_history`](docs/GSE.md#gse_get_stock_history) | Daily prices and volume for one share code, back to 2007 |
| [`gse_rank_stocks`](docs/GSE.md#gse_rank_stocks) | Rank the whole exchange, or compare a basket, by return, price change, volume or turnover |
| [`gse_list_companies`](docs/GSE.md#gse_list_companies) | Every listed company: share code, name, board, listing date |
| [`gse_search_company`](docs/GSE.md#gse_search_company) | Best-matching companies for a name, with a confidence score |
| [`gse_get_market_index`](docs/GSE.md#gse_get_market_index) | Market-wide GSE Composite Index, market cap, GSE-FSI, volume |
| [`gse_list_fixed_income_issuers`](docs/GSE.md#gse_list_fixed_income_issuers) | Corporate bond issuers on the Ghana Fixed Income Market |

**Bank of Ghana** — [full reference and sample queries](docs/BOG.md)

| Tool | Returns |
| ---- | ------- |
| [`bog_get_interbank_fx_rates`](docs/BOG.md#bog_get_interbank_fx_rates) | Cedi reference rates against 19 currencies — latest day, or history to 1996 |
| [`bog_get_treasury_bill_rates`](docs/BOG.md#bog_get_treasury_bill_rates-and-bog_get_central_bank_bill_rates) | Government of Ghana bill, note and bond rates, back to 2013 |
| [`bog_get_central_bank_bill_rates`](docs/BOG.md#bog_get_treasury_bill_rates-and-bog_get_central_bank_bill_rates) | The Bank of Ghana's own bill rates, back to 2016 |
| [`bog_get_interbank_interest_rates`](docs/BOG.md#bog_get_interbank_interest_rates) | Interbank weighted average, reverse repo and depo rates, back to 2002 |

**IMF** — [full reference and sample queries](docs/IMF.md)

| Tool | Returns |
| ---- | ------- |
| [`imf_list_indicators`](docs/IMF.md#imf_list_indicators) | Search ~130 macroeconomic indicators by keyword; returns the code each needs |
| [`imf_get_indicator_history`](docs/IMF.md#imf_get_indicator_history) | Time series for one or more indicators — GDP, inflation, debt, and more — for Ghana and, optionally, other countries, regions or groups |

**Ghana Statistical Service** — [full reference and sample queries](docs/GSS.md)

| Tool | Returns |
| ---- | ------- |
| [`gss_list_tables`](docs/GSS.md#gss_list_tables) | The 16 official StatsBank macroeconomic tables, filterable by keyword or sector |
| [`gss_describe_table`](docs/GSS.md#gss_describe_table) | One table's filterable dimensions, the values each accepts, and which periods are published |
| [`gss_get_data`](docs/GSS.md#gss_get_data) | Observations for a table — official CPI for Ghana and all 16 regions, GDP, debt, fiscal, money, rates, trade and more |

Plus `ping` — no input, returns `{ ok, server, version }`. It belongs to no source and
touches nothing upstream, which makes it a clean connectivity check.

### Is the data fresh?

Every result carries a `meta` block:

```json
{ "origin": "live", "ageSeconds": 0, "skippedRows": 0 }
```

| `origin`      | Means                                                                 |
| ------------- | ---------------------------------------------------------------------- |
| `live`        | Just fetched from the source site                                     |
| `cache`       | A fresh cached copy; `ageSeconds` says how old                        |
| `stale-cache` | The fetch failed, so an expired copy was served                       |
| `static-seed` | The fetch failed entirely and a built-in fallback list was used       |

`stale-cache` and `static-seed` always set `meta.warning`. Nothing is ever presented as
fresh when it isn't. Each source's guide lists which origins its tools can return and
how long each stays fresh.

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

The transport is Streamable HTTP and there is no authentication — the data is public, so
there is no API key to configure. Any MCP client that speaks HTTP will work.

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

**Anything else** — point it at `/mcp` and let it negotiate. There is also a plain
`GET /health` that needs no MCP client:

```bash
curl http://localhost:8787/health
```

Swap `localhost:8787` for your `workers.dev` URL once [deployed](#deploying) — or, for
the hosted copy, use `https://ghana-data-mcp.epigos.workers.dev/mcp` directly, no setup
required. The root URL itself (`/`) serves a landing page (tools, setup, sample chat
queries) rather than JSON — that's `public/index.html`, served by Cloudflare's static
assets, not the Worker code.

### Try it

Confirm the connection with a question that fetches nothing:

> Use the ping tool on the ghana-data server.

Then something real:

> What has MTN Ghana's share price done this month?

> What are the best performing stocks on the GSE right now?

> What is the cedi trading at against the dollar?

> What is the current 91-day Treasury bill rate in Ghana?

> What has the IMF forecast for Ghana's GDP growth next year?

> What is Ghana's official inflation rate, and is it worse in the north?

Each source's guide has a fuller set, chosen to exercise its tools and the awkward parts
of its data — [GSE](docs/GSE.md#sample-chat-queries),
[Bank of Ghana](docs/BOG.md#sample-chat-queries), [IMF](docs/IMF.md#sample-chat-queries),
[Ghana Statistical Service](docs/GSS.md#sample-chat-queries).

## Deploying

1. Create your own KV namespace — the id in `wrangler.toml` belongs to the maintainer's
   account and will not work in yours:

   ```bash
   npx wrangler kv namespace create GSE_CACHE
   ```

   Paste the id it prints over the `id` under `[[kv_namespaces]]`.

2. Deploy:

   ```bash
   npm run deploy
   ```

No secrets and no authentication — the data is public. It fits comfortably in the Workers
free tier: KV absorbs the repeat queries, and the fetches are I/O-bound, so billed CPU
time stays low.

## How it works

```
MCP client ──► Worker /mcp ──► sources/{gse,bog,imf,gss} ──► lib/{http,cache,rateLimit} ──► source site
                                                            │
                                                       Workers KV
```

MCP is served at `/mcp` by the Cloudflare Agents SDK's stateless handler, so there is no
Durable Object to deploy: every tool is an independent read-only fetch with no session
state worth keeping.

Each source owns a folder under `src/sources/` with the same internal shape —
`client.ts` talks upstream, `parser.ts` is pure transformation, `tools.ts` registers the
MCP tools — and shares the infrastructure in `src/lib/`. Both sites publish through the
same WordPress table plugin, so that client lives in `lib/wpDataTables.ts` and serves
both. Adding a source is documented in [CONTRIBUTING.md](CONTRIBUTING.md).

### Caching

Cached in Workers KV, with the freshness window stored *inside* the value and a 30-day
retention on the entry itself. That is what makes the stale fallback possible: if KV
expired entries at the TTL there would be nothing left to serve when a fetch fails.

Tools try, in order: a live fetch, a fresh cached copy, an expired cached copy, and —
where a source provides one — a built-in seed list, reporting which they used in
[`meta.origin`](#is-the-data-fresh). A partial failure degrades partially: if one company
table fails while another succeeds, the directory returns what it got plus a warning
naming what is missing.

Per-source cache keys and TTLs are documented with the source.

### Being a good citizen upstream

- A descriptive `User-Agent` naming the project, linking to this repo.
- Cache-first, so repeat questions never reach the source site.
- Jittered exponential backoff on 403/429/5xx instead of retrying immediately.
- An inbound per-IP limit of 30 requests/minute, so a looping client cannot turn into a
  load problem for someone else's website.

## Testing

```bash
npm test          # unit tests, no network
npm run typecheck
npm run test:live # optional: hits gse.com.gh, the IMF API and StatsBank to catch upstream changes
```

The unit tests run against saved fixtures in `test/fixtures/`, so CI never depends on a
third-party site being up. `test:live` is the canary for upstream changes and is skipped
by default.

**One local-development caveat.** StatsBank negotiates TLS 1.2 with CBC-only cipher
suites and no AEAD. Cloudflare's production runtime and Node both connect to it fine,
but local `wrangler dev` has no cipher in common with it — so every `gss_*` call needing
the network fails under `npm run dev` with `Network connection lost`, while working on the
deployed Worker. It is a limit of the local runtime, not something this code can fix.
Run the dev server on Cloudflare's edge instead:

```bash
npx wrangler dev --remote
```

Details, and the other ways round it, in
[docs/GSS.md](docs/GSS.md#a-note-on-local-development).

### CI

| Workflow | Trigger | Does |
| -------- | ------- | ---- |
| [`ci.yml`](.github/workflows/ci.yml) | push to `main`, PRs, manual | Typecheck + unit tests on Node 22 and 24, plus a `wrangler deploy --dry-run` bundle check |
| [`upstream-canary.yml`](.github/workflows/upstream-canary.yml) | 16:30 UTC Mon & Thu, manual | The live tests against gse.com.gh and the IMF DataMapper API |

The split is the point: CI stays green or red on **our** code, never on whether a source
site happens to be up. Neither workflow needs a secret.

BoG's live tests run separately, via `npm run test:live:bog`.

## License

MIT
