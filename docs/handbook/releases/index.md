---
description: Every stable Mantle release — what it contains, what it requires, and what changed since the previous stable.
---
# Releases

Mantle publishes to npm under the `@aotter/*` scope. A **stable** release is a
plain `X.Y.Z` version on the `latest` dist-tag; it is the only kind of release
covered by this chapter and the only kind intended for production use.

```sh
npm install @aotter/mantle
```

Prereleases exist so a stable can be prepared in the open, and they are not
covered here: `alpha` is cut from `develop` and may break anything, `rc` is a
stable candidate cut from `main`. Installing a prerelease means opting into an
exact version, not a channel. [GitHub Releases](https://github.com/aotter/mantle/releases)
is the canonical, immutable change history; this chapter is the narrative one.

All ten packages share a single version and are published together, so mixed
versions across `@aotter/mantle*` are never a supported combination. Pin the
version you install and upgrade the whole set at once.

## 0.1.2 — 2026-09-21

The first stable release, and Mantle's first public one. Everything before it
was an internal prerelease; there is no earlier stable to upgrade from and no
migration path to follow.

**Requires** Node.js 22 or newer. Cloudflare Workers is the supported host.

**The manifest engine.** Describe data, queries, actions and triggers as four
atoms — [Schema](../reference/schema.md), [View](../reference/view.md),
[Procedure](../reference/procedure.md) and [Trigger](../reference/trigger.md) —
in YAML under `manifests/`. `mantle generate` parses, links and compiles them
into `.mantle/generated/mantle.ts`: a sealed execution plan, TypeScript types
and typed bindings. Fingerprint or version mismatches between a generated plan
and the installed packages fail immediately and ask you to regenerate.

**Storage.** Each Manifest Schema becomes one native SQLite/D1 table. Authored
fields keep their exact names as columns; Mantle's row envelope adds
`_mantle_id`, `_mantle_status`, `_mantle_version`, `_mantle_author_id`,
`_mantle_created_at` and `_mantle_updated_at`. Generated migration artifacts
cover initial and additive changes; renames, type changes, data transforms and
`uniqueIndexes` tuple changes are a manual rebuild.

**Surfaces.** One contract drives all of them: public REST Views and HTTP
Triggers, server-rendered HTML with Markdown, `llms.txt` and sitemap output, the
Admin console and its prebuilt React SPA, and MCP — anonymous read-only Views at
`/api/mcp`, staff tools at `/api/mcp/staff`, and Admin WebMCP in the browser.
See [HTTP, MCP, CLI and packages](../reference/surface.md) for the full list.

**Hosting.** `createMantleWorker` assembles the conventional Cloudflare Worker:
D1 and assets bindings, Better Auth 1.7 (social providers, email OTP, magic
link, passkey), Admin, MCP, Web and R2 media uploads. The Bun and Vercel
adapters are experimental, cover public Views and HTTP Triggers only, and leave
authentication and CSRF to the host. [ChatGPT Sites](../sites/index.md) is a
first-class integration with a runnable reference.

**Agents.** `mantle skills` projects the installed package's skills into
`.agents/skills/mantle-*` and `.claude/skills/mantle-*`, so an agent working in
your project reads instructions matched to the version you installed. `--check`
detects drift without writing.

**Not yet covered.** Stable does not carry a published latency budget,
production-traffic measurement or a soak window; those acceptance items are
tracked for 0.1.3 in [#962](https://github.com/aotter/mantle/issues/962). The
Bun and Vercel adapters may change in a minor release.

## Source

- [`CHANGELOG.md`](../../../CHANGELOG.md)
- [`docs/release-process.md`](../../../docs/release-process.md)
- [`.github/workflows/release.yml`](../../../.github/workflows/release.yml)
- [`scripts/release-tag-order.mjs`](../../../scripts/release-tag-order.mjs)
