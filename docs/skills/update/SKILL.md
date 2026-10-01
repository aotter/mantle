---
name: update
description: Upgrade a Mantle project's @aotter/mantle packages to a new exact version, including the move from 0.1.x to 0.2, without overwriting application-owned code.
metadata:
  source: "@aotter/mantle"
  sourcePath: docs/skills/update/SKILL.md
  applies_to: mantle 0.2
  projection: package
---

# Mantle Update

Upgrade deliberately; never overwrite application-owned code.

1. Inspect `git status`, `package.json`, the lockfile and the installed
   `@aotter/mantle` version. Keep unrelated local changes. Work on a branch.
2. Choose an explicit target version (`npm view @aotter/mantle dist-tags`).
   Read its release notes on GitHub and, after installing, its own
   `node_modules/@aotter/mantle/docs/`. The old version's docs are not the new
   contract.
3. **From 0.1.x to 0.2:** stop here and follow
   `node_modules/@aotter/mantle/docs/upgrade-0.1-to-0.2.md` after installing
   the target. There is no codemod and no in-place database upgrade: the
   project moves by hand, to a new database.
4. Set `@aotter/mantle` and `@aotter/mantle-ui` (if present) to the same exact
   version and update the lockfile with the package manager. Review the
   dependency diff and any peer changes `mantle generate` names.
5. Regenerate and check:

```sh
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec tsc --noEmit
```

6. The preset (`src/service.ts`, `src/index.ts`, `wrangler.jsonc`) is never
   rewritten. Generate into a scratch directory with the same manifests and
   `mantle.config.json`, diff it against the project's files, and apply the
   changes that matter by hand.
7. Run the service locally and test its real routes and sign-in. Before
   deploying, run `mantle generate --check --database <copy of the database>`
   to see what boot will change.

Report the old and new versions, the checks and their results, what changed
in the service files, and what remains. A dependency update does not
authorize a deploy. Never commit secrets.
