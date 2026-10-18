# View

A View requires `surface: public | admin | internal` and one `sql` SELECT. Optional keys include title, description, input, requires, restrict, uiSchema (admin only), and cache. The app imports its generated typed function and supplies a native handle, verified Caller and driver-ready input.

## SQL

PostgreSQL syntax is parsed and checked at generation. Reads may reference declared Schemas, CTEs and reusable internal Views; no auth/system tables or arbitrary external relations. The compiler adds scope, TTL, publication and translation-parent visibility at every relation. SQL policy is not injected at request time.

The SQL each dialect accepts, for Views and Procedures alike, is listed in [the SQL reference](sql.md); [SQL patterns](../guides/sql-patterns.md) shows the common ones. Unsupported SQL fails with a source position; generation is the authority for each target.

OFFSET, arbitrary functions/relations, DDL and transaction control are not a read escape hatch. Use keyset paging. Select latitude/longitude explicitly instead of native geo projections.

## Restrict

`restrict` narrows one target by Schema: `restrict: { orders: "region IN auth.user('region')" }`. Each key is a Schema the SQL reads; each value uses the [scope](schema.md#field-scope) grammar, and a `= auth.uid()` term only on `author_id` or that Schema's own owner column. The effective rule is the Schema's scope AND the restrict. `{ all: true }` never lifts a restrict term: such a caller is refused with `AUTH_DENIED`. A View or Procedure that reads a restricted View carries that View's restrict too, so composing never widens it. A View with `restrict` cannot use a shared cache.

## Search and totals

`mantle.search(<alias>, <text>)` matches the Schema's declared `searchableFields`, and `mantle.search_rank(<alias>)`
orders by relevance; qualify both with `mantle.`. An optional search reads
`WHERE p.active AND (input.q IS NULL OR mantle.search(p, input.q))`, and a ranked one
`WHERE mantle.search(p, input.q) ORDER BY mantle.search_rank(p), p.id` (see `examples/reference-service` `catalog.yaml`
for cursor paging over the rank).

Views using `mantle.search`, Store search and Admin list search share the dialect search: SQLite/D1 use FTS for queries of 3 or more characters (shorter queries use LIKE); PostgreSQL uses ILIKE over the declared fields and scans by default. A View does not make PostgreSQL search faster. For large PostgreSQL tables, the application's agent adds trigram indexes in a migration, which ILIKE then uses with no code change:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX articles_title_trgm ON articles USING gin (title gin_trgm_ops);
```

Store keeps `find`/`first` search and `count`. `count` scans every matching row; for large tables or frequently shown totals, use an internal View with indexed predicates or avoid exact totals. Aggregates still scan matching rows. See [Store reads](../guides/typed-queries.md#store-reads-and-writes).

## Results and paging

Each SELECT output needs a unique static name. Unquoted SQL identifiers fold to lower case; use an explicit quoted alias to preserve case (`r.reqStatus AS "reqStatus"`). Generation warns when an unaliased direct declared field would use its lower-case storage name. Declared-column lineage supplies generated types; computed outputs remain native/unknown. SQL formats declared date-time/date outputs, while computed timestamps retain driver values. See [native execution](../guides/native-execution.md).

Bare `views/<encoded-name>.ts` returns row arrays. Proved pageable exposed/internal Views also receive native `paged/views/*`, returning `{ rows, nextCursor? }`. Selected REST/MCP boundaries use separate `paged/wire/views/*` SQL when declared integers require exact transport projections; bare modules also export `WireRow`. Indexed ordering after fixed equality prefixes ([index prefixes](schema.md#index-prefixes-for-paged-views)), non-null typed keys, complete groups and singleton joins/lookups are checked at generation. Unsupported internal paging retains its bare View; exposure requires a supported page contract. Aggregates still scan/group their sources: inspect EXPLAIN.

Publishing Schema fields may be NULL in drafts even when required, so public View paging cannot order by them. `published_at` is accepted by Store ordering but rejected as a View paging key. Use `ORDER BY id`, or keep the business date in an operational Schema as an indexed, required non-null field.

Internal Views have no public route/tool. Public and admin Views use selected REST/MCP/Admin bindings. `uiSchema.list` selects admin search/filter/display metadata; `uiSchema.nav.group/order/hidden` places an admin View in the sidebar ([sidebar](../guides/native-admin.md#sidebar)). See [surfaces](surface.md) for validation, paging and wire conversions and [typed queries](../guides/typed-queries.md) for a complete example.
