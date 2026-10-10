---
description: Read and write through the typed Store from handlers and service code, call named Views, and choose between ctx.store, runtime.store and runtime.store.as(caller).
---
# Query from TypeScript

Handler and service code reach Mantle-owned rows only through Store. The
generated `.mantle/generated/mantle.ts` types it over your Schemas and Views:
`ctx.store` in a `MantleHandlers` handler is its `CallerStore`, while
`runtime.store` is the untyped `MantleStore` until you cast it to the
generated `Store`.

| Store | Where | Scope |
|---|---|---|
| `ctx.store` | inside a `ref` handler | bound to the invocation's caller. Only an authorization guard gets a read-only one |
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
`filters` (`ctx.store.view(name, { search: "refund", filters: { ticketState: "open" } })`);
Store refuses a filter the View does not declare. An output that reads a
Schema field unchanged has that field's type, `created_at` and `updated_at`
are `string | null`, and an expression, or another native column such as `id`,
is `unknown`. Page with `limit` (default 50, at most 500) and the opaque
`cursor` from `nextCursor`.

## Readers (`db`)

Every Schema has a reader on `ctx.db` (the same object as `ctx.store.db`, also
`runtime.store.db` and `runtime.store.as(caller).db`), named by the lower-camel
form of the Schema's name: `tickets` is `ctx.db.tickets`, `ticket-events` is
`ctx.db.ticketEvents`. A name that has no such form (a non-ASCII name, or one
starting with a digit) is the Schema's lower-case name, `ctx.db["2fa"]`. Two
Schemas that become one name, and the reserved names `constructor`, `then`,
`__proto__`, `prototype`, `toString`, `valueOf` and `hasOwnProperty`, are
refused with `SCHEMA_READER_NAME_COLLISION`.

```ts
const ticket = await ctx.db.tickets.get(id);                       // one row or null
const next = await ctx.db.tickets.first({ where: { ticketState: "open" }, orderBy: { createdAt: "asc" } });
const { rows, nextCursor } = await ctx.db.tickets.find({
  where: { ticketState: "open", subject: { like: "%refund%" } },
  columns: ["id", "subject"],                                      // the row is Pick<Row, "id" | "subject">
  limit: 20,
});
```

- `get(id, { columns })`, `first(query)` and `find(query)`. A query is
  `{ where, columns, orderBy, search }`; `find` also takes `limit` (1 to 500,
  default 50) and the opaque `cursor` from `nextCursor`.
- `where` is **AND only**: `{ column: value }` is equality, `{ column: null }`
  is `IS NULL`, and `{ column: { eq, ne, gt, gte, lt, lte, like, in, notIn, isNull } }`
  compares. `in` and `notIn` take a non-empty list without `null`. For `or`,
  `not`, a subquery, a join or an aggregate, declare a View and call
  `store.view`.
- `orderBy` is one column, and `id` breaks ties. The default is
  `{ updatedAt: "desc" }`. `search` is matched against `searchableFields` (and
  `id`).
- A row has the native columns (`id`, `version`, `createdAt`, `updatedAt`,
  `status` on a `publishing` Schema, `authorId` or `null`) and every field the
  Schema declares except its scope field, each as its type or `null` (a column
  is not required in storage, so a read can find it empty).
- A reader returns every status of a `publishing` Schema, drafts included:
  published-only is the rule for a public View. Scope, TTL and `requires` apply
  as they do to every Store read.
- Each query shape is converted and compiled once per Store, then reused for
  every caller; only the values change between calls. Values are checked on
  every call.

Without generated types, `runtime.store.db` is a `StoreDb` of untyped readers.
`readerOf(store.db, "tickets")` (from `@aotter/mantle`) returns the reader of a
Schema by name, in any case.

## `select` and `write`

`select` is deprecated and is removed in the next alpha: use a reader. For a
query that needs no declared View, `select` takes a JSON query over one
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

- `where` (writes keep all of this; reads through a reader are AND only):
  `{ column: value }` is equality and sibling keys are AND; also
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
  `onConflict: "ignore" | { columns, update }`. A scoped Schema refuses a
  client `id`, because a chosen id could collide with another owner's row and
  reveal it: give such rows a field of your own that is unique with the scope
  field (`uniqueIndexes: [[owner, clientKey]]`) when other rows of the same
  write must point at them, or when a retry must find them.
- `update` with `set` and `where`; `delete` with `where`. A `where` that pins
  `id` is a row op: it may carry `lock` (the version the caller saw), and
  writing no row is `CONFLICT`.
- A result is `{ id, version }` for a row op and `{ affected }` for a set op.
- `set` and `values` never name the scope field or a native column (except
  `status` on a `publishing` Schema, below); Store
  fills them. A `null` leaves empty, or clears, a field the Schema does not
  require (the generated `values` and `set` types accept it); for a required
  field it is refused. On a `publishing` Schema, `set: { status }` is how a `ref`
  handler publishes, unpublishes or archives.

Failures throw `DiagnosticError` with `INPUT_VALIDATION_FAILED` (including a
failed `check`), `CONFLICT` (`conflict.reason` is `lock`, `expect` or
`unique`, and `conflict.opIndex` names the operation; for `unique` it is
present when exactly one operation of the write targets the violated Schema,
since the engine names the table and not the statement), `RESOURCE_UNAVAILABLE`
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
