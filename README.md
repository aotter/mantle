# Mantle

[![CI](https://github.com/aotter/mantle/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/aotter/mantle/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

![A dungeon master invokes four runes while a living shell labyrinth assembles itself; an unused pickaxe lies nearby.](docs/assets/mantle-hero.jpg)

**Be the dungeon master. Don't code every corridor.**

Declare four atoms. Mantle makes the dungeon move.

Most vibe coding builds an application one tunnel at a time: a data model, a
route, a page, an admin action, a background job. The first version is fast;
the next prompt has to remember how every tunnel connects.

Mantle gives the application a small grammar: Schema, View, Procedure, and
Trigger. Author only the atoms you need, validate them into one runtime plan,
and generate typed bindings from the same contract. Bring your own database,
server, routes, and UI.

> **Prerelease:** APIs and manifests may change between alpha releases. Treat
> the installed package's version-matched docs as the contract and review
> generated code before production use.

## One manifest, one contract

Define application intent in ordinary YAML. Related atoms can share a file;
Core discovers immediate `.yaml` and `.yml` files under `manifests/` without
assigning a special filename.

```yaml
# manifests/orders.yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: orders
spec:
  title: Orders
  schema:
    type: object
    required: [status, total]
    properties:
      status: { type: string, enum: [open, closed] }
      total: { type: number, minimum: 0 }

---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: open-orders
spec:
  surface: public
  from: orders
  fields: [id, status, total]
  filter:
    eq: { field: status, value: open }
```

Generate the sealed plan and typed application bindings:

```bash
pnpm exec mantle generate
```

Embed them behind storage owned by the application:

```ts
import { createMantleRuntime, prepareDeployment } from "@aotter/mantle/runtime";
import { bindMantle, plan } from "./.mantle/generated/mantle.js";

const prepared = await prepareDeployment(plan, applicationStorage);
const runtime = createMantleRuntime({ plan, prepared });
const mantle = bindMantle(runtime);

const orders = await mantle.views.openOrders();
```

Generated properties use deterministic lower-camel names while preserving the
authored wire names internally. Dynamic applications can skip code generation
and call Runtime with authored names directly. The host keeps ownership of
storage, handlers, routing, process lifecycle, and sibling application code.

## How it works

```text
YAML sources -> parse -> link -> compile -> RuntimePlan
                                      |
                    application storage -> prepare -> MantleRuntime
                                                        |
                       typed bindings / Web / Admin / platform adapters
```

- Use Spec alone for parsing, linking, diagnostics, or custom tooling.
- Embed Runtime behind semantic ports backed by SQLite, Postgres, MongoDB, or
  existing application repositories.
- Add generated bindings when compile-time property names are useful.
- Add Web, Admin, or Admin UI independently.
- Use the Bun, Vercel, or Cloudflare adapter when its host contract matches.
- Start from [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters)
  when an official example or bootstrap is useful. A Starter is not required
  by Core and does not define where Mantle lives in an application.

### Why “Mantle”?

A mollusk's mantle is the living tissue that secretes its shell. Mantle follows
the same idea: it does not hand you a prefabricated application shell and ask
you to move in. It grows useful structure around the application you already
own.

## Develop with Mantle

### For human engineers

Every layer is an ordinary TypeScript API. Human engineers can author and
review manifests directly, use Spec without Runtime, implement semantic ports
over existing storage, or compose generated bindings and optional packages.
The [umbrella package README](packages/mantle/README.md) is the installed API
guide; adapter authors start with the [adapter guide](docs/adapter-guide.md).

### With a coding agent

This source repository is also an installable agent plugin bundle for Claude
Code, Codex, Cursor, and GitHub Copilot. The plugin gives coding agents
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
is cloned or opened. See [`skills/README.md`](skills/README.md) for host details
and the shipped consumer workflows.

Installing the source-repository plugin helps an agent create and maintain
Mantle projects. Inside a consumer project, `mantle skills` instead projects
the installed package's exact version of the `develop`, `plugin`, `theme`, and
`update` skills into repo-local agent paths.

## Packages

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

```bash
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec mantle validate
pnpm exec mantle introspect
pnpm exec mantle emit-openapi
pnpm exec mantle emit-types
pnpm exec mantle skills
pnpm exec mantle update --ref <immutable-starter-ref>
```

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
