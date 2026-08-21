# Mantle Release Skill

Use this skill for a Mantle version bump, npm publish, Core or Starter tag,
release recovery, or an explicit Landing release caused by Core.

## Required reading

Before changing a version or running the controller, read completely:

- `docs/release-process.md`
- root and workspace `package.json` files
- all four agent plugin manifests
- `.agents/plugins/marketplace.json`
- `.github/workflows/release.yml`

Inspect the exact `mantle-starters` and `mantle-landing` commits pinned by the
controller. Inspect Landing deployment configuration only when
`deploy_landing=true` is explicitly in scope.

When changing release automation, follow `docs/release-process.md` section
"Changing release automation" before editing workflow code.

## Contract

Public versions and tags are immutable. `.github/workflows/release.yml` is the
only release controller. Do not push a release tag, invoke the Starter worker,
or repair public state manually.

For the current pre-v0.1 alpha cadence:

- merge a reviewed release PR into `develop`;
- dispatch the controller from that merge commit;
- leave `deploy_landing=false` unless Landing was separately reviewed.

The controller gates source and exact-packed Starter before tagging Core,
publishes and verifies the registries, waits for the Starter's exact tagged
merge, then tests the Starter, clean-created projects, and reviewed Landing
consumer before public channel promotion and the Core GitHub Release. Starter
does not promote `main`, backport, or dispatch Landing.

## Prepare the release PR

1. Fetch Core and Starter remotes. Prove the intended version and both tags are
   unused.
2. Preview GitHub's generated notes since the previous tag. Correct PR metadata
   and apply `skip-release-notes` to the release-only PR.
3. Align every workspace package, plugin manifest, and marketplace ref to the
   exact version.
4. Pin the controller and Core CI to the reviewed Starter `develop` commit.
   Never substitute a branch or floating tag.
5. Audit downstream literals when an SDK type or closed enum changed.
6. Run:

   ```bash
   pnpm check
   node scripts/check-packed-consumer.mjs --self-test
   ```

7. Inspect the diff and packed umbrella payload. Merge a same-repository PR
   only after CI and review pass; direct-push commits are not releasable.

## Run and watch

Dispatch `release.yml` with the version without `v`. Watch until all of these
are proven:

1. Core tag resolves to the release merge commit.
2. All nine npmjs artifacts exist with matching integrity and no `workspace:*`.
3. GitHub Packages mirrors exist.
4. Starter's canonical release PR passes the named gates, merges into
   `develop`, and its tag resolves to that recorded merge.
5. The frozen Starter tag passes the public-registry bundle gate.
6. Clean Blank and multilingual Transaction projects install and pass checks.
7. The reviewed Landing consumer passes against the exact candidate.
8. The Core GitHub Release exists.
9. Landing was dispatched only when the input was explicitly true.

Then give a coding agent with no Mantle checkout only the generated instructions
and confirm one project reaches a running Worker with the version-matched
repo-local skills and intended runtime surface.

## Recovery

- Transient or partial run: rerun the same controller commit and version. Each
  existing mutation must verify exact identity or fail; an older rerun must
  never move a registry channel tag backward.
- Wrong public artifact: fix forward with the next version. Never force-retag,
  overwrite, or reuse an npm version.
- Missing or stale Starter source: merge the Starter correction first, then
  pin that exact SHA in the next Core release PR.
- Closed/non-canonical Starter release PR, mismatched tag, advanced gated base,
  or missing credential: stop and repair the explicit state. Do not guess a
  fallback branch, commit, or tag.
