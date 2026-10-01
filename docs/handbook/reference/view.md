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

| Area | Supported | Rule |
|---|---|---|
| Expressions | columns, aliases, literals, arithmetic, `\|\|`, `CASE`, `COALESCE`, `NULLIF`, `CAST` | `CAST(x AS int)` only for an integer literal: use `round(x)`. `CAST(x AS bool)` follows PostgreSQL. `*` expands to declared fields |
| Conditions | comparisons, `AND`/`OR`/`NOT`, `BETWEEN`, `IS [NOT] NULL`, `IS DISTINCT FROM`, `IN (list \| subquery)`, `[NOT] EXISTS`, `LIKE … ESCAPE` | `LIKE` is case-insensitive (SQLite). An input array in `IN` binds once |
| Relations | one Schema, `INNER`/`LEFT JOIN … ON` (self-joins too), a subquery in `FROM`, `json_each(<input or column>)` | the only comma join is `t, json_each(t.col)` |
| Subqueries | scalar and correlated | |
| Aggregation | `count`, `sum`, `min`, `max`, `avg`, `count(DISTINCT)`, `json_group_array([DISTINCT])`, `json_group_object`, `GROUP BY`, `HAVING` | a selected column is grouped or aggregated |
| Windows | `row_number()`, `rank()`, `sum`/`count … OVER (PARTITION BY … ORDER BY …)` | no frame clause |
| Order and paging | `ORDER BY … [NULLS FIRST \| LAST]`, `LIMIT`, `DISTINCT` | `id` is appended as the last sort key; `LIMIT` needs `ORDER BY`; a paged sort key must be non-null (sort by a required field or `COALESCE(x, …)`): a nullable key is not refused, and rows whose key is NULL can drop out after the first page; `DISTINCT` with `ORDER BY` is refused |
| JSON | `->>`, `json_extract`, `json_set`, `json_insert`, `json_remove`, `json_array_length` | `->` is refused |
| Time | `now()`, `date_trunc('hour'\|'day'\|'week'\|'month'\|'year', ts)`, `extract(year\|month\|day\|dow\|hour FROM ts)`, `ts ± interval '<n> seconds\|minutes\|hours'`, `ts - ts` | site time zone; `ts - ts` is microseconds. Calendar intervals (`day`, `month`) are refused: bind the boundary as an input |
| Search and places | `mantle.search(t, q)`, `mantle.search_rank(t)`, `mantle.near(t.f, lat, lng, meters)`, `mantle.distance(t.f, lat, lng)` | `near` takes a literal radius of at most 50 km; ordering by `distance` needs `LIMIT` ≤ 100 and has no cursor |

Refused always: `OFFSET`, `RIGHT`/`FULL`/`CROSS JOIN`, `LATERAL`, `NATURAL`,
`USING`, recursive CTEs, `UNION`/`INTERSECT`/`EXCEPT`, window frames,
`FOR UPDATE`, positional `$1`, `rowid`, SQLite's clock (`'now'`,
`CURRENT_TIMESTAMP`), `strftime`/`date`/`unixepoch`, `REGEXP`, `ILIKE`,
functions outside D1's allowlist, an unqualified `search()`, and any relation
that is not a declared Schema (`_mantle_*` and auth tables included).

### Names

- Unquoted identifiers fold to lower case; Schema and field names resolve
  case-insensitively. A Schema whose name is not a plain identifier is quoted:
  `FROM "support-tickets"`.
- Native columns are `id`, `status`, `version`, `created_at`, `updated_at`,
  `author_id`.
- An output that reads a Schema field unchanged comes back under the field's
  declared name and is decoded to its type. Any other output keeps its alias
  as SQL folded it: `AS orderCount` is `ordercount`, `AS "orderCount"` keeps the
  case. A native column comes back in its stored encoding (timestamps are
  microseconds).

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

## `uiSchema` (staff Views)

| Key | Effect |
|---|---|
| `list.columns` | the outputs the console shows, in order; CSV export uses them |
| `list.searchFields` | outputs the console's search box matches: one case-insensitive `LIKE '%text%'` per output, ORed, with `%`, `_` and `\` in the text matched literally |
| `list.filterFields` | outputs the console offers as filters: one `=` each, the value coerced to the output's field type |

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
SQL reads neither `auth.*` nor `now()` (`VIEW_CACHE_INVALID`). The 0.2.0 REST
surface does not send cache headers yet; cache in front of it if you need to.

## Diagnostics

`SQL_SYNTAX`, `SQL_UNSUPPORTED`, `SQL_FUNCTION`, `SQL_RELATION`, `SQL_COLUMN`,
`SQL_SHAPE`, `SQL_TYPE` (each with a line and column in the SQL),
`VIEW_INPUT_INVALID_SHAPE`, `VIEW_INPUT_RESERVED_NAME`, `VIEW_CACHE_INVALID`,
`VIEW_UI_INVALID`, `AUTH_PREDICATE_NOT_IN_ENUM`, `GUARD_PROCEDURE_UNKNOWN`. At
run time: `UNAUTHENTICATED`, `AUTH_DENIED`, `INPUT_VALIDATION_FAILED`,
`NOT_FOUND`. See [Diagnostics](./diagnostics.md).
