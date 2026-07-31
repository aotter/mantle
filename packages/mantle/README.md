# @aotter/mantle

Umbrella entry for the Mantle SDK — a manifest-driven CMS for Cloudflare Workers, built around a 4-atom YAML model (Schema / View / Procedure / Trigger) where agents write config and the runtime carries the complexity.

> v0.1.x is in development. APIs may change between minor versions.

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
| `@aotter/mantle/cloudflare` | Cloudflare Workers adapter — D1, KV, R2, Better Auth, MCP via `@cloudflare/workers-oauth-provider` |
| `@aotter/mantle/admin-ui` | Pre-built React 19 admin SPA bundle |

```ts
import { parseManifestsOrThrow } from "@aotter/mantle/spec";
import { createCmsRuntime } from "@aotter/mantle/runtime";
import { mountServerEndpoints } from "@aotter/mantle/cloudflare";
```

## Getting started

Give the [Mantle repo](https://github.com/aotter/mantle) to a coding agent or
install its agent plugin, then ask it to create a site. The install skill picks
a deterministic bundle from
[`aotter/mantle-starters`](https://github.com/aotter/mantle-starters),
materializes a local project, and verifies it before any provider work.

[Mantle landing](https://mantle.tools) uses the same bundles and continues
through private GitHub repo creation, Cloudflare deployment, and optional paid
hosted auth. Generated repos vendor Core-owned `mantle:*` skills from this
package for repo-local use.

## Agent marketplace install

Install the Mantle Core skill bundle before working on generated repos:

```bash
# Claude Code
/plugin marketplace add aotter/mantle
/plugin install mantle@mantle

# Codex
codex plugin marketplace add aotter/mantle --ref develop
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
| Netlify | 📋 README stub — engineering forcing function for v0.2 (`@aotter/mantle-netlify`) |

The `mantle-runtime` package never imports Cloudflare-specific types — adapters bind concrete drivers (D1 / KV / R2) to the runtime's `domain/port/*` interfaces, so adding a new adapter is a port-implementation exercise, not a refactor.

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
  - `node_modules/@aotter/mantle/docs/adr/`
  - `node_modules/@aotter/mantle/skills/develop/SKILL.md`
  - `node_modules/@aotter/mantle/skills/plugin/SKILL.md`
  - `node_modules/@aotter/mantle/skills/theme/SKILL.md`
  - `node_modules/@aotter/mantle/skills/update/SKILL.md`
  - `node_modules/@aotter/mantle/skills/install/SKILL.md`
  - `node_modules/@aotter/mantle/skills/provision/SKILL.md`
- [Repo](https://github.com/aotter/mantle)
- [4-atom manifest model (ADR-0001)](https://github.com/aotter/mantle/blob/develop/docs/adr/0001-four-atom-manifest-model.md)
- [API and MCP authorization](https://github.com/aotter/mantle/blob/develop/docs/api-mcp-authorization.md)
- [Deferred lifecycle Queues](https://github.com/aotter/mantle/blob/develop/docs/deferred-lifecycle-queues.md)
- [Schema indexes on D1](https://github.com/aotter/mantle/blob/develop/docs/schema-indexes.md)
- [Release process](https://github.com/aotter/mantle/blob/develop/docs/release-process.md)
- [Issues](https://github.com/aotter/mantle/issues)

## License

Apache-2.0
