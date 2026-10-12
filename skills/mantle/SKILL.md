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
application). For workspace links, inspect the linked package's README first; concrete
`generated.ts` queries select the [native flow](#generated-native-applications)
before the Core version rules below. The same flow applies when an installed
alpha.7-or-later package README documents generated native queries; stop before
the historical Core new-project instructions. If it has `@aotter/mantle`, read its `package.json`, lockfile and
`node_modules/@aotter/mantle/package.json`, and follow that version's docs.

- `0.2.x`: continue below; for ongoing work read
  `node_modules/@aotter/mantle/docs/skills/develop/SKILL.md`.
- `0.1.x` (v1 manifests, a `version: 1` `mantle.config.json`, `mantle skills`):
  upgrade only when asked, with `docs/skills/update/SKILL.md` and
  `docs/upgrade-0.1-to-0.2.md` of the 0.2 package.

## Generated native applications

Follow the installed (or workspace-linked) package README for generation, Workers
builds and D1 Sessions; the Core scaffolding below does not apply. Read that
version's `docs/next/compatibility.md` before choosing declarations; planned
features require their implementation first. Keep auth behind
`authLoader(() => import(...))` to pass the startup guard. Install only the exact
released version shown by the installed/target package
contract. Replacing Core needs explicit app wiring and reviewed deployment
migrations; never use initial schema.sql as an in-place production upgrade.
Pass outgoing `responseHeaders` to `resolveCaller` so Better Auth's session cookie
can slide. Native auth adapters use joins by default; keep the joined primary
session/user check, including before any refresh from secondary storage.

Use the workflow **generate → typecheck → implement listed handlers**: run
`mantle generate`, then `tsc --noEmit`. Implement every printed `Handlers` key
and pass the implementations at `store(db, caller, { handlers })` (and selected
surface options). Run `tsc --noEmit` again before local acceptance.
Generated Store metadata initializes on its first use, once per module. Bind
`store(db, caller, options?)` for the current request; never reuse one caller's
bound Store for another caller.

Use `paged/views/<encoded-name>.ts` for bounded cursor walks, including internal
Views that satisfy the installed package's generation-time paging proofs.
Call its default export with `(db, caller, input, { limit?, cursor? })`; it returns
`{ rows, nextCursor? }`. Internal paging creates no public route/tool. Keep bare
Views for authored-query row arrays, and inspect native EXPLAIN/source indexes
when grouping: cursor paging does not eliminate aggregation work.

Commit everything `mantle generate` writes, including generated TypeScript, SQL and
Wrangler edits; keep bundle `dist/` untracked. Never hand-edit generated files.
Resolve conflicts by merging manifests/options and regenerating. Add the printed
`.gitattributes` line and run the same generate command with `--check` in CI.
Compose the app-owned `fetch` using `docs/next/service.md`: auth/consent, Admin,
MCP, REST behind one request-local origin-checked resolver; keep heavy auth dynamic.

For generated native applications, optional site settings/media are selected
with `--site <module>` exporting `siteDefaults`. Apply the emitted deployment DDL;
wire application-owned object storage as documented in `docs/next/media.md`.

For selected experimental Admin, mount the generated `admin({ db, caller, ... })`
handler yourself. Use a cookie session with OSS role `staff`, and provide an
`assets` function that returns `null` for missing files. Pass ref handlers in the
options; verify `/admin/api/bootstrap` and a scoped staff View against the local
native database before deploying. Read `docs/next/surfaces.md#mounting-admin` for
optional identity/site facets, CSV, origin checks and the other Admin modules.
Verify `/admin/api/webmcp` and one same-origin `POST /admin/api/webmcp/<tool>`:
only declared staff tools are exposed, with the same native validation/paging and
caller-owned ref handlers as MCP. This browser boundary does not need the MCP SDK.

For a generated public website, follow [web mounting and acceptance](references/web.md).
The app renders HTML and inserts `site.head()`; generated `web.ts` serves the
indexes and Markdown alternates.

For site/media/staff management, pass object storage as `media` and lazy native
identity methods in `identity.directory(context)`; forward the request headers
and verified caller to `d1Identity`/`postgresIdentity`. Verify media upload/commit,
member cursor paging and invitations locally. Missing capabilities return 501;
use only `staff` or `null` in role updates.

For a Cloud design-only draft, use generated `adminDesign({ name, origin })`
with no DB/Caller wiring. Its `/admin/api/me` role stays null and only four
static GET projections exist; 403 `DESIGN_ONLY` means a host must supply a
separate authorized runtime to test business operations. Keep the existing
`@aotter/mantle-ui/admin-preview` document/protocol helpers, and verify the
message's origin, iframe source and active draft/revision before serving it.
Read `docs/next/surfaces.md#design-preview`; never substitute a staff identity
to make the preview render.

For selected Admin extensions, use full app-owned declarations with OSS role
`staff` and `--admin-extensions <module>`, then merge the generated helper's
route/assets/public-metadata facets into `admin`. Generate → typecheck → implement
the declared settings/action/API handlers using native context; preserve scope,
OCC and transaction handling in their writes. Keep UI modules same-origin and
source loaders lazy. Read `docs/next/admin-extensions.md` and test denied callers,
invalid settings and browser SRI before deploying.
For that console, test OTP sign-in through the app-owned Better Auth handler,
actual entries/member/media requests and an ordinary member's 403. Serve the
installed UI asset directory through the app's Wrangler binding or Bun reader;
do not import the SPA into the query bundle. Next uses the single `staff` role,
explicit publishing metadata and forward entry paging with URL cursor history.
Verify conflict handling reads the latest entry once without retrying a write or
losing the user's edits. Keep legacy 0.2 role setup separate from this experiment.


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
   check that the console loads and `GET /admin/api/me` is `owner`. Exercise the REST routes and `/mcp` `tools/list`. For custom handlers and websites, run the [local HTTP acceptance](references/cloud.md#local-http-acceptance-before-source-upload) before uploading source; compilation and packing do not execute handlers.

For a local cold start, do not push, deploy or configure providers. For a
requested hosted app, continue with the selected hosting workflow.

## Complete websites

For a requested complete website, apply [website defaults](references/website.md)
without asking the user to enumerate OTP, media, Admin or SEO. A Cloud frontend
kit is authoritative about the selected runtime's capabilities. Defaults are
acceptance requirements, not evidence that a missing renderer is implemented.
Do not report a complete website with blocked required checks.

## Hosting and publishing

Follow the user's requested host. A request for a complete hosted Mantle Cloud
app includes saving, previewing and publishing it; continue through the terminal
release result. A local-only or save-only request stops there. Creating a local
project alone does not imply a deploy request. Self-hosting remains available.

- **Experimental Workers consumers:** use the generation/build flow above.
- **Core Cloudflare Workers or ChatGPT Sites:** follow
  `node_modules/@aotter/mantle/docs/skills/provision/SKILL.md` and that host's
  native deployment workflow.
- **Mantle Cloud:** follow [Cloud workflow](references/cloud.md). The bundled
  `scripts/mantle-cloud.mjs` supports `check`, `prepare`, `source`, `open`, `pack backend`, `pack frontend` and `version`.
  Cloud MCP owns source admission, review, durable deployment and rollback. After one accepted publication, read native status until terminal; do not advance each deployment step. Run the helper by absolute path from the application root;
  follow the discovered Cloud MCP schemas and the workflow reference;
  local pack output is not Cloud state. It uses the project's installed compiler and esbuild; it bundles
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
Cloud contracts or Git credentials to the helper over stdin. Existing OAuth/session and project
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

Admin deployment applies the generated `admin-schema.sql` alongside the initial schema before mounting `admin.ts`. Admin entries use native Store reads and generated validation; an Archived entry may be restored to a draft with Unpublish, as in 0.2.
