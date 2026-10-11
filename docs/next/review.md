# Next first-slice correctness and architecture review

Reviewed working source on 2026-10-11 against baseline `6fda2dfd`, not a frozen release head. This is a source review of the experimental four-target slice. It does not certify formal benchmark results or full 0.2 compatibility. See [compatibility ledger](compatibility.md).

## Remaining actionable finding

**P2 — Known PostgreSQL COMMIT failures still bypass classification.** The generated COMMIT catch unconditionally reports `OUTCOME_UNKNOWN`. A PostgreSQL SERIALIZABLE transaction may return SQLSTATE `40001` at COMMIT; that is a known server rejection, not a lost acknowledgement. The kernel classifier correctly distinguishes `40001`/`40P01` from no SQLSTATE or class `08`, but the generated COMMIT catch does not use that distinction. Preserve the known native failure classification and cleanup behavior; retain uncertain outcome and client discard for transport/unknown acknowledgement failures. A simulated/native COMMIT rejection regression must distinguish the two paths.

**Timezone artifact fix reviewed; native regression pending.** The initial SQLite artifact now includes `_mantle_tz` and a UTC offset row beginning at `-9007199254740991`. `OFF()` selects the latest transition at or before the timestamp and falls back to zero. The sentinel covers valid safe-integer microsecond binds, and any earlier SQL-derived truncation still yields the correct zero UTC offset. The artifact explicitly supports UTC, not regional transition history. This resolves the missing-relation source defect; the implementing agent is adding a fresh-native calendar-lowering regression. Search and geo auxiliary virtual tables/triggers are included through `desired()`.

## Earlier findings addressed in current source

- PG statements now request raw official-driver text and decode with native field OID/type modifier. This avoids default node-postgres Date conversion, lost timestamp precision, safe int8 strings and unscaled numeric aggregate differences. Views use generated column positions; duplicate/dynamic output positions are refused. Procedure rows retain native result-field decoding.
- PG execution and COMMIT failure paths are separated. A failed rollback preserves both causes; Transport COMMIT uncertainty is reported as `OUTCOME_UNKNOWN`; the known-server-error distinction remains open above. Messages explicitly require discarding the client. The generated function does not own an application-supplied Client/PoolClient: host wiring must actually discard/end it on those paths and must not reuse a failed client. This ownership remains a native-app test obligation.
- Procedure output validation now uses `OUTPUT_VALIDATION_FAILED` and does not expose its unexpected value. Output checking still occurs after native commit, matching the baseline boundary.
- Generated string maximum-length checks abort subsequent pattern checks. This restores the overlong-input safety boundary without adding another validator interpreter.
- Value-safety traversal now runs inside the validation exception boundary, so throwing getters do not escape as raw application errors.
- Database error classification wraps native failures in safe contract errors, including SQLite/D1 assertion conflicts and PG SQLSTATE failures; original errors remain internal causes.
- Infrastructure now supplies compiler-resolved View output keys and refuses ambiguous output position metadata instead of emitting unsafe fixed-position decoding.

These conclusions are based on source inspection. Focused test counts reported by implementing agents are not substituted here for independently rerunning their commands.

## Contracts checked directly

SQL Procedure output is `{ results: rowsPerStatement }`, as in baseline `createRuntime`. A row-classified statement expects one affected row; set statements do not acquire an invented one-row expectation. D1 places its count assertion in the same native batch. Bun SQLite checks changes inside its native transaction. PG checks `rowCount` before COMMIT. A later assertion failure therefore remains inside the batch transaction boundary.

Declared authorization runs before input/database work. Each predicate still requires a user caller; a system caller does not satisfy it. Only the explicit system branch selects trusted SQL. Public Views use public-mode SQL even for system callers, preserving the distinction between published visibility and trusted mode. Caller UID and role bind values are operation-local, not mutable shared state. Scope SQL remains the existing compiler's generation output.

Trigger, ref-handler and guard declarations are refused rather than omitted. Publishing mutation declarations are also refused pending native lifecycle support. The ledger explicitly leaves those features open. Full-row Views are a new limited API, not an implementation of Store pagination; that distinction is now documented rather than hidden by the fixture's array-shaped expected values.

The initial DDL helpers are build-time SQL emitters, not request-time convergence. PG emits authored indexes rather than assuming an Admin surface. Existing-database migration, timezone configuration and selected optional surfaces are not proved by this initial artifact and remain separate ledger work.

## Architecture / Ponytail review

The generated path is concrete SQL and functions with native driver calls; the old compiler is a build-time dependency. Small scalar/diagnostic helpers do not reintroduce RuntimePlan dispatch. The source contains no replacement pool, lock waiter, execution registry or retry scheduler. Application ownership of PG resources avoids a second connection manager.

The first slice remains narrower than the full goal: official Zod constructors still parse values, ref handlers and dynamic readers are absent, and no optional Auth/REST/MCP/Admin/UI composition is generated. These are explicit open compatibility responsibilities, not evidence that the architecture is a complete replacement.

No additional P1 scope/auth or transaction-order defect was found in this source pass. The known COMMIT rejection finding remains actionable; the timezone fix still needs its native regression. Final acceptance still requires the exact-head four native applications, generated-consumer type checks and the independent semantic oracle, with no performance claim from this review alone.
