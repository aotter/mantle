# Authorization requirements

Views and Procedures accept:

```yaml
requires:
  auth:
    all:
      - ctx.user
      - ctx.admin
      - { ctx.auth.scope: "exports:read" }
```

| Predicate | Holds when |
| --- | --- |
| `ctx.user`, `ctx.auth` | Caller is a verified user |
| `ctx.admin` | Caller is in the admin layer |
| `{ ctx.auth.scope: "scope" }` | User scopes include that scope |

Selected REST, MCP and Admin boundaries accept an optional `authorize(target, caller)` callback. `Target`, exported by `@aotter/mantle/contracts`, contains `kind` (`view`, `procedure` or `schema`) and the manifest `name`; Admin generic entry routes also supply `action` (`read`, `create`, `update` or `delete`). The callback runs after credentials and `requires` pass, before execution and row policy. A false result or rejected promise returns `AUTH_DENIED` (HTTP 403); a synchronous exception is an internal error. MCP tool lists and Admin navigation metadata hide denied targets. Omitting the callback preserves existing behavior; direct generated typed functions do not invoke it.

All predicates must hold. Anonymous/system callers satisfy none of these predicates. Without `requires`, the invocation is ungated, while Schema row policy still applies. Role lists such as `{ ctx.admin: [editor] }` are refused: decide per-target roles in application code. Role names match `^[a-z][a-zA-Z0-9_-]{0,62}$`; an invalid name in a verified user's role fails identity resolution and names the role. Better Auth’s admin plugin `adminRoles` determines the admin layer (default `["admin"]`); Mantle has no role setting of its own.

Dynamic `requires.guard` is rejected with `GENERATE_UNSUPPORTED`. Implement custom checks in app-owned handlers before executing queries. Generated TypeScript does not validate arbitrary external input; selected boundaries validate inputs, and direct callers must do so themselves.

Predicate failure is `UNAUTHENTICATED` for a non-user or `AUTH_DENIED` for a user. Scope, TTL and publishing independently limit rows; see [authorization](../concepts/authorization.md).

## User fields

A user field is a value the identity provider verified on the user, such as `region`. It limits rows in two places only:

- A Schema `scope` applies to every SQL relation, Store, REST/MCP and native Admin access: `scope: "region IN auth.user('region')"`. See [Schema](schema.md#field-scope).
- A View or Procedure `restrict` applies to one target: `restrict: { orders: "region IN auth.user('region')" }`. See [View](view.md#restrict).

Values come from the verified Better Auth user record. Fields must be server-set: declare stored fields with `input: false` in `user.additionalFields`, or produce derived fields through `customSession`. Pass the generated `userFields` constant as `resolveCaller(request, auth, { fields: userFields })`.

SQL cannot reference caller values: `auth.user()` fails with `USER_REF_SCOPE_ONLY`, and `auth.hasRole()` / `auth.role()` with `AUTH_ROLE_REMOVED`. Names are literals; Better Auth core fields and names beginning `mantle` are reserved.

Values come from the original frozen Caller, which holds identity in a private WeakMap. Anonymous and copied/unbranded callers have no roles or user fields. Values are validated and frozen: finite numbers; strings of 1–256 UTF-8 bytes without NUL or lone surrogates; arrays of at most 64 items with duplicates removed, only for multi-valued fields. `{ all: true }` is the typed "every value" state of one field. Unknown user fields are discarded. A missing or empty value is refused before SQL runs (`UNAUTHENTICATED` for anonymous callers, otherwise `AUTH_DENIED`); it never matches every row. Never mint verified users from request data. Resolve credentials before constructing an identity, and pass the original Caller to generated operations.

## Gateway mode

Selected `rest`, `mcp` and `admin` boundaries accept `gateway: { tenant: "example" }`. Forward the execution context: `api(request, env, ctx)` from `fetch(request, env, ctx)`. Only `ctx.props.mantle` supplies identity; absent props are anonymous. Application cookies and bearer tokens are ignored, and the application's auth instance is never loaded. Present props on an entry without gateway mode fail with `HOST_CONTRACT` (412).

The v1 props contain `v: 1`, the configured `tenant`, `layer` (`admin` or `member`), `user` (`id`, optional `role`, `email`, `name` and user fields), `authenticatedAs` (`snapshot` or `fresh`), `credential` (`session` or `oauth`) and `requestId`. Optional `target`, `targetHash`, `bodyDigest` and `dryRun: true` are accepted. `hostCaller(props, { tenant, fields })` from `@aotter/mantle/host-caller` validates and brands this shape. Generated boundaries supply inferred field types; manually composed boundaries may pass `fields`. Tests use `hostAs(props)` from `@aotter/mantle/testing` with the same JSON.

Admin-layer callers have kind `host`, subject `host:<id>` and the admin layer. Member-layer callers have kind `user`, subject `<id>` and no admin privilege, regardless of role names. Both retain ordinary scope checks and expose freshness, credential and request id to application code. Admin-layer callers see drafts; member management refuses host-built callers with 403. Copies lose identity authority.

Snapshots may read only: SQL writes, Store/Admin mutations, publishing transitions and ref handlers fail before execution with `STALE_CALLER` (403). SQL Procedure classification comes from compiled statement kinds. Session writes keep origin checks. Both layers receive `{ error: { code, field?, target? } }`: 412 for invalid contracts, tenant mismatches or missing/empty required fields (naming the field), 403 for denials, and 400 for malformed bodies; never 401.
