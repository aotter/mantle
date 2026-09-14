---
description: The sealed parse-link-compile-prepare-bind pipeline, Core versus optional products, and how Cloudflare, Bun, Vercel and IndexedDB differ.
---
# Runtime pipeline and adapters

Mantle has exactly one path from YAML to a running service, and one owner for every rule along it. This page walks that pipeline, then shows what changes and what stays fixed when you swap the host underneath it.

## The sealed pipeline

```txt
ManifestSourceSet
  -> parse + normalize -> ParsedManifestSet
  -> link               -> LinkedManifestSet
  -> compile            -> RuntimePlan
  -> prepare deployment -> PreparedRevision
  -> bind runtime       -> MantleRuntime
```

Each stage's output can be constructed only by the stage that owns it, and a failed stage produces nothing the next stage can use. Parse, link and compile are pure and deterministic.

| Stage | Owns | Rejects | Must not own |
|---|---|---|---|
| Parse + normalize | YAML syntax and alias limits, the closed four-atom shape, atom-local rules, behavior-affecting defaults, source metadata | Unknown keys, bad envelopes, unsupported JSON Schema keywords, invalid index and `uiSchema` shapes | Cross-atom references, handlers, storage, routes |
| Link | Duplicate symbols, cross-atom references, guard graphs, translations, manifest-owned route and tool collisions | Unknown Schema or Procedure references, guard self-reference and chains, duplicate HTTP paths, MCP tool-name collisions | I/O, selected modules, handler availability |
| Compile | Immutable lookup records, authorization plans, Trigger indices, Procedure descriptors, logical View plans, the semantic fingerprint | Nothing new; it projects an already valid graph | Connections, repositories, handlers, requests, templates, assets |
| Prepare | Storage migrations, indexes and native Views, handler availability, selected capability and reserved-route checks, the readiness revision | Missing handler refs, reserved-path conflicts, `View.spec.sql` on storage that does not declare the SQLite dialect | Re-interpreting YAML, executing requests |
| Bind and invoke | Semantic ports, handler dispatch, parameter binding, centralized authorization, content, View, Procedure, Trigger and lifecycle operations | Invalid input, unauthorized callers, lifecycle transitions the state machine forbids | DDL, route mounting, assets, HTTP, session and cache policy |
| Optional modules and adapters | Web and Admin composition; request, session, cache and platform translation | Whatever the platform itself rejects | Re-parsing, re-linking, or a second authorization stack |

Nothing downstream may reinterpret raw manifests. That is what makes a rule verifiable exactly once, and why every rejection carries a diagnostic code instead of a guess. See [Diagnostic codes](../reference/diagnostics.md).

## What `mantle generate` produces

```sh
pnpm exec mantle generate
pnpm exec mantle generate --check
```

`generate` validates and compiles the manifests directory, then writes one typed module at `.mantle/generated/mantle.ts` containing the sealed `plan` with its fingerprint, the handler types, and two entry points:

```ts
import { bindMantle, createMantle, plan } from "../.mantle/generated/mantle.js";

// Eager: one preparation attempt, no caching and no retry.
const mantle = await createMantle({ storage, handlers, ports });
const notes = await mantle.views.publishedNotes();
await mantle.entries.orders.createDraft({ data, authorId: user.id });

// Or bind a runtime the host already assembled and owns the lifecycle of.
const bound = bindMantle(runtime);
await bound.runtime.archive.execute({ id, ctx });
```

Generated property names are deterministic lower-camel identifiers; calls keep the authored wire names internally, and a collision is an error (`CODEGEN_IDENTIFIER_COLLISION`). Code generation is a pure projection: it never caches, retries, mounts routes or owns host lifecycle, and the typed API keeps its raw `runtime` so it hides nothing. Skipping generation is valid — call `runtime.executeView({ view: "published-notes" })` by name.

## Core, optional products, adapters

| Layer | Package | Responsibility |
|---|---|---|
| Core | `@aotter/mantle-spec` | Sources, parse, normalize, link, introspection, code generation. No runtime or platform dependency. |
| Core | `@aotter/mantle-runtime` | `RuntimePlan`, preparation contracts, semantic storage ports, `MantleRuntime`. No Web, Admin or platform dependency. |
| Optional product | `@aotter/mantle-web` | Public HTML, Markdown mirrors, `llms.txt`, sitemap, SEO, preview, templates, path composition. Owns no routes. |
| Optional product | `@aotter/mantle-admin` | Admin API orchestration, OAuth surfaces, the asset contract. |
| Optional product | `@aotter/mantle-admin-ui` | The pre-built React Admin SPA artifact. |
| Adapter | `@aotter/mantle-cloudflare`, `-bun`, `-vercel`, `-indexeddb` | Bind platform storage, lifecycle, request, session, cache and asset concerns to Core ports. |

The umbrella `@aotter/mantle` installs Spec and Runtime only; every other subpath is an optional peer you install when you select it. Core does not reserve Admin paths or serve a UI when the module is absent.

## Capability matrix

| | Cloudflare | Bun | Vercel Functions | IndexedDB |
|---|---|---|---|---|
| Storage | D1 through the SQLite chain | Caller-owned `bun:sqlite` `Database` | Any injected `MantleStorageAdapter`; optional `/libsql` Turso driver | One application-owned IndexedDB database |
| Public View REST | Yes | Yes | Yes | Not mounted; call the runtime directly |
| HTTP Triggers | Yes | Yes | Yes | Not mounted; `runtime.invokeTrigger` |
| Admin, Auth, OAuth | Yes | Absent | Absent | Absent |
| MCP `/mcp`, `/mcp/staff` | Yes | Absent | Absent | Absent (WebMCP is a separate browser binding) |
| Public web pages | Opt-in via `mountPublicRoutes` plus templates and a resolver | Absent | Absent | Absent |
| Cache policy | Owned, applied at the final boundary | Host-owned | Host-owned | n/a |
| `View.spec.sql` | Supported | Supported | Supported on a SQLite-family driver | Rejected at preparation |
| Optional capabilities | R2 media, Queues deferred hooks, KV catalog cache | None | Platform `waitUntil` | None |
| Host still owns | Application routes and frontend | `Bun.serve`, auth, CSRF, database shutdown | Web handler, auth, CSRF, route composition | Database naming, persistence requests, UI invalidation, sync |

The Manifest does not change across that row. What changes is which surfaces exist to reach it.

## Storage ports

A storage adapter prepares one `RuntimePlan` into semantic ports. Three are required:

| Port | Role |
|---|---|
| `MantleStorageAdapter` / `PreparedMantleStorage` | Prepares one plan into a revision: migrations, indexes, native Views |
| `EntryRepository` and `EntryReader` | Entry writes and reads |
| `ViewQueryExecutor` | Executes compiled logical View plans |

Two are optional and only when a feature needs them: `MediaStorage` for upload flows, and `DeferredHookDispatcher` for at-least-once `after_*` delivery. `DatabaseDriver` is not a portability contract — it is the reusable SQLite/D1 seam. A PostgreSQL, MongoDB or application-owned-table adapter implements the semantic ports directly rather than emulating D1.

Declarative Views compile to logical plans once, and preparation lowers those plans to native queries. `View.spec.sql` is the exception: it is explicitly SQLite-only in v0.1. Storage that does not declare that dialect rejects such a View at preparation with `VIEW_DIALECT_UNSUPPORTED`, before mutating any state. Mantle does not guess a translation and ships no universal query driver. A View that must run everywhere uses `from` with a filter AST; see [View](../reference/view.md).

## Embedding each adapter

Cloudflare, through the conventional facade:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

Bun, with the server and SQLite handle staying yours:

```ts
import { Database } from "bun:sqlite";
import { createBunMantle } from "@aotter/mantle-bun";

const database = new Database("app.sqlite");
const mantle = createBunMantle({ plan, database, handlers });

Bun.serve({
  async fetch(request) {
    return (await mantle.handle(request)) ?? new Response("not found", { status: 404 });
  },
});
```

Vercel Functions, with storage injected:

```ts
import { SqliteMantleStorageAdapter } from "@aotter/mantle-runtime";
import { createVercelMantle } from "@aotter/mantle-vercel";
import { LibsqlDatabaseDriver } from "@aotter/mantle-vercel/libsql";

const mantle = createVercelMantle({
  plan,
  handlers,
  storage: new SqliteMantleStorageAdapter(new LibsqlDatabaseDriver(client)),
});
```

Browser IndexedDB, with no HTTP transport at all:

```ts
import { bootMantleRuntime } from "@aotter/mantle-runtime";
import { IndexedDbMantleStorageAdapter } from "@aotter/mantle-indexeddb";

const storage = new IndexedDbMantleStorageAdapter({ databaseName: "my-app" });
const runtime = await bootMantleRuntime({ plan, storage, handlers });
await runtime.invokeTrigger({ trigger: "rename-board-mcp", input, ctx });
```

`handle()` returns `null` for a path Mantle does not own, so the host keeps its own routes. Never treat a Vercel Function's filesystem or `/tmp` as durable state.

## The adapter-boundary rule

Platform bindings belong at the composition root only: the Worker entry, `createMantleWorker` options, the `bindings` hook and `wrangler.jsonc`. Procedure handlers receive them through `ctx.env`.

Application code never queries Mantle-owned tables — `entries`, `site_config`, media, Auth — and never reaches through a raw database handle to get at them. Use Manifests, runtime use cases, `runtime.entries`, `runtime.siteConfig`, generated `bindMantle(runtime)` and Views instead, and do not copy generated-column names or construct SDK storage keys. An application may of course own its own tables behind its own repository; that is different from writing to Core's.

If a normal feature cannot be expressed through a purpose-shaped surface, treat that as a gap in the abstraction rather than teaching the project Mantle's internals. Internals change between versions; the ports do not.

## Related

- [The four atoms](./four-atoms.md) — what the pipeline is compiling.
- [Bindings and primitives](../cloudflare/bindings.md) — the composition root in practice.
- [Low-level composition](../cloudflare/low-level-composition.md) — assembling a Worker from the same public primitives.
- [Project layout and the CLI loop](../start/project-and-cli.md) — where `generate` sits in the daily loop.

## Source
- [`docs/adr/0019-sealed-manifest-runtime-pipeline.md`](../../../docs/adr/0019-sealed-manifest-runtime-pipeline.md)
- [`docs/adapter-guide.md`](../../../docs/adapter-guide.md)
- [`packages/mantle/README.md`](../../../packages/mantle/README.md)
- [`packages/mantle-runtime/README.md`](../../../packages/mantle-runtime/README.md)
- [`packages/adapters/bun/README.md`](../../../packages/adapters/bun/README.md)
- [`packages/adapters/vercel/README.md`](../../../packages/adapters/vercel/README.md)
- [`packages/adapters/indexeddb/README.md`](../../../packages/adapters/indexeddb/README.md)
- [`skills/develop/SKILL.md`](../../../skills/develop/SKILL.md)
