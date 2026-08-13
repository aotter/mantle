# @aotter/mantle

Umbrella entry for the Mantle SDK — a manifest-driven CMS for Cloudflare Workers, built around a 4-atom YAML model (Schema / View / Procedure / Trigger) where agents write config and the runtime carries the complexity.

> Mantle is prerelease software. Use this package's `package.json` as the exact
> installed version; APIs may change between prereleases until v0.1.0.

## Install

```bash
npm install @aotter/mantle@alpha
# or
pnpm add @aotter/mantle@alpha
```

## What's inside

Adopters install this one package and import from subpaths. Sub-packages remain individually installable for tooling / alt-adapter authors.

| Subpath | Re-exports |
|---|---|
| `@aotter/mantle/spec` (or root) | Manifest grammar, validators, JSON-Schema→Zod, diagnostic catalog (no env / no IO) |
| `@aotter/mantle/runtime` | Hexagonal runtime: domain ports, use cases, infrastructure helpers (no adapter deps) |
| `@aotter/mantle/runtime/testing` | Node-only crowded SQLite planner and HTTP sampling helpers |
| `@aotter/mantle/cloudflare` | Cloudflare Workers adapter — D1, Workers Cache, R2, Better Auth, MCP via `@cloudflare/workers-oauth-provider` |
| `@aotter/mantle/admin-ui` | Pre-built React 19 admin SPA bundle |

```ts
import { parseManifestsOrThrow } from "@aotter/mantle/spec";
import { createCmsRuntime } from "@aotter/mantle/runtime";
import { mountServerEndpoints } from "@aotter/mantle/cloudflare";
```

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

`mantle generate` validates `./manifests/site.yaml`, then writes the
parsed manifest module and handler declarations to `.mantle/generated/`.
It does not sync skills, update packages, style, provision, or deploy.
When manifests declare Views or Procedures, the generated `site.ts` also exports
`bindMantleSite(runtime)`: its `views` and `procedures` keys, inputs, and outputs
come from those manifests, while diagnostics still come from the runtime use
cases.
Dynamic `runtime.viewsByName` access remains available for low-level code.

```ts
const site = bindMantleSite(runtime);
const notes = await site.views["published-notes"]();
const result = await site.procedures["expire-order"](
  { orderId },
  { user: null, staff: null, env },
);
```

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
import { manifest } from "../.mantle/generated/site.js";

export default createMantleWorker({ manifest });
```

`createMantleWorker` owns conventional D1/assets bindings, Auth, Admin,
manifest REST/HTTP routes, OAuth, MCP, cache safety, and rejection-safe
per-isolate boot. Use its single `extend` seam for application handlers and
new Hono routes; use the public low-level exports when the deployment does not
fit the conventional binding or lifecycle contract.

Extensions may add routes but may not replace Core surfaces. These paths are
reserved:

- `/admin` and `/admin/*`
- `/api/auth` and `/api/auth/*`
- `/api/views` and `/api/views/*`
- `/oauth` and `/oauth/*`
- `/mcp` and `/mcp/*`
- `/.well-known/oauth*`
- `/favicon.svg`
- global `*` and `/*` handlers

A custom Auth factory's `basePath` and exact manifest-owned method/path pairs
are also reserved at assembly. Static literal conflicts fail TypeScript during
the consumer build. Computed paths cannot be proven statically, so the facade
checks Hono's assembled route table and fails closed before serving requests.
There is no standard-route override option.

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
| Cloudflare Workers | ✅ shipping |

The `mantle-runtime` package never imports Cloudflare-specific types — adapters bind concrete drivers (D1 / R2) to the runtime's `domain/port/*` interfaces, so adding a new adapter is a port-implementation exercise, not a refactor.

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
