---
description: Install the Mantle agent skill, hand off to the installed package's `mantle help`, and diagnose missing or stale instructions.
---
# Install and verify agent instructions

Two separate things are installed: the agent's `mantle` skill and the application's `@aotter/mantle` package. The skill
holds no contract and does not depend on the SDK version: it sends the agent to `mantle help`, which prints the docs
shipped inside the installed package. So the skill can come from the latest repository while the application pins any
version.

## 1. Install the `mantle` skill

Any agent that reads skills:

```sh
npx skills add aotter/mantle@mantle
```

The explicit name excludes the repository's maintainer skills. As a plugin, which carries the same one skill and no
hosted-service connection:

```sh
codex plugin marketplace add aotter/mantle
codex plugin add mantle@mantle
```

```text
/plugin marketplace add aotter/mantle
/plugin install mantle@mantle
```

Cursor and GitHub Copilot read their plugin manifests from the same repository. The skill installs no SDK, creates no
project and copies no handbook.

## 2. Install the SDK and read its docs

Use the version the project already pins. For a new project, pick one exact version from
[Releases](../releases/index.md) (only plain `X.Y.Z` versions are for production) and pin every selected
`@aotter/mantle*` package to it:

```sh
pnpm add --save-exact @aotter/mantle@<version>
npx mantle help
```

`mantle help` prints the installed version's entry page; prefer it over any online copy of this handbook.

## 3. Verify the application

Run the app's exact generation command with `--check`, typecheck, implement every printed handler and typecheck again.
Test actual routes and persisted state, then run acceptance as the entry page describes. Installing a skill proves none
of these flows.

If `mantle help` reports missing docs, reinstall the SDK version the app pins. If a feature differs from an online page,
the installed docs win.
