# Auth hosting model

The native SDK leaves authentication and identity selection to application code.
The application resolves a verified `Caller` for each request and passes it to
generated queries and selected surfaces. There is no `mantle.config.json.identity`
switch or generated auth/service preset. See the current
[service composition](handbook/cloudflare/service-entry.md) and
[authorization contract](handbook/reference/authorization.md).

| Application wiring | Who produces the caller |
|---|---|
| Better Auth | App-owned `auth.ts` and optional official plugins; `resolveCaller` from `@aotter/mantle/auth` verifies sessions/tokens and carries the original branded identity. The app owns the database, provider credentials and production email sender. |
| Existing identity provider | An app-owned resolver verifies its sessions/tokens, then constructs the original Caller with `userCaller` from `@aotter/mantle/user-fields`. Never derive authority from unverified request data. |
| Public-only routes | The app supplies `{ kind: "anonymous" }`; generated SQL still applies public visibility and row rules. |

Domain and transport boundaries:

- **Same parent domain.** First-party apps under one registrable domain can
  share a Better Auth session with `crossSubDomainCookies` and a
  `cookiePrefix`; `trustedOrigins` is the auth-flow trust list, not CORS.
- **Customer domains.** Cookies never cross registrable domains. A customer
  site runs its own OAuth/OIDC flow against the identity provider and keeps
  its own session; its app-owned resolver maps that verified session to a Caller.
- **API and MCP authorization** retains generated `requires` and row policy.
  Selected REST/MCP/Admin boundaries accept `authorize(target, caller)` for
  per-target permissions; direct generated calls do not invoke that callback.
  Dynamic manifest `requires.guard` is refused. See
  [surface contracts](handbook/reference/surface.md).

The hosted-auth/Landing provisioning model from 0.1.x (ADR-0014) is historical.
An application behind a host gateway uses the explicit
[Gateway mode](handbook/reference/authorization.md#gateway-mode) contract;
host project membership alone does not grant application admin authority. See
[Authentication](handbook/cloudflare/authentication.md) and
[Authorization](handbook/concepts/authorization.md).
