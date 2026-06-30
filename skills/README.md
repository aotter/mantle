# SKILL.md briefs (mantle)

Agent-readable skill briefs for consumers of `@aotter/mantle-*`. Discoverable by URL — no plugin install needed.

| Skill | When to invoke |
|---|---|
| [`develop`](develop/SKILL.md) | `mantle:develop`: Core-owned workflow for manifest, runtime, handler, adapter, validation, and MCP work in any Mantle project. |
| [`plugin`](plugin/SKILL.md) | `mantle:plugin`: Core-owned marketplace workflow for plan-first capability installs across starters and adapters. |
| [`theme`](theme/SKILL.md) | `mantle:theme`: Core-owned visual workflow. Reads project context but does not depend on starter-owned skill semantics. |
| [`update`](update/SKILL.md) | `mantle:update`: Core-owned drift check workflow for SDK, starter snapshots, and plugin lockfiles. |
| [`install`](install/SKILL.md) | User wants to start or continue a Mantle site. Sites launch on [Mantle landing](https://mantle.tools), which provisions the GitHub repo and first Cloudflare deploy; this brief orients the agent to take over and continue the provisioned repo. |
| [`customize-design`](customize-design/SKILL.md) | Legacy publication-specific design guide. Prefer `mantle:theme` for generated repos. |
| [`extend`](extend/SKILL.md) | Legacy atom-authoring guide. Prefer `mantle:develop` or `mantle:plugin` depending on whether the work is one-off or installable. |
| [`provision`](provision/SKILL.md) | User wants production fully usable after a landing launch. Verify the current landing deploy, wire per-site staff auth, smoke test, and hand off the operator setup URL. |

The skills target `mantle@v0.1.0`. Each one names its assumed grammar version in the front-matter `applies_to:` field; future versions add a sibling SKILL.md or update the existing one.

## Skill authority

The `mantle:*` namespace is owned by `@aotter/mantle`. Starter template
repos may vendor exact copies for offline/repo-local use, but they must not
fork the meaning of a `mantle:*` skill. Starter launch files and plugin recipes
are context that Core skills read, not competing skill contracts.

## Marketplace install

The repo is also an agent plugin bundle:

- Claude Code: `.claude-plugin/plugin.json` plus `.claude-plugin/marketplace.json`.
- Codex: `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json`.
- Cursor: `.cursor-plugin/plugin.json`.
- VS Code + GitHub Copilot: `.copilot-plugin/plugin.json`.

## Audience

These are written for **AI agents acting on behalf of consumers of mantle**, not for agents maintaining the mantle SDK itself. SDK-internal guidance lives in [`/CLAUDE.md`](../CLAUDE.md). Two audiences, two artifacts.

## Discoverability

The skills target ADR-0007's "AI as primary author" thesis: agents reach these files by URL when the user invokes them by intent ("install mantle", "extend my CMS", "deploy"). No `/skill install` slash command is required — point the agent at the GitHub raw URL or pass the markdown content directly.

## Conventions

Each SKILL.md ships:

- **Front-matter** with `name`, `description`, `when_to_invoke`, `applies_to`.
- **Preflight** section — environment + user-confirmation gates.
- **Step-by-step** — concrete commands (`pnpm validate`, `mantle emit-openapi`, etc.).
- **Diagnostic recipes** — `Symptom → Cause → Fix` table for the common failure modes.
- **Don't** — reviewer-style list of patterns the agent must reject (often citing ADRs).
- **When you're done** — what to report back to the user.

If you're writing a new SKILL, follow the same structure. The CLI commands referenced are stable across v0.1.x.
