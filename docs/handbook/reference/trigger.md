---
description: Trigger field reference for Mantle 0.2.0 — http, mcp, lifecycle and schedule sources, POSIX cron and its Cloudflare translation, and the diagnostics each raises.
---
# Trigger

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: place-order-http }
spec:
  source: { kind: http, method: POST, path: /api/orders }
  target: { procedure: place-order }
```

`target.procedure` names a declared Procedure
(`TRIGGER_TARGET_PROCEDURE_UNKNOWN`). Several Triggers may target one
Procedure; each source runs it as an `Invocation` with the same `requires`,
guard and validation.

## `http`

| Field | Values |
|---|---|
| `method` | `POST`, `PUT`, `PATCH`, `DELETE` (reads are Views) |
| `path` | starts with `/api/` (`TRIGGER_PATH_INVALID`); `{param}` segments bind to inputs of the same name, coerced to their declared types |

The REST surface answers it. The JSON body and the path parameters merge into
the input (a path parameter wins). A `(method, path)` pair is unique
(`TRIGGER_PATH_COLLISION`); a route with fewer parameters is tried first, so
`/api/items/search` is not shadowed by `/api/items/{id}`. The answer is the
Procedure's output, or `{ "error": … }`. `ctx.cause.kind` is `http`.

The body is parsed JSON. For a signed webhook, verify the raw body in the
service's own `fetch` and call `runtime.invokeProcedure`.

## `mcp`

| Field | Values |
|---|---|
| `surface` | `public` (`/mcp`) or `staff` (the staff MCP surface; also an Admin operation) |

The tool is named after the Procedure, kebab to snake case
(`MCP_TOOL_NAME_COLLISION` when two names meet). Give the Procedure a
`description` (`MCP_TOOL_DESCRIPTION_MISSING` warns). `ctx.cause.kind` is
`mcp`.

## `lifecycle`

| Field | Values |
|---|---|
| `schema` | the Schema watched (`LIFECYCLE_SCHEMA_UNKNOWN`) |
| `on` | non-empty: `before_create`, `after_create`, `before_update`, `after_update`, `before_delete`, `after_delete`, `before_publish`, `after_publish` |

The target is a `ref` Procedure (`LIFECYCLE_TARGET_NOT_REF`). `ctx.cause` is
`{ kind: "lifecycle", trigger, hook, schema, rows, id }`.

- A **before** hook runs before the batch, receives the one row (for an insert,
  the row about to be written), reads only, and rejects by throwing; nothing is
  applied. The write then locks the version the hook saw. Before hooks on one
  operation run in Trigger-name order.
- An **after** hook runs after the commit, once per statement and Trigger, with
  every written row in `rows` (each with `id` and `version`). A failure is
  logged and never undoes the write. `id` is stable for a replay.

A hook sees the originating caller. Any path that writes the Schema fires its
hooks: SQL Procedures, `ctx.store`, Admin. A set op on a Schema with a before
hook for that operation is refused.

## `schedule`

| Field | Values |
|---|---|
| `cron` | five-field POSIX cron in UTC; weekday 0 = Sunday |
| `enabled` | optional, default `true` |

The target runs as the system caller with input `{}`. It may not declare
`requires.auth` predicates (`SCHEDULE_AUTH_INVALID`), and its input must
accept an empty object (`SCHEDULE_INPUT_INVALID`). `ctx.cause` is
`{ kind: "schedule", trigger, cron, scheduledTime, id: "<trigger>:<scheduledTime>" }`.

The service passes `schedules: true` to `createMantle`; without it boot
refuses an enabled schedule (`SCHEDULE_NOT_WIRED`).

### Cloudflare

Cloudflare numbers weekdays 1 (Sunday) to 7. `toCloudflareCron` from
`@aotter/mantle/cloudflare` adds one to every explicit weekday number and
leaves `*`, names and the other fields alone:

| POSIX (manifest) | Cloudflare (`wrangler.jsonc`) |
|---|---|
| `0 3 * * 0` | `0 3 * * 1` |
| `0 9 * * 1-5` | `0 9 * * 2-6` |
| `*/5 * * * *` | `*/5 * * * *` |

It refuses what it cannot translate faithfully: `?`, `L`, `W`, `#`, weekday
`7`, numbers with a leading zero, a backwards range, a name with a step, and a
day of month together with a weekday. `mantle generate` runs it on every
enabled schedule and fails before writing on a refusal. The generated
`src/index.ts` maps Cloudflare's cron back to every POSIX expression that
shares it.
