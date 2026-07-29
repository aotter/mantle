---
name: update
description: Check a Mantle project for drift against its Core SDK, starter source, or installed plugin lockfiles.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/update/SKILL.md
  applies_to: mantle@v0.1.0
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
   `typecheck`.

## Workflow

1. Start from a clean git worktree.
2. Resolve a mutable target branch to its current commit SHA, then run the
   project's existing update or compare script with that immutable ref.
   If it exits before writing a report (for example, an older
   `mantle:update` rejects a new bundle placeholder), fetch the provision
   bundle from that `aotter/mantle-starters` commit, extract
   its `scripts/update.mjs` to a temporary file, and run that file from the
   project root with the same commit SHA. Do not replace the project's updater
   before reviewing the report.
3. Read the generated report before editing.
4. Apply useful differences manually.
5. Re-run:

```bash
pnpm validate
pnpm typecheck
```

## Boundary

Starter bundles and plugin packages can provide source snapshots, but Core owns
the update vocabulary. A stale starter recipe or plugin note is context; it does
not override the installed Core SDK contract.
