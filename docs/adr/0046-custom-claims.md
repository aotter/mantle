# ADR-0046: Custom claims and claim scope

**Status:** Proposed (issue #1492).

**Date:** 2026-10-13

**Amends:** ADR-0002 (closed value references: `auth.claim(name)` joins `auth.uid()` and
`auth.role()`), ADR-0030 and ADR-0034 (a Schema `scope` may bind a claim as well as the
caller's id), and ADR-0032 decision 8 (a caller carries claims, and a host may supply the
caller).

## Context

#1492 keeps a generic authorization mechanism in Mantle and leaves the management of
roles, groups and attributes to whoever runs the application. Mantle already speaks
Supabase's vocabulary: `auth.uid()` and `auth.role()`. Mature products express
per-caller data rules the same way:
- Supabase uses custom claims, added by a Custom Access Token Hook and read in policies.
- Firebase uses custom claims, read in rules as `request.auth.token`, and tests them with
  `authenticatedContext(uid, claims)`.
- Hasura uses session variables.
- OIDC providers such as Keycloak use protocol mappers that emit claims.

In each of these products, the rule names a claim. An identity system fills the claim in
production, and a test harness fills it locally, so the same rule passes both.

Mantle needs that shape for three reasons:
1. An author writes an ordinary, testable rule: "sales staff see the orders of their
   regions".
2. A self-hosted application fills the claims itself.
3. A managed host or gateway authenticates staff in front of the application and fills
   the claims there. The application never learns about the host's groups, roles or
   attributes; it only reads claims.

## Decision

### 1. Claims are part of the caller

- A non-system caller carries `claims`: a map from claim name to a set of strings.
- Claims are validated once, deep-frozen and stored in a private `WeakMap` keyed by the
  caller. Binds read claims only from there. `caller.claims` is a read-only view.
- A caller without a brand binds no claims: a user or anonymous caller binds `{}`, and a
  host caller without a brand is an error. A copied caller object loses its claims, so a
  copy fails closed.
- Anonymous callers never carry claims.
- Each value must be well-formed UTF-8, between 1 and 256 bytes, and contain no NUL.
  A claim holds at most 64 values; duplicates are removed. A single string is normalized
  to a one-element set, and null to `{}`.
- An invalid value is an error (`CLAIMS_INVALID`). Values are never silently filtered.
- Claim names match `^[a-z][a-z0-9_]{0,62}$` and are literals. These names are reserved:
  `uid sub role roles scope scopes actor kind v target request_id iss aud exp iat nbf jti`
  and `mantle_*`.

### 2. `auth.claim(name)` is a SQL value reference

**In a Schema scope** (the enforced form):

```yaml
kind: Schema
metadata: { name: Order }
spec:
  scope:
    region: auth.claim('region')
  properties:
    region: { type: string, enum: [TW, JP, KR] }
  indexes:       [[region, createdAt]]
  uniqueIndexes: [[region, orderNo]]
```

**In View and Procedure SQL**, only one form is accepted:

```sql
WHERE region IN (auth.claim('region'))
```

- The IN list holds only the claim.
- `=`, `NOT IN`, `<>`, `LIKE` and `= ANY(...)` are refused with `CLAIM_SET_OPERATOR`,
  whose message suggests the IN form.
- The reference may appear only in positive positions: reachable from the root of
  `WHERE`, `JOIN ON` or `HAVING` through `AND` and `OR`.
- It is refused under `NOT`, `IS NOT TRUE`, `IS DISTINCT FROM` or `NOT EXISTS`, inside an
  anti-join, in a select list, in `VALUES`, `SET`, `ORDER BY` or `GROUP BY`, and as a
  function argument.
- In SQL it is the author's own filter, not a boundary. If the SQL reads a Schema that is
  not scoped by that claim, the diagnostic `CLAIM_FILTER_NOT_ENFORCED` says so.

**Types.** A claim compared with a column takes the column's type, and v1 claims are
strings. Two scopes that bind the same claim must agree on type and enum
(`CLAIM_CONFLICT`). An enum is optional: without one the claim works, but `mantle
generate` warns that no generated list of all values exists.

### 3. Claim scope semantics

- A Schema may have at most one owner field (`auth.uid()`) and at most one claim field.
  The claim field is a required, non-nullable string that leads an index.
- **Reads.** For every non-system caller, the generator wraps every read and write
  position with `column IN (caller's set)`. The positions are:
  - the policy wrapper, including joins, subqueries, CTEs, set operations, windows and
    `INSERT … SELECT` sources;
  - `UPDATE` and `DELETE` `WHERE` clauses;
  - the Store guard;
  - parent `EXISTS` checks and parent merges, including the Admin and Store parent
    merges and translation locales.

  A missing or empty claim matches no row.
- **No role bypass.** No role-based shortcut skips a claim term. In particular, the
  staff shortcut on translation children (`role IN ('staff') OR EXISTS(parent)`) keeps
  the parent's claim term inside the `EXISTS`. Publishing and translation Schemas may be
  claim-scoped.
- **The "all values" escape is itself a claim.** A scope can lift the filter for callers
  who hold a second claim:

  ```yaml
  scope:
    region: auth.claim('region') OR auth.claim('region_all')
  ```

  - A caller whose `region_all` claim is non-empty reads and writes every value.
  - Every other caller is filtered by `region`.
  - The kernel picks one of two pre-lowered statements per request, so the filtered
    statement keeps its index.
  - The escape names a claim, never `auth.role()`. Roles stay out of scope, so a host
    and a self-hosted application decide "all" in the same way.
- **Writes.**
  - An insert that supplies a value must supply one inside the set (`AUTH_DENIED`, and
    no row is written).
  - An insert without a value auto-fills when the set has one value, and fails with
    `INPUT_VALIDATION_FAILED` otherwise. An anonymous insert is `UNAUTHENTICATED`.
  - A claim-scoped Schema always generates the id.
  - Store and Admin inserts share one pre-check.
  - Procedure `INSERT` and upsert into a claim-scoped Schema run only in trusted mode.
  - The claim column can never be changed by `SET`: not by Store, by the write
    allowlist, by `DO UPDATE SET`, or by Admin update fragments.
- **Uniqueness.**
  - Every `uniqueIndexes` entry and every `ON CONFLICT` target is prefixed with
    `[owner?, claim?]`. Storage adds the prefix, and both dialects are tested.
  - Uniqueness is therefore per partition. A conflict can never reveal another
    partition's row.
- **Out of set equals missing.** For `findById`, update, delete and `row:true`, a row
  outside the set returns the same code, message and status as a row that does not
  exist.
- **Lowering.**
  - SQLite: `col IN (SELECT value FROM json_each(?))`, binding `'[null]'` for a missing
    or empty set.
  - PostgreSQL: `col = ANY(CAST(CAST($n AS text) AS text[]))`, with every element
    double-quoted and escaped, and NULL bound for an empty set.

  Each claim is bound once per statement.
- **Paging.** `col IN (claim)` counts as fan-out fixed for the paging proof, so an index
  such as `[region, createdAt]` serves `ORDER BY createdAt`. The cost is bounded by
  elements × limit. Staff and public variants are each proven.
- **Public Views.** Row policy applies in public mode too. A public View over a
  claim-scoped Schema returns nothing to anonymous visitors, and generate warns with
  `CLAIM_SCOPE_PUBLIC_ANON_EMPTY`. A member with claims sees their own range. Tests pin
  that anonymous callers carry no claims, because anonymous responses may be cached
  publicly.

### 4. Where claims come from

**The application's claims callback (self-hosted).** It is set once on `authLoader` and
runs for session, bearer and credential callers. It is the same idea as Supabase's
Custom Access Token Hook:

```ts
const auth = authLoader(load, {
  claims: async ({ user, caller, credential, token }) =>
    caller.role === "staff"
      ? { region_all: ["1"] }
      : { region: user.region ?? [] },
})
```

- The callback receives no `request`. An optional `narrow(claims, request)` may only
  intersect the result.
- `token` holds verified external token claims, so claims from an external identity
  provider pass through.
- `claimsFromUserFields(["region"])` reads Better Auth user fields. It refuses any field
  that is not `additionalFields` with `input: false` (`AUTH_CONFIGURATION_ERROR`), so a
  user can never write their own claims.
- Claims read from a table are cached per request. Across requests the cache is
  read-only, keyed by the session and `user.updatedAt`, within the cookie cache TTL.
  Writes always recompute.
- The application may also export the callback as `claims()` from its module. A host
  that composes the application calls the same function for member requests, so member
  claims are the same everywhere.

**The host (section 5).** A host computes staff claims and passes them in.

**Tests and local development (section 7).** Test tools fill claims locally.

### 5. Host contract v1

A host supplies a versioned contract when it composes the application:

```ts
{ v: 1, caller, db, staff: "local" | "host", media?, mail?, claims }
```

- `db` is the native handle: D1, Bun.SQL, postgres.js, or any driver that passes the
  `Postgres` interface conformance suite. The kernel never branches on which host it
  runs under.
- **`hostCaller(ctx)` builds a host caller.** It reads only `ctx.props.mantle`, which
  only the platform can set, and requires the complete v1 shape:

  ```ts
  { v: 1, kind: "host", actor, claims, target, targetHash, requestId,
    credential: "session" | "oauth", bodyDigest }
  ```

  It never reads headers or the body. On a non-staff entry, `props.mantle` is an error
  (a tripwire). A host caller has no uid and no role.
- **`staff: "host"` means staff exist only as host callers.**
  - Local users' roles bind null.
  - `ctx.staff`, `/mcp/staff` and Admin accept only host callers.
  - Local staff management (setting roles, staff invitations) is disabled.

  With `staff: "local"` (the default), the application's own `staff` role works as
  today.
- **Missing claim.** A missing claim that a host target needs fails with
  `CLAIMS_CONTRACT` (412) before any SQL runs. Claims the target does not read are
  ignored and logged. Denials of a host caller are 403, never 401.

### 6. Forwarded invocations and target pinning

- **Pinning.** A host caller may call only `props.target`. Each generated function checks
  `caller.kind === "host" && caller.target === <id>`.
- **Release binding.** `targetHash` binds the target to a release. A mismatch is 412.
- **MCP.** A host caller may not send JSON-RPC batches. It may call `initialize`, and
  `tools/call` with the pinned name. The host answers `tools/list` itself.
- **Body binding.** `bodyDigest` binds the body.
- **Origin checks.** Session-credential host writes keep origin checks: the host checks
  `Sec-Fetch-Site`/`Origin` before issuing props, and `checkOrigin` applies according to
  `props.credential`.
- **`/mcp/staff`** becomes an allowlist: staff users (`staff: "local"`) or host callers.
  It is no longer a denylist that admits new caller kinds by default.
- **Subjects.** User subjects may not start with `system:` or `host:`. Host writes record
  `author_id = 'host:' + actor`.

### 7. Admin, content and handlers accept host callers

- **Admin targets.** Every Admin API route maps to exactly one target id
  (`admin:<method> <path template>`), and the id must equal `props.target`. The catalog
  lists Admin targets.
- **Gates.** The Admin gate, the extension contract (`caller: { kind: "staff" | "host" }`),
  publishing transitions, site settings and media accept host callers, and claim scope
  applies throughout.
- **Drafts.** Host callers see drafts, as staff do.
- **Owner-scoped Schemas.** These have no member subject for a host. They read as empty
  for host callers, and host writes to them are `AUTH_DENIED`. The catalog flags such
  targets `alwaysEmptyForHost`.
- **Ref handlers.** Host callers may call them.
  - `ctx.store` is bound to the host caller and enforces scope.
  - `ctx.db` is undefined for host callers; `HandlerContext` is a union by caller kind.
  - Such Procedures are flagged `opaque` in the catalog. Custom code is the author's
    responsibility, and the catalog lets a host's administrators see that.

### 8. Capability catalog

`mantle generate` writes `catalog.json` as a managed generated file. It has a published
JSON Schema and `schemaVersion`, and lists `hostContract: [1]`.

**Top level:** `vocabulary.claims`, the claim names with their types, enums and the
Schemas that bind them.

**Each target** is an MCP `Tool` object (`name`, `title`, `description`, `inputSchema`,
`annotations`). Mantle's fields sit under `_meta`:
- surface, kind and `targetHash`;
- `claims`: each claim it reads, and whether through `scope` (enforced) or `sql`
  (a filter only);
- `hostCallable`;
- the flags `opaque`, `rawDb`, `ownerScoped`, `alwaysEmptyForHost`, `readsRole` and
  `unscopedReads`.

The catalog holds no SQL and no data. Its file name must not collide with the MCP Apps
catalog.

### 9. Local testing and development

`@aotter/mantle/testing` (a new export, refused by `mantle bundle`) provides:

- **`authenticatedAs(subject, claims, options?)`** builds a branded user, staff or host
  caller and calls generated functions directly. It verifies lowering and binds. A host
  target is a generated literal union type, so a misspelled target fails typecheck.
- **`claimsFor(callback, user)`** runs the application's real claims callback.
- **`fakeHost(app, { actor, claims } | { persona })`** drives `app.fetch` with
  `props.mantle` the way a host does:
  - it resolves targets from the catalog;
  - it sends only the claims a target reads;
  - it reproduces `CLAIMS_CONTRACT`.

  Entry selection, context passing, gates and pinning are therefore tested.
- **Fixture schema.** A published JSON Schema describes claim fixtures (personas). A host
  may export them, sanitized, with stable labels and a `planHash`; a stale fixture fails
  with `CLAIMS_FIXTURE_STALE`.

`mantle dev --claims region=TW[,JP]` uses `fakeHost` for staff targets and prints its
scope. `--member-claims` overrides the callback for member routes.
- It binds only to 127.0.0.1.
- It checks the `Host` header.
- It requires a per-run token.
- It refuses remote data unless `--allow-remote-data` is set.

Visibility assertions must not use the system caller or `runtime.store`, because both
bypass scope.

### 10. Version safety

- `binds`, `bindValues` and `renderTerm` switch exhaustively and throw on an unknown
  recipe or operator.
- Generated modules that use claims import a `CLAIMS_V1` sentinel, so an older runtime
  fails to link instead of shifting binds.
- One exhaustive `modeOf(caller)` chooses the lowered mode at every dispatch site, and a
  host caller never runs a trusted variant.

## Deliberate bypasses

These paths ignore claim scope by design. The handbook lists them:
- the system caller and `runtime.store`;
- the TTL sweep;
- `ctx.db` for non-host callers;
- unscoped Schemas, flagged `unscopedReads` in the catalog.

## Consequences

- **Portability.** The same manifest runs self-hosted, under a managed host and in local
  tests.
  - The mechanism is open source: grammar, enforcement, the callback, the host contract,
    the test tools and the conformance suite.
  - Deciding who holds which claims (identity, groups, attributes, mappers, grants,
    audit) belongs to whoever operates the application.
- **Authors.** Authors write one more value reference, and agents that know Supabase,
  Firebase or Hasura already know its meaning.
- **Breaking changes for the unreleased 0.2:**
  - the scope grammar;
  - the `Caller` shape and the `HandlerContext` union;
  - the `/mcp/staff` allowlist;
  - the Admin gate and the extension contract;
  - the new generated `catalog.json`.
- **Cost.** An application without claims generates byte-identical code. The shared
  kernel code, including the bind case, must fit the existing `startup:*` budgets.

## Alternatives rejected

- **A host-only scope source (`host()`).** It was meaningless in a self-hosted
  application and could not be tested locally.
- **Roles and attributes declared in the manifest.** They put a role model into the
  application, which must stay agnostic.
- **A field-level annotation** (a revived `x-mantle-bind`). It compiles to the same plan
  as `scope`, so it would change the grammar twice.
- **Host session variables usable only in SQL.** SQL filters can be bypassed by joins
  and negation, so they cannot be a boundary.
- **`auth.role()` in scope for "all".** A managed host's callers have no role. The escape
  is a claim, so every host decides "all" the same way.

## Acceptance

Each item below runs on bun:sqlite, D1, Bun.SQL and postgres.js. The rows are the
ADR-0034 position matrix: join, `LEFT JOIN`, subquery, CTE, set operation, window,
`INSERT … SELECT`, `DO UPDATE`, Store search, cursor paging and `findById`. The callers
are:
- anonymous;
- a member with claims and a member without;
- a local staff user with and without claims, and one holding the "all" claim;
- a host caller inside the set, outside it, with an empty set and with a missing claim;
- the system caller.

Then:
- Every surface (REST, MCP, web, Admin, Store, handlers, publishing and translations).
- Inserts inside and outside the set, and single-value auto-fill.
- `SET` on the claim column refused in every path.
- Unique and upsert behaviour that never crosses partitions.
- The element encodings: NULL text, quotes, backslash, comma, braces and lone
  surrogates.
- `staff: "host"` refusing a local `role='staff'` user on Admin and `/mcp/staff`.
- A forged header or props on a public entry.
- Version skew failing to link.
- Batch refusal and pinning.
- The `mantle dev` binding rules.
