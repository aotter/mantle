---
description: Generate and call typed Views, including internal-only queries, and choose indexed entry readers without confusing them with authorized public reads.
---
# Query from TypeScript

Use a **View** when a read needs declared params, projection, pagination or
`requires` authorization. Use an **entry reader** for trusted host code that
needs stored entries by a data field. Both are exposed by generated bindings;
only the View executes the declared View authorization contract.

## Declare an internal query

Save this complete source as `manifests/tickets.yaml`. The operational Schema
uses a business status field distinct from Mantle's native `status`.

```yaml
apiVersion: cms.mantle.aotter.net/v1
kind: Schema
metadata:
  name: tickets
spec:
  title: Tickets
  lifecycle: operational
  schema:
    type: object
    additionalProperties: false
    required: [subject, ticketState]
    properties:
      subject: { type: string }
      ticketState: { type: string, enum: [open, closed] }
  indexes: [[ticketState]]
---
apiVersion: cms.mantle.aotter.net/v1
kind: View
metadata:
  name: tickets-by-state
spec:
  surface: internal
  from: tickets
  fields: [id, subject, ticketState]
  filter:
    eq: { field: ticketState, value: { $param: ticketState } }
  params:
    type: object
    additionalProperties: false
    required: [ticketState]
    properties:
      ticketState: { type: string, enum: [open, closed] }
  limit: 50
```

```sh
pnpm exec mantle validate --no-source
pnpm exec mantle generate
pnpm exec mantle generate --check
```

`internal` keeps this query out of REST routes, OpenAPI, MCP/WebMCP catalogs and
Admin reports. It remains in the plan and generated binding. It is not a
security bypass: adding `requires` evaluates the same authorization and guards
against the host-supplied `ctx` on every call. No `uiSchema` or shared HTTP
cache is allowed for an internal View.

## Bind and call

When the host already owns a prepared Runtime, bind it once where you need the
typed API. This function can live in `src/queries.ts`:

```ts
import type { MantleRuntime } from "@aotter/mantle/runtime";
import { bindMantle } from "../.mantle/generated/mantle.js";

export async function openTickets(runtime: MantleRuntime) {
  const mantle = bindMantle(runtime);
  const result = await mantle.views.ticketsByState({
    params: { ticketState: "open" },
    page: 1,
    show: 20,
  });
  if (!result.ok) throw new Error(result.diagnostic.message);
  return result.result.rows;
}
```

The runtime response uses `result` on success (`result.result.rows` above);
REST wraps those rows under `data` instead.

The wire name `tickets-by-state` becomes `ticketsByState`. Required params
make the request and `params` mandatory; invalid enum values are TypeScript
errors, and Runtime also validates actual inputs. `show` remains capped by
`limit`. For an authorized View, pass the verified caller context as `ctx`;
do not fabricate staff/user identities from request input.

A host without a Runtime can use generated `createMantle({ storage, handlers,
ports })`, which delegates one eager boot attempt and returns the typed
binding. Host code still owns connection lifetime and retries. See
[Runtime and adapters](../concepts/runtime-and-adapters.md).

## What is typed

| Query form | Generated shape | Limit |
|---|---|---|
| Declarative View | `Mantle.ViewParams_<name>` and `Mantle.ViewRow_<name>` | Projection follows `fields`; native columns have their native types. Data properties remain optional in the row type. |
| SQL View | Typed params; row type `unknown` | The generator does not infer SQL expressions or aliases. Narrow/validate rows in host code. |
| Entry field reader | `MantleEntry<Mantle.Entry_<schema>>` | The field must be a declared data property and the value a compatible string, number or boolean. Types do not prove an index exists. |
| Dynamic Runtime call | `runtime.executeView({ view, ctx, options })` | Useful without codegen; supplying a generic row type is the caller's assertion, not SQL validation. |

Without `fields`, a declarative View includes native entry columns and Schema
properties. Use explicit projections on exposed reads. Public declarative
Views over publishing Schemas inject `status = published`; internal/staff
Views and SQL statements do not. See [View reference](../reference/view.md).

## Indexed entry reads

For the Schema above:

```ts
const rows = await mantle.entries.tickets.findManyByDataField({
  field: "ticketState",
  value: "open",
  limit: 20,
});
// rows[n].data is the generated tickets data shape.
```

| Method | Returns | Options worth knowing |
|---|---|---|
| `readBySlug({ slug, locale?, status? })` | One entry or `null` | Use on a Schema with a slug field and an appropriate index. |
| `readByDataField({ field, value, locale?, status? })` | One entry or `null` | Equality on one data property. |
| `readByDataFieldIn({ field, values, latestPerValue?, locale?, status? })` | Entry array | Batch equality lookups; `latestPerValue` selects the newest match per value. |
| `findManyByDataField({ field, value, limit })` | Entry array | Bounded equality lookup across statuses; no `ctx`, `status` or `locale` option. |

These readers do not evaluate View `requires`, inject public visibility or
fire mutation hooks. In particular, `findManyByDataField` can return drafts.
Use a public View for untrusted callers; do not expose a raw reader as a public
route and assume the generated type authorizes it. Declare a measured index
whose leftmost field matches the lookup; do not scan an entire collection in
TypeScript to replace a field query.

## Generate from an existing plan

A build tool that already compiled a sealed plan can use the pure emitter:

```ts
import { emitMantleModule } from "@aotter/mantle/codegen";

const emitted = emitMantleModule({ plan });
if (!emitted.ok) throw new Error(emitted.diagnostics.map(d => d.message).join("\n"));
// Write emitted.source to your generated module in the build step.
```

Pass either `{ plan }` or `{ linked }`, never both. The plan form avoids
reparsing YAML and preserves the same generated types and entry/View/Procedure
bindings. The emitter does no I/O, asset copying, storage preparation or caching.

## Source

- [Binding generator](../../../packages/mantle/src/codegen/emitMantleModule.ts)
- [Type generator](../../../packages/mantle-spec/src/usecase/EmitTypesUseCase.ts)
- [Entry reader contract](../../../packages/mantle-runtime/src/domain/port/EntryReader.ts)
- [View execution](../../../packages/mantle-runtime/src/usecase/view/ExecuteViewUseCase.ts)
