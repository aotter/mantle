---
description: The files you own in a Mantle project, every mantle and mantle-harness command with its flags, the generated module, the daily check loop, and version pins.
---
# Project layout and the CLI loop

This page describes a directly authored Mantle project: which files are yours, what the installed CLI does to them, and the loop you run before every commit. Surfaces are optional — take only what you need. [The minimal Worker](./quickstart-worker.md) is Spec + adapter without Admin. [Local Admin](./quickstart-admin.md) is the opt-in Dev UI path when humans need a console.

## You own the project

Core is a manifest compiler and a runtime, not a project generator. You write `package.json`, the manifests, the Worker entry, handlers, TypeScript and provider configuration. `mantle generate` compiles what exists; it never initializes a missing project or invents a default Schema, frontend or home route.

```txt
my-service/
├── package.json              exact-pinned @aotter/mantle* + peers, scripts
├── tsconfig.json             includes src/ and .mantle/generated/
├── wrangler.jsonc            Worker name, flags, vars, bindings
├── .dev.vars                 local secrets for wrangler dev; never committed
├── manifests/
│   └── site.yaml             immediate .yaml/.yml files; multi-document with ---
├── src/
│   ├── index.ts              createMantleWorker({ plan, extend })
│   └── mantle/handlers/      handler refs (a convention; any path under src/)
├── public/                   required ASSETS root when Admin is installed; generate writes public/_mantle/admin/
├── .mantle/generated/
│   └── mantle.ts             written by mantle generate
├── .agents/skills/mantle-*/  written by mantle skills
└── .claude/skills/mantle-*/  same bytes, for Claude compatibility
```

The minimal Worker reference keeps `.mantle/`, `.agents/`, `.claude/`, `.wrangler/`, `.dev.vars*` and `.env*` out of git and regenerates the first three in its `check` script. Committing the generated files is also workable, because `generate --check` and `skills --check` detect drift either way. Commit the lockfile in a real application and install with `--frozen-lockfile` afterwards.

`mantle validate` greps `./src` for the names of `handler.kind: ref` Procedures; a handler that is not found anywhere under `src/` produces a `HANDLER_NOT_REGISTERED` warning, so keep handlers under that root or pass `--source`.

## The CLI

The umbrella package installs two binaries, `mantle` and `mantle-harness`. Run them through the package manager, for example `pnpm exec mantle generate`. Defaults shown are the pinned ones. Bare `mantle` / `mantle --help` prints a layered overview of optional surfaces (Minimal Spec + generate, Runtime / adapter, opt-in Admin). `generate --help` and `validate --help` stay on the compile path. After a successful `generate`, the CLI says Admin is opt-in: next steps when `@aotter/mantle-admin-ui` is installed, otherwise an API-only tip.

| Command | Flags | Does |
|---|---|---|
| `mantle generate` | `--manifests <dir>` (default `./manifests`), `-o, --output <dir>` (default `.mantle/generated`), `--namespace <name>` (default `Mantle`), `--check` | Validate, link and compile manifests; write `mantle.ts`; sync Admin assets when installed. `--check` exits 1 without writing when output is stale. |
| `mantle validate` | `--manifests <dir>`, `--source <dir>` (default `./src`), `--no-source`, `--phase preview\|deploy` (default `preview`), `--format json\|text`, `--json` | Static manifest and handler-source validation. Exit 0 with warnings allowed, 1 on any error, 2 on a CLI invocation problem. |
| `mantle skills` | `--check` | Copy every skill marked `projection: project` into `.agents/skills/mantle-<name>/` and `.claude/skills/mantle-<name>/`. `--check` exits 1 when a projection is stale. |
| `mantle emit-openapi` | `--manifests <dir>`, `--title <str>` (default `mantle`), `--version <str>` (default `0.1.0`), `--session-cookie-name <str>`, `-o, --output <file>` | Emit OpenAPI 3.1 for HTTP Triggers and `GET /api/views/<name>` routes to stdout or a file. MCP is out of scope. |
| `mantle-harness indexes` | `--manifests <dir>`, `--rows <n>` (default 2000), `--require <view>` (repeatable), `--require-public`, `--format text\|json` | Execute compiled Views in crowded SQLite and inspect query plans; exit 1 when a required View lacks its access path. |
| `mantle-harness http` | `--base-url <url>`, `--route <name=path-or-url>` (repeatable, required), `--rounds <n>` (default 20), `--warmup <n>` (default 2), `--format text\|json` | Sample a running Worker and report p50/p95 timings plus query-count and `rows_read` metric headers. |

Advanced manifest primitives live in the `@aotter/mantle-spec` package's own `mantle-spec` binary: `mantle-spec introspect [--manifests <dir>]` dumps the parsed manifest tree as JSON, and `mantle-spec emit-types [--manifests <dir>] [--namespace <name>] [-o <file>]` emits standalone `.d.ts` declarations. Add `@aotter/mantle-spec` as a direct dependency to run them. The full flag reference is in [HTTP, MCP, CLI and packages](../reference/surface.md).

### What `generate` does and does not do

`generate` reads the manifest directory, runs the same validation as `validate` (without the handler-source grep), links the set, and emits one `.mantle/generated/mantle.ts`. When `@aotter/mantle-admin-ui` is installed it also syncs the **prebuilt** Admin SPA into `public/_mantle/admin/`, excluding the package's `server.*` exports; Core-only installs skip that copy. Any error diagnostic stops the run with exit 1.

Do not Vite-build Admin unless you are developing `@aotter/mantle-admin-ui` itself. A Cloudflare project that serves Admin must declare Static Assets:

```jsonc
"assets": { "directory": "./public", "binding": "ASSETS" }
```

That binding is a hard requirement. If `/admin` returns SPA `index.html` (`200`) while `/_mantle/admin/assets/*` is `404`, the page white-screens. Leave `/_mantle` out of `run_worker_first` so those files stay on the assets layer. `generate` warns when it syncs Admin and the local wrangler config has no `ASSETS` binding.

It does not project skills, update packages, change styling, provision providers, or deploy. It does not create manifests: a missing or empty `manifests/` directory is an error, not a prompt.

## The generated module

`.mantle/generated/mantle.ts` exports:

| Export | Purpose |
|---|---|
| `plan` | The sealed RuntimePlan with its fingerprint. The conventional Worker imports only this. |
| `MantleHandlers<Env>` | The handler map type: one typed function per `handler.kind: ref` Procedure, receiving `(input, ctx)`. |
| `createMantle({ storage, handlers, ports })` | Prepares storage eagerly once and returns the typed binding. No caching or retry. |
| `bindMantle(runtime)` | The same typed binding over a runtime whose lifecycle the host already owns. |

The binding exposes `mantle.views.<lowerCamelName>()`, `mantle.procedures.<name>(input, ctx)`, `mantle.entries.<collection>.createDraft({ data, authorId })` and the underlying `mantle.runtime`. Generated property names are deterministic lower-camel identifiers; calls keep the authored wire names internally. Details are in [HTTP, MCP, CLI and packages](../reference/surface.md).

## The daily loop

```sh
pnpm install --frozen-lockfile
pnpm exec mantle validate
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec tsc --noEmit
pnpm test                      # only when the project declares a test script
pnpm exec mantle-harness indexes --require-public --format text
pnpm exec wrangler dev --local
```

Run the harness after any change to a Schema index, View filter or ordering, or public route; declare the smallest ordered index the measured path needs and respect SQLite's leftmost-prefix rule. Before a deploy, run `mantle validate --phase deploy`. Probe at least one declared route on the local origin; a `200` from a public View does not prove Admin or MCP login works. When Admin is installed, also probe `/admin/sign-in` and one `/_mantle/admin/assets/*` URL — both must be `200`. HTML 200 with asset 404 is the white-screen class of bug.

## Connecting an agent

`mantle skills` projects the skills the installed package marks `projection: project`. At this version those are `develop`, `plugin`, `theme` and `update`; `install`, `media-gc` and `provision` stay opt-in because they create projects, delete remote objects or handle production secrets. Both tool layouts receive identical bytes. Generation never rewrites these files.

Install the version-matched plugin bundle in the agent host, using the exact version from `package.json`:

```sh
# Claude Code — two separate prompts
/plugin marketplace add aotter/mantle@v<installed-version>
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle --ref v<installed-version>
codex plugin add mantle@mantle
```

The projected `develop` skill tells the agent to read `package.json` for the installed version, the manifests and adapter config, and the docs under `node_modules/@aotter/mantle/docs/` before editing. To connect an MCP client to the running Worker, see [MCP and agents](../concepts/mcp-and-agents.md).

## Version pins

- Pin every `@aotter/mantle*` package to one exact version and move them together. Check that release's peer ranges when you move.
- This handbook describes the snapshot in this source tree. Use the docs that ship with the version in `package.json`, not a floating branch.
- The authoring CLI is `generate`, `validate`, `emit-openapi` and `skills`. `mantle-harness` is the measurement binary. There is no `create` / `update` happy path.
- When you change versions: pin the new exact version and refresh the lockfile; keep the Worker, D1, KV identity, origins, auth mode and secrets; then run `generate`, `generate --check`, `skills`, `skills --check`, `validate`, typecheck and tests before deploying.

## Source
- [`docs/direct-authoring.md`](../../../docs/direct-authoring.md)
- [`docs/examples/local-admin-otp/README.md`](../../../docs/examples/local-admin-otp/README.md)
- [`docs/examples/local-admin-otp/wrangler.jsonc`](../../../docs/examples/local-admin-otp/wrangler.jsonc)
- [`docs/examples/minimal-worker/.gitignore`](../../../docs/examples/minimal-worker/.gitignore)
- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/mantle/src/cli/main.ts`](../../../packages/mantle/src/cli/main.ts)
- [`packages/mantle/src/cli/generate.ts`](../../../packages/mantle/src/cli/generate.ts)
- [`packages/mantle/src/cli/skills.ts`](../../../packages/mantle/src/cli/skills.ts)
- [`packages/mantle/src/cli/harness.ts`](../../../packages/mantle/src/cli/harness.ts)
- [`packages/mantle/src/codegen/emitMantleModule.ts`](../../../packages/mantle/src/codegen/emitMantleModule.ts)
- [`packages/mantle-spec/src/infrastructure/cli/ValidateCommand.ts`](../../../packages/mantle-spec/src/infrastructure/cli/ValidateCommand.ts)
- [`packages/mantle-spec/src/infrastructure/cli/EmitOpenapiCommand.ts`](../../../packages/mantle-spec/src/infrastructure/cli/EmitOpenapiCommand.ts)
- [`packages/mantle-spec/src/infrastructure/cli/MantleCli.ts`](../../../packages/mantle-spec/src/infrastructure/cli/MantleCli.ts)
- [`skills/develop/SKILL.md`](../../../skills/develop/SKILL.md)
