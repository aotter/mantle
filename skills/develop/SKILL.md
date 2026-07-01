---
name: mantle:develop
description: Work on any Mantle project using the Core SDK contract. Use for manifest, runtime, content model, handler, adapter, validation, and MCP work after a project already exists.
source: "@aotter/mantle"
sourcePath: skills/develop/SKILL.md
when_to_invoke: |
  Working dir contains a Mantle project: package.json depends on @aotter/mantle or @aotter/mantle-*, and manifests/ or src/mantle/config.ts exists. Legacy projects may still use src/mantleConfig.ts.
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
falling back to remote docs.

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

## Rules

- Prefer manifest YAML for content model changes.
- Add TypeScript only for handlers, rendering, adapter wiring, or real behavior.
- Do not write directly to D1, KV, Postgres, or object storage for content
  authoring. Use runtime use cases, admin APIs, or Staff MCP.
- Do not commit provider secrets.
- If the work is an installable capability, switch to `mantle:plugin`.
