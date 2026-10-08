---
description: Procedure field reference for Mantle 0.2.0 — input and output, SQL and ref handlers, write rules, row ops and locks, target, mcp annotations, uiSchema and diagnostics.
---
# Procedure

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: review-order }
spec:
  title: Review order                 # optional, a string or a locale map
  description: …                      # optional; the MCP tool's and Admin operation's description
  requires: { … }                     # optional, see Authorization requirements
  input: { type: object, … }          # required JSON Schema
  output: { type: object }            # required JSON Schema
  handler: { sql: "…" }               # or { ref: <name> }
  target: { schema, id, version? }    # optional; inferred for one locked row op
  mcp: { destructiveHint: true }      # optional tool annotations
  uiSchema: { … }                     # optional, Admin only
```

`input` is validated before the handler runs (`INPUT_VALIDATION_FAILED`),
and the result against `output` (`OUTPUT_VALIDATION_FAILED`, a 500: the bug
is the handler's). `expectedVersion` is the conventional input name for the
version a caller read.

## `handler.sql`

One or more `INSERT`, `UPDATE` and `DELETE` statements separated by `;`,
applied as one batch: all or nothing, in order. The output is
`{ "results": [[…], …] }`, the `RETURNING` rows of each statement in order; so
an `output` of `{ type: object }` accepts it.

| Statement | Supported |
|---|---|
| `INSERT` | `INSERT INTO t (cols) VALUES (…)` (one row), `INSERT INTO t (cols) SELECT …`, `ON CONFLICT (cols) DO NOTHING \| DO UPDATE SET c = EXCLUDED.c …`, `RETURNING` |
| `UPDATE` | `UPDATE t SET c = <expr> … WHERE …`, `RETURNING` |
| `DELETE` | `DELETE FROM t WHERE …`, `RETURNING` |

Expressions are those of [View SQL](./view.md#what-the-d1-dialect-accepts).
References: `input.<name>`, `auth.uid()`, `auth.role()`, `now()`.

**A write may not name** the scope field, `version`, `status`, `created_at`,
`updated_at`, `author_id`, or `id` in an `UPDATE`, in a column list, `SET` or
`DO UPDATE SET`; on a scoped Schema an `INSERT` names no `id`. Store fills
them (`SQL_WRITE`). Multi-row `VALUES` is refused: insert from
`json_each(input.items)` on D1 instead (PostgreSQL: `jsonb_array_elements(input.items)`). `UPDATE … FROM`, `DELETE … USING`,
`INSERT OR …` and `last_insert_rowid()` are refused.

**RETURNING names** fold to lower case unless quoted:
`RETURNING id, orderNumber AS "orderNumber"`.

### Row ops and set ops

- **Row op**: an `UPDATE` or `DELETE` whose top-level `WHERE` has
  `id = <value>`, or a one-row `INSERT … VALUES` without `ON CONFLICT`. If it
  writes no row the batch fails with `CONFLICT` and nothing applies.
- **Set op**: everything else. Writing no row is a normal result. Refused on a
  `publishing` Schema, and on a Schema with a `before_*` hook for that
  operation.
- **Lock**: `AND version = input.<name>` in a row op's `WHERE`. A stale version
  matches nothing, so it is `CONFLICT` (HTTP 409).

### `target`

`{ schema, id, version? }`: the Schema the Procedure mutates, the required
string input holding the row id, and the integer input holding the version it
locks. Admin binds an operation to a row by it. A Procedure whose SQL is
exactly one row op pinning `id` (and `version`) to inputs gets it inferred;
declare it for a `ref` handler. `PROCEDURE_TARGET_INVALID` when the inputs do
not have those shapes.

## `handler.ref`

```yaml
handler: { ref: cancelOrder }
```

The name of a function in the service's `handlers` map. The generated
`MantleHandlers` type lists exactly the plan's refs, with typed input and
output; boot refuses a missing one (`HANDLER_NOT_REGISTERED`) and an extra
one (`HANDLER_NOT_DECLARED`).

```ts
(input, ctx) => output | Promise<output>
// ctx: { caller, cause, store, invoke, env, waitUntil }
```

A handler reaches Mantle-owned rows only through `ctx.store`
([Query from TypeScript](../guides/typed-queries.md)). It throws
`DiagnosticError` (from `@aotter/mantle`) to answer with a code; any
other throw is logged and answered as `INTERNAL_ERROR`. Guards, before hooks
and lifecycle targets must be `ref` handlers.

## `requires`

`requires.auth.all` (predicates) and `requires.guard.procedure` (a `ref`
Procedure run before this one). See
[Authorization requirements](./authorization.md).

## `mcp`

`readOnlyHint`, `destructiveHint`, `openWorldHint` (booleans), copied onto the
MCP tool. `readOnlyHint` and `destructiveHint` may not both be true, and a SQL
handler, which always writes, may not claim `readOnlyHint: true`.

## `uiSchema`

| Key | Effect in Admin |
|---|---|
| `fields.<name>.widget: textarea` | a multiline input |
| `fields.<name>.widget: <extension>/<contribution>` (with optional `options`) | an Admin extension's `field.input/v1` control ([Extend Admin](../guides/admin-extensions.md)) |
| `collectionAction: <schema>` | offer the operation on that collection's list |

Admin lists a Procedure as an operation only when a Trigger binds it to the
staff MCP surface.

## Diagnostics

Validate: `SQL_SYNTAX`, `SQL_UNSUPPORTED`, `SQL_FUNCTION`, `SQL_RELATION`,
`SQL_COLUMN`, `SQL_WRITE`, `SQL_SHAPE`, `SQL_TYPE`, `PROCEDURE_TARGET_INVALID`,
`GUARD_PROCEDURE_UNKNOWN`, `GUARD_SELF_REFERENCE`, `GUARD_PROCEDURE_NOT_REF`,
`GUARD_CHAIN_NOT_ALLOWED`, `MCP_TOOL_DESCRIPTION_MISSING` (a warning),
`MCP_TOOL_INPUT_UNION_AMBIGUOUS`, `MCP_TOOL_INPUT_UNBOUNDED`. Boot:
`HANDLER_NOT_REGISTERED`, `HANDLER_NOT_DECLARED`. Run time:
`INPUT_VALIDATION_FAILED`, `UNAUTHENTICATED`, `AUTH_DENIED`,
`ENTITLEMENT_REQUIRED`, `CONFLICT`, `OUTPUT_VALIDATION_FAILED`,
`INVOCATION_DEPTH_EXCEEDED`, `INTERNAL_ERROR`. See [Diagnostics](./diagnostics.md).
