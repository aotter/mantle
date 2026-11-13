---
description: The postgres.js client options, statement preparation and request-scoped clients for PostgreSQL through Hyperdrive.
---
# PostgreSQL through Hyperdrive

On `cloudflare-postgres` the application creates the [postgres.js](https://github.com/porsager/postgres) client and
passes it to generated code; Mantle does not own the client, its options or its lifetime. This page gives the settings
Mantle is tested with and the reasons, quoting Cloudflare's documentation.

> **Verification status:** Mantle's tests run in workerd under local Wrangler with a Hyperdrive binding whose
> `localConnectionString` points at a test database. Cloudflare documents that this mode connects "directly to the
> database without going through Hyperdrive" and that "Hyperdrive's connection pooling and query caching do not take
> effect". Nothing on this page has been verified on a deployed Hyperdrive configuration. In particular, the hangs and
> failures Cloudflare describes for unprepared queries below were not reproduced; the change was made on Cloudflare's
> documentation and on the wire traces Mantle's tests record.

## The client

Create one client per request, inside the handler:

```ts
import postgres from "postgres";

export const client = (env: { HYPERDRIVE: Hyperdrive }) =>
  postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false });
```

| Option | Setting | Why |
| --- | --- | --- |
| `prepare` | leave the default, `true` | Cloudflare's [postgres.js page](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-drivers-and-libraries/postgres-js/): "Do not use `prepare: false` with Postgres.js … Postgres.js then sends additional protocol messages to discover parameter types before each query. Hyperdrive's transaction pooling mode does not reliably support this behavior. This can cause queries to hang or fail intermittently." [Connection pooling](https://developers.cloudflare.com/hyperdrive/concepts/connection-pooling/): "Hyperdrive supports named prepared statements as implemented in the `postgres.js` and `node-postgres` drivers." |
| `fetch_types` | `false` | Cloudflare's example: "If you are not using array types in your Postgres schema, disable `fetch_types` to avoid an additional round-trip (unnecessary latency)". Generated code binds no arrays; set it to `true` if your own SQL binds PostgreSQL arrays. |
| `max` | `1` | Mantle runs a request's statements one after another, and a transaction holds its one connection. Cloudflare's example uses `max: 5` "due to Workers' limits on concurrent external connections"; raise it only if your own code runs queries concurrently. With `max: 1`, a query on the client awaited inside an open transaction of the same client waits for that transaction; Mantle refuses the outer handle inside a Store transaction for this reason. |
| lifetime | per request | [Connection lifecycle](https://developers.cloudflare.com/hyperdrive/concepts/connection-lifecycle/): "Do not create database clients or connection pools in the global scope. Instead, create a new client inside each handler invocation". It also says you "do **not** need to call … `sql.end()`". |

## How Mantle sends statements

Mantle's driver calls `unsafe(text, values, { prepare: true })` for every statement it runs: generated Views,
Procedures and Store calls, Better Auth through `postgresAdapter`, and the identity helpers. postgres.js's `unsafe`
otherwise sets `prepare: false` for that query, whatever the client's option, which Cloudflare's same page notes:
"queries using sql.unsafe() will set this to false". With the option, postgres.js sends what its tagged templates send:

| Statement | Before (unprepared) | Now (named) |
| --- | --- | --- |
| first use on a connection | `Parse('') Describe Flush`, then `Bind Execute Sync`: 2 round trips | `Parse(name) Describe Flush`, then `Bind Execute Sync`: 2 round trips |
| later uses on that connection | the same 2 round trips | `Bind Execute Sync`: 1 round trip |
| no bind values | simple `Query` | simple `Query` (unchanged) |

With a client per request, a statement is prepared once per request, so a request that runs each statement once makes
the same number of round trips as before and one that repeats a statement makes fewer.

- **Opting out.** A client created with `prepare: false` keeps every statement unnamed: postgres.js lets the client's
  option win over the query's. Use it only for a pooler that cannot handle named statements; on Hyperdrive Cloudflare
  advises against it.
- **Your own SQL.** `sql.unsafe(text, values)` that your code calls, including on the handle a Store transaction passes
  you, keeps postgres.js's default (unprepared). Pass `{ prepare: true }` yourself, or use tagged templates.
- **Query caching.** Cloudflare's [troubleshooting page](https://developers.cloudflare.com/hyperdrive/observability/troubleshooting/)
  names `prepare: false` as a reason queries are not cached. Mantle already requires a Hyperdrive configuration with
  caching disabled; one that left caching on was, in effect, uncached for Mantle's reads before, and is not now.
  Check the configuration (`wrangler hyperdrive get <id>`) before upgrading.
- **Schema changes.** A prepared statement whose result columns change under it (a migration adds a column a
  `RETURNING *` returns) fails inside a transaction with `0A000 cached plan must not change result type`; outside one,
  postgres.js re-prepares and retries. The failure is a PostgreSQL error, so Mantle reports the write as failed and
  rolled back, never as `OUTCOME_UNKNOWN`. With a client per request, only statements the same request already ran are
  exposed. Bun.SQL has always prepared every statement this way.
- **Bun.SQL** ignores the third argument and prepares every parameterised statement itself; nothing changes there.
