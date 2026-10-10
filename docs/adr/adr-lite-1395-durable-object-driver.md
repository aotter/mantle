# ADR-lite: Durable Object SQLite driver (experimental)

**Status:** Accepted direction for issue #1395. Follows ADR-0032 decision 6 and "How to apply" item 2 (host integrations are maintained examples, not Core contracts) and item 3 (the new public names are recorded in its Amendments), ADR-0040 §2 and ADR-0041.

## Decision

`durableObjectDriver(storage)` is a `DatabaseDriver` over a SQLite-backed `DurableObjectStorage`, exported from `@aotter/mantle/cloudflare` with `durableObjectStorage(storage, options?)` beside `d1Storage`. Both are `@experimental`: they may change in a minor version and are covered by neither the generated presets nor the packed-consumer check.

- Each `batch` is one native `transactionSync`; `all` and `first` use the native `sql.exec` cursor outside a transaction. No Mantle pool, lock, retry or coordinator (ADR-0040 §2).
- Binds are positional and `?N` is native. A boolean becomes 0 or 1 and `undefined` becomes null; everything else is unchanged. `maxBindings` is 100, the Durable Object per-statement limit.
- Engine errors are rethrown unchanged. The driver attaches nothing.
- `durableObject.ts` holds only the driver and type-only imports, so a Worker bundle importing it does not pull in the SQL parser or printer. `durableObjectStorage` lives in `cloudflare/index.ts`, as `d1Storage` does.

## Evidence

`test/cloudflare/durable-object.test.ts` runs the storage conformance suite and the constraint classification through `SqliteStoreExecutor` against real Durable Object SQLite in local workerd (wrangler 4.137, miniflare 5.20260921). Observed error: a plain `Error` with no `code`, the SQLite code in the message:

```
UNIQUE constraint failed: r.u: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_UNIQUE)
```

So the executor's existing rules classify UNIQUE, NOT NULL, the `MANTLE_CHECK` triggers, plain CHECK, foreign keys, `expect` and a missing table as on D1, and no driver-side mapping or executor change was needed. A mapping, if production errors ever lack the code, must attach `code` only for recognised SQLite refusal texts and never for platform errors (reset, timeout, overload), which stay `OUTCOME_UNKNOWN`.

This is local-workerd evidence. Production (deployed) error shapes are unconfirmed.

## Trust boundary

The handbook documents a Worker that authenticates on the shared database and forwards the caller to a Durable Object in a header. The Worker must overwrite the header on every request, the object must validate its shape and fall back to anonymous, the namespace must not be publicly addressable, and subjects must be namespaced per credential.

## Schedules

`invokeSchedule(cron)` runs every enabled Trigger with that spelling; it has no notion of the owning composition. A per-member Trigger therefore needs a cron spelling no Worker Trigger uses, the Worker's `scheduled` handler must skip it, and the alarm calls `invokeSchedule` only for it. The schedule ledger is per database.

## Non-goals

- Admin or MCP across many Durable Objects (needs its own ADR).
- A generated Durable Object preset.
- Cross-object transactions.
- Mantle computing alarm times.
- Any claim of production verification beyond local workerd.
