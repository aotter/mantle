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
versions and the consumer installation examples to the release tag (see
docs/release-process.md step 2), inspect the packed docs/skills payload, run `pnpm check` and
`pnpm check:init-audit` (the `mantle init` app installs without high or critical advisories;
needs the network) and review its exact SHA. The reference consumer gate runs
from packed packages outside workspace links. Bump `MANTLE_VERSION`
(`packages/mantle/src/build/core/version.ts`) with `package.json`, then regenerate
`docs/examples/reference-service` using that example's native generation command.
Keep compiler version metadata and the committed generated artifacts fresh.
Merge into develop for every
version; 0.2 work on `0.2.x` reaches a release only after a `0.2.x` -> develop
PR merges (docs/release-process.md). Beta, RC and stable then follow "Promote to main" in
docs/release-process.md: pin
`promote/<version>` at that develop merge SHA, PR it into main, merge with a
merge commit, dispatch with `--ref main`. Stable also needs recorded owner
acceptance on the version's release-gate issue, and its entry added to
docs/handbook/releases/index.md. Do not infer permission to publish from an
implementation PR. Before an alpha or beta, also run the startup and
request-cost checkpoint below.

## Startup and request-cost checkpoint

Run this checkpoint for a PR that changes `packages/mantle/src/auth`,
`packages/mantle/src/kernel` or generator code/output, and once before every
alpha or beta. It is a maintainer measurement, not a CI job or a committed script;
the existing `startupGraph`, `check-size`, `check-package` and `check:ui-size`
gates remain unchanged.

1. Build and check the reference service from the exact packed packages, then
   ask Wrangler for the exact upload:

   ```sh
   checkpoint_dir="$(mktemp -d)"
   node scripts/check-packed-consumer.mjs \
     --project docs/examples/reference-service \
     --output "$checkpoint_dir/packed" -- pnpm check
   cd "$checkpoint_dir/packed/consumer"
   pnpm exec wrangler deploy --dry-run \
     --outfile "$checkpoint_dir/worker.bundle"
   ```

2. Walk the entry's static imports in `dist/worker` and compare them with the
   dry-run module list. Better Auth, the MCP SDK, zod and compiler/YAML code
   must be absent. Record entry-static bytes and module count. Also report the
   whole upload by module, calling out deferred packages, duplicated chunks and
   unused modules.
3. Profile that same upload five times and report every sample:

   ```sh
   for run in 1 2 3 4 5; do
     pnpm exec wrangler check startup \
       --worker "$checkpoint_dir/worker.bundle" \
       --outfile "$checkpoint_dir/startup-$run.cpuprofile"
   done
   ```

   Local startup profiles are diagnostic. Treat short or noisy profiles as
   inconclusive, never as a numeric pass or deployed startup time.
4. In the disposable packed consumer, instrument the D1 binding at its native
   execution boundary and run it under local Wrangler/workerd on an unused
   port. Count a bound `all`, `first`, `run` or `raw` as one round trip and a
   `batch` as one; `prepare` alone is not a round trip. For each request class,
   record the first request in a new isolate and a repeat in the same isolate,
   separating authority reads, business queries and refresh writes:
   - health or another fixed no-data route: 0 DB and 0 DDL;
   - `/api/auth/get-session`;
   - cookie-authenticated REST read, with cookie cache off and on;
   - MCP `initialize`;
   - MCP `tools/list`;
   - one successful authenticated write.

   Restart only the Wrangler process started for this checkpoint when a fresh
   isolate is needed. Apply schema before probing; imports, startup and ordinary
   requests must execute no DDL.
5. Put the commands, five startup samples, graph/upload breakdown and cold/warm
   D1 counts in the PR body, or on the release issue for an alpha or beta.

Real-edge `startup_time_ms` and deployed latency are optional. If measured,
use only the maintainer's existing Wrangler login and temporary `spike-`-prefixed
Worker and D1 resources. Delete only those resources afterwards and verify their
absence with Wrangler list commands; never record account IDs.

Dispatch the controller from the reviewed release merge with the version
without v. Watch all gates, not only publication:

1. Core tag resolves to that canonical merge.
2. All three npmjs artifacts exist with matching integrity and no workspace:*.
3. GitHub Packages mirrors verify the same three-package candidate.
4. The reference Worker installs exact public packages, generates/types/checks
   successfully and serves its declared HTTP route before channel promotion.
5. Monotonic channel promotion succeeds for every package on `alpha`,
   `beta`, `rc`, or `latest`. Those are the only official channels and are
   never removed. `mantle-release` is an internal candidate dist-tag:
   publish attaches it, promote leaves it pointing at the last published
   candidate, and consumers must not install it. The GitHub prerelease or
   release succeeds.

For stable acceptance, give an agent only the version-matched consumer
instructions and confirm a directly authored application reaches a running
Worker. No SDK checkout or scaffold command is required.

Transient/partial failures rerun the same controller commit/version. Verify
existing state, preserve newer channels, and fail on identity disagreement.
Wrong public artifacts require a new version; never overwrite or force-retag.

After a controller-only fix lands on the tip, re-dispatch the same version
from the source branch. Resolve recovers using the existing tag SHA when
that commit is an ancestor of the tip and package versions still match.
Tagged recovery skips the Core source check because that tree was already
released from the immutable tag. When every npmjs package at that version
already exists, it also skips packing, immutable tarball comparison and the
public-registry Worker gate.
The controller tip must not rebuild published artifact identity.

Legacy recovery follows the controller and docs at that version's immutable
tag, not the current release workflow. No legacy repositories or deployments
are changed by a new Core release.
