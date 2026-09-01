# ADR-0020: Builtin Handler Contracts and Matched Upsert

**Status:** Accepted

**Date:** 2026-09-01

**Related:** [#765](https://github.com/aotter/mantle/issues/765),
[#766](https://github.com/aotter/mantle/issues/766),
ADR-0008, ADR-0010, ADR-0014, ADR-0019

## Context

Mantle Procedures can bind to standard entry-mutation operations using `handler.kind: builtin` (e.g. `create`, `update`, `delete`, `archive`, `upsert`).

Before this ADR:
1. **No static contract validation**: Procedure input JSON Schema contracts were not statically verified against the requirements of their builtin operations during manifest linking (`ValidateManifestsUseCase`). Invalid contracts (e.g. `update` missing `id` or `expectedVersion`, nullable union types like `type: ["string", "null"]`, or `archive` on operational Schemas) were only caught at runtime via `requireField` or runtime assertions, causing valid-looking manifests to fail during invocation.
2. **Missing natural key upsert (`handler.match`)**: Built-in `upsert` only supported legacy ID-based lookup (`id` + `expectedVersion`), requiring client knowledge of internal system IDs. Real-world domains require idempotent upserts matching natural keys (such as `slug`, `siteKey`, or composite unique keys like `[slug, locale]`).
3. **Concurrency and race conditions**: Matched upsert must handle concurrent writers safely. When two concurrent writers miss preflight lookup, storage-level unique constraints must catch the conflict and surface structured `CONFLICT` diagnostics without retrying or corrupting entries.

## Decision

### 1. Static Contract Validation for Builtin Handlers

Manifest linking (`ManifestGraphValidator.ts`) now validates Procedure `input` schemas against the requirements of their builtin `op`:

- **Diagnostic Code**: `BUILTIN_HANDLER_CONTRACT_INVALID` (phase: `validate`).
- **Common rule**: `input` must be an `object` schema (`type: "object"`).
- **`update`**:
  - `properties.id` must be strict, non-nullable `string` (`type: "string"`, not union array, not `nullable: true`).
  - `properties.expectedVersion` must be strict, non-nullable `number` (`type: "number"`, not union array, not `nullable: true`).
  - `required` must include both `"id"` and `"expectedVersion"`.
- **`delete`**:
  - `properties.id` must be strict, non-nullable `string`.
  - `required` must include `"id"`.
- **`archive`**:
  - Target Schema must have `lifecycle: "publishing"` (operational Schemas have no lifecycle transitions and cannot be archived).
  - `properties.id` must be strict, non-nullable `string`.
  - `required` must include `"id"`.
- **`upsert` (legacy mode without `match`)**:
  - If either `id` or `expectedVersion` is declared, both must be declared with strict string and number types respectively. Neither is in `required` because the create branch accepts new entries without IDs.

### 2. Matched Upsert Grammar and Static Contract (`handler.match`)

Procedures with `op: "upsert"` may declare `match`:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: upsertArticleBySlug
spec:
  input:
    type: object
    properties:
      slug:
        type: string
      title:
        type: string
      body:
        type: string
    required:
      - slug
      - title
  output:
    type: object
  handler:
    kind: builtin
    op: upsert
    schema: articles
    match:
      - slug
```

**Grammar and parser validation rules (`ManifestParser.ts`)**:
- `match` is allowed in `spec.handler` only when `handler.kind === "builtin"` and `op === "upsert"`.
- `match` must be a non-empty array of unique, non-empty field names.

**Static manifest validation rules (`ManifestGraphValidator.ts`)**:
- `handler.match` must exactly match one declared unique index in the target Schema's `spec.uniqueIndexes` (matching length, field names, and order).
- Every field in `handler.match` must be declared in the target Schema's `spec.schema.properties`.
- Every field in `handler.match` must be declared in Procedure `input.properties` and listed in `input.required`.
- Procedure `input` must NOT declare `id` or `expectedVersion` when using `match`.

### 3. Runtime Semantics and Atomic Conflict Handling (`InvokeBuiltinUseCase.ts`)

When executing matched upsert:
1. Extract matching field values from `input`.
2. Query existing entry using `entries.findByDataFields({ collection, fields })`.
3. **If found**: Execute update path (`opUpdate`):
   - Merge input into existing data using `projectUpdateAndStamp`, preserving omitted fields and system bindings.
   - Use `existing.id` and `existing.version` for optimistic concurrency control (OCC).
   - Pass caller's original input to lifecycle hooks (`before_update` / `after_update`).
4. **If not found**: Execute create path (`opCreate`):
   - Project and stamp data using `projectAndStamp`.
   - Set status to `"published"` (if `lifecycle: "operational"`) or `"draft"` (if `lifecycle: "publishing"`).
   - Pass caller's original input to lifecycle hooks (`before_create` / `after_create`).
5. **Concurrency & Race Conditions**:
   - Both update and create operations are wrapped in `withConflictDiagnostic`.
   - Storage-level unique constraint violations (e.g. SQLite `SQLITE_CONSTRAINT_UNIQUE`, Postgres `23505`) and version/status mismatches are converted into structured `CONFLICT` diagnostics (HTTP 409).
   - The runtime does not automatically retry matched upsert on conflict, providing deterministic failure semantics under race conditions.

## Consequences

- **Fail-fast authoring**: Schema and Procedure mismatches are detected during `mantle validate` or test time rather than failing unpredictably at runtime.
- **Strict type safety**: Nullable union types cannot bypass static contract validation.
- **Natural key idempotency**: Clients can author natural-key upsert procedures for ingestion and sync pipelines without managing internal mantle IDs.
- **Safe concurrency**: Concurrent writes are guarded by database-level unique constraints and translated to standard `CONFLICT` diagnostics.
