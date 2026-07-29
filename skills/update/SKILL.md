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
   `scripts/update.mjs` and `scripts/materialize.mjs` together into a temporary
   directory, and run the updater from the project root with the same commit
   SHA. Do not replace the project's updater before reviewing the report.
3. Read the generated report before editing.
4. Triage each path; do not treat the report as a patch or merge plan.
5. Port confirmed upstream changes one hunk at a time.
6. Re-run:

```bash
pnpm validate
pnpm typecheck
```

## Report Triage

Current reports compare three states: the original starter ref, the target
ref, and the local project.

- Review `upstream` to find starter changes worth porting. Use `local` only to
  understand project-owned drift from the original starter.
- Never copy generated comparison versions of `wrangler.toml`,
  `.dev.vars.example`, `.mantle/launch-state.json`, or
  `.mantle/features.json`. Preserve Worker/D1 names, bindings, origins,
  provider values, and launch state. Port a reviewed upstream line manually
  only when it does not replace project identity or state.
- The updater omits the two `.mantle/*.json` state files and reproduces project
  identity. If `upstream` proposes `mantle-<type>` names for a real project,
  stop: the comparator is stale or incompatible. Use the target updater
  recovery in step 2, then regenerate the report.
- A large `local` section is normal after customization. Counts are not a
  confidence score.

## Boundary

Starter bundles and plugin packages can provide source snapshots, but Core owns
the workflow vocabulary. Repo-local update guidance may recover an older
updater, but it does not override the installed Core runtime/API contract.
