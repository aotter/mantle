# ADR-lite: bounded public content and complete discovery

Status: implemented for #809; combined deployment measurements tracked in #812.
Context: ADR-0010 translation joins, ADR-0019 sealed semantic storage, #792 Web
transport/cache ownership. No manifest keys or remote Web SDK are introduced.

## Decision

Add the semantic `EntryReader.readPublishedPage` operation instead of silently
capping generic `readPublished`. Forward pages sort by updatedAt and id descending,
with default 50 / maximum 2,000 rows and a 1-MiB data-JSON budget. A single larger
entry remains readable and advances the cursor. This budget covers the selected
canonical data, excluding envelope bytes, joined parents, media and consumer HTML.
SQLite uses indexed, bounded candidates, a running byte sum and lookahead before
transfer to Worker memory. Exact locale plus shared entries are merged in SQL.
Selected data fields retain JSON types and use one bound JSON field list, including
for projections larger than D1's ordinary bind or SQL-function argument limits.

The optional Web use cases return an explicit page object. Cloudflare mounts
publish its continuation in a body link and `Link: rel="next"`. HTML lists include
accessible navigation. An empty intermediate/final llms page remains traversable.
Root llms reads each canonical page once and expands shared entries per locale
without repeated canonical reads. Unknown/unmapped/no-content rows consume their
place in the page; they do not prevent reaching later eligible rows.

Sitemap parts project path metadata and default to 2,000 entries, expanding shared
routes per locale. The index walks the same metadata-page boundaries as the parts,
so a byte-limited part cannot cause skipped URLs. Small sites keep a single urlset.
Additional routes appear only in the first part. A custom path resolver must declare
its required data fields to obtain projection; otherwise full bounded data remains
available. Protocol limits fail explicitly instead of silently truncating URLs.

Translation lists request only the newest published parent per join value. Storage
ranks matching IDs before loading their bodies, preventing duplicate historical
parents from multiplying transferred rows. Missing/draft parents leave the child
unchanged. Child data still wins and media resolution remains one batch per page.

## Limits and alternatives

Sitemap index generation is O(N) metadata work on an origin MISS. It retains one
page and the index's URL list rather than all entry bodies; the protocol permits
at most 50,000 parts. Persisted generation/part boundaries would require an explicit
publication/invalidation owner and are deferred until index traffic justifies it.
A hard `LIMIT 500` would lose discovery URLs and is rejected. Offset pages would
make deep traversal grow with depth and are rejected. Entry caching would leave
the cold materialization spike and stale-state questions unresolved.

Pages reflect live canonical state, not a cross-request snapshot: publishing or
changing sort keys during a crawl can move entries between pages. Browser-local
IndexedDB shares the semantic cursor and output budget but still scans a local
collection. Parent/media data and consumer template expansion have separate costs;
there is no promise that arbitrary consumer rendering fits 1 MiB.

## Verification

Real SQLite tests walk the 18 combinations of 100/10,000/50,000 rows, 64 B/4 KiB
body and 1/3/10 locales, comparing complete llms/sitemap URL sets. List transfer is
21 rows at limit 20 in every case; 50,000 mixed rows and 10 locales retain all
275,000 URLs. Tests cover tied sort keys, >1-MiB entries, JSON projection types,
missing projected keys, parent duplicates/missing/drafts, child overrides, media
batching and persistence-field privacy. HTTP tests walk visible continuations,
empty final pages, sitemap indexes and staff-only preview behavior. The portable
storage conformance suite checks new semantics across adapters.

Wrangler-local records native D1 query/row work for list, llms and sitemap alongside
existing readiness, View, Procedure and Admin gates. Node traversal CPU/RSS includes
fixture/assertion costs and is not reported as Worker CPU. Combined #812 evidence
will supply Worker CPU, heap, cache HIT/MISS, remote controls and placement results.
