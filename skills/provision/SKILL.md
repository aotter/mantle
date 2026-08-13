---
name: provision
description: Ship a local or Mantle landing-generated project to Cloudflare and finish production auth. Use when a Mantle project is ready for GitHub, Cloudflare deployment, self-hosted GitHub OAuth, paid Mantle hosted auth verification, production smoke testing, or operator handoff.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/provision/SKILL.md
  applies_to: mantle grammar v0.1
---

# Provision a Mantle Project

Local cold start deliberately stops before this skill. Provision only after the
user asks to create remote resources or ship production.

## Source of Truth

1. Read `.mantle/launch-state.json`, `.mantle/handoff.md`, `wrangler.toml`,
   and the current git remotes.
2. Read installed `@aotter/mantle*` versions from `package.json`.
3. Use matching embedded docs under `node_modules/@aotter/mantle/docs/`.
4. Never infer provider authority from launch state. Confirm the active GitHub
   and Cloudflare accounts before changing them.

Run the local gate first:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm typecheck
git status --short
```

## Resume From Observed State

Do not branch on how the project was created. Verify these facts and skip
completed work:

1. `git remote get-url origin` confirms the GitHub repo.
2. An HTTPS `PUBLIC_ORIGIN` that responds confirms the Cloudflare deploy.
3. `/admin/sign-in` returning `503 setup_incomplete` means auth is not bound.
   Use the recorded auth intent only to choose hosted or self-hosted setup;
   live behavior is authoritative.

If there is no remote, confirm the target account, create a private repo,
commit, and push `main`. If there is no live Worker, confirm the Cloudflare
account, prefer an available connector, or use `pnpm exec wrangler login` with
the user's agreement, then run `pnpm deploy`.

Capture the live URL in `PUBLIC_ORIGIN` and `Public site:` in `AGENTS.md`, then
commit and push non-secret changes. Reuse any repo or Worker already created
by landing. Workers Builds is optional after a direct deploy.

When the owner later adopts a custom domain, update `PUBLIC_ORIGIN` and the
provider's OAuth callback together, then redeploy. Do not patch `site_config`
directly; boot syncs its canonical origin from `PUBLIC_ORIGIN`.

## Choose Auth

- **Self-hosted — free:** configure the owner's per-site GitHub OAuth App and
  Worker secrets using the steps below.
- **Mantle hosted auth — paid:** use only when the landing handoff records a
  hosted allocation and client configuration. Mantle Platform operates the
  identity provider; do not ask the user for a per-site GitHub OAuth App.

Do not claim that hosted auth can attach to an arbitrary local repo unless the
current Mantle landing flow explicitly supplies that handoff.

For the exact boundary, read
`node_modules/@aotter/mantle/docs/auth-hosting-model.md`.

## Self-hosted Auth

1. Ask the user to create a GitHub OAuth App:

- Homepage URL: `<worker-url>`
- Authorization callback URL: `<worker-url>/api/auth/callback/github`
- Device Flow: unchecked

2. Put non-secret values in `wrangler.toml`:

- `PUBLIC_ORIGIN`
- `GITHUB_CLIENT_ID`
- `ADMIN_GITHUB_LOGIN`
- correct Worker `name`

3. Keep the Client Secret out of chat. Prefer a Cloudflare connector for
   secrets; otherwise use hidden shell input:

```bash
read -rsp "GitHub OAuth client secret: " MANTLE_GITHUB_CLIENT_SECRET && printf "\n"
printf '%s' "$MANTLE_GITHUB_CLIENT_SECRET" | pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
openssl rand -hex 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
unset MANTLE_GITHUB_CLIENT_SECRET
```

Set `BETTER_AUTH_SECRET` once and preserve it. Rotating it invalidates existing
sessions.

4. Commit and push only non-secret config, then redeploy:

```bash
git add wrangler.toml AGENTS.md
git commit -m "mantle: wire production auth"
git push
pnpm deploy
```

## Hosted Auth

Follow the landing handoff and generated client configuration. Hosted
configuration remains in landing-managed Cloudflare Worker bindings; do not
write client secrets into `wrangler.toml`.

Verify that admin sign-in redirects to Mantle Hosted Auth and Staff MCP
authenticates, then skip the self-hosted flow.

## Smoke Test

- public home route;
- `/admin/sign-in`;
- selected admin sign-in path;
- `/mcp/staff` with an agent client when available;
- one type-specific core workflow.

Media uploads are optional. Configure R2 only when the owner asks for
staff-managed files; then read
`node_modules/@aotter/mantle/docs/media-uploads.md`.

## Handoff

Return:

- public URL;
- admin sign-in URL;
- Staff MCP URL;
- operator setup URL:
  `https://mantle.tools/connect?site=<url-encoded-worker-url>`;
- remote resources created or reused;
- auth mode and any intentionally deferred setup.

## Don't

- Don't create remote resources before the user asks to ship.
- Don't ask for a Cloudflare API token in the base flow.
- Don't commit provider secrets.
- Don't require R2 for first production.
- Don't invent a second provision orchestrator.
- Don't use `/admin/auth/github/callback`; the callback is
  `/api/auth/callback/github`.
