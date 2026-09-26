---
description: Generate wire-keyed Store types, call named Views, and distinguish trusted Store reads from authorized public reads.
---
# Query from TypeScript

Use a **View** when a read needs declared params, projection, pagination or
`requires` authorization. Use an **entry reader** for trusted host code that
needs stored entries by a data field. The generated Store map types the Schema and View wire names; only the View
executes the declared View authorization contract.

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
Admin reports. It remains in the plan and Store type map. It is not a
security bypass: adding `requires` evaluates the same authorization and guards
against the host-supplied `ctx` on every call. No `uiSchema` or shared HTTP
cache is allowed for an internal View.

## Call with wire names

The generated module exports a sealed `plan` plus `Schemas`, `Views`, and
`Store` type maps. Host code boots that plan once and uses the same
`runtime.store` object for typed reads and writes:

```ts
import type { MantleRuntime } from "@aotter/mantle/runtime";
import type { Store } from "../.mantle/generated/mantle.js";

export async function openTickets(runtime: MantleRuntime) {
  const store = runtime.store as Store;
  const result = await store.view("tickets-by-state", {
    params: { ticketState: "open" },
    page: 1,
    show: 20,
  });
  return result.rows;
}
```

The wire name remains `tickets-by-state`; no lower-camel name is generated.
Required params are checked by TypeScript and Runtime validates the values.
`show` remains capped by the View's `limit`. A View with `requires` still
needs a verified caller context; invoke it through `runtime.executeView({
view, ctx, options })` until the Store caller-binding grammar lands.

To boot from generated code, pass its `plan` and typed `MantleHandlers` to
`bootMantleRuntime({ plan, storage, handlers, ports })`. Host code owns
connection lifetime and retries.

## What is typed

| Query form | Generated shape | Limit |
|---|---|---|
| Declarative View | `Mantle.ViewParams_<name>` and `Mantle.ViewRow_<name>` | Projection follows `fields`; native columns have their native types. Data properties remain optional in the row type. |
| SQL View | Typed params; row type `unknown` | The generator does not infer SQL expressions or aliases. Narrow/validate rows in host code. |
| Store select/write | `Store`, `Schemas` | Schema wire names and insert/update values are typed; Runtime still validates Store queries. |
| Dynamic Runtime call | `runtime.executeView({ view, ctx, options })` | Useful without codegen; supplying a generic row type is the caller's assertion, not SQL validation. |

Without `fields`, a declarative View includes native entry columns and Schema
properties. Use explicit projections on exposed reads. Public declarative
Views over publishing Schemas inject `status = published`; internal/staff
Views and SQL statements do not. See [View reference](../reference/view.md).

## Store reads

For the Schema above, use Store. Legacy `runtime.entries` readers remain
available to existing Web/Admin code until the grammar migration:

```ts
const rows = await (runtime.store as Store).select({
  from: "tickets",
  where: { ticketState: "open" },
  limit: 20,
});
// rows.rows[n] is a flat Store row.
```

Trusted host Store reads include every lifecycle status and do not evaluate a
View's `requires` or public visibility. Use a public View for untrusted callers.
Declare an index whose leftmost field matches a frequent lookup. The old
`runtime.entries` methods remain for existing Web/Admin code, but generated
per-Schema wrappers are gone.

## Generate from an existing plan

A build tool that already compiled a sealed plan can use the pure emitter:

```ts
import { emitMantleModule } from "@aotter/mantle/codegen";

const emitted = emitMantleModule({ plan });
if (!emitted.ok) throw new Error(emitted.diagnostics.map(d => d.message).join("\n"));
// Write emitted.source to your generated module in the build step.
```

Pass either `{ plan }` or `{ linked }`, never both. The plan form avoids
reparsing YAML and preserves the same generated type maps. The emitter does no I/O, asset copying, storage preparation or caching.

## Source

- [Binding generator](../../../packages/mantle/src/codegen/emitMantleModule.ts)
- [Type generator](../../../packages/mantle-spec/src/usecase/EmitTypesUseCase.ts)
- [Entry reader contract](../../../packages/mantle-runtime/src/domain/port/EntryReader.ts)
- [View execution](../../../packages/mantle-runtime/src/usecase/view/ExecuteViewUseCase.ts)
