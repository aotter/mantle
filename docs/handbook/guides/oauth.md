# OAuth provider and consent

Auth remains app-owned. Install the existing optional Better Auth peers and
create your `betterAuth()` instance with `jwt({ disableSettingJwtHeader: true })`
and `oauthProvider` (or the provider's MCP preset). Append `oauthGrantExtension`
**first** in its `extensions`. The helper comes from
`@aotter/mantle/auth/oauth` and binds issued access tokens to the current consent
ID and Better Auth’s consent reference without changing `referenceId`. Add
`oauthGrantRevocation()` from the same module to the plugins: it ends a user's
grants on a password reset or admin action (below), and `mantle generate --auth`
refuses an OAuth provider without it.
Configure
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
All of sub, azp, mantle_consent_id and the consent reference must match, and so
must sid while the token stands on its session (an `offline_access` token may
outlive it; see below). The consent must cover the resource and every token
scope. `scopes` adds a resource-specific scope floor (403 when missing).
Unbound legacy tokens fail closed. Disconnect deletes the grant first, revokes
its access/refresh tokens. Tokens issued without an active consent fail closed.
First-party `skip_consent` tokens instead require a live, enabled client with
`skipConsent` and allowed scopes, plus the same session or `offline_access`
rule as consented tokens. Already-issued
JWTs fail on the next call, and reconsenting cannot revive the old JWT lineage.

Grant lifetime follows Better Auth. Better Auth issues a refresh token only when
the grant includes `offline_access`; a client registered for `authorization_code`
may use `refresh_token` too, so registering only `authorization_code` does not
prevent long-lived grants.
For renewable MCP connections, the examples permit `scopes: ["mcp", "offline_access"]`.
An explicit `scopes` list replaces the provider's defaults; `["mcp"]` alone
disables refresh-token issuance. The client must also request `mcp offline_access`
and the user must consent to background access. Declaring the `refresh_token`
grant type alone is insufficient. `offline_access` belongs in authorization-server
metadata, not in the protected resource's required scope floor; resource metadata
continues to advertise `mcp`.

For a new ChatGPT custom MCP connection, open **Advanced OAuth settings** after
entering the server URL and let discovery finish. Keep `mcp` selected and add
`offline_access` to **Base scopes** before creating and linking the connection.
Base scopes are requested even when tools declare their own scopes; selecting
only a default scope can be superseded by tool-level scopes. Check that the
consent page actually lists both scopes. Merely advertising `offline_access` in
authorization-server metadata does not make ChatGPT request it: a default
connection can request only `mcp`, render successfully, and receive no refresh
token. Do not put `offline_access` in the resource's required scope floor or add
it silently to an authorization request after the user has consented.

For an existing connection granted only `mcp`, deploy the allowed-scope change,
refresh the client's discovery/registration metadata, then reconnect or reauthorize
once with `offline_access` and obtain updated consent. Allowing a scope does not
add it to a stored consent. Do not edit consent rows, prolong access-token TTLs or
disable grant checks to avoid that step. Verify a refresh token was issued and
that the client can rotate it and resume MCP after access expiry; a successful
initial `tools/list` does not prove renewable authorization. The reference service's
local smoke exercises issuance, refresh after website sign-out, rotation retry
and revocation using real OAuth endpoints and a disposable D1.

Without `offline_access` the grant is bound to the browser session: its tokens
stop working when that session expires or the user signs out. A refresh that
narrows the scope to drop `offline_access` after the session ends returns
`invalid_grant`, so it never yields an unusable token. An `offline_access` grant
outlives the browser session. Expiry, deletion and sign-out of the session leave
it usable until its current refresh token expires or is revoked. Revocation
includes disconnect, refresh-token revocation and Better Auth's reuse detection.
Each refresh rotates the token with a fresh `refreshTokenExpiresIn` (30 days by
default), so an offline grant that keeps refreshing does not expire. Without a live session, its access tokens need an
unrevoked, unexpired `offline_access` refresh token for the same user and client.
The consent, client, scope, resource and ban checks still apply. An access token
issued before sign-out stays valid until it expires (one hour by default).
`oauthGrantRevocation()` ends every OAuth grant of the user once one of these
succeeds: revokes their refresh and access tokens, deletes their consents for
every client (the next authorization asks again, except for a first-party
`skip_consent` client, which never asks) and their unredeemed
authorization codes. The events and the sessions each one ends:

| Event | Sessions ended |
| --- | --- |
| Password reset (`/reset-password`, `/email-otp/reset-password`, `/phone-number/reset-password`) | all |
| Admin password change (`/admin/set-user-password`) | all |
| Password change with `revokeOtherSessions` | all; Better Auth gives the current device a new session |
| Admin ban (`/admin/ban-user`, or `/admin/update-user` setting `banned: true`) | all (Better Auth) |
| Admin session revocation (`/admin/revoke-user-sessions`) | all (Better Auth) |
| Email OTP or magic-link sign-in (`/sign-in/email-otp`, `/magic-link/verify`) that proves the address of an unverified user | all, and its password and linked accounts (Better Auth) |

The last row covers account pre-hijacking: someone who signed up with another
person's address before it was verified loses their OAuth grants as well as the
password, linked accounts and sessions that Better Auth strips when the owner
proves the address. Mantle ends these grants before Better Auth checks the code or
link, while the user is still unverified, so a failed OTP or magic-link attempt on an
unverified user also ends that user's OAuth grants.

Otherwise a failed attempt, session expiry, a password change without `revokeOtherSessions`,
and the user's own sign-out, `/revoke-sessions` and `/revoke-other-sessions`
("sign out everywhere") end no OAuth grant, as in Better Auth; the user ends a
connected app's grant by disconnecting it on the connected-apps page
(`/oauth/consents`). Unbanning does not restore grants. An access token issued
before the event is rejected on its next use, with one exception: an
`offline_access` access token of a first-party `skip_consent` client passes again,
until it expires (one hour by default), once the user grants that client offline
access anew, because it is checked against any live `offline_access` refresh token
of the same user and client. Better Auth's `/oauth2/introspect` reports a refreshed
token inactive once its original session has expired, while Mantle's resource
check accepts it; Mantle does not use introspection.
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
