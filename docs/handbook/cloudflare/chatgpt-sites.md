---
description: Experimental Mantle composition on ChatGPT Sites: identity, D1, R2 media, public web, MCP gates, and deployment checks.
---
# ChatGPT Sites host checklist (experimental)

This is a tested composition pattern, not a claim that every Cloudflare Worker binding or remote MCP feature is available on Sites. Sites owns deployment, audience and ChatGPT sign-in; Mantle owns its runtime plan, D1 content, staff roles, Admin and optional public web. Keep the application outside the Mantle SDK checkout and pin all `@aotter/mantle*` packages to one exact version.

Start from the [runnable Sites host reference](../../examples/host-chatgpt-sites/README.md), then replace its **example** manifest with the user's business contract. It contains the matching D1 migrations/fingerprint, R2 upload adapter, local smoke test and build layout. Its browser-backed staff identity is not an OAuth resource-server credential.

## First deployment

1. Inspect the Site's actual hosting manifest and available bindings. Bind D1 before booting Mantle; create and apply the generated immutable D1 migration before publishing. Do not run DDL per request.
2. Compile the sealed plan (`mantle generate --check`, `mantle validate --phase deploy`) and bind `SqliteMantleStorageAdapter(new D1DatabaseDriver(env.DB), siteDefaults)`. Keep the generated storage fingerprint in sync with the migration.
3. If Admin is requested, mount `@aotter/mantle-admin` and its prebuilt assets. Use the trusted identity supplied by Sites **only after its ingress has stripped caller-supplied identity headers**. Map the stable per-Site user ID to a Mantle principal; use email only for owner bootstrap/invitation matching, not as a durable ID. Persist staff roles in D1 and re-read them for each privileged request. A Site Viewer is not automatically a Mantle editor.
4. If public pages are requested, compose `@aotter/mantle-web` over published-only queries. Verify anonymous article HTML, canonical/JSON-LD, Markdown, sitemap and `llms.txt`; a draft must remain 404. Do not assume a successful Admin boot implies a working homepage.
5. Publish through Sites, then verify the deployed version rather than only a local preview. Test owner, second account, role revocation, public/anonymous reads and every configured binding.

## Media with only an R2 binding

The `MediaStorage` port returns an HTTP `PUT` capability; it does **not** require a presigned S3 URL. An application with `env.MEDIA_BUCKET` can implement the port with `R2Bucket.put/head/get/delete` and return a same-origin upload URL. Bind that implementation as `ports.mediaStorage` **and** declare at least one `siteDefaults.media.purposes` policy; otherwise the Admin library and `create_media_upload` remain disabled.

The application must mount two routes alongside the port:

- `PUT /admin/media-upload/:group/:file`: check an authenticated editor-or-higher session, exact `Origin`, unexpired D1 pending-upload record, server-generated storage key, declared MIME and exact byte size before `R2Bucket.put`. Bound the request body by the policy limit. In Workers, a fixed-length `Uint8Array` is the conservative input to `put` when a streamed request body has unknown length. The port's `createUpload` must return this route as `uploadUrl` and the exact required `Content-Type` header.
- `GET /media/:purpose/:group/:file`: look up the committed `media_assets` row before `R2Bucket.get`, and serve only a listed variant with a safe MIME, `nosniff` and an intentional public cache policy. This is a **public** URL; it does not make private media safe.

The existing create → `PUT` each `uploadUrl` → commit flow works unchanged in Admin UI. Verify that an anonymous/cross-origin/expired/oversize `PUT` fails, that pre-commit public reads are 404, and that committed media resolves anonymously. A successful R2 binding read/write probe alone does not enable the library.

The browser route above uses the Sites session and therefore does **not** automatically work for a remote MCP client. For remote agent upload, either give the client a separately authenticated Worker `PUT` capability (with its own expiry and pending-record check) or choose the native `R2MediaStorage` direct-to-R2 path. Do not put image bytes in MCP JSON tool arguments. R2 bindings expose object operations, not S3 SigV4 presigning: direct-to-R2 presigned URLs require an R2 S3 endpoint and API key pair. Do not configure those credentials merely to make Admin UI upload work.

## Remote MCP is a separate gate

Admin's in-browser WebMCP tools are not a remote `/mcp/staff` server. The runnable reference mounts an anonymous, **read-only** `/api/mcp` backed only by public Views. On the public experimental Site, unauthenticated HTTPS requests to `POST /api/mcp` passed `initialize`, `tools/list`, and a published View `tools/call`. Sites intercepted `POST /mcp` with its own 404 before the Worker route, so the reference uses the non-reserved path. This proves the manual HTTPS MCP transport works for public tools; it does **not** establish ChatGPT connector registration or staff OAuth. The reference does not mount staff MCP or issue OAuth tokens. There are two distinct connection paths: Sites-provisioned connection details (`get_site` with `include_mcp_connection`) require a deployed MCP declaration, while a manually configured remote connector targets the HTTPS endpoint directly. Do not treat failure of the former as proof that the latter is impossible.

The first failed staff connection in the experimental Site had a concrete application cause: `/mcp/staff` was never mounted, so it returned 404; `/.well-known/oauth-protected-resource` was handled by the Admin auth fallback and also returned 404. The earlier private-Site challenge returned Sign in with ChatGPT HTML instead of OAuth JSON. Neither observation is a transport limitation, as `/api/mcp` now proves. A browser SIWC session and forwarded `oai-*` identity headers cannot be treated as an OAuth bearer token. A staff connector needs a standard authorization server (or established provider), PKCE/CIMD or DCR, token validation, and a fresh Mantle role check on each tool call. Do not expose the staff dispatcher solely because the public MCP probe works.

For either path, first verify that the HTTP handler exists, OAuth protected-resource and authorization metadata return JSON at the expected URLs, an unauthenticated request gets a standards-compliant `401` challenge, and an authenticated client can run `tools/list` plus a read-only call. The Sites browser session is not an MCP bearer token; re-check the Mantle staff role on each authenticated tool request. A Site sign-in HTML page returned to an OAuth JSON request is a failed integration, not a valid challenge. Do not infer remote MCP support from an installed connector name or from working Admin WebMCP. Sites-managed MCP declaration syntax and ingress behavior remain unverified; do not guess a hosting manifest key.

## Capability boundaries

Native Cloudflare deployments can configure R2 public domains, S3 credentials, Queues, Durable Objects, KV and Cron independently. A Sites deployment should claim only the bindings its hosting manifest and deployed tests actually expose. `waitUntil` is not a durable queue. Keep missing primitives as explicit host limitations rather than adding fake Mantle ports.

See [native R2 direct upload](./media-r2.md), [authentication](./authentication.md), and [public web](./public-web.md).

## Source

- [`MediaStorage` port](../../../packages/mantle-runtime/src/domain/port/MediaStorage.ts)
- [Media upload use case](../../../packages/mantle-runtime/src/usecase/media/CreateMediaUploadUseCase.ts)
- [Cloudflare R2 Workers binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [OpenAI Sites](https://learn.chatgpt.com/docs/sites)
- [OpenAI MCP server authentication](https://developers.openai.com/plugins/build/auth)
