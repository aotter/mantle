---
description: Generation targets, CLI options and ownership of native application files.
---
# Project layout and CLI

| File | Owner |
| --- | --- |
| `manifests/*.yaml` | App: closed v2 declarations and SQL |
| `src/worker.ts`, auth, handlers, frontend | App: routing, Caller verification and side effects |
| `generated/` | Generator: TypeScript, native SQL and selected bindings |
| `migrations/` | App's agent and native migration tool |
| `wrangler.jsonc` | App configuration; generator maintains selected split-build keys |
| `dist/` | Disposable bundle output (`dist/worker`, `dist/client`); do not commit |

## Commands

```sh
mantle generate <target> <output-directory> <manifest>... [options]
mantle bundle <entry> <outdir> [--assets <dir>]
```

| Target | Dialect | Handle |
| --- | --- | --- |
| `bun-sqlite` | sqlite | bun:sqlite Database |
| `bun-postgres` | postgres | Bun.SQL |
| `cloudflare-d1` | sqlite | D1 binding/session |
| `cloudflare-postgres` | postgres | postgres.js, usually with Hyperdrive |

Other handles may adapt to the same [structural driver contracts](../guides/adapter-guide.md). Dialects are exactly postgres and sqlite in 0.2.0.

| Option | Meaning |
| --- | --- |
| `--check` | Compare generated owned files and Wrangler build keys without writing; stale output exits nonzero. No database or credentials are needed. |
| `--admin` | Emit native Admin bindings and `admin/*` modules; install the separate Admin package. |
| `--auth <module>` | Read plain `authOptions(env)` (or an exported auth instance's options) and append selected Better Auth DDL. Repeat it once per Better Auth instance. Prefer plain options without initialization side effects. |
| `--site <module>` | Read `siteDefaults`; emit site/media bindings and deployment SQL. |
| `--admin-extensions <module>` | Read the named/default `adminExtensions` array and the optional `navGroups` (legacy sidebar groups; `defineAdmin` `nav.groups` declares them now, see native-admin.md "Sidebar"). The app shell passes `src/admin.ts`. |
| `--wrangler <path>` | Existing JSONC/JSON/TOML config; default finds one or creates `wrangler.jsonc`. TOML receives manual-edit instructions. |
| `--entry <path>` | Worker source entry; default `src/worker.ts`. |
| `--outdir <path>` | Bundle output; default `dist`. The Worker goes to `<outdir>/worker`. Keep separate from source/generated files. |
| `--assets <path>` | With `--admin`: the static assets directory `mantle bundle` builds Admin into (`<assets>/admin`); default `<outdir>/client`. Written to Wrangler's `assets.directory`, and to the build command when not the default. |

## Outputs

`generated/.mantle-inputs.json` records the Mantle version, the target, and a hash of every input the run read (manifests and the
`--auth`, `--site`, `--admin-extensions` modules). `mantle bundle`, which Wrangler runs for `wrangler dev` and every
deploy, refuses to build when an input changed since, so stale generated code cannot run; regenerate and rebuild.
Commit it with the other generated files.
The bundle also prints notes, never errors, for SQL in the app's own code against Better Auth's tables (read users
through `userOf(caller)` or `readIdentity(auth)` instead) and for Better Auth roles beyond `admin` and `user`.

`generated.ts` exports typed queries and Store. Direct `views/<encoded-name>.ts` and `procedures/<encoded-name>.ts` entries export an operation and its types. Proved pageable Views also have `paged/views/*`; boundary checks live in `validation/*`. `admin-descriptors.ts`, `rest.ts` and `web.ts` are always emitted. Manifest exposure selects `mcp.ts`; `admin-bindings.ts`, `admin-client.ts` (browser-side types and hooks for `admin.tsx`) and `admin/*` require `--admin`. Auth and site are explicit options.

Apply `schema.sql` only to an empty database. Later changes require [explicit migrations](../concepts/runtime-and-adapters.md#schema-installation-and-migrations); generation and runtime do not inspect the database. Ref declarations print the `Handlers` keys to implement.

Never edit generated output by hand. Merge manifests/options, regenerate with the same command, then review TypeScript and SQL diffs. Use that exact command with `--check` in CI. Unmarked app files are preserved. Imported option modules must be pure; generation does not make their side effects safe.

On Workers, generation configures `mantle bundle` as Wrangler's build command. It emits minified split ESM into `<outdir>/worker` with a startup guard for eager Better Auth imports and for Admin's browser code (`@aotter/mantle-admin/app` and `/hooks`, which `generated/admin-client.ts` imports; they belong to `admin.tsx`). When the Worker imports `@aotter/mantle-admin/server`, it also builds Admin with Vite into `<assets>/admin` (`--assets`, default `<outdir>/client`), from `admin.tsx` beside the Worker entry or Admin's built-in entry; `src/admin.ts` is not an entry. The assets directory must not overlap the Worker directory, and neither the outdir nor the assets directory may be the working directory or contain the Worker entry. The built-in entry is not rebuilt while the installed `@aotter/mantle-admin` keeps its path and version and its direct dependencies keep theirs; an `admin.tsx` entry builds every time. The build needs no install scripts (`npm ci --ignore-scripts` works). A `package-lock.json` made on one OS can lack the native build binaries (rolldown, `@tailwindcss/oxide`, lightningcss) that npm installs per platform from `optionalDependencies`, so a lockfile made on macOS can fail the build on a Linux host; create the lockfile on the build platform or use pnpm. Nothing at runtime reads `node_modules`. On Bun, the app owns `Bun.serve`, its Database/SQL pool and scheduler; Bun runs the server as TypeScript, so for a `bun-*` target recorded in `.mantle-inputs.json`, `mantle bundle src/server.ts dist` skips the Worker bundle and builds only Admin, into `dist/client/admin` (read with `bunAdminAssets("dist/client/admin")`, adapted for `adminShell` as in service composition). See [service composition](../cloudflare/service-entry.md).
