# Mantle Release Skill

Use for explicit version bumps, publication, tagging and release recovery.
Read fully before acting: docs/release-process.md, .github/release.yml,
root/workspace package.json files, all four plugin manifests, marketplace
manifests and .github/workflows/release.yml. Workflow edits require the Draft
PR state table in the release process before editing code.

The sole controller is release.yml. Public versions/tags are immutable; never
publish/tag manually. New Core releases have no Starter/Landing dispatch or
checkout dependency; the frozen legacy line is never changed by one.

Prepare a same-repository release PR: prove the new version/tag unused,
preview native release notes and correct PR metadata, align package/plugin
versions, inspect the packed docs/skills payload, run `pnpm check` and review
its exact SHA. The reference consumer gate runs from packed packages outside
workspace links. Merge into develop for every version. Beta, RC and stable
then follow "Promote to main" in docs/release-process.md: pin
`promote/<version>` at that develop merge SHA, PR it into main, merge with a
merge commit, dispatch with `--ref main`. Stable also needs recorded owner
acceptance on the version's release-gate issue, and its entry added to
docs/handbook/releases/index.md. Do not infer permission to publish from an
implementation PR.

Dispatch the controller from the reviewed release merge with the version
without v. Watch all gates, not only publication:

1. Core tag resolves to that canonical merge.
2. All eleven npmjs artifacts exist with matching integrity and no workspace:*.
3. GitHub Packages mirrors verify the same candidate.
4. The reference Worker installs exact public packages, generates/types/checks
   successfully and serves its declared HTTP route before channel promotion.
5. Monotonic channel promotion succeeds for every package. Each promote
   step then attempts to remove the temporary `mantle-release` dist-tag on
   npmjs and GitHub Packages when it points at this version. A failed
   removal warns and continues. The GitHub prerelease or release succeeds.
   `alpha` / `beta` / `rc` / `latest` are never removed.

For stable acceptance, give an agent only the version-matched consumer
instructions and confirm a directly authored application reaches a running
Worker. No SDK checkout or scaffold command is required.

A leftover `mantle-release` tag from a commit that predates removal is not
cleared by retrying that commit. Actions `NPM_TOKEN` currently 403s on
dist-tag DELETE, so the release controller warns and continues. The cleanup
workflow stays a strict DELETE and is not a release: it deletes only that
tag, and only when a consumer channel already points at the same version.
It needs a token that can `rm`; the current Actions token does not. After
`remove-mantle-release-dist-tag.yml` is on develop:

```sh
gh workflow run remove-mantle-release-dist-tag --ref develop -f confirm=remove-mantle-release
```

Transient/partial failures rerun the same controller commit/version. A
workflow fix can instead be dispatched from the current source-branch tip:
the existing tag is not moved, and the job packs that tagged commit before
promoting. Verify existing state, preserve newer channels, and fail on
identity disagreement.
Wrong public artifacts require a new version; never overwrite or force-retag.
Legacy recovery follows the controller and docs at that version's immutable
tag, not the current release workflow. No legacy repositories or deployments
are changed by a new Core release.
