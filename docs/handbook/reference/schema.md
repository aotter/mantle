# Schema

A Schema declares one table and its typed Store collection. Required keys are title and an object JSON Schema. Optional keys include lifecycle, scope, lock, TTL, indexes, uniqueIndexes, checks, searchableFields, localized, translates and uiSchema. Unknown keys fail validation.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  lifecycle: operational
  scope: "owner = auth.uid()"
  uniqueIndexes: [[owner, orderNumber]]
  searchableFields: [orderNumber]
  checks: ["qty > 0"]
  schema:
    type: object
    additionalProperties: false
    required: [owner, orderNumber, qty]
    properties:
      owner: { type: string }
      orderNumber: { type: string }
      qty: { type: integer, minimum: 1 }
```

## Fields and storage

A string `pattern` needs a `maxLength`: generation bounds each regex's backtracking and, when it refuses one (`INVALID_PATTERN`), names the largest `maxLength` it accepts. Anchor patterns with `^` and avoid nested quantifiers such as `(-[a-z0-9]+)*`.

| Field | sqlite | postgres |
| --- | --- | --- |
| string | TEXT | text |
| date-time | integer microseconds | timestamptz |
| date | integer days | date |
| integer | INTEGER | int8 |
| number | REAL | float8 |
| boolean | 0/1 | bool |
| object/array | JSON text | jsonb |
| geo | lat/lng columns, R*Tree | lat/lng columns |

System columns include id, version, created_at, updated_at and author_id; publishing adds status/published_at. Initial DDL declares a field NOT NULL when an `operational` Schema lists it in `required` and it does not allow null; `default` never does, and no column gets a DDL `DEFAULT` ([server-maintained fields](#admin-uischema)). Do not declare reserved fields. Manifest native column names in indexes use camelCase (`createdAt`); generated Store/SQL use storage names (`created_at`). Scope is omitted from returned rows.

Declared date/date-time outputs are SQL-formatted strings (`YYYY-MM-DD`, UTC ISO with six fractional digits). Computed timestamps remain native. Inputs and other output scalars follow [the native contract](../guides/native-execution.md). Date conversion through JS Date loses microseconds.

Generated types constrain Store fields and writes; Store does not interpret a JSON Schema on each call. Validate untrusted inputs at the boundary. Selected Admin emits full/partial field checks; drafts may be incomplete, while publishing checks required data. Native constraints remain database-enforced.

## Row rules

Schemas default to operational. Publishing opts into draft/published/archived and generated admin/system transitions. Store cannot assign system columns or scope; generated policy fills them. See [lifecycle and locales](../concepts/lifecycle-and-locales.md).

Owner and field columns prefix every unique index in that order. User reads/writes see their own rows; anonymous reads see none. System callers bypass scope. TTL uses `{ field, expireAfterSeconds }` over a date-time field; expired rows become invisible but remain stored until a system sweep. TTL is not allowed on translations.

### Locks

`lock` freezes a row while a condition on it holds. It is a data-state invariant, not an authorization rule: it binds every caller, admins included.

```yaml
kind: Schema
metadata: { name: post_revisions }
spec:
  lifecycle: operational
  lock:
    - name: live_revision
      on: [update, delete]
      when: EXISTS (SELECT 1 FROM posts p WHERE p.current_revision = post_revisions.id)
      message: "This revision is live. Create a new revision and switch to it."
```

- `when` true means locked. It reads the existing row only (like RLS `USING`); new rows stay with `checks`. `on` lists `update` and/or `delete`; names are unique per Schema.
- A caller's update or delete of the Schema gets `AND NOT (<when>)` in its WHERE, beside scope and the version check, so the write stays one atomic statement. Several locks are ANDed. A NULL `when` refuses the write: a lock fails closed. An `ON CONFLICT DO UPDATE` carries the `update` locks too, as a set op: an upsert whose conflicting row is locked leaves it unchanged and returns no row for it, like `DO NOTHING`; use a row-classified `UPDATE` to have the refusal reported.
- It applies to the generic writes compiled by Core (Admin's generic patch and delete) and to caller-mode SQL Procedures' `UPDATE`/`DELETE` of the locked Schema. Only a trusted write (the system caller) bypasses it: the maintenance escape hatch, visible in code review.
- `when` allows the Schema's own columns, constants, comparisons (`=`, `<>`, `<`, `>`, `<=`, `>=`, `IN (…)`), `AND`/`OR`/`NOT`, `IS [NOT] NULL` and `[NOT] EXISTS (SELECT … FROM <declared Schema> [alias] WHERE …)`. It calls no function (`now()`, `auth.*`, aggregates, windows) and reads no `input.*`, so it holds the same for every caller and request. Inside a subquery every column is qualified: `p.current_revision` for the subquery's Schema, `post_revisions.id` for the locked row (an unqualified `id` would silently read `posts.id`). A subquery reads one Schema, without join, `WITH`, `GROUP BY`, `ORDER BY`, `LIMIT` or `DISTINCT`, and its alias may not hide the locked Schema's name. `when` is one expression: a trailing `ORDER BY`, `GROUP BY` or `LIMIT` is refused. The compiler gives each subquery relation a reserved `_mantle_lock_<n>` alias, so the alias of a write the lock guards can never capture its references (relation aliases starting with `_mantle` are refused in authored SQL).
- Subqueries read the stored rows, without the reader's scope, publishing filter or TTL: a referencing row the caller cannot see still locks.
- **Index rule.** Locks are index-proven reads, like [paged Views](#index-prefixes-for-paged-views): every guarded write runs them. Each `EXISTS` needs an equality (`=` to the locked row's column, an outer subquery's column or a literal, or `IN (<literals>)`) among its top-level `AND` terms on the first column of a declared index, unique index or `id` of its Schema. The example needs `indexes: [[current_revision]]` on `posts`; otherwise generation fails with `LOCK_INDEX_MISSING`, naming the index to declare. A condition on the locked row's own columns needs no index. An `OR` of correlations is not index-proven: split it into separate locks.

`localized` and `translates: { parent, on }` declare a translation child. Parent visibility and publication are retained, with matching scope where needed. Locale values stay plain strings.

## Indexes, checks and search

Indexes are ordered composite scalar/native columns. A paged View's `ORDER BY` must match an index on the base Schema after any fixed equality prefix ([index prefixes](#index-prefixes-for-paged-views)), ending with `id` as the tiebreak: `ORDER BY created_at DESC, id DESC` needs `indexes: [[createdAt, id]]` (generation reports `Missing index for ORDER BY ...` otherwise). Required operational fields are NOT NULL; publishing drafts may be incomplete. Store sortable types use indexed/non-null columns, with explicit nullable published_at support.

### Index prefixes for paged Views

Only equality fixes an index prefix: `col = input.x`, `col = 'literal'` and an `= auth.uid()` scope or restrict. A user-field term (`region IN auth.user('region')`, as a `scope` or `restrict`) binds a set of values, so it never fixes a prefix, even when the caller holds one value or `{ all: true }`: the statement is prepared for a set, and an `ORDER BY` after that column would read and sort all of the caller's rows on every page. With `scope: "region IN auth.user('region')"`, `indexes: [[region, orderNo, id]]` and `ORDER BY orderNo`, generation refuses the View, names the bounded order and links here. The bounded ways:

- `ORDER BY region, orderNo`, served by the same index: rows come back grouped by region. `region DESC, orderNo DESC` reads it backwards; on PostgreSQL confirm with `EXPLAIN` that no Sort remains. Every column added to the `ORDER BY` must be non-null and nameable in SQL; a `publishing` Schema field other than a user-field scope column can be null, and the `scope` owner column cannot be named, so the refusal then says this order is unavailable.
- A View input bound with equality, `WHERE region = input.region ORDER BY orderNo`: the input fixes the prefix, and the scope still applies. Every set-bound column before the ordered ones needs its own equality.
- For `{ all: true }` callers, an index on the equality-fixed columns, then the ordered columns, then `id`: `[orderNo, id]` here, `[tier, orderNo, id]` with `WHERE tier = input.tier`. It is not bounded for scoped callers, who scan the index and filter, and it does not help a View with any `restrict`, which [`{ all: true }` never lifts](view.md#restrict).

Declaring both indexes does not make one View bounded for every caller. System (trusted) reads drop scope terms, so a scope-first index such as `[owner, at]` is not a proved range scan for them.

`uniqueIndexes` accept declared fields only, never native entry columns such as `authorId`. For per-member uniqueness, declare a required string `member` field, write `member: caller.subject` in a handler, and use `uniqueIndexes: [[member, orderNumber]]`; do not take `member` from client input.

Publishing fields may be NULL in drafts even when required, so they cannot be View paging keys. Store accepts `published_at` ordering, but View paging rejects it. Use `ORDER BY id`, or keep the business date in an operational Schema as an indexed, required non-null field. See [View paging](view.md#results-and-paging).

`checks` are restricted SQL expressions over the table's columns, emitted in initial DDL. Native databases enforce them; bare database errors are not automatically mapped to input-validation failures. `searchableFields` defaults to none: Store and Admin list search then match the exact id only, and Admin's search box says so. Name the fields people search by, such as the list `primaryField` or a `title`; with Admin selected, `mantle generate` warns when a Schema has no `searchableFields` but has such a field that could be one (a plain string, not a date, date-time or reference). Searchable fields must be plain string fields. SQLite/D1 emit FTS5 trigram tables and maintenance triggers; PostgreSQL uses ILIKE. Short SQLite terms use LIKE. Store search additionally matches exact id and combines with row policy.

The runtime never creates, alters or checks tables. Initial DDL is for an empty database. Changed fields, checks, indexes and search DDL require [agent-owned native migrations](../concepts/runtime-and-adapters.md#schema-installation-and-migrations), including explicit data migration for destructive/type changes. Mantle drops nothing.

## Admin uiSchema

A property marked `readOnly: true` in the JSON Schema is server-maintained (a counter, a total): Admin's generic create stores its `default` whatever the input says, Admin edits ignore it, and only Procedures (or server code through the Store) change it afterwards. JSON Schema defaults are applied by Admin's generic create only, not by the Store or the database: initial DDL emits no `DEFAULT` for a field, so server code through the Store and a SQL Procedure that inserts the row set the field themselves. A root `readOnly: true` makes the whole Schema read-only in Admin: a generic Admin write is refused with 403 `AUTH_DENIED` (not a 409 version conflict).

`default` does not make a column NOT NULL; `required` does (in an `operational` Schema). For a server-maintained value that is never NULL, list it in both, `required: [name, total]` with `total: {type: integer, readOnly: true, default: 0}`: initial DDL declares `total` NOT NULL, Store and View row types read it as `number` rather than `number | null`, Admin's create still fills the default when the client omits it, and the Store's insert type requires server code to pass it. Without `required` the column stays nullable, and an INSERT that omits it stores NULL. Adding `required` to an existing table is a [migration](../concepts/runtime-and-adapters.md#schema-installation-and-migrations): backfill NULLs, then add NOT NULL.

`fields.<name>.widget` selects a built-in control (`textarea`); `list.primaryField`, `list.columns` and enum `filterField` select list presentation (operational Schemas only; a publishing Schema's list shows its title field and status); `nav.parentField` chooses the parent a child folds under (required when two or more required `id` references exist) and `nav.standalone` lists the child in the sidebar; `nav.group/order/hidden` place it in the sidebar ([sidebar](../guides/native-admin.md#sidebar)). `list.columns` must not repeat `list.primaryField` or itself (`SCHEMA_UI_INVALID`). Generation validates these against declared fields/indexes. Components that render a field, cell or record aside are not manifest references: they live in `defineAdmin` ([customising Admin](../guides/native-admin.md#customising-admin)), and a manifest that still names one (`widget: <extension>/<contribution>`, `widget` `options`, `list.cells`, `panels`) is refused. JSON Schema root `schema.readOnly: true` disables generic Admin writes, not declared Procedures; `uiSchema.readOnly` is rejected with `SCHEMA_UI_INVALID`. `x-mantle-ref` relates a field to another Schema id or single-field unique field. It is not a foreign key: the database does not check that the referenced row exists, and deleting that row leaves the reference dangling. Check existence in the write (a JOIN or `EXISTS` in the Procedure, with `handler.mustWrite` when a missing parent must be a 409) and guard deletes with `NOT EXISTS` ([SQL patterns](../guides/sql-patterns.md)).

See [Admin](../guides/admin-ui.md) and [diagnostics](diagnostics.md).

### Field scope

`scope` is one predicate of terms joined by `AND`: at most one `<column> = auth.uid()` and any number of `<column> IN auth.user('<field>')`, for example `scope: "tenant = auth.uid() AND region IN auth.user('region')"`. Scoped columns are required, non-null, and lead an index. The scope protects every SQL relation, Store, REST/MCP and native Admin access.

A caller whose value for a field is `{ all: true }` drops that field's term only; the other terms still apply. Generated SQL holds one statement per target and selects the form for each caller at run time; values are always bound parameters. Neither roles nor the admin layer widen a field scope or a translation parent's visibility. A Schema whose `x-mantle-ref` points to a field-scoped Schema must carry the same scope terms.

For inserts, one allowed partition autofills a missing value; multiple values require an explicit allowed partition, and missing/empty values fail with `AUTH_DENIED`. Callers holding `{ all: true }` and system callers always provide an explicit partition. A Procedure `INSERT … VALUES` follows the same rule for user callers, checked before any SQL runs: leave the partition column out to autofill a caller's single value, or take it from an input declared with the column's own type (`VALUES (input.region, …)`) or a matching literal, which must be inside the caller's set; any other expression there is refused. A Procedure that callers holding several values or `{ all: true }` use, such as an Admin create action, takes the partition as an optional input. `INSERT … SELECT` into a field-scoped Schema, and an insert into a Schema the target `restrict`s, run only for system callers, which this check does not cover: they name the partition themselves; use the scoped Store for user writes there. The partition is never writable through SET, including upsert and native Admin patch. An excluded id behaves like a missing row: reads return not found; Store update/delete and row-classified Procedure UPDATE/DELETE affecting zero rows return HTTP 409 (`CONFLICT`). Native Admin's visible-row pre-read returns 404 for either id. SQLite binds a JSON array; PostgreSQL binds a quoted, escaped array. Public Views over field scope warn that anonymous callers are refused.

#### References to a scoped Schema

A non-null `x-mantle-ref` value that points to a scoped Schema (field or owner scope) must name a row of that Schema the caller can read, matched on `id` or on the object form's `field`, and that row must have the same value as the child for every scope field the two share (`ADR-0034`: a reference between scoped Schemas stays inside one owner or partition). A Store insert or update, a Procedure `INSERT … VALUES`, `UPDATE … SET` or `DO UPDATE SET`, and native Admin's generic create and patch check it in the same statement; a missing, unreadable or other-partition parent behaves like a missing row: a single-row statement returns HTTP 409 (`CONFLICT`), and an `ON CONFLICT` insert or a set update writes nothing for that row. A caller holding several values or `{ all: true }` can still not point a child in one partition at a parent in another. `INSERT … SELECT` that writes such a reference runs only for system callers. A caller's `UPDATE … SET` or `DO UPDATE SET` of such a reference takes no subquery, which could read the parent's columns as its own. Trusted writes (system callers, `runtime.store`) are not checked, like the other row rules. NULL is always allowed; deleting a parent does not touch its children.

## Reserved entry columns

Every Schema row has native columns that a Schema must not declare as data properties: `id`, `status`, `version`,
`createdAt`, `updatedAt` and `authorId` (SQL `id`, `status`, `version`, `created_at`, `updated_at`, `author_id`).
Use a domain name for your own fields (`requestStatus`, `submittedAt`). Views read native columns and `spec.indexes`
can index them without declaring them; `uniqueIndexes` cannot include them. `status` and `published_at` belong to
the publishing lifecycle; `version` backs `expectedVersion`; `author_id` is the verified creator used by
`restrict: { <schema>: "author_id = auth.uid()" }`.

A seed or other SQL that inserts rows outside Mantle (`wrangler d1 execute --file seed.sql`) sets the native columns
itself: `id` (text, unique), `created_at` and `updated_at` (on SQLite and D1 integer microseconds since the Unix epoch,
e.g. `1767225600000000`; on PostgreSQL `timestamptz`), and on a publishing Schema `status` and `published_at`.
SQLite and D1 default an omitted `updated_at` to `0`, which Admin shows as 1970. Procedures and the Store fill every
native column for you; prefer them for fixtures. [Seed data](../guides/local-testing.md#seed-data) shows a complete
seed for each dialect.
