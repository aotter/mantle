---
description: Install the Mantle agent plugin or its one skill, hand off to the installed package's own docs, and diagnose missing or stale instructions.
---
# Install and verify agent instructions

Two separate things are installed: the agent's `mantle` skill and the
application's `@aotter/mantle` package. Installing one does not install the
other, and the installed package is always the authority for the version it
carries.

## 1. Install the `mantle` skill

The Mantle plugin carries one OSS authoring skill, `mantle`, and local
acceptance references. It does not configure a hosted-service connection.
Install from the Git tag matching the exact SDK version you selected (currently
`v0.2.0`). Pin the tag to keep instructions aligned with the application's
SDK. A skill install does not upgrade the application's SDK.

For Codex, pin the marketplace checkout:

```sh
codex plugin marketplace add aotter/mantle --ref v0.2.0
codex plugin add mantle@mantle
```

For Claude Code, first clone the release into a directory you will keep:

```sh
git clone --depth 1 --branch v0.2.0 https://github.com/aotter/mantle.git mantle-plugin
```

Then, in Claude Code, use that checkout's absolute path:

```text
/plugin marketplace add /absolute/path/to/mantle-plugin
/plugin install mantle@mantle
```

Cursor and GitHub Copilot use their plugin manifests from the same tagged
checkout. Without a plugin host, install only the consumer skill by name:

```sh
npx skills add https://github.com/aotter/mantle/tree/v0.2.0 --skill mantle
```

When upgrading the SDK, update the marketplace ref or local tagged checkout and
refresh/reinstall the plugin using the host's native workflow. Verify the loaded
manifest version and skill source. Do not reset a checkout containing local edits.

Read the path the installer prints (for project-local Codex,
`.agents/skills/mantle/SKILL.md`). The skill installs no SDK, creates no
project and copies no handbook.

## 2. Install the SDK, then read its own docs

Use the version the project already pins. For a new project, install stable
0.2.0 exactly:

```sh
pnpm add --save-exact @aotter/mantle@0.2.0
```

Add optional `@aotter/mantle-ui@0.2.0` and `@aotter/mantle-admin@0.2.0` only
when the selected surfaces need them. Every selected `@aotter/mantle*` package
stays at the same exact version. Read, from the application:

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
| `docs/skills/performance/SKILL.md` | after acceptance converges, or when a page, first request or query is slow |

0.2.0 has no `mantle skills` command: nothing is copied into the project.
An agent reads these files from `node_modules` when the task calls for them.

## 3. Verify the application

Run the app's exact generation command with `--check`, typecheck, implement every printed handler and typecheck again. Test actual routes and persisted state. With selected Admin, mount `entries(bindings.schemas, bindings.adapter)` and serve assets separately. Verify member/admin OTP, row visibility and OCC. Installing a skill proves none of these flows.

If packaged docs are missing, reinstall the SDK version pinned by the app. If a feature differs from an online page, read the installed docs rather than assuming compatibility.
