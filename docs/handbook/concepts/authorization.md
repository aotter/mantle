# Authorization

The app verifies credentials and supplies a `Caller` from `@aotter/mantle/contracts`:

- Anonymous: `{ kind: 'anonymous' }`.
- User: `kind`, stable opaque `subject`, optional `issuer`, `role: string | null`, `admin?: boolean`, `scopes`, `credential`, `credentialId` and `clientId`. Credentials are session, OAuth, API key or personal token; never put raw credentials in the Caller.
- System: `{ kind: 'system', reason }`, constructed only by trusted application code for maintenance. Request data cannot grant system authority.

Resolve once per request. Invalid presented credentials must fail; do not downgrade them to anonymous. Use `checkOrigin(request, caller)` for cookie-session mutations; generated boundaries enforce it too. Keep response cookie headers from `resolveCaller` so sessions can slide.

## Operations and rows

View/Procedure `requires.auth.all` gates invocation. `ctx.user` / `ctx.auth` require a user; `ctx.admin` requires the admin layer; `ctx.auth.scope` checks a scope. Which admin role may call which target is application code, decided before the call. [Requirements](../reference/authorization.md) lists the vocabulary. Store collections do not check these operation gates: authorize before using Store.

The compiler adds row policy to every Schema relation, including joins and nested SQL. Scope limits a user to their subject or to their [user field](../reference/authorization.md#user-fields) values and gives anonymous callers no scoped rows. System calls bypass scope. TTL hides expired rows. Public Views see only published rows on publishing Schemas; caller reads expose drafts only to admin/system. Translations also retain parent visibility.

Field `scope` hides rows even from admin callers; use View/Procedure [`restrict`](../reference/view.md#restrict) to limit member access while Admin collection reads see all rows allowed by the Schema's scope.

The app owns custom identity and roles. Better Auth’s admin plugin `adminRoles` (default `["admin"]`) classifies comma-separated `user.role` values. `resolveCaller` carries this layer as `admin`; `isAdmin(caller)` and `hasAdminRole(caller, name)` consult it. Application-owned resolvers mint the original Caller with `userCaller` from `@aotter/mantle/user-fields`, using only a verified user and the identity provider’s adminRoles. Setting `admin: true` on a plain object grants no privilege. Member role names alone do not grant privilege. Optional [Better Auth](../cloudflare/authentication.md) helpers use fresh primary authority by default. Admin additionally requires an admin cookie session. UI visibility never replaces a server authorization check.
