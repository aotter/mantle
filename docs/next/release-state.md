# Alpha.7 three-package release state

The alpha.7 package set is `@aotter/mantle-ui`, `@aotter/mantle` and
`@aotter/mantle-admin`, published in that dependency order. UI is independent;
Admin depends on UI and peers on the single SDK. The retired Core runtime and
private experimental package are not published. All three use the same version.

This table precedes controller changes under the [release SOP](../release-process.md).
`release.yml` remains the sole writer. Alpha.7 is dispatched from its reviewed
release merge on develop after the clean integration order, fixed gates, exact
packed consumers, Swolhalla browser OTP and actual Worker/DB performance acceptance.

| State | Next boundary | Required invariant / retry |
| --- | --- | --- |
| Implementation incomplete | Source integration and review | No tag, publication or channel mutation |
| Reviewed release merge; unused version | Existing source, native and packed-consumer gates | Canonical develop merge and exact three-package versions; fixed SDK/UI/Admin budgets pass |
| Gates passed; no tag | Existing immutable Core tag step | Credentials and version absence verified first; tag identifies the canonical merge |
| Tag exists; candidates partial | Existing npmjs publish and GPR mirror steps | Verify existing identity; publish missing artifacts only, with internal mantle-release tag |
| Tagged controller-only recovery | Existing Resolve and recovery steps | Tag SHA remains the identity; do not rebuild or overwrite published artifacts from a changed tip |
| Candidates verified | Existing public-registry reference consumer gate | The installed SDK/UI/Admin source of truth must match; no workspace dependency or source alias |
| Consumer passes | Existing per-registry channel promotion steps | All three verified packages; same version no-op, newer channels preserved |
| Channels promoted or preserved | Existing GitHub release step | Same immutable release identity; retry through the same controller |

Public channels remain alpha, beta, rc and latest. Publishing attaches only
mantle-release; neither public nor internal tags are deleted. Every candidate
presence, verification and promotion loop covers the whole three-package set.
Recovery retains the SOP's existing tagged-publication rules; a package existing
on a registry is not evidence that a new acceptance test was run.

Controller scope is the package set, corresponding version/packed-consumer
checks and SOP/docs. There is no second publisher, manual tag, unpublish,
downstream deployment, legacy release rewrite, or new channel. Frozen legacy
recovery continues to use the controller and SOP at its immutable tag.

Freeze each controller revision for adversarial review. Findings name a state,
an event interleaving and the incorrect mutation. After two patch rounds, a new
foundational blocker returns to this table and the maintainer for a scope decision.
