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
  oauthProvider: { loginPage: "/admin/sign-in", consentPage: "/admin/oauth/consent", scopes: ["mcp"], mcpResource: `${origin}/mcp` },
});
```

`consentPage` is Admin's consent page when the service mounts Admin (the
preset does); without Admin it is `/oauth/consent`, the plain page
`createAuthRoutes` serves. Both post the decision to `/oauth/consent`.

then `createCallerResolver(auth, { jwtBearer: { audience: `${origin}/mcp`, scopes: ["mcp"] } })`,
`createAuthRoutes(auth, { resolver })` and an `AdminIdentity` over the auth's
own methods. With dialect `postgres` the preset passes `database:
pgPool(connect), driver: pgDatabaseDriver(connect)` over Hyperdrive; host `bun`
passes `bunAuthDatabase(sql)` and `bunDatabaseDriver(sql)` (or the bun:sqlite
`Database` and `bunSqliteDriver(db)`), with `ipAddressHeaders:
["x-mantle-client-ip"]`, which its entry sets from the socket.

### Local sign-in

Install auth and MCP dependencies at the versions declared in the installed
Core package's `peerDependencies`; the generator prints a versioned install
command and refuses incompatible installed peers before writing generated files.
The preset owns convergence; a normal fresh local database needs no manual auth
migration. `auth.ready` initializes Better Auth's context; auth tables are prepared
lazily before authenticated operations. Mantle runs Better Auth's explicit schema
validation after that preparation, including when the schema ledger is current;
an incompatible existing schema still rejects authentication.

#### Upgrading an existing 1.7.0–1.7.2 auth database

Those Better Auth versions created a required `account.issuer` column that
1.7.7 no longer writes. Automatic additive convergence preserves that column;
it cannot make a required unused column safe for future inserts. Before starting
the upgraded service, the database owner must migrate this legacy constraint.
Fresh databases need no such step.

For PostgreSQL, first inspect the service's own database/schema and back it up:

```sql
SELECT table_schema, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'account' AND column_name = 'issuer';
```

If the legacy column is required and has no default, apply this in the service's
auth schema (the example assumes it is selected by `search_path`):

```sql
BEGIN;
ALTER TABLE "account" ALTER COLUMN "issuer" DROP NOT NULL;
COMMIT;
```

This retains every row and existing issuer value. It changes only the obsolete
constraint; new accounts may leave that column null. Restart the service after
the migration so Better Auth checks the repaired schema in a fresh context.
Verify existing users, roles, sessions and content rows, then sign in again.
Do not drop auth tables or disable schema validation. This applies to native Bun
PostgreSQL and Cloudflare/Hyperdrive PostgreSQL alike.

For D1/SQLite, `ALTER COLUMN` is unavailable. Use a database-owner-reviewed table
rebuild that retains every column/value, index and foreign-key relationship while
making the legacy issuer nullable; do not run the PostgreSQL statement there.
See Better Auth's [1.7 upgrade guide](https://www.better-auth.com/docs/guides/1-7-upgrade-guide).
Mantle's portable auth facade does not silently perform engine-specific table
rebuilds or remove historical fields.

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

On Bun, copy `.env.example` to `.env`, set `PUBLIC_ORIGIN=http://127.0.0.1:3000`
and run `bun src/index.ts`; send the same HTTP requests to port 3000. Codes print
to the Bun console. Normalize test email addresses to lowercase when matching
that output. Treat codes and session cookies as secrets in test logs.

Local clients share the loopback socket IP and therefore share sign-in limits.
Multi-user smoke tests must respect the retry window (HTTP 429) rather than
spoofing forwarding headers or disabling production limits. `rateLimit: {
window: 60, max: 100 }` changes the general quota, but plugin-specific OTP limits
still apply; changing it is not a way to bypass those limits.

### MCP clients for members

`/admin/sign-in` suits staff. When members connect an MCP client to the public
`/mcp`, set `loginPage` to the service's own sign-in page. That page must
continue the authorization: Better Auth sends the browser there with the
request signed, and the sign-in carries it back as `oauth_query`, then follows
the `url` it answers (consent) instead of the page's own destination:

```ts
import { signedOAuthQuery } from "@aotter/mantle-ui/kit";

const oauthQuery = signedOAuthQuery(window.location.search);
const res = await fetch("/api/auth/sign-in/email-otp", { method: "POST", credentials: "include",
  headers: { "content-type": "application/json" }, body: JSON.stringify({ email, otp, ...(oauthQuery ? { oauth_query: oauthQuery } : {}) }) });
const { url } = await res.json();
location.assign(url ?? "/account");
```

Dynamic client registration takes a client that names no `application_type`
and registers only `http` loopback redirects (`localhost`, `127.0.0.1`,
`[::1]`) as `native` (RFC 8252), which is how local MCP clients register; any
other registration is checked as Better Auth checks it (`web` needs `https` on a
non-loopback host).

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
included, and the email codes still pending for its address. Never delete auth
rows with SQL. To require a recent sign-in first, compare
`(await auth.getSession(request)).session.createdAt` with the current time.

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
