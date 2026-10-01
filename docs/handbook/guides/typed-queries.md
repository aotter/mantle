---
description: Read and write through the typed Store from handlers and service code, call named Views, and choose between ctx.store, runtime.store and runtime.store.as(caller).
---
# Query from TypeScript

Handler and service code reach Mantle-owned rows only through Store. The
generated `.mantle/generated/mantle.ts` types it over your Schemas and Views.

| Store | Where | Scope |
|---|---|---|
| `ctx.store` | inside a `ref` handler | bound to the invocation's caller. A guard or a before hook gets a read-only one |
| `runtime.store.as(caller)` | service code that has resolved a caller | that caller |
| `runtime.store` | trusted host code (imports, maintenance) | none: no caller scope. TTL still applies |

Each one applies TTL visibility, and published-only on public Views. Only
`runtime.store` skips caller scope, so never hand it a request's input
unchecked.

## Declare an internal View

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: tickets }
spec:
  title: Tickets
  lifecycle: operational
  indexes: [[ticketState]]
  schema:
    type: object
    additionalProperties: false
    required: [subject, ticketState]
    properties:
      subject: { type: string }
      ticketState: { type: string, enum: [open, closed] }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: tickets-by-state }
spec:
  surface: internal
  input:
    type: object
    additionalProperties: false
    required: [ticketState]
    properties:
      ticketState: { type: string, enum: [open, closed] }
  sql: |
    SELECT id, subject, ticketState FROM tickets
    WHERE ticketState = input.ticketState
    ORDER BY created_at DESC LIMIT 50
```

`internal` keeps the View off REST, MCP and Admin. It is still in the plan and
the typed Store. It is not a security bypass: a `requires` on it is checked
for the caller the Store is bound to.

## Call it

```ts
import type { MantleHandlers } from "../.mantle/generated/mantle.js";

export const handlers: MantleHandlers = {
  closeStale: async (_input, ctx) => {
    const { rows, nextCursor } = await ctx.store.view("tickets-by-state", { input: { ticketState: "open" }, limit: 20 });
    // rows: { id: unknown; subject: string | null; ticketState: "open" | "closed" | null }[]
    return { open: rows.length, more: nextCursor !== undefined };
  },
};
```

The View name, its `input` and its row type are checked by `tsc`. A staff View
with `uiSchema.list.searchFields` or `filterFields` also takes `search` and
`filters` (`runtime.store.view(name, { search: "refund", filters: { ticketState: "open" } })`);
Store refuses a filter the View does not declare. An output
that reads a Schema field unchanged has that field's type; an expression, or
a native column such as `id`, is `unknown`. Page with `limit` (default 50,
at most 500) and the opaque `cursor` from `nextCursor`.

## `select` and `write`

For a query that needs no declared View, `select` takes a JSON query over one
Schema:

```ts
const { rows } = await ctx.store.select({
  from: "tickets",
  columns: ["id", "subject"],
  where: { ticketState: "open", subject: { like: "%refund%" } },
  orderBy: { updatedAt: "desc" },
  limit: 20,
});
```

- `where`: `{ column: value }` is equality and sibling keys are AND; also
  `{ column: { eq, ne, gt, gte, lt, lte, like, in, notIn, isNull } }`, and
  `and`, `or`, `not`. `in` takes a list or `{ select, from, where }`.
- `orderBy`: one column; `id` breaks ties. Default `{ updatedAt: "desc" }`.
- `search`: text matched against `searchableFields` (and `id`).
- Native columns are camelCase here (`createdAt`, `authorId`), while SQL spells
  them snake_case (`created_at`).

`write` applies every operation or none, in order:

```ts
await ctx.store.write([
  { update: "tickets", set: { ticketState: "closed" }, where: { id }, lock: expectedVersion },
  { insert: "ticket-events", values: { ticketId: id, kind: "closed" } },
]);
```

- `insert` with `values`, optional client `id` (`ctx.store.id()`) and
  `onConflict: "ignore" | { columns, update }`.
- `update` with `set` and `where`; `delete` with `where`. A `where` that pins
  `id` is a row op: it may carry `lock` (the version the caller saw), and
  writing no row is `CONFLICT`.
- A result is `{ id, version }` for a row op and `{ affected }` for a set op.
- `set` and `values` never name the scope field or a native column; Store
  fills them. A `null` clears a field the Schema does not require; for a
  required field it is refused. On a `publishing` Schema, `set: { status }` is how a `ref`
  handler publishes, unpublishes or archives.

Failures throw `DiagnosticError` with `INPUT_VALIDATION_FAILED` (including a
failed `check`), `CONFLICT` (`conflict.reason` is `lock`, `expect` or
`unique`, and `conflict.opIndex` names the operation), `RESOURCE_UNAVAILABLE`
or `OUTCOME_UNKNOWN`. Nothing is written on any failure. After
`OUTCOME_UNKNOWN`, retry with the same client ids and locks: a replayed insert
conflicts on its id, a replayed update on its lock.

## From service code

The service's `fetch` receives the runtime. Resolve the caller first, as the
generated `withCaller` does, and bind Store to it:

```ts
const caller = await resolveCaller(request);
if (!("caller" in caller)) return new Response("unauthorized", { status: 401 });
const { rows } = await runtime.store.as(caller.caller).view("tickets-by-state", { input: { ticketState: "open" } });
```

To run a Procedure from service code, with its auth, guard and validation, call
`runtime.invokeProcedure({ procedure, input, caller, cause: { kind: "internal", id } })`.
Inside a handler, `ctx.invoke(name, input)` does the same and keeps the caller.
