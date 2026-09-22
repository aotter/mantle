---
description: How Schema, View, Procedure, Trigger and uiSchema become Admin forms, lists, navigation and actions, with a complete customization example.
---
# Customize the Admin console

Many Admin changes are manifest edits: labels, multiline inputs, operational
list columns and tabs, reports and action placement. Admin API derives
metadata from the compiled plan; the prebuilt SPA renders it. The host must
already mount Admin API, authentication and Admin assets — see the
[local Admin tutorial](../start/quickstart-admin.md).

## Manifest to rendered UI

| User request | Author this | What Admin renders / constraints |
|---|---|---|
| Rename a collection or explain a field | Schema `title` / `description`, property `title` / `description` | Localized labels and help. Property names and stored values stay unchanged. |
| Make a field required or an option list | JSON Schema `required`, `enum`, `type` | Required marker and type-derived control; enums become selects. These are data contracts, not styling flags. |
| Make a string multiline | Schema or Procedure `uiSchema.fields.<name>.widget: textarea` | Textarea for a top-level string field. `textarea` is the only supported explicit widget. |
| Edit Markdown or HTML | Property `x-mcp-hint: markdown` or `html` | Rich editor; these hints take precedence over `widget: textarea`. `richtext` currently uses a textarea. |
| Edit a timestamp or show money | `format: date-time` on a string; `x-mcp-hint: timestamp-ms` or `money-minor` on a number | Date/time controls or number preview. Money uses minor units divided by 100 and a sibling `currency` when present. |
| Reorder an operational record list | Schema `uiSchema.list.primaryField`, `.columns` | Linked leading data field, then ordered columns. Native columns such as `status` and `createdAt` are allowed in `columns`; `primaryField` must be a scalar data property. |
| Add business-state tabs | Schema `uiSchema.list.filterField` | Operational-only enum tabs/sidebar links. Field needs a string enum and a left-prefix index. |
| Search record contents | Schema `searchableFields` | Searches declared string fields plus entry id. This is substring search, not an index declaration. |
| Show related records | Required property `x-mantle-ref` | Eligible child collections fold into the parent's workbench; translation children use language tabs. |
| Also show a folded child in navigation | Schema `uiSchema.nav.standalone: true`, optional `parentField` | Adds its own list with parent filter, retaining the folded view. Multiple eligible parent refs require `parentField`; not allowed on translation children. |
| Add a read-only report and CSV | View `surface: staff`, `title`, `uiSchema.list` | Report navigation; `columns`, `searchFields`, `filterFields` use output names. Server filters before pagination; CSV includes all matches. |
| Add a list-level action | Eligible Procedure `uiSchema.collectionAction: <schema>` | Collection action with a form generated from Procedure `input`. |
| Add a row action | Eligible Procedure input property `x-mantle-ref: <schema>` | Row operation with prefilled reference. Selection uses a same-name Schema property, then a sole single-field unique index, otherwise entry `id`. |
| Make generic content editing read-only | Schema root `schema.readOnly: true` | Generic authoring writes are blocked; declared Procedures remain available. A disabled field is not an authorization rule. |

The data editor also handles booleans, numbers, objects and arrays from JSON
Schema. Bound fields (`x-mantle-bind`) display read-only because Runtime owns
the value. Media controls depend on the supported media schema and host media
policy; `uiSchema` alone cannot enable uploads.

Schema list presentation (`primaryField`, `columns`, `filterField`) is for
`lifecycle: operational`. Publishing collections keep the built-in publishing
workflow. For an alternate publishing table, define a staff View report.

## Example: an operational inbox

This complete source configures a collection and a separate staff report.
The collection filters by `ticketState`, not Mantle's native publishing status.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: support-tickets
spec:
  title: { en: Support tickets, zh-TW: 客服工單 }
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [subject, ticketState]
    properties:
      subject: { type: string, title: Subject }
      details: { type: string, description: Include the steps to reproduce. }
      ticketState: { type: string, enum: [open, waiting, closed] }
  indexes: [[ticketState]]
  searchableFields: [subject, details]
  uiSchema:
    fields:
      details: { widget: textarea }
    list:
      primaryField: subject
      columns: [ticketState, createdAt]
      filterField: ticketState
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: support-report
spec:
  title: Support report
  surface: staff
  from: support-tickets
  fields: [id, subject, ticketState, createdAt]
  uiSchema:
    list:
      columns: [subject, ticketState, createdAt]
      searchFields: [subject]
      filterFields: [ticketState]
```

The collection shows Subject first, State and Created at next, state tabs,
and a multiline Details editor. The report is a separate navigation entry
with its own search/filter configuration and CSV export. Schema `.list` and
View `.list` are different contracts; do not copy their keys between atoms.

## When a Procedure becomes a button

`uiSchema.collectionAction` alone does not expose a Procedure. Admin discovers
staff operations from either a staff MCP Trigger or an HTTP Trigger whose
Procedure requires `ctx.staff`. Runtime rechecks Procedure `requires` on
execution. Use the [Procedure reference](../reference/procedure.md#uischema)
for a complete action declaration.

An eligible operation with row bindings appears on those records. One with
`collectionAction` appears on that collection's list. Operations without either
appear in the standalone Operations screen. Row mutations use the observed
entry version for optimistic concurrency where the Procedure contract declares
`expectedVersion`; keep its input contract intact when adjusting presentation.

## Verify a change

1. Edit the application manifests, then run `mantle validate`, `mantle generate`
   and `mantle generate --check` through the local package manager.
2. Restart/reload the host so Admin receives the new compiled plan. Check
   `/admin/api/collections`, `/admin/api/views-manifest` or
   `/admin/api/operations` in an authenticated session if the UI seems stale.
3. Open the affected list and editor: check labels, actual columns, filters,
   form values and keyboard access. Verify a record after saving, and verify
   report filters in CSV as well as the visible page.

`uiSchema` roots and supported nested keys are closed. Schema accepts `fields`,
`list`, `nav`; Procedure accepts `collectionAction`, `fields`; staff View accepts
`list`. They do not accept a custom layout, CSS, React component, arbitrary
widget name or permission policy. See [Schema](../reference/schema.md#uischema),
[View](../reference/view.md#uischemalist) and [Procedure](../reference/procedure.md#uischema).

For a new layout or unsupported widget, use application-owned UI against the
appropriate APIs or propose a change to the Admin UI package. Do not patch
`public/_mantle/admin/`: generation replaces those prebuilt assets. Visitor
frontend styles and the `theme` skill's site changes do not style Admin.

## Source

- [Admin UI contract validation](../../../packages/mantle-spec/src/domain/service/SchemaAdminUiChecker.ts)
- [Admin metadata and operation discovery](../../../packages/mantle-admin/src/mountMantleAdmin.ts)
- [Entry form renderer](../../../packages/mantle-admin-ui/src/features/content/entry-edit-view.tsx)
- [Collection renderer](../../../packages/mantle-admin-ui/src/features/content/collection-view.tsx)
- [Action renderer](../../../packages/mantle-admin-ui/src/features/content/row-operations.tsx)
- [Navigation rules](../../../packages/mantle-admin-ui/src/lib/collection-nav.ts)
