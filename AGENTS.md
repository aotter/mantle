# Mantle contributor router

- To create or continue a Mantle application, use the version-matched consumer
  skills under [`skills/`](skills/) and materialize a project outside this SDK
  checkout.
- To change or review this SDK, read [`CONTRIBUTING.md`](CONTRIBUTING.md) and
  the relevant accepted ADRs before editing.
- To version, publish, tag, or fan out a release, additionally read the
  canonical [release skill](.agent/skills/mantle-release/SKILL.md). Do not
  release unless the user explicitly asks.

Repository safety gates:

- Branch from and open PRs against `develop`; preserve merge commits.
- Keep Runtime adapter-neutral and the v0.1 manifest grammar closed.
- Use the narrowest relevant check while editing; run `pnpm check` for broad
  changes.

`CLAUDE.md` is a compatibility pointer, not a second instruction authority.
Generated applications receive their own version-matched instructions from
[`aotter/mantle-starters`](https://github.com/aotter/mantle-starters).
