---
description: Protect Views and Procedures with site-issued API keys, opaque scopes and a live entitlement guard, over REST and MCP.
---
# Guarded API access: API keys, scopes and entitlement

[Examples hub](./README.md)

Three access levels: anonymous, a verified credential with a scope, and a
credential plus a live paid-state guard. Read it if other systems or agents
call your service with keys instead of browser sessions.

## Problem

A service sells API access. Anyone may read the public catalog. Customers get
API keys the service issues and stores itself; each key carries scopes such as
`catalog:read` or `exports:read`. Some operations also need the customer's
subscription to be paid right now, a fact that changes independently of the
key. The same operation must be callable over REST and the public MCP surface
with the same authorization. Mantle enforces; the service owns keys, scopes
and billing.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: catalog-items }
spec:
  title: Catalog items
  lifecycle: publishing
  uniqueIndexes: [[slug]]
  schema:
    type: object
    additionalProperties: false
    required: [slug, title, priceMinor]
    properties:
      slug: { type: string, pattern: "^[a-z0-9-]+$" }
      title: { type: string, minLength: 1, maxLength: 160 }
      priceMinor: { type: integer, minimum: 0, x-mcp-hint: money-minor }
---
# 1. Anonymous public read
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: public-catalog }
spec:
  surface: public
  description: The published catalog, for anyone.
  sql: SELECT id, slug, title, priceMinor, updated_at FROM "catalog-items" ORDER BY title LIMIT 100
---
# 2. A verified credential with a scope. Views take the same `requires` as Procedures.
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: partner-catalog }
spec:
  surface: public
  description: The catalog with every field, for API keys with catalog:read.
  requires: { auth: { all: [ctx.auth, { ctx.auth.scope: "catalog:read" }] } }
  sql: SELECT id, slug, title, priceMinor, created_at, updated_at FROM "catalog-items" ORDER BY slug
---
# 3. A scope plus a live entitlement guard
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: require-active-api-access }
spec:
  input: { type: object }
  output: { type: object }
  handler: { ref: requireActiveApiAccess }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Procedure
metadata: { name: download-export }
spec:
  title: Download export
  description: Fetch a prepared export report; needs exports:read and active paid access.
  requires:
    auth: { all: [ctx.auth, { ctx.auth.scope: "exports:read" }] }
    guard: { procedure: require-active-api-access }
  input:
    type: object
    required: [reportId]
    properties:
      reportId: { type: string }
  output:
    type: object
    required: [reportId]
    properties:
      reportId: { type: string }
  handler: { ref: downloadExport }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: download-export-http }
spec:
  source: { kind: http, method: POST, path: /api/exports/download }
  target: { procedure: download-export }
---
apiVersion: cms.mantle.aotter.net/v2
kind: Trigger
metadata: { name: download-export-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: download-export }
```

The predicate vocabulary is closed and is evaluated against the `Caller` only:

- `ctx.user` and `ctx.auth` both hold for any `user` caller, whatever its
  credential (session, OAuth, API key or personal token). An anonymous or
  system caller satisfies neither.
- Each `ctx.auth.scope` names one opaque scope the caller must carry; repeat it
  for several.
- `guard.procedure` names one unguarded `ref` Procedure.

The order is fixed: resolve the caller, check `requires.auth`, validate the
input, run the guard, run the target. See the
[authorization reference](../handbook/reference/authorization.md).

## The caller resolver

The service's entry resolves the caller once per request with a
`CallerResolver`. This one recognizes the service's own API keys and hands
everything else to the resolver `mantle generate` wrote (sessions and OAuth
bearer tokens). The table is the application's; Mantle neither creates nor
reads it.

```ts
// src/apiKeys.ts
import type { CallerResolver } from "@aotter/mantle";

interface KeyRow { readonly id: string; readonly account_id: string; readonly scopes_json: string; readonly revoked_at: string | null }

export function withApiKeys(db: D1Database, next: CallerResolver): CallerResolver {
  return async (request) => {
    const raw = request.headers.get("x-api-key");
    if (raw === null) return next(request); // not ours: a session or a bearer token may still be
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(raw)))]
      .map((b) => b.toString(16).padStart(2, "0")).join("");
    const row = await db.prepare("SELECT id, account_id, scopes_json, revoked_at FROM site_api_keys WHERE token_sha256 = ?")
      .bind(digest).first<KeyRow>();
    const scopes: unknown = row ? JSON.parse(row.scopes_json) : null;
    // a presented but unknown or revoked key is 401, never anonymous
    if (!row || row.revoked_at !== null || !Array.isArray(scopes)) return { invalid: true };
    return {
      caller: {
        kind: "user",
        subject: `account:${row.account_id}`, // namespaced, so it never collides with a signed-in user's id
        role: null,
        scopes: scopes.filter((s): s is string => typeof s === "string"),
        credential: "api-key",
        credentialId: row.id, // the record id, never the raw key
        clientId: null,
      },
    };
  };
}
```

In `src/service.ts`, wrap the generated resolver:

```ts
const resolver = withApiKeys(env.DB, createCallerResolver(auth, { jwtBearer: { audience: `${origin}/mcp` } }));
```

Every surface already runs behind `withCaller(resolver, …)`, so REST, both MCP
surfaces and Admin see the same caller. A key never gets a staff role here, so
it can never pass Admin's gate.

## Handlers

```ts
// src/handlers.ts
import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle/spec";
import type { MantleHandlers } from "../.mantle/generated/mantle.js";
import type { Env } from "./service.js";

export const handlers: MantleHandlers<Env> = {
  requireActiveApiAccess: async (_input, ctx) => {
    const account = ctx.caller.kind === "user" ? ctx.caller.subject : null;
    const paid = account
      ? await ctx.env.DB.prepare("SELECT 1 FROM site_api_entitlements WHERE account = ? AND state = 'paid'").bind(account).first()
      : null;
    if (!paid) {
      throw new DiagnosticError(runtimeDiagnostic({ code: "ENTITLEMENT_REQUIRED", severity: "error", path: "site:api-entitlement", message: "Active paid API access is required." }));
    }
    return {};
  },

  downloadExport: async ({ reportId }) => ({ reportId }),
};
```

A guard receives the target's validated input and the same caller, reads only
(its `ctx.store.write` and `ctx.invoke` fail), runs on every call and is never
cached. A throw of any kind fails closed and the target never runs; only a
`DiagnosticError` chooses the status.

## Try it

```sh
curl -sS http://127.0.0.1:8787/api/views/public-catalog
curl -sS http://127.0.0.1:8787/api/views/partner-catalog -H "x-api-key: $SITE_API_KEY"
curl -i -X POST http://127.0.0.1:8787/api/exports/download \
  -H 'content-type: application/json' -H "x-api-key: $SITE_API_KEY" -d '{"reportId":"report-1"}'
```

| Caller | HTTP | `error.code` |
|---|---|---|
| valid key, required scope, paid | 200 | — |
| no credential, for a target that `requires` one | 401 | `UNAUTHENTICATED` |
| a presented key that is unknown or revoked | 401 | `UNAUTHENTICATED`, before any surface runs |
| valid key without the scope | 403 | `AUTH_DENIED` |
| scoped key, no paid row | 402 | `ENTITLEMENT_REQUIRED` |

Over MCP the same Procedure answers `download_export` with an error result
carrying the same code. A standard MCP client authenticates with an OAuth
bearer token from the service's authorization server; an agent holding an API
key can send `x-api-key` instead, since `/mcp` sits behind the same resolver.
`tools/list` shows `public_catalog`, `partner_catalog` and `download_export`.
Listing is not enforcement: every call checks the predicates and the guard
again.

## What this leaves out

Mantle does not issue or store keys, define a scope catalog, or read a payment
provider.

- **Key issuance.** Generating, hashing, showing once, rotating and revoking
  keys is application code writing `site_api_keys`.
- **Billing.** Whatever fills `site_api_entitlements` (a webhook, a sync, a
  staff action) is outside the guard; the guard reads the current row.
- **Personal tokens.** A token that acts as a signed-in user resolves to that
  user's own subject key, with `credential: "personal-token"`, in the same
  resolver.

## Source

- [Authorization](../handbook/concepts/authorization.md): `Caller`, `CallerResolver`, `withCaller`
- [Authentication](../handbook/cloudflare/authentication.md): the generated resolver
