# ADR-0025: Reserved native column names and published-only public Views

**Status:** Accepted

**Date:** 2026-09-22

**Related:** [#962](https://github.com/aotter/mantle/issues/962),
[#1007](https://github.com/aotter/mantle/issues/1007),
[#1008](https://github.com/aotter/mantle/issues/1008),
[#1009](https://github.com/aotter/mantle/issues/1009),
[#1010](https://github.com/aotter/mantle/issues/1010),
[ADR-0022](0022-caller-observed-version-occ.md),
[ADR-0024](0024-manifest-native-schema-tables.md)

## Context

Every entry carries six native columns outside `data`: `id`, `status`,
`version`, `createdAt`, `updatedAt`, `authorId`. Before this decision the
grammar treated their names inconsistently:

- A Schema data property could reuse one of the names. The SQLite dialect then
  resolved the name to the data column first; IndexedDB resolved it to the
  native field first. The same View read different columns on different
  storage.
- `Schema.spec.indexes` could not reference the names at all
  (`SCHEMA_INDEX_INVALID`), while the runtime's own indexes lead with
  `_mantle_status`.
- A public View over a `publishing` Schema hid drafts only when the author
  wrote `filter: eq status published`. The handbook promised drafts are
  unreadable until published; nothing enforced it on REST, MCP
  `query_view_*` or WebMCP, which share one compiled plan.

The #962 soak measured the consequence of the second point: the list View
read 14,940 rows per request on a 10,991-row D1 table. Without planner
statistics, which production SQLite-family storage never has, SQLite chose
the runtime's `(_mantle_status, _mantle_updated_at, _mantle_id)` index for the
status equality and sorted every published row in a temporary B-tree; the
declared `[publishedAt]` index was never used, and the grammar refused the
`(status, publishedAt)` index that would have served the query.

Two alternatives were considered and rejected during review (#1008):

- **Core derives indexes from Views.** Rejected: the manifest is a deployment
  spec; Mantle Core is not a query optimizer, and a derived index has no
  owner when a View is deleted.
- **Explicit object references** such as `{ meta: status }` /
  `{ field: publishedAt, direction: desc }`. Deferred: it adds a grammar shape
  to solve an ambiguity that reserving the names removes, and no shipped View
  needs mixed-direction ordering. It remains the upgrade path.

A data-first resolution rule with only `status` reserved was also rejected: an
index declared as `[[createdAt]]` would silently change meaning when a data
property `createdAt` is added later, while the index identity (field-name
hex) kept the old physical index.

## Decision

1. **The six native column names are reserved.** A Schema data property may
   not use them; `mantle validate` fails closed with
   `INVALID_MANIFEST_ENVELOPE` at `/spec/schema/properties/<name>`, the same
   mechanism ADR-0022 uses for `expectedVersion`. Domain names replace them
   (`submittedAt`, `orderStatus`, `submittedBy`).
2. **Every storage resolves a native name to the native column, first.** With
   shadowing rejected this is a no-op for valid manifests; it is stated so the
   SQLite dialect, IndexedDB and the index DDL cannot drift apart again.
3. **`Schema.spec.indexes` may reference native names**; the SQLite dialect
   maps them to `_mantle_*` columns in `CREATE INDEX`. `uniqueIndexes` may not:
   native columns carry no domain uniqueness. Tuples stay `string[][]`; no
   direction, no object form.
4. **The author declares the access path; Mantle measures it.** A public View
   over a `publishing` Schema always carries `status = published`, so its
   index leads with `status` (`indexes: [[status, publishedAt]]`). Core does
   not synthesize that index. The harness and the D1 inspector (#1010) report
   whether the declared index is used.
5. **Public Views over `publishing` Schemas read published rows only, fail
   closed.** The linker injects `status = published` into the compiled plan
   whether or not the manifest writes it; an authored identical predicate is
   redundant and kept; any other `status` comparison on such a View is
   `VIEW_PUBLIC_STATUS_INVALID`. Staff Views, `operational` Schemas and SQL
   Views are untouched.

## Consequences

- Breaking for manifests that declared a data property with one of the six
  names; the official examples and tests were renamed (#1009). Storage is
  additive: the renamed property is a new column and the old one stays until
  an explicit migration. The 0.1.3 release entry carries the upgrade note.
- The semantic fingerprint of any plan with a public publishing View changes
  once (the injected predicate); `mantle generate` regenerates it.
- Index identities of existing declarations are unchanged; native-name tuples
  get new identities. Stale indexes left behind by redeclaration are tracked
  separately (#1011).
- Verified on real D1 without `ANALYZE`: the list View reads 50 rows per
  request with `[status, publishedAt]` and 10,000 without it (#1014).

## Where this lives

The handbook is the single source: [`reference/schema.md`](../handbook/reference/schema.md)
(reserved columns, index rules), [`reference/view.md`](../handbook/reference/view.md)
(surfaces). Skills and CLI diagnostics point there; they do not restate the
rules.
