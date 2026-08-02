---
name: develop
description: Work on an existing Mantle site through manifests, generated types, business handlers, and the public Core SDK.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/develop/SKILL.md
  applies_to: mantle@v0.1.0
---

# Mantle Develop

Mantle sites should expose business decisions, not SDK assembly. Start with the
smallest author-owned surface and disclose lower layers only when the task needs
them.

## First Read

1. `package.json` and `wrangler.jsonc` for the installed version, commands,
   bindings, and public vars.
2. `manifests/` for the Schema, View, Procedure, and Trigger contracts.
3. `src/index.ts`, then `src/handlers.ts` and nearby business services when
   present.
4. `public/index.html` or the project-owned UI directory when the site has a
   visible page.
5. `.mantle/launch-state.json` and `.mantle/handoff.md` for launch context.

Treat `.mantle/generated/` and projected `.agent`/`.claude` Mantle skills as
generated outputs. Regenerate them; do not edit them by hand.

## Pick the Smallest SDK Layer

The normal Worker entry is:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { manifest } from "../.mantle/generated/site.js";

export default createMantleWorker({ manifest });
```

- Add `handlers` only for manifest Procedures with `handler.kind: ref`.
- Use `createMantleWorker({ extend })` to add a route, middleware, or service
  on Mantle's existing Cloudflare stack. Use the top-level `bindings` option to
  augment conventional adapters.
- Use the public low-level exports from `@aotter/mantle/runtime` and
  `@aotter/mantle/cloudflare` only when the façade cannot express the required
  Worker architecture.

Do not rebuild Hono, D1/KV adapters, Auth, OAuth, MCP, cache policy, or runtime
boot in normal site source.

When a hidden default must become application-owned, do not recreate the old
bundle wholesale:

| Former surface | Reclaim it through |
|---|---|
| `src/mantle/config.ts` | Façade options and typed `extend`; use the public low-level composition recipe only when the Worker architecture itself differs. |
| Kiwa/component catalog | Edit the materialized page, or copy/eject one selected source file with provenance and license. The last full historical catalog is starter `v0.0.11-alpha.63`. |
| Overlay seed | Recover a selected legacy alpha.63 seed only as reference; port useful intent into manifests, content, business/UI source, or test-only fixtures. |
| Repo updater | Prefer or wrap installed `mantle update`. A deliberate project-owned replacement is allowed and maintained by that project; do not blindly restore the generated legacy updater. |

The full recipes live in
`node_modules/@aotter/mantle/docs/site-overrides.md`. This is a shadcn-style
ownership boundary: defaults are omitted until useful, and copied source is
free to change.

## Authoring Loop

```bash
pnpm exec mantle generate
pnpm validate
pnpm check:generated
pnpm typecheck
pnpm check
```

`mantle generate` compiles parsed manifests and handler types into
`.mantle/generated/` and refreshes Core-owned local skills. Run it after every
manifest or referenced-Procedure change. After changing `wrangler.jsonc`, run
the project's Wrangler type-generation/check command too.

Mantle has exactly four atoms:

| Atom | Purpose |
|---|---|
| `Schema` | Stored entity shape and indexes. |
| `View` | Typed read/query surface. |
| `Procedure` | Typed mutation or operation. |
| `Trigger` | HTTP, lifecycle, or MCP invocation. |

Do not invent a new manifest kind for UI, forms, features, or workflows.

## Common Changes

- Change stored and public input fields in the Schema and Procedure together.
- Keep public mutation inputs `additionalProperties: false`.
- Keep fixed option values aligned between Schema, Procedure, and UI.
- Use `lifecycle: none` for operational submissions and `simple` for content
  people stage and publish.
- Edit `public/index.html` directly when it is the shipped static page. Add a
  component framework only when real interaction or reuse justifies it.
- Use Admin, Staff MCP, or typed runtime use cases for stored content. Do not
  write Mantle-owned tables or KV keys directly.
- Put secrets in Cloudflare's secret store, never `wrangler.jsonc` or git.

## Performance

After changing indexes or public reads, use the project's harness:

```bash
pnpm check:indexes
# or
pnpm exec mantle-harness indexes --require-public --format text
```

Use crowded query plans and query counts, not tiny-fixture timing. Respect
SQLite's leftmost-prefix rule. Add only the index a measured path needs; do not
cache every read.

For serving changes, start the Worker and sample real routes with
`mantle-harness http`. Verify cache MISS/HIT for explicitly public responses
and `private, no-store` for auth, API, MCP, redirects, and errors.

## Boundary

Normal site code uses manifests, generated handler types, Auth, runtime use
cases, `entryReader`, and `siteConfig`. Cloudflare-specific code belongs at the
Worker composition root. If a normal feature needs Mantle table SQL, generated
column names, or private package paths, report a Core abstraction gap instead
of creating a second implementation.
