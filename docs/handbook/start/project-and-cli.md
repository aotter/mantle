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
| `dist/` | Disposable bundle output; do not commit |

## Commands

```sh
mantle generate <target> <output-directory> <manifest>... [options]
mantle bundle <entry> <outdir>
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
| `--admin-extensions <module>` | Read the named/default `adminExtensions` array and the optional `navGroups` (sidebar groups; see native-admin.md "Sidebar"). The app shell passes `src/admin.ts`. |
| `--wrangler <path>` | Existing JSONC/JSON/TOML config; default finds one or creates `wrangler.jsonc`. TOML receives manual-edit instructions. |
| `--entry <path>` | Worker source entry; default `src/worker.ts`. |
| `--outdir <path>` | Split bundle output; default `dist`. Keep separate from source/generated files. |

## Outputs

`generated/.mantle-inputs.json` records the Mantle version and a hash of every input the run read (manifests and the
`--auth`, `--site`, `--admin-extensions` modules). `mantle bundle`, which Wrangler runs for `wrangler dev` and every
deploy, refuses to build when an input changed since, so stale generated code cannot run; regenerate and rebuild.
Commit it with the other generated files.
The bundle also prints notes, never errors, for SQL in the app's own code against Better Auth's tables (read users
through `userOf(caller)` or `readIdentity(auth)` instead) and for Better Auth roles beyond `admin` and `user`.

`generated.ts` exports typed queries and Store. Direct `views/<encoded-name>.ts` and `procedures/<encoded-name>.ts` entries export an operation and its types. Proved pageable Views also have `paged/views/*`; boundary checks live in `validation/*`. `admin-descriptors.ts`, `rest.ts` and `web.ts` are always emitted. Manifest exposure selects `mcp.ts`; `admin-bindings.ts` and `admin/*` require `--admin`. Auth and site are explicit options.

Apply `schema.sql` only to an empty database. Later changes require [explicit migrations](../concepts/runtime-and-adapters.md#schema-installation-and-migrations); generation and runtime do not inspect the database. Ref declarations print the `Handlers` keys to implement.

Never edit generated output by hand. Merge manifests/options, regenerate with the same command, then review TypeScript and SQL diffs. Use that exact command with `--check` in CI. Unmarked app files are preserved. Imported option modules must be pure; generation does not make their side effects safe.

On Workers, generation configures `mantle bundle` as Wrangler's build command. It emits minified split ESM with a startup guard for eager Better Auth imports. On Bun, the app owns `Bun.serve`, its Database/SQL pool and scheduler. See [service composition](../cloudflare/service-entry.md).
