# AGENTS.md

This SDK repo's agent entry point is **[CLAUDE.md](./CLAUDE.md)** — read that first.

Consumer projects scaffolded via `create-mantle` get a different, mantle-aware `AGENTS.md` templated
from [`_common/AGENTS.md.template`](https://github.com/aotter/mantle-starters/blob/main/_common/AGENTS.md.template)
on the starters repo (per [ADR-0016](./docs/adr/0016-agents-md-and-macros.md)). This file at the SDK
repo root only points you at the right place.

## Quick links for contributing agents

- Contribution contract → [CONTRIBUTING.md](./CONTRIBUTING.md)
- Architecture rules / clean-arch layout → [CLAUDE.md](./CLAUDE.md)
- Decision history (irreversible choices) → [`docs/adr/`](./docs/adr/)
- Release / fanout guardrail → [`.agent/skills/mantle-release/SKILL.md`](./.agent/skills/mantle-release/SKILL.md)
- Skills for end-user flows → [`skills/install/SKILL.md`](./skills/install/SKILL.md), [`skills/extend/SKILL.md`](./skills/extend/SKILL.md), [`skills/provision/SKILL.md`](./skills/provision/SKILL.md)
