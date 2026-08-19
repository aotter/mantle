---
name: install
description: Start a new Mantle site locally from a deterministic starter bundle, or orient and continue an existing local or Mantle landing project. Use when the user gives a Mantle repository URL and asks to try or build with it, invokes the Mantle install skill, wants a new Mantle site, or opens an existing generated site.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/install/SKILL.md
  applies_to: mantle grammar v0.1
  projection: plugin
  projectionReason: Creates a new project; nothing to project into an existing one.
---

# Mantle Install

Route by the working directory:

- If it already contains `.mantle/launch-state.json` or depends on
  `@aotter/mantle`, continue the existing project.
- Otherwise create a new local project from a deterministic provision bundle.
  Do not use the Mantle SDK checkout as the application.

Mantle landing uses the same bundles but continues through GitHub, Cloudflare,
and optional paid hosted auth. Use landing only when the user wants that
hosted provider flow.

## Create a Local Project

1. Infer the closest starter from the user's request. Ask only when two choices
   would materially change the result.

| Intent | Type |
|---|---|
| API/MCP backend or empty base | `blank` |
| Small public or company site | `presence` |
| Form, application, or submission flow | `intake` |
| Blog, docs, posts, or editorial site | `publication` |
| Catalog or order intent | `transaction` |
| Booking or request intent | `reservation` |
| Member or participation intent | `community` |

2. Choose a target directory outside both Mantle repositories; its name
   becomes the project slug. Derive a brand, one-sentence description, and
   locales from the user's prompt. Require Node 22+ and pnpm 9+; check
   `node --version` and `pnpm --version` before creating.

3. Create the project with the Core CLI. It resolves the official immutable
   starter tag for its own version, so no starters checkout is involved:

```bash
npx -y @aotter/mantle@alpha create <type> <target-dir> \
  --brand "<brand>" \
  --description "<one sentence>" \
  --locales <comma-separated-locales>
```

Pin an exact version (`@aotter/mantle@<version>`) when the user asked for one.
`create` writes files and stops: it installs nothing, initializes no
repository, configures no auth, and deploys nothing. It refuses to write into
a path that already exists, and there is no force flag — choose a new
directory instead.

Do not clone the starters repository, copy `blank/`, merge overlays, or edit a
provision bundle by hand. The CLI renders the same immutable bundle Mantle
landing uses.

4. For a typed launch, read `.mantle/handoff.md`, the selected overlay's
   `layout.md`, `seed-prompt.md`, and `seed.json`. Shape the first local page by
   editing that checked-in seed; generated content modules import it directly.
   This is application source, not direct D1 authoring. Do not use Staff MCP
   until an auth provider is configured.

5. Initialize and verify the local project:

```bash
cd <target-dir>
git init -b main
pnpm install --frozen-lockfile
pnpm exec mantle skills
pnpm exec mantle skills --check
pnpm validate
pnpm typecheck
pnpm dev
```

Open `http://localhost:8787`. Public preview works before auth is configured;
auth-gated routes may return `503 setup_incomplete`. `blank` is intentionally
empty; typed launches must show the selected seed. Do not infer SDK public
render routes from the Core README—generated projects mount only the URL
surface documented in their own README.

## Continue an Existing Project

Read these before editing:

1. `.mantle/launch-state.json`, `.mantle/features.json`, and
   `.mantle/handoff.md`.
2. `package.json` for the installed `@aotter/mantle*` versions.

Install the locked dependency graph and replace any stale projected Core
skills before reading them:

```bash
pnpm install --frozen-lockfile
pnpm exec mantle skills
pnpm exec mantle skills --check
```

Then read:

3. Repo-local Mantle skills under `.agents/skills/` or `.claude/skills/`. A
   project created before this layout may also carry `.agent/skills/`; read it
   if present, but never write there and never delete it.
4. Matching embedded docs under `node_modules/@aotter/mantle/docs/`.

Use remote docs only when embedded docs are unavailable, and use a tag matching
the installed version. Never use `develop` docs for a versioned project.

Do not branch on how the project was created. Verify the current git remote,
live URL, and auth response, then skip work that is already complete.

Then run:

```bash
pnpm exec mantle skills --check
pnpm validate
pnpm typecheck
```

Inspect the already composed manifest, page, and seed files before changing
them. Use the project's scripts first; ask the installed CLI for its command
list rather than trusting one copied into prose:

```bash
pnpm exec mantle --help
pnpm validate
```

## Production

Local cold start intentionally stops before GitHub and Cloudflare operations.
When the user asks to ship, use `mantle:provision` from the installed plugin or
`node_modules/@aotter/mantle/skills/provision/SKILL.md`.

Mantle landing is the first-run option when the user wants Mantle to create the
private GitHub repo, connect Cloudflare, and offer paid hosted auth. Free
self-hosted auth requires the owner to configure their GitHub OAuth App and
provider secrets.

## Report

Return:

- created or opened project path;
- selected type and why;
- local URL;
- validation and typecheck results;
- observed GitHub, deploy, and auth state;
- three tailored next options: shape the visual experience, build the first
  real business workflow, or finish deploy/auth if incomplete. Never leave
  auth or seed data as the only next step.

## Don't

- Don't use the Mantle SDK checkout as the generated application.
- Don't hand-compose starter layers; materialize the generated provision
  bundle.
- Don't push, deploy, or configure providers during local cold start.
- Don't commit provider secrets.
- Don't block the first useful page on optional media storage.
