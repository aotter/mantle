---
description: The requires grammar — closed auth predicates, guard Procedures, staff roles, HandlerContext, evaluation order and the 401/402/403 mapping.
---
# Authorization

`requires` is the whole authorization grammar. It appears on [Procedure](./procedure.md) and [View](./view.md) and nowhere else; Schemas and Triggers carry no `requires`. This page is the field-level contract and the runtime behaviour it produces. The narrative version is [Authorization](../concepts/authorization.md), and a worked deployment is [Guarded API](../examples/guarded-api.md). Diagnostic codes named here are catalogued in [Diagnostics](./diagnostics.md).

## `requires`

```yaml
spec:
  requires:
    auth:
      all:
        - ctx.auth
        - ctx.user
        - { "ctx.auth.scope": "orders:read" }
    guard:
      procedure: require-active-subscription
```

| Key | Type | Required | Rules |
|---|---|---|---|
| `requires` | mapping | no | Omitted means the target is anonymous. Only `auth` and `guard` are accepted. |
| `requires.auth` | mapping | no | Only `all` is accepted. `any`, `none` and negation do not exist in v0.1. |
| `requires.auth.all` | array | yes when `auth` is present | Non-empty array of predicates. Every entry must pass. |
| `requires.guard` | mapping | no | Exactly one key, `procedure`, holding a non-empty Procedure name. |

`auth` and `guard` are independent: a target may declare a guard with no static predicates, or predicates with no guard. Shape violations are `INVALID_MANIFEST_ENVELOPE` with a JSON Pointer to the offending key.

## Predicates

The vocabulary is closed. A bare string form is either `ctx.user` or `ctx.auth`; an object form carries exactly one key.

| Predicate | Written as | Passes when |
|---|---|---|
| Signed-in user | `ctx.user` | `ctx.user` is not `null`. A service API key with no user subject fails this. |
| Verified credential | `ctx.auth` | `ctx.auth` is present, that is, the adapter verified some credential. There is no credential-kind predicate. |
| Scope | `{ "ctx.auth.scope": "orders:read" }` | `ctx.auth.scopes` contains that exact opaque string. Repeat the predicate under `all` to require several scopes. |
| Staff role | `{ "ctx.staff": [owner, editor] }` | `ctx.staff` is present and `ctx.staff.role` is one of the listed roles. This is exact membership, not role-or-above. |

| Validation rule | Diagnostic |
|---|---|
| Predicate is one of the four forms above. | `INVALID_MANIFEST_ENVELOPE` at `/spec/requires/auth/all/<i>` |
| Object form has exactly one key, `ctx.staff` or `ctx.auth.scope`. | `INVALID_MANIFEST_ENVELOPE` |
| `ctx.auth.scope` value is a non-empty string. | `INVALID_MANIFEST_ENVELOPE` |
| `ctx.staff` value is a non-empty array of strings. | `INVALID_MANIFEST_ENVELOPE` |
| Every `ctx.staff` role is `owner`, `editor` or `contributor`. | `AUTH_PREDICATE_NOT_IN_ENUM` |

Scope strings are opaque to Core. Mantle neither issues credentials nor defines a scope catalog; the deployment owns both.

## Denial

Predicates are evaluated in declaration order and the first failure denies the call.

| Caller state | Code | HTTP |
|---|---|---|
| No `ctx.auth`, no `ctx.user` and no `ctx.staff`. | `UNAUTHENTICATED` | `401` |
| Authenticated in any of those three ways but a predicate is unsatisfied. | `AUTH_DENIED` | `403` |

Both diagnostics carry the failing predicate's position: the `path` is `<target path>#/requires/auth/all/<i>`, where `<target path>` is `manifest:Procedure/<name>` or `manifest:View/<name>` unless the caller supplied its own prefix. `expected` describes the predicate in prose; the offending value is not echoed. An auth-gated View invoked with no caller context at all is denied `UNAUTHENTICATED` at `<target path>#/requires/auth` before any predicate runs.

## Guards

`requires.guard.procedure` names one ordinary Procedure. It is not a fifth atom, and it is not a policy language: it is a handler that is allowed to say no.

- The guard receives the target's **already-validated** input (Procedure) or params (View) and the **same** `HandlerContext`.
- It runs through the identical pipeline: its own `requires.auth.all`, its own `input` schema, its handler, its `output` schema.
- It runs on every call and is never cached.
- It fails closed. Any non-`ok` guard result is returned to the caller unchanged and the target handler is never invoked.

| Rule | Diagnostic | Where checked |
|---|---|---|
| The named Procedure is declared. | `GUARD_PROCEDURE_UNKNOWN` | validate and runtime |
| A Procedure does not guard itself. | `GUARD_SELF_REFERENCE` | validate and runtime |
| The guard uses `handler.kind: ref`, not `builtin`. | `GUARD_PROCEDURE_BUILTIN` | validate and runtime |
| The guard does not itself declare `requires.guard`. Guard chains are one level deep, never more. | `GUARD_CHAIN_NOT_ALLOWED` | validate and runtime |

All four report at `<target path>#/requires/guard/procedure`; diagnostics raised inside the guard itself are prefixed `<target path>#/requires/guard/<guard name>`. The runtime repeats every check the validator already made, so a boot-bypassing embedding still fails closed.

A guard denies by throwing a `DiagnosticError` carrying a runtime diagnostic. `ENTITLEMENT_REQUIRED` (`402`) is the conventional code for "verified caller, current business state says no" — an expired subscription, a revoked entitlement, an unpaid invoice. Any other runtime code works the same way and maps through the [status table](./diagnostics.md#runtime).

## Staff roles

| Role | Rank | Capabilities |
|---|---|---|
| `owner` | 3 | Full control. Staff list, role changes, invitations, site settings, developer console. |
| `editor` | 2 | Publish, unpublish, delete and manage all entries; media uploads and assets; member list. |
| `contributor` | 1 | Create and edit drafts. Cannot create or edit operational records, and cannot edit an entry that is no longer `draft`. |

`users` is the base identity layer; `staff` is a privilege overlay with one row per privileged user, so `ctx.staff.id` always equals `ctx.user.id`. A signed-in user with no staff row is an ordinary site member with no Admin access and no `/mcp/staff` access.

Rank ordering exists for "this role or above" gates — Admin's own route table uses it, so an `owner` passes an `editor`-gated Admin route. The manifest predicate does not: `{ "ctx.staff": [editor] }` admits editors only. List every role you mean.

The adapter re-reads the caller's current role from the database on every protected request. A role is never taken from a token, a consent snapshot or a cached catalog, so a demotion takes effect on the next call.

## `HandlerContext`

Handlers, guards and predicate evaluation all see the same normalized value.

```ts
interface HandlerContext<Env = unknown> {
  readonly user: { readonly id: string } | null;
  readonly staff: { readonly id: string; readonly role: StaffRole } | null;
  readonly auth?: {
    readonly credential: "session" | "oauth" | "api-key" | "personal-token";
    readonly credentialId: string | null;
    readonly clientId: string | null;
    readonly scopes: readonly string[];
  };
  readonly env: Env;
  readonly waitUntil?: (p: Promise<unknown>) => void;
  readonly event?: HandlerLifecycleEvent;
}
```

| Field | Notes |
|---|---|
| `user` | `{ id }` of the site-local user row, or `null`. The id is the deployment's own user record, never a platform or upstream-provider subject. |
| `staff` | Privilege overlay, or `null`. |
| `auth` | Present only after a credential verified. `credentialId` is an opaque record id or token identifier; `clientId` names the OAuth client when there is one; `scopes` is the granted set. |
| `env` | Adapter bindings. |
| `waitUntil` | Platform fire-and-forget bridge, when the adapter has one. |
| `event` | Populated only when the Procedure runs as a lifecycle hook target. See [Trigger](./trigger.md). |

Raw credentials never enter this object: no cookie value, no API key, no bearer token, no refresh token. Resolution precedence on the Cloudflare adapter is the deployment's own credential resolver, then configured OAuth bearer verification, then the cookie session; a recognized-but-invalid credential is rejected outright and never falls back to a valid cookie. See [Authentication](../cloudflare/authentication.md).

## Order of evaluation

The order is fixed and identical on REST, MCP and in-process invocation.

| Step | Procedure | View |
|---|---|---|
| 1 | Adapter verifies and normalizes the credential. | Same. |
| 2 | `requires.auth.all` against the context. | `requires.auth.all` against the context. |
| 3 | `input` validated and coerced. | `params` validated and coerced. |
| 4 | Guard invoked with the validated value and the same context. | Guard invoked with the validated params and the same context. |
| 5 | Handler dispatched. | Query executed. |
| 6 | `output` validated. | Rows paginated and returned. |

Static predicates run before input validation on purpose: an unauthorized caller learns that it is unauthorized, not what the input schema looks like.

## Views

Two consequences follow from that order.

- **Static auth precedes param validation.** A protected View never reports a parameter error to a caller that failed its predicates.
- **The guard authorizes the query, not the rows.** It sees the validated params and returns pass or fail for the whole call. It cannot rewrite the filter, drop columns or remove rows.

Row-level scoping is a separate mechanism, described in [Views](../concepts/views.md): the closed `{ "$ctx.user": "id" }` filter sentinel. The caller never supplies that value, so the same View is safe on REST and on public MCP. Core rejects the sentinel unless the View declares `ctx.user` in `requires.auth.all` and the compared field is the leftmost field of a declared Schema index; a missing identity is `401`, never a dropped filter or a full-table read. The field-level rules are in [View](./view.md#value-forms).

## Example

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: require-active-subscription
spec:
  title: Require an active subscription
  input: { type: object }
  output: { type: object }
  handler: { kind: ref, ref: requireActiveSubscription }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Procedure
metadata:
  name: download-report
spec:
  title: Download a report
  requires:
    auth:
      all:
        - ctx.user
        - ctx.auth
        - { "ctx.auth.scope": "reports:read" }
    guard: { procedure: require-active-subscription }
  input:
    type: object
    required: [reportId]
    properties:
      reportId: { type: string }
  output:
    type: object
    required: [url]
    properties:
      url: { type: string, format: uri }
  handler: { kind: ref, ref: downloadReport }
---
apiVersion: cms.mantle.aotter.net/v1
kind: Trigger
metadata:
  name: download-report-http
spec:
  source: { kind: http, method: POST, path: /api/reports/download }
  target: { procedure: download-report }
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: my-reports
spec:
  title: My reports
  surface: public
  from: reports
  requires:
    auth:
      all: [ctx.user]
    guard: { procedure: require-active-subscription }
  filter:
    and:
      - { eq: { field: status, value: published } }
      - { eq: { field: ownerId, value: { "$ctx.user": id } } }
  fields: [title, publishedAt]
  orderBy: [{ field: publishedAt, direction: desc }]
  limit: 50
```

The guard handler denies with a structured diagnostic rather than a thrown string, so the boundary emits `402` instead of the `INTERNAL_ERROR` envelope:

```ts
import { DiagnosticError, runtimeDiagnostic } from "@aotter/mantle/spec";
import type { HandlerContext } from "@aotter/mantle/runtime";

export const requireActiveSubscription = async (
  _input: unknown,
  ctx: HandlerContext<{ DB: D1Database }>,
) => {
  const active = await ctx.env.DB
    .prepare("SELECT 1 FROM site_memberships WHERE user_id = ? AND state = 'active' LIMIT 1")
    .bind(ctx.user!.id)
    .first();
  if (active) return {};
  throw new DiagnosticError(
    runtimeDiagnostic({
      code: "ENTITLEMENT_REQUIRED",
      severity: "error",
      path: `site:membership/${ctx.user!.id}`,
      message: "An active subscription is required.",
    }),
  );
};
```

`site_memberships` is deployment-owned. Core creates no credential, entitlement or billing tables and reads no payment-provider state.

## OpenAPI projection

`mantle emit-openapi` reflects authorization into the emitted OpenAPI 3.1 document. Only schemes the deployment actually accepts are configured, and only those become alternatives.

| Manifest | OpenAPI |
|---|---|
| Any `requires.auth.all` predicate | `security` alternatives drawn from the configured `sessionCookie`, `oauthBearer`, `apiKey` and `personalToken` schemes, plus `x-mantle-auth-predicates`, a `401` response and a `403` response. |
| Repeated `{ "ctx.auth.scope": … }` | OAuth scopes on the `oauthBearer` alternative, plus `x-mantle-required-scopes`. |
| `requires.guard.procedure` | `x-mantle-guard-procedure` and a `402` response. |
| No `requires` | No `security` requirement and no auth responses. |

Cookie sessions are emitted as cookies, never relabelled as bearer tokens. A protected target with no configured security scheme is an emission error, not a silently unprotected operation. MCP is out of scope for the emitter; required scopes and guard behaviour reach agents through the standard Tool description, and every `tools/call` re-runs the predicates and the guard. Discovery is never the enforcement boundary — see [MCP and agents](../concepts/mcp-and-agents.md).

## Source

- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/StaffRoleHierarchy.ts`](../../../packages/mantle-spec/src/domain/service/StaffRoleHierarchy.ts)
- [`packages/mantle-spec/src/usecase/EmitOpenapiUseCase.ts`](../../../packages/mantle-spec/src/usecase/EmitOpenapiUseCase.ts)
- [`packages/mantle-runtime/src/domain/model/HandlerContext.ts`](../../../packages/mantle-runtime/src/domain/model/HandlerContext.ts)
- [`packages/mantle-runtime/src/domain/service/AuthPredicateEvaluator.ts`](../../../packages/mantle-runtime/src/domain/service/AuthPredicateEvaluator.ts)
- [`packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts`](../../../packages/mantle-runtime/src/usecase/procedure/InvokeProcedureUseCase.ts)
- [`packages/mantle-runtime/src/usecase/view/ExecuteViewUseCase.ts`](../../../packages/mantle-runtime/src/usecase/view/ExecuteViewUseCase.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`packages/adapters/cloudflare/src/mount/mountMcp.ts`](../../../packages/adapters/cloudflare/src/mount/mountMcp.ts)
- [`docs/api-mcp-authorization.md`](../../../docs/api-mcp-authorization.md)
- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
