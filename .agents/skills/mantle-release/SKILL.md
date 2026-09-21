# Mantle Release Skill

Use for explicit version bumps, publication, tagging and release recovery.
Read fully before acting: docs/release-process.md, .github/release.yml,
root/workspace package.json files, all four plugin manifests, marketplace
manifests and .github/workflows/release.yml. Workflow edits require the Draft
PR state table in the release process before editing code.

The sole controller is release.yml. Public versions/tags are immutable; never
publish/tag manually. New Core releases have no Starter/Landing dispatch or
checkout dependency. Alpha.17 remains the untouched legacy contract.

Prepare a same-repository release PR: prove the new version/tag unused,
preview native release notes and correct PR metadata, align package/plugin
versions, inspect the packed docs/skills payload, run `pnpm check` and review
its exact SHA. The reference consumer gate runs from packed packages outside
workspace links. Merge into develop for every version. Beta, RC and stable
then follow "Promote to main" in docs/release-process.md: pin
`promote/<version>` at that develop merge SHA, PR it into main, merge with a
merge commit, dispatch with `--ref main`. Stable also needs recorded owner
acceptance on the release-gate issue (#826 for 0.1.2). Do not infer permission
to publish from an implementation PR.

Dispatch the controller from the reviewed release merge with the version
without v. Watch all gates, not only publication:

1. Core tag resolves to that canonical merge.
2. All ten npmjs artifacts exist with matching integrity and no workspace:*.
3. GitHub Packages mirrors verify the same candidate.
4. The reference Worker installs exact public packages, generates/types/checks
   successfully and serves its declared HTTP route before channel promotion.
5. Monotonic channel promotion and the GitHub prerelease/release succeed.

For first stable acceptance (#826), give an agent only the version-matched
consumer instructions and confirm a directly authored application reaches a
running Worker. No SDK checkout or scaffold command is required.

Transient/partial failures rerun the same controller commit/version. Verify
existing state, preserve newer channels, and fail on identity disagreement.
Wrong public artifacts require a new version; never overwrite or force-retag.
Legacy alpha.17 recovery follows the controller and docs at its immutable tag,
not the new release workflow. No legacy repositories or deployments are changed
by a new Core release.
