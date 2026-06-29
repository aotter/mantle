---
name: mantle:update
description: Check a Mantle project for drift against its Core SDK, starter source, or installed plugin lockfiles.
source: "@aotter/mantle"
sourcePath: skills/update/SKILL.md
when_to_invoke: |
  User asks to update Mantle, compare generated files, refresh starter/vendor output, or inspect marketplace plugin drift.
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
2. Run the project's existing update or compare script if one exists.
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
