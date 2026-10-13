# Schema

A Schema declares one table and its typed Store collection. Required keys are title and an object JSON Schema. Optional keys include lifecycle, scope, TTL, indexes, uniqueIndexes, checks, searchableFields, localized, translates and uiSchema. Unknown keys fail validation.

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: orders }
spec:
  title: Orders
  lifecycle: operational
  scope: { owner: auth.uid() }
  uniqueIndexes: [[owner, orderNumber]]
  searchableFields: [orderNumber]
  checks: ["qty > 0"]
  schema:
    type: object
    additionalProperties: false
    required: [owner, orderNumber, qty]
    properties:
      owner: { type: string }
      orderNumber: { type: string }
      qty: { type: integer, minimum: 1 }
```

## Fields and storage

| Field | sqlite | postgres |
| --- | --- | --- |
| string | TEXT | text |
| date-time | integer microseconds | timestamptz |
| date | integer days | date |
| integer | INTEGER | int8 |
| number | REAL | float8 |
| boolean | 0/1 | bool |
| object/array | JSON text | jsonb |
| geo | lat/lng columns, R*Tree | lat/lng columns |

System columns include id, version, created_at, updated_at and author_id; publishing adds status/published_at. Do not declare reserved fields. Manifest native column names in indexes use camelCase (`createdAt`); generated Store/SQL use storage names (`created_at`). Scope is omitted from returned rows.

Declared date/date-time outputs are SQL-formatted strings (`YYYY-MM-DD`, UTC ISO with six fractional digits). Computed timestamps remain native. Inputs and other output scalars follow [the native contract](../guides/native-execution.md). Date conversion through JS Date loses microseconds.

Generated types constrain Store fields and writes; Store does not interpret a JSON Schema on each call. Validate untrusted inputs at the boundary. Selected Admin emits full/partial field checks; drafts may be incomplete, while publishing checks required data. Native constraints remain database-enforced.

## Row rules

Schemas default to operational. Publishing opts into draft/published/archived and generated staff/system transitions. Store cannot assign system columns or scope; generated policy fills them. See [lifecycle and locales](../concepts/lifecycle-and-locales.md).

Scope is one required string bound to `auth.uid()`, leading an index and every unique index. User reads/writes see their own rows; anonymous reads see none. System callers bypass scope. TTL uses `{ field, expireAfterSeconds }` over a date-time field; expired rows become invisible but remain stored until a system sweep. TTL is not allowed on translations.

`localized` and `translates: { parent, on }` declare a translation child. Parent visibility and publication are retained, with matching scope where needed. Locale values stay plain strings.

## Indexes, checks and search

Indexes are ordered composite scalar/native columns. Required operational fields are NOT NULL; publishing drafts may be incomplete. Store sortable types use indexed/non-null columns, with explicit nullable published_at support.

`checks` are restricted SQL expressions over the table's columns, emitted in initial DDL. Native databases enforce them; bare database errors are not automatically mapped to input-validation failures. Searchable fields must be plain string fields. SQLite/D1 emit FTS5 trigram tables and maintenance triggers; PostgreSQL uses ILIKE. Short SQLite terms use LIKE. Store search additionally matches exact id and combines with row policy.

The runtime never creates, alters or checks tables. Initial DDL is for an empty database. Changed fields, checks, indexes and search DDL require [agent-owned native migrations](../concepts/runtime-and-adapters.md#schema-installation-and-migrations), including explicit data migration for destructive/type changes. Mantle drops nothing.

## Admin uiSchema

`fields.<name>.widget/options` select supported controls or extension contributions; `list.primaryField`, columns/cells and enum `filterField` select list presentation; `nav.standalone/parentField` control child navigation; panels select record sidebars. Generation validates these against declared fields/indexes and selected extension declarations. Root `readOnly` disables generic Admin writes, not declared Procedures. `x-mantle-ref` relates a field to another Schema id or single-field unique field.

See [Admin](../guides/admin-ui.md), [extensions](../guides/admin-extensions.md) and [diagnostics](diagnostics.md).
