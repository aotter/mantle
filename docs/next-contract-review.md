# Next Day 1 contract review

Review baseline: `6fda2dfd`. This is an acceptance proposal for the generated-code architecture, not evidence that Next already passes it. Source behavior takes precedence over historical ADR examples that describe retired builtin handlers. In particular, ADR-0022's old builtin API is not a requirement to resurrect it.

## Decision boundary

Generate concrete typed functions and target-native SQL from validated declarations. The generated service must execute without interpreting `RuntimePlan`, constructing SQL ASTs, or routing each call through the old generic executor. Reusing compiler policy and official codec/validation implementations does not require retaining their old runtime orchestration. A new metadata table plus an interpreter under a different name would miss this goal.

Day 1 includes Bun SQLite, Bun PostgreSQL, Cloudflare D1 and Cloudflare PostgreSQL. SQLite versus PostgreSQL are two SQL semantics; Bun versus Workers are host/resource-lifetime differences. Four entry files alone do not demonstrate four working targets.

The existing contributor rules describe the 0.2 sealed-plan architecture. Next needs an explicit architecture decision recording the replacement; silently declaring its generated code to be an acceleration of that plan would obscure the intended change. Keep parser/domain code free of platform dependencies and surfaces optional.

## What must remain observable

| Responsibility | Generate-time facts | Request/operation-time obligations |
| --- | --- | --- |
| Schema and SQL | Validate closed grammar, names, relations, input fields, functions, target support, CTE lexical scope, projection lineage; emit DDL, SQL and typed bindings | Bind values through the target codec; never interpolate values or accept client-selected identifiers |
| Caller/auth | Emit declared predicate checks and guard calls | Resolve verified identity, current role and scopes; distinguish absent credentials from invalid credentials; invalid bearer must not fall back to a cookie or anonymous access |
| Visibility | Inject each physical relation's scope, TTL and public publishing predicates, including CTEs, joins, correlated subqueries and conflict branches | Bind this caller and the operation's clock; retain predicates for every read/write path, including ref-handler helpers and internal invocations |
| Validation | Emit concrete validators where their semantics are supported, otherwise explicitly retain an official validator | Check untrusted input, apply defaults/transforms consistently, validate Procedure output, bound cyclic/deep values and keep diagnostics safe; TypeScript types do not validate network input |
| SQL Procedures | Emit statement order, row/set classification, expected counts, codecs, explicit version predicates and RETURNING projections | Execute the complete SQL batch atomically on one native transaction/batch; abort on failed expectations; return only the authored results |
| Ref Procedures | Generate typed handler calls and their declared dependencies | Preserve the caller, cause, input/output validation, guard ordering and nested-invocation limits; application code owns its independently committed effects |
| Publishing | Resolve state-transition rules and affected Schema at generation | Check actual current state and required complete entry; pin the checked version when publishing requires it; protect published entries |
| Lifecycle | Resolve named triggers, order, operation and event projection | Observe the appropriate row, invoke before hooks before the outer batch, then after hooks only for committed affected rows; preserve caller/cause and event identity |
| Paging | Emit each accepted ordering, projection and keyset predicate shape | Validate limit/cursor and bind current key values, including NULL patterns; preserve complete order, ties, direction, authored LIMIT and native engine ordering |
| Storage readiness | Emit target DDL/migrations/index ownership | Apply migrations safely, retain fingerprint/readiness checks, fail on unsupported/colliding state; never treat a matching marker as proof of unrelated Auth tables |
| Surfaces | Generate optional route/tool/interaction catalogs and descriptors | HTTP/MCP/Admin must call the same checked Procedure/View functions, preserve role filtering, wire envelopes, output checks and redaction |

Additional 0.2 responsibilities that cannot disappear without an explicit scope decision: typed Schema readers (`get`, `first`, `find`), Store row and set writes, scoped unique indexes/upsert, publishing and translation constraints, TTL visibility and maintenance, full-text/geo operators where supported, schedule/HTTP/lifecycle Triggers, safe diagnostics and observation/cause propagation. Optional Auth, Web, Admin, MCP, site/config/media/email and UI composition must either continue to work against generated functions or be visibly declared unavailable. A smaller SQL demo is not an equivalent generated application.

## Security and semantic blockers

1. **Public is not trusted.** Existing `bindFor` maps a user/anonymous caller to caller mode and only host/system access to trusted mode. A public View changes publishing visibility; it does not authorize bypassing Schema ownership. Scope fields and private/system columns must not leak through `*`, joins, RETURNING, hook-only hidden columns or CTE projection aliases. Scoped inserts derive ownership from the verified caller; caller-chosen IDs and conflict targets cannot probe another owner's rows.
2. **Generated entry points need an explicit trust boundary.** Unexported native helpers may assume already-validated data; exported request/handler entry points may not. HTTP body fields cannot construct a system Caller. A shared mutable caller/bind array or cached request result would create cross-request leakage. Application-authored server code is trusted, but that does not justify promoting its incoming arguments to host privilege.
3. **Authorization guards are not before hooks.** Guards see validated input, read-only caller-bound access and no nested mutation invocation. Before hooks instead have normal caller-bound Store and nested invocation capability. Both must preserve declared ordering and the original caller; no hidden privilege escalation through direct generated helper calls.
4. **Before hooks do not create a business transaction.** Their snapshots are observations. A hook that throws prevents the outer SQL batch, but earlier hook writes remain committed. Do not inject implicit OCC just because a hook exists. Publishing's separate state/version protection and explicitly authored OCC remain. Do not parallelize ordered hooks or replace their event rows with post-write rows.
5. **Atomicity has an exact boundary.** A SQL Procedure's statements and affected-count assertions commit together. A later failure rolls back earlier SQL mutations. Ref-handler calls and hooks can perform separate native transactions; there is no ambient cross-call rollback promise. At baseline, Procedure output validation occurs after execution: invalid output is rejected/redacted, but does not roll back a committed batch. Next must not claim otherwise accidentally.
6. **No stale-token substitution or automatic retry.** Explicit caller-observed versions stay in the actual write predicate; a fresh pre-read version cannot replace them. Zero-row/expected-count failures remain conflicts, without revealing whether an invisible row exists. Native serialization/deadlock errors are surfaced. A lost COMMIT response is uncertain outcome, not safe-to-retry failure.
7. **Native RETURNING and affected rows are different facts.** Preserve caller output separately from lifecycle rows. Trigger-suppressed mutations must not fabricate after events or counts. TTL sweeping reports scanned candidates and advances its candidate cursor even when fewer rows are deleted; DELETE RETURNING alone cannot replace that contract.
8. **Paging cannot quietly become OFFSET or first-page-only.** Test NULLs, duplicate sort values, mixed directions, joins, grouped outputs, more than one page and authored limits on both engines. Uniqueness proof belongs to the generated query's actual root result, not a dependency's fake Schema metadata. Baseline View cursors are bound to the View name, not cryptographically to caller or input; do not claim stronger security. Scope is re-enforced independently on every page.
9. **Concrete does not mean finite requests.** Staff search/filter values and Schema-reader predicates are dynamic. Generate a small legal construction strategy or explicitly constrain the new public API with a migration decision; silently accepting only a few measured shapes is not parity. Never emit an old interpreter fallback and call the generated path complete.
10. **Output validation cannot be a pass-through bridge.** MCP's schema library and the generated application must really validate their respective boundaries. Preserve official defaults, optional/nullable distinctions, unknown keys, error paths, safe output redaction and getter behavior for JavaScript callers. Unsupported schema keywords must fail generation or use an explicitly documented correct path, not be ignored.

## Native host contract

- Bun SQLite uses native cached reads and native atomic transactions. With Better Auth, preserve separate file-backed WAL handles for Store and Auth and native foreign keys. Do not share an asynchronously busy handle or pretend separate `:memory:` handles share data.
- Bun PostgreSQL uses the native Pool; one checked-out client owns a SERIALIZABLE SQL batch. Workers PostgreSQL uses native Client acquisition within supported request/operation lifetime. Release/end/rollback/discard behavior must preserve uncertain outcome; no Mantle pool, SQL scheduler or request-session manager.
- D1 uses native binding reads and atomic batch operations, including count assertions within the same batch. Local Wrangler evidence is not a cloud latency or Hyperdrive-equivalence claim.
- Do not normalize dialect-native numeric, temporal, NULL ordering, collation or planner behavior to make cross-engine tests look equal. Preserve the documented codec contract for each engine, including dates, timestamps, JSON, numeric precision and booleans.

## Naming and minimum acceptance

No `asProcedure` literal exists in the baseline `packages` or `docs` source search. The existing public execution entry is `invokeProcedure`; caller binding is `store.as(caller)`, and ref handlers use `ctx.invoke`. If Next introduces `asProcedure`, define whether it wraps a handler, binds a caller, or exports an operation. It must not silently mean trusted bypass, automatic transaction or unchecked output. This is a new API decision, not an existing compatibility requirement.

The smallest credible Day 1 gate is one generated generic application executed natively on all four targets, with differential assertions against 0.2 on each target independently:

- User A/B, anonymous and host/system controls; stale/invalid credentials, current role changes, guarded nested calls; deliberately unscoped negative control that proves the test detects leakage.
- SQL and ref Procedures; a successful multi-statement write, stale OCC, final-statement failure/rollback, unique collision and output-validation failure with committed-state verification.
- Before-hook ordered side effects plus outer veto; after-hook failure without changing committed results; publishing transition/version race; suppressed-delete trigger and TTL cursor behavior.
- First/deep/all pages with NULL/ties/mixed direction, search and filters; full result comparison, no ignored fields except unavoidable generated identities under a documented normalization.
- Runtime invalid-value corpus and complete transport responses; optional selected Auth/Admin/MCP routes exercised through their real official adapters rather than stub callbacks.
- Clean generated build and bundle inspection proving no old RuntimePlan interpreter/executor dependency; exact packed CLI generation reproducibility; immutable artifacts and matched schema/data/clock for any timing claims.

All tests above are proposed acceptance criteria, not tests run by this review. Current work must publish explicit omissions rather than label unimplemented optional surfaces or unsupported declared features compatible.

## Ponytail assessment

Keep the parser/linker and policy compiler as generation tools. Emit named functions that use native drivers and small existing codec/diagnostic helpers. Delete the need for a runtime plan registry, compiled-program cache and generic operation dispatcher from the generated path. Avoid a second validator interpreter, capability manager, shape scheduler, query optimizer, custom retry layer or cross-engine transaction facade. Share source-generation rules where useful; do not hide concrete generated operations behind a replacement universal runtime.

Source anchors: `core/runtime/createRuntime.ts`, `core/runtime/auth.ts`, `core/sql/run.ts`, `core/sql/policy.ts`, `core/store/createStore.ts`, `core/store/cursor.ts`, `core/caller.ts`; ADR-0040/0041/0044 and current handbook references. This review changes documentation only.
