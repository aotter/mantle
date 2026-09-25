---
description: Production checklist, the check loop, deploy and post-deploy probes, day-to-day content operations, and version pins.
---
# Deploy and operate

This page is the production checklist for a Mantle Worker on Cloudflare: what to pin and configure, which checks to run before `wrangler deploy`, how to verify a deployment, how content is operated afterwards, and how to move versions.

## Before the first deploy

- Pin every `@aotter/mantle*` package to one exact version and commit the lockfile. Install with `pnpm install --frozen-lockfile` (or `npm ci`) from then on. See [Project and CLI](../start/project-and-cli.md).
- Set `PUBLIC_ORIGIN` to the real HTTPS origin, without a trailing slash. It drives canonical URLs, `.md` mirrors, `llms.txt`, the MCP resource and the OAuth callback. If a static documentation build also emits absolute URLs, give it the same value.
- Set the production D1 `database_id` (and `account_id` if your deployment needs it) in `wrangler.jsonc`. A local `database_name` is not a production identifier, and local D1 is not production data.
- Choose production Auth: a generated CF app uses `MANTLE_AUTH_MODE=self-managed` or `hosted` with `ADMIN_GITHUB_LOGIN` and the matching provider credentials. Local `local-otp` works only on loopback. If you author your own Worker Auth factory, replace console email delivery with a real `EmailSender`. Store secrets with `wrangler secret put`. See [Authentication](./authentication.md).
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

A required path fails on a required Schema-table scan, a temporary sort or an unindexed data-field predicate. Then dry-run and deploy:

This local SQLite check intentionally runs without planner statistics. Treat it
as a conservative preflight; use post-deploy D1 metrics for production cost and
latency claims.

```sh
wrangler deploy --dry-run
wrangler deploy
```

## Post-deploy verification

Probe the deployed origin, not `wrangler dev`. Run only the probes for surfaces
the application mounts and configures:

| Probe | Expect |
|---|---|
| `GET /api/views/<public-view>` | `200`, `{ "ok": true, "data": { "rows": [...] } }` |
| `GET /<locale>/<segment>/<slug>` and `GET /<locale>/<segment>/<slug>.md` | `200` HTML and Markdown for a published entry |
| `GET /llms.txt`, `GET /sitemap.xml`, `GET /robots.txt` | `200` |
| `GET /<locale>/<segment>/does-not-exist` | `404` from your `notFoundRenderer` |
| `POST /mcp/staff` without credentials | `401` with `WWW-Authenticate`; `GET /mcp` is `405` |
| `GET /admin` | Sign-in page; sign in with the `ADMIN_GITHUB_LOGIN` account |

Then check the cache: a second anonymous `GET` of a public page should show `cf-cache-status: HIT`; publish a change in Admin and the next request should be a `MISS`. Sample latency with:

```sh
pnpm exec mantle-harness http --base-url https://example.com \
  --route recent=/api/views/recent-posts --route page=/en/posts/hello --rounds 20 --warmup 2
```

## Operating content

Sign in to Admin with a staff account. Publishing collections (`lifecycle: publishing`) follow draft, publish, verify:

1. Create a draft with its title, slug, locale and body.
2. Publish (`editor` or above). The write purges the deployment-scoped public cache tag.
3. Open the public URL and its `.md` mirror. Drafts never appear on pages, mirrors, `llms.txt` or the sitemap; use `?preview=1` with a staff session to see one.
4. Unpublish removes the entry from every public surface; the Admin delete action and the Staff MCP `archive_entry` tool retire it.

Operational collections (`lifecycle: operational`) have no publish step; records are edited in place and do not purge the public cache. The same operations are available to agents through Staff MCP; see [MCP and agents](../concepts/mcp-and-agents.md).

Site settings split by owner. Brand, title and description seed once from `siteDefaults` and are then edited in Admin (`owner`); each edit purges the public cache. Origin, icons, locales and media purposes are code-owned and re-sync from `siteDefaults` on every boot, so change them in the Worker and redeploy. Analytics, pixels and search-engine verification are host chrome, not Core settings; see [Site chrome](./site-chrome.md) and [Site config](../reference/site-config.md).

## Changing versions

Pin every selected `@aotter/mantle*` package to one exact version and keep them together. This handbook describes the snapshot in this source tree; use the docs that ship with the version you install.

1. Pin the new exact release for every selected package and update the lockfile through the package manager; review peer ranges.
2. Keep application source, Worker/D1/KV identity, origins, auth mode and secrets.
3. Run `mantle generate`, `generate --check`, `skills`, `skills --check`, `validate`, typecheck and tests.
4. Test local routes and authorization, then deploy.

Each Manifest Schema is a native table. Safe additive storage changes deploy online. Destructive changes — including any `uniqueIndexes` tuple add, remove, reorder or rewrite — are rejected; rebuild the instance and move required data outside Mantle. There is no in-product data-move workflow.

## Source
- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`docs/direct-authoring.md`](../../../docs/direct-authoring.md)
- [`docs/performance-harness.md`](../../../docs/performance-harness.md)
- [`docs/examples/host-minimal-worker/README.md`](../../../docs/examples/host-minimal-worker/README.md)
- [`docs/examples/host-minimal-worker/package.json`](../../../docs/examples/host-minimal-worker/package.json)
- [`docs/examples/host-minimal-worker/wrangler.jsonc`](../../../docs/examples/host-minimal-worker/wrangler.jsonc)
- [`docs/examples/host-minimal-worker/smoke.mjs`](../../../docs/examples/host-minimal-worker/smoke.mjs)
- [`packages/mantle-spec/src/domain/model/SiteConfig.ts`](../../../packages/mantle-spec/src/domain/model/SiteConfig.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`packages/adapters/cloudflare/src/oauth/cachePolicy.ts`](../../../packages/adapters/cloudflare/src/oauth/cachePolicy.ts)
