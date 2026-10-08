# ADR-0037: PostgreSQL is the reference dialect; D1 runs a subset

**Status:** Accepted for 0.2.0. Amends ADR-0034 decisions 2 and 8 and ADR-0035 decisions 1, 4 and 6, and replaces the
PostgreSQL dialect amendment's "What it accepts".

**Date:** 2026-10-02

**Related:** ADR-0014 (Cloud and tenants), ADR-0034, ADR-0035, ADR-0036, #1293

## Context

ADR-0035 decision 1 made Mantle SQL PostgreSQL's syntax and meaning, and said a PostgreSQL dialect "can accept nearly all of
PostgreSQL". The PostgreSQL dialect shipped as D1's subset less SQLite's functions, so a PostgreSQL manifest also compiled for
D1. That kept engines interchangeable, but it held services that chose PostgreSQL to SQLite's limits: no `WITH`, no window
frames, no `FILTER`, no jsonb operators. A View that needed one rule in many places (a plan's visible window, for example)
had to repeat it.

Services that pick PostgreSQL pick it for good (Swolhalla runs on PostgreSQL from day one). The subset should be D1's
limitation, not every dialect's.

Two kinds of author write Mantle SQL, and the allowlist means something different to each:
- **A self-hosted service** (enterprise, Swolhalla): the author also operates the database and can reach it directly. The
  allowlist does not stop malice there; it stops mistakes, above all SQL (often written by an AI) that would read another
  member's rows.
- **Mantle Cloud:** tenants are third parties. Today each tenant has its own D1 and its own Workers for Platforms script, and
  the tenant's `ref` handlers run in that script with the raw `DB` binding (aotter/mantle-home `apps/control/src/deploy/provider.ts`).
  Isolation between tenants is the separate database, not the allowlist. A PostgreSQL cell shared by thousands of tenants
  behind one Hyperdrive config (one connection string, one role) cannot isolate tenants that way.

## Decision

### 1. One reference allowlist, PostgreSQL's

- Mantle SQL's allowlist lives in Core (`src/core/sql/allowlist.ts`): the walker and two profiles, **base** (what every
  dialect runs, ADR-0034's subset) and **reference** (base plus decision 2). The PostgreSQL dialect accepts the reference
  profile. The D1 dialect accepts base.
- A construct D1 refuses but the reference accepts is refused with the reason "needs the PostgreSQL dialect", so an author
  knows it is an engine limit, not a mistake.
- The allowlist stays closed on every dialect. "PostgreSQL first" means a larger closed list, never "anything PostgreSQL
  parses": PostgreSQL's catalog has thousands of functions, and one that runs SQL text (`query_to_xml`) or reads files
  bypasses every policy.
- Each construct added to the reference profile lands with: the walker's rule, the policy rewriter's handling (a new relation
  position has a probe in the compliance suite, ADR-0034 decision 8), a compliance case on PostgreSQL, and a D1 refusal test.

### 2. The reference profile, first wave

| Construct | Rule |
|---|---|
| `WITH` and `WITH RECURSIVE` | Every CTE body is a `SELECT`. A data-modifying CTE (`WITH x AS (DELETE …)`) is refused. Each Schema read inside a body is wrapped like any other (relation position `cte`); a reference to the CTE is not. A reference is a CTE only by PostgreSQL's scope (a body sees its earlier siblings, every sibling under `RECURSIVE`); the allowlist and the rewriter both check that scope at runtime, because a `cte` tag on any other name would make PostgreSQL read the table, or the catalog view, of that name unwrapped. |
| `UNION`, `UNION ALL`, `INTERSECT`, `EXCEPT` | Inside a CTE body or a subquery only, never a View's own top-level `SELECT`, because Core's paging and deterministic order act on that `SELECT`. Each branch is wrapped (position `setop`). |
| `DISTINCT ON` | Inside a CTE body or a subquery only, for the same reason: Core's paging rewrites the top-level order, which decides which row `DISTINCT ON` keeps. |
| `LATERAL` subqueries | `JOIN LATERAL (…) x ON …` or `, LATERAL (…) x`. The subquery is wrapped as any FROM subquery. |
| Window frames | `ROWS` and `RANGE` with literal offsets; functions `avg`, `min`, `max`, `lag`, `lead`, `first_value`, `last_value` and `dense_rank` gain `OVER`. |
| Aggregates | `FILTER (WHERE …)`, `ORDER BY` inside an aggregate, `string_agg`. |
| jsonb | Operators `->`, `#>`, `#>>`, `@>`, `<@`, `?`, `?|`, `?&`; `jsonb_build_object`, `jsonb_build_array`, `jsonb_strip_nulls`, `jsonb_agg`, `jsonb_object_agg`, `to_jsonb`, `jsonb_typeof`; casts to `jsonb`. |
| Text | `ILIKE`, `NOT ILIKE`, and the regular-expression operators `~`, `~*`, `!~`, `!~*`; `split_part`. |
| Numbers | `greatest`, `least`, `floor`, `ceil`, `sqrt`, `power`. |
| Time | `AT TIME ZONE`; `date_trunc` adds `minute` and `quarter`; `extract` adds `minute`, `quarter`, `week`, `isoyear`, `isodow`, `doy` and `epoch`. |
| Casts | A cast of any expression to `int4`, `int8`, `numeric(p, s)`, `date` or `timestamptz` (D1 keeps its literal-only rule, which exists because SQLite truncates and stores time as integers). A bare text literal compared with a date-time, date or boolean column is PostgreSQL's cast, so the D1 refusal of it does not apply. |

Still refused everywhere: data-modifying CTEs, set-returning functions in FROM other than `json_each`, `generate_series`,
`FOR UPDATE`, `OFFSET`, `RIGHT` and `FULL` joins, and every function in ADR-0035 decision 4's list. Each needs its own
amendment.

### 3. A View may read another View

- A View's or a Procedure's `FROM` may name an **internal** View (`surface: internal`) that declares no `input` and no `requires`, by its name
  with `-` written `_` (`free-window` is `free_window`). A Schema of the same name keeps it: the name reads the Schema.
- The compiler inlines the referenced View's compiled `SELECT` as a `FROM` subquery before the dialect sees the tree. Policy
  and every check then apply to it as to any subquery. Nothing reaches the runtime that a hand-written subquery could not.
- References are resolved in dependency order; a cycle is a compile error.
- On every dialect. This is how a rule used by many Views is written once.

### 4. A narrowing hook

- `postgresStorage` and `sqliteStorage` take `restrict?: (plan, context) => readonly SqlDiagnostic[]`. Core runs it on every
  program's IR after the dialect's own check, at runtime (ADR-0035: the runtime never trusts an IR). Since the SQL compile
  cache, an accepted verdict is cached with the compiled program, so `restrict` runs again only for a program Core compiles anew. It can only refuse.
- It is for an operator that runs other people's plans. A self-hosted service does not set it.

### 5. Every PostgreSQL transaction has a statement timeout

- The PostgreSQL driver pins `statement_timeout` with `SET LOCAL` in every transaction, as it pins `DateStyle` and `TimeZone`:
  10 seconds unless `postgresStorage({ statementTimeoutMs })` says otherwise. A recursive CTE or a regular expression that runs
  away ends there.
- A database role used by Mantle is not a superuser and holds no file or server privilege (`pg_read_server_files`,
  `pg_execute_server_program`). The handbook says so; Mantle does not check.

### 6. Mantle Cloud's boundary

- **D1 (today):** the tenant's database is the isolation unit, so the tenant's code may hold its binding, as it does.
- **PostgreSQL (when Cloud adds it):** the cell's connection never enters a tenant script. The platform owns the Hyperdrive
  binding and runs a Store service the tenant script calls (as it calls `MAIL` and `MEDIA`). The service validates every IR
  with the dialect, then a Cloud `restrict` profile, then the policy rewriter, and runs each transaction as the tenant with
  `SET LOCAL ROLE` and the tenant's `search_path`. The cell role is a member of every tenant role; a tenant role holds only its
  schema. The allowlist is then a real boundary, and PostgreSQL's privileges are the second one.
- The Cloud profile and the Store service are aotter/mantle-home's to build; Core provides decision 4.

## Consequences

- A PostgreSQL manifest may no longer compile for D1. Moving from PostgreSQL to D1 can need a rewrite; moving from D1 to
  PostgreSQL still needs none.
- The reference profile grows by amendment, one construct at a time, each with its probe.
- Swolhalla's free-plan window is one internal View every other View reads.

## Alternatives

- **Accept everything PostgreSQL parses and deny a list of dangerous functions.** A denylist is never complete: an extension,
  a new catalog function or a server upgrade adds one. Rejected.
- **A Schema-level visibility predicate** (a second `scope`, injected by the rewriter). It solves the repeated window, but only
  for row filters; View references solve it and every other shared rule.
- **Native row-level security on PostgreSQL** (ADR-0035 decision 3's `policy: "native"`). The right second layer for Cloud
  (decision 6); a larger change than this ADR needs.

## Conformance cases

1. Each decision 2 construct gives PostgreSQL's result on the PostgreSQL dialect, and D1 refuses it with "needs the
   PostgreSQL dialect".
2. The relation-position probe covers `cte` and `setop`, and a Schema read inside a recursive CTE, a `UNION` branch and a
   `LATERAL` subquery never shows another owner's rows. An IR whose `cte` tag names a relation outside PostgreSQL's CTE
   scope (the CTE's own body, a later sibling, a catalog view) is refused at runtime.
3. A View's top-level `UNION` or `DISTINCT ON`, and a data-modifying CTE, are refused with a position.
4. A View reads an internal View; the reference to a View with an input, a public View or a cycle is refused.
5. A `restrict` that refuses a program stops it at runtime with its diagnostic.
6. A statement past `statement_timeout` fails with `RESOURCE_UNAVAILABLE`, and nothing is written.
