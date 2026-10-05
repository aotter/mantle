---
name: mantle
description: Create a Mantle 0.2 service, continue an existing one, or save, preview and publish it on Mantle Cloud, using the installed @aotter/mantle package's own docs and this skill's Cloud helper script.
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
2. For a Mantle Cloud project, first connect Cloud MCP and select or create the
   organization/project as described in [Cloud workflow](references/cloud.md).
   Use the exact Core version returned by `cloud_host_contract`. Otherwise
   choose the version: `npm view @aotter/mantle dist-tags`. Use a `0.2.x`
   version (while 0.2.0 is in prerelease it is on `alpha`; `latest` may still
   be 0.1.x). Install it exactly: `npm install --save-exact @aotter/mantle@<version>`
   (or the pnpm/yarn/bun equivalent). Install `@types/node` and `typescript`
   as dev dependencies; Cloudflare additionally needs `wrangler` and
   `@cloudflare/workers-types`, while Bun needs `bun-types`. Pin every
   `@aotter/mantle*` package to that same version. If the project's registry
   overrides npmjs, add `@aotter:registry=https://registry.npmjs.org/` to the
   project's `.npmrc`.
3. Read `node_modules/@aotter/mantle/docs/handbook/start/quickstart-worker.md`
   for Cloudflare, or `docs/handbook/start/project-and-cli.md` for Bun,
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
   those with the project's package manager and run it again. Use Core's
   installed `package.json` `peerDependencies` versions for auth/MCP peers,
   not registry latest; resolve incompatible peer warnings before running.
   Then
   `mantle generate --check` and `tsc --noEmit`.
7. With identity `mantle`: `cp .dev.vars.example .dev.vars`, set
   `ADMIN_EMAIL` and a random `BETTER_AUTH_SECRET`, run `wrangler dev --local`
   (on Bun: `.env.example` to `.env`, then `bun src/index.ts`),
   sign in at `/admin/sign-in` with the one-time code printed to the log, and
   check that the console loads and `GET /admin/api/me` is `owner`. Exercise the REST routes and `/mcp` `tools/list`.

For a local cold start, do not push, deploy or configure providers. For a
requested hosted app, continue with the selected hosting workflow.

## Hosting and publishing

Follow the user's requested host. A request for a complete hosted Mantle Cloud
app includes saving, previewing and publishing it; continue through the terminal
release result. A local-only or save-only request stops there. Creating a local
project alone does not imply a deploy request. Self-hosting remains available.

- **Cloudflare Workers or ChatGPT Sites:** follow
  `node_modules/@aotter/mantle/docs/skills/provision/SKILL.md` and that host's
  native deployment workflow.
- **Mantle Cloud:** follow [Cloud workflow](references/cloud.md). The bundled
  `scripts/mantle-cloud.mjs` supports `link`, `save`, `status`, `deploy`,
  `rollback` and `version`. Run it by absolute path from the application root;
  execute its literal `nextAction` using the connected Cloud MCP, not guessed
  tool names. It uses the project's installed compiler and esbuild; it bundles
  no Core, SQL parser, provider credentials or application runtime.

For an offline readiness check:

```bash
node <this skill>/scripts/mantle-cloud.mjs check [--project <dir>] [--core <Cloud version>]
```

It reads only the project, compiles with its installed `@aotter/mantle/spec`,
and prints `{ ok, coreVersion, fingerprint, sourceHash, planFile, cloud,
nextAction? }`. `cloud: "not_checked"` is not a deployment result.
`planFile: "stale"` means regenerate and commit `.mantle/generated/`;
`core_mismatch` means install Cloud's exact version. Cloud serves D1 plans.

The plugin configures `https://cloud.mantle.tools/mcp`. The same Cloud workflow
works with a staging MCP connection; do not change production to staging behind
the user's back. Never put tokens or grants in files, commands or chat. Pipe
Cloud results to the helper over stdin. Existing OAuth/session and project
edit/deploy rules still apply; Cloud membership never grants tenant staff access.

## Existing project and handoff

Preserve the user's manifests, `src/` files, identity, package versions and
provider resources. `src/service.ts`, `src/index.ts` and `wrangler.jsonc` are
the application's after the first generate. Run `mantle generate --check` and
the project's own tests before and after a change.

To add Mantle to an application that has its own code, users and data, read
`node_modules/@aotter/mantle/docs/skills/integrate/SKILL.md` first.

Report the project path, the exact Mantle version, what you changed, the checks
you ran with their results, and anything left for the user.
