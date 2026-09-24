# Mantle on ChatGPT Sites: runnable reference

The runnable application for [Mantle on ChatGPT Sites](../../handbook/chatgpt-sites/index.md) connects Sites D1 + R2 bindings, Sign in with ChatGPT identity, Mantle Admin and staff roles, same-origin media upload, a published-only article frontend, anonymous read-only `/api/mcp`, and Sites-session staff tools at `/api/mcp/staff`. Remote OAuth MCP remains a separate integration; see [MCP support](../../handbook/chatgpt-sites/host-reference.md#remote-mcp-is-a-separate-gate).

After setup, follow [Publish your first article](../../handbook/chatgpt-sites/index.md#publish-your-first-article) to verify the editorial workflow in Admin, then [maintain content with an agent](../../handbook/chatgpt-sites/index.md#maintain-content-with-an-agent). Article pages advertise their Markdown mirror through an HTML `rel="alternate"` link; the example does not add a visible Markdown button to the reader UI.

## Before writing code

Read the user's business request and author the manifest for **their** records and lifecycle. The included `articles` example deliberately allows a title-only draft; `body` uses `x-mcp-hint: markdown`, while `coverAssetId` uses both `x-mantle-ref: media_assets` (Admin picker) and `x-mcp-hint: media-image` (agent guidance). The `published-articles` View is a list projection, not the detail page contract. If the user's content must always have a body, add it to `required`; if the public API must return body or cover ID, add those to the View's `fields`. Review staff roles, public filters and indexes before deployment. `mantle validate` checks grammar, **not** whether this model matches the business request. Manifest changes after deployment require a new reviewed D1 migration and matching storage fingerprint; never edit an applied migration.

## Install and run

Requires Mantle 0.1.2 or newer. Copy this directory from the selected installed SDK version into a new application directory. Replace every `@aotter/mantle*` `latest` dependency in `package.json` with that same exact version, then:

```bash
npm install                                  # or: bun install
npx mantle validate --phase deploy           # or: bunx mantle ...
npm run generate && npm run check
npx wrangler d1 migrations apply DB --local
npm run dev -- --port 4174                   # leave running
npm test                                     # smoke, in a second terminal
```

This example does not commit a lockfile. Commit the lockfile created by your
first install and use `npm ci` for subsequent installs. `bun install` also
works when you use Bun's lockfile consistently.

## Add a manifest HTTP Trigger

Mounting Admin does not register a manifest HTTP Trigger on the Site's Hono
router. For an anonymous JSON form whose Trigger declares `POST /api/rsvp`, add
the corresponding route inside `assemble` in `src/index.ts`:

```ts
import { createMantleRequestHandler } from '@aotter/mantle/runtime';

const handleHttp = createMantleRequestHandler({ plan, getRuntime: get });
app.post('/api/rsvp', async c =>
  (await handleHttp(c.req.raw, { user: null, staff: null, env: c.env }))
    ?? new Response('Not found', { status: 404 }));
```

Return the handler's `Response` directly: it validates the JSON body and maps
Mantle diagnostics to HTTP status codes. If the Trigger requires a signed-in
user or staff role, derive that context from the verified Sites session instead
of copying the anonymous context above. See [Procedures and Triggers](../../handbook/concepts/procedures-and-triggers.md#the-http-envelope).

Keep `.openai/hosting.json`; do not copy an existing Site's `project_id`. To use another port, also set the Worker's `PUBLIC_ORIGIN` and the test's `MANTLE_TEST_ORIGIN` to that same localhost origin. Local test headers simulate Sites' trusted dispatcher; they do **not** prove deployed ChatGPT login.

Review the entire [smoke script](./scripts/check.mjs) before adapting it. It covers D1 CRUD/version conflict, owner/member/role revocation, R2 read/write/delete, media create → PUT → commit → public read, both advertised MCP URLs, public MCP `initialize`/`tools/list`/View call, staff MCP authentication/catalog, draft isolation, published article HTML/Markdown/SEO, and negative auth/Origin/size checks. It creates and deletes only its own test records and objects.

The checked-in `drizzle/` migrations and `src/storage-fingerprint.json` match the example manifest and runtime. Apply all pending D1 migrations before deploying updated code; managed storage does not apply runtime infrastructure migrations at boot, and a missing column can make every route return 500. `scripts/migration.mjs` shows the one-time generation mechanism; do **not** run it against a deployed database or overwrite an applied migration. For a new business manifest, generate/review an initial migration before the first deployment; for a later change, generate an additive migration from the previous schema state.

## Publish with Sites

1. Create a new Site through Sites and request **both D1 and R2**. Confirm its saved hosting manifest has `d1: "DB"` and `r2: "MEDIA_BUCKET"`; the local example intentionally omits `project_id` until Sites provisions one. A missing R2 binding cannot be repaired by adding an R2 type to TypeScript. Sites controls provisioning and publishing, not `wrangler deploy`.
2. In Sites settings, set `PUBLIC_ORIGIN` to the exact production origin and `OWNER_EMAIL` to the intended first owner. Do not commit hosted secrets or identity headers. Keep the Site audience narrow until verification. A Site Viewer is not automatically a Mantle staff member.
3. Review the D1 migration, save a Sites version, then deploy that version. Every deployment URL is production. Confirm the deployed artifact includes `dist/server/index.js`, `dist/client/`, `dist/.openai/hosting.json` and `dist/.openai/drizzle/`; `npm run build` replaces `dist` before preparing those artifacts, so removed migrations cannot remain in a later build.
4. On the deployed Site, check `/health`, `/admin/sign-in`, one `/_mantle/admin/assets/*` file, owner login and staff revocation, Admin media upload and committed public image URL, then publish an article with that asset as its cover. Anonymous draft and uncommitted image URLs must return 404. Check public HTML, Markdown, canonical/JSON-LD, sitemap and `llms.txt`; POST `/api/mcp` should discover only the public View tool, while `/api/mcp/staff` must reject anonymous/member requests and expose staff tools to a current staff session. The root `/mcp` path was intercepted in the lab and is not used by this reference.

The media path uses only the R2 binding: `ports.mediaStorage` + `media.purposes` + authenticated same-origin PUT + committed-only public GET. It does not need an R2 S3 endpoint or API keys. The upload route is browser-session authenticated, so it is **not** an MCP agent upload route. Do not expose the Worker outside Sites' identity-stripping ingress: `src/chatgpt-auth.ts` trusts the `oai-*` headers only under that condition.

## Stop conditions

- `/admin/media` says storage is disabled: check **all three** of `r2` binding, `ports.mediaStorage`, and `media.purposes`; a successful R2 probe alone is insufficient.
- Admin HTML loads but JS assets 404: check `dist/client/_mantle/admin/assets/` and `ASSETS` routing.
- `/api/mcp/staff` uses the Sites-injected browser identity and re-reads the Mantle staff role. It is mounted and advertised in Admin, but it is not an OAuth resource server. Do not register it as a remote ChatGPT connector until OAuth discovery, a standards-compliant bearer challenge and token verification are implemented and tested.
- OAuth discovery returns sign-in HTML: Sites' page session is not an OAuth bearer challenge. Do not bypass Sites auth or trust browser cookies as remote MCP credentials.

See the [Sites host reference](../../handbook/chatgpt-sites/host-reference.md) and [OpenAI Sites documentation](https://learn.chatgpt.com/docs/sites).
