---
name: mantle provision
description: Deploy an installed mantle consumer project to the user's Cloudflare Worker and return the public URL plus Staff / User MCP URLs. Use after the install skill has produced a standalone project and the user wants the service online.
when_to_invoke: |
  Project exists, `pnpm validate --phase deploy` + `pnpm typecheck` pass (i.e. the Mantle subagent filled the welcome cards in step 9 of install), user wants to deploy.
applies_to: mantle@v0.1.0
---

# Provision a mantle project

You're taking an installed consumer project from local files to a user-owned Cloudflare Worker.

End state:

- D1 + render KV exist in the user's CF account; `wrangler.toml` points at them.
- Explicitly selected feature resources are either provisioned by their own opt-in
  starter scripts or clearly deferred for the operator.
- Worker secrets are set (Better Auth + GitHub OAuth + Turnstile if the archetype carries it).
- Worker deploys; GitHub OAuth via Better Auth + MCP OAuth/DCR work.
- `mantle/site.md` frontmatter `site_url:` + `revisions:` updated; `AGENTS.md` `Public site:` line updated.
- Post-deploy smoke proves unauthenticated MCP is rejected.
- Public URL + Staff MCP URL + User MCP URL printed; handoff points at `mantle/site.md` as the return-context surface.

Provision does **not** seed content. First real content is created after owner sign-in through Staff MCP / admin authoring.

## Principles (gotchas that aren't obvious from CF docs)

1. **D1 + render KV always. Base first-run does not touch R2.** R2 enables billing prompts on the CF account, so the default provision path must not create buckets. First-party media is an explicit opt-in feature (`media-r2`) after the site is online or when the user has clearly selected that overlay. If `.mantle/features.json` includes `media-r2`, use the starter's feature script only after the operator confirms billing readiness; otherwise leave R2 alone.

2. **Turnstile is conditional on the starter, not on this skill.** Archetypes with a public unauthenticated write surface (`presence`, `publication`, `intake` — all carry the `contact-messages` Schema and CAPTCHA `before_create` Trigger) provision a Turnstile widget. `blank` skips it. The starter's `provision.mjs` decides.

3. **Same GitHub account for everything.** `gh auth status`, the OAuth App registration, and `ADMIN_GITHUB_LOGIN` must all be the same login. Mismatch fails at the OAuth consent step with a 403 that's hard to diagnose.

4. **Scoped CF API token, short-lived, revocable.** Permissions: Workers Scripts Edit + Workers KV Storage Edit + D1 Edit + Turnstile Edit (only for archetypes that need it). Account scope: the specific target account (never "All accounts"). TTL: 1 day. Created at `dash.cloudflare.com/profile/api-tokens` → "Edit Cloudflare Workers" template + permission additions. Revoke after provision finishes.

5. **OAuth App callback URL is exact.** `<worker_url>/admin/auth/github/callback`. No paraphrase, no normalization, no trailing slash.

6. **One OAuth App per site.** It powers both browser sign-in and MCP OAuth/DCR consent.

7. **`BETTER_AUTH_SECRET` is auto-generated and load-bearing.** `provision:up` mints a fresh 32-byte secret on every run and pipes it in as a worker secret — the user never sees the value, and `wrangler secret list` shows names only, not values. The secret signs session cookies + JWTs, and (if the JWT plugin is enabled) encrypts JWK private keys at rest. Consequences worth saying out loud during handoff: re-running `provision:up` on the same worker, deleting and recreating the worker, or migrating to a new account all mint a fresh secret — every existing session is invalidated and any stored JWK row stops decrypting. There is no in-flow recovery path; if the user wants graceful rotation later, surface `BETTER_AUTH_SECRETS` (comma-separated, plural — old values kept for verification) as the path.

8. **Launch state is context, not provider authority.** If install came from `create-mantle launch --session ...`, read `.mantle/launch-state.json` before preflight. It can supply `github.owner`, `github.admin_login`, repo intent, and the fact that the raw session URL was already claimed. It does not authorize Cloudflare operations, billing-gated features, OAuth App secrets, or custom domains. Keep asking for the Cloudflare API token and GitHub OAuth App secret exactly as this Skill describes.

## CLI surface

```bash
# Always — note `--phase deploy`. The default `pnpm validate` runs the
# preview phase, which silences `MANTLE_LETTER_NOT_WRITTEN` and any other
# pre-deploy-only gates so local dev exits 0. Provision is the gate where
# we want the strict view; explicitly switch:
pnpm validate --phase deploy   # or `pnpm validate:deploy` if the starter ships that script
pnpm typecheck

# Provision (presence / publication / intake — uses the starter's provision.mjs):
pnpm provision:plan -- --project-name "<project-name>"
pnpm provision:up   -- --project-name "<project-name>" --github-username "<gh-login>" --client-id "<client-id>"

# blank: no provision.mjs ships. See § blank below.
```

`provision:plan` is read-only. Reads `CLOUDFLARE_API_TOKEN` from env, looks up the workers.dev subdomain, prints (a) resources that will be created, (b) the precomputed worker URL, (c) the GitHub OAuth App fields the user pastes at `github.com/settings/developers`. No mutation.

`provision:up` reads both `CLOUDFLARE_API_TOKEN` and `GITHUB_CLIENT_SECRET` from env. One pass: creates D1 + render KV + (conditional) Turnstile via CF API, writes resource IDs + `PUBLIC_ORIGIN` + Turnstile site key into `wrangler.toml`, deploys, pipes worker secrets (`ADMIN_GITHUB_LOGIN`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BETTER_AUTH_SECRET` (freshly generated), `TURNSTILE_SECRET_KEY`), updates `mantle/site.md` + `AGENTS.md`. Single deploy — origin is correct before deploy. Partial failures don't roll back; IDs are printed so the user can clean up via dashboard or rerun.

Feature overlays may add their own scripts, such as `pnpm media-r2:provision`.
Treat those as starter lifecycle scripts, not `mantle` CLI commands. They run
only when the feature is present in `.mantle/features.json` and the user
explicitly accepts the extra provider requirements.

Don't run `wrangler d1 create` / `wrangler kv namespace create` / `wrangler secret put` by hand when the script can do it. Wrangler's KV namespace command can produce ugly duplicated names like `<project>-<project>-render`; the script bypasses this via the CF API with exact titles.

## Flow

1. **Preflight** — if `.mantle/launch-state.json` exists, read it first and use `github.admin_login` / `github.owner` as the expected GitHub identity unless the user explicitly overrides it. Then run `pnpm validate --phase deploy` (or `pnpm validate:deploy`) + `pnpm typecheck` + `gh auth status` (confirm gh-login matches `ADMIN_GITHUB_LOGIN`). The `--phase deploy` flag is the readiness gate: it re-enables `MANTLE_LETTER_NOT_WRITTEN` plus any future pre-deploy-only checks. If the install Skill's Mantle subagent (step 9) didn't fill the welcome cards, this is where it surfaces — return to install before continuing.

   If GitHub CLI auth fails or shows the wrong login, pause provision as a recoverable auth step. Tell the user the local install is already committed/validated, state the expected GitHub login, ask them to run `gh auth login -h github.com` or switch to the expected account, and ask them to reply when done. Do not ask for Cloudflare credentials yet. When they return, re-run `gh auth status`, then continue with step 2. Keep the project path, commit SHA, validation status, and expected login in your status message so the next turn can resume without rediscovery.

2. **Get CF API token from user.** Via stdin (`! read -rsp …`), env var, or chat paste — user's choice. Set `CLOUDFLARE_API_TOKEN` in env and confirm `pnpm exec wrangler whoami` returns the expected account. If `.mantle/features.json` includes feature resources, inspect the feature README/scripts now and name any extra requirements before running them.

3. **`pnpm provision:plan -- --project-name X`.** Print the precomputed values. Ask the user to register the GitHub OAuth App with those exact values (Homepage URL, Authorization callback URL). The user generates a Client Secret and copies both Client ID and Secret back.

4. **`pnpm provision:up`.** With `CLOUDFLARE_API_TOKEN` and `GITHUB_CLIENT_SECRET` in env, run with `--project-name`, `--github-username`, `--client-id`. Surface the printed URLs verbatim.

5. **Post-deploy smoke.**

   ```bash
   BASE='<worker_url>'
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/mcp"                       # 401 — unauth MCP rejected
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/"                          # 302 → canonical locale
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/<canonical-locale>"        # 200 (404 expected pre-content; also fine)
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/sitemap.xml"               # 200
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/api/views/recent-posts"    # 200 — publication only
   ```

   Don't submit real contact/lead form posts as smoke; that creates test records in production storage.

6. **Bootstrap owner + MCP consent.** Tell the user to open `<worker_url>/admin/sign-in` and complete GitHub OAuth. The callback creates the user and calls `ensureBootstrapOwner` using `ADMIN_GITHUB_LOGIN`. Then connect an MCP-capable client to `<worker_url>/mcp/staff` — DCR handles registration, browser opens the consent screen, staff membership is checked, tokens issue, `/mcp/staff` accepts the bearer.

   `<worker_url>/mcp` is the end-user MCP resource — read-only View queries in v0.1. Authoring lives on `/mcp/staff`.

7. **Second-agent proof.** Connect a second agent through Staff MCP and run the starter's core workflow (list collections, create draft, update, publish, confirm public route). Publication: posts CRUD + `recent-posts` View. Intake: leads CRUD + `leads-recent` View. This is the v0.1.0 release gate — don't call the install production-ready until it works.

   If `media-r2` was selected and provisioned, include one media smoke: create an upload, PUT a tiny image through the presigned URL, commit it, and fetch the returned public URL. If `media-r2` was selected but the operator deferred billing/API-token setup, state that production is online while media hosting remains explicitly deferred.

8. **Handoff** — see § Mantle handoff below.

## `blank` archetype

The `blank` starter ships without a `provision.mjs` orchestrator. Production proof requires manually wiring the same Better Auth factory, OAuth App, `ADMIN_GITHUB_LOGIN`, and dual MCP mounts as `publication`. v0.1.0 ships this as a known gap; advanced users wire it themselves with raw `wrangler` commands. If your end-user picked `blank`, surface this honestly: `pnpm dev` works out of the box for local exploration, but production deploy requires per-step wrangler invocations until blank's provision.mjs lands.

## Secret etiquette

Both the CF API token and the GitHub Client Secret can come in via stdin (`read -rsp` → `export`) or chat paste. Offer both paths once.

- Terminal (preferred — value stays out of chat log):
  ```
  ! read -rsp "Cloudflare API token: " CLOUDFLARE_API_TOKEN && export CLOUDFLARE_API_TOKEN && printf "\n"
  ```
- Chat paste: low-risk for one-time use given the IP filter + 1-day TTL + revocation reminder.

Do not put `--client-secret <value>` in the visible command. `provision:up` reads `GITHUB_CLIENT_SECRET` from env — prefer:

```bash
read -rs GITHUB_CLIENT_SECRET
export GITHUB_CLIENT_SECRET
pnpm provision:up -- --project-name X --github-username Y --client-id Z
```

If an agent safety classifier refuses a secret-bearing command, ask the user once for explicit authorization to run it via stdin/env (the secret never lands in a file, RUN_NOTES, or command line). If they decline, hand them the literal `read -rs … && export …` line.

After provision: `unset CLOUDFLARE_API_TOKEN`, then remind the user to revoke at `dash.cloudflare.com/profile/api-tokens`.

## Mantle handoff

After all checks pass, render the final message in Mantle's voice (quiet, first-person, restrained, no emoji, native register in the user's language). `provision:up` already updated `mantle/site.md` `site_url:` + appended a `revisions:` entry stamped `by: provision`, and updated `AGENTS.md` `Public site:`. Confirm both wrote: `git status -- mantle/site.md AGENTS.md`.

Render in the user's language. Intent:

- Site is online at `<worker_url>`. Two short reasons to look first: read as a visitor, then sign in at `<worker_url>/admin/sign-in`.
- `mantle/site.md` now has the URL written in. Pasting that file's contents into a future conversation summons Mantle back. (A URL form via `.well-known/mantle/` is deferred.)
- Staff MCP URL is in the admin sidebar; raw link `<worker_url>/mcp/staff`.
- Acknowledge if the admin 5-card render is deferred — letter lives in `mantle/site.md` `## welcome`.
- If a Cloudflare API token was used, remind to revoke at `dash.cloudflare.com/profile/api-tokens`.

After the handoff, drop Mantle's voice.

## Diagnostics

| Symptom | Cause | Fix |
|---|---|---|
| `provision:plan` "expected 1 account" | Token sees multiple accounts | Recreate token with **Account Resources** scoped to the single target account, not "All accounts" |
| `provision:plan` "workers.dev subdomain not set" | User never claimed a subdomain | `dash.cloudflare.com` → Workers & Pages → claim a subdomain → rerun |
| `provision:up` fails on CF API call | Token missing a scope | Recreate with Workers Scripts Edit + Workers KV Storage Edit + D1 Edit + Turnstile Edit (last only if needed) |
| `provision:up` fails after some resources created | Partial provision | IDs printed before failure — delete via dashboard and rerun, or update `wrangler.toml` manually with printed IDs and rerun the failing step. Don't silently retry |
| Worker boots but `/mcp/staff` returns 500 | OAuth secrets failed to set | `printf '%s' '<v>' \| pnpm exec wrangler secret put GITHUB_CLIENT_ID` (etc.); redeploy |
| Owner signs in but MCP consent returns 403 | `ADMIN_GITHUB_LOGIN` doesn't match the GitHub login that signed in | `wrangler secret put ADMIN_GITHUB_LOGIN`; sign in again |
| GitHub OAuth callback shows mismatch error | OAuth App callback URL registered wrong | Edit OAuth App callback to exactly `<worker_url>/admin/auth/github/callback` |
| Public publication has no posts after provision | Expected — provision doesn't seed | Sign in at `<worker_url>/admin/sign-in` and use Staff MCP / admin authoring. Don't run `fixture` or `seed:initial` against prod |

## Don't

- Don't reintroduce stub bearer auth or `MANTLE_ALLOW_STUB_OAUTH`.
- Don't put secrets in `wrangler.toml`, `.env` (committed), or README snippets with real values.
- Don't block v0.1.0 on admin UI. Bootstrap owner + MCP is the v0.1.0 proof.
- Don't expose staff management as MCP tools.
- Don't promise custom domain automation in v0.1.0.
- Don't enable R2 / ask for billing setup / mention credit cards in the base first-run path. Only do it for an explicit `media-r2` opt-in.
- Don't ship the Turnstile test site key (`1x00000000000000000000AA`) or `dev-stub` secret to production. The starter ships them for `pnpm dev`; production deploys must replace both.
- Don't deploy twice. `provision:up` deploys once after origin is correct.
