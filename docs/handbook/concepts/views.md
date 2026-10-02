---
description: How a View's SQL SELECT is compiled, which policies the runtime injects, and how REST, MCP, Admin and Store serve it with limit and cursor paging.
---
# Reads: Views, REST and MCP

A View is one SQL `SELECT` in PostgreSQL syntax over declared Schemas.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: my-orders }
spec:
  surface: public
  requires: { auth: { all: [ctx.user] } }
  sql: |
    SELECT o.id, o.qty, o.orderStatus, i.name AS item, o.version
    FROM orders o JOIN items i ON i.id = o.itemId
    ORDER BY o.created_at DESC
```

## Compiled once, checked at every run

`mantle generate` parses the SQL with PostgreSQL's own parser, refuses what the
dialect does not support (with the position in the statement), and stores the
parse tree as the View's IR in the plan. No Worker parses SQL. At run time the
runtime validates the IR against the same allowlist, injects policy, and the D1
dialect prints SQLite.

What the D1 dialect accepts, in short (the [View reference](../reference/view.md)
has the full table):

- columns, literals, arithmetic, `CASE`, `COALESCE`, `CAST` (to `int` only for
  integer literals: use `round(x)`), JSON `->>`;
- `WHERE` with comparisons, `BETWEEN`, `IN (list | subquery)`, `EXISTS`,
  `LIKE` (case-insensitive, as in SQLite), `IS DISTINCT FROM`;
- `INNER` and `LEFT JOIN`, subqueries, `json_each(…)`;
- `GROUP BY`, `HAVING`, `count`, `sum`, `min`, `max`, `avg`,
  `json_group_array`, `json_group_object`; `row_number()`, `rank()` and running
  aggregates;
- `ORDER BY … NULLS FIRST | LAST`, `LIMIT` (it needs an `ORDER BY`),
  `DISTINCT`;
- `now()`, `date_trunc`, `extract`, `ts ± interval '<n> seconds|minutes|hours'`;
- `mantle.search`, `mantle.search_rank`, `mantle.near`, `mantle.distance`.

Refused: `OFFSET` (page with cursors), `RIGHT`/`FULL`/`CROSS JOIN`, any table
that is not a declared Schema, and SQLite's own clock (`CURRENT_TIMESTAMP`,
`'now'`).

PostgreSQL is the reference dialect (ADR-0037): on it a View may also use `WITH`
(recursive too), `UNION` and `DISTINCT ON` inside a `WITH` or subquery,
`LATERAL`, window frames, `FILTER`, jsonb operators, `ILIKE` and regular
expressions. D1 refuses them as needing the PostgreSQL dialect. On every
dialect a View may read an internal View in `FROM`, which is inlined; that is
how a rule many Views share is written once.

## Policies the runtime injects

Every Schema reference, in `FROM`, joins and subqueries, is replaced by a
subquery that keeps only visible rows:

- **scope**: on a scoped Schema, a user caller's own rows (an anonymous caller
  sees none);
- **TTL**: unexpired rows;
- **published-only**: on a `public` View, published rows of `publishing`
  Schemas.

So the join in `my-orders` sees only the caller's orders, and the View never
says so. A public View that joins a Schema without `publishing` to one with it
must join them by an explicit condition, or validation refuses it.

## Output names and types

- A column that reads a Schema field unchanged comes back under the field's
  declared name and type (`o.orderStatus` is `orderStatus`).
- Anything else keeps its alias. SQL folds unquoted names to lower case, so
  `count(o.id) AS orderCount` comes back as `ordercount`; write
  `AS "orderCount"` to keep the case.
- `*` expands to the declared fields, never the scope field or native columns.
- The generated `ViewRow_<name>` types each column the same way; an expression
  is `unknown`.

## Surfaces

| `surface` | Served at |
|---|---|
| `public` | `GET /api/views/<name>` (REST) and a tool on the public MCP surface (`/mcp`) |
| `staff` | `GET /admin/api/views/<name>`, with CSV at `/export`, and a tool on the staff MCP surface (`/mcp/staff`) |
| `internal` | no surface: `ctx.store.view(...)` and `runtime.store` only |

`requires` gates every path: an anonymous caller is 401 `UNAUTHENTICATED`, a
signed-in one who fails a predicate is 403 `AUTH_DENIED`. A staff View still
needs its own `requires` to limit roles beyond Admin's gate.

## Input and paging

`input` is a JSON Schema object; the SQL reads `input.<name>`. Over REST the
properties are query parameters, coerced to their declared types; a missing
required one is 400 `INPUT_VALIDATION_FAILED`. `limit` and `cursor` are
reserved names.

Every surface pages the same way: `limit` (default 50, at most 500) and an
opaque `cursor`. The response is `{ "rows": [...], "nextCursor": "…" }`, with
`nextCursor` only when more rows exist. The compiler appends `id` to the
`ORDER BY` so the order is total. A View's own `LIMIT` caps the whole result.

## MCP

Each View of a surface is a read-only tool named after it in snake case
(`my-orders` is `my_orders`), whose input is the View's `input` plus `limit`
and `cursor`. `description` becomes the tool's description. See
[MCP and agents](./mcp-and-agents.md).

## Further reading

- [View reference](../reference/view.md)
- [Query from TypeScript](../guides/typed-queries.md)
