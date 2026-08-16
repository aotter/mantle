# Mantle

[![CI](https://github.com/aotter/mantle/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/aotter/mantle/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

Mantle is an embeddable, manifest-driven application engine. It turns four
authored atoms—Schema, View, Procedure, and Trigger—into a validated runtime
plan, typed application bindings, and optional delivery surfaces.

> Mantle is prerelease software. APIs and manifests may change between alpha
> releases. Use the installed package's version-matched docs as the contract
> and review generated code before production use.

## Compose only what the application needs

```text
YAML sources -> parse -> link -> compile -> RuntimePlan
                                      |
                    application storage -> prepare -> MantleRuntime
                                                        |
                       typed bindings / Web / Admin / platform adapters
```

- Use Spec alone for parsing, linking, diagnostics, or your own tooling.
- Embed Runtime behind semantic ports backed by SQLite, Postgres, MongoDB, or
  existing application repositories.
- Run `mantle generate` when compile-time property names are useful; dynamic
  applications can call Runtime with authored wire names directly.
- Add Web, Admin, or Admin UI independently.
- Use the Bun, Vercel, or Cloudflare adapter when its host contract matches.
- Start from [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters)
  when an official example/bootstrap is useful. A Starter is not required by
  Core and does not define where Mantle lives in an application.

A generated plan can be embedded without handing server or database lifecycle
to Mantle:

```ts
import { createMantleRuntime, prepareDeployment } from "@aotter/mantle/runtime";
import { plan, bindMantle } from "./.mantle/generated/mantle.js";

const prepared = await prepareDeployment(plan, applicationStorage);
const runtime = createMantleRuntime({ plan, prepared, handlers });
const mantle = bindMantle(runtime);

const orders = await mantle.views.openOrders();
```

The host owns `applicationStorage`, `handlers`, routing, process lifecycle, and
any sibling application code.

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
Cloudflare are optional peers and remain directly installable. Installed API
and CLI examples live in the [umbrella package README](packages/mantle/README.md);
adapter authors start with the [adapter guide](docs/adapter-guide.md).

## Authoring CLI

The umbrella provides the `mantle` command set:

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
change styling, provision providers, or deploy the application.

## Consumer skills and official examples

The versioned [`skills/`](skills/) directory is shipped for agents working on
consumer applications. `mantle skills` projects the installed versions into a
consumer repository and `mantle skills --check` detects drift. These product
artifacts are intentionally separate from this repository's maintainer rules.

For a new example application, use [`skills/install/SKILL.md`](skills/install/SKILL.md)
to select and materialize a deterministic Starter bundle. Provisioning is a
separate, explicit workflow; Cloudflare-specific setup lives in
[`skills/provision/SKILL.md`](skills/provision/SKILL.md).

## Contributing

- [`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor and architecture
  authority for humans and agents.
- [`docs/adr/`](docs/adr/) records accepted, path-dependent decisions.
- [`docs/release-process.md`](docs/release-process.md) governs releases.
- [GitHub Releases](https://github.com/aotter/mantle/releases) is the canonical
  public change history.

Apache 2.0. See [`LICENSE`](LICENSE).
