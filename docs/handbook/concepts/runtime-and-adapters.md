---
description: How createMantle boots the runtime from a storage adapter, how storage converges to the plan, the D1 and PostgreSQL dialects, and the fingerprint handshake.
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
- Each entry call binds its own `ctx.waitUntil` to the runtime facade handed
  to the service. Handler calls, nested invocations and Store lifecycle hooks
  retain work on that entry's context, including concurrent requests. Calls
  without a context do not borrow another request's retainer.
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

`mantle.config.json` names the dialect (`sqlite`, `postgres`, or another dialect package, which must pass
`runStorageConformance` from `@aotter/mantle/testing`). A plan records its
dialect, and boot refuses a plan compiled for another one.

## The PostgreSQL dialect

`"dialect": "postgres"` in `mantle.config.json` compiles the plan for
PostgreSQL (13 or later). On Cloudflare, `mantle generate --dialect postgres`
writes the preset over Hyperdrive; on any other platform, add `"host": "none"`
and compose `createMantle` with `postgresStorage` yourself (ADR-0036). PostgreSQL
is Mantle SQL's reference dialect (ADR-0037): it accepts D1's subset without
SQLite's own `typeof`, `hex`, `json_extract`, `json_set`, `json_insert` and
`json_remove` (write `x ->> '$.path'`), plus `WITH`, set operations, `LATERAL`,
window frames, `FILTER`, jsonb operators and the rest of the
[View reference](../reference/view.md)'s PostgreSQL table. A manifest that uses
them no longer compiles for D1; one that does not moves between engines with a
recompile.

- Columns have native types: `timestamptz`, `date`, `numeric(p, s)`, `boolean`,
  `jsonb`, `bigint` and `double precision`. Values are decoded by the type
  PostgreSQL reports, so computed outputs (`now()`, `date_trunc`, a `CAST`) come
  back as wire values too: ISO date-times, booleans, parsed JSON.
- Every write batch is one `SERIALIZABLE` transaction, retried on a
  serialization failure, so a guard such as `WHERE NOT EXISTS` holds under
  concurrent writers as it does on SQLite's single writer.
- `checks` are `CHECK` constraints added `NOT VALID`: they bind every later
  write and leave older rows alone, like D1's triggers.
- `json_each`, `->>` and `CAST(x AS bool)` read as they do on D1 through small
  SQL functions Mantle creates (`_mantle_json_each`, `_mantle_jget`,
  `_mantle_bool`). `json_group_array` and `json_group_object` order by value.
- Results match D1 where Mantle decides them. Text columns use `COLLATE "C"`,
  so they compare by code point. An `ORDER BY` key without `NULLS FIRST/LAST`
  puts NULL first ascending, as Core pages every View. Values never depend on
  the server's `DateStyle`, `IntervalStyle` or `TimeZone`. Elsewhere the meaning
  is PostgreSQL's, where D1 differs:
  - `LIKE` is case-sensitive.
  - Division by zero is an error.
  - `->>` returns text.
  - `||` prints booleans and floats as PostgreSQL does.
- `searchableFields` and `mantle.near()` scan without an index in 0.2.0, and
  `mantle.search_rank()` counts occurrences rather than computing bm25.
  Site settings and media are D1-only.
- `date_trunc` and `extract` compute in the site time zone
  (`postgresStorage({ connect, timeZone })`, default UTC).
- Every statement has a `statement_timeout` of 10 seconds, pinned in each
  transaction (`statementTimeoutMs`; 0 is none). Storage convergence has none.
  A statement past it fails with `RESOURCE_UNAVAILABLE` and writes nothing.
- Connect as a role that owns the service's tables but is not a superuser and
  holds no file or server privilege (`pg_read_server_files`,
  `pg_execute_server_program`). Mantle's allowlist refuses such functions; the
  role is the second line.

## Storage adapters

| Adapter | From | Driver |
|---|---|---|
| `d1Storage(env.DB, { timeZone?, site? })` | `@aotter/mantle/cloudflare` | Cloudflare D1, the one the preset uses |
| `sqliteStorage(driver, { timeZone?, maxBindings?, site?, restrict? })` | `@aotter/mantle/d1` | any `DatabaseDriver`: `{ batch(statements) }`, all or nothing |
| `postgresStorage({ connect, timeZone?, statementTimeoutMs?, restrict? })` | `@aotter/mantle/postgres` | `connect` opens one node-postgres (`pg`) client; Hyperdrive on Workers |

`restrict(plan, context)` returns refusals of its own, run after the dialect's
on every program at runtime. It only narrows what runs, for an operator that
runs other people's plans; a self-hosted service leaves it out (ADR-0037).

On Workers, PostgreSQL goes through Hyperdrive, which pools the connections, so
`connect` opens a client per operation (a socket must not outlive its request):

```ts
import pg from "pg";
import { pgDatabaseDriver, pgPool, postgresStorage } from "@aotter/mantle/postgres";

const connect = (env: Env) => async () => {
  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  return client;
};
// storage: (env) => postgresStorage({ connect: connect(env) })
// identity: createMantleAuth({ database: pgPool(connect(env)), driver: pgDatabaseDriver(connect(env)), ... })
```

The Worker needs `compatibility_flags: ["nodejs_compat"]` for `pg`. Mantle runs
every read in a transaction, which Hyperdrive never answers from its cache.
Better Auth's reads (sessions, roles) do not, so create the Hyperdrive config
with caching disabled (`wrangler hyperdrive create … --caching-disabled`), or a
revoked session can be accepted until the cache expires. `timeZone` must be an
IANA name: PostgreSQL reads an offset such as `+08:00` with the opposite sign.

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
