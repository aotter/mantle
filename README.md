<h1 align="center">Mantle</h1>

<p align="center">
  <em>Be the dungeon master. Don’t code every corridor.</em>
</p>

<p align="center">
  <img src="docs/assets/mantle-hero.jpg" width="900" alt="A dungeon master invokes four runes while a living shell labyrinth assembles itself; an unused pickaxe lies nearby.">
</p>

<p align="center">
  <strong>Schema. View. Procedure. Trigger. Four atoms from which your world takes shape.</strong><br>
  Speak it in plain YAML, and the dungeon wakes—whole, lit from within, and yours to command.
</p>

<p align="center">
  <a href="https://github.com/aotter/mantle/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/aotter/mantle/ci.yml?branch=develop&style=flat-square&label=build"></a>
  <a href="https://github.com/aotter/mantle/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/aotter/mantle?style=flat-square&color=0b7285&label=stars"></a>
  <a href="https://www.npmjs.com/package/@aotter/mantle"><img alt="npm alpha" src="https://img.shields.io/npm/v/@aotter/mantle/alpha?style=flat-square&label=npm&color=0b7285"></a>
  <a href="https://github.com/aotter/mantle/releases"><img alt="GitHub prerelease" src="https://img.shields.io/github/v/release/aotter/mantle?include_prereleases&sort=semver&style=flat-square&label=release&color=0b7285"></a>
  <a href="https://nodejs.org/"><img alt="Node.js 22 or newer" src="https://img.shields.io/badge/node-%3E%3D22-0b7285?style=flat-square&logo=nodedotjs&logoColor=white"></a>
  <a href="LICENSE"><img alt="Apache-2.0 license" src="https://img.shields.io/badge/license-Apache--2.0-0b7285?style=flat-square"></a>
</p>

<p align="center">
  <a href="#one-manifest-one-contract">Quick start</a>
  &middot;
  <a href="#how-it-works">How it works</a>
  &middot;
  <a href="#develop-with-mantle">Develop</a>
  &middot;
  <a href="#packages">Packages</a>
  &middot;
  <a href="#cli-reference">CLI</a>
</p>

<p>
  <sub><strong>Prerelease:</strong> APIs and manifests may change between alpha releases. Treat the installed package's version-matched docs as the contract and review generated code before production use.</sub>
</p>

# Describe it. Run it.

You write a prompt and watch the AI agent start building the whole project, one
file at a time. Mantle takes a different path: describe the project in plain
YAML, and let that description become a validated, typed, running service.

Schema, View, Procedure, and Trigger express what exists, how it is read, what
can change, and what happens next. Mantle compiles that intent into a runtime
plan and connects it to the stack you already own.

The goal isn’t to help an agent write the whole codebase faster. It’s to make
the description itself executable.

> Don’t ask the agent to write the whole project. Ask it to describe the
> project in YAML—and let Mantle make it work.

## One manifest, one contract

Create `manifests/blog.yml`:

```yaml
# manifests/blog.yml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: posts }
spec:
  title: Posts
  schema:
    type: object
    required: [title, body]
    properties:
      title: { type: string }
      body: { type: string, x-mcp-hint: markdown }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata: { name: published-posts }
spec:
  surface: public
  from: posts
  fields: [id, title, body]
  filter: { eq: { field: status, value: published } }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: submit-post }
spec:
  input:
    type: object
    required: [title, body]
    properties:
      title: { type: string }
      body: { type: string, x-mcp-hint: markdown }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: posts }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submit-post-http }
spec:
  source: { kind: http, method: POST, path: /api/posts }
  target: { procedure: submit-post }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: submit-post-mcp }
spec:
  source: { kind: mcp, surface: public }
  target: { procedure: submit-post }
```

The selected adapters turn `published-posts` into both
`GET /api/views/published-posts` and the public MCP tool
`query_view_published_posts`. Two tiny Triggers expose the same builtin
Procedure as `POST /api/posts` and the public MCP tool `submit_post`; there is
no second handler to keep in sync. Mantle Admin reads the same Schema and
`x-mcp-hint` to render the collection with a Markdown editor.

Run from the project root:

```bash
pnpm exec mantle generate
```

By default, `generate` reads the immediate `.yaml` and `.yml` files in
`./manifests` and writes `.mantle/generated/mantle.ts`. Both paths are
configurable:

```bash
pnpm exec mantle generate --manifests ./content --output ./src/generated
```

The generated module contains the sealed plan, generated types, and
`bindMantle`. Import it only after generation:

```ts
import { createMantleRuntime, prepareDeployment } from "@aotter/mantle/runtime";
import { bindMantle, plan } from "./.mantle/generated/mantle.js";

const prepared = await prepareDeployment(plan, applicationStorage);
const runtime = createMantleRuntime({ plan, prepared });
const mantle = bindMantle(runtime);

const posts = await mantle.views.publishedPosts();
```

`published-posts` becomes `publishedPosts` in TypeScript while its wire name stays
unchanged. Code generation is optional; dynamic applications can call Runtime
with authored names directly.

Nothing else is surrendered. The host owns storage, handlers, routing, process
lifecycle, and sibling application code.

## How it works

The incantation follows one sealed path. Everything around it stays composable.

```text
YAML sources -> parse -> link -> compile -> RuntimePlan
                                      |
                    application storage -> prepare -> MantleRuntime
                                                        |
                       typed bindings / Web / Admin / platform adapters
```

- **Spec** parses, links, and diagnoses manifests without a runtime or adapter.
- **Runtime** executes the sealed plan through semantic ports backed by SQLite,
  Postgres, MongoDB, or existing application repositories.
- **Codegen** adds typed property names when they help; Runtime does not require
  it.
- **Web, Admin, and Admin UI** compose independently around Core.
- **Bun, Vercel, and Cloudflare adapters** bind only the host contracts they
  own.
- **Starters** are examples and bootstraps, not the shape of Core. Browse them
  at [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters).

### Why “Mantle”?

A mollusk's mantle is the living tissue that grows its shell. This Mantle works
the same way: it grows useful structure around the application you already
own. It never asks you to move into a prefabricated shell.

## Develop with Mantle

### Human engineers

Human engineers get the same direct path: ordinary YAML in, ordinary
TypeScript APIs out.

```bash
pnpm add @aotter/mantle@alpha
```

Author and review manifests directly, use Spec without Runtime, implement
semantic ports over existing storage, or compose generated bindings and
optional packages. The [umbrella package README](packages/mantle/README.md) is
the installed API guide; adapter authors start with the
[adapter guide](docs/adapter-guide.md).

### Coding agents

This repository has a second entrance: it is an installable agent plugin bundle
for Claude Code, Codex, Cursor, and GitHub Copilot. The plugin carries
version-matched Mantle workflows; it is an authoring aid, not a Runtime
dependency.

Use an immutable tag matching the installed package version:

```bash
# Claude Code — run as two separate prompts
/plugin marketplace add aotter/mantle@v<installed-version>
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle --ref v<installed-version>
codex plugin add mantle@mantle
```

Cursor and GitHub Copilot discover their plugin manifests when this repository
is cloned or opened. See [`skills/README.md`](skills/README.md) for host details.

- **Repository plugin:** teaches an agent to create and maintain Mantle
  projects.
- **`mantle skills`:** projects the installed package's exact `develop`,
  `plugin`, `theme`, and `update` workflows into a consumer repository.

## Packages

The center is small: Spec defines meaning and Runtime executes it. Everything
else composes around them.

| Package | Role |
|---|---|
| `@aotter/mantle-spec` | Pure grammar, parser, linker, diagnostics, and authoring CLI. |
| `@aotter/mantle-runtime` | Plan compiler, storage preparation, semantic ports, and runtime invocation. |
| `@aotter/mantle` | Core umbrella, typed code generation, and the `mantle` CLI. |
| `@aotter/mantle-web` | Optional HTML, Markdown, `llms.txt`, sitemap, SEO, and preview composition. |
| `@aotter/mantle-admin` | Optional Admin API, auth, and asset composition. |
| `@aotter/mantle-admin-ui` | Optional pre-built Admin SPA. |
| `@aotter/mantle-bun` | Bun adapter over caller-owned `bun:sqlite`. |
| `@aotter/mantle-vercel` | Vercel Functions adapter over injected storage; optional libSQL subpath. |
| `@aotter/mantle-cloudflare` | Cloudflare Workers adapter over D1 and selected platform services. |

The umbrella installs Spec and Runtime. Web, Admin, Admin UI, Bun, Vercel, and
Cloudflare are optional peers and remain directly installable.

## CLI reference

The umbrella provides one `mantle` command set:

| Command | Purpose |
|---|---|
| `mantle generate` | Compile manifests into the sealed plan and typed `bindMantle` module. |
| `mantle generate --check` | Fail without writing when generated code is stale. |
| `mantle validate` | Validate manifests and handler-source references. |
| `mantle introspect` | Print the parsed manifest tree as JSON. |
| `mantle emit-openapi` | Emit OpenAPI 3.1 from HTTP Triggers and View routes. |
| `mantle emit-types` | Emit TypeScript declarations from Schemas, Procedures, and Views. |
| `mantle skills` | Project version-matched Core skills into the consumer repository. |
| `mantle update --ref <ref>` | Compare local work with an immutable provision bundle; apply nothing. |

Run commands through the project's package manager, for example
`pnpm exec mantle generate`.

`generate` writes one `.mantle/generated/mantle.ts` module containing the
sealed plan, generated types, and `bindMantle`. It does not install Admin,
change styling, project skills, provision providers, or deploy the application.

## Contributing

- [`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor and architecture
  authority for humans and agents.
- [`docs/adr/`](docs/adr/) records accepted, path-dependent decisions.
- [`docs/release-process.md`](docs/release-process.md) governs releases.
- [GitHub Releases](https://github.com/aotter/mantle/releases) is the canonical
  public change history.

Apache 2.0. See [`LICENSE`](LICENSE).
