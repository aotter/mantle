---
description: A task-to-feature table for Mantle 0.2.0 manifests — what to declare for each common need, with links to the field reference and an example.
---
# Manifest feature reference

| You need | Declare | Reference | Example |
|---|---|---|---|
| A table | a Schema with a JSON Schema | [Schema](./schema.md) | every example |
| Authored content with drafts and publishing | `lifecycle: publishing` (the default) | [Lifecycle](../concepts/lifecycle-and-locales.md) | [Publication](../../examples/publication.md) |
| Records written by the system | `lifecycle: operational` | [Lifecycle](../concepts/lifecycle-and-locales.md) | [Intake form](../../examples/intake.md) |
| Rows only their owner may ever see | `scope: { owner: auth.uid() }` | [Authorization](../concepts/authorization.md) | reference service `orders` |
| A member sees their own rows, staff see all | store `auth.uid()` in the SQL, filter `WHERE x = auth.uid()` | [Authorization](../concepts/authorization.md) | [Procurement](../../examples/procurement.md) |
| A rule every write obeys | `checks: ["stock >= 0"]` | [Schema](./schema.md#checks) | [Commerce inventory](../../examples/commerce-inventory.md) |
| Uniqueness | `uniqueIndexes` | [Schema](./schema.md#indexes) | [Commerce](../../examples/commerce.md) |
| Full-text search | `searchableFields` and `mantle.search` | [View](./view.md) | [Publication](../../examples/publication.md) |
| Places | `format: geo` and `mantle.near` / `mantle.distance` | [View](./view.md) | |
| Rows that expire | `ttl`, then `sweepExpired` | [Lifecycle](../concepts/lifecycle-and-locales.md#ttl) | |
| Translations | `localized`, `translates` | [Schema](./schema.md#localized-and-translates) | [Publication](../../examples/publication.md) |
| A public read | a View, `surface: public` | [View](./view.md) | every example |
| A staff report with CSV | a View, `surface: staff`, `uiSchema.list` | [Admin](../guides/admin-ui.md) | [Reservation](../../examples/reservation.md) |
| A read only code uses | a View, `surface: internal` | [Query from TypeScript](../guides/typed-queries.md) | [Commerce inventory](../../examples/commerce-inventory.md) |
| Joins, aggregates, windows | the View's SQL | [View](./view.md#what-the-d1-dialect-accepts) | reference service `sales-by-item` |
| A write | a Procedure with `handler: { sql }` | [Procedure](./procedure.md) | every example |
| Several writes, all or nothing | several statements in one `sql` | [Procedure](./procedure.md#handlersql) | reference service `place-order` |
| An upsert | `INSERT … ON CONFLICT (…) DO UPDATE` | [Procedure](./procedure.md) | reference service `restock` |
| No lost updates | `WHERE id = input.id AND version = input.expectedVersion` | [Procedure](./procedure.md#row-ops-and-set-ops) | [Commerce](../../examples/commerce.md) |
| Code: call a service, read then write, set `status` | `handler: { ref }` | [Procedure](./procedure.md#handlerref) | [Commerce inventory](../../examples/commerce-inventory.md) |
| An HTTP route | a Trigger `kind: http` | [Trigger](./trigger.md#http) | every example |
| An agent tool | a Trigger `kind: mcp`, or a View | [MCP and agents](../concepts/mcp-and-agents.md) | every example |
| An Admin operation | a Trigger `kind: mcp, surface: staff` | [Admin](../guides/admin-ui.md) | [Procurement](../../examples/procurement.md) |
| Signed-in callers only | `requires: { auth: { all: [ctx.user] } }` | [Authorization requirements](./authorization.md) | [Procurement](../../examples/procurement.md) |
| Staff roles | `{ ctx.staff: [owner, editor] }` | [Authorization requirements](./authorization.md) | [Commerce](../../examples/commerce.md) |
| API keys and scopes | a custom `CallerResolver`, `{ ctx.auth.scope: … }` | [Authorization](../concepts/authorization.md) | [Guarded API access](../../examples/guarded-api.md) |
| A live check before one action | `requires.guard` | [Authorization requirements](./authorization.md#guard) | [Intake with bot check](../../examples/intake-hooks.md) |
| A rule before every write of a Schema | a `before_*` lifecycle Trigger | [Trigger](./trigger.md#lifecycle) | |
| Side effects after a write | an `after_*` lifecycle Trigger | [Trigger](./trigger.md#lifecycle) | [Intake with bot check](../../examples/intake-hooks.md) |
| A recurring job | a Trigger `kind: schedule` (POSIX cron) | [Trigger](./trigger.md#schedule) | [Commerce inventory](../../examples/commerce-inventory.md) |
| A signed webhook | a route in the service's `fetch`, then `runtime.invokeProcedure` | [Writes](../concepts/procedures-and-triggers.md#webhooks) | [Commerce inventory](../../examples/commerce-inventory.md) |
| Media uploads | `d1Storage(db, { site })` and `r2MediaStorage` | [Media uploads with R2](../cloudflare/media-r2.md) | |

## Not in 0.2.0

| 0.1.x feature | In 0.2.0 |
|---|---|
| builtin handlers (`create`, `update`, `upsert`, `delete`, `archive`) | SQL statements; `archive` is a `ref` handler setting `status` |
| the Filter AST, `params`, `$param`, `$ctx.user` | the View's SQL, `input`, `input.<name>`, `auth.uid()` |
| `page` / `show` | `limit` / `cursor` |
| `x-mantle-bind` | `scope`, or `auth.uid()` / `now()` in the SQL |
| generated record tools on Staff MCP | declared Procedures with `mcp` Triggers |
| `errorPolicy` on lifecycle hooks | before hooks fail closed; after hooks are best effort |
| deferred hooks on a Queue | after hooks run after the commit; a queue is the service's own |
| Mantle-rendered public pages, templates, sitemap | not ported; render from your own `fetch` |
| `mantle validate`, `emit-openapi`, `mantle skills` | `mantle generate` and `mantle generate --check` |
