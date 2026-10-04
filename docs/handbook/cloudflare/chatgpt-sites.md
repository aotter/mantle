---
description: Run a Mantle 0.2.0 service on ChatGPT Sites — the Cloudflare preset with a custom identity over Sites sign-in, D1 schema delivery, R2 media, MCP paths, and what to verify after each publish.
---
# Mantle on ChatGPT Sites

A ChatGPT Site runs a Cloudflare Worker with D1 and R2 bindings, and Sites owns
sign-in and deployment. Mantle runs there as the ordinary Cloudflare preset
with `identity: custom`: Sites authenticates the person, and your
`src/identity.ts` turns that into a Mantle `Caller`. There is no Sites option in
`mantle generate` and no Sites code in Core.

This page is a guide, not a runnable example. Inspect the Site's actual
hosting configuration and bindings before relying on any detail here, and
verify every claim on the deployed Site.

## Generate

```sh
pnpm exec mantle generate --identity custom --features mcp,admin,web
```

Keep the application outside the Mantle SDK checkout, pin every
`@aotter/mantle*` package to one exact version, and publish through Sites; do
not `wrangler deploy` a Site's Worker yourself.

## Identity: Sites sign-in as a `CallerResolver`

Sites' ingress authenticates the visitor and forwards the identity in
`oai-authenticated-user-*` headers. Trust them **only** when every request
reaches the Worker through that ingress, which strips caller-supplied copies;
never expose the Worker on another route.

Staff roles are the application's: keep them in your own table (here
`sites_users (id, email, role)`, created by your own migration) and read them
on every request. A Site viewer is not automatically a Mantle editor.

```ts
// src/identity.ts
import type { CallerResolver } from "@aotter/mantle";

export function sitesResolver(db: D1Database, ownerEmail: string | undefined): CallerResolver {
  return async (request) => {
    const sub = request.headers.get("oai-authenticated-user-id");
    const email = request.headers.get("oai-authenticated-user-email")?.trim().toLowerCase();
    if (!sub) return { caller: { kind: "anonymous" } };
    if (!email || sub.length > 512) return { invalid: true };
    const subject = `chatgpt:${sub}`; // namespaced: unique across issuers, never the email
    await db.prepare("INSERT INTO sites_users (id, email, role) VALUES (?1, ?2, ?3) ON CONFLICT (id) DO NOTHING")
      .bind(subject, email, email === ownerEmail?.trim().toLowerCase() ? "owner" : null).run();
    const row = await db.prepare("SELECT role FROM sites_users WHERE id = ?1").bind(subject).first<{ role: "owner" | "editor" | "contributor" | null }>();
    return { caller: { kind: "user", subject, role: row?.role ?? null, scopes: [], credential: "session", credentialId: null, clientId: null } };
  };
}
```

In `src/service.ts`, use `sitesResolver(env.DB, env.OWNER_EMAIL)` where the
preset uses `resolveCaller`. The email is used only to recognize the first
owner. To manage staff from Admin, implement `AdminIdentity`'s `directory` and
`roles` facets (from `@aotter/mantle/admin`) over `sites_users` and pass it as
`identity`; without it Admin hides user management.

A Sites session is a browser session. It is not an OAuth bearer token, so it
does not authenticate a remote MCP client.

## Storage on D1

Boot converges Schema tables to the plan. If the Site applies schema changes
through migration files instead of letting the Worker run DDL, deliver
Mantle's SQL that way:

1. Point `mantle generate --check --database <file>` at a local SQLite file
   in the same state as the Site's database (for example local D1 under
   `.wrangler/state/v3/d1/`, migrated the same way).
2. Put the printed SQL into a new migration in the Site's migration directory,
   together with your own tables (`sites_users`).
3. Publish; boot then finds the database converged and applies nothing.

Repeat for each plan change. A blocked change is resolved by hand, as in
[Deploy and operate](./deploy-and-operate.md#resolving-a-blocked-change).

## Media

`r2MediaStorage` presigns uploads with R2's S3 API, which needs an S3
endpoint and an API key pair. With only an R2 binding, implement the
`MediaStorage` port yourself (`createUpload`, `commitUpload`, `deleteObject`)
and add two routes to your service:

- an authenticated, same-origin `PUT` route that checks the pending upload,
  the declared type and the exact size before `bucket.put`;
- a public `GET` route that serves only committed variants, with a safe type
  and `nosniff`.

Pass it as `media` to `createAdminSurface` and declare media purposes in the
site defaults ([Media uploads with R2](./media-r2.md)).

## MCP paths

Try `/mcp` first. If the Site does not route it to the Worker, mount the
public surface at another path you own (`createMcpSurface(runtime, { basePath:
"/agent/mcp", surface: "public" })`) and report the real paths through
`createAdminSurface`'s `site: { mcpEndpoints }`. Admin and its browser tools
work with the Sites session. A remote staff MCP client (`/mcp/staff`)
needs a real OAuth authorization server and bearer verification in your
resolver; a forwarded identity header is not one.

## Verify after every publish

- Anonymous: a public View, an HTTP Trigger, `/mcp` (or your path)
  `initialize` and `tools/list` when a public tool may be called anonymously;
  when every public tool `requires` a caller, they answer 401 with a
  `WWW-Authenticate` challenge instead.
- The owner: `GET /admin/api/me` is `owner`; a staff View and an operation.
- A second account: no Admin access until granted; revoking the role takes
  effect on the next request.
- Every binding the service uses, on the deployed Site, not only locally.

Sites lists financial transactions among its unsupported uses; a working
sandbox flow is not support for live payments.
