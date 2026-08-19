---
name: update
description: Check a Mantle project for drift against its Core SDK, starter source, or installed plugin lockfiles.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/update/SKILL.md
  applies_to: mantle grammar v0.1
  projection: project, plugin
---

# Mantle Update

Use this for drift checks. Do not blindly overwrite user-owned code.

## First Read

1. `package.json` and lockfile for installed `@aotter/mantle*` versions.
2. `.mantle/launch-state.json` and `.mantle/features.json` when the project
   came from Mantle landing.
3. `.mantle/plugins.json` and `.mantle/plugins.lock.json` when plugins are
   installed.
4. Existing project scripts such as `mantle:update`, `validate`, and
   `typecheck`; the installed `mantle update` command is authoritative.

## Workflow

1. Start from a clean git worktree.
2. Resolve a mutable target branch to its current commit SHA, then run the
   installed command with that immutable ref:

```bash
pnpm exec mantle update --ref <immutable-ref>
```

   For the one-time alpha.63 bridge, invoke the exact newer Core package and
   provide the current bundle location because alpha.63 metadata does not
   contain it:

```bash
pnpm dlx @aotter/mantle@<exact-version> update \
  --ref <immutable-ref> \
  --bundle-base-url 'https://raw.githubusercontent.com/aotter/mantle-starters/{ref}/provision-bundles'
```

   Do not extract or replace a repo-local updater. The Core command accepts
   the alpha.63 no-`v` source ref, writes only the report, and records the
   versioned bundle location for the reviewed metadata migration.
3. Read the generated report before editing.
4. Triage each path; do not treat the report as a patch or merge plan.
5. Port confirmed upstream changes one hunk at a time.
6. Apply only the report's `.mantle/launch-state.json` and
   `.mantle/features.json` metadata migration, preserving every other field.
7. Re-run:

```bash
pnpm validate
pnpm typecheck
```

## Report Triage

Current reports compare three states: the original starter ref, the target
ref, and the local project.

- Review `upstream` to find starter changes worth porting. Use `local` only to
  understand project-owned drift from the original starter.
- Never copy generated comparison versions of `.mantle/launch-state.json` or
  `.mantle/features.json`; the report omits them and gives a field-level
  migration instead. Preserve Worker/D1 names, bindings, origins, provider
  values, and all unlisted launch state.
- The updater reproduces project identity in legacy Wrangler files. If
  `upstream` proposes `mantle-<type>` names for a real project, stop: the
  bundle is incompatible and must not be ported.
- A large `local` section is normal after customization. Counts are not a
  confidence score.

## Boundary

Starter bundles and plugin packages can provide source snapshots, but Core owns
the workflow vocabulary. Repo-local update guidance may recover an older
updater, but it does not override the installed Core runtime/API contract.
