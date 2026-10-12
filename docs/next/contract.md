# Mantle Next: generated native execution

Status: experimental implementation decision authorized on 2026-10-11.
Baseline: 6fda2dfddc72d414720c9540d572b199a7bb7a35. Existing Mantle remains intact.

## Goal

The generated application must execute concrete typed functions and concrete
SQL through the official native driver. Generated code must not import the
old runtime, Store executor, RuntimePlan, IR interpreter, fingerprint verifier,
or execution registry. SQL policy is compiled once during generation.
The generic IR round trip and repeated row processing have one architectural
cause: an execution interpreter between generated declarations and the driver.
Next removes that intermediate executor rather than accelerating it.

Day-one targets are Bun SQLite, Bun PostgreSQL, Cloudflare D1, and Cloudflare
PostgreSQL. Workers validation uses local Wrangler only. Bare PostgreSQL entries
call Bun.SQL's own shape (`Postgres`: `unsafe(text, values)` and
`begin(options, fn)`), so Bun passes its `SQL` directly. Store transaction handles also run multi-statement
Procedures within the existing transaction (ADR-0045). postgres.js
satisfies the same shape with no adapter (Workers PostgreSQL over Hyperdrive:
`postgres(env.HYPERDRIVE.connectionString)`; verified by `verify-native cloudflare-postgres`); other drivers are
application-owned adapters. Date-time, date and JSON inputs are declared text in the SQL (and in the Store's
comparisons), because postgres.js would otherwise turn text bound to timestamptz into a Date and lose microseconds. SQLite uses bun:sqlite; D1 uses its platform binding. Pool,
connection lifetime, database isolation, locks and retries remain native and
application-owned. No cloud provisioning.

## Current implementation boundary

The first PR is a four-target generated SQL slice, not a complete 0.2 replacement.
Its View functions return full authored-SQL row arrays, not the Store paging API.
There is no optional Auth/Web/MCP/Admin/UI composition in this slice. Ref Procedure
handlers are generated application contracts; guards and Triggers are currently refused. The [supported/refused list](compatibility.md)
separates generated scope, refused declarations and planned features; none
of those status labels substitutes for native test evidence. Issue #1459 stays open.

## Contracts and ownership

Next retains the closed v2 Schema/View/Procedure/Trigger authoring grammar, PostgreSQL
SQL authoring, typed interfaces, scope/visibility/TTL, declared authorization,
input/output validation, explicit OCC, native atomicity, and stable failures.
The supported/refused list identifies availability. Core APIs, imports, envelopes
and cursors have no compatibility layer; existing data moves explicitly without
automatic migration. Internal RuntimePlan and executor APIs are not retained.
Compilation may use the existing parser, linker, SQL policy,
and dialect printers as build dependencies. They must never enter the request
bundle. Each dialect retains its own native behavior; cross-DB equivalence is
not promised.

### Revised query responsibility decision (2026-10-11)

Generated query code must have the same execution work as independently written
native code for the same declared SQL policy and transaction. A helper is not
required merely because the old runtime owned it. The user explicitly approved
moving validation to the application boundary and reconsidering old query-time
checks; preserving the old internal execution contract is not the goal.

The default typed query accepts application-validated parameters and a verified
Caller, binds literal SQL using the official driver, and returns that target's
native result types. Generated TypeScript is a compile-time contract, not a
validator for untrusted data. The application must validate external input before
calling it. Generate-time schema/SQL diagnostics remain mandatory.

The bare query must not recursively scan JSON, construct validators, revalidate
known database rows, normalize errors across databases, or require universal row
decoding. Direct in-process values are owned by their application caller; input
bounds, JSON defaults and computed result types are handled explicitly by the
application boundary rather than assumed from TypeScript.

Driver-native PostgreSQL types and SQLite/D1 types need not match, except for
declared date-time and date outputs (below), which the SQL formats. That does not
justify overriding every PG type parser or adding a generic decoder to the bare
query. Authored output names should be emitted into SQL where valid, avoiding
an extra per-row projection merely to repair names already known at generation.

Declared authorization, ownership/TTL SQL policy, explicit OCC and atomic writes
remain required. Generate them as the native application would implement them.
Transaction rollback and uncertain COMMIT handling must still preserve data-loss
protection and client disposal responsibility; native errors are rethrown (one exception, below), and
redaction before they reach HTTP users belongs to the application boundary (no helper). Removing generic error
normalization does not authorize dropping transaction outcome evidence.

**Single-statement writes:** a Procedure with one statement is atomic on its own
and runs in autocommit, with no BEGIN/COMMIT on PG or native transaction on Bun
SQLite. A row-classified statement touches at most one row (one-row INSERT or
unique `id =`), so a failed count check after autocommit has changed nothing.
On PG it runs at the server's default isolation, not SERIALIZABLE: a concurrent
OCC loser re-evaluates its `version =` predicate, matches zero rows and returns
`CONFLICT` instead of SQLSTATE 40001. A server ErrorResponse (SQLSTATE and
severity) is a known rollback and is rethrown natively, except a unique violation (23505, SQLite's `UNIQUE constraint failed`), which, in a generated Procedure or a Store write, is `ContractError("CONFLICT")` with the native error as `cause` on every target, and except connection,
resource and shutdown classes (08, 28, 53, 57, 58, XX), which, like any failure
without a server response (lost socket), are `OUTCOME_UNKNOWN`. SQLSTATE is
`errno` on Bun.SQL and `code` on postgres.js. Multi-statement Procedures run in
`begin("isolation level serializable", ...)`: a failure before the callback
returns was rolled back by `begin`; only a failed COMMIT is classified as above.

The optional `checked` boundary was removed on 2026-10-11; validation, defaults and error redaction belong to the application.

**Date-time wire form:** a View output that is a declared `date-time` column
(including `created_at`/`updated_at`) returns the handbook's wire form, an ISO
string in UTC with six fractional digits; a declared `date` returns `YYYY-MM-DD`.
The generator wraps those SELECT items before the dialect's own printer prints them
(`to_char` on PostgreSQL, `strftime`/`date` with floor arithmetic on SQLite), so the
database formats them and no row decoder runs. Bun.SQL's `Date` would drop
microseconds. A write's `RETURNING` of such a column gets the same form. Inputs bound to a declared date-time take the same ISO text (or a
valid `Date`), and a declared date takes `YYYY-MM-DD` text, on every target: a
timestamp needs `Z` or an offset and hours 00-23, a day that does not exist is refused with `SQL_TYPE` before the write, and SQLite receives
microseconds and days while PostgreSQL receives the canonical text. Computed values
(`now()`, `date_trunc`, `CAST`) carry no declared type and stay driver-native; on
PostgreSQL through Bun.SQL that is a `Date`, which drops microseconds. Other
declared scalars are driver-native.

Driver-ready JSON parameters are text on every target (a JavaScript array would otherwise be bound as a PostgreSQL array), so the application serializes them. Bare PG SQL declares each JSON parameter as text
(`CAST(CAST($n AS text) AS jsonb)`), so Bun.SQL sends the text verbatim instead of
JSON-encoding it again; generation refuses a JSON parameter used any other way. SQLite bool/date/timestamp/numeric parameters use their declared
storage representations. Bound optional fields become explicit required values,
with null representing absence; D1 cannot bind undefined. Native output keys are
SQL names rather than a post-query camel-case projection. PG uses the driver's
default type parsers (including Date and int8 strings); custom application parser
configuration changes application-owned behavior. Procedures expose raw
`{ results }`, not a claim of validated authored output.

When Auth composition is implemented, it resolves a trusted Caller once at the
application entry. The first slice accepts an application-supplied Caller and
does not verify credentials. SQL binds the caller subject directly; a system
caller is application-owned and never wire input.

Application handlers own business rules and side effects. Before/after lifecycle
hooks are refused; write a custom handler instead. No sandbox, implicit hook OCC,
lock wait, or behavior analyzer is added. An unsupported guard,
hook, lifecycle, reader shape, or feature must produce an actionable generate
error rather than silently execute without its contract. The
[supported/refused list](compatibility.md) defines the replacement scope, including
features planned in #1465.

PostgreSQL session prerequisites are deployment configuration (ROLE/DATABASE
settings; Hyperdrive does not keep session SETs): `DateStyle` ISO, YMD;
`IntervalStyle` postgres; `TimeZone` UTC; `standard_conforming_strings` on;
`extra_float_digits` 1; a positive `statement_timeout` (10 s by default). Nothing
at request time sets or verifies them.

Storage migrations are explicit deployment artifacts. No request or module import
may converge storage or inspect every schema. Optional Better Auth, REST, MCP,
Admin and UI stay outside the query core. Preserve their public behavior as they
are added; do not make a read import their entire composition.

The separate generated `transfer.ts` deployment entry provides
[portable dump/import](portable-store.md) over an exact static descriptor. It
preserves physical Schema/product/auth rows and excludes sessions; it does not
reuse scoped/TTL/publishing-filtered Store reads. Its deploy-time integer text
projection and codecs do not change bare query responsibilities or startup graphs.

## Ref Procedures

Ref Procedures generate a typed `Handlers` interface, keyed by Procedure name,
required at the wiring point `store(db, caller, { handlers })`. SQL-only Stores
have no handlers option. The direct `procedures` map and operation entries expose
SQL Procedures; ref Procedures are callable through the bound Store's map.
Generated `requires` checks precede invoking `(ctx, input)`, where
`ctx = { caller, db, store }` uses the actual caller-bound Store. Inside an
interactive transaction, both `ctx.db` and `ctx.store` are transaction-bound;
the context Store types expose collections and operation maps shared by both.
Missing, extra and incompatible implementations fail TypeScript at Store wiring;
an object missing a key at runtime is `HANDLER_NOT_REGISTERED`. Input/output schemas remain
typed application contracts; external input validation belongs to selected
REST/MCP boundary modules. Those surfaces take handlers in their options when
ref Procedures are exposed. Handler failures propagate unchanged. Custom handlers
own their side effects and explicit transaction boundaries.

## Shared runtime core

Generated Views, Procedures, the Store and the Better Auth adapter share one kernel (`src/kernel`): a dialect per engine (how SQL is
spelled), a driver per handle (how it is called and what atomicity it really has), one bind evaluator, one condition builder and one
generic Store. Nothing branches on the engine at run time. The design, the Store's rules and limits, and the measured costs are in
[ADR-0045](../adr/0045-next-runtime-core.md); size numbers are `size-budgets.json` and `scripts/check-package.ts`.

## Opt-in publishing

The default Schema lifecycle is `operational`. Opt-in `publishing` emits status
(`draft | published | archived`, NOT NULL default `draft`), nullable
`published_at`, and an index on `(published_at, id)` prefixed by scope when present.
The timestamp is a selectable native column and uses the normal ISO wire form.
Indexed Store ordering on this nullable system column uses `NULLS LAST` for both
directions; its keyset cursor handles nulls. Other sortable columns remain indexed
and NOT NULL.

Generated `<table>.publish`, `.unpublish`, and `.archive` take
`{ id, expectedVersion }`, gate staff/system Callers, and execute one atomic native
UPDATE. Legal states are draft→published, published→draft, and draft/published→archived.
Publish checks required fields. Guards retain scope, TTL and OCC. CONFLICT messages
name the operation and possible guard failures; no second read guesses which guard
failed after concurrent activity. Store refuses direct status/published_at writes,
but imposes no separate role-based edit/delete rule; Admin owns those limits.

Core rowPolicy term data defines the published value and carries the generation-time staff vocabulary, and both
Core's AST renderer and Store render that data. Public Views always require
published rows; other Views and Store permit drafts only for staff/system.
Policy applies at every relation, including joins, LEFT JOINs, subqueries and CTEs.
Transitions already gate staff and therefore need only scope/TTL in their row rule.


## Architecture and acceptance

`kernel <- domain <- usecase <- infrastructure`. Kernel contains portable
contract primitives only. Domain owns generation inputs, target declarations
and pure source emission. Usecase orchestrates generation. Infrastructure reads
files and assembles the existing build-time compiler/dialect. Host imports in
emitted strings are output, not generator dependencies.

Every supported feature needs a side-by-side semantic test against independently
written native SQL on the same engine and fixture. Compare SQL/bind work, full
results, errors, and committed state. Performance comparisons follow the protocol
in `packages/mantle-next/AGENTS.md`; no artificial delay or weakened oracle.

Existing ADRs remain historical and continue governing the old package. For Next,
this decision supersedes only the old interpreter/plan-at-runtime topology and
ADR-0044's seeded-executor path. Existing specifications describe retained
contracts where this decision and #1465 explicitly reuse them; they do not promise
API compatibility. No permanent dual engine,
new grammar or speculative runtime framework is introduced.

## Initial DDL decision

The SQL-only initial artifact emits declared indexes and native primary/unique
constraints. PostgreSQL's historical automatic Admin `updated_at,id` index is
not emitted by Next when no Admin surface is selected. The old package's
convergence behavior remains unchanged. Optional surfaces must justify and own
their additional indexes when composed; read/write overhead must not be hidden
in the minimal query core. Initial DDL is an explicit empty-database artifact,
not a replacement for safe production migration or readiness checks.

SQLite-family initial artifacts use UTC. Their existing time-zone SQL lowering
needs `_mantle_tz`; generate emits its native table and one UTC offset row covering
the safe timestamp range. No request-time zone-table construction occurs. Regional
time zones are not yet supported by this slice.

## TTL maintenance

A TTL Schema generates `<schema>.sweepExpired(db, caller, { limit?, cursor?, delete? })`
in `procedures/<schema>.sweepExpired.ts`. Only an application-created system caller
with a non-empty reason may invoke it; HTTP/OAuth callers cannot become system
callers. The app owns scheduling. Schedule/lifecycle Triggers remain refused.

The sweep returns `{ scanned, removed, nextCursor? }`, defaults to 500 candidates,
and accepts limits 1..500. `delete: false` scans without deleting. Cursors belong
to that Schema's sweep. NULL and future TTL values survive; a timestamp exactly
at the shared dialect cutoff expires. Maintenance deliberately ignores scope and
publishing visibility, deleting expired rows across tenants. Candidate selection
and deletion run atomically through the native driver with its existing uncertain
transaction outcome handling. Native triggers may suppress deletes, so scanned
and removed counts can differ; the cursor advances over selected candidates.

```ts
import sweep from './generated/procedures/session_notes.sweepExpired.js';

export default {
  async scheduled(_event, env) {
    const caller = { kind: 'system', reason: 'scheduled TTL cleanup' } as const;
    // Bounded per invocation: the next scheduled run starts again from the oldest
    // expired rows, so no cursor needs to survive between runs.
    let cursor: string | undefined;
    for (let pages = 0; pages < 20; pages++) {
      const page = await sweep(env.DB, caller, { limit: 500, cursor });
      cursor = page.nextCursor;
      if (!cursor) break;
    }
  },
};
```

Keep the sweep import in the scheduled entry; apps selecting unrelated operations
exclude maintenance code. Set `triggers.crons` in Wrangler yourself. The SDK's
`toCloudflareCron` helper (the `cron` subpath) converts five-field POSIX schedules
(weekday 0=Sunday) to Cloudflare weekdays (1=Sunday); it refuses ambiguous schedules
that restrict both day-of-month and weekday. This is conversion only, no dispatcher.
Bound scheduled work to your host's execution budget; keep the returned cursor
when continuing a larger sweep in a later invocation.

### Optional site and media

`generateFromSources({ site: siteDefaults, ... })` (CLI: `--site <module>` exporting
`siteDefaults`) adds the generated `site` module and the `site_config`, `media_assets`, and
`pending_media_uploads` tables to deployment `schema.sql`. Without that option,
none is emitted. `site(db, caller)` constructs a capability without queries or
DDL. `read()` overlays stored brand/title/description over code defaults;
`updateSettings()` persists only operator fields. Generated `site-seed.sql` seeds
nonblank operator defaults once with `ON CONFLICT DO NOTHING`; initial `schema.sql`
also contains that seed. Apply the seed during subsequent deployments. Origin, icons, locales and
media purposes are generated code constants, so a deployment updates them
without boot-time sync or seeds. A later code change never overwrites stored
operator settings. Defaults use the 0.2 build-time validator and mime expansion.

Site settings and media require the OSS `staff` role, on the application's
verified Caller. `siteInfo(config, options)` from the optional `/site` subpath
projects the 0.2 Admin site wire, including absolute MCP endpoints and selected
capabilities. The app supplies media/email wiring and extension declarations.
Media asset times and `createdAt` remain epoch milliseconds for the existing
Admin SPA; content row timestamps remain ISO as specified above. Media references
still use `x-mantle-ref: media_assets`; the application resolves ids to URLs.

The media library keeps 0.2 purposes, variants, 15-minute upload groups, offset
paging (1–500), literal id/alt/caption search and edits. It never receives bytes.
SVG is refused. Delete removes objects before the row; `PARTIAL_FAILURE` retains
the same id and advertises a safe retry. Commit keeps upload sources until the
native SQL write is durable; repeated commit returns the existing immutable id.
Each R2 commit attempt owns different public keys; concurrent loser cleanup
cannot affect the durable winner. A fully copied loser removes only its own
unselected objects after reading the winning SQL row.

Error statuses: the core `statusOf`/`wire` map only the core codes
(`INPUT_VALIDATION_FAILED`, `UNAUTHENTICATED`, `AUTH_DENIED`, `NOT_FOUND`,
`METHOD_NOT_ALLOWED`, `CONFLICT`, `OUTCOME_UNKNOWN`); any other `ContractError` carries
its own `status` (and extra wire `fields`), otherwise it is a redacted 500. Raise media,
site and `PARTIAL_FAILURE` codes with `mediaError(code, message, path?)` from
`@aotter/mantle-next/media`, never `new ContractError("MEDIA_…")` directly; a custom
`MediaStorage` that throws these codes without a status is given it by the library.
An uncertain SQL outcome is propagated by the native driver. Retry that group
rather than creating a replacement asset. Rejected objects are discarded.

## OSS staff role

OSS auth templates grant `staff`; any staff can manage users. Caller.role is an open string for application identity vocabulary. Next publishing visibility and transitions use only the generated staff allowlist (`staff`), consistently in Views and Store. Core keeps its legacy role preset for existing consumers. Auth helpers are optional app-selected modules and never perform boot DDL.
## Translation publication

Translations retain the v2 `localized` / `translates { parent, on }` declarations.
Publishing uses one guarded UPDATE: any parent row sharing `on` may satisfy it,
but that row must be published and visible under the same caller's SQL scope.
There is no prior parent read or cached publication decision. Translations keep
their own status; drafts remain valid. Public translation reads also require a
published, caller-visible parent with the same `on` value. This condition belongs
to the shared generated SQL row policy used by Store, Views and locale queries,
not a second application filter. Unpublish/archive hides the translations;
re-publishing the parent restores them without updating their status. Staff/system
preview reads retain access to drafts.

Store translation reads merge parent fields into the returned row; translation
fields, including system fields, win name collisions. Non-unique join keys choose
one caller-visible parent by newest `created_at`, then id; public reads choose from
published parents. Parent-only fields are read-only and optional in the row type:
child insert/update inputs and write results retain their own columns.
Non-staff translation updates and deletes are also gated by the visible published
parent policy. Scoped parents and children must declare the same scope column;
the generator refuses different or missing child scope columns. Parent publication,
visibility and inherited field selection always correlate the stored parent/child
scope values, including for system callers. Authored Views continue to
return their explicit SELECT columns; parent fields must be selected explicitly.
Generated SQLite/PostgreSQL interactive Store transactions refuse to combine a
translation publication with its parent's status change, in either order. A failed
guarded publication releases only its own reservation, preserving prior successful
writes in the same transaction.
D1 has no interactive Store transactions and is exempt from this one-write rule.
Raw application-owned native transactions remain the application's responsibility.

Generated `translations.ts` lists locales for one parent page with native keyset
queries (50 keys per batch, 500 child rows per read). The caller owns the parent
page and its boundary validation. `locale` values are ordinary strings, and
`toCanonicalLocale` is an explicit helper rather than a Store coercion.


