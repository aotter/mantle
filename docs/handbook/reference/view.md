---
description: View field reference — declarative and SQL forms, filter AST, params, pagination, REST and MCP surfaces, and every diagnostic they raise.
---
# View

A View is a named read-only query over Schemas. It is the only atom that needs no [Trigger](./trigger.md): declaring `surface` mounts it. This page is the field-level contract; the concepts are in [Views](../concepts/views.md) and [The four atoms](../concepts/four-atoms.md). Envelope rules are in [Manifest envelope and conventions](./manifest.md), and every diagnostic code named here is catalogued in [Diagnostics](./diagnostics.md).

## Fields

| Field | Type | Required | Default | Rules |
|---|---|---|---|---|
| `title` | LocalizedText | no | Title-Cased `metadata.name` | Admin report label. Non-empty string or locale map. |
| `uiSchema` | object | no | — | Only on `surface: staff`; only the key `list`. Violations are `VIEW_UI_INVALID`. |
| `from` | string | exactly one of `from` / `sql` | — | Name of a declared Schema (`VIEW_FROM_UNKNOWN_SCHEMA`). The declarative form. |
| `sql` | string | exactly one of `from` / `sql` | — | One SQLite `SELECT`. See [`sql`](#sql). |
| `surface` | `public` \| `staff` | yes | — | Decides where the View mounts. See [Surfaces](#surfaces). |
| `requires` | AuthorizationRequirements | no | — | `auth.all` predicates plus one optional `guard.procedure`. See [Authorization](./authorization.md). |
| `filter` | FilterAst | no | — | `from` form only. See [Filter AST](#filter-ast). |
| `fields` | `string[]` | no | every column | `from` form only. Projection. Not shape-validated by the parser. |
| `orderBy` | `{ field, direction? }[]` | no | `[]` | `from` form only. `direction` defaults to `asc`. |
| `limit` | number | no | 50 at runtime | `from` and `sql`. Not shape-validated by the parser; clamped at request time. |
| `params` | JSON Schema | no | — | `type: object` with `properties`. Reserved: `page`, `show`, `cursor`. |

`from` counts as present when it is a non-empty string; `sql` when it is non-empty after trimming. Declaring both, or neither, is `INVALID_MANIFEST_ENVELOPE` at `/spec` with the message *View.spec requires exactly one of from or sql*. Combining `sql` with `filter`, `fields` or `orderBy` is rejected the same way at `/spec/<key>`.

## Declarative example

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: my-support-requests
spec:
  title: { en: My support requests, "zh-TW": 我的客服請求 }
  surface: public
  from: support-requests
  requires:
    auth:
      all: [ctx.user]
  fields: [id, ticketNumber, subject, requestStatus, submittedAt]
  filter:
    and:
      - eq: { field: submittedBy, value: { "$ctx.user": "id" } }
      - eq: { field: requestStatus, value: { $param: requestStatus } }
  orderBy:
    - { field: submittedAt, direction: desc }
  limit: 100
  params:
    type: object
    required: [requestStatus]
    properties:
      requestStatus: { type: string, enum: [open, waiting, closed] }
```

The Schema this reads must index `submittedBy` as the leftmost field of some tuple, otherwise the identity filter is rejected. See [Schema indexes](./schema.md#indexes).

## SQL example

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: order-lines-by-status
spec:
  title: Order lines by status
  surface: staff
  sql: |
    SELECT o.id AS orderId,
           o.orderNumber AS orderNumber,
           json_extract(line.value, '$.sku') AS sku,
           json_extract(line.value, '$.quantity') AS quantity
    FROM orders AS o
    JOIN json_each(o.lines) AS line
    WHERE o.orderStatus = :orderStatus
    ORDER BY o.orderNumber ASC
  params:
    type: object
    required: [orderStatus]
    properties:
      orderStatus: { type: string, enum: [paid, shipped, cancelled] }
  limit: 200
  uiSchema:
    list:
      columns: [orderNumber, sku, quantity]
      searchFields: [orderNumber, sku]
      filterFields: [sku]
```

## Filter AST

`filter` is a tree. Every node is an object with **exactly one** key: a comparison operator, or `and` / `or`.

| Key | Shape | Rules |
|---|---|---|
| `eq`, `gt`, `gte`, `lt`, `lte` | `{ field, value }` | Only those two keys. `field` is a non-empty string. `value` must be present; `null` is a legal value. |
| `and`, `or` | array of nodes | Non-empty. Nests to any depth. |

Any other key, a node with zero or several keys, an array node, or an empty `and` / `or` is `INVALID_MANIFEST_ENVELOPE` at the node's pointer.

### Value forms

| Form | Written as | Rules |
|---|---|---|
| Literal | `value: published` | Any JSON scalar, including `null`. Compared as written. |
| Param reference | `value: { $param: locale }` | The name must be declared under `params.properties` (`VIEW_FILTER_PARAM_REF_UNKNOWN`, also raised when no `params` is declared at all or the name is empty) and listed in `params.required` (`VIEW_FILTER_PARAM_REF_NOT_REQUIRED`). |
| Caller identity | `value: { "$ctx.user": "id" }` | The sentinel is closed: exactly one key, the literal string `id`, and only under `eq`. Anything else is `VIEW_FILTER_CTX_USER_REF_INVALID`. |

The identity sentinel carries two further graph-level obligations, checked once `from` resolves:

| Rule | Diagnostic |
|---|---|
| The View declares `ctx.user` in `requires.auth.all`. | `VIEW_FILTER_CTX_USER_REF_REQUIRES_AUTH` at `/spec/requires/auth/all` |
| The compared field is the leftmost field of some `uniqueIndexes` or `indexes` tuple on the source Schema. | `VIEW_FILTER_CTX_USER_REF_REQUIRES_INDEX` |

Provider claims and platform identities are deliberately out of reach; `id` is the only bindable identity value.

### Graph-level field checks

For a `from` View, the valid field names are the top-level keys of the Schema's `properties` plus the [reserved entry columns](./schema.md#reserved-entry-columns). Unknown names are rejected per site:

| Location | Diagnostic |
|---|---|
| `filter.<op>.field` | `VIEW_FILTER_FIELD_NOT_IN_SCHEMA` |
| `fields[i]`, `orderBy[i].field` | `VIEW_FIELD_NOT_IN_SCHEMA` |
| `uiSchema.list.<key>[i]` | `VIEW_UI_INVALID` |
| `from` itself | `VIEW_FROM_UNKNOWN_SCHEMA` (no further field checks run) |

None of these run for a `sql` View — its output columns are whatever the `SELECT` produces.

## `sql`

One statement, read-only, compiled and bound by the runtime.

| Rule | Effect |
|---|---|
| The trimmed text matches `/^select\b/i` and contains no `;`. | Otherwise `INVALID_MANIFEST_ENVELOPE` at `/spec/sql`: `View.spec.sql must be one SELECT statement without a semicolon`. |
| Every `:name` occurrence is declared in `params.properties`. | `VIEW_FILTER_PARAM_REF_UNKNOWN` |
| Every `:name` occurrence is listed in `params.required`. | `VIEW_FILTER_PARAM_REF_NOT_REQUIRED` |
| `filter`, `fields` and `orderBy` are absent. | `INVALID_MANIFEST_ENVELOPE` at `/spec/<key>` |
| Tables are Schema names. | Each Schema is exposed as a logical table reconciled at boot. Names containing `-` must be double-quoted: `FROM "post-translations"`. |

Bound params are passed as positional values; caller input is never interpolated into the statement. SQLite JSON functions are available, so `json_each` and `json_extract` can unnest and project array or object members of `data` — the SQL example above does both.

> **Warning**
> `sql` Views are native SQLite. Static validation never executes the statement, so a syntax or column error surfaces only when the View runs. On a storage adapter that does not support the native dialect the View fails at prepare time with `VIEW_DIALECT_UNSUPPORTED`, naming the dialects that adapter does support.

## `params`

`params` declares the caller-supplied query shape and is walked by the [JSON Schema subset](./schema.md#json-schema-subset) validator.

| Rule | Diagnostic |
|---|---|
| A non-array object. | `VIEW_PARAMS_INVALID_SHAPE` at `/spec/params` |
| `type: "object"`. | `VIEW_PARAMS_INVALID_SHAPE` at `/spec/params/type` |
| `properties` is declared and is an object. | `VIEW_PARAMS_INVALID_SHAPE` at `/spec/params/properties` |
| No property named `page`, `show` or `cursor`. | `VIEW_PARAMS_RESERVED_NAME` |

The runtime owns those three names for pagination, which is why they cannot be redeclared. Rename the domain param (`pageSize`, `showArchived`).

## `orderBy`, `fields` and `limit`

`orderBy` is an array of objects accepting only `field` and `direction`. A non-array value, a non-object entry, a missing or empty `field`, or a `direction` other than `asc` / `desc` is `VIEW_ORDERBY_INVALID` at the offending pointer; an unrecognized key inside an entry is `INVALID_MANIFEST_ENVELOPE`.

`fields` and `limit` receive **no shape validation in the parser**. A `fields` value that is not an array of strings, or a `limit` that is not a number, is not reported as a diagnostic — it fails later, at graph validation or at request time. Declare them as documented.

`limit` is a per-View cap, and the runtime clamps around it on every call:

| Input | Result |
|---|---|
| `limit` missing, non-numeric, non-finite or `<= 0` | Cap is 50. |
| `limit` valid | Cap is `min(floor(limit), 500)`. 500 is the hard ceiling for any single round-trip. |
| `?show=` missing or not a positive finite number | Page size is the cap. |
| `?show=` valid | Page size is `min(floor(show), cap)`. |
| `?page=` missing or below 1 | Page 1. |

## `uiSchema.list`

Admin presentation for `surface: staff` Views. Declaring `uiSchema` on a public View is `VIEW_UI_INVALID`, as is any root key other than `list` or any key inside `list` other than the three below.

| Key | Meaning |
|---|---|
| `columns` | Ordered columns for the Admin report table and the default CSV column set. |
| `searchFields` | Output fields the Admin substring search box covers. |
| `filterFields` | Output fields offered as exact-match filters (`?filter.<field>=`). |

Each is an array of non-empty strings with no duplicates within the key. The characters `"`, `\` and NUL are rejected in a field name. The names are **View output field names** — SQL aliases for a `sql` View; for a `from` View they are additionally checked against the Schema's properties plus reserved columns.

Admin applies search and filters before pagination, rejecting a search term or filter value longer than 200 characters and any `filter.<field>` key that is not a declared `filterFields` entry. `GET /admin/api/views/<name>/export` streams the same query as CSV covering every matching row, not only the visible page; its columns come from `uiSchema.list.columns`, falling back to `spec.fields` and then to the union of keys in the returned rows.

## Surfaces

| `surface` | REST | MCP tool | Admin |
|---|---|---|---|
| `public` | `GET /api/views/<name>`, plus a catalog at `GET /api/views` | `query_view_<segment>` on `/mcp` | Also mounted at `GET /admin/api/views/<name>` and `/export` behind the staff gate |
| `staff` | `GET /admin/api/views/<name>` and `/admin/api/views/<name>/export` — not mounted publicly | `query_view_<segment>` on `/mcp/staff` | Report sidebar |

`<segment>` is `metadata.name` lower-cased with `-` replaced by `_`. Two Views that mangle to the same segment collide with `MCP_TOOL_NAME_COLLISION`. Admin also serves the manifest listing `GET /admin/api/views-manifest`. Surface choice is visibility, not authorization: `requires` still gates every call on both transports. See [Surfaces](./surface.md) and [MCP and agents](../concepts/mcp-and-agents.md).

The MCP `inputSchema` is `params.properties` plus `page` and `show` as optional numbers, carrying `params.required` through unchanged; the tool is annotated `readOnlyHint: true`.

## REST contract

Pagination uses the two reserved knobs, `?page=` (1-indexed) and `?show=`. The response envelope is:

```json
{ "ok": true, "data": { "rows": [], "page": 1, "show": 20, "hasMore": true } }
```

`hasMore` is the lazy form — `rows.length === show`. There is no COUNT query and no `LIMIT n+1` probe, so a final page that exactly fills `show` reports `hasMore: true` and the next page comes back empty.

A failure returns `{ ok: false, diagnostic }` with the diagnostic's mapped status. Static `requires.auth` runs before parameter validation, so an unauthorized caller never learns the parameter shape; a `guard` Procedure runs after validation and authorizes the whole query rather than filtering rows.

### Param coercion

Query strings arrive as text. The runtime coerces each declared param by its `type` before validating against `params`; MCP callers send typed JSON and skip this step.

| Declared `type` | Coercion | Rejected when |
|---|---|---|
| `string`, or `type` omitted | Used as-is. | — |
| `integer` | `parseInt(raw, 10)` | The round-trip does not equal the trimmed input, so `"1.5"` and `"1abc"` fail. |
| `number` | `Number(raw)` | The result is not finite. |
| `boolean` | `"true"` / `"false"` | Any other text. |
| `enum` (with any of the above) | Coerced by `type` first, then checked for membership. | The coerced value is not in `enum`. |
| anything else | — | Unsupported on the REST surface. |

A missing required param or a failed coercion is `INPUT_VALIDATION_FAILED` (400). Unknown query keys are ignored.

## Source

- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts)
- [`packages/mantle-spec/src/domain/service/McpToolNaming.ts`](../../../packages/mantle-spec/src/domain/service/McpToolNaming.ts)
- [`packages/mantle-runtime/src/usecase/view/ExecuteViewUseCase.ts`](../../../packages/mantle-runtime/src/usecase/view/ExecuteViewUseCase.ts)
- [`packages/mantle-runtime/src/domain/service/ViewParamCoercer.ts`](../../../packages/mantle-runtime/src/domain/service/ViewParamCoercer.ts)
- [`packages/mantle-runtime/src/domain/service/Pagination.ts`](../../../packages/mantle-runtime/src/domain/service/Pagination.ts)
- [`packages/mantle-runtime/src/domain/service/CallableCapabilityProjector.ts`](../../../packages/mantle-runtime/src/domain/service/CallableCapabilityProjector.ts)
- [`packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts`](../../../packages/mantle-runtime/src/infrastructure/http/createMantleRequestHandler.ts)
- [`packages/mantle-runtime/src/infrastructure/storage/SqliteViewCompiler.ts`](../../../packages/mantle-runtime/src/infrastructure/storage/SqliteViewCompiler.ts)
- [`packages/mantle-runtime/src/infrastructure/storage/SqliteMantleStorageAdapter.ts`](../../../packages/mantle-runtime/src/infrastructure/storage/SqliteMantleStorageAdapter.ts)
- [`packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts`](../../../packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`packages/adapters/cloudflare/src/mount/mountRuntimeEndpoints.ts`](../../../packages/adapters/cloudflare/src/mount/mountRuntimeEndpoints.ts)
- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
