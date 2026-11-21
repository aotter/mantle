## `packages/mantle/src/build/**`: what can be deleted or shrunk

Nothing was changed on disk or on GitHub.

**How I checked:**
- **Unused exports.** I asked the TypeScript language service (`findReferences`) about every exported symbol under `src/build`. The search covered `packages/mantle/{src,tests,compiler-tests,scripts}` and `packages/mantle-admin/src`. I backed it up with `grep -rlw` over `packages/*/src`, `packages/*/tests`, `packages/mantle/compiler-tests`, `docs/examples` and `scripts`. Scratch scripts: `/tmp/claude-0/-home-user/2a4793ed-0877-51aa-ab4c-ab47e02367c9/scratchpad/refs.cjs` and `exports.mjs`.
- **Public reach.** `src/build` is never a published subpath; `./internal/*` points only at `src/kernel`. The build code reaches the public API in two places:
  - `.` and `./generate` export `GenerateRequest`, which uses `ManifestSourceSet` and `SiteDefaults`.
  - `./describe` exports `AppDescription` and `DescribeTarget`, which use `JsonSchema`, `ProcedureMcpAnnotations`, `PlanRestrict` and `UserFieldSpec`.
- **Seams.** No `build` symbol is in `tests/application-seams.ts`. None of the findings touches those types.
- **Bundle.** Every name in the `compiler.ts` barrel is used outside `build`, so the barrel is lean.

### SAFE (sorted by lines saved)

1. **ViewAdminUiChecker.ts and SchemaAdminUiChecker.ts:L9-L41, L656: yagni.** Both checkers build a normalised presentation (`SchemaListFilter`, `SchemaListPresentation`, `EMPTY_LIST`, `ViewListPresentation`, `EMPTY_VIEW_LIST`, the `invalid()` wrapper, `filter: null` on every return) that nobody reads. Return the first problem only; keep `nav` for `checkSchemaNavTargets`.
   - evidence: the only callers are `SchemaSpecChecks.ts:75` (`.problems[0]`), `ProcedureViewSpecChecks.ts:50` (`.problems[0]`) and `SchemaAdminUiChecker.ts:518` (`{ nav, problems }`). `grep checkSchemaAdminUi|checkViewAdminUi` in tests and compiler-tests finds nothing.
   - class: SAFE, ~45 lines
2. **d1/lower.ts:L19-L71 and postgres/lower.ts:L37-L66: reuse.** These are duplicated between the two files: the `sql()` template splicer with `TOKEN` (d1 L30-46, pg L46-62, identical), `q`, `Arg`/`argOf` (d1 L66-71, pg L37-42), `strConst`, and `HAV` (identical except `min` vs `least`). The geo-field and "no search fields" / "search_rank needs mantle.search" refusals are also repeated (d1 L95-130, pg L121-148). Move them into one shared lowering helper in `core/sql/`, with `HAV` taking the min function as a parameter.
   - evidence: side-by-side read of both files.
   - class: SAFE, ~35 lines (identical output)
3. **d1/storage.ts:L39-L199: delete and shrink.** `Desired` and its `name`/`unique`/`columns` fields on indexes, triggers and virtuals are leftovers from the removed convergence step; only `.sql` and `table` are read. `createTable` lists native columns and then special-cases each one by name; print them directly, as the PostgreSQL file does. Also:
   - its `notNull = new Set()` default is never used;
   - `SYSTEM_DDL[0]!, [1]!, [2]!` can be `...SYSTEM_DDL`;
   - the unique/index column builder (d1 L84-95 and pg storage L37-50) and the `checkShapeProblem` guard in `checkText` are duplicated across the two dialects, so share one helper.
   - evidence: `grep desired(|.virtuals|SYSTEM_DDL` finds only `initialStorageSql`. The comments at L158 and pg L82 still say "not convergence".
   - class: SAFE, ~30 lines (schema.sql bytes unchanged)
4. **compilePlan.ts:L346-L362 and L877-L893, L458-L463 and L488-L493, plus 6 sites building `path: \`${sourceId}#/${documentIndex}…\``: shrink.**
   - The `registerUserField` + `SqlRefusal` catch block appears twice.
   - The `compileSql("SELECT 1 FROM \"…\" WHERE …")` call appears twice (for checks and for locks).
   - The diagnostic location boilerplate is repeated 6 times; `toDiagnostic` already builds it.
   - Fix: one `userField(prop)` helper, one `whereOf(name, text)` and one `at(source, pointer)`.
   - evidence: `grep -c 'sourceId}#/${' compilePlan.ts` = 6.
   - class: SAFE, ~20 lines
5. **d1/print.ts:L11-L65 and postgres/print.ts:L12-L48: reuse.** The `NullTest`, `BooleanTest` and `SubLink` overrides, `Raw`, the `RawExpr` interface and `print()` are identical in both files. Make one base `Deparser` subclass; d1 adds `ParamRef`/`TypeCast`/`A_Const`/`A_Expr`, pg adds `A_Expr`/`FuncCall`.
   - evidence: side-by-side read of both files.
   - class: SAFE, ~20 lines
6. **allowlist.ts:L1-L9, L734; core/dialect.ts:L23-L24; compile.ts:L1-L3; compileSql.ts:L4; run.ts:L135-L145, L159; ManifestFieldChecks.ts:L80-L101: delete stale comments.**
   - Several say "the runtime imports it", "the runtime never trusts an IR" or "Nothing in a Worker imports this module". The hard invariant is that kernel never imports `build`, and nothing loads a plan at runtime.
   - run.ts has a doc block left above `Source` that belongs to nothing, a comment about a compile cache that no longer exists, and a "see `runView`" pointer to a function that no longer exists.
   - ManifestFieldChecks documents a legacy `{ manifests, diagnostics }` adapter that does not exist.
   - evidence: `grep -rn runView src` matches only the comment (and a negative test regex in tests/consumer.test.ts). `grep "manifests, diagnostics"` matches only the comment.
   - class: SAFE, ~15 lines
7. **core/sql/run.ts:L8-L15, L87-L89, L166: yagni and reuse.** `Program` and `RunEnv` are each used once as a type. `opts = { cursor, match }` is a pointless indirection. L87-89 re-implements `outName` (L27), and so does compilePlan.ts:L289.
   - evidence: TS findReferences gives `RunEnv` and `ViewMatch` zero external uses; `Program` is used only in the `Lowerable` type in lowered.ts:15.
   - class: SAFE, ~10 lines (stale comments counted in #6)
8. **admin/procedureFlow.ts:L51, L114-L117, L138-L139, L215, L222, L240, L302 and developerConsole.ts:L40: delete.** These branches handle IR that the allowlist refuses before it reaches the plan:
   - `MergeStmt` is refused by `program()` (allowlist.ts ~L428: only Select/Insert/Update/Delete are allowed);
   - `BooleanTest` is not in `KEYS`;
   - `AEXPR_OP_ANY`, `AEXPR_OP_ALL`, `AEXPR_BETWEEN_SYM` and `AEXPR_NOT_BETWEEN_SYM` are in neither profile's `A_Expr.kind` enum;
   - `JoinExpr.usingClause`, `DeleteStmt.usingClause` and `WindowDef.name` are not in `KEYS` (`KEYWORD` refuses the two usingClauses);
   - `rowPreconditions` tests `fromClause`, `usingClause` and `withClause` on Update/Delete, and `UpdateStmt`/`DeleteStmt` `KEYS` contain none of them.
   - evidence: allowlist.ts KEYS L37-71 and ENUM L161-189. `sqlLogic` and `procedureFlow` only receive plan IR, which has passed `accepts`.
   - class: SAFE, ~12 lines (generated console output unchanged)
9. **compilePlan.ts:L330-L333, L1056-L1065 and ManifestParser.ts:L77, L94, L137, L156, L200, L232: yagni.**
   - `compileLinkedPlan` has one caller, and its `dialect = d1` default is never used: inline it.
   - Production always passes `"operational"` for `defaultLifecycle` (infrastructure/generate.ts:254, cli.ts:88, describe). Only tests rely on the `"publishing"` default. Drop the parameter and its threading through 6 parser sites, and fix the default to operational.
   - evidence: TS findReferences gives `compileLinkedPlan` 0 external references. A call-site scan shows 24 test calls use the default (compiler-tests/spec/*, tests/generate.test.ts:67, tests/refusals.test.ts:61); they would need `lifecycle: publishing` in their fixtures.
   - class: SAFE (test churn only), ~12 lines
10. **allowlist.ts:L238, L296: reuse.** `AGG ∪ MORE_AGG` is exactly `SqlIr.ts:L170-181 AGGREGATES` (the same 10 names). Define one and derive the other.
    - evidence: set comparison by reading both lists.
    - class: SAFE, ~11 lines
11. **postgres/lower.ts:L173-L180: delete.** The `typeof`/`hex`/`json_extract`/`json_set`/`json_insert`/`json_remove` → "not supported by the PostgreSQL dialect" branch cannot be reached. `postgres/validator.ts:L11-20 REFUSED` throws first, both in `accepts` (compileSql.ts:218) and in `check` (compile.ts:33, which runs before `applyPolicy`).
    - evidence: `grep "not supported by the PostgreSQL dialect"` finds no test.
    - class: SAFE, ~8 lines
12. **core/dialect.ts:L33-L38 and postgres/dialect.ts:L21: delete.** `MantleDialect.nativeSql` is set and never read.
    - evidence: `grep -rn nativeSql` across all scanned trees finds only these two lines plus a comment in compiler-tests/corpus.ts:17.
    - class: SAFE, ~7 lines
13. **spec/kernel/index.ts: yagni.** It is a barrel over one file. Its only `src` importer is core/sql/compile.ts:6 (run.ts already imports `diagnostic.js` directly).
    - evidence: the barrel-importer grep shows compile.ts:6 and compiler-tests/compiler.ts:2 only.
    - class: SAFE, ~7 lines
14. **core/sql/policy.ts:L457-L461 and spec/infrastructure/sql/frontEnd.ts:L18: delete.** `case "auth.role"` and the `"auth.hasrole"` entry in `MANTLE_FUNCTIONS` cannot be reached. `refuseUserReferences` (compileSql.ts:213, UserReferences.ts:29-34) already throws `AUTH_ROLE_REMOVED` for both, and `FUNCS` has no `auth.role`, so `dialect.check` would refuse before policy anyway.
    - evidence: tests/user-fields.test.ts reaches the code only through UserReferences. The diagnostic code and its text stay.
    - class: SAFE, ~6 lines
15. **core/sql/policy.ts:L114-L129: reuse.** `declaredCols`/`starCols` repeat `compilePlan.ts:L70-73 starCols` exactly. Keep one, for example in SqlIr.
    - class: SAFE, ~5 lines
16. **core/sql/lowered.ts:L50-L59, L97-L105: yagni.** `lowerView` and `lowerProcedure` are exported but called only by `lowerPlan`, which always passes `columns`, `warn` and `at`. Drop the defaults and the exports.
    - evidence: TS findReferences gives 0 external references.
    - class: SAFE, ~5 lines
17. **d1/storage.ts:L16-L17, d1/lower.ts:L48, postgres/lower.ts:L64-L65, postgres/storage.ts:L8, compilePlan.ts:L460, L490: reuse.** The `q` identifier quoter is written 4 times plus 2 inline copies, and `lit` twice. Keep one in core/sql/ast.ts.
    - class: SAFE, ~5 lines
18. **core/sql/policy.ts:L73, L166-L167: shrink.** `PolicyLowering.anyOf?` is optional, but both dialects implement it (d1/lower.ts:193, postgres/lower.ts:185). Make it required and delete the refusal "User scope needs native set lowering." that can never fire.
    - evidence: `grep` finds no test for that message.
    - class: SAFE, ~3 lines
19. **core/dialect.ts:L39-L43: shrink.** `print?` is optional, but both dialects set it and all 6 callers write `dialect.print!` (lowered.ts:47, infrastructure/generate.ts:42, 62, 64, adminPaging.ts:53, adminEntries.ts:56). Make it required. d1/dialect.ts:14 `print: ast => print(ast)` can be just `print`.
    - class: SAFE, ~3 lines
20. **allowlist.ts:L278, L280, L375: delete.** `MORE_KEYS.CommonTableExpr` is identical to the base entry (L44). `"withClause"` in `MORE_KEYS.SelectStmt` is already in the base keys (L39). Because the base profile accepts `SelectStmt.withClause`, `KEYWORD["SelectStmt.withClause"]` is never reached.
    - class: SAFE, ~2 lines
21. **ManifestGrammar.ts:L482-L483: delete.** `AdminRole` is a roles leftover and nothing references it.
    - evidence: TS findReferences returns 0 references, internal included.
    - class: SAFE, ~2 lines
22. **compilePlan.ts:L1050 and RuntimePlan.ts:L166: delete.** `access.roles` is a roles leftover. It is always `[]` and never read.
    - evidence: `grep -rn "access.roles|.roles\b"` outside build finds nothing relevant. `RuntimePlan` is not reachable from any published export; describe exposes only `access.userFields`.
    - class: SAFE, ~2 lines
23. **developerConsole.ts:L47 and ManifestSourceSpans.ts:L32: reuse.** Both re-implement `ManifestFieldChecks.ts:L144 escapeJsonPointerSegment`.
    - class: SAFE, ~1 line
24. **About 95 file-local symbols: delete the `export` keyword only.** The full list is in the `refs.cjs` output; examples are the allowlist tables, `SqliteDeparser`, `columnType`, the grammar sub-types and the ManifestLinker result types. `ALL_EDGES_REACHED` is an intentional compile-time assertion and stays.
    - class: SAFE, ~0 lines

### BREAKING

25. **core/sql/run.ts:L39-L95: reuse.** `nativeNotNull`/`fromItems`/`notNullIn` duplicate `compilePlan.ts:L253-295` (`tableOutputs.read`). The `ponytail:` comment at L67-68 says required fields count as nullable because storage adds NOT NULL to native columns only, and that a NOT NULL "needs a storage migration". That condition no longer holds: both initial DDLs now print NOT NULL for `notNullColumns` (d1/storage.ts:168, postgres/storage.ts:93, SqlIr.ts:194-216). Share one nullability reader that uses `NATIVE_NOT_NULL ∪ notNullColumns`.
    - evidence: side-by-side read.
    - Why breaking: paged View SQL changes (more row-comparison cursors on PostgreSQL, fewer `OR … IS NULL` branches on both dialects), so generated output is no longer byte-identical.
    - class: BREAKING (generated output), ~45 lines
26. **admin/developerConsole.ts:L68, L260, L304-L316: delete.** These fields are always constant, left over from the removed schedule Triggers and `requires.guard`: `guard: null` (×2), `schedules: []`, `runs: []`, `latestRuns: []`, `observationAvailability: "unavailable"`, `sweepObservation: "unavailable"`.
    - evidence: the Admin UI still renders them in `packages/mantle-admin/admin/src/features/logic/developer-operations.tsx` (schedules/latestRuns sections, ~100 lines), `logic-view.tsx:314, 329, 401-420`, `procedure-flow.tsx:23-46` and `lib/types.ts:370, 415, 481-484`; `packages/mantle-admin/src/server/authorization.ts:102` filters `schedules`.
    - Why breaking: the generated `admin-developer-console.ts` output and the Admin wire type both change, so Core and Admin must ship together.
    - class: BREAKING, ~8 lines in Core (plus ~100 in Admin)

### DECISION

27. **core/sql/compile.ts:L33-L50, d1/validator.ts:L40-L45, postgres/validator.ts:L66-L76, allowlist.ts:L1160-L1181, core/dialect.ts:L23-L24: delete.** This is a second allowlist pass, `MantleDialect.check`, which `compileProgram` runs on IR that `accepts` already passed, together with the `SqlPlan.grammar` version check. It was written for a runtime that loaded untrusted plans, and that no longer exists.
    - Why it needs a decision: `infrastructure/adminEntries.ts:235-339` also sends SDK-built ASTs through `compileProgram`, so the pass now works as a self-check.
    - evidence: tests compiler-tests/spec/sql-compile.test.ts:142, 206, 214-219 exercise it.
    - class: DECISION, ~55 lines
28. **ProcedureViewSpecChecks.ts:L292-L298, L320-L321, L333-L338; TriggerSpecChecks.ts:L43-L47, L64-L70; ManifestParser.ts:L258-L261; UserReferences.ts:L29-L34 with diagnostic.ts:L25 and SqlIr.ts:L20: delete.** These are special migration messages for removed features: `requires.guard`, `ctx.staff`, `ctx.admin: [roles]`, schedule/lifecycle Trigger kinds, the v1 apiVersion hint and `AUTH_ROLE_REMOVED`. The closed grammar already refuses each one generically (`rejectUnknownKeys`, the predicate or kind enum, the apiVersion check, and "function … is not on the allowlist").
    - evidence: tests are tests/refusals.test.ts, tests/user-fields.test.ts, tests/admin-layer.test.ts and compiler-tests/spec/compile-plan.test.ts. `AUTH_ROLE_REMOVED` is documented in docs/handbook/reference/diagnostics.md.
    - Why it is a decision: removing them changes diagnostic text, and the `AUTH_ROLE_REMOVED` code removal is BREAKING.
    - Exception: do **not** touch the `x-mantle-bind` refusal (SchemaSpecChecks.ts:~227-233). `validateJsonSchema` is a denylist, so without that check the keyword would be silently accepted and the field would become caller-supplied.
    - class: DECISION (and BREAKING for the code), ~30 lines

### Lean already

positions.ts (an intentional type-level assertion), PlanFingerprint, SqlRefusal, the d1 and postgres codecs, PgQueryParser, ManifestLinker and LocaleCanonicalizer. Most `ponytail:` notes in postgres/lower.ts (L84, 126, 145, 162) name latency triggers that have not been reached, so they stay. I only skimmed the bodies of SchemaSpecChecks, ManifestGraphValidator, TriggerGraphChecks, SiteDefaultsValidator, McpToolNaming, SqlRowPolicy and SchemaIndexChecker; they are not cleared beyond the items above.

### Noticed in passing (correctness, out of scope)

1. **Lifecycle default mismatch.** SchemaAdminUiChecker.ts:88 and :306, and SchemaIndexChecker.ts:172, treat a missing `lifecycle` as `"publishing"`. Production parsing defaults it to `"operational"` (ManifestParser.ts:242 with generate.ts:254 and cli.ts:88). As a result, a Schema that omits `lifecycle` has `list.primaryField`/`columns`/`filterField` refused, even though it compiles as operational. It also lets an index on `status` through, although such a Schema has no status column.
2. **Repeated parsing.** compilePlan parses each SQL source up to three times (`relationNames`, `statementCount`, `compileSql`). That is performance, not correctness.

net: -409 lines possible (SAFE: 271, BREAKING: 53, DECISION: 85), plus ~100 lines in mantle-admin if #26 goes ahead.
