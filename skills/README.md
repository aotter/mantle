# SKILL.md briefs (mantle)

Agent-readable skill briefs for consumers of `@aotter/mantle-*`. Discoverable by URL — no plugin install needed.

| Skill | When to invoke |
|---|---|
| [`develop`](../docs/skills/develop/SKILL.md) | `mantle:develop`: Core-owned workflow for manifest, runtime, handler, adapter, validation, and MCP work in any Mantle project. |
| [`integrate`](../docs/skills/integrate/SKILL.md) | `mantle:integrate`: choose and carry out an existing application's Mantle integration or rebuild and data migration. |
| [`media-gc`](../docs/skills/media-gc/SKILL.md) | `mantle:media-gc`: audit or remove stale uncommitted public media objects with the connected Cloudflare API. |
| [`plugin`](../docs/skills/plugin/SKILL.md) | `mantle:plugin`: Core-owned marketplace workflow for plan-first capability installs across applications and adapters. |
| [`theme`](../docs/skills/theme/SKILL.md) | `mantle:theme`: Core-owned visual workflow. Reads project-owned theme and UI contracts. |
| [`update`](../docs/skills/update/SKILL.md) | `mantle:update`: Core-owned drift check workflow for SDK dependencies, local skills, and plugin lockfiles. |
| [`mantle`](install/SKILL.md) | User wants to author a local Mantle application or continue an existing project. |
| [`provision`](../docs/skills/provision/SKILL.md) | User wants a local project shipped to Cloudflare, ChatGPT Sites or Mantle Cloud, with production auth and operator handoff. |
| [`mantle-host`](../plugins/mantle-host/skills/mantle-host/SKILL.md) | User picked the Mantle Cloud deploy target: link, save, deploy, rollback or status. Ships only in the `mantle-host` plugin. |

The skills target Mantle's v0.1 grammar. The installed package version, not
duplicated skill prose, selects the exact runtime and embedded docs.

## Disclosure audit

Every skill ships as one `SKILL.md` with no reference files, scripts, or
assets, so nothing is deferred behind a second load. Progressive disclosure
here is section routing inside one file: the agent reads the entry constraints,
then only the section its selected path names. `scripts/check-skills.mjs`
enforces the columns below.

The one exception is `mantle-host`. It carries a vendored script,
`scripts/mantle-host.mjs`, so it lives in its own plugin under
`plugins/mantle-host/` instead of `docs/skills/`. The script is copied
byte-exact from `aotter/mantle-home`. `scripts/VENDORED.json` beside it
records the source commit, SHA-256, host protocol and the Core version the
bundle is pinned to. `scripts/check-plugin-vendor.mjs` verifies the hash, runs
the bundle's `version --json` to compare the protocol and Core pin, and fails
when `coreVersion` is not `packages/mantle`'s version. A Core version bump
therefore needs a mantle-home build pinned to the new version, re-vendored in
the same change. The skill is not in the npm package, and `mantle skills` does
not project it. `scripts/check-skills.mjs` covers every
`plugins/*/skills/*/SKILL.md` with the same front-matter and audit-row rules,
and it requires plugin skills to declare `projection: plugin` only.

Claude Code updates an installed plugin only when its manifest version
changes, and `scripts/sync-plugin-manifests.mjs` sets that version to Core's.
Every re-vendor therefore needs a plugin version bump, that is a Core release,
before Claude Code users receive it; until then they keep the previous bundle.
`npx skills add aotter/mantle --skill mantle-host` reads the repository's
default branch (`main`) and picks up a re-vendor when that branch does.

| Skill | Routes on | Entry-path constraints (read before acting) | Path-gated sections | Projection | Restricted because |
|---|---|---|---|---|---|
| `develop` | existing project; manifest, runtime, handler, adapter, or MCP work | four-atom model; adapter neutrality; no direct D1/KV/Postgres writes; no committed secrets | performance harness; local MCP client; locale rules | project | — |
| `integrate` | independently authored application; add Mantle or rebuild with migration | inspect application before strategy; version-matched SDK; protect live data | embed; incrementally replace; rebuild and migrate | package | Existing-project migration is opt-in; a fresh generated app does not need this brief. |
| `plugin` | user wants an installable capability | plan before apply; lock entry is the removal manifest; delete only plugin-owned files and atoms | apply; remove | project | — |
| `theme` | brand or visual direction in a project | repo-owned theme and UI contracts | — | project | — |
| `update` | SDK upgrade or plugin lock review | never blindly overwrite user-owned code | — | project | — |
| `mantle` | new application, or opening an existing project | do not use the SDK checkout as the application; no push/deploy/provider config during cold start | author local project; continue existing project | plugin | Creates a new project; nothing to project into an existing one. |
| `provision` | ship to Cloudflare, ChatGPT Sites or Mantle Cloud and finish production auth | secrets never enter source or logs; explicit auth mode; one committed `.mantle/hosting.json` with no secrets | Mantle Cloud; hosted auth; self-managed auth | package | Platform-specific deploy that handles production secrets; opt-in only. |
| `mantle-host` | user picked the Mantle Cloud target, or the project has `.mantle/hosting.json` | clean committed tree; grants on stdin only, never in files or logs; deploy is a separate reviewed step; run only printed commands; esbuild is a project devDependency | link; save; deploy; rollback | plugin | Ships only in the mantle-host plugin with its vendored deploy script; Cloud deploy is opt-in. |
| `media-gc` | audit or remove stale uncommitted media objects | audit by default; confirm exact account, bucket, cutoff, and candidate digest; re-audit before applying; never prefix-delete; never print keys | apply | package | Destructive remote object deletion and Cloudflare-specific; opt-in only. |

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
withholds `project` must say why. `plugin` marks a skill installed from this
repository rather than the npm package: the bootstrap skill and `mantle-host`.
`package` is an opt-in brief in the installed SDK. `scripts/check-skills.mjs` holds that
declaration and the audit table below to each other.

Run `mantle skills` to project the installed package's skills into a project;
use `mantle skills --check` to fail closed on drift. The installed package and
`node_modules/@aotter/mantle/docs/` are the single version-matched authority.
Application files and plugin recipes are project context, not competing
contracts.

## Source-repository marketplace install

`skills/install/SKILL.md` declares `name: mantle` and is copied as a small
directory. The other seven package skills live in `docs/skills/` and ship with
the npm package. `mantle skills` projects the four ongoing workflows after
package installation.

The `skills` CLI also reads `.claude-plugin/marketplace.json` and finds
`plugins/mantle-host/skills/mantle-host`. The no-flag command therefore
discovers two skills, `mantle` and `mantle-host`. An interactive run asks
which to install, and an agent or `-y` run installs both. Name the skill to
install exactly one:

```sh
npx skills add aotter/mantle --skill mantle        # bootstrap only
npx skills add aotter/mantle --skill mantle-host   # Mantle Cloud deploy, with its script
```

The second command is the fallback for hosts without a plugin marketplace. It
copies the whole skill directory, including `scripts/mantle-host.mjs` and
`scripts/VENDORED.json`.

Other marketplace hosts point to the same entry:

```sh
npx skills add aotter/mantle
```

```bash
# Claude Code — two separate prompts
/plugin marketplace add aotter/mantle
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle
codex plugin add mantle@mantle
```

Read the path printed by the installer (for project-local Codex,
`.agents/skills/mantle/SKILL.md`). Only the selected brief is installed, not
the SDK or handbook. After choosing and installing an exact SDK version, read
`node_modules/@aotter/mantle/skills/install/SKILL.md` and its embedded docs;
that package supersedes the bootstrap Git-ref instructions. After packages are
installed, `mantle skills` projects the installed package's own skills into the
project, and `mantle skills --check` fails on drift.

Cursor and GitHub Copilot read their manifests from the repository directly.
These manifests are not duplicated into the npm package:

- Claude Code: `.claude-plugin/plugin.json` plus `.claude-plugin/marketplace.json`.
- Codex: `.codex-plugin/plugin.json` plus `.agents/plugins/marketplace.json`.
- Cursor: `.cursor-plugin/plugin.json`.
- VS Code + GitHub Copilot: `.copilot-plugin/plugin.json`.

Both marketplaces also list `mantle-host`, whose own manifests are
`plugins/mantle-host/.claude-plugin/plugin.json` and
`plugins/mantle-host/.codex-plugin/plugin.json`:

```bash
/plugin install mantle-host@mantle
codex plugin add mantle-host@mantle
```

Cursor and Copilot read a single root `plugin.json` here, and this repository
has no multi-plugin manifest for them. They use the `--skill mantle-host`
fallback above. `scripts/sync-plugin-manifests.mjs` generates every manifest
listed here.

## Audience

These are written for **AI agents acting on behalf of consumers of mantle**,
not for contributors maintaining the Mantle SDK itself. SDK contributors use
the repo-root `CONTRIBUTING.md`; it is intentionally not shipped inside the npm
package. Two audiences, two artifacts.

## Discoverability

The skills target ADR-0007's "AI as primary author" thesis: agents reach these files by URL when the user invokes them by intent ("install mantle", "develop my Mantle site", "deploy"). Official cold start is `npx skills add aotter/mantle`. Point the agent at the repository or pass the version-matched markdown content directly.

## Conventions

Each SKILL.md ships:

- **Front-matter** with a stable `name`, trigger-complete
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
