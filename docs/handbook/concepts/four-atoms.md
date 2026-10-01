---
description: The four manifest atoms of Mantle 0.2.0 (Schema, View, Procedure, Trigger), what each compiles to, and how they reference each other.
---
# The four atoms

Every manifest document is one atom:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema | View | Procedure | Trigger
metadata: { name: <name> }
spec: { … }
```

| Atom | Declares | Compiles to | Code |
|---|---|---|---|
| **Schema** | rows: a JSON Schema of fields, indexes, `checks`, scope, TTL, lifecycle | one `STRICT` table with native columns and one column per scalar field | none |
| **View** | a read: one SQL `SELECT`, its `input`, `surface` and `requires` | validated SQL IR in the plan | none |
| **Procedure** | a write: `input`, `output`, `requires` and a handler, either SQL statements or a `ref` | IR for `sql`, a name for `ref` | only `ref` |
| **Trigger** | when a Procedure runs: an HTTP route, an MCP tool, a lifecycle hook or a schedule | a binding in the plan | none |

Views read and Procedures write; a View never writes and a Procedure's SQL
holds write statements only. Custom code exists only behind a Procedure's
`ref`.

## How they reference each other

```
Trigger ──target──▶ Procedure ──SQL writes / ctx.store──▶ Schema
                       ▲  │                                  ▲
         requires.guard│  └─ctx.invoke──▶ Procedure          │
                       │                                     │
View ────────────SQL SELECT (joins, subqueries)──────────────┘
Trigger(lifecycle) ◀── a write to its Schema
```

- A View's or Procedure's SQL names Schemas by `metadata.name`; a name that is
  not a plain identifier is quoted (`"support-tickets"`).
- A Trigger targets one Procedure. A lifecycle Trigger also names the Schema
  it watches.
- `requires.guard` names a `ref` Procedure that runs before the target.
- `x-mantle-ref` on a field points at another Schema's `id` or unique field;
  Admin uses it to relate rows and bind operations.

`mantle generate` links every reference and refuses a dangling one, a
duplicate name, or two names that differ only in case.

## Native columns

Every Schema table carries native columns that Store fills and no write may
set:

| SQL name | Store JSON name | Meaning |
|---|---|---|
| `id` | `id` | text id, generated unless a `ref` handler passes `ctx.store.id()` |
| `status` | `status` | `draft`, `published` or `archived`; on a `publishing` Schema only (an `operational` one has no `status` column) |
| `version` | `version` | starts at 1, bumps on every write; the optimistic lock |
| `created_at`, `updated_at` | `createdAt`, `updatedAt` | timestamps |
| `author_id` | `authorId` | the subject key of the caller that created the row |

SQL spells them snake_case; the JSON of `ctx.store` keeps camelCase. A Schema
field may not reuse these names.

## Values in SQL

| Reference | Is |
|---|---|
| `input.<name>` | a declared `input` property |
| `auth.uid()` | the caller's subject key (`NULL` for an anonymous caller) |
| `auth.role()` | the caller's staff role, or `NULL` |
| `now()` | the invocation time |
| `mantle.search(t, q)`, `mantle.search_rank(t)`, `mantle.near(...)`, `mantle.distance(...)` | full-text search and geo functions |

A SQL literal is a literal. There are no `$`-prefixed references and no
positional `$1`.

## What the runtime adds

Every Schema reference in every statement, joins and subqueries included, is
rewritten before it runs:

- **Scope**: on a Schema with `scope`, a user caller sees and writes only the
  rows whose scope field is its own subject key.
- **TTL**: expired rows are invisible.
- **Published-only**: a public View reading a `publishing` Schema sees
  published rows only.
- **Locks**: `WHERE id = … AND version = input.…` pins one row; writing none is
  `CONFLICT`.

Authors write the business query; they never repeat these rules. See
[Authorization](./authorization.md) and [Lifecycle and locales](./lifecycle-and-locales.md).

## Further reading

- [Reads: Views, REST and MCP](./views.md)
- [Writes: Procedures, Triggers and hooks](./procedures-and-triggers.md)
- [Feature table](../reference/features.md)
