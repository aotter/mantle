---
description: Every HTTP route the generated Mantle 0.2.0 service mounts (REST, auth, MCP, Admin), the package subpaths and their exports, and the CLI.
---
# HTTP, MCP, CLI and packages

## Routes of the generated service

`src/service.ts` mounts, in this order. Each surface runs behind
`withCaller(resolver, …)`.

| Path | Surface | Mounted when |
|---|---|---|
| `/api/auth/*`, `/.well-known/oauth-authorization-server/*`, `/.well-known/oauth-protected-resource[/*]`, `/oauth/consent[/data]`, `/oauth/consents[/data\|/revoke]` | `createAuthRoutes` | identity `mantle` |
| `/admin/*` | `createAdminSurface`: the console (from `ASSETS`) and `/admin/api/*` | feature `admin` |
| `/mcp` | `createMcpSurface`, `surface: public` | feature `mcp` |
| everything else | `createRestSurface` at `/api` | always |

### REST

| Route | |
|---|---|
| `GET /api/views/<name>` | a `public` View; query parameters are its `input` plus `limit` and `cursor`. Answers `{ rows, nextCursor? }` |
| `<METHOD> <path>` | each `http` Trigger; the JSON body and path parameters are the input. Answers the Procedure's output |

A failure is `{ "error": <diagnostic> }` with the code's status
([Diagnostics](./diagnostics.md)). A cookie session cannot mutate across
origins.

### Auth (identity `mantle`)

| Route | |
|---|---|
| `GET /api/auth/methods` | the sign-in methods this service offers |
| `/api/auth/*` | Better Auth: email OTP (`/email-otp/send-verification-otp`, `/sign-in/email-otp`), magic link, social and generic OAuth sign-in, sessions, sign-out, the OAuth provider |
| `/.well-known/oauth-authorization-server/*`, `/.well-known/oauth-protected-resource[/mcp]` | OAuth metadata, served by Better Auth |
| `/oauth/consent`, `/oauth/consents` | consent and connected apps, session only |

### MCP

| Route | |
|---|---|
| `POST /mcp` | the public surface (Streamable HTTP, JSON-RPC) |
| `POST /mcp/staff` | the staff surface: staff only, the same token as `/mcp`; see [MCP and agents](../concepts/mcp-and-agents.md) |

### Admin API

Every route needs a staff caller; the column names the least role.

| Route | Role | |
|---|---|---|
| `GET /admin/api/me`, `GET /admin/api/bootstrap` | contributor | the caller; the console's first load |
| `GET /admin/api/collections`, `GET …/collections/{name}/statistics` | contributor | Schemas; statistics answer 501 in 0.2.0 |
| `GET /admin/api/entries?collection=`, `GET …/entries/export`, `GET …/entries/{id}` | contributor | list (with `search`, `limit`, `cursor`), CSV, one row |
| `POST /admin/api/entries`, `PATCH …/entries/{id}` (with `expectedVersion`) | contributor | create, edit (contributors: drafts only) |
| `POST …/entries/{id}/publish`, `…/unpublish`, `DELETE …/entries/{id}` | editor | |
| `GET /admin/api/views-manifest`, `GET …/views/{name}`, `GET …/views/{name}/export` | contributor | staff Views (`{ name, title, description, input, list: { columns, searchFields, filterFields }, columns }`); rows by `limit`/`cursor` with `search` and `filter.<output>`; CSV |
| `GET /admin/api/operations`, `POST …/operations/{name}` | contributor | Procedures bound to the staff MCP surface |
| `GET /admin/api/site` | contributor | site metadata, `mcpEndpoints`, and `capabilities: { siteSettings, media, invitationEmail, statistics }` (what this deployment turned on; the console hides what is off) |
| `GET`, `PATCH /admin/api/site-settings` | owner | 501 `SITE_NOT_CONFIGURED` without `runtime.site` |
| `POST /admin/api/media/uploads`, `POST …/media/uploads/{groupId}/commit`, `GET …/media`, `GET`, `PATCH`, `DELETE …/media/{id}` | editor | with `media` and `runtime.site` |
| `GET /admin/api/webmcp`, `POST …/webmcp/{tool}` | contributor | the staff tools for a browser agent (`{ tools, routes }`); a call runs one as `/mcp/staff` does and answers `{ output }` |
| `GET /admin/api/staff`, `PATCH …/staff/{id}/role`, `POST …/staff/invitations`, `DELETE …/staff/invitations/{id}` | owner | with an `AdminIdentity` that has `directory` / `roles` |
| `GET /admin/api/members` | editor | with `directory` |
| `GET /admin/api/developer-console` | owner | the plan's data model, logic and schedules |

## Packages

Two npm packages, always published together at one version.

| Import | Exports |
|---|---|
| `@aotter/mantle` | `createMantle`, `createMantleRuntime`, `withCaller`, `systemCaller`, the `Caller`, `CallerResolver`, `MantleService`, `HandlerContext`, `Invocation` and Store types, `EmailSender` |
| `@aotter/mantle/spec` | the grammar types, `compilePlan`, `mcpTools`, `DiagnosticError`, `runtimeDiagnostic` (the SQL compiler loads only when called) |
| `@aotter/mantle/d1`, `/d1/compile` | the D1 dialect: `sqliteStorage`; its compile side |
| `@aotter/mantle/cloudflare` | `d1Storage`, `d1Driver`, `r2MediaStorage`, `toCloudflareCron` |
| `@aotter/mantle/auth` | `createMantleAuth`, `createSetupIncompleteAuth`, `createCallerResolver`, `createAuthRoutes`, `ConsoleEmailSender`, `appleClientSecret` |
| `@aotter/mantle/admin` | `createAdminSurface`, `AdminIdentity` |
| `@aotter/mantle/mcp` | `createMcpSurface` |
| `@aotter/mantle/web` | `createRestSurface` |
| `@aotter/mantle/testing` | `runStorageConformance`, the dialect compliance suite |
| `@aotter/mantle-ui` | `/controller`, `/kit`, `/mcp-app`, and the prebuilt Admin console in `dist/admin` (exported as `./admin/index.html`), which the preset serves at `/admin` |

A subpath that is not imported is never loaded: a service with identity
`none` bundles no Better Auth, and no Worker bundles the SQL parser.

## CLI

`mantle generate [--manifests <dir>] [--features <list>] [--identity <kind>]`
and `mantle generate --check [--database <file>]`. See
[Project layout and CLI](../start/project-and-cli.md).
