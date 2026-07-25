# Contributing

The main thing this document exists to explain is **how to add a Ghana data
source**, because that is the shape the whole repo is built around.

## The namespace convention

Every MCP tool is prefixed with its source:

| Source                     | Prefix  | Example                 |
| -------------------------- | ------- | ----------------------- |
| Ghana Stock Exchange       | `gse_`  | `gse_get_stock_history` |
| Bank of Ghana (planned)    | `bog_`  | `bog_get_exchange_rate` |
| Ghana Statistical Service  | `gss_`  | `gss_get_indicator`     |

Two reasons it matters. A model choosing between thirty tools needs to see which
data source a tool belongs to from its name alone. And a prefix keeps a future
source from colliding with an existing tool name — `get_history` would be
ambiguous the moment a second source has history of its own.

## Adding a source

1. **Copy the template.**

   ```bash
   cp -r src/sources/_template src/sources/bog
   ```

2. **Implement the three files.** Keep the split — it is what keeps the parser
   testable without a network:

   | File        | Responsibility                                                    |
   | ----------- | ----------------------------------------------------------------- |
   | `client.ts` | Talks upstream. No parsing, no MCP, no caching.                   |
   | `parser.ts` | Pure functions: raw response → typed rows. No fetch, no clock.    |
   | `types.ts`  | Zod schemas shared by the parser and the tool output schemas.     |
   | `tools.ts`  | Registers tools, applies caching, formats results and errors.     |

3. **Register it** in `src/server.ts`:

   ```ts
   registerBogTools(server, { client: new BogClient(), cache });
   ```

4. **Save a fixture** of a real upstream response under `test/fixtures/` and
   test the parser against it. No unit test may touch the network.

5. **Add a live smoke test** under `test/integration/`, gated behind an env var
   like the GSE one, so upstream changes get caught without CI depending on
   someone else's uptime.

That is the whole checklist. `lib/` is shared and should not need changes.

## House rules

**Always fetch through `lib/http.ts`.** It applies the project User-Agent, the
timeout, and the jittered retry policy. A raw `fetch` skips all three and makes
us a worse guest on someone else's server.

**Cache through `readThrough`.** It gives you fresh-hit, live-load and
stale-fallback in one call, and it reports which happened.

**Label the origin.** Every result carries `meta.origin`. A cached, stale, or
seeded answer must never look like a live one — a caller acting on stale market
data should know that is what it has.

**Drop bad rows, don't fail the call.** One malformed row in three months of
history should not cost the caller the other eighty-nine days. Count what you
skipped and report it in `meta.skippedRows`.

**Don't parse what upstream stores as prose.** If a column holds free text —
mixed currencies, mixed units, typos — pass it through as a string and say so in
the schema. GSE's `statedCapital` is the cautionary example: `2.9 million`,
`600.000.000` and `GHS400milliion` all live in the same column, and any parser
confident enough to turn those into numbers will be wrong by a factor of a
million on some rows. Text a caller can see is approximate beats a number that
silently isn't.

**Use the right error type.** `UpstreamError` means the remote site let us down
and a retry may help; `ParseError` means the response shape was wrong and a retry
will not. Tools return `isError: true` with a readable message — never throw at
the client.

**Write tool descriptions for a model.** Say what the tool returns, in what
units, and which tool to reach for first. If a field name is misleading — as
`high`/`low` are for GSE, where they mean the 52-week extremes — say so in the
schema, not just in a code comment.

## Before opening a PR

```bash
npm test
npm run typecheck
```

If you changed anything touching upstream requests, also run:

```bash
npm run test:live
```

## Scraping etiquette

These sites publish data for the public but did not sign up to be an API. Cache
aggressively, back off on errors, keep the identifying User-Agent, and do not add
a tool that needs to hammer an endpoint to work.
