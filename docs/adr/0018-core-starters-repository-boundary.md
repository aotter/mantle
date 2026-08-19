# ADR-0018: Keep Core and public starters in separate repositories

**Status:** Accepted for now; revisit only under the triggers below

**Date:** 2026-08-02

**Related:** [#542](https://github.com/aotter/mantle/issues/542),
[#191](https://github.com/aotter/mantle/issues/191),
[#97](https://github.com/aotter/mantle/issues/97),
[#99](https://github.com/aotter/mantle/issues/99)

## Context

Core and the public starter source currently form a producer-consumer
boundary:

```text
Core (SDK producer)
  -> published npm contract
mantle-starters (external consumer and bundle producer)
  -> immutable provision bundle
mantle-landing (provisioner)   Core CLI (`mantle create`)
```

> **Amended 2026-08-19 (#699).** The chain above is no longer linear. Core's
> umbrella CLI is now also a consumer of the immutable bundle: `mantle create`
> resolves the official `v${packageVersion}` starter tag, renders it through
> the environment-neutral module Core owns, and writes a local project. Core
> is therefore both the upstream producer of the npm contract and a downstream
> consumer of the release train it starts.
>
> This does not move starter content into Core, so the decision below stands:
> starters still author the bundles and still validate the published SDK as an
> external consumer. What changed is the supporting argument. Two consequences
> are worth stating rather than rediscovering:
>
> - **The published-consumer guarantee is now proven twice.** `mantle create`
>   materializes a project that installs the published package, so a break in
>   the npm contract fails in Core's own release smoke as well as in starter CI.
> - **Reconsideration input 1 is being answered.** #699 replaces the release
>   order so a candidate is published under a temporary dist-tag, validated
>   against the exact packed artifacts, and only then promoted. That was listed
>   below as an unresolved prerequisite for any future merge; when it lands,
>   this ADR should record it as resolved rather than pending.

The repositories were originally split because premium starters needed a
private ACL. That reason does not determine where public starters must live,
and the private premium repository remains a stub. A later decision, #191,
made Core, starters, and landing mirror the same version and connected them
with an automated release fanout.

The fanout accumulated real costs: release-only commits, `main`/`develop`
backports, fallback tag creation, commit-subject detection, cross-repository
credentials, and a Core-skill drift check that can skip when the sibling
checkout is unavailable. Issue #542 therefore proposed moving public starters
back into this repository.

That operational pain does not by itself prove source cohesion. The separate
starter repository now provides a useful invariant that did not exist in the
original rationale: the canonical generated-site fixture consumes published
SDK packages and cannot silently link Core workspace packages.

A heuristic review of merged PRs from 2026-06-03 through 2026-08-02 also did
not show sustained majority co-change. After excluding release, promotion,
backport, and dependency PRs, 9 of 64 Core PRs explicitly referenced starters,
and 13 of 79 starter PRs explicitly referenced Core. Explicit references
undercount forced adaptations, so these numbers are directional rather than a
permanent threshold. They do show that release noise is not a sufficient proxy
for product coupling.

## Decision

Keep `aotter/mantle` and `aotter/mantle-starters` separate for now.

The boundary is a release-contract boundary, not an ACL boundary:

- Core produces versioned npm artifacts.
- Starters validate those artifacts as an external consumer and produce
  immutable provision bundles.
- Landing consumes the released bundle and provisions end-user repositories.

Do not merge or archive the starters repository until the following no-regret
work has landed:

1. **Pre-publish downstream harness.** Validate starters against the exact SDK
   tarballs that would be published, preferably through an ephemeral registry,
   before a release tag exists.
2. **Fail-closed Core-skill drift check.** Compare starter-vendored skills with
   the installed SDK package in normal starter CI; never depend on an optional
   sibling checkout.
3. **One release controller.** Replace the bump/tag/dispatch/fallback chain and
   remove avoidable `main`/`develop` backport noise without moving source code.
4. **Repository-agnostic updates.** Make generated sites resolve a configured
   bundle base URL instead of hard-coding `aotter/mantle-starters`.

Issue #542 remains the work and reconsideration tracker. This ADR is the
canonical explanation of the repository-boundary decision. The current
mechanics belong in `docs/release-process.md`; implementation details should
not be duplicated here.

## Reconsideration triggers

Re-evaluate a monorepo after the four items above land if either signal persists:

- the release path still needs at least two special-case workaround fixes per
  quarter, such as fallback tags, backports, or commit-message detectors; or
- SDK contract changes require same-release starter adaptations more often than
  roughly once per month, making atomic cross-repository work a recurring cost.

A future merge proposal must also resolve:

- how the same tagged starter version is validated against the exact package
  artifacts before npm publication;
- a real last-legacy-version to first-new-location update for an existing site;
- landing dispatch and release credentials, which do not disappear merely by
  moving starters;
- premium-repository direction;
- nested pnpm/Dependabot/lockfile CI, licensing, open issues, and repository
  history migration.

These are decision inputs, not a disguised permanent prohibition. A monorepo
is appropriate if its atomicity benefit remains material after the release
machinery is simplified.

## Consequences

### Positive

- The published-package consumer guarantee remains structural rather than
  simulated by workspace exclusions and realpath assertions.
- The four improvements reduce risk and complexity under either eventual
  repository shape.
- Existing generated-site update URLs remain valid while the updater contract
  is made portable.
- Starter-only product work keeps an independent source boundary.

### Negative

- Cross-repository changes cannot land in one atomic PR.
- A release event still crosses repository boundaries and needs a narrowly
  scoped credential or GitHub App.
- Release noise remains until the controller and branch flow are simplified.
- Core-skill drift remains possible until the fail-closed check lands.

## Alternatives

### Merge immediately

Rejected. The proposed release order cannot both start from an immutable tag
and regenerate a same-version registry-backed starter lockfile after publish.
Existing generated sites also cannot cross the hard-coded repository boundary
without a bridge.

### Keep the repositories separate without simplifying the release path

Rejected. The current fanout complexity and silent skill-check escape hatch are
real defects; retaining the boundary does not justify retaining those defects.

### Declare that the repositories must never merge

Rejected. The current boundary is valuable, but it is replaceable with explicit
and tested invariants if future co-change and release evidence justify the cost.

## How to apply

- Treat starters as a downstream SDK consumer in CI and release design.
- Do not add starter projects to the Core pnpm workspace as a shortcut for
  cross-contract validation.
- Track the four prerequisite changes and future merge evidence in #542.
- Any future repository-move proposal must supersede this ADR and #191
  explicitly, with the transition tests listed above.

## Implementation status

The repository-boundary decision is active. The four no-regret improvements are
tracked from #542 and may land independently; none requires a repository move.
