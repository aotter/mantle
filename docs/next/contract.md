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
`begin(options, fn)`), so Bun passes its `SQL` directly. A Bun transaction handle
also works for Views and single-statement Procedures; a multi-statement Procedure
opens its own transaction, which Bun refuses inside another (no write happens). Other
drivers are application-owned adapters to that shape; Workers PostgreSQL (for
example Mantle Cloud over Hyperdrive) adapts node-postgres, and the tested recipe
is `tests/apps/pg-port.ts`. SQLite uses bun:sqlite; D1 uses its platform binding. Pool,
connection lifetime, database isolation, locks and retries remain native and
application-owned. No cloud provisioning.

## Current implementation boundary

The first PR is a four-target generated SQL slice, not a complete 0.2 replacement.
Its View functions return full authored-SQL row arrays, not the Store paging API.
There is no optional Auth/Web/MCP/Admin/UI composition in this slice. Ref handlers,
guards and Triggers are currently refused. The [compatibility ledger](compatibility.md)
separates implemented scope, refused declarations and open responsibilities; none
of those status labels substitutes for native test evidence. Issue #1459 stays open.

## Contracts and ownership

The full compatibility goal is to keep the closed v2 Schema/View/Procedure/Trigger authoring grammar, PostgreSQL
SQL authoring, typed interfaces, scope/visibility/TTL, declared authorization,
input/output validation, explicit OCC, native atomicity, and stable failures.
These are the target observable promises, not a claim that every one is implemented
in the first slice, and not a requirement to preserve internal RuntimePlan
or executor APIs. Compilation may use the existing parser, linker, SQL policy,
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

Optional generated boundary entries own untrusted-input validation and defaults,
transport-safe error formatting, and compatibility conversions where selected.
These entries must not be dependencies of a bare query import. The bare query
must not recursively scan JSON, construct validators, revalidate known database
rows, normalize errors across databases, or require universal row decoding.
JSON parsing at a transport cannot produce cycles; direct in-process values are
owned by their application caller. Input bounds still belong at the actual
external boundary. Arbitrary JSON defaults and computed result types must be
handled explicitly by that boundary rather than assumed from TypeScript.

Driver-native PostgreSQL types and SQLite/D1 types need not match, except for
declared date-time and date outputs (below), which the SQL formats. That does not
justify overriding every PG type parser or adding a generic decoder to the bare
query. Authored output names should be emitted into SQL where valid, avoiding
an extra per-row projection merely to repair names already known at generation.

Declared authorization, ownership/TTL SQL policy, explicit OCC and atomic writes
remain required. Generate them as the native application would implement them.
Transaction rollback and uncertain COMMIT handling must still preserve data-loss
protection and client disposal responsibility; native errors must not be exposed
to HTTP users without application-boundary handling. Removing generic error
normalization does not authorize dropping transaction outcome evidence.

**Implementation:** default `generated.ts` now binds driver-native parameters,
returns native rows without a projection/decoder and preserves native database
errors. It imports no Zod and performs no input/output validation or JSON scan.
Auth/OCC failures and uncertain transaction outcomes remain explicit generated
checks. SQL policy and atomic transactions are preserved.

**Single-statement writes:** a Procedure with one statement is atomic on its own
and runs in autocommit, with no BEGIN/COMMIT on PG or native transaction on Bun
SQLite. A row-classified statement touches at most one row (one-row INSERT or
unique `id =`), so a failed count check after autocommit has changed nothing.
On PG it runs at the server's default isolation, not SERIALIZABLE: a concurrent
OCC loser re-evaluates its `version =` predicate, matches zero rows and returns
`CONFLICT` instead of SQLSTATE 40001. A server ErrorResponse (SQLSTATE and
severity) is a known rollback and is rethrown natively, except connection,
resource and shutdown classes (08, 28, 53, 57, 58, XX), which, like any failure
without a server response (lost socket), are `OUTCOME_UNKNOWN`. SQLSTATE is
`errno` on Bun.SQL and `code` on node-postgres. Multi-statement Procedures run in
`begin("isolation level serializable", ...)`: a failure before the callback
returns was rolled back by `begin`; only a failed COMMIT is classified as above.

**Checked removed (2026-10-11):** the optional `checked` boundary (`--checked`,
`checked.ts`, Zod validators, scalar codecs, failure envelopes) is gone. It
duplicated the bare query and held PostgreSQL to node-postgres for type OIDs.
Validation, defaults and error redaction belong to the application boundary;
`databaseError` stays exported from contracts as an optional redaction helper that
generated code never imports.

**Date-time wire form:** a View output that is a declared `date-time` column
(including `created_at`/`updated_at`) returns the handbook's wire form, an ISO
string in UTC with six fractional digits; a declared `date` returns `YYYY-MM-DD`.
The generator wraps those SELECT items before the dialect's own printer prints them
(`to_char` on PostgreSQL, `strftime`/`date` with floor arithmetic on SQLite), so the
database formats them and no row decoder runs. Bun.SQL's `Date` would drop
microseconds. Computed values (`now()`, `date_trunc`, `CAST`, aggregates) carry no
declared type and stay driver-native, as the handbook says for `now()`. Other
declared scalars are driver-native.

Driver-ready JSON parameters are text on both targets: node-postgres treats a
JavaScript array as a PostgreSQL array, so native JSON binds must be serialized by
the application. Bare PG SQL declares each JSON parameter as text
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

Application handlers own business rules and before-hook side effects. Declared
hook ordering and veto behavior must be preserved when implemented; no sandbox,
implicit hook OCC, lock wait, or behavior analyzer is added. An unsupported guard,
hook, lifecycle, reader shape, or feature must produce an actionable generate
error rather than silently execute without its contract. This experimental
package cannot replace 0.2 until the compatibility ledger is complete.

PostgreSQL session prerequisites move to native deployment configuration, not
a replacement runtime boot. Generated `postgresRequirements` data records the
baseline defaults: ISO date text, postgres intervals, UTC casts, standard
strings, exact float text and a 10-second native statement limit. ROLE/DATABASE
settings are required with Hyperdrive pooling; application session SETs must not
be assumed persistent. Stricter positive limits are valid; the old explicit
unbounded policy remains an application decision. No request-time verification,
connection manager or timeout/retry scheduler is introduced.

Storage migrations are explicit deployment artifacts. No request or module import
may converge storage or inspect every schema. Optional Better Auth, REST, MCP,
Admin and UI stay outside the query core. Preserve their public behavior as they
are added; do not make a read import their entire composition.

## Architecture and acceptance

`kernel <- domain <- usecase <- infrastructure`. Kernel contains portable
contract primitives only. Domain owns generation inputs, target declarations
and pure source emission. Usecase orchestrates generation. Infrastructure reads
files and assembles the existing build-time compiler/dialect. Host imports in
emitted strings are output, not generator dependencies.

Every supported feature needs a side-by-side semantic test against independently
written native SQL on the same engine and fixture. Compare SQL/bind work, full
results, errors, and committed state. Performance comparisons must match scope,
validation, transactions and response shape. Measure warm and cold separately,
retain raw paired samples, report median/p95 plus uncertainty, and do not infer
cloud parity from local Wrangler. No artificial delay or weakened oracle.

Existing ADRs remain historical and continue governing the old package. For Next,
this decision supersedes only the old interpreter/plan-at-runtime topology and
ADR-0044's seeded-executor path. Other 0.2 observable specifications are the
compatibility source until explicitly amended here. No permanent dual engine,
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
time zones are an open compatibility item, not implicitly supported by this slice.
