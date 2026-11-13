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

Create one client per request, inside the handler. Objects that live for the isolate (a Better Auth instance, Mantle's
REST, MCP and Admin surfaces) must not hold a client: a postgres.js client kept at module scope answers its first
request, and under local Wrangler the next request then fails with "Cannot perform I/O on behalf of a different
request" (the one after that reconnects and succeeds, and so on). Give those objects a handle that resolves the current
request's client instead. Save this as `src/db.ts`:

```ts
// src/db.ts: one postgres.js client per request, reachable from objects built once per isolate.
import { AsyncLocalStorage } from "node:async_hooks";
import postgres from "postgres";
import type { Postgres } from "@aotter/mantle/contracts";

const clients = new AsyncLocalStorage<Postgres>();

/** Runs `fn` with a fresh client; nothing needs to close it (Hyperdrive cleans up when the request ends). */
export function withRequestDb<T>(env: { HYPERDRIVE: Hyperdrive }, fn: () => T): T {
  return clients.run(postgres(env.HYPERDRIVE.connectionString, { max: 1, fetch_types: false }), fn);
}

function current(): Postgres {
  const client = clients.getStore();
  if (!client) throw new Error("No PostgreSQL client for this request: call it inside withRequestDb.");
  return client;
}

/** The current request's client, for objects built once per isolate. Pass it wherever Mantle takes a `Postgres`. */
export const requestDb: Postgres = {
  unsafe: (text, values, options) => current().unsafe(text, values, options),
  begin: (options, fn) => current().begin(options, fn),
};
```

`src/db.ts` imports `node:async_hooks`, so the Worker needs the `nodejs_compat` compatibility flag, which postgres.js
already requires. The client connects on its first query, so creating one on a request that never touches the
database costs nothing. Background work the request hands to `ctx.waitUntil` (Better Auth's tasks through
`withAuthTasks`) keeps the request's context and so its client; do not call `sql.end()` yourself, or such a task finds
the client closed.

Every other handler that reaches the database through `requestDb` (directly, through generated code or through Better
Auth) wraps its work the same way; outside `withRequestDb`, `requestDb` throws:

```ts
// src/jobs.ts: a cron trigger and a queue consumer; each invocation gets its own client, like a request.
import { requestDb, withRequestDb } from "./db.js";

type Env = { HYPERDRIVE: Hyperdrive };
export default {
  scheduled: (_controller: ScheduledController, env: Env, ctx: ExecutionContext) =>
    ctx.waitUntil(
      withRequestDb(env, async () => {
        await requestDb.unsafe("SELECT 1", []);
      }),
    ),
  queue: (batch: MessageBatch<{ id: string }>, env: Env) =>
    withRequestDb(env, async () => {
      for (const message of batch.messages) await requestDb.unsafe("SELECT $1::text", [message.body.id]);
    }),
};
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

## Better Auth on PostgreSQL

Keep one Better Auth instance per isolate, as the D1 [app shell](../../examples/app-shell/README.md) does, and give
`postgresAdapter` the request handle from `src/db.ts`. The instance and its plugins are built once, behind `authLoader`
and a dynamic import, so Better Auth stays out of Worker startup and requests that never read a session never load it;
every query it sends goes to the client of the request it serves. Building Better Auth per request instead also works,
but costs about 0.6 ms of CPU per authenticated request (median of 50 constructions with the `admin`, `emailOTP` and
`jwt` plugins, Bun 1.4 on one machine; about 7 ms for the first) and does not fit the app shell, which also installs
its in-process JWKS fetch once per isolate.

`src/auth.ts`, the PostgreSQL counterpart of the app shell's (add its hardening, sign-up gate and MCP plugins the same way):

```ts
// src/auth.ts: Better Auth over the request's client; loaded only on a request that needs auth.
import { betterAuth } from "better-auth/minimal";
import { admin, emailOTP } from "better-auth/plugins";
import type { BetterAuthOptions } from "better-auth/types";
import { postgresAdapter } from "@aotter/mantle/auth/adapter";
import { postgresBootstrapAdmin } from "@aotter/mantle/auth/identity";
import { requestDb } from "./db.js";

export type AuthEnv = { BETTER_AUTH_SECRET: string; PUBLIC_ORIGIN: string; ADMIN_EMAIL: string };

export function authOptions(env: AuthEnv) {
  const origin = env.PUBLIC_ORIGIN || "https://example.invalid";
  const plugins = [
    admin({ defaultRole: "user", adminRoles: ["admin"] }),
    emailOTP({
      sendVerificationOTP: async ({ email, otp }) => {
        // Replace with a real sender (guides/email.md) before deploying.
        if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) throw new Error("Configure an email sender.");
        console.log(`${email}: one-time code is ${otp}`);
      },
    }),
  ];
  const bootstrap = env.ADMIN_EMAIL
    ? postgresBootstrapAdmin(requestDb, { match: "email", value: env.ADMIN_EMAIL }, () => ({ options: { plugins } }))
    : async () => {};
  return {
    database: postgresAdapter(requestDb),
    secret: env.BETTER_AUTH_SECRET || "schema-generation-placeholder-secret",
    baseURL: origin,
    basePath: "/api/auth",
    plugins,
    databaseHooks: { user: { create: { after: bootstrap }, update: { after: bootstrap } } },
    session: { storeSessionInDatabase: true },
    verification: { storeInDatabase: true },
  } satisfies BetterAuthOptions;
}

export const createAuth = (env: AuthEnv) => betterAuth(authOptions(env));
```

The Worker entry wraps each request in `withRequestDb` and passes `requestDb` to generated code and to Mantle's
surfaces (`rest({ db: () => requestDb, … })`), so auth and data share the request's one client:

```ts
// src/index.ts: one Better Auth instance per isolate, one PostgreSQL client per request.
import { authLoader, resolveCaller } from "@aotter/mantle/auth";
import { authRoutes } from "@aotter/mantle/auth/routes";
import { withAuthTasks } from "@aotter/mantle/auth/hardening";
import { surfaceFailure } from "@aotter/mantle/contracts";
import { requestDb, withRequestDb } from "./db.js";
import type { AuthEnv } from "./auth.js";

type Env = AuthEnv & { HYPERDRIVE: Hyperdrive };
let auth: ReturnType<typeof authLoader<ReturnType<typeof import("./auth.js").createAuth>>> | undefined;

export default {
  fetch: (request: Request, env: Env, ctx: ExecutionContext) =>
    withRequestDb(env, async () => {
      auth ??= authLoader(() => import("./auth.js").then(m => m.createAuth(env)));
      try {
        const own = await withAuthTasks(ctx.waitUntil.bind(ctx), () =>
          authRoutes(auth!, { methods: [{ kind: "email-otp" }] })(request),
        );
        if (own) return own;
        const caller = await resolveCaller(request, auth);
        // Generated code takes the handle as it would a client: procedures.book(requestDb, caller, input).
        const [{ now }] = await requestDb.unsafe("SELECT now()::text AS now", []);
        return Response.json({ caller: caller.kind, now });
      } catch (error) {
        return surfaceFailure(error);
      }
    }),
};
```

`tests/auth-postgres-worker.test.ts` runs `src/db.ts` and `src/auth.ts` from this page unchanged in workerd under local
Wrangler, through a Hyperdrive binding, with a generated Procedure in place of the `SELECT`: email-OTP sign-in (which
makes the first user admin through `postgresBootstrapAdmin`, a transaction), three cookie-authenticated requests in the
same isolate and an authenticated write.

### When the connection is lost

A write whose connection fails after it was sent (Hyperdrive or the origin drops it, or the request's client is
closed) may have committed. Mantle reports it as `OUTCOME_UNKNOWN` ("The write outcome is unknown; reconcile before
retrying."), which `surfaceFailure` answers with HTTP 503: read the row again before deciding whether to retry. A failure
PostgreSQL answers with an error (a constraint, a serialization failure, `0A000`) is reported as that error and
nothing was written. Better Auth's own writes go through the same driver, so a lost connection during sign-in reaches
Better Auth as an error and the sign-in fails; the user signs in again.
