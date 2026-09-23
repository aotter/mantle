---
description: Views are the only public read surface — surfaces, declarative versus SQL form, params, identity filters, pagination, the MCP mirror and index planning.
---
# Reads: Views, REST and MCP

Views declare reusable queries and their transport visibility. This page explains why, how a View is shaped, and what it costs at query time. Field-level rules are in the [View reference](../reference/view.md).

## One read surface, not two

A View is a named, read-only query over Schemas. Public and staff Views mount on supported transports with no [Trigger](./procedures-and-triggers.md) involved. Schemas are never publicly readable on their own.

Exposing collections directly — a `Schema.spec.expose.rest` flag, or a `GET /api/<collection>` shortcut — was considered and rejected. A Schema declares the storage shape. Its entries carry drafts, internal status, server-stamped fields and per-row data the author never intended to publish; `contact-messages` is the canonical example, where a direct collection route would be a privacy bug by default. A View already has the right semantics — a named query with explicit fields, filter, ordering and limit — so auto-exposing it only ratifies what the manifest already says.

Use `surface: internal` for a named query callable only by host code. It remains in the plan and generated bindings, but is absent from REST, MCP, WebMCP and Admin reports. Its `requires` and guards still run. See [Typed queries](../guides/typed-queries.md).

## Surfaces

`spec.surface` is required and closed to three values.

| `surface` | REST | MCP | Extra |
|---|---|---|---|
| `public` | `GET /api/views/<name>` | `query_view_<segment>` on `/mcp` | Listed by `GET /api/views` |
| `staff` | `GET /admin/api/views/<name>` | `query_view_<segment>` on `/mcp/staff` | `GET /admin/api/views/<name>/export`, Admin report sidebar |
| `internal` | None | None | Host calls through `executeView` or generated `views` bindings |

The adapter filters the View set before building each MCP dispatcher, so a guessed public tool call cannot reach a staff View. Surface decides transport visibility; `spec.requires` decides whether the verified caller may execute the View, on REST and MCP alike. See [Authorization](./authorization.md).

## Declarative `from` versus one `sql` SELECT

A View declares exactly one of `from` or `sql`; declaring both or neither is rejected.

- **`from`** names a Schema and pairs with `fields`, `filter`, `orderBy` and `limit`. The filter is a closed AST: `eq`, `gt`, `gte`, `lt`, `lte`, combined with `and` and `or`. Field-to-field comparison and arithmetic are not expressible.
- **`sql`** is a single `SELECT` with no semicolon. Every Schema is available as a logical table named after its `metadata.name`, with data properties projected as columns; quote names containing hyphens (`"post-translations"`). Combining `sql` with `fields`, `filter` or `orderBy` is rejected.

Use `from` for portable single-Schema queries, typed result rows and eligible public caching. Use `sql` for joins, aggregation or JSON expansion that the declarative form cannot express. SQL Views require a SQLite-capable adapter (`VIEW_DIALECT_UNSUPPORTED` otherwise), and generated SQL row types are `unknown`. The CLI validates SQL against an empty database of declared Schema tables; programmatic validation needs the `sqlViewSandbox` port for the same check. Exercise data-dependent behavior on your adapter or with `mantle-harness indexes`.

## Params

`spec.params` is a JSON Schema with `type: object` and a `properties` map. The reserved names `page`, `show` and `cursor` are rejected (`VIEW_PARAMS_RESERVED_NAME`); the rest of the query-string namespace is yours.

In the declarative form, a filter value may be the sentinel `{ $param: <name> }`. The name must resolve to a declared param and must appear in `params.required`. In a SQL View, params are named bindings written `:name`; they are bound, never interpolated, and every `:name` must be a required declared param.

## Identity-bound Views

A View can filter to the calling user's own rows with the closed sentinel `{ "$ctx.user": "id" }`. Three rules apply, each with its own diagnostic:

1. It appears only under `eq`, as a single-key object whose value is the literal string `"id"` — otherwise `VIEW_FILTER_CTX_USER_REF_INVALID`.
2. The View must require a signed-in user: `ctx.user` in `requires.auth.all` — otherwise `VIEW_FILTER_CTX_USER_REF_REQUIRES_AUTH`.
3. The compared field must be the leftmost field of a declared index on the source Schema — otherwise `VIEW_FILTER_CTX_USER_REF_REQUIRES_INDEX`.

This is a filter, not a row-level policy engine. `requires` authorizes the whole query; it does not inject per-row visibility predicates. Membership, payment and entitlement checks belong in a guard Procedure. See [Procurement approvals](../../examples/builtin-procurement.md).

## Shared response cache

Caller-independent published data may declare `cache: { sharedMaxAge: <seconds> }`, with an integer from 1 through 86400. The Cloudflare adapter applies it only to anonymous REST responses when the Worker also has a stable `cacheScope`. Staff, guarded, identity-bound, SQL and operational-schema Views cannot opt in; MCP and WebMCP calls remain private. Publishing writes purge the deployment-scoped tag after the canonical write.

## Pagination and the envelope

REST callers pass `?page=<1-indexed>&show=<page size>`; MCP callers pass the same two names as tool arguments.

| Knob | Behavior |
|---|---|
| `View.spec.limit` | The server-enforced cap. Missing or invalid becomes 50; otherwise the floor of the value, capped at 500. |
| `show` | Missing, non-numeric or non-positive becomes the cap; otherwise the smaller of the request and the cap. |
| `page` | Missing, non-numeric or below 1 becomes 1. |

```json
{ "ok": true, "data": { "rows": [], "page": 1, "show": 20, "hasMore": false } }
```

`hasMore` is lazy: it is true exactly when `rows.length === show`. There is no `COUNT(*)` and no `LIMIT n+1` probe, so a full final page reports `hasMore: true` and the next request returns an empty list. That is one false positive on the boundary in exchange for no extra round-trip on every request.

Query strings arrive as strings, so the transport boundary coerces each declared param: `string` is identity, `integer` uses `parseInt` and rejects float-like input, `number` uses `Number()`, `boolean` accepts only `"true"` and `"false"`, and an `enum` is matched against its array. A missing required param or a coercion failure is `INPUT_VALIDATION_FAILED` (HTTP 400). Unknown query-string keys are ignored.

## Staff report lists

A staff View may opt into Admin's standard list chrome without changing its REST or MCP contract:

```yaml
spec:
  uiSchema:
    list:
      columns: [orderNumber, customerName, orderStatus]
      searchFields: [orderNumber, customerName, customerEmail]
      filterFields: [orderStatus]
```

These names are output field names — SQL aliases for a `sql` View, Schema properties or reserved columns for a `from` View. Admin applies search and exact filters *before* pagination and carries them into `GET /admin/api/views/<name>/export`, whose CSV contains every matching row, not only the visible page. `uiSchema` is staff-only; a public View that declares it is `VIEW_UI_INVALID`.

## The MCP mirror

Every public or staff View is also a tool on its matching MCP surface; internal Views are never tools. The name is the View name lowercased with hyphens replaced by underscores, prefixed `query_view_`. Its input schema is `params.properties` plus `page` and `show`, and it is annotated `readOnlyHint: true`. One executor and one response shape serve REST and MCP, so an agent and a downstream service read exactly the same rows. See [MCP and agents](./mcp-and-agents.md).

## Performance: declare the index the query needs

On SQLite and D1, every Schema is a native table and each top-level property is
a native column. Declared `indexes` and `uniqueIndexes` become B-tree indexes
over those columns; Core-compiled projections, filters and ordering reference
the same columns directly.

Declare the **smallest ordered index justified by the measured path**, and respect SQLite's leftmost-prefix rule. Equality columns go first, the ordered column last. A public declarative View over a publishing Schema always carries `status = published`, so its index leads with `status`: `[status, locale, publishedAt]` serves `WHERE status = ? AND locale = ?`, `… AND publishedAt > ?`, and `… ORDER BY publishedAt`. It does not serve `WHERE publishedAt > ?` alone, and `[publishedAt]` alone does not serve the published list — without planner statistics SQLite prefers the status equality and sorts in a temporary B-tree. If a second hot path needs a different leading field, that is a second index — not a reason to enumerate every permutation, since each index costs storage and slows every write.

```sh
pnpm exec mantle-harness indexes --require-public --format text
```

The harness applies the real migrations and generated DDL, seeds skewed rows,
compiles and executes the actual View SQL, and records `EXPLAIN QUERY PLAN`. A
healthy indexed plan contains `SEARCH <schema-table> USING INDEX`; an indexed
filter-and-order path should not contain `USE TEMP B-TREE FOR ORDER BY`.
Findings are advisory unless you opt a View into the gate. Never change
user-visible filter or ordering semantics just to make the gate pass.

## Example: a public localized list

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: published-announcements
spec:
  title: Published announcements
  surface: public
  from: announcements
  cache: { sharedMaxAge: 3600 }
  params:
    type: object
    additionalProperties: false
    required: [locale]
    properties:
      locale: { type: string }
  fields: [id, slug, locale, title, summary, publishedAt]
  filter:
    and:
      - eq: { field: status, value: published }
      - eq: { field: locale, value: { $param: locale } }
      - gte: { field: publishedAt, value: 0 }
  orderBy:
    - { field: publishedAt, direction: desc }
  limit: 50
```

The source Schema declares `indexes: [[status, locale, publishedAt]]`; the `status` predicate is present whether or not the View writes it. The `gte publishedAt 0` clause is what keeps the ordered column inside the indexed range rather than forcing a sort. Omitting `locale` returns 400.

## Example: a staff SQL report

A `sql` View earns its keep when the answer is not one row per entry. Here an operational `requests` Schema stores a `tags` array, and the report needs one row per tag so staff can search and filter by tag:

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: requests-by-tag
spec:
  title: Requests by tag
  surface: staff
  sql: |
    SELECT r._mantle_id AS requestId,
           r.subject AS subject,
           r.requestStatus AS requestStatus,
           tag.value AS tag,
           r._mantle_created_at AS createdAt
    FROM requests AS r
    JOIN json_each(r.tags) AS tag
    WHERE r.requestStatus = :requestStatus
    ORDER BY r._mantle_created_at DESC
  params:
    type: object
    required: [requestStatus]
    properties:
      requestStatus: { type: string, enum: [open, waiting, closed] }
  uiSchema:
    list:
      columns: [subject, tag, requestStatus]
      searchFields: [subject, tag]
      filterFields: [tag]
  limit: 200
```

`tags` is an array property, so `json_each` unnests it and one request appears once per tag. The runtime wraps the whole statement as a subquery before applying pagination, which is why Admin's search and filters attach to the SQL output aliases — `tag` is a real filterable column even though no Schema property is named `tag`. See [Commerce inventory](../../examples/cf-primitives-commerce-inventory.md) for the same technique over order lines.

## Source

- [`docs/adr/0012-views-as-public-rest.md`](../../../docs/adr/0012-views-as-public-rest.md)
- [`docs/schema-indexes.md`](../../../docs/schema-indexes.md)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-runtime/src/domain/service/Pagination.ts`](../../../packages/mantle-runtime/src/domain/service/Pagination.ts)
- [`packages/mantle-runtime/src/domain/service/ViewParamCoercer.ts`](../../../packages/mantle-runtime/src/domain/service/ViewParamCoercer.ts)
- [`packages/mantle-runtime/src/infrastructure/storage/SqliteViewCompiler.ts`](../../../packages/mantle-runtime/src/infrastructure/storage/SqliteViewCompiler.ts)
- [`packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts`](../../../packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts)
- [`packages/adapters/cloudflare/src/mount/mountRuntimeEndpoints.ts`](../../../packages/adapters/cloudflare/src/mount/mountRuntimeEndpoints.ts)
- [`docs/skills/develop/SKILL.md`](../../skills/develop/SKILL.md)
