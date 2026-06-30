# @aotter/mantle-cloudflare

Cloudflare Workers adapter for mantle.

This package mounts the runtime on Hono, implements the runtime ports against
Cloudflare D1 / KV / Workers assets, and owns Better Auth wiring for GitHub
OAuth plus MCP OAuth/DCR.

`0.0.7-alpha` is an early prerelease for the agent-provisioning proof. The API
surface remains in flux until `v0.1.0`.

## Better Auth Boundaries

`createAuth()` exposes curated Better Auth configuration fields, not a
generic Better Auth passthrough. The hosted-auth and self-hosted-auth
product boundary is documented in
[`docs/auth-hosting-model.md`](../../../docs/auth-hosting-model.md).

For trusted first-party apps that share one parent domain, configure
same-parent-domain cookies explicitly:

```ts
const auth = createAuth({
  database: env.DB,
  baseURL: "https://platform.mantle.tools",
  secret: env.BETTER_AUTH_SECRET,
  methods,
  trustedOrigins: ["https://mantle.tools", "https://www.mantle.tools"],
  cookiePrefix: "mantle-platform",
  crossSubDomainCookies: {
    enabled: true,
    domain: "mantle.tools",
  },
});
```

Use `crossSubDomainCookies` only when the same party controls every
participating subdomain. For a customer-owned domain such as
`customer.com`, use an OAuth/OIDC broker flow instead of shared cookies.

## Optional R2 Media Uploads

R2-backed staff media uploads are adapter-specific post-launch work, not part
of the Core SDK skill contract or Day 1 landing path. Use the Cloudflare recipe
only when a site actually needs staff-managed images or files:

<https://raw.githubusercontent.com/aotter/mantle/develop/docs/media-uploads.md>
