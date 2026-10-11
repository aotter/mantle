# Next first-slice correctness and architecture review

Reviewed source on 2026-10-11 against baseline `6fda2dfd`; the first frozen implementation was `d3f5128c`. This is a source review of the experimental four-target slice. It does not certify formal benchmark results or full 0.2 compatibility. See [compatibility ledger](compatibility.md).

## Findings resolved and verification

The PostgreSQL COMMIT classification finding is resolved. Known server rejections
(`40001`, `40P01`) retain the native resource-failure classification after one
ROLLBACK attempt. Transport/no-state/shutdown failures retain OUTCOME_UNKNOWN;
failed cleanup preserves both causes and requires application-owned client
discard. Official-client fault injection exercises these branches; actual native
applications additionally verify atomic rollback and physical committed state.

The SQLite UTC artifact finding is resolved. `_mantle_tz` includes its native
UTC offset row beginning at `-9007199254740991`; the safe timestamp domain is
covered. A fresh-database calendar regression and all four native applications
verify UTC day lowering against independent SQL and fixture values. Regional
transition history remains outside this slice.

Native PostgreSQL session requirements are explicit deployment preconditions.
The generated `postgresRequirements` export is plain data for the application,
not a boot verifier or connection manager. Native ROLE/DATABASE configuration
must preserve ISO dates, postgres intervals, UTC cast semantics, standard strings,
exact float text and the default bounded statement timeout. Hyperdrive's pooling
must not be assumed to retain application session SETs. This resource trust
boundary is documented rather than reintroducing per-request configuration work.

## Earlier findings addressed in current source

- PG statements now request raw official-driver text and decode with native field OID/type modifier. This avoids default node-postgres Date conversion, lost timestamp precision, safe int8 strings and unscaled numeric aggregate differences. Views use generated column positions; duplicate/dynamic output positions are refused. Procedure rows retain native result-field decoding.
- PG execution and COMMIT failure paths are separated. A failed rollback preserves both causes; transport COMMIT uncertainty is reported as `OUTCOME_UNKNOWN`; known server rejection is classified after cleanup. Messages explicitly require discarding the client. The generated function does not own an application-supplied Client/PoolClient: host wiring must actually discard/end it on those paths and must not reuse a failed client. This ownership remains a native-app test obligation.
- Procedure output validation now uses `OUTPUT_VALIDATION_FAILED` and does not expose its unexpected value. Output checking still occurs after native commit, matching the baseline boundary.
- Generated string maximum-length checks abort subsequent pattern checks. This restores the overlong-input safety boundary without adding another validator interpreter.
- Value-safety traversal now runs inside the validation exception boundary, so throwing getters do not escape as raw application errors.
- Database error classification wraps native failures in safe contract errors, including SQLite/D1 assertion conflicts and PG SQLSTATE failures; original errors remain internal causes.
- Infrastructure now supplies compiler-resolved View output keys and refuses ambiguous output position metadata instead of emitting unsafe fixed-position decoding.

At the frozen implementation, independently rerun Next checks passed 22 tests / 150 assertions, strict generated consumers on all four targets and bundle-graph exclusion of the old engine. Actual local applications passed 21 semantic checks each (84 total). These checks establish the exercised SQL slice, not complete 0.2 compatibility or performance equivalence.

## Contracts checked directly

SQL Procedure output is `{ results: rowsPerStatement }`, as in baseline `createRuntime`. A row-classified statement expects one affected row; set statements do not acquire an invented one-row expectation. D1 places its count assertion in the same native batch. Bun SQLite checks the RETURNING row count (or `run().changes`) inside its native transaction. PG checks `rowCount` before COMMIT. A later assertion failure therefore remains inside the batch transaction boundary. Single-statement Procedures skip the transaction: the statement is atomic and a row op changes at most one row (see contract.md, "Single-statement writes").

Declared authorization runs before input/database work. Each predicate still requires a user caller; a system caller does not satisfy it. Only the explicit system branch selects trusted SQL. Public Views use public-mode SQL even for system callers, preserving the distinction between published visibility and trusted mode. Caller UID and role bind values are operation-local, not mutable shared state. Scope SQL remains the existing compiler's generation output.

Trigger, ref-handler and guard declarations are refused rather than omitted. Publishing mutation declarations are also refused pending native lifecycle support. The ledger explicitly leaves those features open. Full-row Views are a new limited API, not an implementation of Store pagination; that distinction is now documented rather than hidden by the fixture's array-shaped expected values.

The initial DDL helpers are build-time SQL emitters, not request-time convergence. PG emits authored indexes rather than assuming an Admin surface. Existing-database migration, timezone configuration and selected optional surfaces are not proved by this initial artifact and remain separate ledger work.

## Architecture / Ponytail review

The generated path is concrete SQL and functions with native driver calls; the old compiler is a build-time dependency. Small scalar/diagnostic helpers do not reintroduce RuntimePlan dispatch. The source contains no replacement pool, lock waiter, execution registry or retry scheduler. Application ownership of PG resources avoids a second connection manager.

The first slice remains narrower than the full goal: official Zod constructors still parse values, ref handlers and dynamic readers are absent, and no optional Auth/REST/MCP/Admin/UI composition is generated. These are explicit open compatibility responsibilities, not evidence that the architecture is a complete replacement.

No additional P1 scope/auth or transaction-order defect was found in this source pass. Known COMMIT rejection and timezone regressions passed. Further source changes require a fresh exact-head native run. Performance acceptance is reported separately; this review does not certify it.

## Final source and check evidence

Earlier emission behavior was reviewed at `b54e0672`; `d5936122` adds only the
Worker clock caveat. Astra verified the actual draft PR's remote `d5936122` head;
the independent 6.1 Sol correctness/Ponytail review found no new actionable defect.
Mapped output-name collisions now fail generation. Input names are resolved at
generation and bind directly from validated input; row keys are static and decoder
scratch is row-local. `__proto__` remains an own computed property. Actual SQLite
tests cover repeated authored camelCase inputs, defaults and explicit NULL values.
These emission changes introduce no execution registry or metadata interpreter.

Next build/typecheck and 32 tests / 299 assertions passed, including strict
four-target consumers and bundle/dependency checks. At clean `66122a82`, all four
actual targets passed 21 native semantic checks each, and repeated those checks
during the matched warm run. Cold samples also checked complete results.

Workspace typechecks and the packed original-package Worker reference consumer
passed. The full core run had 1016 passes and one timeout; its entire 42-test file
passed an isolated rerun without changing timeouts. The UI single-worker full run
had 228 passes and two initial-value polling failures; the six-test failing file
passed unchanged in both isolated candidate and baseline runs. This is rerun
evidence, not a claim that a single full UI run was green. Full `pnpm check` still
stops at the baseline-reproduced Cloud helper `plan_stale` mismatch.

See [performance evidence](performance.md) for measured costs and acceptance gaps.

The generation-only PG View simplification at `66122a82` was reviewed independently
by Astra and 6.1 Sol. It flattens only a root identity policy wrapper over one known
physical relation. Explicit exposed-column checks prevent private-column access;
uncertain query shapes retain the original AST. Scope predicates and parameter
numbers remain intact. Actual PG comparisons verify complete rows, OID/type
modifiers, caller/public/trusted modes, TTL, NULLs, ordering, LIMIT and aggregates;
a missing-owner negative control proves the oracle detects leakage. Integration
checks preserve bind recipes, paging metadata and all Procedure SQL. No request
code imports this 51-line helper. Performance benefit is measured separately;
structural SQL simplification alone is not proof of improvement.
