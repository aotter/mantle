---
name: extend
description: Add a Schema, View, Procedure, Trigger, typed handler, or deliberate Worker extension to an existing Mantle site.
metadata:
  source: "@aotter/mantle"
  sourcePath: skills/extend/SKILL.md
  applies_to: mantle@v0.1.0
---

# Extend a Mantle Site

Start with the manifest. Mantle has four atoms:

| Atom | Purpose |
|---|---|
| `Schema` | Stored entity shape, constraints, and indexes. |
| `View` | Typed public read/query. |
| `Procedure` | Typed mutation or business operation. |
| `Trigger` | HTTP, lifecycle, or MCP invocation. |

Use the Worker extension seam only for behavior that is not atom-shaped. Do
not reconstruct deleted starter assembly.

## Canonical loop

1. Add or edit YAML under `manifests/`.
2. Run `pnpm exec mantle generate` immediately.
3. Implement only referenced handlers and small business services.
4. Update the project-owned UI when the request/response contract changed.
5. Run the project's complete check.

```bash
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm validate
pnpm typecheck
pnpm check
```

Generated handler input/output and View row types live under
`.mantle/generated/`. Import them; never decode `Record<string, unknown>` or
invent a second handler context.

## Example: builtin newsletter signup

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata: { name: newsletter-signups }
spec:
  title: Newsletter signups
  schema:
    type: object
    additionalProperties: false
    required: [email]
    properties:
      email: { type: string, format: email }
      createdAt: { type: number, x-mantle-bind: now }
  uniqueIndexes: [[email]]
  lifecycle: none
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata: { name: subscribe }
spec:
  input:
    type: object
    additionalProperties: false
    required: [email]
    properties:
      email: { type: string, format: email }
  output: { type: object }
  handler: { kind: builtin, op: create, schema: newsletter-signups }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata: { name: subscribe-http }
spec:
  source: { kind: http, method: POST, path: /api/subscribe }
  target: { procedure: subscribe }
```

No `handlers.ts` is needed for a builtin Procedure. For `handler.kind: ref`,
implement the exact generated `MantleHandlers<SiteEnv>` member so `input`,
output, `ctx.env`, auth, and `ctx.waitUntil` stay typed.

## Typed Views and custom routes

Use the generated binder instead of reconstructing View requests or rows:

```ts
import { bindMantleSite, manifest } from "../.mantle/generated/site.js";
import {
  createMantleWorker,
  runMantleUseCase,
} from "@aotter/mantle/cloudflare";

export default createMantleWorker({
  manifest,
  extend: () => ({
    mount({ app, getRuntime }) {
      app.get("/catalog.json", () => {
        return runMantleUseCase("GET /catalog.json", async () => {
          const site = bindMantleSite(await getRuntime());
          return site.views["public-products"]();
        });
      });
    },
  }),
});
```

`extend` reuses Mantle's actual router, runtime ref, Auth, bindings, mounts, and
cache boundary. Never call `getRuntime()` synchronously from the extension
factory; call it inside a request or lifecycle callback.

Use `bindings` to augment conventional adapters. Use public low-level exports
from `@aotter/mantle/runtime` and `@aotter/mantle/cloudflare` when the Worker
architecture genuinely needs full composition, scheduled/queue behavior, or
different binding ownership. Copy the version-matched low-level fixture as a
starting recipe; never import private source paths or create parallel
D1/KV/Auth/OAuth/MCP/cache stacks.

## Boundaries

- Public reads go through Views; do not add a Schema-level REST flag.
- Mutations go through runtime use cases/Procedures; do not write Mantle-owned
  D1 tables or KV keys directly.
- Keep Schema, Procedure, UI field names, and fixed option values aligned.
- Put secrets in Cloudflare's secret store, not manifests or `wrangler.jsonc`.
- Use only manifest grammar accepted by the installed version; diagnostics
  include a code and suggestion. Read the shipped `docs/design-atoms.md` when
  unsure.
- Add indexes only for measured query paths. Run `pnpm check:indexes` or
  `mantle-harness indexes --require-public` with crowded data.
- Do not globally cache dynamic reads. Verify explicit public cache HIT/MISS
  and `private, no-store` for auth, API, MCP, redirects, and errors.

Show endpoint examples and visually verify UI changes before claiming done.
