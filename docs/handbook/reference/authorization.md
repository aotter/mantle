---
description: The requires block of Views and Procedures, its closed predicate vocabulary, guard rules, evaluation order and failure codes, and the Caller each predicate reads.
---
# Authorization requirements

```yaml
requires:
  auth:
    all:                       # every predicate must hold
      - ctx.user
      - { ctx.staff: [owner, editor] }
      - { ctx.auth.scope: "exports:read" }
  guard:
    procedure: require-active-plan
```

Both keys are optional; without `requires` anyone may call, including
anonymous callers. Views and Procedures take the same block.

## Predicates

The vocabulary is closed (`AUTH_PREDICATE_NOT_IN_ENUM`). Each reads the
request's [Caller](../concepts/authorization.md):

| Predicate | Holds when |
|---|---|
| `ctx.user` | `caller.kind === "user"` |
| `ctx.auth` | `caller.kind === "user"` (any verified credential) |
| `{ ctx.staff: [owner \| editor \| contributor, …] }` | `caller.role` is one of the listed roles |
| `{ ctx.auth.scope: "<scope>" }` | `caller.scopes` includes it; repeat for several |

The system and anonymous callers satisfy none. Roles are not ranked here: list
every role that may call.

## Guard

`guard.procedure` names one Procedure that:

- is a `ref` handler (`GUARD_PROCEDURE_NOT_REF`), declared
  (`GUARD_PROCEDURE_UNKNOWN`), not the Procedure itself
  (`GUARD_SELF_REFERENCE`), and has no guard of its own
  (`GUARD_CHAIN_NOT_ALLOWED`);
- receives the target's validated input, so its own `input` schema must accept
  the target's fields (leave `additionalProperties` open);
- gets the same caller, a read-only `ctx.store`, and no `ctx.invoke`;
- allows by returning and rejects by throwing. Throw a `DiagnosticError` to
  choose the code; any other throw is a 500. Either way the target never runs.

A guard runs on every call and is never cached.

## Order

1. The service's `CallerResolver` (a failed credential is 401 here).
2. `requires.auth.all`, in order: the first failure answers.
3. `input` validation.
4. The guard.
5. The handler, then `output` validation.

## Failures

| Situation | HTTP | Code |
|---|---|---|
| a presented credential failed | 401 | `UNAUTHENTICATED` (with a `WWW-Authenticate` challenge on MCP mounts) |
| an anonymous caller fails a predicate | 401 | `UNAUTHENTICATED` |
| a signed-in caller fails a predicate | 403 | `AUTH_DENIED` |
| a guard rejects | the guard's code, e.g. 402 | `ENTITLEMENT_REQUIRED` |
| an OAuth token lacks a scope a tool requires (MCP) | 403 | `insufficient_scope` challenge |

The path of a predicate failure points at it:
`manifest:Procedure/<name>#/requires/auth/all/<index>`.

## Rows

`requires` decides whether a caller may run the View or Procedure. Which rows
it reaches comes from Schema `scope` and from `auth.uid()` in the SQL; see
[Authorization](../concepts/authorization.md#rows-scope-and-authuid).
