# Next compatibility ledger

Baseline: `6fda2dfd`. This ledger distinguishes the full 0.2 compatibility goal from the first generated native execution slice. Issue #1459 remains open. The experimental package is not a replacement release.

## First slice and evidence policy

The first slice generates typed SQL View and inline SQL Procedure functions for Bun SQLite, Bun PostgreSQL, Cloudflare D1 and Cloudflare PostgreSQL. View functions return the complete rows of the authored SQL, subject to its own LIMIT. They are **not** the 0.2 Store View paging API: there is no default page limit, cursor envelope, staff search/filter options or automatic page continuation in this slice. Callers must not substitute them transparently for `store.view`.

There is no optional application composition in this slice: no generated Auth resolver, REST/MCP/Admin routes, UI, ref-handler dispatch or lifecycle/schedule wiring. Passing a trusted Caller from application code tests SQL policy; it is not proof of end-to-end authentication. Four target generators are implemented in source; native test results must separately identify the exact generated artifact and targets actually exercised. This document does not certify unrun tests or performance.

The revised [query responsibility decision](contract.md#revised-query-responsibility-decision-2026-10-11)
makes bare typed queries an application-trusted native API. Input/output validation,
legacy scalar conversion and safe transport errors belong to selected boundary
entries. The checked slice was removed on 2026-10-11; bare queries use driver-ready binds
and native rows/errors, with declared date-time and date outputs formatted by the
SQL. Rows below that require validation or legacy conversion belong to the
application boundary. This is
an explicit API responsibility change, not completed implementation or permission
to omit validation at external application boundaries.

Statuses below describe implementation scope, not a passed compatibility gate:

- **Slice:** present in the initial implementation; acceptance remains conditional on semantic tests and review fixes.
- **Refused:** an unsupported declaration is rejected during generation. This protects correctness but does not complete compatibility.
- **Open:** absent from the slice or not yet proved; must be implemented, explicitly refused where reachable, or changed through an explicit compatibility decision.

Every follow-up must name its target matrix, acceptance tests and owner before claiming completion. The issue owner coordinates open rows; source owners are the generator for emitted behavior, contract primitives for portable checks, and infrastructure for build/deployment/host wiring. No feature may disappear from this ledger merely because the procurement fixture does not exercise it.

## Full observable inventory

| 0.2 responsibility | First-slice status | Remaining acceptance / owner |
| --- | --- | --- |
| Closed v2 parsing/linking and target SQL validation | Slice: existing compiler at generation | Invalid declaration/SQL diagnostics; no runtime compiler import. Generator/infrastructure |
| Concrete emitted SQL and typed functions | Slice | Build all four generated consumers; inspect bundle graph for old runtime/plan/executor; reproducible generation. Generator |
| Native SQL dialect behavior | Slice | Per-engine codec, NULL, collation, CTE, alias and expression semantics; no cross-engine normalization. Generator/contracts |
| Caller mode, trusted system mode, declared auth predicates | Slice | User/anonymous/system matrix; denied access before SQL; system satisfies no user predicate. No wire can choose trusted mode. Generator |
| Credential verification, fresh roles/scopes, OAuth/session behavior | Open; no Auth composition | Official provider wiring; invalid credential never falls back; role/grant revocation and complete Auth responses. Infrastructure |
| Scope/TTL/public publishing policy | Slice via compiled policy | Every physical relation, nested query, conflict branch and public read; private projection and negative controls. Generator |
| Input validation and defaults | Slice: generated official Zod constructors for supported schemas | Full supported-schema differential corpus, accessor/cycle/depth behavior and bounded regex safety; unsupported keywords must refuse. Contracts/generator |
| Procedure output validation and safe errors | Slice, under review | Correct OUTPUT code and redaction; defaults/cloning; committed-state test for validation failure after execution. Contracts/generator |
| Typed parameter encoding and row decoding | Slice, under review | Integer precision, numeric scale, JSON, bool, temporal precision, NULL/optional fields and computed outputs on both engines. Generator/contracts |
| Full-row SQL Views | Slice; intentionally distinct API | Complete projected result/order and authored LIMIT, not page-envelope parity. Generator |
| Store View paging and opaque cursors | Open | First/deep/all pages, NULLs/ties/mixed directions/grouping/joins; query binding; default/max limits; root result uniqueness. Generator |
| Staff View search and filters | Open | Declared fields, escaped LIKE, typed equality, combined filters and cursor shapes. Generator |
| SQL Procedures, row/set operations, RETURNING | Slice | Ordered full result arrays, no-RETURNING empty arrays, trigger-suppressed counts, whole-batch rollback. Generator |
| Explicit OCC and expected affected counts | Slice, under review | Caller-observed token, row-zero conflict, foreign-row nondisclosure, native in-transaction assertions; no retries. Generator/contracts |
| Scoped inserts/upsert and native uniqueness | Slice via compiler/DDL | Ownership injection, generated identities, scoped conflict targets, create race and expired-row policy. Generator/infrastructure |
| PostgreSQL session preconditions and bounded statements | Slice: explicit native deployment requirements | ISO/postgres text formats, UTC casts, standard strings, float precision and native default timeout; Hyperdrive role/database configuration; no per-request settings manager. Infrastructure/host |
| Native transaction/error outcomes | Slice, under review | D1 atomic batch, SQLite native transaction, PG SERIALIZABLE via Bun.SQL-shaped begin() (single-statement Procedures autocommit at default isolation; node-postgres through an application adapter); uncertain COMMIT and rollback failure, safe classification, disposal ownership. Generator/contracts/host |
| Ref Procedures and typed handler context | Refused | Caller/cause propagation, input/output checks, application side effects, nested invocation depth. Generator |
| Dynamic authorization guards | Refused | Validated input, read-only Store/no-invoke, same caller and guard ordering. Generator |
| Before and after lifecycle hooks | Refused via Trigger rejection | Ordered visible snapshots, veto versus independent commits; after events only for committed affected rows; stable event identity. Generator |
| Publishing writes and complete-entry state transitions | Refused | Draft/edit/protected-delete transitions; full-entry checks and independently required version pinning. Generator |
| Translation constraints and translated entry operations | Open | Parent/group constraints and publication semantics; refuse reachable unsupported writes in interim. Generator |
| Typed Schema readers (`get`, `first`, `find`) | Open; no reader API | Predicate grammar, ordering, bounds, metadata decode and page behavior; finite benchmark shapes are insufficient. Generator |
| Store JSON row/set mutation API | Open; inline SQL is not this API | Projection, write result shapes, caller policy, validation and atomic arrays. Generator |
| TTL maintenance | Open; read visibility alone is insufficient | System-only sweep, candidate count/cursor distinct from deleted RETURNING rows, bounded continuation and hooks. Generator |
| Full-text, geo and other target-specific SQL facilities | Partial compiler availability; geo output refused | Explicit supported matrix, required auxiliary schema/index artifacts and native behavior; refuse omissions. Generator/infrastructure |
| HTTP and schedule Triggers | Refused via Trigger rejection | Validated invocation, authenticated source, schedule readiness and cause/depth rules. Infrastructure/generator |
| Initial schema DDL | Slice: explicit SQL artifact | Native CHECK/unique constraints, system assertion table, auxiliary structures and correct target application. Infrastructure |
| Existing-storage migration/convergence | Open | Ownership ledger/fingerprint checks, collision/data-loss protection, partial migration recovery; initial CREATE is not convergence. Infrastructure |
| Stable diagnostics and observation/cause | Partial boundary errors | Safe codes/paths/failure facts across transports; preserve uncertain outcomes and internal-only causes/SQL; no accidental native error exposure. Contracts/surfaces |
| REST/Web public Views and HTTP Procedures | Open; no composition | Existing envelopes, authorization, bounds, paging, caching/response contracts and complete body parity. Surfaces |
| MCP tools/resources/apps | Open; no composition | Actual official SDK validation, catalogs, role filtering, full results/error envelopes and resource metadata. Surfaces |
| Admin operations, bootstrap, CSV and interaction bindings | Open; no composition | Scoped complete responses, paging/CSV, caller-observed OCC binding and recovery, role filtering. Surfaces |
| Site/config/media/email services | Open; no composition | Existing validation, storage/provider error semantics, partial deletion recovery, no invented cross-store transaction. Infrastructure/surfaces |
| Optional UI and generated application setup | Open; no composition | Typed consumer imports, optional peers, interactions/accessibility and selected host wiring. Infrastructure/UI |

## Gates before expanding claims

First-slice acceptance requires actual generated applications on all four targets, matched native work and complete result/state assertions. Native comparison alone is not a 0.2 contract oracle: verify typed outputs and failures against the baseline on the same engine without coercions that hide discrepancies. Record unresolved findings and refusals explicitly.

Before claiming a row compatible, add meaningful adversarial evidence, including foreign ownership, invalid inputs, later-statement rollback, stale OCC, and native failure paths where relevant. Before replacing 0.2, resolve the entire ledger or publish explicitly approved breaking API decisions. Unsupported-feature refusal and benchmark speed are neither proof of compatibility nor permission to close the full issue.
