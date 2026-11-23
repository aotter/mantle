---
description: The first deploy step by step (sign-in method, Cloudflare account, Wrangler login, database, secrets), schema installation and migrations, scheduled work, and operating a native Worker.
---
# Deploy and operate

Run the same generation command with `--check`, typecheck the application and test its selected routes before deploying. Keep generated TypeScript, SQL and Wrangler edits committed; keep bundle `dist/` untracked. The app owns the database, auth secrets, trusted origin and assets.

Deploy only when the user asks; creating a project locally is not authorization. Confirm the exact account and reuse the
resources it already has before creating any. For ChatGPT Sites, follow [Mantle on ChatGPT Sites](chatgpt-sites.md).

## Before the first deploy

An agent walks the user through these in order: it says what to click or run, then waits for the user to say it is
done. The user types every secret into Wrangler in their own terminal, never into chat or a file the agent writes. Steps
1–4 change nothing on Cloudflare; steps 5–8 create or change resources on the account, so they wait until the user asks
for the deploy.

1. **Sign-in method.** The email code `init` writes prints codes to the local log and sends none from a deployment.
   The user picks one of the three methods in [Choose how users sign in](sign-in-methods.md), and its recipe is
   applied and checked locally.
2. **Cloudflare account.** The user signs up at [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up) or
   uses an account they have. Email and password, and Cloudflare Email Service to any recipient, need Workers Paid
   ([Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/)); the other methods add no plan
   requirement of their own.
3. **Wrangler.** The app pins it as a dev dependency, so nothing is installed globally:
   `pnpm exec wrangler --version` prints the pinned version.
4. **Authorize Wrangler.** `pnpm exec wrangler login` opens the browser; the user signs in to Cloudflare and allows
   Wrangler. It stores an OAuth token on the user's machine, and `pnpm exec wrangler logout` revokes it
   ([Wrangler commands](https://developers.cloudflare.com/workers/wrangler/commands/general/)). Prefer it to an API
   token pasted into chat or saved in a file, where it outlives the session in transcripts, history or a repository.
   Without a browser on that machine (SSH, a container), add `--device` and open the printed link elsewhere. Then
   `pnpm exec wrangler whoami` shows the signed-in email and its accounts: the user confirms the account by name before
   anything is created. With several accounts, set `account_id` in `wrangler.jsonc` to the confirmed one. A
   `CLOUDFLARE_API_TOKEN` in the environment takes priority over the login, so `whoami` is where to see which one
   Wrangler uses.
5. **The database.** `pnpm exec wrangler d1 create mantle-app --binding DB --update-config`, with the `database_name`
   from `wrangler.jsonc`, creates it and writes its `database_id` into the `DB` entry (Wrangler rewrites the file with
   tabs). Without an id, `wrangler deploy` creates an empty database itself
   ([automatic provisioning](https://developers.cloudflare.com/workers/wrangler/configuration/)) and the Worker would
   answer before its schema exists. Install the schema once, on this new empty database, never on one that already has
   tables: `pnpm exec wrangler d1 execute DB --remote --file generated/schema.sql`
   ([install and change schemas](#install-and-change-schemas)).
6. **The origin.** `PUBLIC_ORIGIN` is the app's final HTTPS origin. Without a domain it is
   `https://<name>.<subdomain>.workers.dev`, from `name` in `wrangler.jsonc` and the account's `workers.dev` subdomain
   (dashboard, **Workers & Pages**). A custom domain must be a zone on the same account; add
   `"routes": [{ "pattern": "app.example.com", "custom_domain": true }]` and Cloudflare creates its DNS record and
   certificate ([custom domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)).
   No sign-in method needs a custom domain, but Cloudflare Email Service sends only from a domain on Cloudflare DNS.
   With GitHub sign-in, create the production OAuth App now, with this origin
   ([GitHub sign-in](sign-in-methods.md#github-sign-in)). Changing the origin later means changing it there too.
7. **Secrets.** For each name, the user runs `pnpm exec wrangler secret put <NAME>` in their terminal and types the value
   at Wrangler's prompt. `secrets.required` makes `wrangler deploy` refuse while one is unset. Before the first deploy
   the Worker does not exist yet, and Wrangler offers to create it as an empty placeholder that the deploy replaces.
   Wrangler also reads a value from standard input, so the auth secret can be set without ever being shown:

   ```sh
   openssl rand -hex 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
   ```

   | Sign-in method | Secrets |
   | --- | --- |
   | Every method | `BETTER_AUTH_SECRET` (a new random value, never the local one), `PUBLIC_ORIGIN`, `ADMIN_EMAIL` |
   | Email code | The sender's: an API key for a provider; Cloudflare Email Service uses a `send_email` binding and a sender address in `wrangler.jsonc` instead ([email](../guides/email.md)) |
   | GitHub | `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` from the production OAuth App; `ADMIN_GITHUB_LOGIN` with the username rule |
   | Email and password | None more |

8. **Deploy, when the user asks.** `pnpm exec wrangler deploy --dry-run` builds and lists the bindings without
   uploading; `pnpm exec wrangler deploy` builds and uploads. With email and password, the user then signs up right
   away and [promotes the first admin](sign-in-methods.md#the-first-admin). Then verify the checklist below on the
   deployed host.

## Production checklist

1. Migrations are reviewed, rehearsed on a copy and applied before traffic reaches the new code
   ([install and change schemas](#install-and-change-schemas)).
2. Secrets live in the host's secret store, never in source, chat or logs: the auth secret, the trusted HTTPS
   `PUBLIC_ORIGIN`, `ADMIN_EMAIL` and what the chosen [sign-in method](sign-in-methods.md) needs
   ([authentication](authentication.md)). The admin exists: through the bootstrap rule, or promoted by hand with
   passwords.
3. Admin assets are served Worker-first ([Workers assets and secrets](service-entry.md#workers-assets-and-secrets)) and
   both [public-fetch flags](#public-fetch-routing) stay in every environment.
4. After deploying, verify on the deployed host: admin sign-in gets role `admin`, a member is denied Admin, public and
   protected reads, a persisted write, a stale OCC write refused, and MCP `tools/list` after each connect step (a 2025
   `initialize` and a 2026-07-28 `server/discover`) with a real OAuth bearer.
5. Keep the previous build and the migration rollback until the release is verified.

## Public fetch routing

Workers use `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`.
The public-fetch flag routes native `fetch` through Cloudflare's public Internet
boundary. OAuth verification needs it to fetch JWKS on the service's own public
hostname; CIMD also requires this boundary for client metadata. `nodejs_compat`
alone does not establish it.

`mantle generate cloudflare-*` adds these flags without replacing other flags,
including in environments with their own `compatibility_flags` array. The same
command with `--check` refuses missing flags without writing. JSON/JSONC configs
are updated; TOML receives manual-edit instructions. Keep both flags in every
TOML environment override. An explicit `global_fetch_private_origin` is preserved
for applications without OAuth/CIMD, but conflicts with selected OAuth/CIMD auth
and with the public-fetch flag: generation refuses that config without rewriting
it. Such applications must use public routing for their OAuth/CIMD transport.

After deployment, complete a real OAuth sign-in and use the resulting bearer
for MCP `initialize`, `server/discover` and `tools/list`. Local development and cookie-only Admin
checks do not verify production public-hostname routing.

## Install and change schemas

The rules are in [schema installation and migrations](../concepts/runtime-and-adapters.md#schema-installation-and-migrations): the runtime runs no DDL, the initial `schema.sql` is only for an empty database, and every later change is a reviewed migration rehearsed on a copy and applied before the new code deploys.

Write each migration from the diff of `generated/schema.sql` ([schema migrations](../guides/migrations.md#write-a-migration) gives what each change needs on D1 and PostgreSQL). For D1, create a migration with `pnpm exec wrangler d1 migrations create <database> <name>`, write the statements in it, then rehearse `pnpm exec wrangler d1 migrations apply <database> --local` against copied data. Apply the reviewed migrations to the target before `wrangler deploy`. Initial DDL may be placed in the first migration for a new database.

For PostgreSQL, use the app's migration tool and deployment credentials. Plan lock waits and long index builds there; request credentials need no DDL privileges. Configure session settings on the role/database as described in [native execution](../guides/native-execution.md#postgresql-settings). Hyperdrive query caching must be disabled for authority and mutation visibility. Client options and per-request clients: [PostgreSQL through Hyperdrive](postgres-hyperdrive.md). A transaction that mixes the application's own SQL with generated Procedures uses transaction-scoped locks and settings under Hyperdrive; see [your own SQL in a Store transaction](../concepts/runtime-and-adapters.md#your-own-sql-in-a-store-transaction).

## Latency placement and D1 read replication

Measure these options against the application's real traffic; neither is a
default latency guarantee. [Smart Placement](https://developers.cloudflare.com/workers/configuration/placement/)
can move fetch execution closer to observed back-end services:

```jsonc
"placement": { "mode": "smart" }
```

A placed Worker runs every request that reaches it in that location, static files
included. Keep static prefixes out of `assets.run_worker_first` (the generated
default already excludes `/admin/assets/*` and `/assets/*`) so the edge answers them next to the
visitor; see [Workers assets](service-entry.md#workers-assets-and-secrets).

For globally distributed, read-heavy D1 traffic, enable
[read replication](https://developers.cloudflare.com/d1/best-practices/read-replication/)
on the database and pass one request-scoped `env.DB.withSession(...)` handle to
the selected generated Views, Procedures and Store. Those D1 entry points accept
`D1DatabaseSession`. Without the Sessions API, queries continue to use the primary.

Use `first-unconstrained` only when a replica snapshot is acceptable,
`first-primary` when the flow must start from the latest primary state, or carry
a bookmark between logical sessions for sequential consistency. Reuse the same
session within that logical flow; all writes still go to the primary. Keep fresh
authentication/authorization checks and mutation/read-after-write paths on their
required current-authority path rather than weakening them for replica latency.

## Scheduled work

The application owns its schedule: it declares the crons in `wrangler.jsonc` and exports `scheduled()`, which calls
generated Procedures as a system caller. A manifest has no `schedule` source
(ADR-lite #2111). Keep one checked map from cron to the
work it runs; a test holds it equal to the Wrangler list, so the two cannot drift. With this manifest:

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: login_codes }
spec:
  title: Login codes
  lifecycle: operational
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    type: object
    required: [code, expiresAt]
    properties:
      code: { type: string }
      expiresAt: { type: string, format: date-time }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: carts }
spec:
  title: Carts
  lifecycle: operational
  schema:
    type: object
    required: [cartState]
    properties:
      cartState: { type: string, enum: [open, closed] }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: close-stale-carts }
spec:
  description: Close the carts nobody touched for 24 hours. Run by the scheduler as the system caller.
  input: { type: object, additionalProperties: false, properties: {} }
  output: { type: object }
  handler:
    sql: |
      UPDATE carts SET cartState = 'closed'
        WHERE cartState = 'open' AND updated_at < now() - CAST('24 hours' AS interval)
        RETURNING id
```

```ts
// src/schedule.ts
import { toCloudflareCron } from "@aotter/mantle/cron";
import sweepLoginCodes from "../generated/procedures/login_codes.sweepExpired.js";
import closeStaleCarts from "../generated/procedures/close-stale-carts.js";

type Env = { DB: D1Database };
const system = (job: string) => ({ kind: "system", reason: `cron: ${job}` }) as const;

/** POSIX cron (UTC, weekday 0 = Sunday) → the jobs it runs. */
export const schedules: Record<string, Record<string, (env: Env) => Promise<unknown>>> = {
  "*/15 * * * *": {
    "login_codes.sweepExpired": env => sweepLoginCodes(env.DB, system("login_codes.sweepExpired"), { limit: 500 }),
  },
  "0 3 * * 1": {
    "close-stale-carts": env => closeStaleCarts(env.DB, system("close-stale-carts"), {}),
    "login_codes.sweepExpired": env => sweepLoginCodes(env.DB, system("login_codes.sweepExpired"), { limit: 500 }),
  },
};
// Cloudflare spells weekdays 1-7 (1 = Sunday); `controller.cron` is the spelling wrangler.jsonc lists.
const byCron = new Map(Object.entries(schedules).map(([cron, jobs]) => [toCloudflareCron(cron), jobs]));
if (byCron.size !== Object.keys(schedules).length) throw new Error("Two schedules map to one Cloudflare cron.");

export async function scheduled(controller: ScheduledController, env: Env): Promise<void> {
  const jobs = byCron.get(controller.cron);
  if (!jobs) throw new Error(`No scheduled work for cron "${controller.cron}".`);
  const names = Object.keys(jobs);
  const outcomes = await Promise.allSettled(names.map(name => jobs[name]!(env)));
  outcomes.forEach((outcome, i) => console.log(JSON.stringify({ cron: controller.cron, job: names[i], outcome: outcome.status })));
  const failed = names.filter((_, i) => outcomes[i]!.status === "rejected");
  if (failed.length)
    throw new AggregateError(
      outcomes.flatMap(outcome => (outcome.status === "rejected" ? [outcome.reason] : [])),
      `Scheduled jobs failed for "${controller.cron}": ${failed.join(", ")}`,
    );
}
```

The Worker exports it beside `fetch` (`export default { fetch, scheduled }`), and `wrangler.jsonc` lists the
Cloudflare spelling of each key: `"triggers": { "crons": ["*/15 * * * *", "0 3 * * 2"] }`. An unknown cron and a failed
job both throw, so the invocation shows as failed in Workers Logs, and the other jobs of that cron still ran. The
system Caller's `reason` names the job. Cloudflare does not document automatic retries for Cron Triggers: keep each job
bounded (a sweep's `limit`, with the rest left for the next run) and safe to run twice.

```ts
// schedule.test.ts, beside wrangler.jsonc
import assert from "node:assert/strict";
import { test } from "node:test";
import { toCloudflareCron } from "@aotter/mantle/cron";
import { unstable_readConfig } from "wrangler";
import { schedules } from "./src/schedule.js";

test("wrangler.jsonc declares exactly the crons the schedule map runs", () => {
  const declared = unstable_readConfig({ config: "wrangler.jsonc" }).triggers.crons ?? [];
  assert.deepEqual([...declared].sort(), Object.keys(schedules).map(toCloudflareCron).sort());
});
```

A host that runs applications as Workers it dispatches to must invoke each application's `scheduled()` itself. The
application's declaration is still its `triggers.crons`, which the host reads to know what to run and when.

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

Scheduling is app-owned: see [scheduled work](#scheduled-work) and [TTL maintenance](../guides/native-execution.md#ttl-maintenance). Expired rows remain stored and hold unique keys until removed.

An `OUTCOME_UNKNOWN` write may have committed; reconcile before deciding what to do next and never retry automatically. For MCP Apps, verify a newly invoked render tool on the deployed host and keep old
conversations working with the [retained-page recipe](../guides/mcp-apps.md#keep-old-conversations-working-after-an-upgrade).
Deploying an application never publishes or bumps the SDK.
