# Mantle agent skill

[`mantle`](mantle/SKILL.md) is the one consumer skill, shipped by the plugins and by `npx skills add aotter/mantle@mantle`.
Installation: [agent setup](../docs/handbook/guides/agent-setup.md).

The skill only routes to `mantle help`, which prints the installed package's handbook. It holds no contract, version
number or workflow detail of its own, so it never drifts from the SDK an application pins: put any rule an agent must
follow in the handbook instead. `scripts/check-skills.mjs` enforces that this is the only skill, its front matter, a
line budget, no version strings, and that every `mantle help <topic>` it names exists.
