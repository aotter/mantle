# Mantle on ChatGPT Sites: runnable reference

This is a **reference consumer application**, not a Mantle starter or a production-ready OAuth server. It reproduces the tested composition: Sites D1 + R2 bindings, Sign in with ChatGPT identity, Mantle Admin and staff roles, same-origin media upload, a published-only article frontend, and anonymous read-only `/api/mcp` for public Views. It uses `@aotter/mantle*` `0.1.2-alpha.6`; pin every Mantle package to the same exact release when updating it. Remote `/mcp/staff` is deliberately **not** claimed or mounted; see [the MCP gate](../../handbook/cloudflare/chatgpt-sites.md#remote-mcp-is-a-separate-gate).

## Before writing code

Read the user's business request and author the manifest for **their** records and lifecycle. The included `articles` example deliberately allows a title-only draft; `body` uses `x-mcp-hint: markdown`, while `coverAssetId` uses both `x-mantle-ref: media_assets` (Admin picker) and `x-mcp-hint: media-image` (agent guidance). The `published-articles` View is a list projection, not the detail page contract. If the user's content must always have a body, add it to `required`; if the public API must return body or cover ID, add those to the View's `fields`. Review staff roles, public filters and indexes before deployment. `mantle validate` checks grammar, **not** whether this model matches the business request. Manifest changes after deployment require a new reviewed D1 migration and matching storage fingerprint; never edit an applied migration.

## Local reproduction

1. Copy this directory into a new application directory outside the Mantle SDK checkout. Keep `.openai/hosting.json` but do not copy an existing Site's `project_id`.
2. Run `npm ci`, `npm run build`, then `npx mantle validate --phase deploy` and `npm run check`.
3. Apply `npx wrangler d1 migrations apply DB --local`. Start `npm run dev -- --port 4174` in another terminal, then run `npm test`. Local test headers simulate Sites' trusted dispatcher; they do **not** prove deployed ChatGPT login.
4. Review the entire [smoke script](./scripts/check.mjs) before adapting it. It covers D1 CRUD/version conflict, owner/member/role revocation, R2 read/write/delete, media create → PUT → commit → public read, public MCP `initialize`/`tools/list`/View call, draft isolation, published article HTML/Markdown/SEO, and negative auth/Origin/size checks. It creates and deletes only its own test records and objects.

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

See the [Sites host checklist](../../handbook/cloudflare/chatgpt-sites.md) and [OpenAI Sites documentation](https://learn.chatgpt.com/docs/sites).
