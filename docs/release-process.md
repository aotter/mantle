# Release process

Mantle remains prerelease software until the stable v0.1.0 gate closes.
Published package versions, Git tags, GitHub releases, and Starter tags are
immutable: repair a bad release with the next version, never by replacing
public state.

## Authority

`.github/workflows/release.yml` is the single release controller. Humans merge
a reviewed release PR and dispatch that workflow from the merge commit. Humans
do not push release tags or start downstream release workers directly.

The controller owns this order:

```text
Core source + exact-packed Starter gates
  -> Core tag
  -> npmjs + GitHub Packages
  -> Starter release worker
  -> immutable Starter tag
  -> public-registry Starter gate
  -> Core GitHub Release
  -> optional Landing worker
```

The Starter worker owns only its repository transition: it prepares a release
PR from the exact gated `develop` commit, waits for the named checks, merges
that checked head atomically into `develop`, and tags the recorded merge
commit. It does not promote `main`, backport, infer releases from commit text,
or dispatch Landing.

Landing is an explicit controller input and defaults off. A release that keeps
`deploy_landing=false` does not mutate or deploy Landing.

## Changing release automation

Before editing a release workflow, put a finite state table plus its
invariants and non-goals in a Draft PR. Name the single mutation boundary for
each external resource; recovery must return through that boundary rather than
introduce a second writer.

Freeze one commit SHA for review. Every finding must name the affected state
row, a concrete event interleaving, and the wrong mutation it permits. A clean
verdict expires when that SHA changes. After two patch rounds, a new
foundational blocker returns to the state table and the user for a scope
decision instead of starting another local redesign loop.

## Branches and channels

- Feature and release PRs target `develop`.
- Alpha prereleases before stable v0.1.0 release directly from the merged
  `develop` release commit.
- Beta, RC, and stable promotion to `main` remains a deliberate human decision;
  it is not part of the alpha controller.
- Alpha, beta, and RC GitHub releases are prereleases.
- npm dist-tags follow the suffix: `alpha`, `beta`, `rc`, or `latest` for
  stable versions.
- During the legacy `0.0.x-alpha` cadence, `latest` follows the current alpha.
  The final `0.1.0-alpha.N` candidates advance only `alpha`; `latest` moves to
  `0.1.0` after the stable gate passes.

## Release PR

1. Fetch Core and Starter remotes and choose the next unused version.
2. Preview GitHub's generated notes for the merged commits since the previous
   tag. Correct PR titles and labels before release; do not duplicate the notes
   in `CHANGELOG.md`. Label the release-only PR `skip-release-notes`.
3. Set that exact version in every workspace package and in all four agent
   plugin manifests. Set `.agents/plugins/marketplace.json` to the immutable
   `v<version>` ref.
4. Pin both the controller and Core CI to the exact reviewed
   `mantle-starters/develop` commit intended for this release. Do not use a
   branch, latest tag, or inferred fallback.
5. If an SDK type changed, audit downstream literal constructors and exhaustive
   switches before publication. CI in Core cannot prove downstream source
   compatibility by itself.
6. Run `pnpm check`, inspect the packed umbrella package, and run the exact
   packed-consumer gate. Review and merge a same-repository PR into `develop`;
   the controller rejects a direct-push release commit.

Preview the native notes before merging the release PR:

```bash
gh api --method POST repos/aotter/mantle/releases/generate-notes \
  -f tag_name=vX.Y.Z \
  -f target_commitish="$(git rev-parse origin/develop)" \
  -f previous_tag_name=vPREVIOUS \
  --jq .body
```

The nine public packages publish in dependency order:

1. `@aotter/mantle-spec`
2. `@aotter/mantle-admin-ui`
3. `@aotter/mantle-runtime`
4. `@aotter/mantle-web`
5. `@aotter/mantle-admin`
6. `@aotter/mantle-bun`
7. `@aotter/mantle-vercel`
8. `@aotter/mantle-cloudflare`
9. `@aotter/mantle`

The umbrella package must contain its version-matched `docs/` and `skills/`
payload. No tarball may contain `workspace:*` dependencies, secrets, local
state, or workspace-only files. Starter content is still authored and released
from the versioned `mantle-starters` repository — Core owns no starter source.
Core's umbrella CLI is the canonical consumer of that release: `mantle create`
resolves the official immutable `v${packageVersion}` starter tag and renders it
through Core's shared provision module. A published Core version
therefore requires the matching starter tag to exist; see
[ADR-0018](adr/0018-core-starters-repository-boundary.md).

## Run the controller

Dispatch `.github/workflows/release.yml` from the merged release commit with:

- `version`: the version without the leading `v`.
- `deploy_landing`: `false` unless Landing was separately reviewed and is
  intentionally part of this release.

Before creating the Core tag, the controller proves:

- the requested version matches every package, plugin, and marketplace ref;
- `pnpm check` passes;
- packed Core passes in the exact pinned Starter source;
- all nine release tarballs exist;
- npm and cross-repository credentials are present and readable;
- a fresh version is unused across npmjs, GitHub Packages, and Starter tags;
- the pinned Starter commit is still the remote `develop` tip.

After npm publication, it compares each public registry integrity value with
the locally packed tarball, rejects leaked `workspace:*` dependencies, waits
for the Starter tag, checks that tag's exact Core/base provenance, installs its
frozen locks from the public registry, and reruns the Starter bundle gates.
Only then does it create the Core GitHub Release.

## Idempotency and recovery

The global controller lock serializes releases. Re-running the same release is
supported:

- an existing Core tag must resolve to the same controller commit;
- existing npm and GitHub Packages versions are verified and skipped;
- channel dist-tags are never moved backward by an older rerun;
- a duplicate Starter dispatch resumes its open/merged state or reports a
  tagged no-op;
- an existing GitHub Release is a no-op.

If source or immutable state disagrees, the workflow fails instead of guessing.
Fix source and publish the next version when public state is wrong. Re-run the
same controller only for a transient failure or a verified partial transition.
Never force-retag or republish an existing version.

## Credentials

Core repository secrets:

| Secret | Minimum purpose |
|---|---|
| `NPM_TOKEN` | Publish the nine `@aotter/*` packages on npmjs. |
| `RELEASE_FANOUT_TOKEN` | Read and dispatch `aotter/mantle-starters`; also read and dispatch `aotter/mantle-landing` only when Landing is enabled. |

Core's job-scoped `GITHUB_TOKEN` creates the Core tag and release and mirrors
packages to GitHub Packages. Starter's job-scoped token pushes its generated
branch, checked merge, and tag; its `RELEASE_FANOUT_TOKEN` is used only to
create the canonical same-repository PR. Prefer separate fine-grained tokens
or a GitHub App when practical; do not grant organization-wide repository
access for this flow.

## Post-release verification

Completion requires evidence for both repositories, not only a green publish
step:

```bash
gh -R aotter/mantle release view vX.Y.Z
gh api repos/aotter/mantle-starters/git/ref/tags/vX.Y.Z

for p in \
  @aotter/mantle-spec \
  @aotter/mantle-admin-ui \
  @aotter/mantle-runtime \
  @aotter/mantle-web \
  @aotter/mantle-admin \
  @aotter/mantle-bun \
  @aotter/mantle-vercel \
  @aotter/mantle-cloudflare \
  @aotter/mantle; do
  npm view "$p@X.Y.Z" version dist.integrity dependencies --json
done
```

Clone the exact Starter tag into a fresh directory, install with frozen locks,
run its bundle gates, and materialize at least one typed project. Confirm the
generated project contains version-matched repo-local Mantle skills and the
expected typed runtime surface. `blank` remains headless and contains no Kiwa;
a typed Starter revision may retain its replaceable offline UI palette, but
runtime code must not import it.

If `deploy_landing=false`, also verify that no Landing release dispatch or
deployment was started.

## Fix-forward policy

- Broken public package or Starter bundle: publish the next alpha and explain
  the re-spin in the fix PR and generated GitHub Release notes.
- Use `npm deprecate` to steer consumers away from a broken version.
- Unpublish only for secrets, private files, or similarly severe exposure;
  npm versions cannot be reused and registry metadata may remain unavailable
  during the unpublish cooldown.
- A cross-cutting rename must include an explicit infrastructure-config diff
  and live smoke test. CI success does not prove renamed Worker, D1, KV, route,
  or secret bindings are correct.
