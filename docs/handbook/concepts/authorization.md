---
description: One authorization pipeline for REST, MCP and Admin — identity kinds, static predicates, the dynamic guard, staff roles and 401/403/402.
---
# Authorization

Mantle has one authorization pipeline. A manifest HTTP Trigger, a View over REST, an MCP `tools/call` and an Admin operation all reach the same evaluator, so a rule written once holds on every surface. This page explains the model; the exact `requires` grammar is in the [authorization reference](../reference/authorization.md), and a worked ladder of four access levels is in [Guarded API access](../examples/guarded-api.md).

## The fixed order

Every protected invocation runs the same five steps:

1. Verify and normalize the transport credential.
2. Evaluate the static predicates in `requires.auth.all`, before any input-schema detail is exposed.
3. Validate and coerce the target input, or the View params.
4. Invoke the guard Procedure with that validated value and the same context.
5. Invoke the target only after the guard succeeds.

Static predicates run before validation so an unauthorized caller cannot probe a schema by reading its error messages. The guard runs after validation so it can decide on the actual arguments. Every stage fails closed.

## Identity kinds

The adapter verifies the transport, then hands the runtime normalized, non-secret metadata. Handlers see this and nothing else:

```ts
interface HandlerContext {
  readonly user: { readonly id: string } | null;
  readonly staff: { readonly id: string; readonly role: StaffRole } | null;
  readonly auth?: {
    readonly credential: "session" | "oauth" | "api-key" | "personal-token";
    readonly credentialId: string | null;
    readonly clientId: string | null;
    readonly scopes: readonly string[];
  };
}
```

Three things are distinct:

- **`ctx.user`** is the end-user identity: a row in the site's own Better Auth user table. A service API key may have no user at all.
- **`ctx.staff`** is a role overlay on top of a user, not a separate account. A user with no overlay is `null` here.
- **`ctx.auth`** is the verified credential itself, of kind `session`, `oauth`, `api-key` or `personal-token`. Raw keys, refresh tokens and cookies never enter the runtime; `credentialId` is an opaque record id.

The predicate vocabulary is closed and maps onto those three: `ctx.user`, `ctx.auth`, `{ "ctx.auth.scope": "<scope>" }` (repeat it to require several), and `{ "ctx.staff": [roles] }`. There is no credential-kind predicate — a target that must reject browser sessions does so by requiring a scope no session grant carries.

## Predicates versus the guard

| | Static predicates | Guard Procedure |
|---|---|---|
| Declared as | `requires.auth.all` | `requires.guard.procedure` |
| Answers | Is this caller of the right kind, with the right role and scopes? | Is this verified caller allowed to do this business action right now? |
| Evaluated | Before input validation | After input validation, on every call, never cached |
| Reads | The compiled plan only | Your tables, your provider state, `ctx.env` |
| Typical failure | `401` or `403` | `402` |

Anything that changes independently of the credential belongs in the guard: payment state, subscription or membership status, seat counts, per-tenant entitlement. A key stays valid while a subscription lapses, so the fact that a caller paid is not something a token can carry. The guard is an ordinary unguarded `handler.kind: ref` Procedure — not a fifth atom — and it throws a structured diagnostic to deny:

```ts
throw new DiagnosticError(
  runtimeDiagnostic({
    code: "ENTITLEMENT_REQUIRED",
    severity: "error",
    path: `site:membership/${ctx.user!.id}`,
    message: "Active membership is required.",
  }),
);
```

## 401, 403 and 402

| Status | Diagnostic | Meaning |
|---|---|---|
| `401` | `UNAUTHENTICATED` | No credential, or a recognized credential that is bad, revoked or expired. |
| `403` | `AUTH_DENIED` | Verified caller, but a required predicate failed — a missing scope, a missing user subject, an insufficient staff role. |
| `402` | `ENTITLEMENT_REQUIRED` | Verified and permitted caller whose current business state does not allow the action. |

The split is the point: `401` says *who are you*, `403` says *you may not*, `402` says *not until you settle something*. Only the guard produces `402`, and on `402` the target handler is never invoked. See [Diagnostic codes](../reference/diagnostics.md) for the full mapping.

## Staff roles

Staff roles are `owner`, `editor` and `contributor`. Owners manage staff and site settings; editors publish, approve and manage entries; contributors work on drafts.

A manifest predicate tests **exact membership**, not rank: `{ "ctx.staff": [editor] }` admits editors and nobody else, an owner included. List every role you mean, as in `{ "ctx.staff": [owner, editor] }`. Rank ordering does exist, but only Admin's own route table uses it, which is why an owner passes an Admin route gated at editor. See [Authorization requirements](../reference/authorization.md).

The role is re-read from the database on every protected REST and MCP call. A token snapshot or a consent-time role is not an authorization boundary, so demoting or revoking a user in Admin locks them out on their very next request — no token revocation, no cache flush, no waiting for expiry.

## The credential resolver seam

Sites that issue their own API keys or personal tokens supply one `ConsumerCredentialResolver` through the Worker's `extend` seam. It returns exactly one of three outcomes:

| Outcome | Meaning |
|---|---|
| `not-handled` | The request carries none of the site's credential formats. Resolution moves on. |
| `invalid` | The request carries a recognized format that is bad, revoked or malformed. |
| `verified` | The site's authoritative record was checked; normalized metadata is returned. |

Resolution precedence is site resolver, then configured OAuth bearer, then cookie session. A recognized-but-invalid credential never falls back to a valid cookie: presenting a revoked key is a failure, not an invitation to be treated as an anonymous browser. Return `not-handled`, never `invalid`, for a request your resolver simply does not recognize.

Scopes are opaque strings the site defines and grants. Mantle compares them; it does not interpret `catalog:read`, publish a scope catalog, or infer a hierarchy. Correspondingly, Mantle issues and stores no API keys or personal tokens, and holds no payment or subscription state. Those tables, their issuance, hashing, rotation and revocation, and whatever fills them from a billing provider, are application code. Mantle owns verification, normalization and enforcement.

## MCP is the same pipeline

An MCP `tools/call` runs the identical evaluator, in the identical order, with the identical diagnostics — surfaced as JSON-RPC errors carrying `error.data.code` instead of an HTTP status. A Trigger's `source.surface` selects which catalog lists a tool, and `tools/list` hides what the caller cannot see. That filtering is discovery UX, not enforcement: a client that guesses a tool name still meets every predicate and the guard. Discovery is never the authorization boundary. See [MCP and agents](./mcp-and-agents.md).

## Related

- [Authorization requirements](../reference/authorization.md) — the `requires` shape, predicate forms, guard rules, OpenAPI projection.
- [Guarded API access](../examples/guarded-api.md) — a full resolver, guards and the REST/MCP outcome tables.
- [Reads: Views, REST and MCP](./views.md) — the `$ctx.user` identity-View sentinel.
- [Authentication](../cloudflare/authentication.md) — sessions, first owner, role management routes.

## Source
- [`docs/api-mcp-authorization.md`](../../../docs/api-mcp-authorization.md)
- [`docs/adapter-guide.md`](../../../docs/adapter-guide.md)
- [`packages/mantle-runtime/src/domain/model/HandlerContext.ts`](../../../packages/mantle-runtime/src/domain/model/HandlerContext.ts)
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts)
- [`packages/adapters/cloudflare/src/mount/resolveCaller.ts`](../../../packages/adapters/cloudflare/src/mount/resolveCaller.ts)
- [`packages/mantle-spec/src/domain/service/StaffRoleHierarchy.ts`](../../../packages/mantle-spec/src/domain/service/StaffRoleHierarchy.ts)
