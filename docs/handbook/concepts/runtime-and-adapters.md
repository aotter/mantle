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
| a missing table, field column, index, or unique index that builds | creates it (on SQLite, `STRICT` tables with their check and FTS triggers) |
| a unique index that fails on existing rows, a column with another type, a changed index, a missing native column, a native column (`id`, `version`, `created_at`, `updated_at`, the scope field, `status`) that is nullable on PostgreSQL | refuses with `STORAGE_CHANGE_BLOCKED`, naming the change and a SQL hint (for a nullable native column: backfill, then `SET NOT NULL`) |
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
is Mantle SQL's reference dialect (ADR-0037), and its SQL is PostgreSQL's own
(ADR-0039): Mantle lowers nothing to imitate SQLite. It accepts D1's subset except
SQLite's own vocabulary (below), plus `WITH`, set operations, `LATERAL`, window
frames, `FILTER`, jsonb operators and the rest of the
[View reference](../reference/view.md)'s PostgreSQL table. A manifest targets one
dialect: it need not compile for D1 or return the same values there. D1 to
PostgreSQL is a migration (export, rewrite the SQL, import), not a switch.

A SQLite spelling fails validation with its position and the PostgreSQL one:

| SQLite (D1) | PostgreSQL |
|---|---|
| `FROM t, json_each(t.col) j`, `j.value` | `FROM t, jsonb_array_elements_text(t.col) WITH ORDINALITY AS j(value, n)` (`jsonb_array_elements` for jsonb values, `jsonb_each_text(t.col) WITH ORDINALITY AS j(key, value, n)` for an object) |
| `ORDER BY …, j.id` of `json_each` | `WITH ORDINALITY AS j(value, n)`, then `ORDER BY …, j.n` (a sorted View over a row source needs `WITH ORDINALITY`; Mantle pages by it) |
| `x ->> '$.a.b'`, `x ->> '$[0]'` | `x #>> '{a,b}'`, `x ->> 'a'`, `x ->> 0` (a `$…` string is refused: PostgreSQL would read it as a key) |
| `json_extract(x, '$.a')` | `x ->> 'a'` (text) or `x -> 'a'` (jsonb) |
| `json_remove(x, '$.a')` | `x - 'a'` |
| `json_set`, `json_insert` | build the value with `jsonb_build_object` or `jsonb_build_array` |
| `CAST(n AS bool)` of an integer | `n <> 0` (PostgreSQL has no bigint to boolean cast; `CAST('true' AS bool)` is unchanged) |
| `2 * 3 \|\| 4` (text by any type) | `2 * 3 \|\| '4'`, or `CAST(n AS text) \|\| …`: `\|\|` needs a text operand |
| `hex(x)`, `typeof(x)` | no equivalent on the allowlist; refused |
| `NULL` first when ascending | `NULL` last when ascending (PostgreSQL's; say `NULLS FIRST` to override) |

- Columns have native types: `timestamptz`, `date`, `numeric(p, s)`, `boolean`,
  `jsonb`, `bigint` and `double precision`. Values are decoded by the type
  PostgreSQL reports, so computed outputs (`now()`, `date_trunc`, a `CAST`) come
  back as wire values too: ISO date-times, booleans, parsed JSON.
- Every write batch is one `SERIALIZABLE` transaction, retried on a
  serialization failure, so a guard such as `WHERE NOT EXISTS` holds under
  concurrent writers as it does on SQLite's single writer.
- `checks` are `CHECK` constraints added `NOT VALID`: they bind every later
  write and leave older rows alone, like D1's triggers.
- `->>`, `||`, `CAST` and the jsonb row sources mean what PostgreSQL says; the
  only SQL function Mantle creates is `_mantle_expect`. A database booted by an
  earlier release keeps its `_mantle_jget`, `_mantle_bool` and `_mantle_json_each`
  unused. `json_group_array` and `json_group_object` order by value.
- Schema text columns Mantle creates use `COLLATE "C"`; a new text field
  added to an existing Schema table does too. This preserves the existing
  storage default independently of the database's locale. It is not a
  locale-aware alphabetical sort. Existing columns keep their actual
  collation: convergence neither checks nor migrates it, and Mantle does not
  adopt unrelated tables. The paging tiebreak uses the column's own collation
  so an index with that collation can serve it. Changing collation is an
  operator-planned change to ordering and indexes, not an automatic upgrade.
  An `ORDER BY` key without `NULLS FIRST/LAST`
  sorts NULL as PostgreSQL does: last ascending, first descending (D1 puts it
  first ascending). The `id` tiebreak follows the last key's direction, so an
  matching index on the sort keys (and the `updated_at` index Mantle creates)
  can serve a paged sort. This NULL order is PostgreSQL's default for every
  `ORDER BY`, window and aggregate (`json_group_array`) ones included. Values never depend on
  the server's `DateStyle`, `IntervalStyle` or `TimeZone`. Elsewhere the meaning
  is PostgreSQL's, where D1 differs:
  - `LIKE` is case-sensitive.
  - Division by zero is an error.
  - `->>` returns text.
- `searchableFields` and `mantle.near()` scan without an index in 0.2.0, and
  `mantle.search_rank()` counts occurrences rather than computing bm25.
  Site settings and media are SQLite-only (D1, bun:sqlite).
- `date_trunc` and `extract` compute in the site time zone
  (`postgresStorage({ connect, timeZone })`, default UTC).
- `statementTimeoutMs` defaults to 10 seconds. A write batch sets it with
  `SET LOCAL` on its transaction. A read is one autocommit statement under
  the role's own `statement_timeout`; with a nonzero configured limit, boot
  requires a positive role limit no larger than it
  (`ALTER ROLE app SET statement_timeout = '10s'`). Setting
  `statementTimeoutMs: 0` disables the write limit and that boot requirement;
  it does not change the role limit a read uses. Storage convergence disables
  the statement timeout and separately bounds lock waits
  ([deploy guidance](../cloudflare/deploy-and-operate.md#postgresql-convergence-and-long-index-builds)).
  A statement timeout fails with `RESOURCE_UNAVAILABLE`; a timed-out write
  batch rolls back.
- Boot reads the role's settings once and refuses to start, naming the
  `ALTER ROLE … SET` to run, unless `DateStyle` is ISO, `IntervalStyle` is
  `postgres`, `extra_float_digits` is at least 1, `standard_conforming_strings`
  is on and `TimeZone` is UTC (date and instant casts in your SQL use the
  session's zone). These are PostgreSQL's defaults, except a server initialized
  in another time zone. Configure these on the database role rather than
  relying on per-client `SET` commands surviving Hyperdrive's pooled-session
  reset; verify that behavior on the deployed binding as described below.
- Connect as a role that owns the service's tables but is not a superuser and
  holds no file or server privilege (`pg_read_server_files`,
  `pg_execute_server_program`). Mantle's allowlist refuses such functions; the
  role is the second line.

## Storage adapters

| Adapter | From | Driver |
|---|---|---|
| `d1Storage(env.DB, { timeZone?, site? })` | `@aotter/mantle/cloudflare` | Cloudflare D1, the one the preset uses |
| `sqliteStorage(driver, { timeZone?, maxBindings?, site?, restrict? })` | `@aotter/mantle/d1` | any `DatabaseDriver`: `{ batch(statements) }`, all or nothing |
| `postgresStorage({ connect, timeZone?, statementTimeoutMs?, restrict? })` | `@aotter/mantle/postgres` | `connect` opens one node-postgres (`pg`) client: Hyperdrive on Workers, a `pg.Pool` on Bun (ADR-0039) |
| `bunSqliteStorage(db, { timeZone?, site?, restrict? })` | `@aotter/mantle/bun` | a bun:sqlite `Database`; foreign keys are turned on |

`restrict(plan, context)` returns refusals of its own, run after the dialect's
on every program at runtime. It only narrows what runs, for an operator that
runs other people's plans; a self-hosted service leaves it out (ADR-0037).

On Workers, PostgreSQL goes through Hyperdrive, which owns pooling. Each
operation opens a native Client; its transaction or query closes that Client.
On Bun, the application owns one native Pool, and each operation releases its
PoolClient. No request-scoped client manager is involved (ADR-0041).

```ts
import pg from "pg";
import { postgresStorage } from "@aotter/mantle/postgres";

const connect = async () => {
  const client = new pg.Client({ connectionString: env.HYPERDRIVE.connectionString });
  await client.connect();
  return client;
};
const storage = postgresStorage({ connect });
```

For Bun, use `connect: () => pool.connect()` and pass the native Pool directly
to Better Auth. A write batch uses one acquired client for native SERIALIZABLE
BEGIN, sequential statements, and COMMIT. There is no custom pipeline or
automatic serialization/deadlock retry. Failed transactions attempt rollback;
unusable clients are discarded, and a lost COMMIT response is OUTCOME_UNKNOWN.

Real Hyperdrive verification remains an integration task; local Wrangler PG
connects directly and does not establish cloud proxy behavior. Verify role
settings after pooled-session reuse, a bare read after a write, revocation
freshness and atomic rollback on the deployed binding with caching disabled.
See [migration](../guides/native-execution.md) for existing application source.

The Worker needs `compatibility_flags: ["nodejs_compat"]` for `pg`. Mantle's
and Better Auth's reads run outside a transaction, which Hyperdrive would answer
from its cache, so create the Hyperdrive config with caching disabled
(`wrangler hyperdrive create … --caching-disabled`), or a read can miss the
write before it and a revoked session can be accepted until the cache expires. The same holds for a role
re-read and for a revoked grant: Auth's reads are single statements outside a transaction, so their freshness
depends on `--caching-disabled` too. `timeZone` must be an
IANA name: PostgreSQL reads an offset such as `+08:00` with the opposite sign.

Bun has a generated preset for both engines (`mantle generate --host bun`,
ADR-0038, ADR-0039): over PostgreSQL it is the Workers composition on a `pg.Pool`;
over SQLite `bunSqliteDriver` gives Better Auth the same store. A `DatabaseDriver` is one method, so another engine
(libSQL, for example) is a few lines of application code on `host: none`: the
entry calls `createMantle` and its own server. See
[Another host or engine](../guides/adapter-guide.md) for the driver contract
(numbered binds, rethrown engine errors with their code), schedules through
`invokeSchedule`, and what is untested.

`site` turns on the site capability (site settings and media); see
[Site defaults and site_config](../reference/site-config.md).

## Testing a service

Run the service under `wrangler dev` against a fresh local D1 and drive it over
HTTP, as the [reference service](../../examples/reference-service/README.md)'s
`smoke.mjs` does.
