# Release process

How a version reaches npm. What each shipped stable contains is
[Releases](handbook/releases/index.md); this document is the procedure only.
A release has no Starter/Landing checkout, tag, dispatch, credential or
deployment dependency.

## Authority and state transitions

`.github/workflows/release.yml` is the only release controller. Humans merge
a reviewed same-repository release PR, then explicitly dispatch that merge.
No task implicitly authorizes publication; no manual package/tag writer exists.

| State | Sole next writer | Retry / invariant |
|---|---|---|
| Reviewed source; unused version | Core source/packed-consumer gates, then immutable Core tag | Exact canonical merged PR SHA and version required |
| Tag exists; registry candidates partial | Existing npm/GPR publication steps | Verify existing artifact identity; publish missing versions only |
| Tag exists and all eleven npmjs packages already exist | Metadata verify, then channel promote and the GitHub release | Skip pack and immutable tarball compare. The controller tip must not rebuild published artifact identity. npm integrity metadata still has to be `sha512`. The public-registry Worker gate stays skipped |
| Tag exists on an ancestor of the dispatched tip; tip package versions still match | Resolve binds release identity to the tag SHA; later steps stay the existing writers | Controller-only recovery. Do not retag. The canonical merged-PR check uses the tag SHA. Fail when the tip version differs or the tag commit is not an ancestor |
| Registry candidates verified | Public-registry reference consumer gate | No mutation; failure leaves public channels and `mantle-release` unchanged |
| Consumer passes | That registry's promote step: monotonic channel add for every package | Same version is a no-op; older runs cannot move a channel backward. Public channels are only `alpha`, `beta`, `rc`, and `latest`. `mantle-release` is never removed |
| Channels promoted or preserved | GitHub release step | Existing release identity or fail. Leftover `mantle-release` pointing at the last published candidate is expected |

The public-registry gate uses a disposable copy of the directly authored
`docs/examples/host-minimal-worker` reference, installs the exact candidate, then
checks generation, skill projection, TypeScript and real Worker HTTP behavior.
The same reference is gated against exact tarballs before Core tagging. It is
a test/example, not a scaffold product or another repository release.

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

Invariants: immutable versions/tags retain their identity; registry integrity
and the published-consumer gate precede public channel promotion; retries
cannot move channels backward. No downstream mutation, unpublish, dist-tag
removal, or rollback is introduced. The runnable release-order check guards
these transitions.

Mutation boundaries during a release: `Publish to npmjs` and `Mirror to
GitHub Packages` attach the internal candidate dist-tag `mantle-release`
while publishing a version. `Promote npmjs channel tags` is the only
release step that moves npmjs public channels. `Promote GitHub Packages
channel tags` is the only release step that moves GitHub Packages public
channels. Neither step removes `mantle-release`. Recovery of a partial
release reruns that same controller and version.

`mantle-release` is not a public channel. It stays forever as an internal
candidate tag pointing at the last published candidate. Official channels
are only `alpha`, `beta`, `rc`, and `latest`. Consumers must not install
`mantle-release`. Deleting it after promotion is not part of the release:
dist-tag DELETE only added failure and re-run state, and Actions
`NPM_TOKEN` 403s on that DELETE.

## Branches and channels

| Version | Source branch | npm dist-tag | GitHub release |
|---|---|---|---|
| `X.Y.Z-alpha.N` | `develop` | `alpha` | prerelease |
| `X.Y.Z-beta.N` | `main` | `beta` | prerelease |
| `X.Y.Z-rc.N` | `main` | `rc` | prerelease |
| `X.Y.Z` | `main` | `latest` | release |

- The controller derives the source branch from the version: `-alpha` means
  `develop`, anything else means `main`. An untagged dispatch must be that
  branch's tip and the merge commit of exactly one PR into that branch.
  When the version tag already exists on an ancestor of the tip, Resolve
  recovers from that tag SHA; see Recovery.
  `scripts/release-tag-order.mjs` rejects any other prerelease identifier.
- `develop` is where every change integrates first, so it is the base for all
  work despite `main` being the repository's default branch on GitHub. `main`
  changes only through promotion PRs and hotfix PRs (below); it is never pushed
  directly, rebased or force-updated. Both branches share one ruleset: PR, one
  approval, resolved threads and a current-base `Typecheck + tests` check.
- Stable is the only release that moves `latest`. A prerelease channel keeps
  its last version when a later stable publishes.
- Publish uses `--tag mantle-release`. `mantle-release` is an internal
  candidate dist-tag, not a public channel. Consumers must not install it.
  Official channels are only `alpha`, `beta`, `rc`, and `latest`.
  Publication does not move those channels. After the public-registry
  consumer gate, each registry's promote step moves every package's real
  channel and leaves `mantle-release` pointing at the last published
  candidate.

## Prepare and run

1. Fetch Core refs, prove the version and tag unused. Preview GitHub generated
   notes since the previous tag; correct PR metadata and label release-only
   PRs skip-release-notes. Do not duplicate release entries in CHANGELOG.md.
2. Align every workspace package, plugin and marketplace ref to the version.
   The controller checks package.json files and plugin manifests only; docs
   pins and the admin-ui registry dependency are hand-edited, so grep for the
   old version until only lockfiles and registry-pinned examples remain:

   ```sh
   OLD=<previous version> NEW=<version>
   git grep -l "\"version\": \"$OLD\"" -- '*.json' ':!**/package-lock.json' \
     | xargs perl -pi -e "s/\"version\": \"\Q$OLD\E\"/\"version\": \"$NEW\"/"
   node scripts/sync-plugin-manifests.mjs
   git grep -n "$OLD" -- ':!pnpm-lock.yaml' ':!**/package-lock.json'
   ```

3. Review API compatibility and migration instructions for actual consumers.
   Frozen legacy consumers stay on their pinned version; do not make them
   follow new Core.
4. Run `pnpm check`, including exact packed Worker, optional products, Bun,
   Vercel, skills, release invariants, types and tests. Inspect the umbrella
   docs/skills payload: no workspace dependencies, secrets or local state.
5. Freeze the PR head for self review; CI must pass before merge. Merge into
   `develop` with a merge commit for every version. For an alpha, dispatch
   release.yml from that merge with `version` (without v). For beta, RC and
   stable, continue with the promotion below. The controller refuses an
   untagged source that is no longer the expected branch tip.

The eleven public packages remain in dependency order:

1. @aotter/mantle-spec
2. @aotter/mantle-admin-ui
3. @aotter/mantle-runtime
4. @aotter/mantle-indexeddb
5. @aotter/mantle-web
6. @aotter/mantle-admin
7. @aotter/mantle-auth
8. @aotter/mantle-bun
9. @aotter/mantle-vercel
10. @aotter/mantle-cloudflare
11. @aotter/mantle

## Promote to main (beta, RC, stable)

Every non-alpha release is the version PR above, one promotion PR and one
dispatch. The version PR still merges into `develop`, so `develop` always
contains what `main` publishes and promotions never conflict.

1. Stable only: the version's release-gate issue records owner acceptance.
   Every gate item passes with linked evidence or is explicitly deferred
   there, and no `release-gate` issue stays open against the version.
   Beta and RC need the gate defined, not passed.
2. Merge the version PR into `develop` with a merge commit; note its SHA.
3. Pin the promotion head at that SHA so later `develop` merges cannot ride
   along, then open the promotion PR against `main`:

   ```sh
   git fetch origin
   git push origin <develop merge SHA>:refs/heads/promote/<version>
   gh pr create --base main --head promote/<version> \
     --title "release: promote <version> to main" --label skip-release-notes
   ```

   The body names the version PR, the pinned SHA and the gate evidence. The
   usual review and checks apply. An organization-admin bypass merge must be
   recorded on the PR (see CONTRIBUTING).
4. Merge with a merge commit, never rebase: the controller needs `main`'s tip
   to be the PR's merge commit. `main`'s tree now equals the pinned commit.
5. Dispatch from `main` and watch every gate exactly as for an alpha:

   ```sh
   gh workflow run release.yml --ref main -f version=<version>
   ```

6. RC to stable repeats 2–5 with the next version. `rc` keeps pointing at
   the last RC; stable moves only `latest`.

Hotfix on `main` is for a published non-alpha version that cannot wait for
the next promotion. Branch from `main`, include the version bump, PR into
`main`, dispatch as in step 5, then immediately PR `main` back into `develop`
and resolve version files in favour of `develop`. Until that lands, the next
promotion conflicts on the version files.

GitHub generates notes from the immediately previous tag, which for a stable
is usually its own last RC. To cover the whole line instead, regenerate from
the previous stable and edit the release body after the run. The body is not
an immutable artifact; the tag and packages are.

```sh
gh api repos/aotter/mantle/releases/generate-notes \
  -f tag_name=v<version> -f previous_tag_name=v<previous stable> --jq .body > notes.md
gh release edit v<version> --notes-file notes.md
```

Add the version's entry to [Releases](handbook/releases/index.md) in the same
pass, so the handbook and the GitHub release describe the same thing.

After publication, move docs/examples that were pinned to a packed checkout
back to registry installation with an updated lockfile, and close the gate
issue with the run link and completion evidence.

## Credentials and verification

Core needs NPM_TOKEN for npmjs. Its job-scoped GITHUB_TOKEN creates the Core
tag/release and mirrors GitHub Packages. No cross-repository fanout token is
needed. Before tagging, verify credentials and new-version absence on both
registries. Existing artifacts on retry must have matching integrity.

Completion requires the Core tag SHA, all eleven npmjs/GPR packages, exact
integrity, no workspace dependencies, a passing public-registry Worker gate,
correct channel tags, and the GitHub release. Leftover `mantle-release`
pointing at the last published candidate is expected. Retain run links and
gate evidence.
This does not prove stable production soak or upgrade safety; the version's
release-gate issue owns those acceptance requirements. An agent acceptance run
uses only the version-matched authoring instructions, not an SDK checkout or
generated site.

## Recovery

Rerun the same controller commit/version for a transient or verified partial
transition. Existing tags/artifacts must match; newer channels stay put. Fail
on identity disagreement instead of guessing. A wrong public artifact needs
a new version; never force-retag, overwrite or reuse a published version.

After a controller-only fix lands on the tip, re-dispatch the same version
from the source branch. Resolve recovers using the existing tag SHA when
that commit is an ancestor of the tip and package versions on the tip still
match. The tag owns the release SHA; the tip only carries controller fixes.
Tagged recovery skips the Core source check because that tree was already
released from the immutable tag. When `tag_exists` and all eleven npmjs
packages already exist at that version, that same existence check skips
packing, immutable tarball comparison, and the public-registry Worker gate.
The controller tip must not rebuild an artifact whose identity is already
published. Verify npm metadata still runs. The Worker gate stays skipped
because the first run already passed it before promotion.

Unpublish is reserved for actual secret/private-file exposure, never routine
fixes. Infrastructure renames require their explicit config diff and live
smoke; CI alone cannot prove provider identity.
