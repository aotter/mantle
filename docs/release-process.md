# Release process

mantle is in `0.0.x-alpha` until the v0.1.0 release gate closes. The process below documents the branch, tag, GitHub release, and npm publish discipline for prereleases and stable releases.

## Branch model

- `develop` is the integration branch for all PRs.
- `main` is release-only.
- Release PRs merge `develop -> main`.
- Hotfixes branch from `main`, merge back to `main`, tag, then merge or cherry-pick back to `develop`.

## Versioning

- Use semver after v0.1.0.
- Tag format is `vMAJOR.MINOR.PATCH`, for example `v0.1.0`.
- Alpha tags may use prerelease suffixes, for example `v0.0.6-alpha`.
- Package versions, agent plugin manifest versions, and the immutable
  `.agents/plugins/marketplace.json` `v<version>` ref must stay aligned unless
  a future ADR explicitly changes release policy.

## Release channels

### Alpha

Alpha releases validate dogfood and integration flows. They may include
new capability, starter changes, and compatibility-breaking pre-v0.1
behavior. Use alpha for official-site dogfood, provision-path testing,
and early consumer projects that can tolerate churn.

- Version suffix: `-alpha.N`, e.g. `0.0.0-alpha.1`.
- Git tag: `v0.0.0-alpha.1`.
- GitHub Release: mark as prerelease.
- npm dist-tag: `alpha`.
- npm `latest` (pre-v0.1.0 policy): `latest` tracks the most
  user-useful pre-release for default `npm install` (no tag) calls.
  Concretely: when a beta exists, `latest` follows the most recent
  beta; otherwise it follows the most recent alpha. Once v0.1.0
  stable ships, `latest` switches to stable-only and never points
  at a prerelease again.
- Required before publish: `pnpm run check`, changelog entry (written at
  release time, see playbook step 2 below), release PR merged to the branch
  required by the cadence below, and tag pushed.

### Beta

Beta means the v0.1 feature shape is close to complete. New feature work
should be rare and explicitly called out in the release PR.

- Version suffix: `-beta.N` once needed, e.g. `0.1.0-beta.1`.
- GitHub Release: prerelease.
- npm dist-tag: `beta`.
- Focus: bug fixes, docs, provision UX, migration/upgrade path.

### Release candidate

RC means "could become stable if no blocker appears." Only blocker fixes
should land between RCs.

- Version suffix: `-rc.N`, e.g. `0.1.0-rc.1`.
- GitHub Release: prerelease.
- npm dist-tag: `rc`.
- Focus: release blockers only.

### Stable

Stable releases use no prerelease suffix.

- Version: `0.1.0`, `0.1.1`, ...
- Git tag: `v0.1.0`.
- GitHub Release: not prerelease.
- npm dist-tag: `latest`.
- Focus: public install path and supported upgrade story.

## Normal release playbook

The release pipeline is automated end-to-end (#191). Pushing a `v*` tag
fans out: npm publish → starters bump → starters tag → landing bump →
landing deploy. The human steps are:

1. Confirm the release scope, intended version, and blocking issues. The
   release PR aligns every package/plugin version and the agent marketplace ref
   to the intended `v<version>` tag.
2. **Write the `CHANGELOG.md` entry for this release.** Per-PR `[Unreleased]` entries are not used (see `CONTRIBUTING.md § Changelog`). Aggregate the merged-since-last-tag commit log into Keep-a-Changelog buckets (`Added` / `Changed` / `Deprecated` / `Removed` / `Fixed` / `Security`), prefix package scope when relevant (`**`@aotter/mantle-runtime`**: ...`), cross-link the closing PR + issue. The entry lives under a new `## [vX.Y.Z] - YYYY-MM-DD` heading directly; no `[Unreleased]` placeholder. Useful command for the aggregation pass:

   ```bash
   git log --oneline --no-merges vPREV..HEAD -- ':!CHANGELOG.md' ':!pnpm-lock.yaml'
   ```

3. **If this release widens any SDK type** (new required field, new closed-enum entry, removed export, broader runtime contract), run the [cross-repo type-shape audit](#cross-repo-type-shape-changes) below BEFORE bumping. CI inside `mantle/` won't catch downstream literal breaks — only the fanout's validate gate will, after publish is irreversible.
4. Run the full local gate from `develop`:

   ```bash
   pnpm run check
   ```

5. **Pre-v0.1 alpha shortcut**: cut the SDK release directly from `develop` — open a release PR with base=`develop` titled `release: publish alpha.N as pre-v1 latest`, merge with a merge commit, tag the develop merge commit, push the tag. Skip steps 6–8. `mantle/main` updates less frequently than alphas; promotion happens when an alpha graduates to beta/stable. Downstream fanout still promotes `mantle-starters/develop` into `mantle-starters/main` for each alpha so the starter tarball and landing deploy roll forward. (Per practice since alpha.7; see [§ Pre-v0.1 alpha cadence](#pre-v01-alpha-cadence) below.)
6. **Stable / beta / RC**: open a release PR base=`main`, head=`develop`. The PR title MUST contain the literal substring `release: bump @aotter/mantle* to vX.Y.Z` — that exact phrase is the trigger contract for `mantle-starters/.github/workflows/tag-and-dispatch-landing.yml`'s tag job. Anything else and the landing chain skips tagging.
7. Review the diff for accidental unreleased work.
8. Merge with a merge commit.
9. Tag the merge commit:

   ```bash
   git tag v0.1.0
   git push origin v0.1.0
   ```

10. The release fanout takes over (see § Release fanout below). Watch
    the Actions tab for the chain; intervene only if a gate fails. See [§ Fix-forward when bump fanout fails](#fix-forward-when-bump-fanout-fails) if validate fails downstream.

### Pre-v0.1 alpha cadence

Through 2026-05-19 (alpha.7, alpha.8, alpha.9), every SDK alpha bump tagged directly from `develop` — no `mantle/develop → mantle/main` promotion. Codex hand-tagged the develop merge commit; `release.yml` doesn't care which branch the tag points at. `mantle/main` updates intentionally lag the alpha cadence so the canonical SDK "released" pointer doesn't churn daily.

This drops steps 6–9 from the SDK playbook above for pre-v0.1 alphas — the PR base stays `develop`, merge with a merge commit, tag the develop merge commit. The release fanout still fires on the tag push because `release.yml` is keyed on `v*` tags, not branch. The downstream starters fanout opens its release PR against `mantle-starters/main`, using the default-branch `develop` checkout as the head, so starter content and landing can keep auto-publishing per alpha.

Once v0.1.0 ships, switch to the full `develop → main → tag` flow per the steps above.

### Cross-repo type-shape changes

When a release widens an SDK type, downstream literal constructors in `mantle-starters/` and `mantle-landing/` may break the fanout's validate / typecheck gate AFTER npm publish lands. The npm publish itself succeeds (the SDK code compiles fine in isolation); the breakage surfaces in `bump-from-sdk.yml` and `bump-from-starters.yml`'s gate, by which point a hotfix has to chase the broken alpha.

Audit checklist for any release that widens a type — run from the workroot containing all three repos:

```bash
# Find literal constructors of every SDK-owned type in downstream repos.
# Extend the type list when adding more SDK-owned exported types.
for repo in mantle-starters mantle-landing; do
  echo "=== $repo"
  git -C "$repo" grep -nE ': (SiteConfig|SiteDefaults|MediaAsset|Entry|Revision)\s*[=:]' -- '*.ts' || true
done
```

Concrete examples:

- Adding a required field to `SiteConfig` (e.g. `media: { purposes }` in v0.0.11-alpha.9): every `SiteConfig` literal in starter `test/fixture/data.ts` + `scripts/seed-initial-content.ts` + landing equivalents needs the new field BEFORE the SDK ships, or downstream bump fails. Fix-forward path described below works but it's bumpy.
- Adding a closed-enum entry: same hazard if downstream `switch` statements are exhaustive.
- Removing an export: starter `import` statements need migration in the same release PR.

The audit takes ~30 seconds and rules out the most common fanout failure. Do it as part of step 3 above, not after the tag is pushed.

### Fix-forward when bump fanout fails

`bump-from-sdk.yml` / `bump-from-starters.yml` failed at the validate / typecheck gate because the SDK release introduced a code-shape break? Re-firing the workflow won't help — it'll fail the same gate on the same source. The fix-forward path:

1. Branch off `develop` (starters) or `main` (landing): `release/vX.Y.Z`.
2. Replicate what the bump workflow would have done — bump every `@aotter/mantle*` dep + own `version` in package.json files, refresh lockfiles via `pnpm install --no-frozen-lockfile`, and rebuild starter provision bundles when starters source changed.
3. Add whatever source-code fixes satisfy the new SDK shape.
4. Commit subject MUST be `release: bump @aotter/mantle* to vX.Y.Z` (starters) or `release: bump @aotter/mantle to vX.Y.Z` (landing) — `tag-and-dispatch-landing.yml` filters on this in starters; landing has no equivalent filter but the convention keeps history consistent.
5. Open PR base=`main` (starters and landing), CI passes now that lockfile + source are in sync, rebase-merge.
6. **Immediately open a `chore: backport main→develop` PR** (same repo, base=`develop`, head=`main`). The fast-path commit lives on `main` only — leaving it there silently shifts `main` ahead of `develop` in the touched files. The next `bump-from-sdk.yml` (which opens its release PR from develop→main) then collides on those exact files. alpha.15 hit this in mantle-starters: 13 file conflicts because alpha.14-era #272 follow-ups had been fix-forwarded to main without back-merging. Auto-merge the backport PR; no review gate needed since main is authoritative.
7. **Don't** re-fire `bump-from-sdk.yml` afterwards — it'll error with `No changes after bump — was the SDK version the same as current?` because your fast-path PR already did the bump. The workflow's only purpose was to produce the same end state your PR did.

### Re-spin release for a downstream-content-only fix

Sometimes the SDK npm artifact is fine but the generated starter provision bundle is broken (e.g. starter content didn't include a freshly-required field at release time). Per `§ Rollback / yanking policy`, the right path is to publish the next alpha as a no-op SDK bump that re-spins the fanout:

1. Cut alpha.N+1 in `mantle/` with empty SDK diff (versions + CHANGELOG only).
2. CHANGELOG entry MUST say explicitly: `No SDK code changes. alpha.N+1 re-spins the release fanout to ship starter content that should have been part of alpha.N (see #XXX).`
3. Tag + push -> full fanout produces fresh `mantle-starters` provision bundles with the corrected content.

Don't force-retag the broken alpha. Don't introduce a starter-only sub-tag like `vX.Y.Z-starter.N`. Either breaks the convention that starter version === SDK version.

## Release fanout

The repository boundary and its reconsideration criteria are governed by
[ADR-0018](adr/0018-core-starters-repository-boundary.md). This section records
the current mechanics only.

`mantle/.github/workflows/release.yml` triggers on `v*` tag push.
The full chain:

```
mantle: git push tag v0.0.11-alpha.4
      │
      ▼
release.yml: pnpm install → build → test (gate) → verify package.json
             versions match the tag → pack tarballs → publish/verify
             npmjs → mirror GitHub Packages → GitHub release →
             repository_dispatch
             to mantle-starters
                   │
                   ▼
mantle-starters/bump-from-sdk.yml: bump @aotter/mantle* deps
             + own version → pnpm install + rebuild bundles →
             validate × 5 starters (gate) → typecheck × 5 (gate) →
             PR onto main → auto-approve + auto-merge
                   │
                   ▼ (after PR merges to main)
mantle-starters/tag-and-dispatch-landing.yml: tag the merge commit
             vX.Y.Z → repository_dispatch to mantle-landing
                   │
                   ▼
mantle-landing/bump-from-starters.yml: bump @aotter/mantle* dep
             + own version (so STARTER_VERSION const updates) →
             pnpm install → typecheck (gate) → wrangler dry build (gate) →
             PR onto main → auto-approve + auto-merge
                   │
                   ▼ (after PR merges to main)
mantle-landing/deploy.yml (existing): wrangler deploy → production
```

Every workflow is gated. A failed gate stops the chain at the failing
PR (left open for human triage). Nothing downstream fires until the
upstream PR is fixed + merged.

### Operator setup (one-time)

Repo secrets:

| Repo | Secret | Purpose |
|---|---|---|
| `aotter/mantle` | `NPM_TOKEN` | npm publish access to `@aotter/*` |
| `aotter/mantle` | `RELEASE_FANOUT_TOKEN` | cross-repo dispatch to `mantle-starters` |
| `aotter/mantle-starters` | `RELEASE_FANOUT_TOKEN` | open release PR + cross-repo dispatch to `mantle-landing` |
| `aotter/mantle-landing` | `RELEASE_FANOUT_TOKEN` | open release PR (deploy is `deploy.yml`'s job) |

`RELEASE_FANOUT_TOKEN` is the same fine-grained PAT across all three
repos — easier to manage than three separate tokens. Required
permissions: `contents: write`, `pull-requests: write`, `actions: write`
on the three repos. Token expiration policy is whatever you want;
rotate when expired.

Long-term recommendation: replace the PAT with a GitHub App
(`mantle-release-bot`) installed on the three repos and use
`actions/create-github-app-token` to mint short-lived install
tokens per workflow run. PAT path works for now.

### Manual fallback

If `RELEASE_FANOUT_TOKEN` is missing or a workflow fails partway:

- npm publish still happens (it doesn't need the fanout token; only
  `NPM_TOKEN`)
- Each downstream workflow has a `workflow_dispatch` trigger so the
  operator can re-fire it manually from the Actions UI with the
  version as input.

Order of manual re-fires: `mantle-starters/bump-from-sdk.yml` →
(wait for merge) → `mantle-starters/tag-and-dispatch-landing.yml`
(fires automatically on merge) → `mantle-landing/bump-from-starters.yml`
fires automatically via the cross-repo dispatch.

### Channel-specific behavior

`release.yml` infers the npm dist-tag from the version suffix:

| Tag pushed | npm dist-tag | GitHub release marked |
|---|---|---|
| `v1.2.3` | `latest` | normal release |
| `v0.0.11-alpha.4` | `alpha` | prerelease |
| `v0.1.0-beta.1` | `beta` | prerelease |
| `v0.1.0-rc.1` | `rc` | prerelease |

Without the inference, every prerelease would land on `latest` and
break adopters running `npm install @aotter/mantle` without an
explicit tag. The mapping is in the "Extract version + infer npm tag"
step of `release.yml`.

## npm publish

Published npm packages are the runtime dependency source for
agent-provisioned consumer projects (ADR-0013). Starter files may be
copied from GitHub, but `setup:site` rewrites runtime dependencies to
the selected npm version.

### Packages published in alpha

For `0.0.x-alpha`, publish SDK packages in dependency order:

1. `@aotter/mantle-spec`
2. `@aotter/mantle-admin-ui`
3. `@aotter/mantle-runtime`
4. `@aotter/mantle-cloudflare`
5. `@aotter/mantle` (umbrella — depends on all four above; publish last so its exact-pinned `dependencies` resolve)

The umbrella is the adopter-facing entry: a single dep, subpath imports
`@aotter/mantle/{spec,runtime,cloudflare,admin-ui}`. Sub-packages
stay individually installable for tooling / alt-adapter authors.

Do **not** publish starter packages during alpha unless a separate PR
explicitly prepares their package allowlists and verifies the tarballs.
Current starter launch flow is landing-driven: landing fetches generated
`provision-bundles/<type>.json` artifacts from `aotter/mantle-starters`,
commits the user's GitHub repo, and uses npm as the runtime dependency
source.

Do **not** publish `@aotter/mantle-netlify` while it is a stub.

Releases on this SDK repo must not attach or publish a separate starter
scaffolder package. Local cold start is owned by the versioned provision
bundles and materializer in `aotter/mantle-starters`.

`skills/install/SKILL.md` creates or continues a local / landing-generated
project. Human-facing starter bundle details belong in the `mantle-starters`
README, not this SDK repo.

### Pre-publish checks

Run the full gate before publishing:

```bash
pnpm run check
```

Run `pnpm build` from the workspace root first so `dist/` exists for
every package — `pnpm publish` does NOT run the build lifecycle scripts
by default, and a tarball published without `dist/` is a wasted version
slot (npm forbids republishing the same version, and `npm unpublish`
needs an OTP not always to hand). Then pack + inspect:

```bash
pnpm run check                          # boundary + build + typecheck + test
mkdir -p /tmp/mantle-pack
pnpm -C packages/mantle-spec       pack --pack-destination /tmp/mantle-pack
pnpm -C packages/mantle-admin-ui   pack --pack-destination /tmp/mantle-pack
pnpm -C packages/mantle-runtime    pack --pack-destination /tmp/mantle-pack
pnpm -C packages/adapters/cloudflare    pack --pack-destination /tmp/mantle-pack
pnpm -C packages/mantle            pack --pack-destination /tmp/mantle-pack
tar tzf /tmp/mantle-pack/aotter-mantle-<ver>.tgz | head    # spot-check
```

Confirm sub-package tarballs contain only their intended `dist`, `README.md`,
`LICENSE`, and `package.json` payloads. The umbrella package must additionally
contain the version-matched `docs/` and `skills/` trees. Do not publish
tarballs containing local state, `.wrangler/`, secrets, fixtures, or
workspace-only artifacts.

### Alpha publish command

Publish prerelease packages with the `alpha` dist-tag, in dep order:

```bash
pnpm publish --filter @aotter/mantle-spec       --no-git-checks --access public
pnpm publish --filter @aotter/mantle-admin-ui   --no-git-checks --access public
pnpm publish --filter @aotter/mantle-runtime    --no-git-checks --access public
pnpm publish --filter @aotter/mantle-cloudflare --no-git-checks --access public
pnpm publish --filter @aotter/mantle            --no-git-checks --access public
```

Or one-shot:

```bash
pnpm -r publish --no-git-checks --access public --tag alpha
```

`pnpm publish` resolves `workspace:*` deps to the actual published
version at pack time, so the umbrella's `dependencies` lock to the
exact `0.0.X-alpha` of each sub-package once the publish completes.

**DO NOT use `npm publish` directly** inside a workspace package.
`npm publish` (unlike `pnpm publish`) does **not** rewrite `workspace:*`
specifiers — they ship to the registry verbatim as the literal string
`"workspace:*"`, which no consumer can resolve. Recovery requires
bumping past the broken version (see "Rollback / yanking policy") since
republishing the same version is forbidden. Saw this concretely on the
0.0.11-alpha rename round: mantle-runtime / cloudflare / umbrella all
shipped broken via `npm publish` and had to be republished at
0.0.11-alpha.3 via `pnpm publish`.

Confirm zero `workspace:*` leaked into published deps:

```bash
for p in @aotter/mantle{-spec,-admin-ui,-runtime,-cloudflare,}; do
  echo "=== $p"
  npm view "$p@alpha" dependencies --json | grep -i workspace && echo "  ⚠ LEAK"
done
```

`pnpm publish` uses `publishConfig.tag` (set to `alpha` on every
package) but `npm` also assigns the `latest` dist-tag by default. Per
the pre-v0.1 `latest` policy above, that's the correct behavior; no
action needed. Add the `alpha` tag explicitly only if it's missing:

```bash
npm dist-tag add @aotter/mantle@<ver> alpha
```

After publishing, verify:

```bash
for p in @aotter/mantle{-spec,-admin-ui,-runtime,-cloudflare,}; do
  npm view "$p" version dist-tags --json
done
```

Note: `npm view` against a freshly-published name can 404 for 5–15 min
while the Fastly read-side cache propagates. The write side (and
`pnpm publish`'s "cannot publish over the previously published
versions" sanity check) is the authoritative confirmation that the
publish landed.

**For consumer projects depending on the just-published packages**,
also smoke-test installability after publish:

```bash
mkdir -p /tmp/install-smoke && cd /tmp/install-smoke
echo '{"name":"smoke","private":true}' > package.json
npm install @aotter/mantle@alpha --no-package-lock --no-save
ls node_modules/@aotter/mantle  # expect: dist/ docs/ skills/ package.json README.md
```

If `npm install` 404s for >15 min despite `pnpm publish` succeeding,
the metadata doc is likely tombstoned (see Rollback policy below for
the 24h unpublish cooldown).

### Rollback / yanking policy

Do not use npm unpublish as the normal rollback mechanism. If an alpha
is broken:

1. Publish the next alpha with a higher version.
2. Deprecate the broken version with a clear message.

Example:

```bash
npm deprecate @aotter/mantle-runtime@0.0.0-alpha.1 "Broken alpha; use 0.0.0-alpha.2"
```

Only unpublish when the tarball contains secrets, private files, or a
severely wrong package. Remember:

- npm package versions cannot be reused after unpublish (forever).
- After unpublishing, the **package's metadata document is tombstoned
  for 24 hours**. Republishing the SAME version is forbidden, AND new
  versions you publish during the cooldown can land but the `npm view`
  / `npm install` read path returns 404 because the metadata doc is in
  a frozen state. Saw this concretely on 0.0.11-alpha rename:
  unpublished a workspace-leaked umbrella, republished as
  0.0.11-alpha.1 and .alpha.2 — both were technically published (the
  registry refused republish with "previously published versions"
  errors) but invisible to consumers. Only `0.0.11-alpha.3` (after a
  version-number "jump") cleared the tombstone.

Safer rollback discipline: skip unpublish entirely. Just bump + deprecate.

## Cross-cutting rename playbook

A "rename" here means a substring-level identifier shift that crosses
multiple repos / packages (e.g. `mantle` → `mantle` on 2026-05-16).
These are once-per-product-life events. The rules below cost ~30 minutes
of pre-flight; skipping them cost a half-day of outage when ignored.

### Step 1 — pre-flight grep for substring false-positives

A naive `sed s/OLD/NEW/g` matches OLD as a **substring** of unrelated
identifiers. Concrete trap: renaming `mantle` → `mantle` hit
`aotter-mantle` (the CF worker name) → `aottermantle`. The
auto-deploy after merge created an orphan worker without secrets;
`the Mantle landing page` returned 503 for 30 minutes.

Before the sed, search for shapes where OLD could appear as a substring
of a meaningful different identifier:

```bash
# Substring of an unrelated infra identifier?
git grep -E "[a-zA-Z]+-?${OLD_NAME}" -- '*.toml' '*.yaml' '*.yml' '*.json'

# Specifically check Cloudflare worker / D1 / KV / DO names
git grep -nE "^name|database_name|class_name|queue.*name" -- wrangler.toml '**/wrangler.toml'

# CI workflow names / step IDs
git grep -nE "name:|id:" -- '.github/workflows/**'
```

Hand-edit (or use word-boundary regex) any match that should *not* shift.

### Step 2 — post-sed infra-config diff

After the bulk replace, **explicitly diff every infrastructure config
file** even if the change looks mechanical:

```bash
git diff --name-only HEAD~1 | grep -E "wrangler|workflow|toml|terraform|kubernetes"
git diff HEAD~1 -- wrangler.toml '**/wrangler.toml'
```

Eyeball each line. Worker / DB / queue names that shift mean wrangler
will deploy to a NEW resource without secrets / bindings — silent
disaster.

### Step 3 — CI green ≠ deploy OK

The deploy workflow can report success while the live URL is broken.
Reasons: secrets don't carry to a renamed worker, route bindings
re-attach to the new (empty) worker, etc.

**Always smoke-test the live URL after a config-touching deploy:**

```bash
sleep 60   # Let the deploy + DNS propagate
for path in / /zh-TW /skill/after-launch /admin; do
  code=$(curl -sIo /dev/null -w "%{http_code}" "https://<your-site>$path")
  echo "  $path → $code"
done
```

5xx without an obvious source-level cause usually means
infrastructure-config drift, not application bug.

### Step 4 — Cross-repo rename order

For renames spanning SDK + starters + landing (or any
SDK-depends-on-published-SDK chain):

1. Source-level rename in all repos. Consumer repos may temporarily use
   npm aliases (for example the new package name pointing at a
   pre-rename package version) so CI can pass before the
   first `@aotter/*` SDK release exists.
2. Merge the starters / landing workflow changes before pushing the SDK
   release tag, so the fanout understands the new package names.
3. Merge the SDK rename PR, then push the next `v*` tag. The SDK
   `release.yml` publishes `@aotter/*` through GitHub Actions using
   `NPM_TOKEN`; do not publish locally.
4. Let `bump-from-sdk.yml` replace the temporary consumer aliases with
   the freshly published real `@aotter/*` version, regenerate lockfiles,
   and promote through starters → landing.
5. Smoke-test live URLs.
6. Deprecate old packages with `npm deprecate` and a message pointing
   to `@aotter/mantle` (repeat for the subpackages).

GitHub repo renames (`gh repo rename`) and local-dir renames can happen
anytime — GitHub auto-redirects old URLs to new ones; no consumer
breakage from this step alone.

## Hotfix process

Use hotfixes only for released `main` defects.

1. Branch from `main`:

   ```bash
   git checkout -b fix/issue-NN-hotfix origin/main
   ```

2. Keep the patch narrow.
3. Run the relevant tests and the full gate when feasible.
4. Open the PR against `main`.
5. Merge, tag a patch release, and update GitHub release notes.
6. Merge or cherry-pick the hotfix back to `develop`.

## Pre-flight checklist

- [ ] PR base is correct for the release type — `develop` for pre-v0.1 alphas, `main` for beta/RC/stable (see [§ Pre-v0.1 alpha cadence](#pre-v01-alpha-cadence)).
- [ ] `CHANGELOG.md` has the release entry. If it's a no-op SDK bump to re-spin starter content, the entry MUST say so explicitly (see [§ Re-spin release for a downstream-content-only fix](#re-spin-release-for-a-downstream-content-only-fix)).
- [ ] **Cross-repo type-shape audit ran** if this release widens any SDK type — see [§ Cross-repo type-shape changes](#cross-repo-type-shape-changes). Skipping this is how alpha.9 shipped with broken starter content.
- [ ] `pnpm run check` passed or failures are documented and accepted.
- [ ] Package/plugin versions, `.agents/plugins/marketplace.json` ref, and tag
      name match.
- [ ] GitHub release notes link the relevant issues and ADRs.
- [ ] Automated `release.yml` published packed tarballs to npmjs and
      mirrored them to GitHub Packages before dispatching downstream
      fanout. If publishing manually, verify no `workspace:*` leaked
      into published `dependencies` via the check script in the
      "Alpha publish command" section.
- [ ] Cross-repo rename? Pre-flight grep for substring false-positives
      ran (see "Cross-cutting rename playbook"); infra-config diff
      explicitly reviewed; consumer-repo lockfiles refreshed after the
      SDK publish lands.
- [ ] Smoke-tested live downstream URL (e.g. `the Mantle landing page`)
      after consumer-repo deploys — CI green is not enough when infra
      config (wrangler.toml `name`, D1 / KV / DO bindings) shifted.
- [ ] npm publish steps are either completed or explicitly not applicable.
