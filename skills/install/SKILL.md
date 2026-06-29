---
name: mantle install
description: Orient and continue a Mantle site that Mantle landing has provisioned. Mantle sites launch on Mantle landing (mantle.tools), which creates the GitHub repo and the first Cloudflare deploy; the agent takes over the provisioned repo to complete the selected type, first pages, and content. Use when the user pasted a Mantle launch / after-launch context, opened a landing-provisioned repo, or wants to start a new Mantle site.
when_to_invoke: |
  The user wants a new Mantle site, pasted a Mantle landing launch / after-launch context, or opened a repo that Mantle landing provisioned and wants help continuing it.
---

# mantle install

Mantle sites are launched on **Mantle landing** (`https://mantle.tools`),
not scaffolded locally. Landing asks the launch questions, then provisions
server-side: it creates the user's private GitHub repo, commits a blank
deployable Mantle site, and connects Cloudflare Workers CI for the first
deploy. Your job is to **continue that provisioned repo** — complete the
selected type, first pages, and content — not to scaffold from scratch.

There is no local scaffolder to run. The `create-mantle` CLI was retired
when provisioning moved into landing. If the user has not launched yet,
send them to `https://mantle.tools` to launch, then resume here once the
repo exists. Do not rebuild the old manual interview / prompt-composition
harness.

## Ground Truth

`@aotter/mantle-*` exposes exactly four declarative atoms scoped to
`cms.mantle.aotter.net/v1`, mapping 1-to-1 to Postgres primitives:

| Atom | Postgres analog | External surface |
|---|---|---|
| Schema | `CREATE TABLE` | none directly |
| View | `CREATE VIEW` | auto-mounted at `GET /api/views/<name>` |
| Procedure | `CREATE FUNCTION` | none directly |
| Trigger | `CREATE TRIGGER` + cron + REST route + LISTEN/NOTIFY | binding atom |

Anything domain-shaped (Form, Membership, Workflow) is composed in the
consumer project from these four atoms plus user TypeScript. Full grammar
reference:
<https://raw.githubusercontent.com/aotter/mantle/develop/docs/design-atoms.md>.

A landing-provisioned repo carries its launch context and ground truth in:

| Path | Contents |
|---|---|
| `.mantle/launch-state.json` | Non-secret launch choices: type, purpose, locales, repo, owner, suggested overlay |
| `.mantle/features.json` | Starter launch context and applied starter state |
| `.mantle/handoff.md` | The launch handoff note written for you |
| `manifests/*.yaml` | Schemas / Views / Procedures / Triggers |
| `src/mantleConfig.ts` | Site defaults, handler registration, runtime bindings |
| `src/handlers/` | Handler implementations |
| `AGENTS.md` | Cross-tool agent entry |
| `.agent/skills/` + `.claude/skills/` | Vendored Core skills from `@aotter/mantle`: `mantle:develop`, `mantle:plugin`, `mantle:theme`, `mantle:update` |

## Take Over a Provisioned Repo

The repo was already created and deployed by landing. Continue it:

1. Confirm repository access through an available GitHub connector or MCP
   tool. Use GitHub CLI only if it is already authenticated.
2. Clone or open the repo, then read `.mantle/launch-state.json`,
   `.mantle/features.json`, and `.mantle/handoff.md`.
3. Inspect the four-atoms manifest, the type overlay notes, pages, and
   seed data before changing code.
4. Validate locally before editing:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm typecheck
```

Diagnostics are structured JSON with `code` and `suggestion` fields.
Surface both verbatim when validation fails.

## Continue With Repo-Local Skills

The generated repo vendors Core-owned skills under `.agent/skills/` and
`.claude/skills/`. The starter carries local copies for offline/pinned use; it
does not own a separate skill contract.

- **`mantle:develop`** — manifest, runtime, content-model, layout,
  bug-fix, and validation work on the site.
- **`mantle:plugin`** — install repeatable marketplace capabilities using
  a plan-first Core workflow.
- **`mantle:theme`** — brand and visual direction via Mantle / Kiwa tokens
  and source. There is no premade theme picker; visual direction is agent
  work after launch.
- **`mantle:update`** — compare the repo against its upstream provision
  bundle or installed plugin locks.

Remove the placeholder blank homepage once the selected type ships a real
homepage.

## Optional Media Uploads

R2-backed media uploads are a post-launch opt-in, not part of Day 1
provisioning. R2 setup may require Cloudflare billing or a credit card, so
do not block the first deploy or first useful page on it.

When the site really needs staff-managed images or files, follow the
consumer recipe:
<https://raw.githubusercontent.com/aotter/mantle/develop/docs/media-uploads.md>.

For media maintenance, prefer Claude Code, Codex, Cursor, or another
local/non-sandboxed coding agent that can read files and make outbound PUT
requests. Do not rely on Claude Cowork for R2 uploads; use a
non-sandboxed agent instead.

## Local Preview

To see the site locally before pushing:

```bash
[ -f .dev.vars.example ] && cp .dev.vars.example .dev.vars
openssl rand -hex 32
pnpm dev
```

Paste the generated random value into `.dev.vars` as `BETTER_AUTH_SECRET`.
This secret is local only and must not be reused for production. Use
`localhost`, not `127.0.0.1`, in local examples. A fresh blank site may
return 404 on the public home route until the type overlay adds one; treat
that as an empty-site state, not a failure, when validation and admin
routes are alive.

## Production

Landing already created the GitHub repo and the first Cloudflare deploy.
To finish production — verify the deploy, wire per-site staff auth, smoke
test, and hand off the operator setup URL — continue with the provision
skill:
<https://raw.githubusercontent.com/aotter/mantle/develop/skills/provision/SKILL.md>.

## Don't

- Don't run or look for `create-mantle`; it was retired with provisioning v2.
- Don't rebuild the manual interview / prompt-composition harness.
- Don't scaffold a project from scratch locally; launch happens on landing.
- Don't block the first useful page on polishing prose or writing a site letter.
- Don't ask for a Cloudflare API token in the base flow.
- Don't require R2 media setup in the base flow; it is optional
  post-launch work.
- Don't commit provider secrets.
- Don't use `127.0.0.1` in OAuth callback examples; use `localhost` locally
  and the real Worker URL in production.
