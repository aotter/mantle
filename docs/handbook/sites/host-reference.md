---
description: "Mantle on ChatGPT Sites: identity, D1, R2 media, public web, MCP boundaries, and deployment checks."
---
# ChatGPT Sites host reference

Start with [Mantle on ChatGPT Sites](./index.md) for the supported installation
path and your first publishing workflow. This reference explains how the
integration connects Sites hosting and sign-in to Mantle content, staff roles,
Admin, media, and public web. Keep the application outside the Mantle SDK
checkout and use matching SDK packages.

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

The reference exposes these separate surfaces:

| Surface | Authentication | Reference support |
|---|---|---|
| Admin WebMCP | Current browser Admin session and fresh Mantle staff role | Available within Admin. |
| Public MCP (reference path: `/api/mcp`) | Anonymous, read-only public Views | Manual HTTPS `initialize`, `tools/list`, and a published View call verified on the deployed integration. |
| Sites-session staff MCP (reference path: `/api/mcp/staff`) | Sites-injected identity plus a fresh Mantle staff role | Mounted and reported to Admin; not usable as a remote OAuth connector. |
| Remote staff OAuth MCP | OAuth bearer authorization and fresh Mantle staff role | Requires a separate integration. |
| Sites-managed connector registration | Sites MCP declaration and connection configuration | Unverified; do not guess a hosting manifest key. |

Try the conventional `/mcp` path first. If ChatGPT Sites does not route that
path to the application, mount the MCP handler at another application-owned
path and report the actual path through `mcpEndpoints`. For example:

```ts
app.all("/agent/read", publicMcpHandler);

mountMantleAdmin(app, {
  plan,
  auth,
  assets,
  get,
  mcpEndpoints: { public: "/agent/read", staff: "/agent/staff" },
});
```

The reference encountered that condition and chose `/api/mcp` plus
`/api/mcp/staff`. It mounts both handlers and passes both paths through
`mcpEndpoints`, so Admin displays the routes that actually exist. These are
example fallback paths, not Mantle Core routes. Verify each chosen route with
`initialize`, `tools/list`, and a tool call after every Sites deployment.

The reference smoke test also checks that `/mcp` and `/mcp/staff` return 404.
The earlier deployment's root `/mcp` response is not evidence of a globally
reserved Sites path; another Sites deployment may route it differently.

Identity follows the same host-owned design. `@aotter/mantle-admin` exports
`AdminAuth`; the reference implements it using trusted Sites identity headers
and a D1 staff table. A host may implement the interface with another identity
system or wrap Mantle's Better Auth adapter. Core does not contain a ChatGPT
login implementation or require Better Auth for Sites.

A successful public MCP call verifies that endpoint, not ChatGPT connector
registration. A manually configured connector targets the HTTPS endpoint;
Sites-provisioned connection details (`get_site` with `include_mcp_connection`)
additionally require a deployed MCP declaration.

The reference's staff endpoint trusts only identity injected by the Sites
ingress, rejects ordinary members, and re-reads the Mantle role on every
request. Before exposing staff MCP to remote clients, implement a standard
OAuth authorization server or established provider, bearer verification, and
a fresh Mantle staff role check on each tool request. Verify OAuth protected-resource and
authorization metadata as JSON, a standards-compliant unauthenticated `401`
challenge, and authenticated `tools/list` plus a read-only call. A Sites browser
session or forwarded identity header is not an OAuth bearer token; a sign-in
HTML page returned to an OAuth JSON request is a failed integration.

## Capability boundaries

Native Cloudflare deployments can configure R2 public domains, S3 credentials, Queues, Durable Objects, KV and Cron independently. A Sites deployment should claim only the bindings its hosting manifest and deployed tests actually expose. `waitUntil` is not a durable queue. Keep missing primitives as explicit host limitations rather than adding fake Mantle ports.

See [native R2 direct upload](../cloudflare/media-r2.md), [authentication](../cloudflare/authentication.md), and [public web](../cloudflare/public-web.md).

For custom business rules and external API calls, see the
[equipment checkout guide](./equipment-checkout.md). It keeps transactional
application state separate from notification delivery and documents the
deployment experiment's limits. Sites' [unsupported uses](https://learn.chatgpt.com/docs/sites#understand-limits-and-unsupported-uses)
include financial transactions; a successful sandbox experiment is not support
for live payments.

## Source

- `MediaStorage` port and the media upload use case in `@aotter/mantle-runtime`
- [Cloudflare R2 Workers binding API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [Cloudflare R2 presigned URLs](https://developers.cloudflare.com/r2/api/s3/presigned-urls/)
- [OpenAI Sites](https://learn.chatgpt.com/docs/sites)
- [OpenAI MCP server authentication](https://developers.openai.com/plugins/build/auth)
