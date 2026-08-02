---
name: provision
description: Ship a Mantle site to Cloudflare and finish production auth using the generated project's existing configuration.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/provision/SKILL.md
  applies_to: mantle@v0.1.0
---

# Provision a Mantle Site

Provision only after the user asks to create remote resources or ship.

## Observe first

Read `.mantle/launch-state.json`, `.mantle/handoff.md`, `wrangler.jsonc`,
`package.json`, and git remotes. Confirm active GitHub and Cloudflare accounts;
launch metadata is not provider authority.

```bash
pnpm install --frozen-lockfile
pnpm exec mantle generate --check
pnpm validate
pnpm typecheck
pnpm check
git status --short
```

Reuse existing resources. A confirmed remote means GitHub is done; an HTTPS
`PUBLIC_ORIGIN` that responds means a Worker exists; `/admin/sign-in` returning
`503 setup_incomplete` means only auth setup remains.

If required and authorized, create a private repository, push `main`, create
the declared Cloudflare bindings, run the project's deploy command, and record
the live URL in the project-owned handoff/config. Do not invent a second
provision orchestrator.

## Auth

- **Self-hosted:** the owner creates a per-site GitHub OAuth App. Homepage is
  the Worker URL; callback is
  `<worker-url>/api/auth/callback/github`; Device Flow stays off. Put public
  identifiers/origin in `wrangler.jsonc`, and store
  `GITHUB_CLIENT_SECRET` plus a stable `BETTER_AUTH_SECRET` with Wrangler
  secrets. Never commit or echo secrets.
- **Mantle hosted auth:** use only a Landing handoff that includes a hosted
  allocation/client. Keep secrets in Landing-managed bindings and verify the
  redirect to Mantle Platform. Do not ask for a per-site GitHub OAuth App.

Read the installed version's `docs/auth-hosting-model.md` for the exact
boundary. Preserve `BETTER_AUTH_SECRET`; rotation invalidates sessions.

## Smoke and handoff

Verify the public page, `/admin/sign-in`, the selected sign-in path,
`/mcp/staff` when an agent client is available, and one archetype-specific
workflow. Configure R2 only when staff-managed media is requested.

Return the public, admin, Staff MCP, and operator connect URLs; resources
created/reused; auth mode; checks; and intentionally deferred setup. Never
claim success from config alone—exercise the live routes.
