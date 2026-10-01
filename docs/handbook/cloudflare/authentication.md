---
description: Sign-in for a Mantle 0.2.0 service — the three identity choices, createMantleAuth with email OTP, social and OAuth methods, the first owner, roles, production senders, and a custom CallerResolver.
---
# Authentication

Mantle never owns your users. Choose once, in `mantle.config.json`:

| `identity` | Callers come from | Auth tables |
|---|---|---|
| `mantle` | `@aotter/mantle/auth`: Better Auth sign-in, staff roles, an OAuth server for MCP | Better Auth's, migrated by Better Auth |
| `custom` | your `src/identity.ts`, a `CallerResolver` over your own sessions or tokens | none |
| `none` | nobody: every caller is anonymous | none |

A rerun of `mantle generate` cannot switch identity. Admin needs `mantle` or
`custom`.

## Identity `mantle`

The generated `src/service.ts` builds the auth from `env`:

```ts
createMantleAuth({
  database: env.DB, driver: d1Driver(env.DB), baseURL: origin, secret: env.BETTER_AUTH_SECRET,
  methods: [{ kind: "email-otp", sender: new ConsoleEmailSender() }],
  bootstrapOwner: { match: "email", value: env.ADMIN_EMAIL },
  ipAddressHeaders: ["cf-connecting-ip"],
  oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/oauth/consent", scopes: ["mcp"], mcpResource: `${origin}/mcp` },
});
```

then `createCallerResolver(auth, { jwtBearer: { audience: `${origin}/mcp`, scopes: ["mcp"] } })`,
`createAuthRoutes(auth, { resolver })` and an `AdminIdentity` over the auth's
own methods.

### Local sign-in

```sh
cp .dev.vars.example .dev.vars   # ADMIN_EMAIL, a random BETTER_AUTH_SECRET, PUBLIC_ORIGIN=http://127.0.0.1:8787
pnpm exec wrangler dev --local
curl -X POST http://127.0.0.1:8787/api/auth/email-otp/send-verification-otp \
  -H 'content-type: application/json' -H 'origin: http://127.0.0.1:8787' \
  -d '{"email":"you@example.com","type":"sign-in"}'
```

`ConsoleEmailSender` prints the code to the wrangler log; post it to
`/api/auth/sign-in/email-otp` with `{ email, otp }` to get a session cookie.
The preset prints codes only when `PUBLIC_ORIGIN` is set to a loopback `http:`
origin and both secrets exist. Otherwise it uses
`createSetupIncompleteAuth`, which refuses sign-in with a message, so a
deployed service never prints codes to its log.

### Production

Replace the local choices in `src/service.ts`:

- **A real sender.** Implement `EmailSender` (`send({ to, subject, text, html?, locale, category? })`)
  over your provider, and pass it to the email method. Drop the loopback check
  once the sender is real.
- **Secrets.** `wrangler secret put BETTER_AUTH_SECRET` (32+ random bytes) and
  `wrangler secret put ADMIN_EMAIL`; set `PUBLIC_ORIGIN` to the deployed origin
  in `vars`.
- **Methods.** `methods` takes any mix:

```ts
methods: [
  { kind: "email-otp", sender },
  { kind: "magic-link", sender },
  { kind: "social", provider: "google", options: { clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET } },
  { kind: "oauth", displayName: "Company SSO", options: { providerId: "sso", discoveryUrl: …, clientId: …, clientSecret: … } },
]
```

`options` is Better Auth's own configuration for that method, passed through.
`appleClientSecret` builds Apple's signed client secret. `GET /api/auth/methods`
lists what the service offers, for your sign-in page.

Other options: `rateLimit`, `trustedOrigins`, `cookiePrefix`,
`crossSubDomainCookies` (first-party apps under one parent domain),
`accountLinking` (passed to Better Auth; by default a social sign-in links to
an existing row only when the provider verified the email and the local row is
verified), `staffInvitationSender`, `sessionCache`, and raw Better Auth
`plugins`.

### The first owner and roles

`bootstrapOwner: { match: "email", value }` (or `{ match: "github-login", value }`)
makes the first matching sign-in the `owner`. Staff roles are `owner`,
`editor` and `contributor`; a user without one is a member. Owners manage staff
through Admin's API (`/admin/api/staff`, `/staff/invitations`), which calls
Better Auth's admin API with the owner's own request. The resolver reads the
role on every request, so a revoked role takes effect at once.

### Account deletion

`auth.deleteUser(userId)` deletes a user through Better Auth, sessions
included. Never delete auth rows with SQL.

## Identity `custom`

`src/identity.ts` exports `resolveCaller: CallerResolver`. It throws until you
implement it, so a request fails loudly instead of running as anonymous.

```ts
export const resolveCaller: CallerResolver = async (request) => {
  const token = request.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token) return { caller: { kind: "anonymous" } };   // nothing presented
  const user = await verifyMyToken(token);                // your own auth
  if (!user) return { invalid: true };                    // presented and bad: 401, never anonymous
  return { caller: {
    kind: "user", subject: `myapp:${user.id}`, role: user.isAdmin ? "owner" : null,
    scopes: user.scopes, credential: "oauth", credentialId: user.tokenId, clientId: null,
  } };
};
```

- `subject` is stable and unique across every issuer you accept; namespace it
  when there are several. Never use an email.
- Map your roles onto `owner`, `editor` and `contributor`, or leave `role`
  `null` and authorize with scopes and guards.
- Admin gets no `identity` with `custom`, so it hides user management.
  Implement `AdminIdentity` (`directory`, `roles`, `deleteUser`, each optional)
  from `@aotter/mantle/admin` to show it.

[Mantle on ChatGPT Sites](./chatgpt-sites.md) is a worked `custom` identity.

## Further reading

- [Authorization](../concepts/authorization.md)
- [MCP and agents](../concepts/mcp-and-agents.md): OAuth for MCP clients
