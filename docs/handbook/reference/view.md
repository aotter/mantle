---
description: View field reference for Mantle 0.2.0 — the SQL SELECT and the dialect it accepts, input, surface, requires, uiSchema, cache, output names, paging and diagnostics.
---
# View

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: search-items }
spec:
  title: Search items          # optional, a string or a locale map
  description: …               # optional; the MCP tool's description
  surface: public              # public | staff | internal (required)
  requires: { … }              # optional, see Authorization requirements
  input:                       # optional JSON Schema object
    type: object
    required: [q]
    properties: { q: { type: string, minLength: 1 } }
  uiSchema: { list: { … } }    # optional, staff Views only
  cache: { sharedMaxAge: 60 }  # optional
  sql: |                       # required: one SELECT
    SELECT i.id, i.name, i.stock FROM items i
    WHERE mantle.search(i, input.q)
    ORDER BY mantle.search_rank(i), i.name
```

## `sql`

One `SELECT` in PostgreSQL syntax over declared Schemas. It reads
`input.<name>`, `auth.uid()`, `auth.role()` and `now()`. The runtime adds
scope, TTL and (on a public View) published-only to every Schema it reads;
never repeat them.

### What the D1 dialect accepts

The `sqlite` dialect (`@aotter/mantle/d1`) runs this subset on D1, on Bun's
SQLite and on any `sqliteStorage` driver.

| Area | Supported | Rule |
|---|---|---|
| Expressions | columns, aliases, literals, arithmetic, `\|\|`, `CASE`, `COALESCE`, `NULLIF`, `CAST` | `CAST(x AS int)` only for an integer literal: use `round(x)`. `CAST(x AS bool)` follows PostgreSQL's text rules; an integer has no cast to boolean on PostgreSQL: write `x <> 0`. `*` expands to declared fields; a bare `*` over a subquery or `json_each` is refused: name the columns |
| Conditions | comparisons, `AND`/`OR`/`NOT`, `BETWEEN`, `IS [NOT] NULL`, `IS DISTINCT FROM`, `IN (list \| subquery)`, `[NOT] EXISTS`, `LIKE … ESCAPE` | `LIKE` is case-insensitive (SQLite). An input array in `IN` binds once. A date-time, date or boolean column (and `created_at`, `updated_at`) is not compared with a bare string: write `CAST('…' AS timestamptz)`, `true`, or bind an input |
| Relations | one Schema, `INNER`/`LEFT JOIN … ON` (self-joins too), a subquery in `FROM`, `json_each(<input or column>)` on D1; on PostgreSQL `jsonb_array_elements_text(<input or column>) WITH ORDINALITY AS j(value, n)` | the only comma join is `t, json_each(t.col)` on D1 (PostgreSQL: `t, jsonb_array_elements_text(t.col) WITH ORDINALITY AS j(value, n)`, [SQLite to PostgreSQL rewrites](../concepts/runtime-and-adapters.md#the-postgresql-dialect)). Paging appends the first relation's `id`; a subquery or CTE first in `FROM` must output it. JOIN fanout can repeat that key inside or outside a subquery: supply a unique full sort order for paging. The compiler does not prove that a derived `id` is unique. A row source alone first in `FROM` is keyed by its own `id` or ordinality |
| Subqueries and CTEs | scalar and correlated; ordinary nonrecursive `WITH … AS (SELECT …)` | CTE references follow lexical scope; each physical Schema read retains caller and visibility policy |
| Aggregation | `count`, `sum`, `min`, `max`, `avg`, `count(DISTINCT)`, `json_group_array([DISTINCT])`, `json_group_object`, `GROUP BY`, `HAVING` | a selected column is grouped or aggregated |
| Windows | `row_number()`, `rank()`, `sum`/`count … OVER (PARTITION BY … ORDER BY …)` | no frame clause |
| Order and paging | `ORDER BY … [NULLS FIRST \| LAST]`, `LIMIT`, `DISTINCT` | `id` is appended as the last sort key (on PostgreSQL in the last key's direction); `LIMIT` needs `ORDER BY` and bounds every page together; a sort key may be NULL (an unstated `NULLS` follows the dialect: D1 puts NULL first ascending and last descending, PostgreSQL last ascending and first descending, and the cursor follows the same rule); `ORDER BY 1` sorts by the first output; `DISTINCT` with `ORDER BY` is refused. A View without `ORDER BY` (a `DISTINCT`, an aggregate, a `GROUP BY`) is one page: it takes no cursor and is refused when it has more rows than the page |
| JSON | `->>`, `json_extract`, `json_set`, `json_insert`, `json_remove`, `json_array_length` | `->` is refused |
| Time | `now()`, `date_trunc('hour'\|'day'\|'week'\|'month'\|'year', ts)`, `extract(year\|month\|day\|dow\|hour FROM ts)`, `ts ± interval '<n> seconds\|minutes\|hours'`, `ts - ts` | site time zone; `ts - ts` is microseconds. Calendar intervals (`day`, `month`) are refused: bind the boundary as an input |
| Search and places | `mantle.search(t, q)`, `mantle.search_rank(t)`, `mantle.near(t.f, lat, lng, meters)`, `mantle.distance(t.f, lat, lng)` | `near` takes a literal radius of at most 50 km; ordering by `distance` needs `LIMIT` ≤ 100 and has no cursor |

Refused on D1: `WITH RECURSIVE`, `MATERIALIZED`/`NOT MATERIALIZED` hints, `LATERAL`, `UNION`/`INTERSECT`/`EXCEPT`, window frames,
`FILTER`, `DISTINCT ON`, `ILIKE`, regular expressions and jsonb operators. The
PostgreSQL dialect accepts each of them (next section), and D1 says so in its
refusal: "needs the PostgreSQL dialect".

Refused on every dialect: `OFFSET`, `RIGHT`/`FULL`/`CROSS JOIN`, `NATURAL`,
`USING`, `FOR UPDATE`, a write inside `WITH`, positional `$1`, `rowid`,
SQLite's clock (`'now'`, `CURRENT_TIMESTAMP`), `strftime`/`date`/`unixepoch`,
`generate_series` and any function outside the allowlist, an unqualified
`search()`, and any relation that is not a declared Schema, a CTE or an
internal View (`_mantle_*` and auth tables included).

### What the PostgreSQL dialect adds

PostgreSQL is Mantle SQL's reference dialect (ADR-0037); D1 runs the subset above.
On PostgreSQL a View may also use:

| Construct | Notes |
|---|---|
| `WITH`, `WITH RECURSIVE` | every CTE body is a `SELECT`; a Schema read inside one is scoped like any other |
| `UNION [ALL]`, `INTERSECT`, `EXCEPT`, `DISTINCT ON` | inside a `WITH` or a subquery, never the View's own `SELECT`, which Core pages and orders |
| `JOIN LATERAL (…) x ON …`, `, LATERAL (…) x` | |
| Window frames | `ROWS`/`RANGE BETWEEN … PRECEDING AND …` with literal offsets (an integer, or an interval for `RANGE` over time); `avg`, `min`, `max`, `lag`, `lead`, `first_value`, `last_value`, `dense_rank` over a window. `GROUPS` and `EXCLUDE` are refused |
| Aggregates | `FILTER (WHERE …)`, `ORDER BY` inside an aggregate, `string_agg`, `jsonb_agg`, `jsonb_object_agg` |
| jsonb | `->`, `#>`, `#>>`, `@>`, `<@`, `?`, `?\|`, `?&`; `jsonb_build_object`, `jsonb_build_array`, `jsonb_strip_nulls`, `to_jsonb`, `jsonb_typeof`; a json field is stored as `jsonb` |
| Text and numbers | `ILIKE`, `~`, `~*`, `!~`, `!~*`, `split_part`, `greatest`, `least`, `floor`, `ceil`, `sqrt`, `power` |
| Time | `ts AT TIME ZONE 'Asia/Taipei'`; `date_trunc` adds `minute` and `quarter`; `extract` adds `minute`, `quarter`, `week`, `isoyear`, `isodow`, `doy`, `epoch` |
| Casts | any expression to `int4`, `int8`, `numeric(p, s)`, `date`, `timestamptz`, `jsonb`; a text literal compared with a date-time column is cast, as PostgreSQL does |

A PostgreSQL View runs under the role's `statement_timeout`. With the default
`postgresStorage({ statementTimeoutMs: 10_000 })`, boot requires that role
limit to be positive and no larger than 10 seconds. Setting the option to
zero disables that boot requirement, without changing the role's own limit.
See [PostgreSQL runtime settings](../concepts/runtime-and-adapters.md#the-postgresql-dialect).

### Reading another View

A View's `FROM` may name an internal View (`surface: internal`, no `input`, no
`requires`) by its name with `-` written `_`: `FROM free_window w`. The
D1 compiler emits shared native CTE dependencies within each outermost SELECT.
PostgreSQL retains FROM subqueries so its planner can push predicates and LIMIT
through repeated references. Scope and every check apply inside dependencies
on both dialects; the engine owns the resulting plan. A View that reads itself, directly or through
others, is refused; a View named like a Schema is not readable this way (the name reads the Schema). Write a rule many
Views share (a plan's visible window, a definition of "active") once this way.

### Names

- Unquoted identifiers fold to lower case; Schema and field names resolve
  case-insensitively. A Schema whose name is not a plain identifier is quoted:
  `FROM "support-tickets"`.
- Native columns are `id`, `status`, `version`, `created_at`, `updated_at`,
  `author_id`.
- An output that reads a Schema field unchanged comes back under the field's
  declared name and is decoded to its type, and so does `created_at` or
  `updated_at` (an ISO date-time). A `sum`, `min` or `max` of one column keeps
  that column's type and hints (a sum of a `money-minor` field is money); a
  `count` or an `avg` is a plain number. Any other output keeps its alias as
  SQL folded it: `AS orderCount` is `ordercount`, `AS "orderCount"` keeps the
  case. A staff View's `uiSchema.list.columns` must name each output as the row
  carries it; a name that differs only by case is `VIEW_UI_INVALID`, and the
  message says to quote the alias.

## `input`

A JSON Schema object with declared `properties`; the SQL reads
`input.<name>`. `limit` and `cursor` are reserved
(`VIEW_INPUT_RESERVED_NAME`). An input the call leaves out binds `NULL`, after
the schema's `default` if it declares one.

## `surface`

| Value | Served |
|---|---|
| `public` | `GET /api/views/<name>` and a tool on `/mcp` |
| `staff` | `GET /admin/api/views/<name>`, `GET /admin/api/views/<name>/export` (CSV), and a tool on the staff MCP surface |
| `internal` | nowhere: `ctx.store.view(name, …)` and `runtime.store` only |

## Paging and the response

Every surface takes `limit` (default 50, maximum 500) and `cursor`, and answers
`{ "rows": [...], "nextCursor": "…" }`. `nextCursor` appears only when more
rows exist; pass it back unchanged. A cursor is bound to its View and order.
REST coerces each `input` query parameter to its declared type.

### Author a unique order for the result

Keyset paging requires the complete `ORDER BY` to distinguish every result
row. The appended `id` breaks ties for a single Schema row; it does not prove
uniqueness after a one-to-many join or inside a derived table, CTE or another
View. A column named `id` in a subquery can repeat. Mantle does not check the
result for duplicate sort keys or invent a unique key for arbitrary SQL.

For example, when an item has several orders, order by both identities. This
query works on D1 and PostgreSQL; `items` declares `name`, and `orders`
declares `item_id`:

```sql
SELECT s.id, s.name, s.order_id
FROM (
  SELECT i.id, i.name, o.id AS order_id
  FROM items i JOIN orders o ON o.item_id = i.id
) s
ORDER BY s.id, s.order_id
```

Here `(s.id, s.order_id)` identifies each joined row. `ORDER BY s.id` alone
does not: a later page can skip the other orders for the same item. For a
row source, retain its element key as well as the parent key in the outer
ordering; repeated element values are not identities. A nullable key follows
the dialect's NULL ordering, but NULL handling does not make a repeated tuple
unique. For grouped or set-operation results, reason about the resulting
rows rather than assuming an input table's `id` still identifies them.

Cursor paging of a result without a unique complete ordering is unsupported,
even if its SQL compiles. The compiler does not generally prove or refuse
that case. Add the keys that identify the result rows before using cursor
paging. An authored `LIMIT` also needs a deterministic order at its
boundary. Paging is not a snapshot: changing the data or sort values between
requests can change which rows subsequent pages return.

The compiler appends `id` even when a unique index already orders the rows.
Schema columns are nullable, so a unique index can hold the same tuple twice
when one key is NULL, and an unscoped caller (`runtime.store`, the system caller) sees every
owner's rows. Ending the index with the order keys still lets the database
search it; D1's plan may show `USE TEMP B-TREE FOR LAST TERM OF ORDER BY`,
which sorts only within ties of the earlier keys.

### Long aggregate ranges

A View with `GROUP BY … ORDER BY` pages with a cursor on its group keys, and
every page reruns the whole aggregation before it filters past the cursor. An
all-time weekly series read in nine pages aggregates the full history nine
times; one benchmark read about 56,000 D1 rows per page. Two fixes:

1. **Bound the range with inputs**, such as `WHERE s.performed_at >= input.from`,
   so a page aggregates only what it shows.
2. **Keep a rollup Schema** for long ranges: one row per member, week and
   exercise, written by the same Procedure that writes the source rows. The
   Procedure's statements are one batch, so the rollup never disagrees with its
   source.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: weekly_volume }
spec:
  title: Weekly volume
  scope: { owner: auth.uid() }
  uniqueIndexes: [[owner, localWeek, exerciseKey]]
  schema:
    type: object
    additionalProperties: false
    required: [owner, localWeek, exerciseKey, volume]
    properties:
      owner: { type: string, maxLength: 80 }
      localWeek: { type: string, pattern: "^[0-9]{4}-W[0-9]{2}$", maxLength: 8 }
      exerciseKey: { type: string, maxLength: 80 }
      volume: { type: number }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: rebuild-week }
spec:
  input:
    type: object
    additionalProperties: false
    required: [localWeek]
    properties:
      localWeek: { type: string, pattern: "^[0-9]{4}-W[0-9]{2}$", maxLength: 8 }
  output: { type: object }
  handler:
    sql: |
      DELETE FROM weekly_volume WHERE localWeek = input.localWeek;
      INSERT INTO weekly_volume (localWeek, exerciseKey, volume)
        SELECT localWeek, exerciseKey, sum(weight * reps) FROM sets
        WHERE localWeek = input.localWeek GROUP BY localWeek, exerciseKey
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: weekly-volume }
spec:
  surface: public
  sql: SELECT localWeek, exerciseKey, volume FROM weekly_volume ORDER BY localWeek, exerciseKey
```

This assumes a scoped `sets` Schema with `localWeek`, `exerciseKey`, `weight`
and `reps` (see [Per-member calendar buckets](./schema.md#per-member-calendar-buckets)).
Put the same two statements after the `INSERT INTO sets …` in the Procedure that
logs, edits or deletes a set, so the touched week is recomputed in the same
batch. Store adds the scope to every statement, so each member recomputes only
their own rows. The reading View pages by an index search on the unique index.
An incremental `INSERT … ON CONFLICT (localWeek, exerciseKey) DO UPDATE SET
volume = weekly_volume.volume + EXCLUDED.volume` also compiles, but it is
correct only for inserts, not edits or deletes.

Three things to keep in mind:

- **Backfill is per member.** Store stamps the scope column from the caller's
  `auth.uid()`, and a write may not name it, so a system caller cannot write
  rows for each member. Backfill by running the recompute once per member and
  week with that member's user Caller (for example from a host script through
  `runtime.invokeProcedure`), or as a one-off outside Store with SQL
  (`wrangler d1 execute`, `psql`) that fills every column Store would: `id`,
  the scope column, `created_at`, `updated_at`, `author_id` and `version`.
- **Every write path must maintain the rollup.** Admin edits go through Store
  but do not run your Procedure. Set `schema.readOnly: true` on the source
  Schema so every write goes through the Procedures (see
  [Procurement](../../examples/procurement.md)). A lifecycle Trigger
  (`after_create`, `after_update`, `after_delete`) can recompute from the rows
  in `ctx.cause.rows`, but after hooks are best effort, run after the commit in
  a new transaction and never undo the source write, so the rollup is
  eventually consistent there.
- **An unscoped read of a rollup sees every owner:** `runtime.store`, a
  schedule or other system-caller Procedure. Staff are scoped like any member
  and see only their own rollup rows.

The manifests above were compiled with `mantle generate --identity none
--features web --dialect sqlite` followed by `generate --check`, the steps
`scripts/check-doc-examples.mjs` runs.

## `uiSchema` (staff Views)

| Key | Effect |
|---|---|
| `list.columns` | the outputs the console shows, in order; CSV export uses them |
| `list.searchFields` | outputs the console's search box matches: one case-insensitive `LIKE '%text%'` per output, ORed, with `%`, `_` and `\` in the text matched literally |
| `list.filterFields` | outputs the console offers as filters: one `=` each, the value coerced to the output's field type |
| `list.cells` | output -> `<extension>/<contribution>`: an Admin extension's `field.cell/v1` renderer for that column ([Extend Admin](../guides/admin-extensions.md)) |

Each name must be one of the View's outputs (`VIEW_UI_INVALID` otherwise).
The conditions wrap the View's own query, after its `WHERE` and the injected
policy and before paging, so they narrow what the caller may already see and
the cursor stays valid. Over HTTP they are Admin's `search` and
`filter.<output>` query parameters on `/admin/api/views/<name>` and its
`/export`; in code, `store.view(name, { search, filters })`. A declared
`input` remains the way to parameterize the query itself. Other keys are
refused (`VIEW_UI_INVALID`).

## `cache`

`{ sharedMaxAge: 1–86400 }` is accepted only on an unguarded public View whose
expanded SQL reads neither `auth.*` nor `now()`, nor TTL or operational Schemas
(`VIEW_CACHE_INVALID`). Generation and uploaded-plan verification check executable IR,
including internal View dependencies; comments, literals and display source do not decide
eligibility. The annotation is the author's promise that this response may be shared
for the chosen duration, not a proof of arbitrary native SQL immutability (for example,
implicit time-dependent casts). The value is
carried into the plan, and the REST surface answers an anonymous caller of such
a View with `Cache-Control: public, s-maxage=<n>` and `Vary: authorization, cookie`,
so a shared cache does not answer a signed-in request with it. A cached answer
lives until it expires, across a deploy too: choose `<n>` for that. A signed-in caller's
response and every error keep `private, no-store`. The MCP surface sends no
cache header.

## Diagnostics

`SQL_SYNTAX`, `SQL_UNSUPPORTED`, `SQL_FUNCTION`, `SQL_RELATION`, `SQL_COLUMN`,
`SQL_SHAPE`, `SQL_TYPE` (each with a line and column in the SQL),
`VIEW_INPUT_INVALID_SHAPE`, `VIEW_INPUT_RESERVED_NAME`, `VIEW_CACHE_INVALID`,
`VIEW_UI_INVALID`, `AUTH_PREDICATE_NOT_IN_ENUM`, `GUARD_PROCEDURE_UNKNOWN`. At
run time: `UNAUTHENTICATED`, `AUTH_DENIED`, `INPUT_VALIDATION_FAILED`,
`NOT_FOUND`. See [Diagnostics](./diagnostics.md).
