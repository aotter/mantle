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

Recommended path: open the Mantle landing page, pick an archetype/theme, provide or authorize the GitHub owner context, then hand the generated one-line launch command to Claude Code / Cursor / Codex. The command runs `create-mantle launch --session <session-url>`; the short-lived session carries the site name, locales, GitHub owner/admin login, starter choices, and repo intent so the agent can scaffold first and ask content/voice questions after launch.

The older prompt-first path remains available when a launch session is not present: the install Skill asks the right follow-up questions and then runs the scaffolder for you.

Starter source and direct scaffolder usage live in [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters); this repo carries the SDK, runtime, adapter packages, and agent skills.

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

→ **Install a fresh publication/site** — start at [`skills/install/SKILL.md`](skills/install/SKILL.md).
→ **Add a new atom** (Schema / View / Procedure + http Trigger) to an existing starter — start at [`skills/extend/SKILL.md`](skills/extend/SKILL.md).
→ **Finish production deploy** (GitHub repo, Cloudflare dashboard first deploy, OAuth App, Wrangler secrets, smoke) — start at [`skills/provision/SKILL.md`](skills/provision/SKILL.md).

## For humans

End state: a Cloudflare Worker at `https://<your-site>.<your-account>.workers.dev` with:

- `/admin` — React admin SPA, role-gated after sign-in (GitHub / Google / Apple / 30+ social providers, email-OTP, magic-link — adopter picks the methods)
- `/mcp/staff` — staff MCP endpoint, owner/editor agents connect here to edit content
- `/mcp` — end-user/read MCP endpoint for public View tools and future member flows
- `/<locale>/<collection>/<slug>` — per-entry HTML
- `/<locale>/<collection>/<slug>.md` — agent-friendly markdown mirror
- `/<locale>/llms.txt` — per-locale llms.txt index
- public surface in your taste (the v0.1.0 starter ships Hono + hono/jsx + Tailwind)

For a guided install, follow the steps in [`skills/install/SKILL.md`](skills/install/SKILL.md).

## Packages

| Package | Role |
|---|---|
| `@aotter/mantle-spec` | Spec engine — types + parse + validate + diagnostics + JSON-Schema → zod converter + CLI. Zero env deps. |
| `@aotter/mantle-runtime` | Runtime engine — dispatcher + entry-writer + view executor + content-ops + render + MCP. Defines required adapter ports plus optional feature ports. |
| `@aotter/mantle-admin-ui` | Admin SPA — React 19 + Vite + Tailwind v4. In development; ships in v0.1.0. |
| `@aotter/mantle-cloudflare` | Cloudflare Workers adapter. Implements ports against D1 / KV / ASSETS. Ships `createAuth()` — the Better Auth-backed *default* implementation of the SDK's `Auth` contract (see [ADR-0014](docs/adr/0014-auth-better-auth-and-multi-tenant-mcp.md) § "Auth as contract, Better Auth as default"); replace by passing your own `Auth` instance. |
| `@aotter/mantle-netlify` | **Stub.** Coming v0.2. Engineering forcing function: keeps `mantle-runtime` adapter-agnostic. |

## Starters

Starter taxonomy. v0.1.0 ships the available rows; the rest are roadmap so agents can pick the closest fit and either fall back to `blank` or wait for the family to land.

End-user starters live in the [`aotter/mantle-starters`](https://github.com/aotter/mantle-starters) monorepo. The install Skill invokes the scaffolder distributed by that repo, which downloads a pinned source tarball, merges `_common/` + `<archetype>/` + optional theme overlays, and initializes a fresh user-owned Git repo without `origin` set. See the [starter README](https://github.com/aotter/mantle-starters#readme) for the current archetype/theme keys, direct invocation, and source layout. Premium / per-customer starters live in the private sibling [`aotter/mantle-starters-premium`](https://github.com/aotter/mantle-starters-premium).

| Starter | Family | Status | What |
|---|---|---|---|
| [`mantle-starters/presence`](https://github.com/aotter/mantle-starters/tree/develop/presence) | presence | available | Brand / service presence site with pages and a contact surface. |
| [`mantle-starters/publication`](https://github.com/aotter/mantle-starters/tree/develop/publication) | publication | available | Owner-published content — landing pages, articles, docs-lite, project updates, basic contact form. Multi-locale posts/pages, Cloudflare Turnstile, per-slug `.md` mirror, llms.txt, SEO/AEO. |
| [`mantle-starters/intake`](https://github.com/aotter/mantle-starters/tree/develop/intake) | intake | available | Publication shape plus structured `leads` Schema, staff-only lead View, and anonymous lead submission. |
| [`mantle-starters/transaction`](https://github.com/aotter/mantle-starters/tree/develop/transaction) | transaction | available | Small catalog + cart + checkout/order workflow on Cloudflare primitives; sized for low-volume direct commerce. |
| [`mantle-starters/blank`](https://github.com/aotter/mantle-starters/tree/develop/blank) | — | available | Headless API + MCP only. Drop-in backend for consumers bringing their own frontend (Next.js / Astro / native / partner). |
| [`mantle-starters/reservation`](https://github.com/aotter/mantle-starters/tree/develop/reservation) | reservation | roadmap note | Routes users to `intake` as the v0.1 holding pattern until booking primitives land. |
| `community` | community | roadmap | Member posts, comments, likes, reactions, moderation queue, agent-assisted moderation. Blocks on end-user auth. |
| `membership` | membership | roadmap | Private posts, paid newsletters, portals, or fan-club style content. Blocks on end-user auth + row-level visibility grammar + provider-backed entitlements. |

## Repo conventions

- [`CONTRIBUTING.md`](CONTRIBUTING.md) — workflow contract for AI + human contributors (branch prefixes, commit shape, PR template, architecture gates).
- [`CLAUDE.md`](CLAUDE.md) — in-repo conventions for agents writing code (PR base branch, manifest grammar lock, ADR discipline, clean-architecture rules).
- [`docs/release-process.md`](docs/release-process.md) — release + publish discipline (channels, dist-tags, deprecation policy, pre-publish checks).
- [`CHANGELOG.md`](CHANGELOG.md) — versioned change log.

## License

Apache 2.0. See [`LICENSE`](LICENSE).
