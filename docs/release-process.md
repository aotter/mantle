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
| Tag exists and all three npmjs packages already exist | Metadata verify, then channel promote and the GitHub release | Skip pack and immutable tarball compare. The controller tip must not rebuild published artifact identity. npm integrity metadata still has to be `sha512`. The public-registry Worker gate stays skipped |
| Tag exists on an ancestor of the dispatched tip; tip package versions still match | Resolve binds release identity to the tag SHA; later steps stay the existing writers | Controller-only recovery. Do not retag. The canonical merged-PR check uses the tag SHA. Fail when the tip version differs or the tag commit is not an ancestor |
| Registry candidates verified | Public-registry reference consumer gate | No mutation; failure leaves public channels and `mantle-release` unchanged |
| Consumer passes | That registry's promote step: monotonic channel add for every package | Same version is a no-op; older runs cannot move a channel backward. Public channels are only `alpha`, `beta`, `rc`, and `latest`. `mantle-release` is never removed |
| Channels promoted or preserved | GitHub release step | Existing release identity or fail. Leftover `mantle-release` pointing at the last published candidate is expected |

The public-registry gate (`scripts/check-worker-consumer.mjs --registry`) uses
a disposable copy of the directly authored `docs/examples/reference-service`,
installs the exact candidate, then runs its `pnpm check`: `mantle generate`,
`generate --check`, TypeScript and a real `wrangler dev` smoke test.
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
dist-tag DELETE only added failure and re-run state.

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
  On a PR into `main` that check is the whole Full checks suite, for every
  author. On a ready PR into `develop` it is the PR CI (`ci.yml`: typecheck,
  package tests against a PostgreSQL service and `test:native`), for every
  author; on a draft it is skipped, which counts as passing.
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
   Once the version's entry in [Releases](handbook/releases/index.md) is
   written, run `node scripts/check-breaking.mjs --release-notes <version>
   [--since <tag>]` (needs `gh`, tags and full history): it fails for every PR
   labelled `breaking-change` and merged since `--since` that the version's
   section does not mark breaking (a Breaking heading, a `**Breaking` item, or
   a paragraph starting "Breaking" and the list after it). `--since` defaults
   to the previous tag for a prerelease and to the previous stable tag for a
   stable, whose section covers the whole line.
   A version past a removed-subpath stub's `removeAfter` fails
   `scripts/check-breaking.mjs` (in `pnpm check`) until the version PR deletes
   that stub ([CONTRIBUTING](../CONTRIBUTING.md#removed-public-subpaths)).
2. Align every workspace package, plugin and marketplace ref to the version.
   The controller checks package.json files and plugin manifests only; docs
   pins and the reference service's exact `@aotter/mantle*` dependencies are
   hand-edited, so grep for the old version until only lockfiles and
   registry-pinned examples remain:

   ```sh
   OLD=<previous version> NEW=<version>
   git grep -l "\"version\": \"$OLD\"" -- '*.json' ':!**/package-lock.json' \
     | xargs perl -pi -e "s/\"version\": \"\Q$OLD\E\"/\"version\": \"$NEW\"/"
   node scripts/sync-plugin-manifests.mjs
   git grep -n "$OLD" -- ':!pnpm-lock.yaml' ':!**/package-lock.json'
   ```

   The consumer skill and installation docs are version-neutral (`skills/README.md`):
   they route to `mantle help`, so a release changes no skill or install command.
   Update the versioned reference-service links. The new tag exists only after the
   controller creates it; do not create it manually.

3. Review API compatibility and migration instructions for actual consumers.
   Frozen legacy consumers stay on their pinned version; do not make them
   follow new Core.
4. Run `pnpm check:pg` (`pnpm check` and `test:native` against a throwaway
   PostgreSQL), including the reference service from exact packed
   tarballs, skills, release invariants, types and tests; plain `pnpm check`
   skips every PostgreSQL test. The version PR body says which of the two ran.
   The controller runs
   the same `pnpm check` against a PostgreSQL service (`MANTLE_PG_URL`), then
   four-target native conformance (`test:native`), before it tags. Inspect the `@aotter/mantle` docs payload
   (`scripts/sync-package-docs.mjs`: the upgrade guide, handbook, selected
   runnable examples, workflow skills and plugin skill): no workspace
   dependencies, secrets or local state. ADRs and the reference-service source
   stay in the repository; packaged links to them must use a versioned URL.
   Run `pnpm check:init-audit` (`scripts/check-init-audit.mjs`; needs the
   network and `pnpm build`): it runs `mantle init` into a temp directory, points
   its `@aotter/mantle*` pins at freshly packed tarballs, resolves every other
   pin from the public registry and fails on any high or critical
   `npm audit` advisory, dev dependencies included. The controller runs the
   same gate before it tags. On failure, bump the
   `docs/examples/app-shell/package.json` pins (Wrangler together with a
   `@cloudflare/workers-types` that satisfies its peer range), align
   `docs/examples/reference-service` and the SDK's own Wrangler devDependency,
   and run `pnpm install` so `pnpm-lock.yaml` follows.
   Run the maintainer release skill's
   [startup and request-cost checkpoint](../.agents/skills/mantle-release/SKILL.md#startup-and-request-cost-checkpoint)
   when its auth/kernel/generator trigger applies and before every alpha or beta.
   Before every release, alpha included, run Linux Full checks
   (`gh workflow run full-checks.yml --ref <version PR branch>`) on the frozen
   version PR head, and link the green run from the version PR. A promotion
   PR into `main` runs the same workflow by itself.
5. Freeze the PR head for self review; that Full checks run must pass before
   merge, besides the PR's own `develop` CI, which runs `test:native` but not
   Full checks' Wrangler/D1 integration step, the CLI and Admin native-server
   tests, worker-consumer, examples, doc examples, OSS plugin, Chrome or size
   checks. Merge into
   `develop` by rebase or with a merge commit: the controller needs the tip to
   be the commit GitHub records as that PR's merge, which both produce. A
   promotion into `main` is different and always takes a merge commit (below).
   For an alpha, dispatch release.yml from that tip with `version` (without v). For beta, RC and
   stable, continue with the promotion below. The controller refuses an
   untagged source that is no longer the expected branch tip.

The three public packages, in dependency order:

1. @aotter/mantle-ui — pure shared UI/controller/kit.
2. @aotter/mantle — the single native Core SDK, compiler, generator and CLI.
3. @aotter/mantle-admin — optional Admin server, SPA and MCP App; SDK is a peer.

All three versions stay in lockstep. The same package list drives existence,
packing, registry verification and channel promotion; partial publication must
not bypass the consumer gate. Frozen legacy releases retain their tagged
controller and two-package topology. This migration does not authorize a
release or reusing an already published version.

A `0.2.0-alpha.N` publishes on the same `alpha` channel as every alpha: the
controller owns channels, so `publishConfig.tag` never picks one. Promoting it
moves `@alpha` from 0.1.x to the breaking 0.2 line, and a later 0.1.x alpha
would no longer promote, since the two lines do not order. Like every alpha it
dispatches from `develop`, so the 0.2 line is released only after `0.2.x` is
merged there: a same-repository PR from `0.2.x` into `develop`, merged with a
merge commit. That merge is the dispatch source of an alpha whose version the
branch already carries; otherwise the version PR follows it. A separate `next`
channel for 0.2 would need a controller change first.

## Promote to main (beta, RC, stable)

Every non-alpha release is the version PR above, one promotion PR and one
dispatch. The version PR still merges into `develop`, so `develop` always
contains what `main` publishes and promotions never conflict.

1. Stable only: the version's release-gate issue records owner acceptance.
   Every gate item passes with linked evidence or is explicitly deferred
   there, and no `release-gate` issue stays open against the version.
   Beta and RC need the gate defined, not passed.
2. Merge the version PR into `develop`; note the SHA of the resulting tip.
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

### What the handbook's release notes keep

The handbook records how to upgrade from one stable release to the next.
Prerelease notes are working notes for people testing that prerelease, not a
permanent record:

- An alpha, beta or RC entry is short: what to pin, what a tester must change
  to keep running, and what is not yet verified. It does not need a full
  migration guide for a change that a later prerelease may reshape or undo.
  GitHub's generated notes already list every merged PR.
- Brief never drops a breaking item. Each one is a `**Breaking: …**` item (or
  sits under a Breaking heading) that references its PR and gives one
  before → after line plus either the replacement or "no replacement yet"
  with an issue link. The PR's Migration section is its source, and a fix,
  feature or PR body is never the only place a break is announced.
- When the stable is cut, replace that line's prerelease subsections with one
  "Upgrading from `<previous stable>`" section that describes the final state
  only, with full upgrade notes for each breaking item: what to change, the
  replacement, and the stubs that release still ships. A change that was
  introduced and then reworked or reverted between prereleases appears once,
  as it shipped, or not at all.
- Do not edit the notes of a prerelease that is already published to match
  this: its packed docs are immutable. Apply it from the next version PR on.

After publication, move docs/examples that were pinned to a packed checkout
back to registry installation with an updated lockfile, and close the gate
issue with the run link and completion evidence.

## Credentials and verification

npmjs authentication is npm
[trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC): the
repository holds no npm token. npmjs.com trusts the workflow file
`release.yml` of this repository running in the GitHub environment
`npm-publish`, and npm exchanges the job's identity for a short-lived
credential at `npm publish` and `npm dist-tag add`. Provenance is attached
automatically. Job-scoped GITHUB_TOKENs create the Core tag and release and
mirror GitHub Packages. No cross-repository fanout token is needed.

The controller is a chain of jobs, each with only the permissions it needs:

| Job | Does | Permissions |
|---|---|---|
| `prepare` | Resolve state, source gates, pack; tarballs travel as a run artifact | `contents: read`, `pull-requests: read` |
| `publish` | Preflight, Core tag, npmjs publish, metadata and artifact verification | `contents: write`, `packages: read`, `id-token: write`; environment `npm-publish` |
| `mirror` | GitHub Packages mirror | `contents: read`, `packages: write` |
| `consumer` | Public-registry reference Worker gate | `contents: read` |
| `promote` | npmjs channel dist-tags | `contents: read`, `id-token: write`; environment `npm-publish` |
| `release` | GitHub Packages channel dist-tags, GitHub release | `contents: write`, `packages: write` |

Every step of a job with `id-token: write` can mint the identity npmjs
trusts. `publish` and `promote` therefore install no dependencies and run no
package code: only npm and the dependency-free
`scripts/verify-release-artifact.mjs` and `scripts/release-tag-order.mjs`.
Keep it that way when editing them; the release self-test fails otherwise.
Both install an exact npm (`OIDC_NPM_VERSION` in the workflow): trusted
publishing needs npm 11.5.1 or later for `npm publish`, 11.21.0 or later for
`npm dist-tag`, and Node 22.14.0 or later, on a GitHub-hosted runner.

If the `npm-publish` environment has required reviewers, a release waits for
approval twice: before `publish` and before `promote`.

Before tagging, the preflight proves new-version absence on both registries
and that the job token reads GitHub Packages. Existing artifacts on retry
must have matching integrity. It cannot prove npmjs write access: OIDC does
not authenticate `npm whoami` or `npm access`. A missing, expired or
mismatched trusted publisher therefore fails at `npm publish`, after the
immutable tag exists; see Recovery.

### One-time npmjs.com setup

For each of `@aotter/mantle-ui`, `@aotter/mantle` and `@aotter/mantle-admin`:
npmjs.com → Packages → the package → Settings → Trusted publishing → GitHub
Actions, with

- Organization or user: `aotter`
- Repository: `mantle`
- Workflow filename: `release.yml`
- Environment name: `npm-publish`
- Allowed actions: publishing with `npm publish`, and **Allow npm dist-tag**

Every field is case-sensitive and the environment name must match the
workflow's exactly. A new configuration expires unless its first publish
succeeds within 2 days, and an expired one cannot be edited, only deleted and
recreated: create them shortly before the next release.

Completion requires the Core tag SHA, all three npmjs/GPR packages, exact
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
released from the immutable tag. When `tag_exists` and all three npmjs
packages already exist at that version, that same existence check skips
packing, immutable tarball comparison, and the public-registry Worker gate.
The controller tip must not rebuild an artifact whose identity is already
published. Verify npm metadata still runs. The Worker gate stays skipped
because the first run already passed it before promotion.

When `npm publish` fails because the trusted publisher is missing, expired
or does not match (workflow filename, environment name, allowed actions), the
tag already exists and nothing is published. Fix the configuration on
npmjs.com and dispatch the same version again from the same branch: the
controller finds the tag, skips the source gates, packs, and publishes what
is missing. The same holds when `npm dist-tag add` is refused in `promote`
because **Allow npm dist-tag** is off: the packages are published and
verified, and a second dispatch only promotes.

Unpublish is reserved for actual secret/private-file exposure, never routine
fixes. Infrastructure renames require their explicit config diff and live
smoke; CI alone cannot prove provider identity.
