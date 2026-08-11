# API and MCP authorization

Mantle gives generated sites one authorization pipeline for manifest HTTP
Triggers, Views, Procedures, and MCP tools. Core verifies or normalizes a
caller, evaluates the closed manifest predicates, invokes an optional dynamic
guard Procedure, and only then reaches the target.

Mantle does **not** issue or store API keys or personal tokens, define a scope
catalog, read payment-provider state, or decide who is entitled to a product.
Those are site-owned concerns. The Cloudflare adapter supplies a narrow
resolver seam and the runtime supplies the common enforcement machinery.

## Ownership boundary

| Mantle Core SDK | Generated site / Mantle Site |
| --- | --- |
| Curated OAuth resource and audience options | API-key and personal-token generation, hashing, storage, rotation, and revocation |
| JWT verification and linked-provider token facade | Scope names and grant rules |
| `ConsumerCredentialResolver` normalization seam | Account, transaction, subscription, and entitlement tables |
| `HandlerContext.auth`, closed predicates, and guard orchestration | Guard handlers and payment-state freshness rules |
| Consistent REST/MCP diagnostics and reflection | CORS policy and business response fields |

Authentication and entitlement are deliberately separate. A resolver answers
“is this credential valid, and who/what does it represent?” A guard answers
“is that currently verified caller allowed to perform this business action?”

## Core contracts

After the adapter verifies a caller, runtime handlers see only normalized,
non-secret metadata:

```ts
interface HandlerContext {
  readonly user: { readonly id: string } | null;
  readonly staff: { readonly id: string; readonly role: StaffRole } | null;
  readonly auth?: {
    readonly credential: "session" | "oauth" | "api-key" | "personal-token";
    readonly credentialId: string | null;
    readonly clientId: string | null;
    readonly scopes: readonly string[];
  };
  // env, waitUntil, and event omitted here
}
```

Raw credentials and refresh tokens never enter this context. The manifest
vocabulary stays closed:

```yaml
requires:
  auth:
    all:
      - ctx.auth
      - ctx.user
      - { "ctx.auth.scope": "orders:read" }
  guard:
    procedure: require-active-api-access
```

- `ctx.auth` requires any verified credential.
- `ctx.user` requires a verified user subject. Service API keys may have no
  user.
- each `ctx.auth.scope` entry requires that opaque, site-defined scope;
  repeat the predicate to require multiple scopes.
- `ctx.staff` continues to use the closed staff-role list.
- `guard.procedure` names one ordinary, unguarded `handler.kind: ref`
  Procedure. It is not a fifth Policy atom.

The runtime order is fixed:

1. verify and normalize the transport credential;
2. evaluate static predicates before exposing input-schema details;
3. validate/coerce target input or View params;
4. invoke the guard with that validated value and the same context;
5. invoke the target only after the guard succeeds.

Missing/invalid credentials return `401`; a verified caller missing a required
role or scope returns `403`; a site guard may return
`ENTITLEMENT_REQUIRED`/`402`. Guards run on every call and are not cached.

### Identity-bound Views

Use the closed `{ "$ctx.user": "id" }` filter sentinel for rows owned by the
current site-local Better Auth user. The caller never supplies this value, so
the same View is safe on both REST and public MCP:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: orders }
spec:
  schema:
    type: object
    properties:
      userId: { type: string, x-mantle-bind: ctx.user }
      orderNumber: { type: string }
      orderStatus: { type: string }
      totalMinor: { type: integer }
      placedAt: { type: integer }
  indexes: [[userId, placedAt]]
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: my-orders }
spec:
  surface: public
  from: orders
  requires:
    auth:
      all: [ctx.user]
  filter:
    and:
      - { eq: { field: status, value: published } }
      - { eq: { field: userId, value: { "$ctx.user": id } } }
  fields: [orderNumber, orderStatus, totalMinor, placedAt]
  orderBy: [{ field: placedAt, direction: desc }]
  limit: 50
```

Core rejects this sentinel unless the View requires `ctx.user` and the bound
field is the leftmost field of a declared Schema index. Missing identity fails
with `401`; it never drops the filter or falls back to all rows. REST exposes
`GET /api/views/my-orders`; public MCP exposes `query_view_my_orders`. Both
call `ExecuteViewUseCase` and bind the same `ctx.user.id`.

The id belongs to the customer site's Better Auth user row. It is not a
Mantle Platform user id, Hosted Auth upstream subject, email, or provider id.
Hosted Auth may establish the site session, but Platform is not part of the
View query path.

## Site OAuth symmetry

A site-issued OAuth access token represents the same caller on public MCP and
manifest HTTP routes. Both surfaces populate `ctx.user` and `ctx.auth` from the
same token grant; expiry, revocation, scope, client, and resource audience are
enforced before the Procedure or View runs.

## Cloudflare consumer wiring

Pass one site-owned resolver to `createCmsRef`. Return `not-handled` when the
request is not one of the site's credential formats, `invalid` when it is a
recognized but bad/revoked credential, and `verified` only after checking the
authoritative site record.

This example table and query are consumer code, not a Mantle migration:

```ts
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
      // Lets configured OAuth bearer or cookie-session auth try next.
      return { kind: "not-handled" };
    }

    const digest = await sha256(raw);
    const row = await db
      .prepare(
        "SELECT id, kind, user_id, scopes_json, revoked_at " +
          "FROM site_credentials WHERE token_sha256 = ? AND kind = ? LIMIT 1",
      )
      .bind(digest, kind)
      .first<CredentialRow>();

    if (!row || row.revoked_at !== null) return { kind: "invalid" };
    const scopes = parseScopes(row.scopes_json);
    if (!scopes) return { kind: "invalid" };

    return {
      kind: "verified",
      credential: {
        credential: row.kind,
        credentialId: row.id, // opaque row id, never the raw key/token
        userId: row.user_id,
        scopes,
      },
    };
  };
}

async function sha256(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function parseScopes(json: string): string[] | null {
  try {
    const value: unknown = JSON.parse(json);
    return Array.isArray(value) && value.every((scope) => typeof scope === "string")
      ? value
      : null;
  } catch {
    return null;
  }
}
```

Wire it alongside the existing Auth facade. `oauthBearer` is optional and
enables JWT bearer verification for manifest REST routes:

```ts
import {
  AssetsAssetServer,
  createCmsRef,
  createMcpApiHandler,
  createOAuthProvider,
  D1DatabaseDriver,
  mountServerEndpoints,
} from "@aotter/mantle/cloudflare";

const runtimeRef = createCmsRef({
  manifests,
  handlers,
  bindings: {
    db: new D1DatabaseDriver(env.DB),
    assets: env.ASSETS
      ? new AssetsAssetServer(env.ASSETS)
      : { fetch: async () => null },
  },
  auth,
  credentialResolver: siteCredentialResolver(env.DB),
  oauthBearer: {
    audience: "https://api.example.com",
    // Optional server-wide floor. Manifest scopes still run per target.
    scopes: ["api"],
  },
});

mountServerEndpoints(app, runtimeRef);

const oauthProvider = createOAuthProvider({
  defaultHandler: {
    fetch: (request, workerEnv, ctx) => app.fetch(request, workerEnv, ctx),
  },
  apiHandlers: {
    "/mcp/staff": createMcpApiHandler({ ref: runtimeRef, surface: "staff" }),
    "/mcp": createMcpApiHandler({ ref: runtimeRef, surface: "public" }),
  },
  scopesSupported: ["mcp"],
});
```

Export or delegate to `oauthProvider` as the Worker's top-level handler so the
OAuth provider can verify MCP bearers before dispatching to either MCP surface.

Resolution precedence is site resolver, configured OAuth bearer, then cookie
session. A recognized invalid credential never falls back to a valid cookie.
For each verified user, the adapter re-reads the current staff role rather than
trusting a token or consent-time snapshot.

## 1. Anonymous public API

Omit `requires` when the operation is intentionally anonymous:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: public-status }
spec:
  input: { type: object }
  output:
    type: object
    required: [status]
    properties:
      status: { type: string }
  handler: { kind: ref, ref: publicStatus }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: public-status-http }
spec:
  source: { kind: http, method: POST, path: /api/status }
  target: { procedure: public-status }
```

```ts
const handlers = {
  publicStatus: async () => ({ status: "ok" }),
};
```

```bash
curl -i -X POST https://site.example.com/api/status \
  -H 'content-type: application/json' \
  -d '{}'
# HTTP/2 200
```

OpenAPI emits no `security` requirement and no auth responses for this
operation. No MCP tool is created unless a separate MCP Trigger targets the
Procedure.

## 2. Public API requiring an API key

The API remains publicly reachable, but its target requires a verified
credential and the site-defined `catalog:read` scope:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: read-catalog }
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
metadata: { name: read-catalog-http }
spec:
  source: { kind: http, method: POST, path: /api/catalog/read }
  target: { procedure: read-catalog }
```

```ts
import type { HandlerContext } from "@aotter/mantle/runtime";

const handlers = {
  readCatalog: async (_input: unknown, ctx: HandlerContext) => ({
    credentialId: ctx.auth!.credentialId,
    items: [],
  }),
};
```

```bash
curl -i -X POST https://site.example.com/api/catalog/read \
  -H 'content-type: application/json' \
  -H "x-api-key: $SITE_API_KEY" \
  -d '{}'
# valid key with catalog:read -> 200
# missing or recognized-invalid key -> 401
# verified key without catalog:read -> 403
```

`ctx.auth` intentionally means any verified credential; there is no
credential-kind predicate. Configure and document only the credential sources
the site intends to accept, or put a kind-specific business rule in a guard.
With `security.apiKey` configured during OpenAPI emission, the operation
advertises the real header and carries `x-mantle-required-scopes`.

## 3. API key plus a mutable paid/transaction guard

Keep key verification in the resolver. Put current paid state in an ordinary,
site-owned guard Procedure:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: require-active-api-access }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: requireActiveApiAccess }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: download-export }
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
metadata: { name: download-export-http }
spec:
  source: { kind: http, method: POST, path: /api/exports/download }
  target: { procedure: download-export }
```

```ts
import {
  DiagnosticError,
  runtimeDiagnostic,
} from "@aotter/mantle/spec";
import type { HandlerContext } from "@aotter/mantle/runtime";

const handlers = {
  requireActiveApiAccess: async (_input: unknown, ctx: HandlerContext) => {
    const credentialId = ctx.auth?.credentialId;
    const paid = credentialId
      ? await env.DB.prepare(
          "SELECT 1 FROM site_api_entitlements " +
            "WHERE credential_id = ? AND state = 'paid' LIMIT 1",
        )
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
};
```

```bash
curl -i -X POST https://site.example.com/api/exports/download \
  -H 'content-type: application/json' \
  -H "x-api-key: $SITE_API_KEY" \
  -d '{"reportId":"report-1"}'
# valid + entitled -> 200
# invalid key -> 401
# verified key missing exports:read -> 403
# verified key whose current paid row is absent/revoked -> 402
```

The guard receives the already validated target input and runs for every call.
On `402`, the target handler is not invoked. OpenAPI reflects the guard as
`x-mantle-guard-procedure` and includes a `402` response; Mantle does not infer
or publish the site's billing model.

## 4. Personal token with user scope, shared by REST and MCP semantics

This Procedure requires a user subject, a verified credential, a delegated
scope, and current membership. Bind the same target to HTTP and public MCP:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: require-active-membership }
spec:
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: requireActiveMembership }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: read-account }
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
metadata: { name: read-account-http }
spec:
  source: { kind: http, method: POST, path: /api/accounts/read }
  target: { procedure: read-account }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: read-account-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: read-account }
```

```ts
import {
  DiagnosticError,
  runtimeDiagnostic,
} from "@aotter/mantle/spec";
import type { HandlerContext } from "@aotter/mantle/runtime";

const handlers = {
  requireActiveMembership: async (_input: unknown, ctx: HandlerContext) => {
    const active = await env.DB.prepare(
      "SELECT 1 FROM site_memberships " +
        "WHERE user_id = ? AND state = 'active' LIMIT 1",
    )
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

REST uses the site resolver's personal token:

```bash
curl -i -X POST https://site.example.com/api/accounts/read \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $SITE_PERSONAL_TOKEN" \
  -d '{"accountId":"acct-1"}'
```

Standard remote MCP uses the MCP server's OAuth bearer, not the raw site PAT.
After OAuth normalization, it reaches the same target and guard:

```bash
curl -sS -X POST https://site.example.com/mcp \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $MCP_OAUTH_ACCESS_TOKEN" \
  -d '{
    "jsonrpc":"2.0",
    "id":1,
    "method":"tools/call",
    "params":{
      "name":"read_account",
      "arguments":{"accountId":"acct-1"}
    }
  }'
```

Expected behavior:

| State | REST | MCP |
| --- | --- | --- |
| valid user credential, `accounts:read`, active membership | `200` target result | JSON-RPC `result` |
| missing/invalid credential | `401` | OAuth layer rejects the request |
| verified caller missing user or `accounts:read` | `403` | JSON-RPC error with `error.data.code = "AUTH_DENIED"` |
| membership revoked while credential remains valid | `402` | JSON-RPC error with `error.data.code = "ENTITLEMENT_REQUIRED"` |
| MCP bearer missing the resource-level `mcp` scope | n/a | HTTP `403` plus `WWW-Authenticate: ... insufficient_scope` |

`tools/list` includes `read_account` only on the public surface selected by its
MCP Trigger. The standard Tool schema remains standard: required scopes and
guard metadata are described in text, while every `tools/call` re-evaluates
the manifest predicates and guard. Staff Views are listed/callable only on the
staff MCP surface; discovery is never the enforcement boundary.

## OAuth resource primitives

When one Mantle site is an OAuth client of another, request a stable RFC 8707
resource and use standard `offline_access` when refresh is needed:

```ts
const clientAuth = createAuth({
  // database, baseURL, secret, other methods...
  methods: [{
    kind: "oauth",
    providerId: "mantle-platform",
    clientId: env.PLATFORM_CLIENT_ID,
    discoveryUrl: "https://platform.example.com/api/auth/.well-known/openid-configuration",
    scopes: ["openid", "offline_access", "accounts:read"],
    resource: "https://api.example.com",
  }],
});

const { accessToken, accessTokenExpiresAt, scopes } =
  await clientAuth.getProviderAccessToken(request, "mantle-platform");
```

The server-side getter is bound to the current local session request and never
returns a refresh token or account row. On the provider:

```ts
const providerAuth = createAuth({
  // database, baseURL, secret, methods...
  oauthProvider: {
    loginPage: "/sign-in",
    consentPage: "/consent",
    scopes: ["openid", "offline_access", "accounts:read"],
    validAudiences: ["https://api.example.com"],
  },
});

const verification = await providerAuth.verifyOAuthAccessToken(request, {
  audience: "https://api.example.com",
  scopes: ["accounts:read"],
});
```

The verifier accepts JWT access tokens only and checks the configured issuer,
JWKS/signature, audience, time claims, and required scopes. It returns only
`userId`, `clientId`, `credentialId`, and scopes. Opaque tokens are rejected;
there is no introspection fallback.

## OpenAPI reflection

Emit only the schemes the deployed REST mount actually accepts:

```ts
import { EmitOpenapiUseCase } from "@aotter/mantle/spec";

const { document } = EmitOpenapiUseCase.run({
  manifests,
  title: "Site API",
  version: "1.0.0",
  security: {
    sessionCookie: false,
    oauthBearer: {
      openIdConnectUrl:
        "https://platform.example.com/api/auth/.well-known/openid-configuration",
    },
    apiKey: { in: "header", name: "X-API-Key" },
    personalToken: { bearerFormat: "PAT" },
  },
});
```

Anonymous operations have no security requirement. Protected operations use
configured scheme alternatives, OAuth scopes derive from repeated
`ctx.auth.scope` predicates, and guard-backed targets advertise `402`. Cookie
sessions are represented as cookies, never mislabeled as bearer tokens.

## Runnable contract check

The integration fixture uses mutable, consumer-owned credential and
entitlement fakes. It proves this sequence for one Procedure over REST and MCP:

```text
grant -> REST succeeds -> MCP succeeds
revoke entitlement while credential remains valid
-> next REST call is 402 -> next MCP call is ENTITLEMENT_REQUIRED
```

Run the guide/contract and normalization checks from the Mantle repository:

```bash
pnpm --filter @aotter/mantle-cloudflare exec vitest run \
  test/authorization-integration.test.ts \
  test/resolve-caller.test.ts \
  test/mount-http-trigger-auth.test.ts
```

`authorization-integration.test.ts` also asserts that this shipped guide still
contains all four scenarios and the exact public API names used by the fixture.
The package typecheck catches changes to those APIs; the integration test
catches changes to REST/MCP enforcement and mutable guard behavior.
