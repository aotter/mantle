---
description: Envelope fields, unknown-key policy, multi-document YAML, LocalizedText, naming rules and reserved names shared by every Manifest kind.
---
# Manifest envelope and conventions

This page covers the rules that apply to every Manifest document before kind-specific validation runs. Read it once; the four atom pages ([Schema](./schema.md), [View](./view.md), [Procedure](./procedure.md), [Trigger](./trigger.md)) assume it. Diagnostic codes named here are catalogued in [Diagnostics](./diagnostics.md).

## Envelope

Every document is a YAML mapping with exactly four top-level keys.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema | View | Procedure | Trigger
metadata:
  name: posts
spec:
  # kind-specific
```

| Field | Type | Required | Rules |
|---|---|---|---|
| `apiVersion` | literal | yes | Exactly `cms.mantle.aotter.net/v1`. Anything else is `INVALID_MANIFEST_ENVELOPE` at `/apiVersion`. |
| `kind` | enum | yes | `Schema`, `View`, `Procedure` or `Trigger`. |
| `metadata` | mapping | yes | Only the key `name` is accepted. There is no `namespace`. |
| `metadata.name` | string | yes | Non-empty. Unique within its kind (`DUPLICATE_NAME`, one diagnostic per occurrence). A Schema and a View may share a name. |
| `spec` | mapping | yes | Kind-specific; see the atom pages. |

A document that is not a mapping is rejected with `manifest must be a YAML mapping`.

## Unknown-key policy

The parser rejects keys outside the shipped grammar at every level it knows. The diagnostic is `INVALID_MANIFEST_ENVELOPE` with the message `<dotted.path> is not supported` and a JSON Pointer to the offending key (for example `spec.foo is not supported` at `/spec/foo`). Enum values outside the grammar are rejected the same way.

| Pointer | Allowed keys |
|---|---|
| `/` | `apiVersion`, `kind`, `metadata`, `spec` |
| `/metadata` | `name` |
| `/spec` (Schema) | `title`, `description`, `schema`, `uiSchema`, `uniqueIndexes`, `indexes`, `searchableFields`, `localized`, `translates`, `lifecycle` |
| `/spec` (View) | `title`, `uiSchema`, `from`, `sql`, `surface`, `requires`, `filter`, `fields`, `orderBy`, `limit`, `params` |
| `/spec` (Procedure) | `title`, `description`, `requires`, `input`, `uiSchema`, `output`, `handler` |
| `/spec` (Trigger) | `source`, `target` |
| `/spec/translates` | `parent`, `on` |
| `/spec/requires` | `auth`, `guard` |
| `/spec/requires/auth` | `all` |
| `/spec/requires/guard` | `procedure` |
| `/spec/requires/auth/all/<i>` (object form) | exactly one of `ctx.staff`, `ctx.auth.scope` |
| `/spec/handler` (`kind: ref`) | `kind`, `ref` |
| `/spec/handler` (`kind: builtin`) | `kind`, `op`, `schema`, `match` |
| `/spec/filter/<op>` | `field`, `value` |
| `/spec/orderBy/<i>` | `field`, `direction` |
| `/spec/source` (`kind: http`) | `kind`, `method`, `path` |
| `/spec/source` (`kind: lifecycle`) | `kind`, `schema`, `on`, `errorPolicy` |
| `/spec/source` (`kind: mcp`) | `kind`, `surface` |
| `/spec/target` | `procedure` |
| `/spec/uiSchema` (View) | `list` (only on `surface: staff`; violations are `VIEW_UI_INVALID`) |
| `/spec/uiSchema/list` (View) | `columns`, `searchFields`, `filterFields` |

`uiSchema` on Schema and Procedure is the one place where unknown root keys are tolerated. The parser inspects only `fields` (Schema and Procedure), `list` (Schema) and `collectionAction` (Procedure); a Schema that declares `uiSchema.collectionAction` is rejected with `SCHEMA_UI_INVALID`. JSON Schema documents inside `spec.schema`, `spec.input`, `spec.output` and `spec.params` follow the [JSON Schema subset](./schema.md#json-schema-subset) instead of an allowlist.

## Multi-document YAML and sources

The parser consumes a set of sources, each `{ sourceId, text }`. The CLI builds this set from the immediate `.yaml` and `.yml` files of the manifests directory, sorted lexicographically, with the file path as `sourceId`; an unreadable or empty directory is `MANIFEST_ROOT_NOT_FOUND`. Nested directories are not read.

Within one source:

- `---` separates documents. A feature commonly bundles a Procedure and its Triggers in one file.
- YAML merge keys (`<<`) are disabled.
- Alias expansion is capped at 100 aliases per document. Exceeding the cap is `INVALID_MANIFEST_ENVELOPE` with the message `YAML alias-expansion limit exceeded`.
- Empty or `null` documents are skipped.
- A YAML syntax error is `INVALID_MANIFEST_ENVELOPE` at `/`, prefixed `[doc <index>]`.

Parsing is all-or-nothing. Any error-severity diagnostic in any document withholds the whole parsed set; later stages never see a partial graph. Every diagnostic carries `source: { sourceId, documentIndex, path }` plus a line and column span when the YAML node is known.

## LocalizedText

`Schema.spec.title` (required), `Schema.spec.description`, `View.spec.title`, `Procedure.spec.title` and `Procedure.spec.description` accept either a plain string or a locale map.

```yaml
title: Products
# or
title: { en: Products, "zh-TW": 商品 }
```

The parser rejects an empty string, an empty map `{}`, an array, an empty locale key and any non-string or empty value. JSON Schema property `title` and `description` keywords accept the same shape for Admin labels and help text; MCP tool schemas collapse them to the `en` value.

Resolution order (`resolveLocalizedText`): the viewer's preferred locale, then the site's canonical locale, then the first key in insertion order. A value that was never set resolves to `null`.

## Naming rules for `metadata.name`

| Rule | Applies to | Diagnostic |
|---|---|---|
| Non-empty string, unique within the kind. | all kinds | `DUPLICATE_NAME` |
| Must match `/^[A-Za-z][A-Za-z0-9_.-]*$/` when the Schema declares any `indexes` or `uniqueIndexes`. | Schema | `SCHEMA_INDEX_INVALID` at `/metadata/name` |
| Unique after MCP mangling (`mcpToolNameSegment`: lower-case, `-` becomes `_`). Two Schemas, or two Views, that mangle to the same segment collide. | Schema, View | `MCP_TOOL_NAME_COLLISION` |
| A Procedure's mangled name must not equal a reserved generic tool name, start with a reserved tool prefix, equal a Schema's mangled segment, or equal another Procedure's mangled name. | Procedure | `MCP_TOOL_NAME_COLLISION` |
| One MCP Trigger per `(surface, tool name)`. | Trigger | `MCP_TOOL_NAME_COLLISION` |
| Unique lower-camel identifier within each group (`entries`, `views`, `procedures`, `triggers`) when running `mantle generate`. The identifier joins the `[A-Za-z0-9]+` runs of the name, lower-casing the first and capitalising the rest; `my-orders` and `My Orders` both become `myOrders`. | all kinds | `CODEGEN_IDENTIFIER_COLLISION` |

Names containing `-` must be double-quoted when used as tables in a `sql` View (`"post-translations"`).

## Reserved names

| Namespace | Reserved | Effect |
|---|---|---|
| Entry columns | `id`, `status`, `version`, `createdAt`, `updatedAt`, `authorId` | Native on every Schema. Cannot appear in `indexes` or `uniqueIndexes` (`SCHEMA_INDEX_INVALID`). Valid in View `fields`, `filter`, `orderBy` and `uiSchema.list`. Avoid declaring data properties with these names; SQL Views project the native column, not the data field. |
| Data field | `locale` | A non-localized Schema that declares `properties.locale` is rejected; use a domain name such as `orderLocale`. On a localized Schema the runtime requires `data.locale` on writes. |
| View params | `page`, `show`, `cursor` | Owned by the runtime for pagination. Declaring them under `params.properties` is `VIEW_PARAMS_RESERVED_NAME`. |
| Builtin input | `id`, `expectedVersion` | Contract fields for builtin `update`, `delete` and `archive`; forbidden in a matched `upsert` input. |
| MCP tool names | `list_entries`, `get_entry`, `request_publish`, `unpublish_entry`, `archive_entry`, `delete_entry`, `create_media_upload`, `commit_media_upload` | A Procedure that mangles to one of these is `MCP_TOOL_NAME_COLLISION`. |
| MCP tool prefixes | `create_draft_`, `update_draft_`, `create_record_`, `update_record_`, `query_view_` | Same as above. |
| HTTP paths | Every `http` Trigger path must start with `/api/` (`TRIGGER_PATH_INVALID` at validate time). The Cloudflare Worker additionally reserves `/admin`, `/_mantle`, `/api/auth`, `/api/views`, `/oauth`, `/mcp`, any path starting `/.well-known/oauth`, and the exact registrations `*` and `/*`; a Trigger under one of these fails at boot with `TRIGGER_PATH_INVALID`. | See [Trigger](./trigger.md#http-source). |

## Source

- [`packages/mantle-spec/src/domain/model/ManifestGrammar.ts`](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [`packages/mantle-spec/src/domain/service/ManifestParser.ts`](../../../packages/mantle-spec/src/domain/service/ManifestParser.ts)
- [`packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts`](../../../packages/mantle-spec/src/domain/service/ManifestGraphValidator.ts)
- [`packages/mantle-spec/src/domain/service/SchemaIndexChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaIndexChecker.ts)
- [`packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts`](../../../packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts)
- [`packages/mantle-spec/src/domain/service/McpToolNaming.ts`](../../../packages/mantle-spec/src/domain/service/McpToolNaming.ts)
- [`packages/mantle-spec/src/infrastructure/cli/loadManifests.ts`](../../../packages/mantle-spec/src/infrastructure/cli/loadManifests.ts)
- [`packages/mantle-spec/src/kernel/diagnostic.ts`](../../../packages/mantle-spec/src/kernel/diagnostic.ts)
- [`packages/mantle/src/codegen/emitMantleModule.ts`](../../../packages/mantle/src/codegen/emitMantleModule.ts)
- [`packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts`](../../../packages/mantle-runtime/src/usecase/boot/ValidateBootUseCase.ts)
- [`packages/adapters/cloudflare/src/worker/createMantleWorker.ts`](../../../packages/adapters/cloudflare/src/worker/createMantleWorker.ts)
- [`docs/design-atoms.md`](../../../docs/design-atoms.md)
