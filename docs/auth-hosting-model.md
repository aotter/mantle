# Auth hosting model

0.1.x described free self-hosted auth, a paid hosted-auth platform provisioned
through Landing, and parent- and customer-domain SSO (ADR-0014). In 0.2.0
Mantle never owns the user (ADR-0032 decision 8): the service resolves a
`Caller` once per request, and `identity` in `mantle.config.json` chooses who
produces it.

| `identity` | Who produces the caller |
|---|---|
| `mantle` | `@aotter/mantle/auth`: Better Auth on the service's own database, with email OTP, magic link, social and generic OAuth sign-in, staff roles and an OAuth server for MCP. Self-hosted; the owner supplies provider credentials and an email sender |
| `custom` | the service's own `CallerResolver` over its existing sessions or tokens, which may come from any identity provider |
| `none` | nobody: every caller is anonymous |

What carries over from 0.1.x:

- **Same parent domain.** First-party apps under one registrable domain can
  share a Better Auth session with `crossSubDomainCookies` and a
  `cookiePrefix`; `trustedOrigins` is the auth-flow trust list, not CORS.
- **Customer domains.** Cookies never cross registrable domains. A customer
  site runs its own OAuth/OIDC flow against the identity provider and keeps
  its own session; with `identity: custom` its resolver maps that session to a
  `Caller`.
- **API and MCP authorization** is the same `requires` and guard everywhere;
  see [Guarded API access](examples/guarded-api.md).

The standalone hosted-auth and Landing provisioning flow from 0.1.x is absent
in 0.2.0. A Mantle Cloud tenant uses Cloud's managed identity/storage contract;
Cloud project membership does not grant tenant staff access. See
[Authentication](handbook/cloudflare/authentication.md) and
[Authorization](handbook/concepts/authorization.md).
