---
description: Manifest capability table mapping authoring goals to Schema, View, Procedure and Trigger fields, generated APIs and Admin behavior.
---
# Manifest feature reference

All paths below are relative to the atom's `spec`. The envelope is always
`apiVersion`, `kind`, `metadata.name`, `spec`. Features compose from these four
atoms; there is no separate Form, Workflow or UI manifest kind. See the
[envelope reference](./manifest.md) for naming and unknown-key rules.

## Capability table

| Goal | Atom and fields | Runtime / surface effect | Contract |
|---|---|---|---|
| Define stored business data | Schema `schema` | Validated fields; storage adapter prepares the Schema. Generated entry types follow the JSON Schema subset. | [Schema](./schema.md) |
| Choose draft publishing or live records | Schema `lifecycle` | `publishing` has draft/publish transitions; `operational` creates live records. Admin workflow follows this choice. | [Lifecycle](../concepts/lifecycle-and-locales.md) |
| Label fields and collections | Schema `title`, `description`, property `title`, `description` | Localized Admin labels/help. Does not rename data keys. | [LocalizedText](./manifest.md#localizedtext) |
| Make Procedure-managed records | Schema `schema.readOnly` | Disables generic authoring writes; declared Procedures still work. | [Read-only collections](./schema.md#root-readonly-true) |
| Find and constrain records | Schema `indexes`, `uniqueIndexes`, `searchableFields` | Native access paths, uniqueness and declared substring-search fields. Search fields do not create indexes. | [Indexes](./schema.md#indexes) |
| Translate or relate records | Schema `localized`, `translates`; property `x-mantle-ref` | Locale rows, joined translations, relation controls and folded child collections. | [Schema](./schema.md), [Admin guide](../guides/admin-ui.md) |
| Stamp trusted values | Property `x-mantle-bind` | Runtime stamps identity/time; generic agent inputs exclude bound fields and Admin shows them read-only. | [Binding](./schema.md#x-mantle-bind) |
| Adjust collection inputs and list | Schema `uiSchema.fields`, `.list`, `.nav` | Textareas, operational columns/tabs, standalone child navigation. No CSS or component injection. | [Admin guide](../guides/admin-ui.md) |
| Query one Schema portably | View `from`, `fields`, `filter`, `orderBy`, `limit`, `params` | Named query with generated typed params and projected rows. | [View](./view.md), [typed queries](../guides/typed-queries.md) |
| Join or aggregate in SQLite | View `sql`, `params`, `limit` | One bound SELECT; requires a SQLite-capable adapter. Generated row type is `unknown`. | [SQL Views](./view.md#sql) |
| Choose read visibility | View `surface` | `public`: public REST/MCP; `staff`: Admin reports/staff MCP; `internal`: host binding only. Transports require host composition. | [Surfaces](./view.md#surfaces) |
| Authorize a query or action | View / Procedure `requires.auth`, `requires.guard` | Runtime checks verified caller context and optional guard. Visibility and UI metadata do not grant access. | [Authorization](./authorization.md) |
| Filter by caller identity | View `filter` with `$ctx.user: id` | Declarative equality filter; requires user auth and a left-prefix index. | [Identity filters](./view.md#value-forms) |
| Cache anonymous published reads | View `cache.sharedMaxAge` | Eligible public declarative publishing reads receive shared HTTP cache policy when the host configures cache scope. | [View cache](../concepts/views.md#shared-response-cache) |
| Configure a report | Staff View `title`, `uiSchema.list` | Ordered report/CSV columns, server-side search and exact filters. | [View list](./view.md#uischemalist) |
| Define an action | Procedure `input`, `output`, `handler` | Typed input/output; builtin mutation or registered host handler. A Procedure does not create an HTTP route by itself. | [Procedure](./procedure.md) |
| Put an action in Admin | Procedure `uiSchema.collectionAction`, `.fields`; input `x-mantle-ref`; qualifying Trigger | Collection/row actions and forms; eligible standalone operations appear under Operations. | [Admin guide](../guides/admin-ui.md) |
| Describe an agent action | Procedure `title`, `description`, `mcp` | Tool descriptions and behavior annotations; enforcement remains in runtime authorization/validation. | [Procedure](./procedure.md) |
| Expose an HTTP action | Trigger `source: { kind: http, method, path }`, `target.procedure` | Handler on the declared `/api/` path through supporting host adapters. | [HTTP Trigger](./trigger.md#http-source) |
| Expose an agent action | Trigger `source: { kind: mcp, surface }`, `target.procedure` | Public or staff MCP tool; Procedure authorization still applies. | [Trigger](./trigger.md) |
| React to content lifecycle | Trigger `source: { kind: lifecycle, schema, on, errorPolicy }`, `target.procedure` | Invokes the action on selected lifecycle events. Deferred execution needs host support. | [Hooks](../concepts/procedures-and-triggers.md) |

## Where manifest control ends

Manifests describe data, callable behavior and supported presentation metadata.
They do not declare arbitrary React components, visitor routes, page layouts,
CSS, provider credentials or deployment resources. Those belong to application
source and optional host packages. For an Admin change, consult the
[rendering map](../guides/admin-ui.md) before deciding that custom UI is needed.

The pipeline is source → parse → link → compile → prepare storage → bind
runtime. `mantle generate` projects the plan and types; it does not start a
server. Programmatic `emitMantleModule({ plan })` also accepts an already
compiled plan; see [typed queries](../guides/typed-queries.md).

## Source

- [Manifest grammar](../../../packages/mantle-spec/src/domain/model/ManifestGrammar.ts)
- [Admin UI validation](../../../packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts)
- [Type generation](../../../packages/mantle-spec/src/usecase/EmitTypesUseCase.ts)
- [Runtime binding generation](../../../packages/mantle/src/codegen/emitMantleModule.ts)
