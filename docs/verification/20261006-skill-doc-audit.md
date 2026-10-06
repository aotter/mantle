# Consumer skills and documentation audit — 2026-10-06

The audit used Plugin Creator's `update-plugin` workflow for the existing
Git-managed Mantle plugin. Its source identity, hosting, permissions and release
process remain unchanged. No plugin was installed, uploaded or published.

## Coverage

- Inventory: all 105 Markdown sources under `docs/`, `skills/` and
  `.agents/skills/` before adding this report (101 under `docs/`). All relative
  Markdown file links resolved. Historical ADR/release descriptions were kept
  in their historical context rather than rewritten as current consumer APIs.
- Every source skill was read: the plugin's `mantle`, the package's `develop`,
  `integrate`, `update`, `provision`, `media-gc`, and the maintainer release skill.
  The six shipped consumer skills retain their distinct package/plugin
  projections, triggers, authority and destructive/deployment restrictions.
- Checked CLI/preset ownership, installed-version documentation, peer pinning,
  Manifest/SQL-first guidance, public surface composition, Cloud host protocol,
  save/preview/publish states, source recovery, secrets and upgrade boundaries.
- Checked existing host compatibility manifests and the packaged Cloud helper.
  This audit does not migrate the plugin's distribution format or change the
  connected Cloud endpoint. The helper's offline checks remain local evidence.

## Repairs

1. Provision, handbook overview/deployment and the current 0.2 release narrative
   still said Cloud could not accept 0.2 services. They now route through the
   plugin's Cloud workflow and the selected project's exact host contract,
   preserving the D1-only, project-grant and paired-publish boundaries.
2. Procurement/View predicates did not describe generic Admin entry access.
   The example now blocks generic writes with Schema `readOnly`; authorization
   and Admin docs explain that generic reads follow Admin roles and Schema
   scope, and show a stricter application-owned wrapper inside `withCaller`.
3. Develop now calls out every mounted entrance and verifies state transitions,
   same-version concurrent writes, restart persistence and actual UI behavior.
   Approval-chain advice prefers SQL conditions before custom hooks/guards.
4. Provision's secrets text distinguishes deployment secret storage from
   untracked local environment files; the old standalone hosted-auth model is
   distinguished from Cloud's managed tenant identity.
5. The member MCP App recipe reads the installed Core's `peerDependencies`
   for optional package versions, matching the CLI's consumer contract.
6. OAuth docs explain the preset's closed DCR policy and public owner-managed
   native PKCE registration. The stricter Admin wrapper targets API paths so
   sign-in, assets and member OAuth consent remain reachable.

## Validation

Commands actually passed:

```sh
git diff --check
node scripts/check-skills.mjs
node scripts/check-boundaries.mjs
node scripts/sync-plugin-manifests.mjs --check
node scripts/check-doc-examples.mjs
node scripts/check-cloud-plugin.mjs
```

The checks cover six shipped skills, six synchronized host/marketplace
manifests, twelve compiled example pages and the packaged helper's host
negotiation/resume path. Documentation changes add no Runtime option, grammar
key, private import or second identity resolver. Fresh PR #1336 consumer
verification independently reproduced the contributor generic-read gap and
verified the stricter host composition with real sessions and PostgreSQL.

This source audit does not prove remote authenticated Cloud publication. Cloud
staging/production rollout and release evidence belong to `aotter/mantle-home`.
The source changes reach installed package consumers through a later authorized
SDK release; no npm publication is part of this audit.
