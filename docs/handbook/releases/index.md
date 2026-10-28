---
description: Every Mantle release line — what 0.2.x changes, and what each stable 0.1.x release contained.
---
# Releases

Mantle publishes to npm under the `@aotter/*` scope. A **stable** release is a
plain `X.Y.Z` version on the `latest` dist-tag and is the only kind intended
for production. Prereleases (`alpha`, `rc`) let a release be prepared in the
open; installing one means choosing an exact version, not a channel.
[GitHub Releases](https://github.com/aotter/mantle/releases) is the canonical
change history; this page is the narrative one.

From 0.2.0-alpha.7, Mantle publishes three packages together at one version:
`@aotter/mantle` (native SDK, compiler and CLI), `@aotter/mantle-ui` (pure UI),
and `@aotter/mantle-admin` (optional Admin server, SPA and MCP App).
Pin every package you use to the same exact version and upgrade them together.

## 0.2.1 — in preparation

0.2.1 adds Schema locks: a manifest rule that refuses a row's update or delete
for every caller path (REST, MCP, Admin and Procedures), with Admin showing the
lock before an edit. `spec.publishing.liveEdits` lets an application edit a
published row in place, and the [revisions guide](../guides/revisions.md) now
freezes the live revision with a lock and switches it atomically. It also brings
Admin form and refresh fixes, the media picker for custom inputs and pages
(`@aotter/mantle-admin/media`), `matchTarget` in `@aotter/mantle/describe`, and
dependency updates for current advisories.

### Upgrading to 0.2.1-alpha.1

Pin `@aotter/mantle`, and any selected `@aotter/mantle-ui` and
`@aotter/mantle-admin`, to `0.2.1-alpha.1`, refresh the lockfile, regenerate and
review owned output. No DDL changes are required. Breaking changes:

- **PostgreSQL `version`:** Store results return `version` as a number, as on
  SQLite and D1. Procedure results stay driver-native.
- **Admin record form:** clearing an optional field sends `null`; generated
  form types for optional fields are `T | null`.
- **REST route precedence** is fixed and most-specific-first. Only overlapping
  same-method http Triggers with the same parameter count can change winner.
  `TRIGGER_PATH_INVALID` and `TRIGGER_PATH_COLLISION` refuse ambiguous paths
  at generation; see [route precedence](../reference/trigger.md#route-precedence).
- **Tooling:** the templates move to Wrangler 4.153.0 and
  `@cloudflare/workers-types` 5.20261027.1.
- **Revisions recipe:** an application that copied the guide's
  `switch-revision` handler should adopt the new version, which requires
  `expectedRevisionVersion` from the preview.

## 0.2.0 (2026-10-19)

The first stable native 0.2 release compiles closed v2 manifests to SQL and
TypeScript for Bun SQLite/PostgreSQL and Cloudflare D1/PostgreSQL. It ships
three matching packages: Core, the pure UI kit and the optional application-built
Admin. Applications own routing, verified identity, database handles, migrations
and deployment; selected REST, MCP, public pages, publishing, translations and
media compose around the generated operations.

This is a breaking upgrade from 0.1.x: follow the [0.1-to-0.2 migration
guide](../../upgrade-0.1-to-0.2.md), use a new 0.2 database and explicitly move
data. From alpha.11, pin the three selected packages to 0.2.0, regenerate and
review owned output; the stable version commit changes release metadata and
documentation rather than adding another runtime API.

[GitHub release](https://github.com/aotter/mantle/releases/tag/v0.2.0) is the
complete change history. Known follow-ups remain tracked: [Admin/authoring
refinements](https://github.com/aotter/mantle/issues/1752), [production social
and magic-link recipe verification](https://github.com/aotter/mantle/issues/1273)
and [real Sites guide verification](https://github.com/aotter/mantle/issues/1272).
Those provider-specific paths are not claimed as verified by local OTP or
native-host tests.

### Upgrading to 0.2.0

Pin every selected `@aotter/mantle`, `@aotter/mantle-ui` and
`@aotter/mantle-admin` dependency to `0.2.0`, refresh the lockfile,
then regenerate and check the application's owned artifacts. Keep existing
production migrations application-owned; generated initial DDL is for an empty
database. This release includes breaking Admin authoring and paging changes.

1. **Build output and host configuration.** `mantle bundle` writes server
   modules to `dist/worker` and static files to `dist/client`, including
   `dist/client/admin`. Rerun `mantle generate` with the application's `--entry`
   and check the resulting Wrangler `main`, `base_dir`, asset directory and
   build command. See [CLI and generated ownership](../start/project-and-cli.md).
2. **Application-owned React.** Install React and React DOM in the application
   at the same exact version (the examples use `19.3.0`). Admin takes them as
   peers; a mismatched pair fails its build.
3. **Replace extensions with application composition.** Move to
   `defineAdmin(meta, { nav, pages, home, components, plugins, mcp })` in
   `src/admin.tsx`. Remove `--admin-extensions`, `adminExtensions`,
   `defineAdminExtension`, extension handlers and removed manifest widget,
   `list.cells` and panel references. `navGroups` becomes `nav.groups`.
   Use the [Admin migration table](../guides/native-admin.md#migrating-from-admin-extensions)
   rather than carrying the former registration layer forward.
4. **Build the MCP App with the application.** The prebuilt
   `@aotter/mantle-admin/mcp-app` / `mantleAppHtml` export is gone. Use
   `adminMcpApps({ catalogue: mcpAppCatalogues.admin })` with the generated
   catalogue; it reads the built asset. Declare CSP once in `defineAdmin`.
   The default resource URI hashes the built HTML, catalogue and metadata;
   custom HTML functions need an explicit immutable URI. Load interactive
   host HTML through authenticated `resources/read`, which embeds its
   catalogue. See [MCP Apps](../guides/mcp-apps.md).
5. **Run the generated compatibility check.** Run
   `node --test generated/admin-mcp-app.check.mjs` after building. Install
   the optional `playwright-core` peer and a browser, or set
   `MANTLE_TEST_CHROMIUM`; a missing browser fails rather than skips. This
   checks rendering with a synthetic catalogue, not application authorization
   or completion of a Procedure action.
6. **Keep the host graph safe.** The MCP build rejects `/admin/api` access,
   cookies and undeclared remote loads. Its entry must be readable in Node.
   An optional `src/admin.mcp.tsx` (or `buildAdmin({ mcpEntry })`) isolates
   browser-only integrations; both roots can reuse one host-safe config,
   components and CSS. Without it the whole shared entry graph is checked.
7. **Distinguish total bounds from page sizes.** Authored SQL `LIMIT` now
   bounds the complete ordered result set across cursor pages, including web
   indexes. Use paging `options.limit` for page size; remove an authored limit
   only if it was incorrectly being used as a page-size setting. MCP accepts
   sizes of 1–500, but a response budget can return fewer rows: append pages
   until `nextCursor` is absent, not until a short page. See
   [View paging](../reference/surface.md).
8. **Install build dependencies where the build runs.** Wrangler dev/deploy
   runs its configured build command, so that environment needs
   `node_modules`. The resulting built server/assets do not read
   `node_modules` when served. See the
   [application shell](../../examples/app-shell/README.md).

Record/collection cells, inputs, record actions, asides and `RecordView` are
now truthfully browser-only (`surface: "browser"`); remove unreachable MCP
branches. View cells remain `both`, and pages opt in through `pages[].mcp`.
A Procedure action's input is distinct from a collection record input: use a
Procedure target and MCP Trigger with the View's unchanged `id` and observed
`version` for native row actions. [Shared custom-page headers](../guides/mcp-apps.md#customising-admin-for-mcp-hosts)
can compose localized title, description and actions on both surfaces; omit the
option to keep prior behavior, or use `header: false` for an element-owned heading.

OAuth issuer verification now follows Better Auth's normalized URL while
preserving explicit issuer/JWKS settings. Cloudflare OAuth configurations need
`global_fetch_strictly_public` for public JWKS fetches; generated settings and
the official examples retain it. Native MCP Apps use the official ext-apps
client. Browser Admin now displays a localized explicit reload action when a
lazy page fails, rather than going blank; it does not reload automatically or
replay writes.

### Native SDK migration (alpha.7)

Alpha.7 replaces the previous Core runtime and generated service contract.
Existing alpha.6 applications require a source migration:

- Replace `createMantle`, `Store.select` and the old host presets with
  [native generated queries and Store](../guides/typed-queries.md).
  Generate with an explicit target and output directory, for example
  `mantle generate cloudflare-d1 generated manifests/*.yaml --auth src/auth.ts --admin`.
  See [CLI and generated ownership](../start/project-and-cli.md).
- The application owns routing, native database handles, verified Caller,
  Auth configuration and migrations. Runtime no longer converges storage or
  runs DDL at boot. Apply generated `schema.sql` only to an empty database;
  migrate existing data explicitly. PostgreSQL uses Bun.SQL on Bun and
  postgres.js on Workers. See [native execution](../guides/native-execution.md).
- Install the separate `@aotter/mantle-admin` package when selecting Admin, with `react` and `react-dom` in the application pinned to one identical exact version (Admin no longer installs them).
  Compose its [native bindings](../guides/native-admin.md) in the application.
  Bare queries retain driver-native values; selected REST/MCP/Admin boundaries
  own validation and declared-column wire conversion.
- Move lifecycle/schedule handlers and dynamic authorization guards into
  application code. Review [authorization and Caller wiring](../concepts/runtime-and-adapters.md)
  and regenerate all owned artifacts before running `generate --check`.

The [reference Worker](https://github.com/aotter/mantle/tree/v0.2.0/docs/examples/reference-service) and
[app shell](../../examples/app-shell/) demonstrate the current composition.
The following earlier-alpha notes are historical; the current handbook and
the native migration above supersede their runtime and CLI instructions.

### Earlier alpha design

0.2.0 replaces 0.1.x's grammar and composition; no stable 0.1.5 was released
(`0.1.5-alpha.1` was a prerelease). It breaks every consumer, and
`docs/upgrade-0.1-to-0.2.md` in the package is the guide for moving a project
by hand.

- **Manifests are `cms.mantle.aotter.net/v2`.** Views are one SQL `SELECT` and
  Procedures are SQL statements or a `ref`, in PostgreSQL syntax. The builtin
  handlers, the Filter AST, `params`, `$ctx` references and `x-mantle-bind` are
  gone; Schemas gain `checks`, and `searchableFields` becomes full-text search.
- **SQL in the dialect's syntax.** PostgreSQL is the reference dialect
  (`@aotter/mantle/postgres`); D1 and SQLite run a subset
  (`@aotter/mantle/d1`). Each dialect is its own target (ADR-0039), and a
  plan records its dialect.
- **One Store.** Every read and write goes through Store, which adds caller
  scope, TTL and published-only to every statement, and an optimistic lock
  where the caller passes one; a write
  is all or nothing.
- **The service is the application's.** `createMantle(service, …)` replaces
  `createMantleWorker`, and the first `mantle generate` writes the host's
  preset (`src/service.ts`, `src/index.ts`, ...) once. `--host` is
  `cloudflare` (D1, or PostgreSQL through Hyperdrive), `bun` (node-postgres
  or bun:sqlite, `@aotter/mantle/bun`) or `none` (plan and types only), and
  `--dialect` is `sqlite` or `postgres`; both are chosen once.
- **Mantle never owns your users.** A `CallerResolver` turns a request into a
  `Caller`; identity is `mantle` (Better Auth), `custom` or `none`. Core creates
  no auth tables.
- **Storage converges to the plan** at boot: additions are applied, unsafe
  changes are refused with a diagnostic, nothing is dropped, and there are no
  migration files.
- **Schedules are POSIX cron**; `toCloudflareCron` translates them for Wrangler.
- **MCP tools come from Views and Procedures only.** Staff tools are at
  `/mcp/staff` for an OAuth client, with Mantle's MCP App rendering staff
  View rows in the chat; Admin's WebMCP runs the same tools on Admin's own
  routes.
- **The CLI is `mantle generate`** and `mantle generate --check`. `validate`,
  `emit-openapi`, `skills` and `mantle-harness` are removed.
- **The Admin console** moves to `@aotter/mantle-ui/admin`, served at `/admin`
  by the preset through the service's `ASSETS` binding.
- **Not yet in 0.2.0:** Mantle-rendered public pages and the MCP interaction
  App tools.

### Native driver and before-hook cleanup (#1426)

This breaking source migration removes request-scoped PostgreSQL sessions,
custom write pipelining/retries, SQLite lock polling and before-hook runtime
policing. Copy the new native preset wiring; existing generated source is not
overwritten. Authenticated Bun SQLite uses separate Store/Auth handles to the
same WAL file. Operational before hooks no longer add an implicit version
lock; explicit OCC, publishing checks and authorization guards remain.
See [native execution migration](../guides/native-execution.md) and ADR-0041.
The alpha.6 instructions below describe that release; ADR-0041 supersedes its
requestScoped/pipeline/shared-SQLite-handle directions after this cleanup.

### Upgrading an existing PostgreSQL service (0.2.0-alpha.6)

PostgreSQL is native from this alpha (ADR-0039): each dialect is its own target,
PostgreSQL's SQL and ordering are PostgreSQL's, and node-postgres (`pg`) is the
PostgreSQL driver on every host. D1 and SQLite output is unchanged except where
noted. Work through these in order before deploying.

1. **Role settings (from #1383, now also checked on Bun).** Boot refuses with
   `STORAGE_CHANGE_BLOCKED` (path `storage:settings`) unless the role Mantle
   connects as has a statement limit and UTC:
   `ALTER ROLE app SET statement_timeout = '10s'; ALTER ROLE app SET TimeZone = 'UTC';`
   (10s or less). Bun's `Bun.SQL` entry used to pin its own limit and skip this
   check. A Hyperdrive config must keep `--caching-disabled`: reads, role
   re-reads and grant revocations run outside a transaction.
2. **Rewrite SQLite spellings, then run `mantle generate`.** A PostgreSQL
   manifest that uses `json_each`, `-> '$.a'`, `->> '$.a'`, `json_extract`,
   `json_set`, `json_insert`, `json_remove` or `hex` fails validation with its
   position and the PostgreSQL spelling. The
   [dialect contract](../concepts/runtime-and-adapters.md#drivers-and-dialects)
   covers the PostgreSQL target: `json_each(t.col) j` becomes
   `jsonb_array_elements_text(t.col) WITH ORDINALITY AS j(value, n)` (a sorted
   View over a row source needs the alias and `WITH ORDINALITY`, and `j.id`
   becomes `j.n`), `CAST(n AS bool)` of an integer becomes `n <> 0`, and `||`
   needs a text operand. The PostgreSQL dialect version is now 2, so a plan
   compiled earlier fails at boot with `PLAN_FINGERPRINT_MISMATCH`: run
   `mantle generate` and deploy the regenerated plan.
3. **NULL order.** Unstated `NULLS` now follows PostgreSQL: NULL last ascending,
   first descending, for every `ORDER BY` including windows and
   `json_group_array`. Write `NULLS FIRST` or `NULLS LAST` to keep a specific
   order. Rows tied on the last sort key are ordered by `id` in that key's
   direction. A cursor live across the deploy may repeat or skip rows once.
4. **Bun entry.** Install `pg` and `@types/pg`. Replace
   `new SQL(url, { prepare: false, ... })` with
   `new pg.Pool({ connectionString, pipeline: true })`; `Env.SQL` becomes
   `Env.PG`. The simplest path is to delete `src/service.ts` and `src/index.ts`
   and re-run `mantle generate --host bun`, or copy the new preset. Removed from
   `@aotter/mantle/bun`: `bunPostgresStorage`, `bunPgConnect`,
   `bunDatabaseDriver`, `bunAuthDatabase`, `BunSqlPool`, `BunAuthPool`. The role
   no longer needs `TEMPORARY`. Custom transports lose `temporaryResultMetadata`,
   `describeResult` and `readOnly` from `PgClient` / `PgStatement`.
5. **Generated `src/service.ts` changed.** The `database(env).run` wrapper moved
   to the exported `mantle`, and the Bun pooled wrapper ends each client once.
   The preset is never rewritten: re-run `mantle generate` into a scratch
   directory and copy the difference, or delete and regenerate if unedited.
6. **First boot does one-time work.** It runs once under the advisory lock:
   - one `_mantle_ix_<schema>_updated` index on `([scope,] updated_at, id)` per
     Schema, built without `CONCURRENTLY` inside the convergence transaction, so
     writes to a large table block while it builds. Pre-create it before
     deploying, on the schema (`search_path`) Mantle uses, with both names quoted:
     `CREATE INDEX CONCURRENTLY "_mantle_ix_<schema>_updated" ON "<schema>" (["<scope>",] updated_at, id)`.
     A matching index is accepted. If a concurrent build fails, drop the invalid
     index before deploying: boot accepts it by name and columns and never
     rebuilds it. A Schema name longer than about 43 bytes gets a hashed index
     name; read it from a fresh database's `pg_indexes` instead;
   - each `_mantle_chk_*` check is rebuilt once (earlier releases left no
     marker); later boots leave unchanged checks alone;
   - the old `_mantle_jget`, `_mantle_bool` and `_mantle_json_each` functions
     stay in place, unused: a previous release still running during a rolling
     deploy calls them.
7. **Boot under contention.** Concurrent boots converge once. A boot that cannot
   get a lock within about five tries of one second fails with
   `STORAGE_CHANGE_BLOCKED` naming the lock (another boot still converging, or a
   long transaction on a table the plan changes), and is not retried for 10
   seconds. A winner building a very large index can outlast its waiters, which
   then report the blocked boot; boot again when it has finished (#1408).
8. **Auth.** `get-session` no longer carries a `set-auth-jwt` response header
   when the OAuth provider is configured; call the plugin's `/api/auth/token`
   instead. `d1Driver`'s structural `D1PreparedStatement` now requires `first`
   and `all`: a hand-rolled fake must add them.
9. **D1.** A paged View with `json_each` in a `JOIN` arm, or with more than one
   `json_each`, now pages by every element's `id`: its order among ties changes,
   no row is skipped, and a cursor issued before the upgrade may need to restart.

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
