# mantle

[![CI](https://github.com/aotter/mantle/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/aotter/mantle/actions/workflows/ci.yml)
[![License: Apache-2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](./CONTRIBUTING.md)
[![Status: Experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#status)

> ⚠️ **Experimental — co-built with AI**
>
> mantle is co-developed with AI coding agents (Claude Code) and is
> currently in **0.0.x / pre-1.0**. Treat everything here as experimental:
> APIs, manifests, schema shapes, and runtime behavior **can break between
> any two commits** without notice or migration path. Do not deploy this
> for anything you cannot afford to rebuild from scratch.
>
> Review the code, run your own tests, and verify generated content before
> trusting it. Pull requests welcome; bug reports especially welcome.

**Build your content model by prompting, not configuring.**

Agent-native headless CMS where AI agents are first-class authors — locked-grammar manifests, structured JSON diagnostics, and static `.md` mirrors every agent can crawl without auth. Most CMSes treat AI as a content editor; mantle treats it as the developer.

## Try it cold

If a user hands you this repo and says "let's try Mantle" or "what can we
build?", read [`skills/install/SKILL.md`](skills/install/SKILL.md). Pick the
closest `blank`, `presence`, `intake`, `publication`, `transaction`,
`reservation`, or `community` bundle from
[`aotter/mantle-starters`](https://github.com/aotter/mantle-starters),
materialize it into a new local project, then install, validate, typecheck, and
start the preview. Do not use this SDK checkout as the application.

[Mantle landing](https://mantle.tools) runs the same starter-bundle flow and
continues through private GitHub repo creation, Cloudflare deployment, and
optional paid hosted auth. Local cold start stops before those provider
operations.

Generated projects include the `mantle` authoring CLI from
`@aotter/mantle-spec`: `validate`, `introspect`, `emit-openapi`, and
`emit-types`. The umbrella package also ships `mantle-harness` for crowded
SQLite index coverage and live Worker/API/page sampling; see
[`docs/performance-harness.md`](docs/performance-harness.md).

> **Prerelease.** This repo is a clean rebuild of the v0.0.x POC. Until v0.1.0 tags, the API surface is in flux — alpha and beta releases may introduce breaking changes. Current published versions and channel policy are documented in [`docs/release-process.md`](docs/release-process.md). Track the rebuild plan at [#1](https://github.com/aotter/mantle/issues/1).

## Part of Mantle

**Mantle** (**C**onfig **L**anguage for **A**pps & **M**odeling) is Aotter's family of agent-native config languages. Two halves, one thesis:

- **Apps (OLTP)** — `mantle` (this repo) and future apps. Build a content-driven web service by declaring atoms in YAML; the runtime ships dispatcher + auth + render + MCP for free.
- **Modeling (OLAP)** — [`aotter-mantle`](https://github.com/aotter/aotter-mantle) (sibling project). Turn enterprise Excel/CSV files into Kimball-modeled DuckLake warehouses by declaring star-schema configs in YAML.

> Note: the two halves intentionally live as separate repos under the `aotter` org — different release cadences, different licensing posture.

The shared spirit: **agents write config, runtime carries the complexity**. Hard problems — schema validation, cache invalidation, OAuth, locale canonicalization, JSON Schema → zod conversion, transactional state — live in the runtime, where they're written once by people who understand them. The authoring surface is YAML the agent fills in, where mistakes are caught by structured diagnostics before they become production failures. Non-coders get AI leverage safely; the runtime is the load-bearing part.

This repo is the OLTP side of that thesis applied to web content.

## For AI agents

You're an agent helping a (likely non-technical) user install or extend a mantle project.

Before working:

- Match the installed Mantle version and use its embedded docs under
  `node_modules/@aotter/mantle/docs/`; do not guess from the latest branch.
- For "let's try it" requests, materialize the closest starter bundle before
  proposing custom code.
- Cloudflare deployment is the primary production path.
- Free self-hosted auth requires the site owner to configure the GitHub OAuth
  App, provider secrets, and related operations.
- [Mantle landing](https://mantle.tools) also offers paid hosted auth for
  owners who do not want to operate provider configuration and auth
  infrastructure.

→ **Install a fresh publication/site** — start at [`skills/install/SKILL.md`](skills/install/SKILL.md).
→ **Work inside an existing project** — start at [`skills/develop/SKILL.md`](skills/develop/SKILL.md).
→ **Install a repeatable marketplace capability** — start at [`skills/plugin/SKILL.md`](skills/plugin/SKILL.md).
→ **Adjust brand and visual direction** — start at [`skills/theme/SKILL.md`](skills/theme/SKILL.md).
→ **Check SDK / starter / plugin drift** — start at [`skills/update/SKILL.md`](skills/update/SKILL.md).
→ **Finish production deploy** (GitHub repo, Cloudflare dashboard first deploy, OAuth App, Wrangler secrets, smoke) — start at [`skills/provision/SKILL.md`](skills/provision/SKILL.md).

The `mantle:*` namespace is owned by `@aotter/mantle`. Generated starters
vendor Core workflow skills pinned to their starter ref for offline use.
Those skills may include updater compatibility guidance, but the installed
package version and its embedded docs remain the runtime/API contract.
`.mantle/*` launch files and plugin recipes are project context, not another
contract.

### Install Mantle Core skills

Install the Mantle agent plugin to create or continue sites. Generated starter
repos also vendor the Core workflow skills locally; use those for project
workflow and the installed package docs for SDK behavior.

**Claude Code**

```bash
/plugin marketplace add aotter/mantle
/plugin install mantle@mantle
```

**Codex**

```bash
codex plugin marketplace add aotter/mantle --ref develop
codex plugin add mantle@mantle
```

**Cursor**

Cursor can auto-discover this repo through `.cursor-plugin/plugin.json` after
the repo is cloned. If auto-discovery does not pick it up, open Cursor
Settings -> Plugins, paste `https://github.com/aotter/mantle`, and add Mantle.

**VS Code + GitHub Copilot**

Copilot can auto-discover this repo through `.copilot-plugin/plugin.json` after
the repo is cloned or opened.

| Agent | Status | Install method |
|---|---|---|
| Claude Code | supported | `/plugin marketplace add aotter/mantle` then `/plugin install mantle@mantle` |
| Codex | supported | `codex plugin marketplace add aotter/mantle --ref develop` then `codex plugin add mantle@mantle` |
| Cursor | supported | Auto-discovery via `.cursor-plugin/plugin.json` |
| VS Code + GitHub Copilot | supported | Auto-discovery via `.copilot-plugin/plugin.json` |

### Marketplace capability installs

Tell your coding agent:

```txt
Use repo-local mantle:plugin to install <plugin slug or recipe URL> in this repo.
```

Update or remove an installed capability the same way:

```txt
Use repo-local mantle:plugin to update <plugin id> in this repo.
Use repo-local mantle:plugin to remove <plugin id> from this repo.
```

A Mantle marketplace entry must be agent-installable: it names the plugin,
Mantle version range, source package or recipe URL, files/atoms/routes/tools it
will add, adapter capabilities, required secrets, and checks. The agent reads
that entry, plans the diff, applies the declared files, updates
`.mantle/plugins.json` and `.mantle/plugins.lock.json`, then runs
`pnpm validate` and `pnpm typecheck`.

There is no `mantle plugin add` CLI yet. The current install surface is the
Core-owned `mantle:plugin` skill plus deterministic plugin recipes.

## For humans

Core surfaces on a Cloudflare Worker at
`https://<your-site>.<your-account>.workers.dev`:

- `/admin` — React admin SPA, role-gated after sign-in (GitHub / Google / Apple / 30+ social providers, email-OTP, magic-link — adopter picks the methods)
- `/mcp/staff` — staff MCP endpoint, owner/editor agents connect here to edit content
- `/mcp` — end-user/read MCP endpoint for public View tools and future member flows
- public surface in your taste (the v0.1.0 starter ships Hono + hono/jsx + Tailwind)

Public render routes are opt-in consumer wiring. When a project registers
`mountPublicRoutes`, matching templates, and a `publicPathResolver`, the SDK
can expose `/<locale>/<collection>/<slug>`, its `.md` mirror,
`/<locale>/llms.txt`, and `/sitemap.xml`. Generated projects document the
routes they actually mount; Mantle does not publish every Schema by default.

For a guided install, follow the steps in [`skills/install/SKILL.md`](skills/install/SKILL.md).

## Packages

| Package | Role |
|---|---|
| `@aotter/mantle-spec` | Spec engine — types + parse + validate + diagnostics + JSON-Schema → zod converter + CLI. Zero env deps. |
| `@aotter/mantle-runtime` | Runtime engine — dispatcher + entry-writer + view executor + content-ops + render + MCP. Defines required adapter ports plus optional feature ports. |
| `@aotter/mantle-admin-ui` | Admin SPA — React 19 + Vite + Tailwind v4. In development; ships in v0.1.0. |
| `@aotter/mantle-cloudflare` | Cloudflare Workers adapter. Implements ports against D1 / KV / ASSETS. Ships `createAuth()` — the Better Auth-backed *default* implementation of the SDK's `Auth` contract (see [ADR-0014](docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md) § "Auth as contract, Better Auth as default"); replace by passing your own `Auth` instance. |
| `@aotter/mantle-netlify` | **Stub.** Coming v0.2. Engineering forcing function: keeps `mantle-runtime` adapter-agnostic. |

Auth and hosted-identity boundaries are documented in
[`docs/auth-hosting-model.md`](docs/auth-hosting-model.md). Free Mantle
sites can self-host supported login methods; Mantle Platform can offer
hosted identity, email, and entitlement-backed convenience without
owning a generated site's local grants or member records.

## Starters

Starter taxonomy. Mantle landing fetches `provision-bundles/<type>.json` from [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters), substitutes launch facts, commits the repo, and connects Cloudflare Workers CI when possible.

The starter repo owns blank source, small type overlays, vendored Kiwa source, and deterministic provision bundles. Theme selection is not a first-run path; agents continue from the generated repo and the after-launch handoff shown by landing.

Generated repos carry vendored copies of Core-owned `mantle:*` skills from
`@aotter/mantle`, including `mantle:plugin` for marketplace capability work.

| Starter | Family | Status | What |
|---|---|---|---|
| [`mantle-starters/blank`](https://github.com/aotter/mantle-starters/tree/develop/blank) | blank | available | Headless API + MCP only. Drop-in backend for consumers bringing their own frontend. |
| [`overlays/presence`](https://github.com/aotter/mantle-starters/tree/develop/overlays/presence) | presence | available | Small public presence and contact intent. |
| [`overlays/intake`](https://github.com/aotter/mantle-starters/tree/develop/overlays/intake) | intake | available | Structured submission and intake workflow intent. |
| [`overlays/publication`](https://github.com/aotter/mantle-starters/tree/develop/overlays/publication) | publication | available | Pages, posts, docs-lite, project updates, and contact flow atoms. |
| [`overlays/transaction`](https://github.com/aotter/mantle-starters/tree/develop/overlays/transaction) | transaction | available | Small catalog/order workflow intent; payment/provider details remain post-launch work. |
| [`overlays/reservation`](https://github.com/aotter/mantle-starters/tree/develop/overlays/reservation) | reservation | available | Booking/request intent; provider-specific fulfillment remains post-launch work. |
| [`overlays/community`](https://github.com/aotter/mantle-starters/tree/develop/overlays/community) | community | available | Member/community intent with moderation and participation atoms. |

## Repo conventions

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow contract for AI + human contributors (branch prefixes, commit shape, PR template, architecture gates).
- [`CLAUDE.md`](CLAUDE.md) — in-repo conventions for agents writing code (PR base branch, manifest grammar lock, ADR discipline, clean-architecture rules).
- [`docs/release-process.md`](docs/release-process.md) — release + publish discipline (channels, dist-tags, deprecation policy, pre-publish checks).
- [`CHANGELOG.md`](CHANGELOG.md) — versioned change log.

## License

Apache 2.0. See [`LICENSE`](LICENSE).
