---
description: The Caller, the one CallerResolver at the service entry, requires predicates, guards, Schema scope and auth.uid(), and how staff roles fit.
---
# Authorization

Mantle never owns your users. The service resolves who is calling once per
request, and Mantle enforces the manifests against that answer.

## The Caller

```ts
type Caller =
  | { kind: "anonymous" }
  | { kind: "user"; subject: string; issuer?: string; role: "owner" | "editor" | "contributor" | null;
      scopes: readonly string[]; credential: "session" | "oauth" | "api-key" | "personal-token";
      credentialId: string | null; clientId: string | null }
  | { kind: "system"; reason: string };
```

- `subject` is the application's subject key: opaque, stable, unique across
  every issuer, never an email. `auth.uid()`, a scope field and `author_id`
  store it. A resolver over several identity providers namespaces it
  (`chatgpt:<sub>`, `account:<id>`).
- `role` is a staff role or `null`. Admin's vocabulary is `owner`, `editor`,
  `contributor`; a resolver maps its own roles onto it, or leaves `null` and
  uses scopes and guards.
- The `system` caller comes only from host code (`systemCaller(reason)`):
  schedules, maintenance, a verified webhook. No request can produce one.

## One boundary: `CallerResolver` and `withCaller`

```ts
type CallerResolver = (request: Request) =>
  Promise<{ caller: Caller } | { invalid: true; challenge?: string; status?: 401 | 403 }>;
```

The generated `src/service.ts` wraps every surface in
`withCaller(resolver, surface)`:

- A credential that was presented but fails is answered 401 before any
  surface runs. It is never treated as anonymous; only "no credential" is.
- A cookie session may not mutate across origins: a non-GET request with a
  session needs a same-origin `Origin` or `Sec-Fetch-Site`, or it is 403.
- Identity `mantle` resolves Better Auth sessions and OAuth bearer tokens;
  identity `custom` is your `src/identity.ts`; identity `none` passes
  `{ kind: "anonymous" }`. See [Authentication](../cloudflare/authentication.md).

## `requires`

Views and Procedures take the same block:

```yaml
requires:
  auth:
    all:
      - ctx.user
      - { ctx.staff: [owner, editor] }
      - { ctx.auth.scope: "exports:read" }
  guard: { procedure: require-active-plan }
```

| Predicate | Holds when |
|---|---|
| `ctx.user` | the caller is a `user` |
| `ctx.auth` | the caller is a `user` (any verified credential) |
| `{ ctx.staff: [roles] }` | the caller's `role` is one of them |
| `{ ctx.auth.scope: "<scope>" }` | the caller's `scopes` include it; repeat for several |

Every predicate in `all` must hold. A system or anonymous caller satisfies
none. A failure is 401 `UNAUTHENTICATED` for an anonymous caller and 403
`AUTH_DENIED` for a signed-in one. The optional guard is a `ref` Procedure
that runs next and may reject with any code, for example
`ENTITLEMENT_REQUIRED` (402).

`requires` is checked on every path: REST, MCP, Admin operations,
`ctx.invoke` and `runtime.invokeProcedure`. Listing a tool is not permission
to call it.

## Rows: scope and `auth.uid()`

`requires` decides whether a caller may run a View or Procedure. Which
**rows** it reaches is decided in the data:

**Scope** hides rows from everyone but their owner:

```yaml
kind: Schema
metadata: { name: orders }
spec:
  scope: { owner: auth.uid() }
  indexes: [[owner]]
  schema:
    required: [owner, …]
```

- The scope field is a required string, the first column of an index, and the
  first column of every `uniqueIndexes` entry.
- Every read and write of a user caller is limited to rows whose `owner` is its
  subject key; an anonymous caller reaches none. Store fills `owner` on insert,
  and no write may set it, so a row can never move to another owner.
- Staff are user callers too: scope hides other users' rows from them as
  well. Use scope only for rows that no one but the owner may ever see.
- `runtime.store` and the system caller are not scoped.

**`auth.uid()` in SQL** covers the rest. When staff must see every row but a
member sees only their own, store the writer and filter on it:

```sql
INSERT INTO requisitions (requestedBy, item) VALUES (auth.uid(), input.item);
SELECT … FROM requisitions WHERE requestedBy = auth.uid();
```

The writer comes from the caller, never from an input. See
[Procurement approvals](../../examples/procurement.md).

## Admin

Admin's gate admits any staff role, and each Admin route names the least role
it needs. Admin reads and writes through `runtime.store.as(caller)`, so scope
and `requires` apply to staff exactly as to anyone. See
[Customize Admin](../guides/admin-ui.md).

## Further reading

- [Authorization reference](../reference/authorization.md)
- [Guarded API access](../../examples/guarded-api.md)
