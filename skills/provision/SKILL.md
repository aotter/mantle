---
name: mantle provision
description: Finish production deployment for an installed Mantle consumer project. Use after the install skill has produced a standalone project and the user wants the service online through their own GitHub and Cloudflare accounts.
when_to_invoke: |
  Project exists, `pnpm validate` + `pnpm typecheck` pass, the scaffold is ready to push to GitHub, and the user wants a production Cloudflare Worker.
applies_to: mantle@v0.1.0
---

# Provision a Mantle Project

You're taking an installed consumer project from local files to a
user-owned GitHub repo and Cloudflare Worker.

The base flow is deterministic first, provider-browser second:

1. The coding agent validates the scaffold and pushes a private GitHub
   repo.
2. The user creates the first Cloudflare Worker deploy from that GitHub
   repo in Cloudflare Dashboard. Cloudflare owns automatic first-deploy
   resource provisioning for id-less bindings.
3. The user reports the deployed Worker URL back to the agent.
4. The user creates the per-site GitHub OAuth App.
5. The agent runs `pnpm run provision:up` to write non-secret config,
   set Worker secrets through Wrangler, and update local handoff files.

Mantle landing is not the executor. It provides launch context and a
handoff; provider authority stays with the user and their coding agent.

Do deterministic work before interrupting the user. When provider UI is
required, give one exact browser task at a time: link, button path,
expected result, and what value the user should report back.

## End State

- The scaffold is committed and pushed to the user's private GitHub repo.
- Cloudflare has deployed the Worker from that repo at least once.
- `wrangler.toml` contains `PUBLIC_ORIGIN`, `GITHUB_CLIENT_ID`,
  `ADMIN_GITHUB_LOGIN`, and the correct Worker name.
- Worker secrets are set: `GITHUB_CLIENT_SECRET`,
  `BETTER_AUTH_SECRET`, and optional feature/provider secrets.
- `AGENTS.md` `Public site:` points at the deployed Worker URL.
- Staff MCP and browser admin sign-in are ready to test.
- Operator setup URL is ready to hand to the owner:
  `https://mantle.tools/connect?site=<url-encoded-worker-url>`.

Provision does not seed production content. First real content is
created after owner sign-in through Staff MCP / admin authoring.

## Principles

1. Use the user's accounts. The repo belongs to the user's GitHub
   account or org. The Worker belongs to the user's Cloudflare account.
2. Do not ask for a Cloudflare API token in the base flow. Cloudflare
   Dashboard plus Workers Builds handle the first deploy; Wrangler
   handles secrets after the user logs in.
3. GitHub OAuth is per-site and user-owned. The callback URL is exactly
   `<worker-url>/api/auth/callback/github`.
4. Launch state is context, not provider authority. `.mantle/launch-state.json`
   may supply owner, admin login, repo name, locales, archetype, theme,
   and selected features. It does not authorize Cloudflare operations,
   billing-gated features, OAuth secrets, or custom domains.
5. `BETTER_AUTH_SECRET` is load-bearing. Preserve an existing secret;
   rotating it invalidates sessions.

## Flow

Run from the generated project root.

1. Preflight:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm typecheck
if node -e "process.exit(require('./package.json').scripts?.test ? 0 : 1)"; then
  pnpm test
else
  echo "No pnpm test script; skipping."
fi
git status --short
gh auth status
```

If GitHub CLI auth is missing or points at the wrong login, pause and
ask the user to switch/login before creating the repo.

2. Create a private GitHub repo in the selected owner, add the remote,
   commit the scaffold, and push. Use the user's GitHub auth context.

3. Print the deterministic browser plan:

```bash
pnpm run provision:plan
```

4. Hand the user directly to Cloudflare's Git import path:

```text
https://dash.cloudflare.com/?to=%2F%3Aaccount%2Fworkers-and-pages
```

Ask them to create a Worker from the pushed GitHub repo, keep the Worker
name equal to `wrangler.toml` `name`, wait for deploy, and send back the
live `*.workers.dev` URL. Ask for the Worker name only if Cloudflare
forced a name different from the repo/project name.

5. After the Worker URL is known, print the worker-specific plan:

```bash
pnpm run provision:plan -- --worker-url <worker-url>
```

Read only the values needed for the current project. Do not dump
internal notes or placeholder syntax onto a non-coder.

6. Ask the user to create the per-site GitHub OAuth App after the Worker
   URL is known:

- Homepage URL: `<worker-url>`
- Authorization callback URL: `<worker-url>/api/auth/callback/github`
- Device Flow: unchecked

Ask for the Client ID in chat. Keep the Client Secret out of chat and
pass it through the hidden shell prompt below.

7. Authorize Wrangler and apply provision:

```bash
pnpm exec wrangler login
read -rsp "GitHub OAuth client secret: " GITHUB_CLIENT_SECRET && export GITHUB_CLIENT_SECRET && printf "\n"
pnpm run provision:up -- --worker-url <worker-url> --github-username <gh-login> --client-id <client-id>
unset GITHUB_CLIENT_SECRET
```

8. Commit and push generated non-secret outputs:

```bash
git status --short -- wrangler.toml src/mantleConfig.ts AGENTS.md
git add wrangler.toml src/mantleConfig.ts AGENTS.md
git commit -m "mantle: wire production provision"
git push
```

Wait for Cloudflare Workers Builds to redeploy from the pushed commit. If
the dashboard build is unavailable, run `pnpm deploy` from this repo as a
fallback and explain that fallback to the user.

9. Smoke test:

- public home route;
- `/admin/sign-in`;
- GitHub admin sign-in;
- `/mcp/staff` with an agent client when available;
- a starter-specific core workflow.

A fresh site may have no public home content yet. A 404 on the locale
homepage is acceptable only after the Worker boots, `/admin/sign-in`
loads, and auth/MCP boundaries behave correctly.

## Feature Overlays

If `.mantle/features.json` lists features, run the repo-local feature
overlay skill first:

```text
.agent/skills/mantle-feature-overlays/SKILL.md
```

Feature scripts are starter lifecycle scripts, not Mantle CLI commands.
Run them only when the feature is present and the user accepts any extra
provider/billing requirement.

## Handoff

After smoke checks pass, render a short final handoff in the user's
language:

- Public URL.
- Admin sign-in URL.
- Staff MCP URL.
- Operator setup URL (`https://mantle.tools/connect?site=...`).
- What changed locally and what was committed.
- Any intentionally deferred feature setup.

Point future agents at `AGENTS.md`, `.mantle/launch-state.json`, and the
repo-local `.agent/skills/` directory.

## Diagnostics

| Symptom | Likely cause | Fix |
|---|---|---|
| Cloudflare first deploy cannot infer a binding | Starter uses a resource Dashboard cannot auto-create | Follow `provision:plan` notes, then redeploy. |
| `provision:up` cannot infer Worker name | Custom domain or non-workers.dev URL | Add `--worker-name <cloudflare-worker-name>`. |
| `wrangler secret put` targets wrong account | Wrangler logged into another Cloudflare account | Re-run `pnpm exec wrangler login` and confirm account. |
| GitHub OAuth callback mismatch | OAuth App callback URL is wrong | Set it exactly to `<worker-url>/api/auth/callback/github`. |
| Owner signs in but admin/MCP returns 403 | `ADMIN_GITHUB_LOGIN` does not match signed-in GitHub login | Re-run `provision:up` with the correct `--github-username`, or update the secret. |
| Worker boots but sessions fail after rerun | `BETTER_AUTH_SECRET` changed or was deleted | Restore the old secret if available; otherwise users must sign in again. |

## Don't

- Don't ask for a Cloudflare API token in the base first-run path.
- Don't create Cloudflare resources from Mantle landing.
- Don't commit provider secrets.
- Don't use `127.0.0.1` in OAuth callback examples; use `localhost`
  locally and the real Worker URL in production.
- Don't use `/admin/auth/github/callback`; the Better Auth callback path
  is `/api/auth/callback/github`.
