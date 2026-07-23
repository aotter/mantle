---
name: provision
description: Ship a local or Mantle landing-generated project to Cloudflare and finish production auth. Use when a Mantle project is ready for GitHub, Cloudflare deployment, self-hosted GitHub OAuth, paid Mantle hosted auth verification, production smoke testing, or operator handoff.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/provision/SKILL.md
  applies_to: mantle@v0.1.0
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

## Get a Live Worker URL

Choose the path from observed state.

### Local project

Before creating anything, confirm the user wants the project pushed and
deployed.

1. Create a private repository in the user's chosen GitHub account or
   organization with an available GitHub connector. Use `gh` only when it is
   already authenticated.
2. Commit the generated project, add the confirmed remote, and push `main`.
3. Confirm the Cloudflare account, then prefer an available Cloudflare
   connector. Otherwise run `pnpm exec wrangler login` with the user's
   agreement and deploy with:

```bash
pnpm deploy
```

4. Capture the resulting `https://<worker>.<account>.workers.dev` URL. Write it
   to `PUBLIC_ORIGIN` in `wrangler.toml` and `Public site:` in `AGENTS.md`,
   then commit and push the non-secret changes.

Connecting Cloudflare Workers Builds to GitHub is optional after the direct
deploy; do not block the first live Worker on CI setup.

### Mantle landing project

Landing already created the private GitHub repo and started the first
Cloudflare build. Verify that build and capture the live Worker URL. Do not
create another repo or Worker.

The public site should respond before staff auth is configured. Auth-gated
routes may return `503 setup_incomplete`.

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

Verify that admin sign-in redirects to Mantle Platform and Staff MCP
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
