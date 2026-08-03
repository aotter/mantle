# SKILL.md briefs (mantle)

Agent-readable skill briefs for consumers of `@aotter/mantle-*`. Discoverable by URL — no plugin install needed.

| Skill | When to invoke |
|---|---|
| [`develop`](develop/SKILL.md) | `mantle:develop`: Core-owned workflow for manifest, runtime, handler, adapter, validation, and MCP work in any Mantle project. |
| [`plugin`](plugin/SKILL.md) | `mantle:plugin`: Core-owned marketplace workflow for plan-first capability installs across starters and adapters. |
| [`theme`](theme/SKILL.md) | `mantle:theme`: Core-owned visual workflow. Reads project context but does not depend on starter-owned skill semantics. |
| [`update`](update/SKILL.md) | `mantle:update`: Core-owned drift check workflow for SDK, starter snapshots, and plugin lockfiles. |
| [`install`](install/SKILL.md) | User wants to create a local Mantle site from a deterministic starter bundle or continue an existing local / landing-generated project. |
| [`provision`](provision/SKILL.md) | User wants a local or landing-generated project shipped to Cloudflare with production auth and operator handoff. |

The skills target Mantle's v0.1 grammar. The installed package version, not
duplicated skill prose, selects the exact runtime and embedded docs.

## Skill authority

The `mantle:*` namespace is owned by `@aotter/mantle`. Run `mantle skills` to
project the installed package's `develop`, `plugin`, `theme`, and `update`
skills to identical `.agent` and `.claude` paths; use `mantle skills --check`
to fail closed on drift. The installed package and
`node_modules/@aotter/mantle/docs/` are the single version-matched authority.
Starter launch files and plugin recipes are project context, not competing
contracts.

## Source-repository marketplace install

The source repository is also an agent plugin bundle. These manifests are not
duplicated into the npm package:

- Claude Code: `.claude-plugin/plugin.json` plus `.claude-plugin/marketplace.json`.
- Codex: `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json`.
- Cursor: `.cursor-plugin/plugin.json`.
- VS Code + GitHub Copilot: `.copilot-plugin/plugin.json`.

## Audience

These are written for **AI agents acting on behalf of consumers of mantle**,
not for agents maintaining the Mantle SDK itself. SDK maintainers use the
repo-root `CLAUDE.md` from a source checkout; it is intentionally not shipped
inside the npm package. Two audiences, two artifacts.

## Discoverability

The skills target ADR-0007's "AI as primary author" thesis: agents reach these files by URL when the user invokes them by intent ("install mantle", "develop my Mantle site", "deploy"). No `/skill install` slash command is required — point the agent at a version tag or pass the version-matched markdown content directly.

## Conventions

Each SKILL.md ships:

- **Front-matter** with a folder-matching `name`, trigger-complete
  `description`, and optional source/version `metadata`. Plugin hosts add the
  external `mantle:` namespace.
- **Preflight** section — environment + user-confirmation gates.
- **Step-by-step** — concrete commands (`pnpm validate`, `mantle emit-openapi`, etc.).
- **Diagnostic recipes** — `Symptom → Cause → Fix` table for the common failure modes.
- **Don't** — reviewer-style list of patterns the agent must reject (often citing ADRs).
- **When you're done** — what to report back to the user.

If you're writing a new SKILL, follow the same structure. Commands and prose
must match the package version that carries the skill; later prereleases may
revise both together.
