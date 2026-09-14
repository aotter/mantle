---
description: Schema field reference — JSON Schema subset, extension keywords, uiSchema, indexes, searchable fields, translates and lifecycle rules.
---
# Schema

A Schema declares one collection: the JSON Schema for each entry's `data`, its indexes, its Admin presentation and its lifecycle mode. Schemas are never exposed directly; Views read them and Procedures write them. This page is the field-level contract; the concepts are in [The four atoms](../concepts/four-atoms.md) and [Lifecycle and locales](../concepts/lifecycle-and-locales.md). Envelope rules are in [Manifest envelope and conventions](./manifest.md).

## Fields

| Field | Type | Required | Default | Rules |
|---|---|---|---|---|
| `title` | LocalizedText | yes | — | Admin label. Non-empty string or locale map. |
| `description` | LocalizedText | no | — | Same shape as `title`. |
| `schema` | JSON Schema 2020-12 | yes | — | Must be an object. Walked by the [subset validator](#json-schema-subset). |
| `uiSchema` | object | no | — | Accepts `fields` and `list`. Violations are `SCHEMA_UI_INVALID`. |
| `uniqueIndexes` | `string[][]` | no | `[]` | Ordered tuples of top-level scalar fields. See [Indexes](#indexes). |
| `indexes` | `string[][]` | no | `[]` | Ordered non-unique tuples. Must not repeat a `uniqueIndexes` tuple. |
| `searchableFields` | `string[]` | no | `[]` | Top-level string fields for Admin and Staff MCP substring search. |
| `localized` | boolean | no | `false` | When `false`, a `locale` property is rejected. Must be a boolean. |
| `translates` | `{ parent, on }` | no | — | Marks a translation child. Requires `localized: true`. |
| `lifecycle` | `publishing` \| `operational` | no | `publishing` | Selects the [state machine](#lifecycle). |

### Reserved entry columns

Every entry carries `id`, `status`, `version`, `createdAt`, `updatedAt` and `authorId` as native columns outside `data`. They cannot be indexed (`SCHEMA_INDEX_INVALID`) but are valid in View `fields`, `filter`, `orderBy` and `uiSchema.list`. `locale` is a reserved data field: only a localized Schema may declare it, and the runtime requires it on writes to a localized Schema. Do not name data properties after the native columns; SQL Views project the native column.

## Example

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: support-requests
spec:
  title: { en: Support requests, "zh-TW": 客服請求 }
  description: Requests submitted from the public contact form.
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [ticketNumber, subject, body, requestStatus]
    properties:
      ticketNumber: { type: string, pattern: "^SR-[0-9]{6}$" }
      subject: { type: string, minLength: 1, maxLength: 200 }
      body: { type: string, x-mcp-hint: markdown }
      requestStatus: { type: string, enum: [open, waiting, closed], default: open }
      customerId: { type: string, x-mantle-ref: customers }
      attachmentId: { type: string, x-mantle-ref: media_assets, x-mcp-hint: media-file }
      submittedBy: { type: string, x-mantle-bind: ctx.user }
      submittedAt: { type: integer, x-mcp-hint: timestamp-ms, x-mantle-bind: now }
  uiSchema:
    fields:
      body: { widget: textarea }
    list:
      filterField: requestStatus
      primaryField: ticketNumber
      columns: [subject, requestStatus, submittedAt]
  uniqueIndexes: [[ticketNumber]]
  indexes: [[requestStatus, submittedAt], [customerId]]
  searchableFields: [ticketNumber, subject]
```

## `translates`

A translation child holds the locale-specific fields of a non-localized parent, joined on a shared field.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: product-translations
spec:
  title: Product translations
  localized: true
  translates: { parent: products, on: sku }
  schema:
    type: object
    required: [sku, name]
    properties:
      sku: { type: string }
      locale: { type: string }
      name: { type: string, minLength: 1 }
      description: { type: string, x-mcp-hint: markdown }
  uniqueIndexes: [[sku, locale]]
```

`locale` is declared but not listed in `required`; the write-time gate enforces presence.

| Phase | Rule | Diagnostic |
|---|---|---|
| parse | `parent` and `on` are non-empty strings; no other keys. | `INVALID_MANIFEST_ENVELOPE` |
| parse | `localized: true` is set. | `TRANSLATES_REQUIRES_LOCALIZED` |
| parse | At least one property besides `locale` and the join field. | `TRANSLATES_REQUIRES_CONTENT_FIELD` |
| parse | `on` is declared in this Schema's `properties`. | `TRANSLATES_FIELD_NOT_IN_CHILD` |
| validate and boot | `parent` names a declared Schema. | `TRANSLATES_PARENT_UNKNOWN` |
| validate and boot | The parent is not `localized: true`. | `TRANSLATES_PARENT_IS_LOCALIZED` |
| validate and boot | `on` is declared in the parent's `properties`. | `TRANSLATES_FIELD_NOT_IN_PARENT` |
| boot | A localized Schema needs at least one site locale. | `SCHEMA_LOCALIZED_REQUIRES_SITE_LOCALES` |

## JSON Schema subset

Authors write JSON Schema; the runtime validates with zod via `z.fromJSONSchema`. The parser accepts a bounded subset so every manifest converts.

| Recognized keywords |
|---|
| `$defs`, `$ref`, `oneOf`, `const`, `type`, `properties`, `required`, `items`, `enum`, `format`, `pattern`, `minLength`, `maxLength`, `minimum`, `maximum`, `minItems`, `maxItems`, `nullable`, `readOnly`, `default`, `additionalProperties`, `title`, `description`, and any `x-` keyword |

| Rejected keywords (`JSON_SCHEMA_UNSUPPORTED`) |
|---|
| `anyOf`, `allOf`, `not`, `if`, `then`, `else`, `$anchor`, `$dynamicAnchor`, `$dynamicRef`, `definitions`, `patternProperties`, `prefixItems`, `contains`, `dependentSchemas`, `propertyNames`, `unevaluatedProperties` |

Other standard keywords are not rejected by the parser, but only the recognized set is part of the documented contract.

| Rule | Diagnostic |
|---|---|
| Nesting deeper than 100 levels, or more than 10,000 schema nodes. | `JSON_SCHEMA_LIMIT_EXCEEDED` |
| `$ref` must begin `#/$defs/` and resolve to an object in the same document. | `JSON_SCHEMA_REF_INVALID` |
| `pattern` must compile as a JavaScript regular expression. | `INVALID_PATTERN` |
| Every `required` entry of `spec.schema` must be declared under `properties`. | `REQUIRED_FIELD_UNKNOWN` |
| `properties` and `$defs` must be objects; `oneOf` a non-empty array; `additionalProperties` a boolean or a schema. | `INVALID_MANIFEST_ENVELOPE` |

Two compatibility normalizations run at the boundary: `nullable: true` becomes a `type` array that includes `"null"`, and `format: url` becomes `format: uri`. `additionalProperties` keeps standard semantics: omitted or `true` preserves extra keys, `false` rejects them, a schema validates them.

### `x-mantle-bind`

Marks a property as server-stamped. The value is a closed enum; anything else is `BIND_VALUE_NOT_IN_ENUM`.

| Value | Stamped as | Typical field |
|---|---|---|
| `ctx.user` | `ctx.user?.id ?? null` | `authorId`, `submittedBy` |
| `ctx.staff` | `ctx.staff?.id ?? null` | `approvedBy`, `grantedBy` |
| `now` | write-time Unix epoch milliseconds | `createdAt`, `submittedAt` |

Stamping semantics: on create the computed value replaces whatever the caller sent. On update the existing stamp is preserved and only computed when the stored row lacks it, so a `now` bind does not become an updated-at field. A `null` stamp is dropped before JSON Schema validation, so `type: string` passes for anonymous callers. Bound properties are removed from Staff MCP `create_*` and `update_*` tool schemas. Stamped values appear in View output as ordinary fields.

### `x-mantle-ref`

An informational foreign-key marker on a string property that holds another collection's entry id (`x-mantle-ref: customers`). Nothing is enforced: no constraint, cascade or orphan check. Admin uses it for pickers and related rows; `x-mantle-ref: media_assets` marks a media asset id. Declare a single-field index on the ref field when reverse lookups must stay bounded. On a Procedure input property the marker exposes a row action; see [Procedure](./procedure.md#uischema).

### `x-mcp-hint`

A free-form string that tells agents and Admin widgets how to render or produce a value. The grammar accepts any string; these values are conventional.

| Value | Meaning |
|---|---|
| `markdown`, `richtext`, `code` | Text editor and authoring format. |
| `media`, `media-image`, `media-video`, `media-file` | Media-shaped URL or asset reference (`isMediaMcpHint`). |
| `money-minor` | Integer amount in minor currency units. |
| `timestamp-ms` | Unix epoch milliseconds. |
| `idempotency-key` | On a Procedure input: Admin generates and hides one UUID per form; other callers generate one and reuse it on retry. |

### Root `readOnly: true`

`schema.readOnly: true` at the root marks a Procedure-managed collection. Staff MCP emits no `create_*` or `update_*` tool for it, and Admin's generic create, update, status change and delete return `CONFLICT` with the message that the Schema is read-only on generic authoring surfaces. List and detail access and declared Procedures (builtin or `ref`) keep working.

## `uiSchema`

| Key | Rule |
|---|---|
| `fields.<field>.widget` | Only `textarea`. The field must be a top-level property with a string type (`string` or `[string, null]`). |
| `list.filterField` | Operational Schemas only. A declared property with a non-empty string `enum` that is the first field of some `indexes` or `uniqueIndexes` tuple. Admin renders the enum as sidebar links and list tabs. |
| `list.primaryField` | Operational Schemas only. A non-empty top-level scalar property; rendered as the linked leading column. |
| `list.columns` | Operational Schemas only. Top-level scalar properties, no repeats and not repeating `primaryField`. |

Every violation is `SCHEMA_UI_INVALID`. Without `primaryField` and `columns`, Admin lists an operational collection with platform metadata only. None of these settings changes runtime or MCP validation.

## Indexes

`uniqueIndexes` and `indexes` are arrays of ordered field tuples. Shape errors are `INVALID_MANIFEST_ENVELOPE`; semantic errors are `SCHEMA_INDEX_INVALID` unless noted. Bare strings and the retired `indexedFields` key are rejected; each index is an array of field names, even when it has one field.

| Rule | Diagnostic |
|---|---|
| When any index is declared, `metadata.name` matches `/^[A-Za-z][A-Za-z0-9_.-]*$/`. | `SCHEMA_INDEX_INVALID` at `/metadata/name` |
| Each tuple is a non-empty array of strings. | `INVALID_MANIFEST_ENVELOPE` (shape) or `SCHEMA_INDEX_INVALID` (empty) |
| No field repeats within a tuple; field names match the same safe pattern. | `SCHEMA_INDEX_INVALID` |
| Fields are not reserved entry columns. | `SCHEMA_INDEX_INVALID` |
| Fields are exact top-level keys of `properties`. | `UNIQUE_INDEX_FIELD_UNKNOWN` or `SCHEMA_INDEX_FIELD_UNKNOWN` |
| Fields are indexable scalars: exactly one non-null type, optionally nullable. `string` maps to TEXT, `integer` and `boolean` to INTEGER, `number` to REAL. | `SCHEMA_INDEX_INVALID` |
| No tuple repeats within a list; `indexes` does not repeat a `uniqueIndexes` tuple. | `SCHEMA_INDEX_INVALID` |

On SQLite storage each tuple becomes a partial index over generated columns of `entries.data`; queries benefit from a leftmost prefix. Unique indexes are also checked before every write; a conflicting row is `CONFLICT`.

## `searchableFields`

An array of unique top-level string properties (`string` or `[string, null]`). Non-array or non-string entries are `INVALID_MANIFEST_ENVELOPE`; duplicates and non-string properties are `SCHEMA_SEARCH_INVALID`; unknown fields are `SCHEMA_SEARCH_FIELD_UNKNOWN`. The entry `id` is always searched. Substring search does not use `indexes`.

## Lifecycle

`publishing` is the default state machine.

| From | To |
|---|---|
| `draft` | `published`, `archived` |
| `published` | `archived`, `draft` |
| `archived` | `draft` |

`operational` has no transitions. Entries are created with `status: published`, edited in place, and any publish, unpublish or archive request returns `CONFLICT`. Admin hides lifecycle controls; Staff MCP emits `create_record_<segment>` and `update_record_<segment>` instead of the draft tools. A builtin `archive` Procedure cannot target an operational Schema.

Deleting a `published` entry of a publishing Schema is `CONFLICT` (unpublish first). Operational entries can be deleted in any status.

### Write-time locale gate

Every authoring path (Admin, Staff MCP, builtin Procedures) runs the same guard after stamping, per request, reading the current site locales.

| Condition | Result |
|---|---|
| Non-localized Schema and `data.locale` is present. | `INPUT_VALIDATION_FAILED` |
| Localized Schema and `data.locale` missing or empty. | `INPUT_VALIDATION_FAILED` (skipped for partial draft saves; publish re-checks). |
| Localized Schema and `data.locale` not in the site locales. | `INPUT_VALIDATION_FAILED` with the enabled locales as candidates. |
| Site locales list is empty. | Locale membership is not checked. |

Site locales are configured in [Site config](./site-config.md).

## Source

- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/CrossSchemaChecker.ts`](../../../packages/mantle-spec/src/domain/service/CrossSchemaChecker.ts)
- [`packages/mantle-spec/src/domain/service/SchemaIndexChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaIndexChecker.ts)
- [`packages/mantle-spec/src/domain/service/SchemaSearchChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaSearchChecker.ts)
- [`packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts)
- [`packages/mantle-spec/src/domain/service/LifecycleStateMachine.ts`](../../../packages/mantle-spec/src/domain/service/LifecycleStateMachine.ts)
- [`packages/mantle-spec/src/domain/service/JsonSchemaToZod.ts`](../../../packages/mantle-spec/src/domain/service/JsonSchemaToZod.ts)
- [`packages/mantle-runtime/src/domain/service/BuiltinProjector.ts`](../../../packages/mantle-runtime/src/domain/service/BuiltinProjector.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryWriteGuard.ts)
- [`packages/mantle-runtime/src/domain/service/io/EntryDeleteGuard.ts`](../../../packages/mantle-runtime/src/domain/service/io/EntryDeleteGuard.ts)
- [`packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts`](../../../packages/mantle-runtime/src/infrastructure/mcp/McpToolCatalog.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
