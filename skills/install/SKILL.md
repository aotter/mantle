---
name: install
description: Author a new Mantle application directly from version-matched SDK docs, or continue an existing project. Use when asked to install Mantle, build a Mantle application, or open a Mantle repository.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/install/SKILL.md
  applies_to: mantle grammar v0.1
  projection: plugin
  projectionReason: Creates a new project; nothing to project into an existing one.
---

# Mantle Install

Mantle is an embeddable manifest engine. The application owns its source and
provider configuration. There is no Starter/type picker or `mantle create`.
Do not use the SDK checkout as the application, copy an old Starter tree, or
turn `generate` into implicit scaffolding.

## New application

1. Determine the actual host and required surfaces from the request. Reuse an
   existing application when available; otherwise work in its own directory.
   Do not assume Cloudflare, public HTML or Admin is required. Check Node 22+
   and pnpm 9+ for these SDK examples.
2. Choose the requested exact SDK version, or resolve the intended release
   channel once. Pin all selected `@aotter/mantle*` dependencies to that same
   version. Install only the adapter/optional packages the application needs.
   If a global scope registry overrides public npmjs, use a project-owned
   `.npmrc` with `@aotter:registry=https://registry.npmjs.org/`.
3. Read the installed `node_modules/@aotter/mantle/docs/handbook/start/project-and-cli.md`.
   The version-matched `docs/examples/minimal-worker/` is a runnable Cloudflare
   reference, not a template to install wholesale. Other hosts use the embedded
   adapter guides. Author package scripts, manifests, entry and configuration
   for the user's requirements. No default notes model, home page, icon,
   launch metadata or frontend is required.
4. Compile and verify using the application's commands. The fundamental CLI
   sequence is:

```sh
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec mantle validate
pnpm exec mantle skills
pnpm exec mantle skills --check
```

Run the project's TypeScript check and start its actual local server. Probe a
route the application declares; an API-only project may correctly return 404
at `/`. Auth routes may return `503 setup_incomplete` until the selected auth
provider is configured. Do not introduce an auth bypass to make smoke pass.

Commit the resolved lockfile in the application's normal workflow; subsequent
installs use `pnpm install --frozen-lockfile`. Do not initialize/push a remote,
provision resources, deploy or commit secrets as part of local verification.

## Existing application

Read package.json, lockfile, actual entry, manifest files, provider config and
project instructions. `.mantle/launch-state.json`, features or handoff files
are optional legacy context, never prerequisites. Preserve them and user code.
Install the frozen dependency graph, project installed Core skills, then read
those skills and embedded docs. Never apply develop docs to an older package.
Use the installed `mantle --help` and the project's scripts as authority.

For legacy alpha.17 projects, retain their pinned behavior until an explicit
upgrade is requested; read `docs/migration-0.1.2.md` before upgrading. Do not
rewrite provider identities, delete metadata or fetch a nonexistent new Starter
tag. SDK upgrades follow the update skill, not a bundle comparison command.

## Ship and report

When deployment is requested, follow the installed provision skill and the
observed host configuration. Legacy Landing remains an alpha.17 product; it
is not a launch dependency for new Core projects.

Report the project path, exact SDK version, local URL/HTTP result and checks,
plus any genuinely missing auth/provider setup. Do not claim a working homepage
or authenticated MCP based only on successful generation.
