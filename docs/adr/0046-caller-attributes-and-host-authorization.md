# ADR-0046: Declared roles, caller attributes and a host authorization seam

**Status:** Proposed (issue #1492). A spike validates decisions 2–5 before acceptance.

**Date:** 2026-10-13

**Amends:** ADR-0002 and ADR-0032 decision 8 (the role vocabulary is declared per
application instead of Core's closed `STAFF_ROLES`), ADR-0030 (a Schema scope can
name a caller attribute as well as `auth.uid()`) and ADR-0034 (adds `auth.attr(name)`
to the SQL references).

## Context

#1492 decided that OSS keeps a generic mechanism and ships one role, `staff`. Mantle
Cloud sells the role model and its management: staff permissions, member tiers and
organizations. The generic mechanism did not exist yet:

- Generation refuses every role except `staff` (`STAFF_ROLES`, `usecase/refusals.ts`).
- SQL can reference only `input.<name>`, `auth.uid()`, `auth.role()` and `now()`. A
  Schema `scope` binds only `auth.uid()`.
- `requires` can name `ctx.user`, `ctx.staff: [roles]` and `ctx.auth.scope`.
- `Caller.role` is an open string, but nothing else about the caller reaches SQL.

Cloud's design also changed (mantle-home #412, #413). Its spikes on 2026-10-13 tested
it live:
- The dispatcher only routes.
- Staff traffic alone passes through a platform `org-auth` Worker. The org's staff,
  groups, roles, attributes and grants live in one SQLite Durable Object per
  organization, which is the source of truth.
- `org-auth` hands the tenant a verified caller through Workers for Platforms
  `props`. That adds about 3 ms, and no callback is needed.
- Public and member traffic never passes through `org-auth`.

So the tenant, which is the Mantle application, must receive roles and attributes
from its host and enforce them. The same manifest must also run in OSS, where the
application resolves its own callers.

Cloud also plans an organization-wide MCP entry point, "Omni MCP", modelled on Uber's
MCP Gateway (2026). Uber's gateway has two halves:
- a **registry** (the control plane) of servers and tools. Tools are discovered
  automatically but start disabled, and their owners review and enable them;
- a **data plane** that serves one `/<server>/mcp` endpoint per virtual server, plus
  an Omni server.

Omni is a single endpoint. Agents discover through it incrementally with
`discover_server`, `discover_tools`, `get_tool_schema` and `invoke_tool`, under the
gateway's access control. In Cloud, Omni and the per-project staff MCP endpoints
belong to `org-auth`. The tenant must therefore be callable by that gateway and
describable without being called.

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
   - A host such as Cloud may assign only the declared vocabulary. Cloud reads it from
     the plan when it deploys.

2. **`Caller` carries attributes.** A user caller gains
   `attrs?: Readonly<Record<string, string | number | boolean | readonly (string | number)[]>>`.
   - Only the resolver fills it, from data that administrators write (an IdP mapper,
     admin-set attributes, or tenant-side membership and entitlement rows). A caller
     never sets its own attributes.
   - The kernel never reads `attrs` except through decision 3.

3. **`auth.attr(name)` is a SQL reference**, next to `auth.uid()`.
   - It lowers to one bind from a new `attr` bind recipe. A multi-valued attribute
     binds one array parameter:
     - SQLite: `IN (SELECT value FROM json_each(?))`;
     - PostgreSQL: `= ANY($n::text[])`.

     Nothing is interpolated into SQL text.
   - A missing attribute binds NULL, so a predicate on it matches nothing and the
     read fails closed.
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

   OSS ships a small reference implementation: a static role → target allowlist.
   Cloud's constraint executor (const, enum and range on canonical input) stays
   closed source and runs inside the tenant's Cloud entry. Its per-request data
   arrives in `props`.

6. **One host contract supplies callers and the seam.** The application entry is
   `defineApp(host => ({ fetch }))`, where `host` provides
   `caller(request, env, ctx)` and an optional `authorize`.
   - OSS's default host resolves callers with Better Auth (`resolveCaller`) and
     installs no `authorize`.
   - Cloud's host reads the verified caller and the compiled constraints from
     `ctx.props`, which `org-auth` sets. It never trusts request headers.
   - Core has no Cloud branch.

7. **Admin targets are addressable.** Every Admin API route maps to one target from
   its method and path alone (#1551), so an edge layer can allow or deny without
   reading the body. Admin's `present` hints (hidden or read-only) come from the host
   (Cloud: `org-auth`), not from the tenant.

8. **The plan publishes a capability catalog.** `mantle generate` writes a static,
   host-readable catalog, `catalog.json`, beside the generated code. It lists every
   exposed target:
   - target id, surface and MCP tool name;
   - title and description;
   - canonical input JSON Schema and annotations (read-only, destructive);
   - the roles `requires` names and the attributes the target's SQL reads;
   - a per-target input-schema hash.

   Each entry is an MCP `Tool` object (`name`, `title`, `description`, `inputSchema`,
   `annotations`) with Mantle's fields under `_meta`. A third-party server's
   `tools/list` snapshot therefore fits the same registry shape, and only Mantle
   targets carry the extra fields.
   It holds no SQL and no data. A gateway uses it for discovery and schema answers
   (`discover_tools`, `get_tool_schema`, a flattened constrained schema) and for binding
   grants per target. When a target's schema hash changes, only that target's grant
   lapses. The gateway answers discovery without calling a tenant. This replaces
   deriving tools from Core's runtime (mantle-home #357, #379).

9. **Surfaces accept a host-forwarded invocation.** A gateway that has already
   authenticated the caller may invoke a tenant surface in process, for example a
   `tools/call` that Omni forwards to the tenant's staff MCP surface. The caller and
   the constraints come from the host contract (decision 6), so:
   - no bearer token or cookie is required on that path;
   - the surface still runs its own `requires`, attribute scope, generated validation
     and `authorize`;
   - the forwarded caller can say an agent is acting for a human. `Caller` already
     carries `credential` and `clientId`, and a host may add an `actor` marker that
     `authorize` can read. The kernel does not interpret it.

## Consequences

- One manifest runs in both places:
  - **OSS**: the application decides who has which role and attribute (Better Auth
    fields, the organization plugin, its own tables).
  - **Cloud**: the decision comes from the org-level model (a Keycloak-aligned realm
    per organization, with groups, composite roles, attributes and delegated admin),
    and the result arrives as the caller.
- Member tiers and B2B2C organizations use the same `auth.attr()`. Their values come
  from tenant-local rows that the application resolver reads, so no `auth.org()`
  special case is needed.
- Attribute scope makes row-level ABAC declarative and dialect-native. Policies written
  as `WHERE` clauses by hand remain possible, but scope is the default.
- **Omni MCP and the organization registry live entirely in Cloud's `org-auth`.**
  Compared with Uber's design:
  - The registry is fed by each release's `catalog.json`, not by crawling or by an LLM.
    The manifest is the IDL, so discovery is deterministic.
  - "Discovery is not exposure" holds: a target that appears in a new release stays
    unavailable to restricted staff until an administrator grants it.
  - `invoke_tool` resolves to a project and target, then forwards per decision 9. The
    tenant sees an ordinary staff call.
  - Response trimming ("response projection"), output redaction and third-party
    credential exchange are gateway features on the response path. They are not
    kernel seams.
  - Public and member traffic never pass through the gateway.
  - **Reserved, not built now: non-Mantle MCP servers behind the same gateway**
    (mantle-home #370). A Mantle project is only one kind of server in the
    organization registry. Registry entries, grant targets (`<server>/<tool>`) and Omni
    discovery must not assume a Mantle tenant. A third-party server is registered from a
    pinned `tools/list` snapshot, which is re-reviewed when it changes, in place of
    `catalog.json`. It is called with credentials the gateway holds, never with a
    forwarded Cloud token. It gets only target-level and input checks at the gateway,
    because it has no `requires`, attribute scope or `authorize` of its own. Nothing in
    this ADR's tenant contract is needed for it.
- Cost when unused: nothing at startup or per request. When used: one bind per
  attribute reference, plus whatever `authorize` costs.
- Breaking changes for 0.2 (unreleased):
  - `STAFF_ROLES` becomes "`staff` plus the declared roles";
  - the `Caller` type gains optional fields.

## Alternatives rejected

- **Attributes as `requires` predicates** (`ctx.attr: {...}`). That would split data
  rules between `requires` and SQL. Scope and `WHERE` already express them.
- **Open path expressions on the caller** (`auth.user.region`). ADR-0002 rejected
  these for the same reason: no declared type and no defined null behaviour.
- **A policy engine in the kernel.** Grants, groups and their merging are product
  decisions (#1492). The kernel exposes a seam and binds.
- **The tenant calls back to `org-auth` per check.** That works (a `WorkerEntrypoint`
  stub in props, spike #413), but it adds a hop per check. Constraints travel in
  props instead.

## Open questions for the spike

- Can `kysely-durable-objects` run Better Auth inside `transactionSync`? The spike ran
  with `transaction: false`, which matters for Cloud's org DO, not for this ADR.
- Do the attribute-scope lowering and the array bind run unchanged on D1, bun:sqlite,
  Bun.SQL and postgres.js through the existing compliance suite?
- What does a missing multi-valued attribute look like in both dialects? It must match
  nothing, never everything.

- Is `catalog.json` enough for `get_tool_schema` once the grant has flattened the
  schema, or does the gateway also need each target's generated validator to
  canonicalize Omni input before forwarding? Proposal: the tenant canonicalizes under
  decision 9, and the gateway only filters by target.

## Evidence

- Cloud spikes, 2026-10-13: mantle-home #413.
- Topology: dispatcher → org-auth → tenant with `props`, about 3 ms extra; failure
  isolation; gradual deployment.
- Better Auth on Durable Object SQLite; fresh-on-write revocation.
- Uber Engineering, "Designing MCP Gateway: Uber's MCP Management Platform" (2026):
  - registry and data plane;
  - disabled-by-default discovery with owner review;
  - Omni MCP with incremental discovery;
  - response projection;
  - third-party token exchange;
  - Code Mode through a CLI.
