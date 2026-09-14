# ADR-lite: collection creation statistics on Admin home

Status: proposed with #823; implementation stays in an unmerged demo PR.
Context: ADR-0019 semantic storage and optional Admin composition.

Add one optional `EntryReader.readCreationStatistics` read. SQLite/D1 implements
it; custom adapters without it return an explicit unavailable state in Admin.
The staff guard runs before storage access, and successful responses are private,
no-store. The endpoint accepts only primary, visible collections and four range
presets. No manifest keys, generic aggregation language or new cache port.

Each card independently persists its range and interval/cumulative mode in
`cms.preference.collection-statistics.<collection>`. Only preferences enter
localStorage. The chart and CSV describe current retained rows by native
`createdAt`, all statuses, with current `uiSchema.list.filterField` classification.
Unknown values share an Other series. Deleted rows are absent: these are creation
cohorts of retained rows, not an event log or historical inventory. Cumulative
means a prefix sum inside the selected range, starting from zero.

Ranges are 1h/5m, 24h/1h, 7d/6h and 20d/1d. Every interval is half-open; the last
ends at the observation time. CSV uses ISO UTC bounds while chart labels use the
browser's timezone. SVG steps preserve exact bucket extents without interpolation.
The toolbar download exports the current card's mode, current total and series;
CSV cells are quoted and formula-shaped headers are neutralized.

## Aggregation and freshness

A single SQL statement returns a total and sparse grouped counts from one SQLite
snapshot. `entries(collection, created_at)` is prepared by canonical migration
0008. The range branch searches the index, and the total branch counts index
entries. Payload JSON stays in the database; only count rows reach the Worker.

The existing Cloudflare KV decorator caches MCP site configuration, not entry
queries. Reusing that key/projection would mix unrelated data and mutation
ownership. Direct aggregation is sufficient for this demo: Wrangler-local with
10,000 rows returned 897 bytes with one statement, 30,002 engine rows read and
p50/p95 of 4.26/5.80 ms (10 samples). A real SQLite test also aggregates 50,000
4-KiB rows into at most 40 count rows / 4 KiB and verifies immediate updates and
deletes. These are local measurements, not remote latency guarantees.

There is no server statistics cache to evict or repopulate after a racing write.
Every Admin/MCP/Procedure committed write is visible on the next read, including
subtype updates and deletes. React Query data stays in memory, becomes stale
immediately, and refetches on mount/focus and every 60 seconds while the home is
active. Successful UI mutations invalidate its common statistics query prefix.
Changing only cumulative mode reuses the same count data without another query.

`ponytail:` exact totals still take O(N) index work and filtered time ranges may
read JSON for subtype grouping; returned bytes are bounded by bucket/enum count,
not row count. If measured production read volume makes this expensive, add a
transactionally maintained collection revision/projection and revision-keyed KV
snapshots. Plain KV delete-after-write is insufficient because eventual
consistency and racing miss fills can serve old aggregates. No cron, event store,
generic cache framework or eager write-through aggregate is justified here.

## Verification

Runtime SQLite tests cover lower/upper edges, unknown subtype, collection
isolation, zero rows, edits/deletes, invalid windows, range index use and 50k rows.
Admin tests cover 401/403 before storage, invalid collection/range (including
prototype names), all presets, no-store, and unsupported adapters. UI tests cover
all preference combinations, zero filling, stacking, prefix sums and CSV safety.
Browser QA covers independent per-card preferences, reload, both themes and CSV.
