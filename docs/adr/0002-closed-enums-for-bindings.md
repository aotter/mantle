# ADR-0002: Closed enums for identity/time bindings

**Status:** Carried over from POC v0.0.x; refreshed for v0.1.0;
amended 2026-07-15 for verified credentials and delegated scopes.

**Date**: 2026-04-30 (POC); refreshed 2026-05-03

**Deciders**: phsu

**Related**: [ADR-0001](0001-four-atom-manifest-model.md)

---

## Context

Two places in the v0.1 grammar accept identity-or-time-shaped
values:

1. **`x-mantle-bind`** (Schema property extension) — declares that
   a field is server-stamped at write. The SDK fills the value;
   the caller must not supply it.
2. **`requires.auth.all` predicates** (Procedure auth gate) —
   names who must be acting for the call to proceed.

The straightforward design would let authors put expressions in
these slots:

```yaml
authorId: { x-mantle-bind: "${session.user.id}" }
createdAt: { x-mantle-bind: "${request.timestamp}" }
```

```yaml
requires:
  auth:
    all:
      - "${session.user.id == row.authorId}"
      - "${session.user.permissions includes 'write:posts'}"
```

This is the path most CMS-shaped products go down. It immediately
becomes a problem:

- Each new use case stretches the expression language (string
  ops, array containment, date math, lookups). The language
  compounds.
- The expression evaluator becomes a dependency footprint
  (Liquid, Jinja, JEXL, custom DSL). Each is a security surface
  (server-side template injection, sandbox escape, ReDoS).
- Static validation becomes intractable — to know whether a
  manifest is correct, the validator would need to type-check the
  expression language, including its host-environment access
  shape.
- Author tooling (autocomplete, type inference) does not survive
  free-form strings.
- AI authors writing manifests are particularly bad at templating
  languages — model output drifts into a similar-looking but
  subtly invalid syntax (Liquid filter where Jinja was expected,
  etc.).

The same product class has already invented several of these
languages and inherited their footguns (Hasura's permissions
expressions, Strapi's policies, PostgREST's `PRE_REQUEST` hooks).
Every one of them ends up either gradually closing the
expression set or wearing the support cost of an open-grammar
DSL.

## Decision

**Both binding slots use closed enums.** Any value not in the
enum is a parse error.

### `x-mantle-bind` — closed enum (v0.1)

```ts
type MantleBindValue = "ctx.user" | "ctx.staff" | "now";
```

| Value | Resolves to | Typical use |
|---|---|---|
| `ctx.user` | UUID of the signed-in end-user (from session); `null` if anonymous | row ownership: `authorId`, `submittedBy`, `creatorId` |
| `ctx.staff` | UUID of the staff member acting; `null` for end-user-only paths | audit trail: `approvedBy`, `moderatedBy`, `grantedBy` |
| `now` | Server timestamp at write (ISO-8601 with timezone) | `createdAt`, `submittedAt`, `grantedAt` |

### `requires.auth.all` predicate — closed vocabulary (v0.1)

```yaml
requires:
  auth:
    all:
      - ctx.user                            # caller is any signed-in end-user
      - ctx.staff: [editor, owner]          # caller is staff in one of these roles
```

The vocabulary is exactly:

- `ctx.user` — caller is signed in as an end-user
- `ctx.staff: [<role>, ...]` — caller is signed in as staff in one of these roles
- `ctx.auth` — caller supplied an adapter-verified credential
- `ctx.auth.scope: <scope>` — credential carries the exact scope

### Adding a new entry is an explicit grammar-revise round

New `x-mantle-bind` values or `ctx.*` predicates do not get added ad hoc:

1. A documented use case showing the existing closed set cannot
   express the requirement.
2. A design pass on what the new value's runtime semantics are
   (where does it come from? when is it null? what happens at
   the storage layer?).
3. A spec doc revision.
4. Code that updates the validator to accept the new value.

This treats the closed set as load-bearing infrastructure, not
configuration.

## Consequences

### Pros

- Validator can statically know all legal values for a binding
  slot; static validation emits `V_BIND_VALUE_NOT_IN_ENUM` with
  the full candidate list as a one-step fix for the AI author.
- No expression-language dependency, no template injection
  surface, no ReDoS, no sandbox escape.
- Meaning of each value is documented in one place (the v0.1
  grammar reference); authors do not have to read evaluator
  source to know what `ctx.staff: [editor]` returns when there
  is no staff session.
- AI author hit rate goes way up: a closed enum of 3 values
  (`x-mantle-bind`) is unambiguous; the model outputs the right
  value or none at all.

### Costs

- Real use cases that don't fit get pushed to "use a custom
  Procedure handler that does the binding inside TS." For an
  expression like "stamp the user's team_id," the author writes
  TS (cheap; the team_id lookup is in handler scope anyway).
  For an expression like "stamp the value of an upstream API
  call," the author writes TS (correct outcome — that work
  belongs in handler logic, not in declarative metadata).
- Adding a new enum entry is heavyweight (grammar revise) even
  when the use case is obvious. The friction is the point;
  resist optimizing it away.
- The `ctx.user` vs `ctx.staff` split forces authors to
  understand the user-vs-staff session distinction up front.
  Acceptable cost; the distinction is fundamental to the
  CMS's auth model.

### Risks

- **Pressure to add entries case-by-case.** First use case
  shows up, "it's just one more value, what's the harm?" The
  harm is that the enum stops being load-bearing — every
  subsequent addition is precedent for the next. Mitigation:
  document the grammar-revise process (ADR-0001 § Future
  grammar discipline) and apply it.
- **Underpowered for genuine multi-tenant deployments.**
  `ctx.tenant` was considered + dropped in v0.1 because the
  current product is single-tenant per deployment. If
  multi-tenant SaaS is pursued later, `ctx.tenant` reintroduces
  via grammar-revise.
- **`now` semantics on D1 vs PG diverge.** D1 has no
  column-level `DEFAULT now()`; SDK stamps. PG (v0.2+ via
  Hyperdrive — see `mantle-cloudflare` README) has native defaults. Authors writing
  `x-mantle-bind: now` on a future PG-targeted deployment may
  expect column-level enforcement; v0.1.0 ships SDK-stamped
  only.

## Alternatives considered

**(a) Open expression language with sandboxing**.
Rejected: dependency footprint, security surface, AI author hit
rate, static-validation tractability all bad. Hasura / Strapi /
PostgREST precedent is not encouraging.

**(b) Open expression language with a custom DSL written by
us**.
Rejected: same problems as (a), plus we own the DSL. The
maintenance load on a custom evaluator is permanent.

**(c) Open enum with documentation but no validator
enforcement** (i.e. unknown values silently work if the
runtime happens to handle them).
Rejected: every undocumented usage drifts into precedent.
Validator-enforced closure is the only durable form.

**(d) `x-mantle-bind: ctx.user.id`, `ctx.user.email`,
`ctx.user.locale`** (open path expressions on a structured
ctx object).
Rejected: turns `ctx.user` into an object with fields that have
their own evolution. Each field path becomes a separate spec
question (when is `ctx.user.email` null? what about
`ctx.user.preferences.timezone`?). Cleanest decision is the
opaque identity ID + a separate handler-side lookup if you need
attributes.

## How to apply

- New manifest using a value not in the enum: parse error,
  exact diagnostic shape with `candidates` populated. AI authors
  fix in one turn.
- New use case wanting an entry not in the enum: document the concrete
  semantics and add validation, runtime behavior, and docs together.
- Lookups (e.g. "stamp the team_id"): handler-side TS, not
  binding metadata. The Procedure handler has the lookup
  context anyway.
- Reviewing PRs: any change to the validator's enum check is
  itself a grammar-revise; flag.

## Implementation status

Closed-enum types live in `packages/mantle-spec/` and the
parser rejects unknown values with the structured diagnostic
shape. Verify in code review that new manifest grammar
additions do not quietly widen these enums; widening is a
grammar-revise, not a code-cleanup.

## Amendment — 2026-07-15: verified credentials and delegated scopes

Epic #467 supplied the required grammar-revise evidence: the existing
`ctx.user` and `ctx.staff` predicates cannot represent service API keys or
delegated OAuth/personal-token scopes without coupling Core to a credential
store. The closed predicate vocabulary is therefore extended by exactly two
entries:

```yaml
requires:
  auth:
    all:
      - ctx.auth
      - { "ctx.auth.scope": "orders:read" }
```

- `ctx.auth` requires any credential that an adapter has already verified and
  normalized into `HandlerContext.auth`.
- `{ "ctx.auth.scope": "<opaque site-owned scope>" }` requires that one exact
  scope. Multiple scopes are expressed by repeating the predicate under the
  existing `all` group.

The full v0.1 vocabulary is now `ctx.user`, `ctx.staff`, `ctx.auth`, and
`ctx.auth.scope`. The latter two do not add a credential-kind expression,
`any` group, policy array, scope catalog, or entitlement lookup. API keys may
have no `ctx.user`; OAuth and personal tokens may supply one. Missing identity
or credential yields `UNAUTHENTICATED` (`401`), while a verified credential
missing a required role/scope yields `AUTH_DENIED` (`403`).

Current membership, payment, ownership, or transaction state is intentionally
not a static predicate. A target may name one ordinary Procedure through
`requires.guard.procedure`; that Procedure performs the site-owned dynamic
check after target input validation and before target execution. This keeps
the predicate set closed and preserves the four-atom model.
