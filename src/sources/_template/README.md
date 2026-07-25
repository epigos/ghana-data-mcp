# Source template

Copy this folder to `src/sources/<name>/` to add a Ghana data source. See
[CONTRIBUTING.md](../../../CONTRIBUTING.md) for the full walkthrough.

The split exists so each file has one job and only `client.ts` ever touches the
network — which is what keeps `parser.ts` testable offline:

| File        | Responsibility                                                     |
| ----------- | ------------------------------------------------------------------ |
| `client.ts` | Talks to the upstream site. No parsing, no MCP, no caching.        |
| `parser.ts` | Pure functions from raw response → typed rows. Fully unit-tested.  |
| `types.ts`  | Zod schemas shared by the parser and the tool output schemas.      |
| `tools.ts`  | Registers MCP tools, applies caching, formats results and errors.  |

Every tool name must be prefixed with the source namespace (`gse_`, `bog_`, …).
