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

## Generated native applications (alpha.7 and later)

If the installed/target README describes generated native queries, use this
flow and stop before the historical Core instructions below.

Follow the installed [native generation and service workflow](../../next/service.md)
with the exact package version's `contract.md` and `compatibility.md`. Commit
all generated output, run the same generation command with `--check`, and keep
bundle `dist/` untracked. The app owns its verified Caller, handlers and native
resources; OSS staff role is `staff`.

Pin exact target SDK/peer versions and read its release notes and Admin asset
installation instructions. Core-to-native replaces app imports/wiring; it is not
a package-only update. Preserve users, sessions, content and application code.
Review emitted SQL/policy diffs and rehearse explicit data-preserving schema/auth/role
migrations on a copy. Initial schema.sql never authorizes rebuilding production
tables. Verify auth/Admin/MCP/REST, locks and persistence before authorized cutover.

## Historical Core applications (through alpha.6)

The following applies only when the target package still uses RuntimePlan.

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
4. Set `@aotter/mantle`, and `@aotter/mantle-ui` where present, to the same
   exact version (`@aotter/mantle-admin-ui` is gone: the console is
   `@aotter/mantle-ui/admin`), and update the lockfile with the
   package manager. Review the dependency diff and any peer changes
   `mantle generate` names.
   With identity `mantle`, inspect auth database upgrade requirements in
   `docs/handbook/cloudflare/authentication.md` before starting the new service.
   Better Auth 1.7.0–1.7.2's required legacy `account.issuer` needs a
   data-preserving host-specific constraint migration when moving to 1.7.7;
   fresh-database success alone does not verify an upgrade. Back up the service's
   own database and retain existing users, sessions, roles and content.
5. Regenerate and check:

```sh
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec tsc --noEmit
```

   An existing PostgreSQL service also follows the upgrade notes in
   `docs/handbook/releases/index.md` (SQL rewrites, `mantle generate` for the
   new dialect version, the regenerated `src/service.ts`).
6. The preset (`src/service.ts`, `src/index.ts`, `src/handlers.ts`,
   `wrangler.jsonc`) is never
   rewritten. Generate into a scratch directory with the same manifests and
   `mantle.config.json`, diff it against the project's files, and apply the
   changes that matter by hand.
7. Run the service locally and test its real routes and sign-in. Before
   deploying a SQLite project, run
   `mantle generate --check --database <local SQLite file>` to see what boot
   will change.

Report the old and new versions, the checks and their results, what changed
in the service files, and what remains. A dependency update does not
authorize a deploy. Never commit secrets.
