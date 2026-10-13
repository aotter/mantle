# Authorization requirements

Views and Procedures accept:

```yaml
requires:
  auth:
    all:
      - ctx.user
      - ctx.admin
      - { ctx.admin: [editor] }
      - { ctx.auth.scope: "exports:read" }
```

| Predicate | Holds when |
| --- | --- |
| `ctx.user`, `ctx.auth` | Caller is a verified user |
| `ctx.admin` | Caller is in the admin layer |
| `{ ctx.admin: [editor] }` | Admin holds one of the listed roles |
| `{ ctx.auth.scope: "scope" }` | User scopes include that scope |

All predicates must hold. Anonymous/system callers satisfy none of these predicates. Without `requires`, the invocation is ungated, while Schema row policy still applies. Role names are application-owned and match `^[a-z][a-zA-Z0-9_]{0,62}$`; the list is open. A member holding a listed role gains nothing. Better Auth’s admin plugin `adminRoles` determines the admin layer (default `["admin"]`); Mantle has no role setting of its own.

Dynamic `requires.guard` is rejected with `GENERATE_UNSUPPORTED`. Implement custom checks in app-owned handlers before executing queries. Generated TypeScript does not validate arbitrary external input; selected boundaries validate inputs, and direct callers must do so themselves.

Predicate failure is `UNAUTHENTICATED` for a non-user or `AUTH_DENIED` for a user. Scope, TTL and publishing independently limit rows; see [authorization](../concepts/authorization.md).
