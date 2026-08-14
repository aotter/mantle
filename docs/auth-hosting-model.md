# Auth Hosting Model

Mantle treats authentication as a runtime capability, not a paywall on
basic login. The split is:

- **Mantle SDK** gives every generated site the primitives needed to
  run its own auth.
- **Mantle's conventional Cloudflare adapter** runs the generated site's
  selected self-hosted or Mantle Platform hosted client configuration.
- **Mantle starters** declare the mode and provider placeholders that landing
  or the site owner completes.
- **Mantle Platform** can sell hosted identity, provider setup, email,
  and billing convenience for site owners who do not want to operate
  those pieces.

This document is the source of truth for the product and SDK boundary.
Do not duplicate this model in starter handoff copy or landing prose;
link here and keep downstream docs short.

## Free Self-Hosted Auth

A free Mantle site can run every login method the SDK exposes through
`createAuth()`:

- social OAuth providers supported by Better Auth;
- generic provider-specific options through the `social.extras` shape;
- email OTP;
- magic link;
- passkey or additional Better Auth method support when the SDK adds a
  curated first-class field for it;
- first-party same-domain or same-parent-domain SSO when the site owner
  controls every participating subdomain.

The site owner supplies their own provider client ids/secrets,
transactional email sender, DNS, cookie policy, and operational
maintenance. Mantle must not block self-hosted login behind a paid
feature flag.

## Hosted Platform Auth

Paid hosted auth is a convenience and operations product. The value is
that Mantle Platform can:

- hold OAuth provider configuration;
- hold email provider credentials;
- send OTP and magic-link email;
- manage deliverability and provider rotation;
- register generated sites as clients;
- check billing/license entitlements before hosted capabilities are
  enabled;
- expose a stable hosted identity broker for generated sites.

The generated site still owns local grants, member records, content,
orders, forms, and legal copy. Platform returns identity. The site maps
that identity into `ctx.user`, `ctx.staff`, and its own grant model.

## Same Parent Domain SSO

When the apps share a parent domain that the same party controls, SSO
can use browser cookies:

```ts
createAuth({
  // ...
  trustedOrigins: ["https://mantle.tools", "https://www.mantle.tools"],
  cookiePrefix: "mantle-platform",
  crossSubDomainCookies: {
    enabled: true,
    domain: "mantle.tools",
  },
});
```

Use this only for a trusted first-party app family, for example
`platform.mantle.tools` and `mantle.tools`.

`cookiePrefix` is required whenever more than one Better Auth app can
write cookies under the same parent domain. Without it, Platform and
Landing can overwrite each other's default Better Auth cookie names.

`trustedOrigins` is a Better Auth auth-flow trust list. It is not a
general API CORS policy and must not be documented as one.

## Customer Domain SSO

Shared cookies do not work across different registrable domains:

```text
platform.mantle.tools  ->  customer.com
```

Browsers will not send a `mantle.tools` cookie to `customer.com`. For a
customer-owned domain, hosted auth must use OAuth/OIDC:

```text
customer.com/login
  -> platform.mantle.tools/oauth/authorize
  -> user signs in with Platform-supported methods
  -> customer.com/api/auth/callback/mantle
  -> customer.com verifies the authorization response
  -> customer.com creates its own local session
```

That local session is the customer's site session. Platform remains the
identity broker and entitlement authority; it does not become the
customer site's member database or authorization system.

## Landing Provisioning Split

Landing should branch before GitHub or Cloudflare side effects:

- **Continue free**: commit a self-hosted auth-ready site with docs,
  env placeholders, and the user's own provider setup path.
- **Use hosted auth**: check Platform entitlement, register the site as
  a Platform auth client, and commit the generated site's Platform auth
  client config.

Landing can probe Platform staff/session state, but provisioning's
GitHub OAuth token is still Landing-owned unless a separate token
handoff design is introduced.

The conventional hosted-auth client wiring belongs in Core's Cloudflare
adapter. Starters declare its environment bindings; landing supplies an
allocated client. A site can still replace Auth construction through
`createMantleWorker({ auth })` when it needs a different curated identity
design. Core continues to own the normalized manifest/runtime credential
vocabulary (`ctx.user`, `ctx.staff`, `ctx.auth`) and guard orchestration.

## API and MCP Authorization

Login hosting and business API authorization are related but separate. Core
provides a normalized verified-credential context (`ctx.auth`), closed scope
predicates, one Cloudflare consumer credential resolver seam, and a
Procedure-backed guard that REST and MCP both execute. A generated site owns
API keys, personal tokens, grants, transactions, subscriptions, and the guard
handler that checks current business state.

Mantle Platform may be the identity or OAuth token authority for a hosted
flow. That does not make token claims the generated site's live membership or
entitlement authority. The target site's guard reads its authoritative state
on every call. See [API and MCP authorization](api-mcp-authorization.md) for
the exact public API and four consumer examples.

## SDK Surface Rule

Mantle should expose Better Auth knobs only as curated first-class
fields when there is a real Mantle use case. Do not add a generic
`betterAuthOptions` or `advanced` passthrough.

The current first-party SSO use case justifies these optional fields on
`CreateAuthConfig`:

- `trustedOrigins`
- `crossSubDomainCookies`
- `cookiePrefix`

The cross-site API use case additionally justifies these curated fields and
facades:

- generic OAuth method `resource`
- OAuth provider `validAudiences`
- `Auth.getProviderAccessToken(request, providerId)`
- `Auth.verifyOAuthAccessToken(tokenOrRequest, { audience, scopes })`

All are additive. Existing generated sites that do not pass them keep their
previous cookie, session, and REST behavior. These are not a raw Better Auth
options passthrough.
