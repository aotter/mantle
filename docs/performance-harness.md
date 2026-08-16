# Data access, cache policy, and performance harness

Mantle site code declares intent; Core owns the shared storage layout and the
Cloudflare adapter owns provider bindings. A site-building agent should not
need Mantle table names, generated-column names, KV prefixes, or D1 APIs to
make a normal content/API/page change.

## Ownership

| Read or state | Owner | Notes |
|---|---|---|
| Entry get/list and public slug/data-field/published reads | `DatabaseEntryRepository` through `EntryRepository` / `EntryReader` | Schema-aware field resolution is shared here. |
| Manifest View execution | `ExecuteViewUseCase` + prepared `ViewQueryExecutor` | Core owns authorization and request validation; selected storage lowers queries once and resolves declared Schema indexes. |
| Editable settings and code-owned locale/media policy | `DatabaseSiteConfigRepository` | Editable values and dynamic media tool policy are read fresh; boot-seeded locale policy may be memoized within the runtime instance. |
| Pending media uploads | `DatabasePendingUploadRepository` | Canonical, read-after-write D1 state; never publish-cache state. |
| Rendered HTML, Markdown, and `llms.txt` | Request-time render use cases plus the Cloudflare public-route cache policy | D1 is canonical; version-local Workers Cache stores anonymous HTTP responses. |
| D1 transport and optional query metrics | Cloudflare bindings | Bindings stay thin. Query/cache policy does not belong in a generic provider `BaseRepository`. |

`CmsRuntime.db` remains deprecated compatibility surface. New site code uses
Manifests, runtime use cases, `entryReader`, and `siteConfig`. A site may own
additional tables behind its own repository at the composition root, but it
must not query Mantle-owned tables through `runtime.db`.

## Cache contract

- D1 is canonical for entries, site settings, media metadata, and pending
  uploads. Core stores no rendered artifact copies.
- Public routes render canonical state and return
  `Cache-Control: public, max-age=0, s-maxage=300`.
- Cloudflare Workers Cache checks eligible anonymous responses before invoking
  the Worker. Cache keys are version-local, so a deploy starts with no stale
  response from the previous Worker version.
- Successful publishing-content and site-setting writes purge the shared
  `mantle-public` Cache-Tag through Cloudflare's native cache API. Operational
  records and immutable assets stay outside that invalidation boundary.
- Do not cache every repository read. Cross-isolate correctness for editable
  data wins unless a read has a measured hot-path contract and explicit
  invalidation.

## Index coverage

The Node harness uses the real canonical migrations, generated Schema DDL,
real View compiler, deterministic skewed rows, and SQLite
`EXPLAIN QUERY PLAN`:

```bash
pnpm exec mantle-harness indexes --manifests ./manifests --format text
pnpm exec mantle-harness indexes --require-public --format json
pnpm exec mantle-harness indexes --require account-members --format json
```

Without `--require-public` or `--require`, findings are advisory. A required
path fails on an `entries` table scan, a temporary ORDER BY B-tree, or a
data-field predicate/order that does not use a declared Schema index.
Projection alone does not require an index. `mantle validate` remains a pure
correctness check; no performance grammar or manifest atom was added.

Use the machine report in CI. It includes the compiled SQL and parameters,
query-plan details, named indexes, scan/sort flags, result count, SQLite
version, fixture row count, and required-failure summary.

## Worker/API/page sampling

Sample any running environment with the public HTTP helper:

```bash
pnpm exec mantle-harness http \
  --base-url http://127.0.0.1:8787 \
  --route recent=/api/views/recent-posts \
  --route page=/en/posts/hello \
  --rounds 20 --warmup 2 --format json
```

Timing always reports p50/p95/max. A test-only Worker wrapper may also return
`x-mantle-query-count` and `x-mantle-rows-read`; those become distributions in
the same report. Do not expose these diagnostic headers in production.

Core CI runs `pnpm bench:wrangler` against real Wrangler-local D1, Worker HTTP
routing, View execution, and origin page rendering. It compares 100 and 10,000
row fixtures and gates row-read scaling plus endpoint query budgets, not
absolute milliseconds. Wrangler-local does not emulate the new entrypoint
Workers Cache, so cache hits are a deployment-level smoke check rather than a
fabricated local metric.

## Seven findings: measured disposition

Measured on the deterministic 2026-08-01 Wrangler-local fixture; timings are
diagnostic, while query/row counts are the stable assertions.

| Finding | Disposition |
|---|---|
| Public cache hits read D1 first | Removed from Worker code. Cloudflare's entrypoint Workers Cache runs before the Worker; Core has no inner render cache. |
| Slug/locale reads bypass generated indexes | Fixed by the shared schema-aware entry-read boundary. A 10,000-row page MISS measured 2 queries / 5 rows read. |
| OFFSET pagination | Accepted for the v0.1 bounded-result surfaces: every response is capped at 500 rows and public hot paths must stay shallow. Deep/export workloads require a purpose-shaped cursor API before they are declared hot. |
| Admin substring search scans | Accepted only for the authenticated Admin collection browser, with a 500-row response cap. Large/search-heavy sites should add a purpose-shaped indexed View or dedicated search service; do not expose this scan publicly. |
| Published list/sitemap/llms paths lack system indexes | Fixed with measured partial indexes for published global, locale, collection, and collection+locale ordering. The 100-row and 10,000-row API runs both measured 1 query / 20 rows read. |
| Page MISS waits for cache write-back | Removed. Origin rendering returns directly; Workers Cache owns response storage outside the Worker. |
| Benchmark stops at fake in-process dispatch | Fixed by the Node planner and Wrangler-local Worker/API/page layers. The old dispatch microbenchmark remains a narrow CPU signal only. |

The retained OFFSET and substring-search trade-offs are visible exceptions,
not patterns for new public APIs. Re-measure before widening either scope.

See also [Schema indexes](./schema-indexes.md) and the official Cloudflare
[D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).
