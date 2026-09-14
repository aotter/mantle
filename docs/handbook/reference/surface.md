---
description: Every surface Mantle exposes — Worker HTTP routes and their cache class, the MCP tool catalog, CLI flags, the generated module, packages and versions.
---
# HTTP, MCP, CLI and package surface

What a Mantle deployment exposes, in one place: the routes the conventional Cloudflare Worker owns, the MCP tools it advertises, the commands the package installs, the module `mantle generate` writes, and which package holds what. Route behaviour follows [Conventional Worker](../cloudflare/conventional-worker.md); this page is the index.

## HTTP routes

Every table below describes the conventional Cloudflare Worker assembled by `createMantleWorker`. The **cache** column is the class the final `applyCachePolicy` boundary assigns. Only an anonymous `200` `GET`/`HEAD` response that explicitly declares `public` plus a shared freshness lifetime stays cacheable, and it then varies on `Cookie` and `Authorization`; the request must carry neither header and the response must set no cookie. Everything else becomes `private, no-store` with any CDN cache override stripped.

### Manifest routes

| Route | Response | Cache |
|---|---|---|
| `GET /api/views` | `{ ok: true, data: [ { name, title?, description, inputSchema } ] }` — one descriptor per public View. | `private, no-store` |
| `GET /api/views/<name>?page=&show=` | `{ ok: true, data: { rows, page, show, hasMore } }`. One route per View declaring `surface: public`. Query values are coerced against `params`; a bad value is `400`. | `private, no-store` |
| `<METHOD> <path>` | Every manifest HTTP Trigger, at its declared `POST`, `PUT`, `PATCH` or `DELETE` and path under `/api/`. The JSON body must be an object. Success is `{ ok: true, data: … }`. | `private, no-store` |

Staff Views are not mounted here; they live under `/admin/api/views/<name>`.

### Admin

All `/admin/api/*` routes require a staff session, carry a 1 MiB JSON body limit, and are `private, no-store`.

| Route | Response |
|---|---|
| `GET /admin`, `/admin/`, `/admin/sign-in`, `/admin/c/:collection`, `/admin/c/:collection/:id`, `/admin/media`, `/admin/preferences`, `/admin/connected-apps`, `/admin/settings`, `/admin/staff`, `/admin/members`, `/admin/ops`, `/admin/dev`, `/admin/dev/model`, `/admin/dev/logic`, `/admin/dev/docs`, `/admin/views/:name` | The Admin SPA shell, read from `/_mantle/admin/index.html` through the assets binding. `503` with an explanatory body when the bundle is missing. |
| `GET /admin/api/views/<name>` | Staff execution of any declared View, public or staff, with Admin search and filtering applied before pagination. |
| `GET /admin/api/views/<name>/export` | The same query as CSV, covering every matching row rather than one page. |
| `GET /admin/api/views-manifest` | `{ views: … }` — the View manifest projection the SPA renders from. |
| `GET /admin/api/operations` | `{ operations: [ { name, title, description, input, uiSchema, triggers, rowBindings } ] }`, filtered per caller by re-evaluating each Procedure's `requires.auth.all`. |
| `POST /admin/api/operations/:name` | Invokes a staff-operable Procedure through the same use case the staff MCP surface uses. `404` when the name is not staff-operable. |
| `GET /admin/api/me`, `/collections`, `/collections/:name/statistics`, `/entries`, `/entries/export`, `/entries/:id`, `/site` | Session, catalog and entry reads. |
| `POST /admin/api/entries`, `PATCH /admin/api/entries/:id` | Create and edit. Contributors are limited to drafts on publishing Schemas. |
| `POST /admin/api/entries/:id/publish`, `/unpublish`, `DELETE /admin/api/entries/:id` | Lifecycle. Editor or above. |
| `POST /admin/api/media/uploads`, `POST /admin/api/media/uploads/:uploadGroupId/commit`, `GET /admin/api/media`, `GET`, `PATCH` and `DELETE /admin/api/media/:id` | Media lifecycle. Editor or above. |
| `GET /admin/api/staff`, `PATCH /admin/api/staff/:id/role`, `POST /admin/api/staff/invitations`, `DELETE /admin/api/staff/invitations/:id`, `GET /admin/api/developer-console`, `GET` and `PATCH /admin/api/site-settings` | Owner only. |
| `GET /admin/api/members` | Editor or above. |

`/_mantle/*` holds the static Admin bundle. It is served by the Worker's static-assets layer from `public/_mantle/admin/`, which `mantle generate` syncs when `@aotter/mantle-admin-ui` is installed. The Worker registers no route there; the prefix is reserved so extensions cannot claim it.

### Auth, OAuth and MCP

| Route | Response | Cache |
|---|---|---|
| `GET /api/auth/methods` | `{ methods }` — the registered sign-in method kinds, no secrets. Explicitly `no-store` so a method change cannot be served stale. | `private, no-store` |
| `ALL /api/auth/*` | Better Auth: sign-in, callback, session, magic link, OTP. `/api/auth` is the default base path. | `private, no-store` |
| `ALL /api/auth/oauth2/*` | The site's OAuth provider endpoints, including consent. | `private, no-store` |
| `ALL /.well-known/oauth-authorization-server/*`, `/.well-known/oauth-protected-resource`, `/.well-known/oauth-protected-resource/*` | RFC 8414 and RFC 9728 discovery metadata, registered explicitly so no catch-all can swallow them. `/.well-known/oauth-protected-resource/mcp` is the resource metadata the MCP `WWW-Authenticate` challenge points at. | `private, no-store` |
| `ALL /oauth/*` | Consent and connected-apps pages: `/oauth/consent`, `/oauth/consent/data`, `/oauth/consents`, `/oauth/consents/data`, `/oauth/consents/revoke`. | `private, no-store` |
| `ALL /mcp` | Public MCP surface. JSON-RPC. | `private, no-store` |
| `ALL /mcp/staff` | Staff MCP surface. Rejects a verified caller with no staff row using `403` and `insufficient_scope`. | `private, no-store` |

Both MCP surfaces verify an OAuth access token against one canonical resource, `${PUBLIC_ORIGIN}/mcp`, and one scope, `mcp`. A missing or invalid token is `401` with a `Bearer` challenge naming the resource metadata URL; DPoP failures answer with a `DPoP` challenge. Misconfigured or partial auth environment variables keep public routes serving and return `503 setup_incomplete` from every Auth-owned route above — see [Authentication](../cloudflare/authentication.md).

### Public pages

These are opt-in and application-declared. Public rendering needs three matching inputs: a `mountPublicRoutes(...)` call declaring the collection routes, a `TemplateRegistry` passed as `templates`, and a `publicPathResolver`. A headless deployment declares none of them and serves none of these routes; mounting every Schema automatically is deliberately not offered, because a collection can hold a slug and still be private. Bodies render from canonical database state.

| Route | Response | Cache |
|---|---|---|
| `GET /` | `302` to `/{canonical locale}`. | `private, no-store` |
| `GET /:locale` | Composed home page. | `public, max-age=0, s-maxage=300` + `Cache-Tag: mantle-public` |
| `GET /:locale.md` | Markdown mirror of the home page. | public |
| `GET /:locale/:segment` | Collection list page. Opt-in per collection route. Paginates by `?cursor=` and adds `Link: <…>; rel="next"` plus an in-page next link. | public |
| `GET /:locale/:segment.md` | Markdown mirror of the list. | public |
| `GET /:locale/:segment/:slug` | Entry page. | public |
| `GET /:locale/:segment/:slug.md` | Markdown mirror of one entry. Registered before the bare slug route, and the slug group stays single-segment. | public |
| `GET /:locale/:segment/:slug?preview=1` | Live render of unpublished content. Gated on a staff session: `401` with no session, `403` for a non-staff user. | `private, no-store` |
| `GET /llms.txt` | Composed agent index across every locale, with `?cursor=` continuation and `Link: rel="next"`. | public |
| `GET /:locale/llms.txt` | The same, scoped to one locale. | public |
| `GET /sitemap.xml` | Sitemap. `?part=1` returns a single part; otherwise a sitemap index is returned whenever a continuation exists, and `?cursor=` fetches the next part. Part size is `min(2000, floor(40000 / locale count))`, at least 1. | public |
| `GET /robots.txt` | `User-agent: *`, `Allow: /`, and a `Sitemap:` pointer built from `siteDefaults.origin`. | public |
| `GET /favicon.ico` | A convention, not a reserved path: an existing host route wins. Picks the first themeless PNG icon, else the first themeless icon, else the first icon; serves it from the assets binding when it resolves to `/favicon.ico` on this origin, and otherwise redirects to the icon `src`. | `private, no-store` |

The first three rows register only when a home renderer is supplied; without one, `/` and `/{locale}` are not mounted at all. Unmatched paths fall through to the supplied not-found renderer. Setting `liveDev` switches entry and list HTML to `private, no-store`. Publishing-content and site-setting writes purge the `mantle-public` tag; immutable assets and operational records stay outside that boundary. More in [Public web](../cloudflare/public-web.md).

### Reserved paths

Extensions may add routes but may not replace Core surfaces. These are reserved:

- `/admin` and `/admin/*`
- `/_mantle` and `/_mantle/*`
- `/api/auth` and `/api/auth/*`
- `/api/views` and `/api/views/*`
- `/oauth` and `/oauth/*`
- `/mcp` and `/mcp/*`
- `/.well-known/oauth*`
- the global `*` and `/*` registrations

A custom Auth factory's `basePath` and every manifest-owned `(method, path)` pair are reserved as well. Static literal conflicts fail the consumer's TypeScript build; computed paths cannot be proven statically, so the facade inspects the assembled route table and fails closed before serving. A manifest HTTP Trigger under one of these prefixes is `TRIGGER_PATH_INVALID` at boot.

## MCP tools

Tool names are the mangled `metadata.name`: lower-cased, with `-` replaced by `_`. Discovery is filtered per caller, but discovery is never the enforcement boundary — every `tools/call` re-evaluates the target's `requires.auth.all` and its guard.

| Tool | Surface | Registered when |
|---|---|---|
| `query_view_<segment>` | The View's own `surface` | One per declared View. `annotations.readOnlyHint` is `true`; the input schema is the View's `params.properties` plus `page` and `show`. |
| `<procedure segment>` | The Trigger's `surface` | One per `Trigger.source.kind: mcp`. A Procedure with no MCP Trigger is not exposed. |
| `list_entries` | staff | Always. Search, sort and cursor-paged entry listing. |
| `get_entry` | staff | Always. |
| `request_publish` | staff | Always. Rejected at call time for an operational Schema. |
| `unpublish_entry` | staff | Always. Same restriction. |
| `archive_entry` | staff | Always. Same restriction. |
| `delete_entry` | staff | Always. |
| `create_draft_<segment>`, `update_draft_<segment>` | staff | Per publishing Schema whose `schema.readOnly` is not `true`. |
| `create_record_<segment>`, `update_record_<segment>` | staff | Per operational Schema whose `schema.readOnly` is not `true`. |
| `create_media_upload`, `commit_media_upload` | staff | Only when a `mediaStorage` port is bound **and** at least one `media.purposes` entry is declared. |

The public surface carries callable capabilities only — public Views and Procedures with a public MCP Trigger. No generic entry tool and no authoring tool is ever advertised there. Update tools add `id` and `expected_version` as required fields, and `x-mantle-bind` properties are stripped from authoring tool schemas because the server stamps them. Localized `title` and `description` collapse to their `en` value in tool schemas. Concepts are in [MCP and agents](../concepts/mcp-and-agents.md).

## CLI

The `@aotter/mantle` package installs two binaries, `mantle` and `mantle-harness`. Exit codes are `0` for success, `1` for a diagnostic failure and `2` for an invocation problem.

| Command | Flags |
|---|---|
| `mantle generate` | `--manifests <dir>` (default `./manifests`), `-o, --output <dir>` (default `.mantle/generated`), `--namespace <name>` (default `Mantle`), `--check`, `-h, --help` |
| `mantle skills` | `--check`, `-h, --help` |
| `mantle validate` | `--manifests <dir>` (default `./manifests`), `--source <dir>` (default `./src`), `--no-source`, `--phase preview\|deploy` (default `preview`), `--format json\|text` (default by TTY), `--json`, `-h, --help` |
| `mantle emit-openapi` | `--manifests <dir>`, `--title <str>` (default `mantle`), `--version <str>` (default `0.1.0`), `--session-cookie-name <str>`, `-o, --output <file>`, `-h, --help` |
| `mantle-harness indexes` | `--manifests <dir>`, `--rows <n>`, `--require <view>` (repeatable), `--require-public`, `--format json\|text`, `-h, --help` |
| `mantle-harness http` | `--route <name=url>` (repeatable, required), `--base-url <url>`, `--rounds <n>`, `--warmup <n>`, `--format json\|text`, `-h, --help` |

`generate` validates and compiles the manifest directory, writes the typed module, and — when `@aotter/mantle-admin-ui` is installed — syncs the Admin SPA into `public/_mantle/admin/`, excluding `server.*` files. `--check` fails without writing when either output is stale. `skills` copies every skill the installed package marks `projection: project` into `.agents/skills/mantle-*` and `.claude/skills/mantle-*`; both layouts receive identical bytes. `validate --phase deploy` adds the pre-deploy-only gates on top of the grammar and cross-Schema checks. `emit-openapi` covers HTTP Triggers and View REST routes; MCP is out of scope. `mantle-harness indexes` executes compiled Views against crowded SQLite and inspects query plans; `http` samples a running Worker for p50 and p95. Day-to-day use is in [Project and CLI](../start/project-and-cli.md).

## The generated module

`mantle generate` writes one file, `.mantle/generated/mantle.ts`. It is generated code: do not edit it, and regenerate after any manifest change.

| Export | Shape |
|---|---|
| `plan` | The sealed `RuntimePlan`, carrying a semantic fingerprint. |
| `Mantle` (or `--namespace`) | Type namespace holding `Entry_*`, `ViewRow_*`, `ViewParams_*`, `ProcInput_*` and `ProcOutput_*` for every atom. |
| `MantleViewOptions` | `{ page?, show?, ctx? }`. |
| `MantleHandlers<Env>` | Typed map of every `handler.kind: ref` key the manifests declare. |
| `CreateMantleOptions<Env>` | `BootMantleRuntimeArgs` without `plan` and `handlers`, plus the typed `handlers` map. |
| `createMantle(options)` | Boots the runtime and returns the bound facade. Eager: it prepares once and neither caches nor retries. |
| `bindMantle(runtime)` | Binds an already-booted runtime. Throws when `runtime.revision` does not equal the generated plan's fingerprint. |

The bound object is deterministic lower-camel property names over the authored wire names:

```ts
import { createMantle } from "../.mantle/generated/mantle.js";

const mantle = await createMantle({ storage, handlers });

await mantle.views.publishedNotes({ page: 1, show: 20 });
await mantle.procedures.expireOrder({ orderId }, { user: null, staff: null, env });
await mantle.entries.orders.createDraft({ data, authorId: user.id });
mantle.triggers.expireOrderHttp;   // { name, source, target }
await mantle.runtime.archive.execute({ id, ctx });
```

`entries.<collection>` exposes `createDraft`, `get`, `list` and `delete`. `runtime` is the underlying Core runtime, so the typed projection never hides it. A host that owns its own lifecycle can skip generation entirely and call `runtime.executeView({ view: "published-notes" })` directly.

## Packages

The umbrella installs Spec and Runtime only. Web, Admin, Admin UI, Bun, Vercel and Cloudflare are optional peers; install one before importing its subpath. Every sub-package is also directly installable.

| Package | Umbrella subpath | Holds |
|---|---|---|
| `@aotter/mantle` | root | Umbrella plus the `mantle` and `mantle-harness` binaries. |
| `@aotter/mantle-spec` | `/spec` | Manifest grammar, parser, validators, JSON Schema to zod, site-config contract, diagnostic catalog. No environment, no IO. |
| `@aotter/mantle-runtime` | `/runtime` | Hexagonal runtime: domain ports, use cases, MCP catalog, storage helpers. No adapter dependencies. |
| — | `/runtime/testing` | Node-only crowded-SQLite planner and HTTP sampling helpers used by `mantle-harness`. |
| — | `/codegen` | The pure linked-manifests to typed-module emitter, with no IO. |
| `@aotter/mantle-web` | `/web` | HTML, Markdown, `llms.txt`, sitemap, SEO and preview composition. No routes, no platform dependencies. |
| `@aotter/mantle-admin` | `/admin` | Admin API, auth route mounting, OAuth pages, static-asset composition. |
| `@aotter/mantle-admin-ui` | `/admin-ui` | Pre-built React 19 Admin SPA bundle. |
| `@aotter/mantle-bun` | `/bun` | Bun adapter over a caller-owned `bun:sqlite` database. |
| `@aotter/mantle-vercel` | `/vercel` | Vercel Functions adapter with injected durable storage and platform `waitUntil`. |
| — | `/vercel/libsql` | Optional application-owned Turso/libSQL driver. |
| `@aotter/mantle-cloudflare` | `/cloudflare` | Cloudflare Workers adapter: D1, Workers Cache, R2, Queues, Better Auth 1.7 MCP and CIMD. |
| `@aotter/mantle-indexeddb` | — | Browser IndexedDB adapter. Directly installable; no umbrella subpath. |

## Versions

This handbook was added on the development branch after `v0.1.0-alpha.17`. It describes that development snapshot and will ship with a future release; it is not included in the published `0.1.0-alpha.17` package. For a registry installation, use the documentation at the matching release tag. For a source-built package, record the source commit as well as the package version: a development checkout can still carry the previous release version.

The documentation site pins its handbook commit in `docs/handbook.json` and records its vendored SDK source in `vendor/mantle/SOURCE.txt`. Those commits may differ when the intervening changes are behavior-neutral; the site verifies that condition during the build. The site's source-built tarballs are not the npm `alpha.17` artifacts.

`0.1.0-alpha.17` is immutable and no stable `0.1.0` is planned; the first stable target is `0.1.2`. That line removes the scaffolding path — the `mantle create` command, the bundle-oriented `mantle update` command, and the `@aotter/mantle/provision` subpath — with no aliases and no replacement scaffold command. `generate`, `skills`, `validate` and `emit-openapi` remain, and generation and runtime Web rendering keep their existing responsibilities. New projects are authored directly: write the manifests, run `generate`, wire the Worker. The reasoning is [ADR-0021](../../../docs/adr/0021-retire-starter-scaffolding.md).

Prerelease packages take their exact version from their own `package.json`, which is the authority; APIs may change between prereleases until `0.1.2`.

## Source

- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/mantle/src/cli/main.ts`](../../../packages/mantle/src/cli/main.ts)
- [`packages/mantle/src/cli/generate.ts`](../../../packages/mantle/src/cli/generate.ts)
- [`packages/mantle/src/cli/skills.ts`](../../../packages/mantle/src/cli/skills.ts)
- [`packages/mantle/src/cli/harness.ts`](../../../packages/mantle/src/cli/harness.ts)
- [`packages/mantle/src/codegen/emitMantleModule.ts`](../../../packages/mantle/src/codegen/emitMantleModule.ts)
- [`packages/mantle-spec/src/infrastructure/cli/ValidateCommand.ts`](../../../packages/mantle-spec/src/infrastructure/cli/ValidateCommand.ts)
- [`packages/mantle-spec/src/infrastructure/cli/EmitOpenapiCommand.ts`](../../../packages/mantle-spec/src/infrastructure/cli/EmitOpenapiCommand.ts)
- [`packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts`](../../../packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`packages/mantle-admin/src/mountMantleOAuth.ts`](../../../packages/mantle-admin/src/mountMantleOAuth.ts)
- [`packages/adapters/cloudflare/README.md`](../../../packages/adapters/cloudflare/README.md)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`packages/adapters/cloudflare/src/mount/mountRuntimeEndpoints.ts`](../../../packages/adapters/cloudflare/src/mount/mountRuntimeEndpoints.ts)
- [`packages/adapters/cloudflare/src/mount/mountPublicRoutes.ts`](../../../packages/adapters/cloudflare/src/mount/mountPublicRoutes.ts)
- [`packages/adapters/cloudflare/src/mount/mountMcp.ts`](../../../packages/adapters/cloudflare/src/mount/mountMcp.ts)
- [`packages/adapters/cloudflare/src/oauth/cachePolicy.ts`](../../../packages/adapters/cloudflare/src/oauth/cachePolicy.ts)
- [`docs/adr/0021-retire-starter-scaffolding.md`](../../../docs/adr/0021-retire-starter-scaffolding.md)
- [`docs/migration-0.1.2.md`](../../../docs/migration-0.1.2.md)
