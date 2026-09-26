---
description: Schema field reference — JSON Schema subset, uiSchema, indexes, translates, lifecycle and TTL rules.
---
# Schema

A Schema declares one collection: the JSON Schema for each entry's `data`, its indexes, its Admin presentation and its lifecycle mode. Schemas are never exposed directly; Views read them and Procedures write them. This page is the field-level contract; the concepts are in [The four atoms](../concepts/four-atoms.md) and [Lifecycle and locales](../concepts/lifecycle-and-locales.md). Envelope rules are in [Manifest envelope and conventions](./manifest.md).

## Fields

| Field | Type | Required | Default | Rules |
|---|---|---|---|---|
| `title` | LocalizedText | yes | — | Admin label. Non-empty string or locale map. |
| `description` | LocalizedText | no | — | Same shape as `title`. |
| `schema` | JSON Schema 2020-12 | yes | — | Must be an object. Walked by the [subset validator](#json-schema-subset). |
| `uiSchema` | object | no | — | Accepts `fields`, `list`, and `nav`. Violations are `SCHEMA_UI_INVALID`. |
| `uniqueIndexes` | `string[][]` | no | `[]` | Ordered tuples of top-level scalar fields. See [Indexes](#indexes). |
| `indexes` | `string[][]` | no | `[]` | Ordered non-unique tuples of data fields and native entry columns. Must not repeat a `uniqueIndexes` tuple. |
| `searchableFields` | `string[]` | no | `[]` | Top-level string fields for Admin and Staff MCP substring search. |
| `localized` | boolean | no | `false` | When `false`, a `locale` property is rejected. Must be a boolean. |
| `translates` | `{ parent, on }` | no | — | Marks a translation child. Requires `localized: true`. |
| `lifecycle` | `publishing` \| `operational` | no | `publishing` | Selects the [state machine](#lifecycle). |
| `ttl` | `{ field, expireAfterSeconds }` | no | — | Logical expiry over one top-level date-time property. See [TTL](#ttl). |
| `scope` | `{ field: "$ctx.user.id" }` | no | — | One required string field with a leftmost index; caller-bound Store operations enforce it. |

### Caller scope

`scope: { ownerId: "$ctx.user.id" }` binds a Schema to the verified caller. Declare `ownerId` as a required, non-null string property and put it first in `indexes` or `uniqueIndexes`. `ctx.store.select` and set deletes AND this predicate with the requested `where`, including subqueries over another scoped Schema. Inserts fill `ownerId` and reject a conflicting value; row updates and deletes verify ownership before hooks. Missing identity fails closed. `runtime.store` is trusted host access without an injected scope. Declarative Views over the Schema must also AND an identity filter at the top level and require `ctx.user`; native SQL Views remain a trusted escape hatch.

### Reserved entry columns

Every entry carries `id`, `status`, `version`, `createdAt`, `updatedAt` and `authorId` as native columns outside `data`. They are valid in View `fields`, `filter`, `orderBy` and `uiSchema.list.columns`, and `indexes` may include them (`uniqueIndexes` may not). `uiSchema.list.primaryField` is the entry title and must be a declared data property. A data property may not reuse one of these names: validate fails closed with `INVALID_MANIFEST_ENVELOPE` at `/spec/schema/properties/<name>`, because SQLite-family and IndexedDB storage would otherwise resolve the name differently and an index declared today could change meaning when a same-named property is added later. Use a domain name instead (`submittedAt`, `orderStatus`, `submittedBy`); the native column is still there and still readable (ADR-0025). `locale` is a reserved data field: only a localized Schema may declare it, and the runtime requires it on writes to a localized Schema. SQL Views project the native column. Do not declare `expectedVersion` under `spec.schema.properties` — that name is the reserved Procedure OCC token; validate fails closed with `INVALID_MANIFEST_ENVELOPE` (ADR-0022). New reserved Procedure input names need an ADR.

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

Two accepted spellings are normalized at the boundary: `nullable: true` becomes a `type` array that includes `"null"`, and `format: url` becomes `format: uri`. `additionalProperties` keeps standard semantics: omitted or `true` preserves extra keys, `false` rejects them, a schema validates them.

### `x-mantle-bind`

Marks a property as server-stamped. The value is a closed enum; anything else is `BIND_VALUE_NOT_IN_ENUM`.

| Value | Stamped as | Typical field |
|---|---|---|
| `ctx.user` | `ctx.user?.id ?? null` | `authorId`, `submittedBy` |
| `ctx.staff` | `ctx.staff?.id ?? null` | `approvedBy`, `grantedBy` |
| `now` | write-time Unix epoch milliseconds | `createdAt`, `submittedAt` |

Stamping semantics: on create the computed value replaces whatever the caller sent. On update the existing stamp is preserved and only computed when the stored row lacks it, so a `now` bind does not become an updated-at field. A `null` stamp is dropped before JSON Schema validation, so `type: string` passes for anonymous callers. Bound properties are removed from Staff MCP `create_*` and `update_*` tool schemas. Stamped values appear in View output as ordinary fields.

### `x-mantle-ref`

An informational foreign-key marker on a string property that holds another collection's entry id (`x-mantle-ref: customers`). The object form `x-mantle-ref: { schema: customers, field: customerNumber }` names the target field instead. `field` must be `id` or a single-field unique index of that Schema, and the Schema must exist; otherwise it is `MANTLE_REF_INVALID`. The string form means `field: id`. Only `id` references compose parent/child navigation. Nothing is enforced: no constraint, cascade or orphan check. Admin uses it for pickers and related rows; `x-mantle-ref: media_assets` marks a media asset id. Declare a single-field index on the ref field when reverse lookups must stay bounded. On a Procedure input property the marker exposes a row action; see [Procedure](./procedure.md#uischema).

### `x-mcp-hint`

A free-form string that tells agents and Admin widgets how to render or produce a value. The grammar accepts any string; these values are conventional.

| Value | Meaning |
|---|---|
| `markdown`, `richtext`, `code` | Text editor and authoring format. |
| `media`, `media-image`, `media-video`, `media-file` | Media-shaped URL or asset reference (`isMediaMcpHint`). |
| `money-minor` | Integer amount in minor currency units. |
| `timestamp-ms` | Unix epoch milliseconds. |
| `idempotency-key` | On a Procedure input: Admin generates and hides one UUID per form; other callers generate one and reuse it on retry. |

Do not use a hint for optimistic concurrency. The reserved Procedure input name `expectedVersion` is the OCC token (observed `entry.version` at read time). First-party Admin binds and hides it where a declared operation target locks it (ADR-0029), never by name alone. Schema `spec.schema.properties` must not declare it (`INVALID_MANIFEST_ENVELOPE`).

### Root `readOnly: true`

`schema.readOnly: true` at the root marks a Procedure-managed collection. Staff MCP emits no `create_*` or `update_*` tool for it, and Admin's generic create, update, status change and delete return `CONFLICT` with the message that the Schema is read-only on generic authoring surfaces. Declared Views and Procedures (builtin or `ref`) keep working.

## `uiSchema`

Closed Admin-only roots: `fields`, `list`, `nav`. Nested keys are closed too. Unknown roots or nested keys are `SCHEMA_UI_INVALID`.

| Key | Rule |
|---|---|
| `fields.<field>.widget` | Only `textarea`. The field must be a top-level property with a string type (`string` or `[string, null]`). |
| `list.filterField` | Operational Schemas only. A declared property with a non-empty string `enum` that is the first field of some `indexes` or `uniqueIndexes` tuple. Admin renders the enum as sidebar links and list tabs. |
| `list.primaryField` | Operational Schemas only. A non-empty top-level scalar property; rendered as the linked leading column. |
| `list.columns` | Operational Schemas only. Top-level properties or native entry columns, no repeats and not repeating `primaryField`; structured values render as compact JSON. |
| `nav.standalone` | Boolean. `true` also emits a main Admin Nav list entry with a **parent autocomplete filter**. It does not unfold: required `x-mantle-ref` children still compose under the parent. Omit or `false` means fold-only (discover via the parent-entry workbench). Rejected on top-level Schemas, `translates` children, and Schemas with no eligible required-ref parent. |
| `nav.parentField` | Allowed only with `standalone: true`. Names a required `x-mantle-ref` field used as the parent filter. One eligible required ref is inferred; more than one requires an explicit `parentField`. Do not rely on property-order heuristics when multiple refs exist. |

```yaml
uiSchema:
  list:
    primaryField: name
    columns: [status]
  nav:
    standalone: true
    parentField: organizationId
```

Every violation is `SCHEMA_UI_INVALID`. Without `primaryField` and `columns`, Admin lists an operational collection with platform metadata only. `nav` is operational Admin navigation only — it does not change runtime, MCP, or publishing validation. Parent autocomplete coexists with `list.filterField` enum tabs as a separate control.

Keep implementation-detail children fold-only. Use `nav.standalone: true` when staff also need a cross-parent list; see the [inventory example](../../examples/cf-primitives-commerce-inventory.md).

## Indexes

`uniqueIndexes` and `indexes` are arrays of ordered field tuples. Shape errors are `INVALID_MANIFEST_ENVELOPE`; semantic errors are `SCHEMA_INDEX_INVALID` unless noted. Each index is an array of field names, even when it has one field; a bare string is rejected.

| Rule | Diagnostic |
|---|---|
| When any index is declared, `metadata.name` matches `/^[A-Za-z][A-Za-z0-9_.-]*$/`. | `SCHEMA_INDEX_INVALID` at `/metadata/name` |
| Each tuple is a non-empty array of strings. | `INVALID_MANIFEST_ENVELOPE` (shape) or `SCHEMA_INDEX_INVALID` (empty) |
| No field repeats within a tuple; field names match the same safe pattern. | `SCHEMA_INDEX_INVALID` |
| `uniqueIndexes` fields are data properties. `indexes` fields may also be the native columns `id`, `status`, `version`, `createdAt`, `updatedAt`, `authorId`, which map to their `_mantle_*` columns. | `SCHEMA_INDEX_INVALID` |
| Data fields are exact top-level keys of `properties`. | `UNIQUE_INDEX_FIELD_UNKNOWN` or `SCHEMA_INDEX_FIELD_UNKNOWN` |
| Fields are indexable scalars: exactly one non-null type, optionally nullable. `string` maps to TEXT, `integer` and `boolean` to INTEGER, `number` to REAL. | `SCHEMA_INDEX_INVALID` |
| No tuple repeats within a list; `indexes` does not repeat a `uniqueIndexes` tuple. | `SCHEMA_INDEX_INVALID` |

On SQLite storage each Schema is a native table and every tuple becomes an
index over its native field columns; queries benefit from a leftmost prefix.

A public View over a `publishing` Schema is compiled with `status = published`
whether or not the manifest writes it ([View surfaces](./view.md#surfaces)), so
its hot path always starts with an equality on `status`. Lead the index with
it, then the ordered field: `indexes: [[status, publishedAt]]`. A bare
`[[publishedAt]]` does not serve that query on production SQLite (no planner
statistics), which sorts every published row in a temporary B-tree instead
(#962). Declare the index the query needs; Mantle does not derive one (ADR-0025).
Unique indexes are also checked before every write; a conflicting row is
`CONFLICT`. After the first deployment, adding, removing, reordering, or changing
any `uniqueIndexes` tuple is destructive and requires rebuilding the instance
and moving required data manually. Automatic deployment rejects the change.

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

## TTL

```yaml
spec:
  ttl: { field: expiresAt, expireAfterSeconds: 0 }
  schema:
    type: object
    properties:
      expiresAt: { type: string, format: date-time, nullable: true }
```

`field` must name one top-level `date-time` string property; `expireAfterSeconds` is finite and nonnegative. An entry expires when its timestamp plus the duration is **at or before** the current instant. Missing or null dates never expire. `SCHEMA_TTL_INVALID` rejects invalid policies.

Legacy values that SQLite cannot parse as dates also remain visible and are not swept; correct those rows before relying on TTL. New writes must pass the Schema's date-time validation.

Expiry is logical first: Entry, declarative View, Admin, MCP and Web reads stop returning the row at the boundary, even before a sweep deletes it. A native SQL View cannot guarantee that filter, so a SQL View whose statement names a TTL Schema's table is rejected (`VIEW_TTL_NATIVE_UNSAFE`); SQL over other tables is unaffected. Mantle tables are named after their Schema, so any read of a TTL table spells its name, and a match inside a string literal or comment rejects too. A View over a TTL Schema cannot use shared caching (`VIEW_CACHE_INVALID`). Bun and D1 use the same SQLite predicate; other storage adapters must supply equivalent read filtering or reject the plan.

TTL is currently rejected on either side of a `translates` relationship (`SCHEMA_TTL_TRANSLATION_UNSUPPORTED`), because a translation child could otherwise remain visible after its parent expires.

Physical cleanup is **explicit**. `runtime.store.sweepExpired({ collection: "events", limit: 50 })` previews one page; add `delete: true` to remove it. Follow `nextCursor` until absent. The limit is 1–100, `scanned` counts expired candidates and `removed` counts successful deletes. A failure throws and the previous cursor is safe to retry. Host code may invoke the sweep on a schedule; Procedure `ctx.store` does not expose it. The sweep does not fire entry lifecycle hooks: expiration already changed logical visibility, and the sweep only reclaims storage (ADR-0028).

The Developer Console shows declared TTL policies. It does not infer sweep history from a policy; host scheduling can record `scanned` and `removed` counts separately.

Adding or shortening TTL on an existing Schema immediately changes **read visibility**, but never starts a deletion job. Preview a sweep and review its counts before requesting `delete: true`. Keep a backup when changing the policy on populated data. Physical unique constraints still see expired rows until cleanup, so a reused unique value may conflict before the sweep.

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
- [`packages/mantle-runtime/src/domain/service/CapabilityCatalog.ts`](../../../packages/mantle-runtime/src/domain/service/CapabilityCatalog.ts)
- [`packages/mantle-runtime/src/usecase/capability/InvokeCapabilityUseCase.ts`](../../../packages/mantle-runtime/src/usecase/capability/InvokeCapabilityUseCase.ts)
- [`packages/mantle-admin/src/mountMantleAdmin.ts`](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
