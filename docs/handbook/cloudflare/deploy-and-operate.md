---
description: Install schema explicitly, migrate before deploying, and operate a native Worker.
---
# Deploy and operate

Run the same generation command with `--check`, typecheck the application and test its selected routes before deploying. Keep generated TypeScript, SQL and Wrangler edits committed; keep bundle `dist/` untracked. The app owns the database, auth secrets, trusted origin and assets.

## Install and change schemas

The runtime never creates, alters or checks tables. Boot and requests run no DDL, introspection or schema checks.

For the first install, apply generated `schema.sql`, including selected auth/site DDL, to an empty database. Apply selected seed SQL explicitly.

For every later schema change, the application's coding agent diffs the regenerated `schema.sql`, writes a migration with the host's native tool (`wrangler d1 migrations` or the app's PostgreSQL migration tool), rehearses it on a copy, and applies it before deploying the new code. Cloud executes migrations at deploy time.

Destructive changes and type changes need explicit data migration. Mantle drops nothing. Initial `schema.sql` is not an upgrade script.

For D1, create a migration with `pnpm exec wrangler d1 migrations create <database> <name>`, review its SQL, then rehearse `pnpm exec wrangler d1 migrations apply <database> --local` against copied data. Apply the reviewed migrations to the target before `wrangler deploy`. Initial DDL may be placed in the first migration for a new database.

For PostgreSQL, use the app's migration tool and deployment credentials. Plan lock waits and long index builds there; request credentials need no DDL privileges. Configure session settings on the role/database as described in [native execution](../guides/native-execution.md#postgresql-settings). Hyperdrive query caching must be disabled for authority and mutation visibility.

## Operate

Enable Workers Logs and traces in production. The top-level `observability.enabled` alone does not enable traces:

```jsonc
"observability": {
  "enabled": true,
  "logs": { "enabled": true, "head_sampling_rate": 1 },
  "traces": { "enabled": true, "head_sampling_rate": 0.01 }
}
```

Auth configuration and production email delivery are app-owned; follow [authentication](authentication.md). Keep secrets in the platform's secret store. With `secrets.required`, `wrangler deploy` refuses to upload while a required secret is unset: set them with `wrangler secret put` (or pass `--secrets-file` on the first deploy). Serve the selected Admin assets through the [native Admin](../guides/native-admin.md) shell contract.

Scheduling is app-owned. Wire generated system-only TTL sweeps into `scheduled()` and configure Wrangler crons explicitly. Bound each invocation and retain a cursor if work remains; see [TTL maintenance](../guides/native-execution.md#ttl-maintenance). Expired rows remain stored and hold unique keys until removed.

After deployment, verify public and protected reads, member/admin sign-in, a persisted write, stale OCC and selected MCP/Admin/web routes. An `OUTCOME_UNKNOWN` write may have committed; reconcile before deciding what to do next and never retry automatically.
