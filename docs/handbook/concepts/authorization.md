# Authorization

The app verifies credentials and supplies a `Caller` from `@aotter/mantle/contracts`:

- Anonymous: `{ kind: 'anonymous' }`.
- User: `kind`, stable opaque `subject`, optional `issuer`, `role: string | null`, `scopes`, `credential`, `credentialId` and `clientId`. Credentials are session, OAuth, API key or personal token; never put raw credentials in the Caller.
- System: `{ kind: 'system', reason }`, constructed only by trusted application code for maintenance. Request data cannot grant system authority.

Resolve once per request. Invalid presented credentials must fail; do not downgrade them to anonymous. Use `checkOrigin(request, caller)` for cookie-session mutations; generated boundaries enforce it too. Keep response cookie headers from `resolveCaller` so sessions can slide.

## Operations and rows

View/Procedure `requires.auth.all` gates invocation. `ctx.user` / `ctx.auth` require a user; `ctx.staff` accepts only the generated OSS role `staff`; `ctx.auth.scope` checks a scope. [Requirements](../reference/authorization.md) lists the vocabulary. Store collections do not check these operation gates: authorize before using Store.

The compiler adds row policy to every Schema relation, including joins and nested SQL. Scope limits a user to their subject and gives anonymous callers no scoped rows. System calls bypass scope. TTL hides expired rows. Public Views see only published rows on publishing Schemas; caller reads expose drafts only to staff/system. Translations also retain parent visibility.

The app owns custom identity and roles. Optional [Better Auth](../cloudflare/authentication.md) helpers use fresh primary authority by default. Admin additionally requires a staff cookie session. UI visibility never replaces a server authorization check.
