# OAuth provider and consent

Auth remains app-owned. Install the existing optional Better Auth peers and
create your `betterAuth()` instance with `jwt({ disableSettingJwtHeader: true })`
and `oauthProvider` (or the provider's MCP preset). Append `oauthGrantExtension`
**first** in its `extensions`. The helper comes from
`@aotter/mantle/auth/oauth` and binds issued access tokens to the current consent
ID and Better Auth’s consent reference without changing `referenceId`.
The deprecated `oauthGrantHooks` is a no-op and may be omitted. Configure
`consentPage: "/oauth/consent"`, loginPage,
resources, allowed/default client registration scopes, and public/native DCR
explicitly. For MCP clients use the SDK's `mcp` preset, `allowPublicClientPrelogin:
true`, and a `90d` registration client-secret expiration. The application selects
plugins and options; Mantle does not wrap Better Auth or run runtime DDL.

With Mantle's native adapters, `oauthProvider.resources` comes from runtime
configuration, including environment-derived identifiers. `schema.sql` contains
auth DDL only. On the first OAuth lookup of a configured resource (authorization,
token issuance, registration defaults or audience checks), the adapter validates
and inserts the missing row with insert-if-absent semantics. Concurrent requests
are safe; subsequent lookups preserve persisted policy edits. No resource deploy
step is required, and `resourceSeedMode` does not overwrite existing rows.
To retire a resource, set its persisted `disabled` policy (or configure it disabled
before its first lookup). Removing configuration does not disable an existing row.
Do not delete a configured resource row: a later lookup in a new adapter instance
can recreate it from configuration. On
`/oauth2/authorize` an invalid configured identifier surfaces as the provider's
`invalid_target` redirect rather than HTTP 500.

Auth initialization, cookie/bearer resolution and normal MCP/REST requests perform
no resource SELECT or INSERT. The adapter suppresses the provider's eager and
bulk lazy seeding. Invalid configured identifiers produce HTTP 500 with
`AUTH_CONFIGURATION_ERROR` and no write; unconfigured identifiers keep the
provider's normal rejection. Validation follows upstream's identifier validator
(or absolute URI without a fragment by default); unsupported signing algorithms
are dropped before insertion.

```ts
import { authRoutes } from "@aotter/mantle/auth/routes";
import { authLoader } from "@aotter/mantle/auth";
const auth = authLoader(() => import("./auth.js").then(m => m.auth));
const routes = authRoutes(auth, {
  methods: [{ kind: "email-otp" }],
  connectedAppsPage: "/admin/connected-apps", // optional; otherwise plain HTML
});
// In fetch: await routes(request) ?? otherRoutes(request).
```

`GET /api/auth/methods` exposes only the supplied method descriptions and does
not load auth. `basePath` must match Better Auth if changed. Better Auth owns all
`/api/auth/*` endpoints and RFC 8414/9728 well-known discovery routes. Mount those
well-known paths at the origin, before a catch-all or proxy; retain the external
issuer/resource URL and trusted forwarding rules. The SDK handler receives them
unchanged. A POST registration whose redirect URIs are all HTTP localhost,
127.0.0.1 or [::1] becomes `application_type: "native"` when omitted; explicit
types and mixed/external callbacks stay under the SDK's validation.

`/oauth/consent` and `/oauth/consents` serve escaped, script-free English or zh-TW
HTML. Their `/data` routes serve the 0.2 UI JSON shapes. Consent approval and
`POST /oauth/consents/revoke` require a live cookie session and same-origin
mutation; bearer credentials cannot grant or disconnect apps. Consent completion
uses only the provider-validated signed query and redirect. All responses are
private/no-store. Connected-app redirects must be same-origin paths.

`resolveCaller(request, loader, { audience, scopes })` verifies token signature,
issuer, audience and request-bound DPoP through Better Auth, including a durable
single-use proof reservation. It then checks the live consent and session and
loads the current database user.
All of sub, azp, sid, mantle_consent_id and the consent reference must match;
the consent must cover the resource and every token scope, and the session must
still be alive. `scopes` adds a resource-specific scope floor (403 when missing).
Unbound legacy tokens fail closed. Disconnect deletes the grant first, revokes
its access/refresh tokens. Tokens issued without an active consent fail closed.
First-party `skip_consent` tokens instead require a live, enabled client with
`skipConsent` and allowed scopes, plus a live user session. Already-issued
JWTs fail on the next call, and reconsenting cannot revive the old JWT lineage.
Database failures remain server errors, rather than silently authenticating.

For app-owned API keys/personal tokens, supply `resolveCredential(request)` in
`resolveCaller` options. It runs before OAuth/cookies; return a verified user
Caller or null when absent, and throw when presented but invalid. The same scope
floor applies. Any non-Bearer/DPoP Authorization header (including Basic from a staging
gateway), unless handled by the app-owned credential hook, is UNAUTHENTICATED
and never falls back to a cookie. The application owns credential verification;
Mantle loads live roles, bans and declared stored fields.

For the 0.2 legacy-DCR cleanup policy, call `pruneLegacyOAuthClients(auth)` from
an application-owned hourly scheduled job. It deletes only ownerless,
non-CIMD/non-reference clients older than 90 days; it runs no boot-time work.

When configuring session secondary storage, set `verification.storeInDatabase: true` and `session.storeSessionInDatabase: true`: live grants and durable DPoP single-use reservations must use the database, never a non-atomic session KV cache.

Auth routing also guards Better Auth’s raw `/api/auth/admin/*` endpoints (including percent-encoded admin paths): only a fresh primary-database `admin` cookie session may enter, and mutations require same origin. A stale admin snapshot in session KV cannot bypass demotion, ban or session deletion. App-owned auth mounts can reuse `guardAuthAdminRequest` from `@aotter/mantle/auth/admin` with a resolver that reads current authority.

Use primary database sessions without session secondaryStorage as the simple
safe configuration. If optional session caching is enabled, use the
**authority-bound** secondary-storage adapter from the identity/auth template
(`@aotter/mantle/auth/hardening`, #1499): every snapshot must be checked against the primary session and current
user before the SDK can read it, including raw SDK endpoints and session lists.
Arbitrary session KV snapshots are outside this secure configuration: middleware
may trust stale roles or refresh an expired primary session from a snapshot.
Merely setting storeSessionInDatabase true does not fix those SDK endpoints.
Mantle's caller and raw-admin guard validate primary authority before refreshing,
but do not make arbitrary SDK session caching safe. Keep verification
consumption and DPoP single-use reservations in the database.
