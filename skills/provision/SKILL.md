---
name: mantle provision
description: Finish production for a Mantle site after Mantle landing has provisioned it. Landing already created the private GitHub repo and the first Cloudflare Worker deploy; this skill covers verifying that deploy, wiring per-site staff auth (GitHub OAuth App + Worker secrets), smoke testing, and handing off the operator setup URL.
when_to_invoke: |
  Mantle landing has created the repo and the first Cloudflare deploy, the user wants production fully usable, and staff sign-in / MCP still needs wiring.
applies_to: mantle@v0.1.0
---

# Provision a Mantle Project

Provisioning is landing-driven. **Mantle landing is the executor for the
first deploy**: it creates the user's private GitHub repo, commits the
blank deployable site, connects Cloudflare Workers CI, and triggers the
first build. You pick up after that to make production fully usable.

The Worker boots before staff auth is configured — it serves public routes
and returns a clean `503 setup_incomplete` on auth-gated routes until the
GitHub OAuth App and Worker secrets are set. Your remaining job is to
finish that wiring, verify, and hand off.

Keep provisioning boring: set the few secrets, commit non-secret config,
let Cloudflare CI redeploy. Do not re-create the repo, re-run the first
deploy, or resurrect a heavy `provision:up` orchestrator — both retired
with v2.

## End State

- Cloudflare has deployed the Worker from the repo (landing's first build,
  plus your redeploy after config).
- `wrangler.toml` carries `PUBLIC_ORIGIN`, `GITHUB_CLIENT_ID`,
  `ADMIN_GITHUB_LOGIN`, and the correct Worker name.
- Worker secrets are set: `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET`,
  and any optional feature/provider secrets.
- `AGENTS.md` `Public site:` points at the deployed Worker URL.
- Staff MCP and browser admin sign-in work.
- Operator setup URL handed to the owner:
  `https://mantle.tools/connect?site=<url-encoded-worker-url>`.

Provision does not seed production content. First real content is created
after owner sign-in through Staff MCP / admin authoring.

## Principles

1. Use the user's accounts. The repo and Worker belong to the user's
   GitHub and Cloudflare accounts.
2. No Cloudflare API token in the base flow. Prefer a Cloudflare MCP
   connector for provider work; use `wrangler login` as a fallback after
   the user agrees.
3. GitHub OAuth is per-site and user-owned. The callback URL is exactly
   `<worker-url>/api/auth/callback/github`.
4. Launch state is context, not provider authority.
   `.mantle/launch-state.json` may supply owner, admin login, repo name,
   locales, and type. It does not authorize Cloudflare operations, OAuth
   secrets, or custom domains.
5. `BETTER_AUTH_SECRET` is load-bearing. Set it once and preserve it;
   rotating it invalidates every session.

## Flow

Run from the generated project root.

1. Verify the landing deploy. Confirm Cloudflare Workers CI built and
   deployed from GitHub, and capture the live `*.workers.dev` URL. The
   public site should respond; auth-gated routes return `503
   setup_incomplete` until step 4 — that is expected, not a failure.

2. Confirm the local repo is clean and valid before changing config:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm typecheck
git status --short
```

3. Ask the user to create the per-site GitHub OAuth App once the Worker
   URL is known:

- Homepage URL: `<worker-url>`
- Authorization callback URL: `<worker-url>/api/auth/callback/github`
- Device Flow: unchecked

Ask for the Client ID in chat. Keep the Client Secret out of chat and pass
it through the hidden shell prompt below.

4. Write non-secret production config into `wrangler.toml`
   (`PUBLIC_ORIGIN=<worker-url>`, `GITHUB_CLIENT_ID`, `ADMIN_GITHUB_LOGIN`,
   and the correct Worker `name`), then set the Worker secrets. Prefer a
   Cloudflare MCP connector; otherwise use Wrangler after the user agrees
   to `wrangler login`:

```bash
pnpm exec wrangler login
read -rsp "GitHub OAuth client secret: " GITHUB_CLIENT_SECRET && printf "\n"
printf '%s' "$GITHUB_CLIENT_SECRET" | pnpm exec wrangler secret put GITHUB_CLIENT_SECRET
openssl rand -hex 32 | pnpm exec wrangler secret put BETTER_AUTH_SECRET
unset GITHUB_CLIENT_SECRET
```

Set `BETTER_AUTH_SECRET` only on the first run; reuse the existing value on
later runs.

5. Commit and push the non-secret config so Cloudflare CI redeploys:

```bash
git add wrangler.toml AGENTS.md
git commit -m "mantle: wire production provision"
git push
```

Wait for Workers Builds to redeploy from the pushed commit. If the
dashboard build is unavailable, run `pnpm deploy` as a fallback and explain
that to the user.

6. Smoke test:

- public home route;
- `/admin/sign-in`;
- GitHub admin sign-in;
- `/mcp/staff` with an agent client when available;
- a type-specific core workflow.

A fresh site may have no public home content yet. A 404 on the locale
homepage is acceptable only after the Worker boots, `/admin/sign-in`
loads, and auth / MCP boundaries behave correctly.

## Handoff

After smoke checks pass, render a short final handoff in the user's
language:

- Public URL.
- Admin sign-in URL.
- Staff MCP URL.
- Operator setup URL (`https://mantle.tools/connect?site=...`).
- What changed locally and what was committed.
- Any intentionally deferred feature / provider setup.

Point future agents at `AGENTS.md`, `.mantle/launch-state.json`, and the
repo-local `.agent/skills/` directory (`mantle:develop`, `mantle:overlay`,
`mantle:theme`, `mantle:update`).

## Diagnostics

| Symptom | Likely cause | Fix |
|---|---|---|
| Auth-gated routes return `503 setup_incomplete` | GitHub OAuth + secrets not wired yet | Expected before step 3-4; finish the OAuth App + secrets, then redeploy. |
| `wrangler secret put` targets the wrong account | Wrangler logged into another Cloudflare account | Re-run `pnpm exec wrangler login` and confirm the account. |
| GitHub OAuth callback mismatch | OAuth App callback URL is wrong | Set it exactly to `<worker-url>/api/auth/callback/github`. |
| Owner signs in but admin / MCP returns 403 | `ADMIN_GITHUB_LOGIN` does not match the signed-in GitHub login | Fix the `ADMIN_GITHUB_LOGIN` value and redeploy. |
| Worker boots but sessions fail after a rerun | `BETTER_AUTH_SECRET` changed or was deleted | Restore the old secret if available; otherwise users must sign in again. |

## Don't

- Don't ask for a Cloudflare API token in the base first-run path.
- Don't re-create the repo or re-run the first deploy from the agent;
  landing owns first provisioning.
- Don't resurrect `provision:up` / `provision:plan` as a second
  provisioner; those scripts were retired with v2.
- Don't commit provider secrets.
- Don't use `127.0.0.1` in OAuth callback examples; use `localhost` locally
  and the real Worker URL in production.
- Don't use `/admin/auth/github/callback`; the Better Auth callback path is
  `/api/auth/callback/github`.
