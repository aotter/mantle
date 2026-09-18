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

The runtime exposes no raw database handle. Application and adapter code uses
the sealed plan, runtime use cases, `entries`, and `siteConfig`. An application may own
additional tables behind its own repository at the composition root, but it
must not query Mantle-owned tables outside the selected storage adapter.

## Cache contract

- D1 is canonical for entries, site settings, media metadata, and pending
  uploads. Core stores no rendered artifact copies.
- Public routes render canonical state and return
  `Cache-Control: public, max-age=0, s-maxage=300`.
- Cloudflare Workers Cache checks eligible anonymous responses before invoking
  the Worker. Cache keys are version-local, so a deploy starts with no stale
  response from the previous Worker version.
- Successful publishing-content and site-setting writes purge the shared
  deployment-scoped public Cache-Tag through Cloudflare's native cache API. Operational
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
path fails on a required Schema-table scan, a temporary ORDER BY B-tree, or a
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

The path-scoped Cloudflare benchmark workflow runs `pnpm bench:wrangler`
against real Wrangler-local D1, Worker HTTP routing, View execution, and origin
page rendering. It compares 100 and 10,000 row fixtures and gates row-read
scaling plus endpoint query budgets, not absolute milliseconds. It is separate
from the required repository checks so an unrelated dependency or docs PR does
not fail on the platform harness. Wrangler-local does not emulate the new
entrypoint Workers Cache, so cache hits are a deployment-level smoke check
rather than a fabricated local metric.

## Seven findings: measured disposition

Measured on the deterministic 2026-08-01 Wrangler-local fixture; timings are
diagnostic, while query/row counts are the stable assertions.

| Finding | Disposition |
|---|---|
| Public cache hits read D1 first | Removed from Worker code. Cloudflare's entrypoint Workers Cache runs before the Worker; Core has no inner render cache. |
| Slug/locale reads bypass Schema indexes | Fixed by the shared schema-aware entry-read boundary over native columns. A 10,000-row page MISS measured 2 queries / 5 rows read. |
| OFFSET pagination | Retained only where the View/Admin contract explicitly uses it, with a 500-row response cap. Public content lists and discovery now use forward keyset pages; they are not covered by the old 500-row claim. |
| Admin substring search scans | Accepted only for the authenticated Admin collection browser, with a 500-row response cap. Large/search-heavy sites should add a purpose-shaped indexed View or dedicated search service; do not expose this scan publicly. |
| Published list/sitemap/llms paths lack system indexes | Fixed with measured partial indexes for published global, locale, collection, and collection+locale ordering. The 100-row and 10,000-row API runs both measured 1 query / 20 rows read. |
| Page MISS waits for cache write-back | Removed. Origin rendering returns directly; Workers Cache owns response storage outside the Worker. |
| Benchmark stops at fake in-process dispatch | Fixed by the Node planner and Wrangler-local Worker/API/page layers. The old dispatch microbenchmark remains a narrow CPU signal only. |

The retained OFFSET and substring-search trade-offs are visible exceptions,
not patterns for new public APIs. Re-measure before widening either scope.

See also [Schema indexes](./schema-indexes.md) and the official Cloudflare
[D1 index guidance](https://developers.cloudflare.com/d1/best-practices/use-indexes/).

### Prepared database, new Worker state

The Wrangler fixture resets its in-isolate runtime after seeding while retaining
D1. The first public page has a four-statement budget (fingerprint, lazy locale,
site settings, entry); subsequent origin pages have a two-statement budget.
This is a new application state in the same workerd isolate, not a measurement
of module startup CPU or an entrypoint cache HIT. Locale caching is enabled by
a successful preparation fingerprint; editable settings and media policy still
read the canonical database on every call.

### HTTP Trigger routing

The portable request handler indexes Trigger paths by method and segments once.
Literal and wildcard branches retain sealed-plan order, including encoded literal
collisions that an outer router may select differently. Each request decodes its
segments once and invokes the original Trigger identity through the same runtime.
The 1/10/100/1,000-route regression uses four segment lookups at every size;
overlapping wildcard shapes can visit multiple branches, pruned by route rank.
The HTTP microbench and workerd harness include the same route-count axis.
Workerd wall times include I/O and are not CPU measurements or a fixed-ms CI gate.

### Public content pages and discovery (#809)

| Surface | Canonical read / continuation |
|---|---|
| Collection HTML and collection Markdown | 50 entries by default, forward `cursor`; visible Next link plus HTTP `Link: rel="next"`. |
| Locale and root llms.txt | One canonical page, default 50 entries; root expands that page across configured locales in memory. Shared entries are not reread once per locale. Follow the body/HTTP continuation link. |
| Sitemap part | Up to 2,000 entries, with only declared path fields (built-in resolver: `slug`). A small site returns a urlset directly; a larger site returns a sitemap index linking every part. |
| Sitemap index | Walks metadata pages to derive exact part cursors; O(N) metadata work on an index MISS, with one page resident at a time. It is not a constant-work list endpoint. |

`EntryReader.readPublishedPage` caps returned data JSON at 1 MiB and 2,000 rows.
One oversized entry is returned alone to make progress. SQLite applies the byte
budget before transferring/parsing JSON in the Worker; one extra candidate
identifies continuation. A localized + shared page merges two indexed ranges
inside the same statement. The original `readPublished` remains an explicit
unbounded read unless its caller supplies a limit.

Translation lists resolve at most one newest published parent per join value,
then resolve media once for the bounded list. Parent payloads and media metadata
are additional input; the 1 MiB budget describes the canonical child page, not
arbitrary template output or total Worker heap. Custom renderers own their output
size. IndexedDB keeps identical page semantics but currently scans its local
collection; this is not a claim of bounded IndexedDB storage I/O.

The real SQLite fixture matrix covers 100/10,000/50,000 published rows, 64 B/4 KiB
bodies, and 1/3/10 locales. At limit 20, every case transfers 21 candidate rows;
4 KiB body data occupies 87,003–87,129 bytes, independent of collection size.
Complete llms traversal uses 2/200/1,000 statements at the default 50-row page
size, independent of locale count. Sitemap and llms URL sets match, including
275,000 URLs for 50,000 mixed localized/shared rows across 10 locales.

Run `pnpm --filter @aotter/mantle-cloudflare exec vitest run
test/public-content-scaling.test.ts` to emit JSON transfer sizes and traversal
CPU/wall/RSS diagnostics. These are Node + SQLite + assertions, including the
fixture database and URL-validation set; RSS is a process high-water mark, not
per-request Worker peak memory. Worker CPU, true cache HIT/MISS and placement
measurements belong to the matched native/full-stack harness (#812).

The workerd smoke also measures public list, llms and sitemap. The first two
use two warm statements (settings + page) and bounded D1 work. Sitemap index
queries and rows-read scale with the number of metadata parts; this explicit
cost preserves complete discovery instead of silently dropping URLs.

### Request diagnostics (version 1, test/performance only)

Import `runWithRequestDiagnostics`, `instrumentD1`, `instrumentKv` and
`instrumentR2` from `@aotter/mantle-cloudflare/testing`. Wrap native bindings once
before handing the same D1 object to Auth and Runtime. Open the request context
outside the complete facade fetch, and pass binding-presence flags matching the
instrumented fixture. The observer receives one response-time record; it never
receives request headers, tokens, proofs, user IDs, SQL, parameters, tool arguments,
object keys or response content. Sync/async observer failure cannot change the
original response or exception. The library emits no diagnostic headers or logs.

Records distinguish HTTP outcome from JSON-RPC result/error/tool-error. They
include actual in-isolate arrivals, inclusive OAuth/DPoP, role, runtime, catalog,
dispatcher construction and dispatch wall spans. Unreached phases are null.
Shared KV loads charge native I/O once to the initiating request; waiters record
wait duration and the same hit/miss/repair/error source. Boot publication has a
separate counter. The original rejected shared load remains retryable.

D1 statements and binding calls are separate: a batch is one call and N attempted
statements. Failed attempts count. `exec` uses the provider's count; unavailable
counts stay in `unknownStatementCalls`, never a semicolon parser. `first(column)`
and `raw` preserve native behavior and do not silently execute `all` to manufacture
metadata. Their absent metadata is null. Rows/duration are sums of available
metadata, and `metadataStatements` identifies coverage; incomplete coverage is
not a full-workload total. Serialized binding results are measured bytes, not a
claim about bytes on the provider's wire. Existing D1DatabaseDriver observers can
request metadata for first-row reads when a fixture explicitly chooses that mode.

KV bytes identify UTF-8, buffer or reserialized JSON sources. R2 payload bytes
remain unknown for an unconsumed/partly consumed GET. A successful PUT of that exact
native GET stream confirms the transferred body size on both operations. Streams
are never wrapped or buffered for diagnostics, preserving R2's native known-length
contract. `byteSamples` distinguishes known payload samples from the operation
count. Metadata/list response serialization is labeled separately from object
payload. R2 coverage is head/get/put/delete/list, not multipart-upload instrumentation.

Snapshots freeze at response creation; outstanding/deferred operations remain
visible through `inFlight` and metadata coverage and cannot rewrite a published
record. `totalMs` excludes the subsequent test-only JSON-RPC response inspection,
delivery and deferred work. CPU, TTFB, full-body duration and heap must be measured
separately. Worker wall clocks advance on I/O and are not a CPU timer; use the
[official CPU profiler](https://developers.cloudflare.com/workers/observability/dev-tools/cpu-usage/).
Measure diagnostics off/on overhead with the same workload before interpreting
small latency differences.

### Matched native facade controls (#812)

`pnpm bench:wrangler` now also runs the native parity smoke. The full
`pnpm bench:parity` matrix adds real Auth/MCP, cold workerd processes, R2,
TTFB/full-body timing and CPU/heap evidence. See
[the controls, gates and reproducible commands](./adr/adr-lite-812-native-parity.md).
