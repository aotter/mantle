---
description: Production checklist, the check loop, deploy and post-deploy probes, day-to-day content operations, and upgrades.
---
# Deploy and operate

This page is the production checklist for a Mantle Worker on Cloudflare: what to pin and configure, which checks to run before `wrangler deploy`, how to verify a deployment, how content is operated afterwards, and how to upgrade.

## Before the first deploy

- Pin every `@aotter/mantle*` package to one exact version and commit the lockfile. Install with `pnpm install --frozen-lockfile` (or `npm ci`) from then on. See [Project and CLI](../start/project-and-cli.md).
- Set `PUBLIC_ORIGIN` to the real HTTPS origin, without a trailing slash. It drives canonical URLs, `.md` mirrors, `llms.txt`, the MCP resource and the OAuth callback. If a static documentation build also emits absolute URLs, give it the same value.
- Set the production D1 `database_id` (and `account_id` if your deployment needs it) in `wrangler.jsonc`. A local `database_name` is not a production identifier, and local data is not migrated.
- Choose `MANTLE_AUTH_MODE` and store the secrets with `wrangler secret put`. See [Authentication](./authentication.md).
- Keep `compatibility_flags: ["nodejs_compat", "global_fetch_strictly_public"]`.
- Enable observability:

```jsonc
"observability": { "enabled": true, "logs": { "head_sampling_rate": 1 } },
"upload_source_maps": true
```

## The check loop

Run the project's `check` script before every deploy. The minimal reference chains:

```sh
mantle generate && mantle generate --check && mantle validate \
  && mantle skills && mantle skills --check && tsc --noEmit && node smoke.mjs
```

Add tests and the frontend build where the project has them, then confirm index coverage for every public View:

```sh
pnpm exec mantle-harness indexes --require-public --format text
```

A required path fails on an `entries` table scan, a temporary sort or an unindexed data-field predicate. Then dry-run and deploy:

```sh
wrangler deploy --dry-run
wrangler deploy
```

## Post-deploy verification

Probe the deployed origin, not `wrangler dev`:

| Probe | Expect |
|---|---|
| `GET /api/views/<public-view>` | `200`, `{ "ok": true, "data": { "rows": [...] } }` |
| `GET /<locale>/<segment>/<slug>` and `GET /<locale>/<segment>/<slug>.md` | `200` HTML and Markdown for a published entry |
| `GET /llms.txt`, `GET /sitemap.xml`, `GET /robots.txt` | `200` |
| `GET /<locale>/<segment>/does-not-exist` | `404` from your `notFoundRenderer` |
| `GET /mcp` without credentials | `401` with `WWW-Authenticate` |
| `GET /admin` | Sign-in page; sign in with the `ADMIN_GITHUB_LOGIN` account |

Then check the cache: a second anonymous `GET` of a public page should show `cf-cache-status: HIT`; publish a change in Admin and the next request should be a `MISS`. Sample latency with:

```sh
pnpm exec mantle-harness http --base-url https://example.com \
  --route recent=/api/views/recent-posts --route page=/en/posts/hello --rounds 20 --warmup 2
```

## Operating content

Sign in to Admin with a staff account. Publishing collections (`lifecycle: publishing`) follow draft, publish, verify:

1. Create a draft with its title, slug, locale and body.
2. Publish (`editor` or above). The write purges the `mantle-public` cache tag.
3. Open the public URL and its `.md` mirror. Drafts never appear on pages, mirrors, `llms.txt` or the sitemap; use `?preview=1` with a staff session to see one.
4. Unpublish removes the entry from every public surface; the Admin delete action and the Staff MCP `archive_entry` tool retire it.

Operational collections (`lifecycle: operational`) have no publish step; records are edited in place and do not purge the public cache. The same operations are available to agents through Staff MCP; see [MCP and agents](../concepts/mcp-and-agents.md).

Site settings split by owner. Brand, title and description seed once from `siteDefaults` and are then edited in Admin (`owner`); each edit purges the public cache. Origin, icons, locales and media purposes are code-owned and re-sync from `siteDefaults` on every boot, so change them in the Worker and redeploy. See [Site config](../reference/site-config.md).

## Upgrading

Read the migration notes shipped with the target release before changing versions; docs on the development branch do not describe your installed version. The 0.1.2 line removes `mantle create`, the bundle `mantle update` and `@aotter/mantle/provision`; `generate`, `validate`, `emit-openapi` and `skills` remain. To upgrade:

1. Pin the new exact release for every selected package and update the lockfile through the package manager; review peer upgrades.
2. Remove scripts that call retired commands. Keep application source, Worker/D1/KV identity, origins, auth mode and secrets.
3. Run `mantle generate`, `generate --check`, `skills`, `skills --check`, `validate`, typecheck and tests.
4. Test local routes and authorization, then deploy.

## Source
- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`docs/direct-authoring.md`](../../../docs/direct-authoring.md)
- [`docs/migration-0.1.2.md`](../../../docs/migration-0.1.2.md)
- [`docs/performance-harness.md`](../../../docs/performance-harness.md)
- [`docs/examples/minimal-worker/README.md`](../../../docs/examples/minimal-worker/README.md)
- [`docs/examples/minimal-worker/package.json`](../../../docs/examples/minimal-worker/package.json)
- [`docs/examples/minimal-worker/wrangler.jsonc`](../../../docs/examples/minimal-worker/wrangler.jsonc)
- [`docs/examples/minimal-worker/smoke.mjs`](../../../docs/examples/minimal-worker/smoke.mjs)
- [`packages/mantle-spec/src/domain/model/SiteConfig.ts`](../../../packages/mantle-spec/src/domain/model/SiteConfig.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`packages/adapters/cloudflare/src/oauth/cachePolicy.ts`](../../../packages/adapters/cloudflare/src/oauth/cachePolicy.ts)
