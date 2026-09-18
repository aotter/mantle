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

Scalar JSON Schema types map to SQLite affinities: string to `TEXT`, integer
and boolean to `INTEGER`, and number to `REAL`. Objects and arrays use `TEXT`
containing canonical JSON. Nullable values use SQL `NULL`.

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
renames, type conversions, data transforms, table removal, and narrowing
constraints require an explicitly authored migration. AI may author that
migration, but the reviewed artifact is immutable deployment input; production
does not ask a model to generate SQL.

Preparation records applied migration ids in the existing `_migrations` ledger.
The enclosing immutable artifact checksum protects the ordered SQL and
fingerprints. Preparation rejects an unknown source fingerprint, changed
artifact checksum, skipped revision, or target mismatch. Every migration is
transactionally retryable. Failed preparation leaves the previous storage
revision active.

Because SQLite cannot make arbitrary destructive schema changes safely with a
single `ALTER TABLE`, destructive changes use create-copy-verify-swap inside a
transaction. Generated migrations quote all identifiers and never interpolate
runtime input.

### Builder support

Builder keeps its in-memory or IndexedDB semantic adapter for interactive
preview. It does not carry SQLite into portable Runtime.

Each successful build also produces the same physical storage plan and
migration artifact used by deployment. Builder verifies its checksum and shows
the source/target fingerprints, risk classification, ordered SQL, and checksum.
The interactive preview continues to run the real Mantle Runtime over the
existing IndexedDB semantic adapter; it does not carry a second SQLite runtime
or copy preview data into one. Destructive changes remain previewable but are
marked not deployable until reviewed migration SQL is supplied in code.

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

Schema-changing deployments use a short maintenance window. The deployment
sequence is:

1. disable tenant traffic and wait for the existing write lease to end;
2. verify the current tenant D1 storage fingerprint;
3. apply and verify the migration;
4. upload the Worker pinned to that target storage/runtime pair;
5. run the canary against the pinned identities;
6. activate traffic and record the revision.

A runtime-only deployment whose storage fingerprint is unchanged may use the
existing live upload path. The maintenance window is the deliberately simple
first contract; measured demand may later justify online migration machinery.

Automatic deployments retain old columns and tables needed by the previous
active Worker. This keeps code rollback valid. Destructive cleanup is a later,
explicit deployment after the previous runtime is no longer a rollback target.
Mantle runtime upgrades use the same mechanism even when the authored Manifest
does not change.

Release objects are content-addressed or version-addressed. A retry reads the
same release and migration selected by the original operation; a mutable
`release/current` object is not valid deployment input.

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
- Destructive schema changes require a reviewed migration and a later cleanup
  deployment.

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
6. Pin runtime, storage, migration, and artifact identities in Cloud deploys;
   test initial deploy, additive Schema change, runtime-only upgrade, failed
   migration retry, and rollback.
7. Update all public storage, Schema, Builder, deployment, and migration
   documentation after the conformance and consumer checks pass.

## Decision review

Reviewed after implementation against ADR-0019, the semantic storage ports,
Builder preview persistence, and Mantle Cloud's retryable deployment state.
The review found and corrected three boundary mistakes before acceptance:

- authored data may legitimately contain `id`, `status`, or `createdAt`, so
  physical envelope columns require the `_mantle_` prefix;
- Builder should expose the exact immutable artifact but not embed SQLite WASM;
  CI and Cloud/D1 already own executable DDL verification, while preview owns
  semantic Runtime behavior over IndexedDB;
- Cloud must pin the runtime release and storage artifact selected when the
  operation starts; a mutable current release would make retry and rollback
  nondeterministic.

The native-table path is implemented without a compatibility `entries` table.
Acceptance is gated by the repository consumer check and the Cloud upgrade,
retry, and rollback checks in the ADR's final application step.
