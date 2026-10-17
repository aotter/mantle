---
name: mantle
description: Create, continue, test or deploy a Mantle application using installed @aotter/mantle docs, including manifests, SQL Views and Procedures, MCP tools, app-built Admin, mantle generate and Mantle upgrades.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/mantle/SKILL.md
  applies_to: mantle 0.2
  projection: plugin
  projectionReason: The plugin's authoring entry skill is installed from the repository; workflow documentation comes from the installed SDK package.
---

# Mantle

The Mantle plugin's one skill. It installs no SDK and creates nothing by
itself. Once a project has `@aotter/mantle`, the installed package is the
authority: `node_modules/@aotter/mantle/README.md` and
`node_modules/@aotter/mantle/docs/`. Prefer them over this file, the SDK
checkout, or any online copy.

## Find the project and its version

Work in the user's application, outside the SDK checkout. Read package.json, the lockfile, installed SDK README and node_modules/@aotter/mantle/docs/. Those files define the exact version's contract. Preserve existing identity, handles, routes and resources.

## Choose the installed package skill

- Read `node_modules/@aotter/mantle/docs/skills/develop/SKILL.md` to change an existing project's manifests, SQL, handlers, service entry or surfaces.
- Read `node_modules/@aotter/mantle/docs/skills/integrate/SKILL.md` to add Mantle to an application with existing code, users or data.
- Read `node_modules/@aotter/mantle/docs/skills/update/SKILL.md` to upgrade Mantle, including from 0.1.x.
- Read `node_modules/@aotter/mantle/docs/skills/provision/SKILL.md` only for an authorized production deployment.
- Read `node_modules/@aotter/mantle/docs/skills/media-gc/SKILL.md` only to audit or remove stale uncommitted media uploads.

For a new project, install an exact published SDK version with matching selected Admin/UI packages. Node must be 22.22 or newer. Add TypeScript and target types; Workers also need Wrangler. `node_modules/@aotter/mantle/docs/examples/app-shell/package.json` lists the Wrangler, TypeScript and type-package versions this release is tested with. Optional auth/MCP peers use the installed SDK's package.json versions. Read the installed handbook's start/project-and-cli.md before choosing a target.

For a new Cloudflare app, copy `node_modules/@aotter/mantle/docs/examples/app-shell/` first, then the closest example from `docs/examples/README.md` on top of it, and edit from there: manifests, `src/handlers.ts`, `src/routes.ts`, `src/schedule.ts`, `smoke.mjs`. Search for `AGENT:` to find what the app must fill in; the example pages are unstyled on purpose, so styling them is part of that work. Before reporting done, resolve each `AGENT:` or name the ones you left. Keep the two roles `admin` and `user` unless the user asks for more.

Before reporting any user-facing work as done, follow the installed
`node_modules/@aotter/mantle/docs/handbook/guides/agent-workflow-acceptance.md`:
run independent acceptance with a fresh agent on the surface its user uses.
This is not limited to MCP; if it was not run, say so explicitly and report the
work as UNVERIFIED rather than done. For MCP workflows, also run the guide's
design audit before implementing tools. This workflow practice applies to every
installed SDK version: if its guide is older or MCP-scoped, apply its fresh-agent
round loop to the user-facing surface actually built. If an older installed
version lacks this guide, record the missing guidance and preserve that version's
contract; do not silently upgrade or substitute checkout/online docs.

For existing older applications, use their installed docs until the user requests an upgrade. For partial adoption read node_modules/@aotter/mantle/docs/skills/integrate/SKILL.md.

## Generated native applications

Follow the installed (or workspace-linked) package README for generation, Workers
builds and D1 Sessions; the app owns its entry and routing. Read that
version's `docs/handbook/reference/features.md` before choosing declarations. Keep auth behind
`authLoader(() => import(...))` to pass the startup guard. Install only the exact
released version shown by the installed/target package
contract. Replacing Core needs explicit app wiring and reviewed deployment
migrations; never use initial schema.sql as an in-place production upgrade.
Pass outgoing `responseHeaders` to `resolveCaller` so Better Auth's session cookie
can slide. Native auth adapters use joins by default; keep the joined primary
session/user check, including before any refresh from secondary storage.
Only positively classified View/web reads may pass `readOnly: true`, with official
cookieCache `{enabled:true,maxAge:60,refreshCache:false,version:"read-60-v1"}` and
no KV. Bump version when enabling/changing the policy; writes, Admin, consent,
unknown/ref/media calls stay fresh. Read the installed auth docs before MCP caching.

Use the workflow **generate → implement listed handlers → check**. In an app
copied from the installed app shell, its scripts are the canonical commands:

```sh
pnpm generate
pnpm check
```
Implement every printed `Handlers` key
and pass the implementations at `store(db, caller, { handlers })` (and selected
surface options).
Generated Store metadata initializes on its first use, once per module. Bind
`store(db, caller, options?)` for the current request; never reuse one caller's
bound Store for another caller.

Use `paged/views/<encoded-name>.ts` for bounded cursor walks, including internal
Views that satisfy the installed package's generation-time paging proofs.
Call its default export with `(db, caller, input, { limit?, cursor? })`; it returns
`{ rows, nextCursor? }`. Internal paging creates no public route/tool. Keep bare
Views for authored-query row arrays, and inspect native EXPLAIN/source indexes
when grouping: cursor paging does not eliminate aggregation work.
Bare Views, Store and SQL Procedure results keep driver-native scalar values.
Selected REST/MCP/Admin boundaries return target-identical `WireRow` types:
declared integers become safe numbers or exact decimal strings, SQLite/D1
JSON/booleans become JSON values/booleans, and compiler-declared decimals become
strings. Selected SQL reads integer text before driver rounding; it cannot repair
already-rounded writes. Use exported `WireRow` for clients and `Row` for bare
queries. Computed/ref results remain app-owned.

Commit everything `mantle generate` writes, including generated TypeScript, SQL and
Wrangler edits; keep bundle `dist/` untracked. Never hand-edit generated files.
Resolve conflicts by merging manifests/options and regenerating. Add the printed
`.gitattributes` line and run the same generate command with `--check` in CI.
Compose the app-owned `fetch` using `docs/handbook/cloudflare/service-entry.md`: auth/consent, Admin,
MCP, REST behind one request-local origin-checked resolver; keep heavy auth dynamic.

For selected native Admin, follow the version-matched
`docs/handbook/guides/native-admin.md`: select `--admin` (or `admin: true`), then
build and serve the application-owned Admin with `mantle bundle` as that guide
describes.
Admin reads share generated whitelisted native View templates, writes use native
Procedure fragments and generated checks. Ref operations retain typed `ctx.store`
at request time. Verify member/frontend and admin/Admin OTP, tenant/privacy/TTL,
publishing, paging, statistics, exact OCC, ref effects and the actual console;
never retry unknown 503 writes automatically. Read the installed Admin README
for raw-body limits, CSP/assets, 22 languages and the developer workspace.
Use only versions actually published, or the explicitly linked workspace packages.

For generated native applications, optional site settings/media are selected
with `--site <module>` exporting `siteDefaults`. Apply the emitted deployment DDL;
wire application-owned object storage as documented in `docs/handbook/cloudflare/media-r2.md`.

For a generated public website, follow [web mounting and acceptance](references/web.md).
The app renders HTML and inserts `site.head()`; generated `web.ts` serves the
indexes and Markdown alternates.

## Complete websites

For a requested complete website, apply [website defaults](references/website.md)
without asking the user to enumerate OTP, media, Admin or SEO. Defaults are
acceptance requirements, not evidence that a missing renderer is implemented.
Do not report a complete website with blocked required checks.

Run the [local HTTP acceptance](references/local-testing.md) for handlers and selected interfaces; compilation does not execute their behavior. Account for every declared interface as verified, intentionally not exposed, or deferred/unverified with a reason in the existing application handoff. An early preview may defer remote MCP; preserve that pending work. WebMCP, cookie-session discovery and OAuth Bearer/client integration are separate checks.

## Self-hosted deployment

Deploy only when the user requests it. Follow the application's selected host
and the installed `docs/skills/provision/SKILL.md`; use the platform's native
workflow. Local project creation alone is not deployment authorization.

## Existing project and handoff

Preserve the user's manifests, `src/` files, identity, package versions and
provider resources. The app writes its entry (`src/worker.ts` by default;
`--entry` selects another). Workers generation creates or updates Wrangler's
split-build settings and public-fetch compatibility flags. Run the same generation command (target, output directory,
manifests and options) with `--check`, and the project's own tests,
before and after a change.

To add Mantle to an application that has its own code, users and data, read
`node_modules/@aotter/mantle/docs/skills/integrate/SKILL.md` first.

Report the project path, the exact Mantle version, what you changed, the checks
you ran with their results, the independent acceptance verdict (CONVERGED / NOT
CONVERGED / BLOCKED / UNVERIFIED), and anything left for the user.

## Data paths

Follow the installed `docs/handbook/guides/typed-queries.md` for Store,
Procedure and View data paths; the service composition guide owns request-local
Caller binding.
