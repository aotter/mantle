# ADR-0046: Declared roles, caller attributes and a host authorization seam

**Status:** Proposed (issue #1492). A 2026-10-13 spike validated decisions 1–3, 8 and the host-supplied caller of 6 and 9 (see Evidence).

**Date:** 2026-10-13

**Amends:** ADR-0002 and ADR-0032 decision 8 (the role vocabulary is declared per
application instead of a closed `STAFF_ROLES`), ADR-0030 (a Schema scope can name a
caller attribute as well as `auth.uid()`) and ADR-0034 (adds `auth.attr(name)` to
the SQL references).

## Context

#1492 decided that Mantle ships a generic authorization mechanism and one built-in
role, `staff`. Richer role models, such as staff permissions, member tiers and
organizations, are decided by whoever runs the application. That can be the
application itself, or a managed host or gateway in front of it. The generic
mechanism does not exist yet:

- Generation refuses every role except `staff`.
- SQL can reference only `input.<name>`, `auth.uid()`, `auth.role()` and `now()`. A
  Schema `scope` binds only `auth.uid()`.
- `requires` can name `ctx.user`, `ctx.staff: [roles]` and `ctx.auth.scope`.
- `Caller.role` is an open string, but nothing else about the caller reaches SQL.

Two kinds of host need more than that:
- An application resolves its own callers, for example with Better Auth fields,
  organization membership or entitlement rows.
- A managed host or MCP gateway authenticates staff in front of the application and
  passes the verified caller in. The gateway must also list and describe the
  application's tools without calling it, and forward tool calls to it.

The manifest language and these seams are open source, so a project runs the same way
under either kind of host.

## Decision

1. **The application declares its role and attribute vocabulary.** One
   `kind: Auth` document per application lists the roles `requires` may name and the
   attributes SQL may read. This keeps the grammar closed: it is one more document
   kind, not a free-form block.

   ```yaml
   kind: Auth
   spec:
     roles: [editor, sales, finance]        # staff stays built in
     attributes:
       region:     { type: string, multiple: true }
       department: { type: string }
       tier:       { type: string }         # member tiers use the same mechanism
   ```

   Attribute types are `string` and `number`, each optionally `multiple`. There is no
   `boolean`, because SQLite and PostgreSQL have no shared value form for it.

   - `mantle generate` refuses a role or attribute that is not declared, and checks
     attribute types where SQL uses them.
   - With no `Auth` document, behaviour is unchanged: `staff` is the only role and there
     are no attributes.
   - A host may assign only the declared vocabulary, which it reads from the plan.

2. **`Caller` carries attributes.** A user caller gains
   `attrs?: Readonly<Record<string, string | number | readonly (string | number)[]>>`.
   - Only the resolver fills it, from data that administrators write (an identity
     provider mapping, admin-set attributes, or membership and entitlement rows). A
     caller never sets its own attributes.
   - The kernel never reads `attrs` except through decision 3.

3. **`auth.attr(name)` is a SQL reference**, next to `auth.uid()`. It lowers to one
   bind from a new `attr` bind recipe, and nothing is interpolated into SQL text.

   - **Authoring.** A single-valued attribute is compared with `col = auth.attr('x')`.
     A multi-valued attribute must stand alone in an IN list: `col IN (auth.attr('x'))`.
     `NOT IN` over an attribute is a generate error. `= ANY(...)` is not used, because
     it is outside the SQL allowlist.
   - **Lowering.**
     - SQLite: `x IN (SELECT value FROM json_each(?))` with a JSON array.
     - PostgreSQL: `= ANY(CAST(CAST($n AS text) AS text[]))` with an array literal
       sent as text. Drivers do not agree on binding a JS array.

     Both forms keep the column's index.
   - **Fail closed.** A missing attribute, or an empty array, matches nothing, never
     everything, even under an author's `NOT (...)`. SQLite binds `'[null]'` and
     PostgreSQL binds NULL. A bare NULL is not enough on SQLite, because
     `x IN (empty set)` is FALSE there, so its negation would return every row.
   - **Scope.** A Schema `scope` may name an attribute, for example
     `scope: { region: "auth.attr('region')" }`.
     - Reads AND the membership predicate into every touched Schema, as identity scope
       does today (ADR-0030).
     - An insert must supply a value inside the caller's set, or it fails with
       `AUTH_DENIED`.
     - An update or delete of a row outside the set fails with `CONFLICT`.
     - System callers bypass attribute scope exactly as they bypass identity scope.
   - **The scope column stays an ordinary column.** It is readable, can be named in
     queries and indexes, and is returned. Only writes are constrained.
   - **First-version limits.** These are refused at generate time, not supported:
     - publishing and translation Schemas cannot be attribute-scoped;
     - Procedure SQL cannot INSERT into an attribute-scoped Schema; the Store writes it.

4. **Roles stay in `requires`.**
   - `ctx.staff: [roles]` evaluates against the caller's role set.
   - `Caller.role` remains for one role. A host may supply `roles: readonly string[]`.
   - Every kernel role check goes through one helper, `hasRole(caller, roles)`, which
     reads `roles` when present and otherwise `role`. That covers generated
     `requires`, the MCP staff gate, publishing transitions and the `auth.role()` bind
     (the first role). A host therefore never has to fill both fields consistently.
   - Attribute conditions are never `requires` predicates. They belong in SQL or
     `scope`, so data rules stay in one place.

5. **A host authorization seam, not a policy engine.** Generated `rest`, `mcp`, admin
   mounts and the Store accept `authorize?(target, input, caller)`:
   - It runs after generated validation, so `input` is canonical and frozen, and
     before any SQL.
   - Targets are `procedure:<name>`, `view:<name>` and `schema:<name>#read|write|status`.
   - It returns allow or `{ deny, reason, revision }`, and it cannot rewrite input.
   - System callers and nested handler calls skip it, running under the definer's
     authority.
   - Without the option, the kernel runs no extra code.
   - Denials are `POLICY_DENIED` (403) carrying `revision`. On MCP, an unknown or
     hidden target is `-32602`, which does not disclose the tool.

   Mantle ships a small reference implementation: a static role → target allowlist.
   Richer policies, such as constraints on canonical input or grant merging, are the
   host's.

6. **One host contract supplies callers and the seam.** The application entry is
   `defineApp(host => ({ fetch }))`, where `host` provides
   `caller(request, env, ctx)` and an optional `authorize`.
   - The default host resolves callers with Better Auth (`resolveCaller`) and installs
     no `authorize`.
   - A platform host may read a verified caller from its invocation context, such as
     Workers for Platforms `ctx.props`, which only the platform can set. It never
     trusts request headers.
   - The kernel never branches on which host it runs under.

7. **Admin targets are addressable.** Every Admin API route maps to one target from
   its method and path alone (#1551), so an edge layer can allow or deny without
   reading the body. Admin's presentation hints (hidden or read-only) may come from
   the host.

8. **The plan publishes a capability catalog.** `mantle generate` writes a static,
   host-readable catalog, `catalog.json`, beside the generated code. It lists every
   exposed target:
   - target id, surface and MCP tool name;
   - title and description;
   - canonical input JSON Schema and annotations (read-only, destructive);
   - the roles `requires` names and the attributes the target's SQL reads;
   - a per-target input-schema hash.

   `mantle generate` writes it for every application, and it is a generated file like
   the others: it carries the generated header and is removed when no longer produced.
   It covers REST and MCP targets. Admin targets join it when decision 7 lands.

   Each entry is an MCP `Tool` object (`name`, `title`, `description`, `inputSchema`,
   `annotations`) with Mantle's fields under `_meta`, so a registry can hold Mantle
   and non-Mantle servers in one shape.

   The catalog holds no SQL and no data. A gateway uses it to:
   - answer discovery and schema questions without calling the application;
   - bind its own grants per target. When a target's schema hash changes, only grants
     on that target need review.

9. **Surfaces accept a host-forwarded invocation.** A host that has already
   authenticated the caller may invoke a surface in process, for example by forwarding
   an MCP `tools/call`. The caller comes from the host contract (decision 6), so:
   - no bearer token or cookie is required on that path;
   - the surface still runs its own `requires`, attribute scope, generated validation
     and `authorize`;
   - the forwarded caller can say an agent is acting for a human. `Caller` already
     carries `credential` and `clientId`, and a host may add an `actor` marker that
     `authorize` can read. The kernel does not interpret it.

## Consequences

- One manifest runs under any host. The host decides who has which role and attribute.
  The application enforces `requires`, attribute scope and its generated validation.
- Member tiers and B2B organizations use the same `auth.attr()`, with values read by
  the application's resolver, so no `auth.org()` special case is needed.
- Attribute scope makes row-level ABAC declarative and dialect-native. Policies written
  as `WHERE` clauses by hand remain possible, but scope is the default.
- **Cost.**
  - Generated code for an application without attributes is byte-identical.
  - The kernel's `attr` bind case is shared code, about 37 B in every bundle. It must
    fit the existing `startup:*` budgets by trimming elsewhere, not by raising them.
  - Per request, one attribute reference costs one bind: about 25 ns single-valued and
    a few hundred ns for a small set. On SQLite the query is 6–19% slower than plain
    equality and still uses the index. PostgreSQL showed about +30% in one run; this
    must be re-measured before acceptance.
- Breaking changes for 0.2 (unreleased):
  - `STAFF_ROLES` becomes "`staff` plus the declared roles";
  - the `Caller` type gains optional fields;
  - a new `kind: Auth` document;
  - generation writes `catalog.json`.

## Alternatives rejected

- **Attributes as `requires` predicates** (`ctx.attr: {...}`). That would split data
  rules between `requires` and SQL. Scope and `WHERE` already express them.
- **Open path expressions on the caller** (`auth.user.region`). ADR-0002 rejected
  these for the same reason: no declared type and no defined null behaviour.
- **A policy engine in the kernel.** Grants, groups and their merging are host
  decisions (#1492). The kernel exposes a seam and binds.
- **Deriving the tool list from a running application.** Discovery would then need a
  request to every application, and the result would be only as stable as that
  runtime. The plan already knows every target.

## Open questions

- Attributes inside CTEs, subqueries and JOINs, and cursor paging past the first page
  with an attribute predicate, were not covered by the spike.
- Checking an attribute's type against its column's type beyond a database CAST.
- Re-measure the PostgreSQL cost of the array membership predicate.
- Is `catalog.json` enough for a gateway's flattened schemas? Proposal: the application
  canonicalizes forwarded input itself (decision 9), and the gateway only filters by
  target.

## Evidence

Spike, 2026-10-13, on the Next SDK:
- **Implemented:** decisions 1–3 and 8, plus the host-supplied caller of decisions 6
  and 9 for the generated `rest()` and `mcp()`.
- **Scenario checks:** 54 per target, on bun:sqlite, a D1 shim, Bun.SQL and
  postgres.js, and in local workerd for D1 and PostgreSQL. They cover single- and
  multi-valued attributes, missing and empty sets, negation, scoped Store reads,
  insert/update/delete outside the set, and system callers.
- **Existing SDK suite:** unchanged, on Bun 1.4.2 and 1.3.14.
- **Generated output:** 30 generations, 714 files, compared before and after. They are
  byte-identical apart from `catalog.json`.
- **`catalog.json` hashes:** stable across runs and key order. A changed input changes
  only that target's hash.
- **Not built:** decisions 5 and 7, `defineApp`, and the `actor` marker.
