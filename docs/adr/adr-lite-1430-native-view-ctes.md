# ADR-lite: Native CTEs for named View dependencies

**Status:** Accepted direction for issue #1430.

**Amends:** ADR-0037 decisions 1–3; follows ADR-0040 and ADR-0042.

On D1, the compiler represents a readable named View dependency as a native
SELECT CTE, once per outermost SELECT subtree, instead of copying its SELECT
at every reference. PostgreSQL retains native FROM subqueries: measured
repeated-dependency CTEs changed limited index scans into full CTE/heap scans,
hash joins and sorts. Other dialects retain the existing subquery representation.
The existing compile-side dialect name selects this lowering; no new option or
runtime capability is added. Dependencies remain internal Views without input or requires;
Schema-name precedence and cycle refusal remain. INSERT SELECT uses its SELECT;
scalar subqueries in other writes retain separate SELECT-local dependencies.

The base SQL subset now accepts ordinary nonrecursive SELECT CTEs. Recursive
WITH and materialization hints remain reference-dialect features; set operations
and other reference-only constructs are not added to base. Data-changing CTEs
remain refused everywhere. This adds no manifest key or runtime IR node.

Compilation retains validated tagged dependency sources only until it emits
the sealed native AST. On D1, generated CTE names avoid authored identifiers. An authored CTE
that would capture a physical table read is renamed with its lexical references,
preserving its original implicit or explicit alias. This also accounts for
SQLite's forward-reference behavior. Authored CTE bodies stay in their original
scope. Dependency discovery follows lexical CTE scope, rather than subtracting
every CTE name from every relation in a source.

The existing runtime allowlist checks every CTE reference against its scope.
The existing policy walker filters each physical Schema read inside a CTE,
preserving caller, TTL and publishing visibility. Output lineage follows CTE
columns; root paging does not treat a derived row as a physical Schema row.
ORDER, LIMIT and input binding remain at their original SELECTs. Complete unique
paging order remains the author's responsibility.

Authored CTEs remain authored CTEs on both engines. Native engines decide
whether to inline or materialize them; Mantle adds no hint,
cost optimizer, index choice, cache, dependency manager or runtime state. The
existing closed function lists exclude volatile functions such as random(),
clock_timestamp() and nextval(); now() and auth values are bound per invocation.
Adding volatile functions would require revisiting dependency-sharing semantics.
Unordered results and aggregate order remain native and unspecified. No equal
planner behavior or cross-engine performance guarantee is made.

Validation uses generic dependency DAGs, authored-name collisions, nested
shadowing, scoped correlated aggregates, decoded columns and full cursor pages
on native SQLite/D1 and PostgreSQL. Engine plans and performance are measured
separately from semantic equivalence. Private applications and data are not
fixtures in this repository.
