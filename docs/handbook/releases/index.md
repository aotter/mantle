---
description: Every Mantle release line — what 0.2.0 changes, and what each stable 0.1.x release contained.
---
# Releases

Mantle publishes to npm under the `@aotter/*` scope. A **stable** release is a
plain `X.Y.Z` version on the `latest` dist-tag and is the only kind intended
for production. Prereleases (`alpha`, `rc`) let a release be prepared in the
open; installing one means choosing an exact version, not a channel.
[GitHub Releases](https://github.com/aotter/mantle/releases) is the canonical
change history; this page is the narrative one.

From 0.2.0, Mantle is two packages, `@aotter/mantle` and `@aotter/mantle-ui`,
published together at one version: the 0.1.x `-spec`, `-runtime`,
`-cloudflare`, `-auth`, `-admin`, `-mcp`, `-web` and other packages fold into
subpaths of `@aotter/mantle`, and `@aotter/mantle-admin-ui` into
`@aotter/mantle-ui/admin`. Pin every one you use to the
same exact version and upgrade them together.

## 0.2.0 — in preparation

0.2.0 replaces 0.1.x's grammar and composition; no 0.1.5 was released. It
breaks every consumer, and `docs/upgrade-0.1-to-0.2.md` in the package is the
guide for moving a project by hand.

- **Manifests are `cms.mantle.aotter.net/v2`.** Views are one SQL `SELECT` and
  Procedures are SQL statements or a `ref`, in PostgreSQL syntax. The builtin
  handlers, the Filter AST, `params`, `$ctx` references and `x-mantle-bind` are
  gone; Schemas gain `checks`, and `searchableFields` becomes full-text search.
- **One Store.** Every read and write goes through Store, which adds caller
  scope, TTL and published-only to every statement, and an optimistic lock
  where the caller passes one; a write
  is all or nothing.
- **The service is the application's.** `createMantle(service, …)` replaces
  `createMantleWorker`, and the first `mantle generate` writes the Cloudflare
  preset (`src/service.ts`, `src/index.ts`, `wrangler.jsonc`) once. `--host` is
  gone; other hosts use `@aotter/mantle/d1` with their own driver.
- **Mantle never owns your users.** A `CallerResolver` turns a request into a
  `Caller`; identity is `mantle` (Better Auth), `custom` or `none`. Core creates
  no auth tables.
- **Storage converges to the plan** at boot: additions are applied, unsafe
  changes are refused with a diagnostic, nothing is dropped, and there are no
  migration files.
- **Schedules are POSIX cron**; `toCloudflareCron` translates them for Wrangler.
- **MCP tools come from Views and Procedures only.** Staff tools are at
  `/mcp/staff` for an OAuth client; Admin's WebMCP runs the same tools on
  Admin's own routes.
- **The CLI is `mantle generate`** and `mantle generate --check`. `validate`,
  `emit-openapi`, `skills` and `mantle-harness` are removed.
- **The Admin console** moves to `@aotter/mantle-ui/admin`, served at `/admin`
  by the preset through the Worker's `ASSETS` binding.
- **Not yet in 0.2.0:** Mantle-rendered public pages, the MCP interaction App
  tools, and deploying to Mantle Cloud.

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
authentication and CSRF to the host. ChatGPT Sites is a
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

- [GitHub Releases](https://github.com/aotter/mantle/releases)
- [`CHANGELOG.md`](https://github.com/aotter/mantle/blob/main/CHANGELOG.md)
