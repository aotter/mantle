---
name: install
description: Interview a human, author a local Mantle Worker from version-matched SDK docs, walk them into Admin with email OTP, or continue an existing project. Use when asked to install Mantle, build a Mantle service, or open a Mantle repository.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/install/SKILL.md
  applies_to: mantle grammar v0.1
  projection: plugin
  projectionReason: Creates a new project; nothing to project into an existing one.
---

# Mantle Install

Mantle is an embeddable manifest engine. The application owns its source and
provider configuration. There is no `mantle create`. Do not use the SDK
checkout as the application or turn `generate` into implicit scaffolding.

A human does not learn Mantle by reading a README and generating files alone.
Interview them, get a Worker running on local D1, then walk them into Admin
with email OTP.

## New application

1. Interview the human: what service, who uses it, which records, what they
   can read or write, which email becomes the first Admin owner. Determine
   the host and required surfaces from those answers. Do not assume
   Cloudflare, public HTML or Admin is required — but the usual first human
   milestone on Cloudflare is local Admin OTP. Check Node 22+ and pnpm 9+
   for these SDK examples. Work in the application's own directory.
2. Choose the requested exact SDK version, or resolve the intended release
   channel once. Pin all selected `@aotter/mantle*` dependencies to that same
   version. Install only the adapter/optional packages the application needs.
   For the local Admin milestone, install `@aotter/mantle-cloudflare` and
   `@aotter/mantle-admin-ui`. If a global scope registry overrides public
   npmjs, use a project-owned `.npmrc` with
   `@aotter:registry=https://registry.npmjs.org/`.
3. Read the installed
   `node_modules/@aotter/mantle/docs/handbook/start/quickstart-worker.md`
   and `project-and-cli.md`. Handbook examples under
   `docs/handbook/examples/` are full grammar inspiration. The
   `docs/examples/minimal-worker/` reference is a runnable API-only
   Cloudflare shape, not a template to install wholesale and not a visitor
   homepage. Author package scripts, manifests, entry and configuration
   for the interview. No default notes model, home page, icon or frontend
   is required. `GET /` may correctly be 404.
4. For local Admin OTP, wire `createAuth` with `{ kind: "email-otp" }` and
   `ConsoleEmailSender`, set `bootstrapOwner` to the interviewed email, put
   `BETTER_AUTH_SECRET` in `.dev.vars`, and bind `ASSETS` to `./public`.
   Do not rebuild Admin. Do not use incomplete `MANTLE_AUTH_MODE=self-managed`
   as a login path.
5. Compile and verify using the application's commands. The fundamental CLI
   sequence is:

```sh
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec mantle validate
pnpm exec mantle skills
pnpm exec mantle skills --check
```

Run the project's TypeScript check and start `wrangler dev --local` (or the
project's `dev` script). Probe a route the application declares. Walk the
human to `/admin/sign-in`; they read the OTP from the Wrangler log and open
`/admin/dev`. Do not introduce an auth bypass to make smoke pass.

Commit the resolved lockfile in the application's normal workflow; subsequent
installs use `pnpm install --frozen-lockfile`. Do not initialize/push a remote,
provision resources, deploy or commit secrets as part of local verification.

## Existing application

Read package.json, lockfile, actual entry, manifest files, provider config and
project instructions. Leftover `.mantle` metadata is optional context, never
a prerequisite. Preserve user code. Install the frozen dependency graph,
project installed Core skills, then read those skills and embedded docs.
Never apply develop-branch docs to an older package. Use the installed
`mantle --help` and the project's scripts as authority. The shipping commands
are `generate`, `validate`, `skills` and `emit-openapi`.

## Ship and report

When deployment is requested, follow the installed provision skill and the
observed host configuration. Local first path stays local.

Report the project path, exact SDK version, local URL/HTTP result, whether
Admin OTP sign-in worked, and any genuinely missing auth/provider setup. Do
not claim a working homepage or authenticated MCP based only on successful
generation.
