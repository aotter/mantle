---
name: mantle provision
description: Finish production deployment for an installed Mantle consumer project. Use after the install skill has produced a standalone project and the user wants the service online through their own GitHub and Cloudflare accounts.
when_to_invoke: |
  Project exists, `pnpm validate` + `pnpm typecheck` pass, the scaffold is ready to push to GitHub, and the user wants a production Cloudflare Worker.
applies_to: mantle@v0.1.0
---

# Provision a mantle project

You're taking an installed consumer project from local files to a
user-owned GitHub repo and Cloudflare Worker.

The base flow is dashboard-first:

1. The user's coding agent scaffolds and pushes a private GitHub repo.
2. The user opens Cloudflare Dashboard and creates a Worker from that
   GitHub repo. Cloudflare performs the first deploy and owns automatic
   first-deploy resource provisioning for id-less bindings.
3. The user reports the deployed Worker URL back to the agent.
4. The user creates the per-site GitHub OAuth App.
5. The agent runs `pnpm run provision:up` to write non-secret config,
   set Worker secrets through Wrangler, and update local handoff files.

Mantle landing is not the executor. It provides launch context and a
complete handoff; provider authority stays with the user and their
coding agent.

## End state

- The scaffold is committed and pushed to the user's private GitHub repo.
- Cloudflare has deployed the Worker from that repo at least once.
- `wrangler.toml` contains `PUBLIC_ORIGIN`, `GITHUB_CLIENT_ID`,
  `ADMIN_GITHUB_LOGIN`, and the correct Worker name.
- Worker secrets are set: `GITHUB_CLIENT_SECRET`,
  `BETTER_AUTH_SECRET`, and optional feature/provider secrets.
- `mantle/site.md` frontmatter `site_url:` and `AGENTS.md` `Public
  site:` point at the deployed Worker URL.
- Staff MCP and browser admin sign-in are ready to test.
- Operator setup URL is ready to hand to the owner:
  `https://mantle.tools/connect?site=<url-encoded-worker-url>`.

Provision does not seed production content. First real content is
created after owner sign-in through Staff MCP / admin authoring.

## Principles

1. **Use the user's accounts.** The repo belongs to the user's GitHub
   account or org. The Worker belongs to the user's Cloudflare account.
   Do not make Mantle a central runtime dependency.

2. **No Cloudflare API token in the base flow.** The base provision path
   does not ask for `CLOUDFLARE_API_TOKEN` and does not call Cloudflare
   resource APIs directly. Cloudflare Dashboard + Workers Builds handle
   the first deploy; Wrangler handles secrets after the user logs in.

3. **GitHub OAuth is per-site and user-owned.** The user creates a
   GitHub OAuth App for this generated site. The exact callback URL is:
   `<worker-url>/api/auth/callback/github`

4. **Same GitHub login for admin.** `gh auth status`, the OAuth App
   owner, and `ADMIN_GITHUB_LOGIN` should line up unless the user
   intentionally chose an org repo with a separate admin login.

5. **Launch state is context, not provider authority.** If install came
   from Mantle landing, read `.mantle/launch-state.json`. It can supply
   owner, admin login, repo name, locales, archetype, theme, and
   selected features. It does not authorize Cloudflare operations,
   billing-gated features, OAuth secrets, or custom domains.

6. **Feature overlays can add optional provider steps.** Read
   `.mantle/features.json` before provision. For example, `media-r2`
   may ask the operator to make an explicit R2/billing choice after the
   base site is online.

7. **`BETTER_AUTH_SECRET` is load-bearing.** The shared provision runner
   leaves an existing `BETTER_AUTH_SECRET` in place and creates one only
   when missing. Rotating it invalidates sessions and may make stored
   JWK rows unreadable. Do not rotate casually.

## CLI surface

Run from the generated project root:

```bash
pnpm validate
pnpm typecheck
pnpm run provision:plan
pnpm exec wrangler login
pnpm run provision:up -- --worker-url <worker-url> --github-username <gh-login> --client-id <client-id>
```

`provision:plan` is read-only. It prints the Cloudflare dashboard
first-deploy steps, the GitHub OAuth App fields, the Wrangler login
requirement, and feature-specific notes.

`provision:up` requires:

- `--worker-url <worker-url>`: the deployed Cloudflare Worker URL.
- `--github-username <gh-login>`: the bootstrap admin GitHub login.
- `--client-id <client-id>`: GitHub OAuth App Client ID.
- `GITHUB_CLIENT_SECRET` in the environment or stdin.

It writes non-secret config, sets Worker secrets with Wrangler, updates
`mantle/site.md` and `AGENTS.md`, then prints public/admin/MCP and
operator setup URLs.

Do not pass `GITHUB_CLIENT_SECRET` as a visible command argument.

```bash
read -rsp "GitHub OAuth client secret: " GITHUB_CLIENT_SECRET && export GITHUB_CLIENT_SECRET && printf "\n"
pnpm run provision:up -- --worker-url <worker-url> --github-username <gh-login> --client-id <client-id>
```

## Presenting browser steps (non-coder handoff)

Flow steps 3 and 5 hand the user into a browser. That user is usually a
non-coder who is trusting the agent — present those steps the way you'd
guide someone over the phone, not as a terse engineer checklist. The
plan that `provision:plan` prints is *your* reference; re-present it, do
not paste it through.

Rules:

- **One task at a time.** Send the Cloudflare deploy, wait for the URL,
  *then* send the GitHub OAuth App. Never dump both browser tasks in one
  message.
- **Number only what they see.** Label the block `STEP 1 of 2` /
  `STEP 2 of 2`. Do not leak your internal plan numbering — a user
  seeing "Step 2" and "Step 4" with gaps assumes they missed something.
- **Lead with one plain "why".** A single sentence on what the step
  accomplishes ("this is what puts your site on the internet").
- **Full-sentence click paths, not arrows.** "Click *Create
  application*, then open the *Import a repository* tab" — not
  `Create application → Import a repository`. Quote the exact labels the
  user sees on screen.
- **Say what they'll see and what to copy.** Name the landmark and the
  success signal ("a link ending in `.workers.dev` — copy that"), and a
  rough time ("about a minute").
- **Ask for values in plain language.** "Paste me the live link, and
  the Client ID." Never ask for `KEY=value` shell syntax, and never make
  them type literal `<...>` placeholders.
- **Protect the secret in words, not jargon.** Tell them to copy the
  Client Secret and keep it on their clipboard, and that you'll ask for
  it privately so it never lands in the chat. Don't say "stdin" or "env".
- **Give an escape hatch.** "If a screen doesn't match what I describe,
  paste a screenshot and I'll point you to the right button."

Keep agent-internal correctness rules out of the user-facing text. The
`localhost` / `127.0.0.1` callback rule (see Don't) governs what *you*
write; a dashboard user is handed the real Worker URL and never needs to
hear that warning.

## Flow

1. **Preflight.** Read `.mantle/launch-state.json` if present, then
   confirm the expected repo owner/admin login. Run:

   ```bash
   pnpm install --frozen-lockfile
   pnpm validate
   pnpm typecheck
   git status --short
   gh auth status
   ```

   If GitHub CLI auth is missing or points at the wrong login, pause
   and ask the user to switch/login before creating the repo.

2. **Push the repo.** Create a private GitHub repo in the selected
   owner, add the remote, commit the scaffold, and push. Use the user's
   GitHub auth context.

3. **Ask the user to run Cloudflare first deploy.** They should open
   Cloudflare Dashboard, create a Worker, choose GitHub as source, pick
   the repo, keep the Worker name aligned with the repo/project name,
   and run the first deploy. They report the deployed Worker URL back.
   Present this as `STEP 1 of 2` per **Presenting browser steps** above,
   and wait for the Worker URL before moving on.

4. **Print the plan.**

   ```bash
   pnpm run provision:plan
   ```

   Read any feature-specific notes out loud. If the project uses queues
   or another Cloudflare resource that Dashboard cannot infer, follow
   the plan's explicit instructions.

5. **Create the GitHub OAuth App.** Ask the user to create it under the
   account/org that should own site auth:

   - Application name: project/site name
   - Homepage URL: `<worker-url>`
   - Authorization callback URL:
     `<worker-url>/api/auth/callback/github`
   - Device Flow: unchecked

   Present this as `STEP 2 of 2` per **Presenting browser steps** above.
   Ask for the Client ID in chat; have them keep the Client Secret on
   the clipboard for the hidden prompt in step 6 — do not ask them to
   paste the secret in chat.

6. **Authorize Wrangler and run provision.**

   ```bash
   pnpm exec wrangler login
   read -rsp "GitHub OAuth client secret: " GITHUB_CLIENT_SECRET && export GITHUB_CLIENT_SECRET && printf "\n"
   pnpm run provision:up -- --worker-url <worker-url> --github-username <gh-login> --client-id <client-id>
   unset GITHUB_CLIENT_SECRET
   ```

7. **Commit provision outputs.** Confirm and commit local changes:

   ```bash
   git status --short -- wrangler.toml src/mantleConfig.ts mantle/site.md AGENTS.md
   ```

8. **Smoke test.**

   ```bash
   BASE='<worker-url>'
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/mcp"                # unauthenticated should reject
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/"                   # redirect or 200
   curl -s -o /dev/null -w '%{http_code}\n' "$BASE/admin/sign-in"      # 200/302 auth entry
   ```

   Then ask the user to sign in through GitHub at
   `<worker-url>/admin/sign-in` and connect an MCP-capable client to
   `<worker-url>/mcp/staff`.

9. **Operator setup proof.** Open the operator setup URL:

   ```text
   https://mantle.tools/connect?site=<url-encoded-worker-url>
   ```

   Confirm it shows the Staff MCP URL, User MCP URL, Claude connector
   entry, and `mantle-companion-upload` plugin install commands. The
   companion upload path must pass file references/metadata only; large
   binary payloads go through Mantle upload sessions and signed URLs,
   not base64 MCP tool arguments.

10. **Second-agent proof.** Connect a second agent through Staff MCP and
   run the starter's core workflow: list collections, create/update a
   draft, publish or submit the starter's natural operation, and confirm
   a public read path. Do not create throwaway production submissions
   unless the user explicitly accepts those records.

## Feature overlays

If `.mantle/features.json` lists features, run the repo-local feature
overlay skill first:

```text
.agent/skills/mantle-feature-overlays/SKILL.md
```

Feature scripts are starter lifecycle scripts, not Mantle CLI
commands. Run them only when the feature is present and the user
accepts any extra provider/billing requirement.

## Handoff

After smoke checks pass, render a short final handoff in the user's
language, in plain words (no `wrangler.toml` / secret / CLI jargon):

- Public URL.
- Admin sign-in URL.
- Staff MCP URL.
- Operator setup URL (`https://mantle.tools/connect?site=...`) for
  Staff/User MCP connection and the companion upload plugin.
- What changed locally and what was committed.
- Any intentionally deferred feature setup.

Point future agents at `mantle/site.md`, `AGENTS.md`, and the
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
- Don't recite a browser step to a non-coder as a terse `A → B → C`
  breadcrumb, a `KEY=value` reply contract, a `<placeholder>` they might
  paste literally, or an internal correctness warning (e.g. the
  `127.0.0.1` rule). See **Presenting browser steps**.
