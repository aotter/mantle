---
name: mantle
description: Set up a new Mantle application or continue an existing one using the installed SDK's matching instructions.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/install/SKILL.md
  applies_to: mantle grammar v0.1
  projection: plugin
  projectionReason: Creates a new project; nothing to project into an existing one.
---

# Mantle

`npx skills add aotter/mantle` installs this small bootstrap skill. It does not
install the SDK or create a project. The skill name is `mantle`; the source
folder remains `skills/install/` so installation does not copy the repository.

## Find the application and its version

First locate the user's target project. If it already has `@aotter/mantle`,
read that project's `package.json`, lockfile, and
`node_modules/@aotter/mantle/package.json`. Follow the CLI and docs shipped in
that exact installed package. Never use another project's dependencies, the
SDK checkout, a floating GitHub handbook, or an old alpha/Starter fallback.
An older installed SDK may only support direct authoring; its own
`mantle generate --help` decides which flags exist. Upgrade only when requested.

For a new project, choose `cf` or `chatgpt-sites` from the request; ask only if
it remains ambiguous. A host-free Spec-only project needs no host. Resolve the
latest **published stable** `@aotter/mantle` version from npm once, confirm it
is not a prerelease, and install it with an exact version in the new project.
For example, run `npm view @aotter/mantle@latest version`, inspect the returned
plain `X.Y.Z`, then `npm install --save-exact @aotter/mantle@X.Y.Z` with that
actual version substituted. Set `type=module` in `package.json` first; npm's
default project type may be CommonJS.
When testing a release candidate, use the explicitly supplied exact version
or local tarball instead of npm latest. Pin every selected `@aotter/mantle*`
package to the running CLI's exact version; `generate` writes the required
package declarations. Do not let npm's default `^` range remain. If the
project registry overrides public npmjs, set `@aotter:registry=https://registry.npmjs.org/`
in a project-owned `.npmrc`.

## New project sequence

1. Create a separate application directory with Node 22+ and a project
   `package.json` containing `"type":"module"`. Install the exact chosen
   `@aotter/mantle` version locally. Read its
   `node_modules/@aotter/mantle/skills/install/SKILL.md` and version-matched
   `docs/handbook/start/overview.md` before continuing. These installed
   instructions take precedence over this GitHub bootstrap copy. Check
   `npx mantle generate --help`: if it does not list `--host`, follow the
   installed version's direct-authoring path instead of the steps below.
2. On a CLI that supports it, run with an explicit host, for example
   `npx mantle generate --host cf` or `npx mantle generate --host chatgpt-sites`.
   No `--features` means Spec, Runtime, API, MCP, Admin and a blank editable
   home. For a smaller app, positively list the modules with `--features`
   (for example `spec,api`); use `--features spec` for a host-free compiler.
   Do not remove Admin merely because its package is not installed yet.
3. The first run may declare selected dependencies and exit asking for an
   install. Install them using the project's package manager, then rerun
   `mantle generate` to finish. Read `docs/handbook/start/project-and-cli.md`
   from the same installed package for saved selections, owned files,
   `--check`, and `--adopt`.
4. Before adding a Schema on ChatGPT Sites, review and apply its initial local
   D1 migration as the installed Sites guide says. Then add only the user's
   Schema, View, Procedure and Trigger manifests. Keep the blank home editable;
   do not invent business data or media bindings. Run `mantle generate` to
   append any new migration, review and apply it, then run `generate --check`,
   `validate`, `skills`, build/typecheck and local smoke.
5. For Cloudflare, follow installed `docs/handbook/start/project-and-cli.md`
   and `docs/handbook/cloudflare/authentication.md`. Copy `.dev.vars.example`
   to `.dev.vars`, set `ADMIN_EMAIL` and `BETTER_AUTH_SECRET`, and match
   `PUBLIC_ORIGIN` to the loopback URL printed by `wrangler dev`. Open
   `/admin/sign-in` with that email; read the OTP from wrangler logs. Check
   Admin assets and an owner-only Admin API before claiming Admin works. For
   ChatGPT Sites, follow installed
   `docs/handbook/chatgpt-sites/generated-app.md`: review and apply local D1
   migrations, set `OWNER_EMAIL` and `PUBLIC_ORIGIN`, then test the blank home,
   unauthorized Admin, owner Admin, public MCP and staff MCP. Local owner
   identity is simulated by the loopback-only smoke; it does not create a
   browser ChatGPT session. Sites owns
   production identity and deployment; do not deploy its Worker directly.
   Browser Admin WebMCP and Sites-session `/api/mcp/staff` do not provide
   remote staff OAuth MCP. The owner can maintain content through Admin and
   the applicable authenticated MCP surface.

Use installed `docs/handbook/reference/features.md` for Manifest choices and
`docs/examples/` for optional examples. The generated project is the starting
point; a domain example is not a template to copy wholesale. Do not use a
`mantle-starters` tag or `mantle create`.

## Existing project and handoff

Preserve selected features, user-authored files, migrations, package versions,
identity settings and provider resources. Use the installed CLI's `--help` and
package-local docs. Run `generate --check` without writing, then the project's
normal tests. For a legacy project, keep its established direct-authoring
flow until an upgrade is requested; the new bootstrap skill does not make an
old SDK understand new flags.

When deployment is requested, read the installed version's
`skills/provision/SKILL.md`. Report the target path, exact SDK version, local
HTTP results, Admin/MCP identity evidence, and any missing provider setup.
Local simulated Sites headers do not prove deployed ChatGPT sign-in.
