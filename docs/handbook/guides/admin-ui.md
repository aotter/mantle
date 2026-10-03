---
description: What Admin serves in 0.2.0, how manifests and uiSchema become Admin's collections, reports and operations, and how to verify a change.
---
# Customize Admin from manifests

`createAdminSurface` serves Admin's API at `/admin/api/*` behind a staff gate.
Every route reads and writes through `runtime.store.as(caller)` and
`invokeProcedure`, so Admin sees exactly what the signed-in staff member may
see. What Admin shows is derived from the compiled plan: labels, forms, list
columns, reports and operations are manifest edits.

With feature `admin`, the generated preset also serves the console, the
prebuilt SPA in `@aotter/mantle-ui/admin`, at `/admin`: `wrangler.jsonc` binds
`node_modules/@aotter/mantle-ui/dist/admin` as the Worker's `ASSETS`
(`run_worker_first`), and `src/service.ts` passes `createAdminSurface` an
`assets` function that reads from it. `mantle generate` warns when `admin` is
selected and `wrangler.jsonc` binds no `ASSETS`. Sign in at `/admin/sign-in`.

## Manifest to Admin

| You want | Author this | Effect and limits |
|---|---|---|
| Rename a collection or explain a field | Schema `title` / `description`, property `title` / `description` (a string or a locale map) | Labels and help. Stored names do not change |
| Required fields and option lists | JSON Schema `required`, `enum`, `type` | Data contracts, checked on every write, not styling |
| Option labels | a string property's `oneOf: [{ const: open, title: { en: Open, zh-TW: 處理中 } }, …]` instead of `enum` | Selects, filter tabs and list cells show the `title` |
| A multiline string | Schema or Procedure `uiSchema.fields.<name>.widget: textarea` | `textarea` is the only explicit widget |
| Markdown or HTML | property `x-mcp-hint: markdown` or `html` | A rich editor |
| A timestamp, a date or money | `format: date-time`, `format: date`; `x-mcp-hint: money-minor` on an integer | Date controls; money in minor units, with a sibling `currency` when present |
| Columns of an operational list | Schema `uiSchema.list.primaryField`, `.columns` | `primaryField` is a scalar data field; `columns` may name native columns (`createdAt`, `updatedAt`) |
| Business-state tabs | Schema `uiSchema.list.filterField` | Operational Schemas only; a string enum that leads an index |
| Search | Schema `searchableFields` | Full-text search over those string fields, plus `id` |
| Related records | a required property with `x-mantle-ref` | Children fold under their parent |
| A folded child in navigation too | Schema `uiSchema.nav.standalone: true`, optional `parentField` | Its own list with a parent filter |
| A read-only report with CSV | a View with `surface: staff`, `title`, `uiSchema.list` | `columns`, `searchFields` and `filterFields` name the View's outputs; the search box and filters become `LIKE` and `=` on them. `GET /admin/api/views/<name>/export` returns every matching row |
| An operation | a Procedure bound by a Trigger with `source: { kind: mcp, surface: staff }` | Listed at `/admin/api/operations` for staff its `requires` admits, and run with `POST /admin/api/operations/<name>` |
| A row operation | that Procedure's `target` (declared or inferred from `WHERE id = … AND version = …`) | Bound to the row's `id`, and its version when the target names one |
| A list-level operation | Procedure `uiSchema.collectionAction: <schema>` | Shown on that collection |
| No generic edits | Schema root `schema.readOnly: true` | Admin's entry routes refuse writes (`CONFLICT`); declared Procedures still run |

Schema list presentation (`primaryField`, `columns`, `filterField`) is for
`lifecycle: operational`. Publishing Schemas keep the draft, publish and
archive workflow (`POST /admin/api/entries/{id}/publish` and `/unpublish`).

## Example: an operational inbox

```yaml
apiVersion: cms.mantle.aotter.net/v2
kind: Schema
metadata: { name: support-tickets }
spec:
  title: { en: Support tickets, zh-TW: 客服工單 }
  lifecycle: operational
  indexes: [[ticketState]]
  searchableFields: [subject, details]
  uiSchema:
    fields:
      details: { widget: textarea }
    list:
      primaryField: subject
      columns: [ticketState, createdAt]
      filterField: ticketState
  schema:
    type: object
    additionalProperties: false
    required: [subject, ticketState]
    properties:
      subject: { type: string, title: Subject }
      details: { type: string, description: Include the steps to reproduce. }
      ticketState: { type: string, enum: [open, waiting, closed] }
---
apiVersion: cms.mantle.aotter.net/v2
kind: View
metadata: { name: support-report }
spec:
  title: Support report
  surface: staff
  requires: { auth: { all: [{ ctx.staff: [owner, editor] }] } }
  uiSchema:
    list:
      columns: [subject, ticketState, created_at]
      searchFields: [subject]
      filterFields: [ticketState]
  sql: SELECT id, subject, ticketState, created_at FROM "support-tickets" ORDER BY created_at DESC
```

Schema `uiSchema.list` and View `uiSchema.list` are different contracts; do
not copy keys between them. The report's search box matches `subject`
(`LIKE`), its filter is `ticketState` (`=`), and a declared `input` would add
a form above them; all of them keep cursor paging.

## Roles

The Developer console's Procedure overview projects the sealed SQL AST into
a static execution diagram: authorization, validated input, guard, applicable
lifecycle hooks, ordered atomic statements, commit or rollback, and output
validation. Statement cards show read/write dependencies, row versus set
semantics, RETURNING and ordered CASE assignments. CASE chooses a field value;
WHERE filters rows. A set operation can affect zero rows and still continue.
Output validation and after-hook failures do not roll back an existing commit.
Unsupported expression shapes remain explicitly opaque beside authored SQL;
code handlers' effects and actual run history are not inferred.

The inline business flow uses Schema/property titles and titled enum options
from the developer snapshot; generic verbs and operators are UI translations.
It expands direct `UPDATE SET field = CASE … END` assignments only. CASE
inside arithmetic, casts, functions, SELECT or INSERT remains in the SQL
detail tree, rather than pretending its intermediate result is the assigned
value. SQL identifiers match manifest names case-insensitively. The existing
`money-minor` display convention uses hundredths and a single-valued sibling
`currency` enum; if numeric conversion or currency formatting would round a
threshold, the flow shows its exact SQL literal marked as a raw SQL value.
These display hints do not establish or validate business units.


Admin's gate admits any staff role. Inside it, each route names the least role
it needs: `contributor` reads and edits drafts, `editor` publishes, deletes
and manages media, `owner` manages staff, site settings and the developer
console. Operations and staff Views are further limited by their own
`requires`.

## Verify a change

1. Run `mantle generate`, then `mantle generate --check`.
2. Restart `wrangler dev` so the runtime loads the new plan.
3. Open `/admin` with a staff session and check the affected list, form,
   report or operation. `GET /admin/api/bootstrap` carries the collections,
   Views, operations and site the console renders.

`uiSchema` keys are closed. Schema takes `fields`, `list` and `nav`;
Procedure takes `collectionAction` and `fields`; a staff View takes `list`. No
layout, CSS, component or permission keys exist; build those in your own UI
over Admin's API or your own surfaces.

## Source

- [Schema](../reference/schema.md#uischema), [View](../reference/view.md) and [Procedure](../reference/procedure.md) references
- [HTTP, MCP, CLI and packages](../reference/surface.md): every Admin route
