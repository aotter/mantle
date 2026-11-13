# ADR-lite: PostgreSQL on Workers through Hyperdrive

**Status:** Proposed, issue #2018. Amends the PostgreSQL driver of [ADR-0045](0045-next-runtime-core.md); adds no
subpath and no grammar. Nothing here was verified on a deployed Hyperdrive configuration.

## Context

Mantle's PostgreSQL driver sent every statement with `db.unsafe(text, binds)`. postgres.js 3.4.9's `unsafe` sets
`prepare: false` on the query, and the query's option overrides the client's (`src/connection.js`:
`q.prepare = options.prepare && ('prepare' in q.options ? q.options.prepare : true)`), so a parameterised statement
always took the unnamed describe-first path: `Parse('') Describe Flush`, then `Bind Execute Sync`, on every execution.
The handbook said statement preparation was "the postgres.js client's option, unchanged by Mantle", which was not true.

Cloudflare's postgres.js page says: "Do not use `prepare: false` with Postgres.js … Postgres.js then sends additional
protocol messages to discover parameter types before each query. Hyperdrive's transaction pooling mode does not
reliably support this behavior. This can cause queries to hang or fail intermittently", and its example notes that
"queries using sql.unsafe() will set this to false". Its connection-pooling page says "Hyperdrive supports named
prepared statements as implemented in the `postgres.js` and `node-postgres` drivers." No statement-count limit is
documented on the limits page. The hang or failure itself was not reproduced: local Wrangler connects directly to the
database.

Recorded locally through a TCP proxy (postgres.js 3.4.9, `max: 1`, `fetch_types: false`; flights are round trips):

| Call | First execution | Repeated |
| --- | --- | --- |
| `unsafe(sql, binds)` (Mantle before) | `P('')DH`, `B('')ES` | `P('')DH`, `B('')ES` |
| `unsafe(sql, binds, { prepare: true })` | `P(named)DH`, `B(named)ES` | `B(named)ES` |
| tagged template | `P(named)DH`, `B(named)ES` | `B(named)ES` |
| either, client `prepare: false` | `P('')DH`, `B('')ES` | `P('')DH`, `B('')ES` |
| Bun.SQL 1.3.14 / 1.4.4, with or without the option | `P(named)DS`, `B(named)ES` | `B(named)ES` |

Inside `begin` the same holds per statement. Bun.SQL ignores a third argument and always prepares named statements.

## Decision: statement preparation (P1-1)

1. **Mantle's driver passes `{ prepare: true }`** to `unsafe` for every statement it sends (`read`, and therefore
   `run`, Procedures, the Store, `postgresAdapter`, the identity helpers). The `Postgres` contract's `unsafe` gains an
   optional third parameter, `options?: { prepare?: boolean }`; an implementer with two parameters still conforms, and
   Bun.SQL ignores it. On postgres.js Mantle's wire traffic becomes the same as postgres.js's own tagged templates, the
   configuration Cloudflare's example uses.
2. **It is the default, with the client as the switch.** A client created with `prepare: false` still wins, so an
   application behind a pooler without named-statement support keeps unnamed statements by configuring the client, as
   postgres.js documents. No Mantle option is added.
3. **The application's own `sql.unsafe` is unchanged**, including on the raw handle a Store transaction passes: Mantle
   forwards whatever options the application passes and adds none.

Rejected: an opt-in Mantle option (every Workers application would have to find it to follow Cloudflare's advice, and
the handbook already promised that the client's option governs); routing Mantle's SQL through tagged templates (a
second code path for one driver, and the generated SQL is already text with `$n` binds).

### Consequences

- With a client per request, each statement is prepared once per request: a request that runs each statement once
  makes the same round trips as before (two per parameterised statement), and a repeated statement costs one. An
  exploratory local run through a proxy adding about 1 ms each way measured medians of 5.7 vs 5.8 ms for one read,
  22.2 vs 19.6 ms for a two-statement Procedure plus a read, and 16.2 vs 11.2 ms for three executions of one read
  (before vs after; not an acceptance measurement).
- A Hyperdrive configuration that left query caching on, against the handbook, was in effect uncached for Mantle's
  reads (Cloudflare names `prepare: false` as a cause of uncached queries) and now caches them. The release notes ask
  applications to confirm caching is disabled.
- A schema change that alters a prepared statement's result columns (a column added under `RETURNING *`) fails that
  statement inside a transaction with `0A000 cached plan must not change result type` (postgres.js retries it outside
  one). It is a PostgreSQL error, so the write is reported as failed and rolled back. Bun.SQL already behaved this way.
- Hyperdrive's behaviour with named statements (statement reuse across its pooled origin connections, any limits) can
  only be confirmed on a deployed configuration.

## Context: Better Auth on Workers (P1-2)

The handbook and `postgresAdapter`'s docstring said to create the postgres.js client "per request, or per isolate with
`max: 1`". Reproduced under `wrangler dev --local` with a Hyperdrive `localConnectionString`: a client cached at module
scope answered request 1, failed request 2 with "Cannot perform I/O on behalf of a different request", reconnected on
request 3 and failed request 4. Cloudflare's connection-lifecycle page: "Do not create database clients or connection
pools in the global scope. Instead, create a new client inside each handler invocation". The only auth wiring shown
(the D1 app shell) keeps one Better Auth instance per isolate over `d1Adapter(env.DB)`, and `postgresAdapter`,
`postgresBootstrapAdmin` and `postgresIdentity` had run only under Bun.

## Decision: request-scoped handle, one Better Auth instance per isolate (P1-2)

4. **The documented wiring keeps one Better Auth instance per isolate over a request-scoped `Postgres` handle**: an
   application-owned `src/db.ts` creates the postgres.js client per request inside `AsyncLocalStorage.run`, and
   `requestDb` (a `Postgres` whose `unsafe` and `begin` call the current request's client) goes to `postgresAdapter`,
   `postgresBootstrapAdmin` and generated code. Better Auth stays behind `authLoader` and a dynamic import, so the
   entry-static closure is unchanged.
5. **No new SDK export.** The handle is about twenty lines of application code on a Node API workerd provides under
   `nodejs_compat`; Mantle adds it to its own surface when applications ask for it (an extension point request).
6. **The handbook page's `src/db.ts` and `src/auth.ts` are the tested code**: `tests/auth-postgres-worker.test.ts`
   extracts them and runs them in workerd under local Wrangler through a Hyperdrive binding (email-OTP sign-in with the
   bootstrap admin transaction, three cookie-authenticated requests in one isolate, a generated two-statement
   Procedure), and `check:doc-examples` typechecks the page.

Rejected: building Better Auth per request (measured about 0.6 ms of CPU per construction, median of 50 with the
`admin`, `emailOTP` and `jwt` plugins on Bun 1.4, about 7 ms for the first; it sends no queries, but it does not fit
the app shell, which installs its in-process JWKS fetch once per isolate); a client per isolate with `max: 1`
(reproduced failing); a Mantle option to make `postgresAdapter` take a function (the same request scoping, as SDK
surface, before anyone asked for it).

### Consequences

- Auth and data share the request's one client when the entry passes `requestDb` to Mantle's surfaces.
- A query outside `withRequestDb` throws instead of reusing another request's client.
- Background tasks a request hands to `waitUntil` keep its context and client; the application does not end the
  client.
