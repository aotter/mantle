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

All thirteen packages share a single version and are published together, so mixed
versions across `@aotter/mantle*` are never a supported combination. Pin the
version you install and upgrade the whole set at once.

## 0.1.5 — in preparation

`mantle generate` now assembles a blank, editable full site by default for
Cloudflare Workers or ChatGPT Sites. `--features` positively selects a smaller
composition; Spec-only needs no host. The first run declares exact matching
dependencies, and a second run after installation completes the project.
Existing directly authored applications retain their compile path. Saved
choices and user-owned files survive reruns, while `--check` reports drift
without writing. On Sites, review and apply append-only D1 migrations before
running code that expects the new Schema. The new Sites worker trusts identity
only behind the Sites dispatcher and does not expose a separate `workers.dev`
URL.

Reviewed Sites unique-index tuple replacement can now generate an immutable
SQL migration with source/target fingerprints, checksum and an explicit report.
Local D1 duplicate preflight fails before writing files; production D1 still
enforces the new constraint when the reviewed migration is applied. Runtime-
managed CF boot continues to reject uniqueness changes without a reviewed
artifact path.

The owner-only Developer Console can inspect live Schema entries and run
declared Views on demand through guarded Admin routes. Its HTTP and MCP lists
link to the owning declarations. UI action placement is no longer shown as a
Procedure-to-Schema execution path; custom handlers and native SQL Views state
when their data relationships cannot be inferred from the Manifest.

Ref Procedures can now group insert, update and delete operations across
Schemas with `ctx.store.write`. D1 and Bun commit the group or roll it
back, including when the last conditional write finds a stale version. Other
adapters must explicitly implement the optional capability before using it.

Cloudflare Cron Triggers now target ordinary Procedures through `source.kind:
schedule`. The generated runtime plan records each schedule, while Wrangler
registration remains application-owned. Scheduled calls have no user or staff
authority, carry a stable retry key, and pass through Procedure validation and
authorization. D1-backed Workers retain owner-only run observations
for 30 days; the Console distinguishes a declaration from registration and
observed executions. Managed SQLite hosts must apply the append-only
`0007-schedule-run-observations` migration before boot. Other hosts do not
register schedules.

Schemas may declare a `ttl` date-time policy. D1 and Bun hide expired entries
from semantic reads and declarative Views before any deletion. Physical cleanup
is an explicit bounded sweep, previewed by default and resumable by cursor;
there is no automatic bulk deletion when a policy is introduced or shortened.
Native SQL Views and shared View caches are rejected for TTL Schemas because
they cannot guarantee the expiry boundary. Cloudflare public routes that can
include TTL content use `no-store` so a cached page cannot outlive its entries.

Agents installed through `npx skills add aotter/mantle` must still inspect the
target project's actual SDK version. Published 0.1.4 packages do **not**
support the new project flags; 0.1.5-alpha.1 does. Use the installed docs and
upgrade all selected packages together. The bootstrap skill remains a small directory,
not a repository clone.

## 0.1.4 — 2026-09-24

0.1.4 repairs the published consumer path without changing the Manifest
grammar. Pin every selected `@aotter/mantle*` package to `0.1.4`, refresh the
lockfile, then rerun `mantle generate` and `mantle skills` with their `--check`
commands. Read the handbook and skills from that installed version.

**ChatGPT Sites reference.** The 0.1.3 reference omitted the
`_mantle_boot_state.store_instance_id` column required by the runtime, which
could make deployed runtime routes return 500. The reference now adds the
append-only `drizzle/0003_store_instance_id.sql` migration. If your project
was copied from that reference, carry the new migration forward and apply
pending D1 migrations **before** deploying updated code; do not edit a
migration already applied. Repeated builds now clear `dist` so removed SQL
files cannot remain in the deployment artifact. The Sites guide also shows
how to mount an HTTP Trigger, identifies the browser and MCP owner workflows,
and names its integration chapter `docs/handbook/chatgpt-sites/`.

**Agent installation.** `npx skills add aotter/mantle` installs the small
`mantle` bootstrap skill; the installed npm package supplies version-matched
instructions and docs. The skill now checks the application's installed
version before reading them. Superseded Starter decisions are marked as
history: no `mantle-starters/v0.1.4` tag or `mantle create` command is needed
to author a new application.

## 0.1.3 — 2026-09-23

0.1.3 tightens the contract between Manifests, generated TypeScript, agent
skills and the optional Admin surface. To upgrade from 0.1.2, pin every
selected `@aotter/mantle*` package to `0.1.3`, refresh the lockfile, then run
`mantle generate`, `mantle skills` and the matching `--check` commands.

**Private and typed reads.** Views may use `surface: internal` to stay out of
REST, MCP, WebMCP, OpenAPI and Admin while remaining callable from host code.
Generated bindings type declarative View params and rows, expose typed indexed
field reads for Schemas, and can be emitted from an already compiled plan. SQL
Views remain SQLite-native and deliberately return an `unknown` row type.

**Safer View storage and validation.** Public declarative Views over publishing
Schemas always enforce published status. Native entry columns (`id`, `status`,
`version`, `createdAt`, `updatedAt`, `authorId`) are reserved consistently and
may be used in the supported View/index positions. SQL validation is confined
to declared Schema tables, and the local index harness now uses production-
shaped planner and fixture state instead of reporting an artificial pass.

**MCP and authorization.** Tool schemas have agent-shaped inputs and standard
read-only, destructive, open-world and idempotency annotations. Calls carry
expected-version data through optimistic concurrency checks, enforce the
caller gate, and can emit audit records keyed by a declared idempotency input.
OAuth provider extensions, account linking and sign-in-link flows are owned by
the extracted optional `@aotter/mantle-auth` package. Session cache keys bind
to the prepared store identity so replacing D1 cannot revive stale sessions.

**Admin and authoring.** Manifest `uiSchema` can select operational collection
columns/tabs, staff report search/filter/CSV fields and collection or row
actions. Native columns render correctly in lists, and operation dialogs reset
their optimistic-concurrency state between actions. The handbook now starts
with a task-oriented overview, a complete Manifest feature table, typed-query
and Admin-rendering guides, and an explicit skill-install → pinned SDK →
project-skill handoff. The CLI points to those installed, version-matched docs.

**Upgrade note.** Regeneration is required because generated bindings and
projected skills gained APIs and instructions. Applications that declared one
of the newly reserved native column names as business data must rename that
field before upgrading. Backend-specific D1/IndexedDB cost inspectors and
server-side soak budgets remain deferred to
[#1040](https://github.com/aotter/mantle/issues/1040); the conservative local
harness is a preflight, not production cost evidence.

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
authentication and CSRF to the host. [ChatGPT Sites](../chatgpt-sites/index.md) is a
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
