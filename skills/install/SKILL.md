---
name: install
description: Start a new Mantle site locally from a deterministic starter bundle, or orient and continue an existing local or Mantle landing project. Use when the user gives a Mantle repository URL and asks to try or build with it, invokes the Mantle install skill, wants a new Mantle site, or opens an existing generated site.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/install/SKILL.md
  applies_to: mantle@v0.1.0
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

2. Choose a target directory outside the Mantle SDK checkout. Derive a short
   project slug, brand, one-sentence description, and locales from the user's
   prompt.

3. Clone [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters)
   into a temporary directory and run its materializer. Use a starters ref
   supplied by the user for branch testing. Otherwise use a tag matching the
   requested Mantle version; use `develop` only for unreleased work.

```bash
git clone --depth 1 --branch <starters-ref> \
  https://github.com/aotter/mantle-starters.git <temporary-starters-dir>
pnpm --dir <temporary-starters-dir> materialize <type> \
  --out <target-dir> \
  --project-name <slug> \
  --brand "<brand>" \
  --description "<one sentence>" \
  --locales <comma-separated-locales>
```

The materializer writes the same precomposed `provision-bundles/<type>.json`
used by Mantle landing. Do not manually copy `blank/`, merge overlays, or edit
the generated bundle JSON.

4. Initialize and verify the local project:

```bash
cd <target-dir>
git init -b main
pnpm install --frozen-lockfile
pnpm validate
pnpm typecheck
pnpm dev
```

Open `http://localhost:8787`. Public preview works before auth is configured;
auth-gated routes may return `503 setup_incomplete`.

## Continue an Existing Project

Read these before editing:

1. `.mantle/launch-state.json`, `.mantle/features.json`, and
   `.mantle/handoff.md`.
2. `package.json` for the installed `@aotter/mantle*` versions.
3. Repo-local Mantle skills under `.agent/skills/` or `.claude/skills/`.
4. Matching embedded docs under `node_modules/@aotter/mantle/docs/`.

Use remote docs only when embedded docs are unavailable, and use a tag matching
the installed version. Never use `develop` docs for a versioned project.

Then run:

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm typecheck
```

Inspect the already composed manifest, page, and seed files before changing
them. Use the project's scripts first; generated projects expose:

```bash
pnpm exec mantle --help
pnpm validate
pnpm introspect
pnpm emit-openapi
pnpm emit-types
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
- GitHub, Cloudflare, and auth work intentionally deferred.

## Don't

- Don't use the Mantle SDK checkout as the generated application.
- Don't hand-compose starter layers; materialize the generated provision
  bundle.
- Don't push, deploy, or configure providers during local cold start.
- Don't commit provider secrets.
- Don't block the first useful page on optional media storage.
