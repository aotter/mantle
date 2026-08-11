# ADR-0012: Views as named REST and MCP read surfaces

**Status:** Accepted for v0.1.0. Amended to match the shipped public/staff
surface and authorization contract.

**Date:** 2026-05-05; amended 2026-08-03

## Context

mantle ships two read-side surfaces and one write-side surface:

- **Templates** (rendered HTML / Markdown / `llms.txt`) — composed by the consumer's `TemplateRegistry` from runtime APIs. The starter blog uses these for `/{locale}/posts/{slug}` etc.
- **MCP tools** — the staff surface exposes entry authoring and lifecycle
  tools; both public and staff surfaces expose `query_view_<name>` for Views
  assigned to that surface.
- **HTTP Triggers** — write-side endpoints declared by the consumer (`Trigger.source.kind: http`, methods `POST | PUT | PATCH | DELETE` only). Per ADR-0001 grammar, **`GET` is intentionally absent** because read endpoints belong to Views, not Procedures.

What was missing: a stable, consumer-facing **public REST read surface**. The starter blog had no JSON API at all. The CMS needed an answer to "I'm a downstream service that wants `posts` filtered by locale — how do I read?" without forcing every consumer to hand-write a route handler that re-implements filtering.

This ADR answers that question: **every parsed View is a named read surface**.
Views default to public and auto-expose `GET /api/views/<view-name>` plus a
matching public MCP tool. `surface: staff` moves both transports to the guarded
staff surfaces. Schemas do not get a public REST surface at all.

(Schemas remain available on the **admin** REST surface — `/admin/api/*` — which lands with the admin UI commit and is auth-gated to staff. That's a separate cut and out of scope here.)

## Decision

### 1. Public reads route through Views, never Schemas

Adding `Schema.spec.expose.rest` and letting collections leak directly to public REST was the alternative considered. We rejected it because:

- `Schema` declares the **storage shape**; entries carry `draft` / internal status, server-stamped fields, and per-row data the author may not have intended for the public. `contact-messages` is the canonical example — direct `GET /api/contact-messages` would be a privacy bug by default.
- `View` already has the right semantics: a named query with explicit `filter` / `fields` / `orderBy` / `limit`. Auto-exposing it as REST ratifies what the manifest already declares.
- One way to do public reads is simpler than two. The Mantle thesis ("agents write config; runtime carries complexity") gets stronger when the contract surface stays narrow.

### 2. URL shape: `/api/views/<view-name>`

No version prefix. `apiVersion: cms.mantle.aotter.net/v1` is the manifest-grammar version, locked under v0.1 grammar discipline; the public REST URL doesn't need to repeat it.

`<view-name>` is `View.metadata.name` verbatim. Authors are free to pick kebab-case (`recent-posts`) or any URL-safe identifier; the runtime mounts the route as-is.

### 3. Views auto-expose on one declared surface

`View.spec.surface` uses the closed `public | staff` vocabulary and defaults to
`public`:

- public Views mount at `GET /api/views/<name>` and appear as
  `query_view_<name>` on `/mcp`;
- staff Views mount at `GET /admin/api/views/<name>` behind the live staff-role
  gate and appear only on `/mcp/staff`.

The adapter filters the View set before constructing each MCP dispatcher, so a
guessed public tool call cannot reach a staff View. `View.spec.requires` then
applies the same static predicates and optional guard Procedure on REST and MCP
calls. Surface selects transport visibility; authorization decides whether the
verified caller may execute the View.

We still reject a second `expose.rest` switch. A View is externally queryable
on exactly one surface; internal-only helpers remain TypeScript code.

### 4. Pagination knobs are reserved query-string names

REST callers pass `?page=<1-indexed>&show=<page-size>`. MCP callers pass the
same reserved names as tool arguments. Internally the runtime emits
`LIMIT show OFFSET (page-1)*show`.

`page` / `show` / `cursor` are reserved names. The parser rejects any `View.spec.params.properties.<name>` colliding with these (`VIEW_PARAMS_RESERVED_NAME`). The author owns the rest of the query-string namespace.

The alternative ("let `filter` express arithmetic so the author writes their own page→offset math") was rejected as a grammar-discipline violation: v0.1 filter is a closed AST (`eq` / `gt` / `gte` / `lt` / `lte` plus boolean `and` / `or`) and adding arithmetic would drag in operator precedence, type coercion, and a closed-enum-vs-expression debate that distracts from shipping.

`View.spec.limit` is the **server-enforced cap** on `show`; if the caller passes `?show=10000` and the View declares `limit: 50`, the runtime trims to 50.

### 5. Filter comparison `value` accepts a `{ $param: <name> }` sentinel

Static Views are useful (`recent-posts`); param-driven Views are essential (`posts-by-locale?locale=zh-TW`). Until this ADR, filter values were literals, which forced one View per parameter combination — unworkable for `tag` / `locale` / `author` queries.

The grammar gains:

```yaml
spec:
  params:
    type: object                            # required, must be type: object
    properties:
      locale: { type: string }              # scalar leaf types
    required: [locale]                      # v0.1.0 enforces required-only
  filter:
    eq: { field: locale, value: { $param: locale } }
```

The `$param` discriminator key was chosen to match the JSON Schema `$ref` convention. The later closed `{ "$ctx.user": "id" }` sentinel follows the same `$<name>` shape; `$now` remains unimplemented.

Boot validator gates:
- `View.spec.params` MUST be `type: object` with `properties` declared (`VIEW_PARAMS_INVALID_SHAPE`).
- Reserved names rejected (`VIEW_PARAMS_RESERVED_NAME`).
- Every `{ $param: <name> }` ref MUST resolve to a declared param (`VIEW_FILTER_PARAM_REF_UNKNOWN`).
- Every `{ $param: <name> }` ref MUST appear in `params.required` (`VIEW_FILTER_PARAM_REF_NOT_REQUIRED`).

The required-only rule is a v0.1.0 simplification. v0.1.x will promote optional-with-skip semantics (filter clauses referencing missing optional params evaluate to TRUE / no-op) — the runtime compiler already implements drop semantics for forward compatibility, but the parser rejects it today so authors get a clear "not yet" diagnostic.

### 6. Response envelope is `{ rows, page, show, hasMore }`

```json
{
  "ok": true,
  "data": {
    "rows": [...],
    "page": 1,
    "show": 20,
    "hasMore": true
  }
}
```

`rows` is intentionally a generic name (matches OLAP family conventions in `aotter-mantle`). v0.1.0 Views are list-of-projected-entries, but join + group-by results land in v0.1.x and may use a different envelope (`data.value` for scalars, `data.tree` for hierarchies). The choice of `rows` over `entries` keeps the door open without forcing a v0.1.0 manifest declaration of output shape.

`hasMore = (rows.length === effectiveShow)` — the lazy semantics. We do **not** issue a separate `COUNT(*)` query, and we do not pull `LIMIT n+1` to probe. If the server returns exactly `show` rows, the caller may or may not have more; if fewer, we know definitively. The trade is one false-positive on the boundary case (caller asks for next page, gets empty) in exchange for no extra round-trip per request.

### 7. Param coercion happens at the transport boundary

Query strings arrive as strings; `View.spec.params` declares the JSON Schema type. The Cloudflare adapter (`coerceViewParams` in `mountServerEndpoints.ts`) coerces per-property:

| `params.<name>.type` | Coercion |
|---|---|
| `string` | identity |
| `integer` | `parseInt` (rejects non-canonical / float-like input) |
| `number` | `Number()` |
| `boolean` | `"true"` / `"false"` only |
| `enum` | string matched against the enum array |

Required params not present → `400 INPUT_VALIDATION_FAILED`. Coercion failure → `400 INPUT_VALIDATION_FAILED`. Unknown query-string keys are silently ignored (lenient v0.1.0; strict mode is a candidate v0.1.x flag).

## Out of scope (deferred)

- **`Trigger.target.view`** (lifecycle/projection triggers fired by Views). Tracked separately as a v0.2 grammar move.
- **`spec.output.kind`** (declaring scalar / tree / tabular result shape per View). Lands with join + group-by support in v0.1.x.
- **Optional param-ref drop semantics in the parser.** Runtime is already implemented; parser promotes when v0.1.x lands.
- **DRAFT filter operators** (`contains` / `in` / `like` / `not`). v0.1 keeps comparison operators closed to `eq` / `gt` / `gte` / `lt` / `lte`; field-to-field comparisons remain out of scope.
- **Row-level policy rewriting.** `requires` authorizes the whole View; it does
  not inject per-row visibility predicates. Consumer-specific membership,
  payment, or entitlement checks belong in the optional guard Procedure.

## Consequences

**Authors gain:**
- REST and MCP read surfaces for free — declare a View and choose public or
  staff visibility once.
- Single mental model for "how do consumers and agents read?": always Views.
- Cheap pagination + dynamic filters without hand-writing handlers.

**Authors lose:**
- A View per filter combination (until DRAFT operators land). `posts-by-locale` plus `posts-by-tag` plus `posts-by-locale-and-tag` would be three Views in v0.1.0.
- No internal-only View surface; choose public/staff or keep the query in a TS
  helper.

**Runtime gains:**
- One executor and response shape cover public/staff REST and MCP reads.
- Forward-compat for join / group-by / aggregation: envelope generalises by Views declaring `output.kind` later.

**Reviewers / future contributors should:**
- Reject any PR adding `Schema.spec.expose.rest` or a similar Schema-level public-read flag.
- Reject any PR introducing a second public read surface (e.g. `/api/<collection>` shortcut).
- Require REST and MCP mounts to filter by the same `View.spec.surface` value,
  and keep authorization in the shared `ExecuteViewUseCase` path.
- Reject any PR that lets `filter` reference state outside the declared `params` (e.g. `{ $env: ... }`, `{ $cookie: ... }`) without a matching ADR amendment.
