# Authorization requirements

Views and Procedures accept:

```yaml
requires:
  auth:
    all:
      - ctx.user
      - { ctx.staff: [staff] }
      - { ctx.auth.scope: "exports:read" }
```

| Predicate | Holds when |
| --- | --- |
| `ctx.user`, `ctx.auth` | Caller is a verified user |
| `{ ctx.staff: [staff] }` | User role matches `staff` |
| `{ ctx.auth.scope: "scope" }` | User scopes include that scope |

All predicates must hold. Anonymous/system callers satisfy none of these predicates. Without `requires`, the invocation is ungated, while Schema row policy still applies. Generation rejects other staff vocabulary; ordinary Caller role strings remain app-owned.

Dynamic `requires.guard` is rejected with `GENERATE_UNSUPPORTED`. Implement custom checks in app-owned handlers before executing queries. Generated TypeScript does not validate arbitrary external input; selected boundaries validate inputs, and direct callers must do so themselves.

Predicate failure is `UNAUTHENTICATED` for a non-user or `AUTH_DENIED` for a user. Scope, TTL and publishing independently limit rows; see [authorization](../concepts/authorization.md).
