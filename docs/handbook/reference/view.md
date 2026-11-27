# View

A View requires `surface: public | admin | internal` and one `sql` SELECT. Optional keys include title, description, input, requires, restrict, uiSchema (admin only), and cache. The app imports its generated typed function and supplies a native handle, verified Caller and driver-ready input; a JSON input (an array read by `json_each(input.ids)`) takes its authored array or object, which the generated query serializes.

## SQL

PostgreSQL syntax is parsed and checked at generation. Reads may reference declared Schemas, CTEs and reusable internal Views; no auth/system tables or arbitrary external relations (memberships reach row policy as user fields; a listing reads the application's own Schema: [organization members and invitations](authorization.md#organization-members-and-invitations)). The compiler adds scope, TTL, publication and translation-parent visibility at every relation. SQL policy is not injected at request time.

The SQL each dialect accepts, for Views and Procedures alike, is listed in [the SQL reference](sql.md); [SQL patterns](../guides/sql-patterns.md) shows the common ones. Unsupported SQL fails with a source position; generation is the authority for each target.

`*` and `t.*` expand to the Schema's declared fields only. Select `id`, `version`, `created_at` and `updated_at` by name when a client needs them (a write's `expectedVersion`, a detail link, keyset paging).

OFFSET, arbitrary functions/relations, DDL and transaction control are not a read escape hatch. Use keyset paging. Select latitude/longitude explicitly instead of native geo projections.

## Restrict

`restrict` narrows one target by Schema: `restrict: { orders: "region IN auth.user('region')" }`. Each key is a Schema the SQL reads; each value uses the [scope](schema.md#field-scope) terms, and a `= auth.uid()` term only on `author_id` or that Schema's own owner column. The effective rule is the Schema's scope AND the restrict. `{ all: true }` never lifts a restrict term: such a caller is refused with `AUTH_DENIED`.

Unlike `scope`, a restrict may join its terms with `OR` and group them with parentheses; `AND` binds tighter, as in SQL (ADR-0046):

```
restrict := conj ( OR conj )*
conj     := factor ( AND factor )*
factor   := term | "(" restrict ")"
term     := <column> = auth.uid() | <column> IN auth.user('<field>')
```

`restrict: { documents: "author_id = auth.uid() OR org IN auth.user('ownerOrgIds')" }` shows a document to its creator or to an owner of its organization ([worked example](authorization.md#creator-or-organization-owner)). A value with `OR` or parentheses has at most 8 terms; a value of `AND` alone has no term limit. Each AND-chain keeps the rules above (one `= auth.uid()`, a column or field once); column names compare without case, as in SQL, so `org` and `ORG` are one column: an OR of the same term in two spellings is that one term, and an AND of them is refused. Generation rewrites the value to an AND of OR-clauses, which `describe` lists under `or`, and reports a mistake in a term once. Inside an OR-clause a missing or empty user field matches no row instead of being refused, so the clause's other terms decide; under [gateway mode](authorization.md#gateway-mode) only a field the host forwarded as `[]` does, and one the host did not forward at all is still `HOST_CONTRACT` (412). `{ all: true }` and anonymous callers are refused as before. Every column a restrict names, in any clause, is never `SET`. A Procedure `INSERT` into a Schema its restrict names with an `IN` term or an OR-clause runs only for system callers when that Schema has a field scope, and is refused at generation (`USER_FIELD_POSITION`) when it has none, exactly as with an `IN` term alone; a caller inserts such rows through the Schema's Store, which stamps `author_id` (a `= auth.uid()` term alone, on a Schema without a field scope, is stamped and does not refuse the INSERT). Generated output with an OR-clause requires bind capability `USER_REFS_V2`, so a runtime older than OR refuses to load it (`USER_REFS_VERSION`) rather than misread its binds. An OR-clause never fixes an index prefix: a paged View needs an index served by its other equalities ([index prefixes](schema.md#index-prefixes-for-paged-views)). A View or Procedure that reads a restricted View carries that View's restrict too, so composing never widens it. A View with `restrict` cannot use a shared cache.

## Search and totals

`mantle.search(<alias>, <text>)` matches the Schema's declared `searchableFields`, and `mantle.search_rank(<alias>)`
orders by relevance; qualify both with `mantle.`. An optional search reads
`WHERE p.active AND (input.q IS NULL OR mantle.search(p, input.q))`, and a ranked one
`WHERE mantle.search(p, input.q) ORDER BY mantle.search_rank(p), p.id`; page it with a cursor over the rank and the id.

Views using `mantle.search`, Store search and Admin list search share the dialect search: SQLite/D1 use FTS for queries of 3 or more characters (shorter queries use LIKE); PostgreSQL uses ILIKE over the declared fields and scans by default. A View does not make PostgreSQL search faster. For large PostgreSQL tables, the application's agent adds trigram indexes in a migration, which ILIKE then uses with no code change:

```sql
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX articles_title_trgm ON articles USING gin (title gin_trgm_ops);
```

Store keeps `find`/`first` search and `count`. `count` scans every matching row; for large tables or frequently shown totals, use an internal View with indexed predicates or avoid exact totals. Aggregates still scan matching rows. See [Store reads](../guides/typed-queries.md#store-reads-and-writes).

## Results and paging

Each SELECT output needs a unique static name. Unquoted SQL identifiers fold to lower case; use an explicit quoted alias to preserve case (`r.reqStatus AS "reqStatus"`). Generation warns when an unaliased direct declared field would use its lower-case storage name. Declared-column lineage supplies generated types; computed outputs remain native/unknown, except a top-level output that is a JSON document by construction (a JSON aggregate or builder, a scalar subquery of one, or a `COALESCE` of those; see [SQL patterns](../guides/sql-patterns.md#a-row-with-its-children-in-one-read)), which is typed JSON. Text composed with `||` or `COALESCE` only from text columns (a string field without a date or date-time format, `id`, `author_id`, a publishing `status`) and string literals is typed `string`: `||` is non-null when every operand is, `COALESCE` when any argument is (a literal counts). It is native text on every target, so no boundary converts it. Any other operand, including a number, a date-time, an input, a function call or a `CAST`, leaves the output `unknown`. An output is non-null (`string`, not `string | null`) only when it reads unchanged a column its table declares NOT NULL (`id`, `version`, `created_at`, `updated_at`, a publishing `status`, or a [required](schema.md#fields-and-storage) field of an operational Schema) directly or through FROM subqueries; the right side of a LEFT JOIN, an aggregate, a column beside an aggregate without GROUP BY, a CTE and any other expression stay nullable. SQL formats declared date-time/date outputs, while computed timestamps retain driver values. See [native execution](../guides/native-execution.md).

Bare `views/<encoded-name>.ts` returns row arrays. Proved pageable exposed/internal Views also receive native `paged/views/*`, returning `{ rows, nextCursor? }`. Selected REST/MCP boundaries use separate `paged/wire/views/*` SQL when declared integers require exact transport projections; bare modules also export `WireRow`. Indexed ordering after fixed equality prefixes ([index prefixes](schema.md#index-prefixes-for-paged-views)), non-null typed keys, complete groups and singleton joins/lookups are checked at generation. Unsupported internal paging retains its bare View; exposure requires a supported page contract. Aggregates still scan/group their sources: inspect EXPLAIN.

Publishing Schema fields may be NULL in drafts even when required, so public View paging cannot order by them. `published_at` is accepted by Store ordering but rejected as a View paging key. Use `ORDER BY id`, or keep the business date in an operational Schema as an indexed, required non-null field.

A public or admin View pages by its ORDER BY keys, so each is a column: a Schema field, `id` or a GROUP BY key. An internal View is not paged and may order by an expression. Core makes every ORDER BY total by appending the first relation's `id` as the last key. When the first relation in FROM is a subquery, a CTE or an internal View, it must output `id`; a grouped one cannot, so GROUP BY in the View's own SELECT, where Core appends the group keys instead.

Internal Views have no public route/tool. Public and admin Views use selected REST/MCP/Admin bindings. A public View can also be read at a path of your own, such as `GET /api/orders/{id}`, through a [GET Trigger](trigger.md#get-triggers-for-a-view), which refuses repeated and unknown query keys before any read. `uiSchema.list` selects admin search/filter/display metadata; `uiSchema.nav.group/order/hidden` places an admin View in the sidebar ([sidebar](../guides/native-admin.md#sidebar)). See [surfaces](surface.md) for validation, paging and wire conversions and [typed queries](../guides/typed-queries.md) for a complete example.
