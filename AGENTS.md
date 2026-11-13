# Mantle contributor router

- To create or continue a Mantle application, use the version-matched consumer
  skills under [`skills/`](skills/) and materialize a project outside this SDK
  checkout.
- To change or review this SDK, read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  the relevant accepted ADRs before editing.
- For implementation, apply [Ponytail](.agents/skills/ponytail/SKILL.md): native
  primitives first; deletion before new wrappers; least logic, not fewest lines. For
  complexity review use [Ponytail Review](.agents/skills/ponytail-review/SKILL.md), alongside correctness review.
- To version, publish, or tag a release, additionally read the
  canonical [release skill](.agents/skills/mantle-release/SKILL.md). Do not
  release unless the user explicitly asks.

Repository safety gates:

- Branch from and open PRs against `develop`; preserve merge commits. `main` is
  the default branch, so pass `--base develop` — an unspecified base targets
  `main`, which takes only promotion and hotfix PRs.
- Keep Runtime adapter-neutral and the v2 manifest grammar closed.
- Use the narrowest relevant check while editing; run `pnpm check:pg` for broad
  changes.

PostgreSQL is a first-class target (production runs Cloudflare Workers + PostgreSQL):

- A PR's local evidence is `pnpm check:pg` (`pnpm check` plus `test:native` against a
  throwaway PostgreSQL), not plain `pnpm check`, which skips every PostgreSQL test and
  says so on its last line. The PR body names which of the two ran.
- Before merging a change to the PostgreSQL driver/dialect, auth, the kernel request
  pipeline or generator output, dispatch Linux Full checks on the branch
  (`gh workflow run full-checks.yml --ref <branch>`) and link the green run.
- Local Wrangler runs `cloudflare-postgres` over a direct database connection, not
  Hyperdrive. Claim nothing about Hyperdrive pooling, caching or limits without
  evidence from a deployed Hyperdrive configuration.

`CLAUDE.md` is a compatibility pointer, not a second instruction authority.
Applications read version-matched instructions from their installed Core
package (`node_modules/@aotter/mantle/docs/`); see
[agent setup](docs/handbook/guides/agent-setup.md).

Public/private boundary: follow [CONTRIBUTING.md](CONTRIBUTING.md#publicprivate-boundary).
