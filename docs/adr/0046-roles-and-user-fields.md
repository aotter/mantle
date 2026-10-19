# ADR-0046: Roles and user fields in SQL scope

**Status:** Accepted for 0.2.0 (2026-10-14, issue #1492), amended the same day by the section "Amendment: enforcement only", which takes precedence over the sections it names; §4 Paging amended 2026-10-15 (#1644).

**Date:** 2026-10-13

**Amends:** ADR-0002 (closed value references: `auth.hasRole(name)` and
`auth.user(field)` join `auth.uid()`; `auth.role()` is removed), ADR-0030 and ADR-0034
(a Schema `scope` may bind a user field as well as the caller's id), and ADR-0032
decision 8 (a caller carries roles and user fields, and a host may supply the caller).

## Context

#1492 keeps a generic authorization mechanism in Mantle and leaves the management of
people, groups and attributes to whoever runs the application. Mantle's identity layer
is Better Auth, so the mechanism uses Better Auth's own vocabulary:
- **Roles.** The admin plugin stores `user.role`. A user may hold several roles, stored
  comma-separated, and checks ask whether the user *has* a role or permission.
- **User data.** Applications add `user.additionalFields` (typed, with `input: false` for
  fields users must not write) or derive fields per session with `customSession`.
  Applications read them as `session.user.<field>`.
- **Anything richer** (groups, delegated administration, attribute mapping) is built as
  an application plugin with its own schema and hooks. Better Auth does not ship it.

Two names that agents already know shaped the SQL surface:
- Supabase's `auth.role()` returns a database role (`authenticated`, `anon`) and is
  deprecated there. A set-valued `auth.role()` in Mantle would be misread.
- `hasRole` is the predicate Spring Security, Quarkus and Better Auth checks use.

Mantle needs one rule shape that works in three places:
1. An author writes an ordinary, testable rule: "sales admins see the orders of their
   regions; administrators see all orders".
2. A self-hosted application fills roles and fields with Better Auth.
3. A managed host or gateway authenticates its own people in front of the application and
   supplies the same user shape. The application never learns how the host computed
   it.

## Amendment: enforcement only (2026-10-14)

**Principle.** Mantle enforces row access and verifies forwarded calls. It does not decide which values a caller holds.
- Deciding values belongs to the identity system or gateway in front of the application.
- *Roles decide what a caller may call; caller values decide which rows it sees.* Each Schema has exactly one row template, so nothing merges and a role never widens rows.
- A gateway built on Mantle itself must be able to implement its decisions with Mantle's own primitives.

This amendment takes precedence over the sections listed under "Superseded".

### Caller values
- A caller carries `roles` and `fields`. `roles` is Better Auth's `user.role`, split exactly as Better Auth splits it. Role names may contain `-`, and a malformed role string fails fast, naming the role.
- A field value is one of:
  - a string;
  - a number;
  - an array of strings or numbers;
  - the typed state `{ all: true }`, which is never a magic string.
- Values are validated (§2), branded and deep-frozen. Anonymous callers carry none.
- Each field's type, enum and arity come from the columns it is compared with. Two uses that disagree fail with `USER_FIELD_CONFLICT`.

### Schema `scope`: one row template
A Schema's `scope` is one predicate string with a fixed grammar. Conditions are joined with AND only:

```
predicate := term [AND term ...]
term      := <column> = auth.uid()
           | <column> IN auth.user('<field>')
```

```yaml
scope: "region IN auth.user('region') AND store IN auth.user('stores')"
```

- **Enforcement.** The scope applies to every read and write of the Schema, at all the positions listed in §4: Views, joins, subqueries, CTEs, the Store, the Admin generic routes and export, paging, translation parents, and UPDATE/DELETE.
- **Writes.** Inserts must fall inside the caller's set. Scoped columns are never SET. Uniqueness is partitioned by the scoped columns. A row outside the set behaves as missing.
- **Per term:**
  - an array lowers to `IN`;
  - `{ all: true }` drops that term only, so the other terms still apply;
  - a missing or empty value means no row. The kernel refuses this before any SQL runs, and correctness never relies on NULL semantics.
- **`= auth.uid()` columns are stamped by the system.** They are filled from the caller and never writable.
- **References.** A Schema whose `x-mantle-ref` points to a scoped Schema must carry that Schema's scope terms. Otherwise generate fails and names the missing term.
- **No roles in row rules.** The role escape (`auth.hasRole(...) OR …`) is withdrawn.

### `restrict` on Views and Procedures
```yaml
restrict: { orders: "owner = auth.uid()" }
```
- The grammar is the same, but only value terms are allowed, keyed by a Schema that the target's SQL reads. An unknown key fails generate.
- The effective rule is `scope AND restrict`, so `restrict` never widens.
- `{ all: true }` drops scope terms only. It never drops a `restrict` term.

### SQL
`auth.user()` and `auth.hasRole()` are refused in View and Procedure SQL with `USER_REF_SCOPE_ONLY`, whose message points to `restrict`. `auth.role()` stays removed.

### Calls
- Better Auth `adminRoles` decides the admin layer, and `requires: ctx.admin` means any admin.
- Per-target permission goes through one optional seam, `authorize(target, caller) => boolean | Promise<boolean>`.
  - Mantle calls it after its own gates and before any SQL, on every surface: REST, MCP (including tool listing), web and the Admin generic routes.
  - When it returns false, the call fails with 403.

### Generate warnings
- An admin-surface target reads a scoped Schema (admins without values see nothing).
- A View joins Schemas scoped by different fields (rows outside either set are dropped).

### Gateways
- **Gateway mode.** Selected REST, MCP, Admin and web boundaries accept `gateway: { tenant }` and receive the execution context as their third argument. The caller comes only from `ctx.props.mantle`; absent props mean anonymous. Set gateway mode on every boundary of an application. Application cookies, sessions and bearer tokens are ignored, without loading the application's auth instance; present `props.mantle` prevents falling back to application credentials.
- **Host contract v1.** `hostCaller(props, { tenant, fields })` accepts `{ v: 1, tenant, layer: "admin" | "member", user: { id, role?, ...fields }, authenticatedAs: "snapshot" | "fresh", credential: "session" | "oauth", requestId }`. `target` and `targetHash` are required for the admin layer, optional for members, and enforced whenever supplied. `dryRun` is an optional boolean. Validate the entire shape and require an exact configured tenant match; malformed/version/tenant failures are `HOST_CONTRACT` (412). Roles and fields use ordinary caller validation, including arity and `{ all: true }`, and retain authority only on the original branded, frozen caller.
- **Layers and subjects.** The admin layer produces `kind: "host"`, subject `'host:' + user.id`, and passes `ctx.admin`. The member layer produces `kind: "user"` and the unprefixed subject `user.id`; its roles never grant the admin layer. User subjects cannot start with `host:` or `system:` (case-insensitive). Scope applies throughout, including Admin drafts. Member management refuses host-built callers with 403.
- **Freshness.** Callers expose `authenticatedAs`, `credential` and `requestId`. A snapshot may read; any SQL write, Store/Admin mutation, publishing transition, member mutation or ref handler is refused before execution with `STALE_CALLER` (403). Statement kinds determine whether SQL Procedures write. Session writes retain origin checks according to `credential`.
- **Errors.** Both host-built layers receive JSON `{ error: { code, field?, target? } }`: contract failures are 412, denials (including `authorize` and stale callers) are 403, and malformed bodies are 400. Host callers never receive 401. MCP tool failures use the SDK error result with the same error fields. A needed missing or empty field fails before SQL with `HOST_CONTRACT` (412), naming the field.
- **Tripwire.** Present execution props outside gateway mode is `HOST_CONTRACT` (412); an entry never silently ignores or honors it.
- **Testing.** Tests call `hostCaller(props, { tenant, fields })` with the same props JSON.
- **Target pinning.** Every boundary checks its describe `_meta.id`: REST route ids, Admin route templates, and View/Procedure ids for MCP and web. A wrong target fails with `TARGET_MISMATCH` (412); a stale hash fails with `TARGET_HASH_MISMATCH` (412). Generation computes a target-id → hash map with `targetHash`; gateway requests alone load its module. MCP host callers may initialize and call the pinned tool; batches are refused and `tools/list` is `AUTH_DENIED` (403), since the host answers it.
- **Dry runs.** `dryRun: true` performs pinning, hash, input validation, generated caller checks, authorization and freshness without SQL or side effects. It returns 200 `{ dryRun: true, event }`; MCP carries this result in the SDK tool response. Ref handlers, custom guards, uploads and opaque work fail with `DRY_RUN_UNSUPPORTED` (412).
- **`onAccess(event)` hook.** REST, MCP, Admin and web accept an optional observer for every forwarded caller, both layers, on every outcome including contract errors. It runs after the decision, is never awaited, and logs listener failures once without affecting the response. Non-gateway applications never invoke it. The v1 event is `{ v: 1, requestId, target, targetHash, caller: { kind, subject, layer }, outcome: "allow" | "deny" | "error", reason?, field?, dryRun }`. Reasons match error codes. Dry runs return the same event supplied to the hook.
- **`describeApp(plan)`** is computable before deploy. It lists:
  - the targets: id, `targetHash`, surface and input schema;
  - each Schema's scope terms and each target's `restrict` terms, with field types and enums;
  - a diff of scope and `restrict` terms between two plans, so that widening is visible.

### Testing
`authenticatedAs(user)`.

### Superseded
- §1 and §1a: `auth.hasRole` in scope or SQL, and role lists in `requires`.
- §3: SQL references.
- §4: the single-field scope shape and the role escape; replaced by the predicate above.
- §5: wherever it conflicts with this amendment.
- §6–§10: replaced entirely by this amendment and the handbook’s Gateway mode section.

Everything else stands.

## Decision

### 1. No declaration: the vocabulary comes from use

The application does not declare a role model. Roles and user fields exist in the
manifest only where an author uses them:
- `auth.hasRole('<role>')` in a scope or in SQL;
- `requires: ctx.admin: [<role>, …]`;
- `auth.user('<field>')` in a scope or in SQL.

What a role means and who holds it belongs to the identity system: Better Auth when
self-hosted, a host when hosted.

- **Field types come from the column.** A field compared with a column takes that
  column's type and enum. Two uses that disagree fail with `USER_FIELD_CONFLICT`. An enum
  is optional; without one, `mantle generate` warns that no generated list of all values
  exists.
- **Single or many comes from the operator** (section 3).
- **Names.** Role and field names match `^[a-z][a-zA-Z0-9_]{0,62}$` and are literals.
  These field names are reserved because they are Better Auth core fields or caller
  metadata: `id email emailVerified name image createdAt updatedAt role banned banReason
  banExpires` and `mantle*`.
- **`requires: ctx.admin`** (renamed from `ctx.staff`) accepts any role name.
- `mantle describe` reports every use, so authors, agents and hosts read one
  vocabulary. An application that uses none of these generates
  byte-identical code to today.

A misspelled role never matches, so the rule fails closed. A host that compares the
report with what it can supply catches the typo.

### 1a. Two layers: admin and member

Mantle keeps one boundary between privileged callers and everyone else, and names it
the way Better Auth does.

- **Admin.** A caller holding one of Better Auth's admin plugin `adminRoles` is an admin.
  Mantle reads `adminRoles` from the admin plugin configuration; it has no setting of its
  own. A host caller is an admin by definition. The previous `staff` role,
  `ctx.staff`, `/mcp/staff` and "staff" in Admin are renamed `admin`, `ctx.admin`,
  `/mcp/admin` and "admin"; Better Auth's default `adminRoles: ["admin"]` therefore
  works unchanged.
- **Member.** Every other signed-in caller.
- **Privilege reads only the admin layer.** `requires: ctx.admin` and the role escape in a
  scope (section 4) consult a caller's roles only when the caller is an admin. A member
  who holds a role with the same name gains nothing.
- **Roles inside each layer.** Admins may hold several `adminRoles` with different
  Better Auth access-control statements, for example an `editor` who may publish but not
  ban users. Members may hold member roles such as `vip`. `auth.hasRole()` in SQL reads
  either layer, as a filter.
- **Permissions are Better Auth statements.** Each Admin target names the statement it
  needs (`content:publish`, `user:ban`, `session:revoke`). A local admin passes when one
  of its roles grants the statement through Better Auth's access control. A host caller
  passes the Admin gate, and the host's own gate decides which targets it may reach, in
  the same statement vocabulary.

### 2. The caller carries roles and fields

- A non-system caller carries `roles` (a set) and `fields` (a map from field name to its
  value).
- They are validated once, deep-frozen and stored in a private `WeakMap` keyed by the
  caller. Binds read only from there. `caller.roles` and `caller.fields` are read-only
  views.
- A caller without a brand binds no roles and no fields: a user or anonymous caller
  binds empty, and a host caller without a brand is an error. A copied caller object
  loses both, so a copy fails closed.
- Anonymous callers never carry roles or fields.
- A value is a string, a number, or an array of either (Better Auth's `string`,
  `number`, `string[]`, `number[]`). A string must be well-formed UTF-8, between 1 and
  256 bytes, and contain no NUL. An array holds at most 64 values; duplicates are
  removed. Fields the application never reads are dropped. An invalid value is an error
  (`USER_FIELD_INVALID`); values are never silently filtered.
- `auth.uid()` is unchanged for users. For a host caller it is `'host:' + user.id`.

### 3. SQL references

Three closed value references read the caller:

| Reference | Meaning |
|---|---|
| `auth.uid()` | The caller's subject (unchanged) |
| `auth.hasRole('orgadmin')` | True when the caller holds that role. The argument is a literal role name |
| `auth.user('region')` | The caller's field. The argument is a literal field name |

`auth.role()` is removed (`AUTH_ROLE_REMOVED`, with a message suggesting
`auth.hasRole`).

**The operator says whether a field holds one value or many**, as an author would write
it against a Better Auth user:

```sql
WHERE store  =  auth.user('store')      -- one value
WHERE region IN auth.user('region')     -- one or many values
```

- A field used with `=` in one place and `IN` in another fails with
  `USER_FIELD_OPERATOR`, whose message gives the consistent form.
- At runtime, `IN` and a scope accept a single value or an array. `=` receiving an array
  matches no row and logs `USER_FIELD_SHAPE`.
- `NOT IN`, `<>`, `LIKE` and `= ANY(...)` against a user field are refused.
- References may appear only in positive positions: reachable from the root of `WHERE`,
  `JOIN ON` or `HAVING` through `AND` and `OR`.
- They are refused under `NOT`, `IS NOT TRUE`, `IS DISTINCT FROM` or `NOT EXISTS`, inside
  an anti-join, in a select list, in `VALUES`, `SET`, `ORDER BY` or `GROUP BY`, and as a
  function argument.
- In View and Procedure SQL they are the author's own filter, not a boundary. If the SQL
  reads a Schema that is not scoped by that field, the diagnostic
  `USER_FIELD_FILTER_NOT_ENFORCED` says so.
- A field compared with a column must match the column's type and, when both have one,
  its enum (`USER_FIELD_CONFLICT`).

Permission checks in Better Auth's sense (`hasPermission({ order: ["refund"] })`) are not
SQL. They decide whether a caller may call a target, which is `requires` and, under a
host, the host's own grants.

### 4. Scope by user field

```yaml
kind: Schema
metadata: { name: Order }
spec:
  scope:
    region: auth.hasRole('orgadmin') OR auth.user('region')
  properties:
    region: { type: string, enum: [TW, JP, KR] }
  indexes:       [[region, createdAt]]
  uniqueIndexes: [[region, orderNo]]
```

- A Schema may have at most one owner field (`auth.uid()`) and at most one field scope.
  The scoped column is a required, non-nullable string that leads an index. It lowers to
  `column IN field`; a single value is treated as a one-element set.
- **Role escape.** The scope may be prefixed with `auth.hasRole(<role>) OR …` (one or more
  roles). A caller holding one of those roles reads and writes every value. The kernel
  picks one of two pre-lowered statements per request, so the filtered statement keeps
  its index. This is an explicit, author-written widening, visible in the manifest and
  in the `mantle describe` report.
- **Enforcement.** For every non-system caller, the generator wraps every read and write
  position with the scope term. The positions are:
  - the policy wrapper, including joins, subqueries, CTEs, set operations, windows and
    `INSERT … SELECT` sources;
  - `UPDATE` and `DELETE` `WHERE` clauses;
  - the Store guard;
  - parent `EXISTS` checks and parent merges, including the Admin and Store parent
    merges and translation locales.

  A missing or empty field matches no row.
- **No implicit role bypass.** Only the author-written escape widens a scope. No kernel
  shortcut skips the term: the admin shortcut on translation children
  (`role IN ('admin') OR EXISTS(parent)`) keeps the parent's scope inside the `EXISTS`.
  Publishing and translation Schemas may be field-scoped.
- **Correlated fields.** Fields are independent sets. Two scoped Schemas, or one scope
  and an SQL filter, over `region` and `store` grant every combination of the two sets.
  A rule that must pair values ("TW with store A, JP with store B") uses one combined
  field, such as `regionStore: ["TW:A", "JP:B"]`.
- **Writes.**
  - An insert that supplies a value must supply one inside the set (`AUTH_DENIED`, and
    no row is written).
  - An insert without a value auto-fills when the set has one value, and fails with
    `INPUT_VALIDATION_FAILED` otherwise. An anonymous insert is `UNAUTHENTICATED`.
  - A field-scoped Schema always generates the id.
  - Store and Admin inserts share one pre-check.
  - Procedure `INSERT … VALUES` and upsert into a field-scoped Schema follow the same
    pre-check, bound to the value written. `INSERT … SELECT`, and an insert into a table
    the target `restrict`s, run only in trusted mode. (Amended 2026-10-19: every such
    Procedure was trusted-only, so no member could create a field-scoped row in SQL.)
  - The scoped column can never be changed by `SET`: not by Store, by the write
    allowlist, by `DO UPDATE SET`, or by Admin update fragments.
  - A non-trusted write of an `x-mantle-ref` to a scoped Schema must name a parent the
    caller reads that shares the child's value of every common scope field, checked in
    the same statement by Store, Procedure SQL and native Admin's generic create and
    patch (ADR-0034 §8; the full rule is in `schema.md`). (Amended 2026-10-19, #1757: the
    reference was not checked, so a child could name a missing parent or one in another
    partition. #1761 extends the check to native Admin generic writes.)
- **Uniqueness.**
  - Every `uniqueIndexes` entry and every `ON CONFLICT` target is prefixed with
    `[owner?, scoped field?]`. Storage adds the prefix, and both dialects are tested.
  - Uniqueness is therefore per partition. A conflict can never reveal another
    partition's row.
- **Out of set equals missing.** For `findById`, update, delete and `row:true`, a row
  outside the set returns the same code, message and status as a row that does not
  exist.
- **Lowering.**
  - SQLite: `col IN (SELECT value FROM json_each(?))`, binding `'[null]'` for a missing
    or empty set; a single value binds as a one-element set.
  - PostgreSQL: `col = ANY(CAST(CAST($n AS text) AS text[]))`, with every element
    double-quoted and escaped, and NULL bound for an empty set.

  Each field is bound once per statement.
- **Paging.** `col IN field` counts as fan-out fixed for the paging proof, so an index
  such as `[region, createdAt]` serves `ORDER BY createdAt`. The cost is bounded by
  elements × limit. Admin and public variants are each proven.

  **Amended (#1644, 2026-10-15):** the text above is withdrawn. A user-field `IN` term
  (scope or restrict) never fixes an index prefix; only equality does. The statement is
  prepared for a set of values, so `ORDER BY createdAt` after `[region, createdAt]`
  reads and sorts all of the caller's rows on every page, for one value, several values
  and `{ all: true }` alike; no per-value fan-out exists. Generate proves one statement per
  View, the first variant lowering visits (public or caller, before trusted): its
  `ORDER BY` must be served by a declared index after the columns that equality fixes. The
  `{ all: true }` form is that statement with scope `IN` terms replaced by `OR 1 = 1`, and
  restricts kept, so the proof holds for it too. Trusted reads drop scope terms
  (`= auth.uid()` and user-field alike) and restrict terms, and are not proved; see
  [generated surfaces](../handbook/reference/surface.md). The proof does not promise a
  bounded read: an index on the ordered columns alone is accepted, and a scoped caller then
  scans it and filters. A View the proof refuses names the bounded order; the handbook's
  [index prefixes](../handbook/reference/schema.md#index-prefixes-for-paged-views) lists
  the ways and their costs.
- **Public Views.** Row policy applies in public mode too. A public View over a
  field-scoped Schema returns nothing to anonymous visitors, and generate warns with
  `USER_SCOPE_PUBLIC_ANON_EMPTY`. A member with fields sees their own range. Tests pin
  that anonymous callers carry no fields, because anonymous responses may be cached
  publicly.

### 5. Where roles and fields come from

**Members and admins alike.** The references are not admin-only. `auth.hasRole('vip')`
and `auth.user('plan')` work for members the same way they work for admins, because both
are Better Auth users. Whatever sets `user.role` or a field (the admin plugin, an
`additionalFields` entry, `customSession`, or the application's own Better Auth plugin
for groups or teams) feeds the same references.

**Self-hosted: Better Auth.** Mantle reads the session Better Auth already produces:
- `roles` is `user.role` split on commas (the admin plugin's storage).
- `fields` is `session.user.<field>` for each field the application reads. A field may
  be:
  - a stored `additionalFields` entry, which must have `input: false`
    (`AUTH_CONFIGURATION_ERROR` otherwise, so a user can never write their own scope);
  - or a derived field added by `customSession`, which runs on the server.
- Better Auth's `customSession` output is not stored in the cookie cache, so derived
  fields are recomputed on each session read. Mantle caches them per request only.
- Bearer and credential callers (API keys, OAuth access tokens) have no session. An
  optional `authLoader(load, { user: ({ user, credential, token }) => fields })` maps
  them; `token` holds verified token claims, such as those emitted by Better Auth's
  `customAccessTokenClaims`. The callback receives no request, and fields the
  application never reads are dropped.
- `mantle generate` checks the fields it collected against the Better Auth configuration
  it can see and reports a field that has no stored or derived source
  (`USER_FIELD_UNSOURCED`, a warning).

The handbook shows how fields are filled from Better Auth (`additionalFields` with `input: false`, and `customSession`).

Sections 6–10 are superseded by the amendment above; see the handbook’s [Gateway mode](../handbook/reference/authorization.md#gateway-mode).

### 11. Version safety

- `binds`, `bindValues` and `renderTerm` switch exhaustively and throw on an unknown
  recipe or operator.
- Generated modules that use roles or user fields import an `USER_REFS_V1` sentinel, so an
  older runtime fails to link instead of shifting binds.
- One exhaustive `modeOf(caller)` chooses the lowered mode at every dispatch site, and a
  host caller never runs a trusted variant.

## Deliberate bypasses

These paths ignore scope by design. The handbook lists them:
- the system caller and `runtime.store`;
- the TTL sweep;
- `ctx.db` for non-host callers;
- unscoped Schemas, flagged `unscopedReads` by `mantle describe`;
- the author-written role escape (section 4).

## Consequences

- **Portability.** The same manifest runs self-hosted, under a managed host and in local
  tests.
  - The mechanism is open source: the SQL references,
    enforcement, the Better Auth wiring, the host contract, the test tools and the
    conformance suite.
  - Deciding who holds which roles and field values belongs to the identity system or
    gateway in front of the application, not to Mantle.
  - The same references serve members and admins.
- **Authors and agents.** An author declares nothing new and writes rules with names
  agents already know: Better Auth's `user.role` and `user.<field>`, and the
  `hasRole` predicate. What a self-hosted application can supply depends on its Better
  Auth setup. What a host can supply is the host's
  documentation to publish.
- **Breaking changes for the unreleased 0.2:**
  - `auth.role()` removed in favour of `auth.hasRole()`;
  - the rename of `staff` to `admin` (`ctx.admin`, `/mcp/admin`, the default role), the
    open `requires: ctx.admin` role names and the scope grammar;
  - the `Caller` shape and the `HandlerContext` union;
  - the `/mcp/admin` allowlist;
  - the Admin gate and the extension contract;
  - the new `mantle describe` report.
- **Cost.** An application that uses no role or user field generates byte-identical code.
  The shared kernel code, including the bind case, must fit the existing `startup:*`
  budgets.

## Alternatives rejected

- **Custom claims (`auth.claim(name)`).** An earlier draft of this ADR used a
  claims vocabulary from OIDC providers. Mantle's identity layer is Better Auth, whose
  applications read `user.role` and `user.<field>`; a separate claims layer was one more
  concept to learn, with its own callback and test tools.
- **Roles and fields declared in the manifest** (a `kind: Auth` or `kind: Access`). It
  puts a role model into the application, which must stay agnostic: who holds which role
  and what a field means belong to the identity system. Types and the vocabulary are
  derived from use instead.
- **A host staff mode (`staff: "host"`) or a Mantle `staffRoles` setting.** Better Auth's
  `adminRoles`, the admin/member layering and the host's own gate already express it, so
  either would only add a concept Better Auth already has.
- **Keeping the name `staff`.** The self-hosted privileged layer is Better Auth's admin,
  and a managed host may use "staff" for its own, different concept.
- **A generated catalog file committed with the application.** Only something fronting
  the application needs it, so a self-hosted project would carry an unused file and a
  public file format. `mantle describe` produces the same data on demand.
- **A set-valued `auth.role()`.** Agents read `auth.role()` as Supabase's deprecated
  database-role function, and a singular name returning a set invites misreading `IN`.
- **Permissions in SQL** (`hasPermission`). Permissions decide which target a caller may
  call. Mixing them into row scope would duplicate the target gate.
- **A host-only scope source (`host()`).** It was meaningless in a self-hosted
  application and could not be tested locally.
- **A field-level annotation** (a revived `x-mantle-bind`). It compiles to the same plan
  as `scope`, so it would change the grammar twice.
- **Host session variables usable only in SQL.** SQL filters can be bypassed by joins
  and negation, so they cannot be a boundary.

## Acceptance

Each item below runs on bun:sqlite, D1, Bun.SQL and postgres.js. The rows are the
ADR-0034 position matrix: join, `LEFT JOIN`, subquery, CTE, set operation, window,
`INSERT … SELECT`, `DO UPDATE`, Store search, cursor paging and `findById`. The callers
are:
- anonymous;
- a member with fields and a member without;
- a local admin with and without fields, one holding an escape role, and a member
  holding a role with an escape role's name;
- a host caller inside the set, outside it, with an empty set, with a missing field and
  with an escape role;
- the system caller.

Then:
- Every surface (REST, MCP, web, Admin, Store, handlers, publishing and translations).
- Single and array values with `=`, `IN` and scope; mixed operators refused; `=` with an
  array value matching no row.
- A role used only in `requires` or SQL, a misspelled role failing closed, and
  `adminRoles` deciding admin admission.
- Fields from `additionalFields` (with `input: true` refused) and from `customSession`.
- Inserts inside and outside the set, and single-value auto-fill.
- `SET` on the scoped column refused in every path.
- Unique and upsert behaviour that never crosses partitions.
- The element encodings: NULL text, quotes, backslash, comma, braces and lone
  surrogates.
- No local admin: Admin and `/mcp/admin` refuse every local user while host callers
  pass.
- Admin targets checked against Better Auth statements for local admins. Host callers
  do not manage members: gateway-mode applications load no Better Auth instance.
- Member roles and fields with `auth.hasRole()` and `auth.user()`, from the admin plugin,
  `additionalFields`, `customSession` and a test plugin.
- A forged header or props on a public entry.
- Version skew failing to link.
- Batch refusal and pinning.
- The `mantle dev` binding rules.
