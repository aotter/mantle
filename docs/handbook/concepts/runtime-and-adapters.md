---
description: How createMantle boots the runtime from a storage adapter, how storage converges to the plan, the D1 dialect and other SQLite drivers, and the fingerprint handshake.
---
# Runtime, Store and dialects

```
src/index.ts (host entry) ─▶ mantle = createMantle(service, { plan, storage, schedules })
                                 │ first request: createMantleRuntime → storage.prepare(plan)
                                 ▼
service.fetch(request, env, { runtime, waitUntil })
  └ surfaces / your routes ─▶ runtime.invokeProcedure · runtime.store
                                 └ Store: policy rewrite → dialect check → StoreExecutor
```

## `createMantle`

```ts
createMantle(service, { plan, storage: (env) => MantleStorageAdapter, schedules?, expectedFingerprint? })
// → { fetch(request, env, ctx?), invokeSchedule(cron, scheduledTime, env, ctx?), runDeferredHook(message, env, ctx?) }
// runDeferredHook replays an after-hook Invocation from your own queue; nothing in Mantle emits one
```

- `service` is `{ handlers, fetch(request, env, { runtime, waitUntil }) }`, a
  WinterTC fetch the application owns. Mantle owns no route of its own: the
  service decides what is mounted where.
- The runtime boots lazily on the first call, once per isolate. A failed boot
  is retried by the next request.
- `invokeSchedule` runs every enabled schedule Trigger whose cron is exactly
  the given POSIX expression, as the system caller.
- The host entry is a few lines the generator writes once
  ([The service and its entry](../cloudflare/service-entry.md)); Core handles
  no platform event types.

`createMantleRuntime(args)` is the same boot without the service, for tests
and custom hosts. The runtime exposes `plan`, `store`, `invokeProcedure`,
`bootReport()` (`{ fingerprint, coreVersion }`) and, with site defaults,
`site`.

## Boot checks

Boot refuses to serve when:

- a plan `ref` has no handler (`HANDLER_NOT_REGISTERED`), or a handler is not
  in the plan (`HANDLER_NOT_DECLARED`);
- the plan was compiled for another dialect, or does not match
  `expectedFingerprint` (`PLAN_FINGERPRINT_MISMATCH`);
- an enabled schedule exists without `schedules: true` (`SCHEDULE_NOT_WIRED`);
- storage has a change it cannot make (`STORAGE_CHANGE_BLOCKED`), or a table
  Mantle would create already exists without being Mantle's
  (`STORAGE_TABLE_NOT_OWNED`).

## Storage converges to the plan

There are no migration files for Schema tables. When the plan's fingerprint
differs from the one the database last booted, boot reads the database's
actual tables and indexes, compares them with the plan, and:

| Difference | Boot |
|---|---|
| a missing table, field column, index, or unique index that builds | creates it (`STRICT` tables, check and FTS triggers included) |
| a unique index that fails on existing rows, a column with another type, a changed index, a missing native column | refuses with `STORAGE_CHANGE_BLOCKED`, naming the change and a SQL hint |
| a column or non-unique index the plan no longer declares | keeps it and warns; nothing is ever dropped |

A renamed field is a new empty column beside the old one: copy the data
yourself. A blocked change is the author's to make (SQL through the host's own
tool, a data-copy Procedure, a dedupe), then boot checks again. With the same
fingerprint boot reads nothing. `mantle generate --check --database <file>`
prints the same diff against a local database without applying it.

Mantle's own tables (`_mantle_*`) and its product tables (`site_config`,
`media_assets`, `pending_media_uploads`) keep versioned migrations of their
own. Identity `mantle` migrates Better Auth's tables through Better Auth.

## The D1 dialect

The SQL language is PostgreSQL syntax, pinned to PostgreSQL 18's parser. A
**dialect** decides which of it an engine runs and how. The built-in dialect,
`@aotter/mantle/d1`, runs on SQLite as D1 does: its compile side refuses what
D1 cannot compute exactly, and its runtime side prints SQLite, encodes types
and converges storage.

- `date-time` (and `created_at` / `updated_at`) is stored as microseconds,
  `date` as days, `numeric(p, s)` as an integer of the smallest unit, so
  arithmetic is exact on D1. On the wire a date-time is an ISO string.
- `checks` are enforced by triggers. `x-mantle-ref` is checked by
  `mantle generate` and used by Admin; storage does not enforce it in 0.2.0.
  `searchableFields` uses
  an FTS5 trigram index; `format: geo` uses an R*Tree.
- `date_trunc` and `extract` compute in the site time zone
  (`d1Storage(db, { timeZone })`, default UTC).

`mantle.config.json` may name another dialect package (`dialect`); it must pass
`runStorageConformance` from `@aotter/mantle/testing`. A plan records its
dialect, and boot refuses a plan compiled for another one.

## Storage adapters

| Adapter | From | Driver |
|---|---|---|
| `d1Storage(env.DB, { timeZone?, site? })` | `@aotter/mantle/cloudflare` | Cloudflare D1, the one the preset uses |
| `sqliteStorage(driver, { timeZone?, maxBindings?, site? })` | `@aotter/mantle/d1` | any `DatabaseDriver`: `{ batch(statements) }`, all or nothing |

A `DatabaseDriver` is one method, so a Bun (`bun:sqlite`) or libSQL driver is
a few lines of application code. Those hosts have no generated preset; their
entry calls `createMantle` and their own server. They are not tested end to end
in 0.2.0.

`site` turns on the site capability (site settings and media); see
[Site defaults and site_config](../reference/site-config.md).

## Testing a service

Run the service under `wrangler dev` against a fresh local D1 and drive it over
HTTP, as the [reference service](../../examples/reference-service/README.md)'s
`smoke.mjs` does.
