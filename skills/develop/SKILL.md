---
name: develop
description: Work on any Mantle project using the Core SDK contract. Use for manifest, runtime, content model, handler, adapter, validation, and MCP work after a project already exists.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/develop/SKILL.md
  applies_to: mantle@v0.1.0
---

# Mantle Develop

This is the Core SDK skill for working inside an existing Mantle project.
Starter files, launch handoffs, and plugin recipes are context; this skill
owns the workflow vocabulary.

## First Read

1. `package.json` for the installed `@aotter/mantle*` versions.
2. `manifests/` and `src/mantle/config.ts` for the active atoms and adapter wiring. If the project is older, check `src/mantleConfig.ts`.
3. Optional local context: `.mantle/launch-state.json`, `.mantle/handoff.md`,
   `.mantle/plugins.json`, `.mantle/plugins.lock.json`, and `.mantle/recipes/`.
4. Installed Core docs in `node_modules/@aotter/mantle/docs/`.

If `node_modules/` is missing, run `pnpm install --frozen-lockfile` before
falling back to remote docs. Remote docs must use a tag matching the installed
version; never use `develop` branch docs for a versioned consumer project.

## Existing Examples

Before inventing a Mantle pattern, inspect
[`aotter/mantle-starters`](https://github.com/aotter/mantle-starters).
Use a tag matching the installed Mantle version when available; use `develop`
only for unreleased work. `blank/` shows the base application shape and
`overlays/<type>/` contains working examples of manifests, handlers, routes,
pages, and feature wiring. Copy the smallest matching pattern. Do not edit or
copy generated `provision-bundles/*.json` by hand.

## Authoring CLI

Use the project's scripts first; generated starters expose the shipping
`mantle` authoring CLI from `@aotter/mantle-spec`:

```bash
pnpm exec mantle --help
pnpm validate
pnpm introspect
pnpm emit-openapi
pnpm emit-types
```

This CLI validates and derives artifacts from an existing materialized
project; starter creation is owned by the provision-bundle flow.

## Core Model

Mantle exposes exactly four declarative atoms:

| Atom | Purpose |
|---|---|
| `Schema` | Stored entity/table shape. |
| `View` | Read/query surface. |
| `Procedure` | Typed mutation or operation. |
| `Trigger` | HTTP/lifecycle/MCP invocation binding. |

Do not invent manifest kinds such as `Form`, `Feature`, `Workflow`, or
`Membership`. Compose those from the four atoms plus TypeScript only where
the atoms cannot express the behavior.

## Adapter Boundary

The runtime is adapter-neutral. Required runtime ports are `DatabaseDriver`,
`KvCache`, and `AssetServer`. Optional feature ports, such as `MediaStorage`
or `DeferredHookDispatcher`, are enabled only when the current adapter wires
them.

Do not assume Cloudflare unless the project imports `@aotter/mantle/cloudflare`
or its adapter config is visible. A future Netlify adapter should satisfy the
same Core workflow through its own ports and provider setup.

## Loop

```bash
pnpm install --frozen-lockfile
pnpm validate
pnpm typecheck
pnpm check
```

Use `pnpm dev` for local preview when the project provides it.

## Connect a Local MCP Client

Start the project with `pnpm dev`, then use the exact local origin it prints.
Generated Cloudflare projects normally expose:

- `http://localhost:8787/mcp` for public tools;
- `http://localhost:8787/mcp/staff` for authenticated authoring tools.

Prefer the client's native remote HTTP + OAuth support. Use a standard
HTTP-to-stdio bridge such as `npx -y mcp-remote <url>` only when the client
accepts stdio MCP servers but cannot connect to remote HTTP directly. Mantle
does not own a separate local proxy or an auth-bypass mode.

Before changing client config, confirm the Worker is reachable:

```bash
curl -i http://localhost:8787/mcp
```

An OAuth-protected endpoint should respond with `401` and a
`WWW-Authenticate` resource-metadata challenge before sign-in. After
connecting, inspect `tools/list`; make one read-only `query_view_*` call when
available before invoking any mutation. Use project-scoped client config when
the client offers it, and never commit OAuth tokens or the bridge's token
cache.

## Rules

- Prefer manifest YAML for content model changes.
- Add TypeScript only for handlers, rendering, adapter wiring, or real behavior.
- Do not write directly to D1, KV, Postgres, or object storage for content
  authoring. Use runtime use cases, admin APIs, or Staff MCP.
- Do not commit provider secrets.
- If the work is an installable capability, switch to `mantle:plugin`.
