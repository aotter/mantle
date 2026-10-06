# Mantle contributor router

- To create or continue a Mantle application, use the version-matched consumer
  skills under [`skills/`](skills/) and materialize a project outside this SDK
  checkout.
- To change or review this SDK, read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  the relevant accepted ADRs before editing.
- To version, publish, or tag a release, additionally read the
  canonical [release skill](.agents/skills/mantle-release/SKILL.md). Do not
  release unless the user explicitly asks.

Repository safety gates:

- Branch from and open PRs against `develop`; preserve merge commits. `main` is
  the default branch, so pass `--base develop` — an unspecified base targets
  `main`, which takes only promotion and hotfix PRs.
- Keep Runtime adapter-neutral and the v2 manifest grammar closed.
- Use the narrowest relevant check while editing; run `pnpm check` for broad
  changes.

`CLAUDE.md` is a compatibility pointer, not a second instruction authority.
Applications read version-matched instructions from their installed Core
package (`node_modules/@aotter/mantle/docs/`); see
[agent setup](docs/handbook/guides/agent-setup.md).

Public/private boundary: follow [CONTRIBUTING.md](CONTRIBUTING.md#publicprivate-boundary).
