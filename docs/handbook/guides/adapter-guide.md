---
description: How to run Mantle on another SQLite host or engine - the DatabaseDriver contract (numbered binds, rethrown engine errors), schedules, custom dialects, and what is untested.
---
# Another host or engine

0.1.x had per-host adapters (`@aotter/mantle-cloudflare`, `-bun`, `-vercel`,
`-indexeddb`) built on ADR-0011's storage ports. 0.2.0 replaced them
(ADR-0032 decision 6, ADR-0035): a service is a WinterTC `fetch`, and a host
differs only in its storage driver and how its entry is spelled. `mantle
generate` writes a preset for `host: cloudflare` (D1, or PostgreSQL through
Hyperdrive) and `host: bun` (node-postgres or bun:sqlite, ADR-0038, ADR-0039); `host: none`
writes the plan and types only (ADR-0036). This page says what to write for
any other host.

## Another SQLite host (libSQL, Node)

The built-in D1 dialect runs on any SQLite-family engine through a
`DatabaseDriver`, one method that applies statements in order, all or
nothing:

```ts
import type { DatabaseDriver } from "@aotter/mantle";
import { sqliteStorage } from "@aotter/mantle/d1";

const driver: DatabaseDriver = { async batch(statements) { /* run each { sql, binds } in one transaction; return [{ rows }] */ } };
const mantle = createMantle(service, { plan, storage: () => sqliteStorage(driver) });
```

Then spell the host's entry: `Bun.serve({ fetch: (r) => mantle.fetch(r, env) })`,
a Node HTTP handler, and so on. Schedules call
`mantle.invokeSchedule(posixCron, scheduledTime, env)` from the host's own
scheduler, and the service passes `schedules: true`. Set `"host": "none"`
and adapt `src/service.ts` from a preset. These hosts are not tested end to
end in 0.2.0. On a SQLite-backed Durable Object use the experimental
`durableObjectStorage` from `@aotter/mantle/cloudflare`; see
[Durable Object per tenant](../cloudflare/durable-object-tenant.md).
PostgreSQL on such a host is the same with `postgresStorage({
connect })` from `@aotter/mantle/postgres`.

Binds are numbered `?1`, `?2` in the order given; a driver whose engine binds
only anonymous `?` rewrites them in order (the CLI's `node:sqlite` driver does).
When a statement fails, `batch` rolls back and rethrows the engine's own error
unchanged, with its `code` (or `errcode`): the executor tells a refused
statement from one that never reached the engine by it.

## Another engine

A dialect is an npm package with a compile side (`<dialect>/compile`:
`name`, `version`, `accepts`) and a runtime side (a `MantleStorageAdapter`
whose executor runs the plan). Name it in `mantle.config.json` (`dialect`);
the plan records it and boot refuses another. A dialect is supported when it
passes `runStorageConformance` from `@aotter/mantle/testing` on a real engine.
See ADR-0035 and [Runtime, Store and dialects](../concepts/runtime-and-adapters.md).

## Surfaces and identity

They are host-neutral Fetch functions: `createRestSurface`,
`createMcpSurface`, `createAdminSurface` (with `assets` from
`@aotter/mantle-ui/admin`) and `createAuthRoutes`, each behind
`withCaller(resolver, …)`. Mount them on whatever router the host uses. See
[The service and its entry](../cloudflare/service-entry.md) and
[Authentication](../cloudflare/authentication.md).

## Not in 0.2.0

A browser or IndexedDB driver, Mantle-rendered public pages, and a generated
preset for any host but Cloudflare and Bun.
