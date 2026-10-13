# ADR-0046: Roles and user fields in SQL scope

**Status:** Proposed (issue #1492).

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
- `mantle describe` reports every use (section 9), so authors, agents and hosts read one
  vocabulary. An application that uses none of these generates
  byte-identical code to today.

A misspelled role never matches, so the rule fails closed. A host that compares the
report with what it can supply catches the typo (section 9).

### 1a. Two layers: admin and member

Mantle keeps one boundary between privileged callers and everyone else, and names it
the way Better Auth does.

- **Admin.** A caller holding one of Better Auth's admin plugin `adminRoles` is an admin.
  Mantle reads `adminRoles` from the admin plugin configuration; it has no setting of its
  own. A host caller is an admin by definition (section 6). The previous `staff` role,
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
- `auth.uid()` is unchanged for users. For a host caller it is `'host:' + user.id`
  (section 6).

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
  - Procedure `INSERT` and upsert into a field-scoped Schema run only in trusted mode.
  - The scoped column can never be changed by `SET`: not by Store, by the write
    allowlist, by `DO UPDATE SET`, or by Admin update fragments.
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

The handbook gives Better Auth recipes for common shapes (roles with the admin plugin,
a region field, team membership as a field, a small plugin for groups). Agents working
on a self-hosted application are pointed to them.

**A host (section 6).** A host supplies its own people as admin callers of the same shape. Members of a
hosted application still sign in through the application's own Better Auth, so member
roles and fields come from the same configuration everywhere.

A self-hosted application can reach the same model as a managed host: a Better Auth
plugin with groups and attribute mapping that sets `user.role` and fields produces the
same callers. A host adds operation and governance around it, not a different
mechanism.

**Tests and local development (section 10).** Test tools build users of the same shape.

### 6. Host contract v1

A host supplies a versioned contract when it composes the application:

```ts
{ v: 1, caller, db, media?, mail? }
```

- `db` is the native handle: D1, Bun.SQL, postgres.js, or any driver that passes the
  `Postgres` interface conformance suite. The kernel never branches on which host it
  runs under.
- **`hostCaller(ctx)` builds a host caller.** It reads only `ctx.props.mantle`, which
  only the platform can set, and requires the complete v1 shape. The `user` member has
  the shape of a Better Auth session user:

  ```ts
  { v: 1, kind: "host",
    user: { id, email, name, role: "sales,orgadmin", region: ["TW"] },
    target, targetHash, requestId, credential: "session" | "oauth", bodyDigest }
  ```

  It never reads headers or the body. On a non-admin entry, `props.mantle` is an error
  (a tripwire). The caller's subject is `'host:' + user.id`, and its roles and fields are
  validated like any other caller's.
- **No host mode.** A host that keeps its people outside the application needs no
  switch. No local user holds an `adminRoles` role, so Admin and `/mcp/admin` admit only
  host callers, and the host's own gate decides which targets a host caller may reach.
  Because privilege reads only the admin layer (section 1a), member roles never widen a
  scope.
- **Missing field.** A missing field that a host target needs fails with
  `HOST_CONTRACT` (412) before any SQL runs. Denials of a host caller are 403, never 401.

### 7. Forwarded invocations and target pinning

- **Pinning.** A host caller may call only `props.target`. Each generated function checks
  `caller.kind === "host" && caller.target === <id>`.
- **Release binding.** `targetHash` binds the target to a release. A mismatch is 412.
- **MCP.** A host caller may not send JSON-RPC batches. It may call `initialize`, and
  `tools/call` with the pinned name. The host answers `tools/list` itself.
- **Body binding.** `bodyDigest` binds the body.
- **Origin checks.** Session-credential host writes keep origin checks: the host checks
  `Sec-Fetch-Site`/`Origin` before issuing props, and `checkOrigin` applies according to
  `props.credential`.
- **`/mcp/admin`** (renamed from `/mcp/staff`) becomes an allowlist: admins, or host
  callers.
  It is no longer a denylist that admits new caller kinds by default.
- **Subjects.** User subjects may not start with `system:` or `host:`. Host writes record
  `author_id = 'host:' + user.id`.

### 8. Admin, content and handlers accept host callers

- **Admin targets.** Every Admin API route maps to exactly one target id
  (`admin:<method> <path template>`), and the id must equal `props.target`.
  `mantle describe` lists Admin targets.
- **Gates.** The Admin gate, the extension contract (`caller: { kind: "admin" | "host" }`),
  publishing transitions, site settings and media accept host callers, and scope
  applies throughout. `requires: ctx.admin` checks the host caller's roles.
- **Drafts.** Host callers see drafts, as admins do.
- **Member management.** Admin's identity routes (list and view users, ban and unban,
  revoke sessions, set member roles) are targets like any other, each naming its Better
  Auth statement.
  - A local admin's call goes through Better Auth's admin API with the admin's own
    request, as today.
  - A host caller has no session in the application's Better Auth. Its call runs through
    Better Auth's server context with the same effects as the admin API (for a ban: the
    ban fields and revoking every session), and records `host:` + `user.id` as the
    actor.
  - A host caller can never give a user an `adminRoles` role.
  - Impersonation is never host-callable.
- **Owner-scoped Schemas.** A host caller's subject is `'host:' + user.id`, so it sees
  only rows it owns, never a member's. `mantle describe` flags such targets `ownerScoped`.
- **Ref handlers.** Host callers may call them.
  - `ctx.store` is bound to the host caller and enforces scope.
  - `ctx.db` is undefined for host callers; `HandlerContext` is a union by caller kind.
  - Such Procedures are flagged `opaque` by `mantle describe`. Custom code is the author's
    responsibility, and the report makes that visible.

### 9. `mantle describe`: what the application exposes and who sees what

`mantle describe` reports, for the application as it is generated, every entry point and
how it is protected. It is useful to anyone reviewing permissions before release, to
coding agents checking what they wrote, and to anything that fronts the application (a
gateway, generated documentation, a host). It writes no file into the project.

- `mantle describe` prints a human-readable report: targets, which are enforced by
  scope, which only filter in SQL, and which run custom handler code.
- `mantle describe --json`, and the same data from the exported function
  `describeApp(plan)`, give a machine-readable report with a published JSON Schema and
  `schemaVersion`.

**Top level:** `access`, every role and user field the application uses, with each
field's type, enum, operator form and the Schemas whose scope binds it. It is derived
from use, never declared.

**Each target** is an MCP `Tool` object (`name`, `title`, `description`, `inputSchema`,
`annotations`). Mantle's fields sit under `_meta`:
- surface, kind and `targetHash`;
- `roles`: the roles its `requires` accepts and the roles that widen its scope;
- `userFields`: each field it reads, and whether through `scope` (enforced) or `sql`
  (a filter only);
- `hostCallable`;
- the flags `opaque`, `rawDb`, `ownerScoped` and `unscopedReads`.

The report holds no SQL and no data. Anything that fronts the application builds its
own registry from it; Mantle does not define such registries.

### 10. Local testing and development

`@aotter/mantle/testing` (a new export, refused by `mantle bundle`) provides:

- **`authenticatedAs(user, options?)`** builds a branded member, admin or host caller
  from a Better Auth–shaped user (`{ id, role: "sales", region: ["TW"] }`) and calls
  generated functions directly. It verifies lowering and binds. A host target is a
  generated literal union type, so a misspelled target fails typecheck.
- **`userFor(auth, user)`** runs the application's real Better Auth session pipeline,
  including `customSession`, and returns the fields Mantle would bind.
- **`fakeHost(app, { user } | { persona })`** drives `app.fetch` with `props.mantle` the
  way a host does:
  - it resolves targets from the `mantle describe` data;
  - it sends only the fields a target reads;
  - it reproduces `HOST_CONTRACT`.

  Entry selection, context passing, gates and pinning are therefore tested.
- **Fixture schema.** A published JSON Schema describes user fixtures (personas). A host
  may export them, sanitized, with stable labels and a `planHash`; a stale fixture fails
  with `USER_FIXTURE_STALE`.

`mantle dev --as role=sales,region=TW[,JP]` (or `--as <fixture>`) uses `fakeHost` for admin
targets and prints the resulting scope. Members sign in through the application's own
Better Auth as usual.
- It binds only to 127.0.0.1.
- It checks the `Host` header.
- It requires a per-run token.
- It refuses remote data unless `--allow-remote-data` is set.

Visibility assertions must not use the system caller or `runtime.store`, because both
bypass scope.

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
  - Deciding who holds which roles and field values (groups, attribute mapping, grants,
    audit) belongs to whoever operates the application. Self-hosted, that is the
    application's own Better Auth configuration and plugins; a self-hosted application
    that builds those plugins reaches the same model a managed host offers.
  - The same references serve members and admins.
- **Authors and agents.** An author declares nothing new and writes rules with names
  agents already know: Better Auth's `user.role` and `user.<field>`, and the
  `hasRole` predicate. What a self-hosted application can supply depends on its Better
  Auth setup, and the handbook recipes cover it. What a host can supply is the host's
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
- Admin targets checked against Better Auth statements for local admins; host member
  management (ban with session revocation, member roles only, no `adminRoles`, no
  impersonation).
- Member roles and fields with `auth.hasRole()` and `auth.user()`, from the admin plugin,
  `additionalFields`, `customSession` and a test plugin.
- A forged header or props on a public entry.
- Version skew failing to link.
- Batch refusal and pinning.
- The `mantle dev` binding rules.
