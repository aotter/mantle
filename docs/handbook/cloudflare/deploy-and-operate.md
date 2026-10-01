---
description: Deploy a Mantle 0.2.0 service to Cloudflare Workers, change Schemas safely with storage convergence, resolve a blocked change, and operate schedules, expiry and the boot handshake.
---
# Deploy and operate

## First deploy

```sh
pnpm exec mantle generate --check          # nothing stale
pnpm exec tsc --noEmit
pnpm exec wrangler d1 create my-service     # copy database_id into wrangler.jsonc's d1_databases[0]
pnpm exec wrangler secret put BETTER_AUTH_SECRET   # identity mantle
pnpm exec wrangler secret put ADMIN_EMAIL
pnpm exec wrangler deploy
```

Set `PUBLIC_ORIGIN` in `wrangler.jsonc` `vars` to the deployed origin, and
replace the console email sender first
([Authentication](./authentication.md#production)). The first request boots
the runtime, which creates every table the plan needs on the empty database.

Deploying anywhere is your choice: Cloudflare is the one generated preset,
and you may always self-host. Mantle Cloud is one option, never a
requirement.

## Changing Schemas

There are no migration files. Edit the manifests, run `mantle generate`, and
deploy. The first request after a plan change compares the database with the
plan:

- **Applied**: a new Schema table, a new field column, a new index, a new
  unique index that existing rows satisfy, new `checks` and search triggers.
- **Blocked** (`STORAGE_CHANGE_BLOCKED`, the service refuses to serve): a
  unique index that existing rows break, a field whose type changed, an index
  whose columns changed under the same name, an undeclared unique index.
- **Kept, with a warning**: a column or non-unique index the plan no longer
  declares. Nothing is dropped.

Before deploying, see what boot will do against a local SQLite file, such as
Wrangler's local D1 under `.wrangler/state/v3/d1/` after it has run the
previous plan:

```sh
pnpm exec mantle generate --check --database .wrangler/state/v3/d1/<…>.sqlite
```

It prints the SQL boot would run, the undeclared differences as comments, or
the blocked change (exit 1). It reads the file read-only.

### Resolving a blocked change

Mantle verifies; you change. The diagnostic names the change and hints SQL
that would reach the plan. For example, to make `email` unique when duplicates
exist: remove the duplicates (with a Procedure run as the system caller, or
`wrangler d1 execute`), then deploy again; boot creates the index. To rename a
field: add the new field, copy the data with a Procedure or SQL, then drop the
old field from the manifest (its column stays, unused). Never edit `_mantle_*`
tables.

### Hosts that refuse DDL from the Worker

If a host applies schema changes only through its own migration mechanism,
take the SQL `mantle generate --check --database` prints and deliver it
through that mechanism; boot then finds the database converged.

## Schedules

`wrangler.jsonc` `triggers.crons` holds the Cloudflare spelling of every
enabled schedule Trigger. `mantle generate` warns when it drifts from the plan;
update it by hand (the file is yours). Locally:

```sh
pnpm exec wrangler dev --local --test-scheduled
curl 'http://127.0.0.1:8787/__scheduled?cron=0+3+*+*+1'
```

The cron in the URL is the Cloudflare spelling.

## Expired rows

TTL hides expired rows at once. To delete them, call
`ctx.store.sweepExpired({ collection, limit })` in a schedule Trigger's `ref`
handler (the system caller's Store has it), or `runtime.store.sweepExpired` from
your own maintenance route, page with `nextCursor`, and use
`delete: false` to count first.

## The boot handshake

`runtime.bootReport()` returns `{ fingerprint, coreVersion }`. Pass
`expectedFingerprint` to `createMantle` to refuse booting any plan but the one
you built (`PLAN_FINGERPRINT_MISMATCH`). The fingerprint is in
`.mantle/generated/plan.json`; reformatting a manifest does not change it.

## Mantle Cloud

Deploying a 0.2.0 service to Mantle Cloud needs Cloud's host protocol 3, which
uploads the compiled plan and the service entry. Mantle Cloud does not accept
0.2.0 services yet. The plugin's `mantle` skill and its helper script check
the plan and the installed Core version so a project is ready when it does.

## Moving data from 0.1.x

Give the 0.2.0 service a new D1 database and import through
`runtime.store`; `docs/upgrade-0.1-to-0.2.md` describes the steps.
