# SKILL.md briefs (mantle)

Agent-readable skill briefs for consumers of `@aotter/mantle-*`. Discoverable by URL — no plugin install needed.

| Skill | When to invoke |
|---|---|
| [`develop`](develop/SKILL.md) | `mantle:develop`: Core-owned workflow for manifest, runtime, handler, adapter, validation, and MCP work in any Mantle project. |
| [`media-gc`](media-gc/SKILL.md) | `mantle:media-gc`: audit or remove stale uncommitted public media objects with the connected Cloudflare API. |
| [`plugin`](plugin/SKILL.md) | `mantle:plugin`: Core-owned marketplace workflow for plan-first capability installs across applications and adapters. |
| [`theme`](theme/SKILL.md) | `mantle:theme`: Core-owned visual workflow. Reads project-owned theme and UI contracts. |
| [`update`](update/SKILL.md) | `mantle:update`: Core-owned drift check workflow for SDK dependencies, local skills, and plugin lockfiles. |
| [`install`](install/SKILL.md) | User wants to author a local Mantle application or continue an existing project. |
| [`provision`](provision/SKILL.md) | User wants a local project shipped to Cloudflare with production auth and operator handoff. |

The skills target Mantle's v0.1 grammar. The installed package version, not
duplicated skill prose, selects the exact runtime and embedded docs.

## Disclosure audit

Every skill ships as one `SKILL.md` with no reference files, scripts, or
assets, so nothing is deferred behind a second load. Progressive disclosure
here is section routing inside one file: the agent reads the entry constraints,
then only the section its selected path names. `scripts/check-skills.mjs`
enforces the columns below.

| Skill | Routes on | Entry-path constraints (read before acting) | Path-gated sections | Projection | Restricted because |
|---|---|---|---|---|---|
| `develop` | existing project; manifest, runtime, handler, adapter, or MCP work | four-atom model; adapter neutrality; no direct D1/KV/Postgres writes; no committed secrets | performance harness; local MCP client; locale rules | project, plugin | — |
| `plugin` | user wants an installable capability | plan before apply; lock entry is the removal manifest; delete only plugin-owned files and atoms | apply; remove | project, plugin | — |
| `theme` | brand or visual direction in a project | repo-owned theme and UI contracts | — | project, plugin | — |
| `update` | SDK upgrade or plugin lock review | never blindly overwrite user-owned code | — | project, plugin | — |
| `install` | new application, or opening an existing project | do not use the SDK checkout as the application; no push/deploy/provider config during cold start | author local project; continue existing project | plugin | Creates a new project; nothing to project into an existing one. |
| `provision` | ship to Cloudflare and finish production auth | secrets never enter source or logs; explicit auth mode | hosted auth; self-managed auth | plugin | Platform-specific deploy that handles production secrets; opt-in only. |
| `media-gc` | audit or remove stale uncommitted media objects | audit by default; confirm exact account, bucket, cutoff, and candidate digest; re-audit before applying; never prefix-delete; never print keys | apply | plugin | Destructive remote object deletion and Cloudflare-specific; opt-in only. |

Deliberately monolithic:

- `develop` is the widest file, but its adapter, auth, and data-ownership rules
  constrain every path through it. Splitting them behind routing would let an
  agent reach a write path without them, which is the failure this audit
  exists to prevent.
- `media-gc` keeps its full audit-confirm-reapply sequence inline for the same
  reason: each safeguard is a precondition of the delete that follows it.

## Skill authority

The `mantle:*` namespace is owned by `@aotter/mantle`. Every skill declares its
own distribution scope in front matter: `metadata.projection: project` marks a
skill `mantle skills` should place in a consumer project, and a skill that
withholds `project` must say why. `scripts/check-skills.mjs` holds that
declaration and the audit table below to each other.

Run `mantle skills` to project the installed package's skills into a project;
use `mantle skills --check` to fail closed on drift. The installed package and
`node_modules/@aotter/mantle/docs/` are the single version-matched authority.
Application files and plugin recipes are project context, not competing
contracts.

## Source-repository marketplace install

Cold start is the install skill. Other marketplace hosts are pointers
to the same entry:

```sh
npx skills add aotter/mantle --skill install
```

```bash
# Claude Code — two separate prompts
/plugin marketplace add aotter/mantle
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle
codex plugin add mantle@mantle
```

Then follow the install skill to the CLI and handbook. After packages are
installed, `mantle skills` projects the installed package's own skills into the
project, and `mantle skills --check` fails on drift.

Cursor and GitHub Copilot read their manifests from the repository directly.
These manifests are not duplicated into the npm package:

- Claude Code: `.claude-plugin/plugin.json` plus `.claude-plugin/marketplace.json`.
- Codex: `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json`.
- Cursor: `.cursor-plugin/plugin.json`.
- VS Code + GitHub Copilot: `.copilot-plugin/plugin.json`.

## Audience

These are written for **AI agents acting on behalf of consumers of mantle**,
not for contributors maintaining the Mantle SDK itself. SDK contributors use
the repo-root `CONTRIBUTING.md`; it is intentionally not shipped inside the npm
package. Two audiences, two artifacts.

## Discoverability

The skills target ADR-0007's "AI as primary author" thesis: agents reach these files by URL when the user invokes them by intent ("install mantle", "develop my Mantle site", "deploy"). Official cold start is `npx skills add aotter/mantle --skill install`. Point the agent at the repository or pass the version-matched markdown content directly.

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
