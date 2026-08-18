# @aotter/mantle

Umbrella entry for the embeddable Mantle SDK — a manifest-driven application
engine built around a 4-atom YAML model (Schema / View / Procedure / Trigger)
where agents write config and the runtime carries the complexity.

> Mantle is prerelease software. Use this package's `package.json` as the exact
> installed version; APIs may change between prereleases until v0.1.0.

## Install

```bash
npm install @aotter/mantle@alpha
# or
pnpm add @aotter/mantle@alpha
```

## What's inside

The umbrella provides Spec and Runtime by default. Install an optional package
before importing its matching Web, Admin, Bun, Vercel, Cloudflare, or Admin UI
subpath. Every sub-package also remains directly installable.

| Subpath | Re-exports |
|---|---|
| `@aotter/mantle/spec` (or root) | Manifest grammar, validators, JSON-Schema→Zod, diagnostic catalog (no env / no IO) |
| `@aotter/mantle/runtime` | Hexagonal runtime: domain ports, use cases, infrastructure helpers (no adapter deps) |
| `@aotter/mantle/runtime/testing` | Node-only crowded SQLite planner and HTTP sampling helpers |
| `@aotter/mantle/codegen` | Pure linked manifests → typed `bindMantle` module emitter (no IO) |
| `@aotter/mantle/web` | Optional HTML, Markdown, `llms.txt`, sitemap, SEO, and preview composition (no routes or platform deps) |
| `@aotter/mantle/admin` | Optional Admin API, auth routes, and static-asset composition |
| `@aotter/mantle/bun` | Bun adapter — caller-owned `bun:sqlite` and Web-standard View/Trigger transport |
| `@aotter/mantle/vercel` | Vercel Functions adapter — injected durable storage and platform `waitUntil` |
| `@aotter/mantle/vercel/libsql` | Optional application-owned Turso/libSQL driver |
| `@aotter/mantle/cloudflare` | Cloudflare Workers adapter — D1, Workers Cache, R2, Better Auth, MCP via `@cloudflare/workers-oauth-provider` |
| `@aotter/mantle/admin-ui` | Pre-built React 19 admin SPA bundle |

```ts
import { linkManifestSet, parseManifestSources } from "@aotter/mantle/spec";
import { bootMantleRuntime, compileRuntimePlan } from "@aotter/mantle/runtime";
import { createMantleWeb } from "@aotter/mantle/web";
import { mountRuntimeEndpoints } from "@aotter/mantle/cloudflare";
```

The umbrella installs only Spec and Runtime. Web, Admin, Admin UI, Bun,
Vercel, and Cloudflare are optional peers; install only the subpaths selected
by the application.

The package also installs `mantle` and `mantle-harness`:

```bash
pnpm exec mantle generate
pnpm exec mantle generate --check
pnpm exec mantle skills
pnpm exec mantle skills --check
pnpm exec mantle update --ref <immutable-starter-ref>
pnpm exec mantle-harness indexes --require-public
pnpm exec mantle-harness http --base-url http://127.0.0.1:8787 --route page=/en/example
```

`mantle generate` validates and compiles `./manifests/`, then writes one typed
`.mantle/generated/mantle.ts` module. It performs no Admin asset installation,
skill sync, package update, styling, provisioning, or deployment.
The same pure emitter is available from `@aotter/mantle/codegen` when a host
wants to own parsing and filesystem IO.

```ts
import { createMantle } from "../.mantle/generated/mantle.js";

const mantle = await createMantle({ storage, handlers, ports });
const notes = await mantle.views.publishedNotes();
const result = await mantle.procedures.expireOrder(
  { orderId },
  { user: null, staff: null, env },
);
await mantle.entries.orders.createDraft({ data, authorId: user.id });

// The typed projection never hides the underlying Core runtime.
await mantle.runtime.archive.execute({ id: noteId, ctx });
```

Generated property names are deterministic lower-camel identifiers; calls keep
the authored wire names internally. `createMantle()` eagerly prepares once and
does not cache or retry. Dynamic and platform hosts can keep their own lifecycle,
use generated `bindMantle(runtime)`, or skip code generation and call
`runtime.executeView({ view: "published-notes" })` directly.

`mantle skills` explicitly copies the installed package's `develop`, `plugin`,
`theme`, and `update` skills to matching `.agent/skills/mantle-*` and
`.claude/skills/mantle-*` paths. Both tool layouts receive identical bytes;
`--check` detects drift without writing. Manifest generation never rewrites
agent instructions.

`mantle update` compares the recorded source bundle, a target bundle, and the
local project, then writes `.mantle/update-report.json`. It never applies the
diff. Configure `.mantle/features.json` `registry.bundleBaseUrl` with a URL
containing `{ref}`, or pass `--bundle-base-url` for the alpha.63 bridge. The
report carries the only supported metadata migration; review and apply it
after porting selected upstream changes.

## Conventional Cloudflare Worker

The normal Worker entry delegates Core-owned assembly to the SDK:

```ts
import { createMantleWorker } from "@aotter/mantle/cloudflare";
import { plan } from "../.mantle/generated/mantle.js";

export default createMantleWorker({ plan });
```

`createMantleWorker` owns conventional D1/assets bindings, Auth, Admin,
manifest REST/HTTP routes, OAuth, MCP, cache safety, and rejection-safe
per-isolate boot. Use its single `extend` seam for application handlers and
new Hono routes; use the public low-level exports when the deployment does not
fit the conventional binding or lifecycle contract.

Conventional Auth requires an explicit `MANTLE_AUTH_MODE`: `self-managed`
uses the site's GitHub OAuth credentials, while `hosted` uses a same-origin
Mantle Hosted Auth PKCE client. Missing, invalid, partial, or mixed-mode
configuration keeps public routes available but returns `503 setup_incomplete`
from Auth-owned private routes. Pass `auth: (env) => Auth` only when the site
needs to replace this conventional factory; Core still owns the Auth routes.
The exact bindings and validation rules are in the
[Cloudflare adapter README](../adapters/cloudflare/README.md#conventional-auth).

Extensions may add routes but may not replace Core surfaces. These paths are
reserved:

- `/admin` and `/admin/*`
- `/_mantle` and `/_mantle/*`
- `/api/auth` and `/api/auth/*`
- `/api/views` and `/api/views/*`
- `/oauth` and `/oauth/*`
- `/mcp` and `/mcp/*`
- `/.well-known/oauth*`
- global `*` and `/*` handlers

A custom Auth factory's `basePath` and exact manifest-owned method/path pairs
are also reserved at assembly. Static literal conflicts fail TypeScript during
the consumer build. Computed paths cannot be proven statically, so the facade
checks Hono's assembled route table and fails closed before serving requests.
There is no standard-route override option.

Cloudflare projects may expose an independently installed Admin bundle and the
application's own frontend assets through one native binding:

```toml
[assets]
directory = "./public"
binding = "ASSETS"
```

Declare browser, Admin, and MCP identity once. Multiple renditions are allowed;
keep SVG as the source and add PNG renditions when a target MCP client requires
the baseline raster formats:

```ts
siteDefaults: {
  icons: [
    { src: "/site-icon.png", mimeType: "image/png", sizes: ["64x64"] },
    { src: "/site-icon.svg", mimeType: "image/svg+xml", sizes: ["any"] },
  ],
}
```

Keep both files in the project's `public/` directory. They are one site
identity reused by browser favicons, Admin chrome, and MCP `serverInfo.icons`;
PNG is the compatibility rendition and SVG remains the editable source.

For an uncommon deployment that must own the top-level assembly, use the
embedded [`docs/cloudflare-low-level-composition.md`](docs/cloudflare-low-level-composition.md)
fixture. It composes the same public primitives without importing package
internals or rebuilding Mantle's adapters.

## Getting started

Give the [Mantle repo](https://github.com/aotter/mantle) to a coding agent or
install its agent plugin, then ask it to create a site. The install skill picks
a deterministic bundle from
[`aotter/mantle-starters`](https://github.com/aotter/mantle-starters),
materializes a local project, and verifies it before any provider work.

[Mantle landing](https://mantle.tools) uses the same bundles and continues
through private GitHub repo creation, Cloudflare deployment, and optional paid
hosted auth. Generated repos project Core-owned `mantle:*` skills from their
installed package for repo-local use.

## Agent marketplace install

Install the Mantle Core skill bundle before working on generated repos:

Replace `<installed-version>` with the exact version from this package's
`package.json`. Do not point a versioned consumer at a mutable branch.

```bash
# Claude Code
/plugin marketplace add aotter/mantle@v<installed-version>
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle --ref v<installed-version>
codex plugin add mantle@mantle
```

Cursor and VS Code Copilot can auto-discover the GitHub repo through
`.cursor-plugin/plugin.json` and `.copilot-plugin/plugin.json` after the repo
is cloned or opened.

## Marketplace capability installs

In a generated repo, tell your coding agent:

```txt
Use repo-local mantle:plugin to install <plugin slug or recipe URL> in this repo.
Use repo-local mantle:plugin to update <plugin id> in this repo.
Use repo-local mantle:plugin to remove <plugin id> from this repo.
```

Mantle marketplace entries are agent-installable recipes. They declare the
plugin source, Mantle version range, files/atoms/routes/tools, adapter
requirements, secrets, and checks. The agent applies the recipe through the
Core-owned `mantle:plugin` skill and records it in `.mantle/plugins.json` plus
`.mantle/plugins.lock.json`. There is no `mantle plugin add` CLI yet.

## Adapter targets

| Adapter | Status |
|---|---|
| Bun | ✅ shipping |
| Vercel Functions (Node.js) | ✅ shipping |
| Cloudflare Workers | ✅ shipping |

The `mantle-runtime` package never imports platform-specific types — adapters
bind concrete storage and lifecycle primitives to Core ports, so adding a new
adapter is a port-implementation exercise, not a runtime refactor.

## Documentation

- Embedded docs and agent skills ship inside this npm package for
  generated-site agents:
  - `node_modules/@aotter/mantle/docs/design-atoms.md`
  - `node_modules/@aotter/mantle/docs/api-mcp-authorization.md` (anonymous,
    API-key, paid guard, personal-token, OAuth, REST, and MCP examples)
  - `node_modules/@aotter/mantle/docs/media-uploads.md` (Cloudflare R2 adapter recipe)
  - `node_modules/@aotter/mantle/docs/deferred-lifecycle-queues.md` (versioned
    Queue wiring, retry/DLQ, idempotency, and delivery guarantees)
  - `node_modules/@aotter/mantle/docs/schema-indexes.md` (ordered composite
    JSON-field indexes, D1 query plans, and the safe Procedure SQL helper)
  - `node_modules/@aotter/mantle/docs/performance-harness.md` (crowded SQLite,
    Wrangler-local D1 origin paths and coding-agent guardrails)
  - `node_modules/@aotter/mantle/docs/adr/`
  - `node_modules/@aotter/mantle/skills/develop/SKILL.md`
  - `node_modules/@aotter/mantle/skills/plugin/SKILL.md`
  - `node_modules/@aotter/mantle/skills/theme/SKILL.md`
  - `node_modules/@aotter/mantle/skills/update/SKILL.md`
  - `node_modules/@aotter/mantle/skills/install/SKILL.md`
  - `node_modules/@aotter/mantle/skills/provision/SKILL.md`
- [4-atom manifest model (ADR-0001)](docs/adr/0001-four-atom-manifest-model.md)
- [API and MCP authorization](docs/api-mcp-authorization.md)
- [Deferred lifecycle Queues](docs/deferred-lifecycle-queues.md)
- [Schema indexes on D1](docs/schema-indexes.md)
- [Release process](docs/release-process.md)
- [Source repository](https://github.com/aotter/mantle)
- [Issues](https://github.com/aotter/mantle/issues)

## License

Apache-2.0
