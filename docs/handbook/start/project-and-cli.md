---
description: Generate a full Mantle app or select smaller modules, then safely rerun the CLI as your manifests evolve.
---
# Project layout and CLI

`mantle generate` can assemble a new application or compile manifests in an
existing one. A new hosted app defaults to Spec, Runtime, API, MCP, Admin and
an editable blank home. You can select a smaller set explicitly. It never
invents a business Schema or publishes a deployment.

## Start a new app

Choose a host before running the command. The integrated hosts are `cf` and
`chatgpt-sites`; `--features spec` works without a host. Install one exact
published SDK version, then let the CLI declare its matching optional packages:

```sh
mkdir my-app && cd my-app
npm init -y
npm pkg set type=module
MANTLE_VERSION=$(npm view @aotter/mantle@latest version)
npm install --save-exact "@aotter/mantle@$MANTLE_VERSION"
npx mantle generate --host cf
npm install
npx mantle generate
npm run build
```

Confirm `MANTLE_VERSION` is a stable release, without a prerelease suffix.
Use `--host chatgpt-sites` for a Site; [its guide](../chatgpt-sites/generated-app.md)
continues with D1 migration, owner identity and local smoke. If you already
use pnpm, keep that one package manager and run `pnpm install` /
`pnpm exec mantle`. The first `generate` may exit asking you to install newly
declared packages; the second completes generation. A README or lockfile from
bootstrapping still counts as a new app. Once choices are saved, omit flags on
rerun.

For a smaller composition, list wanted modules positively:

```sh
npx mantle generate --host cf --features spec,api
npx mantle generate --features spec
```

Dependencies are expanded in the saved selection: `api` includes Runtime and
Spec; `admin` includes Runtime, API and MCP. Supported features are `spec`,
`runtime`, `api`, `mcp`, `admin`, `web`. No host is needed for Spec-only. Use an
explicit host in automation so a terminal prompt cannot stall. The selection
lives in `mantle.config.json`; changing it later requires a deliberate migration,
not an accidental CLI flag.

## Files and ownership

| File | Owner | What happens on rerun |
|---|---|---|
| `manifests/*.yaml`, `src/handlers.ts`, `src/home.ts` | You | Preserved. Add domain behavior and edit the blank home here. |
| `package.json`, `mantle.config.json`, `wrangler.jsonc` | Shared | Required versions and scripts are added; existing user values are preserved or conflicts reported. |
| `.mantle/generated/*`, `src/storage-fingerprint.json` | CLI | Rebuilt from the saved selection and manifests. |
| `drizzle/*.sql` on Sites | Review and apply | New migrations append; applied migrations are never rewritten. |
| `public/_mantle/admin/*` | CLI | Prebuilt Admin assets copied from the selected exact package. |
| `.openai/hosting.json` on Sites | Sites | Binding metadata is created locally; existing project metadata is preserved. |

A generated Worker imports the sealed `plan`, your handler map and the selected
modules. Generated files carry a marker so the CLI can distinguish them from
user-owned code. A rerun refuses to replace an unmarked file. `--adopt` opts an
existing authored application into project mode only after the existing entry
and host config deliberately connect the generated output. Legacy applications
without a saved selection keep their prior compile behavior.

`generate` accepts `--manifests <dir>` (default `./manifests`), `--output <dir>`
(default `.mantle/generated`), `--namespace <name>`, `--host cf|chatgpt-sites`,
`--features <comma-list>`, `--adopt`, and `--check`. Check mode exits nonzero
on drift and does not write. `mantle validate` checks grammar and linked
capabilities; `--phase deploy` adds deployment checks. `mantle skills` projects
the installed SDK's project skills into `.agents/skills/` and `.claude/skills/`;
`mantle skills --check` detects drift. `mantle emit-openapi` describes HTTP
Triggers and View REST routes; `mantle-harness indexes` and `http` inspect
queries and running routes. [Command reference](../reference/surface.md).

## Verify the assembled app

```sh
npx mantle generate --check
npx mantle validate
npx mantle skills
npx mantle skills --check
npm run typecheck
npm run build
npm run dev
```

Run scripts that exist in the selected project; Spec-only has no server to
start. A full Cloudflare app should serve the blank home and Admin assets.
For local CF Admin, copy `.dev.vars.example` to `.dev.vars`, replace
`ADMIN_EMAIL` with the intended owner's address and `BETTER_AUTH_SECRET` with
a random 32-byte secret, and keep `PUBLIC_ORIGIN` equal to the loopback URL
wrangler prints. The OTP appears in wrangler logs. Verify that anonymous staff access fails before
claiming Admin or staff MCP is working. A full Site must also apply its reviewed
D1 migration before the Worker boots. The public MCP endpoint is discoverable
without a staff session; the staff endpoint requires the host's verified
identity and a Mantle role. See [MCP and agents](../concepts/mcp-and-agents.md).

For an already installed app, confirm `node_modules/@aotter/mantle/package.json`
and the lockfile agree. Use that package's CLI and `docs/` tree; the latest
GitHub handbook may describe a newer release. Keep all selected
`@aotter/mantle*` packages on one exact version. The prior direct-authoring
contract remains valid for older installed SDKs; upgrade deliberately using
[release notes](../releases/index.md).

## Source

- [Generate CLI](../../../packages/mantle/src/cli/generate.ts)
- [Project selection and package pins](../../../packages/mantle/src/cli/generate-project.ts)
- [Cloudflare assembly](../../../packages/mantle/src/cli/generate-cloudflare.ts)
- [ChatGPT Sites assembly](../../../packages/mantle/src/cli/generate-sites.ts)
