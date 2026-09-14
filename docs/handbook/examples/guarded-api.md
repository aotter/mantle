---
description: Protect Views and Procedures with site-issued API keys, opaque scopes and a live entitlement guard, over REST and MCP.
---
# Guarded API access: API keys, scopes and entitlement

This example climbs a ladder of four access levels: anonymous, verified credential with a scope, credential plus a live paid-state guard, and a personal token that identifies a user. Read it if other systems or agents call your site with keys instead of browser sessions.

## Problem

A site sells API access. Anyone may read the public catalog. Customers get API keys the site issues and stores itself; each key carries site-defined scopes such as `catalog:read` or `exports:read`. Some operations also require that the customer's subscription is currently paid, a fact that changes independently of the key. Individual users may create personal tokens that act as them, and the same operation must be callable over REST and through the public MCP surface with identical authorization. Mantle verifies, normalizes and enforces; the site owns keys, scopes and billing.

## Manifest

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: catalog-items
spec:
  title: Catalog items
  lifecycle: publishing
  uniqueIndexes:
    - [slug]
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
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: public-catalog
spec:
  surface: public
  from: catalog-items
  fields: [id, slug, title, priceMinor, updatedAt]
  filter:
    eq: { field: status, value: published }
  orderBy:
    - { field: title, direction: asc }
  limit: 100
---
# 2. Verified credential with a scope
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: read-catalog
spec:
  requires:
    auth:
      all:
        - ctx.auth
        - { "ctx.auth.scope": "catalog:read" }
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: readCatalog }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: read-catalog-http
spec:
  source: { kind: http, method: POST, path: /api/catalog/read }
  target: { procedure: read-catalog }
---
# 3. Scope plus a live entitlement guard
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: require-active-api-access
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: requireActiveApiAccess }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: download-export
spec:
  requires:
    auth:
      all:
        - ctx.auth
        - { "ctx.auth.scope": "exports:read" }
    guard: { procedure: require-active-api-access }
  input:
    type: object
    required: [reportId]
    properties:
      reportId: { type: string }
  output: { type: object }
  handler: { kind: ref, ref: downloadExport }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: download-export-http
spec:
  source: { kind: http, method: POST, path: /api/exports/download }
  target: { procedure: download-export }
---
# 4. Personal token with a user subject, shared by REST and MCP
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: require-active-membership
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: requireActiveMembership }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: read-account
spec:
  requires:
    auth:
      all:
        - ctx.user
        - ctx.auth
        - { "ctx.auth.scope": "accounts:read" }
    guard: { procedure: require-active-membership }
  input:
    type: object
    required: [accountId]
    properties:
      accountId: { type: string }
  output:
    type: object
    required: [accountId]
    properties:
      accountId: { type: string }
  handler: { kind: ref, ref: readAccount }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: read-account-http
spec:
  source: { kind: http, method: POST, path: /api/accounts/read }
  target: { procedure: read-account }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: read-account-mcp
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: read-account }
```

The predicate vocabulary is closed. `ctx.auth` means any adapter-verified credential (session, OAuth, API key or personal token); there is no credential-kind predicate. `ctx.user` requires a user subject, which a service API key may lack. Each `ctx.auth.scope` entry requires one opaque, site-defined scope; repeat it for several. `guard.procedure` names one ordinary, unguarded `ref` Procedure. The runtime order is fixed: verify credential → static predicates → validate input → guard → target. See [Authorization](../concepts/authorization.md) and the [authorization reference](../reference/authorization.md).

## Worker and handlers

### Credential resolver

The Cloudflare adapter exposes one seam, `ConsumerCredentialResolver`. It answers `not-handled` when the request carries none of the site's credential formats, `invalid` when it carries a recognized but bad or revoked one, and `verified` after checking the site's own record. The table below is application-owned; Mantle has no migration for it.

```ts
// src/auth/credentialResolver.ts
import type { ConsumerCredentialResolver } from "@aotter/mantle/cloudflare";

type CredentialRow = {
  id: string;
  kind: "api-key" | "personal-token";
  user_id: string | null;
  scopes_json: string;
  revoked_at: string | null;
};

export function siteCredentialResolver(db: D1Database): ConsumerCredentialResolver {
  return async (request) => {
    const apiKey = request.headers.get("x-api-key");
    const authorization = request.headers.get("authorization");

    let kind: CredentialRow["kind"];
    let raw: string;
    if (apiKey !== null) {
      kind = "api-key";
      raw = apiKey;
    } else if (authorization?.startsWith("Bearer site_pat_")) {
      kind = "personal-token";
      raw = authorization.slice("Bearer ".length);
    } else {
      return { kind: "not-handled" }; // let OAuth bearer or the cookie session try next
    }

    const digest = await sha256(raw);
    const row = await db
      .prepare("SELECT id, kind, user_id, scopes_json, revoked_at FROM site_credentials WHERE token_sha256 = ? AND kind = ? LIMIT 1")
      .bind(digest, kind)
      .first<CredentialRow>();
    if (!row || row.revoked_at !== null) return { kind: "invalid" };

    const scopes = parseScopes(row.scopes_json);
    if (!scopes) return { kind: "invalid" };
    return {
      kind: "verified",
      credential: {
        credential: row.kind,
        credentialId: row.id, // opaque row id, never the raw key
        userId: row.user_id,
        scopes,
      },
    };
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function parseScopes(json: string): string[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((s) => typeof s === "string") ? value : null;
  } catch {
    return null;
  }
}
```

Resolution precedence is site resolver, then configured OAuth bearer, then cookie session. A recognized-but-invalid credential never falls back to a valid cookie. Handlers see only normalized metadata on `ctx.auth`: `{ credential, credentialId, clientId, scopes }`. Raw keys never enter the runtime.

### Guards and targets

```ts
// src/handlers.ts
import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle/spec";
import type { HandlerContext } from "@aotter/mantle/runtime";
import type { Env } from "./index.js";

export const handlers = {
  readCatalog: async (_input: unknown, ctx: HandlerContext<Env>) => ({
    credentialId: ctx.auth!.credentialId,
    items: [],
  }),

  requireActiveApiAccess: async (_input: unknown, ctx: HandlerContext<Env>) => {
    const credentialId = ctx.auth?.credentialId;
    const paid = credentialId
      ? await ctx.env.DB.prepare("SELECT 1 FROM site_api_entitlements WHERE credential_id = ? AND state = 'paid' LIMIT 1")
          .bind(credentialId)
          .first()
      : null;
    if (!paid) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "ENTITLEMENT_REQUIRED",
          severity: "error",
          path: "site:api-entitlement",
          message: "Active paid API access is required.",
        }),
      );
    }
    return {};
  },

  downloadExport: async ({ reportId }: { reportId: string }) => ({ reportId }),

  requireActiveMembership: async (_input: unknown, ctx: HandlerContext<Env>) => {
    const active = await ctx.env.DB.prepare("SELECT 1 FROM site_memberships WHERE user_id = ? AND state = 'active' LIMIT 1")
      .bind(ctx.user!.id)
      .first();
    if (!active) {
      throw new DiagnosticError(
        runtimeDiagnostic({
          code: "ENTITLEMENT_REQUIRED",
          severity: "error",
          path: `site:membership/${ctx.user!.id}`,
          message: "Active membership is required.",
        }),
      );
    }
    return {};
  },

  readAccount: async ({ accountId }: { accountId: string }) => ({ accountId }),
};
```

A guard receives the already validated target input and the same `HandlerContext`, runs on every call, and is never cached. Any diagnostic, throw, missing handler or invalid output fails closed; on failure the target is not invoked.

### Wiring

```ts
// src/index.ts
import { createMantleWorker, type MantleCloudflareEnv } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";
import { siteCredentialResolver } from "./auth/credentialResolver.js";
import { handlers } from "./handlers.js";

export interface Env extends MantleCloudflareEnv {
  readonly DB: D1Database;
}

export default createMantleWorker<Env>({
  plan,
  handlers,
  extend: ({ env }) => ({
    credentialResolver: siteCredentialResolver(env.DB),
    jwtBearer: {
      audience: "https://api.example.com",
      scopes: ["api"], // optional server-wide floor; manifest scopes still run per target
    },
  }),
});
```

`jwtBearer` is optional; it enables JWT bearer verification for manifest REST routes against the site's own Auth issuer. See [The conventional Worker](../cloudflare/conventional-worker.md).

## Try it

Rung 1, anonymous:

```sh
curl -sS http://localhost:8787/api/views/public-catalog
# 200 {"ok":true,"data":{"rows":[...],"page":1,"show":100,"hasMore":false}}
```

Rung 2, API key with scope:

```sh
curl -i -X POST http://localhost:8787/api/catalog/read \
  -H 'content-type: application/json' -H "x-api-key: $SITE_API_KEY" -d '{}'
```

Rung 3, API key plus paid state:

```sh
curl -i -X POST http://localhost:8787/api/exports/download \
  -H 'content-type: application/json' -H "x-api-key: $SITE_API_KEY" -d '{"reportId":"report-1"}'
```

Rung 4, personal token over REST:

```sh
curl -i -X POST http://localhost:8787/api/accounts/read \
  -H 'content-type: application/json' -H "authorization: Bearer $SITE_PERSONAL_TOKEN" -d '{"accountId":"acct-1"}'
```

REST outcomes for a protected target:

| Caller state | HTTP | `diagnostic.code` |
|---|---|---|
| valid credential, required scope, entitled | 200 | — (`{ ok: true, data }`) |
| missing credential, or recognized but invalid or revoked | 401 | `UNAUTHENTICATED` |
| verified credential missing a required scope (or `ctx.user` for rung 4) | 403 | `AUTH_DENIED` |
| verified and scoped, but the guard finds no paid or active row | 402 | `ENTITLEMENT_REQUIRED` |

Standard remote MCP uses the MCP server's OAuth bearer, not the raw personal token. After OAuth normalization the call reaches the same target and guard:

```sh
curl -sS -X POST http://localhost:8787/mcp \
  -H 'content-type: application/json' -H "authorization: Bearer $MCP_OAUTH_ACCESS_TOKEN" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"read_account","arguments":{"accountId":"acct-1"}}}'
```

| State | REST | MCP |
|---|---|---|
| valid user credential, `accounts:read`, active membership | `200` | JSON-RPC `result` |
| missing or invalid credential | `401` | OAuth layer rejects the request |
| verified caller missing `ctx.user` or `accounts:read` | `403` | JSON-RPC error, `error.data.code = "AUTH_DENIED"` |
| membership revoked while the credential stays valid | `402` | JSON-RPC error, `error.data.code = "ENTITLEMENT_REQUIRED"` |
| MCP bearer lacking the resource-level `mcp` scope | n/a | HTTP `403` plus `WWW-Authenticate: ... insufficient_scope` |

`tools/list` on `/mcp` includes `read_account` because its MCP Trigger selects the public surface, and `query_view_public_catalog` because the View is public. Discovery is not enforcement: every `tools/call` re-evaluates the predicates and the guard. `read_catalog` and `download_export` have no MCP Trigger and are not tools.

`mantle emit-openapi` reflects all of this: anonymous operations carry no `security`, protected ones list the configured schemes, repeated `ctx.auth.scope` predicates become OAuth scopes plus `x-mantle-required-scopes`, and guarded targets advertise `402` under `x-mantle-guard-procedure`.

## What this deliberately leaves out

Mantle does not issue or store API keys or personal tokens, does not define a scope catalog, and does not read payment-provider state. Accordingly this page omits:

- **Key issuance UI.** Generating, hashing, showing once, rotating and revoking keys is application code writing to `site_credentials`.
- **Billing.** Whatever fills `site_api_entitlements` and `site_memberships` (webhooks, a Stripe sync, a manual Admin action) is outside the guard. The guard only reads the current row.
- **CORS policy and business response fields.**

Related: [Procurement approvals](./procurement-approvals.md) shows session-based `ctx.user` and `ctx.staff` predicates; [Commerce](./commerce-transaction.md) shows a payment callback that is verified by the application rather than by a guard.

## Source

- [`docs/api-mcp-authorization.md`](../../../docs/api-mcp-authorization.md) — the four scenarios, resolver wiring, status tables
- [`packages/adapters/cloudflare/src/mount/resolveCaller.ts`](../../../packages/adapters/cloudflare/src/mount/resolveCaller.ts) — `ConsumerCredentialResolution` shape and precedence
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts) — `extend` returning `credentialResolver` and `jwtBearer`
- [`packages/mantle-runtime/src/domain/model/HandlerContext.ts`](../../../packages/mantle-runtime/src/domain/model/HandlerContext.ts) — `ctx.auth`
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts) — guard order
