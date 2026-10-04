---
name: mantle
description: Create a Mantle 0.2 service, continue an existing one, or check it for Mantle Cloud, using the installed @aotter/mantle package's own docs and this skill's Cloud helper script.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/mantle/SKILL.md
  applies_to: mantle 0.2
  projection: plugin
  projectionReason: The plugin's entry skill; it creates projects and carries the Cloud helper, so it is installed from the repository, not the npm package.
---

# Mantle

The Mantle plugin's one skill. It installs no SDK and creates nothing by
itself. Once a project has `@aotter/mantle`, the installed package is the
authority: `node_modules/@aotter/mantle/README.md` and
`node_modules/@aotter/mantle/docs/`. Prefer them over this file, the SDK
checkout, or any online copy.

## Find the project and its version

Locate the user's application (never use the SDK repository as the
application). If it has `@aotter/mantle`, read its `package.json`, lockfile and
`node_modules/@aotter/mantle/package.json`, and follow that version's docs.

- `0.2.x`: continue below; for ongoing work read
  `node_modules/@aotter/mantle/docs/skills/develop/SKILL.md`.
- `0.1.x` (v1 manifests, a `version: 1` `mantle.config.json`, `mantle skills`):
  upgrade only when asked, with `docs/skills/update/SKILL.md` and
  `docs/upgrade-0.1-to-0.2.md` of the 0.2 package.

## New project

1. Create a directory outside the SDK checkout with Node 22+ and
   `"type": "module"` in `package.json`.
2. Choose the version: `npm view @aotter/mantle dist-tags`. Use a `0.2.x`
   version (while 0.2.0 is in prerelease it is on `alpha`; `latest` may still
   be 0.1.x). Install it exactly: `npm install --save-exact @aotter/mantle@<version>`
   (or the pnpm/yarn equivalent), plus `wrangler`, `@cloudflare/workers-types`,
   `@types/node` and `typescript` as dev dependencies. Pin every
   `@aotter/mantle*` package to that same version. If the project's registry
   overrides npmjs, add `@aotter:registry=https://registry.npmjs.org/` to the
   project's `.npmrc`.
3. Read `node_modules/@aotter/mantle/docs/handbook/start/quickstart-worker.md`
   and `docs/handbook/reference/features.md`.
4. Choose the identity and features with the user's request:
   `mantle generate` with no flags is Better Auth sign-in plus Admin, MCP and
   REST; `--identity custom` keeps the user's own auth;
   `--identity none --features web` is a public REST service. The default
   host is Cloudflare over D1; `--host bun` (PostgreSQL unless
   `--dialect sqlite`) or `--dialect postgres` choose another
   (`docs/handbook/start/project-and-cli.md`). Identity, host and dialect
   cannot be switched later.
5. Write only the user's Schemas, Views, Procedures and Triggers in
   `manifests/`. `docs/examples/` shows whole services; do not copy one
   wholesale or invent business data.
6. Run `mantle generate`. When it names missing packages, install exactly
   those with the project's package manager and run it again. Then
   `mantle generate --check` and `tsc --noEmit`.
7. With identity `mantle`: `cp .dev.vars.example .dev.vars`, set
   `ADMIN_EMAIL` and a random `BETTER_AUTH_SECRET`, run `wrangler dev --local`
   (on Bun: `.env.example` to `.env`, then `bun src/index.ts`),
   sign in at `/admin/sign-in` with the one-time code printed to the log, and
   check that the console loads and `GET /admin/api/me` is `owner`. Exercise the REST routes and `/mcp` `tools/list`.

Do not push, deploy or configure providers during a cold start.

## Deploy

Deploying is a separate, explicit request. Self-hosting is always available,
and Mantle Cloud is one option, never a requirement.

- **Cloudflare Workers or ChatGPT Sites:** follow
  `node_modules/@aotter/mantle/docs/skills/provision/SKILL.md`.
- **Mantle Cloud:** Cloud does not accept 0.2 services yet; it needs host
  protocol 3 (a service entry with its compiled plan). Until then, check that
  the project is ready and tell the user Cloud deploy is not available:

```bash
node <this skill>/scripts/mantle-cloud.mjs check [--project <dir>] [--core <version Cloud pins>]
```

  It compiles the manifests with the project's installed
  `@aotter/mantle/spec` (the plugin bundles no compiler), writes nothing and
  contacts no network. It prints one JSON line,
  `{ ok, coreVersion, fingerprint, sourceHash, planFile, cloud, nextAction? }`.
  `planFile: "stale"` means run `mantle generate` and commit
  `.mantle/generated/`. `core_mismatch` means install the version Cloud pins.
  `dialect_unsupported` means the project is not on D1, the only dialect Cloud
  runs.
  Run it by absolute path; never edit it.

The plugin also configures the Mantle Cloud MCP connection
(`https://cloud.mantle.tools/mcp`). Never put tokens or grants in files,
commands or chat.

## Existing project and handoff

Preserve the user's manifests, `src/` files, identity, package versions and
provider resources. `src/service.ts`, `src/index.ts` and `wrangler.jsonc` are
the application's after the first generate. Run `mantle generate --check` and
the project's own tests before and after a change.

To add Mantle to an application that has its own code, users and data, read
`node_modules/@aotter/mantle/docs/skills/integrate/SKILL.md` first.

Report the project path, the exact Mantle version, what you changed, the checks
you ran with their results, and anything left for the user.
