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
  <a href="#features">Features</a>
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

AI builders usually turn a prompt into source files. Mantle turns four small
YAML atoms into one sealed, executable contract.

Describe Schema, View, Procedure, and Trigger once. Mantle links and validates
them before boot, then carries the same RuntimePlan into typed TypeScript,
REST and OpenAPI, MCP tools, optional Web and Admin, and platform adapters.
There is no second schema to keep in sync.

Mantle runs inside the application you own. Your host keeps its storage,
routing, auth, queues, cache policy, and lifecycle; Mantle supplies the
semantic runtime and only the optional surfaces you select.

> Describe the system once. Run the same contract through code, HTTP, MCP,
> Web, and Admin.

## One manifest, one contract

1. Describe your project in `manifests/reservations.yml`:

   ```yaml
   # excerpt — see the complete manifest reference below
   apiVersion: cms.mantle.aotter.net/v1
   kind: Schema
   metadata:
     name: slots
   spec:
     lifecycle: operational
     schema:
       type: object
       required: [startsAt, state]
       properties:
         startsAt: { type: string, format: date-time }
         state: { type: string, enum: [available, reserved] }
         # ...
   ---
   apiVersion: cms.mantle.aotter.net/v1
   kind: View
   metadata:
     name: available-slots
   spec:
     surface: public
     from: slots
     filter:
       eq: { field: state, value: available }
     # ...
   ---
   apiVersion: cms.mantle.aotter.net/v1
   kind: Procedure
   metadata:
     name: request-reservation
   spec:
     input:
       type: object
       required: [slotId, email]
       properties:
         slotId: { type: string }
         email: { type: string, format: email }
     output:
       type: object
       required: [queued]
       properties:
         queued: { type: boolean }
     handler: { kind: ref, ref: queue-reservation-request }
   ---
   apiVersion: cms.mantle.aotter.net/v1
   kind: Trigger
   metadata:
     name: request-reservation-mcp
   spec:
     source: { kind: mcp, surface: public }
     target: { procedure: request-reservation }
   ```

   See the [complete manifest reference](docs/design-atoms.md) for the full syntax.

2. Install Mantle and generate the typed runtime binding:

   ```bash
   pnpm add @aotter/mantle@alpha
   pnpm exec mantle generate
   ```

3. Give the generated binding your
   [storage adapter](docs/adapter-guide.md):

   ```ts
   import {
     createMantle,
     type MantleHandlers,
   } from "./.mantle/generated/mantle.js";

   interface Env {
     RESERVATION_QUEUE: {
       send(message: { slotId: string; email: string }): Promise<void>;
     };
   }

   const handlers = {
     "queue-reservation-request": async ({ slotId, email }, ctx) => {
       await ctx.env.RESERVATION_QUEUE.send({ slotId, email });
       return { queued: true };
     },
   } satisfies MantleHandlers<Env>;

   const mantle = await createMantle({ storage, handlers });

   // The `available-slots` View becomes a typed lower-camel property.
   const slots = await mantle.views.availableSlots();
   ```

4. That's it: the View is a typed query, the Procedure is your typed handler,
   and the Trigger exposes it as a public MCP tool. Your application still
   owns its storage, queue, routing, and lifecycle. The direct helper prepares
   once without hidden caching or retries; platform adapters keep those
   policies, and `mantle.runtime` exposes the same raw Runtime when the host
   needs lower-level capabilities.

## Features

`createMantle()` is only the shortest entry point. Mantle's difference is what
the same contract unlocks around it.

- **One contract across every surface.** The same sealed RuntimePlan powers
  generated types, Runtime execution, transport adapters, Web, and Admin.
- **Typed and standard APIs.** Schemas and Views become typed TypeScript;
  declared Views and HTTP Triggers become REST routes and OpenAPI 3.1 without
  another API schema.
- **MCP servers and tools.** Views, guarded content operations, media
  operations, and MCP Triggers compile into public or staff tool catalogs;
  the Cloudflare adapter can mount them behind OAuth.
- **Version-safe, multilingual content.** Optimistic versions protect against
  stale writes; publishing and operational lifecycles, site locale policy,
  localized Schemas, and parent/translation joins are built in.
- **Web for search engines and LLMs.** The optional Web package composes HTML,
  previews, canonical and social metadata, JSON-LD, hreflang, sitemap,
  `llms.txt`, and predictable `.md` mirrors for serializable public content.
- **A complete Admin, only when selected.** Add the Admin API, staff gates,
  and prebuilt React UI for publishing content and live operational records;
  editorial approval flows are coming next. Omit it for a headless service.
- **Starter families for common product shapes.** Start from
  [Blank, Presence, Intake, Publication, Transaction, or
  Reservation](https://github.com/aotter/mantle-starters); Membership and
  Community are coming soon. Shared recipes and overlays keep them from
  becoming separate framework forks.
- **Open source and host-owned.** Apache-2.0 Core runs inside your process, and
  hosts retain the raw Runtime and handler context for transactions, queues,
  media, or other platform capabilities. Use Bun, Vercel, Cloudflare, or a
  custom semantic storage adapter.
- **A $0-friendly Cloudflare path.** Small deployments can fit within the
  current [Workers](https://developers.cloudflare.com/workers/platform/pricing/)
  and [D1](https://developers.cloudflare.com/d1/platform/pricing/) free limits.
  Domain registration and usage beyond provider limits are separate.

## How it works

Everything consumes the same sealed plan. Optional packages project it into
new surfaces; none becomes another source of truth.

```text
Schema + View + Procedure + Trigger
                 |
        parse -> link -> compile
                 |
          sealed RuntimePlan
                 |
  application ports -> MantleRuntime
                 |
  typed API / REST / OpenAPI / MCP / Web / Admin
```

Spec can parse and diagnose manifests without Runtime. Runtime executes the
plan through semantic ports; generated bindings and host adapters stay thin.
`createMantle` is the shortest direct composition path, not a boundary around
the lower-level Runtime.

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
| `mantle generate` | Compile manifests into a sealed plan and typed runtime module. |
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
sealed plan, generated types, `createMantle`, and `bindMantle`. It does not
install Admin, change styling, project skills, provision providers, or deploy
the application.

## Contributing

- [`CONTRIBUTING.md`](CONTRIBUTING.md) is the contributor and architecture
  authority for humans and agents.
- [`docs/adr/`](docs/adr/) records accepted, path-dependent decisions.
- [`docs/release-process.md`](docs/release-process.md) governs releases.
- [GitHub Releases](https://github.com/aotter/mantle/releases) is the canonical
  public change history.

Apache 2.0. See [`LICENSE`](LICENSE).
