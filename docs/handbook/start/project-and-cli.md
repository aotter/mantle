---
description: The files of a Mantle 0.2.0 project, who owns each, mantle.config.json, and every option of mantle generate.
---
# Project layout and CLI

## Files

| Path | Written by | Owner |
|---|---|---|
| `manifests/*.yaml` | you | you |
| `mantle.config.json` | `mantle generate`, when the selection changes | you may edit it; generate keeps keys it does not know |
| `.mantle/generated/plan.json` | every `mantle generate` | generated: never edit, commit it |
| `.mantle/generated/mantle.ts` | every `mantle generate` | generated: never edit, commit it |
| `src/service.ts`, `src/index.ts`, `src/handlers.ts`, `src/identity.ts` (identity `custom`) | the first `mantle generate` | yours from then on |
| `wrangler.jsonc`, `tsconfig.json`, `.dev.vars.example`, `.gitignore` | the first `mantle generate`, each only if missing | yours |

`mantle generate` writes each preset file only when it does not exist, and
writes none once `src/service.ts` exists: from then on the application owns
its composition. To get a fresh preset, move the old file aside and rerun.

- `plan.json` is `{ "sourceHash": …, "plan": … }`: the sealed `RuntimePlan`
  and the SHA-256 of the manifest sources. The plan's `fingerprint` is what
  boot checks; reformatting a manifest changes `sourceHash` but not the
  fingerprint.
- `mantle.ts` exports `plan`, `sourceHash`, the `Mantle` namespace of row, input and output
  types, `Store` and `CallerStore` typed over your Schemas and
  Views, and `MantleHandlers`, which lists exactly the plan's `ref` handlers. A
  missing or extra handler is a type error. See
  [Query from TypeScript](../guides/typed-queries.md).

## `mantle.config.json`

```json
{ "version": 2, "identity": "mantle", "features": ["mcp", "admin", "web"] }
```

| Key | Values | Meaning |
|---|---|---|
| `version` | `2` | `1`, or any `host` key, is a 0.1.x config and fails with exit 2 |
| `identity` | `mantle`, `custom`, `none` | who the callers are. `mantle`: `@aotter/mantle/auth` (Better Auth sign-in, staff roles, OAuth for MCP). `custom`: your `src/identity.ts` maps your own sessions to callers. `none`: every caller is anonymous |
| `features` | a subset of `mcp`, `admin`, `web`, in that order | `mcp`: the public MCP surface at `/mcp` (and staff MCP inside Admin). `admin`: the Admin console and its API at `/admin`, which needs an identity. `web`: reserved for public pages; REST at `/api` is always mounted |
| `dialect` | an npm package name, optional | the SQL dialect; absent is the built-in D1 dialect (`@aotter/mantle/d1`) |

Without a config or flags, the selection is identity `mantle` and every
feature. An explicit `--features` without `--identity` means identity `none`.
A rerun keeps the saved identity; asking for another one is refused (exit 2),
so switching never drops tables.

Each selection needs packages in the project. `mantle generate` checks them
and stops before writing anything, naming the install command for your
package manager. It never installs anything.

| Selection | Packages |
|---|---|
| always | `@aotter/mantle` |
| identity `mantle` | `better-auth`, `@better-auth/oauth-provider`, `@better-auth/mcp`, `@better-auth/cimd` |
| feature `mcp` | `@modelcontextprotocol/server`, `@modelcontextprotocol/ext-apps` |
| feature `admin` | `@aotter/mantle-ui` (its `dist/admin` is the console, bound as `ASSETS` in `wrangler.jsonc`) |

The project also installs `wrangler`, `@cloudflare/workers-types` and
`@types/node` itself.

## `mantle generate`

```sh
mantle generate [--manifests <dir>] [--features <list>] [--identity <kind>]
mantle generate --check [--database <file>]
```

| Option | Meaning |
|---|---|
| `--manifests <dir>` | the manifest directory, default `./manifests`. Every `.yaml` and `.yml` file directly in it is read |
| `--features <list>` | comma-separated, a positive list. A missing dependency fails with `GENERATE_FEATURE_DEPENDENCY_MISSING`; an omitted feature is never added back |
| `--identity <kind>` | `mantle`, `custom` or `none` |
| `--check` | writes nothing. Exits 1 when `plan.json`, `mantle.ts` or `mantle.config.json` differs from what generate would write, or a package is missing |
| `--database <file>` | with `--check`: also read a local SQLite file (Wrangler's local D1 is under `.wrangler/state/v3/d1/`) read-only, and print the SQL storage convergence would run |

Exit codes: 0 success, 1 a diagnostic or a stale file, 2 a usage or file
error. Diagnostics name the manifest file, the path in it and, for SQL, the
position in the statement.

`--check` is the gate for CI and for agents: run `mantle generate`, then
`mantle generate --check`, then your typecheck.

### Schedules and Cloudflare crons

Schedule Triggers use POSIX cron. `mantle generate` translates each enabled
one with `toCloudflareCron` and refuses (exit 1, before writing) one that
Cloudflare cannot run the same way. It writes `triggers.crons` into a new
`wrangler.jsonc`; once the file is yours it only warns when the crons differ
from the plan, and you update them.

### Storage SQL

Boot creates what the plan adds (tables, columns, indexes, check triggers) and
refuses what it cannot change safely. `--check --database` prints the same
diff without applying it; see [Deploy and operate](../cloudflare/deploy-and-operate.md).

## 0.1.x projects

`apiVersion: cms.mantle.aotter.net/v1` manifests, `--host`, `mantle validate`,
`mantle emit-openapi`, `mantle skills` and the `mantle-harness` bin are gone.
`docs/upgrade-0.1-to-0.2.md` in the installed package is the guide.
