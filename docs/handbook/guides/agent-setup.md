---
description: Trace what npx skills add installs, hand off to the pinned SDK, project version-matched skills and diagnose missing or stale instructions.
---
# Install and verify agent instructions

There are two separate installations: an agent's bootstrap skill and the
application's SDK. Installing one does not install the other.

## 1. Install the bootstrap skill

```sh
npx skills add aotter/mantle
```

The installer selects the repository's `mantle` skill. Read its printed
installation path. In a project-local Codex installation that is
`.agents/skills/mantle/SKILL.md`, not `skills/install/SKILL.md` (the latter is
its source-repository path). Other agent selections and global installation
can use different locations.

The command installs the selected brief; it does not materialize a Mantle
application, install `@aotter/mantle`, or copy `docs/`. The unqualified GitHub
source follows its default branch, not necessarily `develop` or the npm
version you intend to use. The skills installer's lock identifies the source
skill; it is not the application's dependency lockfile.

## 2. Select the SDK version, then read its own instructions

Use the version the project already pins, or resolve the requested npm channel
once and pin every selected `@aotter/mantle*` dependency to the same exact
version. `latest` and `alpha` can describe different capabilities. Resolve only
requirements the user has not provided: host, storage, public API/HTML, and
whether staff need Admin. Follow the bootstrap skill to install the selected
packages locally.
No matching `mantle-starters` tag or bundle is needed to create a project.

Then read:

```text
node_modules/@aotter/mantle/skills/install/SKILL.md
node_modules/@aotter/mantle/docs/handbook/start/overview.md
node_modules/@aotter/mantle/docs/handbook/reference/features.md
```

These files are in the npm tarball. They are the version-matched authority,
including when the bootstrap skill came from a different Git ref. Every
`docs/...` path in the skill resolves under the installed package, not under
`.agents/skills/mantle/`. Keep using that SDK's docs for host examples and CLI
behavior. No local `mantle` binary is available before package installation.

## 3. Project the ongoing workflows

From the application root, after installing the SDK:

```sh
pnpm exec mantle --help
pnpm exec mantle skills
pnpm exec mantle skills --check
```

| Artifact | What you get |
|---|---|
| `.agents/skills/mantle-{develop,plugin,theme,update}/SKILL.md` | The installed package's four project-scoped workflows. |
| `.claude/skills/mantle-{develop,plugin,theme,update}/SKILL.md` | Identical bytes for Claude compatibility. |
| `node_modules/@aotter/mantle/skills/` | All seven shipped skills, including opt-in `mantle`, `provision` and `media-gc`. |
| `node_modules/@aotter/mantle/docs/` | Handbook and examples matched to the package. |

`mantle skills` overwrites these four generated projections. Keep project-specific
instructions elsewhere. `--check` does not write: exit 0 means they match,
1 means missing/stale projections, and 2 means a command/package error.
`mantle generate` does not project skills. Projection does not remove an older
bootstrap `install` or legacy `.agent/skills` copy; use the version-matched
project skills for ongoing work.

## 4. Complete and verify the application

Follow a [tutorial](../start/overview.md#start-with-your-integration), then run
its generation, validation, TypeScript checks and actual local route probes.
Successful skill installation proves only that the instructions were copied.
It does not prove a server, login, Admin assets or MCP connection works.

| Symptom | Cause and next step |
|---|---|
| `skills/install/SKILL.md` is missing | That is source provenance. Read the installer's destination instead. |
| `docs/...` is missing after `skills add` | The skill does not carry the handbook. Install the pinned SDK and read its embedded docs. |
| `mantle` is missing | Install local `@aotter/mantle`; run its binary through the project package manager. |
| `MANIFEST_ROOT_NOT_FOUND` | Author manifests in the configured directory; `generate` is not a scaffold command. |
| `mantle skills --check` exits 1 | Run `mantle skills`, then read the refreshed project skill. |
| No projected provision/media-gc skill | These are intentionally opt-in. Read their installed package files when the task calls for them. |
| A documented feature fails on an older release | Use that release's docs or explicitly upgrade; changing a skill does not change Runtime. |

## Source

- [Bootstrap install skill](../../../skills/install/SKILL.md)
- [Projection implementation](../../../packages/mantle/src/cli/skills.ts)
- [Package file list](../../../packages/mantle/package.json)
- [Package docs and skills copying](../../../scripts/sync-package-docs.mjs)
