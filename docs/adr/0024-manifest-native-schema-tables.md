# ADR-0024: Materialize each Schema as a native storage table

**Status:** Accepted

**Date:** 2026-09-18

**Related:** ADR-0010, ADR-0011, ADR-0019, ADR-0020, ADR-0022, ADR-0023

## Context

The SQLite adapter currently stores every Schema row in one `entries` table.
Business fields live in a JSON `data` column. Schema indexes add generated
columns and partial indexes to that shared table, and Schema-shaped SQL views
project JSON fields back into columns.

That layout made the first dynamic runtime small, but it is now the wrong
authority for a manifest-built system:

- a successfully built Manifest already fixes every Schema and field type;
- generated columns for every historical indexed field accumulate on one
  table, while D1 allows at most 100 columns per table;
- native SQL, inspection, export, and migration tooling see an implementation
  envelope instead of the authored data model;
- application migrations and Mantle's canonical `entries` migrations form two
  persistence systems;
- the compatibility layer is now larger than direct table CRUD.

Mantle has not shipped a stable storage format. Keeping the generic table for
downward compatibility would create the dual path this change is intended to
remove.

## Decision

### One physical table per Schema

The SQLite/D1 storage adapter materializes every compiled Schema as a quoted
native table. The table contains:

- Mantle columns: `_mantle_id`, `_mantle_status`, `_mantle_version`,
  `_mantle_created_at`, `_mantle_updated_at`, and `_mantle_author_id`;
- one column for every top-level Schema property;
- native indexes for every `indexes` and `uniqueIndexes` tuple.

Single scalar JSON Schema types map to SQLite affinities: string to `TEXT`,
integer and boolean to `INTEGER`, and number to `REAL`. Objects, arrays, unions,
and otherwise polymorphic values use `TEXT` containing canonical JSON so a
round trip cannot change their JSON type. Nullable values use SQL `NULL`.

Business columns remain nullable at the database layer. Mantle allows an
incomplete authoring draft; Runtime validation enforces required fields when a
record becomes complete or when an operational Schema is written. An optional
nullable property reads as `null` when its column is null. This is the v0.1
native-table contract; it intentionally does not preserve a distinction
between an absent optional nullable field and an explicit null.

Schema names and field names remain authored wire names and are always SQL
identifier quoted. A Schema table uses its authored Schema name. SQLite
preparation rejects collisions with selected infrastructure tables or views,
including auth tables; this check belongs to the concrete deployment because
the portable Manifest cannot know which optional infrastructure a host binds.
Internal Mantle tables and columns use the reserved `_mantle_` prefix. The
prefix prevents Mantle metadata from stealing ordinary authored names such as
`id`, `status`, or `createdAt`.

The SQLite adapter no longer creates `entries`, generated field columns, or
Schema projection views. There is no dual write, compatibility view, or
fallback JSON repository.

### The compiled storage plan owns DDL

SQLite preparation lowers the Schemas already present in the sealed
`RuntimePlan` into quoted DDL and prepared queries. A persistence-only
projection of those Schemas has a deterministic storage fingerprint; changes
to Procedures, Views, or Triggers do not create a storage revision. No second
physical-plan model mirrors `RuntimePlan`.

Other adapters map the same Schema manifests into their own native storage.
Runtime continues to consume semantic `EntryRepository`,
`EntryReader`, and `ViewQueryExecutor` ports; SQL remains infrastructure.

Repository operations that address one row carry its Schema collection.
`get(id)` and `readById(id)` become collection-qualified operations. Generated
bindings hide this argument behind Schema-specific APIs. Runtime operations
already know the target Schema from their compiled handler, route, or row
context; callers must not search every table for an unqualified id.

Cross-Schema reads are compiled explicitly from the Runtime plan. There is no
implicit union of all tables. A caller that needs several Schemas invokes the
declared Views or Schema-specific readers and combines their results at the
application layer.

### Migrations are build artifacts

The SQLite build compares a stored source Schema description with the target
RuntimePlan and emits a versioned SQL migration artifact containing:

- source and target storage fingerprints;
- ordered SQLite SQL;
- a checksum over the exact migration content;
- whether the change is expand-only or destructive.

Mantle deterministically emits initial tables and safe additive changes. Field
renames, type conversions, data transforms, and narrowing constraints are
destructive in the pre-beta contract. Cloud rejects them; operators export,
reset or rebuild the database, and import through an application-reviewed
process. Production neither generates nor accepts arbitrary migration SQL.

Preparation records applied migration ids in the existing `_migrations` ledger.
The enclosing immutable artifact checksum protects the ordered SQL,
fingerprints, and target projections. Preparation rejects an unknown source
fingerprint, changed artifact checksum, skipped revision, or target mismatch.
Generated migrations are idempotent and retryable after partial application;
activation and integrity verification run on every attempt instead of being
treated as one-time ledger entries.

Generated migrations quote all identifiers and never interpolate runtime
input. Automatic deployments retain removed fields, indexes, and tables as a
physical superset; logical reads follow the selected plan, while retained
storage keeps the previous Worker rollback-compatible.

### Builder support

Builder keeps its in-memory or IndexedDB semantic adapter for interactive
preview. It does not carry SQLite into portable Runtime.

Each successful build can show a draft-to-draft storage delta for authoring
feedback. It is not labeled as the deployment artifact: only Cloud knows the
last successfully deployed source revision and produces the exact immutable
artifact used by deployment. The publish result shows its source/target
fingerprints, risk classification, ordered SQL, and checksum.
The interactive preview continues to run the real Mantle Runtime over the
existing IndexedDB semantic adapter; it does not carry a second SQLite runtime
or copy preview data into one. Destructive changes remain previewable but are
not deployable on the pre-beta Cloud path.

CI executes generated SQL against SQLite. Mantle Cloud/D1 is authoritative at
deployment: it checks the immutable artifact, migration ledger, source/target
fingerprints, database integrity, and canary before restoring traffic. Running
the same DDL in every Builder browser would duplicate those gates while adding
WASM weight and a second Worker/browser compatibility surface.

Unsaved invalid Manifest edits produce diagnostics and no storage revision.
Intermediate Builder edits do not become production migrations. Deployment
diffs the last deployed storage revision against the selected project revision.

### Cloud runtime and Schema upgrades

Every Cloud deployment pins these immutable identities:

- Mantle runtime release;
- project revision and compiled plan fingerprint;
- source and target storage fingerprints;
- migration checksum;
- application artifact checksum.

Automatic migrations are expand-only and therefore run online. The deployment
sequence is:

1. verify the current tenant D1 storage fingerprint;
2. apply idempotent additive DDL and verify the ledger, marker, and integrity;
3. upload an immutable Worker script named by project revision;
4. run the canary directly against that script and the actual D1 marker;
5. select that revision for the default and custom host routes;
6. record the revision active.

There is no KV maintenance gate: KV propagation cannot drain in-flight writes,
and additive DDL does not need one. Destructive changes stop before deployment.
The old revision script remains addressable, so route failure or operator
rollback selects the previous script without rebuilding or replacing it.

Automatic deployments retain old columns and tables needed by the previous
active Worker. This keeps code rollback valid. Physical cleanup happens only
during a later reset or rebuild. Mantle runtime upgrades use the same mechanism
even when the authored Manifest does not change.

Release and application objects are content-addressed. A retry validates and
reads the same bytes selected by the original operation; mutable release names
are not valid deployment input.

## Consequences

### Positive

- D1, SQLite tools, generated types, and the Manifest describe the same tables.
- Each Schema gets independent native limits, indexes, query plans, and schema
  evolution.
- The shared-table column ceiling and permanent generated-column buildup are
  removed.
- Application migrations and Mantle runtime upgrades use one revision model.
- Removing the compatibility repository leaves less persistence code.

### Negative

- This is a storage-format break and requires coordinated changes across Spec,
  Runtime, SQLite adapters, conformance tests, Builder, and Cloud deployment.
- Unqualified global entry lookups and implicit cross-Schema lists disappear.
- Optional nullable fields no longer distinguish absent from explicit null.
- Destructive schema changes require an explicit export/reset/rebuild/import
  operation outside automatic Cloud deployment.

## Alternatives

### Keep `entries` and improve its generated indexes

Rejected. It preserves the shared table's column ceiling, JSON inspection
surface, and a second schema representation after Manifest build already knows
the physical model.

### Keep `entries` as a registry beside native Schema tables

Rejected. A registry adds dual-write atomicity and stale-index failure modes.
Schema-qualified access removes the need for it.

### Put SQLite WASM in the portable Runtime

Rejected. Runtime already has a semantic storage boundary. Builder can verify
the SQLite lowering as a build check without making every adapter or browser
preview depend on SQLite.

### Generate production migrations at deploy time

Rejected. Deployment must execute an immutable reviewed artifact and remain
deterministic when retried. AI generation belongs before review, not inside a
production mutation.

## How to apply

1. Add the sealed physical storage plan and SQLite DDL lowering.
2. Change semantic row operations to require collection identity and update all
   first-party callers.
3. Replace the shared SQLite repository and View compiler with native-table
   implementations; delete shared-table DDL, views, index reconciliation, and
   compatibility helpers.
4. Update memory and IndexedDB adapters to the new semantic port shape.
5. Add build-time migration diff/artifact inspection, plus SQLite execution in
   CI and Cloud/D1 deployment verification.
6. Pin content-addressed runtime, storage, migration, application, and Worker
   revision identities in Cloud deploys; test initial deploy, additive Schema
   change, runtime-only upgrade, partial migration retry, and route rollback.
7. Update all public storage, Schema, Builder, deployment, and migration
   documentation after the conformance and consumer checks pass.

## Decision review

Reviewed after implementation against ADR-0019, the semantic storage ports,
Builder preview persistence, and Mantle Cloud's retryable deployment state.
The review found and corrected three boundary mistakes before acceptance:

- authored data may legitimately contain `id`, `status`, or `createdAt`, so
  physical envelope columns require the `_mantle_` prefix;
- Builder should expose draft storage risk without pretending it knows the
  deployed baseline; Cloud shows the exact immutable artifact, while CI and
  Cloud/D1 own executable DDL verification and preview stays on IndexedDB;
- Cloud must pin the runtime release and storage artifact selected when the
  operation starts; a mutable current release would make retry and rollback
  nondeterministic.

The native-table path is implemented without a compatibility `entries` table.
Acceptance is gated by the repository consumer check and the Cloud upgrade,
retry, and rollback checks in the ADR's final application step.
