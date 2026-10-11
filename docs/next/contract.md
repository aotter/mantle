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
PostgreSQL. Workers validation uses local Wrangler only. PostgreSQL uses
node-postgres; SQLite uses bun:sqlite; D1 uses its platform binding. Pool,
connection lifetime, database isolation, locks and retries remain native and
application-owned. Workers PostgreSQL uses an official Client with Hyperdrive's
connection string during the supported request lifetime. No cloud provisioning.

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

The request code is a generated function plus necessary contract checks.
The small contract harness owns only boundary validation and scalar encoding;
it must not own resource scheduling or interpret authored query structures.
Checks for facts already known during generation belong in generation. Validators
are emitted for the schema and initialized on use, not rebuilt per request.
When Auth composition is implemented, it resolves a trusted Caller once at the application entry.
The first slice accepts an application-supplied Caller and does not verify credentials. SQL binds the
caller subject directly; a system caller is application-owned and never wire input.

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
