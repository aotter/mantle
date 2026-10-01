---
description: Install the Mantle agent plugin or its one skill, hand off to the installed package's own docs, and diagnose missing or stale instructions.
---
# Install and verify agent instructions

Two separate things are installed: the agent's `mantle` skill and the
application's `@aotter/mantle` package. Installing one does not install the
other, and the installed package is always the authority for the version it
carries.

## 1. Install the `mantle` skill

The Mantle plugin carries one skill, `mantle`, its helper script, and the
Mantle Cloud MCP connection (`https://cloud.mantle.tools/mcp`).

```bash
# Claude Code: two separate prompts
/plugin marketplace add aotter/mantle
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle
codex plugin add mantle@mantle
```

Cursor and GitHub Copilot read the plugin manifests from the repository.
Without a plugin host, install the skill alone:

```sh
npx skills add aotter/mantle
```

A skill-only install has no Cloud MCP connection; add one by hand if you need
it. Either way, read the path the installer prints (for project-local Codex,
`.agents/skills/mantle/SKILL.md`). The skill installs no SDK, creates no
project and copies no handbook.

## 2. Install the SDK, then read its own docs

Use the version the project already pins. For a new project, choose a 0.2.x
version with `npm view @aotter/mantle dist-tags` and install it with an exact
version; every `@aotter/mantle*` package stays at that same version. Then
read, from the application:

```text
node_modules/@aotter/mantle/README.md
node_modules/@aotter/mantle/docs/handbook/start/overview.md
node_modules/@aotter/mantle/docs/handbook/reference/features.md
node_modules/@aotter/mantle/docs/skills/<workflow>/SKILL.md
```

These ship in the npm tarball and match the installed code. Prefer them over
the skill's GitHub copy and over any online handbook.

| Package skill | Read it when |
|---|---|
| `docs/skills/develop/SKILL.md` | changing manifests, handlers, the service or its surfaces |
| `docs/skills/integrate/SKILL.md` | adding Mantle to an existing application |
| `docs/skills/update/SKILL.md` | upgrading `@aotter/mantle`, including from 0.1.x |
| `docs/skills/provision/SKILL.md` | deploying, with production sign-in |
| `docs/skills/media-gc/SKILL.md` | auditing or removing stale R2 uploads |

0.2.0 has no `mantle skills` command: nothing is copied into the project.
An agent reads these files from `node_modules` when the task calls for them.

## 3. Verify the application

Installing instructions proves only that they were copied. Prove the service:

1. `mantle generate` and `mantle generate --check` exit 0.
2. The project typechecks against `.mantle/generated/mantle.ts`.
3. `wrangler dev` starts, and the routes you depend on answer: a REST View, an
   HTTP Trigger, `/mcp` `tools/list`, and with identity `mantle` a sign-in and
   `GET /admin/api/me`.

| Symptom | Cause and next step |
|---|---|
| `docs/...` is missing after installing the skill | The skill carries no docs. Install the SDK and read `node_modules/@aotter/mantle/docs/`. |
| `mantle` is not found | Install `@aotter/mantle` locally and run it through the package manager (`pnpm exec mantle`). |
| `mantle skills` or `--host` is unknown | Those are 0.1.x. Follow the installed 0.2.x docs. |
| A v1 manifest or a `version: 1` config fails | The project is on 0.1.x. Follow `docs/upgrade-0.1-to-0.2.md`. |
| A documented feature is missing | The installed version is older than the docs you read. Read its own docs, or upgrade deliberately. |
