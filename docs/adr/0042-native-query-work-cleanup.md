# ADR-0042: Remove unnecessary query work at its owner

**Status:** Accepted direction for issue #1428.

**Date:** 2026-10-10

**Builds on:** ADR-0040 and ADR-0041; persistence ownership ADR-0033,
Better Auth ownership ADR-0014 and ADR-0032.

## Decision

Ordinary SQLite-family product reads use the existing native `all`/`first`
ports, with the existing fallback for batch-only drivers. Site configuration,
media reads and individual preparation/catalog reads do not acquire an
immediate write transaction. Writes and atomic metadata snapshots retain
batches. A shared-DB media policy is still read fresh; it is not cached for an
isolate's lifetime.

Warm SQLite preparation reads the native catalog and existing readiness state
before executing no-op system DDL or ledger creation. The fingerprint remains
the existing convergence contract: a matching fingerprint is not a new promise
to detect arbitrary out-of-band changes to authored tables/indexes. Required
system objects must exist with their expected kinds; missing system objects
follow convergence. A missing timezone table rebuilds its transitions even
when the saved zone matches. Product migrations and explicit Auth schema
validation remain separate; concurrent boot and foreign-table refusal remain.

Media sorting is Core-owned SQL. Add an owned migration for
`media_assets(created_at DESC, id DESC)`. The legacy owner-leading index is
not automatically dropped: its old IF NOT EXISTS migration did not prove
ownership of that global name, which could belong to another table.
Keep the numeric media cursor;
OFFSET still costs skipped rows and substring search can still scan.
Migration ledger ownership is required; an existing unledgered index with the
new name is not silently accepted.

Core's cursor lowering may remove a NULL branch only when result nullability
proves it impossible. An inclusive first-key range bound may be added when it
cannot exclude a later NULL segment. Native ordering, authored LIMIT, joins,
ties and mixed directions remain unchanged. PostgreSQL and SQLite planner
behavior are evaluated independently. Authors still own application indexes
and a complete unique ordering; large tie groups can remain expensive.

After-hook hidden RETURNING columns are selected by schema and semantic verb,
including publish, rather than by the mere existence of any hook on a schema.
Author RETURNING and actual triggered after events remain intact. Store row
projection combines decoding and geo reconstruction without a second row clone
or per-call type map; it does not add codec cache machinery.

Admin constructs immutable plan descriptions once per surface; each request
still evaluates caller visibility and reads current entries/relationships.
Independent bootstrap reads use native Promise.all. Post-write rereads and
mutation prereads needed for existing 404/409 classification remain.

A live Mantle OAuth user-grant query may JOIN the user and return its freshly
read role. The verifier passes this proof separately from JWT claims, only
after grant, scopes and DPoP validation. A verified NULL role is distinct from
missing proof; a missing joined user invalidates the grant. Other audiences and
verifiers retain fresh-role fallback. This is not a session cache or a custom
Better Auth adapter.

Invitations use the official Better Auth create API first, including its owner
permissions. Only the pinned official duplicate-email error triggers an
existing-user lookup; existing roles are unchanged. The documented owner
request requirement applies even when the email already exists. Staff COUNT
and complete staff lists remain.

R2 uses native concurrent head reads and array deletion of upload keys after
copying. All heads pass before publication; each get is checked again. Failed
copy/delete cancels owned bodies where needed and attempts cleanup of possibly
published keys, preserving the original error even if cleanup fails. Object
storage is not made transactional. Structural custom R2 bindings must accept
native `delete(string | string[])`; single-key-only test bindings need updating.

## Rejected shortcuts

- TTL selected candidates are not equivalent to deleted RETURNING rows:
  native BEFORE DELETE triggers can suppress some or all deletes. Preserve
  scanned/removed, preview and candidate-derived cursor with the existing
  scan/delete path; no trigger detector or dialect capability manager.
- Publishing preRead/full-entry validation/version pin is not replaced by
  status-only predicates. Ordered before hooks may have independently
  committed effects observed by subsequent hooks.
- No full Program interning, stale media-policy snapshot, machine credential
  prefix inference, JavaScript SQL CAST emulation, request client sharing,
  pipeline, pool manager, retry or stream-scope coordinator.

## Validation

Native WAL writer tests cover site/media reads and already-prepared product
boot. Native catalog plans cover media ordering and cursor range bounds.
Conformance covers semantic hook verbs, native NULL ordering and data decoding.
Regressions preserve suppressed-delete TTL cursors, caller visibility, live
role changes, official invitation errors, complete staff lists and R2 cleanup.
Four local procurement apps, native Bun SQLite/PostgreSQL, the full workspace
check and the exact packed Worker consumer validate integration. No cloud
performance, billing or cross-engine consistency guarantee is asserted.

## 2026-10-10 amendment — Schema readers (ADR-0043)

The rejected shortcut "No full Program interning" (Consequences) is scoped. **Store read shapes are interned** per ADR-0043: each reader shape keeps one `Program`, so the compile, paged-statement and printed-SQL caches hit. **Views, Procedures and writes are not interned** by this decision: a View's `Program` is already the plan's own, a Procedure's and a write's are built per request.
