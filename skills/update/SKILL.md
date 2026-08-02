---
name: update
description: Compare a Mantle site with an immutable starter release while preserving every project-owned change.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/update/SKILL.md
  applies_to: mantle@v0.1.0
---

# Mantle Update

`mantle update` is a comparator, not an overwrite command.

## First Read

1. `package.json` and lockfile for the installed Mantle version.
2. `.mantle/launch-state.json` for the exact source `starter_ref`.
3. `.mantle/features.json` for the registry version and immutable
   `bundleBaseUrl`.
4. The git diff for project-owned manifests, handlers, routes, UI, and config.

Keep the leading `v` when the source is a Git tag. The recorded ref must be the
exact immutable ref fetched by provisioning.

## Workflow

Start from a clean worktree, then run:

```bash
pnpm exec mantle update --ref vX.Y.Z
```

If the registry metadata already names the intended target, omit `--ref`.
Use `--bundle-base-url` only for a legacy project whose metadata predates the
configured bundle source.

Read `.mantle/update-report.json` before editing. It compares:

- `upstream`: source bundle to target bundle;
- `local`: the current project to its source bundle.

Port reviewed upstream hunks manually. Preserve project names, D1/KV IDs,
origins, secrets, `wrangler.jsonc`, launch state, manifests, handlers, custom
routes, low-level composition, and UI changes. A large local diff is normal and
is not a confidence score.

After the reviewed target files are ported, apply the report's typed
`metadata_migration`: advance only `launch-state.json`'s `starter_ref` and the
registry `version`/`bundleBaseUrl` fields. Preserve every other instance field.
The comparator reports this migration but deliberately does not mutate state.

Landing-created alpha.63 repositories recorded `0.0.11-alpha.63` without the
Git tag's `v`, so their old local updater cannot fetch its source bundle. Run
the released bridge CLI directly instead:

```bash
pnpm dlx @aotter/mantle@0.0.11-alpha.64 update \
  --ref v0.0.11-alpha.64 \
  --bundle-base-url \
  'https://raw.githubusercontent.com/aotter/mantle-starters/{ref}/provision-bundles'
```

The Core CLI retries the historical source as a `v`-prefixed tag and preserves
the recorded ref in its report. Legacy `wrangler.toml` handling is a bridge
only; new projects use `wrangler.jsonc`. Never copy updater scripts out of a
floating branch.

After reviewed edits:

```bash
pnpm exec mantle generate
pnpm validate
pnpm check:generated
pnpm typecheck
pnpm check
```
