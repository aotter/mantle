---
name: provision
description: Ship a Mantle 0.2 project to production — Cloudflare Workers with D1, production sign-in and secrets, or ChatGPT Sites through its guide — and verify the deployed service.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/provision/SKILL.md
  applies_to: mantle 0.2
  projection: package
  projectionReason: Creates remote resources and handles production secrets; opt-in only.
---

# Provision a Mantle project

Provision only after the user asks to create remote resources or ship. Read the
installed `docs/handbook/cloudflare/deploy-and-operate.md` and
`docs/handbook/cloudflare/authentication.md` first.

## Choose the target

Ask which target, unless the project already shows one.

| Target | Config | Follow |
|---|---|---|
| Cloudflare Workers | `wrangler.jsonc` | the rest of this skill |
| ChatGPT Sites | the Site's hosting config | installed `docs/handbook/cloudflare/chatgpt-sites.md`; publish through Sites, never `wrangler deploy` |
| Mantle Cloud | — | not available for 0.2 services yet; the plugin's `mantle` skill says when it is |

Self-hosting is always an option; never present a hosted target as required.

## Local gate

```bash
pnpm install --frozen-lockfile
pnpm exec mantle generate --check
pnpm exec tsc --noEmit
git status --short
```

Confirm the active Cloudflare account with the user before creating anything.

## Cloudflare

1. **Database.** `pnpm exec wrangler d1 create <name>` and put the
   `database_id` into `wrangler.jsonc`'s `d1_databases[0]`, keeping the
   binding `DB`. An existing 0.1.x database is never reused: 0.2 starts on a
   new one.
2. **Origin.** Set `PUBLIC_ORIGIN` in `vars` to the deployed HTTPS origin.
   Update it together with any OAuth callback when a custom domain is added.
3. **Sign-in (identity `mantle`).** Choose one production method and edit
   `src/service.ts`; never deploy `ConsoleEmailSender`:
   - **Email OTP or magic link** with the application's own `EmailSender`
     over its email provider, `bootstrapOwner: { match: "email", value }`.
   - **GitHub**: `{ kind: "social", provider: "github", options: { clientId, clientSecret } }`
     and `bootstrapOwner: { match: "github-login", value }`. The user creates a
     GitHub OAuth App with callback `<PUBLIC_ORIGIN>/api/auth/callback/github`.
   Remove the preset's loopback-only check once the method is real.
4. **Secrets.** Never in chat, files or logs. Use a connector, or hidden
   input:

```bash
openssl rand -hex 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
read -rsp "GitHub client secret: " S && printf '%s' "$S" | pnpm exec wrangler secret put GITHUB_CLIENT_SECRET; unset S
```

   Set `BETTER_AUTH_SECRET` once; rotating it signs everyone out.
5. **Optional bindings.** R2 for media only when asked
   (`docs/handbook/cloudflare/media-r2.md`).
6. **Deploy.** `pnpm exec wrangler deploy`. The first request creates the
   tables. Later Schema changes: run
   `mantle generate --check --database <local SQLite file>` (local D1 under
   `.wrangler/state/v3/d1/`) before each deploy and resolve any blocked change
   by hand.

Commit and push only non-secret changes.

## Verify the deployed service

- A public View and an HTTP Trigger answer.
- Sign-in works with the production method; the owner gets
  `GET /admin/api/me` → `owner`, a second account gets 403.
- `/mcp` answers `tools/list`, and an anonymous call to a protected tool is
  401 with a `WWW-Authenticate` challenge.
- Every enabled schedule appears in the Worker's cron triggers.

## Handoff

Return the public origin, the sign-in method and who the owner is, the MCP
URL (`<origin>/mcp`), the resources created or reused, and anything deferred.

## Don't

- Don't create remote resources before the user asks to ship.
- Don't commit secrets or put them in `wrangler.jsonc` `vars`.
- Don't point a 0.2 service at a 0.1.x database.
- Don't patch `site_config` or `_mantle_*` tables; boot owns them.
