# ADR-0046: Declared roles, caller attributes and a host authorization seam

**Status:** Proposed (issue #1492). A spike validates decisions 1–3 and 8 before acceptance.

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

1. **The application declares its role and attribute vocabulary.** An app-level
   `auth` block lists the roles `requires` may name and the attributes SQL may read:

   ```yaml
   auth:
     roles: [editor, sales, finance]        # staff stays built in
     attributes:
       region:     { type: string, multiple: true }
       department: { type: string }
       tier:       { type: string }         # member tiers use the same mechanism
   ```

   - `mantle generate` refuses a role or attribute that is not declared, and checks
     attribute types where SQL uses them.
   - With no `auth` block, behaviour is unchanged: `staff` is the only role and there
     are no attributes.
   - A host may assign only the declared vocabulary, which it reads from the plan.

2. **`Caller` carries attributes.** A user caller gains
   `attrs?: Readonly<Record<string, string | number | boolean | readonly (string | number)[]>>`.
   - Only the resolver fills it, from data that administrators write (an identity
     provider mapping, admin-set attributes, or membership and entitlement rows). A
     caller never sets its own attributes.
   - The kernel never reads `attrs` except through decision 3.

3. **`auth.attr(name)` is a SQL reference**, next to `auth.uid()`.
   - It lowers to one bind from a new `attr` bind recipe. A multi-valued attribute
     binds one array parameter:
     - SQLite: `IN (SELECT value FROM json_each(?))`;
     - PostgreSQL: `= ANY($n::text[])`.

     Nothing is interpolated into SQL text.
   - A missing attribute binds NULL, so a predicate on it matches nothing and the read
     fails closed.
   - A Schema `scope` may name an attribute, for example
     `scope: { region: "auth.attr('region')" }`. Reads AND
     `region IN auth.attr('region')` into every touched Schema, as identity scope does
     today (ADR-0030). Inserts must supply a value inside the caller's set, and updates
     and deletes check the row first.
   - System callers bypass attribute scope exactly as they bypass identity scope.

4. **Roles stay in `requires`.**
   - `ctx.staff: [roles]` evaluates against the caller's role set.
   - `Caller.role` remains for one role. A host may supply `roles: readonly string[]`;
     when present, the kernel uses it and treats `role` as `roles[0]` for
     compatibility.
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
- Cost when unused: nothing at startup or per request. When used: one bind per
  attribute reference, plus whatever `authorize` costs.
- Breaking changes for 0.2 (unreleased):
  - `STAFF_ROLES` becomes "`staff` plus the declared roles";
  - the `Caller` type gains optional fields;
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

## Open questions for the spike

- Do the attribute-scope lowering and the array bind run unchanged on D1, bun:sqlite,
  Bun.SQL and postgres.js through the existing compliance suite?
- What does a missing multi-valued attribute look like in both dialects? It must match
  nothing, never everything.
- Is `catalog.json` enough for a gateway's schema answers, or should the application
  canonicalize forwarded input itself under decision 9? Proposal: the application
  canonicalizes, and the gateway only filters by target.
