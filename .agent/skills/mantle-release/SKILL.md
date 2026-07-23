# Mantle Release Skill

Use this skill for any Mantle release, prerelease, version bump, npm publish, GitHub tag, fanout repair, downstream starter release, or landing deploy caused by an SDK release.

## Required Reading

Read these files before changing versions or pushing tags:

- `docs/release-process.md`
- `CHANGELOG.md`
- `package.json`
- every workspace package `package.json` whose version participates in the release
- `.codex-plugin/plugin.json`, `.claude-plugin/plugin.json`,
  `.copilot-plugin/plugin.json`, and `.cursor-plugin/plugin.json`

For cross-repo fanout work, also inspect the sibling checkouts:

- `../mantle-starters`
- `../mantle-landing`

## First Principle

Published versions are immutable. Once an npm package, GitHub tag, GitHub
release, or starter provision bundle is public, do not force-retag, overwrite,
or pretend the version can be repaired in place.

If a public version is incomplete, fix forward with the next version. For an alpha re-spin, the next alpha must say explicitly in `CHANGELOG.md` that it has no SDK code changes and exists to re-run the release fanout.

## Release Mode

Choose the mode before editing:

- Pre-v0.1 alpha: release from `develop`; tag the merged release commit on `develop`.
- Beta, RC, or stable: promote `develop` to `main`, then tag the `main` release commit.
- Downstream-only repair after a published SDK release: fix forward. Do not edit or retag the already-published version.

## Pre-Tag Gate

Do not push a `v*` tag until every item below is true.

1. Fetch all three repos and identify the intended release version.

   ```bash
   git fetch origin --prune
   git status --short --branch
   ```

2. Confirm all Mantle package and agent plugin manifest versions are aligned
   to the intended version unless an ADR explicitly permits divergence.

3. Run the SDK repo gate.

   ```bash
   pnpm run check
   ```

4. If docs or agent skills changed, inspect the packed umbrella package and verify the package includes the embedded `docs/` and `skills/` payload.

   ```bash
   pnpm -C packages/mantle pack --pack-destination /tmp/mantle-pack
   tar tzf /tmp/mantle-pack/aotter-mantle-*.tgz | rg '^(package/)?(docs|skills)/'
   ```

5. Check downstream readiness before tagging the SDK.

   In `../mantle-starters`, confirm required blank source, overlays, provision
   bundles, the local materializer, and repo-local skills are merged to
   `develop`.

   ```bash
   git -C ../mantle-starters status --short --branch
   pnpm --dir ../mantle-starters check:provision-bundle
   pnpm --dir ../mantle-starters smoke:provision-bundle
   pnpm --dir ../mantle-starters check:repo-local-skills
   pnpm --dir ../mantle-starters check:starter-locks
   ```

   In `../mantle-landing`, confirm prompt, handoff, and UI assumptions are compatible with the intended starter release.

   ```bash
   git -C ../mantle-landing status --short --branch
   pnpm --dir ../mantle-landing check
   ```

6. If a downstream repo still has required, unmerged release content, stop. Merge that content first or plan an explicit next-alpha re-spin. Do not tag the SDK while the downstream release artifact would still be missing required content.

## Fanout Watch

After pushing the tag, watch the whole chain. Do not call the release complete after npm publish alone.

1. `aotter/mantle` release workflow publishes npm packages and dispatches to `mantle-starters`.
2. `aotter/mantle-starters` bump PR updates runtime deps, passes starter gates, merges to `main`.
3. `aotter/mantle-starters` tags `vX.Y.Z` with matching provision bundles.
4. `aotter/mantle-landing` bump PR updates the landing package, passes gates, merges to `main`.
5. `aotter/mantle-landing` deploys production.

Required post-fanout checks:

```bash
gh -R aotter/mantle release view vX.Y.Z
gh -R aotter/mantle-starters release view vX.Y.Z
npm view @aotter/mantle@X.Y.Z version dist-tags --json
```

Clone the matching starters tag and materialize at least one local project.
Verify generated repos include repo-local agent skills:

```bash
git clone --depth 1 --branch vX.Y.Z https://github.com/aotter/mantle-starters.git /tmp/mantle-starters-smoke
pnpm --dir /tmp/mantle-starters-smoke materialize presence --out /tmp/mantle-smoke --brand "Release Smoke"
rg --files /tmp/mantle-smoke | rg '(^|/)\\.agent/skills/mantle-|(^|/)\\.claude/skills/mantle-'
```

Verify production landing renders a handoff that points to the same version:

```bash
curl -fsSL 'https://mantle.tools/skill/install?...' | rg 'vX\\.Y\\.Z|provision-bundles'
```

## Failure Handling

- Failed downstream validate gate before merge: fix the downstream PR, wait for CI, then merge. Do not republish SDK.
- Downstream release artifact is already public but missing required content: publish the next alpha as a re-spin. Do not force-retag.
- Manual downstream `main` fix: immediately backport `main` to `develop` in that repo so the next fanout does not conflict with an older integration branch.
- Workflow re-run is only useful for transient infrastructure failures. If the source state is wrong, fix the source state first.

## Red Flags

Stop and explain the situation to the user if any of these appear:

- The intended release tag already exists.
- npm already has the intended version.
- `mantle-starters/main` contains release changes that are not backported to `mantle-starters/develop`.
- The starter tarball version does not match the SDK version.
- Landing points to a starter tarball version different from the intended release.
- A prompt or skill URL uses a floating branch for production instead of a released tag.
