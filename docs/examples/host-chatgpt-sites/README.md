# Mantle on ChatGPT Sites: runnable reference

The runnable application for [Mantle on ChatGPT Sites](../../handbook/sites/index.md) connects Sites D1 + R2 bindings, Sign in with ChatGPT identity, Mantle Admin and staff roles, same-origin media upload, a published-only article frontend, and anonymous read-only `/api/mcp` for public Views. Remote `/mcp/staff` is deliberately **not** claimed or mounted; see [MCP support](../../handbook/sites/host-reference.md#remote-mcp-is-a-separate-gate).

**SDK requirement:** this revision requires the checkout's `mountMantleAdmin.mcpEndpoints` support. Published `0.1.2-alpha.6` does not include it, even though the checkout still carries that version number. Use the exact packed-checkout workflow below; copying this folder and running `npm ci` against the registry is not a supported reproduction of this revision. Build typechecking and the endpoint smoke assertions reject that mismatch. Once a release contains this change, update every Mantle dependency and the lockfile together before switching back to registry installation.

After setup, follow [Publish your first article](../../handbook/sites/index.md#publish-your-first-article) to verify the editorial workflow in Admin.

## Before writing code

Read the user's business request and author the manifest for **their** records and lifecycle. The included `articles` example deliberately allows a title-only draft; `body` uses `x-mcp-hint: markdown`, while `coverAssetId` uses both `x-mantle-ref: media_assets` (Admin picker) and `x-mcp-hint: media-image` (agent guidance). The `published-articles` View is a list projection, not the detail page contract. If the user's content must always have a body, add it to `required`; if the public API must return body or cover ID, add those to the View's `fields`. Review staff roles, public filters and indexes before deployment. `mantle validate` checks grammar, **not** whether this model matches the business request. Manifest changes after deployment require a new reviewed D1 migration and matching storage fingerprint; never edit an applied migration.

## Local reproduction

1. Start from a clean, committed Mantle checkout containing this change. Record its `git rev-parse HEAD`, then run `pnpm install --frozen-lockfile` and `pnpm build` from the repository root.
2. Run `node scripts/check-packed-consumer.mjs --project docs/examples/host-chatgpt-sites --output /absolute/path/to/new-sites-reproduction -- pnpm build`. The output path must not exist and must be outside the SDK checkout. This existing helper copies the committed example, packs the SDK, installs exact tarball overrides for all Mantle packages, and reports the source SHA and package hashes. Keep the resulting `artifacts/` beside `consumer/` so the lockfile's tarball paths remain valid.
3. Work in `/absolute/path/to/new-sites-reproduction/consumer`. Run `pnpm exec mantle validate --phase deploy`, `pnpm check`, then `pnpm exec wrangler d1 migrations apply DB --local`. Keep `.openai/hosting.json` but do not copy an existing Site's `project_id`.
4. Start `pnpm dev --port 4174` in another terminal, then run `pnpm test`. To use another port, also override the Worker's `PUBLIC_ORIGIN` and set `MANTLE_TEST_ORIGIN` for the test to that same localhost origin. Local test headers simulate Sites' trusted dispatcher; they do **not** prove deployed ChatGPT login.
5. Review the entire [smoke script](./scripts/check.mjs) before adapting it. It covers D1 CRUD/version conflict, owner/member/role revocation, R2 read/write/delete, media create → PUT → commit → public read, advertised MCP URLs (only `/api/mcp`, staff disabled), public MCP `initialize`/`tools/list`/View call, draft isolation, published article HTML/Markdown/SEO, and negative auth/Origin/size checks. It creates and deletes only its own test records and objects.

The checked-in `drizzle/` migrations and `src/storage-fingerprint.json` match the example manifest. `scripts/migration.mjs` shows the one-time generation mechanism; do **not** run it against a deployed database or overwrite an applied migration. For a new business manifest, generate/review an initial migration before the first deployment; for a later change, generate an additive migration from the previous schema state.

## Publish with Sites

1. Create a new Site through Sites and request **both D1 and R2**. Confirm its saved hosting manifest has `d1: "DB"` and `r2: "MEDIA_BUCKET"`; the local example intentionally omits `project_id` until Sites provisions one. A missing R2 binding cannot be repaired by adding an R2 type to TypeScript. Sites controls provisioning and publishing, not `wrangler deploy`.
2. In Sites settings, set `PUBLIC_ORIGIN` to the exact production origin and `OWNER_EMAIL` to the intended first owner. Do not commit hosted secrets or identity headers. Keep the Site audience narrow until verification. A Site Viewer is not automatically a Mantle staff member.
3. Review the D1 migration, save a Sites version, then deploy that version. Every deployment URL is production. Confirm the deployed artifact includes `dist/server/index.js`, `dist/client/`, `dist/.openai/hosting.json` and `dist/.openai/drizzle/`; `npm run build` prepares those artifacts.
4. On the deployed Site, check `/health`, `/admin/sign-in`, one `/_mantle/admin/assets/*` file, owner login and staff revocation, Admin media upload and committed public image URL, then publish an article with that asset as its cover. Anonymous draft and uncommitted image URLs must return 404. Check public HTML, Markdown, canonical/JSON-LD, sitemap and `llms.txt`; POST `/api/mcp` should discover only the public View tool and execute its read-only call. The public lab deployment passed all three MCP protocol calls; the root `/mcp` path was intercepted by Sites and is not used by this reference.

The media path uses only the R2 binding: `ports.mediaStorage` + `media.purposes` + authenticated same-origin PUT + committed-only public GET. It does not need an R2 S3 endpoint or API keys. The upload route is browser-session authenticated, so it is **not** an MCP agent upload route. Do not expose the Worker outside Sites' identity-stripping ingress: `src/chatgpt-auth.ts` trusts the `oai-*` headers only under that condition.

## Stop conditions

- `/admin/media` says storage is disabled: check **all three** of `r2` binding, `ports.mediaStorage`, and `media.purposes`; a successful R2 probe alone is insufficient.
- Admin HTML loads but JS assets 404: check `dist/client/_mantle/admin/assets/` and `ASSETS` routing.
- `/mcp/staff` returns 404: this example has no remote staff MCP handler. Admin WebMCP is a different surface. Do not register this URL as an authenticated ChatGPT connector until its OAuth discovery, 401 challenge, bearer verification and staff role checks are implemented and tested.
- OAuth discovery returns sign-in HTML: Sites' page session is not an OAuth bearer challenge. Do not bypass Sites auth or trust browser cookies as remote MCP credentials.

See the [Sites host reference](../../handbook/sites/host-reference.md) and [OpenAI Sites documentation](https://learn.chatgpt.com/docs/sites).
