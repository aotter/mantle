---
description: Procedures as SQL programs or ref handlers, atomic writes and optimistic locks, guards, lifecycle hooks, schedules, and how every source becomes one Invocation.
---
# Writes: Procedures, Triggers and lifecycle hooks

A Procedure is a write with a typed `input`, a typed `output` and a handler.
A Trigger says when it runs.

## Two kinds of handler

**SQL.** One or more `INSERT`, `UPDATE` or `DELETE` statements, separated by
`;`, applied as one batch: all of them or none.

```yaml
handler:
  sql: |
    INSERT INTO orders (itemId, qty, orderStatus, placedAt)
    SELECT id, input.qty, 'placed', now() FROM items WHERE id = input.itemId
    RETURNING id, qty;
    UPDATE items SET stock = stock - input.qty WHERE id = input.itemId
```

The result is `{ "results": [...] }`, one array of `RETURNING` rows per
statement. Statements pass values to each other only through tables. If the
second statement fails a `check` (`stock >= 0`), the first is rolled back too.

**`ref`.** A TypeScript function in the service's `handlers` map, for anything
SQL cannot do: calling another service, reading before writing, setting
`status`, branching on what it read.

```yaml
handler: { ref: cancelOrder }
```

```ts
export const handlers: MantleHandlers = {
  cancelOrder: async ({ orderId, expectedVersion }, ctx) => {
    await ctx.store.write([{ update: "orders", set: { orderStatus: "cancelled" }, where: { id: orderId }, lock: expectedVersion }]);
    return { id: orderId };
  },
};
```

A handler receives `(input, ctx)`. `input` is already validated against
`input`, and the return value is validated against `output`.

| `ctx.` | Is |
|---|---|
| `caller` | the [Caller](./authorization.md): `anonymous`, `user` or `system` |
| `cause` | why it runs: `{ kind: "http" \| "mcp" \| "internal" \| "schedule" \| "lifecycle", id, parent? }`, plus `cron` and `scheduledTime` for a schedule, `hook`, `schema` and `rows` for a hook. `id` is stable across retries |
| `store` | the typed Store, bound to the caller |
| `invoke(name, input)` | runs another Procedure with the same caller, re-checking its `requires` and guard |
| `env`, `waitUntil` | the host's environment and background-task hook |

Invocations nest at most 8 deep (`INVOCATION_DEPTH_EXCEEDED`), counting hooks
and `ctx.invoke`.

## What a write may not do

- Name the scope field or a native column (`id` on update, `version`,
  `status`, `created_at`, `updated_at`, `author_id`). Store fills them.
- Name an `id` in an `INSERT` on a scoped Schema: the compiler generates it.
- Use `last_insert_rowid()`, `OFFSET`, DDL, or a table that is not a Schema.

Set a timestamp field from `now()` and an owner field from `auth.uid()` in
the SQL, never from an input.

## Row ops, set ops and locks

A statement is a **row op** when its `WHERE` pins `id` to one value
(`WHERE id = input.id AND …`), or it is an `INSERT … VALUES` of one row
without `ON CONFLICT`. Everything else (`INSERT … SELECT`, `ON CONFLICT`, an
`UPDATE` by another column) is a **set op**.

- A row op that writes no row fails with `CONFLICT`, and the batch is rolled
  back. A set op that writes nothing is a normal result.
- `AND version = input.expectedVersion` makes a row op an optimistic lock: the
  caller sends the version it read, and a stale one is `CONFLICT` (HTTP 409).
- A Procedure with exactly one row op that pins `id` (and optionally
  `version`) to inputs gets its `target` inferred, which Admin uses to bind an
  operation to a row.

## Triggers

| `source.kind` | Fields | Runs the Procedure |
|---|---|---|
| `http` | `method` (`POST`, `PUT`, `PATCH`, `DELETE`), `path` | at that route on the REST surface. `path` starts with `/api/`; `{param}` segments bind to inputs of the same name |
| `mcp` | `surface: public \| staff` | as a tool on that MCP surface. `staff` also lists it as an Admin operation |
| `lifecycle` | `schema`, `on: [hooks]` | around writes to that Schema |
| `schedule` | `cron`, `enabled?` | on a five-field POSIX cron, UTC, weekday 0 = Sunday |

A Procedure with no Trigger can still be run by `ctx.invoke` or from service
code with `runtime.invokeProcedure`. Every source becomes the same
`Invocation` (`{ procedure, input, caller, cause }`), so `requires`, the
guard, input and output validation run the same way for all of them.

## Guards

`requires.guard.procedure` names a `ref` Procedure that runs after
`requires.auth` and input validation, before the target. It receives the
target's validated input and caller, gets a read-only Store, cannot invoke,
and rejects by throwing. Use it for a check that belongs to one action: an
entitlement, a bot token, a business rule. See
[Guarded API access](../../examples/guarded-api.md).

## Lifecycle hooks

```yaml
kind: Trigger
spec:
  source: { kind: lifecycle, schema: orders, on: [after_create, after_update] }
  target: { procedure: record-orders }
```

Hooks are `before_create`, `after_create`, `before_update`, `after_update`,
`before_delete`, `after_delete`, `before_publish` and `after_publish`. The
target is always a `ref` handler.

**Before hooks** are read-only checks for rules every path must obey, Admin and
imports included. A hook receives the one row in `ctx.cause.rows` (for an
insert, the row about to be written), reads with a read-only Store, and
rejects by throwing; nothing in the batch is applied. The write then carries
the version the hook saw, so a change in between is `CONFLICT`. A set op on a
Schema with a before hook for that operation is refused. Hooks run in op order,
and for one op in Trigger-name order.

**After hooks** run only after a commit, once per statement and Trigger, with
every row the statement wrote in `ctx.cause.rows`. Each row is the whole entry
as `ctx.store.select` returns it (`id`, `version`, `createdAt`, `updatedAt`,
`authorId`, every declared field), whatever the statement's own `RETURNING`
asked for: that only shapes the Procedure's result. Loop over them; never read
only `rows[0]`. A failure is logged and never undoes the commit, and a write
the hook makes is a new transaction. Delivery is best effort: a handler that
must not act twice deduplicates on `ctx.cause.id`.

## Schedules

```yaml
kind: Trigger
spec:
  source: { kind: schedule, cron: "0 3 * * 0" }   # Sundays 03:00 UTC
  target: { procedure: weekly-digest }
```

The target runs as the system caller: no caller scope, and no `requires.auth`
predicate holds for it, so it declares none. `ctx.cause.id` is
`<trigger>:<scheduledTime>`, the same for a replay. The service must pass
`schedules: true` to `createMantle` (the preset does); without it boot refuses
an enabled schedule with `SCHEDULE_NOT_WIRED`. The generated Cloudflare entry
maps Cloudflare's cron spelling back to the plan's; see
[The service and its entry](../cloudflare/service-entry.md).

## Webhooks

An HTTP Trigger receives parsed JSON, never the raw body. For a signed
webhook, add a route to the service's own `fetch`: verify the signature over
the raw body, then call `runtime.invokeProcedure` with a system caller. See
[Commerce inventory](../../examples/commerce-inventory.md).

## Further reading

- [Procedure reference](../reference/procedure.md)
- [Trigger reference](../reference/trigger.md)
