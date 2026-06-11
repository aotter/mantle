# ADR-0012: Views as the public REST surface

**Status:** Accepted for v0.1.0. New ADR.

**Date:** 2026-05-05

## Context

mantle ships two read-side surfaces and one write-side surface:

- **Templates** (rendered HTML / Markdown / `llms.txt`) — composed by the consumer's `TemplateRegistry` from runtime APIs. The starter blog uses these for `/{locale}/posts/{slug}` etc.
- **MCP tools** — agent-facing CRUD over the entry chokepoint. Every Schema gets `create_draft_<n>` / `update_draft_<n>` per-collection authoring tools plus generic tools (`list_entries`, `get_entry`, `request_publish`, `unpublish_entry`, `archive_entry`).
- **HTTP Triggers** — write-side endpoints declared by the consumer (`Trigger.source.kind: http`, methods `POST | PUT | PATCH | DELETE` only). Per ADR-0001 grammar, **`GET` is intentionally absent** because read endpoints belong to Views, not Procedures.

What was missing: a stable, consumer-facing **public REST read surface**. The starter blog had no JSON API at all. The CMS needed an answer to "I'm a downstream service that wants `posts` filtered by locale — how do I read?" without forcing every consumer to hand-write a route handler that re-implements filtering.

This ADR answers that question: **every parsed View auto-exposes `GET /api/views/<view-name>`**, and Schemas do not get a public REST surface at all. Public reads always go through a named query.

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

### 3. Views auto-expose; opt-out is "don't write a View"

We considered adding `View.spec.expose: { rest: false }`. Rejected — the shape `View` already has IS "public read API". Authors who want a private named query write a TypeScript helper and call `runtime` directly from their template.

### 4. Pagination knobs are reserved query-string names

Public callers pass `?page=<1-indexed>&show=<page-size>`. Internally the runtime emits `LIMIT show OFFSET (page-1)*show`.

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

The `$param` discriminator key was chosen to match the JSON Schema `$ref` convention. Future sentinels (`$now`, `$ctx.user`) follow the same `$<name>` shape; this ADR adds none of them.

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

### 7. Param coercion happens at the adapter boundary

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

- **MCP tools for Views.** MCP is for agents doing ops; readers don't need a separate MCP tool when they have a stable REST endpoint. Reconsider in v0.2 if downstream agent tooling demands it.
- **`Trigger.target.view`** (lifecycle/projection triggers fired by Views). Tracked separately as a v0.2 grammar move.
- **`spec.output.kind`** (declaring scalar / tree / tabular result shape per View). Lands with join + group-by support in v0.1.x.
- **Optional param-ref drop semantics in the parser.** Runtime is already implemented; parser promotes when v0.1.x lands.
- **DRAFT filter operators** (`contains` / `in` / `like` / `not`). v0.1 keeps comparison operators closed to `eq` / `gt` / `gte` / `lt` / `lte`; field-to-field comparisons remain out of scope.
- **Auth on the public View REST surface.** v0.1.0 Views are public-read by definition. Member-gated reads land with the member system in v0.2.

## Consequences

**Authors gain:**
- Public REST surface for free — declare a View, get an endpoint.
- Single mental model for "how do consumers read?": always Views.
- Cheap pagination + dynamic filters without hand-writing handlers.

**Authors lose:**
- A View per filter combination (until DRAFT operators land). `posts-by-locale` plus `posts-by-tag` plus `posts-by-locale-and-tag` would be three Views in v0.1.0.
- No way to write a "private" named query — moves to a TS helper.

**Runtime gains:**
- One auto-mount path covers every public-read use case for v0.1.0.
- Forward-compat for join / group-by / aggregation: envelope generalises by Views declaring `output.kind` later.

**Reviewers / future contributors should:**
- Reject any PR adding `Schema.spec.expose.rest` or a similar Schema-level public-read flag.
- Reject any PR introducing a second public read surface (e.g. `/api/<collection>` shortcut).
- Reject any PR that lets `filter` reference state outside the declared `params` (e.g. `{ $env: ... }`, `{ $cookie: ... }`) without a matching ADR amendment.
