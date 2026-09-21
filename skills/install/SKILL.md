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
   and pnpm 9+ for these SDK examples. A ChatGPT Site is not a conventional
   Cloudflare Worker deployment; use the installed
   `docs/handbook/sites/index.md` integration guide and
   `docs/examples/host-chatgpt-sites/` runnable reference when selected.
2. Choose the requested exact SDK version, or resolve the intended release
   channel once. Pin all selected `@aotter/mantle*` dependencies to that same
   version. Install only the adapter/optional packages the application needs.
   If a global scope registry overrides public npmjs, use a project-owned
   `.npmrc` with `@aotter:registry=https://registry.npmjs.org/`.
3. Interview the human for host and required surfaces. Do not assume Admin,
   public HTML or Cloudflare. Scale:
   - Spec + generate / embed Runtime — `docs/handbook/start/project-and-cli.md`.
   - Adapter without Admin — `docs/examples/host-minimal-worker/`.
   - Opt-in Admin / Dev UI — only when a human needs a console: interview
     the bootstrap owner email, then `docs/examples/host-local-admin-otp/`
     (`pnpm install && pnpm generate && pnpm dev`, `/admin/sign-in`, OTP
     in wrangler logs). Admin needs `@aotter/mantle-admin`,
     `@aotter/mantle-admin-ui`, wrangler `ASSETS` on `./public`, and
     `createAuth` email-otp + `ConsoleEmailSender`. Do not Vite-build Admin.
   - ChatGPT Sites with Admin/D1/R2 — follow
     `docs/examples/host-chatgpt-sites/`, not the email-OTP Worker example.
     Copy it outside the SDK checkout, then `npm ci`,
     `npx mantle validate --phase deploy`, `npm run generate`, `npm run check`,
     `npx wrangler d1 migrations apply DB --local`,
     `npm run dev -- --port 4174`, and `npm test` in a second terminal.
     Preserve its Sites-owned identity ingress and hosting manifest; author the
     user's Schema/View/Procedure/Trigger, then review migrations, media policy
     and the local/production smoke gates. Sites provisions and deploys; never
     `wrangler deploy` a Site. Request both D1 and R2 when uploads are in scope.
     Browser Admin WebMCP and Sites-session `/api/mcp/staff` do not enable remote staff OAuth MCP.
   - ChatGPT Sites with custom business rules or an external callback — the
     runnable reference covers builtin content only. For application-owned
     operational state, `handler: { kind: ref }` Procedures, staff-only SQL
     Views, staff MCP Triggers with `requires.auth`, and outbound webhooks
     called from handler code, follow
     `docs/handbook/sites/equipment-checkout.md`. It is an implementation
     guide, not a shipped app: keep Mantle-owned Schema tables and
     application-owned tables separate, and give every application table a
     reviewed migration.
   - Grammar — `docs/examples/README.md`. Copy `builtin-*` Manifests directly.
     Read `cf-primitives-*` when the request needs Durable Objects, Queues,
     cron, payment-provider callbacks, or API-key and entitlement guards;
     those carry `ref` handlers and are not Builder-ingestible.
   None of these is a template to install wholesale. Other hosts use the
   embedded adapter guides. Author package scripts, manifests, entry and
   configuration for the user's requirements. No default notes model, home
   page, icon, launch metadata or visitor frontend is required.
4. Compile and verify using the application's commands. The fundamental CLI
   sequence is:

```sh
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec mantle validate
pnpm exec mantle skills
pnpm exec mantle skills --check
```

Run the project's TypeScript check and start its actual local server. Probe
a route the application declares. An API-only or adapter-only project may
correctly return 404 at `/` and have no Admin. When Admin was requested,
probe `/admin/sign-in` and a `/_mantle/admin/assets/*` URL — both must be
200. A white screen is an assets 404, not a missing frontend build.
Conventional Auth routes may return `503 setup_incomplete` until that mode
is configured; the local OTP path replaces construction instead. Do not
introduce an auth bypass to make smoke pass.

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

For a legacy pre-stable project, retain its pinned behavior until an explicit
upgrade is requested. Do not rewrite provider identities, delete metadata or
fetch a nonexistent new Starter tag. SDK upgrades follow the update skill, not
a bundle comparison command.

## Ship and report

When deployment is requested, follow the installed provision skill and the
observed host configuration. Legacy Landing remains a pre-stable product; it
is not a launch dependency for new Core projects.

Report the project path, exact SDK version, local URL/HTTP result and checks,
plus any genuinely missing auth/provider setup. Do not claim a working homepage
or authenticated MCP based only on successful generation.
