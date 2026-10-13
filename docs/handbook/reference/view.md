# View

A View requires `surface: public | staff | internal` and one `sql` SELECT. Optional keys include title, description, input, requires, uiSchema (staff only), and cache. The app imports its generated typed function and supplies a native handle, verified Caller and driver-ready input.

## SQL

PostgreSQL syntax is parsed and checked at generation. Reads may reference declared Schemas, CTEs and reusable internal Views; no auth/system tables or arbitrary external relations. The compiler adds scope, TTL, publication and translation-parent visibility at every relation. SQL policy is not injected at request time.

SQLite supports the compiler's subset: scalar expressions, comparisons, AND/OR/NOT, CASE, COALESCE, supported casts, INNER/LEFT JOIN, subqueries, grouping/aggregates, supported windows, ordered LIMIT, date operations and declared Mantle search/geo functions. PostgreSQL additionally supports recursive CTEs, lateral relations, more window/aggregate forms, ILIKE and jsonb operators where the allowlist permits them. Unsupported SQL fails with a source position; generation is the authority for each target.

OFFSET, arbitrary functions/relations, DDL and transaction control are not a read escape hatch. Use keyset paging. Select latitude/longitude explicitly instead of native geo projections.

## Search and totals

Views using `mantle.search`, Store search and Admin list search share the dialect search: SQLite/D1 use FTS for queries of 3 or more characters (shorter queries use LIKE); PostgreSQL uses ILIKE over the declared fields and scans by default. A View does not make PostgreSQL search faster. For large PostgreSQL tables, the application's agent adds trigram indexes in a migration, which ILIKE then uses with no code change:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX articles_title_trgm ON articles USING gin (title gin_trgm_ops);
```

Store keeps `find`/`first` search and `count`. `count` scans every matching row; for large tables or frequently shown totals, use an internal View with indexed predicates or avoid exact totals. Aggregates still scan matching rows. See [Store reads](../guides/typed-queries.md#store-reads-and-writes).

## Results and paging

Each SELECT output needs a unique static name. Unquoted SQL identifiers fold to lower case; use an explicit quoted alias to preserve case (`r.reqStatus AS "reqStatus"`). Generation warns when an unaliased direct declared field would use its lower-case storage name. Declared-column lineage supplies generated types; computed outputs remain native/unknown. SQL formats declared date-time/date outputs, while computed timestamps retain driver values. See [native execution](../guides/native-execution.md).

Bare `views/<encoded-name>.ts` returns row arrays. Proved pageable exposed/internal Views also receive native `paged/views/*`, returning `{ rows, nextCursor? }`. Selected REST/MCP boundaries use separate `paged/wire/views/*` SQL when declared integers require exact transport projections; bare modules also export `WireRow`. Indexed ordering after fixed equality prefixes, non-null typed keys, complete groups and singleton joins/lookups are checked at generation. Unsupported internal paging retains its bare View; exposure requires a supported page contract. Aggregates still scan/group their sources: inspect EXPLAIN.

Internal Views have no public route/tool. Public and staff Views use selected REST/MCP/Admin bindings. `uiSchema.list` selects staff search/filter/display metadata. See [surfaces](surface.md) for validation, paging and wire conversions and [typed queries](../guides/typed-queries.md) for a complete example.
