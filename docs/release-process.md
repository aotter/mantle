# Release process

First stable targets 0.1.2 (#826). The last legacy Landing/Starter release is
0.1.0-alpha.17. Its immutable artifacts and repositories remain available;
recover that version with its tagged controller/docs. New releases have no
Starter/Landing checkout, tag, dispatch, credential or deployment dependency.

## Authority and state transitions

`.github/workflows/release.yml` is the only release controller. Humans merge
a reviewed same-repository release PR, then explicitly dispatch that merge.
No task implicitly authorizes publication; no manual package/tag writer exists.

| State | Sole next writer | Retry / invariant |
|---|---|---|
| Reviewed source; unused version | Core source/packed-consumer gates, then immutable Core tag | Exact canonical merged PR SHA and version required |
| Tag exists; registry candidates partial | Existing npm/GPR publication steps | Verify existing artifact identity; publish missing versions only |
| Registry candidates verified | Public-registry reference consumer gate | No mutation; failure leaves public channels unchanged |
| Consumer passes | Monotonic npm/GPR channel promotion | Same version is a no-op; older runs cannot move a channel backward |
| Channels promoted/preserved newer | GitHub release step | Existing release identity or fail |

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
cannot move channels backward. No downstream mutation, unpublish or rollback
is introduced. The runnable release-order check guards these transitions.

## Branches and channels

- Alpha releases use the reviewed develop merge. Beta/RC/stable use main after
  explicit promotion; first stable acceptance is tracked by #826.
- Alpha/beta/RC GitHub releases are prereleases; their npm tags match suffixes.
- Stable publishes latest. Final 0.1.0 alphas only advance alpha, preserving
  existing legacy latest. Historic 0.0 alpha behavior remains recoverable.

## Prepare and run

1. Fetch Core refs, prove the version and tag unused. Preview GitHub generated
   notes since the previous tag; correct PR metadata and label release-only
   PRs skip-release-notes. Do not duplicate release entries in CHANGELOG.md.
2. Align every workspace package, plugin and marketplace ref to the version.
3. Review API compatibility and migration instructions for actual consumers.
   Frozen legacy consumers stay on alpha.17; do not make them follow new Core.
4. Run `pnpm check`, including exact packed Worker, optional products, Bun,
   Vercel, skills, release invariants, types and tests. Inspect the umbrella
   docs/skills payload: no workspace dependencies, secrets or local state.
5. Freeze the PR head for self review; CI must pass before merge. Dispatch
   release.yml from that merge with `version` (without v). It refuses an
   untagged source that is no longer the expected branch tip.

The ten public packages remain in dependency order:

1. @aotter/mantle-spec
2. @aotter/mantle-admin-ui
3. @aotter/mantle-runtime
4. @aotter/mantle-indexeddb
5. @aotter/mantle-web
6. @aotter/mantle-admin
7. @aotter/mantle-bun
8. @aotter/mantle-vercel
9. @aotter/mantle-cloudflare
10. @aotter/mantle

## Credentials and verification

Core needs NPM_TOKEN for npmjs. Its job-scoped GITHUB_TOKEN creates the Core
tag/release and mirrors GitHub Packages. No cross-repository fanout token is
needed. Before tagging, verify credentials and new-version absence on both
registries. Existing artifacts on retry must have matching integrity.

Completion requires the Core tag SHA, all ten npmjs/GPR packages, exact
integrity, no workspace dependencies, a passing public-registry Worker gate,
correct channel tags and the GitHub release. Retain run links and gate evidence.
This does not prove stable production soak or upgrade safety; #826 owns those
acceptance requirements. A first-stable agent acceptance uses only the
version-matched authoring instructions, not an SDK checkout or generated site.

## Recovery

Rerun the same controller commit/version for a transient or verified partial
transition. Existing tags/artifacts must match; newer channels stay put. Fail
on identity disagreement instead of guessing. A wrong public artifact needs
a new version; never force-retag, overwrite or reuse a published version.
Unpublish is reserved for actual secret/private-file exposure, never routine
fixes. Infrastructure renames require their explicit config diff and live
smoke; CI alone cannot prove provider identity.
